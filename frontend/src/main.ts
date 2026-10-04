import {createApp} from 'vue'
import App from './App.vue'
import {router} from './router'
/*
 * 自托管字体（Noto Sans SC）—— ⚠️ 必须在 `style.css` **之前** import，
 * 否则它自己的 `@font-face` 会排在后面，`--font-sans` 里的回退顺序就乱了。
 * 文件是脚本生成的，不要手改；见 `frontend/src/fonts.css` 顶部。
 */
import './fonts.css'
import './style.css'

createApp(App).use(router).mount('#app')
