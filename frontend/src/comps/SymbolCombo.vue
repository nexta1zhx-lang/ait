<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import type {Contract} from '../api'

/**
 * 币种选择。
 * 点开默认展开**全部**合约（只显示币种，不带 /USDT）；
 * 打字则按前缀过滤；回车选中第一项，Esc 关闭。
 *
 * ★ 2026-10-03 多了一个 **`plain` 模式**（用户：「去掉搜索只显示币种」）：
 * 窄屏不摆输入框了，就一行「币种 ▾」；点它展开列表，
 * **搜索框挪进列表最上面** —— 528 个合约照样能搜到。
 * 好处：顶部那一行不再被一个“像搜索框的框”占掉 150px。
 */

const props = defineProps<{
  modelValue: string
  contracts: Contract[]
  /** 一次最多渲染多少项（防止几百上千条时卡顿） */
  max?: number
  /** 只显示币种、不要输入框（窄屏用） */
  plain?: boolean
  /**
   * 空值时的占位文案。
   *
   * ⚠️ 2026-10-07 加：账本三格（仓位历史 / 成交历史 / 资金动向）的筛选器要显示
   *    **「全部」**（`''` = 不筛），而开单分析那边空值的含义是「还没选币」——
   *    默认值仍是「选币种」，别改默认行为。
   */
  placeholder?: string
  /**
   * 给了就在列表**最上面**多一颗「全部」（选中它 emit 空串）。
   *
   * ⚠️ 2026-10-07 加：账本三格用 `plain` 模式（一行「全部 ▾」），
   *    而 plain 模式**没有输入框旁边那颗 ✕** —— 没有这一项就没法从某个币回到「全部」。
   *    开单分析那边不传，行为一点没变。
   */
  allLabel?: string
}>()

/** 空值时的占位（见 `placeholder` 的说明） */
const emptyText = computed(() => props.placeholder ?? '选币种')

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

/** 列表最上面那颗「全部」（`allLabel`）：选中 = 清空筛选 */
function pickAll() {
  pick('')
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

/*
 * 点外面关掉。
 *
 * 原来只靠输入框的 `blur` —— 但 `plain` 模式里那颗是个普通按钮，
 * 手指点它**不一定拿得到焦点**（尤其 iPhone），那样列表就永远关不掉。
 * 所以再挂一个 document 层的 mousedown（捕获阶段）。
 */
function onDocDown(e: MouseEvent): void {
  if (boxEl.value && !boxEl.value.contains(e.target as Node)) close()
}

watch(open, v => {
  if (v) document.addEventListener('mousedown', onDocDown, true)
  else document.removeEventListener('mousedown', onDocDown, true)
})

onBeforeUnmount(() =>
  document.removeEventListener('mousedown', onDocDown, true)
)
</script>

<template>
  <div ref="boxEl" class="combo" :class="{plain}">
    <!--
      窄屏：不摆输入框，就一行「币种 ▾」（用户：「去掉搜索只显示币种」）。
      点它展开列表，搜索框在列表里。
    -->
    <button
      v-if="plain"
      type="button"
      class="combo-plain"
      :class="{open}"
      title="切换币种"
      @blur="onBlur"
      @click="open ? close() : show()"
    >
      <!--
        ⚠️ 占位那档的类名**不能叫 `empty`**：全站 `.empty` 是「空态块」（`padding: 22px 0` +
           `text-align: center`），套到这颗标签上会把表头那一行整个顶成 65px 高
           （用户 2026-10-07：「标题栏间距太大了」））。
      -->
      <span class="combo-plain-t" :class="{ph: !modelValue}">{{ modelValue || emptyText }}</span>
      <span class="combo-plain-caret">▾</span>
    </button>

    <!-- 宽屏：原来的输入框（叉号和箭头叠在里侧，别另占宽度） -->
    <div v-else class="combo-box" :class="{clearable: !!modelValue}">
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
      <button
        type="button"
        class="combo-caret"
        title="展开全部合约"
        @mousedown.prevent
        @click="open ? close() : show()"
      >
        ▾
      </button>
    </div>

    <div v-if="open" class="combo-list">
      <!-- 窄屏没有输入框了，所以搜索框搬到列表最上面 -->
      <input
        v-if="plain"
        v-model="filter"
        class="combo-search"
        placeholder="搜币种，如 BTC"
        autocomplete="off"
        spellcheck="false"
        @keydown="onKey"
      />
      <div
        v-if="allLabel && !filter.trim()"
        class="combo-item all"
        @mousedown.prevent="pickAll"
      >
        <span>{{ allLabel }}</span>
      </div>
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
