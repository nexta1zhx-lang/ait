/**
 * 仓位历史（「开仓 → 结仓」一整个来回，像币安「仓位历史」那条）。
 *
 * ★ 用户 2026-10-06 的原话：
 *   「盈亏界面不是统计数据，是每笔仓位的概念，意思是就是开仓到结仓的中间的盈利，
 *     发生减仓的不算在盈亏中统计全平仓的概念，像币安的仓位历史那样，包括
 *     币种 盈利 开仓均价 平仓均价 开平仓时间 持仓时间，点击还可以查看详情
 *     包括每笔订单信息，减仓的要有实现盈利」
 *
 *   ⇒ 所以**不是**「把 income 按类型加起来」，而是把**成交账本**
 *     （`exchange_fills`，WS 实时落 + REST 定期对账补，全站唯一一份）按币种
 *     还原成一段段**仓位周期**：
 *
 *        开仓（0 → 有量）──加仓──减仓──减仓──全平（回 0）  ← 这才算「一笔」
 *
 *     减仓**不单独算一笔**，它的已实现盈亏归到「这一整段」头上
 *     （但仍逐笔留在详情里，用户要看得到「减仓那下赚了多少」）。
 *
 * ⚠️ 数据只有账本里有的那些（币安 `userTrades` 只给最近 7 天，账本也就这么多），
 *    所以**开头可能不完整** —— 第一笔就是平仓的那种段会被标成 `partial`，
 *    界面上要说明白，别让人以为开仓价是 0。
 */
import {query} from '../db/client'

/** 一段周期里的一笔成交（点开详情看的那份） */
export interface PositionOrder {
  /** 成交号（币安的 `tradeId`，前端当 key） */
  id: string
  time: string
  side: 'buy' | 'sell'
  amount: number
  price: number
  /** 手续费（正数，计价币） */
  fee: number
  /** 这一笔的**已实现盈亏**（只有减仓 / 平仓那几笔不为 0） */
  realized: number
  /** 这一笔是**加仓**还是**减仓**（同一方向上再买 = 加仓） */
  reduce: boolean
}

export interface PositionCycle {
  /** 币安原始符号（`1000BONKUSDT`） */
  symbol: string
  side: 'long' | 'short'
  /** 开仓均价（按加仓量加权）。⚠️ 账本不全时为 `null`，界面上显示「—」 */
  entryPrice: number | null
  /** 平仓均价（按减仓量加权；减仓多次就是这几次的均价） */
  exitPrice: number | null
  /** 累计开仓量（加仓之和） */
  qty: number
  /** 累计平仓量（减仓之和）= 全平后等于 `qty` */
  closedQty: number
  /** 已实现盈亏（**毛**：所有平仓那几笔的 `realized` 之和） */
  realized: number
  /** 这一段所有成交的手续费之和（正数） */
  fee: number
  /**
   * 这一段持仓期间的**资金费**（`FUNDING_FEE`，**钱账本**里那一项）。
   *
   * ⚠️ 符号跟着钱走：**负 = 付出、正 = 收到**（币安 `income` 就是这个口径）。
   * ⚠️ 它**不在成交账本里**，只能按「同一个币 + 时间落在这段的开平之间」归过来，
   *    所以持仓为 0 那段时间收/付的资金费归不到任何一段（在「资金动向」里能看到）。
   */
  funding: number
  /**
   * **净盈亏** = 已实现 − 手续费 **+ 资金费**（列表上显示的就是它）。
   *
   * ⚠️ 资金费也算这一笔真花的钱（用户 2026-10-06 追问「为什么资金费不计入」），
   *    所以并进去了；`funding` 自带符号 ⇒ 这里就是直接加，
   *    注意它在 `finish()` 里算不出来（要等钱账本归过来，见 `listPositionHistory`）。
   */
  net: number
  /** 首次开仓时间 */
  openAt: string
  /** 全平时间（`null` = 还没平完） */
  closeAt: string | null
  /** 持仓秒数（还没平完 = 开仓到现在） */
  holdSec: number
  /** 是否已全平（列表只列已平的；未平的在界面上单独提一句） */
  closed: boolean
  /**
   * 账本不完整：这一段的第一笔**本身就是平仓**（`realized != 0`），
   * 说明开仓发生在账本覆盖范围之前 ⇒ 开仓均价 / 持仓时长都只能是个残值。
   */
  partial: boolean
  /** 逐笔订单（时间升序） */
  orders: PositionOrder[]
}

