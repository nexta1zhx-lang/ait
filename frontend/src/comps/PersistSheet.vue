<script setup lang="ts">
/**
 * **持久化分析**弹层（2026-10-15 用户：「点击图标弹窗确定要加入持久化分析，每隔 15 分钟分析一次，
 * 最长不超过 8 小时」）。
 *
 * 一份组件管两件事（同一个入口点开，状态自己判）：
 *   · **还没加入** ⇒ 就是那句确认：每 15 分钟问一次 AI、最长 8 小时、约 32 次 ≈ ¥0.2~0.6；
 *   · **已经在跑** ⇒ 状态（第几次 / 下一次 / 还剩多久）+ 最近结论 + **结论时间线** + 停止 / 立即跑一次。
 *
 * ⚠️ 时间线是这套东西的核心，不是"顺带"：32 条结论里真正有用的是「档位怎么变」和
 *    「它说可做之后到底涨没涨」—— 所以那一列（+1h / +4h）一定要留住。
 */
import {computed, ref, watch} from 'vue'
import {bjTime, fmt} from '../format'
import {markdownToPlain} from '../markdown'
import AnalysisDetail from './AnalysisDetail.vue'
import {
  activeSessionOf,
  afterCell,
  addPersist,
  leftText,
  persistBusy,
  persistLimits,
  persistSessions,
  refreshPersist,
  removePersist,
  untilText,
  runPersistOnce,
  type PersistCadence,
  type PersistRow
} from '../persist'

const props = defineProps<{
  open: boolean
  /** 当前 K 线看的币（基础币） */
  base: string
  /** 当前图上的周期（加入时冻结成这个值） */
  timeframe: string
}>()

const emit = defineEmits<{close: []}>()

/** 这个币正在跑的会话（null = 还没加入） */
const mine = computed(() => activeSessionOf(props.base))

/** 这个币最近的（可能已结束的）会话 —— 结束了也让人能回看时间线 */
const latest = computed<PersistRow | null>(() => {
  const sym = props.base.trim().toUpperCase()
  return persistSessions.value.find(s => s.symbol.toUpperCase() === sym) ?? null
})

const showRow = computed(() => mine.value ?? latest.value)

/** 点时间线里某一条 → 那一次的全文（跟「预测结果」「AI 分析」同一个详情组件） */
const detail = ref<{
  symbol: string
  timeframe: string
  at: string
  price: number | null
  line: string
  verdict: string | null
} | null>(null)

function openDetail(row: {
  createdAt: string
  price: number | null
  line: string
  verdict: string | null
}): void {
  const s = showRow.value
  if (!s) return
  detail.value = {
    symbol: s.symbol,
    timeframe: s.timeframe,
    at: row.createdAt,
    price: row.price,
    line: row.line,
    verdict: row.verdict
  }
}

/**
 * 那两格的悬停提示：说清它是什么，免得倒计时/「—」被当成坏掉。
 *
 * ⚠️ 「13m后」是**倒计时**（那一刻还没到），「—」是**过了点还是没数**（库里缺那根 1m）
 *   —— 两种情况在最坏的时候看着一模一样，只能靠这里说清。
 */
function afterTitle(r: {createdAt: string; after15m: number | null; after1h: number | null}, minutes: 15 | 60): string {
  const t = bjTime(new Date(new Date(r.createdAt).getTime() + minutes * 60_000).toISOString())
  const v = minutes === 15 ? r.after15m : r.after1h
  const what = minutes === 15 ? '15 分钟' : '1 小时'
  if (v !== null) return `那一刻之后 ${what}的价格 vs 当时价（${t} 前后那根 1 分钟 K 线的收盘）`
  return untilText(r.createdAt, minutes)
    ? `还没到点：${t} 之后才有数据`
    : `库里还没有 ${t} 附近的 1 分钟 K 线（这段缺数据）`
}

/** 加入时用哪个周期：默认跟着图上那个，但**只有 15m / 1h 两个**（周期同时决定频率） */
const tf = ref('15m')

/**
 * 当前选中周期的节奏（间隔 / 总时长 / 最多几轮）。
 * ★ 2026-10-16 用户：「选择周期要和调用次数匹配」—— 选 15m 就每 15 分钟一次、盯 8 小时；
 *   选 1h 就每小时一次、盯 16 小时。数字来自后端那份 `CADENCES`（没拿到就退回本地兜底）。
 */
const cad = computed(() => {
  const list = persistLimits.value.cadences
  return list.find(c => c.timeframe === tf.value) ?? list[0]
})

