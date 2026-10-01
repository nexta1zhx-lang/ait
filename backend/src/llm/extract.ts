import OpenAI from 'openai'
import {AppConfig} from '../types'
import {CaseFeatures, CaseGrade, CaseLabel} from '../db/knowledge'
import {SegmentReport} from '../analysis/describe'
import {TokenUsage, addUsage, emptyUsage, readUsage} from './pricing'

const SYSTEM = `你是我的交易复盘助手。

我会给你**一段真实行情**（拉升前 / 拉升段 / 拉升后 三段的客观统计），以及**我自己的标注**：
这段是「我该做的」还是「我不该做的」，可能还有我写的一句备注。

请你用**我自己的交易语言**描述这个案例，并提炼一条可复用的经验。

【必须做到】
1. **只能用我给的数据**，不许编造任何数字，不许提我没给过的东西。
2. 用我的词汇描述：价格结构（更高的高点 / 更高的低点 / 更低的高点 / 更低的低点）、
   「强力 K」「放量」「后续有没有力量」「区间 / 盘整」「资金费率」「持仓量」。
3. **不要用技术指标**（均线 / RSI / MACD / 布林 / ATR 等），我看不懂也不想看。
4. 判档只用我体系里的三档：
   - A = 顺势单（强势币回调不破）
   - B = 不该做（弱势 / 区间来回 / 无动向 / 一日游 / 心态差）
   - C = 期望突破（有盘整结构 + 有强力K放量突破 + 后续有力量，缺一不可）
5. lesson（经验）是**最重要**的字段：
   - 写成**祈使句**，必须**可判定**（例：「缩量拉升、后续没力量的，一律不做」）
   - 1~2 句，不要写「注意风险」这种废话
   - 如果是「我该做的」，就写成「什么样的特征出现时该怎么做」
   - 如果是「我不该做的」，就写成「出现什么特征时必须拒绝」

【输出】只输出一个 JSON 对象，不要代码块，不要任何解释文字：

{
  "grade": "A | B | C",
  "title": "一句话概括这个案例，不超过 20 字",
  "features": {
    "pre": "拉升前的样子（结构 / 量能 / 有没有盘整）",
    "rally": "拉升本身的样子（涨幅、快慢、放量程度）",
    "post": "拉升后的样子（还有没有力量、回撤多少）",
    "heat": "如果能判断，写当时热度；数据不够就写「无数据」"
  },
  "whatWorked": "我这次做对/做错在哪（对应我的体系条款）",
  "lesson": "可复用的经验（祈使句，1~2 句）"
}`

export interface ExtractInput {
  symbol: string
  timeframe: string
  label: CaseLabel
  note: string
  /** describeRally 生成的文字 */
  rallyText: string
  segments: SegmentReport[]
  rallyMeta: {
    changePct: number
    bars: number
    atrMultiple: number
    volMultiple: number | null
  }
  /** 可选：当时的市场热度 */
  heatText?: string
}

export interface ExtractResult {
  grade: CaseGrade
  title: string
  features: CaseFeatures
  whatWorked: string
  lesson: string
}

function buildUser(input: ExtractInput): string {
  const meta = input.rallyMeta
  return `【币种 / 周期】${input.symbol} · ${input.timeframe}

【我的标注】${
    input.label === 'do'
      ? '✅ 这是我该做的（正面案例）'
      : '❌ 这是我不该做的（反面案例）'
  }
${input.note.trim() ? `【我的备注】${input.note.trim()}` : '【我的备注】（没写）'}

【拉升段客观指标】
- 涨幅 ${meta.changePct.toFixed(2)}%，用了 ${meta.bars} 根
- 力度 ${meta.atrMultiple.toFixed(2)} × ATR（越大越猛）
- 量能 ${meta.volMultiple === null ? '无法计算' : meta.volMultiple.toFixed(2) + ' 倍'}

【行情明细】
${input.rallyText}
${input.heatText ? `\n【市场热度】\n${input.heatText}` : ''}

请按上面的要求输出 JSON。`
}

/** 无 API Key 时的兜底：用统计数字拼一段，不让流程断掉 */
function fallback(input: ExtractInput): ExtractResult {
  const m = input.rallyMeta
  const isDo = input.label === 'do'
  return {
    grade: isDo ? 'C' : 'B',
    title: `${input.symbol} ${m.changePct >= 0 ? '拉升' : '下挫'} ${m.changePct.toFixed(1)}%`,
    features: {
      pre: input.segments[0]?.structure ?? '',
      rally: `${m.bars} 根涨 ${m.changePct.toFixed(2)}%，力度 ${m.atrMultiple.toFixed(1)}×ATR，量能 ${
        m.volMultiple === null ? '未知' : m.volMultiple.toFixed(2) + ' 倍'
      }`,
      post: input.segments[2] ? `${input.segments[2].structure}` : '',
      heat: '无数据'
    },
    whatWorked: input.note || '（未配置 LLM_API_KEY，无法提炼）',
    lesson:
      input.note.trim() ||
      `（未配置 LLM_API_KEY，无法自动提炼经验，请手动补一条）${input.symbol} ${input.timeframe}：${isDo ? '这种形态该做' : '这种形态不该做'}`
  }
}

function coerce(raw: string): ExtractResult | null {
  try {
    const t = raw.trim()
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const obj = JSON.parse(m ? m[1].trim() : t)
    if (!obj || typeof obj !== 'object') return null
    const grade = String(obj.grade ?? '').toUpperCase()
    if (!['A', 'B', 'C'].includes(grade)) return null
    const f = obj.features ?? {}
    return {
      grade: grade as CaseGrade,
      title: String(obj.title ?? '').slice(0, 40),
      features: {
        pre: String(f.pre ?? ''),
        rally: String(f.rally ?? ''),
        post: String(f.post ?? ''),
        heat: String(f.heat ?? '')
      },
      whatWorked: String(obj.whatWorked ?? ''),
      lesson: String(obj.lesson ?? '').trim()
    }
  } catch {
    return null
  }
}

/** 让 AI 把一个案例提炼成「特征 + 经验」 */
export async function extractCase(
  input: ExtractInput,
  config: AppConfig
): Promise<{
  result: ExtractResult
  model: string
  mock: boolean
  usage: TokenUsage
  attempts: number
  latencyMs: number
}> {
  if (config.llm.mock || !config.llm.apiKey) {
    return {
      result: fallback(input),
      model: 'mock',
      mock: true,
      usage: emptyUsage(),
      attempts: 0,
      latencyMs: 0
    }
  }

  const client = new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl
  })
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system', content: SYSTEM},
    {role: 'user', content: buildUser(input)}
  ]

  let usage = emptyUsage()
  let attempts = 0
  const startedAt = Date.now()

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++
    const res = await client.chat.completions.create({
      model: config.llm.model,
      temperature: 0.2,
      response_format: {type: 'json_object'},
      messages
    })
    usage = addUsage(usage, readUsage(res))
    const raw = res.choices?.[0]?.message?.content ?? ''
    const parsed = coerce(raw)
    if (parsed) {
      return {
        result: parsed,
        model: config.llm.model,
        mock: false,
        usage,
        attempts,
        latencyMs: Date.now() - startedAt
      }
    }
    messages.push({role: 'assistant', content: raw})
    messages.push({
      role: 'user',
      content:
        '上面不是合法 JSON 或 grade 不是 A/B/C。请只输出符合约定结构的 JSON 对象。'
    })
  }

  const err = new Error('模型没有返回可解析的结果，请重试')
  ;(err as Error & {usage?: TokenUsage}).usage = usage
  throw err
}
