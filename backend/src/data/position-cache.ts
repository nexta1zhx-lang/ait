/**
 * 合约持仓的**单一数据源 + 去重缓存**（2026-10-06 改造 P1 / P3）。
 *
 * ## 为什么要有这个文件
 *
 * 改造前持仓有**三个互不相干的取数方**：
 *   · 交易所界面 —— 读库里那份快照（`exchange_snapshots`，靠 WS 事件才更新）
 *   · K 线叠加   —— 自己每 15 秒打一次 `/api/exchange/trade/positions`
 *   · 下单页仓位 —— 又自己每 15 秒打一次同一个接口
 * 后果有两层：
 *   ① **同一屏两个数**：左栏（快照，可能是几分钟前的）和图上的持仓线（刚拉的）
 *      会同时显示两个不同的数字 —— 用户 2026-10-06 就是这么发现的；
 *   ② **请求翻倍**：每多一个消费者就多一路轮询，全打到交易所，而限流是按 IP 算的。
 *
 * 现在这里当**唯一的账本**：
 *   · `exchange-stream.ts` 的常驻流是**主写入方**（REST 快照 + 标记价重算都往这儿写）；
 *   · `GET /api/exchange/trade/positions` 改成**读这里**，不再直连交易所
 *     （只有「这条流没在跑」时才退回 REST，而且带 TTL + 单飞 + 权重预算）；
 *   · 写进来就**广播**给 SSE 订阅者 → 所有前端页面看到的永远是同一份。
 *
 * ## ⚠️ 两个口径别混
 *
 * `LivePosition.symbol` 是 **ccxt 统一写法**（`BTC/USDT:USDT`）—— 跟
 * `exchange-overview.ts` 里那份对齐，因为**交易所界面**（板子、平仓按钮）吃这个；
 * `LivePosition.raw` 是**币安原始符号**（`BTCUSDT`）—— K 线叠加 / 下单页按它比对。
 * 两个都带上，两拨消费者各取所需，不用各自再去换一次。
 *
 * ⚠️ 「行情重算」只是**展示口径**：钱的事仍以 REST 快照为准（见 docs/EXCHANGE.md
 *    那条「WS 不能替代 REST」）。所以 `live` 只是个标记，不改变对账逻辑。
 */
import {listPositions, type FuturesPositionRow} from './exchange-trade'
import {takeWeight} from '../util/rate-budget'
import type {ExchangeCredentials} from './exchange-account'
import type {ExchangeOverview, FuturesPosition as OverviewPosition} from './exchange-overview'

type Stats = ExchangeOverview['stats']

/** 一条持仓：ccxt 统一符号（给板子）+ 币安原始符号（给 K 线叠加 / 下单页） */
export interface LivePosition extends OverviewPosition {
  /** 币安原始符号，如 `BTCUSDT` */
  raw: string
}

/** 内存里这一套 key 的持仓状态 */
export interface LiveState {
  /** 数据时间（毫秒） */
  at: number
  /** 写这份数据的时候有没有叠加过「行情重算」 */
  live: boolean
  /** 合约钱包余额（不含浮盈）—— 算保证金余额要用 */
  wallet: number
  positions: LivePosition[]
  /** Σ 未实现盈亏 */
  unrealized: number
  /** 保证金余额 = 钱包 + 浮盈（净资产里合约那半，跟 REST 同一个口径） */
  margin: number
  stats: Stats
}

/**
 * 推给前端的**增量**（SSE 事件 `positions`）。
 *
 * 只带会随行情变的那几项：`wallet` / `assets` / `c2c` / `spot` 这些
 * 跟标记价无关的字段**不动**，前端拿着这份往已有快照上盖就行。
 */
export interface PositionsPatch {
  at: string
  live: boolean
  wallet: number
  unrealized: number
  margin: number
  stats: Stats
  positions: LivePosition[]
}

export interface PositionsEvent {
  type: 'positions'
  patch: PositionsPatch
}

/* ---------------- 状态 ---------------- */

const states = new Map<number, LiveState>()
/** 这条 key 的常驻流在不在跑（在跑就信任内存，不必打交易所） */
const streamActive = new Map<number, boolean>()
/** SSE 订阅者 */
const listeners = new Map<number, Set<(ev: PositionsEvent) => void>>()
/** 退回 REST 时那一发的结果（短 TTL，把多个轮询合成一发） */
const rowsCache = new Map<number, {at: number; rows: FuturesPositionRow[]}>()
/** 正在飞的那一发（单飞） */
const inflight = new Map<number, Promise<FuturesPositionRow[]>>()

