#!/usr/bin/env node
/**
 * 历史分析。
 *
 *   npm run history                   最近 20 条
 *   npm run history -- --grade A      只看 A 档
 *   npm run history -- --symbol BTC   只看某个币
 *   npm run history -- --go           只看「可做」的
 *   npm run history -- --pending      只看还没结算的
 *   npm run history -- --stats        档位统计（A 档真的比 B 档好吗）
 *   npm run history -- 12             看第 12 条的完整详情
 */
import {
  OUTCOME_LABEL,
  analysisStats,
  getAnalysis,
  listAnalyses,
  settleAnalysis,
  type OutcomeKind
} from '../db/analyses'
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

/** 北京时间 */
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
  no_go: '⛔不可做'
}
const GRADE_CLS: Record<string, string> = {A: 'A', B: 'B', C: 'C', unclear: '?'}

const f = (n: number | null, d = 4) =>
  n === null || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-US', {maximumFractionDigits: d})

/* ------------------------------------------------------------------ */

async function showList(o: {
  grade?: string
  symbol?: string
  go: boolean
  pending: boolean
  limit: number
  offset: number
}) {
  const {rows, total} = await listAnalyses({
    grade: o.grade,
    symbol: o.symbol,
    actionableOnly: o.go,
    pendingOnly: o.pending,
    limit: o.limit,
    offset: o.offset
  })

  if (!rows.length) {
    console.log('\n还没有记录。跑一次分析就会有：npm run dev -- BTC/USDT\n')
    return
  }

  console.log('')
  console.log(
    `   ${pad('时间', 14)}${pad('币种', 10)}${pad('档', 4)}${pad('结论', 12)}` +
      `${rpad('入场', 12)}${rpad('止损', 12)}${rpad('期望R', 8)}${rpad('结果', 10)}`
  )
  for (const r of rows) {
    const plan = r.entryPrice === null ? '—' : f(r.entryPrice)
    const sl = r.stopLoss === null ? '—' : f(r.stopLoss)
    const e =
      r.expectancyR === null
        ? '—'
        : `${r.expectancyR > 0 ? '+' : ''}${r.expectancyR}`
    const out =
      r.outcome === null
        ? '未结算'
        : `${OUTCOME_LABEL[r.outcome]}${r.rMultiple !== null ? ` ${r.rMultiple}R` : ''}`
    console.log(
      `   ${pad(bj(r.createdAt), 14)}${pad(r.symbol, 10)}${pad(
        GRADE_CLS[r.grade ?? 'unclear'] ?? '?',
        4
      )}${pad(VERDICT_TEXT[r.verdict ?? ''] ?? r.verdict ?? '—', 12)}` +
        `${rpad(plan, 12)}${rpad(sl, 12)}${rpad(e, 8)}${rpad(out, 10)}`
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
  const a = await getAnalysis(id)
  if (!a) {
    console.error(`❌ 没有 id=${id} 的记录`)
    process.exitCode = 1
    return
  }

  const L: string[] = []
  L.push('')
  L.push(`=== #${a.id}  ${a.symbol}  ${bj(a.createdAt)}（北京时间）===`)
  L.push('')
  L.push(
    `判档      ${a.grade ?? '—'}${a.gradeReason ? '  ' + a.gradeReason : ''}`
  )
  L.push(
    `结论      ${VERDICT_TEXT[a.verdict ?? ''] ?? a.verdict ?? '—'}   把握 ${
      a.confidence ?? '—'
    }/100`
  )
  if (a.verdictReason) L.push(`理由      ${a.verdictReason}`)
  L.push('')
  L.push(
    `行情      现价 ${f(a.price)}   周期 ${a.timeframes.join(',')}   图表 ${a.chartTimeframe ?? '—'}`
  )
  L.push('')
  L.push('计划')
  L.push(
    `  入场    ${f(a.entryPrice)}（${a.entryType === 'limit' ? '限价' : '市价'}）`
  )
  L.push(
    `  止损    ${f(a.stopLoss)}${a.stopPct !== null ? `（${a.stopPct}%）` : ''}`
  )
  L.push(`  止盈    ${f(a.tp1Price)} / ${f(a.tp2Price)} / ${f(a.tp3Price)}`)
  L.push(`  末段R   ${f(a.rrFinal, 2)}      期望值 ${f(a.expectancyR, 2)}R`)
  L.push(`  仓位    ${f(a.positionQty, 4)}   杠杆 ${f(a.leverageUsed, 2)}x`)
  L.push('')
  L.push(`护栏      ${a.guardPassed ? '通过' : '拦截'}`)
  for (const v of a.veto) L.push(`  否决项  ${v}`)
  for (const v of a.redLines) L.push(`  红线    ${v}`)
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

  if (a.knowledgeRefs.length) {
    L.push('')
    L.push('引用的知识库经验')
    for (const k of a.knowledgeRefs)
      L.push(`  · [${k.symbol} ${k.timeframe}] ${k.lesson}`)
  }

  const checks = a.result?.checklist ?? []
  if (checks.length) {
    L.push('')
    L.push('Checklist')
    for (const c of checks) {
      const icon =
        c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : '⚠️'
      L.push(`  ${icon} ${c.item}${c.evidence ? ' —— ' + c.evidence : ''}`)
    }
  }

  const holding = a.result?.exitPlan?.holding ?? []
  const watching = a.result?.exitPlan?.watching ?? []
  if (holding.length || watching.length) {
    L.push('')
    L.push('后续怎么跟')
    if (holding.length) {
      L.push('  已开单 —— 必须走')
      for (const e of holding) L.push(`    · ${e}`)
    }
    if (watching.length) {
      L.push('  还没开 —— 回头看')
      for (const e of watching) L.push(`    · ${e}`)
    }
  }
  if (a.result?.coachLine) {
    L.push('')
    L.push(`⚠️  当前最该守住的: ${a.result.coachLine}`)
  }

  L.push('')
  L.push(
    `结果      ${
      a.outcome === null
        ? '还没结算（结算：npm run history -- settle ' +
          a.id +
          ' --outcome tp1 --r 1.5）'
        : `${OUTCOME_LABEL[a.outcome]}  ${a.rMultiple ?? '—'}R  ${
            a.outcomeAt ? bj(a.outcomeAt) : ''
          }`
    }`
  )
  if (a.outcomeNote) L.push(`备注      ${a.outcomeNote}`)
  L.push('')

  process.stdout.write(L.join('\n'))
}

async function doSettle(id: number) {
  const outcome = arg('--outcome')
  if (!outcome || !(outcome in OUTCOME_LABEL)) {
    console.error(`❌ 需要 --outcome <${Object.keys(OUTCOME_LABEL).join('|')}>`)
    process.exitCode = 1
    return
  }
  const num = (v: string | undefined) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const ok = await settleAnalysis(id, {
    outcome: outcome as OutcomeKind,
    rMultiple: num(arg('--r')),
    mfePct: num(arg('--mfe')),
    maePct: num(arg('--mae')),
    note: arg('--note') ?? null
  })
  console.log(
    ok
      ? `✓ #${id} 已结算为 ${OUTCOME_LABEL[outcome as OutcomeKind]}`
      : `❌ 没有 id=${id} 的记录`
  )
}

async function showStats(days: number) {
  const s = await analysisStats(days)

  console.log('')
  console.log(`=== 档位表现（最近 ${days} 天）===`)
  console.log('')
  console.log(`总记录    ${s.total} 条`)
  console.log(`花费      ${cny(s.costUsd)}（${usd(s.costUsd)}）`)
  console.log(`待复盘    ${s.pending} 条「可做」但还没结算`)
  console.log('')

  if (!s.byGrade.length) {
    console.log('（还没有记录）')
    console.log('')
    return
  }

  console.log(
    `   ${pad('档位', 8)}${rpad('次数', 6)}${rpad('可做', 6)}${rpad('已结算', 8)}${rpad('胜率', 8)}${rpad('均R', 8)}${rpad('总R', 8)}`
  )
  for (const g of s.byGrade) {
    console.log(
      `   ${pad(g.grade, 8)}${rpad(String(g.calls), 6)}${rpad(
        String(g.goCount),
        6
      )}${rpad(String(g.settled), 8)}${rpad(
        g.winRate === null ? '—' : (g.winRate * 100).toFixed(0) + '%',
        8
      )}${rpad(g.avgR === null ? '—' : g.avgR.toFixed(2), 8)}${rpad(
        g.totalR === null ? '—' : g.totalR.toFixed(2),
        8
      )}`
    )
  }
  console.log('')

  if (s.bySymbol.length) {
    console.log('按币种（做最多的在前）')
    for (const x of s.bySymbol.slice(0, 10)) {
      console.log(
        `   ${pad(x.symbol, 12)}${rpad(String(x.calls), 6)} 次   ${
          x.settled
            ? `均R ${x.avgR?.toFixed(2)}（${x.settled} 次）`
            : '还没结算'
        }`
      )
    }
    console.log('')
  }

  const settled = s.byGrade.reduce((a, g) => a + g.settled, 0)
  if (settled === 0) {
    console.log('提示：结算了才能算胜率。跑完一单之后：')
    console.log('  npm run history -- settle <id> --outcome tp2 --r 1.75')
    console.log('')
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  await ensureSchema()

  const days = Number(arg('--days')) || 365
  if (has('--stats')) return showStats(days)

  // settle <id> --outcome tp1 --r 1.5
  if (process.argv[2] === 'settle') {
    const id = Number(process.argv[3])
    if (!Number.isFinite(id)) {
      console.error(
        '用法：npm run history -- settle <id> --outcome tp1 --r 1.5'
      )
      process.exitCode = 1
      return
    }
    return doSettle(id)
  }

  // 纯数字 = 看详情
  const idArg = process.argv[2]
  if (idArg && /^\d+$/.test(idArg)) return showDetail(Number(idArg))

  return showList({
    grade: arg('--grade'),
    symbol: arg('--symbol'),
    go: has('--go'),
    pending: has('--pending'),
    limit: Number(arg('--limit')) || 20,
    offset: Number(arg('--offset')) || 0
  })
}

main().catch(e => {
  fail(e)
  process.exitCode = 1
})
