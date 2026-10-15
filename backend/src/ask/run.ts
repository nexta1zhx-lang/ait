/**
 * 「数据问答」的取数循环。
 *
 * 模型能做的事只有「选工具 + 给参数」，SQL 在 `tools.ts` 里是死的 —— 见那个文件的说明。
 * 这里负责：把问题喂进去 → 转 tool_calls → 执行 → 结果回灌 → 最多 `MAX_ROUNDS` 轮 → 拿最终回答。
 *
 * ⚠️ **不要给这次调用传 `response_format`** —— `json_object` 和 `tool_calls` 互斥，
 *    DeepSeek 会直接 400（公共的 `chatParams()` 无条件塞了它，所以这里自己拼参数）。
 */
import OpenAI from 'openai'
import {loadConfig} from '../config'
import {resolveUserLlm} from '../db/llm-keys'
import {recordUsage} from '../db/usage'
import {TokenUsage, addUsage, emptyUsage, readUsage} from '../llm/pricing'
import {bjToday} from './range'
import {buildAskSystemPrompt, buildAskUserPrompt} from './prompt'
import {
  AskToolContext,
  ToolInputError,
  clipForModel,
  runTool,
  toOpenAiTools,
  toolLabel
} from './tools'

/** 最多跑几轮工具调用（一轮 = 一次模型响应，可以同时调好几个工具） */
export const MAX_ROUNDS = 4
/** 带几轮历史进去（多轮追问用；太长只是白花钱） */
export const MAX_HISTORY = 6
/** 单个问题的长度上限 */
export const MAX_QUESTION_CHARS = 500

export interface AskStep {
  tool: string
  /** 工具的中文短名（前端「取值过程」显示） */
  label: string
  args: Record<string, unknown>
  ok: boolean
  ms: number
  rows: number
  detail: string
  error: string | null
}

export interface AskAnswer {
  answer: string
  steps: AskStep[]
  rounds: number
  /** 真查过库吗 —— 没查过就答 = 它自己编的，前端要标出来 */
  verified: boolean
  model: string
  usage: TokenUsage
  latencyMs: number
  costUsd: number
}

export interface AskInput {
  userId: number
  question: string
  /** 前几轮对话（最新的在后面），用来支持追问 */
  history?: {role: 'user' | 'assistant'; content: string}[]
}

function parseArgs(raw: unknown): Record<string, unknown> {
  const s = String(raw ?? '').trim()
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    // 模型偶尔会给出半个 JSON —— 当空参数跑，让它从工具返回里自己发现不对
    return {}
  }
}

/** 取数过程中往外吐的事件（SSE 那条路用它做流式；不传 sink 就是纯阻塞式） */
export type AskEvent =
  /** 进入第 N 轮（前端可以显示「正在想…」，并把上一轮的临时文字清掉） */
  | {type: 'round'; round: number; max: number}
  /** 一个工具跑完了（成不成都推，前端「取值过程」实时长出来） */
  | {type: 'step'; step: AskStep}
  /** 回答的增量（**逐字**推，前端直接往当前那条气泡上追加） */
  | {type: 'delta'; text: string}
  /**
   * 这一轮的文字**作废**（它只是旁白，不是回答）。
   *
   * ⚠️ 流式下模型很爱先来一句「I'll check your recent fills…」再去调工具 ——
   *    那段是**要说的话**不是**答案**，混进气泡里就是一句英文夹在中文回答前面。
   *    所以一轮结束时发现它调了工具，就把这轮推过的文字撤回。
   */
  | {type: 'drop'; round: number}

export type AskSink = (e: AskEvent) => void

/**
 * 这个服务商认不认 `stream_options.include_usage`。
 *
 * 认，流式响应才会在最后一块里带 `usage`（不然整通调用记不到账）。
 * 不认就退回不带它 —— 反正 DeepSeek 自己默认就会给；换个自定义 baseUrl 的
 * 服务商时才可能踩到，踩到只丢一次调用记录，别把整个问答搞挂。
 *
 * ⚠️ 进程级的一个开关就够：同一个 baseUrl 不会一会儿认一会儿不认。
 */
let usageOnStream = true

/** 开一条**流式**的补全（第 2 次起会记住「不认 stream_options」这件事） */
async function openStream(
  client: OpenAI,
  params: Record<string, unknown>
): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
  const p: Record<string, unknown> = {...params, stream: true}
  if (usageOnStream) p.stream_options = {include_usage: true}
  try {
    return (await client.chat.completions.create(
      p as never
    )) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
  } catch (e) {
    const msg = (e as Error)?.message ?? ''
    if (!usageOnStream || !/stream_options|include_usage/i.test(msg)) throw e
    usageOnStream = false
    console.warn(
      '[ask] 这个服务商不认 stream_options.include_usage，已退回不带它（这一通用量可能记不到）'
    )
    delete p.stream_options
    return (await client.chat.completions.create(
      p as never
    )) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
  }
}

