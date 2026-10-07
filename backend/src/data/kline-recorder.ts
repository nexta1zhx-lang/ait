/**
 * ★ K 线底座（常驻）：**一条上游 WS 订全市场 1m**，收盘就地落库 + 滚出高周期。
 *
 * 为什么要有它（用户 2026-10-07：「不需要预热那一套…改为实时的，存储 7 天 1 分钟的」）：
 *   以前「点开哪个币都能立刻画」靠三套补丁 —— 启动预热 120 币、`kline-store` 每 10 秒
 *   REST 保活、跨热线那一刻**阻塞等上游**（注释里记过实测 13 秒）；而且缓存**纯内存不落库**，
 *   重启全丢 ⇒ 冷启动必然回到 REST。
 *   现在：1m 推送流常驻（**0 权重**）→ 收盘落库 → 高周期由 1m 滚出来。
 *   P1 会把那三套补丁整块删掉（本文件是它们的替代品，不要两边并存）。
 *
 * 三条硬约束（都是实测踩出来的，别凭直觉改）：
 *   ① 币安**没有 K 线的聚合流**：`!kline_1m@arr` 回 `{"result":null}`、0 帧 0 字节
 *      （静默无效，连报错都不给）⇒ 只能 per-symbol 订：525 个币 = 525 条流。
 *   ② 一条连接最多 **1024 条流**：1050 条会被 `{"code":4,"msg":"Too many subscriptions"}`
 *      加 `1008 Invalid request` 直接关连接（实测 0 帧）⇒ 这里只订 1m + ticker。
 *      4h/1d 直订实测要多 2 条连接 + 897 帧/秒 + 278 KB/s，只为买「漏分钟保险」——不值，
 *      所以高周期一律 rollup（口径靠每日对账兜，见 docs/EXCHANGE.md）。
 *   ③ 覆盖度**不能靠回执验**：成功回执是 `{"result":null}`（不列流名），流名写错也是静默的
 *      ⇒ 只认「这个币有没有收到过帧」（`stats.covered`）。
 *
 * 内存：只留「每个币 × 每个高周期一个累加器」⇒ 525 × 6 个小对象 ≈ 1 MB，
 *   不需要热层缓存（这台机器宿主只有 909 MB，见压测记录）。
 *
 * 常态权重 0；只有「补缺口 / 灌历史」打 REST，都走 `paced()` 限速。
 */
import {WebSocket} from 'ws'
import {wsAgent} from './exchange-account'
import {loadConfig} from '../config'
import {fetchCandlesRange, listPerpetualSymbols, type PerpSymbol} from './market'
import {
  HIGH_INTERVALS,
  maxOpenTimes,
  pruneCandles,
  rollupFrom1m,
  saveCandles,
  type HighInterval,
  type KlineInterval,
  type NewCandleRow
} from '../db/candle-store'
import {RateBudgetError, takeWeight} from '../util/rate-budget'
import type {MarketType, Timeframe} from '../types'

const MIN_MS = 60_000
const MS: Record<KlineInterval, number> = {
  '1m': MIN_MS,
  '5m': 5 * MIN_MS,
  '15m': 15 * MIN_MS,
  '1h': 60 * MIN_MS,
  '4h': 240 * MIN_MS,
  '1d': 1440 * MIN_MS
}

/** 一次 SUBSCRIBE 发多少条流（币安对**入站**消息有 10 条/秒的限制） */
const SUB_BATCH = 100
/** 攒多久写一次库（每分钟 525 行 1m + 100 多行 rollup，攒一下批量化） */
const FLUSH_MS = 4_000
/** 上游多久一帧都没有就认为这条连接废了（1m 流在交易的币上每秒都有帧） */
const WATCHDOG_MS = 3 * MIN_MS
/** 统计日志间隔 */
const STATS_MS = 5 * MIN_MS
/** 清理间隔（分级保留，见 db/candle-store.ts） */
const PRUNE_EVERY_MS = 6 * 60 * MIN_MS
/** 重连退避上限 */
const RECONNECT_MAX_MS = 15_000
/** 缓冲区上限：落库连续失败时别把内存吃光 */
const BUFFER_MAX = 6_000
/** 补缺口时单个币最多往前补这么久（首次启动不该把权重全花在历史上） */
const BACKFILL_MAX_MS = 240 * MIN_MS
/** 补缺口 / 灌历史的并发 */
const REPAIR_CONC = 2
/** 每发 REST 之间至少隔这么久（限速的第一道闸；第二道是 `takeWeight`） */
const PACE_MS = 400
/**
 * ⚠️ K 线一发（ccxt 每次要 1000 根）的**真实权重是 5**，不是 2。
 *    这里按 5 × 页数算 —— 少算一倍就会超预算、把出口 IP 打进 `-1003`
 *    （2026-10-07 实测：按 2 记时灌历史，一小时 85 次限流）。
 */
