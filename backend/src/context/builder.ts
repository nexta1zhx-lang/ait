import {Candle, MarketSnapshot, StructureState, TimeframeTrend} from '../types'

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a'
  return n.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0
  })
}

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

function trendLabel(t: TimeframeTrend['trend']): string {
  return t === 'up'
    ? '上涨结构(up)'
    : t === 'down'
      ? '下跌结构(down)'
      : '震荡(range)'
}

/** 结构描述：更高的高点 / 更高的低点 等 */
function structureLabel(s: StructureState): string {
  const parts: string[] = []
  if (s.higherHighs) parts.push('更高的高点')
  if (s.higherLows) parts.push('更高的低点')
  if (s.lowerHighs) parts.push('更低的高点')
  if (s.lowerLows) parts.push('更低的低点')
  return parts.length ? parts.join(' + ') : '结构不明'
}

function tfBlock(t: TimeframeTrend): string {
  return [
    `#### ${t.timeframe}`,
    `- 收盘: ${fmt(t.close)}`,
    `- 趋势: ${trendLabel(t.trend)}（${structureLabel(t.structure)}）`,
    `- 区间净涨跌: ${fmt(t.netChangePct, 2)}%   区间振幅: ${fmt(t.rangePct, 2)}%`,
    `- 量比(当前量/近20根均量): ${fmt(t.volRatio, 2)}`,
    `- 该周期波段高 / 低: ${fmt(t.structure.swingHigh)} / ${fmt(t.structure.swingLow)}`
  ].join('\n')
}

function candleRow(c: Candle): string {
  return `${fmtTime(c.timestamp)} | ${fmt(c.open)} | ${fmt(c.high)} | ${fmt(c.low)} | ${fmt(c.close)} | ${fmt(c.volume, 0)}`
}

/** 把行情快照压缩成 LLM 可读的上下文（趋势 + 市场热度 + 周期，无技术指标） */
export function buildContext(snap: MarketSnapshot): string {
  const lines: string[] = []
  const h = snap.heat

  lines.push(`# 行情快照（趋势 + 市场热度 + 周期）`)
  lines.push('')
  lines.push(`## 基本信息`)
  lines.push(`- 币种: ${snap.symbol}`)
  lines.push(`- 交易所: ${snap.exchange}`)
  lines.push(`- 当前价: ${fmt(snap.price)}`)
  lines.push(`- 数据时间: ${fmtTime(snap.timestamp)}`)
  lines.push('')

  lines.push(`## 市场热度`)
  lines.push(
    `- 24h 涨跌: ${h.change24hPct === null ? 'n/a' : fmt(h.change24hPct, 2) + '%'}`
  )
  lines.push(
    `- 24h 振幅: ${h.amplitude24hPct === null ? 'n/a' : fmt(h.amplitude24hPct, 2) + '%'}`
  )
  lines.push(`- 24h 最高 / 最低: ${fmt(h.high24h)} / ${fmt(h.low24h)}`)
  lines.push(`- 24h 成交额: ${fmt(h.quoteVolume24h, 0)}`)
  lines.push(
    `- 资金费率: ${h.fundingRate === null ? 'n/a（现货或无数据）' : fmt(h.fundingRate, 4)}`
  )
  lines.push(
    `- 持仓量: ${h.openInterest === null ? 'n/a' : fmt(h.openInterest, 0)}`
  )
  lines.push(
    `- 持仓量变化: ${h.openInterestChangePct === null ? 'n/a' : fmt(h.openInterestChangePct, 2) + '%'}`
  )
  lines.push(
    `- 多空持仓人数比: ${h.longShortRatio === null ? 'n/a' : fmt(h.longShortRatio, 2)}`
  )
  lines.push('')

  lines.push(`## 趋势参考结构（近 ${snap.structure.lookback} 根 1H）`)
  lines.push(
    `- 区间高 / 低: ${fmt(snap.structure.swingHigh)} / ${fmt(snap.structure.swingLow)}`
  )
  lines.push(
    `- 最近波段高（做空止损参考）: ${fmt(snap.structure.lastSwingHigh)}`
  )
  lines.push(
    `- 最近波段低（做多止损参考）: ${fmt(snap.structure.lastSwingLow)}`
  )
  lines.push(`- 结构: ${structureLabel(snap.structure)}`)
  lines.push('')

  lines.push(`## 多周期趋势（周期共振判断）`)
  lines.push('')
  for (const t of snap.timeframes) {
    lines.push(tfBlock(t))
    lines.push('')
  }

  if (snap.recentCandles.length > 0) {
    lines.push(`## 最近 K 线 (时间 | 开 | 高 | 低 | 收 | 量)`)
    for (const c of snap.recentCandles) {
      lines.push(candleRow(c))
    }
    lines.push('')
  }

  return lines.join('\n')
}
