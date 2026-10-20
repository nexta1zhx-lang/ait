<script setup lang="ts">
/**
 * K 线图下方的**币种标注区**（2026-10-20）。
 *
 * 用户：「打的标签在 K 线显示在底部显示所有历史标签和时间，底部还要加一个类似
 * 横幅通知那样字体滚动显示最新的标签描述和时间，历史标注可折叠」。
 *
 * 两块：
 *   ① 最新一条的**滚动横幅**（标签 / 描述 + 多久之前）：文字超出容器才滚，
 *      复制一份做无缝循环；鼠标悬停暂停，系统开了减少动效就不滚；
 *   ② **历史标注**（默认展开、可折叠）：每条标签 + 描述 + 时间 + 删除。
 *
 * 当前币没有任何标注时整块不渲染（不占 K 线的位置）。
 * 数据来自 `../annotations` 的缓存，保存后由 store 就地更新，这里只负责画。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from 'vue'
import type {SymbolAnnotation} from '../api'
import {
  agoText,
  annotationOf,
  historyOf,
  loadAnnotationHistory,
  removeSymbolAnnotation
} from '../annotations'
import {askConfirm} from '../confirm'
import {bjShort, bjTime} from '../format'
import {showToast} from '../toast'

const props = defineProps<{
  /** 基础币（`BTC`）—— 父组件已经归一过 */
  base: string
}>()

/** 这个币的全部历史（新的在前）；缓存里没有时是空数组 */
const entries = computed<SymbolAnnotation[]>(() => historyOf(props.base))
/** 最新一条：优先历史首条，历史还没到就退回「每个币最新一条」那份缓存 */
const latest = computed<SymbolAnnotation | null>(
  () => entries.value[0] ?? annotationOf(props.base) ?? null
)

/** 历史区展开着没有（默认展开，可折叠） */
const open = ref(true)
/** 正在删的那条 */
const busyId = ref(0)

/* ---------------- 滚动横幅 ---------------- */

const boxEl = ref<HTMLElement | null>(null)
const segEl = ref<HTMLElement | null>(null)
/** 文字比容器宽 → 才滚 */
const scrolling = ref(false)
/** 滚一圈多少秒（按文字宽度算，长句别滚太快） */
const duration = ref(12)

/** 横幅文字：标签 · 描述 · 多久之前（描述里的换行压成空格） */
const liveText = computed(() => {
  const a = latest.value
  if (!a) return ''
  const tags = a.tags.join(' · ')
  const note = a.note.replace(/\s+/g, ' ').trim()
  const head = [tags, note].filter(Boolean).join(' · ')
  return `${head} · ${agoText(a.at)}`
})

function measure(): void {
  const box = boxEl.value
  const seg = segEl.value
  if (!box || !seg) {
    scrolling.value = false
    return
  }
  // +2：亚像素误差不算「放不下」
  const overflow = seg.scrollWidth > box.clientWidth + 2
  scrolling.value = overflow
  if (overflow) {
    // 约 42px/s；最短 8 秒、最长 40 秒，长描述不至于一闪而过
    duration.value = Math.min(40, Math.max(8, Math.round(seg.scrollWidth / 42)))
  }
}

let ro: ResizeObserver | null = null
let observedEl: HTMLElement | null = null

/** 横幅元素首次出现 / 重新出现时绑 ResizeObserver（根节点是 v-if，不能只靠 onMounted） */
function bindObserver(): void {
  const el = boxEl.value
  if (el === observedEl) return
  ro?.disconnect()
  observedEl = el
  if (el && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measure())
    ro.observe(el)
  }
}

watch(
  liveText,
  () => {
    void nextTick(() => {
      bindObserver()
      measure()
    })
  },
  {immediate: true}
)

watch(
  () => props.base,
  base => {
    if (!base) return
    void loadAnnotationHistory(base).catch(e =>
      console.warn(`[标注] 读取 ${base} 的历史失败：${(e as Error).message}`)
    )
  },
  {immediate: true}
)

onMounted(() => {
  bindObserver()
  void nextTick(measure)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  observedEl = null
})

/* ---------------- 删除 ---------------- */

async function remove(entry: SymbolAnnotation): Promise<void> {
  const tags = entry.tags.join(' · ')
  const ok = await askConfirm({
    title: `删掉这条 ${entry.base} 标注？`,
    body: [tags || '（只写了描述）', `${bjShort(entry.at)}`, '删掉之后就找不回来了。'],
    okText: '删除',
    danger: true
  })
  if (!ok) return
  busyId.value = entry.id
  try {
    await removeSymbolAnnotation(entry.id, entry.base)
    showToast('标注已删除', 'ok')
  } catch (e) {
    showToast(`删除标注失败：${(e as Error).message}`, 'bad')
  } finally {
    busyId.value = 0
  }
}
</script>

