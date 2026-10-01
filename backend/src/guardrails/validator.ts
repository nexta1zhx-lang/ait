import {Parser} from 'expr-eval'
import {
  AppConfig,
  GuardrailCheck,
  GuardrailResult,
  LlmDecision,
  MarketSnapshot,
  PositionPlan,
  Violation
} from '../types'

const parser = new Parser()

/**
 * 红线表达式的取值域 = 行情快照变量 + 由**这次判断**派生的量。
 *
 * 快照里只有行情，没有「止损放哪」—— 那是 AI 给出的计划的一部分。
 * 但「止损回撤不能超过价格 5%」这类红线必须能引用它，所以在这里补上。
 * 没给止损时一律取 0，红线自然不会误命中。
 */
function redLineScope(
  decision: LlmDecision,
  snapshot: MarketSnapshot
): Record<string, number> {
  const entry = decision.entry?.price ?? snapshot.price
  const sl = decision.stopLoss
  const hasStop =
    typeof sl === 'number' && Number.isFinite(sl) && entry > 0 && sl !== entry
  const stopDistance = hasStop ? Math.abs(entry - (sl as number)) : 0
  const stopDistancePct = entry > 0 ? (stopDistance / entry) * 100 : 0
  const tps = decision.takeProfits ?? []
  const lastTp = tps.length ? Number(tps[tps.length - 1].price) : 0
  const firstTp = tps.length ? Number(tps[0].price) : 0

  return {
    ...snapshot.variables,
    // ── 本次判断派生 ──
    entry_price: entry,
    stop_loss: hasStop ? (sl as number) : 0,
    /** 止损距入场的百分比（无止损 = 0） */
    stop_distance_pct: stopDistancePct,
    /** 止损距入场的绝对价差 */
    stop_distance: stopDistance,
    tp1_price: firstTp,
    tp_last_price: lastTp,
    /** 末段盈亏比（无止损 = 0） */
    rr_final:
      stopDistance > 0 && lastTp > 0
        ? Math.abs(lastTp - entry) / stopDistance
        : 0,
    is_long: decision.direction === 'long' ? 1 : 0,
    is_open: decision.decision === 'open' ? 1 : 0
  }
}

/** 安全求值：只读取 scope 中已有变量，缺失或出错一律视为不命中 */
function evalWhen(expr: string, scope: Record<string, number>): boolean {
  try {
    const parsed = parser.parse(expr)
    const vars = parsed.variables()
    const filtered: Record<string, number> = {}
    for (const v of vars) filtered[v] = scope[v] ?? 0
    return Boolean(parsed.evaluate(filtered))
  } catch {
    return false
  }
}

/** 数字转字符串（自适应小数位） */
function numberToStr(n: number): string {
  return Number(n).toLocaleString('en-US', {maximumFractionDigits: 8})
}

/**
 * 确定性护栏校验：红线检查 + 方向一致性 + 盈亏比 + 仓位/杠杆计算。
 * 该层结果优先于 LLM，代码不可被模型覆盖。
 */
