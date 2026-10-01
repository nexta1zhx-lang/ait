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

/** 分析过程中的一步（后端 SSE 推过来） */
export interface AnalyzeStep {
  id: string
  label: string
  state: 'running' | 'done' | 'error'
  detail?: string
  ms?: number
}

export interface AnalyzeResult {
  /** 存档编号；后端落库失败时为 null（分析结果照常返回） */
  analysisId: number | null
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
  /** 这次分析走了哪几步（时间线） */
  steps: AnalyzeStep[]
  meta: {
    model: string
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

/** 开单分析（一次性返回）。周期与假设胜率都用后端配置的默认值。 */
export function analyze(symbol: string) {
  return get<AnalyzeResult>(
    '/api/analyze?' + new URLSearchParams({symbol}).toString()
  )
}

/**
 * 带进度的开单分析（SSE）。
 * 返回值是「取消」函数，组件卸载时调一下，别让 EventSource 自己重连。
 */
export function analyzeStream(
  symbol: string,
  handlers: {
    onStep: (step: AnalyzeStep) => void
    onDone: (result: AnalyzeResult) => void
    onError: (message: string) => void
  }
): () => void {
  const url =
    '/api/analyze/stream?' + new URLSearchParams({symbol}).toString()
  const es = new EventSource(url)
  let finished = false

  const stop = () => {
    finished = true
    es.close()
  }

  const parse = (e: MessageEvent) => {
    try {
      return JSON.parse(e.data)
    } catch {
      return null
    }
  }

  es.addEventListener('step', e => {
    const step = parse(e as MessageEvent) as AnalyzeStep | null
    if (step) handlers.onStep(step)
  })

  es.addEventListener('done', e => {
    const out = parse(e as MessageEvent) as AnalyzeResult | null
    stop()
    if (out) handlers.onDone(out)
    else handlers.onError('分析结果解析失败')
  })

  es.addEventListener('failed', e => {
    const out = parse(e as MessageEvent) as {error?: string} | null
    stop()
    handlers.onError(out?.error ?? '分析失败')
  })

  // 服务端正常结束也会触发 error —— 已经收过 done/failed 就忽略
  es.onerror = () => {
    if (finished) return
    const state = es.readyState
    if (state === EventSource.CLOSED) {
      stop()
      handlers.onError('连接中断，请重试')
      return
    }
    // CONNECTING：浏览器正在自动重连，等一下再看
  }

  return stop
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
}

function usageQs(q: UsageQuery, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams({days: String(q.days)})
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

/* ---------------- 历史存档 ---------------- */

export type OutcomeKind =
  | 'tp1'
  | 'tp2'
  | 'tp3'
  | 'sl'
  | 'breakeven'
  | 'expired'
  | 'skipped'

export const OUTCOME_TEXT: Record<OutcomeKind, string> = {
  tp1: '到 TP1',
  tp2: '到 TP2',
  tp3: '到 TP3',
  sl: '打止损',
  breakeven: '平手离场',
  expired: '到期没触发',
  skipped: '看了没做'
}

/** 结算时算不算「赢」 */
export const OUTCOME_WIN: Record<OutcomeKind, boolean | null> = {
  tp1: true,
  tp2: true,
  tp3: true,
  sl: false,
  breakeven: null,
  expired: null,
  skipped: null
}

export const OUTCOME_TONE: Record<OutcomeKind, string> = {
  tp1: 'ok',
  tp2: 'ok',
  tp3: 'ok',
  sl: 'bad',
  breakeven: 'warn',
  expired: '',
  skipped: 'dim'
}

export interface AnalysisRow {
  id: number
  symbol: string
  exchange: string
  marketType: string
  timeframes: string[]
  grade: string | null
  gradeReason: string | null
  verdict: string | null
  confidence: number | null
  direction: string | null
  price: number | null
  entryPrice: number | null
  entryType: string | null
  stopLoss: number | null
  stopPct: number | null
  tp1Price: number | null
  tp2Price: number | null
  tp3Price: number | null
  rrFinal: number | null
  expectancyR: number | null
  positionQty: number | null
  leverageUsed: number | null
  guardPassed: boolean | null
  veto: string[]
  redLines: string[]
  model: string | null
  rulesHash: string | null
  knowledgeRefs: {symbol: string; timeframe: string; lesson: string}[]
  costUsd: number | null
  latencyMs: number | null
  outcome: OutcomeKind | null
  rMultiple: number | null
  outcomeAt: string | null
  outcomeNote: string | null
  createdAt: string
}

export interface GradeStat {
  grade: string
  calls: number
  goCount: number
  settled: number
  winRate: number | null
  avgR: number | null
  totalR: number | null
}

export interface AnalysisStats {
  total: number
  pending: number
  costUsd: number
  byGrade: GradeStat[]
  bySymbol: {
    symbol: string
    calls: number
    settled: number
    avgR: number | null
  }[]
}

export interface AnalysisDetail extends AnalysisRow {
  ccxtSymbol: string | null
  assumedWinRate: number | null
  verdictReason: string | null
  positionNotional: number | null
  riskAmount: number | null
  chartTimeframe: string | null
  promptTokens: number | null
  completionTokens: number | null
  attempts: number | null
  mfePct: number | null
  maePct: number | null
  outcomePrice: number | null
  result: Judge
  guardrails: Guardrails
  expectancy: Expectancy | null
  snapshot: {
    price?: number
    timeframes?: TfStat[]
    heat?: Heat
    structure?: Structure
  }
  meta: Record<string, unknown>
  rules: {hash: string; sources: string[]; system: string; body: string} | null
}

export interface AnalysisQuery {
  symbol: string
  grade: string
  verdict: string
  actionable: boolean
  pending: boolean
  days: number
  limit: number
  offset: number
}

export interface AnalysisPage {
  rows: AnalysisRow[]
  total: number
  stats: AnalysisStats
  /** 美元 → 人民币汇率，跟用量页共用 */
  rate: number
}

function analysisQs(
  q: AnalysisQuery,
  extra: Record<string, string | number> = {}
) {
  const p = new URLSearchParams({
    days: String(q.days),
    limit: String(q.limit),
    offset: String(q.offset)
  })
  if (q.symbol) p.set('symbol', q.symbol)
  if (q.grade) p.set('grade', q.grade)
  if (q.verdict) p.set('verdict', q.verdict)
  if (q.actionable) p.set('actionable', '1')
  if (q.pending) p.set('pending', '1')
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v))
  return p.toString()
}

export const fetchAnalyses = (
  q: AnalysisQuery,
  opts: {limit?: number; offset?: number} = {}
) =>
  get<AnalysisPage>(
    `/api/analyses?${analysisQs(q, {
      limit: opts.limit ?? q.limit,
      offset: opts.offset ?? q.offset
    })}`
  )

export const fetchAnalysis = (id: number) =>
  get<{analysis: AnalysisDetail}>(`/api/analyses/${id}`)

export const settleAnalysis = (
  id: number,
  body: {
    outcome: OutcomeKind
    price?: number | null
    rMultiple?: number | null
    mfePct?: number | null
    maePct?: number | null
    note?: string | null
  }
) => post<{ok: boolean}>(`/api/analyses/${id}/settle`, body)

export const deleteAnalysis = (id: number) =>
  del<{ok: boolean}>(`/api/analyses/${id}`)
