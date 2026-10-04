/**
 * 原生壳（Android / iOS App）专属接线 —— 就两件事：
 *
 *   1. **前后台状态**：接 Capacitor 的 `appStateChange`，灌给 `live.ts`，
 *      好让 K 线 / 行情推送知道「该断开省电」还是「该重连 + 补数据」；
 *   2. **状态栏**：让状态栏的图标保持浅色（深色界面下黑图标看不见）。
 *
 * 返回键**不在这里**，在 `back-button.ts`（它要用 `router` 后退）。
 * **别两处都接** —— 那样按一下会被处理两遍（后退两次 / 直接退出）。
 *
 * ⚠️⚠️ 跟 `back-button.ts` 同一个约定：**不 `import` `@capacitor/*`**。
 *    ① 那些包在 `devDependencies` 里，生产镜像是 `npm ci --omit=dev`（见 `Dockerfile`），
 *       静态 import 会让 Web 打包直接失败；
 *    ② `platform.ts` / `back-button.ts` 一直是「从 `window.Capacitor` 全局对象上取插件」
 *       这套写法，这里保持一致。
 *    所以插件相关的类型都**手写一小块**，别为了几个类型把包引进来。
 */
import {isNativeShell} from './platform'
import {setNativeActive} from './live'

/** 应用主背景 —— 跟 `style.css` 里的 `--bg` 保持一致（改色时两处一起改） */
export const APP_BG = '#08090b'

/** Capacitor App 插件里我们用到的那一小块 */
interface CapApp {
  addListener: (
    event: 'appStateChange',
    cb: (state: {isActive: boolean}) => void
  ) => void
  getState?: () => Promise<{isActive: boolean}>
}

/** Capacitor StatusBar 插件里我们用到的那一小块 */
interface CapStatusBar {
  setStyle: (o: {style: 'DARK' | 'LIGHT' | 'DEFAULT'}) => Promise<void>
  setBackgroundColor?: (o: {color: string}) => Promise<void>
}

interface CapGlobal {
  Plugins?: {App?: CapApp; StatusBar?: CapStatusBar}
}

/** 插件调用一律「失败就算了」：状态栏调不动不该影响主流程 */
function safe(p: Promise<void> | undefined): void {
  p?.catch(() => {})
}

/**
 * 挂上原生壳接线。**只在原生壳里生效**，Web 上直接 return（零副作用）。
 *
 * 要在 `main.ts` 里 `createApp(...)` 之后调（返回键那部分依赖已安装的 router）。
 */
export function setupNativeShell(): void {
  if (!isNativeShell()) return

  const cap = (globalThis as unknown as {Capacitor?: CapGlobal}).Capacitor
  const App = cap?.Plugins?.App
  const StatusBar = cap?.Plugins?.StatusBar

  /*
   * 状态栏：**深底浅字**。
   *
   * ⚠️ `capacitor.config.json` 里已经配了一份同样的，为什么代码里还要再来一次：
   *    ① 那份配置只在 **App 冷启动**时生效。部分 ROM 在切后台回来后会把
   *       `isAppearanceLightStatusBars` 重置，状态栏图标就变回黑的 ——
   *       深色背景上直接看不见。所以每次回前台补一次。
   *    ② 我们 `targetSdkVersion = 36`（见 `android/variables.gradle`），
   *       Android 15+ **强制 edge-to-edge**：状态栏是透明的，底色由 **WebView
   *       自己的内容**透出来（页面顶部有 `--safe-top` 垫着，见 `style.css`），
   *       插件那个 `backgroundColor` 选项在 15+ 上已经失效。所以这边只需要
   *       管住「图标是浅色」这一件事，底色交给页面自己。
   *
   * ⚠️ `Style.DARK` 的名字很有迷惑性：在 Capacitor 里的定义是
   *    **Light text for dark backgrounds**（Android 侧实现就是
   *    `setAppearanceLightStatusBars(false)`）。深色 App 用 `DARK` 是对的，
   *    别改成 `LIGHT`。
   */
  const paintStatusBar = (): void => {
    safe(StatusBar?.setStyle({style: 'DARK'}))
    // Android 15 以下还能设底色（15+ 会被系统忽略，不报错）
    safe(StatusBar?.setBackgroundColor?.({color: APP_BG}))
  }
  paintStatusBar()

  if (!App?.addListener) return

  App.addListener('appStateChange', ({isActive}) => {
    setNativeActive(isActive)
    // 回前台顺手再刷一次状态栏（见上面 ①）
    if (isActive) paintStatusBar()
  })

  /*
   * 冷启动时先问一次当前状态 —— 别干等系统推第一次变化：
   * 万一 App 是**在后台被拉起**的（推送唤醒之类），先问一句才不会误判成前台。
   */
  const st = App.getState?.()
  if (st) void st.then(s => setNativeActive(s.isActive)).catch(() => {})
}
