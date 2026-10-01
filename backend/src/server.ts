#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {loadConfig, ROOT_DIR} from './config'
import {loadContracts} from './contracts'
import {loadRules} from './rules'
import {checkDb, dbHelpMessage, ensureSchema, query} from './db/client'
import {
  CaseLabel,
  deleteCase,
  getCase,
  lessonsByGrade,
  listCases
} from './db/knowledge'
import {recordUsage, usageCalls, usageHeadline, usageSummary} from './db/usage'
import {oneLineCost, usdToCny} from './llm/pricing'
import {
  clearBalanceCache,
  fetchBalance,
  fetchModels,
  type ModelsResult
} from './llm/account'
import {writeEnvVar} from './util/envfile'
import {
  hasBuiltFrontend,
  mountViteDev,
  type ViteDev
} from './devtools/vite-dev'
import {collectCase} from './knowledge-service'
import {computeRecentSR, fetchCandles, fetchSnapshot} from './data/market'
import {buildContext} from './context/builder'
import {judge, toDecision} from './llm/client'
import {validate} from './guardrails/validator'
import {Candle, LlmDecision, MarketType, Timeframe} from './types'

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

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
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

  res.writeHead(404, {'Content-Type': MIME['.html'], 'Cache-Control': 'no-store'})
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

/** 按分批减仓比例加权的盈亏比 → 每笔期望值（单位 R） */
function expectancyOf(dec: LlmDecision, winRate: number) {
  const entry = dec.entry?.price ?? null
  const sl = dec.stopLoss ?? null
  const tps = dec.takeProfits ?? []
  if (entry === null || sl === null || entry === sl || tps.length === 0)
    return null
  const risk = Math.abs(entry - sl)
  const rs = tps.map(t => Math.abs(t.price - entry) / risk)
  const totalPct = tps.reduce((s, t) => s + (t.reducePercent ?? 0), 0)
  const weightedR =
    totalPct > 0
      ? tps.reduce(
          (s, t, i) => s + ((t.reducePercent ?? 0) / totalPct) * rs[i],
          0
        )
      : Math.max(...rs)
  const p = Math.min(1, Math.max(0.01, winRate))
  const r2 = (n: number) => Math.round(n * 100) / 100
  return {
    winRate: p,
    weightedR: r2(weightedR),
    maxR: r2(Math.max(...rs)),
    expectancyR: r2(p * weightedR - (1 - p)),
    positive: p * weightedR - (1 - p) > 0
  }
}

async function handleAnalyze(
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const q = url.searchParams
  const symbolInput = (q.get('symbol') ?? '').trim().toUpperCase()
  if (!symbolInput) {
    sendJson(res, 400, {error: '请先选择币种'})
    return
  }

  const marketParam = q.get('market')
  const market =
    marketParam && ['spot', 'swap', 'coinm'].includes(marketParam)
      ? (marketParam as MarketType)
      : undefined

  const tfParam = q.get('timeframes')
  const fallbackTfs = loadConfig().timeframes
  let timeframes = (
    tfParam ? tfParam.split(',') : fallbackTfs
  )
    .map(s => s.trim())
    .filter((s): s is Timeframe => (VALID_TFS as string[]).includes(s))
  if (timeframes.length === 0) timeframes = fallbackTfs.length ? fallbackTfs : ['1h', '4h', '1d']

  const hasKey = Boolean(process.env.LLM_API_KEY)
  const mockParam = q.get('mock')
  const mock = mockParam === '1' ? true : mockParam === '0' ? false : !hasKey
  /** 期望值用的假设胜率。页面不暴露这个输入了，用默认值；显式传参仍然有效 */
  const DEFAULT_WIN_RATE = 0.45
  const winRate = Math.min(
    1,
    Math.max(0.01, Number(q.get('winRate')) || DEFAULT_WIN_RATE)
  )

  const config = loadConfig({marketType: market, timeframes, mock})
  const rules = loadRules()

  // 知识库：注入「我做对的」和「我踩过的坑」
  let lessons = ''
  try {
    lessons = await lessonsByGrade()
  } catch (e) {
    console.warn('[analyze] 读取知识库失败:', (e as Error).message)
  }

  const snapshot = await fetchSnapshot({
    exchangeId: config.exchange,
    symbol: symbolInput,
    timeframes,
    limit: config.candlesLimit,
    recentTimeframe: '1h',
    recentCount: 30,
    marketType: config.marketType,
    apiBase: config.apiBase
  })

  const context = buildContext(snapshot)
  const {result, meta} = await judge({
    snapshot,
    context,
    rules,
    lessons,
    config
  })

  // 转成护栏模块认识的形状
  const decision = toDecision(result)
  const guardrails = validate(decision, snapshot, config)

  // 记账：这次判断烧了多少 token、多少钱
  const billed = await recordUsage({
    kind: 'judge',
    model: meta.model,
    symbol: snapshot.symbol.replace(/:[^:]*$/, ''),
    timeframe: timeframes.join(','),
    usage: meta.usage,
    mock: meta.mock,
    attempts: meta.attempts,
    latencyMs: meta.latencyMs
  })

  try {
    await query(
      `INSERT INTO analyses (symbol, exchange, grade, verdict, confidence, price,
         decision, rules_hash, model, mock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        snapshot.symbol,
        config.exchange,
        result.grade,
        result.verdict,
        result.confidence,
        snapshot.price,
        JSON.stringify(result),
        rules.hash,
        meta.model,
        meta.mock
      ]
    )
  } catch (e) {
    console.warn('[analyze] 记录失败:', (e as Error).message)
  }

  sendJson(res, 200, {
    symbol: snapshot.symbol.replace(/:[^:]*$/, ''),
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
    expectancy: expectancyOf(decision, winRate),
    meta: {
      model: meta.model,
      mock: meta.mock,
      warning:
        mock && !hasKey
          ? '未配置 LLM_API_KEY，本次是「模拟判断」，不是真实 AI 判断。'
          : null,
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
  })
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
    mock: typeof body.mock === 'boolean' ? body.mock : undefined,
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
          kind: url.searchParams.get('kind'),
          realOnly: url.searchParams.get('realOnly') === '1'
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
        realOnly: url.searchParams.get('realOnly') === '1',
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
      mock: config.llm.mock,
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

/** 退出时把 Vite 关干净，别留个孤儿进程 */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void Promise.resolve(viteDev?.close())
      .catch(() => undefined)
      .then(() => process.exit(0))
  })
}

void 0
main().catch(e => {
  console.error('启动失败：', (e as Error).message)
  process.exitCode = 1
})
