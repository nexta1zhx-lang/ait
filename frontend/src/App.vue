<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import {RouterLink, RouterView} from 'vue-router'
import {cny} from './format'
import {
  account,
  bootstrap,
  changeModel,
  config,
  kbBadge,
  modelOptions,
  notices,
  refreshBalance,
  rulesBadge,
  switchingModel
} from './store'

const NAV = [
  {to: '/', label: '开单分析'},
  {to: '/history', label: '历史'},
  {to: '/knowledge', label: '知识库'},
  {to: '/usage', label: '用量'}
]

const toast = ref('')
const accountError = ref('')

onMounted(bootstrap)

const balanceText = computed(() => {
  const b = config.value?.balance
  if (!b || !b.ok || b.cny === null) return '余额 —'
  return `余额 ${cny(b.cny)}`
})

const balanceTip = computed(() => {
  const b = account.value?.balance
  if (!b) return '点一下刷新余额'
  if (!b.ok) return b.error ?? '拿不到余额'
  const info = b.infos[0]
  if (!info) return 'DeepSeek 账户余额'
  return [
    `总余额 ${cny(info.total)}`,
    `充值 ${cny(info.toppedUp)}`,
    `赠金 ${cny(info.granted)}`,
    b.available ? '账户可用' : '账户不可用',
    b.cached ? '（缓存）' : ''
  ]
    .filter(Boolean)
    .join(' · ')
})

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

async function onRefresh() {
  await refreshBalance()
  const b = account.value?.balance
  accountError.value = b && !b.ok ? (b.error ?? '拿不到余额') : ''
  if (b?.ok) flash('余额已刷新')
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <h1>开单分析</h1>
      <span class="sub">我的规则 + 知识库 → 该不该做</span>
    </div>

    <nav class="nav">
      <RouterLink v-for="n in NAV" :key="n.to" :to="n.to">
        {{ n.label }}
      </RouterLink>
    </nav>

    <!-- 模型切换 + 账户余额（人民币） -->
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
        :class="config.balance.ok ? 'ok' : 'bad'"
        :title="balanceTip"
        @click="onRefresh"
      >
        {{ balanceText }}
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

button.balance {
  background: transparent;
  font-weight: 400;
  cursor: pointer;
  font-family: inherit;
}

button.balance:hover:not(:disabled) {
  border-color: var(--blue);
  color: var(--blue);
  filter: none;
}
</style>
