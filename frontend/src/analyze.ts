/**
 * 开单分析的全局状态。
 *
 * 放模块作用域，不放组件的 `ref` —— 切到「预测历史 / 知识库 / 用量」再回来时
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
  type AnalyzeResult,
  type AnalyzeStep
} from './api'
import {prefetchCandles} from './candles'
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
  '1m': 60_000,
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
 * 一次到底拉多少根 —— 图上铺 200 根，再给 50 根余量（缩放时不用立刻又去拉）。
 *
 * ⚠️ `candles.ts` 的预取**必须用同一个数**：它那份 memo 的 key 里带 `limit`，
 *    差一根就成了另一个条目，预取和随后那发请求合并不上（白多一次往返）。
 *    （服务端对「最新 N 根」**不**把 limit 算进 key —— 同一份数据切一刀就行，
 *      所以真正要对齐的是前端这份 memo。）
 */
export const KLINE_BARS = CHART_BARS + 50

/**
 * 点某个币时先发一次请求（**只在真点击时**）。
 *
 * ⚠️ 2026-10-04 起**没有「空闲时批量预热」那套了**（见 `candles.ts` 顶部说明）：
 *    提前批量取只是把数据白传一遍（60 个币 × 250 根 ≈ 1.5MB）。
 *    2026-10-07 起服务端读 K 线是「内存 → 库 → REST」，这一发基本就是本地库读。
 */
export function prefetchSymbol(base: string): void {
  prefetchCandles(base, chartTf.value, KLINE_BARS)
}

/**
 * 主周期要看多少天 —— **不给用户填，就是图上那段**。
 *
 * 图上初次加载 `CHART_BARS` 根，换成天数交给后端（1h × 200 根 ≈ 8.33 天），
 * 后端再换回根数 —— **只有主周期这一个周期**（2026-10-11 起不再取其余周期）。
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
 * ⚠️ 2026-10-04 之后「合约行情」**只属于桌面端** —— 用户把合约行情提成了
 * 底栏单独一页（`/contracts`），手机端这一页就只剩「K 线 / 实时分析 / 历史分析 / 添加案例」；
 * 桌面端宽屏放得下，保持「左行情 + 右 K 线」不变（用户：「pc 端开单分析保持不变」）。
 *
 * ⚠️ 2026-10-06：「交易所账户移动到我的」—— 那一格整块搬去「我的」（`/me`），
 * 这里不再有它（组件是 `comps/ExchangeAccountLivePanel.vue`，落点见 `views/MeView.vue`）。
 */
export const LEFT_TABS = [
  {value: 'market' as const, label: '合约行情'},
  /*
   * ★ 2026-10-12 用户：「实时分析和预测历史合并改为预测结果」——
   *   原来「实时分析」和「预测历史」是并列两格，可它们看的是同一件事
   *   （一句话结论：上面是刚跑出来的，下面是以前跑过的）。现在合成一格：
   *   上面是本次的分析过程 + 结论卡，下面接预测历史列表。
   *
   * ⚠️ `value` 仍然是 `'live'`，不改 —— 老链接 `?t=live`、以及
   *    `leftTab === 'live'` 那一堆判断（含 `test` 共用同一套渲染）都不用动；
   *    老链接 `?t=history` 由 `AnalyzeView.readTab` 映射过来。
   */
  {value: 'live' as const, label: '预测结果'},
  /*
   * ⚠️ 2026-10-15 用户：「**PC 模式也改为跟手机端一样**」—— 桌面那格「测试」
   *    **整格删掉**，两端统一走 K 线头上那颗烧瓶（点开变 ✓ / ✗，见 `startTestMode`）。
   *    老书签 `?t=test` 由 `AnalyzeView.readTab` 映射到 `live`
   *   （`LeftTab` 里仍留着 `'test'`：`testMode` 的判据和老链接都要认它）。
   */
  /* 用户 2026-10-12：「新建一个页面叫自动化预测 在预测历史后面」 */
  {value: 'auto' as const, label: '自动化预测'},
  /*
   * 交易日记（用户 2026-10-18：「日记模块可以加入某些币种，总结」）。
   * 放在「自动化预测」后面 —— 用户选的就是「自动化预测旁边加一格」。
   * 表结构 / 月统计口径 / 缺口提示见 `docs/JOURNAL.md`。
   */
  {value: 'journal' as const, label: '日记'},
  {value: 'kb' as const, label: '知识库'},
  {value: 'add' as const, label: '添加案例'}
]
/**
 * 左侧一级 tab 的取值。
 *
 * ⚠️ `'test'` 是**遗留值**：2026-10-15 桌面那格「测试」tab 删掉了（PC 跟手机统一走
 * K 线头上那颗烧瓶图标），但 `testMode` 的判据（`testArmed || leftTab === 'test'`）、
 * 以及「老状态被收回来时把测试模式带走」那两处还要认它 —— 所以留在类型里，
 * 只是 `LEFT_TABS` 不再摆出来（老链接 `?t=test` 由 `readTab` 映射到 `live`）。
 */