/** 这一轮大概花多少（¥）：一次 ≈ ¥0.007~0.02，按轮数给个区间 */
const costText = computed(() => {
  const n = cad.value?.maxRuns ?? 0
  return `¥${(n * 0.007).toFixed(1)}~${(n * 0.02).toFixed(1)}`
})

watch(
  () => [props.open, props.timeframe] as const,
  ([open, t]) => {
    if (open) {
      /* 图上那个周期能对上就用它（1h 就默认 1h），对不上（比如 4h/15分）落回 15m */
      tf.value = persistLimits.value.cadences.some(c => c.timeframe === t) ? (t || '15m') : '15m'
      void refreshPersist(true)
    }
  }
)

async function confirmAdd(): Promise<void> {
  const ok = await addPersist({base: props.base.trim().toUpperCase(), timeframe: tf.value})
  if (ok) emit('close')
}

/** 档位 → 色块（跟前端 `verdictKind` 那套词表一致） */
function vClass(v: string | null | undefined): string {
  return v === 'go' ? 'go' : v === 'no' ? 'no' : 'wait'
}
function vText(v: string | null | undefined): string {
  return v === 'go' ? '可做' : v === 'no' ? '不可做' : '观望'
}

/**
 * 某个周期对应的节奏（模板里要显示「第 N/32 次」「每 15 分钟一次」那种）。
 * 认不出来按第一个算（老会话里可能还存着 4h 这种已下线的值）。
 */
function cadOf(timeframe: string): PersistCadence {
  const list = persistLimits.value.cadences
  return list.find(c => c.timeframe === timeframe) ?? list[0]!
}

/** 「8 小时」/「16 小时」——从毫秒折成人话（模板里给确认那段用） */
const leftLabel = computed(() => {
  const ms = cad.value?.maxMs ?? 0
  const h = Math.round(ms / 3600_000)
  return h >= 24 ? `${Math.round(h / 24)} 天` : `${h} 小时`
})

/**
 * 时间线里那句话：抹掉 Markdown、压掉换行，截到 80 字。
 *
 * ⚠️ 必须 `markdownToPlain`：模型给的是**一整篇 Markdown**（`# NIL/USDT 1h 判断` + 分节），
 *    直接印第一行就是那个标题，等于没摘要（跟「预测历史」用的是同一套摘要）。
 */
