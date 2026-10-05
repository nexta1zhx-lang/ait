import {createExchange, humanize, type ExchangeCredentials} from './exchange-account'

/**
 * 合约下单（2026-10-05）。
 *
 * 用户原话：「合约下单，在 k 线页面底部新增下单模块，多空 / 滑动条 / 余额 / 杠杆」。
 *
 * ★ 下单有**两种模式**，由前端显式传 `test` 决定（用户 2026-10-05 追加）：
 *   · `test !== false`（**默认**）→ `POST /fapi/v1/order/test`
 *     币安照常校验签名 / 参数 / 权限 / 保证金，但**不进撮合、不真开仓**。
 *   · `test === false` → `POST /fapi/v1/order` —— **真下单**，会真开仓、真扣保证金。
 *     开关在「配置 → 测试下单」里，关掉就是真单。
 *
 * ⚠️ 参数漏传 / 传错一律落在**测试单**那一侧（下面 `submitOrder` 里是 `test !== false`），
 *    宁可误当测试单，也不能误真下单。
 *
 * 凭据同样**只在本进程里用**（`createExchange` 那套），不回前端。
 */

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

const nullish = (v: unknown): number | null =>
  v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v)

/**
 * 下单相关的报错翻成中文（认不出就退回 `exchange-account.humanize` 那套通用的）。
 *
 * ⚠️⚠️ **别用英文关键词去匹配整条消息** —— ccxt 的报错里**带着请求 URL**：
 *   `binance GET https://fapi.binance.com/fapi/v1/leverageBracket?... 404 Not Found`
 *   `binance GET https://fapi.binance.com/fapi/v2/balance?timestamp=...&signature=...`
 *   于是 `leverage`、`timestamp`、`positionSide` 这些词**在 URL 里全都能匹配上**，
 *   结果一次网络抖动 / 接口 404 被翻译成「杠杆超范围」「时间戳校验失败」
 *   「持仓方向对不上」—— 三个都跟真实原因无关，越查越远。
 *   ⇒ **只认币安回的 `"code"`**，其余交给 `humanize`（它认 IP / 权限 / Key 那几条）。
 */
export function humanizeTrade(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e)
  const code = Number(raw.match(/"code"\s*:\s*(-?\d+)/)?.[1])
  switch (code) {
    case -2019:
      return '保证金不够（可用余额开不了这个仓位）'
    case -4061:
    case -4067:
      return '持仓方向对不上（单向 / 双向持仓模式不一致）'
    case -1013:
    case -4164:
      return '数量太小（不到交易所的最小下单量 / 最小名义价值）'
    case -1111:
    case -4014:
    case -4016:
      return '价格或数量的小数位不对（超出这个合约的精度）'
    case -4003:
      return '数量超过这个合约允许的最大下单量'
    case -4028:
    case -4029:
      return '杠杆超出这个合约允许的范围'
    case -4131:
      return '价格离标记价太远（超出涨跌停）'
    /*
     * 币安的「冷静期」：Key 刚建 / 刚开合约权限那阵，**接口一律不许交易**
     * （2026-10-05 在线上真账户实测到，读余额正常、一下单就是这条）。
     * ⚠️ 这条**不是** IP 白名单也不是权限没开 —— 别让用户去白名单里瞎改，
     *    文案里直接说清楚「币安那边的限制，等等再试」。
     */
    case -4192:
      return '币安那边在「冷静期」：这把 Key 暂时不许下单（新 Key / 刚开合约权限常见），过一阵再试'
    case -1021:
      return '本机时间和服务器差太多（时间戳校验失败）'
    case -4048:
    case -2022:
      return '持仓模式不对（交易所那边是只减仓 / 双向持仓）'
  }
  /*
   * 币安「页面不存在」这类没有 `code` 的情况（HTML / 404）在 `humanize` 里统一处理
   * （它也会先把 URL 抠掉再匹配）—— 这里只管合约下单独有的那几个 code。
   */
  if (/insufficient|margin is not enough/i.test(raw.replace(/https?:\/\/\S+/g, ' ')))
    return '保证金不够（可用余额开不了这个仓位）'
  return humanize(e)
}

