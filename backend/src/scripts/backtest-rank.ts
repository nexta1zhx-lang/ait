/**
 * 回测实验（手动跑）：**批量相对排序**架构有没有增量？
 *
 * 背景：单币逐个判定那套测了三轮（同 46 样本「可做」23/3/9/2、自评概率无区分度），
 * 用户判断「AI 提示词这条路不可行」。这个实验只回答一个问题：
 *   把 25 个候选**一次**交给模型、让它做**相对排序**，它挑出的 top5
 *   之后 6h/24h 的表现，能不能超过「随机 / 动量」这些免费基线？
 *
 * 设计：
 *   · 时间点：过去 7 天，每天 04:00 UTC（北京 12:00）——都留足 3 天后验窗口
 *   · 两个池子（每池 25 个）：
 *       A「热钱池」= 24h 成交额 top80 里确定性抽 25（掺安静币，考它找不找得到冷门苗头）
 *       B「强势池」= 24h 涨幅 ≥ +8% 里按成交额取 25（真人扫盘时的那一筐）
 *   · 基线：全池平均 / 随机 5 个（抽 200 次取均值，固定种子）/ 24h 涨幅 top5
 *   · 决策价 = 那一刻最后一根**已收盘** 1h 的收盘
 *     结果指标：MFE6 / MFE24（之后 6h / 24h 最高涨幅）、TR24（之后 24h 收盘涨幅）
 *   · 信息量：25 个币的排名与 MFE24 的 Spearman（逐批算，看均值）
 *   · DUP=1 时每批跑两遍 —— 量「同输入两次排序像不像」= 架构噪声底线
 *
 * 只读本地库，不请求交易所。
 */
import 'dotenv/config'
import fs from 'fs'
import OpenAI from 'openai'
import {loadConfig} from '../config'
import {loadRules} from '../rules'
import {fetchSnapshot} from '../data/market'
import {buildContext} from '../context/builder'
import {readRangeCandles} from '../db/candle-store'
import {query} from '../db/client'
import {defaultUserId} from '../db/users'
import {resolveUserLlm} from '../db/llm-keys'
import {recordUsage} from '../db/usage'
import {chatParams} from '../llm/params'
import {addUsage, emptyUsage, readUsage} from '../llm/pricing'

const CONC = Number(process.env.CONC ?? 3)
const DUP = process.env.DUP === '1'
/**
 * `lean`（默认）= 一批 25 个、每个给精简数据；
 * `full` = 一批 10 个、每个给**跟单币模式一模一样的那份完整上下文**（buildContext）——
 *          用来排除「是数据给少了，还是相对排序本身没信息」。
 */
const VARIANT = process.env.VARIANT === 'full' ? 'full' : 'lean'
/** 池子大小 */
const K = VARIANT === 'full' ? 10 : 25
/** 时间点（UTC 04:00 = 北京 12:00），都能留出 3 天后验 */
const DAYS = Number(process.env.DAYS ?? 7)

const MS: Record<string, number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000
}

