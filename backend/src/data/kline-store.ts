/**
 * 服务端「最新 N 根」的读路径：**内存 → 库 → REST**（2026-10-07 P1 定稿）。
 *
 * ★ 核心事实：**已收盘的 K 线永不改变，只有「当前那根」在动**。
 *   一次要 300 根，其中 299 根是死的 —— 死的那部分根本不该反复问交易所。
 *
 * 三层各干什么：
 *   ① **内存**：每个 `(币, 周期)` 的**已收盘**那串留在进程里，永不设 TTL
 *      （不变的东西没什么好过期的）；
 *   ② **库**（`candles` 表，底座常驻写）：内存没有 / 跨过一个桶了，就去库里读一份。
 *      本地库毫秒级往返、**0 权重** —— 这就是把「预热/保活」整套删掉的底气：
 *      以前怕冷启动打交易所，现在冷启动只是读一次本地库；
 *   ③ **REST**：库里没有（非 swap、新上市、超出保留窗口）或者**库太旧**
 *      （底座挂了，最后那根明显过期）才退回交易所。
 *
 * 「当前那根」**不进这三层**：它永远从底座内存现取（`currentBar()`，0 I/O）——
 * 那根每 250ms 在动，缓存它等于给自己埋一个"图表慢半拍"的坑。
 *
 * ⇒ 上游成本：**常态 0**（只有库里查不到 / 库过期才发请求），
 *   而 2026-10-04 那版是「每次冷启 528 个币 × 每 4 秒」，还带一条 `MAX_WAIT_MS`
 *   的跨热线阻塞（实测撞上游抖动时让用户等 13 秒）。
 */
import {Candle, MarketType, Timeframe} from '../types'
import {TF_MS, fetchCandles} from './market'
import {
  candleSpan,
  readRangeCandles,
  readRecentCandles,
  unifiedPerpSymbol
} from '../db/candle-store'
import {currentBar} from './kline-recorder'

/** 首次取多少根（比 `limit` 多留一点，缩放时不必马上再取） */
const INIT_BARS = 300
/** 单条最多留多少根（防内存） */
const MAX_BARS = 1200
/**
 * 最多存多少个 `(币, 周期)`，超了淘汰最久没用的。
 * 一份 300 根 ≈ 30KB → 600 份 ≈ 18MB（容器只有 909MB，别再往上加）。
 */
const MAX_KEYS = 600
/** 只有「不带 from/to 且 limit 不大」的请求走这里；历史区间 / 超大 limit 照旧直接打交易所 */
export const STORE_MAX_LIMIT = 600
/**
 * 库里至少要有这么多根才认它。
 * 低于这个数说明「底座没订阅过这个币」（新上市 / 非 swap）⇒ 退回 REST。
 * 取 50 而不是"必须凑够 limit"：新上市的币交易所也只有几十根，来回退 REST 纯浪费。
 */
const DB_MIN_BARS = 50
/**
 * 库里最后一根**已收盘**的桶如果比这还旧，就认为底座不健康（挂了 / 断流），退回 REST。
 * 正常情况最后一根的收盘时刻离现在最多一个周期。
 */
const STALE_AFTER = (tf: Timeframe): number => 2 * TF_MS[tf] + 5 * 60_000

export interface LatestArgs {
  exchangeId: string
  symbol: string
  timeframe: Timeframe
  limit: number
  marketType?: MarketType
  apiBase?: string
}

interface Entry {
  /** **已收盘**的那串（当前根不在这里，见 `currentBar()`） */
  candles: Candle[]
  /** 上次刷新的时刻 */
  at: number
  /** 这份是从哪来的（诊断用）：db / rest */
  from: 'db' | 'rest' | 'none'
  /** 正在飞的刷新：同一个 key 复用它，并发用户不会把同一份数据取 N 遍 */
  inflight: Promise<void> | null
}

const store = new Map<string, Entry>()

