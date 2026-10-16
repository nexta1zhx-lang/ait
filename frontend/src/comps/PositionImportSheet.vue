<script setup lang="ts">
/**
 * 「收录到知识库」弹层 —— 从**一笔仓位**（持仓 / 仓位历史那张卡）导入一条经验。
 *
 * 用户 2026-10-16 的原话：
 *   「订单的仓位上、历史仓位中加一个按钮……点一下自动导入到我的资料库……
 *     这个仓位的截取根据持仓周期来，前面一点，我的持仓范围都要在里面，
 *     然后再包括后面大概 5~6 根走势。这样就能看出我之前开仓是什么情况下开的、
 *     我持仓多久、以及持仓之后那几根走势又是什么样的。」
 *
 * ⇒ 截哪一段、用哪个周期**不由前端定**（见后端 `knowledge-service.ts` 的
 *   `collectCase` / `pickTimeframe`）：开仓前 40 根 + 整段持仓 + 平仓后 6 根，
 *   周期按持仓时长换档。前端只把「这笔仓位是什么」交上去，再把过程画出来。
 *
 * 过程跟「添加案例」那条路一模一样（`step` → `done` / `failed`），所以直接用
 * `steps.ts` 那套合并 + `StepsPanel` 画时间线。
 *
 * ⚠️ 提炼要调模型（十几秒、要花钱），所以：
 *   · 跑的时候**不让关**（关掉连接不会让后端停下，钱已经花了、结果却扔了）
 *   · 兜一个 3 分钟总超时 —— 真卡住了得让人能出来，而不是钉在弹层上
 */
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import StepsPanel from './StepsPanel.vue'
import {
  collectFromPositionStream,
  type AnalyzeStep,
  type CollectResult,
  type PositionImportTarget
} from '../api'
import {failRunning, mergeStep} from '../steps'
import {bjTime, fixed, fmt} from '../format'

const props = defineProps<{
  /** 要导入的那笔仓位；`null` = 弹层关着 */
  target: PositionImportTarget | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 存进去了（外层拿它弹提示 + 刷新「知识库」条数） */
  (e: 'saved', res: CollectResult): void
}>()

/** 一次提炼最多等多久（超过就当它卡住了，放人出去） */
const TIMEOUT_MS = 180_000

const steps = ref<AnalyzeStep[]>([])
const result = ref<CollectResult | null>(null)
const error = ref('')
const running = ref(false)

let stopStream: (() => void) | null = null
let timer: number | undefined

function cleanup() {
  stopStream?.()
  stopStream = null
  window.clearTimeout(timer)
}

/**
 * 换了一笔仓位（或关掉）= 把上一次那套整个拆掉重新来。
 *
 * ⚠️ 必须连 `target` 一起看，不能只看「有没有值」：连点两条不同的仓位时
 *    对象换了但「有值」没变，只看布尔值会接着上一条的步骤往下画。
 */
watch(
  () => props.target,
  t => {
    cleanup()
    steps.value = []
    result.value = null
    error.value = ''
    running.value = false
    if (!t) return
    start(t)
  },
  {immediate: true}
)

onBeforeUnmount(cleanup)

function start(t: PositionImportTarget) {
  running.value = true
  timer = window.setTimeout(() => {
    stopStream?.()
    stopStream = null
    running.value = false
    failRunning(steps.value, '等太久了，已放弃')
    error.value = '提炼超时（超过 3 分钟），可以关掉重试。'
  }, TIMEOUT_MS)

  stopStream = collectFromPositionStream(t.params, {
    onStep(s) {
      mergeStep(steps.value, s)
    },
    onDone(res) {
      cleanup()
      running.value = false
      result.value = res
      emit('saved', res)
    },
    onError(msg) {
      cleanup()
      running.value = false
      failRunning(steps.value, msg)
      error.value = msg
    }
  })
}

const name = computed(() => props.target?.name ?? '')
const params = computed(() => props.target?.params ?? null)
const sideText = computed(() => (params.value?.side === 'short' ? '空' : '多'))

/** 净盈亏（带符号，跟卡片上同一个写法） */
function signed(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`
}

/** 持仓多久的人话 */
function holdText(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`
}

const holdTxt = computed(() => (params.value ? holdText(params.value.holdSec ?? 0) : ''))
</script>

