/**
 * 预测历史（`analyses` 表）。
 *
 * 2026-10-10 重置：整个分析模块只剩「一句话」输出，所以存档也只剩它 ——
 * 币种 / 时间 / 那一句话。表里那堆老列（档位、标签、仓位、结算…）留着不写。
 * 列表只按「币种 + 时间段」筛，跟页面上的两个筛选框一一对应。
 */
import {query, queryOne} from './client'

export interface SaveAnalysisInput {
  /** 这笔预测算谁的 */
  userId: number
  /** 基础币，如 BTC */
  symbol: string
  /** 交易所标的，如 BTC/USDT:USDT */
  ccxtSymbol: string
  exchange: string
  marketType: string
  /** 喂给 AI 的周期（主周期） */
  timeframe: string
  /** AI 给的那一句话 */
  line: string
  /** 分析那一刻的现价 */
  price: number
  model: string
  /** 这次调用花了多少（来自 llm_usage） */
  costUsd: number | null
  llmUsageId: number | null
  latencyMs: number
  promptTokens: number
  completionTokens: number
  /**
   * 这一跑是谁发起的（2026-10-15）：`manual` 手点的 / `persist` 后台持久化跑的。
   * 不传按 `manual`（老调用点不用改）。
   */
  source?: 'manual' | 'persist'
}

/** 列表里的一行：够显示「时间 · 币种 · 周期 · 一句话」就行 */
export interface PredictionRow {
  id: number
  symbol: string
  /**
   * 分析时喂给 AI 的**主周期**（`analyses.chart_timeframe`）。
   *
   * ★ 2026-10-15 用户：「预测结果 每条数据要带周期」—— 同一个币在 15m / 1h / 4h 上
   *   结论可能正好相反，列表里不写周期，两条记录看着像自相矛盾。
   */
  timeframe: string | null
  /** AI 那一句话 */
  line: string
  price: number | null
  createdAt: string
}

export interface ListAnalysesQuery {
  userId: number
  /** 只看这个币（空 = 全部） */
  symbol?: string
  /** 只看最近 N 天 */
  days: number
  limit: number
  offset: number
}

function rowOf(r: {
  id: string | number
  symbol: string
  chart_timeframe: string | null
  line: string | null
  price: string | null
  created_at: Date | string
}): PredictionRow {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    timeframe: r.chart_timeframe ?? null,
    line: r.line ?? '',
    price: r.price === null ? null : Number(r.price),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at)
  }
}

/**
 * 存一条预测。
 *
 * 跟 `recordUsage` 一样是旁路：存不下也不该把这次分析搞挂，
 * 所以调用方（`runAnalysis`）把它包在 try 里。
 */
export async function saveAnalysis(input: SaveAnalysisInput): Promise<number> {
  const rows = await query<{id: string}>(
    `INSERT INTO analyses (
       user_id, symbol, ccxt_symbol, exchange, market_type, timeframes,
       chart_timeframe, grade_reason, price, model, cost_usd, llm_usage_id,
       latency_ms, prompt_tokens, completion_tokens, result, source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      input.userId,
      input.symbol,
      input.ccxtSymbol,
      input.exchange,
      input.marketType,
      [input.timeframe],
      input.timeframe,
      input.line,
      input.price,
      input.model,
      input.costUsd,
      input.llmUsageId,
      input.latencyMs,
      input.promptTokens,
      input.completionTokens,
      JSON.stringify({line: input.line}),
      input.source ?? 'manual'
    ]
  )
  return Number(rows[0]?.id ?? 0)
}

/** 列表：按时间倒序，最新的在最上面 */
export async function listAnalyses(
  q: ListAnalysesQuery
): Promise<{rows: PredictionRow[]; total: number}> {
  const where = ['user_id = $1', `created_at >= now() - make_interval(days => $2)`]
  const params: unknown[] = [q.userId, q.days]
  if (q.symbol) {
    params.push(q.symbol.toUpperCase())
    where.push(`symbol = $${params.length}`)
  }
  const cond = where.join(' AND ')

  const rows = await query<{
    id: string
    symbol: string
    chart_timeframe: string | null
    line: string | null
    price: string | null
    created_at: Date
  }>(
    `SELECT id, symbol, chart_timeframe, grade_reason AS line, price, created_at
       FROM analyses
      WHERE ${cond}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, q.offset]
  )

  const total = await queryOne<{n: string}>(
    `SELECT count(*)::text AS n FROM analyses WHERE ${cond}`,
    params
  )

  return {rows: rows.map(rowOf), total: Number(total?.n ?? 0)}
}

/** 删一条（列表里那条 ✕） */
export async function deleteAnalysis(
  userId: number,
  id: number
): Promise<boolean> {
  const rows = await query<{id: string}>(
    `DELETE FROM analyses WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  )
  return rows.length > 0
}
