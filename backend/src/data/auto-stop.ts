/**
 * **开仓 / 加仓成功后自动挂一张止损**（用户 2026-10-15：「开仓后自动加入 −4% 个点的全部仓位止损」）。
 *
 * 口径（用户当面定的，写在 `docs/EXCHANGE.md` 的 M10 那行）：
 *   · 触发价 = **当前开仓均价** × (1 ∓ pct%)——
 *     多单往下、空单往上；⚠️ 每次加仓都**按新的均价重算**（用户选的这一条：
 *     「按新的开仓均价 −4% 重算触发价，数量覆盖全部仓位」）；
 *   · 数量 = **当前仓位的全部数量**（不是这一单的数量）；
 *   · 百分比由**前端配置**（`settings.ts` 的「开仓自动止损」），下单请求里带过来。
 *
 * 三条安全边界：
 *   ① 只认**自己挂的那张**（`exchange_open_orders.source = 'auto-stop'`）：
 *      加仓时把它撤旧换新；**用户手工挂的止损绝不动**（那可能是他刻意设的更紧的价）——
 *      这种情况直接跳过，并把「已有止损单，自动止损这次没动」报回前端。
 *   ② 拿不到持仓 / 持仓为 0 ⇒ 不挂（宁可没挂，也别挂一张数量瞎猜的单）。
 *   ③ 挂单失败**只回报错误**，绝不影响已经成交的那一单（调用方只把结果附在响应里）。
 */
import {createExchange, type ExchangeCredentials} from './exchange-account'
import {isDualSide, listOpenOrders, placeStopOrder} from './exchange-trade'
import {getPositions, liveStateOf} from './position-cache'
import {listOpenOrdersDb, upsertOpenOrder} from '../db/exchange-store'

/** 我们自己挂的止损的标记（写进 `exchange_open_orders.source`） */
export const AUTO_STOP_SOURCE = 'auto-stop'

export interface AutoStopInput {
  userId: number
  keyId: number
  creds: ExchangeCredentials
  /** 币安原始符号（`1000PEPEUSDT`） */
  symbol: string
  /** 这一单的方向（`long` = 刚开了多） */
  side: 'long' | 'short'
  /** 触发距离（**百分点**，正数：4 = 开仓均价下方 4%）。`0` = 不做 */
  pct: number
  /** 账户是不是双向持仓（拿不准就不传，这里自己去问一次） */
  dual?: boolean
  /**
   * **下单前**这个币 + 这个方向的数量（调用方从常驻流里顺手拿一下）。
   *
   * 用来判断「这一单到底落地上没有」—— 加仓时持仓本来就存在，只看非零会把加仓前
   * 那一行当成结果（数量 / 均价都是旧的）。`0` / 不传 = 之前没持仓。
   */
  before?: number
  /**
   * **减仓专用**：触发价**保持原来那张不动**，只把数量收到当前仓位。
   *
   * 减仓不改开仓均价 ⇒ 触发价本来就该原地不动；而重算的话，万一用户在下单后又改了
   * 配置里的百分比，减个仓会把止损价一起挪走 —— 那不是他要的（用户 2026-10-15
   * 选的是「加仓按新均价重算」，减仓只说「跟着收数量」）。
   */
  keepPrice?: boolean
  /**
   * **减仓专用**：没有「自己挂的自动止损」时**不新建**，直接跳过。
   *
   * 用户把自动止损撤了 / 关了，减仓不该又给他挂回来（那是加仓那边的行为）。
   */
  noCreate?: boolean
}

export interface AutoStopResult {
  ok: boolean
  /** 没做 / 为什么没做（前端按这个出文案） */
  skipped?: 'disabled' | 'no-position' | 'manual-stop' | 'unchanged' | 'no-auto-stop'
  /** 触发价 */
  price?: number
  /** 覆盖的数量（= 全部仓位） */
  quantity?: number
  /** 新挂上的单号 */
  orderId?: string
  /** 撤掉的旧自动单号（加仓时撤旧换新） */
  replaced?: string
  /** 已有手工止损时，把它的触发价带回去（前端好提示） */
  existingPrice?: number | null
  error?: string
}

/** 等这一单落在持仓上：连续两次读到同一个数量才算它「稳住了」（成交是分批推的） */
const WAIT_MS = [0, 150, 350, 700]

/** 读持仓只需要这几个字段（止盈放大那条路不用百分比，也能复用这两个函数） */
type PositionQuery = Pick<AutoStopInput, 'keyId' | 'creds' | 'symbol' | 'side'>