<template>
  <Teleport to="body">
    <div v-if="target" class="sheet-mask" />
    <section
      v-if="target"
      class="sheet warm-skin pi"
      role="dialog"
      aria-label="收录到知识库"
    >
      <header class="sheet-head">
        <b>收录到知识库 · {{ name }} {{ sideText }}</b>
        <button
          class="ghost tiny"
          :disabled="running"
          :title="running ? '正在提炼，等它跑完再关' : '关掉'"
          @click="emit('close')"
        >
          ✕
        </button>
      </header>

      <div class="pi-body">
        <!-- 这笔仓位是什么：让人确认点对了（而不是等十几秒才发现点错了那条） -->
        <div v-if="params" class="pi-pos">
          <span>
            <i>开仓</i>
            <b>{{ bjTime(params.openAt) }}</b>
          </span>
          <span>
            <i>持仓</i>
            <b>{{ holdTxt }}</b>
          </span>
          <span>
            <i>开仓均价</i>
            <b>{{ params.entryPrice == null ? '—' : fmt(params.entryPrice) }}</b>
          </span>
          <span>
            <i>{{ params.closeAt ? '平仓均价' : '还没平' }}</i>
            <b>{{
              params.exitPrice == null ? '—' : fmt(params.exitPrice)
            }}</b>
          </span>
          <span>
            <i>净盈亏</i>
            <b :class="(params.net ?? 0) >= 0 ? 'up' : 'down'">{{
              signed(params.net ?? 0)
            }}</b>
          </span>
          <span>
            <i>杠杆</i>
            <b>{{ params.leverage ? `${fixed(params.leverage, 0)}x` : '—' }}</b>
          </span>
        </div>

        <p class="pi-hint">
          截 <b>开仓前 40 根 + 整段持仓 + 平仓后 6 根</b>，周期按持仓时长自动挑
          （持得久就用大周期）——
          这样 AI 看得到「什么结构下开的」「持了多久怎么走的」「平掉之后又走了几根」。
        </p>

        <!-- 过程：跟「添加案例」共用一个面板 -->
        <StepsPanel
          :steps="steps"
          :running="running"
          :done="!running"
          hint="准备中…"
        />

        <div v-if="error" class="pi-err">{{ error }}</div>

        <!-- 结果：把 AI 提炼到的东西摆出来看一眼 -->
        <div v-if="result" class="pi-done">
          <b class="pi-title">{{ result.title || '（没起标题）' }}</b>
          <p class="pi-lesson">{{ result.lesson }}</p>
          <p class="pi-meta">
            {{ result.symbol }} · {{ result.timeframe }} ·
            {{ result.window.bars }} 根（{{
              bjTime(result.window.start).slice(5, 16)
            }}
            → {{ bjTime(result.window.end).slice(5, 16) }}）
            <template v-if="result.tags.length">
              · 标签 {{ result.tags.join(' / ') }}
            </template>
          </p>
        </div>
      </div>

      <footer class="pi-foot">
        <RouterLink
          v-if="result"
          class="pi-link"
          to="/analyze?t=kb"
          @click="emit('close')"
        >
          去知识库看这条 ›
        </RouterLink>
        <span class="spacer" />
        <button :disabled="running" @click="emit('close')">
          {{ running ? '提炼中…' : '关掉' }}
        </button>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
.pi {
  max-height: 82vh;
}
.pi-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}
/* 这笔仓位的事实：两列小格（跟账本卡片同一个版式：标签在上、数值在下） */
.pi-pos {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.pi-pos > span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pi-pos i {
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}
.pi-pos b {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.up {
  color: var(--ok, #5eba89);
}
.down {
  color: var(--bad, #e55361);
}
.pi-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.pi-err {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bad, #e55361);
}
.pi-done {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--border, #26282e);
  border-radius: 8px;
}
.pi-title {
  font-size: 13.5px;
}
.pi-lesson {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
}
.pi-meta {
  margin: 0;
  font-size: 11.5px;
  color: var(--muted);
}
.pi-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 10px;
}
.pi-link {
  font-size: 12.5px;
  color: var(--accent, #d3b583);
  text-decoration: none;
}
.spacer {
  flex: 1 1 auto;
}
</style>
