/**
 * 图上的压力 / 支撑 —— **按界面上真正显示的那段 K 线自动算**。
 *
 * 以前这两个数来自后端：固定「最近 4 根 1h」的最高 / 最低（图例写着「压力(4H)」），
 * 所以看 5 分图时那两条线跟屏幕上的 K 线基本没什么关系（用户 2026-10-04 提的
 * 「我需要的是根据我的界面显示 k 自动计算」）。
 *
 * 现在的口径：
 *   · **只看当前可见窗口** —— 缩放 / 平移之后自动重算
 *   · 取**显著摆动高低点**（真正转头的位置）：压力 = 现价上方最近的一个、
 *     支撑 = 下方最近的一个；并且要求它**离现价至少隔开这一段的 12%**
 *     （只要「最近」，实测 5 分图上会贴到 0.01% —— 等于没画）
 *   · 这一侧没有够格的拐点 → 退回「这一段图上的最高 / 最低」，**提示里会写明是退路**
 *
 * ⚠️⚠️ 为什么不用「分形拐点（左右各比 wing 根）」：试过，**太密**。
 *     5 分图上量过：最近的上方摆动高点离现价只有 **0.01%**（8 个点）、下方 0.005%
 *     —— 线基本贴在价格上，等于没画（左右各比 3 根就把 3 根的小抖动全算成「摆动」）。
 *     现在改用后端 `analysis/swing.ts` 那套 **ATR 归一化 ZigZag**：
 *     从极值回撤超过 `k × ATR` 才认转折 —— 「摆动」才真的是摆动。
 *     而且 ATR 天生做了归一化，不同币 / 不同周期共用一套阈值。
 *
 * 纯函数、无副作用：拿「K 线数组 + 可见下标范围」就能算，不额外发请求。
 */
import type {Candle} from './api'

export interface Levels {
  /** 现价上方最近的显著摆动高点 */
  resistance: number | null
  /** 现价下方最近的显著摆动低点 */
  support: number | null
  /** 这两个价位来自 `candles` 里的哪一根（-1 = 没有） */
  resIndex: number
  supIndex: number
  /** 这个价是怎么来的（提示里要说清楚） */
  resSource: LevelSource | null
  supSource: LevelSource | null
}

/**
 * 一个价位是怎么来的。
 * `swing` = 显著摆动拐点（首选）；`range` = 这一段图上的最高 / 最低（没拐点可用时的退路）。
 */
export type LevelSource = 'swing' | 'range'

/** 空的一份（每次新对象，别让调用方共享同一个可变引用） */
export function emptyLevels(): Levels {
  return {
    resistance: null,
    support: null,
    resIndex: -1,
    supIndex: -1,
    resSource: null,
    supSource: null
  }
}

/* ---------------- ATR（Wilder），跟后端 `analysis/swing.ts` 同一套 ---------------- */

function trueRange(win: Candle[], i: number): number {
  const c = win[i]
  if (i === 0) return c.high - c.low
  const p = win[i - 1].close
  return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p))
}

function atrSeries(win: Candle[], period = 14): number[] {
  const out = new Array<number>(win.length).fill(0)
  if (!win.length) return out
  let prev = trueRange(win, 0)
  out[0] = prev
  for (let i = 1; i < win.length; i++) {
    const tr = trueRange(win, i)
    prev =
      i < period
        ? (prev * i + tr) / (i + 1)
        : (prev * (period - 1) + tr) / period
    out[i] = prev
  }
  return out
}

/* ---------------- ZigZag 拐点 ---------------- */

interface Pivot {
  index: number
  price: number
  high: boolean
}

/** 回撤超过几倍 ATR 才算一次转折（跟后端默认值一致） */
const ZIGZAG_ATR = 2

/**
 * 挑出来的那个拐点还得**至少离现价这么远**（占这一段振幅的比例）。
 *
 * 0.12 是拿真数据扫出来的：BTC 的 1h / 15m / 5m 各测一遍，
 * 压力 / 支撑分别落在 ±(0.86%, 0.79%) / ±(2.19%, 1.06%) / ±(0.09%, 0.10%)，
 * 三个周期都是「看得见、又不贴住价格」；再小（8%）就开始贴了。
 */
const MIN_GAP_OF_RANGE = 0.12

/**
 * ATR 归一化 ZigZag：从极值回撤超过 `k × ATR` 才认转折。
 * 跟后端 `detectPivots()` 是同一套逻辑（那边还拿它找「主拉升」，这里只取拐点）。
 */
