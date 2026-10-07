#!/usr/bin/env node
/**
 * 临时探针（跑完就删）：验证合约发现要用的那两个接口在本环境到底通不通。
 *   ① ccxt 隐式接口 `fapiPublicGetExchangeInfo`（走 EXCHANGE_PROXY，跟其它调用同一条路）
 *   ② 裸 fetch（contracts.ts 用的那条路，本地可能不通）
 */
import {loadConfig} from '../config'
import {fetchExchangeInfoRaw, listPerpetualSymbols, planContractChanges} from '../data/market'
import {closePool} from '../db/client'
import {fetchBinanceContracts} from '../contracts'

async function main(): Promise<void> {
  const c = loadConfig()
  console.log('config:', {exchange: c.exchange, marketType: c.marketType, apiBase: c.apiBase})

  try {
    const raw = await fetchExchangeInfoRaw({exchangeId: c.exchange, apiBase: c.apiBase})
    console.log(`① fetchExchangeInfoRaw ✓ 合约 ${raw.length} 个`)
    const st: Record<string, number> = {}
    for (const s of raw) st[s.status] = (st[s.status] ?? 0) + 1
    console.log('   status 分布:', st)
    console.log('   样例:', raw[0])
    const newest = raw.filter(r => r.status === 'TRADING' && r.onboardAt).sort((a, b) => b.onboardAt! - a.onboardAt!).slice(0, 3)
    console.log('   最近上线:', newest.map(r => `${r.pair} ${new Date(r.onboardAt!).toISOString()}`).join(' / '))
    const cur = await listPerpetualSymbols({exchangeId: c.exchange, apiBase: c.apiBase})
    const {add, drop} = planContractChanges(raw, cur)
    console.log(`   diff：现在订阅 ${cur.length} 个 → 该加 ${add.length}，该摘 ${drop.length}`)
    if (add.length) console.log('   该加:', add.map(a => a.pair).join(','))
    if (drop.length) console.log('   该摘:', drop.slice(0, 10).map(d => d.pair).join(','), drop.length > 10 ? '…' : '')
  } catch (e) {
    console.log('① ccxt 失败：', (e as Error).message.slice(0, 200))
  }

  try {
    const store = await fetchBinanceContracts()
    console.log(`② 裸 fetch（contracts.ts）✓ 合约 ${store.count} 个，样例 ${store.contracts[0]?.symbol}`)
  } catch (e) {
    console.log('② 裸 fetch 失败（本地正常，服务器上应该通）：', (e as Error).message.slice(0, 120))
  }
  await closePool()
}

void main()
