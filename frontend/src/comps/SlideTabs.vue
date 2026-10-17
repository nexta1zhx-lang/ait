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
  const w = Math.max(16, box.value.width - 16)
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
/*
 * 二级 tab 这套**照抄「我的 → 管理 / 模型配置」那排**
 * （`AdminView` 的 `.adm-tabs` / `ModelPaneView` 的 `.model-tabs`）：
 * 一条横胶囊轨道（细描边 + 暖灰渐变底），选中那颗是淡琥珀渐变胶囊。
 * 用户 2026-10-18：「改为像我的那样的一级和二级」。
 *
 * 区别只有一个：这里的选中胶囊是**滑过去**的（`--seg-i` 那套量法在后面）。
 */
.slide-tabs {
  position: relative;
  display: flex;
  align-items: center;
  align-self: flex-start;
  padding: 3px;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: linear-gradient(120deg, rgb(19, 19, 21), rgb(18, 15, 13));
  overflow-x: auto;
  scrollbar-width: none;
}

.slide-tabs::-webkit-scrollbar {
  display: none;
}

/*
 * 滑块：跟 `.adm-tabs button.active` 同一份渐变 + 内描边。
 * 位置和宽度由 JS 量出来给（见上面 `measure` / `bar`）；
 * `left: 0` + `translateX(offsetLeft)` —— `offsetLeft` 已经含轨道那 3px 内边距。
 */
.st-bar {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 0;
  border-radius: 999px;
  background: linear-gradient(
    112deg,
    rgba(255, 217, 158, 0.25) 0%,
    rgba(255, 193, 107, 0.15) 52%,
    rgba(243, 154, 63, 0.09) 100%
  );
  box-shadow: inset 0 0 0 1px rgba(255, 193, 107, 0.12);
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
  gap: 5px;
  min-height: 30px;
  min-width: 0;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 400;
  white-space: nowrap;
  transition: color 0.18s ease;
}

.slide-tabs button.on {
  color: #ffd291;
}

/* 计数：跟 `.tag` 一个意思，但更淡（选中时贴近滑块那档琥珀） */
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

.slide-tabs button.on .st-badge {
  color: #ffd291;
  border-color: rgba(255, 193, 107, 0.22);
  background: rgba(255, 193, 107, 0.08);
}
</style>
