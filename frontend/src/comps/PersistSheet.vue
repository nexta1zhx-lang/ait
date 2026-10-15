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
  addPersist,
  leftText,
  persistBusy,
  persistLimits,
  persistSessions,
  refreshPersist,
  removePersist,
  runPersistOnce,
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

/** 加入时用哪个周期：默认跟着图上那个（最常用 1h） */
const tf = ref(props.timeframe || '1h')
/** 回看天数（跟分析页那个口径一致） */
const days = ref(3)

watch(
  () => [props.open, props.timeframe] as const,
  ([open, t]) => {
    if (open) {
      tf.value = t || '1h'
      void refreshPersist(true)
    }
  }
)

async function confirmAdd(): Promise<void> {
  const ok = await addPersist({base: props.base.trim().toUpperCase(), timeframe: tf.value, days: days.value})
  if (ok) emit('close')
}

/** 档位 → 色块（跟前端 `verdictKind` 那套词表一致） */
function vClass(v: string | null | undefined): string {
  return v === 'go' ? 'go' : v === 'no' ? 'no' : 'wait'
}
function vText(v: string | null | undefined): string {
  return v === 'go' ? '可做' : v === 'no' ? '不可做' : '观望'
}
function chgText(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`
}
function chgClass(v: number | null): string {
  return v === null ? '' : v >= 0 ? 'up' : 'down'
}
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
        <p class="ps-lead">
          每 <b>15 分钟</b>自动问一次 AI，最多 <b>8 小时</b>（≈ {{ Math.floor(persistLimits.maxMs / persistLimits.intervalMs) }} 次，
          约 ¥0.2~0.6）。结论有变化时给你一条提示 —— 和 Telegram 各发一条。
        </p>
        <div class="sheet-row">
          <span class="rk">主周期</span>
          <div class="ctl seg">
            <button
              v-for="t in ['15m', '1h', '4h']"
              :key="t"
              type="button"
              class="ghost tiny"
              :class="{active: tf === t}"
              @click="tf = t"
            >
              {{ t }}
            </button>
          </div>
        </div>
        <div class="sheet-row">
          <span class="rk">回看天数</span>
          <div class="ctl">
            <input v-model.number="days" type="number" min="1" max="60" step="1" inputmode="numeric" />
          </div>
        </div>
        <p class="ps-dim">
          同一会话里周期/天数就冻住了（32 条结论才是同一把尺子）；同时最多盯
          {{ persistLimits.maxActive }} 个币。
        </p>
        <button class="btn-run ps-go" :disabled="persistBusy" @click="confirmAdd()">
          {{ persistBusy ? '加入中…' : '确认加入' }}
        </button>
      </template>

      <!-- ================= ② 已经在跑：状态 + 时间线 ================= -->
      <template v-else>
        <p class="ps-lead">
          第 <b>{{ mine.runs }}</b> 次 ·
          下一次 <b>{{ bjTime(mine.nextAt) }}</b> ·
          还剩 <b>{{ leftText(mine.endsAt) }}</b>
          <span class="dim">（{{ mine.timeframe }} · 回看 {{ mine.days }} 天）</span>
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
            <span class="ps-price">当时价</span><span class="ps-c1">+1h</span><span class="ps-c4">+4h</span>
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
            <span class="ps-c1 num" :class="chgClass(r.after1h)">{{ chgText(r.after1h) }}</span>
            <span class="ps-c4 num" :class="chgClass(r.after4h)">{{ chgText(r.after4h) }}</span>
          </div>
        </div>
        <p v-else class="ps-dim">还没跑出结论 —— 15 分钟内会出第一条（也可以点「立即跑一次」）。</p>
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
            <span class="ps-c1 num" :class="chgClass(r.after1h)">{{ chgText(r.after1h) }}</span>
            <span class="ps-c4 num" :class="chgClass(r.after4h)">{{ chgText(r.after4h) }}</span>
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
