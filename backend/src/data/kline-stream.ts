/**
 * 实时推送：**币安合约 WS → 我们的 SSE**。管两样东西：
 *
 *   1. K 线    `{sym}@kline_{tf}`      —— 按「币 + 周期」订阅，事件 `kline`
 *   2. 全市场行情 `!ticker@arr`          —— 一条流管所有币，事件 `ticker`（一批增量）
 *
 * 上游按币安文档那种「一条连接 + SUBSCRIBE 多条流」的用法：
 *
 *   → {"method":"SUBSCRIBE","params":["btcusdt@kline_1h"],"id":1}
 *   ← {"e":"kline","E":…,"s":"BTCUSDT","k":{"t":…,"o":…,"h":…,"l":…,"c":…,"v":…,"x":false}}
 *   ← [{"e":"24hrTicker","s":"BTCUSDT","c":"84371.8","P":"2.5","q":"…"}, …]
 *
 * ⚠️ **绝不能**一个「币 + 周期」开一条 WS —— 币安对连接数有硬限制
 * （每 3 分钟 300 个连接、5 条消息/秒、一条连接最多 1024 条流），
 * 用户来回切币很快就撞上。所以这里全局只维护**一条**上游，按流名 SUBSCRIBE / UNSUBSCRIBE。
 *（`!ticker@arr` 是「一条流管全市场」，不占那 1024 条的额度。）
 *
 * 为什么走后端中转而不是浏览器直连币安：
 *   · 客户端不一定连得上 `fstream.binance.com`（手机 / 国内网络），但一定连得上我们自己的域名
 *   · 上游只连一次，多开几个页面也只连一次
 *   · 前端只认 SSE（跟分析进度那套一模一样），不用再引 ws 库
 *
 * ⚠️ 上游收不到数据时**自动退回 REST 轮询**（看门狗 5 秒）：
 *    2026-10 踩过的坑，已修：
 *      ① 上游地址**必须带路由路径 `/market`** —— 2025 起 fstream 拆成
 *         `/public`（`@depth`/`@bookTicker`）、`/market`（`@kline`/`@aggTrade`/`@ticker`/`@markPrice`）、
 *         `/private`（用户数据）。不带路由的连接**能握手、也会回 SUBSCRIBE 回执，
 *         但只给 /public 数据，@kline 静默收不到**（实测无路由 9 秒 0 帧，加 /market 后 1.6 秒 4 帧）；
 *         旧的无路由地址 2026-04-23 下线。
 *      ② 本地网络**会**干扰 WS（2026-10-06 才查清，之前怀疑错了又反过来错了）：
 *         墙把 `fstream.binance.com` 解析到假 IP（31.13.94.7 / 108.160.167.165 这类），
 *         裸连能触发 `open` 但**零帧** —— 看着像「连上了没数据」。本地开发要经出口代理，
 *         见 `scripts/dev-proxy.sh` 与 `exchange-account.ts` 的 `wsAgent()`。
 *         上面 ① 那条路由问题是真的，两者是两回事，别混。
 *    兜底留着当保险（断网/被限流时不至于卡住），对客户端来说两条路都是「后端推过来的」。
 *    （想单测 WS 那条路：`BINANCE_WS_BASE=ws://127.0.0.1:8765` 指到自己的假上游即可。）
 */
import {WebSocket} from 'ws'
import {wsAgent} from './exchange-account'
import {fetchCandles, fetchMarketList, type MarketRow} from './market'
import {loadConfig} from '../config'
import {Candle, Timeframe} from '../types'

/** 上游多久没推这条流就认定不可用（K 线有变化就秒级推，5 秒足够） */
const WS_IDLE_MS = 5_000
/** 退回 REST 之后的轮询间隔 */
const REST_MS = 3_000
/** 没人听了再等一会儿才退订 / 关连接（切 tab、刷新页面不用重连） */
const IDLE_CLOSE_MS = 30_000
/** 上游断了重连的退避上限 */
const RECONNECT_MAX_MS = 15_000

type Listener = (candle: Candle) => void

interface Channel {
  /** 流名：`btcusdt@kline_1h` */
  key: string
  /** 界面币种（BTC） */
  symbol: string
  timeframe: Timeframe
  listeners: Set<Listener>
  /** 当前靠什么拿数据 */
  mode: 'ws' | 'rest'
  restTimer: ReturnType<typeof setInterval> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  /** 上游最后一次推这条流的时间（用来判「连上了但没数据」） */
  lastMsgAt: number
  watchdog: ReturnType<typeof setTimeout> | null
  /** REST 兜底拉数中，防重入 */
  busy: boolean
}

