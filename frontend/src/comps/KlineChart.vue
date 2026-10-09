<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue'
import * as LWC from 'lightweight-charts'
import {
  cancelTradeOrder,
  fetchCandles,
  klineStream,
  placeStopOrder,
  type Candle,
  type LevelSR,
  type TradeOpenOrder,
  type TradePositionRow
} from '../api'
import {CHART_BARS, KLINE_BARS} from '../analyze'
import {loadCandles} from '../candles'
import {emptyLevels, nearestLevels, type Levels} from '../levels'
import {livePrice, setLivePrice} from '../ticker'
import {isForeground, onForegroundChange} from '../live'
import {
  chartShowHistory,
  chartShowLiq,
  chartShowOrders,
  chartShowPosition,
  testOrder
} from '../settings'
import {contracts, priceDigitsOf, tickSizeOf} from '../store'
import {askConfirm} from '../confirm'
import {tradeKey} from '../trade-account'
import {
  baseToExSymbol,
  bindOverlayPositions,
  clearTradeOverlay,
  overlayEnabled,
  overlayErr,
  overlayFills,
  overlayOrders,
  overlayPositions,
  overlayStale,
  overlaySymbol,
  ORPHAN_SWEEP_MS,
  addLocalOrder,
  dropLocalOrder,
  overlayBump,
  refreshTradeOverlay,
  sweepOrphanOrders,
  unbindOverlayPositions
} from '../trade-overlay'
import {positionsFallbackAt} from '../positions'
// 字体栈只有 `style.css` 那一份，这里从 CSS 变量读（见 `fonts.ts`）
import {monoStack, whenFontsReady} from '../fonts'
import {createOverlayLines} from '../overlay-lines'
import TimeModal from './TimeModal.vue'
import StopSheet from './StopSheet.vue'
import {
  bjInputToMs,
  bjInputValue,
  bjShort,
  bjTime,
  decimalsFor,
  fmt,
  price,
  usd
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
  /** 挂止盈 / 止损成了或失败了，报一句给外层弹提示（图里没有 toast） */
  (e: 'note', text: string, tone: 'ok' | 'bad'): void
}>()

/** 'YYYY-MM-DDTHH:mm'（北京时间）→ 毫秒；空或无效给 0 */
function rangeMs(v: string | undefined): number {
  return v ? bjInputToMs(v) : 0
}

/** 拉多少根是**内部策略**，不往界面上摆（用户只看时间） */
const DEFAULT_BARS = CHART_BARS

/*
 * ---------------- 显示多少根：**按屏幕宽度算** ----------------
 *
 * 用户 2026-10-04：「k 线显示根数根据屏幕宽度来」。
 *
 * 之前是死值 `CHART_BARS = 200` —— 不管屏多宽都铺 200 根：
 * 桌面（绘图区 ~798px）刚好 4px 一根，手机上（绘图区 ~280px）就只有 1.4px，
 * 挤成一片糊。现在改成「**一根占多宽**固定，根数 = 可用宽度 ÷ 每根宽度」，
 * 于是桌面/手机看到的**密度一样**，手机自然少铺几根。
 *
 * `PX_PER_BAR = 4.2` 是拿桌面当前的效果反推的（798 ÷ 4.2 ≈ 190 ≈ 原来的 200），
 * 所以**桌面观感不变**，只是手机不再挤。
 */
const PX_PER_BAR = 4.2
/** 再窄也留这么多根，否则一屏就几根看着太空 */
const MIN_BARS = 30
/** 再宽也别超过（防超大屏一次铺太多卡住） */
const MAX_BARS = 400

/**
 * 这块绘图区该铺多少根。
 *
 * ⚠️ 用 `timeScale().width()` 而不是容器宽度 —— 它已经扣掉了右边价格轴，
 * 就是真正能放 K 线的那段宽度（实测桌面 798 / 手机 280）。
 */
function barsForWidth(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return DEFAULT_BARS
  return Math.min(MAX_BARS, Math.max(MIN_BARS, Math.round(w / PX_PER_BAR)))
}

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
  '1m': 1000,
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
  '1m': 60_000,
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

/** 拉多少根。
 *
 * 以某一刻为中心 = 左右各 `CENTER_BARS` 根（+ 缓冲）；
 * 其余情况就是最近的 `DEFAULT_BARS` 根 —— 不再是「从那一刻一直拉到现在」。
 * ⚠️ 这里算的是**拉多少数据**，跟屏幕宽度无关：多拉一点，缩放时不用立刻又去拉。
 */
function barsToLoad(): number {
  if (centered.value) return (CENTER_BARS + CENTER_MARGIN) * 2 + 1
  /*
   * 至少够铺满默认那一屏（再多给一点，缩放时不用立刻又去拉）。
   * ⚠️ 必须用 `KLINE_BARS`：`candles.ts` 的预取按**同一个数**拼 key，
   *    这里换个算法，提前取好的那份就对不上了（`candles.ts` 的 memo key 里带 limit）。
   */
  return KLINE_BARS
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
  {value: '1m', label: '1分'},
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

/*
 * 图例这四条：`label` 是死的，`tip` 也是死的占位。
 *
 * ⚠️ 压力 / 支撑的提示里带**价位和来源那一根**（`levelTip()`），2026-10-04 起
 *    不再挂在模板上：早先它是 `LEGEND` 这个 computed 里现算的，于是 `levels`
 *    一变就得重渲染整个组件 —— 而拖动 / 缩放时它**每帧**都在变。
 *    现在由 `syncLegendTips()` 直接改 `title`，跟模板的响应式彻底脱钩
 *    （用户：「k 线渲染有点慢」）。
 */
const LEGEND = [
  {
    key: 'volume',
    label: '成交量',
    dot: 'vol',
    tip: '成交量 ｜ 点一下显示 / 隐藏'
  },
  {key: 'ema42', label: 'EMA42', dot: 'ema', tip: 'EMA42 ｜ 点一下显示 / 隐藏'},
  {key: 'res', label: '压力', dot: 'res', tip: '压力 ｜ 点一下显示 / 隐藏'},
  {key: 'sup', label: '支撑', dot: 'sup', tip: '支撑 ｜ 点一下显示 / 隐藏'}
]

/** 图例那一行（`syncLegendTips()` 要按 `data-toggle` 找元素） */
const legendEl = ref<HTMLElement | null>(null)

const chartEl = ref<HTMLElement | null>(null)
const levelHost = ref<HTMLElement | null>(null)
/** 左侧标签容器（仓位 / 挂单那几枚） */
const ordLabelHost = ref<HTMLElement | null>(null)
const infoEl = ref<HTMLElement | null>(null)
/** 价格标签里上面那行：离现价的百分比（跟价格**同一个框**） */
const deltaEl = ref<HTMLElement | null>(null)
/** 价格标签里下面那行：触碰到的价 */
const cxValEl = ref<HTMLElement | null>(null)
/** 右轴上那枚「现价」标签（自己画的，见 `renderCurLabel`） */
const curEl = ref<HTMLElement | null>(null)
/** 十字光标的两枚轴标签（价格 / 时间，自己画的，见 `paintCrosshairTags`） */
const cxPriceEl = ref<HTMLElement | null>(null)
const cxTimeEl = ref<HTMLElement | null>(null)
/** 价格框（含上面那行百分比）的高度；字号 / 缩放不变就量一次缓存 */
let cxTagH = 0
/** 时间标签的宽度（只在文字变了时重量一次，别每帧都读 `offsetWidth`） */
let cxTimeW = 0
let cxTimeText = ''

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
let levelLabels: {price: number; color: string; el: HTMLElement}[] = []
let candles: Candle[] = []
let candleIndex = new Map<number, number>()
let emaValues: number[] = []
let overlay: {refPrice: number} = {
  refPrice: NaN
}

/**
 * 图上这两条线现在的价位。
 *
 * 2026-10-04 起**不再来自后端**（以前是固定的「最近 4 根 1h」最高/最低，
 * 看 5 分图时跟屏幕上的 K 线没关系），改成按**当前可见窗口**现算 ——
 * 口径在 `../levels`，缩放 / 平移之后会重算。
 */
const levels = ref<Levels>(emptyLevels())

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
/** 换币 / 换周期时的加载态：图上亮三颗灯（不再整块变淡，见 style.css 的 `.chart-wrap`） */
const fading = ref(false)
/** 灯带至少亮这么久，免得请求太快时看着像原地一颠 */
const FADE_MIN_MS = 140
/**
 * 图上此刻的可见区间。往前补历史时要把视图钉在原位，用它。
 */
let liveRange: {from: number; to: number} | null = null
/**
 * 「铺视图」的版本号：`showLastN()` 要隔一帧才真正设区间，
 * 这一帧里可能又换币 / 换周期了 —— 旧的那次靠它自己作废（见 `showLastN`）。
 */
let applySeq = 0

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
    /*
     * ⚠️ 用 `hourCycle: 'h23'`，别写 `hour12: false` —— 后者在部分引擎（含部分
     *    Android WebView）会按 **h24** 解析，午夜那根刻度就变成「24:00」
     *    （用户 2026-10-09：「K 线图的 X 坐标轴不应该有 24 点，应该是 0 点」）。
     */
    hourCycle: 'h23'
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
      /*
       * ⚠️ 写死字体名是个坑 —— 这里原来是
       *    `'ui-monospace, SFMono-Regular, Menlo, monospace'`，
       *    于是**轴上那串数字一直没跟着页面的 `--mono` 走**，
       *    Mac 上是 SF Mono、安卓上是 Roboto Mono，跟别处也不是一款字。
       *    现在统一从 CSS 变量读（`fonts.ts`）。
       */
      fontFamily: monoStack(),
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
      /*
       * ⚠️ 库自带的那两枚轴标签**关掉**（`labelBackgroundColor` 是库写死的 #2a3441、
       *    没有边框，跟右轴「现价」那枚「边框 + 80% 透明黑」不是一套）——
       *    用户 2026-10-06：「十字价格标签也自定义」。改成自己画的：
       *    见 `paintCrosshairTags()` + `.cx-tag`。
       *
       * ⚠️ 顺带省下一段轴宽：库原来给那枚标签预留了宽度（隔离测过 62 → 50）。
       *    不过现在刻度数字**补齐小数位**（见 `applyPricePrecision`）又宽回来几像素，
       *    所以整条轴的宽度跟改之前差不多 —— 别以为关掉它轴就一定会变窄。
       */
      vertLine: {labelVisible: false},
      horzLine: {labelVisible: false}
    },
    localization: {
      locale: 'zh-CN',
      priceFormatter: (p: number) => price(p, priceDigits.value),
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
    wickDownColor: '#e35561',
    /*
     * 「当前价格」这条线（用户 2026-10-06：「当前价格…颜色为淡白色虚线」）——
     * 它就是蜡烛系列**自带**的那条 last price 线（跟着最后一根的收盘价走），
     * 不用自己再画一条。默认它是「按涨跌染色 + 实线」，这里改成淡白虚线：
     * 不跟多空绿红抢眼，只当「现价在哪」的参考。
     *
     * ⚠️ `lastValueVisible: false`：把库画在右轴上的**那枚现价标签**关掉。
     *    它的底色 = 蜡烛的多空色，而且库**没有**改底色 / 加边框的 API
     *    （用户 2026-10-06：「k线y轴现价能改为边框 + 80% 透明黑吗」）——
     *    所以改成自己挂一个 HTML 的：见 `renderCurLabel()` + `.cur-label`。
     *    这条虚线照旧由库画（`priceLineVisible` 没关）。
     */
    priceLineColor: 'rgba(232,234,240,0.62)',
    priceLineStyle: LWC.LineStyle.Dashed,
    priceLineWidth: 1,
    lastValueVisible: false
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
  /* 叠加线（仓位 / 强平 / 挂单）挂在蜡烛系列上：横线压在蜡烛**下面**（见 `../overlay-lines.ts`） */
  overlayLines.attach(candle)

  /* 标签跟线一起动（见 `labelSyncTick`）：从图建好那刻起每帧盯一下指纹 */
  labelSyncKey = ''
  if (!labelSyncRaf) labelSyncRaf = requestAnimationFrame(labelSyncTick)

  // 视图变化：右侧百分比标签重新定位 + 让信息栏/参考价跟着可见窗口走
  chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
    positionLabels()
    syncWindowRefs()
    /*
     * 压力 / 支撑也是「按可见这段算」的 → 拖动、缩放之后跟着重算。
     * 回调在拖拽时会连着来，所以走 rAF 合并成一帧一次。
     */
    scheduleLevels()
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

  // 用户自己动过（拖动 / 滚轮 / 双指）才算「想看更早的」
  const markPanned = () => {
    userPanned = true
  }
  /* 窄屏「点一下就出信息」也挂在这几个事件上（见 `onChartPointerDown` 那一组） */
  chartEl.value.addEventListener('pointerdown', onChartPointerDown)
  chartEl.value.addEventListener('pointermove', onChartPointerMove)
  chartEl.value.addEventListener('pointerup', onChartPointerUp)
  chartEl.value.addEventListener('pointercancel', onChartPointerCancel)
  chartEl.value.addEventListener('wheel', markPanned, {passive: true})

  /*
   * 自托管字体是**异步**加载的，而 canvas 上画好的字不会自己更新 ——
   * 字体没到位时轴上画的是回退字体，之后也不会重画。
   * 所以字体就绪后再把字体应用一次，逼 LWC 重排重画一帧。
   */
  whenFontsReady(() => {
    refs?.chart.applyOptions({layout: {fontFamily: monoStack()}})
  })

  /*
   * 先把「均线 / 成交量」的显隐按 `VISIBLE`（默认全关）应用一次。
   * ⚠️ 不能靠 `computeLevels()` 顺手做 —— 那条路现在每帧都跑，
   *    `applyOptions` 会让 LWC 重算序列并重画，摆在每帧里纯属浪费。
   */
  renderOverlays()

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

  // 图上的压力 / 支撑：**按当前可见窗口现算**的摆动高低点（见 `../levels`）
  push(levels.value.resistance, '#ffa726', '压力', v.res)
  push(levels.value.support, '#26c6da', '支撑', v.sup)

  return list
}

