<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import * as LWC from 'lightweight-charts'
import {fetchCandles, type Candle, type LevelSR} from '../api'
import {CHART_BARS} from '../analyze'
import TimeModal from './TimeModal.vue'
import {bjInputToMs, bjInputValue, bjShort, bjTime, fmt} from '../format'

/**
 * K 线图（TradingView Lightweight Charts）。
 *
 * 图例里的每一条线都可以点击控制显隐，默认**全部隐藏**。
 * 右侧会贴着价格轴显示每条线的价位相对当前价的百分比。
 */

const props = defineProps<{
  symbol: string
  timeframe: string
  /** 从哪一刻开始画：'YYYY-MM-DDTHH:mm'（北京时间）。空 = 画最近的 */
  from?: string
  /**
   * 画到哪一刻为止（同上格式）。空 = 一直画到最新。
   *
   * 「测试」模式用：回到过去某一刻，图就不能再露出之后的行情，
   * 否则人看到的是未来，而 AI 只看到当时 —— 两边根本不是同一局。
   */
  until?: string
  /** 允许在图上拖出一个范围（「添加案例」才开） */
  selectable?: boolean
  /**
   * 测试模式：等着我在图上点一下，把**结束线**放在「我看到这一根收盘为止」。
   *
   * 跟 `selectable`（拖一段）是两回事：取数只用到**一个时刻**，
   * 划一段会让人以为 AI 只看那一段。
   */
  pickPoint?: boolean
  /** 结束线那一刻（毫秒，= 最后一根已收盘 K 线的收尾时刻）；null = 还没定 */
  pointAt?: number | null
  /** 已经画好的范围（毫秒）—— 画面上会一直高亮着 */
  range?: {from: number; to: number} | null
  /** 是不是正在「等着我拖一段」。按钮在左边面板，这里只管状态 */
  drawing?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:timeframe', v: string): void
  (e: 'update:from', v: string): void
  (e: 'error', msg: string): void
  (e: 'loaded', candles: Candle[]): void
  /** 拖完松手：这一段就是我要的 */
  (e: 'select', v: {from: number; to: number; bars: number}): void
  (e: 'clear:select'): void
  /** 点了结束线：`at` = 那一刻（= 点中那根的收尾时刻） */
  (e: 'point', at: number): void
  /** 定完了 / 按 Esc 了 → 退出选线模式 */
  (e: 'update:pickPoint', v: boolean): void
  /** 拖完了 / 按 Esc 了 → 退出拖动模式 */
  (e: 'update:drawing', v: boolean): void
}>()

/** 'YYYY-MM-DDTHH:mm'（北京时间）→ 毫秒；空或无效给 0 */
function rangeMs(v: string | undefined): number {
  return v ? bjInputToMs(v) : 0
}

/** 拉多少根是**内部策略**，不往界面上摆（用户只看时间） */
const DEFAULT_BARS = CHART_BARS
/** 一遍最多拉多少根（防止区间太大把浏览器拖死） */
const MAX_BARS = 3000

/**
 * 往前拖到底时，一次再补多少根（按周期定）。
 *
 * 目标是一眼能看出「又多了一段」，又不至于一次拉太多卡住：
 * 5m≈3.5 天、15m≈10 天、1h≈41 天、4h≈100 天、1d≈400 天。
 */
const HISTORY_BARS: Record<string, number> = {
  '5m': 1000,
  '15m': 1000,
  '1h': 1000,
  '4h': 600,
  '1d': 400
}

/** 一直往前翻的上限（保护浏览器，别无限堆） */
const MAX_TOTAL_BARS = 20000

const fromMs = computed(() => rangeMs(props.from))
/** 右端时间点；没设 or 设成未来都等于「跟着现在走」 */
const untilMs = computed(() => rangeMs(props.until))
const testMode = computed(() => untilMs.value > 0 && untilMs.value < Date.now())

/**
 * 测试模式下最后一根**已收盘** K 线的开盘时间。
 *
 * 选 02:37 时，02:00~03:00 那根要丢掉 —— 它的最高/最低/收盘
 * 都是 02:37 之后才知道的「未来」，跟 AI 看到的不一样。
 */
const lastClosedMs = computed(() =>
  testMode.value ? (Math.floor(untilMs.value / tfMs()) - 1) * tfMs() : 0
)

/** 这次要画到哪一刻：测试模式钉在那一刻，否则就是现在 */
function endMs(): number {
  return testMode.value ? untilMs.value : Date.now()
}

/** 选了开始时间（且它确实在结束时间之前）就从那一刻画到结束时间 */
const ranged = computed(() => fromMs.value > 0 && fromMs.value < endMs())

function clearRange() {
  emit('update:from', '')
}

/* ---------------- 时间弹窗（选年月日时分） ---------------- */

const TF_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
}

function tfMs(): number {
  return TF_MS[props.timeframe] ?? TF_MS['4h']
}

/** 往前补历史的步长（根） */
function historyBars(): number {
  return HISTORY_BARS[props.timeframe] ?? 1000
}

