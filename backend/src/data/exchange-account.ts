import ccxt from 'ccxt'

/**
 * 交易所账户取数（2026-10-04）。
 *
 * 用户原话：「实时分析 tab 后加入交易所账户信息，显示账户余额和订单历史」。
 *
 * 用 CCXT 统一接口：一个交易所 id + apiKey/secret（+ 有的要 passphrase）就能
 * 走 `fetchBalance()` / `fetchOrders()`。这里只做**只读**查询，
 * 不下单、不撤单 —— 绑进来的 Key 建议只用「读权限」。
 *
 * ⚠️ 凭据只在这个进程里用，**不回给前端**（列表接口只回掩码，见 db/exchange-keys.ts）。
 */
const CCXT: any = ccxt

/** 前端下拉里能选的交易所（够常用的就行，ccxt 还有上百个 id 可以手填） */
export const EXCHANGE_CATALOG: {id: string; label: string}[] = [
  {id: 'binance', label: '币安 Binance'},
  {id: 'okx', label: '欧易 OKX'},
  {id: 'bybit', label: 'Bybit'},
  {id: 'bitget', label: 'Bitget'},
  {id: 'gateio', label: 'Gate.io'},
  {id: 'mexc', label: 'MEXC'},
  {id: 'kucoin', label: 'KuCoin'},
  {id: 'htx', label: 'HTX 火币'},
  {id: 'coinbase', label: 'Coinbase'},
  {id: 'kraken', label: 'Kraken'},
  {id: 'krakenfutures', label: 'Kraken Futures'},
  {id: 'bitmex', label: 'BitMEX'}
]

/** 连交易所要的那几个字段（从 db 里的 `ExchangeKey` 摊平过来） */
export interface ExchangeCredentials {
  exchange: string
  apiKey: string
  secret: string
  password: string
  /** spot = 现货，swap = 合约 */
  marketType: string
  sandbox: boolean
}

/** 稳定币：直接按 1 美元算，不用再查价 */
export const STABLES = new Set([
  'USDT',
  'USDC',
  'BUSD',
  'FDUSD',
  'TUSD',
  'DAI',
  'USDP',
  'USDD',
  'PYUSD'
])

/** 认得出的交易所实例 */
export function createExchange(c: ExchangeCredentials): any {
  const Ctor = CCXT[c.exchange]
  if (!Ctor)
    throw new Error(`不支持的交易所「${c.exchange}」（ccxt 里没有这个 id）`)
  if (!c.apiKey || !c.secret)
    throw new Error('这套账户还没填 API Key / Secret')

  const ex = new Ctor({
    enableRateLimit: true,
    apiKey: c.apiKey,
    secret: c.secret,
    ...(c.password ? {password: c.password} : {}),
    options: {
      ...marketOptionsFor(c),
      /*
       * ⚠️ 币安不带交易对查挂单，ccxt 会**抛**一条「限流更严」的警告
       * （不是真错，但会中断调用）。按它提示显式关掉。
       */
      fetchOpenOrders: {warnWithoutSymbol: false}
    }
  })
  if (c.sandbox && typeof ex.setSandboxMode === 'function') {
    const r = ex.setSandboxMode(true)
    if (r && typeof r.then === 'function') {
      // 返回 Promise 的版本：这里不能 await（createExchange 是同步的），
      // 忽略即可 —— 沙盒只是改 url，绝大多数版本是同步的
      void r.catch(() => undefined)
    }
  }
  return ex
}

/**
 * `defaultType` / `fetchMarkets` 选择。
 *
 * ⚠️ 币安必须**钉死 USDⓈ-M（linear）**：光写 `defaultType: 'swap'` 时 ccxt 会连
 *   币本位的 `dapi.binance.com`，国内网络下它经常连不上（实测报
 *   `dapi.binance.com/dapi/v1/exchangeInfo ... socket disconnected`）。
 *   这里照抄 `data/market.ts` 里已经跑通的那套：
 *     swap → `{defaultType: 'future', fetchMarkets: ['linear']}`（走 fapi）
 *     spot → `{defaultType: 'spot', fetchMarkets: ['spot']}`
 *   其它交易所用通用的 `swap + defaultSubType: 'linear'`。
 */
