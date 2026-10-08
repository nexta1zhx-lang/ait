/**
 * ★ K 线底座（常驻）：**一条上游 WS 订全市场 1m**，收盘就地落库 + 滚出高周期。
 *
 * 为什么要有它（用户 2026-10-07：「不需要预热那一套…改为实时的，存储 7 天 1 分钟的」）：
 *   以前「点开哪个币都能立刻画」靠三套补丁 —— 启动预热 120 币、`kline-store` 每 10 秒
 *   REST 保活、跨热线那一刻**阻塞等上游**（注释里记过实测 13 秒）；而且缓存**纯内存不落库**，
 *   重启全丢 ⇒ 冷启动必然回到 REST。
 *   现在：1m 推送流常驻（**0 权重**）→ 收盘落库 → 高周期由 1m 滚出来。
 *   **2026-10-07 P1 已收口**：那三套补丁（启动预热、10 秒保活、跨热线阻塞）都删了，
 *   读路径改成「内存 → 库 → REST」（见 `kline-store.ts`），库这一层就是本文件写的。
 *   ⇒ 本文件同时是**写**方与**当前根**的来源（`currentBar()`），别再另起一套。
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
import {
  fetchCandlesRange,
  fetchExchangeInfoRaw,
  listPerpetualSymbols,
  planContractChanges,
  type PerpSymbol,
  type RawContract
} from './market'
import {
  HIGH_INTERVALS,
  bucketCoverage,
  candleRejectStats,
  ensureCandlePartitions,
  findStaleBuckets,
  lastTradedAt,
  maxOpenTimes,
  pendingCheckStats,
  pruneCandles,
  readRecentCandles,
  rollupFrom1m,
  saveCandles,
  saveKlineRecon,
  sumClosed1m,
  verifyPendingChecks,
  type HighInterval,
  type KlineInterval,
  type KlineReconRow,
  type NewCandleRow
} from '../db/candle-store'
import {loadSymbols, upsertSymbols} from '../db/symbols'
import {RateBudgetError, takeWeight} from '../util/rate-budget'
import type {Candle, MarketType, Timeframe} from '../types'

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

/**
 * 只留**已收盘**的桶。
 *
 * ⚠️ 交易所的区间接口一定会把「正在走的那根」也带回来（`openTime + 周期 > now`）——
 *    直接入库就是一条**残桶**：量/额/笔只会偏小，而再过一会儿权威口径就有了。
 *    「库里只保证已收盘的桶」这条前提全靠这里守住：读热层（`kline-store`）会把这串
 *    当作完整桶用，掺一根半成品进去，图表上最后一根的量就是错的。
 *    （2026-10-07 补：`repairSymbol` / `seedHistory` / `seedHistory1m` 三处都少了这道过滤。）
 */
function closedOnly<T extends {timestamp: number}>(
  bars: T[],
  ms: number,
  now = Date.now()
): T[] {
  return bars.filter(b => b.timestamp + ms <= now)
}
/** 灌历史的续跑间隔（限流被打断后不用等重启） */
const SEED_RETRY_MS = 20 * 60_000
/** 修复队列：多久扫一次、一次最多几个币、同一个币多久内不重复修 */
const REPAIR_TICK_MS = 60_000
const REPAIR_PER_TICK = 5
/** 积压时的每拍上限（重启后 525 个币都可能缺几分钟，5 个/拍要修两小时） */
const REPAIR_PER_TICK_BACKLOG = 15
const REPAIR_BACKLOG = 50
const REPAIR_COOLDOWN_MS = 10 * MIN_MS
/**
 * 第 2 档「存在性检查」：多久巡检一次、窗口多长。
 *
 * 为什么要有它（`repairSweep` 只管「库里最后一条 vs 现在」）：**窗口中间的洞**它看不见 ——
 * 漏了 40 分钟又被上游接上，最后一条是新的，扫描就认为"没事"。而那个洞会让图上少一截，
 * 读路径还会因为"这段库里有覆盖"而**不去问交易所**，于是洞一直摆着。
 * 0 权重（纯库内聚合，走 candles_ivl_time_idx）⇒ 频率可以给得比较勤。
 */
const GAP_CHECK_MS = 5 * 60_000
const GAP_WINDOW_BARS = 120
/** 刚落下的那根可能还没 flush（每 4 秒一批）⇒ 判"该有"时给它留一点余量 */
const GAP_FLUSH_GRACE_MS = 30_000
/** 库内自洽看最近几个桶（4h 看 4 个就是 16 小时，够覆盖"重启前后写坏的那一个"） */
const STALE_CHECK_BUCKETS = 4
/**
 * 每轮**只复核**多少个账目（`kline_pending_check`）。
 *
 * 账上常态只有「刚 seed / 刚补过数据」的那些桶，所以这个上限几乎用不到；
 * 真赶上大批量补数据（比如重启后 525 个币一起修）时，它保证单轮 IO 有上界 —— 一个桶
 * 最贵也就 1440 行（1d），50 个 ≈ 7 万行，比原来那轮的 370 万行小两个数量级。
 */
const STALE_SWEEP_LIMIT = 50
/**
 * 补高周期时往前补多少格（60 格：5m = 5 小时、1h = 2.5 天）。
 * 原来这个 60 写死在 rollup/官方覆盖两处，现在提出来当常量。
 */
const REPAIR_SPAN_BARS = 60
/** 分区维护的间隔（跨天/跨月/跨年建新分区、丢过期分区；幂等，很便宜） */
const PARTITION_TICK_MS = 60 * 60_000
/**
 * 「静默」判定：上游超过这么久没推某个币，就当它停牌/下架（或我们那条流死了）。
 * 1m 流在交易的币上每秒都有帧，所以 15 分钟已经很宽松。
 */
const SILENT_MS = 15 * 60_000
/** 静默的币最多重订几个 / 同一个币多久重订一次（别把入站消息限制打爆） */
const SILENT_RETRY_MAX = 20
const SILENT_RETRY_MS = 10 * 60_000
/** 一轮最多把几个币排进修复队列（防一次抖动把队列堆爆，剩下的下一轮再来） */
const GAP_ALERT_MAX = 60
/**
 * 第 3 档「抽样对账」：每天抽几个币、每档比多少根、什么时候跑。
 *
 * 为什么是抽样而不是全量：全量 525 币 × 5 档 = 2625 发（≈5000 权重），一年跑一次都嫌吵；
 * 而抽样是**轮换**的（按天序号取模，525 币 175 天一轮），长期下来覆盖面一样是全局。
 * 为什么放在启动 15 分钟后：那之前 `seedHistory` 还在灌，库本来就不全，比出来全是假差异。
 */
/**
 * 合约发现（生命周期）：多久拉一次原始 `exchangeInfo`（权重 1，体 1.1MB）。
 *
 * 每天一次就够了（用户 2026-10-07 定的口径：「改为每日」）—— 新币晚一天上线的影响是
 * 「点开它走 REST」，功能不降级；而**按需发现**（读路径遇到没订阅的币时顺手触发一次，
 * 见 `kline-store.ts`）把"你正在看的那个"提前到"你点它的那一刻"，两边合起来就够用。
 * 另外启动时也跑一次：进程重启通常比 24 小时频繁，等于多了几次免费的对齐机会。
 */
const DISCOVERY_EVERY_MS = 24 * 60 * 60_000
/** 按需发现之间的最小间隔（一次就拿到全市场，重复打没有意义） */
const DISCOVERY_MIN_GAP_MS = 5 * 60_000
const RECON_SYMBOLS = 3
const RECON_BARS = 200
const RECON_FIRST_MS = 15 * MIN_MS
const RECON_EVERY_MS = 24 * 60 * 60_000
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

