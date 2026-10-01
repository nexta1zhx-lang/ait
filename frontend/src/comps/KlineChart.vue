<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import * as LWC from 'lightweight-charts'
import {fetchCandles, type Candle, type LevelSR} from '../api'
import {bjShort, fmt} from '../format'

/**
 * K 线图（TradingView Lightweight Charts）。
 *
 * 图例里的每一条线都可以点击控制显隐，默认**全部隐藏**。
 * 右侧会贴着价格轴显示每条线的价位相对当前价的百分比。
 */

export interface ChartPlan {
  entry?: {type: string; price: number | null}
  stopLoss?: number | null
  takeProfits?: {label: string; price: number}[]
}

const props = defineProps<{
  symbol: string
  timeframe: string
  /** 上一次分析给出的关键价位 */
  plan?: ChartPlan | null
}>()

const emit = defineEmits<{
  (e: 'update:timeframe', v: string): void
  (e: 'error', msg: string): void
  (e: 'loaded', candles: Candle[]): void
}>()

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
  sup: false,
  entry: false,
  sl: false,
  tp: false
})

const LEGEND = [
  {key: 'volume', label: '成交量', dot: 'vol'},
  {key: 'ema42', label: 'EMA42', dot: 'ema'},
  {key: 'res', label: '压力(4H)', dot: 'res'},
  {key: 'sup', label: '支撑(4H)', dot: 'sup'},
  {key: 'entry', label: '入场', dot: 'entry'},
  {key: 'sl', label: '止损', dot: 'sl'},
  {key: 'tp', label: '止盈', dot: 'tp'}
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

  // 视图变化时同步更新右侧百分比标签
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => positionLabels())
  chart.subscribeCrosshairMove((param: any) => {
    updateHover(param)
    positionLabels()
  })

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

  const plan = props.plan
  push(plan?.stopLoss, '#ef5350', '止损', v.sl)
  push(plan?.entry?.price, '#42a5f5', '入场', v.entry)
  for (const tp of plan?.takeProfits ?? []) {
    push(tp.price, '#26a69a', tp.label || 'TP', v.tp)
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
}

/* ---------------- 左上角信息栏 ---------------- */

function infoHTML(
  timeSec: number,
  bar: {open: number; high: number; low: number; close: number},
  vol: number,
  volRatio: number,
  ema42Value: number
): string {
  const p = bjPartsOf(timeSec)
  const chg = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : NaN
  const cls = Number.isFinite(chg) ? (chg >= 0 ? 'up' : 'down') : ''
  const chgText = Number.isFinite(chg)
    ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`
    : '—'
  const aboveEma =
    Number.isFinite(ema42Value) && ema42Value > 0
      ? bar.close >= ema42Value
      : null
  return [
    `<span>${p.month}/${p.day} ${p.hour}:${p.minute}</span>`,
    `<span><span class="k">开</span>${fmt(bar.open)}</span>`,
    `<span><span class="k">高</span>${fmt(bar.high)}</span>`,
    `<span><span class="k">低</span>${fmt(bar.low)}</span>`,
    `<span><span class="k">收</span>${fmt(bar.close)}</span>`,
    `<span class="${cls}">${chgText}</span>`,
    `<span><span class="k">量</span>${fmt(vol, 0)}${
      Number.isFinite(volRatio) ? ` <em>${volRatio.toFixed(2)}x</em>` : ''
    }</span>`,
    `<span class="${aboveEma === null ? '' : aboveEma ? 'up' : 'down'}"
      ><span class="k">EMA42</span>${fmt(ema42Value)}</span
    >`
  ].join('')
}

/** 未悬停时展示最后一根 K 线 */
function showLatestInfo() {
  if (!infoEl.value || !candles.length) return
  const i = candles.length - 1
  const c = candles[i]
  const ma = volMa[i]
  infoEl.value.innerHTML = infoHTML(
    Math.floor(c.timestamp / 1000),
    {open: c.open, high: c.high, low: c.low, close: c.close},
    c.volume,
    Number.isFinite(ma) && ma > 0 ? c.volume / ma : NaN,
    emaValues[emaValues.length - 1]
  )
}

/** 悬停 / 触碰：更新左上角信息栏与右侧「相对当前价」 */
function updateHover(param: any) {
  const reset = () => {
    deltaEl.value?.classList.add('hidden')
    showLatestInfo()
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
      Number.isFinite(vol) && Number.isFinite(ma) && ma > 0 ? vol / ma : NaN,
      idx === undefined ? NaN : emaValues[idx]
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

function draw(data: Candle[], sr: LevelSR | null) {
  if (!ensureChart() || !refs) return
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
  showLatestInfo()
  refs.chart.timeScale().fitContent()
  emit('loaded', data)
}

async function load() {
  const symbol = props.symbol.trim()
  if (!symbol) return
  try {
    const d = await fetchCandles(symbol, props.timeframe)
    draw(d.candles ?? [], d.sr ?? null)
  } catch (e) {
    emit('error', (e as Error).message)
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

/* ---------------- 生命周期 ---------------- */

const title = computed(() => props.symbol)

onMounted(load)
watch(() => props.symbol, load)
watch(() => props.timeframe, load)
watch(() => props.plan, renderOverlays, {deep: true})

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

    <div class="chart-wrap">
      <div ref="chartEl" class="chart"></div>
      <div ref="levelHost" class="level-labels"></div>
      <div ref="infoEl" class="chart-info"></div>
      <div ref="deltaEl" class="cursor-delta hidden"></div>
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
  </section>
</template>
