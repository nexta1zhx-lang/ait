<script setup lang="ts">
/**
 * 「交易所资产」面板的**临时容器：喂模拟数据**。
 *
 * 用户 2026-10-05：「可以，数据先填充模拟数据再真实页面上」——
 * 也就是**先把新界面接进真实页面（开单分析 → 交易所账户），数字先造假**，
 * 看着排版顺眼之后再接后端。
 *
 * ⚠️⚠️ 这里显示的是**假数据**（`exchangeMock.ts`），不是你的账户！
 *    所以顶上挂了一个「模拟数据」的标签，别当成真余额看。
 *    上线前必须换成真数据容器（后端 `/api/exchange/overview` 那条路），
 *    换的时候：把 `AnalyzeView` 里的 `ExchangeAccountMockPanel` 换回真容器、
 *    然后删掉这个文件 + `exchangeMock.ts` + `/preview/account` 预览页。
 */
import {computed, ref} from 'vue'
import ExchangeAccountBoard from './ExchangeAccountBoard.vue'
import {
  MOCK_ACCOUNTS,
  MOCK_INCOME,
  MOCK_OPEN_ORDERS,
  MOCK_TRADES
} from './exchangeMock'

const picked = ref(1)
const symbol = ref('')

const data = computed(
  () => MOCK_ACCOUNTS.find(a => a.value === picked.value)?.data ?? null
)
/** 慢接口那几块（挂单/成交/盈亏）：空账户就当作没有 */
const hasData = computed(() => (data.value?.futures.positions.length ?? 0) > 0)
</script>

<template>
  <div class="mock">
    <!-- 顶上一行：换一套假账户 + 明确标出这是模拟数据 -->
    <div class="bar">
      <select v-model.number="picked" aria-label="模拟账户">
        <option v-for="a in MOCK_ACCOUNTS" :key="a.value" :value="a.value">
          {{ a.label }}
        </option>
      </select>
      <span class="tag mock" title="这里显示的是假数据，不是你的真实账户">
        模拟数据
      </span>
    </div>

    <ExchangeAccountBoard
      v-model:symbol="symbol"
      :data="data"
      :open-orders="hasData ? MOCK_OPEN_ORDERS : []"
      :trades="hasData ? MOCK_TRADES : []"
      :income="hasData ? MOCK_INCOME : []"
      @refresh="() => {}"
      @search="() => {}"
    />
  </div>
</template>

<style scoped>
.mock {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 9px;
  font-size: 13px;
}
/* 一定要显眼：这一页现在是假数字 */
.tag.mock {
  color: var(--warn, #f0b429);
  border-color: color-mix(in srgb, var(--warn, #f0b429) 45%, transparent);
  background: var(--warn-soft, rgba(240, 180, 41, 0.14));
  white-space: nowrap;
}
</style>
