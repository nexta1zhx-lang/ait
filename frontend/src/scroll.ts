/**
 * 页面内的滚动位置记忆 —— 只给**被 `<KeepAlive>` 缓存的那几页**用。
 *
 * 为什么需要：路由带 `KeepAlive` 之后组件不再重建（搜索词 / 筛选 / 图表实例全在），
 * 但 KeepAlive 停用一个组件时，会把它的 DOM 整棵**摘出文档**放进一个游离容器，
 * 再插回来时 `scrollTop` 已经归零 —— 表现就是「切回来列表又跳回顶部了」。
 *
 * 做法：
 *  · 记录挂在**元素本身**上（`WeakMap`）—— 只要 DOM 没换，位置就跟着它走；
 *  · 监听挂在 `document` 的**捕获阶段** —— `scroll` 事件不冒泡，只有捕获才收得到
 *    内层容器的滚动；这样也不用一个个去 find「哪个才是滚动容器」
 *    （行情表 / 左栏 / 抽屉都是动态的）。
 *
 * ⚠️ 不能在 `onDeactivated` 里现读 `scrollTop`：那时候 DOM 已经被摘走了，读到的
 *    多半是 0（Vue 是先 `move()` 再调 deactivated 钩子）。必须趁滚动的时候顺手记下来。
 */
import {onActivated, onDeactivated} from 'vue'

/** 元素 → 最后一次滚到的位置（元素被回收记录也跟着没，不会泄漏） */
const tops = new WeakMap<Element, number>()

export function useScrollMemory(
  getRoot: () => HTMLElement | null | undefined
): void {
  /** 本页自己的「整页滚动」位置 —— 每页一份闭包，不会互相串 */
  let winTop = 0

  function onScroll(e: Event): void {
    const t = e.target
    if (t instanceof HTMLElement) {
      tops.set(t, t.scrollTop)
      return
    }
    // 整页滚动时 target 是 document
    winTop = window.scrollY
  }

  function apply(): void {
    if (winTop) window.scrollTo(0, winTop)
    const root = getRoot()
    if (!root) return
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const top = tops.get(el)
      if (top) el.scrollTop = top
    }
  }

  function restore(): void {
    // 先同步写一次（DOM 在 activated 钩子之前就已经插回来了）；
    // 再补一帧 —— 万一这一帧布局还没稳，写进去会被随后的一次布局重置。
    apply()
    requestAnimationFrame(apply)
  }

  onActivated(() => {
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true
    })
    restore()
  })

  onDeactivated(() => {
    document.removeEventListener('scroll', onScroll, {capture: true})
  })
}
