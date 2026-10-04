/**
 * 「交易所资产」取数（2026-10-05 新增，方案见 `docs/EXCHANGE.md`）。
 *
 * 范围（用户定）：**只统计两个钱包，现货不参与**
 *   · USDT 合约（USDⓈ-M）—— `GET /fapi/v2/account`（余额 + 多资产明细）+ `fetchPositions()`
 *   · C2C 钱包 —— `GET /sapi/v1/asset/wallet/balance?needBalanceDetail=true`
 *
 * ⚠️ 实测踩到的三个坑（别再踩）：
 *   ① 接口里 **C2C 钱包的 `walletName` 实际叫 `Funding`** —— 返回的 10 个钱包
 *      （Spot / Funding / Cross Margin / … / Copy Trading）里**没有 "C2C"**，
 *      按名字找 C2C 会静默拿不到数据。
 *   ② `/fapi/v2/account` 的 `positions[]` **没有 `markPrice` / 强平价**（有 `notional`），
 *      所以持仓改走 ccxt 的 `fetchPositions()` → `/fapi/v2/positionRisk`。
 *   ③ `positions[]` 会返回**全部 920 个槽位**（绝大多数 `positionAmt = 0`），必须过滤。
 *
 * 一次调用打 3 个请求（account / positionRisk / sapi wallet），**共用一个 exchange 实例**
 * —— 不要每块各 createExchange 一遍，那样每次都要 loadMarkets（一两秒）。
 *
 * TODO(M3)：`exchange-account.ts` 里 `fetchExchangeBalance` 那段「稳定币 1:1 + 一次
 * fetchTickers 找 X/USDT」的估值逻辑跟下面 `valueInUsdt` 是同一套；等老面板删掉
 * （M5）之后两处合并成一个 helper。
 */
import {
  STABLES,
  createExchange,
  mapPosition,
  type ExchangeCredentials,
  type PositionRow
} from './exchange-account'

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
 * （宁可少算，不能给错数 —— 跟 `fetchExchangeBalance` 一个原则）。
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
 * C2C 钱包（币安里叫 **Funding**，见文件头 ①）。
 * 不是币安 / ccxt 没有 sapi 方法 ⇒ 返回 null（界面显示「这个账户没有 C2C 钱包」）。
 */
async function fetchC2c(ex: any): Promise<ExchangeOverview['c2c']> {
  if (typeof ex.sapiGetAssetWalletBalance !== 'function') return null
  const raw: any = await ex.sapiGetAssetWalletBalance({needBalanceDetail: true})
  const list: any[] = Array.isArray(raw) ? raw : (raw?.wallets ?? [])
  // ⚠️ 按 Funding 认，不是按 "C2C" 认
  const w = list.find(x => /^funding$/i.test(String(x?.walletName ?? '')))
  if (!w) return null

  const balances = (Array.isArray(w.assetBalances) ? w.assetBalances : [])
    .map((b: any) => ({currency: String(b?.asset ?? ''), amount: n(b?.balance)}))
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
 * 一次取全：合约账户（余额 + 多资产）+ 持仓 + C2C。
 *
 * ⚠️ 只支持**合约**（`marketType=swap`）：现货账户不参与统计，直接抛错让调用方提示用户
 * （别硬算成 0 —— 那会让人以为账户真的没钱）。
 */
export async function fetchExchangeOverview(
  c: ExchangeCredentials
): Promise<ExchangeOverview> {
  if (c.marketType !== 'swap') {
    throw new Error('这套账户不是合约账户（现货不参与统计）')
  }
  const ex = createExchange(c)
  await ex.loadMarkets()

  const accFn = ex.fapiPrivateV2GetAccount ?? ex.fapiPrivateGetAccount
  if (typeof accFn !== 'function') {
    throw new Error(`「${c.exchange}」不支持币安的合约账户接口（暂只接了币安）`)
  }

  // ---- 合约账户 ----
  const acc: any = await accFn.call(ex)
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

  // ---- 持仓（走 positionRisk，见文件头 ②）----
  const rawPos: any[] = (await ex.fetchPositions()) ?? []
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

  // ---- C2C（Funding）----
  let c2c: ExchangeOverview['c2c'] = null
  try {
    c2c = await fetchC2c(ex)
  } catch {
    // C2C 拿不到不该拖垮整个页面：合约那边的数字照样显示
    c2c = null
  }

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
    stats: {
      longCount,
      shortCount: positions.length - longCount,
      notional: r8(positions.reduce((s, p) => s + p.notional, 0)),
      unrealized: r8(positions.reduce((s, p) => s + p.unrealizedPnl, 0))
    }
  }
}
