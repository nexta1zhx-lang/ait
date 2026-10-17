<script setup lang="ts">
/**
 * **交易日记**（用户 2026-10-18）。
 *
 * 用户原话：「想再加一个模块。日记模块可以加入某些币种，总结」→「是我手动写日记。
 * 也不一定是日记，有可能是一周才写一次。最后，都是按月给我汇总到一起」。
 *
 * 所以这一页是**条目式 + 月视图汇总**：
 *   · 上面一条月份切换（◀ 2026-10 ▶），中间是这个月的**自动汇总**
 *     （写了几篇 / 提到哪些币 / 这些币这个月涨跌 / 我在它们上面做了多少），
 *     外加两个**缺口提示**：交易过但没写的（最该补）、写了但没交易的；
 *   · 然后一个「本月总结」框 —— **自己写**，不接模型（用户明确说手动写）；
 *   · 下面是这个月的条目列表，点开看全文，能编辑 / 删除；
 *   · 每条可以**挂几个币**，每个币后面跟一句自己的话；点币名跳 K 线并把时间定在那一天。
 *
 * ⚠️ 全部是纯读库 / 写库（不打交易所、不计权重、不调模型），所以随便刷。
 */
import {computed, onMounted, ref, watch} from 'vue'
import {
  deleteJournalEntry,
  fetchJournal,
  fetchJournalMonths,
  saveJournalEntry,
  saveJournalSummary,
  type Contract,
  type JournalCoin,
  type JournalEntry,
  type JournalMonth
} from '../api'
import {askConfirm} from '../confirm'
import {showToast} from '../toast'
import {fmt} from '../format'
import {contracts} from '../store'
import {leftTab, prefetchSymbol, pickSymbol, chartFrom, MOBILE_MAX} from '../analyze'
import SymbolCombo from '../comps/SymbolCombo.vue'

/* ---------------- 月份 ---------------- */

/** 「这个月」是哪个月（北京时间）—— 跟后端 `bjMonthNow()` 同一口径 */
function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 「今天」是哪一天（北京时间，`YYYY-MM-DD`） */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

const month = ref(thisMonth())
const data = ref<JournalMonth | null>(null)
const loading = ref(false)
const error = ref('')
/** 有日记的那些月份（用来知道 ◀ 还能不能往前翻） */
const months = ref<string[]>([])

const monthLabel = computed(() => {
  const [y, m] = month.value.split('-')
  return `${y} 年 ${Number(m)} 月`
})

