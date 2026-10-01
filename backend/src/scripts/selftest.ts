#!/usr/bin/env node
/**
 * 离线自检：验证「判断结果 → 护栏校验 → 仓位计算 → 渲染」整条链路。
 *
 *   npm run selftest
 *
 * 不依赖网络、不依赖 API Key，也**不需要先编译**（用 tsx 直接跑 TS）。
 * 这里喂进去的是一份**测试夹具**（手写的判断结果），
 * 只用来验证护栏与渲染的算法，跟真实 AI 输出无关。
 */
import {JudgeResult, toDecision} from '../llm/client'
import {validate} from '../guardrails/validator'
import {render} from '../output/render'
import {loadConfig} from '../config'
import {MarketSnapshot, StructureState, Timeframe} from '../types'

const config = loadConfig()
const close = 60000

function structure(up: boolean): StructureState {
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
  timeframe: Timeframe,
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
    structure: structure(trend === 'up')
  }
}

/** 一份「强势上涨」的行情，用来验证「该开仓」这条路径 */
const snapshot: MarketSnapshot = {
  symbol: 'TEST/USDT',
  exchange: 'test',
  timestamp: Date.now(),
  price: close,
  timeframes: [
    tf('15m', 'up', 1.0, 1.1),
    tf('1h', 'up', 2.0, 1.2),
    tf('4h', 'up', 3.0, 1.3),
    tf('1d', 'up', 5.0, 1.4)
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
  structure: structure(true),
  recentCandles: [],
  series: [],
  variables: {
    price: close,
    funding_rate: 0.0001,
    amplitude24h_pct: 4.1,
    change24h_pct: 3.2
  }
}

function check(
  item: string,
  status: 'pass' | 'fail' | 'warn',
  evidence: string
) {
  return {item, status, evidence}
}

/** 一份「强势上涨、可以开多」的判断结果，用来验证开仓这条路径 */
const judge: JudgeResult = {
  grade: 'A',
  gradeReason: '回踩不破前高，4h 上升结构完好',
  verdict: 'go',
  confidence: 78,
  direction: 'long',
  entry: {type: 'market', price: close},
  stopLoss: close * 0.975,
  takeProfits: [
    {label: 'TP1', price: close * 1.025, r: 1, reducePercent: 50},
    {label: 'TP2', price: close * 1.05, r: 2, reducePercent: 25},
    {label: 'TP3', price: close * 1.075, r: 3, reducePercent: 25}
  ],
  checklist: [
    check('这个币强势吗？', 'pass', '4h 更高的高点 + 更高的低点'),
    check('有盘整结构吗？', 'pass', '前高附近横盘蓄势'),
    check('有强力 K / 放量突破吗？', 'pass', '量比 1.2，放量上破'),
    check('后续还有力量吗？', 'pass', '持仓量变化 +2.5%'),
    check('止损位写得出吗？空间合理吗？', 'pass', '止损放在波段低点下方'),
    check('现在是关键时段还是垃圾时段？', 'warn', '数据判断不了，自己看'),
    check('心态是否平稳？', 'warn', '数据判断不了，自己看')
  ],
  failedCritical: [],
  verdictReason: '结构、量能、止损三项都对上了，可以做。',
  exitTriggers: ['动能衰竭（量能萎缩、后续没力量）就走'],
  knowledgeRefs: [],
  coachLine: '强势就顺势做，别在弱势里赌突破。',
  decision: 'open'
}

// 判断结果 → 护栏模块认识的形状（与网页 / CLI 走同一条链路）
const decision = toDecision(judge)
const guard = validate(decision, snapshot, config)

console.log('判档:', judge.grade, '|', judge.gradeReason)
console.log('结论:', judge.verdict)
console.log(
  '决策:',
  decision.decision,
  decision.direction,
  '置信度',
  decision.confidence
)
console.log(
  '入场:',
  decision.entry.price,
  '止损:',
  decision.stopLoss,
  '止盈:',
  decision.takeProfits.map(t => `${t.label}=${t.price}`).join(' / ')
)
console.log('仓位:', guard.position)
console.log('护栏通过:', guard.passed, '| 末段盈亏比:', guard.rMultiple)
for (const c of guard.checks)
  console.log(`  ${c.pass ? '✅' : '⚠️ '} ${c.name} —— ${c.detail}`)
for (const v of guard.violations)
  console.log(`  ❗ ${v.severity}: ${v.id} —— ${v.desc}`)

let failed = false

if (decision.decision !== 'open') {
  console.error(`\n❌ 预期 decision=open，实际 ${decision.decision}`)
  failed = true
}

const entry = decision.entry.price
const stopLoss = decision.stopLoss
if (!guard.position) {
  console.error('❌ 预期计算出仓位')
  failed = true
} else if (entry === null || stopLoss === null) {
  console.error('❌ 预期有入场价与止损价')
  failed = true
} else {
  const expectQty =
    (config.accountEquity * (config.riskPercent / 100)) /
    Math.abs(entry - stopLoss)
  if (Math.abs(guard.position.quantity - expectQty) > 1e-9) {
    console.error(
      `❌ 仓位计算不符：期望 ${expectQty}，实际 ${guard.position.quantity}`
    )
    failed = true
  }
}

if (!guard.passed) {
  console.error('❌ 预期护栏通过')
  failed = true
}

if (failed) process.exit(1)

console.log('\n---- CLI 渲染预览（开仓情形）----')
console.log(
  render(snapshot, decision, guard, {
    model: 'selftest',
    disciplineEmpty: false,
    disciplineHash: 'selftest',
    judge: {
      grade: judge.grade,
      gradeReason: judge.gradeReason,
      exitTriggers: judge.exitTriggers,
      coachLine: judge.coachLine,
      knowledgeRefs: judge.knowledgeRefs
    }
  })
)

console.log('✅ 自检通过')
