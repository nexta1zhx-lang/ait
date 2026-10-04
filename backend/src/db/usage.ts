import {query} from './client'
import {TokenUsage, costOf, emptyUsage} from '../llm/pricing'

export type UsageKind = 'judge' | 'extract'

export const KIND_LABEL: Record<string, string> = {
  judge: '开单分析',
  extract: '案例提炼'
}

export interface RecordUsageInput {
  /** 这笔花费算谁的（用户系统）；null = 没归属 */
  userId: number | null
  /** 用的是**哪把密钥**（多密钥，2026-10-04）—— 统计要按它分开看 */
  llmKeyId?: number | null
  kind: UsageKind
  model: string
  symbol?: string | null
  timeframe?: string | null
  usage?: TokenUsage | null
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
  const cost = costOf(input.model, usage, at)

  try {
    const rows = await query<{id: string; cost_usd: string}>(
      `INSERT INTO llm_usage (kind, model, symbol, timeframe,
         prompt_tokens, completion_tokens, total_tokens,
         cache_hit_tokens, cache_miss_tokens,
         cost_usd, peak, price, assumed, attempts, latency_ms,
         ok, error, created_at, user_id, llm_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
        at,
        input.userId,
        input.llmKeyId ?? null
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
  attempts: number
  latencyMs: number | null
  createdAt: string
  /** 用的哪把密钥（名字；没绑定 / 已删就是 null） */
  keyName: string | null
}

export interface UsageTotals {
  calls: number
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
  /** 按**密钥**分开的统计（多密钥，2026-10-04）—— `key` 就是 llm_key_id */
  byKey: UsageBucket[]
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
  attempts: number
  latency_ms: number | null
  created_at: Date
  key_name?: string | null
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
    attempts: Number(r.attempts),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    createdAt: r.created_at.toISOString(),
    keyName: r.key_name ?? null
  }
}

interface RawBucket {
  key: string
  calls: string
  prompt_tokens: string
  completion_tokens: string
  total_tokens: string
  cache_hit_tokens: string
  cost_usd: string
}

const BUCKET_SQL = (groupExpr: string, where: string) => `
  SELECT ${groupExpr} AS key,
         count(*)::text                            AS calls,
         COALESCE(sum(u.prompt_tokens), 0)::text     AS prompt_tokens,
         COALESCE(sum(u.completion_tokens), 0)::text AS completion_tokens,
         COALESCE(sum(u.total_tokens), 0)::text      AS total_tokens,
         COALESCE(sum(u.cache_hit_tokens), 0)::text  AS cache_hit_tokens,
         COALESCE(sum(u.cost_usd), 0)::text          AS cost_usd
    FROM llm_usage u
    LEFT JOIN user_llm_keys k ON k.id = u.llm_key_id
   WHERE ${where}
   GROUP BY key`

function mapBucket(r: RawBucket, label?: (k: string) => string): UsageBucket {
  return {
    key: r.key,
    label: label ? label(r.key) : r.key,
    calls: Number(r.calls),
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
function whereSql(days: number, kind: UsageKind | null, hasKey: boolean) {
  // $1 = user_id（调用方传入）；$2 = llm_key_id（只按密钥筛时才有）
  const parts = [
    `u.user_id = $1`,
    `u.created_at >= now() - interval '${days} days'`
  ]
  if (kind) parts.push(`u.kind = '${kind}'`)
  if (hasKey) parts.push(`u.llm_key_id = $2`)
  return parts.join(' AND ')
}

const ROW_COLS = `u.id, u.kind, u.model, u.symbol, u.timeframe, u.prompt_tokens,
  u.completion_tokens, u.total_tokens, u.cache_hit_tokens,
  u.cost_usd, u.attempts, u.latency_ms, u.created_at,
  k.name AS key_name`

/** 汇总最近 N 天的用量 */
export async function usageSummary(opts: {
  /** 只看谁的用量（用户隔离）；null = 没归属 */
  userId: number | null
  days?: number
  recent?: number
  /** 只看某类调用 */
  kind?: UsageKind | string | null
  /** 只看某把密钥（llm_key_id）；不传 = 全部 */
  keyId?: number | null
}): Promise<UsageSummary> {
  const days = daysOf(opts.days)
  const recent = Math.max(0, Math.min(500, Math.round(opts.recent ?? 10)))
  const kind = kindOf(opts.kind)
  const keyId = Number(opts.keyId) > 0 ? Number(opts.keyId) : null
  const where = whereSql(days, kind, keyId !== null)
  const params = keyId === null ? [opts.userId] : [opts.userId, keyId]

  const totalsRow = await query<RawBucket>(
    `SELECT 'all' AS key,
            count(*)::text                            AS calls,
            COALESCE(sum(u.prompt_tokens), 0)::text     AS prompt_tokens,
            COALESCE(sum(u.completion_tokens), 0)::text AS completion_tokens,
            COALESCE(sum(u.total_tokens), 0)::text      AS total_tokens,
            COALESCE(sum(u.cache_hit_tokens), 0)::text  AS cache_hit_tokens,
            COALESCE(sum(u.cost_usd), 0)::text          AS cost_usd
       FROM llm_usage u
      WHERE ${where}`,
    params
  )

  const [byDay, byKind, byModel, byKey] = await Promise.all([
    query<RawBucket>(
      BUCKET_SQL(
        `to_char(u.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`,
        where
      ) + ' ORDER BY key DESC LIMIT 400',
      params
    ),
    query<RawBucket>(BUCKET_SQL('u.kind', where) + ' ORDER BY key', params),
    query<RawBucket>(BUCKET_SQL('u.model', where) + ' ORDER BY key', params),
    // 按密钥分开：`key` 就是 llm_key_id 的文本（0 = 没绑定）
    query<RawBucket>(
      BUCKET_SQL(`COALESCE(k.id::text, '0')`, where) +
        ' ORDER BY sum(u.cost_usd) DESC, key',
      params
    )
  ])

  // 密钥名字（byKey 的 label 用）
  const keyNames = new Map<string, string>()
  if (opts.userId !== null) {
    const ks = await query<{id: string; name: string}>(
      'SELECT id, name FROM user_llm_keys WHERE user_id = $1',
      [opts.userId]
    ).catch(() => [] as {id: string; name: string}[])
    for (const k of ks) keyNames.set(k.id, k.name)
  }

  const recentRows = recent
    ? await query<RawRow>(
        `SELECT ${ROW_COLS}
           FROM llm_usage u
           LEFT JOIN user_llm_keys k ON k.id = u.llm_key_id
          WHERE ${where}
          ORDER BY u.created_at DESC
          LIMIT ${recent}`,
        params
      )
    : []

  const t = totalsRow[0]
  return {
    days,
    since: new Date(Date.now() - days * 86_400_000).toISOString(),
    totals: t
      ? {
          calls: Number(t.calls),
          promptTokens: Number(t.prompt_tokens),
          completionTokens: Number(t.completion_tokens),
          totalTokens: Number(t.total_tokens),
          cacheHitTokens: Number(t.cache_hit_tokens),
          costUsd: Number(t.cost_usd)
        }
      : {
          calls: 0,
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
    byKey: byKey.map(r =>
      mapBucket(r, k =>
        k === '0' ? '（未绑定密钥）' : keyNames.get(k) || `已删除的密钥 #${k}`
      )
    ),
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
export async function usageCalls(opts: {
  /** 只看谁的用量（用户隔离）；null = 没归属 */
  userId: number | null
  days?: number
  kind?: UsageKind | string | null
  /** 只看某把密钥；不传 = 全部 */
  keyId?: number | null
  limit?: number
  offset?: number
}): Promise<UsagePage> {
  const days = daysOf(opts.days)
  const kind = kindOf(opts.kind)
  const keyId = Number(opts.keyId) > 0 ? Number(opts.keyId) : null
  const where = whereSql(days, kind, keyId !== null)
  const params = keyId === null ? [opts.userId] : [opts.userId, keyId]
  const limit = Math.max(1, Math.min(500, Math.round(opts.limit ?? 50)))
  const offset = Math.max(0, Math.round(opts.offset ?? 0))

  const [rows, totalRows] = await Promise.all([
    query<RawRow>(
      `SELECT ${ROW_COLS}
         FROM llm_usage u
         LEFT JOIN user_llm_keys k ON k.id = u.llm_key_id
        WHERE ${where}
        ORDER BY u.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    query<{n: string}>(
      `SELECT count(*)::text AS n FROM llm_usage u WHERE ${where}`,
      params
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
export async function usageHeadline(userId: number | null): Promise<{
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
         WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
       )::text AS today_calls,
       COALESCE(sum(cost_usd) FILTER (
         WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
       ), 0)::text AS today_cost,
       count(*)::text AS all_calls,
       COALESCE(sum(cost_usd), 0)::text AS all_cost
     FROM llm_usage
    WHERE user_id = $1`,
    [userId]
  ).catch(() => [])
  const r = rows[0]
  return {
    todayCalls: Number(r?.today_calls ?? 0),
    todayCostUsd: Number(r?.today_cost ?? 0),
    allCalls: Number(r?.all_calls ?? 0),
    allCostUsd: Number(r?.all_cost ?? 0)
  }
}

/** 每把密钥的总用量（「模型配置」页每行显示） */
export async function usageByKey(
  userId: number
): Promise<{keyId: number; calls: number; costUsd: number}[]> {
  const rows = await query<{
    llm_key_id: string
    calls: string
    cost: string
  }>(
    `SELECT llm_key_id,
            count(*)::text AS calls,
            COALESCE(sum(cost_usd), 0)::text AS cost
       FROM llm_usage
      WHERE user_id = $1 AND llm_key_id IS NOT NULL
      GROUP BY llm_key_id`,
    [userId]
  )
  return rows.map(r => ({
    keyId: Number(r.llm_key_id),
    calls: Number(r.calls),
    costUsd: Number(r.cost)
  }))
}

/** 清空用量记录 */
export async function clearUsage(): Promise<void> {
  await query('TRUNCATE llm_usage RESTART IDENTITY')
}
