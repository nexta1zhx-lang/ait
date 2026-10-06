/**
 * 极简缓存：**TTL + 单飞 + 出错留旧**（2026-10-06 加，改造 P3 的第二步）。
 *
 * 为什么要有它：有些接口虽然「按需查交易所」是对的（挂单是秒级变化的东西，
 * 不适合塞进快照），但**前端一秒里问它三次也没必要** —— 而且每问一次都是
 * 币安权重，限流按**出口 IP** 算，一台服务器所有用户共用一份预算。
 *
 * 三件事：
 *   · **TTL**：`ttlMs` 之内的重复请求直接命中，不打交易所（把一秒钟里的 N 次合成一发）；
 *   · **单飞**：TTL 过期时并发进来，也只有一个真的出去（`inflight` 那层）；
 *   · **出错留旧**：拉失败就把上一次的结果顶着 —— 一次网络抖动不该让界面变空。
 *
 * ⚠️ 只给**只读**路径用。写操作（下单 / 撤单 / 清理）之后要调 `bump()` 作废，
 *    否则界面会拿撤掉的单继续画线（用户 2026-10-06 抱怨过这类「撤了还在」）。
 */
export interface TtlCache<V> {
  /** 读（命中就返回；过期就 `load()` 一次，并发合并；失败退回旧值） */
  get(key: string | number, load: () => Promise<V>): Promise<V>
  /** 作废（写操作之后调；不传 key = 全清） */
  bump(key?: string | number): void
  /** 只看看现在有什么（不打交易所；调试 / 判断是否命中用） */
  peek(key: string | number): {at: number; value: V} | undefined
}

export function createTtlCache<V>(opts: {
  ttlMs: number
  /** 出错发日志时用的名字 */
  tag: string
}): TtlCache<V> {
  const hits = new Map<string | number, {at: number; value: V}>()
  const inflight = new Map<string | number, Promise<V>>()

  return {
    async get(key, load) {
      const now = Date.now()
      const hit = hits.get(key)
      if (hit && now - hit.at < opts.ttlMs) return hit.value

      const flying = inflight.get(key)
      if (flying) return flying

      const run = (async (): Promise<V> => {
        try {
          const value = await load()
          hits.set(key, {at: Date.now(), value})
          return value
        } catch (e) {
          console.warn(
            `[cache:${opts.tag}] ${String(key)} 拉取失败：${(e as Error).message.slice(0, 140)}`
          )
          /* 有旧的先顶着；一次都没有才把错误抛上去 */
          if (hit) return hit.value
          throw e
        }
      })()

      inflight.set(key, run)
      try {
        return await run
      } finally {
        if (inflight.get(key) === run) inflight.delete(key)
      }
    },

    bump(key) {
      if (key === undefined) hits.clear()
      else hits.delete(key)
    },

    peek(key) {
      return hits.get(key)
    }
  }
}
