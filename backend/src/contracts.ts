import fs from 'node:fs'
import path from 'node:path'
import {ROOT_DIR} from './config'
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

export function loadContracts(): ContractStore | null {
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
