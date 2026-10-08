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
  /** ws（实时流）/ rollup（由 1m 滚出）/ backfill（补缺口）/ seed（首灌历史） */
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
                updated_at       = now()`

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

/** 批量 UPSERT，返回真正写进去的行数（被同桶覆盖也算） */
export async function saveCandles(rows: NewCandleRow[]): Promise<number> {
  if (!rows.length) return 0
  const clean = sanitizeRows(rows)
  if (clean.length < rows.length) {
    console.warn(
      `[kline] 写入前校验丢弃 ${rows.length - clean.length}/${rows.length} 行：${describeRejects()}`
    )
  }
  if (!clean.length) return 0
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
    await query(`INSERT INTO candles (${COLS}) VALUES ${tuples.join(',')} ${UPSERT}`, values)
    written += chunk.length
  }
  return written
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
  scope: {exchange: string; marketType: string}
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
     ${UPSERT}`,
    [interval, bucketMs, symbols, fromMs, toMs, scope.exchange, scope.marketType]
  )
  return res.rowCount ?? 0
}

/** 分级保留：超期就删（周期 → 保留多久） */
const KEEP: [KlineInterval, string][] = [
  ['1m', '7 days'],
  ['5m', '7 days'],
  ['15m', '30 days'],
  ['1h', '400 days']
]

/**
 * 分级清理。返回删掉的行数。
 *
 * 为什么这么分：1m/5m 只在「最近的图」上有用；15m 要能画 30 天；1h 要能画一年；
 * 4h/1d 一辈子最值钱（一年才 19 万行）。
 *
 * ⚠️ 必须**按 scope 拆开、一档一条 DELETE**。原来那条
 *    `(interval = '1m' AND open_time < …) OR …` 四条分支都缺索引前缀
 *    （`candles` 的索引全部以 `exchange, market_type` 打头）⇒
 *    每次清理都顺序扫 3.8GB，连 autovacuum 一起把磁盘占死（2026-10-07 线上实测）。
 *    拆开后每条都是「前 3 列等值 + `open_time` 范围」⇒ 走 `candles_ivl_time_idx` 的范围扫。
 */
export async function pruneCandles(): Promise<number> {
  let n = 0
  for (const s of await knownCandleScopes()) {
    for (const [interval, keep] of KEEP) {
      const res = await getPool().query(
        `DELETE FROM candles
          WHERE exchange = $1 AND market_type = $2 AND interval = $3
            AND open_time < now() - $4::interval`,
        [s.exchange, s.marketType, interval, keep]
      )
      n += res.rowCount ?? 0
    }
  }
  return n
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
const ALL_INTERVALS: KlineInterval[] = ['1m', ...HIGH_INTERVALS]

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
  const size = await queryOne<{s: string | null}>(
    `SELECT pg_total_relation_size($1)::text AS s`,
    ['candles']
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
