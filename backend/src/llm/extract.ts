import OpenAI from 'openai'
import {AppConfig} from '../types'
import {CaseFeatures, CaseLabel, MoveType} from '../db/knowledge'
import {SegmentReport, SeriesStats} from '../analysis/describe'
import {TokenUsage, addUsage, emptyUsage, readUsage} from './pricing'
import {chatParams} from './params'

/** 提示词正文里写这个占位符，标签规则就插在那个位置（没写就接在末尾） */
export const TAG_SLOT = '{{标签}}'

/**
 * 标签清单 → 提示词里的那一段。
 *
 * 清单现传（模板存在数据库里、我自己随时改 `db/tags.ts`）。
 * **清单为空就真的不给标签**，不拿内置默认来充数。
 */
function tagsRuleOf(templates: readonly string[]): string {
  return templates.length
    ? [
        '【tags（标签）怎么写】',
        '- **只能从下面这份清单里挑**，最多 4 个：',
        `  ${templates.join(' / ')}`,
        '- **绝对不许自己造新的**（造了程序也会直接丢掉），不要用同义词替换',
        '- 挑最贴近这段行情的；一个都不贴就别硬凑，宁可少给'
      ].join('\n')
    : [
        '【tags（标签）怎么写】',
        '- 这次**没有给我可选的标签模板**，所以 `tags` 必须直接返回空数组 `[]`，',
        '  不要自己造任何标签'
      ].join('\n')
}

/**
 * 拼 system prompt。
 *
 * 正文来自**数据库**：`ai_docs` 里 kind=extract 的文档（网页「AI 提示词」页维护）。
 * ⚠️ 代码里**没有兜底文案** —— 库里没写就直接报错，不拿内置文本充数。
 */
export function buildExtractPrompt(
  base: string,
  templates: readonly string[]
): string {
  const text = base.trim()
  if (!text)
    throw new Error(
      '没有启用的「知识库提炼」提示词 —— 去「AI 提示词」页写一份（类型选「知识库提炼」）。'
    )
  const rule = tagsRuleOf(templates)
  return text.includes(TAG_SLOT)
    ? text.replace(TAG_SLOT, rule)
    : `${text}\n\n${rule}`
}

export interface ExtractSR {
  timeframe: string
  bars: number
  resistance: number
  support: number
}

export interface ExtractInput {
  symbol: string
  timeframe: string
  /** @deprecated 已经不再分该做 / 不该做 */
  label?: CaseLabel | null
  note: string
  /** describeSeries 生成的整段行情文字 */
  seriesText: string
  segments: SegmentReport[]
  /** 整段客观统计 */
  stats: SeriesStats
  /** 可选：当时的市场热度 */
  heatText?: string
  /**
   * 这段行情**结束时**那一刻的 4H / 日线压力支撑。
   * 只用那一刻之前的 K 线算的，不含之后的数据。
   */
  sr?: ExtractSR[]
}

export interface ExtractResult {
  /** 这段行情是什么：拉升 / 下跌 / 横盘 */
  moveType: MoveType
  title: string
  /** 为什么会走成这样 */
  why: string
  features: CaseFeatures
  lesson: string
  /** AI 挑的标签（已按模板过滤，见 pickTemplates） */
  tags: string[]
}

/** 价格：大数字不拖小数，小数字保留有效位 */
function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toLocaleString('en-US', {maximumFractionDigits: 1})
  if (abs >= 1) return n.toFixed(3)
  return n.toPrecision(6)
}