const channels = new Map<string, Channel>()

/* ---------------- 上游：一条连接管所有流 ---------------- */

/**
 * 上游 WS 地址。
 *
 * ⚠️ 路径里的 **`/market` 不能省**（见文件头注释）：不带路由的连接能握手、也有 SUBSCRIBE 回执，
 * 但只收得到 `/public` 的数据，`@kline` 会**静默收不到**。
 * `BINANCE_WS_BASE` 只换 host（自建转发 / 假上游用）。
 */
function wsUrl(): string {
  const base = process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com'
  return `${base.replace(/\/$/, '')}/market/ws`
}

let ws: WebSocket | null = null
/** 想订阅的流（含还没发出去的） */
const wanted = new Set<string>()
/** 已经 SUBSCRIBE 过的流 */
const acked = new Set<string>()
let seq = 1
let retry = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function send(msg: unknown): void {
  try {
    ws?.send(JSON.stringify(msg))
  } catch {
    /* 连接刚好断了，onclose 会收尾 */
  }
}

/** 把「想要的」和「已订的」对齐（连上、有增减时都调） */
function flushSubscriptions(): void {
  if (!ws || ws.readyState !== 1) return
  const toSub = [...wanted].filter(s => !acked.has(s))
  if (toSub.length) {
    send({method: 'SUBSCRIBE', params: toSub, id: seq++})
    for (const s of toSub) acked.add(s)
  }
  const toUn = [...acked].filter(s => !wanted.has(s))
  if (toUn.length) {
    send({method: 'UNSUBSCRIBE', params: toUn, id: seq++})
    for (const s of toUn) acked.delete(s)
  }
}

/** 还有没有流指望 WS（含全市场行情那条） */
function anyWantWs(): boolean {
  for (const ch of channels.values()) if (ch.mode === 'ws') return true
  return tickerMode === 'ws'
}

function closeUpstream(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  try {
    ws?.close()
  } catch {
    /* 忽略 */
  }
  ws = null
  acked.clear()
}

/** 上游断开：还有流想要就连回来（退避），连回来后 flushSubscriptions 会补订阅 */
function scheduleReconnect(): void {
  if (reconnectTimer || !anyWantWs()) return
  const wait = Math.min(1000 * 2 ** retry, RECONNECT_MAX_MS)
  retry++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void ensureUpstream()
  }, wait)
}

async function ensureUpstream(): Promise<void> {
  if (!wanted.size) return
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    flushSubscriptions()
    return
  }
  const url = wsUrl()
  let sock: WebSocket
  try {
    // 本地开发要经代理才连得上（见 `exchange-account.ts` 的 `wsAgent()`）
    sock = new WebSocket(url, {agent: await wsAgent()})
  } catch (e) {
    console.warn(`[kline] 上游 WS 建不起来：${(e as Error).message}`)
    degradeAll()
    return
  }
  ws = sock

  sock.onopen = () => {
    retry = 0
    console.info(`[kline] 上游 WS 已连 ${url}（要订 ${wanted.size} 条流）`)
    flushSubscriptions()
  }
  sock.onmessage = ev => onUpstreamMessage(ev)
  sock.onerror = () => {
    /* 具体原因拿不到，交给 onclose 收尾 */
  }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    acked.clear()
    if (anyWantWs()) {
      console.warn('[kline] 上游 WS 断开，准备重连')
      scheduleReconnect()
    }
  }
}

/** 上游推来的东西：订阅回执，或某条流的 K 线（`ws` 给的 `data` 可能是 string 也可能 Buffer） */
function onUpstreamMessage(ev: {data: string | Buffer | ArrayBuffer | Buffer[]}): void {
  let msg: any
  try {
    msg = JSON.parse(String(ev.data))
  } catch {
    return
  }
  // 组合流是 {stream, data}；单流 / SUBSCRIBE 回执另说
  const body = msg?.data ?? msg
  // 订阅回执 {result: null, id: n} —— 不用管
  if (body?.result !== undefined) return
  /*
   * 全市场行情（`!ticker@arr`）推的是**数组**：一个批次里只有这 1 秒里变过的币
   * （实测 1 秒一批、每批两三百个币）。它跟 K 线共用同一条上游连接。
   */
  if (Array.isArray(body)) {
    handleTickerBatch(body)
    return
  }
  if (body?.e !== 'kline' || !body.k) return

  const sym = String(body.s ?? body.k.s ?? '').toLowerCase()
  const iv = String(body.k.i ?? '')
  const ch = channels.get(`${sym}@kline_${iv}`)
  if (!ch) return

  ch.lastMsgAt = Date.now()
  if (ch.watchdog) {
    clearTimeout(ch.watchdog)
    ch.watchdog = null
  }
  // 这条已经退回 REST 了就别再走 WS（两条路一起推会打架）
  if (ch.mode === 'rest') return

  const candle = candleOf(body.k)
  if (candle) broadcast(ch, candle)
}

