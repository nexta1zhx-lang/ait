<script setup lang="ts">
import {computed, ref} from 'vue'
import type {Contract} from '../api'

/**
 * 币种选择。
 * 点开默认展开**全部**合约（只显示币种，不带 /USDT）；
 * 打字则按前缀过滤；回车选中第一项，Esc 关闭。
 */

const props = defineProps<{
  modelValue: string
  contracts: Contract[]
  /** 一次最多渲染多少项（防止几百上千条时卡顿） */
  max?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  /** 从列表里选中（即使用户选的还是当前币种，也要当成切换） */
  (e: 'pick', v: string): void
  (e: 'submit'): void
}>()

const open = ref(false)
const hot = ref(0)
/** 列表的过滤词。和输入框内容分开：点开时清空 → 默认展开全部 */
const filter = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
const boxEl = ref<HTMLElement | null>(null)

const items = computed(() => {
  const q = filter.value.trim().toUpperCase()
  const list = q
    ? props.contracts.filter(c => c.base.includes(q))
    : props.contracts
  return list.slice(0, props.max ?? 1000)
})

/** 被截断了就给个提示，免得以为找不到币 */
const truncated = computed(() => {
  const q = filter.value.trim().toUpperCase()
  const n = q
    ? props.contracts.filter(c => c.base.includes(q)).length
    : props.contracts.length
  return n > items.value.length
})

function show() {
  // 展开全部：清掉过滤词，避免上次打一半的字把列表筛空
  filter.value = ''
  open.value = true
  hot.value = 0
}

function close() {
  open.value = false
  filter.value = ''
}

function pick(base: string) {
  emit('update:modelValue', base)
  emit('pick', base)
  close()
}

/** 清空输入（叉号）。`pickSub('')` 在开单分析那边会顺手把图表和结论也清掉 */
function clear() {
  emit('update:modelValue', '')
  emit('pick', '')
  close()
  inputEl.value?.focus()
  inputEl.value?.select()
}

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  filter.value = v
  emit('update:modelValue', v)
  open.value = true
  hot.value = 0
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    close()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open.value) return
    e.preventDefault()
    const n = items.value.length
    if (!n) return
    hot.value = (hot.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (open.value) {
      const first = items.value[hot.value] ?? items.value[0]
      if (first) pick(first.base)
      else close()
      return
    }
    emit('submit')
  }
}

function onBlur(e: FocusEvent) {
  // 点到列表项时不要先关掉，否则 click 拿不到元素
  const next = e.relatedTarget as Node | null
  if (next && boxEl.value?.contains(next)) return
  close()
}
</script>

<template>
  <div ref="boxEl" class="combo">
    <input
      ref="inputEl"
      :value="modelValue"
      placeholder="输入币种搜索，如 BTC"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @focus="show"
      @click="show"
      @keydown="onKey"
      @blur="onBlur"
    />
    <button
      v-if="modelValue"
      type="button"
      class="combo-clear"
      title="清空"
      @mousedown.prevent="clear"
      @click.prevent="clear"
    >
      ✕
    </button>
    <button type="button" title="展开全部合约" @click="open ? close() : show()">
      ▾
    </button>

    <div v-if="open" class="combo-list">
      <div v-if="!items.length" class="combo-empty">无匹配合约</div>
      <div
        v-for="(c, i) in items"
        :key="c.symbol"
        class="combo-item"
        :class="{hot: i === hot}"
        @mousedown.prevent="pick(c.base)"
        @mouseenter="hot = i"
      >
        <span>{{ c.base }}</span>
      </div>
      <div v-if="truncated" class="combo-empty">
        只显示前 {{ items.length }} 个，继续打字缩小范围
      </div>
    </div>
  </div>
</template>
