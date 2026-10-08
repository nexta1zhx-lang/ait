#!/usr/bin/env node
/**
 * 离线自检：验证「契约 ↔ zod ↔ 渲染」这条链路。
 *
 *   npm run selftest
 *
 * 不依赖网络、不依赖 API Key，也**不需要先编译**（用 tsx 直接跑 TS）。
 *
 * 2026-10-02 大简化之后，护栏 / 仓位 / 止损止盈 / 期望值 / 清单全删了。
 * 2026-10-07 又加进来一件：**K 线写入前校验**（`sanitizeRows`）。
 * 那是个纯函数，而它的失效方式是"悄悄少一根 / 悄悄多一根坏根"—— 图上不报错，
 * 只有靠这组固定夹具才卡得住。所以必须离线可跑（不进网络）。
 *
 * 现在这里卡六件事：
 *   ① 契约（提示词骨架）和 zod 校验结构**一模一样**
 *   ② 渲染能把这四个字段印出来
 *   ③ `sanitizeRows` 该丢的丢、该留的留、该覆盖的覆盖
 *   ④ `planContractChanges` 该加的加、该摘的摘（新币 / 下架 / 待上线）
 *   ⑤ 「这个币刚被平仓」判得对不对 + 撤残留单的去抖（平了就撤，见 `docs/EXCHANGE.md`）
 *   ⑥ 三档（normal / idle / asleep）的判据 + 换档日志里的数字（见 `tierOf` / `tierText`）
 *   ⑦ 分区命名 / 时间格边界 / 保留期解析（见 `partNameOf` / `periodStartOf` / `keepMs`）
 *   ⑧ 币安历史窗口切分（见 `data/exchange-trade.ts` 的 `planWindows`）
 *      —— 这几个是**纯函数**，而它们的失效方式同样很隐蔽：命名约定一变，
 *      `pruneCandles` 就再也匹配不到过期子分区（表会一直涨），或者建分区时算出重叠区间
 *      （直接建不出来）。所以拿固定夹具卡住它们。
 */
import {
  ALL_INTERVALS,
  KLINE_RETENTION,
  PART_GRANULARITY,
  keepMs,
  parsePartName,
  partNameOf,
  periodEndOf,
  periodStartOf,
  sanitizeRows,
  type NewCandleRow
} from '../db/candle-store'
import {planContractChanges, type RawContract} from '../data/market'
import {
  BINANCE_MAX_WINDOW_MS,
  BINANCE_RETENTION_MS,
  planWindows
} from '../data/exchange-trade'
import {
  KeyStream,
  ORPHAN_SWEEP_GAP_MS,
  tierOf,
  tierText,
  type Tier,
  orphanSweepTargets
} from '../exchange-stream'
import type {JudgeResult} from '../llm/client'
import {OUTPUT_CONTRACT} from '../llm/prompt'
import {judgeSchema} from '../llm/schema'
import {render} from '../output/render'
import type {MarketSnapshot} from '../types'

/* ------------------------------------------------------------------ */
/* ① 契约防漂移                                                        */
/* ------------------------------------------------------------------ */

/** 契约骨架里声明的顶层字段（骨架里就 2 空格缩进的 "xxx": 那些） */
function contractFields(): string[] {
  return [...OUTPUT_CONTRACT.matchAll(/^ {2}"([A-Za-z][A-Za-z0-9_]*)":/gm)].map(
    m => m[1]
  )
}

/** 撕掉 .catch() 包装 */
const unwrap = (t: any) =>
  typeof t?.removeCatch === 'function' ? t.removeCatch() : t

/** 取某个 zod 枚举的取值 */
function zodOptions(t: any): string[] {
  const opts = unwrap(t)?.options
  return Array.isArray(opts) ? opts : []
}

