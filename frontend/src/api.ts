/** 所有后端接口的类型与调用 */

/* ---------------- 通用 ---------------- */

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const msg =
      (data as {error?: string} | null)?.error ??
      `请求失败（HTTP ${res.status}）`
    throw new Error(msg)
  }
  return data as T
}

const get = <T>(url: string) => req<T>(url)

const post = <T>(url: string, body: unknown) =>
  req<T>(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  })

const del = <T>(url: string) => req<T>(url, {method: 'DELETE'})

/* ---------------- 配置 / 合约 ---------------- */

export interface RulesInfo {
  sources: string[]
  hash: string
  systemChars: number
  bodyChars: number
  warnings: string[]
}

export interface UsageHeadline {
  todayCalls: number
  todayCostUsd: number
  todayCostCny: number
  allCalls: number
  allCostUsd: number
  allCostCny: number
}

export interface AccountBalance {
  ok: boolean
  available: boolean
  /** 人民币总额（DeepSeek 原生就是 CNY） */
  cny: number | null
  infos: {
    currency: string
    total: number
    granted: number
    toppedUp: number
  }[]
  error: string | null
  cached: boolean
  fetchedAt: string
}

export interface ModelOption {
  id: string
  /** 价目表里有它（否则按兜底价估算） */
  priced: boolean
  price: {inputHit: number; inputMiss: number; output: number}
}

export interface AccountResult {
  provider: string
  baseUrl: string
  hasApiKey: boolean
  mock: boolean
  model: string
  balance: AccountBalance
  models: {
    current: string
    available: ModelOption[]
    fromApi: boolean
    error: string | null
  }
}

export interface AppConfig {
  hasApiKey: boolean
  exchange: string
  marketType: string
  timeframes: string
  model: string
  provider: string
  rules: RulesInfo
  knowledge: {doCount: number; dontCount: number; total: number}
  usage: UsageHeadline
  balance: {
    ok: boolean
    cny: number | null
    available: boolean
    error: string | null
  }
}

export interface Contract {
  base: string
  symbol: string
}

export const fetchConfig = () => get<AppConfig>('/api/config')

/** 余额 + 可用模型 */
export const fetchAccount = (refresh = false) =>
  get<AccountResult>(`/api/account${refresh ? '?refresh=1' : ''}`)

/** 切换模型（写回 .env） */
export const switchModel = (model: string) =>
  post<{
    ok: boolean
    model: string
    persisted: boolean
    warning: string | null
  }>('/api/account/model', {model})

export const fetchContracts = () =>
  get<{contracts: Contract[]; error?: string}>('/api/contracts')

/* ---------------- 行情 ---------------- */

export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface LevelSR {
  resistance: number | null
  support: number | null
}

export const fetchCandles = (symbol: string, timeframe: string, limit = 300) =>
  get<{candles: Candle[]; sr: LevelSR | null}>(
    `/api/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`
  )

/* ---------------- 分析 ---------------- */

export interface Structure {
  higherHighs: boolean
  higherLows: boolean
  lowerHighs: boolean
  lowerLows: boolean
  swingHigh: number
  swingLow: number
}

export interface TfStat {
  timeframe: string
  close: number
  trend: 'up' | 'down' | 'range'
  netChangePct: number
  rangePct: number
  volRatio: number
  structure: Structure
}

export interface Heat {
  fundingRate: number | null
  openInterest: number | null
  openInterestChangePct: number | null
  quoteVolume24h: number | null
  change24hPct: number | null
  amplitude24hPct: number | null
  longShortRatio: number | null
  high24h: number | null
  low24h: number | null
}

export interface ChecklistItem {
  item: string
  status: 'pass' | 'fail' | 'warn'
  evidence: string
}

export interface TakeProfit {
  label: string
  price: number
  r: number
  reducePercent: number
}

