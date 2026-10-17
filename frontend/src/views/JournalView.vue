<script setup lang="ts">
/**
 * **日记**（用户 2026-10-18）。
 *
 * 用户一路改下来的口径：
 *   1. 「日记模块可以加入某些币种，总结」→「是我手动写日记，不一定每天」；
 *   2. 「不要自动按月总结了，默认排版，不显示什么总结，就是每日感想，可以筛选」；
 *   3. 「**默认就是当前时刻不用写日期，有改动就更新时间**；每条日记显示到分钟级，加点区分样式整体」
 *      →「弹窗编辑的币种放在标题下方，定时刻显示的加上年月日，不需要一句话」
 *      →「全部在搜索旁边，搜索框小一点要能放在币种，笔改为加号图标」。
 *
 * 所以这一页现在：
 *   · 顶上**一行**：小搜索框 + 币种下拉（默认「全部」）+ 加号（写一条）；
 *   · 下面是**按时间倒序**的感想流水 —— 每条前面一个圆点 + `MM/DD HH:mm`（精确到分钟），
 *     这个时间就是它**最后一次被改动**的时刻（新建 = 现在，改一次变一次）；
 *   · 条目里挂的币可以**定住一刻**（年月日时分），点这个币就跳到那一刻的 K 线；
 *   · 没有月度统计、没有月度总结、没有缺口提示（那些 2026-10-18 当天就按用户要求撤了）。
 *
 * ⚠️ 全部是纯读库 / 写库（不打交易所、不计权重、不调模型），所以随便刷。
 */
import {computed, onMounted, ref, watch} from 'vue'
import {
  createJournalCategory,
  deleteJournalEntry,
  fetchJournal,
  fetchJournalCategories,
  pinJournalEntry,
  polishJournal,
  saveJournalEntry,
  type Contract,
  type JournalCategory,
  type JournalCoin,
  type JournalEntry
} from '../api'
import {askConfirm} from '../confirm'
import {showToast} from '../toast'
import {contracts} from '../store'
import {leftTab, prefetchSymbol, pickSymbol, chartFrom, MOBILE_MAX} from '../analyze'
import SymbolCombo from '../comps/SymbolCombo.vue'
import DateTimePick from '../comps/DateTimePick.vue'
import AnswerBody from '../comps/AnswerBody.vue'

/* ---------------- 列表 + 筛选 ---------------- */

/** 一页多少条（后端默认 30） */
const PAGE = 30

const entries = ref<JournalEntry[]>([])
const total = ref(0)
/** 写进过日记的那些币（筛选下拉的选项，来自后端） */
const myCoins = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const openId = ref<number | null>(null)

const q = ref('')
const coin = ref('')
/**
 * 只看某个月（`YYYY-MM`，空 = 全部）。
 * 用户 2026-10-18：「整体年月分割日记，顶部添加日历图标，筛选某个月份的」。
 */
const month = ref('')
/** 日历那个小面板开着没有 */
const calOpen = ref(false)
/** 面板里翻到哪一年 */
const calYear = ref(new Date().getFullYear())

/** 分类（用户 2026-10-18：「添加分类……分类可以有不同的颜色表示不同文件夹」） */
const categories = ref<JournalCategory[]>([])
/** 当前筛选的分类（null = 全部） */
const category = ref<number | null>(null)
/** 分类面板开着没有 */
const catOpen = ref(false)
/** 新分类可选的颜色（跟后端 `CATEGORY_COLORS` 同一套） */
const CATEGORY_COLORS = ['#f0b429', '#72d6a0', '#e08aa8', '#7aa2f7', '#c792ea', '#f07178']

/** 新增分类的草稿（默认取一个冷色，跟预设那三个错开） */
const newCatName = ref('')
const newCatColor = ref(CATEGORY_COLORS[3]!)

/** 筛选下拉要 `Contract[]`，这里只有币名 —— 补一个 `symbol` 就行（下拉只认 `base`） */
const coinOptions = computed<Contract[]>(() =>
  myCoins.value.map(base => ({base, symbol: `${base}USDT`}))
)

/**
 * 拉一页。
 * @param reset true = 回到第一页（筛选变了 / 刚存完）；false = 接着往后（「加载更多」）
 */
/**
 * 请求序号 —— **谁最后发谁算数**。
 *
 * ⚠️ 以前这里是 `if (loading.value) return`：连点两下（换币种、再点月份）时，
 *    后一次直接被丢掉，页面停在前一次的结果上。改成「每次发都记一个号，
 *    回来时号不是最新的就作废」，慢的那个回来也盖不掉新的。
 */
let loadSeq = 0

