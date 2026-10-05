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

/**
 * App 外壳底色 —— 状态栏 / 导航栏 / 窗底 / WebView 底都用它。
 *
 * ⚠️ 它等于**前端窄屏（≤900px）的页面主背景**（`style.css` 窄屏那段的 `--panel`，
 *    #121316），**不是**深色那档 `--bg`（#08090b）—— 手机上看到的主背景就是前者。
 *    用户 2026-10-04：「顶部状态栏和底部小白条区域和主背景色一样」。
 *    改色时四处一起改：这里 · `capacitor.config.json`（两个字段）·
 *    `values/colors.xml` 的 `app_shell` · `frontend/index.html` 的 `theme-color`。
 */
export const APP_SHELL_BG = '#121316'

/** Capacitor App 插件里我们用到的那一小块 */
interface CapApp {
  addListener: (
    event: 'appStateChange',
    cb: (state: {isActive: boolean}) => void
  ) => void
  getState?: () => Promise<{isActive: boolean}>
  /** APK 自己的版本号（versionName / versionCode），不是前端版本 */
  getInfo?: () => Promise<{
    name: string
    id: string
    version: string
    build: string
    platform: string
  }>
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
    safe(StatusBar?.setBackgroundColor?.({color: APP_SHELL_BG}))
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

  // 系统栏那条颜色（`paintStatusBar`）只在这里和 `main.ts` 里管；别在别处再调。
}

/* ------------------------------------------------------------------
   「体检单」：排查系统栏 / 安全区问题时用
   （显示在「我的 → 个人信息 → 账户信息」底部，见 `ProfileView.vue`）
   ------------------------------------------------------------------ */

/**
 * 原生壳的体检报告。
 *
 * 用户 2026-10-05：「安全区的主题色还是不对，不是我背景的黑色」——
 * 这个问题**只有原生壳里才有**（网页版没有系统栏），而且成因横跨
 * 「装了哪一版 APK」/「WebView 版本」/「系统给的 insets 是多少」三层，
 * 光看截图分不出来。所以把这几项摆到页面上，一眼定位。
 *
 * ⚠️ 特别提醒 `version`：我们用了 `server.url` 远程加载（见 `capacitor.config.json`），
 *    **前端永远是线上最新版，而原生壳可能还是几个月前装的那个** ——
 *    每次「改了原生代码但看起来没生效」，先看这一项。
 */
export interface ShellInfo {
  /** APK 的 versionName（如 0.2.7）。前端是远程加载的，所以这个才是「壳」的版本 */
  version: string
  /** APK 的 versionCode（如 207） */
  build: string
  platform: string
  /**
   * Android System WebView 主版本号。
   * ★ **≥140** 时 Capacitor 的 `SystemBars` 才会让 WebView 真铺满整屏
   *   （状态栏透明 → 透出页面背景）；<140 会退化成「给 decor 加内边距」，
   *   那时状态栏背后是 **decor 底色**（由 `MainActivity` 负责钉成 #121316）。
   */
  webview: string
  /** 实测 `env(safe-area-inset-top)`，px —— 有值说明系统真给了安全区 */
  envTop: number
  envBottom: number
  /** `SystemBars` 注入的自定义属性（铺满那条路才有）；没注入就是空 */
  cssTop: string
  cssBottom: string
  /** 系统是否深色模式（影响状态栏图标该亮还是该暗） */
  dark: boolean
}

/** 量一个方向的 `env(safe-area-inset-*)`：造个零宽元素读它的高度 */
function measureInset(side: 'top' | 'bottom'): number {
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;' +
    `height:env(safe-area-inset-${side},0px)`
  document.body.appendChild(el)
  const h = el.getBoundingClientRect().height
  el.remove()
  return Math.round(h * 100) / 100
}

/** 取体检报告；非原生壳（网页版）返回 `null` */
export async function shellInfo(): Promise<ShellInfo | null> {
  if (!isNativeShell()) return null

  const cap = (globalThis as unknown as {Capacitor?: CapGlobal}).Capacitor
  const App = cap?.Plugins?.App

  // 版本号拿不到不该让整块板子空掉，逐项 try
  let version = ''
  let build = ''
  let platform = 'android'
  try {
    const i = await App?.getInfo?.()
    if (i) {
      version = i.version
      build = i.build
      platform = i.platform
    }
  } catch {
    /* 插件没注册 / 老壳没这个方法 —— 留空即可 */
  }

  // Android System WebView 的 UA 里有 `Chrome/<主版本>.<...>`；取主版本就够判断 ≥140
  const chrome = /Chrome\/(\d+)/.exec(navigator.userAgent)

  const cs = getComputedStyle(document.documentElement)

  return {
    version: version || '(取不到)',
    build: build || '-',
    platform,
    webview: chrome ? chrome[1] : '(取不到)',
    envTop: measureInset('top'),
    envBottom: measureInset('bottom'),
    cssTop: cs.getPropertyValue('--safe-area-inset-top').trim(),
    cssBottom: cs.getPropertyValue('--safe-area-inset-bottom').trim(),
    dark:
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-color-scheme: dark)').matches
  }
}
