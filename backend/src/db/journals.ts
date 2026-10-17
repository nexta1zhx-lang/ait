/**
 * **交易日记**（用户 2026-10-18：「想再加一个模块。日记模块可以加入某些币种，总结」）。
 *
 * 口径（跟用户对过的）：
 *   · **条目式**，不是「一天一格」：哪天想写就写一条，一周写一条也行，一天写三条也行；
 *   · 每条可以**挂几个币**，每个币后面跟一句自己的话（「DOGE 追高被套」）；
 *   · **按月汇总**：一个月的条目、提到哪些币、这些币那个月怎么走的、我在它们上面做了多少、
 *     以及一个「月度总结」框（自己写，不接模型）；
 *   · 两个**缺口提示**：交易过但没写进日记的币 / 写了但整月没交易的币 —— 复盘最该补的是前者。
 *
 * 跟知识库（`knowledge`）不是一回事，别合并：
 *   · 知识库 = 「某一段行情 + AI 提炼的可复用经验」，按案例；
 *   · 日记 = 「我自己的话 + 那天碰了哪些币」，按时间。
 *
 * 月 / 日一律按**北京时间**算（跟全站显示同一口径）：`day` 存 DATE（不带时区），
 * 月份的时间窗在 SQL 里用 `+08:00` 现算。
 */
import {query, queryOne} from './client'
import {normalizeBase} from './pins'

/** 一条日记最多挂几个币（防手滑一次塞几百个） */
export const MAX_JOURNAL_COINS = 20
/** 正文 / 标题的长度上限（库是 TEXT，这里只是防「贴一整本书」） */
export const MAX_TITLE = 120
export const MAX_BODY = 20000
export const MAX_NOTE = 200

export interface JournalCoin {
  base: string
  /** 对这个币的一句话 */
  note: string
}

export interface JournalEntry {
  id: number
  /** 哪一天（`YYYY-MM-DD`，北京时间） */
  day: string
  title: string
  body: string
  coins: JournalCoin[]
  createdAt: string
  updatedAt: string
}

/** 月视图里「一个币」的统计 */
export interface JournalCoinStat {
  base: string
  /** 这个月有几篇日记提到它 */
  mentions: number
  /** 这个月涨跌幅（%），拿不到就是 null（新币 / 没 K 线） */
  pct: number | null
  /** 这个月我在它上面成交了几笔 */
  fills: number
  /** 这个月我在它上面的净盈亏（已实现 − 手续费），没成交就是 0 */
  pnl: number
}

export interface JournalMonth {
  /** `YYYY-MM` */
  month: string
  entries: JournalEntry[]
  /** 这个月自己写的那一段总结（没写过是空串） */
  summary: string
  stats: {
    entries: number
    coins: JournalCoinStat[]
    /** 这些币合计的成交笔数 / 净盈亏 */
    fills: number
    pnl: number
    /**
     * 交易过、但这个月一篇都没写到的币（**按成交笔数多的在前**）。
     *
     * 带 `fills` 是为了在页面上把它排好序、并且只露前几个 —— 一个月交易过的币
     * 可能几十个（实测 46 个），全铺出来会把页面撑爆，而真正该补的是**做得多的那几个**。
     */
    missing: {base: string; fills: number}[]
    /** 写到了、但这个月没交易过的币（只是在看） */
    idle: string[]
  }
}