/** 要拉多少根：从开始时间到结束时间的跨度（没选时间就拉最近的） */
function barsToLoad(): number {
  if (!ranged.value) return DEFAULT_BARS
  const span = Math.ceil((endMs() - fromMs.value) / tfMs()) + 1
  return Math.min(MAX_BARS, Math.max(DEFAULT_BARS, span))
}

const pickerOpen = ref(false)

/** 打开弹窗时给的初始值：选过就用它，没选过就按「最近 DEFAULT_BARS 根」猜一个 */
const pickerInitial = computed(
  () => fromMs.value || Math.max(endMs() - tfMs() * DEFAULT_BARS, 0)
)

function openPicker() {
  pickerOpen.value = true
}

function onPickTime(ms: number) {
  emit('update:from', bjInputValue(ms))
}

const TFS = [
  {value: '5m', label: '5分'},
  {value: '15m', label: '15分'},
  {value: '1h', label: '1时'},
  {value: '4h', label: '4时'},
  {value: '1d', label: '日线'}
]

/* ---------------- 状态 ---------------- */

/** 图例可点击项的显隐状态（默认全部关闭） */
const VISIBLE = ref<Record<string, boolean>>({
  volume: false,
  ema42: false,
  res: false,
  sup: false
})

const LEGEND = [
  {key: 'volume', label: '成交量', dot: 'vol'},
  {key: 'ema42', label: 'EMA42', dot: 'ema'},
  {key: 'res', label: '压力(4H)', dot: 'res'},
  {key: 'sup', label: '支撑(4H)', dot: 'sup'}
]

const chartEl = ref<HTMLElement | null>(null)
const levelHost = ref<HTMLElement | null>(null)
const infoEl = ref<HTMLElement | null>(null)
const deltaEl = ref<HTMLElement | null>(null)

const logScale = ref(false)

/* ---------------- 图表实例（不在响应式里，避免被代理） ---------------- */

interface ChartRefs {
  chart: any
  candle: any
  volume: any
  ema42: any
}

let refs: ChartRefs | null = null
let priceLines: any[] = []
let levelLabels: {price: number; el: HTMLElement}[] = []
let candles: Candle[] = []
let candleIndex = new Map<number, number>()
let volMa: number[] = []
let emaValues: number[] = []
let overlay: {sr: LevelSR | null; refPrice: number} = {
  sr: null,
  refPrice: NaN
}

/** 正在往前补历史（防重入） */
let loadingOlder = false
/** 已经拉到头了（交易所没有更早的了） */
let reachedStart = false
/** 用户是否真的拖过 / 滚过图表（区分程序自己动的） */
let userPanned = false
/** 这次 setData 往前塞了多少根（用来把视图钉在原地） */
let prependCount = 0

/* ---------------- 指标 ---------------- */

function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let prev = 0
  for (let i = 0; i < period; i++) prev += values[i]
  prev /= period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/* ---------------- 时间刻度 ---------------- */

function bjPartsOf(time: number | string | Date) {
  const d =
    typeof time === 'number' ? new Date(time * 1000) : new Date(time as string)
  const o: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d))
    o[p.type] = p.value
  return o
}

/** 底部坐标刻度：按粒度显示 年 / 月 / 日 / 时:分（北京时间） */
function formatTickMark(time: number, tickMarkType: number): string {
  const T = LWC.TickMarkType
  const p = bjPartsOf(time)
  if (tickMarkType === T.Year) return p.year
  if (tickMarkType === T.Month) return `${Number(p.month)}月`
  if (tickMarkType === T.DayOfMonth)
    return `${Number(p.month)}/${Number(p.day)}`
  return `${p.hour}:${p.minute}`
}

/* ---------------- 创建图表 ---------------- */

function ensureChart(): boolean {
  if (!chartEl.value) return false
  if (refs) return true

  const chart = LWC.createChart(chartEl.value, {
    autoSize: true,
    layout: {
      background: {type: LWC.ColorType.Solid, color: '#0b0f14'},
      textColor: '#8b949e',
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'
    },
    grid: {
      vertLines: {color: 'rgba(255,255,255,0.05)'},
      horzLines: {color: 'rgba(255,255,255,0.05)'}
    },
    rightPriceScale: {borderColor: 'rgba(255,255,255,0.12)'},
    timeScale: {
      borderColor: 'rgba(255,255,255,0.12)',
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      tickMarkFormatter: (time: number, type: number) =>
        formatTickMark(time, type)
    },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: {labelBackgroundColor: '#2a3441'},
      horzLine: {labelBackgroundColor: '#2a3441'}
    },
    localization: {
      locale: 'zh-CN',
      priceFormatter: (p: number) => fmt(p),
      timeFormatter: (t: number) => bjShort(t)
    }
  })

  const candle = chart.addSeries(LWC.CandlestickSeries, {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350'
  })

  const volume = chart.addSeries(LWC.HistogramSeries, {
    priceFormat: {type: 'volume'},
    priceScaleId: '',
    lastValueVisible: false,
    priceLineVisible: false
  })
  volume.priceScale().applyOptions({scaleMargins: {top: 0.82, bottom: 0}})

  const ema42 = chart.addSeries(LWC.LineSeries, {
    color: 'rgba(255,193,7,0.85)',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false
  })

  refs = {chart, candle, volume, ema42}

  // 视图变化：右侧百分比标签重新定位 + 让信息栏/参考价跟着可见窗口走
  chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
    positionLabels()
    syncWindowRefs()
    // 用户拖/滚到最左边了 → 把更早的历史补进来（Binance 那种往前翻）
    if (userPanned && range && range.from <= 3) void loadOlder()
  })
  chart.subscribeCrosshairMove((param: any) => {
    updateHover(param)
    positionLabels()
  })

  // 只有用户自己动过（拖动 / 滚轮）才算「想看更早的」，避免加载后自己触发
  const markPanned = () => (userPanned = true)
  chartEl.value.addEventListener('pointerdown', markPanned)
  chartEl.value.addEventListener('wheel', markPanned, {passive: true})

  return true
}

