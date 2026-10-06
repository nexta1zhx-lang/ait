<script setup lang="ts" generic="T extends string">
/**
 * 自定义样式的下拉选择（用户 2026-10-07：「划转的下拉框换成**自定义样式**」）。
 *
 * 为什么不用原生 `<select>`：它长得是**系统控件**（安卓 WebView 里那套系统弹窗、
 * 灰底灰字），跟这一页的胶囊 / 面板完全不是一套；`<option>` 更是一点都改不了。
 *
 * 做法跟 `SymbolCombo` 的列表同一套（`.combo-list` 那种）：
 * 一个 `position: relative` 的壳 + `position: absolute` 的列表；
 * 点外面 / 按 Esc / 选中一项都会关掉；
 * 列表项右侧给当前项打一个内联 SVG 勾（不用 ✓ 字符：安卓兜底字体不保证有字形）。
 *
 * ⚠️ 列表是**覆盖**在下面内容上的，所以壳外面那一层不能有 `overflow: hidden`
 *    （`.sheet` 是 `overflow: auto`，没问题）。
 */
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'

const props = defineProps<{
  modelValue: T
  options: {value: T; label: string; title?: string}[]
  disabled?: boolean
  /** 壳上的悬停说明（不给就用当前项的 label） */
  title?: string
  /** 无障碍标签（读屏用） */
  ariaLabel?: string
}>()

const emit = defineEmits<{(e: 'update:modelValue', v: T): void}>()

const open = ref(false)
const boxEl = ref<HTMLElement | null>(null)

/** 现在选中的那项的显示文字（找不到就退回原值，别显示空白） */
const current = computed(
  () =>
    props.options.find(o => o.value === props.modelValue)?.label ??
    String(props.modelValue)
)

function pick(v: T): void {
  open.value = false
  if (v !== props.modelValue) emit('update:modelValue', v)
}

/** 点壳外面关掉。⚠️ 用 `pointerdown`（不是 click）：手指按下去就收，
 *  免得那一下同时又被别的按钮吃掉 */
function onDocDown(e: PointerEvent): void {
  if (!open.value) return
  const el = boxEl.value
  if (el && e.target instanceof Node && el.contains(e.target)) return
  open.value = false
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value) open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="boxEl" class="pk" :class="{open, dis: disabled}">
    <button
      type="button"
      class="pk-btn"
      :disabled="disabled"
      :title="title ?? current"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="pk-t">{{ current }}</span>
      <svg class="pk-caret" viewBox="0 0 10 6" aria-hidden="true">
        <path d="M5 5.6.4.4h9.2z" />
      </svg>
    </button>
    <ul v-if="open" class="pk-list" role="listbox">
      <li v-for="o in options" :key="String(o.value)">
        <button
          type="button"
          role="option"
          :aria-selected="o.value === modelValue"
          :class="{on: o.value === modelValue}"
          :title="o.title"
          @click="pick(o.value)"
        >
          {{ o.label }}
          <svg
            v-if="o.value === modelValue"
            class="pk-tick"
            viewBox="0 0 12 12"
            aria-hidden="true"
          >
            <path d="M2.5 6.4 5 8.9l4.5-5.8" />
          </svg>
        </button>
      </li>
    </ul>
  </div>
</template>
