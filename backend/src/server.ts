#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {loadConfig, ROOT_DIR} from './config'
import {loadContracts} from './contracts'
import {loadRules} from './rules'
import {checkDb, closePool, dbHelpMessage, ensureSchema, query} from './db/client'
import {
  CaseLabel,
  deleteCase,
  getCase,
  lessonsByGrade,
  listCases
} from './db/knowledge'
import {recordUsage, usageCalls, usageHeadline, usageSummary} from './db/usage'
import {
  OUTCOME_LABEL,
  analysisStats,
  deleteAnalysis,
  getAnalysis,
  listAnalyses,
  saveAnalysis,
  saveRulesVersion,
  settleAnalysis,
  type OutcomeKind
} from './db/analyses'
import {oneLineCost, usdToCny} from './llm/pricing'
import {
  clearBalanceCache,
  fetchBalance,
  fetchModels,
  type ModelsResult
} from './llm/account'
import {writeEnvVar} from './util/envfile'
import {hasBuiltFrontend, mountViteDev, type ViteDev} from './devtools/vite-dev'
import {collectCase} from './knowledge-service'
import {computeRecentSR, fetchCandles, fetchSnapshot} from './data/market'
import {buildContext} from './context/builder'
import {DEFAULT_WIN_RATE, expectancyOf} from './analysis/expectancy'
import {judge, toDecision, type JudgeMeta, type JudgeResult} from './llm/client'
import {validate} from './guardrails/validator'
import {
  Candle,
  Expectancy,
  GuardrailResult,
  LlmDecision,
  MarketSnapshot,
  MarketType,
  Timeframe
} from './types'

const PORT = Number(process.env.PORT || 8787)
/** 前端构建产物（npm run ui:build 生成） */
const PUBLIC_DIR = path.join(ROOT_DIR, 'frontend', 'dist')
const VALID_TFS: Timeframe[] = ['5m', '15m', '1h', '4h', '1d']

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

/** Vite 产物带内容哈希，可以长期缓存 */
const HASHED_ASSET = /-[\w-]{8,}\.(js|css|woff2)$/

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

