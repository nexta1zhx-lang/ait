<script setup lang="ts">
/**
 * AI 那段自由发挥的回复 → 渲染成 HTML（标题 / 加粗 / 列表 / 段落）。
 *
 * 渲染规则与安全边界都在 `frontend/src/markdown.ts`（先转义再拼标签）。
 * 样式在 `style.css` 的 `.answer-body` 那一节。
 */
import {computed} from 'vue'
import {renderMarkdown} from '../markdown'

const props = defineProps<{
  text: string
  /** 单个换行也断行（日记那种「一行一句」的手写正文要它） */
  softBreaks?: boolean
}>()

const html = computed(() => renderMarkdown(props.text, {softBreaks: props.softBreaks}))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html —— 内容是 renderMarkdown 转义后拼出来的，不走用户 HTML -->
  <div class="answer-body" v-html="html" />
</template>
