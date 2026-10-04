<script setup lang="ts">
/**
 * 「交易所资产」新版界面的预览页（**只有模拟数据**，不连任何接口）。
 *
 * 用户 2026-10-05：「先设计移动端界面」「根据返回的数据格式先模拟一套数据看看效果」。
 * 所以这一页只干一件事：把 `ExchangeAccountBoard` 摆出来，数据全来自
 * `comps/exchangeMock.ts`。
 *
 * 免登录：路径写在 `App.vue` 的 `isPublicPage` 里（页面里只有假数据，没有凭据）。
 * 定稿之后：把真数据那条路（analyze 的「交易所账户」tab）也换成这个 board，
 * 然后这个页连同 mock 一起删。
 */
import {computed, ref} from 'vue'
import ExchangeAccountBoard from '../comps/ExchangeAccountBoard.vue'
import {
  MOCK_ACCOUNTS,
  MOCK_INCOME,
  MOCK_OPEN_ORDERS,
  MOCK_TRADES
} from '../comps/exchangeMock'

const picked = ref(1)
/** 手机宽度 / 宽栏，两种排版对比着看 */
const wide = ref(false)

const data = computed(
  () => MOCK_ACCOUNTS.find(a => a.value === picked.value)?.data ?? null
)
/** 慢接口那几块：空账户就当作没有 */
const hasTrades = computed(
  () => (data.value?.futures.positions.length ?? 0) > 0
)
</script>

<template>
  <div class="pv">
    <section class="panel head">
      <h1>交易所资产 · 移动端界面预览</h1>
      <p class="hint">
        数据是<b>本地模拟</b>的，结构照 <code>fapi/v2/account</code> +
        <code>sapi/v1/asset/wallet/balance</code> 拟（见
        comps/exchangeMock.ts）。 只统计 <b>USDT 合约 + C2C 钱包</b>，不含现货。
      </p>
      <div class="ctl">
        <select v-model.number="picked">
          <option v-for="a in MOCK_ACCOUNTS" :key="a.value" :value="a.value">
            {{ a.label }}
          </option>
        </select>
        <span class="spacer" />
        <button class="ghost tiny" :class="{on: wide}" @click="wide = !wide">
          {{ wide ? '手机宽度' : '宽栏' }}
        </button>
      </div>
    </section>

    <div class="stage" :class="{wide}">
      <ExchangeAccountBoard
        :data="data"
        :open-orders="hasTrades ? MOCK_OPEN_ORDERS : []"
        :trades="hasTrades ? MOCK_TRADES : []"
        :income="hasTrades ? MOCK_INCOME : []"
        @refresh="() => {}"
      />
    </div>
  </div>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  max-width: 1100px;
  margin: 0 auto;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 16px;
}
.head .hint {
  margin: 0 0 10px;
}
.head code {
  background: var(--panel-2);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 11.5px;
}
.ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ctl select {
  padding: 7px 9px;
  font-size: 13px;
  min-width: 180px;
}
.spacer {
  flex: 1 1 auto;
}
.ghost.on {
  color: var(--blue, #d3b583);
  border-color: var(--blue, #d3b583);
}
/* 默认按手机宽度摆（约等于 PC 上开单分析左栏） */
.stage {
  max-width: 420px;
}
.stage.wide {
  max-width: 100%;
}
</style>