/* ---------------- 工具 ---------------- */

/**
 * `BTC` + `1h` → 流名 `btcusdt@kline_1h`。
 *
 * ⚠️ 币安的流名**全小写**（`BTCUSDT@kline_1h` 订不上），
 * 而且名字是「基础币 + 计价币」，所以传进来的 `BTC/USDT` 这种要去掉计价币再加 `usdt`。
 */
function streamName(symbol: string, timeframe: Timeframe): string {
  const base = symbol
    .trim()
    .toUpperCase()
    .replace(/[:/\-\s]/g, '')
    .replace(/USDT$/, '')
    .toLowerCase()
  return `${base}usdt@kline_${timeframe}`
}

/** 上游推的一根（币安 kline 事件的字段） */
function candleOf(k: Record<string, unknown>): Candle | null {
  const timestamp = Number(k.t)
  const open = Number(k.o)
  const high = Number(k.h)
  const low = Number(k.l)
  const close = Number(k.c)
  const volume = Number(k.v)
  if (![timestamp, open, high, low, close].every(Number.isFinite)) return null
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0
  }
}

function broadcast(ch: Channel, candle: Candle): void {
  for (const fn of ch.listeners) {
    try {
      fn(candle)
    } catch {
      /* 单个订阅者出错不能影响别人 */
    }
  }
}

/* ---------------- REST 兜底 ---------------- */

/** 退回 REST：把最后两根拉回来推给订阅者（原来前端那套轮询，挪到后端） */
function startRestFallback(ch: Channel): void {
  if (ch.mode === 'rest') return
  ch.mode = 'rest'
  if (ch.watchdog) {
    clearTimeout(ch.watchdog)
    ch.watchdog = null
  }
  wanted.delete(ch.key)
  flushSubscriptions()
  console.warn(
    `[kline] ${ch.key} 上游 ${WS_IDLE_MS / 1000} 秒没推数据，退回 REST 轮询（每 ${
      REST_MS / 1000
    }s）`
  )

  const tick = async () => {
    if (ch.busy || !ch.listeners.size) return
    ch.busy = true
    try {
      const config = loadConfig()
      // ⚠️ 这个 `fetchCandles` 直接返回 Candle[] —— 包成 `{candles, sr}` 是 HTTP 层的事
      const list = await fetchCandles({
        exchangeId: config.exchange,
        symbol: ch.symbol,
        timeframe: ch.timeframe,
        limit: 2,
        marketType: config.marketType,
        apiBase: config.apiBase
      })
      if (list.length) broadcast(ch, list[list.length - 1])
    } catch (e) {
      // ⚠️ 别静默吞：这条兜底路挂了的话，前端就是「一直不动」，很难查
      console.warn(`[kline] ${ch.key} REST 兜底失败：${(e as Error).message}`)
    } finally {
      ch.busy = false
    }
  }

  void tick()
  ch.restTimer = setInterval(() => void tick(), REST_MS)

  // 所有流都不指望 WS 了，就把上游连接关掉，别白占着
  if (!anyWantWs()) closeUpstream()
}

/** 上游整体不可用（连接都建不起来）时，把所有流退回 REST */
function degradeAll(): void {
  for (const ch of channels.values()) {
    if (ch.mode === 'ws') startRestFallback(ch)
  }
  if (tickerMode === 'ws') startTickerRest()
}

/* ---------------- 订阅入口 ---------------- */

function closeChannel(ch: Channel): void {
  if (ch.restTimer) clearInterval(ch.restTimer)
  ch.restTimer = null
  if (ch.idleTimer) clearTimeout(ch.idleTimer)
  ch.idleTimer = null
  if (ch.watchdog) clearTimeout(ch.watchdog)
  ch.watchdog = null
  channels.delete(ch.key)
  wanted.delete(ch.key)
  flushSubscriptions()
  if (!anyWantWs()) closeUpstream()
}

/**
 * 订阅某个币 + 周期的 K 线。
 *
 * 返回一个取消函数；**最后一个订阅者走了 30 秒**才退订（切 tab / 刷新不用重订）。
 */
