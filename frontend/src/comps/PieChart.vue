<script setup lang="ts">
/**
 * 环形饼图（echarts）。
 *
 * 原来是自己手绘的 SVG（用户 2026-10-04：「统计图改为 echarts，触碰暗色主题」）。
 * **对外接口一个字没改**（props / emit / `PieItem`），所以调用方不用动。
 *
 * 图例仍然是自己画的 HTML（不用 echarts 的 legend）：echarts 的 legend 点击
 * 默认是「把这扇区隐藏掉」，而这里要的是「按这个条件去筛」，行为对不上；
 * 自己画还能顺手显示数值和百分比。
 */
import {computed, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue'
import {
  CHART_COLORS,
  C,
  darkTooltip,
  echarts,
  type ECharts
} from '../chart-theme'

export interface PieItem {
  /** 点击时回传的标识（标签名 / 结论 / 币种） */
  key: string
  label: string
  value: number
  /** 只进 tooltip，不占版面（如「均 44%」） */
  note?: string
}

const props = withDefaults(
  defineProps<{
    items: PieItem[]
    /** 当前选中的那一块（跟外部筛选状态对应） */
    activeKey?: string
    /** 最多画几块，超出的合并成「其他」 */
    top?: number
    unit?: string
    emptyText?: string
    /** 数据还没到 → 只显 loading，不画那张空图 */
    loading?: boolean
  }>(),
  {activeKey: '', top: 8, unit: '次', emptyText: '暂无数据'}
)

const emit = defineEmits<{(e: 'pick', key: string): void}>()

/** 合并出来的那一块（不可点） */
const OTHER = '__other__'

const el = ref<HTMLElement | null>(null)
const chart = shallowRef<ECharts | null>(null)
let ro: ResizeObserver | null = null

const slices = computed(() => {
  const sorted = [...props.items].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, props.top)
  const tail = sorted.slice(props.top)
  if (!tail.length) return head
  return [
    ...head,
    {
      key: OTHER,
      label: '其他',
      value: tail.reduce((s, i) => s + i.value, 0),
      note: `${tail.length} 项`
    }
  ]
})

const total = computed(() => slices.value.reduce((s, i) => s + i.value, 0))

const pickable = (key: string): boolean => key !== OTHER

function pctOf(v: number): string {
  return total.value > 0 ? ((v / total.value) * 100).toFixed(1) + '%' : '0%'
}

const colorOf = (i: number): string => CHART_COLORS[i % CHART_COLORS.length]

/**
 * ⚠️ 容器刚「从隐藏变可见」时，echarts 可能已经拿 100×100 兜底过了，
 * 而且它**不会自己纠正**（实测容器明明 328px，canvas 死卡在 100px）。
 * 所以每次渲染前拿容器的真实尺寸对一遍，不一致就显式 resize。
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
  if (!ensureChart()) return
  const c = chart.value
  if (!c) return
  fitSize()
  // 等数据到齐再画：loading 或空数据时先清空，别 setOption 出一张空图
  if (props.loading || !slices.value.length) {
    c.clear()
    return
  }
  const dimmed = Boolean(props.activeKey)
  c.setOption(
    {
      animationDuration: 240,
      tooltip: {
        ...darkTooltip,
        trigger: 'item',
        formatter: (p: {data?: {value?: number; note?: string}}) => {
          const v = p.data?.value ?? 0
          const extra = p.data?.note ? `<br/>${p.data.note}` : ''
          return `${props.unit} ${v}（${pctOf(v)}）${extra}`
        }
      },
      series: [
        {
          type: 'pie',
          radius: ['52%', '78%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: {borderColor: C.panel, borderWidth: 2},
          label: {show: false},
          labelLine: {show: false},
          emphasis: {scale: true, scaleSize: 4, itemStyle: {shadowBlur: 0}},
          data: slices.value.map((s, i) => ({
            name: s.label,
            value: s.value,
            note: s.note,
            itemStyle: {
              color: colorOf(i),
              // 选了某一项 → 其余变暗（跟原来手绘那套一致）
              opacity: !dimmed || props.activeKey === s.key ? 1 : 0.28
            }
          }))
        }
      ]
    },
    true
  )
}

/**
 * 点扇区 = 按这一项筛（「其他」不响应）
 */
function onClick(p: {name?: string}): void {
  const s = slices.value.find(x => x.label === p.name)
  if (s && pickable(s.key)) emit('pick', s.key)
}

/**
 * 容器**有真实尺寸**了才建图。
 *
 * ⚠️ 容器藏着（`v-show` / 布局未完成）时宽高是 0，这时 `echarts.init` 会刷一屏
 *    「Can't get DOM width or height」而且拿到的实例是坏的 —— 等尺寸回来再建。
 *    隐藏容器变可见时 ResizeObserver 会再报一次，那时才建得出图。
 */
function ensureChart(): boolean {
  if (chart.value) return true
  const box = el.value
  if (!box || box.clientWidth === 0 || box.clientHeight === 0) return false
  chart.value = echarts.init(box)
  chart.value.on('click', onClick)
  return true
}

onMounted(() => {
  render()
  ro = new ResizeObserver(() => {
    // 还没建图 = 容器之前没尺寸，现在可能露出来了 → 试着重来一次
    if (!chart.value) render()
    else fitSize()
  })
  ro.observe(el.value as Element)
})

watch(
  () => [props.items, props.activeKey, props.top],
  () => render(),
  {deep: true}
)

onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
})
</script>

<template>
  <div class="pie">
    <!--
      ⚠️ 图表容器必须**始终占位**（不能 `v-if` / 折叠掉）——
      否则宽度是 0 时 echarts 会拿 100×100 兜底且不再自己纠正。
      就算它真被 `v-show` 藏着也不怕：`ensureChart()` 会等它露出尺寸再建图。
      空数据的提示浮在上面一层，不占容器尺寸。
    -->
    <div ref="el" class="pie-canvas" />
    <div v-if="loading" class="chart-overlay">
      <span class="spin" />
      加载中…
    </div>
    <p v-else-if="!slices.length" class="pie-none">{{ emptyText }}</p>
    <ul v-if="!loading && slices.length" class="pie-legend">
      <li
        v-for="(s, i) in slices"
        :key="s.key"
        :class="{on: s.key === activeKey, dim: !pickable(s.key)}"
        :title="s.note"
        @click="pickable(s.key) && emit('pick', s.key)"
      >
        <i :style="{background: colorOf(i)}" />
        <span class="lb">{{ s.label }}</span>
        <span class="vv">{{ s.value }}</span>
        <span class="pc">{{ pctOf(s.value) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pie {
  position: relative;
  min-width: 0;
}
.pie-none {
  position: absolute;
  inset: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
}
.pie-canvas {
  width: 100%;
  height: 180px;
}
.pie-legend {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.pie-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
/* 悬停：触屏不应用（全站约定，见 style.css 里 `.seg` 上面那段说明） */
@media (hover: hover) {
  .pie-legend li:hover {
    background: var(--panel-2);
  }
}
.pie-legend li.dim {
  cursor: default;
  opacity: 0.75;
}
.pie-legend li.on {
  background: var(--blue-soft);
}
.pie-legend i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.pie-legend .lb {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pie-legend .vv {
  font-variant-numeric: tabular-nums;
}
.pie-legend .pc {
  min-width: 44px;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
