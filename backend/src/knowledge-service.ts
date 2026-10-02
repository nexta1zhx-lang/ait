import {loadConfig} from './config'
import {describeSeries} from './analysis/describe'
import {fetchCandles, fetchCandlesRange, fetchSRAt} from './data/market'
import {
  CaseFeatures,
  CaseLabel,
  CaseStats,
  createCase,
  getCase,
  KnowledgeRow,
  MoveType,
  MAX_TAGS,
  pickTemplates,
  updateCase
} from './db/knowledge'
import {loadTagTemplates} from './db/tags'
import {loadExtractRules} from './rules'
import {recordUsage} from './db/usage'
import {extractCase, type ExtractSR} from './llm/extract'
import {oneLineCost, usdToCny} from './llm/pricing'
import {TF_MS as MARKET_TF_MS} from './data/market'
import {stepRecorder, type AnalyzeStep, type OnStep} from './step'
import {Timeframe} from './types'

/** 保留两位小数 */
function round2(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0
}

const TF_MS: Record<Timeframe, number> = MARKET_TF_MS

/**
 * 复盘时额外喂给 AI 的大周期压力支撑。
 *
 * 用「这段行情结束时」那一刻的 4H / 日线高低点 —— 只吃那一刻之前的 K 线，
 * 相当于 AI 当时抬头能看到的箱体上沿 / 下沿。
 */
const SR_INPUT: {timeframe: Timeframe; bars: number}[] = [
  {timeframe: '4h', bars: 30},
  {timeframe: '1d', bars: 30}
]

export interface CollectInput {
  symbol: string
  timeframe: Timeframe
  /** @deprecated 已经不再分「该做 / 不该做」 */
  label?: CaseLabel | null
  note?: string
  /**
   * 以这个时间点为中心取行情（毫秒）。
   * 「点选一个时间」用这条 —— 拉「中心前后各 aroundBars 根」，再在这段里找主拉升。
   */
  center?: number
  /** 中心前后各取多少根，默认 200 */
  aroundBars?: number
  /** 我在图上画出的时间段（毫秒时间戳） */
  from?: number
  to?: number
  /** 时间段的额外前置量（根），保证拉升点前面有足够历史 */
  lookbackBars?: number
  /** 画了范围就要这一段本身 —— 前后都不补，一根不多一根不少 */
  exact?: boolean
  /** 只分析不落库 */
  dryRun?: boolean
  /** 一步步往外报进度（前端画「分析过程」时间线） */
  onStep?: OnStep
}

/** 「点选一个时间」默认前后各拉多少根 */
export const DEFAULT_AROUND_BARS = 200

