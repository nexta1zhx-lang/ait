<script setup lang="ts">
import {computed, ref} from 'vue'
import {cny, tok, usd} from '../format'
import type {UsageBucket} from '../api'
// 字体栈只有 `style.css` 那一份，这里从 CSS 变量读（见 `fonts.ts`）
import {monoStack} from '../fonts'

/** 按天花费柱状图（纯 SVG，不引图表库） */

/** 横轴那排日期是数字，跟全站其它数字用同一款等宽 */
const mono = monoStack()

const props = defineProps<{
  days: UsageBucket[]
  rate: number
}>()

/** 时间升序，图从左到右 */
const bars = computed(() =>
  [...props.days].sort((a, b) => a.key.localeCompare(b.key))
)

const W = 900
const H = 180
const PAD_L = 8
const PAD_R = 8
const PAD_T = 12
const PAD_B = 26

const maxCost = computed(() =>
  Math.max(...bars.value.map(b => b.costUsd), 0.000001)
)
const slot = computed(() =>
  bars.value.length ? (W - PAD_L - PAD_R) / bars.value.length : 0
)
const barW = computed(() => Math.max(2, Math.min(38, slot.value * 0.62)))

const hovered = ref<number | null>(null)

const x = (i: number) => PAD_L + slot.value * i + (slot.value - barW.value) / 2
const h = (cost: number) => ((H - PAD_T - PAD_B) * cost) / maxCost.value
const y = (cost: number) => H - PAD_B - h(cost)

/** 只显示 5 个刻度，避免挤 */
const labelEvery = computed(() => Math.max(1, Math.ceil(bars.value.length / 5)))

const active = computed(() =>
  hovered.value === null ? null : bars.value[hovered.value]
)

const gridLines = computed(() =>
  [0, 0.5, 1].map(f => ({
    y: PAD_T + (H - PAD_T - PAD_B) * (1 - f),
    label: usd(maxCost.value * f)
  }))
)
</script>

<template>
  <div>
    <div v-if="!bars.length" class="empty">这段时间没有调用记录</div>

    <template v-else>
      <div style="position: relative">
        <svg
          :viewBox="`0 0 ${W} ${H}`"
          preserveAspectRatio="none"
          style="width: 100%; height: 180px; display: block"
        >
          <line
            v-for="g in gridLines"
            :key="g.label"
            :x1="0"
            :x2="W"
            :y1="g.y"
            :y2="g.y"
            stroke="var(--border)"
            stroke-width="1"
            stroke-dasharray="3 5"
            vector-effect="non-scaling-stroke"
            opacity="0.7"
          />
          <rect
            v-for="(b, i) in bars"
            :key="b.key"
            :x="x(i)"
            :y="y(b.costUsd)"
            :width="barW"
            :height="Math.max(1, h(b.costUsd))"
            :fill="hovered === i ? 'var(--ok)' : 'var(--blue)'"
            :opacity="hovered === i ? 1 : 0.75"
            style="cursor: pointer"
            @mouseenter="hovered = i"
            @mouseleave="hovered = null"
          />
        </svg>

        <div style="position: relative; height: 16px; margin-top: -12px">
          <span
            v-for="(b, i) in bars"
            :key="b.key"
            class="dim"
            :style="{
              position: 'absolute',
              left: ((x(i) + barW / 2) / W) * 100 + '%',
              transform: 'translateX(-50%)',
              fontSize: '10px',
              fontFamily: mono,
              fontVariantNumeric: 'tabular-nums'
            }"
          >
            <template v-if="i % labelEvery === 0">{{
              b.key.slice(5)
            }}</template>
          </span>
        </div>

        <div
          v-if="active"
          :style="{
            position: 'absolute',
            top: 0,
            left: ((x(hovered as number) + barW / 2) / W) * 100 + '%',
            transform: 'translateX(-50%)'
          }"
          class="panel"
        >
          <div class="dim" style="font-size: 11px">{{ active.key }}</div>
          <div class="heat-row" style="font-size: 11px">
            <span class="k">花费</span
            ><span class="v">{{ cny(active.costUsd * rate) }}</span>
          </div>
          <div class="heat-row" style="font-size: 11px">
            <span class="k">原价</span
            ><span class="v">{{ usd(active.costUsd) }}</span>
          </div>
          <div class="heat-row" style="font-size: 11px">
            <span class="k">次数</span><span class="v">{{ active.calls }}</span>
          </div>
          <div class="heat-row" style="font-size: 11px">
            <span class="k">输入</span
            ><span class="v">{{ tok(active.promptTokens) }}</span>
          </div>
          <div class="heat-row" style="font-size: 11px">
            <span class="k">输出</span
            ><span class="v">{{ tok(active.completionTokens) }}</span>
          </div>
        </div>
      </div>

      <div
        class="dim"
        style="
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          margin-top: 6px;
        "
      >
        <span>柱子 = 每天花费（人民币）</span>
        <span>最高 {{ cny(maxCost * rate) }} · 共 {{ bars.length }} 天</span>
      </div>
    </template>
  </div>
</template>