async function load(reset = true): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  error.value = ''
  const offset = reset ? 0 : entries.value.length
  try {
    const r = await fetchJournal({
      coin: coin.value || undefined,
      q: q.value.trim() || undefined,
      month: month.value || undefined,
      category: category.value || undefined,
      limit: PAGE,
      offset
    })
    if (seq !== loadSeq) return // 已经有更新的一发在路上了，这次结果扔了
    entries.value = reset ? r.entries : [...entries.value, ...r.entries]
    total.value = r.total
    myCoins.value = r.coins
    if (reset) openId.value = null
  } catch (e) {
    if (seq === loadSeq) error.value = (e as Error).message
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

const more = computed(() => entries.value.length < total.value)

/** 条目按「最后改动时间」已经倒序了 —— 这里只是切段，段之间插一条「2026 年 10 月」 */
const groups = computed(() => {
  const out: {key: string; label: string; items: JournalEntry[]}[] = []
  for (const e of entries.value) {
    const key = (e.at || '').slice(0, 7)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(e)
    else out.push({key, label: monthLabel(key), items: [e]})
  }
  return out
})

/** `2026-10` → `2026 年 10 月` */
/** 哪些年月分组被收起来了（用户 2026-10-18：「日记按年月聚集可收缩」） */
const collapsed = ref<Record<string, boolean>>({})

function toggleGroup(key: string): void {
  collapsed.value = {...collapsed.value, [key]: !collapsed.value[key]}
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-')
  if (!y || !m) return '更早'
  return `${y} 年 ${Number(m)} 月`
}

/** 日历面板里的 12 个月 */
const MONTHS = Array.from({length: 12}, (_, i) => i + 1)

function shiftCalYear(delta: number): void {
  calYear.value += delta
}

function pickMonth(m: number | ''): void {
  if (m === '') {
    month.value = ''
  } else {
    month.value = `${calYear.value}-${String(m).padStart(2, '0')}`
  }
  calOpen.value = false
}

/** 当前筛选的那个月（显示在图标旁边） */
const monthChip = computed(() => (month.value ? monthLabel(month.value) : ''))

/* ---------------- 分类 ---------------- */

async function loadCategories(): Promise<void> {
  try {
    const r = await fetchJournalCategories()
    categories.value = r.categories
  } catch {
    /* 分类拉不到不影响看条目：顶栏那颗按钮就只显示「全部」 */
  }
}

/** 当前筛选的那个分类（顶栏按钮上显示名字 + 颜色点） */
const currentCat = computed(
  () => categories.value.find(c => c.id === category.value) ?? null
)

/**
 * 「默认」分类（没选分类的条目都挂它 —— 用户 2026-10-18：「未选择就是默认分类」）。
 * 后端保证它一定存在；这里只是从列表里找出来给编辑器当默认值。
 */
const defaultCat = computed(
  () => categories.value.find(c => c.name === '默认') ?? categories.value[0] ?? null
)

/** 选一个分类（null = 全部）→ 关面板 + 重新拉第一页 */
function pickCategory(id: number | null): void {
  category.value = id
  catOpen.value = false
  void load()
}

function toggleCat(): void {
  catOpen.value = !catOpen.value
  if (catOpen.value) calOpen.value = false
}

/** 新增一个分类：建完直接选中它 */
async function addCategory(): Promise<void> {
  const name = newCatName.value.trim()
  if (!name) {
    showToast('先起个名字', 'bad')
    return
  }
  try {
    const r = await createJournalCategory({name, color: newCatColor.value})
    categories.value = [...categories.value, r.category]
    newCatName.value = ''
    pickCategory(r.category.id)
    showToast(`已新增分类「${r.category.name}」`)
  } catch (e) {
    showToast(`没加上：${(e as Error).message}`, 'bad')
  }
}

/** 置顶 / 取消置顶（列表顺序会跟着变，所以直接重拉第一页） */
async function togglePin(e: JournalEntry): Promise<void> {
  try {
    await pinJournalEntry(e.id, !e.pinned)
    await load()
    showToast(e.pinned ? '已取消置顶' : '已置顶')
  } catch (err) {
    showToast(`没改成：${(err as Error).message}`, 'bad')
  }
}

function toggleCal(): void {
  calOpen.value = !calOpen.value
  if (calOpen.value && month.value) calYear.value = Number(month.value.slice(0, 4))
}

/* 币种 / 月份筛选：立刻重拉 */
watch(coin, () => void load())
watch(month, () => void load())

/* 关键词：等一下再发（边打边搜，但别一个字一发） */
let qTimer: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (qTimer) clearTimeout(qTimer)
  qTimer = setTimeout(() => void load(), 180)
})

onMounted(() => {
  void load()
  void loadCategories()
})

function toggle(e: JournalEntry): void {
  openId.value = openId.value === e.id ? null : e.id
}

/** `2026-10-18 14:32` → `10/18 14:32`（后端给的就是北京时间，不用再算时区） */
function timeLabel(at: string): string {
  const t = (at || '').slice(5).replace('-', '/')
  return t || '—'
}

/** 定住的那一刻用在 K 线上：`2026-10-18 14:32` → `2026-10-18T14:32` */
function chartAt(at: string): string {
  return (at || '').replace(' ', 'T')
}

/* ---------------- 跳转：币 → K 线（定在那一刻） ---------------- */

/**
 * 点一个币 → 去 K 线看它，并把图**定在这个币定住的那一刻**。
 * 没定时刻就退回「这条日记的时间」。
 */
