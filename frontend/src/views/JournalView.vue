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
  deleteJournalEntry,
  fetchJournal,
  polishJournal,
  saveJournalEntry,
  type Contract,
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

/** 筛选下拉要 `Contract[]`，这里只有币名 —— 补一个 `symbol` 就行（下拉只认 `base`） */
const coinOptions = computed<Contract[]>(() =>
  myCoins.value.map(base => ({base, symbol: `${base}USDT`}))
)

/**
 * 拉一页。
 * @param reset true = 回到第一页（筛选变了 / 刚存完）；false = 接着往后（「加载更多」）
 */
async function load(reset = true): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  const offset = reset ? 0 : entries.value.length
  try {
    const r = await fetchJournal({
      coin: coin.value || undefined,
      q: q.value.trim() || undefined,
      limit: PAGE,
      offset
    })
    entries.value = reset ? r.entries : [...entries.value, ...r.entries]
    total.value = r.total
    myCoins.value = r.coins
    if (reset) openId.value = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

const more = computed(() => entries.value.length < total.value)

/* 币种筛选：立刻重拉 */
watch(coin, () => void load())

/* 关键词：等一下再发（边打边搜，但别一个字一发） */
let qTimer: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (qTimer) clearTimeout(qTimer)
  qTimer = setTimeout(() => void load(), 300)
})

onMounted(() => void load())

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
} | null>(null)
const saving = ref(false)
/** 「加一个币」那颗下拉的当前值（选完就清空，它只是个选择器） */
const comboPick = ref('')

/* ---------------- AI 美化正文 ---------------- */

/** 模型整理出来的候选稿（**不落库**，用户点「用这段」才换成正文） */
const polishDraft = ref('')
const polishing = ref(false)
const polishErr = ref('')

async function beautify(): Promise<void> {
  const ed = editing.value
  if (!ed || polishing.value) return
  const text = ed.body.trim()
  if (!text) {
    showToast('先写点正文再美化', 'bad')
    return
  }
  polishing.value = true
  polishErr.value = ''
  try {
    const r = await polishJournal(text)
    if (r.error || !r.text) throw new Error(r.error || '模型没有返回内容')
    polishDraft.value = r.text
  } catch (e) {
    polishErr.value = (e as Error).message
  } finally {
    polishing.value = false
  }
}

function applyPolish(): void {
  if (!editing.value) return
  editing.value.body = polishDraft.value
  polishDraft.value = ''
  showToast('已换成整理后的版本')
}

function dropPolish(): void {
  polishDraft.value = ''
  polishErr.value = ''
}

/** 合约清单（`SymbolCombo` 要）—— 只保留 swap，跟别的页面一致 */
const swapContracts = computed(() => contracts.value.filter(c => c.symbol.endsWith('USDT')))

function startNew(): void {
  editing.value = {id: null, title: '', body: '', coins: []}
  comboPick.value = ''
  dropPolish()
}

function startEdit(e: JournalEntry): void {
  editing.value = {
    id: e.id,
    title: e.title,
    body: e.body,
    coins: e.coins.map(c => ({...c}))
  }
  comboPick.value = ''
  dropPolish()
}

