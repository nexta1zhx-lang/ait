/**
 * K 线取数的「先拿一份」层。
 *
 * ⚠️⚠️ 2026-10-04 **把「空闲时把一批币暖一遍」整块删掉了**
 *（原来有 `warmCandles` + 并入队列 + 限速 + `stopWarmCandles`，这里占了大半篇）。
 *
 * 那是「后端还没有 K 线缓存」年代的做法 —— 当时点一次币要等服务端现打交易所。
 * 现在服务端是**三层读路径**（`backend/src/data/kline-store.ts`）：内存（已收盘那串）
 * → 本地库（底座常驻写的 `candles` 表，毫秒级、0 权重）→ REST（库里没有才打交易所）。
 * 既没有需要「预热」的东西，也没有「冷启动要等一大截」这回事。
 *
 * 于是前端再暖一遍是**纯重复劳动**：服务端每个几毫秒命中，但**数据要白传一遍**
 *（60 个币 × 250 根 ≈ 1.5MB）—— 一进 `/contracts` 一个都还没点，先下 1.5MB。
 * 用户 2026-10-04：「前端为什么要请求这么多 candles」。
 *
 * 现在只剩两件事：
 *   · `prefetchCandles` —— **真点了某一行**时才先发出去（很便宜：跟随后那次画图请求
 *     共用同一个 promise，不多开一条连接）
 *   · `loadCandles` —— 画图时取；命中上面那次预取就 `cached: true`（跳过淡入淡出）
 *
 * ⚠️ key 必须跟 K 线那边**完全一致**（币种 / 周期 / 根数 / 区间），否则预取和正式请求
 *    对不上，等于白预取。根数统一用 `analyze.ts` 的 `KLINE_BARS`，别各算一份。
 */
import {fetchCandles, type Candle, type LevelSR} from './api'

export interface CandlePayload {
  candles: Candle[]
  sr: LevelSR | null
  ranged?: boolean
}

/** 预取的结果活多久（只用来「合并同一发请求」+ 判断能不能跳过淡入） */
const TTL_MS = 30_000
/** 最多记这么多份（现在只有「刚点到的那几个」，不像以前要装整批名单） */
const MAX_ENTRIES = 24

type Range = {from?: number; to?: number} | undefined
type Entry = {at: number; p: Promise<CandlePayload>}

const memo = new Map<string, Entry>()

/** key 用**请求参数的原文**拼 —— 少一个字段就会把别的币/别的区间当成同一份 */
function keyOf(
  symbol: string,
  timeframe: string,
  limit: number,
  range?: Range
): string {
  return `${symbol}|${timeframe}|${limit}|${range?.from ?? ''}|${range?.to ?? ''}`
}

function fresh(e: Entry | undefined): e is Entry {
  return !!e && Date.now() - e.at < TTL_MS
}

/** 超过上限就清一批：先扔过期的，再扔最老的（Map 保持插入顺序） */
function trim(): void {
  if (memo.size <= MAX_ENTRIES) return
  for (const [k, v] of memo) {
    if (!fresh(v)) memo.delete(k)
  }
  while (memo.size > MAX_ENTRIES) {
    const oldest = memo.keys().next().value
    if (oldest === undefined) break
    memo.delete(oldest)
  }
}

/**
 * 真去取。同一个 key 正在飞就复用那个 promise —— 预取和随后的正式请求
 * 合成一次，不会开两条连接。
 */
function request(
  symbol: string,
  timeframe: string,
  limit: number,
  range?: Range
): Promise<CandlePayload> {
  const k = keyOf(symbol, timeframe, limit, range)
  const hit = memo.get(k)
  if (fresh(hit)) return hit.p

  const p = fetchCandles(symbol, timeframe, limit, range)
  memo.set(k, {at: Date.now(), p})
  trim()
  /*
   * 预取时没人 await 它 —— 异常必须自己吞掉（否则控制台一条 unhandled rejection）。
   * 失败就丢掉条目，别让这个 key 在 TTL 内一直错着；真正读的时候会再抛一次。
   */
  p.catch(() => memo.delete(k))
  return p
}

/**
 * 点某个币时先发一次（**只在真点击时**叫它）。
 *
 * 已有 / 在飞就什么都不做；随后 `loadCandles` 会复用同一个 promise ——
 * 也就是「点的那一下就开始取」，等图表挂载时它往往已经在路上了。
 */
export function prefetchCandles(
  symbol: string,
  timeframe: string,
  limit: number,
  range?: Range
): void {
  const s = symbol.trim()
  if (!s) return
  if (fresh(memo.get(keyOf(s, timeframe, limit, range)))) return
  void request(s, timeframe, limit, range)
}

/**
 * 取 K 线。
 *
 * `cached: true` 表示这份数据是**提前拿好的** —— 调用方可以据此跳过
 * 「淡出 → 换数据 → 淡入」那套过渡（数据本来就在手上，直接画出来就行）。
 */
export function loadCandles(
  symbol: string,
  timeframe: string,
  limit: number,
  range?: Range
): Promise<{payload: CandlePayload; cached: boolean}> {
  const k = keyOf(symbol, timeframe, limit, range)
  const hit = memo.get(k)
  if (fresh(hit)) {
    memo.delete(k) // 一次性：不然后面几次都拿着同一份旧数据
    return hit.p.then(payload => ({payload, cached: true}))
  }
  return request(symbol, timeframe, limit, range).then(payload => ({
    payload,
    cached: false
  }))
}