function goCoin(base: string, at: string, fallbackAt: string): void {
  prefetchSymbol(base)
  pickSymbol(base)
  const when = chartAt(at) || chartAt(fallbackAt)
  if (when) chartFrom.value = when
  if (window.innerWidth <= MOBILE_MAX) leftTab.value = 'chart'
}

/* ---------------- 编辑器 ---------------- */

const editing = ref<{
  id: number | null
  title: string
  body: string
  coins: JournalCoin[]
  /** 挂哪个分类（null = 未分类）；默认跟着当前筛选走 */
  categoryId: number | null
} | null>(null)
const saving = ref(false)
/** 「加一个币」那颗下拉的当前值（选完就清空，它只是个选择器） */
const comboPick = ref('')

/* ---------------- AI 美化正文 ---------------- */

/**
 * AI 美化（用户 2026-10-18：「ai 整理后直接替换，旁边添加撤回图标」）。
 *
 * 拿到就直接顶上正文，**不弹预览**；换之前把原文记在 `bodyBackup` 里，
 * 旁边那颗 ↩ 一键撤回。只要还有备份，「撤回」就一直挂在那儿。
 */
const polishing = ref(false)
/** 被 AI 顶掉之前的那一版（空串 = 没有可撤回的） */
const bodyBackup = ref('')

async function beautify(): Promise<void> {
  const ed = editing.value
  if (!ed || polishing.value) return
  const text = ed.body.trim()
  if (!text) {
    showToast('先写点正文再美化', 'bad')
    return
  }
  polishing.value = true
  try {
    const r = await polishJournal(text)
    if (r.error || !r.text) throw new Error(r.error || '模型没有返回内容')
    bodyBackup.value = ed.body
    ed.body = r.text
    showToast('已按 AI 整理替换（可以撤回）')
  } catch (e) {
    showToast(`没整理成：${(e as Error).message}`, 'bad')
  } finally {
    polishing.value = false
  }
}

/** 撤回：把 AI 顶掉的那一版放回去 */
function undoPolish(): void {
  if (!editing.value || !bodyBackup.value) return
  editing.value.body = bodyBackup.value
  bodyBackup.value = ''
  showToast('已撤回')
}

/** 合约清单（`SymbolCombo` 要）—— 只保留 swap，跟别的页面一致 */
const swapContracts = computed(() => contracts.value.filter(c => c.symbol.endsWith('USDT')))

function startNew(): void {
  editing.value = {
    id: null,
    title: '',
    body: '',
    coins: [],
    categoryId: category.value ?? defaultCat.value?.id ?? null
  }
  comboPick.value = ''
  bodyBackup.value = ''
}

function startEdit(e: JournalEntry): void {
  editing.value = {
    id: e.id,
    title: e.title,
    body: e.body,
    coins: e.coins.map(c => ({...c})),
    categoryId: e.category?.id ?? defaultCat.value?.id ?? null
  }
  comboPick.value = ''
  bodyBackup.value = ''
}

function closeEditor(): void {
  editing.value = null
  bodyBackup.value = ''
}

function addCoin(v: string): void {
  const ed = editing.value
  const base = String(v || '').trim().toUpperCase()
  if (!ed || !base) return
  if (ed.coins.some(c => c.base === base)) {
    showToast(`${base} 已经在里面了`)
    return
  }
  if (ed.coins.length >= 20) {
    showToast('一条最多挂 20 个币', 'bad')
    return
  }
  ed.coins.push({base, at: ''})
  comboPick.value = ''
}

function dropCoin(base: string): void {
  const ed = editing.value
  if (!ed) return
  ed.coins = ed.coins.filter(c => c.base !== base)
}

async function submit(): Promise<void> {
  const ed = editing.value
  if (!ed || saving.value) return
  if (!ed.body.trim() && !ed.title.trim()) {
    showToast('写点什么再记下来', 'bad')
    return
  }
  saving.value = true
  try {
    const r = await saveJournalEntry({
      id: ed.id,
      title: ed.title,
      body: ed.body,
      coins: ed.coins,
      categoryId: ed.categoryId
    })
    editing.value = null
    /* 存完回到第一页（时间是刚改的，一定在最上面），并把它展开 */
    q.value = ''
    coin.value = ''
    await load(true)
    openId.value = r.entry.id
    showToast(ed.id ? '已保存' : '已记下')
  } catch (e) {
    showToast(`没存上：${(e as Error).message}`, 'bad')
  } finally {
    saving.value = false
  }
}

async function remove(e: JournalEntry): Promise<void> {
  const ok = await askConfirm({
    title: `删掉 ${timeLabel(e.at)} 这条？`,
    body: [{t: e.title || e.body.split('\n')[0] || '（空）', tone: 'num'}, {t: '删了找不回来。', tone: 'warn'}],
    okText: '删掉',
    danger: true
  })
  if (!ok) return
  try {
    await deleteJournalEntry(e.id)
    entries.value = entries.value.filter(x => x.id !== e.id)
    total.value = Math.max(0, total.value - 1)
    if (openId.value === e.id) openId.value = null
    showToast('已删除')
  } catch (err) {
    showToast(`删不掉：${(err as Error).message}`, 'bad')
  }
}
</script>

