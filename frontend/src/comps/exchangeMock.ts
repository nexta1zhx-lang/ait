/**
 * 「交易所账户」新版界面的**模拟数据** —— 只为预览效果，不参与线上逻辑。
 *
 * 为什么要它（用户 2026-10-05：「交易所行情账户界面大优化，根据返回的数据格式
 * 先模拟一套数据看看效果」）：
 *   真实数据要绑 API Key + 打交易所，**没法拿来反复调样式**（换个数就要重新拉，
 *   而且字段一会儿全一会儿空）。所以这里照 `ExchangeAccountResult`
 *   （`frontend/src/api.ts`）**一比一**造一套，类型直接标上去 ——
 *   **接口一变，这里编译不过**，比对着假 JSON 调样式安全。
 *
 * ⚠️ 数值是照币安 U 本位合约账户的量级手写的（USDT 为主 + 几个币种仓位），
 *    改的时候别改出「合计 ≠ 各项之和」这种自相矛盾的组合，不然看不出真实排版效果。
 */
import type {
  ExchangeAccountResult,
  ExchangeBalanceRow,
  ExchangeKey,
  ExchangeOrderRow,
  ExchangePositionRow
} from '../api'

/** 模一套账户（下拉里显示的那套） */
function key(over: Partial<ExchangeKey> = {}): ExchangeKey {
  return {
    id: 1,
    exchange: 'binance',
    name: '币安 · 主号',
    apiKey: 'Zk9f****3mQ7',
    apiKeySet: true,
    secret: '****',
    secretSet: true,
    password: '',
    passwordSet: false,
    marketType: 'swap',
    sandbox: false,
    isDefault: true,
    createdAt: '2026-09-18T03:24:11.000Z',
    updatedAt: '2026-10-04T15:02:38.000Z',
    ...over
  }
}

/** 余额行：`usdt` 传 null 就是「查不到价」 */
const bal = (
  currency: string,
  free: number,
  used: number,
  usdt: number | null
): ExchangeBalanceRow => ({
  currency,
  free,
  used,
  total: Math.round((free + used) * 1e8) / 1e8,
  usdt
})

/* ---------------- 合约账户（有余额 + 持仓 + 挂单 + 盈亏） ---------------- */

export const MOCK_CONTRACT: ExchangeAccountResult = {
  account: key(),
  balance: {
    partial: false,
    updatedAt: '2026-10-05T10:42:07.000Z',
    totalUsdt: 31115.34,
    rows: [
      bal('USDT', 6120.4, 18232.55, 24352.95),
      bal('BTC', 0.0152, 0.0342, 4213.86),
      bal('ETH', 0.42, 0.11, 1431.53),
      bal('SOL', 3.2, 0, 486.4),
      bal('BNB', 0.8, 0, 463.2),
      bal('DOGE', 1200, 0, 154.8),
      bal('PEPE', 1500000, 0, 12.6),
      // 这几个是「小额 / 查不到价」的典型，用来试折叠那套：
      bal('USDC', 0.42, 0, 0.42),
      bal('TRX', 38.5, 0, 3.62),
      bal('SHIB', 0, 0, 0)
    ]
  },
  positions: [
    {
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      contracts: 0.5,
      notional: 42650.05,
      entryPrice: 84120.3,
      markPrice: 85300.1,
      liquidationPrice: 76504.2,
      leverage: 20,
      unrealizedPnl: 589.9,
      percentage: 27.63
    },
    {
      symbol: 'ETH/USDT:USDT',
      side: 'short',
      contracts: 6,
      notional: 16206.3,
      entryPrice: 2750.5,
      markPrice: 2701.05,
      liquidationPrice: 2993.2,
      leverage: 10,
      unrealizedPnl: 296.7,
      percentage: 18.31
    }
  ],
  openOrders: [
    {
      id: '1849203311',
      datetime: '2026-10-05T09:12:44.000Z',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      price: 82500,
      amount: 0.005,
      cost: 412.5,
      status: 'open',
      fee: 0,
      feeCurrency: 'USDT'
    },
    {
      id: '1849203312',
      datetime: '2026-10-05T09:40:02.000Z',
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'limit',
      price: 88400,
      amount: 0.008,
      cost: 707.2,
      status: 'open',
      fee: 0,
      feeCurrency: 'USDT'
    },
    {
      id: '1849203313',
      datetime: '2026-10-05T10:01:19.000Z',
      symbol: 'ETH/USDT',
      side: 'buy',
      type: 'limit',
      price: 2620,
      amount: 2,
      cost: 5240,
      status: 'open',
      fee: 0,
      feeCurrency: 'USDT'
    },
    {
      id: '1849203314',
      datetime: '2026-10-05T10:28:57.000Z',
      symbol: 'SOL/USDT',
      side: 'buy',
      type: 'limit',
      price: 138.4,
      amount: 12,
      cost: 1660.8,
      status: 'open',
      fee: 0,
      feeCurrency: 'USDT'
    }
  ],
  orders: {
    kind: 'trades',
    needSymbol: false,
    tried: ['BTC/USDT'],
    rows: [
      trade('1001', '2026-10-05T10:12:03.000Z', 'BTC/USDT', 'buy', 84620.4, 0.01, 846.2, 'closed', 0.42),
      trade('1002', '2026-10-05T09:58:31.000Z', 'BTC/USDT', 'sell', 85110.2, 0.006, 510.66, 'closed', 0.26),
      trade('1003', '2026-10-05T09:31:12.000Z', 'BTC/USDT', 'buy', 83880.1, 0.012, 1006.56, 'closed', 0.5),
      trade('1004', '2026-10-05T08:44:50.000Z', 'BTC/USDT', 'sell', 84200, 0.008, 673.6, 'closed', 0.34),
      trade('1005', '2026-10-05T07:20:08.000Z', 'BTC/USDT', 'buy', 83150.5, 0.015, 1247.26, 'closed', 0.62),
      trade('1006', '2026-10-05T06:03:41.000Z', 'BTC/USDT', 'sell', 82890.7, 0.02, 1657.81, 'closed', 0.83)
    ]
  },
  income: [
    {symbol: 'BTCUSDT', income: 245.8, time: '2026-10-05T10:12:03.000Z'},
    {symbol: 'SOLUSDT', income: 412.35, time: '2026-10-05T09:22:11.000Z'},
    {symbol: 'BTCUSDT', income: 156.2, time: '2026-10-05T05:41:20.000Z'},
    {symbol: 'ETHUSDT', income: 52.7, time: '2026-10-05T04:18:55.000Z'},
    {symbol: 'SOLUSDT', income: 78.9, time: '2026-10-05T02:37:02.000Z'},
    {symbol: 'DOGEUSDT', income: -32.15, time: '2026-10-04T23:11:47.000Z'},
    {symbol: 'ETHUSDT', income: -88.4, time: '2026-10-04T21:05:33.000Z'},
    {symbol: 'BTCUSDT', income: -120.4, time: '2026-10-04T18:52:09.000Z'}
  ],
  balanceError: null,
  positionsError: null,
  openOrdersError: null,
  ordersError: null,
  incomeError: null
}

