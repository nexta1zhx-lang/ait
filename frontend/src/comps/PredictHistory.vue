<script setup lang="ts">
/**
 * 预测历史 —— 每次分析留下的**那一句话**。
 *
 * 2026-10-11 重置：分析只输出一句话（能不能做 / 进场 / 止损），
 * 所以存档也只剩它：**币种 · 时间 · 那一句话**。
 * 筛选就两个：币种 + 时间段，别的都不需要。
 *
 * ★ 2026-10-11 晚：用户把输出格式放开之后，模型改写「小标题 + 分点」的长文，
 *   存进来的也是一整篇 ⇒ 这一列塞不下。所以这里只取**第一句**（`markdownToPlain`），
 *   想看全文去点开那条（原文照旧整段存在库里）。
 *
 * ★ 2026-10-13 用户（三项一起提的）：
 *   ①「币种搜索加下拉框」→ 筛选那颗裸输入框换成 `SymbolCombo`（列表最上面有「全部」）；
 *   ②「预测历史现在显示不全，点击弹窗显示所有内容」→ 每行**点开看全文**
 *     （列表里照旧只放 `markdownToPlain(line, 88)` 那一句，全文进弹层用 `AnswerBody` 渲染）；
 *   ③「时间显示到分钟不要多少前」→ `ago()` 换成 `bjShort()`（`MM/DD HH:mm`）。
 *     列表**自己不再滚**（整页滚），两层滚动条在手机上最难用。
 *
 * ★ 2026-10-13 晚（同一天又改一轮，用户：「预测历史汉字去掉 / 布局优化下 卡片没有对齐 /
 *   去掉分页，改为无限滚动 加 一键回顶的图标」）：
 *   ① 标题那行只剩「共 N 条」（`h2` 里的「预测历史」四个字去掉，计数挪到筛选行右端）——
 *      一级 tab 就叫「预测结果」，再写一遍标题是白占一行；
 *   ② 翻页撤掉，改**无限滚动**：`IntersectionObserver` 盯着列表末尾那颗哨兵，
 *      离视口还有 240px 就把下一页（20 条）接上来；接的时候按 id 去重，
 *      因为请求飞在半路时删过一条的话 `offset` 会偏、同一行会被拿回来两次。
 *      哨兵那儿留一颗「看更早的」当兜底（观察器没生效时还能手动点）；
 *   ③ 加一颗「回到顶部」的悬浮图标按钮（滚过列表头顶 320px 才出现），
 *      点它把**最近的那个滚动祖先**（左栏 `.scroll-body`）滚回顶 ——
 *      不写死 `window`：窄屏那一条是内容区自己滚，`window.scrollY` 永远是 0。
 *   ④ 每行 meta 里的「币种 / 时间」给了固定列宽：币种长短不一（`SENT` vs `1000BONK`）
 *      时，右半边的时间和价格会各自左右跳，一列卡片看着就不齐。
 *
 * ★ 2026-10-12：用户把「实时分析」和「预测历史」两格合并成「预测结果」，
 *   于是这个列表**挂在分析那一格的下面**（`AnalyzeView` 的左栏，`embedded` 模式）。
 *   挂上去之后它不能再自己撑高 / 自己滚 —— 外层 `.scroll-body` 已经在滚了，
 *   两层滚动条在手机上最难用（`embedded` 那个 prop 就是干这个的）。
 */
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {
  deletePrediction,
  fetchPredictions,
  type PredictionRow
} from '../api'
import {bjShort, bjTime, fmt} from '../format'
import {askConfirm} from '../confirm'
import {markdownToPlain} from '../markdown'
import {contracts} from '../store'
import SymbolCombo from './SymbolCombo.vue'
import AnswerBody from './AnswerBody.vue'

/**
 * `embedded`：嵌在**自己会滚**的父容器里（合并后的「预测结果」那一格）。
 * 这时列表不再 `flex: 1 1 auto` 撑满、也不再自己 `overflow-y: auto`。
 */
const props = withDefaults(defineProps<{embedded?: boolean}>(), {embedded: false})

