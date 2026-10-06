import ccxt from 'ccxt'
import type {Agent} from 'node:http'

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

/**
 * 交易所**出网代理**（可选，只在本地开发时设）。
 *
 * ★ 为什么非得从这儿过、不能用 `NODE_USE_ENV_PROXY` 那种环境变量代理：
 *   ccxt 4.5 走的是**原生 fetch**（Node 下就是 undici），而它在加载完 undici 后会
 *   自己 new 一个**直连**的 keep-alive dispatcher（`Exchange.fetchDispatcher`），
 *   然后**显式挂到每个请求的 `dispatcher` 上**（`setFetchProxyOptions`）。
 *   显式 dispatcher 的优先级高于全局 dispatcher ⇒ `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`
 *   会被**整条绕过**（实测：裸 fetch 经代理 200，ccxt 同一条代理下 10s 超时）。
 *   ⇒ 代理只能交给 ccxt 自己：`httpProxy` / `httpsProxy`，它内部会建 ProxyAgent。
 *
 * ★ 用途：本地开发机连不上币安（或币安 API Key 的 IP 白名单里只有服务器 IP）时，
 *   把请求从一台能出去的机器绕出去。见 `scripts/dev-proxy.sh` 与 docs/EXCHANGE.md。
 *   ⚠️ 生产**不设**这个变量 ⇒ 一个字节的行为都不变。
 */
export function exchangeProxy(): string | undefined {
  const v = process.env.EXCHANGE_PROXY?.trim()
  return v ? v : undefined
}

/**
 * ccxt 实例的代理选项（`exchangeProxy()` 没值就返回空对象，等于什么都没加）。
 *
 * ⚠️ 只能给 `httpProxy` **一个**，别同时给 `httpsProxy` —— ccxt 会直接拒掉
 *   （`multiple conflicting proxy settings`）。给 `httpProxy` 它内部按
 *   httpProxy → httpsProxy 的顺序挑，挑中的那个对**所有**请求生效（https 也走它）。
 */
export function ccxtProxyOptions(): {httpProxy?: string} {
  const proxy = exchangeProxy()
  return proxy ? {httpProxy: proxy} : {}
}

/**
 * ccxt 的**限流间隔**（毫秒）—— 用户 2026-10-05 选「调小」这条路。
 *
 * ★ 为什么调：币安在 ccxt 里的默认 `rateLimit` 是 **50ms**，意思是「两次请求之间
 *   至少隔 50ms」，而且**并发调用会被它排成 50ms 一档**。服务器上实测（东京 → 币安，
 *   同一个 `/fapi/v1/ping`）：
 *     裸 fetch               4~19ms
 *     ccxt 关限流            2~10ms       ← ccxt 本身几乎不花时间
 *     ccxt 默认（50ms）      53~61ms/条，**3 条并发 153ms**
 *   面板那条接口正好是 3 条并发（余额 / 持仓 / 杠杆）⇒ 白等 150ms。
 *
 * ★ 为什么是 15ms 而不是关掉：这个限流是**防跑飞**用的 —— 万一将来哪个循环出 bug
 *   狂发请求，有节流在最多 66 次/秒；关掉就是裸奔，币安会直接封 IP（418）。
 *   权重预算心里有数：币安上限 2400 权重/分钟，我们最猛的一处是启动预热
 *   （122 条 K 线 × 权重 5 ≈ 610 权重），怎么都够。
 */
export const CCXT_RATE_LIMIT_MS = 15

/** 所有 ccxt 实例共用的基础配置（限流间隔 + 出口代理） */
export function ccxtBaseOptions(): {
  enableRateLimit: boolean
  rateLimit: number
  httpProxy?: string
} {
  return {
    enableRateLimit: true,
    rateLimit: CCXT_RATE_LIMIT_MS,
    ...ccxtProxyOptions()
  }
}

/** 同一个代理地址，给**裸 WebSocket** 用（没有就返回 undefined） */
let wsAgentCache: Agent | undefined
let wsAgentTried = false

/**
 * WS 用的 CONNECT 隧道 agent（跟 `exchangeProxy()` 同一个环境变量，开发用）。
 *
 * ★ 为什么 WS 得单独接一遍：`ws` **不认** `HTTP_PROXY` / `HTTPS_PROXY`，也不认
 *   `NODE_USE_ENV_PROXY` —— 必须自己 `new WebSocket(url, {agent})` 塞进去。
 *
 * ★ 不塞会怎样（本地实测）：墙把 `fstream.binance.com` 解析成**假 IP**（查到的
 *   31.13.94.7 / 108.160.167.165 这类，全是 Facebook / Twitter 的地址），
 *   TCP 甚至能连上、`open` 也触发，但**一条消息都不推** —— 表面看像「连上了没数据」，
 *   实际是根本没连到币安。塞了 agent 之后由代理那侧解析域名，0.7 秒就出货。
 *
 * ⚠️ `https-proxy-agent` 在 **devDependencies** 里（只有本机开发要代理）：
 *   生产镜像 `npm ci --omit=dev` 里没这个包，所以这里用**动态 import** 并吞掉失败 ——
 *   而且生产不设 `EXCHANGE_PROXY`，压根走不到这儿。
 */
export async function wsAgent(): Promise<Agent | undefined> {
  const proxy = exchangeProxy()
  if (!proxy) return undefined
  if (wsAgentTried) return wsAgentCache
  wsAgentTried = true
  try {
    const {HttpsProxyAgent} = await import('https-proxy-agent')
    wsAgentCache = new HttpsProxyAgent(proxy) as unknown as Agent
  } catch (e) {
    console.warn(
      `[proxy] WS 代理用不了（${(e as Error).message.slice(0, 80)}），WS 走直连`
    )
  }
  return wsAgentCache
}

