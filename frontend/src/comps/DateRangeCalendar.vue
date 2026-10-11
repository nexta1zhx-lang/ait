<script setup lang="ts">
/**
 * **日期区间日历** —— 全站共用这一份。
 *
 * ★ 2026-10-12：原本只有「账户统计」那个日期弹层里有（月历 + 快捷项 + 清除/应用），
 *   用户要求用量统计的日期输入框也用**同一颗**（「日历复用的是账户统计的日历」），
 *   所以把那一套（版式 + 选中逻辑）原样抽到这里，两处共用：
 *   · `UsageView` —— 「模型配置 → 用量统计」那颗带日历图标的输入框，点开就是它；
 *   · `AccountStatsView` —— 账户统计的日期弹层（原来是内联的，现在改成挂这个组件）。
 *
 * 交互（跟原来那套一模一样）：
 *   ① 点一天 = 起点，再点一天 = 终点（第二次点得比起点早，就重新当起点）；
 *   ② 快捷项按「最近 N 天（含今天）」算，`days: null` = 清空（全部）；
 *   ③ 选完**不立刻生效**，点「应用」才 `emit('apply')` —— 这点跟账户统计那边一致
 *      （那边是弹层，误点不该改数据）。
 */
import {computed, ref, watch} from 'vue'

const props = withDefaults(
  defineProps<{
    /** 已生效的区间（`YYYY-MM-DD`；空串 = 没选 / 全部） */
    from?: string
    to?: string
    /** 快捷项；`days` = 最近 N 天（含今天），`null` = 清空 */
    quick?: {label: string; days: number | null}[]
    /** 左下角那颗按钮的字；给 `null` 就不显示那颗（用量页用不到「清除」） */
    clearText?: string | null
  }>(),
  {
    from: '',
    to: '',
    quick: () => [
      {label: '近 7 天', days: 7},
      {label: '近 30 天', days: 30},
      {label: '近 90 天', days: 90},
      {label: '全部', days: null}
    ],
    clearText: '清除日期'
  }
)

const emit = defineEmits<{
  apply: [{from: string; to: string}]
  clear: []
  /**
   * 草稿变了（还没点「应用」）。给**需要在别处显示「起点 → 终点」**的宿主用
   * （账户统计那个弹层的标题就是这么写的）。
   */
  change: [{from: string; to: string}]
}>()

/* ---------------- 北京自然日 ---------------- */

/** `YYYY-MM-DD`（北京） */
function dateKey(d: Date): string {
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0')
  ].join('-')
}

/** 北京「今天」，还是拿 UTC 那个 Date 装（只是把日期字段当游标用） */
function beijingToday(): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .format(new Date())
    .split('-')
    .map(Number)
  return new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!))
}

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

/* ---------------- 草稿状态（选完点「应用」才生效） ---------------- */

const draftFrom = ref(props.from)
const draftTo = ref(props.to)
const calendarMonth = ref(monthStart(beijingToday()))

function seed(): void {
  draftFrom.value = props.from
  draftTo.value = props.to
  const base = props.from || dateKey(beijingToday())
  const parts = base.split('-').map(Number)
  calendarMonth.value = monthStart(
    new Date(Date.UTC(parts[0]!, (parts[1] ?? 1) - 1, 1))
  )
}
seed()
watch(() => [props.from, props.to], seed)

/* ---------------- 月历 ---------------- */

const monthLabel = computed(
  () => `${calendarMonth.value.getUTCFullYear()}年${calendarMonth.value.getUTCMonth() + 1}月`
)

/** 固定铺 42 格（6 周）—— 前后补上邻月的日子，灰掉但可点 */
const calendarCells = computed(() => {
  const first = monthStart(calendarMonth.value)
  const mondayOffset = (first.getUTCDay() + 6) % 7
  const selectedFrom = draftFrom.value
  const selectedTo = draftTo.value
  const today = dateKey(beijingToday())
  return Array.from({length: 42}, (_, index) => {
    const date = new Date(first)
    date.setUTCDate(index - mondayOffset + 1)
    const key = dateKey(date)
    return {
      key,
      day: date.getUTCDate(),
      currentMonth: date.getUTCMonth() === first.getUTCMonth(),
      today: key === today,
      selected: key === selectedFrom || key === selectedTo,
      inRange: Boolean(selectedFrom && selectedTo && key > selectedFrom && key < selectedTo)
    }
  })
})

/** 当前草稿正好等于哪个快捷项（用来点亮那颗按钮） */
const activeQuick = computed(() => {
  if (!draftFrom.value && !draftTo.value) return 'all'
  const end = beijingToday()
  const endKey = dateKey(end)
  for (const q of props.quick) {
    if (q.days === null) continue
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - q.days + 1)
    if (draftFrom.value === dateKey(start) && draftTo.value === endKey)
      return String(q.days)
  }
  return ''
})