/** 这套账户能不能下 U 本位合约的单（不能就把原因说清楚，别让它卡在交易所的报错里） */
function assertTradable(c: ExchangeCredentials): void {
  if (c.marketType !== 'swap')
    throw new Error(
      '这套账户是现货，不能下合约单 —— 去「我的 → 个人信息 → 交易所」加一套 U 本位合约的 Key'
    )
  /*
   * 沙盒（模拟盘）**放行**：以前这里拦着，理由是「币安合约测试网已下线」——
   * 那说的是 ccxt 的 `setSandboxMode`（对合约直接抛 NotSupported），
   * 官方替代品是**模拟盘 demo trading**（`https://demo-fapi.binance.com`），
   * ccxt 用 `enableDemoTrading(true)` 切（见 `exchange-account.createExchange`）。
   *
   * 放行之后**本地开发就有路走了**（2026-10-05 用户问的）：本地出口 IP 会变，
   * 白名单根本填不住；模拟盘 Key 不用白名单、不碰真钱，这一整条链路照样跑得通。
   */
}

/* ------------------------------------------------------------------ */
/* 交易对规格（精度 / 最小量）                                        */
/* ------------------------------------------------------------------ */

/** 币安 U 本位合约接口（跟 `contracts.ts` 同一个环境变量口径） */
const FAPI_BASE = process.env.FAPI_BASE ?? 'https://fapi.binance.com'
/** 币安**模拟盘**（沙盒 Key 走的那个环境）。旧合约测试网已废弃，见 `assertTradable` */
const FAPI_DEMO_BASE = process.env.FAPI_DEMO_BASE ?? 'https://demo-fapi.binance.com'

/**
 * 这套凭据该打哪个环境。
 *
 * ⚠️ 规格（精度 / 最小量）**必须跟凭据同一个环境**：
 *    实测 demo 与线上并不一致（BTCUSDT 的 `stepSize` demo 0.0001、线上 0.001），
 *    拿线上规格去算 demo 单的数量，会被 -1111（精度不对）顶回来。
 *    所以缓存 key 里也带着环境（见 `loadSpecs`）。
 */
const fapiBase = (c: ExchangeCredentials): string =>
  c.sandbox ? FAPI_DEMO_BASE : FAPI_BASE

/** 一个合约的下单规格（就是 exchangeInfo 里那几条 filter，摊平出来） */
interface SymbolSpec {
  /** 币安原始符号，如 BTCUSDT */
  symbol: string
  /** 基础币，如 BTC */
  base: string
  /** LOT_SIZE.stepSize —— 数量必须是它的整数倍 */
  stepSize: number
  /** LOT_SIZE.minQty */
  minQty: number
  /** PRICE_FILTER.tickSize —— 价格必须是它的整数倍 */
  tickSize: number
  /** MIN_NOTIONAL.notional */
  minNotional: number
}

/**
 * 规格缓存。
 *
 * `exchangeInfo` 是**公开接口**（不用凭据、~1.5MB / 920 个合约），
 * 而且规格几小时都不会变 —— 缓 6 小时。
 *
 * ⚠️ 故意**不用 ccxt 的 `loadMarkets()`**：它顺手会去调一个**私有**的
 *    `fetchCurrencies()`（币安那套 `capital/config/getall`），
 *    对「只有合约交易权限」的 Key 是多余的请求，还慢一倍。
 *    这里只需要 filter，直接读公开的 exchangeInfo 就够。
 */
interface SpecsCache {
  at: number
  bySymbol: Map<string, SymbolSpec>
  /**
   * 「有这么个合约、但**现在不能交易**」的：符号 → 币安给的状态。
   * 下架 / 交割中的合约（`SETTLING`）就是这一档 —— 它们还能在公开的
   * `exchangeInfo` 里查到（所以列表里可能还留着），但下不了单。
   * 留着它是为了**把话说准**：用户 2026-10-05 就是拿着这样的币来问的
   * （本地那份币种表是前一天同步的，交割中的币还没剔掉）。
   */
  off: Map<string, string>
}
const SPECS_TTL = 6 * 60 * 60 * 1000
const specsCache = new Map<string, SpecsCache>()

