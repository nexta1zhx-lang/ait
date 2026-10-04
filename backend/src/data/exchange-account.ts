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

/** 数字兜底（ccxt 有的字段可能是 undefined / NaN） */
function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
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
export function humanize(e: unknown): string {
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

/* ------------------------------------------------------------------ */
/* 持仓 / 当前挂单                                                    */
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
