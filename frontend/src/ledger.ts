/**
 * 账本三格（仓位历史 / 成交历史 / 资金动向）的**筛选口径** —— 前端和后端要认同一套名字。
 *
 * 为什么单独一个文件：`LedgerRangeSheet.vue` 是 `<script setup>`（**不能往外 export**），
 * 但这些常量 / 工具面板（`ExchangeAccountLivePanel.vue`）也要用（算范围、认类型）。
 * 两边各写一份迟早会岔，所以提到这里。
 */

/** 快捷时间（`custom` 才让用户填起止日期） */
export type RangeKey = 'today' | '7d' | '30d' | '90d' | 'custom'

/**
 * 资金动向能筛的类型（`income_type` → 中文），顺序 = 界面上从左到右。
 *
 * ⚠️ `OTHER_TYPE` 那颗「其它」**不是**一个真的 `income_type`：
 *    它是「不在下面这些里的那些」（币安还有 `AUTO_EXCHANGE` 之类），
 *    后端会把这一项翻成「`income_type NOT IN (已知这些)`」（见 `server.ts` 的 `ledgerRange`）。
 */
export const LEDGER_TYPES = [
  {value: 'REALIZED_PNL', label: '已实现'},
  {value: 'COMMISSION', label: '手续费'},
  {value: 'COMMISSION_REBATE', label: '返佣'},
  {value: 'FUNDING_FEE', label: '资金费'},
  {value: 'TRANSFER', label: '划转'},
  {value: 'INSURANCE_CLEAR', label: '强平'}
] as const

/** 「其它」的哨兵值（见 `LEDGER_TYPES` 的说明） */
export const OTHER_TYPE = 'OTHER'

/** `income_type` → 中文（列表上那颗标签也用它） */
export const TYPE_NAME: Record<string, string> = {
  ...Object.fromEntries(LEDGER_TYPES.map(t => [t.value, t.label])),
  [OTHER_TYPE]: '其它'
}

/** 北京时间某一天的 0 点（毫秒）；`backDays` = 往前数几天 */
export function bjDayStart(now = Date.now(), backDays = 0): number {
  const shift = 8 * 3600_000
  const day = 86_400_000
  return Math.floor((now + shift) / day) * day - shift - backDays * day
}

/** `'YYYY-MM-DD'`（按北京时间读） */
export function bjDayValue(input: number | null | undefined): string {
  if (!input) return ''
  const d = new Date(input + 8 * 3600_000)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** `'YYYY-MM-DD'`（按北京时间理解）→ 那天 0 点的毫秒 */
export function bjDayToMs(v: string): number {
  const ms = Date.parse(`${v}T00:00:00+08:00`)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * 快捷时间 → 实际区间（毫秒，含端点）。
 *
 * ⚠️ 「近 N 天」= 今天往前数 N-1 天的 0 点 → 现在（含今天，所以是 N 个自然日）；
 *    「自定义」的**结束日整天都算**（不加这一下，选「到今天」会把今天切掉）。
 */
export function rangeToInterval(
  range: RangeKey,
  customFrom = '',
  customTo = '',
  now = Date.now()
): {from: number | null; to: number | null} {
  switch (range) {
    case 'today':
      return {from: bjDayStart(now), to: now}
    case '30d':
      return {from: bjDayStart(now, 29), to: now}
    case '90d':
      return {from: bjDayStart(now, 89), to: now}
    case 'custom': {
      const f = bjDayToMs(customFrom)
      const t = bjDayToMs(customTo)
      return {from: f || null, to: t ? t + 86_400_000 - 1 : null}
    }
    default:
      return {from: bjDayStart(now, 6), to: now}
  }
}
