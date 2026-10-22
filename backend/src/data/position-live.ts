/**
 * **盘中持仓体检** —— 「开单之后给我看状态，别管我要不要开」。
 *
 * 用户 2026-10-22 的原话：「我不希望你再对我的开单有限制……我希望的是，在我开单之后，
 * 能针对盘中的状态以及盘后的复盘，给我一些改进的点」。
 *
 * 所以这一层**只读**：
 *   · 不碰 `/api/exchange/trade/order`，不校验、不拦截、不改默认参数；
 *   · 只把「现在的仓位」和「进场时的样子」摆在一起，再补一条**你自己的历史基准**。
 *
 * 数据来源：
 *   · 持仓 —— `position-cache.ts` 的常驻流（`liveStateOf`，跟板子同源，不打交易所）；
 *   · 进场时的 24h 涨跌幅 / 结构位 —— 本地 `candles`（`pair` 是币安原始符号）。
 *
 * ⚠️ 文案原则见 `data/trade-review.ts` 文件头：**只陈述，不命令**。
 */
import {query, queryOne} from '../db/client'
import {listExchangeKeys} from '../db/exchange-keys'
import {liveStateOf, type LivePosition} from './position-cache'
import {unifiedPerpSymbol} from '../db/candle-store'

/** 算结构位用的周期。15m 是 2026-09-22 起才有全量，更早的仓会走 fallback */
const STRUCT_TF = '15m'

/** 结构位止损的上下限（价格距离 %）。低于下限会被噪音扫，高于下限说明位置太远 */
const STOP_MIN_PCT = 0.4
const STOP_MAX_PCT = 1.5

/** 一条持仓的体检卡 */
export interface HealthCard {
  keyId: number
  /** 币安原始符号（`1000PEPEUSDT`） */
  symbol: string
  /** ccxt 统一符号（`1000PEPE/USDT:USDT`），前端点 K 线要用 */
  unified: string
  side: 'long' | 'short'
  amount: number
  entry: number
  mark: number
  leverage: number
  notional: number
  unrealized: number
  /** ROE %（相对保证金，交易所口径） */
  roe: number | null
  /** 这个仓位占账户净值几倍（真·杠杆） */
  accountLeverage: number | null
  openedAt: string | null
  holdMin: number | null
  stopPrice: number | null
  stopPct: number | null
  /** structural | fallback */
  stopSource: string
  /** 1R = |进场 − 止损| */
  rUnit: number | null
  /** 当前是几 R（浮盈 / 1R） */
  r: number | null
  /** 持仓期间最大浮盈（R）；只在有 R 时给 */
  mfeR: number | null
  /** 持仓期间最大浮亏（R，负数） */
  maeR: number | null
  /** 现价到止损还有多少（%）；已跌破为负 */
  distToStopPct: number | null
  /** 档位：<30 分钟 / ≥30 分钟（复盘基准用） */
  bucket: 'lt30' | 'gte30' | null
  /** 该档位在你历史里的胜率 */
  bucketWinrate: number | null
  /** 体检提示（只陈列，不下命令） */
  tips: {code: string; text: string}[]
}

/**
 * **你自己的历史基准** —— 2026-07-30 ~ 10-20 的 426 笔完整交易算出来的。
 *
 * ⚠️ 这几个数字是**文案对照线**，不是交易规则。改之前先跑一遍
 *    `scripts/replay-my-trades.ts`（回放：同一批进场换退出），别拍脑袋换。
 */
export const BASELINES = {
  lt30: {trades: 280, winRate: 0.2, avgNet: -4.03},
  gte30: {trades: 146, winRate: 0.4, avgNet: 4.77},
  hot: {trades: 22, winRate: 0.5, avgNet: 13.55, label: '进场前 24h 涨超 25%'},
  cold: {trades: 41, winRate: 0.2, avgNet: 9.89, label: '进场前 24h 跌超 3%'},
  middle: {trades: 249, winRate: 0.27, avgNet: -4.04, label: '24h 在 −3% ~ +25% 之间'},
  short: {trades: 112, winRate: 0.25, avgNet: -1.0},
  long: {trades: 312, winRate: 0.27, avgNet: -1.03}
} as const

/** 内存里的 MFE/MAE（重启丢，下一跳由 `position_plans` 恢复初值） */
const excursions = new Map<string, {mfe: number; mae: number}>()
/** 提示冷却：`${keyId}:${symbol}:${side}:${code}` → 最后一次触发时间 */
const tipCooldown = new Map<string, number>()
const TIP_COOLDOWN_MS = 30 * 60_000

function planKeyOf(keyId: number, symbol: string, side: string): string {
  return `${keyId}:${symbol.toUpperCase()}:${side}`
}