/* ---------------- 叠加层：价格线 ---------------- */

function levelList(): {p: number; color: string; title: string}[] {
  const v = VISIBLE.value
  const list: {p: number; color: string; title: string}[] = []
  const push = (p: unknown, color: string, title: string, on: boolean) => {
    if (!on) return
    const n = Number(p)
    if (!Number.isFinite(n)) return
    list.push({p: n, color, title})
  }

  // 最近 4 小时的压力 / 支撑（没有就不画）
  push(overlay.sr?.resistance, '#ffa726', '压力', v.res)
  push(overlay.sr?.support, '#26c6da', '支撑', v.sup)

  return list
}

/** 根据显隐状态重绘均线、成交量、价格线与右侧百分比 */
function renderOverlays() {
  if (!refs) return
  const v = VISIBLE.value
  refs.ema42.applyOptions({visible: v.ema42})
  refs.volume.applyOptions({visible: v.volume})

  for (const l of priceLines) {
    try {
      refs.candle.removePriceLine(l)
    } catch {
      /* 已移除 */
    }
  }
  priceLines = []

  for (const lv of levelList()) {
    priceLines.push(
      refs.candle.createPriceLine({
        price: lv.p,
        color: lv.color,
        lineWidth: 1,
        lineStyle: LWC.LineStyle.Dashed,
        axisLabelVisible: true,
        title: lv.title
      })
    )
  }

  renderLabels()
}

/* ---------------- 右侧百分比标签 ---------------- */

function renderLabels() {
  const host = levelHost.value
  if (!host) return
  host.innerHTML = ''
  levelLabels = []

  const refPrice = overlay.refPrice
  if (!refs || !Number.isFinite(refPrice) || refPrice <= 0) return

  for (const lv of levelList()) {
    const el = document.createElement('span')
    el.style.color = lv.color
    el.title = `${lv.title} ${fmt(lv.p)}`
    const pct = ((lv.p - refPrice) / refPrice) * 100
    el.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
    host.appendChild(el)
    levelLabels.push({price: lv.p, el})
  }
  positionLabels()
}

/** 平移 / 缩放时更新标签位置 */
function positionLabels() {
  if (!refs) return
  const host = levelHost.value
  if (host) {
    const axisW = refs.chart.priceScale('right').width()
    host.style.right = Math.max(0, axisW) + 'px'
  }
  for (const item of levelLabels) {
    const y = refs.candle.priceToCoordinate(item.price)
    if (y === null || y === undefined || !Number.isFinite(y)) {
      item.el.style.display = 'none'
      continue
    }
    item.el.style.display = ''
    item.el.style.top = y + 'px'
  }
  // 画好的范围框要跟着视图走
  drawSelection()
}

/* ---------------- 左上角信息栏 ---------------- */

/** 成交量：上百万就拿 M 说事，看着不炸眼 */
function fmtVol(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—'
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  return fmt(v, 0)
}

