<script setup lang="ts">
/**
 * 「修改挂单」弹层（用户 2026-10-06：「挂单可以修改」）。
 *
 * 「挂单」那个 tab 现在每一行都点得动 —— 点开就是这个。以前只能跑去币安 App 改。
 *
 * ★ **改的东西跟着订单类型走**（分流在后端 `modifyTradeOrder`，这里只负责收数）：
 *   · 限价单 → 改**委托价**（交易所的改单接口，单号不变、不用撤单）
 *   · 止盈 / 止损（条件单）→ 改**触发价**（撤旧挂新：币安条件单**没有**改单接口，
 *     它自己 App 里的「修改」也是这么干的）
 *   所以输入框的标签 / 占位符 / 校验全都看 `isStop`，别写死成「价格」两个字。
 *
 * ⚠️ **改单和撤单都没有测试版**（币安这几个接口不给 test）—— 点下去就是真动作。
 *    所以：① 没改动时「保存」是灰的（免得手滑把同一张单撤了重挂一遍）；
 *    ② 撤单要**二次确认**（第一次点只是把按钮变成「再点一下撤单」）。
 * ⚠️ 触发价正好压在标记价上，币安一定回 `-2021 立即触发` ⇒ 在这儿就拦住，
 *    别让人提交完再看一句看不懂的英文报错（跟 `TpSlSheet` 一个口径）。
 * ⚠️ 这里**不写「真单 / 测试单」那段说明**（用户当天从止盈止损弹层里删过：
 *    「提示去掉，现在都是真的」）。要提醒就写在按钮上，别再加一整段。
 */
import {computed, ref, watch} from 'vue'
import {orderKind, typeText, type OrderEditTarget} from '../tpsl'

const props = defineProps<{
  open: boolean
  /** 正在提交（改单 / 撤单） */
  busy?: boolean
  target: OrderEditTarget | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', v: {price: number; amount: number}): void
  (e: 'cancel'): void
}>()

/** 条件单（止盈 / 止损）—— 它没有委托价，改的是触发价 */
const isStop = computed(() =>
  orderKind({type: props.target?.type ?? ''}) !== 'plain'
)

const price = ref(0)
const amount = ref(0)
/** 打开时那两个原值：判「有没有改过」（没改过就别让人点保存） */
const was = ref({price: 0, amount: 0})
/** 撤单的二次确认（第一次点只是翻脸成「再点一下」） */
const sureCancel = ref(false)

watch(
  () => [props.open, props.target] as const,
  () => {
    const t = props.target
    if (!props.open || !t) return
    price.value = isStop.value ? t.stopPrice : t.price
    amount.value = t.amount
    was.value = {price: price.value, amount: amount.value}
    sureCancel.value = false
  },
  {immediate: true}
)

const held = computed(() => props.target?.held ?? 0)
const name = computed(() => props.target?.name ?? '')
const sideText = computed(() => (props.target?.side === 'buy' ? '买' : '卖'))
const mark0 = computed(() => props.target?.mark ?? 0)

/**
 * 平仓比例（%）：**只有对得上持仓时才有意义**（张数 ÷ 持仓张数）。
 * 拿它当滑轨的读数，改滑轨 = 改数量 —— 部分平仓那种「就平一半」比填小数快得多。
 */
const pct = computed({
  get: () =>
    held.value > 0 ? Math.round((amount.value / held.value) * 100) : 0,
  set: (v: number) => {
    const n = Math.max(1, Math.min(100, Math.round(Number(v) || 0)))
    amount.value = Number(((held.value * n) / 100).toFixed(8))
  }
})

/** 拦下来的原因（空 = 可以提交） */
const bad = computed(() => {
  if (!(price.value > 0)) return isStop.value ? '触发价要先填好' : '委托价要先填好'
  if (!(amount.value > 0)) return '数量要先填好'
  if (isStop.value && mark0.value > 0 && Math.abs(price.value - mark0.value) < 1e-12)
    return `触发价正好是标记价 ${fmtPrice(mark0.value)}，币安会判「立即触发」，挪一点`
  return ''
})

/** 浮点数别用 `!==` 比（滑轨算出来的 3303 可能是 3303.00000001） */
const same = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-9)
const changed = computed(
  () =>
    !same(price.value, was.value.price) || !same(amount.value, was.value.amount)
)

const blocked = computed(() => !!props.busy || !!bad.value || !changed.value)

function onSave(): void {
  if (blocked.value) return
  emit('save', {price: price.value, amount: amount.value})
}

function onCancel(): void {
  if (props.busy) return
  if (!sureCancel.value) {
    sureCancel.value = true
    return
  }
  emit('cancel')
}

function onNum(v: unknown, set: (n: number) => void): void {
  const n = Number(v)
  set(Number.isFinite(n) && n > 0 ? n : 0)
}

/** 价格的小数位：跟图上轴一个量级口径（跟止盈止损弹层一致） */
function fmtPrice(v: number): string {
  const a = Math.abs(v)
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8
  return v.toFixed(d)
}