/**
 * 契约里的字段名必须和 `judgeSchema` 一致。
 *
 * 为什么必须卡：schema 里到处是 `.catch()` 兜底，**只改一边不会报错**，
 * 只会静默把字段丢掉或补默认值 —— 这种问题肉眼很难发现。
 */
function checkContract(): boolean {
  let ok = true
  const declared = contractFields()
  const actual = Object.keys(judgeSchema.shape)

  const missing = actual.filter(k => !declared.includes(k))
  const extra = declared.filter(k => !actual.includes(k))
  if (missing.length) {
    console.error(`❌ 契约少字段（zod 有、提示词没写）：${missing.join('、')}`)
    ok = false
  }
  if (extra.length) {
    console.error(`❌ 契约多字段（提示词写了、zod 没有）：${extra.join('、')}`)
    ok = false
  }

  const enums: [string, string[]][] = [
    ['verdict', zodOptions(judgeSchema.shape.verdict)]
  ]
  for (const [name, opts] of enums) {
    if (!opts.length) {
      console.error(`❌ 取不到 ${name} 的枚举（zod 结构变了？）`)
      ok = false
      continue
    }
    if (!OUTPUT_CONTRACT.includes(opts.join(' | '))) {
      console.error(
        `❌ 契约里 ${name} 的取值和 zod 不一致，应为：${opts.join(' | ')}`
      )
      ok = false
    }
  }

  if (ok) {
    console.log(
      `契约一致性: ✅ ${actual.length} 个字段 / ${enums.length} 处枚举 全对得上`
    )
  }
  return ok
}

/* ------------------------------------------------------------------ */
/* ② 夹具（手写的行情与判断结果，跟真实 AI 输出无关）                    */
/* ------------------------------------------------------------------ */

const close = 60000

function structure(up: boolean) {
  return {
    higherHighs: up,
    higherLows: up,
    lowerHighs: !up,
    lowerLows: !up,
    lastSwingHigh: close * 1.01,
    lastSwingLow: close * 0.975,
    swingHigh: close * 1.03,
    swingLow: close * 0.96,
    lookback: 50
  }
}

function tf(
  timeframe: string,
  trend: 'up' | 'down' | 'range',
  netChangePct: number,
  volRatio: number
) {
  return {
    timeframe,
    close,
    trend,
    netChangePct,
    rangePct: 3,
    volRatio,
    volTrend: trend === 'up' ? 1.3 : trend === 'down' ? 0.7 : 0.9,
    structure: structure(trend === 'up'),
    stats: {
      bars: 60,
      resistance: close * 1.03,
      support: close * 0.96,
      rangePositionPct: trend === 'up' ? 85 : trend === 'down' ? 15 : 50,
      pullbackFromHighPct: trend === 'up' ? 2 : 8,
      avgRangePct: 1.2,
      avgVolume: 120000,
      upBars: 12,
      downBars: 8,
      streak: trend === 'up' ? 2 : trend === 'down' ? -2 : 0
    }
  }
}

const snapshot: MarketSnapshot = {
  symbol: 'TEST/USDT',
  exchange: 'test',
  timestamp: Date.now(),
  price: close,
  primary: '1h',
  blocks: [
    {
      timeframe: '1h',
      primary: true,
      days: 3,
      bars: 72,
      from: Date.now() - 72 * 3600_000,
      to: Date.now(),
      text: '【整段速览】共 72 根，+2.00%，振幅 3.00%'
    }
  ],
  heat: {
    fundingRate: 0.0001,
    openInterest: 5000,
    openInterestChangePct: 2.5,
    quoteVolume24h: 1000000,
    change24hPct: 3.2,
    amplitude24hPct: 4.1,
    longShortRatio: 1.8,
    high24h: close * 1.02,
    low24h: close * 0.98
  },
  candles: []
}