/** 数量比到这个量级就算 0（币安的数量有 8 位小数） */
const EPS = 1e-8
/** 金额留 8 位（跟库里 `numeric(20,8)` 一致） */
const r8 = (v: number): number => Math.round(v * 1e8) / 1e8

/**
 * 把**一个币种**的成交还原成仓位周期。
 *
 * 逐笔扫：仓位从 0 起来就开一段，同方向就是加仓，反方向就是减仓；
 * 回到 0 就结一段、推进结果。**反手**（一笔把仓位打过 0 直接变反向持仓）
 * 会把这一笔按量拆开：先结掉旧段，剩下的量当新段的第一笔。
 */
export function buildCycles(rows: FillLike[]): PositionCycle[] {
  const out: PositionCycle[] = []
  let cur: CycleBuild | null = null

  for (const f of rows) {
    const side = f.side === 'sell' ? 'short' : 'long'
    let left = f.amount
    if (!(left > EPS)) continue

    while (left > EPS) {
      if (!cur) {
        /*
         * ⚠️ 这一段的第一笔就有 `realized` ⇒ 它其实是**平仓**，
         *    真实开仓在账本覆盖范围之前（币安 `userTrades` 只给 7 天）。
         *    按「反方向已有持仓」把它接上，并打 `partial` 标记 ——
         *    否则这笔平仓会被当成「开了一个反向仓」，整段方向全反。
         */
        const partial = f.realized !== 0
        cur = {
          symbol: f.symbol,
          side: partial ? (side === 'long' ? 'short' : 'long') : side,
          partial,
          pos: 0,
          qty: 0,
          entryNotional: 0,
          closedQty: 0,
          exitNotional: 0,
          realized: 0,
          fee: 0,
          openAt: f.ts,
          closeAt: null,
          orders: []
        }
        if (partial) {
          /* 凭空补上一个「未知量的持仓」，好让下面那笔正常算成减仓 */
          cur.pos = left
          cur.closedQty = 0
        }
        continue
      }

      const add = side === cur.side
      const take = add ? left : Math.min(left, cur.pos)
      if (!(take > EPS)) {
        /* 减到 0 了还没消化完 ⇒ 反手：结掉旧段，剩下的留给下一轮 */
        out.push(finish(cur, f.ts))
        cur = null
        continue
      }

      /*
       * 一笔成交量可能**跨段**（反手时被拆开），所以已实现盈亏、手续费
       * 都按「这一笔里落在本段的比例」分摊 —— 不然一段会把整笔的钱都领走。
       */
      const share = take / f.amount
      cur.fee += f.fee * share
      if (add) {
        cur.qty += take
        cur.entryNotional += f.price * take
        cur.pos += take
      } else {
        cur.closedQty += take
        cur.exitNotional += f.price * take
        cur.realized += f.realized * share
        cur.pos -= take
      }
      cur.orders.push({
        id: f.id,
        time: f.ts,
        side: f.side === 'sell' ? 'sell' : 'buy',
        amount: take,
        price: f.price,
        fee: r8(f.fee * share),
        realized: r8(f.realized * share),
        reduce: !add
      })
      left -= take

      if (cur.pos <= EPS) {
        out.push(finish(cur, f.ts))
        cur = null
        /* 反手：`left` 还有量，下一轮 `cur === null` 会按这笔的方向开新段 */
      }
    }
  }
  /* 还没平完的那段也回给前端（界面上要提一句「还有 N 个没平」） */
  if (cur) out.push(finish(cur, null))

  return out
}

interface CycleBuild {
  symbol: string
  side: 'long' | 'short'
  partial: boolean
  pos: number
  qty: number
  entryNotional: number
  closedQty: number
  exitNotional: number
  realized: number
  fee: number
  openAt: string
  closeAt: string | null
  orders: PositionOrder[]
}

