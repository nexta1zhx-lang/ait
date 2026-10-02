/**
 * 开单分析的全局状态。
 *
 * 放模块作用域，不放组件的 `ref` —— 切到「历史 / 知识库 / 用量」再回来时
 * 组件会重新挂载，局部 ref 就没了，结论会被「刷新掉」。
 * 这里保证：
 *   · 结论、分析过程、报错都留着
 *   · 分析跑到一半切走也不中断，回来直接看到结果
 *   · 币种、二级 tab 的选择也留着
 *
 * 派生出来的字段（判档文案、热度行…）仍然留在组件里现算 —— 它们只是
 * 从这些状态推出来的，重新挂载时自然就是对的。
 */
import {computed, ref} from 'vue'
import {
  analyzeStream,
  fetchAnalyses,
  type AnalysisRow,
  type AnalyzeResult,
  type AnalyzeStep
} from './api'
import {config, refreshConfig} from './store'
import {bjInputValue} from './format'
import {failRunning, mergeStep} from './steps'

/* ---------------- 输入 ---------------- */

export const symbol = ref('BTC')
export const chartTf = ref('1h')

/**
 * K 线图从哪一刻开始画（'YYYY-MM-DDTHH:mm'，北京时间；空 = 画最近的）。
 *
 * 只决定「画哪一段」，**不影响 AI 判断用的数据** —— 判断永远用当下行情。
 * 一次拉多少根是内部策略，界面上不体现。
 */
export const chartFrom = ref('')

/**
 * 我在 K 线图上画出来的范围（毫秒时间戳）。
 *
 * 只在「添加案例」tab 用得上：画哪一段就提炼哪一段，
 * 这时候跟 `chartFrom`（从哪一刻开始画到最新）是两码事。
 */
export interface ChartRange {
  from: number
  to: number
  /** 这个范围里有多少根 K 线 */
  bars: number
}
export const chartRange = ref<ChartRange | null>(null)

/**
 * 是不是正等着我在 K 线上拖一段。
 *
 * 按钮在左边「添加案例」的时间那一行（`CollectForm`），
 * 状态放这儿是为了两边都能读 —— 左边显示「在图上拖一段…」，右边进拖动模式。
 */
export const rangeDrawing = ref(false)

/**
 * 画范围时不会切图的显示 —— 范围只是给「添加案例」用的，
 * 图上看哪一段时间不受影响。
 */
export function clearChartRange(): void {
  chartRange.value = null
  rangeDrawing.value = false
}

/** 周期由后端配置决定，页面上不让用户填 */
export const timeframesText = computed(
  () => config.value?.timeframes ?? '15m,1h,4h,1d'
)

/** 一个周期的长度（毫秒）—— 换算「图上这一段有多少天」用 */
const TF_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
}

/**
 * 图上初次加载多少根 K 线 —— **AI 看的主周期就是这一段**。
 *
 * `KlineChart` 也用它（零封口同一条常量，不然两边会漂）。
 */
export const CHART_BARS = 300

/**
 * 主周期要看多少天 —— **不给用户填，就是图上那段**。
 *
 * 图上初次加载 `CHART_BARS` 根，换成天数交给后端（1h × 300 根 = 12.5 天），
 * 后端再换回根数。其余周期看多少天由 `config/calibers.yaml` 决定。
 *
 * ⚠️ 先往下取到 3 位小数：后端的 `barsFor` 是 `ceil(天 × 每天根数)`，
 * 不截断的话 5m 会因为浮点误差多算出 1 根（300.00000000000006 → 301）。
 */
export const lookbackDays = computed(() =>
  Math.max(
    1,
    Math.floor(
      ((CHART_BARS * (TF_MS[chartTf.value] ?? 3_600_000)) / 86_400_000) * 1000
    ) / 1000
  )
)

/** 图上那段说人话（给提示文案用）：12.5 天 / 3.13 天 */
export const spanText = computed(
  () => `${Number(lookbackDays.value.toFixed(2))} 天`
)

