#!/usr/bin/env node
/**
 * 离线自检：验证「契约 ↔ zod ↔ 渲染」这条链路。
 *
 *   npm run selftest
 *
 * 不依赖网络、不依赖 API Key，也**不需要先编译**（用 tsx 直接跑 TS）。
 *
 * 2026-10-02 大简化之后，护栏 / 仓位 / 止损止盈 / 期望值 / 清单全删了，
 * 所以这里只剩两件必须卡住的事：
 *   ① 契约（提示词骨架）和 zod 校验结构**一模一样**
 *   ② 渲染能把这四个字段印出来
 */
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
/* 跑                                                                  */
/* ------------------------------------------------------------------ */

let failed = !checkContract()

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