/** 列表里那一行：抹成一句纯文字，太长就截断 */
function summary(line: string | null | undefined): string {
  if (!line || !line.trim()) return '（这条没留下结论）'
  return markdownToPlain(line, 88)
}

/**
 * 一次接多少条。
 *
 * ★ 2026-10-13：从「滚不到底的 50 条 + 看更早的」改成过一版翻页，
 *   当天又改回**无限滚动**（用户：「去掉分页，改为无限滚动」）。
 *   一次 20 条：手机上滑两下就到底，滚到底自动接下一批，接不上还能手动点。
 */
const PAGE = 20

/** 时间段选项 —— 「全部」给个足够大的天数，后端按 `now() - N days` 拦 */
const RANGES = [
  {value: 7, label: '7 天'},
  {value: 30, label: '30 天'},
  {value: 90, label: '90 天'},
  {value: 3650, label: '全部'}
]

const days = ref(30)
const symbolInput = ref('')
/** 点开看全文的那一条（null = 弹层关着） */
const detail = ref<PredictionRow | null>(null)
/** 整块面板：判断「滚下去多远了」用它，回顶也用它找滚动祖先 */
const panelRef = ref<HTMLElement | null>(null)
/** 列表末尾的哨兵：它一露头就接下一批 */
const sentinel = ref<HTMLElement | null>(null)
/** 真正查下去的那个币种（输入框敲回车 / 点「筛选」才生效） */
const symbol = ref('')

const rows = ref<PredictionRow[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
/** 还有没接上来的（列表长度 < 总数） */
const hasMore = computed(() => rows.value.length < total.value)
/** 还剩几条没接上来 */
const rest = computed(() => Math.max(0, total.value - rows.value.length))
/** 滚远了才把「回到顶部」露出来 */
const showTop = ref(false)

/** 筛过东西没有 —— 决定空状态那句话怎么说 */
const filtered = computed(
  () => Boolean(symbol.value) || days.value !== RANGES[1].value
)

/** 同一行别进来两次（接下一批时 `offset` 是按当前长度算的，中途删过就会偏） */
function dedupe(list: PredictionRow[]): PredictionRow[] {
  const seen = new Set<PredictionRow['id']>()
  return list.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}

/**
 * `more` = 往后接一批（不动已有的），否则从头查一遍（筛选条件变了就走这条）。
 */
async function load(more = false) {
  if (loading.value) return
  if (more && !hasMore.value) return
  loading.value = true
  error.value = ''
  try {
    const res = await fetchPredictions({
      days: days.value,
      symbol: symbol.value,
      limit: PAGE,
      offset: more ? rows.value.length : 0
    })
    rows.value = more ? dedupe([...rows.value, ...res.rows]) : res.rows
    total.value = res.total
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** 离它最近的那个「真在滚」的祖先（左栏的 `.scroll-body`） */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 4)
      return n
  }
  return null
}

function onScroll() {
  // 面板头顶滚出视口 320px（≈ 五六行）才值得给一颗回顶
  showTop.value = (panelRef.value?.getBoundingClientRect().top ?? 0) < -320
}

function toTop() {
  const sc = scrollParent(panelRef.value)
  if (sc) sc.scrollTo({top: 0, behavior: 'smooth'})
  else window.scrollTo({top: 0, behavior: 'smooth'})
}

let io: IntersectionObserver | null = null

onMounted(() => {
  void load()
  /*
   * 观察器盯着哨兵：离视口还有 240px 就预接下一批（等它真进视口再接就晚了半拍）。
   * `root: null` = 按视口算 —— 内容在 `.scroll-body` 里滚也不影响，
   * 交叉比会算上那层 `overflow` 的裁剪。
   */
  io = new IntersectionObserver(
    entries => {
      if (entries.some(e => e.isIntersecting)) void load(true)
    },
    {rootMargin: '240px 0px'}
  )
  if (sentinel.value) io.observe(sentinel.value)
  /*
   * 滚动事件不冒泡，但**捕获阶段**照样路过 document ⇒ 用 capture 监听，
   * 这样内层容器（`.scroll-body`）滚动也能收到。
   */
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  onScroll()
})

