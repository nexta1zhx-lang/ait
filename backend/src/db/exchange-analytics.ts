import {query, queryOne} from './client'

export interface C2cOrderInput {
  orderId: string
  side: 'Buy' | 'Sell'
  asset: 'USDT'
  fiat: string
  fiatTotal: number
  price: number
  quantity: number
  timestamp: string
}

export interface AnalyticsRange {
  from?: number | null
  to?: number | null
}

export interface ExchangeAnalytics {
  capital: {
    orders: number
    depositsUsdt: number
    withdrawalsUsdt: number
    netUsdt: number
    depositsCny: number
    withdrawalsCny: number
  }
}

export interface C2cHistoryOrder {
  orderId: string
  side: 'Buy' | 'Sell'
  asset: 'USDT'
  fiat: string
  fiatTotal: number
  price: number
  quantity: number
  timestamp: string
}

export interface C2cHistoryPage {
  orders: C2cHistoryOrder[]
  page: number
  pageSize: number
  total: number
}

function numberOf(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export async function listC2cOrderHistory(
  userId: number,
  keyId: number,
  page = 1,
  pageSize = 20
): Promise<C2cHistoryPage> {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize)))
  const offset = (safePage - 1) * safePageSize
  const [rows, countRows] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT order_id, side, asset, fiat, fiat_total, price, quantity, ts
         FROM exchange_c2c_orders
        WHERE user_id = $1 AND key_id = $2
        ORDER BY ts DESC, id DESC
        LIMIT $3 OFFSET $4`,
      [userId, keyId, safePageSize, offset]
    ),
    query<Record<string, unknown>>(
      `SELECT count(*) AS total
         FROM exchange_c2c_orders
        WHERE user_id = $1 AND key_id = $2`,
      [userId, keyId]
    )
  ])
  return {
    orders: rows.map(row => ({
      orderId: String(row.order_id ?? ''),
      side: row.side === 'Sell' ? 'Sell' : 'Buy',
      asset: 'USDT',
      fiat: String(row.fiat ?? ''),
      fiatTotal: numberOf(row.fiat_total),
      price: numberOf(row.price),
      quantity: numberOf(row.quantity),
      timestamp: row.ts instanceof Date ? row.ts.toISOString() : new Date(String(row.ts)).toISOString()
    })),
    page: safePage,
    pageSize: safePageSize,
    total: numberOf(countRows[0]?.total)
  }
}

export async function latestC2cOrderTimestamp(
  userId: number,
  keyId: number
): Promise<number | null> {
  const row = await queryOne<{latest_ts: Date | string | null}>(
    `SELECT max(ts) AS latest_ts
       FROM exchange_c2c_orders
      WHERE user_id = $1 AND key_id = $2`,
    [userId, keyId]
  )
  if (row?.latest_ts == null) return null
  const timestamp = row.latest_ts instanceof Date
    ? row.latest_ts.getTime()
    : Date.parse(row.latest_ts)
  if (!Number.isFinite(timestamp)) {
    throw new Error('本地 C2C 订单的时间格式无效')
  }
  return timestamp
}

/** Save imported orders idempotently; re-importing the same export is safe. */
export async function importC2cOrders(
  userId: number,
  keyId: number,
  orders: C2cOrderInput[]
): Promise<number> {
  let inserted = 0
  const chunkSize = 500

  for (let start = 0; start < orders.length; start += chunkSize) {
    const chunk = orders.slice(start, start + chunkSize)
    const values: unknown[] = []
    const placeholders = chunk.map((order, index) => {
      const offset = index * 10
      values.push(
        userId,
        keyId,
        order.orderId,
        order.side,
        order.asset,
        order.fiat,
        order.fiatTotal,
        order.price,
        order.quantity,
        new Date(order.timestamp)
      )
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4},
        $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8},
        $${offset + 9}, $${offset + 10})`
    })
    const rows = await query<{order_id: string}>(
      `INSERT INTO exchange_c2c_orders
         (user_id, key_id, order_id, side, asset, fiat, fiat_total, price, quantity, ts)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (key_id, order_id) DO NOTHING
       RETURNING order_id`,
      values
    )
    inserted += rows.length
  }
  return inserted
}

export async function exchangeAnalytics(
  userId: number,
  keyId: number,
  range: AnalyticsRange = {}
): Promise<ExchangeAnalytics> {
  const from = Math.round(Number(range.from ?? 0)) || null
  const to = Math.round(Number(range.to ?? 0)) || null
  const params = [userId, keyId, from, to]
  const whereRange = `
    AND ($3::bigint IS NULL OR ts >= to_timestamp($3::bigint / 1000.0))
    AND ($4::bigint IS NULL OR ts <= to_timestamp($4::bigint / 1000.0))`

  const [capitalRows] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT count(*) AS orders,
         COALESCE(sum(quantity) FILTER (WHERE side = 'Buy'), 0) AS deposits_usdt,
         COALESCE(sum(quantity) FILTER (WHERE side = 'Sell'), 0) AS withdrawals_usdt,
         COALESCE(sum(fiat_total) FILTER (WHERE side = 'Buy' AND fiat = 'CNY'), 0) AS deposits_cny,
         COALESCE(sum(fiat_total) FILTER (WHERE side = 'Sell' AND fiat = 'CNY'), 0) AS withdrawals_cny
       FROM exchange_c2c_orders
       WHERE user_id = $1 AND key_id = $2 ${whereRange}`,
      params
    )
  ])

  const capital = capitalRows[0] ?? {}
  const depositsUsdt = numberOf(capital.deposits_usdt)
  const withdrawalsUsdt = numberOf(capital.withdrawals_usdt)

  return {
    capital: {
      orders: numberOf(capital.orders),
      depositsUsdt,
      withdrawalsUsdt,
      netUsdt: depositsUsdt - withdrawalsUsdt,
      depositsCny: numberOf(capital.deposits_cny),
      withdrawalsCny: numberOf(capital.withdrawals_cny)
    }
  }
}