export interface Judge {
  grade: 'A' | 'B' | 'C' | 'unclear'
  gradeReason: string
  verdict: 'go' | 'wait' | 'no_go'
  confidence: number
  direction: 'long' | 'short' | 'none'
  entry: {type: 'market' | 'limit'; price: number | null}
  stopLoss: number | null
  takeProfits: TakeProfit[]
  checklist: ChecklistItem[]
  failedCritical: string[]
  verdictReason: string
  exitTriggers: string[]
  knowledgeRefs: {symbol: string; timeframe: string; lesson: string}[]
  coachLine: string
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

export interface Guardrails {
  passed: boolean
  violations: {id: string; desc: string; severity: string}[]
  checks: {name: string; pass: boolean; detail: string}[]
  position: PositionPlan | null
  minRr: number
}

export interface Expectancy {
  winRate: number
  weightedR: number
  expectancyR: number
  positive: boolean
}

export interface AnalyzeResult {
  symbol: string
  exchange: string
  price: number
  heat: Heat
  change24hPct: number | null
  fundingRate: number | null
  structure: Structure
  timeframes: TfStat[]
  judge: Judge
  guardrails: Guardrails
  expectancy: Expectancy | null
  meta: {
    model: string
    mock: boolean
    warning: string | null
    knowledgeUsed: boolean
    usage: {
      callId: number | null
      totalTokens: number
      costUsd: number
      costCny: number
      attempts: number
      latencyMs: number
      text: string
    }
  }
}

/** 开单分析。周期与假设胜率都用后端配置的默认值。 */
export function analyze(opts: {symbol: string; mock: boolean}) {
  const p = new URLSearchParams({
    symbol: opts.symbol,
    mock: opts.mock ? '1' : '0'
  })
  return get<AnalyzeResult>('/api/analyze?' + p.toString())
}

/* ---------------- 知识库 ---------------- */

export interface KnowledgeBrief {
  id: number
  symbol: string
  timeframe: string
  label: 'do' | 'dont'
  grade: 'A' | 'B' | 'C' | null
  title: string
  note: string
  lesson: string
  createdAt: string
}

export interface CollectResult {
  caseId: number | null
  symbol: string
  timeframe: string
  label: 'do' | 'dont'
  grade: 'A' | 'B' | 'C'
  title: string
  lesson: string
  features: {pre?: string; rally?: string; post?: string; heat?: string}
  whatWorked: string
  rallyMeta: {
    changePct: number
    bars: number
    atrMultiple: number
    volMultiple: number | null
  }
  window: {start: string; end: string; bars: number}
  rallyFrom: number
  rallyTo: number
  candleCount: number
  meta: {
    model: string
    mock: boolean
    warning: string | null
    usage: {
      totalTokens: number
      costUsd: number
      costCny: number
      attempts: number
      latencyMs: number
      text: string
    }
  }
}

export const listCases = (label: string) =>
  get<{cases: KnowledgeBrief[]; total: number}>(
    `/api/knowledge?label=${encodeURIComponent(label)}`
  )

export const collectCase = (body: Record<string, unknown>) =>
  post<CollectResult>('/api/knowledge', body)

export const deleteCase = (id: number) =>
  del<{ok: boolean}>(`/api/knowledge/${id}`)

/* ---------------- 用量 ---------------- */

export interface UsageTotals {
  calls: number
  mockCalls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  costUsd: number
}

export interface UsageBucket extends UsageTotals {
  key: string
  label: string
}

export interface UsageRow {
  id: number
  kind: string
  model: string
  symbol: string | null
  timeframe: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  costUsd: number
  mock: boolean
  attempts: number
  latencyMs: number | null
  createdAt: string
}

export interface Money {
  calls: number
  costUsd: number
  costCny: number
}

export interface UsageSummary {
  days: number
  rate: number
  totals: UsageTotals
  byDay: UsageBucket[]
  byKind: UsageBucket[]
  byModel: UsageBucket[]
  recent: UsageRow[]
  today: Money
  allTime: Money
}

export interface UsageCallPage {
  rows: UsageRow[]
  total: number
  limit: number
  offset: number
}

export interface UsageQuery {
  days: number
  kind: '' | 'judge' | 'extract'
  realOnly: boolean
}

function usageQs(q: UsageQuery, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams({
    days: String(q.days),
    realOnly: q.realOnly ? '1' : '0'
  })
  if (q.kind) p.set('kind', q.kind)
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v))
  return p.toString()
}

export const KIND_TEXT: Record<string, string> = {
  judge: '开单分析',
  extract: '案例提炼'
}

export const fetchUsageSummary = (q: UsageQuery, recent = 10) =>
  get<UsageSummary>(`/api/usage/summary?${usageQs(q, {recent})}`)

export const fetchUsageCalls = (
  q: UsageQuery,
  opts: {limit?: number; offset?: number} = {}
) =>
  get<UsageCallPage>(
    `/api/usage/calls?${usageQs(q, {
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0
    })}`
  )
