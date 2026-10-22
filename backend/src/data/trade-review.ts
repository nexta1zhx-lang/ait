/**
 * **盘后复盘** —— 每笔平仓之后给一条「事实 + 你的历史基准 + 一个改进点」。
 *
 * 用户 2026-10-22：「我不希望你再对我的开单有限制……我希望的是，在我开单之后，
 * 能针对盘中的状态以及盘后的复盘，给我一些改进的点」。
 *
 * ## 文案原则（改文案之前先读这一段）
 *
 * **只陈述，不命令。**
 *   ✅「你历史上 <30 分钟的单子 280 笔、胜率 20%。」
 *   ❌「你应该拿久一点。」
 *
 * 为什么：那些"基准"是从**同一批已经发生的单子**里分组算出来的 ——
 * 持仓时长是结果不是原因（赢的单才拿得住）。所以系统只负责把对照线摆出来，
 * 让用户自己看见，**不替他把结论下了**。
 *
 * ## 数据从哪来
 *   · 进场上下文：`position_plans`（开仓后由 `syncPositionJournal` 补一条）；
 *   · 平仓结果：`exchange_fills` 里这段时间的 `realized` 与 `fee`；
 *   · 基准：`position-live.ts` 的 `BASELINES`（426 笔算出来的常量）。
 */
import {query, queryOne} from '../db/client'
import {listExchangeKeys} from '../db/exchange-keys'
import {liveStateOf} from './position-cache'
import {listPositionHistory, type PositionCycle} from './position-history'
import {chg24At, chg24Of, structureStop, BASELINES} from './position-live'

/** 每多少笔生成一条阶段总结 */
const SUMMARY_EVERY = 20

