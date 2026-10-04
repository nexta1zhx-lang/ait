/**
 * 服务端「常驻」K 线缓存。
 *
 * ★ 核心事实：**已收盘的 K 线永不改变，只有「当前那根」在动** ——
 *   一次取 250 根，其中 249 根是死的。
 *
 * 原来 `handleCandles` 走的是通用 `candlesCache`（TTL **4 秒**）—— 等于每 4 秒就把
 * 250 根整体重取一遍。前端「全量预热」一次要点 528 个币，那就是 **528 次真实上游请求**，
 * 而且**每个用户各来一遍**：用户一多，币安权重立刻打满。
 *
 * 这里换成「存起来 + 只补尾巴」：
 *   · 每个 `(交易所, 币, 周期)` 在内存里留一份，**没有硬 TTL**（不变的历史不值得反复取）；
 *   · 什么时候重取？**「最后一根已经不是当前那根」的时候** ——
 *     即 `now - lastBarTs >= 一个周期`：跨过热线了，得把尾巴补齐
 *     （顺便把上一根的收线修正 —— 它当时还没走完）。
 *   · 平时只做「补尾巴」：从最后一根取到此刻，通常就 2 根，**不是 250 根**。
 *
 * ⇒ 上游成本 = **O(活跃的 (币, 周期) 数 ÷ 周期长度)**，**与用户数无关**：
 *   528 个币全是 1h ≈ 0.15 次/秒；全是 5m ≈ 1.8 次/秒。而原来是 8.3 次/秒 **× 用户数**。
 *
 * 另外「当前那根旧了」（超过 `TAIL_MAX_AGE`）只在**后台**补，用户永远不等 ——
 * 反正前端那条 K 线 WS 本来就会把当前这一根推到最新。
 */
import {Candle, MarketType, Timeframe} from '../types'
import {TF_MS, fetchCandles, fetchCandlesRange} from './market'

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
 * 「当前那根」最多允许旧多久。
 * 超过就先给旧的、**后台**补一次尾巴（用户不等）；前端那条 WS 会把当前这根推到最新。
 */
const TAIL_MAX_AGE = 60_000
/**
 * 「跨热线补齐」最多让用户等这么久。
 *
 * ⚠️ 实测（2026-10-04）上游抖一下，这一发能到 **13 秒**（币安 TLS 抖动 + `withRetry` 重试）。
 * 超时就把旧数据先给出去（只差当前这一根，前端 WS 会补），后台那次刷新继续跑。
 */
const MAX_WAIT_MS = 1_500

export interface LatestArgs {
  exchangeId: string
  symbol: string
  timeframe: Timeframe
  limit: number
  marketType?: MarketType
  apiBase?: string
}

interface Entry {
  /**
   * 建这个条目时用的参数（交易所 / 币 / 周期 / 市场类型 / apiBase）。
   *
   * ⚠️ 后台保活（`startKlineKeepWarm`）要按它去补尾巴 —— 光有一个 key 拼不回参数。
   */
  args: LatestArgs
  candles: Candle[]
  /** 上次**成功**取数的时间（`TAIL_MAX_AGE` 用它） */
  at: number
  /** 正在飞的刷新：同一个 key 复用它，并发用户不会把同一份数据取 N 遍 */
  inflight: Promise<void> | null
  /**
   * 上次「补了尾巴但最后一根没往前走」的时刻。
   *
   * ⚠️ 保活靠「最后一根是不是旧了」判断该不该补 —— 但**停牌 / 下架的币新数据永远长不出来**，
   *    不拦一下就会每 10 秒去问一次上游（白烧权重）。所以补完没变化就退避一段。
   */
  stuckAt?: number
}

const store = new Map<string, Entry>()

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/** key 里**不带 limit**：「最新 250 根」和「最新 300 根」是同一份数据，切一刀就行 */
function keyOf(a: LatestArgs): string {
  return `${a.exchangeId}|${a.marketType ?? 'swap'}|${a.symbol}|${a.timeframe}`
}

