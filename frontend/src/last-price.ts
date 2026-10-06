/**
 * **最新成交价**（「现价」）—— 持仓卡上第一格那个数（2026-10-06）。
 *
 * 为什么要它：合约里「现价」和「标记价」是**两个数**
 *   · 现价（last）= 最新一笔成交价，人看图看的是它；
 *   · 标记价（mark）= 币安按几家的价加权算出来的「防插针价」，**强平 / 浮盈都按它算**。
 * 持仓接口里只有标记价，所以「当前价」得从行情那边取 —— 用户拍的就是这一条：
 * 「接最新成交价：给持仓的币挂一条全市场行情流（后端已在跑 /api/tickers/stream，
 * 零权重、每秒一批，只用一次 /api/markets 当底稿）」。
 *
 * ⚠️ 这条流是**全市场**的（币安 `!ticker@arr`，一条流管所有币，不吃权重），
 *    所以「挂一条」对多个页面就是同一条连接 —— `api.ts` 的 `sharedSse` 会按 path 复用。
 *
 * ⚠️ 只留**屏幕上真正要看的那几个币**（`bindLastPrices` 的 `wanted`）：
 *    每批增量有几百个币，整张表都写进响应式对象的话，Vue 每秒要重算一遍全场，
 *    而持仓可能只有三个币。
 */
import {ref} from 'vue'
import {fetchMarkets, tickerStream, type TickerPatch} from './api'

/**
 * 屏幕上的最新价：**币安原始交易对** → 价（`RLCUSDT` → 0.8918）。
 *
 * 只有 `wanted()` 报上来的那几个币在里面（见文件头），所以这个对象很小、赋值也不频繁。
 */
export const lastPrices = ref<Record<string, number>>({})

/** 见过的最新价（**非响应式**，含全市场；只当底稿用，别塞进模板） */
const seen = new Map<string, number>()

let stop: (() => void) | null = null
/** 谁在要哪些币（可能不止一处；每次增量问一遍并集） */
const wanters = new Set<() => string[]>()

/** 底稿只拉一次（一次 ~100KB，别重复拉） */
let baseLoaded = false

/** 归一成币安原始交易对（`RLC/USDT:USDT` 与 `RLCUSDT` 等价） */
function rawOf(symbol: string): string {
  const s = String(symbol ?? '').toUpperCase()
  return s.includes('/') ? `${s.split('/')[0]}USDT` : s
}

/** 把「想要的币」名单刷新进 `lastPrices`（只在真有变化时才换对象，别白触发重渲染） */
function flush(): void {
  const want = new Set<string>()
  for (const f of wanters) for (const s of f()) want.add(rawOf(s))
  const next: Record<string, number> = {}
  for (const p of want) {
    const v = seen.get(p)
    if (typeof v === 'number' && v > 0) next[p] = v
  }
  const cur = lastPrices.value
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(cur).length
  if (same) for (const k of keys) if (cur[k] !== next[k]) same = false
  if (!same) lastPrices.value = next
}

function applyBatch(updates: TickerPatch[]): void {
  for (const u of updates) {
    if (!u?.pair || !(u.last > 0)) continue
    seen.set(String(u.pair).toUpperCase(), u.last)
  }
  flush()
}

/** 底稿：整张合约行情表（后端 5 秒缓存，一次请求）—— 不等它也能用，只是头一秒可能是空的 */
async function loadBase(): Promise<void> {
  if (baseLoaded) return
  baseLoaded = true
  try {
    const r = await fetchMarkets()
    for (const row of r.rows ?? []) {
      if (row.pair && typeof row.last === 'number' && row.last > 0)
        seen.set(String(row.pair).toUpperCase(), row.last)
    }
    flush()
  } catch {
    /* 底稿拿不到不是错：增量每秒就来，等一两秒就有数了 */
    baseLoaded = false
  }
}

/**
 * 开始要这几个币的最新价（**返回解绑函数**）。
 *
 * ⚠️ 同一个页面可能有多个消费者（持仓卡 + 以后别的块），所以是引用计数：
 *    最后一个走了才断流 —— 而且断流走的是 `sharedSse` 的 30 秒宽限，
 *    切页来回连连接都不用重开。
 *
 * @param getWanted 现在就想要哪些币（每次增量都会问一次；给**币安原始交易对**最好，
 *                  统一写法也行，这里会归一）
 */
export function bindLastPrices(getWanted: () => string[]): () => void {
  wanters.add(getWanted)
  if (!stop) {
    stop = tickerStream(applyBatch, () => {
      /* 断够了时间又连上：中间漏掉的增量不追了，重新拉一次整表（跟行情页一个口径） */
      baseLoaded = false
      void loadBase()
    })
    void loadBase()
  }
  flush()
  return () => {
    wanters.delete(getWanted)
    if (wanters.size) return
    stop?.()
    stop = null
  }
}

/** 某个币现在的最新价（拿不到就是 `null`，界面显示「—」，别拿标记价顶上去） */
export function lastOf(symbol: string | undefined): number | null {
  if (!symbol) return null
  const v = lastPrices.value[rawOf(symbol)]
  return typeof v === 'number' && v > 0 ? v : null
}
