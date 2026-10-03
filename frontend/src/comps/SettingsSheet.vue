<script setup lang="ts">
/**
 * 配置（底部弹出）。
 *
 * 入口在 K 线头部「AI 分析 / ＋」那一行最右边那颗按钮上。
 * 现在只有一条开关 + 一条只读信息：
 *   · 保持 K 线缩放样式（开关，默认**打开**）
 *   · 显示多少根 K 线 —— **不是给用户选的档位**，只是把「现在显示多少根」报出来。
 *     这个根数是**全局一份、所有币种共用**的（用户 2026-10-03：
 *     「保持 k 线缩放的根数是所有币种都要」）。
 *
 * 值都在 `settings.ts`（落 localStorage），这里只负责画和改。
 */
import {keepChartZoom, shownBars, shownKey} from '../settings'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{(e: 'close'): void}>()
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

      <p class="sheet-foot">改完立刻生效，自动记在这台设备上。</p>
    </section>
  </Teleport>
</template>