function chooseQuick(days: number | null): void {
  if (days === null) {
    draftFrom.value = ''
    draftTo.value = ''
    calendarMonth.value = monthStart(beijingToday())
    return
  }
  const end = beijingToday()
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - days + 1)
  draftFrom.value = dateKey(start)
  draftTo.value = dateKey(end)
  calendarMonth.value = monthStart(start)
}

function shiftMonth(delta: number): void {
  const next = new Date(calendarMonth.value)
  next.setUTCMonth(next.getUTCMonth() + delta)
  calendarMonth.value = monthStart(next)
}

function chooseDate(key: string): void {
  if (!draftFrom.value || draftTo.value || key < draftFrom.value) {
    draftFrom.value = key
    draftTo.value = ''
    return
  }
  draftTo.value = key
}

watch([draftFrom, draftTo], () =>
  emit('change', {from: draftFrom.value, to: draftTo.value})
)

function apply(): void {
  emit('apply', {from: draftFrom.value, to: draftTo.value})
}

function clear(): void {
  draftFrom.value = ''
  draftTo.value = ''
  emit('clear')
}
</script>

<template>
  <div class="cal">
    <nav v-if="quick.length" class="quick-ranges" aria-label="快捷日期范围">
      <button
        v-for="q in quick"
        :key="q.label"
        type="button"
        :class="{active: activeQuick === String(q.days)}"
        @click="chooseQuick(q.days)"
      >
        {{ q.label }}
      </button>
    </nav>

    <div class="calendar-head">
      <button type="button" aria-label="上个月" @click="shiftMonth(-1)">‹</button>
      <strong>{{ monthLabel }}</strong>
      <button type="button" aria-label="下个月" @click="shiftMonth(1)">›</button>
    </div>

    <div class="calendar-grid">
      <span v-for="day in ['一', '二', '三', '四', '五', '六', '日']" :key="day" class="weekday">
        {{ day }}
      </span>
      <button
        v-for="cell in calendarCells"
        :key="cell.key"
        type="button"
        class="calendar-day"
        :class="{
          outside: !cell.currentMonth,
          selected: cell.selected,
          inRange: cell.inRange,
          today: cell.today
        }"
        @click="chooseDate(cell.key)"
      >
        {{ cell.day }}
      </button>
    </div>

    <footer class="cal-actions">
      <button v-if="clearText" type="button" class="clear-range" @click="clear">
        {{ clearText }}
      </button>
      <span class="spacer" />
      <button type="button" class="apply-range" @click="apply">应用</button>
    </footer>
  </div>
</template>

<style scoped>
/*
 * ⚠️ 这一整套是从 `AccountStatsView.vue` 里**原样搬过来**的（版式不许走样：
 *    那颗日历是用户定的样子）。搬过来之后两处共用，别再各写一份。
 */
.cal {
  display: block;
}

.quick-ranges {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 0 0 12px;
}

.quick-ranges button {
  min-height: 32px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: linear-gradient(135deg, #17191d, #171513);
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}

.quick-ranges button.active {
  border-color: var(--accent-line);
  background: linear-gradient(112deg, rgba(255, 217, 158, 0.19), rgba(243, 154, 63, 0.08));
  color: #ffd291;
}

.calendar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.calendar-head strong {
  font-size: 13px;
}

.calendar-head button {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: linear-gradient(135deg, rgb(39, 39, 40), rgb(39, 30, 21));
  color: var(--text);
  font-size: 21px;
  line-height: 1;
  cursor: pointer;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px 2px;
  padding: 7px 5px;
  border: 1px solid rgb(68, 65, 64);
  border-radius: 12px;
  background: linear-gradient(145deg, #101216, #11100f);
}

.weekday {
  padding: 5px 0;
  color: var(--muted);
  font-size: 10px;
  text-align: center;
}

.calendar-day {
  position: relative;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: linear-gradient(145deg, rgb(24, 27, 33), rgb(24, 20, 18));
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}

.calendar-day:hover {
  background: linear-gradient(135deg, rgb(38, 38, 38), rgb(39, 29, 20));
}

.calendar-day.outside {
  color: var(--muted);
  opacity: 0.42;
}

.calendar-day.inRange {
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(211, 154, 101, 0.19), rgba(120, 149, 180, 0.12));
}

.calendar-day.selected {
  border-radius: 9px;
  background: linear-gradient(115deg, #ffe0ad, #d8894d);
  color: #151515;
  font-weight: 700;
  opacity: 1;
}

.calendar-day.today:not(.selected)::after {
  position: absolute;
  right: 5px;
  bottom: 4px;
  left: 5px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, #ffe0ad, #d8894d);
  content: '';
}

.cal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.cal-actions .spacer {
  margin-left: auto;
}

.clear-range,
.apply-range {
  min-height: 35px;
  padding: 0 13px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: linear-gradient(135deg, rgb(39, 39, 40), rgb(39, 30, 21));
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}

.clear-range:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.apply-range {
  min-width: 86px;
  border-color: var(--accent);
  background: linear-gradient(110deg, #ffe0ad, #d8894d);
  color: #151515;
  font-weight: 600;
}
</style>
