import {Calibers, Timeframe} from './types'

/** 支持的全部周期，由短到长（按这个顺序分析 / 展示） */
export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/** 各周期一根 K 线的毫秒数（`data/market.ts` 直接从这 re-export） */
export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
}

const DAY_MS = 24 * 60 * 60_000

/** 取数参数的默认值 —— 和 `config/calibers.yaml` 里写的一致。 */
export const DEFAULT_CALIBERS: Calibers = {
  minBars: 30,
  maxBars: 1500
}

/**
 * ★ 2026-10-11：**`planFor()` 整块删了**。
 *
 * 用户：「AI 的数据变了吧？不要给了，只给当前周期的前 100 根数据」→「1. 不拉了」。
 * 于是分析只取**主周期**一个周期（顺带把 `config/calibers.yaml` 里的「其余周期」表也删了，
 * 免得留一张没人读的表骗人）。根数还是 `barsFor()` 那一套（夹在 `minBars`~`maxBars`）。
 */

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

/**
 * `config/calibers.yaml` → `Calibers`。
 * 解析失败一律退回默认值 —— 配置写错不该让整站起不来。
 */
export function parseCalibers(raw: unknown): Calibers {
  const fetch = obj(obj(raw)['取数'])
  return {
    minBars: count(
      fetch['最少根数'],
      DEFAULT_CALIBERS.minBars,
      '取数.最少根数'
    ),
    maxBars: count(fetch['最多根数'], DEFAULT_CALIBERS.maxBars, '取数.最多根数')
  }
}
