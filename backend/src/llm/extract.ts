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
 * 正文来自**数据库**：`ai_docs` 里 kind=extract 那份文档（「我的 → AI 提示词」里改）。
 * ⚠️ 代码里**没有兜底文案** —— 库里没写就直接报错，不拿内置文本充数。
 */
export function buildExtractPrompt(
  base: string,
  templates: readonly string[]
): string {
  const text = base.trim()
  if (!text)
    throw new Error(
      '知识库提炼的提示词是空的 —— 去「我的 → AI 提示词」写一份（kind=extract）。'
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
  /**
   * 从一笔仓位导入时，那笔仓位的事实（用户 2026-10-16）。
   *
   * 给了就在提示词里明说「这是我自己做过的一笔真实仓位」，让模型把
   * 「当时是什么样的结构」和「我实际怎么做、结果如何」对上 —— 光看 K 线
   * 只能总结形状，看不出我是在哪儿进出的。
   * ⚠️ 它只进提示词，**不落库**：库里存的是 `knowledge.pos`（见 `db/knowledge.ts`）。
   */
  position?: {
    side: 'long' | 'short'
    /** 开仓时间（毫秒） */
    openAt: number
    closeAt: number | null
    entryPrice: number | null
    exitPrice: number | null
    qty: number
    net: number
    holdSec: number
    leverage: number | null
    keyName?: string
  }
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

/** 价格：大数字不拖小数，小数字保留有效位（没有值给 `—`，别编一个） */
function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toLocaleString('en-US', {maximumFractionDigits: 1})
  if (abs >= 1) return n.toFixed(3)
  return n.toPrecision(6)
}

/** 北京时间 yyyy-mm-dd hh:mm（⚠️ 一定要带年份：仓位可能是去年的事） */
function bjFull(ms: number): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms)))
    p[x.type] = x.value
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/** 持仓多久（给模型看的人话：`1天3小时` / `42 分钟`） */
function holdText(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`
}

/**
 * 从仓位导入时：我那笔仓位的事实 → 提示词里的一段。
 *
 * ⚠️ 时间也要用**北京时间**（跟 `knowledge-service.ts` 的 `bjFull` 同一套），
 *    别用 `toISOString()` —— 差 8 小时会让「我什么时候开的仓」跟 K 线上那根对不上。
 *    （那个函数在本文件里 import 不进来：`knowledge-service` 反过来 import 本文件，
 *     会成环，所以这里留一份小的。）
 */
function positionBlock(p: NonNullable<ExtractInput['position']>): string {
  const hold = holdText(p.holdSec)
  const side = p.side === 'short' ? '空' : '多'
  const money = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`
  return `【这是我自己的一笔真实仓位】
- 方向：${side}${p.leverage ? ` · ${p.leverage}x` : ''}${
    p.keyName ? ` · 账户 ${p.keyName}` : ''
  }
- 开仓：${bjFull(p.openAt)} 均价 ${fmtPrice(p.entryPrice)}${
    p.closeAt === null
      ? '（**还没平**，下面那段走势一直到此刻）'
      : ` → 平仓：${bjFull(p.closeAt)} 均价 ${fmtPrice(p.exitPrice)}`
  }
- 持仓：${hold} · 数量 ${p.qty}
- 净盈亏：${p.closeAt === null ? `${money(p.net)}（至今）` : money(p.net)} USDT（已含手续费 / 资金费）
（上面的行情就是这一段：开仓前那几十根是**我开仓那一刻看到的结构**，中间是我持仓期间，
 最后几根是平仓之后怎么走的。请照上面的要求提炼这段行情，别去评价我该不该这么做。）`
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
${input.position ? `\n${positionBlock(input.position)}\n` : ''}
【整段速览】
- 共 ${s.bars} 根，${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%，振幅 ${s.rangePct.toFixed(2)}%，最大回撤 -${s.maxDrawdownPct.toFixed(2)}%
- 最高点在整段 ${Math.round(s.highAtPct)}% 处，最低点在 ${Math.round(s.lowAtPct)}% 处${
    s.volTrend !== null
      ? `\n- 后半段均量 / 前半段 = ${s.volTrend.toFixed(2)} 倍`
      : ''
  }
${
  srText
    ? `\n【${
        input.position ? '我开仓那一刻' : '这段结束时'
      }的大周期压力 / 支撑】\n${srText}\n（只用那一刻之前的 K 线算的，不含之后的数据）`
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
   * 代码里那份「知识库提炼」提示词正文（`prompts.ts` 的 `EXTRACT_PROMPT`）。
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
    throw new Error(
      '还没配置 API Key —— 去「我的 → 模型配置」填一个 DeepSeek 的 Key 再提炼。'
    )

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
