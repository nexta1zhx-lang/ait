<script setup lang="ts">
/**
 * 配置（底部弹出）。
 *
 * 入口在 K 线头部「AI 分析 / ＋」那一行最右边那颗按钮上。四条：
 *   · 行情过滤 —— 24h 成交额 ≥ N 百万 USDT 的合约才在行情列表里显示
 *     （用户 2026-10-03：「行情过滤 可以配置 24h 成交多少 m，大于这个数合约行情才显示」）。
 *   · 下单账户 —— K 线页底部下单模块用哪套交易所 Key（用户 2026-10-05）。
 *   · 测试下单 —— **开关**（用户 2026-10-05「测试单在配置中开启」）：
 *     以前「测试单」是写死在开单页上的一句标签，现在挪到这儿，开单页不再提。
 *   · 订单设置（2026-10-06）—— 仓位 / 订单历史 / 仓位委托 / 强平价格
 *     这四样画不画在 K 线上（见 `trade-overlay.ts`、`KlineChart` 的叠加层）。
 *
 * ⚠️ 2026-10-04 删掉了两条（用户：「k 线保持样式缩放逻辑全部删掉」）：
 *    「保持 K 线缩放样式」开关 + 「显示多少根 K 线」读数。
 *    现在图上显示多少根由**屏幕宽度**决定，用户不用管、也没得调。
 *
 * 值都在 `settings.ts`（落 localStorage），这里只负责画和改。
 */
import {computed, watch} from 'vue'
import {
  chartShowHistory,
  chartShowLiq,
  chartShowOrders,
  chartShowPosition,
  marketMinVolM,
  testOrder
} from '../settings'
import {
  loadTradeKeys,
  pickTradeKey,
  tradeKey,
  tradeKeys,
  tradeKeysErr
} from '../trade-account'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{(e: 'close'): void}>()

/* 打开时拉一次 Key 列表（30 秒内不重复拉） */
watch(
  () => props.open,
  on => {
    if (on) void loadTradeKeys()
  },
  {immediate: true}
)

/**
 * 行情过滤的输入框。
 * `v-model.number` 交了空串 / 非法值时是 `NaN` —— 一律当 0（不过滤），
 * 不然后面 `NaN * 1e6` 会把整张表滤没。
 */
const minVolM = computed({
  get: () => marketMinVolM.value,
  set: (v: unknown) => {
    marketMinVolM.value = Math.max(0, Math.round(Number(v) || 0))
  }
})

/** 常用档位（手机上点一下就行，不用弹键盘） */
const PRESETS = [0, 1, 5, 10, 50]

/**
 * 切「测试下单」。
 * ⚠️ **关掉的时候必须确认** —— 开关的另一侧是真钱（真开仓 / 真平仓）；
 *    开回来（回到只校验）是往安全那侧走，不用问。
 */
function toggleTest(): void {
  if (!testOrder.value) {
    testOrder.value = true
    return
  }
  const ok = window.confirm(
    '关掉「测试下单」之后，下单和平仓都会发到币安的真实接口：\n\n' +
      '· 会真开仓、真扣保证金\n' +
      '· 平仓会真的把持仓平掉\n\n确定要关掉吗？'
  )
  if (ok) testOrder.value = false
}

/**
 * 「订单设置」那四个开关（用户 2026-10-06）。
 *
 * 走函数而不是模板里直接 `x = !x`：这几个是**从 `settings.ts` import 进来的 ref**，
 * 模板里给它赋值能不能正确落到 `.value` 上不够直观 —— 一律在这儿写清楚。
 */
