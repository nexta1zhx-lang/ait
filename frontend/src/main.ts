import {createApp} from 'vue'
import App from './App.vue'
import {router} from './router'
import {setupAndroidBack} from './back-button'
/*
 * 自托管字体（Noto Sans SC）—— ⚠️ 必须在 `style.css` **之前** import，
 * 否则它自己的 `@font-face` 会排在后面，`--font-sans` 里的回退顺序就乱了。
 * 文件是脚本生成的，不要手改；见 `frontend/src/fonts.css` 顶部。
 */
import './fonts.css'
import './style.css'

const app = createApp(App).use(router)

/*
 * Android 物理返回键：**不接的话按一下就直接退出 App**（看着像崩了）。
 * 只在原生壳里生效，Web 上是空操作 —— 详情见 `back-button.ts`。
 */
setupAndroidBack(router)

app.mount('#app')
