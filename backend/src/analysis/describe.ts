import {Candle} from '../types'
import {RallyWindow} from './swing'

/** 把一段 K 线压缩成人能读、AI 也能读的文字 */

/**
 * 按数值量级选小数位。
 *
 * ⚠️ 不能对价格写死小数位：DOGE 0.0945 用 0 位小数会变成「0」，
 * 一整个「收盘价走势」就成了一排 0，AI 根本看不到形状。
 * 规则跟 `output/render.ts` 、前端 `format.ts` 的 `decimalsFor` 一致。
 */
function decimalsFor(n: number): number {
  const a = Math.abs(n)
  if (!Number.isFinite(a) || a === 0) return 2
  if (a >= 100) return 2
  if (a >= 1) return 4
  if (a >= 0.01) return 5
  if (a >= 0.0001) return 6
  return 8
}

/** 不传位数就按量级自动定 —— 价格类字段一律不要写死位数 */
const fmt = (n: number, d?: number): string =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', {
        maximumFractionDigits: d === undefined ? decimalsFor(n) : d,
        minimumFractionDigits: 0
      })
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

/**
 * **最近几根的逐根明细**（最新那根在最后）。
 *
 * ★ 2026-10-11 加：用户问「是不是我输入数据的问题」—— 是。
 *   切段是「整段均分 5 段 + 每段抽 12 个收盘点」，于是主周期 1h（图上 30 天 = 720 根）
 *   每 12 小时才 1 个点、15m 每 ~48 分钟才 1 个点 ⇒ **「当前这一刻是强是弱」在输入里根本
 *   看不见**，模型只能从「这一段涨了多少」倒推，于是永远给「等回踩企稳」。
 *   这一段把最后 `recent` 根原样列出来（开高低收 / 量 / 涨跌），
 *   「该调不调」「不破前低」「极弱转强」这些判断才有依据。
 *
 * ⚠️ 只在**分析**那条链上传 `recent`（`data/market.ts`），别的调用方
 *    （`describeRally`）没传就是 0，输出逐字不变，别改坏那条链。
 */
export function tailLines(seg: Candle[], recent: number): string[] {
  const n = Math.min(recent, seg.length)
  if (n < 2) return []
  const tail = seg.slice(-n)
  const out = [`【最近 ${n} 根明细】（最新在最后）`]
  for (const c of tail) {
    const chg = c.open !== 0 ? (c.close / c.open - 1) * 100 : 0
    out.push(
      `- ${bj(c.timestamp)}  开 ${fmt(c.open)} 高 ${fmt(c.high)} 低 ${fmt(c.low)} 收 ${fmt(c.close)}` +
        `  涨跌 ${chg >= 0 ? '+' : ''}${fmt(chg, 2)}%  量 ${fmt(c.volume, 0)}`
    )
  }
  return out
}

/** 分析那条链给 AI 的根数（用户 2026-10-11：只给当前周期的前 100 根） */
export const ANALYSIS_BARS = 100

/**
 * **分析那条链的输入**：主周期最近 `n` 根，一根一行 ——
 * 时间 / 开 / 高 / 低 / 收 / 涨跌% / 量比。
 *
 * ★ 2026-10-11 用户：「AI 的数据变了吧？不要给了，只给当前周期的前 100 根数据。」
 *   → 同一天又说「全给数据吧」：**开 / 高 / 低 / 收 都给**（影线、插针都看得到）。
 *
 * 两个口径（按用户点名的字段）：
 *   · **涨跌%** = 这一根收盘 ÷ **上一根收盘** − 1（窗口第一根拿它自己的开盘当基准）。
 *     不是「开 → 收」：收对收才看得出连续性和跳空（开高低本身就在行里）。
 *   · **量比** = 这一根的量 ÷ **前面同样长度那一段**的均量（前面不够就用窗口自己的均量）。
 *     基准取自窗口外面 ⇒ 「放量」是相对**前面那一段**说的，不是相对它自己。
 */
