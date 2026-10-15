/**
 * **跑一次开单分析**（2026-10-15 从 `server.ts` 抽出来的）。
 *
 * 为什么要抽：`runAnalysis` 原来只活在 HTTP 处理器里，而「持久化分析」
 *（每 15 分钟自动跑一发，见 `analysis/persist.ts`）**不能走 HTTP 绕回自己** ——
 * 它得直接调这个函数。`docs/AUTO-PREDICT.md` §6.2 早就把「把 `runAnalysis` 抽成
 * 独立模块」列进了计划，这次一起做掉。
 *
 * 行为跟抽取前**逐字一致**：读提示词 → 拉行情 → 拼上下文 → 调模型 → 记账 → 存档
 *（测试跑不存档）。唯一新增的是 `source` 参数，落进 `analyses.source`，
 * 用来区分「手动跑的」和「持久化跑的」（页面上分开看、复盘分开统计）。
 */
import {loadConfig} from '../config'
import {loadRules} from '../rules'
import {resolveUserLlm} from '../db/llm-keys'
import {recordUsage} from '../db/usage'
import {saveAnalysis} from '../db/analyses'
import {buildContext} from '../context/builder'
import {judge, type JudgeResult} from '../llm/client'
import {oneLineCost, usdToCny} from '../llm/pricing'
import {bjFull} from '../knowledge-service'
import {stepRecorder, type AnalyzeStep, type OnStep} from '../step'
import {fetchSnapshot} from '../data/market'
import type {MarketSnapshot, MarketType, Timeframe} from '../types'

/** `BTC/USDT:USDT` → `BTC`（跟知识库里的写法保持一致） */
export function baseSymbol(ccxtSymbol: string): string {
  return (
    ccxtSymbol
      .split('/')[0]
      ?.replace(/:[^:]*$/, '')
      .toUpperCase() ?? ccxtSymbol
  )
}

/** 分析过程中的一步，用于前端「分析过程」时间线 */
export type {AnalyzeStep}

/** 这一跑是谁发起的 —— 落 `analyses.source` */
export type AnalysisSource = 'manual' | 'persist'

export interface AnalyzeOutcome {
  symbol: string
  ccxtSymbol: string
  exchange: string
  marketType: string
  /** 是不是「回到某一刻」的测试跑（不存档） */
  testMode: boolean
  /** 测试跑的时间点（毫秒）；实时跑是 null */
  at: number | null
  price: number
  /** 每个周期的 K 线是从本地库还是交易所来的（给「分析过程」显示） */
  sources: MarketSnapshot['sources']
  /** 主周期（图上那个） */
  primary: Timeframe
  /** 行情块 —— 只有主周期一个（最近 100 根逐根） */
  blocks: MarketSnapshot['blocks']
  /** 主周期的 K 线（给前端画图） */
  candles: MarketSnapshot['candles']
  /** 主周期往前看了多少天 */
  days: number
  judge: JudgeResult
  /** 本次分析走了哪几步（前端画时间线） */
  steps: AnalyzeStep[]
  meta: {
    model: string
    rules: {sources: string[]; hash: string; warnings: string[]}
    /** 本次给了多少个可用标签 */
    tagCount: number
    usage: {
      callId: number | null
      promptTokens: number
      completionTokens: number
      totalTokens: number
      cacheHitTokens: number
      costUsd: number
      costCny: number
      attempts: number
      latencyMs: number
      text: string
    }
  }
}

function sourceText(sources: MarketSnapshot['sources']): string {
  const db = sources.filter(s => s.from === 'db').map(s => s.timeframe)
  const rest = sources.filter(s => s.from === 'rest').map(s => s.timeframe)
  if (!rest.length) return `数据：本地库（${db.join(' / ')}）`
  if (!db.length) return `数据：交易所现拉（${rest.join(' / ')}）`
  return `数据：本地库（${db.join(' / ')}）+ 交易所兜底（${rest.join(' / ')}）`
}

