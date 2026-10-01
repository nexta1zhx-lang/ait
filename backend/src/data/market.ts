import ccxt from 'ccxt'
import {
  Candle,
  MarketHeat,
  MarketSnapshot,
  MarketType,
  StructureState,
  Timeframe,
  TimeframeTrend,
  TrendState
} from '../types'

const CCXT: any = ccxt

/** 判定趋势所用的统计窗口（按周期给不同长度） */
const TREND_LOOKBACK: Record<Timeframe, number> = {
  '5m': 60,
  '15m': 60,
  '1h': 72,
  '4h': 60,
  '1d': 60
}

/** 结构不明晰时，用净涨跌幅兜底的阈值（%） */
const NET_CHANGE_THRESHOLD = 1.5

/** 成交量均线窗口（用于量比） */
const VOL_RATIO_WINDOW = 20

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

interface Pivot {
  index: number
  price: number
}

/** 摆动高点：左右 wing 根都不高于它（纯价格，不是指标） */
function findPivotHighs(candles: Candle[], wing = 2): Pivot[] {
  const out: Pivot[] = []
  for (let i = wing; i < candles.length - wing; i++) {
    let ok = true
    for (let j = i - wing; j <= i + wing; j++) {
      if (j !== i && candles[j].high >= candles[i].high) {
        ok = false
        break
      }
    }
    if (ok) out.push({index: i, price: candles[i].high})
  }
  return out
}

/** 摆动低点 */
function findPivotLows(candles: Candle[], wing = 2): Pivot[] {
  const out: Pivot[] = []
  for (let i = wing; i < candles.length - wing; i++) {
    let ok = true
    for (let j = i - wing; j <= i + wing; j++) {
      if (j !== i && candles[j].low <= candles[i].low) {
        ok = false
        break
      }
    }
    if (ok) out.push({index: i, price: candles[i].low})
  }
  return out
}

/**
 * 纯价格结构分析（不使用任何技术指标）：
 *   更高的高点 + 更高的低点 → 上涨结构
 *   更低的高点 + 更低的低点 → 下跌结构
 */
export function analyzeStructure(
  candles: Candle[],
  lookback: number
): StructureState {
  const empty: StructureState = {
    higherHighs: false,
    higherLows: false,
    lowerHighs: false,
    lowerLows: false,
    lastSwingHigh: NaN,
    lastSwingLow: NaN,
    swingHigh: NaN,
    swingLow: NaN,
    lookback: 0
  }
  if (!Array.isArray(candles) || candles.length < 6) return empty

  const slice = candles.slice(-lookback)
  let hi = -Infinity
  let lo = Infinity
  for (const c of slice) {
    if (c.high > hi) hi = c.high
    if (c.low < lo) lo = c.low
  }

  const ph = findPivotHighs(slice, 2).slice(-2)
  const pl = findPivotLows(slice, 2).slice(-2)

  return {
    higherHighs: ph.length === 2 && ph[1].price > ph[0].price,
    lowerHighs: ph.length === 2 && ph[1].price < ph[0].price,
    higherLows: pl.length === 2 && pl[1].price > pl[0].price,
    lowerLows: pl.length === 2 && pl[1].price < pl[0].price,
    lastSwingHigh: ph.length ? ph[ph.length - 1].price : hi,
    lastSwingLow: pl.length ? pl[pl.length - 1].price : lo,
    swingHigh: hi,
    swingLow: lo,
    lookback: slice.length
  }
}

/** 由结构 + 净涨跌幅得出趋势状态 */
function classifyTrendState(
  structure: StructureState,
  netChangePct: number
): TrendState {
  if (structure.higherHighs && structure.higherLows) return 'up'
  if (structure.lowerHighs && structure.lowerLows) return 'down'
  if (Number.isFinite(netChangePct)) {
    if (netChangePct >= NET_CHANGE_THRESHOLD) return 'up'
    if (netChangePct <= -NET_CHANGE_THRESHOLD) return 'down'
  }
  return 'range'
}

/** 由单周期 K 线得到趋势快照（纯价格结构，无任何技术指标） */
export function buildTimeframeTrend(
  timeframe: Timeframe,
  candles: Candle[]
): TimeframeTrend {
  const close = candles[candles.length - 1]?.close ?? NaN
  const lookback = Math.min(TREND_LOOKBACK[timeframe] ?? 60, candles.length)
  const window = candles.slice(-lookback)
  const first = window[0]
  const netChangePct =
    first && first.close ? ((close - first.close) / first.close) * 100 : NaN

  let hi = -Infinity
  let lo = Infinity
  for (const c of window) {
    if (c.high > hi) hi = c.high
    if (c.low < lo) lo = c.low
  }
  const rangePct =
    Number.isFinite(hi) && Number.isFinite(lo) && lo > 0
      ? ((hi - lo) / lo) * 100
      : NaN

  // 量比：最新一根成交量 / 近 N 根均量
  const recentVols = window.slice(-VOL_RATIO_WINDOW).map(c => c.volume)
  const avg = recentVols.length
    ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length
    : NaN
  const lastVol = window[window.length - 1]?.volume ?? NaN
  const volRatio = Number.isFinite(avg) && avg > 0 ? lastVol / avg : NaN

  const structure = analyzeStructure(candles, Math.max(lookback, 30))

  return {
    timeframe,
    close,
    trend: classifyTrendState(structure, netChangePct),
    netChangePct,
    rangePct,
    volRatio,
    structure
  }
}

function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
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

