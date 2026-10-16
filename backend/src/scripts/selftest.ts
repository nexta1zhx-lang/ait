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
 *   ⑩ 「数据问答」的参数收敛（模型给的日期 / 跨度 / 条数 / 币种 → SQL 参数）
 *   ⑪ 「从一笔仓位导入知识库」截哪一段行情（见 `knowledge-window.ts`）
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
import {
  POSITION_POST_BARS,
  POSITION_PRE_BARS,
  pickTimeframe,
  positionWindowMs
} from '../knowledge-window'
import {
  bjDayEndMs,
  bjDayStartMs,
  bjStamp,
  clampInt,
  dur,
  dayShift,
  normalizeDay,
  normalizeRange,
  normalizeSymbol
} from '../ask/range'

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
   * ① 真实形状：模型给的是一整篇 Markdown，「结论」的位置**飘忽不定** ——
   *    实测 60 条里从第 2 个字到第 1630 个字都有。所以判定锚在「结论」上，
   *    只看它往后一小段（≤20 字，遇句读就停），**不是**只看开头 20 字。
   */
  const longGo = [
    '# BTC/USDT 1h 判断',
    '',
    '## 一、先看结构：现在处在什么位置',
    '- 前一段高位横盘，区间 82,900 ~ 84,300，反复磨，量比 0.5~1.5x，没有方向。',
    '- 下跌段：一根 -0.87%、量比 6.1x 放量下杀，从 83,930 砸到 82,535，之后连续阴跌。',
    '',
    '## 四、怎么做',
    '结论：**可以开多，** 但只能算「试仓」，止损放 0.0831 下面。'
  ].join('\n')
  want(longGo, 'go', '「结论」在很后面（1400 字级）也要找得到')
  if (longGo.slice(0, 20).includes('结论')) bad('这条夹具得让「结论」不在开头，否则测不出"锚在结论上"')

  const longNo = [
    '# NIL/USDT 15m 判断',
    '',
    '## 一、先说结构：现在是什么状态',
    '- 01:30 起放量拉升，02:00 冲到 0.09497，量比 3.1x / 4.7x / 4.9x，放量是真的。',
    '- 但冲高之后没守住，连续三根阴线往下走，上去就还手了。',
    '',
    '## 结论',
    '不开。现在这一单不该开。'
  ].join('\n')
  want(longNo, 'no', '长 Markdown 里的「不开」要判成不可做')

  /*
   * ② 用户 2026-10-16 定的三条：
   *    · 那段里出现「不」（或「没」，同一类否定）⇒ 不可做（一票否决）
   *    · 出现「观望」⇒ 观望
   *    · 出现「开多 / 做多」⇒ 可做
   */
  want('结论：不开。现在没有可做的结构。', 'no', '「不开」→ 不可做')
  want('结论：现在不该开，等确认', 'no', '「不该开」→ 不可做')
  want('这单 没有可做的结构', 'no', '没有「结论」时退回开头；「没有可做」要判不可做（2026-10-15 那条假警报的原话）')
  want('结论：现在只能观望，等下一根收线', 'wait', '「观望」→ 观望')
  want('结论：可以开多，但只能算「试仓」', 'go', '「可以开多」→ 可做')
  want('结论：可以做多，但要注意位置。', 'go', '「可以做多」→ 可做')
  want('结论：先看看再说', 'wait', '一个词都没命中 → 观望（保守，不发通知）')

  /*
   * ③ 窗口只到**那一句**为止（遇 。！？；，就停）：
   *    结论后面往往紧跟理由，理由里出现「不」不能把结论压掉。
   */
  want('结论：这一单：可以开多，但也不算标准形态', 'go', '逗号就停 ⇒ 理由里的「不」不该压掉结论')
  /*
   * ④ 反过来，**同一句里**带「不」就一票否决 —— 这是用户明确要的粗口径。
   *    ⚠️ 已知代价：条件式放行会被压掉（下面这条夹具就是"压掉"的那个例子）。
   *       方向是安全的（少发通知，不是误发假警报）；真要放开，得专门豁免「不破」。
   */
  want('现在这一单不该开（做多）', 'no', '同一句里「不该开」压掉后面的「做多」')
  want('回踩不破可以做多', 'no', '已知代价：「不破可以做多」这种条件式放行会被判成不可做')

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

  if (ok) console.log('✅ 结论档位：锚在「结论」上的 20 字窗口 + 否定一票否决 夹具通过')
  return ok
}

/* ------------------------------------------------------------------ */
/* ⑩ 数据问答：模型给的参数 → SQL 参数（唯一的闸）                      */
/* ------------------------------------------------------------------ */

/**
 * 夹具在卡什么：`ask/range.ts` 那几个函数是「模型的话 → SQL 参数」之间**唯一**一道闸。
 * 它们的失效方式很隐蔽 —— 区间被悄悄写坏（认不出的日期原样带下去、跨度没夹住），
 * 界面上只看到「没数据」，分不清是真没有还是参数烂了。
 *
 * 所以固定一个「今天」（`2026-10-16`）来卡边界，不吃真实时钟。
 */