/** 诊断用：这一轮各层各命中多少次（验证 P1 时看它，`/api/kline/recorder?db=1`） */
const hits = {memory: 0, db: 0, rest: 0, live: 0, liveStale: 0, rangeDb: 0, rangeRest: 0}

/**
 * 这次请求落在「底座覆盖的那个市场」里吗？
 *
 * ⚠️ 只有 binance + U 本位永续（swap）在库里 / 底座内存里有数据。
 *    现货、币本位**必须**退回 REST —— 而且**当前那根也不能拿合约的顶上**
 *    （2026-10-07 校正：第一版漏了这句，现货图表会混进合约的当前根）。
 */
function inRecorderScope(a: LatestArgs): boolean {
  return a.exchangeId === 'binance' && (a.marketType ?? 'swap') === 'swap'
}

/** key 里**不带 limit**：「最新 250 根」和「最新 300 根」是同一份数据，切一刀就行 */
function keyOf(a: LatestArgs): string {
  return `${a.exchangeId}|${a.marketType ?? 'swap'}|${a.symbol}|${a.timeframe}`
}

/** LRU：用过的挪到末尾，超了就丢队首 */
function touch(k: string, e: Entry): void {
  store.delete(k)
  store.set(k, e)
}

function evict(): void {
  while (store.size > MAX_KEYS) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/** 兜底：直接问交易所要「最新 N 根」（含当前那根） */
function loadFull(a: LatestArgs, bars: number): Promise<Candle[]> {
  return fetchCandles({
    exchangeId: a.exchangeId,
    symbol: a.symbol,
    timeframe: a.timeframe,
    limit: bars,
    marketType: a.marketType,
    apiBase: a.apiBase
  })
}

/**
 * 刷新某个条目的**已收盘**那串：先库，库不行再 REST。
 *
 * ⚠️ 这里只存已收盘的部分。REST 那一发会把**当前那根**也带回来，
 *    得把它切掉 —— 否则「内存里那份」和「现取的当前根」会对同一根桶打架。
 */
async function doRefresh(a: LatestArgs, e: Entry, bars: number): Promise<void> {
  const scope = {exchange: a.exchangeId, marketType: a.marketType ?? 'swap'}
  if (inRecorderScope(a)) {
    // 请求里传的是 `BTC` 这种，库里存的是 `BTC/USDT:USDT`（主键前缀，走索引）
    const rows = await readRecentCandles(
      a.timeframe,
      unifiedPerpSymbol(a.symbol),
      bars,
      scope
    )
    const last = rows[rows.length - 1]
    if (rows.length >= Math.min(bars, DB_MIN_BARS) && last && Date.now() - last.timestamp <= STALE_AFTER(a.timeframe)) {
      e.candles = rows
      e.at = Date.now()
      e.from = 'db'
      hits.db++
      return
    }
  }
  const fresh = await loadFull(a, Math.max(bars, INIT_BARS))
  if (fresh.length) {
    // REST 会把「正在走的那根」也带回来 ⇒ 按当前那根的桶边界切掉
    const step = TF_MS[a.timeframe]
    const cur = Math.floor(Date.now() / step) * step
    e.candles = fresh.filter(c => c.timestamp < cur)
  }
  e.at = Date.now()
  e.from = 'rest'
  hits.rest++
}

/** 同一个 key 同时在飞就复用那个 promise */
function refresh(a: LatestArgs, e: Entry, bars: number): Promise<void> {
  if (e.inflight) return e.inflight
  const p: Promise<void> = (async () => {
    try {
      await doRefresh(a, e, bars)
    } finally {
      e.inflight = null
    }
  })()
  e.inflight = p
  return p
}

/**
 * 拿「最新的 N 根」（最后一根是**正在走的那根**）。
 *
 * 快路：内存里那份还没跨过桶 ⇒ 直接切 + 现取当前根（0 I/O）。
 * 跨过桶了 ⇒ 刷一次（库，毫秒级；库里没有才打交易所），**不再阻塞等上游**。
 */
export async function getLatestCandles(a: LatestArgs): Promise<Candle[]> {
  const k = keyOf(a)
  let e = store.get(k)
  if (!e) {
    e = {candles: [], at: 0, from: 'none', inflight: null}
    store.set(k, e)
    evict()
  } else {
    touch(k, e)
  }

  const step = TF_MS[a.timeframe]
  const need = Math.min(a.limit, MAX_BARS)
  const newest = e.candles[e.candles.length - 1]
  // 最后一根已收盘的桶走完了 ⇒ 该有新的一根了，刷新（本地库，用户不会察觉）
  const rolled = !newest || Date.now() - newest.timestamp >= step
  if (e.candles.length < need || rolled) {
    try {
      await refresh(a, e, need)
    } catch (err) {
      // 刷新失败：有旧数据就先用旧的（前端那条 WS 会把当前那根修正）
      if (!e.candles.length) throw err
    }
  } else {
    hits.memory++
  }

  const out = e.candles.slice(-a.limit)
  const last0 = out[out.length - 1]
  /* ⚠️ 现货 / 币本位不进这里：底座只覆盖 U 本位永续，拼上去就是「图里混了另一个市场」 */
  const live = inRecorderScope(a) ? await currentBar(unifiedPerpSymbol(a.symbol), a.timeframe) : null
  const last = last0
  if (live && (!last || live.timestamp > last.timestamp)) {
    out.push(live)
    hits.live++
  } else if (live && last && live.timestamp === last.timestamp) {
    out[out.length - 1] = live
    hits.live++
  } else if (live) {
    hits.liveStale++
  }
  return out.slice(-a.limit)
}

/**
 * 区间请求（`from`/`to`，前端的「往前拖看更早」与「选某一刻」）：
 * **库里够就走库**（毫秒级、0 权重），库外返回 null 让调用方照旧打交易所。
 *
 * 为什么要它：这条分支以前完全在 P1 之外，每次往前拖一段都是 230ms + 权重 5，
 * 而这段历史在库里查一次 **0.34ms**（实测，走 `candles_ivl_symbol_time_idx`）。
 *
 * ⚠️ 判断口径：整个 `[from, to]` 都落在库里已有的 `[first, last]` 之内才算够
 *    （差一点点都不算 —— 少了头或尾就会跟 REST 那段拼不齐）。
 * ⚠️ 库只有**已收盘**的桶：区间右端贴着「现在」时，最后一根可能还没收盘 ⇒
 *    这根本来也不该画成定局，前端那条 WS 会把当前根补上。
 * ⚠️ 返回空数组也算「够」（那段真的没有数据），返回 null 才是「别问我，去 REST」。
 */
export async function getRangeCandles(a: {
  exchangeId: string
  symbol: string
  timeframe: Timeframe
  limit: number
  from: number
  to: number
  marketType?: MarketType
}): Promise<Candle[] | null> {
  if (!inRecorderScope(a)) {
    hits.rangeRest++
    return null
  }
  const symbol = unifiedPerpSymbol(a.symbol)
  const scope = {exchange: a.exchangeId, marketType: a.marketType ?? 'swap'}
  const span = await candleSpan(a.timeframe, symbol, scope)
  if (!span || a.from < span.first || a.to > span.last) {
    hits.rangeRest++
    return null
  }
  const out = await readRangeCandles(a.timeframe, symbol, a.limit, a.from, a.to, scope)
  hits.rangeDb++
  return out
}

/** 诊断用：现在维护了多少个 `(币, 周期)` 与各层命中次数 */
export function klineStoreStats(): {
  keys: number
  dbKeys: number
  restKeys: number
  hits: {
    memory: number
    db: number
    rest: number
    live: number
    liveStale: number
    rangeDb: number
    rangeRest: number
  }
} {
  let dbKeys = 0
  let restKeys = 0
  for (const e of store.values()) {
    if (e.from === 'db') dbKeys++
    else if (e.from === 'rest') restKeys++
  }
  return {keys: store.size, dbKeys, restKeys, hits: {...hits}}
}