function finish(c: CycleBuild, closeAt: string | null): PositionCycle {
  const closed = c.pos <= EPS
  /* `partial` 的那段没有真实开仓记录 ⇒ 开仓均价给 `null`，别编一个数出来 */
  const entryPrice = c.qty > EPS ? c.entryNotional / c.qty : null
  const exitPrice = c.closedQty > EPS ? c.exitNotional / c.closedQty : null
  const endAt = closed ? closeAt : new Date().toISOString()
  const t0 = Date.parse(c.openAt)
  const t1 = Date.parse(endAt ?? c.openAt)
  return {
    symbol: c.symbol,
    side: c.side,
    entryPrice: entryPrice === null ? null : r8(entryPrice),
    exitPrice: exitPrice === null ? null : r8(exitPrice),
    qty: r8(c.qty),
    closedQty: r8(c.closedQty),
    realized: r8(c.realized),
    fee: r8(c.fee),
    /* 资金费后面从钱账本单独归过来（见 `listPositionHistory`），这里先起 0；
       归到之后再把它加进 `net` */
    funding: 0,
    net: r8(c.realized - c.fee),
    openAt: c.openAt,
    closeAt: closed ? closeAt : null,
    holdSec: Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, Math.round((t1 - t0) / 1000)) : 0,
    closed,
    partial: c.partial,
    orders: c.orders
  }
}

/** `exchange_fills` 里我们用到的那几列 */
interface FillLike {
  id: string
  symbol: string
  side: string
  price: number
  amount: number
  fee: number
  realized: number
  ts: string
}

export interface PositionHistoryResult {
  /** **已全平**的仓位周期（最近平的在最前）—— 「盈亏」列表就是它 */
  cycles: PositionCycle[]
  /**
   * **还没平完**的（最近开仓的在最前）。
   *
   * ⚠️ 单独一组、不混进 `cycles`：用户要的是「全平才算一笔盈亏」，
   *    把未平的混进去会让「盈利」忽上忽下。但它必须**能看得到** ——
   *    用户还要「减仓的要有实现盈利」，而那些减仓就发生在未平这一段的详情里。
   */
  open: PositionCycle[]
  /** 还没平完的有几个 */
  openCount: number
  /** 账本里最早的成交时间（这个时间点之前的历史没进账本） */
  since: string | null
  /** Range-wide statistics over all completed cycles, before the display limit is applied. */
  summary: {
    closedCount: number
    wins: number
    losses: number
    breakeven: number
    grossProfit: number
    grossLoss: number
    net: number
    realized: number
    fees: number
    funding: number
    longCount: number
    shortCount: number
    averageHoldSec: number
  }
  breakdown: {
    bySymbol: {key: string; closedCount: number; wins: number; net: number}[]
    byDirection: {key: 'long' | 'short'; closedCount: number; wins: number; net: number}[]
    byHoldDuration: {key: 'short' | 'medium' | 'long'; closedCount: number; wins: number; net: number}[]
    incompleteHoldCount: number
    profitConcentration: {selectedCount: number; totalCount: number; amount: number; sharePct: number}
    lossConcentration: {selectedCount: number; totalCount: number; amount: number; sharePct: number}
    entryReasonAvailable: false
  }
  daily: {date: string; net: number; cumulative: number; count: number}[]
}

/**
 * 读某套 Key 的仓位历史。
 *
 * `symbol` 给了就只看这个币（K 线那边按币看用得上）。
 * ⚠️ **纯本地读**，不打交易所 —— 数据就是成交账本那 27 行级别的东西，
 *    每次算一遍也就几毫秒。
 */
/**
 * 一段**时间范围**（毫秒，含端点）。都不给 = 不限。
 *
 * ⚠️ 口径：只筛**已平的那些**（`closeAt` 落在范围里）——
 *    「这条仓位最后平在什么时候」才是列表上看到的那一行。
 *    到点的那一段是从**全量成交**里算出来的，所以即使它开仓早于 `from`，
 *    数字仍然是**整段**的（不会变成"半截仓位"）。
 */
export interface HistoryRange {
  from?: number | null
  to?: number | null
}

