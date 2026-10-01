#!/usr/bin/env node
/**
 * 测试「拉升检测」——看看它能不能在真实行情里找到主升段。
 *
 *   npm run swing -- MAGMA 4h           最近 500 根
 *   npm run swing -- BTC 1h --days 30   最近 30 天
 */
import {loadConfig} from '../config'
import {fetchCandles, fetchCandlesRange} from '../data/market'
import {findMainRally, sliceWindow} from '../analysis/swing'
import {Timeframe} from '../types'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const fmt = (n: number, d = 4) =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', {maximumFractionDigits: d})
    : '—'

const bj = (ts: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date(ts))
    .replace(',', '')

async function main(): Promise<void> {
  const symbol = process.argv[2]
  const tf = (process.argv[3] ?? '4h') as Timeframe
  if (!symbol) {
    console.log('用法：npm run swing -- <币种> [周期] [--days N]')
    return
  }
  const days = Number(arg('--days')) || 0
  const config = loadConfig()

  const candles = days
    ? await fetchCandlesRange({
        exchangeId: config.exchange,
        symbol,
        timeframe: tf,
        from: Date.now() - days * 86400_000,
        to: Date.now(),
        marketType: config.marketType,
        apiBase: config.apiBase
      })
    : await fetchCandles({
        exchangeId: config.exchange,
        symbol,
        timeframe: tf,
        limit: 500,
        marketType: config.marketType,
        apiBase: config.apiBase
      })

  console.log(`• ${symbol} ${tf}：拉到 ${candles.length} 根`)
  if (!candles.length) return

  const win = findMainRally(candles)
  if (!win) {
    console.log('❌ 没找到任何上升腿（数据太少或全在下跌）')
    return
  }

  const leg = win.leg
  console.log('')
  console.log('=== 主拉升段 ===')
  console.log(
    `  时间      ${bj(candles[leg.fromIndex].timestamp)} → ${bj(candles[leg.toIndex].timestamp)}`
  )
  console.log(`  价格      ${fmt(leg.fromPrice)} → ${fmt(leg.toPrice)}`)
  console.log(`  涨幅      ${fmt(leg.changePct, 2)}%`)
  console.log(`  根数      ${leg.bars}`)
  console.log(`  力度      ${fmt(leg.atrMultiple, 2)} × ATR`)
  console.log(
    `  量能      ${leg.volMultiple === null ? '—' : fmt(leg.volMultiple, 2) + ' 倍'}`
  )
  console.log(`  得分      ${fmt(leg.score, 2)}`)
  console.log(
    `  够拉升标准 ${win.isRally ? '✅ 是' : '⚠️ 否（力度不足，取的相对最强的一段）'}`
  )

  console.log('')
  console.log('=== 入库窗口（拉升前后两段）===')
  const w = sliceWindow(candles, win)
  console.log(
    `  ${bj(w[0].timestamp)} → ${bj(w[w.length - 1].timestamp)}  共 ${w.length} 根`
  )
  console.log(`  ├ 前段 ${win.preBars} 根（拉升前）`)
  console.log(
    `  ├ 拉升 ${win.rallyEnd - win.rallyStart + 1} 根  ← 在第 ${win.rallyStart}~${win.rallyEnd} 根`
  )
  console.log(`  └ 后段 ${win.postBars} 根（拉升后）`)

  console.log('')
  console.log('=== 窗口内的 K 线（抽样）===')
  const step = Math.max(1, Math.floor(w.length / 12))
  for (let i = 0; i < w.length; i += step) {
    const c = w[i]
    const mark =
      i === win.rallyStart
        ? ' ← 拉升起点'
        : i === win.rallyEnd
          ? ' ← 拉升终点'
          : ''
    console.log(
      `  ${bj(c.timestamp)}  O${fmt(c.open)} H${fmt(c.high)} L${fmt(c.low)} C${fmt(c.close)}  V${fmt(c.volume, 0)}${mark}`
    )
  }
}

main().catch(e => {
  console.error(`\n❌ ${(e as Error).message}`)
  process.exitCode = 1
})
