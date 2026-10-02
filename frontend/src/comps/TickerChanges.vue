<script setup lang="ts">
/**
 * K 线块**底部**那一行：1天 / 3天 / 7天 / 1个月 / 3个月 / 1年 涨幅。
 *
 * 口径 = 「第 N 天前那根日线的收盘 → 现价」（跟交易所同一个算法，后端算好）。
 * 绿涨红跌；某一档数据不够（新上币）就显示「—」。
 */
import {computed} from 'vue'
import {fixed} from '../format'
import type {ChangeWindow} from '../api'
import {ticker} from '../ticker'

const LABELS: {key: ChangeWindow; label: string}[] = [
  {key: 'd1', label: '1天'},
  {key: 'd3', label: '3天'},
  {key: 'd7', label: '7天'},
  {key: 'm1', label: '1个月'},
  {key: 'm3', label: '3个月'},
  {key: 'y1', label: '1年'}
]

const items = computed(() =>
  LABELS.map(({key, label}) => {
    const raw = ticker.value?.changes?.[key]
    const n = Number(raw)
    const ok = raw !== null && raw !== undefined && Number.isFinite(n)
    return {
      label,
      text: ok ? `${n >= 0 ? '+' : ''}${fixed(n, 2)}%` : '—',
      tone: ok ? (n >= 0 ? 'up' : 'down') : ''
    }
  })
)
</script>

<template>
  <div class="tk-changes">
    <span v-for="it in items" :key="it.label" class="tk-chg-item">
      <span class="k">{{ it.label }}</span>
      <span class="v" :class="it.tone">{{ it.text }}</span>
    </span>
  </div>
</template>
