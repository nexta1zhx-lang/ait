/**
 * 交易所快照的**分级归档 + 清理**（2026-10-06）。
 *
 * ## 为什么必须要有
 *
 * `exchange_snapshots` 每 5 分钟写一行、每套 key 一天 288 行，而**原来没有任何清理**
 * （`db/prune.ts` 只管 `analyses` / `llm_usage`）。实测单行 ≈ 1.2 kB ⇒
 * 一套 key 一年 ≈ **128 MB**，100 套就是 **12 GB/年**、300 套 38 GB/年。
 * 这是这套设计里**唯一会随时间无限涨**的东西（docs/EXCHANGE.md 第 9 节：磁盘才是真瓶颈）。
 *
 * ## 分档（doc 里定的）
 *
 * | kind | 来源 | 保留 |
 * |---|---|---|
 * | `5m` | 原始采样 | **7 天** |
 * | `1h` | 5m 聚合 | **90 天** |
 * | `1d` | 1h 聚合 | **永久** |
 *
 * 稳态 ≈ 288×7 + 24×90 + 365 ≈ **4600 行/套**（≈ 5.5 MB），之后只剩 1d 在长
 * （≈ 0.44 MB/年/套）。
 *
 * ## ⚠️ 三条硬规矩
 *
 * ① **不取平均**（doc 里明确定过）：桶里只留 **close / max / min**。
 *    取平均会把「中间爆过一次仓」这种尖峰抹平 —— 资产曲线就骗人了。
 *    写法跟 `listCurve` 一致：`(array_agg(... ORDER BY taken_at DESC))[1]` 取最后一条。
 * ② **只聚合「完整的桶」**：判断条件是**桶的结束时间** ≤ 截止点，不是 `taken_at < 截止点`。
 *    否则边界那个桶会被「半截数据」聚合进去，而 `ON CONFLICT DO NOTHING`
 *    会让这条半截的永远留着、再也修不回来。
 * ③ **INSERT 和 DELETE 用同一段谓词**：删掉的必须正是刚刚聚合过的那些行，
 *    绝不允许「还没聚合就被删了」。
 *
 * ⚠️ 三档的**时间区间互不重叠**（聚合完就把低档删掉），所以 `listCurve` 那边
 *    直接 `kind IN ('5m','1h','1d')` 一锅端再分桶就行，不用判断「这段该读哪一档」。
 */
import {query} from './db/client'

/** 各档保留多久 */
const KEEP_5M_DAYS = 7
const KEEP_1H_DAYS = 90

export interface ArchiveResult {
  /** 新聚合出来的 1h 行 */
  to1h: number
  /** 新聚合出来的 1d 行 */
  to1d: number
  /** 删掉的 5m 行 */
  del5m: number
  /** 删掉的 1h 行 */
  del1h: number
}

/**
 * 跑 SQL 的东西，默认就是连接池的 `query`。
 *
 * 留这个口子是为了**能在一件事务里跑完再 ROLLBACK**（验证归档逻辑时用：
 * 拿一个专用连接 `BEGIN` → 塞点老数据 → 跑归档 → 断言 → `ROLLBACK`，
 * 一行都不落库）。
 */
export type SqlRunner = (
  sql: string,
  params?: unknown[]
) => Promise<Record<string, unknown>[]>

const poolRunner: SqlRunner = (sql, params = []) =>
  query<Record<string, unknown>>(sql, params)

/**
 * 「这个桶已经整个走在截止点之前了」——**只聚合这种桶**（规矩②）。
 * `secs` = 桶宽（3600 / 86400）。
 */
function completeBucketBefore(secs: number, days: number): string {
  return `to_timestamp((floor(extract(epoch FROM taken_at) / ${secs}) * ${secs}) + ${secs})
          <= now() - interval '${days} days'`
}

/**
 * 把 `from` 档聚合成 `to` 档（两档列全同，只是桶宽不同）。
 *
 * `bucketSec` 是目标桶宽；payload 列一律取桶内**最后一条**（= 这一档代表
 * 「桶结束那一刻的状态」，而 high/low 是**整桶的包络**）。
 */
