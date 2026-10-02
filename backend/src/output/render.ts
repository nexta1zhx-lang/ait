import {MarketSnapshot} from '../types'
import type {JudgeResult} from '../llm/client'

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
  /** 本次回溯多少天 */
  days?: number
}

/** 档位 → 中文名 */
const GRADE_NAME: Record<string, string> = {
  A: '顺势单',
  'A-W': '顺势双底',
  S: '突破',
  V: '超跌极速V反',
  B: '不该做',
  unclear: '说不清'
}

function verdictBanner(v: JudgeResult['verdict']): string {
  if (v === 'go') return paint(A.green, `${A.bold}✅ 可做${A.reset}`)
  if (v === 'wait') return paint(A.yellow, `${A.bold}⏸  等待${A.reset}`)
  return paint(A.red, `${A.bold}⛔ 不做${A.reset}`)
}

export function render(
  snap: MarketSnapshot,
  judge: JudgeResult,
  info: RenderInfo
): string {
  const L: string[] = []
  const rule = paint(A.gray, '─'.repeat(58))

  L.push('')
  L.push(
    `${A.bold}${snap.symbol}${A.reset}  @${snap.exchange}   ${paint(A.dim, new Date(snap.timestamp).toISOString().slice(0, 16) + 'Z')}`
  )
  L.push(
    `当前价: ${A.bold}${fmt(snap.price)}${A.reset}   ${verdictBanner(judge.verdict)}` +
      (info.days ? `   ${paint(A.dim, `回溯 ${info.days} 天`)}` : '')
  )
  L.push(rule)

  L.push(`结论:  ${judge.verdict}`)
  if (judge.tags.length)
    L.push(
      `标签:  ${judge.tags.map(t => `${t.name} ${t.probability}%`).join(' / ')}`
    )
  if (judge.outlook)
    L.push(
      `走势:  ${judge.outlook}${paint(A.dim, `（概率 ${judge.probability}%）`)}`
    )
  if (judge.reason) L.push(`理由:  ${judge.reason}`)
  if (judge.recommendation) L.push(`推荐:  ${judge.recommendation}`)

  L.push(rule)
  L.push(
    `模型: ${info.model}   提示词: ${info.disciplineEmpty ? '（空）' : '已加载'} (${info.disciplineHash})`
  )
  if (info.usageText) L.push(paint(A.dim, `本次调用: ${info.usageText}`))
  if (info.logFile) L.push(paint(A.dim, `审计日志: ${info.logFile}`))
  L.push('')

  return L.join('\n')
}