const KLINE_WEIGHT_PER_PAGE = 5
const klineWeight = (maxCandles: number): number =>
  KLINE_WEIGHT_PER_PAGE * Math.max(1, Math.ceil(maxCandles / 1000))
/** 灌历史的续跑间隔（限流被打断后不用等重启） */
const SEED_RETRY_MS = 20 * 60_000
/** 修复队列：多久扫一次、一次最多几个币、同一个币多久内不重复修 */
const REPAIR_TICK_MS = 60_000
const REPAIR_PER_TICK = 5
/** 积压时的每拍上限（重启后 525 个币都可能缺几分钟，5 个/拍要修两小时） */
const REPAIR_PER_TICK_BACKLOG = 15
const REPAIR_BACKLOG = 50
const REPAIR_COOLDOWN_MS = 10 * MIN_MS
/** 灌历史时每个周期取多少根（够画图 + 一次「加载更多」） */
const SEED_BARS: Record<HighInterval, number> = {
  '5m': 1000,
  '15m': 1000,
  '1h': 2000,
  '4h': 1000,
  '1d': 1000
}

interface Agg {
  bucket: number
  /**
   * 这个桶**没等齐**（开头那段没赶上 / 中间漏了分钟）。
   *
   * ⚠️ 这种桶**绝不能写库**：量、笔数会偏小，而 OHLC 里的 high/low 会漏掉最高那一下 ——
   *    而且它还会盖掉 seed / repair 灌进来的交易所口径（实测踩过：桶中间启动，
   *    5m 量 493 而 1m 求和 633）。所以只在**从桶第一分钟开始、且一分钟不缺**时才落库。
   */
  partial: boolean
  /** 下一根该来的 1m 开盘时间（对不上就是漏了分钟） */
  nextMs: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
  takerBuyVolume: number
}

interface SymState {
  sym: PerpSymbol
  /** 最后一个已收盘 1m 的开盘时间（用来算有没有漏分钟） */
  lastClosedMs: number
  /** 各高周期**当前正在累加**的那个桶 */
  aggs: Map<Timeframe, Agg>
  /** 最后一次收到帧的时刻（覆盖度只能这么验，见文件头 ③） */
  coveredAt: number
  /** 上次被排进修复队列的时刻 */
  repairedAt: number
}

interface Cfg {
  exchange: string
  marketType: MarketType
  apiBase?: string
}

let started = false
let stopped = false
let cfg: Cfg | null = null
let symbols: PerpSymbol[] = []
const states = new Map<string, SymState>()
let sock: WebSocket | null = null
let buffer: NewCandleRow[] = []
let flushing = false
let repairing = false
let retry = 0
let lastFrameAt = 0
let openSince = 0
const repairQueue = new Map<string, number>()
const timers: ReturnType<typeof setInterval>[] = []

