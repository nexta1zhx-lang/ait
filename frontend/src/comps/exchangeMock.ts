/**
 * 「交易所资产」新版界面的**模拟数据 + 拟定数据结构**（用户 2026-10-05）。
 *
 * 范围变了（用户原话）：「**只统计这两个维度的钱，不算现货**」
 *   · USDT 合约（USDⓈ-M）—— `GET /fapi/v2/account`（含 `assets[]` + `positions[]`）
 *     + `GET /fapi/v2/balance`
 *   · C2C 钱包 —— `GET /sapi/v1/asset/wallet/balance?needBalanceDetail=true`
 *   ⇒ **现货（Spot 钱包）不参与统计**，老版那套「按币种估值的现货余额列表」不要了。
 *
 * ⚠️ `ExchangeOverview` 这个类型是**拟定**的接口形状（用来先摆界面）：
 *    定稿之后挪进 `frontend/src/api.ts`，跟后端 `/api/exchange/overview` 对齐。
 *    字段名尽量贴币安原文（`totalWalletBalance` → `wallet` 这种只是去掉前缀），
 *    以后对不上时好查。
 */

/** 合约账户里的**多资产**明细（`fapi/v2/account.assets[]`） */
export interface FuturesAsset {
  asset: string
  /** walletBalance */
  wallet: number
  /** availableBalance */
  available: number
  /** unrealizedProfit */
  unrealized: number
}

/** 一个仓位（`fapi/v2/account.positions[]` 里 `positionAmt != 0` 的那些） */
export interface FuturesPosition {
  symbol: string
  /** long / short（币安 `positionSide` 是 LONG/SHORT/BOTH，这里统一成小写） */
  side: string
  /** positionAmt 的绝对值 */
  amount: number
  /** 名义价值 = |positionAmt| × markPrice */
  notional: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number | null
  leverage: number
  unrealizedPnl: number
  /** ROE %（交易所给的，或 未实现盈亏 / 起始保证金） */
  percentage: number | null
}

/** 一条快照 —— **落库的那一份**（见 `/memories/repo/exchange-module.md` 的架构说明） */
export interface ExchangeOverview {
  apiKeyId: number
  /** 这套 Key 的展示信息（脱敏后，前端要显示「币安 · 主号」） */
  account: {exchange: string; name: string; sandbox: boolean; marketType: string}
  /** 快照时间（ISO）—— 前端拿它算「几分钟前」，**先渲染这一份再后台刷新** */
  takenAt: string

  /** USDT 合约（`fapi/v2/account` + `/fapi/v2/balance`） */
  futures: {
    /** totalWalletBalance：钱包余额（不含浮盈） */
    wallet: number
    /** totalUnrealizedProfit：未实现盈亏 */
    unrealized: number
    /** totalMarginBalance：保证金余额 = 钱包 + 浮盈 ⇒ 界面上那个大数 */
    margin: number
    /** availableBalance：可用 */
    available: number
    /** 占用 = margin − available（推导值，接口没直接给） */
    used: number
    assets: FuturesAsset[]
    positions: FuturesPosition[]
  }

  /** C2C 钱包（`sapi/v1/asset/wallet/balance`）—— 没接通的账户给 null */
  c2c: {
    active: boolean
    /** 折 USDT 合计（USDT 按 1，其它币查价折算） */
    totalUsdt: number
    /** `assetBalances`（needBalanceDetail=true 才有） */
    assets: {asset: string; balance: number; usdt: number | null}[]
  } | null

  /** 仓位统计（从 positions 推，后端算好省得前端重复算） */
  stats: {
    longCount: number
    shortCount: number
    /** 所有仓位的名义价值之和 */
    notional: number
    /** 未实现盈亏之和 */
    unrealized: number
  }
}

/* ---------------- 造数据 ---------------- */

