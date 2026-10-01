import {query} from './client'
import {TokenUsage, costOf, emptyUsage} from '../llm/pricing'

export type UsageKind = 'judge' | 'extract'

export const KIND_LABEL: Record<string, string> = {
  judge: '开单分析',
  extract: '案例提炼'
}

export interface RecordUsageInput {
  kind: UsageKind
  model: string
  symbol?: string | null
  timeframe?: string | null
  usage?: TokenUsage | null
  mock?: boolean
  attempts?: number
  latencyMs?: number | null
  ok?: boolean
  error?: string | null
  /** 调用发生的时刻（决定高峰/低谷计价） */
  at?: Date
}

export interface RecordedUsage {
  id: number
  costUsd: number
  usage: TokenUsage
}

/**
 * 记一笔调用。
 * 这是「统计用」的旁路：**绝不因为它失败而影响主流程**。
 */
export async function recordUsage(
  input: RecordUsageInput
): Promise<RecordedUsage | null> {
  const at = input.at ?? new Date()
  const usage = input.usage ?? emptyUsage()
  const mock = Boolean(input.mock)
  const cost = mock
    ? {
        costUsd: 0,
        peak: false,
        assumed: false,
        price: {inputHit: 0, inputMiss: 0, output: 0}
      }
    : costOf(input.model, usage, at)

  try {
    const rows = await query<{id: string; cost_usd: string}>(
      `INSERT INTO llm_usage (kind, model, symbol, timeframe,
         prompt_tokens, completion_tokens, total_tokens,
         cache_hit_tokens, cache_miss_tokens,
         cost_usd, peak, price, assumed, attempts, latency_ms,
         ok, error, mock, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id, cost_usd`,
      [
        input.kind,
        input.model,
        input.symbol ?? null,
        input.timeframe ?? null,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        usage.cacheHitTokens,
        usage.cacheMissTokens,
        cost.costUsd,
        cost.peak,
        JSON.stringify(cost.price),
        cost.assumed,
        input.attempts ?? 1,
        input.latencyMs == null ? null : Math.round(input.latencyMs),
        input.ok ?? true,
        input.error ?? null,
        mock,
        at
      ]
    )
    const row = rows[0]
    if (!row) return null
    return {id: Number(row.id), costUsd: Number(row.cost_usd), usage}
  } catch (e) {
    console.warn('[usage] 记录失败（不影响分析）:', (e as Error).message)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export interface UsageRow {
  id: number
  kind: string
  model: string
  symbol: string | null
  timeframe: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  costUsd: number
  mock: boolean
  attempts: number
  latencyMs: number | null
  createdAt: string
}

export interface UsageTotals {
  calls: number
  mockCalls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  costUsd: number
}

export interface UsageBucket extends UsageTotals {
  key: string
  label: string
}

export interface UsageSummary {
  days: number
  since: string
  totals: UsageTotals
  byDay: UsageBucket[]
  byKind: UsageBucket[]
  byModel: UsageBucket[]
  recent: UsageRow[]
}

interface RawRow {
  id: string
  kind: string
  model: string
  symbol: string | null
  timeframe: string | null
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens: number
  cost_usd: string
  mock: boolean
  attempts: number
  latency_ms: number | null
  created_at: Date
}

function mapRow(r: RawRow): UsageRow {
  return {
    id: Number(r.id),
    kind: r.kind,
    model: r.model,
    symbol: r.symbol,
    timeframe: r.timeframe,
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
    cacheHitTokens: Number(r.cache_hit_tokens),
    costUsd: Number(r.cost_usd),
    mock: r.mock,
    attempts: Number(r.attempts),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    createdAt: r.created_at.toISOString()
  }
}

interface RawBucket {
  key: string
  calls: string
  mock_calls: string
  prompt_tokens: string
  completion_tokens: string
  total_tokens: string
  cache_hit_tokens: string
  cost_usd: string
}

const BUCKET_SQL = (groupExpr: string, where: string) => `
  SELECT ${groupExpr} AS key,
         count(*)::text                            AS calls,
         count(*) FILTER (WHERE mock)::text         AS mock_calls,
         COALESCE(sum(prompt_tokens), 0)::text     AS prompt_tokens,
         COALESCE(sum(completion_tokens), 0)::text AS completion_tokens,
         COALESCE(sum(total_tokens), 0)::text      AS total_tokens,
         COALESCE(sum(cache_hit_tokens), 0)::text  AS cache_hit_tokens,
         COALESCE(sum(cost_usd), 0)::text          AS cost_usd
    FROM llm_usage
   WHERE ${where}
   GROUP BY key`

function mapBucket(r: RawBucket, label?: (k: string) => string): UsageBucket {
  return {
    key: r.key,
    label: label ? label(r.key) : r.key,
    calls: Number(r.calls),
    mockCalls: Number(r.mock_calls),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
    cacheHitTokens: Number(r.cache_hit_tokens),
    costUsd: Number(r.cost_usd)
  }
}

/** 允许筛选的用途；白名单，直接拼进 SQL 也安全 */
const USAGE_KINDS: UsageKind[] = ['judge', 'extract']

function kindOf(v: unknown): UsageKind | null {
  const s = String(v ?? '').trim()
  return (USAGE_KINDS as string[]).includes(s) ? (s as UsageKind) : null
}

function daysOf(v: unknown, fallback = 30): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(3650, Math.round(n)))
}