/** 实例缓存：key = 交易所|市场类型|沙盒|apiKey（见 `createExchange` 里那段） */
const instanceCache = new Map<string, {at: number; ex: any}>()
/**
 * markets 正在后台刷新的实例（key 同上）。
 * ⚠️ 没有它的话，几百个并发请求会各踢一次 `loadMarkets()`（每次 1.5MB）。
 */
const refreshing = new Set<string>()
/** markets 表多久重新加载一次（币安上新 / 下架合约之后要能跟上） */
const INSTANCE_TTL_MS = 30 * 60 * 1000
/** 缓存上限，纯保险（正常就几套 Key） */
const INSTANCE_CACHE_MAX = 20

/** 认得出的交易所实例 */
export function createExchange(c: ExchangeCredentials): any {
  /*
   * ★★ 实例缓存（2026-10-05 加。用户原话：「关于合约交易的开单平，订单获取等等
   *    接口响应太慢了怎么回事」）。
   *
   * 为什么非加不可：`fetchPositions` / `fetchOpenOrders` / `createOrder` 这些 ccxt 方法
   * **内部都会先 `loadMarkets()`**，而 markets 是**每个 ccxt 实例各存一份**的。
   * 以前这里每次调用都 `new Ctor(...)` ⇒ **每个请求都要重下 1.5MB 的 exchangeInfo**。
   * 实测（本地，经出口隧道）：
   *     新实例 + 持仓 `fetchPositions`   5312ms
   *     新实例 + 挂单 `fetchOpenOrders` 3477ms
   *     全新实例光 `loadMarkets`        3339ms   （服务器侧同一个动作只要 330ms）
   * 缓存之后这些只剩一条真正的业务调用（服务器侧 ~60ms/条）。
   *
   * ⚠️ 缓存键**必须带 apiKey**：不同 Key 是不同账户（权限 / IP 白名单 / 双向持仓
   *    都可能不一样），共用实例会串号。凭据换了（apiKey 变了）自然换新实例。
   * ⚠️ 给 markets 一个 TTL：币安上新 / 下架合约之后要能重新加载（30 分钟）。
   * ⚠️ 一个实例也就几 MB（markets 表），但保险起见超过 `INSTANCE_CACHE_MAX` 就整体清掉。
   */
  const cacheKey = [
    c.exchange,
    c.marketType,
    c.sandbox ? 'demo' : 'live',
    c.apiKey
  ].join('|')
  const hit = instanceCache.get(cacheKey)
  if (hit) {
    const age = Date.now() - hit.at
    if (age < INSTANCE_TTL_MS) return hit.ex
    /*
     * ★ 过期了**也照样先把它交出去**，只把重新加载 markets 放到后台（2026-10-06）。
     *
     * ⚠️ 为什么不能在这一行「过期就重建」：重建之后 ccxt 要重新 `loadMarkets()`，
     *    而那是**两条**请求（`exchangeInfo` + `currencies`，1.5MB 那个），
     *    本地经出口隧道实测 **3.3~10.5 秒**。也就是说每 30 分钟就有一次
     *    「点开交易所页面，挂单要等十几秒才出来」。
     *    过期只是「markets 可能有点旧」（上新 / 下架要跟上），**不是数据不能用** ——
     *    挂单 / 持仓 / 下单跟 markets 新旧几乎无关（只用来做符号换算和精度校验）。
     *    所以：立刻用旧的，后台换新的，谁也等不着。
     */
    if (!refreshing.has(cacheKey)) {
      refreshing.add(cacheKey)
      const ex = hit.ex
      void Promise.resolve()
        .then(() => ex.loadMarkets())
        .then(() => {
          hit.at = Date.now()
        })
        .catch((e: Error) => {
          /* 刷新失败就用旧的顶着，30 秒后再说（别把 at 推上去，否则要等一整轮） */
          console.warn(`[exch] markets 后台刷新失败：${e.message.slice(0, 100)}`)
        })
        .finally(() => refreshing.delete(cacheKey))
    }
    return hit.ex
  }

  const Ctor = CCXT[c.exchange]
  if (!Ctor)
    throw new Error(`不支持的交易所「${c.exchange}」（ccxt 里没有这个 id）`)
  if (!c.apiKey || !c.secret)
    throw new Error('这套账户还没填 API Key / Secret')

  const ex = new Ctor({
    ...ccxtBaseOptions(),
    apiKey: c.apiKey,
    secret: c.secret,
    ...(c.password ? {password: c.password} : {}),
    options: {
      ...marketOptionsFor(c),
      /*
       * ⚠️⚠️ **持仓必须走 v2 的 `/fapi/v2/positionRisk`**（2026-10-05 查出来的 bug：
       *      用户「持仓杠杆倍数显示不对」）。
       *
       * 币安 v3 版把 `leverage` 字段**删掉了**（实测同一时刻同一个持仓：
       *      v2 → leverage="10"，还有 marginType / maxNotionalValue
       *      v3 → 压根没有 leverage 字段）
       * 而 ccxt 的 `fetchPositions()` 默认走 v3 ⇒ 杠杆读回来是 `undefined`
       * ⇒ `mapPosition()` 里 `n(undefined)` = 0 ⇒ 界面上显示 **0x**。
       * ccxt 留了 `useV2` 这个开关（`fetchPositionsRisk` 的 option），打开就回 v2。
       * 顺带跟 `data/exchange-trade.ts` 的 `readPositionRiskRow()` 口径一致（那边一直用 v2）。
       */
      fetchPositionsRisk: {useV2: true},
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
  if (instanceCache.size >= INSTANCE_CACHE_MAX) instanceCache.clear()
  instanceCache.set(cacheKey, {at: Date.now(), ex})
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
/* 持仓                                                               */
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

