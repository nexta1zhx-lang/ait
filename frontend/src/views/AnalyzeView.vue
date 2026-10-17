<script setup lang="ts">
/*
 * 组件名要钉死：`App.vue` 的 `<KeepAlive :include="['AnalyzeView','ContractsView']">`
 * 是按**组件名**匹配的，而名字对不上会**静默失效**（整页都不再缓存，看不出错）——
 * 不靠文件名推断，写死在这里。
 */
defineOptions({name: 'AnalyzeView'})

import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch
} from 'vue'
import {RouterLink, useRoute, useRouter} from 'vue-router'
import SymbolCombo from '../comps/SymbolCombo.vue'
import MarketPanel from '../comps/MarketPanel.vue'
import KlineChart from '../comps/KlineChart.vue'
import SettingsSheet from '../comps/SettingsSheet.vue'
import PersistSheet from '../comps/PersistSheet.vue'
import MarginRateBadge from '../comps/MarginRateBadge.vue'
import SegTabs from '../comps/SegTabs.vue'
import CollectForm from '../comps/CollectForm.vue'
import TickerHead from '../comps/TickerHead.vue'
import OrderPanel from '../comps/OrderPanel.vue'
import HistoryView from './HistoryView.vue'
import JournalView from './JournalView.vue'
import AutoPredictView from './AutoPredictView.vue'
import {
  ensurePins,
  isPinnedBase,
  maxPinnedBases,
  toggleFavorite
} from '../pins'
import {
  blacklistHours,
  ensureBlacklist,
  lockCurrentBase,
  lockLeftMs
} from '../blacklist'
import {askConfirm} from '../confirm'
import {showToast} from '../toast'
import {activeSessionOf, bindPersist, leftText} from '../persist'
import {collectStream} from '../api'
import {useScrollMemory} from '../scroll'
import {useSwipeTabs} from '../swipe-tabs'
import {
  CHART_TAB,
  LEFT_TABS,
  type LeftTab,
  MOBILE_MAX,
  autoTab,
  chartFrom,
  chartRange,
  chartTf,
  clearChartRange,
  confirmTestPoint,
  error,
  exitTestMode,
  leftTab,
  loading,
  pickSymbol,
  pointPicking,
  prefetchSymbol,
  rangeDrawing,
  run,
  setPointPicking,
  startTestMode,
  symbol,
  testArmed,
  testBarTime,
  testMode,
  testPoint
} from '../analyze'
import {
  balanceBadge,
  contracts,
  refreshBalance,
  refreshConfig,
  refreshingBalance
} from '../store'
import {nowTick, stopTicker, watchTicker} from '../ticker'
import {bjShort, bjTime} from '../format'

// 结论、分析过程、报错都在 ../analyze 的模块作用域里，
// 切到别的页面再回来不会丢。
onMounted(() =>
  void ensurePins().catch(e =>
    showToast(`读取收藏失败：${(e as Error).message}`, 'bad')
  )
)
/*
 * 持久化分析（2026-10-15 用户：「在 k 线界面顶部加入持久化分析的图标」）。
 * 页面开着时每 30 秒拉一次会话列表（后端才是真正每 15 分钟跑的那个），
 * 结论跨档时 store 里会弹一条站内提示 —— 这里只负责订阅和收尾。
 */
const persistOpen = ref(false)
/** 当前这个币正在跑的持久化会话（null = 没加入）—— 图标染色靠它 */
const persistNow = computed(() => activeSessionOf(symbol.value))
let unbindPersist: (() => void) | null = null
onMounted(() => {
  unbindPersist = bindPersist()
})
onBeforeUnmount(() => {
  unbindPersist?.()
  unbindPersist = null
})
/* 黑名单也拉一次（那颗小锁的禁用态 + 右侧倒计时都靠它；拉不到就交给后端拦下单） */
onMounted(() =>
  void ensureBlacklist().catch(() => {
    /* 拉不到不打扰：这只是显示用，真下单后端还会拦一道 */
  })
)

/*
 * 顶部行情条 / 底部涨幅：跟着币种走，进来就拉、换币立刻重拉。
 * ⚠️ 只有这个页面看得到它，所以离开就把定时器停掉 —— 别在后台一直打交易所。
 */
watch(symbol, s => watchTicker(s), {immediate: true})
onBeforeUnmount(stopTicker)
onMounted(() => window.addEventListener('resize', onViewport))
onBeforeUnmount(() => window.removeEventListener('resize', onViewport))

/**
 * 手机端（≤900px）：一级 tab = **K 线 / 预测结果 / 自动化预测 / 知识库**。
 *
 * 窄屏放不下「左分析 + 右 K 线」两栏；而 K 线那块现在头顶行情条、脚下涨幅行，
 * 自己就是一整屏 —— 所以手机上它自己占一格，不再另开一排开关。
 *
 * 「测试 / 添加案例」那两格在手机端**不摆出来**：这两件都要在图上看点 / 拖，
 * 一屏放不下就来回切，反倒没法用（添加案例挪到 K 线那格的「＋」里去了）。
 * 但**测试本身在手机上是能用的**（用户 2026-10-15：「移动端开单分析的测试功能加上」）——
 * 入口改成 K 线头上、**配置左边那颗测试图标**，走的是「选结束线 → 跳预测结果」那条：
 *   · 点图标 ⇒ 进测试模式 + 开始等着点线；窄屏的图只在自己那一格，所以先切到「K 线」；
 *   · 在图上点一根 ⇒ 自动切回「预测结果」（那儿有结束线、判断按钮和结论）；
 *   · 「清掉」= 退出测试模式（窄屏从「预测结果」里看不到那颗图标，得留一条退路）。
 * tab 行摆不下第 5 格：390px 宽下 4 格 + 模型余额刚好铺满（实测 seg 274 + 余额 75 ≈ 362）。
 *
 * 桌面端图常驻右栏，这几格照旧（那颗测试图标桌面上也在，跟「测试」那格等价）。
 * 断点 `MOBILE_MAX` 跟 CSS 里那套对齐，定义在 `../analyze`（默认选中哪一格也在那儿）。
 */
