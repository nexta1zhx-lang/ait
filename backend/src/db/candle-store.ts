/**
 * K 线底座的库这一层（表结构见 `schema.ts` 的 `candles`）。
 *
 * 只做七件事：**写入前校验 / 批量写入 / 读最近 N 根 / 查最后一个点 / 由 1m 重算高周期 /
 * 分级清理 / 抽样对账落表**。
 * 写入用 UPSERT：实时流、补缺口、重算可能覆盖同一个桶，谁最后写谁赢（都以交易所为准）。
 *
 * ⚠️ 保留策略**按周期分级**（`pruneCandles`），别改成"统一 7 天"：
 *    1h 图要看一年、4h/1d 要看更久，砍掉就没得画了。
 *
 * ⚠️ 库里只保证**已收盘**的桶（当前那根只有 1m 有，高周期的当前根由 1m 现算）。
 *    所以读路径 = `readRecentCandles()`（完整桶）+ 底座内存里的当前根（`currentBar()`），
 *    别直接拿库里的最后一根当"正在走的那根"。
 */
import {getPool, query, queryOne} from './client'
import {loadMarketsStore} from './ccxt-markets'
import type {Candle, Timeframe} from '../types'

/** 底座记 1m，高周期由它滚出来 */
export type KlineInterval = '1m' | Timeframe

/** 底座自己滚出来的那几档（不含 1m：它就是底座本身） */
export type HighInterval = Exclude<Timeframe, '1m'>

/** 这些周期都是 1m 的整数倍 ⇒ 从 1m 滚出来的桶边界与交易所完全对齐（UTC 零点起算） */
export const HIGH_INTERVALS: HighInterval[] = ['5m', '15m', '1h', '4h', '1d']

/** 每个周期一根多少毫秒（桶对齐校验要用；与 `kline-recorder.ts` 的 `MS` 同源） */
const MS: Record<KlineInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 240 * 60_000,
  '1d': 1440 * 60_000
}

/**
 * 库里可能存在的 (exchange, market_type) 组合。
 *
 * ⚠️ 从 `ccxt_markets`（就几行）读，**别**写 `SELECT DISTINCT exchange, market_type FROM candles` ——
 * 那要扫 1000 万条索引项，又变成一次全表级开销（2026-10-07 线上就是被这类扫描拖死的）。
 * `pruneCandles` 与 `candleStoreStats` 都靠它拿 scope（`candles` 的索引全以这两列打头）。
 */
export async function knownCandleScopes(): Promise<
  {exchange: string; marketType: string}[]
> {
  const out: {exchange: string; marketType: string}[] = []
  for (const r of await loadMarketsStore()) {
    const [exchange, marketType] = r.key.split('|')
    if (!exchange || !marketType) continue
    if (!out.some(s => s.exchange === exchange && s.marketType === marketType)) {
      out.push({exchange, marketType})
    }
  }
  return out
}

export interface NewCandleRow {
  exchange: string
  marketType: string
  symbol: string
  pair: string
  interval: KlineInterval
  /** 桶开盘时间（毫秒） */
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
  takerBuyVolume: number
  /**
   * ws（实时流）/ rollup（由 1m 滚出）/ backfill（补缺口）/ seed（首灌历史）
   * / repair（直连某一档官方口径）/ audit（`candles:audit` 脚本回路）
   */
  source: string
}

/** 一次最多拼多少行 —— 每行 14 个参数，PG 上限 65535，300 行留足余量 */
const BATCH_ROWS = 300

const COLS = `exchange, market_type, symbol, pair, interval, open_time,
              open, high, low, close, volume, quote_volume, trades, taker_buy_volume,
              source`

const UPSERT = `ON CONFLICT (exchange, market_type, symbol, interval, open_time)
  DO UPDATE SET pair             = EXCLUDED.pair,
                high             = EXCLUDED.high,
                low              = EXCLUDED.low,
                close            = EXCLUDED.close,
                volume           = EXCLUDED.volume,
                quote_volume     = EXCLUDED.quote_volume,
                trades           = EXCLUDED.trades,
                taker_buy_volume = EXCLUDED.taker_buy_volume,
                source           = EXCLUDED.source,
                updated_at       = now()
  -- ⚠️ 值全一样就别写（2026-10-08）：不生成新版本 ⇒ 没有死行、不动索引。
  --    回补 / 对账 / 重算会把同一批桶反复写很多遍而且是同一个值，这正是死行与
  --    autovacuum 负载的主要来源（实测死行几小时就攒到 60 万、触发全表 3.4GB 的扫描）。
  --    source 也参与比较：同一份 OHLCV 由不同来源写进来时要留下来源变化。
  --    （open 故意不在 SET 里 —— 见 sanitizeRows：同一根的开价以第一次写入为准。）
  WHERE candles.pair             IS DISTINCT FROM EXCLUDED.pair
     OR candles.high             IS DISTINCT FROM EXCLUDED.high
     OR candles.low              IS DISTINCT FROM EXCLUDED.low
     OR candles.close            IS DISTINCT FROM EXCLUDED.close
     OR candles.volume           IS DISTINCT FROM EXCLUDED.volume
     OR candles.quote_volume     IS DISTINCT FROM EXCLUDED.quote_volume
     OR candles.trades           IS DISTINCT FROM EXCLUDED.trades
     OR candles.taker_buy_volume IS DISTINCT FROM EXCLUDED.taker_buy_volume
     OR candles.source           IS DISTINCT FROM EXCLUDED.source`

/**
 * 只补"库里没有的那个桶"（`ON CONFLICT DO NOTHING`）。
 *
 * 跟 `onlyMissing()` 是同一件事的两种落地方式：那个是"先在 JS 里滤掉"，这个是"让数据库挡掉"。
 * 用在 rollup 那条兜底路上 —— 它没法先滤（行是 SQL 里现算的）。
 */
const INSERT_MISSING_ONLY = `ON CONFLICT (exchange, market_type, symbol, interval, open_time) DO NOTHING`

function rowParams(r: NewCandleRow): unknown[] {
  return [
    r.exchange,
    r.marketType,
    r.symbol,
    r.pair,
    r.interval,
    new Date(r.openTime).toISOString(),
    r.open,
    r.high,
    r.low,
    r.close,
    r.volume,
    r.quoteVolume,
    r.trades,
    r.takerBuyVolume,
    r.source
  ]
}

/* ---------------- 写入前校验（第 1 档：实时） ----------------
 *
 * 所有入库路径（实时流 / rollup / 补缺口 / 灌历史）最后都走 `saveCandles`
 * ⇒ 校验放在这里，一处实现、四条路自动覆盖。
 *
 * 为什么要在**写入前**挡：库里放进一根坏 K 线，读路径（内存 → 库 → REST）会把它当权威
 * 数据用，图上不会报错、只会悄悄画错；而修它要等下一次 repair 覆盖 —— 不如在门口丢掉。
 *
 * ⚠️ **只丢「结构性错误」**，不做业务判断（比如"量突然大了 10 倍"那是异常检测，不是校验）：
 *    对齐 / OHLC 关系 / 值域，这三类是**一定错**的，丢了只会少一根，留着会污染整张图。
 */

export type RejectReason = 'align' | 'ohlc' | 'range' | 'dup' | 'unordered'

const REJECT_LABEL: Record<RejectReason, string> = {
  align: '未对齐桶栅格',
  ohlc: 'OHLC 关系不成立',
  range: '值域非法（非正价 / 负量 / 非有限）',
  dup: '同一批里同桶重复',
  unordered: '同一批里时间倒序'
}

const rejects: Record<RejectReason, number> = {
  align: 0,
  ohlc: 0,
  range: 0,
  dup: 0,
  unordered: 0
}
let lastRejectAt = 0
const rejectSample: string[] = []

function bumpReject(reason: RejectReason, r: NewCandleRow): void {
  rejects[reason]++
  lastRejectAt = Date.now()
  if (rejectSample.length < 5) {
    rejectSample.push(
      `${r.interval} ${r.pair} @${new Date(r.openTime).toISOString()} ` +
        `o=${r.open} h=${r.high} l=${r.low} c=${r.close} v=${r.volume}（${r.source}）`
    )
  }
}

/** 校验结果（`/api/kline/recorder` 读它） */
export function candleRejectStats(): Record<RejectReason, number> & {
  lastAt: number
  sample: string[]
} {
  return {...rejects, lastAt: lastRejectAt, sample: [...rejectSample]}
}

/** 一根 K 线的结构性校验：返回 null = 合法，否则是被拒的原因 */
function rejectReason(r: NewCandleRow, ms: number): RejectReason | null {
  if (!Number.isFinite(r.openTime) || r.openTime % ms !== 0) return 'align'
  const nums = [r.open, r.high, r.low, r.close, r.volume, r.quoteVolume, r.trades, r.takerBuyVolume]
  if (!nums.every(Number.isFinite)) return 'range'
  if (r.open <= 0 || r.high <= 0 || r.low <= 0 || r.close <= 0) return 'range'
  if (r.volume < 0 || r.quoteVolume < 0 || r.trades < 0 || r.takerBuyVolume < 0) return 'range'
  if (r.high < r.low) return 'ohlc'
  if (r.high < r.open || r.high < r.close) return 'ohlc'
  if (r.low > r.open || r.low > r.close) return 'ohlc'
  return null
}

