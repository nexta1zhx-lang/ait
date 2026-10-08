/**
 * K 线**连续性审计**：把每一（币 × 档）整条序列按「行数 vs 跨度」核一遍，可选顺手补回来。
 *
 * ## 为什么是**手动脚本**、而不是底座里定时跑（2026-10-08 用户定）
 *
 * 用户的判断：默认历史数据本来就是好的，洞是**事故**（掉线 / 磁盘被打满）留下的，
 * 出了事我自己跑一遍就行 —— 没必要为一件"平时没事"的事在服务里常驻一个定时任务。
 * 代码里也有同样的先例：贵的「全量残桶体检」就是手动入口（`GET /api/kline/gaps?run=full`），
 * 定时那套早就换成记账式复核了。
 *
 * ## 它补的是哪一类洞（底座两条路**结构上**都看不见的）
 *
 * ```
 * repairSweep   ：从【库里最后一根】往现在补 —— 够不到它后面更早的洞；
 * runGapCheck ②：窗口只有 120 根，而且 expected 是从
 *                 「这个币在【窗口里】最早那根」开始数的
 *                 ⇒ 洞只要顶到窗口左沿就完全隐形。
 * ```
 *
 * 实测（2026-10-08，本地事故后）：1m 缺 **620,603 分钟（11.4%）**，而巡检报出来的
 * 1m 缺口**全是「差 1 根」的边界噪音**。拆开看全在两个地方：
 * 10-07（磁盘风暴）520,006 分钟 / 5,427 个洞；10-08（掉线 3.6 小时）100,579 分钟 / 855 个洞。
 *
 * ## 为什么它跑得起（别把它改成"连值一起比"）
 *
 * 判据只用 `count(*)` / `min` / `max` —— 这三样**全在主键索引里**
 * （`(exchange, market_type, symbol, interval, open_time)`）⇒ **纯索引扫描、零堆访问**。
 * 实测全 6 档 **≈8 秒**（1m 3.5s / 5m 0.9 / 15m 1.2 / 1h 1.6 / 4h 0.4 / 1d 0.3）。
 *
 * ⚠️ 千万别顺手把 `sum(volume)` / `array_agg(close)` 加进来：那两列**不在索引里**，
 *    每行都要回堆取页 —— 老的全量自洽扫描就是这么变成 **4 分 40 秒** 的
 *    （也正是 2026-10-08 那次「发布后全站 502 三分钟」的元凶，见 docs/EXCHANGE.md 第 52/53 节）。
 *
 * ## 用法
 *
 * ```
 * npm run candles:audit                       # 只报告，什么都不写（默认）
 * npm run candles:audit -- --repair           # 顺手补回来
 * npm run candles:audit -- --repair --intervals=1m --oldest=20
 * npm run candles:audit -- --symbols=BTC/USDT:USDT,ETH/USDT:USDT
 * ```
 *
 *   `--repair`          真的去补（默认只报告）
 *   `--intervals=`      只审这几档（默认 1m,5m,15m,1h,4h,1d）
 *   `--symbols=`        只审这几个币（ccxt 统一符号，逗号分隔）
 *   `--oldest=N`        打印最老的 N 个洞（默认 10）
 *   `--max=N`           最多修几个洞（默认 0 = 不限）
 *   `--maxcalls=N`      一个洞最多往前打几发（默认 8）
 *
 * **退出码**：还有洞就 `1`（干净是 `0`）—— 方便挂到别的地方当检查用。
 *
 * ⚠️ 补的时候要**出口能连交易所**（跟 `seed-candles.ts` 一样要代理）：
 *    `EXCHANGE_PROXY=http://127.0.0.1:8888 NODE_USE_ENV_PROXY=1 HTTPS_PROXY=... npm run candles:audit -- --repair`
 */
import {closePool} from '../db/client'
import {
  ALL_INTERVALS,
  KLINE_RETENTION,
  auditContiguity,
  keepMs,
  onlyMissing,
  saveCandles,
  type ContiguityGap,
  type KlineInterval,
  type NewCandleRow
} from '../db/candle-store'
import {fetchCandlesRange} from '../data/market'
import {loadConfig} from '../config'
import {RateBudgetError, takeWeight} from '../util/rate-budget'

const MIN_MS = 60_000
const MS: Record<KlineInterval, number> = {
  '1m': MIN_MS,
  '5m': 5 * MIN_MS,
  '15m': 15 * MIN_MS,
  '1h': 60 * MIN_MS,
  '4h': 240 * MIN_MS,
  '1d': 1440 * MIN_MS
}

/** 一发最多要多少根（ccxt 每页 1000；1500 最多两页，跟底座 `repairSymbol` 同口径） */
const PAGE = 1500
/**
 * 一次请求的权重（照底座 `repairSymbol` 的记账：1m 两页按 15、高周期按 5）。
 * ⚠️ 只是**记账口径**，实际拦不拦由 `takeWeight` 那个 1200/分钟的窗口决定。
 */
function weightOf(interval: KlineInterval): number {
  return interval === '1m' ? 15 : 5
}

