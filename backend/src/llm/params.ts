import type {ReasoningEffort} from '../types'

/**
 * 一次大模型调用的公共参数。
 *
 * 为什么单独抽出来：项目里有两处会调模型（开单判断、案例提炼），
 * 参数必须一致 —— 否则「分析快、提炼慢」这种怪事又会冒出来。
 */
export interface ChatCallOptions {
  model: string
  temperature: number
  /** 思考力度；null / undefined = 不传这个参数 */
  reasoningEffort?: ReasoningEffort
  messages: unknown[]
  responseFormat?: boolean
}

/**
 * 拼出 create() 的参数。
 *
 * ⚠️ 关于 `reasoning_effort`：
 * 有些模型（含 deepseek-flash）会把**思维链**写在隐藏字段 `reasoning_content` 里，
 * 这部分照样算 completion token、照样耗时，而我们的代码只读 `message.content` ——
 * 等于花时间花钱买了一段用不上的思考。
 * 实测同一道题：思考 1350/1626 tok（83%）、7477ms；关掉后 0 tok、2024ms，
 * 而且正文反而更长（884 字 vs 585 字）。
 *
 * 所以默认关（`LLM_REASONING=none`）。要让模型自己想，改 .env 就行。
 */
export function chatParams(o: ChatCallOptions): Record<string, unknown> {
  const p: Record<string, unknown> = {
    model: o.model,
    temperature: o.temperature,
    messages: o.messages
  }
  if (o.responseFormat !== false) p.response_format = {type: 'json_object'}
  // 只在明确配置时才传 —— 有些服务商不认识这个参数会直接 400
  if (o.reasoningEffort) p.reasoning_effort = o.reasoningEffort
  return p
}
