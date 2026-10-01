#!/usr/bin/env node
/**
 * 收录一个案例进知识库（网页「知识库」页签是同一个链路）。
 *
 *   npm run learn -- MAGMA 4h --do "回调不破，右侧进的"
 *   npm run learn -- ROBO 1h --dont "突破一点后续没力量"
 *   npm run learn -- MAGMA 4h --do "..." --from 2026-09-01 --to 2026-09-15
 *   npm run learn -- MAGMA 4h --do "..." --dry-run   只预览不落库
 */
import {checkDb, dbHelpMessage, ensureSchema} from '../db/client'
import {collectCase} from '../knowledge-service'
import {Timeframe} from '../types'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function parseDate(s: string): number {
  const t = Date.parse(s)
  if (!Number.isFinite(t))
    throw new Error(`看不懂的时间：${s}（用 2026-09-01 这种格式）`)
  return t
}

const fmt = (n: number, d = 4) =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', {maximumFractionDigits: d})
    : '—'

const bj = (v: string | number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date(v))
    .replace(',', '')

async function main(): Promise<void> {
  await ensureSchema().catch(e => {
    console.error('❌ ' + dbHelpMessage(e))
    process.exitCode = 1
    throw new Error('__exit__')
  })
  const db = await checkDb()
  if (!db.ok) throw new Error(dbHelpMessage({message: db.error}))

  const symbol = process.argv[2]
  const tf = (process.argv[3] ?? '4h') as Timeframe
  if (!symbol || symbol.startsWith('--')) {
    console.log('用法：')
    console.log('  npm run learn -- MAGMA 4h --do "回调不破，右侧进的"')
    console.log('  npm run learn -- ROBO 1h --dont "突破一点后续没力量"')
    console.log('')
    console.log('参数：')
    console.log('  --do / --dont   这是我该做的 / 这是我不该做的（二选一）')
    console.log('  --from --to     只看这段时间（可选，默认最近 500 根）')
    console.log('  --dry-run       只预览不落库')
    process.exitCode = 1
    return
  }

  const doNote = arg('--do')
  const dontNote = arg('--dont')
  if (doNote === undefined && dontNote === undefined) {
    throw new Error('必须写 --do 或 --dont 来标注这个案例')
  }
  const label = doNote !== undefined ? 'do' : 'dont'
  const note = doNote ?? dontNote ?? ''

  const from = arg('--from')
  const to = arg('--to')
  const dryRun = process.argv.includes('--dry-run')

  console.log(
    `• ${symbol} ${tf}  ${label === 'do' ? '✅ 我该做的' : '❌ 我不该做的'}`
  )
  if (from && to) console.log(`• 时间段 ${from} → ${to}`)
  console.log('• 拉行情 + 找拉升段 ...')

  const r = await collectCase({
    symbol,
    timeframe: tf,
    label,
    note,
    from: from && to ? parseDate(from) : undefined,
    to: from && to ? parseDate(to) : undefined,
    dryRun
  })

  console.log(`• 模型: ${r.meta.model}`)
  if (r.meta.warning) console.log(`  ⚠️  ${r.meta.warning}`)

  console.log('')
  console.log('=== 判档 ===')
  console.log(`  ${r.grade} 档   ${r.title}`)

  console.log('')
  console.log('=== 找到的拉升段 ===')
  console.log(`  涨幅      ${fmt(r.rallyMeta.changePct, 2)}%`)
  console.log(`  根数      ${r.rallyMeta.bars}`)
  console.log(`  力度      ${fmt(r.rallyMeta.atrMultiple, 2)} × ATR`)
  console.log(
    `  量能      ${r.rallyMeta.volMultiple === null ? '—' : fmt(r.rallyMeta.volMultiple, 2) + ' 倍'}`
  )

  console.log('')
  console.log('=== 入库窗口（拉升前后两段）===')
  console.log(
    `  ${bj(r.window.start)} → ${bj(r.window.end)}  共 ${r.window.bars} 根`
  )
  console.log(`  ├ 前段 ${r.rallyFrom} 根（拉升前）`)
  console.log(`  ├ 拉升 第 ${r.rallyFrom}~${r.rallyTo} 根`)
  console.log(`  └ 后段 ${r.window.bars - r.rallyTo - 1} 根（拉升后）`)

  console.log('')
  console.log('=== AI 提炼 ===')
  if (r.features.pre) console.log(`拉升前：${r.features.pre}`)
  if (r.features.rally) console.log(`拉升：  ${r.features.rally}`)
  if (r.features.post) console.log(`拉升后：${r.features.post}`)
  if (r.whatWorked) console.log(`\n我的对错：${r.whatWorked}`)
  console.log('')
  console.log(`★ 经验：${r.lesson}`)

  console.log('')
  console.log(r.caseId ? `✓ 已入库（案例 #${r.caseId}）` : '• dry-run，未入库')
}

main().catch(e => {
  if ((e as Error).message === '__exit__') return
  console.error(`\n❌ ${(e as Error).message}`)
  process.exitCode = 1
})