function marketOptionsFor(c: ExchangeCredentials): Record<string, unknown> {
  const isBinance = c.exchange === 'binance'
  if (c.marketType === 'spot') {
    return isBinance
      ? {defaultType: 'spot', fetchMarkets: ['spot']}
      : {defaultType: 'spot'}
  }
  return isBinance
    ? {defaultType: 'future', fetchMarkets: ['linear']}
    : {defaultType: 'swap', defaultSubType: 'linear'}
}

export interface BalanceRow {
  currency: string
  free: number
  used: number
  total: number
  /** 折成 USDT 的估值；查不到价时是 null */
  usdt: number | null
}

export interface BalanceResult {
  rows: BalanceRow[]
  /** 所有能估值的资产折 USDT 的合计 */
  totalUsdt: number
  /** 有没有资产因为查不到价没能估值 */
  partial: boolean
  updatedAt: string
}

/** 数字兜底（ccxt 有的字段可能是 undefined / NaN） */
function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/**
 * 查余额，并尽量折成 USDT。
 *
 * 折价策略：稳定币按 1 算；其它的在**已加载的市场**里找 `X/USDT[:USDT]`，
 * 拿一次 `fetchTickers()` 把价格批量取回来。查不到就不估值（`usdt: null`），
 * 而不是瞎猜 —— 宁可少算，不能给错数。
 */
export async function fetchExchangeBalance(
  c: ExchangeCredentials
): Promise<BalanceResult> {
  const ex = createExchange(c)
  await ex.loadMarkets()
  const raw = await ex.fetchBalance()

  const total = (raw?.total ?? {}) as Record<string, unknown>
  const free = (raw?.free ?? {}) as Record<string, unknown>
  const used = (raw?.used ?? {}) as Record<string, unknown>

  const rows: BalanceRow[] = []
  for (const [currency, v] of Object.entries(total)) {
    const t = n(v)
    if (t <= 0) continue
    rows.push({
      currency,
      total: t,
      free: n(free[currency]),
      used: n(used[currency]),
      usdt: null
    })
  }
  rows.sort((a, b) => b.total - a.total)

  // ---- 估值：只在需要时打一次 fetchTickers ----
  let tickers: Record<string, any> = {}
  try {
    tickers = (await ex.fetchTickers()) ?? {}
  } catch {
    tickers = {}
  }

  const keys: string[] = Object.keys(ex.markets ?? {})
  /** 给某个币找它的 /USDT 交易对（现货 `X/USDT` 或合约 `X/USDT:USDT`） */
  const findUsdtSymbol = (cur: string): string | null => {
    const wanted = [`${cur}/USDT:USDT`, `${cur}/USDT`]
    for (const w of wanted) if (ex.markets?.[w] && tickers[w]) return w
    // 退一步：随便找个以 X/ 开头、以 USDT 结尾的
    return (
      keys.find(
        k => k.startsWith(`${cur}/`) && /USDT(:USDT)?$/.test(k) && tickers[k]
      ) ?? null
    )
  }

  let totalUsdt = 0
  let partial = false
  for (const r of rows) {
    if (STABLES.has(r.currency)) {
      r.usdt = r.total
      totalUsdt += r.total
      continue
    }
    const sym = findUsdtSymbol(r.currency)
    const price = sym ? n(tickers[sym]?.last ?? tickers[sym]?.close) : 0
    if (price > 0) {
      r.usdt = r.total * price
      totalUsdt += r.usdt
    } else {
      partial = true
    }
  }

  return {
    rows,
    totalUsdt,
    partial,
    updatedAt: new Date().toISOString()
  }
}

export interface OrderRow {
  id: string
  datetime: string | null
  symbol: string
  side: string
  type: string
  price: number
  amount: number
  cost: number
  status: string
  fee: number
  feeCurrency: string
}

