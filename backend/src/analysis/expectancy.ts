import type {Expectancy, LlmDecision} from '../types'

/** 期望值用的默认假设胜率（页面不暴露这个输入了） */
export const DEFAULT_WIN_RATE = 0.45

/**
 * 每笔的数学期望（单位 R）：
 *
 *   E = p × 加权R − (1 − p)
 *
 * `加权R` 是按分批减仓比例算的 —— 比如 50% 在 1R、25% 在 2R、25% 在 3R，
 * 加权 R = 0.5×1 + 0.25×2 + 0.25×3 = 1.75R，而不是简单地看最后一档。
 *
 * 缺止损或没止盈时算不出来，返回 null（不是 0，别让 0 混进统计）。
 */
export function expectancyOf(
  dec: LlmDecision,
  winRate: number = DEFAULT_WIN_RATE
): Expectancy | null {
  const entry = dec.entry?.price ?? null
  const sl = dec.stopLoss ?? null
  const tps = dec.takeProfits ?? []
  if (entry === null || sl === null || entry === sl || tps.length === 0)
    return null

  const risk = Math.abs(entry - sl)
  if (!(risk > 0)) return null

  const rs = tps.map(t => Math.abs(t.price - entry) / risk)
  const totalPct = tps.reduce((s, t) => s + (t.reducePercent ?? 0), 0)

  const weightedR =
    totalPct > 0
      ? tps.reduce(
          (s, t, i) => s + ((t.reducePercent ?? 0) / totalPct) * rs[i],
          0
        )
      : Math.max(...rs)

  const p = Math.min(1, Math.max(0.01, winRate))
  const r2 = (n: number) => Math.round(n * 100) / 100
  const expectancyR = p * weightedR - (1 - p)

  return {
    winRate: p,
    weightedR: r2(weightedR),
    maxR: r2(Math.max(...rs)),
    expectancyR: r2(expectancyR),
    positive: expectancyR > 0
  }
}
