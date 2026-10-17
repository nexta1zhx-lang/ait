<script setup lang="ts">
/**
 * **预测分析**（用户 2026-10-12：「新建一个页面叫自动化预测 在预测历史后面」；
 * 2026-10-18 改名并把一级 tab 排到第一个：「自动化预测改名叫做预测分析」）。
 * 四个内层 tab：币种监测 / AI分析 / 自动分析 / 提醒。
 *
 * 这一页是"后台自动跑"的门面：
 *
 *   ① **筛选的币种** —— 按现在的参数扫一轮（后端 `scan/rules.ts`）。纯 SQL 读本地 K 线，
 *      **不调模型、不花钱**、一两百毫秒，可以随便重扫。表格只留三列：
 *      币种 / 原因（命中哪条规则）/ 涨跌幅，**点一行跳 K 线**去看图。
 *   ② **参数弹窗** —— 扫描门槛（存库 `user_scan_settings`，见后端 `db/scan-settings.ts`）。
 *      存库而不是 localStorage：**扫描是网页没开的时候跑的**，参数必须在服务端。
 *
 * ★ 2026-10-12 用户定的两条版式（「后续界面都是这样」）：
 *   · 「样式更改为账户统计样式」⇒ 根节点挂 `.warm-skin`（暖色皮肤，跟账户统计同一套变量），
 *     表格用「边框 + 圆角 + 细横线」那种（对齐账户统计的历史表）；
 *   · 「表单改为弹窗简短不需要描述」「选出来的不要卡片展示，表格显示币种原因涨跌幅」
 *     ⇒ 参数收进底部弹层（跟 K 线页那颗「配置」同一套 `.sheet`），**一行一项、不写说明**；
 *     候选列表从卡片改成三列表格。
 *
 *   ③ **「自动分析」那一格**（2026-10-15 用户：「在自动化预测中加入 tab，线上所有的已自动 ai 的显示」）
 *      —— 列出**所有**已经加入持久化分析的币（在跑的排前面，7 天内的都留着），
 *      每行是 币种 / 进度 / 最近结论，点一行**展开**：那一刻往后 1h、4h 涨了多少 + 看 K 线 / 跑一次 / 停止。
 *      数据就是 `../persist` 那个 store（跟 K 线页顶部那个图标同一份），进页时刷一次。
 *
 * ⚠️ 后面几段（定时扫描 → 快讯式判定 → App 通知）还没接：这里只解决"看清挑出来的是哪些币、
 *    参数怎么改"，以及"点一下去看图"。
 */
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {
  deleteKlineAlert,
  fetchScanPicks,
  fetchScanSettings,
  rearmKlineAlert,
  saveScanSettings,
  type KlineAlert,
  type ScanParams,
  type ScanPick,
  type ScanPicks
} from '../api'
import {bjTime, fmt, int} from '../format'
import {
  klineAlerts,
  noteAlertsChanged,
  refreshKlineAlerts
} from '../kline-alerts'
import {markdownToPlain, verdictKind} from '../markdown'
import {showToast} from '../toast'
import {
  MOBILE_MAX,
  type AutoTab,
  autoTab,
  leftTab,
  pickSymbol,
  prefetchSymbol,
  result as anaResult,
  showResult,
  showSteps,
  steps as anaSteps,
  loading as anaLoading,
  testAt,
  testBarTime,
  testMode
} from '../analyze'
import AnalysisDetail from '../comps/AnalysisDetail.vue'
import SubTabs from '../comps/SubTabs.vue'
import AnswerBody from '../comps/AnswerBody.vue'
import PredictHistory from '../comps/PredictHistory.vue'
import StepsPanel from '../comps/StepsPanel.vue'
import {
  afterCell,
  leftText,
  persistLimits,
  type PersistCadence,
  persistBusy,
  persistSessions,
  refreshPersist,
  removePersist,
  runPersistOnce,
  type PersistRow
} from '../persist'

/** 已保存的那份参数（弹层打开时拿它当草稿的底稿） */
const params = ref<ScanParams | null>(null)
const picks = ref<ScanPick[]>([])
const meta = ref<Omit<ScanPicks, 'params' | 'picks' | 'error'> | null>(null)

const loading = ref(false)
const error = ref('')

/* ---------------- 参数弹层（草稿态：关掉不保存就丢弃） ---------------- */

const sheetOpen = ref(false)
const draft = ref<ScanParams | null>(null)
const saving = ref(false)

function openSheet(): void {
  if (!params.value) return
  // 深拷一层：弹层里改了又关掉，界面上那份不能跟着变
  draft.value = {...params.value, rules: {...params.value.rules}}
  sheetOpen.value = true
}

function closeSheet(): void {
  sheetOpen.value = false
  draft.value = null
}