/* ---------------- 现货账户（没有持仓 / 盈亏那两块） ---------------- */

export const MOCK_SPOT: ExchangeAccountResult = {
  account: key({
    id: 2,
    exchange: 'okx',
    name: 'OKX 现货',
    marketType: 'spot',
    isDefault: false
  }),
  balance: {
    partial: true,
    updatedAt: '2026-10-05T10:39:52.000Z',
    totalUsdt: 5004.18,
    rows: [
      bal('USDT', 3020.5, 880, 3900.5),
      bal('BTC', 0.0089, 0, 758.98),
      bal('ETH', 0.09, 0, 243.09),
      bal('OKB', 1.2, 0, 71.4),
      bal('SOL', 0.2, 0, 30.4),
      // 「查不到价」的那种：显示 — 而不是 0，也不计入合计
      bal('XYZ', 12000, 0, null)
    ]
  },
  positions: [],
  openOrders: [
    {
      id: '778812',
      datetime: '2026-10-05T08:15:00.000Z',
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'limit',
      price: 89000,
      amount: 0.002,
      cost: 178,
      status: 'open',
      fee: 0,
      feeCurrency: 'USDT'
    }
  ],
  orders: {
    kind: 'orders',
    needSymbol: true,
    tried: [],
    rows: []
  },
  income: null,
  balanceError: null,
  positionsError: null,
  openOrdersError: null,
  ordersError: null,
  incomeError: null
}

/* ---------------- 空账户（刚绑上还没入金 / 还没有成交） ---------------- */

export const MOCK_EMPTY: ExchangeAccountResult = {
  account: key({id: 3, name: '币安 · 小号', marketType: 'swap', isDefault: false}),
  balance: {
    partial: false,
    updatedAt: '2026-10-05T10:44:31.000Z',
    totalUsdt: 0,
    rows: [bal('USDT', 0, 0, 0)]
  },
  positions: [],
  openOrders: [],
  orders: {kind: 'trades', needSymbol: false, tried: [], rows: []},
  income: [],
  balanceError: null,
  positionsError: null,
  openOrdersError: null,
  ordersError: null,
  incomeError: null
}

/* ---------------- 逐笔成交工厂 ---------------- */

function trade(
  id: string,
  datetime: string,
  symbol: string,
  side: 'buy' | 'sell',
  price: number,
  amount: number,
  cost: number,
  status: string,
  fee: number
): ExchangeOrderRow {
  return {
    id,
    datetime,
    symbol,
    side,
    type: 'market',
    price,
    amount,
    cost,
    status,
    fee,
    feeCurrency: 'USDT'
  }
}

/** 预览页的「换一套看」选项 */
export const MOCK_SCENES: {value: string; label: string}[] = [
  {value: 'contract', label: '合约（全）'},
  {value: 'spot', label: '现货'},
  {value: 'empty', label: '空账户'},
  {value: 'loading', label: '查询中'},
  {value: 'error', label: '查询失败'}
]
