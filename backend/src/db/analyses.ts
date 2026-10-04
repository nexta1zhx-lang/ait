import {query, queryOne} from './client'
import type {MarketSnapshot} from '../types'
import type {JudgeResult} from '../llm/client'
import type {TokenUsage} from '../llm/pricing'

/**
 * 分析存档。
 *
 * 一次分析 = 一行 `analyses`：
 *   输入（问的是谁、什么周期、什么假设）
 * + 结论（档位 / 结果）
 * + 计划（入场 / 止损 / 止盈 / R / 仓位）
 * + 护栏（红线、一票否决）
 * + 全量存档（AI 原始输出、行情快照，回放用）
 * + 事后结果（复盘用，先留 null）
 *
 * 规则全文不在这里，按 hash 存在 `rules_versions`，避免每行重复 6.6K。
 */

/*
 * 事后结算（outcome / R 倍数 / MFE / MAE）已于 2026-10-02 删除：
 * 没有止损止盈就没有 R 可算，也就没有胜率统计可言。
 * 表里那几列还留着（老记录要能读），新记录一律 null。
 */

export interface SaveAnalysisInput {
  /** 这条记录属于谁（用户系统，2026-10-04）；null = 没归属（CLI 还没建号时） */
  userId: number | null
  symbol: string
  ccxtSymbol: string | null
  exchange: string
  marketType: string
  timeframes: string[]
  chartTimeframe: string
  /** AI 的四个字段：档位 / 标签 / 理由 / 结论 */
  judge: JudgeResult
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

/**
 * 存进 `analyses.tags` 的形状标签 + 概率。
 *
 * ⚠️ 2026-10-02 之前的记录存的是**纯字符串数组**，读回来当 `string` 用 ——
 * 展示前要判一下 `typeof`（前端 `tagsOf()` 就是这么兼容的）。
 */
export interface JudgeTagRow {
  name: string
  probability: number
}

export interface AnalysisRow {
  id: number
  symbol: string
  exchange: string
  marketType: string
  timeframes: string[]
  grade: string | null
  /** AI 那段 reason 存在这一列（列名是老名字，没改，省一次迁移） */
  gradeReason: string | null
  verdict: string | null
  /** AI 挑的形状标签 + 概率（跟知识库同一份标签池） */
  tags: JudgeTagRow[]
  price: number | null
  model: string | null
  rulesHash: string | null
  costUsd: number | null
  latencyMs: number | null
  createdAt: string
}

/**
 * 详情：附带回放用的全量 JSON + 当时的规则全文。
 *
 * ⚠️ 表里还留着一堆**废弃列**（仓位 / 止损止盈 / R / 护栏 / 结算…）——
 * 那是给老记录看的，新记录一律写 null；接口也不再返回它们。
 */
export interface AnalysisDetail extends AnalysisRow {
  ccxtSymbol: string | null
  /** 老记录才有（新记录把 reason 存在 gradeReason 列） */
  verdictReason: string | null
  chartTimeframe: string | null
  promptTokens: number | null
  completionTokens: number | null
  attempts: number | null
  /** AI 的四个字段：档位 / 标签 / 理由 / 结论 */
  result: JudgeResult
  /** 行情快照：当时各周期各拉了多少根（K 线本身不存） */
  snapshot: {
    price?: number
    primary?: string
    blocks?: {
      timeframe: string
      primary?: boolean
      days?: number
      bars?: number
    }[]
    heat?: Record<string, unknown>
  }
  meta: Record<string, unknown>
  /** 当时用的规则全文（从 rules_versions 带出来）
   *  ⚠️ 是**全量**（数据库正文 + 输出契约 `fullSystem()`），因为 hash 也是按全量算的 */
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
 *
 * ⚠️ `system` 要传**全量**（`fullSystem(rules.system)` = 数据库正文 + 输出契约）——
 * hash 是按全量算的，存半截就出现「同一个 hash 对应两份不同文本」，复盘就没意义了。
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

