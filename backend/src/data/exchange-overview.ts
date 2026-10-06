/**
 * 「交易所资产」取数（2026-10-05 新增，方案见 `docs/EXCHANGE.md`）。
 *
 * 范围（用户定）：**合约 + C2C（资金）+ 现货 USDT**
 *   · USDT 合约（USDⓈ-M）—— `GET /fapi/v2/account`（余额 + 多资产明细）+ `fetchPositions()`
 *   · C2C 钱包 —— `GET /sapi/v1/asset/wallet/balance?needBalanceDetail=true`
 *   · 现货 —— `GET /api/v3/account`，**只取 USDT**（用户 2026-10-05：
 *     「现货统计也加上，只要 usdt 的统计简单化」）。别的币不折价 —— 全资产估值
 *     那套东西当年就是因为不好维护才整块删掉的，别再加回来。
 *
 * ⚠️⚠️ 实测踩到的四个坑（别再踩）：
 *   ① **C2C 钱包的名字各账号不一样**：文档写 `walletName` 返回 `"C2C"`，实际这台
 *      账号返回的是 **`"Funding"`**（10 个钱包：Spot / Funding / Cross Margin / …
 *      / Copy Trading）。**两个名字都得认**（`/^(c2c|funding)$/i`），只写一个
 *      就会静默拿不到数据（不报错，数字直接是 0）。
 *   ②⚠️ **`assetBalances[]` 里没有 `balance` 字段！** 每个币种的钱分散在
 *      `free` / `locked` / `freeze` / `withdrawing` 四个**字符串**字段里
 *      （还有 `assetName` / `btcValuation`）。读 `b.balance` 恒等于 0 →
 *      再被「零余额过滤」一扫就什么都不剩了（2026-10-05 真丢过用户 9.92 USDT）。
 *      ⇒ 金额 = free + locked + freeze + withdrawing。
 *      ⚠️ 另外注意钱包**层级**那个 `balance` 是 **BTC 估值**，不是 USDT。
 *   ③ `/fapi/v2/account` 的 `positions[]` **没有 `markPrice` / 强平价**（有 `notional`），
 *      所以持仓改走 ccxt 的 `fetchPositions()` → `/fapi/v2/positionRisk`。
 *   ④ `positions[]` 会返回**全部 920 个槽位**（绝大多数 `positionAmt = 0`），必须过滤。
 *
 * 一次调用打 3 个请求（account / positionRisk / sapi wallet），**共用一个 exchange 实例**
 * —— 不要每块各 createExchange 一遍，那样每次都要 loadMarkets（一两秒）。
 *
 * ★ M5（2026-10-05）：老接口 `/api/exchange/account` 连同它那套「余额估值」已经删了，
 *   现在**全仓库只有下面 `valueInUsdt` 一套估值逻辑**（稳定币 1:1 + 找 X/USDT 报价）。
 */
import {
  STABLES,
  createExchange,
  mapPosition,
  type ExchangeCredentials,
  type PositionRow
} from './exchange-account'
import {takeWeight} from '../util/rate-budget'

/** 合约账户里的多资产明细（`fapi/v2/account.assets[]`） */
export interface FuturesAsset {
  asset: string
  /** walletBalance */
  wallet: number
  /** availableBalance */
  available: number
  /** unrealizedProfit */
  unrealized: number
}

/**
 * 一个仓位。
 * ⚠️ 字段名跟前端 `comps/exchangeMock.ts` 里那份是**对齐**的（`amount` = ccxt 的
 * `contracts`），这样前端换真数据时不用改模板。
 */
export interface FuturesPosition {
  symbol: string
  /** long / short */
  side: string
  amount: number
  notional: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number | null
  leverage: number
  unrealizedPnl: number
  /** ROE %（相对保证金） */
  percentage: number | null
}

/**
 * 现货钱包 —— **只关心 USDT**（用户 2026-10-05：「只要 usdt 的统计简单化」）。
 *
 * ⚠️ 就一个数：其他币种一概不折价、不进净值。要看「可用 / 挂单锁定」去划转那个
 * 弹层（它单独读一次实时余额），快照里不留那么多字段。
 */
