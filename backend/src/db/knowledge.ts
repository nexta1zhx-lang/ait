import {query, queryOne} from './client'
import {Candle} from '../types'

export type CaseLabel = 'do' | 'dont'
export type CaseGrade = 'A' | 'B' | 'C'

export interface CaseFeatures {
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
  label: CaseLabel
  grade: CaseGrade | null
  title: string
  note: string
  lesson: string
  features: CaseFeatures
  windowStart: string
  windowEnd: string
  rallyFrom: number | null
  rallyTo: number | null
  rallyMeta: CaseRallyMeta | null
  candles: Candle[]
  createdAt: string
}

export interface KnowledgeBrief {
  id: number
  symbol: string
  timeframe: string
  label: CaseLabel
  grade: CaseGrade | null
  title: string
  note: string
  lesson: string
  createdAt: string
}

interface Raw {
  id: string
  symbol: string
  timeframe: string
  label: string
  grade: string | null
  title: string
  note: string
  lesson: string
  features: CaseFeatures | null
  window_start: Date
  window_end: Date
  rally_from: number | null
  rally_to: number | null
  rally_meta: CaseRallyMeta | null
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

const COLS = `id, symbol, timeframe, label, grade, title, note, lesson,
  features, window_start, window_end, rally_from, rally_to, rally_meta,
  candles, created_at`

function map(r: Raw): KnowledgeRow {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    timeframe: r.timeframe,
    label: r.label as CaseLabel,
    grade: (r.grade as CaseGrade) ?? null,
    title: r.title,
    note: r.note,
    lesson: r.lesson,
    features: r.features ?? {},
    windowStart: r.window_start.toISOString(),
    windowEnd: r.window_end.toISOString(),
    rallyFrom: r.rally_from,
    rallyTo: r.rally_to,
    rallyMeta: r.rally_meta,
    candles: unpackCandles(r.candles),
    createdAt: r.created_at.toISOString()
  }
}

export interface CreateCaseInput {
  symbol: string
  ccxtSymbol: string | null
  exchange: string
  timeframe: string
  label: CaseLabel
  grade: CaseGrade | null
  title: string
  note: string
  lesson: string
  features: CaseFeatures
  windowStart: number
  windowEnd: number
  rallyFrom: number
  rallyTo: number
  candles: Candle[]
  rallyMeta: CaseRallyMeta
  snapshot: Record<string, unknown>
}

export async function createCase(input: CreateCaseInput): Promise<number> {
  const row = await queryOne<{id: string}>(
    `INSERT INTO knowledge (
       symbol, ccxt_symbol, exchange, timeframe, label, grade, title, note,
       lesson, features, window_start, window_end, rally_from, rally_to,
       candles, rally_meta, snapshot
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      input.symbol,
      input.ccxtSymbol,
      input.exchange,
      input.timeframe,
      input.label,
      input.grade,
      input.title,
      input.note,
      input.lesson,
      JSON.stringify(input.features),
      new Date(input.windowStart),
      new Date(input.windowEnd),
      input.rallyFrom,
      input.rallyTo,
      JSON.stringify(packCandles(input.candles)),
      JSON.stringify(input.rallyMeta),
      JSON.stringify(input.snapshot)
    ]
  )
  return Number(row?.id)
}

/** 列表（不返回 K 线，省流量） */
export async function listCases(
  opts: {
    label?: CaseLabel | 'all'
    limit?: number
  } = {}
): Promise<KnowledgeBrief[]> {
  const where: string[] = []
  const vals: unknown[] = []
  if (opts.label && opts.label !== 'all') {
    vals.push(opts.label)
    where.push(`label = $${vals.length}`)
  }
  vals.push(Math.min(500, Math.max(1, opts.limit ?? 200)))
  const rows = await query<Raw>(
    `SELECT id, symbol, timeframe, label, grade, title, note, lesson,
            features, window_start, window_end, rally_from, rally_to,
            rally_meta, '[]'::jsonb AS candles, created_at
     FROM knowledge
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC
     LIMIT $${vals.length}`,
    vals
  )
  return rows.map(r => {
    const k = map(r)
    return {
      id: k.id,
      symbol: k.symbol,
      timeframe: k.timeframe,
      label: k.label,
      grade: k.grade,
      title: k.title,
      note: k.note,
      lesson: k.lesson,
      createdAt: k.createdAt
    }
  })
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


/**
 * 给分析用的「经验条目」——只取 lesson 字段，很轻。
 * 按档位归类，让 AI 看到「我该做的」和「我踩过的坑」各是什么样。
 */
export async function lessonsByGrade(limitPerGrade = 60): Promise<string> {
  const rows = await query<{
    symbol: string
    timeframe: string
    label: string
    grade: string | null
    lesson: string
    note: string
  }>(
    `SELECT symbol, timeframe, label, grade, lesson, note
     FROM knowledge
     WHERE lesson <> '' OR note <> ''
     ORDER BY created_at DESC
     LIMIT $1`,
    [limitPerGrade * 4]
  )

  const doList: string[] = []
  const dontList: string[] = []
  for (const r of rows) {
    const text = r.lesson || r.note
    const tag = `[${r.symbol} ${r.timeframe}${r.grade ? ' ' + r.grade + '档' : ''}]`
    if (r.label === 'do') {
      if (doList.length < limitPerGrade) doList.push(`- ${tag} ${text}`)
    } else if (dontList.length < limitPerGrade) {
      dontList.push(`- ${tag} ${text}`)
    }
  }
  if (doList.length === 0 && dontList.length === 0) return ''

  const parts: string[] = []
  if (doList.length)
    parts.push(`### 我做对的（照这样找）\n${doList.join('\n')}`)
  if (dontList.length)
    parts.push(`### 我踩过的坑（出现类似特征就拒绝）\n${dontList.join('\n')}`)
  return parts.join('\n\n')
}
