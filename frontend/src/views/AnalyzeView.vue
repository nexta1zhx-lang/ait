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
import {RouterLink} from 'vue-router'
import SymbolCombo from '../comps/SymbolCombo.vue'
import MarketPanel from '../comps/MarketPanel.vue'
import KlineChart from '../comps/KlineChart.vue'
import SettingsSheet from '../comps/SettingsSheet.vue'
import SegTabs from '../comps/SegTabs.vue'
import CollectForm from '../comps/CollectForm.vue'
import StepsPanel from '../comps/StepsPanel.vue'
import RecIcon from '../comps/RecIcon.vue'
import TickerHead from '../comps/TickerHead.vue'
import TickerChanges from '../comps/TickerChanges.vue'
import {tagsOf, type Heat, type LevelSR, collectStream} from '../api'
import {useScrollMemory} from '../scroll'
import {
  CHART_TAB,
  LEFT_TABS,
  MOBILE_MAX,
  chartFrom,
  chartRange,
  chartTf,
  clearChartRange,
  clearTestPoint,
  error,
  history,
  historyError,
  historyGo,
  historyPage,
  historyPageSize,
  historyPages,
  historyTotal,
  leftTab,
  loadHistory,
  loading,
  pickSymbol,
  pointPicking,
  rangeDrawing,
  result,
  run,
  setHistoryPageSize,
  setPointPicking,
  showSteps,
  steps,
  symbol,
  testAt,
  testBarTime,
  testMode,
  testPoint
} from '../analyze'
import {contracts, refreshConfig} from '../store'
import {stopTicker, watchTicker} from '../ticker'
import {
  VERDICT_TEXT,
  bjShort,
  bjTime,
  fixed,
  fmt,
  richText,
  signedPct,
  splitRec
} from '../format'

// 结论、分析过程、报错都在 ../analyze 的模块作用域里，
// 切到别的页面再回来不会丢；这里只负责首次进页面把历史拉一次。
onMounted(() => void loadHistory(symbol.value))

/*
 * 顶部行情条 / 底部涨幅：跟着币种走，进来就拉、换币立刻重拉。
 * ⚠️ 只有这个页面看得到它，所以离开就把定时器停掉 —— 别在后台一直打交易所。
 */
watch(symbol, s => watchTicker(s), {immediate: true})
onBeforeUnmount(stopTicker)
onMounted(() => window.addEventListener('resize', onViewport))
onBeforeUnmount(() => window.removeEventListener('resize', onViewport))

/**
 * 手机端（≤900px）：一级 tab = **K 线 / 实时分析 / 历史分析**。
 *
 * 窄屏放不下「左分析 + 右 K 线」两栏；而 K 线那块现在头顶行情条、脚下涨幅行，
 * 自己就是一整屏 —— 所以手机上它自己占一格，不再另开一排开关。
 *
 * 「测试 / 添加案例」在手机端**不摆出来**：这两件都要在图上看点/拖，
 * 一屏放不下就来回切，反倒没法用（添加案例挪到 K 线那格的「＋」里去了）。
 *
 * 桌面端图常驻右栏，这几格照旧。
 * 断点 `MOBILE_MAX` 跟 CSS 里那套对齐，定义在 `../analyze`（默认选中哪一格也在那儿）。
 */
const isMobile = ref(window.innerWidth <= MOBILE_MAX)

/** 窄屏不摆的那两格（都要在图上看点 / 拖，一屏放不下） */
const MOBILE_HIDDEN_TABS: string[] = ['test', 'add']

/** 跑分析那颗按钮的文案（桌面 / 手机两处按钮共用一个，不会写漂） */
const runLabel = computed(() =>
  loading.value ? '分析中…' : testMode.value ? '按这段行情判断' : '分析'
)

/**
 * ⚠️ 用 `resize` + `innerWidth` 判断，别用 `matchMedia` 的 change ——
 * 那个事件在部分环境（实测内置浏览器）根本不触发，拖宽了「K 线」还赖在 tab 行里。
 */