interface EntryRow {
  id: string | number
  day: string | Date
  title: string | null
  body: string | null
  created_at: Date | string
  updated_at: Date | string
  coins: unknown
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

function coinsOf(v: unknown): JournalCoin[] {
  if (!Array.isArray(v)) return []
  const out: JournalCoin[] = []
  for (const raw of v) {
    const o = raw as {base?: unknown; note?: unknown}
    const base = String(o?.base ?? '').toUpperCase()
    if (!/^[A-Z0-9]{1,20}$/.test(base)) continue
    out.push({base, note: String(o?.note ?? '').slice(0, MAX_NOTE)})
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

/**
 * 月份的时间窗（北京时间）。
 *
 * `YYYY-MM` → `[本月 1 日 00:00+08, 下月 1 日 00:00+08)`。
 * @returns 两个 `+08:00` 的时间戳字符串，直接塞进 SQL 比较
 */
export function monthWindow(month: string): {start: string; end: string; next: string} {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw new Error('月份要写成 2026-10')
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) throw new Error('月份要写成 2026-10')
  const nextY = mo === 12 ? y + 1 : y
  const nextM = mo === 12 ? 1 : mo + 1
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    start: `${y}-${pad(mo)}-01T00:00:00+08:00`,
    end: `${nextY}-${pad(nextM)}-01T00:00:00+08:00`,
    next: `${nextY}-${pad(nextM)}`
  }
}

/** 这个月的全部条目（新的在前，每条带币） */
async function entriesOfMonth(userId: number, month: string): Promise<JournalEntry[]> {
  const {start, end} = monthWindow(month)
  const rows = await query<EntryRow>(
    `SELECT e.id,
            e.day,
            e.title,
            e.body,
            e.created_at,
            e.updated_at,
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object('base', c.base, 'note', c.note)
                                ORDER BY c.sort, c.base)
                 FROM journal_coins c WHERE c.entry_id = e.id),
              '[]'::jsonb
            ) AS coins
       FROM journal_entries e
      WHERE e.user_id = $1
        AND e.day >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
        AND e.day <  ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
      ORDER BY e.day DESC, e.id DESC`,
    [userId, start, end]
  )
  return rows.map(mapEntry)
}

/**
 * 这些币这个月的涨跌幅（用本地日线：月初第一根的开盘 → 月末最后一根的收盘）。
 *
 * ⚠️ 拿不到就返回 `null`（新币 / 库里还没日线），**不要**退化成 0 ——
 *    0% 会被读成「这个月没动」。
 */
async function monthPctOf(bases: string[], month: string): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!bases.length) return out
  const {start, end} = monthWindow(month)
  const pairs = bases.map(b => `${b}USDT`)
  const rows = await query<{pair: string; first_open: number; last_close: number}>(
    `SELECT pair,
            (array_agg(open  ORDER BY open_time ASC ))[1] AS first_open,
            (array_agg(close ORDER BY open_time DESC))[1] AS last_close
       FROM candles
      WHERE exchange = 'binance'
        AND market_type = 'swap'
        AND interval = '1d'
        AND pair = ANY($1)
        AND open_time >= $2::timestamptz
        AND open_time <  $3::timestamptz
      GROUP BY pair`,
    [pairs, start, end]
  )
  for (const r of rows) {
    const o = Number(r.first_open)
    const c = Number(r.last_close)
    if (!Number.isFinite(o) || !Number.isFinite(c) || o <= 0) continue
    out.set(String(r.pair).replace(/USDT$/, ''), Number((((c - o) / o) * 100).toFixed(2)))
  }
  return out
}

/** 这些币这个月的成交（笔数 + 净盈亏 = 已实现 − 手续费） */
async function monthFillsOf(
  userId: number,
  bases: string[],
  month: string
): Promise<Map<string, {fills: number; pnl: number}>> {
  const out = new Map<string, {fills: number; pnl: number}>()
  if (!bases.length) return out
  const {start, end} = monthWindow(month)
  const pairs = bases.map(b => `${b}USDT`)
  const rows = await query<{symbol: string; n: string | number; pnl: string | number}>(
    `SELECT upper(symbol) AS symbol,
            count(*) AS n,
            COALESCE(sum(realized - fee), 0) AS pnl
       FROM exchange_fills
      WHERE user_id = $1
        AND upper(symbol) = ANY($2)
        AND ts >= $3::timestamptz
        AND ts <  $4::timestamptz
      GROUP BY upper(symbol)`,
    [userId, pairs, start, end]
  )
  for (const r of rows) {
    out.set(String(r.symbol).replace(/USDT$/, ''), {
      fills: Number(r.n) || 0,
      pnl: Number(Number(r.pnl ?? 0).toFixed(2))
    })
  }
  return out
}

/**
 * 这个月**交易过**的全部币，带上各自成交了几笔（缺口提示用）。
 *
 * 笔数拿来排序：页面只露前几个「做得最多、却一篇没写」的，其余折起来。
 */
async function tradedBasesOf(
  userId: number,
  month: string
): Promise<{base: string; fills: number}[]> {
  const {start, end} = monthWindow(month)
  const rows = await query<{base: string; n: string | number}>(
    `SELECT upper(regexp_replace(symbol, 'USDT$', '')) AS base, count(*) AS n
       FROM exchange_fills
      WHERE user_id = $1
        AND ts >= $2::timestamptz
        AND ts <  $3::timestamptz
      GROUP BY base
      ORDER BY n DESC, base`,
    [userId, start, end]
  )
  return rows
    .filter(r => Boolean(r.base))
    .map(r => ({base: r.base, fills: Number(r.n) || 0}))
}