  // ⚠️ 账户 / 仓位 / 止损止盈 / 护栏 / 期望值 / 清单 这一整套已于 2026-10-02 删除。
  // 对应的列**还留在表里**（老记录要能读），新记录一律写 null / []。
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
       result, guardrails, expectancy, snapshot, meta, tags,
       user_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23, $24,
       $25, $26, $27, $28, $29, $30,
       $31, $32, $33, $34, $35, $36,
       $37, $38, $39, $40, $41, $42,
       $43, $44, $45, $46
     ) RETURNING id`,
    [
      input.symbol,
      input.ccxtSymbol,
      input.exchange,
      input.marketType,
      input.timeframes,
      null, // assumed_win_rate（期望值已删）
      null, // grade（不再判档）
      // grade_reason 列现在存的就是 AI 的那段 reason
      s(j.reason),
      s(j.verdict),
      null, // verdict_reason（已废弃）
      // 「把握 / 置信度」已废弃：模型自报的数字没有任何依据、也不参与计算，
      // 列留着读老记录，新记录一律写 null
      null,
      null, // direction（已废弃）
      input.snapshot.price ?? null,
      null, // entry_price
      null, // entry_type
      null, // stop_loss
      null, // stop_pct
      null, // tp1_price
      null, // tp2_price
      null, // tp3_price
      null, // rr_final
      null, // expectancy_r
      null, // position_qty
      null, // position_notional
      null, // risk_amount
      null, // leverage_used
      null, // guard_passed
      [], // veto
      [], // red_lines
      input.model,
      input.rulesHash,
      // 不再注入知识库经验，所以没有可引用的条目
      JSON.stringify([]),
      input.llmUsageId,
      input.usage.promptTokens,
      input.usage.completionTokens,
      input.costUsd,
      Math.round(input.latencyMs),
      input.attempts,
      input.chartTimeframe,
      JSON.stringify(j),
      null, // guardrails（已废弃）
      null, // expectancy（已废弃）
      JSON.stringify({
        price: input.snapshot.price,
        primary: input.snapshot.primary,
        blocks: input.snapshot.blocks.map(b => ({
          timeframe: b.timeframe,
          primary: b.primary,
          days: b.days,
          bars: b.bars
        })),
        heat: input.snapshot.heat
      }),
      JSON.stringify(input.meta),
      // tags（新列）—— 跟知识库共用同一份标签池
      JSON.stringify(j.tags ?? []),
      // user_id —— 预测历史按用户隔离
      input.userId
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
  grade, grade_reason, verdict, tags, price, model, rules_hash, cost_usd,
  latency_ms, created_at`

interface RawRow {
  id: string
  symbol: string
  exchange: string
  market_type: string
  timeframes: string[] | null
  grade: string | null
  grade_reason: string | null
  verdict: string | null
  tags: JudgeTagRow[] | null
  price: string | null
  model: string | null
  rules_hash: string | null
  cost_usd: string | null
  latency_ms: number | null
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
    tags: r.tags ?? [],
    price: n(r.price),
    model: r.model,
    rulesHash: r.rules_hash,
    costUsd: n(r.cost_usd),
    latencyMs: r.latency_ms,
    createdAt: r.created_at.toISOString()
  }
}

export interface ListAnalysesOptions {
  /** 只看谁的数据（用户隔离）；null = 没归属的记录 */
  userId: number | null
  /** 只看某个币种 */
  symbol?: string
  /** 只看某个档位（A / A-W / S / V / B / unclear）—— 老记录才有 */
  grade?: string
  /** 只看某个结论（go/wait/no_go） */
  verdict?: string
  /** 只看打了某个形状标签的（标签名要完全一致） */
  tag?: string
  /** 只看可做的 */
  actionableOnly?: boolean
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

  // 用户隔离 —— 永远是第一个条件
  add('user_id = ?', o.userId)
  if (o.symbol) add('symbol = ?', o.symbol.toUpperCase())
  if (o.grade) add('grade = ?', o.grade)
  if (o.verdict) add('verdict = ?', o.verdict)
  // 标签是 `[{name,probability}]`，JSONB 包含判断：只要数组里有一条对象的 name 相同就算命中。
  // 老记录里是纯字符串数组，命中不了 —— 这是故意的（那会儿的标签不是形状标签）
  if (o.tag) add('tags @> ?::jsonb', JSON.stringify([{name: o.tag}]))
  if (o.actionableOnly) parts.push(`verdict = 'go'`)

  return {where: parts.length ? 'WHERE ' + parts.join(' AND ') : '', params}
}