const stats = {
  closedBars: 0,
  minuteGaps: 0,
  partialAggs: 0,
  rowsWritten: 0,
  rowFailures: 0,
  dropped: 0,
  repairedSymbols: 0,
  backfilled1m: 0,
  seeded: 0,
  seedLimited: 0,
  lastFlushAt: 0,
  lastRepairAt: 0,
  lastError: ''
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 限速：每发之间隔一下 + 按**真实权重**从全局预算里取（拿不到就等一下再试） */
async function paced<T>(tag: string, weight: number, fn: () => Promise<T>): Promise<T> {
  await sleep(PACE_MS)
  for (let attempt = 0; ; attempt++) {
    try {
      await takeWeight(weight, tag, 5_000)
      return await fn()
    } catch (e) {
      if (!(e instanceof RateBudgetError) || attempt >= 1) throw e
      await sleep(8_000)
    }
  }
}

function logStats(): void {
  const covered = [...states.values()].filter(s => s.coveredAt > 0).length
  const gap = lastFrameAt ? Math.round((Date.now() - lastFrameAt) / 1000) : -1
  console.log(
    `[kline] 底座：连接 ${sock?.readyState === 1 ? '在' : '断'}，覆盖 ${covered}/${symbols.length}，` +
      `收盘 ${stats.closedBars} 根，落库 ${stats.rowsWritten} 行，漏分钟 ${stats.minuteGaps}，` +
      `待修 ${repairQueue.size}，末帧 ${gap}s 前`
  )
}

/* ---------------- 上游连接 ---------------- */

function wsUrl(): string {
  const base = process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com'
  return `${base.replace(/\/$/, '')}/market/ws`
}

function send(msg: unknown): void {
  try {
    sock?.send(JSON.stringify(msg))
  } catch {
    /* 连接刚好断了，onclose 会收尾 */
  }
}

async function open(): Promise<void> {
  if (stopped) return
  const agent = await wsAgent()
  const ws = new WebSocket(wsUrl(), {agent})
  sock = ws
  ws.on('open', () => {
    retry = 0
    openSince = Date.now()
    lastFrameAt = Date.now()
    const streams = symbols.map(s => `${s.pair.toLowerCase()}@kline_1m`)
    for (let i = 0; i < streams.length; i += SUB_BATCH) {
      send({method: 'SUBSCRIBE', params: streams.slice(i, i + SUB_BATCH), id: i / SUB_BATCH + 1})
    }
    console.log(
      `[kline] 上游已连：${streams.length} 条流（${Math.ceil(streams.length / SUB_BATCH)} 批订阅）`
    )
    /* 重连之后一定先看缺口（断的那段时间一根都不会有） */
    void repairSweep('重连')
  })
  ws.on('message', (d: Buffer) => {
    lastFrameAt = Date.now()
    onMessage(d)
  })
  ws.on('error', (e: Error) => {
    stats.lastError = e.message
    console.warn(`[kline] 上游 WS 错误：${e.message.slice(0, 120)}`)
  })
  ws.on('close', (code: number, reason: Buffer) => {
    stats.lastError = `closed ${code}`
    console.warn(`[kline] 上游断开（${code} ${String(reason).slice(0, 60)}）`)
    retryLater()
  })
}

function retryLater(): void {
  if (stopped) return
  retry++
  const wait = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** Math.min(retry, 4))
  setTimeout(() => void open().catch(() => retryLater()), wait)
}

function checkWatchdog(): void {
  if (stopped || !lastFrameAt) return
  const idle = Date.now() - lastFrameAt
  if (idle < WATCHDOG_MS) return
  console.warn(`[kline] ${Math.round(idle / 1000)}s 一帧都没有 ⇒ 重连（半开连接自愈）`)
  lastFrameAt = Date.now()
  try {
    sock?.terminate()
  } catch {
    /* 已经死了 */
  }
}

/* ---------------- 收帧 → 收盘落库 + 滚高周期 ---------------- */

function onMessage(d: Buffer): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(d.toString()) as Record<string, unknown>
  } catch {
    return
  }
  if (msg.error) {
    console.warn(`[kline] 上游报错：${JSON.stringify(msg.error).slice(0, 140)}`)
    return
  }
  if (msg.e === 'kline') onKline(msg.k as Record<string, unknown>)
}

