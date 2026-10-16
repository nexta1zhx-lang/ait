/**
 * 「数据问答」的参数收敛 —— **纯函数**，不碰数据库。
 *
 * 单独一个文件是为了能离线测：`scripts/selftest.ts` 直接 import 这里跑夹具，
 * 不用起 Postgres（`tools.ts` 那边一 import 就把 `db/*` 一起拉进来了）。
 *
 * 模型给的参数是自由文本：日期可能写成「上周三」、跨度可能写「近三年」、
 * 币种可能写成 `BTCUSDT`。**在进 SQL 之前一律先收敛**，收敛不了的走兜底，
 * 绝不把原始字符串往查询里带。
 */

/** 默认看最近多少天 */
export const DEFAULT_DAYS = 30
/** 单次最多看多少天 —— 防止模型开口就要「近三年」把库和上下文拖垮 */
export const MAX_DAYS = 400
/** 单次最多回多少条（模型读得下的上限，也是 token 成本的主要闸门） */
export const MAX_ROWS = 200

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 某个时刻属于**北京哪一天**（`YYYY-MM-DD`）—— 服务器可能在别的时区，
 * 别拿 `toISOString().slice(0,10)` 当北京日期用。
 */
export function bjDayOf(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(
    new Date(ms)
  )
}

/** 「今天」= 北京自然日 */
export function bjToday(nowMs: number = Date.now()): string {
  return bjDayOf(nowMs)
}

/** 日期加减 N 天。纯字符串日期的加减，不碰时区（中国没有夏令时，够用） */
export function dayShift(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 两个自然日相差几天（`to - from`） */
export function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/**
 * 北京自然日 → 毫秒时间戳（当天 00:00）。
 *
 * 账本那几个查询函数（`listFills` / `listIncome` / `incomeTotals`）收的是**毫秒、
 * 含端点**，时区由调用方负责 —— 见 `exchange-store.ts` 里 `LedgerQuery` 的说明。
 * 用固定 `+08:00` 而不是查时区库：中国没有夏令时，这个偏移是常量，够用且可测。
 */
export function bjDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`)
}

/** 北京自然日 → 那天的**最后一毫秒**（账本查询的 `to` 是含端点的） */
export function bjDayEndMs(day: string): number {
  return bjDayStartMs(dayShift(day, 1)) - 1
}

/**
 * 毫秒时间戳 / 时间字符串 → 北京的 `YYYY-MM-DD HH:mm`。
 *
 * ⚠️ 别用 `toISOString().slice(0, 16)` 糊过去 —— 那是 **UTC**，比用户看到的时间
 *    早 8 小时（晚上 20:30 的分析会被说成"早上"）。模型拿到什么就说什么，
 *    所以这一步必须在取数这一层做对。
 */
export function bjStamp(at: number | string | Date): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(d)
  return `${bjDayOf(d.getTime())} ${hm}`
}

/** 收敛成 `YYYY-MM-DD`；认不出返回 null（ISO 时间戳取前 10 位） */
export function normalizeDay(v: unknown): string | null {
  const s = String(v ?? '').trim()
  const day = DAY_RE.test(s) ? s : s.slice(0, 10)
  if (!DAY_RE.test(day)) return null
  const t = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  /*
   * ⚠️ `Date.parse('2026-02-31T00:00:00Z')` **不报错** —— 它进位成 3 月 3 日。
   *    所以要把解析结果转回来比一遍：不存在的日子必须认成「认不出」，
   *    否则用户问「2 月 31 号」会静默拿到 3 月 3 号的区间，界面上看不出任何异常。
   */
  return new Date(t).toISOString().slice(0, 10) === day ? day : null
}

export interface NormalizedRange {
  from: string
  to: string
  days: number
  /** 区间被改过时说明原因（写进「取值过程」，人和模型都看得见） */
  note: string
}

/**
 * 收敛区间：缺参数、写反了、跨度太大，全在这里治。
 *
 * `today` 显式传进来是为了可测（夹具拿固定「今天」卡边界）。
 */
export function normalizeRange(
  from: unknown,
  to: unknown,
  today: string = bjToday(),
  /**
   * 跨度上限（天）。默认 `MAX_DAYS`（400）—— 那个数是给「分析历史 / 用量」这类
   * 按天攒的流水定的。**K 线要另算**：能往前看多久取决于「这个周期最多读多少根」
   * （1d 能看 1500 天，5m 只能 5 天），所以调用方传自己的上限进来。
   */
  maxDays: number = MAX_DAYS
): NormalizedRange {
  const notes: string[] = []
  let end = normalizeDay(to)
  if (!end) {
    end = today
    if (to) notes.push('结束日期认不出，按今天算')
  }
  if (end > today) {
    end = today
    notes.push('结束日期在未来，按今天算')
  }

  let start = normalizeDay(from)
  if (!start) {
    start = dayShift(end, -(DEFAULT_DAYS - 1))
    if (from) notes.push('开始日期认不出，按默认区间算')
  }
  if (start > end) {
    ;[start, end] = [end, start]
    notes.push('起止写反了，已对调')
  }

  const cap = Math.max(1, Math.round(maxDays))
  const earliest = dayShift(end, -(cap - 1))
  if (start < earliest) {
    start = earliest
    notes.push(`跨度超过 ${cap} 天，已截到最近 ${cap} 天`)
  }
  return {
    from: start,
    to: end,
    days: dayDiff(start, end) + 1,
    note: notes.join('；')
  }
}

/** 正整数参数：夹到 `[1, max]`，认不出用 `def` */
export function clampInt(v: unknown, def: number, max: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(max, n)
}

/** 币种：统一大写、去掉 `/USDT` 之类的对写法；认不出返回 '' */
export function normalizeSymbol(v: unknown): string {
  const raw = String(v ?? '')
    .trim()
    .toUpperCase()
    .split(/[/:]/)[0]
  // 模型可能给交易对写法（`BTCUSDT`），而库里 `analyses.symbol` 存的是基础币（`BTC`）
  const bare = raw.endsWith('USDT') && raw.length > 4 ? raw.slice(0, -4) : raw
  return /^[A-Z0-9]{2,20}$/.test(bare) ? bare : ''
}

/** 秒 → 「1 小时 12 分」/「2 天 3 小时」（持仓时长这种给人看的数字） */
export function dur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}
