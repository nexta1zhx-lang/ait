import {query} from './client'

/**
 * ccxt 的 `markets`（币安 `exchangeInfo`，约 1.1MB）整份存一行。
 *
 * 整份存 JSONB 跟 `contract_store` 一个道理：只有「整体读 / 整体换」的需求，
 * 不按行查，也不会有半新半旧。key 是 `交易所|市场类型|环境`（公开数据，几套 Key 共用）。
 */
export interface StoredMarkets {
  key: string
  markets: Record<string, unknown>
  updatedAt: Date
}

interface Row {
  key: string
  markets: Record<string, unknown> | null
  updated_at: Date | string
}

export async function loadMarketsStore(): Promise<StoredMarkets[]> {
  const rows = await query<Row>(`SELECT key, markets, updated_at FROM ccxt_markets`)
  return rows
    .filter(r => r.markets && Object.keys(r.markets).length > 0)
    .map(r => ({
      key: r.key,
      markets: r.markets as Record<string, unknown>,
      updatedAt: new Date(r.updated_at)
    }))
}

/** 覆盖写（拉取成功后调用）。`count` 只为了肉眼能看出这份表有多少个合约 */
export async function saveMarketsStore(
  key: string,
  exchange: string,
  markets: Record<string, unknown>
): Promise<void> {
  await query(
    `INSERT INTO ccxt_markets (key, exchange, count, markets, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (key) DO UPDATE
        SET exchange   = EXCLUDED.exchange,
            count      = EXCLUDED.count,
            markets    = EXCLUDED.markets,
            updated_at = now()`,
    [key, exchange, Object.keys(markets).length, JSON.stringify(markets)]
  )
}