const isMobile = ref(window.innerWidth <= MOBILE_MAX)

/**
 * 窄屏不摆的那几格（都要在图上看点 / 拖，一屏放不下）。
 *
 * ⚠️ `test`（桌面那格「测试」tab）2026-10-15 已从 `LEFT_TABS` 里删掉 ——
 *    留在这儿只是**兜住老状态**（本地记住的 tab / 老链接可能还是 `test`）：
 *    宽 → 窄 切过来时照样把 `testArmed` 带走并落到「K 线」，别让那一局变成实时跑。
 */
const MOBILE_HIDDEN_TABS: string[] = ['test', 'add']

/** 跑分析那颗按钮的文案（桌面 / 手机两处按钮共用一个，不会写漂） */
const runLabel = computed(() =>
  loading.value ? '分析中…' : testMode.value ? '按这段行情判断' : '分析'
)

/* ---------------- 窄屏那颗「分析」闪电：钉在周期行最右侧 ---------------- */

/*
 * ⚠️ 这里原来挂着整套「拖着走 + 位置存 localStorage」的实现
 *（用户 2026-10-04：「移动端闪电图标位置可以自由移动固定 保存位置」）。
 * 2026-10-05 用户改口：「闪电图标**固定**在选择周期一行最右侧」——
 * 于是整套拖拽（`runEl` / `runSlot` / `runPos` / `runStyle` / `syncRunPos` /
 * `clampRunPos` / `onRunDown` / `onRunMove` / `onRunUp` / `onRunTap` /
 * `RUN_DRAG_MIN` / `RUN_EDGE`）连同 `settings.ts` 里的 `runBtnPos` 一起删了，
 * 按钮改成老老实实待在周期行（`KlineChart` 的 `#head-end` 插槽）里。
 *
 * 位置也不用再记：它现在是文档流里的一个格子，窗口怎么变都自己跟着走。
 * 「固定」这个诉求靠 CSS 完成 —— 跟桌面上那颗「分析」同一个插槽、同一行。
 */

/**
 * ⚠️ 用 `resize` + `innerWidth` 判断，别用 `matchMedia` 的 change ——
 * 那个事件在部分环境（实测内置浏览器）根本不触发，拖宽了「K 线」还赖在 tab 行里。
 */
function onViewport(): void {
  const m = window.innerWidth <= MOBILE_MAX
  // 宽窄没变：什么都不用做（那颗闪电现在是文档流里的格子，自己会跟着走）
  if (m === isMobile.value) return
  isMobile.value = m
  /*
   * 宽窄切换时把「对方不存在的那一格」收回来：
   * 「K 线」只在窄屏有，「合约行情」只在宽屏有（2026-10-04 提成单独一页了），
   * 「添加案例」反过来只有宽屏有（窄屏走 K 线头上那颗 ＋）。
   * ⚠️ `test` 那格 2026-10-15 已整格删掉（PC 跟手机统一走烧瓶图标）——
   *    这里认它只是为了兜老状态：被收回来时把**测试模式**转成 `testArmed` 带走，
   *    不然光切个窗口宽度，下一局就从「测试（不存档）」变成「实时（存档）」了。
   */
  if (!m && leftTab.value === 'chart') leftTab.value = 'market'
  if (
    m &&
    (leftTab.value === 'market' || MOBILE_HIDDEN_TABS.includes(leftTab.value))
  ) {
    if (leftTab.value === 'test') testArmed.value = true
    leftTab.value = 'chart'
  }
}

/**
 * 窄屏的 tab：「K 线」排第一个（它也是默认落的那一格），
 * 后面跟宽屏那套去掉「合约行情 / 添加案例」。
 *
 * ⚠️ 「合约行情」已经搬去底栏的「合约」页（用户 2026-10-04），窄屏不再摆。
 * ⚠️ 2026-10-15 起两端的 tab 几乎一样了 —— 「测试」那格删掉之后，
 *    窄屏只多一格「K 线」、少一格「添加案例」（那件事窄屏走图上的 ＋）。
 */
const tabs = computed(() => {
  if (!isMobile.value) return LEFT_TABS
  const rest = LEFT_TABS.filter(
    t => t.value !== 'market' && !MOBILE_HIDDEN_TABS.includes(t.value)
  )
  return [CHART_TAB, ...rest]
})

/* ---------------- 左栏 tab 记进地址栏（`?t=`） ---------------- */

/*
 * 为什么要有它：2026-10-10 把「预测历史 / 知识库」从「我的 → 复盘」挪进这一页，
 * 那两边原本都是靠 URL 定位的（`/history`、`/knowledge`、`/me?p=replay&r=kb`），
 * 老书签 / 老链接由 `router.ts` 转成 `/analyze?t=…` —— 这里负责认这个 `t`。
 * 反过来用户换 tab 时写回地址栏，刷新 / 分享 / 返回键都能落回同一格。
 */
const route = useRoute()
const router = useRouter()

/**
 * `?t=` 的取值：`chart` 是窄屏专属那格，其余在 `LEFT_TABS` 里。
 *
 * ⚠️ `history` / `live` / `test` 都是**老值**：
 *   · `history`（2026-10-12 之前「预测历史」是独立一格）、
 *   · `live`（原一级 tab「预测结果」）、
 *   · `test`（2026-10-15 之前桌面端那格「测试」）——
 *   2026-10-18 起它们都落到「预测分析 → AI分析」那一内层格（老书签 / 老链接不能白屏）。
 */