/* ---------------- 结果 ---------------- */

export const result = ref<AnalyzeResult | null>(null)
/** 分析过程：后端用 SSE 一步步推过来 */
export const steps = ref<AnalyzeStep[]>([])
export const loading = ref(false)
export const error = ref('')

/* ---------------- tab ---------------- */

/** 左侧一级 tab：实时分析 / 历史分析 / 添加案例 */
export const LEFT_TABS = [
  {value: 'live' as const, label: '实时分析'},
  {value: 'history' as const, label: '历史分析'},
  {value: 'add' as const, label: '添加案例'}
]
export const leftTab = ref<'live' | 'history' | 'add'>('live')

/** 实时分析内部的二级 tab（大简化后只剩两个） */
export const LIVE_TABS = [
  {value: 'verdict' as const, label: 'AI 结论'},
  {value: 'market' as const, label: '市场与周期'}
]
export const liveTab = ref<'verdict' | 'market'>('verdict')

/** 分析过程：跑的时候展开，出结论后收成一行，点一下还能展开 */
export const showSteps = ref(true)

/* ---------------- 该币种的历史分析 ---------------- */

/** 每页条数的兜底值 —— 真实的条数按左栏高度自适应，见 setHistoryPageSize */
export const HISTORY_LIMIT = 12
/** 一页最少 / 最多几条，兜住极端窗口高度 */
export const HISTORY_MIN = 4
export const HISTORY_MAX = 60

export const history = ref<AnalysisRow[]>([])
export const historyTotal = ref(0)
export const historyError = ref('')
/** 当前第几页（从 1 开始） */
export const historyPage = ref(1)
/** 当前每页几条 —— 由左栏能放下几行算出来 */
export const historyPageSize = ref(HISTORY_LIMIT)

/** 一共几页 */
export const historyPages = computed(() =>
  Math.max(1, Math.ceil(historyTotal.value / historyPageSize.value))
)
/** 当前页从第几条开始 */
const historyOffset = computed(
  () => (historyPage.value - 1) * historyPageSize.value
)

/** 已经拉过哪一页（`币种@偏移@条数`），避免回页面时重复请求 */
let historyKey = ''

export async function loadHistory(sym: string, force = false): Promise<void> {
  const s = sym.trim().toUpperCase()
  if (!s) return
  const offset = historyOffset.value
  const key = `${s}@${offset}@${historyPageSize.value}`
  if (!force && historyKey === key) return
  historyError.value = ''
  try {
    const page = await fetchAnalyses({
      symbol: s,
      grade: '',
      verdict: '',
      tag: '',
      actionable: false,
      days: 3650,
      limit: historyPageSize.value,
      offset
    })
    history.value = page.rows
    historyTotal.value = page.total
    historyKey = key
  } catch (e) {
    historyError.value = (e as Error).message
    history.value = []
    historyTotal.value = 0
  }
}

/** 换币种 → 回到第 1 页（否则会停在上一只币翻到的页码上） */
export function resetHistoryPaging(): void {
  historyPage.value = 1
  historyKey = ''
}

/**
 * 左栏高度变了（窗口缩放 / 换 tab）→ 重新算一页该放几条。
 * 目标是刚好装满可视区，列表自己不出现滚动条。
 */
export function setHistoryPageSize(n: number): void {
  const size = Math.max(
    HISTORY_MIN,
    Math.min(HISTORY_MAX, Math.floor(n) || HISTORY_MIN)
  )
  if (size === historyPageSize.value) return
  // 尽量停在原来那条记录上，而不是粗暴地跳回第 1 页
  const firstRow = (historyPage.value - 1) * historyPageSize.value
  historyPageSize.value = size
  historyPage.value = Math.floor(firstRow / size) + 1
  historyKey = ''
  if (symbol.value.trim()) void loadHistory(symbol.value, true)
}

/** 翻页：delta = -1 上一页 / +1 下一页 */
export async function historyGo(delta: number): Promise<void> {
  const next = historyPage.value + delta
  if (next < 1 || next > historyPages.value) return
  historyPage.value = next
  await loadHistory(symbol.value, true)
}

