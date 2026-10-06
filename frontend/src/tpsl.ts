/**
 * 「这条持仓挂了哪些**止盈 / 止损**，各占这条仓位的百分之几」（2026-10-06）。
 *
 * 用户：「持仓页面……加上止盈止损挂单价格加数量百分比……按钮加上止盈/止损是一个按钮，
 * 点击显示当前仓位的止盈止损可以设置」。
 *
 * 为什么要单独一个模块：同一个判断有**两个**地方要用 ——
 *   · 卡片上那行「止盈 0.98 50% │ 止损 0.72 50%」（`ExchangeAccountBoard.vue`）；
 *   · 弹层的初始值（`TpSlSheet.vue`，由 `ExchangeAccountLivePanel.vue` 传进去）。
 *   写两份迟早会有一份漏改（表现就是「卡片上有、点进去是空的」）。
 *
 * ⚠️ 数据是**挂在交易所的条件单**（`props.openOrders` 里那几条），不是我们自己的账本 ——
 *    所以用户在币安 App 上手动挂的止盈止损**也能看见**（这是对的，瞒着人更糟）。
 *    这也意味着「同一个方向可能有好几张」（部分平仓）：这里**全都返回**，
 *    弹层把每一张都列成一行、各改各的（见 `TpSlSheet.vue`）。
 */
import type {ExchangeOpenOrder, FuturesPosition} from './api'

/** 一张止盈 / 止损挂单里界面要用的那几个数 */
export interface TpSlOrder {
  id: string
  /** 触发价（条件单看的这个，不是 `price`） */
  price: number
  /** 委托数量（基础币，绝对值） */
  amount: number
  /** 占了这条持仓的百分之几（>100 也不截断，那是「多挂了一张」的意思） */
  pct: number
}

/** 这条持仓的止盈 / 止损（各按触发价从近到远排） */
export interface TpSlHit {
  profit: TpSlOrder[]
  stop: TpSlOrder[]
}

/**
 * 交给外层的「这一条持仓 + 它的止盈止损」。
 *
 * 卡片点「止盈/止损」时整个传上去：只有板子知道这条持仓的**全部**数字
 * （开仓价 / 标记价 / 数量 / 币安原始符号 / 走哪套 Key），弹层不该再回去推。
 */
export interface TpSlTarget {
  /** ccxt 统一写法（平仓接口吃这个） */
  symbol: string
  /** 币安原始交易对（`RLCUSDT`，挂条件单用这个） */
  raw: string
  side: 'long' | 'short'
  keyId?: number
  /** 币种简写（标题用） */
  name: string
  /** 开仓均价（算「预计收益」用） */
  entry: number
  /** 当前标记价（判止盈 / 止损用；拿不到时传 0，后端还会自己校一遍） */
  mark: number
  /** 持仓数量（张 / 基础币） */
  amount: number
  /**
   * 已经在挂着的止盈 / 止损 —— **全部**，不是第一张。
   *
   * ⚠️ 用户 2026-10-06：「由于有部分平仓的多个平价价格和百分比要显示可点击修改」
   *    ⇒ 部分平仓会让**同一个方向有好几张**（各价、各比例），必须一张不落地列出来，
   *    每张都能改价 / 改比例 / 撤。以前这里只带第一张，剩下的用「还有 N 张」糊过去 ——
   *    那样人根本改不了自己想改的那张。
   */
  profit: TpSlOrder[]
  stop: TpSlOrder[]
}

/**
 * 弹层点「确认」之后要执行的一条动作（由 `TpSlSheet` 生成、容器逐条执行）。
 *
 * · 有 `id` + `cancel`  ⇒ 撤掉那张（此时 `price` / `pct` 不看）
 * · 有 `id`             ⇒ 改那张（后端先撤旧的再挂新的）
 * · 没有 `id`           ⇒ 新挂一张
 */
export interface TpSlAction {
  kind: 'profit' | 'stop'
  id?: string
  cancel?: boolean
  price: number
  pct: number
}

/**
 * 归一成币安原始交易对（`1000LUNC/USDT:USDT` 与 `1000LUNCUSDT` 等价）。
 *
 * ⚠️ 持仓是 ccxt 统一写法、挂单是币安原始写法，比对前必须过这一道；
 *    板子里还用它比「钱账本」，所以这里导出去共用一份。
 */