function pos(
  symbol: string,
  side: 'long' | 'short',
  amount: number,
  entryPrice: number,
  markPrice: number,
  leverage: number,
  liquidationPrice: number | null
): FuturesPosition {
  const notional = Math.round(Math.abs(amount) * markPrice * 100) / 100
  const margin = notional / leverage
  const pnl =
    (side === 'long' ? markPrice - entryPrice : entryPrice - markPrice) *
    Math.abs(amount)
  const unrealizedPnl = Math.round(pnl * 100) / 100
  return {
    symbol,
    side,
    amount: Math.abs(amount),
    notional,
    entryPrice,
    markPrice,
    liquidationPrice,
    leverage,
    unrealizedPnl,
    percentage: margin > 0 ? Math.round((unrealizedPnl / margin) * 10000) / 100 : null
  }
}

function statsOf(ps: FuturesPosition[]): ExchangeOverview['stats'] {
  return {
    longCount: ps.filter(p => p.side !== 'short').length,
    shortCount: ps.filter(p => p.side === 'short').length,
    notional: Math.round(ps.reduce((s, p) => s + p.notional, 0) * 100) / 100,
    unrealized: Math.round(ps.reduce((s, p) => s + p.unrealizedPnl, 0) * 100) / 100
  }
}

const POSITIONS: FuturesPosition[] = [
  pos('BTCUSDT', 'long', 0.5, 84120.3, 85300.1, 20, 76504.2),
  pos('ETHUSDT', 'short', 6, 2750.5, 2701.05, 10, 2993.2)
]

/** 合约 + C2C 都有的「正常账户」 */
export const MOCK_FULL: ExchangeOverview = {
  apiKeyId: 1,
  account: {exchange: 'binance', name: '币安 · 主号', sandbox: false, marketType: 'swap'},
  takenAt: '2026-10-05T10:42:07.000Z',
  futures: {
    wallet: 30228.74,
    unrealized: 886.6,
    margin: 31115.34,
    available: 9672.43,
    used: 21442.91,
    // ⚠️ U 本位合约账户正常情况下 `assets` 就一行 USDT（多资产保证金模式才会多）
    assets: [{asset: 'USDT', wallet: 30228.74, available: 9672.43, unrealized: 886.6}],
    positions: POSITIONS
  },
  c2c: {
    active: true,
    totalUsdt: 2140,
    assets: [
      {asset: 'USDT', balance: 1700, usdt: 1700},
      {asset: 'BTC', balance: 0.004, usdt: 341.2},
      {asset: 'FDUSD', balance: 98.8, usdt: 98.8}
    ]
  },
  stats: statsOf(POSITIONS)
}

/** 没开仓、只有钱包余额（也在用 C2C 收付款的那种） */
export const MOCK_FLAT: ExchangeOverview = {
  apiKeyId: 2,
  account: {exchange: 'binance', name: '币安 · 小号', sandbox: false, marketType: 'swap'},
  takenAt: '2026-10-05T10:40:12.000Z',
  futures: {
    wallet: 320.5,
    unrealized: 0,
    margin: 320.5,
    available: 320.5,
    used: 0,
    assets: [{asset: 'USDT', wallet: 320.5, available: 320.5, unrealized: 0}],
    positions: []
  },
  c2c: {active: true, totalUsdt: 860, assets: [{asset: 'USDT', balance: 860, usdt: 860}]},
  stats: statsOf([])
}

/** 刚绑上：合约没入金、C2C 钱包也没激活 */
export const MOCK_EMPTY: ExchangeOverview = {
  apiKeyId: 3,
  account: {exchange: 'okx', name: 'OKX 备用', sandbox: false, marketType: 'swap'},
  takenAt: '2026-10-05T10:44:31.000Z',
  futures: {
    wallet: 0,
    unrealized: 0,
    margin: 0,
    available: 0,
    used: 0,
    assets: [{asset: 'USDT', wallet: 0, available: 0, unrealized: 0}],
    positions: []
  },
  c2c: null,
  stats: statsOf([])
}

