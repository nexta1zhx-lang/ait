/**
 * 一级 tab 的「左右滑动切换」（**只给窄屏用**）。
 *
 * 用户 2026-10-04：「一级 tab（底下一小段线那种）可滑动切换」。
 *
 * ⚠️ 这东西 **2026-10-03 已经实现过一次**（commit `d23c376`，当时直接内联在
 *    `AnalyzeView.vue` 里），后来在 `9cae7c1 保存工作区` 那次大快照里被整块覆盖掉，
 *    只剩一处分节注释 —— 所以这次抽成独立模块：两页共用，也不容易被顺带覆盖。
 *
 * 手感是照当时实测调好的那套来的，别随手改（改之前先看下面每条「为什么」）：
 *   · 横向 ≥52px，且 ≥ 纵向的 1.3 倍 —— 斜着划多半是想上下滚内容
 *   · **抬手才切** —— 划到一半就切的话，内容在手指底下换掉，人会以为划错了
 *   · 够远就「认定」（`fired`），之后手指再飘也不取消 —— 不然划到一半往上一提
 *     就当没发生过，手感很飘
 *   · 只在窄屏生效，桌面端一点不受影响
 *
 * 当年实测（390px 窄屏、合成 Touch 事件）：
 *   合约行情 —左滑→ K 线 —左滑→ 实时分析 —右滑→ K 线 ✓
 *   竖向划 / 只划 20px / 在搜索框上划 / 在 K 线画布上划 → 都不切 ✓
 */

/** 滑多远才算「切一下」（px）—— 太小会跟「点一下」抢，太大手腕划不动 */
const SWIPE_MIN = 52
/** 横向位移得是纵向的这么多倍 —— 斜着划多半是想上下滚内容 */
const SWIPE_DOMINANCE = 1.3

/** 跟 CSS 的 `@media (max-width: 900px)`、`analyze.ts` 的 `MOBILE_MAX` 对齐 */
const MOBILE_QUERY = '(max-width: 900px)'

/**
 * 手势区里**自己在用横向手势**的东西，一律不抢：
 *
 *  · 输入框 / 可编辑区：手指横划是在选文字、挪光标（不是切 tab）
 *  · `[data-no-swipe]`：留给以后要自己吃横向手势的组件（图上画范围那种）
 *  · **自己能横向滚的元素**：那是滚动，不是切 tab ——
 *    「我的」那排一级 tab（`me-tabs`）、宽表格、下拉列表全靠这一条挡下来。
 *    ⚠️ 判据必须是「`overflow-x` 是 auto/scroll **并且真滚得动**」：
 *    只判 `overflow-x: auto` 会误伤「设了 auto 但其实放得下」的容器
 *    （那种情况下用户横划就是想切 tab）。
 */
function ownsHorizontal(from: EventTarget | null, host: HTMLElement): boolean {
  for (
    let n = from as HTMLElement | null;
    n && n !== host;
    n = n.parentElement
  ) {
    if (!(n instanceof HTMLElement)) break
    if (
      n.matches('input, textarea, select, [contenteditable], [data-no-swipe]')
    )
      return true
    const ox = getComputedStyle(n).overflowX
    if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 4)
      return true
  }
  return false
}

export interface SwipeTabsOptions<T extends string> {
  /**
   * 手势区根元素（就是模板里挂 `ref` 的那个）。
   *
   * ⚠️ 开单分析页**必须挂在左边那栏 `.col`**，不能挂 `.split`：
   *    右边那栏是 K 线（`aside.col.side`），图上横划是**拖动图表看历史行情**，
   *    挂到 `.split` 上会把那个手势抢走。
   */
  host: () => HTMLElement | null
  /** tab 的顺序 —— 按它挪一格 */
  list: () => readonly {value: T}[]
  /** 当前在哪一格 */
  current: () => T
  /** 切过去 */
  set: (v: T) => void
}

/**
 * 返回三个触摸事件处理器，直接绑在 `host` 那个元素上（**带 `.passive`**，
 * 我们从头到尾不 `preventDefault`，不去干扰原生滚动）。
 */
export function useSwipeTabs<T extends string>(
  o: SwipeTabsOptions<T>
): {
  onTouchStart: (e: TouchEvent) => void
  onTouchMove: (e: TouchEvent) => void
  onTouchEnd: () => void
} {
  let s: {x: number; y: number; dx: number; dy: number; fired: boolean} | null =
    null

  function onTouchStart(e: TouchEvent): void {
    s = null
    const host = o.host()
    if (!host || e.touches.length !== 1) return
    if (!window.matchMedia(MOBILE_QUERY).matches) return
    if (ownsHorizontal(e.target, host)) return
    const t = e.touches[0]
    if (!t) return
    s = {x: t.clientX, y: t.clientY, dx: 0, dy: 0, fired: false}
  }

  function onTouchMove(e: TouchEvent): void {
    if (!s || e.touches.length !== 1) return
    const t = e.touches[0]
    if (!t) return
    s.dx = t.clientX - s.x
    s.dy = t.clientY - s.y
    if (
      !s.fired &&
      Math.abs(s.dx) >= SWIPE_MIN &&
      Math.abs(s.dx) >= Math.abs(s.dy) * SWIPE_DOMINANCE
    ) {
      s.fired = true
    }
  }

  /** 抬手（或手势被系统打断）才真切 */
  function onTouchEnd(): void {
    const cur = s
    s = null
    if (!cur?.fired) return
    const list = o.list()
    const i = list.findIndex(t => t.value === o.current())
    // 往左划 = 看右边那一格（跟翻页同一个方向）；已经在头 / 尾就不动
    const next = i >= 0 ? list[i + (cur.dx < 0 ? 1 : -1)] : undefined
    if (next) o.set(next.value)
  }

  return {onTouchStart, onTouchMove, onTouchEnd}
}