function checkAsk(): boolean {
  let ok = true
  const bad = (msg: string): void => {
    console.error(`❌ 数据问答夹具：${msg}`)
    ok = false
  }
  const TODAY = '2026-10-16'

  // ① 日期：认得出 / 带时间 / 自然语言 / 不存在的日子
  const dayCases: [unknown, string | null][] = [
    ['2026-10-01', '2026-10-01'],
    /* 模型经常带时间戳 —— 取前 10 位 */
    ['2026-10-01T12:00:00Z', '2026-10-01'],
    /* 认不出的**必须**是 null，调用方走兜底；原样带下去就是一条永远空结果的查询 */
    ['上周三', null],
    /* 日历上不存在的日子 */
    ['2026-02-31', null],
    [null, null]
  ]
  for (const [raw, want] of dayCases) {
    const got = normalizeDay(raw)
    if (got !== want)
      bad(`normalizeDay(${JSON.stringify(raw)}) 期望 ${want}，实际 ${got}`)
  }

  // ② 区间：默认 30 天 / 写反 / 将来 / 跨度截断
  const rangeCases: {
    from: unknown
    to: unknown
    want: [string, string, number]
    why: string
  }[] = [
    {
      from: null,
      to: null,
      want: ['2026-09-17', TODAY, 30],
      why: '两个都缺 = 默认最近 30 天（含今天）'
    },
    {
      from: '2026-10-01',
      to: '2026-10-10',
      want: ['2026-10-01', '2026-10-10', 10],
      why: '正常区间要原样'
    },
    {
      from: '2026-10-10',
      to: '2026-10-01',
      want: ['2026-10-01', '2026-10-10', 10],
      why: '写反了要对调'
    },
    {
      from: '2026-10-01',
      to: '2030-01-01',
      want: ['2026-10-01', TODAY, 16],
      why: '结束日在未来要收到今天'
    },
    {
      from: '2020-01-01',
      to: TODAY,
      want: ['2025-09-12', TODAY, 400],
      why: '跨度过大要截到 400 天'
    },
    {
      from: '上周三',
      to: '前天',
      want: ['2026-09-17', TODAY, 30],
      why: '两个都认不出 = 默认区间'
    }
  ]
  for (const c of rangeCases) {
    const r = normalizeRange(c.from, c.to, TODAY)
    if (r.from !== c.want[0] || r.to !== c.want[1] || r.days !== c.want[2])
      bad(
        `${c.why}：期望 ${c.want.join(' / ')}，实际 ${r.from} / ${r.to} / ${r.days}`
      )
  }
  /* 改过的区间**要说出来** —— 不说的话用户会以为「真的只查到这么多」 */
  if (!normalizeRange('上周三', '前天', TODAY).note.includes('认不出'))
    bad('区间被兜底替换时必须给出 note')
  if (normalizeRange('2026-10-01', '2026-10-10', TODAY).note)
    bad('正常区间不该有 note')

  // ③ 条数：缺省 / 夹上限 / 非法
  const intCases: [unknown, number, number, number][] = [
    [undefined, 20, 200, 20],
    ['50', 20, 200, 50],
    [9999, 20, 200, 200],
    [0, 20, 200, 20],
    [-5, 20, 200, 20],
    ['abc', 20, 200, 20]
  ]
  for (const [raw, def, max, want] of intCases) {
    const got = clampInt(raw, def, max)
    if (got !== want)
      bad(`clampInt(${JSON.stringify(raw)}, ${def}, ${max}) 期望 ${want}，实际 ${got}`)
  }

  // ④ 币种：库里存基础币，模型可能给交易对写法
  const symCases: [unknown, string][] = [
    ['btc', 'BTC'],
    [' BTC ', 'BTC'],
    ['BTC/USDT:USDT', 'BTC'],
    ['BTC/USDT', 'BTC'],
    ['BTCUSDT', 'BTC'],
    ['', ''],
    ['BTC-', '']
  ]
  for (const [raw, want] of symCases) {
    const got = normalizeSymbol(raw)
    if (got !== want)
      bad(`normalizeSymbol(${JSON.stringify(raw)}) 期望「${want}」，实际「${got}」`)
  }

  // ⑤ 日期加减（跨月/跨年，`dayShift` 的进位别错）
  if (dayShift('2026-03-01', -1) !== '2026-02-28')
    bad('dayShift 跨月不对')
  if (dayShift('2027-01-01', -1) !== '2026-12-31')
    bad('dayShift 跨年不对')

  /*
   * ⑥ 北京时刻 → 毫秒（账本查询要的）与 → 显示串。
   *
   * 「差 8 小时」是这类代码最典型的静默错：查出来的成交会显示成**前一天的傍晚**，
   * 数字都对、时间全错，而且很难一眼看出来。所以两边都钉死。
   */
  const dayStart = bjDayStartMs('2026-10-16')
  if (dayStart !== Date.parse('2026-10-16T00:00:00+08:00'))
    bad(`北京 10-16 00:00 换算错了：${new Date(dayStart).toISOString()}`)
  if (bjDayEndMs('2026-10-16') !== bjDayStartMs('2026-10-17') - 1)
    bad('bjDayEndMs 不是「下一天起点减 1 毫秒」')
  // 16 日 23:30 UTC = 北京 **17 日** 07:30（跨了一个自然日）
  const stamp = bjStamp(Date.parse('2026-10-16T23:30:00Z'))
  if (stamp !== '2026-10-17 07:30')
    bad(`bjStamp 期望「2026-10-17 07:30」，实际「${stamp}」`)
  if (bjStamp('不是时间') !== '') bad('bjStamp 遇到认不出的时间该回空串')

  // ⑦ 持仓时长（`ask/tools.ts` 的 `dur`）—— 60/60 分、48 小时这两个进位点最容易写错
  const durCases: [number, string][] = [
    [45, '45 秒'],
    [60, '1 分'],
    [90 * 60, '1 小时 30 分'],
    [47 * 3600, '47 小时 0 分'],
    [48 * 3600, '2 天 0 小时']
  ]
  for (const [sec, want] of durCases) {
    const got = dur(sec)
    if (got !== want) bad(`dur(${sec}) 期望「${want}」，实际「${got}」`)
  }

  if (ok)
    console.log(
      `✅ 数据问答：${dayCases.length} 组日期 + ${rangeCases.length} 组区间 + ` +
        `${intCases.length} 组条数 + ${symCases.length} 组币种 + ` +
        `${durCases.length} 组时长 夹具通过`
    )
  return ok
}