<template>
  <div class="col journal">
    <!--
      一行：币种（左边、字号小一档）+ 搜索框（吃掉剩下的宽度）+ 加号。
      用户 2026-10-18：「币种选择在左边字体放小，搜日记占剩余位置」。
    -->
    <div class="j-bar">
      <SymbolCombo
        plain
        class="j-flt"
        placeholder="全部"
        all-label="全部"
        :model-value="coin"
        :contracts="coinOptions"
        @pick="v => (coin = v)"
      />
      <div class="j-search">
        <input v-model="q" type="text" placeholder="搜经验" />
        <button v-if="q" type="button" class="ghost tiny j-search-x" title="清掉搜索" @click="q = ''">
          ✕
        </button>
      </div>
      <!--
        分类（用户 2026-10-18：「文件夹放在日期左边」）。
        图标 + 当前分类的色点；点开是一条弹层：全部 / 各分类 / 新增。
      -->
      <div class="j-cat-wrap">
        <button
          type="button"
          class="ghost tiny j-cat"
          :class="{on: !!category}"
          :title="currentCat ? `只看「${currentCat.name}」` : '按分类看'"
          @click="toggleCat"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h4l2 2.4h6.6a2.2 2.2 0 0 1 2.2 2.2v7.2a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2Z" />
          </svg>
          <i v-if="currentCat" class="j-catdot" :style="{background: currentCat.color || 'var(--muted)'}" />
        </button>

        <div v-if="catOpen" class="j-cat-mask" @click="catOpen = false" />
        <div v-if="catOpen" class="j-cat-panel">
          <button
            type="button"
            class="j-cat-item"
            :class="{sel: category === null}"
            @click="pickCategory(null)"
          >
            <i class="j-catdot" style="background: var(--muted); opacity: 0.5" />
            <span>全部</span>
          </button>
          <button
            v-for="c in categories"
            :key="c.id"
            type="button"
            class="j-cat-item"
            :class="{sel: category === c.id}"
            @click="pickCategory(c.id)"
          >
            <i class="j-catdot" :style="{background: c.color || 'var(--muted)'}" />
            <span>{{ c.name }}</span>
          </button>

          <div class="j-cat-new">
            <input
              v-model="newCatName"
              type="text"
              maxlength="16"
              placeholder="新分类…"
              @keydown.enter.prevent="addCategory"
            />
            <div class="j-cat-colors">
              <button
                v-for="c in CATEGORY_COLORS"
                :key="c"
                type="button"
                class="j-cat-swatch"
                :class="{on: newCatColor === c}"
                :style="{background: c}"
                :title="`用这个颜色`"
                @click="newCatColor = c"
              />
            </div>
            <button type="button" class="ghost tiny j-cat-add" title="新增分类" @click="addCategory">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                   stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 日历：只看某个月 -->
      <div class="j-cal-wrap">
        <button
          type="button"
          class="ghost tiny j-cal"
          :class="{on: !!month}"
          :title="month ? `只看 ${monthChip}（点一下换）` : '按月份看'"
          @click="toggleCal"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="15.5" rx="2.5" />
            <path d="M3 10h18M8 3.2v3.6M16 3.2v3.6" />
          </svg>
        </button>

        <div v-if="calOpen" class="j-cal-mask" @click="calOpen = false" />
        <div v-if="calOpen" class="j-cal-panel">
          <div class="j-cal-head">
            <button type="button" class="j-cal-nav" title="上一年" @click="shiftCalYear(-1)">◀</button>
            <b>{{ calYear }}</b>
            <button type="button" class="j-cal-nav" title="下一年" @click="shiftCalYear(1)">▶</button>
          </div>
          <div class="j-cal-grid">
            <button
              v-for="m in MONTHS"
              :key="m"
              type="button"
              class="j-cal-m"
              :class="{sel: month === `${calYear}-${String(m).padStart(2, '0')}`}"
              @click="pickMonth(m)"
            >
              {{ m }} 月
            </button>
          </div>
          <button type="button" class="ghost tiny j-cal-all" @click="pickMonth('')">
            看全部
          </button>
        </div>
      </div>

      <button type="button" class="ghost tiny j-new" title="写一条（时间就是现在）" @click="startNew">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <!-- 条目：最近改动的在上，时间精确到分钟 -->
    <div v-if="entries.length" class="j-list">
      <template v-for="g in groups" :key="g.key">
        <h4 class="j-group" :class="{closed: collapsed[g.key]}" @click="toggleGroup(g.key)">
          <span class="j-group-caret">{{ collapsed[g.key] ? '▸' : '▾' }}</span>
          {{ g.label }}
          <span class="j-group-n">{{ g.items.length }} 条</span>
        </h4>
        <article
          v-for="e in g.items"
          v-show="!collapsed[g.key]"
          :key="e.id"
          class="j-entry"
          :class="{open: openId === e.id}"
        >
          <div class="j-head" @click="toggle(e)">
            <!--
              左边这颗圆点（用户 2026-10-18）：
                · 颜色 = 这条的分类色，比原来大一圈；
                · 位置钉在这一行**头上**（`.j-head` 是定位祖先），展开正文不会跟着挪；
                · 点一下 = 置顶，置顶后圆点变成一颗针。
            -->
            <button
              type="button"
              class="j-dot"
              :class="{on: openId === e.id, pinned: e.pinned}"
              :style="e.category ? {background: e.category.color} : {}"
              :title="e.pinned ? '取消置顶' : '置顶'"
              @click.stop="togglePin(e)"
            >
              <svg v-if="e.pinned" viewBox="0 0 24 24" width="11" height="11" fill="none"
                   stroke="currentColor" stroke-width="1.9" stroke-linecap="round"
                   stroke-linejoin="round" aria-hidden="true">
                <path d="M9.5 3.8h5l-.9 5 2.9 2.9v1.2H7.5v-1.2l2.9-2.9-.9-5Z" />
                <path d="M12 12.9V20" />
              </svg>
            </button>
            <span class="j-t">
              <span class="j-title" :class="{dim: !e.title}">{{ e.title || e.body.split('\n')[0] }}</span>
            </span>
            <span class="j-time">{{ timeLabel(e.at) }}</span>
            <span class="j-caret dim" :class="{up: openId === e.id}">▾</span>
            <span v-if="e.coins.length" class="j-badges">
              <span v-for="c in e.coins" :key="c.base" class="j-badge">{{ c.base }}</span>
            </span>
          </div>

          <!--
            展开用 `grid-template-rows: 0fr → 1fr` 做高度动画（用户 2026-10-18：
            「动画改为展开动画」）。所以内容得**一直在 DOM 里**（v-show，不是 v-if）。
          -->
          <div class="j-collapse" :class="{show: openId === e.id}">
            <div class="j-collapse-in">
              <div class="j-body-wrap">
                <AnswerBody v-if="e.body" class="j-body" :text="e.body" soft-breaks />
                <ul v-if="e.coins.length" class="j-notes">
                  <li v-for="c in e.coins" :key="c.base">
                    <button
                      type="button"
                      class="j-coin"
                      :title="c.at ? `看 ${c.base} 在 ${c.at} 的 K 线` : `看 ${c.base} 的 K 线（这条的时间）`"
                      @click="goCoin(c.base, c.at, e.at)"
                    >
                      {{ c.base }}
                    </button>
                    <span v-if="c.at" class="j-at dim">{{ c.at }}</span>
                  </li>
                </ul>
                <div class="j-acts">
                  <button type="button" class="ghost tiny j-act" title="编辑这一条" @click="startEdit(e)">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 20h4l10-10-4-4L4 16v4Z" />
                      <path d="M13.5 6.5l4 4" />
                    </svg>
                  </button>
                  <button type="button" class="ghost tiny j-act j-del" title="删掉这一条" @click="remove(e)">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 7h16M9.5 7V4.6h5V7M6.5 7l1 13h9l1-13" />
                      <path d="M10.5 10.5v6M13.5 10.5v6" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </article>
      </template>

      <button v-if="more" type="button" class="ghost tiny j-more" :disabled="loading" @click="load(false)">
        {{ loading ? '读…' : `还有 ${total - entries.length} 条` }}
      </button>
    </div>

    <p v-else-if="!loading" class="j-empty dim">
      {{
        q || coin || month || category
          ? `这个${month && !q && !coin && !category ? '月份' : '筛选'}下没有记录。`
          : '还没有记录。点右边那颗加号记一条 —— 不用天天写，想到就记。'
      }}
    </p>

    <!-- 编辑器（底部弹层，跟「扫描参数」同一套 `.sheet`） -->
    <div v-if="editing" class="sheet-mask" @click="closeEditor" />
    <section v-if="editing" class="sheet" role="dialog" aria-label="写日记">
      <header class="sheet-head">
        <b>{{ editing.id ? '编辑日记' : '写一条' }}</b>
        <button class="ghost tiny" title="关掉（不保存）" @click="closeEditor">✕</button>
      </header>

      <div class="sheet-row">
        <span class="rk">标题</span>
        <div class="ctl">
          <input v-model="editing.title" type="text" maxlength="120" />
        </div>
      </div>

      <!-- 分类：一条一条选（没选就是「默认」，后端兜底） -->
      <div class="j-sec">
        <p class="j-sec-t">分类</p>
        <div class="j-cat-pick">
          <button
            v-for="c in categories"
            :key="c.id"
            type="button"
            class="j-cat-chip"
            :class="{on: editing.categoryId === c.id}"
            @click="editing.categoryId = c.id"
          >
            <i class="j-catdot" :style="{background: c.color || 'var(--muted)'}" />
            {{ c.name }}
          </button>
        </div>
      </div>

      <!-- 币种放在标题下面（用户：「弹窗编辑的币种放在标题下方」） -->
      <div class="j-sec">
        <p class="j-sec-t">币种</p>
        <div class="j-add">
          <SymbolCombo
            v-model="comboPick"
            :contracts="swapContracts"
            placeholder=""
            search-placeholder=""
            @pick="addCoin"
          />
        </div>

        <div v-for="c in editing.coins" :key="c.base" class="j-coin-row">
          <button
            type="button"
            class="j-coin"
            :title="`看 ${c.base} 的 K 线`"
            @click="goCoin(c.base, c.at, '')"
          >
            {{ c.base }}
          </button>
          <DateTimePick v-model="c.at" mode="datetime" placeholder="定时刻" />
          <button type="button" class="ghost tiny" title="移出这条" @click="dropCoin(c.base)">
            ✕
          </button>
        </div>
      </div>

      <div class="j-sec">
        <p class="j-sec-t j-body-head">
          <span>正文</span>
          <button
            type="button"
            class="j-ai"
            :class="{on: polishing}"
            :disabled="polishing"
            title="AI 整理：只改写法，不改事实（币种、时间、数字都原样留着）"
            @click="beautify"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7L12 3.5Z" />
              <path d="M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />
            </svg>
            <span v-if="polishing">整理中…</span>
          </button>
          <!-- 撤回：AI 顶掉的那一版还能拿回来 -->
          <button
            v-if="bodyBackup"
            type="button"
            class="j-ai j-undo"
            title="撤回 AI 整理，恢复我原来写的"
            @click="undoPolish"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 9h9.5a5.5 5.5 0 0 1 0 11H8" />
              <path d="M7.5 5.5 4 9l3.5 3.5" />
            </svg>
          </button>
        </p>
        <textarea v-model="editing.body" class="j-body-input" rows="7" />
      </div>

      <div class="j-submit">
        <button class="ghost" :disabled="saving" @click="closeEditor">取消</button>
        <button class="btn-run" :disabled="saving" @click="submit">
          {{ saving ? '保存中…' : editing.id ? '保存' : '记下' }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 顶上一行：币种（左、小字）/ 搜索（吃满剩余）/ 加号 */
.j-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.j-search {
  position: relative;
  flex: 1 1 auto;
  min-width: 56px;
}
.j-search input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 24px 6px 9px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.j-search-x {
  position: absolute;
  right: 1px;
  top: 50%;
  transform: translateY(-50%);
  padding: 2px 4px;
}
/* 币种固定在最左、字号比正文小一档；币名长了自己截断（搜索框才是让位那个） */
.j-flt {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  font-size: 12px;
}
.j-flt :deep(.combo-plain) {
  font-size: 12px;
  padding: 5px 7px;
  /* 一行放不下也不能把「全部」折成两行（加了日历图标之后挤过） */
  white-space: nowrap;
}
.j-flt :deep(.combo-plain-t) {
  font-size: 12px;
}
.j-new {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 8px;
}

/* 条目：一条时间轴往下走，每条一个圆点 */
.j-list {
  position: relative;
  display: flex;
  flex-direction: column;
  padding-left: 14px;
}
.j-list::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 20px;
  bottom: 22px;
  width: 1px;
  background: linear-gradient(
    color-mix(in srgb, var(--border) 90%, transparent),
    color-mix(in srgb, var(--border) 25%, transparent)
  );
}
.j-entry {
  position: relative;
}
.j-head {
  /* 左边那颗圆点挂在这上面 ⇒ 展开正文时它不会跟着跑 */
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: baseline;
  column-gap: 8px;
  row-gap: 4px;
  margin: 2px 0;
  padding: 8px 8px 8px 4px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.14s;
}
@media (hover: hover) {
  .j-head:hover {
    background: color-mix(in srgb, var(--panel-2) 45%, transparent);
  }
}
/*
 * 展开 / 激活：**整条变成一张浮起来的卡**（不再是给选中行刷个底色）——
 * 用户 2026-10-18：「点击激活背景换个样式，设计一下不用拘束之前的风格」。
 */
