/**
 * 回测工具（手动跑）：对「近一个月单日收盘涨过 50%」的每个事件，
 * 取**该日线桶收盘那一刻**回放一次分析，再在本地库算后验收益。
 *
 * 判据（都在本地库算，不请求交易所）：
 *   · 决策价 = 那一刻最后一根已收盘 1h 的收盘（= 快照里的 price）
 *   · 后验   = 之后 6h / 24h / 3 天的最高、最低
 *   · 误杀   = AI 说不能做，但之后 6h 最高 ≥ +20%
 *   · 躲过   = AI 说不能做，但之后 3 天最低 ≤ −10%
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

const CONC = Number(process.env.CONC ?? 5)
const DAYS = Number(process.env.DAYS ?? 30)

interface Event {
  symbol: string
  base: string
  open_time: Date
  day_pct: number
  hi_pct: number
}

/**
 * 样本：**「极弱 → 强势」的时点**（对得上新提示词的形态 6）
 *
 *   · 转折前 24 小时跌得明显（close(T-3)/close(T-24) − 1 ≤ −12%）
 *   · 最近 3 根**不再创新低**（min(low 最近3根) > min(low 前 21 根)）
 *   · 拐头向上（close(T) > close(T−3)）
 *   · 放量（最近 3 根均量 ≥ 前 21 根均量 × 1.3）
 * 每个币取最近一次，最多 46 个。
 */
async function events(): Promise<Event[]> {
  const rows = await query<{symbol: string; open_time: Date}>(
    `WITH h AS (
       SELECT symbol, open_time, open, high, low, close, volume FROM candles
        WHERE exchange='binance' AND market_type='swap' AND interval='1h'
          AND open_time >= now() - interval '32 days'
     ),
     w AS (
       SELECT symbol, open_time, close,
              min(low) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 24 PRECEDING AND 4 PRECEDING) AS lo_prev,
              min(low) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS lo_last3,
              avg(volume) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 24 PRECEDING AND 4 PRECEDING) AS vol_prev,
              avg(volume) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS vol_last3,
              lag(close,3) OVER (PARTITION BY symbol ORDER BY open_time) AS c3,
              lag(close,24) OVER (PARTITION BY symbol ORDER BY open_time) AS c24,
              count(*) OVER (PARTITION BY symbol ORDER BY open_time ROWS BETWEEN 24 PRECEDING AND CURRENT ROW) AS nbars
         FROM h
     ), m AS (
       SELECT DISTINCT ON (symbol) symbol, open_time FROM w
        WHERE nbars = 25 AND c24 > 0 AND lo_prev > 0
          AND (c3/c24 - 1) <= -0.12
          AND lo_last3 > lo_prev
          AND close > c3
          AND vol_last3 >= vol_prev * 1.3
        ORDER BY symbol, open_time DESC
     )
     SELECT symbol, open_time FROM m ORDER BY open_time DESC`
  )
  return rows.map(r => ({
    symbol: r.symbol,
    base: r.symbol.split('/')[0]!,
    // 回放时点 = 那根 1h 收线之后（它成为「最后一根已收盘」）
    open_time: new Date(r.open_time.getTime() + 3600_000),
    day_pct: 0,
    hi_pct: 0
  }))
}

/** 那一刻之后的最高/最低（本地库 1h） */
async function after(
  symbol: string,
  at: Date
): Promise<{hi6: number; lo6: number; hi24: number; lo24: number; hi3d: number; lo3d: number}> {
  const r = await query<Record<string, number | null>>(
    `SELECT max(high) FILTER (WHERE open_time <= $2::timestamptz + interval '6 hours')::float8  AS hi6,
            min(low)  FILTER (WHERE open_time <= $2::timestamptz + interval '6 hours')::float8  AS lo6,
            max(high) FILTER (WHERE open_time <= $2::timestamptz + interval '24 hours')::float8 AS hi24,
            min(low)  FILTER (WHERE open_time <= $2::timestamptz + interval '24 hours')::float8 AS lo24,
            max(high) FILTER (WHERE open_time <= $2::timestamptz + interval '3 days')::float8   AS hi3d,
            min(low)  FILTER (WHERE open_time <= $2::timestamptz + interval '3 days')::float8   AS lo3d
       FROM candles
      WHERE symbol = $1 AND interval='1h' AND open_time > $2::timestamptz
        AND open_time <= $2::timestamptz + interval '3 days'`,
    [symbol, at]
  )
  const x = r[0] ?? {}
  return {
    hi6: Number(x.hi6 ?? NaN),
    lo6: Number(x.lo6 ?? NaN),
    hi24: Number(x.hi24 ?? NaN),
    lo24: Number(x.lo24 ?? NaN),
    hi3d: Number(x.hi3d ?? NaN),
    lo3d: Number(x.lo3d ?? NaN)
  }
}

function verdictOf(line: string): 'yes' | 'no' | 'other' {
  const s = line.trim()
  if (/^不能|^不该|^别|^不要/.test(s)) return 'no'
  if (/^(能做|可以做|可做|建议做|可以|值得做)/.test(s)) return 'yes'
  return 'other'
}

/** 从结论里抠「形态成立概率」（百分数；抠不到算 null） */
function probOf(line: string): number | null {
  const m = line.match(/形态成立[^\d]{0,6}(\d{1,3})\s*%/)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

/** 从结论里抠一个「止损价」（best-effort，抠不到就算 null） */
function stopOf(line: string): number | null {
  const m = line.match(/止损[^\d]{0,8}(\d+(?:\.\d+)?)/)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) && v > 0 ? v : null
}

