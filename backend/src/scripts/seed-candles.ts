/**
 * 本地补历史 K 线 → 之后整表导入线上库（用户 2026-10-07：
 * 「历史数据用脚本在本地数据库补上后续直接导入库数据」）。
 *
 * 为什么不在线上灌：线上出口 IP 要跟交易/账户共用权重（2400/分钟），
 * 2026-10-07 就因为一次在线灌历史吃到 85 次 `-1003`。本地这台机器有独立出口，
 * 一次性把历史拉全、再整表导过去，线上只付「导入」这一次。
 *
 * 用法（本地，需要出口代理）：
 *   EXCHANGE_PROXY=http://127.0.0.1:8888 HTTPS_PROXY=... NODE_USE_ENV_PROXY=1 \
 *     npx tsx backend/src/scripts/seed-candles.ts --symbols=all --rps=6
 *
 *   --symbols=3            只跑前 3 个（试管道用）
 *   --intervals=1m,1h      只跑这几档
 *   --rps=6                每秒最多几发（权重 5/发 ⇒ 6 发/秒 = 1800 权重/分钟）
 *   --conc=3               并发
 *
 * 特性：
 *   · **从库里已有的最早那根往前补**（断点续跑、重复跑也不重复拉）；
 *   · 每档有自己的目标窗口（见 WINDOWS_DAYS），补到窗口起点就跳过；
 *   · 限流（`-1003` / RateBudgetError）就歇一会儿再来，不丢进度。
 */
import {ensureSchema, closePool} from '../db/client'
import {saveCandles, type KlineInterval, type NewCandleRow} from '../db/candle-store'
import {fetchCandlesRange, listPerpetualSymbols} from '../data/market'
import {loadConfig} from '../config'
import {queryOne} from '../db/client'

const DAY_MS = 86_400_000
const MIN_MS = 60_000

const MS: Record<KlineInterval, number> = {
  '1m': MIN_MS,
  '5m': 5 * MIN_MS,
  '15m': 15 * MIN_MS,
  '1h': 60 * MIN_MS,
  '4h': 240 * MIN_MS,
  '1d': 1440 * MIN_MS
}

/**
 * 每档往前补多少天。跟底座的分级保留对上：
 * 1m/5m 留 7 天、15m 留 30 天、1h 留 400 天、4h/1d 永久。
 * ⚠️ 1h 只补 180 天（不是 400）：一屏要 8760 根才画满一年，但那是 400MB 级别的行数，
 *    180 天足够 30 天图 + 一次「加载更多」；真要看一年再让线上按需拉。
 */
const WINDOWS_DAYS: Record<KlineInterval, number> = {
  '1m': 7,
  '5m': 7,
  '15m': 31,
  '1h': 180,
  '4h': 200,
  '1d': 1000
}

/** 一发最多要多少根（ccxt 上限 1000） */
const PAGE = 1000
/** ⚠️ K 线一发的真实权重（`/fapi/v1/klines` limit=1000） */
const WEIGHT_PER_REQUEST = 5

interface Args {
  symbols: string
  intervals: KlineInterval[]
  rps: number
  conc: number
}

