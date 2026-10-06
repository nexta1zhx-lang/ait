import {createExchange, humanize, type ExchangeCredentials} from './exchange-account'
import {loadContracts} from '../contracts'

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

  /*
   * ① 先读**本地那份合约表**（`contract_store`，服务每天自动刷一次，规格也在里面
   *    —— 2026-10-05 加的，见 `contracts.ts` 的 `ContractInfo`）。用户问过
   *    「合约表不是保存在本地吗 一天更新一次」：对，所以下单没必要每次都去问币安。
   *    ⚠️ 沙盒（demo）不走这条 —— 模拟盘的合约集跟线上不一样。
   */
  if (!c.sandbox) {
    const local = await specsFromLocalStore()
    if (local) {
      specsCache.set(key, local)
      return local
    }
  }

  /* ② 本地那份还没有规格（这次改动之前同步的老数据）→ 联网拉一次（原来那条路） */
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

/**
 * 从**本地合约表**拼出规格（不下网）。
 *
 * ⚠️ 返回 `null` 的两种情况：库里是老数据（改这次之前同步的，`ContractInfo` 里没有
 *    规格字段）、或者读取失败 —— 两种都交给调用方走联网那条路，行为跟以前一样。
 * ⚠️ 只收 `status === 'TRADING'` 的；其余（下架 / 交割中）记进 `off`，
 *    这样报错时能说准「是下架了」而不是「没这个交易对」。
 */
