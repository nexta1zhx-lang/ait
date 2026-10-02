import {query, queryOne} from './client'
import {Candle} from '../types'

export type CaseLabel = 'do' | 'dont'
export type CaseGrade = 'A' | 'B' | 'C'

/**
 * 标签模板现在存数据库、由我自己在页面上维护 ——
 * 见 `db/tags.ts` 的 `listTagTemplates()` / `loadTagTemplates()`。
 * 代码里**没有任何写死的默认模板**（删空了就是空的）。
 */

/** 一条案例最多打几个标签 */
export const MAX_TAGS = 4

/**
 * 把 AI 给的标签过滤成「模板里确实有的」。
 *
 * AI 经常自己造词（缩量爬升 / 阶梯下行…），这里一律丢掉 ——
 * 宁可少一个标签，也不要标签池子越长越乱。
 * `allowed` 就是当前模板清单（自己维护的那份）。
 */
export function pickTemplates(
  tags: unknown,
  allowed: readonly string[],
  max = MAX_TAGS
): string[] {
  if (!Array.isArray(tags)) return []
  const ok = new Set(allowed)
  const out: string[] = []
  for (const raw of tags) {
    const t = String(raw ?? '').trim()
    if (!ok.has(t) || out.includes(t)) continue
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

/**
 * 这段行情到底是什么。
 *
 * 以前是让 AI 套用我自己的 A/B/C 档，现在**不再套任何体系** ——
 * AI 只客观说这是拉升 / 下跌 / 横盘，分不分级是我自己打标签的事。
 */
export type MoveType = 'up' | 'down' | 'range'

export interface CaseFeatures {
  structure?: string
  volume?: string
  rhythm?: string
  /** 下面三个是旧字段，只为了能打开老案例 */
  pre?: string
  rally?: string
  post?: string
  heat?: string
}

export interface CaseRallyMeta {
  changePct: number
  bars: number
  atrMultiple: number
  volMultiple: number | null
}

export interface KnowledgeRow {
  id: number
  symbol: string
  timeframe: string
  /** @deprecated 已不再分「该做 / 不该做」，新记录为 null */
  label: CaseLabel | null
  /** @deprecated 旧字段，新记录不再写 */
  grade: CaseGrade | null
  /** 拉升 / 下跌 / 横盘 */
  moveType: MoveType | null
  /** 我从卡片上打的标签（AI 会给建议） */
  tags: string[]
  title: string
  /** 为什么会这样走 */
  why: string
  note: string
  lesson: string
  features: CaseFeatures
  windowStart: string
  windowEnd: string
  rallyFrom: number | null
  rallyTo: number | null
  stats: CaseStats | null
  candles: Candle[]
  createdAt: string
}

/** 整段行情的客观统计（取代旧的 rallyMeta） */
export interface CaseStats {
  bars?: number
  changePct?: number
  rangePct?: number
  maxDrawdownPct?: number
  highAtPct?: number
  lowAtPct?: number
  volTrend?: number | null
  /** 旧字段，兼容老记录 */
  atrMultiple?: number
}

export interface KnowledgeBrief {
  id: number
  symbol: string
  timeframe: string
  /** @deprecated 已不再分「该做 / 不该做」，新记录为 null */
  label: CaseLabel | null
  /** @deprecated 旧字段，新记录不再写 */
  grade: CaseGrade | null
  moveType: MoveType | null
  tags: string[]
  title: string
  why: string
  note: string
  lesson: string
  windowStart: string
  windowEnd: string
  /** 拉升段在 candles 里的下标（列表接口会现算填上） */
  rallyFrom: number | null
  rallyTo: number | null
  /** 拉升段涨幅%（现算） */
  rallyPct?: number | null
  stats: CaseStats | null
  /** 只有 `withCandles: true` 时才有内容，否则是空数组 */
  candles: Candle[]
  createdAt: string
}

interface Raw {
  id: string
  symbol: string
  timeframe: string
  label: string | null
  grade: string | null
  move_type: string | null
  tags: string[] | null
  title: string
  why: string | null
  note: string
  lesson: string
  features: CaseFeatures | null
  window_start: Date
  window_end: Date
  rally_from: number | null
  rally_to: number | null
  rally_meta: CaseStats | null
  candles: number[][] | null
  created_at: Date
}

/** 存库时把 K 线压成 [[t,o,h,l,c,v], ...]，省一大半空间 */
export function packCandles(candles: Candle[]): number[][] {
  return candles.map(c => [
    c.timestamp,
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume
  ])
}

function unpackCandles(rows: number[][] | null): Candle[] {
  if (!Array.isArray(rows)) return []
  return rows.map(r => ({
    timestamp: r[0],
    open: r[1],
    high: r[2],
    low: r[3],
    close: r[4],
    volume: r[5]
  }))
}

const COLS = `id, symbol, timeframe, label, grade, move_type, tags, title, why,
  note, lesson, features, window_start, window_end, rally_from, rally_to,
  rally_meta, candles, created_at`

function map(r: Raw): KnowledgeRow {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    timeframe: r.timeframe,
    label: (r.label as CaseLabel) ?? null,
    grade: (r.grade as CaseGrade) ?? null,
    moveType: (r.move_type as MoveType) ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    title: r.title,
    why: r.why ?? '',
    note: r.note,
    lesson: r.lesson,
    features: r.features ?? {},
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    rallyFrom: r.rally_from,
    rallyTo: r.rally_to,
    stats: r.rally_meta,
    candles: unpackCandles(r.candles),
    createdAt: r.created_at.toISOString()
  }
}

export interface CreateCaseInput {
  symbol: string
  ccxtSymbol: string | null
  exchange: string
  timeframe: string
  /** 已经不填了，留空即可 */
  label?: CaseLabel | null
  moveType: MoveType
  tags: string[]
  title: string
  why: string
  note: string
  lesson: string
  features: CaseFeatures
  windowStart: number
  windowEnd: number
  candles: Candle[]
  stats: CaseStats
  snapshot: Record<string, unknown>
}

export async function createCase(input: CreateCaseInput): Promise<number> {
  const row = await queryOne<{id: string}>(
    `INSERT INTO knowledge (
       symbol, ccxt_symbol, exchange, timeframe, label, move_type, tags,
       title, why, note, lesson, features, window_start, window_end,
       candles, rally_meta, snapshot
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      input.symbol,
      input.ccxtSymbol,
      input.exchange,
      input.timeframe,
      input.label ?? null,
      input.moveType,
      JSON.stringify(input.tags),
      input.title,
      input.why,
      input.note,
      input.lesson,
      JSON.stringify(input.features),
      new Date(input.windowStart),
      new Date(input.windowEnd),
      JSON.stringify(packCandles(input.candles)),
      JSON.stringify(input.stats),
      JSON.stringify(input.snapshot)
    ]
  )
  return Number(row?.id)
}

export interface ListCasesOptions {
  label?: CaseLabel | 'all'
  /** 'none' = 还没判走势类型的 */
  moveType?: MoveType | 'all' | 'none'
  /** 只要带这个标签的 */
  tag?: string
  symbol?: string
  /** 关键词：在 lesson / why / title / note 里模糊匹配 */
  q?: string
  /** 带上 K 线（卡片要画迷你图时就开） */
  withCandles?: boolean
  limit?: number
}

/** 列表（默认不返回 K 线，省流量） */
export async function listCases(
  opts: ListCasesOptions = {}
): Promise<KnowledgeBrief[]> {
  const where: string[] = []
  const vals: unknown[] = []
  if (opts.label && opts.label !== 'all') {
    vals.push(opts.label)
    where.push(`label = $${vals.length}`)
  }
  if (opts.moveType && opts.moveType !== 'all') {
    if (opts.moveType === 'none') {
      where.push('move_type IS NULL')
    } else {
      vals.push(opts.moveType)
      where.push(`move_type = $${vals.length}`)
    }
  }
  const tag = (opts.tag ?? '').trim()
  if (tag) {
    vals.push(JSON.stringify([tag]))
    where.push(`tags @> $${vals.length}::jsonb`)
  }
  const symbol = (opts.symbol ?? '').trim().toUpperCase()
  if (symbol) {
    vals.push(symbol)
    where.push(`upper(symbol) = $${vals.length}`)
  }
  const q = (opts.q ?? '').trim()
  if (q) {
    vals.push(`%${q}%`)
    where.push(
      `(lesson ILIKE $${vals.length} OR why ILIKE $${vals.length} OR title ILIKE $${vals.length} OR note ILIKE $${vals.length} OR tags::text ILIKE $${vals.length})`
    )
  }
  vals.push(Math.min(500, Math.max(1, opts.limit ?? 200)))
  const cols = `id, symbol, timeframe, label, grade, move_type, tags, title, why,
                note, lesson, features, window_start, window_end,
                rally_from, rally_to, rally_meta,
                ${opts.withCandles ? 'candles' : `'[]'::jsonb AS candles`},
                created_at`
  const rows = await query<Raw>(
    `SELECT ${cols}
     FROM knowledge
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC
     LIMIT $${vals.length}`,
    vals
  )
  return rows.map(map)
}

/** 所有标签 + 各用了多少次（筛选栏的 chip 用） */
export async function listTags(): Promise<{tag: string; n: number}[]> {
  const rows = await query<{tag: string; n: string}>(
    `SELECT t.tag, count(*)::text AS n
       FROM knowledge k, jsonb_array_elements_text(k.tags) AS t(tag)
      WHERE jsonb_typeof(k.tags) = 'array'
      GROUP BY t.tag
      ORDER BY count(*) DESC, t.tag ASC
      LIMIT 100`
  )
  return rows.map(r => ({tag: r.tag, n: Number(r.n)}))
}

export interface UpdateCaseInput {
  title?: string
  note?: string
  lesson?: string
  why?: string
  label?: CaseLabel
  moveType?: MoveType | null
  tags?: string[]
  features?: CaseFeatures
}

/** 只改文案类的字段，K 线不动 */
export async function updateCase(
  id: number,
  patch: UpdateCaseInput
): Promise<boolean> {
  const sets: string[] = []
  const vals: unknown[] = []
  const put = (col: string, v: unknown) => {
    vals.push(v)
    sets.push(`${col} = $${vals.length}`)
  }
  if (patch.title !== undefined) put('title', patch.title)
  if (patch.why !== undefined) put('why', patch.why)
  if (patch.moveType !== undefined) put('move_type', patch.moveType)
  if (patch.tags !== undefined) put('tags', JSON.stringify(patch.tags))
  if (patch.note !== undefined) put('note', patch.note)
  if (patch.lesson !== undefined) put('lesson', patch.lesson)
  if (patch.label !== undefined) put('label', patch.label)
  if (patch.features !== undefined)
    put('features', JSON.stringify(patch.features))
  if (!sets.length) return false
  vals.push(id)
  const rows = await query<{id: string}>(
    `UPDATE knowledge SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`,
    vals
  )
  return rows.length > 0
}

export async function getCase(id: number): Promise<KnowledgeRow | null> {
  const row = await queryOne<Raw>(
    `SELECT ${COLS} FROM knowledge WHERE id = $1`,
    [id]
  )
  return row ? map(row) : null
}

export async function deleteCase(id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM knowledge WHERE id = $1 RETURNING id',
    [id]
  )
  return rows.length > 0
}

/* ------------------------------------------------------------------ *
 * 已删除：lessonsForPrompt()
 *
 * 它是「把案例的 lesson 拼成一张经验清单喂给开单分析」用的。
 * 2026-10-02 起开单分析**不再注入知识库经验**（只借一份标签池），
 * 这个函数就没人调了，整块删掉。
 * ------------------------------------------------------------------ */
