/**
 * 移动端「下拉刷新」（2026-10-06，用户要求）。
 *
 * ## 为什么要有它
 *
 * 用户定的口径是「**只有没数据才请求**」：在线的实时性靠 WS 推送 + 本地标记价重算，
 * 后端那几路 REST 对账都降频了（成交 5 分钟 / 挂单 10 分钟 / 快照 5 分钟）。
 * 那么「我觉得数字不对」这一条路就必须**又顺又快** —— 手机上最自然的就是**下拉**：
 *
 *   > 用户原话：「用户感觉不对可以刷新页面，移动端做下滑刷新」
 *
 * 所以它不是「多一个刷新的入口」，而是**降频的前提**：因为给得手动兜底，
 * 才敢把后台的自动请求砍下来。
 *
 * ## 行为
 *
 * · 只在**页面已经在顶部**（最近的滚动容器 `scrollTop === 0`）时才接管，
 *   内部那些自己滚的列表（`.tabs-body`）滚到一半时不受影响；
 * · 下拉有**阻尼**（拖动距离 ×0.5，最多 80px），松手过阈值才触发；
 * · 触发后走 `onRefresh()`，**它没结束就不接受新的下拉**（避免连点/连拉）；
 * · **不 `preventDefault`** —— 不跟系统的回弹/侧滑抢手势，纯显示一个指示条，
 *   兼容性上最稳（这块是体验件，不该为它冒手势冲突的风险）。
 */

import {ref, type Ref} from 'vue'

/** 触发刷新的下拉距离（px，阻尼后的值） */
const THRESHOLD = 54
/** 阻尼后最多显示多少 px */
const MAX = 80
/** 拖动距离 → 显示距离 的阻尼系数 */
const DAMP = 0.5
/** 「刷新中」至少显示这么久（不然一闪而过像没反应） */
const MIN_SPIN_MS = 420

export type PullState = 'idle' | 'pull' | 'ready' | 'busy'

export interface PullRefresh {
  /** 指示条要偏移多少 px（0 = 藏起来） */
  pull: Ref<number>
  state: Ref<PullState>
  onTouchStart: (e: TouchEvent) => void
  onTouchMove: (e: TouchEvent) => void
  onTouchEnd: () => void
}

/** 往上找最近的「真的能滚」的祖先；找不到说明整页都不滚，那就永远算在顶部 */
function scrollerOf(el: EventTarget | null): HTMLElement | null {
  let node = el instanceof HTMLElement ? el.parentElement : null
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const oy = getComputedStyle(node).overflowY
      if (oy === 'auto' || oy === 'scroll') return node
    }
    node = node.parentElement
  }
  return null
}

export function usePullRefresh(onRefresh: () => unknown): PullRefresh {
  const pull = ref(0)
  const state = ref<PullState>('idle')
  let startY = 0
  let tracking = false

  const reset = () => {
    tracking = false
    pull.value = 0
    state.value = 'idle'
  }

  return {
    pull,
    state,
    onTouchStart: e => {
      if (state.value === 'busy') return
      /* 多指（缩放/双指）不参与 */
      if (e.touches.length !== 1) return reset()
      const sc = scrollerOf(e.target)
      /* 内容滚到一半时下拉 = 正常滚动，别抢 */
      if (sc && sc.scrollTop > 0) return reset()
      startY = e.touches[0]!.clientY
      tracking = true
      state.value = 'pull'
    },
    onTouchMove: e => {
      if (!tracking || state.value === 'busy') return
      if (e.touches.length !== 1) return reset()
      const dy = e.touches[0]!.clientY - startY
      if (dy <= 0) {
        /* 往上滑 = 用户在正常滚页面，直接让位 */
        return reset()
      }
      pull.value = Math.min(dy * DAMP, MAX)
      state.value = pull.value >= THRESHOLD ? 'ready' : 'pull'
    },
    onTouchEnd: () => {
      if (state.value === 'busy') return
      const fire = state.value === 'ready'
      tracking = false
      if (!fire) return reset()
      state.value = 'busy'
      pull.value = THRESHOLD
      const t0 = Date.now()
      Promise.resolve()
        .then(onRefresh)
        .catch(() => undefined)
        .then(() => {
          const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - t0))
          setTimeout(reset, wait)
        })
    }
  }
}