.j-entry.open {
  /* ⚠️ 用**负外边距**往外扩会把卡片顶出内容区（用户 2026-10-18 报过），
     所以卡片就老老实实占满这一条，只上下留一点呼吸 */
  margin: 5px 0;
  padding: 5px 0;
  border-radius: 14px;
  transition:
    background 0.18s ease,
    box-shadow 0.18s ease;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--panel-2) 92%, transparent),
    color-mix(in srgb, var(--panel-2) 55%, transparent)
  );
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--blue) 20%, transparent),
    0 8px 22px rgba(0, 0, 0, 0.28);
}
.j-entry.open .j-head {
  background: transparent;
}
/*
 * 左边那颗圆点（用户 2026-10-18）：
 *   · 颜色 = 这条的分类色，比原来大一圈（11px）；
 *   · 挂在 `.j-head` 上（不是整条），所以展开正文时它**钉在原地不动**；
 *   · 点它 = 置顶；置顶后整颗变成一颗针（见模板里的 svg）。
 */
.j-dot {
  position: absolute;
  left: -14px;
  top: 9px;
  width: 11px;
  height: 11px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  /* 默认（没分类的老数据）：一圈中性灰 */
  background: color-mix(in srgb, var(--muted) 60%, transparent);
  color: var(--panel);
  cursor: pointer;
  transition:
    box-shadow 0.15s,
    transform 0.15s;
}
/* 展开那条：外面加一圈光圈（颜色仍是分类色） */
.j-dot.on {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 22%, transparent);
}
/* 置顶：不再是实心圆，变成一颗针 */
.j-dot.pinned {
  background: transparent;
  color: var(--blue);
  width: 15px;
  height: 15px;
  left: -16px;
  top: 7px;
}
@media (hover: hover) {
  .j-dot:hover {
    transform: scale(1.12);
  }
}
/*
 * 展开动画（用户 2026-10-18：「动画改为展开动画」）：高度从 0 涨到内容高度。
 * `grid-template-rows: 0fr → 1fr` 是唯一不用量高度、又不用写死 max-height 的写法；
 * 里面那层必须 `overflow: hidden; min-height: 0`，否则 0fr 也撑得住内容。
 */