export interface OrdersResult {
  /** `orders` = 真·委托单；`trades` = 成交记录（有的交易所不给无 symbol 的委托单，退回成交记录） */
  kind: 'orders' | 'trades'
  rows: OrderRow[]
  /**
   * 交易所**不给「不带交易对」的订单**（币安就是这样），而且从余额也推不出交易对
   * → 前端要引导用户输一个交易对再查。
   */
  needSymbol: boolean
  /** 这次实际查了哪些交易对（自动推出来的，显示用） */
  tried: string[]
}

function mapOrder(o: any): OrderRow {
  const price = n(o?.average ?? o?.price)
  const amount = n(o?.filled ?? o?.amount)
  return {
    id: String(o?.id ?? ''),
    datetime: o?.datetime ?? null,
    symbol: String(o?.symbol ?? ''),
    side: String(o?.side ?? ''),
    type: String(o?.type ?? ''),
    price,
    amount,
    cost: n(o?.cost) || price * amount,
    status: String(o?.status ?? ''),
    fee: n(o?.fee?.cost),
    feeCurrency: String(o?.fee?.currency ?? '')
  }
}

/** 这个错是不是「你得给我一个交易对」 */
function requiresSymbol(e: unknown): boolean {
  return /requires? a symbol|symbol (is )?required|symbol argument/i.test(
    (e as Error)?.message ?? ''
  )
}

/**
 * 把 ccxt 的英文报错翻成人能看的中文（认不出就原样回）。
 * 这几条是绑 Key 时最常撞的。
 */
function humanize(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  if (/signature|invalid api-key|api[- ]?key.*(invalid|not exist)/i.test(m))
    return 'API Key / Secret 不对（或复制时多了空格）'
  if (/ip|whitelist|restricted location/i.test(m))
    return '这把 Key 有 IP 白名单限制 —— 要把服务器 IP 加进白名单'
  if (/permission|not authorized|forbidden|-2015|-1002/i.test(m))
    return '这把 Key 没有读取权限（去交易所给它开「读取」权限）'
  if (requiresSymbol(m)) return '这个交易所要指定交易对才能查订单'
  return m
}

/** 查一个交易对的订单；没有委托单就退回成交记录 */
async function ordersForSymbol(
  ex: any,
  symbol: string,
  cap: number
): Promise<{kind: 'orders' | 'trades'; rows: OrderRow[]}> {
  try {
    const rows = await ex.fetchOrders(symbol, undefined, cap)
    return {kind: 'orders', rows: (rows ?? []).map(mapOrder)}
  } catch {
    const trades = await ex.fetchMyTrades(symbol, undefined, cap)
    return {kind: 'trades', rows: (trades ?? []).map(mapOrder)}
  }
}

/**
 * 订单历史。
 *
 * ⚠️ 币安这类交易所**不给「不带交易对」的订单**（`fetchOrders`/`fetchMyTrades`
 *    都要求 symbol）。所以顺序是：
 *      1. 有指定的 symbol → 直接查它
 *      2. 试全量（okx / bybit 这类支持）
 *      3. 支持不了 → 拿**余额里持有的币**推几个交易对逐个查，合并按时间倒序
 *      4. 连余额都没有 → 回 `needSymbol: true`，让前端引导用户输一个
 */