/** 常驻流里这个币 + 这个方向的持仓（**免费**，而且跟界面看到的是同一份） */
function liveRow(
  input: PositionQuery
): {amount: number; entryPrice: number} | null {
  const want = input.symbol.toUpperCase()
  const hit = liveStateOf(input.keyId)?.positions?.find(
    p =>
      String(p.raw ?? '').toUpperCase() === want &&
      /* 双向持仓时同一个币有两条 ⇒ 必须按方向挑，否则可能拿的是另一条 */
      (p.side === 'short' ? 'short' : 'long') === input.side
  )
  const amount = Math.abs(Number(hit?.amount) || 0)
  if (!(amount > 0)) return null
  return {amount, entryPrice: Math.abs(Number(hit?.entryPrice) || 0)}
}

/**
 * 读出**这一单成交之后**的持仓（数量 + 开仓均价）。
 *
 * ⚠️ 不能只看「有没有持仓」：加仓时这个币**本来就有**持仓，常驻流里那一行还是加仓前的
 *    数量和均价 —— 实测踩过：加仓 1500 之后立刻按旧的 7000 挂了一张止损，
 *    数量和触发价全是错的。所以拿 `before`（下单前这个方向的数量）比对，
 *    **数量变了**才算这一单已经落在持仓上。
 * ⚠️ 市价单会**拆成好几笔**成交（实测 3001 拆成 1499+146+1356）⇒ 还要等它**稳住**
 *    （连续两次读到同一个数量），否则会按中间那个 1499 去挂。
 * ⚠️ 先只看常驻流那一路（不打交易所、权重为 0）；一直没等到才强制读一次 REST 兜底。
 */
async function readPositionAfter(
  input: PositionQuery,
  before: number
): Promise<{amount: number; entryPrice: number} | null> {
  let prev = -1
  for (const wait of WAIT_MS) {
    if (wait) await new Promise(r => setTimeout(r, wait))
    const live = liveRow(input)
    if (!live) continue
    if (live.amount !== before && live.amount === prev) return live
    prev = live.amount
  }
  /* 没等到（常驻流没跑 / 没推过来）⇒ 强制读一次交易所，那是权威口径 */
  const rows = await getPositions(input.keyId, input.creds, {force: true})
  const hit = rows.find(
    p =>
      String(p.symbol ?? '').toUpperCase() === input.symbol.toUpperCase() &&
      (p.side ?? 'long') === input.side
  )
  const amount = Math.abs(Number(hit?.amount) || 0)
  if (!(amount > 0)) return null
  return {amount, entryPrice: Math.abs(Number(hit?.entryPrice) || 0)}
}

/**
 * 确保「这个币 + 这个方向」有一张覆盖**全部仓位**、触发价在开仓均价 ∓pct% 的止损。
 *
 * 加仓会再调一次 ⇒ 按新均价撤旧换新。
 */
