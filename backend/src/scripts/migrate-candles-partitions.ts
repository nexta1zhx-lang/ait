/**
 * 把 `candles` 从**普通表**搬成**两级分区表**（LIST `interval` → RANGE `open_time`）。
 *
 * 为什么要搬（2026-10-08 实测，见 docs/EXCHANGE.md 第 53 节）：
 *   · 一个 1d 档的查询要在 1100 万行 / 5.6GB 上做随机读 ⇒ 单次 3 分 33 秒，
 *     磁盘被占住 60–99%（这台机器 2 核 / 1.9GB / 33MB/s）；
 *   · 保留期靠 `DELETE` ⇒ 每天 90 万行的写放大 + 死行 + autovacuum 扫全表 3.4GB。
 * 分区之后：查询只碰自己那一档（索引从 876MB 变成几十万行的小索引），
 * 保留期变成 `DROP TABLE` 一片子分区（秒级、零死行）。
 *
 * 用法（**先停应用**，避免换表那一刻还有写入）：
 *   npm run candles:partition              # 演练：只检查、打印计划，不动数据
 *   npm run candles:partition -- --apply    # 真迁移
 *   npm run candles:partition -- --drop-old # 校验没问题之后，删掉 candles_old
 *
 * 步骤（幂等，可重复跑）：
 *   ① 前置检查（是否已分区 / 各档行数 / 磁盘余量）
 *   ② `candles` → `candles_old`（保留原索引与数据）
 *   ③ 建分区父表 + 静态骨架 + 索引（DDL 与 `schema.ts` 同一份，不各写一遍）
 *   ④ 按各档**实际最早一行**铺时间子分区
 *   ⑤ 按时间格分批搬数据（每批一个事务，进度可见）
 *   ⑥ 逐档核对行数与 `sum(close)` 校验和
 *   ⑦ `ANALYZE`
 *
 * ⚠️ 老表 `candles_old` **不自动删**：线上跑一两天确认没问题，再 `--drop-old`。
 */
import {
  CANDLES_COLUMNS,
  CANDLES_INDEX_SQL,
  CANDLES_PARTITION_SKELETON_SQL,
  SCHEMA_SQL
} from '../db/schema'
import {closePool, getPool, query, queryOne} from '../db/client'
import {
  ensureCandlePartitions,
  isCandlesPartitioned,
  minOpenTimeByInterval
} from '../db/candle-store'

const APPLY = process.argv.includes('--apply')
const DROP_OLD = process.argv.includes('--drop-old')

const DAY_MS = 86_400_000
/** 一档的期望值（与 candle-store 的保留期/粒度一致；这里只用于打印计划） */
const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const

function log(msg: string): void {
  console.log(msg)
}

async function tableExists(name: string): Promise<boolean> {
  const row = await queryOne<{n: string}>(
    `SELECT count(*)::text AS n FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relname = $1`,
    [name]
  )
  return Number(row?.n ?? 0) > 0
}

/** 逐档：行数 + `sum(close)`（校验和，用来证明搬运没丢行也没改值） */
async function snapshot(table: string): Promise<Map<string, {rows: number; sum: number}>> {
  const rows = await query<{interval: string; n: string; s: number | null}>(
    `SELECT interval, count(*)::text AS n, sum(close) AS s FROM ${table} GROUP BY interval`
  )
  return new Map(rows.map(r => [r.interval, {rows: Number(r.n), sum: Number(r.s ?? 0)}]))
}

