<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import * as LWC from 'lightweight-charts'
import {fetchCandles, klineStream, type Candle, type LevelSR} from '../api'
import {CHART_BARS} from '../analyze'
import {
  MIN_SAVED_BARS,
  chartBars,
  keepChartZoom,
  rememberShown,
  saveChartBars
} from '../settings'
import {setLivePrice} from '../ticker'
import TimeModal from './TimeModal.vue'
import {
  bjInputToMs,
  bjInputValue,
  bjShort,
  bjTime,
  decimalsFor,
  fmt
} from '../format'

/**
 * K 线图（TradingView Lightweight Charts）。
 *
 * 图例里的每一条线都可以点击控制显隐，默认**全部隐藏**。
 * 右侧会贴着价格轴显示每条线的价位相对当前价的百分比。
 */

const props = defineProps<{
  symbol: string
  timeframe: string
  /**
   * 看哪一刻：'YYYY-MM-DDTHH:mm'（北京时间）。空 = 看最新的。
   *
   * 选中的这一刻会摆在图的**正中间**，左右各 `CENTER_BARS` 根。
   * 只决定「看哪一段」，**不影响 AI 判断用的数据**。
   */
  from?: string
  /**
   * 画到哪一刻为止（同上格式）。空 = 一直画到最新。
   *
   * ⚠️ **现在没有调用方**（2026-10-03 用户拍板）：测试的截断**只作用在喂给 AI 的
   * 数据上**（后端按 `at` 取数，只吃那一刻之前已收盘的 K 线），**图上照旧画全** ——
   * 人看得到之后怎么走，才好评判 AI 当时判断得对不对。
   * 这段留着是为了以后真要做「回放视图」（逐步揭示）时能直接用。
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
  /** 已经画好的范围（毫秒）—— 画面上会一直高亮着。
   *  ⚠️ 要带 `bars`：画范围的提示文案要用它，跟 `select` 事件给的一致 */
  range?: {from: number; to: number; bars: number} | null
  /** 是不是正在「等着我拖一段」。按钮在左边面板，这里只管状态 */
  drawing?: boolean
  /**
   * 这张图现在是不是正被看着（窄屏切到别的 tab 就 false）。
   *
   * 图是**常驻**的（切 tab 不销毁），所以不能拿卸载当「关掉 K 线图」——
   * 靠这个属性：变成 false 时把当前那段范围存进对应币种（用户说的「关闭/切换时保存」）。
   */
  active?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:timeframe', v: string): void
  (e: 'update:from', v: string): void
  (e: 'error', msg: string): void
  (e: 'loaded', candles: Candle[]): void
  /** 图上的大周期压力 / 支撑（外层拿去做「价格位置」图用） */
  (e: 'levels', sr: LevelSR | null): void
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

/**
 * 「看某一刻」时，那一刻摆在图的**正中间**，左右各显示多少根。
 *
 * 就是图上那 `CHART_BARS` 根一分为二 —— 用户要求「左右各 100 根」。
 */
const CENTER_BARS = Math.floor(CHART_BARS / 2)

/** 左右各多拉一点做缓冲：不然最边上那几根常常是空的 */
const CENTER_MARGIN = 8

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

/**
 * 选了「看哪一刻」→ 以它为中心画（测试模式另有结束线，不走这套）。
 *
 * ⚠️ 以前这里是「从这一刻一直画到最新」：选个三天前的时间，
 * 整段会被 fitContent 压成一片，什么结构都看不出来（逻辑错误）。
 */
const centered = computed(() => fromMs.value > 0 && !testMode.value)

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

/**
 * 要拉多少根。
 *
 * 以某一刻为中心 = 左右各 `CENTER_BARS` 根（+ 缓冲）；
 * 其余情况就是最近的 `DEFAULT_BARS` 根 —— 不再是「从那一刻一直拉到现在」。
 */
function barsToLoad(): number {
  if (centered.value) return (CENTER_BARS + CENTER_MARGIN) * 2 + 1
  // 至少够铺满默认那一屏（再多给一点，缩放时不用立刻又去拉）
  return Math.max(DEFAULT_BARS, CHART_BARS + 50)
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

/*
 * 实时推送（用户 2026-10-03：k 线实时更新改为 ws）。
 * `hovering` 是十字光标是否停在图上 —— 停着的时候不许抢用户看的那根。
 */
let stopStream: (() => void) | null = null
let hovering = false
/**
 * 正在**整段重画**（切币 / 换周期 / 换时间）：
 * 这期间推送来的 K 线先别往图上盖 —— 图里还是上一个币的数据，
 * 盖上去就是「新币的一根插在旧币尾巴上」，看着就是一闪。
 */
let reloading = false
/** 每次整段重画的序号：半路又切一次时，旧的那次结果直接作废 */
let loadSeq = 0
/** 换币 / 换周期时图上淡一下（硬切会「闪」） */
const fading = ref(false)
/** 淡出至少留这么久，免得请求太快时看着像原地一颠 */
const FADE_MIN_MS = 140
/**
 * 图上此刻的可见区间（跟 `settings` 里存的那份不同：这份是「正在看」，那份是「记住的」）。
 * 换币 / 切走 / 关页时拿它去存（用户：在关闭 K 线图或者切换 K 线图保存）。
 */
let liveRange: {from: number; to: number} | null = null
/**
 * 「铺视图」的版本号：`showLastN()` 要隔一帧才真正设区间，
 * 这一帧里可能又换币 / 换周期了 —— 旧的那次靠它自己作废（见 `showLastN`）。
 */
let applySeq = 0

/**
 * 用户**自己**缩出来的根数（要存进配置的就是它）。
 *
 * ⚠️ 不能直接拿「当前可见多少根」去存：程序重铺（换币、图从藏着变露出来）
 * 中间会短暂报出一个**被卡住的**数字（实测要 200 根先报 129），
 * 存下去就把全局那个数污染了 —— 以后每个币都只显示 129 根。
 * 所以只认「手动手势之后」报上来的值：`userZoomed` 由 pointerdown / wheel 置位，
 * 每次 `load()`（程序重画）开头清掉。
 */
let userBars = 0
let userZoomed = false
/** 上一次的图宽度：用来判断「刚从藏着变成露出来」（0 → 非 0） */
let lastWidth = 0
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
      /*
       * 轴上的字（价格刻度 / 时间刻度 / 十字光标标签）一起跟着这个走。
       * ⚠️ LWC 只能全局设一个字号，**不能只把价格轴调小**。
       * 11 → 10（2026-10-03「字体放小」）→ 9（用户又说「坐标 y 轴间距再小」）：
       * 字小了，LWC 会把刻度排得更密（刻度间距跟着小），轴也跟着变窄。
       */
      fontSize: 9,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      /*
       * 去掉图左下角那个 TradingView 水印 / 链接（用户 2026-10-03 要求）。
       * 这是 LWC 自带的 `layout.attributionLogo`（默认 true）。
       * 注意：LWC 的 README 里把那个链接写成「license 要求」，关掉之前建议先确认一下授权
       * —— 这是产品 / 法务上的选择，不是技术问题。
       */
      attributionLogo: false
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
      /*
       * 最新一根右边留几根空档。
       * 2026-10-03 先按「右侧间距取消」改成了 0，随后用户又要回
       * 「右侧需要留出 8 根 K 线」→ 8（跟下面那个 `RIGHT_GAP` 是同一个值，
       * 两处必须一致，否则程序设的区间跟默认视图不一样宽）。
       */
      rightOffset: RIGHT_GAP,
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
    // 跟 `style.css` 的 `--ok` / `--bad`、`MiniKline.vue` 的 `UP` / `DOWN` 必须一致
    upColor: '#5eba89',
    downColor: '#e35561',
    borderUpColor: '#5eba89',
    borderDownColor: '#e35561',
    wickUpColor: '#5eba89',
    wickDownColor: '#e35561'
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
    /*
     * 记下「当前这个币正在看的那一段」——
     * 真正落盘不在这里（拖一下一下写 localStorage 太磨人），
     * 而是在换币 / 切走 / 关页时由 `saveNow()` 存进对应币种。
     */
    if (range) liveRange = {from: range.from, to: range.to}
    const w = chart.timeScale().width()
    if (w > 0) {
      reportShown()
      /*
       * 刚刚从「藏着」变成「露出来」（窄屏切回这一格）：重铺一次。
       * ⚠️ 0 宽度下 `setVisibleLogicalRange` 算出来的段是歪的（实测铺 200 根，
       * 显出来只剩 141），所以一变可见就得按该有的样子重铺。
       * 重铺又会回调一次本函数，但那时 `lastWidth` 已经不为 0，不会递归。
       */
      if (lastWidth === 0) applyView()
      lastWidth = w
    } else {
      lastWidth = 0
    }
    // 用户拖/滚到最左边了 → 把更早的历史补进来（Binance 那种往前翻）
    if (userPanned && range && range.from <= 3) void loadOlder()
  })
  chart.subscribeCrosshairMove((param: any) => {
    updateHover(param)
    positionLabels()
  })

  // 只有用户自己动过（拖动 / 滚轮 / 双指）才算「想看更早的」+ 算「他缩到了多少根」
  const markPanned = () => {
    userPanned = true
    userZoomed = true
  }
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
  bar: {open: number; high: number; low: number; close: number},
  vol: number,
  volRatio: number
): string {
  const chg = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : NaN
  const cls = Number.isFinite(chg) ? (chg >= 0 ? 'up' : 'down') : ''
  const chgText = Number.isFinite(chg)
    ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`
    : '—'
  return [
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
    hovering = false
    deltaEl.value?.classList.add('hidden')
    showInfoAt(rightmostVisibleIndex())
  }

  if (!refs || !param?.point || param.time === undefined) return reset()

  const bar = param.seriesData?.get(refs.candle)
  if (!bar) return reset()
  hovering = true

  const timeSec = Number(param.time)
  const idx = candleIndex.get(timeSec)
  const volObj = param.seriesData.get(refs.volume)
  const vol = Number(volObj?.value)
  const ma = idx === undefined ? NaN : volMa[idx]

  if (infoEl.value) {
    infoEl.value.innerHTML = infoHTML(
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

/** 选中那一刻落在数据里的下标（比数据还早 / 还晚就贴到边上） */
function centerIndexOf(data: Candle[]): number {
  if (!data.length) return 0
  const i = Math.floor((fromMs.value - data[0].timestamp) / tfMs())
  return Math.min(data.length - 1, Math.max(0, i))
}

/* ---------------- 视图：显示哪一段 ---------------- */

/**
 * 右侧留几根空位。
 *
 * 原本 4 → 用户 2026-10-03「右侧间距取消」→ 0 → 随后又要求
 * 「k 线右侧需要留出 8 根 k 线」→ **8**（最后一根不贴着价格轴，看盘习惯问题）。
 *
 * ⚠️ 这个值跟 `createChart` 里的 `timeScale.rightOffset` **要一致**
 * （现在两处都引用本变量），不然程序设的区间跟默认视图不一样宽。
 * ⚠️ 它同时是「可见区间」的一部分：`to = len - 1 + RIGHT_GAP`，
 * 所以 `reportShown()` 报给配置面板的根数要**减掉**它（那几根是空档、不是 K 线）。
 */
const RIGHT_GAP = 8
/** 最少显示几根 —— 切币时数据短了也不会把图压成一条缝 */
const MIN_SPAN = 10

/** 时间轴上我们用到的那几个方法（不想为它把 LWC 的类型也引进来） */
interface TimeScaleLike {
  width(): number
  applyOptions(o: {barSpacing: number}): void
  setVisibleLogicalRange(r: {from: number; to: number}): void
}

/**
 * 右边缘贴齐最新一根，往左铺 `n` 根（配置里的「显示多少根 K 线」）。
 *
 * ⚠️⚠️ **必须先定「每根多宽」，而且中间得隔一帧**（跟下面「看某一刻」同一个坑）：
 * LWC 的 `setVisibleLogicalRange` **只滚动、不缩放** —— 它拿**当前**的 barSpacing
 * 去卡，要的跨度比一屏放得下的宽时就把左边缘吃掉（实测想要 200 根只给 **129 根**，
 * 于是「显示多少根」从来没有真正生效过）；两次调用挤在同一帧里也不行，
 * 那会儿 barSpacing 还是旧的。
 *
 * ⚠️ 所以不能只看右边缘对不对 —— 右边一直是对的（一直在滚），左边才是真相。
 */
function showLastN(ts: TimeScaleLike, len: number, n: number): void {
  if (len < 2) return
  /*
   * `span` **就是**「要显示多少根」：区间 `[len-span, len-1+RIGHT_GAP]` 里正好 span 根 K 线。
   * ⚠️ 别写成 `len-1-span` —— 那样是 span+1 根，报上去的数字老比设定值大 1
   * （实测设 47 显示 48，看着像「没记住」）。
   */
  const span = Math.max(MIN_SPAN, Math.min(n, len))
  const w = ts.width()
  const my = ++applySeq
  const put = () => {
    if (my !== applySeq) return // 中间又铺过一次（换币 / 换周期），这次作废
    try {
      ts.setVisibleLogicalRange({from: len - span, to: len - 1 + RIGHT_GAP})
    } catch {
      /* 图已经拆了（切页 / 换币），这一帧就算了 */
    }
  }
  if (w > 0) {
    // 一屏要放下 span 根 + 右边那 RIGHT_GAP 格空档
    ts.applyOptions({barSpacing: w / (span + RIGHT_GAP)})
    requestAnimationFrame(put)
  } else {
    // 图还没露出来（宽度 0），算不出每根多宽 —— 先只定区间，
    // 等变可见时订阅里那次 `applyView()` 会再走一遍
    put()
  }
}

/**
 * 按当前配置把视图铺一次（居中那种情况不走这里，它是用户明确点的）。
 *
 * 「保持 K 线缩放样式」打开 → 铺**全局那个根数**（所有币种共用）；
 * 没缩过 / 关掉 → 铺默认那一屏。
 *
 * ⚠️ 以前这里是「这个币记过就还原它自己那段」，一个币一个样；
 * 用户 2026-10-03：「保持 k 线缩放的根数是所有币种都要」→ 改成只认 `chartBars`。
 * 顺带好处：不存在「某个币套用了别的币的区间」这类错位了。
 */
function applyView(): void {
  if (!refs || !candles.length) return
  const saved = keepChartZoom.value && chartBars.value >= MIN_SAVED_BARS
  showLastN(
    refs.chart.timeScale(),
    candles.length,
    saved ? chartBars.value : DEFAULT_BARS
  )
}

/** 当前用户自己缩出来的根数（拿它去存；程序重排不会动它） */
function liveBars(): number {
  return userBars
}

/**
 * 告诉配置面板「现在看多少根 / 是哪个币」。
 *
 * ⚠️ 不能只在可见区间变化时上报：区间**没变**的话 LWC 不回调
 * （比如切到另一个币、铺出来恰好是同一段），面板就会一直显示上一个币的数字。
 */
function reportShown(): void {
  if (!refs) return
  const ts = refs.chart.timeScale()
  const w = ts.width()
  if (w <= 0) return // 图没露出来（窄屏切到别的 tab），这时报的区间没意义
  const r = ts.getVisibleLogicalRange()
  if (!r) return
  liveRange = {from: r.from, to: r.to}
  // 报给配置面板的「显示多少根」要扣掉右侧空档 —— 那 8 格没 K 线
  const n = r.to - r.from + 1 - RIGHT_GAP
  rememberShown(n, `${props.symbol} · ${props.timeframe}`)
  // 只有用户自己缩/拖过，这个数才作数（见 `userBars` 那段注释）
  if (userZoomed) userBars = n
}

/**
 * 画图。
 *
 * `keepView = true` 时（往前补历史）不重设视图，而是把时间轴整体右移
 * 「新塞进来的根数」，这样用户看的那一段不会跳。
 */
function draw(data: Candle[], sr: LevelSR | null, keepView = false) {
  if (!ensureChart() || !refs) return
  const view = keepView ? refs.chart.timeScale().getVisibleLogicalRange() : null
  candles = data
  overlay.sr = sr
  // 报给外层：结论区那把「上沿 / 现价 / 下沿」的尺子要用它
  emit('levels', sr)

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

  /*
   * 价格轴刻度按**这个币的价格量级**定精度。
   *
   * ⚠️ 不设的话 LWC 用默认的 precision: 2 / minMove: 0.01 —— 对低价币就是灾难：
   * 1000PEPE（≈ 0.0043）整段行情都落在同一个 0.01 格子里，刻度会重复 / 错位
   * （用户反馈「价格坐标轴划分不对」）。
   * `localization.priceFormatter` 只改**文字**，改不了**划分**，必须设系列自己的 priceFormat。
   * 精度沿用全站同一套规则 `decimalsFor()`，这样轴刻度 / 十字光标 / 右侧 ±% 标签一致。
   */
  const axisDecimals = decimalsFor(data[data.length - 1]?.close)
  const priceFormat = {
    type: 'price' as const,
    precision: axisDecimals,
    minMove: 1 / 10 ** axisDecimals
  }
  refs.candle.applyOptions({priceFormat})
  // EMA42 跟蜡烛共用右侧价格轴，格式得一致（否则轴上的精度会跟着最后一个系列跑）
  refs.ema42.applyOptions({priceFormat})

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
        c.close >= c.open ? 'rgba(94,186,137,0.45)' : 'rgba(227,85,97,0.45)'
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
  } else if (centered.value) {
    /*
     * 选中的那一刻摆在正中间：左右各 CENTER_BARS 根。
     *
     * ⚠️ 要分两步、而且**中间得隔一帧**：
     *   ① 先把「每根多宽」定成 时间轴宽度 ÷ 要放下的根数；
     *   ② 再设可见区间。
     * 两次调用挤在同一帧里的话，LWC 会拿**上一个** barSpacing 去卡，
     * 结果右边缘是对的、左边缘被吃掉三十多根（实测 7 → 38）。
     *
     * 右边要是已经没有行情了（选的是很近的一刻），那头就留白 ——
     * 留白的意思是「还没发生」，比把刻度硬挤到右边缘诚实。
     */
    const ts = refs.chart.timeScale()
    const i = centerIndexOf(data)
    const w = ts.width()
    if (w > 0) ts.applyOptions({barSpacing: w / (CENTER_BARS * 2 + 1)})
    const put = () => {
      try {
        ts.setVisibleLogicalRange({
          from: i - CENTER_BARS,
          to: i + CENTER_BARS
        })
      } catch {
        /* 图已经拆了（切页/换币），这一帧就算了 */
      }
    }
    requestAnimationFrame(put)
  } else {
    /* 铺全局那个根数（没缩过就是默认那一屏） */
    applyView()
  }

  syncWindowRefs()
  drawSelection()
  // 顺手把「现在看多少根」报给配置面板（区间没变也要报，否则切币后数字会停在旧的那个币）
  reportShown()
  emit('loaded', data)
}

async function load() {
  const symbol = props.symbol.trim()
  if (!symbol) return
  const seq = ++loadSeq
  /*
   * 换币 / 换周期 / 换时间都要整段重画，这里做一次「淡出 → 换数据 → 淡入」。
   * 不淡的话，旧币还是一整套价格区间，新数据一上来（价格轴精度、可见区间、
   * 蜡烛全变）就是硬闪一下 —— 用户说的「切换币种 k 线会有闪动」。
   */
  const startedAt = performance.now()
  reloading = true
  fading.value = true
  // 接下来是程序重铺（不是用户缩的）—— 从现在起到这次画完，报上来的根数都不作数
  userZoomed = false
  try {
    reachedStart = false
    userPanned = false
    // 以选中那一刻为中心：左右各 CENTER_BARS 根（再多拉点缓冲）
    let range: {from: number; to: number} | undefined
    if (centered.value) {
      const half = (CENTER_BARS + CENTER_MARGIN) * tfMs()
      range = {from: fromMs.value - half, to: fromMs.value + half}
    } else if (testMode.value) {
      range = {from: untilMs.value - tfMs() * DEFAULT_BARS, to: untilMs.value}
    }
    const d = await fetchCandles(symbol, props.timeframe, barsToLoad(), range)
    // 半路又切了一次（连点几个币）→ 这次的结果作废，让最后那次画
    if (seq !== loadSeq) return
    // 测试模式：接口只保证 ts ≤ to，那根**还没收盘**的得自己剔掉
    const bars =
      testMode.value && lastClosedMs.value > 0
        ? (d.candles ?? []).filter(c => c.timestamp <= lastClosedMs.value)
        : (d.candles ?? [])
    draw(bars, d.sr ?? null)
  } catch (e) {
    if (seq === loadSeq) emit('error', (e as Error).message)
  } finally {
    if (seq === loadSeq) {
      reloading = false
      // 先把新数据画进 canvas，再等淡出够时长（太快的请求也能看出「换过了」）
      const wait = Math.max(0, FADE_MIN_MS - (performance.now() - startedAt))
      setTimeout(() => {
        if (seq === loadSeq) fading.value = false
      }, wait)
    }
  }
}

/**
 * 往前补一段更早的历史（拖到左边缘时自动调）。
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

/**
 * 实时推送来的那一根，并进数据 —— 让 K 线「动」起来。
 *
 * 时间戳跟最后一根相同 → **就地替换**（同一根还在长）；更大 → append。
 *
 * ⚠️ 只动尾部那三条序列 + 右侧参考价，**绝不碰视图**（不 fitContent、不重设可见区间）——
 * 用户正看哪一段、拖到哪儿都不会被拽走。
 */
function applyTail(tail: Candle[]): void {
  if (!refs || !tail.length || !candles.length) return
  // 整段重画中：图里还是旧币的数据，这一根先不收（load 完会拿到最新的）
  if (reloading) return
  let changed = false
  for (const c of tail) {
    const last = candles[candles.length - 1]
    if (!last) break
    if (c.timestamp === last.timestamp) {
      if (c.close !== last.close || c.high !== last.high) changed = true
      candles[candles.length - 1] = c
    } else if (c.timestamp > last.timestamp) {
      candles.push(c)
      changed = true
    }
  }
  if (!changed) return

  // 尾部重算：EMA / 量均线都要跟着最后一根走
  emaValues = ema(
    candles.map(x => x.close),
    42
  )
  volMa = sma(
    candles.map(x => x.volume),
    20
  )

  const i = candles.length - 1
  const c = candles[i]
  const t = Math.floor(c.timestamp / 1000)
  candleIndex.set(t, i)
  refs.candle.update({
    time: t,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  })
  refs.volume.update({
    time: t,
    value: c.volume,
    color: c.close >= c.open ? 'rgba(94,186,137,0.45)' : 'rgba(227,85,97,0.45)'
  })
  if (Number.isFinite(emaValues[i])) {
    refs.ema42.update({time: t, value: emaValues[i]})
  }

  // 信息栏 / 右侧参考价：只在用户没在看别的那一根时才跟着走
  if (!hovering) {
    overlay.refPrice = c.close
    renderLabels()
    showInfoAt(i)
  }
  // 头部那条行情的「现价」也吃这一口（比 15 秒轮询快得多，价格才能闪得起来）
  setLivePrice(props.symbol, c.close)
  // 画上的选中框、结束线位置跟着数据长度走
  drawSelection()
}

/** 订上实时推送（测试/回看是历史视图，不订） */
function startStream(): void {
  stopStream?.()
  stopStream = null
  const symbol = props.symbol.trim()
  if (!symbol || testMode.value) return
  stopStream = klineStream(symbol, props.timeframe, c => applyTail([c]))
}

/** 切到后台就断掉（别让手机在后台白收推送），回来立刻重订 */
function onLiveVisible(): void {
  if (document.hidden) {
    stopStream?.()
    stopStream = null
    return
  }
  startStream()
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

/**
 * 已经画好的范围**还能改**：
 *   · 抓左 / 右那道粗线 → 只动这一端（另一头钉住）
 *   · 按住中间那段 → 整段平移
 * 改完照旧 walk `select` 事件出去，跟刚拖出来时一模一样。
 */
const grabEdge = ref<'left' | 'right' | 'mid' | null>(null)
/** 抓的起点（像素）和当时的两端下标 + 指针落在第几根 */
let grabX = 0
let grabAt = {i: 0, j: 0, at: 0}

/** 当前范围的两端在数据里的下标（端点不在数据里就按时间找回来） */
function rangeIndexes(): {i: number; j: number} | null {
  const r = props.range
  if (!r || !candles.length) return null
  const find = (ms: number): number | null => {
    const byMap = candleIndex.get(Math.floor(ms / 1000))
    if (byMap !== undefined) return byMap
    const x = msToX(ms)
    return x === null ? null : xToIndex(x)
  }
  const i = find(r.from)
  const j = find(r.to)
  if (i === null || j === null) return null
  return i <= j ? {i, j} : {i: j, j: i}
}

/** 把下标区间发出去（与图上拖出来时同一个事件） */
function emitIdxRange(i: number, j: number): void {
  const last = candles.length - 1
  const a = Math.max(0, Math.min(i, j))
  const b = Math.min(last, Math.max(i, j))
  if (b <= a) return
  emit('select', {
    from: candles[a].timestamp,
    to: candles[b].timestamp,
    bars: b - a + 1
  })
}

function onGrabDown(e: PointerEvent, edge: 'left' | 'right' | 'mid'): void {
  const idx = rangeIndexes()
  if (!idx) return
  // 别让这一下传给下面那层（否则会变成「重新拖一段」）
  e.preventDefault()
  e.stopPropagation()
  grabEdge.value = edge
  grabX = localX(e)
  grabAt = {i: idx.i, j: idx.j, at: xToIndex(grabX)}
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 忽略 */
  }
}

function onGrabMove(e: PointerEvent): void {
  const edge = grabEdge.value
  if (!edge) return
  e.preventDefault()
  const x = localX(e)
  if (edge === 'left') {
    // 不能越过右端（至少留一根）
    emitIdxRange(Math.min(xToIndex(x), grabAt.j - 1), grabAt.j)
    return
  }
  if (edge === 'right') {
    emitIdxRange(grabAt.i, Math.max(xToIndex(x), grabAt.i + 1))
    return
  }
  // 整段平移：按「根」挪，首尾一起动
  const shift = xToIndex(x) - grabAt.at
  emitIdxRange(grabAt.i + shift, grabAt.j + shift)
}

function onGrabUp(e: PointerEvent): void {
  if (!grabEdge.value) return
  e.preventDefault()
  grabEdge.value = null
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

onMounted(load)
// 实时推送：币种 / 周期 / 测试模式一变就重订（上游 WS → 后端 SSE → 这里）
onMounted(() => {
  startStream()
  document.addEventListener('visibilitychange', onLiveVisible)
})
watch([() => props.symbol, () => props.timeframe, testMode], startStream)
watch(() => props.symbol, load)
watch(() => props.timeframe, load)
watch(() => props.from, load)
// 进 / 出测试模式都要重画：右端从「现在」换成那一刻，或换回来
watch(() => props.until, load)
watch([() => props.range, () => props.timeframe], drawSelection)
// 回补历史 / 数据换了 / 缩放平移，范围与结束线的位置都要跟着重算
watch(() => candles.length, drawSelection)
watch(() => props.pointAt, drawPoint)

/*
 * 换币 / 换周期 / 切走这一格：都把「现在显示多少根」存一下。
 *
 * ⚠️ 存的是**全局一个数**（`chartBars`，所有币种共用），跟币种无关 ——
 * 所以这里不需要旧币种、也不需要 `liveRange` 的位置，只要那个**跨度**。
 * 以前是「每个币各记一段 {from,to}」，而回调里读的 `props.symbol` 已经是新币了，
 * 于是旧币的区间被写进新币名下（用户：「切换币种，看不到 k 线，没有自动布局」）。
 */
watch([() => props.symbol, () => props.timeframe], () => {
  saveChartBars(liveBars())
})

/*
 * 配置面板里拨了那颗开关：**立刻重铺一次**（面板上写着「改完立刻生效」）。
 * 打开 → 铺全局那个根数；关掉 → 回到默认那一屏。
 */
watch(keepChartZoom, () => applyView())

/*
 * 切走这一格（窄屏换成别的 tab）：也算「关闭 K 线图」，存一下。
 * 桌面上图一直在（`active` 恒 true），走不到这里。
 */
watch(
  () => props.active,
  (on, was) => {
    if (was !== false && on === false) saveChartBars(liveBars())
  }
)

onBeforeUnmount(() => {
  // 关掉这一页也算「关闭 K 线图」：把当前那段存回去
  saveChartBars(liveBars())
  stopStream?.()
  stopStream = null
  document.removeEventListener('visibilitychange', onLiveVisible)
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
    <!--
      顶部：#top 给外层塞「行情条」（分析页塞的是 TickerHead，币安那种排法）。
      下面才是图上自己的那行：周期按钮 + 外层塞进来的按钮。
    -->
    <slot name="top" />

    <div class="chart-head">
      <!--
        左边这一格留给外层写标题；分析页现在标题都不写了 ——
        币种在顶部行情条最左边，周期有按钮高亮着，再写一遍是重复。
      -->
      <slot name="head" />
      <div class="chart-head-right">
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
        <slot name="head-end" />
      </div>
    </div>

    <div ref="wrapEl" class="chart-wrap" :class="{fading}">
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
        >
          <!-- 画好的这段还能改：两边粗线拖端点，中间按住整段挪 -->
          <span
            class="rb-edge left"
            title="拖这里改起点"
            @pointerdown="onGrabDown($event, 'left')"
            @pointermove="onGrabMove"
            @pointerup="onGrabUp"
            @pointercancel="onGrabUp"
          />
          <span
            class="rb-mid"
            title="按住拖动整段"
            @pointerdown="onGrabDown($event, 'mid')"
            @pointermove="onGrabMove"
            @pointerup="onGrabUp"
            @pointercancel="onGrabUp"
          />
          <span
            class="rb-edge right"
            title="拖这里改终点"
            @pointerdown="onGrabDown($event, 'right')"
            @pointermove="onGrabMove"
            @pointerup="onGrabUp"
            @pointercancel="onGrabUp"
          />
        </div>
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

    <!--
      图表下面**就这一行**：左边「看哪一刻」，中间指标开关，右边 A / L。
      （原来「阳线 / 阴线」那两个图例项去掉了 —— 红绿一目了然，白占地方）
    -->
    <div class="chart-foot">
      <div class="foot-left">
        <button
          type="button"
          class="time-pick"
          :class="{set: fromMs > 0}"
          :title="
            fromMs
              ? `以 ${bjTime(fromMs)} 为中心，左右各 ${CENTER_BARS} 根；点一下改时间`
              : `看某一刻：点一下选时间（那一刻摆在正中间，左右各 ${CENTER_BARS} 根）`
          "
          @click="openPicker"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="5" width="18" height="15.5" rx="2.5" />
            <path d="M3 10h18M8 3.2v3.6M16 3.2v3.6" />
          </svg>
        </button>
        <span v-if="fromMs" class="foot-time">{{ bjTime(fromMs) }}</span>
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

      <!-- 指标开关（点一下显示 / 隐藏） -->
      <div class="legend">
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
    </div>

    <!-- 底部：#bottom 给外层塞东西（分析页塞的是 1天/3天/…/1年 涨幅那一行） -->
    <slot name="bottom" />

    <!-- 选时间：弹窗里选年月日时分，选完就把那一刻摆到图的中间 -->
    <TimeModal
      v-model="pickerOpen"
      kind="point"
      title="选一个时间"
      :hint="`以这一刻为中心，左右各 ${CENTER_BARS} 根 K 线。`"
      :initial="pickerInitial"
      @confirm="onPickTime"
    />
  </section>
</template>
