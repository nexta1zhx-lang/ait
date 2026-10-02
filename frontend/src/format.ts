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

/** 毫秒 → 'YYYY-MM-DDTHH:mm'（北京时间），给 <input type="datetime-local"> 用 */
export function bjInputValue(input: number | string | Date): string {
  const d = typeof input === 'number' ? new Date(input) : new Date(input)
  if (Number.isNaN(d.getTime())) return ''
  const p = bjParts(d)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** 'YYYY-MM-DDTHH:mm'（按北京时间理解）→ 毫秒；非法给 0 */
export function bjInputToMs(v: string): number {
  if (!v) return 0
  const withSec = v.length === 16 ? `${v}:00` : v
  const ms = new Date(`${withSec}+08:00`).getTime()
  return Number.isFinite(ms) ? ms : 0
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
  range: '→ 震荡',
  // 极少数情况下某周期没给方向（数据不足），模型会明确回 unknown
  unknown: '— 无方向数据'
}

/**
 * 档位文案。
 *
 * ⚠️ key 必须和 `backend/src/llm/schema.ts` 的 grade 枚举一模一样 ——
 * 对不上的会直接显示成原始值（如「C」），看着像没翻译。
 */
export const GRADE_TEXT: Record<string, string> = {
  A: 'A 档 · 顺势单',
  'A-W': 'A-W 档 · 顺势双底',
  S: 'S 档 · 突破',
  V: 'V 档 · 超跌极速V反',
  B: 'B 档 · 不该做',
  unclear: '说不清'
}

/**
 * 档位颜色：顺势三档（A / A-W / S）是绿的，逆势 V 是黄的，B 是红的。
 * 对应 `style.css` 里的 `.grade.*`。
 */
export function gradeTone(g?: string | null): string {
  if (!g) return ''
  if (g === 'B') return 'b'
  if (g === 'V') return 'v'
  if (g === 'unclear') return 'unclear'
  return g.toLowerCase()
}

/**
 * 这段行情是什么。
 *
 * 由 AI 客观判断（拉升 / 下跌 / 横盘），**不套我自己的 A/B/C 档** ——
 * 分不分级、怎么分级是我自己打标签的事。
 */
export const MOVE_TEXT: Record<string, {label: string; cls: string}> = {
  up: {label: '↑ 拉升', cls: 'up'},
  down: {label: '↓ 下跌', cls: 'down'},
  range: {label: '→ 横盘', cls: 'range'}
}

export function moveText(m?: string | null): string {
  if (!m) return '—'
  return MOVE_TEXT[m]?.label ?? m
}

export function moveCls(m?: string | null): string {
  if (!m) return 'none'
  return MOVE_TEXT[m]?.cls ?? 'none'
}

/**
 * 结论的中文说法 —— **只在这一份**。
 *
 * 筛选栏、结论分布饼图、列表/详情里的徽标全从它取，
 * 别再各处自己写「等 / 观望」这种两套词。
 * （key 就是 AI 输出契约里的 `verdict` 取值）
 */
export const VERDICT_LABEL: Record<string, string> = {
  go: '可做',
  wait: '观望',
  no_go: '不可做'
}

export const VERDICT_TEXT: Record<string, [string, string]> = {
  go: [`✅ ${VERDICT_LABEL.go}`, 'go'],
  wait: [`⏸ ${VERDICT_LABEL.wait}`, 'wait'],
  no_go: [`⛔ ${VERDICT_LABEL.no_go}`, 'no']
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