function readTab(v: unknown): LeftTab | null {
  if (v === 'chart') return 'chart'
  if (v === 'history' || v === 'live' || v === 'test') {
    autoTab.value = 'live'
    return 'auto'
  }
  return LEFT_TABS.some(t => t.value === v) ? (v as LeftTab) : null
}

/** 只写 `?t=`，其余 query（`?id=` 抽屉、`?symbol=` 筛选）原样留着 */
function writeTab(v: LeftTab): void {
  if (route.query.t === v) return
  const q: Record<string, string> = {}
  for (const [k, val] of Object.entries(route.query)) {
    if (typeof val === 'string') q[k] = val
  }
  q.t = v
  void router.replace({query: q})
}

// 挂在 `watch` 上而不是只读一次：这一页是**缓存的**（`KeepAlive`），
// 老链接进来时组件早就挂着了 —— 只读一次的话 query 变了 tab 不动。
watch(
  () => route.query.t,
  v => {
    const t = readTab(v)
    if (t && t !== leftTab.value) leftTab.value = t
  },
  {immediate: true}
)

// 用户自己换 tab（点 tab 行 / 窄屏左右滑）→ 写回地址栏
watch(leftTab, v => writeTab(v))

/* ---------------- 窄屏：左右滑动切换一级 tab ---------------- */

/**
 * 手势区 = **整个 `.split`**（左栏 tab 行 + 内容，含窄屏「K 线」那格的右栏）。
 *
 * ⚠️ 以前挂在左边 `.col` 上，那是错的：切到窄屏「K 线」时图在右栏 `.col.side` 里，
 *    `.col` 只剩 tab 行那 **40px**，屏幕从上扫到下都落不进手势区 —— 所以当时干脆
 *    把「K 线」那一格**整格关掉**了滑动。用户 2026-10-05：
 *    「应该是除了 k 线图 其余位置都能滑动切换」。
 *
 * 现在挂到 `.split`（含右栏），只把两处**自己吃横向手势**的排除掉：
 *   ① 图表本体（`KlineChart` 的 `.chart-wrap`）—— 图上横划是拖动图表看历史行情；
 *   ② 下单模块（`OrderPanel` 的 `.ord`）—— 横划是切它自己的「开单 / 仓位」
 *      （用户 2026-10-06：「底部开单和仓位可滑动切换，注意不要滑动切换一级 tab 了」）。
 * 其余位置（tab 行 / 行情条 / 周期行 / 图下工具行）都能滑动切 tab。
 *
 * 用户 2026-10-04：「一级 tab（底下一小段线那种）可滑动切换」。
 * 调参与避让规则都在 `../swipe-tabs`，这里只负责接线。
 */
const swipeRef = ref<HTMLElement | null>(null)
const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeTabs<LeftTab>({
  host: () => swipeRef.value,
  list: () => tabs.value,
  current: () => leftTab.value,
  set: v => {
    leftTab.value = v
  },
  // 只有窄屏铺开手势；桌面端一点不受影响（跟 CSS 的 ≤900px 对齐）
  enabled: () => isMobile.value
})

/**
 * 切 tab 时给内容来一下「滑入」。
 *
 * 用户 2026-10-05：「滑动切换太生硬，能否平滑切换类似桌面滑动效果」。
 * 方向跟着 tab 顺序走 —— **往后翻 = 新内容从右边滑进来**（跟滑动 / 翻页同一个方向）。
 *
 * ⚠️ 只挂 260ms 的临时类：动画播完就摘掉。理由有两个：
 *   ① 不摘的话同一个方向连划两次，class 值不变，动画不会重播；
 *   ② `transform` 长期存在会变成 `fixed` 后代的「包含块」——
 *      K 线那颗可拖的闪电按钮（窄屏 `position: fixed`）会被带歪。
 */
const paneAnim = ref<'' | 'l' | 'r'>('')
let paneAnimTimer: number | null = null
watch(leftTab, (nv, ov) => {
  const i = tabs.value.findIndex(t => t.value === nv)
  const j = tabs.value.findIndex(t => t.value === ov)
  if (i < 0 || j < 0 || i === j) return
  paneAnim.value = i > j ? 'l' : 'r'
  if (paneAnimTimer) window.clearTimeout(paneAnimTimer)
  paneAnimTimer = window.setTimeout(() => (paneAnim.value = ''), 260)
})
onBeforeUnmount(() => {
  if (paneAnimTimer) window.clearTimeout(paneAnimTimer)
})

/**
 * 「共 N 个合约」——行情表报上来的数，显示在「合约行情」标题右边
 * （用户 2026-10-03：把下面那行统计挪到标题右侧、顺手删掉「刷新 / 刚刚更新」那行）。
 * 跟着**筛选后的名单**走：搜索 / 换榜单，这个数也跟着变。
 */
const marketCount = ref(0)

/*
 * 历史：这套滑动 2026-10-03 做过（`d23c376`），在 `9cae7c1` 那次大快照里被整块
 * 覆盖掉，之后抽成 `../swipe-tabs` 独立模块加回来（不易再被顺带覆盖）。
 *
 * ⚠️ 它当年的病根是「监听挂在 `.col` 上」——`.col` 高度等于当前 tab 内容高度，
 * 切到「K 线」时图在隔壁的 `.col.side` 里，`.col` 只剩 tab 行那 40px，划了没反应。
 * 现在手势区挂在整个 `.split`、只排除图表本体（`data-no-swipe`），这个坑已经填了
 * （见上面 `useSwipeTabs` 那段）。
 */

