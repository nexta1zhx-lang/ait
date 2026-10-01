import {AppConfig} from '../types'
import {canonicalModel, isAlias, priceFor} from './pricing'

/**
 * DeepSeek 账户余额与可用模型。
 *
 * 官方接口：
 *   GET /user/balance  → {is_available, balance_infos:[{currency,total_balance,...}]}
 *   GET /models        → {data:[{id,owned_by}]}
 *
 * 余额本来就是人民币（CNY），所以直接展示，不做汇率换算。
 */

const BALANCE_PATH = '/user/balance'
const MODELS_PATH = '/models'

/** 缓存：余额不用每次刷页面都去打接口，免得白白消耗额度 */
const CACHE_MS = 60_000

export interface BalanceInfo {
  currency: string
  /** 总余额（可用 + 赠金） */
  total: number
  /** 赠金余额 */
  granted: number
  /** 充值余额 */
  toppedUp: number
}

export interface BalanceResult {
  ok: boolean
  available: boolean
  /** 主币种余额（DeepSeek 返回 CNY） */
  infos: BalanceInfo[]
  /** 方便前端直接用的人民币总额 */
  cny: number | null
  /** 出错时的说明（没配 Key / 网络不通 / 接口变更） */
  error: string | null
  /** 结果是否来自缓存 */
  cached: boolean
  fetchedAt: string
}

function baseUrl(config: AppConfig): string {
  return (config.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

let cache: {at: number; data: BalanceResult} | null = null

/** 清掉缓存（切换 Key / 手动刷新时用） */
export function clearBalanceCache(): void {
  cache = null
}

/** 查账户余额。失败不抛错，用 ok/error 表达，页面照常显示。 */
export async function fetchBalance(
  config: AppConfig,
  opts: {force?: boolean} = {}
): Promise<BalanceResult> {
  const now = Date.now()
  if (!opts.force && cache && now - cache.at < CACHE_MS) {
    return {...cache.data, cached: true}
  }

  const empty = (error: string): BalanceResult => ({
    ok: false,
    available: false,
    infos: [],
    cny: null,
    error,
    cached: false,
    fetchedAt: new Date().toISOString()
  })

  if (!config.llm.apiKey) {
    return empty(
      '未配置 LLM_API_KEY，拿不到余额。在 .env 里填上 Key 就能看到。'
    )
  }

  const url = `${baseUrl(config)}${BALANCE_PATH}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    })
  } catch (e) {
    return empty(`请求余额失败：${(e as Error).message}`)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const hint =
      res.status === 401
        ? 'API Key 无效或已过期'
        : res.status === 404
          ? '当前服务商没有 /user/balance 接口（只有 DeepSeek 官方有）'
          : `HTTP ${res.status}`
    return empty(`${hint}${body ? '：' + body.slice(0, 160) : ''}`)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return empty('余额接口返回的不是 JSON')
  }

  const raw = json as {
    is_available?: boolean
    balance_infos?: {
      currency?: string
      total_balance?: string | number
      granted_balance?: string | number
      topped_up_balance?: string | number
    }[]
  }

  const infos: BalanceInfo[] = (raw.balance_infos ?? []).map(b => ({
    currency: String(b.currency ?? 'CNY').toUpperCase(),
    total: num(b.total_balance),
    granted: num(b.granted_balance),
    toppedUp: num(b.topped_up_balance)
  }))

  const cnyInfo = infos.find(i => i.currency === 'CNY') ?? infos[0] ?? null

  const data: BalanceResult = {
    ok: true,
    available: Boolean(raw.is_available),
    infos,
    cny: cnyInfo ? cnyInfo.total : null,
    error: infos.length ? null : '接口没返回余额明细',
    cached: false,
    fetchedAt: new Date().toISOString()
  }

  cache = {at: now, data}
  return data
}

/* ------------------------------------------------------------------ */
/* 可用模型                                                            */
/* ------------------------------------------------------------------ */

/** 拉不到就退回这份内置列表（DeepSeek 官方在售，只有这两个） */
export const FALLBACK_MODELS = ['deepseek-flash', 'deepseek-v4-pro']

export interface ModelOption {
  id: string
  /** 价目表里有没有它（没有就是按兜底价估算） */
  priced: boolean
  /** 每 1M token 的高峰单价（美元），便于前端展示 */
  price: {inputHit: number; inputMiss: number; output: number}
}

export interface ModelsResult {
  /** 当前正在用的模型（已归一成真实 id） */
  current: string
  /** .env 里写的是别名的话，这里放原始值，页面上提示一下 */
  alias: string | null
  /** 可选列表 */
  available: ModelOption[]
  /** 列表是从接口拿的，还是内置兜底 */
  fromApi: boolean
  error: string | null
}

function option(id: string): ModelOption {
  const lookup = priceFor(id)
  return {id, priced: !lookup.assumed, price: lookup.price}
}

/** 查可用模型 */
export async function fetchModels(config: AppConfig): Promise<ModelsResult> {
  /**
   * .env 里写的可能是历史别名（deepseek-chat / deepseek-reasoner）。
   * 别名不是真实模型 id，直接塞进列表会出现「选了不存在的模型」——
   * 所以先归一，再拿归一后的 id 去跟真实列表对齐。
   */
  const raw = config.llm.model
  const current = canonicalModel(raw)

  /** 真实列表里没有 current 时兜底也算上，免得下拉框选不中当前在用的模型 */
  const build = (ids: string[], fromApi: boolean, error: string | null) => {
    const list = [...new Set(ids)].filter(Boolean)
    if (!list.includes(current)) list.unshift(current)
    return {
      current,
      alias: isAlias(raw) ? raw : null,
      available: list.map(option),
      fromApi,
      error
    }
  }

  if (!config.llm.apiKey) return build(FALLBACK_MODELS, false, null)

  try {
    const res = await fetch(`${baseUrl(config)}${MODELS_PATH}`, {
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok)
      return build(
        FALLBACK_MODELS,
        false,
        `模型列表接口返回 HTTP ${res.status}`
      )

    const json = (await res.json()) as {data?: {id?: string}[]}
    const ids = (json.data ?? [])
      .map(m => canonicalModel(String(m.id ?? '')))
      .filter(Boolean)
      .sort()

    if (!ids.length)
      return build(FALLBACK_MODELS, false, '模型列表是空的，用内置列表')

    return build(ids, true, null)
  } catch (e) {
    return build(
      FALLBACK_MODELS,
      false,
      `请求模型列表失败：${(e as Error).message}`
    )
  }
}
