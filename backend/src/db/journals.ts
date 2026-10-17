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

export interface JournalCategory {
  id: number
  name: string
  /** 文件夹颜色（`#rrggbb`；空串 = 前端用默认色） */
  color: string
}

export interface JournalEntry {
  id: number
  /** 这条**最后一次改动**的时刻（北京时间 `YYYY-MM-DD HH:mm`）—— 列表就显示它 */
  at: string
  title: string
  body: string
  coins: JournalCoin[]
  /** 挂的分类（null = 未分类） */
  category: JournalCategory | null
  /** 置顶（置顶的永远排在列表最前） */
  pinned: boolean
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
  category: unknown
  pinned: boolean | null
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

function categoryOf(v: unknown): JournalCategory | null {
  if (!v || typeof v !== 'object') return null
  const o = v as {id?: unknown; name?: unknown; color?: unknown}
  const id = Number(o.id)
  if (!Number.isFinite(id) || id <= 0) return null
  return {id, name: String(o.name ?? ''), color: String(o.color ?? '')}
}

function mapEntry(r: EntryRow): JournalEntry {
  return {
    id: Number(r.id),
    at: String(r.at ?? '').slice(0, 16),
    title: r.title ?? '',
    body: r.body ?? '',
    coins: coinsOf(r.coins),
    category: categoryOf(r.category),
    pinned: r.pinned === true,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  }
}

/** 单篇的取数片段（`coins` 聚合成 JSON，时间统一换成北京时间字面串） */
const ENTRY_COLUMNS = `
  e.id,
  to_char(e.updated_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') AS at,
  e.title, e.body, e.created_at, e.updated_at, e.pinned,
  (SELECT jsonb_build_object('id', k.id, 'name', k.name, 'color', k.color)
     FROM journal_categories k WHERE k.id = e.category_id) AS category,
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
/**
 * `YYYY-MM` → 那个月的 `[起, 止)`（北京时间）。给「只看某个月」用。
 * 用时间范围而不是 `to_char(...) = ?`，这样能吃到 `(user_id, updated_at DESC)` 那条索引。
 */
function monthRange(month: string): {from: string; to: string} | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  const ny = mo === 12 ? y + 1 : y
  const nm = mo === 12 ? 1 : mo + 1
  return {
    from: `${m[1]}-${m[2]}-01T00:00:00+08:00`,
    to: `${ny}-${String(nm).padStart(2, '0')}-01T00:00:00+08:00`
  }
}

export async function listJournalEntries(
  userId: number,
  opts: {
    coin?: string
    q?: string
    /** 只看某几个月（`YYYY-MM`，可以给多个 —— 用户 2026-10-18：「可以选择多月份」） */
    months?: string[]
    /** 只看某个分类（分类 id；null / 0 = 全部） */
    category?: number | null
    limit?: number
    offset?: number
  } = {}
): Promise<JournalList> {
  const coin = opts.coin ? normalizeBase(opts.coin) : ''
  const q = String(opts.q ?? '').trim().slice(0, 80)
  const like = q ? `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%` : ''
  const limit = Math.min(Math.max(Number(opts.limit) || JOURNAL_PAGE, 1), 200)
  const offset = Math.max(Number(opts.offset) || 0, 0)
  const ranges = (opts.months ?? [])
    .map(m => monthRange(String(m).trim()))
    .filter((r): r is {from: string; to: string} => r !== null)
  const froms = ranges.length ? ranges.map(r => r.from) : null
  const tos = ranges.length ? ranges.map(r => r.to) : null
  const categoryId = Math.max(0, Number(opts.category) || 0) || null

  const rows = await query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS}, count(*) OVER () AS total
       FROM journal_entries e
      WHERE e.user_id = $1
        AND ($2::text = '' OR EXISTS (
              SELECT 1 FROM journal_coins c WHERE c.entry_id = e.id AND c.base = $2))
        AND ($3::text = '' OR e.title ILIKE $3 ESCAPE '\\' OR e.body ILIKE $3 ESCAPE '\\')
        AND ($6::timestamptz[] IS NULL OR EXISTS (
              SELECT 1
                FROM unnest($6::timestamptz[], $7::timestamptz[]) AS mr(a, b)
               WHERE e.updated_at >= mr.a AND e.updated_at < mr.b))
        AND ($8::bigint IS NULL OR e.category_id = $8::bigint)
      ORDER BY e.pinned DESC, e.updated_at DESC, e.id DESC
      LIMIT $4 OFFSET $5`,
    [
      userId,
      coin,
      like,
      limit,
      offset,
      froms,
      tos,
      categoryId
    ]
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
  input: {
    id?: number | null
    title?: string
    body?: string
    coins?: unknown
    /** 挂到哪个分类（null / 0 = 未分类） */
    categoryId?: number | null
  }
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