export async function ensureAutoStop(input: AutoStopInput): Promise<AutoStopResult> {
  const pct = Number(input.pct)
  /*
   * `keepPrice`（减仓「只收数量」那条）**不需要百分比** —— 触发价拿原来那张的，
   * 百分比只是加仓 / 新建时算价用的。
   */
  const resizing = input.keepPrice === true
  if (!resizing && (!Number.isFinite(pct) || pct <= 0))
    return {ok: false, skipped: 'disabled'}
  const symbol = String(input.symbol ?? '').toUpperCase()

  try {
    const before = Number.isFinite(Number(input.before)) ? Number(input.before) : 0
    const pos = await readPositionAfter({...input, symbol}, before)
    if (!pos || !(pos.entryPrice > 0))
      return {ok: false, skipped: 'no-position'}

    const entryPrice =
      Number.isFinite(pct) && pct > 0
        ? pos.entryPrice * (input.side === 'long' ? 1 - pct / 100 : 1 + pct / 100)
        : 0
    const closing: 'buy' | 'sell' = input.side === 'long' ? 'sell' : 'buy'
    const posSide = input.side === 'long' ? 'LONG' : 'SHORT'
    const dual =
      input.dual ?? (await isDualSide(createExchange(input.creds), input.keyId))

    /*
     * 这个币上已经挂着的**止损单**（条件单在另一套接口上，`listOpenOrders` 两路都拉）。
     * 只认「平这个方向的那一侧」：多单的止损是 SELL，空单是 BUY。
     */
    const ours = await listOpenOrdersDb(input.userId, input.keyId)
    const marks = new Map(ours.map(o => [String(o.orderId), String(o.source ?? '')]))
    const existing = (await listOpenOrders(input.creds, symbol)).filter(
      o =>
        String(o.symbol ?? '').toUpperCase() === symbol &&
        String(o.side ?? '').toLowerCase() === closing &&
        /* `STOP` 会同时命中 `STOP_MARKET`，但**不能**命中 `TAKE_PROFIT_MARKET` */
        String(o.type ?? '').toUpperCase().includes('STOP')
    )
    const mine = existing.find(o => marks.get(String(o.id)) === AUTO_STOP_SOURCE)
    const manual = existing.find(o => marks.get(String(o.id)) !== AUTO_STOP_SOURCE)
    /*
     * ★ 手工那张**不碰**：用户可能刻意设得更紧（−2%），我们撤了他就裸奔了。
     *   直接跳过并把它的触发价报回去，前端提示一句。
     */
    if (!mine && manual)
      return {ok: false, skipped: 'manual-stop', existingPrice: manual.stopPrice ?? null}

    /*
     * 减仓那一路：**没有自己挂的止损就不动**（不凭空挂一张出来）。
     * 手工止损已经在上面挡过了 —— 这里挡的是「撤了 / 关了自动止损」那种情况。
     */
    if (!mine && input.noCreate) return {ok: false, skipped: 'no-auto-stop'}

    /*
     * 减仓保持原触发价（`keepPrice`）：拿自己那张的价，只收数量。
     * 拿不到（`mine` 没有价）就退回按开仓均价算 —— 那是加仓那条路的口径。
     */
    const price =
      input.keepPrice && mine && Number(mine.stopPrice) > 0
        ? Number(mine.stopPrice)
        : entryPrice
    /* 已经就是我们想要的那张（触发价 + 数量都对得上）⇒ 不动它，省一次撤旧挂新 */
    /* 算不出价（减仓又找不到自己那张的价）⇒ 不碰，别挂一张没触发价的单 */
    if (!(price > 0)) return {ok: false, skipped: 'no-position'}
    const samePrice = mine && Math.abs(Number(mine.stopPrice) - price) <= price * 1e-6
    const sameQty = mine && Math.abs(Number(mine.amount) - pos.amount) < 1e-9
    if (mine && samePrice && sameQty)
      return {
        ok: true,
        skipped: 'unchanged',
        price: Number(mine.stopPrice),
        quantity: pos.amount,
        orderId: String(mine.id)
      }

    const placed = await placeStopOrder(input.creds, input.keyId, {
      symbol,
      side: closing,
      kind: 'stop',
      stopPrice: price,
      quantity: pos.amount,
      /* 双向持仓模式必须带 positionSide，否则会被当成 LONG（空单就挂反了） */
      posSide: dual ? posSide : undefined,
      /* 撤旧挂新：`placeStopOrder` 看到 orderId 会先撤掉它 */
      orderId: mine ? String(mine.id) : undefined,
      test: false
    })

    /* 记下「这张是我们挂的」—— 对账（`replaceOpenOrders`）不会把这列抹掉 */
    if (placed.orderId)
      await upsertOpenOrder(input.userId, input.keyId, {
        orderId: String(placed.orderId),
        symbol,
        side: closing,
        type: placed.type,
        posSide: dual ? posSide : 'BOTH',
        price: null,
        stopPrice: placed.stopPrice ?? price,
        amount: placed.quantity ?? pos.amount,
        filled: 0,
        reduceOnly: !dual,
        time: Date.now(),
        source: AUTO_STOP_SOURCE
      })

    console.log(
      `[自动止损] ${symbol} ${input.side} 开仓均价 ${pos.entryPrice} → 触发价 ${placed.stopPrice}` +
        ` 数量 ${placed.quantity}（全部仓位）${placed.canceled ? ` 撤掉旧单 ${placed.canceled}` : ''}`
    )
    return {
      ok: true,
      price: placed.stopPrice,
      quantity: placed.quantity,
      orderId: placed.orderId === undefined ? undefined : String(placed.orderId),
      replaced: placed.canceled
    }
  } catch (e) {
    /* 挂止损失败**不能**把已经成交的那一单搞成「失败」—— 只回报错误 */
    return {ok: false, error: e instanceof Error ? e.message : String(e)}
  }
}