async function main(): Promise<void> {
  log('=== candles 分区迁移 ===')

  if (DROP_OLD) {
    if (!(await tableExists('candles_old'))) {
      log('没有 candles_old，不用删')
      return
    }
    if (!(await isCandlesPartitioned())) {
      throw new Error('candles 还没分区 —— 别删 old！先跑 --apply')
    }
    log('DROP TABLE candles_old ...')
    await query('DROP TABLE candles_old')
    log('✓ 已删除 candles_old')
    return
  }

  const partitioned = await isCandlesPartitioned()
  const hasOld = await tableExists('candles_old')
  log(`当前状态：candles 已分区=${partitioned}，candles_old 存在=${hasOld}`)

  /*
   * 续跑：上次半途（比如建父表那步报错）时 candles 已经不存在、或者已经建好了分区父表。
   * 每一步都是幂等的，所以这里按状态决定从哪一步接着走 —— 迁移这种一次性动作
   * 不该因为中途一个报错就得人工收拾。
   */
  /*
   * ⚠️⚠️ 「已经是分区表、但 `candles_old` 不存在」**不代表要重来一遍**（2026-10-08 修）。
   *
   * 这个状态有两个正常来源：
   *   ① 迁移完、观察够了、按文档跑了 `--drop-old`（老表已删）；
   *   ② 整库是从别处灌进来的（例如把本地库整体同步上来）。
   * 而原逻辑只认 `!partitioned` 才叫"要迁移"，`hasOld` 那两个分支管不到这一格 ⇒
   * 它会**直接走到步骤 ① 把线上正在用的分区表改名成 `candles_old`，然后当成首次迁移
   * 重新搬 1000 多万行**（发布窗口内 = 几小时停机 + 多占一倍磁盘）。
   *
   * 所以显式判一次：没有老表可搬 ⇒ 根本没有"迁移"这件事，只做 ③ 的幂等维护。
   */
  const needMigrate = !partitioned
  if (partitioned && !hasOld) {
    log('  已经是分区表、且没有 candles_old ⇒ 没有要迁移的东西，只做幂等维护')
  }
  if (needMigrate && hasOld) {
    log('（续跑）candles_old 在、分区父表还没建好 ⇒ 直接从「建父表」接着走')
  }
  if (needMigrate && !hasOld) {
    const before0 = await snapshot('candles')
    let total0 = 0
    for (const it of INTERVALS) total0 += before0.get(it)?.rows ?? 0
    log(`  当前 candles 是普通表，${total0} 行`)
    if (!APPLY) {
      log('\n演练模式：不做任何改动。真迁移请加 --apply（记得先停应用）。')
      log('迁移会做：candles → candles_old；建分区父表 + 骨架 + 索引；按各档最早一行铺子分区；')
      log('          按时间格分批搬运（幂等，可重复跑）；逐档核对行数与 sum(close)；ANALYZE。')
      return
    }
  } else if (!APPLY) {
    log('\n已经迁移过了。这次只做幂等维护（补齐时间子分区）。真做请加 --apply。')
    return
  }

  /* 迁移前的账（校验用）：只记一次，续跑时从 candles_old 重新数 */
  const before = await snapshot(hasOld ? 'candles_old' : 'candles')
  let total = 0
  for (const it of INTERVALS) {
    const s = before.get(it)
    total += s?.rows ?? 0
    log(`  ${it.padEnd(4)} ${String(s?.rows ?? 0).padStart(10)} 行`)
  }
  log(`  合计 ${total} 行`)

  /* ① 老表让位（数据与索引都跟着走）。已经让过了就跳过 */
  if (!needMigrate) {
    log('\n① 跳过（已经是分区表，不需要让位）')
  } else if (!hasOld) {
    log('\n① candles → candles_old')
    await query('ALTER TABLE candles RENAME TO candles_old')
  } else {
    log('\n① candles → candles_old（已经让过了，跳过）')
  }

  /* ② 建分区父表 + 骨架 + 索引（DDL 与 schema.ts 同一份） */
  log('② 建分区父表 + 骨架 + 索引')
  if (!needMigrate) {
    log('  （已经是分区表，跳过）')
  } else if (!(await isCandlesPartitioned())) {
    if (!(await tableExists('candles'))) {
      await query(`CREATE TABLE candles (${CANDLES_COLUMNS}\n) PARTITION BY LIST (interval)`)
    }
    await query(CANDLES_INDEX_SQL)
    await query(CANDLES_PARTITION_SKELETON_SQL)
  } else {
    log('  （已经是分区表了，跳过）')
  }

  /* ③ 按各档实际最早一行铺子分区（老数据不能漏） */
  log('③ 铺时间子分区（按各档最早一行）')
  /*
   * ⚠️⚠️ `fromMs` 必须从**数据所在的那张表**读，不能靠 `coverExisting`。
   *
   * `coverExisting` 走的是 `minOpenTimeByInterval()`，默认读 `candles` —— 可走到这一步时
   * 老表在步骤 ① 已经改名成 `candles_old`，`candles` 是**刚建好的空父表** ⇒ 读回来是空的
   * ⇒ 下界退化成「现在 − 该档保留期」⇒ **比保留期更老的行全掉进 DEFAULT**。
   * 而 DEFAULT 里的行**永远不会被清理**（`pruneByPartition` 只 DROP 具名子分区）——
   * 2026-10-08 线上实测踩到：1m 的 09-18 ~ 09-19 共 **118,000 行**卡在 `candles_1m_def` 里。
   */
  const source = hasOld ? 'candles_old' : 'candles'
  const mins = await minOpenTimeByInterval(source)
  log(`  最早一行（读自 ${source}）：`)
  for (const it of INTERVALS) {
    const t = mins.get(it)
    log(`    ${it.padEnd(4)} ${t ? new Date(t).toISOString() : '（无数据）'}`)
  }
  /*
   * ⚠️ 按档各给各的下界。**别用全档最小值**：1d 的最早一行是 2024-01，
   *    拿它当 1m 的下界会白造两年多的日切片；反过来拿 1m 的下界去铺 15m，
   *    又会给那些"那几天 15m 根本没数据"的日子造一堆空分区。
   */
  const created = await ensureCandlePartitions({fromByInterval: mins})
  log(`  建了 ${created.length} 个子分区`)

  /* ④ 分批搬运：粗档按 30 天、细档按 1 天，一批一个事务。
         `ON CONFLICT DO NOTHING` ⇒ 幂等，中断了重跑不会插重（也不会报键冲突）。 */
  /** 本次真的搬了多少行 —— ⑤ 靠它判断该做严格核对还是放宽（见那段 ⚠️⚠️） */
  let movedTotal = 0
  if (needMigrate) log('④ 搬数据（按时间格分批；幂等，可重复跑）')
  else log('④ 跳过（没有要搬的东西）')
  for (const it of needMigrate ? INTERVALS : []) {
    const range = await queryOne<{a: Date | null; b: Date | null}>(
      `SELECT min(open_time) AS a, max(open_time) AS b FROM candles_old WHERE interval = $1`,
      [it]
    )
    if (!range?.a) {
      log(`  ${it.padEnd(4)} 没有数据，跳过`)
      continue
    }
    const step = it === '1m' || it === '5m' || it === '15m' ? DAY_MS : 30 * DAY_MS
    const from = new Date(range.a).getTime()
    const to = new Date(range.b as Date).getTime() + step
    let moved = 0
    const t0 = Date.now()
    for (let t = from; t < to; t += step) {
      const res = await getPool().query(
        `INSERT INTO candles SELECT * FROM candles_old
          WHERE interval = $1 AND open_time >= $2 AND open_time < $3
          ON CONFLICT DO NOTHING`,
        [it, new Date(t), new Date(t + step)]
      )
      moved += res.rowCount ?? 0
      process.stdout.write(`\r  ${it.padEnd(4)} 已搬 ${String(moved).padStart(10)} 行`)
    }
    movedTotal += moved
    process.stdout.write(
      `\r  ${it.padEnd(4)} 已搬 ${String(moved).padStart(10)} 行` +
        `（用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）\n`
    )
  }

  /*
   * ⑤ 核对。
   *
   * ⚠️⚠️ **只有在「本次真的搬了行」时才能拿 `candles` 去和 `candles_old` 严格比**（2026-10-08 修）。
   *
   * 原来这里无条件严格比，注释还写着「与 candles_old 比，续跑也准」—— 那个判断是**错的**：
   * `candles_old` 是**迁移那一刻的冻结快照**，而迁移完成后 `candles` 一直在被实时写入
   * ⇒ 之后任何一次重跑都会算出 `candles` 比 `candles_old` **多**，
   * 于是脚本报「迁移失败」退出非零。而 `scripts/deploy.sh` 里是：
   *
   *     if ! ... migrate-candles-partitions.js --apply; then
   *       warn '分区迁移失败 —— 应用先不启，避免它对着半迁移的库写'
   *       exit 1
   *     fi
   *
   * ⇒ **下一次发布就会因为这个假警报把应用起不来**（首次迁移撞不到，因为那时还没有"之后"）。
   * 本地实测撞到：5 档全部报 ✗（1m 4,791,218 → 4,852,876，多的正是迁移后实时写入的）。
   *
   * 所以按「本次搬了几行」分两种核对：
   *   · 搬过（`movedTotal > 0`）⇒ 严格比（刚搬完、且发布时应用是停着的，就该逐位相等）；
   *   · 没搬（幂等维护）⇒ 只要求 `candles` **不少于** `candles_old`，多的那部分是
   *     迁移之后的实时写入，如实打出来。「少了」才是真信号（有数据被弄丢），必须报错。
   */
  let bad = 0
  if (!hasOld) {
    /*
     * 根本没有 `candles_old` ⇒ 这一次没发生"迁移"，没有可比的对象。
     * 只报事实 + 查一个**真正有用的不变量**：DEFAULT 兜底里不该留行
     * （DEFAULT 里的行永远不会被清理，见 docs/EXCHANGE.md 第 58 节）。
     */
    log('⑤ 核对（没有 candles_old 可比：本次没有发生迁移）')
    const now = await snapshot('candles')
    for (const it of INTERVALS) {
      log(`  ${it.padEnd(4)} ${String(now.get(it)?.rows ?? 0).padStart(10)} 行`)
    }
    let defRows = 0
    for (const it of INTERVALS) {
      const row = await queryOne<{n: string}>(
        `SELECT count(*)::text AS n FROM candles_${it}_def`
      )
      const n = Number(row?.n ?? 0)
      defRows += n
      if (n) log(`  ⚠️ candles_${it}_def 里还有 ${n} 行 —— 下一轮维护会搬进具名子分区`)
    }
    log(defRows ? '  （DEFAULT 有残留，属可自愈状态，见第 58 节）' : '  DEFAULT 兜底干净 ✓')
  } else if (movedTotal > 0) {
    log(`⑤ 核对（严格：本次搬了 ${movedTotal} 行）`)
    const fromOld = await snapshot('candles_old')
    const after = await snapshot('candles')
    for (const it of INTERVALS) {
      const a = fromOld.get(it) ?? {rows: 0, sum: 0}
      const b = after.get(it) ?? {rows: 0, sum: 0}
      const rowsOk = a.rows === b.rows
      /* 浮点求和顺序变了 ⇒ 允许相对误差；量级 1e-9 足够抓出"搬运丢行/改值" */
      const tol = Math.max(1e-6, Math.abs(a.sum) * 1e-9)
      const sumOk = Math.abs(a.sum - b.sum) <= tol
      if (!rowsOk || !sumOk) bad++
      log(
        `  ${it.padEnd(4)} 行 ${a.rows} → ${b.rows} ${rowsOk ? '✓' : '✗'}` +
          `   Σclose ${a.sum.toFixed(2)} → ${b.sum.toFixed(2)} ${sumOk ? '✓' : '✗'}`
      )
    }
    if (bad) throw new Error(`有 ${bad} 档对不上 —— 别删 candles_old，先查清楚`)
  } else {
    log('⑤ 核对（幂等维护：本次没有搬运 ⇒ 不严格比，只查有没有"变少"）')
    const fromOld = await snapshot('candles_old')
    const after = await snapshot('candles')
    for (const it of INTERVALS) {
      const a = fromOld.get(it) ?? {rows: 0, sum: 0}
      const b = after.get(it) ?? {rows: 0, sum: 0}
      const lost = a.rows > b.rows
      if (lost) bad++
      log(
        `  ${it.padEnd(4)} 行 ${a.rows} → ${b.rows} ${lost ? '✗ 少行，数据丢了' : '✓'}` +
          `（+${b.rows - a.rows} = 迁移之后的实时写入）`
      )
    }
    if (bad) {
      throw new Error(
        `有 ${bad} 档比 candles_old **少** —— 这才是有数据被弄丢，别删 candles_old，先查清楚`
      )
    }
  }

  /* ⑥ 统计信息（刚搬完 planner 手里还是空的） */
  log('⑥ ANALYZE')
  await query('ANALYZE candles')

  log('\n✓ 完成。')
  if (hasOld) {
    log('  candles_old 先留着；线上观察一两天后：')
    log('    npm run candles:partition -- --drop-old')
    log('  ⚠️ 老表还占着几个 GB，确认无误前别急着删。')
  }
}

main()
  .catch(e => {
    console.error(`\n✗ 迁移失败：${(e as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => closePool())