  /*
   * 分类：没选就挂「默认」（用户 2026-10-18：「未选择就是默认分类」）；
   * 选了的话只认自己的、且必须真的存在（不合法也退回默认，别把整条保存搞挂）。
   */
  let categoryId = await defaultCategoryId(userId)
  const wantCategory = Number(input.categoryId) || 0
  if (wantCategory > 0) {
    const own = await queryOne<{id: string}>(
      'SELECT id FROM journal_categories WHERE id = $1 AND user_id = $2',
      [wantCategory, userId]
    )
    if (own) categoryId = Number(own.id)
  }

  let id = Number(input.id ?? 0) || 0
  if (id > 0) {
    const row = await queryOne<{id: string}>(
      `UPDATE journal_entries
          SET title = $3, body = $4, category_id = $5, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, userId, title, body, categoryId]
    )
    if (!row) throw new Error('这条日记不存在（或者不是你的）')
  } else {
    const row = await queryOne<{id: string}>(
      `INSERT INTO journal_entries (user_id, day, title, body, category_id)
       VALUES ($1, (now() AT TIME ZONE 'Asia/Shanghai')::date, $2, $3, $4)
       RETURNING id`,
      [userId, title, body, categoryId]
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

/**
 * 置顶 / 取消置顶。
 *
 * ⚠️ **不动 `updated_at`**：列表里那个时间是「最后改内容的时刻」，
 *    单纯拨一下置顶就把它改掉会让人以为内容刚改过。
 */
export async function setJournalPinned(
  userId: number,
  id: number,
  pinned: boolean
): Promise<boolean> {
  const rows = await query<{id: string}>(
    'UPDATE journal_entries SET pinned = $3 WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId, pinned]
  )
  return rows.length > 0
}

/* ---------------- 分类 ---------------- */

export const MAX_CATEGORY_NAME = 16

/**
 * 预设分类（用户 2026-10-18：「预设 仓位，经验，回忆录」；
 * 同一天又补一句「未选择就是默认分类新增一个」⇒ 前面多一个中性的「默认」）。
 *
 * 「默认」是真的一行数据：新建时没选分类就自动挂到它上面，
 * 老数据（`category_id IS NULL`）在第一次列分类时也会被归到它下面。
 */
export const DEFAULT_CATEGORY_NAME = '默认'
export const DEFAULT_CATEGORIES: {name: string; color: string}[] = [
  {name: DEFAULT_CATEGORY_NAME, color: '#8b93a1'},
  {name: '仓位', color: '#f0b429'},
  {name: '经验', color: '#72d6a0'},
  {name: '回忆录', color: '#e08aa8'}
]

export const CATEGORY_COLORS = ['#f0b429', '#72d6a0', '#e08aa8', '#7aa2f7', '#c792ea', '#f07178']

/**
 * 「默认」分类的 id（没有就建一个）。
 *
 * 它跟另外三个预设不一样：**永远兜底存在** —— 没选分类的条目要挂到它上面。
 */
export async function defaultCategoryId(userId: number): Promise<number> {
  const row = await queryOne<{id: string}>(
    `INSERT INTO journal_categories (user_id, name, color, sort)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (user_id, lower(name)) DO NOTHING
     RETURNING id`,
    [userId, DEFAULT_CATEGORY_NAME, DEFAULT_CATEGORIES[0]!.color]
  )
  if (row) return Number(row.id)
  const got = await queryOne<{id: string}>(
    'SELECT id FROM journal_categories WHERE user_id = $1 AND lower(name) = lower($2)',
    [userId, DEFAULT_CATEGORY_NAME]
  )
  if (!got) throw new Error('默认分类建不出来')
  return Number(got.id)
}

/**
 * 第一次进「经验」页时把这套预设种下去。
 *
 * ⚠️ 另外三个预设只在**一条分类都没有**时种：否则用户把它们删光了、下次进来又冒出来。
 * ⚠️「默认」例外，每次都会确保存在（它是兜底），顺手把「没分类的老条目」归到它下面。
 */
async function ensureDefaultCategories(userId: number): Promise<void> {
  const row = await queryOne<{n: string}>(
    'SELECT count(*)::text AS n FROM journal_categories WHERE user_id = $1',
    [userId]
  )
  if (Number(row?.n ?? 0) === 0) {
    for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
      const c = DEFAULT_CATEGORIES[i]!
      await query(
        `INSERT INTO journal_categories (user_id, name, color, sort)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [userId, c.name, c.color, i]
      )
    }
  }
  const defId = await defaultCategoryId(userId)
  /* 「默认」永远排第一个（它的 sort 固定 -1，不会被后来新增的分类挤下去） */
  await query(
    'UPDATE journal_categories SET sort = -1 WHERE id = $1 AND sort <> -1',
    [defId]
  )
  /* 老条目（没分类）归到「默认」下面 */
  await query(
    'UPDATE journal_entries SET category_id = $2 WHERE user_id = $1 AND category_id IS NULL',
    [userId, defId]
  )
}

