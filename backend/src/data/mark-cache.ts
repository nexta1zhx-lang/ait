/**
 * 标记价的「最近一条」缓存 —— **单独一个模块，专门躲开循环依赖**。
 *
 * 写的是 `data/kline-stream.ts`（WS 每 3 秒推一条 `markPriceUpdate`），
 * 读的是 `data/market.ts`（头部行情 `/api/ticker` 的首帧）：
 * 那两边的依赖方向是 market → kline-stream，而 kline-stream 又要 import market
 * （它用 `fetchCandles` / `fetchMarketList` / `fetchPremiumIndex`）—— 直接互引就是环。
 * 所以这份数据放中间，两边只依赖它。
 *
 * ⚠️ 这里**只存数据、不订阅**：谁要谁的币由 `kline-stream` 决定
 *    （目前是「有持仓的币」+「正看着的币」，见那边 `subscribeMarkPrice` 的说明）。
 */
import type {PremiumIndex} from './market'

/** `markPriceUpdate` 一条消息带的四件套（跟 `/fapi/v1/premiumIndex` 一份字段） */
export type MarkInfo = PremiumIndex

/** 缓存多久算新鲜 —— 上游 3 秒一条，给 5 条余量 */
const FRESH_MS = 15_000
/** 别无限涨（订阅集合最多也就几十个币，给足余量） */
const MAX_KEYS = 600

const cache = new Map<string, {info: MarkInfo; at: number}>()

/** `BTC/USDT:USDT` → `BTCUSDT`（跟币安流名 / premiumIndex 的 key 一个口径） */
export function rawPairOf(symbol: string): string {
  return String(symbol ?? '')
    .trim()
    .toUpperCase()
    .replace(/[:/\-\s]/g, '')
}

/** 收到一条就记下来（`kline-stream` 在分发给订阅者时顺手调） */
export function putMarkInfo(rawSymbol: string, info: MarkInfo): void {
  const raw = rawPairOf(rawSymbol)
  if (!raw) return
  if (cache.size > MAX_KEYS) cache.clear()
  cache.set(raw, {info, at: Date.now()})
}

/**
 * 这个币最近的标记价。
 *
 * @returns **新鲜的才返回**；太旧 / 没订过 → `null`，调用方自己去 REST 拿
 *          （指数价一刻不停在动，拿十分钟前的来填没有意义）
 */
export function markInfoOf(rawSymbol: string): MarkInfo | null {
  const hit = cache.get(rawPairOf(rawSymbol))
  if (!hit) return null
  return Date.now() - hit.at > FRESH_MS ? null : hit.info
}