export type LeftTab = (typeof LEFT_TABS)[number]['value'] | 'chart' | 'test'

/** 窄屏断点 —— 跟 CSS 里 ≤900px 那套对齐（手机上「K 线」是单独一格） */
export const MOBILE_MAX = 900

/**
 * 一级 tab 默认选哪一格 —— **按屏幕宽度定**（用户 2026-10-04）：
 * 桌面端停「合约行情」（左行情右 K 线，一进来先扫全市场）；
 * 手机端那一格已经搬去 `/contracts` 了，就停「K 线」。
 *
 * 模块只初始化一次 —— 之后一律按用户自己选的记住。
 */
export const leftTab = ref<LeftTab>(
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX
    ? 'chart'
    : 'market'
)

/**
 * 「K 线」这一格 —— **只在手机端**存在。
 *
 * 手机一屏放不下「图 + 分析」两块，所以让它跟实时分析 / 测试 / … 并排成一个 tab；
 * 桌面端图就常驻在右栏，再加一个「K 线」tab 是多余的（所以桌面端这个选项不渲染）。
 */
export const CHART_TAB = {value: 'chart' as const, label: 'K 线'}

/**
 * 从别的页「跳过来看图」时，地址栏该带什么 query。
 *
 * ★ 2026-10-13 用户：「点击跳转到 k 显示 tab 要自动切换为 k 线」——
 *   点持仓卡 / 合约行情里的一行，人想看的是**图**，可窄屏的图在「K 线」那一格，
 *   光跳 `/analyze` 会停在上一格（多半是「预测结果」），还得自己再点一下。
 *
 * ⚠️ 只有窄屏才带 `t=chart`：桌面端图常驻右栏、`chart` 压根不是合法 tab，
 *    带了反而把左栏（合约行情）弄空。
 */
export function chartQuery(): Record<string, string> {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX
    ? {t: CHART_TAB.value}
    : {}
}

/*
 * 2026-10-03：二级 tab（AI 结论 / 市场与周期）已按用户要求整块去掉 ——
 * 结论和「市场热度」现在直铺下来，不再切。所以 `LIVE_TABS` / `liveTab` 两个导出都删了。
 */

/**
 * 分析过程：跑的时候展开，出结论后收成一行，点一下还能展开。
 *
 * ★ 2026-10-13 用户：「预测结果 分析过程默认放在一个按钮图标里，可以打开缩进去」
 *   ⇒ 初值改 `false`（一进来只有一颗小按钮，不再是占掉半屏的面板）；
 *   `run()` 里照旧置 `true`（跑的时候得看得见进度），`onDone` 照旧置 `false`（跑完自动收起来）。
 *
 * ⚠️ 这个开关**只管过程**（`StepsPanel`）。结论卡有自己的一颗 `showResult` ——
 *    用户同一天先要「过程在结果出来后折叠 + 分析完成后不收起」，接着又要
 *    「结论也可收起」，两块就彻底分开了，别再合成一个变量。
 */
export const showSteps = ref(false)

/**
 * 分析结论：出结果就摊开（用户 2026-10-13：「分析完成后不收起」），想腾地方自己收。
 *
 * ★ 同一天用户又补一句「结论也可收起」⇒ 结论卡自己带一颗折叠按钮，
 *   收起后只剩一行「分析结论 + 判定那句话」（见 `AnalyzeView` 的 `.result-toggle`）。
 *   初值 `true`：没有结论时这张卡压根不渲染，一有结论就是展开的。
 */
