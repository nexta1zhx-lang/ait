<script setup lang="ts">
/**
 * 止盈 / 止损确认弹层 —— 拖动仓位线 / 挂单线松手后弹的这一张
 * （用户 2026-10-06：「按住仓位线上下拖 → 松手弹确认单（止盈 / 止损 + 数量百分比），
 * 确认后才发单」，随后又定：**标题写成止盈 / 止损**、上下两行铺开、
 * **去掉百分比快选**、一个弹层、底部滑轨、去掉价格的加减号、
 * **不要括号和小字解释**、移动端默认 80%、PC 限最大宽度）。
 *
 * ★ 沿用 `TransferSheet.vue` 那套 `.sheet` / `.tr-*` / `.ord-*` 样式。
 *
 * ⚠️ **真金白银**：`testOrder === false` 时它会真挂到币安上（`TAKE_PROFIT_MARKET` /
 *    `STOP_MARKET`，触发后市价、只减仓）。数量按合约精度向下取整（后端再算一遍）。
 * ⚠️ `orderId` 有值 = **改单**（先撤旧的再挂新的）；测试单模式下不会撤旧单。
 */
import {computed, ref, watch} from 'vue'

const props = defineProps<{
  open: boolean
  /** 币种简写，如 1000BONK */
  name: string
  /** 被平的那条仓位方向 */
  side: 'long' | 'short'
  /** 触发价（拖出来的那个价） */
  price: number
  /** 开仓均价（算「预计收益」用） */
  entry: number
  /** 这条持仓的数量（张） */
  amount: number
  /** 这次拖动**默认**平掉多少（有挂单时是「剩下的」；改单时是它原来那个数） */
  pct: number
  /** 是不是测试单（true = 只校验、不真挂） */
  testOrder: boolean
  /** 有值 = 改单：正在改的是这一张 */
  orderId?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', v: {kind: 'profit' | 'stop'; price: number; pct: number}): void
}>()

/** 滑轨上画几道刻度（25% 一档）；**不再**做百分比快捷按钮（用户 2026-10-06：「快选取消」） */
const TICKS = [25, 50, 75, 100]

const price = ref(0)
const pct = ref(100)

/* 每次打开都按「拖出来的价 + 默认比例」重置（默认比例见 `defaultPct()`） */
watch(
  () => props.open,
  on => {
    if (!on) return
    price.value = props.price
    pct.value = Math.max(1, Math.min(100, Math.round(props.pct)))
  }
)

const sideText = computed(() => (props.side === 'long' ? '多' : '空'))

/* 止盈还是止损：按价格在开仓价的哪一边自动判（跟拖的方向一致） */
const kind = computed<'profit' | 'stop'>(() =>
  (price.value >= props.entry) === (props.side === 'long') ? 'profit' : 'stop'
)
const kindText = computed(() => (kind.value === 'profit' ? '止盈' : '止损'))

const qty = computed(() => (props.amount * pct.value) / 100)

/** 触发后大概赚 / 亏多少（不含手续费，所以叫「预计」） */
const pnl = computed(
  () =>
    (props.side === 'long' ? price.value - props.entry : props.entry - price.value) *
    qty.value
)

const pnlText = computed(
  () =>
    `${pnl.value >= 0 ? '+' : '−'}$` +
    Math.abs(pnl.value).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
)

/** 价格的小数位：跟图上轴一个量级口径 */
function fmtPrice(v: number): string {
  const a = Math.abs(v)
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8
  return v.toFixed(d)
}

function onPrice(v: unknown): void {
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) price.value = n
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section
      v-if="open"
      class="sheet sheet-confirm"
      role="dialog"
      :aria-label="kindText"
    >
      <header class="sheet-head">
        <!-- 标题就是这一单的性质（用户 2026-10-06：「标题为止盈/止损 都要有」） -->
        <b>{{ kindText }}</b>
        <button type="button" class="sheet-x" title="关闭" @click="emit('close')">
          ✕
        </button>
      </header>

      <!-- 上下两行：上 = 触发价，下 = 平仓比例（快选已去掉，只留滑轨） -->
      <div class="cf-rows">
        <label class="cf-row">
          <span class="cf-lb">触发价</span>
          <input
            class="cf-input"
            :value="fmtPrice(price)"
            type="text"
            inputmode="decimal"
            aria-label="触发价"
            @change="onPrice(($event.target as HTMLInputElement).value)"
          />
        </label>

        <div class="cf-row cf-row-bar">
          <span class="cf-lb">平仓比例<b>{{ pct }}%</b></span>
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
              <i v-for="n in TICKS" :key="n" :style="{left: n + '%'}" />
            </span>
          </span>
        </div>
      </div>

      <!-- 读数：三格，不带任何解释文字 -->
      <div class="cf-stats">
        <span><em>方向</em><b>{{ name }} {{ sideText }}</b></span>
        <span><em>平仓数量</em><b>{{ qty.toFixed(qty < 1 ? 6 : 2) }}</b></span>
        <span>
          <em>预计收益</em>
          <b :class="pnl >= 0 ? 'pnl-up' : 'pnl-down'">{{ pnlText }}</b>
        </span>
      </div>

      <button
        type="button"
        class="tr-go"
        :disabled="busy"
        :title="testOrder ? '测试单：只校验，不会真挂上去' : `真单：触发后按市价平掉 ${pct}%`"
        @click="emit('confirm', {kind, price, pct})"
      >
        {{ busy ? '提交中…' : `${testOrder ? '测试' : ''}${orderId ? '改' : '挂'}${kindText}` }}
      </button>
    </section>
  </Teleport>
</template>