function shiftMonth(delta: number): void {
  const [y, m] = month.value.split('-').map(Number)
  const d = new Date(y!, m! - 1 + delta, 1)
  month.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * ◀ 往前翻到哪为止。
 *
 * ⚠️ 早先是「只能翻到**有日记的最早那个月**」—— 结果只要当月写过一篇，就再也翻不过去，
 * 补一篇上个月的就做不到（用户是**一周一次、甚至隔月**才写一篇）。现在改成：
 * 至少能往前 12 个月；要是更早有日记，就一路翻到那一篇为止。
 */
function minusMonths(m: string, n: number): string {
  const [y, mm] = m.split('-').map(Number)
  const d = new Date(y!, mm! - 1 - n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const canPrev = computed(() => {
  const floor12 = minusMonths(thisMonth(), 12)
  const earliest = months.value[months.value.length - 1]
  const floor = earliest && earliest < floor12 ? earliest : floor12
  return month.value > floor
})

const stats = computed(() => data.value?.stats ?? null)
const entries = computed(() => data.value?.entries ?? [])

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    data.value = await fetchJournal(month.value)
    summaryDraft.value = data.value.summary
    months.value = (await fetchJournalMonths()).months
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

watch(month, () => void load())
onMounted(() => void load())

/* ---------------- 月度总结（自己写，失焦存） ---------------- */

const summaryDraft = ref('')
const summarySaving = ref(false)
/** 刚存过 / 没改过 —— 用来在标题右边显示「已保存」 */
const summarySaved = ref(true)

async function saveSummary(): Promise<void> {
  const text = summaryDraft.value
  if (text === (data.value?.summary ?? '')) return
  summarySaving.value = true
  try {
    await saveJournalSummary(month.value, text)
    if (data.value) data.value.summary = text
    summarySaved.value = true
  } catch (e) {
    showToast(`总结没存上：${(e as Error).message}`, 'bad')
  } finally {
    summarySaving.value = false
  }
}

function onSummaryInput(): void {
  summarySaved.value = false
}

/* ---------------- 条目：展开 / 编辑 ---------------- */

const openId = ref<number | null>(null)
function toggle(e: JournalEntry): void {
  openId.value = openId.value === e.id ? null : e.id
}

/** 编辑器状态：`id` 为空 = 新建 */
const editing = ref<{
  id: number | null
  day: string
  title: string
  body: string
  coins: JournalCoin[]
} | null>(null)
const saving = ref(false)

function startNew(): void {
  editing.value = {
    id: null,
    /* 新建默认「今天」，但停在当前看的那个月时用那个月 1 号（历史上补记更顺） */
    day: month.value === thisMonth() ? today() : `${month.value}-01`,
    title: '',
    body: '',
    coins: []
  }
}

function startEdit(e: JournalEntry): void {
  editing.value = {
    id: e.id,
    day: e.day,
    title: e.title,
    body: e.body,
    coins: e.coins.map(c => ({...c}))
  }
}

function closeEditor(): void {
  editing.value = null
}

/** 加到这篇里的币（默认空备注；已经在里面的就不重复加） */
function addCoin(base: string): void {
  const ed = editing.value
  const b = String(base ?? '').trim().toUpperCase()
  if (!ed || !b) return
  if (ed.coins.some(c => c.base === b)) return
  ed.coins.push({base: b, note: ''})
}

function dropCoin(base: string): void {
  const ed = editing.value
  if (!ed) return
  ed.coins = ed.coins.filter(c => c.base !== base)
}

const comboPick = ref('')

async function submit(): Promise<void> {
  const ed = editing.value
  if (!ed || saving.value) return
  saving.value = true
  try {
    const r = await saveJournalEntry({
      id: ed.id,
      day: ed.day,
      title: ed.title,
      body: ed.body,
      coins: ed.coins
    })
    /* 后端把**那条所在月份**的最新全份一起回来了 —— 直接换上，省一次请求 */
    if (r.month === month.value) {
      data.value = r
      summaryDraft.value = r.summary
      months.value = (await fetchJournalMonths()).months
    } else {
      /* 改了日期、写到别的月份去了：跳到那个月 */
      month.value = r.month
    }
    openId.value = r.entry.id
    editing.value = null
    showToast(ed.id ? '已保存' : '已记下')
  } catch (e) {
    showToast(`没存上：${(e as Error).message}`, 'bad')
  } finally {
    saving.value = false
  }
}

async function remove(e: JournalEntry): Promise<void> {
  const ok = await askConfirm({
    title: `删掉 ${e.day} 这篇？`,
    body: [{t: e.title || '（无标题）', tone: 'num'}, {t: '删了找不回来。', tone: 'warn'}],
    okText: '删掉',
    danger: true
  })
  if (!ok) return
  try {
    await deleteJournalEntry(e.id)
    await load()
    showToast('已删除')
  } catch (err) {
    showToast(`删不掉：${(err as Error).message}`, 'bad')
  }
}

/* ---------------- 跳转：币 → K 线（定在那一天） ---------------- */

/**
 * 点一个币 —— 去 K 线看它，并且**把图定在提到它的那一天**。
 *
 * 图上的「日期选择」入口 2026-10-17 拆掉了，但 `chartFrom` 这条属性还在
 * （`KlineChart` 的 `centered` / 拉数据那套都还认它），所以这里直接写值就行。
 */
function goCoin(base: string, day?: string): void {
  prefetchSymbol(base)
  pickSymbol(base)
  if (day) chartFrom.value = `${day}T12:00`
  if (window.innerWidth <= MOBILE_MAX) leftTab.value = 'chart'
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  const wd = '日一二三四五六'[d.getDay()] ?? ''
  return `${day.slice(5).replace('-', '/')} 周${wd}`
}

function pctText(v: number | null): string {
  if (v === null) return '—'
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`
}

function pctClass(v: number | null): string {
  if (v === null) return 'dim'
  return v >= 0 ? 'up' : 'down'
}

/** 该月提到的币里，成交笔数为 0 的（只是观察） */
const idleSet = computed(() => new Set(stats.value?.idle ?? []))

/** 缺口那一行默认露几个（其余折起来，见模板里那段说明） */
const GAP_SHOW = 5
const gapAll = ref(false)
const shownMissing = computed(() => {
  const list = stats.value?.missing ?? []
  return gapAll.value ? list : list.slice(0, GAP_SHOW)
})

/** 合约清单（`SymbolCombo` 要）—— 只保留 swap，跟别的页面一致 */
const swapContracts = computed<Contract[]>(() => contracts.value)
</script>

<template>
  <div class="col journal">
    <!-- 月份切换 -->
    <div class="seg j-months">
      <button type="button" :disabled="!canPrev" title="上个月" @click="shiftMonth(-1)">
        ◀
      </button>
      <b class="j-month">{{ monthLabel }}</b>
      <button type="button" title="下个月" @click="shiftMonth(1)">▶</button>
      <button
        v-if="month !== thisMonth()"
        type="button"
        class="ghost tiny"
        title="回到这个月"
        @click="month = thisMonth()"
      >
        这个月
      </button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <!-- 这个月的自动汇总 -->
    <section class="panel">
      <div class="sec-head">
        <h2>
          {{ monthLabel }}
          <span class="tag">{{ stats?.entries ?? 0 }} 篇</span>
        </h2>
        <div class="sec-actions">
          <button class="ghost tiny" :disabled="loading" title="重新读一遍" @click="load">
            {{ loading ? '…' : '刷新' }}
          </button>
          <button class="ghost tiny" title="写一篇（今天）" @click="startNew">写一篇</button>
        </div>
      </div>

      <p class="meta-line">
        提到 {{ stats?.coins.length ?? 0 }} 个币 · 成交 {{ stats?.fills ?? 0 }} 笔 ·
        净 {{ (stats?.pnl ?? 0) >= 0 ? '+' : '−' }}{{ fmt(Math.abs(stats?.pnl ?? 0), 2) }} USDT
      </p>

      <div v-if="stats?.coins.length" class="j-chips">
        <button
          v-for="c in stats.coins"
          :key="c.base"
          type="button"
          class="j-chip"
          :title="`${c.base}：这个月 ${c.mentions} 篇提到 · 成交 ${c.fills} 笔 · 净 ${fmt(c.pnl, 2)} —— 点一下看它的 K 线`"
          @click="goCoin(c.base)"
        >
          <b>{{ c.base }}</b>
          <span class="j-cnt">{{ c.mentions }}</span>
          <span class="j-pct" :class="pctClass(c.pct)">{{ pctText(c.pct) }}</span>
          <span v-if="idleSet.has(c.base)" class="j-idle" title="这个月只是观察，没交易">只看</span>
        </button>
      </div>

      <!--
        缺口提示：**交易过、但一篇没写的币**（复盘最该补的就是这些）。
        ⚠️ 一个月可能几十个（实测 46 个），全铺出来会把面板撑爆 ——
           默认只露前 5 个（按成交笔数），其余折起来。
      -->
      <p v-if="stats?.missing.length" class="j-gap">
        <span class="j-gap-t">交易过、但没写进来：</span>
        <button
          v-for="m in shownMissing"
          :key="m.base"
          type="button"
          class="j-gap-b"
          :title="`${m.base}：这个月成交 ${m.fills} 笔 —— 点一下看它的 K 线`"
          @click="goCoin(m.base)"
        >
          {{ m.base }}<em v-if="m.fills > 1">×{{ m.fills }}</em>
        </button>
        <button
          v-if="stats.missing.length > GAP_SHOW"
          type="button"
          class="j-gap-more dim"
          @click="gapAll = !gapAll"
        >
          {{ gapAll ? '收起' : `还有 ${stats.missing.length - GAP_SHOW} 个` }}
        </button>
      </p>
    </section>

    <!-- 本月总结（自己写） -->
    <section class="panel">
      <div class="sec-head">
        <h2>本月总结</h2>
        <span class="dim j-save">
          {{ summarySaving ? '保存中…' : summarySaved ? '自动保存' : '改了还没存（离开输入框就存）' }}
        </span>
      </div>
      <textarea
        v-model="summaryDraft"
        class="j-summary"
        rows="4"
        placeholder="这个月做对了什么、哪几笔是情绪单、下个月改什么（自己写，离开输入框自动保存）"
        @input="onSummaryInput"
        @blur="saveSummary"
      />
    </section>

    <!-- 条目列表 -->
    <section class="panel">
      <p v-if="loading && !entries.length" class="dim">读日记…</p>
      <p v-else-if="!entries.length" class="dim">
        这个月还没写。点上面的「写一篇」记一条 —— 不用天天写，想到就记。
      </p>

      <article v-for="e in entries" :key="e.id" class="j-entry" :class="{open: openId === e.id}">
        <header class="j-head" @click="toggle(e)">
          <span class="j-day">{{ dayLabel(e.day) }}</span>
          <b class="j-title">{{ e.title || '（无标题）' }}</b>
          <span class="j-badges">
            <span v-for="c in e.coins" :key="c.base" class="j-badge">{{ c.base }}</span>
          </span>
          <span class="j-caret dim">{{ openId === e.id ? '▴' : '▾' }}</span>
        </header>

        <div v-if="openId === e.id" class="j-body-wrap">
          <p v-if="e.body" class="j-body">{{ e.body }}</p>
          <ul v-if="e.coins.length" class="j-notes">
            <li v-for="c in e.coins" :key="c.base">
              <button type="button" class="j-coin" @click.stop="goCoin(c.base, e.day)">
                {{ c.base }}
              </button>
              <span class="dim">{{ c.note || '（没写这一条）' }}</span>
            </li>
          </ul>
          <div class="j-acts">
            <button class="ghost tiny" @click.stop="startEdit(e)">编辑</button>
            <button class="ghost tiny" @click.stop="remove(e)">删除</button>
          </div>
        </div>
      </article>
    </section>

    <!-- 编辑器（底部弹层，跟「扫描参数」同一套 `.sheet`） -->
    <div v-if="editing" class="sheet-mask" @click="closeEditor" />
    <section v-if="editing" class="sheet" role="dialog" aria-label="写日记">
      <header class="sheet-head">
        <b>{{ editing.id ? '编辑日记' : '写一篇' }}</b>
        <button class="ghost tiny" title="关掉（不保存）" @click="closeEditor">✕</button>
      </header>

      <div class="sheet-row">
        <span class="rk">日期</span>
        <div class="ctl">
          <input v-model="editing.day" type="date" :max="thisMonth() + '-31'" />
        </div>
      </div>

      <div class="sheet-row">
        <span class="rk">标题</span>
        <div class="ctl">
          <input v-model="editing.title" type="text" placeholder="可不填" maxlength="120" />
        </div>
      </div>

      <div class="j-sec">
        <p class="j-sec-t">正文</p>
        <textarea
          v-model="editing.body"
          class="j-body-input"
          rows="7"
          placeholder="怎么想的就怎么写 —— 一行一句也行"
        />
      </div>

      <div class="j-sec">
        <p class="j-sec-t">加入币种 <span class="dim">（最多 20 个，每个可以跟一句话）</span></p>
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
            @click="goCoin(c.base, editing.day)"
          >
            {{ c.base }}
          </button>
          <input
            v-model="c.note"
            type="text"
            class="j-note-input"
            maxlength="200"
            :placeholder="`对 ${c.base} 的一句话（可不填）`"
          />
          <button type="button" class="ghost tiny" title="移出这篇" @click="dropCoin(c.base)">
            ✕
          </button>
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
.j-months {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.j-months button {
  min-width: 30px;
}
.j-month {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

/* 提到过的币：一行 chips，点一下跳 K 线 */
.j-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.j-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
}
.j-chip b {
  font-weight: var(--fw-mid, 500);
}
.j-chip .j-cnt {
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.j-chip .j-pct {
  font-variant-numeric: tabular-nums;
}
.j-chip .j-idle {
  color: var(--muted);
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 3px;
}
@media (hover: hover) {
  .j-chip:hover {
    border-color: var(--blue);
  }
}

.up {
  color: var(--ok);
}
.down {
  color: var(--bad);
}

/* 缺口那一行：交易过但没写 —— 最该补的，用警示色 */
.j-gap {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--warn, #f0b429);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.j-gap-b {
  padding: 1px 7px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
}
.j-gap-b em {
  margin-left: 3px;
  font-style: normal;
  font-size: 10px;
  opacity: 0.65;
}
.j-gap-more {
  padding: 1px 6px;
  font-size: 11px;
  border: 0;
  background: transparent;
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* 月度总结 */
.j-save {
  font-size: 11px;
}
.j-summary {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 88px;
  padding: 9px 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 9px;
}

/* 条目 */
.j-entry {
  border-top: 1px solid var(--line);
  padding: 2px 0;
}
.j-entry:first-of-type {
  border-top: none;
}
.j-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 2px;
  cursor: pointer;
}
.j-day {
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
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.j-badge {
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
  padding: 0 2px 12px 2px;
}
.j-body {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
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

/* 弹层里的币行 */
.j-sec {
  margin-top: 12px;
}
.j-sec-t {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--muted);
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
.j-note-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 9px;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 7px;
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