onBeforeUnmount(() => {
  document.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
  io?.disconnect()
  io = null
})

function apply() {
  symbol.value = symbolInput.value.trim().toUpperCase()
  void load()
}

/**
 * 下拉框里选中一个币（含列表最上面那颗「全部」，选中它 = 空串）。
 * 选了就直接查 —— 再从下拉框里挑完还要按一次「筛选」，那是白让人多点一下。
 */
function onPick(v: string) {
  symbolInput.value = v
  symbol.value = v.trim().toUpperCase()
  void load()
}

async function setDays(v: number) {
  days.value = v
  await load()
}

async function remove(row: PredictionRow) {
  const yes = await askConfirm({
    title: `删掉 ${row.symbol} 这条记录？`,
    body: '删了就不在预测历史里了。',
    okText: '删掉',
    danger: true
  })
  if (!yes) return
  try {
    await deletePrediction(row.id)
    rows.value = rows.value.filter(r => r.id !== row.id)
    total.value = Math.max(0, total.value - 1)
    if (detail.value?.id === row.id) detail.value = null
  } catch (e) {
    error.value = (e as Error).message
  }
}

/** 弹层里那颗「删掉这条」——删的就是打开的那一条，删完顺手把弹层关掉 */
function removeFromDetail() {
  if (detail.value) void remove(detail.value)
}
</script>

<template>
  <section
    ref="panelRef"
    class="panel hist-panel warm-skin"
    :class="{embedded: props.embedded}"
  >
    <!--
      这一行**不再有标题**：一级 tab 就叫「预测结果」，再写一遍「预测历史」是白占一行
      （用户 2026-10-13：「预测历史汉字去掉」）。计数留在筛选行最右端。
    -->
    <div class="filter-row">
      <!--
        币种筛选：`SymbolCombo`（下拉列表 + 就地搜索）。
        `all-label="全部"` 是给列表最上面那颗的 —— 空串代表不筛，
        没有它就没法从一个币回到「全部」（跟账本三格同一套用法）。
      -->
      <SymbolCombo
        v-model="symbolInput"
        :contracts="contracts"
        placeholder="全部"
        all-label="全部"
        @pick="onPick"
        @submit="apply"
      />
      <button class="ghost" :disabled="loading" @click="apply">筛选</button>
      <div class="ranges">
        <button
          v-for="r in RANGES"
          :key="r.value"
          type="button"
          class="range"
          :class="{on: days === r.value}"
          @click="setDays(r.value)"
        >
          {{ r.label }}
        </button>
      </div>
      <span class="tag count">共 {{ total }} 条</span>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <p v-else-if="loading && !rows.length" class="dim">读取中…</p>
    <p v-else-if="!rows.length" class="dim">
      {{ filtered ? '这个条件下没有记录。' : '还没有记录。跑一次分析，结论就自动存这儿了。' }}
    </p>

    <div v-else class="pred-list">
      <!--
        整行可点 = 看全文（列表里那句是截断的）。
        ⚠️ 删除键必须 `.stop`，否则点「✕」会连带把弹层也打开。
      -->
      <article
        v-for="r in rows"
        :key="r.id"
        class="row"
        role="button"
        tabindex="0"
        title="点开看全文"
        @click="detail = r"
        @keydown.enter.prevent="detail = r"
      >
        <div class="meta">
          <b class="sym-name">{{ r.symbol }}</b>
          <!-- ★ 2026-10-15 用户：「预测结果 每条数据要带周期」——
               同一个币在 15m / 1h / 4h 上结论可能正好相反，不写周期两条记录像自相矛盾 -->
          <span v-if="r.timeframe" class="tf">{{ r.timeframe }}</span>
          <span class="time" :title="bjTime(r.createdAt)">{{
            bjShort(r.createdAt)
          }}</span>
          <span v-if="r.price !== null" class="dim px">
            当时 {{ fmt(r.price) }}
          </span>
          <button
            type="button"
            class="ghost danger del"
            title="删掉这条"
            @click.stop="remove(r)"
          >
            ✕
          </button>
        </div>
        <p class="line">{{ summary(r.line) }}</p>
      </article>
    </div>

    <!--
      列表末尾的哨兵（用户 2026-10-13：「去掉分页，改为无限滚动」）。
      它一进视口 240px 内就自动接下一批；那颗按钮是兜底 ——
      观察器没生效（老 WebView / 打印）时还能手动点。
    -->
    <div ref="sentinel" class="list-end">
      <span v-if="loading && rows.length" class="dim">读取中…</span>
      <button
        v-else-if="hasMore"
        type="button"
        class="ghost tiny"
        @click="load(true)"
      >
        看更早的（还有 {{ rest }} 条）
      </button>
      <span v-else-if="rows.length" class="dim">没有更早的了</span>
    </div>

    <!-- 点一行 → 这一条的全文（列表里那句是截断的，库里存的是整篇） -->
    <Teleport to="body">
      <div v-if="detail" class="sheet-mask" @click="detail = null" />
      <section
        v-if="detail"
        class="sheet warm-skin pred-detail"
        role="dialog"
        aria-label="预测全文"
      >
        <header class="sheet-head">
          <b>{{ detail.symbol }}</b>
          <span class="dim pd-meta">
            <span v-if="detail.timeframe" class="tf">{{ detail.timeframe }}</span>
            {{ bjTime(detail.createdAt) }}
            <template v-if="detail.price !== null">
              · 当时 {{ fmt(detail.price) }}
            </template>
          </span>
          <button
            type="button"
            class="sheet-x"
            title="关闭"
            @click="detail = null"
          >
            ✕
          </button>
        </header>
        <div class="pd-body detail-body">
          <AnswerBody v-if="detail.line?.trim()" :text="detail.line" />
          <p v-else class="dim">（这条没留下结论）</p>
        </div>
        <div class="pd-foot">
          <button
            type="button"
            class="ghost danger"
            @click="removeFromDetail"
          >
            删掉这条
          </button>
        </div>
      </section>
    </Teleport>

    <!--
      回到顶部（用户 2026-10-13：「加 一键回顶的图标」）。
      固定在右下角、滚远了才出现；位置避开窄屏那颗悬浮底栏（`--tabbar-h`）。
    -->
    <button
      v-if="showTop"
      type="button"
      class="to-top"
      title="回到顶部"
      aria-label="回到顶部"
      @click="toTop"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M8 12.5V3.8M4.2 7.6 8 3.6l3.8 4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </section>
