import OpenAI from 'openai'
import {AppConfig, MarketSnapshot} from '../types'
import {JudgeParsed, MAX_TAGS, judgeSchema} from './schema'
import {buildSystemPrompt, buildUserPrompt} from './prompt'
import {chatParams} from './params'
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

/** 判断结果 —— 就是那四个字段，没有别的派生字段了 */
export type JudgeResult = JudgeParsed

function stripFences(s: string): string {
  const t = s.trim()
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return m ? m[1].trim() : t
}

function normalize(d: JudgeParsed): JudgeResult {
  // 标签：去空白、按名字去重、限个数。**不过滤**「模板外的」——
  // 用户明确要「AI 可以自己添加标签」，新造的要原样显示出来。
  // 同一个名字出现两次就留**概率高的**那个。
  const byName = new Map<string, {name: string; probability: number}>()
  for (const t of d.tags ?? []) {
    const name = String(t?.name ?? '').trim()
    if (!name) continue
    const probability = Math.round(Number(t?.probability) || 0)
    const prev = byName.get(name)
    if (!prev || probability > prev.probability)
      byName.set(name, {name, probability})
  }
  const tags = [...byName.values()]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_TAGS)
  return {...d, tags}
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
  /** 数据库里那份「分析预测」提示词正文 */
  prompt: string
  /** 可用的标签池（标签模板 ∪ 知识库里用过的标签） */
  tags: string[]
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
    {role: 'system', content: buildSystemPrompt(input.prompt)},
    {
      role: 'user',
      content: buildUserPrompt(input.context, input.tags)
    }
  ]

  let raw = ''
  let usage = emptyUsage()
  let attempts = 0
  const startedAt = Date.now()

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++
    const res = await client.chat.completions.create(
      chatParams({
        model: config.llm.model,
        temperature: config.llm.temperature,
        reasoningEffort: config.llm.reasoningEffort,
        messages
      }) as never
    )
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
