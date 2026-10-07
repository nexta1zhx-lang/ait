import ccxt from 'ccxt'
import {ccxtBaseOptions} from './exchange-account'
import {
  attachMarkets,
  marketsKeyOf,
  retryUnknownSymbol
} from './ccxt-markets'
import {coolingLeftMs, coolingMessage, noteRateLimit} from '../util/rate-cool'
import {DEFAULT_CALIBERS, TF_MS, barsFor, planFor} from '../calibers'
import {dailyCloses} from '../db/candle-store'
import {describeSeries} from '../analysis/describe'
import {ema42Of} from '../analysis/ema'
import {
  Calibers,
  Candle,
  MarketHeat,
  MarketSnapshot,
  MarketType,
  SeriesBlock,
  Timeframe
} from '../types'

const CCXT: any = ccxt

export {TF_MS}

/** 一天 —— 算 24h 高低 / 涨跌 / 振幅用 */
const DAY_MS = 24 * 60 * 60_000

function toCandles(rows: unknown[]): Candle[] {
  return (rows as unknown[][]).map(r => ({
    timestamp: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5])
  }))
}

function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 跑一个可能失败 / 可能为空的异步调用，出错就给 null（热度项全都容错） */
async function safeCall<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    const v = await fn()
    return (v ?? null) as T | null
  } catch {
    return null
  }
}

/**
 * K 线取数重试。
 *
 * ⚠️ 这条路上**不能容错返回空** —— 少一个周期，AI 就看不到那一层，
 * 却不会报错，等于静默给了残缺数据。但也不能一次失败就整个分析作废：
 * `fapi.binance.com` 会间歇性
 * `Client network socket disconnected before secure TLS connection was established`
 * （实测同一条请求串行打 8 次全成功，但偶尔就是会碰上一次）。
 *
 * 所以这里退避重试几次，还是不行才把错抛上去。
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  times = 3
): Promise<T> {
  let last: unknown
  for (let i = 1; i <= times; i++) {
    /*
     * ⚠️ 限流冷却期里**一次都不打**（见 `util/rate-cool`）：`-1003` 是「这个 IP 打满了」，
     *    不是瞬时抖动，重试只会把封禁窗口往后推。直接抛，让调用方降级去。
     */
    const cool = coolingLeftMs()
    if (cool > 0) throw new Error(`[market] ${label} 跳过：${coolingMessage()}`)
    try {
      return await fn()
    } catch (e) {
      last = e
      /* 限流错**不重试**（原来会白打 2 次），记一次冷却就抛 */
      if (noteRateLimit(e)) throw e
      if (i < times) {
        /*
         * 200ms / 400ms —— 够短，几乎不影响体感；够长，躲过瞬时抖动。
         *
         * ⚠️ 原来是 `300 * i * i`（300ms / 1200ms），太保守了：这是**瞬时的
         *    TLS 连接失败**（请求根本没到币安），不是被限流。实测一次取数
         *    （非 1h 周期要打两趟）里抖两次，退避就吃掉 1.5s，
         *    整条请求变成 2.4s 的尖峰（2026-10-04 实测定位）。
         *    现在最坏 ≈ 0.4+0.2+0.4+0.4+0.5 ≈ 1.9s，而且这种情况本来就少见。
         */
        await new Promise(r => setTimeout(r, 200 * i))
      }
    }
  }
  console.warn(
    `[market] ${label} 连续 ${times} 次失败：${(last as Error)?.message ?? last}`
  )
  throw last
}

export interface RecentSR {
  hours: number
  /** 压力（区间最高价） */
  resistance: number
  /** 支撑（区间最低价） */
  support: number
  candles: number
}

/**
 * 计算「最后 `hours` 根」的高低点当压力 / 支撑。
 *
 * ⚠️ 2026-10-04 起**图上的那两条线不用它了** —— 前端改成按「当前可见窗口 +
 *    摆动高低点」现算（`frontend/src/levels.ts`）。这里只留给老版本 App 兜底，
 *    所以调用方传的就是**手上已经有的那串 K 线**（以前非 1h 周期会专门去取
 *    8 根 1h，现在不再为它多打一趟交易所）。
 * 数据不足或区间无效时返回 null（调用方据此选择“不画”）。
 */
