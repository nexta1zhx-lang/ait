import OpenAI from 'openai'
import {AppConfig, LlmDecision, MarketSnapshot} from '../types'
import {JudgeParsed, judgeSchema} from './schema'
import {buildSystemPrompt, buildUserPrompt} from './prompt'
import {RulesBundle} from '../rules'
import {TokenUsage, addUsage, emptyUsage, readUsage} from './pricing'

export interface JudgeMeta {
  model: string
  raw: string
  /** 本次判断共消耗的 token（重试会叠加） */
  usage: TokenUsage
  /** 实际发出的大模型请求次数（>1 = 第一次返回的 JSON 不合法） */
  attempts: number
  latencyMs: number
}

/** 对外暴露的判断结果：AI 的输出 + 派生出的兼容字段 */
export interface JudgeResult extends JudgeParsed {
  /** 与护栏模块对接的字段 */
  decision: 'open' | 'wait' | 'no_open'
}

/**
 * JudgeResult → 护栏模块认识的 LlmDecision。
 * 判断本身用的是「档位 / 结果 / Checklist」，护栏用的是「规则 / 通过 / 说明」，
 * 这里做一次翻译，避免调用方各自映射走偏。
 */
export function toDecision(d: JudgeResult): LlmDecision {
  return {
    decision: d.decision,
    direction: d.direction,
    confidence: d.confidence,
    entry: d.entry,
    stopLoss: d.stopLoss,
    takeProfits: d.takeProfits,
    disciplineChecks: d.checklist.map(c => ({
      rule: c.item,
      pass: c.status === 'pass',
      note: c.evidence
    })),
    veto: d.failedCritical,
    reasoning: d.verdictReason,
    missing: d.grade === 'B' ? d.failedCritical : []
  }
}

function stripFences(s: string): string {
  const t = s.trim()
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return m ? m[1].trim() : t
}

export function verdictToDecision(
  v: JudgeParsed['verdict']
): JudgeResult['decision'] {
  return v === 'go' ? 'open' : v === 'no_go' ? 'no_open' : 'wait'
}

function normalize(d: JudgeParsed): JudgeResult {
  return {
    ...d,
    confidence: Math.max(
      0,
      Math.min(100, Math.round(Number(d.confidence) || 0))
    ),
    takeProfits: (d.takeProfits ?? []).map(t => ({
      label: t.label || 'TP',
      price: Number(t.price),
      r: Number(t.r) || 0,
      reducePercent: Number(t.reducePercent) || 0
    })),
    decision: verdictToDecision(d.verdict)
  }
}

function tryParse(raw: string): JudgeResult | null {
  try {
    const obj = JSON.parse(stripFences(raw))
    const res = judgeSchema.safeParse(obj)
    if (!res.success) return null
    return normalize(res.data as JudgeParsed)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export interface AnalyzeInput {
  snapshot: MarketSnapshot
  /** buildContext 生成的行情快照 */
  context: string
  rules: RulesBundle
  /** 知识库经验条目 */
  lessons: string
  config: AppConfig
}

/** 调用大模型，按我的体系判断该不该开单 */
export async function judge(
  input: AnalyzeInput
): Promise<{result: JudgeResult; meta: JudgeMeta}> {
  const {config} = input

  if (!config.llm.apiKey)
    throw new Error('未配置 LLM_API_KEY：在 .env 里填上 DeepSeek 的 Key 再试。')

  const client = new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl
  })

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system', content: buildSystemPrompt(input.rules)},
    {role: 'user', content: buildUserPrompt(input.context, input.lessons)}
  ]

  let raw = ''
  let usage = emptyUsage()
  let attempts = 0
  const startedAt = Date.now()

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++
    const res = await client.chat.completions.create({
      model: config.llm.model,
      temperature: config.llm.temperature,
      response_format: {type: 'json_object'},
      messages
    })
    usage = addUsage(usage, readUsage(res))
    raw = res.choices?.[0]?.message?.content ?? ''
    const parsed = tryParse(raw)
    if (parsed) {
      return {
        result: parsed,
        meta: {
          model: config.llm.model,
          raw,
          usage,
          attempts,
          latencyMs: Date.now() - startedAt
        }
      }
    }
    messages.push({role: 'assistant', content: raw})
    messages.push({
      role: 'user',
      content:
        '上面不是合法的 JSON，或缺了必需字段。请只输出一个符合约定结构的 JSON 对象，不要任何其他文字。'
    })
  }

  const err = new Error('大模型没有返回可解析的结果，请重试或更换模型')
  // 把已经烧掉的 token 附在错误上，外层仍能记账
  ;(err as Error & {usage?: TokenUsage}).usage = usage
  throw err
}