/**
 * 过一遍校验，返回**能写的那部分**（顺序保持）。
 *
 * 单调性只在**同一批内**判（跨批判不了：补缺口 / 灌历史本来就是故意写"更早的一段"）：
 *   · 同批同桶重复 ⇒ 后来的覆盖前面的（与 UPSERT「谁最后写谁赢」同义），计数但不丢数据；
 *   · 同批同币同周期时间倒序 ⇒ **只计数不丢** —— 它幂等无害（不同主键各自插入），
 *     但出现它说明上游/调用方乱了序，值得在自检里看见。
 */
export function sanitizeRows(rows: NewCandleRow[]): NewCandleRow[] {
  const out: NewCandleRow[] = []
  const seen = new Map<string, number>()
  const lastOpen = new Map<string, number>()
  for (const r of rows) {
    const bad = rejectReason(r, MS[r.interval] ?? 0)
    if (bad) {
      bumpReject(bad, r)
      continue
    }
    const key = `${r.exchange}|${r.marketType}|${r.symbol}|${r.interval}|${r.openTime}`
    const prev = seen.get(key)
    if (prev !== undefined) {
      bumpReject('dup', r)
      out[prev] = r
      continue
    }
    const series = `${r.symbol}|${r.interval}`
    const last = lastOpen.get(series)
    if (last === undefined || r.openTime > last) lastOpen.set(series, r.openTime)
    else if (r.openTime < last) bumpReject('unordered', r)
    seen.set(key, out.length)
    out.push(r)
  }
  return out
}

/** 自检用：被拒的构成，压成一行日志 */
function describeRejects(): string {
  return (Object.keys(rejects) as RejectReason[])
    .filter(k => rejects[k] > 0)
    .map(k => `${REJECT_LABEL[k]} ${rejects[k]}`)
    .join('、')
}

/**
 * 批量 UPSERT，返回**实际变更**的行数。
 *
 * ⚠️ 2026-10-08 起 `DO UPDATE` 带 `WHERE … IS DISTINCT FROM`：**值一模一样就不写**
 *    （不生成新版本 ⇒ 不产生死行、不动索引）。原来是无条件覆盖，而回补 / 对账 / 重算
 *    会把同一批桶反复写很多遍（同一个值），那正是死行与 vacuum 负载的主要来源。
 *    `rowCount` 因此从「提交的行数」变成「真正变化的行数」，所以返回值和日志口径都叫
 *    「实际变更」——别把它当成"写了多少行"。
 */
