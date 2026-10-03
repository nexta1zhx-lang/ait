#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {loadConfig, ROOT_DIR} from './config'
import {
  CONTRACTS_MAX_AGE_MS,
  ensureContractsFresh,
  loadContracts
} from './contracts'
import {fullSystem, loadExtractRules, loadRules} from './rules'
import {
  checkDb,
  closePool,
  dbHelpMessage,
  ensureSchema,
  query
} from './db/client'
import {
  CaseLabel,
  MoveType,
  deleteCase,
  getCase,
  listCases,
  listTags,
  updateCase,
  type UpdateCaseInput
} from './db/knowledge'
import {
  addTagTemplate,
  deleteTagTemplate,
  listTagTemplates,
  loadTagTemplates,
  moveTagTemplate,
  renameTagTemplate
} from './db/tags'
import {recordUsage, usageCalls, usageHeadline, usageSummary} from './db/usage'
import {
  analysisStats,
  deleteAnalysis,
  getAnalysis,
  listAnalyses,
  saveAnalysis,
  saveRulesVersion
} from './db/analyses'
import {oneLineCost, usdToCny} from './llm/pricing'
import {fetchBalance, fetchModels, type ModelsResult} from './llm/account'
import {writeEnvVar} from './util/envfile'
import {hasBuiltFrontend, mountViteDev, type ViteDev} from './devtools/vite-dev'
import {bjFull, collectCase, reeditCase} from './knowledge-service'
import {stepRecorder, type AnalyzeStep, type OnStep} from './step'
import {
  TF_MS,
  computeRecentSR,
  fetchCandles,
  fetchCandlesRange,
  fetchMarketList,
  fetchSnapshot,
  fetchTickerInfo,
  type MarketRow,
  type TickerInfo
} from './data/market'
import {subscribeKline, subscribeTickers} from './data/kline-stream'
import {buildContext} from './context/builder'
import {judge, type JudgeMeta, type JudgeResult} from './llm/client'
import {Candle, MarketSnapshot, MarketType, Timeframe} from './types'

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
  // 一屏最多 3000 根（前端「加载更多」会递加）
  const limit = Math.min(3000, Math.max(50, Number(q.get('limit')) || 300))
  const config = loadConfig({marketType: market})

  // 日期区间（毫秒）。只决定「画哪一段」，不影响分析用的数据。
  const fromReq = Number(q.get('from')) || 0
  const toReq = Number(q.get('to')) || 0
  const ranged = fromReq > 0 && toReq > fromReq

  // 要比交易所单次上限（1000~1500）还多的时候走分页接口按区间翻。
  // 给了 from 就**从那一刻开始画**（不往回截）—— 用户选的时间上必须真有 K 线；
  // 跨度超过 limit 根时，从 from 起正向取满 limit 根为止。
  const step = TF_MS[timeframe]
  const now = Date.now()
  const rangeFrom = ranged ? fromReq : now - limit * step
  const rangeTo = ranged ? toReq : now

  const [candles, h1] = await Promise.all([
    ranged || limit > 1000
      ? fetchCandlesRange({
          exchangeId: config.exchange,
          symbol,
          timeframe,
          from: rangeFrom,
          to: rangeTo,
          marketType: config.marketType,
          apiBase: config.apiBase,
          maxCandles: limit
        })
      : fetchCandles({
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
    ranged,
    candles,
    sr: computeRecentSR(srSource, 4)
  })
}

/**
 * 头部行情条缓存。
 *
 * 界面上十几秒刷一次，同一个币短时间内重复打交易所没意义；
 * 缓存 15 秒 → 同时开两个页面也只打一次。
 */
const tickerCache = new Map<string, {at: number; data: TickerInfo}>()
const TICKER_TTL_MS = 15_000

/** 头部行情（价格 / 24h / 标记指数 / 资金费率 / 持仓量 / 多周期涨幅） */
async function handleTicker(url: URL, res: http.ServerResponse): Promise<void> {
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
  const config = loadConfig({marketType: market})

  const key = `${config.marketType}|${symbol}`
  const hit = tickerCache.get(key)
  if (hit && Date.now() - hit.at < TICKER_TTL_MS) {
    sendJson(res, 200, hit.data)
    return
  }

  try {
    const data = await fetchTickerInfo({
      exchangeId: config.exchange,
      symbol,
      marketType: config.marketType,
      apiBase: config.apiBase
    })
    tickerCache.set(key, {at: Date.now(), data})
    // 缓存别无限长大：只留最近用过的 50 个币
    if (tickerCache.size > 50) {
      const oldest = [...tickerCache.entries()].sort(
        (a, b) => a[1].at - b[1].at
      )[0]
      if (oldest) tickerCache.delete(oldest[0])
    }
    sendJson(res, 200, data)
  } catch (e) {
    // 头部行情挂了不该拖垮整个页面：前端自己会把这项显示成「—」
    sendJson(res, 502, {error: (e as Error).message})
  }
}

/**
 * 合约行情列表（参考币安「合约行情」页）。
 *
 * 界面上几秒刷一次，**必须缓存**：一次请求就是交易所全量 24h ticker，
 * 多开几个标签页 / 多人同时看时不能各打各的。5 秒足够「实时」了。
 */
const marketsCache = new Map<string, {at: number; rows: MarketRow[]}>()
const MARKETS_TTL_MS = 5_000

async function handleMarkets(
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const marketParam = url.searchParams.get('market')
  const market =
    marketParam && ['spot', 'swap', 'coinm'].includes(marketParam)
      ? (marketParam as MarketType)
      : undefined
  const config = loadConfig({marketType: market})
  const key = `${config.exchange}|${config.marketType}|${config.apiBase ?? ''}`

  const hit = marketsCache.get(key)
  if (hit && Date.now() - hit.at < MARKETS_TTL_MS) {
    sendJson(res, 200, {rows: hit.rows, updatedAt: hit.at})
    return
  }

  try {
    const rows = await fetchMarketList({
      exchangeId: config.exchange,
      marketType: config.marketType,
      apiBase: config.apiBase
    })
    const at = Date.now()
    marketsCache.set(key, {at, rows})
    sendJson(res, 200, {rows, updatedAt: at})
  } catch (e) {
    sendJson(res, 502, {error: (e as Error).message})
  }
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
export type {AnalyzeStep}

export interface AnalyzeOutcome {
  analysisId: number | null
  symbol: string
  ccxtSymbol: string
  exchange: string
  marketType: string
  /** 是不是「回到某一刻」的测试跑（不存档） */
  testMode: boolean
  /** 测试跑的时间点（毫秒）；实时跑是 null */
  at: number | null
  price: number
  heat: MarketSnapshot['heat']
  change24hPct: number | null
  fundingRate: number | null
  openInterest: number | null
  /** 主周期（图上那个） */
  primary: Timeframe
  /** 各周期的切段描述 */
  blocks: MarketSnapshot['blocks']
  /** 主周期的 K 线（给前端画图） */
  candles: MarketSnapshot['candles']
  /** 主周期往前看了多少天 */
  days: number
  judge: JudgeResult
  /** 本次分析走了哪几步（前端画时间线） */
  steps: AnalyzeStep[]
  meta: {
    model: string
    rules: {sources: string[]; hash: string; warnings: string[]}
    /** 本次给了多少个可用标签 */
    tagCount: number
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

/** 读 query 里的 symbol / market / timeframe / days / at */
function analyzeParams(q: URLSearchParams): {
  symbol: string
  market?: MarketType
  /** 主周期（图上那个） */
  timeframe: Timeframe
  /** 主周期往前看多少天；0 / 非法 = 用配置里的默认值 */
  days: number
  /** 测试时间点（毫秒）；null = 用真正的现在跑实时分析 */
  at: number | null
} {
  const marketParam = q.get('market')
  const tfRaw = (q.get('timeframe') ?? '').trim()
  const fallback = loadConfig().timeframes
  const timeframe = (VALID_TFS as string[]).includes(tfRaw)
    ? (tfRaw as Timeframe)
    : (fallback[0] ?? '1h')
  return {
    symbol: (q.get('symbol') ?? '').trim().toUpperCase(),
    market:
      marketParam && ['spot', 'swap', 'coinm'].includes(marketParam)
        ? (marketParam as MarketType)
        : undefined,
    timeframe,
    days: Number(q.get('days')) || 0,
    at: parseAt(q.get('at'))
  }
}

/** 测试时间点：毫秒时间戳；非法 / 未来时间一律当作没给 */
function parseAt(raw: string | null): number | null {
  if (!raw) return null
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return null
  // 未来的时间点没有数据可看，直接当没填
  if (ms > Date.now()) return null
  return Math.floor(ms)
}

/**
 * 一次分析的全过程。
 * 网页（JSON）、网页（SSE 进度）、命令行都走这里，避免几份实现各写一遍。
 */
async function runAnalysis(opts: {
  symbol: string
  market?: MarketType
  /** 主周期（图上那个） */
  timeframe: Timeframe
  /** 主周期往前看多少天；0 = 用配置默认值 */
  days: number
  /** 测试时间点（毫秒）：只看到那一刻为止的数据，且不存档 */
  at?: number | null
  onStep?: OnStep
}): Promise<AnalyzeOutcome> {
  const {symbol: symbolInput, market, timeframe} = opts
  const {steps, start: step, markFailed} = stepRecorder(opts.onStep)
  const testAt = opts.at ?? null

  // 1. 读分析预测提示词（数据库里那份 kind=predict）
  const endRules = step('rules', '读分析预测提示词')
  const rules = await loadRules()
  if (rules.dbError) {
    // 没有角色和规则的判断等于让 AI 自由发挥，宁可不开跑
    markFailed('rules', rules.dbError)
    throw new Error(
      `读不到提示词文档（角色/规则），先确认数据库正常：${rules.dbError}`
    )
  }
  endRules(
    rules.bodyEnabled
      ? `${rules.sources.join('、')} · 角色 ${rules.system.length} 字 + 规则 ${rules.body.length} 字 · ${rules.hash}`
      : '（没有启用的角色/规则文档，本次按知识库经验判断）'
  )

  const config = loadConfig({marketType: market, timeframes: [timeframe]})
  const cal = config.calibers
  /** 主周期看多少天（前端传的是「图上那段」的天数；没传就用配置默认值） */
  const days = Math.max(1, opts.days || config.lookbackDays)

  // 2. 可用的标签池
  //    **复用**两处现有的东西，不另建一套标签体系：
  //      · 标签模板（网页「历史知识库」页维护）
  //      · 知识库里已经用过的标签
  //    注意：只给标签词，**不给经验正文** —— 经验暂时不注入。
  const endTags = step('tags', '取可用的标签')
  let tags: string[] = []
  try {
    const [templates, used] = await Promise.all([
      loadTagTemplates(),
      listTags()
    ])
    tags = [...new Set([...templates, ...used.map(u => u.tag)])]
  } catch (e) {
    console.warn('[analyze] 读取标签池失败:', (e as Error).message)
  }
  endTags(
    tags.length
      ? `${tags.length} 个：${tags.slice(0, 6).join(' / ')}…`
      : '没有标签可用'
  )

  // 3. 拉行情
  const endFetch = step(
    'fetch',
    testAt
      ? `拉取 ${symbolInput} 行情（测试：${bjFull(testAt)} 为止）`
      : `拉取 ${symbolInput} 行情`
  )
  let snapshot: MarketSnapshot
  try {
    snapshot = await fetchSnapshot({
      exchangeId: config.exchange,
      symbol: symbolInput,
      timeframe,
      days,
      marketType: config.marketType,
      apiBase: config.apiBase,
      calibers: config.calibers,
      // 测试模式：只看得见这一刻之前已收盘的 K 线
      at: testAt ?? undefined
    })
  } catch (e) {
    markFailed('fetch', (e as Error).message)
    throw e
  }
  endFetch(
    `${snapshot.symbol} · 主周期 ${timeframe}（图上 ${days} 天）· ` +
      snapshot.blocks.map(b => `${b.timeframe} ${b.bars} 根`).join(' / ') +
      ` · 现价 ${snapshot.price}`
  )

  // 4. 构建上下文
  const endCtx = step('context', '构建喂给 AI 的行情快照')
  const context = buildContext(snapshot)
  endCtx(`${context.length} 字（K 线切成小段描述，不算口径）`)

  // 5. 调用大模型
  const endJudge = step('judge', `调用 ${config.llm.model} 判断`)
  let result: JudgeResult
  let meta: JudgeMeta
  try {
    ;({result, meta} = await judge({
      snapshot,
      context,
      prompt: rules.system,
      tags,
      config
    }))
  } catch (e) {
    markFailed('judge', (e as Error).message)
    throw e
  }
  endJudge(
    `${meta.model} · ${meta.usage.promptTokens}+${meta.usage.completionTokens} tok · 回答 ${meta.raw.length} 字` +
      (config.llm.reasoningEffort
        ? ` · 思考=${config.llm.reasoningEffort}`
        : '') +
      (meta.attempts > 1 ? ` · 重试 ${meta.attempts} 次` : '')
  )

  const chartTimeframe = '1h'

  // 6. 记账并存档
  const endArchive = step(
    'archive',
    testAt ? '记账（测试跑不存档）' : '记账并存档'
  )
  const billed = await recordUsage({
    kind: 'judge',
    model: meta.model,
    symbol: baseSymbol(snapshot.symbol),
    timeframe,
    usage: meta.usage,
    attempts: meta.attempts,
    latencyMs: meta.latencyMs
  })

  let analysisId: number | null = null
  try {
    await saveRulesVersion({
      hash: rules.hash,
      system: fullSystem(rules.system),
      body: rules.body,
      sources: rules.sources
    })
    // 测试跑是「回到过去重放」，不是真实的一笔 —— 不存档，
    // 否则历史列表和胜率统计里会混进一堆事后诸葛
    if (!testAt) {
      analysisId = await saveAnalysis({
        symbol: baseSymbol(snapshot.symbol),
        ccxtSymbol: snapshot.symbol,
        exchange: config.exchange,
        marketType: config.marketType,
        timeframes: [timeframe],
        chartTimeframe,
        judge: result,
        snapshot,
        meta: {model: meta.model, days},
        model: meta.model,
        rulesHash: rules.hash,
        llmUsageId: billed?.id ?? null,
        usage: meta.usage,
        costUsd: billed?.costUsd ?? null,
        latencyMs: meta.latencyMs,
        attempts: meta.attempts
      })
    }
  } catch (e) {
    console.warn('[analyze] 存档失败:', (e as Error).message)
  }
  endArchive(
    testAt
      ? `测试跑（${bjFull(testAt)}）不存档 · 花费 ${oneLineCost(meta.usage, billed?.costUsd ?? 0, meta.latencyMs)}`
      : analysisId === null
        ? '存库失败（不影响本次结论）'
        : `存档 #${analysisId} · 花费 ${oneLineCost(meta.usage, billed?.costUsd ?? 0, meta.latencyMs)}`
  )

  return {
    analysisId,
    symbol: baseSymbol(snapshot.symbol),
    ccxtSymbol: snapshot.symbol,
    exchange: config.exchange,
    marketType: config.marketType,
    testMode: testAt !== null,
    at: testAt,
    price: snapshot.price,
    heat: snapshot.heat,
    change24hPct: snapshot.heat.change24hPct,
    fundingRate: snapshot.heat.fundingRate,
    openInterest: snapshot.heat.openInterest,
    primary: snapshot.primary,
    blocks: snapshot.blocks,
    candles: snapshot.candles,
    days,
    judge: result,
    steps,
    meta: {
      model: meta.model,
      rules: {
        sources: rules.sources,
        hash: rules.hash,
        warnings: rules.warnings
      },
      tagCount: tags.length,
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
 * K 线实时推送（SSE）。上游是币安的合约 WS，见 `data/kline-stream.ts`。
 *
 * 事件 `kline` 推的是一根 K 线（**正在长的那根也会推**：`timestamp` 相同就是同一根在更新）；
 * 每 20 秒发一条注释当心跳，免得中间代理把长连接当成空闲掐了。
 */
async function handleKlineStream(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const q = url.searchParams
  const symbol = (q.get('symbol') ?? '').trim().toUpperCase()
  const tfParam = (q.get('timeframe') ?? '1h') as Timeframe
  const timeframe = (VALID_TFS as string[]).includes(tfParam) ? tfParam : '1h'
  if (!symbol) {
    sendJson(res, 400, {error: '请先选择币种'})
    return
  }

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
  send('open', {symbol, timeframe})

  const unsubscribe = subscribeKline(symbol, timeframe, candle =>
    send('kline', {candle})
  )
  const beat = setInterval(() => res.write(': ping\n\n'), 20_000)

  let closed = false
  const done = () => {
    if (closed) return
    closed = true
    clearInterval(beat)
    unsubscribe()
  }
  req.on('close', done)
  res.on('close', done)
}

/**
 * 全市场行情实时推送（SSE，上游是币安的 `!ticker@arr`）。
 *
 * 事件 `ticker` 推的是**一批增量**：只有刚变过的两三百个币（1 秒一批）。
 * 前端拿一次 `GET /api/markets` 当底稿，之后只吃增量，**不用再轮询接口**。
 * 上游挂了后端会自动退回 REST 轮询（那时一批就是整张表），前端不用管。
 */
async function handleTickerStream(
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
  send('open', {stream: 'ticker'})

  const unsubscribe = subscribeTickers(patches =>
    send('ticker', {updates: patches})
  )
  const beat = setInterval(() => res.write(': ping\n\n'), 20_000)

  let closed = false
  const done = () => {
    if (closed) return
    closed = true
    clearInterval(beat)
    unsubscribe()
  }
  req.on('close', done)
  res.on('close', done)
}

/**
 * 币种图标（代理几套公开图标集 + 按顺序兜底）。
 *
 * 为什么不让浏览器直连图标站：图标源在国内不一定连得上，但**我们的域名一定连得上**
 * （跟 K 线 WS 中转一个道理）；顺带在内存里缓存起来，几百个币也就几百 KB，
 * 浏览器那边 `max-age` 七天。找不到就 404，前端退回首字母的圆形占位。
 *
 * ★ 2026-10-03 换过一次源。用户问「图标怎么不全」——实测把 528 个合约跑了一遍：
 *
 *   | 源 | 命中 |
 *   |---|---|
 *   | `spothq/cryptocurrency-icons`（原来只用这个） | **86 / 528（16%）** |
 *   | `assets.coincap.io` | 245 / 528（46%） |
 *   | `static.okx.com` | **352 / 528（67%）** |
 *   | 三家合起来 | 406 / 528（77%） |
 *
 * spothq 那套是 2018 年前后停更的老图标集，**新币几乎一个都没有**
 * （HYPE / SUI / WLD / PUMP / ENA / TAO / PEPE 全缺）—— 这就是「图标不全」的原因。
 * 现在按 **okx → coincap → spothq** 的顺序试，谁先答应用谁。
 * 剩下那 122 个（新上币、中文名的（牛来 / 龙虾 / 币安人生）、以及 BTCDOM 这种指数）
 * 三家都没有，继续走首字母占位。
 */
const ICON_SOURCES: ((k: string) => string)[] = [
  // OKX 的公开 CDN：按纯 ticker 取，对币安那批合约覆盖最好
  k => `https://static.okx.com/cdn/oksupport/asset/currency/icon/${k}.png`,
  // CoinCap：@2x 那张，体积小（~2KB）
  k => `https://assets.coincap.io/assets/icons/${k}@2x.png`,
  // 老的那套（留着当兜底：老币它反而更全，比如一堆 2017 年的币）
  k =>
    `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${k}.png`
]

const iconCache = new Map<string, {buf: Buffer; type: string} | null>()

/**
 * 没有这个币的图标：回 404 但**带缓存头**。
 *
 * 图标集里没有的小币（新上的一堆）会走到这儿，前端退回首字母圆；
 * 不带缓存头的话，每次开页面都要为那十来个币再问一遍（浏览器控制台一片 404）。
 */
function sendNoIcon(res: http.ServerResponse): void {
  res.writeHead(404, {'Cache-Control': 'public, max-age=86400', ...CORS})
  res.end()
}

/** 逐个源试一遍，拿到就返回；全都拿不到返回 null */
async function fetchIcon(
  keys: string[]
): Promise<{buf: Buffer; type: string} | null> {
  for (const src of ICON_SOURCES) {
    for (const k of keys) {
      try {
        const r = await fetch(src(k), {
          signal: AbortSignal.timeout(4000)
        })
        if (!r.ok) continue
        /*
         * ⚠️ 必须校验类型：这几个源对「不存在的币」有时也回 **200**，
         * 但正文是一小段 HTML 或 JSON（实测 LIT / MARSCOIN / US 就是这样，
         * 浏览器那边 `<img>` 解码失败 → 变成裂图）。不是 `image/*` 就当没找到，
         * 继续试下一个源 —— 千万别把 `content-type` 兜底成 image/png 蒙过去。
         */
        const ct = (r.headers.get('content-type') ?? '').split(';')[0].trim()
        if (!ct.startsWith('image/')) continue
        const buf = Buffer.from(await r.arrayBuffer())
        if (!buf.length) continue
        return {buf, type: ct}
      } catch {
        // 这个源不通/超时 → 换下一个（别把整条链路卡死）
        continue
      }
    }
  }
  return null
}

async function handleIcon(
  sym: string,
  res: http.ServerResponse
): Promise<void> {
  const key = sym.trim().toLowerCase()
  if (!/^[a-z0-9]{1,20}$/.test(key)) {
    sendJson(res, 400, {error: '币种不合法'})
    return
  }
  let hit = iconCache.get(key)
  if (hit === undefined) {
    /*
     * 候选键：先用原样，再去掉开头的数字。
     * `1000PEPE` / `1000SHIB` 这种，图标站多数只认 `pepe` / `shib`。
     */
    const stripped = key.replace(/^\d+/, '')
    const keys = stripped && stripped !== key ? [key, stripped] : [key]
    hit = await fetchIcon(keys)
    // 找不到也记一笔（null），别每次开页面都为同一个币把三个源都问一遍
    iconCache.set(key, hit)
  }
  if (!hit) {
    sendNoIcon(res)
    return
  }
  res.writeHead(200, {
    'Content-Type': hit.type,
    'Content-Length': hit.buf.length,
    'Cache-Control': 'public, max-age=604800',
    ...CORS
  })
  res.end(hit.buf)
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

/**
 * 把参数（POST body / SSE 的 query）整理成 collectCase 的输入。
 * 两种入口共用一个解析，免得规则写两遍。
 */
function collectInput(get: (k: string) => unknown):
  | {error: string}
  | {
      symbol: string
      timeframe: Timeframe
      note: string
      center?: number
      aroundBars?: number
      from?: number
      to?: number
      lookbackBars?: number
      exact?: boolean
      dryRun?: boolean
    } {
  const symbol = str(get('symbol')).trim().toUpperCase()
  if (!symbol) return {error: '请填写币种，例如 MAGMA'}

  const tf = str(get('timeframe'), '4h') as Timeframe
  const timeframe = (VALID_TFS as string[]).includes(tf) ? tf : '4h'

  const from = num(get('from'))
  const to = num(get('to'))
  if ((from && !to) || (!from && to)) {
    return {error: '时间段要同时给起止时间'}
  }

  return {
    symbol,
    timeframe,
    note: str(get('note')),
    // 「点选为中心」走这条：以某个时间点为中心，前后各 N 根
    center: num(get('center')),
    aroundBars: num(get('aroundBars')),
    from,
    to,
    lookbackBars: num(get('lookbackBars')),
    // 我在图上画了范围 → 就要这一段本身，前后不补
    exact: get('exact') === true || get('exact') === '1',
    // save=0（或 body 里 save:false）= 只分析不落库，调试用
    dryRun: get('save') === false || get('save') === '0'
  }
}

async function handleCollectCase(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req)
  const params = collectInput(k => body[k])
  if ('error' in params) {
    sendJson(res, 400, {error: params.error})
    return
  }
  sendJson(res, 200, await collectCase(params))
}

/**
 * 带进度的案例提炼（Server-Sent Events）。
 * 一路上推 `step`，最后推 `done`（内容与 POST /api/knowledge 完全一致）。
 */
async function handleCollectStream(
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

  const params = collectInput(k => url.searchParams.get(k))
  if ('error' in params) {
    send('failed', {error: params.error})
    res.end()
    return
  }

  let closed = false
  req.on('close', () => (closed = true))

  try {
    const outcome = await collectCase({
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

async function handleListCases(
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const q = url.searchParams
  const labelRaw = q.get('label') ?? 'all'
  const label = (['do', 'dont'] as string[]).includes(labelRaw)
    ? (labelRaw as CaseLabel)
    : 'all'
  const moveRaw = q.get('moveType') ?? 'all'
  const moveType = (['up', 'down', 'range', 'none'] as string[]).includes(
    moveRaw
  )
    ? (moveRaw as MoveType | 'none')
    : 'all'
  const withCandles = q.get('candles') === '1'
  const cases = await listCases({
    label,
    moveType,
    tag: q.get('tag') ?? '',
    symbol: q.get('symbol') ?? '',
    q: q.get('q') ?? '',
    // 卡片要画迷你图时才把 K 线一起带上
    withCandles
  })

  sendJson(res, 200, {total: cases.length, cases})
}

/** GET /api/knowledge/tags —— 标签模板（我自己维护）+ 已用统计 + 模板外的老标签 */
async function handleListTags(res: http.ServerResponse): Promise<void> {
  const [rows, used] = await Promise.all([listTagTemplates(), listTags()])
  const counts = new Map(used.map(t => [t.tag, t.n]))
  const names = rows.map(r => r.name)
  sendJson(res, 200, {
    tags: used,
    templates: rows.map(r => ({...r, n: counts.get(r.name) ?? 0})),
    // 老记录里那些不在模板里的标签（弹窗里提示清掉）
    legacy: used.map(t => t.tag).filter(t => !names.includes(t))
  })
}

/** 标签模板的增 / 删 / 改 / 排序 —— 全部由我自己在网页上维护 */
async function handleAddTagTemplate(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
  try {
    sendJson(res, 201, await addTagTemplate(body.name))
  } catch (e) {
    sendJson(res, 400, {error: (e as Error).message})
  }
}

async function handleUpdateTagTemplate(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
  try {
    const row = await renameTagTemplate(id, body.name)
    sendJson(res, row ? 200 : 404, row ?? {error: '模板不存在'})
  } catch (e) {
    sendJson(res, 400, {error: (e as Error).message})
  }
}

async function handleMoveTagTemplate(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  const dir = body?.dir === 'up' ? 'up' : 'down'
  const ok = await moveTagTemplate(id, dir)
  sendJson(res, 200, {ok})
}

async function handleDeleteTagTemplate(
  id: number,
  res: http.ServerResponse
): Promise<void> {
  const ok = await deleteTagTemplate(id)
  sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '模板不存在'})
}

/** PATCH /api/knowledge/:id —— 只改文案，K 线不动 */
async function handleUpdateCase(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req)
  const patch: UpdateCaseInput = {}
  if (typeof body.title === 'string') patch.title = body.title
  if (typeof body.note === 'string') patch.note = body.note
  if (typeof body.lesson === 'string') patch.lesson = body.lesson
  if (typeof body.why === 'string') patch.why = body.why
  if (body.label === 'do' || body.label === 'dont') patch.label = body.label
  if (body.moveType === null) patch.moveType = null
  else if (['up', 'down', 'range'].includes(String(body.moveType)))
    patch.moveType = body.moveType as MoveType
  if (Array.isArray(body.tags))
    patch.tags = body.tags
      .map(t => String(t ?? '').trim())
      .filter(t => t.length > 0 && t.length <= 12)
      .slice(0, 10)
  if (body.features && typeof body.features === 'object')
    patch.features = body.features as UpdateCaseInput['features']

  const ok = await updateCase(id, patch)
  sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '案例不存在'})
}

/** POST /api/knowledge/:id/reedit —— 用库里存下的 K 线重跑一次 AI 提炼 */
async function handleReeditCase(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req)
  const result = await reeditCase(id, {
    note: typeof body.note === 'string' ? body.note : undefined
  })
  sendJson(res, 200, result)
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
    const rules = await loadRules()
    // ok 表示「服务能不能用」：数据库连不上就不算 ok。
    // ⚠️ HTTP 状态码固定 200 —— 这样部署脚本能区分「进程没起来」和
    //    「起来了但数据库不通」，两种情况要看的日志不一样。
    sendJson(res, 200, {
      ok: db.ok,
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
    const rules = await loadRules()
    const env = process.env
    // 知识库只报一个总数（已经不再分「该做 / 不该做」）
    const rows = await query<{n: string}>(
      'SELECT count(*)::text AS n FROM knowledge'
    ).catch(() => [] as {n: string}[])
    const knowledge = {total: Number(rows[0]?.n ?? 0)}
    const head = await usageHeadline().catch(() => ({
      todayCalls: 0,
      todayCostUsd: 0,
      allCalls: 0,
      allCostUsd: 0
    }))
    const cfg = loadConfig()
    sendJson(res, 200, {
      hasApiKey: Boolean(env.LLM_API_KEY),
      exchange: env.EXCHANGE ?? 'binance',
      marketType: env.MARKET_TYPE ?? 'swap',
      timeframes: cfg.timeframes.join(','),
      /** 主周期默认看多少天（前端传的是「图上那段」的天数） */
      lookback: {days: cfg.lookbackDays},
      model: cfg.llm.model,
      provider: 'deepseek',
      rules: {
        sources: rules.sources,
        hash: rules.hash,
        /** 角色设定字数 */
        systemChars: rules.system.length,
        /** 规则正文字数 */
        bodyChars: rules.body.length,
        /** 本次是否真的把角色/规则发给了模型 */
        bodyEnabled: rules.bodyEnabled,
        /** db = 数据库里有启用的文档；documents = 库里没有 */
        origin: rules.origin,
        updatedAt: rules.updatedAt,
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
      }
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

  /* ---- 账户：可用模型 + 余额（`?refresh=1` 绕过 60 秒缓存）---- */
  if (p === '/api/account') {
    const config = loadConfig()
    const refresh = url.searchParams.get('refresh') === '1'
    const [models, balance] = await Promise.all([
      fetchModels(config),
      fetchBalance(config, refresh)
    ])
    sendJson(res, 200, {
      provider: 'deepseek',
      baseUrl: config.llm.baseUrl,
      hasApiKey: Boolean(config.llm.apiKey),
      model: config.llm.model,
      models,
      balance
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
    let store = await loadContracts()
    if (!store) {
      // 全新环境（库里没有、本地也没文件）——现场拉一次，
      // 慢几秒也比给前端一个空下拉强
      await ensureContractsFresh().catch(() => null)
      store = await loadContracts()
    }
    if (!store) {
      sendJson(res, 404, {
        error:
          '币种表还没准备好（库里没有，拉币安也没成功）。稍后刷新页面重试，'
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

  if (p === '/api/ticker') {
    await handleTicker(url, res)
    return
  }
  if (p === '/api/markets') {
    await handleMarkets(url, res)
    return
  }
  if (p === '/api/kline/stream') {
    await handleKlineStream(url, req, res)
    return
  }
  if (p === '/api/tickers/stream') {
    await handleTickerStream(req, res)
    return
  }
  if (p.startsWith('/api/icon/')) {
    await handleIcon(p.slice('/api/icon/'.length), res)
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
          tag: url.searchParams.get('tag') ?? undefined,
          actionableOnly: url.searchParams.get('actionable') === '1',
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
    const m = p.match(/\/(\d+)$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])

    if (method === 'DELETE') {
      const ok = await deleteAnalysis(id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '记录不存在'}
      )
    }
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const row = await getAnalysis(id).catch(() => null)
    if (!row) return sendJson(res, 404, {error: '记录不存在'})
    return sendJson(res, 200, {analysis: row})
  }

  /* ---- 知识库 ---- */
  if (p === '/api/knowledge') {
    if (method === 'GET') return handleListCases(url, res)
    if (method === 'POST') return handleCollectCase(req, res)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p === '/api/knowledge/tags') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    return handleListTags(res)
  }
  /* ---- 标签模板（我自己维护，AI 只能从这里挑） ---- */
  if (p === '/api/tag-templates') {
    if (method === 'GET') return handleListTags(res)
    if (method === 'POST') return handleAddTagTemplate(req, res)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p.startsWith('/api/tag-templates/')) {
    const mm = p.match(/^\/api\/tag-templates\/(\d+)(\/move)?$/)
    if (!mm) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(mm[1])
    if (mm[2] === '/move') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      return handleMoveTagTemplate(id, req, res)
    }
    if (method === 'PUT') return handleUpdateTagTemplate(id, req, res)
    if (method === 'DELETE') return handleDeleteTagTemplate(id, res)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  // 带进度地收录一个案例（SSE）—— EventSource 只能发 GET，参数走 query
  if (p === '/api/knowledge/stream') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    return handleCollectStream(url, req, res)
  }
  if (p.startsWith('/api/knowledge/')) {
    const m = p.match(/^\/api\/knowledge\/(\d+)(\/reedit)?$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])
    if (m[2] === '/reedit') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      return handleReeditCase(id, req, res)
    }
    if (method === 'DELETE') {
      const ok = await deleteCase(id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '案例不存在'}
      )
    }
    if (method === 'PATCH') return handleUpdateCase(id, req, res)
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

  const rules = await loadRules()
  const frontend = await resolveFrontend()

  // 币种表：启动时过旧就后台刷一次（新上币自动出现），之后每 24 小时一次。
  // 不 await —— 联网慢不应该拖住启动；失败了也只告警，继续用旧清单。
  const kickContracts = () => {
    void ensureContractsFresh()
      .then(r => {
        if (r.refreshed) console.log(`  币种表  ${r.reason} → ${r.count} 个`)
      })
      .catch(e => console.warn(`  币种表  ⚠️  ${(e as Error).message}`))
  }
  kickContracts()
  setInterval(kickContracts, CONTRACTS_MAX_AGE_MS).unref()

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
    console.log(
      `  提示词  ${rules.sources.join('、') || '（数据库里没有启用的文档）'}`
    )
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
