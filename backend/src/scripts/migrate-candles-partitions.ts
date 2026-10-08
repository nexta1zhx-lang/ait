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
import {ensureCandlePartitions, isCandlesPartitioned} from '../db/candle-store'

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
  if (!partitioned && hasOld) {
    log('（续跑）candles_old 在、分区父表还没建好 ⇒ 直接从「建父表」接着走')
  }
  if (!partitioned && !hasOld) {
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
  if (!hasOld) {
    log('\n① candles → candles_old')
    await query('ALTER TABLE candles RENAME TO candles_old')
  } else {
    log('\n① candles → candles_old（已经让过了，跳过）')
  }

  /* ② 建分区父表 + 骨架 + 索引（DDL 与 schema.ts 同一份） */
  log('② 建分区父表 + 骨架 + 索引')
  if (!(await isCandlesPartitioned())) {
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
  const created = await ensureCandlePartitions({coverExisting: true})
  log(`  建了 ${created.length} 个子分区`)

  /* ④ 分批搬运：粗档按 30 天、细档按 1 天，一批一个事务。
         `ON CONFLICT DO NOTHING` ⇒ 幂等，中断了重跑不会插重（也不会报键冲突）。 */
  log('④ 搬数据（按时间格分批；幂等，可重复跑）')
  for (const it of INTERVALS) {
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
    process.stdout.write(
      `\r  ${it.padEnd(4)} 已搬 ${String(moved).padStart(10)} 行` +
        `（用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）\n`
    )
  }

  /* ⑤ 核对：行数 + sum(close) 逐档比（与 candles_old 比，不是与"迁移前快照"比 —— 续跑也准） */
  log('⑤ 核对（对 candles_old）')
  const after = await snapshot('candles')
  const fromOld = await snapshot('candles_old')
  let bad = 0
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

  /* ⑥ 统计信息（刚搬完 planner 手里还是空的） */
  log('⑥ ANALYZE')
  await query('ANALYZE candles')

  log('\n✓ 迁移完成。candles_old 先留着；线上观察一两天后：')
  log('    npm run candles:partition -- --drop-old')
  log('  ⚠️ 老表还占着 ~5.5GB，确认无误前别急着删。')
}

main()
  .catch(e => {
    console.error(`\n✗ 迁移失败：${(e as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => closePool())
