import {ANALYSIS_BARS} from '../analysis/describe'
import {MarketSnapshot} from '../types'

/**
 * 行情快照 → 喂给 AI 的文本。
 *
 * ★ 2026-10-11 用户：「AI 的数据变了吧？不要给了，只给当前周期的前 100 根数据。」
 *
 * 所以这里只有三块：**基本信息 + 主周期最近 100 根逐根 + 怎么用这些数据**。
 * 「其余周期」「切成小段的结构描述」「EMA42」**一律不再出现** ——
 * `data/market.ts` 那边也只取、只造主周期这一个 block（2026-10-11 起连取都不取别的周期了）。
 *
 * ⚠️ **这里不算任何口径**：每根就是 时间 / 收盘 / 涨跌% / 量比，
 *    「哪一段在放量、哪一段动能掉了、哪个关键收盘被破了」全交给 AI 自己读。
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

  const block = snap.blocks.find(b => b.primary) ?? snap.blocks[0]
  if (block) {
    lines.push(
      `## ${block.timeframe} 最近 ${block.bars} 根` +
        '（逐根：时间 / 开 / 高 / 低 / 收 / 涨跌% / 量比）'
    )
    lines.push('')
    lines.push(
      `- 时间范围：${bjTime(block.from)} → ${bjTime(block.to)}（北京，最新在最后）`
    )
    lines.push('- **涨跌%** = 这一根收盘 ÷ 上一根收盘 − 1（第一根用它自己的开盘比）')
    lines.push(
      `- **量比** = 这一根的量 ÷ **前面同样长度那一段**（最多 ${block.bars} 根）的均量` +
        `（前面不够就用这 ${block.bars} 根自己的均量）`
    )
    lines.push('')
    lines.push(block.text.trim())
    lines.push('')
  }

  lines.push('## 怎么用这些数据')
  lines.push('')
  lines.push(
    `- 只有**一个周期**（主周期 ${snap.primary}）的**最近 ${ANALYSIS_BARS} 根**，` +
      '每根：时间 / 开 / 高 / 低 / 收 / 涨跌% / 量比'
  )
  lines.push(
    '- **没有**别的周期，**没有任何指标**（EMA / MACD / RSI / 布林 / ATR 都没有）'
  )
  lines.push(
    '- 高低点用**收盘价**看大方向；影线看**这一根的高 / 低**（插针、假突破都在这里面）'
  )
  lines.push(
    '- 「放量」只能这样看：**量比明显大于 1**，而且后面几根**守住了**没还手' +
      '（量比冲得很高但马上掉回去 = 出货）'
  )
  lines.push(
    '- 重点在**转折**：哪一段开始持续放量、哪一段动能掉了、哪一根量比突然冲到几倍 ——' +
      '不要只念一遍数字'
  )
  lines.push('- 严禁编造：只能用上面出现过的数字，没给的说不知道')
  lines.push('')

  return lines.join('\n')
}