/** 所有响应都带上，前端独立部署也能调 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS
  })
  res.end(JSON.stringify(data))
}

/** 托管前端（Vue3 SPA 的构建产物） */
function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const rel =
    urlPath === '/'
      ? 'index.html'
      : decodeURIComponent(urlPath).replace(/^\/+/, '')
  const safeRel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '')
  let filePath = path.join(PUBLIC_DIR, safeRel)

  // 目录 → 目录下的 index.html
  if (
    filePath.startsWith(PUBLIC_DIR) &&
    fs.existsSync(filePath) &&
    fs.statSync(filePath).isDirectory()
  ) {
    filePath = path.join(filePath, 'index.html')
  }

  // 真实文件就直接发
  if (
    filePath.startsWith(PUBLIC_DIR) &&
    fs.existsSync(filePath) &&
    fs.statSync(filePath).isFile()
  ) {
    res.writeHead(200, {
      'Content-Type':
        MIME[path.extname(filePath).toLowerCase()] ??
        'application/octet-stream',
      'Cache-Control': HASHED_ASSET.test(safeRel)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
    })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  // 其余路径交给前端路由（/knowledge、/usage …），刷新也能打开
  const indexHtml = path.join(PUBLIC_DIR, 'index.html')
  if (fs.existsSync(indexHtml)) {
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-cache'
    })
    fs.createReadStream(indexHtml).pipe(res)
    return
  }

  res.writeHead(404, {
    'Content-Type': MIME['.html'],
    'Cache-Control': 'no-store'
  })
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>前端还没构建</title>
<style>
  body{margin:0;padding:48px 24px;background:#0d1117;color:#e6edf3;
       font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.9}
  main{max-width:660px;margin:0 auto}
  h1{font-size:20px;margin:0 0 12px}
  code{background:#1c2230;padding:2px 8px;border-radius:6px;
       font-family:ui-monospace,Menlo,monospace;font-size:13px}
  ol{padding-left:22px}
  li{margin:8px 0}
  a{color:#42a5f5}
  .dim{color:#8b949e;font-size:13px}
</style></head><body><main>
<h1>前端还没构建</h1>
<p>后端已经起来了，但 <code>frontend/dist</code> 是空的。两种做法：</p>
<ol>
  <li><b>只想用页面</b>：跑 <code>npm run ui:build</code>，然后刷新。</li>
  <li><b>要改前端</b>：另开一个终端跑 <code>npm run ui:dev</code>，
      访问 <a href="http://localhost:5173">http://localhost:5173</a>
      <span class="dim">（热更新，改完不用重新构建）</span></li>
</ol>
<p class="dim">API 本身是好的，可以直接请求
  <a href="/api/health">/api/health</a> · <a href="/api/config">/api/config</a> ·
  <a href="/api/account">/api/account</a></p>
</main></body></html>`)
}

function readJsonBody(
  req: http.IncomingMessage,
  limitBytes = 32 * 1024 * 1024
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const obj = JSON.parse(raw)
        resolve(obj && typeof obj === 'object' ? obj : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function fail(res: http.ServerResponse, tag: string, e: unknown): void {
  const err = e as Error
  console.error(`[${tag}]`, err.message)
  const code = (e as {code?: string})?.code
  const isDb =
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === '28P01' ||
    code === '3D000' ||
    code === 'ETIMEDOUT'
  if (isDb) {
    sendJson(res, 503, {error: dbHelpMessage(e), dbDown: true})
    return
  }
  sendJson(res, 500, {error: err.message})
}

/* ------------------------------------------------------------------ */
/* 行情 / 图表                                                         */
/* ------------------------------------------------------------------ */

async function handleCandles(
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const q = url.searchParams
  const symbol = (q.get('symbol') ?? '').trim().toUpperCase()
  if (!symbol) {
    sendJson(res, 400, {error: '请先选择币种'})
    return
  }
  const marketParam = q.get('market')
  const market =
    marketParam && ['spot', 'swap', 'coinm'].includes(marketParam)
      ? (marketParam as MarketType)
      : undefined

  const tfParam = (q.get('timeframe') ?? '1h') as Timeframe
  const timeframe = (VALID_TFS as string[]).includes(tfParam) ? tfParam : '1h'
  const limit = Math.min(1000, Math.max(50, Number(q.get('limit')) || 300))
  const config = loadConfig({marketType: market})

  const [candles, h1] = await Promise.all([
    fetchCandles({
      exchangeId: config.exchange,
      symbol,
      timeframe,
      limit,
      marketType: config.marketType,
      apiBase: config.apiBase
    }),
    timeframe === '1h'
      ? Promise.resolve<Candle[]>([])
      : fetchCandles({
          exchangeId: config.exchange,
          symbol,
          timeframe: '1h',
          limit: 8,
          marketType: config.marketType,
          apiBase: config.apiBase
        })
  ])

  const srSource = timeframe === '1h' ? candles : h1
  sendJson(res, 200, {
    symbol,
    timeframe,
    candles,
    sr: computeRecentSR(srSource, 4)
  })
}

/* ------------------------------------------------------------------ */
/* 开单分析                                                            */
/* ------------------------------------------------------------------ */

/** `BTC/USDT:USDT` → `BTC`（跟知识库里的写法保持一致） */
function baseSymbol(ccxtSymbol: string): string {
  return (
    ccxtSymbol
      .split('/')[0]
      ?.replace(/:[^:]*$/, '')
      .toUpperCase() ?? ccxtSymbol
  )
}

/** 分析过程中的一步，用于前端「分析过程」时间线 */
export interface AnalyzeStep {
  /** 稳定 id，前端拿来匹配 */
  id: string
  /** 显示文案 */
  label: string
  state: 'running' | 'done' | 'error'
  /** 这一步的补充说明（周期、K 线数、token、耗时…） */
  detail?: string
  /** 这一步花了多少毫秒 */
  ms?: number
}

type OnStep = (step: AnalyzeStep) => void

export interface AnalyzeOutcome {
  analysisId: number | null
  symbol: string
  ccxtSymbol: string
  exchange: string
  marketType: string
  price: number
  heat: MarketSnapshot['heat']
  change24hPct: number | null
  fundingRate: number | null
  openInterest: number | null
  structure: MarketSnapshot['structure']
  timeframes: MarketSnapshot['timeframes']
  series: MarketSnapshot['series']
  judge: JudgeResult
  guardrails: GuardrailResult
  expectancy: Expectancy | null
  /** 本次分析走了哪几步（前端画时间线） */
  steps: AnalyzeStep[]
  meta: {
    model: string
    rules: {sources: string[]; hash: string; warnings: string[]}
    knowledgeUsed: boolean
    usage: {
      callId: number | null
      promptTokens: number
      completionTokens: number
      totalTokens: number
      cacheHitTokens: number
      costUsd: number
      costCny: number
      attempts: number
      latencyMs: number
      text: string
    }
  }
}

function parseTimeframes(raw: string | null): Timeframe[] {
  const fallback = loadConfig().timeframes
  const list = (raw ? raw.split(',') : fallback)
    .map(x => x.trim())
    .filter((x): x is Timeframe => (VALID_TFS as string[]).includes(x))
  if (list.length > 0) return list
  return fallback.length ? fallback : ['1h', '4h', '1d']
}

/** 读 query 里的 symbol / market / timeframes / winRate */
function analyzeParams(q: URLSearchParams): {
  symbol: string
  market?: MarketType
  timeframes: Timeframe[]
  winRate: number
} {
  const marketParam = q.get('market')
  return {
    symbol: (q.get('symbol') ?? '').trim().toUpperCase(),
    market:
      marketParam && ['spot', 'swap', 'coinm'].includes(marketParam)
        ? (marketParam as MarketType)
        : undefined,
    timeframes: parseTimeframes(q.get('timeframes')),
    // 期望值用的假设胜率。页面不暴露这个输入，用默认值；显式传参仍然有效
    winRate: Math.min(
      1,
      Math.max(0.01, Number(q.get('winRate')) || DEFAULT_WIN_RATE)
    )
  }
}

/**
 * 一次分析的全过程。
 * 网页（JSON）、网页（SSE 进度）、命令行都走这里，避免几份实现各写一遍。
 */
async function runAnalysis(opts: {
  symbol: string
  market?: MarketType
  timeframes: Timeframe[]
  winRate: number
  onStep?: OnStep
}): Promise<AnalyzeOutcome> {
  const {symbol: symbolInput, market, timeframes, winRate} = opts
  const onStep: OnStep = opts.onStep ?? (() => {})
  const steps: AnalyzeStep[] = []

  /** 开一步 → 返回「收尾」函数（自动算耗时并置为 done） */
  const step = (id: string, label: string) => {
    const startedAt = Date.now()
    const rec: AnalyzeStep = {id, label, state: 'running' as const}
    steps.push(rec)
    onStep({...rec})
    return (detail?: string) => {
      rec.state = 'done'
      rec.detail = detail
      rec.ms = Date.now() - startedAt
      onStep({...rec})
    }
  }

  /** 某一步炸了，把它标红（错误本身继续往外抛） */
  const markFailed = (id: string, msg: string) => {
    const rec = steps.find(x => x.id === id)
    if (!rec) return
    rec.state = 'error'
    rec.detail = msg
    rec.ms = Date.now()
    onStep({...rec})
  }

  // 1. 读规则
  const endRules = step('rules', '读取我的规则')
  const rules = loadRules()
  endRules(
    rules.sources.length
      ? `${rules.sources.join('、')} · ${(
          (rules.system.length + rules.body.length) /
          1000
        ).toFixed(1)}K 字 · ${rules.hash}`
      : '（没读到规则文件，用内置角色设定）'
  )

  const config = loadConfig({marketType: market, timeframes})

  // 2. 知识库经验
  const endKb = step('knowledge', '取知识库经验')
  let lessons = ''
  try {
    lessons = await lessonsByGrade()
  } catch (e) {
    console.warn('[analyze] 读取知识库失败:', (e as Error).message)
  }
  endKb(lessons.trim() ? `${lessons.length} 字` : '知识库为空，跳过')

  // 3. 拉行情
  const endFetch = step('fetch', `拉取 ${symbolInput} 行情`)
  let snapshot: MarketSnapshot
  try {
    snapshot = await fetchSnapshot({
      exchangeId: config.exchange,
      symbol: symbolInput,
      timeframes,
      limit: config.candlesLimit,
      recentTimeframe: '1h',
      recentCount: 30,
      marketType: config.marketType,
      apiBase: config.apiBase
    })
  } catch (e) {
    markFailed('fetch', (e as Error).message)
    throw e
  }
  endFetch(
    `${snapshot.symbol} · ${timeframes.join('/')} · ${snapshot.series.length} 根 K 线 · 现价 ${snapshot.price}`
  )

  // 4. 构建上下文
  const endCtx = step('context', '构建喂给 AI 的行情快照')
  const context = buildContext(snapshot)
  endCtx(`${context.length} 字`)

  // 5. 调用大模型
  const endJudge = step('judge', `调用 ${config.llm.model} 判断`)
  let result: JudgeResult
  let meta: JudgeMeta
  try {
    ;({result, meta} = await judge({snapshot, context, rules, lessons, config}))
  } catch (e) {
    markFailed('judge', (e as Error).message)
    throw e
  }
  endJudge(
    `${meta.model} · ${meta.usage.promptTokens}+${meta.usage.completionTokens} tok · 回答 ${meta.raw.length} 字` +
      (meta.attempts > 1 ? ` · 重试 ${meta.attempts} 次` : '')
  )

  // 6. 护栏与仓位（代码算，不采信 AI 的算术）
  const endGuard = step('guardrails', '护栏与仓位校验（代码）')
  const decision = toDecision(result)
  const guardrails = validate(decision, snapshot, config)
  endGuard(
    guardrails.passed
      ? `通过 ${guardrails.checks.length} 项检查` +
          (typeof guardrails.rMultiple === 'number'
            ? ` · 末段盈亏比 ${guardrails.rMultiple}R`
            : '')
      : `拦下：${guardrails.violations.map(v => v.desc || v.id).join('；')}`
  )

  const expectancy = expectancyOf(decision, winRate)
  const chartTimeframe = '1h'

  // 7. 记账并存档
  const endArchive = step('archive', '记账并存档')
  const billed = await recordUsage({
    kind: 'judge',
    model: meta.model,
    symbol: baseSymbol(snapshot.symbol),
    timeframe: timeframes.join(','),
    usage: meta.usage,
    attempts: meta.attempts,
    latencyMs: meta.latencyMs
  })

  let analysisId: number | null = null
  try {
    await saveRulesVersion({
      hash: rules.hash,
      system: rules.system,
      body: rules.body,
      sources: rules.sources
    })
    analysisId = await saveAnalysis({
      symbol: baseSymbol(snapshot.symbol),
      ccxtSymbol: snapshot.symbol,
      exchange: config.exchange,
      marketType: config.marketType,
      timeframes,
      assumedWinRate: winRate,
      chartTimeframe,
      judge: result,
      guardrails,
      expectancy,
      snapshot,
      meta: {model: meta.model},
      model: meta.model,
      rulesHash: rules.hash,
      llmUsageId: billed?.id ?? null,
      usage: meta.usage,
      costUsd: billed?.costUsd ?? null,
      latencyMs: meta.latencyMs,
      attempts: meta.attempts
    })
  } catch (e) {
    console.warn('[analyze] 存档失败:', (e as Error).message)
  }
  endArchive(
    analysisId === null
      ? '存库失败（不影响本次结论）'
      : `存档 #${analysisId} · 花费 ${oneLineCost(meta.usage, billed?.costUsd ?? 0, meta.latencyMs)}`
  )

  return {
    analysisId,
    symbol: baseSymbol(snapshot.symbol),
    ccxtSymbol: snapshot.symbol,
    exchange: config.exchange,
    marketType: config.marketType,
    price: snapshot.price,
    heat: snapshot.heat,
    change24hPct: snapshot.heat.change24hPct,
    fundingRate: snapshot.heat.fundingRate,
    openInterest: snapshot.heat.openInterest,
    structure: snapshot.structure,
    timeframes: snapshot.timeframes,
    series: snapshot.series,
    judge: result,
    guardrails,
    expectancy,
    steps,
    meta: {
      model: meta.model,
      rules: {
        sources: rules.sources,
        hash: rules.hash,
        warnings: rules.warnings
      },
      knowledgeUsed: lessons.length > 0,
      // 本次调用的 token 与花费（统计用）
      usage: {
        callId: billed?.id ?? null,
        promptTokens: meta.usage.promptTokens,
        completionTokens: meta.usage.completionTokens,
        totalTokens: meta.usage.totalTokens,
        cacheHitTokens: meta.usage.cacheHitTokens,
        costUsd: billed?.costUsd ?? 0,
        costCny: usdToCny(billed?.costUsd ?? 0),
        attempts: meta.attempts,
        latencyMs: meta.latencyMs,
        text: oneLineCost(meta.usage, billed?.costUsd ?? 0, meta.latencyMs)
      }
    }
  }
}