function onKline(k: Record<string, unknown>): void {
  const st = states.get(String(k.s ?? '').toUpperCase())
  if (!st || String(k.i) !== '1m') return
  st.coveredAt = Date.now()
  /* 未收盘那根只在内存里（读热层 P1 再谈），不落库：525 upsert/秒 换不到任何体验 */
  if (!k.x) return

  const openTime = Number(k.t)
  const bar = {
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v) || 0,
    quoteVolume: Number(k.q) || 0,
    trades: Number(k.n) || 0,
    takerBuyVolume: Number(k.V) || 0
  }
  if (![openTime, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) return

  if (st.lastClosedMs && openTime > st.lastClosedMs + MIN_MS) {
    /* 中间漏了分钟（上游抖 / 进程重启）⇒ 排进修复队列，别让它烂在库里 */
    stats.minuteGaps++
    queueRepair(st, st.lastClosedMs + MIN_MS)
  }
  st.lastClosedMs = openTime
  stats.closedBars++

  push({
    interval: '1m',
    openTime,
    ...bar,
    source: 'ws'
  }, st)
  rollup(st, openTime, bar)

  if (buffer.length > BUFFER_MAX) {
    stats.dropped += buffer.length - BUFFER_MAX
    buffer.splice(0, buffer.length - BUFFER_MAX)
  }
}

interface Bar {
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
  takerBuyVolume: number
}

function push(
  row: Omit<NewCandleRow, 'exchange' | 'marketType' | 'symbol' | 'pair'>,
  st: SymState
): void {
  if (!cfg) return
  buffer.push({
    exchange: cfg.exchange,
    marketType: cfg.marketType,
    symbol: st.sym.symbol,
    pair: st.sym.pair,
    ...row
  })
}

/**
 * 把刚收盘的这根 1m 并进各高周期的当前桶；桶满了就落库。
 *
 * ⚠️ **残桶绝不写**：换桶时如果上一个桶没等齐（启动时从桶中间开始记、或中间漏了分钟），
 *    写下去就是一条**量偏小**的假 K 线，而且会盖掉 seed/repair 灌进来的交易所口径。
 *    残桶靠两条路补：启动那次由 `seedHistory()` 的 REST 覆盖；
 *    运行中的漏分钟由 `onKline` 排进修复队列（`repairSymbol` 再问交易所）。
 */
function rollup(st: SymState, openTime: number, bar: Bar): void {
  for (const it of HIGH_INTERVALS) {
    const ms = MS[it]
    const bucket = Math.floor(openTime / ms) * ms
    let agg = st.aggs.get(it)
    if (!agg || agg.bucket !== bucket) {
      if (agg) {
        /* 上一个桶没等齐就换桶了 ⇒ 丢掉不写（见 Agg.partial 的说明） */
        if (!agg.partial) stats.partialAggs++
        st.aggs.delete(it)
      }
      st.aggs.set(it, {
        bucket,
        partial: openTime !== bucket,
        nextMs: openTime + MIN_MS,
        ...bar
      })
      continue
    }
    if (openTime !== agg.nextMs) agg.partial = true
    agg.nextMs = openTime + MIN_MS
    agg.high = Math.max(agg.high, bar.high)
    agg.low = Math.min(agg.low, bar.low)
    agg.close = bar.close
    agg.volume += bar.volume
    agg.quoteVolume += bar.quoteVolume
    agg.trades += bar.trades
    agg.takerBuyVolume += bar.takerBuyVolume
    if (agg.bucket + ms <= openTime + MIN_MS) {
      if (agg.partial) {
        /* 残桶：不写（见 Agg.partial 的说明），启动那一段由 seed 的 REST 数据兜底 */
        stats.partialAggs++
      } else {
        flushAgg(st, it, agg)
      }
      st.aggs.delete(it)
    }
  }
}

function flushAgg(st: SymState, interval: HighInterval, agg: Agg): void {
  push(
    {
      interval,
      openTime: agg.bucket,
      open: agg.open,
      high: agg.high,
      low: agg.low,
      close: agg.close,
      volume: agg.volume,
      quoteVolume: agg.quoteVolume,
      trades: agg.trades,
      takerBuyVolume: agg.takerBuyVolume,
      source: 'rollup'
    },
    st
  )
}

