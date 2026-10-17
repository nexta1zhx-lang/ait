/**
 * **日记**（用户 2026-10-18）。
 *
 * 用户一路改下来的口径：
 *   1. 「日记模块可以加入某些币种，总结」→「是我手动写日记，不一定每天」；
 *   2. 「不要自动按月总结了，默认排版，不显示什么总结，就是每日感想，可以筛选」；
 *   3. 「**默认就是当前时刻不用写日期，有改动就更新时间**；每条日记显示到分钟级」。
 *
 * 所以现在：
 *   · **没有「写在哪一天」这个字段** —— 条目的时间就是它**最后被改动的那一刻**
 *     （`updated_at`），新建 = 现在，编辑 = 保存的那一刻；列表按它倒序、显示到分钟；
 *   · 每条可以**挂几个币**，每个币可以**定住一刻**（`at_ts`，可空），点这个币就跳到那一刻的 K 线；
 *   · 筛选只有「币种」和「关键词（标题 / 正文）」。
 *
 * 跟知识库（`knowledge`）不是一回事，别合并：
 *   · 知识库 = 「某一段行情 + AI 提炼的可复用经验」，按案例；
 *   · 日记 = 「我自己的话 + 那一刻碰了哪些币」，按时间。
 *
 * ⚠️ 时间一律按**北京时间**：库里存 `timestamptz`，进出都换成 `YYYY-MM-DD HH:mm` 这种
 *    北京时间的字面串（前端也是这个格式，来回不用再算时区）。
 */
import {query, queryOne} from './client'
import {normalizeBase} from './pins'

export const MAX_JOURNAL_COINS = 20
export const MAX_TITLE = 120
export const MAX_BODY = 20000

/** 列表默认一页多少条（「还有更多」再要下一页） */
export const JOURNAL_PAGE = 30

export interface JournalCoin {
  base: string
  /** 定住的那一刻（北京时间 `YYYY-MM-DD HH:mm`，空串 = 没定） */
  at: string
}

export interface JournalEntry {
  id: number
  /** 这条**最后一次改动**的时刻（北京时间 `YYYY-MM-DD HH:mm`）—— 列表就显示它 */
  at: string
  title: string
  body: string
  coins: JournalCoin[]
  createdAt: string
  updatedAt: string
}

export interface JournalList {
  entries: JournalEntry[]
  /** 命中总数（跟当前页无关，用来判断还有没有下一页） */
  total: number
  /** 写进过日记的全部币（筛选下拉用，去重、按字母排） */
  coins: string[]
}

interface EntryRow {
  id: string | number
  at: string
  title: string | null
  body: string | null
  created_at: Date | string
  updated_at: Date | string
  coins: unknown
  total?: string | number
}

function iso(v: Date | string | null | undefined): string {
  if (!v) return ''
  return v instanceof Date ? v.toISOString() : String(v)
}

/** `YYYY-MM-DD HH:mm`（北京时间）→ `timestamptz` 用的字面串；不合法就是空串 */
function bjLiteral(v: unknown): string {
  const t = String(v ?? '').trim().replace('T', ' ')
  const m = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return ''
  const [, y, mo, d, h, mi] = m
  const hh = Number(h)
  const mm = Number(mi)
  if (hh > 23 || mm > 59) return ''
  return `${y}-${mo}-${d} ${String(hh).padStart(2, '0')}:${mi}`
}

function coinsOf(v: unknown): JournalCoin[] {
  if (!Array.isArray(v)) return []
  const out: JournalCoin[] = []
  for (const raw of v) {
    const o = raw as {base?: unknown; at?: unknown}
    const base = String(o?.base ?? '').toUpperCase()
    if (!/^[A-Z0-9]{1,20}$/.test(base)) continue
    out.push({base, at: String(o?.at ?? '').slice(0, 16)})
  }
  return out
}

function mapEntry(r: EntryRow): JournalEntry {
  return {
    id: Number(r.id),
    at: String(r.at ?? '').slice(0, 16),
    title: r.title ?? '',
    body: r.body ?? '',
    coins: coinsOf(r.coins),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  }
}

/** 单篇的取数片段（`coins` 聚合成 JSON，时间统一换成北京时间字面串） */
const ENTRY_COLUMNS = `
  e.id,
  to_char(e.updated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') AS at,
  e.title, e.body, e.created_at, e.updated_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'base', c.base,
                     'at', COALESCE(to_char(c.at_ts AT TIME ZONE 'Asia/Shanghai',
                                            'YYYY-MM-DD HH24:MI'), ''))
                   ORDER BY c.sort, c.base)
              FROM journal_coins c WHERE c.entry_id = e.id), '[]'::jsonb) AS coins`