/** AI 只回这六个字段 */
const judge: JudgeResult = {
  tags: [
    {name: '放量突破', probability: 70},
    {name: '缩量横盘', probability: 30}
  ],
  reason: '第 2 小段开始放量，1h 回踩没破前一段低点，量能越走越强。',
  outlook: '先回踩 1h 区间下沿附近，再往上试前面那个高点。',
  probability: 65,
  verdict: 'go',
  recommendation: '现在别追，等回踩不破再进；跌破区间下沿就不看。'
}

/* ------------------------------------------------------------------ */
/* ③ K 线写入前校验（`db/candle-store.ts` 的 `sanitizeRows`）             */
/* ------------------------------------------------------------------ */

function row(over: Partial<NewCandleRow>): NewCandleRow {
  return {
    exchange: 'binance',
    marketType: 'swap',
    symbol: 'BTC/USDT:USDT',
    pair: 'BTCUSDT',
    interval: '1h',
    /* 对齐到小时栅格 */
    openTime: 1_759_788_000_000 - ((1_759_788_000_000 % 3_600_000) | 0),
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 10,
    quoteVolume: 1000,
    trades: 5,
    takerBuyVolume: 6,
    source: 'ws',
    ...over
  }
}

type Check = [string, NewCandleRow[], (out: NewCandleRow[]) => boolean]

const badRow = row({openTime: 1_759_788_000_000 - (1_759_788_000_000 % 3_600_000) + 60_000}) // 没对齐钟点
const checks: Check[] = [
  ['正常一根：原样放行', [row({})], out => out.length === 1],
  ['未对齐桶栅格：丢', [badRow], out => out.length === 0],
  ['high 比 close 还低：丢', [row({high: 99})], out => out.length === 0],
  ['low 比 open 还高：丢', [row({low: 101})], out => out.length === 0],
  ['价格是 0：丢', [row({close: 0})], out => out.length === 0],
  ['量是负的：丢', [row({volume: -1})], out => out.length === 0],
  ['值是 NaN：丢', [row({high: Number.NaN})], out => out.length === 0],
  [
    '同批同桶重复：只留一根（后来的赢）',
    [row({close: 105}), row({close: 108})],
    out => out.length === 1 && out[0].close === 108
  ],
  [
    '同批时间倒序：两根都留（幂等，只计数）',
    [row({openTime: 1_759_788_000_000 - (1_759_788_000_000 % 3_600_000) + 3_600_000}), row({})],
    out => out.length === 2
  ],
  [
    '两个币各自单调：互不影响',
    [row({}), row({symbol: 'ETH/USDT:USDT', pair: 'ETHUSDT', openTime: 1_759_788_000_000 - (1_759_788_000_000 % 3_600_000) + 3_600_000})],
    out => out.length === 2
  ]
]

function checkSanitize(): boolean {
  let ok = true
  for (const [name, input, want] of checks) {
    const out = sanitizeRows(input)
    if (!want(out)) {
      console.error(`❌ 写入前校验：${name} —— 期望不满足（实际留下 ${out.length} 根）`)
      ok = false
    }
  }
  if (!ok) console.log('')
  else console.log(`✅ 写入前校验：${checks.length} 组夹具通过`)
  return ok
}

/* ------------------------------------------------------------------ */
/* ④ 合约发现的 diff（`data/market.ts` 的 `planContractChanges`）         */
/* ------------------------------------------------------------------ */

function raw(pair: string, status: string, onboardAt: number | null = null): RawContract {
  const base = pair.replace(/USDT$/, '')
  return {pair, symbol: `${base}/USDT:USDT`, base, status, onboardAt}
}
const sub = (pair: string): {pair: string} => ({pair})

type DiffCheck = [
  string,
  RawContract[],
  Array<{pair: string}>,
  (r: {add: RawContract[]; drop: Array<{pair: string}>}) => boolean
]

