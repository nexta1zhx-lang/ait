import ccxt from 'ccxt'
import {ccxtBaseOptions} from './exchange-account'
import {
  attachMarkets,
  marketsKeyOf,
  reloadMarkets,
  retryUnknownSymbol
} from './ccxt-markets'
import {coolingLeftMs, coolingMessage, noteRateLimit} from '../util/rate-cool'
import {DEFAULT_CALIBERS, TF_MS, barsFor} from '../calibers'
import {
  dailyCloses,
  readRangeCandles,
  readRecentCandles,
  unifiedPerpSymbol
} from '../db/candle-store'
import {markInfoOf} from './mark-cache'
import {ANALYSIS_BARS, barLines} from '../analysis/describe'
import {
  Calibers,
  Candle,
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
   * 实际拉多少根 = `max(barsFor(这个天数), 2×100)` —— 只有主周期一个周期。
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
  /** 取数参数（根数上下限）；不传就用默认值 */
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
  /*
   * ★ 按**交易所原始 id** 查（2026-10-13 补，用户报「当前持仓获取不到行情了」）。
   *
   * 账本 / 持仓里存的是交易所的 id（`MEGAUSDT`、`1000BONKUSDT`），而 ccxt 的
   * `exchange.markets` 是按**统一符号**索引的（`MEGA/USDT:USDT`）。上面那两个
   * candidate 都救不回来：
   *   · `markets['MEGAUSDT']` ✗（那是 id，不在这个索引里）；
   *   · `normalizeSymbol('MEGAUSDT','swap')` = `MEGAUSDT/USDT:USDT` ✗
   *     —— 它本来就是给**基础币**（`BTC`）用的，喂整串 id 会多切出一截；
   *   · 下面那个"去掉分隔符再比"的模糊匹配也匹配不上
   *     （`MEGAUSDT` vs `MEGA/USDT:USDT` 去掉分隔符是 `MEGAUSDTUSDT`）。
   * 所以直接查 ccxt 的 id 索引（`markets_by_id`，值可能是数组）。
   */
  const byId = exchange.markets_by_id?.[upper]
  const hit = Array.isArray(byId) ? byId[0] : byId
  if (hit?.symbol) return String(hit.symbol)
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

/**
 * 解析符号：**认不出来就重刷一次 markets 再试**。
 *
 * ★ 2026-10-13 用户：「当前持仓获取不到行情了」——那笔是**刚上架**的币（MEGAUSDT），
 *   库里那份 markets 是上架之前的快照，ccxt 认不出这个符号。
 *   ⚠️ 这一步发生在**任何 ccxt 调用之前**，所以 `retryUnknownSymbol()` 那套
 *     `catch(unknownSymbol) → 重刷 → 重试` 的包装兜不住它（那套包的是 fetchOHLCV 等方法）。
 *     凡是"先解析、再请求"的入口都得走这个helper，别再自己 `resolveSymbol`。
 *   ⚠️ `reloadMarkets` 自带 inflight 去重（短时间内多次并发只打一次上游），
 *     所以这里不必再加锁。
 */
async function resolveWithReload(
  exchange: any,
  raw: string,
  marketType: MarketType,
  marketsKey: string
): Promise<string> {
  try {
    return resolveSymbol(exchange, raw, marketType)
  } catch (e) {
    console.warn(
      `[exch] 认不出符号 ${raw} ⇒ 重刷 markets 再试（${(e as Error).message.slice(0, 70)}）`
    )
    await reloadMarkets(exchange, marketsKey)
    return resolveSymbol(exchange, raw, marketType)
  }
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
  const mk = marketsKeyOf(opts.exchangeId, marketType, opts.apiBase || 'live')
  const symbol = await resolveWithReload(exchange, opts.symbol, marketType, mk)
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
  const mk = marketsKeyOf(opts.exchangeId, marketType, opts.apiBase || 'live')
  const symbol = await resolveWithReload(exchange, opts.symbol, marketType, mk)

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

/*
 * ────────────────────────── 一个周期的 K 线从哪来 ──────────────────────────
 *
 * ★ 2026-10-11（用户：「读读我本地的不也可以吗？反正我库里有所有的数据」）：
 *   分析改成**本地库优先**。底座（`kline-recorder`）常驻把 1m 滚成
 *   15m / 1h / 4h / 1d 写进 `candles`，库里查一次是毫秒级、**0 上游权重**；
 *   以前这里每个周期都要现拉一次币安（4~5 发 REST），既慢又吃限流。
 *
 * 口径跟 `data/kline-store.ts` 一致（图表走的是那条三层读）：
 *   · 底座只覆盖 **binance 的 U 本位永续** —— 现货 / 币本位照旧走 REST；
 *   · 库里只有**已收盘**的桶 ⇒ 正在走的那根由实时底座补上（`currentBar`）；
 *   · 库里不够（新上市的币）/ 太旧（底座挂了·断流）⇒ 退回 REST。
 *
 * ⚠️ 不复用 `kline-store` 那份**内存缓存**：它的单份上限是 600~1200 根，
 *    而分析一次要最多 1500 根（`calibers.maxBars`）—— 硬塞会把图表的缓存顶掉。
 */

/** 底座覆盖范围（跟 `kline-store.ts` 的 `inRecorderScope` 同一把口径） */
function inDbScope(exchangeId: string, marketType: MarketType): boolean {
  return exchangeId === 'binance' && marketType === 'swap'
}

/**
 * 库里至少要有这么多根才认它 —— 低于这个数说明底座没订阅过这个币
 * （新上市 / 非 swap），来回退 REST 纯浪费。跟 `kline-store.ts` 同一个值。
 */
const DB_MIN_BARS = 50

/**
 * 库里最后一根**已收盘**的桶如果比这还旧，就认为底座不健康（挂了 / 断流），
 * 退回 REST。正常情况最后一根的收盘时刻离现在最多一个周期。
 * 跟 `kline-store.ts` 的 `STALE_AFTER` 同一把尺子。
 */
const DB_STALE_AFTER = (tf: Timeframe): number => 2 * TF_MS[tf] + 5 * 60_000

/**
 * 取一个周期的 K 线：**先本地库，库外/太旧才退回交易所**。
 *
 * `at` 给了就是**回放**（测试 / 复盘）：只要那一刻之前**已收盘**的桶，
 * 且不拼实时那根（拼了就是偷看未来）。
 */
async function seriesCandles(o: {
  exchange: any
  exchangeId: string
  marketType: MarketType
  /** ccxt 统一符号（`BTC/USDT:USDT`） */
  symbol: string
  timeframe: Timeframe
  bars: number
  at: number | null
  liveBar: ((tf: Timeframe) => Promise<Candle | null>) | null
}): Promise<{candles: Candle[]; from: 'db' | 'rest'}> {
  const step = TF_MS[o.timeframe]

  if (inDbScope(o.exchangeId, o.marketType)) {
    try {
      /*
       * ⚠️ 回放（`at`）要按**区间**读：`readRecentCandles` 读的是「最近 N 根」，
       *    回放点在过去时那 N 根全落在 `at` 之后，筛完一根不剩（踩过：
       *    「10 天前那一刻」整块退回了 REST，而库里其实一根不缺）。
       */
      const rows = o.at
        ? await readRangeCandles(
            o.timeframe,
            unifiedPerpSymbol(o.symbol),
            o.bars + 2,
            o.at - (o.bars + 2) * step,
            o.at,
            {exchange: o.exchangeId, marketType: o.marketType}
          )
        : await readRecentCandles(
            o.timeframe,
            unifiedPerpSymbol(o.symbol),
            o.bars,
            {exchange: o.exchangeId, marketType: o.marketType}
          )
      const closed = o.at
        ? rows.filter(c => c.timestamp + step <= o.at!).slice(-o.bars)
        : rows
      const last = closed[closed.length - 1]
      // 「现在」这一刻：回放看的是 `at`，实时看的是真现在
      const now = o.at ?? Date.now()
      const fresh = last ? now - last.timestamp <= DB_STALE_AFTER(o.timeframe) : false
      if (closed.length >= Math.min(o.bars, DB_MIN_BARS) && fresh) {
        const out = closed
        if (o.liveBar) {
          const live = await o.liveBar(o.timeframe).catch(() => null)
          if (live) {
            if (!last || live.timestamp > last.timestamp) out.push(live)
            else if (live.timestamp === last.timestamp) out[out.length - 1] = live
          }
        }
        return {candles: out, from: 'db'}
      }
    } catch {
      /* 库没起来 / 表还没建 → 直接走 REST */
    }
  }

  const fromRest = o.at
    ? await fetchCandlesAsOf(o.exchange, o.symbol, o.timeframe, o.at, o.bars)
    : toCandles(
        await withRetry<unknown[]>(`${o.timeframe} 取数`, () =>
          o.exchange.fetchOHLCV(o.symbol, o.timeframe, undefined, o.bars)
        )
      )
  return {candles: fromRest, from: 'rest'}
}

/**
 * 拉取某币的完整行情快照。
 *
 * ★ 2026-10-11：**只取主周期一个周期**（用户：「不要给了，只给当前周期的前 100 根数据」→「1. 不拉了」）。
 *   以前这里是「四个周期各切成小段」，现在主周期拉 `max(图上根数, 2×100)` 根 ——
 *   100 根发给 AI，前面同样长的一段只用来当「量比」的基准，别的周期一概不取。
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

  /*
   * 实时底座里「正在走的那根」的取法（`kline-recorder` 的 `currentBar`）。
   *
   * ⚠️ 用**动态 import**：`data/kline-recorder.ts` 自己也 `import` 本文件
   *    （它要用 `fetchCandlesRange` 等），静态引进来就是一条循环依赖。
   *    这里只在真要走本地库时才 import 一次，之后模块缓存命中，成本可忽略。
   */
  const liveBarOf: ((tf: Timeframe) => Promise<Candle | null>) | null = replayAt
    ? null
    : await (async () => {
        try {
          const rec = await import('./kline-recorder.js')
          return (tf: Timeframe) => rec.currentBar(symbol, tf)
        } catch {
          return null
        }
      })()

  // 至少 2×ANALYSIS_BARS：100 根发给 AI，前面同样长的一段用来当「量比」的基准
  const days = opts.days
  const bars = Math.max(barsFor(opts.timeframe, days, cal), ANALYSIS_BARS * 2)
  const got = await seriesCandles({
    exchange,
    exchangeId: opts.exchangeId,
    marketType,
    symbol,
    timeframe: opts.timeframe,
    bars,
    at: replayAt,
    liveBar: liveBarOf
  })
  const main = {timeframe: opts.timeframe, days, candles: got.candles}
  const mainCandles = main.candles

  /*
   * 现价 = **最后一根 K 线的收盘**。
   *
   * 以前这里取的是 ticker（「24h 行情」那一发）—— 热度整块删掉之后不再有它，
   * 于是价格跟 K 线同源：库/交易所那条链里最后一根（含正在走的那根）的收盘。
   */
  const price = mainCandles[mainCandles.length - 1]?.close ?? NaN

  // ---------- 喂给 AI 的那一段：主周期最近 100 根逐根（开高低收 / 涨跌% / 量比） ----------
  /*
   * ★ 2026-10-11 用户：「不要给了，只给当前周期的前 100 根数据」→「全给数据吧」。
   *
   * 一根一行：**时间 / 开 / 高 / 低 / 收 / 涨跌% / 量比**（`describe.ts` 的 `barLines`）。
   * 其余周期不再取、不再发；EMA42 也不再发（要让 AI 看均线就自己在图上加一条）。
   */
  const win = mainCandles.slice(-ANALYSIS_BARS)
  const blocks: SeriesBlock[] = [
    {
      timeframe: main.timeframe,
      primary: true,
      days: main.days,
      bars: win.length,
      from: win[0]?.timestamp ?? 0,
      to: win[win.length - 1]?.timestamp ?? 0,
      text: barLines(mainCandles, ANALYSIS_BARS).join('\n')
    }
  ]

  const sources = [{timeframe: main.timeframe, from: got.from}]

  return {
    symbol,
    exchange: opts.exchangeId,
    timestamp: replayAt ?? Date.now(),
    price,
    primary: opts.timeframe,
    blocks,
    sources,
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

  /*
   * 资金费率 / 标记价 / 指数价：**先看 WS 那份缓存**（`{sym}@markPrice` 一条消息全带，
   * 见 `./mark-cache`）—— 有新鲜的就省掉 `/fapi/v1/premiumIndex` 这一发。
   * ⚠️ 只认 15 秒以内的：指数价一刻不停在动，旧值填进去不如不发。
   * ⚠️ 首帧（从没看过这个币）时缓存大概率是空的 ⇒ 还是打一发，同时也把「结算周期」带回来
   *    （那个只有 REST 有，WS 只给「下次收取时间」）。
   */
  const pairId = pairOf(exchange, symbol)
  const cachedMark = pairId ? markInfoOf(pairId) : null
  const lastFunding = lastFundingOf.get(pairId) ?? {}
  const [ticker, fr, oi, daily] = await Promise.all([
    withRetry<any>('头部 ticker', () => exchange.fetchTicker(symbol)),
    cachedMark
      ? null
      : safeCall<any>(() =>
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

  /* 攒下来（下次走 WS 缓存时结算周期 / 费率就有值可填） */
  rememberFunding(
    pairId,
    fr ? numOrNull(fr.fundingRate) : null,
    fundingIntervalHours
  )

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
    // 顺序：WS 缓存（最新）→ ticker 自带的标记/指数价（币安 premiumIndex 一并返回）
    markPrice: cachedMark
      ? cachedMark.markPrice
      : numOrNull(ticker?.markPrice ?? fr?.markPrice),
    indexPrice: cachedMark
      ? (cachedMark.indexPrice ?? numOrNull(ticker?.indexPrice ?? fr?.indexPrice))
      : numOrNull(ticker?.indexPrice ?? fr?.indexPrice),
    fundingRate: cachedMark
      ? (cachedMark.fundingRate ?? lastFunding.rate ?? null)
      : fr
        ? numOrNull(fr.fundingRate)
        : (lastFunding.rate ?? null),
    /*
     * 结算周期 WS 不给（消息里只有「下次收取时间」）⇒ 记住上一次 REST 报的，
     * 第一次看过之后就不用再为它打 premiumIndex 了。
     */
    fundingIntervalHours: fundingIntervalHours ?? lastFunding.intervalHours ?? null,
    nextFundingAt: cachedMark?.nextFundingTime ?? nextFundingAt,
    openInterest,
    openInterestValue,
    changes,
    changeBases,
    updatedAt: Date.now()
  }
}

/** ccxt 统一符号 → 交易所原始交易对（`BTCUSDT`）；认不出来就是空串 */
function pairOf(exchange: any, symbol: string): string {
  try {
    return String(exchange?.market?.(symbol)?.id ?? '').toUpperCase()
  } catch {
    return ''
  }
}

/**
 * 每个币「上次 REST 报的」资金费率与结算周期。
 *
 * 结算周期（8 小时那种）**只有 REST 的 premiumIndex 有**，WS 那条只给「下次收取时间」；
 * 资金费率偶尔也可能在 WS 缓存过期的那一刻缺一下。所以把最近一次 REST 的结果记下来，
 * 之后（哪怕走 WS）也能把这两个值填上，不必为了它专门再打一发。
 */
const lastFundingOf = new Map<string, {rate?: number | null; intervalHours?: number | null}>()
const LAST_FUNDING_MAX = 600

function rememberFunding(
  pair: string,
  rate: number | null,
  intervalHours: number | null
): void {
  if (!pair) return
  if (lastFundingOf.size > LAST_FUNDING_MAX) lastFundingOf.clear()
  const prev = lastFundingOf.get(pair) ?? {}
  lastFundingOf.set(pair, {
    rate: rate ?? prev.rate ?? null,
    intervalHours: intervalHours ?? prev.intervalHours ?? null
  })
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
  /**
   * 「基准时刻」那一刻的收盘价（只在请求带了 `?since=` 时给，见 `closesAtOrBefore`）。
   *
   * 前端拿它 + 实时 `last` 现算「基准时间 → 现在」的涨跌幅（换掉 24h 口径）。
   * 没换基准、或那一刻查不到就是个 `null`。
   */
  baseClose?: number | null
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
/**
 * 币安 `/fapi/v1/premiumIndex` 的一行 —— **一次请求就是全市场**。
 *
 * 这四个值在同一条 WS 消息里也有（`{sym}@markPrice@1s` 的 `p` / `i` / `r` / `T`），
 * 正常走那边；这里是**上游 WS 哑了之后的兜底**（见 `data/kline-stream.ts` 的标记价兜底）。
 */
export interface PremiumIndex {
  /** 标记价格 `p` */
  markPrice: number
  /** 指数价格 `i` */
  indexPrice: number | null
  /** 当期资金费率 `r` */
  fundingRate: number | null
  /** 下次资金费用时间（毫秒）`T` */
  nextFundingTime: number | null
}

/** 全市场标记价 / 指数价 / 资金费率（一次调用，`/fapi/v1/premiumIndex` 不带参数）。 */
export async function fetchPremiumIndex(opts?: {
  exchangeId?: string
  apiBase?: string
}): Promise<Map<string, PremiumIndex>> {
  const exchange = await getExchange(
    opts?.exchangeId ?? 'binance',
    'swap',
    opts?.apiBase
  )
  /* ccxt 的隐式方法：binance 上就是 `/fapi/v1/premiumIndex`（不带参数 = 全市场） */
  const list: any[] = (await exchange.fapiPublicGetPremiumIndex()) ?? []
  const out = new Map<string, PremiumIndex>()
  for (const r of list) {
    const sym = String(r?.symbol ?? '').toUpperCase()
    const mark = numOrNull(r?.markPrice)
    if (!sym || mark === null) continue
    const next = numOrNull(r?.nextFundingTime)
    out.set(sym, {
      markPrice: mark,
      indexPrice: numOrNull(r?.indexPrice),
      fundingRate: numOrNull(r?.lastFundingRate),
      nextFundingTime: next !== null && next > 0 ? next : null
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 合约发现（生命周期）：原始 exchangeInfo + diff                        */
/* ------------------------------------------------------------------ */

/** 币安原始 `exchangeInfo` 里我们关心的一行（**保留所有 status**，生命周期要用） */
export interface RawContract {
  /** 交易所原始符号（`BTCUSDT`） */
  pair: string
  /** ccxt 统一符号（`BTC/USDT:USDT`）—— 跟库里 `candles.symbol` 同一把钥匙 */
  symbol: string
  base: string
  /** `TRADING` / `PENDING_TRADING` / `SETTLING` / `CLOSE` … */
  status: string
  /** 上线时间（毫秒）；拿不到就是 null */
  onboardAt: number | null
}

/**
 * 拉**原始** `exchangeInfo`（U 本位永续 + USDT 结算，**不过滤 status**）。
 *
 * 为什么不复用现有的两条路：
 *  · `contracts.ts` 那条是**裸 fetch**（本地要过代理，直连不通）；这里走 ccxt 实例，
 *    跟其它所有调用共用同一套代理配置 ⇒ 本地和线上行为一致。实测确认 `applyApiBase`
 *    只换掉了**现货**那套 origin，`fapi.binance.com` 保持原样，所以本地也能通。
 *  · `listPerpetualSymbols`（ccxt `markets`）把 `status` 压成了一个 `active` 布尔，
 *    **并且丢掉 `onboardDate`** —— 而"这币什么时候上线的"正是生命周期要的。
 *
 * 权重 1（实测响应头 `x-mbx-used-weight-1m: 1`），体约 1.1 MB。
 */
export async function fetchExchangeInfoRaw(opts: {
  exchangeId: string
  apiBase?: string
}): Promise<RawContract[]> {
  const exchange = await getExchange(opts.exchangeId, 'swap', opts.apiBase)
  /* ccxt 的隐式方法：binance 上就是 `/fapi/v1/exchangeInfo` */
  const raw = (await exchange.fapiPublicGetExchangeInfo()) as {
    symbols?: Array<Record<string, unknown>>
  }
  const out: RawContract[] = []
  for (const s of raw?.symbols ?? []) {
    if (String(s.contractType ?? '').toUpperCase() !== 'PERPETUAL') continue
    if (String(s.quoteAsset ?? '').toUpperCase() !== 'USDT') continue
    if (String(s.marginAsset ?? '').toUpperCase() !== 'USDT') continue
    const base = String(s.baseAsset ?? '')
    const pair = String(s.symbol ?? '')
    if (!base || !pair) continue
    const onboard = Number(s.onboardDate)
    out.push({
      pair,
      symbol: `${base}/USDT:USDT`,
      base,
      status: String(s.status ?? ''),
      onboardAt: Number.isFinite(onboard) && onboard > 0 ? onboard : null
    })
  }
  return out
}

/**
 * 合约清单 diff（**纯函数**，离线可测）：谁该加进来、谁该摘掉。
 *
 *  · 加：原始清单里 `status === 'TRADING'` 且我们没订阅；
 *  · 摘：我们订阅了，但原始清单里**没有它**、或者它的 `status` 不再是 `TRADING`。
 *
 * ⚠️ 这里只判定**不动作** —— 摘除是有代价的（要先用交易所口径把最后一段补完，
 *    见 `kline-recorder.ts` 的 `dropSymbol`），加进来也要考虑订阅配额。
 */
export function planContractChanges(
  raw: RawContract[],
  subscribed: Array<{pair: string}>
): {add: RawContract[]; drop: Array<{pair: string}>} {
  const have = new Set(subscribed.map(s => s.pair.toUpperCase()))
  const seen = new Map<string, RawContract>()
  for (const r of raw) seen.set(r.pair.toUpperCase(), r)
  const add: RawContract[] = []
  for (const r of raw) {
    if (r.status === 'TRADING' && !have.has(r.pair.toUpperCase())) add.push(r)
  }
  const drop: Array<{pair: string}> = []
  for (const s of subscribed) {
    const r = seen.get(s.pair.toUpperCase())
    if (!r || r.status !== 'TRADING') drop.push({pair: s.pair})
  }
  return {add, drop}
}
