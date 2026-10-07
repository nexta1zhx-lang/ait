/**
 * 用**币安官方历史数据包**（`data.binance.vision`）在本地补 K 线历史 → 之后整表导线上库。
 *
 * 为什么要这条路径（2026-10-07 用户：「灌历史有点慢 能否本地跑不走代理」「能否调多个数据源」）：
 *   · 本地出口把 `fapi.binance.com` 解析到假 IP ⇒ REST 必须走代理；
 *   · REST 一发权重 5，525 币 × 6 档要几千发，实测 `--conc=8 --rps=14` 反而把自己打进
 *     `-1003`（提速即撞墙）；
 *   · `data.binance.vision` **直连可用**（实测 HTTP/2 200，不走代理）、**不占任何权重**，
 *     而且一个包就是一整天/一整月 ⇒ 请求数少一个量级，还多给 quote_volume / trades /
 *     taker_buy_volume 三个字段（ccxt OHLCV 只有 5 个，seed-candles.ts 只能塞 0）。
 *
 * 用法（本地，**不要**带代理环境变量）：
 *   npx tsx backend/src/scripts/seed-vision.ts --symbols=all --conc=16
 *
 *   --symbols=3            只跑前 3 个（试管道用）
 *   --symbols=BTC          只跑某个币
 *   --intervals=1m,15m     只跑这几档（默认 1m,5m,15m,1h,4h）
 *   --conc=16              同时下几个包
 *   --dry                  只列计划（不下、不写）
 *   --force                忽略「库里已覆盖就跳过」的断点续跑判断
 *
 * 分工（谁便宜谁干）：
 *   · 1m/5m/15m/1h/4h → 本脚本（vision 包，0 权重）；
 *   · 1d → `seed-candles.ts`（一发 1000 根，525 发就够；vision 的 1d 包是 34 个文件/币，反而更贵）。
 *
 * 包规则（实测）：**当月没有月包**（月末后才发）⇒ 当月逐日拿日包；
 * 月包/日包都带 CSV 表头，12 列：
 *   open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore
 *
 * 特性：断点续跑（库里已覆盖的包直接跳过）、只写**已收盘**的桶、限速靠并发不用令牌桶（服务端不限我们）。
 */
import {execFile} from 'node:child_process'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {closePool, ensureSchema, query} from '../db/client'
import {saveCandles, type KlineInterval, type NewCandleRow} from '../db/candle-store'
import {listPerpetualSymbols} from '../data/market'
import {loadConfig} from '../config'

const run = promisify(execFile)

const MIN_MS = 60_000
const DAY_MS = 86_400_000

const MS: Record<KlineInterval, number> = {
  '1m': MIN_MS,
  '5m': 5 * MIN_MS,
  '15m': 15 * MIN_MS,
  '1h': 60 * MIN_MS,
  '4h': 240 * MIN_MS,
  '1d': 1440 * MIN_MS
}

/** 每档补多少天 —— 跟 seed-candles.ts 和底座的分级保留对齐 */
const WINDOWS_DAYS: Record<KlineInterval, number> = {
  '1m': 7,
  '5m': 7,
  '15m': 31,
  '1h': 180,
  '4h': 200,
  '1d': 1000
}

const BASE = 'https://data.binance.vision/data/futures/um'
/** 1d 留给 seed-candles.ts 的 REST 路径（见文件头分工说明） */
const DEFAULT_INTERVALS: KlineInterval[] = ['1m', '5m', '15m', '1h', '4h']

interface Args {
  symbols: string
  intervals: KlineInterval[]
  conc: number
  dry: boolean
  force: boolean
}

