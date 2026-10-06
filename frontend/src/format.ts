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

/**
 * 合约一个 tick 要几位小数（`tickSize` 0.1 → 1 位、0.0001 → 4 位、0.25 → 2 位）。
 *
 * ⚠️ 别用 `-Math.log10(tick)` 取整：0.25 这种「不是 10 的幂」的 tick 会少算一位。
 *    这里靠字符串数小数位，`1e-5` 这种科学计数法的也能算对。
 */
export function digitsForTick(tick: unknown): number {
  const t = Number(tick)
  if (!Number.isFinite(t) || t <= 0) return 2
  const s = t.toFixed(12).replace(/0+$/, '')
  const dot = s.indexOf('.')
  return Math.max(0, Math.min(12, dot < 0 ? 0 : s.length - dot - 1))
}

/**
 * 价格：按合约精度**补齐**小数位（`84,910.0` / `86,976.1`）。
 *
 * ⚠️ 价格别用 `fmt()` —— 它的 `minimumFractionDigits: 0` 会把整数价格的小数位吃掉，
 *    同一屏里就出现「24h 低 84,910 · 高 86,976.1」这种位数不齐
 *    （用户 2026-10-06：「精度没统一」）。价格一律走这个函数。
 */
export function price(n: unknown, digits: number): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const d = Math.max(0, Math.min(12, Math.round(digits)))
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d
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
  // 秒也要（bjTimeSec 用）；只读自己需要的字段，所以对 bjTime/bjShort 没影响
  second: '2-digit',
  hour12: false
})

function bjParts(d: Date): Record<string, string> {
  const o: Record<string, string> = {}
  for (const p of BJ.formatToParts(d)) o[p.type] = p.value
  return o
}

/** 交易图上的时间：秒或毫秒时间戳 / Date */
/**
 * **带秒**的北京时间：`10-06 20:32:17`（只到「月-日 时:分:秒」）。
 *
 * ⚠️ `bjTime()` 只到分钟 —— 资金动向那一列要「这一秒到账」这种精度
 *    （资金费 / 手续费常常同一分钟内好几笔），所以单开一个。
 */
export function bjTimeSec(input: number | string | Date): string {
  const d =
    typeof input === 'number'
      ? new Date(input < 1e11 ? input * 1000 : input)
      : new Date(input)
  if (Number.isNaN(d.getTime())) return '—'
  const p = bjParts(d)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

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

/** ---------------------------------------------------------------- 推荐做法分段 */
/**
 * AI 的 `recommendation` 要求写成固定三行（`现在：` / `动手：` / `别碰：`）。
 * 这里把它拆成一段段好按行渲染：
 *   - 模型可能写成三行，也可能挤成一行、还可能带 **加粗** —— 都容错
 *   - 老记录是一整段没前缀的 → 原样返回一段（`k` 为空，当普通段落渲染）
 */
export interface RecPart {
  /** 前缀；老记录没前缀就是空串 */
  k: string
  v: string
  /** 配色用 */
  tone: 'now' | 'do' | 'dont' | 'plain'
}

const REC_TONE: Record<string, RecPart['tone']> = {
  现在: 'now',
  开单: 'do',
  // 2026-10-03 之前的写法，老记录里还是「动手」，一起认
  动手: 'do',
  别碰: 'dont'
}

export function splitRec(text: string | undefined | null): RecPart[] {
  const raw = (text ?? '').trim()
  if (!raw) return []
  // 先统一成「一个前缀一行」，两种写法就都能吃下了
  const marked = raw.replace(
    /\s*\*{0,2}\s*(现在|开单|动手|别碰)\s*\*{0,2}\s*[:：]\s*/g,
    (_m, k: string) => `\n${k}:`
  )
  const parts: RecPart[] = []
  for (const line of marked.split('\n')) {
    const s = line.trim()
    if (!s) continue
    const m = s.match(/^(现在|开单|动手|别碰)[:：]\s*(.*)$/)
    if (m && m[2].trim()) {
      parts.push({k: m[1], v: m[2].trim(), tone: REC_TONE[m[1]] ?? 'plain'})
    } else {
      parts.push({k: '', v: s, tone: 'plain'})
    }
  }
  return parts
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

/** ---------------------------------------------------------------- 结论文字高亮 */
/**
 * 结论里的「关键字加粗 + 变色」。
 *
 * 用户 2026-10-03：「能否在关键字加粗颜色变化」。两件事一起做：
 *   ① 模型习惯写 `**开多**` 来标重点，以前页面上是**原样显示星号**（因为用 `{{ }}` 插值），
 *      现在把它变成真加粗 + 上色；
 *   ② 没标的词按词表自动上色（方向 / 风险 / 关键位）。
 *
 * ⚠️ 输出是 HTML（模板里要 `v-html`），所以**先转义再插标签** ——
 *    AI 的输出也当不可信文本看，别让它写出真的标签来。
 * ⚠️ 只跑**一遍**正则（用替换函数），插入的标签不会被重新扫描，不会把标签自己包进去。
 */

/**
 * 上色词表：`[词, 色调]`。顺序无所谓，代码里会按长度从长到短排（「假突破」必须赢「突破」）。
 *
 * ⚠️ 2026-10-03 用户说「颜色有太多啦啦」—— 之前涨/跌/风险/关键位四个色全上，
 * 一段正文里五颜六色很吵。现在**只留两类**：
 *   · 模型自己用 `**…**` 标的重点（蓝）
 *   · 风险 / 纪律词（琥珀，这类真的要知道）
 * 方向词（涨/跌）和结构词（支撑/压力）不再上色 —— 推荐那三行本来就有绿/红标签。
 * 要重新加回某一类，就把词表补上、CSS 里 `.kw-xxx` 补上即可。
 */
const KW_TONES: [string, string][] = [
  ['不要追', 'warn'],
  ['别追高', 'warn'],
  ['止损', 'warn'],
  ['止盈', 'warn'],
  ['风险', 'warn'],
  ['假突破', 'warn'],
  ['轻仓', 'warn'],
  ['观望', 'warn'],
  ['别碰', 'warn']
]

/** 排好序的词表（长的优先） + 词→色调 */
const KW_SORTED = [...KW_TONES].sort((a, b) => b[0].length - a[0].length)
const KW_MAP = new Map(KW_TONES)

/** `**…**`（模型标的重点）也算一个「词」，一起在这一个正则里匹配 */
const KW_RE = new RegExp(
  `\\*\\*[^*\\n]{1,60}\\*\\*|${KW_SORTED.map(([w]) => w).join('|')}`,
  'g'
)

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 结论文字 → 可 `v-html` 的 HTML（关键字加粗上色） */
export function richText(src: string | undefined | null): string {
  const raw = (src ?? '').trim()
  if (!raw) return ''
  return escapeHtml(raw).replace(KW_RE, m => {
    if (m.startsWith('**')) {
      const t = m.slice(2, -2).trim()
      return t ? `<b class="kw kw-key">${t}</b>` : ''
    }
    return `<span class="kw kw-${KW_MAP.get(m) ?? 'key'}">${m}</span>`
  })
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
