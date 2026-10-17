<script setup lang="ts">
/**
 * **自己做的**日期 / 时间选择器（用户 2026-10-18：「日期改为自定义不用系统的，
 * 目前没显示全，显示到分，…选择币种…可以固定一个时间」）。
 *
 * 为什么不用原生控件：`<input type="date">` / `type="datetime-local"` 在不同浏览器、
 * 尤其手机 App 的 WebView 里长得完全不一样，窄屏上还会被截断（用户遇到的「显示不全」）。
 * 这里就是自己画的日历格子 / 时分两列，样式跟全站一致。
 *
 * 三种模式：
 *   · `mode="date"`     → 值形如 `2026-10-18`
 *   · `mode="time"`     → 值形如 `14:30`（到分钟）
 *   · `mode="datetime"` → 值形如 `2026-10-18 14:30`（两步：先点日历，再点时分）
 *
 * 面板**就地展开**（不是浮层）—— 它主要活在底部弹层 `.sheet` 里，而 `.sheet` 是
 * `overflow:auto` 的，浮层会被裁掉。
 */
import {computed, nextTick, ref, watch} from 'vue'

const props = defineProps<{
  modelValue: string
  mode: 'date' | 'time' | 'datetime'
  /** `mode=date` 时可选的最后一天（`YYYY-MM-DD`），日记不写未来 */
  max?: string
  /** `mode=time` 没选时的兜底文案 */
  placeholder?: string
}>()

const emit = defineEmits<{(e: 'update:modelValue', v: string): void}>()

const open = ref(false)
/** `datetime` 模式分两步：先选日期，再选时分 */
const stage = ref<'date' | 'time'>('date')
const wrapEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

/* ---------------- 日期 ---------------- */

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

const WD = ['日', '一', '二', '三', '四', '五', '六']

/** 面板现在停在哪一年哪一月（打开时按当前值定） */
const viewY = ref(new Date().getFullYear())
const viewM = ref(new Date().getMonth() + 1)

const datePart = computed(() => (props.modelValue || '').slice(0, 10))
const valueDate = computed(() =>
  /^\d{4}-\d{2}-\d{2}$/.test(datePart.value) ? datePart.value : ''
)

interface Cell {
  day: string
  d: number
  inMonth: boolean
  disabled: boolean
  today: boolean
}

const cells = computed<Cell[]>(() => {
  const first = new Date(viewY.value, viewM.value - 1, 1)
  const out: Cell[] = []
  for (let i = 0; i < 42; i++) {
    const dt = new Date(viewY.value, viewM.value - 1, 1 - first.getDay() + i)
    const y = dt.getFullYear()
    const m = String(dt.getMonth() + 1).padStart(2, '0')
    const d = String(dt.getDate()).padStart(2, '0')
    const day = `${y}-${m}-${d}`
    out.push({
      day,
      d: dt.getDate(),
      inMonth: dt.getMonth() + 1 === viewM.value,
      disabled: Boolean(props.max && day > props.max),
      today: day === todayStr()
    })
  }
  return out
})

function shiftMonth(delta: number): void {
  const d = new Date(viewY.value, viewM.value - 1 + delta, 1)
  viewY.value = d.getFullYear()
  viewM.value = d.getMonth() + 1
}

/**
 * 「今」：跟点日历里今天那一格**完全一样**（`datetime` 模式下要接着去选时分，
 * 以前这里直接 emit 一个只有日期的值就收起了 —— 用户 2026-10-18：「点击今天没有跳转时间」）。
 */
function pickToday(): void {
  if (props.mode === 'datetime') {
    const t = hour.value && minute.value ? `${hour.value}:${minute.value}` : '12:00'
    emit('update:modelValue', `${todayStr()} ${t}`)
    stage.value = 'time'
    void nextTick(scrollToPicked)
    return
  }
  emit('update:modelValue', todayStr())
  open.value = false
}

function pickDay(c: Cell): void {
  if (c.disabled) return
  if (props.mode === 'datetime') {
    const t = hour.value && minute.value ? `${hour.value}:${minute.value}` : '12:00'
    emit('update:modelValue', `${c.day} ${t}`)
    stage.value = 'time'
    void nextTick(scrollToPicked)
    return
  }
  emit('update:modelValue', c.day)
  open.value = false
}

/* ---------------- 时间（时 / 分两列） ---------------- */