async function flush(): Promise<void> {
  if (flushing || !buffer.length) return
  flushing = true
  const rows = buffer.splice(0, buffer.length)
  try {
    stats.rowsWritten += await saveCandles(rows)
    stats.lastFlushAt = Date.now()
  } catch (e) {
    stats.rowFailures++
    stats.lastError = (e as Error).message
    console.warn(
      `[kline] 落库失败（${rows.length} 行留着下轮再写）：${(e as Error).message.slice(0, 120)}`
    )
    if (buffer.length + rows.length <= BUFFER_MAX) buffer.unshift(...rows)
    else stats.dropped += rows.length
  } finally {
    flushing = false
  }
}

/* ---------------- 补缺口 / 灌历史 / 修复 ---------------- */

function queueRepair(st: SymState, fromMs: number): void {
  if (Date.now() - st.repairedAt < REPAIR_COOLDOWN_MS) return
  const cur = repairQueue.get(st.sym.symbol)
  if (cur === undefined || fromMs < cur) repairQueue.set(st.sym.symbol, fromMs)
}

/**
 * 扫一遍「该修什么」：库里缺口 + 高周期历史不够的。
 *
 * 触发时机：启动、上游重连、之后每 60 秒扫一次修复队列。
 * 全部走 `paced()`，并发 `REPAIR_CONC` —— 525 个币同时补会把 IP 打进 `-1003`。
 */
async function repairSweep(reason: string): Promise<void> {
  if (repairing || stopped || !cfg) return
  repairing = true
  try {
    const stored = await maxOpenTimes(
      '1m',
      symbols.map(s => s.symbol)
    )
    const now = Date.now()
    let queued = 0
    for (const st of states.values()) {
      const last = stored.get(st.sym.symbol)
      if (!last) {
        /*
         * 库里一根 1m 都没有（第一次跑 / 刚清过库）：只补最近半小时。
         * 为什么要排而不是跳过：**跨启动那一刻的高周期桶**（比如今天那根 1d）
         * 是 seed 写的「启动时刻快照」，我们自己的 rollup 因为没从桶头开始会被判残而丢弃 ——
         * 不修的话它会一直错下去。`repairSymbol` 的第③步会用交易所口径把它盖回去。
         */
        queueRepair(st, now - 30 * MIN_MS)
        queued++
        continue
      }
      const newest = Math.max(last, st.lastClosedMs)
      if (now - newest <= 2 * MIN_MS) continue
      queueRepair(st, Math.max(newest + MIN_MS, now - BACKFILL_MAX_MS))
      queued++
    }
    if (queued) console.log(`[kline] ${reason}：发现 ${queued} 个币有缺口，排进修复队列`)
  } catch (e) {
    stats.lastError = (e as Error).message
    console.warn(`[kline] 缺口扫描失败：${(e as Error).message.slice(0, 120)}`)
  } finally {
    repairing = false
  }
}

async function repairTick(): Promise<void> {
  if (stopped || !cfg || repairing) return
  const perTick =
    repairQueue.size > REPAIR_BACKLOG ? REPAIR_PER_TICK_BACKLOG : REPAIR_PER_TICK
  const jobs: string[] = []
  for (const [symbol] of repairQueue) {
    if (jobs.length >= perTick) break
    jobs.push(symbol)
  }
  if (!jobs.length) return
  repairing = true
  try {
    let i = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const symbol = jobs[i++]
        if (!symbol || stopped) return
        const from = repairQueue.get(symbol)
        repairQueue.delete(symbol)
        const st = [...states.values()].find(s => s.sym.symbol === symbol)
        if (!st || from === undefined) continue
        try {
          await repairSymbol(st, from)
          stats.repairedSymbols++
          st.repairedAt = Date.now()
        } catch (e) {
          stats.lastError = (e as Error).message
          if (e instanceof RateBudgetError) {
            /* 被限流：把这个币放回队列，等一会儿再来（硬挤只会把 IP 打得更死） */
            queueRepair(st, from)
            await sleep(20_000)
          } else {
            console.warn(`[kline] 修 ${symbol} 失败：${(e as Error).message.slice(0, 100)}`)
          }
        }
      }
    }
    await Promise.all(Array.from({length: Math.min(REPAIR_CONC, jobs.length)}, () => worker()))
    stats.lastRepairAt = Date.now()
  } finally {
    repairing = false
  }
}