export const showResult = ref(true)

/* ---------------- 跑一次分析 ---------------- */

let closeStream: (() => void) | null = null

export function stopRun(): void {
  closeStream?.()
  closeStream = null
  loading.value = false
}

/**
 * 上一次跑的是**哪一刻**（`testAt` 的值；`null` = 还没跑过 / 实时跑）。
 *
 * 只给 `confirmTestPoint` 用：同一个结束线点两次 ✓ 不该白烧两次模型调用。
 * 不做成 ref —— 界面上没有任何地方要显示它（显示的是结果本身）。
 */
let lastRunAt: number | null = null

/* ---------------- 测试模式：回到过去某一刻 ---------------- */

/**
 * 现在还是不是窄屏（断点跟 CSS 那套 ≤900px 对齐）。
 *
 * ⚠️ 一次性判断，**不是响应式的**（`AnalyzeView` 自己那份 `isMobile` 才是）——
 * 这里只用来决定「点一下要不要切格」，不需要跟着窗口变。
 */
export function isNarrow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX
}

/**
 * 「我确实在测试模式里」——**不靠 `leftTab` 也能撑住这个状态**。
 *
 * 用户 2026-10-15：「移动端开单分析的测试功能加上，配置旁加上测试的图标，
 * 选择线后跳转预测结果」——
 *   · 窄屏**没有「测试」那一格 tab**（tab 行 4 格 + 模型余额刚好铺满，摆不下第 5 格），
 *     所以测试模式改从 **K 线头上那颗测试图标**进；
 *   · 窄屏的图只在自己那一格（`.split.m-chart`），选线就得先切到「K 线」；
 *     选完再切回「预测结果」看结论 —— 一进一出，`leftTab` 都不再是 `test`。
 * 这个状态就是用来兜住那种情况的：只要它开着，切到哪儿都还是测试跑
 *（`testAt` 不会变 null）——否则**测试跑会被当成实时跑存进库里**（踩过，见 `run()`）。
 */
export const testArmed = ref(false)

/**
 * 测试模式 = **「测试」那一格**（宽屏那格 tab，2026-10-03 定的）**或** 图标打开的那个状态。
 * 进去就等于「回到结束线那一刻跑一局」，结果不存档。
 */
export const testMode = computed(
  () => testArmed.value || leftTab.value === 'test'
)

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

/**
 * 这一格能不能看到图 —— 窄屏只有「K 线」/「测试」两格有图（见 `style.css` 的 `.split.m-*`），
 * 宽屏图常驻右栏、每一格都有。选线得在图上看，看不到图就不该停在「等着你点」那个状态。
 */
function chartVisible(t: LeftTab): boolean {
  return !isNarrow() || t === 'chart' || t === 'test'
}

export function setPointPicking(v: boolean): void {
  pointPicking.value = v
  /*
   * 窄屏：点「重选」的时候人正停在「预测结果」那一格，图在隔壁「K 线」里 ——
   * 不切过去就成了「让我点一根，可图在哪儿」。宽屏图常驻，不动。
   */
  if (v && !chartVisible(leftTab.value)) leftTab.value = 'chart'
}

/**
 * **进**测试模式（K 线头上那颗烧瓶图标点一下）。
 *
 * ★ 2026-10-15 用户重做：「点击测试图标**消掉，变成勾和叉**」——
 *   烧瓶不再是「开关」，点它就**消失**、原位换成 ✓ / ✗ 两颗（见 `AnalyzeView`）：
 *     · ✓ = 结束线定好了，跳去「预测结果」（`confirmTestPoint`）；
 *     · ✗ = 关掉（`exitTestMode`）。
 *   进来顺手把「选结束线」打开：点这颗图标本来就是「我要在图上点一根」。
 *   窄屏图只在自己那一格，`setPointPicking` 会先把人切到「K 线」。
 */
export function startTestMode(): void {
  testArmed.value = true
  setPointPicking(true)
}