/** 预览页「换一套看」的选项 */
export const MOCK_ACCOUNTS: {value: number; label: string; data: ExchangeOverview}[] = [
  {value: 1, label: '币安 · 主号（合约 + C2C）', data: MOCK_FULL},
  {value: 2, label: '币安 · 小号（未开仓）', data: MOCK_FLAT},
  {value: 3, label: 'OKX · 空账户', data: MOCK_EMPTY}
]

/* ---------------- 下面这些不进快照：按需查、单独拉 ---------------- */

export interface ExchangeOpenOrder {
  id: string
  symbol: string
  side: string
  type: string
  price: number
  amount: number
  datetime: string | null
}

export interface ExchangeTrade {
  id: string
  symbol: string
  side: string
  price: number
  amount: number
  cost: number
  fee: number
  feeCurrency: string
  datetime: string | null
}

/** 当前挂单（`fapi/v1/openOrders`，不需要交易对） */
export const MOCK_OPEN_ORDERS: ExchangeOpenOrder[] = [
  {id: '1', symbol: 'BTCUSDT', side: 'buy', type: 'limit', price: 82500, amount: 0.005, datetime: '2026-10-05T09:12:44.000Z'},
  {id: '2', symbol: 'BTCUSDT', side: 'sell', type: 'limit', price: 88400, amount: 0.008, datetime: '2026-10-05T09:40:02.000Z'},
  {id: '3', symbol: 'ETHUSDT', side: 'buy', type: 'limit', price: 2620, amount: 2, datetime: '2026-10-05T10:01:19.000Z'},
  {id: '4', symbol: 'SOLUSDT', side: 'buy', type: 'limit', price: 138.4, amount: 12, datetime: '2026-10-05T10:28:57.000Z'}
]

/** 成交（`fapi/v1/allOrders` / `userTrades`，**必须带交易对**，所以是慢接口） */
export const MOCK_TRADES: ExchangeTrade[] = [
  {id: '1001', symbol: 'BTCUSDT', side: 'buy', price: 84620.4, amount: 0.01, cost: 846.2, fee: 0.42, feeCurrency: 'USDT', datetime: '2026-10-05T10:12:03.000Z'},
  {id: '1002', symbol: 'BTCUSDT', side: 'sell', price: 85110.2, amount: 0.006, cost: 510.66, fee: 0.26, feeCurrency: 'USDT', datetime: '2026-10-05T09:58:31.000Z'},
  {id: '1003', symbol: 'BTCUSDT', side: 'buy', price: 83880.1, amount: 0.012, cost: 1006.56, fee: 0.5, feeCurrency: 'USDT', datetime: '2026-10-05T09:31:12.000Z'},
  {id: '1004', symbol: 'ETHUSDT', side: 'sell', price: 2701.05, amount: 2, cost: 5402.1, fee: 2.7, feeCurrency: 'USDT', datetime: '2026-10-05T08:44:50.000Z'}
]

/** 已实现盈亏（`fapi/v1/income?incomeType=REALIZED_PNL`，币安专属） */
export const MOCK_INCOME: {symbol: string; income: number; time: string | null}[] = [
  {symbol: 'BTCUSDT', income: 245.8, time: '2026-10-05T10:12:03.000Z'},
  {symbol: 'SOLUSDT', income: 412.35, time: '2026-10-05T09:22:11.000Z'},
  {symbol: 'BTCUSDT', income: 156.2, time: '2026-10-05T05:41:20.000Z'},
  {symbol: 'ETHUSDT', income: 52.7, time: '2026-10-05T04:18:55.000Z'},
  {symbol: 'DOGEUSDT', income: -32.15, time: '2026-10-04T23:11:47.000Z'},
  {symbol: 'ETHUSDT', income: -88.4, time: '2026-10-04T21:05:33.000Z'},
  {symbol: 'BTCUSDT', income: -120.4, time: '2026-10-04T18:52:09.000Z'}
]
