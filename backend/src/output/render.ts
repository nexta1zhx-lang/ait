import {GuardrailResult, LlmDecision, MarketSnapshot} from '../types'

const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
}

const paint = (color: string, s: string) => `${color}${s}${A.reset}`

/** 按数值量级选择小数位，避免低价币被四舍五入成同一个值 */
function decimalsFor(n: number): number {
  const a = Math.abs(n)
  if (!Number.isFinite(a) || a === 0) return 2
  if (a >= 100) return 2
  if (a >= 1) return 4
  if (a >= 0.01) return 5
  if (a >= 0.0001) return 6
  return 8
}

function fmt(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a'
  return n.toLocaleString('en-US', {
    maximumFractionDigits: digits === undefined ? decimalsFor(n) : digits,
    minimumFractionDigits: 0
  })
}

export interface RenderInfo {
  model: string
  disciplineEmpty: boolean
  disciplineHash: string
  logFile?: string
  /** 本次大模型调用消耗（一行摘要） */
  usageText?: string
  /** 判档结果（A/B/C）与结尾提醒 */
  judge?: {
    grade: string
    gradeReason?: string
    exitTriggers?: string[]
    coachLine?: string
    knowledgeRefs?: {symbol: string; timeframe: string; lesson: string}[]
  }
}

function decisionBanner(d: LlmDecision): string {
  if (d.decision === 'open')
    return paint(A.green, `${A.bold}✅ 建议开仓${A.reset}`)
  if (d.decision === 'wait')
    return paint(A.yellow, `${A.bold}⏸  观望${A.reset}`)
  return paint(A.red, `${A.bold}⛔ 不开仓${A.reset}`)
}

function dirText(d: LlmDecision): string {
  if (d.direction === 'long') return paint(A.green, '做多 long')
  if (d.direction === 'short') return paint(A.red, '做空 short')
  return paint(A.gray, '无方向')
}

export function render(
  snap: MarketSnapshot,
  decision: LlmDecision,
  guard: GuardrailResult,
  info: RenderInfo
): string {
  const L: string[] = []
  const rule = paint(A.gray, '─'.repeat(58))

  L.push('')
  L.push(
    `${A.bold}${snap.symbol}${A.reset}  @${snap.exchange}   ${paint(A.dim, new Date(snap.timestamp).toISOString().slice(0, 16) + 'Z')}`
  )
  L.push(
    `当前价: ${A.bold}${fmt(snap.price)}${A.reset}   ${decisionBanner(decision)}   方向: ${dirText(decision)}   置信度: ${paint(A.cyan, String(decision.confidence))}/100`
  )
  if (info.judge?.grade) {
    const g = info.judge.grade
    const colored =
      g === 'A'
        ? paint(A.green, `${A.bold}${g} 档 · 顺势单${A.reset}`)
        : g === 'B'
          ? paint(A.red, `${A.bold}${g} 档 · 不该做${A.reset}`)
          : g === 'C'
            ? paint(A.cyan, `${A.bold}${g} 档 · 期望突破${A.reset}`)
            : paint(A.gray, `${g} · 说不清`)
    L.push(`判档:  ${colored}`)
    if (info.judge.gradeReason)
      L.push(`       ${paint(A.dim, info.judge.gradeReason)}`)
  }
  L.push(rule)

  const entryPrice = decision.entry.price ?? snap.price
  L.push(
    `入场:  ${fmt(entryPrice)}  ${paint(A.dim, `(${decision.entry.type === 'limit' ? '限价' : '市价'})`)}`
  )
  if (decision.stopLoss !== null) {
    const distPct = ((decision.stopLoss - entryPrice) / entryPrice) * 100
    L.push(
      `止损:  ${paint(A.red, fmt(decision.stopLoss))}  (${distPct >= 0 ? '+' : ''}${fmt(distPct, 2)}%)`
    )
  } else {
    L.push(`止损:  ${paint(A.gray, 'n/a')}`)
  }
  if (decision.takeProfits.length > 0) {
    const tpStr = decision.takeProfits
      .map(
        t =>
          `${fmt(t.price)}(${t.label} ${fmt(t.r, 1)}R${t.reducePercent ? `, 减${t.reducePercent}%` : ''})`
      )
      .join(' / ')
    L.push(`止盈:  ${paint(A.green, tpStr)}`)
  } else {
    L.push(`止盈:  ${paint(A.gray, 'n/a')}`)
  }

  if (guard.position) {
    const p = guard.position
    L.push(
      `仓位:  ${A.bold}${fmt(p.quantity, 6)}${A.reset}  (名义 ${fmt(p.notional)} U)   风险 ${fmt(p.riskAmount)} U (账户 ${p.riskPercent}%)   杠杆 ${fmt(p.requiredLeverage, 2)}x → 建议 ${fmt(p.leverageUsed, 2)}x`
    )
  } else {
    L.push(
      `仓位:  ${paint(A.gray, '未计算（未开仓或缺少止损）')}   账户风险上限 ${guard.minRr}R / 单笔风险见配置`
    )
  }
  L.push(rule)

  if (decision.disciplineChecks.length > 0) {
    L.push(paint(A.bold, '纪律核对 (AI):'))
    for (const c of decision.disciplineChecks) {
      const mark = c.pass ? paint(A.green, '✅') : paint(A.red, '❌')
      L.push(
        `  ${mark} ${c.rule}${c.note ? paint(A.dim, ` —— ${c.note}`) : ''}`
      )
    }
  }

  if (guard.checks.length > 0) {
    L.push(paint(A.bold, '护栏校验 (代码):'))
    for (const c of guard.checks) {
      const mark = c.pass ? paint(A.green, '✅') : paint(A.yellow, '⚠️')
      L.push(
        `  ${mark} ${c.name}${c.detail ? paint(A.dim, ` —— ${c.detail}`) : ''}`
      )
    }
  }

  if (decision.veto.length > 0) {
    L.push(paint(A.red, `否决项: ${decision.veto.join('；')}`))
  }
  if (decision.missing.length > 0) {
    L.push(paint(A.yellow, `还差: ${decision.missing.join('；')}`))
  }
  if (decision.reasoning) {
    L.push(`${paint(A.bold, 'AI 结论:')} ${decision.reasoning}`)
  }

  if (info.judge?.exitTriggers && info.judge.exitTriggers.length > 0) {
    L.push(paint(A.bold, '什么情况下必须走:'))
    for (const t of info.judge.exitTriggers) L.push(`  · ${t}`)
  }

  if (info.judge?.knowledgeRefs && info.judge.knowledgeRefs.length > 0) {
    L.push(paint(A.bold, '知识库参考:'))
    for (const k of info.judge.knowledgeRefs) {
      L.push(`  [${k.symbol} ${k.timeframe}] ${paint(A.dim, k.lesson)}`)
    }
  }

  if (info.judge?.coachLine) {
    L.push('')
    L.push(paint(A.yellow, `⚠️  当前最该守住的: ${info.judge.coachLine}`))
  }

  const verdict = guard.passed
    ? paint(A.green, '通过')
    : paint(A.red, '被护栏拦截')
  L.push(rule)
  L.push(
    `护栏结果: ${verdict}   模型: ${info.model}   我的规则: ${info.disciplineEmpty ? '（空）' : '已加载'} (${info.disciplineHash})`
  )
  if (info.usageText) L.push(paint(A.dim, `本次调用: ${info.usageText}`))
  if (info.logFile) L.push(paint(A.dim, `审计日志: ${info.logFile}`))
  L.push('')

  return L.join('\n')
}