export function pairOf(symbol: string): string {
  const s = String(symbol).toUpperCase()
  return s.includes('/') ? `${s.split('/')[0]}USDT` : s
}

/**
 * 这张挂单是止盈 / 止损 / 普通委托。
 *
 * ⚠️ **只能看币安原始类型**（`info.type`）：ccxt 会把 `STOP_MARKET` /
 *    `TAKE_PROFIT_MARKET` 都归一成 `market`，到那儿就分不出来了
 *    （跟 K 线叠加里 `orderKind` 同一个理由，见后端 `OpenOrderRow`）。
 */
export function orderKind(o: {type: string}): 'profit' | 'stop' | 'plain' {
  const t = String(o.type).toUpperCase()
  if (t.includes('TAKE_PROFIT')) return 'profit'
  if (t.includes('STOP')) return 'stop'
  return 'plain'
}

/** 平掉这条持仓要用哪一边下单：多头的止盈止损是**卖**。
 * ⚠️ 入参收 `string`：后端那份 `side` 是宽类型，只有 `'short'` 才当空头（跟界面同一个口径）。
 */
export function closeSideOf(side: string): 'buy' | 'sell' {
  return side === 'short' ? 'buy' : 'sell'
}

/**
 * 触发价在现价哪一侧 ⇒ 这张单该用哪个类型发（`profit` = 止盈 / `stop` = 止损）。
 *
 * ⚠️ 这跟后端 `legalKind()` 是**同一个口径**（币安只认这个，见 `exchange-trade.ts` 那张表）：
 *   · 平多（卖）：触发价 **> 现价** ⇒ 涨到才触发 ⇒ 止盈；**< 现价** ⇒ 跌到才触发 ⇒ 止损
 *   · 平空（买）：反过来
 *
 * ⚠️ 它跟「相对**开仓价**是赚是亏」**不是一回事** —— 用户 2026-10-06 问的就是这个：
 *    多单开仓 5、现价 10、触发价填 8：相对开仓价是赚的（锁定 +3），
 *    但 8 在现价**下方** ⇒ 币安只收 `STOP_MARKET`。这就是**保本单 / 移动止损**，
 *    类型上是止损，不是止盈（拿止盈类型去挂会被回 `-2021`）。
 */
export function kindOfPrice(
  side: string,
  price: number,
  mark: number
): 'profit' | 'stop' {
  if (!(price > 0) || !(mark > 0)) return 'stop'
  return closeSideOf(side) === 'sell'
    ? price > mark
      ? 'profit'
      : 'stop'
    : price < mark
      ? 'profit'
      : 'stop'
}