/* ---------------- 加仓后把已有止盈放大到全部仓位 ---------------- */

/**
 * 加仓后**止盈**怎么改（用户 2026-10-15 晚上：「有仓位止盈的话，加仓之后把加仓的
 * 单子也要放到止盈里面去，变成百分之百」）。
 *
 * 跟自动止损不一样：止盈的价是**用户自己设的**，这里只动数量，**绝不改触发价**。
 * 口径：
 *   · 只处理「加仓」（`before > 0` 且新仓位更大）；
 *   · 一张止盈 ⇒ 数量改成**加仓后的全部仓位**（原来是 100% 的仍然是 100%）；
 *   · 多张（分批止盈）/ `closePosition`（数量 0，本来就覆盖全仓）/ 数量已对上 ⇒ **不动**。
 *
 * 拆成纯函数是为了**能拿假数据在本地验**（这条链会真撤单 / 真挂单，不能靠猜）。
 */
export type TakeProfitPlan =
  | {
      action: 'skip'
      reason:
        | 'not-add'
        | 'not-grown'
        | 'no-tp'
        | 'multiple-tp'
        | 'close-position'
        | 'unchanged'
        | 'no-price'
      price?: number
      quantity?: number
      orderId?: string
    }
  | {action: 'resize'; orderId: string; stopPrice: number; quantity: number; from: number}

export function planTakeProfitResize(input: {
  /** 加仓前这个方向的数量 */
  before: number
  /** 加仓后这个方向的数量 */
  amount: number
  /** 这个方向上已有的止盈单（调用方已按 symbol + 平仓侧筛过） */
  tps: {id?: unknown; amount?: unknown; stopPrice?: unknown}[]
}): TakeProfitPlan {
  const before = Math.abs(Number(input.before) || 0)
  const amount = Math.abs(Number(input.amount) || 0)
  if (!(before > 0)) return {action: 'skip', reason: 'not-add'}
  if (!(amount > before + 1e-9))
    return {action: 'skip', reason: 'not-grown', quantity: amount}
  const tps = input.tps
  if (!tps.length) return {action: 'skip', reason: 'no-tp'}
  /* 分批止盈没法猜哪张该覆盖全仓 —— 猜错就把用户自己的分布改坏了 */
  if (tps.length > 1)
    return {action: 'skip', reason: 'multiple-tp', quantity: amount}
  const tp = tps[0]!
  const orderId = String(tp.id ?? '')
  const from = Math.abs(Number(tp.amount) || 0)
  const stopPrice = Number(tp.stopPrice) || 0
  /* 数量 0 = `closePosition`（全仓平）—— 本来就覆盖全部仓位 */
  if (!(from > 0))
    return {
      action: 'skip',
      reason: 'close-position',
      price: stopPrice,
      quantity: amount,
      orderId
    }
  if (Math.abs(from - amount) < 1e-9)
    return {
      action: 'skip',
      reason: 'unchanged',
      price: stopPrice,
      quantity: from,
      orderId
    }
  if (!(stopPrice > 0))
    return {action: 'skip', reason: 'no-price', quantity: amount, orderId}
  return {action: 'resize', orderId, stopPrice, quantity: amount, from}
}

export type TakeProfitSkip =
  | Extract<TakeProfitPlan, {action: 'skip'}>['reason']
  | 'no-position'

export interface TakeProfitResult {
  ok: boolean
  /** 没做 / 为什么没做 */
  skipped?: TakeProfitSkip
  price?: number
  quantity?: number
  orderId?: string
  /** 撤掉的旧单号（改数量 = 撤旧挂新） */
  replaced?: string
  error?: string
}

export type TakeProfitInput = Omit<
  AutoStopInput,
  'pct' | 'keepPrice' | 'noCreate'
> & {
  /**
   * 只让币安校验一遍（**不撤旧单、不挂新单**）—— 本地拿真账户验这条链用。
   * ⚠️ 条件单的触发价没有测试接口，跟自动止损那边一样（见 `placeStopOrder`）。
   */
  test?: boolean
}

/**
 * 加仓之后，把已有的那张止盈**数量**放大到加仓后的全部仓位（触发价不动）。
 *
 * 失败**绝不能**影响已经成交的加仓单：调用方只把结果推给前端提示一句。
 */
const tpResizeQueues = new Map<number, Promise<TakeProfitResult>>()

