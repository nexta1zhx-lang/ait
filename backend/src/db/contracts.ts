import {query, queryOne} from './client'
import type {ContractInfo, ContractStore} from '../contracts'

/**
 * 币种表（合约清单）整份存在 `contract_store` 的单行里（id = 1）。
 *
 * 为什么不做成「一行一个合约」：这里只有**整体读 / 整体换**的需求
 * （前端要的是完整下拉列表），没有按行查的场景。整份存一个 JSONB 最省事，
 * 也不会读到半新半旧的清单。
 */

interface Row {
  exchange: string
  market_type: string
  source: string
  count: number
  contracts: ContractInfo[]
  updated_at: Date | string
}

export interface StoredContracts {
  store: ContractStore
  /** 上次刷新时间（用来判断要不要再刷） */
  updatedAt: Date
}

/** 读整份币种表；库里还没有 / 是空的 → null（调用方回退本地文件） */
export async function loadContractStore(): Promise<StoredContracts | null> {
  const r = await queryOne<Row>(
    `SELECT exchange, market_type, source, count, contracts, updated_at
       FROM contract_store
      WHERE id = 1`
  )
  if (!r || !Array.isArray(r.contracts) || r.contracts.length === 0) return null
  const updatedAt = new Date(r.updated_at)
  return {
    store: {
      exchange: r.exchange,
      marketType: r.market_type as ContractStore['marketType'],
      updatedAt: updatedAt.toISOString(),
      source: r.source,
      count: Number(r.count) || r.contracts.length,
      contracts: r.contracts
    },
    updatedAt
  }
}

/**
 * 整份覆盖（upsert）—— 拉取成功后调用。
 *
 * ⚠️ `at` 是「这份数据是什么时候拉的」：从本地文件首次灌库时要传**文件自己的时间**，
 * 否则会被当成「刚更新」，接下来 24 小时不会再联网刷（踩过）。
 */
export async function saveContractStore(
  store: ContractStore,
  at?: Date
): Promise<void> {
  await query(
    `INSERT INTO contract_store
       (id, exchange, market_type, source, count, contracts, updated_at)
     VALUES (1, $1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()))
     ON CONFLICT (id) DO UPDATE
        SET exchange    = EXCLUDED.exchange,
            market_type = EXCLUDED.market_type,
            source      = EXCLUDED.source,
            count       = EXCLUDED.count,
            contracts   = EXCLUDED.contracts,
            updated_at  = EXCLUDED.updated_at`,
    [
      store.exchange,
      store.marketType,
      store.source,
      store.count,
      JSON.stringify(store.contracts),
      at ? at.toISOString() : null
    ]
  )
}