/** 收起这一条持仓的止盈 / 止损（没挂就是空数组） */
export function tpSlOf(
  orders: ExchangeOpenOrder[] | undefined,
  pos: Pick<
    FuturesPosition,
    'symbol' | 'side' | 'amount' | 'markPrice' | 'keyName' | 'raw'
  >
): TpSlHit {
  const out: TpSlHit = {profit: [], stop: []}
  const pair = pairOf(pos.raw ?? pos.symbol)
  const want = closeSideOf(pos.side)
  for (const o of orders ?? []) {
    const kind = orderKind(o)
    if (kind === 'plain') continue
    if (pairOf(o.symbol) !== pair) continue
    /* 「全部」那一格里两套账户可能有同一个币 ⇒ 按 Key 名分开（跟 `realizedOf` 一个口径） */
    if (pos.keyName && o.keyName && o.keyName !== pos.keyName) continue
    /*
     * ⚠️ 两道方向判断都要过：`side` 是必须的（平多 = 卖），`posSide` 只在**双向持仓模式**
     *    下才有意义（单向模式币安回 `BOTH`）—— 所以它在且对不上时才算不匹配。
     *    只看 `posSide` 会把单向模式的单全漏掉，只看 `side` 会把「反向开仓」的单当成止盈。
     */
    if (String(o.side) !== want) continue
    const ps = String(o.posSide ?? '').toUpperCase()
    if ((ps === 'LONG' || ps === 'SHORT') && ps !== (pos.side === 'long' ? 'LONG' : 'SHORT'))
      continue
    /* 条件单的触发价在 `stopPrice`；`closePosition`（全平型）那张没有数量，拿 0 表示 */
    const price = Number(o.stopPrice ?? 0)
    if (!(price > 0)) continue
    /*
     * ⚠️ 数量为 0 = 币安那种 `closePosition: true` 的**全平型**条件单（`origQty` 就是 0）
     *    ⇒ 按 **100%** 算。别显示成「0%」，那会让人以为这张单什么也不平。
     */
    const amount = Math.max(0, Number(o.amount ?? 0))
    out[kind].push({
      id: o.id,
      price,
      amount,
      pct: amount > 0 && pos.amount > 0 ? (amount / pos.amount) * 100 : 100
    })
  }
  /*
   * **离标记价最近的那张排第一**（最先会触发的那张）—— 弹层只认第一张，
   * 所以「哪张算主要的」得有个说得过去的定义，别按币安返回的顺序（那个是按下单时间）。
   */
  const mark = Number(pos.markPrice ?? 0)
  const near = (a: TpSlOrder, b: TpSlOrder) =>
    Math.abs(a.price - mark) - Math.abs(b.price - mark)
  if (mark > 0) {
    out.profit.sort(near)
    out.stop.sort(near)
  } else {
    /* 拿不到标记价就按价格排（止盈从低到高、止损从高到低），至少是稳定的 */
    out.profit.sort((a, b) => a.price - b.price)
    out.stop.sort((a, b) => b.price - a.price)
  }
  return out
}

/**
 * 币安原始订单类型 → 中文（「挂单」列表和改单弹层共用一份）。
 *
 * 用户 2026-10-06：「挂单页面数据我看不懂」—— 那一列以前**原样印着**
 * `TAKE_PROFIT_MARKET` / `STOP_MARKET`。⚠️ 只放这里一份：板子上那行、改单弹层的
 * 标题都要用，写两份迟早有一份漏改（表现就是「列表里是中文、点进去变英文」）。
 */
export const ORDER_TYPE_TEXT: Record<string, string> = {
  LIMIT: '限价',
  MARKET: '市价',
  STOP: '止损（限价）',
  STOP_MARKET: '止损（市价）',
  TAKE_PROFIT: '止盈（限价）',
  TAKE_PROFIT_MARKET: '止盈（市价）',
  TRAILING_STOP_MARKET: '跟踪止损',
  LIMIT_MAKER: '限价 Maker'
}

/** 订单类型的中文名；不认识的原样返回（宁可露英文，也别显示成空白） */
export function typeText(t: string): string {
  const k = String(t ?? '').toUpperCase()
  return ORDER_TYPE_TEXT[k] ?? k
}

/**
 * 「挂单」列表点一行 → 改单弹层要的那个目标。
 *
 * 是 `ExchangeOpenOrder` 那几个字段 + 弹层自己要用到的上下文（对应仓位 / 标记价），
 * 由板子点行那一刻拼好（只有板子手上同时有挂单和持仓）。
 */
export interface OrderEditTarget {
  /** 单号 */
  id: string
  /** 币安原始符号（`1000BONKUSDT`）—— 改单 / 撤单接口都吃这个 */
  raw: string
  /** 走哪套 Key（多套账户时必填） */
  keyId?: number
  /** 哪套 Key 的（多套账户时挂单里带的那个名字；外层靠它找 `keyId`） */
  keyName?: string
  /** 币种简写（标题用） */
  name: string
  /** 币安原始类型（`LIMIT` / `STOP_MARKET` / `TAKE_PROFIT_MARKET` …） */
  type: string
  /** 买 / 卖 */
  side: 'buy' | 'sell'
  /** 现在的委托价（限价单；条件单没有 ⇒ 0） */
  price: number
  /** 现在的触发价（止盈 / 止损；普通委托没有 ⇒ 0） */
  stopPrice: number
  /** 委托数量（基础币） */
  amount: number
  /** 这条对应的**持仓**数量（算「平仓比例」用；对不上仓位就是 0） */
  held: number
  /** 标记价 / 最新价：占位符 + 「压在现价上」的校验（拿不到是 0） */
  mark: number
}