/**
 * 修一个币：① 补 1m ② 用 SQL 把高周期重算（只算**已完整**的桶）
 * ③ 对高周期再打一发 REST 覆盖同一段 —— 交易所口径永远是准的，
 *    我们漏了分钟时，rollup 出来的量/笔数会偏小，必须让它盖回去。
 */
async function repairSymbol(st: SymState, fromMs: number): Promise<void> {
  if (!cfg) return
  const now = Date.now()
  const bars = await paced(`补 1m ${st.sym.pair}`, 15, () =>
    fetchCandlesRange({
      exchangeId: cfg!.exchange,
      symbol: st.sym.symbol,
      timeframe: '1m',
      from: fromMs,
      to: now,
      marketType: cfg!.marketType,
      apiBase: cfg!.apiBase,
      maxCandles: 1500
    })
  )
  const rows: NewCandleRow[] = bars
    .filter(b => b.timestamp >= fromMs && b.timestamp < now)
    .map(b => ({
      exchange: cfg!.exchange,
      marketType: cfg!.marketType,
      symbol: st.sym.symbol,
      pair: st.sym.pair,
      interval: '1m' as KlineInterval,
      openTime: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      quoteVolume: 0,
      trades: 0,
      takerBuyVolume: 0,
      source: 'backfill'
    }))
  if (rows.length) {
    await saveCandles(rows)
    stats.backfilled1m += rows.length
  }

  for (const it of HIGH_INTERVALS) {
    const ms = MS[it]
    const from = Math.floor(Math.max(fromMs, now - 60 * ms) / ms) * ms
    const to = Math.floor(now / ms) * ms
    if (from < to) await rollupFrom1m(it, [st.sym.symbol], from, to, ms)

    /* ③ 同段再问一次交易所（1~2 根的量，很便宜） */
    const official = await paced(`补 ${it} ${st.sym.pair}`, 5, () =>
      fetchCandlesRange({
        exchangeId: cfg!.exchange,
        symbol: st.sym.symbol,
        timeframe: it,
        from,
        to: now,
        marketType: cfg!.marketType,
        apiBase: cfg!.apiBase,
        maxCandles: Math.max(3, Math.ceil((now - from) / ms) + 2)
      })
    )
    const officialRows: NewCandleRow[] = official
      .filter(c => c.timestamp >= from && c.timestamp < now)
      .map(c => ({
        exchange: cfg!.exchange,
        marketType: cfg!.marketType,
        symbol: st.sym.symbol,
        pair: st.sym.pair,
        interval: it as KlineInterval,
        openTime: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        quoteVolume: 0,
        trades: 0,
        takerBuyVolume: 0,
        source: 'repair'
      }))
    if (officialRows.length) await saveCandles(officialRows)
  }
}

/**
 * 灌历史：高周期每档取 `SEED_BARS` 根（**只补库里没有 / 断档的**）。
 *
 * 为什么要：光靠实时流攒，1h 要 10 天才能画满一屏；灌一次就当场「秒开」。
 * 成本：525 币 × 5 档 = 2625 发（权重约 5/发）⇒ 限速跑 10~20 分钟，`KLINE_SEED=off` 可关。
 * ⚠️ 灌进来的是 ccxt 的口径（只有 OHLCV，量/笔数/主动买量没有）⇒ 存 0，
 *    对账只比 OHLCV（`docs/EXCHANGE.md` 的每日对账）。
 */
/**
 * 可选：把 1m 的**7 天历史**一次灌满（`KLINE_SEED_1M=on`，默认关）。
 *
 * 为什么默认关：11 发/币 × 525 ≈ 5800 发（≈29k 权重，等于 24 分钟的整站预算）。
 * 不灌的话 1m 的 7 天窗口靠实时流自然攒满 —— 读路径本来就要为「库没覆盖到的那段」兜 REST。
 */
