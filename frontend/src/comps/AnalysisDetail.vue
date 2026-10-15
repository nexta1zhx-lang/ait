<script setup lang="ts">
/**
 * **一条分析的详情**（点列表里那一行 → 看全文）。
 *
 * 为什么单独一个组件：三处都要看同一份东西 —— 「预测结果」的历史列表（`PredictHistory`）、
 * K 线页那个「持久化分析」弹层的时间线、以及「自动化预测 → AI 分析」的时间线。
 * 各写一份的话，头部那行信息（币种 / 时间 / 当时价 / 周期）迟早会写歪。
 *
 * 全文渲染交给 `AnswerBody`（Markdown → HTML 的转义规则都在 `markdown.ts`）。
 */
import {bjTime, fmt} from '../format'
import AnswerBody from './AnswerBody.vue'

const props = defineProps<{
  open: boolean
  symbol: string
  /** 周期（`1h` / `4h`…）；没有就不显示那一截 */
  timeframe?: string | null
  /** 那一刻（ISO 字符串或毫秒） */
  at?: string | number | null
  /** 分析那一刻的现价 */
  price?: number | null
  /** 结论原文（整篇 Markdown） */
  line: string | null
  /** 档位：`go` / `no` / `wait`（染色用，跟列表里那个色块一致） */
  verdict?: string | null
  /** 底部再挂一颗按钮时用（比如「看 K 线」） */
  actionText?: string
}>()

const emit = defineEmits<{close: []; action: []}>()

function timeText(): string {
  const a = props.at
  if (a === null || a === undefined || a === '') return ''
  return bjTime(typeof a === 'number' ? a : a)
}

function verdictText(): string {
  return props.verdict === 'go' ? '可做' : props.verdict === 'no' ? '不可做' : '观望'
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet warm-skin ad-sheet" role="dialog" aria-label="分析详情">
      <header class="sheet-head">
        <b>{{ symbol }}</b>
        <span class="dim ad-meta">
          <span v-if="verdict" class="ps-v" :class="verdict">{{ verdictText() }}</span>
          <span v-if="timeframe" class="ad-tf">{{ timeframe }}</span>
          {{ timeText() }}
          <template v-if="price !== null && price !== undefined">
            · 当时 {{ fmt(price) }}
          </template>
        </span>
        <button type="button" class="sheet-x" title="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="ad-body detail-body">
        <AnswerBody v-if="line?.trim()" :text="line" />
        <p v-else class="dim">（这条没留下结论）</p>
      </div>

      <div v-if="actionText" class="ad-foot">
        <button type="button" class="ghost tiny" @click="emit('action')">{{ actionText }}</button>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
/*
 * 版面跟「预测结果」里那个详情弹层（`.pred-detail`）刻意保持一致 ——
 * 同一件事在两处看起来不该是两个样。
 * ⚠️ 正文的**字号**那份规则不在这儿：`.detail-body` 在 `style.css` 里，
 *    两个详情弹层共用一份（用户 2026-10-15：「详情字体太大了」→「预测结果详情也小一点」）。
 */
.ad-sheet {
  max-height: 80vh;
}

.ad-sheet .sheet-head {
  /* 币种 + 一行小字（时间 / 周期 / 当时价） */
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.ad-sheet .sheet-head b {
  font-size: 14px;
}

.ad-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}

.ad-tf {
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
}

.ad-body {
  max-height: 58vh;
  overflow: auto;
  -webkit-overflow-scrolling: touch;
}

</style>
