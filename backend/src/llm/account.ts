import {AppConfig} from '../types'
import {canonicalModel, isAlias, priceFor} from './pricing'

/**
 * 可用模型列表。
 *
 * 官方接口：`GET /models` → {data:[{id,owned_by}]}
 *
 * 余额单独走 `fetchBalance()`（`GET /user/balance`，带 60 秒缓存）。
 * 账户资金 / 仓位那一套仍然没有 —— 只留「切模型 + 看还剩多少钱」。
 */

const MODELS_PATH = '/models'
const BALANCE_PATH = '/user/balance'

function baseUrl(config: AppConfig): string {
  return (config.llm.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ */
/* 账户余额                                                             */
/* ------------------------------------------------------------------ */

export interface BalanceInfo {
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

export interface BalanceResult {
  ok: boolean
  available: boolean
  /** 首选币种（有 CNY 就用 CNY，否则第一个） */
  main: BalanceInfo | null
  /** 接口返回的全部币种 */
  infos: BalanceInfo[]
  /** 拿不到时的原因（没配 Key / 接口报错） */
  error: string | null
  fetchedAt: number
}

/** 官方接口：`GET /user/balance` */
function toInfo(raw: any): BalanceInfo {
  const num = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return {
    currency: String(raw?.currency ?? ''),
    totalBalance: num(raw?.total_balance),
    grantedBalance: num(raw?.granted_balance),
    toppedUpBalance: num(raw?.topped_up_balance)
  }
}

/**
 * 查余额。**带 60 秒缓存** —— 顶栏一刷新就调一次，没必要每次都打接口。
 * `refresh = true` 绕过缓存（页面上点一下就是刷新）。
 */
let balanceCache: {at: number; value: BalanceResult} | null = null

export async function fetchBalance(
  config: AppConfig,
  refresh = false
): Promise<BalanceResult> {
  const now = Date.now()
  if (!refresh && balanceCache && now - balanceCache.at < 60_000) {
    return balanceCache.value
  }

  const fail = (error: string): BalanceResult => ({
    ok: false,
    available: false,
    main: null,
    infos: [],
    error,
    fetchedAt: now
  })

  if (!config.llm.apiKey) {
    balanceCache = {at: now, value: fail('没有配置 API Key')}
    return balanceCache.value
  }

  try {
    const res = await fetch(`${baseUrl(config)}${BALANCE_PATH}`, {
      headers: {
        Authorization: `Bearer ${config.llm.apiKey}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) {
      balanceCache = {at: now, value: fail(`余额接口返回 HTTP ${res.status}`)}
      return balanceCache.value
    }

    const json = (await res.json()) as {
      is_available?: boolean
      balance_infos?: unknown[]
    }
    const infos = (json.balance_infos ?? []).map(toInfo).filter(i => i.currency)
    if (!infos.length) {
      balanceCache = {at: now, value: fail('余额接口没返回数据')}
      return balanceCache.value
    }

    const value: BalanceResult = {
      ok: true,
      available: json.is_available !== false,
      main: infos.find(i => i.currency === 'CNY') ?? infos[0],
      infos,
      error: null,
      fetchedAt: now
    }
    balanceCache = {at: now, value}
    return value
  } catch (e) {
    balanceCache = {
      at: now,
      value: fail(`请求余额失败：${(e as Error).message}`)
    }
    return balanceCache.value
  }
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
