import {MarketHeat, MarketSnapshot, SeriesBlock} from '../types'

/**
 * 行情快照 → 喂给 AI 的文本。
 *
 * ⚠️ **这里不算任何口径**（不变量比、不找摆点、不算区间位置）——
 * 每个周期就是把 K 线**切成小段读出来**（`analysis/describe.ts` 的
 * `describeSeries`），跟知识库收录案例时同一套做法。
 * AI 自己从这些数字里读形状。
 */

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a'
  return n.toLocaleString('en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0
  })
}

/** 北京时间，到分钟 */
function bjTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'n/a'
  return new Date(ts + 8 * 3600_000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16)
}

/** 天数说人话：3 天 / 12 小时 / 45 分钟 */
function daysText(days: number, tf: string): string {
  const ms = days * 24 * 3600_000
  if (days >= 1) return `最近 ${Number(days.toFixed(2))} 天`
  if (ms >= 3600_000) return `最近 ${Math.round(ms / 3600_000)} 小时`
  if (tf === '5m' || tf === '15m') return `最近 ${Math.round(ms / 60_000)} 分钟`
  return `最近 ${Number(days.toFixed(2))} 天`
}

function heatBlock(h: MarketHeat): string[] {
  const pct = (v: number | null) =>
    v === null ? 'n/a' : `${Number(v.toFixed(2))}%`
  return [
    '## 市场热度',
    `- 24h 涨跌 / 振幅: ${pct(h.change24hPct)} / ${pct(h.amplitude24hPct)}`,
    `- 24h 最高 / 最低: ${fmt(h.high24h)} / ${fmt(h.low24h)}`,
    `- 24h 成交额: ${fmt(h.quoteVolume24h, 0)}`,
    `- 资金费率: ${h.fundingRate === null ? 'n/a（现货或无数据）' : fmt(h.fundingRate, 4)}`,
    `- 持仓量: ${h.openInterest === null ? 'n/a' : fmt(h.openInterest, 0)}`,
    `- 持仓量变化: ${pct(h.openInterestChangePct)}`,
    `- 多空持仓人数比: ${h.longShortRatio === null ? 'n/a' : fmt(h.longShortRatio, 2)}`
  ]
}

/** 一个周期：标题 + describeSeries 切出来的那段文字 */
function blockSection(b: SeriesBlock): string[] {
  const head =
    `### ${b.timeframe}（${daysText(b.days, b.timeframe)} → ${b.bars} 根` +
    `${b.from && b.to ? ` · ${bjTime(b.from)} → ${bjTime(b.to)}` : ''}` +
    `）${b.primary ? ' **← 主周期（图上这个）**' : ''}`
  return [head, '', b.text.trim()]
}

/** 把行情快照写成 LLM 可读的文本 */
export function buildContext(snap: MarketSnapshot): string {
  const lines: string[] = []

  lines.push('# 行情快照')
  lines.push('')
  lines.push('## 基本信息')
  lines.push(`- 币种: ${snap.symbol}`)
  lines.push(`- 交易所: ${snap.exchange}`)
  lines.push(`- 当前价: ${fmt(snap.price)}`)
  lines.push(`- 现在: ${bjTime(snap.timestamp)}（北京）`)
  lines.push(`- 主周期: ${snap.primary}`)
  lines.push('')

  lines.push(...heatBlock(snap.heat))
  lines.push('')

  lines.push('## 各周期行情（把 K 线切成小段读出来的）')
  lines.push('')
  for (const b of snap.blocks) {
    lines.push(...blockSection(b))
    lines.push('')
  }

  lines.push('## 怎么用这些数据')
  lines.push('')
  lines.push(
    '- 每个周期都是**同一套读法**：先说整段概览，再按时间均分成几小段，'
  )
  lines.push(
    '  每段给开高低收 / 涨跌 / 量能变化 —— 全部由 K 线与成交量直接算出来，'
  )
  lines.push('  **没有任何技术指标**（无 MACD / RSI / 布林 / ATR）')
  lines.push(
    '- 「主周期」是我在图上看的那个，其余周期是拿来对照更大 / 更小级别的'
  )
  lines.push('- 段与段之间的**转折**（哪一段开始放量、哪一段动能掉了、')
  lines.push('  哪一段破了前一段的高/低点）才是重点，不要只念一遍数字')
  lines.push('- 严禁编造：只能用上面出现过的数字，没给的说不知道')
  lines.push('')

  return lines.join('\n')
}