export interface CollectResult {
  caseId: number | null
  symbol: string
  timeframe: Timeframe
  /** @deprecated 已经不再分「该做 / 不该做」，固定为 null */
  label: CaseLabel | null
  /** 这段行情是什么：拉升 / 下跌 / 横盘 */
  moveType: MoveType
  title: string
  /** 为什么会走成这样 */
  why: string
  lesson: string
  features: CaseFeatures
  /** AI 从模板里挑的标签（模板外的会被丢掉） */
  tags: string[]
  /** 这次能选的标签模板（弹窗里点这些） */
  tagTemplates: readonly string[]
  /** 整段客观统计 */
  stats: CaseStats
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
  /** 一共拉了多少根 */
  candleCount: number
  /** 这次走了哪几步（前端画时间线） */
  steps: AnalyzeStep[]
  meta: {
    model: string
    warning: string | null
    /** 喂给 AI 的行情文字一共多少字 */
    promptChars: number
    /** 复盘时一并喂进去的 4H / 日线压力支撑 */
    sr: ExtractSR[]
    /** 喂给模型的输入原文（用户输入部分） */
    prompt: string
    /** 模型原样返回的内容 */
    raw: string
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
 *   我给币种 + 一个时间点（或我在 K 线图上画的一段） → 系统拉那段行情
 *   → 一并算出**那一刻**的 4H / 日线压力支撑 → AI 看这是什么行情
 *   （拉升 / 下跌 / 横盘）、为什么走成这样、能总结出什么经验 → 存进知识库。
 *
 * 注：不再强制找「主拉升段」，也不再分「该做 / 不该做」——
 * 记的是「形状 + 经验」。
 */
export async function collectCase(input: CollectInput): Promise<CollectResult> {
  const config = loadConfig()
  const {steps, start, markFailed} = stepRecorder(input.onStep)

  const tfMs = TF_MS[input.timeframe]
  const lookback = (input.lookbackBars ?? 120) * tfMs
  const forward = 60 * tfMs

  /* ---- 1. 拉行情 ---- */
  const exactRange = !!(input.exact && input.from && input.to)
  const endFetch = start(
    'fetch',
    `拉取 ${input.symbol.toUpperCase()} ${input.timeframe} 行情`
  )

  let candles
  let windowNote = ''
  try {
    if (exactRange) {
      // 我在图上画的范围：就要这一段本身，前后不补
      candles = await fetchCandlesRange({
        exchangeId: config.exchange,
        symbol: input.symbol,
        timeframe: input.timeframe,
        from: input.from as number,
        to: input.to as number,
        marketType: config.marketType,
        apiBase: config.apiBase
      })
      windowNote = '（我画的范围，一根不多一根不少）'
    } else if (input.center) {
      // 点选一个时间：以它为中心，前后各拉 N 根
      const bars = Math.min(
        2000,
        Math.max(20, input.aroundBars ?? DEFAULT_AROUND_BARS)
      )
      const from = input.center - bars * tfMs
      const to = input.center + bars * tfMs
      candles = await fetchCandlesRange({
        exchangeId: config.exchange,
        symbol: input.symbol,
        timeframe: input.timeframe,
        from,
        to,
        marketType: config.marketType,
        apiBase: config.apiBase,
        maxCandles: bars * 2 + 5
      })
      windowNote = `（你选的时间点前后各 ${bars} 根）`
    } else if (input.from && input.to) {
      // 用户给了时间段但没要「原样」：多取前面一段，保证转折之前有蓄势可看
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
  } catch (e) {
    markFailed('fetch', (e as Error).message)
    throw e
  }

  if (candles.length < 40) {
    markFailed(
      'fetch',
      `只拉到 ${candles.length} 根，太少（至少要 40 根，范围画大一点或换周期）`
    )
    throw new Error(
      `只拉到 ${candles.length} 根 K 线，太少，无法判断行情。把范围画大一点或换个周期。`
    )
  }
  endFetch(
    `${candles.length} 根 · ${bjFull(candles[0].timestamp)} → ${bjFull(
      candles[candles.length - 1].timestamp
    )} ${windowNote}`
  )

  const windowCandles = candles
  const windowEndMs = windowCandles[windowCandles.length - 1].timestamp

  /* ---- 2. 那一刻的 4H / 日线压力支撑 ---- */
  const endSR = start('sr', '算这一刻的 4H / 日线压力支撑')
  const sr = await loadSRAt(windowEndMs, input, config)
  endSR(
    sr.length
      ? sr
          .map(
            x =>
              `${x.timeframe} ${fmtNum(x.support)}~${fmtNum(
                x.resistance
              )}（${x.bars} 根）`
          )
          .join(' · ')
      : '拉不到大周期数据，本次不喂压力支撑'
  )

  /* ---- 3. 把行情压成文字 ---- */
  const endDescribe = start('describe', '把行情切成小段读结构')
  const {text: seriesText, segments, stats} = describeSeries(candles)
  endDescribe(
    `${stats.bars} 根 → ${segments.length} 小段 · ${seriesText.length} 字`
  )

  /* ---- 4. 调模型提炼 ---- */
  const endExtract = start('extract', `调用 ${config.llm.model} 提炼经验`)
  // 标签模板和提炼提示词都在数据库里、我自己维护，每次现取
  const templates = await loadTagTemplates()
  const extractRules = await loadExtractRules()
  let extracted, model, usage, attempts, latencyMs, prompt, raw
  try {
    ;({
      result: extracted,
      model,
      usage,
      attempts,
      latencyMs,
      prompt,
      raw
    } = await extractCase(
      {
        symbol: input.symbol.toUpperCase(),
        timeframe: input.timeframe,
        note: input.note ?? '',
        seriesText,
        segments,
        stats,
        sr
      },
      config,
      templates,
      extractRules.system
    ))
  } catch (e) {
    markFailed('extract', (e as Error).message)
    throw e
  }
  // AI 自己造的词一律丢掉，只留模板里的
  const tags = pickTemplates(extracted.tags, templates)
  const dropped = extracted.tags.filter(t => !tags.includes(t))
  endExtract(
    `${model} · ${usage.promptTokens}+${usage.completionTokens} tok · ${stats.bars} 根 → ${extracted.title}` +
      (tags.length ? ` · 标签 ${tags.join('/')}` : '') +
      (dropped.length ? ` · 丢掉自造标签 ${dropped.join('/')}` : '') +
      (!templates.length ? ' · 当前没有标签模板' : '') +
      (attempts > 1 ? ` · 重试 ${attempts} 次` : '')
  )

  /* ---- 5. 记账 + 存档 ---- */
  const endSave = start('save', '记账并存进知识库')
  const billed = await recordUsage({
    kind: 'extract',
    model,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    usage,
    attempts,
    latencyMs
  })

  const caseStats: CaseStats = {
    bars: stats.bars,
    changePct: round2(stats.changePct),
    rangePct: round2(stats.rangePct),
    maxDrawdownPct: round2(stats.maxDrawdownPct),
    highAtPct: Math.round(stats.highAtPct),
    lowAtPct: Math.round(stats.lowAtPct),
    volTrend: stats.volTrend === null ? null : round2(stats.volTrend)
  }

  let caseId: number | null = null
  if (!input.dryRun) {
    caseId = await createCase({
      symbol: input.symbol.toUpperCase(),
      ccxtSymbol: null,
      exchange: config.exchange,
      timeframe: input.timeframe,
      moveType: extracted.moveType,
      tags,
      title: extracted.title,
      why: extracted.why,
      note: input.note ?? '',
      lesson: extracted.lesson,
      features: extracted.features,
      windowStart: windowCandles[0].timestamp,
      windowEnd: windowEndMs,
      candles: windowCandles,
      stats: caseStats,
      snapshot: {}
    })
  }
  endSave(
    input.dryRun
      ? '只分析不落库'
      : `案例 #${caseId} · ${windowCandles.length} 根 · ` +
          (templates.length
            ? `${templates.length} 个标签模板里挑了 ${tags.length} 个`
            : '没有标签模板，本次不打标签')
  )

  return {
    caseId,
    symbol: input.symbol.toUpperCase(),
    timeframe: input.timeframe,
    label: null,
    moveType: extracted.moveType,
    title: extracted.title,
    why: extracted.why,
    lesson: extracted.lesson,
    features: extracted.features,
    tags,
    tagTemplates: templates,
    stats: caseStats,
    window: {
      start: new Date(windowCandles[0].timestamp).toISOString(),
      end: new Date(windowEndMs).toISOString(),
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
    candleCount: candles.length,
    steps,
    meta: {
      model,
      warning: null,
      promptChars: seriesText.length,
      sr,
      prompt,
      raw,
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

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 北京时间 yyyy-mm-dd hh:mm */
export function bjFull(ms: number): string {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(ms)))
    p[x.type] = x.value
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toLocaleString('en-US', {maximumFractionDigits: 1})
  if (abs >= 1) return n.toFixed(3)
  return n.toPrecision(6)
}

/**
 * 拉「这段行情结束时」那一刻的 4H / 日线压力支撑。
 * 拉不到不算失败 —— 只是少一个参考维度。
 */
async function loadSRAt(
  at: number,
  input: Pick<CollectInput, 'symbol' | 'timeframe'>,
  config: ReturnType<typeof loadConfig>
): Promise<ExtractSR[]> {
  const out: ExtractSR[] = []
  for (const spec of SR_INPUT) {
    // 案例本身要是 4H/日线，就不重复喂了
    if (spec.timeframe === input.timeframe) continue
    try {
      const r = await fetchSRAt({
        exchangeId: config.exchange,
        symbol: input.symbol,
        timeframe: spec.timeframe,
        at,
        bars: spec.bars,
        marketType: config.marketType,
        apiBase: config.apiBase
      })
      if (r) {
        out.push({
          timeframe: r.timeframe.toUpperCase(),
          bars: r.bars,
          resistance: r.resistance,
          support: r.support
        })
      }
    } catch {
      /* 大周期拉不到就算了 */
    }
  }
  return out
}

export type {KnowledgeRow}

/* ------------------------------------------------------------------ */
/* 重新提炼                                                            */
/* ------------------------------------------------------------------ */

export interface ReeditInput {
  /** 改掉备注再提炼（不传就用库里原来的） */
  note?: string
  /** 一步步往外报进度 */
  onStep?: OnStep
}

/**
 * 用库里已经存下的 K 线重跑一次 AI 提炼。
 *
 * 用途：录完之后发现经验总结得不对、或者改了备注，
 * 不用重新拉行情（拉到的也不是当时那段了），直接就地重算。
 */
export async function reeditCase(
  id: number,
  input: ReeditInput = {}
): Promise<CollectResult> {
  const config = loadConfig()
  const {steps, start, markFailed} = stepRecorder(input.onStep)

  const endLoad = start('load', `读案例 #${id} 存下的 K 线`)
  const row = await getCase(id)
  if (!row) {
    markFailed('load', `案例 #${id} 不存在`)
    throw new Error(`案例 #${id} 不存在`)
  }

  const candles = row.candles
  if (candles.length < 20) {
    markFailed('load', `只存了 ${candles.length} 根，不够重算`)
    throw new Error('这条案例没存下 K 线，无法重新提炼，请删掉重新收录。')
  }

  // 库里存的就是当初拉的整段，直接用，不再做任何裁剪
  const windowCandles = candles
  const windowEndMs = windowCandles[windowCandles.length - 1].timestamp
  const note = input.note ?? row.note
  endLoad(
    `${windowCandles.length} 根 · ${bjFull(
      windowCandles[0].timestamp
    )} → ${bjFull(windowEndMs)}`
  )

  /* 那一刻的 4H / 日线压力支撑（跟首次收录保持同一条口径） */
  const endSR = start('sr', '算这一刻的 4H / 日线压力支撑')
  const sr = await loadSRAt(
    windowEndMs,
    {symbol: row.symbol, timeframe: row.timeframe as Timeframe},
    config
  )
  endSR(sr.length ? sr.map(x => x.timeframe).join(' · ') : '拉不到，跳过')

  const endDescribe = start('describe', '把行情切成小段读结构')
  const {text: seriesText, segments, stats} = describeSeries(candles)
  endDescribe(`${stats.bars} 根 → ${segments.length} 小段`)

  const endExtract = start('extract', `调用 ${config.llm.model} 重新提炼`)
  const templates = await loadTagTemplates()
  const extractRules = await loadExtractRules()
  let extracted, model, usage, attempts, latencyMs, prompt, raw
  try {
    ;({
      result: extracted,
      model,
      usage,
      attempts,
      latencyMs,
      prompt,
      raw
    } = await extractCase(
      {
        symbol: row.symbol,
        timeframe: row.timeframe,
        note,
        seriesText,
        segments,
        stats,
        sr
      },
      config,
      templates,
      extractRules.system
    ))
  } catch (e) {
    markFailed('extract', (e as Error).message)
    throw e
  }
  const tags = pickTemplates(extracted.tags, templates)
  endExtract(
    `${model} · ${usage.promptTokens}+${usage.completionTokens} tok · ${extracted.title}` +
      (tags.length ? ` · 标签 ${tags.join('/')}` : '')
  )

  const endSave = start('save', '写回案例')
  const billed = await recordUsage({
    kind: 'extract',
    model,
    symbol: row.symbol,
    timeframe: row.timeframe,
    usage,
    attempts,
    latencyMs
  })

  const caseStats: CaseStats = {
    bars: stats.bars,
    changePct: round2(stats.changePct),
    rangePct: round2(stats.rangePct),
    maxDrawdownPct: round2(stats.maxDrawdownPct),
    highAtPct: Math.round(stats.highAtPct),
    lowAtPct: Math.round(stats.lowAtPct),
    volTrend: stats.volTrend === null ? null : round2(stats.volTrend)
  }

  await updateCase(id, {
    note,
    moveType: extracted.moveType,
    tags,
    title: extracted.title,
    why: extracted.why,
    lesson: extracted.lesson,
    features: extracted.features
  })
  endSave(`案例 #${id} 已更新`)

  return {
    caseId: id,
    symbol: row.symbol,
    timeframe: row.timeframe as Timeframe,
    label: row.label,
    moveType: extracted.moveType,
    title: extracted.title,
    why: extracted.why,
    lesson: extracted.lesson,
    features: extracted.features,
    tags,
    tagTemplates: templates,
    stats: caseStats,
    window: {
      start: new Date(windowCandles[0].timestamp).toISOString(),
      end: new Date(windowEndMs).toISOString(),
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
    candleCount: candles.length,
    steps,
    meta: {
      model,
      warning: null,
      promptChars: seriesText.length,
      sr,
      prompt,
      raw,
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
