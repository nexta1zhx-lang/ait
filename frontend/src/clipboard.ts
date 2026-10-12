/**
 * 复制文本到剪贴板（2026-10-13）。
 *
 * 三处地方各写了一遍同样的代码（分享弹层 / 代理订阅 / 远程桌面），而且三处
 * **都有同一个坑**：只判断了「有没有 `navigator.clipboard`」，没有管它会不会**拒绝**。
 *
 * ★ 用户 2026-10-13 在装机版 App 上报：「复制…在移动端 app 不生效」。
 *   根因就在这儿：Capacitor 的安卓 WebView 里 `navigator.clipboard.writeText`
 *   **存在、但会 reject**（`NotAllowedError: Write permission denied` —— 那一侧
 *   没人去响应 WebView 的 `onPermissionRequest` 里 `clipboard-write` 这项权限）。
 *   于是老代码走到了 `else` 的**反面**：`if` 命中 → 抛异常 → `catch` 里弹「复制失败」，
 *   真正的退路（`execCommand`）压根没执行过；用户看到的就是「点了没反应 / 复制失败」。
 *
 * 所以这里的顺序是「**先试新的，失败就老实退回老的**」，而不是二选一：
 *   ① `navigator.clipboard.writeText`：桌面浏览器 / https 手机浏览器的主路；
 *   ② 老的 `textarea` + `document.execCommand('copy')`：WebView / 非安全上下文的退路。
 *
 * ⚠️ ①要加**超时兜底**（600ms）：个别 WebView 里那个 promise 既不 resolve 也不 reject，
 *    干等就等于「点了没反应」。超时了照样落 ②，而这个时间窗内用户手势（transient
 *    activation，Chrome 给 5 秒）还在，`execCommand('copy')` 仍算「用户触发」。
 * ⚠️ ②用完必须把 `textarea` 摘掉、并且**把焦点还给用户原来的选区**：
 *    安卓上 focus 一个 `textarea` 会弹软键盘，所以给 `readonly`（不给它输入能力）
 *    并且用 `position: fixed` 钉住，别让页面跟着滚。
 * ⚠️ 别用 `navigator.clipboard.writeText` 包在 `try` 里却当成「一定成功」——它成功时
 *    也是异步的，所以这个函数**是 async 的**：调用方 `await` 之后再弹提示。
 */

import {nativeCopyText} from './native-share'
import {isNativeShell} from './platform'

/**
 * 复制一段文本。
 *
 * @returns 真的复制到了吗 —— `false` 时调用方要给出「手动长按选中」那类提示，
 *          **别**只说「已复制」（用户会以为进了剪贴板）。
 */
export async function copyText(text: string): Promise<boolean> {
  /*
   * ⓪ **原生壳里先问原生剪贴板**（2026-10-13 加的）：`@capacitor/clipboard` 是真
   *    写系统剪贴板，比 WebView 里那两条（一个会拒、一个是废弃 API）都稳。
   *    ⚠️ 只在原生壳里试：web 上白白多绕一圈异步；
   *    ⚠️ 老 APK 没这个插件 ⇒ `nativeCopyText` 返回 false，往下走老路。
   */
  if (isNativeShell() && (await nativeCopyText(text))) return true
  if (await tryClipboardApi(text)) return true
  return legacyCopy(text)
}

/** ① 新的异步 Clipboard API（存在但可能 reject / 可能卡住，两条都当失败） */
async function tryClipboardApi(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false
  const write = (async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  })()
  // 超时那条只是「不等了」，不是「取消了」——晚到的成功写的还是同一段文本，无害
  const timeout = new Promise<boolean>(resolve => setTimeout(() => resolve(false), 600))
  return Promise.race([write, timeout])
}

/** ② 老办法：钉一个只读 textarea，选中它再 execCommand('copy') */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // 1px + opacity:0：别让它显形，也别撑出滚动条；fixed 是为了不带动页面滚动
  ta.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;'
  document.body.appendChild(ta)

  // 先记下用户自己的选区：复制完要还回去，否则页面上「选中的东西」被我们偷走了
  const sel = document.getSelection()
  const keep = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null

  let ok = false
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    ta.remove()
    if (sel && keep) {
      sel.removeAllRanges()
      sel.addRange(keep)
    }
  }
  return ok
}
