<script setup lang="ts">
/**
 * 按天花费柱状图（echarts）。
 *
 * 原来是手绘 SVG（用户 2026-10-04：「统计图改为 echarts，触碰暗色主题」）。
 * props 没变，`UsageView` 不用动。
 */
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue'
import {cny, usd} from '../format'
import type {UsageBucket} from '../api'
import {C, darkTooltip, echarts, type ECharts} from '../chart-theme'

const props = defineProps<{
  days: UsageBucket[]
  rate: number
}>()

/** 时间升序，图从左到右 */
const bars = computed(() =>
  [...props.days].sort((a, b) => a.key.localeCompare(b.key))
)

const el = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
let ro: ResizeObserver | null = null

/**
 * ⚠️ 容器刚「从隐藏变可见」时，echarts 可能已经拿 100×100 兜底过了，
 * 而且它**不会自己纠正**（实测容器明明 328px，canvas 死卡在 100px）。
 */
function fitSize(): void {
  const c = chart.value
  const box = el.value
  if (!c || !box) return
  const w = box.clientWidth
  const h = box.clientHeight
  if (w > 0 && h > 0 && (c.getWidth() !== w || c.getHeight() !== h)) {
    c.resize({width: w, height: h})
  }
}

function render(): void {
  if (!chart.value) return
  fitSize()
  const xs = bars.value.map(b => b.key.slice(5))
  chart.value.setOption(
    {
      animationDuration: 220,
      grid: {left: 54, right: 12, top: 14, bottom: 24},
      tooltip: {
        ...darkTooltip,
        trigger: 'axis',
        axisPointer: {
          type: 'shadow',
          shadowStyle: {color: 'rgba(255,255,255,.04)'}
        },
        formatter: (ps: {dataIndex?: number}[]) => {
          const i = ps?.[0]?.dataIndex
          const b = i === undefined ? null : bars.value[i]
          if (!b) return ''
          return `${b.key}<br/>${usd(b.costUsd)}<br/>${cny(b.costUsd * props.rate)}`
        }
      },
      xAxis: {
        type: 'category',
        data: xs,
        // 只留 5 个刻度，否则日期会挤成一团
        axisLabel: {
          color: C.text,
          fontSize: 10,
          interval: Math.max(1, Math.ceil(xs.length / 5)) - 1
        },
        axisLine: {lineStyle: {color: C.grid}},
        axisTick: {show: false}
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color: C.text,
          fontSize: 10,
          formatter: (v: number) => usd(v)
        },
        splitLine: {lineStyle: {color: C.grid, type: 'dashed'}}
      },
      series: [
        {
          type: 'bar',
          data: bars.value.map(b => b.costUsd),
          barMaxWidth: 34,
          itemStyle: {color: C.blue, borderRadius: [3, 3, 0, 0]},
          emphasis: {itemStyle: {color: C.ok}}
        }
      ]
    },
    true
  )
}

onMounted(() => {
  if (!el.value) return
  chart.value = echarts.init(el.value)
  render()
  ro = new ResizeObserver(() => fitSize())
  ro.observe(el.value)
})

watch(
  () => [props.days, props.rate],
  () => render(),
  {deep: true}
)

onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
})
</script>

<template>
  <div class="trend-wrap">
    <!--
      ⚠️ 容器必须**始终可见** —— 藏起来（v-show/v-if）时宽度是 0，
      echarts 会拿 100×100 兜底且不再自己纠正（实测 canvas 死卡在 100px）。
    -->
    <div ref="el" class="trend" />
    <p v-if="!bars.length" class="trend-none">这段时间没有调用记录</p>
  </div>
</template>

<style scoped>
.trend-wrap {
  position: relative;
  min-width: 0;
}
.trend {
  width: 100%;
  height: 180px;
}
.trend-none {
  position: absolute;
  inset: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
}
</style>