/** 取最近 N 根 15m 的 close/high/low（按币安原始符号 `pair` 查） */
async function recentBars(
  pair: string,
  n = 20
): Promise<{close: number; high: number; low: number}[]> {
  const rows = await query<{close: number; high: number; low: number}>(
    `SELECT close, high, low FROM candles
      WHERE pair = $1 AND interval = $2 AND market_type = 'swap'
      ORDER BY open_time DESC LIMIT $3`,
    [pair.toUpperCase(), STRUCT_TF, n]
  )
  return rows.map(r => ({close: Number(r.close), high: Number(r.high), low: Number(r.low)}))
}

/** 进场前 24h 涨跌幅（%）。拿不到返回 null —— 界面显示「—」，别编 */
export async function chg24At(pair: string, atMs: number): Promise<number | null> {
  const r = await queryOne<{now: number; then: number}>(
    `SELECT (SELECT close FROM candles
              WHERE pair = $1 AND interval = '1h' AND market_type = 'swap'
                AND open_time <= $2 ORDER BY open_time DESC LIMIT 1) AS now,
            (SELECT close FROM candles
              WHERE pair = $1 AND interval = '1h' AND market_type = 'swap'
                AND open_time <= $2 ORDER BY open_time DESC OFFSET 24 LIMIT 1) AS then`,
    [pair.toUpperCase(), new Date(atMs)]
  )
  if (!r?.now || !r?.then) return null
  return ((Number(r.now) / Number(r.then)) - 1) * 100
}

/** 现在这一刻的 24h 涨跌幅 */
export function chg24Of(pair: string): Promise<number | null> {
  return chg24At(pair, Date.now())
}

/**
 * 结构位止损：多单放在「最近 3 根的最低点下方一点」，空单对称。
 * 返回的价格已经 clamp 到 [0.4%, 1.5%]；clamp 后仍然越界（比如进场价离结构位太远）
 * 就退回 1.0% 的保守值，并把 `source` 标成 `fallback`。
 */
export async function structureStop(
  pair: string,
  side: 'long' | 'short',
  entry: number
): Promise<{stop: number | null; pct: number | null; source: 'structural' | 'fallback'}> {
  if (!(entry > 0)) return {stop: null, pct: null, source: 'fallback'}
  const bars = await recentBars(pair, 20)
  if (bars.length < 5) return {stop: null, pct: null, source: 'fallback'}
  const last3 = bars.slice(0, 3)
  const lows = last3.map(b => b.low)
  const highs = last3.map(b => b.high)
  const structural = side === 'long' ? Math.min(...lows) : Math.max(...highs)
  let pct = Math.abs((structural - entry) / entry) * 100
  if (!Number.isFinite(pct) || pct <= 0) return {stop: null, pct: null, source: 'fallback'}
  /*
   * 夹到 [0.4%, 1.5%]。
   *
   * ⚠️ 夹完仍然算 `structural` —— 它是「结构位被上下限修正过」，不是「没有结构位」。
   *    `fallback` 只留给**根本没数据**的情况（K 线不够 / 进场价缺失），
   *    这样界面上「（估算）」那两个字才有意义。
   */
  const clamped = Math.min(Math.max(pct, STOP_MIN_PCT), STOP_MAX_PCT)
  const stop =
    side === 'long' ? entry * (1 - clamped / 100) : entry * (1 + clamped / 100)
  return {stop, pct: clamped, source: 'structural'}
}