async function loadSpecs(c: ExchangeCredentials): Promise<SpecsCache> {
  /* 环境也算进 key：demo 和线上的规格不一样（见 `fapiBase`） */
  const key = `${c.exchange}|${c.marketType}|${c.sandbox ? 'demo' : 'live'}`
  const hit = specsCache.get(key)
  if (hit && Date.now() - hit.at < SPECS_TTL) return hit

  const url = `${fapiBase(c)}/fapi/v1/exchangeInfo`
  const res = await fetch(url, {
    headers: {'User-Agent': 'crypto-entry-advisor'}
  })
  if (!res.ok) throw new Error(`读合约规格失败：${url} 返回 HTTP ${res.status}`)
  const json = (await res.json()) as {symbols?: Array<Record<string, any>>}
  /*
   * 空列表直接报错 —— 别让它往后走。
   *
   * 2026-10-06 本地实测踩到过：某一次拿到的是**没有 `symbols` 的 200**，
   * 于是 `bySymbol` 建成空的、还被缓存 6 小时，接着每个币都报
   * 「币安的合约列表里没有「BTC」这个交易对」—— 一句话把人带偏到币安身上。
   * 现在这种响应直接失败（不缓存），并把响应开头带出来。
   */
  if (!json.symbols?.length) {
    const body = JSON.stringify(json).slice(0, 160)
    throw new Error(
      `读合约规格失败：${url} 的响应里没有合约列表（HTTP ${res.status}，${body}）`
    )
  }

  const bySymbol = new Map<string, SymbolSpec>()
  const off = new Map<string, string>()
  for (const s of json.symbols ?? []) {
    if (s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT') continue
    const sym = String(s.symbol).toUpperCase()
    const status = String(s.status ?? '')
    /*
     * 不是 TRADING 的（下架 / 交割中 `SETTLING` / `PENDING_TRADING`…）
     * 记进 `off`：它们**还在** exchangeInfo 里，光说「没这个交易对」是错的。
     */
    if (status !== 'TRADING') {
      off.set(sym, status)
      continue
    }
    const filters: Array<Record<string, any>> = s.filters ?? []
    const f = (type: string) => filters.find(x => x.filterType === type) ?? {}
    bySymbol.set(sym, {
      symbol: sym,
      base: String(s.baseAsset ?? ''),
      stepSize: n(f('LOT_SIZE').stepSize),
      minQty: n(f('LOT_SIZE').minQty),
      tickSize: n(f('PRICE_FILTER').tickSize),
      minNotional: n(f('MIN_NOTIONAL').notional)
    })
  }
  const fresh: SpecsCache = {at: Date.now(), bySymbol, off}
  specsCache.set(key, fresh)
  return fresh
}

/** 前端给的是币安原始符号（`BTCUSDT`） */
async function specFor(
  c: ExchangeCredentials,
  raw: string
): Promise<SymbolSpec> {
  const want = String(raw ?? '').trim().toUpperCase()
  const {bySymbol, off} = await loadSpecs(c)
  const spec = bySymbol.get(want)
  if (spec) return spec
  /*
   * 分两种说法，别混成一句「没这个交易对」——
   * 交割中 / 已下架的币**确实还在**币安的列表里，只是不能下单了
   *（币种表是每天同步的，最快也要一天才会把它剔掉）。
   */
  const status = off.get(want)
  if (status)
    throw new Error(
      `币安那边「${want}」已经不能交易了（${status === 'SETTLING' ? '正在交割 / 已下架' : `状态 ${status}`}），换一个币种`
    )
  throw new Error(`币安的合约列表里没有「${want}」这个交易对`)
}

/** 步长（0.001）→ 小数位（3）。交易所给的 `stepSize` 是**值**不是位数。 */
function stepToDecimals(step: unknown): number {
  const s = Number(step)
  if (!Number.isFinite(s) || s <= 0) return 0
  return Math.max(0, Math.min(12, Math.ceil(-Math.log10(s))))
}

/** 按步长**向下**取整（下单量宁可小一点，绝不能超出余额 / 精度） */
function floorToStep(v: number, step: number): number {
  if (!(step > 0)) return v
  return Number((Math.floor(v / step + 1e-9) * step).toFixed(stepToDecimals(step)))
}

/* ------------------------------------------------------------------ */
/* 余额 / 杠杆                                                        */
/* ------------------------------------------------------------------ */

export interface FuturesBalance {
  /** 可用余额（能开新仓的那部分） */
  available: number
  /** 钱包余额（不含浮盈） */
  wallet: number
  /** 未实现盈亏 */
  unrealized: number
}

/**
 * 合约账户余额（`GET /fapi/v2/balance`）。
 * ⚠️ 普通 U 本位账户**只有 USDT 一行**，但多资产账户可能有几行 —— 全加起来。
 */
export async function fetchFuturesBalance(ex: any): Promise<FuturesBalance> {
  const rows: any[] = (await ex.fapiPrivateV2GetBalance()) ?? []
  let available = 0
  let wallet = 0
  let unrealized = 0
  for (const r of rows) {
    available += n(r?.availableBalance)
    wallet += n(r?.balance)
    unrealized += n(r?.crossUnPnl)
  }
  return {available, wallet, unrealized}
}

/**
 * 这个交易对当前的杠杆（`GET /fapi/v2/positionRisk?symbol=`）—— 没持仓也会回一条。
 *
 * ⚠️ 版本这块有坑（实测，用真 Key 打的）：
 *   · **v1 已经下线**：`/fapi/v1/positionRisk` 直接 404（回的是币安那张 HTML 错误页）
 *   · **v3 在「这个交易对没有持仓」时回空数组**（实测 `[]`）—— 拿不到杠杆
 *   · **v2 照常回那一条**（`leverage: "20"`，`positionSide: "BOTH"`）
 * 所以**优先 v2**，v3 只当兜底（v2 哪天也下线了才轮到它）。
 */
async function readPositionRiskRow(
  ex: any,
  symbol?: string
): Promise<any[] | any | null> {
  const call =
    typeof ex.fapiPrivateV2GetPositionRisk === 'function'
      ? ex.fapiPrivateV2GetPositionRisk
      : typeof ex.fapiPrivateV3GetPositionRisk === 'function'
        ? ex.fapiPrivateV3GetPositionRisk
        : ex.fapiPrivateGetPositionRisk
  const rows: any[] = (await call.call(ex, symbol ? {symbol} : {})) ?? []
  if (!Array.isArray(rows)) return null
  if (!symbol) return rows
  return (
    rows.find(
      r => String(r?.symbol ?? '').toUpperCase() === symbol.toUpperCase()
    ) ?? rows[0] ?? null
  )
}

/**
 * 一条持仓（面板「仓位」那一格列出来的那种）。
 * 比 `FuturesPosition` 多一个 `symbol` —— 那个是「某个交易对的持仓」，
 * 这个能跨交易对凑成一个列表。
 */
export interface FuturesPositionRow extends FuturesPosition {
  /** 币安原始符号（BTCUSDT） */
  symbol: string
}

/** 一个交易对当前的持仓（没持仓就是 `null`） */
export interface FuturesPosition {
  side: 'long' | 'short'
  /** 持仓量（基础币，**绝对值**） */
  amount: number
  /** 开仓均价 */
  entryPrice: number
  /** 标记价 */
  markPrice: number
  /** 未实现盈亏（USDT） */
  unrealized: number
  /** 名义价值（USDT） */
  notional: number
  /** 这个交易对的杠杆 */
  leverage: number
}

/**
 * 从 `positionRisk` 那一行里读持仓。
 *
 * ⚠️ 方向要看 `positionSide`：
 *   · 双向持仓模式（`LONG` / `SHORT`）→ 直接用
 *   · 单向持仓模式（`BOTH`）→ `positionAmt` **带正负号**（正 = 多）
 */
function positionFromRow(row: any): FuturesPosition | null {
  if (!row) return null
  const amt = n(row.positionAmt)
  if (!Number.isFinite(amt) || amt === 0) return null
  const ps = String(row.positionSide ?? 'BOTH').toUpperCase()
  const side: 'long' | 'short' =
    ps === 'LONG' ? 'long' : ps === 'SHORT' ? 'short' : amt > 0 ? 'long' : 'short'
  const entryPrice = Number(row.entryPrice)
  const markPrice = Number(row.markPrice)
  return {
    side,
    amount: Math.abs(amt),
    entryPrice: Number.isFinite(entryPrice) ? entryPrice : 0,
    markPrice: Number.isFinite(markPrice) ? markPrice : 0,
    unrealized: n(row.unRealizedProfit),
    notional: Number.isFinite(markPrice) ? Math.abs(amt) * markPrice : 0,
    leverage: Math.floor(n(row.leverage)) || 0
  }
}

/** 这个交易对允许的最大杠杆（`GET /fapi/v1/leverageBracket?symbol=` 的第一档） */
async function readMaxLeverage(ex: any, symbol: string): Promise<number | null> {
  const rows: any[] = (await ex.fapiPrivateGetLeverageBracket({symbol})) ?? []
  const row = Array.isArray(rows) ? rows[0] : null
  const first = row?.brackets?.[0]
  return nullish(first?.initialLeverage)
}

/* ------------------------------------------------------------------ */
/* 一个交易对的「下单信息」（面板初始化那一把）                        */
/* ------------------------------------------------------------------ */

export interface TradeInfo {
  /** 币安原始符号 */
  symbol: string
  /** 基准币（BTC） */
  base: string
  balance: FuturesBalance
  /** 当前杠杆（读不到就是 null，前端退回默认值） */
  leverage: number | null
  /** 交易所允许的最大杠杆（读不到就是 null） */
  maxLeverage: number | null
  /** 当前持仓（没持仓 / 读不到就是 null） */
  position: FuturesPosition | null
  /** 数量小数位（0.001 的步长 → 3） */
  amountPrecision: number
  /** 价格小数位 */
  pricePrecision: number
  /** 最小下单量（基础币） */
  minAmount: number
  /** 最小名义价值（USDT） */
  minCost: number
  /**
   * **余额没读到的原因**（有值 = 可用余额不可信，别拿它算仓位）。
   * 单独拎出来是因为它跟杠杆那几条性质不同：杠杆读不到还能照常下单，
   * 余额读不到就必须拦住、并且把真正的原因（IP 白名单 / 权限）摆给用户看，
   * 不能笼统说一句「没有可用余额」。
   */
  balanceError: string | null
  /** 杠杆 / 最大杠杆没拿到的原因（只是提示，不挡下单） */
  errors: string[]
}

/**
 * 面板要的那一把：余额 + 杠杆 + 精度。
 *
 * 三件事**并发打**（彼此不依赖），单项失败不拖垮整体 ——
 * 余额读不到也还能显示面板，只是「可用」是「—」。
 */
export async function collectTradeInfo(
  c: ExchangeCredentials,
  rawSymbol: string
): Promise<TradeInfo> {
  assertTradable(c)
  const spec = await specFor(c, rawSymbol)
  const ex = createExchange(c)
  const errors: string[] = []
  let balanceError: string | null = null

  /* 杠杆和持仓出自**同一次** `positionRisk`（这个接口不便宜，别打两遍） */
  let riskRow: any = null
  const [balance, , maxLeverage] = await Promise.all([
    fetchFuturesBalance(ex).catch(e => {
      balanceError = humanizeTrade(e)
      return {available: 0, wallet: 0, unrealized: 0}
    }),
    readPositionRiskRow(ex, spec.symbol).then(
      r => {
        riskRow = r
        return r
      },
      e => {
        errors.push(`当前杠杆没读到：${humanizeTrade(e)}`)
        return null
      }
    ),
    readMaxLeverage(ex, spec.symbol).catch(e => {
      errors.push(`最大杠杆没读到：${humanizeTrade(e)}`)
      return null
    })
  ])
  const leverage = nullish(riskRow?.leverage)

  return {
    symbol: spec.symbol,
    base: spec.base,
    balance,
    leverage,
    maxLeverage,
    position: positionFromRow(riskRow),
    amountPrecision: stepToDecimals(spec.stepSize),
    pricePrecision: stepToDecimals(spec.tickSize),
    minAmount: spec.minQty,
    minCost: spec.minNotional,
    balanceError,
    errors
  }
}

/* ------------------------------------------------------------------ */
/* 调杠杆 / 下单                                                      */
/* ------------------------------------------------------------------ */

/** 这套 Key 是不是「双向持仓」——5 分钟内不重复问（这个接口权重 30，不便宜） */
const dualSideCache = new Map<number | string, {at: number; dual: boolean}>()
const DUAL_TTL = 5 * 60 * 1000

async function isDualSide(ex: any, cacheKey: number | string): Promise<boolean> {
  const hit = dualSideCache.get(cacheKey)
  if (hit && Date.now() - hit.at < DUAL_TTL) return hit.dual
  const r: any = await ex.fapiPrivateGetPositionSideDual()
  const dual = r?.dualSidePosition === true || r?.dualSidePosition === 'true'
  dualSideCache.set(cacheKey, {at: Date.now(), dual})
  return dual
}

/**
 * 调这个交易对的杠杆（`POST /fapi/v1/leverage`）。
 *
 * ⚠️ 有持仓 / 挂单时交易所不让改（会报错），原样把它的原因翻出来给用户。
 */
export async function setSymbolLeverage(
  c: ExchangeCredentials,
  rawSymbol: string,
  leverage: number
): Promise<{symbol: string; leverage: number}> {
  assertTradable(c)
  if (!Number.isFinite(leverage) || leverage < 1)
    throw new Error('杠杆至少 1 倍')
  const spec = await specFor(c, rawSymbol)
  const ex = createExchange(c)

  const lev = Math.floor(leverage)
  const r: any = await ex.fapiPrivatePostLeverage({
    symbol: spec.symbol,
    leverage: lev
  })
  return {symbol: spec.symbol, leverage: n(r?.leverage) || lev}
}

export interface OrderInput {
  /** 币安原始符号，如 BTCUSDT */
  symbol: string
  /** long = 买入 / short = 卖出 */
  side: 'long' | 'short'
  type: 'market' | 'limit'
  /** 基础币数量（面板算好传过来） */
  quantity: number
  /**
   * 限价单 = 委托价（必填）。
   * 市价单 = 面板算数量时用的参考价（标记价 / 现价），**只用来做最小名义价值的体检**，
   *           不发给交易所 —— 给了能早点拦下「太小」的单，不给就跳过这项检查。
   */
  price?: number
  /** 只减仓（平仓用）。⚠️ 双向持仓模式下币安**不允许**带这个参数，见 `placeOrder` */
  reduceOnly?: boolean
  /**
   * `true`（或不传）= 走测试接口，只校验不真开仓；
   * `false` = **真下单**（配置里「测试下单」关掉时才会传）。
   */
  test?: boolean
}

/** 真正发给交易所的那几个参数（回给前端，好在界面上复述一遍） */
export interface OrderParams {
  symbol: string
  side: 'BUY' | 'SELL'
  type: 'MARKET' | 'LIMIT'
  quantity: number
  price?: number
  timeInForce?: string
  positionSide?: 'LONG' | 'SHORT'
  reduceOnly?: boolean
}

/** 一张已经发出去的单：参数 + 走的哪种模式 + 交易所回的号（测试单没有） */
export interface PlacedOrder extends OrderParams {
  /** `true` = 测试单（只校验）；`false` = **真单**（已进撮合） */
  test: boolean
  orderId?: string
  /** 交易所回的状态（真单一般回 `NEW` / `FILLED`；测试单是空对象、没有这个字段） */
  status?: string
}

/**
 * 真正把单发出去 —— 测试单 / 真单**只差最后那一行接口名**，别的逻辑一模一样。
 *
 * ⚠️ `test !== false` 才是测试单：默认值、`undefined`、`null` 全都落在这边。
 */
async function submitOrder(
  ex: any,
  params: OrderParams,
  test: boolean
): Promise<Pick<PlacedOrder, 'orderId' | 'status'>> {
  if (test) {
    await ex.fapiPrivatePostOrderTest({...params})
    /* 测试单成功时交易所只回一个空对象 ⇒ 没有 orderId / status */
    return {}
  }
  const r: any = await ex.fapiPrivatePostOrder({...params})
  return {
    orderId: r?.orderId === undefined ? undefined : String(r.orderId),
    status: r?.status === undefined ? undefined : String(r.status)
  }
}

/**
 * 下一张单（`POST /fapi/v1/order/test`，或 `test: false` 时走 `POST /fapi/v1/order`）。
 *
 * ⚠️ 测试单**不会真的开仓**：币安只校验参数 / 签名 / 权限 / 保证金，
 *    成功时交易所回一个空对象（`{}`），所以这里把「发出去的参数」回给前端复述。
 */
export async function placeOrder(
  c: ExchangeCredentials,
  keyId: number | string,
  input: OrderInput
): Promise<PlacedOrder> {
  assertTradable(c)
  const qtyRaw = Number(input.quantity)
  if (!Number.isFinite(qtyRaw) || qtyRaw <= 0)
    throw new Error('数量要先填好（拖一下滑动条选仓位）')
  if (input.type === 'limit') {
    const px = Number(input.price)
    if (!Number.isFinite(px) || px <= 0) throw new Error('限价单要先填价格')
  }

  const ex = createExchange(c)
  const spec = await specFor(c, input.symbol)
  const symbol = spec.symbol

  // 按交易所的步长**向下**收（面板算出来的可能多几位小数）
  const quantity = floorToStep(qtyRaw, spec.stepSize)
  if (quantity <= 0) throw new Error('数量太小：按这个合约的精度取整之后是 0')

  if (spec.minQty && quantity < spec.minQty)
    throw new Error(`数量太小：这个合约最少要下 ${spec.minQty} ${spec.base}`)

  const params: OrderParams = {
    symbol,
    side: input.side === 'short' ? 'SELL' : 'BUY',
    type: input.type === 'limit' ? 'LIMIT' : 'MARKET',
    quantity
  }

  const price = Number(input.price)
  if (input.type === 'limit') {
    if (!Number.isFinite(price) || price <= 0)
      throw new Error('限价单要先填价格')
    params.price = floorToStep(price, spec.tickSize)
    // 币安限价单必须给有效方式，GTC = 挂着直到成交或我撤
    params.timeInForce = 'GTC'
  }

  if (
    spec.minNotional &&
    Number.isFinite(price) &&
    price > 0 &&
    quantity * price < spec.minNotional
  )
    throw new Error(
      `名义价值太小：这一单约 ${(quantity * price).toFixed(2)} USDT，` +
        `不到交易所要求的 ${spec.minNotional} USDT`
    )

  /*
   * 双向持仓模式下**必须**带 `positionSide`（不带会报 -4061）；
   * 单向持仓模式下**不能**带。所以先问一次账户是哪种（5 分钟内不重复问）。
   *
   * ⚠️ 同理，`reduceOnly` **只在单向持仓模式下能带**：双向模式下币安直接回
   *    -1106（`Parameter 'reduceonly' sent when not required`）。双向模式本来就靠
   *    「反方向 + 同一个 positionSide」自动减仓，不需要它。
   */
  const dual = await isDualSide(ex, keyId)
  if (dual) params.positionSide = params.side === 'BUY' ? 'LONG' : 'SHORT'
  else if (input.reduceOnly) params.reduceOnly = true

  const test = input.test !== false
  const placed = await submitOrder(ex, params, test)
  return {...params, test, ...placed}
}

/* ------------------------------------------------------------------ */
/* 平仓                                                               */
/* ------------------------------------------------------------------ */

export interface CloseOrderParams extends PlacedOrder {
  /** 这一单对应的是哪个方向的持仓（给人看的） */
  from: 'long' | 'short'
}

/** 从这个交易对的行里挑出「哪个方向」的那一条（双向持仓时一个币有两条） */
function pickSide(rows: any[], side: 'long' | 'short'): any[] {
  const hit = rows.filter(r => positionFromRow(r)?.side === side)
  return hit.length ? hit : rows
}

/**
 * 平仓（跟下单同一个接口：默认**测试单**，`test: false` 时**真平仓**）。
 *
 * 三种用法（`target` 越具体，平的越少）：
 *   · 不传            → 把账户里**有持仓的全平一遍**（顶栏「一键平仓」）
 *   · 只给 `symbol`   → 平这个交易对（⚠️ 双向持仓模式下会**两条都平**）
 *   · `symbol + side` → 只平这个方向的这一条（面板上每一行的「平仓」）
 */
export async function closePositions(
  c: ExchangeCredentials,
  keyId: number | string,
  target?: {symbol?: string; side?: 'long' | 'short'},
  test = true
): Promise<{orders: CloseOrderParams[]}> {
  assertTradable(c)
  const ex = createExchange(c)

  let rows: any[]
  if (target?.symbol) {
    const spec = await specFor(c, target.symbol)
    const row = await readPositionRiskRow(ex, spec.symbol)
    rows = row ? [row] : []
    /* 双向持仓：一个币两条（LONG / SHORT），面板上那一行要精确到方向 */
    if (target.side && rows.length) rows = pickSide(rows, target.side)
  } else {
    const all = await readPositionRiskRow(ex, undefined)
    rows = Array.isArray(all) ? all : all ? [all] : []
  }

  const held = rows.map(r => ({row: r, pos: positionFromRow(r)}))
  const live = held.filter(h => h.pos) as {row: any; pos: FuturesPosition}[]

  if (!live.length)
    throw new Error(target?.symbol ? '这个交易对现在没有持仓' : '现在没有任何持仓')

  const dual = await isDualSide(ex, keyId)
  const orders: CloseOrderParams[] = []

  for (const {row, pos} of live) {
    const symbol = String(row.symbol ?? '').toUpperCase()
    if (!symbol) continue
    const spec = await specFor(c, symbol)
    const quantity = floorToStep(pos.amount, spec.stepSize)
    if (!(quantity > 0)) continue
    /* ⚠️ `from` 只是回给前端看的，**不能**混进发给交易所的参数里 */
    const params: OrderParams = {
      symbol,
      side: pos.side === 'long' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity
    }
    if (dual) params.positionSide = pos.side === 'long' ? 'LONG' : 'SHORT'
    else params.reduceOnly = true
    const placed = await submitOrder(ex, params, test)
    orders.push({...params, test, ...placed, from: pos.side})
  }

  if (!orders.length) throw new Error('持仓太小，按合约精度取整之后是 0，平不掉')
  return {orders}
}

/**
 * 账户里**所有**持仓（面板「仓位」那一格用的列表）。
 *
 * ⚠️ 双向持仓模式下同一个币会有两条（LONG / SHORT），所以每一条都得看
 *    `positionSide`，不能只按 symbol 去重。
 */
export async function listPositions(
  c: ExchangeCredentials
): Promise<FuturesPositionRow[]> {
  assertTradable(c)
  const ex = createExchange(c)
  const all = await readPositionRiskRow(ex, undefined)
  const rows = Array.isArray(all) ? all : all ? [all] : []
  const out: FuturesPositionRow[] = []
  for (const r of rows) {
    const pos = positionFromRow(r)
    const symbol = String(r?.symbol ?? '').toUpperCase()
    if (!pos || !symbol) continue
    out.push({...pos, symbol})
  }
  /* 名义大的排前面：一眼看到最要紧的那笔 */
  out.sort((a, b) => b.notional - a.notional)
  return out
}
