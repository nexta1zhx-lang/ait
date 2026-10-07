/**
 * 图表 / 分析支持的周期。
 *
 * ⚠️ `'1m'` 是 2026-10-07 用户要求加进前端的（「一分钟的选项 k 也在前端需要」）。
 *    它以前的处境很尴尬：请求 `timeframe=1m` 会被 `VALID_TFS` 挡下、**静默按 1h 返回**
 *    （2026-10-06 就因此把仓位明细那张图变成了一小时 K 线，8 笔成交全挤在一根上）。
 *    现在 1m 是正式成员：底座常驻存 7 天，`/api/candles` 与 K 线 WS 都认它。
 */
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

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

/**
 * 判档：A 顺势单 / A-W 顺势双底 / S 突破 / V 超跌极速V反 / B 不该做 / unclear 说不清。
 *
 * 2026-10-02 起开单分析**不再判档**了（改成预测走势），这个类型只给
 * 历史记录 / 老数据兼容用，新记录不再写档位。
 */
export type Grade = 'A' | 'A-W' | 'S' | 'V' | 'B' | 'unclear'

/**
 * 取数参数 —— 分析时「各周期各拉多少根 K 线」，来自 `config/calibers.yaml`。
 *
 * ⚠️ 这里**没有任何口径公式**（不变量比、不找摆点、不算区间位置）——
 * 行情直接把 K 线切成小段交给 AI 自己读（跟知识库收录时同一套做法）。
 */
export interface Calibers {
  /**
   * 其余周期各拉多少天：主周期 → { 那个周期: 天数 }。
   * 主周期自己不在表里 —— 它用「图上那段有多长」的天数。
   */
  others: Record<string, Partial<Record<Timeframe, number>>>
  /** 根数下限（日线只给几天时兜底） */
  minBars: number
  /** 根数上限（15m 别拉爆） */
  maxBars: number
}

/** 一个周期的行情块 —— 就是 `describeSeries` 切出来的那段文字 */
export interface SeriesBlock {
  timeframe: Timeframe
  /** 是不是主周期（图上那个） */
  primary: boolean
  /** 这个块往前看了多少天 */
  days: number
  /** 实际拉到的根数 */
  bars: number
  /** 第一根 / 最后一根的时间戳 */
  from: number
  to: number
  /** 切段描述（整段速览 + 分几小段），直接喂给 AI */
  text: string
  /**
   * EMA42 —— **只有 15m / 1h 两块才有**。
   * 用户 2026-10-03：「EMA42 不是必要看的，只在看回调时、看 15m 和 1h 才参考」。
   * 4h / 1d 不给（主周期是 4h/1d 时快照里就完全没有均线这一节）。
   */
  ema42?: Ema42Info
}

/*
 * 已删除（2026-10-02）：StructureState / TfStats / TimeframeTrend
 *
 * 那三个是「先把 K 线压成公式值再给 AI」那一套的产物（摆点、量比、量能水平、
 * 区间位置…）。现在改成把 K 线**切成小段直接描述**给 AI（`analysis/describe.ts`
 * 的 `describeSeries`，跟知识库收录时同一个做法），所以它们没人用了。
 */

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

import type {Ema42Info} from './analysis/ema'

export interface MarketSnapshot {
  symbol: string
  exchange: string
  timestamp: number
  price: number
  /** 主周期（你在图上看的那个） */
  primary: Timeframe
  /** 各周期的行情块（按周期从短到长），每块就是一段切段描述 */
  blocks: SeriesBlock[]
  /** 市场热度 */
  heat: MarketHeat
  /** 主周期的 K 线 —— 给前端画图；后端只用它算 EMA42，不整段发给 AI */
  candles: Candle[]
}

/*
 * ── 已删除（2026-10-02 大简化）──
 *
 * 原来这里有：DisciplineCheck / TakeProfit / LlmDecision / ChecklistRate /
 * Violation / PositionPlan / GuardrailResult / Expectancy / RedLineConfig。
 *
 * 连同 `guardrails/validator.ts` 与 `analysis/expectancy.ts` 一起整块去掉了：
 * 账户资金、单笔风险、杠杆、盈亏比、止损距离、硬性红线、准入清单 —— 全不要了。
 *
 * 现在 AI 只回四个字段：档位 grade + 标签 tags + 理由 reason + 结论 verdict
 * （见 `llm/schema.ts` 的 judgeSchema）。代码不再算仓位、不再校验。
 */

export interface AppConfig {
  exchange: string
  /** 覆盖交易所公共 API 域名（默认域名不可达时使用） */
  apiBase?: string
  marketType: MarketType
  timeframes: Timeframe[]
  /**
   * 回溯多少天（前端那个「看最近 N 天」）。
   * 各周期实际拉多少根 = 天数 ÷ 周期长度，再按 calibers 的上下限夹一下。
   */
  lookbackDays: number
  /** 口径参数（算公式用的数字），来自 `config/calibers.yaml` */
  calibers: Calibers
  /**
   * 分析 / 用量流水保留多少天（<= 0 = 不清理）。
   *
   * 用户 2026-10-04：「历史统计数据保存 3 个月的」→ 默认 **90**。
   * ⚠️ 只删 `analyses` / `llm_usage` 这两张流水表，
   *    `knowledge`（一条条攒的经验案例）和提示词**绝不碰**。
   */
  keepDays: number
  llm: {
    apiKey: string
    baseUrl: string
    /** 真实模型 id。历史别名（deepseek-chat 等）在读配置时已归一 */
    model: string
    temperature: number
    /**
     * 思考力度（部分模型会把「思维链」写在隐藏字段 reasoning_content 里）。
     *
     * `'none'` = 关掉思考：实测快 3.7 倍、输出 token 少 4 倍，
     * 而且思维链本来就没被代码用到（只读 message.content）。
     * `null` = 不传这个参数，让模型自己决定。
     */
    reasoningEffort: ReasoningEffort
  }
}

/** 思考力度；null = 不传参数 */
export type ReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | null