const HOURS = Array.from({length: 24}, (_, i) => String(i).padStart(2, '0'))
const MINS = Array.from({length: 60}, (_, i) => String(i).padStart(2, '0'))

const hour = computed(() => (props.modelValue.split(' ')[1] || '').slice(0, 2))
const minute = computed(() => (props.modelValue.split(' ')[1] || '').slice(3, 5))

const hourCol = ref<HTMLElement | null>(null)
const minCol = ref<HTMLElement | null>(null)

function pickHour(h: string): void {
  const m = minute.value || '00'
  if (props.mode === 'datetime') {
    const d = valueDate.value
    if (!d) return
    emit('update:modelValue', `${d} ${h}:${m}`)
    return
  }
  emit('update:modelValue', `${h}:${m}`)
}
function pickMin(m: string): void {
  const h = hour.value || '00'
  if (props.mode === 'datetime') {
    const d = valueDate.value
    if (!d) return
    emit('update:modelValue', `${d} ${h}:${m}`)
    open.value = false
    return
  }
  emit('update:modelValue', `${h}:${m}`)
  open.value = false
}

/** 打开时把选中项滚到中间，别让人自己找 */
function scrollToPicked(): void {
  for (const [el, idx] of [
    [hourCol.value, Number(hour.value || '0')],
    [minCol.value, Number(minute.value || '0')]
  ] as [HTMLElement | null, number][]) {
    if (!el) continue
    el.scrollTop = Math.max(0, idx * 30 - 60)
  }
}

function toggle(): void {
  open.value = !open.value
  if (!open.value) return
  stage.value = 'date'
  if (props.mode === 'date' || props.mode === 'datetime') {
    const base = valueDate.value || todayStr()
    const [y, m] = base.split('-').map(Number)
    viewY.value = y!
    viewM.value = m!
  } else {
    void nextTick(scrollToPicked)
  }
  void nextTick(reveal)
}

/** 清掉时间（挂币那行允许「不定时间」） */
function clear(): void {
  emit('update:modelValue', '')
  open.value = false
}

/** 往上找第一个「自己滚」的祖先（`.sheet` 就是） */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let e = el?.parentElement ?? null
  while (e) {
    const oy = getComputedStyle(e).overflowY
    if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight) return e
    e = e.parentElement
  }
  return null
}

/**
 * 把刚展开的面板滚进可视区。
 *
 * ⚠️ 面板是**绝对定位**的下拉，`scrollIntoView` 只认按钮本身 —— 挂币那行本来就靠下，
 *    不自己算一下的话面板会露在弹层外面（看起来像被切掉一半，实测 bottom 超出 86px）。
 */
function reveal(): void {
  const panel = panelEl.value
  const sc = scrollParent(wrapEl.value)
  if (!panel || !sc) return
  const pr = panel.getBoundingClientRect()
  const sr = sc.getBoundingClientRect()
  const pad = 10
  if (pr.bottom > sr.bottom - pad) sc.scrollTop += pr.bottom - (sr.bottom - pad)
  else if (pr.top < sr.top + pad) sc.scrollTop -= sr.top + pad - pr.top
}

/* 点外面收起来 */
watch(open, v => {
  if (!v) return
  setTimeout(() => document.addEventListener('mousedown', onDocDown), 0)
})

function onDocDown(e: MouseEvent): void {
  if (wrapEl.value && !wrapEl.value.contains(e.target as Node)) {
    open.value = false
  }
  document.removeEventListener('mousedown', onDocDown)
}

const label = computed(() => {
  if (props.mode === 'date') return props.modelValue || '选日期'
  if (props.mode === 'time') return props.modelValue || props.placeholder || '不定时间'
  return props.modelValue || props.placeholder || '定时刻'
})
</script>