function closeEditor(): void {
  editing.value = null
  dropPolish()
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
      coins: ed.coins
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
        <input v-model="q" type="text" placeholder="搜日记" />
        <button v-if="q" type="button" class="ghost tiny j-search-x" title="清掉搜索" @click="q = ''">
          ✕
        </button>
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
      <article v-for="e in entries" :key="e.id" class="j-entry">
        <div class="j-head" :class="{open: openId === e.id}" @click="toggle(e)">
          <i class="j-dot" :class="{on: openId === e.id}" />
          <span class="j-time">{{ timeLabel(e.at) }}</span>
          <span class="j-title" :class="{dim: !e.title}">{{ e.title || e.body.split('\n')[0] }}</span>
          <span class="j-caret dim">{{ openId === e.id ? '▴' : '▾' }}</span>
          <!--
            币放在**第二行**，不跟标题抢宽度 —— 手机上一行塞两三个长币名，
            标题就被挤成「按…」（展开后下面本来就逐条列着所有币）。
          -->
          <span v-if="e.coins.length" class="j-badges">
            <span v-for="c in e.coins" :key="c.base" class="j-badge">{{ c.base }}</span>
          </span>
        </div>

        <div v-if="openId === e.id" class="j-body-wrap">
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
      </article>

      <button v-if="more" type="button" class="ghost tiny j-more" :disabled="loading" @click="load(false)">
        {{ loading ? '读…' : `还有 ${total - entries.length} 条` }}
      </button>
    </div>

    <p v-else-if="!loading" class="j-empty dim">
      {{
        q || coin
          ? '这个筛选下没有日记。'
          : '还没有日记。点右边那颗加号记一条 —— 不用天天写，想到就记。'
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
          <input v-model="editing.title" type="text" placeholder="可不填" maxlength="120" />
        </div>
      </div>

      <!-- 币种放在标题下面（用户：「弹窗编辑的币种放在标题下方」） -->
      <div class="j-sec">
        <p class="j-sec-t">
          币种 <span class="dim">（最多 20 个 · 可以定住一刻，点它就跳那一刻的 K 线）</span>
        </p>
        <div class="j-add">
          <SymbolCombo
            v-model="comboPick"
            :contracts="swapContracts"
            placeholder="加一个币…"
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
            title="AI 美化：只改写法，不改事实（币种、时间、数字都原样留着）"
            @click="beautify"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7L12 3.5Z" />
              <path d="M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />
            </svg>
            <span v-if="polishing">美化中…</span>
          </button>
        </p>
        <textarea
          v-model="editing.body"
          class="j-body-input"
          rows="7"
          placeholder="怎么想的就怎么写 —— 一行一句也行"
        />

        <!-- AI 整理出来的候选稿（不落库）：看一眼，觉得好再替换 -->
        <div v-if="polishing || polishDraft || polishErr" class="j-polish">
          <div class="j-polish-h">
            <span class="j-polish-t">AI 整理后</span>
            <button
              v-if="polishDraft"
              type="button"
              class="j-polish-use"
              @click="applyPolish"
            >
              用这段
            </button>
            <button type="button" class="ghost tiny" title="不要这段" @click="dropPolish">
              ✕
            </button>
          </div>
          <p v-if="polishing" class="dim j-polish-wait">等一下，正在整理…</p>
          <p v-else-if="polishErr" class="j-polish-err">{{ polishErr }}</p>
          <AnswerBody v-else :text="polishDraft" soft-breaks />
        </div>
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
  gap: 8px;
  margin-bottom: 10px;
}
.j-search {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
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
  left: 2.5px;
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
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
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
    background: color-mix(in srgb, var(--panel-2) 70%, transparent);
  }
}
.j-head.open {
  background: color-mix(in srgb, var(--panel-2) 55%, transparent);
}
/* 圆点：钉在左边那条时间轴上；展开的那条亮起来 + 加光圈 */
.j-dot {
  position: absolute;
  left: -14px;
  top: 15px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  opacity: 0.55;
  transition:
    background 0.15s,
    box-shadow 0.15s,
    opacity 0.15s;
}
.j-dot.on {
  background: var(--blue);
  opacity: 1;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 22%, transparent);
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
  grid-column: 2 / 4;
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
}
.j-body-wrap {
  position: relative;
  margin: 0 0 10px;
  padding: 2px 10px 10px 11px;
  border-left: 2px solid color-mix(in srgb, var(--blue) 45%, transparent);
  border-radius: 0 8px 8px 0;
  background: color-mix(in srgb, var(--panel-2) 45%, transparent);
}
.j-body {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.75;
  word-break: break-word;
}
.j-body:last-child {
  margin-bottom: 0;
}
.j-notes {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
}
.j-notes li {
  display: flex;
  gap: 7px;
  align-items: baseline;
}
.j-acts {
  display: flex;
  gap: 6px;
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