export async function saveCandles(rows: NewCandleRow[]): Promise<number> {
  if (!rows.length) return 0
  const clean = sanitizeRows(rows)
  if (clean.length < rows.length) {
    console.warn(
      `[kline] 写入前校验丢弃 ${rows.length - clean.length}/${rows.length} 行：${describeRejects()}`
    )
  }
  if (!clean.length) return 0
  /* 记账：这一批里有没有「写下去的时候桶还没收盘」的高周期行（见 recordPendingChecks） */
  await recordPartials(clean)
  let written = 0
  for (let i = 0; i < clean.length; i += BATCH_ROWS) {
    const chunk = clean.slice(i, i + BATCH_ROWS)
    const values: unknown[] = []
    const tuples = chunk.map((r, n) => {
      values.push(...rowParams(r))
      const base = n * 15
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::timestamptz,
               $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12},
               $${base + 13}::int, $${base + 14}, $${base + 15})`
    })
    const res = await getPool().query(`INSERT INTO candles (${COLS}) VALUES ${tuples.join(',')} ${UPSERT}`, values)
    written += res.rowCount ?? 0
  }
  return written
}

/**
 * 把这一批里「高周期 + 写的时候桶还没收盘」的行记进复核账（`kline_pending_check`）。
 *
 * 为什么放在这里：四条入库路（实时流 / rollup / 补缺口 / 灌历史）最后都过 `saveCandles`
 * ⇒ 一处判定、四处生效（与 `sanitizeRows` 同一个思路），不会漏。
 *
 * ⚠️ `source !== 'seed'` 却写了未收盘的桶 = **违反设计**（`rollup` 的累加器有 `partial`
 *    自保、`rollupFrom1m` 的区间按桶对齐、REST 覆盖走 `closedOnly`），所以这里直接告警 ——
 *    等于一条断言，将来谁改坏了当场就知道，而不是等几周后靠巡检发现。
 */
async function recordPartials(rows: NewCandleRow[]): Promise<void> {
  const now = Date.now()
  const partial = rows.filter(
    r => r.interval !== '1m' && r.openTime + (MS[r.interval] ?? 0) > now
  )
  if (!partial.length) return
  const unexpected = partial.filter(r => r.source !== 'seed')
  if (unexpected.length) {
    const one = unexpected[0]
    console.warn(
      `[kline] ⚠️ 写了未收盘的高周期桶（按设计不该发生，已记账等收盘复核）：` +
        `${unexpected.length} 行，例 ${one.interval} ${one.pair} ` +
        `@${new Date(one.openTime).toISOString()}（source=${one.source}）`
    )
  }
  try {
    await recordPendingChecks(
      partial.map(r => ({
        interval: r.interval,
        symbol: r.symbol,
        openTime: r.openTime,
        scope: {exchange: r.exchange, marketType: r.marketType},
        why: r.source
      }))
    )
  } catch (e) {
    /* 记账失败不能连累落库：下轮还会再写，这一桶大不了少复核一次 */
    console.warn(`[kline] 复核记账失败：${(e as Error).message.slice(0, 120)}`)
  }
}

/**
 * 这些币在某个周期上各自最后一个点（毫秒）；没记录过的币不出现在结果里。
 *
 * ⚠️ **必须带 scope**（`exchange` + `market_type`）：`candles` 的三个索引都以这两列打头，
 *    只给 `interval + symbol` 的话**一个索引都用不上** ⇒ 顺序扫整张表。
 *    2026-10-07 线上实测：表涨到 10.45M 行 / 3.8GB 之后，这一条要跑 **6.8 分钟**
 *    （并行 worker 把 2 核机器的磁盘读到 94% io-wait），而它**开机跑 5 次、之后每 60 秒一次**
 *    （`repairSweep`）⇒ 磁盘永远占着、K 线实时写入被堵、app 容器要 3.5 分钟才 `listen()`
 *    （Caddy 全程 502）。见 docs/EXCHANGE.md §52。
 *
 * 为什么用「每币一次索引探测」而不是 `GROUP BY symbol`：带上 scope 之后 `GROUP BY` 仍要把
 * 这些币在该档的**全部**索引项读一遍（1m × 525 币 × 7 天 ≈ 530 万条）；
 * `ORDER BY open_time DESC LIMIT 1` 每个币只读**1 条**（向后索引扫，取到就停）。
 */
export async function maxOpenTimes(
  interval: KlineInterval,
  symbols: string[],
  scope: {exchange: string; marketType: string}
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!symbols.length) return out
  const rows = await query<{symbol: string; t: Date | null}>(
    `SELECT s.sym AS symbol, m.t
       FROM unnest($3::text[]) AS s(sym)
       LEFT JOIN LATERAL (
         SELECT open_time AS t
           FROM candles
          WHERE exchange = $1 AND market_type = $2 AND interval = $4 AND symbol = s.sym
          ORDER BY open_time DESC
          LIMIT 1
       ) m ON true`,
    [scope.exchange, scope.marketType, symbols, interval]
  )
  for (const r of rows) {
    if (r.t) out.set(r.symbol, new Date(r.t).getTime())
  }
  return out
}

/**
 * 把一批「准备写进去的行」滤成**只留库里确实没有的那些**。
 *
 * ## 为什么必须有它（2026-10-08 实测抓到的一次真事故）
 *
 * `saveCandles` 是**覆盖写**（UPSERT），而不同来源的字段完整度**不一样**：
 *
 * | 来源 | `trades` / `quote_volume` | 说明 |
 * | --- | --- | --- |
 * | `vision`（币安官方历史包） | **有** | 15m 953,828 行**全部**非 0 |
 * | `rollup`（由 ws 的 1m 滚出） | **有**（1m 是 ws 时） | 同一桶 523 行里 468 行非 0 |
 * | `ws`（实时 1m） | **有** | 1m 65,648 行里只有 280 行是 0 |
 * | `seed` / `backfill` / `repair` / `audit`（ccxt REST） | **一律 0** | `fetchOHLCV` 只有 OHLCV |
 *
 * 而"补洞"用的 REST 正好是**最不全**的那一种。所以「拿 REST 去补一个其实存在的桶」
 * 不是补数据，是**降级**：实测一次 `candles:audit --repair` 就把 15m 的 05:00 桶
 * （原本 468/523 行带真实笔数）里那两个币的 `trades` / `quote_volume` 抹成了 0。
 *
 * 结论：**补存量洞一律 insert-only** —— 只补"库里没有的那个桶"。
 * 要"修一个存在的桶"是另一件事（`kline_pending_check` 那条残桶复核路），
 * 那种情况**必须**覆盖，不能走这个函数。
 *
 * 代价：一条走索引的查询（`open_time` 在主键里 ⇒ 纯索引扫描），而且只在真要写之前跑一次。
 */
export async function onlyMissing(
  rows: NewCandleRow[],
  scope: {exchange: string; marketType: string}
): Promise<NewCandleRow[]> {
  if (!rows.length) return rows
  const symbols = [...new Set(rows.map(r => r.symbol))]
  const intervals = [...new Set(rows.map(r => r.interval))]
  const lo = new Date(Math.min(...rows.map(r => r.openTime)))
  const hi = new Date(Math.max(...rows.map(r => r.openTime)))
  const have = await query<{symbol: string; interval: string; open_time: Date}>(
    `SELECT symbol, interval, open_time
       FROM candles
      WHERE exchange = $1 AND market_type = $2
        AND symbol = ANY($3::text[]) AND interval = ANY($4::text[])
        AND open_time >= $5 AND open_time <= $6`,
    [scope.exchange, scope.marketType, symbols, intervals, lo, hi]
  )
  const present = new Set(
    have.map(r => `${r.symbol}|${r.interval}|${new Date(r.open_time).getTime()}`)
  )
  return rows.filter(r => !present.has(`${r.symbol}|${r.interval}|${r.openTime}`))
}

export async function lastOpenTime(
  interval: KlineInterval,
  symbol: string,
  scope: {exchange: string; marketType: string}
): Promise<number | null> {
  const row = await queryOne<{t: Date | null}>(
    `SELECT open_time AS t
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND interval = $3 AND symbol = $4
      ORDER BY open_time DESC
      LIMIT 1`,
    [scope.exchange, scope.marketType, interval, symbol]
  )
  return row?.t ? new Date(row.t).getTime() : null
}

/**
 * 这个币「最后一次**真实成交**」的时刻（该周期上 volume > 0 的最大开盘时间）。
 *
 * 为什么需要它：币下架（币安 `status = SETTLING`）之后**K 线接口还会继续给数据**，
 * 但那些是**量 0 的水平线**（实测 OMG/WAVES 下架后最近 5 根 1h 量全是 0、价格冻住）。
 * 下架时"把最后一段补完"如果补到 `now`，就会往 **4h/1d 永久档**塞一堆假 K 线
 * ⇒ 必须用这个当补数据的**上界**。
 */
export async function lastTradedAt(
  interval: KlineInterval,
  symbol: string,
  scope: {exchange: string; marketType: string}
): Promise<number | null> {
  const row = await queryOne<{t: Date | null}>(
    `SELECT max(open_time) AS t
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = $4
        AND volume > 0`,
    [scope.exchange, scope.marketType, symbol, interval]
  )
  return row?.t ? new Date(row.t).getTime() : null
}

const DAY_MS = 86_400_000

/**
 * 「基准时刻」用哪一档、往前扫多宽的窗（见 `closesAtOrBefore`）。
 *
 * 按基准时刻离现在多远挑**够用的最细一档**：越细越贴近那一刻，但只有那一档真的
 * 覆盖到了才行（实测保留：1m ≈ 7 天、15m ≈ 1 个月、1h ≈ 半年、1d ≈ 两年）。
 * `windowMs` 是往前找的余地 —— 那一刻正好没成交（冷门币）就再往前够一点。
 */
function baseProbe(atMs: number): {interval: KlineInterval; windowMs: number} {
  const age = Date.now() - atMs
  if (age <= 6 * DAY_MS) return {interval: '1m', windowMs: 3 * 3600_000}
  if (age <= 25 * DAY_MS) return {interval: '15m', windowMs: DAY_MS}
  if (age <= 170 * DAY_MS) return {interval: '1h', windowMs: 3 * DAY_MS}
  return {interval: '1d', windowMs: 20 * DAY_MS}
}

/**
 * 某个时刻各币的**收盘价**（`symbol`（`BTC/USDT:USDT`）→ close）。
 *
 * 干什么用：合约行情排行榜换基准 —— 把「24h 涨跌幅」换成「**基准时间 → 现在**」的涨跌幅
 * （见 `server.ts` 的 `handleMarkets` 与前端 `MarketPanel.vue`）。基准时刻可能是某个时区的
 * 「当天 00:00」（日切看「今日」），也可能是用户在配置里挑的**任意时刻**。
 *
 * 口径：每个币取「该档上**已收盘**且开盘时间 ≤ 基准时刻」的最后一根
 * （`open_time <= atMs - 一个周期`），所以拿到的就是那一刻（或之前最近一刻）的价。
 * 挑哪一档见 `baseProbe`；库外（太早 / 该档没覆盖）或那一段正好没成交的币
 * **不出现在 Map 里** —— 调用方该当成「没有基准价」（界面显示「—」）。
 */
export async function closesAtOrBefore(
  atMs: number,
  scope: {exchange: string; marketType: string}
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const {interval, windowMs} = baseProbe(atMs)
  const cutoff = atMs - MS[interval]
  const rows = await query<{symbol: string; close: number}>(
    `SELECT DISTINCT ON (symbol) symbol, close
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND interval = $3
        AND open_time <= $4 AND open_time > $5
      ORDER BY symbol, open_time DESC`,
    [
      scope.exchange,
      scope.marketType,
      interval,
      new Date(cutoff),
      new Date(cutoff - windowMs)
    ]
  )
  for (const r of rows) out.set(r.symbol, Number(r.close))
  return out
}

/** 某个周期上已经记了多少个点（在哪个区间）。⚠️ 同 `maxOpenTimes`：必须带 scope，否则全表扫 */
export async function candleCount(
  interval: KlineInterval,
  symbol: string,
  scope: {exchange: string; marketType: string}
): Promise<number> {
  const row = await queryOne<{n: string}>(
    `SELECT count(*)::text AS n
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND interval = $3 AND symbol = $4`,
    [scope.exchange, scope.marketType, interval, symbol]
  )
  return Number(row?.n ?? 0)
}

/**
 * 把请求里的币种写法（`BTC` / `BTCUSDT` / `BTC/USDT:USDT`）归一成**库里存的那种**统一形式。
 *
 * 底座只覆盖 U 本位永续（`market.ts` 的 `listPerpetualSymbols`：swap + linear + quote=USDT），
 * ccxt 给它们的统一形式就是 `BASE/USDT:USDT` —— 这既是 `candles.symbol` 存的值，
 * 也正好是主键（exchange, market_type, symbol, interval, open_time）的**前缀**：
 * 按它查才走索引（按 `pair` 查是另一个列，会全表扫 1000 万行）。
 * ⚠️ 非 U 本位永续（现货 / 币本位）没有这层数据，调用方该直接走 REST。
 */
export function unifiedPerpSymbol(raw: string): string {
  const base = raw.trim().toUpperCase().split(/[/:]/)[0]
  const bare = base.endsWith('USDT') ? base.slice(0, -4) : base
  return `${bare}/USDT:USDT`
}

/**
 * 把某段**已收盘的 1m** 汇总成一根（给「当前根」用）。
 *
 * 为什么要它：高周期的当前根在内存里靠累加器合成，可累加器**刚重启 / 漏过分钟就不可信**
 * （`Agg.partial`）—— 那种时候最后一根的 `open` 会取错、量会小一大截。
 * 这时用「库里的 1m（已收盘那部分）+ 当前这根活的 1m」现拼一根才是对的。
 *
 * ⚠️ `open` 必须是**最早那根**的 open、`close` 是**最晚那根**的 close，
 *    所以用 `array_agg(... ORDER BY open_time)` 取首尾 —— 别写成 `min(open)/max(close)`，
 *    那是"这段里的最低开价/最高收价"，不是桶的开收。
 */
export async function sumClosed1m(
  symbol: string,
  from: number,
  to: number,
  scope: {exchange: string; marketType: string}
): Promise<{
  open: number
  high: number
  low: number
  close: number
  volume: number
} | null> {
  if (to <= from) return null
  const row = await queryOne<{
    open: number | null
    high: number | null
    low: number | null
    close: number | null
    volume: number | null
  }>(
    `SELECT (array_agg(open  ORDER BY open_time ASC ))[1] AS open,
            max(high) AS high,
            min(low)  AS low,
            (array_agg(close ORDER BY open_time DESC))[1] AS close,
            sum(volume) AS volume
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = '1m'
        AND open_time >= $4 AND open_time < $5`,
    [scope.exchange, scope.marketType, symbol, new Date(from), new Date(to)]
  )
  if (!row || row.open === null || row.close === null) return null
  return {
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0)
  }
}

/**
 * 这个 (币, 周期) 在库里覆盖到哪儿（最早/最晚各一根的开盘时间，毫秒）。
 *
 * 干什么用：区间请求（`/api/candles?from=&to=`，前端「往前拖看更早」与「选某一刻」）
 * 要先问一句「这段库里到底有没有」—— **有就本地读（毫秒级、0 权重），没有才打交易所**。
 * 走主键前缀（exchange, market_type, symbol, interval），min/max 直接读索引两头，很快。
 */
export async function candleSpan(
  interval: KlineInterval,
  symbol: string,
  scope: {exchange: string; marketType: string}
): Promise<{first: number; last: number} | null> {
  const row = await queryOne<{a: Date | null; b: Date | null}>(
    `SELECT min(open_time) AS a, max(open_time) AS b
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = $4`,
    [scope.exchange, scope.marketType, symbol, interval]
  )
  if (!row?.a || !row?.b) return null
  return {first: new Date(row.a).getTime(), last: new Date(row.b).getTime()}
}

/**
 * 读某段区间**已收盘**的 K 线（`from` 起、正序、最多 `limit` 根，含 `to` 那一刻）。
 *
 * ⚠️ 语义必须跟 `market.ts` 的 `fetchCandlesRange` **一模一样**（那边是「从 from 正序取满
 *    maxCandles 根、`ts <= to`」），否则「库内走库、库外走 REST」两段拼起来会错位。
 */
export async function readRangeCandles(
  interval: KlineInterval,
  symbol: string,
  limit: number,
  from: number,
  to: number,
  scope: {exchange: string; marketType: string}
): Promise<Candle[]> {
  if (limit <= 0 || to < from) return []
  const rows = await query<{
    open_time: Date
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>(
    `SELECT open_time, open, high, low, close, volume
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = $4
        AND open_time >= $5 AND open_time <= $6
      ORDER BY open_time ASC
      LIMIT $7`,
    [scope.exchange, scope.marketType, symbol, interval, new Date(from), new Date(to), limit]
  )
  return rows.map(r => ({
    timestamp: new Date(r.open_time).getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume)
  }))
}

/**
 * 读某个币、某个周期**最近 `limit` 根已收盘的 K 线**（返回时新的在后）。
 *
 * 这是 P1 读路径的第二层（`内存 → 库 → REST`）：底座在常驻写它，
 * 读一次是本地库的毫秒级往返、**0 权重**，比打交易所便宜两个数量级。
 *
 * ⚠️ 库里只有**已收盘**的桶 —— 当前那根要调用方自己接上（`kline-recorder.ts` 的
 *    `currentBar()`），别把这里的最后一根当成"正在走的那根"。
 * ⚠️ 也只覆盖「底座订阅过的币 × 保留窗口内」：查不到（新上市、非 swap、超窗）
 *    就返回空数组，让调用方退回 REST。
 */
export async function readRecentCandles(
  interval: KlineInterval,
  symbol: string,
  limit: number,
  scope: {exchange: string; marketType: string}
): Promise<Candle[]> {
  if (limit <= 0) return []
  const rows = await query<{
    open_time: Date
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>(
    `SELECT open_time, open, high, low, close, volume
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = $4
      ORDER BY open_time DESC
      LIMIT $5`,
    [scope.exchange, scope.marketType, symbol, interval, limit]
  )
  const out: Candle[] = []
  // DESC 取回来的，翻成时间正序（前端/分析都按"新的在后"用）
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    out.push({
      timestamp: new Date(r.open_time).getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume)
    })
  }
  return out
}

/**
 * 由 1m **重算**某个高周期的一段桶。
 *
 * 什么时候用：补了缺口之后（回补的 1m 是直接写库的，没经过内存累加器）。
 * ⚠️ 只重算**已经完整的桶**（`to` 传当前桶起点），别去覆盖正在累加的那个桶 ——
 *    内存里那份还没 flush，两边会打架。
 */
export async function rollupFrom1m(
  interval: Timeframe,
  symbols: string[],
  fromMs: number,
  toMs: number,
  bucketMs: number,
  scope: {exchange: string; marketType: string},
  /**
   * `true` = **只补缺的**（`ON CONFLICT DO NOTHING`），不覆盖已存在的桶。
   *
   * ⚠️ 「补洞」那条路必须传 `true`：rollup 是从库里的 1m 现算的，而 1m 自己可能是
   *    `seed` / `backfill` 来的（只有 OHLCV、`trades` / `quote_volume` 存 0），
   *    也可能是 ws 来的（笔数是真的）。**算出来的值不一定比库里那行好**，
   *    覆盖写就可能拿 0 盖掉真值（实测见 `onlyMissing` 的说明）。
   *    只有"修一个已经存在但值不对的桶"（残桶裁决）才该覆盖。
   */
  fillOnly = false
): Promise<number> {
  if (!symbols.length || fromMs >= toMs) return 0
  const res = await getPool().query(
    `INSERT INTO candles (${COLS})
     SELECT exchange, market_type, symbol, pair, $1,
            to_timestamp(floor(extract(epoch FROM open_time) * 1000 / $2) * $2 / 1000),
            (array_agg(open  ORDER BY open_time ASC))[1],
            max(high),
            min(low),
            (array_agg(close ORDER BY open_time DESC))[1],
            sum(volume), sum(quote_volume), sum(trades), sum(taker_buy_volume),
            'rollup'
       FROM candles
      WHERE exchange = $6 AND market_type = $7 AND interval = '1m' AND symbol = ANY($3::text[])
        AND open_time >= to_timestamp($4 / 1000.0)
        AND open_time <  to_timestamp($5 / 1000.0)
      GROUP BY exchange, market_type, symbol, pair,
               floor(extract(epoch FROM open_time) * 1000 / $2)
     ${fillOnly ? INSERT_MISSING_ONLY : UPSERT}`,
    [interval, bucketMs, symbols, fromMs, toMs, scope.exchange, scope.marketType]
  )
  /*
   * ⚠️ 这条 INSERT 绕过了 `saveCandles` ⇒ 记账钩子要单独补一次（否则它写出的残桶没人复核）。
   *    正常调用方（`repairSymbol`）的 `from`/`to` 都按桶对齐、且 `to` = 当前桶起点，
   *    所以这里几乎不会触发；一旦触发就说明有人传了非对齐区间 ⇒ 记账 + 告警。
   */
  const lastBucket = Math.floor((toMs - 1) / bucketMs) * bucketMs
  if (lastBucket + bucketMs > Date.now()) {
    console.warn(
      `[kline] ⚠️ rollupFrom1m 写到了未收盘的桶（${interval} @${new Date(lastBucket).toISOString()}）——` +
        `按构造不该发生，已记账等收盘复核`
    )
    await recordPendingChecks(
      symbols.map(symbol => ({
        interval: interval as KlineInterval,
        symbol,
        openTime: lastBucket,
        scope,
        why: 'rollup'
      }))
    ).catch(() => undefined)
  }
  return res.rowCount ?? 0
}

/** 分级保留：超期就删（周期 → 保留多久） */
const KEEP: [KlineInterval, string][] = [
  ['1m', '7 days'],
  ['5m', '7 days'],
  ['15m', '30 days'],
  ['1h', '400 days']
]
/** 一次 DELETE 最多删多少行（老库路径：避免长事务 + 一次性写放大） */
const PRUNE_BATCH = 20_000

export interface PruneResult {
  /** 删掉/丢掉的**行数**（分区路径是估计值，来自 `reltuples`） */
  rows: number
  /** 丢掉的子分区名（分区路径才有） */
  partitions: string[]
}

/**
 * 分级清理。返回删掉的行数（分区路径还会返回丢掉的子分区名）。
 *
 * 为什么这么分：1m/5m 只在「最近的图」上有用；15m 要能画 30 天；1h 要能画一年；
 * 4h/1d 一辈子最值钱（一年才 19 万行）。
 *
 * 两条路：
 *  · **分区表（2026-10-08 起，线上常态）**：直接 `DROP` 过期的时间子分区 ——
 *    秒级、零死行、不触发 autovacuum 扫全表。这是这套分区最主要的目的。
 *  · **老库（还没迁移）**：按 scope + 档位分批删。⚠️ 必须**按 scope 拆开、一档一条 DELETE**：
 *    原来那条 `(interval='1m' AND open_time < …) OR …` 四条分支都缺索引前缀 ⇒ 顺序扫 3.8GB。
 */
export async function pruneCandles(): Promise<PruneResult> {
  if (await isCandlesPartitioned()) return pruneByPartition()
  let rows = 0
  for (const s of await knownCandleScopes()) {
    for (const [interval, keep] of KEEP) {
      for (;;) {
        const res = await getPool().query(
          `DELETE FROM candles WHERE ctid IN (
             SELECT ctid FROM candles
              WHERE exchange = $1 AND market_type = $2 AND interval = $3
                AND open_time < now() - $4::interval
              LIMIT $5)`,
          [s.exchange, s.marketType, interval, keep, PRUNE_BATCH]
        )
        const n = res.rowCount ?? 0
        rows += n
        if (n < PRUNE_BATCH) break
      }
    }
  }
  return {rows, partitions: []}
}

/** 1d 收盘序列（**新的在前**）—— 给「N 天涨幅」算基点用 */
export interface DailyClose {
  /** 那根 1d 的开盘时间（UTC 零点，毫秒） */
  at: number
  close: number
}

/**
 * 从底座库里读 1d 收盘。
 *
 * ⚠️ 底座只记 U 本位永续（`market_type='swap'`）⇒ 现货 / 币本位这里查不到，
 *    调用方要退回 REST（见 `market.ts` 的 `fetchTickerInfo`）。
 */
export async function dailyCloses(
  exchange: string,
  marketType: string,
  symbol: string,
  limit = 400
): Promise<DailyClose[]> {
  const rows = await query<{t: Date; c: number}>(
    `SELECT open_time AS t, close AS c
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = '1d'
      ORDER BY open_time DESC
      LIMIT $4`,
    [exchange, marketType, symbol, Math.max(1, Math.round(limit))]
  )
  return rows.map(r => ({at: new Date(r.t).getTime(), close: Number(r.c)}))
}

export interface CandleStoreStats {
  /** 行数：默认是**估计值**（`pg_class.reltuples`），`exact` 时才是精确值 */
  rows: number
  /** 上面那个 `rows` 是不是精确值 */
  exact: boolean
  sizeBytes: number
  byInterval: Record<string, {rows: number | null; from: string | null; to: string | null}>
}

/** 库里所有档（1m 在最前，其余按 `HIGH_INTERVALS`） */
export const ALL_INTERVALS: KlineInterval[] = ['1m', ...HIGH_INTERVALS]

/* ---------------- 分区：粒度 / 保留期 / 建与删（2026-10-08） ----------------
 *
 * `candles` 是从 2026-10-08 起**两级分区**的：`LIST (interval)` → `RANGE (open_time)`
 * （见 `schema.ts` 的 `candles` 段）。这一节是它的运行时助手：
 *   · `ensureCandlePartitions()` —— 建时间子分区（启动 / 每天 / 迁移时）
 *   · `pruneCandles()` —— 保留期改成 **DROP 整片子分区**（下面的 `pruneByPartition`）
 *
 * 为什么值得动结构（2026-10-08 实测，见 docs/EXCHANGE.md 第 53 节）：
 *   · 查询只碰自己那一档 ⇒ 索引从「1100 万行的 876MB」变成每档几十万行的小索引，
 *     缓存命中率上去（这台机器 `shared_buffers` 384MB + OS 1.4GB，而数据 5.6GB）；
 *   · 保留期不再是一天 90 万行 DELETE（三份索引写放大 + 死行 + autovacuum 扫全表 3.4GB），
 *     而是 `DROP TABLE` 一片 —— 秒级、零死行。
 */
export type PartGranularity = 'day' | 'month' | 'year'

/** 每档的时间子分区粒度（粒度比保留期粗时，最老那一片会多留一格） */
export const PART_GRANULARITY: Record<KlineInterval, PartGranularity> = {
  '1m': 'day',
  '5m': 'day',
  '15m': 'day',
  '1h': 'month',
  '4h': 'year',
  '1d': 'year'
}

/** 分级保留期（null = 永久）。⚠️ 与 docs/EXCHANGE.md 的保留表同一个口径 */
export const KLINE_RETENTION: Record<KlineInterval, string | null> = {
  '1m': '7 days',
  '5m': '7 days',
  '15m': '30 days',
  '1h': '400 days',
  '4h': null,
  '1d': null
}

/** 永久保留的档：建子分区时往回铺多久（灌历史最多两年多） */
const FOREVER_LOOKBACK_MS = 3 * 365 * 24 * 3600 * 1000

/** 把 `'7 days'` 这种写法换算成毫秒（本地小工具，只认 `N day(s)`） */
export function keepMs(keep: string): number {
  const m = /^(\d+)\s*days?$/.exec(keep)
  if (!m) throw new Error(`保留期写法不认识：${keep}`)
  return Number(m[1]) * DAY_MS
}

/** 该时刻所在时间格的起点（UTC：天/月/年） */
export function periodStartOf(ms: number, g: PartGranularity): number {
  const d = new Date(ms)
  if (g === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  if (g === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  return Date.UTC(d.getUTCFullYear(), 0, 1)
}

/** 该时间格的**下一个**起点（= 本格终点，左闭右开） */
export function periodEndOf(startMs: number, g: PartGranularity): number {
  const d = new Date(startMs)
  if (g === 'day') return startMs + DAY_MS
  if (g === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return Date.UTC(d.getUTCFullYear() + 1, 0, 1)
}

/** 子分区命名：`candles_1m_20261008`（时间格起点）。`pruneCandles` 按这个名字反解 */
export function partNameOf(interval: KlineInterval, startMs: number): string {
  const d = new Date(startMs)
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  return `candles_${interval}_${ymd}`
}

/** 反解名字；不是时间子分区（DEFAULT、子父表、别的表）就返回 null */
export function parsePartName(name: string): {interval: KlineInterval; startMs: number} | null {
  const m = /^candles_(1m|5m|15m|1h|4h|1d)_(\d{4})(\d{2})(\d{2})$/.exec(name)
  if (!m) return null
  return {
    interval: m[1] as KlineInterval,
    startMs: Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]))
  }
}

/** `candles` 是不是已经分区了（迁移前的老库是普通表 ⇒ 建/删分区都要退化成老办法） */
export async function isCandlesPartitioned(): Promise<boolean> {
  const row = await queryOne<{relkind: string}>(
    `SELECT relkind FROM pg_class WHERE relname = 'candles' AND relnamespace = current_schema()::regnamespace`
  )
  return row?.relkind === 'p'
}

/**
 * 建时间子分区，覆盖**保留期整段 + 下一格**（启动、每天、迁移时都调）。
 *
 * 幂等：已存在的直接跳过（一次查名字集合，不是几十次往返）。返回新建的名字。
 *
 * ⚠️ 每个档都有 DEFAULT 兜底分区（`schema.ts` 建的），插入永远不会因为缺分区失败；
 *    建新格时**先**把 DEFAULT 里落在这一格的行搬出来，再建分区（否则会撞约束），建完搬回去。
 * ⚠️ 分区表上父表的 `reloptions` 不继承给子分区 ⇒ 这里逐片设激进的 autovacuum。
 *
 * @param opts.fromMs 从这一刻起铺（默认按保留期铺；`coverExisting` 时按各档实际最早一行铺）
 * @param opts.coverExisting 迁移/历史灌数据用：按**库里已有的最早一行**铺，别漏掉老数据
 */
export async function ensureCandlePartitions(
  opts: {fromMs?: number; coverExisting?: boolean} = {}
): Promise<string[]> {
  if (!(await isCandlesPartitioned())) return []
  const rows = await query<{relname: string}>(
    `SELECT relname FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relname LIKE 'candles\\_%'`
  )
  const existing = new Set(rows.map(r => r.relname))
  const mins = opts.coverExisting && opts.fromMs === undefined ? await minOpenTimeByInterval() : null
  /*
   * ⚠️⚠️ 下界还要算上**每个 `*_def`（DEFAULT 兜底）里的最早一行**（2026-10-08 加）。
   *
   * 为什么必须有这一条：`pruneByPartition` 只 DROP **具名**子分区 —— **DEFAULT 里的行
   * 永远不会过期、永远清不掉**，那是条只增不减的泄漏。而迁移时若下界算窄了
   * （历史上正好踩过一次，见 `minOpenTimeByInterval` 的 ⚠️），超期的行就会堆在 DEFAULT 里。
   * 把下界一直往前够到 DEFAULT 里最早那一行，这些行就会被搬进具名子分区、随后被正常 DROP 掉。
   *
   * 收敛性：搬完 DEFAULT 就空了 ⇒ 下一轮不再往前够，不会反复建了又删。
   * 代价：6 次 `min(open_time)` —— 走继承来的主键索引，向后索引扫取到就停。
   */
  const defMin = await defaultPartitionMin()
  const now = Date.now()
  const created: string[] = []
  for (const it of ALL_INTERVALS) {
    const g = PART_GRANULARITY[it]
    const keep = KLINE_RETENTION[it]
    const floor = now - (keep ? keepMs(keep) : FOREVER_LOOKBACK_MS)
    const since = Math.min(
      opts.fromMs ?? Infinity,
      mins?.get(it) ?? Infinity,
      defMin.get(it) ?? Infinity,
      floor
    )
    const stop = periodEndOf(periodStartOf(now, g), g)
    for (let start = periodStartOf(since, g); start < stop; start = periodEndOf(start, g)) {
      const name = partNameOf(it, start)
      if (existing.has(name)) continue
      const end = periodEndOf(start, g)
      const def = `candles_${it}_def`
      /* ① DEFAULT 里落在这一格的行先拿出来（新分区建好再放回去） */
      const moved = await query<Record<string, unknown>>(
        `DELETE FROM ${def} WHERE open_time >= $1 AND open_time < $2 RETURNING *`,
        [new Date(start), new Date(end)]
      )
      /* ② 建分区：父表上的三个索引会自动带过来 */
      await query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF candles_${it}
           FOR VALUES FROM ('${new Date(start).toISOString()}') TO ('${new Date(end).toISOString()}')`
      )
      if (moved.length) {
        await query(
          `INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(null::candles, $1::jsonb)`,
          [JSON.stringify(moved)]
        )
      }
      /* ③ 子分区自己的 reloptions（父表的不继承） */
      await query(
        `ALTER TABLE ${name} SET (autovacuum_vacuum_scale_factor = 0.05,
                                  autovacuum_analyze_scale_factor = 0.02)`
      )
      existing.add(name)
      created.push(name)
    }
  }
  return created
}