onBeforeUnmount(() => {
  collectClose?.()
})

/*
 * 图表报错：**「找不到交易对」这种不弹红字**。
 * 币种输入框每敲一个字都会带着 symbol 去重画图，用户只是在筛选，
 * 或者选了个库里没有的币 —— 这时候蹦一条红色报错没有任何用，
 * 图空着、上面行情显示「—」就够了（用户 2026-10-03：「合约搜索没有 前端不要提示报错文字」）。
 * 真出错（交易所挂了 / 网络断）还是要提示，别吞。
 */
const onChartError = (msg: string) => {
  if (/找不到交易对/.test(msg)) {
    error.value = ''
    return
  }
  error.value = msg
}

/**
 * 合约行情里点了一行 → 换币种。
 *
 * `pickSymbol`（analyze.ts）会把结论清掉、历史重拉；这里只管窄屏：
 * 图是单独一格，选完直接跳过去看图 —— 不然在手机上点完像没反应。
 */
function onPickMarket(base: string): void {
  // 先发出去：等切过去画图时直接命中（服务端是内存/本地库，很快）
  prefetchSymbol(base)
  pickSymbol(base)
  if (isMobile.value) leftTab.value = 'chart'
}

/**
 * 点「分析」—— 桌面那颗文字按钮和窄屏那颗闪电共用这一个
 * （2026-10-05 起两颗都在 `KlineChart` 的 `#head-end` 插槽里，即**周期行最右侧**）。
 *
 * 用户 2026-10-03：「点击分析自动跳转实时分析界面」——
 * 默认停在「合约行情 / K 线」那一格，点完分析还杵在榜单前面，看不见结论，
 * 得自己再点一下。所以点下去先把左侧切过去。
 *
 * ★ 2026-10-18：结论那格搬进了「预测分析 → AI分析」，跳的落点跟着改。
 *
 * ⚠️ **测试模式不能因为切格就丢掉**：`testMode` 里除了 `testArmed` 还认遗留的
 *    `leftTab === 'test'`，切走会让后者变 false、`testAt` 跟着变 null ——
 *    测试跑会被当成实时跑**存进库里**（踩过一次，`analyze.ts` 的 `run()` 里也留着同样的告警）。
 */
function onRun(): void {
  if (leftTab.value === 'test') testArmed.value = true
  autoTab.value = 'live'
  leftTab.value = 'auto'
  run()
}

const currentSymbolPinned = computed(() =>
  isPinnedBase(symbol.value.trim().toUpperCase())
)
const pinBusy = ref(false)

async function toggleCurrentFavorite(): Promise<void> {
  const base = symbol.value.trim().toUpperCase()
  if (!base || pinBusy.value) return
  pinBusy.value = true
  try {
    await toggleFavorite(base)
  } catch (e) {
    showToast((e as Error).message, 'bad')
  } finally {
    pinBusy.value = false
  }
}

/* ---------------- 黑名单（用户 2026-10-10） ---------------- */

/** 当前这个币还在黑名单里锁着吗（跟着每秒跳的 `nowTick` 走，到点自己就变 false） */
const currentSymbolLocked = computed(
  () => lockLeftMs(symbol.value.trim().toUpperCase(), nowTick.value) > 0
)
const banBusy = ref(false)

/**
 * 「加入黑名单」——**必须二次确认**，而且把话说全。
 *
 * 这是给自己上锁：点下去 `blacklistHours` 小时（后端定的，2026-10-17 起是 8）内
 * 开不了这个币的单，**而且没有提前解锁**。
 * 所以确认框里三件事都要写清楚（锁多久 / 平仓不受影响 / 不能提前解除），
 * 别让人以为跟收藏一样点错了再点一下就能回来。
 */
async function confirmBlacklist(): Promise<void> {
  const base = symbol.value.trim().toUpperCase()
  if (!base || banBusy.value || currentSymbolLocked.value) return
  const ok = await askConfirm({
    title: `把 ${base} 加入黑名单？`,
    body: [
      {t: `加入后 ${blacklistHours.value} 小时内不能开 ${base} 的单。`, tone: 'warn'},
      {t: '减仓 / 平仓不受影响 —— 手里有仓随时能跑。', tone: 'num'},
      {t: '⚠️ 这期间不能提前解除，到点自动失效。', tone: 'warn'}
    ],
    okText: '加入黑名单',
    danger: true
  })
  if (!ok) return
  banBusy.value = true
  try {
    const until = await lockCurrentBase(base)
    showToast(
      `已把 ${base} 关进黑名单：${bjTime(until)} 才能开单`,
      'ok'
    )
  } catch (e) {
    showToast((e as Error).message, 'bad')
  } finally {
    banBusy.value = false
  }
}

/* ---------------- 手机端「＋ 添加案例」---------------- */
/*
 * 窄屏不再有「添加案例」那一格（那套表单要在图上看过程、还要填备注，手机上来不及）：
 * 「AI 分析」右边一颗「＋」→ 点开变成「✕」，旁边冒出「添加案例」，图上也就能拖范围了。
 * 提炼时**不摆那串步骤**（手机屏放不下），就转个圈；完了弹一下结果。
 */
const collectMode = ref(false)
const collecting = ref(false)
/** 配置面板（K 线头部最右边那颗按钮点开，从底部弹出来） */
const cfgOpen = ref(false)
/**
 * 这张图现在在屏幕上吗。
 *
 * 图是常驻的（切 tab 不销毁），所以要靠这个告诉它「算是被关掉了」——
 * 它会趁这个时机把当前那段缩放存进对应币种（用户：「关闭 K 线图时保存」）。
 * 桌面端图一直在右栏，恒 true；窄屏只有「K 线 / 测试」两格露着图。
 */