async function aggregate(
  from: '5m' | '1h',
  to: '1h' | '1d',
  bucketSec: number,
  keepDays: number,
  exec: SqlRunner
): Promise<number> {
  const where = `kind = '${from}' AND ${completeBucketBefore(bucketSec, keepDays)}`
  const last = (col: string): string =>
    `(array_agg(${col} ORDER BY taken_at DESC))[1]`
  const rows = await exec(
    `INSERT INTO exchange_snapshots
       (user_id, key_id, kind, taken_at,
        high, high_at, low, low_at,
        wallet, unrealized, margin, available, positions, assets,
        c2c_total, c2c_detail, spot_usdt, source, err)
     SELECT
       user_id,
       key_id,
       '${to}',
       to_timestamp(floor(extract(epoch FROM taken_at) / ${bucketSec}) * ${bucketSec}),
       /* 包络：整桶的最大 / 最小净值，以及各自发生在什么时候 */
       max(high),
       (array_agg(high_at ORDER BY high DESC, taken_at DESC))[1],
       min(low),
       (array_agg(low_at ORDER BY low ASC, taken_at DESC))[1],
       /* 状态：取桶内最后一条（= 桶结束那一刻） */
       ${last('wallet')}, ${last('unrealized')}, ${last('margin')},
       ${last('available')}, ${last('positions')}, ${last('assets')},
       ${last('c2c_total')}, ${last('c2c_detail')}, ${last('spot_usdt')},
       'agg',
       null
       FROM exchange_snapshots
      WHERE ${where}
      /*
       * ⚠️ GROUP BY 里**把桶表达式原样写一遍**，不能用序号 ——
       *    SELECT 列表里那个 kind 常量（如 '1h'）自己占了一列，
       *    序号写错就会把桶表达式漏掉，报「taken_at 必须出现在 GROUP BY 里」。
       */
      GROUP BY user_id, key_id,
               to_timestamp(floor(extract(epoch FROM taken_at) / ${bucketSec}) * ${bucketSec})
     ON CONFLICT (key_id, kind, taken_at) DO NOTHING
     RETURNING id`,
    []
  )
  return rows.length
}

/**
 * 跑一轮归档 + 清理。**幂等**，多久跑一次都行（重跑只是白扫一遍）。
 *
 * ⚠️ 顺序：先聚合、后删除。中间任何一步抛错，后面的删除就不会发生 ——
 *    宁可多留几天，也不能「没聚合就删」。
 */
export async function archiveExchangeSnapshots(
  exec: SqlRunner = poolRunner
): Promise<ArchiveResult> {
  /* 先 1h 再 1d：1d 要吃刚生成的 1h */
  const to1h = await aggregate('5m', '1h', 3600, KEEP_5M_DAYS, exec)
  const to1d = await aggregate('1h', '1d', 86400, KEEP_1H_DAYS, exec)

  const del5m = await exec(
    `DELETE FROM exchange_snapshots
      WHERE kind = '5m' AND ${completeBucketBefore(3600, KEEP_5M_DAYS)}
      RETURNING id`
  )
  const del1h = await exec(
    `DELETE FROM exchange_snapshots
      WHERE kind = '1h' AND ${completeBucketBefore(86400, KEEP_1H_DAYS)}
      RETURNING id`
  )

  return {
    to1h,
    to1d,
    del5m: del5m.length,
    del1h: del1h.length
  }
}

/* ==================================================================
 * 定时跑
 * ================================================================== */

/** 多久跑一轮（归档是低优先级的活，一小时一次足够） */
const ARCHIVE_MS = 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null

/**
 * 跑一轮，**无论有没有活都打一行**。
 *
 * ⚠️ 别改成「只在有活时打」：归档是**后台静默**的活，
 *    真出问题（权限、SQL、库连不上）时如果平时一点声音都没有，
 *    你只会看到磁盘慢慢涨，却不知道它早就没在跑了。一小时一行不值钱。
 */
async function runOnce(tag: string): Promise<void> {
  try {
    const r = await archiveExchangeSnapshots()
    console.log(
      `  交易所资产  归档${tag}：聚合 1h ${r.to1h} 行 / 1d ${r.to1d} 行，` +
        `清理 5m ${r.del5m} 行 / 1h ${r.del1h} 行`
    )
  } catch (e) {
    /* 归档失败不该影响任何在线功能 —— 只记日志，下一轮再来 */
    console.warn('  交易所资产  归档失败：', (e as Error).message.slice(0, 160))
  }
}

/**
 * 起归档定时器（一小时一轮），并**立刻先跑一次** ——
 * 不然「机器重启过 / 服务停了几天」这种断档要等一小时才开始收拾。
 */
export function startExchangeArchiver(): void {
  if (timer) return
  void runOnce('（启动）')
  timer = setInterval(() => void runOnce(''), ARCHIVE_MS)
}

/** 退出时停掉（跑在途中的那一轮不用等） */
export function stopExchangeArchiver(): void {
  if (timer) clearInterval(timer)
  timer = null
}
