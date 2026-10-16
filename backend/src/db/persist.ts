/**
 * **持久化分析**的会话表（2026-10-15 用户：「在 k 线界面顶部加入持久化分析的图标，
 * 点击图标弹窗确定要加入持久化分析，每隔 15 分钟分析一次，最长不超过 8 小时」）。
 *
 * 这一层只管「会话」这件状态：谁在盯哪个币、口径是什么、跑了几轮、下一轮什么时候、
 * 最近一条结论是什么。**真正的分析在 `analysis/persist.ts` 里跑**（那里调 `runAnalysis`）。
 *
 * ⚠️ 调度的口径（一整条链上只有这里和 `persist.ts` 两处定义，别在别处算）：
 *   · **周期决定频率**（2026-10-16 用户：「选择周期要和调用次数匹配」）：
 *       `15m` ⇒ 每 **15 分钟** 问一次，最长 **8 小时**（= 32 次）
 *       `1h`  ⇒ 每 **1 小时** 问一次，最长 **16 小时**（= 16 次）
 *     只支持这两个周期（`CADENCES` 就是唯一真源，界面上也只给这两个）。
 *   · 每次**对齐 K 线收线 + 20 秒**（15m：:00/:15/:30/:45；1h：整点）；
 *   · 同时最多 `MAX_ACTIVE_PER_USER` 个会话（多点几下别把钱包烧了）。
 */
import {query, queryOne} from './client'
import {verdictOf} from '../analysis/verdict'

/** 一个会话的节奏：周期 → 间隔 / 总时长 / 最多几轮 */
export interface Cadence {
  timeframe: string
  /** 每轮间隔（毫秒） */
  intervalMs: number
  /** 会话最长跑多久（毫秒） */
  maxMs: number
  /** 最多跑几轮（= maxMs / intervalMs，写死是为了界面能直接显示"≈N 次"） */
  maxRuns: number
  label: string
}

/**
 * **唯一真源**：支持哪几个周期、各自的间隔和多长。
 *
 * ★ 2026-10-16 用户：「选择周期要和调用次数匹配，不再是固定 15 分钟交一次 AI 分析，
 *   如果我选择 15 分钟就掉 15 分钟的数据，15 分钟掉一次；如果选择 1 小时，
 *   就 1 小时调用一次 AI。只支持这两个周期。15 分钟是只钓 8 小时，1 小时可以钓 16 小时。」
 *
 * ⚠️ 数字对得上：15m × 32 = 8h、1h × 16 = 16h。改任何一个都要跟着改另两个。
 */
export const CADENCES: Cadence[] = [
  {timeframe: '15m', intervalMs: 15 * 60_000, maxMs: 8 * 60 * 60_000, maxRuns: 32, label: '15 分钟'},
  {timeframe: '1h', intervalMs: 60 * 60_000, maxMs: 16 * 60 * 60_000, maxRuns: 16, label: '1 小时'}
]

/** 取某个周期的节奏（认不出来就按 15m —— 老会话里可能存着 4h 这种已下线的值） */
export function cadenceOf(timeframe: string): Cadence {
  return CADENCES.find(c => c.timeframe === timeframe) ?? CADENCES[0]!
}

/** 「回看天数」不再让人选（2026-10-16 用户：「回看几天的去掉」）——
 *  它本来就只是个换算根数的旋钮，而根数有 200 的下限兜着，喂给 AI 的永远是最近 100 根。 */
export const DEFAULT_DAYS = 3

/** 一个用户同时最多几个会话 */
export const MAX_ACTIVE_PER_USER = 3
/** 连续失败这么多次就暂停这个会话（别默默一直烧） */
export const MAX_CONSECUTIVE_FAILURES = 3

export interface PersistSession {
  id: number
  userId: number
  /** 基础币（BTC） */
  symbol: string
  /** 行情符号（BTC/USDT:USDT） */
  ccxtSymbol: string
  exchange: string
  marketType: string
  /** 冻结的分析口径 */
  timeframe: string
  days: number
  startedAt: string
  endsAt: string
  nextAt: string
  runs: number
  failed: number
  status: 'active' | 'ended'
  endedReason: string | null
  endedAt: string | null
  /** 最近一条结论 */
  lastAnalysisId: number | null
  lastVerdict: string | null
  lastLine: string | null
  lastPrice: number | null
  lastAt: string | null
}

