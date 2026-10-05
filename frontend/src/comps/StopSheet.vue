<script setup lang="ts">
/**
 * 「止盈 / 止损」确认单（用户 2026-10-06）。
 *
 * 用户原话：「按住仓位线上下拖 → 松手弹确认单（止盈 / 止损 + 数量百分比），
 * 确认后才发单」。所以在 K 线上拖着那条仓位线走，松手就弹这个 ——
 * **这里才是真正发单的那一步**，拖动本身不发单。
 *
 * ★ 沿用 `ReduceSheet.vue` / `TransferSheet.vue` 那套 `.sheet` / `.tr-*` / `.ord-*` 样式。
 *
 * ⚠️ **真金白银**：`testOrder === false` 时它是真挂到币安上的条件单
 *    （`TAKE_PROFIT_MARKET` / `STOP_MARKET`，触发后走市价、只减仓）。
 * ⚠️ 数量按合约精度**向下取整**（真正取整在后端再算一遍），取整成 0 会报错。
 * ⚠️ `orderId` 有值 = **改单**（先撤旧的再挂新的）—— 测试单模式下不会撤旧单。
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
  /** 是不是测试单（true = 只校验、不真挂） */
  testOrder: boolean
  /** 价格的小数位（跟着这个币的价格量级走，跟图上一致） */
  decimals: number
  /** 有值 = 改单：正在改的是这一张 */
  orderId?: string
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', v: {kind: 'profit' | 'stop'; price: number; pct: number}): void
}>()

/** 每 25% 一个快捷档（跟减仓 / 下单那根滑轨一致） */
const PRESETS = [25, 50, 75, 100]

/** 触发价：拖出来的那个价开局，还能在这儿微调（步长 = 一个 tick） */
const price = ref(0)
/** 平掉多少（%） */
const pct = ref(100)

/*
 * 每次打开都按「拖出来的那个价 + 全平」重置：
 * 止盈 / 止损默认是**保护整条仓位**的，改成 25% 才是例外。
 */
watch(
  () => props.open,
  on => {
    if (!on) return
    price.value = props.price
    pct.value = 100
  }
)

const sideText = computed(() => (props.side === 'long' ? '多' : '空'))

/**
 * 止盈还是止损 —— **按价格在开仓价的哪一边自动判**（跟拖的方向一致）：
 * 多单：价在开仓价上面 = 止盈，下面 = 止损；空单反过来。
 */
const kind = computed<'profit' | 'stop'>(() => {
  const up = price.value >= props.entry
  const long = props.side === 'long'
  return up === long ? 'profit' : 'stop'
})

const kindText = computed(() => (kind.value === 'profit' ? '止盈' : '止损'))

const qty = computed(() => (props.amount * pct.value) / 100)

/**
 * 触发后大概赚 / 亏多少（不含手续费，所以叫「预计」）。
 * 多单平仓 = 卖：`(触发价 − 开仓均价) × 数量`；空单反过来。
 */
const pnl = computed(() => {
  const diff =
    props.side === 'long' ? price.value - props.entry : props.entry - price.value
  return diff * qty.value
})

const pnlTone = computed(() => (pnl.value >= 0 ? 'up' : 'down'))

/** 跟持仓列表同一个写法（越小的币留越多小数位） */
function qtyText(v: number): string {
  const a = Math.abs(v)
  return v.toFixed(a === 0 ? 0 : a < 0.01 ? 8 : a < 1 ? 6 : a < 1000 ? 4 : 2)
}
function money(v: number): string {
  return `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}
function fmtPrice(v: number): string {
  return v.toFixed(Math.min(12, Math.max(0, props.decimals)))
}

/** 价格输入框：`v-model.number` 交了非法值是 NaN，一律挡住（别把 NaN 发出去） */
function onPrice(v: unknown): void {
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) price.value = n
}

/** 一步一格（一个 tick）：用价格量级推个够小的步长 */
const step = computed(() => 1 / 10 ** Math.min(12, Math.max(0, props.decimals)))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet" role="dialog" aria-label="止盈止损">
      <header class="sheet-head">
        <b>{{ orderId ? '改' : '挂' }}{{ kindText }} · {{ name }} {{ sideText }}</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
      </header>

      <p class="tr-warn">
        挂一张
        <b>{{ kind === 'profit' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET' }}</b>
        （触发后走<b>市价</b>、<b>只减仓</b>）。
        <template v-if="testOrder"
          >当前是<b>测试单</b>：币安照常校验签名 / 参数 / 权限，但<b>不会真挂上去</b>。</template
        >
        <template v-else>跟下单一样是<b>真单</b>：挂上去之后交易所那边就真有效了。</template>
        <template v-if="orderId">
          这是<b>改单</b>：确认后先撤掉原来那张，再挂这个新价
          <template v-if="testOrder">（测试单模式<b>不会撤</b>旧单）。</template>
        </template>
      </p>

      <label class="ord-field">
        <span>触发价</span>
        <span class="os-price">
          <button
            type="button"
            class="ghost tiny"
            title="往下挪一格"
            @click="price = Math.max(0, price - step)"
          >
            −
          </button>
          <input
            :value="fmtPrice(price)"
            type="text"
            inputmode="decimal"
            aria-label="触发价"
            @change="onPrice(($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="ghost tiny"
            title="往上挪一格"
            @click="price = price + step"
          >
            ＋
          </button>
        </span>
      </label>

      <div class="sheet-row col">
        <div class="sheet-text">
          <b>平掉多少</b>
          <p>触发后平掉这条持仓的这么多。默认全平。</p>
        </div>
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
        开仓均价 <b>{{ fmtPrice(entry) }}</b> · 触发价 <b>{{ fmtPrice(price) }}</b>
        · 平 <b>{{ qtyText(qty) }}</b> 张
        <span class="dim">（这条持仓 {{ qtyText(amount) }} 张 · {{ pct }}%）</span>
        <br />
        预计收益
        <b class="os-pnl" :class="pnlTone">{{ money(pnl) }}</b>
        <span class="dim">（触发后按这个价成交，不含手续费）</span>
      </p>

      <button
        type="button"
        class="tr-go"
        :disabled="busy"
        :title="
          testOrder
            ? '测试单：只校验，不会真挂上去'
            : `真单：挂一张${kindText}（触发后真成交）`
        "
        @click="emit('confirm', {kind, price, pct})"
      >
        {{
          busy
            ? '提交中…'
            : testOrder
              ? `${orderId ? '测试改' : '测试挂'}${kindText} ${pct}%`
              : `${orderId ? '改' : '挂'}${kindText} ${pct}%`
        }}
      </button>
    </section>
  </Teleport>
</template>