export function barLines(candles: Candle[], n = ANALYSIS_BARS): string[] {
  const win = candles.slice(-Math.max(1, n))
  if (!win.length) return ['（没有 K 线）']
  const before = candles.slice(0, candles.length - win.length).slice(-win.length)
  const base = mean((before.length ? before : win).map(c => c.volume)) || 1
  const first = win[0]!
  return win.map((c, i) => {
    const prev = i === 0 ? {close: first.open} : win[i - 1]!
    const chg = Number(((prev.close > 0 ? c.close / prev.close - 1 : 0) * 100).toFixed(2))
    const pct = chg === 0 ? '0.00%' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`
    return (
      `${bj(c.timestamp)}  开 ${fmt(c.open)} 高 ${fmt(c.high)} 低 ${fmt(c.low)} ` +
      `收 ${fmt(c.close)}  ${pct}  量比 ${(c.volume / base).toFixed(1)}x`
    )
  })
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
  for (let i = 0; i < seg.length; i += step) out.push(fmt(seg[i].close))
  if (out[out.length - 1] !== fmt(seg[seg.length - 1].close)) {
    out.push(fmt(seg[seg.length - 1].close))
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

/** 一段行情写成 AI 可读的文字 */
export function renderSegment(s: SegmentReport): string {
  return [
    `【${s.label}】${s.from} → ${s.to}，共 ${s.bars} 根`,
    `- 价格：${fmt(s.open)} → ${fmt(s.close)}（${s.changePct >= 0 ? '+' : ''}${fmt(s.changePct, 2)}%）`,
    `- 区间：高 ${fmt(s.high)} / 低 ${fmt(s.low)}，振幅 ${fmt(s.rangePct, 2)}%`,
    `- 最大回撤：-${fmt(s.maxDrawdownPct, 2)}%`,
    `- 结构：${s.structure}`,
    `- 均量：${fmt(s.volAvg, 0)}${s.volMultiple !== null ? `（相对前段 ${fmt(s.volMultiple, 2)} 倍）` : ''}`,
    `- 收盘价走势：${s.series}`
  ].join('\n')
}

/** 整段行情的客观统计（不预设它是拉升还是下跌） */
export interface SeriesStats {
  bars: number
  open: number
  close: number
  high: number
  low: number
  changePct: number
  rangePct: number
  maxDrawdownPct: number
  /** 最高点出现在整段的百分之几处 */
  highAtPct: number
  lowAtPct: number
  volAvg: number
  /** 后半段均量 / 前半段均量 —— 看资金是越来越活跃还是越来越冷 */
  volTrend: number | null
}

export function seriesStats(candles: Candle[]): SeriesStats {
  const n = candles.length
  const open = candles[0]?.open ?? 0
  const close = candles[n - 1]?.close ?? 0
  let hi = -Infinity
  let lo = Infinity
  let hiIdx = 0
  let loIdx = 0
  candles.forEach((c, i) => {
    if (c.high > hi) {
      hi = c.high
      hiIdx = i
    }
    if (c.low < lo) {
      lo = c.low
      loIdx = i
    }
  })
  const vols = candles.map(c => c.volume)
  const half = Math.floor(n / 2)
  const v1 = mean(vols.slice(0, half))
  const v2 = mean(vols.slice(half))
  return {
    bars: n,
    open,
    close,
    high: hi,
    low: lo,
    changePct: open ? (close / open - 1) * 100 : 0,
    rangePct: lo ? ((hi - lo) / lo) * 100 : 0,
    maxDrawdownPct: maxDrawdownPct(candles),
    highAtPct: n > 1 ? (hiIdx / (n - 1)) * 100 : 0,
    lowAtPct: n > 1 ? (loIdx / (n - 1)) * 100 : 0,
    volAvg: mean(vols),
    volTrend: v1 > 0 ? v2 / v1 : null
  }
}

/**
 * 把整段行情切成若干小段写出来。
 *
 * **不预设它是拉升** —— 让 AI 自己看这段到底是拉升、下跌还是横盘，
 * 以及为什么会走成这样。
 */
export function describeSeries(
  candles: Candle[],
  parts = 5,
  /** 末尾再列几根逐根明细（0 = 不要；只有分析那条链会传，见 `tailLines`） */
  recent = 0
): {text: string; segments: SegmentReport[]; stats: SeriesStats} {
  if (!candles.length)
    return {
      text: '（没有 K 线）',
      segments: [],
      stats: seriesStats([])
    }

  const stats = seriesStats(candles)
  const n = candles.length
  const segments: SegmentReport[] = []
  const size = Math.max(1, Math.ceil(n / parts))
  for (let i = 0; i < n; i += size) {
    segments.push(
      segment(
        candles,
        i,
        Math.min(n - 1, i + size - 1),
        `第 ${segments.length + 1} 段`
      )
    )
  }

  const head = [
    `【整段概览】${bj(candles[0].timestamp)} → ${bj(candles[n - 1].timestamp)}，共 ${n} 根`,
    `- 价格：${fmt(stats.open)} → ${fmt(stats.close)}（${stats.changePct >= 0 ? '+' : ''}${fmt(stats.changePct, 2)}%）`,
    `- 区间：高 ${fmt(stats.high)} / 低 ${fmt(stats.low)}，振幅 ${fmt(stats.rangePct, 2)}%`,
    `- 最大回撤：-${fmt(stats.maxDrawdownPct, 2)}%`,
    `- 最高点在整段 ${Math.round(stats.highAtPct)}% 处，最低点在 ${Math.round(stats.lowAtPct)}% 处`,
    `- 均量 ${fmt(stats.volAvg, 0)}${
      stats.volTrend !== null
        ? `，后半段均量 / 前半段 = ${fmt(stats.volTrend, 2)} 倍`
        : ''
    }`
  ].join('\n')

  const tail = recent > 0 ? tailLines(candles, recent) : []
  return {
    text: [head, ...segments.map(renderSegment), ...tail].join('\n\n'),
    segments,
    stats
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

  return {
    text: [pre, rallySeg, post].map(renderSegment).join('\n\n'),
    segments: [pre, rallySeg, post]
  }
}
