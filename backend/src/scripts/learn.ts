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

const MOVE_TEXT: Record<string, string> = {
  up: '拉升',
  down: '下跌',
  range: '横盘'
}

const fmt = (n: number | undefined, d = 4) =>
  typeof n === 'number' && Number.isFinite(n)
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
    console.log('  npm run learn -- MAGMA 4h --note "回调不破，右侧进的"')
    console.log('  npm run learn -- ROBO 1h --from 2026-09-01 --to 2026-09-05')
    console.log('')
    console.log('参数：')
    console.log('  --note          我的一句备注（可选）')
    console.log('  --from --to     只看这段时间（可选，默认最近 500 根）')
    console.log('  --exact         区间原样用，前后不补（配合 --from/--to）')
    console.log('  --dry-run       只预览不落库')
    process.exitCode = 1
    return
  }

  const note = arg('--note') ?? ''

  const from = arg('--from')
  const to = arg('--to')
  const dryRun = process.argv.includes('--dry-run')
  const exact = process.argv.includes('--exact')

  console.log(`• ${symbol} ${tf}`)
  if (from && to) console.log(`• 时间段 ${from} → ${to}`)
  console.log('• 拉行情 + 算大周期压力支撑 ...')

  const r = await collectCase({
    symbol,
    timeframe: tf,
    note,
    from: from && to ? parseDate(from) : undefined,
    to: from && to ? parseDate(to) : undefined,
    exact,
    dryRun,
    onStep: s => {
      console.log(
        `  ${s.state === 'running' ? '◌' : s.state === 'done' ? '●' : '✕'} ${
          s.label
        }${s.detail ? `  ${s.detail}` : ''}${s.ms ? `  ${s.ms}ms` : ''}`
      )
    }
  })

  console.log(`• 模型: ${r.meta.model}`)
  if (r.meta.warning) console.log(`  ⚠️  ${r.meta.warning}`)

  console.log('')
  console.log('=== 这段行情是什么 ===')
  console.log(`  ${MOVE_TEXT[r.moveType] ?? r.moveType}   ${r.title}`)
  if (r.tags.length) console.log(`  标签      ${r.tags.join(' · ')}`)

  console.log('')
  console.log('=== 客观统计 ===')
  console.log(`  涨跌幅    ${fmt(r.stats.changePct, 2)}%`)
  console.log(`  振幅      ${fmt(r.stats.rangePct, 2)}%`)
  console.log(`  最大回撤  -${fmt(r.stats.maxDrawdownPct, 2)}%`)
  console.log(
    `  最高/最低 在整段 ${r.stats.highAtPct}% / ${r.stats.lowAtPct}% 处`
  )
  console.log(
    `  量能趋势  ${
      r.stats.volTrend === null || r.stats.volTrend === undefined
        ? '—'
        : fmt(r.stats.volTrend, 2) + ' 倍（后半段/前半段）'
    }`
  )

  console.log('')
  console.log('=== 入库窗口 ===')
  console.log(
    `  ${bj(r.window.start)} → ${bj(r.window.end)}  共 ${r.window.bars} 根`
  )
  console.log(`  （一共拉了 ${r.candleCount} 根）`)

  console.log('')
  console.log('=== AI 提炼 ===')
  if (r.meta.sr.length) {
    console.log(
      `大周期压力支撑：${r.meta.sr
        .map(x => `${x.timeframe} ${x.support}~${x.resistance}`)
        .join('  ')}`
    )
  }
  if (r.why) console.log(`为什么会这样走：\n${r.why}`)
  if (r.features.structure) console.log(`\n结构：${r.features.structure}`)
  if (r.features.volume) console.log(`量能：${r.features.volume}`)
  if (r.features.rhythm) console.log(`节奏：${r.features.rhythm}`)
  console.log('')
  console.log(`★ 经验：${r.lesson}`)
  if (r.tags.length) console.log(`★ 标签：${r.tags.join(' · ')}`)

  console.log('')
  console.log(r.caseId ? `✓ 已入库（案例 #${r.caseId}）` : '• dry-run，未入库')
}

main().catch(e => {
  if ((e as Error).message === '__exit__') return
  console.error(`\n❌ ${(e as Error).message}`)
  process.exitCode = 1
})
