import fs from 'node:fs'
import path from 'node:path'
import {ROOT_DIR} from './config'
import {loadContractStore, saveContractStore} from './db/contracts'
import {MarketType} from './types'

/** 单个合约信息 */
export interface ContractInfo {
  /** 交易所原始符号，如 BTCUSDT */
  symbol: string
  /** 基础币种，如 BTC */
  base: string
  /** 计价币种，如 USDT */
  quote: string
  /** CCXT 统一符号，如 BTC/USDT:USDT */
  ccxt: string
  /** 展示用，如 BTC/USDT */
  display: string
  contractType: string
  status: string
}

export interface ContractStore {
  exchange: string
  marketType: MarketType
  updatedAt: string
  source: string
  count: number
  contracts: ContractInfo[]
}

export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const CONTRACTS_FILE = path.join(DATA_DIR, 'contracts.json')

/** Binance U 本位合约接口 */
const FAPI_BASE = process.env.FAPI_BASE ?? 'https://fapi.binance.com'

/** 从币安拉取全部 U 本位永续合约（交易中） */
export async function fetchBinanceContracts(): Promise<ContractStore> {
  const url = `${FAPI_BASE}/fapi/v1/exchangeInfo`
  const res = await fetch(url, {
    headers: {'User-Agent': 'crypto-entry-advisor'}
  })
  if (!res.ok) throw new Error(`请求 ${url} 返回 HTTP ${res.status}`)
  const json = (await res.json()) as {symbols?: Array<Record<string, unknown>>}

  const contracts: ContractInfo[] = (json.symbols ?? [])
    .filter(
      s =>
        s.contractType === 'PERPETUAL' &&
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT'
    )
    .map(s => {
      const base = String(s.baseAsset)
      const quote = String(s.quoteAsset)
      const settle = String(s.marginAsset ?? quote)
      return {
        symbol: String(s.symbol),
        base,
        quote,
        ccxt: `${base}/${quote}:${settle}`,
        display: `${base}/${quote}`,
        contractType: String(s.contractType),
        status: String(s.status)
      }
    })
    .sort((a, b) => a.display.localeCompare(b.display))

  return {
    exchange: 'binance',
    marketType: 'swap',
    updatedAt: new Date().toISOString(),
    source: url,
    count: contracts.length,
    contracts
  }
}

export function saveContracts(store: ContractStore): string {
  fs.mkdirSync(DATA_DIR, {recursive: true})
  fs.writeFileSync(CONTRACTS_FILE, JSON.stringify(store, null, 2), 'utf8')
  return CONTRACTS_FILE
}

export function loadContractsFromFile(): ContractStore | null {
  try {
    if (!fs.existsSync(CONTRACTS_FILE)) return null
    const parsed = JSON.parse(
      fs.readFileSync(CONTRACTS_FILE, 'utf8')
    ) as ContractStore
    if (!parsed || !Array.isArray(parsed.contracts)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 读币种表：**数据库优先**，库里还没有（新装 / 迁移中）就退回本地 JSON 文件。
 *
 * ⚠️ 2026-10-03 起改了：以前只读 `data/contracts.json`（要手动 `npm run sync:contracts`
 * 才会更新，新上币看不到）。现在存库、并由服务每天自动刷（见 `ensureContractsFresh`）。
 * 这个函数改成 async，调用点都要 await。
 */
export async function loadContracts(): Promise<ContractStore | null> {
  try {
    const stored = await loadContractStore()
    if (stored) return stored.store
  } catch (e) {
    console.warn(
      '[contracts] 读数据库失败，回退本地文件:',
      (e as Error).message
    )
  }
  return loadContractsFromFile()
}

/** 拉一次币安 + 落库 + 顺手写一份本地文件（离线时还能兜底） */
export async function refreshContracts(): Promise<ContractStore> {
  const store = await fetchBinanceContracts()
  await saveContractStore(store)
  try {
    saveContracts(store)
  } catch (e) {
    console.warn(
      '[contracts] 写本地文件失败（不影响使用）:',
      (e as Error).message
    )
  }
  return store
}

/** 超过这个时间就认为该刷新了（用户要求「每天更新防止上新币」） */
export const CONTRACTS_MAX_AGE_MS = 24 * 3600_000

export interface ContractsFreshness {
  /** 这次真的联网刷了吗 */
  refreshed: boolean
  /** 当前有多少个合约 */
  count: number
  /** 说人话的原因（打日志用） */
  reason: string
}

/**
 * 保证币种表是新的：
 *   1. 库里已有、且没超过 maxAgeMs → 什么都不做
 *   2. 库里没有，但本地有 `data/contracts.json` → **先灌进库**（不联网）
 *   3. 过旧 / 没有 → 联网刷一次；失败就保留旧数据（只告警，不影响服务）
 */
export async function ensureContractsFresh(
  maxAgeMs = CONTRACTS_MAX_AGE_MS
): Promise<ContractsFreshness> {
  let stored = await loadContractStore().catch(() => null)

  // 2) 库里空的：把本地文件灌进去，先让服务有得用
  if (!stored) {
    const file = loadContractsFromFile()
    if (file) {
      // ⚠️ 带文件自己的时间：塞进去的是旧数据，接下来该刷还是要刷
      const at = new Date(file.updatedAt)
      await saveContractStore(file, Number.isNaN(at.getTime()) ? undefined : at)
      stored = await loadContractStore().catch(() => null)
      if (stored) {
        console.log(`  币种表  首次导入本地文件：${stored.store.count} 个`)
      }
    }
  }

  const ageMs = stored ? Date.now() - stored.updatedAt.getTime() : Infinity
  if (stored && ageMs < maxAgeMs) {
    return {
      refreshed: false,
      count: stored.store.count,
      reason: `数据库里是新的（${Math.round(ageMs / 3600_000)} 小时前）`
    }
  }

  // 3) 该刷了
  try {
    const store = await refreshContracts()
    return {
      refreshed: true,
      count: store.count,
      reason: stored
        ? `已自动刷新（上次 ${Math.round(ageMs / 3600_000)} 小时前）`
        : '已自动刷新（库里原来没有）'
    }
  } catch (e) {
    if (stored) {
      return {
        refreshed: false,
        count: stored.store.count,
        reason: `刷新失败（继续用旧的 ${stored.store.count} 个）：${(e as Error).message}`
      }
    }
    throw e
  }
}