export async function listPositionHistory(
  userId: number,
  keyId: number,
  limit = 50,
  symbol?: string,
  range: HistoryRange = {}
): Promise<PositionHistoryResult> {
  const rows = await query<Record<string, unknown>>(
    `SELECT trade_id, symbol, side, price, amount, fee, realized, ts
       FROM exchange_fills
      WHERE user_id = $1 AND key_id = $2
        AND ($3::text IS NULL OR upper(symbol) = upper($3::text))
      ORDER BY ts ASC, trade_id ASC`,
    [userId, keyId, symbol ?? null]
  )
  const fills: FillLike[] = rows.map(r => ({
    id: String(r.trade_id ?? ''),
    symbol: String(r.symbol ?? ''),
    side: String(r.side ?? ''),
    price: num(r.price),
    amount: num(r.amount),
    fee: num(r.fee),
    realized: num(r.realized),
    ts: r.ts ? new Date(String(r.ts)).toISOString() : ''
  }))

  /* 按币种分组再还原（仓位是**每个币各自**的） */
  const bySymbol = new Map<string, FillLike[]>()
  for (const f of fills) {
    if (!f.symbol || !f.ts) continue
    const list = bySymbol.get(f.symbol)
    if (list) list.push(f)
    else bySymbol.set(f.symbol, [f])
  }

  const all: PositionCycle[] = []
  for (const list of bySymbol.values()) all.push(...buildCycles(list))

  /*
   * 资金费：**成交账本里没有这一项**，它在钱账本（`exchange_income`）里，
   * 所以单独取回来，按「同一个币 + 时间落在这段的开仓~平仓之间」归给某一段
   * （用户 2026-10-06：「仓位历史底部已实现改为资金费用」）。
   * ⚠️ 归不到（持仓为 0 那会儿收/付的）就丢掉 —— 那段钱在「资金动向」里看得到。
   */
  const feeRows = await query<Record<string, unknown>>(
    `SELECT symbol, amount, ts
       FROM exchange_income
      WHERE user_id = $1 AND key_id = $2 AND income_type = 'FUNDING_FEE'
        AND ($3::text IS NULL OR upper(symbol) = upper($3::text))`,
    [userId, keyId, symbol ?? null]
  )
  if (feeRows.length) {
    const bySym = new Map<string, PositionCycle[]>()
    for (const c of all) {
      const list = bySym.get(c.symbol)
      if (list) list.push(c)
      else bySym.set(c.symbol, [c])
    }
    for (const r of feeRows) {
      const sym = String(r.symbol ?? '')
      const at = r.ts ? Date.parse(String(r.ts)) : NaN
      const amount = num(r.amount)
      if (!sym || !Number.isFinite(at) || !amount) continue
      const hit = bySym
        .get(sym)
        ?.find(
          c =>
            at >= Date.parse(c.openAt) &&
            (c.closeAt === null || at <= Date.parse(c.closeAt))
        )
      if (hit) {
        hit.funding = r8(hit.funding + amount)
        /*
         * 资金费**当场并进净盈亏**（用户 2026-10-06：「为什么资金费不计入」）。
         * 它是**带符号**的（付出去是负的），所以直接加 = 付出扣钱、收到进钱。
         */
        hit.net = r8(hit.net + amount)
      }
    }
  }

  const openList = all
    .filter(c => !c.closed)
    /* 最近开仓的在最前 */
    .sort((a, b) => String(b.openAt).localeCompare(String(a.openAt)))
  const from = Number(range.from ?? 0) || 0
  const to = Number(range.to ?? 0) || 0
  const inRangeClosed = all.filter(c => {
    if (!c.closed) return false
    if (!from && !to) return true
    const at = c.closeAt ? Date.parse(c.closeAt) : NaN
    if (!Number.isFinite(at)) return false
    if (from && at < from) return false
    if (to && at > to) return false
    return true
  })
  const summary = inRangeClosed.reduce(
    (result, cycle) => {
      result.closedCount++
      result.net += cycle.net
      result.realized += cycle.realized
      result.fees += cycle.fee
      result.funding += cycle.funding
      result.holdSec += cycle.holdSec
      if (cycle.net > 0) {
        result.wins++
        result.grossProfit += cycle.net
      } else if (cycle.net < 0) {
        result.losses++
        result.grossLoss += Math.abs(cycle.net)
      }
      else result.breakeven++
      if (cycle.side === 'long') result.longCount++
      else result.shortCount++
      return result
    },
    {
      closedCount: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      grossProfit: 0,
      grossLoss: 0,
      net: 0,
      realized: 0,
      fees: 0,
      funding: 0,
      longCount: 0,
      shortCount: 0,
      holdSec: 0
    }
  )
  const closed = inRangeClosed
    /* 最近平的在最前（跟币安仓位历史一致） */
    .sort((a, b) => String(b.closeAt).localeCompare(String(a.closeAt)))
    .slice(0, Math.min(500, Math.max(1, Math.round(limit) || 50)))
  summary.grossProfit = r8(summary.grossProfit)
  summary.grossLoss = r8(summary.grossLoss)
  summary.net = r8(summary.net)
  const aggregate = <K extends string>(
    cycles: PositionCycle[],
    keyFor: (cycle: PositionCycle) => K
  ) => {
    const groups = new Map<K, {key: K; closedCount: number; wins: number; net: number}>()
    for (const cycle of cycles) {
      const key = keyFor(cycle)
      const group = groups.get(key) ?? {key, closedCount: 0, wins: 0, net: 0}
      group.closedCount++
      group.net += cycle.net
      if (cycle.net > 0) group.wins++
      groups.set(key, group)
    }
    return [...groups.values()].map(group => ({...group, net: r8(group.net)}))
  }
  const symbolBreakdown = aggregate(inRangeClosed, cycle => cycle.symbol)
    .sort((a, b) => b.net - a.net)
  const directionGroups = aggregate(inRangeClosed, cycle => cycle.side)
  const byDirection = (['long', 'short'] as const).map(key =>
    directionGroups.find(group => group.key === key) ?? {key, closedCount: 0, wins: 0, net: 0}
  )
  const completeHoldCycles = inRangeClosed.filter(cycle => !cycle.partial)
  const durationGroups = aggregate(completeHoldCycles, cycle =>
    cycle.holdSec <= 60 * 60 ? 'short' : cycle.holdSec <= 24 * 60 * 60 ? 'medium' : 'long'
  )
  const byHoldDuration = (['short', 'medium', 'long'] as const).map(key =>
    durationGroups.find(group => group.key === key) ?? {key, closedCount: 0, wins: 0, net: 0}
  )
  const profitSampleSize = Math.ceil(inRangeClosed.length * 0.05)
  const topProfitCycles = [...inRangeClosed]
    .sort((a, b) => b.net - a.net)
    .slice(0, profitSampleSize)
  const topProfitAmount = r8(topProfitCycles.reduce((sum, cycle) => sum + Math.max(0, cycle.net), 0))
  const largestLosses = inRangeClosed
    .filter(cycle => cycle.net < 0)
    .sort((a, b) => a.net - b.net)
    .slice(0, 5)
  const largestLossAmount = r8(largestLosses.reduce((sum, cycle) => sum + Math.abs(cycle.net), 0))
  const breakdown: PositionHistoryResult['breakdown'] = {
    bySymbol: symbolBreakdown,
    byDirection,
    byHoldDuration,
    incompleteHoldCount: inRangeClosed.length - completeHoldCycles.length,
    profitConcentration: {
      selectedCount: topProfitCycles.length,
      totalCount: inRangeClosed.length,
      amount: topProfitAmount,
      sharePct: summary.grossProfit > 0 ? r8(topProfitAmount / summary.grossProfit * 100) : 0
    },
    lossConcentration: {
      selectedCount: largestLosses.length,
      totalCount: summary.losses,
      amount: largestLossAmount,
      sharePct: summary.grossLoss > 0 ? r8(largestLossAmount / summary.grossLoss * 100) : 0
    },
    entryReasonAvailable: false
  }
  const {
    holdSec,
    ...summaryFields
  } = summary
  const dailyMap = new Map<string, {net: number; count: number}>()
  for (const cycle of inRangeClosed) {
    if (!cycle.closeAt) continue
    const date = new Date(Date.parse(cycle.closeAt) + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    const day = dailyMap.get(date) ?? {net: 0, count: 0}
    day.net += cycle.net
    day.count++
    dailyMap.set(date, day)
  }
  let cumulative = 0
  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => {
      cumulative += value.net
      return {
        date,
        net: r8(value.net),
        cumulative: r8(cumulative),
        count: value.count
      }
    })

  return {
    cycles: closed,
    open: openList,
    openCount: openList.length,
    since: fills[0]?.ts ?? null,
    summary: {
      ...summaryFields,
      averageHoldSec: summary.closedCount ? holdSec / summary.closedCount : 0
    },
    breakdown,
    daily
  }
}

/** 数字兜底（`numeric` 列回来的是字符串） */
function num(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
