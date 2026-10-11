import {MarketSnapshot} from '../types'
import type {JudgeResult} from '../llm/client'

const A = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
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

/**
 * 终端里画一次判断。
 *
 * ★ 2026-10-11：结论就是**一句话**（能不能做 + 进场价 + 止损价），
 *   原来的档位 / 标签 / 概率 / 理由 / 走势 / 推荐 六块全删了。
 */
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
    `当前价: ${A.bold}${fmt(snap.price)}${A.reset}` +
      (info.days ? `   ${paint(A.dim, `回溯 ${info.days} 天`)}` : '')
  )
  L.push(rule)

  L.push(`${A.bold}${judge.line}${A.reset}`)

  L.push(rule)
  L.push(
    `模型: ${info.model}   提示词: ${info.disciplineEmpty ? '（空）' : '已加载'} (${info.disciplineHash})`
  )
  if (info.usageText) L.push(paint(A.dim, `本次调用: ${info.usageText}`))
  if (info.logFile) L.push(paint(A.dim, `审计日志: ${info.logFile}`))
  L.push('')

  return L.join('\n')
}