/** 回到第 1 页（跑完一次新分析后，新记录在最前面） */
export async function historyFirstPage(sym: string): Promise<void> {
  historyPage.value = 1
  await loadHistory(sym, true)
}

/* ---------------- 跑一次分析 ---------------- */

let closeStream: (() => void) | null = null

export function stopRun(): void {
  closeStream?.()
  closeStream = null
  loading.value = false
}

/* ---------------- 测试模式：回到过去某一刻 ---------------- */

/** 跑哪种：实时（看当下）/ 测试（回到我圈出来的那一段） */
export const RUN_MODES = [
  {
    value: 'live' as const,
    label: '实时',
    title: '用当下最新的行情判断，结果会存档'
  },
  {
    value: 'test' as const,
    label: '测试',
    title:
      '回到我在图上圈出来的那一段去看「当时」：只看那一刻之前已收盘的 K 线，资金费率/持仓量留空，结果不存档'
  }
]
export const runMode = ref<'live' | 'test'>('live')
export const testMode = computed(() => runMode.value === 'test')

/**
 * 测试跑的「那一刻」= 我在图上圈出来那一段（`chartRange`）的**结束时刻**。
 *
 * 段本身就是复用「添加案例」那套圈选：同一段 K 线，一个用来提炼经验、
 * 一个用来当「当时」—— 所以不另开一份状态，免得两个 tab 各记一段互相打架。
 */
export const testAt = computed(() =>
  testMode.value ? (chartRange.value?.to ?? null) : null
)

/** K 线图要画到哪一刻：测试模式固定在那一小段的结尾，否则画到最新 */
export const chartUntil = computed(() =>
  testMode.value && chartRange.value ? bjInputValue(chartRange.value.to) : ''
)

/** 切实时 / 测试：把上一次的结论清掉，免得看成上一局的 */
export function setRunMode(v: 'live' | 'test'): void {
  if (v === runMode.value) return
  runMode.value = v
  result.value = null
  steps.value = []
  error.value = ''
  if (v === 'test') {
    // 跟「添加案例」一样：进了这个模式就直接等着我在图上拖，少点一下
    if (!chartRange.value) rangeDrawing.value = true
  } else {
    rangeDrawing.value = false
  }
}

/** 换币种：清掉上一只币的结论，历史由 loader 重拉（并回到第 1 页） */
export function pickSymbol(v: string): void {
  symbol.value = v
  result.value = null
  steps.value = []
  error.value = ''
  resetHistoryPaging()
  void loadHistory(v)
}

export function run(): void {
  const s = symbol.value.trim().toUpperCase()
  if (!s) {
    error.value = '请先选择币种'
    return
  }
  if (loading.value) return
  if (testMode.value && !chartRange.value) {
    error.value = '测试模式：先用「画范围」在右边 K 线上拖一段'
    return
  }

  symbol.value = s
  error.value = ''
  result.value = null
  steps.value = []
  leftTab.value = 'live'
  liveTab.value = 'verdict'
  showSteps.value = true
  loading.value = true

  const at = testAt.value

  closeStream = analyzeStream(
    s,
    {days: lookbackDays.value, timeframe: chartTf.value, at},
    {
      onStep(step) {
        mergeStep(steps.value, step)
      },
      onDone(r) {
        // 后端给的 steps 是完整终态，直接覆盖，免得漏掉最后几步的耗时
        if (r.steps?.length) steps.value = r.steps
        result.value = r
        // 结论出来了就把过程让开位置，需要看就点那一行展开
        showSteps.value = false
        stopRun()
        void refreshConfig()
        // 新记录排在最前面 —— 顺手回到第 1 页，否则停在旧页看不到它。
        // 测试跑不存档，也就没有新记录可看
        if (!at) void historyFirstPage(s)
      },
      onError(msg) {
        error.value = msg
        failRunning(steps.value, msg)
        stopRun()
      }
    }
  )
}
