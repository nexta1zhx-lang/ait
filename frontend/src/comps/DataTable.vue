<script setup lang="ts" generic="T extends Record<string, any>">
import {computed, ref} from 'vue'

/** 通用表格：点击表头排序 + 具名插槽自定义单元格 */

export interface Column {
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
}

const props = defineProps<{
  columns: Column[]
  rows: T[]
  empty?: string
  initialSort?: string
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

function toggle(col: Column) {
  if (!col.value && !(col.key in (props.rows[0] ?? {}))) return
  if (sortKey.value === col.key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sortKey.value = col.key
  sortDir.value = col.dir ?? 'desc'
}

function arrow(col: Column) {
  if (sortKey.value !== col.key) return ''
  return sortDir.value === 'asc' ? '▲' : '▼'
}
</script>

<template>
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            :class="[c.align === 'right' ? 'r' : '', 'sortable']"
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
            :class="[c.align === 'right' ? 'r' : '', c.strong ? 's' : '']"
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