interface Cand {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface PoolCoin {
  symbol: string
  base: string
  qv: number
  ch24: number
  ch7d: number
}

interface Outcome {
  p: number
  mfe6: number
  mfe24: number
  tr24: number
  mae3d: number
  /** 首触：先摸到 +15% 还是先破 −10%（同一根内两样都摸到按「先止损」保守算）；都没摸到就是 24h 收盘收益 */
  touch: number
  touched: 'up' | 'dn' | 'none'
}

/* ------------------------------------------------------------------ 取数 */

/** `at` 之前最近 n 根**已收盘** K 线（本地库） */
async function series(interval: string, symbol: string, at: number, n: number): Promise<Cand[]> {
  const ms = MS[interval]!
  const rows = await readRangeCandles(
    interval as never,
    symbol,
    n + 2,
    at - n * ms,
    at - 1,
    {exchange: 'binance', marketType: 'swap'}
  )
  return rows.slice(-n)
}

/** 那一刻的候选池：24h 成交额 / 24h 涨幅 / 7d 涨幅 */
async function universe(at: Date): Promise<PoolCoin[]> {
  const rows = await query<{symbol: string; qv: number; c0: number; c1: number}>(
    `SELECT symbol,
            sum(GREATEST(quote_volume, volume * close))::float8 AS qv,
            (array_agg(close ORDER BY open_time))[1]::float8 AS c0,
            (array_agg(close ORDER BY open_time))[count(*)]::float8 AS c1
       FROM candles
      WHERE exchange='binance' AND market_type='swap' AND interval='1h'
        AND open_time > $1::timestamptz - interval '24 hours'
        AND open_time <= $1::timestamptz
      GROUP BY symbol
     HAVING count(*) >= 24
      ORDER BY sum(GREATEST(quote_volume, volume * close)) DESC`,
    [at]
  )
  const d7 = await query<{symbol: string; c7: number}>(
    `SELECT symbol, (array_agg(close ORDER BY open_time))[1]::float8 AS c7
       FROM candles
      WHERE exchange='binance' AND market_type='swap' AND interval='1d'
        AND open_time > $1::timestamptz - interval '8 days'
        AND open_time <= $1::timestamptz
      GROUP BY symbol`,
    [at]
  )
  const past = new Map(d7.map(r => [r.symbol, Number(r.c7)]))
  return rows
    .map(r => ({
      symbol: r.symbol,
      base: r.symbol.split('/')[0]!,
      qv: Number(r.qv),
      ch24: Number(r.c1) / Number(r.c0) - 1,
      ch7d: past.has(r.symbol) ? Number(r.c1) / past.get(r.symbol)! - 1 : NaN
    }))
    .filter(r => Number.isFinite(r.ch24))
}

/** 确定性抽样（xorshift），保证每次跑同一批候选 */
function sample<T>(xs: T[], n: number, seed: number): T[] {
  const a = xs.slice()
  let s = (seed >>> 0) || 1
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a.slice(0, n)
}

/** 那一刻之后 3 天，逐根 1h 拉回来，在 JS 里算后验 */
async function outcomes(
  symbols: string[],
  at: number,
  price: Record<string, number>
): Promise<Record<string, Outcome>> {
  const rows = await query<{symbol: string; open_time: Date; high: number; low: number; close: number}>(
    `SELECT symbol, open_time, high, low, close FROM candles
      WHERE symbol = ANY($1::text[]) AND interval='1h'
        AND open_time > $2::timestamptz
        AND open_time <= $2::timestamptz + interval '3 days'
      ORDER BY symbol, open_time`,
    [symbols, new Date(at)]
  )
  const out: Record<string, Outcome> = {}
  for (const r of rows) {
    const t = new Date(r.open_time).getTime()
    const o = (out[r.symbol] ??= {
      p: price[r.symbol] ?? NaN,
      mfe6: NaN,
      mfe24: NaN,
      tr24: NaN,
      mae3d: Infinity,
      touch: NaN,
      touched: 'none'
    })
    const p = o.p
    if (!Number.isFinite(p) || p <= 0) continue
    const dt = t - at
    if (dt <= 6 * 3_600_000) o.mfe6 = Math.max(o.mfe6 || -Infinity, r.high / p - 1) as never
    if (dt <= 24 * 3_600_000) {
      o.mfe24 = Math.max(o.mfe24 || -Infinity, r.high / p - 1) as never
      o.tr24 = r.close / p - 1
      if (o.touched === 'none') {
        const up = r.high / p - 1 >= 0.15
        const dn = r.low / p - 1 <= -0.1
        if (dn) {
          o.touch = -0.1
          o.touched = 'dn'
        } else if (up) {
          o.touch = 0.15
          o.touched = 'up'
        }
      }
    }
    o.mae3d = Math.min(o.mae3d, r.low / p - 1)
  }
  for (const k of Object.keys(out)) {
    const o = out[k]!
    if (!Number.isFinite(o.mfe6)) o.mfe6 = NaN
    if (!Number.isFinite(o.mfe24)) o.mfe24 = NaN
    if (!Number.isFinite(o.mae3d)) o.mae3d = NaN
    if (!Number.isFinite(o.touch)) o.touch = o.tr24 // 24h 内都没摸到 → 按 24h 收盘算
  }
  return out
}

/* ------------------------------------------------------------------ 写成文本 */

const bj = (ts: number) =>
  new Date(ts + 8 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ')

function px(n: number): string {
  const a = Math.abs(n)
  const d = a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 6
  return n.toFixed(d)
}

const pc = (v: number, d = 1) =>
  Number.isFinite(v) ? (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%' : 'n/a'

function amt(v: number): string {
  if (!Number.isFinite(v)) return 'n/a'
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '万'
  return v.toFixed(0)
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN

/** 一个币的紧凑块（比单币那套短得多 —— 一批要塞 25 个） */
function coinBlock(
  id: number,
  c: PoolCoin,
  bars: {h1: Cand[]; h4: Cand[]; d1: Cand[]; m15: Cand[]}
): string {
  const {h1, h4, d1, m15} = bars
  const cur = h1[h1.length - 1]?.close ?? NaN
  const lines: string[] = []

  lines.push(
    `[${id}] ${c.base}  现价 ${px(cur)}  24h ${pc(c.ch24)}  7d ${pc(c.ch7d)}  24h额 ${amt(c.qv)}`
  )

  // 1h：整段 + 6 段（每段给涨跌 / 高低 / 量能比）
  const first = h1[0]!
  const avgVol = mean(h1.map(b => b.volume)) || 1
  const size = Math.max(1, Math.ceil(h1.length / 6))
  const segs: string[] = []
  for (let i = 0; i < h1.length; i += size) {
    const s = h1.slice(i, Math.min(h1.length, i + size))
    const a = s[0]!
    const z = s[s.length - 1]!
    const hi = Math.max(...s.map(b => b.high))
    const lo = Math.min(...s.map(b => b.low))
    segs.push(
      `${bj(a.timestamp)}→${bj(z.timestamp).slice(6)} ${pc(z.close / a.open - 1)} ` +
        `高${px(hi)} 低${px(lo)} 量${(mean(s.map(b => b.volume)) / avgVol).toFixed(1)}x`
    )
  }
  lines.push(
    `1h(近${h1.length}根)：${bj(first.timestamp)}→${bj(h1[h1.length - 1]!.timestamp)} ` +
      `整段 ${pc(cur / first.open - 1)} 高${px(Math.max(...h1.map(b => b.high)))} ` +
      `低${px(Math.min(...h1.map(b => b.low)))}`
  )
  segs.forEach(s => lines.push(`  ${s}`))

  // 15m：最近 12 根逐根（当下强弱就看这里），量比 = 相对前 12 根均量
  const prev = m15.slice(0, m15.length - 12)
  const base15 = mean((prev.length ? prev : m15).map(b => b.volume)) || 1
  const tail = m15.slice(-12)
  const cells = tail.map(b => {
    const hh = new Date(b.timestamp + 8 * 3_600_000).toISOString().slice(11, 16)
    return (
      `${hh} 收${px(b.close)} ${pc(b.close / b.open - 1)} ` +
      `量${(b.volume / base15).toFixed(1)}x`
    )
  })
  lines.push('15m 最近 12 根（北京，只给收盘/涨跌/量比）：')
  for (let i = 0; i < cells.length; i += 4) lines.push('  ' + cells.slice(i, i + 4).join(' | '))

  // 4h / 1d 各一行概览
  const sum = (bars2: Cand[]) => {
    if (!bars2.length) return 'n/a'
    const a = bars2[0]!
    const z = bars2[bars2.length - 1]!
    return (
      `${pc(z.close / a.open - 1)} 高${px(Math.max(...bars2.map(b => b.high)))} ` +
      `低${px(Math.min(...bars2.map(b => b.low)))}`
    )
  }
  const hl = Math.floor(h4.length / 2)
  lines.push(
    `4h(近${h4.length}根) ${sum(h4)} 后/前量 ${(
      mean(h4.slice(hl).map(b => b.volume)) / (mean(h4.slice(0, hl).map(b => b.volume)) || 1)
    ).toFixed(1)}x | 1d(近${d1.length}根) ${sum(d1)}`
  )
  return lines.join('\n')
}

/* ------------------------------------------------------------------ 排名解析 */

/** 从 `RANK: 7 3 12 …` 里抠出排名（返回 ID 顺序 + 缺了几个） */
function parseRank(raw: string, k: number): {rank: number[]; missing: number} {
  const line = raw.split('\n').find(l => /RANK\s*[:：]/i.test(l)) ?? raw
  const job = line.replace(/^.*?RANK\s*[:：]/i, '')
  const seen: number[] = []
  for (const tok of job.split(/[^0-9]+/)) {
    const v = Number(tok)
    if (Number.isFinite(v) && v >= 1 && v <= k && !seen.includes(v)) seen.push(v)
  }
  const missing = k - seen.length
  for (let i = 1; i <= k; i++) if (!seen.includes(i)) seen.push(i)
  return {rank: seen, missing}
}

/* ------------------------------------------------------------------ 统计 */

function rankOf(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({v, i})).sort((a, b) => a.v - b.v)
  const r = new Array<number>(xs.length)
  idx.forEach((o, j) => (r[o.i] = j + 1))
  return r
}

/** Spearman：AI 排名（1=最强）和后验 MFE24 的排序一致吗 */
function spearman(aiRank: number[], mfe24: number[]): number {
  const m = mfe24.map(v => (Number.isFinite(v) ? v : -1))
  const a = rankOf(aiRank.map(v => -v)) // 转成「越大越好」再排
  const b = rankOf(m)
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN
}

const stat = (out: Outcome[], ids: number[]) => {
  const xs = ids.map(i => out[i]!).filter(Boolean)
  return {
    mfe6: mean(xs.map(o => o.mfe6)),
    mfe24: mean(xs.map(o => o.mfe24)),
    tr24: mean(xs.map(o => o.tr24)),
    touch: mean(xs.map(o => o.touch)),
    hit: xs.filter(o => o.mfe24 >= 0.1).length / xs.length,
    up: xs.filter(o => o.touched === 'up').length / xs.length
  }
}

/** 随机 5 个的均值（固定种子，200 次） */
function rand5(out: Outcome[], k: number, seed: number): Outcome[] {
  let s = seed
  const acc: Outcome[] = []
  for (let t = 0; t < 200; t++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const xs = sample([...Array(k).keys()], 5, s + t)
    acc.push(...xs.map(i => out[i]!))
  }
  return acc
}

/* ------------------------------------------------------------------ 主流程 */

const SYS_TAIL = `

【本次是**批量模式**】
下面会一次给你 ${K} 个候选币的行情，都是**同一时刻**截的。不要逐个下「能做/不能做」的结论，
而是把它们按「谁最可能在接下来 6~24 小时里走出我的形态」**从强到弱排个序**。
每个币的数据比平时少：只有 1h 分段 + 最近 12 根 15m 明细 + 4h/1d 概览。

输出格式（严格遵守，别的字都不要）：
RANK: 7 3 12 1 25 …   ← ${K} 个编号，空格分开，从你认为最强到最弱，一个不能少也不能重复
TOP5: 7=一句话 | 3=一句话 | 12=一句话 | 1=一句话 | 25=一句话`

interface Row {
  pool: 'A' | 'B'
  at: string
  atMs: number
  price: Record<string, number>
  out: Outcome[]
  coins: PoolCoin[]
  rank: number[]
  rank2?: number[]
  missing: number
  raw: string
  latencyMs: number
}

async function main(): Promise<void> {
  const rules = await loadRules()
  const userId = await defaultUserId().catch(() => null)
  const resolved = await resolveUserLlm(userId)
  const config = loadConfig({llm: resolved.llm})
  const client = new OpenAI({apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl})

  const now = Date.now()
  const hour = Math.floor(now / 3_600_000) * 3_600_000
  const utcHour = Math.floor(hour / 3_600_000) % 24
  const points: number[] = []
  // 每天 UTC 04:00（北京 12:00）
  for (let d = DAYS; d >= 1; d--) points.push(hour - d * 86_400_000 - (utcHour - 4) * 3_600_000)

  const jobs: {pool: 'A' | 'B'; at: number; coins: PoolCoin[]}[] = []
  for (const at of points) {
    const u = await universe(new Date(at))
    const top80 = u.slice(0, 80)
    jobs.push({pool: 'A', at, coins: sample(top80, K, at)})
    const strong = top80.filter(c => c.ch24 >= 0.08)
    jobs.push({
      pool: 'B',
      at,
      coins: (strong.length >= K ? strong : u.filter(c => c.ch24 >= 0.03)).slice(0, K)
    })
  }

  console.log(
    `提示词 ${rules.hash} · 批次 ${jobs.length}${DUP ? '（每批跑两遍）' : ''} · 并发 ${CONC}\n`
  )

  const rows: Row[] = []
  let idx = 0
  let cost = 0
  const worker = async (): Promise<void> => {
    while (idx < jobs.length) {
      const j = jobs[idx++]!
      const at = j.at
      const bars: Record<string, {h1: Cand[]; h4: Cand[]; d1: Cand[]; m15: Cand[]}> = {}
      const price: Record<string, number> = {}
      let usable = j.coins
      let blocks = ''

      if (VARIANT === 'full') {
        const built = await Promise.all(
          j.coins.map(async c => {
            try {
              const snap = await fetchSnapshot({
                exchangeId: config.exchange,
                symbol: c.base,
                timeframe: '1h',
                days: config.lookbackDays,
                marketType: 'swap',
                apiBase: config.apiBase,
                calibers: config.calibers,
                at
              })
              return {c, text: buildContext(snap), p: snap.price}
            } catch {
              return null
            }
          })
        )
        const ok = built.filter((x): x is NonNullable<typeof x> => x !== null)
        if (ok.length < K) continue
        usable = ok.map(x => x.c)
        ok.forEach(x => (price[x.c.symbol] = x.p))
        blocks = ok.map((x, i) => `[${i + 1}] ${x.c.base}\n${x.text}`).join('\n\n')
      } else {
        await Promise.all(
          j.coins.map(async c => {
            const [h1, h4, d1, m15] = await Promise.all([
              series('1h', c.symbol, at, 96),
              series('4h', c.symbol, at, 120),
              series('1d', c.symbol, at, 30),
              series('15m', c.symbol, at, 24)
            ])
            bars[c.symbol] = {h1, h4, d1, m15}
          })
        )
        usable = j.coins.filter(c => (bars[c.symbol]?.h1.length ?? 0) >= 48)
        if (usable.length < K) continue
        usable.forEach(c => (price[c.symbol] = bars[c.symbol]!.h1.slice(-1)[0]!.close))
        blocks = usable.map((c, i) => coinBlock(i + 1, c, bars[c.symbol]!)).join('\n\n')
      }

      const out = await outcomes(usable.map(c => c.symbol), at, price)
      const outs = Object.values(out)
      if (outs.some(o => o.mae3d === Infinity)) continue
      const user =
        `【同一时刻 ${bj(at)}（北京）· ${K} 个候选】\n\n${blocks}\n\n` +
        `请按我的提示词把这 ${K} 个编号从强到弱排序。`
      if (process.env.DRY === '1' && rows.length === 0)
        console.log(
          `\n[DRY] 池 ${j.pool} · 提示词 ${rules.system.length} + 附加 ${SYS_TAIL.length} 字 · ` +
            `user ${user.length} 字（≈${Math.round(user.length / 1.6)} token）\n\n${user.slice(0, 3000)}\n`
        )

      const run = async (): Promise<{rank: number[]; missing: number; raw: string; ms: number}> => {
        const started = Date.now()
        let usage = emptyUsage()
        let raw = ''
        if (process.env.DRY === '1') {
          raw = `RANK: ${[...Array(K).keys()].map(i => i + 1).join(' ')}\nTOP5: dry`
        }
        for (let attempt = 0; !process.env.DRY && attempt < 2; attempt++) {
          const res = await client.chat.completions.create(
            chatParams({
              model: config.llm.model,
              temperature: config.llm.temperature,
              reasoningEffort: config.llm.reasoningEffort,
              messages: [
                {role: 'system', content: rules.system + SYS_TAIL},
                {role: 'user', content: user}
              ],
              responseFormat: false
            }) as never
          )
          usage = addUsage(usage, readUsage(res))
          raw = res.choices?.[0]?.message?.content ?? ''
          if (raw.trim()) break
        }
        const billed = await recordUsage({
          userId,
          llmKeyId: resolved.keyId,
          kind: 'judge',
          model: config.llm.model,
          symbol: `rank:${j.pool}`,
          usage,
          latencyMs: Date.now() - started
        })
        cost += billed?.costUsd ?? 0
        const parsed = parseRank(raw, K)
        return {...parsed, raw, ms: Date.now() - started}
      }

      const r1 = await run()
      const r2 = DUP ? await run() : null
      rows.push({
        pool: j.pool,
        at: bj(at),
        atMs: at,
        price,
        out: usable.map(c => out[c.symbol]!),
        coins: usable,
        rank: r1.rank,
        rank2: r2?.rank,
        missing: r1.missing,
        raw: r1.raw,
        latencyMs: r1.ms
      })
      process.stdout.write(`\r  完成 ${rows.length}/${jobs.length}   `)
    }
  }

  await Promise.all(Array.from({length: CONC}, () => worker()))
  process.stdout.write('\n\n')

  type ArmStat = {mfe24: number; tr24: number; touch: number; hit: number; up: number}
  const agg: Record<string, {mfe24: number[]; tr24: number[]; touch: number[]; hit: number[]; up: number[]; rho: number[]}> =
    {}
  const add = (k: string, s: ArmStat, rho?: number) => {
    const a = (agg[k] ??= {mfe24: [], tr24: [], touch: [], hit: [], up: [], rho: []})
    a.mfe24.push(s.mfe24)
    a.tr24.push(s.tr24)
    a.touch.push(s.touch)
    a.hit.push(s.hit)
    a.up.push(s.up)
    if (rho !== undefined && Number.isFinite(rho)) a.rho.push(rho)
  }

  console.log(
    '池 | 时点(北京) | 组 | MFE24 | TR24 | 首触(+15/−10) | 命中≥10% | 先到+15%'
  )
  for (const r of rows.sort((a, b) => a.at.localeCompare(b.at) || a.pool.localeCompare(b.pool))) {
    const k = r.coins.length
    const ai = stat(r.out, r.rank.slice(0, 5))
    const bot = stat(r.out, r.rank.slice(-5))
    const all = stat(r.out, [...Array(k).keys()])
    const rnd = stat(rand5(r.out, k, 42), [...Array(1000).keys()])
    const momIds = r.coins
      .map((c, i) => ({i, v: c.ch24}))
      .sort((a, b) => b.v - a.v)
      .slice(0, 5)
      .map(o => o.i)
    const mom = stat(r.out, momIds)
    const rho = spearman(r.rank, r.out.map(o => o.mfe24))
    // AI 是不是只是在抄「24h 涨幅」？排名和涨幅本身的相关
    const rhoMom = spearman(r.rank, r.coins.map(c => c.ch24))
    const f = (v: number) => pc(v).padStart(7)
    const line = (
      name: string,
      s: {mfe24: number; tr24: number; touch: number; hit: number; up: number}
    ) =>
      `  ${name.padEnd(9)} ${f(s.mfe24)} ${f(s.tr24)} ${f(s.touch)} ` +
      `${(s.hit * 100).toFixed(0).padStart(4)}% ${(s.up * 100).toFixed(0).padStart(4)}%`
    console.log(
      `\n${r.pool} | ${r.at} | ${k} 候选 | 解析缺 ${r.missing} | ${(r.latencyMs / 1000).toFixed(1)}s`
    )
    console.log(line('AI top5', ai))
    console.log(line('AI bot5', bot))
    console.log(line('随机5', rnd))
    console.log(line('动量24h5', mom))
    console.log(line('全池均值', all))
    console.log(
      `  ρ(排名, MFE24) = ${rho >= 0 ? '+' : ''}${rho.toFixed(3)}` +
        ` · ρ(排名, 24h涨幅) = ${rhoMom >= 0 ? '+' : ''}${rhoMom.toFixed(3)}` +
        ` · top5 与动量重合 ${r.rank.slice(0, 5).filter(x => momIds.includes(x - 1)).length}/5`
    )
    if (r.rank2) {
      const ov = r.rank.slice(0, 5).filter(x => r.rank2!.slice(0, 5).includes(x)).length
      console.log(
        `  两次重复：ρ = ${spearman(r.rank, r.rank2.map(v => -v)).toFixed(3)} · top5 重合 ${ov}/5`
      )
    }
    add('AI top5', ai, rho)
    add('AI bot5', bot)
    add('随机5', rnd)
    add('动量24h5', mom)
    add('全池均值', all)
  }

  console.log('\n======== 汇总（批次均值） ========')
  for (const [k, v] of Object.entries(agg)) {
    console.log(
      `${k.padEnd(10)} MFE24 ${pc(mean(v.mfe24)).padStart(7)}  TR24 ${pc(mean(v.tr24)).padStart(7)}  ` +
        `首触 ${pc(mean(v.touch)).padStart(7)}  命中 ${(mean(v.hit) * 100).toFixed(1)}%  ` +
        `先到+15% ${(mean(v.up) * 100).toFixed(1)}%` +
        (v.rho.length ? `  ρ均值 ${(mean(v.rho) >= 0 ? '+' : '') + mean(v.rho).toFixed(3)}` : '')
    )
  }
  console.log(`\n花费 ≈ $${cost.toFixed(4)}`)
  fs.writeFileSync(
    process.env.OUT ?? '/tmp/rank.json',
    JSON.stringify(rows, null, 1)
  )
  if (rows[0]) console.log('\n--- 第一批原话（截断 1200 字）---\n' + rows[0].raw.slice(0, 1200))
}

void main().then(() => process.exit(0))