/** 图例提示：把「这个价位是多少、来自哪一根、怎么来的」写出来 */
function levelTip(kind: 'res' | 'sup'): string {
  const lv = levels.value
  const price = kind === 'res' ? lv.resistance : lv.support
  const i = kind === 'res' ? lv.resIndex : lv.supIndex
  const src = kind === 'res' ? lv.resSource : lv.supSource
  const what = kind === 'res' ? '压力' : '支撑'
  const side = kind === 'res' ? '高' : '低'
  const tail = ' ｜ 点一下显示 / 隐藏'
  if (price === null)
    return `${what}：这一段里${side === '高' ? '上方' : '下方'}没有可用的位置${tail}`
  const bar = candles[i]
  const from = bar ? `${bjTime(bar.timestamp)} ` : ''
  // 是拐点还是「没拐点可用时的退路」，说清楚 —— 不装成拐点
  const how =
    src === 'swing' ? `${from}那根的摆动${side}点` : `这一段图上的最${side}点`
  return `${what} ${priceText(price)} · ${how}（按图上可见这段自动算）${tail}`
}

/**
 * 重算图上的压力 / 支撑，并按新值重画那两条价格线。
 *
 * 口径（`../levels`）：**只看当前可见窗口** → 找摆动高低点 →
 * 现价上方最近的一个当压力、下方最近的一个当支撑；找不到就不画。
 */
function computeLevels(): void {
  if (!refs) return
  const ts = refs.chart.timeScale()
  const r = ts.width() > 0 ? ts.getVisibleLogicalRange() : null
  /*
   * 拿不到可信的可见区间（图还没铺过、或窄屏切到别的 tab 时宽度为 0）
   * 就退回「图上加载的全部」—— 总比抱着上一次的旧线不放要好。
   */
  const next = candles.length
    ? nearestLevels(candles, r ? r.from : 0, r ? r.to : candles.length - 1)
    : emptyLevels()
  /*
   * ⚠️ 数值没变就**什么都别做**（只把标签位置摆一下）。
   *
   * 这个函数在拖动 / 缩放时是**每帧**跑的，而「窗口挪了一点、拐点还是同一个」
   * 是常态（拿真数据量过：每往前挪一根，约一半的步进数值不变）。
   * `levels` 是响应式的，赋个新对象会重渲染本组件、还会惊动外层整块重渲染 ——
   * 纯属白扔一帧的预算（用户：「k 线渲染有点慢」）。
   */
  if (sameLevels(next, levels.value)) {
    positionLabels()
    return
  }
  levels.value = next
  renderLevels()
  emitLevels(next)
}

/** 两份压力 / 支撑「算出来是同一份」吗（全等就不必重画、更不必惊动外层） */
function sameLevels(a: Levels, b: Levels): boolean {
  return (
    a.resistance === b.resistance &&
    a.support === b.support &&
    a.resIndex === b.resIndex &&
    a.supIndex === b.supIndex &&
    a.resSource === b.resSource &&
    a.supSource === b.supSource
  )
}

/* ---------------- 叠加层：订单信息（2026-10-06） ----------------
 *
 * 用户：「配置界面可以配置订单设置，1.仓位 2.订单历史 3.仓位委托 4.强平价格」
 *      「是控制和 k 线联动的价格或历史是否显示在 k 线上」。
 *      之后又定了线的样式（2026-10-06 晚）：
 *        · 当前价格 —— **淡白色虚线**、贴 y 轴（就是蜡烛系列自带那条 last price 线）
 *        · 仓位     —— **多绿 / 空红、实线**，左侧标签显示**盈利价值**
 *        · 挂单     —— **多绿 / 空红虚线**，左侧标签显示**止损 / 止盈 + 预计收益 + 数量%**
 *
 * 四样**各画各的**，跟上面「压力 / 支撑」那两条线**分开存** ——
 * 那两条是「按可见窗口现算」的、跟着平移每帧重画；这几条是账户数据，
 * **只在账户真的变了才变**（`orderLineList()` 现算一份，画线与左标签都按它来）。
 *
 * 颜色：仓位 / 挂单**按多空分绿红**（用户点名要的），跟蜡烛同一对绿红 ——
 * 靠**线型**分开（仓位实线、挂单虚线、强平红虚线）；强平的红比仓位那根更扎眼。
 *
 * 2026-10-07 又一版（用户：「止损止盈和仓位的价格都放坐标轴上颜色要对应层级最低
 * 1.仓位拖动时，原有的仓位不动，只是多条虚线去拉 方向和仓位价值不要加竖线
 * 2.止盈止损线 左侧只显示盈利价格挪到坐标轴上」）：
 *   · 横线 + 右侧轴上的价格 → 自己写的 series primitive（见 `overlayLines`）
 *   · 左标签只留「一眼要用的数」，价格一律上轴
 *   · 拖动只加一条虚线预览，原线原标签不动
 */
/** 多（买）绿 / 空（卖）红 —— 跟蜡烛同一对色，全站「多绿空红」一套 */
const SIDE_COLOR = {long: '#5eba89', short: '#e35561'} as const
/** 强平：红虚线。⚠️ 比上面那个红**亮**，短仓的仓位线也是红的，别混 */
const LINE_LIQ = '#ff5252'
/** 当前价格线：淡白 */
const LINE_LAST = 'rgba(232,234,240,0.62)'
/** 成交点（买 / 卖）—— 比蜡烛亮一档，压在蜡烛里也找得着 */
const MARKER_BUY = '#7ee787'
const MARKER_SELL = '#ff7b72'

/**
 * 一条要画的价格线（仓位 / 强平 / 挂单）。
 *
 * `label` 是**左侧**那枚标签的文字（`null` = 这条线的左边不放东西）；
 * `labelTitle` 是它的 `title`（手指按住 / 悬停看细节）。
 *
 * ⚠️ 线本身（横线 + 右侧轴上的价格）由 `overlayLines` 这个 series primitive 画，
 *    见 `../overlay-lines.ts` 开头为什么不用库自带的 `createPriceLine()`。
 */
interface OrderLine {
  p: number
  color: string
  /** 实线还是虚线 */
  dashed: boolean
  /**
   * 左侧标签：**几段**，段间一条实线分割（用户 2026-10-06：
   * 「标签都移到左边…描框带透明度中间实线分割」）。
   *   · 仓位 → `[多 $3.00] | [未实现盈亏]`（方向和价值**同一段**，中间不竖线 —— 2026-10-07）
   *   · 强平 → `[强平]`
   *   · 挂单 → `[盈利]`（止盈 / 止损）或 `[委托] | [数量]`（加仓）
   * `null` = 这条线不放标签。
   */
  label: string[] | null
  labelTitle: string
  /** 左侧标签的颜色（不填跟线同色） */
  labelColor?: string
  /** 挂单才有的单号：标签上会冒出一颗「✕」，点了确认就能撤（用户 2026-10-06） */
  cancelId?: string
  /**
   * 这条线**能不能拖**（拖了会怎样）。
   *
   * `null` / 不填 = 不能拖（强平那条就是纯参考线，拖它没意义）。
   * 有值 = 按住它左边那枚标签上下拖：仓位线 → 挂一张新的止盈 / 止损；
   * 已挂的单 → 改单。
   */
  drag?: DragRef | null
}

/**
 * 「这条线能拖出什么」——拖的是哪条仓位 / 哪张单，以及算「预计收益」要的几个数。
 */
interface DragRef {
  /** `pos` = 拖的是仓位线（挂新单）；`order` = 拖的是已挂的单（改单） */
  kind: 'pos' | 'order'
  /** 币安原始符号 */
  symbol: string
  /** 被平的那条仓位方向 */
  side: 'long' | 'short'
  /** 开仓均价（算「预计收益」） */
  entry: number
  /**
   * **当前标记价** —— 判「这张单该发止盈还是止损」用的是它，**不是**开仓价。
   *
   * ⚠️ 2026-10-06 修 `-2021`：币安的触发方向是死的（止损类型 = 价格跌到触发价才成交），
   *    所以「相对**现价**在哪一侧」才有意义。多单浮盈时把触发价拖到开仓价（保本单）——
   *    相对开仓价是赚的，但相对现价在**下方** ⇒ 只能发 `STOP_MARKET`；
   *    按开仓价判成「止盈」就会被币安回 `Order would immediately trigger.`
   */
  mark: number
  /** 这条持仓的数量（张） */
  amount: number
  /** 改单时：这一张的单号 + positionSide */
  orderId?: string
  posSide?: string
}

/**
 * 画线的那个 series primitive（横线 + 右侧轴上的价格）。
 *
 * 用户 2026-10-07：「止损止盈和仓位的价格都放坐标轴上颜色要对应**层级最低**」——
 * 库自带的 `createPriceLine()` 一是画在蜡烛**上面**、二是没有层级开关，
 * 三样（价格上轴 + 颜色对应 + 压在蜡烛下面）凑不齐 ⇒ 自己画（见 `../overlay-lines.ts`）。
 */
const overlayLines = createOverlayLines()
let orderMarkers: ReturnType<typeof LWC.createSeriesMarkers> | null = null

/** 涨跌色的 CSS 变量值（跟 `--ok` / `--bad` 同一对） */
function sideColor(side: 'long' | 'short'): string {
  return SIDE_COLOR[side]
}

/** `+$0.52` / `−$0.12`（带正负号和 $，跟「仓位」那一格一个写法） */
function money(v: number): string {
  return `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`
}

/**
 * 这条挂单是**止损**、**止盈**还是普通委托。
 *
 * ⚠️ 只能看币安原始类型（`info.type`）：ccxt 会把 `STOP_MARKET` /
 *    `TAKE_PROFIT_MARKET` 都归一成 `market`，到那儿就分不出来了（见后端 `OpenOrderRow`）。
 */
function orderKind(o: TradeOpenOrder): 'stop' | 'profit' | 'plain' {
  const t = String(o.type).toUpperCase()
  if (t.includes('TAKE_PROFIT')) return 'profit'
  if (t.includes('STOP')) return 'stop'
  return 'plain'
}

/**
 * 一张挂单「平的是哪条持仓」。
 *
 * 双向持仓模式下币安直接告诉你（`positionSide`）；单向模式（`BOTH`）只能按方向猜：
 * 卖出单平的是多单、买入单平的是空单。
 */
function orderTargetPos(o: TradeOpenOrder): TradePositionRow | null {
  const list = overlayPositions.value
  if (!list.length) return null
  if (o.posSide === 'LONG') return list.find(p => p.side === 'long') ?? null
  if (o.posSide === 'SHORT') return list.find(p => p.side === 'short') ?? null
  const want = o.side === 'sell' ? 'long' : 'short'
  return list.find(p => p.side === want) ?? null
}

/**
 * 一个挂单的左侧标签。
 *
 * 用户 2026-10-06：「止盈止损也加上价格，止盈止损百分比放标签旁」→
 * 2026-10-07：「止盈止损线 左侧只显示盈利，价格挪到坐标轴上」→
 * 同一天又补：「止盈止损字样和百分比要加上」——
 *   触发价挂在**右侧价格轴**上（颜色跟着线走），左边这枚是
 *   **止盈 / 止损 ＋ 预期盈利 ＋ 平仓百分比**（`止盈 │ +$0.5733 │ 100%`）。
 *   加仓那种（没有盈亏）照旧「委托 │ 数量 N」。
 * 数量 / 按开仓均价怎么算的**明细都在 title 里**（按住标签 / 悬停看）。
 *
 * ⚠️ 不含手续费（两张单两边都要吃一次 taker/maker），所以叫「预计」。
 */
function orderLabel(
  o: TradeOpenOrder,
  px: number
): {label: string[]; title: string; color: string} {
  const pos = orderTargetPos(o)
  const kind = orderKind(o)
  const base = kind === 'profit' ? '止盈' : kind === 'stop' ? '止损' : '委托'
  /*
   * ⚠️ 数量 0 = 币安那种 **`closePosition: true` 的「全平型」条件单**
   *    （接口里就是 `quantity:"0.0"`，App 上那个「全部仓位」）—— 用户 2026-10-07：
   *    「我在手机下现价全部止损，但是在图表 k 上显示 0%」。
   *    以前拿 `o.amount`（0）去比持仓量 ⇒ 标签上那个百分比是 **0%**、
   *    右边「预计收益」也恒等于 $0.00。它其实平的是**整条仓位** ⇒ 按 `pos.amount` 算，
   *    百分比直接 100%（跟 `tpsl.ts` 的 `tpSlOf` 一个口径，那边早就这么处理了）。
   */
  const full = !!pos && !(o.amount > 0)
  const qty = full ? pos.amount : o.amount
  const notes: string[] = [`${base} ${priceText(px)}`, `数量 ${fmt(qty)}`]
  /*
   * 这一单是**平仓**（那才有「预计收益」）：
   *   卖单打多头、买单打空头 = 平仓；反过来的那两种是加仓。
   */
  const closing = !!pos && (o.side === 'sell') === (pos.side === 'long')
  if (pos && (o.reduceOnly || closing)) {
    const diff = o.side === 'sell' ? px - pos.entryPrice : pos.entryPrice - px
    const pnl = diff * qty
    notes.push(`预计收益 ${money(pnl)}（按开仓均价 ${priceText(pos.entryPrice)} 算，不含手续费）`)
    /*
     * 颜色按**赚还是亏**走（绿 / 红）—— 止盈止损一眼看出是保护盈利还是割肉。
     */
    const color = pnl >= 0 ? '#5eba89' : '#e35561'
    const parts = [base, money(pnl)]
    if (pos.amount > 0) {
      const pct = full ? 100 : Math.min(100, (qty / pos.amount) * 100)
      notes.push(`平掉这条持仓的 ${pct.toFixed(1)}%`)
      parts.push(`${pct.toFixed(0)}%`)
    }
    return {label: parts, title: notes.join(' · '), color}
  }
  notes.push('这一单是加仓（不是平仓），不结算盈亏')
  return {
    label: [base, `数量 ${fmt(o.amount)}`],
    title: notes.join(' · '),
    color: sideColor(o.side === 'buy' ? 'long' : 'short')
  }
}

