#!/usr/bin/env node
/**
 * 历史分析。
 *
 *   npm run history                   最近 20 条
 *   npm run history -- --symbol BTC   只看某个币
 *   npm run history -- --go           只看「可做」的（go）
 *   npm run history -- --stats        标签分布（按形状标签统计）
 *   npm run history -- --grade A      只看**老记录**的 A 档 ——
 *                                     2026-10-02 起不再判档，新记录没有档位
 *   npm run history -- 12             看第 12 条的完整详情
 *
 * 通用筛选：--days N（默认 365）· --limit N（默认 20）· --offset N
 *
 * 2026-10-02 大简化之后，AI 只回 6 个字段（标签 + 概率 / 理由 / 走势 /
 * 走势概率 / 结论 / 推荐），所以这里不再有 计划 / 止损止盈 / 仓位 / 护栏 /
 * 清单 / 结算与 R 倍数。
 */
import {analysisStats, getAnalysis, listAnalyses} from '../db/analyses'
import {defaultUserId} from '../db/users'
import {dbHelpMessage, ensureSchema} from '../db/client'
import {formatCny as cny, formatUsd as usd} from '../llm/pricing'

/** 只有真的是连不上库才给「检查 Docker」的提示，其它错误原样吐出来 */
function fail(e: unknown): void {
  const m = (e as Error)?.message ?? String(e)
  if (/ECONNREFUSED|password|does not exist|ENOTFOUND|ETIMEDOUT/i.test(m))
    console.error('❌ ' + dbHelpMessage(e))
  else console.error('❌ ' + m)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(name)

const pad = (s: string, n: number) => {
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1
  return s + ' '.repeat(Math.max(0, n - w))
}
const rpad = (s: string, n: number) => {
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1
  return ' '.repeat(Math.max(0, n - w)) + s
}

/** 北京时间 MM-DD HH:mm */
function bj(iso: string): string {
  const d = new Date(iso)
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d))
    p[x.type] = x.value
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

const VERDICT_TEXT: Record<string, string> = {
  go: '✅可做',
  wait: '⏸观望',
  no_go: '⛔不做'
}

const f = (n: number | null | undefined, d = 4) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-US', {maximumFractionDigits: d})

/* ------------------------------------------------------------------ */

async function showList(o: {
  grade?: string
  symbol?: string
  go: boolean
  limit: number
  offset: number
}) {
  const {rows, total} = await listAnalyses({
    userId: await defaultUserId().catch(() => null),
    grade: o.grade,
    symbol: o.symbol,
    actionableOnly: o.go,
    limit: o.limit,
    offset: o.offset
  })

  if (!rows.length) {
    console.log('\n还没有记录。跑一次分析就会有：npm run dev -- BTC/USDT\n')
    return
  }

  console.log('')
  console.log(
    `   ${pad('时间', 14)}${pad('币种', 10)}${pad('标签', 34)}${pad('结论', 12)}`
  )
  for (const r of rows) {
    // 标签按概率从高到低，这里只印前两个，够认出形状了
    // （老记录存的是纯字符串，没概率）
    const tags =
      r.tags
        .slice(0, 2)
        .map(t => (typeof t === 'string' ? t : `${t.name} ${t.probability}%`))
        .join(' / ') || '—'
    console.log(
      `   ${pad(bj(r.createdAt), 14)}${pad(r.symbol, 10)}${pad(tags, 34)}${pad(
        VERDICT_TEXT[r.verdict ?? ''] ?? r.verdict ?? '—',
        12
      )}`
    )
  }

  console.log('')
  console.log(
    `   共 ${total} 条，显示第 ${o.offset + 1}~${o.offset + rows.length} 条` +
      (total > o.offset + rows.length
        ? `（下一页：--offset ${o.offset + o.limit}）`
        : '')
  )
  console.log('   看详情：npm run history -- <id>')
  console.log('')
}

async function showDetail(id: number) {
  const a = await getAnalysis(id, await defaultUserId().catch(() => null))
  if (!a) {
    console.error(`❌ 没有 id=${id} 的记录`)
    process.exitCode = 1
    return
  }

  const r = a.result ?? ({} as NonNullable<typeof a.result>)
  const L: string[] = []
  L.push('')
  L.push(`=== #${a.id}  ${a.symbol}  ${bj(a.createdAt)}（北京时间）===`)
  L.push('')
  L.push(`判档      ${a.grade ?? '—'}`)
  L.push(`结论      ${VERDICT_TEXT[a.verdict ?? ''] ?? a.verdict ?? '—'}`)
  if (r.tags?.length) L.push(`标签      ${r.tags.join(' / ')}`)
  if (r.reason) L.push(`理由      ${r.reason}`)
  L.push('')
  const days = (a.meta as {days?: number})?.days
  L.push(
    `行情      现价 ${f(a.price)}   周期 ${a.timeframes.join(',')}` +
      (days ? `   回溯 ${days} 天` : '')
  )
  L.push('')
  L.push(
    `成本      ${cny(a.costUsd ?? 0)}（${usd(a.costUsd ?? 0)}）   ${
      a.promptTokens ?? 0
    } + ${a.completionTokens ?? 0} tok   ${a.latencyMs ?? 0}ms`
  )
  L.push(`模型      ${a.model ?? '—'}`)
  if (a.rulesHash) {
    L.push(
      `规则      ${a.rulesHash}${a.rules ? `（${a.rules.sources.join('、')}）` : ''}`
    )
  }
  L.push('')

  process.stdout.write(L.join('\n'))
}

async function showStats(days: number) {
  const s = await analysisStats(days, await defaultUserId().catch(() => null))

  console.log('')
  console.log(`=== 标签分布（最近 ${days} 天）===`)
  console.log('')
  console.log(`总记录    ${s.total} 条`)
  console.log(`花费      ${cny(s.costUsd)}（${usd(s.costUsd)}）`)
  console.log('')

  if (!s.byTag.length) {
    console.log('（还没有记录）')
    console.log('')
    return
  }

  console.log(`   ${pad('标签', 14)}${rpad('次数', 6)}${rpad('平均概率', 9)}`)
  for (const t of s.byTag) {
    console.log(
      `   ${pad(t.name, 14)}${rpad(String(t.calls), 6)}${rpad(
        t.avgProbability === null ? '—' : `${t.avgProbability}%`,
        9
      )}`
    )
  }
  console.log('')

  if (s.bySymbol.length) {
    console.log('按币种（做最多的在前）')
    for (const x of s.bySymbol.slice(0, 10)) {
      console.log(`   ${pad(x.symbol, 12)}${rpad(String(x.calls), 6)} 次`)
    }
    console.log('')
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await ensureSchema()

  const days = Number(arg('--days')) || 365
  if (has('--stats')) return showStats(days)

  // 纯数字 = 看详情
  const idArg = process.argv[2]
  if (idArg && /^\d+$/.test(idArg)) return showDetail(Number(idArg))

  return showList({
    grade: arg('--grade'),
    symbol: arg('--symbol'),
    go: has('--go'),
    limit: Number(arg('--limit')) || 20,
    offset: Number(arg('--offset')) || 0
  })
}

main().catch(e => {
  fail(e)
  process.exitCode = 1
})
