/**
 * 头部行情（K 线块顶部那条 + 底部涨幅行）。
 *
 * 全局一份：顶部信息和底部涨幅是同一个数据源，别各拉各的。
 *
 * ★ 2026-10-06（用户：「前端 ticker 那条 15 秒 REST 换成 SSE 推送」）：
 *   **价格 / 24h 涨跌 / 高低 / 成交量**改成吃 SSE `/api/tickers/stream` 的增量
 *   （后端从币安 `!ticker@arr` 中转，**每秒一批**）—— 这一条流**不打交易所、不计权重**。
 *   剩下的字段（**资金费率、持仓量、指数价、各窗口涨跌**）流里没有，
 *   仍然靠 `/api/ticker`，但节奏从 15 秒放宽到 `SLOW_MS`（60 秒，它们本来就变得慢：
 *   资金费 8 小时才结一次、持仓量 5 分钟级）。
 *
 *   ⇒ 稳态下这一项从「每 15 秒一次 REST」变成「一分钟一次 + 一条零成本的长连接」。
 */
import {computed, ref} from 'vue'
import {
  fetchTicker,
  tickerStream,
  type TickerInfo,
  type TickerPatch
} from './api'

export const ticker = ref<TickerInfo | null>(null)
export const tickerError = ref('')

/** 秒级「现在」——倒计时要按秒跳 */
export const nowTick = ref(Date.now())

/*
 * ★ 实时价（2026-10-03，用户：「价格颜色跟随当前行情变化闪动」）。
 *
 * 行情本体是 **15 秒**一刷，靠它闪动太砋了。开单页里本来就有一条
 * K 线 WS（`/api/kline/stream`），推的最后一根收盘价就是现价、而且秒级 ——
 * 所以 `KlineChart.applyTail()` 每收到一帧就叫一下 `setLivePrice()`，
 * 头部直接用它。
 *
 * ⚠️ 两个坑：
 *   ① 只认**当前这只币**的价（切了币，旧币的帧还在路上，不能让它写进来）；
 *   ② 有时效：测试 / 回看 / 切后台时那条流是断的，值会“冻”住 ——
 *      超过 `LIVE_TTL` 就自动退回 15 秒那份，不会一直顶着一个不动的价。
 */
export const livePrice = ref<number | null>(null)
/** 实时价是什么时候写进来的 */
export const livePriceAt = ref(0)
const LIVE_TTL = 20_000

/** 当前是否有一只新鲜的实时价（没就用 15 秒那份） */
export const freshLivePrice = computed<number | null>(() => {
  const t = nowTick.value
  return t - livePriceAt.value < LIVE_TTL ? livePrice.value : null
})

/** 给 K 线那边调的：报一个实时价过来 */
export function setLivePrice(sym: string, v: number): void {
  const s = (sym ?? '').trim().toUpperCase()
  if (!s || s !== symbol || !Number.isFinite(v)) return
  livePrice.value = v
  livePriceAt.value = Date.now()
}

/**
 * REST 底稿的刷新节奏（见文件头说明）。
 *
 * ⚠️ 只兜「流里没有」的那几项（资金费率 / 持仓量 / 指数价 / 各窗口涨跌），
 *    价格那些已经是 SSE 1 秒级了 —— 所以别再按 15 秒打。
 */
const SLOW_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null
let clock: ReturnType<typeof setInterval> | null = null
/** 全市场增量的订阅（全市场一条流管所有币，换币不用重连，只是筛的币变了） */
let stopStream: (() => void) | null = null
/** 当前盯着的币（换币就整个重来） */
let symbol = ''
/**
 * 正在拉的币。
 *
 * ⚠️ 以前是个共享的 `busy` 布尔：BTC → ETH 切得快时，ETH 那次会被「忙」挡掉，
 * 而 BTC 的结果照样写进去 —— 头上就顶着**上一个币的价格**（要等下个 15 秒才纠正）。
 * 现在按币判：同一个币才防堆叠，换了币就放行，旧结果由序号丢掉。
 */
let busySymbol = ''
/** 请求序号：换币后兜回来的旧数据直接作废 */
let loadSeq = 0

async function load(): Promise<void> {
  const s = symbol
  if (!s || busySymbol === s) return
  busySymbol = s
  const seq = ++loadSeq
  try {
    const info = await fetchTicker(s)
    // 半路换币 / 已经有更新的结果了 → 这份作废
    if (seq !== loadSeq || s !== symbol) return
    ticker.value = info
    tickerError.value = ''
  } catch (e) {
    if (seq === loadSeq && s === symbol)
      tickerError.value = (e as Error).message || '取不到行情'
  } finally {
    if (busySymbol === s) busySymbol = ''
  }
}

/**
 * 把全市场增量里属于**当前这只币**的那几条盖到头上（1 秒级，零权重）。
 *
 * ⚠️ `pair` 是币安原始交易对（`BTCUSDT`），跟 `TickerInfo.pair` 一个口径；
 *    找不到这只币就什么都不做（上游一批只有刚变过的两三百个币）。
 */
function applyTickerBatch(updates: TickerPatch[]): void {
  const cur = ticker.value
  if (!cur || !symbol || !cur.pair) return
  const p = updates.find(u => u.pair === cur.pair)
  if (!p) return
  ticker.value = {
    ...cur,
    last: p.last ?? cur.last,
    change24hPct: p.change24hPct ?? cur.change24hPct,
    high24h: p.high24h ?? cur.high24h,
    low24h: p.low24h ?? cur.low24h,
    volume24h: p.volume24h ?? cur.volume24h,
    quoteVolume24h: p.quoteVolume24h ?? cur.quoteVolume24h,
    updatedAt: Date.now()
  }
}

/**
 * 跟着币种走：换币立刻拉一次底稿；之后
 *   · 价格类 → 吃 SSE 增量（秒级）；
 *   · 资金费率 / 持仓量那些 → `SLOW_MS` 一次 REST。
 *
 * 同一个币重复调用不会重开定时器（否则每切一次 tab 就多一个）。
 */
export function watchTicker(next: string): void {
  const s = (next ?? '').trim().toUpperCase()
  if (s === symbol) return
  symbol = s
  // 先把旧的清掉：宁可这一瞬间是「—」，也别顶着上一个币的价格
  ticker.value = null
  tickerError.value = ''
  // 实时价同理：换币了，旧币那个价一秒都不能留
  livePrice.value = null
  livePriceAt.value = 0
  if (timer) clearInterval(timer)
  timer = null
  if (!s) {
    stopTickerStream()
    return
  }
  void load()
  timer = setInterval(() => void load(), SLOW_MS)
  /* 全市场增量（换币不用重连：这条流管所有币，只是筛的那只变了） */
  if (!stopStream)
    stopStream = tickerStream(applyTickerBatch, () => void load())
  if (!clock) clock = setInterval(() => (nowTick.value = Date.now()), 1000)
}

function stopTickerStream(): void {
  stopStream?.()
  stopStream = null
}

/** 离开分析页就停掉，别在后台一直打交易所 / 挂着连接 */
export function stopTicker(): void {
  symbol = ''
  if (timer) clearInterval(timer)
  if (clock) clearInterval(clock)
  timer = null
  clock = null
  stopTickerStream()
}
