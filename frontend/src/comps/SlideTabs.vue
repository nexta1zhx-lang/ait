<script setup lang="ts" generic="T extends string | number">
/**
 * 分段 tab（**滑块指示式**）。
 *
 * 用户 2026-10-18 连着改了几版才定下来：
 *   「tab 改为胶囊式」→「滑块指示式」→「滑块跟着文字宽度走」→ **「简约点」**。
 *
 * 于是只剩三样东西：**一排纯文字 + 一颗跟着文字宽度走的细滑条 + 选中那格染琥珀**。
 * 没有外框、没有底色块、计数就是一个淡淡的数字 —— 少一层「控件感」。
 *
 * 格子**不定宽**：按自己的文字（+ 计数）撑开；滑条是真去量选中那格的
 * `offsetLeft` / `offsetWidth` 再滑过去 —— 各格宽窄不同也能对得准，
 * 不用在 CSS 里猜「四分之一」（那样一旦加减一格就全歪）。
 *
 * ⚠️ 容器 `position: relative` 是必须的：`offsetLeft` 量的是相对**定位祖先**的距离。
 * ⚠️ 第一次量到之前滑块 `opacity: 0`（`ready` 那个类），否则会从左上角「滑进来」一下。
 * ⚠️ 内边距写死小值：全站 `button` 默认 `padding: 9px 20px`，一排格子会被撑爆（踩过）。
 */
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'

const props = defineProps<{
  modelValue: T
  options: {value: T; label: string; badge?: string | number}[]
}>()

const emit = defineEmits<{(e: 'update:modelValue', v: T): void}>()

const tabEls = ref<HTMLElement[]>([])

/** 选中那格的位置与宽度（px，相对容器） */
const box = ref({left: 0, width: 0, ready: false})

/** 细滑条：比那一格窄 16px（左右各留 8px），居中，太短的格子保底 18px */
const bar = computed(() => {
  const w = Math.max(18, box.value.width - 16)
  return {
    left: box.value.left + (box.value.width - w) / 2,
    width: w,
    ready: box.value.ready
  }
})

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
      class="st-bar"
      :class="{ready: bar.ready}"
      :style="{transform: `translateX(${bar.left}px)`, width: `${bar.width}px`}"
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
  gap: 4px;
  max-width: 100%;
  /* 窄屏挤不下时自己横着滚，不把页面撑破 */
  overflow-x: auto;
  scrollbar-width: none;
}

.slide-tabs::-webkit-scrollbar {
  display: none;
}

/*
 * 细滑条：贴在格子底部的一小段（2px），宽度跟着选中的文字走。
 * 位置和宽度由 JS 量出来给（见上面 `measure` / `bar`）。
 */
.st-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  border-radius: 999px;
  background: var(--accent);
  opacity: 0;
  transition:
    transform 0.24s cubic-bezier(0.4, 0.1, 0.2, 1),
    width 0.24s cubic-bezier(0.4, 0.1, 0.2, 1),
    opacity 0.18s ease;
  pointer-events: none;
}

.st-bar.ready {
  opacity: 1;
}

.slide-tabs button {
  position: relative;
  z-index: 1;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  min-width: 0;
  padding: 0 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  font-weight: var(--fw-mid);
  white-space: nowrap;
  transition: color 0.18s ease;
}

.slide-tabs button.on {
  color: var(--accent);
}

/* 计数：就是一个淡数字，不画框 */
.st-badge {
  font-size: 10px;
  font-weight: 400;
  line-height: 1;
  color: var(--muted);
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

.slide-tabs button.on .st-badge {
  color: inherit;
  opacity: 0.85;
}
</style>