const diffChecks: DiffCheck[] = [
  ['完全同步：什么都不做', [raw('BTCUSDT', 'TRADING'), raw('ETHUSDT', 'TRADING')], [sub('BTCUSDT'), sub('ETHUSDT')], r => !r.add.length && !r.drop.length],
  ['新上线：加', [raw('BTCUSDT', 'TRADING'), raw('NEWUSDT', 'TRADING', 1)], [sub('BTCUSDT')], r => r.add.length === 1 && r.add[0].pair === 'NEWUSDT'],
  ['待上线（PENDING_TRADING）：**不加** —— 还不能交易', [raw('BTCUSDT', 'TRADING'), raw('NEWUSDT', 'PENDING_TRADING')], [sub('BTCUSDT')], r => !r.add.length && !r.drop.length],
  ['下架（从清单里消失）：摘', [raw('BTCUSDT', 'TRADING')], [sub('BTCUSDT'), sub('GONEUSDT')], r => r.drop.length === 1 && r.drop[0].pair === 'GONEUSDT'],
  ['下架（还在清单里但 status 变了）：摘', [raw('BTCUSDT', 'TRADING'), raw('OMGUSDT', 'SETTLING')], [sub('BTCUSDT'), sub('OMGUSDT')], r => !r.add.length && r.drop.length === 1 && r.drop[0].pair === 'OMGUSDT'],
  ['下架的币又回到 TRADING：不摘也不重复加', [raw('BTCUSDT', 'TRADING'), raw('BACKUSDT', 'TRADING')], [sub('BTCUSDT'), sub('BACKUSDT')], r => !r.add.length && !r.drop.length],
  ['大小写不敏感（上游大小写变了不算新币）', [raw('BTCUSDT', 'TRADING')], [sub('btcusdt')], r => !r.add.length && !r.drop.length]
]

function checkDiff(): boolean {
  let ok = true
  for (const [name, rawList, subscribed, want] of diffChecks) {
    const got = planContractChanges(rawList, subscribed)
    if (!want(got)) {
      console.error(`❌ 合约 diff：${name} —— 期望不满足（加 ${got.add.length} / 摘 ${got.drop.length}）`)
      ok = false
    }
  }
  if (ok) console.log(`✅ 合约 diff：${diffChecks.length} 组夹具通过`)
  return ok
}

/* ------------------------------------------------------------------ */
/* ④b 档位：有仓 / 有挂单就永远不睡（人不在线也一样）                   */
/* ------------------------------------------------------------------ */

/**
 * 卡「后端会不会因为没人看就把流/对账关小」的那条底线。
 *
 * 用户 2026-10-07 问：「现在我的合约有仓位的情况下，后端还会关闭 ws 吗」——
 * 答案必须是「不会」，而且**有仓 / 有单时连降档都不该发生**：
 * 降档后成交 / 挂单 / 账本变成 8~16 小时才轮一次（睡着档干脆全停），
 * 而止盈止损还在场的时候，中间那几个小时正好是最需要算准的。
 * 夹具用**真的那份 `tierOf()`**，别另写一份判断。
 */
function checkTier(): boolean {
  const H = 60 * 60 * 1000
  const cases: [{p: number; o: number; idle: number; deaf?: boolean; why: string}, string][] = [
    [{p: 1, o: 0, idle: 5 * H, why: '有仓 5 小时没动静'}, 'normal'],
    [{p: 0, o: 1, idle: 5 * H, why: '没仓但有一张挂在场的条件单'}, 'normal'],
    [{p: 1, o: 2, idle: 30 * 24 * H, why: '有仓 + 两张单，一个月没人管'}, 'normal'],
    [{p: 0, o: 0, idle: 5 * 60 * 1000, why: '空仓空单但才 5 分钟'}, 'normal'],
    [{p: 0, o: 0, idle: 30 * 60 * 1000, why: '空仓空单 30 分钟'}, 'idle'],
    [{p: 0, o: 0, idle: 5 * H, why: '空仓空单 5 小时'}, 'asleep'],
    [{p: 1, o: 0, idle: 5 * H, deaf: true, why: '有仓 + 流哑了'}, 'normal'],
    [{p: 0, o: 0, idle: 5 * H, deaf: true, why: '空仓 + 流哑了（哑了就不许睡）'}, 'normal']
  ]
  let ok = true
  for (const [c, want] of cases) {
    const got = tierOf({
      positions: c.p,
      openOrders: c.o,
      idleMs: c.idle,
      deaf: c.deaf === true
    })
    if (got !== want) {
      console.error(`❌ 档位：${c.why} 应为 ${want}，实际 ${got}`)
      ok = false
    }
  }
  if (ok) console.log(`✅ 档位：${cases.length} 组夹具通过（有仓/有单永不降档）`)
  return ok
}