/** 各档**库里最早那一行**的时刻（迁移时按它铺子分区，别漏掉老数据） */
/**
 * 每个 `candles_<档>_def`（DEFAULT 兜底）里**最早那一行**（毫秒）；空的档不出现。
 *
 * 用途见 `ensureCandlePartitions` 里那段 ⚠️⚠️：DEFAULT 里的行永远不被清理，
 * 所以建分区时下界必须一直够到它们最早那一行，好把它们搬进可 DROP 的具名子分区。
 *
 * 表可能还不存在（第一次迁移的半路上）⇒ 查不到就跳过，别让维护任务报错。
 */
async function defaultPartitionMin(): Promise<Map<KlineInterval, number>> {
  const out = new Map<KlineInterval, number>()
  for (const it of ALL_INTERVALS) {
    try {
      const row = await queryOne<{t: Date | null}>(
        `SELECT min(open_time) AS t FROM candles_${it}_def`
      )
      if (row?.t) out.set(it, new Date(row.t).getTime())
    } catch {
      /* 那片子分区还没建（或已被 DROP）—— 没有 DEFAULT 行要照顾 */
    }
  }
  return out
}

/**
 * 每档的**最早一行**（毫秒）。
 *
 * ⚠️ 默认看 `candles`，但**迁移脚本必须传 `'candles_old'`** —— 见下面 `ensureCandlePartitions`
 *    里那段 ⚠️⚠️（2026-10-08 线上就是在这里踩的：步骤 ① 已经把老表改名成 `candles_old`，
 *    再去读 `candles` 读到的是**刚建好的空父表** ⇒ 下界退化成「现在 − 保留期」⇒
 *    比保留期更老的行全掉进 DEFAULT，而且永远清不掉）。
 */