export interface SpotWallet {
  /** 现货钱包里的 USDT（可用 + 挂单锁定） */
  usdt: number
}

/** 取数结果 = 将来要写进 `exchange_snapshots` 的那一份 */
export interface ExchangeOverview {
  /** 这套 key 的展示信息（脱敏，不含凭据） */
  account: {exchange: string; name: string; sandbox: boolean; marketType: string}
  /** 采集时间（ISO）—— 前端拿它算「几分钟前」 */
  takenAt: string
  futures: {
    /** totalWalletBalance：钱包余额（不含浮盈） */
    wallet: number
    /** totalUnrealizedProfit */
    unrealized: number
    /** totalMarginBalance：保证金余额 = 钱包 + 浮盈（净资产里的合约那半） */
    margin: number
    /** availableBalance */
    available: number
    /** 占用 = margin − available（接口没直接给，推导） */
    used: number
    assets: FuturesAsset[]
    positions: FuturesPosition[]
  }
  /** C2C 钱包；没接通/不是币安就是 null */
  c2c: {
    active: boolean
    totalUsdt: number
    assets: {asset: string; balance: number; usdt: number | null}[]
  } | null
  /**
   * 现货钱包里的 **USDT**；读不到（没权限 / 不是币安）就是 null。
   * ⚠️ 只有 USDT 一个数：别的币不折价，`totalUsdt` 也不等于「现货总资产」。
   */
  spot: SpotWallet | null
  /** 仓位统计（就在这儿算好，省得前端重复算） */
  stats: {
    longCount: number
    shortCount: number
    notional: number
    unrealized: number
  }
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
/** 金额统一留 8 位小数（跟 NUMERIC(24,8) 对齐，免得浮点尾巴乱飞） */
function r8(x: number): number {
  return Math.round(x * 1e8) / 1e8
}

/**
 * 批量折 USDT：稳定币按 1 算，其余在**已加载的市场**里找 `X/USDT[:USDT]`，
 * 用**一次** `fetchTickers()` 把价格批量取回来；查不到就给 `null`
 * （宁可少算，不能给错数 —— 这是这个模块的原则）。
 */
async function valueInUsdt(
  ex: any,
  rows: {currency: string; amount: number}[]
): Promise<{usdt: (number | null)[]; total: number; partial: boolean}> {
  const usdt: (number | null)[] = rows.map(() => null)
  let total = 0
  let partial = false

  const need = rows.filter(
    (r, i) => r.amount > 0 && !STABLES.has(r.currency) && rows[i]
  )
  let tickers: Record<string, any> = {}
  if (need.length) {
    try {
      tickers = (await ex.fetchTickers()) ?? {}
    } catch {
      tickers = {}
    }
  }
  const keys: string[] = Object.keys(ex.markets ?? {})
  const findUsdtSymbol = (cur: string): string | null => {
    for (const w of [`${cur}/USDT:USDT`, `${cur}/USDT`]) {
      if (ex.markets?.[w] && tickers[w]) return w
    }
    return (
      keys.find(
        k => k.startsWith(`${cur}/`) && /USDT(:USDT)?$/.test(k) && tickers[k]
      ) ?? null
    )
  }

  rows.forEach((row, i) => {
    const amt = n(row.amount)
    if (amt === 0) {
      usdt[i] = 0
      return
    }
    if (STABLES.has(row.currency)) {
      usdt[i] = amt
      total += amt
      return
    }
    const sym = findUsdtSymbol(row.currency)
    const price = sym ? n(tickers[sym]?.last ?? tickers[sym]?.close) : 0
    if (price > 0) {
      usdt[i] = amt * price
      total += usdt[i] as number
    } else {
      partial = true
    }
  })

  return {usdt, total, partial}
}

/**
 * 一个 `assetBalances[]` 条目里**到底有多少钱**。
 *
 * ⚠️ 这里没有 `balance` 这个字段（踩过：读它恒为 0，用户的 9.92 USDT 直接不见了）。
 *    币安把金额拆成四个**字符串**字段：可用 / 挂单锁定 / 冻结 / 提现中，
 *    加起来才是这个币的真实持仓。
 */
function assetAmount(b: any): number {
  const sum = n(b?.free) + n(b?.locked) + n(b?.freeze) + n(b?.withdrawing)
  // 兼容别的交易所 / 以后币安改版：上面四个都拿不到时才看 balance
  return sum !== 0 ? sum : n(b?.balance)
}

/**
 * C2C 钱包。
 *
 * ⚠️ 名字要认两个：文档写 `"C2C"`，实测有账号返回 `"Funding"`（见文件头 ①）。
 * 不是币安 / ccxt 没有 sapi 方法 ⇒ 返回 null（界面显示「这个账户没有 C2C 钱包」）。
 */
async function fetchC2c(ex: any): Promise<ExchangeOverview['c2c']> {
  if (typeof ex.sapiGetAssetWalletBalance !== 'function') return null
  const raw: any = await ex.sapiGetAssetWalletBalance({needBalanceDetail: true})
  const list: any[] = Array.isArray(raw) ? raw : (raw?.wallets ?? [])
  const w = list.find(x => /^(c2c|funding)$/i.test(String(x?.walletName ?? '').trim()))
  if (!w) return null

  const balances = (Array.isArray(w.assetBalances) ? w.assetBalances : [])
    .map((b: any) => ({currency: String(b?.asset ?? ''), amount: assetAmount(b)}))
    .filter((b: any) => b.currency && b.amount !== 0)
    .sort((a: any, b: any) => b.amount - a.amount)

  const {usdt, total} = await valueInUsdt(ex, balances)
  return {
    active: Boolean(w.activate),
    totalUsdt: r8(total),
    assets: balances.map((b: any, i: number) => ({
      asset: b.currency,
      balance: b.amount,
      usdt: usdt[i] === null ? null : r8(usdt[i] as number)
    }))
  }
}

/**
 * 现货钱包里的 **USDT**。
 *
 * ⚠️ 走 `GET /api/v3/account`（ccxt `privateGetAccount`），**只挑 USDT 那一行**：
 *    `balances[]` 里其余币种一概不算 —— 见文件头那句「简单化」。
 *    `free` / `locked` 是**字符串**，直接 `Number()` 就对了（跟 C2C 那边不同，
 *    那边连 `balance` 字段都没有，见文件头 ②）。
 *
 * 读不到（不是币安 / 没读权限）⇒ 返回 null，界面那一块直接不显示，**不报错**：
 * 现货属于「顺带统计」，缺了不该拖垮整个页面。
 */
async function fetchSpot(ex: any): Promise<SpotWallet | null> {
  if (typeof ex.privateGetAccount !== 'function') return null
  const acc: any = await ex.privateGetAccount()
  const b = (Array.isArray(acc?.balances) ? acc.balances : []).find(
    (x: any) => String(x?.asset ?? '').toUpperCase() === 'USDT'
  )
  /* `free` / `locked` 是**字符串**，直接 Number() 就对了 */
  return {usdt: r8(n(b?.free) + n(b?.locked))}
}

/**
 * 一次取全：合约账户（余额 + 多资产）+ 持仓 + C2C + 现货 USDT。
 *
 * ⚠️ 只支持**合约**（`marketType=swap`）：账户类型本身还是要求合约
 * （合约那半边是主体），现货只是「顺带统计一个 USDT」。
 */
export async function fetchExchangeOverview(
  c: ExchangeCredentials
): Promise<ExchangeOverview> {
  if (c.marketType !== 'swap') {
    throw new Error('这套账户不是合约账户（这一页的主体是合约）')
  }
  /*
   * 一次 = 4 个请求，权重按币安文档估：
   *   /fapi/v2/account          5
   *   /fapi/v2/positionRisk     5
   *   /sapi/asset/wallet/balance ~1
   *   /api/v3/account（现货）    10   ← 这个最容易被漏掉
   * 合计 ≈ 21，**往上记到 25** 留余量（宁可少放行，也别把出口 IP 打封）。
   * ⚠️ 冷实例还会先 loadMarkets（1.5MB exchangeInfo），那个不按权重算，
   *    靠实例缓存（30 分钟）挡掉。
   */
  await takeWeight(25, 'overview')
  const ex = createExchange(c)
  await ex.loadMarkets()

  const accFn = ex.fapiPrivateV2GetAccount ?? ex.fapiPrivateGetAccount
  if (typeof accFn !== 'function') {
    throw new Error(`「${c.exchange}」不支持币安的合约账户接口（暂只接了币安）`)
  }

  /*
   * ★ 2026-10-06：**四路并发**（用户：「刷新图标为什么转那么久」）。
   *
   * 原来是 account → positionRisk → C2C → 现货 **一路 await 下来**，经出口隧道
   * 一个来回 0.1~0.7 秒，实测串行 ≈1.8 秒、并发 364ms（`/tmp` 探针量过每一路）：
   *
   * | 单步 | 耗时 |
   * |---|---|
   * | `/fapi/v2/account` | 135ms |
   * | `positionRisk` | 459ms |
   * | C2C `wallet/balance` | 166ms |
   * | C2C 估值 `fetchTickers` | 308ms |
   * | 现货 `/api/v3/account` | **710ms** |
   *
   * 这四路之间**没有任何依赖**（都只吃 `ex`）⇒ 并发出去总耗时 = 最慢的那一路。
   * ⚠️ 两处口径**故意保持原样**：
   *   · `positionRisk`（`fetchPositions`）失败**仍然让整次刷新失败** —— 不能悄悄
   *     当成「没有持仓」，那会让界面显示成空仓；
   *   · C2C / 现货 读不到只当 `null`（**不拖垮整页**，跟改之前一样）。
   */
  const [accRaw, rawPosRaw, c2cRes, spotRes] = await Promise.all([
    accFn.call(ex),
    ex.fetchPositions(),
    fetchC2c(ex).then(
      v => ({ok: true as const, v}),
      () => ({ok: false as const, v: null})
    ),
    fetchSpot(ex).then(
      v => ({ok: true as const, v}),
      () => ({ok: false as const, v: null})
    )
  ])
  const acc: any = accRaw
  const c2c = c2cRes.ok ? c2cRes.v : null
  const spot = spotRes.ok ? spotRes.v : null

  // ---- 合约账户 ----
  const wallet = n(acc?.totalWalletBalance)
  const unrealized = n(acc?.totalUnrealizedProfit)
  const margin = n(acc?.totalMarginBalance)
  const available = n(acc?.availableBalance)
  const assets: FuturesAsset[] = (Array.isArray(acc?.assets) ? acc.assets : [])
    .map((a: any) => ({
      asset: String(a?.asset ?? ''),
      wallet: n(a?.walletBalance),
      available: n(a?.availableBalance),
      unrealized: n(a?.unrealizedProfit)
    }))
    // 零余额的行（普通账户里就只有一行 USDT）没必要留着
    .filter((a: FuturesAsset) => a.asset && (a.wallet !== 0 || a.available !== 0))

  // ---- 持仓（走 positionRisk，见文件头 ②；**跟上面三路并发**）----
  const rawPos: any[] = rawPosRaw ?? []
  const positions: FuturesPosition[] = rawPos
    .map(mapPosition)
    .filter((p: PositionRow) => p.contracts !== 0 || p.notional !== 0)
    .map((p: PositionRow) => ({
      symbol: p.symbol,
      side: p.side,
      amount: p.contracts,
      notional: p.notional,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      liquidationPrice: p.liquidationPrice,
      leverage: p.leverage,
      unrealizedPnl: p.unrealizedPnl,
      percentage: p.percentage
    }))
    .sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional))

  /* C2C / 现货 已经在上面那四路并发里取回来了（失败当 null，不拖垮整页） */

  const longCount = positions.filter(p => p.side !== 'short').length
  return {
    account: {
      exchange: c.exchange,
      name: '',
      sandbox: c.sandbox,
      marketType: c.marketType
    },
    takenAt: new Date().toISOString(),
    futures: {
      wallet: r8(wallet),
      unrealized: r8(unrealized),
      margin: r8(margin),
      available: r8(available),
      used: r8(Math.max(margin - available, 0)),
      assets,
      positions
    },
    c2c,
    spot,
    stats: {
      longCount,
      shortCount: positions.length - longCount,
      notional: r8(positions.reduce((s, p) => s + p.notional, 0)),
      unrealized: r8(positions.reduce((s, p) => s + p.unrealizedPnl, 0))
    }
  }
}
