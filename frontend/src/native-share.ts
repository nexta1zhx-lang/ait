/**
 * 原生壳里的「分享图片 / 保存图片 / 复制文字」（2026-10-13）。
 *
 * ★ 为什么要有这一层：用户 2026-10-13 在装机版 App 上连报三次
 *   「复制和保存图片和分享在移动端 app 不生效」「点击分享后提示没有可分享的软件」
 *   「无法长按保存，分享也是出来保存图片的界面」。
 *   浏览器能力（`<a download>` / `navigator.share` / `navigator.clipboard` /
 *   长按图片的系统菜单）在 Capacitor 的安卓 WebView 里**要么没有、要么是假支持**
 *   （逐条实测写在 `ShareSheet.vue` 顶部），只能走原生插件：
 *     · `@capacitor/filesystem` —— 把画好的 PNG 落到 App 的 cache 目录
 *     · `@capacitor/share`      —— 拿那个文件的 uri 去真弹系统分享面板
 *     · `@capacitor/clipboard`  —— 复制文本
 *
 * ⚠️⚠️ **不 `import` `@capacitor/*`** —— 仓库既有约定（见 `platform.ts` / `native.ts`
 *    顶部）：插件都从 `window.Capacitor.Plugins` 那个全局对象上取，
 *    只手写「我们用得到的那一小块」类型。这样 web 包里不会多打进去几个插件的 JS，
 *    而且**老 APK 里没有这个插件**时也只是取到 `undefined`，不会因为 import 就崩。
 *
 * ⚠️ 每个函数都**返回成没成**（`false` 而不是抛）：调用方要能退回 web 那条路
 *    （长按大图 / `execCommand`）——用户手机上装的可能还是没带插件的那版 APK，
 *    那时候调用会抛 `Share plugin is not implemented on android`。
 */

/** Capacitor 往 `window` 上注入的那个全局对象（用得到的那一小块） */
interface CapGlobal {
  Plugins?: {
    Share?: {
      share: (o: {
        title?: string
        text?: string
        files?: string[]
        dialogTitle?: string
      }) => Promise<unknown>
    }
    Filesystem?: {
      writeFile: (o: {
        path: string
        data: string
        /** `Directory.Cache` 的字面量（枚举是数字，字面量字符串更稳） */
        directory: string
        recursive?: boolean
      }) => Promise<{uri?: string}>
    }
    Clipboard?: {
      write: (o: {string: string}) => Promise<void>
    }
  }
}

function plugins(): CapGlobal['Plugins'] {
  return (globalThis as unknown as {Capacitor?: CapGlobal}).Capacitor?.Plugins
}

/** blob → 纯 base64（不带 `data:image/png;base64,` 前缀，插件要的是裸串） */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('读图片失败'))
    fr.onload = () => {
      const s = String(fr.result ?? '')
      const at = s.indexOf(',')
      resolve(at >= 0 ? s.slice(at + 1) : s)
    }
    fr.readAsDataURL(blob)
  })
}

/**
 * 把图丢给系统分享面板（App 里的「分享」）。
 *
 * @param text 要一起带上的文案；传空就是「只分享图片」
 * @param dialogTitle 面板标题（安卓上多数机型不显示，传着无害）
 */
export async function nativeShareImage(input: {
  base64: string
  filename: string
  text?: string
  title?: string
  dialogTitle?: string
}): Promise<boolean> {
  const p = plugins()
  if (!p?.Share?.share || !p.Filesystem?.writeFile) return false
  try {
    // 落到 cache 目录就够了：系统面板要的是个能读的 `file://`，
    // 用户往哪儿存由他在面板里选（相册 / 文件 / 微信 …）
    const w = await p.Filesystem.writeFile({
      path: input.filename,
      data: input.base64,
      directory: 'CACHE',
      recursive: true
    })
    if (!w?.uri) return false
    // ⚠️ `files` 只传**一个** uri：插件内部会把它包成 FileProvider 的 content://，
    //    多传几个在某些机型上会把面板弄成全空（用户报的「没有可分享的软件」差不多那意思）
    await p.Share.share({
      title: input.title,
      text: input.text,
      files: [w.uri],
      dialogTitle: input.dialogTitle
    })
    return true
  } catch {
    /* 用户在面板上点了取消也会走到这儿（插件把 cancel 也当异常）——所以只回 false，
       由调用方决定要不要"退回长按大图"，别弹错误提示吓人 */
    return false
  }
}

/**
 * 复制文本（原生剪贴板）。
 *
 * ⚠️ 只在**原生壳里**试它，web 上直接走 `clipboard.ts` 那套 —— 别让浏览器多绕一圈。
 */
export async function nativeCopyText(text: string): Promise<boolean> {
  const c = plugins()?.Clipboard
  if (!c?.write) return false
  try {
    await c.write({string: text})
    return true
  } catch {
    return false
  }
}
