<script setup lang="ts">
/**
 * 配置（底部弹出）。
 *
 * 入口在 K 线头部「AI 分析 / ＋」那一行最右边那颗按钮上。
 * 现在只有一条开关 + 一条只读信息：
 *   · 保持 K 线缩放样式（开关，默认**打开**）
 *   · 显示多少根 K 线 —— **不是给用户选的档位**，只是把「当前这个币正在看多少根」报出来
 *     （用户：「显示多少根 k 线是根据当前币种查看的效果，在关闭 k 线图或者切换 k 线图保存」）
 *
 * 值都在 `settings.ts`（落 localStorage），这里只负责画和改。
 */
import {computed} from 'vue'
import {keepChartZoom, rememberedCount, shownBars, shownKey} from '../settings'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{(e: 'close'): void}>()

/** 「已记住 3 个币」——只在真记住过的时候提一句 */
const remembered = computed(() => rememberedCount())
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
            打开后，每个币都记得自己<b>最后看到的那一段</b>：换币、换周期、切页回来，
            各是各的，不会自己跳回最新一段。关掉就是每次都自动适配最新行情。
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
              现在 <em>{{ shownKey }}</em> 图上显示 <em>{{ shownBars }}</em> 根
              —— 这是你缩放 /
              拖出来的，不在这儿选；切走或换币时自动记住，回来还是这段。
            </template>
            <template v-else
              >打开 K 线图后，这里会显示当前看了多少根。</template
            >
            <template v-if="remembered">
              <br />已经记住 {{ remembered }} 个币的缩放。
            </template>
          </p>
        </div>
      </div>

      <p class="sheet-foot">改完立刻生效，自动记在这台设备上。</p>
    </section>
  </Teleport>
</template>