/** 没有常驻流时，REST 结果缓存多久（多个轮询器合成一发） */
const REST_TTL_MS = 5_000
/** 有常驻流时，内存快照可以信多久（流自己有事件触发 + 5 分钟采样兜底） */
const TRUST_STREAM_MS = 90_000

function r8(x: number): number {
  return Math.round(x * 1e8) / 1e8
}

/**
 * 用**标记价本地重算**一条持仓的未实现盈亏（改造 P4）。
 *
 * ⚠️ 这是**展示口径**：币安 `positionRisk` 回的 `unRealizedProfit` 才是对账口径。
 *    两边算法一致（(标记价 − 开仓价) × 数量 × 方向），差别只在于**取哪个时刻的标记价**
 *    —— 所以 REST 快照一到就把它整个盖掉（`publishLive(..., live: false)`），不累积误差。
 *
 * 口径说明（U 本位 / linear）：
 *   · 未实现盈亏 = (标记价 − 开仓价) × 持仓量 × 方向（空头方向为 −1）
 *   · 名义价值  = |持仓量| × 标记价
 *   · ROE(%)    = 未实现盈亏 / 起始保证金 × 100，起始保证金 = 名义价值 / 杠杆
 *
 * `amount` 是基础币数量（ccxt 的 `contracts`），U 本位合约正好 1:1。
 */
export function withMark<T extends OverviewPosition>(
  p: T,
  mark: number | undefined
): T {
  if (!mark || !(mark > 0) || !(p.entryPrice > 0) || !(p.amount > 0)) return p
  const dir = p.side === 'short' ? -1 : 1
  const unrealized = (mark - p.entryPrice) * p.amount * dir
  const notional = Math.abs(p.amount) * mark
  const margin = p.leverage > 0 ? notional / p.leverage : 0
  return {
    ...p,
    markPrice: mark,
    unrealizedPnl: r8(unrealized),
    notional: r8(notional),
    percentage: margin > 0 ? r8((unrealized / margin) * 100) : p.percentage
  }
}

function statsOf(positions: LivePosition[]): Stats {
  let longCount = 0
  let notional = 0
  let unrealized = 0
  for (const p of positions) {
    if (p.side !== 'short') longCount++
    notional += p.notional
    unrealized += p.unrealizedPnl
  }
  return {
    longCount,
    shortCount: positions.length - longCount,
    notional: r8(notional),
    unrealized: r8(unrealized)
  }
}

/* ---------------- 订阅（给 SSE 用） ---------------- */

export function subscribePositions(
  keyId: number,
  fn: (ev: PositionsEvent) => void
): () => void {
  let set = listeners.get(keyId)
  if (!set) {
    set = new Set()
    listeners.set(keyId, set)
  }
  const bucket = set
  bucket.add(fn)
  return () => {
    bucket.delete(fn)
    if (!bucket.size) listeners.delete(keyId)
  }
}

function emit(keyId: number, patch: PositionsPatch): void {
  const set = listeners.get(keyId)
  if (!set?.size) return
  for (const fn of set) {
    try {
      fn({type: 'positions', patch})
    } catch {
      /* 一个订阅者出错别连累别人（比如 SSE 往一个已经断掉的响应里写） */
    }
  }
}

/* ---------------- 写入（由常驻流调用） ---------------- */

export function setStreamActive(keyId: number, active: boolean): void {
  streamActive.set(keyId, active)
}

/**
 * 常驻流把最新持仓写进来 —— **主写入口**。
 *
 * 每写一次就广播一次，前端所有页面（交易所板子 / K 线叠加 / 下单页）
 * 拿到的都是这一份，不会再出现「同一屏两个数」。
 */
export function publishLive(
  keyId: number,
  input: {
    wallet: number
    positions: LivePosition[]
    live: boolean
    at?: number
  }
): LiveState {
  const stats = statsOf(input.positions)
  const state: LiveState = {
    at: input.at ?? Date.now(),
    live: input.live,
    wallet: r8(input.wallet),
    positions: input.positions,
    unrealized: stats.unrealized,
    /* 保证金余额 = 钱包 + 浮盈（跟 REST 的 totalMarginBalance 同一个算法） */
    margin: r8(input.wallet + stats.unrealized),
    stats
  }
  states.set(keyId, state)
  /* 内存里已经有更新的了，REST 那份短缓存就没用了 */
  rowsCache.delete(keyId)
  emit(keyId, {
    at: new Date(state.at).toISOString(),
    live: state.live,
    wallet: state.wallet,
    unrealized: state.unrealized,
    margin: state.margin,
    stats: state.stats,
    positions: state.positions
  })
  return state
}