export async function minOpenTimeByInterval(
  table: 'candles' | 'candles_old' = 'candles'
): Promise<Map<KlineInterval, number>> {
  const out = new Map<KlineInterval, number>()
  for (const s of await knownCandleScopes()) {
    const rows = await query<{interval: string; a: Date | null}>(
      `SELECT interval, min(open_time) AS a FROM ${table}
        WHERE exchange = $1 AND market_type = $2 GROUP BY interval`,
      [s.exchange, s.marketType]
    )
    for (const r of rows) {
      if (!r.a) continue
      const ms = new Date(r.a).getTime()
      const key = r.interval as KlineInterval
      const prev = out.get(key)
      if (prev === undefined || ms < prev) out.set(key, ms)
    }
  }
  return out
}

/**
 * 过期子分区直接 `DROP`（保留期的实现）。
 *
 * 粒度比保留期粗时最老那片会多留一格（1d 按年切 ⇒ 永久档没有过期一说；1h 按月切
 * ⇒ 400 天实际留 13 个月）。这是可以接受的：相比「每天 90 万行 DELETE」，
 * 这点多留的行便宜得多 —— 而且它换来的是零死行、零 autovacuum 全表扫。
 */
async function pruneByPartition(): Promise<PruneResult> {
  const rows = await query<{relname: string; est: string}>(
    `SELECT relname, greatest(reltuples, 0)::bigint::text AS est
       FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relname ~ '^candles_(1m|5m|15m|1h|4h|1d)_[0-9]{8}$'`
  )
  const now = Date.now()
  let n = 0
  const dropped: string[] = []
  for (const r of rows) {
    const p = parsePartName(r.relname)
    if (!p) continue
    const keep = KLINE_RETENTION[p.interval]
    if (!keep) continue
    if (periodEndOf(p.startMs, PART_GRANULARITY[p.interval]) > now - keepMs(keep)) continue
    await query(`DROP TABLE IF EXISTS ${r.relname}`)
    n += Number(r.est)
    dropped.push(r.relname)
  }
  return {rows: n, partitions: dropped}
}

