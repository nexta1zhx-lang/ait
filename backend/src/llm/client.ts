import OpenAI from 'openai'
import {AppConfig, LlmDecision, MarketSnapshot} from '../types'
import {JudgeParsed, judgeSchema} from './schema'
import {buildSystemPrompt, buildUserPrompt} from './prompt'
import {RulesBundle} from '../rules'
import {TokenUsage, addUsage, emptyUsage, readUsage} from './pricing'

export interface JudgeMeta {
  model: string
  mock: boolean
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

export function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/** 按价格量级选择小数位，避免低价币（如 DOGE）被四舍五入成同一个值 */
export function priceDecimals(n: number): number {
  const a = Math.abs(n)
  if (!Number.isFinite(a) || a === 0) return 2
  if (a >= 100) return 2
  if (a >= 1) return 4
  if (a >= 0.01) return 5
  if (a >= 0.0001) return 6
  return 8
}

export function roundPrice(n: number): number {
  const f = 10 ** priceDecimals(n)
  return Math.round(n * f) / f
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
/* 无 API Key 时的模拟判断                                             */
/* ------------------------------------------------------------------ */

const CHECKLIST_ITEMS = [
  '这个币强势吗？',
  '有盘整结构吗？',
  '有强力 K / 放量突破吗？',
  '后续还有力量吗？',
  '止损位写得出吗？空间合理吗？',
  '现在是关键时段还是垃圾时段？',
  '心态是否平稳？'
]

/** 离线判断：不联网、不需要 API Key，用于自测与 --mock */
export function mockJudge(
  snap: MarketSnapshot,
  config: AppConfig
): JudgeResult {
  const tf =
    snap.timeframes.find(t => t.timeframe === '1h') ??
    snap.timeframes[snap.timeframes.length - 1]
  const s = tf.structure
  const heat = snap.heat

  const upStructure = s.higherHighs && s.higherLows
  const trendUp = tf.trend === 'up'
  const strong = trendUp && upStructure
  const range = tf.trend === 'range'
  const fundingHot =
    heat.fundingRate !== null && Math.abs(heat.fundingRate) > 0.0005
  const volThin = tf.volRatio < 0.5
  const pumped = heat.change24hPct !== null && heat.change24hPct > 15

  const failed: string[] = []
  if (!strong) failed.push('①弱势币种（结构不支持）')
  if (range) failed.push('②区间 / 盘整里来回做')
  if (volThin) failed.push('③无动向（缩量）')

  const grade: JudgeParsed['grade'] = strong
    ? heat.change24hPct !== null && heat.change24hPct > 5
      ? 'C'
      : 'A'
    : failed.length > 0
      ? 'B'
      : 'unclear'

  const price = snap.price
  const dec = 10 ** priceDecimals(price)
  const swingLow = s.lastSwingLow
  let stopLoss: number | null = null
  const takeProfits: JudgeResult['takeProfits'] = []

  if (grade !== 'B' && !pumped && !fundingHot) {
    stopLoss = roundPrice(
      Number.isFinite(swingLow) ? swingLow * 0.997 : price * 0.985
    )
    if (stopLoss >= price * 0.999) stopLoss = roundPrice(price * 0.985)
    const risk = price - stopLoss
    if (risk > 1 / dec) {
      for (let i = 1; i <= 3; i++) {
        takeProfits.push({
          label: `TP${i}`,
          price: roundPrice(price + risk * i),
          r: i,
          reducePercent: i === 1 ? 50 : 25
        })
      }
    } else {
      stopLoss = null
    }
  }

  const go = grade !== 'B' && stopLoss !== null && takeProfits.length > 0

  const checklist = [
    {
      item: CHECKLIST_ITEMS[0],
      status: strong ? ('pass' as const) : ('fail' as const),
      evidence: `趋势=${tf.trend}，结构=${
        s.higherHighs && s.higherLows
          ? '更高的高点 + 更高的低点'
          : s.lowerHighs && s.lowerLows
            ? '更低的高点 + 更低的低点'
            : '结构不明'
      }`
    },
    {
      item: CHECKLIST_ITEMS[1],
      status: range ? ('warn' as const) : ('pass' as const),
      evidence: `区间振幅 ${round(tf.rangePct, 2)}%，${range ? '处于震荡' : '有方向'}`
    },
    {
      item: CHECKLIST_ITEMS[2],
      status: volThin ? ('fail' as const) : ('pass' as const),
      evidence: `量比 ${round(tf.volRatio, 2)}${volThin ? '（缩量）' : ''}`
    },
    {
      item: CHECKLIST_ITEMS[3],
      status:
        heat.openInterestChangePct === null
          ? ('warn' as const)
          : heat.openInterestChangePct >= 0
            ? ('pass' as const)
            : ('fail' as const),
      evidence:
        heat.openInterestChangePct === null
          ? '持仓量数据缺失'
          : `持仓量变化 ${round(heat.openInterestChangePct, 2)}%`
    },
    {
      item: CHECKLIST_ITEMS[4],
      status: stopLoss === null ? ('fail' as const) : ('pass' as const),
      evidence:
        stopLoss === null
          ? '下方没有可依托的结构位，写不出止损'
          : `波段低 ${round(swingLow, 2)}，止损 ${stopLoss}`
    },
    {
      item: CHECKLIST_ITEMS[5],
      status: 'warn' as const,
      evidence: '数据无法判断，请你自己确认现在是不是关键时段'
    },
    {
      item: CHECKLIST_ITEMS[6],
      status: 'warn' as const,
      evidence: '数据无法判断，请你自己确认心态'
    }
  ]

  return {
    grade,
    gradeReason: failed.length
      ? `命中：${failed.join('；')}`
      : `结构 ${upStructure ? '更高的高点 + 更高的低点' : '—'}，趋势 ${tf.trend}`,
    // 对齐规则：B 档一票否决，只能是 no_go，不能「再看看」
    verdict: go ? 'go' : grade === 'B' ? 'no_go' : 'wait',
    confidence: go ? 62 : 38,
    direction: go ? 'long' : 'none',
    entry: {type: 'market', price: go ? roundPrice(price) : null},
    stopLoss,
    takeProfits,
    checklist,
    failedCritical: failed,
    verdictReason: go
      ? '结构与趋势一致，止损可依托波段低点，量能正常。'
      : failed.length
        ? `不满足：${failed.join('；')}。`
        : '条件不足，建议观望。',
    exitTriggers: go
      ? ['动能衰竭（量能萎缩、后续没力量）就走', '冲高 / 加速段果断兑现']
      : [],
    knowledgeRefs: [],
    coachLine: '弱势千万不能赌突破，不去空就已经很好了。',
    decision: go ? 'open' : 'wait'
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

  if (config.llm.mock || !config.llm.apiKey) {
    return {
      result: mockJudge(input.snapshot, config),
      meta: {
        model: 'mock',
        mock: true,
        raw: '',
        usage: emptyUsage(),
        attempts: 0,
        latencyMs: 0
      }
    }
  }

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
          mock: false,
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
