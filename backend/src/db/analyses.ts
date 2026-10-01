import {query, queryOne} from './client'
import type {
  Expectancy,
  GuardrailResult,
  MarketSnapshot,
  StructureState,
  TimeframeTrend,
  Violation
} from '../types'
import type {JudgeResult} from '../llm/client'
import type {TokenUsage} from '../llm/pricing'

/**
 * 分析存档。
 *
 * 一次分析 = 一行 `analyses`：
 *   输入（问的是谁、什么周期、什么假设）
 * + 结论（档位 / 结果 / 置信度）
 * + 计划（入场 / 止损 / 止盈 / R / 仓位）
 * + 护栏（红线、一票否决）
 * + 全量存档（AI 原始输出、行情快照，回放用）
 * + 事后结果（复盘用，先留 null）
 *
 * 规则全文不在这里，按 hash 存在 `rules_versions`，避免每行重复 6.6K。
 */

/** 事后结果分类 */
export type OutcomeKind =
  | 'tp1'
  | 'tp2'
  | 'tp3'
  | 'sl'
  | 'breakeven'
  | 'expired'
  | 'skipped'

export const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  tp1: '到 TP1',
  tp2: '到 TP2',
  tp3: '到 TP3',
  sl: '打止损',
  breakeven: '平手离场',
  expired: '到期没触发',
  skipped: '看了没做'
}

export interface SaveAnalysisInput {
  symbol: string
  ccxtSymbol: string | null
  exchange: string
  marketType: string
  timeframes: string[]
  assumedWinRate: number
  chartTimeframe: string
  judge: JudgeResult
  guardrails: GuardrailResult
  expectancy: Expectancy | null
  snapshot: MarketSnapshot
  meta: Record<string, unknown>
  model: string
  rulesHash: string | null
  llmUsageId: number | null
  usage: TokenUsage
  /** 本次花费（美元），从 llm_usage 带回来 */
  costUsd: number | null
  latencyMs: number
  attempts: number
}

export interface AnalysisRow {
  id: number
  symbol: string
  exchange: string
  marketType: string
  timeframes: string[]
  grade: string | null
  gradeReason: string | null
  verdict: string | null
  confidence: number | null
  direction: string | null
  price: number | null
  entryPrice: number | null
  entryType: string | null
  stopLoss: number | null
  stopPct: number | null
  tp1Price: number | null
  tp2Price: number | null
  tp3Price: number | null
  rrFinal: number | null
  expectancyR: number | null
  positionQty: number | null
  leverageUsed: number | null
  guardPassed: boolean | null
  veto: string[]
  redLines: string[]
  model: string | null
  rulesHash: string | null
  knowledgeRefs: {symbol: string; timeframe: string; lesson: string}[]
  costUsd: number | null
  latencyMs: number | null
  outcome: OutcomeKind | null
  rMultiple: number | null
  outcomeAt: string | null
  outcomeNote: string | null
  createdAt: string
}

/** 详情：附带回放用的全量 JSON + 当时的规则全文 */
export interface AnalysisDetail extends AnalysisRow {
  ccxtSymbol: string | null
  assumedWinRate: number | null
  verdictReason: string | null
  positionNotional: number | null
  riskAmount: number | null
  chartTimeframe: string | null
  promptTokens: number | null
  completionTokens: number | null
  attempts: number | null
  mfePct: number | null
  maePct: number | null
  outcomePrice: number | null
  /** AI 完整输出（checklist / exitTriggers / coachLine 都在里面） */
  result: JudgeResult
  /** 护栏逐条明细 */
  guardrails: GuardrailResult
  expectancy: Expectancy | null
  /** 行情快照：多周期统计 + 市场热度 + 价格结构 */
  snapshot: {
    price?: number
    timeframes?: TimeframeTrend[]
    heat?: Record<string, unknown>
    structure?: StructureState
  }
  meta: Record<string, unknown>
  /** 当时用的规则全文（从 rules_versions 带出来） */
  rules: {hash: string; sources: string[]; system: string; body: string} | null
}

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}
const s = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v)

/* ------------------------------------------------------------------ */
/* 规则版本                                                            */
/* ------------------------------------------------------------------ */

/**
 * 记一份规则快照。同一个 hash 只写一次（ON CONFLICT DO NOTHING）。
 * 没有它，以后规则改了就看不出「当时 AI 读的是什么」。
 */
export async function saveRulesVersion(r: {
  hash: string
  system: string
  body: string
  sources: string[]
}): Promise<void> {
  await query(
    `INSERT INTO rules_versions (hash, system, body, sources, chars)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (hash) DO NOTHING`,
    [r.hash, r.system, r.body, r.sources, r.system.length + r.body.length]
  )
}

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