/* ---------------- 待复核的高周期桶：记账 + 复核（2026-10-08） ----------------
 *
 * 「库内自洽」原来自定时全市场扫描（每轮 4 桶 × 5 档 × 全部币 ≈ 370 万行 1m 读取、
 * 实测 4 分 40 秒，而其中 4h/1d 那 97% 从没揪出过坏桶 ⇒ 磁盘被占 60–99%）。
 * 现在只复核**我们自己写下去、且写的时候桶还没收盘**的那些桶：
 *   · 历史数据不会自己变坏（用户 2026-10-08 确认的口径）；
 *   · 掉线 / 网络抖动的后果只会落在「刚补进来的那段」上；
 *   · 真正会写坏桶的动作只有三处（seed / rollup / repair 的 REST 覆盖），
 *     而它们全部经 `saveCandles` 一处 ⇒ 在那一处判定并记账，就**不会漏**。
 */

/** 一条待复核的账目 */
export interface PendingCheck {
  interval: KlineInterval
  symbol: string
  openTime: number
  scope: {exchange: string; marketType: string}
  /** 写入来源（`seed` / `rollup` / `backfill` / `repair`），排查用 */
  why: string
}

/**
 * 记账：把「写下去的时候桶还没收盘」的高周期桶记进 `kline_pending_check`。
 *
 * 由 `saveCandles` 调（一处判定、四条写入路全覆盖）。同一批里重复的桶会去重，
 * 已记过的靠 `ON CONFLICT DO NOTHING` 幂等。
 */
export async function recordPendingChecks(rows: PendingCheck[]): Promise<number> {
  const uniq = new Map<string, PendingCheck>()
  for (const r of rows) {
    uniq.set(
      `${r.scope.exchange}|${r.scope.marketType}|${r.symbol}|${r.interval}|${r.openTime}`,
      r
    )
  }
  const list = [...uniq.values()]
  if (!list.length) return 0
  const values: unknown[] = []
  const tuples = list.map((r, n) => {
    const b = n * 6
    values.push(r.scope.exchange, r.scope.marketType, r.symbol, r.interval, new Date(r.openTime), r.why)
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::timestamptz, $${b + 6})`
  })
  await query(
    `INSERT INTO kline_pending_check (exchange, market_type, symbol, interval, open_time, why)
     VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`,
    values
  )
  return list.length
}

/** 复核出来的坏桶（交 `repairSymbol` 用交易所口径盖回去） */
export interface StaleBucketVerdict {
  symbol: string
  interval: string
  openTime: number
  why: string
  ours: {close: number; volume: number}
  from1m: {close: number; volume: number}
}

export interface PendingSweep {
  /** 这一轮取出来复核的账目数 */
  due: number
  /** 一致 ⇒ 销账 */
  ok: number
  /** 不一致 ⇒ 交修复，**留着账**继续盯 */
  stale: StaleBucketVerdict[]
  /** 1m 还没补齐（还在补数据）⇒ 留着下轮 */
  waiting: number
  /** 超过保留期仍无法判定 ⇒ 销账 + 告警（1m 都不在了，没法判） */
  expired: number
}

/**
 * 复核：只核对账上「桶已收盘」的那些，每个桶一次定向探测（≤1440 行）。
 *
 * 判据与原来那条全表扫描**逐字一致**（免得改出语义差）：
 *   该桶 1m 一根不缺（`n = 桶长` 且最后一根正好落在桶末）的前提下，
 *   `高周期行.close ≠ 1m 最后一根 close` 或 `volume 求和不符` ⇒ 残桶/陈旧值。
 */
export async function verifyPendingChecks(limit = 50): Promise<PendingSweep> {
  const out: PendingSweep = {due: 0, ok: 0, stale: [], waiting: 0, expired: 0}
  const due = await query<{
    exchange: string
    market_type: string
    symbol: string
    interval: string
    open_time: Date
    mins: number
    tries: number
    why: string
    h_close: number | null
    h_volume: number | null
    m_n: string
    m_v: number | null
    m_c: number | null
    m_t: Date | null
  }>(
    `WITH grid(ivl, mins) AS (
       VALUES ('1m', 1), ('5m', 5), ('15m', 15), ('1h', 60), ('4h', 240), ('1d', 1440)
     ), due AS (
       SELECT p.*, g.mins
         FROM kline_pending_check p
         JOIN grid g ON g.ivl = p.interval
        WHERE p.open_time + (g.mins * interval '1 minute') <= now()   -- 桶已收盘才判
        ORDER BY p.written_at
        LIMIT $1
     )
     SELECT d.exchange, d.market_type, d.symbol, d.interval, d.open_time, d.mins, d.tries,
            d.why, h.close AS h_close, h.volume AS h_volume,
            m.n AS m_n, m.v AS m_v, m.c AS m_c, m.t AS m_t
       FROM due d
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, sum(volume) AS v,
                (array_agg(close ORDER BY open_time DESC))[1] AS c, max(open_time) AS t
           FROM candles
          WHERE exchange = d.exchange AND market_type = d.market_type
            AND interval = '1m' AND symbol = d.symbol
            AND open_time >= d.open_time
            AND open_time < d.open_time + (d.mins * interval '1 minute')
       ) m ON true
       LEFT JOIN candles h
         ON h.exchange = d.exchange AND h.market_type = d.market_type
        AND h.symbol = d.symbol AND h.interval = d.interval AND h.open_time = d.open_time`,
    [Math.max(1, limit)]
  )
  out.due = due.length
  const done: [string, string, string, string, Date][] = []
  const wait: [string, string, string, string, Date][] = []
  for (const r of due) {
    const key: [string, string, string, string, Date] = [
      r.exchange,
      r.market_type,
      r.symbol,
      r.interval,
      new Date(r.open_time)
    ]
    /* 高周期那一行没了（被清掉/换过档）：没什么可核对的 */
    if (r.h_close === null || r.h_volume === null) {
      done.push(key)
      out.ok++
      continue
    }
    const bucketEnd = new Date(r.open_time).getTime() + r.mins * 60_000
    const lastExpected = bucketEnd - 60_000
    const complete = Number(r.m_n) === r.mins && r.m_t !== null && new Date(r.m_t).getTime() === lastExpected
    if (!complete) {
      /* 1m 还没补齐：现在判就是把自己缺的数据算成这行的错，留着下轮 */
      wait.push(key)
      out.waiting++
      continue
    }
    const mClose = Number(r.m_c)
    const mVolume = Number(r.m_v)
    const closeOff = r.h_close !== mClose
    const volOff = Math.abs(r.h_volume - mVolume) > Math.max(1e-9, Math.abs(mVolume) * 1e-9)
    if (closeOff || volOff) {
      out.stale.push({
        symbol: r.symbol,
        interval: r.interval,
        openTime: new Date(r.open_time).getTime(),
        why: r.why,
        ours: {close: r.h_close, volume: r.h_volume},
        from1m: {close: mClose, volume: mVolume}
      })
      wait.push(key) // 留着账：等修复完再复核一次
    } else {
      done.push(key)
      out.ok++
    }
  }
  const where = `WHERE (exchange, market_type, symbol, interval, open_time) IN (${inTuples(done, 5)})`
  if (done.length) await query(`DELETE FROM kline_pending_check ${where}`, flatIn(done))
  if (wait.length) {
    await query(
      `UPDATE kline_pending_check SET tries = tries + 1, checked_at = now()
        WHERE (exchange, market_type, symbol, interval, open_time) IN (${inTuples(wait, 5)})`,
      flatIn(wait)
    )
  }
  /* 超过保留期仍判不了的（1m 早被清了）⇒ 销账 + 告警一次，别让它永远挂在账上 */
  const stale = await query<{n: string}>(
    `WITH gone AS (
       DELETE FROM kline_pending_check
        WHERE written_at < now() - interval '7 days'
        RETURNING 1
     ) SELECT count(*)::text AS n FROM gone`
  )
  out.expired = Number(stale[0]?.n ?? 0)
  return out
}

/** IN 列表的占位符（每行 n 个） */
function inTuples(keys: [string, string, string, string, Date][], n: number): string {
  return keys
    .map((_, i) => {
      const b = i * n
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::timestamptz)`
    })
    .join(',')
}