function parseArgs(): Args {
  const get = (k: string): string | undefined => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`))
    return hit ? hit.slice(k.length + 3) : undefined
  }
  const iv = (get('intervals') ?? '1m,5m,15m,1h,4h,1d')
    .split(',')
    .map(s => s.trim())
    .filter((s): s is KlineInterval => s in MS)
  return {
    symbols: get('symbols') ?? 'all',
    intervals: iv.length ? iv : (['1m', '5m', '15m', '1h', '4h', '1d'] as KlineInterval[]),
    rps: Math.max(1, Number(get('rps') ?? 6)),
    conc: Math.max(1, Number(get('conc') ?? 3))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 全局令牌桶：不管几个 worker，都别超过 rps 发/秒 */
let nextSlot = 0
async function rateLimit(rps: number): Promise<void> {
  const gap = 1000 / rps
  const now = Date.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + gap
  if (at > now) await sleep(at - now)
}

const totals = {requests: 0, rows: 0, skipped: 0, limited: 0, failed: 0}

/** 库里这个 (币, 周期) 最早那根的开盘时间（没有就 null） */
async function earliestOf(symbol: string, interval: KlineInterval): Promise<number | null> {
  const row = await queryOne<{t: Date | null}>(
    `SELECT min(open_time) AS t FROM candles WHERE interval = $1 AND symbol = $2`,
    [interval, symbol]
  )
  return row?.t ? new Date(row.t).getTime() : null
}

async function fillOne(
  cfg: {exchange: string; marketType: string; apiBase?: string},
  symbol: string,
  pair: string,
  interval: KlineInterval,
  rps: number
): Promise<void> {
  const ms = MS[interval]
  const from = Date.now() - WINDOWS_DAYS[interval] * DAY_MS
  const have = await earliestOf(symbol, interval)
  if (have !== null && have <= from + ms) {
    totals.skipped++
    return
  }
  let end = have ?? Date.now()
  let guard = 0
  while (end > from && guard++ < 200) {
    const start = Math.max(from, end - PAGE * ms)
    const want = Math.min(PAGE, Math.round((end - start) / ms))
    if (want < 1) break
    await rateLimit(rps)
    totals.requests++
    let bars: {timestamp: number; open: number; high: number; low: number; close: number; volume: number}[]
    try {
      bars = await fetchCandlesRange({
        exchangeId: cfg.exchange,
        symbol,
        timeframe: interval,
        from: start,
        to: end,
        marketType: cfg.marketType as never,
        apiBase: cfg.apiBase,
        maxCandles: want
      })
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (/-1003|Too many requests|RateBudget/.test(msg)) {
        totals.limited++
        console.warn(`[seed] 限流，歇 30 秒（${symbol} ${interval}）：${msg.slice(0, 80)}`)
        await sleep(30_000)
        continue
      }
      totals.failed++
      console.warn(`[seed] 失败（${symbol} ${interval}）：${msg.slice(0, 100)}`)
      break
    }
    const rows: NewCandleRow[] = bars
      .filter(b => b.timestamp >= start && b.timestamp < end)
      .map(b => ({
        exchange: cfg.exchange,
        marketType: cfg.marketType,
        symbol,
        pair,
        interval,
        openTime: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        quoteVolume: 0,
        trades: 0,
        takerBuyVolume: 0,
        source: 'seed'
      }))
    if (!rows.length) break
    await saveCandles(rows)
    totals.rows += rows.length
    const earliest = Math.min(...rows.map(r => r.openTime))
    if (earliest >= end) break
    end = earliest
  }
}

async function main(): Promise<void> {
  const args = parseArgs()
  await ensureSchema()
  const c = loadConfig()
  const cfg = {exchange: c.exchange, marketType: c.marketType as string, apiBase: c.apiBase}
  let symbols = await listPerpetualSymbols({exchangeId: cfg.exchange, apiBase: cfg.apiBase})
  if (args.symbols !== 'all') {
    const n = Number(args.symbols)
    if (Number.isFinite(n) && n > 0) symbols = symbols.slice(0, n)
    else symbols = symbols.filter(s => s.base === args.symbols.toUpperCase())
  }
  const jobs: {symbol: string; pair: string; interval: KlineInterval}[] = []
  for (const s of symbols) {
    for (const interval of args.intervals) jobs.push({symbol: s.symbol, pair: s.pair, interval})
  }
  console.log(
    `[seed] ${symbols.length} 个币 × ${args.intervals.length} 档 = ${jobs.length} 个任务；` +
      `${args.rps} 发/秒（≈${args.rps * WEIGHT_PER_REQUEST * 60} 权重/分钟）、并发 ${args.conc}`
  )
  const t0 = Date.now()
  let done = 0
  let i = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[i++]
      if (!job) return
      await fillOne(cfg, job.symbol, job.pair, job.interval, args.rps)
      done++
      if (done % 50 === 0 || done === jobs.length) {
        const min = (Date.now() - t0) / 60_000
        console.log(
          `[seed] ${done}/${jobs.length} 任务 | 请求 ${totals.requests} | 写入 ${totals.rows} 行 | ` +
            `跳过 ${totals.skipped} | 限流 ${totals.limited} | 失败 ${totals.failed} | ` +
            `${min.toFixed(1)} 分钟（${(totals.requests / Math.max(1, min)).toFixed(0)} 发/分钟）`
        )
      }
    }
  }
  await Promise.all(Array.from({length: args.conc}, () => worker()))
  console.log(
    `[seed] 完成：${jobs.length} 个任务、请求 ${totals.requests}、写入 ${totals.rows} 行、` +
      `跳过 ${totals.skipped}、限流 ${totals.limited}、失败 ${totals.failed}，` +
      `用时 ${((Date.now() - t0) / 60_000).toFixed(1)} 分钟`
  )
}

main()
  .catch(e => {
    console.error('[seed] 挂了：', (e as Error).message)
    process.exitCode = 1
  })
  .finally(() => closePool().catch(() => undefined))