export async function askData(
  input: AskInput,
  sink?: AskSink
): Promise<AskAnswer> {
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS)
  if (!question) throw new Error('问题不能是空的')

  const resolved = await resolveUserLlm(input.userId)
  const config = loadConfig({llm: resolved.llm})
  if (!config.llm.apiKey)
    throw new Error(
      '还没配置 API Key —— 去「我的 → 模型配置」填一个 DeepSeek 的 Key 再试。'
    )

  const client = new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl
  })

  const ctx: AskToolContext = {
    userId: input.userId,
    exchange: config.exchange,
    marketType: config.marketType
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system', content: buildAskSystemPrompt(bjToday())},
    ...(input.history ?? [])
      .slice(-MAX_HISTORY)
      .filter(m => m.content.trim())
      .map(m => ({role: m.role, content: m.content}) as OpenAI.Chat.ChatCompletionMessageParam),
    {role: 'user', content: buildAskUserPrompt(question)}
  ]

  const steps: AskStep[] = []
  let usage = emptyUsage()
  let answer = ''
  let rounds = 0
  const startedAt = Date.now()

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1
    sink?.({type: 'round', round: rounds, max: MAX_ROUNDS})

    const params: Record<string, unknown> = {
      model: config.llm.model,
      temperature: config.llm.temperature,
      messages,
      tools: toOpenAiTools(),
      tool_choice: 'auto'
    }
    // 跟别的调用点一样：只在用户明确配了思考力度时才传（有些服务商不认这个参数）
    if (config.llm.reasoningEffort) params.reasoning_effort = config.llm.reasoningEffort

    const stream = await openStream(client, params)

    let text = ''
    /*
     * 流式下 tool_calls 是**按 index 分片**吐出来的：第一片带 id + name，
     * 后面几片只有 arguments 的碎片。所以要先归并成完整的调用再执行。
     */
    const acc = new Map<number, {id: string; name: string; args: string}>()
    for await (const chunk of stream) {
      if (chunk?.usage) usage = addUsage(usage, readUsage(chunk))
      const d = chunk?.choices?.[0]?.delta
      if (!d) continue
      if (typeof d.content === 'string' && d.content) {
        text += d.content
        sink?.({type: 'delta', text: d.content})
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0
        const cur = acc.get(i) ?? {id: '', name: '', args: ''}
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        acc.set(i, cur)
      }
    }

    const calls = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
    if (!calls.length) {
      // 这一轮没调工具 = 这就是最终回答
      answer = text.trim()
      break
    }

    // 调了工具 ⇒ 这一轮那段文字只是旁白，撤回（别让它混进回答里）
    if (text.trim()) sink?.({type: 'drop', round: rounds})

    messages.push({
      role: 'assistant',
      content: text.trim() || null,
      tool_calls: calls.map(c => ({
        // 极少数服务商不给 id，补一个 —— 不回填的话下一轮的 tool 消息对不上
        id: c.id || `call_${round}_${c.name}`,
        type: 'function' as const,
        function: {name: c.name, arguments: c.args}
      }))
    } as OpenAI.Chat.ChatCompletionMessageParam)

    for (const call of calls) {
      const name = call.name
      const args = parseArgs(call.args)
      const t0 = Date.now()
      const push = (step: AskStep): void => {
        steps.push(step)
        sink?.({type: 'step', step})
      }
      try {
        const out = await runTool(name, args, ctx)
        push({
          tool: name,
          label: toolLabel(name),
          args,
          ok: true,
          ms: Date.now() - t0,
          rows: out.rows,
          detail: out.detail,
          error: null
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: clipForModel(out.data)
        })
      } catch (e) {
        const msgText = (e as Error)?.message ?? String(e)
        // 数据库真炸了要留日志；参数错是模型自己的问题，不用惊动运维
        if (!(e instanceof ToolInputError)) {
          console.error(`[ask] 工具 ${name} 失败：`, msgText)
        }
        push({
          tool: name,
          label: toolLabel(name),
          args,
          ok: false,
          ms: Date.now() - t0,
          rows: 0,
          detail: msgText,
          error: msgText
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({error: msgText})
        })
      }
    }
  }

  if (!answer) {
    answer = steps.some(s => s.ok)
      ? '查到了数据，但这一轮没组织出回答（可能是模型返回了空内容）。请再问一次，或把问题说得再具体一点。'
      : '没查到能回答这个问题的数据。可以先试试问「最近 30 天的分析记录」「我在跟踪哪些币」这类问题。'
  }

  const latencyMs = Date.now() - startedAt
  // 记账走旁路：记不上也不该把这次问答搞挂（跟别的调用点一致）
  let costUsd = 0
  try {
    const billed = await recordUsage({
      userId: input.userId,
      llmKeyId: resolved.keyId,
      kind: 'ask',
      model: config.llm.model,
      usage,
      attempts: rounds,
      latencyMs
    })
    costUsd = billed?.costUsd ?? 0
  } catch (e) {
    console.error('[ask] 记账失败：', (e as Error).message)
  }

  return {
    answer,
    steps,
    rounds,
    verified: steps.some(s => s.ok),
    model: config.llm.model,
    usage,
    latencyMs,
    costUsd
  }
}