async function specsFromLocalStore(): Promise<SpecsCache | null> {
  try {
    const store = await loadContracts()
    const rows = store?.contracts ?? []
    if (!rows.length) return null

    const bySymbol = new Map<string, SymbolSpec>()
    const off = new Map<string, string>()
    let withSpecs = 0
    for (const r of rows) {
      const sym = String(r.symbol ?? '').toUpperCase()
      if (!sym) continue
      if (r.status !== 'TRADING') {
        off.set(sym, String(r.status ?? ''))
        continue
      }
      const stepSize = Number(r.stepSize)
      const tickSize = Number(r.tickSize)
      /* 规格缺任何一个都不算数（宁可回退到下网那条路，也别拿 0 去算数量） */
      if (!(stepSize > 0) || !(tickSize > 0)) continue
      withSpecs++
      bySymbol.set(sym, {
        symbol: sym,
        base: String(r.base ?? ''),
        stepSize,
        minQty: Number(r.minQty) || 0,
        tickSize,
        minNotional: Number(r.minNotional) || 0
      })
    }
    if (!withSpecs) return null
    return {at: Date.now(), bySymbol, off}
  } catch (e) {
    console.warn(
      `[specs] 读本地合约表失败，改用联网：${(e as Error).message.slice(0, 120)}`
    )
    return null
  }
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
  /**
   * **维持保证金** + **维持保证金率**（2026-10-06 加，用户要「MM 合约保证金率」）。
   * 保证金率 = 维持保证金 ÷ 保证金余额，100% 即强平。
   * `mmr` 带着是为了本地随标记价重算（见 `position-cache` 的 `withMark`）。
   */
  maintMargin: number
  mmr: number
  /** 这个交易对的杠杆 */
  leverage: number
  /**
   * 强平价（2026-10-06 加）。
   *
   * 用户要「强平价格」能画在 K 线上 —— `positionRisk` 里本来就有这个字段
   * （v2 那个 `liquidationPrice`），早先只是没往后端对象上搬。
   * ⚠️ 没持仓 / 逐仓没这个数时币安回 `0` 或 `null` ⇒ 这里给 `null`，
   *    界线不要画一条 0 的线出来。
   */
  liquidationPrice: number | null
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
    /* 维持保证金 / 它的费率：币安 raw 字段就是这两个（v2 的 `maintMargin`） */
    maintMargin: n(row.maintMargin ?? row.maintenanceMargin),
    mmr: n(row.maintenanceMarginPercentage),
    leverage: Math.floor(n(row.leverage)) || 0,
    /* 强平价：`0` / 空 / 非数一律当「没有」（别画一条 0 的线） */
    liquidationPrice: (() => {
      const lq = nullish(row.liquidationPrice)
      return lq !== null && lq > 0 ? lq : null
    })()
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
  /** `TAKE_PROFIT_MARKET` / `STOP_MARKET` 是止盈 / 止损那类**条件单**（见 `placeStopOrder`） */
  type: 'MARKET' | 'LIMIT' | 'TAKE_PROFIT_MARKET' | 'STOP_MARKET'
  quantity: number
  price?: number
  /** 条件单的触发价（市价单 / 限价单不带） */
  stopPrice?: number
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
  target?: {
    symbol?: string
    side?: 'long' | 'short'
    /**
     * 只平掉这么多（百分比 0~100，用户 2026-10-05：「加个按钮减仓 弹窗选择百分比」）。
     * 不传 / ≥100 = 全平。⚠️ 按合约精度**向下取整**，取整后是 0 就报错，
     * 绝不「四舍五入」多平一点。
     */
    pct?: number
  },
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

  const pctRaw = Number(target?.pct)
  const partial = Number.isFinite(pctRaw) && pctRaw > 0 && pctRaw < 100
  if (partial && !(target?.symbol))
    throw new Error('减仓要指定交易对（一次只减一个仓位）')
  const ratio = partial ? pctRaw / 100 : 1

  const dual = await isDualSide(ex, keyId)
  const orders: CloseOrderParams[] = []

  for (const {row, pos} of live) {
    const symbol = String(row.symbol ?? '').toUpperCase()
    if (!symbol) continue
    const spec = await specFor(c, symbol)
    const quantity = floorToStep(pos.amount * ratio, spec.stepSize)
    if (!(quantity > 0)) {
      if (partial)
        throw new Error(
          `减仓 ${pctRaw}% 按合约精度取整之后是 0（这个仓位一共 ${pos.amount}，最小变动 ${spec.stepSize}），比例放大一点`
        )
      continue
    }
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

/* ---------------- 画在 K 线上的那两样（2026-10-06） ----------------
 *
 * 用户：「配置界面可以配置订单设置，1.仓位 2.订单历史 3.仓位委托 4.强平价格」
 * 「是控制和 k 线联动的价格或历史是否显示在 k 线上」——
 * 也就是币安合约图那套：开仓均价线 / 强平线 / 挂单线 / 成交点。
 * 这里只负责**取数**（前两个用 `listPositions` 就够），画图在前端的 `KlineChart`。
 */

/** 一张挂单（画成 K 线上的「仓位委托」那条价格线） */
export interface OpenOrderRow {
  id: string
  /** 币安原始符号（BTCUSDT） */
  symbol: string
  side: 'buy' | 'sell'
  /**
   * 币安原始订单类型（`LIMIT` / `STOP_MARKET` / `TAKE_PROFIT_MARKET` …）。
   *
   * ⚠️ 取 `info.type` 而不是 ccxt 那个 `type`：ccxt 会把它**归一**成
   *    `limit` / `market`，`STOP_MARKET` 和 `TAKE_PROFIT_MARKET` 到那儿就分不出来了
   *    （K 线上那条线要按这个标「止损 / 止盈」）。
   */
  type: string
  /** 币安原始持仓方向（`LONG` / `SHORT` / `BOTH`）——配仓位算「这个单平的是哪条」 */
  posSide: string
  /** 委托价（市价单没有，给 `null`） */
  price: number | null
  /** 触发价（止损 / 止盈那类条件单才有） */
  stopPrice: number | null
  /** 委托量（基础币） */
  amount: number
  /** 已成交（基础币） */
  filled: number
  /** 只减仓（平仓单）—— 界面上跟开仓单分个色可用 */
  reduceOnly: boolean
  /** 下单时间（毫秒） */
  time: number
}

/**
 * 当前挂单（某个交易对；不给 `symbol` 就是整个账户）。
 *
 * ⚠️ 市价单 / 条件单**没有委托价**，`price` 给 `null` —— 调用方别拿它当 0 画线
 *    （0 会被画到价格轴最底下）。
 */
export async function listOpenOrders(
  c: ExchangeCredentials,
  symbol?: string
): Promise<OpenOrderRow[]> {
  assertTradable(c)
  const ex = createExchange(c)
  /*
   * ⚠️ 币安把「条件单」（止盈 / 止损）搬到了 **Algo Order** 那套接口之后，
   *    `GET /fapi/v1/openOrders` **看不到它们**（实测：真挂了一张 STOP_MARKET，
   *    普通挂单列表回空数组）。ccxt 用 `params.conditional = true` 分流到
   *    `GET /fapi/v1/openAlgoOrders`，所以这里**两套都要拉、合起来**。
   *    条件单那一路失败（权限 / 接口没有）就当没有，别把普通挂单也带崩。
   */
  /*
   * ⚠️ **不带 symbol** 查全账户时，必须显式告诉 ccxt `subType: 'linear'`
   *    （2026-10-06 实测出来的坑）：没有 market 可以依的时候 ccxt 猜不出这是
   *    U 本位合约，`isLinear()` 判不出来 ⇒ 条件单那一路**悄悄走到别的分支**、
   *    回一个空数组 —— 看着像「账户里一条条件单都没有」，其实 4 张就挂在那儿
   *    （同一时刻带 symbol 查就查得到）。带上 symbol 时不用传（market 里自带）。
   */
  const sub = symbol ? {} : {subType: 'linear'}
  /*
   * ⚠️ 这两条**不能都吞成空数组**（2026-10-06 实测踩到）：本地经出口隧道时
   *    条件单那一路会**超时**，`.catch(() => [])` 把它变成「账户里一条条件单都没有」——
   *    跟真的没有**长得一模一样**，用户看到的就是「我挂的止盈止损不见了」。
   *    所以用 `allSettled` 把两边的成败都留着，两个都失败才抛
   *    （那才肯定是错，不是「真的没有」）。
   */
  const [normalRes, algoRes] = await Promise.allSettled([
    ex.fetchOpenOrders(symbol, undefined, undefined, {...sub}),
    ex.fetchOpenOrders(symbol, undefined, undefined, {conditional: true, ...sub})
  ])
  const normal: any[] = normalRes.status === 'fulfilled' ? (normalRes.value ?? []) : []
  const algo: any[] = algoRes.status === 'fulfilled' ? (algoRes.value ?? []) : []
  if (algoRes.status === 'rejected') {
    console.warn(
      `[exch] 条件单（止盈/止损）没取到：${humanizeTrade(algoRes.reason).slice(0, 120)}` +
        ' —— 挂单列表里可能少了这几张'
    )
  }
  if (normalRes.status === 'rejected' && algoRes.status === 'rejected') {
    throw new Error(
      `挂单没取到：${humanizeTrade(normalRes.reason).slice(0, 120)}` +
        `（条件单那一路也失败：${humanizeTrade(algoRes.reason).slice(0, 80)}）`
    )
  }
  const raw: any[] = [...((normal as any[]) ?? []), ...((algo as any[]) ?? [])]
  const out: OpenOrderRow[] = []
  for (const o of raw) {
    const id = String(o?.id ?? '')
    /* ⚠️ 用 `info.symbol`（币安原始 `1000BONKUSDT`）优先，ccxt 那个是统一写法
       `1000BONK/USDT:USDT` —— 前端要拿它跟合约表里的 symbol 对得上 */
    const sym = String(o?.info?.symbol ?? o?.symbol ?? symbol ?? '').toUpperCase()
    if (!id || !sym) continue
    out.push({
      id,
      symbol: sym,
      side: String(o?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy',
      /*
       * ⚠️ 条件单（algo）那个接口回的字段是 **`orderType`**（不是 `type`），
       *    而 ccxt 归一后的 `o.type` 会变成 `market` —— 两个都读不到「STOP_MARKET」
       *    的话，K 线上那张止盈 / 止损会被标成「委托」。实测踩过。
       */
      type: String(
        o?.info?.orderType ?? o?.info?.type ?? o?.type ?? ''
      ).toUpperCase(),
      posSide: String(o?.info?.positionSide ?? 'BOTH').toUpperCase(),
      price: nullish(o?.price),
      stopPrice: nullish(o?.stopPrice),
      amount: n(o?.amount),
      filled: n(o?.filled),
      reduceOnly: o?.reduceOnly === true || o?.info?.reduceOnly === true,
      time: n(o?.timestamp)
    })
  }
  /* 新的排前面（跟币安 App 的委托列表一致） */
  out.sort((a, b) => b.time - a.time)
  return out
}

/* ------------------------------------------------------------------ */
/* 交易所那本账（`/fapi/v1/income`，2026-10-06）                        */
/* ------------------------------------------------------------------ */

/** 一条收入记录（币安 `/fapi/v1/income` 的一行） */
export interface IncomeRecord {
  /**
   * **去重键**（不是币安那个 `tranId` 原值，见下面的注意）。
   *
   * ⚠️ 币安 `income` 的 `tranId` 跟成交号**不是一个东西**
   *    （实测：成交 `959680406` 对应的 `tranId` 是 `95850959680406`），
   *    所以**不能**拿它去跟 WS 事件里的 `t` 对齐 —— 一对不上就会
   *    同一笔钱记两遍（WS 一条、income 一条）。真正能对齐的是 `tradeId` 字段。
   */
  tranId: string
  incomeType: string
  symbol: string
  asset: string
  /** 正数进钱、负数出钱 */
  amount: number
  /** 毫秒 */
  ts: number
  tradeId: string
}

/**
 * 一条 income 的**去重键**：成交类用 `tradeId`（+ 资产），其它类用 `tranId`。
 *
 * ⚠️ 为什么必须算法统一：同一笔钱有**两条写入路**（WS/成交 REST 补 VS income 对账），
 *    两边只有算出**同一个键**才会撞在唯一键上。踩过的坑：按 `tranId` 去重 ⇒
 *    手续费 27 条变 54 条、已实现 -0.1510 变 -0.3020（正好两倍）。
 * ⚠️ 带上资产：同一笔的手续费理论上可能拆成两个币（BNB 抵扣），
 *    只按 `tradeId` 会丢掉一条。
 */
export function incomeDedupeKey(r: {
  tranId: string
  tradeId?: string
  asset: string
}): string {
  const tid = String(r.tradeId ?? '')
  const base = tid && tid !== '0' ? tid : r.tranId
  return `${base}:${r.asset || 'USDT'}`
}

/**
 * 拉交易所的**钱账本**（`GET /fapi/v1/income`）。
 *
 * 这是「统一口径」的关键一步 —— 用户原话「数据要统一用一套」「资金费又算吗」：
 * ```
 *   已实现盈亏 REALIZED_PNL  ┐
 *   手续费     COMMISSION    ├─ 三个加起来才是**净收益**
 *   资金费     FUNDING_FEE   ┘   （每 8 小时结一次，合约特有的成本）
 * ```
 * 只把成交里的 `realizedPnl` 加起来是**毛的**（实测 7 天：已实现 -0.151、
 * 手续费 -0.265、资金费 -0.004 —— 手续费比已实现还大）。
 *
 * ⚠️ **权重 30**（币安文档），比一般接口贵得多 ⇒ 别按分钟轮询，见
 *    `exchange-stream.ts` 的对账节奏（接上时一次 + 每小时一次）。
 * ⚠️ 不给 `incomeType` 就是**全类型**（省调用次数）。
 * ⚠️ 币安这个接口一次最多 1000 条、只能查最近 7 天（不给 startTime 时）。
 */
export async function fetchIncomeHistory(
  c: ExchangeCredentials,
  opts: {startTime: number; limit?: number}
): Promise<IncomeRecord[]> {
  assertTradable(c)
  const ex = createExchange(c)
  const call =
    typeof ex.fapiPrivateGetIncome === 'function'
      ? ex.fapiPrivateGetIncome
      : null
  if (!call) return []

  const limit = Math.min(1000, Math.max(1, opts.limit ?? 1000))
  const raw: any = await call.call(ex, {
    startTime: Math.round(opts.startTime),
    limit
  })
  const list: any[] = Array.isArray(raw) ? raw : []
  const out: IncomeRecord[] = []
  for (const r of list) {
    const ts = Number(r?.time)
    const amount = Number(r?.income)
    const type = String(r?.incomeType ?? '')
    if (!type || !Number.isFinite(ts) || !ts || !Number.isFinite(amount)) continue
    const tranId = String(r?.tranId ?? '')
    const asset = String(r?.asset ?? 'USDT')
    const tradeId = String(r?.tradeId ?? '')
    out.push({
      /*
       * ⚠️ 缺 `tranId` 时**必须自己造一个稳定的键**：不然 `ON CONFLICT` 挡不住
       *    重复，定期重扫同一个窗口就会把同一笔记好几遍。
       *    用「类型 + 时间 + 金额 + 币种」当兜底键（这些一样的基本就是同一笔）。
       */
      tranId: incomeDedupeKey({
        tranId: tranId || `${type}:${ts}:${amount}:${asset}`,
        tradeId,
        asset
      }),
      incomeType: type,
      symbol: String(r?.symbol ?? '').toUpperCase(),
      asset,
      amount,
      ts,
      tradeId
    })
  }
  /* 旧的排前面（写库顺序无所谓，但看着顺眼好排查） */
  out.sort((a, b) => a.ts - b.ts)
  return out
}

/* ------------------------------------------------------------------ */
/* 止盈 / 止损（拖 K 线上那条仓位线拖出来的，2026-10-06）              */
/* ------------------------------------------------------------------ */

export interface StopOrderInput {
  /** 币安原始符号 */
  symbol: string
  /** **平仓方向**：多单拖出来的是 `sell`、空单是 `buy` */
  side: 'buy' | 'sell'
  /** `profit` = 止盈（`TAKE_PROFIT_MARKET`）/ `stop` = 止损（`STOP_MARKET`） */
  kind: 'profit' | 'stop'
  /** 触发价（拖到哪就挂在哪） */
  stopPrice: number
  /** 平掉多少（基础币，按合约步长向下取整） */
  quantity: number
  /** 双向持仓模式下要告诉币安「这是哪条仓位的单」（`LONG` / `SHORT`） */
  posSide?: string
  /**
   * 有值 = **改单**：先把这一张撤了再挂新的。
   *
   * ⚠️ 币安没有「改触发价」的接口，它自己 App 里的「修改」也是**撤 + 重挂**。
   * ⚠️ **测试单模式下不撤单** —— 不然「只校验」就变成真把人家的单撤了，
   *    那是真金白银的动作，测试模式绝对不能干。
   */
  orderId?: string
  /** `true`（或不传）= 走测试接口只校验；`false` = 真挂上去 */
  test?: boolean
}

/** 挂出去的条件单（`PlacedOrder` + 改单撤掉的旧单号 + 测试单的说明） */
export interface PlacedStopOrder extends PlacedOrder {
  /** 改单时撤掉的旧单号（测试单模式 / 没改单时没有） */
  canceled?: string
  /** 测试单模式下说明「哪一部分币安没给测」（条件单没有 test 接口） */
  note?: string
}

/**
 * 挂一张**止盈 / 止损**单。
 *
 * 用户 2026-10-06：「按住仓位线上下拖 → 松手弹确认单（止盈 / 止损 + 数量百分比），
 * 确认后才发单」。类型只用 `TAKE_PROFIT_MARKET` / `STOP_MARKET`（触发后走市价）：
 * 拖出来的是**一个价格**（触发价），没有第二个价能给限价单用。
 *
 * 减仓那两件事跟 `placeOrder` 同一套规矩：
 *   · 双向持仓模式 → 带 `positionSide`（**不能**带 `reduceOnly`，币安会回 -1106）
 *   · 单向持仓模式 → 带 `reduceOnly: true`
 */
export async function placeStopOrder(
  c: ExchangeCredentials,
  keyId: number | string,
  input: StopOrderInput
): Promise<PlacedStopOrder> {
  assertTradable(c)
  const rawPrice = Number(input.stopPrice)
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) throw new Error('触发价不对')
  const rawQty = Number(input.quantity)
  if (!Number.isFinite(rawQty) || rawQty <= 0) throw new Error('数量要先填好')

  const ex = createExchange(c)
  const spec = await specFor(c, input.symbol)
  const symbol = spec.symbol

  /* 触发价按 tick 收一下（拖出来的可能是任意小数） */
  const stopPrice = floorToStep(rawPrice, spec.tickSize)
  if (stopPrice <= 0) throw new Error('触发价太小了')
  const quantity = floorToStep(rawQty, spec.stepSize)
  if (quantity <= 0) throw new Error('数量太小：按这个合约的精度取整之后是 0')
  if (spec.minQty && quantity < spec.minQty)
    throw new Error(`数量太小：这个合约最少要下 ${spec.minQty} ${spec.base}`)

  const dual = await isDualSide(ex, keyId)
  const type = input.kind === 'profit' ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET'
  const test = input.test !== false

  /*
   * ⚠️⚠️ 条件单**不能**发到 `/fapi/v1/order`（无论 test 还是真单）：
   *   币安回 `-4120 Order type not supported for this endpoint.
   *   Please use the Algo Order API endpoints instead.`
   *   ⇒ 它们现在走 `/fapi/v1/algoOrder`（`algoType=CONDITIONAL`），
   *     ccxt 4.5 已经替我们分好路了：`createOrder(..., {stopLossPrice / takeProfitPrice})`
   *     会自动带上 `triggerPrice` + `algoType` 打到 algo 那个口子上。
   *
   * ⚠️ 而 algo 那个口子**没有 test 版本**（ccxt 的分支里 `test` 参数被直接忽略）——
   *    也就是说「测试单」在这儿**没法让币安把整张条件单校验一遍**。
   *    为了绝不在测试模式下真挂单，测试模式改成：
   *      ① 本地把数量 / 触发价的精度先收一遍
   *      ② 拿同样的数量 / 方向发一张 **MARKET reduceOnly 测试单** ——
   *         币安会照常校验签名 / 权限 / 数量 / 持仓方向 / 保证金，
   *         只是「触发价」那部分交易所不给测（这一点会在返回的 `note` 里说明）
   */
  if (test) {
    const probe: OrderParams = {
      symbol,
      side: input.side === 'buy' ? 'BUY' : 'SELL',
      type: 'MARKET',
      quantity,
      ...(dual
        ? {positionSide: (input.posSide === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT'}
        : {reduceOnly: true})
    }
    const placed = await submitOrder(ex, probe, true)
    return {
      ...probe,
      symbol,
      stopPrice,
      test: true,
      type,
      ...placed,
      note:
        '测试单：币安校验了数量 / 方向 / 权限 / 保证金；' +
        '条件单的「触发价」交易所没有测试接口，所以这张单**没有真挂上去**'
    }
  }

  let canceled: string | undefined
  if (input.orderId) {
    await cancelAnyOrder(ex, symbol, input.orderId)
    canceled = input.orderId
  }

  const params: Record<string, unknown> = {
    ...(input.kind === 'profit'
      ? {takeProfitPrice: stopPrice}
      : {stopLossPrice: stopPrice}),
    ...(dual
      ? {positionSide: input.posSide === 'SHORT' ? 'SHORT' : 'LONG'}
      : {reduceOnly: true})
  }
  const r: any = await ex.createOrder(
    symbol,
    'market',
    input.side === 'buy' ? 'buy' : 'sell',
    quantity,
    undefined,
    params
  )
  return {
    symbol,
    side: input.side === 'buy' ? 'BUY' : 'SELL',
    type,
    quantity,
    stopPrice,
    ...(dual
      ? {positionSide: input.posSide === 'SHORT' ? 'SHORT' : 'LONG'}
      : {reduceOnly: true}),
    test: false,
    orderId: r?.id === undefined ? undefined : String(r.id),
    status: r?.status === undefined ? undefined : String(r.status),
    canceled
  }
}

/**
 * 撤一张挂单（用户 2026-10-06：「挂单…可拖动改」配套）。
 *
 * 改单（`placeStopOrder` 带 `orderId`）内部就用它；单独暴露出来是因为
 * 拖出来的那些止盈 / 止损单**总得有个地方撤** —— 不然用户只能跑去币安 App 撤。
 *
 * ⚠️ 撤单是**真动作**，没有测试版：撤了就是撤了。所以前端要它之前先确认一下。
 */
export async function cancelTradeOrder(
  c: ExchangeCredentials,
  symbol: string,
  orderId: string
): Promise<{orderId: string; symbol: string}> {
  assertTradable(c)
  if (!orderId) throw new Error('缺单号')
  const ex = createExchange(c)
  const spec = await specFor(c, symbol)
  await cancelAnyOrder(ex, spec.symbol, orderId)
  return {orderId, symbol: spec.symbol}
}

/**
 * 撤一张单 —— **普通单和条件单在币安是两套接口**（见 `listOpenOrders` 那段说明）。
 *
 * 先按普通单撤；撤不到（回「未知订单」那类）再按条件单（`conditional: true`
 * → `DELETE /fapi/v1/algoOrder`）撤。两条都不行就把**第一条**的错抛出去
 * （通常那个信息更有用：「未知订单」说明单号不对，而不是「不支持」）。
 */
async function cancelAnyOrder(
  ex: any,
  symbol: string,
  orderId: string
): Promise<void> {
  try {
    await ex.cancelOrder(orderId, symbol)
    return
  } catch (e) {
    try {
      await ex.cancelOrder(orderId, symbol, {conditional: true})
    } catch {
      throw e
    }
  }
}

/** `cancelOrphanOrders` 的结果（界面上就一行提示，所以给的都是能直接看的数） */
export interface OrphanCleanupResult {
  /** 账户里现在有几条持仓 */
  positions: number
  /** 看了几张平仓单（`reduceOnly`） */
  checked: number
  /** 真撤掉的 */
  cancelled: {symbol: string; orderId: string; amount: number}[]
  /** 撤失败的（单独报，不连累别的） */
  failed: {symbol: string; orderId: string; error: string}[]
}

/**
 * 撤掉「这条仓位已经没了，单却还挂着」的残留平仓单。
 *
 * 用户 2026-10-06：「没有仓位所有挂单都应该取消才对，为什么还显示在图上」。
 * 实测币安**不会**替我们撤：1000FLOKI 的仓位已经 0 张，三张 STOP / TAKE_PROFIT
 * （各 380 张、`reduceOnly`）照样挂着，那它们就会一直画在 K 线上，触发时也只会
 * 变成一张废单。所以这里主动清掉。
 *
 * ⚠️ **只碰 `reduceOnly` 的单**：挂着的**开仓**限价单（等着进场的）没有仓位是正常的，
 *    顺手撤了才是事故。
 * ⚠️ 持仓读不到（接口失败 / 没权限）时**直接抛错、什么都不做** —— 那种「读不到」
 *    一旦被当成「没仓位」，就是清仓级别的误伤。
 *
 * `symbol` 给了就只看这个交易对（前端每 15 秒刷 K 线数据时顺手清当前这个币）；
 * 不给就是整个合约账户（每分钟的那次大盘点）。
 */
export async function cancelOrphanOrders(
  c: ExchangeCredentials,
  symbol?: string
): Promise<OrphanCleanupResult> {
  assertTradable(c)
  const ex = createExchange(c)
  /* ⚠️ 顺序不能换：先确认拿到持仓（失败就抛），再去读挂单 */
  const positions = await listPositions(c)
  const orders = await listOpenOrders(c, symbol)
  const want = symbol ? String(symbol).toUpperCase() : ''

  /** 「这条单平的是哪条持仓」：双向模式听币安的，单向模式按方向反推（卖出平多） */
  const closes = (o: OpenOrderRow): 'long' | 'short' =>
    o.posSide === 'LONG' ? 'long' : o.posSide === 'SHORT' ? 'short' : o.side === 'sell' ? 'long' : 'short'
  const live = new Set(positions.map(p => `${p.symbol}|${p.side}`))

  const out: OrphanCleanupResult = {
    positions: positions.length,
    checked: 0,
    cancelled: [],
    failed: []
  }
  for (const o of orders) {
    if (!o.reduceOnly) continue
    if (want && o.symbol !== want) continue
    out.checked++
    if (live.has(`${o.symbol}|${closes(o)}`)) continue
    try {
      await cancelAnyOrder(ex, o.symbol, o.id)
      out.cancelled.push({symbol: o.symbol, orderId: o.id, amount: o.amount})
    } catch (e) {
      out.failed.push({symbol: o.symbol, orderId: o.id, error: humanize(e)})
    }
  }
  return out
}