/** 一条持仓 → 体检卡（不做任何交易动作） */
async function cardOf(
  keyId: number,
  equity: number,
  p: LivePosition
): Promise<HealthCard> {
  const side: 'long' | 'short' = p.side === 'short' ? 'short' : 'long'
  const entry = Number(p.entryPrice) || 0
  const mark = Number(p.markPrice) || entry
  const amount = Math.abs(Number(p.amount) || 0)
  const notional = Number(p.notional) || entry * amount
  const openedAtMs = p.meta?.openedAt ?? null
  const holdMin = openedAtMs ? (Date.now() - openedAtMs) / 60000 : null

  const row = await queryOne<{
    stop_price: string | null
    stop_pct: string | null
    stop_source: string
    r_unit: string | null
    mfe_price: string | null
    mae_price: string | null
    chg24_entry: string | null
    opened_at: Date
  }>(
    `SELECT stop_price, stop_pct, stop_source, r_unit, mfe_price, mae_price, chg24_entry, opened_at
       FROM position_plans
      WHERE key_id = $1 AND symbol = $2 AND pos_side = $3 AND closed_at IS NULL
      ORDER BY opened_at DESC LIMIT 1`,
    [keyId, p.raw?.toUpperCase() ?? p.symbol, p.raw ? 'BOTH' : 'BOTH']
  )

  let stopPrice = row?.stop_price ? Number(row.stop_price) : null
  const stopPct = row?.stop_pct ? Number(row.stop_pct) : null
  let stopSource = row?.stop_source ?? 'fallback'
  let rUnit = row?.r_unit ? Number(row.r_unit) : null
  let stopPctFinal = stopPct
  /*
   * 计划里没有止损价（老仓 / 那张表上线前开的）⇒ **现场按结构位算一个**。
   * ⚠️ 算出来要把 `stopPrice` 一起填上 —— 只填 `rUnit` 会让卡片上有 R 却没有止损价，
   *    界面就变成「几 R 有数、止损位显示无」，自相矛盾（E2E 抓到过）。
   */
  if (!stopPrice) {
    const s = await structureStop(p.raw ?? p.symbol, side, entry)
    stopPrice = s.stop
    stopPctFinal = s.pct
    rUnit = s.stop ? Math.abs(entry - s.stop) : null
    stopSource = s.source
  }

  const dir = side === 'long' ? 1 : -1
  const r = rUnit && rUnit > 0 ? ((mark - entry) * dir) / rUnit : null

  /* MFE / MAE：内存里滚动，重启后从库里那两列恢复初值 */
  const ek = planKeyOf(keyId, p.raw ?? p.symbol, side)
  const prev = excursions.get(ek)
  const mfe = prev ? Math.max(prev.mfe, mark) : Number(row?.mfe_price ?? mark)
  const mae = prev ? Math.min(prev.mae, mark) : Number(row?.mae_price ?? mark)
  excursions.set(ek, {mfe, mae})
  const mfeR = rUnit && rUnit > 0 ? ((mfe - entry) * dir) / rUnit : null
  const maeR = rUnit && rUnit > 0 ? ((mae - entry) * dir) / rUnit : null

  const distToStopPct =
    stopPrice && mark > 0 ? (((mark - stopPrice) / mark) * dir) * 100 : null

  const bucket: 'lt30' | 'gte30' | null =
    holdMin === null ? null : holdMin < 30 ? 'lt30' : 'gte30'
  const bucketWinrate = bucket ? BASELINES[bucket].winRate : null

  /* ---- 三条提示（只陈列事实 + 你的历史） ---- */
  const tips: HealthCard['tips'] = []
  const now = Date.now()
  const push = (code: string, text: string) => {
    const k = `${ek}:${code}`
    const last = tipCooldown.get(k) ?? 0
    if (now - last < TIP_COOLDOWN_MS) return
    tipCooldown.set(k, now)
    tips.push({code, text})
  }
  if (holdMin !== null && holdMin >= 30 && r !== null && r < 0.5 && r < 0) {
    const b = BASELINES[bucket ?? 'gte30']
    const label = bucket === 'lt30' ? '<30 分钟' : '≥30 分钟'
    push(
      'time-stop',
      `已持仓 ${Math.round(holdMin)} 分钟，最大浮盈 ${(mfeR ?? 0).toFixed(2)}R，现价在成本下方。` +
        `你历史上 ${label}的单子 ${b.trades} 笔、胜率 ${Math.round(b.winRate * 100)}%。`
    )
  }
  if (distToStopPct !== null && distToStopPct < 0) {
    push('structure-broken', `已跌破进场时的结构位 ${stopPrice?.toPrecision(6)}，结构位失效。`)
  }
  if (r !== null && r >= 1 && distToStopPct !== null && distToStopPct < 0.5) {
    push(
      'one-r',
      `浮盈到 ${r.toFixed(1)}R，止损还在成本另一侧（离现价 ${distToStopPct.toFixed(2)}%）。`
    )
  }

  return {
    keyId,
    symbol: p.raw ?? p.symbol,
    unified: p.symbol,
    side,
    amount,
    entry,
    mark,
    leverage: Number(p.leverage) || 0,
    notional,
    unrealized: Number(p.unrealizedPnl) || 0,
    roe: p.percentage === null || p.percentage === undefined ? null : Number(p.percentage),
    accountLeverage: equity > 0 ? notional / equity : null,
    openedAt: openedAtMs ? new Date(openedAtMs).toISOString() : null,
    holdMin: holdMin === null ? null : Math.round(holdMin),
    stopPrice,
    stopPct: stopPctFinal,
    stopSource,
    rUnit,
    r,
    mfeR,
    maeR,
    distToStopPct,
    bucket,
    bucketWinrate,
    tips
  }
}

/**
 * 某个用户**当前所有持仓**的体检卡（跨 key）。
 *
 * ⚠️ 只读内存里的常驻流（`liveStateOf`）—— **不打交易所**。
 *    流没起来 / 那一套 key 没连上 ⇒ 那套 key 不出卡片（不是报错）。
 */
export async function listHealthCards(userId: number): Promise<HealthCard[]> {
  const keys = await listExchangeKeys(userId, {all: true})
  const out: HealthCard[] = []
  for (const k of keys) {
    const st = liveStateOf(k.id)
    if (!st || !st.positions?.length) continue
    const equity = Number(st.margin) || Number(st.wallet) || 0
    for (const p of st.positions) {
      if (!(Math.abs(Number(p.amount) || 0) > 0)) continue
      try {
        out.push(await cardOf(k.id, equity, p))
      } catch {
        /* 单个仓位算不出来不该让整页空掉 */
      }
    }
  }
  return out
}
