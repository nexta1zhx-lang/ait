<template>
  <!--
    「MM 保证金率」（2026-10-06，用户：「再配置旁加个显示 mm 合约保证金率」
    →「样式改一下根据风险来变色」）。

    挂在**开单模块「价格」那一行的最右侧**（2026-10-07 用户：「mm放在 下面最右侧和
    价格那一排」；之前是挂 K 线头部那颗齿轮左边的）。账户级风险刻度：
    维持保证金 ÷ 保证金余额，**到 100% 就是强平**（跟币安界面上每行仓位那个数同口径，
    这里是整套账户合起来那一份）。
    ⚠️ 它跟着 `tradeKey`（下单账户）走 ⇒ 摆在「账户标签 / 可用余额」旁边是一个账户的三个数，
       别挪回图表头部 —— 那里看不出是哪套账户的风险。

    ⚠️ 没有数据（没有仓位 / 还没连上流）就**什么都不渲染**，不摆假的 0%。
  -->
  <span
    v-if="text"
    class="mm"
    :class="level.cls"
    :title="tip"
    aria-label="MM 合约保证金率"
  >
    <em>MM</em>{{ text }}
  </span>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import {fixed} from '../format'
import {accountRiskOf, bindPositions} from '../positions'
import {tradeKey} from '../trade-account'

/**
 * ⚠️ 绑定要**跟着 `tradeKey` 走**，不能在 `onMounted` 里只绑一次：
 *    Key 列表是异步来的，挂载那一刻 `tradeKey` 还是 `null` ——
 *    只绑一次就等于拿 `undefined` 去绑，之后永远没有数据（标签一直不出现）。
 *    共享 store 是引用计数的，跟下单模块绑同一套时只会开一条 SSE。
 */
/** 用来催一次重算（store 是全局单例，切账户时让它重新读） */
const tick = ref(0)

let unbind: (() => void) | null = null
watch(
  () => tradeKey.value?.id,
  id => {
    unbind?.()
    unbind = typeof id === 'number' && id > 0 ? bindPositions([id]) : null
    /* store 是全局单例，切账户时催一次重算 */
    tick.value++
  },
  {immediate: true}
)
onBeforeUnmount(() => {
  unbind?.()
  unbind = null
})

const risk = computed(() => {
  void tick.value
  return accountRiskOf(tradeKey.value?.id)
})

const text = computed(() => {
  const r = risk.value?.ratio ?? null
  return r === null || !Number.isFinite(r) ? '' : `${fixed(r, 2)}%`
})

/**
 * **按风险变色**（用户：「样式改一下根据风险来变色」）。
 *
 *   · < 30%  正常 —— 绿
 *   · 30~60% 注意 —— 黄
 *   · 60~85% 偏高 —— 橙（开始要紧盯）
 *   · ≥ 85%  危险 —— 红 + 轻微呼吸（离强平只剩一点）
 */
const LEVELS = [
  {min: 85, cls: 'lv4', label: '危险'},
  {min: 60, cls: 'lv3', label: '偏高'},
  {min: 30, cls: 'lv2', label: '注意'},
  {min: -Infinity, cls: 'lv1', label: '正常'}
] as const

const level = computed(() => {
  const v = risk.value?.ratio ?? 0
  return LEVELS.find(l => v >= l.min) ?? LEVELS[LEVELS.length - 1]!
})

const tip = computed(() => {
  const r = risk.value
  if (!r || r.ratio === null) return ''
  return (
    `MM 合约保证金率（${level.value.label}）= 维持保证金 ÷ 保证金余额\n` +
    `维持保证金 ${fixed(r.maintMargin, 4)} ÷ 保证金余额 ${fixed(r.margin, 4)}` +
    ` = ${fixed(r.ratio, 2)}%\n` +
    '到 100% 就是强平。随标记价实时重算，不用等刷新。'
  )
})
</script>

<style scoped>
/*
 * 跟旁边那颗齿轮排一行。窄屏也留着 —— 这是**风险**刻度，比齿轮更该看见。
 * ⚠️ 只有一枚「胶囊 + 数字」，**底下不加进度条**（用户 2026-10-06：「下面不用加进度条」）。
 */
.mm {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 7px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  /* 兜底色（理论上进不来：没数据就不渲染） */
  color: var(--muted, #8b93a1);
  background: color-mix(in srgb, currentcolor 10%, transparent);
}
.mm em {
  font-style: normal;
  font-size: 10px;
  opacity: 0.75;
  letter-spacing: 0.3px;
}
/* ① 正常（< 30%） */
.mm.lv1 {
  color: var(--ok, #5eba89);
  background: var(--ok-soft, rgba(94, 186, 137, 0.14));
}
/* ② 注意（30~60%） */
.mm.lv2 {
  color: var(--warn, #f0b429);
  background: var(--warn-soft, rgba(240, 180, 41, 0.14));
}
/* ③ 偏高（60~85%）：橙 —— 黄红之间，一眼能跟「注意」分开 */
.mm.lv3 {
  color: color-mix(in srgb, var(--bad, #e35561) 55%, var(--warn, #f0b429));
  background: color-mix(in srgb, currentcolor 16%, transparent);
}
/* ④ 危险（≥ 85%）：红 + 呼吸（离强平只剩一点） */
.mm.lv4 {
  color: var(--bad, #e35561);
  background: var(--bad-soft, rgba(227, 85, 97, 0.14));
  animation: mm-breathe 1.6s ease-in-out infinite;
}
@keyframes mm-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.62;
  }
}
@media (prefers-reduced-motion: reduce) {
  .mm.lv4 {
    animation: none;
  }
}
</style>
