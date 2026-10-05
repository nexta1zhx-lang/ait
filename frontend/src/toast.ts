/**
 * 全站「信息提示」（toast）—— **一个就好**，别再各页自己写一份
 * （`AnalyzeView` / `OrderPanel` 曾经各攒了一套 `toast` ref + 定时器）。
 *
 * 用法：`import {showToast} from '../toast'` → `showToast('已撤单：BTC @ 85,123.4', 'ok')`。
 *
 * ⚠️ 文案里**不要写状态符号**（`✅` / `❌` / `⚠️`）：成 / 败由 `.ok` / `.bad` 的颜色表达
 *    （用户 2026-10-06：「不要加符号提示」）。
 * 真正画出来的是 `comps/ToastHost.vue`（挂在 `App.vue`，全局唯一一份）。
 * 样式与规范见 `style.css` 的「信息提示（toast）与确认框（dlg）」那一节。
 */
import {ref} from 'vue'

export type ToastTone = 'ok' | 'bad'

export interface ToastState {
  text: string
  tone: ToastTone
  /** 自增序号：同一条文案再来一次时也重建 DOM，入场动画 / 计时都重新开始 */
  id: number
}

export const toast = ref<ToastState | null>(null)

/*
 * 自己走掉的时间：报错要看清楚原因，留久一点；成功 / 中性一句话 4 秒够了。
 * 点一下也能立刻关（见 `ToastHost`）。
 */
const OK_MS = 4000
const BAD_MS = 8000

let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

/** 弹一条信息提示（`tone` 缺省是成功） */
export function showToast(text: string, tone: ToastTone = 'ok'): void {
  toast.value = {text, tone, id: ++seq}
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => (toast.value = null), tone === 'bad' ? BAD_MS : OK_MS)
}

/** 立刻收起（点提示条 / 页面卸载时用） */
export function hideToast(): void {
  if (timer) clearTimeout(timer)
  timer = null
  toast.value = null
}