export interface ReviewRow {
  id: number
  kind: 'trade' | 'summary'
  /** 属于哪一套 Key（账户）—— 2026-10-22：用户有两个账户，复盘要能分开看 */
  keyId: number | null
  /** 那一套 Key 的名字（「币安」/「测试」），复盘页当账户标签用 */
  accountName: string | null
  symbol: string | null
  side: string | null
  openedAt: string | null
  closedAt: string | null
  holdMin: number | null
  net: number | null
  fee: number | null
  buckets: string | null
  baselineWinrate: number | null
  verdict: string | null
  tip: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

function rowOf(r: Record<string, unknown>): ReviewRow {
  return {
    id: Number(r.id),
    kind: (r.kind as 'trade' | 'summary') ?? 'trade',
    keyId: r.key_id === null || r.key_id === undefined ? null : Number(r.key_id),
    accountName: (r.account_name as string) ?? null,
    symbol: (r.symbol as string) ?? null,
    side: (r.side as string) ?? null,
    openedAt: r.opened_at ? new Date(r.opened_at as string).toISOString() : null,
    closedAt: r.closed_at ? new Date(r.closed_at as string).toISOString() : null,
    holdMin: r.hold_min === null || r.hold_min === undefined ? null : Number(r.hold_min),
    net: r.net === null || r.net === undefined ? null : Number(r.net),
    fee: r.fee === null || r.fee === undefined ? null : Number(r.fee),
    buckets: (r.buckets as string) ?? null,
    baselineWinrate:
      r.baseline_winrate === null || r.baseline_winrate === undefined
        ? null
        : Number(r.baseline_winrate),
    verdict: (r.verdict as string) ?? null,
    tip: (r.tip as string) ?? null,
    detail: (r.detail as Record<string, unknown>) ?? null,
    createdAt: new Date(r.created_at as string).toISOString()
  }
}

/** 档位 → 基准（`hot` / `cold` / `middle` 按进场前 24h 涨跌幅分） */
function bucketsOf(holdMin: number | null, chg24: number | null, side: string): string[] {
  const out: string[] = []
  if (holdMin !== null) out.push(holdMin < 30 ? 'lt30' : 'gte30')
  if (chg24 !== null) {
    if (chg24 > 25) out.push('hot')
    else if (chg24 < -3) out.push('cold')
    else out.push('middle')
  }
  out.push(side === 'short' ? 'short' : 'long')
  return out
}

function bucketLabel(b: string): string {
  switch (b) {
    case 'lt30':
      return '<30 分钟'
    case 'gte30':
      return '≥30 分钟'
    case 'hot':
      return '进场前 24h 涨超 25%'
    case 'cold':
      return '进场前 24h 跌超 3%'
    case 'middle':
      return '24h 在 −3% ~ +25% 之间'
    case 'short':
      return '空单'
    default:
      return '多单'
  }
}

/**
 * 一条点评 + 一个改进点。
 *
 * 挑「当期偏差最大」的那一档说 —— 一条复盘只给一句建议，多了等于没有。
 */
function verdictOf(
  net: number,
  holdMin: number | null,
  chg24: number | null,
  side: string
): {verdict: string; tip: string; baseline: number | null} {
  const isWin = net > 0
  const parts: string[] = []
  let baseline: number | null = null

  if (holdMin !== null) {
    const b = holdMin < 30 ? BASELINES.lt30 : BASELINES.gte30
    baseline = b.winRate
    parts.push(
      `持仓 ${Math.round(holdMin)} 分钟（${bucketLabel(holdMin < 30 ? 'lt30' : 'gte30')}）：` +
        `你这一档 ${b.trades} 笔、胜率 ${Math.round(b.winRate * 100)}%、平均 ${b.avgNet >= 0 ? '+' : ''}${b.avgNet.toFixed(2)} U。`
    )
  }

  let tip = ''
  if (side === 'short' && chg24 !== null && chg24 > 10) {
    tip =
      `这笔是「24h 已涨 ${chg24.toFixed(0)}% 之后做空」。你 112 笔空单胜率 25%、合计 −112 U —— ` +
      `摸顶这一类是你账上最稳定的出血口。`
  } else if (chg24 !== null && chg24 > -3 && chg24 <= 25) {
    tip =
      `这笔进场前 24h 只动了 ${chg24.toFixed(1)}%，属于「中间地带」：` +
      `你这一档 249 笔、合计 −1,007 U，是亏得最多的一类。`
  } else if (holdMin !== null && holdMin < 30 && !isWin) {
    tip = `短档是你最大的出血口：280 笔合计 −1,128 U。这一笔也在里面。`
  } else if (holdMin !== null && holdMin >= 240) {
    tip = `长持这一档你只做了 47 笔，但净赚 +337 U —— 全部利润都来自这里。`
  } else if (isWin) {
    tip = `这笔赚钱了；同一档里你还有 ${Math.round((1 - (baseline ?? 0.3)) * 100)}% 的单子是亏的，说明它不是稳定来源。`
  } else {
    tip = `这笔亏了；先看它属于哪一档，再看那一档的历史合计，不要用单笔反推方法好坏。`
  }

  const verdict = `${isWin ? '盈利' : '亏损'} ${net >= 0 ? '+' : ''}${net.toFixed(2)} U。` + parts.join('')
  return {verdict, tip, baseline}
}

/** 这笔从开到平的账（直接从成交账本算，不依赖持仓缓存还在不在） */
async function closeStats(
  keyId: number,
  symbol: string,
  openedAt: Date
): Promise<{net: number; fee: number; closeAt: Date | null}> {
  const r = await queryOne<{real: string; fee: string; last: Date | null}>(
    `SELECT coalesce(sum(realized), 0) AS real,
            coalesce(sum(fee), 0) AS fee,
            max(ts) AS last
       FROM exchange_fills
      WHERE key_id = $1 AND upper(symbol) = upper($2) AND ts >= $3`,
    [keyId, symbol, openedAt]
  )
  const real = Number(r?.real ?? 0)
  const fee = Number(r?.fee ?? 0)
  return {net: real - fee, fee, closeAt: r?.last ? new Date(r.last) : null}
}

/**
 * 一跳同步：**开仓补计划 → 滚动 MFE/MAE → 平仓生成复盘 → 每 20 笔出总结**。
 *
 * 由 `server.ts` 的定时器每分钟调一次（照 `persist` 那套，不并发）。
 * ⚠️ 不碰下单链路：这张表只被读，不被任何交易接口引用。
 */
export async function syncPositionJournal(
  userId: number
): Promise<{opened: number; closed: number; reviews: number}> {
  let opened = 0
  let closed = 0
  let reviews = 0

  const keys = await listExchangeKeys(userId, {all: true})
  for (const k of keys) {
    const st = liveStateOf(k.id)
    const live = (st?.positions ?? []).filter(p => Math.abs(Number(p.amount) || 0) > 0)
    const liveKeys = new Set(live.map(p => `${(p.raw ?? p.symbol).toUpperCase()}:${p.side === 'short' ? 'short' : 'long'}`))

    /* ① 有仓没计划 → 补一条（开仓那一刻周围长什么样） */
    for (const p of live) {
      const side = p.side === 'short' ? 'short' : 'long'
      const symbol = (p.raw ?? p.symbol).toUpperCase()
      const exists = await queryOne<{id: string}>(
        `SELECT id FROM position_plans
          WHERE key_id = $1 AND symbol = $2 AND pos_side = 'BOTH' AND closed_at IS NULL
          ORDER BY opened_at DESC LIMIT 1`,
        [k.id, symbol]
      )
      if (exists) continue
      const entry = Number(p.entryPrice) || 0
      if (!(entry > 0)) continue
      const openedAtMs = p.meta?.openedAt ?? Date.now()
      const chg24 = await chg24Of(symbol)
      const s = await structureStop(symbol, side, entry)
      await query(
        `INSERT INTO position_plans
           (user_id, key_id, symbol, pos_side, side, opened_at, entry_price, qty, leverage,
            entry_tf, chg24_entry, stop_price, stop_pct, stop_source, r_unit,
            mfe_price, mae_price)
         VALUES ($1,$2,$3,'BOTH',$4,$5,$6,$7,$8,'15m',$9,$10,$11,$12,$13,$14,$14)
         ON CONFLICT (key_id, symbol, pos_side, opened_at) DO NOTHING`,
        [
          userId,
          k.id,
          symbol,
          side,
          new Date(openedAtMs),
          entry,
          Math.abs(Number(p.amount) || 0),
          Number(p.leverage) || null,
          chg24,
          s.stop,
          s.pct,
          s.source,
          s.stop ? Math.abs(entry - s.stop) : null,
          Number(p.markPrice) || entry
        ]
      )
      opened++
    }

    /* ② 计划还开着、仓位没了 → 平仓 + 生成复盘 */
    const openPlans = await query<Record<string, unknown>>(
      `SELECT * FROM position_plans
        WHERE key_id = $1 AND closed_at IS NULL`,
      [k.id]
    )
    for (const pl of openPlans) {
      const symbol = String(pl.symbol)
      const side = String(pl.side)
      if (liveKeys.has(`${symbol.toUpperCase()}:${side}`)) {
        /* 还开着：把 MFE/MAE 刷进去（每分钟一次，量很小） */
        const p = live.find(
          x => (x.raw ?? x.symbol).toUpperCase() === symbol.toUpperCase() && (x.side === 'short' ? 'short' : 'long') === side
        )
        const mark = Number(p?.markPrice) || 0
        if (mark > 0) {
          const dir = side === 'long' ? 1 : -1
          await query(
            `UPDATE position_plans
                SET mfe_price = CASE
                      WHEN mfe_price IS NULL THEN $2
                      WHEN ($2 - mfe_price) * $3 > 0 THEN $2 ELSE mfe_price END,
                    mae_price = CASE
                      WHEN mae_price IS NULL THEN $2
                      WHEN ($2 - mae_price) * $3 < 0 THEN $2 ELSE mae_price END
              WHERE id = $1`,
            [pl.id, mark, dir]
          )
        }
        continue
      }

      /* 仓位不见了 = 这条计划结束 */
      const openedAt = new Date(pl.opened_at as string)
      const {net, fee, closeAt} = await closeStats(k.id, symbol, openedAt)
      const end = closeAt ?? new Date()
      const holdMin = Math.max(0, Math.round((end.getTime() - openedAt.getTime()) / 60000))
      await query(`UPDATE position_plans SET closed_at = $2 WHERE id = $1`, [pl.id, end])
      closed++

      const chg24 = pl.chg24_entry === null ? null : Number(pl.chg24_entry)
      const buckets = bucketsOf(holdMin, chg24, side)
      const {verdict, tip, baseline} = verdictOf(net, holdMin, chg24, side)
      const detail = {
        entry: Number(pl.entry_price),
        qty: Number(pl.qty),
        leverage: pl.leverage === null ? null : Number(pl.leverage),
        stop: pl.stop_price === null ? null : Number(pl.stop_price),
        stopPct: pl.stop_pct === null ? null : Number(pl.stop_pct),
        stopSource: pl.stop_source,
        chg24Entry: chg24,
        mfe: pl.mfe_price === null ? null : Number(pl.mfe_price),
        mae: pl.mae_price === null ? null : Number(pl.mae_price),
        fee,
        net
      }
      const ins = await query(
        `INSERT INTO trade_reviews
           (user_id, key_id, kind, symbol, side, opened_at, closed_at, hold_min, net, fee,
            buckets, baseline_winrate, verdict, tip, detail)
         VALUES ($1,$2,'trade',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          userId,
          k.id,
          symbol,
          side,
          openedAt,
          end,
          holdMin,
          net,
          fee,
          buckets.join(','),
          baseline,
          verdict,
          tip,
          JSON.stringify(detail)
        ]
      )
      if (ins.length) reviews++
    }
  }

  if (reviews) await maybeSummary(userId)
  return {opened, closed, reviews}
}

/**
 * **阶段总结**：按平仓时间排序，每 `SUMMARY_EVERY` 笔一条。
 *
 * 幂等：靠 `detail.total` 去重 —— 同一批（比如第 20 笔）只会有一条，
 * 定时器反复跑、补历史重跑都不会刷屏。
 */
export async function rebuildSummaries(userId: number): Promise<number> {
  const all = await query<Record<string, unknown>>(
    `SELECT net, fee, hold_min, buckets FROM trade_reviews
      WHERE user_id = $1 AND kind = 'trade'
      ORDER BY closed_at ASC NULLS LAST, created_at ASC`,
    [userId]
  )
  let created = 0
  for (let total = SUMMARY_EVERY; total <= all.length; total += SUMMARY_EVERY) {
    const dup = await queryOne<{id: string}>(
      `SELECT id FROM trade_reviews
        WHERE user_id = $1 AND kind = 'summary' AND detail->>'total' = $2 LIMIT 1`,
      [userId, String(total)]
    )
    if (dup) continue

    const rows = all.slice(total - SUMMARY_EVERY, total)
    const nets = rows.map(r => Number(r.net ?? 0))
    const wins = nets.filter(v => v > 0)
    const losses = nets.filter(v => v < 0)
    const sum = nets.reduce((a, b) => a + b, 0)
    const fee = rows.reduce((a, r) => a + Number(r.fee ?? 0), 0)
    const payoff =
      wins.length && losses.length
        ? wins.reduce((a, b) => a + b, 0) /
          wins.length /
          Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
        : 0

    const tally = new Map<string, number>()
    for (const r of rows) {
      for (const b of String(r.buckets ?? '').split(',').filter(Boolean)) {
        tally.set(b, (tally.get(b) ?? 0) + Number(r.net ?? 0))
      }
    }
    const worst = [...tally.entries()].sort((a, b) => a[1] - b[1])[0]
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]

    const verdict =
      `第 ${total - SUMMARY_EVERY + 1}–${total} 笔：净 ${sum >= 0 ? '+' : ''}${sum.toFixed(2)} U，` +
      `胜率 ${Math.round((wins.length / rows.length) * 100)}%，盈亏比 ${payoff.toFixed(2)}，` +
      `手续费 ${fee.toFixed(2)} U。`
    const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
    const tip = worst
      ? `这 ${rows.length} 笔里最亏的是「${bucketLabel(worst[0])}」：${sign(worst[1])} U` +
        (best && best[0] !== worst[0] && best[1] > 0
          ? `；唯一赚钱的是「${bucketLabel(best[0])}」：${sign(best[1])} U。`
          : best && best[1] <= 0
            ? '；这一批没有任何一档是赚的。'
            : '。')
      : '样本还不够分档。'

    const ins = await query(
      `INSERT INTO trade_reviews
         (user_id, kind, verdict, tip, detail, created_at)
       VALUES ($1, 'summary', $2, $3, $4, now())
       RETURNING id`,
      [userId, verdict, tip, JSON.stringify({count: rows.length, total, sum, fee, payoff})]
    )
    if (ins.length) created++
  }
  return created
}

/** 兼容旧调用点：有没有新总结要看库里，直接重建一遍（幂等，写不重） */
export async function maybeSummary(userId: number): Promise<number> {
  return rebuildSummaries(userId)
}

/**
 * **给历史仓位补复盘**（这张表上线之前平掉的单子没有 `position_plans`）。
 *
 * 幂等：同一个 (key, symbol, opened_at) 已经有复盘就跳过。
 * 用于「先把过去 426 笔的复盘补出来」——不然这个页面第一次打开是空的。
 */
export async function backfillReviews(
  userId: number,
  keyId: number,
  limit = 1000
): Promise<number> {
  const hist = await listPositionHistory(userId, keyId, limit)
  let n = 0
  for (const c of hist.cycles) {
    if (!c.closeAt) continue
    const openedAt = new Date(c.openAt)
    if (!Number.isFinite(openedAt.getTime())) continue
    const exists = await queryOne<{id: string}>(
      `SELECT id FROM trade_reviews
        WHERE key_id = $1 AND upper(symbol) = upper($2) AND opened_at = $3 AND kind = 'trade'
        LIMIT 1`,
      [keyId, c.symbol, openedAt]
    )
    if (exists) continue

    const holdMin = Math.max(0, Math.round((c.holdSec ?? 0) / 60))
    const chg24 = await chg24At(c.symbol, openedAt.getTime())
    const buckets = bucketsOf(holdMin, chg24, c.side)
    const {verdict, tip, baseline} = verdictOf(c.net, holdMin, chg24, c.side)
    const detail = {
      entry: c.entryPrice,
      exit: c.exitPrice,
      qty: c.qty,
      leverage: c.leverage,
      chg24Entry: chg24,
      fee: c.fee,
      net: c.net,
      backfilled: true
    }
    const ins = await query(
      `INSERT INTO trade_reviews
         (user_id, key_id, kind, symbol, side, opened_at, closed_at, hold_min, net, fee,
          buckets, baseline_winrate, verdict, tip, detail)
       VALUES ($1,$2,'trade',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        userId,
        keyId,
        c.symbol,
        c.side,
        openedAt,
        new Date(c.closeAt),
        holdMin,
        c.net,
        c.fee,
        buckets.join(','),
        baseline,
        verdict,
        tip,
        JSON.stringify(detail)
      ]
    )
    if (ins.length) n++
  }
  if (n) await maybeSummary(userId)
  return n
}

/**
 * 复盘列表。
 *
 * 排序**按交易时间**（`closed_at`），不是按写库时间 —— 补历史那批是同一秒写的，
 * 按 `created_at` 排出来是乱序（用户 2026-10-22：「数据不对，我历史到 10 月份」）。
 *
 * 筛选：
 *   · `keyId`  —— 哪一套 Key（账户）；`summary` 跨账户，不受它影响
 *   · `result` —— `win` / `loss`
 *   · `hold`   —— `lt30` / `gte30`
 *   · `order`  —— `asc`（默认，由前到后）/ `desc`
 */
export interface ReviewQuery {
  keyId?: number | null
  result?: 'win' | 'loss' | null
  hold?: 'lt30' | 'gte30' | null
  order?: 'asc' | 'desc'
}

export async function listReviews(
  userId: number,
  kind: 'trade' | 'summary' = 'trade',
  limit = 50,
  q: ReviewQuery = {}
): Promise<ReviewRow[]> {
  const order = q.order === 'desc' ? 'DESC' : 'ASC'
  const rows = await query<Record<string, unknown>>(
    `SELECT r.*, k.name AS account_name
       FROM trade_reviews r
       LEFT JOIN user_exchange_keys k ON k.id = r.key_id
      WHERE r.user_id = $1 AND r.kind = $2
        AND ($4::bigint IS NULL OR r.kind = 'summary' OR r.key_id = $4)
        AND ($5::text  IS NULL OR ($5 = 'win'  AND r.net > 0) OR ($5 = 'loss' AND r.net < 0))
        AND ($6::text  IS NULL OR ($6 = 'lt30' AND r.hold_min < 30) OR ($6 = 'gte30' AND r.hold_min >= 30))
      ORDER BY COALESCE(r.closed_at, r.created_at) ${order}, r.id ${order}
      LIMIT $3`,
    [userId, kind, Math.min(Math.max(limit, 1), 500), q.keyId ?? null, q.result ?? null, q.hold ?? null]
  )
  return rows.map(rowOf)
}

/** 同一套筛选下的总条数（列表有 limit，界面要显示「300 / 435」） */
export async function countReviews(
  userId: number,
  kind: 'trade' | 'summary' = 'trade',
  q: ReviewQuery = {}
): Promise<number> {
  const r = await queryOne<{n: string}>(
    `SELECT count(*)::text AS n
       FROM trade_reviews r
      WHERE r.user_id = $1 AND r.kind = $2
        AND ($3::bigint IS NULL OR r.kind = 'summary' OR r.key_id = $3)
        AND ($4::text  IS NULL OR ($4 = 'win'  AND r.net > 0) OR ($4 = 'loss' AND r.net < 0))
        AND ($5::text  IS NULL OR ($5 = 'lt30' AND r.hold_min < 30) OR ($5 = 'gte30' AND r.hold_min >= 30))`,
    [userId, kind, q.keyId ?? null, q.result ?? null, q.hold ?? null]
  )
  return Number(r?.n ?? 0)
}

export async function getReview(userId: number, id: number): Promise<ReviewRow | null> {
  const r = await queryOne<Record<string, unknown>>(
    `SELECT * FROM trade_reviews WHERE user_id = $1 AND id = $2`,
    [userId, id]
  )
  return r ? rowOf(r) : null
}

/* ============================================================
 * **周期总结**（2026-10-22 晚：用户不要「每笔 / 总结」两个 tab 了，
 *   改成「自己选一段时间 → 出这一段的总结」）。
 *
 * 数据直接从成交账本还原的仓位周期算（`position-history`），
 * **不依赖 `trade_reviews` 表** —— 所以也不需要「补历史」和每分钟同步。
 * ============================================================ */

export interface RangeBucket {
  key: string
  label: string
  count: number
  wins: number
  net: number
}

export interface RangeSummary {
  from: string | null
  to: string | null
  count: number
  net: number
  grossProfit: number
  grossLoss: number
  fee: number
  /** 胜率 0~1 */
  winRate: number
  /** 盈亏比（均盈 / 均亏） */
  payoff: number
  /** 中位持仓（分钟） */
  medianHoldMin: number
  maxWin: number
  maxLoss: number
  byHold: RangeBucket[]
  bySide: RangeBucket[]
  /** 按币种，赚最多的前 5 / 亏最多的前 5 */
  topSymbols: RangeBucket[]
  worstSymbols: RangeBucket[]
}

const HOLD_BUCKETS: {key: string; label: string; max: number}[] = [
  {key: 'lt30', label: '不到 30 分钟', max: 30},
  {key: '30to240', label: '30 分钟 – 4 小时', max: 240},
  {key: 'gt240', label: '4 小时以上', max: Infinity}
]

/** 一段时间的总结。`from` / `to` 是毫秒时间戳，不给就是全部。 */
export async function summarizeRange(
  userId: number,
  keyId: number | null,
  fromMs: number | null,
  toMs: number | null
): Promise<RangeSummary> {
  const keys = await listExchangeKeys(userId, {all: true})
  const target = keyId ? keys.filter(k => k.id === keyId) : keys
  const cycles: {
    symbol: string
    side: string
    holdSec: number
    net: number
    fee: number
  }[] = []
  for (const k of target) {
    const hist = await listPositionHistory(userId, k.id, 5000, undefined, {
      from: fromMs,
      to: toMs
    })
    for (const c of hist.cycles) {
      if (!c.closeAt) continue
      cycles.push({symbol: c.symbol, side: c.side, holdSec: c.holdSec ?? 0, net: c.net, fee: c.fee})
    }
  }

  const nets = cycles.map(c => c.net)
  const wins = nets.filter(v => v > 0)
  const losses = nets.filter(v => v < 0)
  const net = nets.reduce((a, b) => a + b, 0)
  const fee = cycles.reduce((a, c) => a + c.fee, 0)
  const holds = cycles.map(c => c.holdSec / 60).sort((a, b) => a - b)

  const group = (
    pick: (c: {symbol: string; side: string; holdSec: number}) => string,
    labels: Record<string, string>
  ): RangeBucket[] => {
    const m = new Map<string, {count: number; wins: number; net: number}>()
    for (const c of cycles) {
      const k = pick(c)
      const cur = m.get(k) ?? {count: 0, wins: 0, net: 0}
      cur.count++
      if (c.net > 0) cur.wins++
      cur.net += c.net
      m.set(k, cur)
    }
    return [...m.entries()].map(([key, v]) => ({
      key,
      label: labels[key] ?? key,
      count: v.count,
      wins: v.wins,
      net: Math.round(v.net * 100) / 100
    }))
  }

  const byHold = HOLD_BUCKETS.map(b => {
    const rows = cycles.filter(c => {
      const m = c.holdSec / 60
      const prev = HOLD_BUCKETS[HOLD_BUCKETS.indexOf(b) - 1]
      const min = prev ? prev.max : -Infinity
      return m >= min && m < b.max
    })
    return {
      key: b.key,
      label: b.label,
      count: rows.length,
      wins: rows.filter(c => c.net > 0).length,
      net: Math.round(rows.reduce((a, c) => a + c.net, 0) * 100) / 100
    }
  })

  const bySide = group(c => c.side, {long: '多单', short: '空单'})
  const bySym = group(c => c.symbol, {})
    .sort((a, b) => b.net - a.net)

  return {
    from: fromMs ? new Date(fromMs).toISOString() : null,
    to: toMs ? new Date(toMs).toISOString() : null,
    count: cycles.length,
    net: Math.round(net * 100) / 100,
    grossProfit: Math.round(wins.reduce((a, b) => a + b, 0) * 100) / 100,
    grossLoss: Math.round(losses.reduce((a, b) => a + b, 0) * 100) / 100,
    fee: Math.round(fee * 100) / 100,
    winRate: cycles.length ? wins.length / cycles.length : 0,
    payoff:
      wins.length && losses.length
        ? (wins.reduce((a, b) => a + b, 0) / wins.length) /
          Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
        : 0,
    medianHoldMin: holds.length ? Math.round(holds[Math.floor(holds.length / 2)]!) : 0,
    maxWin: nets.length ? Math.max(...nets) : 0,
    maxLoss: nets.length ? Math.min(...nets) : 0,
    byHold,
    bySide,
    topSymbols: bySym.slice(0, 5).map(x => ({...x, label: x.key.replace(/USDT$/, '')})),
    worstSymbols: bySym
      .slice(-5)
      .reverse()
      .map(x => ({...x, label: x.key.replace(/USDT$/, '')}))
  }
}

/* ============================================================
 * **仓位明细**（2026-10-22 晚）：用户要「点开具体的一笔，看持仓多久、
 * 最大盈利多少、回撤多少」，并且明确「不要以每笔成交为单位，
 * 因为一次交易可能拆成了多个订单」。
 *
 * ⇒ 单位是**仓位周期**（`position-history` 的 `PositionCycle`：0 → 有量 → 加仓 → 减仓 → 归零），
 *    一笔成交只是它下面的一张单（`orders`）。
 *
 * MFE / MAE（最大浮盈 / 最大回撤）从 `candles` 算：
 *   · 优先 15m（2026-09-22 起才有全量）；
 *   · 没有就退 1h（2026-04-10 起有）；
 *   · 两档都没数据 ⇒ `null`，界面显示「无分钟级数据」，**不要拿 0 糊弄**。
 * ⚠️ 1h 对几分钟的仓基本没有分辨率（最多一根 K 线），所以响应里带上 `resolution`，
 *    界面要如实标出来。
 * ============================================================ */

export interface CycleDetail {
  symbol: string
  side: 'long' | 'short'
  openAt: string
  closeAt: string | null
  holdSec: number
  entry: number | null
  exit: number | null
  qty: number
  leverage: number | null
  realized: number
  fee: number
  funding: number
  net: number
  /** 成交笔数（一次交易可能拆成很多张单） */
  fills: number
  /** 最大浮盈 / 最大回撤（相对开仓价，正数百分比；`null` = 没数据） */
  mfePct: number | null
  maePct: number | null
  /** 同样两个数换算成 U（按开仓量算，只是估算） */
  mfeUsd: number | null
  maeUsd: number | null
  /** 这两个数是哪一档 K 线算出来的：15m / 1h / null */
  resolution: '1m' | '15m' | '1h' | null
  orders: {
    time: string
    side: 'buy' | 'sell'
    amount: number
    price: number
    fee: number
    realized: number
    reduce: boolean
  }[]
}

/**
 * 一个仓位周期内的最高 / 最低价。
 *
 * ⚠️ 边界必须**往回退一根**：开仓在 14:32，覆盖它的那根 15m 是 **14:30 开的**
 *    （`open_time` 14:30 < 开仓时刻），按 `open_time >= 开仓` 过滤会把这一根漏掉 ——
 *    十来分钟的仓会一根都取不到、MFE 直接是 null（2026-10-22 实测踩过）。
 *
 * 精度：1m → 15m → 1h 依次退。1m 只在 2026-10-15 之后有，15m 从 09-22 起，
 * 1h 从 04-10 起；三档都没有就返回 null，界面显示「无分钟级数据」。
 */
async function excursion(
  pair: string,
  fromMs: number,
  toMs: number
): Promise<{hi: number; lo: number; res: '1m' | '15m' | '1h'} | null> {
  const LOOKBACK: Record<'1m' | '15m' | '1h', number> = {
    '1m': 60_000,
    '15m': 15 * 60_000,
    '1h': 60 * 60_000
  }
  for (const iv of ['1m', '15m', '1h'] as const) {
    const r = await queryOne<{hi: string | null; lo: string | null; n: string}>(
      `SELECT max(high) AS hi, min(low) AS lo, count(*)::text AS n
         FROM candles
        WHERE pair = $1 AND interval = $2 AND market_type = 'swap'
          AND open_time >= $3 AND open_time <= $4`,
      [pair.toUpperCase(), iv, new Date(fromMs - LOOKBACK[iv]), new Date(toMs)]
    )
    if (r && Number(r.n) > 0) return {hi: Number(r.hi), lo: Number(r.lo), res: iv}
  }
  return null
}

/**
 * 一段时间里的**仓位明细**（按平仓时间倒序，最近的在最前）。
 * `limit` 只管返回多少条，不参与统计。
 */
export async function listCycleDetails(
  userId: number,
  keyId: number | null,
  fromMs: number | null,
  toMs: number | null,
  limit = 200
): Promise<CycleDetail[]> {
  const keys = await listExchangeKeys(userId, {all: true})
  const target = keyId ? keys.filter(k => k.id === keyId) : keys
  /** 先收齐，再并发算 MFE（`c` 是 `PositionCycle`，类型从 `listPositionHistory` 推不出来就标 any） */
  const raw: {c: PositionCycle; k: number}[] = []

  for (const k of target) {
    const hist = await listPositionHistory(userId, k.id, Math.min(Math.max(limit, 1), 500), undefined, {
      from: fromMs,
      to: toMs
    })
    for (const c of hist.cycles) if (c.closeAt) raw.push({c, k: k.id})
  }

  /*
   * MFE/MAE 每段要查一次 K 线 —— 一段一段串行跑，200 段要 2 秒多。
   * 分 8 条并发（连接池默认 10 条，留两条给别的请求），实测能压到 0.5 秒级。
   */
  const CHUNK = 8
  const out: CycleDetail[] = []
  for (let i = 0; i < raw.length; i += CHUNK) {
    const part = await Promise.all(
      raw.slice(i, i + CHUNK).map(async ({c}) => {
        const openMs = Date.parse(c.openAt)
        const closeMs = Date.parse(c.closeAt!)
        let mfePct: number | null = null
        let maePct: number | null = null
        let mfeUsd: number | null = null
        let maeUsd: number | null = null
        let resolution: '1m' | '15m' | '1h' | null = null
        if (c.entryPrice && Number.isFinite(openMs) && Number.isFinite(closeMs) && closeMs > openMs) {
          const ex = await excursion(c.symbol, openMs, closeMs).catch(() => null)
          if (ex) {
            resolution = ex.res
            const dir = c.side === 'long' ? 1 : -1
            const up = ((ex.hi - c.entryPrice) / c.entryPrice) * 100
            const dn = ((ex.lo - c.entryPrice) / c.entryPrice) * 100
            mfePct = dir > 0 ? up : -dn
            maePct = dir > 0 ? dn : -up
            const notional = c.entryPrice * c.qty
            mfeUsd = (mfePct / 100) * notional
            maeUsd = (maePct / 100) * notional
          }
        }
        const d: CycleDetail = {
          symbol: c.symbol,
          side: c.side,
          openAt: c.openAt,
          closeAt: c.closeAt,
          holdSec: c.holdSec,
          entry: c.entryPrice,
          exit: c.exitPrice,
          qty: c.qty,
          leverage: c.leverage,
          realized: c.realized,
          fee: c.fee,
          funding: c.funding,
          net: c.net,
          fills: c.orders.length,
          mfePct,
          maePct,
          mfeUsd,
          maeUsd,
          resolution,
          orders: c.orders.map((o: PositionCycle['orders'][number]) => ({
            time: o.time,
            side: o.side,
            amount: o.amount,
            price: o.price,
            fee: o.fee,
            realized: o.realized,
            reduce: o.reduce
          }))
        }
        return d
      })
    )
    out.push(...part)
  }

  return out.sort((a, b) => (b.closeAt ?? '').localeCompare(a.closeAt ?? '')).slice(0, limit)
}