function flatIn(keys: [string, string, string, string, Date][]): unknown[] {
  return keys.flatMap(k => [...k])
}

/** 账上有多少条、最老那条多久了（`/api/kline/recorder` 看它） */
export async function pendingCheckStats(): Promise<{rows: number; oldestMs: number | null}> {
  const row = await queryOne<{n: string; oldest: Date | null}>(
    `SELECT count(*)::text AS n, min(written_at) AS oldest FROM kline_pending_check`
  )
  return {
    rows: Number(row?.n ?? 0),
    oldestMs: row?.oldest ? new Date(row.oldest).getTime() : null
  }
}

/**
 * 诊断用：库里有多少行、多大、每档覆盖到哪儿。
 *
 * ⚠️ 默认**不精确数行**：`count(*)` 要扫全表，10.45M 行 / 3.8GB 时一次几秒到几十秒，
 *    还把磁盘占住（2026-10-07 线上就是被这类扫描拖死的）。默认走
 *    `pg_class.reltuples`（autovacuum 维护的估计值，这表开了激进的 autovacuum ⇒ 够准）
 *    + 每档两个**索引端点探测**（`from` / `to`，与表大小无关）。
 *    真要精确值就传 `exact: true`（会跑那条全表 count，慎用）。
 */
export async function candleStoreStats(
  opts: {exact?: boolean} = {}
): Promise<CandleStoreStats> {
  /*
   * ⚠️ 分区表的父表自身 size = 0 ⇒ 必须把**叶子**加起来。
   * ⚠️ 但 `pg_partition_tree()` 对**普通表返回 0 行**（实测；不是"返回它自己一行"），
   *    而 `sum()` 在没有行时是 NULL ⇒ 用 `coalesce` 兜回 `pg_total_relation_size`：
   *    分区表走前者、迁移前的普通表走后者，两种形态都报得对。
   */
  const size = await queryOne<{s: string | null}>(
    `SELECT coalesce(
              (SELECT sum(pg_total_relation_size(relid)) FROM pg_partition_tree('candles') WHERE isleaf),
              pg_total_relation_size('candles')
            )::text AS s`
  )
  const byInterval: CandleStoreStats['byInterval'] = {}
  for (const it of ALL_INTERVALS) byInterval[it] = {rows: null, from: null, to: null}

  let rows = 0
  if (opts.exact) {
    const exact = await query<{interval: string; n: string; a: Date | null; b: Date | null}>(
      `SELECT interval, count(*)::text AS n, min(open_time) AS a, max(open_time) AS b
         FROM candles GROUP BY interval ORDER BY interval`
    )
    for (const r of exact) {
      rows += Number(r.n)
      byInterval[r.interval] = {
        rows: Number(r.n),
        from: r.a ? new Date(r.a).toISOString() : null,
        to: r.b ? new Date(r.b).toISOString() : null
      }
    }
  } else {
    const est = await queryOne<{n: string}>(
      `SELECT greatest(reltuples, 0)::bigint::text AS n FROM pg_class WHERE relname = $1`,
      ['candles']
    )
    rows = Number(est?.n ?? 0)
    /* 每档的覆盖区间：带 scope 的索引端点探测 ⇒ 每条只读 1 个索引项 */
    for (const s of await knownCandleScopes()) {
      for (const it of ALL_INTERVALS) {
        const r = await queryOne<{a: Date | null; b: Date | null}>(
          `SELECT (SELECT open_time FROM candles
                    WHERE exchange = $1 AND market_type = $2 AND interval = $3
                    ORDER BY open_time ASC LIMIT 1) AS a,
                  (SELECT open_time FROM candles
                    WHERE exchange = $1 AND market_type = $2 AND interval = $3
                    ORDER BY open_time DESC LIMIT 1) AS b`,
          [s.exchange, s.marketType, it]
        )
        const cur = byInterval[it] ?? {rows: null, from: null, to: null}
        const from = r?.a ? new Date(r.a).toISOString() : null
        const to = r?.b ? new Date(r.b).toISOString() : null
        byInterval[it] = {
          rows: null,
          from: !from ? cur.from : !cur.from || from < cur.from ? from : cur.from,
          to: !to ? cur.to : !cur.to || to > cur.to ? to : cur.to
        }
      }
    }
  }
  return {rows, exact: !!opts.exact, sizeBytes: Number(size?.s ?? 0), byInterval}
}

/* ---------------- 缺口巡检（第 2 档：定时，0 权重） ----------------
 *
 * 「存在性检查」：某个币某一档在窗口内**该有多少根、实际有多少根**。
 * 一条 SQL 扫完一档（走 candles_ivl_time_idx，`open_time` 是第 4 列 ⇒ 范围扫得动），
 * 完全在库里算，**0 权重**，所以可以每几分钟跑一次。
 *
 * ⚠️ 只覆盖「库里在该窗口有行的币」—— 一根都没有的币不会出现在结果里，
 *    调用方要拿 `states`（底座订阅清单）来补这一层判断（recorder 的 `gapCheck` 就是这么做的）。
 */

export interface BucketCoverage {
  n: number
  lo: number
  hi: number
}

export async function bucketCoverage(
  interval: KlineInterval,
  sinceMs: number,
  scope: {exchange: string; marketType: string}
): Promise<Map<string, BucketCoverage>> {
  const rows = await query<{symbol: string; n: string; lo: Date; hi: Date}>(
    `SELECT symbol, count(*)::text AS n, min(open_time) AS lo, max(open_time) AS hi
       FROM candles
      WHERE exchange = $1 AND market_type = $2 AND interval = $3 AND open_time >= $4
      GROUP BY symbol`,
    [scope.exchange, scope.marketType, interval, new Date(sinceMs)]
  )
  const out = new Map<string, BucketCoverage>()
  for (const r of rows) {
    out.set(r.symbol, {
      n: Number(r.n),
      lo: new Date(r.lo).getTime(),
      hi: new Date(r.hi).getTime()
    })
  }
  return out
}

/* ---------------- 连续性审计（第 2 档的兜底：整条序列自洽，2026-10-08） ----------------
 *
 * ## 为什么必须另起一个检查（`runGapCheck` 天然看不见的那一类洞）
 *
 * `runGapCheck` 的 `expected` 是**从「这个币在窗口里最早那根」开始数**的
 * （`lo = max(floor(since/ms)*ms, floor(c.lo/ms)*ms)`）—— 这么做是为了不冤枉新上市的币，
 * 但副作用是：**洞只要顶到窗口左沿就完全隐形**。而 `queueRepair` 的起点用的就是同一个
 * 锚点 ⇒ 连修也不会去修它。于是「掉线 / 重启」造出来的洞，只要巡检下一次跑到时已经
 * 晚了（1m 的窗口只有 120 根 = 2 小时），就**永远不会被发现、也永远不会被补**。
 *
 * 2026-10-08 实测（本地，事故后）：1m 缺 **620,603 分钟（11.4%）**，
 * 而巡检报出来的 1m 缺口全是「差 1 根」的边界噪音。逐日拆开：
 *   10-07（磁盘风暴）520,006 分钟 / 5,427 个洞；10-08（掉线 3.6 小时）100,579 分钟 / 855 个洞。
 *
 * ## 为什么它能便宜到可以定时跑
 *
 * 判据是「**行数 vs 跨度**」：`count(*)` vs `(max-min)/step + 1`。
 * `min` / `max` / `count` 三列**都在主键索引里**（`(exchange, market_type, symbol,
 * interval, open_time)`）⇒ **纯索引扫描、零堆访问**。实测全 6 档 **5.6 秒**（1m 单独 0.9 秒）。
 *
 * ⚠️ 别顺手把 `sum(volume)` / `array_agg(close)` 加进来 —— 那两列不在索引里，每行都要回堆取页，
 *    老的「库内自洽」全市场扫描就是这么变成 **4 分 40 秒** 的（见 docs/EXCHANGE.md 第 52/53 节）。
 *
 * ## 返回什么
 *
 * 每个「有洞的（币 × 档）」一行，带**最老那个洞**的起止时刻 ——
 * 也就是说调用方拿到的是「**从哪一刻起往后补**」的锚点（`repairSymbol` 只会往后补，
 * 所以必须给它最老的那个洞，一次覆盖后面所有洞）。
 */

export interface ContiguityGap {
  interval: KlineInterval
  symbol: string
  /** 整条序列缺几根 */
  missing: number
  /** 整条序列的跨度（根）—— `missing / expected` 就是缺的比例 */
  expected: number
  /** 最老的洞：**第一根缺的**桶的 open_time（毫秒）——补的起点 */
  holeFrom: number
  /** 最老的洞：洞后第一根**在库里的**桶（毫秒，仅用于日志展示与跨度计算） */
  holeTo: number
}

