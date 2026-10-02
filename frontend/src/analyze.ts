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
import {computed, ref, watch} from 'vue'
import {
  analyzeStream,
  fetchAnalyses,
  type AnalysisRow,
  type AnalyzeResult,
  type AnalyzeStep
} from './api'
import {config, refreshConfig} from './store'
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
 * `KlineChart` 也用它（封口同一条常量，不然两边会漂）。
 * 2026-10-03 用户要求「图表默认显示 200 根」：从 300 降到 200（1h ≈ 8.3 天）。
 */
export const CHART_BARS = 200

/**
 * 主周期要看多少天 —— **不给用户填，就是图上那段**。
 *
 * 图上初次加载 `CHART_BARS` 根，换成天数交给后端（1h × 200 根 ≈ 8.33 天），
 * 后端再换回根数。其余周期看多少天由 `config/calibers.yaml` 决定。
 *
 * ⚠️ 先往下取到 3 位小数：后端的 `barsFor` 是 `ceil(天 × 每天根数)`，
 * 不截断的话 5m 会因为浮点误差多算出 1 根（200.00000000000003 → 201）。
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

/**
 * 左侧一级 tab：合约行情 / 实时分析 / 测试 / 历史分析 / 添加案例。
 *
 * 「合约行情」摆在最前面（用户 2026-10-03：在实时分析**左侧**加一格）——
 * 参考币安合约行情页：一眼扫全市场，点一行就切币。
 */
export const LEFT_TABS = [
  {value: 'market' as const, label: '合约行情'},
  {value: 'live' as const, label: '实时分析'},
  {value: 'test' as const, label: '测试'},
  {value: 'history' as const, label: '历史分析'},
  {value: 'add' as const, label: '添加案例'}
]
export type LeftTab = (typeof LEFT_TABS)[number]['value'] | 'chart'

/** 窄屏断点 —— 跟 CSS 里 ≤900px 那套对齐（手机上「K 线」是单独一格） */
export const MOBILE_MAX = 900

/**
 * 一级 tab 默认选哪一格 —— **宽屏窄屏都是「合约行情」**（用户 2026-10-03：
 * 移动端和 pc 都默认显示合约行情）。一进来先扫全市场，点一行就切币去看图。
 * 模块只初始化一次 —— 之后一律按用户自己选的记住。
 */
export const leftTab = ref<LeftTab>('market')

/**
 * 「K 线」这一格 —— **只在手机端**存在。
 *
 * 手机一屏放不下「图 + 分析」两块，所以让它跟实时分析 / 测试 / … 并排成一个 tab；
 * 桌面端图就常驻在右栏，再加一个「K 线」tab 是多余的（所以桌面端这个选项不渲染）。
 */
export const CHART_TAB = {value: 'chart' as const, label: 'K 线'}

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

/**
 * 「测试」现在是**左侧一级 tab**（2026-10-03 用户要求：查询栏那个实时/测试开关去掉）。
 * 选中它就等于「回到结束线那一刻跑一局」，结果不存档。
 */
export const testMode = computed(() => leftTab.value === 'test')

/**
 * 测试模式：**结束线**放在哪 —— 也就是「我看到哪一刻」。
 *
 * 只用一个时刻，**不划一段**：取数永远是「以这一刻为终点往前推 N 根」，
 * 划一段反而会让人以为 AI 只看那一段（其实只有结束那一刻参与取数）。
 *
 * 值 = 最后一根已收盘 K 线的**收尾时刻**（开盘时刻 + 一个周期），
 * 后端拿它当 `at`，`timestamp + step <= at` 正好把那一根算进最后一根。
 */
export const testPoint = ref<number | null>(null)

/** 是不是正等着我在图上点一下，把结束线放下去 */
export const pointPicking = ref(false)

export function setPointPicking(v: boolean): void {
  pointPicking.value = v
}

/** 清掉结束线（模板里不给导入的 ref 直接赋值） */
export function clearTestPoint(): void {
  testPoint.value = null
  pointPicking.value = false
}

/** 测试跑的「现在」= 结束线那一刻 */
export const testAt = computed(() => (testMode.value ? testPoint.value : null))

/** 结束线落在哪一根 K 线上（显示用：收尾时刻减一个周期就是那根的开盘时刻） */
export const testBarTime = computed(() =>
  testPoint.value === null
    ? null
    : testPoint.value - (TF_MS[chartTf.value] ?? 3_600_000)
)

/**
 * 切 tab 时顺手做两件事（就放这里，组件里不用再挂一个 watch）：
 *   1. **实时 ↔ 测试** 是两种跑法，切了就清掉上一局的结论，免得看成上一局的；
 *   2. 进「测试」就直接等我在图上点结束线（少按一次）；其它 tab 一律退出选线/拖动。
 */
watch(leftTab, (v, prev) => {
  const running = (x: LeftTab) => x === 'live' || x === 'test'
  if (running(v) && running(prev)) {
    result.value = null
    steps.value = []
    error.value = ''
  }
  pointPicking.value = v === 'test' && !testPoint.value
  if (v !== 'add') rangeDrawing.value = false
})

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
  if (testMode.value && !testPoint.value) {
    error.value = '测试模式：先在右边 K 线上点一根，定下「看到哪一刻」'
    return
  }

  symbol.value = s
  error.value = ''
  result.value = null
  steps.value = []
  // ⚠️ 这里**不能**动 leftTab：测试已经是左侧一级 tab 了（2026-10-03），
  // 一点「判断」就切回实时的话，testMode 立刻变 false、testAt 变 null ——
  // 测试跑会被当成实时跑存档（踩过：#100 就是这么来的）。
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