export function computeRecentSR(candles: Candle[], hours = 4): RecentSR | null {
  if (!Array.isArray(candles) || candles.length < 2) return null
  const win = candles.slice(-hours)
  if (win.length < 2) return null
  let hi = -Infinity
  let lo = Infinity
  for (const c of win) {
    if (c.high > hi) hi = c.high
    if (c.low < lo) lo = c.low
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null
  return {hours, resistance: hi, support: lo, candles: win.length}
}

/** 某个时间点「当时」的大周期压力 / 支撑 */
export interface SRAtTime {
  timeframe: Timeframe
  bars: number
  resistance: number
  support: number
  /** 这个箱体相对中间价的宽度% */
  widthPct: number
}

/**
 * 算「某个时间点当时」的压力 / 支撑。
 *
 * 关键：只取那一刻**之前**的 N 根 K 线，绝不用之后的数据 ——
 * 复盘案例时 AI 该看到的是「当时能看到什么」，不能被未来行情污染。
 * 拉不到就返回 null，不耽误主流程。
 */
export async function fetchSRAt(opts: {
  exchangeId: string
  symbol: string
  timeframe: Timeframe
  /** 以这个时间点为「现在」（毫秒） */
  at: number
  /** 往前看多少根 */
  bars: number
  marketType?: MarketType
  apiBase?: string
}): Promise<SRAtTime | null> {
  const step = TF_MS[opts.timeframe]
  const candles = await fetchCandlesRange({
    exchangeId: opts.exchangeId,
    symbol: opts.symbol,
    timeframe: opts.timeframe,
    from: opts.at - (opts.bars + 1) * step,
    to: opts.at,
    marketType: opts.marketType,
    apiBase: opts.apiBase,
    maxCandles: opts.bars + 5
  })
  const win = candles.slice(-opts.bars)
  // 至少得凑够一半，否则那段历史根本不够看
  if (win.length < Math.max(2, Math.floor(opts.bars / 2))) return null

  let hi = -Infinity
  let lo = Infinity
  for (const c of win) {
    if (c.high > hi) hi = c.high
    if (c.low < lo) lo = c.low
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null

  const mid = (hi + lo) / 2
  return {
    timeframe: opts.timeframe,
    bars: win.length,
    resistance: hi,
    support: lo,
    widthPct: mid > 0 ? ((hi - lo) / mid) * 100 : 0
  }
}

export interface FetchOptions {
  exchangeId: string
  symbol: string
  /** 主周期 —— 你在图上看的那个 */
  timeframe: Timeframe
  /**
   * 主周期往前看多少天（= 图上那段有多长）。
   * 其余周期拉多少天由 `calibers.others` 决定。
   */
  days: number
  marketType?: MarketType
  /** 覆盖交易所公共 API 域名，用于默认域名不可达的场景 */
  apiBase?: string
  /**
   * 「以哪一刻为现在」（毫秒）。不填 = 真·现在。
   *
   * 填了就是**测试 / 复盘**：全部数据只能来自这一刻之前已收盘的 K 线，
   * 实时类接口（资金费率 / 持仓量 / 多空比 / 24h 成交额）一律不取 ——
   * 那些接口查到的永远是「现在」，拿来当过去用就是偷看未来。
   */
  at?: number
  /** 取数参数（各周期拉多少根）；不传就用默认值 */
  calibers?: Calibers
}

/**
 * 按「某时刻」取 K 线：只要**已经收盘**的那些，绝不含那一刻正在走的那根。
 *
 * 这是整个测试功能的底线 —— 那根还没走完的 K 线里包含着「未来」。
 */
async function fetchCandlesAsOf(
  exchange: any,
  symbol: string,
  tf: Timeframe,
  at: number,
  bars: number
): Promise<Candle[]> {
  const step = TF_MS[tf]
  // 多要几根，因为开头可能落在一根 K 线中间、末尾那根也要丢掉
  const rows = await withRetry<unknown[]>(`回放 ${tf}`, () =>
    exchange.fetchOHLCV(symbol, tf, at - (bars + 2) * step, bars + 3)
  )
  return toCandles(rows ?? [])
    .filter(c => Number.isFinite(c.timestamp) && c.timestamp + step <= at)
    .slice(-bars)
}

/** 把 MarketType 映射为 ccxt 的 defaultType / fetchMarkets 选项 */
function marketOptions(mt: MarketType): Record<string, unknown> {
  switch (mt) {
    case 'swap':
      return {defaultType: 'future', fetchMarkets: ['linear']}
    case 'coinm':
      return {defaultType: 'delivery', fetchMarkets: ['inverse']}
    case 'spot':
    default:
      return {defaultType: 'spot', fetchMarkets: ['spot']}
  }
}

/**
 * 将交易所的公共 API 域名替换为指定 base。
 * 例如 Binance 默认 https://api.binance.com 不可达时，可换成 https://data-api.binance.vision。
 */
function applyApiBase(exchange: any, base: string): void {
  const urls = exchange.urls
  if (!urls) return
  const to = base.replace(/\/+$/, '')
  let fromOrigin: string | undefined
  const publicUrl: unknown = urls.api && urls.api.public
  if (typeof publicUrl === 'string') {
    try {
      fromOrigin = new URL(publicUrl).origin
    } catch {
      fromOrigin = undefined
    }
  }
  if (!fromOrigin) {
    const m = JSON.stringify(urls).match(/https:\/\/[a-z0-9.-]+/i)
    fromOrigin = m ? m[0] : undefined
  }
  if (!fromOrigin) return
  exchange.urls = JSON.parse(JSON.stringify(urls).split(fromOrigin).join(to))
}

/**
 * 把用户输入的符号归一化为 CCXT 统一符号。
 *   swap  : BTC/USDT   -> BTC/USDT:USDT
 *   coinm : BTC/USD    -> BTC/USD:BTC
 */
export function normalizeSymbol(
  symbol: string,
  marketType: MarketType
): string {
  const s = symbol.trim().toUpperCase()
  if (s.includes(':')) return s
  const parts = s.includes('/')
    ? s.split('/')
    : [s, marketType === 'coinm' ? 'USD' : 'USDT']
  const base = parts[0]
  const quote = parts[1]
  if (marketType === 'coinm') return `${base}/${quote}:${base}`
  if (marketType === 'swap') return `${base}/${quote}:${quote}`
  return `${base}/${quote}`
}

/** 在已加载的市场中解析出可用符号，并在失败时给出近似提示 */
function resolveSymbol(
  exchange: any,
  raw: string,
  marketType: MarketType
): string {
  const upper = raw.trim().toUpperCase()
  const candidates = [upper, normalizeSymbol(upper, marketType)]
  for (const c of candidates) {
    if (exchange.markets && exchange.markets[c]) return c
  }
  // 模糊匹配：去掉分隔符后比较，兼容 BTCUSDT / BTC/USDT / btc-usdt
  const compact = upper.replace(/[:/\-_\s]/g, '')
  const keys: string[] = Object.keys(exchange.markets ?? {})
  const fuzzy = keys.find(k => k.replace(/[:/\-_\s]/g, '') === compact)
  if (fuzzy) return fuzzy

  const head = (upper.split('/')[0] ?? '').replace(/[:/\-_]/g, '')
  const similar = keys.filter(k => k.startsWith(head)).slice(0, 10)
  throw new Error(
    `找不到交易对 ${raw}（市场类型 ${marketType}）。` +
      (similar.length
        ? `相近的有：${similar.join(', ')}`
        : '请检查符号是否正确。')
  )
}

/** 已加载市场的交易所实例缓存，避免每次请求重复 loadMarkets */
const exchangeCache = new Map<
  string,
  any
>() /** 获取（并缓存）已加载市场的交易所实例 */
async function getExchange(
  exchangeId: string,
  marketType: MarketType,
  apiBase?: string
): Promise<any> {
  const key = `${exchangeId}|${marketType}|${apiBase ?? ''}`
  const cached = exchangeCache.get(key)
  if (cached) return cached

  const Ctor = CCXT[exchangeId]
  if (!Ctor)
    throw new Error(`未知交易所：${exchangeId}（请检查 --exchange 参数）`)

  const exchange = new Ctor({
    // 限流间隔 + 出口代理，见 `exchange-account.ts` 的 `ccxtBaseOptions()`
    ...ccxtBaseOptions(),
    options: marketOptions(marketType)
  })
  if (apiBase) applyApiBase(exchange, apiBase)
  /* markets 走落库那份（见 `data/ccxt-markets.ts`），冷启动不再下 1.1MB */
  const mk = marketsKeyOf(exchangeId, marketType, apiBase || 'live')
  attachMarkets(exchange, mk)
  retryUnknownSymbol(exchange, mk)
  await exchange.loadMarkets()
  exchangeCache.set(key, exchange)
  return exchange
}

/**
 * 预热：把「每个进程只付一次」的成本提前到启动时。
 *
 * ⚠️ 实测结论（2026-10-04，用户问「第一发 2.7s 为什么这么久」）：
 *    · `loadMarkets()` 约 **430ms**（上游 exchangeInfo 实测 485ms + ccxt 解析 528 个合约）
 *      —— 每个进程只付一次，但**每次部署/重启都由第一个用户付** → 这里打掉
 *    · 那一发 2.7s **不是它、也不是币安抖动重试**（实测那次失败数为 0），
 *      而是 **开发模式特有的**：同一个进程里挂着 Vite 开发中间件，
 *      第一个请求进来时它在做懒初始化，把事件循环占住 ~1.9s。
 *      对照实测（同一个新进程，同样只打一发 K 线）：
 *        `npm run web`（带 Vite）        第 1 发 **2015ms** · 第 2 发 157ms
 *        `FRONTEND=dist`（不带 Vite）    第 1 发  **179ms** · 第 2 发 165ms
 *      ⇒ **线上没有 Vite，压根没这个问题**；本地开发看到的第一发慢不用追。
 *        （要验证后端真实速度，用 `FRONTEND=dist NODE_ENV=production npm run web`）
 *
 * 失败都不算错：真正取数时会重来一遍，这里只留告警。
 */
export async function warmExchange(opts: {
  exchangeId: string
  marketType?: MarketType
  apiBase?: string
}): Promise<void> {
  const marketType = opts.marketType ?? 'swap'
  const exchange = await getExchange(opts.exchangeId, marketType, opts.apiBase)
  /*
   * 真拉一次 K 线（用 BTC —— 所有合约里必然存在的那个，别的币可能下架）。
   * 这一发不在意结果，只为把「取数」这条路也走热；成本就一次请求。
   */
  const symbol = resolveSymbol(exchange, 'BTC/USDT', marketType)
  await exchange.fetchOHLCV(symbol, '1h', undefined, 250)
}

export interface FetchCandlesOptions {
  exchangeId: string
  symbol: string
  timeframe: Timeframe
  limit: number
  marketType?: MarketType
  apiBase?: string
  /** 起始时间（毫秒）。给了就从这里开始取 */
  since?: number
}
/** 单独拉取某周期的 K 线（图表切换周期用，不跑指标与 LLM） */
export async function fetchCandles(
  opts: FetchCandlesOptions
): Promise<Candle[]> {
  const marketType = opts.marketType ?? 'swap'
  const exchange = await getExchange(opts.exchangeId, marketType, opts.apiBase)
  const symbol = resolveSymbol(exchange, opts.symbol, marketType)
  const rows = await withRetry<unknown[]>(`${opts.timeframe} 图表取数`, () =>
    exchange.fetchOHLCV(symbol, opts.timeframe, opts.since, opts.limit)
  )
  return toCandles(rows)
}

export interface FetchRangeOptions {
  exchangeId: string
  symbol: string
  timeframe: Timeframe
  /** 起始时间（毫秒） */
  from: number
  /** 结束时间（毫秒） */
  to: number
  marketType?: MarketType
  apiBase?: string
  /** 安全上限，防止区间过大把内存撑爆 */
  maxCandles?: number
}

/**
 * 拉取一段时间区间的 K 线（自动分页）。
 * 用于「我给出一个时间段，AI 自动抓取那段行情」。
 */
export async function fetchCandlesRange(
  opts: FetchRangeOptions
): Promise<Candle[]> {
  const marketType = opts.marketType ?? 'swap'
  const step = TF_MS[opts.timeframe]
  const maxCandles = opts.maxCandles ?? 3000
  const exchange = await getExchange(opts.exchangeId, marketType, opts.apiBase)
  const symbol = resolveSymbol(exchange, opts.symbol, marketType)

  const out: Candle[] = []
  const seen = new Set<number>()
  let cursor = opts.from

  while (cursor <= opts.to && out.length < maxCandles) {
    const rows = await withRetry<unknown[]>(`${opts.timeframe} 分页取数`, () =>
      exchange.fetchOHLCV(symbol, opts.timeframe, cursor, 1000)
    )
    if (!Array.isArray(rows) || rows.length === 0) break

    let added = 0
    for (const row of rows as unknown[][]) {
      const ts = Number(row[0])
      if (!Number.isFinite(ts) || ts > opts.to) continue
      if (seen.has(ts)) continue
      seen.add(ts)
      out.push({
        timestamp: ts,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      })
      added++
    }

    const lastTs = Number((rows as unknown[][])[rows.length - 1][0])
    if (!Number.isFinite(lastTs) || lastTs < cursor + step) break
    cursor = lastTs + step
    if (rows.length < 1000 || added === 0) break
  }

  out.sort((a, b) => a.timestamp - b.timestamp)
  return out
}

/** 拉取持仓量历史（用于算变化率；接口不可用时返回空数组） */
async function fetchOpenInterestSeries(
  exchange: any,
  symbol: string
): Promise<number[]> {
  if (typeof exchange.fetchOpenInterestHistory !== 'function') return []
  const rows = await exchange.fetchOpenInterestHistory(
    symbol,
    '1h',
    undefined,
    6
  )
  if (!Array.isArray(rows)) return []
  return rows
    .map((r: any) =>
      Number(r?.openInterestAmount ?? r?.openInterestValue ?? r?.openInterest)
    )
    .filter((v: number) => Number.isFinite(v) && v > 0)
}

/** 拉取多空持仓人数比（ccxt 无该接口时返回 null） */
async function fetchLongShort(
  exchange: any,
  symbol: string
): Promise<number | null> {
  if (typeof exchange.fetchLongShortRatio !== 'function') return null
  const r = await exchange.fetchLongShortRatio(symbol, '1h', undefined, 1)
  const row = Array.isArray(r) ? r[r.length - 1] : r
  return numOrNull(row?.longShortRatio ?? row?.longAccount)
}

/** 币安 futures/data 基地址 */
const FAPI_DATA_BASE = process.env.FAPI_BASE ?? 'https://fapi.binance.com'

/** 直连币安公开接口取多空持仓人数比（ccxt 未提供时的兜底） */
async function fetchBinanceLongShortRatio(
  pair: string
): Promise<number | null> {
  const url =
    `${FAPI_DATA_BASE}/futures/data/globalLongShortAccountRatio` +
    `?symbol=${encodeURIComponent(pair)}&period=1h&limit=1`
  const res = await fetch(url, {
    headers: {'User-Agent': 'crypto-entry-advisor'}
  })
  if (!res.ok) return null
  const arr = (await res.json()) as Array<Record<string, unknown>>
  const row = Array.isArray(arr) ? arr[arr.length - 1] : null
  return numOrNull(row?.longShortRatio)
}

/**
 * 拉取某币的完整行情快照。
 *
 * 跟知识库收录时**同一套做法**：不算任何口径，把每个周期的 K 线
 * **切成小段描述**（`describeSeries`）直接交给 AI 自己读。
 *
 * 主周期用「图上那段有多长」的天数；其余周期按 `calibers.others` 的天数。
 */
export async function fetchSnapshot(
  opts: FetchOptions
): Promise<MarketSnapshot> {
  const marketType = opts.marketType ?? 'swap'
  const cal = opts.calibers ?? DEFAULT_CALIBERS
  const exchange = await getExchange(opts.exchangeId, marketType, opts.apiBase)
  const symbol = resolveSymbol(exchange, opts.symbol, marketType)

  /** 是不是「以过去某一刻为现在」的回放（测试 / 复盘） */
  const replayAt = typeof opts.at === 'number' && opts.at > 0 ? opts.at : null

  const plan = planFor(opts.timeframe, cal)
  const daysOf = (tf: Timeframe, days: number | null) => days ?? opts.days

  let ticker: any = null
  let fr: any = null
  let oi: any = null
  let oiSeries: number[] = []
  let ls: number | null = null

  /** 每个周期拉回来的 K 线 */
  const raw: {timeframe: Timeframe; days: number; candles: Candle[]}[] = []

  if (replayAt) {
    // 回放：只拉截止那一刻**已收盘**的 K 线。
    // 实时类接口（ticker / 资金费率 / 持仓量 / 多空比）一个都不调 ——
    // 它们只会返回「现在」，混进过去的数据里就是偷看未来。
    const got = await Promise.all(
      plan.map(async p => ({
        timeframe: p.timeframe,
        days: daysOf(p.timeframe, p.days),
        candles: await fetchCandlesAsOf(
          exchange,
          symbol,
          p.timeframe,
          replayAt,
          barsFor(p.timeframe, daysOf(p.timeframe, p.days), cal)
        )
      }))
    )
    raw.push(...got)
  } else {
    const tickerP = exchange.fetchTicker(symbol)
    const candlesP = Promise.all(
      plan.map(async p => {
        const days = daysOf(p.timeframe, p.days)
        const bars = barsFor(p.timeframe, days, cal)
        const rows = await withRetry<unknown[]>(`${p.timeframe} 取数`, () =>
          exchange.fetchOHLCV(symbol, p.timeframe, undefined, bars)
        )
        return {timeframe: p.timeframe, days, candles: toCandles(rows)}
      })
    )

    const [t, got, [f, o, s, l]] = await Promise.all([
      tickerP,
      candlesP,
      Promise.all([
        safeCall(() =>
          exchange.has['fetchFundingRate']
            ? exchange.fetchFundingRate(symbol)
            : null
        ),
        safeCall(() =>
          exchange.has['fetchOpenInterest']
            ? exchange.fetchOpenInterest(symbol)
            : null
        ),
        safeCall(() => fetchOpenInterestSeries(exchange, symbol)),
        safeCall(() => fetchLongShort(exchange, symbol))
      ])
    ])
    ticker = t
    raw.push(...got)
    fr = f
    oi = o
    oiSeries = Array.isArray(s) ? s : []
    ls = l
  }

  /** 主周期那块（图上那个） */
  const mainRaw = raw.find(r => r.timeframe === opts.timeframe) ?? raw[0]
  const mainCandles = mainRaw?.candles ?? []
  const lastClose = mainCandles[mainCandles.length - 1]?.close ?? NaN

  // ---------- 市场热度 ----------
  let fundingRate: number | null = null
  let openInterest: number | null = null
  let openInterestChangePct: number | null = null
  let longShortRatio: number | null = null
  let quoteVolume24h: number | null = null
  let change24hPct: number | null = null
  let amplitude24hPct: number | null = null
  let high24h: number | null = null
  let low24h: number | null = null
  let price = NaN

  if (replayAt) {
    // 只有 K 线可查：现价 = 最后一根已收盘 K 线的收盘，
    // 24h 高低 / 涨跌 / 振幅也从这段 K 线自己算出来
    price = lastClose
    const win = mainCandles.filter(c => c.timestamp >= replayAt - DAY_MS)
    const w = win.length >= 2 ? win : mainCandles
    if (w.length >= 2) {
      let hi = -Infinity
      let lo = Infinity
      for (const c of w) {
        if (c.high > hi) hi = c.high
        if (c.low < lo) lo = c.low
      }
      if (Number.isFinite(hi) && Number.isFinite(lo) && lo > 0) {
        high24h = hi
        low24h = lo
        amplitude24hPct = ((hi - lo) / lo) * 100
      }
      const first = w[0].open
      const last = w[w.length - 1].close
      if (Number.isFinite(first) && first > 0 && Number.isFinite(last)) {
        change24hPct = ((last - first) / first) * 100
      }
    }
  } else {
    fundingRate = fr ? numOrNull(fr.fundingRate) : null
    // 兜底顺序：持仓量接口 → 资金费率里带的 → 持仓量历史最后一期
    openInterest = oi
      ? numOrNull(
          oi.openInterestAmount ?? oi.openInterestValue ?? oi.openInterest
        )
      : null
    if (openInterest === null && fr)
      openInterest = numOrNull(fr.openInterestAmount)
    if (openInterest === null && oiSeries.length > 0)
      openInterest = oiSeries[oiSeries.length - 1]

    if (oiSeries.length >= 2) {
      const first = oiSeries[0]
      const last = oiSeries[oiSeries.length - 1]
      if (first > 0) openInterestChangePct = ((last - first) / first) * 100
    }

    longShortRatio = ls
    if (longShortRatio === null && opts.exchangeId === 'binance') {
      try {
        const m = exchange.market(symbol)
        if (m && m.id) longShortRatio = await fetchBinanceLongShortRatio(m.id)
      } catch {
        /* 忽略 */
      }
    }

    price = Number(ticker?.last ?? lastClose ?? NaN)
    high24h = numOrNull(ticker?.high)
    low24h = numOrNull(ticker?.low)
    amplitude24hPct =
      high24h !== null && low24h !== null && low24h > 0
        ? ((high24h - low24h) / low24h) * 100
        : null
    change24hPct = numOrNull(ticker?.percentage)
    quoteVolume24h = numOrNull(ticker?.quoteVolume ?? ticker?.baseVolume)
  }

  const heat: MarketHeat = {
    fundingRate,
    openInterest,
    openInterestChangePct,
    quoteVolume24h,
    change24hPct,
    amplitude24hPct,
    longShortRatio,
    high24h,
    low24h
  }

  // ---------- 每个周期切成小段读结构 ----------
  const blocks: SeriesBlock[] = raw.map(r => {
    const {text, stats} = describeSeries(r.candles)
    // EMA42 只给 15m / 1h（用户要求：看回调时才参考，平时不用提）
    const ema42 =
      r.timeframe === '15m' || r.timeframe === '1h'
        ? (ema42Of(r.candles) ?? undefined)
        : undefined
    return {
      timeframe: r.timeframe,
      primary: r.timeframe === opts.timeframe,
      days: r.days,
      bars: stats.bars,
      from: r.candles[0]?.timestamp ?? 0,
      to: r.candles[r.candles.length - 1]?.timestamp ?? 0,
      text,
      ...(ema42 ? {ema42} : {})
    }
  })

  return {
    symbol,
    exchange: opts.exchangeId,
    timestamp: replayAt ?? Date.now(),
    price,
    primary: opts.timeframe,
    blocks,
    heat,
    candles: mainCandles
  }
}

/* ------------------------------------------------------------------ */
/* 头部行情条（实时）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 涨幅那一行看哪几档。
 *
 * ⚠️ 顺序就是界面上的顺序，别乱动 —— 前端按这个顺序摆。
 */
export const CHANGE_WINDOWS = ['d1', 'd3', 'd7', 'm1', 'm3', 'y1'] as const
export type ChangeWindow = (typeof CHANGE_WINDOWS)[number]

/**
 * 每档往前数多少天（`y1` 要 366 根日线才够，见下面 `dailySeries`）。
 *
 * ⚠️ `d1` 是**今日涨跌（UTC 日切）**：基点是**昨天那根 1d 的收盘**。
 *    它跟头部那条「24h 涨跌」（滚动 24 小时）**不是一回事** —— 2026-10-07 专门拍过这个口径：
 *    两个数不一样、信息量更大；要是一样就没必要并排显示两个。
 */
const CHANGE_DAYS: Record<ChangeWindow, number> = {
  d1: 1,
  d3: 3,
  d7: 7,
  m1: 30,
  m3: 90,
  y1: 365
}

/** 基点：第 N 天前那根 1d 的收盘（UTC 零点对齐） */
export interface ChangeBase {
  at: number
  close: number
}

const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS

/**
 * 头部那条行情（币安期货页顶部那种）。
 *
 * 这是**轻量**取数：ticker + 资金费率 + 持仓量 + 366 根日线，四个请求并发，
 * 跟 `fetchSnapshot`（要切段、算结构、拉多周期）不是一回事，能十几秒刷一次。
 */
export interface TickerInfo {
  /** 归一化后的符号，如 `BTC/USDT:USDT` */
  symbol: string
  /** 交易所原始交易对，如 `BTCUSDT` */
  pair: string
  marketType: MarketType
  last: number | null
  /** 24h 涨跌额 */
  change24h: number | null
  /** 24h 涨跌幅 % */
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  /** 24h 成交量（币） */
  volume24h: number | null
  /** 24h 成交额（计价币，通常是 USDT） */
  quoteVolume24h: number | null
  markPrice: number | null
  indexPrice: number | null
  /** 当期资金费率（0.0001 = 0.01%） */
  fundingRate: number | null
  /**
   * 结算周期（小时）。交易所一般给 8（少数币 4）——
   * ccxt 的 `interval` 经常是空的，所以拿「下一次结算 − 上一次结算」自己算。
   */
  fundingIntervalHours: number | null
  /** 下一次结算时刻（毫秒） */
  nextFundingAt: number | null
  /** 合约持仓量（币） */
  openInterest: number | null
  /** 合约持仓量折算成计价币 */
  openInterestValue: number | null
  /** 3天 / 7天 / 1个月 / 3个月 / 1年 涨幅 % */
  changes: Record<ChangeWindow, number | null>
  /**
   * 每档的**基点**（第 N 天前那根 1d 的收盘）。
   *
   * 给前端用：现价每秒都在变（行情 SSE 增量），而基点一天才变一次 ⇒
   * 前端拿基点 + 现价就能**每秒重算**这一行，不必等下一次 `/api/ticker`（原来是 60 秒）。
   */
  changeBases: Record<ChangeWindow, ChangeBase | null>
  updatedAt: number
}

/**
 * 拉一次头部行情。
 *
 * 涨跌幅口径：**第 N 天前那根日线的收盘 → 现价**（跟交易所「N 天涨幅」一致）。
 * 日线**先读底座库**（0 权重），库里不够才退回 REST（见 `dailySeries`）。
 */
/**
 * 「日线收盘」序列（`UTC 零点 → 收盘价`）：**先读底座库**（`candles` 的 1d，0 权重），
 * 库里不够才退回 REST 那 366 根。
 *
 * 为什么改：以前每个开着的页面每分钟都要现拉一次日线（4 个上游请求里最贵的一发）。
 * 底座库里已经有 1000+ 根日线（`KLINE_SEED` 灌的 + 自己滚出来的），顺带还能把
 * 「基点是哪一刻的」一起给前端（`changeBases`）⇒ 现价一动这几档就能秒级重算。
 *
 * ⚠️ 退回 REST 的条件：库里少于 `y1 + 2` 根（现货 / 刚上的币 / 历史还没灌）。
 */
async function dailySeries(
  opts: {exchangeId: string; apiBase?: string},
  symbol: string,
  marketType: MarketType,
  exchange: any
): Promise<Map<number, number>> {
  const need = CHANGE_DAYS.y1 + 2
  const fromDb = new Map<number, number>()
  try {
    for (const r of await dailyCloses(opts.exchangeId, marketType, symbol, need + 10)) {
      if (r.close > 0) fromDb.set(r.at, r.close)
    }
  } catch {
    /* 库没起来 / 表还没建 → 直接走 REST */
  }
  if (fromDb.size >= need) return fromDb

  const rows =
    (await safeCall<any[]>(() => exchange.fetchOHLCV(symbol, '1d', undefined, 366))) ?? []
  const fromRest = new Map<number, number>()
  for (const r of rows as unknown[][]) {
    const at = Number(r[0])
    const close = Number(r[4])
    if (Number.isFinite(at) && Number.isFinite(close) && close > 0) fromRest.set(at, close)
  }
  return fromRest.size > fromDb.size ? fromRest : fromDb
}

export async function fetchTickerInfo(opts: {
  exchangeId: string
  symbol: string
  marketType?: MarketType
  apiBase?: string
}): Promise<TickerInfo> {
  const marketType = opts.marketType ?? 'swap'
  const exchange = await getExchange(opts.exchangeId, marketType, opts.apiBase)
  const symbol = resolveSymbol(exchange, opts.symbol, marketType)

  const [ticker, fr, oi, daily] = await Promise.all([
    withRetry<any>('头部 ticker', () => exchange.fetchTicker(symbol)),
    safeCall<any>(() =>
      exchange.has['fetchFundingRate']
        ? exchange.fetchFundingRate(symbol)
        : null
    ),
    safeCall<any>(() =>
      exchange.has['fetchOpenInterest']
        ? exchange.fetchOpenInterest(symbol)
        : null
    ),
    dailySeries(opts, symbol, marketType, exchange)
  ])

  /** 交易所原始交易对（BTCUSDT），界面上跟交易所对齐 */
  let pair = ''
  try {
    pair = String(exchange.market(symbol)?.id ?? '')
  } catch {
    pair = ''
  }

  const last = numOrNull(ticker?.last)
  const todayStart = utcDayStart(Date.now())

  const changes = {} as Record<ChangeWindow, number | null>
  const changeBases = {} as Record<ChangeWindow, ChangeBase | null>
  for (const w of CHANGE_WINDOWS) {
    /* 基点 = 「第 N 天前那根 1d」的开盘时间（UTC 零点）对应的收盘价 */
    const at = todayStart - CHANGE_DAYS[w] * DAY_MS
    const base = daily.get(at) ?? null
    changeBases[w] = base && base > 0 ? {at, close: base} : null
    changes[w] =
      last !== null && base && base > 0 ? (last / base - 1) * 100 : null
  }

  const nextFundingAt =
    numOrNull(fr?.nextFundingTimestamp) ??
    numOrNull(fr?.fundingTimestamp) ??
    null

  // 结算周期：ccxt 的 interval（'8h'）优先，没有就用「下一次 − 上一次」自己算
  let fundingIntervalHours: number | null = null
  const ivRaw = String(fr?.interval ?? '')
  const ivMatch = ivRaw.match(/^(\d+(?:\.\d+)?)h$/)
  if (ivMatch) fundingIntervalHours = Number(ivMatch[1])
  if (fundingIntervalHours === null) {
    const prev = numOrNull(fr?.previousFundingTimestamp)
    if (nextFundingAt !== null && prev !== null && nextFundingAt > prev) {
      fundingIntervalHours = Math.round((nextFundingAt - prev) / 3_600_000)
    }
  }

  const openInterest = numOrNull(
    oi?.openInterestAmount ?? oi?.openInterestValue ?? oi?.openInterest
  )
  let openInterestValue = numOrNull(oi?.openInterestValue)
  if (openInterestValue === null && openInterest !== null) {
    const px = numOrNull(ticker?.markPrice) ?? last
    if (px !== null) openInterestValue = openInterest * px
  }

  return {
    symbol,
    pair: pair || symbol.replace(/[:/]/g, ''),
    marketType,
    last,
    change24h: numOrNull(ticker?.change),
    change24hPct: numOrNull(ticker?.percentage),
    high24h: numOrNull(ticker?.high),
    low24h: numOrNull(ticker?.low),
    volume24h: numOrNull(ticker?.baseVolume),
    quoteVolume24h: numOrNull(ticker?.quoteVolume),
    // ticker 里就带标记 / 指数价（币安 premiumIndex 一并返回）
    markPrice: numOrNull(ticker?.markPrice ?? fr?.markPrice),
    indexPrice: numOrNull(ticker?.indexPrice ?? fr?.indexPrice),
    fundingRate: fr ? numOrNull(fr.fundingRate) : null,
    fundingIntervalHours,
    nextFundingAt,
    openInterest,
    openInterestValue,
    changes,
    changeBases,
    updatedAt: Date.now()
  }
}

/** 合约行情列表的一行（列照着币安「合约行情」页来） */
export interface MarketRow {
  /** 界面上的币种（BTC） */
  base: string
  /** ccxt 统一符号（BTC/USDT:USDT） */
  symbol: string
  /** 交易所原始交易对（BTCUSDT） */
  pair: string
  last: number | null
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  /** 24h 成交量（按币算） */
  volume24h: number | null
  /** 24h 成交额（按计价币算，U 本位就是 USDT） */
  quoteVolume24h: number | null
  /**
   * 全网市值排名（CoinGecko，1 = BTC）。
   * 不在前 500 名的（新上币 / 小币）是 null —— 界面就不显示这一项。
   * 见 `data/marketcap.ts`。
   */
  rank?: number | null
}

/**
 * 全站**唯一的一把尺子**：U 本位永续只认 `contractType = PERPETUAL`。
 *
 * 币安的「TradFi 永续」（AAPLUSDT / XAUUSDT / SOXLUSDT…）也是 swap + linear，
 * 不拦就多出两百多个 —— 行情表的「共 N 个合约」、币种下拉、K 线底座的订阅币集
 * 一旦各用一把尺子，用户就会看到「合约数量对不上」。
 * （别的交易所没有 contractType，拿不到就照收。）
 */
function isPerpetual(m: any): boolean {
  const ct = String(m?.info?.contractType ?? '').toUpperCase()
  return !ct || ct === 'PERPETUAL'
}

export interface PerpSymbol {
  /** ccxt 统一符号（BTC/USDT:USDT）—— 库里 / 接口里都用它 */
  symbol: string
  /** 币安交易对（BTCUSDT）—— 上游 WS 的流名用它 */
  pair: string
  base: string
}

/**
 * U 本位永续的完整清单，**0 网络**（markets 是启动时从库里灌进内存的那份，
 * 见 `data/ccxt-markets.ts`）。
 */
export async function listPerpetualSymbols(opts: {
  exchangeId: string
  apiBase?: string
}): Promise<PerpSymbol[]> {
  const exchange = await getExchange(opts.exchangeId, 'swap', opts.apiBase)
  const out: PerpSymbol[] = []
  for (const [sym, raw] of Object.entries(exchange.markets ?? {})) {
    const m = raw as any
    if (!m || m.active === false) continue
    if (!(m.swap && m.linear)) continue
    if (String(m.quote).toUpperCase() !== 'USDT') continue
    if (!isPerpetual(m)) continue
    const pair = String(m.id ?? '')
    if (!pair) continue
    out.push({symbol: sym, pair, base: String(m.base ?? sym.split('/')[0])})
  }
  return out
}

/**
 * 全部合约的 24h 行情。
 *
 * 参考币安合约行情页：**一次请求拿全**（ccxt `fetchTickers` 对币安 U 本位
 * 就是打一次 `/fapi/v1/ticker/24hr`），按成交额从大到小排。
 * 只保留还在交易、计价 USDT 的合约 —— 下架的、非 USDT 的（如币本位）混进来
 * 会让「排行榜」没意义。
 *
 * `limit` 只是兜底：页面上默认只渲染前若干行，数据还是全的（搜索/排序都要全）。
 */
export async function fetchMarketList(opts: {
  exchangeId: string
  marketType?: MarketType
  apiBase?: string
  limit?: number
}): Promise<MarketRow[]> {
  const marketType = opts.marketType ?? 'swap'
  const exchange = await getExchange(opts.exchangeId, marketType, opts.apiBase)
  const tickers = await withRetry<any>('合约行情', () =>
    exchange.fetchTickers()
  )
  const markets: Record<string, any> = exchange.markets ?? {}

  const rows: MarketRow[] = []
  for (const [sym, m] of Object.entries(markets)) {
    if (!m || m.active === false) continue
    if (marketType === 'swap' && !(m.swap && m.linear)) continue
    if (marketType === 'coinm' && !(m.swap && m.inverse)) continue
    if (marketType === 'spot' && !m.spot) continue
    // U 本位永续一律 USDT 计价；币本位是 USD，现货挑 USDT 对
    if (marketType !== 'coinm' && String(m.quote).toUpperCase() !== 'USDT')
      continue
    if (!isPerpetual(m)) continue

    const t = tickers?.[sym]
    if (!t) continue
    const last = numOrNull(t.last)
    if (last === null) continue

    rows.push({
      base: String(m.base ?? sym.split('/')[0]),
      symbol: sym,
      pair: String(m.id ?? ''),
      last,
      change24hPct: numOrNull(t.percentage),
      high24h: numOrNull(t.high),
      low24h: numOrNull(t.low),
      volume24h: numOrNull(t.baseVolume),
      quoteVolume24h: numOrNull(t.quoteVolume)
    })
  }

  // 成交额大的排前面 —— 跟交易所默认榜一致
  rows.sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
  return opts.limit ? rows.slice(0, opts.limit) : rows
}

/**
 * 拉**全市场标记价**（`GET /fapi/v1/premiumIndex`，不带 symbol 一次拿全，权重 10）。
 *
 * ★ 2026-10-06 加：给「持仓未实现盈亏」的实时重算做 **REST 兜底**用。
 *
 * 为什么一次拿全、而不是按币逐个查（`?symbol=` 权重才 1）：
 * 这一路的成本**几乎全在往返上**（本地经出口隧道约 1 秒），一个来回比 10 个权重贵得多。
 * 而且 `@markPrice@1s` 那条 WS 流本来就是「每币一条」，一次全拿语义一样。
 *
 * 返回 `{ 币安原始符号(大写) → 标记价 }`。
 */
export async function fetchMarkPrices(opts?: {
  exchangeId?: string
  apiBase?: string
}): Promise<Map<string, number>> {
  const exchange = await getExchange(
    opts?.exchangeId ?? 'binance',
    'swap',
    opts?.apiBase
  )
  /* ccxt 的隐式方法：binance 上就是 `/fapi/v1/premiumIndex`（不带参数 = 全市场） */
  const list: any[] = (await exchange.fapiPublicGetPremiumIndex()) ?? []
  const out = new Map<string, number>()
  for (const r of list) {
    const sym = String(r?.symbol ?? '').toUpperCase()
    const mark = numOrNull(r?.markPrice)
    if (sym && mark !== null) out.set(sym, mark)
  }
  return out
}