/* ------------------------------------------------------------------ */
/* ⑪ 从一笔仓位导入：截哪一段行情 + 用哪个周期                            */
/* ------------------------------------------------------------------ */

/**
 * 夹具在卡什么：这两个是「点一下收录」那条路上**唯一**一处把仓位变成行情窗口的规则
 * （`knowledge-service.ts` 只管取数和调模型）。
 *
 * 它们的失效方式很隐蔽 —— 窗口少截一段、周期挑大一档，界面上照样导入成功，
 * 只是 AI 看到的图不对（前面没有蓄势 → 总结出的经验是错的），没人会发现。
 * 所以这里把档位边界和窗口两端都钉死。
 *
 * ⚠️ 夹具一个真时钟都不吃：`positionWindowMs` 的「现在」由调用方给。
 */
function checkKnowledgeWindow(): boolean {
  let ok = true
  const bad = (msg: string): void => {
    console.error(`❌ 仓位导入夹具：${msg}`)
    ok = false
  }

  // ① 周期档位（闭区间：正好 6 小时还是 5m）
  const tfCases: [number, string][] = [
    [0, '5m'],
    [115, '5m'],
    [6 * 3600, '5m'],
    [6 * 3600 + 1, '15m'],
    [24 * 3600, '15m'],
    [24 * 3600 + 1, '1h'],
    [4 * 86400, '1h'],
    [4 * 86400 + 1, '4h'],
    [16 * 86400, '4h'],
    [16 * 86400 + 1, '1d'],
    /* 脏数据（负数 / 调时差算出的怪值）不能把档位带塌 */
    [-100, '5m']
  ]
  for (const [sec, want] of tfCases) {
    const got = pickTimeframe(sec)
    if (got !== want) bad(`pickTimeframe(${sec}) 期望 ${want}，实际 ${got}`)
  }

  // ② 已平的仓位：前 40 根 + 整段持仓 + 后 6 根（5m ⇒ 一根 300000ms）
  const TF = 300_000
  const openAt = Date.parse('2026-10-16T09:18:00+08:00')
  const closeAt = Date.parse('2026-10-16T09:35:00+08:00')
  const now = Date.parse('2026-10-16T12:00:00+08:00')
  const w = positionWindowMs({openAt, closeAt}, TF, now)
  if (w.from !== openAt - POSITION_PRE_BARS * TF)
    bad(`窗口左端该是开仓前 ${POSITION_PRE_BARS} 根，实际差 ${(openAt - w.from) / TF} 根`)
  if (w.to !== closeAt + POSITION_POST_BARS * TF)
    bad(`窗口右端该是平仓后 ${POSITION_POST_BARS} 根，实际差 ${(w.to - closeAt) / TF} 根`)

  /*
   * ③ **还没平完**的仓位：右端取「现在」，不能拿 `closeAt = null` 去算
   *    （`null + 6 根` 会变成 1970 年那一段，或者 NaN —— 两种都拉不到行情）
   */
  const open2 = positionWindowMs({openAt, closeAt: null}, TF, now)
  if (open2.to !== now + POSITION_POST_BARS * TF)
    bad('还没平完的仓位，右端该是「现在 + 后置几根」')

  if (ok)
    console.log(
      `✅ 仓位导入：${tfCases.length} 组周期档位 + 前置 ${POSITION_PRE_BARS} / 后置 ` +
        `${POSITION_POST_BARS} 根窗口 夹具通过`
    )
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
if (!checkAsk()) failed = true
if (!checkKnowledgeWindow()) failed = true

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
