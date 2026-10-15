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
 * 现在这里卡九件事：
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
 *   ⑨ 同向加仓浮盈额度、其他币开仓 5 倍额度、账户总杠杆 11 倍上限。
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
  isWithinPositionProfitAddBudget,
  orderEquityRatio,
  planWindows,
  positionProfitAddBudget,
  symbolBudget,
  totalLeverageAfter
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
import {judgeSchema} from '../llm/schema'
import {render} from '../output/render'
import type {MarketSnapshot} from '../types'
import {enteredGo, verdictOf, type Verdict} from '../analysis/verdict'

/* ------------------------------------------------------------------ */
/* ① 契约防漂移                                                        */
/* ------------------------------------------------------------------ */

/* 契约防漂移那套检查 2026-10-11 删了 —— 输出从「六字段 JSON」变成「一句话」，
   没有骨架可以对照了；`judgeSchema` 只在下面拿来校一下夹具。 */

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
  sources: [{timeframe: '1h', from: 'db'}],
  candles: []
}

/** AI 只回一句话 */
const judge: JudgeResult = {
  line: '能做：现价附近可轻仓进，止损放前一个结构低点下方。'
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
/* ⑨ 合约开仓与浮盈加仓额度                                            */
/* ------------------------------------------------------------------ */
function checkTradeBudgets(): boolean {
  let ok = true
  const bad = (msg: string): void => {
    console.error(`❌ 加仓额度夹具：${msg}`)
    ok = false
  }

  const profitBudget = positionProfitAddBudget(10, 10)
  if (profitBudget !== 100) bad(`浮盈 10 × 10x 应为 100，实际 ${profitBudget}`)
  if (positionProfitAddBudget(-3, 10) !== 0) bad('负浮盈不能生成加仓额度')
  if (positionProfitAddBudget(10, 20) !== 100) bad('加仓额度杠杆必须封顶 10x')
  if (!isWithinPositionProfitAddBudget(100, profitBudget)) bad('预算内的加仓单应放行')
  if (isWithinPositionProfitAddBudget(102, profitBudget)) bad('超出浮盈预算的加仓单应拒绝')
  if (isWithinPositionProfitAddBudget(5, 0)) bad('无浮盈时不应允许加仓')

  if (orderEquityRatio(500, 100) !== 5) bad('新开仓恰为 5x 权益应放行')
  if ((orderEquityRatio(501, 100) ?? 0) <= 5) bad('新开仓超过 5x 权益应拒绝')
  if (symbolBudget(100, 0, 500).overflow) bad('新开其他币 5x 权益额度应放行')
  if (!symbolBudget(100, 0, 502).overflow) bad('新开其他币超过 5x 权益应拒绝')
  if (totalLeverageAfter([900], 100, 200) !== 11) bad('账户总杠杆恰为 11x 应放行')
  if ((totalLeverageAfter([900], 100, 201) ?? 0) <= 11) bad('账户总杠杆超过 11x 应拒绝')

  if (ok) console.log('✅ 加仓额度：浮盈 × 10、其他币开仓 5x、账户总杠杆 11x 夹具通过')
  return ok
}

/* ------------------------------------------------------------------ */
/* ⑩ 结论档位与「该不该提醒」                                          */
/* ------------------------------------------------------------------ */
function checkVerdict(): boolean {
  let ok = true
  const bad = (msg: string): void => {
    console.error(`❌ 档位夹具：${msg}`)
    ok = false
  }
  const want = (text: string, expect: Verdict, why: string): void => {
    const got = verdictOf(text)
    if (got !== expect) bad(`${why}：期望 ${expect}，实际 ${got}`)
  }

  /*
   * ① 真实形状：模型给的是一整篇 Markdown，档位那两个字**在后面**。
   *    （旧实现只扫前 260 字，这两条都会判成 wait —— 这是 2026-10-15 修的那个 bug）
   */
  const longGo = [
    '# NIL/USDT 1h 判断',
    '',
    '## 一、先看结构：这只币现在处在什么位置',
    '- 大背景（10-11 → 10-13）：一路阴跌，从 0.0956 掉到 0.0831，中间没有像样的反抽。',
    '- 近 24 根：在 0.0840~0.0895 之间横着，量能比前面那波跌的时候明显萎缩。',
    '- 均线：1h 的 EMA20 还在 EMA60 下面，但两条之间的距离在收窄。',
    '',
    '## 二、关键位',
    '- 上方：0.0956 是这一段的前高，也是 1h 那根大阴线的起点。',
    '- 下方：0.0831 是这波低点，破了就回到下跌通道里。',
    '- 中间这个 0.0862 附近密集成交最多，是当下多空的分界。',
    '',
    '## 三、结论',
    '**可以做多**，回踩 0.0862 不破就进，止损放 0.0831 下面。'
  ].join('\n')
  want(longGo, 'go', '长 Markdown 里的「可以做多」要判成可做')
  if (longGo.slice(0, 260).includes('可以做多')) {
    bad('这条夹具得让结论落在 260 字之后，否则测不出旧 bug')
  }

  const longNo = [
    '# NIL/USDT 1h 判断',
    '',
    '## 一、先看结构',
    '骨架还是空头，反抽都是卖点。',
    '',
    '## 二、结论',
    '**不能做多**，等它站回 0.0956 再说。'
  ].join('\n')
  want(longNo, 'no', '长 Markdown 里的「不能做多」要判成不可做')

  /* ② 否定优先：「不能做」内部含「能做」，必须不被误读成可做 */
  want('这位置不能做多', 'no', '「不能做多」不能被内部包含的「能做」骗成 go')
  want('不建议现在开多', 'no', '「不建议」是否决')
  /* ③ 观望：既没否决也没放行 */
  want('现在只能观望，等下一根收线', 'wait', '纯观望')
  /* ④ 观望不是否决：「先等回踩」不该判成 no（否则 no ↔ wait 会来回弹通知） */
  want('先等回踩不破再看', 'wait', '「先等」属于观望，不是否决')
  /* ⑤ 抹 Markdown：记号夹在词中间也得认出来 */
  want('# 判断\n\n> **可做**，轻仓', 'go', '抹掉 Markdown 记号后要认出可做')

  /* ⑥ 值不值得提醒：**只在"转成可做"那一刻**（用户 2026-10-15：「只有可做才弹窗和发 TG」） */
  const alert = (prev: string | null, next: Verdict, expect: boolean, why: string): void => {
    if (enteredGo(prev, next) !== expect) bad(why)
  }
  alert(null, 'go', true, '第一轮就是可做 —— 最该知道的那次，必须提醒')
  alert('wait', 'go', true, '观望 → 可做 必须提醒')
  alert('no', 'go', true, '不可做 → 可做 必须提醒')
  alert('go', 'go', false, '一直可做不重复提醒')
  alert('go', 'wait', false, '可做 → 观望 不该提醒（本轮只推可做）')
  alert('go', 'no', false, '可做 → 走弱 不该提醒（本轮只推可做）')
  alert('no', 'wait', false, '不可做 ↔ 观望 是噪音，不该提醒')
  alert('wait', 'no', false, '观望 ↔ 不可做 是噪音，不该提醒')

  if (ok) console.log('✅ 结论档位：长 Markdown 全文找 + 只在「转可做」时提醒 夹具通过')
  return ok
}

/* ------------------------------------------------------------------ */
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

let failed = false
if (!checkSanitize()) failed = true
if (!checkDiff()) failed = true
if (!checkCloseSweep()) failed = true
if (!checkTier()) failed = true
if (!checkTierText()) failed = true
if (!checkPartitions()) failed = true
if (!checkWindows()) failed = true
if (!checkTradeBudgets()) failed = true
if (!checkVerdict()) failed = true

// 夹具也得过 zod —— 少了字段 / 类型写错，这里会立刻炸
const parsed = judgeSchema.safeParse(judge)
if (!parsed.success) {
  console.error('❌ 夹具过不了 zod 校验：', parsed.error.issues)
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