/** 这张图现在该画哪几条线（数据不是这个币的一律不画） */
function orderLineList(): OrderLine[] {
  const out: OrderLine[] = []
  if (!overlaySymbol.value || overlaySymbol.value !== baseToExSymbol(props.symbol)) {
    return out
  }
  for (const p of overlayPositions.value) {
    const long = p.side === 'long'
    const who = long ? '多' : '空'
    if (chartShowPosition.value && p.entryPrice > 0) {
      /*
       * 仓位：**多绿空红、实线**（用户 2026-10-06：「空单红色，多单绿色 实线」）。
       * 左边那枚标签：**方向 + 仓位价值 │ 未实现盈亏**（用户 2026-10-06：
       * 「仓位价值放方向旁」→「仓位是方向+价值+盈利额」；2026-10-07：
       * 「方向和仓位价值不要加竖线」⇒ 这两样合成**一段**，中间不再插分割线）——
       * 开仓价已经挂到右侧轴上了（用户 2026-10-07：「仓位的价格都放坐标轴上」）。
       * ⚠️ 标签颜色按**盈亏**染（绿赚红亏）—— 所以那个金额一定要露在标签上，
       *    不然颜色在说什么就看不出来了。数量 / 杠杆仍在 `labelTitle` 里。
       */
      const pnl = p.unrealized
      const pct = p.entryPrice > 0 && p.amount > 0
        ? (pnl / (p.entryPrice * p.amount)) * 100
        : null
      out.push({
        p: p.entryPrice,
        color: sideColor(p.side),
        dashed: false,
        label: [`${who} ${usd(p.notional)}`, money(pnl)],
        labelColor: pnl >= 0 ? '#5eba89' : '#e35561',
        /* 拖着这条线上下走 = 给这条仓位挂一张止盈 / 止损（见 `ordLabelDown`） */
        drag: {
          kind: 'pos',
          symbol: overlaySymbol.value,
          side: p.side,
          entry: p.entryPrice,
          mark: p.markPrice,
          amount: p.amount,
          posSide: p.side === 'long' ? 'LONG' : 'SHORT'
        },
        labelTitle:
          `开仓均价 ${priceText(p.entryPrice)} · ${who}单\n` +
          `未实现盈亏 ${money(pnl)}` +
          (pct === null ? '' : `（${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%）`) +
          `\n仓位价值 ${usd(p.notional)} · 数量 ${fmt(p.amount)} · ${p.leverage}x`
      })
    }
    /* 强平价只有币安真给了才画（逐仓 / 没持仓时是 null） */
    if (chartShowLiq.value && p.liquidationPrice && p.liquidationPrice > 0) {
      out.push({
        p: p.liquidationPrice,
        color: LINE_LIQ,
        dashed: true,
        /* 强平也放左边（用户：「标签都移到左边吧」）—— 价位在右侧轴上
           （用户 2026-10-07：「价格都放坐标轴上」），这里只留「强平」两个字好认是哪条线 */
        label: ['强平'],
        labelTitle: `强平价 ${priceText(p.liquidationPrice)} · ${who}单`
      })
    }
  }
  if (chartShowOrders.value) {
    for (const o of overlayOrders.value) {
      /* 市价 / 条件单没有委托价 → 退回触发价；两个都没有就不画 */
      const px = o.price ?? o.stopPrice
      if (!px || px <= 0) continue
      const lab = orderLabel(o, px)
      const target = orderTargetPos(o)
      out.push({
        p: px,
        /* 挂单：**多（买）绿、空（卖）红，虚线**（用户 2026-10-06） */
        color: sideColor(o.side === 'buy' ? 'long' : 'short'),
        dashed: true,
        label: lab.label,
        labelColor: lab.color,
        cancelId: o.id,
        /* 拖着它走 = **改单**（撤旧的、挂新价）；认不出平的是哪条就只给看、不给拖 */
        drag: target
          ? {
              kind: 'order',
              symbol: overlaySymbol.value,
              side: target.side,
              entry: target.entryPrice,
              mark: target.markPrice,
              amount: target.amount,
              orderId: o.id,
              posSide: o.posSide
            }
          : null,
        labelTitle: lab.title
      })
    }
  }
  return out
}

/**
 * 把「成交历史」按**当前周期**落到对应的那根 K 线上。
 *
 * 币安给的是精确到毫秒的成交时刻，图上只有一根根 K 线 —— 得先找到
 * 「这笔成交落在哪一根」。用**二分**在 `candles` 里找最后一个
 * `barTime <= 成交时刻` 的（比拿周期名字去算步长稳：往前补历史、跨月都不会错）。
 * 落在已加载这段之外的直接不要（画上去 LWC 也不认）。
 */
function barTimeOf(ms: number): number | null {
  if (!candles.length) return null
  const sec = Math.floor(ms / 1000)
  const first = Math.floor(candles[0]!.timestamp / 1000)
  if (sec < first) return null
  let lo = 0
  let hi = candles.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Math.floor(candles[mid]!.timestamp / 1000) <= sec) lo = mid
    else hi = mid - 1
  }
  return Math.floor(candles[lo]!.timestamp / 1000)
}

/** 成交点（买 = 往上箭头、卖 = 往下箭头），位置按这笔价跟那根 K 线的高低摆 */
function renderOrderMarkers(): void {
  if (!refs) return
  const on =
    chartShowHistory.value &&
    overlaySymbol.value === baseToExSymbol(props.symbol) &&
    candles.length > 0
  const list = on ? overlayFills.value : []
  const markers: any[] = []
  for (const t of list) {
    const time = barTimeOf(t.time)
    if (time === null) continue
    const buy = t.side === 'buy'
    /*
     * ⚠️ 成交点用**比蜡烛更亮**的一对绿 / 红（蜡烛是 #5eba89 / #e35561）：
     *    这一点是「我在这儿成交过」的事件标记，压在蜡烛的红绿里就找不着了。
     *    配置里那个小圆点（`.oset-dot[data-kind='his']`）用的是同一对颜色。
     */
    markers.push({
      time,
      position: buy ? 'belowBar' : 'aboveBar',
      color: buy ? MARKER_BUY : MARKER_SELL,
      shape: buy ? 'arrowUp' : 'arrowDown',
      text: ''
    })
  }
  /* ⚠️ LWC 要求按时间升序（后端已经排过，这里再兜一次，别信上游） */
  markers.sort((a, b) => a.time - b.time)
  if (!orderMarkers) {
    orderMarkers = LWC.createSeriesMarkers(refs.candle, markers)
    return
  }
  orderMarkers.setMarkers(markers)
}

/**
 * 把订单信息那几条线 / 点**全部撤掉**（图空了、或者判定该什么都不画时用）。
 *
 * ⚠️ 跟 `renderOrderLines()` 的「就地改价」不一样：这里是真删 —— 图上一个币的数据
 *    都没有了，留着上个币的价位线没有意义。
 */
function dropOrderLines(): void {
  lastLines = []
  overlayLines.set([])
  clearDragPreview()
  orderMarkers?.setMarkers([])
  /* 标签也一起清掉（这里是「什么都不画」，不是重算） */
  if (ordLabelHost.value) ordLabelHost.value.innerHTML = ''
  ordLabels = []
}

/**
 * 重画订单信息那几样。数据变（SSE + 各触发点）/ 开关变 / 换币 / 图的这一段变
 * 都要走一遍 —— 但**不是每帧**（跟压力支撑不一样，这个不随平移变）。
 */
function renderOrderLines(): void {
  if (!refs) return
  /* ⚠️ 正在拖那条线的时候不许重画：这一拍的数据回来会把左边那几枚标签的下标
     全打乱（正拖着的标签会指向别人）*/
  if (drag.value) return
  clearDragPreview()
  const list = orderLineList()
  /*
   * 线本体交给那个 primitive：价位 → y 是它自己在 `render` 里算的（所以平移 / 缩放
   * 自动跟手，不用像左标签那样每帧盯），右侧轴上那枚价格标签也由它出
   *（`axis` 就是轴上要写的字 —— 全部写价格，用户 2026-10-07：「价格都放坐标轴上」）。
   */
  lastLines = list.map(l => ({
    price: l.p,
    color: l.color,
    dashed: l.dashed,
    axis: priceText(l.p)
  }))
  overlayLines.set(lastLines)
  renderOrdLabels(list)
  renderOrderMarkers()
}

/* ---------------- 左侧标签（仓位 / 挂单） ----------------
 *
 * 用户 2026-10-06：「仓位…标签放左侧显示盈利价值」「挂单…左侧显示止损或者止盈
 * 加预计止损止盈后收益 加止盈数量百分比」——
 * 这几样都挂在**图左边**（右侧轴已经被价格占了，压力/支撑的百分比也在那边）。
 *
 * 实现跟右边那套百分比标签一模一样：一个绝对定位的容器 + 每行一个 `<span>`，
 * `priceToCoordinate()` 把价位换成 y 像素。⚠️ 尽量**复用** `<span>`（平移时每帧都
 * 要摆位置），只在「条数变了」时重建。
 */
let ordLabels: {
  price: number
  color: string
  /** 整颗标签（描框那个盒子） */
  el: HTMLElement
  /** 几段文字，段与段之间是 CSS 的 `i`（那条竖分割线） */
  parts: HTMLElement[]
  drag: DragRef | null
  /** 这条标签是第几条线（按下标找它 —— 点一下会露出「✕」） */
  lineIdx: number
  /** 挂单才有：点了它就去撤这张单 */
  cancelId?: string
}[] = []

/** 现在露出一颗「✕」的是哪颗标签（点一下标签出✕，再点别处收起来） */
let cancelShownEl: HTMLElement | null = null

/**
 * 上一次画给 `overlayLines` 的那一份（**含顺序**）。
 *
 * 拖动时要拿它把**被拖的那一条**换个价再 `set()` 回去 —— 线是 primitive 自己按价算 y 的，
 * 想让它跟手就得把新的价交给它（见 `drawDragPreview`）。
 */
let lastLines: {price: number; color: string; dashed?: boolean; axis?: string}[] = []
/** 这次拖动**真的动过**吗（只点一下不算 —— 点一下是"露出 ✕"） */
let dragTouched = false

/*
 * 拖**仓位线**时那条虚线自己的标签。
 *
 * ★ 两条路的区别（用户 2026-10-07 亲口定的，别搞混）：
 *   · 拖**已挂的单** = **改单** ⇒ 那条线本身就是那张单，**挪它自己**（见 `drawDragPreview`）；
 *   · 拖**仓位线** = **新挂**一张止盈 / 止损 ⇒ 原来那条是**仓位**、不是订单，
 *     挪它没有意义 —— 所以这里另起一条虚线和一枚标签（用户：「仓位的派生」）。
 * 它不在 `ordLabels` 数组里，`positionOrdLabels()` 不管它。
 */
let dragPreviewEl: HTMLElement | null = null
let dragPreviewParts: HTMLElement[] = []

/**
 * 撤一张挂单（用户 2026-10-06：「点击左侧标签出现叉号，点击弹窗确认可撤单」）。
 *
 * ⚠️ 撤单**没有测试版**：撤了就是撤了（跟「测试下单」开关无关），
 *    所以这一步必须问一次 —— 走全站那个确认框（`askConfirm`），别用 `window.confirm`
 *    （系统默认那种改不了样式，也压不过图上的东西）。
 */
async function cancelOrderAsk(id: string, symbol: string, price: number): Promise<void> {
  const name = baseToName(symbol)
  const ok = await askConfirm({
    title: `撤掉 ${name} 这张挂单？`,
    body: [
      {t: `委托价 ${priceText(price)}`, tone: 'num'},
      {t: '撤掉之后这一份平仓保护就没了。', tone: 'warn'}
    ],
    okText: '撤单',
    danger: true
  })
  if (!ok) return
  try {
    const r = await cancelTradeOrder(symbol, id, tradeKey.value?.id)
    if (!r.ok) {
      emit('note', r.error || '撤单失败', 'bad')
      return
    }
    emit('note', `已撤单：${name} @ ${priceText(price)}`, 'ok')
    /* 撤成功 = 这张单**已经不在场上**了 ⇒ 线当场抹掉（别等那次直连交易所的读） */
    dropLocalOrder(id)
    void pullOverlay()
  } catch (e) {
    emit('note', (e as Error).message, 'bad')
  }
}

/** 点标签（不是拖）= 露出 / 收起那颗「✕」 */
function toggleCancelX(item: (typeof ordLabels)[number]): void {
  if (!item.cancelId) return
  const el = item.el
  if (cancelShownEl === el) {
    hideCancelX()
    return
  }
  cancelShownEl?.classList.remove('show-x')
  el.classList.add('show-x')
  cancelShownEl = el
  buzzLight()
}

/** 把那颗「✕」收起来（点标签自己 / 点图上别处） */
function hideCancelX(): void {
  if (!cancelShownEl) return
  cancelShownEl.classList.remove('show-x')
  cancelShownEl = null
}

/** 轻轻震一下（跟别处一个路子，不支持就算了） */
function buzzLight(): void {
  try {
    navigator.vibrate?.(8)
  } catch {
    /* 忽略 */
  }
}

/**
 * 画左侧标签。
 *
 * `lines` 就是 `renderOrderLines()` 刚算出来的那一份（**下标必须对齐**：
 * 拖动时 `drawDragPreview()` 要按 `lineIdx` 去改对应的那条价格线）。
 */
