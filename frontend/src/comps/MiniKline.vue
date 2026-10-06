<script setup lang="ts">
/**
 * 迷你 K 线（echarts）—— 画知识库卡片里「收录时存下的那段行情」。
 *
 * 原来是手绘 canvas（用户 2026-10-04：「统计图改为 echarts」）。
 *
 * ⚠️ 一屏可能同时挂十几张，所以刻意压开销：
 *    · `animation: false`（不要入场动画）
 *    · `silent: true`（卡片里的小图不需要任何悬停/点击）
 *    · 坐标轴全部 `show: false`（原来就是纯图形，没有刻度）
 *    · 根数太多先按 OHLC 降采样，否则一根不到一个像素会糊成一团
 */
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue'
import type {Candle} from '../api'
import {echarts, type ECharts} from '../chart-theme'

const props = defineProps<{
  candles: Candle[]
  height?: number
  /** 要不要画成交量（知识库卡片里不要，嫌乱） */
  showVolume?: boolean
  /** 数据还没到 → 只显 loading，不画空图 */
  loading?: boolean
}>()

// 跟 `KlineChart.vue`、`style.css` 的 `--ok` / `--bad` 三处必须一致
const UP = '#5eba89'
const DOWN = '#e35561'

/** 图上最多画多少根（超了按 OHLC 合并） */
const MAX_BARS = 160


/**
 * 一根 K 线的时间（毫秒）。
 *
 * ⚠️ 两种数据源混着用：`/api/candles` 给的是 **`timestamp`**，
 *    而知识库卡片那份老数据里写的是 `time` —— 两个都认，别只认一个。
 */
function candleTime(c: Candle): number {
  const legacy = (c as Candle & {time?: number}).time
  return typeof legacy === 'number' ? legacy : c.timestamp
}

const el = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
let ro: ResizeObserver | null = null

const boxH = computed(() => props.height ?? 118)

/** 根数太多时按 OHLC 合并，否则一根不到一个像素会糊成一团 */
function downsample(cs: Candle[], step: number): Candle[] {
  if (step <= 1) return cs
  const out: Candle[] = []
  for (let i = 0; i < cs.length; i += step) {
    const g = cs.slice(i, i + step)
    if (!g.length) continue
    out.push({
      timestamp: candleTime(g[0]),
      open: g[0].open,
      high: Math.max(...g.map(c => c.high)),
      low: Math.min(...g.map(c => c.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((s, c) => s + c.volume, 0)
    })
  }
  return out
}

/**
 * ⚠️ 容器刚「从隐藏变可见」时，echarts 可能已经拿 100×100 兜底过了，
 * 而且它**不会自己纠正** —— 每次渲染前拿真实尺寸对一遍。
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

/**
 * 容器**有真实尺寸**了才建图。
 *
 * ⚠️ 藏着 / 布局未完成时宽高是 0，这时 `echarts.init` 会刷一屏
 *    「Can't get DOM width or height」且实例是坏的 —— 等尺寸回来再建。
 */
function ensureChart(): boolean {
  if (chart.value) return true
  const box = el.value
  if (!box || box.clientWidth === 0 || box.clientHeight === 0) return false
  chart.value = echarts.init(box)
  return true
}

function render(): void {
  if (!ensureChart()) return
  fitSize()
  const c = chart.value
  if (!c) return
  // 等数据到齐再画：loading 或空数据时先清空，别 setOption 出一张空图
  if (props.loading || !props.candles.length) {
    c.clear()
    return
  }
  const raw = props.candles
  const step = Math.max(1, Math.ceil(raw.length / MAX_BARS))
  const cs = downsample(raw, step)
  const xs = cs.map(c => String(candleTime(c)))
  // echarts 的蜡烛数据顺序是 [开, 收, 低, 高]
  const ohlc = cs.map(c => [c.open, c.close, c.low, c.high])

  const totalH = boxH.value
  const withVol = props.showVolume === true && cs.length > 0
  const volH = withVol ? Math.max(12, Math.round(totalH * 0.22)) : 0

  c.setOption(
    {
      animation: false,
      silent: true,
      grid: withVol
        ? [
            {left: 0, right: 0, top: 0, height: totalH - volH - 4},
            {left: 0, right: 0, top: totalH - volH, height: volH}
          ]
        : [{left: 0, right: 0, top: 0, bottom: 0}],
      xAxis: withVol
        ? [
            {type: 'category', data: xs, show: false, boundaryGap: true},
            {
              type: 'category',
              data: xs,
              gridIndex: 1,
              show: false,
              boundaryGap: true
            }
          ]
        : [{type: 'category', data: xs, show: false, boundaryGap: true}],
      yAxis: withVol
        ? [
            {type: 'value', scale: true, show: false},
            {type: 'value', gridIndex: 1, show: false}
          ]
        : [{type: 'value', scale: true, show: false}],
      series: [
        {
          type: 'candlestick',
          data: ohlc,
          barMaxWidth: 6,
          itemStyle: {
            color: UP,
            color0: DOWN,
            borderColor: UP,
            borderColor0: DOWN
          }
        },
        ...(withVol
          ? [
              {
                type: 'bar' as const,
                xAxisIndex: 1,
                yAxisIndex: 1,
                data: cs.map(c => ({
                  value: c.volume,
                  itemStyle: {
                    color: c.close >= c.open ? UP : DOWN,
                    opacity: 0.45
                  }
                })),
                barMaxWidth: 6
              }
            ]
          : [])
      ]
    },
    // notMerge：换了案例（比如弹窗里换一条）别把上一条的 series 留着
    true
  )
}

onMounted(() => {
  render()
  ro = new ResizeObserver(() => {
    // 容器从「藏着」变「露出来」或宽度变了 → 重排一次
    // （还没建图时 render 会先尝试建图）
    render()
  })
  ro.observe(el.value as Element)
})

watch(
  () => [props.candles, props.height, props.showVolume, props.loading],
  () => render(),
  {
    deep: true
  }
)

onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
})
</script>

<template>
  <div class="mini-kline" :style="{height: boxH + 'px'}">
    <div ref="el" class="mini-kline-el" />
    <span v-if="loading" class="mini-kline-loading">加载中…</span>
  </div>
</template>

<style scoped>
.mini-kline {
  position: relative;
  width: 100%;
  min-width: 0;
}
.mini-kline-el {
  position: absolute;
  inset: 0;
}
.mini-kline-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 11px;
  pointer-events: none;
}
</style>
