<script setup lang="ts">
/**
 * 头部行情条右侧那一行：1天 / 3天 / 7天 / 1个月 / 3个月 / 1年 涨幅。
 *
 * 口径 = 「第 N 天前那根日线的收盘 → 现价」（跟交易所同一个算法）。
 * ⚠️ 「1天」是**今日涨跌（UTC 日切：昨收 → 现价）**，跟头部那条「24h 涨跌」（滚动 24 小时）
 *    不是一个数 —— 2026-10-07 专门拍的口径：两档都留，且要能看出差别。
 *
 * ★ 2026-10-07 还改成**本地算**：后端连基点（`changeBases`）一起给，
 *    而现价每秒都在被行情增量刷新 ⇒ 这一行跟着秒级跳动（原来要等 60 秒那次 `/api/ticker`）。
 * 绿涨红跌；某一档数据不够（新上币 / 库里还没那么多日线）就显示「—」。
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
    /* 现价（每秒被行情增量刷新）+ 基点 ⇒ 本地实时算；基点还没到就退回后端算好的那个 */
    const t = ticker.value
    const base = t?.changeBases?.[key]
    const last = Number(t?.last)
    const live =
      base && base.close > 0 && Number.isFinite(last)
        ? (last / base.close - 1) * 100
        : null
    const raw = live ?? t?.changes?.[key]
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