function renderOrdLabels(lines: OrderLine[]): void {
  const host = ordLabelHost.value
  if (!host) return
  const items = lines.map((l, i) => ({l, i})).filter(x => x.l.label)
  /* 标签数 / 有没有「能撤的单」变了就重建（重建后要重新挂手势） */
  const sameShape =
    ordLabels.length === items.length &&
    items.every(
      (x, k) =>
        !!x.l.cancelId === !!ordLabels[k]!.cancelId &&
        x.l.label!.length === ordLabels[k]!.parts.length
    )
  if (!sameShape) {
    host.innerHTML = ''
    cancelShownEl = null
    ordLabels = items.map(({l, i}, k) => {
      const el = document.createElement('span')
      el.className = 'olb'
      el.style.color = l.labelColor ?? l.color
      /*
       * 段与段之间插一条竖线（CSS 的 `i`）：`多 $3.00 │ +$0.12`。
       * 段数由数据决定（仓位 / 加仓单两段，强平、止盈止损一段）。
       */
      const parts = l.label!.map((t, j) => {
        if (j) el.appendChild(document.createElement('i'))
        const s = document.createElement(j === 0 ? 'b' : 'span')
        s.textContent = t
        el.appendChild(s)
        return s
      })
      /*
       * 能拖的才有手势（仓位线 / 挂单线）：按住这颗标签上下拖 —— 线本身只有 1px，
       * 手指去按它太苛刻，标签就压在线上、位置一样准。
       * ⚠️ 按一下**不动** = 点（挂单那张会冒出「✕」），动了才算拖（见 `ordLabelUp`）。
       */
      if (l.drag) {
        el.classList.add('draggable')
        el.addEventListener('pointerdown', e => ordLabelDown(e, k))
        el.addEventListener('pointermove', ordLabelMove)
        el.addEventListener('pointerup', ordLabelUp)
        el.addEventListener('pointercancel', ordLabelCancel)
      }
      if (l.cancelId) {
        const x = document.createElement('button')
        x.type = 'button'
        x.className = 'olb-x'
        x.textContent = '✕'
        x.title = '撤掉这张挂单'
        /*
         * ⚠️ 这一下必须**就地拦下**（用户 2026-10-06：「点击叉号没反应」）：
         *    冒到标签上的 `pointerdown` 会开始一次「拖动」，手指一抬 `ordLabelUp`
         *    发现「没挪动」→ 当成「再点一下标签」，把 ✕ 又收了起来（`display:none`）——
         *    于是 `click` 永远到不了这颗按钮上。表现就是「点叉号什么也不发生」。
         */
        for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
          x.addEventListener(t, e => e.stopPropagation())
        }
        x.addEventListener('click', e => {
          e.stopPropagation()
          void cancelOrderAsk(l.cancelId!, overlaySymbol.value, l.p)
        })
        el.appendChild(x)
      }
      host.appendChild(el)
      return {
        price: l.p,
        color: l.labelColor ?? l.color,
        el,
        parts,
        drag: l.drag ?? null,
        lineIdx: i,
        cancelId: l.cancelId
      }
    })
  }
  for (let k = 0; k < items.length; k++) {
    const lv = items[k]!.l
    const item = ordLabels[k]!
    item.price = lv.p
    item.drag = lv.drag ?? null
    item.lineIdx = items[k]!.i
    item.cancelId = lv.cancelId
    const color = lv.labelColor ?? lv.color
    lv.label!.forEach((t, j) => {
      const el = item.parts[j]
      if (el && el.textContent !== t) el.textContent = t
    })
    if (item.color !== color) {
      item.color = color
      item.el.style.color = color
    }
    if (item.el.title !== lv.labelTitle) item.el.title = lv.labelTitle
  }
  positionOrdLabels()
}

/** 平移 / 缩放 / 价格轴动过之后，把左侧标签摆到对应的 y 上 */
function positionOrdLabels(): void {
  if (!refs) return
  for (const item of ordLabels) {
    const y = refs.candle.priceToCoordinate(item.price)
    if (y === null || y === undefined || !Number.isFinite(y)) {
      item.el.style.display = 'none'
      continue
    }
    item.el.style.display = ''
    item.el.style.top = y + 'px'
  }
  positionDragPreview()
}

/** 拖仓位线时，那枚预览标签摆到「拖到的那个价」上（跟别的标签一样按 y 摆） */
function positionDragPreview(): void {
  if (!refs || !dragPreviewEl) return
  const y = refs.candle.priceToCoordinate(dragPrice.value)
  if (y === null || y === undefined || !Number.isFinite(y)) {
    dragPreviewEl.style.display = 'none'
    return
  }
  dragPreviewEl.style.display = ''
  dragPreviewEl.style.top = y + 'px'
}

/**
 * 就地把一枚标签的文字换掉（拖「已挂的单」时用）。
 *
 * ⚠️ 段数不一样（加仓单两段、平仓单三段）就得**重建**里面的节点，而重建时要把
 *    「✕」按钮捞回来 —— 它是 `el` 的最后一个子节点，`innerHTML = ''` 会连它一起清掉。
 */
function setLabelTexts(item: (typeof ordLabels)[number], texts: string[]): void {
  if (item.parts.length !== texts.length) {
    const x = item.el.querySelector('.olb-x')
    item.el.innerHTML = ''
    item.parts = texts.map((t, j) => {
      if (j) item.el.appendChild(document.createElement('i'))
      const el = document.createElement(j === 0 ? 'b' : 'span')
      el.textContent = t
      item.el.appendChild(el)
      return el
    })
    if (x) item.el.appendChild(x)
    return
  }
  item.parts.forEach((el, j) => {
    const t = texts[j]!
    if (el.textContent !== t) el.textContent = t
  })
}

/**
 * 让标签跟线**一起动**（用户 2026-10-06：「这个 k 线插件为什么线和标签不是一块移动的」）。
 *
 * 线是 canvas 画的：价格轴一被拖动（或自动缩放变了一下），LWC 自己重画，线就到新位置了；
 * 标签是普通 DOM，得有人告诉它「这个价现在在哪个 y」。现成的回调只有两个 ——
 * 「可见区间变了」和「十字线动了」—— 而**拖右侧价格轴这两样都不发**
 * （指针压根不在画布上），于是线走了、标签还杵在原地。
 *
 * 这里每帧比一下**指纹**（y=0 处的价 + 画布宽高）：一变就重摆一次。一次就两三个
 * 便宜的取值，比挂一堆回调稳（缩放动画、自动缩放、换周期铺数据都不会漏）。
 */
let labelSyncRaf = 0
let labelSyncKey = ''
function labelSyncTick(): void {
  labelSyncRaf = requestAnimationFrame(labelSyncTick)
  if (!refs) return
  const pane = refs.chart.paneSize()
  const key = `${refs.candle.coordinateToPrice(0)}|${pane?.width ?? 0}|${pane?.height ?? 0}`
  if (key === labelSyncKey) return
  labelSyncKey = key
  positionLabels()
}

/* ---------------- 拖动：仓位线 → 挂止盈 / 止损；挂单线 → 改单 ----------------
 *
 * 用户 2026-10-06：「按住当前仓位可上下拖动挂单，拖动过程中显示预计盈利或亏损」
 *                「（挂单）可拖动改」。
 *
 * 做法：**拖左边那枚标签**（线本身只有 1px，手指按不住）。按住之后：
 *   · 那条线跟着手指走、变成虚线（挂单的样子），标签实时变成
 *     「止盈 +$0.52 · 100%」—— 这就是「拖动过程中显示预计盈利或亏损」
 *   · 松手 → 弹确认单（`StopSheet`），**确认了才真发单**
 *
 * ⚠️ 拖动期间**不许**重画（`renderOrderLines()` 头上一句挡了）：这一拍的数据回来
 *    会把正被拖着的那条线拽回原位。松手 / 取消之后再重画。
 */
/*
 * ⚠️ 用 `shallowRef`：`ref()` 会把对象**包成 Proxy**，而 `ordLabels[i].drag` 里存的是
 *    原始对象 ⇒ `l.drag === drag.value` 永远不成立（按 drag 找标签就找不着，
 *    表现是「拖着的时候线上那枚标签不动」）。踩过一次。
 */
const drag = shallowRef<DragRef | null>(null)
/** 手指按下时的位置（用来分「点一下」和「拖动」：挪动 < 6px 算点） */
let dragStartX = 0
/** 手指现在拖到的价（吸附到一个 tick 之后） */
const dragPrice = ref(0)
/** 松手后要弹的确认单（`null` = 没弹） */
const stopSheet = shallowRef<{drag: DragRef; price: number; pct: number} | null>(null)
/** 发单中（按钮转圈、防连点） */
const stopBusy = ref(false)
/** 按住时手指的 y 与那条线的价（按「挪了多少像素」换算价格，手指滑出图外也不会跳） */
let dragFromY = 0
let dragFromPrice = 0
/** 正被拖的那条线是第几条（按下标找到原来那枚标签 → 点一下出「✕」） */
let dragLineIdx = -1

/**
 * 这个合约一个 tick 多大（拖出来的价吸附到它上面；合约表里没有就按价格量级推）。
 * `symbol` 传**交易所符号**（`BTCUSDT`，合约表里那种），不是「BTC」。
 * `ref` 只在拿不到合约表时用来「按量级猜」，默认用正在拖的价。
 */
function tickOf(symbol: string, ref = dragFromPrice): number {
  return tickSizeOf(symbol) ?? 1 / 10 ** decimalsFor(ref)
}

/**
 * 图上价格的**小数位** —— 跟合约 `tickSize` 走（BTC 0.1 → 1 位、DOGE 0.00001 → 5 位）。
 *
 * ⚠️ 图上原来每处自己 `fmt()`，而 `fmt` 会把整数价格的小数位吃掉 ⇒ 同一屏里
 *    「开 85,383.3 / 高 85,615」并排（用户 2026-10-06：「精度没统一」）。
 *    价钱一律走 `priceText`，包括右轴刻度（见 `applyPricePrecision`）。
 */
const priceDigits = computed(() => priceDigitsOf(props.symbol, Number(livePrice.value) || dragFromPrice))

/** 价格文案 */
function priceText(v: unknown): string {
  return price(v, priceDigits.value)
}

/**
 * 把价格精度落到 LWC 上（右轴刻度数字走的也是 `localization.priceFormatter`）。
 * 换币 / 合约表到位后 tick 会变，所以要重设一次 —— 值没变就不动，免得白重画一帧。
 */
let appliedPriceDigits = -1
function applyPricePrecision(): void {
  if (!refs) return
  const d = priceDigits.value
  if (d === appliedPriceDigits) return
  appliedPriceDigits = d
  refs.chart.applyOptions({localization: {priceFormatter: (p: number) => price(p, d)}})
}

/** 一像素值多少钱（拿当前价和它上面 1px 的价标定） */
function pricePerPixel(): number {
  if (!refs) return 0
  const y0 = refs.candle.priceToCoordinate(dragFromPrice)
  if (y0 === null || y0 === undefined || !Number.isFinite(y0)) {
    const paneH = refs.chart.paneSize?.().height || wrapEl.value?.clientHeight || 0
    if (!paneH) return 0
    const hi = Number(refs.candle.coordinateToPrice(0))
    const lo = Number(refs.candle.coordinateToPrice(paneH))
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return 0
    return (hi - lo) / paneH
  }
  /*
   * ⚠️ 符号：y 往下**价格越低**，所以「往上 1px 的价」减「这儿的价」才是
   *    **正的**「每像素多少钱」。写成 `p1 - p2` 会得到负数，`if (perPx > 0)`
   *    那一关就把整段拖动悄悄吃掉了（踩过一次）。
   */
  const here = Number(refs.candle.coordinateToPrice(y0))
  const up = Number(refs.candle.coordinateToPrice(y0 - 1))
  if (!Number.isFinite(here) || !Number.isFinite(up)) return 0
  return Math.abs(up - here)
}

function ordLabelDown(e: PointerEvent, labelIdx: number): void {
  const item = ordLabels[labelIdx]
  if (!item?.drag || !refs) return
  e.preventDefault()
  e.stopPropagation()
  drag.value = item.drag
  dragFromPrice = item.price
  dragPrice.value = item.price
  dragFromY = e.clientY
  dragStartX = e.clientX
  /* 这条线是第几条（标签建的时候就记好了，见 `renderOrdLabels`） */
  dragLineIdx = item.lineIdx
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    /* 拿不到指针捕获也能拖（手指滑出这颗标签才断） */
  }
  /*
   * ⚠️ 这里**不**画拖动样子：按一下不动 = 点开「✕」，那时候把标签文字改成
   *    「止盈 +$0.00 100%」纯属捣乱。越过 6px 门槛才算拖（见 `ordLabelMove`，跟
   *    `ordLabelUp` 判"是不是点"用的是同一个门槛）。
   */
}

function ordLabelMove(e: PointerEvent): void {
  if (!drag.value || !refs) return
  e.preventDefault()
  /* 还没跨过"点"的门槛 ⇒ 先别动样子（见 `ordLabelDown` 末尾那条说明） */
  if (Math.abs(e.clientY - dragFromY) <= 6 && Math.abs(e.clientX - dragStartX) <= 6) return
  const perPx = pricePerPixel()
  let next = dragFromPrice
  if (perPx > 0) next = dragFromPrice + (dragFromY - e.clientY) * perPx
  const tick = tickOf(drag.value.symbol)
  next = Math.max(tick, Math.round(next / tick) * tick)
  dragPrice.value = next
  drawDragPreview()
}

/** 松手：**没挪动** = 点一下标签（露出「✕」）；挪动了 = 弹确认单（这一步不发单） */
function ordLabelUp(e: PointerEvent): void {
  if (!drag.value) return
  e.preventDefault()
  const moved =
    Math.abs(e.clientY - dragFromY) > 6 || Math.abs(e.clientX - dragStartX) > 6
  const d = drag.value
  const price = dragPrice.value
  const idx = dragLineIdx
  drag.value = null
  dragLineIdx = -1
  /* 先把图恢复成「数据的样子」，再决定是弹单还是弹✕ */
  renderOrderLines()
  if (!moved) {
    const item = ordLabels.find(l => l.lineIdx === idx)
    if (item) toggleCancelX(item)
    return
  }
  stopSheet.value = {drag: d, price, pct: DEFAULT_CLOSE_PCT}
}

/**
 * 拖动止盈 / 止损时，确认弹层里**默认平掉多少** —— **一律整条仓位**。
 *
 * 用户 2026-10-06：「每次拖动止盈止损都改为 100% 订单的数量」。
 * 止盈 / 止损是**二选一**：哪边先到就平哪边，同一个仓位的两张不会同时成交，
 * 所以每一张都按**整条仓位**报，不必去扣「已经挂了多少没保护」。
 *
 * ⚠️ 别改回「100% − 已挂平仓单占比」那套：挂单数量会被交易所按精度**向下取整**
 *    （挂满 100% 也可能差零点几张没覆盖到），减出来常是 0.1% 这种凑不满一格的值，
 *    再被 `max(1, …)` 一兜就成了「默认 1%」
 *    —— 用户 2026-10-06：「（拖动）默认 100%，为什么还会有 1%」。
 */