function zigzagPivots(win: Candle[], atr: number[], k = ZIGZAG_ATR): Pivot[] {
  const pivots: Pivot[] = []
  if (win.length < 3) return pivots

  const push = (index: number, price: number, high: boolean) => {
    const last = pivots[pivots.length - 1]
    if (last && last.index === index) return
    pivots.push({index, price, high})
  }

  let trend: 1 | -1 | 0 = 0
  let hiIdx = 0
  let hi = win[0].high
  let loIdx = 0
  let lo = win[0].low

  for (let i = 1; i < win.length; i++) {
    // ATR 起步阶段可能是 0/NaN，退回用这根自己的振幅，别让阈值变成 0
    const a = atr[i]
    const thr = k * (Number.isFinite(a) && a > 0 ? a : win[i].high - win[i].low)
    const h = win[i].high
    const l = win[i].low

    if (trend === 0) {
      // 哪个方向的阈值先被突破，就定哪个方向
      if (h - lo >= thr) {
        push(loIdx, lo, false)
        trend = 1
        hi = h
        hiIdx = i
        continue
      }
      if (hi - l >= thr) {
        push(hiIdx, hi, true)
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
        push(hiIdx, hi, true)
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
      push(loIdx, lo, false)
      trend = 1
      hi = h
      hiIdx = i
    }
  }
  return pivots
}

/**
 * 从拐点里挑**离 `ref` 最近、而且在它那一侧、并且至少隔开 `minGap`** 的那个。
 *
 * ⚠️ 为什么还要 `minGap`：「最近的那个拐点」有时候就在价格旁边（现价刚从一个
 *    小极值回头），实测 5 分图上只有 **0.01%** —— 线贴在价格上，等于没画。
 *    要求它离现价至少“这一段振幅的 12%”，两条线才都在看得见的位置上。
 */
function pickSwing(
  pivots: Pivot[],
  ref: number,
  minGap: number,
  above: boolean
): Pivot | null {
  let best: Pivot | null = null
  for (const p of pivots) {
    const gap = above ? p.price - ref : ref - p.price
    if (gap < minGap) continue
    if (!best || gap < (above ? best.price - ref : ref - best.price)) best = p
  }
  return best
}

/** 窗口里最高 / 最低的那一根（`above` 决定找最高还是最低） */
function extreme(
  win: Candle[],
  above: boolean
): {index: number; price: number} {
  let idx = 0
  let best = above ? win[0].high : win[0].low
  for (let i = 1; i < win.length; i++) {
    const p = above ? win[i].high : win[i].low
    if (above ? p > best : p < best) {
      best = p
      idx = i
    }
  }
  return {index: idx, price: best}
}

/**
 * 算出这一屏该画的两条线。
 *
 * `from` / `to` 是**可见窗口**在 `candles` 里的下标（`getVisibleLogicalRange()`
 * 给的是小数、还可能为负或超出，这里会夹好）。参考价取窗口内**最后一根的收盘价**
 * —— 跟右侧那排 ±% 标签用的参考价是同一个（都对着可见窗口）。
 */
export function nearestLevels(
  candles: Candle[],
  from: number,
  to: number
): Levels {
  if (!Array.isArray(candles) || !candles.length) return emptyLevels()
  const a = Math.max(0, Math.floor(Math.min(from, to)))
  const b = Math.min(candles.length - 1, Math.ceil(Math.max(from, to)))
  const win = candles.slice(a, b + 1)
  // ATR + ZigZag 在太短的窗口上没有意义
  if (win.length < 20) return emptyLevels()

  const pivots = zigzagPivots(win, atrSeries(win))
  const ref = win[win.length - 1].close

  /*
   * 「至少隔多远」按**这一段自己的振幅**算（不写死百分比）：
   * 振幅大的行情自然允许更远的线，死水微澜的时候线也该离得近。
   */
  let hi = -Infinity
  let lo = Infinity
  for (const c of win) {
    if (c.high > hi) hi = c.high
    if (c.low < lo) lo = c.low
  }
  const minGap = (hi - lo) * MIN_GAP_OF_RANGE

  const up = pickSwing(
    pivots.filter(p => p.high),
    ref,
    minGap,
    true
  )
  const dn = pickSwing(
    pivots.filter(p => !p.high),
    ref,
    minGap,
    false
  )

  /*
   * 这一侧一个够格的拐点都没有（比如正冲新高、上方还没回头过）→
   * 退回「这一段图上的最高 / 最低」，总比什么都不画强。
   * 提示里会写明这是退路（不是拐点），不装成拐点。
   */
  const upBar = up ? null : ref < hi ? extreme(win, true) : null
  const dnBar = dn ? null : ref > lo ? extreme(win, false) : null

  return {
    resistance: up ? up.price : upBar ? upBar.price : null,
    support: dn ? dn.price : dnBar ? dnBar.price : null,
    resIndex: up ? a + up.index : upBar ? a + upBar.index : -1,
    supIndex: dn ? a + dn.index : dnBar ? a + dnBar.index : -1,
    resSource: up ? 'swing' : upBar ? 'range' : null,
    supSource: dn ? 'swing' : dnBar ? 'range' : null
  }
}