/**
 * 列表：**按「最后改动时间」倒序**（用户：「有改动就更新时间」）。
 *
 * `coin` / `q` 都可空；两个一起给就是「同时满足」。
 * ⚠️ `q` 用 `$3 = ''` 短路，不能靠 `ILIKE '%'`：`title` 是可空列，
 *    空关键词时 `NULL ILIKE '%'` 还是 NULL，没写标题的条目会被漏掉。
 */
export async function listJournalEntries(
  userId: number,
  opts: {coin?: string; q?: string; limit?: number; offset?: number} = {}
): Promise<JournalList> {
  const coin = opts.coin ? normalizeBase(opts.coin) : ''
  const q = String(opts.q ?? '').trim().slice(0, 80)
  const like = q ? `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%` : ''
  const limit = Math.min(Math.max(Number(opts.limit) || JOURNAL_PAGE, 1), 200)
  const offset = Math.max(Number(opts.offset) || 0, 0)

  const rows = await query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}, count(*) OVER () AS total
       FROM journal_entries e
      WHERE e.user_id = $1
        AND ($2::text = '' OR EXISTS (
              SELECT 1 FROM journal_coins c WHERE c.entry_id = e.id AND c.base = $2))
        AND ($3::text = '' OR e.title ILIKE $3 ESCAPE '\\' OR e.body ILIKE $3 ESCAPE '\\')
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT $4 OFFSET $5`,
    [userId, coin, like, limit, offset]
  )

  const coinRows = await query<{base: string}>(
    `SELECT DISTINCT c.base
       FROM journal_coins c
       JOIN journal_entries e ON e.id = c.entry_id
      WHERE e.user_id = $1
      ORDER BY c.base`,
    [userId]
  )

  return {
    entries: rows.map(mapEntry),
    total: rows.length ? Number(rows[0]!.total) || rows.length : 0,
    coins: coinRows.map(r => r.base)
  }
}

/**
 * 新建 / 更新一条。
 *
 * ⚠️ **不收日期**（用户：「默认就是当前时刻不用写日期」）：
 *    新建 -> `updated_at` = now()；改任何内容 -> `updated_at` = now()。
 *    `day` 只是老字段，插入时写北京时间的今天，读的时候没人用它。
 */
export async function saveJournalEntry(
  userId: number,
  input: {id?: number | null; title?: string; body?: string; coins?: unknown}
): Promise<JournalEntry> {
  const title = String(input.title ?? '').slice(0, MAX_TITLE)
  const body = String(input.body ?? '').slice(0, MAX_BODY)

  const coins: JournalCoin[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(input.coins) ? input.coins : []) {
    const o = raw as {base?: unknown; at?: unknown}
    let base: string
    try {
      base = normalizeBase(o?.base)
    } catch {
      continue // 写法不对的直接跳过（前端是列表选的，理论上不会有）
    }
    if (seen.has(base)) continue
    seen.add(base)
    coins.push({base, at: bjLiteral(o?.at)})
    if (coins.length >= MAX_JOURNAL_COINS) break
  }

  let id = Number(input.id ?? 0) || 0
  if (id > 0) {
    const row = await queryOne<{id: string}>(
      `UPDATE journal_entries
          SET title = $3, body = $4, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, userId, title, body]
    )
    if (!row) throw new Error('这条日记不存在（或者不是你的）')
  } else {
    const row = await queryOne<{id: string}>(
      `INSERT INTO journal_entries (user_id, day, title, body)
       VALUES ($1, (now() AT TIME ZONE 'Asia/Shanghai')::date, $2, $3)
       RETURNING id`,
      [userId, title, body]
    )
    if (!row) throw new Error('日记没写进去')
    id = Number(row.id)
  }

  /* 币整份换掉（一条最多 20 个，重写比 diff 简单也不慢） */
  await query('DELETE FROM journal_coins WHERE entry_id = $1', [id])
  for (let i = 0; i < coins.length; i++) {
    const c = coins[i]!
    await query(
      `INSERT INTO journal_coins (entry_id, base, at_ts, sort)
       VALUES ($1, $2, CASE WHEN $3 = '' THEN NULL ELSE ($3 || '+08:00')::timestamptz END, $4)`,
      [id, c.base, c.at, i]
    )
  }

  const saved = await queryOne<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM journal_entries e WHERE e.id = $1`,
    [id]
  )
  if (!saved) throw new Error('保存后读不回来')
  return mapEntry(saved)
}

export async function deleteJournalEntry(userId: number, id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM journal_entries WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}