interface Raw {
  id: string
  user_id: string
  symbol: string
  ccxt_symbol: string
  exchange: string
  market_type: string
  timeframe: string
  days: number
  started_at: Date
  ends_at: Date
  next_at: Date
  runs: number
  failed: number
  status: string
  ended_reason: string | null
  ended_at: Date | null
  last_analysis_id: string | null
  last_verdict: string | null
  last_line: string | null
  last_price: string | null
  last_at: Date | null
}

const COLS = `id, user_id, symbol, ccxt_symbol, exchange, market_type, timeframe, days,
              started_at, ends_at, next_at, runs, failed, status, ended_reason, ended_at,
              last_analysis_id, last_verdict, last_line, last_price, last_at`

const iso = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString() : String(d)

function map(r: Raw): PersistSession {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    symbol: r.symbol,
    ccxtSymbol: r.ccxt_symbol,
    exchange: r.exchange,
    marketType: r.market_type,
    timeframe: r.timeframe,
    days: Number(r.days),
    startedAt: iso(r.started_at)!,
    endsAt: iso(r.ends_at)!,
    nextAt: iso(r.next_at)!,
    runs: Number(r.runs),
    failed: Number(r.failed),
    status: r.status === 'ended' ? 'ended' : 'active',
    endedReason: r.ended_reason,
    endedAt: iso(r.ended_at),
    lastAnalysisId: r.last_analysis_id === null ? null : Number(r.last_analysis_id),
    lastVerdict: r.last_verdict,
    lastLine: r.last_line,
    lastPrice: r.last_price === null ? null : Number(r.last_price),
    lastAt: iso(r.last_at)
  }
}

/**
 * 下一轮的时刻：**对齐这个周期的 K 线收线 + 20 秒**（15m：:00/:15/:30/:45；1h：整点）。
 *
 * 为什么对齐：喂给 AI 的行情是"截止最后一根**已收盘** K 线"，对齐之后每一轮的输入都是
 * 刚收线那根，同一会话里各轮的输入口径一致（可横向比）；不对齐会出现"这一轮用了 3 分钟前
 * 收的那根、下一轮用了刚收的"，结论没法比。
 * 为什么 +20 秒：给 K 线底座（`kline-recorder`）一点落库时间，别抢在它前面。
 */
export function nextRunAt(intervalMs: number, from: number = Date.now()): Date {
  const aligned = Math.floor((from + 20_000) / intervalMs) * intervalMs
  const at = aligned > from ? aligned : aligned + intervalMs
  return new Date(at + 20_000)
}

/** 建会话（同一个币同时只能有一个在跑 —— 唯一索引挡重复点） */
export async function createSession(input: {
  userId: number
  symbol: string
  ccxtSymbol: string
  exchange: string
  marketType: string
  timeframe: string
  days: number
}): Promise<PersistSession> {
  const startedAt = Date.now()
  const cad = cadenceOf(input.timeframe)
  const row = await queryOne<Raw>(
    `INSERT INTO persist_sessions
       (user_id, symbol, ccxt_symbol, exchange, market_type, timeframe, days, next_at, ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${COLS}`,
    [
      input.userId,
      input.symbol.toUpperCase(),
      input.ccxtSymbol,
      input.exchange,
      input.marketType,
      input.timeframe,
      input.days,
      nextRunAt(cad.intervalMs, startedAt),
      new Date(startedAt + cad.maxMs)
    ]
  )
  if (!row) throw new Error('建持久化分析会话失败')
  return map(row)
}

export async function getSession(id: number): Promise<PersistSession | null> {
  const row = await queryOne<Raw>(
    `SELECT ${COLS} FROM persist_sessions WHERE id = $1`,
    [id]
  )
  return row ? map(row) : null
}

/** 某用户的会话列表（在跑的在前、然后按开始时间倒序） */
export async function listSessions(userId: number): Promise<PersistSession[]> {
  const rows = await query<Raw>(
    `SELECT ${COLS} FROM persist_sessions
      WHERE user_id = $1 AND started_at > now() - interval '7 days'
      ORDER BY (status = 'active') DESC, started_at DESC
      LIMIT 40`,
    [userId]
  )
  return rows.map(map)
}

/** 正在跑的会话数（加入之前查一下配额） */
export async function countActive(userId: number): Promise<number> {
  const row = await queryOne<{n: string}>(
    `SELECT count(*) AS n FROM persist_sessions WHERE user_id = $1 AND status = 'active'`,
    [userId]
  )
  return Number(row?.n ?? 0)
}

/**
 * 到点该跑的会话（跨用户）—— 调度器每个 tick 取这批。
 *
 * `FOR UPDATE SKIP LOCKED` 是为了将来多进程/多实例也不会重复跑同一条；
 * 现在只有一个进程，但它顺带把「这一批正在跑」的状态原子地标记出来了。
 */
