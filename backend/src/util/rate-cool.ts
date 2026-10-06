/**
 * 交易所**限流冷却**（2026-10-06 加）。
 *
 * 币安合约的权重是按**出口 IP** 算的（2400/分钟），一回 `-1003`
 * 就说明这个 IP 已经打满 —— 这时候**再打是纯亏**：
 * 请求照样被拒，还可能把封禁窗口拉长，而这个 IP 是我们和用户其它程序共用的。
 *
 * 实测（2026-10-06 的日志）：启动那一刻 IP 已经在限流里，`头部 ticker` 还在
 * 一路「3 次重试 × 十几次」地打 —— 一分钟里白送几十个请求，一点用没有。
 *
 * 所以：收到 `-1003` 记一个**冷却截止时间**，冷却期内的调用直接快速失败
 * （不碰网络），到点自动恢复；一个冷却窗口只打一行日志，不刷屏。
 *
 * ⚠️ 冷却时间故意短（默认 20 秒）：币安那个窗口是滑动 1 分钟，
 *    死等 1 分钟会让「用户点刷新」这种手动操作也卡住；20 秒足够让窗口滑过去一部分。
 *    `EXCHANGE_COOL_MS` 可覆盖。
 */
function coolMs(): number {
  const v = Number(process.env.EXCHANGE_COOL_MS)
  return Number.isFinite(v) && v > 0 ? v : 20_000
}

let until = 0

/** 这个错是不是「被限流了」 */
export function isRateLimitError(e: unknown): boolean {
  const s = String((e as {message?: unknown})?.message ?? e ?? '')
  return s.includes('-1003') || /\b429\b/.test(s) || /too many requests/i.test(s)
}

/**
 * 记一次限流。**返回 true 表示这确实是限流错** —— 调用方据此
 * **别再重试**（重试不是「再试一次机会」，是「再往打满的 IP 上补一刀」）。
 */
export function noteRateLimit(e: unknown): boolean {
  if (!isRateLimitError(e)) return false
  const now = Date.now()
  const wasCooling = now < until
  until = Math.max(until, now + coolMs())
  if (!wasCooling) {
    console.warn(
      `[cool] 交易所限流（-1003）—— 后端 ${Math.round(coolMs() / 1000)} 秒内不再往交易所打请求`
    )
  }
  return true
}

/** 冷却还剩多少毫秒（0 = 没在冷却） */
export function coolingLeftMs(): number {
  return Math.max(0, until - Date.now())
}

/** 限流冷却期里给用户看的一句人话 */
export function coolingMessage(): string {
  return `交易所限流中（-1003），约 ${Math.ceil(coolingLeftMs() / 1000)} 秒后自动恢复`
}
