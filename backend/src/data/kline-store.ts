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
  candles: Candle[]
  /** 上次**成功**取数的时间（`TAIL_MAX_AGE` 用它） */
  at: number
  /** 正在飞的刷新：同一个 key 复用它，并发用户不会把同一份数据取 N 遍 */
  inflight: Promise<void> | null
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
    e = {candles: [], at: 0, inflight: null}
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
