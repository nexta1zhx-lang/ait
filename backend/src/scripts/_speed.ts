/* 临时测速脚本：5m 带/不带其它周期，以及各周期对比。用完即删。 */
import {fetchSnapshot} from '../data/market'
import {buildContext} from '../context/builder'
import {loadConfig} from '../config'
import {judge} from '../llm/client'
import {loadRules} from '../rules'
import {loadTagTemplates} from '../db/tags'
import {listTags} from '../db/knowledge'

async function main() {
  const c = loadConfig()

  /* ---------- 1. 取数 + 拼上下文（不调模型） ---------- */
  console.log('\n=== 取数 + 拼上下文（不调模型，每档跑两次取第二次）===\n')
  console.log('  主周期    块数  总根数  取数      拼装    上下文')
  console.log('  ' + '-'.repeat(52))

  const cases: {tf: string; days: number; others: Record<string, number>}[] = [
    {tf: '5m', days: 1.041, others: {}}, // 改之前：一个块
    {tf: '5m', days: 1.041, others: {'15m': 2, '1h': 10, '4h': 20, '1d': 30}},
    {tf: '15m', days: 3.125, others: {'1h': 10, '4h': 20, '1d': 30}},
    {tf: '1h', days: 12.5, others: {'15m': 2, '4h': 30, '1d': 60}},
    {tf: '4h', days: 50, others: {'1d': 60}},
    {tf: '1d', days: 300, others: {}}
  ]

  for (const k of cases) {
    let fetch = 0
    let build = 0
    let bars = 0
    let chars = 0
    let blocks = 0
    for (let round = 0; round < 2; round++) {
      const t0 = Date.now()
      const s = await fetchSnapshot({
        exchangeId: c.exchange,
        symbol: 'BTC/USDT',
        timeframe: k.tf as never,
        days: k.days,
        marketType: c.marketType,
        calibers: {
          ...c.calibers,
          others: {...c.calibers.others, [k.tf]: k.others}
        }
      })
      const t1 = Date.now()
      const ctx = buildContext(s)
      const t2 = Date.now()
      fetch = t1 - t0
      build = t2 - t1
      bars = s.blocks.reduce((a, b) => a + b.bars, 0)
      chars = ctx.length
      blocks = s.blocks.length
    }
    const name = k.tf + (Object.keys(k.others).length ? '' : ' 单块')
    console.log(
      `  ${name.padEnd(9)}${String(blocks).padEnd(6)}${String(bars).padEnd(8)}` +
        `${String(fetch + 'ms').padEnd(10)}${String(build + 'ms').padEnd(8)}${chars} 字`
    )
  }

  /* ---------- 2. 端到端（真调模型）：只比 5m 两种 ---------- */
  const rules = await loadRules()
  let tags: string[] = []
  try {
    const [templates, used] = await Promise.all([
      loadTagTemplates(),
      listTags()
    ])
    tags = [...new Set([...templates, ...used.map(u => u.tag)])]
  } catch {
    /* 标签池取不到就算了，不影响测速 */
  }

  console.log('\n=== 端到端（真调模型）===\n')
  console.log(
    '  主周期       上下文   提示tok  输出tok  调模型    取数+拼装  合计'
  )
  console.log('  ' + '-'.repeat(70))

  const runs: [string, Record<string, number>][] = [
    ['5m 单块', {}],
    ['5m 5 个块', {'15m': 2, '1h': 10, '4h': 20, '1d': 30}]
  ]

  for (const [label, others] of runs) {
    const t0 = Date.now()
    const s = await fetchSnapshot({
      exchangeId: c.exchange,
      symbol: 'BTC/USDT',
      timeframe: '5m',
      days: 1.041,
      marketType: c.marketType,
      calibers: {...c.calibers, others: {...c.calibers.others, '5m': others}}
    })
    const ctx = buildContext(s)
    const t1 = Date.now()
    const {meta} = await judge({
      snapshot: s,
      context: ctx,
      prompt: rules.system,
      tags,
      config: c
    })
    const t2 = Date.now()
    console.log(
      `  ${label.padEnd(13)}${String(ctx.length + ' 字').padEnd(9)}` +
        `${String(meta.usage.promptTokens).padEnd(9)}${String(meta.usage.completionTokens).padEnd(9)}` +
        `${String(meta.latencyMs + 'ms').padEnd(10)}${String(t1 - t0 + 'ms').padEnd(12)}${t2 - t0}ms`
    )
  }
  console.log('')
}

void main()
