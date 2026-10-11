<script setup lang="ts">
/**
 * 日历图标 —— **全站共用这一份**（原来在 `KlineChart.vue` 里内联着，2026-10-12 提出来）。
 *
 * 用户 2026-10-12：「日期筛选换成带日历图标的日期输入框，**图标复用** K 线页那颗」——
 * 所以形状照抄 K 线页「看某一刻」那颗（24 方格子里一个带两个挂钩的日历），
 * 只是搬到这里给两处共用。
 *
 * 用法：`<IconCalendar />`（颜色跟 `currentColor`，尺寸用 `size`）。
 */
withDefaults(defineProps<{size?: number}>(), {size: 14})
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="5" width="18" height="15.5" rx="2.5" />
    <path d="M3 10h18M8 3.2v3.6M16 3.2v3.6" />
  </svg>
</template>
