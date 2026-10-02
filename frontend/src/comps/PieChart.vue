<script setup lang="ts">
/**
 * 手绘 SVG 环形饼图 —— 不引图表库。
 *
 * 为什么不用 CSS `conic-gradient`：扇区要**可点**、要有 tooltip、要跟图例联动高亮，
 * SVG path 直接挂事件就行，也不用为了一个饼图装个依赖。
 */
import {computed} from 'vue'

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
  }>(),
  {activeKey: '', top: 8, unit: '次', emptyText: '暂无数据'}
)

const emit = defineEmits<{(e: 'pick', key: string): void}>()

/** 配色：够 9 块用，跟页面主色系一致 */
const COLORS = [
  '#58a6ff',
  '#39c5bb',
  '#d29922',
  '#f778ba',
  '#a371f7',
  '#7ee787',
  '#ffa657',
  '#79c0ff',
  '#ff7b72'
]

const R = 52
const INNER = 31
const C = 60

function pt(rad: number, angle: number): [number, number] {
  return [C + rad * Math.cos(angle), C + rad * Math.sin(angle)]
}

/** 环形扇区路径；整圆必须拆成两段，否则 A 命令会退化画不出来 */
function donut(start: number, end: number): string {
  const span = end - start
  if (span >= Math.PI * 2 - 1e-6) {
    return [
      donut(start, start + Math.PI),
      donut(start + Math.PI, start + Math.PI * 2)
    ].join(' ')
  }
  const [x0, y0] = pt(R, start)
  const [x1, y1] = pt(R, end)
  const [x2, y2] = pt(INNER, end)
  const [x3, y3] = pt(INNER, start)
  const large = span > Math.PI ? 1 : 0
  return `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${INNER} ${INNER} 0 ${large} 0 ${x3} ${y3} Z`
}

const total = computed(() => props.items.reduce((s, i) => s + i.value, 0))

const slices = computed(() => {
  const sorted = [...props.items].sort((a, b) => b.value - a.value)
  const head = sorted.slice(0, props.top)
  const tail = sorted.slice(props.top)
  const list = tail.length
    ? [
        ...head,
        {
          key: '__other__',
          label: `其他 ${tail.length} 项`,
          value: tail.reduce((s, i) => s + i.value, 0)
        }
      ]
    : head

  const sum = list.reduce((s, i) => s + i.value, 0) || 1
  let angle = -Math.PI / 2
  return list.map((it, i) => {
    const span = (it.value / sum) * Math.PI * 2
    const out = {
      ...it,
      color: COLORS[i % COLORS.length],
      pct: (it.value / sum) * 100,
      d: donut(angle, angle + span)
    }
    angle += span
    return out
  })
})

/** 「其他」是聚合出来的，点了没法筛 */
const pickable = (key: string) => key !== '__other__'
</script>

<template>
  <div class="pie">
    <div v-if="!total" class="pie-empty">{{ emptyText }}</div>

    <template v-else>
      <svg class="pie-svg" viewBox="0 0 120 120" role="img">
        <g v-for="s in slices" :key="s.key">
          <path
            :d="s.d"
            :fill="s.color"
            :class="{
              on: !!activeKey && activeKey === s.key,
              off: !!activeKey && activeKey !== s.key
            }"
            :style="pickable(s.key) ? null : {cursor: 'default'}"
            @click="pickable(s.key) && emit('pick', s.key)"
          >
            <title>
              {{ s.label }} · {{ s.value }} {{ unit }}（{{
                s.pct.toFixed(1)
              }}%）
            </title>
          </path>
        </g>
        <text class="pie-total" x="60" y="58">{{ total }}</text>
        <text class="pie-total-label" x="60" y="70">合计</text>
      </svg>

      <ul class="pie-legend">
        <li
          v-for="s in slices"
          :key="s.key"
          :class="{
            on: !!activeKey && activeKey === s.key,
            dim: !!activeKey && activeKey !== s.key,
            flat: !pickable(s.key)
          }"
          :title="
            pickable(s.key) ? '点一下只看这一类' : '聚合出来的，不能直接筛'
          "
          @click="pickable(s.key) && emit('pick', s.key)"
        >
          <i :style="{background: s.color}" />
          <span class="name">{{ s.label }}</span>
          <span class="num">
            {{ s.value }}<em>{{ s.pct.toFixed(0) }}%</em>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.pie {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 132px;
}

.pie-empty {
  flex: 1;
  text-align: center;
  color: var(--dim, #8b949e);
  font-size: 12px;
}

.pie-svg {
  width: 132px;
  height: 132px;
  flex: 0 0 auto;
  overflow: visible;
}

.pie-svg path {
  cursor: pointer;
  transition:
    opacity 0.15s,
    transform 0.15s;
  transform-origin: 60px 60px;
}

.pie-svg path.on {
  transform: scale(1.04);
}
.pie-svg path.off {
  opacity: 0.32;
}

.pie-total {
  fill: var(--fg, #e6edf3);
  font-size: 17px;
  font-weight: 600;
  text-anchor: middle;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.pie-total-label {
  fill: var(--dim, #8b949e);
  font-size: 9px;
  text-anchor: middle;
  pointer-events: none;
}

.pie-legend {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 0;
  max-height: 148px;
  overflow-y: auto;
}

.pie-legend li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 5px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}

.pie-legend li:hover {
  background: rgba(255, 255, 255, 0.05);
}

.pie-legend li.on {
  background: rgba(88, 166, 255, 0.14);
  color: var(--fg, #e6edf3);
}

.pie-legend li.dim {
  opacity: 0.5;
}

.pie-legend li.flat {
  cursor: default;
}

.pie-legend i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}

.pie-legend .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pie-legend .num {
  color: var(--dim, #8b949e);
  font-variant-numeric: tabular-nums;
}

.pie-legend .num em {
  font-style: normal;
  margin-left: 5px;
  font-size: 10px;
  opacity: 0.75;
}
</style>