export async function fetchExchangeOrders(
  c: ExchangeCredentials,
  opts: {limit?: number; symbol?: string; symbols?: string[]} = {}
): Promise<OrdersResult> {
  const ex = createExchange(c)
  await ex.loadMarkets()
  const cap = Math.max(1, Math.min(200, opts.limit ?? 50))
  const symbol = (opts.symbol ?? '').trim()

  if (symbol) {
    const r = await ordersForSymbol(ex, symbol, cap)
    return {...r, needSymbol: false, tried: [symbol]}
  }

  // 全量试一下（部分交易所有这种接口）
  try {
    const rows = await ex.fetchOrders(undefined, undefined, cap)
    return {kind: 'orders', rows: (rows ?? []).map(mapOrder), needSymbol: false, tried: []}
  } catch (e1) {
    if (!requiresSymbol(e1)) {
      try {
        const trades = await ex.fetchMyTrades(undefined, undefined, cap)
        return {
          kind: 'trades',
          rows: (trades ?? []).map(mapOrder),
          needSymbol: false,
          tried: []
        }
      } catch (e2) {
        if (!requiresSymbol(e2)) throw new Error(humanize(e2))
      }
    }
  }

  // 用余额推出来的交易对逐个查
  const tried: string[] = []
  const merged: OrderRow[] = []
  for (const s of opts.symbols ?? []) {
    try {
      const r = await ordersForSymbol(ex, s, cap)
      tried.push(s)
      merged.push(...r.rows)
    } catch {
      /* 这个交易对没有 / 不支持，跳过 */
    }
  }
  if (tried.length) {
    merged.sort((a, b) => (b.datetime ?? '').localeCompare(a.datetime ?? ''))
    return {kind: 'orders', rows: merged.slice(0, cap), needSymbol: false, tried}
  }
  return {kind: 'orders', rows: [], needSymbol: true, tried: []}
}

