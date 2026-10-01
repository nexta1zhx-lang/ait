<script setup lang="ts">
/** 顶部 KPI 卡片组 */

export interface StatCard {
  label: string
  value: string
  sub?: string
  tone?: '' | 'ok' | 'bad' | 'warn' | 'blue'
}

defineProps<{cards: StatCard[]}>()
</script>

<template>
  <div class="cards">
    <div v-for="c in cards" :key="c.label" class="card" :class="c.tone">
      <div class="k">{{ c.label }}</div>
      <div class="v">{{ c.value }}</div>
      <div v-if="c.sub" class="sub">{{ c.sub }}</div>
    </div>
  </div>
</template>