/**
 * 逐（币 × 档）审「整条序列连不连续」，返回**有洞的**那些，按「洞越老越靠前」排序。
 *
 * 一条 SQL 搞定：`lag()` 窗口函数同时给出「行数」和「最老的洞」。
 * 走主键索引 ⇒ 增量排序，不需要额外排序 1000 万行。
 */
export async function auditContiguity(
  scope: {exchange: string; marketType: string},
  intervals: KlineInterval[] = ALL_INTERVALS,
  /** 只看这几个币（ccxt 统一符号）。给了就**按币走索引**，比全市场快得多 */
  symbols: string[] = []
): Promise<ContiguityGap[]> {
  const out: ContiguityGap[] = []
  for (const interval of intervals) {
    const ms = MS[interval]
    const rows = await query<{
      symbol: string
      n: string
      lo: Date
      hi: Date
      hole_from: Date | null
      hole_to: Date | null
    }>(
      `WITH s AS (
         SELECT symbol, open_time,
                lag(open_time) OVER (PARTITION BY symbol ORDER BY open_time) AS p
           FROM candles
          WHERE exchange = $1 AND market_type = $2 AND interval = $3
            AND ($5::text[] IS NULL OR symbol = ANY($5::text[]))
       ), g AS (
         SELECT symbol, count(*) AS n, min(open_time) AS lo, max(open_time) AS hi,
                min(p) FILTER (WHERE open_time - p > $4::interval) AS hole_from,
                min(open_time) FILTER (WHERE open_time - p > $4::interval) AS hole_to
           FROM s GROUP BY symbol
       )
       SELECT symbol, n::text, lo, hi, hole_from, hole_to
         FROM g WHERE hole_from IS NOT NULL`,
      [
        scope.exchange,
        scope.marketType,
        interval,
        `${ms} milliseconds`,
        symbols.length ? symbols : null
      ]
    )
    for (const r of rows) {
      const lo = new Date(r.lo).getTime()
      const hi = new Date(r.hi).getTime()
      out.push({
        interval,
        symbol: r.symbol,
        expected: Math.round((hi - lo) / ms) + 1,
        missing: Math.round((hi - lo) / ms) + 1 - Number(r.n),
        holeFrom: new Date(r.hole_from!).getTime() + ms,
        holeTo: new Date(r.hole_to!).getTime()
      })
    }
  }
  /* 洞越老越先修：掉线后的老洞最可能被永久丢掉（1m 只有 7 天保留期） */
  out.sort((a, b) => a.holeFrom - b.holeFrom || a.interval.localeCompare(b.interval))
  return out
}

/* ---------------- 库内自洽：高周期桶 vs 1m 重算（第 2 档的加强） ----------------
 *
 * 为什么要有它（2026-10-07 抽样对账第一轮就抓到的真事）：一条**残桶**（写的时候那个桶还没
 * 收盘）在"只查有没有"的检查里是**看不出来的** —— 它在那儿、根数也对，就是值不对。
 * 而且它**永远不会自愈**：`seedHistory` 嫌它太新而跳过、`repairSweep` 只看 1m（1m 是新的）。
 *
 * 判据（只比「1m 数据一根不缺」的桶，避免把自己的洞算成别人的错）：
 *   · 该桶最后一根 1m 的 close ≠ 高周期行的 close；或
 *   · 该桶 1m 的 volume 求和 ≠ 高周期行的 volume
 * ⇒ 这行是残桶 / 陈旧值，交给 `repairSymbol` 用交易所口径盖回去。
 *
 * 成本：走 candles_ivl_symbol_time_idx 的范围扫（每桶读 bucket/1m 行），0 权重。
 */

export interface StaleBucket {
  symbol: string
  interval: string
  openTime: number
  ours: {close: number; volume: number}
  from1m: {close: number; volume: number}
}

export async function findStaleBuckets(
  interval: HighInterval,
  sinceMs: number,
  scope: {exchange: string; marketType: string},
  symbols: string[],
  limit = 50
): Promise<StaleBucket[]> {
  if (!symbols.length) return []
  const minutes = MS[interval] / 60_000
  const rows = await query<{
    symbol: string
    open_time: Date
    h_close: number
    h_volume: number
    m_close: number
    m_volume: number
  }>(
    `SELECT h.symbol, h.open_time, h.close AS h_close, h.volume AS h_volume,
            m.c AS m_close, m.v AS m_volume
       FROM candles h
       JOIN LATERAL (
         SELECT count(*) AS n,
                sum(volume) AS v,
                (array_agg(close ORDER BY open_time DESC))[1] AS c,
                max(open_time) AS t
           FROM candles
          WHERE exchange = h.exchange AND market_type = h.market_type
            AND interval = '1m' AND symbol = h.symbol
            AND open_time >= h.open_time
            AND open_time < h.open_time + ($4 * interval '1 minute')
       ) m ON true
      WHERE h.interval = $1 AND h.exchange = $2 AND h.market_type = $3
        AND h.open_time >= $5
        -- ⚠️ 必须按币过滤：不过滤就要为**全市场**每个高周期行都做一次 1m 范围扫
        --    （实测 1575 行 × 240 根 = 1.0 秒），过滤后只剩订阅清单那几个（几十毫秒）。
        AND h.symbol = ANY($6::text[])
        -- 这个桶的 1m 一根不缺（最后一根正好落在桶末），否则那是"我们自己的洞"，不算这行的错
        AND m.n = $4
        AND m.t = h.open_time + ($4 * interval '1 minute') - interval '1 minute'
        AND (h.close <> m.c OR abs(h.volume - m.v) > greatest(1e-9, abs(m.v) * 1e-9))
      ORDER BY h.open_time DESC
      LIMIT $7`,
    [interval, scope.exchange, scope.marketType, minutes, new Date(sinceMs), symbols, limit]
  )
  return rows.map(r => ({
    symbol: r.symbol,
    interval,
    openTime: new Date(r.open_time).getTime(),
    ours: {close: Number(r.h_close), volume: Number(r.h_volume)},
    from1m: {close: Number(r.m_close), volume: Number(r.m_volume)}
  }))
}

/* ---------------- 抽样对账落表（第 3 档：每日） ---------------- */

export interface KlineReconRow {
  symbol: string
  interval: string
  fromTime: number
  toTime: number
  compared: number
  mismatched: number
  missing: number
  firstBadAt: number | null
  /** 前几处差异的明细（别存全量：一轮能差上千根） */
  detail: unknown[]
  /** daily（定时）/ manual（手动触发） */
  source: string
  ok: boolean
}

export async function saveKlineRecon(rows: KlineReconRow[]): Promise<number> {
  if (!rows.length) return 0
  const values: unknown[] = []
  const tuples = rows.map((r, n) => {
    const b = n * 11
    values.push(
      r.symbol,
      r.interval,
      new Date(r.fromTime).toISOString(),
      new Date(r.toTime).toISOString(),
      r.compared,
      r.mismatched,
      r.missing,
      r.firstBadAt === null ? null : new Date(r.firstBadAt).toISOString(),
      JSON.stringify(r.detail),
      r.source,
      r.ok
    )
    return `($${b + 1}, $${b + 2}, $${b + 3}::timestamptz, $${b + 4}::timestamptz, $${b + 5}::int,
             $${b + 6}::int, $${b + 7}::int, $${b + 8}::timestamptz, $${b + 9}::jsonb, $${b + 10}, $${b + 11})`
  })
  const res = await getPool().query(
    `INSERT INTO kline_recon
       (symbol, interval, from_time, to_time, compared, mismatched, missing,
        first_bad_at, detail, source, ok)
     VALUES ${tuples.join(',')}`,
    values
  )
  return res.rowCount ?? 0
}

export interface KlineReconRecord extends Omit<KlineReconRow, 'fromTime' | 'toTime' | 'firstBadAt'> {
  id: number
  checkedAt: string
  fromTime: string
  toTime: string
  firstBadAt: string | null
}

/** 最近几轮对账结果（自检接口读它；默认只回最近 20 条） */
export async function recentKlineRecon(limit = 20): Promise<KlineReconRecord[]> {
  const rows = await query<{
    id: string
    checked_at: Date
    symbol: string
    interval: string
    from_time: Date
    to_time: Date
    compared: number
    mismatched: number
    missing: number
    first_bad_at: Date | null
    detail: unknown[]
    source: string
    ok: boolean
  }>(
    `SELECT id, checked_at, symbol, interval, from_time, to_time, compared, mismatched,
            missing, first_bad_at, detail, source, ok
       FROM kline_recon
      ORDER BY checked_at DESC, id DESC
      LIMIT $1`,
    [Math.max(1, Math.round(limit))]
  )
  return rows.map(r => ({
    id: Number(r.id),
    checkedAt: new Date(r.checked_at).toISOString(),
    symbol: r.symbol,
    interval: r.interval,
    fromTime: new Date(r.from_time).toISOString(),
    toTime: new Date(r.to_time).toISOString(),
    compared: Number(r.compared),
    mismatched: Number(r.mismatched),
    missing: Number(r.missing),
    firstBadAt: r.first_bad_at ? new Date(r.first_bad_at).toISOString() : null,
    detail: r.detail,
    source: r.source,
    ok: r.ok
  }))
}
