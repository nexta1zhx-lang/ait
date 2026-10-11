/**
 * 批量扫描工具（手动跑）：把「近三个月涨幅 ≥ N%」的币逐个丢给 AI，
 * 统计有多少条结论是「可做」。
 *
 * 用现在数据库里那份分析提示词（`ai_docs` kind=predict），跑的是**线上同一条流水线**：
 * `fetchSnapshot`（K 线走本地库）→ `buildContext` → `judge`。
 * ⚠️ 不写 `analyses`（不污染预测历史），但**记用量**（这些调用是真花钱的）。
 */
import {loadConfig} from '../config'
import {loadRules} from '../rules'
import {fetchSnapshot} from '../data/market'
import {buildContext} from '../context/builder'
import {judge} from '../llm/client'
import {recordUsage} from '../db/usage'
import {defaultUserId} from '../db/users'
import {resolveUserLlm} from '../db/llm-keys'
import {query} from '../db/client'
import {MarketType, Timeframe} from '../types'

const MIN_PCT = Number(process.env.MIN_PCT ?? 50)
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 90)
const TF = (process.env.TF ?? '1h') as Timeframe
const DAYS = Number(process.env.DAYS ?? 30)
const CONC = Number(process.env.CONC ?? 5)
/** 只跑这几个币（逗号分隔），做 A/B 时用 */
const ONLY = (process.env.ONLY ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
/** 把「近 N 天涨幅」当成前置条件写进上下文（A/B 的另一组） */
const INJECT = process.env.INJECT === '1'

interface Pick {
  symbol: string
  c0: number
  c1: number
  pct: number
  t0: Date
  t1: Date
}

/**
 * 选出「最近 `WINDOW_DAYS` 天涨得最多」的币。
 *
 * ⚠️ 窗口 ≤ 7 天时用 **1h** 算（按小时精确回溯）；更长才用日线
 *    （日线的最后一根是**已收盘**的那根，拿它算「现在」会差一整天）。
 */
async function picks(): Promise<Pick[]> {
  if (WINDOW_DAYS <= 7) {
    return query<Pick>(
      `WITH h AS (
         SELECT symbol, open_time, close FROM candles
          WHERE exchange = 'binance' AND market_type = 'swap' AND interval = '1h'
            AND open_time >= now() - make_interval(hours => $1::int + 6)
       ),
       n AS (SELECT DISTINCT ON (symbol) symbol, open_time AS t1, close AS c1 FROM h ORDER BY symbol, open_time DESC)
       SELECT n.symbol, h0.close::float8 AS c0, n.c1::float8 AS c1, h0.open_time AS t0, n.t1, 
              (n.c1 / NULLIF(h0.close, 0) - 1) * 100 AS pct
         FROM n
         JOIN h h0 ON h0.symbol = n.symbol
                  AND h0.open_time = n.t1 - make_interval(hours => $1::int)
        WHERE h0.close > 0 AND (n.c1 / h0.close - 1) * 100 >= $2
        ORDER BY pct DESC`,
      [WINDOW_DAYS * 24, MIN_PCT]
    )
  }
  return query<Pick>(
    `WITH scope AS (
       SELECT symbol, open_time, close FROM candles
        WHERE exchange = 'binance' AND market_type = 'swap' AND interval = '1d'
          AND open_time >= now() - make_interval(days => $1::int + 5)
     ),
     o AS (SELECT DISTINCT ON (symbol) symbol, close AS c0, open_time AS t0 FROM scope ORDER BY symbol, open_time ASC),
     n AS (SELECT DISTINCT ON (symbol) symbol, close AS c1, open_time AS t1 FROM scope ORDER BY symbol, open_time DESC)
     SELECT o.symbol, o.c0::float8 AS c0, n.c1::float8 AS c1, o.t0, n.t1,
            (n.c1 / NULLIF(o.c0, 0) - 1) * 100 AS pct
       FROM o JOIN n USING (symbol)
      WHERE o.c0 > 0 AND (n.c1 / o.c0 - 1) * 100 >= $2
      ORDER BY pct DESC`,
    [WINDOW_DAYS, MIN_PCT]
  )
}

/** 「能做…」= 可做；「不能做…」= 不可做；其余（说不清）单独列出来人工看 */
function verdictOf(line: string): 'yes' | 'no' | 'other' {
  const s = line.trim()
  if (/^不能|^不该|^别|^不要/.test(s)) return 'no'
  if (/^(能做|可以做|可做|建议做|可以|值得做)/.test(s)) return 'yes'
  return 'other'
}

async function main(): Promise<void> {
  const rules = await loadRules()
  if (!rules.bodyEnabled) {
    console.error('❌ 数据库里没有启用的分析提示词')
    process.exit(1)
  }
  console.log(
    `提示词：${rules.sources.join('、')} · ${rules.system.length} 字 · ${rules.hash}\n` +
      `筛选：近 ${WINDOW_DAYS} 天涨幅 ≥ ${MIN_PCT}% · 主周期 ${TF} · 图上 ${DAYS} 天 · 并发 ${CONC}\n`
  )

  const userId = await defaultUserId().catch(() => null)
  const resolved = await resolveUserLlm(userId)
  const config = loadConfig({timeframes: [TF], llm: resolved.llm})

  const all = await picks()
  const list = ONLY.length ? all.filter(p => ONLY.includes(p.symbol.split('/')[0]!.toUpperCase())) : all
  console.log(`候选 ${list.length} 个，开始跑…\n`)

  const out: {
    base: string
    pct: number
    price: number
    line: string
    kind: 'yes' | 'no' | 'other'
    err?: string
  }[] = []
  let done = 0
  let cost = 0
  let idx = 0

  const worker = async (): Promise<void> => {
    while (idx < list.length) {
      const p = list[idx++]!
      const base = p.symbol.split('/')[0]!
      const row = {base, pct: p.pct, price: p.c1, line: '', kind: 'other' as const}
      try {
        const snapshot = await fetchSnapshot({
          exchangeId: config.exchange,
          symbol: base,
          timeframe: TF,
          days: DAYS,
          marketType: config.marketType as MarketType,
          apiBase: config.apiBase,
          calibers: config.calibers
        })
        let context = buildContext(snapshot)
        if (INJECT) {
          /*
           * A/B 的另一组：把「前置条件」明写进上下文 ——
           * 这批币之所以被选中就是因为**近 90 天涨幅 ≥50%**，但 K 线块里看不到这一句
           * （主周期只有图上那段，日线块也只有 60 天）。
           */
          context +=
            `\n\n## 前置条件（筛选时用的）\n` +
            `- 这个币**近 ${WINDOW_DAYS} 天涨幅 +${p.pct.toFixed(1)}%**` +
            `（${p.c0} → ${p.c1}），是从低位大幅拉升上来的。\n` +
            `- 我要找的就是这种「已经拉过一波」的币里，**现在**有没有能进的机会。\n`
        }
        const {result, meta} = await judge({
          snapshot,
          context,
          prompt: rules.system,
          config
        })
        const billed = await recordUsage({
          userId,
          llmKeyId: resolved.keyId,
          kind: 'judge',
          model: meta.model,
          symbol: base,
          timeframe: TF,
          usage: meta.usage,
          attempts: meta.attempts,
          latencyMs: meta.latencyMs
        })
        cost += billed?.costUsd ?? 0
        row.price = snapshot.price
        row.line = result.line.trim()
        ;(row as {kind: 'yes' | 'no' | 'other'}).kind = verdictOf(row.line)
      } catch (e) {
        ;(row as {err?: string}).err = (e as Error).message.slice(0, 80)
      }
      out.push(row as never)
      done += 1
      process.stdout.write(
        `\r  进度 ${done}/${list.length}（可做 ${out.filter(r => r.kind === 'yes').length}）   `
      )
    }
  }

  await Promise.all(Array.from({length: CONC}, () => worker()))
  process.stdout.write('\n\n')

  const yes = out.filter(r => r.kind === 'yes')
  const no = out.filter(r => r.kind === 'no')
  const other = out.filter(r => r.kind === 'other' && !r.err)
  const err = out.filter(r => r.err)

  console.log('==================== 可做 ====================')
  for (const r of yes.sort((a, b) => b.pct - a.pct)) {
    console.log(`${r.base.padEnd(10)} ${WINDOW_DAYS}天 +${r.pct.toFixed(1)}%   ${r.line}`)
  }
  console.log('\n==================== 说得含糊 / 没判 ====================')
  for (const r of other) console.log(`${r.base.padEnd(10)} +${r.pct.toFixed(1)}%   ${r.line}`)
  if (err.length) {
    console.log('\n==================== 出错 ====================')
    for (const r of err) console.log(`${r.base.padEnd(10)} ${r.err}`)
  }

  console.log('\n==================== 不可做 ====================')
  for (const r of no.sort((a, b) => b.pct - a.pct)) {
    console.log(`${r.base.padEnd(10)} ${WINDOW_DAYS}天 +${r.pct.toFixed(1)}%   ${r.line}`)
  }

  console.log(
    `\n汇总：候选 ${list.length} · 可做 ${yes.length} · 不可做 ${no.length} · 含糊 ${other.length} · 出错 ${err.length}` +
      `\n本次花费 ≈ $${cost.toFixed(4)}`
  )
}

void main().then(() => process.exit(0))
