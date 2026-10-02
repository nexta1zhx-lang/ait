<script setup lang="ts">
/**
 * K 线块**顶部**那条行情（币安期货页顶部那种排法）：
 *
 *   左 = 币种（下拉，外层用 #symbol 插进来）+ 永续标记
 *   中 = 现价（大字）+ 24h 涨跌额 / 涨跌幅
 *   右 = 标记价格 / 指数价格 / 资金费率 + 倒计时 / 24h 高低 / 成交量额 / 持仓量
 *
 * 数据来自「../ticker」（15 秒刷一次），拿不到就显示「—」，不挡页面。
 */
import {computed} from 'vue'
import {fixed, fmt} from '../format'
import {nowTick, ticker} from '../ticker'

/** 涨了绿、跌了红 —— 跟图上蜡烛一套 */
const tone = computed(() => {
  const v = ticker.value?.change24hPct
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return ''
  return Number(v) >= 0 ? 'up' : 'down'
})

const lastText = computed(() => fmt(ticker.value?.last))

const changeText = computed(() => {
  const d = ticker.value
  if (!d || d.change24h === null || d.change24hPct === null) return '—'
  const abs = fmt(d.change24h)
  const p = `${Number(d.change24hPct) >= 0 ? '+' : ''}${fixed(d.change24hPct, 2)}%`
  return `${abs}  ${p}`
})

/** 成交量 / 成交额 / 持仓量：中文量级，别糊一长串数字 */
function big(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return fmt(n, 0)
}

/** 资金费率：0.0001 → 0.01000%（跟交易所一样留 5 位） */
const fundingText = computed(() => {
  const r = ticker.value?.fundingRate
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return '—'
  return `${fixed(Number(r) * 100, 5)}%`
})

/** 下一次结算倒计时 hh:mm:ss */
const countdown = computed(() => {
  const at = ticker.value?.nextFundingAt
  if (!at) return ''
  const left = at - nowTick.value
  if (left <= 0) return '结算中…'
  const s = Math.floor(left / 1000)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
})

const fundingLabel = computed(() => {
  const h = ticker.value?.fundingIntervalHours
  return h ? `资金费率 (${h}时)` : '资金费率'
})

/** 右侧那一串指标：两列排，跟交易所一样 */
const rows = computed(() => {
  const d = ticker.value
  return [
    {k: '标记价格', v: fmt(d?.markPrice)},
    {k: '24h最高价', v: fmt(d?.high24h)},
    {k: '指数价格', v: fmt(d?.indexPrice)},
    {k: '24h最低价', v: fmt(d?.low24h)},
    {k: '24h成交量', v: big(d?.volume24h)},
    {k: '24h成交额', v: big(d?.quoteVolume24h)},
    {k: '合约持仓量', v: big(d?.openInterestValue)}
  ]
})
</script>

<template>
  <div class="tk-head">
    <div class="tk-left">
      <slot name="symbol" />
      <!--
        以前这儿还有个「永续 / 币本位永续 / 现货」的小标签，用户 2026-10-03 说去掉：
        「永续字样去掉」——全站就是 U 本位永续，写着是废话。
        （`typeTag` 那个 computed 一起删了，别留死代码。）
      -->
      <!--
        外层可以再塞东西（窄屏把「分析 / ＋ / 配置」摆这儿）。
        ⚠️ 包一层 `.tk-actions` 才能把**一整组**顶到最右边（光给最后一颗加 auto 会把 ＋ 落在半路）。
      -->
      <span class="tk-actions"><slot name="actions" /></span>
    </div>

    <div class="tk-mid">
      <span class="tk-last" :class="tone">{{ lastText }}</span>
      <span class="tk-chg" :class="tone">{{ changeText }}</span>
    </div>

    <div class="tk-stats">
      <div v-for="r in rows" :key="r.k" class="tk-item">
        <span class="k">{{ r.k }}</span>
        <span class="v">{{ r.v }}</span>
      </div>
      <!-- 资金费率 + 倒计时摆一格，跟交易所一样 -->
      <div class="tk-item">
        <span class="k">{{ fundingLabel }}</span>
        <span class="v">
          <em class="tk-fund">{{ fundingText }}</em>
          <template v-if="countdown"> / {{ countdown }}</template>
        </span>
      </div>
    </div>
    <!--
      ⚠️ 这里**不放报错文字**（用户 2026-10-03：「合约搜索没有 前端不要提示报错文字」）。
      用户边打字边筛合约时，每敲一个字都会去拉一次行情，搜到不存在的那只必然报错——
      这时候蹦一行红字毫无用处。取不到就把各格显示成「—」，不挡页面。
    -->
  </div>
</template>