/** 月视图需要的全部东西（一次请求拿全） */
export async function getJournalMonth(userId: number, month: string): Promise<JournalMonth> {
  const entries = await entriesOfMonth(userId, month)
  const mentions = new Map<string, number>()
  for (const e of entries) {
    for (const c of e.coins) mentions.set(c.base, (mentions.get(c.base) ?? 0) + 1)
  }
  const bases = [...mentions.keys()]
  const [pctMap, fillMap, traded] = await Promise.all([
    monthPctOf(bases, month),
    monthFillsOf(userId, bases, month),
    tradedBasesOf(userId, month)
  ])

  const coins: JournalCoinStat[] = bases
    .map(base => ({
      base,
      mentions: mentions.get(base) ?? 0,
      pct: pctMap.get(base) ?? null,
      fills: fillMap.get(base)?.fills ?? 0,
      pnl: fillMap.get(base)?.pnl ?? 0
    }))
    .sort((a, b) => b.mentions - a.mentions || b.fills - a.fills || a.base.localeCompare(b.base))

  const summaryRow = await queryOne<{summary: string}>(
    'SELECT summary FROM journal_months WHERE user_id = $1 AND month = $2',
    [userId, month]
  )

  const written = new Set(bases)
  return {
    month,
    entries,
    summary: summaryRow?.summary ?? '',
    stats: {
      entries: entries.length,
      coins,
      fills: coins.reduce((n, c) => n + c.fills, 0),
      pnl: Number(coins.reduce((n, c) => n + c.pnl, 0).toFixed(2)),
      /* 交易过、但一篇没写 —— 按成交笔数多的在前（页面只露前几个，其余折起来） */
      missing: traded.filter(t => !written.has(t.base)),
      /* 写了、但这个月没交易过（只是在看） */
      idle: coins.filter(c => c.fills === 0).map(c => c.base)
    }
  }
}

/** 保存一条（`id` 为空 = 新建）。返回保存后的这条 + 它所在的那个月 */
export async function saveJournalEntry(
  userId: number,
  input: {id?: number | null; day: string; title?: string; body?: string; coins?: unknown}
): Promise<{entry: JournalEntry; month: string}> {
  const day = String(input.day ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期要写成 2026-10-18')
  const title = String(input.title ?? '').slice(0, MAX_TITLE)
  const body = String(input.body ?? '').slice(0, MAX_BODY)

  const coins: JournalCoin[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(input.coins) ? input.coins : []) {
    const o = raw as {base?: unknown; note?: unknown}
    let base: string
    try {
      base = normalizeBase(o?.base)
    } catch {
      continue // 写法不对的直接跳过（前端是列表选的，理论上不会有）
    }
    if (seen.has(base)) continue
    seen.add(base)
    coins.push({base, note: String(o?.note ?? '').trim().slice(0, MAX_NOTE)})
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
      'INSERT INTO journal_coins (entry_id, base, note, sort) VALUES ($1, $2, $3, $4)',
      [id, c.base, c.note, i]
    )
  }

  const saved = await queryOne<EntryRow>(
    `SELECT e.id, e.day, e.title, e.body, e.created_at, e.updated_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('base', c.base, 'note', c.note)
                                       ORDER BY c.sort, c.base)
                        FROM journal_coins c WHERE c.entry_id = e.id), '[]'::jsonb) AS coins
       FROM journal_entries e WHERE e.id = $1`,
    [id]
  )
  if (!saved) throw new Error('保存后读不回来')
  return {entry: mapEntry(saved), month: day.slice(0, 7)}
}

export async function deleteJournalEntry(userId: number, id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM journal_entries WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}

/** 存月度总结（upsert；传空串就是清掉） */
export async function saveJournalMonth(
  userId: number,
  month: string,
  summary: string
): Promise<void> {
  monthWindow(month) // 校验格式
  const text = String(summary ?? '').slice(0, MAX_BODY)
  await query(
    `INSERT INTO journal_months (user_id, month, summary, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, month) DO UPDATE
        SET summary = EXCLUDED.summary, updated_at = now()`,
    [userId, month, text]
  )
}

/**
 * 这个币在**历次日记**里被怎么说的（跨月反查）。
 *
 * 用户还没提，但这是「日记」最值钱的一条：能看出「我每次碰 DOGE 都是同一个错」。
 */
export async function coinHistory(
  userId: number,
  rawBase: string,
  limit = 100
): Promise<JournalEntry[]> {
  const base = normalizeBase(rawBase)
  const rows = await query<EntryRow>(
    `SELECT e.id, e.day, e.title, e.body, e.created_at, e.updated_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('base', c.base, 'note', c.note)
                                       ORDER BY c.sort, c.base)
                        FROM journal_coins c WHERE c.entry_id = e.id), '[]'::jsonb) AS coins
       FROM journal_entries e
       JOIN journal_coins c1 ON c1.entry_id = e.id AND c1.base = $2
      WHERE e.user_id = $1
      ORDER BY e.day DESC, e.id DESC
      LIMIT $3`,
    [userId, base, limit]
  )
  return rows.map(mapEntry)
}

/** 有日记的月份列表（新的在前）—— 前端拿它画「◀ 2026-10 ▶」时判断有没有更早的 */
export async function journalMonths(userId: number): Promise<string[]> {
  const rows = await query<{month: string}>(
    `SELECT to_char(day, 'YYYY-MM') AS month
       FROM journal_entries
      WHERE user_id = $1
      GROUP BY month
      ORDER BY month DESC`,
    [userId]
  )
  return rows.map(r => r.month)
}