/* ------------------------------------------------------------------ */
/* ④c 换档日志的文案：数字必须跟真节奏一致                              */
/* ------------------------------------------------------------------ */

/**
 * 卡「日志里那句话跟真的节奏一致」。
 *
 * 为什么值得单独卡：这段文案**被手抄过两版，两版都过时了**，而且只有人去读代码才发现 ——
 * 一版写「对账降频到 30 分钟一轮」（真的早就是 8 / 12 / 16 小时），
 * 另一版写「对账全 1 小时」（真的早就是 4 / 6 / 8 小时）。
 * 现在文案由 `tierText()` 从 `TIER_GAPS` 现算，这组夹具就是那个「现算」的守卫：
 * 谁改了节奏这里先红，逼你顺手把 `docs/EXCHANGE.md` 的档位表也改掉。
 */
function checkTierText(): boolean {
  const want: [Tier, string][] = [
    ['normal', '成交 4 小时 / 挂单 6 小时 / 账本 8 小时'],
    ['idle', '成交 8 小时 / 挂单 12 小时 / 账本 16 小时'],
    /* 睡着档只许说「停」—— `TIER_GAPS.asleep` 那三项永不生效，不许报出一个假节奏 */
    ['asleep', '对账全停']
  ]
  let ok = true
  for (const [tier, needle] of want) {
    const text = tierText(tier)
    if (!text.includes(needle)) {
      console.error(`❌ 档位文案：${tier} 该含「${needle}」，实际「${text}」`)
      ok = false
    }
  }
  if (ok) console.log(`✅ 档位文案：${want.length} 档的数字跟真节奏对得上`)
  return ok
}

/* ------------------------------------------------------------------ */
/* ⑤ 平仓 ⇒ 当场撤残留止盈止损单：判据 + 去抖                          */
/* ------------------------------------------------------------------ */

/**
 * 一条 `ACCOUNT_UPDATE` 里哪个币算「**刚被平掉**」—— 驱动的是**真的那份代码**
 * （`applyAccountUpdate`），不是这里另写一份判断。
 *
 * 为什么必须卡：判宽了（只要看见 `pa = 0` 就算）会对着**本来就没仓位的币**发撤单请求 ——
 *   一条账户事件里常带着一堆零仓位的币，那就是一串白打的 REST（权重白烧，还可能踩 `-1003`）；
 *   判窄了（漏掉）就回到用户 2026-10-07 报的那个「平完仓止盈止损还挂着」。
 */