/** 一次最多往前补多久（= `maxcalls` 发）——防止某个洞老到把预算打光 */
const DEFAULT_MAX_CALLS = 8

interface Args {
  repair: boolean
  intervals: KlineInterval[]
  symbols: string[]
  oldest: number
  max: number
  maxcalls: number
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const hit = argv.find(a => a === `--${k}` || a.startsWith(`--${k}=`))
    if (!hit) return undefined
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
  }
  const num = (k: string, dflt: number): number => {
    const v = Number(get(k))
    return Number.isFinite(v) && v > 0 ? v : dflt
  }
  const list = (k: string): string[] =>
    (get(k) ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  const intervals = list('intervals') as KlineInterval[]
  for (const it of intervals) {
    if (!MS[it]) throw new Error(`--intervals 里有不认识的周期：${it}`)
  }
  return {
    repair: argv.includes('--repair'),
    intervals: intervals.length ? intervals : ALL_INTERVALS,
    symbols: list('symbols'),
    oldest: num('oldest', 10),
    max: num('max', 0),
    maxcalls: num('maxcalls', DEFAULT_MAX_CALLS)
  }
}

const fmt = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 16)

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig()
  const scope = {exchange: cfg.exchange, marketType: cfg.marketType}

  console.log(
    `连续性审计：${scope.exchange}|${scope.marketType}，档位 ${args.intervals.join('/')}` +
      (args.symbols.length ? `，币 ${args.symbols.length} 个` : '，全部币') +
      (args.repair ? '（会顺手补）' : '（只报告）')
  )

  const t0 = Date.now()
  const gaps = await auditContiguity(scope, args.intervals, args.symbols)
  const spent = ((Date.now() - t0) / 1000).toFixed(1)
  const missing = gaps.reduce((s, g) => s + g.missing, 0)
  console.log(`扫描完成：${spent} 秒，${gaps.length} 组有洞、共缺 ${missing} 根\n`)

  /* 逐档一行：组数 / 缺根 / 缺的比例 */
  const byInterval = new Map<KlineInterval, {n: number; miss: number; expected: number}>()
  for (const g of gaps) {
    const c = byInterval.get(g.interval) ?? {n: 0, miss: 0, expected: 0}
    c.n++
    c.miss += g.missing
    c.expected += g.expected
    byInterval.set(g.interval, c)
  }
  console.log('档位   有洞的币   缺根        该有        缺的比例')
  for (const it of args.intervals) {
    const c = byInterval.get(it)
    if (!c) {
      console.log(`${it.padEnd(6)}         0  ${'—'.padStart(10)}  ${'—'.padStart(10)}   OK`)
      continue
    }
    console.log(
      `${it.padEnd(6)} ${String(c.n).padStart(9)} ${String(c.miss).padStart(10)} ` +
        `${String(c.expected).padStart(11)} ${((100 * c.miss) / c.expected).toFixed(2)}%`
    )
  }

  if (!gaps.length) {
    console.log('\n整条序列都连续，没有洞。')
    return
  }

  console.log(`\n最老的 ${Math.min(args.oldest, gaps.length)} 个洞（1m 只留 7 天，越老越急）：`)
  for (const g of gaps.slice(0, args.oldest)) {
    console.log(
      `  ${g.interval.padEnd(4)} ${g.symbol.padEnd(22)} 缺 ${String(g.missing).padStart(6)}` +
        `/${String(g.expected).padStart(6)}   ${fmt(g.holeFrom)} → ${fmt(g.holeTo)}`
    )
  }

  if (!args.repair) {
    console.log('\n（只报告。要补就加 `-- --repair`）')
    process.exitCode = 1
    return
  }

  const todo = args.max > 0 ? gaps.slice(0, args.max) : gaps
  console.log(`\n开始补：${todo.length} 个洞（一个洞最多往前 ${args.maxcalls} 发）`)
  let done = 0
  let written = 0
  let failed = 0
  for (const [i, g] of todo.entries()) {
    try {
      const w = await repairOne(cfg, scope, g, args.maxcalls)
      written += w
      done++
      if (i % 20 === 0 || i === todo.length - 1) {
        console.log(
          `  [${i + 1}/${todo.length}] ${g.interval} ${g.symbol} 写了 ${w} 行` +
            `（累计 ${written} 行，失败 ${failed}）`
        )
      }
    } catch (e) {
      failed++
      const msg = (e as Error).message.slice(0, 120)
      console.warn(`  ✗ ${g.interval} ${g.symbol} 补失败：${msg}`)
      /* 被限流就歇久一点再继续，别把 IP 打得更死 */
      if (e instanceof RateBudgetError) await new Promise(r => setTimeout(r, 20_000))
    }
  }
  console.log(`补完：处理 ${done} 个洞，写入 ${written} 行，失败 ${failed} 个`)

  /* 复核一遍：让"到底还有没有洞"由数据说话，而不是由刚写的代码说 */
  console.log('\n复核：')
  const again = await auditContiguity(scope, args.intervals, args.symbols)
  const stillMissing = again.reduce((s, g) => s + g.missing, 0)
  console.log(`  ${again.length} 组还有洞、共缺 ${stillMissing} 根（原先 ${gaps.length} 组 / ${missing} 根）`)
  if (again.length) {
    console.log('  还剩（最老 5 个）：')
    for (const g of again.slice(0, 5)) {
      console.log(
        `    ${g.interval.padEnd(4)} ${g.symbol.padEnd(22)} 缺 ${g.missing}/${g.expected}  ${fmt(g.holeFrom)}`
      )
    }
    console.log(
      '  取不回来的可能是：那一段交易所自己也没有（下架/停牌）、或者已经超过\n' +
        '  `/fapi/v1/userTrades` 之外的接口上限（K 线区间接口最多往回给 1500 根/发 × ' +
        `${args.maxcalls} 发）。`
    )
    process.exitCode = 1
  }
}

