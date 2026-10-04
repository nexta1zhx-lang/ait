<script setup lang="ts">
/**
 * 配置（底部弹出）。
 *
 * 入口在 K 线头部「AI 分析 / ＋」那一行最右边那颗按钮上。
 * 现在只剩一条：
 *   · 行情过滤 —— 24h 成交额 ≥ N 百万 USDT 的合约才在行情列表里显示
 *     （用户 2026-10-03：「行情过滤 可以配置 24h 成交多少 m，大于这个数合约行情才显示」）。
 *
 * ⚠️ 2026-10-04 删掉了两条（用户：「k 线保持样式缩放逻辑全部删掉」）：
 *    「保持 K 线缩放样式」开关 + 「显示多少根 K 线」读数。
 *    现在图上显示多少根由**屏幕宽度**决定，用户不用管、也没得调。
 *
 * 值都在 `settings.ts`（落 localStorage），这里只负责画和改。
 */
import {computed} from 'vue'
import {marketMinVolM} from '../settings'

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

      <p class="sheet-foot">改完立刻生效，自动记在这台设备上。</p>
    </section>
  </Teleport>
</template>