/** 存一次分析，返回 id */
export async function saveAnalysis(input: SaveAnalysisInput): Promise<number> {
  const j = input.judge
  const g = input.guardrails
  const p = g.position
  const tps = j.takeProfits ?? []
  const entry = j.entry?.price ?? null
  const stop = j.stopLoss ?? null
  const stopPct =
    entry !== null && stop !== null && entry !== 0
      ? Math.round(((stop - entry) / entry) * 100 * 10000) / 10000
      : null

  const rows = await query<{id: string}>(
    `INSERT INTO analyses (
       symbol, ccxt_symbol, exchange, market_type, timeframes, assumed_win_rate,
       grade, grade_reason, verdict, verdict_reason, confidence, direction,
       price, entry_price, entry_type, stop_loss, stop_pct,
       tp1_price, tp2_price, tp3_price, rr_final, expectancy_r,
       position_qty, position_notional, risk_amount, leverage_used,
       guard_passed, veto, red_lines,
       model, rules_hash, knowledge_refs, llm_usage_id,
       prompt_tokens, completion_tokens, cost_usd, latency_ms, attempts,
       chart_timeframe,
       result, guardrails, expectancy, snapshot, meta
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23, $24,
       $25, $26, $27, $28, $29, $30,
       $31, $32, $33, $34, $35, $36,
       $37, $38, $39, $40, $41, $42,
       $43, $44
     ) RETURNING id`,
    [
      input.symbol,
      input.ccxtSymbol,
      input.exchange,
      input.marketType,
      input.timeframes,
      input.assumedWinRate,
      s(j.grade),
      s(j.gradeReason),
      s(j.verdict),
      s(j.verdictReason),
      n(j.confidence),
      s(j.direction),
      input.snapshot.price ?? null,
      entry,
      j.entry?.type ?? null,
      stop,
      stopPct,
      tps[0]?.price ?? null,
      tps[1]?.price ?? null,
      tps[2]?.price ?? null,
      n(g.rMultiple),
      input.expectancy?.expectancyR ?? null,
      p?.quantity ?? null,
      p?.notional ?? null,
      p?.riskAmount ?? null,
      p?.leverageUsed ?? null,
      g.passed ?? null,
      j.failedCritical ?? [],
      (g.violations ?? []).map((v: Violation) => v.desc || v.id),
      input.model,
      input.rulesHash,
      JSON.stringify(j.knowledgeRefs ?? []),
      input.llmUsageId,
      input.usage.promptTokens,
      input.usage.completionTokens,
      input.costUsd,
      Math.round(input.latencyMs),
      input.attempts,
      input.chartTimeframe,
      JSON.stringify(j),
      JSON.stringify(g),
      input.expectancy ? JSON.stringify(input.expectancy) : null,
      JSON.stringify({
        price: input.snapshot.price,
        timeframes: input.snapshot.timeframes,
        heat: input.snapshot.heat,
        structure: input.snapshot.structure
      }),
      JSON.stringify(input.meta)
    ]
  )

  const row = rows[0]
  if (!row) throw new Error('分析记录写入失败')
  return Number(row.id)
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

const LIST_COLS = `id, symbol, exchange, market_type, timeframes,
  grade, grade_reason, verdict, confidence, direction,
  price, entry_price, entry_type, stop_loss, stop_pct,
  tp1_price, tp2_price, tp3_price, rr_final, expectancy_r,
  position_qty, leverage_used,
  guard_passed, veto, red_lines,
  model, rules_hash, knowledge_refs, cost_usd, latency_ms,
  outcome, r_multiple, outcome_at, outcome_note, created_at`

interface RawRow {
  id: string
  symbol: string
  exchange: string
  market_type: string
  timeframes: string[] | null
  grade: string | null
  grade_reason: string | null
  verdict: string | null
  confidence: number | null
  direction: string | null
  price: string | null
  entry_price: string | null
  entry_type: string | null
  stop_loss: string | null
  stop_pct: string | null
  tp1_price: string | null
  tp2_price: string | null
  tp3_price: string | null
  rr_final: string | null
  expectancy_r: string | null
  position_qty: string | null
  leverage_used: string | null
  guard_passed: boolean | null
  veto: string[] | null
  red_lines: string[] | null
  model: string | null
  rules_hash: string | null
  knowledge_refs: {symbol: string; timeframe: string; lesson: string}[] | null
  cost_usd: string | null
  latency_ms: number | null
  outcome: string | null
  r_multiple: string | null
  outcome_at: Date | null
  outcome_note: string | null
  created_at: Date
}

function mapRow(r: RawRow): AnalysisRow {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    exchange: r.exchange,
    marketType: r.market_type,
    timeframes: r.timeframes ?? [],
    grade: r.grade,
    gradeReason: r.grade_reason,
    verdict: r.verdict,
    confidence: n(r.confidence),
    direction: r.direction,
    price: n(r.price),
    entryPrice: n(r.entry_price),
    entryType: r.entry_type,
    stopLoss: n(r.stop_loss),
    stopPct: n(r.stop_pct),
    tp1Price: n(r.tp1_price),
    tp2Price: n(r.tp2_price),
    tp3Price: n(r.tp3_price),
    rrFinal: n(r.rr_final),
    expectancyR: n(r.expectancy_r),
    positionQty: n(r.position_qty),
    leverageUsed: n(r.leverage_used),
    guardPassed: r.guard_passed,
    veto: r.veto ?? [],
    redLines: r.red_lines ?? [],
    model: r.model,
    rulesHash: r.rules_hash,
    knowledgeRefs: r.knowledge_refs ?? [],
    costUsd: n(r.cost_usd),
    latencyMs: r.latency_ms,
    outcome: (r.outcome as OutcomeKind) ?? null,
    rMultiple: n(r.r_multiple),
    outcomeAt: r.outcome_at ? r.outcome_at.toISOString() : null,
    outcomeNote: r.outcome_note,
    createdAt: r.created_at.toISOString()
  }
}