/** 内存里那份（调试 / 内部用） */
export function liveStateOf(keyId: number): LiveState | null {
  return states.get(keyId) ?? null
}

/** 这套 key 的流在跑吗 */
export function isStreamActive(keyId: number): boolean {
  return streamActive.get(keyId) === true
}

/* ---------------- 读取（给 `/api/exchange/trade/positions` 用） ---------------- */

/** `LivePosition` → 对外那条 REST 形状（币安原始符号 + `unrealized` 字段名） */
function toRow(p: LivePosition): FuturesPositionRow {
  return {
    symbol: p.raw,
    /* 快照那边 `side` 是宽 string，这里收窄成对外那个联合类型 */
    side: p.side === 'short' ? 'short' : 'long',
    amount: p.amount,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    unrealized: p.unrealizedPnl,
    notional: p.notional,
    leverage: p.leverage,
    liquidationPrice: p.liquidationPrice
  }
}

/**
 * 拿持仓（K 线叠加 / 下单页那条接口用的形状）。
 *
 * 顺序：
 *   ① 内存里有常驻流写的数据 → **直接用**（不打交易所，跟板子同源）；
 *   ② 没有、或者流停了太久 → 退回 REST，但**带 TTL + 单飞 + 权重预算**：
 *      · TTL 把同一秒内 N 个轮询器合成一发；
 *      · 单飞保证并发进来只有一发真的出去；
 *      · 预算保证不会把出口 IP 打进 `-1003`。
 *
 * ⚠️ 失败时**返回旧数据**（有的话），别让界面因为一次网络抖动变空。
 */
export async function getPositions(
  keyId: number | undefined,
  c: ExchangeCredentials,
  opts: {maxAgeMs?: number; force?: boolean} = {}
): Promise<FuturesPositionRow[]> {
  if (!keyId) return fetchRows(null, c)

  /*
   * ⚠️ `force` 必须**两个缓存都跳过** —— 只跳内存那份的话，
   * 还会被 `rowsCache`（REST 结果 5s TTL）挡住，下单/平仓之后照样看不到新仓位。
   */
  if (!opts.force) {
    const now = Date.now()
    const live = states.get(keyId)
    if (live) {
      const maxAge =
        opts.maxAgeMs ?? (isStreamActive(keyId) ? TRUST_STREAM_MS : REST_TTL_MS)
      if (now - live.at < maxAge) return live.positions.map(toRow)
    }

    const hit = rowsCache.get(keyId)
    if (hit && now - hit.at < REST_TTL_MS) return hit.rows
  }

  return fetchRows(keyId, c)
}

/**
 * 真的去打一次交易所（带单飞 + 预算）。
 *
 * ⚠️ 失败时**有旧的先顶着** —— 拉不到不能把界面清空（那比数字旧一会儿糟得多）；
 *    一发都没有才把错误抛上去，让接口回一句人话。
 */
async function fetchRows(
  keyId: number | null,
  c: ExchangeCredentials
): Promise<FuturesPositionRow[]> {
  if (keyId) {
    const flying = inflight.get(keyId)
    if (flying) return flying
  }

  /* 这一发本身就是「去重的那个」：并发进来的后来者直接 await 它 */
  const run = (async (): Promise<FuturesPositionRow[]> => {
    try {
      await takeWeight(5, 'positionRisk')
      const rows = await listPositions(c)
      if (keyId) rowsCache.set(keyId, {at: Date.now(), rows})
      return rows
    } catch (e) {
      const stale = keyId ? rowsCache.get(keyId) : undefined
      console.warn(
        `[positions] ${keyId ? `key ${keyId} ` : ''}读持仓失败：${(e as Error).message.slice(0, 140)}`
      )
      if (stale) return stale.rows
      throw e
    }
  })()

  if (!keyId) return run

  inflight.set(keyId, run)
  try {
    return await run
  } finally {
    if (inflight.get(keyId) === run) inflight.delete(keyId)
  }
}
