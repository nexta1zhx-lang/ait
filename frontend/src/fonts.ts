/**
 * 读 CSS 里定义的字体栈 —— 给**写不了 CSS** 的地方用。
 *
 * canvas 的 `ctx.font`、lightweight-charts 的 `layout.fontFamily`、SVG 里
 * 内联的 `font-family`……这些只能在 JS 里传字符串。如果在那儿再抄一份字体名，
 * 改字体时必然漏掉一处 —— 实测就漏了：
 *
 *   `KlineChart.vue` / `MiniKline.vue` 里写死了
 *   `'ui-monospace, SFMono-Regular, Menlo, monospace'`，
 *   于是**图上坐标轴那串数字**一直没跟着 `--mono` 走，
 *   多机型下跟页面其它数字不是一款字（用户 2026-10-04：「全部换成等宽」）。
 *
 * 所以这里统一从 CSS 变量读：**字体的真相只有 `style.css` 那一份**。
 */
function readStack(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    // `getPropertyValue` 会把源码里的换行和缩进一起返回，压平了好读也保险
    .replace(/\s+/g, ' ')
    .trim()
  return v || fallback
}

/** 等宽栈（所有数字都用它）：对应 `--mono` */
export const monoStack = (): string => readStack('--mono', 'monospace')

/** 正文字体栈：对应 `--font-sans` */
export const sansStack = (): string => readStack('--font-sans', 'sans-serif')

/**
 * 等自托管字体加载完再跑一次回调。
 *
 * ⚠️ 为什么需要：**canvas 上画好的字不会自己更新**。
 *    字体还没到位就 `fillText`，那一帧画出来的是回退字体，之后也不会重画 ——
 *    于是手机上（首次加载慢）图上的数字和你调试图上的长得不一样。
 *    图表那边用它在 `document.fonts.ready` 后重新应用一次字体 / 重画一帧。
 */
export function whenFontsReady(fn: () => void): void {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts) {
    fn()
    return
  }
  void fonts.ready.then(() => fn())
}