const chartActive = computed(
  () => !isMobile.value || leftTab.value === 'chart' || leftTab.value === 'test'
)

/**
 * 这一页现在是不是「当前页」。
 *
 * 2026-10-04 给 `<RouterView>` 加了 `KeepAlive`：切到别的底栏 tab 时组件**不再卸载**
 * （好处就是用户要的：回来还是走之前那样 —— 分析结果、选中的 tab、图上缩放全在）。
 * 代价是**后台的实时推送不会自己停**（`document.hidden` 只反映「浏览器标签页」
 * 级别的前后台，切站内 tab 它一直是 visible）→ 拿这个标志补上。
 */
const pageAlive = ref(true)

/** 整页根节点：给「滚动位置记忆」用（见 `../scroll`） */
const rootRef = ref<HTMLElement | null>(null)
/*
 * `KeepAlive` 会把这一页的 DOM 整棵摘出文档再插回来，`scrollTop` 那时已经归零
 * （用户 2026-10-04：「滚动条没缓存」）—— 这里把左栏 / 行情表 / 历史列表
 * 各处的滚动位置一并记回来。
 */
useScrollMemory(() => rootRef.value)
/** 首次激活就是「刚挂载」，别把同一个请求拉两遍（onActivated 在首次挂载后也会触发） */
let firstActivate = true
onActivated(() => {
  pageAlive.value = true
  void ensurePins().catch(e =>
    showToast(`读取收藏失败：${(e as Error).message}`, 'bad')
  )
  /* 黑名单可能在别处（另一台设备 / 另一个标签页）刚锁过，切回来对一次 */
  void ensureBlacklist().catch(() => {})
  if (firstActivate) {
    firstActivate = false
    return
  }
})
onDeactivated(() => {
  pageAlive.value = false
})
/** 一次性提示：走全站那一份（`../toast`，画在 `ToastHost`）—— 这一页不再自己攒一套 */
let collectClose: (() => void) | null = null

function toggleCollect(): void {
  collectMode.value = !collectMode.value
  if (collectMode.value) {
    // 图上开始能横向拖一段
    rangeDrawing.value = true
    showToast('在图上横向拖一段，再点「添加案例」')
  } else {
    rangeDrawing.value = false
    clearChartRange()
  }
}

/** 把图上拖出来的那一段提炼成经验（不带备注、不看步骤） */
function runCollect(): void {
  const r = chartRange.value
  const s = symbol.value.trim().toUpperCase()
  if (!s) return showToast('先选币种', 'bad')
  if (!r) return showToast('先在图上拖一段行情', 'bad')
  if (collecting.value) return

  collecting.value = true
  collectClose = collectStream(
    {
      symbol: s,
      timeframe: chartTf.value,
      note: '',
      from: r.from,
      to: r.to,
      exact: true
    },
    {
      // 步骤一律丢掉 —— 手机上只看结果
      onStep() {},
      onDone(res) {
        collecting.value = false
        collectClose = null
        collectMode.value = false
        rangeDrawing.value = false
        clearChartRange()
        showToast(
          `已存进知识库：${res.symbol} ${res.timeframe} · ${res.window.bars} 根 · ` +
            (res.tags?.[0] ?? '没挑到标签')
        )
        void refreshConfig()
      },
      onError(msg) {
        collecting.value = false
        collectClose = null
        showToast(`提炼失败：${msg}`, 'bad')
      }
    }
  )
}

/** 「拖一段」只给「添加案例」用 —— 手机端那颗「＋」展开时也算 */
const chartSelectable = computed(
  () => leftTab.value === 'add' || collectMode.value
)

/** 图上拖完一段 → 记下范围，顺手退出拖动模式（图恢复可拖） */
function onPickRange(v: {from: number; to: number; bars: number}) {
  chartRange.value = v
  rangeDrawing.value = false
}

/**
 * 图上点了结束线 → 记下那一刻。
 *
 * ⚠️ 这里**只记时点**，别做别的事：
 *   · **不能**在这儿 `pointPicking = false`（2026-10-15 实测踩到）：拖动那条线时
 *     `KlineChart` **每动一下就 emit 一次** `point`（好让「判断时点」跟着跳），
 *     一停选线 ⇒ 图那边的 `watch(picking)` 立刻把 `dragLineX` 清掉、
 *     `onLayerMove` 也改走「划范围」那条路 ⇒ **线拖到一半就不跟手、手指还在屏上就断了**。
 *     选线什么时候停由**图自己**在抬手时决定（`onLineUp` → `setPicking(false)`）。
 *   · **不要**在这儿弹提示（用户 2026-10-15：「确定好线之后，不需要弹窗提示说确定线了」）——
 *     而且拖动过程中每动一下都会触发这里，弹出来就是刷屏。
 */
function onPickPoint(at: number) {
  testPoint.value = at
}

</script>