/**
 * **出**测试模式（✓/✗ 里那个 ✗：「点击 ✗ 关掉」）。
 *
 * 关掉就是**真的关掉**：测试模式停掉 + 结束线一起清 —— 不然线赖在图上
 *（用户 2026-10-15 早先报过「取消后线还赖在图上」）。
 * 人还杵在宽屏「测试」那一格时顺手切回「预测结果」：那格里测试和预测结果是同一套渲染，
 * 不切过去看不出已经退出了。
 */
export function exitTestMode(): void {
  testArmed.value = false
  testPoint.value = null
  pointPicking.value = false
  if (leftTab.value === 'test') leftTab.value = 'live'
}

/**
 * **✓**：结束线定好了 ⇒ 切到「预测结果」**并当场把这一局跑起来**。
 *
 * ⚠️ 线是在**图上**点的：窄屏点完还杵在「K 线」那一格，不跳过去就跟没反应一样
 *    （上一版是「点完自动跳」，2026-10-15 用户改成**点 ✓ 才跳**）。
 *
 * ★ 为什么还顺手 `run()`：2026-10-15 用户实测后说「**点击✓跳转页面没有显示分析结果，有问题**」——
 *   只切格的话，落过去是一片空的（还得自己再点一下「按这段行情判断」）。所以 ✓ = 去分析：
 *   跳过去 + 立刻开跑，过程和结论都在那儿。
 *   两条不重复烧钱的规矩：
 *     · **正在跑**就不打断（`loading`）；
 *     · **同一个结束线**刚跑过（结果还在屏幕上）也不重跑 —— `lastRunAt` 记着上一次跑的是哪一刻。
 */
export function confirmTestPoint(): void {
  if (testPoint.value === null) return
  leftTab.value = 'live'
  if (!loading.value && lastRunAt !== testAt.value) run()
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
 *   2. 进「测试」就直接等我在图上点结束线（少按一次）；图上点不到的那些格
 *      （窄屏「预测结果 / 知识库」…）一律退出选线 —— 让人「点一根」却看不见图，
 *      那是死路。测试模式本身不跟着 tab 走（见 `testArmed`）。
 */
watch(leftTab, (v, prev) => {
  const running = (x: LeftTab) => x === 'live' || x === 'test'
  if (running(v) && running(prev)) {
    result.value = null
    steps.value = []
    error.value = ''
  }
  /*
   * ⚠️ 这里**不能**每次都重算选线状态：窄屏点「重选」是先把选线打开、**再**切到
   *    「K 线」那一格（见 `setPointPicking`），无条件重算会被这次切格自己抹掉 ——
   *    人落到图上，却还是「没在选线」（踩过）。所以只在两种该变的地方动手。
   */
  if (v === 'test' && !testPoint.value) pointPicking.value = true
  else if (!chartVisible(v)) pointPicking.value = false
  if (v !== 'add') rangeDrawing.value = false
})

/** 换币种：清掉上一只币的结论 */
export function pickSymbol(v: string): void {
  symbol.value = v
  result.value = null
  steps.value = []
  error.value = ''
}

export function run(): void {
  const s = symbol.value.trim().toUpperCase()
  if (!s) {
    error.value = '请先选择币种'
    return
  }
  if (loading.value) return
  if (testMode.value && !testPoint.value) {
    error.value = '测试模式：先在 K 线上点一根，定下「看到哪一刻」'
    return
  }

  symbol.value = s
  error.value = ''
  result.value = null
  steps.value = []
  // ⚠️ 这里**不能**动 leftTab：测试已经是左侧一级 tab 了（2026-10-03），
  // 一点「判断」就切回实时的话，testMode 立刻变 false、testAt 变 null ——
  // 测试跑会被当成实时跑存档（踩过：#100 就是这么来的）。
  showSteps.value = true
  loading.value = true

  const at = testAt.value
  /* 记下「这一跑看的是哪一刻」—— ✓ 拿它判「同一个结束线要不要重跑」（见 `confirmTestPoint`） */
  lastRunAt = at

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
        // 结论出来了就把过程让开位置，需要看就点那一行展开；结论本身摊开
        showSteps.value = false
        showResult.value = true
        stopRun()
        void refreshConfig()
      },
      onError(msg) {
        error.value = msg
        failRunning(steps.value, msg)
        stopRun()
      }
    }
  )
}