/**
 * 加仓后止盈放大 —— **同一套 Key 串行**。
 *
 * 连着加两次仓时，两个后台任务会同时看到「旧止盈」⇒ 都去撤它：后一个撤到的是
 * 已被撤掉的单，失败回挂还可能多插一张。串行之后，第二个进来会重新读一次挂单，
 * 看到数量已经对上 ⇒ `unchanged`，什么都不做。
 */
export function ensureTakeProfitFull(
  input: TakeProfitInput
): Promise<TakeProfitResult> {
  const keyId = Number(input.keyId)
  const prev = tpResizeQueues.get(keyId)
  const run = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(() =>
    ensureTakeProfitFullNow(input)
  )
  tpResizeQueues.set(keyId, run)
  const clear = (): void => {
    if (tpResizeQueues.get(keyId) === run) tpResizeQueues.delete(keyId)
  }
  run.then(clear, clear)
  return run
}

async function ensureTakeProfitFullNow(
  input: TakeProfitInput
): Promise<TakeProfitResult> {
  const symbol = String(input.symbol ?? '').toUpperCase()
  const before = Math.abs(Number(input.before) || 0)
  try {
    const pos = await readPositionAfter({...input, symbol}, before)
    if (!pos) return {ok: false, skipped: 'no-position'}

    const closing: 'buy' | 'sell' = input.side === 'long' ? 'sell' : 'buy'
    /*
     * 条件单跟止损在同一套接口上（`listOpenOrders` 两路都拉）。
     * ⚠️ 只认**平这个方向的那一侧**：多单的止盈是 SELL，空单是 BUY；
     *    `TAKE_PROFIT_MARKET` 命中，`STOP_MARKET` 不含这个词，不会混进来。
     */
    const all = await listOpenOrders(input.creds, symbol)
    const tps = all.filter(
      o =>
        String(o.symbol ?? '').toUpperCase() === symbol &&
        String(o.side ?? '').toLowerCase() === closing &&
        String(o.type ?? '').toUpperCase().includes('TAKE_PROFIT')
    )
    const plan = planTakeProfitResize({before, amount: pos.amount, tps})
    if (plan.action === 'skip')
      return {
        /* `unchanged` 也算成功：本来就已经覆盖全仓了 */
        ok: plan.reason === 'unchanged',
        skipped: plan.reason,
        price: plan.price,
        quantity: plan.quantity,
        orderId: plan.orderId
      }

    const dual =
      input.dual ?? (await isDualSide(createExchange(input.creds), input.keyId))
    const posSide = input.side === 'long' ? 'LONG' : 'SHORT'
    const test = input.test === true
    try {
      const placed = await placeStopOrder(input.creds, input.keyId, {
        symbol,
        side: closing,
        kind: 'profit',
        stopPrice: plan.stopPrice,
        quantity: plan.quantity,
        /* 双向持仓必须带 positionSide，否则会被当成 LONG */
        posSide: dual ? posSide : undefined,
        /* 撤旧挂新：`placeStopOrder` 看到 orderId 会先撤掉它（测试模式不会撤） */
        orderId: plan.orderId || undefined,
        test
      })
      console.log(
        `[止盈调整] ${symbol} ${input.side} 加仓后 ${plan.from} → ${placed.quantity}` +
          `（全部仓位）触发价 ${placed.stopPrice}` +
          `${placed.canceled ? ` 撤旧单 ${placed.canceled}` : ''}` +
          `${test ? ' [测试]' : ''}`
      )
      return {
        ok: true,
        price: placed.stopPrice,
        quantity: placed.quantity,
        orderId:
          placed.orderId === undefined ? undefined : String(placed.orderId),
        replaced: placed.canceled
      }
    } catch (e) {
      /*
       * 「撤旧挂新」是两步：撤完再挂失败，仓位就**没有止盈**了。
       * 尽力按原来的数量挂回去（价不变），再把错报上去。
       * ⚠️ 测试模式根本没撤单，不需要（也不该）回挂。
       */
      if (!test)
        await placeStopOrder(input.creds, input.keyId, {
          symbol,
          side: closing,
          kind: 'profit',
          stopPrice: plan.stopPrice,
          quantity: plan.from,
          posSide: dual ? posSide : undefined,
          test: false
        }).catch(restoreErr => {
          console.warn(
            `[止盈调整] ${symbol} 改数量失败后，按原数量回挂也失败：` +
              `${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`
          )
        })
      throw e
    }
  } catch (e) {
    return {ok: false, error: e instanceof Error ? e.message : String(e)}
  }
}
