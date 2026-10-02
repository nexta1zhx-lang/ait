import {Calibers, Timeframe} from './types'

/** 支持的全部周期，由短到长（按这个顺序分析 / 展示） */
export const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']

/** 各周期一根 K 线的毫秒数（`data/market.ts` 直接从这 re-export） */
export const TF_MS: Record<Timeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
}

const DAY_MS = 24 * 60 * 60_000

/** 取数参数的默认值 —— 和 `config/calibers.yaml` 里写的一致。 */
export const DEFAULT_CALIBERS: Calibers = {
  others: {
    '5m': {'15m': 2, '1h': 10, '4h': 20, '1d': 30},
    '15m': {'1h': 10, '4h': 20, '1d': 30},
    '1h': {'15m': 2, '4h': 30, '1d': 60},
    '4h': {'1d': 60},
    '1d': {}
  },
  minBars: 30,
  maxBars: 1500
}

/** 某个周期这一次拉多少根 */
export interface TfPlan {
  timeframe: Timeframe
  /** 天数；`null` = 「图上」—— 用主周期那段算出来的天数 */
  days: number | null
}

/**
 * 主周期 → 这一次要分析哪几个周期、各拉多少天。
 *
 * 规则（我自己定的，写在 `config/calibers.yaml`））：
 *   看 5m  → 5m 图上 · 15m 2 天 · 1h 10 天 · 4h 20 天 · 1d 30 天
 *   看 15m → 15m 图上 · 1h 10 天 · 4h 20 天 · 1d 30 天
 *   看 1h  → 15m 2 天 · 1h 图上 · 4h 30 天 · 1d 60 天
 *   看 4h  → 4h 图上 · 1d 60 天（不带 15m / 1h）
 *   看 1d  → 只带 1d（图上）
 *
 * 主周期那一项 `days` 永远是 `null` —— 它的天数由「图上那段有多长」决定。
 */
export function planFor(
  main: Timeframe,
  cal: Calibers = DEFAULT_CALIBERS
): TfPlan[] {
  const table = cal.others[main]
  if (!table || !Object.keys(table).length)
    return [{timeframe: main, days: null}]

  return TIMEFRAMES.filter(tf => tf === main || table[tf] !== undefined).map(
    tf => ({
      timeframe: tf,
      days: tf === main ? null : (table[tf] as number)
    })
  )
}

/** 「这段时间有多少天」→ 这个周期实际拉多少根（夹在 `minBars`~`maxBars`） */
export function barsFor(
  tf: Timeframe,
  days: number,
  cal: Calibers = DEFAULT_CALIBERS
): number {
  const d = Number.isFinite(days) && days > 0 ? days : 1
  const raw = Math.ceil((d * DAY_MS) / TF_MS[tf])
  return Math.min(cal.maxBars, Math.max(cal.minBars, raw))
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** 解析一个「根数 / 天数」类参数：正整数，不合法就退回默认并提醒 */
function count(v: unknown, fallback: number, label: string): number {
  if (v === undefined || v === null) return fallback
  const n = Number(v)
  if (Number.isFinite(n) && n >= 1) return Math.floor(n)
  console.warn(
    `⚠️  calibers.yaml 的「${label}」= “${String(v)}” 不是正整数，按 ${fallback} 处理`
  )
  return fallback
}

/** 解析「其余周期」那张表：主周期 → { 周期: 天数 } */
function parseOthers(v: unknown): Calibers['others'] {
  const raw = obj(v)
  const out: Calibers['others'] = {}
  for (const main of Object.keys(raw)) {
    if (!(TIMEFRAMES as string[]).includes(main)) {
      console.warn(
        `⚠️  calibers.yaml 的「其余周期」里有不认识的周期“${main}”，已忽略`
      )
      continue
    }
    const inner = obj(raw[main])
    const row: Partial<Record<Timeframe, number>> = {}
    for (const tf of Object.keys(inner)) {
      if (!(TIMEFRAMES as string[]).includes(tf)) {
        console.warn(
          `⚠️  calibers.yaml 的「其余周期.${main}」里有不认识的周期“${tf}”，已忽略`
        )
        continue
      }
      row[tf as Timeframe] = count(inner[tf], 1, `其余周期.${main}.${tf}`)
    }
    out[main] = row
  }
  return Object.keys(out).length ? out : DEFAULT_CALIBERS.others
}

/**
 * `config/calibers.yaml` → `Calibers`。
 * 解析失败一律退回默认值 —— 配置写错不该让整站起不来。
 */
export function parseCalibers(raw: unknown): Calibers {
  const fetch = obj(obj(raw)['取数'])
  return {
    others: parseOthers(fetch['其余周期']),
    minBars: count(
      fetch['最少根数'],
      DEFAULT_CALIBERS.minBars,
      '取数.最少根数'
    ),
    maxBars: count(fetch['最多根数'], DEFAULT_CALIBERS.maxBars, '取数.最多根数')
  }
}