function infoHTML(
  timeSec: number,
  bar: {open: number; high: number; low: number; close: number},
  vol: number,
  volRatio: number
): string {
  const p = bjPartsOf(timeSec)
  const chg = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : NaN
  const cls = Number.isFinite(chg) ? (chg >= 0 ? 'up' : 'down') : ''
  const chgText = Number.isFinite(chg)
    ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`
    : '—'
  return [
    `<span>${p.month}/${p.day} ${p.hour}:${p.minute}</span>`,
    `<span><span class="k">开</span>${fmt(bar.open)}</span>`,
    `<span><span class="k">高</span>${fmt(bar.high)}</span>`,
    `<span><span class="k">低</span>${fmt(bar.low)}</span>`,
    `<span><span class="k">收</span>${fmt(bar.close)}</span>`,
    `<span class="${cls}">${chgText}</span>`,
    `<span><span class="k">成交量</span>${fmtVol(vol)}${
      Number.isFinite(volRatio) ? ` <em>${volRatio.toFixed(2)}x</em>` : ''
    }</span>`
  ].join('')
}

/** 未悬停时展示第 i 根 K 线 */
function showInfoAt(i: number) {
  if (!infoEl.value || !candles.length) return
  const idx = Math.min(candles.length - 1, Math.max(0, i))
  const c = candles[idx]
  const ma = volMa[idx]
  infoEl.value.innerHTML = infoHTML(
    Math.floor(c.timestamp / 1000),
    {open: c.open, high: c.high, low: c.low, close: c.close},
    c.volume,
    Number.isFinite(ma) && ma > 0 ? c.volume / ma : NaN
  )
}

/** 当前可见窗口最右边那一根（没有就退回最后一根） */
function rightmostVisibleIndex(): number {
  if (!refs || !candles.length) return candles.length - 1
  const r = refs.chart.timeScale().getVisibleLogicalRange()
  const last = candles.length - 1
  if (!r) return last
  return Math.min(last, Math.max(0, Math.round(r.to)))
}

/**
 * 所有显示都跟着「当前可见窗口」走：
 * 左上角信息栏 = 窗口最右边那根；右侧 ±% = 相对它的收盘价。
 */
function syncWindowRefs() {
  if (!refs || !candles.length) return
  const i = rightmostVisibleIndex()
  const c = candles[i]
  if (Number.isFinite(c?.close)) {
    overlay.refPrice = c.close
    renderLabels()
  }
  showInfoAt(i)
}

/** 悬停 / 触碰：更新左上角信息栏与右侧「相对当前价」 */
function updateHover(param: any) {
  const reset = () => {
    deltaEl.value?.classList.add('hidden')
    showInfoAt(rightmostVisibleIndex())
  }

  if (!refs || !param?.point || param.time === undefined) return reset()

  const bar = param.seriesData?.get(refs.candle)
  if (!bar) return reset()

  const timeSec = Number(param.time)
  const idx = candleIndex.get(timeSec)
  const volObj = param.seriesData.get(refs.volume)
  const vol = Number(volObj?.value)
  const ma = idx === undefined ? NaN : volMa[idx]

  if (infoEl.value) {
    infoEl.value.innerHTML = infoHTML(
      timeSec,
      bar,
      vol,
      Number.isFinite(vol) && Number.isFinite(ma) && ma > 0 ? vol / ma : NaN
    )
  }

  const delta = deltaEl.value
  if (!delta) return
  const refPrice = overlay.refPrice
  const cursorPrice = refs.candle.coordinateToPrice(param.point.y)
  if (
    !Number.isFinite(refPrice) ||
    refPrice <= 0 ||
    !Number.isFinite(cursorPrice)
  )
    return delta.classList.add('hidden')

  const vs = ((cursorPrice - refPrice) / refPrice) * 100
  delta.style.width = Math.max(0, refs.chart.priceScale('right').width()) + 'px'
  delta.style.top = param.point.y + 14 + 'px'
  delta.classList.remove('hidden')
  delta.classList.toggle('up', vs >= 0)
  delta.classList.toggle('down', vs < 0)
  delta.textContent = `${vs >= 0 ? '+' : ''}${vs.toFixed(2)}%`
}

/* ---------------- 画图 ---------------- */

/**
 * 画图。
 *
 * `keepView = true` 时（往前补历史）不 fitContent，而是把时间轴整体右移
 * 「新塞进来的根数」，这样用户看的那一段不会跳。
 */
function draw(data: Candle[], sr: LevelSR | null, keepView = false) {
  if (!ensureChart() || !refs) return
  const view = keepView ? refs.chart.timeScale().getVisibleLogicalRange() : null
  candles = data
  overlay.sr = sr

  if (!data.length) {
    refs.candle.setData([])
    refs.volume.setData([])
    refs.ema42.setData([])
    volMa = []
    emaValues = []
    candleIndex = new Map()
    overlay.refPrice = NaN
    renderOverlays()
    drawSelection()
    return
  }

  const t = (c: Candle) => Math.floor(c.timestamp / 1000)

  refs.candle.setData(
    data.map(c => ({
      time: t(c),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }))
  )
  refs.volume.setData(
    data.map(c => ({
      time: t(c),
      value: c.volume,
      color:
        c.close >= c.open ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)'
    }))
  )

  const closes = data.map(c => c.close)
  volMa = sma(
    data.map(c => c.volume),
    20
  )
  emaValues = ema(closes, 42)
  candleIndex = new Map(data.map((c, i) => [t(c), i]))
  refs.ema42.setData(
    emaValues
      .map((v, i) => ({time: t(data[i]), value: v}))
      .filter(p => Number.isFinite(p.value))
  )

  overlay.refPrice = closes[closes.length - 1]
  renderOverlays()
  showInfoAt(candles.length - 1)

  // 先把「用户自己动过」的标志清掉：不然 fitContent 把左边缘带到 0 时
  // 会被当成「用户拖到头了」而多拉一段历史
  userPanned = false

  if (view) {
    // 前面塞了 prependCount 根 → 下标整体后移，钉住原来那段
    refs.chart.timeScale().setVisibleLogicalRange({
      from: view.from + prependCount,
      to: view.to + prependCount
    })
    prependCount = 0
  } else {
    refs.chart.timeScale().fitContent()
  }

  syncWindowRefs()
  drawSelection()
  emit('loaded', data)
}

async function load() {
  const symbol = props.symbol.trim()
  if (!symbol) return
  try {
    reachedStart = false
    userPanned = false
    // 选了开始时间：从那刻画到结束；测试模式没选开始时间：往前铺 DEFAULT_BARS 根
    let range: {from: number; to: number} | undefined
    if (ranged.value) range = {from: fromMs.value, to: endMs()}
    else if (testMode.value)
      range = {from: untilMs.value - tfMs() * DEFAULT_BARS, to: untilMs.value}
    const d = await fetchCandles(symbol, props.timeframe, barsToLoad(), range)
    // 测试模式：接口只保证 ts ≤ to，那根**还没收盘**的得自己剔掉
    const bars =
      testMode.value && lastClosedMs.value > 0
        ? (d.candles ?? []).filter(c => c.timestamp <= lastClosedMs.value)
        : (d.candles ?? [])
    draw(bars, d.sr ?? null)
  } catch (e) {
    emit('error', (e as Error).message)
  }
}

/**
 * 往前补一段更早的历史（拖到左边缘时自动调）。
 *
 * 一次补多少根看周期（`HISTORY_BARS`）；补完把视图钉在原地，不会跳。
 */
async function loadOlder(): Promise<void> {
  if (loadingOlder || reachedStart || !refs || !candles.length) return
  if (candles.length >= MAX_TOTAL_BARS) return
  const symbol = props.symbol.trim()
  if (!symbol) return

  const firstMs = candles[0].timestamp
  const step = tfMs()
  const group = historyBars()

  loadingOlder = true
  try {
    const d = await fetchCandles(symbol, props.timeframe, group, {
      from: firstMs - group * step,
      to: firstMs - 1
    })
    const older = (d.candles ?? []).filter(c => c.timestamp < firstMs)
    if (!older.length) {
      reachedStart = true
      return
    }
    // 这一批连一半都凑不齐，基本就是拉到交易所最早那几根了
    if (older.length < group / 2) reachedStart = true
    prependCount = older.length
    // keepView：别 fitContent，把视图钉在用户正看的那一段
    draw([...older, ...candles], overlay.sr, true)
  } catch {
    /* 网络/交易所抽风就先算了，下次拖动再试 */
  } finally {
    loadingOlder = false
  }
}

/* ---------------- 坐标轴工具 ---------------- */

/** A：自动布局 —— 线性坐标 + 恢复自动缩放 + 适配全部数据 */
function autoLayout() {
  if (!refs) return
  logScale.value = false
  refs.chart.priceScale('right').applyOptions({
    mode: LWC.PriceScaleMode.Normal,
    autoScale: true
  })
  refs.chart.timeScale().fitContent()
}

/** L：切换对数坐标 */
function toggleLog() {
  if (!refs) return
  logScale.value = !logScale.value
  refs.chart.priceScale('right').applyOptions({
    mode: logScale.value
      ? LWC.PriceScaleMode.Logarithmic
      : LWC.PriceScaleMode.Normal
  })
}

function toggleLegend(key: string) {
  VISIBLE.value[key] = !VISIBLE.value[key]
  renderOverlays()
}

/* ---------------- 在图上拖一个范围 ---------------- */

/**
 * 「画范围」：在图上横向拖一段，松手就把这段的起止时间报给外面
 * （「添加案例」拿它去取这一段 K 线 + 提炼经验）。
 *
 * 拖的时候盖一层透明层把鼠标接管过来 —— 这样拖动不会把图表带着平移，
 * 也不会误触发「往前补历史」。松手后自动退出这个模式，图恢复可拖。
 *
 * 按钮不在图这边（挪到左边「添加案例」的时间那一行），这里只管状态：
 * 外面传 `drawing` 进来，拖完 / 按 Esc 就 emit `update:drawing` 退出去。
 */
/** 拖动模式（受控） */
const localDrawing = ref(false)
const rangeMode = computed(() =>
  props.selectable ? (props.drawing ?? localDrawing.value) : false
)

function setDrawing(v: boolean) {
  if (props.drawing === undefined) localDrawing.value = v
  emit('update:drawing', v)
}

const dragFromX = ref<number | null>(null)
const dragToX = ref<number | null>(null)
const dragHint = ref('')
const layerEl = ref<HTMLElement | null>(null)
/** 图表容器（量宽度用：决定结束线标签摆哪边） */
const wrapEl = ref<HTMLElement | null>(null)
/** 已经落定的范围在画面上的位置 */
const selBox = ref<{from: number; to: number} | null>(null)
const selHint = ref('')

/* ---------------- 结束线（测试模式的「看到哪一刻」）---------------- */

/** 选线模式（受控） */
const localPicking = ref(false)
const picking = computed(() =>
  props.pickPoint === undefined ? localPicking.value : props.pickPoint
)

function setPicking(v: boolean) {
  if (props.pickPoint === undefined) localPicking.value = v
  emit('update:pickPoint', v)
}

/** 正在拖的时候线在哪（像素）；null = 没在拖 */
const dragLineX = ref<number | null>(null)
/** 已经落定的线在画面上的位置 */
const selLine = ref<number | null>(null)

/** 线画在哪：拖的时候跟鼠标，不拖的时候按 `pointAt` 算 */
const lineX = computed(() => dragLineX.value ?? selLine.value)

/** 图表容器宽度（决定「看到 X 收盘」那句标签摆线左边还是右边） */
const wrapW = ref(0)
/**
 * 标签摆在线的**左侧**。
 *
 * 结束线一般放在最右边那根附近，标签默认向右排就会冲出右边界被切掉（`.range-layer`
 * 是 `overflow: hidden`），所以只要线过了中线就翻到左边去。
 */
const lineTagLeft = computed(
  () => lineX.value !== null && wrapW.value > 0 && lineX.value > wrapW.value / 2
)

/**
 * 结束线标签文案。
 *
 * 窄图放不下整句 —— 实测图宽 328px 时整句宽 231px，标签向左排会超出左边界被裁掉
 * （`.range-layer` 是 `overflow: hidden`）。窄了就只写关键那半句，
 * 完整时刻左边面板和 `title` 里都有。
 */
function lineTagLabel(barMs: number): string {
  if (wrapW.value > 0 && wrapW.value < 400) return `看到 ${bjShort(barMs)} 收盘`
  return `结束线 · 看到 ${bjTime(barMs)} 这根收盘`
}

/** 线上那句「看到 X 收盘」（拖的时候跟着鼠标实时变） */
const liveLineHint = computed(() => {
  const x = dragLineX.value
  if (x !== null && candles.length) {
    return lineTagLabel(candles[xToIndex(x)].timestamp)
  }
  const at = props.pointAt
  if (at === null || at === undefined) return ''
  return lineTagLabel(at - tfMs())
})

const pointTip = computed(() =>
  picking.value
    ? '在图上点一根 K 线 —— 定下「我看到这一根收盘」，按 Esc 取消'
    : ''
)

function onLineDown(e: PointerEvent) {
  if (!picking.value) return
  e.preventDefault()
  dragLineX.value = localX(e)
  commitLine(dragLineX.value)
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
}

function onLineMove(e: PointerEvent) {
  if (dragLineX.value === null) return
  e.preventDefault()
  dragLineX.value = localX(e)
  commitLine(dragLineX.value)
}

/**
 * 把 x 像素换算成「那一刻」发出去。
 *
 * 值 = 那一根的**收尾时刻**（开盘 + 一个周期），后端拿它当 `at`，
 * `timestamp + step <= at` 正好把这一根算成最后一根已收盘的。
 * 拖动过程中每动一下就发一次，面板上的「判断时点」会跟着跳。
 */
function commitLine(x: number) {
  if (!candles.length) return
  const at = candles[xToIndex(x)].timestamp + tfMs()
  if (at !== props.pointAt) emit('point', at)
}

function onLineUp(e: PointerEvent) {
  const x = dragLineX.value
  if (x === null) return
  e.preventDefault()
  dragLineX.value = null
  setPicking(false)
  commitLine(x)
}

/* 已经放好的线：不用重选，直接拖它就行 */
function onHandleDown(e: PointerEvent) {
  if (picking.value) return
  e.preventDefault()
  e.stopPropagation()
  dragLineX.value = selLine.value ?? localX(e)
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
}

function onHandleMove(e: PointerEvent) {
  if (dragLineX.value === null) return
  e.preventDefault()
  dragLineX.value = localX(e)
  commitLine(dragLineX.value)
}

function onHandleUp(e: PointerEvent) {
  const x = dragLineX.value
  if (x === null) return
  e.preventDefault()
  dragLineX.value = null
  commitLine(x)
}

/** 拖到一半按 Esc 就取消（挂在 window 上，不用先点图） */
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (picking.value) {
    dragLineX.value = null
    setPicking(false)
    return
  }
  if (!rangeMode.value) return
  dragFromX.value = null
  dragToX.value = null
  dragHint.value = ''
  setDrawing(false)
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/* 宽度变了要重算结束线标签摆哪边 */
let wrapRo: ResizeObserver | null = null
onMounted(() => {
  const el = wrapEl.value
  if (!el) return
  wrapW.value = el.clientWidth
  wrapRo = new ResizeObserver(entries => {
    const w = entries[0]?.contentRect.width ?? 0
    if (w > 0 && Math.abs(w - wrapW.value) > 0.5) wrapW.value = w
  })
  wrapRo.observe(el)
})
onBeforeUnmount(() => wrapRo?.disconnect())

/** 图上 x 像素 → K 线下标（超出可见区域就夹到边界） */
function xToIndex(x: number): number {
  if (!refs || !candles.length) return 0
  const ts = refs.chart.timeScale()
  const px = Math.max(0, Math.min(ts.width(), x))
  const logical = ts.coordinateToLogical(px)
  const last = candles.length - 1
  if (logical === null || logical === undefined || !Number.isFinite(logical)) {
    return 0
  }
  return Math.min(last, Math.max(0, Math.round(logical)))
}

/** 时间戳 → 图上 x 像素（这根不在图上就返回 null） */
function msToX(ms: number): number | null {
  if (!refs || !candles.length) return null
  const x = refs.chart.timeScale().timeToCoordinate(Math.floor(ms / 1000))
  return x === null || x === undefined || !Number.isFinite(x) ? null : x
}

function localX(e: PointerEvent): number {
  const el = layerEl.value
  if (!el) return 0
  return e.clientX - el.getBoundingClientRect().left
}

function hintOf(x1: number, x2: number): string {
  if (!candles.length) return ''
  const i = xToIndex(Math.min(x1, x2))
  const j = xToIndex(Math.max(x1, x2))
  return `${bjTime(candles[i].timestamp)} → ${bjTime(
    candles[j].timestamp
  )} · ${j - i + 1} 根`
}

function onRangeDown(e: PointerEvent) {
  if (!rangeMode.value) return
  e.preventDefault()
  dragFromX.value = localX(e)
  dragToX.value = dragFromX.value
  dragHint.value = hintOf(dragFromX.value, dragToX.value)
  // 抓住指针，拖到图外面也不丢（拿不到就算了，不影响拖）
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
}

function onRangeMove(e: PointerEvent) {
  if (dragFromX.value === null) return
  e.preventDefault()
  dragToX.value = localX(e)
  dragHint.value = hintOf(dragFromX.value, dragToX.value)
}

function onRangeUp(e: PointerEvent) {
  const a = dragFromX.value
  if (a === null) return
  e.preventDefault()
  const b = dragToX.value ?? a
  dragFromX.value = null
  dragToX.value = null
  dragHint.value = ''
  setDrawing(false)

  const x1 = Math.min(a, b)
  const x2 = Math.max(a, b)
  // 拖得太短当误触：只框一根没意义
  if (x2 - x1 < 4 || !candles.length) return

  const i = xToIndex(x1)
  const j = xToIndex(x2)
  if (j <= i) return
  emit('select', {
    from: candles[i].timestamp,
    to: candles[j].timestamp,
    bars: j - i + 1
  })
}

/** 同一层透明覆盖：范围模式拖一段，选线模式点一根 */
function onLayerDown(e: PointerEvent) {
  if (picking.value) return onLineDown(e)
  onRangeDown(e)
}

function onLayerMove(e: PointerEvent) {
  if (picking.value) return onLineMove(e)
  onRangeMove(e)
}

function onLayerUp(e: PointerEvent) {
  if (picking.value) return onLineUp(e)
  onRangeUp(e)
}

/** 把已经定下来的范围画到图上（平移 / 缩放后会跟着重画） */
function drawSelection() {
  // 只有「添加案例」和「实时分析 · 测试」才关心范围
  const r = props.selectable ? props.range : null
  const clear = () => {
    if (selBox.value) selBox.value = null
    if (selHint.value) selHint.value = ''
  }
  if (!r || !refs || !candles.length) return clear()

  // 先把端点夹到实际拿到的 K 线区间里。
  // 测试模式下 "只留已收盘的" 会把结尾那根剔掉，端点于是不再等于
  // 任何一根 K 线的时间，而 timeToCoordinate 只认真实存在的 bar，
  // 会直接返回 null —— 高亮就整个没了。夹一下就能正常画出来。
  const first = candles[0].timestamp
  const last = candles[candles.length - 1].timestamp
  const clamp = (ms: number) => Math.min(Math.max(ms, first), last)
  const a = msToX(clamp(r.from))
  const b = msToX(clamp(r.to))
  if (a === null || b === null) return clear()

  const from = Math.min(a, b)
  const to = Math.max(a, b)
  // 完全划到视图外面去了就不显示
  if (to < 0 || from > refs.chart.timeScale().width()) return clear()

  // 位置没变就别动 —— 这个函数会被鼠标移动高频调用
  if (!selBox.value || selBox.value.from !== from || selBox.value.to !== to) {
    selBox.value = {from, to}
  }
  const hint = `${bjTime(r.from)} → ${bjTime(r.to)} · ${r.bars} 根`
  if (selHint.value !== hint) selHint.value = hint
}

/**
 * 把**结束线**画到图上。
 *
 * 线落在「最后一根已收盘 K 线」的**中心**（`timeToCoordinate` 给的就是那根的中心），
 * 也就是「我看到这一根为止」，而不是一个悬在两根之间的刻度。
 */
function drawPoint() {
  const at = props.pointAt
  const clear = () => {
    if (selLine.value !== null) selLine.value = null
  }
  if (at === null || at === undefined || !refs || !candles.length)
    return clear()

  const bar = at - tfMs() // 最后一根已收盘 K 线的开盘时刻
  const x = msToX(bar)
  if (x === null) return clear() // 那根还没在图上（往前补回来才会出现）
  const w = refs.chart.timeScale().width()
  if (x < -20 || x > w + 20) return clear() // 滚出视图了

  if (selLine.value !== x) selLine.value = x
}

/* ---------------- 生命周期 ---------------- */

const title = computed(() => props.symbol)

onMounted(load)
watch(() => props.symbol, load)
watch(() => props.timeframe, load)
watch(() => props.from, load)
// 进 / 出测试模式都要重画：右端从「现在」换成那一刻，或换回来
watch(() => props.until, load)
watch([() => props.range, () => props.timeframe], drawSelection)
// 回补历史 / 数据换了 / 缩放平移，范围与结束线的位置都要跟着重算
watch(() => candles.length, drawSelection)
watch(() => props.pointAt, drawPoint)

onBeforeUnmount(() => {
  try {
    refs?.chart.remove()
  } catch {
    /* 忽略 */
  }
  refs = null
  priceLines = []
  levelLabels = []
})
</script>

<template>
  <section class="panel chart-panel">
    <div class="chart-head">
      <h2>
        {{ title }} <span class="tag">{{ timeframe }}</span>
      </h2>
      <div class="seg">
        <button
          v-for="t in TFS"
          :key="t.value"
          type="button"
          :class="{active: t.value === timeframe}"
          @click="emit('update:timeframe', t.value)"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div class="date-row">
      <span class="dim">从</span>
      <button
        type="button"
        class="time-pick"
        :class="{set: fromMs > 0}"
        title="点一下选时间（年月日时分）"
        @click="openPicker"
      >
        {{ fromMs ? bjTime(fromMs) : '选一个时间' }}
      </button>
      <span
        v-if="testMode"
        class="until-tag"
        :title="`只画已收盘的 K 线；设的测试点是 ${bjTime(untilMs)}`"
      >
        K 线到 {{ bjTime(lastClosedMs) }}
      </span>
      <button
        v-if="from"
        type="button"
        class="ghost tiny"
        title="清掉时间，看最新的 K 线"
        @click="clearRange"
      >
        回到最新
      </button>
    </div>

    <div ref="wrapEl" class="chart-wrap">
      <div ref="chartEl" class="chart"></div>
      <div ref="levelHost" class="level-labels"></div>
      <div ref="infoEl" class="chart-info"></div>
      <div ref="deltaEl" class="cursor-delta hidden"></div>

      <!-- 画范围 / 放结束线用的透明层：拖的时候接管鼠标，平时不吃事件 -->
      <div
        v-if="rangeMode || picking || selBox || lineX !== null"
        ref="layerEl"
        class="range-layer"
        :class="{drawing: rangeMode || picking}"
        @pointerdown="onLayerDown"
        @pointermove="onLayerMove"
        @pointerup="onLayerUp"
        @pointercancel="onLayerUp"
      >
        <div
          v-if="selBox"
          class="range-box"
          :style="{
            left: selBox.from + 'px',
            width: selBox.to - selBox.from + 'px'
          }"
        />
        <div
          v-if="dragFromX !== null && dragToX !== null"
          class="range-box live"
          :style="{
            left: Math.min(dragFromX, dragToX) + 'px',
            width: Math.abs(dragToX - dragFromX) + 'px'
          }"
        />
        <!-- 结束线：一条竖线，落在「我看到这一根收盘」上；已放好的可以直接拖 -->
        <div
          v-if="lineX !== null"
          class="range-line"
          :class="{
            live: dragLineX !== null || picking,
            'tag-left': lineTagLeft
          }"
          :style="{left: lineX + 'px'}"
          @pointerdown="onHandleDown"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleUp"
        >
          <!-- 竖线本身只有 2px，单独给一条宽一点的命中区，好抓 -->
          <span class="range-line-hit" title="按住左右拖动，改「看到哪一刻」" />
          <span class="range-line-tag">{{ liveLineHint }}</span>
        </div>
        <span v-if="dragHint" class="range-hint">{{ dragHint }}</span>
        <span v-else-if="selHint" class="range-hint">{{ selHint }}</span>
      </div>

      <!-- 等着拖 / 等着点的时候给个提示，别让人不知道接下来干嘛 -->
      <div v-if="rangeMode || picking" class="range-tip">
        {{
          picking ? pointTip : '在图上横向拖一段 —— 松手就选好了，按 Esc 取消'
        }}
      </div>
    </div>

    <div class="chart-tools">
      <button
        type="button"
        title="自动布局（线性坐标 + 适配全部）"
        @click="autoLayout"
      >
        A
      </button>
      <button
        type="button"
        :class="{active: logScale}"
        title="切换对数坐标"
        @click="toggleLog"
      >
        L
      </button>
    </div>

    <div class="legend">
      <span><i class="dot up" />阳线</span>
      <span><i class="dot down" />阴线</span>
      <span
        v-for="l in LEGEND"
        :key="l.key"
        :data-toggle="l.key"
        :class="{off: !VISIBLE[l.key]}"
        :title="`点击显示 / 隐藏`"
        @click="toggleLegend(l.key)"
      >
        <i class="dot" :class="l.dot" />{{ l.label }}
      </span>
      <span class="dim">点一下切换显隐</span>
    </div>

    <!-- 选时间：弹窗里选年月日时分，选完就从那一刻开始画 -->
    <TimeModal
      v-model="pickerOpen"
      kind="point"
      title="选一个时间"
      hint="从这一刻开始画 K 线，一直画到最新。"
      :initial="pickerInitial"
      @confirm="onPickTime"
    />
  </section>
</template>
