<script setup lang="ts">
/**
 * 净资产曲线（echarts）。
 *
 * 画法照 `docs/EXCHANGE.md` 定的三件事：
 *   · **`close` 画折线**（桶内最后一条的净值）
 *   · **`high` / `low` 画区间带**（桶内最大/最小；用两条堆叠的 line 拼出来，
 *     下面那条只占位不画线）
 *   · **不插值**：断档处往数据里塞 `null`，echarts 自己就把折线断开了
 *     —— 让人看得出这里缺数据，而不是被一条直线蒙过去
 *
 * ⚠️ y 轴用 `scale: true`（**不强制从 0 起**）：账户只有几美元时从 0 画，
 *    曲线会贴着顶成一条直线，什么走势都看不出来。
 */
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue'
import {C, darkTooltip, echarts, type ECharts} from '../chart-theme'
import {bjTime} from '../format'
import type {CurvePoint} from '../api'

const props = defineProps<{
  points: CurvePoint[]
  /** 后端用的桶宽（秒）—— 判断「断档」要用它 */
  bucketSec?: number
}>()

/** 塞过 null 之后的点（`null` = 这一段断过，折线在这里断） */
interface Row {
  t: number
  close: number
  high: number
  low: number
}

const el = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
let ro: ResizeObserver | null = null

/**
 * 把点整理成 echarts 要的形状。
 *
 * ⚠️ 断档（两点间隔 > 2.5 个桶）时**插一个 `null`**，不能就这么连着 ——
 *    那就等于自己画了一条不存在的直线。
 */
const shape = computed(() => {
  const pts = props.points ?? []
  if (pts.length < 2) return null
  const gapMs = Math.max(1, props.bucketSec ?? 300) * 2500

  /** 跟 xs 一一对应：断档那个位置是 null（tooltip 靠它跳过） */
  const rows: (Row | null)[] = []
  const xs: number[] = []
  const close: (number | null)[] = []
  const low: (number | null)[] = []
  const band: (number | null)[] = []

  pts.forEach((p, i) => {
    const t = new Date(p.t).getTime()
    if (!Number.isFinite(t)) return
    const prev = i > 0 ? new Date(pts[i - 1].t).getTime() : 0
    if (i > 0 && t - prev > gapMs) {
      // 断档：在中间某个位置插一个空点，折线就断在这儿
      xs.push(prev + (t - prev) / 2)
      rows.push(null)
      close.push(null)
      low.push(null)
      band.push(null)
    }
    const row: Row = {t, close: p.close, high: p.high, low: p.low}
    xs.push(t)
    rows.push(row)
    close.push(p.close)
    // 堆叠：下面那条放 low，上面那条放 (high - low)，叠起来正好到 high
    low.push(p.low)
    band.push(Math.max(0, p.high - p.low))
  })
  if (rows.length < 2) return null

  const span = xs[xs.length - 1] - xs[0]
  return {xs, rows, close, low, band, span}
})

/** 轴上时间：跨度短看时分，跨度长看月日 */
function axisTime(v: number, span: number): string {
  const d = new Date(v)
  const p = (x: number): string => String(x).padStart(2, '0')
  return span <= 36 * 3600 * 1000
    ? `${p(d.getHours())}:${p(d.getMinutes())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** y 轴刻度：大数缩写一下，不然标签比图还宽 */
function shortMoney(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `$${(v / 1e3).toFixed(0)}k`
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}k`
  return `$${v.toFixed(2)}`
}

/**
 * ⚠️ 容器刚「从隐藏变可见」时 echarts 可能已经拿 100×100 兜底过了，
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

/** 容器**有真实尺寸**了才建图（宽高是 0 时 init 会刷一屏报错且实例是坏的） */
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
  const s = shape.value
  if (!s) {
    c.clear()
    return
  }
  const span = s.span
  c.setOption(
    {
      animationDuration: 220,
      grid: {left: 50, right: 10, top: 10, bottom: 20},
      tooltip: {
        ...darkTooltip,
        trigger: 'axis',
        axisPointer: {type: 'line', lineStyle: {color: C.grid}},
        formatter: (ps: {dataIndex?: number}[]) => {
          const i = ps?.[0]?.dataIndex
          const r = i === undefined ? null : s.rows[i]
          if (!r) return ''
          return (
            `${bjTime(new Date(r.t).toISOString())}<br/>` +
            `净值 ${shortMoney(r.close)}<br/>` +
            `<span style="color:${C.text}">高 ${shortMoney(r.high)} · 低 ${shortMoney(r.low)}</span>`
          )
        }
      },
      xAxis: {
        type: 'time',
        axisLabel: {
          color: C.text,
          fontSize: 10,
          hideOverlap: true,
          formatter: (v: number) => axisTime(v, span)
        },
        axisLine: {lineStyle: {color: C.grid}},
        axisTick: {show: false},
        splitLine: {show: false}
      },
      yAxis: {
        // ⚠️ 不强制从 0 起，否则几美元的小账户就是一条直线
        scale: true,
        axisLabel: {
          color: C.text,
          fontSize: 10,
          formatter: (v: number) => shortMoney(v)
        },
        splitLine: {lineStyle: {color: C.grid, type: 'dashed'}}
      },
      series: [
        /*
         * 区间带：两条堆叠的线。下面那条（low）只占位、不画线、不响应鼠标；
         * 上面那条（high-low）只画填充。
         */
        {
          name: 'low',
          type: 'line',
          stack: 'band',
          data: s.xs.map((x, i) => [x, s.low[i]]),
          symbol: 'none',
          lineStyle: {opacity: 0},
          areaStyle: {opacity: 0},
          silent: true,
          z: 1,
          tooltip: {show: false}
        },
        {
          name: 'band',
          type: 'line',
          stack: 'band',
          data: s.xs.map((x, i) => [x, s.band[i]]),
          symbol: 'none',
          lineStyle: {opacity: 0},
          areaStyle: {color: C.blue, opacity: 0.16},
          silent: true,
          z: 1,
          tooltip: {show: false}
        },
        {
          name: '净值',
          type: 'line',
          data: s.xs.map((x, i) => [x, s.close[i]]),
          symbol: 'none',
          smooth: false,
          // ⚠️ 必须 false：插进去的 null 就是要把折线断开（不插值）
          connectNulls: false,
          lineStyle: {color: C.blue, width: 1.6},
          z: 3
        }
      ]
    },
    true
  )
}

onMounted(() => {
  render()
  ro = new ResizeObserver(() => {
    if (!chart.value) render()
    else fitSize()
  })
  ro.observe(el.value as Element)
})

watch(() => [props.points, props.bucketSec], () => render(), {deep: true})

onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
})
</script>

<template>
  <div class="curve-wrap">
    <div ref="el" class="curve" />
    <p v-if="!shape" class="dim">
      还不够画曲线 —— 快照每 5 分钟攒一个点，过一会儿就有。
    </p>
  </div>
</template>

<style scoped>
.curve {
  width: 100%;
  height: 148px;
}
.dim {
  margin: 0;
  padding: 22px 0;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}
</style>
