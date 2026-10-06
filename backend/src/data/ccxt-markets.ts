import {loadMarketsStore, saveMarketsStore} from '../db/ccxt-markets'

/**
 * ccxt 的 `markets`（币安 `exchangeInfo`，约 1.1MB）**落库复用**：
 * 启动从库里灌回去（0 网络），过期才后台重下；认不出的符号立即重下一次。
 * （以前它只在内存，每次进程重启都要重下 —— 本地隧道 25 秒 > ccxt 默认 10 秒超时。）
 */
export interface MarketsEntry {
  markets: Record<string, unknown>
  at: number
}

/** 库里那份 markets 在内存里的副本（`createExchange` 是同步的，等不了库） */
const cache = new Map<string, MarketsEntry>()

/** markets 多久重下一次（用户：每天一次就够；上新 / 改精度这些变动很慢） */
export const MARKETS_TTL_MS = 24 * 60 * 60 * 1000

/** `loadMarkets()` 的下载时限：ccxt 默认 10 秒，隧道下不够 */
export const MARKETS_TIMEOUT_MS = 30_000

/** markets 是公开数据 ⇒ 键里**不带 Key**：同一个交易所 / 市场类型 / 环境几套账户共用一份 */
export function marketsKeyOf(
  exchangeId: string,
  marketType: string,
  env: string
): string {
  return [exchangeId, marketType, env].join('|')
}

/** 启动时把库里的 markets 读进内存（`server.ts` 开头调，早于任何实例创建） */
export async function hydrateMarketsCache(): Promise<void> {
  const rows = await loadMarketsStore()
  for (const r of rows) cache.set(r.key, {markets: r.markets, at: r.updatedAt.getTime()})
  if (rows.length)
    console.log(`  交易所  markets 从库里载入 ${rows.length} 份（${rows.map(r => r.key).join(' / ')}）`)
}

/** 库里这份是不是够新 */
function fresh(key: string): boolean {
  const hit = cache.get(key)
  return !!hit && Date.now() - hit.at < MARKETS_TTL_MS
}

/** 同一个 key 同时在下的那一发（下 1.1MB 很贵，并发调用只等这一发，别各下一份） */
const inflight = new Map<string, Promise<void>>()

/** 真去下一次，成功就落库 + 更新内存。认不出符号时也复用它 */
export function reloadMarkets(ex: any, key: string): Promise<void> {
  const cur = inflight.get(key)
  if (cur) return cur
  const p = doReload(ex, key).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function doReload(ex: any, key: string): Promise<void> {
  const keep = ex.timeout
  ex.timeout = MARKETS_TIMEOUT_MS
  try {
    /* ⚠️ 必须 `true`：ccxt 不传就是「已经有了就直接返回」，等于没重下 */
    await ex.loadMarkets(true)
  } catch (e) {
    console.warn(`[exch] markets 载入失败：${(e as Error).message.slice(0, 110)}`)
    throw e
  } finally {
    ex.timeout = keep
  }
  const markets = ex.markets as Record<string, unknown>
  cache.set(key, {markets, at: Date.now()})
  await saveMarketsStore(key, String(ex.id ?? ''), markets).catch((e: Error) =>
    console.warn(`[exch] markets 落库失败：${e.message.slice(0, 80)}`)
  )
}

/**
 * 实例建好后调一次：库里那份直接 `setMarkets()` 灌进去（0 网络），
 * 只有「库里没有 / 超过一天」才在后台重下。
 */
export function attachMarkets(ex: any, key: string): void {
  if (ex.__marketsAttached) return
  ex.__marketsAttached = true
  const hit = cache.get(key)
  if (hit) ex.setMarkets(hit.markets)
  /*
   * ⚠️ ccxt `loadMarkets()` 只在 `marketsLoading === undefined` 时才真去下载，
   *    失败后**不清**这个字段 ⇒ 之后每次调用都拿到同一个 rejected promise、
   *    毫秒级立刻失败（报的还是第一次那句超时）。所以这里补上清理。
   */
  const raw = ex.loadMarkets.bind(ex)
  ex.loadMarkets = (...args: unknown[]) =>
    raw(...args).catch((e: unknown) => {
      ex.marketsLoading = undefined
      throw e
    })
  if (!fresh(key)) void reloadMarkets(ex, key).catch(() => undefined)
}

/** 实例缓存过期（到了 TTL）时用：库里那份也旧了才重下，否则只是把实例寿命续上 */
export function refreshMarketsIfStale(ex: any, key: string): Promise<void> {
  return fresh(key) ? Promise.resolve() : reloadMarkets(ex, key)
}

/** ccxt 认不出这个符号（多半是币安刚上新，库里那份还没刷到） */
function unknownSymbol(e: unknown): boolean {
  return /BadSymbol|does not have market|market.*not found/i.test(
    (e as Error)?.message ?? ''
  )
}

/**
 * 认不出符号 → 重下一次 markets → 重试同一件事（用户：「认不出来再调一次」）。
 * 只包**带交易对**的那几个方法。
 */
export function retryUnknownSymbol(ex: any, key: string): void {
  for (const m of ['fetchOpenOrders', 'createOrder', 'editOrder', 'cancelOrder']) {
    if (typeof ex[m] !== 'function') continue
    const raw = ex[m].bind(ex)
    ex[m] = (...args: unknown[]) =>
      raw(...args).catch(async (e: unknown) => {
        if (!unknownSymbol(e)) throw e
        console.warn(
          `[exch] 认不出符号（${(e as Error).message.slice(0, 60)}）⇒ 重刷 markets 再试一次`
        )
        await reloadMarkets(ex, key)
        return raw(...args)
      })
  }
}