.j-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}
.j-collapse.show {
  grid-template-rows: 1fr;
}
.j-collapse-in {
  min-height: 0;
  overflow: hidden;
}
.j-time {
  flex: none;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.j-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.j-badges {
  grid-column: 1 / -1;
  padding-left: 2px;
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.j-badge {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--muted);
}
.j-caret {
  flex: none;
  font-size: 11px;
  transition: transform 0.18s ease-out;
}
.j-caret.up {
  transform: rotate(180deg);
}
/*
 * 展开的正文：就是一页纸，**不加左侧色块、不加背景**（用户明确不要）。
 * 但要有**边距**（用户 2026-10-18：「正文加边距」）—— 左右各 10px，
 * 跟卡片边缘拉开，读起来才不像贴着框。
 */
.j-body-wrap {
  padding: 2px 10px 12px 10px;
}

/* 年月分割的小标题 */
/* 年月分组头：点一下收起 / 展开（用户 2026-10-18：「按年月聚集可收缩」） */
.j-group {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 16px 0 4px;
  padding-left: 2px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.j-group:first-child {
  margin-top: 2px;
}
.j-group-caret {
  width: 9px;
  font-size: 9px;
  line-height: 1;
  opacity: 0.7;
}
/* 条数：收起时也能看出里面有多少 */
.j-group-n {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}

/* 顶部那颗日历 + 它的小面板 */
.j-cal-wrap {
  position: relative;
  flex: none;
}
.j-cal {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 8px;
}
.j-cal.on {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 45%, transparent);
}
.j-cal-mask {
  position: fixed;
  inset: 0;
  z-index: 20;
}
.j-cal-panel {
  position: absolute;
  z-index: 21;
  top: calc(100% + 6px);
  right: 0;
  width: 212px;
  padding: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
}
.j-cal-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.j-cal-head b {
  flex: 1 1 auto;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.j-cal-nav {
  padding: 2px 6px;
  font-size: 11px;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.j-cal-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.j-cal-m {
  padding: 7px 0;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid transparent;
  border-radius: 7px;
}
.j-cal-m:hover {
  border-color: var(--border);
}
.j-cal-m.sel {
  color: #1a1a1a;
  background: var(--blue);
  font-weight: 600;
}
.j-cal-all {
  width: 100%;
  margin-top: 8px;
  font-size: 12px;
}

/* ---------------- 分类（顶栏那颗按钮 + 左侧弹层） ---------------- */
.j-cat-wrap {
  position: relative;
  flex: none;
}
.j-cat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 7px;
}
.j-cat.on {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 45%, transparent);
}
.j-cat-mask {
  position: fixed;
  inset: 0;
  z-index: 20;
}
.j-cat-panel {
  position: absolute;
  z-index: 21;
  top: calc(100% + 6px);
  /* 按钮已经挪到日历左边，弹层往左展开 */
  right: 0;
  width: 200px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
  max-height: 62vh;
  overflow-y: auto;
}
.j-cat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 7px;
}
.j-cat-item.sel {
  color: var(--blue);
  background: color-mix(in srgb, var(--blue) 14%, transparent);
}
/* 文件夹色点 */
.j-catdot {
  flex: none;
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.j-cat-new {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.j-cat-new input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 7px;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 7px;
}
.j-cat-colors {
  display: flex;
  gap: 3px;
}
.j-cat-swatch {
  width: 13px;
  height: 13px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
}
.j-cat-swatch.on {
  border-color: var(--text);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 16%, transparent);
}
.j-cat-add {
  display: inline-flex;
  align-items: center;
  padding: 4px 6px;
}

