/**
 * Token 用量与花费计算。
 *
 * 价目表按 DeepSeek 官方页手工维护（单位：美元 / 1M token，取**高峰价**）：
 *   https://api-docs.deepseek.com/quick_start/pricing
 *
 * 高峰时段 = 01:00-04:00 与 06:00-10:00 UTC（周一~周五，中国法定节假日除外），
 * 低谷价是高峰价的一半，这里按下单时刻自动折算。
 *
 * 价格会变。想用自己的数，在 .env 里覆盖：
 *   LLM_PRICE_INPUT_HIT / LLM_PRICE_INPUT_MISS / LLM_PRICE_OUTPUT
 */

export interface ModelPrice {
  /** 输入 · 缓存命中 */
  inputHit: number
  /** 输入 · 缓存未命中 */
  inputMiss: number
  /** 输出 */
  output: number
}

/** 高峰价（美元 / 1M token） */
export const PRICING: Record<string, ModelPrice> = {
  'deepseek-flash': {inputHit: 0.006, inputMiss: 0.3, output: 1.2},
  'deepseek-v4-pro': {inputHit: 0.044, inputMiss: 1.32, output: 3.96}
}

/** 兜底价目：模型不在表里时用它，并在记录里标 assumed=true */
export const FALLBACK_PRICE: ModelPrice = PRICING['deepseek-flash']

/** 历史名 / 供应商写法 → 价目表里的键 */
const ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v3.2': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro'
}

/**
 * 把历史别名（deepseek-chat / deepseek-reasoner 之类）归一到真实模型 id。
 * 归不了的原样返回 —— 用户可能自己在 .env 里写了别的服务商的模型。
 */
export function canonicalModel(id: string): string {
  const m = (id ?? '').trim()
  return ALIASES[m] ?? m
}

/** 这个 id 是不是已知别名（用于提示「你写的其实是 XX」） */
export function isAlias(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALIASES, (id ?? '').trim())
}

export interface PriceLookup {
  price: ModelPrice
  /** 价目表里没有这个模型，用的是兜底价 */
  assumed: boolean
  /** 解析到的价目键 */
  key: string | null
}

function envNum(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 查价：先看 .env 覆盖，再看别名，最后兜底 */
export function priceFor(model: string): PriceLookup {
  const m = String(model || '')
    .trim()
    .toLowerCase()

  const hit = envNum('LLM_PRICE_INPUT_HIT')
  const miss = envNum('LLM_PRICE_INPUT_MISS')
  const out = envNum('LLM_PRICE_OUTPUT')
  if (hit !== null || miss !== null || out !== null) {
    const base = PRICING[ALIASES[m] ?? m] ?? FALLBACK_PRICE
    return {
      price: {
        inputHit: hit ?? base.inputHit,
        inputMiss: miss ?? base.inputMiss,
        output: out ?? base.output
      },
      assumed: false,
      key: '.env'
    }
  }

  const key = ALIASES[m] ?? m
  const found = PRICING[key]
  if (found) return {price: found, assumed: false, key}
  return {price: FALLBACK_PRICE, assumed: true, key: null}
}

/**
 * 是否处于高峰计价时段。
 * 注意：官方还排除了中国法定节假日，这里只按「UTC 周几 + 小时」判断，
 * 节假日的调用会被高估一倍（金额很小，可以接受）。
 */
export function isPeak(at: Date = new Date()): boolean {
  const day = at.getUTCDay() // 0 = 周日
  if (day === 0 || day === 6) return false
  const h = at.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

/* ------------------------------------------------------------------ */
/* Token 用量                                                          */
/* ------------------------------------------------------------------ */

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** DeepSeek 专有：命中前缀缓存的输入 token（便宜几十倍） */
  cacheHitTokens: number
  /** 未命中的输入 token */
  cacheMissTokens: number
  /** 思考模式下的推理 token（一般已含在 completion 里） */
  reasoningTokens: number
}

export function emptyUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0
  }
}