async function handleAnalyze(
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const params = analyzeParams(url.searchParams)
  if (!params.symbol) {
    sendJson(res, 400, {error: '请先选择币种'})
    return
  }
  try {
    sendJson(res, 200, await runAnalysis(params))
  } catch (e) {
    sendJson(res, 502, {error: (e as Error).message})
  }
}

/**
 * 带进度的分析（Server-Sent Events）。
 * 一路上推 `step`，最后推 `done`（内容与 /api/analyze 完全一致）。
 */
async function handleAnalyzeStream(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS
  })

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const params = analyzeParams(url.searchParams)
  if (!params.symbol) {
    send('failed', {error: '请先选择币种'})
    res.end()
    return
  }

  // 页面切走了就别再往回写（大模型调用中途没法取消，但至少别浪费）
  let closed = false
  req.on('close', () => (closed = true))

  try {
    const outcome = await runAnalysis({
      ...params,
      onStep: s => {
        if (!closed) send('step', s)
      }
    })
    if (!closed) send('done', outcome)
  } catch (e) {
    if (!closed) send('failed', {error: (e as Error).message})
  } finally {
    res.end()
  }
}

/* ------------------------------------------------------------------ */
/* 知识库                                                              */
/* ------------------------------------------------------------------ */

async function handleCollectCase(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req)

  const symbol = str(body.symbol).trim().toUpperCase()
  if (!symbol) {
    sendJson(res, 400, {error: '请填写币种，例如 MAGMA'})
    return
  }

  const tf = str(body.timeframe, '4h') as Timeframe
  const timeframe = (VALID_TFS as string[]).includes(tf) ? tf : '4h'

  const labelRaw = str(body.label, 'do')
  const label: CaseLabel = labelRaw === 'dont' ? 'dont' : 'do'

  const from = num(body.from)
  const to = num(body.to)
  if ((from && !to) || (!from && to)) {
    sendJson(res, 400, {error: '时间段要同时给起止时间'})
    return
  }

  const result = await collectCase({
    symbol,
    timeframe,
    label,
    note: str(body.note),
    from,
    to,
    lookbackBars: num(body.lookbackBars),
    dryRun: body.save === false
  })
  sendJson(res, 200, result)
}