export function validate(
  decision: LlmDecision,
  snapshot: MarketSnapshot,
  config: AppConfig
): GuardrailResult {
  const violations: Violation[] = []
  const checks: GuardrailCheck[] = []

  // 1) 硬性红线
  const scope = redLineScope(decision, snapshot)
  for (const rl of config.redLines) {
    const hit = evalWhen(rl.when, scope)
    checks.push({
      name: `红线: ${rl.desc || rl.id}`,
      pass: !hit,
      detail: rl.when
    })
    if (hit)
      violations.push({id: rl.id, desc: rl.desc || rl.id, severity: 'reject'})
  }

  const hasReject = () => violations.some(v => v.severity === 'reject')

  // 非开仓结论：仅返回红线结果
  if (decision.decision !== 'open' || decision.direction === 'none') {
    return {
      passed: !hasReject(),
      violations,
      checks,
      position: null,
      minRr: config.minRrRatio,
      rMultiple: null
    }
  }

  const entryPrice = decision.entry.price ?? snapshot.price
  const sl = decision.stopLoss
  const isLong = decision.direction === 'long'

  // 2) 方向一致性
  if (sl === null || !Number.isFinite(sl)) {
    checks.push({name: '方向一致性', pass: false, detail: '未给出有效止损价'})
    violations.push({
      id: 'missing_stop',
      desc: '未给出止损价',
      severity: 'reject'
    })
  } else {
    const ok = isLong ? sl < entryPrice : sl > entryPrice
    checks.push({
      name: '方向一致性',
      pass: ok,
      detail: `方向=${decision.direction} 入场=${entryPrice} 止损=${sl}`
    })
    if (!ok) {
      violations.push({
        id: 'direction_mismatch',
        desc: '止损方向与开仓方向矛盾',
        severity: 'reject'
      })
    }
  }

  // 3) 仓位与杠杆（由代码计算，不采信 LLM 的算术）
  let position: PositionPlan | null = null
  if (sl !== null && Number.isFinite(sl)) {
    const stopDistance = Math.abs(entryPrice - sl)
    const riskAmount = config.accountEquity * (config.riskPercent / 100)
    const quantity = stopDistance > 0 ? riskAmount / stopDistance : 0
    const notional = quantity * entryPrice
    const requiredLeverage =
      config.accountEquity > 0 ? notional / config.accountEquity : 0
    const leverageUsed = Math.max(1, Math.ceil(requiredLeverage * 100) / 100)

    position = {
      riskPercent: config.riskPercent,
      riskAmount,
      stopDistance,
      quantity,
      notional,
      requiredLeverage,
      leverageUsed
    }

    if (config.riskPercent > config.maxRiskPercent) {
      violations.push({
        id: 'risk_over',
        desc: `单笔风险 ${config.riskPercent}% 超过上限 ${config.maxRiskPercent}%`,
        severity: 'reject'
      })
      checks.push({
        name: '单笔风险',
        pass: false,
        detail: `${config.riskPercent}% > 上限 ${config.maxRiskPercent}%`
      })
    } else {
      checks.push({
        name: '单笔风险',
        pass: true,
        detail: `${config.riskPercent}% ≤ 上限 ${config.maxRiskPercent}%`
      })
    }

    if (requiredLeverage > config.maxLeverage) {
      violations.push({
        id: 'leverage_over',
        desc: `所需杠杆 ${requiredLeverage.toFixed(2)}x 超过上限 ${config.maxLeverage}x`,
        severity: 'reject'
      })
      checks.push({
        name: '杠杆',
        pass: false,
        detail: `${requiredLeverage.toFixed(2)}x > 上限 ${config.maxLeverage}x`
      })
    } else {
      checks.push({
        name: '杠杆',
        pass: true,
        detail: `${requiredLeverage.toFixed(2)}x ≤ 上限 ${config.maxLeverage}x`
      })
    }

    // 止损距离合理性（相对入场的百分比，替代原来的 ATR 校验）
    const stopPct = entryPrice > 0 ? (stopDistance / entryPrice) * 100 : NaN
    const [lo, hi] = config.stopPctRange
    if (Number.isFinite(stopPct)) {
      const ok = stopPct >= lo && stopPct <= hi
      checks.push({
        name: '止损距离',
        pass: ok,
        detail: `${stopPct.toFixed(2)}% (合理区间 ${lo}~${hi}%)`
      })
      if (!ok) {
        violations.push({
          id: 'stop_distance_range',
          desc: `止损距离 ${stopPct.toFixed(2)}% 不在合理区间 ${lo}~${hi}%`,
          severity: 'warn'
        })
      }
    }

    // 止损是否放在结构位之外（做多应在最近波段低之下，做空反之）
    const st = snapshot.structure
    if (
      st &&
      Number.isFinite(st.lastSwingLow) &&
      Number.isFinite(st.lastSwingHigh)
    ) {
      const ref = isLong ? st.lastSwingLow : st.lastSwingHigh
      const ok = isLong ? sl < ref : sl > ref
      checks.push({
        name: '止损位置(顺结构)',
        pass: ok,
        detail: isLong
          ? `止损 ${numberToStr(sl)} ${ok ? '<' : '≥'} 最近波段低 ${numberToStr(ref)}`
          : `止损 ${numberToStr(sl)} ${ok ? '>' : '≤'} 最近波段高 ${numberToStr(ref)}`
      })
      if (!ok) {
        violations.push({
          id: 'stop_inside_structure',
          desc: '止损未放在结构位之外',
          severity: 'warn'
        })
      }
    }
  }

  // 4) 盈亏比（以末段止盈目标计，TP1 作为参考一并展示）
  let rMultiple: number | null = null
  const tps = decision.takeProfits
  if (tps.length > 0 && sl !== null && Number.isFinite(sl)) {
    const risk = Math.abs(entryPrice - sl)
    if (risk > 0) {
      const rs = tps.map(t => Math.abs(t.price - entryPrice) / risk)
      rMultiple = Math.max(...rs)
      const ok = rMultiple >= config.minRrRatio
      checks.push({
        name: '盈亏比(末段TP)',
        pass: ok,
        detail: `TP1 ${rs[0].toFixed(2)}R / 末段 ${rMultiple.toFixed(2)}R (最小 ${config.minRrRatio}R)`
      })
      if (!ok) {
        violations.push({
          id: 'rr_low',
          desc: `末段盈亏比 ${rMultiple.toFixed(2)}R 低于最小 ${config.minRrRatio}R`,
          severity: 'warn'
        })
      }
    }
  } else {
    checks.push({name: '盈亏比(末段TP)', pass: false, detail: '缺少止盈价'})
    violations.push({id: 'missing_tp', desc: '未给出止盈价', severity: 'warn'})
  }

  return {
    passed: !hasReject(),
    violations,
    checks,
    position,
    minRr: config.minRrRatio,
    rMultiple
  }
}
