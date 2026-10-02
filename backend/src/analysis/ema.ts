/**
 * EMA42 —— 用户明确说「不是必要看的指标」：
 *
 *   · **只在看回调的时候**参考（回踩确认 / 回踩不破 / 回调到均线附近）
 *   · **只用在 15m 和 1h 上**，4h / 1d 不给
 *
 * 所以它不算「每个周期都算一遍的口径」，只在 `market.ts` 造 15m / 1h 那两块时顺手算出来，
 * 挂在 `SeriesBlock.ema42` 上；`context/builder.ts` 只负责把它写成一行文字。
 *
 * ⚠️ 只给**数值**（现值 / 价格在上还是下 / 斜率），不下结论 —— 怎么用是 AI 的事。
 */

export const EMA_PERIOD = 42
/** 看斜率时回看多少根 */
export const EMA_SLOPE_BARS = 10
/** 斜率小于这个百分比就算「走平」 */
const FLAT_PCT = 0.05

export interface Ema42Info {
  /** 均线现值 */
  value: number
  /** 现价相对均线的百分比（正 = 在上方） */
  diffPct: number
  /** 近 N 根均线自身的变化百分比 */
  slopePct: number
  slope: 'up' | 'flat' | 'down'
}

/** 指数移动平均。首值拿前 period 根的简单平均打底（几百根后误差早衰减掉了） */
export function emaSeries(closes: number[], period = EMA_PERIOD): number[] {
  if (!closes.length) return []
  const k = 2 / (period + 1)
  const seedLen = Math.min(period, closes.length)
  let seed = 0
  for (let i = 0; i < seedLen; i++) seed += closes[i]
  const out = [seed / seedLen]
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i] * k + out[i - 1] * (1 - k))
  }
  return out
}

/**
 * 一组 K 线的 EMA42 概览；根数太少（< 2）返回 null。
 * `price` 不给就用最后一根收盘价。
 */
export function ema42Of(
  candles: {close: number}[],
  price?: number
): Ema42Info | null {
  const closes = candles
    .map(c => Number(c?.close))
    .filter(v => Number.isFinite(v) && v > 0)
  if (closes.length < 2) return null

  const series = emaSeries(closes)
  const value = series[series.length - 1]
  const prev = series[Math.max(0, series.length - 1 - EMA_SLOPE_BARS)]
  const last = Number.isFinite(price)
    ? Number(price)
    : closes[closes.length - 1]
  const diffPct = ((last - value) / value) * 100
  const slopePct = ((value - prev) / prev) * 100
  return {
    value,
    diffPct,
    slopePct,
    slope: Math.abs(slopePct) < FLAT_PCT ? 'flat' : slopePct > 0 ? 'up' : 'down'
  }
}
