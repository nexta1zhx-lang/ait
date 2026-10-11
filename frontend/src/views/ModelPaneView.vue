<script setup lang="ts">
/**
 * 「我的 → 模型配置」这一格 —— 三个子 tab：**密钥配置 / 用量统计 / AI 提示词**。
 *
 * ★ 2026-10-12 用户原话：
 *   「ai 提示词 tab 改为模型配置，个人信息中的模型配置内容提出到这个页面和 ai 提示词合并
 *     改为 3 个子 tab，1 密钥配置 2. 用量统计 3.ai 提示词」
 *
 * 于是三处一起动：
 *   · 一级 tab 的**标签**从「AI 提示词」改成「模型配置」（在 `MeView` 的 `PANES` 里）；
 *   · 「个人信息」里那段「模型配置」**搬出来**（`ProfileView` 不再有这一格）；
 *   · 原来「模型配置」是一大坨（密钥表 + 内嵌用量），这里**拆成三段**：
 *     密钥（`LlmConfigView`）/ 用量（`UsageView`）/ 提示词（`PromptsView`）。
 *
 * 二级 tab 的状态放在 `MeView`、写进地址栏 `?t=keys|usage|prompts`
 * （跟「管理」那一格的 `?t=users|server` 同一套）。
 *
 * 三格**切走即卸载** —— 都没有轮询 / 订阅，重挂很便宜（`UsageView` 会重拉一次统计）。
 */
import {computed} from 'vue'
import SegTabs from '../comps/SegTabs.vue'
import LlmConfigView from './LlmConfigView.vue'
import UsageView from './UsageView.vue'
import PromptsView from './PromptsView.vue'

export type ModelTab = 'keys' | 'usage' | 'prompts'

const TABS: {value: ModelTab; label: string}[] = [
  {value: 'keys', label: '密钥配置'},
  {value: 'usage', label: '用量统计'},
  {value: 'prompts', label: 'AI 提示词'}
]

const props = defineProps<{tab?: ModelTab}>()
const emit = defineEmits<{'update:tab': [ModelTab]}>()

const current = computed(() => props.tab ?? 'keys')
</script>

<template>
  <div class="model-pane">
    <SegTabs
      class="model-tabs"
      :model-value="current"
      :options="TABS"
      @update:model-value="v => emit('update:tab', v as ModelTab)"
    />

    <LlmConfigView v-if="current === 'keys'" />
    <UsageView v-else-if="current === 'usage'" />
    <PromptsView v-else />
  </div>
</template>

<style scoped>
.model-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/*
 * 二级 tab（密钥配置 / 用量统计 / AI 提示词）—— 跟「管理」那格同一套**胶囊分段器**
 * （`.adm-tabs` / `.prof-tabs` 是同一份样式的另外两处副本）。
 */
.model-tabs {
  flex: 0 0 auto;
  align-self: flex-start;
  max-width: 100%;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: linear-gradient(120deg, rgb(19, 19, 21), rgb(18, 15, 13));
  overflow-x: auto;
  scrollbar-width: none;
}
.model-tabs::-webkit-scrollbar {
  display: none;
}
/* ⚠️ 按钮在子组件（`SegTabs.vue`）里 ⇒ 必须 `:deep()` 才够得着 */
.model-tabs :deep(button) {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
}
.model-tabs :deep(button.active) {
  background: linear-gradient(
    112deg,
    rgba(255, 217, 158, 0.25) 0%,
    rgba(255, 193, 107, 0.15) 52%,
    rgba(243, 154, 63, 0.09) 100%
  );
  color: #ffd291;
  box-shadow: inset 0 0 0 1px rgba(255, 193, 107, 0.12);
}
</style>
