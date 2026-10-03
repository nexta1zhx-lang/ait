<script setup lang="ts">
/**
 * 配置（底部弹出）。
 *
 * 入口在 K 线头部「AI 分析 / ＋」那一行最右边那颗按钮上。
 * 现在三条：
 *   · 保持 K 线缩放样式（开关，默认**打开**）
 *   · 显示多少根 K 线 —— **不是给用户选的档位**，只是把「现在显示多少根」报出来。
 *     这个根数是**全局一份、所有币种共用**的（用户 2026-10-03：
 *     「保持 k 线缩放的根数是所有币种都要」）。
 *   · 行情过滤 —— 24h 成交额 ≥ N 百万 USDT 的合约才在行情列表里显示
 *     （用户 2026-10-03：「行情过滤 可以配置 24h 成交多少 m，大于这个数合约行情才显示」）。
 *
 * 值都在 `settings.ts`（落 localStorage），这里只负责画和改。
 */
import {computed} from 'vue'
import {keepChartZoom, marketMinVolM, shownBars, shownKey} from '../settings'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{(e: 'close'): void}>()

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

      <!-- ① 保持 K 线缩放样式 -->
      <div class="sheet-row">
        <div class="sheet-text">
          <b>保持 K 线缩放样式</b>
          <p>
            打开后，图上显示多少根<b>所有币种共用</b>：在哪个币上缩到多少根，
            换币 / 换周期 / 切页回来都还是这个根数（右边缘始终贴齐最新一根）。
            关掉就是每次都自动适配最新行情。
          </p>
        </div>
        <button
          type="button"
          class="switch"
          :class="{on: keepChartZoom}"
          :aria-pressed="keepChartZoom"
          @click="keepChartZoom = !keepChartZoom"
        >
          <span />
        </button>
      </div>

      <!-- ② 显示多少根 K 线：只读（跟着你的缩放走，切走时自动存） -->
      <div class="sheet-row col">
        <div class="sheet-text">
          <b>显示多少根 K 线</b>
          <p>
            <template v-if="shownBars">
              现在 <em>{{ shownKey }}</em> 图上显示 <em>{{ shownBars }}</em>
              根 —— 这是你缩放 / 拖出来的，不在这儿选；
              这个根数<b>所有币种共用</b>，切走或换币时自动记住。
            </template>
            <template v-else
              >打开 K 线图后，这里会显示当前看了多少根。</template
            >
          </p>
        </div>
      </div>

      <!-- ③ 行情过滤：24h 成交额低于这个数的合约不显示 -->
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

      <p class="sheet-foot">改完立刻生效，自动记在这台设备上。</p>
    </section>
  </Teleport>
</template>