function parseArgs(): Args {
  const get = (k: string): string | undefined => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`))
    return hit ? hit.slice(k.length + 3) : undefined
  }
  const iv = (get('intervals') ?? DEFAULT_INTERVALS.join(','))
    .split(',')
    .map(s => s.trim())
    .filter((s): s is KlineInterval => s in MS)
  return {
    symbols: get('symbols') ?? 'all',
    intervals: iv.length ? iv : DEFAULT_INTERVALS,
    conc: Math.max(1, Number(get('conc') ?? 16)),
    dry: process.argv.includes('--dry'),
    force: process.argv.includes('--force')
  }
}

/** UTC 当天 00:00 */
const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS

/** UTC 当月 1 日 00:00 */
function monthStart(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

function nextMonth(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function monthKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

interface FileJob {
  /** ccxt 统一形式（`BTC/USDT:USDT`）—— 库里 `candles.symbol` 存的就是它 */
  symbol: string
  /** 交易所原始 id（`BTCUSDT`）—— 文件名 / URL 用它 */
  raw: string
  interval: KlineInterval
  url: string
  label: string
  /** 这个包覆盖的时间范围（毫秒，左闭右开） */
  rangeStart: number
  rangeEnd: number
  /** 本次要的窗口起点 */
  from: number
}

/** 某个 (币, 周期) 要下哪些包：整月用月包，当月（月包还没发）用日包 */
function planFiles(
  symbol: string,
  raw: string,
  interval: KlineInterval,
  from: number,
  now: number
): FileJob[] {
  const out: FileJob[] = []
  const curMonth = monthKey(now)
  const today = dayStart(now)
  const push = (kind: 'monthly' | 'daily', key: string, rangeStart: number, rangeEnd: number): void => {
    const name = `${raw}-${interval}-${key}.zip`
    out.push({
      symbol,
      raw,
      interval,
      url: `${BASE}/${kind}/klines/${raw}/${interval}/${name}`,
      label: `${raw} ${interval} ${key}`,
      rangeStart,
      rangeEnd,
      from
    })
  }
  for (let m = monthStart(from); m < now; m = nextMonth(m)) {
    if (monthKey(m) !== curMonth) {
      push('monthly', monthKey(m), m, nextMonth(m))
      continue
    }
    // 当月：月包要等月末才发 ⇒ 逐日拿（今天那份还没发，不下）
    for (let d = Math.max(m, dayStart(from)); d < today; d += DAY_MS) {
      push('daily', dayKey(d), d, d + DAY_MS)
    }
  }
  return out
}

interface ZipRow {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  trades: number
  takerBuyVolume: number
}

/** 把 CSV 行解析成数字 —— 表头、空行、列数不对的都丢掉 */
function parseCsv(stdout: string): ZipRow[] {
  const out: ZipRow[] = []
  for (const line of stdout.split('\n')) {
    if (!line || line.charCodeAt(0) < 48 || line.charCodeAt(0) > 57) continue // 表头/空行
    const f = line.split(',')
    if (f.length < 11) continue
    const openTime = Number(f[0])
    const close = Number(f[4])
    if (!Number.isFinite(openTime) || !Number.isFinite(close)) continue
    out.push({
      openTime,
      open: Number(f[1]),
      high: Number(f[2]),
      low: Number(f[3]),
      close,
      volume: Number(f[5]),
      quoteVolume: Number(f[7]),
      trades: Number(f[8]),
      takerBuyVolume: Number(f[9])
    })
  }
  return out
}

const totals = {files: 0, bytes: 0, rows: 0, skipped: 0, missing: 0, failed: 0, empty: 0}

/** 下一次包；404 回 null（当月/昨天的包可能还没发，属正常） */
async function download(
  job: FileJob,
  dir: string,
  attempt = 0
): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(job.url, {redirect: 'follow'})
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      return download(job, dir, attempt + 1)
    }
    throw e
  }
  if (res.status === 404) return null
  if (!res.ok) {
    if (res.status >= 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      return download(job, dir, attempt + 1)
    }
    throw new Error(`HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  totals.bytes += buf.byteLength
  const path = join(dir, `${job.raw}-${job.interval}-${job.label.split(' ').pop()}.zip`)
  await writeFile(path, buf)
  try {
    const {stdout} = await run('unzip', ['-p', path], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8'
    })
    return stdout
  } finally {
    await rm(path, {force: true})
  }
}

async function handle(
  job: FileJob,
  dir: string,
  cfg: {exchange: string; marketType: string},
  now: number,
  earliest: Map<string, number>
): Promise<void> {
  const ms = MS[job.interval]
  const have = earliest.get(`${job.symbol}|${job.interval}`)
  // 断点续跑：这个包整段都在「库里已有的最早那根」之前 ⇒ 已经有数据了
  if (have !== undefined && job.rangeEnd <= have) {
    totals.skipped++
    return
  }
  const from = Math.max(job.from, job.rangeStart)
  const to = Math.min(now, job.rangeEnd)
  if (to <= from) {
    totals.skipped++
    return
  }
  const stdout = await download(job, dir)
  if (stdout === null) {
    totals.missing++
    return
  }
  const rows: NewCandleRow[] = []
  for (const r of parseCsv(stdout)) {
    // 只写窗口内的、且**已收盘**的桶（最后一根可能还在走）
    if (r.openTime < from || r.openTime >= to) continue
    if (r.openTime + ms > now) continue
    rows.push({
      exchange: cfg.exchange,
      marketType: cfg.marketType,
      symbol: job.symbol,
      pair: job.raw,
      interval: job.interval,
      openTime: r.openTime,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      quoteVolume: r.quoteVolume,
      trades: Number.isFinite(r.trades) ? Math.round(r.trades) : 0,
      takerBuyVolume: r.takerBuyVolume,
      source: 'vision'
    })
  }
  if (!rows.length) {
    totals.empty++
    return
  }
  await saveCandles(rows)
  totals.rows += rows.length
}

