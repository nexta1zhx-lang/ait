/**
 * K 线底座的库这一层（表结构见 `schema.ts` 的 `candles`）。
 *
 * 只做四件事：**批量写入 / 查最后一个点 / 由 1m 重算高周期 / 分级清理**。
 * 写入用 UPSERT：实时流、补缺口、重算可能覆盖同一个桶，谁最后写谁赢（都以交易所为准）。
 *
 * ⚠️ 保留策略**按周期分级**（`pruneCandles`），别改成"统一 7 天"：
 *    1h 图要看一年、4h/1d 要看更久，砍掉就没得画了。
 *
 * ⚠️ 库里只保证**已收盘**的桶（当前那根只有 1m 有，高周期的当前根由 1m 现算）。
 *    所以 P1 的读路径 = 库里那份（完整桶）+ 由 1m 补出来的当前根，别直接拿库里的当"最后一根"。
 */
import {getPool, query, queryOne} from './client'
import type {Timeframe} from '../types'

/** 底座记 1m，高周期由它滚出来 */
export type KlineInterval = '1m' | Timeframe

/** 这些周期都是 1m 的整数倍 ⇒ 从 1m 滚出来的桶边界与交易所完全对齐（UTC 零点起算） */
export const HIGH_INTERVALS: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']

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