/* 条目头：分类点 + 标题，最右一颗置顶针 */
.j-t {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 编辑器里的分类胶囊 */
.j-cat-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.j-cat-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.j-cat-chip.on {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 45%, transparent);
  background: color-mix(in srgb, var(--blue) 12%, transparent);
}
/*
 * Markdown 的默认间距是给**结论卡**调的（段落 11px、列表 12px、条目 5px），
 * 放到日记这种「一行一句」的短段落上太空了 —— 这里整体收一半
 * （用户 2026-10-18：「md 格式的间距都这么大吗」）。
 */
.j-body :deep(p) {
  margin: 0 0 6px;
}
.j-body :deep(ul),
.j-body :deep(ol) {
  margin: 2px 0 6px;
  padding-left: 17px;
}
.j-body :deep(li) {
  margin-bottom: 2px;
}
.j-body :deep(> p:last-child) {
  margin-top: 0;
}
/* 正文里那几样 Markdown 的观感：日记这页自己定，不去改结论卡那套 */
.j-body :deep(strong) {
  font-weight: 650;
  color: var(--text);
}
.j-body :deep(h3),
.j-body :deep(h4) {
  margin: 9px 0 4px;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.45;
  color: var(--text);
}
.j-body :deep(li::marker) {
  color: var(--muted);
}
.j-body :deep(hr) {
  margin: 10px 0;
  border: 0;
  border-top: 1px solid var(--border);
}
.j-body :deep(code) {
  padding: 0 4px;
  font-size: 0.92em;
  border-radius: 4px;
  background: var(--panel-2);
}
.j-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
}
.j-body:last-child {
  margin-bottom: 0;
}
/*
 * 币种区：跟正文之间**拉一条分割线**（用户 2026-10-18：「币种区加分割」）。
 * 有没有正文都成立 —— 只有币的时候那条线就顶在最上面当个小标题栏。
 */