export async function dueSessions(limit = 10): Promise<PersistSession[]> {
  const rows = await query<Raw>(
    `SELECT ${COLS} FROM persist_sessions
      WHERE status = 'active' AND next_at <= now()
      ORDER BY next_at
      LIMIT $1`,
    [limit]
  )
  return rows.map(map)
}

/** 一轮跑完：推进 next_at、清失败计数、记下最近一条结论 */
export async function markRun(input: {
  id: number
  runs: number
  nextAt: Date
  analysisId: number | null
  verdict: string | null
  line: string | null
  price: number | null
}): Promise<void> {
  await query(
    `UPDATE persist_sessions
        SET runs = $2, failed = 0, next_at = $3,
            last_analysis_id = $4, last_verdict = $5, last_line = $6, last_price = $7,
            last_at = now(), updated_at = now()
      WHERE id = $1`,
    [input.id, input.runs, input.nextAt, input.analysisId, input.verdict, input.line, input.price]
  )
}

/**
 * 这一轮失败（模型 / 网络）。
 *
 * ⚠️ `runs` **不推进** —— 失败的一轮不算"问过一次"，否则连续失败会把 32 次配额吃光；
 * 但 `next_at` 要往前推，别让一个坏会话卡在队首每 15 分钟重试到天亮。
 */
export async function markFailure(input: {
  id: number
  failed: number
  /** 这个会话的间隔（决定下一轮什么时候，见 `cadenceOf`） */
  intervalMs: number
}): Promise<'ok' | 'paused'> {
  const paused = input.failed >= MAX_CONSECUTIVE_FAILURES
  await query(
    `UPDATE persist_sessions
        SET failed = $2, next_at = $3, updated_at = now()
            ${paused ? ", status = 'ended', ended_reason = '连续失败自动停', ended_at = now()" : ''}
      WHERE id = $1`,
    [input.id, input.failed, nextRunAt(input.intervalMs)]
  )
  return paused ? 'paused' : 'ok'
}

/** 结束一个会话（到点 / 手动停 / 连续失败） */
export async function endSession(id: number, reason: string): Promise<void> {
  await query(
    `UPDATE persist_sessions
        SET status = 'ended', ended_reason = $2, ended_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [id, reason]
  )
}

/** 到点自动结束（调度器每个 tick 顺手收一批到时长上限的：15m 会话 8h / 1h 会话 16h） */
export async function expireSessions(): Promise<number> {
  const rows = await query<{id: string}>(
    `UPDATE persist_sessions
        SET status = 'ended', ended_reason = '到时长上限', ended_at = now(), updated_at = now()
      WHERE status = 'active' AND ends_at <= now()
      RETURNING id`
  )
  return rows.length
}

/**
 * 记一条提醒（「转成可做」）。
 *
 * 用途见 `schema.ts` 里 `persist_alerts` 那段：**给 App 那个前台服务轮询用的锚点**
 *（手机上没谷歌服务时 FCM 用不了，改成 App 自己轮询），顺带当提醒的账本。
 */
export async function insertAlert(input: {
  userId: number
  sessionId: number
  symbol: string
  timeframe: string
  verdict: string
  line: string
  price: number | null
}): Promise<void> {
  await query(
    `INSERT INTO persist_alerts (user_id, session_id, symbol, timeframe, verdict, line, price)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.userId,
      input.sessionId,
      input.symbol,
      input.timeframe,
      input.verdict,
      input.line,
      input.price
    ]
  )
}

/** 提醒流水（`since` 之后的新条目，老的在前） */
export async function listAlerts(
  userId: number,
  since: number,
  limit = 20
): Promise<{id: number; symbol: string; timeframe: string; verdict: string; line: string; price: number | null; createdAt: string}[]> {
  const rows = await query<{
    id: string
    symbol: string
    timeframe: string
    verdict: string | null
    line: string | null
    price: string | null
    created_at: Date
  }>(
    `SELECT id, symbol, timeframe, verdict, line, price, created_at
       FROM persist_alerts
      WHERE user_id = $1 AND id > $2
      ORDER BY id
      LIMIT $3`,
    [userId, since, limit]
  )
  return rows.map(r => ({
    id: Number(r.id),
    symbol: r.symbol,
    timeframe: r.timeframe,
    verdict: r.verdict ?? 'go',
    line: r.line ?? '',
    price: r.price === null ? null : Number(r.price),
    createdAt: iso(r.created_at)!
  }))
}

