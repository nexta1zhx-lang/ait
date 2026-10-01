/** 数值 / 时间格式化 */

/** 按数值量级选小数位，避免低价币被四舍五入成同一个值 */
export function decimalsFor(n: unknown): number {
  const a = Math.abs(Number(n))
  if (!Number.isFinite(a) || a === 0) return 2
  if (a >= 100) return 2
  if (a >= 1) return 4
  if (a >= 0.01) return 5
  if (a >= 0.0001) return 6
  return 8
}

/** 价格 / 通用数字 */
export function fmt(n: unknown, digits?: number): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const d = digits === undefined ? decimalsFor(n) : digits
  return Number(n).toLocaleString('en-US', {
    maximumFractionDigits: d,
    minimumFractionDigits: 0
  })
}

export function usd(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return '$0'
  if (n < 0.0001) return '<$0.0001'
  if (n < 1) return '$' + n.toFixed(4)
  return '$' + n.toFixed(2)
}

export function cny(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return '¥0'
  if (n < 0.001) return '<¥0.001'
  if (n < 1) return '¥' + n.toFixed(3)
  if (n < 1000) return '¥' + n.toFixed(2)
  return '¥' + n.toLocaleString('en-US', {maximumFractionDigits: 2})
}

export function tok(v: unknown): string {
  return Math.round(Number(v) || 0).toLocaleString('en-US')
}

export function int(v: unknown): string {
  return Math.round(Number(v) || 0).toLocaleString('en-US')
}

export function pct(v: unknown, digits = 1): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return (n * 100).toFixed(digits) + '%'
}

/** 固定小数位（保留末尾的 0），百分比 / 倍数用 */
export function fixed(n: unknown, digits = 2): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** 带正负号的百分比 */
export function signedPct(v: unknown, digits = 2): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${fixed(n, digits)}%`
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  return `${(v / 1000).toFixed(1)}s`
}

/* ---------------- 时间（一律北京时间） ---------------- */

const BJ = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

function bjParts(d: Date): Record<string, string> {
  const o: Record<string, string> = {}
  for (const p of BJ.formatToParts(d)) o[p.type] = p.value
  return o
}

/** 交易图上的时间：秒或毫秒时间戳 / Date */
export function bjTime(input: number | string | Date, withDate = true): string {
  const d =
    typeof input === 'number'
      ? new Date(input < 1e11 ? input * 1000 : input)
      : new Date(input)
  if (Number.isNaN(d.getTime())) return '—'
  const p = bjParts(d)
  const time = `${p.hour}:${p.minute}`
  return withDate ? `${p.year}-${p.month}-${p.day} ${time}` : time
}

/** MM/DD HH:mm */
export function bjShort(input: number | string | Date): string {
  const d =
    typeof input === 'number'
      ? new Date(input < 1e11 ? input * 1000 : input)
      : new Date(input)
  if (Number.isNaN(d.getTime())) return '—'
  const p = bjParts(d)
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`
}

/** 相对时间：3 分钟前 */
export function ago(input: number | string | Date): string {
  const t = new Date(input).getTime()
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

/* ---------------- 业务文案 ---------------- */

export const TREND_TEXT: Record<string, string> = {
  up: '↑ 上涨',
  down: '↓ 下跌',
  range: '→ 震荡'
}

export const GRADE_TEXT: Record<string, string> = {
  A: 'A 档 · 顺势单',
  B: 'B 档 · 不该做',
  C: 'C 档 · 期望突破',
  unclear: '说不清'
}

export const VERDICT_TEXT: Record<string, [string, string]> = {
  go: ['✅ 可做', 'go'],
  wait: ['⏸ 观望', 'wait'],
  no_go: ['⛔ 不可做', 'no']
}

/** 结构简称：高点↑ 低点↑ */
export function structureText(s?: {
  higherHighs?: boolean
  lowerHighs?: boolean
  higherLows?: boolean
  lowerLows?: boolean
}): string {
  if (!s) return '—'
  const parts: string[] = []
  if (s.higherHighs) parts.push('高点↑')
  if (s.lowerHighs) parts.push('高点↓')
  if (s.higherLows) parts.push('低点↑')
  if (s.lowerLows) parts.push('低点↓')
  return parts.length ? parts.join(' ') : '结构不明'
}

/** 结构全称（悬停提示用） */
export function structureFull(s?: {
  higherHighs?: boolean
  lowerHighs?: boolean
  higherLows?: boolean
  lowerLows?: boolean
}): string {
  if (!s) return ''
  const parts: string[] = []
  if (s.higherHighs) parts.push('更高的高点')
  if (s.lowerHighs) parts.push('更低的高点')
  if (s.higherLows) parts.push('更高的低点')
  if (s.lowerLows) parts.push('更低的低点')
  return parts.length ? parts.join(' + ') : '结构不明'
}