export async function listAnalyses(
  o: ListAnalysesOptions
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

export async function getAnalysis(
  id: number,
  userId: number | null
): Promise<AnalysisDetail | null> {
  const r = await queryOne<
    RawRow & {
      ccxt_symbol: string | null
      verdict_reason: string | null
      chart_timeframe: string | null
      prompt_tokens: number | null
      completion_tokens: number | null
      attempts: number | null
      result: JudgeResult | null
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
      WHERE a.id = $1 AND a.user_id = $2`,
    [id, userId]
  )
  if (!r) return null

  const base = mapRow(r)
  return {
    ...base,
    ccxtSymbol: r.ccxt_symbol,
    verdictReason: r.verdict_reason,
    chartTimeframe: r.chart_timeframe,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    attempts: r.attempts,
    result: r.result ?? ({} as JudgeResult),
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
/* 删除                                                                */
/* ------------------------------------------------------------------ */

export async function deleteAnalysis(
  id: number,
  userId: number | null
): Promise<boolean> {
  const rows = await query(
    'DELETE FROM analyses WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

/**
 * 存进 `analyses.tags` 的形状标签 + 概率。
 *
 * ⚠️ 2026-10-02 之前的记录存的是**纯字符串数组**，读回来当 `string` 用，
 * 展示前记得判一下 `typeof`（前端 `tagsOf()` 就是这么干的）。
 */
export interface JudgeTagRow {
  name: string
  probability: number
}
export interface TagStat {
  name: string
  calls: number
  /** 平均概率（0~100）；老记录没有概率就是 null */
  avgProbability: number | null
}

export interface AnalysisStats {
  total: number
  byTag: TagStat[]
  /** 按币种：做过多少次 */
  bySymbol: {symbol: string; calls: number}[]
  /** 按结论：go / wait / no_go（老记录没写结论的就是 unknown） */
  byVerdict: {verdict: string; calls: number}[]
  costUsd: number
}

/** 标签分布：每个形状标签出现了多少次、平均概率多少 */
export async function analysisStats(
  days = 365,
  userId: number | null
): Promise<AnalysisStats> {
  const d = Math.max(1, Math.min(3650, Math.round(days)))
  const since = `now() - interval '${d} days'`

  const [totals, byTag, bySymbol, byVerdict] = await Promise.all([
    query<{n: string; cost: string}>(
      `SELECT count(*)::text AS n,
              COALESCE(sum(cost_usd), 0)::text AS cost
         FROM analyses WHERE user_id = $1 AND created_at >= ${since}`,
      [userId]
    ),
    query<{name: string; calls: string; avg_p: string | null}>(
      // 只统计 `[{name,probability}]` 这种新结构；老记录的字符串标签直接排掉
      `SELECT t->>'name' AS name,
              count(*)::text AS calls,
              round(avg((t->>'probability')::numeric))::text AS avg_p
         FROM analyses a, jsonb_array_elements(a.tags) t
        WHERE a.user_id = $1
          AND a.created_at >= ${since}
          AND jsonb_typeof(t) = 'object'
          AND (t->>'name') IS NOT NULL
          AND (t->>'probability') IS NOT NULL
        GROUP BY 1
        ORDER BY count(*) DESC, 1
        LIMIT 20`,
      [userId]
    ),
    query<{symbol: string; calls: string}>(
      `SELECT symbol, count(*)::text AS calls
         FROM analyses
        WHERE user_id = $1 AND created_at >= ${since}
        GROUP BY 1
        ORDER BY count(*) DESC
        LIMIT 30`,
      [userId]
    ),
    query<{verdict: string; calls: string}>(
      `SELECT COALESCE(verdict, 'unknown') AS verdict,
              count(*)::text AS calls
         FROM analyses
        WHERE user_id = $1 AND created_at >= ${since}
        GROUP BY 1
        ORDER BY count(*) DESC`,
      [userId]
    )
  ])

  const t = totals[0]
  return {
    total: Number(t?.n ?? 0),
    costUsd: Number(t?.cost ?? 0),
    byTag: byTag.map(r => ({
      name: r.name,
      calls: Number(r.calls),
      avgProbability: r.avg_p === null ? null : Number(r.avg_p)
    })),
    bySymbol: bySymbol.map(r => ({
      symbol: r.symbol,
      calls: Number(r.calls)
    })),
    byVerdict: byVerdict.map(r => ({
      verdict: r.verdict,
      calls: Number(r.calls)
    }))
  }
}
