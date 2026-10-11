import OpenAI from 'openai'
import {AppConfig, MarketSnapshot} from '../types'
import {JudgeParsed, JudgeResult} from './schema'
export type {JudgeResult}
import {buildSystemPrompt, buildUserPrompt} from './prompt'
import {chatParams} from './params'
import {TokenUsage, addUsage, emptyUsage, readUsage} from './pricing'

export interface JudgeMeta {
  model: string
  raw: string
  /** 本次判断共消耗的 token（重试会叠加） */
  usage: TokenUsage
  /** 实际发出的大模型请求次数（>1 = 第一次回了空 / 废内容） */
  attempts: number
  latencyMs: number
}

export interface AnalyzeInput {
  snapshot: MarketSnapshot
  /** buildContext 生成的行情快照 */
  context: string
  /** 数据库里那份「分析预测」提示词正文 */
  prompt: string
  config: AppConfig
}

/**
 * 调用大模型，按我的体系给一句结论。
 *
 * ★ 2026-10-11：**不再解析 JSON** —— 模型回什么，整段 trim 一下就是 `line`
 *   （能不能做 + 进场价 + 止损价，自然语言）。所以 `response_format` 也关掉，
 *   免得逼它吐 JSON。只留一道兜底：**回了空**就追加一句让它重答，最多两次。
 */
export async function judge(
  input: AnalyzeInput
): Promise<{result: JudgeResult; meta: JudgeMeta}> {
  const {config} = input

  if (!config.llm.apiKey)
    throw new Error(
      '还没配置 API Key —— 去「我的 → 模型配置」填一个 DeepSeek 的 Key 再试。'
    )

  const client = new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl
  })

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system', content: buildSystemPrompt(input.prompt)},
    {role: 'user', content: buildUserPrompt(input.context)}
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
        messages,
        // 要的是自然语言那句话，别逼它输出 JSON
        responseFormat: false
      }) as never
    )
    usage = addUsage(usage, readUsage(res))
    raw = res.choices?.[0]?.message?.content ?? ''
    const line = raw.trim()
    if (line) {
      return {
        result: {line} as JudgeParsed,
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
    messages.push({role: 'user', content: '请只回一句话结论。'})
  }

  const err = new Error('大模型没有返回内容，请重试或更换模型')
  // 把已经烧掉的 token 附在错误上，外层仍能记账
  ;(err as Error & {usage?: TokenUsage}).usage = usage
  throw err
}