async function handleListCases(
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const labelRaw = url.searchParams.get('label') ?? 'all'
  const label = (['do', 'dont'] as string[]).includes(labelRaw)
    ? (labelRaw as CaseLabel)
    : 'all'
  const cases = await listCases({label})
  sendJson(res, 200, {total: cases.length, cases})
}

async function handleGetCase(
  id: number,
  res: http.ServerResponse
): Promise<void> {
  const row = await getCase(id)
  if (!row) {
    sendJson(res, 404, {error: '案例不存在'})
    return
  }
  sendJson(res, 200, {case: row})
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const p = url.pathname
  const method = req.method ?? 'GET'

  if (!p.startsWith('/api/')) {
    // 开发模式下前端交给 Vite 中间件（改完立刻生效，不需要 build）
    if (viteDev?.handle(req, res)) return
    serveStatic(res, p)
    return
  }

  if (p === '/api/health') {
    const db = await checkDb()
    const rules = loadRules()
    sendJson(res, 200, {
      ok: true,
      db,
      rules: {
        sources: rules.sources,
        hash: rules.hash,
        systemChars: rules.system.length,
        bodyChars: rules.body.length,
        warnings: rules.warnings
      }
    })
    return
  }

  if (p === '/api/config') {
    const rules = loadRules()
    const env = process.env
    const counts = await query<{label: string; n: string}>(
      'SELECT label, count(*)::text AS n FROM knowledge GROUP BY label'
    ).catch(() => [] as {label: string; n: string}[])
    const knowledge = {doCount: 0, dontCount: 0, total: 0}
    for (const c of counts) {
      const n = Number(c.n)
      if (c.label === 'do') knowledge.doCount = n
      else knowledge.dontCount = n
      knowledge.total += n
    }
    const head = await usageHeadline().catch(() => ({
      todayCalls: 0,
      todayCostUsd: 0,
      allCalls: 0,
      allCostUsd: 0
    }))
    const cfg = loadConfig()
    const balance = await fetchBalance(cfg).catch(() => null)
    sendJson(res, 200, {
      hasApiKey: Boolean(env.LLM_API_KEY),
      exchange: env.EXCHANGE ?? 'binance',
      marketType: env.MARKET_TYPE ?? 'swap',
      timeframes: cfg.timeframes.join(','),
      model: cfg.llm.model,
      provider: 'deepseek',
      rules: {
        sources: rules.sources,
        hash: rules.hash,
        systemChars: rules.system.length,
        bodyChars: rules.body.length,
        warnings: rules.warnings
      },
      knowledge,
      usage: {
        todayCalls: head.todayCalls,
        todayCostUsd: head.todayCostUsd,
        todayCostCny: usdToCny(head.todayCostUsd),
        allCalls: head.allCalls,
        allCostUsd: head.allCostUsd,
        allCostCny: usdToCny(head.allCostUsd)
      },
      /** 账户余额（人民币，DeepSeek 原生就是 CNY） */
      balance: balance
        ? {
            ok: balance.ok,
            cny: balance.cny,
            available: balance.available,
            error: balance.error
          }
        : {ok: false, cny: null, available: false, error: '暂时拿不到余额'}
    })
    return
  }

  /* ---- 用量统计 ---- */
  if (p === '/api/usage' || p === '/api/usage/summary') {
    const days = url.searchParams.get('days')
    const recent = url.searchParams.get('recent')
    try {
      const [summary, headline] = await Promise.all([
        usageSummary({
          days: Number(days ?? 30),
          recent: Number(recent ?? 10),
          kind: url.searchParams.get('kind')
        }),
        usageHeadline()
      ])
      sendJson(res, 200, {
        ...summary,
        // 展示用汇率，前端拿它把美元折成人民币
        rate: usdToCny(1),
        today: {
          calls: headline.todayCalls,
          costUsd: headline.todayCostUsd,
          costCny: usdToCny(headline.todayCostUsd)
        },
        allTime: {
          calls: headline.allCalls,
          costUsd: headline.allCostUsd,
          costCny: usdToCny(headline.allCostUsd)
        }
      })
    } catch (e) {
      sendJson(res, 503, {error: dbHelpMessage(e)})
    }
    return
  }

  if (p === '/api/usage/calls') {
    try {
      const page = await usageCalls({
        days: Number(url.searchParams.get('days') ?? 30),
        kind: url.searchParams.get('kind'),
        limit: Number(url.searchParams.get('limit') ?? 50),
        offset: Number(url.searchParams.get('offset') ?? 0)
      })
      sendJson(res, 200, page)
    } catch (e) {
      sendJson(res, 503, {error: dbHelpMessage(e)})
    }
    return
  }

  /* ---- 账户：余额 + 可用模型 ---- */
  if (p === '/api/account') {
    const config = loadConfig()
    const force = url.searchParams.get('refresh') === '1'
    if (force) clearBalanceCache()
    const [balance, models] = await Promise.all([
      fetchBalance(config, {force}),
      fetchModels(config)
    ])
    sendJson(res, 200, {
      provider: 'deepseek',
      baseUrl: config.llm.baseUrl,
      hasApiKey: Boolean(config.llm.apiKey),
      model: config.llm.model,
      balance,
      models
    })
    return
  }

  /* ---- 切换模型：写回 .env，立刻生效 ---- */
  if (p === '/api/account/model') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
    const config = loadConfig()
    const model = str(body.model).trim()

    if (!model) return sendJson(res, 400, {error: '缺少 model'})
    if (model.length > 80 || /[\s=]/.test(model))
      return sendJson(res, 400, {error: '模型名不合法'})

    // 以接口返回的可用列表为准；拿不到列表就放行（用户可能自己知道要什么）
    const models: ModelsResult = await fetchModels(config)
    const allowed = models.available.map(m => m.id)
    if (models.fromApi && !allowed.includes(model)) {
      return sendJson(res, 400, {
        error: `这个模型不可用。可选：${allowed.join(' / ')}`
      })
    }

    const saved = writeEnvVar('LLM_MODEL', model)
    clearBalanceCache()
    const next = loadConfig()
    sendJson(res, 200, {
      ok: true,
      model: next.llm.model,
      /** 没写进 .env 的话，重启就丢了 */
      persisted: saved,
      warning: saved ? null : '没写进 .env（文件可能不可写），重启后会还原。'
    })
    return
  }

  if (p === '/api/contracts') {
    const store = loadContracts()
    if (!store) {
      sendJson(res, 404, {
        error: '尚未生成本地合约列表，请先运行：npm run sync:contracts'
      })
      return
    }
    sendJson(res, 200, store)
    return
  }

  if (p === '/api/candles') {
    await handleCandles(url, res)
    return
  }

  if (p === '/api/analyze') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    await handleAnalyze(url, res)
    return
  }

  if (p === '/api/analyze/stream') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    await handleAnalyzeStream(url, req, res)
    return
  }

  /* ---- 分析存档 ---- */
  if (p === '/api/analyses') {
    try {
      const [list, stats] = await Promise.all([
        listAnalyses({
          symbol: url.searchParams.get('symbol') ?? undefined,
          grade: url.searchParams.get('grade') ?? undefined,
          verdict: url.searchParams.get('verdict') ?? undefined,
          actionableOnly: url.searchParams.get('actionable') === '1',
          pendingOnly: url.searchParams.get('pending') === '1',
          limit: Number(url.searchParams.get('limit') ?? 30),
          offset: Number(url.searchParams.get('offset') ?? 0)
        }),
        analysisStats(Number(url.searchParams.get('days') ?? 365))
      ])
      sendJson(res, 200, {...list, stats, rate: usdToCny(1)})
    } catch (e) {
      sendJson(res, 503, {error: dbHelpMessage(e)})
    }
    return
  }

  if (p.startsWith('/api/analyses/')) {
    const m = p.match(/\/(\d+)(\/settle)?$/)
    if (!m)
      return sendJson(res, 400, {
        error: '路径不对。用法：/api/analyses/12 或 /api/analyses/12/settle'
      })
    const id = Number(m[1])
    const settle = Boolean(m[2])

    if (!settle) {
      if (method === 'DELETE') {
        const ok = await deleteAnalysis(id)
        return sendJson(
          res,
          ok ? 200 : 404,
          ok ? {ok: true} : {error: '记录不存在'}
        )
      }
      const row = await getAnalysis(id).catch(() => null)
      if (!row) return sendJson(res, 404, {error: '记录不存在'})
      return sendJson(res, 200, {analysis: row})
    }

    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
    const outcome = str(body.outcome).trim()
    if (!(outcome in OUTCOME_LABEL)) {
      return sendJson(res, 400, {
        error: `outcome 只能是：${Object.keys(OUTCOME_LABEL).join(' / ')}`
      })
    }
    const ok = await settleAnalysis(id, {
      outcome: outcome as OutcomeKind,
      outcomePrice: num(body.price) ?? null,
      rMultiple: num(body.rMultiple) ?? null,
      mfePct: num(body.mfePct) ?? null,
      maePct: num(body.maePct) ?? null,
      note: str(body.note) || null
    }).catch(() => false)
    return sendJson(
      res,
      ok ? 200 : 404,
      ok ? {ok: true} : {error: '记录不存在'}
    )
  }

  /* ---- 知识库 ---- */
  if (p === '/api/knowledge') {
    if (method === 'GET') return handleListCases(url, res)
    if (method === 'POST') return handleCollectCase(req, res)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p.startsWith('/api/knowledge/')) {
    const m = p.match(/\/(\d+)$/)
    const id = m ? Number(m[1]) : null
    if (id === null) return sendJson(res, 404, {error: 'Not Found'})
    if (method === 'DELETE') {
      const ok = await deleteCase(id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '案例不存在'}
      )
    }
    return handleGetCase(id, res)
  }

  sendJson(res, 404, {error: 'Not Found'})
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`
  )
  route(req, res, url).catch(e => fail(res, url.pathname, e))
})

/** 挂上 Vite 开发中间件后不为 null */
let viteDev: ViteDev | null = null

/**
 * 前端用哪种方式提供：
 *   vite  —— 需要 vite 已安装（开发机器）。零构建，热更新
 *   dist  —— 托管 frontend/dist（生产）
 * 用 FRONTEND=dist 可以强制走静态托管。
 */
async function resolveFrontend(): Promise<'vite' | 'dist'> {
  if (process.env.FRONTEND === 'dist') return 'dist'
  if (process.env.NODE_ENV === 'production') return 'dist'
  viteDev = await mountViteDev()
  return viteDev ? 'vite' : 'dist'
}

async function main(): Promise<void> {
  try {
    await ensureSchema()
  } catch (e) {
    console.error('\n⚠️  数据库不可用 —— 先去启动它，否则网页用不了。\n')
    console.error(dbHelpMessage(e))
    console.error('')
  }

  const rules = loadRules()
  const frontend = await resolveFrontend()

  server.listen(PORT, () => {
    console.log('')
    console.log('  ✅ 开单分析 Web 界面已启动')
    console.log(`     http://localhost:${PORT}`)
    console.log('')
    if (frontend === 'vite') {
      console.log('  前端    Vite 开发模式 —— 改前端代码立刻生效，不需要 build')
    } else if (hasBuiltFrontend()) {
      console.log('  前端    frontend/dist（要改前端就重新 ui:build）')
    } else {
      console.log('  前端    ⚠️  还没构建：npm run ui:build')
    }
    console.log(`  规则    ${rules.sources.join('、') || '（空）'}`)
    for (const w of rules.warnings) console.log(`  ⚠️  ${w}`)
    console.log('')
    console.log('  按 Ctrl+C 停止。')
    console.log('')
  })
}

/** 退出时把 Vite 与数据库连接池关干净，别留孤儿进程 */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void Promise.resolve(viteDev?.close())
      .catch(() => undefined)
      .then(() => closePool())
      .catch(() => undefined)
      .then(() => process.exit(0))
  })
}

main().catch(e => {
  console.error('启动失败：', (e as Error).message)
  process.exitCode = 1
})
