/**
 * 全站「确认框」—— 替掉 `window.confirm()`（系统默认那种改不了样式，跟这套皮肤不搭，
 * 手机上还会被浏览器弹成一条丑陋的横幅）。
 *
 * 用法：
 *   `import {askConfirm} from '../confirm'`
 *   `if (!(await askConfirm({title: '撤掉 BTC 这张挂单？', body: '撤掉之后这一份平仓保护就没了。', okText: '撤单', danger: true}))) return`
 *
 * 真正画出来的是 `comps/ConfirmDialog.vue`（挂在 `App.vue`，全局唯一一份）。
 * 文案 / 尺寸 / 层级规范见 `style.css` 的「信息提示（toast）与确认框（dlg）」那一节。
 */
import {ref} from 'vue'

/**
 * 正文里的一行：纯字符串 = 普通灰字；带 `tone` 的行按用途上色。
 *
 * ⚠️ 正文**不支持 HTML / Markdown**（用户数据会进标题正文，走 HTML 就是 XSS 口子），
 *    所以用这种结构化的小标记，别在文案里写 `**加粗**`（会原样显示出来）。
 */
export type ConfirmLine =
  | string
  /** num = 参数行（币种 / 价 / 数量）：正文色 + 全站那套数字字体 */
  | {t: string; tone?: 'num' | 'warn'}

export interface ConfirmOptions {
  /** 一句话说清要发生什么，以问号收尾 */
  title: string
  /** 代价 / 不可逆性。数组 = 多段（各占一行，参数放后面几行） */
  body?: ConfirmLine | ConfirmLine[]
  /** 确认键上的**动作**词（「撤单」/「平掉」/「删除」），别写「确定」 */
  okText?: string
  /** 取消键文案，缺省「取消」 */
  cancelText?: string
  /** 破坏性操作（撤单 / 平仓 / 删除 / 清数据）：确认键用实心红 */
  danger?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

/** 当前等着回答的那一个（同一时刻只允许一个，见 `askConfirm`） */
export const pendingConfirm = ref<PendingConfirm | null>(null)

/**
 * 弹一个确认框，等用户点。
 *
 * ⚠️ 同一时刻只留一个：又弹一个时，前一个按**取消**收掉 —— 不然它的 Promise
 *    永远悬着，那个 `await` 里的代码就再也不往下走了（比「少问一次」严重得多）。
 */
export function askConfirm(o: ConfirmOptions): Promise<boolean> {
  pendingConfirm.value?.resolve(false)
  return new Promise<boolean>(resolve => {
    pendingConfirm.value = {...o, resolve}
  })
}

/** 用户给了答案：关掉确认框并把结果交回 `askConfirm` 的 Promise */
export function settleConfirm(ok: boolean): void {
  const p = pendingConfirm.value
  pendingConfirm.value = null
  p?.resolve(ok)
}