function checkCloseSweep(): boolean {
  const ks = new KeyStream({id: 0} as any) as any
  /* `ex.market()` 拿不到就退回原始符号 —— 夹具里统一符号 == 币安原始符号，够用 */
  ks.ex = {market: () => null}
  const overview = (held: string[]): any => ({
    futures: {
      wallet: 100,
      positions: held.map(symbol => ({symbol, entryPrice: 1, unrealizedPnl: 0}))
    }
  })
  const cases: [string, string[], any[], string[]][] = [
    ['整个仓平掉', ['BTCUSDT'], [{s: 'BTCUSDT', pa: '0'}], ['BTCUSDT']],
    ['本来就没这个仓（只是又收了一条零仓事件）', [], [{s: 'BTCUSDT', pa: '0'}], []],
    ['仓位还在（只是均价变了）', ['BTCUSDT'], [{s: 'BTCUSDT', pa: '0.5', ep: '1.1'}], []],
    ['一半平一半留', ['BTCUSDT', 'ETHUSDT'], [{s: 'BTCUSDT', pa: '0'}, {s: 'ETHUSDT', pa: '2'}], ['BTCUSDT']],
    ['平旧仓 + 开新仓混在一批', ['BTCUSDT'], [{s: 'BTCUSDT', pa: '0'}, {s: 'SOLUSDT', pa: '3'}], ['BTCUSDT']]
  ]
  let ok = true
  for (const [name, held, changed, want] of cases) {
    ks.lastOverview = overview(held)
    const got: string[] = ks.applyAccountUpdate({B: [], P: changed}).closedSymbols
    if (got.join(',') !== want.join(',')) {
      console.error(`❌ 平仓判定：${name} —— 期望 [${want.join(',')}]，拿到 [${got.join(',')}]`)
      ok = false
    }
  }

  /*
   * 去抖（`ORPHAN_SWEEP_GAP_MS` = 30 秒）：同一个币 30 秒内只扫一次，过了才再扫。
   * ⚠️ 写反的后果是"悄悄白烧权重"，所以两边都要卡。
   */
  const swept = new Map<string, number>()
  const t0 = 1_700_000_000_000
  const GAP = ORPHAN_SWEEP_GAP_MS
  swept.set('BTCUSDT', t0)
  /* ⚠️ 门槛取的是**常量本身**（`ORPHAN_SWEEP_GAP_MS`）—— 别在这儿写死秒数，
     不然哪天调了间隔这组夹具还在测老数字（2026-10-07 就从 30 秒改成过 10 秒）。 */
  const debounce: [string, string[], number, string[]][] = [
    ['刚扫过（1 秒）不再扫', ['BTCUSDT'], t0 + 1_000, []],
    ['刚好卡在门槛上还不扫', ['BTCUSDT'], t0 + GAP, []],
    ['过了门槛就再扫', ['BTCUSDT'], t0 + GAP + 1_000, ['BTCUSDT']],
    ['没扫过的币立刻扫，同批重复只挑一次', ['ETHUSDT', 'ETHUSDT'], t0 + 1_000, ['ETHUSDT']],
    ['空符号忽略', ['', 'ETHUSDT'], t0 + 1_000, ['ETHUSDT']]
  ]
  for (const [name, list, now, want] of debounce) {
    const got = orphanSweepTargets(list, swept, now)
    if (got.join(',') !== want.join(',')) {
      console.error(`❌ 撤残留单去抖：${name} —— 期望 [${want.join(',')}]，拿到 [${got.join(',')}]`)
      ok = false
    }
  }

  if (ok) console.log(`✅ 平仓即撤单：${cases.length + debounce.length} 组夹具通过`)
  return ok
}

/* ------------------------------------------------------------------ */
/* ⑦ 分区命名 / 边界 / 保留期                                            */
/* ------------------------------------------------------------------ */

/** UTC 毫秒的简写（夹具里写清楚比 `Date.UTC(...)` 好读） */
function ms(iso: string): number {
  return Date.parse(iso)
}

