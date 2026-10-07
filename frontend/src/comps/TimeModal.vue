<script setup lang="ts">
/**
 * 选一个时间点（北京时间，精确到分钟）的弹窗。
 *
 * 两种用法：
 *   · kind='center'（默认）：「添加案例」用 —— 选完以这个时间为**中心**，
 *     往前、往后各拉 N 根 K 线，再在这段里找主拉升。
 *   · kind='point'：K 线图「看哪一段」用 —— 只是单纯挑一个时间点，
 *     标题 / 说明由外面通过 title / hint 给。
 */
import {computed, ref, watch} from 'vue'
import {bjInputToMs, bjInputValue, bjTime} from '../format'

const props = defineProps<{
  modelValue: boolean
  /** 打开时的初始值（毫秒） */
  initial?: number
  /** center = 以时间为中心拉 K 线；point = 单纯选一个时间点 */
  kind?: 'center' | 'point'
  /** 弹窗标题，不填按 kind 取默认 */
  title?: string
  /** 弹窗里的一句说明，point 模式用 */
  hint?: string
  /** 只用来算「前后各 N 根 ≈ 多长时间」的提示文案 */
  timeframe?: string
  bars?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'confirm', ms: number): void
}>()

const TF_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
}

const centerMode = computed(() => (props.kind ?? 'center') === 'center')

const headTitle = computed(
  () => props.title ?? (centerMode.value ? '选一个时间点' : '选一个时间')
)

const value = ref('')

watch(
  () => props.modelValue,
  open => {
    if (open) value.value = bjInputValue(props.initial ?? Date.now())
  },
  {immediate: true}
)

const ms = computed(() => bjInputToMs(value.value))

/** 前后各 bars 根换算成天数，让人有个概念 */
const spanText = computed(() => {
  const step = TF_MS[props.timeframe ?? '4h'] ?? TF_MS['4h']
  const bars = props.bars ?? 200
  const days = (step * bars) / 86_400_000
  if (days >= 1) return `${Math.round(days * 10) / 10} 天`
  return `${Math.round((step * bars) / 3_600_000)} 小时`
})

const rangeText = computed(() => {
  if (!ms.value) return '—'
  const step = TF_MS[props.timeframe ?? '4h'] ?? TF_MS['4h']
  const bars = props.bars ?? 200
  return `${bjTime(ms.value - step * bars)} → ${bjTime(ms.value + step * bars)}`
})

const QUICK = [
  {label: '现在', back: 0},
  {label: '1 天前', back: 1},
  {label: '3 天前', back: 3},
  {label: '7 天前', back: 7},
  {label: '30 天前', back: 30}
]

function pick(daysAgo: number) {
  const t = Date.now() - daysAgo * 86_400_000
  value.value = bjInputValue(t)
}

function close() {
  emit('update:modelValue', false)
}

function confirm() {
  if (!ms.value) return
  emit('confirm', ms.value)
  close()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-mask" @click.self="close">
      <div class="modal-card">
        <h3>{{ headTitle }} <span class="dim">北京时间 · 精确到分钟</span></h3>

        <p v-if="centerMode" class="hint">
          以这个时间为中心，往前、往后各拉
          <b>{{ props.bars ?? 200 }} 根</b>
          {{ props.timeframe ?? '' }} K 线（≈ 前后各 {{ spanText }}），
          再在这段里找主拉升段。
        </p>
        <p v-else-if="props.hint" class="hint">{{ props.hint }}</p>
        <p v-else class="hint">选一个时间点，精确到分钟。</p>

        <div class="quick">
          <button
            v-for="q in QUICK"
            :key="q.label"
            type="button"
            class="ghost tiny"
            @click="pick(q.back)"
          >
            {{ q.label }}
          </button>
        </div>

        <input v-model="value" type="datetime-local" class="dt" step="60" />

        <div v-if="centerMode" class="preview">
          <span class="k">实际会拉</span>
          <span class="v">{{ rangeText }}</span>
        </div>

        <div class="modal-actions">
          <button type="button" class="ghost" @click="close">取消</button>
          <button type="button" :disabled="!ms" @click="confirm">
            {{ centerMode ? '就用这个时间' : '确定' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 320; /* 压在底部弹层 `.sheet`（301）上面 —— 配置里点「任意…」要能弹出来 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}

.modal-card {
  width: min(420px, 100%);
  padding: 16px 18px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
}

.modal-card h3 {
  margin: 0 0 8px;
  font-size: 14px;
}

.modal-card h3 .dim {
  font-size: 11px;
  font-weight: 400;
}

.modal-card .hint {
  margin: 0 0 10px;
  line-height: 1.6;
}

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.dt {
  width: 100%;
  padding: 9px 10px;
  font-size: 15px;
  font-family: var(--mono);
  color-scheme: dark;
  text-align: center;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 10px 0 4px;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}

.preview .k {
  font-size: 10.5px;
  color: var(--muted);
}

.preview .v {
  font-size: 11.5px;
  font-family: var(--mono);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