async function seedHistory1m(): Promise<void> {
  if (!cfg || (process.env.KLINE_SEED_1M ?? '').toLowerCase() !== 'on') return
  const now = Date.now()
  const have = await maxOpenTimes(
    '1m',
    symbols.map(s => s.symbol)
  )
  const jobs = symbols.filter(s => {
    const last = have.get(s.symbol)
    return !last || now - last > 60 * MIN_MS
  })
  if (!jobs.length) return
  console.log(`[kline] 灌 1m 历史（7 天）：${jobs.length} 个币，限速后台跑`)
  let i = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const sym = jobs[i++]
      if (!sym || stopped) return
      try {
        const from = Date.now() - 7 * 1440 * MIN_MS
        const rows = await paced(`灌 1m ${sym.pair}`, klineWeight(11_000), () =>
          fetchCandlesRange({
            exchangeId: cfg!.exchange,
            symbol: sym.symbol,
            timeframe: '1m',
            from,
            to: Date.now(),
            marketType: cfg!.marketType,
            apiBase: cfg!.apiBase,
            maxCandles: 11_000
          })
        )
        const out: NewCandleRow[] = rows.map(c => ({
          exchange: cfg!.exchange,
          marketType: cfg!.marketType,
          symbol: sym.symbol,
          pair: sym.pair,
          interval: '1m' as KlineInterval,
          openTime: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          quoteVolume: 0,
          trades: 0,
          takerBuyVolume: 0,
          source: 'seed'
        }))
        if (out.length) {
          await saveCandles(out)
          stats.seeded += out.length
        }
      } catch (e) {
        stats.lastError = (e as Error).message
      }
    }
  }
  await Promise.all(Array.from({length: REPAIR_CONC}, () => worker()))
  console.log('[kline] 灌 1m 历史完成')
}

async function seedHistory(): Promise<void> {
  if (!cfg || (process.env.KLINE_SEED ?? '').toLowerCase() === 'off') return
  const now = Date.now()
  const have = new Map<HighInterval, Map<string, number>>()
  for (const it of HIGH_INTERVALS) {
    have.set(
      it,
      await maxOpenTimes(
        it,
        symbols.map(s => s.symbol)
      )
    )
  }
  const jobs: {sym: PerpSymbol; it: HighInterval; tries: number}[] = []
  for (const s of symbols) {
    for (const it of HIGH_INTERVALS) {
      const last = have.get(it)?.get(s.symbol)
      if (last && now - last < 2 * MS[it]) continue
      jobs.push({sym: s, it, tries: 0})
    }
  }
  if (!jobs.length) return
  console.log(`[kline] 灌历史：${jobs.length} 个（币 × 周期）任务（限速 ${REPAIR_CONC} 并发）`)
  let i = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[i++]
      if (!job || stopped || job.tries > 3) return
      try {
        const ms = MS[job.it]
        const bars = SEED_BARS[job.it]
        const from = Date.now() - bars * ms
        const rows = await paced(
          `灌历史 ${job.it} ${job.sym.pair}`,
          klineWeight(bars),
          () =>
          fetchCandlesRange({
            exchangeId: cfg!.exchange,
            symbol: job.sym.symbol,
            timeframe: job.it,
            from,
            to: Date.now(),
            marketType: cfg!.marketType,
            apiBase: cfg!.apiBase,
            maxCandles: bars
          })
        )
        const out: NewCandleRow[] = rows.map(c => ({
          exchange: cfg!.exchange,
          marketType: cfg!.marketType,
          symbol: job.sym.symbol,
          pair: job.sym.pair,
          interval: job.it as KlineInterval,
          openTime: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          quoteVolume: 0,
          trades: 0,
          takerBuyVolume: 0,
          source: 'seed'
        }))
        if (out.length) {
          await saveCandles(out)
          stats.seeded += out.length
        }
      } catch (e) {
        stats.lastError = (e as Error).message
        if (e instanceof RateBudgetError) {
          /* 限流：排到队尾、等一会儿（灌历史可以慢慢来，绝不能把 IP 打封） */
          jobs.push({...job, tries: job.tries + 1})
          stats.seedLimited++
          await sleep(20_000)
        }
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(REPAIR_CONC, jobs.length)}, () => worker()))
  console.log(
    `[kline] 灌历史这一轮结束：累计 ${stats.seeded} 行` +
      (stats.seedLimited ? `（被限流让路 ${stats.seedLimited} 次）` : '')
  )
}

