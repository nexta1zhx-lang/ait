/**
 * 中国法定节假日（**放假的日期**，北京时间，`YYYY-MM-DD`）。
 *
 * 只影响「高峰 / 空闲时段」的判定：这些日子**全天**按空闲计价（半价）。
 * 调休上班的周末**不用**写进来 —— 规则里「周末全天空闲」优先，周末一律半价。
 *
 * ⚠️ **每年国务院办公厅发通知后手工更新一次**（通常 11 月发下一年的安排）。
 *
 * ⚠️⚠️ 下面这份是**按往年规律推的，请以官方通知为准**。
 * 对账方式：`npm run peak` 会列出全年每一天算高峰还是空闲，
 * 对着官方日历扫一眼就能看出哪里不对，改这个文件即可。
 */

/** 补齐两位数 */
const pad = (n: number) => String(n).padStart(2, '0')

/** 一段连续日期展开成 `YYYY-MM-DD` 列表（含头含尾） */
function range(from: string, to: string): string[] {
  const out: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    const d = new Date(t)
    out.push(
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    )
  }
  return out
}

export const CN_HOLIDAYS: ReadonlySet<string> = new Set([
  // ---------------- 2025 ----------------
  ...range('2025-01-01', '2025-01-01'), // 元旦
  ...range('2025-01-28', '2025-02-04'), // 春节
  ...range('2025-04-04', '2025-04-06'), // 清明
  ...range('2025-05-01', '2025-05-05'), // 劳动节
  ...range('2025-05-31', '2025-06-02'), // 端午
  ...range('2025-10-01', '2025-10-08'), // 国庆 + 中秋

  // ---------------- 2026（⚠️ 请照官方通知核对） ----------------
  ...range('2026-01-01', '2026-01-03'), // 元旦
  ...range('2026-02-15', '2026-02-22'), // 春节（除夕 2/16）
  ...range('2026-04-04', '2026-04-06'), // 清明
  ...range('2026-05-01', '2026-05-05'), // 劳动节
  ...range('2026-06-19', '2026-06-21'), // 端午
  ...range('2026-09-25', '2026-09-27'), // 中秋
  ...range('2026-10-01', '2026-10-08') // 国庆
])

/**
 * 北京时间下的「年月日 + 星期 + 小时」。
 *
 * 做法是先把时刻加 8 小时，再用 `getUTC*` 去读 ——
 * 读出来就是北京时间，不用管本机时区。
 */
export function beijingParts(at: Date): {
  ymd: string
  /** 0 = 周日 */
  dow: number
  hour: number
} {
  const d = new Date(at.getTime() + 8 * 3600_000)
  return {
    ymd: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    dow: d.getUTCDay(),
    hour: d.getUTCHours()
  }
}

/**
 * 是不是**高峰时段**（北京时间）。
 *
 * 高峰：周一~周五（不含法定节假日）的 9:00-12:00 与 14:00-18:00。
 * 其余全部（含周末、法定节假日全天、以及平日的其它时段）= 空闲时段，
 * 单价是高峰的**一半**（折算在 `costOf` 里）。
 */
export function isPeakHour(at: Date = new Date()): boolean {
  const p = beijingParts(at)
  if (p.dow === 0 || p.dow === 6) return false
  if (CN_HOLIDAYS.has(p.ymd)) return false
  return (p.hour >= 9 && p.hour < 12) || (p.hour >= 14 && p.hour < 18)
}

/** 给界面/日志用的一句话：高峰 / 空闲（周末）/ 空闲（节假日） */
export function peakText(at: Date = new Date()): string {
  const p = beijingParts(at)
  if (p.dow === 0 || p.dow === 6) return '空闲（周末）'
  if (CN_HOLIDAYS.has(p.ymd)) return '空闲（法定节假日）'
  return isPeakHour(at) ? '高峰' : '空闲'
}