export async function listJournalCategories(userId: number): Promise<JournalCategory[]> {
  await ensureDefaultCategories(userId)
  const rows = await query<{id: string; name: string; color: string}>(
    `SELECT id, name, color FROM journal_categories
      WHERE user_id = $1 ORDER BY sort, id`,
    [userId]
  )
  return rows.map(r => ({id: Number(r.id), name: r.name, color: r.color ?? ''}))
}

export async function createJournalCategory(
  userId: number,
  input: {name?: unknown; color?: unknown}
): Promise<JournalCategory> {
  const name = String(input.name ?? '').trim().slice(0, MAX_CATEGORY_NAME)
  if (!name) throw new Error('分类得有个名字')
  const wanted = String(input.color ?? '').trim()
  let color = /^#[0-9a-fA-F]{6}$/.test(wanted) ? wanted.toLowerCase() : ''
  if (!color) {
    const n = await queryOne<{n: string}>(
      'SELECT count(*)::text AS n FROM journal_categories WHERE user_id = $1',
      [userId]
    )
    color = CATEGORY_COLORS[Number(n?.n ?? 0) % CATEGORY_COLORS.length]!
  }
  const row = await queryOne<{id: string; name: string; color: string}>(
    `INSERT INTO journal_categories (user_id, name, color, sort)
     VALUES ($1, $2, $3, (SELECT COALESCE(max(sort), 0) + 1 FROM journal_categories WHERE user_id = $1))
     ON CONFLICT (user_id, lower(name)) DO NOTHING
     RETURNING id, name, color`,
    [userId, name, color]
  )
  if (!row) throw new Error(`「${name}」已经有了`)
  return {id: Number(row.id), name: row.name, color: row.color ?? ''}
}

/** 改分类的名字 / 颜色（只改自己的；重名给一句人话） */
export async function updateJournalCategory(
  userId: number,
  id: number,
  input: {name?: unknown; color?: unknown}
): Promise<JournalCategory> {
  const name = String(input.name ?? '').trim().slice(0, MAX_CATEGORY_NAME)
  if (!name) throw new Error('分类得有个名字')
  const wanted = String(input.color ?? '').trim()
  const color = /^#[0-9a-fA-F]{6}$/.test(wanted) ? wanted.toLowerCase() : ''
  const dup = await queryOne<{id: string}>(
    'SELECT id FROM journal_categories WHERE user_id = $1 AND lower(name) = lower($2) AND id <> $3',
    [userId, name, id]
  )
  if (dup) throw new Error(`「${name}」已经有了`)
  const row = await queryOne<{id: string; name: string; color: string}>(
    `UPDATE journal_categories
        SET name = $3, color = COALESCE(NULLIF($4, ''), color)
      WHERE id = $1 AND user_id = $2
      RETURNING id, name, color`,
    [id, userId, name, color]
  )
  if (!row) throw new Error('这个分类不存在（或者不是你的）')
  return {id: Number(row.id), name: row.name, color: row.color ?? ''}
}

/**
 * 删一个分类 —— 它底下的条目**先挪回「默认」**，别让它们变成孤儿。
 * ⚠️「默认」不能删：它是没选分类时的落点，删了下次保存又会被建出来。
 */
export async function deleteJournalCategory(userId: number, id: number): Promise<boolean> {
  const defId = await defaultCategoryId(userId)
  if (id === defId) throw new Error('「默认」分类不能删')
  await query(
    'UPDATE journal_entries SET category_id = $3 WHERE user_id = $1 AND category_id = $2',
    [userId, id, defId]
  )
  const rows = await query<{id: string}>(
    'DELETE FROM journal_categories WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}

export async function deleteJournalEntry(userId: number, id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM journal_entries WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}
