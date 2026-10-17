/**
 * **日记润色**（用户 2026-10-18：「标题旁加个 ai 的图标，可以美化正文部分，输出是可以显示」）。
 *
 * 跟 `judge` / `extractCase` 那种「让模型做判断」不同 —— 这一个**只改写法、不改事实**：
 * 用户随手写的几句话，模型把它整理成一段能读的 Markdown，币种、时间、价格、情绪一个都不能动，
 * 更不许自己加交易建议（那是 `analysis` 那一套的事，日记里出现就等于把用户的话改了）。
 */
import OpenAI from 'openai'
import {AppConfig} from '../types'
import {chatParams} from './params'
import {TokenUsage, addUsage, emptyUsage, readUsage} from './pricing'

/** 日记正文最多给多少字（跟 `MAX_BODY` 同一个量级，再长就不要发模型了） */
export const MAX_POLISH_CHARS = 6000

const SYSTEM = `你是中文交易日记的编辑。用户会把随手记的几句话交给你，你只做**写法上的整理**。

必须遵守：
1. 事实一个字都不改：币种名、时间、价格、数量、盈亏、方向、情绪，原样保留；用户没写的数字绝不编。
2. 不加任何交易建议、不加鸡汤、不加评价，不替用户下结论。
3. 不要前言后语（不写「好的」「以下是整理后的版本」），直接输出整理后的正文。
4. 段落短句化：像人在日记本上写的，不要公文腔；可以分段、可以用有序列表，但不要出现标题（#）。
5. 篇幅跟原文相当，最多不超过原文的 1.6 倍；原文只有一两句就保持一两句。
6. 用 Markdown 的形态输出（加粗、列表、空行分段都可以），但不要用代码块。`

export interface PolishResult {
  text: string
  model: string
  usage: TokenUsage
  attempts: number
  latencyMs: number
}

export async function polishText(
  raw: string,
  config: AppConfig
): Promise<PolishResult> {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('没有正文可美化')
  if (text.length > MAX_POLISH_CHARS)
    throw new Error(`太长了（上限 ${MAX_POLISH_CHARS} 字），拆成几条再美化`)
  if (!config.llm.apiKey)
    throw new Error('还没配置 API Key —— 去「我的 → 模型配置」填一个 Key 再试')

  const client = new OpenAI({apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl})
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system', content: SYSTEM},
    {role: 'user', content: text}
  ]

  let usage = emptyUsage()
  let attempts = 0
  const startedAt = Date.now()
  let lastRaw = ''

  /* 回空就再要一次（跟 `judge` 同一个兜底），最多两次 */
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++
    const res = await client.chat.completions.create(
      chatParams({
        model: config.llm.model,
        temperature: 0.35,
        reasoningEffort: config.llm.reasoningEffort,
        responseFormat: false,
        messages
      }) as never
    )
    usage = addUsage(usage, readUsage(res))
    const out = String(res.choices?.[0]?.message?.content ?? '').trim()
    lastRaw = out
    if (out) {
      return {
        text: out.slice(0, 20000),
        model: config.llm.model,
        usage,
        attempts,
        latencyMs: Date.now() - startedAt
      }
    }
    messages.push({role: 'assistant', content: '(空)'})
    messages.push({role: 'user', content: '刚才返回了空内容，请直接输出整理后的日记正文。'})
  }

  const err = new Error('模型没有返回内容，请重试')
  ;(err as Error & {usage?: TokenUsage}).usage = usage
  ;(err as Error & {raw?: string}).raw = lastRaw
  throw err
}
