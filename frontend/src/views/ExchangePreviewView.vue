<script setup lang="ts">
/**
 * 「交易所账户」新版界面的**预览页**（模拟数据，不连任何接口）。
 *
 * 用户 2026-10-05：「交易所行情账户界面大优化，根据返回的数据格式先模拟一套数据
 * 看看效果」—— 真数据要绑 Key + 打交易所，样式来回调的时候太慢，
 * 所以这里用 `exchangeMock.ts` 那套假数据把新界面直接摆出来。
 *
 * 免登录：路径写在 `App.vue` 的 `isPublicPage` 里（只有假数据，没有真凭据）。
 * 定稿之后：把真数据那条路（`ExchangeAccountPanel.vue`）也换成
 * `ExchangeAccountBoard`，这个页和 mock 就可以删了。
 */
import {computed, ref} from 'vue'
import ExchangeAccountBoard from '../comps/ExchangeAccountBoard.vue'
import {MOCK_CONTRACT, MOCK_EMPTY, MOCK_SPOT} from '../comps/exchangeMock'
import type {ExchangeAccountResult} from '../api'

/** 三套「账户」= 三种典型数据形状 */
const accounts: {id: number; label: string; data: ExchangeAccountResult}[] = [
  {id: 1, label: '币安 · 主号（合约）', data: MOCK_CONTRACT},
  {id: 2, label: 'OKX 现货', data: MOCK_SPOT},
  {id: 3, label: '币安 · 小号（空）', data: MOCK_EMPTY}
]

const picked = ref(1)
/** 状态预览：正常 / 查询中 / 查询失败 */
const state = ref<'ok' | 'loading' | 'error'>('ok')
const orderSymbol = ref('')

const data = computed<ExchangeAccountResult | null>(() => {
  if (state.value !== 'ok') return null
  return accounts.find(a => a.id === picked.value)?.data ?? null
})
const loading = computed(() => state.value === 'loading')
const error = computed(() =>
  state.value === 'error' ? '币安接口返回：Invalid API-key, IP, or permissions for action.' : ''
)

/** 预览宽度：默认按手机上那一栏（≈ 手机上全宽 / PC 左栏） */
const wide = ref(false)
</script>

<template>
  <div class="pv">
    <section class="panel head">
      <h1>交易所账户界面 · 预览</h1>
      <p class="hint">
        这一页吃的是本地模拟数据（结构照 /api/exchange/account 的返回，见
        comps/exchangeMock.ts），用来先看新版排版 —— 真数据那条路还没换过来。
        右上角可以切「正常 / 查询中 / 查询失败」三种状态和宽窄两档宽度。
      </p>

      <div class="ctl">
        <select v-model.number="picked" :disabled="state !== 'ok'">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.label }}</option>
        </select>
        <button
          v-for="s in [
            {v: 'ok', l: '正常'},
            {v: 'loading', l: '查询中'},
            {v: 'error', l: '查询失败'}
          ]"
          :key="s.v"
          class="ghost tiny"
          :class="{on: state === s.v}"
          @click="state = s.v as 'ok' | 'loading' | 'error'"
        >
          {{ s.l }}
        </button>
        <span class="spacer" />
        <button class="ghost tiny" :class="{on: wide}" @click="wide = !wide">
          {{ wide ? '窄栏' : '宽栏' }}
        </button>
      </div>
    </section>

    <div class="stage" :class="{wide}">
      <ExchangeAccountBoard
        v-model:symbol="orderSymbol"
        :data="data"
        :loading="loading"
        :error="error"
        @search="() => {}"
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
.ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ctl select {
  padding: 6px 8px;
  font-size: 13px;
  min-width: 160px;
}
.spacer {
  flex: 1 1 auto;
}
.ghost.on {
  color: var(--blue, #d3b583);
  border-color: var(--blue, #d3b583);
}
/* 窄栏 = 手机上那一栏的宽度（PC 上开单分析左栏 ≈ 430px） */
.stage {
  max-width: 430px;
}
.stage.wide {
  max-width: 100%;
}
</style>
