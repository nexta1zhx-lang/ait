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

export interface PolishResult {
  text: string
  model: string
  usage: TokenUsage
  attempts: number
  latencyMs: number
}

/**
 * @param systemBase 提示词正文 —— **来自数据库**（`ai_docs` 里 kind=polish 的启用文档），
 *   在「我的 → AI 提示词 → 日记润色」里改；代码里不再兜底（用户 2026-10-18：「提示词放在数据库中」）。
 */
export async function polishText(
  raw: string,
  config: AppConfig,
  systemBase = ''
): Promise<PolishResult> {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('没有正文可美化')
  if (text.length > MAX_POLISH_CHARS)
    throw new Error(`太长了（上限 ${MAX_POLISH_CHARS} 字），拆成几条再美化`)
  if (!config.llm.apiKey)
    throw new Error('还没配置 API Key —— 去「我的 → 模型配置」填一个 Key 再试')
  if (!systemBase.trim())
    throw new Error('没有「日记润色」提示词 —— 去「我的 → AI 提示词」写一份并打勾')

  const client = new OpenAI({apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl})
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system', content: systemBase},
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