<template>
  <div ref="wrapEl" class="dtp" :class="{open}">
    <button type="button" class="dtp-btn" :class="{on: open}" @click="toggle">
      <span class="dtp-v">{{ label }}</span>
      <span class="dtp-c">▾</span>
    </button>

    <div
      v-if="open && (mode === 'date' || (mode === 'datetime' && stage === 'date'))"
      ref="panelEl"
      class="dtp-panel"
    >
      <div class="dtp-head">
        <button type="button" class="dtp-nav" title="上个月" @click="shiftMonth(-1)">◀</button>
        <b>{{ viewY }} 年 {{ viewM }} 月</b>
        <button type="button" class="dtp-nav" title="下个月" @click="shiftMonth(1)">▶</button>
        <button type="button" class="dtp-nav dtp-today" title="今天" @click="pickToday">
          今
        </button>
      </div>
      <div class="dtp-wd">
        <span v-for="w in WD" :key="w">{{ w }}</span>
      </div>
      <div class="dtp-grid">
        <button
          v-for="c in cells"
          :key="c.day"
          type="button"
          class="dtp-cell"
          :class="{out: !c.inMonth, sel: c.day === modelValue, td: c.today, dis: c.disabled}"
          :disabled="c.disabled"
          @click="pickDay(c)"
        >
          {{ c.d }}
        </button>
      </div>
    </div>

    <div v-else-if="open" ref="panelEl" class="dtp-panel dtp-time">
      <div ref="hourCol" class="dtp-col">
        <button
          v-for="h in HOURS"
          :key="h"
          type="button"
          class="dtp-num"
          :class="{sel: h === hour}"
          @click="pickHour(h)"
        >
          {{ h }}
        </button>
      </div>
      <span class="dtp-sep">:</span>
      <div ref="minCol" class="dtp-col">
        <button
          v-for="m in MINS"
          :key="m"
          type="button"
          class="dtp-num"
          :class="{sel: m === minute}"
          @click="pickMin(m)"
        >
          {{ m }}
        </button>
      </div>
      <div class="dtp-side">
        <button
          v-if="mode === 'datetime'"
          type="button"
          class="dtp-back"
          title="回去改日期"
          @click="stage = 'date'"
        >
          ◀
        </button>
        <button type="button" class="dtp-clear" title="不定时刻" @click="clear">✕</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dtp {
  position: relative;
  flex: none;
}
/*
 * 展开时把整块抬起来 —— 弹层里同级的 `.j-add`（币种下拉）、后面几行币都是
 * `position: relative`，不抬的话日历/时分面板会被它们盖住、点不动。
 */
.dtp.open {
  z-index: 30;
}

.dtp-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--text);
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  white-space: nowrap;
}
.dtp-btn.on,
.dtp-btn:hover {
  border-color: var(--blue);
}
.dtp-c {
  font-size: 10px;
  color: var(--muted);
}

/* 面板就地展开（浮层会被 `.sheet` 的 overflow 裁掉） */
.dtp-panel {
  position: absolute;
  z-index: 31;
  top: calc(100% + 4px);
  left: 0;
  width: 232px;
  padding: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
}
.dtp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.dtp-head b {
  flex: 1 1 auto;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.dtp-nav {
  flex: none;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.dtp-today {
  color: var(--blue);
}
.dtp-wd,
.dtp-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.dtp-wd span {
  text-align: center;
  font-size: 10px;
  color: var(--muted);
  padding-bottom: 2px;
}
.dtp-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  /*
   * ⚠️ 必须自己把 padding 清掉：全站 button 默认 `padding: 9px 20px`，
   *   7 列格子每格撑到 55px，整张日历比面板还宽 —— 右边三列直接被裁掉，
   *   看着就是「字没居中」（2026-10-18 用户报的）。
   */
  min-width: 0;
  padding: 0;
  height: 26px;
  font: inherit;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.dtp-cell:hover {
  background: var(--panel-2);
}
.dtp-cell.out {
  color: var(--muted);
  opacity: 0.45;
}
.dtp-cell.td {
  color: var(--blue);
}
.dtp-cell.sel {
  background: var(--blue);
  color: #fff;
}
.dtp-cell.dis {
  opacity: 0.25;
}

/* 时间：时分两列，各自滚 */
.dtp-time {
  width: auto;
  display: flex;
  align-items: stretch;
  gap: 4px;
}
.dtp-col {
  width: 42px;
  max-height: 168px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  scrollbar-width: none;
}
.dtp-col::-webkit-scrollbar {
  width: 0;
}
.dtp-num {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 0;
  height: 28px;
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text);
  background: transparent;
  border: 0;
  border-radius: 6px;
}
.dtp-num:hover {
  background: var(--panel-2);
}
.dtp-num.sel {
  background: var(--blue);
  color: #fff;
}
.dtp-sep {
  align-self: center;
  font-size: 12px;
  color: var(--muted);
}
.dtp-side {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-self: flex-start;
}
.dtp-clear,
.dtp-back {
  padding: 2px 4px;
  font-size: 11px;
  color: var(--muted);
  background: transparent;
  border: 0;
}
.dtp-back {
  color: var(--blue);
}
</style>