function onViewport(): void {
  const m = window.innerWidth <= MOBILE_MAX
  if (m === isMobile.value) return
  isMobile.value = m
  /*
   * 宽窄切换时把「对方不存在的那一格」收回来：
   * 「K 线」只在窄屏有，「合约行情」只在宽屏有（2026-10-04 提成单独一页了），
   * 「测试 / 添加案例」反过来只有宽屏有。
   */
  if (!m && leftTab.value === 'chart') leftTab.value = 'market'
  if (
    m &&
    (leftTab.value === 'market' || MOBILE_HIDDEN_TABS.includes(leftTab.value))
  ) {
    leftTab.value = 'chart'
  }
}

/**
 * 窄屏的 tab：「K 线」排第一个（它也是默认落的那一格），
 * 后面跟宽屏那套去掉「合约行情 / 测试 / 添加案例」。
 *
 * ⚠️ 「合约行情」已经搬去底栏的「合约」页（用户 2026-10-04），窄屏不再摆。
 */
const tabs = computed(() => {
  if (!isMobile.value) return LEFT_TABS
  const rest = LEFT_TABS.filter(
    t => t.value !== 'market' && !MOBILE_HIDDEN_TABS.includes(t.value)
  )
  return [CHART_TAB, ...rest]
})

/* ---------------- 窄屏：左右滑动切换一级 tab ---------------- */

/**
 * 「共 N 个合约」——行情表报上来的数，显示在「合约行情」标题右边
 * （用户 2026-10-03：把下面那行统计挪到标题右侧、顺手删掉「刷新 / 刚刚更新」那行）。
 * 跟着**筛选后的名单**走：搜索 / 换榜单，这个数也跟着变。
 */
const marketCount = ref(0)

/*
 * ⚠️ 这里原来有一套「窄屏左右滑动切换一级 tab」（`swipeRef` / `onSwipeStart/Move/End`
 * / `stepTab` / `ownsHorizontal`），2026-10-04 **整套删掉**（用户：「移动端滑动切换
 * tab 逻辑删掉」）。
 *
 * 删之前实测过它确实是坏的：监听挂在 `.col` 这个盒子上，而 `.col` 的高度等于当前
 * tab 内容的高度 —— 切到「K 线」时图在隔壁的 `.col.side` 里，`.col` 只剩 40px
 * （就那行 tab 按钮），「实时分析」也只有 144px。所以绝大多数地方划了没反应。
 * 与其修，不如不要（用户的选择）。

/* ---------- 历史列表：能放几行就放几行，列表自己不出滚动条 ---------- */
const histBox = ref<HTMLElement | null>(null)
let histRO: ResizeObserver | null = null

/** 左边栏可视高度 ÷ 单行高度（含行距）= 这一页该放几条 */
function measureHistoryRows(): void {
  const box = histBox.value
  if (!box) return
  const h = box.clientHeight
  if (h <= 0) return
  const lis = box.querySelectorAll('li')
  /*
   * ⚠️ 拿第 1、2 行的 `offsetTop` 差当「一步」，而不是只量单行高度：
   * 行之间现在有 `margin-top`（用户：「行加间距」），只按行高算会多摆一行、
   * 最后那行被 `overflow: hidden` 切掉。
   * 首行没有上边距，所以「一步」= 行高 + 行距 ✓
   */
  const step =
    lis.length > 1
      ? lis[1].offsetTop - lis[0].offsetTop
      : lis[0]?.getBoundingClientRect().height || 28
  if (step <= 0) return
  setHistoryPageSize(Math.max(1, Math.floor(h / step)))
}

// tab 切过来时 ul 才存在，ref 一挂上就量；窗口缩放由 ResizeObserver 接着管
watch(histBox, el => {
  histRO?.disconnect()
  histRO = null
  if (!el) return
  histRO = new ResizeObserver(() => measureHistoryRows())
  histRO.observe(el)
  void nextTick(measureHistoryRows)
})

// 第一页拉回来的行渲染完了，才量得到真实行高
watch(
  () => history.value.length,
  () => void nextTick(measureHistoryRows)
)