function toggleChart(kind: 'position' | 'history' | 'orders' | 'liq'): void {
  if (kind === 'position') chartShowPosition.value = !chartShowPosition.value
  else if (kind === 'history') chartShowHistory.value = !chartShowHistory.value
  else if (kind === 'orders') chartShowOrders.value = !chartShowOrders.value
  else chartShowLiq.value = !chartShowLiq.value
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet" role="dialog" aria-label="配置">
      <header class="sheet-head">
        <b>配置</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">
          ✕
        </button>
      </header>

      <!-- 行情过滤：24h 成交额低于这个数的合约不显示 -->
      <div class="sheet-row col">
        <div class="sheet-text">
          <b>行情过滤</b>
          <p>
            24h 成交额低于这个数的合约，<b>合约行情</b>列表里就不显示（单位：
            <em>百万 USDT</em>）。填 <em>0</em> = 全部显示。
          </p>
        </div>
        <div class="mvol">
          <input
            v-model.number="minVolM"
            type="number"
            min="0"
            step="1"
            inputmode="decimal"
            aria-label="24h 成交额下限（百万 USDT）"
          />
          <span>M</span>
          <div class="mvol-presets">
            <button
              v-for="p in PRESETS"
              :key="p"
              type="button"
              class="ghost tiny"
              :class="{on: marketMinVolM === p}"
              @click="minVolM = p"
            >
              {{ p === 0 ? '不限' : p + 'M' }}
            </button>
          </div>
        </div>
      </div>

      <!--
        下单账户（用户 2026-10-05：「配置中可切换用户」）——
        K 线页底部那个下单模块用哪套交易所 Key，在这儿切。
      -->
      <div class="sheet-row col">
        <div class="sheet-text">
          <b>下单账户</b>
          <p>
            K 线页底部的<b>下单模块</b>用这一套 Key（余额 / 杠杆 / 持仓都看它）。
            要改 Key 本身去「我的 → 个人信息 → 交易所」。
          </p>
        </div>
        <div class="tk-picks">
          <button
            v-for="k in tradeKeys"
            :key="k.id"
            type="button"
            class="ghost tiny"
            :class="{on: tradeKey?.id === k.id}"
            :title="`${k.name} · ${k.marketType === 'swap' ? '合约' : '现货'}`"
            @click="pickTradeKey(k.id)"
          >
            {{ k.name }}
          </button>
          <span v-if="!tradeKeys.length" class="dim tiny">{{
            tradeKeysErr || '还没配置交易所 Key'
          }}</span>
        </div>
      </div>

      <!--
        测试下单（用户 2026-10-05：「测试单在配置中开启」）——
        以前「测试单」是写死在开单页上的一句标签，现在是这儿的一个开关。
      -->
      <div class="sheet-row">
        <div class="sheet-text">
          <b>测试下单</b>
          <p v-if="testOrder">
            开着：只发到币安<b>测试接口</b>，校验参数 / 权限 / 保证金，
            <b>不进撮合、不真开仓、不真平仓</b>。
          </p>
          <p v-else>
            ⚠️ 已关闭：下单 / 平仓都是<b>真单</b>，会真扣保证金、真的平掉持仓。
          </p>
        </div>
        <!--
          ⚠️ 打开/关掉都让用户二次确认 —— 这个开关的另一侧是真钱，
            误触一下就从「只校验」变成「真开仓」。
        -->
        <button
          type="button"
          class="switch"
          :class="{on: testOrder}"
          role="switch"
          :aria-checked="testOrder"
          :aria-label="testOrder ? '测试下单已开启' : '测试下单已关闭'"
          title="点一下切换（会先确认）"
          @click="toggleTest"
        >
          <span />
        </button>
      </div>

      <!--
        订单设置（用户 2026-10-06）——
        「配置界面可以配置订单设置，1.仓位 2.订单历史 3.仓位委托 4.强平价格」
        「是控制和 k 线联动的价格或历史是否显示在 k 线上」。
        四样各自一个开关，控制**画不画在 K 线上**；关掉的项**连数据都不再去拉**。
      -->
      <div class="sheet-row col">
        <div class="sheet-text">
          <b>订单设置</b>
          <p>
            这四样要不要<b>画在 K 线上</b>（跟上面「下单账户」那套 Key 联动）。
            关掉的不显示、也不会再去交易所取这份数据。
          </p>
        </div>
        <div class="oset">
          <div class="oset-row">
            <span class="oset-dot" data-kind="pos" />
            <b>仓位</b>
            <em>持仓的<b>开仓均价</b>画一条线（多空各一条）</em>
            <button
              type="button"
              class="switch"
              :class="{on: chartShowPosition}"
              role="switch"
              :aria-checked="chartShowPosition"
              aria-label="仓位"
              title="点一下切换"
              @click="toggleChart('position')"
            >
              <span />
            </button>
          </div>
          <div class="oset-row">
            <span class="oset-dot" data-kind="his" />
            <b>订单历史</b>
            <em>历史成交标成图上的<b>买卖点</b></em>
            <button
              type="button"
              class="switch"
              :class="{on: chartShowHistory}"
              role="switch"
              :aria-checked="chartShowHistory"
              aria-label="订单历史"
              title="点一下切换"
              @click="toggleChart('history')"
            >
              <span />
            </button>
          </div>
          <div class="oset-row">
            <span class="oset-dot" data-kind="ord" />
            <b>仓位委托</b>
            <em>当前<b>挂单</b>每张画一条线</em>
            <button
              type="button"
              class="switch"
              :class="{on: chartShowOrders}"
              role="switch"
              :aria-checked="chartShowOrders"
              aria-label="仓位委托"
              title="点一下切换"
              @click="toggleChart('orders')"
            >
              <span />
            </button>
          </div>
          <div class="oset-row">
            <span class="oset-dot" data-kind="liq" />
            <b>强平价格</b>
            <em>强平价画一条线</em>
            <button
              type="button"
              class="switch"
              :class="{on: chartShowLiq}"
              role="switch"
              :aria-checked="chartShowLiq"
              aria-label="强平价格"
              title="点一下切换"
              @click="toggleChart('liq')"
            >
              <span />
            </button>
          </div>
        </div>
      </div>

      <p class="sheet-foot">改完立刻生效，自动记在这台设备上。</p>
    </section>
  </Teleport>
</template>
