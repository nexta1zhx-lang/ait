#!/usr/bin/env node
/**
 * API 用量与花费统计。
 *
 *   npm run cost                  最近 30 天
 *   npm run cost -- --days 7      最近 7 天
 *   npm run cost -- --recent 20   多列几笔明细
 *   npm run cost -- --json        输出原始 JSON
 *   npm run cost -- --clear --yes 清空记录
 */
import {UsageBucket, UsageRow, clearUsage, usageSummary} from '../db/usage'
import {dbHelpMessage, ensureSchema} from '../db/client'
import {
  formatCny,
  formatTokens,
  formatUsd,
  pricingTable,
  usdToCny
} from '../llm/pricing'

interface Opts {
  days: number
  recent: number
  json: boolean
  clear: boolean
  yes: boolean
}

function parseArgs(argv: string[]): Opts {
  const val = (name: string, fallback: number): number => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return fallback
    const n = Number(argv[i + 1])
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    days: val('days', 30),
    recent: val('recent', 10),
    json: argv.includes('--json'),
    clear: argv.includes('--clear'),
    yes: argv.includes('--yes')
  }
}

/* ------------------------------------------------------------------ */

/** 中文按两格宽算，否则表格会歪 */
function width(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))
/** 右对齐 */
const rpad = (s: string, n: number) => ' '.repeat(Math.max(0, n - width(s))) + s
/** 左对齐并截断到指定宽度 */
function fit(s: string, n: number): string {
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1
    if (w + cw > n) break
    out += ch
    w += cw
  }
  return out + ' '.repeat(Math.max(0, n - w))
}

function bucketTable(title: string, rows: UsageBucket[], keyHead: string) {
  if (!rows.length) return []
  const out = [title]
  out.push(
    `  ${pad(keyHead, 22)}${rpad('次数', 6)}${rpad('token', 14)}${rpad('花费', 12)}`
  )
  for (const r of rows) {
    out.push(
      `  ${pad(r.label || r.key, 22)}${rpad(String(r.calls), 6)}${rpad(
        formatTokens(r.totalTokens),
        14
      )}${rpad(formatUsd(r.costUsd), 12)}`
    )
  }
  out.push('')
  return out
}

function recentTable(rows: UsageRow[]): string[] {
  if (!rows.length) return []
  const out = ['最近调用', '  （时间 / 用途 / 币种 / 输入+输出 token / 花费）']
  for (const r of rows) {
    const d = new Date(r.createdAt)
    const when = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`
    const cost = r.mock ? '模拟' : formatUsd(r.costUsd)
    out.push(
      `  ${when}  ${pad(r.kind === 'extract' ? '案例提炼' : '开单分析', 10)}${fit(
        (r.symbol ?? '—') + (r.timeframe ? ' ' + r.timeframe : ''),
        18
      )}${rpad(formatTokens(r.promptTokens), 8)}+${rpad(
        formatTokens(r.completionTokens),
        6
      )} ${rpad(cost, 9)}${
        r.latencyMs == null ? '' : ' ' + Math.round(r.latencyMs) + 'ms'
      }${r.attempts > 1 ? ` ×${r.attempts}` : ''}`
    )
  }
  out.push('')
  return out
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  try {
    await ensureSchema()
  } catch (e) {
    console.error('❌ ' + dbHelpMessage(e))
    process.exitCode = 1
    return
  }

  if (opts.clear) {
    if (!opts.yes) {
      console.log('这会清空所有用量记录（不影响知识库与分析记录）。')
      console.log('确认请加 --yes：npm run cost -- --clear --yes')
      process.exitCode = 1
      return
    }
    await clearUsage()
    console.log('✓ 已清空用量记录。')
    return
  }

  const s = await usageSummary({days: opts.days, recent: opts.recent})

  if (opts.json) {
    process.stdout.write(JSON.stringify(s, null, 2) + '\n')
    return
  }

  const t = s.totals
  const realCalls = t.calls - t.mockCalls
  const perCall = realCalls > 0 ? t.costUsd / realCalls : 0
  const hitRate = t.promptTokens > 0 ? t.cacheHitTokens / t.promptTokens : 0

  const L: string[] = []
  L.push('')
  L.push('=== API 用量与花费 ===')
  L.push('')
  L.push(`统计范围   最近 ${s.days} 天`)
  L.push(
    `调用次数   ${t.calls} 次${
      t.mockCalls ? `（其中模拟 ${t.mockCalls} 次，不计费）` : ''
    }`
  )
  L.push(
    `Token      输入 ${formatTokens(t.promptTokens)}（缓存命中 ${formatTokens(
      t.cacheHitTokens
    )}，命中率 ${(hitRate * 100).toFixed(1)}%）+ 输出 ${formatTokens(
      t.completionTokens
    )} = ${formatTokens(t.totalTokens)}`
  )
  L.push(
    `花费       ${formatUsd(t.costUsd)}（${formatCny(t.costUsd)}，汇率 ${process.env.USD_CNY ?? 7.1}）`
  )
  if (realCalls > 0) {
    L.push(`平均单次   ${formatUsd(perCall)}（${formatCny(perCall)}）`)
  }
  L.push('')

  L.push(...bucketTable('按天', s.byDay.slice(0, opts.days), '日期'))
  L.push(...bucketTable('按用途', s.byKind, '用途'))
  L.push(...bucketTable('按模型', s.byModel, '模型'))
  L.push(...recentTable(s.recent))

  L.push(...pricingTable())
  L.push('')
  if (t.calls === 0) {
    L.push('（还没有记录。跑一次分析或收录一个案例就会自动记账。）')
    L.push('')
  }
  if (realCalls > 0 && t.costUsd / realCalls < 0.05) {
    L.push(
      `参考：按目前节奏，100 次分析约 ${formatCny((t.costUsd / realCalls) * 100)}。`
    )
    L.push('')
  }

  process.stdout.write(L.join('\n'))
}

main().catch(e => {
  console.error('❌ ' + dbHelpMessage(e))
  process.exitCode = 1
})
