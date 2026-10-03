/**
 * 运行环境判断：**Web 浏览器** 还是 **原生壳（Android / iOS app）**。
 *
 * 打包成 App 后，页面不再跑在 `bitcoooin.cn` 上，而是跑在 WebView 的本地
 * scheme 下：
 *
 *   Android（`androidScheme` 默认 https） → `https://localhost/`
 *   iOS（`iosScheme` 默认 capacitor）     → `capacitor://localhost/`
 *
 * 这两种情况下：
 *   1. `/api/...` 这类**相对路径会打到 WebView 自己身上**，必须换成绝对地址
 *      （见 `api.ts` 的 `API_BASE`）；
 *   2. 没有后端做 SPA 回退，`history` 路由刷新会 404，要换成 `hash`
 *      （见 `router.ts`）。
 *
 * 线上（`bitcoooin.cn`）和本地开发（`http://localhost:5173`）都不会命中，
 * 所以这些判断在 Web 上恒为 false，不影响现有行为。
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

/** Capacitor 原生壳会往 window 注入 `Capacitor`，优先用它（比猜 URL 准） */
function capGlobal(): CapacitorGlobal | undefined {
  return (globalThis as unknown as {Capacitor?: CapacitorGlobal}).Capacitor
}

/** 是不是在原生壳里跑 */
export function isNativeShell(): boolean {
  const cap = capGlobal()
  if (typeof cap?.isNativePlatform === 'function') {
    return cap.isNativePlatform()
  }
  // 兜底：没注入全局对象时按 URL 判断
  const {protocol, hostname} = location
  if (protocol === 'capacitor:') return true
  return protocol === 'https:' && hostname === 'localhost'
}

/** 原生平台名（Web 上恒为 'web'） */
export function shellPlatform(): 'android' | 'ios' | 'web' {
  const cap = capGlobal()
  const p = typeof cap?.getPlatform === 'function' ? cap.getPlatform() : ''
  if (p === 'android' || p === 'ios') return p
  if (!isNativeShell()) return 'web'
  // 认不出具体是哪个就当 Android（它用的是 https://localhost）
  return location.protocol === 'capacitor:' ? 'ios' : 'android'
}