/** 这个用户最新那条提醒的 id（App 第一次拉的时候拿它当起点，免得把历史全弹一遍） */
export async function latestAlertId(userId: number): Promise<number> {
  const row = await queryOne<{id: string | null}>(
    `SELECT max(id) AS id FROM persist_alerts WHERE user_id = $1`,
    [userId]
  )
  return row?.id === null || row?.id === undefined ? 0 : Number(row.id)
}

/** 用户手动停（只能停自己的） */
export async function stopSession(userId: number, id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    `UPDATE persist_sessions
        SET status = 'ended', ended_reason = '手动停止', ended_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'active'
      RETURNING id`,
    [id, userId]
  )
  return rows.length > 0
}

export interface TimelineRow {
  id: number
  createdAt: string
  verdict: string | null
  line: string
  price: number | null
  costUsd: number | null
  /**
   * 这一条之后的价格变化（%，复盘用，取不到是 null）：
   *   · `after15m` = 那一刻之后 **15 分钟** 的价格 vs 当时价
   *   · `after1h`  = 那一刻之后 **1 小时** 的价格 vs 当时价
   * ★ 2026-10-16 用户：「改为前 15 分钟的那一根和前 1 小时的那一根，涨跌幅是多少」——
   *   原来是 +1h / +4h（4 小时对 8 小时的会话来说常常等不到）。
   */
  after15m: number | null
  after1h: number | null
}

/**
 * 一个会话的**结论时间线**。
 *
 * 直接读 `analyses`（`source='persist'` 且在这一会话的时间窗里）—— 不另建映射表：
 * 每条结论都已经落在那儿了（含当时价格），复制一份只会两边不同步。
 *
 * 后验涨跌（+15 分钟 / +1 小时）**现算**，用的是 **1 分钟 K 线**：
 * 取 `analyses.created_at + 15 分钟（或 1 小时）` 之后**第一根已收盘的 1m** 的收盘价，
 * 跟这条记录的 `price` 比。
 *   · 为什么用 1m 而不是 15m/1h：要的是"那一刻之后 15 分钟 / 1 小时**大概**多少钱"，
 *     1m 级最贴近这个说法（用 15m 的话最早也是 30 分钟后才有一根收盘的）；
 *   · 为什么是「之后第一根」而不是"刚好那一刻"：K 线按整点切，分析是在收线 +20 秒跑的，
 *     取"之后第一根"就是"再往后一点点"的那个价，不会用到未来的数据。
 * ⚠️ 未来的那几根还没发生 ⇒ 就是 null（页面上显示倒计时）。
 */
export async function sessionTimeline(
  session: PersistSession,
  limit = 40
): Promise<TimelineRow[]> {
  const rows = await query<{
    id: string
    created_at: Date
    grade_reason: string | null
    price: string | null
    cost_usd: string | null
    a15: string | null
    a1: string | null
  }>(
    `SELECT a.id, a.created_at, a.grade_reason, a.price, a.cost_usd,
            (SELECT f.close FROM candles f
              WHERE f.exchange = a.exchange AND f.market_type = a.market_type
                AND f.interval = '1m' AND f.symbol = a.ccxt_symbol
                AND f.open_time >= a.created_at + interval '15 minutes'
              ORDER BY f.open_time LIMIT 1) AS a15,
            (SELECT f.close FROM candles f
              WHERE f.exchange = a.exchange AND f.market_type = a.market_type
                AND f.interval = '1m' AND f.symbol = a.ccxt_symbol
                AND f.open_time >= a.created_at + interval '1 hour'
              ORDER BY f.open_time LIMIT 1) AS a1
       FROM analyses a
      WHERE a.user_id = $1 AND a.source = 'persist' AND a.symbol = $2
        AND a.created_at >= $3
      ORDER BY a.created_at DESC
      LIMIT $4`,
    [session.userId, session.symbol, session.startedAt, limit]
  )
  return rows
    .map(r => {
      const price = r.price === null ? null : Number(r.price)
      const chg = (v: string | null): number | null => {
        const x = v === null ? null : Number(v)
        return price && price > 0 && x !== null ? (x / price - 1) * 100 : null
      }
      return {
        id: Number(r.id),
        createdAt: iso(r.created_at)!,
        verdict: verdictOf(r.grade_reason ?? ''),
        line: r.grade_reason ?? '',
        price,
        costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
        after15m: chg(r.a15),
        after1h: chg(r.a1)
      }
    })
    .reverse()
}