/**
 * 补一个洞：从 `holeFrom` 起往现在补，每次最多 `PAGE` 根、总共最多 `maxcalls` 发。
 *
 * ## ⚠️ 只写"库里没有的桶"（`onlyMissing`）——这是本脚本最重要的约束
 *
 * `fetchCandlesRange` 走 ccxt，**只有 OHLCV**：`trades` / `quote_volume` / `taker_buy_volume`
 * 一律得填 0。而库里同一个桶可能是 `vision`（官方历史包，字段全）或 `rollup`（由 ws 的 1m 滚出，
 * 笔数也是真的）写进去的。所以**覆盖写 = 拿 0 盖掉真值**。
 *
 * 实测（就是本脚本第一次跑出来的真事）：15m 的 05:00 桶原本 523 行里 468 行带真实笔数，
 * `--repair` 之后被它覆盖的那 2 个币变成了 `trades=0 / quote_volume=0`（`source='audit'`）。
 * 现在改成 insert-only 之后**永远不会**发生这种事：补洞只加行，不替换。
 *
 * 想"修一个已经存在但值不对的桶"是**另一件事**，走底座的残桶复核
 * （`kline_pending_check`），那条路才需要覆盖写。
 */
async function repairOne(
  cfg: ReturnType<typeof loadConfig>,
  scope: {exchange: string; marketType: string},
  g: ContiguityGap,
  maxcalls: number
): Promise<number> {
  const ms = MS[g.interval]
  const now = Date.now()
  const keep = KLINE_RETENTION[g.interval]
  /* 保留期之外的一律不补（1m/5m 7 天、15m 30 天、1h 400 天；永久档给 3 年） */
  const floor = now - (keep ? keepMs(keep) : 3 * 365 * 24 * 3600 * 1000)
  const to = Math.floor(now / ms) * ms
  let at = Math.max(Math.floor(Math.max(g.holeFrom, floor) / ms) * ms, to - maxcalls * PAGE * ms)
  if (at > g.holeFrom) {
    console.warn(
      `  ⚠️ ${g.interval} ${g.symbol} 的洞（${fmt(g.holeFrom)}）超出保留期或 ${maxcalls} 发上限，` +
        `只能从 ${fmt(at)} 起补`
    )
  }
  let written = 0
  for (let calls = 0; at < to && calls < maxcalls; calls++) {
    const until = Math.min(to, at + PAGE * ms)
    await takeWeight(weightOf(g.interval), `audit ${g.interval} ${g.symbol}`)
    const bars = await fetchCandlesRange({
      exchangeId: cfg.exchange,
      symbol: g.symbol,
      timeframe: g.interval,
      from: at,
      to: until,
      marketType: cfg.marketType,
      apiBase: cfg.apiBase,
      maxCandles: PAGE
    })
    /*
     * ⚠️ 只留**已收盘**的（`timestamp + ms <= now`）：交易所区间接口会把正在走的那根也返回，
     *    不滤掉就会往库里写一根量只有半截的假桶（2026-10-07 实测踩过 5 币 × 5 档）。
     */
    const rows: NewCandleRow[] = bars
      .filter(b => b.timestamp >= at && b.timestamp + ms <= now)
      .map(b => ({
        exchange: scope.exchange,
        marketType: scope.marketType,
        symbol: g.symbol,
        pair: g.symbol,
        interval: g.interval,
        openTime: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        /* ccxt 的 OHLCV 没有这三样 ⇒ 0（跟底座 seed/backfill 同一个口径，对账只比 OHLCV） */
        quoteVolume: 0,
        trades: 0,
        takerBuyVolume: 0,
        source: 'audit'
      }))
    /* ⚠️ 只留库里没有的桶（见上面那段）——补洞只加行，绝不覆盖已有的 */
    const fresh = await onlyMissing(rows, scope)
    if (fresh.length < rows.length) {
      console.log(`    · 跳过 ${rows.length - fresh.length} 根已存在的（补洞不覆盖写）`)
    }
    if (fresh.length) written += await saveCandles(fresh)
    at = until
  }
  return written
}

void main()
  .catch(e => {
    console.error(`连续性审计失败：${(e as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => void closePool())
