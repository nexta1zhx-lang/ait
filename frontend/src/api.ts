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

const patchReq = <T>(url: string, body: unknown) =>
  req<T>(url, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  })

const put = <T>(url: string, body: unknown) =>
  req<T>(url, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  })

/* ---------------- 配置 / 合约 ---------------- */

export interface RulesInfo {
  /** 参与这次判断的文档名（如「角色：主提示词」） */
  sources: string[]
  hash: string
  /** 角色设定字数 */
  systemChars: number
  /** 规则正文字数 */
  bodyChars: number
  /** 本次是否真的把角色/规则发给了模型 */
  bodyEnabled?: boolean
  /** db = 库里有启用的文档；documents = 库里没有 */
  origin?: 'db' | 'documents'
  updatedAt?: string | null
  warnings: string[]
}

/* ---------------- AI 提示词文档（存数据库） ---------------- */

/**
 * role = 开单分析的角色设定；rule = 规则正文；
 * extract = 知识库提炼（收录案例时用的那份）
 */
export type DocKind = 'role' | 'rule' | 'extract' | 'predict'

export interface AiDoc {
  id: number
  kind: DocKind
  name: string
  content: string
  enabled: boolean
  sort: number
  updatedAt: string
}

export interface AiDocVersion {
  id: number
  docId: number
  name: string
  kind: DocKind
  chars: number
  savedAt: string
}

/** 拼 prompt 的概览 —— 页面顶部那条「这次会发什么」 */
export interface AiAssembly {
  enabled: boolean
  origin: 'db' | 'documents'
  sources: string[]
  hash: string
  /** 分析预测那份的字数（就这一份） */
  predictChars: number
  /** 知识库提炼那份（跟分析不是一条链路，单独报） */
  extractChars: number
  extractSources: string[]
  extractHash: string
  updatedAt: string | null
  warnings: string[]
}

export const fetchAiDocs = () =>
  get<{docs: AiDoc[]; assembly: AiAssembly}>('/api/ai-docs')

export const createAiDoc = (input: {
  kind: DocKind
  name: string
  content?: string
}) => post<{doc: AiDoc}>('/api/ai-docs', input)

export const updateAiDoc = (
  id: number,
  patch: {
    kind?: DocKind
    name?: string
    content?: string
    enabled?: boolean
    sort?: number
  }
) => put<{doc: AiDoc}>(`/api/ai-docs/${id}`, patch)

export const deleteAiDoc = (id: number) => del<{ok: true}>(`/api/ai-docs/${id}`)

export const fetchAiVersions = (id: number) =>
  get<{versions: AiDocVersion[]}>(`/api/ai-docs/${id}/versions`)

export const fetchAiVersion = (versionId: number) =>
  get<{version: AiDocVersion & {content: string}}>(
    `/api/ai-versions/${versionId}`
  )

export const restoreAiVersion = (versionId: number) =>
  post<{doc: AiDoc}>(`/api/ai-versions/${versionId}/restore`, {})

/** 看这次真正发出去的 system prompt（`kind='extract'` 看知识库提炼那份） */
export const fetchAiPreview = (kind?: 'extract') =>
  get<{system: string; enabled: boolean; sources: string[]; hash: string}>(
    kind ? `/api/ai-preview?kind=${kind}` : '/api/ai-preview'
  )

export interface UsageHeadline {
  todayCalls: number
  todayCostUsd: number
  todayCostCny: number
  allCalls: number
  allCostUsd: number
  allCostCny: number
}

export interface ModelOption {
  id: string
  /** 价目表里有它（否则按兜底价估算） */
  priced: boolean
  price: {inputHit: number; inputMiss: number; output: number}
}

/** 账户余额已于 2026-10-02 删除，这里只剩「切模型」 */
/** 一个币种的余额（DeepSeek 可能同时返回 CNY / USD） */
export interface BalanceInfo {
  currency: string
  totalBalance: number
  grantedBalance: number
  toppedUpBalance: number
}

