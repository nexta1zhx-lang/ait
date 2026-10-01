import {Candle} from '../types'
import {RallyWindow} from './swing'

/** 把一段 K 线压缩成人能读、AI 也能读的文字 */

const fmt = (n: number, d = 2): string =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', {maximumFractionDigits: d})
    : '—'

function bj(ts: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date(ts))
    .replace(',', '')
}

function mean(nums: number[]): number {
  if (!nums.length) return 0
  return nums.reduce((s, x) => s + x, 0) / nums.length
}

/** 段内结构：把段一分为二，比较前后半段的高低点 */
export function segmentStructure(seg: Candle[]): string {
  if (seg.length < 6) return '样本不足'
  const half = Math.floor(seg.length / 2)
  const a = seg.slice(0, half)
  const b = seg.slice(half)
  const parts: string[] = []
  const aHigh = Math.max(...a.map(c => c.high))
  const bHigh = Math.max(...b.map(c => c.high))
  const aLow = Math.min(...a.map(c => c.low))
  const bLow = Math.min(...b.map(c => c.low))
  if (bHigh > aHigh) parts.push('后半段创出更高的高点')
  else if (bHigh < aHigh) parts.push('后半段高点更低')
  if (bLow > aLow) parts.push('更高的低点')
  else if (bLow < aLow) parts.push('更低的低点')
  return parts.length ? parts.join(' + ') : '高低点基本持平（横盘）'
}

/** 段内最大回撤（从任一高点回落的最大幅度，正数表示跌幅%） */
export function maxDrawdownPct(seg: Candle[]): number {
  let peak = -Infinity
  let worst = 0
  for (const c of seg) {
    if (c.high > peak) peak = c.high
    if (peak > 0) {
      const dd = ((peak - c.low) / peak) * 100
      if (dd > worst) worst = dd
    }
  }
  return worst
}

/** 按比例抽样出收盘价序列，让 AI 能看出形状 */
export function sampleCloses(seg: Candle[], points = 12): string {
  if (!seg.length) return '—'
  const step = Math.max(1, Math.floor(seg.length / points))
  const out: string[] = []
  for (let i = 0; i < seg.length; i += step) out.push(fmt(seg[i].close, 0))
  if (out[out.length - 1] !== fmt(seg[seg.length - 1].close, 0)) {
    out.push(fmt(seg[seg.length - 1].close, 0))
  }
  return out.join(' → ')
}

export interface SegmentReport {
  label: string
  from: string
  to: string
  bars: number
  open: number
  close: number
  high: number
  low: number
  changePct: number
  rangePct: number
  maxDrawdownPct: number
  structure: string
  volAvg: number
  volMultiple: number | null
  series: string
}

function segment(
  candles: Candle[],
  from: number,
  to: number,
  label: string,
  baseVol?: number
): SegmentReport {
  const seg = candles.slice(from, to + 1)
  const open = seg[0]?.open ?? 0
  const close = seg[seg.length - 1]?.close ?? 0
  const high = Math.max(...seg.map(c => c.high))
  const low = Math.min(...seg.map(c => c.low))
  const volAvg = mean(seg.map(c => c.volume))
  return {
    label,
    from: bj(seg[0]?.timestamp ?? 0),
    to: bj(seg[seg.length - 1]?.timestamp ?? 0),
    bars: seg.length,
    open,
    close,
    high,
    low,
    changePct: open !== 0 ? (close / open - 1) * 100 : 0,
    rangePct: low !== 0 ? ((high - low) / low) * 100 : 0,
    maxDrawdownPct: maxDrawdownPct(seg),
    structure: segmentStructure(seg),
    volAvg,
    volMultiple: baseVol && baseVol > 0 ? volAvg / baseVol : null,
    series: sampleCloses(seg)
  }
}

/** 把「拉升前 / 拉升 / 拉升后」三段写成 AI 可读的文字 */
export function describeRally(
  candles: Candle[],
  win: RallyWindow
): {text: string; segments: SegmentReport[]} {
  const all = candles.slice(win.windowStart, win.windowEnd + 1)
  const pre = segment(
    all,
    0,
    Math.max(0, win.rallyStart - 1),
    '拉升前（蓄势/盘整）'
  )
  const rallySeg = segment(all, win.rallyStart, win.rallyEnd, '拉升段')
  const post = segment(
    all,
    Math.min(all.length - 1, win.rallyEnd + 1),
    all.length - 1,
    '拉升后',
    rallySeg.volAvg
  )

  const block = (s: SegmentReport) =>
    [
      `【${s.label}】${s.from} → ${s.to}，共 ${s.bars} 根`,
      `- 价格：${fmt(s.open)} → ${fmt(s.close)}（${s.changePct >= 0 ? '+' : ''}${fmt(s.changePct)}%）`,
      `- 区间：高 ${fmt(s.high)} / 低 ${fmt(s.low)}，振幅 ${fmt(s.rangePct)}%`,
      `- 最大回撤：-${fmt(s.maxDrawdownPct)}%`,
      `- 结构：${s.structure}`,
      `- 均量：${fmt(s.volAvg, 0)}${s.volMultiple !== null ? `（相对前段 ${fmt(s.volMultiple)} 倍）` : ''}`,
      `- 收盘价走势：${s.series}`
    ].join('\n')

  return {
    text: [block(pre), block(rallySeg), block(post)].join('\n\n'),
    segments: [pre, rallySeg, post]
  }
}