const DEFAULT_CLOSE_PCT = 100

function ordLabelCancel(): void {
  if (!drag.value) return
  drag.value = null
  dragLineIdx = -1
  renderOrderLines()
}

/**
 * 拖动时那条线的样子（两条路，见上面 `dragPreviewEl` 那段说明）。
 *
 *   · **已挂的单** ⇒ 把被拖的那条线**换价再 `set()` 回去**：线的 y 是 primitive
 *     自己按价算的，想让它跟手就得把新价交给它；标签也换成新的
 *     「止盈 │ +$0.52 │ 100%」（形状本来就一样）⇒ 看上去就是**原来那条线在走**。
 *     松手确认之后它就是新的那张单（后端撤旧挂新），所以"派生一条"是错的。
 *   · **仓位线** ⇒ 原来那条一动不动，`setPreview` 另画一条虚线 + 另起一枚标签。
 *
 * ⚠️ 判「止盈 / 止损」用**标记价**（拿不到才退回开仓价）—— 见 `DragRef.mark` 那段。
 */
function drawDragPreview(): void {
  const d = drag.value
  if (!d || !refs) return
  const px = dragPrice.value
  const long = d.side === 'long'
  const ref = d.mark > 0 ? d.mark : d.entry
  const isProfit = long ? px > ref : px < ref
  const diff = long ? px - d.entry : d.entry - px
  const pct = DEFAULT_CLOSE_PCT
  const pnl = diff * (d.amount * pct) / 100
  const t1 = isProfit ? '止盈' : '止损'
  /* 跟图上已挂的单一样的三段：`止盈 │ +$0.52 │ 100%`（用户：「字样和百分比要加上」） */
  const texts = [t1, money(pnl), `${pct}%`]
  const pnlColor = pnl >= 0 ? '#5eba89' : '#e35561'
  dragTouched = true

  if (d.kind === 'order') {
    /* ① 线：挪**原来那条**（`lastLines` 是上一次画的那一份，顺序跟 `dragLineIdx` 对齐） */
    const cur = lastLines[dragLineIdx]
    if (cur) {
      const next = lastLines.slice()
      next[dragLineIdx] = {...cur, price: px, dashed: true, axis: priceText(px)}
      overlayLines.set(next)
    }
    /* ② 标签：原来那枚跟着走 + 文字换成新的（拖到哪、预计盈亏就是多少） */
    const item = ordLabels.find(l => l.lineIdx === dragLineIdx)
    if (item) {
      setLabelTexts(item, texts)
      if (item.color !== pnlColor) {
        item.color = pnlColor
        item.el.style.color = pnlColor
      }
      item.price = px
      positionOrdLabels()
    }
    return
  }

  /* 仓位线：另起一条虚线 + 另起一枚标签（原线 / 原标签一根手指都不碰） */
  /* 预览虚线：颜色按「平仓单的方向」走（多头的平仓单是卖单 = 红，跟挂单那套一致） */
  overlayLines.setPreview({
    price: px,
    color: sideColor(long ? 'short' : 'long'),
    dashed: true,
    axis: priceText(px)
  })
  /* 预览标签：形状跟 `.olb` 一样，只是描边走虚线 */
  const host = ordLabelHost.value
  if (!dragPreviewEl && host) {
    const el = document.createElement('span')
    el.className = 'olb drag'
    dragPreviewParts = [0, 1, 2].map(j => {
      if (j) el.appendChild(document.createElement('i'))
      const t = document.createElement(j === 0 ? 'b' : 'span')
      el.appendChild(t)
      return t
    })
    dragPreviewEl = el
    host.appendChild(el)
  }
  dragPreviewParts.forEach((el, j) => {
    const t = texts[j]!
    if (el.textContent !== t) el.textContent = t
  })
  if (dragPreviewEl && dragPreviewEl.style.color !== pnlColor) {
    dragPreviewEl.style.color = pnlColor
  }
  positionDragPreview()
}

/**
 * 收掉拖动的临时样子。
 *
 * ⚠️ 拖「已挂的单」时改的是**原来那条线 / 那枚标签** ⇒ 这里得让它回到"数据的样子"：
 *    线由紧接着的 `renderOrderLines()` 重新 `set()` 一份数据的就复位了；
 *    标签则是把 `ordLabels` 清空、逼 `renderOrdLabels` 走**重建**（拖动期间文字和位置
 *    都改过，原地改不回去）。`dragTouched` 那道闸是为了**别每次刷新都重建标签**。
 */
function clearDragPreview(): void {
  overlayLines.setPreview(null)
  dragPreviewEl?.remove()
  dragPreviewEl = null
  dragPreviewParts = []
  if (!dragTouched) return
  dragTouched = false
  ordLabels = []
  cancelShownEl = null
}

/**
 * 确认单里点了「挂止盈 / 止损」——**这才是真正发单的那一步**。
 *
 * ⚠️ 真单（`testOrder === false`）挂上去，交易所那边就真有效了。
 * ⚠️ `orderId` 有值 = 改单：后端先撤旧的再挂新的（测试单模式不撤）。
 */
async function submitStop(v: {
  kind: 'profit' | 'stop'
  price: number
  pct: number
}): Promise<void> {
  const s = stopSheet.value
  if (!s || stopBusy.value) return
  stopBusy.value = true
  try {
    const r = await placeStopOrder(
      {
        symbol: s.drag.symbol,
        /* 平仓方向跟仓位反着来：多头的止盈 / 止损是**卖** */
        side: s.drag.side === 'long' ? 'sell' : 'buy',
        kind: v.kind,
        stopPrice: v.price,
        quantity: (s.drag.amount * v.pct) / 100,
        posSide: s.drag.posSide,
        orderId: s.drag.orderId
      },
      tradeKey.value?.id,
      testOrder.value
    )
    if (!r.ok) {
      emit('note', r.error || '挂单失败', 'bad')
      return
    }
    stopSheet.value = null
    /*
     * ⚠️ 说出来的类型用后端**实际发出去**那个 `r.kind`（可能跟这里传的不一样：
     *    触发价相对现价在哪一侧，币安只接受那一种，见后端 `legalKind()`）。
     *    用 `v.kind` 会出现「提示说挂的止盈、实际挂的是止损」。
     */
    const sent = r.kind ?? v.kind
    const what = sent === 'profit' ? '止盈' : '止损'
    const fixed = sent !== v.kind ? '（触发价在现价这一侧，按币安规矩改成' + what + '）' : ''
    const name = baseToName(s.drag.symbol)
    const tail = s.drag.orderId ? (r.test ? '（测试改单）' : '（已改单）') : ''
    emit(
      'note',
      r.test
        ? `测试${what}：${name} ${v.pct}% @ ${priceText(v.price)}，币安校验通过${tail}${fixed}` +
            '（条件单没有测试接口，没真挂上去）'
        : `已挂${what}：${name} ${v.pct}% @ ${priceText(v.price)}${tail}${fixed}`,
      'ok'
    )
    /*
     * ★ 让线跟提示**同时**出现：接口已经回了单号，先把这张单塞进叠加层的数据里。
     *   ⚠️ 只对**真单**做（测试单没真挂上去）；改单要把被撤掉的旧单号一起摘掉。
     *   紧接着那次重读照发 —— 它是**校准**，真值回来会覆盖这条乐观数据。
     */
    if (!r.test && r.orderId) {
      addLocalOrder(
        {
          id: r.orderId,
          symbol: s.drag.symbol,
          side: s.drag.side === 'long' ? 'sell' : 'buy',
          type: sent === 'profit' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET',
          posSide: s.drag.posSide === 'SHORT' ? 'SHORT' : s.drag.posSide === 'LONG' ? 'LONG' : 'BOTH',
          /* 触发价用**手指放下那个价**（后端会按 tick 取整，重读那次再对齐） */
          price: null,
          stopPrice: v.price,
          amount: (s.drag.amount * v.pct) / 100,
          filled: 0,
          reduceOnly: true,
          time: Date.now()
        },
        r.canceled
      )
    }
    /* 立刻补一次：新挂的单要马上出现在图上 */
    void pullOverlay()
  } catch (e) {
    emit('note', (e as Error).message, 'bad')
  } finally {
    stopBusy.value = false
  }
}

/** 币安原始符号 → 界面上那个币种（`1000BONKUSDT` → `1000BONK`） */
function baseToName(symbol: string): string {
  return String(symbol).toUpperCase().replace(/USDT$/, '') || symbol
}

/* ---------------- 订单信息：什么时候去拉 ---------------- */

/**
 * 订单信息**什么时候拉**（没有轮询定时器了）。
 *
 * 只在**这张主图被看着**（`active`）+ 前台 + 四个开关至少开一个的时候拉：
 *   · 桌面端左栏那张小图不传 `active` ⇒ 它一次都不拉（不然一进页面打两遍交易所）
 *   · 全关掉 = 一个请求都不发
 *
 * 触发点全是**事件**：
 *   · 进页面 / 切回来 / 回前台 / 换币 / 换「下单账户」/ 动那四个开关；
 *   · SSE（`overlayBump`：挂单变动、新成交、上游流哑了或恢复）；
 *   · 持仓兜底轮询那一拍（`positionsFallbackAt`：连 SSE 都断着的时候，`positions.ts`
 *     每 60 秒自己 REST 补一次，这里跟着补一次，免得挂单线一直冻着）。
 *
 * ⚠️ 以前还有一条 `OVERLAY_MS = 15_000` 的轮询。它才是「止盈止损线慢半拍」的元凶
 *    （实测挂一张要 **15.3 秒**才画出来），SSE 那条路接上之后就删了。
 */
let stopOverlayForeground: (() => void) | null = null

/*
 * 「没仓位的残留平仓单」定时盘一遍账户（用户 2026-10-06：仓位平了、单还挂着）。
 *
 * 平时那次**分币清**（`refreshTradeOverlay` 里手上刚好有这个币的持仓和挂单，
 * 顺手就清了）只碰当前这个币；这一轮一次把**整个账户**盘干净。
 *
 * ⚠️ 这一轮**重**（不带交易对查挂单是 40 权重/条，两套 = 80）且**跨标签页节流**，
 *    详细原因见 `trade-overlay.ts` 的 `ORPHAN_SWEEP_MS` —— 2026-10-06 就是这么把
 *    出口 IP 弄进币安 `-1003` 黑名单 8 分钟的。
 */
const ORPHAN_MS = ORPHAN_SWEEP_MS
let orphanTimer: ReturnType<typeof setInterval> | null = null

/** 盘一遍残留平仓单，撤到了就说一声（没撤到就不打扰） */
async function sweepOrphans(): Promise<void> {
  const r = await sweepOrphanOrders(tradeKey.value?.id)
  if (r.cancelled > 0) {
    const names = r.symbols.map(baseToName).join('、')
    emit('note', `🧹 已清掉 ${r.cancelled} 张无仓位挂单：${names}`, 'ok')
    void pullOverlay()
  }
}

function syncOrphanTimer(): void {
  if (!overlayWanted()) {
    if (orphanTimer) clearInterval(orphanTimer)
    orphanTimer = null
    return
  }
  if (orphanTimer) return
  orphanTimer = setInterval(() => {
    if (overlayWanted()) void sweepOrphans()
  }, ORPHAN_MS)
}

function overlayWanted(): boolean {
  return !!props.active && overlayEnabled() && isForeground()
}

/**
 * 上一次 `pullOverlay()` 取数的键（`symbol|keyId`）与时刻（2026-10-09）。
 * 见 `pullOverlay` 里的说明：只用来挡住「切页回来」，不挡 SSE 的即时补读。
 */
let lastPullKey = ''
let lastPullAt = 0
/** 叠加层的「够新」窗口：来回切页 15 秒内不重拉 */
const OVERLAY_FRESH_MS = 15_000

async function pullOverlay(): Promise<void> {
  if (!overlayWanted()) {
    /* 这一页不要订单信息了 → 持仓订阅也跟着放掉（一个请求都不发） */
    unbindOverlayPositions()
    return
  }
  /*
   * 持仓订阅**共享 store**（常驻流经 SSE 推）；绑一次就一直在，
   *   换了「下单账户」会自动重绑（`bindOverlayPositions` 里判 keyId）。
   */
  bindOverlayPositions(tradeKey.value?.id)
  /*
   * ★ 2026-10-09：**切页回来不再重拉**（用户的主场景就是「行情 tab 和开单分析 tab 来回跳」，
   *   实测他那一分钟挂单/成交/持仓被各拉了 5~6 遍）。
   *
   * ⚠️ 窗口**只加在这里**（激活这条路），**不能加进 `refreshTradeOverlay` 里** ——
   *    下面那条 SSE 事件驱动的补读（`orders` / `fill` → `overlayBump`）是**必须立刻发**的，
   *    加了窗口就会出现「刚挂的单子要等窗口过期才画上线」（用户 2026-10-07 刚报过慢 15 秒的那个问题）。
   *    换币也不会被它挡住：键里带了 symbol，换币即换键。
   */
  const key = `${props.symbol}|${tradeKey.value?.id ?? ''}`
  if (key === lastPullKey && Date.now() - lastPullAt < OVERLAY_FRESH_MS) return
  lastPullKey = key
  lastPullAt = Date.now()
  await refreshTradeOverlay(props.symbol, tradeKey.value?.id)
}

/**
 * 挂单 / 成交变了（SSE `orders` / `fill`）⇒ **马上**补一次（以前这里唯一的数据来源是
 * 一条 15 秒的轮询，已经删了）。
 *
 * 用户 2026-10-07：「k线止盈止损渲染感觉慢了一步」—— 实测（在币安那头挂一张不会成交的
 * 限价单，再看这条线什么时候出现）**慢了 15.3 秒**（当时唯一的数据来源是 15 秒轮询）。
 * 线本身照旧直连交易所读（带 symbol、权重 1），这里只是**不再干等定时器**。
 *
 * ⚠️ 两段节流，缺一不可：
 *    · **去抖 250ms** —— 一次挂 / 撤单后端会连推几条（NEW → 对账 → …），先合并成一条；
 *    · **最小间隔 700ms** —— 那几条有时**前后差几百毫秒**（去抖挡不住），
 *      实测一次下单会引来 **3 发**「重读挂单 + 重读成交」；带上最小间隔就只剩 1~2 发，
 *      而多等的那点（≤0.7s）换掉的是两三发白读。
 * ⚠️ 只当「该重读了」的信号：`pullOverlay()` 自己会判 `overlayWanted()`（不在前台 / 图没被
 *    看着 / 四个开关全关 ⇒ 一次都不打）。
 */
