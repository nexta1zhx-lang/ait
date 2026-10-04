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

/** 每个用户自己的大模型配置（从 `user_llm` 读出来，空字段 = 不覆盖） */
export interface LlmOverrides {
  apiKey?: string
  baseUrl?: string
  model?: string
  reasoningEffort?: ReasoningEffort
}

export interface ConfigOverrides {
  exchange?: string
  timeframes?: Timeframe[]
  apiBase?: string
  marketType?: MarketType
  /** 用户自己填的 DeepSeek 配置；给了就盖住 .env 那份 */
  llm?: LlmOverrides
}

export function loadConfig(overrides: ConfigOverrides = {}): AppConfig {
  const calibers = parseCalibers(loadCalibersFile())

  /*
   * ⚠️ 2026-10-04：**不再从 .env 读大模型配置** ——
   * Key / 接口地址 / 模型 / 思考力度都放在**每个用户自己的** `user_llm` 里
   * （「我的 → 模型配置」）。服务器 `.env` 里那份已经搬到管理员账号
   * （启动时 `seedAdminLlmFromEnv()` 自动搬一次，见 db/users.ts）。
   *
   * 所以这里只剩「这个用户什么都没配」时的兜底默认值。
   */
  const o = overrides.llm ?? {}
  const apiKey = (o.apiKey ?? '').trim()
  const baseUrl = (o.baseUrl ?? '').trim() || DEFAULT_LLM_BASE_URL
  /*
   * 历史别名（deepseek-chat / deepseek-reasoner）统一归一成真实模型 id ——
   * 否则同一份模型会在用量/存档里被记成两个名字，统计和单价都跟着错。
   */
  const model = canonicalModel((o.model ?? '').trim() || DEFAULT_LLM_MODEL)
  /*
   * 思考力度默认 `none`：模型把思维链写在隐藏字段里，算 token、占时间，
   * 而代码只读 message.content —— 实测关掉后快 3.7 倍、输出 token 少 4 倍。
   * 用户可以在「模型配置」里改成 minimal / high，或 auto（不传参数）。
   */
  const effort =
    o.reasoningEffort !== undefined ? o.reasoningEffort : DEFAULT_REASONING

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
    /*
     * 流水保留期（天）。**0 = 永不清理**。
     * 用户 2026-10-04：「流水数据永远不删吧」—— 所以默认就是 0（以前默认 90）。
     * 想给数据库减负就显式写 `KEEP_DAYS=90`。
     */
    keepDays: Math.max(0, num(process.env.KEEP_DAYS, 0)),
    llm: {
      apiKey,
      baseUrl,
      model,
      temperature: DEFAULT_LLM_TEMPERATURE,
      reasoningEffort: effort
    }
  }
}

/* ---------------------------------------------------------------- */
/* 大模型默认值（只有「用户什么都没配」时才用得上）                    */
/* ---------------------------------------------------------------- */

/** DeepSeek 官方接口地址 */
export const DEFAULT_LLM_BASE_URL = 'https://api.deepseek.com'
/** 便宜那档；贵的那档是 `deepseek-v4-pro` */
export const DEFAULT_LLM_MODEL = 'deepseek-flash'
/** 默认不思考（见上面那段注释） */
export const DEFAULT_REASONING: ReasoningEffort = 'none'
/** 判断要尽量稳定，温度给低一点 */
export const DEFAULT_LLM_TEMPERATURE = 0.1