onBeforeUnmount(() => {
  histRO?.disconnect()
  collectClose?.()
  if (toastTimer) clearTimeout(toastTimer)
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
  pickSymbol(base)
  if (isMobile.value) leftTab.value = 'chart'
}

/**
 * 点「分析」（桌面 `#head-end` 和手机上币种旁那颗共用这一个）。
 *
 * 用户 2026-10-03：「点击分析自动跳转实时分析界面」——
 * 默认停在「合约行情 / K 线」那一格，点完分析还杵在榜单前面，看不见结论，
 * 得自己再点一下「实时分析」。所以点下去先把左侧切过去。
 *
 * ⚠️ **「测试」那一格不能切**：`testMode` 是从 `leftTab` 推出来的，
 * 切走会让它变 false、`testAt` 跟着变 null —— 测试跑会被当成实时跑**存进库里**
 * （踩过一次，`analyze.ts` 的 `run()` 里也留着同样的告警）。
 */
function onRun(): void {
  if (leftTab.value !== 'live' && leftTab.value !== 'test')
    leftTab.value = 'live'
  run()
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
  if (firstActivate) {
    firstActivate = false
    return
  }
  // 缓存了页面 = 不再重新挂载，回来时顺手把「历史分析」那一列刷一下
  // （翻页 / 币种 / 滚动位置都留着，只换数据）
  void loadHistory(symbol.value, true)
})
onDeactivated(() => {
  pageAlive.value = false
})
/** 一次性提示（几秒后自己消失，点一下也消失） */
const toast = ref<{text: string; tone: 'ok' | 'bad'} | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
let collectClose: (() => void) | null = null

function showToast(text: string, tone: 'ok' | 'bad' = 'ok'): void {
  toast.value = {text, tone}
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(
    () => (toast.value = null),
    tone === 'bad' ? 8000 : 4000
  )
}

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

/** 图上点了结束线 → 记下那一刻，顺手退出选线模式 */
function onPickPoint(at: number) {
  testPoint.value = at
  pointPicking.value = false
}

/* ---------------- 结论渲染 ---------------- */

const judge = computed(() => result.value?.judge)

/** AI 挑的标签（模板外的不做过滤，标出来给人看） */
const tags = computed(() => tagsOf(result.value?.judge))

/** 结论头那颗徽标 —— 不再判档，直接显示**走势概率**（= outlook 那条走法的概率） */
const probText = computed(() =>
  judge.value ? `走势概率 ${judge.value.probability}%` : '未判断'
)
const verdictInfo = computed(
  () => VERDICT_TEXT[judge.value?.verdict ?? ''] ?? ['—', '']
)

/** 推荐做法拆成「现在 / 动手 / 别碰」几行（老记录没前缀就一段） */
const recParts = computed(() => splitRec(judge.value?.recommendation))

/*
 * 价格位置图（用户 2026-10-04：「纯文字太单调懒得看，能否图示预测」）。
 *
 * 图上的 4H 压力/支撑 由 `KlineChart` 报上来（`@levels`），拿不到就退回 24h 高低 ——
 * 总之要画出一道「上沿 / 现价 / 下沿」的尺子，让人一眼看出现价卡在哪。
 */
const sr = ref<LevelSR | null>(null)

const levelBox = computed<{
  hi: number
  lo: number
  hiK: string
  loK: string
} | null>(() => {
  const r = result.value
  const p = r?.price
  if (!r || !p) return null
  /*
   * ⚠️ **测试跑不能用车上的压力 / 支撑**：那是拿「现在」的 K 线算出来的，
   * 而这里的价格是**那一刻**的 —— 两把尺子对不上。
   * 实测踩过：测试点现价 83,302，图上 4H 却给 84,708 ~ 84,928，现价被甩在盒子外面。
   * 那一刻的 24h 高低是**随快照一起取回来的**，跟价格同一个时点，只有它靠得住。
   */
  if (!r.testMode) {
    const hi = sr.value?.resistance
    const lo = sr.value?.support
    if (hi && lo && hi > lo) return {hi, lo, hiK: '压力', loK: '支撑'}
  }
  const h = r.heat?.high24h
  const l = r.heat?.low24h
  if (h && l && h > l) return {hi: h, lo: l, hiK: '24h高', loK: '24h低'}
  return null
})

/** 三行：上沿 / 现价 / 下沿，带上离现价多远（%） */
const levels = computed(() => {
  const b = levelBox.value
  const p = result.value?.price
  if (!b || !p) return []
  const off = (v: number) =>
    `${v >= p ? '+' : ''}${(((v - p) / p) * 100).toFixed(2)}%`
  return [
    {k: b.hiK, v: fmt(b.hi), d: off(b.hi), tone: 'hi'},
    {k: '现价', v: fmt(p), d: '—', tone: 'now'},
    {k: b.loK, v: fmt(b.lo), d: off(b.lo), tone: 'lo'}
  ]
})

