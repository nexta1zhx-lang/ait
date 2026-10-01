import {Candle} from '../types'

/**
 * 「拉升」检测 —— 成熟做法：ATR 归一化的 ZigZag 拐点 + 力度/资金打分。
 *
 * 1. 先算 ATR(Wilder)，用它把价格波动归一化，这样不同币、不同周期可比
 * 2. ZigZag：从极值回撤超过 k×ATR 才认转折，滤掉噪声
 * 3. 把相邻拐点连成「腿」(leg)，只看上升腿
 * 4. 打分 = 力度(涨了几个 ATR) × 资金(量能放大倍数)
 * 5. 取分最高且够得上门槛的那条腿 = 主拉升
 * 6. 截取「拉升前 N 根 + 拉升段 + 拉升后 M 根」作为入库窗口
 */

export interface Pivot {
  index: number
  price: number
  type: 'high' | 'low'
}

export interface Leg {
  fromIndex: number
  toIndex: number
  fromPrice: number
  toPrice: number
  direction: 'up' | 'down'
  bars: number
  changePct: number
  /** 涨跌幅相当于几个 ATR */
  atrMultiple: number
  /** 拉升段的均量 / 之前基准段的均量 */
  volMultiple: number | null
  /** 力度 × 资金 */
  score: number
}

export interface SwingOptions {
  /** ATR 周期 */
  atrPeriod?: number
  /** ZigZag 阈值：回撤超过几倍 ATR 才算转折 */
  zigzagAtr?: number
  /** 上升腿至少涨几倍 ATR 才算得上是「拉升」 */
  minRiseAtr?: number
  /** 量能对比的基准根数 */
  volLookback?: number
  /** 入库窗口：拉升前最多保留多少根 */
  preBars?: number
  /** 入库窗口：拉升后最多保留多少根 */
  postBars?: number
}

export interface RallyWindow {
  leg: Leg
  /** 窗口在原始 candles 里的下标（闭区间） */
  windowStart: number
  windowEnd: number
  /** 拉升起点 / 终点在窗口内的相对下标 */
  rallyStart: number
  rallyEnd: number
  /** 窗口内实际保留的前段 / 后段根数 */
  preBars: number
  postBars: number
  /** 这段是否真的够得上「拉升」标准 */
  isRally: boolean
}

export const DEFAULT_SWING: Required<SwingOptions> = {
  atrPeriod: 14,
  zigzagAtr: 2,
  minRiseAtr: 3,
  volLookback: 20,
  preBars: 60,
  postBars: 40
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function trueRange(candles: Candle[], i: number): number {
  const c = candles[i]
  if (i === 0) return c.high - c.low
  const p = candles[i - 1].close
  return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p))
}

/** Wilder 平滑的 ATR 序列 */
export function atrSeries(candles: Candle[], period = 14): number[] {
  const n = candles.length
  const out = new Array<number>(n).fill(0)
  if (n === 0) return out
  let prev = trueRange(candles, 0)
  out[0] = prev
  for (let i = 1; i < n; i++) {
    const tr = trueRange(candles, i)
    prev =
      i < period
        ? (prev * i + tr) / (i + 1)
        : (prev * (period - 1) + tr) / period
    out[i] = prev
  }
  return out
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((s, x) => s + x, 0) / nums.length
}

function atrAt(atr: number[], candles: Candle[], i: number): number {
  const v = atr[i]
  if (Number.isFinite(v) && v > 0) return v
  for (let j = i; j >= 0; j--) {
    if (Number.isFinite(atr[j]) && atr[j] > 0) return atr[j]
  }
  return Math.max(1e-12, candles[i].high - candles[i].low)
}

function meanAtr(
  atr: number[],
  candles: Candle[],
  from: number,
  to: number
): number {
  const vals: number[] = []
  for (let i = from; i <= to; i++) vals.push(atrAt(atr, candles, i))
  return mean(vals)
}

/** 拉升段均量 / 之前 volLookback 根的均量 */
function volumeRatio(
  candles: Candle[],
  from: number,
  to: number,
  lookback: number
): number | null {
  const segAvg = mean(candles.slice(from, to + 1).map(c => c.volume))
  const base = candles
    .slice(Math.max(0, from - lookback), from)
    .map(c => c.volume)
  if (base.length < 3) return null
  const baseAvg = mean(base)
  if (!(baseAvg > 0)) return null
  return segAvg / baseAvg
}

/* ------------------------------------------------------------------ */
/* ZigZag 拐点                                                         */
/* ------------------------------------------------------------------ */

