import ccxt from 'ccxt'
import {DEFAULT_CALIBERS, TF_MS, barsFor, planFor} from '../calibers'
import {describeSeries} from '../analysis/describe'
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

export interface RecentSR {
  hours: number
  /** 压力（区间最高价） */
  resistance: number
  /** 支撑（区间最低价） */
  support: number
  candles: number
}

/**
 * 计算最近 N 小时的压力 / 支撑（传入 1H K 线，取最近 N 根）。
 * 数据不足或区间无效时返回 null（调用方据此选择“不画”）。
 */
export function computeRecentSR(
  candles1h: Candle[],
  hours = 4
): RecentSR | null {
  if (!Array.isArray(candles1h) || candles1h.length < 2) return null
  const win = candles1h.slice(-hours)
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
  const rows = await exchange.fetchOHLCV(
    symbol,
    tf,
    at - (bars + 2) * step,
    bars + 3
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
const exchangeCache = new Map<string, any>()

/** 获取（并缓存）已加载市场的交易所实例 */
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
    enableRateLimit: true,
    options: marketOptions(marketType)
  })
  if (apiBase) applyApiBase(exchange, apiBase)
  await exchange.loadMarkets()
  exchangeCache.set(key, exchange)
  return exchange
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
  const rows = await exchange.fetchOHLCV(
    symbol,
    opts.timeframe,
    opts.since,
    opts.limit
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
    const rows = await exchange.fetchOHLCV(symbol, opts.timeframe, cursor, 1000)
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
        const rows = await exchange.fetchOHLCV(
          symbol,
          p.timeframe,
          undefined,
          barsFor(p.timeframe, days, cal)
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
    return {
      timeframe: r.timeframe,
      primary: r.timeframe === opts.timeframe,
      days: r.days,
      bars: stats.bars,
      from: r.candles[0]?.timestamp ?? 0,
      to: r.candles[r.candles.length - 1]?.timestamp ?? 0,
      text
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