async function main(): Promise<void> {
  const rules = await loadRules()
  const userId = await defaultUserId().catch(() => null)
  const resolved = await resolveUserLlm(userId)
  const config = loadConfig({timeframes: ['1h'], llm: resolved.llm})
  const list = await events()
  console.log(`提示词 ${rules.hash} · 事件 ${list.length} 个 · 并发 ${CONC}\n`)

  const rows: {
    base: string
    bucket: string
    when: string
    dayPct: number
    price: number
    line: string
    kind: 'yes' | 'no' | 'other'
    stop: number | null
    prob: number | null
    hi6: number
    hi24: number
    lo3d: number
    hi3d: number
    err?: string
  }[] = []
  let idx = 0
  let cost = 0
  let done = 0

  const worker = async (): Promise<void> => {
    while (idx < list.length) {
      const e = list[idx++]!
      // 回放时点 = 那个日线桶收盘的时刻（北京第 2 天 08:00）
      const at = e.open_time
      const bj = (d: Date) =>
        new Date(d.getTime() + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
      const row = {
        base: e.base,
        bucket: bj(e.open_time),
        when: bj(at),
        dayPct: e.day_pct,
        price: NaN,
        line: '',
        kind: 'other' as const,
        stop: null as number | null,
        prob: null as number | null,
        hi6: NaN,
        hi24: NaN,
        lo3d: NaN,
        hi3d: NaN
      }
      try {
        const snapshot = await fetchSnapshot({
          exchangeId: config.exchange,
          symbol: e.base,
          timeframe: '1h',
          days: DAYS,
          marketType: 'swap',
          apiBase: config.apiBase,
          calibers: config.calibers,
          at: at.getTime()
        })
        const {result, meta} = await judge({
          snapshot,
          context: buildContext(snapshot),
          prompt: rules.system,
          config
        })
        const billed = await recordUsage({
          userId,
          llmKeyId: resolved.keyId,
          kind: 'judge',
          model: meta.model,
          symbol: e.base,
          timeframe: '1h',
          usage: meta.usage,
          attempts: meta.attempts,
          latencyMs: meta.latencyMs
        })
        cost += billed?.costUsd ?? 0
        row.price = snapshot.price
        row.line = result.line.trim()
        ;(row as {kind: 'yes' | 'no' | 'other'}).kind = verdictOf(row.line)
        row.stop = stopOf(row.line)
        row.prob = probOf(row.line)
        const a = await after(e.symbol, at)
        row.hi6 = a.hi6
        row.hi24 = a.hi24
        row.lo3d = a.lo3d
        row.hi3d = a.hi3d
      } catch (err) {
        ;(row as {err?: string}).err = (err as Error).message.slice(0, 70)
      }
      rows.push(row as never)
      done += 1
      process.stdout.write(`\r  ${done}/${list.length}   `)
    }
  }

  await Promise.all(Array.from({length: CONC}, () => worker()))
  process.stdout.write('\n\n')

  const pct = (v: number, base: number) =>
    Number.isFinite(v) && Number.isFinite(base) && base > 0
      ? ((v / base - 1) * 100).toFixed(0) + '%'
      : '—'

  console.log('币 | 回放时点(北京) | 决策价 | AI | 概率 | 6h高 | 24h高 | 3天低 | 结论原话')
  for (const r of rows.sort((a, b) => a.when.localeCompare(b.when))) {
    console.log(
      [
        r.base.padEnd(8),
        r.when,
        String(r.price).padEnd(10),
        r.kind === 'yes' ? '可做' : r.kind === 'no' ? '不做' : '含糊',
        String(r.prob ?? '—').padStart(4),
        pct(r.hi6, r.price).padStart(6),
        pct(r.hi24, r.price).padStart(6),
        pct(r.lo3d, r.price).padStart(6),
        (r.err ?? r.line).slice(0, 88)
      ].join(' | ')
    )
  }
  require('fs').writeFileSync('/tmp/bt6.json', JSON.stringify(rows, null, 1))

  const ok = rows.filter(r => !r.err)
  const yes = ok.filter(r => r.kind === 'yes')
  const no = ok.filter(r => r.kind === 'no')
  const missed = no.filter(r => r.hi6 / r.price - 1 >= 0.2)
  const avoided = no.filter(r => r.lo3d / r.price - 1 <= -0.1)
  const stopHit = no.filter(
    r => r.stop !== null && r.lo3d < (r.stop as number)
  )
  const avg = (xs: number[]) =>
    xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 : 0

  console.log(
    `\n汇总：事件 ${ok.length} · 可做 ${yes.length} · 不做 ${no.length} · 含糊 ${ok.length - yes.length - no.length}` +
      `\n  「不做」里：之后 6h 最高 ≥+20% 的（误杀）${missed.length} 个；之后 3 天最低 ≤−10% 的（躲过）${avoided.length} 个` +
      `\n  「不做」里给了止损价的 ${no.filter(r => r.stop !== null).length} 个，其中之后 3 天真的跌破那个价的 ${stopHit.length} 个` +
      `\n  「不做」组的平均最大有利（6h）/平均最大不利（3 天）：+${avg(no.map(r => r.hi6 / r.price - 1)).toFixed(1)}% / ${avg(no.map(r => r.lo3d / r.price - 1)).toFixed(1)}%` +
      (yes.length
        ? `\n  「可做」组的平均最大有利（6h）/平均最大不利（3 天）：+${avg(yes.map(r => r.hi6 / r.price - 1)).toFixed(1)}% / ${avg(yes.map(r => r.lo3d / r.price - 1)).toFixed(1)}%`
        : '') +
      `\n花费 ≈ $${cost.toFixed(4)}`
  )
}

void main().then(() => process.exit(0))