export interface ListAnalysesOptions {
  /** 只看某个币种 */
  symbol?: string
  /** 只看某个档位（A/B/C/unclear） */
  grade?: string
  /** 只看某个结论（go/wait/no_go） */
  verdict?: string
  /** 只看可做的 */
  actionableOnly?: boolean
  /** 只看还没结算的 */
  pendingOnly?: boolean
  limit?: number
  offset?: number
}

function listWhere(o: ListAnalysesOptions): {where: string; params: unknown[]} {
  const parts: string[] = []
  const params: unknown[] = []
  const add = (sql: string, v: unknown) => {
    params.push(v)
    parts.push(sql.replace('?', `$${params.length}`))
  }

  if (o.symbol) add('symbol = ?', o.symbol.toUpperCase())
  if (o.grade) add('grade = ?', o.grade)
  if (o.verdict) add('verdict = ?', o.verdict)
  if (o.actionableOnly) parts.push(`verdict = 'go'`)
  if (o.pendingOnly) parts.push('outcome IS NULL')

  return {where: parts.length ? 'WHERE ' + parts.join(' AND ') : '', params}
}

export async function listAnalyses(
  o: ListAnalysesOptions = {}
): Promise<{rows: AnalysisRow[]; total: number}> {
  const {where, params} = listWhere(o)
  const limit = Math.max(1, Math.min(200, Math.round(o.limit ?? 30)))
  const offset = Math.max(0, Math.round(o.offset ?? 0))

  const [rows, total] = await Promise.all([
    query<RawRow>(
      `SELECT ${LIST_COLS} FROM analyses ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    query<{n: string}>(
      `SELECT count(*)::text AS n FROM analyses ${where}`,
      params
    )
  ])

  return {rows: rows.map(mapRow), total: Number(total[0]?.n ?? 0)}
}

export async function getAnalysis(id: number): Promise<AnalysisDetail | null> {
  const r = await queryOne<
    RawRow & {
      ccxt_symbol: string | null
      assumed_win_rate: string | null
      verdict_reason: string | null
      position_notional: string | null
      risk_amount: string | null
      chart_timeframe: string | null
      prompt_tokens: number | null
      completion_tokens: number | null
      attempts: number | null
      mfe_pct: string | null
      mae_pct: string | null
      outcome_price: string | null
      result: JudgeResult | null
      guardrails: GuardrailResult | null
      expectancy: Expectancy | null
      snapshot: AnalysisDetail['snapshot'] | null
      meta: Record<string, unknown> | null
      rv_hash: string | null
      rv_sources: string[] | null
      rv_system: string | null
      rv_body: string | null
    }
  >(
    `SELECT a.*,
            rv.hash    AS rv_hash,
            rv.sources AS rv_sources,
            rv.system  AS rv_system,
            rv.body    AS rv_body
       FROM analyses a
       LEFT JOIN rules_versions rv ON rv.hash = a.rules_hash
      WHERE a.id = $1`,
    [id]
  )
  if (!r) return null

  const base = mapRow(r)
  return {
    ...base,
    ccxtSymbol: r.ccxt_symbol,
    assumedWinRate: n(r.assumed_win_rate),
    verdictReason: r.verdict_reason,
    positionNotional: n(r.position_notional),
    riskAmount: n(r.risk_amount),
    chartTimeframe: r.chart_timeframe,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    attempts: r.attempts,
    mfePct: n(r.mfe_pct),
    maePct: n(r.mae_pct),
    outcomePrice: n(r.outcome_price),
    result: r.result ?? ({} as JudgeResult),
    guardrails: r.guardrails ?? ({} as GuardrailResult),
    expectancy: r.expectancy,
    snapshot: r.snapshot ?? {},
    meta: r.meta ?? {},
    rules: r.rv_hash
      ? {
          hash: r.rv_hash,
          sources: r.rv_sources ?? [],
          system: r.rv_system ?? '',
          body: r.rv_body ?? ''
        }
      : null
  }
}

/* ------------------------------------------------------------------ */
/* 事后结算（复盘）                                                     */
/* ------------------------------------------------------------------ */

export async function settleAnalysis(
  id: number,
  o: {
    outcome: OutcomeKind
    outcomePrice?: number | null
    rMultiple?: number | null
    mfePct?: number | null
    maePct?: number | null
    note?: string | null
  }
): Promise<boolean> {
  const rows = await query(
    `UPDATE analyses SET
       outcome = $2, outcome_at = now(), outcome_price = $3,
       r_multiple = $4, mfe_pct = $5, mae_pct = $6, outcome_note = $7
     WHERE id = $1
     RETURNING id`,
    [
      id,
      o.outcome,
      o.outcomePrice ?? null,
      o.rMultiple ?? null,
      o.mfePct ?? null,
      o.maePct ?? null,
      o.note ?? null
    ]
  )
  return rows.length > 0
}

export async function deleteAnalysis(id: number): Promise<boolean> {
  const rows = await query('DELETE FROM analyses WHERE id = $1 RETURNING id', [
    id
  ])
  return rows.length > 0
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export interface GradeStat {
  grade: string
  calls: number
  goCount: number
  settled: number
  winRate: number | null
  avgR: number | null
  totalR: number | null
}

export interface AnalysisStats {
  total: number
  byGrade: GradeStat[]
  /** 按币种：做过的次数 + 实际平均 R */
  bySymbol: {
    symbol: string
    calls: number
    settled: number
    avgR: number | null
  }[]
  /** 还没结算的可做单 */
  pending: number
  costUsd: number
}

/** 档位统计：回答「A 档真的比 B 档好吗」 */
export async function analysisStats(days = 365): Promise<AnalysisStats> {
  const d = Math.max(1, Math.min(3650, Math.round(days)))
  const since = `now() - interval '${d} days'`

  const [totals, byGrade, bySymbol] = await Promise.all([
    query<{n: string; pending: string; cost: string}>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE outcome IS NULL AND verdict = 'go')::text AS pending,
              COALESCE(sum(cost_usd), 0)::text AS cost
         FROM analyses WHERE created_at >= ${since}`
    ),
    query<{
      grade: string
      calls: string
      go_count: string
      settled: string
      wins: string
      avg_r: string | null
      total_r: string | null
    }>(
      `SELECT COALESCE(grade, 'unclear') AS grade,
              count(*)::text AS calls,
              count(*) FILTER (WHERE verdict = 'go')::text AS go_count,
              count(*) FILTER (WHERE outcome IS NOT NULL)::text AS settled,
              count(*) FILTER (WHERE r_multiple > 0)::text AS wins,
              avg(r_multiple) FILTER (WHERE outcome IS NOT NULL)::text AS avg_r,
              sum(r_multiple) FILTER (WHERE outcome IS NOT NULL)::text AS total_r
         FROM analyses
        WHERE created_at >= ${since}
        GROUP BY 1`
    ),
    query<{
      symbol: string
      calls: string
      settled: string
      avg_r: string | null
    }>(
      `SELECT symbol,
              count(*)::text AS calls,
              count(*) FILTER (WHERE outcome IS NOT NULL)::text AS settled,
              avg(r_multiple) FILTER (WHERE outcome IS NOT NULL)::text AS avg_r
         FROM analyses
        WHERE created_at >= ${since}
        GROUP BY 1
        ORDER BY count(*) DESC
        LIMIT 30`
    )
  ])

  const t = totals[0]
  return {
    total: Number(t?.n ?? 0),
    pending: Number(t?.pending ?? 0),
    costUsd: Number(t?.cost ?? 0),
    byGrade: byGrade.map(r => {
      const settled = Number(r.settled)
      const wins = Number(r.wins)
      return {
        grade: r.grade,
        calls: Number(r.calls),
        goCount: Number(r.go_count),
        settled,
        winRate: settled > 0 ? wins / settled : null,
        avgR: n(r.avg_r),
        totalR: n(r.total_r)
      }
    }),
    bySymbol: bySymbol.map(r => ({
      symbol: r.symbol,
      calls: Number(r.calls),
      settled: Number(r.settled),
      avgR: n(r.avg_r)
    }))
  }
}
