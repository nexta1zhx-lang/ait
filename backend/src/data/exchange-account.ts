import ccxt from 'ccxt'

/**
 * 交易所账户取数（2026-10-04）。
 *
 * 用户原话：「实时分析 tab 后加入交易所账户信息，显示账户余额和订单历史」。
 *
 * 用 CCXT 统一接口：一个交易所 id + apiKey/secret（+ 有的要 passphrase）就能
 * 走 `fetchBalance()` / `fetchOrders()`。**这里只做只读查询**（账户 / 持仓 / 挂单），
 * 不下单、不撤单 —— 下单在 `data/exchange-trade.ts`（2026-10-05 加的，
 * ⚠️ 那边也**只走币安的测试接口**，不做真下单）。
 *
 * ⚠️ 凭据只在这个进程里用，**不回给前端**（列表接口只回掩码，见 db/exchange-keys.ts）。
 *    不过「建议只用读权限」这句话 2026-10-05 起不成立了：要用 K 线页底部那个
 *    下单模块，Key 得有**合约交易**权限（下单模块本身仍是测试单，不会真成交）。
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
  /*
   * 沙盒 / 模拟盘。
   *
   * ⚠️ 币安这边**老办法已经不能用了**：`setSandboxMode(true)` 对合约会直接抛
   *    `NotSupported: binance testnet/sandbox mode is not supported for futures
   *    anymore`（ccxt 把旧合约测试网 `testnet.binancefuture.com` 摘了）。
   *    官方替代品是**模拟盘 demo trading**，地址 `https://demo-fapi.binance.com`
   *    —— ccxt 用 `enableDemoTrading(true)` 切（它把 `urls.api` 换成 `urls.demo`）。
   *    别的交易所没这回事，照旧走 `setSandboxMode`。
   *
   * 这一步是**本地开发能不能跑起来的关键**：本地出口 IP 会变，白名单填不住；
   * 模拟盘 Key 不用白名单、不碰真钱，整条链路（余额 / 杠杆 / 规格 / 测试单）都通。
   */
  if (c.sandbox) {
    if (c.exchange === 'binance' && typeof ex.enableDemoTrading === 'function') {
      ex.enableDemoTrading(true)
    } else if (typeof ex.setSandboxMode === 'function') {
      const r = ex.setSandboxMode(true)
      if (r && typeof r.then === 'function') {
        // 返回 Promise 的版本：这里不能 await（createExchange 是同步的），
        // 忽略即可 —— 沙盒只是改 url，绝大多数版本是同步的
        void r.catch(() => undefined)
      }
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
 * 这几条是绑 Key / 下单最常撞的。
 *
 * ⚠️ **匹配前必须先把请求 URL 抠掉**：ccxt 的报错里带着 URL
 *    （`binance GET https://fapi.binance.com/fapi/v2/balance?timestamp=…&signature=…`），
 *    而 `signature` / `ip` / `leverage` / `positionSide` 这些词**在 URL 里全都有** ⇒
 *    一次网络抖动 / 404 会被翻译成「Key 不对」「IP 没白名单」「杠杆超范围」，
 *    跟真实原因毫不相干，照着查能查一整天（实测踩过）。
 *    抠掉 URL 后还剩关键字的，才是真·那句话。
 *
 * ⚠️ **顺序也有讲究**：`-2015` 那句话里 `API-key` / `IP` / `permissions` 三个词
 *    是**一起**出现的（`Invalid API-key, IP, or permissions for action, request ip: 1.2.3.4`），
 *    而币安绝大多数情况下这条就是**IP 白名单**问题。原来的顺序先判「Key 不对」，
 *    于是永远轮不到 IP 那条 ⇒ 所以 `-2015` 单独按 code 拎出来最先判。
 */
export function humanize(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e)
  // 抠掉 URL 再匹配（原因见上面那段）；下面那个 code 从原文里取
  const m = raw.replace(/https?:\/\/\S+/g, ' ')
  const code = Number(raw.match(/"code"\s*:\s*(-?\d+)/)?.[1])

  /* 币安「页面不存在」时回一张 HTML（接口版本下线就是这样）—— 别把 HTML 甩给用户 */
  if (/404 Not Found/i.test(m) || /<html/i.test(m))
    return '交易所这个接口调不通（404）—— 多半是接口版本变了，需要更新代码'

  if (code === -2015) {
    const ip = raw.match(/request ip:\s*([0-9a-f.:]+)/i)?.[1]
    return (
      '这把 Key 接不下这次请求：多半是「IP 白名单」没放行' +
      (ip ? `（把 ${ip} 加进白名单）` : '') +
      '，其次看它有没有开对应的交易权限'
    )
  }
  if (code === -1003)
    return '交易所限流了（请求太频繁）—— 过一会儿再试'
  if (code === -1022 || code === -2014 || code === -2008)
    return 'API Key / Secret 不对（或复制时多了空格）'
  if (/signature|invalid api-key|api[- ]?key.*(invalid|not exist)/i.test(m))
    return 'API Key / Secret 不对（或复制时多了空格）'
  if (/permission|not authorized|forbidden|-1002/i.test(m))
    return '这把 Key 没有这个操作需要的权限（去交易所给它开对应权限）'
  if (/whitelist|restricted location/i.test(m))
    return '这把 Key 有 IP 白名单限制 —— 要把服务器出口 IP 加进白名单'
  if (requiresSymbol(m)) return '这个交易所要指定交易对才能查订单'
  /* 网络层的问题：把带 URL 的原始报错换成一句人话（URL 已经抠掉了，这些词不会误命中） */
  if (
    /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|TLS|handshake/i.test(
      m
    )
  )
    return '连不上交易所（超时 / TLS 被断 / 网络不通）—— 过一会儿再试'
  return raw
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
