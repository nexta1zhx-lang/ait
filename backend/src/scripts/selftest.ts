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
 * 现在这里卡三件事：
 *   ① 契约（提示词骨架）和 zod 校验结构**一模一样**
 *   ② 渲染能把这四个字段印出来
 *   ③ `sanitizeRows` 该丢的丢、该留的留、该覆盖的覆盖
 *   ④ `planContractChanges` 该加的加、该摘的摘（新币 / 下架 / 待上线）
 */
import {sanitizeRows, type NewCandleRow} from '../db/candle-store'
import {planContractChanges, type RawContract} from '../data/market'
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
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

let failed = !checkContract()
if (!checkSanitize()) failed = true
if (!checkDiff()) failed = true

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
