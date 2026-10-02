import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import {canonicalModel} from './llm/pricing'
import {parseCalibers} from './calibers'
import {AppConfig, MarketType, ReasoningEffort, Timeframe} from './types'

/** 仓库根目录（backend/src 与 backend/dist 的往上两级） */
export const ROOT_DIR = path.resolve(__dirname, '..', '..')

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback
}

/**
 * 读 `config/calibers.yaml`（口径参数 + 回溯天数的默认值）。
 *
 * 文件不在或写坏都退回默认值，不影响启动。
 * 风控/账户那套（guardrails.yaml）已于 2026-10-02 整体删除。
 */
function loadCalibersFile(): Record<string, unknown> {
  const p = path.join(ROOT_DIR, 'config/calibers.yaml')
  if (!fs.existsSync(p)) return {}
  try {
    const parsed = YAML.parse(fs.readFileSync(p, 'utf8'))
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch (e) {
    console.warn(
      `[config] 解析 config/calibers.yaml 失败（按默认口径走）：${(e as Error).message}`
    )
    return {}
  }
}

export interface ConfigOverrides {
  exchange?: string
  timeframes?: Timeframe[]
  apiBase?: string
  marketType?: MarketType
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const calibers = parseCalibers(loadCalibersFile())

  return {
    exchange: overrides.exchange ?? process.env.EXCHANGE ?? 'binance',
    apiBase: overrides.apiBase ?? process.env.API_BASE ?? undefined,
    marketType:
      overrides.marketType ??
      ((process.env.MARKET_TYPE as MarketType) || 'swap'),
    timeframes:
      overrides.timeframes ?? (['15m', '1h', '4h', '1d'] as Timeframe[]),
    // 主周期默认看多少天。前端每次会传「图上那段」的天数，
    // 这里的只是命令行 / 没传时的兜底。
    lookbackDays: Math.max(1, num(process.env.LOOKBACK_DAYS, 3)),
    calibers,
    llm: {
      apiKey: process.env.LLM_API_KEY ?? '',
      baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
      /**
       * .env 里可能是历史别名（deepseek-chat / deepseek-reasoner）。
       * 这里统一归一成真实模型 id —— 否则同一份模型会在用量/存档里
       * 被记成两个名字，统计和单价都跟着错。
       */
      model: canonicalModel(process.env.LLM_MODEL ?? 'deepseek-flash'),
      temperature: num(process.env.LLM_TEMPERATURE, 0.1),
      /**
       * 思考力度。**默认 none**：模型把思维链写在隐藏字段里，算 token、
       * 占时间，而代码只读 message.content —— 实测关掉后快 3.7 倍、
       * 输出 token 少 4 倍，结论长度反而更长。
       * 想让它想：.env 里写 LLM_REASONING=minimal / high；
       * 想让模型自己决定：LLM_REASONING=auto（等于不传这个参数）。
       */
      reasoningEffort: reasoningEffort(process.env.LLM_REASONING)
    }
  }
}

const REASONING_VALUES = ['none', 'minimal', 'low', 'medium', 'high'] as const

/**
 * 解析 LLM_REASONING。
 *   空 / auto      → null（不传参数，模型自己决定）
 *   none/minimal/… → 原样传给 API
 *   不认识的写法   → 当成 auto，并在启动时提醒一句
 */
function reasoningEffort(raw: string | undefined): ReasoningEffort {
  const v = (raw ?? 'none').trim().toLowerCase()
  if (v === '' || v === 'auto' || v === 'default') return null
  if ((REASONING_VALUES as readonly string[]).includes(v)) {
    return v as ReasoningEffort
  }
  console.warn(
    `⚠️  LLM_REASONING=“${raw}” 不认识（可用：${REASONING_VALUES.join(' / ')} / auto），本次按 auto 处理`
  )
  return null
}