/** 现价在「上沿 → 下沿」这条尺子上的位置（0% = 贴上沿，100% = 贴下沿） */
const lvPos = computed<number | null>(() => {
  const b = levelBox.value
  const p = result.value?.price
  if (!b || !p) return null
  return Math.min(100, Math.max(0, ((b.hi - p) / (b.hi - b.lo)) * 100))
})

const heatRows = computed(() => {
  const h: Heat | undefined = result.value?.heat
  if (!h) return []
  const num = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(Number(v))
      ? null
      : Number(v)
  const pctText = (v: number | null, digits = 2) =>
    v === null ? '—' : signedPct(v, digits)
  const rows: {k: string; v: string; cls?: string}[] = []
  const ch = num(h.change24hPct)
  rows.push({
    k: '24h 涨跌',
    v: pctText(ch),
    cls: ch === null ? '' : ch >= 0 ? 'ok' : 'bad'
  })
  rows.push({
    k: '24h 振幅',
    v: num(h.amplitude24hPct) === null ? '—' : fixed(h.amplitude24hPct, 2) + '%'
  })
  rows.push({k: '24h 高 / 低', v: `${fmt(h.high24h)} / ${fmt(h.low24h)}`})
  rows.push({
    k: '24h 成交额',
    v: num(h.quoteVolume24h) === null ? '—' : fmt(h.quoteVolume24h, 0)
  })
  rows.push({
    k: '资金费率',
    v:
      num(h.fundingRate) === null
        ? '—'
        : (Number(h.fundingRate) * 100).toFixed(4) + '%'
  })
  rows.push({
    k: '持仓量',
    v: num(h.openInterest) === null ? '—' : fmt(h.openInterest, 0)
  })
  const oiCh = num(h.openInterestChangePct)
  rows.push({
    k: '持仓量变化',
    v: pctText(oiCh),
    cls: oiCh === null ? '' : oiCh >= 0 ? 'ok' : 'bad'
  })
  rows.push({
    k: '多空人数比',
    v: num(h.longShortRatio) === null ? '—' : fixed(h.longShortRatio, 2)
  })
  return rows
})
</script>