export async function runAnalysis(opts: {
  /** 谁在分析（用户系统） */
  userId: number
  symbol: string
  market?: MarketType
  /** 主周期（图上那个） */
  timeframe: Timeframe
  /** 主周期往前看多少天；0 = 用配置默认值 */
  days: number
  /** 测试时间点（毫秒）：只看到那一刻为止的数据，且不存档 */
  at?: number | null
  /** 这一跑是谁发起的（默认手动）—— 只影响 `analyses.source` 那一列 */
  source?: AnalysisSource
  onStep?: OnStep
}): Promise<AnalyzeOutcome> {
  const {symbol: symbolInput, market, timeframe} = opts
  const {steps, start: step, markFailed} = stepRecorder(opts.onStep)
  const testAt = opts.at ?? null

  // 1. 读分析预测提示词（数据库里那份 kind=predict）
  const endRules = step('rules', '读分析预测提示词')
  const rules = await loadRules()
  if (rules.dbError) {
    // 没有角色和规则的判断等于让 AI 自由发挥，宁可不开跑
    markFailed('rules', rules.dbError)
    throw new Error(
      `读不到提示词文档（角色/规则），先确认数据库正常：${rules.dbError}`
    )
  }
  endRules(
    rules.bodyEnabled
      ? `${rules.sources.join('、')} · ${rules.system.length} 字 · ${rules.hash}`
      : '（没有启用的分析预测提示词 —— 去「我的 → AI 提示词」写一份）'
  )

  // 用哪把密钥：**默认**那把（多密钥，2026-10-04）；用量会记到它名下
  const resolved = await resolveUserLlm(opts.userId)
  const config = loadConfig({
    marketType: market,
    timeframes: [timeframe],
    llm: resolved.llm
  })
  /** 主周期看多少天（前端传的是「图上那段」的天数；没传就用配置默认值） */
  const days = Math.max(1, opts.days || config.lookbackDays)

  // 2. 拉行情
  const endFetch = step(
    'fetch',
    testAt
      ? `拉取 ${symbolInput} 行情（测试：${bjFull(testAt)} 为止）`
      : `拉取 ${symbolInput} 行情`
  )
  let snapshot: MarketSnapshot
  try {
    snapshot = await fetchSnapshot({
      exchangeId: config.exchange,
      symbol: symbolInput,
      timeframe,
      days,
      marketType: config.marketType,
      apiBase: config.apiBase,
      calibers: config.calibers,
      // 测试模式：只看得见这一刻之前已收盘的 K 线
      at: testAt ?? undefined
    })
  } catch (e) {
    markFailed('fetch', (e as Error).message)
    throw e
  }
  endFetch(
    `${snapshot.symbol} · 主周期 ${timeframe}（图上 ${days} 天）· ` +
      `现价 ${snapshot.price}` +
      ` · 发给 AI：${snapshot.blocks.map(b => `${b.timeframe} ${b.bars} 根`).join(' / ')}` +
      ` · ${sourceText(snapshot.sources)}`
  )

  // 4. 构建上下文
  const endCtx = step('context', '构建喂给 AI 的行情快照')
  const context = buildContext(snapshot)
  endCtx(
    `${context.length} 字（主周期最近 ${snapshot.blocks[0]?.bars ?? 0} 根逐根，不算口径）`
  )

  // 5. 调用大模型
  const endJudge = step('judge', `调用 ${config.llm.model} 判断`)
  let result: JudgeResult
  let meta: Awaited<ReturnType<typeof judge>>['meta']
  try {
    ;({result, meta} = await judge({
      snapshot,
      context,
      prompt: rules.system,
      config
    }))
  } catch (e) {
    markFailed('judge', (e as Error).message)
    throw e
  }
  endJudge(
    `${meta.model} · ${meta.usage.promptTokens}+${meta.usage.completionTokens} tok · 回答 ${meta.raw.length} 字` +
      (config.llm.reasoningEffort
        ? ` · 思考=${config.llm.reasoningEffort}`
        : '') +
      (meta.attempts > 1 ? ` · 重试 ${meta.attempts} 次` : '')
  )

  // 6. 记账 + 存档：历史就存这一句话（测试跑不存档）
  const endArchive = step('archive', '记账')
  const billed = await recordUsage({
    userId: opts.userId,
    llmKeyId: resolved.keyId,
    kind: 'judge',
    model: meta.model,
    symbol: baseSymbol(snapshot.symbol),
    timeframe,
    usage: meta.usage,
    attempts: meta.attempts,
    latencyMs: meta.latencyMs
  })
  if (testAt === null && result.line.trim()) {
    // 旁路：存档失败不该把这次分析搞挂
    try {
      await saveAnalysis({
        userId: opts.userId,
        symbol: baseSymbol(snapshot.symbol),
        ccxtSymbol: snapshot.symbol,
        exchange: config.exchange,
        marketType: config.marketType,
        timeframe,
        line: result.line.trim(),
        price: snapshot.price,
        model: meta.model,
        costUsd: billed?.costUsd ?? null,
        llmUsageId: billed?.id ?? null,
        latencyMs: meta.latencyMs,
        promptTokens: meta.usage.promptTokens,
        completionTokens: meta.usage.completionTokens,
        source: opts.source ?? 'manual'
      })
    } catch (e) {
      console.error('[analyses] 存档失败：', (e as Error).message)
    }
  }
  endArchive(oneLineCost(meta.usage, billed?.costUsd ?? 0, meta.latencyMs))

  return {
    symbol: baseSymbol(snapshot.symbol),
    ccxtSymbol: snapshot.symbol,
    exchange: config.exchange,
    marketType: config.marketType,
    testMode: testAt !== null,
    at: testAt,
    price: snapshot.price,
    sources: snapshot.sources,
    primary: snapshot.primary,
    blocks: snapshot.blocks,
    candles: snapshot.candles,
    days,
    judge: result,
    steps,
    meta: {
      model: meta.model,
      rules: {
        sources: rules.sources,
        hash: rules.hash,
        warnings: rules.warnings
      },
      tagCount: 0,
      // 本次调用的 token 与花费（统计用）
      usage: {
        callId: billed?.id ?? null,
        promptTokens: meta.usage.promptTokens,
        completionTokens: meta.usage.completionTokens,
        totalTokens: meta.usage.totalTokens,
        cacheHitTokens: meta.usage.cacheHitTokens,
        costUsd: billed?.costUsd ?? 0,
        costCny: usdToCny(billed?.costUsd ?? 0),
        attempts: meta.attempts,
        latencyMs: meta.latencyMs,
        text: oneLineCost(meta.usage, billed?.costUsd ?? 0, meta.latencyMs)
      }
    }
  }
}
