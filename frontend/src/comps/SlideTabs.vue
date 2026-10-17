<script setup lang="ts" generic="T extends string | number">
/**
 * 分段 tab（**滑块指示式**）。
 *
 * 用户 2026-10-18 连着改了三版才定下来：
 *   「tab 改为胶囊式」→「改为滑块指示式」→「**滑块跟着文字宽度走**（不是等宽格，
 *   淡底小圆角）」。
 *
 * 所以这里**不给每格定宽**：格子按自己的文字（+ 计数）撑开；滑块是真的去量
 * 选中那格的 `offsetLeft` / `offsetWidth` 再滑过去 —— 各格宽窄不同也能严丝合缝，
 * 不用在 CSS 里猜「四分之一」「五分之一」（那样一旦加减一格就全歪）。
 *
 * ⚠️ 容器 `position: relative` 是必须的：`offsetLeft` 量的是相对**定位祖先**的距离。
 * ⚠️ 第一次量到之前滑块 `opacity: 0`（`ready` 那个类），否则会从左上角「滑进来」一下。
 * ⚠️ 内边距写死小值：全站 `button` 默认 `padding: 9px 20px`，一排格子会被撑爆（踩过）。
 */
import {nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'

const props = defineProps<{
  modelValue: T
  options: {value: T; label: string; badge?: string | number}[]
}>()

const emit = defineEmits<{(e: 'update:modelValue', v: T): void}>()

const tabEls = ref<HTMLElement[]>([])

/** 滑块的位置与宽度（px，相对容器） */
const box = ref({left: 0, width: 0, ready: false})

let ro: ResizeObserver | null = null

function setTab(el: Element | null, i: number): void {
  if (el instanceof HTMLElement) tabEls.value[i] = el
}

function measure(): void {
  const i = props.options.findIndex(o => o.value === props.modelValue)
  const el = tabEls.value[i]
  if (!el) return
  box.value = {left: el.offsetLeft, width: el.offsetWidth, ready: true}
}

/* 换格 / 计数变了（标签宽度跟着变）都要重量一次 */
watch(
  () => [
    props.modelValue,
    props.options.map(o => `${o.label}:${o.badge ?? ''}`).join('|')
  ],
  () => void nextTick(measure)
)

onMounted(() => {
  void nextTick(measure)
  if (typeof ResizeObserver === 'undefined') return
  const host = tabEls.value[0]?.parentElement
  if (!host) return
  ro = new ResizeObserver(() => measure())
  ro.observe(host)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})
</script>

<template>
  <div class="slide-tabs" role="tablist">
    <span
      class="st-thumb"
      :class="{ready: box.ready}"
      :style="{transform: `translateX(${box.left}px)`, width: `${box.width}px`}"
      aria-hidden="true"
    ></span>
    <button
      v-for="(o, i) in options"
      :key="String(o.value)"
      :ref="el => setTab(el, i)"
      type="button"
      role="tab"
      :aria-selected="o.value === modelValue"
      :class="{on: o.value === modelValue}"
      @click="emit('update:modelValue', o.value)"
    >
      {{ o.label }}
      <span v-if="o.badge !== undefined" class="st-badge">{{ o.badge }}</span>
    </button>
  </div>
</template>

<style scoped>
.slide-tabs {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  /* 窄屏挤不下时自己横着滚，不把页面撑破 */
  overflow-x: auto;
  scrollbar-width: none;
}

.slide-tabs::-webkit-scrollbar {
  display: none;
}

/*
 * 滑块：**淡琥珀底 + 细琥珀边 + 小圆角**（用户 2026-10-18：「太亮了」「圆角太大」）。
 * 位置和宽度都由 JS 量出来给（见上面 `measure`）。
 */
.st-thumb {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border: 1px solid var(--accent-line);
  border-radius: 6px;
  background: var(--accent-soft);
  opacity: 0;
  transition:
    transform 0.26s cubic-bezier(0.4, 0.1, 0.2, 1),
    width 0.26s cubic-bezier(0.4, 0.1, 0.2, 1),
    opacity 0.18s ease;
  pointer-events: none;
}

.st-thumb.ready {
  opacity: 1;
}

.slide-tabs button {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  min-width: 0;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: var(--fw-mid);
  white-space: nowrap;
  transition: color 0.18s ease;
}

.slide-tabs button.on {
  color: var(--accent);
}

/* 计数小标签：跟着选中态一起变琥珀，别在淡底上留一圈灰边 */
.slide-tabs button.on .st-badge {
  color: var(--accent);
  border-color: var(--accent-line);
}

.st-badge {
  font-size: 10px;
  font-weight: 400;
  line-height: 1;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