async function main(): Promise<void> {
  const args = parseArgs()
  await ensureSchema()
  const c = loadConfig()
  const cfg = {exchange: c.exchange, marketType: c.marketType as string}
  let symbols = await listPerpetualSymbols({exchangeId: cfg.exchange, apiBase: c.apiBase})
  if (args.symbols !== 'all') {
    const n = Number(args.symbols)
    symbols = Number.isFinite(n) && n > 0
      ? symbols.slice(0, n)
      : symbols.filter(s => s.base === args.symbols.toUpperCase())
  }
  if (!symbols.length) throw new Error(`没有匹配的币：${args.symbols}`)

  // 「库里已有的最早那根」一次问清，别一个包一次查询
  const earliest = new Map<string, number>()
  const mins = await query<{symbol: string; interval: string; t: Date | null}>(
    `SELECT symbol, interval, min(open_time) AS t
       FROM candles
      WHERE interval = ANY($1::text[]) AND symbol = ANY($2::text[])
      GROUP BY symbol, interval`,
    [args.intervals, symbols.map(s => s.symbol)]
  )
  for (const r of mins) {
    if (r.t) earliest.set(`${r.symbol}|${r.interval}`, new Date(r.t).getTime())
  }

  const now = Date.now()
  const jobs: FileJob[] = []
  for (const s of symbols) {
    for (const interval of args.intervals) {
      const from = now - WINDOWS_DAYS[interval] * DAY_MS
      jobs.push(...planFiles(s.symbol, s.pair, interval, from, now))
    }
  }
  const perIv = new Map<KlineInterval, number>()
  for (const j of jobs) perIv.set(j.interval, (perIv.get(j.interval) ?? 0) + 1)
  console.log(
    `[vision] ${symbols.length} 个币 × ${args.intervals.length} 档 = ${jobs.length} 个包` +
      `（${[...perIv].map(([k, v]) => `${k} ${v}`).join(' / ')}），并发 ${args.conc}` +
      `${args.force ? '，--force 忽略断点' : ''}`
  )
  if (args.dry) {
    console.log(`[vision] --dry：只列计划。样例：\n  ${jobs[0]?.url ?? ''}\n  ${jobs[jobs.length - 1]?.url ?? ''}`)
    return
  }

  const dir = await mkdtemp(join(tmpdir(), 'vision-'))
  const t0 = Date.now()
  let done = 0
  let i = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[i++]
      if (!job) return
      try {
        await handle(job, dir, cfg, now, args.force ? new Map() : earliest)
      } catch (e) {
        totals.failed++
        console.warn(`[vision] 失败（${job.label}）：${(e as Error).message.slice(0, 120)}`)
      }
      done++
      if (done % 200 === 0 || done === jobs.length) {
        const min = (Date.now() - t0) / 60_000
        console.log(
          `[vision] 包 ${done}/${jobs.length} | 写入 ${totals.rows} 行 | 跳过 ${totals.skipped} | ` +
            `没发 ${totals.missing} | 空 ${totals.empty} | 失败 ${totals.failed} | ` +
            `${(totals.bytes / 1e6).toFixed(0)} MB | ${min.toFixed(1)} 分钟（${(done / Math.max(0.1, min)).toFixed(0)} 包/分钟）`
        )
      }
    }
  }
  await Promise.all(Array.from({length: args.conc}, () => worker()))
  await rm(dir, {recursive: true, force: true})
  const min = (Date.now() - t0) / 60_000
  console.log(
    `[vision] 完成：${jobs.length} 个包、写入 ${totals.rows} 行、跳过 ${totals.skipped}、` +
      `没发 ${totals.missing}、空 ${totals.empty}、失败 ${totals.failed}、` +
      `${(totals.bytes / 1e6).toFixed(0)} MB，用时 ${min.toFixed(1)} 分钟` +
      `（${(done / Math.max(0.1, min)).toFixed(0)} 包/分钟）`
  )
}

main()
  .catch(e => {
    console.error('[vision] 挂了：', (e as Error).message)
    process.exitCode = 1
  })
  .finally(() => closePool().catch(() => undefined))