/** 拼 WHERE（全部走白名单 / 数字，无注入面） */
function whereSql(days: number, kind: UsageKind | null, realOnly: boolean) {
  const parts = [`created_at >= now() - interval '${days} days'`]
  if (realOnly) parts.push('NOT mock')
  if (kind) parts.push(`kind = '${kind}'`)
  return parts.join(' AND ')
}

const ROW_COLS = `id, kind, model, symbol, timeframe, prompt_tokens,
  completion_tokens, total_tokens, cache_hit_tokens,
  cost_usd, mock, attempts, latency_ms, created_at`

/** 汇总最近 N 天的用量 */
export async function usageSummary(
  opts: {
    days?: number
    recent?: number
    /** 只看某类调用 */
    kind?: UsageKind | string | null
    /** 只看非模拟调用 */
    realOnly?: boolean
  } = {}
): Promise<UsageSummary> {
  const days = daysOf(opts.days)
  const recent = Math.max(0, Math.min(500, Math.round(opts.recent ?? 10)))
  const kind = kindOf(opts.kind)
  const where = whereSql(days, kind, Boolean(opts.realOnly))

  const totalsRow = await query<RawBucket>(
    `SELECT 'all' AS key,
            count(*)::text                            AS calls,
            count(*) FILTER (WHERE mock)::text         AS mock_calls,
            COALESCE(sum(prompt_tokens), 0)::text     AS prompt_tokens,
            COALESCE(sum(completion_tokens), 0)::text AS completion_tokens,
            COALESCE(sum(total_tokens), 0)::text      AS total_tokens,
            COALESCE(sum(cache_hit_tokens), 0)::text  AS cache_hit_tokens,
            COALESCE(sum(cost_usd), 0)::text          AS cost_usd
       FROM llm_usage
      WHERE ${where}`
  )

  const [byDay, byKind, byModel] = await Promise.all([
    query<RawBucket>(
      BUCKET_SQL(
        `to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`,
        where
      ) + ' ORDER BY key DESC LIMIT 400'
    ),
    query<RawBucket>(BUCKET_SQL('kind', where) + ' ORDER BY key'),
    query<RawBucket>(BUCKET_SQL('model', where) + ' ORDER BY key')
  ])

  const recentRows = recent
    ? await query<RawRow>(
        `SELECT ${ROW_COLS} FROM llm_usage
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT ${recent}`
      )
    : []

  const t = totalsRow[0]
  return {
    days,
    since: new Date(Date.now() - days * 86_400_000).toISOString(),
    totals: t
      ? {
          calls: Number(t.calls),
          mockCalls: Number(t.mock_calls),
          promptTokens: Number(t.prompt_tokens),
          completionTokens: Number(t.completion_tokens),
          totalTokens: Number(t.total_tokens),
          cacheHitTokens: Number(t.cache_hit_tokens),
          costUsd: Number(t.cost_usd)
        }
      : {
          calls: 0,
          mockCalls: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cacheHitTokens: 0,
          costUsd: 0
        },
    byDay: byDay
      .map(r => mapBucket(r))
      .sort((a, b) => b.key.localeCompare(a.key)),
    byKind: byKind.map(r => mapBucket(r, k => KIND_LABEL[k] ?? k)),
    byModel: byModel.map(r => mapBucket(r)),
    recent: recentRows.map(mapRow)
  }
}

export interface UsagePage {
  rows: UsageRow[]
  total: number
  limit: number
  offset: number
}

/** 明细列表（分页） */
export async function usageCalls(
  opts: {
    days?: number
    kind?: UsageKind | string | null
    realOnly?: boolean
    limit?: number
    offset?: number
  } = {}
): Promise<UsagePage> {
  const days = daysOf(opts.days)
  const kind = kindOf(opts.kind)
  const where = whereSql(days, kind, Boolean(opts.realOnly))
  const limit = Math.max(1, Math.min(500, Math.round(opts.limit ?? 50)))
  const offset = Math.max(0, Math.round(opts.offset ?? 0))

  const [rows, totalRows] = await Promise.all([
    query<RawRow>(
      `SELECT ${ROW_COLS} FROM llm_usage
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}`
    ),
    query<{n: string}>(
      `SELECT count(*)::text AS n FROM llm_usage WHERE ${where}`
    )
  ])

  return {
    rows: rows.map(mapRow),
    total: Number(totalRows[0]?.n ?? 0),
    limit,
    offset
  }
}

/** 今日 + 全部（顶部徽标用，两条轻查询） */
export async function usageHeadline(): Promise<{
  todayCalls: number
  todayCostUsd: number
  allCalls: number
  allCostUsd: number
}> {
  const rows = await query<{
    today_calls: string
    today_cost: string
    all_calls: string
    all_cost: string
  }>(
    `SELECT
       count(*) FILTER (
         WHERE NOT mock
           AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
       )::text AS today_calls,
       COALESCE(sum(cost_usd) FILTER (
         WHERE NOT mock
           AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
       ), 0)::text AS today_cost,
       count(*) FILTER (WHERE NOT mock)::text AS all_calls,
       COALESCE(sum(cost_usd) FILTER (WHERE NOT mock), 0)::text AS all_cost
     FROM llm_usage`
  ).catch(() => [])
  const r = rows[0]
  return {
    todayCalls: Number(r?.today_calls ?? 0),
    todayCostUsd: Number(r?.today_cost ?? 0),
    allCalls: Number(r?.all_calls ?? 0),
    allCostUsd: Number(r?.all_cost ?? 0)
  }
}

/** 清空用量记录 */
export async function clearUsage(): Promise<void> {
  await query('TRUNCATE llm_usage RESTART IDENTITY')
}
