export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d'

/** 市场类型：现货 / U 本位合约 / 币本位合约 */
export type MarketType = 'spot' | 'swap' | 'coinm'

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type TrendState = 'up' | 'down' | 'range'

/** 价格结构（完全基于高低点，不依赖任何技术指标） */
export interface StructureState {
  /** 更高的高点 */
  higherHighs: boolean
  /** 更高的低点 */
  higherLows: boolean
  /** 更低的高点 */
  lowerHighs: boolean
  /** 更低的低点 */
  lowerLows: boolean
  /** 最近一个波段高（做空止损参考） */
  lastSwingHigh: number
  /** 最近一个波段低（做多止损参考） */
  lastSwingLow: number
  /** 统计区间内的最高价 */
  swingHigh: number
  /** 统计区间内的最低价 */
  swingLow: number
  /** 参与统计的 K 线根数 */
  lookback: number
}

/** 单周期趋势快照（趋势 + 周期，不含指标） */
export interface TimeframeTrend {
  timeframe: Timeframe
  close: number
  trend: TrendState
  /** 该周期统计区间的净涨跌幅 % */
  netChangePct: number
  /** 该周期统计区间的振幅 % */
  rangePct: number
  /** 量比：最新一根成交量 / 近 20 根均量 */
  volRatio: number
  structure: StructureState
}

/** 市场热度（来自交易所公开数据，与盘面情绪相关） */
export interface MarketHeat {
  /** 资金费率 */
  fundingRate: number | null
  /** 持仓量 */
  openInterest: number | null
  /** 持仓量变化 %（近几期） */
  openInterestChangePct: number | null
  /** 24h 成交额 */
  quoteVolume24h: number | null
  /** 24h 涨跌幅 % */
  change24hPct: number | null
  /** 24h 振幅 % = (high - low) / low * 100 */
  amplitude24hPct: number | null
  /** 多空持仓人数比 */
  longShortRatio: number | null
  high24h: number | null
  low24h: number | null
}

export interface MarketSnapshot {
  symbol: string
  exchange: string
  timestamp: number
  price: number
  /** 各周期趋势（用于判断多周期是否共振） */
  timeframes: TimeframeTrend[]
  /** 市场热度 */
  heat: MarketHeat
  /** 止损参考结构（取 1H） */
  structure: StructureState
  /** 上下文中包含的最近 K 线 */
  recentCandles: Candle[]
  /** 用于绘图的完整 K 线序列（recentTimeframe，数量为 candlesLimit） */
  series: Candle[]
  /** 扁平化变量命名空间，供护栏表达式引用 */
  variables: Record<string, number>
}

export interface DisciplineCheck {
  rule: string
  pass: boolean
  note: string
}

export interface TakeProfit {
  label: string
  price: number
  r: number
  reducePercent: number
}

export type DecisionKind = 'open' | 'wait' | 'no_open'
export type Direction = 'long' | 'short' | 'none'

export interface LlmDecision {
  decision: DecisionKind
  direction: Direction
  confidence: number
  entry: {type: 'market' | 'limit'; price: number | null}
  stopLoss: number | null
  takeProfits: TakeProfit[]
  disciplineChecks: DisciplineCheck[]
  veto: string[]
  reasoning: string
  missing: string[]
}

export type Severity = 'reject' | 'warn'

export interface Violation {
  id: string
  desc: string
  severity: Severity
}

export interface PositionPlan {
  riskPercent: number
  riskAmount: number
  stopDistance: number
  quantity: number
  notional: number
  requiredLeverage: number
  leverageUsed: number
}

export interface GuardrailCheck {
  name: string
  pass: boolean
  detail: string
}

export interface GuardrailResult {
  passed: boolean
  violations: Violation[]
  checks: GuardrailCheck[]
  position: PositionPlan | null
  minRr: number
  rMultiple: number | null
}

/**
 * 期望值：按分批减仓比例**加权**的盈亏比，算出每笔的数学期望（单位 R）。
 *
 *   E = p × 加权R − (1 − p)
 *
 * E > 0 才值得做。假设胜率 p 由用户给（页面默认 0.45）。
 */
export interface Expectancy {
  /** 假设胜率（0~1） */
  winRate: number
  /** 按减仓比例加权的盈亏比 */
  weightedR: number
  /** 最远那一档的盈亏比 */
  maxR: number
  /** 数学期望（R） */
  expectancyR: number
  positive: boolean
}

export interface RedLineConfig {
  id: string
  desc: string
  when: string
}

export interface AppConfig {
  exchange: string
  /** 覆盖交易所公共 API 域名（默认域名不可达时使用） */
  apiBase?: string
  marketType: MarketType
  timeframes: Timeframe[]
  candlesLimit: number
  accountEquity: number
  riskPercent: number
  maxLeverage: number
  maxRiskPercent: number
  minRrRatio: number
  /** 止损距入场的百分比合理区间（用于替代 ATR 校验） */
  stopPctRange: [number, number]
  takeProfitR: number[]
  reducePercents: number[]
  redLines: RedLineConfig[]
  llm: {
    apiKey: string
    baseUrl: string
    /** 真实模型 id。历史别名（deepseek-chat 等）在读配置时已归一 */
    model: string
    temperature: number
  }
}
