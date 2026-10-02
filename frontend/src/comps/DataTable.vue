<script lang="ts">
/**
 * 通用列定义。
 * 泛型参数必须写在这里（普通 `<script>` 块）——
 * 写在 `<script setup generic>` 里的话，别的文件 import 时拿不到泛型参数，
 * 会报「类型 Column 不是泛型类型」。
 */
export interface Column<T = Record<string, any>> {
  /** 行数据字段名，同时作为插槽名 */
  key: string
  label: string
  align?: 'left' | 'right'
  /** 排序取值；默认取 row[key] */
  value?: (row: T) => number | string
  /** 默认排序方向 */
  dir?: 'asc' | 'desc'
  /** 首列加粗 */
  strong?: boolean
  /**
   * 列宽提示（CSS 宽度，如 `'130px'`）。
   *
   * 不给宽度的列会自己吸掉剩下的空间 —— 想让「内容很长的那一列」变宽，
   * 就把**其他**列都写上宽度。
   */
  width?: string
  /** 允许换行（默认 `nowrap`，长文本会把表撑得很宽） */
  wrap?: boolean
}
</script>

<script setup lang="ts" generic="T extends Record<string, any>">
import {computed, ref} from 'vue'

/** 通用表格：点击表头排序 + 具名插槽自定义单元格 */

const props = defineProps<{
  columns: Column<T>[]
  rows: T[]
  empty?: string
  initialSort?: string
  /**
   * 按 `columns[].width` 严格分列（`table-layout: fixed`）。
   *
   * 不打开的话浏览器会按内容自己分，写了宽度的列可能被别的列抢走空间 ——
   * 列宽跟内容差很多（如「标签」这种要换行的）就必须开。
   * 没写宽度的列平分剩下的宽度。
   */
  fixed?: boolean
}>()

const sortKey = ref(props.initialSort ?? '')
const sortDir = ref<'asc' | 'desc'>('desc')

const sorted = computed(() => {
  const col = props.columns.find(c => c.key === sortKey.value)
  if (!col) return props.rows
  const get = (r: T): number | string =>
    col.value ? col.value(r) : (r[col.key] as number | string)
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...props.rows].sort((a, b) => {
    const x = get(a)
    const y = get(b)
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
    return String(x).localeCompare(String(y)) * dir
  })
})

function toggle(col: Column<T>) {
  if (!col.value && !(col.key in (props.rows[0] ?? {}))) return
  if (sortKey.value === col.key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sortKey.value = col.key
  sortDir.value = col.dir ?? 'desc'
}

function arrow(col: Column<T>) {
  if (sortKey.value !== col.key) return ''
  return sortDir.value === 'asc' ? '▲' : '▼'
}
</script>

<template>
  <div class="table-wrap">
    <table class="table" :class="{fixed}">
      <thead>
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            :class="[c.align === 'right' ? 'r' : '', 'sortable']"
            :style="c.width ? {width: c.width} : null"
            @click="toggle(c)"
          >
            {{ c.label }}<span class="ar">{{ arrow(c) }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!sorted.length">
          <td :colspan="columns.length" class="empty">
            {{ empty ?? '（无数据）' }}
          </td>
        </tr>
        <tr v-for="(row, i) in sorted" :key="i">
          <td
            v-for="c in columns"
            :key="c.key"
            :class="[
              c.align === 'right' ? 'r' : '',
              c.strong ? 's' : '',
              c.wrap ? 'wrap' : ''
            ]"
            :style="c.width ? {width: c.width} : null"
          >
            <slot :name="c.key" :row="row" :value="row[c.key]">
              {{ row[c.key] }}
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