/** 读热层要的「当前那根 1m」：底座只把**未收盘**那帧放这里，永远不落库 */
interface LiveBar {
  /** 交易所原始 id（`BTCUSDT`）—— `states` 是按它做 key 的，取累加器要用它 */
  pair: string
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
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
  /** 上次因为"上游好久没推它"而重订它那条流的时刻（见 `runGapCheck` 的静默分支） */
  silentRetryAt: number
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
/**
 * 待修队列：币 → 「从哪一刻起 + 要修哪几档」。
 *
 * ⚠️ 2026-10-08 起带上 `intervals`（用户要求：**回补别去读 1m，直接拿交易所已经聚合好的那一档**）。
 *    原来队列只记一个 `fromMs`，`repairSymbol` 于是"六发全打"：无条件拿一发 1m（`maxCandles: 1500`）
 *    + 5 档各再拿一发官方覆盖 —— 而巡检报出来的缺口**绝大多数在高周期**
 *    （实测 1596 处全是 5m/15m/1h/4h，1m 是 0）⇒ 那发 1m 基本是白拿的。
 *    现在：谁报的缺口就修谁 —— 报 5m 就直连 `interval=5m`（一发覆盖 1500 根），
 *    报 1m 才去补 1m（补完顺手用 SQL 把高周期滚出来，0 权重）。
 */
interface RepairJob {
  /** 缺口的起点（毫秒） */
  from: number
  /** 要修的档（`1m` 或高周期） */
  intervals: Set<KlineInterval>
}
const repairQueue = new Map<string, RepairJob>()
/** 动态订阅/退订用的请求 id（跟启动那批批量订阅的 id 分开，便于看回执） */
let subSeq = 1000

/**
 * 合约**生命周期**的内存镜像（读路径要 0 I/O 查它，别让它去查库）。
 * 启动时从 `symbols` 表灌一次，之后每次发现都覆盖。
 */
interface Lifecycle {
  status: string
  onboardAt: number | null
  delistedAt: number | null
}
const lifecycle = new Map<string, Lifecycle>()
/** 已订阅币的 ccxt 统一符号集合（按 pair 建的 `states` 查起来不方便） */
const subscribedSymbols = new Set<string>()

const discoveryStats = {
  lastAt: 0,
  lastReason: '',
  /** 上游原始清单里有多少个 U 本位永续 USDT 合约 */
  lastRaw: 0,
  /** 其中 TRADING 的 */
  lastTrading: 0,
  added: 0,
  dropped: 0,
  lastError: ''
}
let discovering = false
let lastDiscoveryAt = 0
/**
 * `KLINE_RECORDER_MAX` 的上限（本地只订 8 个币减轻内存压力）。
 * ⚠️ 发现那条路**必须**尊重它 —— 否则本地一跑发现就"补齐"到 525 个，把上限打穿。
 */
let maxSymbols = 0
let capWarned = false

/**
 * 每个币**最近一次收到的 1m 帧**（含未收盘那根）—— 读热层的「当前根」就靠它。
 *
 * 为什么不落库：未收盘那根每秒变 ~4 次，525 个币就是 2000+ upsert/秒，换不到任何体验；
 * 而读路径要的是「此刻的值」，内存里这份就是最新最准的。
 */
const live1m = new Map<string, LiveBar>()
const timers: ReturnType<typeof setInterval>[] = []

const stats = {
  closedBars: 0,
  minuteGaps: 0,
  /** 上游好久没推帧的币数（多半是停牌/下架；也可能是我们那条流静默死了） */
  silentSymbols: 0,
  partialAggs: 0,
  rowsWritten: 0,
  rowFailures: 0,
  dropped: 0,
  repairedSymbols: 0,
  backfilled1m: 0,
  repairedHigh: 0,
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
  const sym = String(k.s ?? '').toUpperCase()
  const st = states.get(sym)
  if (!st || String(k.i) !== '1m') return
  st.coveredAt = Date.now()

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

  /*
   * ★ 当前那根（含**未收盘**）留在内存里 —— 读热层拿它接在库的历史后面（见 `currentBar()`）。
   *   库里只有已收盘的桶，没有它就画不出"正在走的这根"，只能再打一趟交易所。
   *   525 个币 × 一分钟几帧 ≈ 几千个小对象，几十 KB，可以忽略。
   *   收盘后**照样留着**：下一帧来之前它就是这个币最新的那根，读路径按时间戳去重，
   *   不会和库里刚写进去的同一根重复。
   */
  /* key 用 ccxt 统一形式 —— 跟库里 `candles.symbol` / `currentBar()` 的调用方同一把钥匙 */
  live1m.set(st.sym.symbol, {pair: st.sym.pair, openTime, ...bar})
  /* 未收盘那根不落库：525 upsert/秒 换不到任何体验 */
  if (!k.x) return

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

/**
 * 某个币、某个周期**当前正在走的那根**（库里没有，只能在这儿合成；0 I/O、0 权重）。
 *
 * 高周期的当前根 = 累加器里**已收盘的 1m**（`Agg`）+ 正在走的那根 1m：
 *   · 累加器还没轮到这根活的（`agg.nextMs <= live.openTime`）⇒ 把活的并进去；
 *   · 已经并过（活的那根其实已收盘并 rollup 过了）⇒ 只用累加器，别重复加一遍量。
 *
 * ⚠️ 只对「底座订阅过的币」有效：非 swap / 新上市这些没订阅的返回 null，
 *    调用方该退回 REST（见 `kline-store.ts`）。
 */
export async function currentBar(
  symbol: string,
  interval: Timeframe
): Promise<Candle | null> {
  /* ⚠️ `symbol` 是 ccxt 统一形式（`BTC/USDT:USDT`）—— 跟库里 `candles.symbol` 同一把钥匙，
     别传交易所原始 id（那套 key 是 `states` 内部用的，见 `boot()`）。 */
  const live = live1m.get(symbol)
  if (!live) return null
  const asCandle = (openTime: number, b: Omit<LiveBar, 'pair' | 'openTime'>): Candle => ({
    timestamp: openTime,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume
  })
  if (interval === '1m') return asCandle(live.openTime, live)

  const ms = MS[interval]
  const bucket = Math.floor(live.openTime / ms) * ms
  const agg = states.get(live.pair.toUpperCase())?.aggs.get(interval)
  /*
   * 累加器可用（这个桶的、且没缺过分钟）⇒ 直接用它 + 活的这根 1m（0 I/O）。
   */
  if (agg && agg.bucket === bucket && !agg.partial) {
    const mergeLive = live.openTime >= agg.nextMs
    return {
      timestamp: bucket,
      open: agg.open,
      high: mergeLive ? Math.max(agg.high, live.high) : agg.high,
      low: mergeLive ? Math.min(agg.low, live.low) : agg.low,
      close: mergeLive ? live.close : agg.close,
      volume: agg.volume + (mergeLive ? live.volume : 0)
    }
  }
  /*
   * 累加器**不可信**（刚重启 / 这个桶中间漏过分钟 ⇒ `partial`，或者桶刚开还没有 1m 进来）：
   * 光拿活的这根 1m 冒充整根是错的 —— `open` 会取成这一分钟的开价、量只有一分钟的量。
   * 正确的拼法 = 库里**已收盘的 1m**（这个桶里那一段）+ 活的这根。
   */
  if (cfg) {
    const fromDb = await sumClosed1m(symbol, bucket, live.openTime, {
      exchange: cfg.exchange,
      marketType: cfg.marketType
    })
    if (fromDb) {
      return {
        timestamp: bucket,
        open: fromDb.open,
        high: Math.max(fromDb.high, live.high),
        low: Math.min(fromDb.low, live.low),
        close: live.close,
        volume: fromDb.volume + live.volume
      }
    }
  }
  /* 库里也没有（刚装 / 底座还没写过）：只能拿这根活的顶着 */
  return asCandle(bucket, live)
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

/** 返回 true = 真排进去了；false = 在冷却里被挡下（调用方要如实计数，别虚报） */
/**
 * 排进修复队列。`intervals` 缺省是 `['1m']`（`repairSweep` 的主用途：它只看 1m 的落后）。
 *
 * ⚠️ 报**高周期**缺口时一定要把那一档传进来 —— 传了才会**直连交易所那一档**去补，
 *    不传就只会去补 1m（贵一个量级，而且 `trades` 那列滚出来恒 0）。
 */
function queueRepair(
  st: SymState,
  fromMs: number,
  intervals: KlineInterval[] = ['1m']
): boolean {
  if (Date.now() - st.repairedAt < REPAIR_COOLDOWN_MS) return false
  const cur = repairQueue.get(st.sym.symbol)
  if (!cur) {
    repairQueue.set(st.sym.symbol, {from: fromMs, intervals: new Set(intervals)})
  } else {
    if (fromMs < cur.from) cur.from = fromMs
    for (const it of intervals) cur.intervals.add(it)
  }
  return true
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
  const scope = {exchange: cfg.exchange, marketType: cfg.marketType}
  try {
    const stored = await maxOpenTimes('1m', symbols.map(s => s.symbol), scope)
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
      /* 上游好久没推它 = 停牌/下架（或这条流死了）：别排队 —— `repairSymbol` 也会自保跳过 */
      if (st.coveredAt && now - st.coveredAt > SILENT_MS) continue
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
        const job = repairQueue.get(symbol)
        repairQueue.delete(symbol)
        const st = [...states.values()].find(s => s.sym.symbol === symbol)
        if (!st || !job) continue
        try {
          await repairSymbol(st, job.from, job.intervals)
          stats.repairedSymbols++
          st.repairedAt = Date.now()
        } catch (e) {
          stats.lastError = (e as Error).message
          if (e instanceof RateBudgetError) {
            /* 被限流：把这个币放回队列，等一会儿再来（硬挤只会把 IP 打得更死） */
            queueRepair(st, job.from, [...job.intervals])
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
async function repairSymbol(
  st: SymState,
  fromMs: number,
  intervals: Set<KlineInterval>
): Promise<void> {
  if (!cfg) return
  const now = Date.now()
  /*
   * ⚠️ 自保：**很久没有真实成交的币一律不补**（停牌 / 下架 / 上游不再推它）。
   *
   * 为什么必要：币安对**已下架**（`status = SETTLING`）的币**还会继续返回 K 线**，
   * 只是那些全是**量 0 的水平线**（实测 OMG/WAVES 下架后最近 5 根 1h 量全是 0、价格冻住）。
   * 补这种币 = 往 **4h/1d（永久保留）** 里塞假 K 线 —— 而且下架可能发生在两次合约发现之间
   * （最长 24 小时），这段时间 `repairSweep`/缺口巡检都会来碰它。
   * 判据用「最后一次 volume > 0 的 1m」而不是"上游有没有推帧"：推帧可能是订阅时的快照帧。
   */
  const scope = {exchange: cfg.exchange, marketType: cfg.marketType}
  const lastTrade = await lastTradedAt('1m', st.sym.symbol, scope)
  if (lastTrade !== null && now - lastTrade > SILENT_MS) {
    stats.silentSymbols++
    return
  }
  /*
   * ① 1m：**只在真的要点名修 1m 时才去拿**。
   *    原来无论修什么档都先无条件拿一发 1m（`maxCandles: 1500`）—— 而巡检报出来的缺口
   *    绝大多数在高周期（2026-10-08 实测 1596 处全是 5m/15m/1h/4h，1m 是 0）⇒
   *    那一发连同后面 5 档的官方覆盖一共 **6 发/币**，其中大部分是白打的。
   *    现在报 5m 就只打 5m（见 ②），1m 有洞才补 1m。
   */
  if (intervals.has('1m')) {
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
    const rows: NewCandleRow[] = closedOnly(
      bars.filter(b => b.timestamp >= fromMs),
      MIN_MS,
      now
    )
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
      stats.backfilled1m += await saveCandles(rows)
    }
    /*
     * 1m 补好了 ⇒ 用**纯 SQL** 把高周期那一档滚出来（0 权重）。高周期本来就由 1m 滚成，
     * 这一步等于"顺手把派生数据补齐"，不用再打交易所。
     */
    for (const it of HIGH_INTERVALS) {
      const ms = MS[it]
      const from = Math.floor(Math.max(fromMs, now - REPAIR_SPAN_BARS * ms) / ms) * ms
      const to = Math.floor(now / ms) * ms
      if (from < to) await rollupFrom1m(it, [st.sym.symbol], from, to, ms, scope)
    }
  }

  /*
   * ② 高周期：**哪档缺就直连哪档**（交易所已经聚合好的那个接口）。
   *
   *    · 官方那一档就是权威口径（量 / 笔数 / 主动买量都齐），而 rollup 出来的 `trades`
   *      恒 0（1m 那列我们本来就没存）；
   *    · 一发请求覆盖 `maxCandles` 根 —— 补 5m 的 42 根只要 1 发，而走「补 1m + 自己聚合」
   *      要拿 210 根 1m 再算一遍；
   *    · 只对被点名的那几档打，常态就是「缺哪档打哪发」。
   *
   *    ⚠️ 交易所那发拿不到（超时 / 被限流）时**退回**「用 1m 重算」（纯 SQL、0 权重）——
   *       所以 rollup 那条路留着当兜底，不是主路。
   */
  for (const it of HIGH_INTERVALS) {
    if (!intervals.has(it)) continue
    const ms = MS[it]
    const from = Math.floor(Math.max(fromMs, now - REPAIR_SPAN_BARS * ms) / ms) * ms
    const to = Math.floor(now / ms) * ms
    if (from >= to) continue
    let ok = false
    try {
      /*
       * ⚠️ 必须 `closedOnly`：交易所区间接口会把**正在走的那根**也返回，
       *    而它 `timestamp < now` 一过滤就"合法"了 —— 于是库里多一根量只有半截的
       *    `source='repair'`（2026-10-07 实测抓到：5 个币 × 5 档全有）。
       */
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
      const officialRows: NewCandleRow[] = closedOnly(
        official.filter(c => c.timestamp >= from),
        ms,
        now
      )
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
      if (officialRows.length) {
        await saveCandles(officialRows)
        stats.repairedHigh += officialRows.length
        ok = true
      }
    } catch (e) {
      stats.lastError = (e as Error).message
    }
    if (!ok) {
      /* 兜底：交易所没给（或给空了）⇒ 用库里的 1m 重算这一段（0 权重） */
      await rollupFrom1m(it, [st.sym.symbol], from, to, ms, scope)
    }
  }
}

/* ---------------- 维护任务计时（P4，2026-10-08） ----------------
 *
 * 为什么要有：2026-10-08 那次「服务器为什么慢」，只能 ssh 进去手工量（`pg_stat_activity`
 * + `EXPLAIN` + 临时探针）才定位到「巡检一轮 4 分 40 秒」。
 * 现在每个维护任务自己报耗时，超阈值就打日志 —— 慢会自己冒出来，不用再问人。
 */
/**
 * 超过多久算「慢」并告警。默认 3 秒 —— 这台机器上纯 DB 的维护任务都是几十毫秒级。
 *
 * ⚠️ **要走交易所 REST 的任务不能套这个数**：`补缺口` 一轮要按限速打十几发请求
 *    （本地走隧道时实测 57–63 秒，这是**正常工作量**不是故障）。这类任务单独放宽，
 *    否则积压期间每一拍都告警，把真正该看的日志淹掉。
 */
const SLOW_TASK_MS_DEFAULT = 3_000
const SLOW_TASK_MS: Record<string, number> = {
  补缺口: 120_000,
  灌历史: 120_000
}
const taskStats: Record<string, {lastMs: number; lastAt: number; runs: number; slow: number}> = {}

/** 包一个维护任务，记耗时；慢过阈值告警一次（每次跑都告警，便于 f 日志里搜） */
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  try {
    return await fn()
  } finally {
    const ms = Date.now() - t0
    const s = (taskStats[name] ??= {lastMs: 0, lastAt: 0, runs: 0, slow: 0})
    s.lastMs = ms
    s.lastAt = Date.now()
    s.runs++
    const limit = SLOW_TASK_MS[name] ?? SLOW_TASK_MS_DEFAULT
    if (ms >= limit) {
      s.slow++
      console.warn(
        `[kline] ⚠️ 维护任务慢：${name} 用了 ${(ms / 1000).toFixed(1)} 秒` +
          `（阈值 ${limit / 1000} 秒，第 ${s.slow} 次）`
      )
    }
  }
}

/* ---------------- 三档校验 ----------------
 *
 *  ① 实时（写入前）  `sanitizeRows` 在 `db/candle-store.ts` 的 `saveCandles` 里 —— 四条入库路
 *     （实时流 / rollup / 补缺口 / 灌历史）都走它，所以校验只写了一处。计数读 `candleRejectStats()`。
 *  ② 定时（存在性）  `runGapCheck`：窗口内该有多少根 vs 实际有多少根 ⇒ 告警 + 排进修复队列。
 *  ③ 每日（抽样对账）`runKlineRecon`：抽 3 个币 × 5 档 vs 交易所 REST 逐字段比 OHLCV ⇒ 落表。
 */

const gapStats = {
  lastAt: 0,
  lastFound: 0,
  lastScanned: 0,
  lastQueued: 0,
  lastCooling: 0,
  lastStale: 0,
  lastSilent: 0,
  /** 这一轮取出来复核的账目数 / 还判不了的 */
  lastChecked: 0,
  lastStaleWaiting: 0
}
let gapChecking = false

/**
 * 第 2 档：存在性检查（定时、0 权重）。
 *
 * 只看**底座订阅过、且收过帧**的币（`coveredAt > 0`）：没收到过帧的币要么是死币、
 * 要么是刚启动，报警只会是噪音 —— 那件事 `logStats` 的 `覆盖 x/y` 已经在看了。
 *
 * 导出是给管理接口手动触发的（`GET /api/kline/gaps?run=1`）：定时那轮 5 分钟一次，
 * 想当场确认"洞有没有被补上"不该干等。
 */
export async function runGapCheck(reason: string): Promise<{
  scanned: number
  found: number
  queued: number
  cooling: number
  stale: number
  /** 账上「1m 还没补齐」、这一轮判不了的桶（留着下轮复核） */
  staleWaiting: number
  /** 账目超期销账的条数（1m 已过保留期，永远判不了了） */
  staleExpired: number
  /** 上游好久没推帧的币（停牌/下架，或者我们那条流静默死了 —— 已顺手重订一次） */
  silent: number
}> {
  if (gapChecking || stopped || !cfg) {
    return {
      scanned: 0,
      found: 0,
      queued: 0,
      cooling: 0,
      stale: 0,
      staleWaiting: 0,
      staleExpired: 0,
      silent: 0
    }
  }
  gapChecking = true
  const out = {
    scanned: 0,
    found: 0,
    queued: 0,
    cooling: 0,
    stale: 0,
    staleWaiting: 0,
    staleExpired: 0,
    silent: 0
  }
  try {
    const scope = {exchange: cfg.exchange, marketType: cfg.marketType}
    const now = Date.now()
    const byInterval: Record<string, number> = {}
    const samples: string[] = []
    for (const it of ['1m', ...HIGH_INTERVALS] as KlineInterval[]) {
      const ms = MS[it]
      const since = now - GAP_WINDOW_BARS * ms
      const expectedTo = Math.floor((now - ms - GAP_FLUSH_GRACE_MS) / ms) * ms
      if (expectedTo < since) continue
      const cov = await bucketCoverage(it, since, scope)
      for (const st of states.values()) {
        if (!st.coveredAt) continue
        /*
         * 上游好久没推这个币了：要么它停牌/下架了，要么**我们这条流静默死了**。
         * 两种都不该算成"缺口"（缺口巡检会去补数据，而停牌币补出来是量 0 的假 K 线）。
         * 但值得重订一次 —— 若是流死了，重订就自愈；若是币停了，重订没有副作用。
         */
        if (now - st.coveredAt > SILENT_MS) {
          out.silent++
          if (out.silent <= SILENT_RETRY_MAX && now - st.silentRetryAt > SILENT_RETRY_MS) {
            st.silentRetryAt = now
            send({
              method: 'UNSUBSCRIBE',
              params: [`${st.sym.pair.toLowerCase()}@kline_1m`],
              id: ++subSeq
            })
            send({
              method: 'SUBSCRIBE',
              params: [`${st.sym.pair.toLowerCase()}@kline_1m`],
              id: ++subSeq
            })
          }
          continue
        }
        out.scanned++
        const c = cov.get(st.sym.symbol)
        /* 窗口里该有多少根：从「它自己最早那根」到「现在该有的最后一根」 */
        const lo = c ? Math.max(Math.floor(since / ms) * ms, Math.floor(c.lo / ms) * ms) : null
        const expected = lo === null ? 0 : Math.floor((expectedTo - lo) / ms) + 1
        const actual = c?.n ?? 0
        if (expected > 0 && actual >= expected) continue
        /* `lo === null` 表示窗口里一根都没有（上游在推我们、库里却空着）⇒ 也算缺口 */
        out.found++
        byInterval[it] = (byInterval[it] ?? 0) + 1
        if (samples.length < 5) {
          samples.push(`${st.sym.pair}/${it} 有 ${actual} 该有 ${expected}`)
        }
        if (
          out.queued < GAP_ALERT_MAX &&
          queueRepair(st, lo ?? now - BACKFILL_MAX_MS, [it])
        ) {
          out.queued++
        } else {
          out.cooling++
        }
      }
    }
    /*
     * ② 库内自洽：只复核**账上**那些「我们自己写下去、且写的时候桶还没收盘」的高周期桶。
     *
     * 2026-10-08 改的（见 docs/EXCHANGE.md 第 53 节）：
     *   原来是「4 桶 × 5 档 × 全部币」的定时全市场扫描 —— 每轮 ≈ 370 万行 1m 读取、
     *   实测 **4 分 40 秒**（1d 一档就 3 分 33 秒），而 `gapChecking` 守卫会让上一轮没完就跳过
     *   下一轮 ⇒ 实际是**背靠背连续跑**，磁盘被占 60–99%（`wa=48%`、loadavg 冲到 11）——
     *   这才是「服务器慢」和发布期间超时的真身。而那段最贵的 4h/1d 从没揪出过任何坏桶。
     *   现在：只核对账上「桶已收盘」的那些，一个桶一次定向探测（≤1440 行）。
     *   全量扫描保留成**手动**入口（`?run=full`），供上线时把历史遗留理一遍。
     */
    const sweep = await verifyPendingChecks(STALE_SWEEP_LIMIT)
    out.stale = sweep.stale.length
    out.staleWaiting = sweep.waiting
    out.staleExpired = sweep.expired
    const staleByInterval: Record<string, number> = {}
    const staleSamples: string[] = []
    for (const sv of sweep.stale) {
      staleByInterval[sv.interval] = (staleByInterval[sv.interval] ?? 0) + 1
      if (staleSamples.length < 5) {
        staleSamples.push(
          `${sv.symbol}/${sv.interval} @${new Date(sv.openTime).toISOString()} ` +
            `库里 close=${sv.ours.close} 而 1m 重算=${sv.from1m.close}（记账来源 ${sv.why}）`
        )
      }
      const st = [...states.values()].find(v => v.sym.symbol === sv.symbol)
      if (!st) continue
      if (out.queued < GAP_ALERT_MAX && queueRepair(st, sv.openTime, [sv.interval as KlineInterval])) {
        out.queued++
      }
      else out.cooling++
    }
    gapStats.lastAt = now
    gapStats.lastFound = out.found
    gapStats.lastScanned = out.scanned
    gapStats.lastQueued = out.queued
    gapStats.lastCooling = out.cooling
    gapStats.lastStale = out.stale
    gapStats.lastSilent = out.silent
    gapStats.lastStaleWaiting = out.staleWaiting
    gapStats.lastChecked = sweep.due
    /* 账上超期（1m 都没了、判不了）要看得见：说明有桶一直没能复核 */
    if (out.staleExpired) {
      console.warn(
        `[kline] 复核账目超期销账 ${out.staleExpired} 条（记账超过 7 天仍判不了 —— 1m 已过保留期）`
      )
    }
    if (out.found) {
      const detail = Object.entries(byInterval)
        .map(([k, v]) => `${k} ${v}`)
        .join(' / ')
      console.warn(
        `[kline] 缺口巡检（${reason}）：${out.scanned} 组里发现 ${out.found} 处缺口（${detail}），` +
          `排进修复队列 ${out.queued} 个` +
          /* 冷却期内的要如实说：不然"排队 8 个"却什么都没修，看日志的人会以为是修复坏了 */
          (out.cooling ? `（${out.cooling} 个在 10 分钟冷却里，下一轮再排）` : '') +
          ` —— 例：${samples.join('；')}`
      )
    }
    if (out.silent) {
      console.warn(
        `[kline] 静默合约（${reason}）：${out.silent} 个币上游好久没推帧（停牌/下架，` +
          `或我们那条流死了）—— 已顺手重订，且**不**去补数据`
      )
    }
    if (out.stale) {
      const detail = Object.entries(staleByInterval)
        .map(([k, v]) => `${k} ${v}`)
        .join(' / ')
      console.warn(
        `[kline] 库内自洽（${reason}）：${out.stale} 个高周期桶跟 1m 重算对不上（${detail}）` +
          `—— 多为残桶/陈旧值，按冷却情况排进修复队列。例：${staleSamples.join('；')}`
      )
    }
  } catch (e) {
    stats.lastError = (e as Error).message
    console.warn(`[kline] 缺口巡检失败：${(e as Error).message.slice(0, 120)}`)
  } finally {
    gapChecking = false
  }
  return out
}

/**
 * **手动**的全量残桶体检（`GET /api/kline/gaps?run=full`）。
 *
 * 就是 2026-10-08 之前那个定时任务（4 桶 × 5 档 × 全部币的全市场扫描），
 * 现在只在这个入口跑：**上线时把历史遗留的残桶理一遍**，之后定时路径只走记账复核
 * （见 `verifyPendingChecks` 与 docs/EXCHANGE.md 第 53 节）。
 *
 * ⚠️ 它很贵：实测一轮 4 分 40 秒（1d 一档 3 分 33 秒），会把磁盘占满 —— 别没事就点它。
 */
export async function runFullStaleSweep(reason = '手动'): Promise<{
  stale: number
  queued: number
  samples: string[]
}> {
  if (!cfg) return {stale: 0, queued: 0, samples: []}
  const scope = {exchange: cfg.exchange, marketType: cfg.marketType}
  const now = Date.now()
  const samples: string[] = []
  let stale = 0
  let queued = 0
  for (const it of HIGH_INTERVALS) {
    const ms = MS[it]
    const found = await timed(`全量残桶体检 ${it}`, () =>
      findStaleBuckets(it, now - STALE_CHECK_BUCKETS * ms, scope, symbols.map(v => v.symbol))
    )
    stale += found.length
    for (const sv of found) {
      if (samples.length < 5) {
        samples.push(
          `${sv.symbol}/${it} @${new Date(sv.openTime).toISOString()} ` +
            `库里 close=${sv.ours.close} 而 1m 重算=${sv.from1m.close}`
        )
      }
      const st = [...states.values()].find(v => v.sym.symbol === sv.symbol)
      if (st && queueRepair(st, sv.openTime)) queued++
    }
  }
  console.log(
    `[kline] 全量残桶体检（${reason}）：发现 ${stale} 个对不上的高周期桶，排进修复队列 ${queued} 个` +
      (samples.length ? ` —— 例：${samples.join('；')}` : '')
  )
  return {stale, queued, samples}
}

const reconStats = {
  lastAt: 0,
  lastSource: '',
  checked: 0,
  compared: 0,
  mismatched: 0,
  missing: 0,
  badSeries: 0,
  lastError: ''
}
let reconning = false

/** 数值比对：价格是同一个数过一遍 IEEE754，量是「60 个 double 相加」vs 交易所自己的和 ⇒ 末位可能差一点 */
function closeEnough(a: number, b: number): boolean {
  if (a === b) return true
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9)
}

/** 比一个（币 × 周期）：库里最近 `RECON_BARS` 根 vs 交易所同段，逐字段比 OHLCV */
async function reconOne(
  sym: PerpSymbol,
  it: HighInterval,
  source: string,
  scope: {exchange: string; marketType: string},
  now: number
): Promise<KlineReconRow> {
  const ms = MS[it]
  const row: KlineReconRow = {
    symbol: sym.symbol,
    interval: it,
    fromTime: now,
    toTime: now,
    compared: 0,
    mismatched: 0,
    missing: 0,
    firstBadAt: null,
    detail: [],
    source,
    ok: true
  }
  const ours = await readRecentCandles(it, sym.symbol, RECON_BARS, scope)
  if (!ours.length) {
    row.detail = [{note: '库里没有这个币这一档的数据（新上市 / 非 swap / 超出保留窗）'}]
    return row
  }
  row.fromTime = ours[0].timestamp
  row.toTime = ours[ours.length - 1].timestamp + ms
  const official = closedOnly(
    await paced(`对账 ${it} ${sym.pair}`, 2, () =>
      fetchCandlesRange({
        exchangeId: cfg!.exchange,
        symbol: sym.symbol,
        timeframe: it,
        from: row.fromTime,
        to: now,
        marketType: cfg!.marketType,
        apiBase: cfg!.apiBase,
        maxCandles: RECON_BARS + 10
      })
    ),
    ms,
    now
  )
  const theirs = new Map<number, Candle>()
  for (const b of official) if (b.timestamp >= row.fromTime) theirs.set(b.timestamp, b)
  for (const b of ours) {
    const t = theirs.get(b.timestamp)
    if (!t) {
      row.missing++
      row.firstBadAt ??= b.timestamp
      if (row.detail.length < 5) row.detail.push({at: new Date(b.timestamp).toISOString(), why: '交易所没有这根'})
      continue
    }
    theirs.delete(b.timestamp)
    row.compared++
    for (const f of ['open', 'high', 'low', 'close', 'volume'] as const) {
      if (closeEnough(b[f], t[f])) continue
      row.mismatched++
      row.firstBadAt ??= b.timestamp
      if (row.detail.length < 5) {
        row.detail.push({at: new Date(b.timestamp).toISOString(), field: f, ours: b[f], theirs: t[f]})
      }
      break
    }
  }
  for (const ts of theirs.keys()) {
    row.missing++
    row.firstBadAt ??= ts
    if (row.detail.length < 5) row.detail.push({at: new Date(ts).toISOString(), why: '我们缺这根'})
  }
  row.ok = row.mismatched === 0 && row.missing === 0
  return row
}

/**
 * 第 3 档：抽样对账（每日 + 手动）。
 *
 * 选币**按天轮换**（`dayIndex * 3 + k` 取模）—— 不随机是为了可复现：出问题能算出"那天比了谁"。
 */
export async function runKlineRecon(source: string): Promise<{
  checked: number
  compared: number
  mismatched: number
  missing: number
  bad: number
}> {
  if (reconning) throw new Error('对账正在跑')
  if (!cfg || !symbols.length) throw new Error('底座还没就绪（拿不到合约清单）')
  reconning = true
  const scope = {exchange: cfg.exchange, marketType: cfg.marketType}
  const now = Date.now()
  try {
    const dayIndex = Math.floor(now / (24 * 60 * 60_000))
    const picks: PerpSymbol[] = []
    const taken = new Set<string>()
    for (let k = 0; picks.length < Math.min(RECON_SYMBOLS, symbols.length) && k < symbols.length; k++) {
      const s = symbols[(dayIndex * RECON_SYMBOLS + k) % symbols.length]
      if (taken.has(s.symbol)) continue
      taken.add(s.symbol)
      picks.push(s)
    }
    const rows: KlineReconRow[] = []
    for (const s of picks) {
      for (const it of HIGH_INTERVALS) {
        rows.push(await reconOne(s, it, source, scope, now))
      }
    }
    await saveKlineRecon(rows)
    const compared = rows.reduce((a, r) => a + r.compared, 0)
    const mismatched = rows.reduce((a, r) => a + r.mismatched, 0)
    const missing = rows.reduce((a, r) => a + r.missing, 0)
    const bad = rows.filter(r => !r.ok).length
    reconStats.lastAt = now
    reconStats.lastSource = source
    reconStats.checked = rows.length
    reconStats.compared = compared
    reconStats.mismatched = mismatched
    reconStats.missing = missing
    reconStats.badSeries = bad
    reconStats.lastError = ''
    const who = picks.map(p => p.pair).join('/')
    if (bad) {
      const first = rows.find(r => !r.ok)!
      console.warn(
        `[kline] 对账（${source}）⚠️ ${who}：${rows.length} 组里 ${bad} 组不一致，` +
          `比了 ${compared} 根（差 ${mismatched} / 缺 ${missing}）—— 首个：` +
          `${first.interval} ${first.symbol} ${first.firstBadAt ? new Date(first.firstBadAt).toISOString() : ''}`
      )
    } else {
      console.log(
        `[kline] 对账（${source}）：${who} × 5 档，逐字段比了 ${compared} 根，全部一致 ✅`
      )
    }
    return {checked: rows.length, compared, mismatched, missing, bad}
  } catch (e) {
    reconStats.lastError = (e as Error).message
    throw e
  } finally {
    reconning = false
  }
}

/* ---------------- 合约发现（生命周期：新币 / 下架） ----------------
 *
 * 用户 2026-10-07 的口径：「如果行情有更新，比如有新币，或者新币种下架了，再去调整它的历史
 * 然后订阅」。所以这里只做三件事：
 *   ① 发现（每天一次 + 启动一次 + 读路径按需触发一次）
 *   ② 新币：加进清单 + 追加 SUBSCRIBE（**不用重连**）+ 让它进灌历史那一轮
 *   ③ 下架：**先用交易所口径把最后一段补完**，再退订 + 摘除；库里历史一行不删
 *
 * ⚠️ 摘除前"补完最后一段"不是可选项：高周期的最后一根可能是**桶没走完就断流**的残桶，
 *    而 4h/1d 是**永久保留**的 —— 不补就会在永久档位里留下一条错的收盘价
 *    （2026-10-07 那次 4h `83850.1` vs 交易所 `84104.9` 就是同一类问题的"遗留版"）。
 */

/**
 * 加一个刚上线（或我们之前漏掉）的合约：进清单 + 追加订阅 + 交给灌历史。
 * 返回 true = 真加进去了 —— 调用方**必须**按它计数（被上限挡下不算"新增"，
 * 不然日志会写"新增 3 个"实际一个没加，跟缺口巡检那次是同一个教训）。
 */
function addSymbol(c: RawContract): boolean {
  const key = c.pair.toUpperCase()
  if (states.has(key)) return false
  if (maxSymbols > 0 && symbols.length >= maxSymbols) {
    if (!capWarned) {
      capWarned = true
      console.warn(
        `[kline] 发现到新合约 ${c.pair}，但订阅数已到上限 ${maxSymbols}（KLINE_RECORDER_MAX）⇒ 不加`
      )
    }
    return false
  }
  const sym: PerpSymbol = {symbol: c.symbol, pair: c.pair, base: c.base}
  symbols.push(sym)
  states.set(key, {
    sym,
    lastClosedMs: 0,
    aggs: new Map(),
    coveredAt: 0,
    repairedAt: 0,
    silentRetryAt: 0
  })
  subscribedSymbols.add(c.symbol)
  lifecycle.set(c.symbol, {status: c.status, onboardAt: c.onboardAt, delistedAt: null})
  if (sock?.readyState === 1) {
    send({
      method: 'SUBSCRIBE',
      params: [`${c.pair.toLowerCase()}@kline_1m`],
      id: ++subSeq
    })
    console.log(
      `[kline] 新合约 ${c.pair} → 已追加订阅 1m（上线 ${
        c.onboardAt ? new Date(c.onboardAt).toISOString() : '时间未知'
      }）`
    )
  } else {
    /* 连接还没开：`open()` 的 `on('open')` 会按当时的 `symbols` 重新订一遍 ⇒ 覆盖到它 */
    console.log(`[kline] 新合约 ${c.pair} → 已加进清单（连接没开，重连时一起订）`)
  }
  return true
}

/**
 * 摘掉一个不再交易的合约：退订 → 从清单和内存里拿掉。返回 true = 真摘了。
 *
 * 用户 2026-10-07 的口径：「下线就不需要了，k 线也没必要统计」⇒ **不补最后一段**。
 * 这一版最初想"摘之前先用交易所口径补完"，实测发现那是错的：币安对已下架的币**照样返回
 * K 线**，但全是**量 0 的水平线** —— 补下去等于往 4h/1d（永久保留）里塞假数据。
 * 所以现在的规矩是：**它停在哪就是哪**，一条也不补。
 */
async function dropSymbol(pair: string, why: string): Promise<boolean> {
  const key = pair.toUpperCase()
  const st = states.get(key)
  if (!st || !cfg) return false
  states.delete(key)
  live1m.delete(st.sym.symbol)
  subscribedSymbols.delete(st.sym.symbol)
  const i = symbols.findIndex(v => v.pair.toUpperCase() === key)
  if (i >= 0) symbols.splice(i, 1)
  const prev = lifecycle.get(st.sym.symbol)
  /* 表里那份（`upsertSymbols`）已经按"TRADING → 非 TRADING 那一刻"记了时间；
     这里只是把内存镜像也标上，省得读路径还要为它去问发现结果 */
  lifecycle.set(st.sym.symbol, {
    status: 'DELISTED',
    onboardAt: prev?.onboardAt ?? null,
    delistedAt: prev?.delistedAt ?? Date.now()
  })
  if (sock?.readyState === 1) {
    send({
      method: 'UNSUBSCRIBE',
      params: [`${st.sym.pair.toLowerCase()}@kline_1m`],
      id: ++subSeq
    })
  }
  console.log(
    `[kline] 合约下架 ${st.sym.pair}（${why}）：已退订、已从清单摘除（不补数据 —— ` +
      `下架后交易所给的是量 0 的假 K 线）；库里已有的历史不动`
  )
  return true
}

/**
 * 跑一次合约发现（**不要直接调它**，读路径要用 `requestDiscovery` 走去抖那条）。
 *
 * 也导出给管理接口手动触发（`GET /api/kline/contracts?run=1`）。
 */
export async function discoverContracts(
  reason: string
): Promise<{raw: number; trading: number; added: number; dropped: number}> {
  if (discovering) throw new Error('合约发现正在跑')
  if (!cfg) throw new Error('底座还没就绪')
  discovering = true
  try {
    const raw = await paced('合约发现', 1, () =>
      fetchExchangeInfoRaw({exchangeId: cfg!.exchange, apiBase: cfg!.apiBase})
    )
    const {add, drop} = planContractChanges(raw, symbols)
    let added = 0
    for (const c of add) if (addSymbol(c)) added++
    let dropped = 0
    for (const d of drop) dropped += (await dropSymbol(d.pair, '不在 TRADING 清单里')) ? 1 : 0
    const capBlocked = add.length - added
    /* 内存镜像跟着原始清单走（**注意在 add/drop 之后**，别被上面覆盖掉） */
    for (const c of raw) {
      const prev = lifecycle.get(c.symbol)
      lifecycle.set(c.symbol, {
        status: c.status,
        onboardAt: c.onboardAt ?? prev?.onboardAt ?? null,
        delistedAt: c.status === 'TRADING' ? null : (prev?.delistedAt ?? Date.now())
      })
    }
    const written = await upsertSymbols(
      raw.map(c => ({
        exchange: cfg!.exchange,
        marketType: cfg!.marketType,
        pair: c.pair,
        symbol: c.symbol,
        base: c.base,
        status: c.status,
        onboardAt: c.onboardAt
      }))
    )
    const trading = raw.filter(c => c.status === 'TRADING').length
    discoveryStats.lastAt = Date.now()
    discoveryStats.lastReason = reason
    discoveryStats.lastRaw = raw.length
    discoveryStats.lastTrading = trading
    discoveryStats.added += added
    discoveryStats.dropped += dropped
    discoveryStats.lastError = ''
    /* ⚠️ 别把币名全列出来：本地只订 8 个时，"新增"会是 517 个 —— 一行日志几十 KB */
    const show = (pairs: string[]): string =>
      pairs.length > 8 ? `${pairs.slice(0, 8).join('/')}…（共 ${pairs.length}）` : pairs.join('/')
    const tail =
      add.length || drop.length
        ? `，新增 ${added} 个${add.length ? `（${show(add.map(a => a.pair))}）` : ''}` +
          `，下架 ${dropped} 个${drop.length ? `（${show(drop.map(d => d.pair))}）` : ''}` +
          (capBlocked ? `，其中 ${capBlocked} 个被订阅上限挡住` : '')
        : '，没有变化'
    console.log(
      `[kline] 合约发现（${reason}）：原始 ${raw.length} 个（TRADING ${trading}），` +
        `订阅 ${symbols.length} 个，落表 ${written} 行${tail}`
    )
    if (added) void seedHistory()
    return {raw: raw.length, trading, added, dropped}
  } catch (e) {
    discoveryStats.lastError = (e as Error).message
    throw e
  } finally {
    discovering = false
  }
}

/**
 * **按需发现**：读路径遇到一个"在合约范围里、但底座没订阅"的币时顺手调它。
 *
 * 为什么要有：新币上线后的头几个小时正是最想看图的时候，而每天一次那轮最多晚 24 小时。
 * 它不加轮询 —— 只是把"每天那一次判定"提前到"你关心的那一刻"。
 * 全局去抖 `DISCOVERY_MIN_GAP_MS`（一次就拿到全市场，重复打没意义）；
 * 单币的去抖在读路径那边（负缓存），两边合起来把成本压到 ~0。
 */
export function requestDiscovery(reason: string): void {
  if (stopped || !cfg || discovering) return
  if (Date.now() - lastDiscoveryAt < DISCOVERY_MIN_GAP_MS) return
  lastDiscoveryAt = Date.now()
  void discoverContracts(reason).catch(e =>
    console.warn(`[kline] 合约发现失败（${reason}）：${(e as Error).message.slice(0, 120)}`)
  )
}

/** 这个（统一符号）币底座订阅了吗 —— 读路径用它决定要不要按需发现 */
export function isSymbolSubscribed(symbol: string): boolean {
  return subscribedSymbols.has(symbol)
}

/** 生命周期查询（内存，0 I/O）：读路径用它避开"已下架"的币 */
export function symbolLifecycleOf(symbol: string): Lifecycle | undefined {
  return lifecycle.get(symbol)
}

/** 当前订阅了几个合约（自检用；`symbols` 会随发现增删，别缓存） */
export function subscribedSymbolCount(): number {
  return symbols.length
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
  const scope = {exchange: cfg.exchange, marketType: cfg.marketType}
  const have = await maxOpenTimes('1m', symbols.map(s => s.symbol), scope)
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
        const out: NewCandleRow[] = closedOnly(rows, MIN_MS).map(c => ({
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
  const scope = {exchange: cfg.exchange, marketType: cfg.marketType}
  const have = new Map<HighInterval, Map<string, number>>()
  for (const it of HIGH_INTERVALS) {
    have.set(it, await maxOpenTimes(it, symbols.map(s => s.symbol), scope))
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
        const out: NewCandleRow[] = closedOnly(rows, MS[job.it]).map(c => ({
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
    const r = await pruneCandles()
    if (r.partitions.length) {
      /* 分区路径：丢掉整片子分区（秒级、零死行）—— 这才是保留期的常态 */
      console.log(
        `[kline] 分级清理：丢掉 ${r.partitions.length} 片子分区（≈${r.rows} 行）：` +
          `${r.partitions.join('、')}`
      )
    } else if (r.rows) {
      /* 老库（未迁移）路径：按 scope + 档位分批删 */
      console.log(`[kline] 分级清理：删掉 ${r.rows} 行（1m/5m >7天、15m >30天、1h >400天）`)
    }
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
  /*
   * 分区先就位再写任何一行：跨天/跨月的那一刻如果没建好，晚到的帧会落进 DEFAULT 兜底分区
   * （不丢，但要多一次搬迁）。幂等、几十毫秒。
   */
  await timed('分区维护', () => ensureCandlePartitions())
  symbols = await listPerpetualSymbols({exchangeId: cfg.exchange, apiBase: cfg.apiBase})
  const max = Number(process.env.KLINE_RECORDER_MAX || 0)
  if (Number.isFinite(max) && max > 0) symbols = symbols.slice(0, max)
  if (!symbols.length) throw new Error('拿不到合约清单（markets 里没有 U 本位永续）')
  maxSymbols = max
  for (const s of symbols) {
    states.set(s.pair.toUpperCase(), {
      sym: s,
      lastClosedMs: 0,
      aggs: new Map(),
      coveredAt: 0,
      repairedAt: 0,
      silentRetryAt: 0
    })
    subscribedSymbols.add(s.symbol)
  }
  /*
   * 生命周期镜像：先读库里那份（上次发现的结果）—— 这样**第一次发现跑完之前**，
   * 读路径就已经知道哪些币是下架的（省掉一轮没用的按需发现）。
   */
  try {
    const rows = await loadSymbols(c.exchange, c.marketType)
    for (const r of rows) {
      lifecycle.set(r.symbol, {
        status: r.status,
        onboardAt: r.onboardAt ? r.onboardAt.getTime() : null,
        delistedAt: r.delistedAt ? r.delistedAt.getTime() : null
      })
    }
    if (rows.length) console.log(`[kline] 生命周期：从库里读回 ${rows.length} 个合约`)
  } catch (e) {
    console.warn(`[kline] 读生命周期表失败（不影响运行）：${(e as Error).message.slice(0, 100)}`)
  }
  console.log(`[kline] 底座启动：${symbols.length} 个合约，1 条上游连接（只订 1m）`)
  await open()
  timers.push(setInterval(() => void timed('落库', flush), FLUSH_MS))
  timers.push(setInterval(logStats, STATS_MS))
  timers.push(setInterval(() => void timed('分级清理', prune), PRUNE_EVERY_MS))
  timers.push(setInterval(checkWatchdog, WATCHDOG_MS))
  timers.push(setInterval(() => void timed('补缺口', repairTick), REPAIR_TICK_MS))
  /* 第 2 档：存在性检查（0 权重）。第一次等一个周期，别跟启动那轮 seed/repair 抢 */
  timers.push(setInterval(() => void timed('缺口巡检', () => runGapCheck('定时')), GAP_CHECK_MS))
  /* 分区维护：跨零点/跨月/跨年时建新的时间子分区（幂等，几毫秒），顺手丢过期分区 */
  timers.push(
    setInterval(() => void timed('分区维护', ensureCandlePartitions), PARTITION_TICK_MS)
  )
  /* 第 3 档：抽样对账。启动 15 分钟后第一轮（那之后 seed 基本灌完，比出来才有意义） */
  if ((process.env.KLINE_RECON ?? '').toLowerCase() !== 'off') {
    timers.push(
      setTimeout(() => {
        void runKlineRecon('daily').catch(e =>
          console.warn(`[kline] 对账失败：${(e as Error).message.slice(0, 140)}`)
        )
      }, RECON_FIRST_MS)
    )
    timers.push(
      setInterval(() => {
        void runKlineRecon('daily').catch(e =>
          console.warn(`[kline] 对账失败：${(e as Error).message.slice(0, 140)}`)
        )
      }, RECON_EVERY_MS)
    )
  }
  /* 灌历史可以被打断（限流让路）⇒ 定期续一轮；幂等：已经跟到现在的币会跳过 */
  timers.push(setInterval(() => void seedHistory(), SEED_RETRY_MS))
  for (const t of timers) t.unref()
  /* 合约发现：启动一次（进程重启通常比 24 小时频繁，等于多几次免费对齐）+ 之后每天一次 */
  timers.push(setInterval(() => requestDiscovery('定时'), DISCOVERY_EVERY_MS))
  void discoverContracts('启动').catch(e =>
    console.warn(`[kline] 合约发现失败（启动）：${(e as Error).message.slice(0, 120)}`)
  )
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
  live1m.clear()
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
  /** 上游好久没推帧的币数（多半是停牌/下架；也可能是我们那条流静默死了） */
  silentSymbols: number
  partialAggs: number
  rowsWritten: number
  rowFailures: number
  dropped: number
  repairedSymbols: number
  backfilled1m: number
  /** 直连交易所补回来的**高周期**行数（2026-10-08 起：哪档缺就直连哪档） */
  repairedHigh: number
  seeded: number
  seedLimited: number
  pendingRepairs: number
  /** 内存里「当前那根」的币数（读热层从这里取当前根，见 `currentBar()`） */
  liveBars: number
  openSec: number
  lastFrameSecAgo: number
  /** 第 1 档：写入前校验丢了什么（按原因） */
  rejected: ReturnType<typeof candleRejectStats>
  /** 第 2 档：最近一次缺口巡检 */
  gaps: typeof gapStats
  /** 第 3 档：最近一次抽样对账 */
  recon: typeof reconStats
  /** 合约发现（生命周期）：最近一次的结果 + 累计增删 */
  discovery: typeof discoveryStats & {subscribed: number; lifecycle: number}
  /**
   * 每个维护任务的耗时（`lastMs` / 跑过几次 / 慢过几次）。
   *
   * 2026-10-08 加的：那天「服务器为什么慢」只能靠 ssh 进去手工量（`pg_stat_activity`
   * + `EXPLAIN` + 我的探针），最后才发现是巡检一轮 4 分 40 秒在占磁盘。
   * 有了这张表，慢会自己出现在接口和日志里 —— 不用再问人。
   */
  tasks: Record<string, {lastMs: number; lastAt: number; runs: number; slow: number}>
  /** 待复核的高周期桶（`kline_pending_check`）：账目数与最老那条多久了 */
  pendingCheck: {rows: number; oldestSecAgo: number}
  lastError: string
}

export async function klineRecorderStats(): Promise<KlineRecorderStats> {
  /* 账目数读库：小表（常态几十行），但要防它拖慢这个诊断接口 */
  const pending = await pendingCheckStats().catch(() => ({rows: -1, oldestMs: null}))
  return {
    enabled: started && !stopped,
    connected: sock?.readyState === 1,
    symbols: symbols.length,
    covered: [...states.values()].filter(s => s.coveredAt > 0).length,
    closedBars: stats.closedBars,
    minuteGaps: stats.minuteGaps,
    silentSymbols: stats.silentSymbols,
    partialAggs: stats.partialAggs,
    rowsWritten: stats.rowsWritten,
    rowFailures: stats.rowFailures,
    dropped: stats.dropped,
    repairedSymbols: stats.repairedSymbols,
    backfilled1m: stats.backfilled1m,
    repairedHigh: stats.repairedHigh,
    seeded: stats.seeded,
    seedLimited: stats.seedLimited,
    pendingRepairs: repairQueue.size,
    liveBars: live1m.size,
    openSec: openSince ? Math.round((Date.now() - openSince) / 1000) : 0,
    lastFrameSecAgo: lastFrameAt ? Math.round((Date.now() - lastFrameAt) / 1000) : -1,
    rejected: candleRejectStats(),
    gaps: {...gapStats},
    recon: {...reconStats},
    discovery: {...discoveryStats, subscribed: symbols.length, lifecycle: lifecycle.size},
    tasks: Object.fromEntries(Object.entries(taskStats).map(([k, v]) => [k, {...v}])),
    pendingCheck: {
      rows: pending.rows,
      oldestSecAgo: pending.oldestMs ? Math.round((Date.now() - pending.oldestMs) / 1000) : -1
    },
    lastError: stats.lastError
  }
}