</template>

<style scoped>
.pred-list {
  /* 左栏宽度就那么大，一句话常常要换行 —— 行距松一点更好扫 */
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/*
 * ⚠️ 2026-10-13：列表**自己不再滚**（原来这里挂着 `flex: 1 1 auto` +
 *    `min-height: 0` + `overflow-y: auto`）。整页一个滚动条 ——
 *    两层滚动条在手机上最容易把人困住。
 */
.hist-panel.embedded {
  flex: 0 0 auto;
}

/*
 * 列表末尾：接下一批的哨兵。高度按按钮撑（不写死），
 * 「读取中…」和「没有更早的了」这两句也落在这儿。
 */
.list-end {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 26px;
  margin-top: 8px;
  font-size: 12px;
}

/*
 * 「回到顶部」：固定在右下角，滚远了才出现。
 * 底边让开窄屏那颗悬浮底栏（`--tabbar-h` 只在窄屏定义，桌面端取 0）。
 */
.to-top {
  position: fixed;
  right: 14px;
  bottom: calc(var(--tabbar-h, 0px) + 16px + env(safe-area-inset-bottom));
  z-index: 45;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--panel-2);
  color: var(--muted);
  cursor: pointer;
}

@media (hover: hover) {
  .to-top:hover {
    color: var(--text);
    border-color: var(--blue);
  }
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

/* 计数（原来在标题那行，标题去掉后挪到筛选行右端） */
.filter-row .count {
  margin-left: auto;
}

/*
 * 下拉框（`SymbolCombo`）：**自适应**。
 *
 * ★ 2026-10-13 用户：「币种搜索自适应」—— 原来写死 `width: 170px`，
 *   窄屏一行装不下就把「筛选」和那几个时间段挤到下一行，宽屏又白空一截。
 *   现在给它 `flex: 1 1 110px`：一行里有多少位置就吃多少（110 是最小可读宽度），
 *   装不下才换行。
 *   110 是量出来的：币种框 + 筛选 + 时间段 + 「共 N 条」在 518 宽窄屏刚好一行放得下
 *   （140 就会把「共 N 条」挤到第二行单挂一个，很难看）；到 375 才换成两行。
 */
.filter-row .combo {
  flex: 1 1 110px;
  min-width: 0;
}

.ranges {
  display: flex;
  gap: 4px;
}

.range {
  padding: 3px 9px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
}

.range.on {
  border-color: var(--blue);
  color: var(--blue);
}

.row {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  /* 整行可点 = 看全文 */
  cursor: pointer;
}

@media (hover: hover) {
  .row:hover {
    border-color: var(--blue);
  }
}

/*
 * 每行 meta 排成「币种 / 时间 / 价格 / ✕」四列。
 *
 * ⚠️ 2026-10-13（用户：「卡片没有对齐」）：原来这里是 flex + `gap`，
 *    每列的位置取决于前一列有多宽 —— 币种长短不一（`SENT` / `BTC` / `1000BONK`）
 *    时，右半边的时间和价格行行都不一样，一摞卡片看着就歪了。
 *    给前两列一个**下限**（`minmax(68px, max-content)`）就能让绝大多数行对齐，
 *    又不会把偶尔冒出来的长币种挤成省略号。
 */
.meta {
  display: grid;
  /*
   * 五列：币种 · **周期** · 时间 · 当时价 · 删除键（2026-10-15 加的周期，见模板注释）。
   * ⚠️ 列数跟 DOM 子元素数必须对得上 —— 少一列就会把「删除键」挤到第二行。
   *    前两列给下限是为了行行对齐（原来的理由见上面那段）。
   */
  grid-template-columns:
    minmax(68px, max-content) auto minmax(76px, max-content) 1fr auto;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 4px;
}

.meta .sym-name {
  font-size: 13px;
}

/* 周期小标：一眼能分出 15m / 1h / 4h 的记录 */
.meta .tf,
.pd-meta .tf {
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--muted);
  font-size: 11px;
}

