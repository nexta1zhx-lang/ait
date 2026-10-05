<script setup lang="ts">
/**
 * 「减仓」弹层 —— 选百分比，只平掉这个仓位的一部分
 * （用户 2026-10-05：「加个按钮减仓 弹窗选择百分比」）。
 *
 * 下单模块的「仓位」tab 和「交易所账户 → 持仓」两处都用它。
 *
 * ★ 沿用 `TransferSheet.vue` 那套 `.sheet` / `.tr-*` 样式，不另起一套 CSS。
 *
 * ⚠️ **真金白银**：跟「平仓」一样是市价 `reduceOnly`，`testOrder === false` 时真成交。
 * ⚠️ 这里只是「想平掉百分之几」，真正下多少由后端按合约精度**向下取整**
 *    （取整后是 0 会报错，不会偷偷放大到最小一张）。
 */
import {computed, ref, watch} from 'vue'

const props = defineProps<{
  open: boolean
  /** 币种简写，如 1000LUNC */
  name: string
  side: 'long' | 'short'
  /** 持仓数量（张） */
  amount: number
  /** 仓位价值（USDT） */
  notional: number
  /** 是不是测试单（true = 只校验、不真平） */
  testOrder: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', pct: number): void
}>()

/** 每 25% 一个快捷档（跟下单那根滑轨的节点一致） */
const PRESETS = [25, 50, 75, 100]
const pct = ref(25)

/* 每次打开都回到 25%：上次若选过 100%，下次打开默认全平，太容易误点 */
watch(
  () => props.open,
  on => {
    if (on) pct.value = 25
  }
)

const sideText = computed(() => (props.side === 'long' ? '多' : '空'))
const estNotional = computed(() => (props.notional * pct.value) / 100)
const estAmount = computed(() => (props.amount * pct.value) / 100)

/** 跟持仓列表同一个写法（越小的币留越多小数位） */
function qtyText(v: number): string {
  const a = Math.abs(v)
  return v.toFixed(a === 0 ? 0 : a < 0.01 ? 8 : a < 1 ? 6 : a < 1000 ? 4 : 2)
}
function money(v: number): string {
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet" role="dialog" aria-label="减仓">
      <header class="sheet-head">
        <b>减仓 · {{ name }} {{ sideText }}</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
      </header>

      <p class="tr-warn">
        ⚠️ 减仓是<b>市价 reduceOnly</b>。
        <template v-if="testOrder"
          >当前是<b>测试单</b>：币安照常校验签名 / 参数 / 权限，但<b>不进撮合、不会真平</b>。</template
        >
        <template v-else>跟平仓一样<b>真成交</b>（只平一部分）。</template>
        实际数量按合约精度<b>向下取整</b>，取整后是 0 会报错、不会多平。
      </p>

      <div class="sheet-row col">
        <div class="sheet-text"><b>平掉多少</b></div>
        <div class="tk-picks">
          <button
            v-for="p in PRESETS"
            :key="p"
            type="button"
            class="ghost tiny"
            :class="{on: pct === p}"
            @click="pct = p"
          >
            {{ p }}%
          </button>
        </div>
      </div>

      <label class="ord-field ord-slider">
        <span>{{ pct }}%</span>
        <span class="ord-bar">
          <input
            v-model.number="pct"
            type="range"
            min="1"
            max="100"
            step="1"
            :style="{'--fill': pct + '%'}"
            :title="`平掉 ${pct}%`"
          />
          <span class="ord-ticks" aria-hidden="true">
            <i v-for="n in PRESETS" :key="n" :style="{left: n + '%'}" />
          </span>
        </span>
      </label>

      <p class="tr-avail">
        约平 <b>{{ qtyText(estAmount) }}</b> 张 · 价值
        <b>{{ money(estNotional) }}</b>
        <span class="dim"
          >（这个仓位 {{ qtyText(amount) }} 张 ·
          {{ money(notional) }}）</span
        >
      </p>

      <button
        type="button"
        class="tr-go"
        :disabled="busy"
        :title="testOrder ? '测试减仓（只校验、不真平）' : '减仓（真单）'"
        @click="emit('confirm', pct)"
      >
        {{ busy ? '提交中…' : testOrder ? `测试减仓 ${pct}%` : `减仓 ${pct}%` }}
      </button>
    </section>
  </Teleport>
</template>
