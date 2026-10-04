<script setup lang="ts">
/**
 * 迷你 K 线图（原生 canvas 手绘，不依赖 lightweight-charts）。
 *
 * 用途：知识库卡片里画「这条案例收录时存下的那段行情」。
 * 控件里可能同时挂着十几张，所以刻意做得很轻；
 * **不标拉伸区间**（用户不要），只看整段长什么样。
 */
import {onBeforeUnmount, onMounted, ref, watch} from 'vue'
import type {Candle} from '../api'
// 字体栈只有 `style.css` 那一份，这里从 CSS 变量读（见 `fonts.ts`）
import {monoStack, whenFontsReady} from '../fonts'

const props = defineProps<{
  candles: Candle[]
  height?: number
  /** 要不要画成交量（知识库卡片里不要，嫌乱） */
  showVolume?: boolean
}>()

const host = ref<HTMLCanvasElement | null>(null)
let ro: ResizeObserver | null = null
let raf = 0

// 跟 `KlineChart.vue`、`style.css` 的 `--ok` / `--bad` 三处必须一致
const UP = '#5eba89'
const DOWN = '#e35561'
const GRID = 'rgba(139, 148, 158, 0.22)'
const TEXT = 'rgba(139, 148, 158, 0.95)'

/** 根数太多时按 OHLC 合并，否则一根不到一个像素会糊成一团 */
function downsample(
  candles: Candle[],
  max: number
): {data: Candle[]; size: number} {
  if (candles.length <= max) return {data: candles, size: 1}
  const size = Math.ceil(candles.length / max)
  const out: Candle[] = []
  for (let i = 0; i < candles.length; i += size) {
    const seg = candles.slice(i, i + size)
    out.push({
      timestamp: seg[0].timestamp,
      open: seg[0].open,
      high: Math.max(...seg.map(c => c.high)),
      low: Math.min(...seg.map(c => c.low)),
      close: seg[seg.length - 1].close,
      volume: seg.reduce((s, c) => s + c.volume, 0)
    })
  }
  return {data: out, size}
}

function paint() {
  const el = host.value
  const raw = props.candles
  if (!el || !raw.length) return

  // 根数太多就合并（一根不到一个像素会糊成一团）
  const {data} = downsample(raw, 180)

  const dpr = window.devicePixelRatio || 1
  const w = Math.max(60, el.clientWidth)
  const h = props.height ?? 118
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
  }
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const padT = 10
  const padB = 14
  const padL = 4
  const padR = 40
  const showVol = props.showVolume === true
  const volH = showVol ? 16 : 0
  const priceH = h - padT - padB - volH
  const plotW = w - padL - padR

  let lo = Infinity
  let hi = -Infinity
  let maxVol = 0
  for (const c of data) {
    if (c.low < lo) lo = c.low
    if (c.high > hi) hi = c.high
    if (c.volume > maxVol) maxVol = c.volume
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return
  const pad = (hi - lo) * 0.06
  lo -= pad
  hi += pad

  const n = data.length
  const step = plotW / n
  const bodyW = Math.max(1, Math.min(step * 0.68, 9))

  const y = (p: number) => padT + priceH * (1 - (p - lo) / (hi - lo))
  const x = (i: number) => padL + step * (i + 0.5)

  // 参考线：最高 / 最低
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  for (const p of [hi - pad, lo + pad]) {
    const yy = Math.round(y(p)) + 0.5
    ctx.beginPath()
    ctx.moveTo(padL, yy)
    ctx.lineTo(padL + plotW, yy)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // 蜡烛
  for (let i = 0; i < n; i++) {
    const c = data[i]
    const up = c.close >= c.open
    ctx.strokeStyle = up ? UP : DOWN
    ctx.fillStyle = up ? UP : DOWN
    const cx = x(i)
    ctx.beginPath()
    ctx.moveTo(cx, y(c.high))
    ctx.lineTo(cx, y(c.low))
    ctx.lineWidth = 1
    ctx.stroke()
    const yo = y(c.open)
    const yc = y(c.close)
    const top = Math.min(yo, yc)
    const bh = Math.max(1, Math.abs(yc - yo))
    ctx.fillRect(cx - bodyW / 2, top, bodyW, bh)
  }

  // 成交量
  if (showVol && maxVol > 0) {
    const vTop = padT + priceH + 3
    for (let i = 0; i < n; i++) {
      const c = data[i]
      const bh = Math.max(1, (c.volume / maxVol) * volH)
      ctx.fillStyle =
        c.close >= c.open ? 'rgba(94,186,137,0.42)' : 'rgba(227,85,97,0.42)'
      ctx.fillRect(x(i) - bodyW / 2, vTop + volH - bh, bodyW, bh)
    }
  }

  // 右侧：最高 / 最低
  ctx.fillStyle = TEXT
  // ⚠️ 原来写死的 `ui-monospace, …, Menlo, monospace` 没跟着 `--mono` 走
  ctx.font = '10px ' + monoStack()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  const fmtPrice = (p: number) =>
    p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(3) : p.toFixed(6)
  ctx.fillText(fmtPrice(hi - pad), padL + plotW + 5, y(hi - pad))
  ctx.fillText(fmtPrice(lo + pad), padL + plotW + 5, y(lo + pad))
}

function schedule() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(paint)
}

onMounted(() => {
  schedule()
  /*
   * canvas 画好的字不会自己更新 —— 自托管字体是异步到的，
   * 字体就绪后必须重画一帧，否则最高/最低那两个数字一直是回退字体的样子。
   */
  whenFontsReady(schedule)
  if (host.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(schedule)
    ro.observe(host.value)
  }
})

watch(() => props.candles, schedule, {deep: false})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  ro = null
})
</script>

<template>
  <div class="mini-kline">
    <canvas ref="host" :style="{height: (height ?? 118) + 'px'}" />
    <div v-if="!candles.length" class="mini-empty">这条案例没存下 K 线</div>
  </div>
</template>

<style scoped>
.mini-kline {
  position: relative;
  width: 100%;
}
.mini-kline canvas {
  display: block;
  width: 100%;
  border-radius: 6px;
  background: var(--panel);
}
.mini-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--muted);
}
</style>
