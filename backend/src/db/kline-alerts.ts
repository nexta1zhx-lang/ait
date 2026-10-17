/**
 * K 线上的**画线**与**穿线提醒**（用户 2026-10-17：「k 线界面…改为划线模式…
 * 点击画的线可以添加超过该线提醒，在自动化预测显示所有的提醒」）。
 *
 * 两张表、两种活法：
 *   · 画线（`kline_drawings`）—— 纯展示，前端整份读写（一个币一份 JSON 数组）；
 *   · 提醒（`kline_alerts`）—— **服务器盯价**（`price-alerts.ts`）：网页没开也要响，
 *     所以必须落库，不能只放浏览器。
 *
 * ⚠️ `symbol` 存的是**基础币**（`DOGE`），跟 K 线页 `analyze.ts` 的 `symbol` 同口径；
 *    币安原始交易对（`DOGEUSDT`）由盯价那边现拼 —— 两边别各存一套。
 */
import {query, queryOne} from './client'

export type AlertOp = 'above' | 'below'
export type AlertStatus = 'active' | 'triggered'

export interface KlineAlert {
  id: number
  /** 谁画的这条线（盯价那边要按这个用户发推送） */
  userId: number
  symbol: string
  price: number
  op: AlertOp
  note: string
  status: AlertStatus
  createdAt: string
  triggeredAt: string | null
  triggeredPrice: number | null
}

interface Row {
  id: string | number
  user_id: string | number
  symbol: string
  price: string | number
  op: string
  note: string | null
  status: string
  created_at: Date | string
  triggered_at: Date | string | null
  triggered_price: string | number | null
}

function iso(v: Date | string | null): string | null {
  if (!v) return null
  return v instanceof Date ? v.toISOString() : String(v)
}

function mapRow(r: Row): KlineAlert {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    symbol: r.symbol,
    price: Number(r.price),
    op: r.op === 'below' ? 'below' : 'above',
    note: r.note ?? '',
    status: r.status === 'triggered' ? 'triggered' : 'active',
    createdAt: iso(r.created_at) ?? '',
    triggeredAt: iso(r.triggered_at),
    triggeredPrice: r.triggered_price === null ? null : Number(r.triggered_price)
  }
}

/** 基础币归一（`doge` / `DOGE/USDT:USDT` / `DOGEUSDT` 都收成 `DOGE`） */
export function normalizeBase(v: unknown): string {
  let s = String(v ?? '').trim().toUpperCase()
  if (s.includes('/')) s = s.split('/')[0] ?? ''
  s = s.replace(/[^A-Z0-9]/g, '')
  if (s.endsWith('USDT') && s.length > 4) s = s.slice(0, -4)
  return s
}

/** 这个用户的所有提醒（新的在前） */
export async function listKlineAlerts(userId: number): Promise<KlineAlert[]> {
  const rows = await query<Row>(
    `SELECT id, user_id, symbol, price, op, note, status, created_at, triggered_at, triggered_price
       FROM kline_alerts WHERE user_id = $1 ORDER BY id DESC LIMIT 200`,
    [userId]
  )
  return rows.map(mapRow)
}

/**
 * 盯价用的那份清单：**所有用户**还在等的提醒。
 *
 * 一次性全捞进内存（一张表也就几百行），每穿一条就改一行 —— 不能每秒查库。
 */
export async function listActiveAlerts(): Promise<KlineAlert[]> {
  const rows = await query<Row>(
    `SELECT id, user_id, symbol, price, op, note, status, created_at, triggered_at, triggered_price
       FROM kline_alerts WHERE status = 'active' ORDER BY id ASC`
  )
  return rows.map(mapRow)
}

export async function createKlineAlert(input: {
  userId: number
  symbol: string
  price: number
  op: AlertOp
  note?: string
}): Promise<KlineAlert> {
  const row = await queryOne<Row>(
    `INSERT INTO kline_alerts (user_id, symbol, price, op, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, symbol, price, op, note, status, created_at, triggered_at, triggered_price`,
    [input.userId, input.symbol, input.price, input.op, input.note ?? '']
  )
  if (!row) throw new Error('提醒没写进去')
  return mapRow(row)
}

/** 删一条（只能删自己的） */
export async function deleteKlineAlert(userId: number, id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM kline_alerts WHERE user_id = $1 AND id = $2 RETURNING id',
    [userId, id]
  )
  return rows.length > 0
}

/**
 * 重新盯（改回 active，清掉上次触发的时间和价）。
 *
 * 用户 2026-10-17 的用法就是「这条响过了，我还想它下次再响」——
 * 有了它就不必删了重建。
 */
export async function rearmKlineAlert(userId: number, id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    `UPDATE kline_alerts
        SET status = 'active', triggered_at = NULL, triggered_price = NULL
      WHERE user_id = $1 AND id = $2
      RETURNING id`,
    [userId, id]
  )
  return rows.length > 0
}

/** 盯价那边判定了「穿线」→ 标记 + 记一笔触发价（幂等：已经是 triggered 就不再改） */
export async function markAlertTriggered(id: number, price: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    `UPDATE kline_alerts
        SET status = 'triggered', triggered_at = now(), triggered_price = $2
      WHERE id = $1 AND status = 'active'
      RETURNING id`,
    [id, price]
  )
  return rows.length > 0
}

/* ---------------- 画线（整份读写，一个币一份） ---------------- */

export async function getKlineDrawings(userId: number, symbol: string): Promise<unknown[]> {
  const row = await queryOne<{items: unknown}>(
    'SELECT items FROM kline_drawings WHERE user_id = $1 AND symbol = $2',
    [userId, symbol]
  )
  return Array.isArray(row?.items) ? (row.items as unknown[]) : []
}

export async function saveKlineDrawings(
  userId: number,
  symbol: string,
  items: unknown[]
): Promise<void> {
  await query(
    `INSERT INTO kline_drawings (user_id, symbol, items, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (user_id, symbol) DO UPDATE
        SET items = EXCLUDED.items, updated_at = now()`,
    [userId, symbol, JSON.stringify(items)]
  )
}
