/**
 * 「现在到底在不在前台」—— 把**浏览器标签页**和**原生壳**的前后台状态
 * 并成**一个信号**，全站只认这一个。
 *
 * 为什么要单独抽一层（两个来源都不能单独信）：
 *
 *   · **Web**：只有 `document.visibilitychange`。切标签 / 切窗口都很准。
 *   · **原生壳（Android / iOS）**：切后台 / 锁屏时 WebView 被系统挂起，这里两头
 *     都可能不准 ——
 *       ① 部分机型 / 内核**不补发** `visibilitychange`，切回来也不知道；
 *       ② 另一些在 `onPause` 时把 visibility 置成 hidden，**回前台却不置回来**，
 *          `document.hidden` 就永久卡在 true。
 *
 * 所以**不能两个条件取与**（只要有一个卡住，信号就永远回不来），
 * 得让**原生壳说了算** —— 见 `isForeground()`。
 *
 * K 线推送、行情推送都盯着这个信号决定「断开省流量」还是「重连 + 补数据」。
 *
 * ⚠️ 这个文件**不能 `import` `@capacitor/*`**：它连 Web 首屏都会加载，而那些包
 *    在 `devDependencies` 里（生产镜像 `npm ci --omit=dev` 根本不装）。原生那边
 *    只有 `native.ts` 能动插件，动完把结果灌进 `setNativeActive()`。
 */
import {ref, watch} from 'vue'

/**
 * 原生壳报上来的前后台状态。
 *
 * `null` = **原生壳还没报过**（Web 上永远是 null，只看 `document.hidden`）。
 * 一旦报过就由它说了算，理由见 `isForeground()`。
 */
const nativeActive = ref<boolean | null>(null)

/** 原生侧调用：接 Capacitor 的 `appStateChange`（在 `native.ts` 里） */
export function setNativeActive(v: boolean): void {
  nativeActive.value = v
}

/**
 * 此刻在前台吗。
 *
 * 优先级：**原生壳报过 → 完全听它的**；没报过（Web）→ 看 `document.hidden`。
 *
 * 为什么不两个都看：见文件头 ① ② —— 两个来源里任何一个卡住，`&&` 出来的结果
 * 就永远回不到 true，表现就是「切后台再回来，行情再也不动了」，而且刷新都没用
 * （得杀进程重开）。原生壳那边是系统直接告诉我们的，比 WebView 的 visibility 可信。
 */
export function isForeground(): boolean {
  if (nativeActive.value !== null) return nativeActive.value
  return !document.hidden
}

/**
 * 订阅「前后台翻转」，**只在状态真的变了**时回调一次。
 *
 * 去抖是必要的：原生壳和 `visibilitychange` 会先后报同一件事
 * （例如切后台时系统先发 `appStateChange` 再发 `visibilitychange`），
 * 不去抖就会把「断开」执行两遍、回来时「重连 + 补数据」执行两遍。
 *
 * 返回取消函数；组件卸载 / 流关闭时必须调，否则监听会一直挂着。
 */
export function onForegroundChange(cb: (active: boolean) => void): () => void {
  let last = isForeground()
  const fire = (): void => {
    const now = isForeground()
    if (now === last) return
    last = now
    cb(now)
  }
  document.addEventListener('visibilitychange', fire)
  const stopWatch = watch(nativeActive, fire)
  return () => {
    document.removeEventListener('visibilitychange', fire)
    stopWatch()
  }
}