<template>
  <div ref="rootRef" class="analyze">
    <!-- ============ 查询 ============ -->
    <!-- 币种下拉与「AI 分析」按钮都移到右边 K 线的头部了（2026-10-03 用户要求） -->

    <div v-if="error" class="error">❌ {{ error }}</div>

    <!-- ============ 左右布局（手机端「K 线」也是这里的一格） ============ -->
    <div
      class="split"
      :class="[
        leftTab === 'chart'
          ? 'm-chart'
          : leftTab === 'test'
            ? 'm-test'
            : 'm-analysis',
        // 「历史分析」「合约行情」各自再挂一个类：窄屏要让它跟「K 线」一样吃满整屏
        leftTab === 'history' ? 'm-history' : '',
        leftTab === 'market' ? 'm-market' : ''
      ]"
    >
      <!--
        ── 左：一级 tab + 内容 ──
        ⚠️ 这一栏**必须常驻**：切到手机上那格「K 线」时，tab 行就在这里面，
        整栏藏了就没地方切回去了。所以只把内容清空（见下面的分支）。
      -->
      <div class="col">
        <div class="tab-row">
          <SegTabs v-model="leftTab" :options="tabs" />
        </div>

        <!--
          ① 合约行情（参考币安合约行情页）：点一行就切币种。
          ⚠️ 这一块**常驻**（用 v-show 而不是 v-if）：在手机上「行情 → K 线 → 再回行情」时，
          列表的滚动位置 / 搜索词 / 榜单都得是走之前那样（用户 2026-10-03）。
          不占资源：不在这一格时传 `active=false`，组件会把推送和轮询都停掉。
        -->
        <div v-show="leftTab === 'market'" class="scroll-body">
          <section class="panel mkt-panel">
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

        <!-- ② 实时分析 / 测试（两块共用同一套渲染：测试多一块「结束线」面板） -->
        <template v-if="leftTab === 'live' || leftTab === 'test'">
          <div class="scroll-body">
            <!-- 测试模式：在图上点一根，定下「我看到哪一刻」 -->
            <section v-if="testMode" class="panel test-panel">
              <h2>
                测试 · 结束线
                <span class="tag">不存档</span>
              </h2>
              <p class="hint">
                在右边 K 线上<b>点一根</b>，把「结束线」放在那儿 —— AI
                会把<b>这一根收盘之后</b>当成「当时」：只看得到那一刻之前
                <b>已经收盘</b>的 K 线，之后的一根都不给。
                <br />
                取数永远是「以这一刻为终点往前推」，所以只用一个时刻，
                <b>不用划一段</b>。
              </p>

              <div class="follow-row" :class="{picked: testPoint !== null}">
                <span class="k">结束线</span>
                <span class="v">
                  <!-- 用 testBarTime 判空（它和 testPoint 同生同灭），这样 bjTime 的参数才是 number -->
                  <template v-if="testBarTime !== null">
                    看到 {{ bjTime(testBarTime) }} 这根收盘
                    <em v-if="testPoint !== null">
                      判断时点 = {{ bjTime(testPoint) }}
                    </em>
                  </template>
                  <template v-else-if="pointPicking">
                    在右边图上点一根…
                    <em>点一下就定好了（按 Esc 取消）</em>
                  </template>
                  <template v-else>
                    还没选
                    <em>点右边「选结束线」开始</em>
                  </template>
                </span>

                <button
                  type="button"
                  class="ghost tiny range-btn"
                  :class="{on: pointPicking}"
                  :title="
                    pointPicking
                      ? '在图上点一根 K 线，点中就算选好（Esc 取消）'
                      : '在图上点一根 K 线，定下「我看到这一根收盘」'
                  "
                  @click="setPointPicking(!pointPicking)"
                >
                  {{
                    pointPicking
                      ? '取消'
                      : testPoint !== null
                        ? '重选'
                        : '选结束线'
                  }}
                </button>
                <button
                  v-if="testPoint !== null"
                  type="button"
                  class="ghost tiny"
                  title="清掉结束线，重新选"
                  @click="clearTestPoint"
                >
                  清掉
                </button>
              </div>
            </section>

            <!-- 测试模式：必须一眼看出来这不是实时那一局 -->
            <div v-if="testAt" class="test-banner">
              <b>⏱ 测试模式 · 判断时点 {{ bjTime(testAt) }}</b>
              <span
                >AI 只看得到这一刻之前已收盘的 K 线；资金费率 / 持仓量 /
                多空比拿不到、留空。<b>本次不存档。</b></span
              >
            </div>

            <StepsPanel
              :steps="steps"
              :done="!!result"
              :running="loading"
              :open="showSteps"
              :hint="
                testMode
                  ? '点「按这段行情判断」后，这里会逐步写出：读分析预测提示词 → 取可用的标签 → 拉那一刻的行情 → 拼上下文 → 调模型（测试跑不存档）。'
                  : '点「AI 分析」后，这里会逐步写出：读分析预测提示词 → 取可用的标签 → 拉行情 → 拼上下文 → 调模型 → 存档。'
              "
              @update:open="showSteps = $event"
            />

            <template v-if="result">
              <!--
                ★ 2026-10-03 精简（用户要求）：
                · 去掉「已存档 #N → 去复盘」那个链接
                · 去掉二级 tab 栏（原来「结论 / 市场与周期」两格）→ 结论和热度直接铺下来
                · 去掉「各周期行情」（发给 AI 的原文）那一大块
                · 去掉下面那 6 项统计（当前价 / 24h 涨跌 / 资金费率 / 拉了多少行情 /
                  提示词版本 / 可用标签）—— 价格上面行情条里就有，其余与判断无关
                · **市场热度保留**（唯一要看的是它）
              -->
              <section class="panel flush result-card">
                <!-- ① 走势概率：一条长条，比一个数字好看也好比 -->
                <div class="prob">
                  <div class="prob-top">
                    <span class="prob-num" :class="verdictInfo[1]">
                      {{ judge?.probability ?? '—' }}<i>%</i>
                    </span>
                    <span class="prob-cap">走势概率</span>
                    <span class="pill" :class="verdictInfo[1]">{{
                      verdictInfo[0]
                    }}</span>
                  </div>
                  <span class="prob-track">
                    <i
                      :class="verdictInfo[1]"
                      :style="{width: (judge?.probability ?? 0) + '%'}"
                    />
                  </span>
                </div>

                <!-- ② 形状：每个标签一条概率条（比 chips 直观） -->
                <div v-if="tags.length" class="viz">
                  <div class="sec-label">形状 · 有多像</div>
                  <div v-for="t in tags" :key="t.name" class="shape">
                    <span class="shape-name">{{ t.name }}</span>
                    <span class="shape-track">
                      <i :style="{width: t.probability + '%'}" />
                    </span>
                    <span class="shape-pct">{{ t.probability }}%</span>
                  </div>
                </div>

                <!-- ③ 价格位置：上沿 / 现价 / 下沿 一把尺子 -->
                <div v-if="levels.length" class="viz">
                  <div class="sec-label">价格位置</div>
                  <div class="lv">
                    <span class="lv-rail">
                      <b class="lv-dot" :style="{top: (lvPos ?? 0) + '%'}" />
                    </span>
                    <span class="lv-rows">
                      <span
                        v-for="r in levels"
                        :key="r.k"
                        class="lv-row"
                        :class="r.tone"
                      >
                        <em class="k">{{ r.k }}</em>
                        <b class="v">{{ r.v }}</b>
                        <i class="d">{{ r.d }}</i>
                      </span>
                    </span>
                  </div>
                </div>
                <!-- ① 推荐：最该照做的（绿，字最大）—— AI 按「现在/开单/别碰」三行给 -->
                <section v-if="recParts.length" class="concl rec">
                  <span class="concl-h">推荐</span>
                  <span class="concl-sub">最该照做的</span>
                  <template v-for="(p, i) in recParts" :key="i">
                    <div v-if="p.k" class="rec-row" :class="p.tone">
                      <span class="rec-k">
                        <!-- 矢量图标（会动）：现在=呼吸光点 / 开单=上冲箭头 / 别碰=摇头禁止符 -->
                        <RecIcon :tone="p.tone" />
                        <span>{{ p.k }}</span>
                      </span>
                      <!-- richText：关键字加粗 + 上色（见 format.ts） -->
                      <span class="rec-v" v-html="richText(p.v)" />
                    </div>
                    <p v-else class="rec-plain" v-html="richText(p.v)" />
                  </template>
                </section>

                <!-- ② 走势：最可能这么走（蓝，带概率） -->
                <section v-if="judge?.outlook" class="concl out">
                  <span class="concl-h">走势</span>
                  <span class="concl-sub">最可能这么走</span>
                  <span v-if="judge.probability" class="concl-pct">
                    {{ judge.probability }}%
                  </span>
                  <p v-html="richText(judge.outlook)" />
                </section>

                <!-- ③ 理由：道理讲给想深挖的人听（灰，默认收起） -->
                <details v-if="judge?.reason" class="concl why">
                  <summary>
                    <span class="concl-h">理由</span>
                    <span class="concl-sub">为什么这么看（点开）</span>
                  </summary>
                  <p v-html="richText(judge.reason)" />
                </details>
              </section>

              <!-- 市场热度：**用户明确要保留的一块**（二级 tab 和「各周期行情」都去掉了） -->
              <section class="panel flush">
                <h2>市场热度 <span class="tag">交易所数据</span></h2>
                <div class="heat-grid">
                  <div v-for="r in heatRows" :key="r.k" class="heat-row">
                    <span class="k">{{ r.k }}</span>
                    <span class="v" :class="r.cls">{{ r.v }}</span>
                  </div>
                </div>
              </section>
            </template>
          </div>
        </template>

        <!-- ② 历史分析：只在切到这个 tab 时显示 -->
        <div v-else-if="leftTab === 'history'" class="scroll-body">
          <section class="panel hist-panel">
            <h2>
              {{ symbol }} 的历史分析
              <span class="tag">共 {{ historyTotal }} 条</span>
            </h2>
            <div v-if="historyError" class="dim">
              （读取失败：{{ historyError }}）
            </div>
            <ul v-else ref="histBox" class="hist">
              <li v-for="h in history" :key="h.id">
                <!--
                  色调类（go/wait/no）挂在行上：左边那条色条、结论文字的颜色都靠它
                  （以前只挂在结论文字上，那文字又没配色，整行看上去是灰的）。
                -->
                <RouterLink
                  :to="`/history?id=${h.id}`"
                  :class="
                    h.verdict ? (VERDICT_TEXT[h.verdict]?.[1] ?? '') : 'dim'
                  "
                >
                  <span class="t">{{ bjShort(h.createdAt) }}</span>
                  <!-- 跟「预测历史」同一套标签体系，这里左右只摆得下两个 -->
                  <span class="tags">
                    <span
                      v-for="t in (h.tags ?? []).slice(0, 2)"
                      :key="t.name"
                      class="tag"
                    >
                      {{ t.name }}
                      <i v-if="t.probability">{{ t.probability }}%</i>
                    </span>
                    <span v-if="!(h.tags ?? []).length" class="dim">—</span>
                  </span>
                  <span
                    class="v"
                    :class="
                      h.verdict ? (VERDICT_TEXT[h.verdict]?.[1] ?? '') : 'dim'
                    "
                  >
                    {{
                      h.verdict
                        ? (VERDICT_TEXT[h.verdict]?.[0] ?? h.verdict)
                        : '—'
                    }}
                  </span>
                </RouterLink>
              </li>
            </ul>
            <p v-if="!historyError && !history.length" class="hint">
              {{ symbol }} 还没有分析记录。
              <template v-if="historyPages > 1">
                （第 {{ historyPage }} 页是空的，翻回第 1 页看看）
              </template>
            </p>

            <!-- 分页：一页放不下就翻 -->
            <div v-if="historyPages > 1" class="pager">
              <button
                class="ghost tiny"
                :disabled="historyPage <= 1"
                @click="historyGo(-1)"
              >
                上一页
              </button>
              <span class="dim">
                第 {{ historyPage }} / {{ historyPages }} 页 · 每页
                {{ historyPageSize }}
              </span>
              <button
                class="ghost tiny"
                :disabled="historyPage >= historyPages"
                @click="historyGo(1)"
              >
                下一页
              </button>
            </div>

            <div v-if="historyTotal > history.length" class="hist-more">
              <RouterLink :to="`/history?symbol=${symbol}`">
                去「历史」页看全部 {{ historyTotal }} 条 →
              </RouterLink>
            </div>
          </section>
        </div>

        <!-- ③ 添加案例：币种/周期跟右侧，时间段只认「图上拖的那一段」
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
          @levels="sr = $event"
          @clear:select="clearChartRange"
          @error="onChartError"
        >
          <!-- 顶部：行情条（币种下拉就摆在它左边，跟交易所一个位置） -->
          <template #top>
            <TickerHead>
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
                <!--
                  窄屏：「分析」就**贴在币种旁边**（用户 2026-10-03：「ai 分析改为分析
                  靠在币种旁边」），后来又要「**分析改为闪电图标**」。
                  所以窄屏这颗就是一颗闪电，文案走 title / aria-label（`runLabel`）。
                  放 `#symbol` 里而不是 `#actions` —— 后者整组带 `margin-left: auto`，会被推到最右边。
                -->
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
          <!-- 右边：跑分析（桌面端在这儿，手机端在上面币种旁） -->
          <template #head-end>
            <button class="btn-run head-run" :disabled="loading" @click="onRun">
              {{ runLabel }}
            </button>
          </template>
          <!-- 底部：1天 / 3天 / 7天 / 1个月 / 3个月 / 1年 涨幅 -->
          <template #bottom>
            <TickerChanges />
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

    <!-- 一次性提示：成了 / 失败了都说一声，几秒后自己消失 -->
    <div
      v-if="toast"
      class="toast"
      :class="toast.tone"
      title="点一下关掉"
      @click="toast = null"
    >
      {{ toast.text }}
    </div>

    <!-- 配置：从底部弹出来（入口在 K 线头部最右边那颗齿轮） -->
    <SettingsSheet :open="cfgOpen" @close="cfgOpen = false" />
  </div>
</template>