function buildUser(input: ExtractInput): string {
  const s = input.stats
  const srText = (input.sr ?? [])
    .map(
      x =>
        `- ${x.timeframe}（最近 ${x.bars} 根）：压力 ${fmtPrice(
          x.resistance
        )} / 支撑 ${fmtPrice(x.support)}`
    )
    .join('\n')
  return `【币种 / 周期】${input.symbol} · ${input.timeframe}

${input.note.trim() ? `【我的备注】${input.note.trim()}` : '【我的备注】（没写）'}

【整段速览】
- 共 ${s.bars} 根，${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%，振幅 ${s.rangePct.toFixed(2)}%，最大回撤 -${s.maxDrawdownPct.toFixed(2)}%
- 最高点在整段 ${Math.round(s.highAtPct)}% 处，最低点在 ${Math.round(s.lowAtPct)}% 处${
    s.volTrend !== null
      ? `\n- 后半段均量 / 前半段 = ${s.volTrend.toFixed(2)} 倍`
      : ''
  }
${
  srText
    ? `\n【这段结束时的大周期压力 / 支撑】\n${srText}\n（只用那一刻之前的 K 线算的，不含之后的数据）`
    : ''
}

【行情明细】
${input.seriesText}
${input.heatText ? `\n【市场热度】\n${input.heatText}` : ''}

请按上面的要求输出 JSON。`
}

/** 无 API Key 时的兜底：用统计数字拼一段，不让流程断掉 */
function coerce(raw: string): ExtractResult | null {
  try {
    const t = raw.trim()
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const obj = JSON.parse(m ? m[1].trim() : t)
    if (!obj || typeof obj !== 'object') return null
    const mt = String(obj.moveType ?? '').toLowerCase()
    if (!['up', 'down', 'range'].includes(mt)) return null
    const f = obj.features ?? {}
    const tags = Array.isArray(obj.tags)
      ? obj.tags
          .map((t: unknown) => String(t ?? '').trim())
          .filter((t: string) => t.length > 0 && t.length <= 12)
          .slice(0, 8)
      : []
    return {
      moveType: mt as MoveType,
      title: String(obj.title ?? '').slice(0, 40),
      why: String(obj.why ?? '').trim(),
      features: {
        structure: String(f.structure ?? ''),
        volume: String(f.volume ?? ''),
        rhythm: String(f.rhythm ?? '')
      },
      lesson: String(obj.lesson ?? '').trim(),
      tags
    }
  } catch {
    return null
  }
}

/** 让 AI 把一个案例提炼成「特征 + 经验」 */
export async function extractCase(
  input: ExtractInput,
  config: AppConfig,
  /**
   * 当前的标签模板清单（存数据库，我自己维护）。
   * 空数组 = 这次没有模板 → 模型被要求返回空 tags。
   */
  tagTemplates: readonly string[] = [],
  /**
   * 数据库里那份「知识库提炼」提示词正文（kind=extract）。
   * 空了就直接报错 —— 代码里没有兜底文案。
   */
  systemBase = ''
): Promise<{
  result: ExtractResult
  model: string
  usage: TokenUsage
  attempts: number
  latencyMs: number
  /** 这一次真正发出去的输入（给「AI 分析过程」看） */
  prompt: string
  /** 模型原样返回的内容 */
  raw: string
}> {
  if (!config.llm.apiKey)
    throw new Error('未配置 LLM_API_KEY：提炼案例需要调用大模型。')

  const client = new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl
  })
  const userPrompt = buildUser(input)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system', content: buildExtractPrompt(systemBase, tagTemplates)},
    {role: 'user', content: userPrompt}
  ]

  let usage = emptyUsage()
  let attempts = 0
  let lastRaw = ''
  const startedAt = Date.now()

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++
    const res = await client.chat.completions.create(
      chatParams({
        model: config.llm.model,
        temperature: 0.2,
        reasoningEffort: config.llm.reasoningEffort,
        messages
      }) as never
    )
    usage = addUsage(usage, readUsage(res))
    const raw = res.choices?.[0]?.message?.content ?? ''
    lastRaw = raw
    const parsed = coerce(raw)
    if (parsed) {
      return {
        result: parsed,
        model: config.llm.model,
        usage,
        attempts,
        latencyMs: Date.now() - startedAt,
        prompt: userPrompt,
        raw
      }
    }
    messages.push({role: 'assistant', content: raw})
    messages.push({
      role: 'user',
      content:
        '上面不是合法 JSON（或 moveType 不是 up/down/range）。请只输出符合约定结构的 JSON 对象。'
    })
  }

  const err = new Error('模型没有返回可解析的结果，请重试')
  ;(err as Error & {usage?: TokenUsage}).usage = usage
  throw err
}
