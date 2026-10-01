#!/usr/bin/env node
import {fetchBinanceContracts, saveContracts} from './contracts'

async function main(): Promise<void> {
  console.log('• 正在从币安拉取全部 U 本位永续合约 ...')
  const store = await fetchBinanceContracts()
  const file = saveContracts(store)
  console.log('')
  console.log(`✅ 共 ${store.count} 个合约`)
  console.log(`   交易所: ${store.exchange} (${store.marketType})`)
  console.log(`   更新于: ${store.updatedAt}`)
  console.log(`   已保存: ${file}`)
  console.log('')
  console.log('   网页界面会自动读取该文件，可直接下拉选择合约。')
}

main().catch((e: Error) => {
  console.error(`❌ 失败：${e.message}`)
  process.exitCode = 1
})
