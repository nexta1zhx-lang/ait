/**
 * **日记**（用户 2026-10-18：「想再加一个模块。日记模块可以加入某些币种，总结」）。
 *
 * 口径（跟用户对过的）：
 *   · **每日感想 / 想到就写**：条目式，不是「一天一格」—— 一周写一条也行，一天写三条也行；
 *   · 每条可以**挂几个币**，每个币后面跟一句自己的话（「DOGE 追高被套」）；
 *   · ★ 2026-10-18 用户改口：「**不要**自动按月总结了，默认排版，不显示什么总结，
 *     就是每日感想，可以筛选」→ 月度统计 / 月度总结 / 缺口提示**全删了**，
 *     这一页只剩「倒序的条目列表 + 筛选（币种 / 关键词）」，按月翻的那套也一起去掉。
 *
 * 跟知识库（`knowledge`）不是一回事，别合并：
 *   · 知识库 = 「某一段行情 + AI 提炼的可复用经验」，按案例；
 *   · 日记 = 「我自己的话 + 那天碰了哪些币」，按时间。
 *
 * `day` 存 DATE（不带时区），由前端按**北京时间**给出 `YYYY-MM-DD`。
 */
import {query, queryOne} from './client'
import {normalizeBase} from './pins'

export const MAX_JOURNAL_COINS = 20
export const MAX_TITLE = 120
export const MAX_BODY = 20000
export const MAX_NOTE = 200

/** 列表默认一页多少条（「还有更多」再要下一页） */
export const JOURNAL_PAGE = 30

export interface JournalCoin {
  base: string
  /** 这个币在这篇里的一句话（可空） */
  note: string
  /**
   * 这个币在这一篇里**定住的那一刻**（北京时间 `HH:mm`，空串 = 没定）。
   * 点它跳 K 线时就定在这一刻 —— 用户 2026-10-18：「可以固定一个时间，点击就显示该段时间」。
   */
  at: string
}

export interface JournalEntry {
  id: number
  /** `YYYY-MM-DD` */
  day: string
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
  day: string | Date
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

/** `day` 存的是 DATE —— 驱动可能给 `2026-10-18` 或一个 Date，统一成 `YYYY-MM-DD` */
function dayOf(v: string | Date): string {
  if (v instanceof Date) {
    /* DATE 列取回来是**本地时区的零点**；别用 toISOString()（那会退一天） */
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return String(v).slice(0, 10)
}

/** `HH:mm` 校验 —— 只认 00:00 ~ 23:59，别的一律当没定 */
function atOf(v: unknown): string {
  const t = String(v ?? '').trim()
  const m = /^(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return ''
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return ''
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

function coinsOf(v: unknown): JournalCoin[] {
  if (!Array.isArray(v)) return []
  const out: JournalCoin[] = []
  for (const raw of v) {
    const o = raw as {base?: unknown; note?: unknown; at?: unknown}
    const base = String(o?.base ?? '').toUpperCase()
    if (!/^[A-Z0-9]{1,20}$/.test(base)) continue
    out.push({base, note: String(o?.note ?? '').slice(0, MAX_NOTE), at: atOf(o?.at)})
  }
  return out
}

function mapEntry(r: EntryRow): JournalEntry {
  return {
    id: Number(r.id),
    day: dayOf(r.day),
    title: r.title ?? '',
    body: r.body ?? '',
    coins: coinsOf(r.coins),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  }
}

/** 单篇的取数片段（`coins` 直接聚合成 JSON，省一次往返） */
const ENTRY_COLUMNS = `
  e.id, e.day, e.title, e.body, e.created_at, e.updated_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('base', c.base, 'note', c.note,
                                                'at', c.at_time)
                             ORDER BY c.sort, c.base)
              FROM journal_coins c WHERE c.entry_id = e.id), '[]'::jsonb) AS coins`

/**
 * 列表：**一律倒序**（日期新的在上，同一天按写入先后倒序）。
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
      ORDER BY e.day DESC, e.id DESC
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

export async function saveJournalEntry(
  userId: number,
  input: {id?: number | null; day: string; title?: string; body?: string; coins?: unknown}
): Promise<JournalEntry> {
  const day = String(input.day ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期要写成 2026-10-18')
  const title = String(input.title ?? '').slice(0, MAX_TITLE)
  const body = String(input.body ?? '').slice(0, MAX_BODY)

  const coins: JournalCoin[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(input.coins) ? input.coins : []) {
    const o = raw as {base?: unknown; note?: unknown; at?: unknown}
    let base: string
    try {
      base = normalizeBase(o?.base)
    } catch {
      continue // 写法不对的直接跳过（前端是列表选的，理论上不会有）
    }
    if (seen.has(base)) continue
    seen.add(base)
    coins.push({base, note: String(o?.note ?? '').trim().slice(0, MAX_NOTE), at: atOf(o?.at)})
    if (coins.length >= MAX_JOURNAL_COINS) break
  }

  let id = Number(input.id ?? 0) || 0
  if (id > 0) {
    const row = await queryOne<{id: string}>(
      `UPDATE journal_entries
          SET day = $3::date, title = $4, body = $5, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, userId, day, title, body]
    )
    if (!row) throw new Error('这条日记不存在（或者不是你的）')
  } else {
    const row = await queryOne<{id: string}>(
      `INSERT INTO journal_entries (user_id, day, title, body)
       VALUES ($1, $2::date, $3, $4)
       RETURNING id`,
      [userId, day, title, body]
    )
    if (!row) throw new Error('日记没写进去')
    id = Number(row.id)
  }

  /* 币整份换掉（条目最多 20 个，重写比 diff 简单也不慢） */
  await query('DELETE FROM journal_coins WHERE entry_id = $1', [id])
  for (let i = 0; i < coins.length; i++) {
    const c = coins[i]!
    await query(
      'INSERT INTO journal_coins (entry_id, base, note, at_time, sort) VALUES ($1, $2, $3, $4, $5)',
      [id, c.base, c.note, c.at, i]
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