async function prune(): Promise<void> {
  try {
    const n = await pruneCandles()
    if (n) console.log(`[kline] 分级清理：删掉 ${n} 行（1m/5m >7天、15m >30天、1h >400天）`)
  } catch (e) {
    console.warn(`[kline] 清理失败：${(e as Error).message.slice(0, 120)}`)
  }
}

/* ---------------- 生命周期 ---------------- */

export function startKlineRecorder(): void {
  if (started || stopped) return
  if ((process.env.KLINE_RECORDER ?? '').toLowerCase() === 'off') {
    console.log('[kline] 底座已关闭（KLINE_RECORDER=off）')
    return
  }
  started = true
  void boot().catch(e => {
    started = false
    console.warn(`[kline] 底座启动失败：${(e as Error).message.slice(0, 160)}`)
  })
}

async function boot(): Promise<void> {
  const c = loadConfig()
  cfg = {exchange: c.exchange, marketType: c.marketType, apiBase: c.apiBase}
  symbols = await listPerpetualSymbols({exchangeId: cfg.exchange, apiBase: cfg.apiBase})
  const max = Number(process.env.KLINE_RECORDER_MAX || 0)
  if (Number.isFinite(max) && max > 0) symbols = symbols.slice(0, max)
  if (!symbols.length) throw new Error('拿不到合约清单（markets 里没有 U 本位永续）')
  for (const s of symbols) {
    states.set(s.pair.toUpperCase(), {
      sym: s,
      lastClosedMs: 0,
      aggs: new Map(),
      coveredAt: 0,
      repairedAt: 0
    })
  }
  console.log(`[kline] 底座启动：${symbols.length} 个合约，1 条上游连接（只订 1m）`)
  await open()
  timers.push(setInterval(() => void flush(), FLUSH_MS))
  timers.push(setInterval(logStats, STATS_MS))
  timers.push(setInterval(() => void prune(), PRUNE_EVERY_MS))
  timers.push(setInterval(checkWatchdog, WATCHDOG_MS))
  timers.push(setInterval(() => void repairTick(), REPAIR_TICK_MS))
  /* 灌历史可以被打断（限流让路）⇒ 定期续一轮；幂等：已经跟到现在的币会跳过 */
  timers.push(setInterval(() => void seedHistory(), SEED_RETRY_MS))
  for (const t of timers) t.unref()
  await prune()
  void repairSweep('启动')
  void seedHistory()
  void seedHistory1m()
}

export async function stopKlineRecorder(): Promise<void> {
  if (!started || stopped) return
  stopped = true
  for (const t of timers) clearInterval(t)
  timers.length = 0
  try {
    sock?.close()
  } catch {
    /* 已经断了 */
  }
  sock = null
  await flush()
}

export interface KlineRecorderStats {
  enabled: boolean
  connected: boolean
  symbols: number
  covered: number
  closedBars: number
  minuteGaps: number
  partialAggs: number
  rowsWritten: number
  rowFailures: number
  dropped: number
  repairedSymbols: number
  backfilled1m: number
  seeded: number
  seedLimited: number
  pendingRepairs: number
  openSec: number
  lastFrameSecAgo: number
  lastError: string
}

export function klineRecorderStats(): KlineRecorderStats {
  return {
    enabled: started && !stopped,
    connected: sock?.readyState === 1,
    symbols: symbols.length,
    covered: [...states.values()].filter(s => s.coveredAt > 0).length,
    closedBars: stats.closedBars,
    minuteGaps: stats.minuteGaps,
    partialAggs: stats.partialAggs,
    rowsWritten: stats.rowsWritten,
    rowFailures: stats.rowFailures,
    dropped: stats.dropped,
    repairedSymbols: stats.repairedSymbols,
    backfilled1m: stats.backfilled1m,
    seeded: stats.seeded,
    seedLimited: stats.seedLimited,
    pendingRepairs: repairQueue.size,
    openSec: openSince ? Math.round((Date.now() - openSince) / 1000) : 0,
    lastFrameSecAgo: lastFrameAt ? Math.round((Date.now() - lastFrameAt) / 1000) : -1,
    lastError: stats.lastError
  }
}