export function detectPivots(candles: Candle[], atr: number[], k = 2): Pivot[] {
  const n = candles.length
  const pivots: Pivot[] = []
  if (n < 3) return pivots

  const push = (index: number, price: number, type: 'high' | 'low') => {
    const last = pivots[pivots.length - 1]
    if (last && last.index === index) return
    pivots.push({index, price, type})
  }

  let trend: 1 | -1 | 0 = 0
  let hiIdx = 0
  let hi = candles[0].high
  let loIdx = 0
  let lo = candles[0].low

  for (let i = 1; i < n; i++) {
    const thr = k * atrAt(atr, candles, i)
    const h = candles[i].high
    const l = candles[i].low

    if (trend === 0) {
      // 哪个方向的阈值先被突破，就定哪个方向
      if (h - lo >= thr) {
        push(loIdx, lo, 'low')
        trend = 1
        hi = h
        hiIdx = i
        continue
      }
      if (hi - l >= thr) {
        push(hiIdx, hi, 'high')
        trend = -1
        lo = l
        loIdx = i
        continue
      }
      if (h > hi) {
        hi = h
        hiIdx = i
      }
      if (l < lo) {
        lo = l
        loIdx = i
      }
      continue
    }

    if (trend === 1) {
      if (h > hi) {
        hi = h
        hiIdx = i
      }
      if (hi - l >= thr) {
        push(hiIdx, hi, 'high')
        trend = -1
        lo = l
        loIdx = i
      }
      continue
    }

    // trend === -1
    if (l < lo) {
      lo = l
      loIdx = i
    }
    if (h - lo >= thr) {
      push(loIdx, lo, 'low')
      trend = 1
      hi = h
      hiIdx = i
    }
  }

  if (trend === 1) push(hiIdx, hi, 'high')
  else if (trend === -1) push(loIdx, lo, 'low')

  return pivots
}

/** 拐点 → 腿 */
export function buildLegs(
  candles: Candle[],
  pivots: Pivot[],
  atr: number[],
  volLookback = 20
): Leg[] {
  const legs: Leg[] = []
  for (let i = 0; i + 1 < pivots.length; i++) {
    const a = pivots[i]
    const b = pivots[i + 1]
    const avgA = meanAtr(atr, candles, a.index, b.index)
    const move = Math.abs(b.price - a.price)
    const atrMultiple = avgA > 0 ? move / avgA : 0
    const volMultiple = volumeRatio(candles, a.index, b.index, volLookback)
    const leg: Leg = {
      fromIndex: a.index,
      toIndex: b.index,
      fromPrice: a.price,
      toPrice: b.price,
      direction: b.price > a.price ? 'up' : 'down',
      bars: b.index - a.index + 1,
      changePct: a.price !== 0 ? (b.price / a.price - 1) * 100 : 0,
      atrMultiple,
      volMultiple,
      score: 0
    }
    // 力度 × 资金：涨得多 + 放量足 = 强
    leg.score = atrMultiple * Math.max(0.3, volMultiple ?? 1)
    legs.push(leg)
  }
  return legs
}

/* ------------------------------------------------------------------ */
/* 主拉升                                                              */
/* ------------------------------------------------------------------ */

export function findMainRally(
  candles: Candle[],
  options: SwingOptions = {}
): RallyWindow | null {
  const o = {...DEFAULT_SWING, ...options}
  if (candles.length < o.atrPeriod + 5) return null

  const atr = atrSeries(candles, o.atrPeriod)
  const pivots = detectPivots(candles, atr, o.zigzagAtr)
  const legs = buildLegs(candles, pivots, atr, o.volLookback)
  const ups = legs.filter(l => l.direction === 'up')
  if (ups.length === 0) return null

  const qualified = ups.filter(l => l.atrMultiple >= o.minRiseAtr)
  const pool = qualified.length > 0 ? qualified : ups
  const best = pool.reduce((a, b) => (b.score > a.score ? b : a))

  const windowStart = Math.max(0, best.fromIndex - o.preBars)
  const windowEnd = Math.min(candles.length - 1, best.toIndex + o.postBars)

  return {
    leg: best,
    windowStart,
    windowEnd,
    rallyStart: best.fromIndex - windowStart,
    rallyEnd: best.toIndex - windowStart,
    preBars: best.fromIndex - windowStart,
    postBars: windowEnd - best.toIndex,
    isRally: qualified.length > 0
  }
}

/** 截出入库窗口的 K 线 */
export function sliceWindow(candles: Candle[], win: RallyWindow): Candle[] {
  return candles.slice(win.windowStart, win.windowEnd + 1)
}