<template>
  <div ref="rootRef" class="analyze">
    <!-- ============ 查询 ============ -->
    <!-- 币种下拉与「AI 分析」按钮都移到右边 K 线的头部了（2026-10-03 用户要求） -->

    <div v-if="error" class="error">{{ error }}</div>

    <!-- ============ 左右布局（手机端「K 线」也是这里的一格） ============ -->
    <div
      ref="swipeRef"
      class="split"
      :class="[
        leftTab === 'chart'
          ? 'm-chart'
          : leftTab === 'test'
            ? 'm-test'
            : 'm-analysis',
        // 「合约行情」再挂一个类：窄屏要让它跟「K 线」一样吃满整屏
        // ⚠️ 原来这里还有 `leftTab === 'history' ? 'm-history' : ''` —— 2026-10-12
        //    「预测历史」并进「预测结果」之后它就没主了（留着的后果是那条 `:not(.m-history)`
        //    判据把合并后那一格自己的滚动关掉，反过来坏事），所以删掉、`style.css` 里那套也清了。
        leftTab === 'market' ? 'm-market' : '',
        // 切 tab 的滑入方向（见上面 paneAnim）：'pane-l' | 'pane-r' | ''
        paneAnim ? 'pane-' + paneAnim : ''
      ]"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend.passive="onTouchEnd"
      @touchcancel.passive="onTouchEnd"
    >
      <!--
        ── 左：一级 tab + 内容 ──
        ⚠️ 这一栏**必须常驻**：切到手机上那格「K 线」时，tab 行就在这里面，
        整栏藏了就没地方切回去了。所以只把内容清空（见下面的分支）。
      -->
      <div class="col">
        <div class="tab-row">
          <SegTabs v-model="leftTab" :options="tabs" />
          <!--
            窄屏：把「模型余额」钉在这一行最右侧。

            用户 2026-10-04：「移动端 在开单分析顶部 tab栏最右侧加上 模型余额 fixed 固定」。
            手机上顶栏整块收起来了（`.topbar { display: none }`），余额原先只在
            「我的 → 个人信息 → 模型配置」里看得到 —— 这里补一颗，点一下刷新（跟顶栏那颗同一个 store）。
            「固定」靠的是**这一行不参与内容滚动**（内容在下面的 `.scroll-body` 里自己滚），
            所以它一直看得见，不需要 `position: fixed`。
            宽屏不露（顶栏已经有账号区了）。
          -->
          <button
            type="button"
            class="badge balance tab-balance"
            :class="balanceBadge.cls"
            :title="balanceBadge.title"
            :disabled="refreshingBalance"
            @click="refreshBalance"
          >
            {{ refreshingBalance ? '余额 …' : balanceBadge.text }}
          </button>
        </div>

        <!--
          ① 合约行情（参考币安合约行情页）：点一行就切币种。
          ⚠️ 这一块**常驻**（用 v-show 而不是 v-if）：在手机上「行情 → K 线 → 再回行情」时，
          列表的滚动位置 / 搜索词 / 榜单都得是走之前那样（用户 2026-10-03）。
          不占资源：不在这一格时传 `active=false`，组件会把推送和轮询都停掉。
        -->
        <div v-show="leftTab === 'market'" class="scroll-body">
          <section class="panel mkt-panel warm-skin">
            <!--
              标题右侧那个「共 N 个合约」是 MarketPanel `count` 事件报上来的 ——
              统计跟着**筛选后的名单**走（搜索 / 榜单变了它也跟着变）。
              左边原来那句「点一行切币种」提示已按用户要求去掉。
            -->
            <h2>
              合约行情
              <span v-if="marketCount" class="mkt-count">
                共 {{ marketCount }} 个合约
              </span>
            </h2>
            <MarketPanel
              :symbol="symbol"
              :active="pageAlive && leftTab === 'market'"
              @pick="onPickMarket"
              @count="marketCount = $event"
            />
          </section>
        </div>

        <!-- ②' 自动化预测：扫描参数（可调参数） + 这一轮筛出来的币种（2026-10-12） -->
        <div v-if="leftTab === 'auto'" class="scroll-body">
          <AutoPredictView />
        </div>

        <!-- ②'' 交易日记（2026-10-18）：条目式 + 按月汇总，纯读库不花钱 -->
        <div v-else-if="leftTab === 'journal'" class="scroll-body">
          <JournalView />
        </div>

        <!-- ③ 知识库：2026-10-10 从「我的 → 复盘」挪进来，替掉原来的「历史分析」 -->
        <div
          v-else-if="leftTab === 'kb'"
          class="scroll-body"
        >
          <HistoryView />
        </div>

        <!-- ④ 添加案例：币种/周期跟右侧，时间段只认「图上拖的那一段」
             （不再跟 K 线日历选的那个时间绑在一起） -->
        <div v-else-if="leftTab === 'add'" class="scroll-body">
          <CollectForm
            compact
            :symbol="symbol"
            :timeframe="chartTf"
            :range="chartRange"
            :drawing="rangeDrawing"
            @draw-range="rangeDrawing = $event"
            @clear:select="clearChartRange"
          />
        </div>
      </div>

      <!-- ── 右：K 线（整屏高度） ── -->
      <aside class="col side">
        <KlineChart
          class="chart-side"
          :symbol="symbol"
          :timeframe="chartTf"
          :from="chartFrom"
          :active="pageAlive && chartActive"
          :selectable="chartSelectable"
          :range="chartRange"
          :drawing="rangeDrawing"
          :pick-point="pointPicking"
          :point-at="testMode ? testPoint : null"
          @update:timeframe="chartTf = $event"
          @update:from="chartFrom = $event"
          @update:drawing="rangeDrawing = $event"
          @update:pick-point="setPointPicking"
          @select="onPickRange"
          @point="onPickPoint"
          @clear:select="clearChartRange"
          @error="onChartError"
          @note="showToast"
        >
          <!-- 顶部：行情条（币种下拉就摆在它左边，跟交易所一个位置） -->
          <template #top>
            <TickerHead :symbol="symbol">
              <template #symbol>
                <!--
                  窄屏：**只显示币种**（用户 2026-10-03：「去掉搜索只显示币种」）——
                  不摆输入框了，就是「BTC ▾」，点开列表里才有搜索框。
                -->
                <SymbolCombo
                  v-model="symbol"
                  :contracts="contracts"
                  :plain="isMobile"
                  @pick="pickSymbol"
                  @submit="onRun"
                />
                <button
                  type="button"
                  class="ghost tiny tk-fav"
                  :class="{on: currentSymbolPinned}"
                  :disabled="pinBusy || !symbol.trim()"
                  :aria-label="
                    currentSymbolPinned
                      ? `取消收藏 ${symbol.toUpperCase()}`
                      : `收藏 ${symbol.toUpperCase()}`
                  "
                  :title="
                    currentSymbolPinned
                      ? '取消收藏'
                      : `收藏（最多 ${maxPinnedBases} 个）`
                  "
                  @click="toggleCurrentFavorite"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z"
                    />
                  </svg>
                </button>
                <!--
                  黑名单（用户 2026-10-10）：挨着收藏那颗星。
                  点一下 → 确认框 → 这个币 8 小时不能开单（**后端也拦**，不是只禁按钮；
                  时长以后端 `BLACKLIST_HOURS` 为准，2026-10-17 从 24 缩到 8）。
                  ⚠️ 已经在黑名单里就**禁用**：解锁只能等时间到（没有「点一下出来」这回事，
                     不然就成了「点错再点回来」，那这锁就没意义了）。
                -->
                <button
                  type="button"
                  class="ghost tiny tk-ban"
                  :class="{on: currentSymbolLocked}"
                  :disabled="banBusy || currentSymbolLocked || !symbol.trim()"
                  :aria-label="
                    currentSymbolLocked
                      ? `${symbol.toUpperCase()} 在黑名单里`
                      : `把 ${symbol.toUpperCase()} 加入黑名单`
                  "
                  :title="
                    currentSymbolLocked
                      ? `${symbol.toUpperCase()} 已在黑名单（倒计时见右侧），到点自动解除`
                      : `加入黑名单：${blacklistHours} 小时内不能开这个币的单`
                  "
                  @click="confirmBlacklist"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle
                      cx="12"
                      cy="12"
                      r="8.6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                    />
                    <path
                      d="M6.2 17.8L17.8 6.2"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </template>
              <!--
                大字价格那一行的最右端（用户 2026-10-07：「mm放在 下面最右侧和价格那一排」）——
                MM 合约保证金率跟着**下单账户**走，摆在价格行右端；币种那一行不再放它。
              -->
              <template #price-end>
                <MarginRateBadge class="tk-mm" />
              </template>
              <!-- 最右侧那组：＋ / 添加案例 / 配置 -->
              <template #actions>
                <!--
                  手机端「＋」：点开变成「✕」，左边冒出「添加案例」，
                  图上同时可以横向拖一段。
                -->
                <button
                  v-if="!collectMode"
                  class="ghost tiny tk-only-mobile tk-plus"
                  title="添加案例：在图上拖一段，提炼成经验"
                  @click="toggleCollect"
                >
                  ＋
                </button>
                <template v-else>
                  <button
                    class="ghost tiny tk-only-mobile tk-add"
                    :disabled="collecting"
                    title="添加案例：把图上拖出来的这段提炼成经验"
                    @click="runCollect"
                  >
                    ✓
                  </button>
                  <button
                    class="ghost tiny tk-only-mobile tk-plus on"
                    title="退出添加案例"
                    @click="toggleCollect"
                  >
                    ✕
                  </button>
                </template>
                <!--
                  ⚠️ MM 合约保证金率 2026-10-07 **挪到「大字价格」那一行的最右端**了
                  （用户：「mm放在 下面最右侧和价格那一排」＋「右侧」）——
                  币种那一行不放它了，见下面 `#price-end` 插槽。
                -->
                <!--
                  测试模式（2026-10-15 用户重做：「**点击测试图标消掉，变成勾和叉**……
                  确定完线后，点击 ✓ 跳转分析，点击 ✗ 关掉」）——
                  挨着「配置」，**两端都露**：宽屏它跟左边那格「测试」tab 等价，
                  窄屏没有那一格（tab 行摆不下第 5 格），这就是唯一的入口。
                    · 没在测试模式 ⇒ 一颗烧瓶；点一下**它自己消失**，原位换成 ✓ / ✗；
                    · ✓ = 结束线定好了 ⇒ 跳「预测结果」看结论（没点线时是灰的、按不动）；
                    · ✗ = 关掉测试模式，连结束线一起清（线不会赖在图上）。
                  测试模式本身的状态靠「在图上那条结束线 + 预测结果里那条测试模式标识」看，
                  图标不再有「亮着」这一档（用户要的就是勾和叉，不是开关）。
                -->
                <template v-if="!testMode">
                  <button
                    type="button"
                    class="ghost tiny tk-test"
                    title="测试：在图上点一根 K 线，回到那一刻跑一局（不存档）"
                    aria-label="测试模式"
                    @click="startTestMode()"
                  >
                    <!-- 烧瓶：跟「配置」的滑块图标一眼分得开，也不用文字挤地方 -->
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9.4 3h5.2M10.6 3.6v5.9L5.3 17.9A1.9 1.9 0 0 0 6.9 20.8h10.2a1.9 1.9 0 0 0 1.6-2.9L13.4 9.5V3.6" />
                      <path d="M8.2 14.6h7.6" />
                    </svg>
                  </button>
                </template>
                <template v-else>
                  <!-- ✓：没点线时 `disabled`（灰着），点它就跳「预测结果」 -->
                  <button
                    type="button"
                    class="ghost tiny tk-test ok"
                    :disabled="testPoint === null"
                    :title="
                      testPoint === null
                        ? '先在图上点一根 K 线定结束线'
                        : `去分析：按结束线 ${bjTime(testBarTime ?? 0)} 那一刻跑一局`
                    "
                    aria-label="去分析"
                    @click="confirmTestPoint()"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12.6 9.6 17.2 19 7.4" />
                    </svg>
                  </button>
                  <!-- ✗：关掉测试模式（结束线也一起清掉） -->
                  <button
                    type="button"
                    class="ghost tiny tk-test no"
                    title="关掉测试模式（结束线一起清掉）"
                    aria-label="关掉测试模式"
                    @click="exitTestMode()"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
                    </svg>
                  </button>
                </template>
                <!-- 最右边：配置（点开从底部弹出来） -->
                <button
                  class="ghost tiny tk-cfg"
                  title="配置"
                  aria-label="配置"
                  @click="cfgOpen = true"
                >
                  <!-- 滑块图标：两条横线 + 旋钮（跟常见的「调节」图标一致，也跟齿轮分得清） -->
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 8h7M17 8h3M4 16h3M13 16h7" />
                    <circle cx="14" cy="8" r="2.6" />
                    <circle cx="10" cy="16" r="2.6" />
                  </svg>
                </button>
              </template>
            </TickerHead>
          </template>
          <!--
            周期行（`KlineChart` 的 `.chart-head-right`）**最右边那颗**「跑分析」：
            桌面是文字按钮，窄屏是一颗闪电 —— 两个都放在这一个插槽里，靠 CSS 二选一。

            用户 2026-10-05：「闪电图标固定在选择周期一行最右侧」。
            ⚠️ 窄屏那颗原来挂在上面币种旁边（`#symbol` 里）、而且是 `position: fixed`
            可以拖着走的（user 2026-10-04 的要求）—— 现在整套拖拽都拆了，
            它就跟桌面那颗一样老实待在文档流里（详见脚本里那段说明）。
          -->
          <template #head-end>
            <!--
              持久化分析（2026-10-15 用户：「在 k 线界面顶部加入持久化分析的图标」
              →「**自动化图标放在闪电旁边**，激活改为转动态效果」）——
              所以它现在待在**周期行最右端、那颗闪电左边**（不是上面那排「测试 / 配置」里）。
              亮着（`.on`，染蓝）= 这个币正在被每 15 分钟问一次。
              ⚠️ 中间试过让它"转起来"表示在跑，用户当天就否了：「**不要一直转**」——
                  一直转的东西挂在图上一整天太吵，所以现在是静态图标 + 颜色。
              点一下开弹层（没加入是那句确认，加入之后是状态 + 结论时间线）。
            -->
            <button
              type="button"
              class="ghost tiny tk-persist"
              :class="{on: !!persistNow}"
              :title="
                persistNow
                  ? `正在持久化分析：第 ${persistNow.runs} 次 · 还剩 ${leftText(persistNow.endsAt)} —— 点一下看结论时间线`
                  : '持久化分析：每 15 分钟问一次 AI，最长 8 小时'
              "
              aria-label="持久化分析"
              @click="persistOpen = true"
            >
              <!--
                ★ 2026-10-15 用户来回试了四轮，最后定的就是这条：
                  「在 k 线界面顶部加入持久化分析的图标」→「自动化图标放在闪电旁边，激活改为转动态效果」
                  →「不要一直转，改成分析上下折线」→「折线启动要动起来，一直在滚动」
                  →「算了还是换个图标吧，**启动就为实色**」。
                所以：图标 = **AI 星芒**（两颗四角星，"AI"那个通用记号），
                在跑 = **实色按钮**（跟旁边那颗闪电同一套：主色底 + 墨色图标）——
                不再搞旋转/滚动那些花活，一眼看得出来在不在跑。
                ⚠️ 星芒是**填充**形状（`fill` 走 currentColor，不是描边），
                   所以 "实色" 那档只用换颜色，不用换图标。
              -->
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M10.4 2.4 12.1 7.9 17.6 9.6 12.1 11.3 10.4 16.8 8.7 11.3 3.2 9.6 8.7 7.9Z"
                />
                <path
                  d="M17.9 13.9 18.8 16.7 21.6 17.6 18.8 18.5 17.9 21.3 17 18.5 14.2 17.6 17 16.7Z"
                />
              </svg>
            </button>
            <button class="btn-run head-run" :disabled="loading" @click="onRun">
              {{ runLabel }}
            </button>
            <button
              class="btn-run tk-run"
              :disabled="loading"
              :title="runLabel"
              :aria-label="runLabel"
              @click="onRun"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
          </template>
          <!-- 底部：合约下单模块。 -->
          <template #bottom>
            <OrderPanel
              :symbol="symbol"
              :active="pageAlive && chartActive"
              @config="cfgOpen = true"
            />
          </template>
        </KlineChart>
      </aside>
    </div>

    <!--
      提炼中：就转个圈。手机上不看那串步骤（一屏放不下，还得往下滑），
      完了弹一下结果。
    -->
    <div v-if="collecting" class="collect-mask">
      <div class="collect-mask-card">
        <span class="spin" />
        <b>AI 正在提炼这段行情…</b>
        <span class="dim">拉行情 → 算压力支撑 → 读结构 → 提炼经验</span>
      </div>
    </div>

    <!-- 一次性提示由全局的 `ToastHost` 画（见 App.vue / style.css 那一节） -->

    <!-- 持久化分析：从底部弹出来的那块（入口是 K 线头部那颗循环箭头） -->
    <PersistSheet
      :open="persistOpen"
      :base="symbol"
      :timeframe="chartTf"
      @close="persistOpen = false"
    />

    <!-- 配置：从底部弹出来（入口在 K 线头部最右边那颗齿轮） -->
    <SettingsSheet :open="cfgOpen" @close="cfgOpen = false" />
  </div>
</template>