/** 数量（基础币）：越小的币留越多小数位，跟持仓列表一个写法 */
function fmtQty(v: number): string {
  const a = Math.abs(v)
  return v.toFixed(a === 0 ? 0 : a < 0.01 ? 8 : a < 1 ? 6 : a < 1000 ? 4 : 2)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section
      v-if="open && target"
      class="sheet sheet-confirm os-sheet warm-skin"
      role="dialog"
      aria-label="修改挂单"
    >
      <header class="sheet-head">
        <b>修改挂单 · {{ name }}</b>
        <button type="button" class="sheet-x" title="关闭" @click="emit('close')">
          ✕
        </button>
      </header>

      <!-- 这张单现在的样子（改之前先确认改的是哪一张） -->
      <div class="os-sum">
        <span class="side" :class="target.side === 'buy' ? 'buy' : 'sell'">
          {{ sideText }}
        </span>
        <span
          class="os-ty"
          :class="
            orderKind({type: target.type}) === 'profit'
              ? 'profit'
              : orderKind({type: target.type}) === 'stop'
                ? 'stop'
                : 'plain'
          "
        >
          {{ typeText(target.type) }}
        </span>
        <span class="dim tiny">
          原{{ isStop ? '触发价' : '委托价' }}
          {{ fmtPrice(isStop ? target.stopPrice : target.price) }}
        </span>
      </div>

      <div class="cf-row">
        <span class="cf-lb">
          {{ isStop ? '触发价' : '委托价' }}
          <b v-if="mark0 > 0">现价 {{ fmtPrice(mark0) }}</b>
        </span>
        <input
          class="cf-input"
          :value="price > 0 ? fmtPrice(price) : ''"
          type="text"
          inputmode="decimal"
          :placeholder="mark0 > 0 ? `现价 ${fmtPrice(mark0)}` : '价格'"
          :aria-label="isStop ? '触发价' : '委托价'"
          @change="onNum(($event.target as HTMLInputElement).value, n => (price = n))"
        />
      </div>

      <!-- 平仓比例：只在这张单对得上持仓时才有意义（开仓单没有「平多少」这回事） -->
      <div v-if="held > 0" class="cf-row-bar os-bar">
        <span class="cf-lb">平仓比例<b>{{ pct }}%</b></span>
        <span class="ord-bar">
          <input
            v-model.number="pct"
            type="range"
            min="1"
            max="100"
            step="1"
            :style="{'--fill': pct + '%'}"
            :title="`平掉持仓的 ${pct}%`"
          />
        </span>
        <span class="os-qty">持仓 {{ fmtQty(held) }}</span>
      </div>

      <div class="cf-row">
        <span class="cf-lb">数量<b v-if="held > 0">约 {{ pct }}% 的仓位</b></span>
        <input
          class="cf-input"
          :value="amount > 0 ? fmtQty(amount) : ''"
          type="text"
          inputmode="decimal"
          placeholder="数量"
          aria-label="数量"
          @change="onNum(($event.target as HTMLInputElement).value, n => (amount = n))"
        />
      </div>

      <!-- 拦住的原因 / 没改动的说明 —— 别让人对着灰按钮猜 -->
      <p v-if="bad" class="os-bad">{{ bad }}</p>
      <p v-else-if="!changed" class="os-hint">价格 / 数量都没改</p>

      <div class="os-act">
        <button
          type="button"
          class="os-cancel"
          :class="{sure: sureCancel}"
          :disabled="busy"
          :title="sureCancel ? '再点一下就真撤了' : '撤掉这张单（要再点一下确认）'"
          @click="onCancel"
        >
          {{ sureCancel ? '再点一下撤单' : '撤单' }}
        </button>
        <button
          type="button"
          class="tr-go os-go"
          :disabled="blocked"
          :title="bad ? bad : changed ? '按新价 / 新数量改这张单（真动作）' : '没有要改的'"
          @click="onSave"
        >
          <template v-if="busy">提交中…</template>
          <template v-else-if="!changed">保存修改</template>
          <template v-else>保存修改</template>
        </button>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
/* 摘要那一行：买/卖 + 中文类型 + 原价 */
.os-sum {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0 10px;
  flex-wrap: wrap;
}
.os-ty {
  font-size: 12.5px;
}
.os-ty.profit {
  color: var(--ok, #5eba89);
}
.os-ty.stop {
  color: var(--bad, #e55361);
}
.os-ty.plain {
  color: var(--muted);
}
/* 输入框那一行（复用全局 `.cf-lb` / `.cf-input` 的观感，只补间距） */
.os-sheet .cf-row {
  margin-top: 2px;
}
.os-bar {
  margin-top: 10px;
}
.os-qty {
  font-size: 11px;
  color: var(--dim, #999);
  white-space: nowrap;
}
.os-bad {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--warn, #f0b429);
}
.os-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
/* 底下两颗：左边撤单、右边保存（主按钮复用全局 `.tr-go`），**要一样高** */
.os-act {
  display: flex;
  align-items: stretch;
  gap: 8px;
  margin-top: 10px;
}
.os-cancel {
  flex: 0 0 auto;
  padding: 0 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  /* 平时低调（跟全局 `button.danger` 一个调子）：撤单是危险动作，但没必要一直红着 */
  background: var(--panel-2);
  color: var(--muted);
  font-size: 13px;
  font-weight: var(--fw-mid, 500);
  cursor: pointer;
}
/* 第一次点过之后 = 真撤，这时候才红起来 */
.os-cancel.sure {
  border-color: var(--bad, #e55361);
  background: var(--bad-soft, rgba(227, 85, 97, 0.14));
  color: var(--bad, #e55361);
}
.os-cancel:disabled {
  opacity: 0.45;
  cursor: default;
}
.os-go {
  flex: 1 1 auto;
  /* ⚠️ `.tr-go` 自带 `margin-top: 10px` —— 并排布局里会把右边那颗顶下去，必须清掉 */
  margin-top: 0;
}
</style>