/** 同 ts 替换、更新的 append —— 跟前端 `applyTail` 是同一套逻辑 */
function merge(target: Candle[], fresh: Candle[]): void {
  for (const c of fresh) {
    const last = target[target.length - 1]
    if (!last) target.push(c)
    else if (c.timestamp === last.timestamp) target[target.length - 1] = c
    else if (c.timestamp > last.timestamp) target.push(c)
  }
  if (target.length > MAX_BARS) target.splice(0, target.length - MAX_BARS)
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

/** 补尾巴：**从最后一根（含）取到此刻** —— 顺便把上一根没走完的收线修正掉 */
function loadTail(a: LatestArgs, lastTs: number): Promise<Candle[]> {
  const now = Date.now()
  const step = TF_MS[a.timeframe]
  const bars = Math.min(
    MAX_BARS,
    Math.max(2, Math.ceil((now - lastTs) / step) + 2)
  )
  return fetchCandlesRange({
    exchangeId: a.exchangeId,
    symbol: a.symbol,
    timeframe: a.timeframe,
    from: lastTs,
    to: now,
    marketType: a.marketType,
    apiBase: a.apiBase,
    maxCandles: bars
  })
}

async function doRefresh(
  a: LatestArgs,
  e: Entry,
  full: boolean
): Promise<void> {
  const last = e.candles[e.candles.length - 1]
  if (!full && last) {
    merge(e.candles, await loadTail(a, last.timestamp))
  } else {
    const fresh = await loadFull(
      a,
      Math.min(MAX_BARS, Math.max(a.limit, INIT_BARS))
    )
    // ⚠️ 只在真拿到数据时才替换，别把好用的旧数据冲掉
    if (fresh.length) e.candles = fresh
  }
  e.at = Date.now()
}

/** 同一个 key 同时在飞就复用那个 promise */
function refresh(a: LatestArgs, e: Entry, full: boolean): Promise<void> {
  if (e.inflight) return e.inflight
  const p: Promise<void> = (async () => {
    try {
      await doRefresh(a, e, full)
    } finally {
      e.inflight = null
    }
  })()
  e.inflight = p
  return p
}

/**
 * 拿「最新的 N 根」。
 *
 * 正常路径全部命中内存；只有三种情况才打上游：
 *   ① 这个 `(币, 周期)` 没存过 → 整体取一次；
 *   ② 跨过热线了 → **补齐再给**（少一根 / 收线没修正是不能忍的，这个分支每个周期才一次）；
 *   ③ 只是当前那根旧了 → **后台**补，用户不等。
 */
export async function getLatestCandles(a: LatestArgs): Promise<Candle[]> {
  const k = keyOf(a)
  let e = store.get(k)
  if (!e) {
    e = {args: a, candles: [], at: 0, inflight: null}
    store.set(k, e)
    evict()
  } else {
    touch(k, e)
  }

  const step = TF_MS[a.timeframe]
  const last = e.candles[e.candles.length - 1]
  const rolled = !!last && Date.now() - last.timestamp >= step

  try {
    if (!e.candles.length || e.candles.length < Math.min(a.limit, INIT_BARS)) {
      await refresh(a, e, true)
    } else if (rolled) {
      /*
       * 跨过热线：**先补齐再返回**，否则客户端会拿到
       * （a）少一根、或者（b）上一根收线还是「当时没走完」的值。
       * 它的客户端 WS 只推「当前那一根」，补不回这些 —— 所以不能等它兜。
       *
       * ⚠️ 但**最多等 `MAX_WAIT_MS`**（实测上游抖动时这一发能到 13 秒）——
       * 超时就把旧数据先给出去，后台那次刷新继续跑，下一个请求就对了。
       */
      await Promise.race([
        refresh(a, e, false).catch(() => {}),
        sleep(MAX_WAIT_MS)
      ])
    } else if (Date.now() - e.at > TAIL_MAX_AGE) {
      // 当前那根旧了：先给旧的、后台补
      void refresh(a, e, false).catch(() => {})
    }
  } catch (err) {
    // 刷新失败：有旧数据就先用旧的（前端 WS 会把当前那根修正）
    if (!e.candles.length) throw err
  }

  return e.candles.slice(-a.limit)
}

/** 诊断用：现在维护了多少个 `(币, 周期)` */
export function klineStoreSize(): number {
  return store.size
}

/* ---------------- 保活：别让「看过一次的币」过一会儿又变冷 ---------------- */

/**
 * 多久扫一遍。只有真的「跨过热线」的条目才会发请求，扫本身不花钱。
 *
 * 10 秒是有讲究的：**整点那一刻，所有 1h 条目会同时跨线** ——
 * 扫得太稀（比如 60 秒），这中间点进来的人就要一起阻塞等补尾巴。
 */
const KEEP_WARM_EVERY_MS = 10_000
/** 一圈最多补几条（别一次把上游打爆） */
const KEEP_WARM_MAX = 40
/** 同一圈里的并发：上游一发 ~150ms，8 条并发能把整点那一波压到一秒内 */
const KEEP_WARM_CONC = 8
/** 「补了也长不出新数据」的条目退避多久再去试（停牌 / 下架的币） */
const KEEP_WARM_STUCK_MS = 10 * 60_000

let keepWarmTimer: ReturnType<typeof setInterval> | null = null

/**
 * 后台保活：把「尾巴已经跨过热线」的条目**提前**补一遍。
 *
 * 为什么需要（用户 2026-10-04：「不是添加了行情预热功能吗 60 个币种怎么还是慢」）：
 *   这个缓存没有硬 TTL，但 `getLatestCandles` 里有个「跨热线」判定 ——
 *   最后那根已经不是「当前那根」了（`now - last.timestamp >= 一个周期`），
 *   下一次请求就得**阻塞着**等一次尾部补取（实测 ~150ms，撞上游抖动能到 1.5s）。
 *   ⇒ **一个 `(币, 周期)` 只要超过「一个周期」没人看，下次点它就要等**
 *     （1h 图一小时、15m 图 15 分钟、5m 图 5 分钟）。
 *   于是启动预热的效果**只顶一个周期那么久**，之后 60 个币跟没预热差不多。
 *
 * 这里在后台把它们提前补上：用户来的时候永远是「没跨线」那条快路。
 * 成本可控：只有跨线的条目才发请求，而一个条目**一个周期才跨一次**
 *   ⇒ 600 个条目全是 1h 也才 0.17 次/秒。
 */
export function startKlineKeepWarm(): void {
  if (keepWarmTimer) return
  keepWarmTimer = setInterval(keepWarmRound, KEEP_WARM_EVERY_MS)
  // 别因为这条定时器让进程退不出去
  keepWarmTimer.unref()
}

/**
 * 一轮保活：挑出「跨过热线」的条目，并发补一遍尾巴。
 *
 * ⚠️ 整个包在 `try` 里 —— 这是条 `setInterval`，抛出去就是**进程级**未捕获异常。
 *    保活失败顶多慢一拍，绝不能把整个服务带下去。
 */
function keepWarmRound(): void {
  try {
    const now = Date.now()
    const due: string[] = []
    for (const [k, e] of store) {
      if (e.inflight || !e.args) continue
      // 刚试过、上游也没给新数据（停牌 / 下架）→ 退避一会儿再说
      if (e.stuckAt && now - e.stuckAt < KEEP_WARM_STUCK_MS) continue
      const last = e.candles[e.candles.length - 1]
      if (!last) continue
      // 还热着（没跨热线）就不动它
      if (now - last.timestamp < TF_MS[e.args.timeframe]) continue
      due.push(k)
      if (due.length >= KEEP_WARM_MAX) break
    }
    if (!due.length) return
    /*
     * 并发跑，但一圈只开这么多：整点那一刻几十个 1h 会同时跨线，
     * 串行补要几十秒，这期间点进来的人全在等 —— 并发才能把窗口压到一秒内。
     */
    let i = 0
    const worker = (): void => {
      const k = due[i++]
      if (k === undefined) return
      const e = store.get(k)
      if (!e || !e.args || e.inflight) return worker()
      const args = e.args
      void refresh(args, e, false)
        .then(() => {
          /*
           * 补完**还跨着线** = 上游根本没有更新的数据（停牌 / 下架）→ 退避一段，
           * 否则这个条目会被每 10 秒问一次上游，白烧权重。
           * 反过来它只要真的往前走了一步（用户那次刷新也算），退避就清掉。
           */
          const bar = e.candles[e.candles.length - 1]
          e.stuckAt =
            bar && Date.now() - bar.timestamp >= TF_MS[args.timeframe]
              ? Date.now()
              : 0
        })
        .catch(() => {
          /* 保活失败无所谓：用户真来的时候会自己补 */
        })
        .then(worker)
    }
    for (let n = 0; n < Math.min(KEEP_WARM_CONC, due.length); n++) worker()
  } catch (err) {
    console.warn(`[kline] 缓存保活出错：${(err as Error).message}`)
  }
}