const ORDERS_PULL_MS = 250
const ORDERS_PULL_GAP_MS = 700
let ordersPullTimer: ReturnType<typeof setTimeout> | null = null
let lastOrdersPullAt = 0
function scheduleOverlayPull(): void {
  if (ordersPullTimer) return
  const wait = Math.max(
    ORDERS_PULL_MS,
    ORDERS_PULL_GAP_MS - (Date.now() - lastOrdersPullAt)
  )
  ordersPullTimer = setTimeout(() => {
    ordersPullTimer = null
    lastOrdersPullAt = Date.now()
    if (overlayWanted()) void pullOverlay()
  }, wait)
}

/**
 * 关掉某一样时得**立刻**把它从图上抹掉（不然要等下一次数据到达才消失），
 * 所以四个开关任一变化都重画一遍，并按需要补拉数据。
 */
watch(
  [chartShowPosition, chartShowLiq, chartShowOrders, chartShowHistory],
  () => {
    if (!overlayEnabled()) clearTradeOverlay()
    renderOrderLines()
    syncOrphanTimer()
    void pullOverlay()
  }
)

/* 换币：先把上一个币的线抹掉（`refreshTradeOverlay` 里会清），顺便重排定时器 */
watch(
  () => props.symbol,
  () => {
    renderOrderLines()
    void pullOverlay()
  }
)

/* 数据到了就重画（一次账户变动一次，开销可以忽略） */
watch(
  [overlaySymbol, overlayPositions, overlayOrders, overlayFills],
  () => renderOrderLines(),
  {deep: true}
)

/*
 * 挂单 / 成交刚变过、上游流哑了或恢复（SSE）⇒ 补一次读（去抖合并同一批事件）。
 *
 * 第二行是「连 SSE 都断着」那一档：`positions.ts` 每 60 秒自己 REST 兜一次，
 * 挂单线跟着补一次，不至于一直冻着。
 */
watch([overlayBump, positionsFallbackAt], () => scheduleOverlayPull())

/** 图脚那句「挂单」状态：读不到 / 只拿到快照时才出现（正常 `null`，不渲染） */
const ordNote = computed(() => {
  if (!chartShowOrders.value) return null
  if (overlayStale.value)
    return {
      text: '挂单：快照',
      title: `实时没读到挂单（${overlayErr.value}），图上画的是最近一次对账的快照，最多滞后 2 分钟`
    }
  if (overlayErr.value)
    return {text: '挂单：没读到', title: `这一轮没读到挂单：${overlayErr.value}`}
  return null
})

/* 换了下单账户：这一批数据是上一套 Key 的，作废重拉 */
watch(
  () => tradeKey.value?.id,
  () => {
    clearTradeOverlay()
    renderOrderLines()
    void pullOverlay()
  }
)

/* ---------------- 报给外层（节流） ---------------- */

/** 上一次把压力 / 支撑报出去的时刻（毫秒） */
let lastLevelsEmit = 0
let levelsEmitTimer: ReturnType<typeof setTimeout> | null = null
/** 攒着还没报出去的那一份（节流窗口结束时报**最新**的，不是最早的） */
let levelsEmitPending: Levels | null = null
/**
 * 连续拖动时，压力 / 支撑最多这么频繁地报给外层。
 *
 * ⚠️ 外层（开单分析结论区那把「上沿 / 现价 / 下沿」的尺子）一拿到这个数就
 *    **整块重渲染** —— 那是全站最大的一个组件，而 K 线的平移回调是每帧都来的：
 *    一帧报一次能把主线程吃满（用户：「k 线渲染有点慢」）。
 *    那把尺子只是个参考刻度，每秒刷几次跟每帧刷肉眼没差别。
 */
const LEVELS_EMIT_MS = 150

function flushLevelsEmit(): void {
  if (levelsEmitTimer) clearTimeout(levelsEmitTimer)
  levelsEmitTimer = null
  lastLevelsEmit = Date.now()
  const v = levelsEmitPending
  levelsEmitPending = null
  emit('levels', v ? {resistance: v.resistance, support: v.support} : null)
}

/** 报压力 / 支撑给外层；传 `null`（图空了）立刻生效，不能等节流 */
function emitLevels(v: Levels | null): void {
  if (!v) {
    levelsEmitPending = null
    flushLevelsEmit()
    return
  }
  levelsEmitPending = v
  if (levelsEmitTimer) return
  const wait = LEVELS_EMIT_MS - (Date.now() - lastLevelsEmit)
  if (wait <= 0) flushLevelsEmit()
  else levelsEmitTimer = setTimeout(flushLevelsEmit, wait)
}

/** 缩放 / 平移时一帧只算一次（回调会连着来） */
let levelsRaf = 0
function scheduleLevels(): void {
  if (levelsRaf) return
  levelsRaf = requestAnimationFrame(() => {
    levelsRaf = 0
    computeLevels()
  })
}

/**
 * 显隐开关变了才走这儿：均线 / 成交量那两条序列的 `visible` 要跟着动。
 *
 * ⚠️ 别把它塞进每帧都跑的 `renderLevels()` 里 —— `applyOptions` 会让 LWC
 *    重算序列并重画，平移时每帧调一次纯属浪费。
 */
function renderOverlays() {
  if (!refs) return
  const v = VISIBLE.value
  refs.ema42.applyOptions({visible: v.ema42})
  refs.volume.applyOptions({visible: v.volume})
  renderLevels()
}

