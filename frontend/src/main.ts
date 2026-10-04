import {createApp} from 'vue'
import App from './App.vue'
import {router} from './router'
import {setupAndroidBack} from './back-button'
import {setupNativeShell} from './native'
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
 * 触屏专属的收尾：**长按不要弹系统菜单**。
 *
 * 用户 2026-10-04：「长按不需要出现选中文字效果」。
 * 文字本身已经在 `style.css` 里做成不可选（`@media (hover: none)` 那一段），
 * 但长按**链接**（导航、历史明细行都是 `<a>`）时 Android WebView 照样会弹一个
 * 系统菜单（打开 / 复制链接 / 选词），看着就不是原生 App。所以这里一并挡掉。
 *
 * ⚠️ 只在 `hover: none`（没有真正的指针）时挂 —— PC 上的右键菜单不能动。
 * ⚠️ 项目里**没有**自己实现的右键菜单（`grep contextmenu` 是空的），所以挡掉不亏；
 *    以后真要加自定义右键菜单，记得把这里改成「只挡链接」之类的条件。
 */
if (window.matchMedia('(hover: none)').matches) {
  window.addEventListener('contextmenu', e => e.preventDefault())
}

app.mount('#app')
