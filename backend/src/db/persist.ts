/**
 * **持久化分析**的会话表（2026-10-15 用户：「在 k 线界面顶部加入持久化分析的图标，
 * 点击图标弹窗确定要加入持久化分析，每隔 15 分钟分析一次，最长不超过 8 小时」）。
 *
 * 这一层只管「会话」这件状态：谁在盯哪个币、口径是什么、跑了几轮、下一轮什么时候、
 * 最近一条结论是什么。**真正的分析在 `analysis/persist.ts` 里跑**（那里调 `runAnalysis`）。
 *
 * ⚠️ 调度的口径（一整条链上只有这里和 `persist.ts` 两处定义，别在别处算）：
 *   · 每轮间隔 `RUN_INTERVAL_MS` = 15 分钟，**对齐 15m 收线**（:00/:15/:30/:45 + 20 秒）；
 *   · 会话总时长 `MAX_SESSION_MS` = 8 小时 = **最多 32 次**；
 *   · 同时最多 `MAX_ACTIVE_PER_USER` 个会话（多点几下别把钱包烧了）。
 */
import {query, queryOne} from './client'
import {verdictOf} from '../analysis/verdict'

/** 一轮的间隔：15 分钟（对齐 15m 收线，见 `nextRunAt`） */
export const RUN_INTERVAL_MS = 15 * 60_000
/** 一个会话最长跑多久：8 小时（用户 2026-10-15 定的上限）⇒ 最多 32 次 */
export const MAX_SESSION_MS = 8 * 60 * 60_000
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
 * 下一轮的时刻：**对齐 15m 收线 + 20 秒**。
 *
 * 为什么对齐：喂给 AI 的行情是"截止最后一根**已收盘** K 线"，对齐之后每一轮的输入都是
 * 刚收线那根，同一会话里各轮的输入口径一致（可横向比）；不对齐会出现"这一轮用了 3 分钟前
 * 收的那根、下一轮用了刚收的"，结论没法比。
 * 为什么 +20 秒：给 K 线底座（`kline-recorder`）一点落库时间，别抢在它前面。
 */
export function nextRunAt(from: number = Date.now()): Date {
  const step = RUN_INTERVAL_MS
  const aligned = Math.floor((from + 20_000) / step) * step
  const at = aligned > from ? aligned : aligned + step
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
      nextRunAt(startedAt),
      new Date(startedAt + MAX_SESSION_MS)
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
}): Promise<'ok' | 'paused'> {
  const paused = input.failed >= MAX_CONSECUTIVE_FAILURES
  await query(
    `UPDATE persist_sessions
        SET failed = $2, next_at = $3, updated_at = now()
            ${paused ? ", status = 'ended', ended_reason = '连续失败自动停', ended_at = now()" : ''}
      WHERE id = $1`,
    [input.id, input.failed, nextRunAt()]
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

/** 到点自动结束（调度器每个 tick 顺手收一批 8h 到期的） */
export async function expireSessions(): Promise<number> {
  const rows = await query<{id: string}>(
    `UPDATE persist_sessions
        SET status = 'ended', ended_reason = '满 8 小时', ended_at = now(), updated_at = now()
      WHERE status = 'active' AND ends_at <= now()
      RETURNING id`
  )
  return rows.length
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
  /** 这一条之后的价格变化（+1h / +4h，%）：复盘用，取不到是 null */
  after1h: number | null
  after4h: number | null
}

/**
 * 一个会话的**结论时间线**。
 *
 * 直接读 `analyses`（`source='persist'` 且在这一会话的时间窗里）—— 不另建映射表：
 * 每条结论都已经落在那儿了（含当时价格），复制一份只会两边不同步。
 *
 * 后验涨跌（+1h / +4h）现算：拿那个币在 `analyses.created_at + 1h/4h` 之后第一根 1h 的收盘价
 * 跟这条记录的 `price` 比。⚠️ 未来的那几根还没发生 ⇒ 就是 null（页面上显示「—」）。
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
    a1: string | null
    a4: string | null
  }>(
    `SELECT a.id, a.created_at, a.grade_reason, a.price, a.cost_usd,
            (SELECT f.close FROM candles f
              WHERE f.exchange = a.exchange AND f.market_type = a.market_type
                AND f.interval = '1h' AND f.symbol = a.ccxt_symbol
                AND f.open_time >= a.created_at + interval '1 hour'
              ORDER BY f.open_time LIMIT 1) AS a1,
            (SELECT f.close FROM candles f
              WHERE f.exchange = a.exchange AND f.market_type = a.market_type
                AND f.interval = '1h' AND f.symbol = a.ccxt_symbol
                AND f.open_time >= a.created_at + interval '4 hours'
              ORDER BY f.open_time LIMIT 1) AS a4
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
        after1h: chg(r.a1),
        after4h: chg(r.a4)
      }
    })
    .reverse()
}

