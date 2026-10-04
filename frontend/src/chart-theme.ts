/**
 * echarts 的**共用暗色主题** + 按需注册。
 *
 * 全站的统计图（饼图 / 柱状 / 迷你 K 线 / 服务器监测）都从这里取配置，
 * 保证跟页面主题（`style.css` 的 CSS 变量）是一套颜色 —— 用户 2026-10-04：
 * 「统计图改为 echarts，触碰暗色主题」。
 *
 * ⚠️ **只注册用得到的**图表与组件，别 `import 'echarts'` 整包（那会把整个
 *    echarts 打进 bundle）。
 * ⚠️ K 线主图（`KlineChart.vue`）**不在**这一套里 —— 它用 lightweight-charts，
 *    交互（十字光标 / 缩放 / 画范围 / 实时推送）都是专门做的，不换。
 */
import * as echarts from 'echarts/core'
import {
  BarChart,
  CandlestickChart,
  GaugeChart,
  LineChart,
  PieChart
} from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent
} from 'echarts/components'
import {CanvasRenderer} from 'echarts/renderers'

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  CandlestickChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer
])

/** 一套跟站点主题对齐的颜色（跟 style.css 的变量同值） */
export const CHART_COLORS = [
  '#42a5f5', // blue
  '#26a69a', // ok
  '#f0b429', // warn
  '#a78bfa', // violet
  '#ef5350', // bad
  '#4dd0e1', // cyan
  '#ffb74d', // orange
  '#9ccc65' //  light green
]

/** 文字 / 网格 / 面板（暗色） */
export const C = {
  text: '#8b949e',
  strong: '#e6edf3',
  grid: '#2a3441',
  border: '#2a3441',
  panel: '#161b22',
  bg: '#0d1117',
  blue: '#42a5f5',
  ok: '#26a69a',
  warn: '#f0b429',
  bad: '#ef5350',
  violet: '#a78bfa'
}

/**
 * 暗色 tooltip。echarts 默认是白底黑字，在暗色页面上很扎眼。
 *
 * ⚠️ `appendToBody` 别开：开了以后 tooltip 会脱离组件，
 *    在弹窗（抽屉）里会跑到下层去，看着像「tooltip 不见了」。
 */
export const darkTooltip = {
  backgroundColor: 'rgba(13,17,23,.94)',
  borderColor: C.border,
  borderWidth: 1,
  padding: [6, 10],
  textStyle: {color: C.strong, fontSize: 12},
  extraCssText: 'backdrop-filter: blur(6px); border-radius: 8px;'
}

/** 暗色的坐标轴（自带 10px 小字） */
export function darkAxis(extra: Record<string, unknown> = {}) {
  return {
    axisLabel: {color: C.text, fontSize: 10},
    axisLine: {lineStyle: {color: C.grid}},
    axisTick: {show: false},
    splitLine: {lineStyle: {color: C.grid, type: 'dashed'}},
    ...extra
  }
}

/** 暗色的图例（右上角，小圆点） */
export function darkLegend(extra: Record<string, unknown> = {}) {
  return {
    top: 0,
    right: 0,
    itemWidth: 10,
    itemHeight: 7,
    itemGap: 10,
    textStyle: {color: C.text, fontSize: 11},
    inactiveColor: '#4b5563',
    ...extra
  }
}

/** 饼图/环图的默认样式（暗色、不要阴影） */
export function darkPie(label = true) {
  return {
    type: 'pie' as const,
    itemStyle: {
      borderColor: C.panel,
      borderWidth: 2
    },
    label: label ? {color: C.text, fontSize: 11} : {show: false},
    labelLine: label
      ? {lineStyle: {color: C.grid}, length: 6, length2: 6}
      : {show: false}
  }
}

export {echarts}
/** 图表实例的类型（`echarts` 是命名空间值，当不了类型用，单独导一次） */
export type {ECharts} from 'echarts/core'