export interface BalanceResult {
  ok: boolean
  available: boolean
  /** 首选币种（有 CNY 就用 CNY） */
  main: BalanceInfo | null
  infos: BalanceInfo[]
  error: string | null
  fetchedAt: number
}

export interface AccountResult {
  provider: string
  baseUrl: string
  hasApiKey: boolean
  model: string
  models: {
    current: string
    available: ModelOption[]
    fromApi: boolean
    error: string | null
  }
  /** 模型账户还剩多少钱（拉不到时 ok=false，error 里有原因） */
  balance: BalanceResult
}

export interface AppConfig {
  hasApiKey: boolean
  exchange: string
  marketType: string
  timeframes: string
  /** 回溯天数：默认值 + 允许范围（查询栏那个输入框用） */
  lookback: {days: number; min: number; max: number}
  model: string
  provider: string
  rules: RulesInfo
  knowledge: {total: number}
  usage: UsageHeadline
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

/**
 * 拉 K 线。
 *
 * 不给 `range` 就是「最近 limit 根」；给了 `range` 就按时间段取
 * （只影响画哪一段，不影响分析用的数据）。
 */
export const fetchCandles = (
  symbol: string,
  timeframe: string,
  limit = 300,
  range?: {from?: number; to?: number}
) => {
  const qs = new URLSearchParams({symbol, timeframe, limit: String(limit)})
  if (range?.from) qs.set('from', String(range.from))
  if (range?.to) qs.set('to', String(range.to))
  return get<{candles: Candle[]; sr: LevelSR | null; ranged?: boolean}>(
    `/api/candles?${qs}`
  )
}

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
  /** 量比：最新一根成交量 / 近 20 根均量 */
  volRatio: number
  /**
   * 量能水平：近 20 根均量 ÷ 更早那一段的均量。
   * >1 放量、<1 缩量 —— 判断「弱势 = 成交量低」看它，量比只管最新一根。
   */
  volTrend: number
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

/**
 * 判档：A 顺势单 / A-W 顺势双底 / S 突破 / V 超跌极速V反 / B 不该做 / unclear 说不清
 *
 * ⚠️ 已废弃：不再判档了（改成预测 + 标签概率）。
 * 老记录里还有这些值，历史页读回来要能显示，类型先留着。
 */
export type Grade = 'A' | 'A-W' | 'S' | 'V' | 'B' | 'unclear'

/** 形状标签 + 它现在有多成立 */
export interface JudgeTag {
  name: string
  /** 0~100 */
  probability: number
}

/**
 * AI 的判断结果 —— **只有这六个字段**。
 *
 * 2026-10-02 改成「预测」：不再判档，改成预测接下来最大概率的走法，
 * 同时给每个形状标签一个概率。
 */
export interface Judge {
  /** 形状标签，按概率从高到低（最多 4 个；池子里没有的会新造） */
  tags: JudgeTag[]
  /** 为什么这么看，要落到具体数据上 */
  reason: string
  /** 接下来最大概率会走成什么样（方向和节奏） */
  outlook: string
  /** 上面那个走势的概率，0~100 */
  probability: number
  verdict: 'go' | 'wait' | 'no_go'
  /** 推荐怎么做：现在做什么、什么条件下动手、什么条件下不碰 */
  recommendation: string
}

/** 一个周期的行情（后端把 K 线切成小段读出来的文字） */
export interface SeriesBlock {
  timeframe: string
  /** 是不是我在图上看的那个周期 */
  primary: boolean
  /** 这个周期取了多少天；null = 按「图上那段」换算 */
  days: number | null
  bars: number
  from: string
  to: string
  /** 切段读出来的行情文字 */
  text: string
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
  /** 是不是「回到某一刻」的测试跑（测试跑不存档） */
  testMode: boolean
  /** 测试跑的时间点（毫秒）；实时跑是 null */
  at: number | null
  price: number
  heat: Heat
  change24hPct: number | null
  fundingRate: number | null
  /** 主周期 = 我在图上看的那个 */
  primary: string
  /** 各周期行情：主周期 + 跟着取的辅助周期 */
  blocks: SeriesBlock[]
  /** 本次主周期回溯多少天 */
  days: number
  judge: Judge
  /** 这次分析走了哪几步（时间线） */
  steps: AnalyzeStep[]
  meta: {
    model: string
    /** 本次用的规则文件（版本 hash 会写进结论卡片） */
    rules: {sources: string[]; hash: string; warnings: string[]}
    /** 本次给了多少个可用标签 */
    tagCount: number
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

/** 开单分析（一次性返回）。周期与回溯天数用后端配置的默认值。 */
export function analyze(symbol: string, days?: number, at?: number | null) {
  const q = new URLSearchParams({symbol})
  if (days) q.set('days', String(days))
  if (at) q.set('at', String(at))
  return get<AnalyzeResult>('/api/analyze?' + q.toString())
}

/**
 * 带进度的开单分析（SSE）。
 *
 * `opts.at` 给了就是**测试跑**：后端只看得见那一刻之前已收盘的 K 线，
 * 实时类字段（资金费率 / 持仓量 / 多空比）全部置空，而且不存档。
 * 返回值是「取消」函数，组件卸载时调一下，别让 EventSource 自己重连。
 */
export function analyzeStream(
  symbol: string,
  opts: {days?: number; timeframe?: string; at?: number | null},
  handlers: {
    onStep: (step: AnalyzeStep) => void
    onDone: (result: AnalyzeResult) => void
    onError: (message: string) => void
  }
): () => void {
  const q = new URLSearchParams({symbol})
  if (opts.days) q.set('days', String(opts.days))
  // 主周期 = 图上那个；不传的话后端会用配置里的第一个周期（会跟图上不一致）
  if (opts.timeframe) q.set('timeframe', opts.timeframe)
  if (opts.at) q.set('at', String(opts.at))
  const url = '/api/analyze/stream?' + q.toString()
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

export interface KnowledgeCase {
  id: number
  symbol: string
  timeframe: string
  /** @deprecated 已经不再分「该做 / 不该做」，新记录为 null */
  label: 'do' | 'dont' | null
  /** @deprecated 旧字段，新记录不再写（以前让 AI 套我的 A/B/C 档） */
  grade: 'A' | 'B' | 'C' | null
  /** 拉升 / 下跌 / 横盘 */
  moveType: MoveType | null
  /** 我从卡片上打的标签（只能从模板里挑） */
  tags: string[]
  title: string
  /** 为什么会走成这样 */
  why: string
  note: string
  lesson: string
  windowStart: string
  windowEnd: string
  /** 拉升段在 candles 里的下标（列表接口会现算填上） */
  rallyFrom: number | null
  rallyTo: number | null
  /** 拉升段涨幅%（现算） */
  rallyPct?: number | null
  /** 整段行情的客观统计 */
  stats: CaseStats | null
  /** 只有请求时带 candles=1 才有内容 */
  candles: Candle[]
  createdAt: string
}

/** 这段行情是什么 */
export type MoveType = 'up' | 'down' | 'range'

export interface CaseStats {
  bars?: number
  changePct?: number
  rangePct?: number
  maxDrawdownPct?: number
  highAtPct?: number
  lowAtPct?: number
  volTrend?: number | null
  /** 旧字段，兼容老记录 */
  atrMultiple?: number
}

export interface CollectResult {
  caseId: number | null
  symbol: string
  timeframe: string
  /** @deprecated 已经不再分「该做 / 不该做」，固定为 null */
  label: 'do' | 'dont' | null
  moveType: MoveType
  title: string
  /** 为什么会走成这样 */
  why: string
  lesson: string
  features: {structure?: string; volume?: string; rhythm?: string}
  /** AI 从模板里挑的标签 */
  tags: string[]
  /** 可选的标签模板（弹窗里点这些） */
  tagTemplates: string[]
  stats: CaseStats
  window: {start: string; end: string; bars: number}
  /** 这次走了哪几步 */
  steps: AnalyzeStep[]
  candleCount: number
  meta: {
    model: string
    warning: string | null
    /** 喂给 AI 的行情文字一共多少字 */
    promptChars: number
    /** 复盘时一并喂进去的 4H / 日线压力支撑 */
    sr: {timeframe: string; bars: number; resistance: number; support: number}[]
    /** 喂给模型的输入原文 */
    prompt: string
    /** 模型原样返回的内容 */
    raw: string
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

export interface ListCasesParams {
  label?: 'all' | 'do' | 'dont'
  /** 'none' = 还没判走势类型的 */
  moveType?: MoveType | 'all' | 'none'
  /** 只要带这个标签的 */
  tag?: string
  symbol?: string
  q?: string
  /** 卡片要画迷你图时打开 */
  candles?: boolean
}

export const listCases = (p: ListCasesParams = {}) => {
  const qs = new URLSearchParams()
  if (p.label && p.label !== 'all') qs.set('label', p.label)
  if (p.moveType && p.moveType !== 'all') qs.set('moveType', p.moveType)
  if (p.tag) qs.set('tag', p.tag)
  if (p.symbol) qs.set('symbol', p.symbol)
  if (p.q) qs.set('q', p.q)
  if (p.candles) qs.set('candles', '1')
  return get<{cases: KnowledgeCase[]; total: number}>(`/api/knowledge?${qs}`)
}

/** 一个标签模板（我自己维护的清单里的一项） */
export interface TagTemplate {
  id: number
  name: string
  sort: number
  /** 有几条案例正在用这个标签 */
  n: number
}

/** 标签模板清单 + 已用统计 + 老记录里那些不在模板里的标签 */
export const fetchTags = () =>
  get<{
    tags: {tag: string; n: number}[]
    templates: TagTemplate[]
    legacy: string[]
  }>('/api/knowledge/tags')

export const addTagTemplate = (name: string) =>
  post<TagTemplate>('/api/tag-templates', {name})

export const renameTagTemplate = (id: number, name: string) =>
  put<TagTemplate>(`/api/tag-templates/${id}`, {name})

export const deleteTagTemplate = (id: number) =>
  del<{ok: boolean}>(`/api/tag-templates/${id}`)

export const moveTagTemplate = (id: number, dir: 'up' | 'down') =>
  post<{ok: boolean}>(`/api/tag-templates/${id}/move`, {dir})

export const collectCase = (body: Record<string, unknown>) =>
  post<CollectResult>('/api/knowledge', body)

/** 收录一个案例（取哪个时间段的参数） */
export interface CollectParams {
  symbol: string
  timeframe: string
  note?: string
  /** 点选一个时间点 → 以它为中心前后各拉 N 根 */
  center?: number
  aroundBars?: number
  /** 在图上画的范围 */
  from?: number
  to?: number
  /** 画的范围原样用，前后不补 */
  exact?: boolean
}

/**
 * 带进度的案例提炼（SSE）。
 * 跟开单分析一样，一路上推 `step`，最后推 `done`。
 * 返回值是「取消」函数。
 */
export function collectStream(
  params: CollectParams,
  handlers: {
    onStep: (step: AnalyzeStep) => void
    onDone: (result: CollectResult) => void
    onError: (message: string) => void
  }
): () => void {
  const qs = new URLSearchParams({symbol: params.symbol})
  qs.set('timeframe', params.timeframe)
  if (params.note) qs.set('note', params.note)
  if (params.center) qs.set('center', String(params.center))
  if (params.aroundBars) qs.set('aroundBars', String(params.aroundBars))
  if (params.from && params.to) {
    qs.set('from', String(params.from))
    qs.set('to', String(params.to))
  }
  if (params.exact) qs.set('exact', '1')

  const es = new EventSource('/api/knowledge/stream?' + qs.toString())
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
    const out = parse(e as MessageEvent) as CollectResult | null
    stop()
    if (out) handlers.onDone(out)
    else handlers.onError('提炼结果解析失败')
  })
  es.addEventListener('failed', e => {
    const out = parse(e as MessageEvent) as {error?: string} | null
    stop()
    handlers.onError(out?.error ?? '提炼失败')
  })
  es.onerror = () => {
    if (finished) return
    if (es.readyState === EventSource.CLOSED) {
      stop()
      handlers.onError('连接中断，请重试')
    }
  }

  return stop
}

/** 只改文案，K 线不动 */
export const updateCase = (id: number, patch: Record<string, unknown>) =>
  patchReq<{ok: boolean}>(`/api/knowledge/${id}`, patch)

/** 用库里存下的 K 线重跑一次 AI 提炼 */
export const reeditCase = (id: number, body: Record<string, unknown> = {}) =>
  post<CollectResult>(`/api/knowledge/${id}/reedit`, body)

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

/**
 * 一次分析的存档行（列表用）。
 *
 * 2026-10-02 大简化后，「事后结算」（outcome / R 倍数 / MFE / MAE）已删除：
 * 没有止损止盈就没有 R 可算。表里那几列还留着（老记录要能读），新记录一律 null。
 */
export interface AnalysisRow {
  id: number
  symbol: string
  exchange: string
  marketType: string
  timeframes: string[]
  grade: string | null
  /** 现在存的就是 AI 那段 reason */
  gradeReason: string | null
  /** 形状标签 + 概率（新记录才有；老记录是 [] 或老结构） */
  tags: JudgeTag[]
  verdict: string | null
  price: number | null
  model: string | null
  rulesHash: string | null
  costUsd: number | null
  latencyMs: number | null
  createdAt: string
}

export interface GradeStat {
  grade: string
  calls: number
  /** 其中给了「可做」的次数 */
  goCount: number
}

/** 一个形状标签在这段时间里出现了多少次、平均概率多少 */
export interface TagStat {
  name: string
  calls: number
  /** 平均概率 0~100；老记录没有概率就是 null */
  avgProbability: number | null
}

export interface AnalysisStats {
  total: number
  costUsd: number
  /** 标签分布（老档位统计已废弃） */
  byTag: TagStat[]
  bySymbol: {symbol: string; calls: number}[]
}

/**
 * AI 的原始输出（历史详情用）。
 *
 * 新记录 = 六个字段（tags / reason / outlook / probability / verdict /
 * recommendation）；老记录是旧结构（字段多得多，tags 还只是字符串数组），
 * 所以这里用宽松类型，展示前统一过一遍 `tagsOf()`。
 */
export type JudgeResultLike = Record<string, unknown>

/**
 * 从 result 里安全地把标签取成 `{name, probability}` ——
 * 老记录的 tags 是纯字符串数组，这里补一个默认概率（0，页面上不显示百分比）。
 */
export function tagsOf(result: JudgeResultLike | null | undefined): JudgeTag[] {
  const t = result?.tags
  if (!Array.isArray(t)) return []
  const out: JudgeTag[] = []
  for (const x of t) {
    if (typeof x === 'string') {
      if (x.trim()) out.push({name: x.trim(), probability: 0})
    } else if (x && typeof x === 'object') {
      const o = x as {name?: unknown; probability?: unknown}
      const name = String(o.name ?? '').trim()
      if (!name) continue
      const p = Math.round(Number(o.probability))
      out.push({name, probability: Number.isFinite(p) ? p : 0})
    }
  }
  return out
}

export interface AnalysisDetail extends AnalysisRow {
  ccxtSymbol: string | null
  chartTimeframe: string | null
  promptTokens: number | null
  completionTokens: number | null
  attempts: number | null
  /** 老记录才有（新记录把 reason 存在 gradeReason 列） */
  verdictReason: string | null
  result: JudgeResultLike | null
  snapshot: {
    price?: number
    timeframes?: TfStat[]
    heat?: Heat
    structure?: Structure
  }
  meta: Record<string, unknown>
  rules: {
    hash: string
    sources: string[]
    system: string
    body: string
  } | null
}

export interface AnalysisQuery {
  symbol: string
  grade: string
  verdict: string
  /** 只看打了这个形状标签的（空 = 全部） */
  tag: string
  actionable: boolean
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
  if (q.tag) p.set('tag', q.tag)
  if (q.actionable) p.set('actionable', '1')
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

export const deleteAnalysis = (id: number) =>
  del<{ok: boolean}>(`/api/analyses/${id}`)
