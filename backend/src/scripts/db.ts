#!/usr/bin/env node
/**
 * 数据库维护。
 *
 *   npm run db:status       连接状态 + 各表条数
 *   npm run db:reset -- --yes  清空数据
 */
import {checkDb, dbHelpMessage, ensureSchema, query} from '../db/client'

async function status(): Promise<void> {
  const db = await checkDb()
  if (!db.ok) {
    console.error('❌ ' + dbHelpMessage({message: db.error}))
    process.exitCode = 1
    return
  }
  const labels: Record<string, string> = {
    knowledge: '知识库案例',
    analyses: '分析记录',
    llm_usage: 'API 调用记录'
  }
  console.log('=== 数据库状态 ===\n')
  console.log(`连接        ${db.version}`)
  console.log('')
  for (const [t, n] of Object.entries(db.counts ?? {})) {
    console.log(
      `  ${(labels[t] ?? t).padEnd(12, '　')} ${n < 0 ? '（表不存在）' : n}`
    )
  }

  const byGrade = await query<{label: string; n: string}>(
    'SELECT label, count(*)::text AS n FROM knowledge GROUP BY label'
  ).catch(() => [])
  if (byGrade.length) {
    console.log('\n  知识库明细：')
    for (const r of byGrade) {
      console.log(`    ${r.label === 'do' ? '我该做的' : '我不该做的'}  ${r.n}`)
    }
  }
  console.log('')
  console.log('提示：')
  console.log('  npm run web          启动网页')
  console.log('  npm run cost         看 API 用量与花费')
  console.log('  npm run swing -- BTC 4h   测试拉升检测')
}

async function reset(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.log('这会清空「知识库」「分析记录」和「API 用量记录」。')
    console.log('确认请加 --yes：npm run db:reset -- --yes')
    process.exitCode = 1
    return
  }
  const db = await checkDb()
  if (!db.ok) throw new Error(dbHelpMessage({message: db.error}))
  await query('TRUNCATE knowledge, analyses, llm_usage RESTART IDENTITY')
  console.log('✓ 已清空。')
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status'
  if (cmd !== 'reset') {
    try {
      await ensureSchema()
    } catch (e) {
      console.error('❌ ' + dbHelpMessage(e))
      process.exitCode = 1
      return
    }
  }
  if (cmd === 'status') return status()
  if (cmd === 'reset') return reset()
  console.log('用法：npm run db:status | npm run db:reset -- --yes')
  process.exitCode = 1
}

main().catch(e => {
  console.error(`\n❌ ${(e as Error).message}`)
  process.exitCode = 1
})