export function subscribeKline(
  symbol: string,
  timeframe: Timeframe,
  listener: Listener
): () => void {
  const key = streamName(symbol, timeframe)
  let ch = channels.get(key)
  if (!ch) {
    ch = {
      key,
      symbol: symbol.trim().toUpperCase(),
      timeframe,
      listeners: new Set(),
      mode: 'ws',
      restTimer: null,
      idleTimer: null,
      lastMsgAt: 0,
      watchdog: null,
      busy: false
    }
    channels.set(key, ch)
    wanted.add(key)
    console.info(`[kline] ${key} 订阅（上游一条连接共用）`)
    // 连上了但一直不推数据 → 当不可用，退回 REST。
    // （最常见的真因是上游地址少了 `/market` 路由 —— 能握手、有回执、但零帧，见文件头注释）
    ch.watchdog = setTimeout(() => {
      if (ch && ch.mode === 'ws' && !ch.lastMsgAt) startRestFallback(ch)
    }, WS_IDLE_MS)
    void ensureUpstream()
  }
  if (ch.idleTimer) {
    clearTimeout(ch.idleTimer)
    ch.idleTimer = null
  }
  ch.listeners.add(listener)

  return () => {
    ch?.listeners.delete(listener)
    if (!ch || ch.listeners.size) return
    // 留个缓冲：切 tab / 刷新页面马上又回来时不用重订
    ch.idleTimer = setTimeout(() => {
      if (ch && !ch.listeners.size) closeChannel(ch)
    }, IDLE_CLOSE_MS)
  }
}

/** 当前有几条流（调试 / 健康检查用） */
export function klineChannelCount(): number {
  return channels.size
}

/* ---------------- 全市场行情（`!ticker@arr`） ---------------- */

/**
 * 一条行情增量。字段名跟币安 ticker 事件对齐，但**值都转成数字了**
 * （币安推的全是字符串，转好再往下走，前端少一堆 `Number()`）。
 *
 * 只带会变的那几个：最新价 / 24h 涨跌 / 24h 高低 / 24h 量额。
 * 币种名（`base`）不动，前端拿 `pair` 去合并。
 */
export interface TickerPatch {
  /** 交易所原始交易对（BTCUSDT） */
  pair: string
  last: number
  change24hPct: number
  high24h: number
  low24h: number
  volume24h: number
  quoteVolume24h: number
}

type TickerListener = (patches: TickerPatch[]) => void

/**
 * 全市场行情那一条流（`/market` 路由下，1 秒一批）。
 * ⚠️ 跟 K 线不同，它**不需要按币订阅** —— 一条流管全市场，所以不占「1024 条流」的额度。
 */
const TICKER_STREAM = '!ticker@arr'
/** 上游这么久没推行情就当 WS 不可用（正常 1 秒一批） */
const TICKER_IDLE_MS = 5_000
/** 退回 REST 后的轮询间隔（整表 ~100KB，比 K 线那档慢） */
const TICKER_REST_MS = 5_000
/** 没人听了再等一会儿才退订 */
const TICKER_IDLE_CLOSE_MS = 30_000

const tickerListeners = new Set<TickerListener>()
/** off = 没订阅 / ws = 走上游推送 / rest = 已退回轮询 */
let tickerMode: 'off' | 'ws' | 'rest' = 'off'
let tickerLastMsgAt = 0
let tickerWatchdog: ReturnType<typeof setTimeout> | null = null
let tickerIdleTimer: ReturnType<typeof setTimeout> | null = null
let tickerRestTimer: ReturnType<typeof setInterval> | null = null
let tickerBusy = false

function emitTicker(patches: TickerPatch[]): void {
  for (const fn of tickerListeners) {
    try {
      fn(patches)
    } catch {
      /* 单个订阅者出错不能影响别人 */
    }
  }
}

/** 上游推来的一批行情 → 转成我们那套字段 */
function handleTickerBatch(arr: unknown[]): void {
  if (tickerMode !== 'ws' || !tickerListeners.size) return
  tickerLastMsgAt = Date.now()
  if (tickerWatchdog) {
    clearTimeout(tickerWatchdog)
    tickerWatchdog = null
  }
  const patches: TickerPatch[] = []
  for (const raw of arr) {
    const p = patchOf(raw as Record<string, unknown>)
    if (p) patches.push(p)
  }
  if (patches.length) emitTicker(patches)
}

/** 币安 ticker 事件 → 我们要的那几个数（全是字符串，得转） */
function patchOf(t: Record<string, unknown>): TickerPatch | null {
  const pair = String(t?.s ?? '').toUpperCase()
  if (!pair) return null
  const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return {
    pair,
    last: num(t.c),
    change24hPct: num(t.P),
    high24h: num(t.h),
    low24h: num(t.l),
    // v 是按币算的成交量，q 是按计价币算的成交额（U 本位就是 USDT）
    volume24h: num(t.v),
    quoteVolume24h: num(t.q)
  }
}