.meta .px {
  font-variant-numeric: tabular-nums;
}

.meta .del {
  margin-left: auto;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1.4;
}

.line {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

<style>
/*
 * 全文弹层。
 *
 * ⚠️ 用**非 scoped** 的样式块：`Teleport to="body"` 把节点挪出了组件树，
 *    scoped 那条属性选择器就落不到它自己身上了（`.pred-detail` 挂在
 *    Teleport 里的根节点上，父组件的 scoped 也够不着）。
 *
 * `.sheet` 本身是全局体系（贴底、最多 80vh、自己滚），这里只补两处：
 * ① 头部那行是「币种 + 时间 + 价格 + ✕」四段，全局的 `space-between`
 *    会把它们摊到四边 ⇒ 改左对齐，只把 ✕ 顶到最右；
 * ② 正文那一段（`AnswerBody` 渲染的 markdown）给点内部留白 + 可滚动。
 */
.pred-detail .sheet-head {
  justify-content: flex-start;
  gap: 6px;
}

.pred-detail .sheet-head .pd-meta {
  font-size: 12px;
}

.pred-detail .sheet-head .sheet-x {
  margin-left: auto;
}

.pred-detail .pd-body {
  padding: 2px 0 6px;
  border-top: 1px solid var(--border);
}

/* 全文可能很长 —— 弹层自己滚（`.sheet` 已经 max-height: 80vh; overflow: auto） */
/*
 * ⚠️ 正文**字号**不在这里定：`.detail-body` 那套在 `style.css` 里，
 *    跟「AI 分析 / K 线弹层」的详情共用一份（用户 2026-10-15：「详情字体太大了」
 *    →「预测结果详情也小一点」）。这里只管留白，
 *    早先这里写过的 13.5px 会让两处差半号，删掉了。
 */

.pred-detail .pd-foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
</style>
