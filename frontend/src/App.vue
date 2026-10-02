<script setup lang="ts">
import {computed, onMounted, ref, watch} from 'vue'
import {RouterLink, RouterView, useRoute} from 'vue-router'
import {cny} from './format'
import {
  balanceBadge,
  bootstrap,
  changeModel,
  config,
  kbBadge,
  modelOptions,
  notices,
  refreshBalance,
  refreshingBalance,
  rulesBadge,
  switchingModel
} from './store'

const NAV = [
  {to: '/', label: '开单分析'},
  {to: '/history', label: '预测历史'},
  {to: '/knowledge', label: '历史知识库'},
  {to: '/prompts', label: 'AI 提示词'},
  {to: '/usage', label: '用量'}
]

const toast = ref('')
const accountError = ref('')

/**
 * 开单分析 / 预测历史要「一屏塞下、内部各自滚动」，其它页还是普通长文档。
 * 页面高度归 body 管，所以在这里切一个 class，别影响别的路由。
 */
const route = useRoute()
watch(
  () => route.path,
  p => {
    document.body.classList.toggle(
      'fixed-viewport',
      p === '/' || p === '/history'
    )
  },
  {immediate: true}
)

onMounted(bootstrap)

let timer: number | undefined
function flash(msg: string) {
  toast.value = msg
  window.clearTimeout(timer)
  timer = window.setTimeout(() => (toast.value = ''), 4000)
}

async function onModel(v: string) {
  accountError.value = ''
  const err = await changeModel(v)
  if (err) accountError.value = err
  else flash(`已切到 ${v}，下一次判断就用它`)
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <h1>开单分析</h1>
      <span class="sub">分析预测提示词 + 行情数据 → 最大概率会怎么走</span>
    </div>

    <nav class="nav">
      <RouterLink v-for="n in NAV" :key="n.to" :to="n.to">
        {{ n.label }}
      </RouterLink>
    </nav>

    <!-- 模型切换 + 余额（点一下刷新） -->
    <div v-if="config" class="account">
      <label
        class="model-pick"
        title="切换判断用的模型（会写进 .env，重启也保留）"
      >
        <span class="dim">模型</span>
        <select
          :value="config.model"
          :disabled="switchingModel"
          @change="onModel(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="m in modelOptions" :key="m.id" :value="m.id">
            {{ m.id }}{{ m.priced ? '' : '（无价目）' }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="badge balance"
        :class="balanceBadge.cls"
        :title="balanceBadge.title"
        :disabled="refreshingBalance"
        @click="refreshBalance"
      >
        {{ refreshingBalance ? '余额 …' : balanceBadge.text }}
      </button>
    </div>

    <div class="topmeta">
      <span class="badge" :class="rulesBadge.cls" :title="rulesBadge.title">
        {{ rulesBadge.text }}
      </span>
      <span class="badge" :class="kbBadge.cls">{{ kbBadge.text }}</span>
      <RouterLink
        to="/usage"
        class="badge"
        :class="config && config.usage.allCalls > 0 ? 'ok' : ''"
        :title="
          config
            ? `今日 ${config.usage.todayCalls} 次 / 累计 ${config.usage.allCalls} 次真实调用`
            : ''
        "
      >
        <template v-if="config && config.usage.allCalls > 0">
          花费 今日 {{ cny(config.usage.todayCostCny) }} · 累计
          {{ cny(config.usage.allCostCny) }}（{{ config.usage.allCalls }} 次）
        </template>
        <template v-else>花费 暂无付费调用</template>
      </RouterLink>
      <span class="dim">仅供纪律辅助，非投资建议</span>
    </div>
  </header>

  <div v-if="toast" class="notice">{{ toast }}</div>
  <div v-if="accountError" class="error">{{ accountError }}</div>
  <div v-if="notices.length" class="notice">{{ notices.join('\n') }}</div>

  <RouterView />
</template>

<style scoped>
.account {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-pick {
  display: flex;
  align-items: center;
  gap: 6px;
}

.model-pick > span {
  font-size: 12px;
}

.model-pick select {
  width: auto;
  min-width: 150px;
  padding: 5px 9px;
  font-size: 12px;
}
</style>
