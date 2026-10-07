/**
 * 本地补历史 K 线（走 REST/ccxt）→ 之后整表导入线上库（用户 2026-10-07：
 * 「历史数据用脚本在本地数据库补上后续直接导入库数据」）。
 *
 * ★ 分工（2026-10-07 追加，别搞混）：**1m/5m/15m/1h/4h 优先走 `seed-vision.ts`**
 *   （币安官方历史包，直连、0 权重、字段更全，实测 1067 包/分钟）。本脚本的活是：
 *     · `--intervals=1d`：1d 的包是 34 个文件/币，REST 一发 1000 根更便宜 ⇒ **1d 就归这里**；
 *     · 补尾：包有 T+1 发布延迟（还有几小时空白）⇒ 用本脚本按窗口重跑一遍把尾段补齐
 *       （断点续跑，已补的会跳过）。
 *   两个脚本都跑完再 `npm run candles:sync` 导线上。
 *
 * 为什么不在线上灌：线上出口 IP 要跟交易/账户共用权重（2400/分钟），
 * 2026-10-07 就因为一次在线灌历史吃到 85 次 `-1003`。本地这台机器有独立出口，
 * 一次性把历史拉全、再整表导过去，线上只付「导入」这一次。
 *
 * ⚠️ REST 的代价（实测）：一发权重 **5**（ccxt 每次要 1000 根），并发拉到 8、14 发/秒
 *   会把自己打进 `-1003` —— 提速就是撞墙，这也是换官方包的根本原因。
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
import {ensureSchema, closePool, query, queryOne} from '../db/client'
import {saveCandles, type KlineInterval, type NewCandleRow} from '../db/candle-store'
import {fetchCandlesRange, listPerpetualSymbols} from '../data/market'
import {loadConfig} from '../config'

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

interface Range {
  start: number
  end: number
}

/**
 * 库里在 [from, to) 内**缺哪些段**（左闭右开）。
 *
 * ★ 为什么不是「看头部够不够就跳过」（2026-10-07 修的）：
 *   原来只看 `min(open_time) <= from + ms` 就认定「整窗都有」—— 可窗口里可能有**洞**：
 *   底座只保证「部署之后」的那段（线上实测 1m 只有最近 28 分钟），
 *   `repairSweep` 也只修**尾**、不修内部洞 ⇒ vision 段（10-05 23:59 止）和实时段之间
 *   会留下约 27 小时的空洞，而头部检查根本发现不了。
 *   现在按「头 / 中间 / 尾」三段一起算，只补缺的。
 */
async function missingRanges(
  symbol: string,
  interval: KlineInterval,
  from: number,
  to: number,
  ms: number
): Promise<Range[]> {
  const head = await queryOne<{a: Date | null; b: Date | null; n: number}>(
    `SELECT min(open_time) AS a, max(open_time) AS b, count(*)::int AS n
       FROM candles
      WHERE interval = $1 AND symbol = $2 AND open_time >= $3 AND open_time < $4`,
    [interval, symbol, new Date(from), new Date(to)]
  )
  if (!head?.a || !head?.b || !head.n) return [{start: from, end: to}]
  const a = new Date(head.a).getTime()
  const b = new Date(head.b).getTime()
  const out: Range[] = []
  if (a > from) out.push({start: from, end: a})
  if (b + ms < to) out.push({start: b + ms, end: to})
  // 根数对不上跨度 ⇒ 中间有洞，逐段找出来
  if (head.n < Math.floor((b - a) / ms) + 1) {
    const rows = await query<{a: Date; b: Date}>(
      `WITH s AS (
         SELECT open_time, lead(open_time) OVER (ORDER BY open_time) AS nxt
           FROM candles
          WHERE interval = $1 AND symbol = $2 AND open_time >= $3 AND open_time < $4
       )
       SELECT open_time AS a, nxt AS b
         FROM s
        WHERE nxt IS NOT NULL AND nxt > open_time + ($5::bigint * interval '1 millisecond')
        ORDER BY 1`,
      [interval, symbol, new Date(from), new Date(to), ms]
    )
    for (const r of rows) {
      out.push({start: new Date(r.a).getTime() + ms, end: new Date(r.b).getTime()})
    }
  }
  return out.filter(r => r.end > r.start).sort((x, y) => x.start - y.start)
}

/** 补一段（从 end 往回一页一页拉） */
async function fillRange(
  cfg: {exchange: string; marketType: string; apiBase?: string},
  symbol: string,
  pair: string,
  interval: KlineInterval,
  range: Range,
  rps: number
): Promise<void> {
  const ms = MS[interval]
  const from = range.start
  let end = range.end
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

async function fillOne(
  cfg: {exchange: string; marketType: string; apiBase?: string},
  symbol: string,
  pair: string,
  interval: KlineInterval,
  rps: number
): Promise<void> {
  const ms = MS[interval]
  const now = Date.now()
  /*
   * ⚠️ 两端都要对齐到**桶栅格**（2026-10-07 修的）：
   *   · 起点不对齐 ⇒ 头部会算出一个「不到一根」的残缺缺口，白拉一发还被区间过滤掉（写 0 行）；
   *   · 终点用 now ⇒ 会把**正在走的当前桶**也拉回来写进去（残桶：量偏小、high/low 漏点）。
   *   对齐到「已收盘的桶」之后，缺口就是整数根，拉回来的每一根都能原样入库。
   */
  const from = Math.floor((now - WINDOWS_DAYS[interval] * DAY_MS) / ms) * ms
  const to = Math.floor(now / ms) * ms
  const ranges = await missingRanges(symbol, interval, from, to, ms)
  if (!ranges.length) {
    totals.skipped++
    return
  }
  for (const range of ranges) {
    await fillRange(cfg, symbol, pair, interval, range, rps)
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
