/**
 * Android 物理返回键。
 *
 * 不接这个事件的话，Android 上按返回键 = **系统直接退出 App**：
 * 用户刚在「开单分析」里点开，按一下退回桌面，看着就像 App 崩了。
 *
 * 规则（跟绝大多数 App 一致）：
 *   · 还能后退 → 走路由后退
 *   · 已经在落地页（`LANDING_PATH`）→ 再按才真退出
 *
 * ⚠️⚠️ **不 `import` `@capacitor/*`** —— 这是仓库既有约定（见 `platform.ts` 顶部）：
 *   ① 那些包在 `devDependencies` 里（生产镜像只装 prod 依赖，见 `Dockerfile`）；
 *   ② `platform.ts` / `router.ts` 一直是「走 `window.Capacitor` 全局对象」这套。
 *   所以这里也从全局取插件；拿不到就整个函数空操作 —— **Web 上永远走不到**。
 *
 * 想要更花哨的行为（比如「连按两次才退出」+ 一句 Toast）先别改这里：
 * 双击退出在纯网页壳上很容易让人以为「按键没反应」，等真机用一阵再说。
 */

import type {Router} from 'vue-router'
import {isNativeShell} from './platform'
import {LANDING_PATH} from './router'

/**
 * Capacitor App 插件里我们用到的那一小块 —— 手写声明，
 * 免得为了几个类型把 `@capacitor/app` 引进来（它会让前端 bundle 多一个依赖）。
 */
interface CapApp {
  addListener: (
    event: 'backButton',
    cb: (data?: {canGoBack?: boolean}) => void
  ) => void
  exitApp?: () => void
}

interface CapGlobal {
  Plugins?: {App?: CapApp}
}

/**
 * 挂上返回键处理。**只在原生壳（Android / iOS App）里生效**，Web 上直接 return。
 *
 * @param router 用来后退。要在 `main.ts` 里 `createApp(...).use(router)` **之后**调，
 *   否则 `router.back()` 还没有历史可退。
 */
export function setupAndroidBack(router: Router): void {
  if (!isNativeShell()) return

  const App = (globalThis as unknown as {Capacitor?: CapGlobal}).Capacitor
    ?.Plugins?.App
  // 插件没装 / 全局对象没注入 → 什么都不做（保持系统默认行为）
  if (!App?.addListener) return

  App.addListener('backButton', ev => {
    /*
     * 优先用插件给的 `canGoBack` —— 那是 Android 侧量的 WebView **真实历史**，
     * 比「在不在落地页」准（比如从「开单分析」点回「合约」时，虽然人在落地页，
     * 但历史上还有上一条，这时该后退而不是退出）。
     *
     * 老版本插件不给这个字段，就退回自己判断：不在落地页 = 有得退。
     */
    const canGoBack =
      ev?.canGoBack ?? router.currentRoute.value.path !== LANDING_PATH

    if (canGoBack) router.back()
    else App.exitApp?.()
  })
}