/** 重画压力 / 支撑那两条价格线 + 右侧标签 + 图例提示（平移 / 缩放时高频调用） */
function renderLevels(): void {
  if (!refs) return
  const list = levelList()
  /*
   * 条数一样就**就地改价格**，别拆了重建 —— 重建会让 LWC 重新排一遍整张图。
   * （条数变了说明增 / 减了一条线，那时才重建。）
   */
  if (priceLines.length === list.length) {
    for (let i = 0; i < list.length; i++) {
      priceLines[i].applyOptions({
        price: list[i]!.p,
        color: list[i]!.color,
        title: list[i]!.title
      })
    }
  } else {
    for (const l of priceLines) {
      try {
        refs.candle.removePriceLine(l)
      } catch {
        /* 已移除 */
      }
    }
    const candleSeries = refs.candle
    priceLines = list.map(lv =>
      candleSeries.createPriceLine({
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
  syncLegendTips()
}

/**
 * 把「压力 / 支撑」那两条图例的提示（带价位、来源那一根）刷成最新的。
 *
 * ⚠️ 故意**不走模板**：早先这是 `LEGEND` 这个 computed 里现算 `levelTip()` 的，
 *    于是 `levels` 一变就整块重渲染本组件 —— 而它平移时每帧都在变。
 *    这里直接改 `title`，跟模板的响应式彻底脱钩。
 */
function syncLegendTips(): void {
  const host = legendEl.value
  if (!host) return
  for (const kind of ['res', 'sup'] as const) {
    const el = host.querySelector(`[data-toggle="${kind}"]`)
    if (el) el.setAttribute('title', levelTip(kind))
  }
}

/* ---------------- 右侧百分比标签 ---------------- */

function renderLabels() {
  const host = levelHost.value
  if (!host) return
  const refPrice = overlay.refPrice
  const list =
    refs && Number.isFinite(refPrice) && refPrice > 0 ? levelList() : []
  /*
   * ⚠️ 复用已有的 `<span>`，别每次 `innerHTML = ''` 重建：
   *    这个函数在平移 / 悬停时**每帧**都跑，反复建 / 拆 DOM 会让浏览器不停排版。
   *    只有「条数变了」（增删了某条线）才重建一次。
   */
  if (levelLabels.length !== list.length) {
    host.innerHTML = ''
    levelLabels = list.map(lv => {
      const el = document.createElement('span')
      el.style.color = lv.color
      host.appendChild(el)
      return {price: lv.p, color: lv.color, el}
    })
  }
  for (let i = 0; i < list.length; i++) {
    const lv = list[i]!
    const item = levelLabels[i]!
    item.price = lv.p
    const pct = ((lv.p - refPrice) / refPrice) * 100
    const text = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
    if (item.el.textContent !== text) item.el.textContent = text
    if (item.color !== lv.color) {
      item.color = lv.color
      item.el.style.color = lv.color
    }
    const title = `${lv.title} ${priceText(lv.p)}`
    if (item.el.title !== title) item.el.title = title
  }
  positionLabels()
}

/** 平移 / 缩放时更新标签位置 */
function positionLabels() {
  if (!refs) return
  const host = levelHost.value
  if (host) {
    /*
     * 跟价格轴**同位置同宽度** —— 标签直接挂在轴上（用户 2026-10-05：
     * 「k 线右侧百分比会定在坐标轴上」）。以前是 `right: 轴宽`，浮在轴左边、
     * 盖在 K 线上，看着像两条飘着的色块。
     */
    const axisW = Math.max(0, refs.chart.priceScale('right').width())
    host.style.right = '0px'
    host.style.width = axisW + 'px'
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
  positionOrdLabels()
  renderCurLabel()
  // 画好的范围框要跟着视图走
  drawSelection()
}

/**
 * 右轴上那枚**现价**标签（自己画的 HTML，不是库那枚 —— 见 `createChart` 里
 * `lastValueVisible: false` 那段注释）。
 *
 * 跟 `.level-labels` / `.ord-labels` 一个做法：绝对定位，`priceToCoordinate()` 换 y，
 * 宽度按价格轴的实际宽度。长什么样（边框 + 80% 透明黑）在 `style.css` 的 `.cur-label`。
 *
 * ⚠️ 现价被拖到**可视区间外**时要收起来（用户拖右轴 / 缩得很小时）——
 *    库那枚也是这么干的。不收的话它会停在图外面的空白里，看着像坏了。
 */
/**
 * 右轴宽度。标签要跟轴同宽，但**页面在后台时 LWC 的渲染循环是停的**，
 * 这时量出来是 0 —— 照抄 0 会把标签写成 0 宽（看不见），所以：
 * 量不到就**别写死宽度**（交给 CSS 按内容自适应），等回到前台再量（见 `visibilitychange`）。
 */
function axisWidth(): number {
  return Math.max(0, refs?.chart.priceScale('right').width() ?? 0)
}

function renderCurLabel(): void {
  const el = curEl.value
  if (!el) return
  const price = candles.length ? candles[candles.length - 1]!.close : NaN
  const y = refs && Number.isFinite(price) ? refs.candle.priceToCoordinate(price) : null
  const paneH = refs?.chart.paneSize?.().height ?? 0
  const off =
    y === null || y === undefined || !Number.isFinite(y) || y < 0 || y > paneH
  el.classList.toggle('off', off)
  if (off) return
  el.style.top = `${y}px`
  const axisW = axisWidth()
  el.style.width = axisW ? `${axisW}px` : ''
  /* 位数字跟右轴刻度同一套（`priceText` 就是图的 `priceFormatter`），别自己另定精度 */
  const text = priceText(price)
  if (el.textContent !== text) el.textContent = text
}

/* ---------------- 左上角信息栏 ---------------- */

/** 成交额：中文量级（跟「行情条」上的 `big()` 一个口径），别糊一长串数字 */
function fmtQuote(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '—'
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`
  return fmt(v, 0)
}

/**
 * 这一根的成交额（USDT）。
 *
 * ⚠️ 是个**折算值**，不是币安那个 `quoteAssetVolume`：我们的 K 线是走
 *    ccxt `fetchOHLCV` 拿的，它只回 6 个字段（没有成交额），所以用
 *    **典型价 × 成交量** 折算（典型价 = (高 + 低 + 收) / 3，
 *    比拿收盘价算更贴近真实成交均价）。
 */
function quoteOf(
  bar: {high: number; low: number; close: number},
  vol: number
): number {
  if (!Number.isFinite(vol) || vol <= 0) return NaN
  const px = (bar.high + bar.low + bar.close) / 3
  if (!Number.isFinite(px) || px <= 0) return NaN
  return vol * px
}

/**
 * 触碰 / 悬停时那一格信息（用户 2026-10-05：**去掉「成交量」和那个 `0.45x` 倍数，
 * 改显示「成交额」**）。
 */
function infoHTML(
  bar: {open: number; high: number; low: number; close: number},
  vol: number
): string {
  const chg = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : NaN
  const cls = Number.isFinite(chg) ? (chg >= 0 ? 'up' : 'down') : ''
  const chgText = Number.isFinite(chg)
    ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`
    : '—'
  return [
    `<span><span class="k">开</span>${priceText(bar.open)}</span>`,
    `<span><span class="k">高</span>${priceText(bar.high)}</span>`,
    `<span><span class="k">低</span>${priceText(bar.low)}</span>`,
    `<span><span class="k">收</span>${priceText(bar.close)}</span>`,
    /* 这一格原来光秃秃一个「+0.18%」，跟开/高/低/收 不是一套 —— 补上「涨跌幅」三个字
     *（用户 2026-10-06：「k线信息加上涨跌幅字，样式和原来一样简单」）。 */
    `<span class="${cls}"><span class="k">涨跌幅</span>${chgText}</span>`,
    `<span><span class="k">成交额</span>${fmtQuote(quoteOf(bar, vol))}</span>`
  ].join('')
}

/** 未悬停时展示第 i 根 K 线 */
function showInfoAt(i: number) {
  if (!infoEl.value || !candles.length) return
  const idx = Math.min(candles.length - 1, Math.max(0, i))
  const c = candles[idx]
  infoEl.value.innerHTML = infoHTML(
    {open: c.open, high: c.high, low: c.low, close: c.close},
    c.volume
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

/**
 * 光标 / 手指落在图上时：信息栏 + 右侧「相对当前价」都按这根 K 线和这个价刷一遍。
 *
 * ⚠️ 抽出来是因为有**两条**路进来：鼠标 hover（`updateHover`）、
 *    窄屏轻点（`showAtPointer`）—— 后者拿不到 crosshair 事件，得自己刷。
 */
function paintHover(
  bar: {open: number; high: number; low: number; close: number},
  vol: number,
  cursorPrice: number | null | undefined,
  cursorX: number,
  cursorY: number,
  timeSec: number
): void {
  hovering = true
  if (infoEl.value) {
    infoEl.value.innerHTML = infoHTML(bar, vol)
    /*
     * `.on` = 「现在真的在指/在碰」。窄屏只有带上它才显示（用户 2026-10-05：
     * 「移动端的触碰信息是触碰才有」）—— 平时图上是干净的，不糊一层数字。
     */
    infoEl.value.classList.add('on')
  }

  /*
   * ⚠️ 百分比那一行**必须先刷**：它跟价格同一个框，`paintCrosshairTags` 要按
   *    「框有多高」把它摆到光标上，这一行没内容时量出来的高度是错的。
   */
  paintDeltaRow(Number(cursorPrice))

  paintCrosshairTags(cursorX, cursorY, timeSec, Number(cursorPrice))
}

/**
 * 价格标签里上面那一行：这个价离现价多少（%）。
 *
 * 用户 2026-10-06：「触碰时百分比放上面」「y轴价格百分比和触碰的价格放在一个框内」——
 * 所以它不再是轴上另立一枚浮层，而是价格标签里的**第一行**（见模板里的 `.cx-price`）。
 * 拿不到现价参考（`overlay.refPrice`）就把这一行收起来，只留价格。
 */
function paintDeltaRow(cursorPrice: number): void {
  const row = deltaEl.value
  const box = cxPriceEl.value
  if (!row || !box) return
  const refPrice = overlay.refPrice
  if (!Number.isFinite(refPrice) || refPrice <= 0 || !Number.isFinite(cursorPrice)) {
    if (!row.classList.contains('hidden')) {
      row.classList.add('hidden')
      /* 没有百分比这一行就不该有涨跌色 —— 整个框退回中性黑底 */
      box.classList.remove('up', 'down')
      /* 框少一行 ⇒ 高度缓存作废，下一帧按一行重新量 */
      cxTagH = 0
    }
    return
  }
  const vs = ((cursorPrice - refPrice) / refPrice) * 100
  if (row.classList.contains('hidden')) {
    row.classList.remove('hidden')
    cxTagH = 0
  }
  /*
   * 涨跌色染在**整个框**上（用户 2026-10-06：「原有的价格背景色就去掉吧和百分比统一」）——
   * 所以类挂在框 `.cx-price` 上，不是挂在那一行上。
   */
  const up = vs >= 0
  box.classList.toggle('up', up)
  box.classList.toggle('down', !up)
  const text = `${vs >= 0 ? '+' : ''}${vs.toFixed(2)}%`
  if (row.textContent !== text) row.textContent = text
}

/**
 * 十字光标那两枚轴标签：**价格**贴右轴（跟光标的高度对齐）、**时间**贴底部时间轴
 * （跟光标的横坐标对齐）。
 *
 * 用户 2026-10-06：「十字价格标签也自定义」—— 库自带那两枚底色是写死的
 * （`crosshair.*.labelBackgroundColor`），跟我们这套「1px 边框 + 80% 透明黑」对不上，
 * 所以在 `createChart` 里把库的关了（`labelVisible: false`），自己画（`.cx-tag`）。
 *
 * ⚠️ 贴边要**收进来**（库那两枚也是这么干的）：不夹一下，靠上 / 靠左时半枚标签会
 *    露到图外面去。
 * ⚠️ 宽度 / 高度各量一次就缓存：这个函数是悬停时**每帧**跑的，别每帧都读
 *    `offsetWidth`（那是一次强制重排）。
 */
function paintCrosshairTags(
  x: number,
  y: number,
  timeSec: number,
  price: number
): void {
  const pEl = cxPriceEl.value
  const tEl = cxTimeEl.value
  const pane = refs?.chart.paneSize?.()
  const paneW = pane?.width ?? 0
  const paneH = pane?.height ?? 0
  if (!pEl || !tEl || !refs || !paneW || !paneH) {
    pEl?.classList.add('off')
    tEl?.classList.add('off')
    return
  }

  /*
   * ---- 价格框：贴右轴，整个框**居中在光标的 y 上** ----
   *
   * 用户 2026-10-06：「线连接要居中」⇒ 十字光标那条横线要从框的**正中**穿出去，
   * 所以按整个框（两行）居中，不是按价格那一行居中。
   * 顶到图顶 / 图底就整体夹进 pane 里（框比 pane 还高时才可能贴边，正常不会）。
   */
  /*
   * ⚠️ **先把价格写进去再量**：量的时候 `.cx-v` 还是空的（只有 padding 的 2px 高），
   *    缓存下来的高度就偏小、框会整体偏上小半行。
   */
  const val = cxValEl.value
  const pText = Number.isFinite(price) ? priceText(price) : '—'
  if (val && val.textContent !== pText) val.textContent = pText
  if (!cxTagH) {
    /* 量之前得先让它露出来（`.off` 是 `display: none`，量出来是 0） */
    pEl.classList.remove('off')
    cxTagH = pEl.offsetHeight
  }
  const axisW = axisWidth()
  pEl.style.width = axisW ? `${axisW}px` : ''
  /*
   * ⚠️ `top` 这里**已经减掉了半个框高**，所以 `.cx-price` 的 CSS **不能**再挂
   *    `translateY(-50%)`（那会再往上顶半框）。
   */
  const top = y - cxTagH / 2
  pEl.style.top = `${Math.min(Math.max(top, 0), Math.max(0, paneH - cxTagH))}px`
  pEl.classList.remove('off')

  /* ---- 时间：贴底部轴，横向跟光标（贴着图的两边时夹住） ---- */
  const tText = bjShort(timeSec)
  if (tText !== cxTimeText) {
    tEl.classList.remove('off')
    tEl.textContent = tText
    cxTimeText = tText
    cxTimeW = tEl.offsetWidth
  }
  tEl.style.left = `${Math.min(Math.max(x, cxTimeW / 2), Math.max(cxTimeW / 2, paneW - cxTimeW / 2))}px`
  tEl.classList.remove('off')
}

/** 什么都没指着：信息栏退回「可见窗口最右边那根」、窄屏直接藏起来，右侧 ±% 也藏 */
function clearHover(): void {
  hovering = false
  deltaEl.value?.classList.add('hidden')
  infoEl.value?.classList.remove('on')
  cxPriceEl.value?.classList.add('off')
  cxTimeEl.value?.classList.add('off')
  showInfoAt(rightmostVisibleIndex())
}

/** 悬停 / 触碰：更新左上角信息栏与右侧「相对当前价」 */
function updateHover(param: any) {
  if (!refs || !param?.point || param.time === undefined) return clearHover()

  const bar = param.seriesData?.get(refs.candle)
  if (!bar) return clearHover()

  const volObj = param.seriesData.get(refs.volume)
  paintHover(
    bar,
    Number(volObj?.value),
    refs.candle.coordinateToPrice(param.point.y),
    param.point.x,
    param.point.y,
    Number(param.time)
  )
}

/* ---------------- 窄屏：点一下就出信息 ---------------- */

/*
 * 用户 2026-10-05：「移动端能够做到点击一下就能够出现信息，现在是长按才会有」。
 *
 * lightweight-charts 在触屏上**长按**才把十字光标交出来，轻点它只当「点了个空白」。
 * 所以这里自己判一次「轻点」：位移没超过 `TAP_SLOP`、按住没超过 `TAP_MS` 才算；
 * 拖了 / 按久了都不管（那是看历史行情、不是点信息）。
 *
 * ⚠️ 只认 `pointerType === 'touch'`：桌面端 hover 本来就有信息，不用再插一脚。
 * ⚠️ `setCrosshairPosition()` **不会**触发 `subscribeCrosshairMove`
 *    （内部是 `skipEvent = true`），所以信息栏得自己刷 —— 见 `paintHover`。
 */
const TAP_SLOP = 8
const TAP_MS = 350

let tapFrom: {x: number; y: number; at: number} | null = null

/**
 * 十字光标是不是「轻点钉住的」——钉着的时候**再轻点一下 = 收起**
 * （用户 2026-10-06：「k线点击一次出现k线触碰的效果已有，再次点屏幕取消」）。
 *
 * ⚠️ 不能跟着 `clearHover()` 一起重置：真机上轻点之后 LWC 有时会补一个
 *    「没有 point」的 crosshair 事件，那一下只是把信息收起来，钉住的语义还在
 *    —— 重置了的话第二下轻点就变成「重新摆一次」而不是「取消」。
 */
let tapPinned = false

/** 把十字光标摆到手指那一列，并刷出信息 */
function showAtPointer(clientX: number, clientY: number): void {
  const host = chartEl.value
  if (!host || !refs || !candles.length) return
  const rect = host.getBoundingClientRect()
  const x = clientX - rect.left
  const y = clientY - rect.top
  const logical = refs.chart.timeScale().coordinateToLogical(x)
  if (logical === null || logical === undefined) return
  const i = Math.min(candles.length - 1, Math.max(0, Math.round(logical)))
  const c = candles[i]
  if (!c) return
  const price = refs.candle.coordinateToPrice(y)
  refs.chart.setCrosshairPosition(
    Number.isFinite(price) ? (price as number) : c.close,
    Math.floor(c.timestamp / 1000),
    refs.candle
  )
  paintHover(c, c.volume, price, x, y, Math.floor(c.timestamp / 1000))
  tapPinned = true
}

/** 收起轻点钉住的十字光标 / 信息（再点一下屏幕，或手指拖走了） */
function clearPinnedPointer(): void {
  tapPinned = false
  refs?.chart.clearCrosshairPosition()
  clearHover()
}

function onChartPointerDown(e: PointerEvent): void {
  /* 跟原来的 `markPanned` 一样：自己动过图就算「在看更早的行情」 */
  userPanned = true
  /* 手指落到图上 = 不看标签了，那颗「✕」收起来（跟点标签自己一下一个效果） */
  hideCancelX()
  tapFrom =
    e.pointerType === 'touch'
      ? {x: e.clientX, y: e.clientY, at: Date.now()}
      : null
}

function onChartPointerMove(e: PointerEvent): void {
  /*
   * 手指 / 鼠标在图上一动就把标签摆一次（用户 2026-10-06：「线和标签不是一块移动的」）。
   *
   * 拖右侧价格轴时线会跟着动、而这期间 LWC 的两个回调一个都不发（指针不在画布上、
   * 可见区间也没变）⇒ 标签就杵在原地。指针事件是**我们自己**挂在容器上的，
   * 轴那一条也在容器里，所以这里补一次最稳；每帧一次的那个兜底见 `labelSyncTick`
   * （它在手势之外的变化上生效，比如自动缩放、铺新数据）。
   * ⚠️ 开销跟已有的「十字线一动就摆」（`subscribeCrosshairMove`）一个量级，不是新负担。
   */
  positionLabels()
  if (!tapFrom) return
  if (
    Math.abs(e.clientX - tapFrom.x) > TAP_SLOP ||
    Math.abs(e.clientY - tapFrom.y) > TAP_SLOP
  ) {
    tapFrom = null
    /* 手指拖了 = 在看历史行情，刚才点出来的信息别赖在图上 */
    clearPinnedPointer()
  }
}

function onChartPointerUp(e: PointerEvent): void {
  const from = tapFrom
  tapFrom = null
  if (!from || e.pointerType !== 'touch') return
  if (Date.now() - from.at > TAP_MS) return
  /* 已经钉着 = 这一下是「取消」，不是「再看这一根」 */
  if (tapPinned) return clearPinnedPointer()
  showAtPointer(e.clientX, e.clientY)
}

function onChartPointerCancel(): void {
  tapFrom = null
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
 * 按当前**屏幕宽度**把视图铺一次（居中那种情况不走这里，它是用户明确点的）。
 *
 * ⚠️ 2026-10-04 改：以前这里读「存下来的根数」（`keepChartZoom` / `chartBars`），
 *    整套跟着删了（用户：「k 线保持样式缩放逻辑全部删掉」）。现在**每次都按绘图区
 *    宽度算** —— 用户手动缩放只影响当下这一屏，切走 / 换币就回到按宽度算的值。
 */
function applyView(): void {
  if (!refs || !candles.length) return
  const ts = refs.chart.timeScale()
  showLastN(ts, candles.length, barsForWidth(ts.width()))
}

/**
 * 只把当前可见区间记在 `liveRange` 里（往前补历史时要把视图钉在原位，要用它）。
 *
 * ⚠️ 不再往配置面板报「现在显示多少根」了 —— 那个读数跟着缩放记忆一起删了。
 */
function reportShown(): void {
  if (!refs) return
  const ts = refs.chart.timeScale()
  if (ts.width() <= 0) return // 图没露出来（窄屏切到别的 tab），这时报的区间没意义
  const r = ts.getVisibleLogicalRange()
  if (r) liveRange = {from: r.from, to: r.to}
}

/**
 * 画图。
 *
 * `keepView = true` 时（往前补历史）不重设视图，而是把时间轴整体右移
 * 「新塞进来的根数」，这样用户看的那一段不会跳。
 */
function draw(data: Candle[], keepView = false) {
  if (!ensureChart() || !refs) return
  const view = keepView ? refs.chart.timeScale().getVisibleLogicalRange() : null
  candles = data
  /* 换币 / 合约表到位后价格小数位可能变，落到 LWC 上（右轴刻度数字也走它） */
  applyPricePrecision()

  if (!data.length) {
    refs.candle.setData([])
    refs.volume.setData([])
    refs.ema42.setData([])
    emaValues = []
    candleIndex = new Map()
    overlay.refPrice = NaN
    // 没数据就别留着上一个币那两条线
    levels.value = emptyLevels()
    emitLevels(null)
    renderLevels()
    /* 图空了：订单信息那几条线 / 点也得撤掉，别留在空图上 */
    dropOrderLines()
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
  emaValues = ema(closes, 42)
  candleIndex = new Map(data.map((c, i) => [t(c), i]))
  refs.ema42.setData(
    emaValues
      .map((v, i) => ({time: t(data[i]), value: v}))
      .filter(p => Number.isFinite(p.value))
  )

  /*
   * 换币 / 换周期 / 换时间（整段重画）时把右侧价格轴交还给**自动缩放**。
   *
   * ⚠️ 用户在价格轴上拖过 / 捏过之后，LWC 会把 `autoScale` 关掉（这是它的默认行为）；
   *    不重开的话，换到新币时价格轴还停在上一个币的区间 —— 新蜡烛可能整个落在框外，
   *    看着就是「k 线价格没有重置 y 轴」（用户反馈：有时候不重置）。
   * ⚠️ `keepView`（往前补历史）不能动 —— 那时要把用户正看的那一段钉住，
   *    这里只在整段重画时重置。
   */
  if (!keepView) {
    refs.chart.priceScale('right').applyOptions({autoScale: true})
  }

  overlay.refPrice = closes[closes.length - 1]
  /*
   * 压力 / 支撑：拿新数据 + 此刻的可见区间先算一遍（换币后那两条线得马上是新币的，
   * 不能停在上一个币的价位上）。视图真正铺好之后，下面 `scheduleLevels()` 还会再算一次。
   * ⚠️ 先把节流计时清零：换币 / 换周期是「一次性」动作，外层该**立刻**拿到新值，
   *    不能因为刚好落在上一次平移的节流窗口里而等 150ms。
   */
  lastLevelsEmit = 0
  computeLevels()
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
  /*
   * 再算一次压力 / 支撑：视图是在上面那几支里才真正铺好的
   *（`applyView()` / 居中那支都是**隔一帧**才设可见区间）。
   * 走 rAF → 排在它们后面执行，拿到的就是铺好之后的区间。
   */
  scheduleLevels()
  /*
   * 订单信息（开仓均价 / 强平 / 委托线 + 成交点）跟着新数据重画一次：
   * 换币要立刻换成新币的线、成交点也要按新的一段重新落位
   * （`barTimeOf` 是拿 `candles` 二分找的，数据换了不重画就会画在错的一根上）。
   */
  renderOrderLines()
  emit('loaded', data)
}

async function load() {
  const symbol = props.symbol.trim()
  if (!symbol) return
  const seq = ++loadSeq
  /*
   * 换币 / 换周期 / 换时间都要整段重画，这中间在图中间亮一条三颗灯的灯带。
   * 以前是整块 `opacity: .3` 淡下去 —— 用户 2026-10-10 说那像「蒙了一层遮罩」，
   * 改成只给指示灯：旧图保持原样，直到新数据画上去。
   */
  const startedAt = performance.now()
  let cached = false
  reloading = true
  fading.value = true
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
    /*
     * 走 `candles.ts`：合约列表里划过/按过的币，这段 K 线**已经提前取好了**
     * （`cached: true`）—— 那就不必等网络，直接画。
     */
    const r = await loadCandles(symbol, props.timeframe, barsToLoad(), range)
    const d = r.payload
    cached = r.cached
    // 半路又切了一次（连点几个币）→ 这次的结果作废，让最后那次画
    if (seq !== loadSeq) return
    // 测试模式：接口只保证 ts ≤ to，那根**还没收盘**的得自己剔掉
    const bars =
      testMode.value && lastClosedMs.value > 0
        ? (d.candles ?? []).filter(c => c.timestamp <= lastClosedMs.value)
        : (d.candles ?? [])
    draw(bars)
    /*
     * 数据本来就在手上 → 立刻收掉灯带，连那 140ms 都不等。
     * 「点币种 → 跳过去 K 线已经画好了」靠的就是这一句：亮灯和画图之间
     * 没有任何等待，浏览器通常一帧都没来得及把灯带画出来。
     */
    if (cached) fading.value = false
  } catch (e) {
    if (seq === loadSeq) emit('error', (e as Error).message)
  } finally {
    if (seq === loadSeq) {
      reloading = false
      // 先把新数据画进 canvas，再等灯带够时长（太快的请求也能看出「换过了」）
      const wait = cached
        ? 0
        : Math.max(0, FADE_MIN_MS - (performance.now() - startedAt))
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
  /*
   * ⚠️ 竞态：这一段是**异步**的（库里 10ms、退回交易所 200~2000ms），
   *    而它是 append/prepend 进同一个 `candles`。用户拖到左边缘之后马上点了别的币，
   *    `load()` 已经画上新币了，这一段晚到的**旧币**数据再 prepend 上去，
   *    图上就是「两个币的价格拼在一起」——而且不会自己恢复（要等下一次 load）。
   *    所以这里跟 `load()` 用同一个序号：回来时序号变了就整段作废。
   */
  const seq = loadSeq
  loadingOlder = true
  try {
    const d = await fetchCandles(symbol, props.timeframe, group, {
      from: firstMs - group * step,
      to: firstMs - 1
    })
    if (seq !== loadSeq) return
    const older = (d.candles ?? []).filter(c => c.timestamp < firstMs)
    if (!older.length) {
      reachedStart = true
      return
    }
    // 这一批连一半都凑不齐，基本就是拉到交易所最早那几根了
    if (older.length < group / 2) reachedStart = true
    prependCount = older.length
    // keepView：别 fitContent，把视图钉在用户正看的那一段
    draw([...older, ...candles], true)
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

  // 尾部重算：EMA 要跟着最后一根走
  emaValues = ema(
    candles.map(x => x.close),
    42
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
  // 头部那条行情的「现价」也吃这一口（比那档 15 秒的行情缓存快得多，价格才闪得起来）
  setLivePrice(props.symbol, c.close)
  /* 右轴那枚「现价」标签也得跟着走：它按 `priceToCoordinate(现价)` 摆 */
  renderCurLabel()
  // 画上的选中框、结束线位置跟着数据长度走
  drawSelection()
}

/** 订上实时推送（测试/回看是历史视图，不订；这一页被切走也不订） */
function startStream(): void {
  stopStream?.()
  stopStream = null
  const symbol = props.symbol.trim()
  if (!symbol || testMode.value) return
  /*
   * ⚠️ 2026-10-04 加了路由 `KeepAlive` 之后，切走这一页组件**不再卸载**，
   *    而 `visibilitychange` 只反映「浏览器标签页」级别的前后台（站内切 tab 一直是
   *    visible）—— 不拦一下就会留一条 SSE 在后台白收推送。
   */
  if (props.active === false) return
  stopStream = klineStream(
    symbol,
    props.timeframe,
    c => applyTail([c]),
    onStreamReconnect
  )
}

/**
 * 流断够了时间又连回来（切后台回来、或看门狗收掉了一条僵尸连接）：
 * 把这段时间漏掉的 K 线补回来。
 *
 * ⚠️ 只重订不补数据的话，图上会**在中间缺一段** —— 最后一根虽然在跟着动，
 *    它前面是空的（后台待得越久缺口越大）。
 */
function onStreamReconnect(): void {
  if (testMode.value) return
  void load()
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

/*
 * 页面被切到后台时 LWC 的渲染循环会停（`priceScale().width()` 停在 0），
 * 回到前台后它自己会重排重画、但**不会**通知我们 —— 所以清一下 `labelSyncKey`
 * 逼下一帧重新定位一次标签（宽度/位置都用得上轴宽）。
 */
function onVisible(): void {
  if (document.visibilityState !== 'visible') return
  labelSyncKey = ''
}
onMounted(() => document.addEventListener('visibilitychange', onVisible))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisible))

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
/*
 * 实时推送：币种 / 周期 / 测试模式一变就重订（上游 WS → 后端 SSE → 这里）。
 *
 * ⚠️ 这里**不再自己听 `visibilitychange`** 了：「App 切后台断开 / 回前台重连」
 *    现在全在 `klineStream` → `liveSse` 里（切后台还顺手断开省电）。
 *    而且光听 `visibilitychange` 也**不够**：原生壳里切后台 / 锁屏不一定会发它，
 *    得靠 Capacitor 的 `appStateChange`（见 `native.ts` + `live.ts`）。
 */
onMounted(startStream)
watch([() => props.symbol, () => props.timeframe, testMode], startStream)
// 「这一页被切走 / 切回来」也要断和重订（路由 KeepAlive 之后组件不卸载了）
watch(() => props.active, startStream)

/*
 * 订单信息（仓位 / 强平 / 仓位委托 / 订单历史）的取数：
 * 进来看见就要有 → 挂载时拉一次；切走 / 切回来（`active`）各对齐一次；
 * 前台翻转立刻补一次。之后**没有轮询**了，全靠 SSE 事件（见 `scheduleOverlayPull`）。
 */
onMounted(() => {
  void pullOverlay()
  /* 进页面先把账户盘一遍（上次在别处平掉的仓位，残单就是这时候清掉的） */
  void sweepOrphans()
  syncOrphanTimer()
  stopOverlayForeground = onForegroundChange(on => {
    if (on) {
      void pullOverlay()
      void sweepOrphans()
    }
    syncOrphanTimer()
  })
})
watch(() => props.active, on => {
  if (on) {
    void pullOverlay()
    void sweepOrphans()
  }
  syncOrphanTimer()
})
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
 * ⚠️ 这里原来还有三处「存下现在显示多少根」的 watcher（换币/换周期、配置面板那颗
 *    「保持缩放」开关、切走这一格），2026-10-04 跟着缩放记忆**一起删了** ——
 *    现在显示根数只由屏幕宽度决定（`barsForWidth`），没什么可存的。
 */

onBeforeUnmount(() => {
  stopStream?.()
  stopStream = null
  if (levelsEmitTimer) clearTimeout(levelsEmitTimer)
  levelsEmitTimer = null
  /* 每帧盯标签位置的那个也要停（不然它一直在跑、还在往死对象上取值） */
  if (labelSyncRaf) cancelAnimationFrame(labelSyncRaf)
  labelSyncRaf = 0
  labelSyncKey = ''
  /* 订单信息那套（定时器 + 前后台监听）也要收掉，不然切页之后还在打交易所 */
  unbindOverlayPositions()
  if (orphanTimer) clearInterval(orphanTimer)
  orphanTimer = null
  /* 挂单变动那条去抖也要收（收完就不该再补那一发了） */
  if (ordersPullTimer) clearTimeout(ordersPullTimer)
  ordersPullTimer = null
  stopOverlayForeground?.()
  stopOverlayForeground = null
  /* 画叠加线的那个 primitive 挂在蜡烛系列上，图拆掉之前先摘下来 */
  overlayLines.detach()
  try {
    refs?.chart.remove()
  } catch {
    /* 忽略 */
  }
  refs = null
  priceLines = []
  levelLabels = []
  /* ⚠️ 这个引用的是**已经拆掉的图**，不清掉的话下次挂载会往死对象上 setMarkers */
  orderMarkers = null
  ordLabels = []
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

    <!--
      ⚠️ `data-no-swipe`：窄屏一级 tab 的「左右滑动切换」把手势区铺到了整个 `.split`
      （见 `AnalyzeView`），图这块得自己吃下横向手势 —— 图上横划是拖动看历史行情，
      不能被当成「切 tab」。其余位置（tab 行 / 行情条 / 周期行 / 图下工具行）照旧能滑动切换。
      ⚠️ 图下面那块**下单模块**（`OrderPanel`，槽 `#bottom`，在本元素之外）也自己吃横向手势
      （它在自己的根上标了 `data-no-swipe`）—— 横划是切「开单 / 仓位」，不是切一级 tab。
    -->
    <div ref="wrapEl" class="chart-wrap" data-no-swipe :class="{fading}">
      <div ref="chartEl" class="chart"></div>
      <!--
        换币 / 换周期的指示灯：三颗灯一颗一颗亮过去（`style.css` 的 `.kl-dots`）。
        以前是整块变淡，用户觉得像蒙了层遮罩 —— 现在只加这一条灯带。
      -->
      <div v-if="fading" class="kl-dots" aria-hidden="true">
        <i></i><i></i><i></i>
      </div>
      <div ref="levelHost" class="level-labels"></div>
      <!-- 右轴上的「现价」标签：库那枚关掉了（改不了底色 / 边框），自己画一个 -->
      <span ref="curEl" class="cur-label off"></span>
      <!--
        十字光标的轴标签（自己画的，见 `paintCrosshairTags`）：
        价格那枚里**装两行** —— 上面「离现价的百分比」、下面「触碰到的价」，
        两行在**同一个框**里（用户 2026-10-06：「y轴价格百分比和触碰的价格放在一个框内」）。
      -->
      <span ref="cxPriceEl" class="cx-tag cx-price off">
        <span ref="deltaEl" class="cx-d hidden"></span>
        <span ref="cxValEl" class="cx-v"></span>
      </span>
      <span ref="cxTimeEl" class="cx-tag cx-time off"></span>
      <!-- 左侧标签：仓位的盈亏、挂单的止盈/止损 + 预计收益 + 数量% -->
      <div ref="ordLabelHost" class="ord-labels"></div>
      <div ref="infoEl" class="chart-info"></div>

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

      <!-- 挂单读不到 / 只拿到快照时的提示（正常不渲染） -->
      <span v-if="ordNote" class="ord-note" :title="ordNote.title">{{
        ordNote.text
      }}</span>

      <!-- 指标开关（点一下显示 / 隐藏） -->
      <div ref="legendEl" class="legend">
        <span
          v-for="l in LEGEND"
          :key="l.key"
          :data-toggle="l.key"
          :class="{off: !VISIBLE[l.key]}"
          :title="l.tip"
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

    <!--
      拖动仓位线 / 挂单线松手后弹的确认单（用户 2026-10-06）——
      「止盈 / 止损 + 数量百分比」，**确认了才真发单**（走「配置 → 测试下单」那套）。
    -->
    <StopSheet
      :open="!!stopSheet"
      :name="stopSheet ? baseToName(stopSheet.drag.symbol) : ''"
      :side="stopSheet?.drag.side ?? 'long'"
      :price="stopSheet?.price ?? 0"
      :entry="stopSheet?.drag.entry ?? 0"
      :mark="stopSheet?.drag.mark ?? 0"
      :amount="stopSheet?.drag.amount ?? 0"
      :pct="stopSheet?.pct ?? 100"
      :order-id="stopSheet?.drag.orderId"
      :test-order="testOrder"
      :busy="stopBusy"
      @close="stopSheet = null"
      @confirm="submitStop"
    />
  </section>
</template>
