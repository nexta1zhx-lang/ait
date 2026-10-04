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

app.mount('#app')