<template>
  <section v-if="latest" class="ann-strip" aria-label="币种标注">
    <!-- ① 最新一条：类似通知横幅的滚动文字 -->
    <div class="ann-live">
      <span class="ann-live-k">最新</span>
      <div ref="boxEl" class="ann-live-box">
        <div
          class="ann-live-track"
          :class="{run: scrolling}"
          :style="{animationDuration: `${duration}s`}"
        >
          <span ref="segEl" class="ann-live-seg">{{ liveText }}</span>
          <!-- 复制一份做无缝循环；读屏只读第一份 -->
          <span v-if="scrolling" class="ann-live-seg" aria-hidden="true">{{
            liveText
          }}</span>
        </div>
      </div>
    </div>

    <!-- ② 历史标注：默认展开，可折叠 -->
    <button
      v-if="entries.length"
      type="button"
      class="ann-hist-head"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span>历史标注 <b>{{ entries.length }}</b></span>
      <span class="ann-hist-toggle">{{ open ? '收起' : '展开' }}</span>
    </button>

    <ol v-if="open && entries.length" class="ann-list">
      <li v-for="e in entries" :key="e.id" class="ann-item">
        <div class="ann-item-top">
          <span v-for="t in e.tags" :key="t" class="ann-pill">{{ t }}</span>
          <span v-if="!e.tags.length" class="ann-pill ann-only">标注</span>
          <span class="ann-time" :title="bjTime(e.at)"
            >{{ bjShort(e.at) }} · {{ agoText(e.at) }}</span
          >
          <button
            type="button"
            class="ann-del"
            :disabled="busyId === e.id"
            title="删掉这条标注"
            aria-label="删掉这条标注"
            @click="remove(e)"
          >
            ✕
          </button>
        </div>
        <p v-if="e.note" class="ann-note-text">{{ e.note }}</p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.ann-strip {
  flex: 0 0 auto;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  min-width: 0;
}

/* ---------------- 滚动横幅 ---------------- */
.ann-live {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs, 8px);
  background: var(--panel-2);
}
.ann-live-k {
  flex: 0 0 auto;
  padding: 1px 5px;
  border: 1px solid var(--accent-line);
  border-radius: 3px;
  color: var(--accent);
  font-size: 10px;
  line-height: 1.4;
  letter-spacing: 0.08em;
}
.ann-live-box {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}
.ann-live-track {
  display: flex;
  width: max-content;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}
.ann-live-track.run {
  animation: ann-marquee linear infinite;
}
/* 两个一模一样的段各带 40px 尾巴 ⇒ translateX(-50%) 正好是一段的宽度，接缝不跳 */
.ann-live-seg {
  padding-right: 40px;
}
.ann-live-track:not(.run) .ann-live-seg {
  padding-right: 0;
}
@keyframes ann-marquee {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
@media (hover: hover) {
  .ann-live:hover .ann-live-track.run {
    animation-play-state: paused;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ann-live-track.run {
    animation: none;
  }
}

/* ---------------- 历史 ---------------- */
.ann-hist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  margin-top: 6px;
  padding: 4px 2px;
  border: 0;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  cursor: pointer;
}
.ann-hist-head b {
  color: var(--text);
  font-weight: var(--fw-mid, 500);
}
.ann-hist-toggle {
  flex: 0 0 auto;
  color: var(--accent);
}

.ann-list {
  list-style: none;
  margin: 2px 0 0;
  padding: 0;
  max-height: 140px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  /*
   * 历史条目自己滚：标注多了也不会把下面的下单模块顶出屏幕。
   * 滚动条不抢眼：跟全站其他角落一样细。
   */
}
.ann-item {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs, 8px);
  background: var(--panel-2);
}
.ann-item-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.ann-pill {
  flex: 0 0 auto;
  max-width: 100%;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10.5px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ann-pill.ann-only {
  background: var(--panel);
  color: var(--muted);
}
.ann-time {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--muted);
  font-size: 10.5px;
  white-space: nowrap;
}
.ann-del {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
}
@media (hover: hover) {
  .ann-del:hover:not(:disabled) {
    color: var(--bad, #f07178);
    background: var(--panel);
  }
}
.ann-del:disabled {
  opacity: 0.4;
  cursor: default;
}
.ann-note-text {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 窄屏：K 线卡片本身左右 padding 是 0，这里补 8px 跟下单模块对齐 */
@media (max-width: 900px) {
  .ann-strip {
    padding-left: 8px;
    padding-right: 8px;
  }
  .ann-list {
    max-height: 120px;
  }
}
</style>