async function saveSheet(): Promise<void> {
  if (!draft.value) return
  saving.value = true
  error.value = ''
  try {
    params.value = (await saveScanSettings(draft.value)).params
    closeSheet()
    showToast('参数已保存')
    // 参数改了候选就变了：直接重扫，所见即所得
    await loadPicks()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

/**
 * 成交额门槛在界面上用**百万 USDT**（`3.00 M`）：原始值是 `3000000`，
 * 手机上七个数字一行放不下，也没人愿意数零。
 */
const turnoverM = computed({
  get: () => Math.round((draft.value?.minTurnover ?? 0) / 10_000) / 100,
  set: (v: number) => {
    if (draft.value) draft.value.minTurnover = Math.max(0, Math.round((Number(v) || 0) * 1e6))
  }
})

/** 主周期那排胶囊 */
const TFS = [
  {value: '15m' as const, label: '15m'},
  {value: '1h' as const, label: '1h'},
  {value: '4h' as const, label: '4h'}
]

/** 规则开关（每一行左边一个开关，右边是它自己的阈值） */
const RULES = [
  {key: 'breakout' as const, label: 'A 放量突破'},
  {key: 'dip' as const, label: 'B 深跌转折'},
  {key: 'rally' as const, label: 'C 爆拉'},
  {key: 'volume' as const, label: 'D 量能异动'}
]

/* ---------------- 「自动 AI」那一格 ---------------- */

/**
 * 四格（用户 2026-10-18）：
 *   `scan`   币种监测（原「筛选的币种」）
 *   `live`   AI分析（原一级 tab「预测结果」：本次分析 + 结论 + 预测历史）
 *   `ai`     自动分析（原「AI 分析」：持久化分析的会话）
 *   `alerts` 提醒（画线提醒）
 *
 * ⚠️ 状态放在 `../analyze` 的 `autoTab`，不在这个组件里：一级 tab 切走这里就卸载了，
 *    而「点分析 / 点 ✓」都要能把人直接送到 `live` 那一格（见 `onRun` / `confirmTestPoint`）。
 * ⚠️ 不做成 URL 参数：这一页本身就是 `/analyze?t=auto` 的一格，再加一层查询参数
 *    会跟上面那层 tab 的 `?t=` 打架（`analyze.ts` 那套只认一层）。
 */
const tab = autoTab

/** 换格（`SubTabs` 的 `update:modelValue`）—— 显式写出来，别在模板里给 ref 别名赋值 */
function setTab(v: AutoTab): void {
  autoTab.value = v
}

/** 四格（用户 2026-10-18 定的顺序）；计数当徽标挂在后面 */
const TAB_OPTIONS = computed<
  {value: AutoTab; label: string; badge?: string | number}[]
>(() => [
  {value: 'scan', label: '币种监测', badge: picks.value.length},
  {value: 'live', label: 'AI分析'},
  {value: 'ai', label: '自动分析', badge: aiRows.value.length},
  {value: 'alerts', label: '提醒', badge: activeAlerts.value.length}
])

/* ---------------- 「AI分析」那一格（原一级 tab「预测结果」） ---------------- */

/**
 * 结论卡的三样（判定色 / 收起后那一行）—— 跟原来 `AnalyzeView` 里那套一模一样，
 * 只是数据源换成了 `analyze.ts` 里导出的 `result`（改名 `anaResult`，避开这一页自己的）。
 */
const judge = computed(() => anaResult.value?.judge)
const verdict = computed(() => verdictKind(judge.value?.line ?? ''))
const summary = computed(() => markdownToPlain(judge.value?.line ?? '', 42))

/** 展开了哪个会话（一次只展开一个，手上一屏放得下两个都会把页面拉得很长） */
const expandId = ref<number | null>(null)

/** 所有会话：在跑的排前面（后端 `listSessions` 已经排好，直接用） */
const aiRows = computed<PersistRow[]>(() => persistSessions.value)

const activeCount = computed(() => aiRows.value.filter(s => s.status === 'active').length)

/**
 * 某个周期对应的节奏（模板里显示「每 15 分钟一次 / 最多 32 次」）。
 * 真源在后端 `CADENCES`，这里只是照着显示；认不出来按第一个算（老会话里可能存着 4h）。
 */
function cadOf(timeframe: string): PersistCadence {
  const list = persistLimits.value.cadences
  return list.find(c => c.timeframe === timeframe) ?? list[0]!
}

function verdictText(v: string | null | undefined): string {
  return v === 'go' ? '可做' : v === 'no' ? '不可做' : '观望'
}
function verdictClass(v: string | null | undefined): string {
  return v === 'go' ? 'go' : v === 'no' ? 'no' : 'wait'
}
/** 那一句话：抹 Markdown、压换行、截断（模型给的是一整篇，原样印出来没法看） */
function lineText(line: string | null | undefined, max = 60): string {
  return line ? markdownToPlain(line, max) : ''
}
function toggleAi(id: number): void {
  expandId.value = expandId.value === id ? null : id
}

/**
 * 点**时间线里某一条** = 看那一次的全文（列表里那句是截断的，库里存的是整篇）。
 * 这跟「预测结果」里点一行看详情是同一件事 —— 用的是同一个弹层组件。
 */
const detail = ref<{
  symbol: string
  timeframe: string
  at: string
  price: number | null
  line: string
  verdict: string | null
} | null>(null)

/** 刷新会话列表（进页 / 切格 / 点刷新都走它）；`quiet` 不走那个「读失败弹 toast」的分支 */
async function refreshAi(): Promise<void> {
  await refreshPersist(true)
}

watch(tab, t => {
  if (t === 'ai') {
    expandId.value = null
    void refreshAi()
  }
  if (t === 'alerts') void loadAlerts()
})

/* ---------------- 画线提醒（2026-10-17） ---------------- */

/**
 * 用户 2026-10-17：「点击画的线可以添加超过该线提醒，在**自动化预测**显示所有的提醒」。
 *
 * 这一格就是那块的台账：还在盯的排前面，响过的留着看「当时多少价响的」。
 * 判定在服务器（`backend/src/price-alerts.ts`）—— **网页没开也会响**，
 * 所以这里只是读列表 / 删除 / 重新盯，不用在前端盯着价格算。
 */
/**
 * ⚠️ 不在这儿自己拉一份：跟 K 线那边**共用** `../kline-alerts.ts` 那份 store。
 * 之前两边各拉各的 —— 在 K 线上加一条、这边要等 30 秒才看到；这边删一条，
 * K 线上的铃铛还挂着（用户 2026-10-17：「提醒页面和 k 线的线上提醒状态不同步」）。
 */
const alerts = klineAlerts
const alertsBusy = ref(false)
/** 这一格开着的时候每 30 秒刷一次（服务器触发的铃铛要能灭） */
let alertsTimer: ReturnType<typeof setInterval> | null = null

const activeAlerts = computed(() => alerts.value.filter(a => a.status === 'active'))

/** 顶部那三个过滤条件（全部 / 未提醒 / 已提醒） */
const alertFilter = ref<'all' | 'active' | 'done'>('all')
const filteredAlerts = computed(() => {
  const f = alertFilter.value
  if (f === 'all') return alerts.value
  return alerts.value.filter(a => (f === 'active') === (a.status === 'active'))
})

async function loadAlerts(): Promise<void> {
  alertsBusy.value = true
  try {
    await refreshKlineAlerts(true)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    alertsBusy.value = false
  }
}

async function dropAlert(id: number): Promise<void> {
  try {
    await deleteKlineAlert(id)
    /* 重拉一次让 K 线上那条线的铃铛同一步灭掉（共享 store） */
    await noteAlertsChanged()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function armAlert(id: number): Promise<void> {
  try {
    await rearmKlineAlert(id)
    await noteAlertsChanged()
  } catch (e) {
    error.value = (e as Error).message
  }
}

const alertDir = (a: KlineAlert): string => (a.op === 'below' ? '跌破' : '上穿')

/** 提醒价的小数位：跟这个价本身量级走（0.0812 显示 4 位、83000 显示 1 位） */
function alertPrice(v: number | null): string {
  return v === null ? '—' : fmt(v, v >= 100 ? 2 : v >= 1 ? 4 : 6)
}

/* ---------------- 数据 ---------------- */

async function loadPicks(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await fetchScanPicks()
    picks.value = r.picks
    params.value = r.params
    meta.value = {
      at: r.at,
      timeframe: r.timeframe,
      scanned: r.scanned,
      excludedTop: r.excludedTop,
      rankMissing: r.rankMissing,
      ruleHits: r.ruleHits,
      ms: r.ms
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onBeforeUnmount(() => {
  if (alertsTimer) clearInterval(alertsTimer)
  alertsTimer = null
})

onMounted(async () => {
  /* 三格的数据都在进页时拉一次：切过去就是现成的，不用等 */
  void refreshPersist(true)
  void loadAlerts()
  alertsTimer = setInterval(() => {
    if (tab.value === 'alerts') void loadAlerts()
  }, 30_000)
  try {
    params.value = (await fetchScanSettings()).params
  } catch (e) {
    error.value = (e as Error).message
  }
  await loadPicks()
})

/**
 * 点一行 → 跳 K 线看这个币。
 *
 * 跟「合约行情」点一行是同一个做法（`ContractsView.onPickMarket`）：
 * 先把 K 线数据预取出去（服务端走本地库，很快），再换币种；
 * **窄屏还得把左栏切到「K 线」那一格**，否则图在另一边、看不见。
 */
function openKline(base: string): void {
  prefetchSymbol(base)
  pickSymbol(base)
  if (window.innerWidth <= MOBILE_MAX) leftTab.value = 'chart'
}

/** 「现在」= 最后一根**已收盘** K 线的收盘时刻 */
const atText = computed(() => (meta.value ? bjTime(meta.value.at) : '—'))

/**
 * 表格上面那一行信息。
 *
 * ⚠️ 拼成**一整句**而不是写几个 `<span>`：模板里元素之间的空格会被 Vue 吃掉，
 *    上一版就贴成了「排掉 21 个· 140ms」。
 */
const metaText = computed(() => {
  const m = meta.value
  if (!m) return ''
  const parts = [
    m.timeframe,
    `截止 ${atText.value}`,
    `参与打分 ${int(m.scanned)} 个`,
    rangeText.value
  ]
  if (!m.rankMissing) parts.push(`排掉 ${m.excludedTop} 个`)
  parts.push(`${m.ms}ms`)
  return parts.join(' · ')
})

const rangeText = computed(() => {
  const p = params.value
  if (!p) return '—'
  return p.excludeTopRank > 0 ? `市值前 ${p.excludeTopRank} 不扫` : '不看市值排名'
})

/** 命中原因：多条时用 ` · ` 连（表格一行放得下） */
function reason(p: ScanPick): string {
  return p.ruleLabels.join(' · ')
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`
}

function pctClass(v: number): string {
  return v >= 0 ? 'up' : 'down'
}
</script>

<template>
  <!-- `.warm-skin` = 账户统计那套暖色（用户 2026-10-12：「样式更改为账户统计样式」） -->
  <div class="col auto warm-skin">
    <div v-if="error" class="error">{{ error }}</div>

    <!--
      四格（用户 2026-10-18 定的顺序）：币种监测 / AI分析 / 自动分析 / 提醒。
      ★ 「AI分析」就是原来一级 tab「预测结果」整格搬进来的那一格。
      ★ 二级 tab：一排纯文字 + 选中那颗淡琥珀高亮（见 `comps/SubTabs.vue`）。
    -->
    <SubTabs :model-value="tab" :options="TAB_OPTIONS" @update:model-value="setTab" />

    <section v-if="tab === 'scan'" class="panel">
      <div class="sec-head">
        <h2>
          币种监测
          <span class="tag">{{ picks.length }} 个</span>
        </h2>
        <div class="sec-actions">
          <button
            class="ghost tiny"
            :disabled="loading"
            title="按现在的参数重扫一轮"
            @click="loadPicks"
          >
            {{ loading ? '…' : '重扫' }}
          </button>
          <button class="ghost tiny" title="扫描参数" @click="openSheet">参数</button>
        </div>
      </div>

      <!-- 一行信息：数据截止 / 参与打分多少 / 排掉多少 / 用时（不写"这是干什么的"） -->
      <p class="meta-line">
        {{ metaText }}
        <span v-if="meta?.rankMissing" class="warn">
          · 市值排名没拉到 ⇒「市值前 N 不扫」这条没生效
        </span>
      </p>

      <p v-if="loading && !picks.length" class="dim">扫描中…</p>
      <p v-else-if="!picks.length" class="dim">这一轮没有候选（阈值偏严，或者行情真的没事）。</p>

      <div v-else class="tbl-wrap">
        <table class="pick-table">
          <thead>
            <tr>
              <th>币种</th>
              <th>原因</th>
              <th class="r">涨跌幅</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in picks"
              :key="p.symbol"
              :title="`${p.base} · 看 K 线`"
              @click="openKline(p.base)"
            >
              <td class="base">{{ p.base }}</td>
              <td class="dim">{{ reason(p) }}</td>
              <td class="r num" :class="pctClass(p.pct24)">{{ pct(p.pct24) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!--
      AI分析（原一级 tab「预测结果」）：本次分析过程 + 结论卡，下面接预测历史。
      ★ 2026-10-18 用户：「预测结果改名 ai分析，挪到自动化预测中」——
        内容整块搬过来，行为不变（跑还是走 K 线头上那颗「分析」）。
    -->
    <section v-else-if="tab === 'live'" class="live-pane">
      <!--
        测试模式：整格**只有这一条**（用户 2026-10-15：「只添加一个测试模式」）。
        ⚠️ 早先这里是 `v-if="testAt"`（跑完才有），现在按 `testMode` 出 ——
           测试模式一开就挂上，一眼看得出来「这一局不存档」：
             · 还没点线 ⇒ 提示去图上点一根；
             · 点好了   ⇒ 报出结束线那一刻；
             · 跑过之后 ⇒ 再补一句判断时点。
      -->
      <div v-if="testMode" class="test-banner">
        <b v-if="testBarTime !== null"
          >⏱ 测试模式 · 结束线 {{ bjTime(testBarTime) }}</b
        >
        <b v-else>⏱ 测试模式 · 在图上点一根 K 线定结束线</b>
        <em v-if="testAt">判断时点 {{ bjTime(testAt) }}</em>
      </div>

      <!--
        分析过程（可折叠）+ 分析结论（**不折叠**）。
        ★ 2026-10-13 用户定死了这两颗的脾气：
          · 「过程在结果出来后折叠」⇒ 面板归 `showSteps` 管：开跑时展开看进度
            （`analyze.ts` 的 `run()` 置 true），出结果自动收成一颗按钮（`onDone` 置 false）；
          · 「分析完成后不收起」⇒ 结论卡**只认 `result`**，不跟 `showSteps` 走 ——
            过程收起来之后，结论照样摊在下面（折叠的是过程，不是答案）。
        ★ 同一天还要求「分析结论加个背景块颜色即可，其余用 md 解析」——
          底色在 `.result-card`（style.css），判定色靠 `v-go` / `v-no` / `v-wait`。
      -->
      <div class="ana-block">
        <StepsPanel
          :steps="anaSteps"
          :done="!!anaResult"
          :running="anaLoading"
          :open="showSteps"
          :hint="
            testMode
              ? '点「按这段行情判断」后，这里会逐步写出：读分析预测提示词 → 拉那一刻的行情 → 拼上下文 → 调模型（测试跑不存档）。'
              : '点「AI 分析」后，这里会逐步写出：读分析预测提示词 → 拉行情 → 拼上下文 → 调模型 → 记账存档。'
          "
          @update:open="showSteps = $event"
        />

        <!--
          ★ 2026-10-13 用户：「结论也可收起」⇒ 卡的头上多一颗折叠按钮（与「分析过程」
            那颗同一副脾气）：收起后只剩一行「分析结论 + 判定那句话」，点一下摊开。
            默认展开（`showResult` 初值 true，`onDone` 里也会置回 true）。
          ★ 2026-10-03 精简（用户要求）：
          · 去掉「已存档 #N → 去复盘」那个链接
          · 去掉二级 tab 栏（原来「结论 / 市场与周期」两格）→ 结论和热度直接铺下来
          · 去掉「各周期行情」（发给 AI 的原文）那一大块
          · 去掉下面那 6 项统计（当前价 / 24h 涨跌 / 资金费率 / 拉了多少行情 /
            提示词版本 / 可用标签）—— 价格上面行情条里就有，其余与判断无关
          · **市场热度**（2026-10-11 也删了：用户「热度不要，不需要」——
            分析不取它、提示词里没有它，页面上也就没得显示）
        -->
        <section
          v-if="anaResult"
          class="result-card"
          :class="`v-${verdict}`"
        >
          <button
            type="button"
            class="result-toggle"
            :aria-expanded="showResult"
            @click="showResult = !showResult"
          >
            <span class="rt-label">分析结论</span>
            <span v-if="!showResult" class="rt-sum">{{ summary }}</span>
            <span class="rt-chev">{{ showResult ? '收起 ▴' : '▾' }}</span>
          </button>

          <!--
            ★ 2026-10-11 晚：提示词放开了输出格式 ⇒ 模型改成写小标题 + 分点 + 加粗。
            结论卡片原来是把整段当**纯文本**贴出来的（`white-space: pre-wrap`），
            于是页面上能直接看到 `#` `**` `-`。现在交给 `AnswerBody` 渲染成 HTML。
            ⚠️ 收起用 `v-show`（不是 `v-if`）：md 渲染一次就够，来回折别重渲染。
          -->
          <div v-show="showResult" class="result-body">
            <AnswerBody v-if="judge?.line" :text="judge.line" />
            <p v-else class="verdict-line">（模型没给结论）</p>
          </div>
        </section>
      </div>

      <!--
        预测历史（原「预测历史」那一格）：每次分析留下的那一句话。
        `embedded` = 嵌在会滚的父容器里 ⇒ 列表自己不再滚、不再抢高度
        （否则一页里套两层滚动条，手机上最难用）。
      -->
      <PredictHistory embedded />
    </section>

    <!-- 画线提醒：K 线图上点一条线加的「上穿 / 跌破」提醒（服务器自己盯价） -->
    <section v-else-if="tab === 'alerts'" class="panel">
      <div class="sec-head">
        <h2>
          画线提醒
          <span class="tag">{{ activeAlerts.length }} 条在盯</span>
        </h2>
        <div class="sec-actions">
          <button class="ghost tiny" :disabled="alertsBusy" title="重新拉一次" @click="loadAlerts">
            {{ alertsBusy ? '…' : '刷新' }}
          </button>
        </div>
      </div>

      <!-- 顶部过滤条件（用户 2026-10-17：「顶部添过滤条件」） -->
      <div class="seg al-filter">
        <button type="button" :class="{active: alertFilter === 'all'}" @click="alertFilter = 'all'">
          全部 <span class="tag">{{ alerts.length }}</span>
        </button>
        <button
          type="button"
          :class="{active: alertFilter === 'active'}"
          @click="alertFilter = 'active'"
        >
          未提醒 <span class="tag">{{ activeAlerts.length }}</span>
        </button>
        <button
          type="button"
          :class="{active: alertFilter === 'done'}"
          @click="alertFilter = 'done'"
        >
          已提醒 <span class="tag">{{ alerts.length - activeAlerts.length }}</span>
        </button>
      </div>

      <p v-if="!filteredAlerts.length" class="dim">
        {{ alerts.length ? '这个筛选下没有提醒。' : '还没有提醒 —— 到 K 线图上画一条线，点它一下就能加。' }}
      </p>

      <div v-else class="tbl-wrap">
        <table class="pick-table al-table">
          <thead>
            <tr>
              <th>币种</th>
              <th>方向</th>
              <th class="r">价位</th>
              <th class="r">状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="a in filteredAlerts"
              :key="a.id"
              :title="`${a.symbol} · 看 K 线`"
              @click="openKline(a.symbol)"
            >
              <td class="base">{{ a.symbol }}</td>
              <!-- 方向也用图标（上穿 ↗ / 下穿 ↘），窄屏才塞得下 -->
              <td>
                <span class="al-dir" :title="alertDir(a)">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path v-if="a.op === 'above'" d="M6 18 18 6M18 6h-7M18 6v7" />
                    <path v-else d="M6 6l12 12M18 18h-7M18 18v-7" />
                  </svg>
                </span>
              </td>
              <td class="r num">{{ alertPrice(a.price) }}</td>
              <!-- 状态只用图标（用户 2026-10-17：「状态用图标，已提醒未提醒」） -->
              <td class="r">
                <span
                  v-if="a.status === 'active'"
                  class="al-ico on"
                  :title="`未提醒（在盯 ${alertPrice(a.price)}）`"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.6 2H4.4L6 16Z" />
                    <path d="M10 20.5h4" />
                  </svg>
                </span>
                <span
                  v-else
                  class="al-ico done"
                  :title="`已提醒 ${alertPrice(a.triggeredPrice)}${
                    a.triggeredAt ? ' · ' + bjTime(a.triggeredAt).slice(5) : ''
                  }`"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M5 12.5 10 17.5 19.5 7" />
                  </svg>
                </span>
              </td>
              <!-- 动作也只用图标：重新盯 / 删除 -->
              <td class="al-acts">
                <button
                  v-if="a.status === 'triggered'"
                  class="al-btn"
                  title="重新盯（再挂回去等下一穿）"
                  aria-label="重新盯"
                  @click.stop="armAlert(a.id)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
                    <path d="M20 4.5V10h-5.5" />
                  </svg>
                </button>
                <button
                  class="al-btn del"
                  title="删掉这条提醒"
                  aria-label="删除"
                  @click.stop="dropAlert(a.id)"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h16M9.5 7V4.8h5V7M6.5 7l.9 13h9.2l.9-13" />
                  </svg>
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 自动分析：所有加入过持久化分析的币（在跑的排前面，7 天内的都留着） -->
    <section v-else class="panel">
      <div class="sec-head">
        <h2>
          自动分析
          <span class="tag">{{ activeCount }} 个在跑</span>
        </h2>
        <div class="sec-actions">
          <button
            class="ghost tiny"
            :disabled="persistBusy"
            title="重新拉一次列表"
            @click="refreshAi"
          >
            刷新
          </button>
        </div>
      </div>

      <p class="meta-line">
        选了哪个周期就按那个节奏问 AI（15m ⇒ 每 15 分钟 / 8 小时；1h ⇒ 每小时 / 16 小时）；
        只在结论**转成「可做」**时提醒（站内 + Telegram + App 推送）。
        点一行展开看时间线和当时的结论。
      </p>

      <p v-if="!aiRows.length" class="dim">
        还没有加入过 —— 到 K 线页顶部点那个循环箭头就能加入（每个币最多盯 8 小时）。
      </p>

      <div v-else class="ai-list">
        <template v-for="s in aiRows" :key="s.id">
          <div class="ai-row" :class="{open: expandId === s.id}" @click="toggleAi(s.id)">
            <div class="ai-sym">
              <b>{{ s.symbol }}</b>
              <span class="dim">{{ s.timeframe }}</span>
            </div>
            <div class="ai-prog">
              <span class="ai-st" :class="s.status === 'active' ? 'on' : 'off'">
                {{ s.status === 'active' ? '在跑' : '已结束' }}
              </span>
              <span class="dim">第 {{ s.runs }} 次</span>
              <span class="dim">每 {{ cadOf(s.timeframe).label }}一次</span>
              <span v-if="s.status === 'active'" class="dim">剩 {{ leftText(s.endsAt) }}</span>
            </div>
            <div class="ai-last">
              <span class="ps-v" :class="verdictClass(s.lastVerdict)">
                {{ verdictText(s.lastVerdict) }}
              </span>
              <span class="dim ai-line">{{ lineText(s.lastLine) || '还没跑出结论' }}</span>
            </div>
            <div class="ai-caret dim">{{ expandId === s.id ? '▴' : '▾' }}</div>
          </div>

          <div v-if="expandId === s.id" class="ai-detail">
            <p class="dim ai-next">
              <span v-if="s.status === 'active'">下一次 {{ bjTime(s.nextAt) }} · </span>
              {{ bjTime(s.startedAt) }} 起 · 每 {{ cadOf(s.timeframe).label }}一次 ·
              最多 {{ cadOf(s.timeframe).maxRuns }} 次
              <span v-if="s.endedReason"> · {{ s.endedReason }}</span>
            </p>

            <div v-if="s.timeline.length" class="ps-tl">
              <div class="ps-tl-head">
                <span>时间</span><span>档位</span><span>结论</span>
                <span class="ps-price">当时价</span><span class="ps-c1">+15分</span><span class="ps-c4">+1时</span>
              </div>
              <div
                v-for="r in [...s.timeline].reverse()"
                :key="r.id"
                class="ps-tl-row clickable"
                role="button"
                tabindex="0"
                title="点开看全文"
                @click="
                  detail = {
                    symbol: s.symbol,
                    timeframe: s.timeframe,
                    at: r.createdAt,
                    price: r.price,
                    line: r.line,
                    verdict: r.verdict
                  }
                "
                @keydown.enter.prevent="
                  detail = {
                    symbol: s.symbol,
                    timeframe: s.timeframe,
                    at: r.createdAt,
                    price: r.price,
                    line: r.line,
                    verdict: r.verdict
                  }
                "
              >
                <span class="ps-t num dim">{{ bjTime(r.createdAt).slice(5) }}</span>
                <span class="ps-v" :class="verdictClass(r.verdict)">{{ verdictText(r.verdict) }}</span>
                <span class="ps-line" :title="r.line">{{ lineText(r.line) }}</span>
                <span class="ps-price num">{{ r.price === null ? '—' : fmt(r.price, 6) }}</span>
                <span class="ps-c1 num" :class="afterCell(r, 15).cls">{{ afterCell(r, 15).text }}</span>
                <span class="ps-c4 num" :class="afterCell(r, 60).cls">{{ afterCell(r, 60).text }}</span>
              </div>
            </div>
            <p v-else class="dim">还没跑出结论 —— 15 分钟内会出第一条，也可以点「跑一次」。</p>

            <div class="ai-acts">
              <button class="ghost tiny" @click.stop="openKline(s.symbol)">看 K 线</button>
              <template v-if="s.status === 'active'">
                <button
                  class="ghost tiny"
                  :disabled="persistBusy"
                  title="不等下一个 15 分钟，现在就跑一轮"
                  @click.stop="runPersistOnce(s.id)"
                >
                  跑一次
                </button>
                <button class="ghost tiny" :disabled="persistBusy" @click.stop="removePersist(s.id)">
                  停止
                </button>
              </template>
            </div>
          </div>
        </template>
      </div>
    </section>

    <!-- 点时间线里某一条 → 那一次的全文（跟「预测结果」同一个详情组件） -->
    <AnalysisDetail
      :open="!!detail"
      :symbol="detail?.symbol ?? ''"
      :timeframe="detail?.timeframe"
      :at="detail?.at ?? null"
      :price="detail?.price ?? null"
      :line="detail?.line ?? ''"
      :verdict="detail?.verdict ?? null"
      action-text="看 K 线"
      @close="detail = null"
      @action="
        () => {
          if (detail) openKline(detail.symbol)
          detail = null
        }
      "
    />

    <!-- 参数弹层：跟 K 线页那颗「配置」同一套（`.sheet`），一行一项、不写说明 -->
    <Teleport to="body">
      <div v-if="sheetOpen" class="sheet-mask" @click="closeSheet" />
      <section v-if="sheetOpen && draft" class="sheet warm-skin" role="dialog" aria-label="扫描参数">
        <header class="sheet-head">
          <b>扫描参数</b>
          <button class="ghost tiny" title="关掉（不保存）" @click="closeSheet">✕</button>
        </header>

        <div class="sheet-row">
          <span class="rk">主周期</span>
          <div class="ctl seg">
            <button
              v-for="t in TFS"
              :key="t.value"
              type="button"
              class="ghost tiny"
              :class="{on: draft.timeframe === t.value}"
              @click="draft.timeframe = t.value"
            >
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="sheet-row">
          <span class="rk">成交额门槛</span>
          <div class="ctl">
            <input
              v-model.number="turnoverM"
              type="number"
              min="0"
              step="0.5"
              inputmode="decimal"
              title="24h 成交额低于此值的合约不进候选（单位：百万 USDT）"
            />
            <span class="unit">M</span>
          </div>
        </div>

        <div class="sheet-row">
          <span class="rk">每类取前</span>
          <div class="ctl">
            <input
              v-model.number="draft.perRule"
              type="number"
              min="1"
              max="30"
              step="1"
              inputmode="numeric"
            />
          </div>
        </div>

        <div class="sheet-row">
          <span class="rk">候选上限</span>
          <div class="ctl">
            <input
              v-model.number="draft.maxPicks"
              type="number"
              min="1"
              max="60"
              step="1"
              inputmode="numeric"
            />
          </div>
        </div>

        <div class="sheet-row">
          <span class="rk">市值前 N</span>
          <div class="ctl">
            <input
              v-model.number="draft.excludeTopRank"
              type="number"
              min="0"
              max="500"
              step="5"
              inputmode="numeric"
            />
            <span class="unit">名</span>
          </div>
        </div>

        <div class="sheet-row">
          <span class="rk">上市天数</span>
          <div class="ctl">
            <input
              v-model.number="draft.minAgeDays"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
            />
            <span class="unit">天</span>
          </div>
        </div>

        <!-- 四条规则：一行一条 —— 左边开关 + 名字，右边它自己的阈值 -->
        <div v-for="r in RULES" :key="r.key" class="sheet-row rule-row">
          <button
            type="button"
            class="switch"
            :class="{on: draft.rules[r.key]}"
            :title="draft.rules[r.key] ? '开着，点一下关掉' : '关着，点一下打开'"
            @click="draft.rules[r.key] = !draft.rules[r.key]"
          >
            <span />
          </button>
          <span class="rk">{{ r.label }}</span>

          <div class="ctl">
            <template v-if="r.key === 'breakout'">
              <span class="unit">量比 ≥</span>
              <input
                v-model.number="draft.breakoutVol"
                type="number"
                min="1"
                step="0.1"
                inputmode="decimal"
              />
            </template>
            <template v-else-if="r.key === 'dip'">
              <span class="unit">24h ≤</span>
              <input
                v-model.number="draft.dipPct"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
              />
              <span class="unit">% 量比 ≥</span>
              <input
                v-model.number="draft.dipVol"
                type="number"
                min="1"
                step="0.1"
                inputmode="decimal"
              />
            </template>
            <template v-else-if="r.key === 'rally'">
              <span class="unit">24h ≥</span>
              <input
                v-model.number="draft.rallyPct"
                type="number"
                min="0"
                step="1"
                inputmode="numeric"
              />
              <span class="unit">%</span>
            </template>
            <template v-else>
              <span class="unit">量比 ≥</span>
              <input
                v-model.number="draft.spikeVol"
                type="number"
                min="1"
                step="0.1"
                inputmode="decimal"
              />
            </template>
          </div>
        </div>

        <div class="sheet-row save-row">
          <button class="primary wide" :disabled="saving" @click="saveSheet">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>
    </Teleport>
  </div>
</template>

<style scoped>
.auto {
  gap: 6px;
}

/* 「AI分析」那一格：测试标识 + 分析过程 + 结论卡 + 预测历史，竖着排 */
.live-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/*
 * 会话列表：一行 = 币种 / 进度 / 最近结论，点一下展开时间线。
 * ⚠️ 用 grid + div 而不是 `<table>`：手机上要把四列折成两行（见下面那条媒体查询），
 *    表格的 `display` 一改就到处是坑（对齐、边框、colspan），这里没必要冒那个险。
 */
.ai-list {
  border: 1px solid var(--border);
  border-radius: 11px;
  overflow: hidden;
}

.ai-row {
  display: grid;
  grid-template-columns: 92px 168px minmax(0, 1fr) 16px;
  gap: 10px;
  align-items: center;
  padding: 10px;
  cursor: pointer;
  border-top: 1px solid var(--line);
}

.ai-row:first-child {
  border-top: 0;
}

.ai-row.open {
  background: rgba(255, 255, 255, 0.03);
}

.ai-row:active {
  background: rgba(255, 255, 255, 0.05);
}

@media (hover: hover) {
  .ai-row:hover {
    background: rgba(255, 255, 255, 0.035);
  }
}

.ai-sym {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 13px;
}

.ai-sym .dim {
  font-size: 11px;
}

.ai-prog {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  white-space: nowrap;
}

/* 「在跑 / 已结束」那个小标 */
.ai-st {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
}

.ai-st.on {
  background: var(--blue-soft);
  color: var(--blue);
}

.ai-st.off {
  background: color-mix(in srgb, var(--border) 60%, transparent);
  color: var(--muted);
}

.ai-last {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}

/* 那一句话：一行省略号（完整的那句在展开的「结论」列里） */
.ai-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-caret {
  font-size: 11px;
  text-align: right;
}

.ai-detail {
  padding: 2px 10px 12px;
  border-top: 1px dashed color-mix(in srgb, var(--border) 70%, transparent);
  background: rgba(255, 255, 255, 0.02);
}

.ai-next {
  margin: 8px 0;
  font-size: 11.5px;
}

.ai-acts {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

/*
 * 窄屏（手机）：四列折成两行 —— ① 币种 + 进度 ② 结论（整行、最多两行）。
 * 跟 K 线页那个弹层的时间线同一个思路。
 */
@media (max-width: 560px) {
  .ai-row {
    grid-template-columns: minmax(0, 1fr) auto 16px;
    grid-template-areas:
      'sym  prog  caret'
      'last last  last';
    row-gap: 6px;
  }
  .ai-sym {
    grid-area: sym;
  }
  .ai-prog {
    grid-area: prog;
  }
  .ai-last {
    grid-area: last;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    white-space: normal;
    line-height: 1.45;
  }
  .ai-last .ai-line {
    white-space: normal;
  }
  .ai-caret {
    grid-area: caret;
  }
  .ai-acts {
    flex-wrap: wrap;
  }
}

.sec-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sec-head h2 {
  margin: 0;
  font-size: 14px;
}

.sec-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

/* 数据截止那一行：小字、灰、可换行（手机上会折成两行） */
.meta-line {
  margin: 6px 0 8px;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.6;
}

.meta-line .warn {
  color: #e0a03c;
}

/*
 * 表格：账户统计那张历史表的样子 —— 一个边框 + 圆角的框，里面是细横线，
 * 字号小、数字等宽。三列：**币种 / 原因 / 涨跌幅**（用户 2026-10-12 定）。
 */
.tbl-wrap {
  border: 1px solid var(--border);
  border-radius: 11px;
  overflow: hidden;
}

.pick-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.pick-table th,
.pick-table td {
  padding: 10px;
  text-align: left;
}

.pick-table th {
  color: var(--muted);
  font-size: 11px;
  font-weight: var(--fw-normal, 400);
}

/* 点一行 = 跳 K 线 ⇒ 给个按得下去的高度 */
.pick-table tbody tr {
  cursor: pointer;
  border-top: 1px solid var(--line);
}

.pick-table tbody tr:active {
  background: rgba(255, 255, 255, 0.04);
}

@media (hover: hover) {
  .pick-table tbody tr:hover {
    background: rgba(255, 255, 255, 0.035);
  }
}

.pick-table .base {
  font-weight: var(--fw-mid, 500);
}

.pick-table .r {
  text-align: right;
}

.pick-table .num {
  font-variant-numeric: tabular-nums;
}

/*
 * 提醒那一格（2026-10-17 用户：「提示小字去掉，状态用图标，已提醒未提醒，
 * 删除换图标，顶部添过滤条件」）—— 所以这里只有图标，没有文案。
 */
.al-filter {
  margin-bottom: 10px;
}

/* 窄屏上五列要塞得下：这表格的内边距比通用那张再小一号 */
.al-table th,
.al-table td {
  padding: 9px 6px;
}
.al-table .base {
  white-space: nowrap;
}
.al-dir {
  display: inline-flex;
  color: var(--muted);
}
.al-dir svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.al-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
}
.al-ico svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* 未提醒 = 蓝色铃铛；已提醒 = 绿色勾 */
.al-ico.on {
  color: var(--blue);
  background: var(--blue-soft);
}
.al-ico.done {
  color: var(--ok);
}

.pick-table .al-acts {
  width: 1%;
  padding-left: 0;
  white-space: nowrap;
  text-align: right;
}
.al-btn {
  width: 26px;
  height: 24px;
  margin-left: 4px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--muted);
}
.al-btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.al-btn.del {
  color: var(--bad);
}
@media (hover: hover) {
  .al-btn:hover {
    color: var(--text);
    border-color: var(--blue);
    filter: none;
  }
}

.up {
  color: var(--ok);
}

.down {
  color: var(--bad);
}

/* ---------------- 参数弹层（`.sheet` 那套是全站的，这里只补尺寸） ----------------
 *
 * ★ 2026-10-12 用户：「参数弹窗 选项字体缩小，能在一行就在一行」——
 *   一条一项**钉死在一行里**（`nowrap`：标签不许换行、控件不许掉到下一行），
 *   字号整体小一号、上下留白收掉，11 行一屏基本看得完。
 *   配套：标签文案也跟着缩短（「每类取前 / 市值前 N / 上市天数」），
 *   长文案靠 `title` 兜（悬停才看得见）。
 */
.sheet-row {
  flex-wrap: nowrap;
  gap: 8px;
  padding: 7px 0;
}

.rk {
  font-size: 12.5px;
}

.sheet-row input {
  width: 64px;
  min-height: 30px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* 控件那一组也不许换行（`.ctl` 全局是 `flex-wrap: wrap`） */
.sheet-row .ctl {
  flex-wrap: nowrap;
}

/* B 那条要放两个输入框（跌幅 + 量比），窄一点才排得下 */
.rule-row input {
  width: 54px;
}

.unit {
  color: var(--muted);
  font-size: 10.5px;
  white-space: nowrap;
}

/* 规则那几行左边是开关，别跟标签挤在一起 */
.rule-row {
  gap: 6px;
}

/* 主周期那排胶囊小一号 */
.seg button {
  padding: 4px 9px;
  font-size: 11.5px;
}

/* 保存那颗也收一点（原来 40px 高在这份弹层里偏胖） */
.save-row {
  padding: 9px 0 2px;
}

.save-row .wide {
  min-height: 34px;
  font-size: 12.5px;
}

/* 主周期那排胶囊：选中的点亮（跟配置弹层里的胶囊一个样子） */
.seg button.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.save-row .wide {
  width: 100%;
}
</style>
