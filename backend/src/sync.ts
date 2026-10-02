#!/usr/bin/env node
/**
 * 手动刷币种表（`npm run sync:contracts`）。
 *
 * 2026-10-03 起：正常不用手动跑 —— 服务启动时过旧会自动刷，之后每天一次。
 * 这个命令留着是为了「马上就想刷一次」或排查用。
 */
import {refreshContracts} from './contracts'
import {ensureSchema} from './db/client'

async function main(): Promise<void> {
  console.log('• 正在从币安拉取全部 U 本位永续合约 ...')
  try {
    await ensureSchema()
  } catch (e) {
    console.warn(`⚠️  数据库不可用，只写本地文件：${(e as Error).message}`)
  }
  const store = await refreshContracts()
  console.log('')
  console.log(`✅ 共 ${store.count} 个合约`)
  console.log(`   交易所: ${store.exchange} (${store.marketType})`)
  console.log(`   更新于: ${store.updatedAt}`)
  console.log(`   已写入: 数据库 contract_store + data/contracts.json`)
  console.log('')
  console.log('   网页下拉会自动读取（无需重启）。')
}

main().catch((e: Error) => {
  console.error(`❌ 失败：${e.message}`)
  process.exitCode = 1
})
