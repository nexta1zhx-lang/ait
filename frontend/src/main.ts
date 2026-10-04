import {createApp} from 'vue'
import App from './App.vue'
import {router} from './router'
import {setupAndroidBack} from './back-button'
import {setupNativeShell} from './native'
import {isNativeShell} from './platform'
/*
 * 自托管字体（Noto Sans SC）—— ⚠️ 必须在 `style.css` **之前** import，
 * 否则它自己的 `@font-face` 会排在后面，`--font-sans` 里的回退顺序就乱了。
 * 文件是脚本生成的，不要手改；见 `frontend/src/fonts.css` 顶部。
 */
import './fonts.css'
import './style.css'

const app = createApp(App).use(router)

/*
 * 原生壳（Android / iOS App）接线：状态栏 + 前后台状态（`native.ts`）。
 * Web 上是空操作。必须在 `use(router)` 之后 —— 里面的返回键要用 router 后退。
 */
setupNativeShell()

/*
 * 返回键**单独挂**（要用 router），见 `back-button.ts`。
 * 不接的话 Android 上按一下就直接退出 App，看着像崩了。
 * ⚠️ 别再往 `native.ts` 里加一份 —— 一个键被处理两遍会后退两次 / 直接退出。
 */
setupAndroidBack(router)

/*
 * 触屏专属的收尾：**长按不弹系统菜单 + 冲掉粘滞 hover**。
 *
 * 判据：**原生壳**，或者**主指针是粗指针**（手机 / 平板）。
 *
 * ⚠️⚠️ **不能只看 `(hover: none)`**：部分 Android WebView / ROM 会把
 * `(hover: hover)` 误报成 true —— 后果有两个（用户 2026-10-05 都报了）：
 *   ① `:hover` 粘在手指点过的地方（滑动切 tab 后，原来那格留一块底色）；
 *   ② `@media (hover: none)` 那段「禁止长按选字」根本不生效 → 长按能拖选文字。
 * 所以这里自己判、给 `<html>` 加个 `touch` 类，
 * 样式（`style.css`）以这个类为准，不再只依赖媒体查询。
 */
const coarsePointer =
  window.matchMedia?.('(pointer: coarse)').matches === true ||
  (navigator.maxTouchPoints ?? 0) > 0
if (isNativeShell() || coarsePointer) {
  document.documentElement.classList.add('touch')
  // 长按**链接**（导航 / 历史明细行都是 `<a>`）不弹「打开 / 复制链接 / 选词」
  window.addEventListener('contextmenu', e => e.preventDefault())
  /*
   * 粘滞 hover：手指点过的地方 `:hover` 会一直留着（直到点别处）——
   * 看着就像「那一格被选中了 / 多了一块背景」。抬手时把 pointer-events
   * 关一下再打开，强制浏览器重算 `:hover`，把粘住的态冲掉。
   *
   * ⚠️⚠️ **必须同步恢复**（不能挪到 `requestAnimationFrame` 里，曾经就是这么写的）：
   * 浏览器是在 `touchend` 之后紧接着派发 `click` 的，如果那一刻
   * `pointer-events: none` 还挂在被点的元素上，命中测试就落不到它身上 ——
   * 行情表那一行的 `@click`（`<tr>` 上的）收不到事件，
   * 用户看到的就是「**轻点币种有时候没反应**」（点到 `<td>` 里哪一格决定中不中）。
   * 中间那次读 `offsetWidth` 是**强制同步重算**，保证「关 → 开」真的生效，
   * 又不会把这段状态拖过 `click` 那一瞬间。
   */
  document.addEventListener(
    'touchend',
    e => {
      const el = e.target as HTMLElement | null
      if (!el || !el.style) return
      el.style.pointerEvents = 'none'
      void el.offsetWidth
      el.style.pointerEvents = ''
    },
    {passive: true, capture: true}
  )
}

app.mount('#app')