function int(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/**
 * 从接口返回里读出用量。
 * 字段名各家略有出入，缺失的一律按 0 处理，不抛错。
 */
export function readUsage(res: unknown): TokenUsage {
  const r = res as Record<string, unknown> | null
  const u = (r?.usage ?? {}) as Record<string, unknown>

  const promptTokens = int(u.prompt_tokens)
  const completionTokens = int(u.completion_tokens)
  const totalTokens = int(u.total_tokens) || promptTokens + completionTokens

  // DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens
  // OpenAI：prompt_tokens_details.cached_tokens
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>
  let cacheHitTokens =
    int(u.prompt_cache_hit_tokens) || int(details.cached_tokens)
  let cacheMissTokens = int(u.prompt_cache_miss_tokens)

  if (cacheHitTokens + cacheMissTokens === 0 && promptTokens > 0) {
    // 供应商没给明细：全部按未命中算（偏保守，不会少算钱）
    cacheMissTokens = promptTokens
  } else if (cacheMissTokens === 0 && promptTokens > cacheHitTokens) {
    cacheMissTokens = promptTokens - cacheHitTokens
  }

  const completionDetails = (u.completion_tokens_details ?? {}) as Record<
    string,
    unknown
  >
  const reasoningTokens = int(completionDetails.reasoning_tokens)

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens
  }
}

/** 重试场景：把多次调用的用量叠加 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens
  }
}

/* ------------------------------------------------------------------ */
/* 花费                                                                */
/* ------------------------------------------------------------------ */

export interface CostBreakdown {
  costUsd: number
  peak: boolean
  assumed: boolean
  /** 实际使用的单价（美元 / 1M token，已按高峰/低谷折算） */
  price: ModelPrice
}

/** 按用量 + 下单时刻算钱 */
export function costOf(
  model: string,
  usage: TokenUsage,
  at: Date = new Date()
): CostBreakdown {
  const lookup = priceFor(model)
  const peak = isPeak(at)
  const factor = peak ? 1 : 0.5 // 低谷半价
  const price: ModelPrice = {
    inputHit: lookup.price.inputHit * factor,
    inputMiss: lookup.price.inputMiss * factor,
    output: lookup.price.output * factor
  }

  const costUsd =
    (usage.cacheHitTokens * price.inputHit +
      usage.cacheMissTokens * price.inputMiss +
      usage.completionTokens * price.output) /
    1_000_000

  return {
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    peak,
    assumed: lookup.assumed,
    price
  }
}

/** 美元 → 人民币，汇率可用 USD_CNY 覆盖 */
export function usdToCny(usd: number): number {
  const rate = envNum('USD_CNY') ?? 7.1
  return Math.round(usd * rate * 10000) / 10000
}

/* ------------------------------------------------------------------ */
/* 展示                                                                */
/* ------------------------------------------------------------------ */

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$0'
  if (usd === 0) return '$0'
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 1) return '$' + usd.toFixed(4)
  return '$' + usd.toFixed(2)
}

export function formatCny(usd: number): string {
  const cny = usdToCny(usd)
  if (cny === 0) return '¥0'
  if (cny < 0.001) return '<¥0.001'
  if (cny < 1) return '¥' + cny.toFixed(3)
  return '¥' + cny.toFixed(2)
}

export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 一行摘要（人民币在前）：`¥0.009（$0.0012）· 1,820 + 320 tok · 620ms` */
export function oneLineCost(
  usage: TokenUsage,
  costUsd: number,
  latencyMs?: number | null
): string {
  const parts = [
    `${formatCny(costUsd)}（${formatUsd(costUsd)}）`,
    `${formatTokens(usage.promptTokens)} + ${formatTokens(usage.completionTokens)} tok`
  ]
  if (latencyMs != null) parts.push(`${Math.round(latencyMs)}ms`)
  return parts.join(' · ')
}

/** 价目表说明，用于 `npm run cost` 结尾 */
export function pricingTable(): string[] {
  const lines = ['计价基准（美元 / 1M token，高峰价；低谷减半）']
  for (const [name, p] of Object.entries(PRICING)) {
    lines.push(
      `  ${name.padEnd(18)} 输入命中 ${p.inputHit}  输入未命中 ${p.inputMiss}  输出 ${p.output}`
    )
  }
  lines.push(
    `  汇率 USD_CNY = ${envNum('USD_CNY') ?? 7.1}（.env 可改；单价也可用 LLM_PRICE_* 覆盖）`
  )
  return lines
}
