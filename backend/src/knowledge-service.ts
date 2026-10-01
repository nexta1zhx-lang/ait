import {loadConfig} from './config'
import {describeRally} from './analysis/describe'
import {findMainRally, sliceWindow} from './analysis/swing'
import {fetchCandles, fetchCandlesRange} from './data/market'
import {CaseFeatures, CaseLabel, createCase, KnowledgeRow} from './db/knowledge'
import {recordUsage} from './db/usage'
import {extractCase} from './llm/extract'
import {oneLineCost, usdToCny} from './llm/pricing'
import {Timeframe} from './types'

const TF_MS: Record<Timeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
}

export interface CollectInput {
  symbol: string
  timeframe: Timeframe
  /** do = 我该做的；dont = 我不该做的 */
  label: CaseLabel
  note?: string
  /** 可选：我只关心这段时间里的行情（毫秒时间戳） */
  from?: number
  to?: number
  /** 时间段的额外前置量（根），保证拉升点前面有足够历史 */
  lookbackBars?: number
  mock?: boolean
  /** 只分析不落库 */
  dryRun?: boolean
}

export interface CollectResult {
  caseId: number | null
  symbol: string
  timeframe: Timeframe
  label: CaseLabel
  grade: 'A' | 'B' | 'C'
  title: string
  lesson: string
  features: CaseFeatures
  whatWorked: string
  rallyMeta: {
    changePct: number
    bars: number
    atrMultiple: number
    volMultiple: number | null
  }
  window: {start: string; end: string; bars: number}
  /** 入库窗口内的 K 线（供前端画图） */
  candles: {
    timestamp: number
    open: number
    high: number
    low: number
    close: number
    volume: number
  }[]
  rallyFrom: number
  rallyTo: number
  candleCount: number
  meta: {
    model: string
    mock: boolean
    warning: string | null
    /** 本次提炼消耗的 token 与花费 */
    usage: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
      costUsd: number
      costCny: number
      attempts: number
      latencyMs: number
      text: string
    }
  }
}

/**
 * 收录一个案例：
 *   我给币种（+ 可选时间段）→ 系统拉行情 → 自动找主拉升 → 截「拉升前后两段」
 *   → AI 提炼特征与经验 → 存进知识库。
 */
export async function collectCase(input: CollectInput): Promise<CollectResult> {
  const config = loadConfig()
  const hasKey = Boolean(process.env.LLM_API_KEY)
  const mock = input.mock ?? (process.env.LLM_MOCK === '1' ? true : !hasKey)

  const tfMs = TF_MS[input.timeframe]
  const lookback = (input.lookbackBars ?? 120) * tfMs
  const forward = 60 * tfMs

  let candles
  let windowNote = ''
  if (input.from && input.to) {
    // 用户给了时间段：多取前面一段，保证拉升点之前有蓄势可看
    const from = input.from - lookback
    const to = input.to + forward
    candles = await fetchCandlesRange({
      exchangeId: config.exchange,
      symbol: input.symbol,
      timeframe: input.timeframe,
      from,
      to,
      marketType: config.marketType,
      apiBase: config.apiBase
    })
    windowNote = `（你给的区间 + 前置 ${input.lookbackBars ?? 120} 根 + 后置 60 根）`
  } else {
    candles = await fetchCandles({
      exchangeId: config.exchange,
      symbol: input.symbol,
      timeframe: input.timeframe,
      limit: 500,
      marketType: config.marketType,
      apiBase: config.apiBase
    })
    windowNote = '（最近 500 根）'
  }

  if (candles.length < 40) {
    throw new Error(
      `只拉到 ${candles.length} 根 K 线，太少，无法判断拉升。换个更长的时间段或换周期。`
    )
  }

  const win = findMainRally(candles)
  if (!win) {
    throw new Error('这段行情里没有找到任何上升段，无法收录。')
  }

  const windowCandles = sliceWindow(candles, win)
  const {text: rallyText, segments} = describeRally(candles, win)

  const {
    result: extracted,
    model,
    mock: usedMock,
    usage,
    attempts,
    latencyMs
  } = await extractCase(
    {
      symbol: input.symbol.toUpperCase(),
      timeframe: input.timeframe,
      label: input.label,
      note: input.note ?? '',
      rallyText,
      segments,
      rallyMeta: {
        changePct: win.leg.changePct,
        bars: win.leg.bars,
        atrMultiple: win.leg.atrMultiple,
        volMultiple: win.leg.volMultiple
      }
    },
    {...config, llm: {...config.llm, mock}}
  )

  // 记账：提炼经验也是一次真实调用
  const billed = await recordUsage({
    kind: 'extract',
    model,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    usage,
    mock: usedMock,
    attempts,
    latencyMs
  })

  const rallyMeta = {
    changePct: Number(win.leg.changePct.toFixed(2)),
    bars: win.leg.bars,
    atrMultiple: Number(win.leg.atrMultiple.toFixed(2)),
    volMultiple:
      win.leg.volMultiple === null
        ? null
        : Number(win.leg.volMultiple.toFixed(2))
  }

  let caseId: number | null = null
  if (!input.dryRun) {
    caseId = await createCase({
      symbol: input.symbol.toUpperCase(),
      ccxtSymbol: null,
      exchange: config.exchange,
      timeframe: input.timeframe,
      label: input.label,
      grade: extracted.grade,
      title: extracted.title,
      note: input.note ?? '',
      lesson: extracted.lesson,
      features: extracted.features,
      windowStart: windowCandles[0].timestamp,
      windowEnd: windowCandles[windowCandles.length - 1].timestamp,
      rallyFrom: win.rallyStart,
      rallyTo: win.rallyEnd,
      candles: windowCandles,
      rallyMeta,
      snapshot: {}
    })
  }

  return {
    caseId,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    label: input.label,
    grade: extracted.grade,
    title: extracted.title,
    lesson: extracted.lesson,
    features: extracted.features,
    whatWorked: extracted.whatWorked,
    rallyMeta,
    window: {
      start: new Date(windowCandles[0].timestamp).toISOString(),
      end: new Date(
        windowCandles[windowCandles.length - 1].timestamp
      ).toISOString(),
      bars: windowCandles.length
    },
    candles: windowCandles.map(c => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    })),
    rallyFrom: win.rallyStart,
    rallyTo: win.rallyEnd,
    candleCount: candles.length,
    meta: {
      model,
      mock: usedMock,
      warning:
        usedMock && !hasKey
          ? '未配置 LLM_API_KEY，本次经验是本地兜底生成的，请手改后再用。'
          : null,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        costUsd: billed?.costUsd ?? 0,
        costCny: usdToCny(billed?.costUsd ?? 0),
        attempts,
        latencyMs,
        text: oneLineCost(usage, billed?.costUsd ?? 0, latencyMs)
      }
    }
  }
}

/** 让 AI 只做提炼、不落库（前端可以先预览再存） */
export async function previewCase(input: CollectInput): Promise<CollectResult> {
  return collectCase({...input, dryRun: true})
}

export type {KnowledgeRow}