/** REST 那一路的一行 → 增量（只走兜底时用） */
function rowToPatch(r: MarketRow): TickerPatch {
  return {
    pair: r.pair.toUpperCase(),
    last: r.last ?? 0,
    change24hPct: r.change24hPct ?? 0,
    high24h: r.high24h ?? 0,
    low24h: r.low24h ?? 0,
    volume24h: r.volume24h ?? 0,
    quoteVolume24h: r.quoteVolume24h ?? 0
  }
}

/** 开始指望 WS（订阅这条流） */
function ensureTickerWs(): void {
  if (tickerMode === 'ws' || tickerMode === 'rest') return
  tickerMode = 'ws'
  tickerLastMsgAt = 0
  wanted.add(TICKER_STREAM)
  console.info(`[kline] ${TICKER_STREAM} 订阅（全市场行情，上游一条连接共用）`)
  tickerWatchdog = setTimeout(() => {
    if (tickerMode === 'ws' && !tickerLastMsgAt) startTickerRest()
  }, TICKER_IDLE_MS)
  void ensureUpstream()
}

/** 退回 REST：整表当一批增量推下去（前端按 pair 合并，顺带能捡到上新币） */
function startTickerRest(): void {
  if (tickerMode === 'rest') return
  tickerMode = 'rest'
  if (tickerWatchdog) {
    clearTimeout(tickerWatchdog)
    tickerWatchdog = null
  }
  wanted.delete(TICKER_STREAM)
  flushSubscriptions()
  console.warn(
    `[kline] ${TICKER_STREAM} 上游 ${TICKER_IDLE_MS / 1000} 秒没推数据，退回 REST 轮询（每 ${
      TICKER_REST_MS / 1000
    }s）`
  )

  const tick = async () => {
    if (tickerBusy || !tickerListeners.size) return
    tickerBusy = true
    try {
      const config = loadConfig()
      const rows = await fetchMarketList({
        exchangeId: config.exchange,
        marketType: config.marketType,
        apiBase: config.apiBase
      })
      if (rows.length) emitTicker(rows.map(rowToPatch))
    } catch (e) {
      // ⚠️ 别静默吞：兜底路挂了的话前端就是「一直不动」，很难查
      console.warn(
        `[kline] ${TICKER_STREAM} REST 兜底失败：${(e as Error).message}`
      )
    } finally {
      tickerBusy = false
    }
  }

  void tick()
  tickerRestTimer = setInterval(() => void tick(), TICKER_REST_MS)

  // 所有流都不指望 WS 了，就把上游连接关掉，别白占着
  if (!anyWantWs()) closeUpstream()
}

/** 彻底退订这条流（没人听的时候） */
function closeTicker(): void {
  if (tickerRestTimer) clearInterval(tickerRestTimer)
  tickerRestTimer = null
  if (tickerWatchdog) clearTimeout(tickerWatchdog)
  tickerWatchdog = null
  if (tickerIdleTimer) clearTimeout(tickerIdleTimer)
  tickerIdleTimer = null
  tickerMode = 'off'
  wanted.delete(TICKER_STREAM)
  flushSubscriptions()
  if (!anyWantWs()) closeUpstream()
  console.info('[kline] 全市场行情没人听了，退订')
}

/**
 * 订阅**全市场行情**（一条流管所有币）。
 *
 * 推来的每批只包含「刚变过」的币，所以**必须先拿一份底稿**
 * （前端的做法：`GET /api/markets` 拉一次全表，再拿增量往里盖）。
 *
 * 返回取消函数；最后一个订阅者走了 30 秒才退订。
 */
export function subscribeTickers(listener: TickerListener): () => void {
  const first = tickerListeners.size === 0
  tickerListeners.add(listener)
  if (tickerIdleTimer) {
    clearTimeout(tickerIdleTimer)
    tickerIdleTimer = null
  }
  if (first) ensureTickerWs()

  return () => {
    tickerListeners.delete(listener)
    if (tickerListeners.size) return
    // 留个缓冲：切 tab / 刷新页面马上又回来时不用重订
    tickerIdleTimer = setTimeout(() => {
      if (!tickerListeners.size) closeTicker()
    }, TICKER_IDLE_CLOSE_MS)
  }
}

/** 现在全市场行情还指望 WS 吗（调试用） */
export function tickerStreamMode(): string {
  return tickerMode
}