export interface FetchOptions {
  exchangeId: string
  symbol: string
  timeframes: Timeframe[]
  limit: number
  recentTimeframe: Timeframe
  recentCount: number
  /** 市场类型，默认 U 本位合约 */
  marketType?: MarketType
  /** 覆盖交易所公共 API 域名，用于默认域名不可达的场景 */
  apiBase?: string
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

/** 各周期一根 K 线的毫秒数 */
const TF_MS: Record<Timeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
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
 * 用于「我给出一个时间段，AI 自动抓取拉升前后的样子」。
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
 * 拉取某币种的完整行情快照：
 *   多周期趋势（价格结构） + 市场热度。不含任何技术指标。
 */
export async function fetchSnapshot(
  opts: FetchOptions
): Promise<MarketSnapshot> {
  const marketType = opts.marketType ?? 'swap'
  const exchange = await getExchange(opts.exchangeId, marketType, opts.apiBase)
  const symbol = resolveSymbol(exchange, opts.symbol, marketType)
  const ticker = await exchange.fetchTicker(symbol)

  const timeframes: TimeframeTrend[] = []
  const candlesByTf: Partial<Record<Timeframe, Candle[]>> = {}
  for (const tf of opts.timeframes) {
    const rows = await exchange.fetchOHLCV(symbol, tf, undefined, opts.limit)
    const candles = toCandles(rows)
    candlesByTf[tf] = candles
    timeframes.push(buildTimeframeTrend(tf, candles))
  }

  // ---------- 市场热度（全部容错，取不到就是 null） ----------
  let fundingRate: number | null = null
  let openInterest: number | null = null
  let openInterestChangePct: number | null = null
  let longShortRatio: number | null = null

  try {
    if (exchange.has['fetchFundingRate']) {
      const fr = await exchange.fetchFundingRate(symbol)
      fundingRate = numOrNull(fr.fundingRate)
      if (openInterest === null) openInterest = numOrNull(fr.openInterestAmount)
    }
  } catch {
    /* 忽略 */
  }

  try {
    if (exchange.has['fetchOpenInterest']) {
      const oi = await exchange.fetchOpenInterest(symbol)
      openInterest = numOrNull(
        oi.openInterestAmount ?? oi.openInterestValue ?? oi.openInterest
      )
    }
  } catch {
    /* 忽略 */
  }

  try {
    const series = await fetchOpenInterestSeries(exchange, symbol)
    if (series.length >= 2) {
      const first = series[0]
      const last = series[series.length - 1]
      if (first > 0) openInterestChangePct = ((last - first) / first) * 100
      if (openInterest === null) openInterest = last
    }
  } catch {
    /* 忽略 */
  }

  try {
    longShortRatio = await fetchLongShort(exchange, symbol)
  } catch {
    /* ccxt 不支持时忽略，走下面的兜底 */
  }
  if (longShortRatio === null && opts.exchangeId === 'binance') {
    try {
      const m = exchange.market(symbol)
      if (m && m.id) longShortRatio = await fetchBinanceLongShortRatio(m.id)
    } catch {
      /* 忽略 */
    }
  }

  const lastTf = opts.timeframes[opts.timeframes.length - 1]
  const recent = candlesByTf[opts.recentTimeframe] ?? candlesByTf[lastTf] ?? []
  const recentCandles = recent.slice(-opts.recentCount)

  const structureSource = candlesByTf['1h'] ?? recent
  const structure = analyzeStructure(
    structureSource,
    Math.max(30, Math.min(60, structureSource.length))
  )

  const price = Number(ticker.last ?? recent[recent.length - 1]?.close ?? NaN)
  const high24h = numOrNull(ticker.high)
  const low24h = numOrNull(ticker.low)
  const amplitude24hPct =
    high24h !== null && low24h !== null && low24h > 0
      ? ((high24h - low24h) / low24h) * 100
      : null

  const heat: MarketHeat = {
    fundingRate,
    openInterest,
    openInterestChangePct,
    quoteVolume24h: numOrNull(ticker.quoteVolume ?? ticker.baseVolume),
    change24hPct: numOrNull(ticker.percentage),
    amplitude24hPct,
    longShortRatio,
    high24h,
    low24h
  }

  const variables: Record<string, number> = {
    price,
    funding_rate: fundingRate ?? NaN,
    open_interest: openInterest ?? NaN,
    oi_change_pct: openInterestChangePct ?? NaN,
    change24h_pct: heat.change24hPct ?? NaN,
    amplitude24h_pct: heat.amplitude24hPct ?? NaN,
    volume24h: heat.quoteVolume24h ?? NaN,
    long_short_ratio: longShortRatio ?? NaN,
    swing_high: structure.swingHigh,
    swing_low: structure.swingLow,
    last_swing_high: structure.lastSwingHigh,
    last_swing_low: structure.lastSwingLow,
    trend_up_count: 0,
    trend_down_count: 0,
    trend_range_count: 0
  }

  let up = 0
  let down = 0
  let range = 0
  for (const t of timeframes) {
    const p = t.timeframe
    variables[`close_${p}`] = t.close
    variables[`net_change_${p}`] = t.netChangePct
    variables[`range_${p}`] = t.rangePct
    variables[`vol_ratio_${p}`] = t.volRatio
    variables[`trend_${p}`] = t.trend === 'up' ? 1 : t.trend === 'down' ? -1 : 0
    if (t.trend === 'up') up++
    else if (t.trend === 'down') down++
    else range++
  }
  variables.trend_up_count = up
  variables.trend_down_count = down
  variables.trend_range_count = range

  return {
    symbol,
    exchange: opts.exchangeId,
    timestamp: Date.now(),
    price,
    timeframes,
    heat,
    structure,
    recentCandles,
    series: recent,
    variables
  }
}