function shortLine(line: string): string {
  return markdownToPlain(line, 80)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet" role="dialog" aria-label="持久化分析">
      <header class="sheet-head">
        <b>{{ base.toUpperCase() }} · 持久化分析</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
      </header>

      <!-- ================= ① 还没加入：确认 ================= -->
      <template v-if="!mine">
        <!--
          周期**同时决定频率**（2026-10-16 用户：「选择周期要和调用次数匹配」）：
            15m ⇒ 每 15 分钟问一次 · 盯 8 小时 · 32 次
            1h  ⇒ 每小时问一次   · 盯 16 小时 · 16 次
          所以这段文案必须跟着选中的周期变，别再写死 15 分钟/8 小时。
        -->
        <p class="ps-lead">
          每 <b>{{ cad?.label }}</b>自动问一次 AI，最多 <b>{{ leftLabel }}</b>
          （{{ cad?.maxRuns }} 次，约 {{ costText }}）。结论**转成「可做」**时给你一条提示
          —— 站内 + Telegram（装了 App 还会推手机）。
        </p>
        <div class="sheet-row">
          <span class="rk">主周期</span>
          <div class="ctl seg">
            <button
              v-for="c in persistLimits.cadences"
              :key="c.timeframe"
              type="button"
              class="ghost tiny"
              :class="{active: tf === c.timeframe}"
              @click="tf = c.timeframe"
            >
              {{ c.timeframe }}
            </button>
          </div>
        </div>
        <p class="ps-dim">
          周期同时决定**多久问一次**和**盯多久**（{{ cad?.label }}一次 /
          {{ cad?.maxRuns }} 次 / {{ leftLabel }}）；加入后就冻住，同一批结论才是同一把尺子。
          同时最多盯 {{ persistLimits.maxActive }} 个币。
        </p>
        <button class="btn-run ps-go" :disabled="persistBusy" @click="confirmAdd()">
          {{ persistBusy ? '加入中…' : '确认加入' }}
        </button>
      </template>

      <!-- ================= ② 已经在跑：状态 + 时间线 ================= -->
      <template v-else>
        <p class="ps-lead">
          第 <b>{{ mine.runs }}/{{ cadOf(mine.timeframe).maxRuns }}</b> 次 ·
          下一次 <b>{{ bjTime(mine.nextAt) }}</b> ·
          还剩 <b>{{ leftText(mine.endsAt) }}</b>
          <span class="dim">（{{ mine.timeframe }} · 每 {{ cadOf(mine.timeframe).label }}一次）</span>
        </p>
        <p v-if="mine.lastLine" class="ps-last">
          <span class="ps-v" :class="vClass(mine.lastVerdict)">{{ vText(mine.lastVerdict) }}</span>
          {{ shortLine(mine.lastLine) }}
        </p>

        <div class="ps-actions">
          <button class="ghost tiny" :disabled="persistBusy" @click="runPersistOnce(mine.id)">
            {{ persistBusy ? '…' : '立即跑一次' }}
          </button>
          <button class="ghost tiny" :disabled="persistBusy" @click="removePersist(mine.id)">
            停止
          </button>
        </div>

        <h3 class="ps-h">结论时间线</h3>
        <div v-if="showRow && showRow.timeline.length" class="ps-tl">
          <div class="ps-tl-head">
            <span>时间</span><span>档位</span><span>结论</span>
            <span class="ps-price">当时价</span><span class="ps-c1">+15分</span><span class="ps-c4">+1时</span>
          </div>
          <div
            v-for="r in [...showRow.timeline].reverse()"
            :key="r.id"
            class="ps-tl-row clickable"
            role="button"
            tabindex="0"
            title="点开看全文"
            @click="openDetail(r)"
            @keydown.enter.prevent="openDetail(r)"
          >
            <span class="ps-t num dim">{{ bjTime(r.createdAt).slice(5) }}</span>
            <span class="ps-v" :class="vClass(r.verdict)">{{ vText(r.verdict) }}</span>
            <span class="ps-line" :title="r.line">{{ shortLine(r.line) }}</span>
            <span class="ps-price num">{{ r.price === null ? '—' : fmt(r.price, 6) }}</span>
            <span class="ps-c1 num" :class="afterCell(r, 15).cls" :title="afterTitle(r, 15)">
              {{ afterCell(r, 15).text }}
            </span>
            <span class="ps-c4 num" :class="afterCell(r, 60).cls" :title="afterTitle(r, 60)">
              {{ afterCell(r, 60).text }}
            </span>
          </div>
        </div>
        <p v-else class="ps-dim">
          还没跑出结论 —— {{ cadOf(mine.timeframe).label }}内会出第一条（也可以点「立即跑一次」）。
        </p>
      </template>

      <!-- 已经结束的会话：也让它能被回看（时间线在下面那一块） -->
      <template v-if="!mine && latest">
        <p class="ps-dim">
          上一次会话：{{ bjTime(latest.startedAt) }} 起，{{ latest.runs }} 次，{{ latest.endedReason || '已结束' }}。
        </p>
        <div v-if="latest.timeline.length" class="ps-tl">
          <div
            v-for="r in [...latest.timeline].reverse().slice(0, 12)"
            :key="r.id"
            class="ps-tl-row clickable"
            role="button"
            tabindex="0"
            title="点开看全文"
            @click="openDetail(r)"
            @keydown.enter.prevent="openDetail(r)"
          >
            <span class="ps-t num dim">{{ bjTime(r.createdAt).slice(5) }}</span>
            <span class="ps-v" :class="vClass(r.verdict)">{{ vText(r.verdict) }}</span>
            <span class="ps-line" :title="r.line">{{ shortLine(r.line) }}</span>
            <span class="ps-price num">{{ r.price === null ? '—' : fmt(r.price, 6) }}</span>
            <span class="ps-c1 num" :class="afterCell(r, 15).cls" :title="afterTitle(r, 15)">
              {{ afterCell(r, 15).text }}
            </span>
            <span class="ps-c4 num" :class="afterCell(r, 60).cls" :title="afterTitle(r, 60)">
              {{ afterCell(r, 60).text }}
            </span>
          </div>
        </div>
      </template>
    </section>

    <AnalysisDetail
      :open="!!detail"
      :symbol="detail?.symbol ?? ''"
      :timeframe="detail?.timeframe"
      :at="detail?.at ?? null"
      :price="detail?.price ?? null"
      :line="detail?.line ?? ''"
      :verdict="detail?.verdict ?? null"
      @close="detail = null"
    />
  </Teleport>
</template>
