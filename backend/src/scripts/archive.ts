/**
 * 手动跑一次交易所快照的归档 + 清理（平时服务自己每小时跑一次）。
 *
 *   npm run archive          # 跑一轮，打印聚合 / 删除了多少行
 *
 * 用途：把保留策略改成别的天数之后想立刻生效、或者服务没开的时候想手动收拾一下。
 * 幂等 —— 连跑几次只是白扫几遍，不会算错。
 */
import {archiveExchangeSnapshots} from '../exchange-archive'
import {query} from '../db/client'

async function main(): Promise<void> {
  const before = await query<{kind: string; n: string}>(
    `SELECT kind, count(*) AS n FROM exchange_snapshots GROUP BY kind ORDER BY kind`
  )
  console.log('\n=== 归档前 ===')
  for (const r of before) console.log(`  ${r.kind.padEnd(3)} ${r.n} 行`)
  if (!before.length) console.log('  （库里还没有快照）')

  const r = await archiveExchangeSnapshots()
  console.log('\n=== 这一轮 ===')
  console.log(`  聚合出 1h ${r.to1h} 行、1d ${r.to1d} 行（已存在的桶跳过）`)
  console.log(`  清理掉 5m ${r.del5m} 行、1h ${r.del1h} 行`)

  const after = await query<{kind: string; n: string}>(
    `SELECT kind, count(*) AS n FROM exchange_snapshots GROUP BY kind ORDER BY kind`
  )
  console.log('\n=== 归档后 ===')
  for (const x of after) console.log(`  ${x.kind.padEnd(3)} ${x.n} 行`)
  console.log()
}

main().catch(e => {
  console.error(`\n❌ ${(e as Error).message}`)
  process.exitCode = 1
})