/** 从余额里推几个「可能查得到订单」的交易对（按估值从高到低，最多 6 个） */
function deriveSymbols(
  c: ExchangeCredentials,
  balance: BalanceResult | null
): string[] {
  if (!balance) return []
  const swap = c.marketType !== 'spot'
  const out: string[] = []
  for (const r of balance.rows) {
    const cur = r.currency.toUpperCase()
    if (STABLES.has(cur)) continue // 稳定币本身不是交易对的 base
    out.push(swap ? `${cur}/USDT:USDT` : `${cur}/USDT`)
    if (out.length >= 6) break
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 持仓 / 当前挂单 / 已实现盈亏                                        */
/* ------------------------------------------------------------------ */

export interface PositionRow {
  symbol: string
  /** long / short */
  side: string
  contracts: number
  notional: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number | null
  leverage: number
  unrealizedPnl: number
  /** 相对保证金的收益率 %（ccxt 给） */
  percentage: number | null
}

/*
 * 导出是给新的「交易所资产」模块（data/exchange-overview.ts）复用的 ——
 * 它在**同一个 exchange 实例**上一次性取「合约账户 + 持仓 + C2C」，
 * 不想再 createExchange + loadMarkets 一遍（那要一两秒）。
 */
export function mapPosition(p: any): PositionRow {
  const contracts = n(p?.contracts)
  const amt = n(p?.info?.positionAmt)
  const side =
    p?.side ??
    (amt > 0 ? 'long' : amt < 0 ? 'short' : contracts > 0 ? 'long' : 'short')
  const nullish = (v: unknown): number | null =>
    v === undefined || v === null ? null : n(v)
  return {
    symbol: String(p?.symbol ?? ''),
    side,
    contracts,
    notional: n(p?.notional),
    entryPrice: n(p?.entryPrice),
    markPrice: n(p?.markPrice),
    liquidationPrice: nullish(p?.liquidationPrice),
    leverage: n(p?.leverage),
    unrealizedPnl: n(p?.unrealizedPnl ?? p?.info?.unRealizedProfit),
    percentage: nullish(p?.percentage)
  }
}

/**
 * 当前持仓（ccxt 统一 `fetchPositions()` → 币安 `/fapi/v2/positionRisk`）。
 * 只留有仓位的（仓量为 0 的一律丢掉）。
 */
export async function fetchExchangePositions(
  c: ExchangeCredentials
): Promise<PositionRow[]> {
  const ex = createExchange(c)
  if (typeof ex.fetchPositions !== 'function') return []
  await ex.loadMarkets()
  const rows: any[] = (await ex.fetchPositions()) ?? []
  return rows
    .map((p: any) => mapPosition(p))
    .filter((p: PositionRow) => p.contracts !== 0 || p.notional !== 0)
    .sort(
      (a: PositionRow, b: PositionRow) =>
        Math.abs(b.notional) - Math.abs(a.notional)
    )
}

/**
 * 当前挂单（ccxt 统一 `fetchOpenOrders()` → 币安 `/fapi/v1/openOrders`）。
 * ⚠️ 币安合约的挂单接口**不需要交易对** —— 这块比历史订单好拿得多。
 */
export async function fetchOpenOrders(
  c: ExchangeCredentials,
  limit = 100
): Promise<OrderRow[]> {
  const ex = createExchange(c)
  await ex.loadMarkets()
  const cap = Math.max(1, Math.min(200, limit))
  const rows: any[] = (await ex.fetchOpenOrders(undefined, undefined, cap)) ?? []
  const list: OrderRow[] = rows.map((o: any) => mapOrder(o))
  list.sort((a: OrderRow, b: OrderRow) =>
    (b.datetime ?? '').localeCompare(a.datetime ?? '')
  )
  return list
}

export interface RealizedPnlRow {
  symbol: string
  income: number
  time: string | null
}

/**
 * 已实现盈亏（`/fapi/v1/income?incomeType=REALIZED_PNL`）。
 * 币安专属（USDⓈ-M 合约钱包）；别的交易所没有这个方法 → 返回 null，前端不显示这一块。
 */
export async function fetchRealizedPnl(
  c: ExchangeCredentials,
  limit = 30
): Promise<RealizedPnlRow[] | null> {
  const ex = createExchange(c)
  if (typeof ex.fapiPrivateGetIncome !== 'function') return null
  const cap = Math.max(1, Math.min(1000, limit))
  const rows = await ex.fapiPrivateGetIncome({
    incomeType: 'REALIZED_PNL',
    limit: cap
  })
  return (rows ?? []).map((r: any) => ({
    symbol: String(r?.symbol ?? ''),
    income: n(r?.income),
    time: Number.isFinite(Number(r?.time))
      ? new Date(Number(r.time)).toISOString()
      : null
  }))
}

/** 「这一套账户」查余额 + 持仓 + 挂单 + 订单：每一项各自失败都不影响其它 */
export async function fetchExchangeAccount(
  c: ExchangeCredentials,
  opts: {orderLimit?: number; symbol?: string} = {}
): Promise<{
  balance: BalanceResult | null
  positions: PositionRow[] | null
  openOrders: OrderRow[] | null
  orders: OrdersResult | null
  income: RealizedPnlRow[] | null
  balanceError: string | null
  positionsError: string | null
  openOrdersError: string | null
  ordersError: string | null
  incomeError: string | null
}> {
  const orderLimit = opts.orderLimit ?? 50
  // 现货账户没有「持仓」这一说，也拿不到合约收益流水
  const isSwap = c.marketType !== 'spot'

  const [bal, pos, open, income] = await Promise.allSettled([
    fetchExchangeBalance(c),
    isSwap ? fetchExchangePositions(c) : Promise.resolve([] as PositionRow[]),
    fetchOpenOrders(c, orderLimit),
    isSwap
      ? fetchRealizedPnl(c, Math.max(30, orderLimit * 20))
      : Promise.resolve(null)
  ])

  const balance = bal.status === 'fulfilled' ? bal.value : null

  // 订单历史仍要交易对（币安 allOrders 必填）—— 用余额推出来的币兜底
  let orders: OrdersResult | null = null
  let ordersError: string | null = null
  try {
    orders = await fetchExchangeOrders(c, {
      limit: orderLimit,
      symbol: opts.symbol,
      symbols: deriveSymbols(c, balance)
    })
  } catch (e) {
    ordersError = humanize(e)
  }

  return {
    balance,
    positions: pos.status === 'fulfilled' ? pos.value : null,
    openOrders: open.status === 'fulfilled' ? open.value : null,
    orders,
    income: income.status === 'fulfilled' ? income.value : null,
    balanceError: bal.status === 'rejected' ? humanize(bal.reason) : null,
    positionsError: pos.status === 'rejected' ? humanize(pos.reason) : null,
    openOrdersError: open.status === 'rejected' ? humanize(open.reason) : null,
    ordersError,
    incomeError: income.status === 'rejected' ? humanize(income.reason) : null
  }
}