.j-notes {
  margin: 10px 0 10px;
  padding: 9px 0 0;
  border-top: 1px solid var(--border);
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
}
/* 正文和币种之间的间距再给足一点 */
.j-body + .j-notes {
  margin-top: 12px;
}
.j-notes li {
  display: flex;
  gap: 7px;
  align-items: baseline;
}
.j-acts {
  display: flex;
  gap: 6px;
  padding-top: 2px;
}
.j-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 7px;
}
.j-act.j-del:hover {
  color: var(--bad);
  border-color: var(--bad);
}
/* 币后面那个定住的那一刻（年月日时分） */
.j-at {
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.j-more {
  align-self: center;
  margin: 12px 0 4px;
  font-size: 12px;
}
.j-empty {
  margin: 14px 2px;
  font-size: 12.5px;
  line-height: 1.7;
}

/* 弹层里的币行 */
.j-sec {
  margin-top: 14px;
}
.j-sec-t {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--muted);
}
/* 「正文」那行：左边是字，右边是 AI 那一下 */
.j-body-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.j-ai {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font: inherit;
  font-size: 11.5px;
  color: var(--blue);
  background: color-mix(in srgb, var(--blue) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--blue) 35%, transparent);
  border-radius: 999px;
}
.j-ai:hover {
  background: color-mix(in srgb, var(--blue) 18%, transparent);
}
.j-ai.on {
  opacity: 0.6;
}
.j-ai.j-undo {
  color: var(--muted);
  background: transparent;
  border-color: var(--border);
}
.j-ai:disabled {
  cursor: default;
}

/* AI 整理出来的候选稿：一眼能分清「这不是我写的」 */
.j-polish {
  margin-top: 8px;
  padding: 8px 10px 10px;
  border: 1px dashed color-mix(in srgb, var(--blue) 40%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--blue) 6%, transparent);
}
.j-polish-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.j-polish-t {
  flex: 1 1 auto;
  font-size: 11.5px;
  color: var(--blue);
}
.j-polish-use {
  padding: 3px 10px;
  font: inherit;
  font-size: 11.5px;
  color: #1a1a1a;
  background: var(--blue);
  border: 0;
  border-radius: 999px;
}
.j-polish-wait {
  margin: 0;
  font-size: 12px;
}
.j-polish-err {
  margin: 0;
  font-size: 12px;
  color: var(--bad);
}
.j-body-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 9px 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 9px;
}
.j-add {
  margin-bottom: 8px;
}
/* 币种选择框矮一档（用户 2026-10-18：「选择框高度短一点」） */
.j-add :deep(.combo-box input) {
  padding-top: 5px;
  padding-bottom: 5px;
  font-size: 12.5px;
}
.j-add :deep(.combo-box) {
  min-height: 0;
}
.j-coin-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.j-coin {
  flex: none;
  padding: 3px 8px;
  font-size: 12px;
  font-family: var(--mono);
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--blue);
}
.j-submit {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
}
.j-submit .btn-run {
  min-width: 88px;
}

/*
 * 窄屏底栏是**悬浮层**（不贴边，真实高度 ≈ `--tabbar-h`），
 * 而分析页那几个格子是「定死高度、内容自己滚」——`#app` 上那条
 * `padding-bottom` 管不到这里，最后一句话会被底栏压住。
 * 所以在滚动内容尾巴上自己留出这一段。
 */
@media (width <= 900px) {
  .journal {
    padding-bottom: calc(var(--tabbar-h, 59px) + env(safe-area-inset-bottom, 0px) + 10px);
  }
}
</style>
