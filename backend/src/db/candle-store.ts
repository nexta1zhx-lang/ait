/**
 * K 线底座的库这一层（表结构见 `schema.ts` 的 `candles`）。
 *
 * 只做五件事：**批量写入 / 读最近 N 根 / 查最后一个点 / 由 1m 重算高周期 / 分级清理**。
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
import type {Candle, Timeframe} from '../types'

/** 底座记 1m，高周期由它滚出来 */
export type KlineInterval = '1m' | Timeframe

/** 底座自己滚出来的那几档（不含 1m：它就是底座本身） */
export type HighInterval = Exclude<Timeframe, '1m'>

/** 这些周期都是 1m 的整数倍 ⇒ 从 1m 滚出来的桶边界与交易所完全对齐（UTC 零点起算） */
export const HIGH_INTERVALS: HighInterval[] = ['5m', '15m', '1h', '4h', '1d']

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

/** 批量 UPSERT，返回真正写进去的行数（被同桶覆盖也算） */
export async function saveCandles(rows: NewCandleRow[]): Promise<number> {
  if (!rows.length) return 0
  let written = 0
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS)
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

/** 这些币在某个周期上各自最后一个点（毫秒）；没记录过的币不出现在结果里 */
export async function maxOpenTimes(
  interval: KlineInterval,
  symbols: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!symbols.length) return out
  const rows = await query<{symbol: string; t: Date | null}>(
    `SELECT symbol, max(open_time) AS t
       FROM candles
      WHERE interval = $1 AND symbol = ANY($2::text[])
      GROUP BY symbol`,
    [interval, symbols]
  )
  for (const r of rows) {
    if (r.t) out.set(r.symbol, new Date(r.t).getTime())
  }
  return out
}

export async function lastOpenTime(
  interval: KlineInterval,
  symbol: string
): Promise<number | null> {
  const row = await queryOne<{t: Date | null}>(
    `SELECT max(open_time) AS t FROM candles WHERE interval = $1 AND symbol = $2`,
    [interval, symbol]
  )
  return row?.t ? new Date(row.t).getTime() : null
}

/** 某个周期上已经记了多少个点（在哪个区间） */
export async function candleCount(
  interval: KlineInterval,
  symbol: string
): Promise<number> {
  const row = await queryOne<{n: string}>(
    `SELECT count(*)::text AS n FROM candles WHERE interval = $1 AND symbol = $2`,
    [interval, symbol]
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
  bucketMs: number
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
      WHERE interval = '1m' AND symbol = ANY($3::text[])
        AND open_time >= to_timestamp($4 / 1000.0)
        AND open_time <  to_timestamp($5 / 1000.0)
      GROUP BY exchange, market_type, symbol, pair,
               floor(extract(epoch FROM open_time) * 1000 / $2)
     ${UPSERT}`,
    [interval, bucketMs, symbols, fromMs, toMs]
  )
  return res.rowCount ?? 0
}

/**
 * 分级清理。返回删掉的行数。
 *
 * 为什么这么分：1m/5m 只在「最近的图」上有用；15m 要能画 30 天；1h 要能画一年；
 * 4h/1d 一辈子最值钱（一年才 19 万行）。
 */
export async function pruneCandles(): Promise<number> {
  const res = await getPool().query(
    `DELETE FROM candles
      WHERE (interval = '1m'  AND open_time < now() - interval '7 days')
         OR (interval = '5m'  AND open_time < now() - interval '7 days')
         OR (interval = '15m' AND open_time < now() - interval '30 days')
         OR (interval = '1h'  AND open_time < now() - interval '400 days')`
  )
  return res.rowCount ?? 0
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
  rows: number
  sizeBytes: number
  byInterval: Record<string, {rows: number; from: string | null; to: string | null}>
}

/** 诊断用：库里有多少行、多大、每档覆盖到哪儿 */
export async function candleStoreStats(): Promise<CandleStoreStats> {
  const rows = await query<{interval: string; n: string; a: Date | null; b: Date | null}>(
    `SELECT interval, count(*)::text AS n, min(open_time) AS a, max(open_time) AS b
       FROM candles GROUP BY interval ORDER BY interval`
  )
  const size = await queryOne<{s: string | null}>(
    `SELECT pg_total_relation_size('candles')::text AS s`
  )
  const byInterval: CandleStoreStats['byInterval'] = {}
  let total = 0
  for (const r of rows) {
    total += Number(r.n)
    byInterval[r.interval] = {
      rows: Number(r.n),
      from: r.a ? new Date(r.a).toISOString() : null,
      to: r.b ? new Date(r.b).toISOString() : null
    }
  }
  return {rows: total, sizeBytes: Number(size?.s ?? 0), byInterval}
}
