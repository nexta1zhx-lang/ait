import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import {canonicalModel} from './llm/pricing'
import {AppConfig, MarketType, RedLineConfig, Timeframe} from './types'

/** 仓库根目录（backend/src 与 backend/dist 的往上两级） */
export const ROOT_DIR = path.resolve(__dirname, '..', '..')

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback
}

function pick<T>(v: unknown, fallback: T): T {
  return v === undefined || v === null ? fallback : (v as T)
}

function loadGuardrailsFile(): Record<string, unknown> {
  const candidates = [
    'config/guardrails.yaml',
    'config/guardrails.example.yaml'
  ]
  for (const rel of candidates) {
    const p = path.join(ROOT_DIR, rel)
    if (fs.existsSync(p)) {
      try {
        const parsed = YAML.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && typeof parsed === 'object')
          return parsed as Record<string, unknown>
      } catch (e) {
        console.warn(`[config] 解析 ${rel} 失败：${(e as Error).message}`)
      }
    }
  }
  return {}
}

export interface ConfigOverrides {
  exchange?: string
  timeframes?: Timeframe[]
  apiBase?: string
  marketType?: MarketType
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const g = loadGuardrailsFile()
  const risk = (g['风控'] as Record<string, unknown>) ?? {}
  const rawRedLines = Array.isArray(g['硬性红线'])
    ? (g['硬性红线'] as unknown[])
    : []

  const redLines: RedLineConfig[] = rawRedLines
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r, i) => ({
      id: String(r.id ?? `redline_${i}`),
      desc: String(r.desc ?? ''),
      when: String(r.when ?? 'false')
    }))

  const stopRange = pick<number[]>(risk['止损距离百分比范围'], [0.2, 8])

  return {
    exchange: overrides.exchange ?? process.env.EXCHANGE ?? 'binance',
    apiBase: overrides.apiBase ?? process.env.API_BASE ?? undefined,
    marketType:
      overrides.marketType ??
      ((process.env.MARKET_TYPE as MarketType) || 'swap'),
    timeframes:
      overrides.timeframes ?? (['15m', '1h', '4h', '1d'] as Timeframe[]),
    candlesLimit: 300,
    accountEquity: pick(
      risk['账户资金'],
      num(process.env.ACCOUNT_EQUITY, 10000)
    ),
    riskPercent: pick(risk['单笔风险百分比'], num(process.env.RISK_PERCENT, 1)),
    maxLeverage: pick(risk['最大杠杆'], num(process.env.MAX_LEVERAGE, 5)),
    maxRiskPercent: pick(risk['单笔风险上限百分比'], 2),
    minRrRatio: pick(risk['最小盈亏比'], 1.5),
    stopPctRange: [Number(stopRange[0] ?? 0.2), Number(stopRange[1] ?? 8)],
    takeProfitR: pick<number[]>(risk['止盈分批'], [1, 2, 3]),
    reducePercents: pick<number[]>(risk['分批减仓比例'], [50, 25, 25]),
    redLines,
    llm: {
      apiKey: process.env.LLM_API_KEY ?? '',
      baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
      /**
       * .env 里可能是历史别名（deepseek-chat / deepseek-reasoner）。
       * 这里统一归一成真实模型 id —— 否则同一份模型会在用量/存档里
       * 被记成两个名字，统计和单价都跟着错。
       */
      model: canonicalModel(process.env.LLM_MODEL ?? 'deepseek-flash'),
      temperature: num(process.env.LLM_TEMPERATURE, 0.1)
    }
  }
}