function checkPartitions(): boolean {
  let ok = true
  const bad = (msg: string): void => {
    console.error(`❌ 分区夹具：${msg}`)
    ok = false
  }

  /* 时间格边界：天/月/年，含月末与跨年 */
  const cases: [string, 'day' | 'month' | 'year', string, string][] = [
    ['2026-10-08T13:45:00Z', 'day', '2026-10-08T00:00:00Z', '2026-10-09T00:00:00Z'],
    ['2026-10-31T23:59:59Z', 'day', '2026-10-31T00:00:00Z', '2026-11-01T00:00:00Z'],
    ['2026-10-08T13:45:00Z', 'month', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'],
    ['2026-12-31T23:59:59Z', 'month', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'],
    ['2026-12-31T23:59:59Z', 'year', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'],
    /* 闰年 2 月：按天切不能算成 28 号就完事 */
    ['2028-02-29T05:00:00Z', 'day', '2028-02-29T00:00:00Z', '2028-03-01T00:00:00Z']
  ]
  for (const [at, g, wantStart, wantEnd] of cases) {
    const start = periodStartOf(ms(at), g)
    const end = periodEndOf(start, g)
    if (start !== ms(wantStart)) bad(`${at} 按 ${g} 切的起点应为 ${wantStart}，得到 ${new Date(start).toISOString()}`)
    if (end !== ms(wantEnd)) bad(`${at} 按 ${g} 切的终点应为 ${wantEnd}，得到 ${new Date(end).toISOString()}`)
  }

  /* 命名 ↔ 反解：往返必须一致，且别把 DEFAULT / 子父表认成时间子分区 */
  for (const it of ALL_INTERVALS) {
    const start = Date.UTC(2026, 9, 8)
    const name = partNameOf(it, start)
    const back = parsePartName(name)
    if (!back || back.interval !== it || back.startMs !== start) {
      bad(`「${it}」命名往返不一致：${name} → ${JSON.stringify(back)}`)
    }
  }
  for (const notAPart of ['candles_1m_def', 'candles_1m', 'candles', 'candles_1m_2026100', 'other_1m_20261008']) {
    if (parsePartName(notAPart) !== null) bad(`「${notAPart}」不该被认成时间子分区`)
  }

  /* 保留期写法 */
  if (keepMs('7 days') !== 7 * 86_400_000) bad("keepMs('7 days') 不对")
  if (keepMs('400 days') !== 400 * 86_400_000) bad("keepMs('400 days') 不对")
  for (const s of ['7d', '一周', '']) {
    let threw = false
    try {
      keepMs(s)
    } catch {
      threw = true
    }
    if (!threw) bad(`keepMs('${s}') 该报错（写法不认识），却算出了值`)
  }

  /* 每档都得有粒度和保留期声明 —— 少一个，那一档就永远不会被清理/建分区 */
  for (const it of ALL_INTERVALS) {
    if (!PART_GRANULARITY[it]) bad(`「${it}」没有声明分区粒度`)
    if (!(it in KLINE_RETENTION)) bad(`「${it}」没有声明保留期`)
  }
  /* 永久保留的档不该被判成过期 ⇒ 保留期必须是 null */
  for (const it of ['4h', '1d'] as const) {
    if (KLINE_RETENTION[it] !== null) bad(`「${it}」是永久保留档，保留期应为 null`)
  }

  /* 保留期必须**至少**覆盖读路径要用的窗口（粗档 1h 要能画一年 = 400 天） */
  const keepDays = (it: keyof typeof KLINE_RETENTION): number | null => {
    const k = KLINE_RETENTION[it]
    return k === null ? null : keepMs(k) / 86_400_000
  }
  if (keepDays('1m') !== 7) bad('1m 保留期应为 7 天（读路径 baseProbe 按 6 天挑 1m）')
  if ((keepDays('1h') ?? 0) < 400) bad('1h 保留期要 ≥400 天（K 线要能画一年）')

  if (ok) console.log('✅ 分区：命名往返 / 时间格边界 / 保留期解析 夹具通过')
  return ok
}

/* ------------------------------------------------------------------ */
/* ⑧ 币安历史窗口切分（`planWindows`）                                   */
/* ------------------------------------------------------------------ */

/**
 * 为什么值得一条夹具：`/fapi/v1/userTrades` **单次窗口上限 7 天**
 * （实测超了回 `{"code":-4165,"msg":"Maximum time interval is 7 days."}`），
 * 而补成交是「从水位一直取到现在」——切窗口一旦算错（漏一段 / 重叠错 / 跨过 7 天），
 * 表现是**线上报 -4165 而后端只在日志里嘟囔一句**，很容易几周没人发现。
 */
function checkWindows(): boolean {
  let ok = true
  const bad = (msg: string): void => {
    console.error(`❌ 窗口夹具：${msg}`)
    ok = false
  }
  const D = 86_400_000
  const W = 7 * D

  /* ① 刚好 7 天 ⇒ 一片，且左闭右开 */
  const one = planWindows(0, W, W)
  if (one.length !== 1) bad(`刚好 7 天应该切 1 片，实际 ${one.length}`)
  else if (one[0].from !== 0 || one[0].to !== W) bad('那一片的区间不对')

  /* ② 边界：多 1 毫秒 ⇒ 两片，且**不重叠、不留缝** */
  const two = planWindows(0, W + 1, W)
  if (two.length !== 2) bad(`7 天 + 1ms 应该切 2 片，实际 ${two.length}`)
  else if (two[0].to !== two[1].from) bad('两片之间必须首尾相接（to 等于下一片的 from）')
  else if (two[1].to !== W + 1) bad('最后一片必须收到区间终点')

  /* ③ 跨 3 个月（90 天）⇒ 每片都不超过 7 天，且首尾相接 */
  const many = planWindows(0, 90 * D, W)
  for (const w of many) {
    if (w.to - w.from > W) bad(`有一片跨度 ${(w.to - w.from) / D} 天 > 7 天`)
    if (!(w.to > w.from)) bad('出现空片 / 反片')
  }
  for (let i = 1; i < many.length; i++) {
    if (many[i].from !== many[i - 1].to) bad(`第 ${i} 片与前一片不相接`)
  }
  if (many.length !== 13) bad(`90 天按 7 天切应该是 13 片，实际 ${many.length}`)

  /* ④ 空 / 反向 / 非法跨度 ⇒ 空数组（调用方据此直接跳过，别发请求） */
  if (planWindows(100, 100, W).length) bad('from === to 应该切出空数组')
  if (planWindows(200, 100, W).length) bad('反向区间应该切出空数组')
  if (planWindows(0, D, 0).length) bad('跨度 0 应该切出空数组')
  if (planWindows(NaN, D, W).length) bad('NaN 起点应该切出空数组')

  /* ⑤ 保留期常量本身要自洽：地平线必须 ≥ 单窗口（否则永远切不出一片） */
  if (!(BINANCE_RETENTION_MS >= BINANCE_MAX_WINDOW_MS)) {
    bad('保留期（地平线）必须不小于单次窗口上限')
  }

  if (ok) console.log('✅ 窗口：币安 7 天窗口切分 夹具通过')
  return ok
}

/* ------------------------------------------------------------------ */
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

let failed = !checkContract()
if (!checkSanitize()) failed = true
if (!checkDiff()) failed = true
if (!checkCloseSweep()) failed = true
if (!checkTier()) failed = true
if (!checkTierText()) failed = true
if (!checkPartitions()) failed = true
if (!checkWindows()) failed = true

// 夹具也得过 zod —— 少了字段 / 类型写错，这里会立刻炸
const parsed = judgeSchema.safeParse(judge)
if (!parsed.success) {
  console.error('❌ 夹具过不了 zod 校验：', parsed.error.issues)
  failed = true
}

if (judge.tags.length > 4) {
  console.error(`❌ 标签超了 4 个：${judge.tags.join(' / ')}`)
  failed = true
}

console.log('\n---- CLI 渲染预览 ----')
console.log(
  render(snapshot, judge, {
    model: 'selftest',
    disciplineEmpty: false,
    disciplineHash: 'selftest',
    days: 7,
    usageText: '测试用，不产生费用'
  })
)

if (failed) process.exit(1)
console.log('✅ 自检通过')
