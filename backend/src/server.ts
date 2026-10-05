#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {createHash, randomBytes} from 'node:crypto'
import QRCode from 'qrcode'
import {loadConfig, ROOT_DIR} from './config'
import {
  CONTRACTS_MAX_AGE_MS,
  ensureContractsFresh,
  loadContracts
} from './contracts'
import {marketCapRanks, rankOf, refreshMarketCapRanks} from './data/marketcap'
import {fullSystem, loadExtractRules, loadRules} from './rules'
import {
  checkDb,
  closePool,
  dbHelpMessage,
  ensureSchema,
  query
} from './db/client'
import {collectServerStatus, recentSamples, startSampling} from './system'
import {pruneOldData} from './db/prune'
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
import {
  recordUsage,
  usageByKey,
  usageCalls,
  usageHeadline,
  usageSummary
} from './db/usage'
import {
  ADMIN_USERNAME,
  accountForTotp,
  changePassword,
  checkLogin,
  cleanupSessions,
  consumeRecoveryCode,
  createUser,
  deleteSession,
  deleteUser,
  disableTotp,
  enableTotp,
  ensureAdmin,
  getTotpState,
  listSessions,
  listUsersForAdmin,
  readTotpPending,
  renameUser,
  revokeOtherSessions,
  revokeSession,
  seedAdminLlmFromEnv,
  setTotpLastStep,
  setTotpPending,
  setUserPassword,
  startSession,
  touchSession,
  userByToken,
  verifyUserPassword,
  type SessionMeta,
  type User
} from './db/users'
import {clientIp} from './util/device'
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecovery,
  otpauthUrl,
  verifyTotp
} from './util/totp'
import {MAX_PINS, listPins, togglePin} from './db/pins'
import {
  MARKET_TYPES,
  createExchangeKey,
  deleteExchangeKey,
  getDefaultExchangeKey,
  getExchangeKey,
  listExchangeKeys,
  maskCred,
  setDefaultExchangeKey,
  updateExchangeKey,
  type ExchangeKey
} from './db/exchange-keys'
import {
  EXCHANGE_CATALOG,
  fetchOpenOrders,
  humanize
} from './data/exchange-account'
import {
  collectTradeInfo,
  humanizeTrade,
  placeTestOrder,
  setSymbolLeverage
} from './data/exchange-trade'
import {fetchExchangeOverview} from './data/exchange-overview'
import {
  firstSnapshotHours,
  latestSnapshot,
  listCurve,
  listFills,
  saveSnapshot
} from './db/exchange-store'
import {
  startExchangeStreams,
  startSnapshotSampler,
  stopExchangeStreams,
  subscribeExchange,
  publishSnapshot
} from './exchange-stream'
import {
  backfillUsageKeys,
  createLlmKey,
  deleteLlmKey,
  getDefaultLlmKey,
  listLlmKeys,
  maskKey,
  migrateLegacyLlm,
  resolveUserLlm,
  saveUserLlm,
  setDefaultLlmKey,
  updateLlmKey
} from './db/llm-keys'
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
  warmExchange,
  type MarketRow,
  type TickerInfo
} from './data/market'
import {
  STORE_MAX_LIMIT,
  getLatestCandles,
  startKlineKeepWarm
} from './data/kline-store'
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
  '.apk': 'application/vnd.android.package-archive',
  '.woff2': 'font/woff2'
}

/** Vite 产物带内容哈希，可以长期缓存 */
const HASHED_ASSET = /-[\w-]{8,}\.(js|css|woff2)$/

/* ------------------------------------------------------------------ */
/* 基础设施                                                            */
/* ------------------------------------------------------------------ */

/**
 * 跨域放行名单（2026-10-04 收窄：原来是 `Access-Control-Allow-Origin: *`）。
 *
 * 真正需要跨域的只有**手机 App**：Capacitor 把页面放在 WebView 的本地来源下
 * （Android → `https://localhost`、iOS → `capacitor://localhost`），
 * 调 `https://bitcoooin.cn` 是真跨域，必须放行。
 * 网页版是同源（前端就是这个进程托管的）本来用不到 CORS；
 * 本机开发（`http://localhost:5173` 之类）顺手放行，别把自己卡住。
 *
 * 现在**按 Origin 白名单**回：命中就把那个 Origin 原样回过去，没命中就不带这个头
 * （浏览器自己会拦）。认证走 `Authorization` 头、不是 Cookie，所以收窄后
 * 也不会引入 CSRF 问题。
 */
const CORS_ORIGIN_RE =
  /^(https?:\/\/localhost(:\d+)?|capacitor:\/\/localhost|https:\/\/bitcoooin\.cn)$/

/** 这些头跟 Origin 无关，所有响应都带上 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  // 同一个 URL 对不同 Origin 回的 CORS 头不一样，必须告诉缓存分键
  Vary: 'Origin'
}

/**
 * 请求一进来就把 CORS 头挂到响应上。
 * 用 `setHeader`（**不是** writeHead）—— 后面各处 `res.writeHead(...)` 会自动
 * 合并已经设过的头，所以 `sendJson` 和那几个 SSE / 图标出口一个都不用改。
 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v)
  const origin = String(req.headers.origin ?? '').slice(0, 200)
  if (origin && CORS_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
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

/* ------------------------------------------------------------------ */
/* 下载分发（/download 页 + /dl/*）                                     */
/* ------------------------------------------------------------------ */

/**
 * 下载目录 —— APK 就放这儿。
 *
 * · 线上：Caddy 挂了 `./downloads:/srv/dl:ro`，`/dl/*` 由 **Caddy 直接发**，
 *   请求压根到不了本进程（见 `Caddyfile` / `docker-compose.prod.yml`）；
 * · 本地：没人帮忙代发，所以下面 `serveDownload()` 自己发一份 ——
 *   这样 `npm run web` 打开 `/download` 页，点了按钮真能下下来。
 *
 * `releases.json` 是手写的清单（介绍 / 更新说明），跟文件同级放。
 * 磁盘上有、清单里没写的 APK 也会列出来（标成「未登记」），不让谁隐身。
 */
const DOWNLOAD_DIR = path.join(ROOT_DIR, 'downloads')
const RELEASES_FILE = path.join(DOWNLOAD_DIR, 'releases.json')

interface ReleaseMeta {
  version?: string
  file?: string
  date?: string
  title?: string
  notes?: string[]
  /** 显式标「不是推荐版本」；一般不用写 —— 版本号最大的自动算推荐 */
  deprecated?: boolean
}

interface ReleasesDoc {
  app?: {
    name?: string
    packageId?: string
    desc?: string
    require?: string
    sizeHint?: string
    install?: string[]
  }
  releases?: ReleaseMeta[]
}

/** `entry-advisor-0.1.0.apk` → `0.1.0` */
function versionFromFile(file: string): string {
  const m = file.match(/(\d+(?:\.\d+)*)(?=\.apk$)/i)
  return m ? m[1] : file.replace(/\.apk$/i, '')
}

/** 版本号比较（数字段逐个比，`0.10.0` 要大于 `0.9.0`） */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(n => Number(n) || 0)
  const pb = b.split('.').map(n => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * APK 的 md5 —— 页面上显示出来方便核对下载有没有坏。
 * 4MB 的包没必要每次请求都重算，按「路径 + 大小 + mtime」缓存，文件一变自动失效。
 */
const md5Cache = new Map<string, {key: string; hex: string}>()

function fileMd5(file: string): string {
  const st = fs.statSync(file)
  const key = `${st.size}:${st.mtimeMs}`
  const hit = md5Cache.get(file)
  if (hit?.key === key) return hit.hex
  const hex = createHash('md5').update(fs.readFileSync(file)).digest('hex')
  md5Cache.set(file, {key, hex})
  return hex
}

/** 北京时间 YYYY-MM-DD */
function bjDate(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 列清单：`releases.json` 的介绍 + 磁盘上真实的文件信息（大小 / md5 / 时间） */
function listDownloads() {
  let doc: ReleasesDoc = {}
  try {
    doc = JSON.parse(fs.readFileSync(RELEASES_FILE, 'utf8')) as ReleasesDoc
  } catch {
    /* 没清单就只按文件列 */
  }

  let onDisk: string[] = []
  try {
    onDisk = fs
      .readdirSync(DOWNLOAD_DIR)
      .filter(f => f.toLowerCase().endsWith('.apk'))
  } catch {
    /* 目录还不存在（没打过包） */
  }

  const metas: ReleaseMeta[] = [...(doc.releases ?? [])]
  for (const f of onDisk) {
    if (!metas.some(m => m.file === f)) metas.push({file: f})
  }

  const releases = metas
    .filter((m): m is ReleaseMeta & {file: string} => Boolean(m.file))
    .map(m => {
      const file = path.join(DOWNLOAD_DIR, m.file)
      let size = 0
      let mtime = 0
      let md5: string | null = null
      try {
        const st = fs.statSync(file)
        size = st.size
        mtime = Math.round(st.mtimeMs)
        md5 = fileMd5(file)
      } catch {
        /* 清单里写了、文件不在（本地没打包时很常见）*/
      }
      return {
        version: m.version ?? versionFromFile(m.file),
        file: m.file,
        url: `/dl/${encodeURIComponent(m.file)}`,
        title: m.title ?? '',
        date: m.date ?? (mtime ? bjDate(mtime) : ''),
        notes: m.notes ?? [],
        /** 清单里登记过 / 还是磁盘上捡到的 */
        listed: Boolean(m.title || m.notes?.length || m.date),
        size,
        mtime,
        md5,
        deprecated: Boolean(m.deprecated),
        latest: false
      }
    })
    .filter(r => r.size > 0)
    .sort((a, b) => cmpVersion(b.version, a.version))

  if (releases.length && !releases[0].deprecated) releases[0].latest = true

  // ⚠️ 只回清单，**不回 `DOWNLOAD_DIR` 这个绝对路径** ——
  //    接口是公开的，没必要把容器里的目录结构说出去。
  return {
    app: doc.app ?? {},
    releases
  }
}

/** 本地把 `downloads/` 发出去（线上这一步是 Caddy 干的） */
function serveDownload(res: http.ServerResponse, urlPath: string): void {
  const rel = decodeURIComponent(urlPath.replace(/^\/dl\/?/, '')).replace(
    /^\/+/,
    ''
  )
  const safe = path.normalize(rel)
  const file = path.join(DOWNLOAD_DIR, safe)

  if (
    !safe ||
    safe.startsWith('..') ||
    !file.startsWith(DOWNLOAD_DIR) ||
    !fs.existsSync(file) ||
    !fs.statSync(file).isFile()
  ) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end('没有这个文件')
    return
  }

  const base = path.basename(file)
  res.writeHead(200, {
    'Content-Type':
      MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    // 手机上点了直接存下来，别在浏览器里打开
    'Content-Disposition': `attachment; filename="${base}"`,
    'Cache-Control': 'no-cache'
  })
  fs.createReadStream(file).pipe(res)
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

/**
 * 交易所 Key 只回**掩码**（`abcd****wxyz`）—— 真凭据只留在服务端拿去连交易所。
 * 每个 `*Set` 告诉前端「这一栏填过没有」（前端拿它显示「已设置 / 用掩码表示没改」）。
 */
const publicExchangeKey = (k: ExchangeKey) => ({
  id: k.id,
  exchange: k.exchange,
  name: k.name,
  apiKey: maskCred(k.apiKey),
  apiKeySet: Boolean(k.apiKey),
  secret: maskCred(k.secret),
  secretSet: Boolean(k.secret),
  password: maskCred(k.password),
  passwordSet: Boolean(k.password),
  marketType: k.marketType,
  sandbox: k.sandbox,
  isDefault: k.isDefault,
  createdAt: k.createdAt,
  updatedAt: k.updatedAt
})

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

/**
 * 缓存 + **同 key 并发合并** + **过期先给旧的、后台悄悄刷** —— 给「图表初次取数」用。
 *
 * 为什么需要（2026-10-04 实测定位）：
 *  · `/api/candles` 是唯一**没有缓存**的取数接口（`markets` 5s、`ticker` 15s），
 *    每次开页面 / 切回来都冷着打一趟交易所；
 *  · 非 1h 周期时它**一次要打两趟**（本周期 + 8 根 1h 算压力支撑），
 *    而 fapi 会间歇性 TLS 抖动（实测约 1/6），`withRetry` 退避 200→400ms，
 *    所以实际分布是「**大多数 ~0.2s，偶尔 2.4s**」；
 *  · 页面一打开好几个接口同时发，同一条数据还会并发重复请求。
 *
 * 三段行为：
 *  ① `age < ttlMs`                → 直接回，连交易所都不碰（重复开页面变瞬时）
 *  ② `ttlMs ≤ age < staleMs`      → **先把旧的给出去**，同时后台刷新一份
 *     —— 这一条是关键：只靠 ① 的话，冷却后的**第一次**照样得等币安，
 *        而用户注意到的恰恰是第一次（实测端到端 2.6s）
 *  ③ 再旧                           → 老老实实等一次（数据不能无限陈旧）
 * 外加：**同一个 key 正在飞就等它**，不再另开一条到交易所的连接（减少抖动机会）。
 *
 * ⚠️ 缓存 key 必须带上全部影响结果的参数（币种 / 周期 / 根数 / 区间）——
 *    不然切币种会拿到上一个币的数据。所以干脆用「请求参数的原文」当 key。
 * ⚠️ 失败**不缓存**（把条目删掉），否则一次抖动会让这个 key 在 TTL 内一直错。
 * ⚠️ 后台刷新**必须自己吞掉异常**，否则是一个无人处理的 rejection。
 */
function makeCache<T>(ttlMs: number, staleMs: number, cap: number) {
  type Entry = {at: number; data?: T; inflight?: Promise<T>}
  const map = new Map<string, Entry>()

  function evict(): void {
    // 超过上限就丢最旧的几条（key 空间是「币种 × 周期 × 根数」，不清理会一直涨）
    if (map.size <= cap) return
    const old = [...map.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [k] of old.slice(0, map.size - cap)) map.delete(k)
  }

  /** 真的去打一趟；成功才落缓存 */
  function fetchNow(key: string, fn: () => Promise<T>): Promise<T> {
    const inflight = fn().then(
      data => {
        map.set(key, {at: Date.now(), data})
        evict()
        return data
      },
      err => {
        /*
         * ⚠️ 失败**不要**把整个条目删掉（那是第一版，实测反而更慢）：
         *    删了 = 旧数据也没了，下一发只能阻塞着去问币安，又撞一次抖动
         *    （实测 12 轮里 2 轮 651ms / 1392ms）。
         *    正确做法：**保住旧数据**、只把 inflight 清掉 —— 下一次继续「先给旧的、
         *    后台再刷」。数据真的老到超过 stale 窗口时，③ 那条路自然会强制刷新。
         *    只有「压根没拿到过数据」时才删条目。
         */
        const cur = map.get(key)
        if (!cur || cur.data === undefined) map.delete(key)
        else delete cur.inflight
        throw err
      }
    )
    map.set(key, {
      at: map.get(key)?.at ?? Date.now(),
      data: map.get(key)?.data,
      inflight
    })
    return inflight
  }

  return async function load(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = map.get(key)
    if (hit) {
      const age = Date.now() - hit.at
      if (hit.data !== undefined) {
        if (age < ttlMs) return hit.data
        if (age < staleMs) {
          // 后台刷一份，这份**不 await**：失败就当没发生（吞掉，别变 unhandled）
          if (!hit.inflight) {
            hit.inflight = fetchNow(key, fn).catch(() => {
              // 刷失败 → 把 inflight 清掉，下次再来；旧数据继续用
              const cur = map.get(key)
              if (cur && cur.inflight === hit.inflight) delete cur.inflight
              return hit.data as T
            }) as Promise<T>
          }
          return hit.data
        }
      }
      if (hit.inflight) return hit.inflight // 并发合并
    }
    return fetchNow(key, fn)
  }
}

/** 图表 K 线：4 秒内直接回；4~30 秒之间先给旧的、后台刷 */
const candlesCache = makeCache<Candle[]>(4_000, 30_000, 60)

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

  /*
   * ⚠️⚠️ 缓存 key 里**不能**放「每次现算的时间」。
   *
   * 第一版写成 `...|${rangeFrom}|${rangeTo}`，而**不指定区间**时（正常看图就是
   * 这样）那两个值是 `now - limit*step` 和 `now`，都用 `Date.now()` 算 ——
   * key 每毫秒都不一样，**缓存一次都不会命中**，等于白加（实测才发现：
   * 连打 20 次每次都是 160ms 的真实取数耗时）。
   *
   * 所以：不指定区间就是「最新 N 根」，跟「哪一刻问的」无关，key 里只放
   * `latest`；只有真的带了 from/to 才把区间写进去。
   */
  const cacheKey = ranged
    ? `${config.exchange}|${config.marketType}|${symbol}|${timeframe}|${limit}|${rangeFrom}|${rangeTo}`
    : `${config.exchange}|${config.marketType}|${symbol}|${timeframe}|${limit}|latest`

  /*
   * 「最新 N 根」走**服务端常驻缓存**（`data/kline-store.ts`）：
   * 已收盘的 K 线永不变、只有当前那根在动 —— 没必要让每个用户都把 250 根整体重取一遍
   *（原来走 `candlesCache`，TTL 4 秒 + 528 个币 = 528 次真实上游请求 **× 用户数**）。
   * 带 from/to 的历史区间、以及超大 limit 照旧走下面那条（很少发生）。
   */
  const candles =
    !ranged && limit <= STORE_MAX_LIMIT
      ? await getLatestCandles({
          exchangeId: config.exchange,
          symbol,
          timeframe,
          limit,
          marketType: config.marketType,
          apiBase: config.apiBase
        })
      : await candlesCache(cacheKey, () =>
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
              })
        )

  sendJson(res, 200, {
    symbol,
    timeframe,
    ranged,
    candles,
    /*
     * 压力 / 支撑。
     *
     * ⚠️ 2026-10-04 起**前端不再用它了** —— 图上那两条线改成「按当前可见窗口 +
     *    摆动高低点」现算（见 `frontend/src/levels.ts`），因为固定「最近 4 根 1h」
     *    看 5 分图时跟屏幕上的 K 线没什么关系。
     *    但**字段保留**（老版本 App 还在读它），只是改成用**已经拿到的这串 K 线**算，
     *    不再为它多打一趟交易所 —— 以前非 1h 周期都要额外取 8 根 1h，
     *    等于每次取数都多一次撞币安 TLS 抖动的机会。
     */
    sr: computeRecentSR(candles, 4)
  })
}

/* ---------------- 启动预热：常用币的 K 线 ---------------- */

/**
 * 只吞不吐的响应壳。
 *
 * ⚠️ 只能喂给 `handleCandles` 这种「只调 `sendJson(res, ...)`」的处理函数
 *    （`sendJson` 只用到 `writeHead` + `end`）。
 */
function silentResponse(): http.ServerResponse {
  return {
    writeHead: () => {},
    end: () => {}
  } as unknown as http.ServerResponse
}

/**
 * 启动预热：把「最常点的几个币 × 最常用的周期」的 K 线先取一份放进缓存。
 *
 * 用户 2026-10-04 要的效果：**点币种跳过去，K 线就该已经画出来了**。
 *
 * 路由那一下的等待由前端解决（划过 / 按下某一行时就先取，见
 * `frontend/src/candles.ts`），但**每次部署或重启后的第一个用户**没人替他预取 ——
 * 他要吃一整套冷启动：**这个币的 K 线**（+ 非 1h 周期还要多打一趟 8 根 1h 算压力支撑）。
 * 实测线上那一下是 **2.4s**（之后才降到 0.4s）。这里先把最可能被点的那几个拉好，
 * 于是第一发也是**缓存命中**。
 *
 * ⚠️⚠️ **故意直接调 HTTP 处理器**（假 URL + 丢弃响应的 res），而不是另写一份取数：
 *    缓存 key 是用**请求参数原文**拼的（见 `handleCandles` 里那段注释），
 *    另写一份就有两套 key —— 改一边忘一边 = 预热全白做，而且不报错。
 *    走同一条路，就永远对得上。
 * ⚠️ 串行执行、不 await 在启动流程上（一个 ~150~400ms）；失败只少暖一个币，
 *    用户真点的时候 `withRetry` 会再来一次。
 */
/** 成交额前多少个（与前端 `MarketPanel` 的 `TOP_VOL` 同口径） */
const WARM_TOP_VOL = 60
/** |24h 涨跌幅| 超这个百分比也算要暖的（正在异动，用户大概率会去看） */
const WARM_BIG_MOVE_PCT = 20
/** 拿不到行情清单时的兜底名单 */
const WARM_FALLBACK = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']
/**
 * 启动预热哪些周期。
 *
 * ⚠️ 每多一个周期 = 启动时多「名单长度」次上游请求（60 个币 → **+60 次，约 +10s**；
 *    后台跑、不挡启动，但会占带宽与币安权重）。
 *
 * 用户 2026-10-04 在这里反复调整过（「不用全周期」→「只保留 1h」→ 又发现 **15m 慢**），
 * 所以做成可配：`.env` 里写 `WARM_TFS=1h,15m,5m`；不写就用默认的 **1h + 15m**。
 * 不预热的那几个周期，每个 `(币, 周期)` 的**第一次**请求会现打交易所（~160ms，
 * 撞抖动 0.5~2s），之后就常驻内存（`data/kline-store.ts`）。
 */
const WARM_TIMEFRAMES: Timeframe[] = (() => {
  const list = (process.env.WARM_TFS ?? '1h,15m')
    .split(',')
    .map(s => s.trim())
    .filter((s): s is Timeframe => (VALID_TFS as string[]).includes(s))
  return list.length ? list : ['1h']
})()
/** ⚠️ 必须跟前端一次拉多少根一致（`frontend/src/analyze.ts` 的 `KLINE_BARS` = 250） */
const WARM_LIMIT = 250

/** 预热名单 = 成交额前 N ∪ |24h 涨跌| > 20% —— 与前端 `MarketPanel.warmTargets` 同一个口径 */
async function warmPicks(): Promise<string[]> {
  try {
    const cfg = loadConfig()
    const rows = await fetchMarketList({
      exchangeId: cfg.exchange,
      marketType: cfg.marketType,
      apiBase: cfg.apiBase
    })
    const picked = new Set(
      [...rows]
        .sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
        .slice(0, WARM_TOP_VOL)
        .map(r => r.base)
    )
    for (const r of rows) {
      if (Math.abs(r.change24hPct ?? 0) > WARM_BIG_MOVE_PCT) picked.add(r.base)
    }
    return [...picked]
  } catch {
    /* 交易所抖了就拿不到清单 —— 退回常用那几个，别因为预热把启动流程搞挂 */
    return WARM_FALLBACK
  }
}

async function warmCandlesCache(): Promise<{
  ok: number
  total: number
  /** 名单回给调用方，接着用它预热头部行情 */
  bases: string[]
}> {
  const bases = await warmPicks()
  const total = bases.length * WARM_TIMEFRAMES.length
  let ok = 0
  for (const symbol of bases) {
    for (const timeframe of WARM_TIMEFRAMES) {
      try {
        const url = new URL(
          `/api/candles?symbol=${symbol}&timeframe=${timeframe}&limit=${WARM_LIMIT}`,
          'http://warm.local'
        )
        await handleCandles(url, silentResponse())
        ok += 1
      } catch {
        /* 暖不到就算了 —— 用户真点的时候会自己取 */
      }
    }
  }
  return {ok, total, bases}
}

/**
 * 同时最多预热几个币的头部行情。
 *
 * ⚠️ 每个币要并发打 4 趟交易所，不限并发会在启动瞬间把币安权重打满。
 */
const WARM_TICKER_CONC = 3

/**
 * 启动预热：把同一批币的**头部行情条**也先取好。
 *
 * 为什么需要：`/api/ticker` 一次要并发打 4 趟交易所（ticker + 资金费率 + 持仓量 +
 * 366 根日线），**冷启实测 ~1.07s** —— 点一个新币，头顶那条行情要空一秒
 *（用户 2026-10-04：「k 线图上面的数据信息能否缓存，现在感觉太慢了」）。
 * 预热后就是缓存命中（1~2ms）。
 *
 * ⚠️ 走的是同一个 `handleTicker`（假 URL + 丢弃响应的 res）—— 缓存 key 对得上。
 */
async function warmTickerCache(
  bases: string[]
): Promise<{ok: number; total: number}> {
  let ok = 0
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < bases.length) {
      const symbol = bases[i++]
      try {
        await handleTicker(
          new URL(`/api/ticker?symbol=${symbol}`, 'http://warm.local'),
          silentResponse()
        )
        ok += 1
      } catch {
        /* 暖不到就算了 */
      }
    }
  }
  await Promise.all(
    Array.from({length: Math.min(WARM_TICKER_CONC, bases.length)}, () =>
      worker()
    )
  )
  return {ok, total: bases.length}
}

/**
 * 头部行情条缓存。
 *
 * ⚠️ 2026-10-04 把 TTL 从 **15 秒拉到 60 秒**：
 *    15 秒太短 —— 客户端本就是 15 秒一刷，等于**每 15 秒就把当前活跃币重打一遍上游**
 *   （一次 4 趟）。而这个接口冷启实测 **~1.07s**，用户感受得到的慢就在这。
 *    60 秒内直接回；60 秒以上**先给旧的、后台再刷**。
 *
 * ⚠️⚠️ 又一轮（用户：「不是添加了行情预热功能吗 60 个币种怎么还是慢」）：
 *    `stale` 原来是 **10 分钟** —— 也就是说**启动预热只顶 10 分钟**：
 *    一个币超过 10 分钟没人看，再点它就走 ③「老老实实等一次」（实测
 *    `/api/ticker?symbol=XRP` **699ms**、BNB **318ms**，冷启最差 1.07s）。
 *    60 个币，用户不可能每 10 分钟全看一遍，于是「预热过」的币照样等一秒。
 *    现在 `stale` 拉到 **24 小时**：预热过的币一整天都走 ②「先给旧的、后台再刷」，
 *    **永远不会阻塞**；真放了 24 小时没人看，才回退到 ③ 等一次。
 *    价格晚一点无所谓 —— 前端头部吃的实时价是 K 线 WS 推的（`ticker.ts` 的
 *    `freshLivePrice`），资金费率倒计时也是本地算的；而且**每次访问都会顺手后台刷一份**。
 *    cap 200 → 300：装下预热那批（成交额前 60 ∪ 异动），再留点余量给随手点开的币。
 *
 * ⚠️⚠️ 2026-10-05 又改回来（用户：「k 线上面成交量 / 高低价这些数据都没更新」）：
 *    60 秒太「钝」—— 前端 15 秒一刷，可这 60 秒里每次都返回同一份；`stale` 设成
 *    24 小时的本意是「先给旧的、后台再刷」，但客户端只会在**下一次**轮询（15 秒后）
 *    才拿到新的，表现就是「一分钟才动一下」，用户以为坏了。
 *    现在直接 `ttl = stale = 15 秒`：**过期就阻塞拉一份新的**（第 ③ 条路），
 *    客户端每次轮询拿到的都是 15 秒以内的数据。一次 4 趟上游、15 秒一遍，
 *    对一台个人服务器 + 币安 2400 权重/分钟 完全无压力。
 */
const tickerCache = makeCache<TickerInfo>(15_000, 15_000, 300)

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

  try {
    const data = await tickerCache(key, () =>
      fetchTickerInfo({
        exchangeId: config.exchange,
        symbol,
        marketType: config.marketType,
        apiBase: config.apiBase
      })
    )
    sendJson(res, 200, data)
  } catch (e) {
    // 头部行情挂了不该拖垮整个页面：前端自己会把这项显示成「—」
    sendJson(res, 502, {error: (e as Error).message})
  }
}

/**
 * 合约行情列表（参考币安「合约行情」页）。
 *
 * 界面上几秒刷一次，**必须缓存**：一次请求就是交易所全量 24h ticker
 * （实测 ~24KB / 528 个合约），多开几个标签页 / 多人同时看时不能各打各的。
 * 5 秒足够「实时」了。
 *
 * ⚠️ 2026-10-04 改成与 K 线同一套 `makeCache`：冷的时候同样会撞币安 TLS 抖动
 *    （线上实测有一次 2.097s），而它是**首页**那个列表的数据源。
 *    所以：5 秒内直接回；5 秒~2 分钟之间**先给旧的、后台再刷**。
 *    （列表本身每秒都有 WS 增量在推，这份快照只当「底稿」，旧几秒毫无影响）
 */
const marketsCache = makeCache<{rows: MarketRow[]; at: number}>(
  5_000,
  120_000,
  10
)

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

  try {
    // 「取数时刻」跟数据一起进缓存：命中（包括直接给旧那份）时报的才是**上次真正拉到的**时间，
    // 而不是「这次请求的时间」—— 那种写法会假装刚更新过。
    const v = await marketsCache(key, async () => ({
      rows: await fetchMarketList({
        exchangeId: config.exchange,
        marketType: config.marketType,
        apiBase: config.apiBase
      }),
      at: Date.now()
    }))
    /*
     * 顺带把市值排名贴上去（用户 2026-10-04：「24h 替换成市值排名 如 no.1」）。
     * ⚠️ 贴在这层而**不是** `fetchMarketList` 里：那份是缓存好的，
     * 排名有自己的 6 小时刷新节奏，混在一起会让行情表被排名拖住/反过来。
     * `marketCapRanks()` 是同步的，拿不到就是空 Map（少一项而已，不影响行情）。
     */
    const ranks = marketCapRanks()
    const rows = ranks.size
      ? v.rows.map(r => ({...r, rank: rankOf(ranks, r.base)}))
      : v.rows
    sendJson(res, 200, {rows, updatedAt: v.at})
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
  /** 谁在分析（用户系统） */
  userId: number
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

  // 用哪把密钥：**默认**那把（多密钥，2026-10-04）；用量会记到它名下
  const resolved = await resolveUserLlm(opts.userId)
  const config = loadConfig({
    marketType: market,
    timeframes: [timeframe],
    llm: resolved.llm
  })
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
      loadTagTemplates(opts.userId),
      listTags(opts.userId)
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
    userId: opts.userId,
    llmKeyId: resolved.keyId,
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
        userId: opts.userId,
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
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const params = analyzeParams(url.searchParams)
  if (!params.symbol) {
    sendJson(res, 400, {error: '请先选择币种'})
    return
  }
  try {
    sendJson(res, 200, await runAnalysis({...params, userId: user.id}))
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
  /*
   * 心跳：**必须是具名事件**，不能写成 SSE 注释行（`: ping`）。
   * 注释行浏览器不会派发给 JS，前端那套「多久没动静就判定连接已死」的看门狗
   * 就瞎了 —— 手机切后台回来的僵尸连接全靠它收（见 `frontend/src/api.ts` 的 `liveSse`）。
   * 下面 analyze / knowledge 那两条是**任务型**一次性流，不收僵尸，用注释行就行。
   */
  const beat = setInterval(() => send('heartbeat', {}), 20_000)

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
  /* 心跳必须是具名事件，理由同上 */
  const beat = setInterval(() => send('heartbeat', {}), 20_000)

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
 * 交易所资产的实时推送（SSE）—— M2 第二件事（方案见 `docs/EXCHANGE.md`）。
 *
 * 事件：
 *   `open`      握手（keyId / 交易所 / 名字 / 市场类型）
 *   `snapshot`  最新快照。**载荷与 `GET /api/exchange/overview` 逐字对齐**，
 *               连上先补一条当底稿（前端不用再 GET 一次就能渲染），之后
 *               WS 事件 / 5 分钟采样 / 用户点刷新 都会推。
 *   `fill`      新成交（WS 实时）
 *   `backfill`  REST 补成交的汇总（前端收到重拉一次成交列表）
 *   `reject`    这套账户不参与统计（现货 / 没填 Key）—— ⚠️ **前端收到必须
 *               `es.close()`**，否则 EventSource 会自动重连，变成一个死循环。
 *   `heartbeat` 20 秒一次（**必须是具名事件**，理由见 `handleKlineStream`）
 *
 * ⚠️ 事件按 `key_id` 广播（`subscribeExchange`），key 是**校验过属于当前用户**的，
 *    所以不会串到别人账上。
 */
async function handleExchangeStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: number,
  keyId: number,
  account: ReturnType<typeof publicExchangeKey>,
  reject: string | null
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
  /* 只取展示要用的四个字段 —— 掩码、id 这些不往流里发 */
  const boardAccount = {
    exchange: account.exchange,
    name: account.name,
    marketType: account.marketType,
    sandbox: account.sandbox
  }

  if (reject) {
    send('open', {account})
    send('reject', {account, noSnapshot: true, reason: reject})
    res.end()
    return
  }
  send('open', {account})

  // 底稿：库里最近一条（毫秒级，不打交易所）；读失败不致命，后面还有实时事件
  try {
    const snap = await latestSnapshot(userId, keyId)
    send(
      'snapshot',
      snap
        ? {
            account,
            noSnapshot: false,
            overview: {...snap.overview, account: boardAccount},
            source: snap.source,
            ageSec: snap.ageSec,
            stale: snap.stale,
            err: snap.err
          }
        : {
            account,
            noSnapshot: true,
            reason: '还没采过这个账户（点一下刷新）'
          }
    )
  } catch (e) {
    console.warn('[exchange/stream] 底稿读取失败：', (e as Error).message)
  }

  const unsubscribe = subscribeExchange(keyId, ev => {
    if (ev.type === 'snapshot') {
      send('snapshot', {
        account,
        noSnapshot: false,
        overview: {...ev.overview, account: boardAccount},
        source: ev.source,
        ageSec: 0,
        stale: false,
        err: null
      })
      return
    }
    if (ev.type === 'fill') return send('fill', ev.fill)
    return send('backfill', {added: ev.added})
  })
  /* 心跳必须是具名事件，理由同上 */
  const beat = setInterval(() => send('heartbeat', {}), 20_000)

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
 * 浏览器那边 `max-age` 七天。
 * ⚠️ 找不到**不再回 404**，而是现画一张首字母圆回 200 —— 为什么，见下面
 *    `letterIcon` 那一大段说明（用户 2026-10-05：「合约行情页面报错」）。
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
/** 缓存上限：正常就 528 个币，超了说明有人在乱刷 key，直接清空重来 */
const ICON_CACHE_MAX = 2000

/*
 * ──────────────── 没有图标时：服务端自己画一张「首字母圆」 ────────────────
 *
 * ⚠️⚠️ 用户 2026-10-05：「合约行情页面报错」—— 拿来的是一屏控制台红字：
 *
 *     MarketPanel.vue:172  GET /api/icon/ain?v=2 404 (Not Found)
 *     MarketPanel.vue:172  GET /api/icon/us?v=2   404 (Not Found)
 *     MarketPanel.vue:172  GET /api/icon/%E9%BE%99%E8%99%BE?v=2 400 (Bad Request)
 *
 * 原因：前端是 `<img src="/api/icon/xxx">`，而**浏览器对任何加载失败的 `<img>`
 * 都会在控制台打一行红字**（404 也一样）。实测 528 个合约里有 122 个图标源都没有
 *（新上币、中文名的、BTCDOM 这种指数）—— 一屏 120 行里就有十来个，所以控制台常年刷红。
 *
 * 这行红字**消不掉**：改 CSS `background-image` 确实不报错，但那样就分不清「有图标」
 * 和「没图标」了（首字母会从图标底下透出来）；改成 JS `fetch` 一样会报
 *（fetch 拿到 404 同样打红字）。唯一能让控制台干净的办法就是**别回错误码**。
 *
 * 所以把前端原来那张首字母占位**搬到服务端画**：
 *  · 颜色算法跟前端 `MarketPanel.letterColor()` **逐字一致**：
 *    `h = (h*31 + charCode) % 360`、`hsl(h 52% 38%)`，种子用**原始大小写**的币种名
 *  · 字母大小按 `.ico-letter` 量：26px 的圆里 14px 字 ⇒ 100 的 viewBox 里 54，
 *    字重 700、白色、居中 —— 换过来基本看不出区别
 *  · 前端那条 `.ico-letter` 老路**留着**（真遇到网络错误时兜底）
 */

/** 首字母圆的色相 —— ⚠️ 跟前端的 `letterColor()` 是同一份算法，改要两边一起改 */
function letterHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360
  return h
}

/** SVG 文本要转义（币种名里出现 `&` / `<` 也不会把文档搞坏） */
function xmlEsc(s: string): string {
  return s.replace(/[&<>]/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
  )
}

/** 画一张「首字母圆」（没有图标时的兜底，说明见上面那段） */
function letterIcon(seed: string): {buf: Buffer; type: string} {
  const ch = seed.slice(0, 1).toUpperCase()
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    `<circle cx="50" cy="50" r="50" fill="hsl(${letterHue(seed)},52%,38%)"/>` +
    '<text x="50" y="50" dy="0.35em" text-anchor="middle" fill="#fff" font-size="54" font-weight="700" ' +
    `font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Noto Sans SC,sans-serif">${xmlEsc(ch)}</text>` +
    '</svg>'
  return {buf: Buffer.from(svg, 'utf8'), type: 'image/svg+xml'}
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
  /*
   * ⚠️ 路由传进来的是 **`url.pathname`（没解码）** —— 实测 `/api/icon/%41in`
   *    拿到的是字面量 `%41in`（见 `const p = url.pathname`）。中文名合约
   *    （龙虾 / 牛来 / 哈基米…）不先解码就是一堆 `%E9…`，首字母圆会画成一个「%」。
   */
  let raw = sym
  try {
    raw = decodeURIComponent(sym)
  } catch {
    // 坏的百分号转义（`%zz`）会抛，按原样用
  }
  raw = raw.trim()
  const key = raw.toLowerCase()

  /*
   * 只有「像图标键」的才值得去问那三套图标源：纯 ASCII 字母/数字（可带 `-`）。
   *
   * ⚠️ 币安真有中文名的合约（实测 5 个：哈基米 / 币安人生 / 我踏马来了 / 牛来 / 龙虾），
   *    那些图库里**必然没有**，没必要为它们打三次上游；
   *    顺带也挡住了把 `/` `.` `?` 塞进来拼上游 URL 的可能。
   *
   * ⚠️⚠️ 但这**不是「客户端请求错了」** —— 原来这里回的是
   *    `400 {error:'币种不合法'}`，于是这 5 个币在用户控制台里变成 5 行 400
   *（看着像我们代码有 bug）。现在一律走「没有图标」那条路。
   */
  const probeable = /^[a-z0-9][a-z0-9-]{0,23}$/.test(key)

  let hit = iconCache.get(key)
  if (hit === undefined) {
    if (!probeable) {
      hit = null
    } else {
      /*
       * 候选键：先用原样，再去掉开头的数字。
       * `1000PEPE` / `1000SHIB` 这种，图标站多数只认 `pepe` / `shib`。
       */
      const stripped = key.replace(/^\d+/, '')
      const keys = stripped && stripped !== key ? [key, stripped] : [key]
      hit = await fetchIcon(keys)
    }
    // 找不到也记一笔（null），别每次开页面都为同一个币把三个源都问一遍
    iconCache.set(key, hit)
    if (iconCache.size > ICON_CACHE_MAX) iconCache.clear()
  }

  if (hit) {
    res.writeHead(200, {
      'Content-Type': hit.type,
      'Content-Length': hit.buf.length,
      'Cache-Control': 'public, max-age=604800',
      ...CORS
    })
    res.end(hit.buf)
    return
  }

  /*
   * 没有真图标 → 现画一张首字母圆（**200，不是 404**，为什么见 `letterIcon` 那段）。
   * ⚠️ 缓存只给 **1 天**（不是图标那 7 天）：以后补了图标源 / 这币上了图库，
   *    一天后浏览器就自己来取新的了。
   */
  const avatar = letterIcon(raw || '?')
  res.writeHead(200, {
    'Content-Type': avatar.type,
    'Content-Length': avatar.buf.length,
    'Cache-Control': 'public, max-age=86400',
    ...CORS
  })
  res.end(avatar.buf)
}

/**
 * 带进度的分析（Server-Sent Events）。
 * 一路上推 `step`，最后推 `done`（内容与 /api/analyze 完全一致）。
 */
async function handleAnalyzeStream(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User
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
      userId: user.id,
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
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const body = await readJsonBody(req)
  const params = collectInput(k => body[k])
  if ('error' in params) {
    sendJson(res, 400, {error: params.error})
    return
  }
  sendJson(res, 200, await collectCase({...params, userId: user.id}))
}

/**
 * 带进度的案例提炼（Server-Sent Events）。
 * 一路上推 `step`，最后推 `done`（内容与 POST /api/knowledge 完全一致）。
 */
async function handleCollectStream(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User
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
      userId: user.id,
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
  res: http.ServerResponse,
  user: User
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
    userId: user.id,
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
async function handleListTags(
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const [rows, used] = await Promise.all([
    listTagTemplates(user.id),
    listTags(user.id)
  ])
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
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
  try {
    sendJson(res, 201, await addTagTemplate(user.id, body.name))
  } catch (e) {
    sendJson(res, 400, {error: (e as Error).message})
  }
}

async function handleUpdateTagTemplate(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
  try {
    const row = await renameTagTemplate(user.id, id, body.name)
    sendJson(res, row ? 200 : 404, row ?? {error: '模板不存在'})
  } catch (e) {
    sendJson(res, 400, {error: (e as Error).message})
  }
}

async function handleMoveTagTemplate(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  const dir = body?.dir === 'up' ? 'up' : 'down'
  const ok = await moveTagTemplate(user.id, id, dir)
  sendJson(res, 200, {ok})
}

async function handleDeleteTagTemplate(
  id: number,
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const ok = await deleteTagTemplate(user.id, id)
  sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '模板不存在'})
}

/** PATCH /api/knowledge/:id —— 只改文案，K 线不动 */
async function handleUpdateCase(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User
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

  const ok = await updateCase(id, user.id, patch)
  sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '案例不存在'})
}

/** POST /api/knowledge/:id/reedit —— 用库里存下的 K 线重跑一次 AI 提炼 */
async function handleReeditCase(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const body = await readJsonBody(req)
  const result = await reeditCase(id, {
    userId: user.id,
    note: typeof body.note === 'string' ? body.note : undefined
  })
  sendJson(res, 200, result)
}

async function handleGetCase(
  id: number,
  res: http.ServerResponse,
  user: User
): Promise<void> {
  const row = await getCase(id, user.id)
  if (!row) {
    sendJson(res, 404, {error: '案例不存在'})
    return
  }
  sendJson(res, 200, {case: row})
}

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从请求里取 token。
 *
 * 首选 `Authorization: Bearer <token>`；SSE（EventSource）**发不了请求头**，
 * 所以也接受 `?token=`。
 */
function bearerToken(req: http.IncomingMessage, url: URL): string {
  const h = req.headers.authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (m) return m[1].trim()
  return (url.searchParams.get('token') ?? '').trim()
}

/**
 * 当前登录用户；没带 token / token 无效 → null。
 *
 * ⚠️⚠️ **查库出错要往外抛，不能吞成 null** —— 吞了就等于把「数据库抖了一下」
 *     变成 401「请先登录」，而前端（`api.ts` 的 `req()`）一见到 401 就
 *     `setAuthToken('')` 把本地 token **真删掉** → 用户被永久踢下线，
 *     得重新输密码（还多一道 TOTP）。2026-10-04 线上就这么发生过一次
 *     （用户报「token 卡掉」）。调用方统一走 `authUser()`，把出错变成 503。
 */
async function currentUser(
  req: http.IncomingMessage,
  url: URL
): Promise<User | null> {
  const t = bearerToken(req, url)
  if (!t) return null
  const user = await userByToken(t)
  if (user) touchSoon(t)
  return user
}

/**
 * 取当前用户，**顺手把「数据库不通」和「没登录」分开**：
 *  · token 无效 / 没带 → `null`（调用方回 401，客户端该登出就登出）
 *  · 查库出错 → 写 503 并返回 `undefined`（**调用方直接 return**，别再写响应）
 */
async function authUser(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<User | null | undefined> {
  try {
    return await currentUser(req, url)
  } catch (e) {
    fail(res, 'auth', e)
    return undefined
  }
}

/*
 * 「最后活跃」刷新节流。
 *
 * 用户 2026-10-04：「账户支持多端登录」→ 设备列表要显示最后活跃时间。
 * 每个请求都写一行库太浪费（一次分析就是十几个请求），所以**同一 token
 * 每分钟最多写一次** —— 精确到分钟够用了。
 */
const touchAt = new Map<string, number>()
const TOUCH_MS = 60_000

function touchSoon(token: string): void {
  const now = Date.now()
  const last = touchAt.get(token) ?? 0
  if (now - last < TOUCH_MS) return
  touchAt.set(token, now)
  if (touchAt.size > 2000) {
    for (const [k, v] of touchAt) if (now - v > TOUCH_MS * 10) touchAt.delete(k)
  }
  void touchSession(token).catch(() => undefined)
}

/*
 * 两步验证的「中间票」：密码过了、6 位码还没过的那一小段。
 *
 * 放内存就够（5 分钟、最多错 5 次）；重启丢掉也只是让人重新输一次密码，
 * 不值得为它建表。
 */
interface TotpTicket {
  userId: number
  exp: number
  tries: number
}
const totpTickets = new Map<string, TotpTicket>()
const TICKET_MS = 5 * 60_000
const TICKET_TRIES = 5

function issueTicket(userId: number): string {
  const now = Date.now()
  for (const [k, v] of totpTickets) if (v.exp <= now) totpTickets.delete(k)
  const t = randomBytes(24).toString('hex')
  totpTickets.set(t, {userId, exp: now + TICKET_MS, tries: 0})
  return t
}

/** 登录时顺手记的设备信息（给「登录设备」列表用） */
function sessionMeta(req: http.IncomingMessage): SessionMeta {
  return {
    userAgent: String(req.headers['user-agent'] ?? ''),
    ip: clientIp(
      req.headers as Record<string, unknown>,
      req.socket.remoteAddress
    )
  }
}

/**
 * 不需要登录的接口：行情 / K 线 / 币种 / 图标 / 健康检查 / 下载清单。
 * 其余（分析、存档、知识库、标签、用量、账户、服务器监测）全要登录。
 */
function isPublicApi(p: string): boolean {
  return (
    p === '/api/health' ||
    p === '/api/contracts' ||
    p === '/api/candles' ||
    p === '/api/ticker' ||
    p === '/api/markets' ||
    p === '/api/kline/stream' ||
    p === '/api/tickers/stream' ||
    p === '/api/downloads' ||
    p.startsWith('/api/icon/')
  )
}

/** `/api/auth/*` */
async function handleAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  p: string
): Promise<void> {
  const method = req.method ?? 'GET'

  if (p === '/api/auth/logout' && method === 'POST') {
    const t = bearerToken(req, url)
    if (t) await deleteSession(t).catch(() => undefined)
    return sendJson(res, 200, {ok: true})
  }

  if (p === '/api/auth/me' && method === 'GET') {
    const user = await authUser(req, res, url)
    if (user === undefined) return
    if (!user) return sendJson(res, 401, {error: '未登录'})
    return sendJson(res, 200, {user})
  }

  /* 改密码：成功后会踢掉所有会话，前端要重新登录 */
  if (p === '/api/auth/password') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const user = await authUser(req, res, url)
    if (user === undefined) return
    if (!user) return sendJson(res, 401, {error: '请先登录'})
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      await changePassword(
        user.id,
        str(body.oldPassword),
        str(body.newPassword)
      )
      return sendJson(res, 200, {ok: true, relogin: true})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /* 改用户名（「个人信息」页） */
  if (p === '/api/auth/profile') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const user = await authUser(req, res, url)
    if (user === undefined) return
    if (!user) return sendJson(res, 401, {error: '请先登录'})
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const updated = await renameUser(user.id, body.username)
      return sendJson(res, 200, {ok: true, user: updated})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  if (p === '/api/auth/register' || p === '/api/auth/login') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    /*
     * 用户 2026-10-04：「不开放注册」—— 账号一律由管理员在
     * 「我的 → 管理」里创建。这里直接挡掉，别再让人自己注册。
     */
    if (p === '/api/auth/register') {
      return sendJson(res, 403, {
        error: '注册已关闭，请联系管理员创建账号'
      })
    }
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const check = await checkLogin({
        username: str(body.username),
        password: str(body.password)
      })
      /*
       * 开了两步验证的账号：**这里先不发 token**，给一张 5 分钟的中间票，
       * 等 `/api/auth/totp/verify` 过了第二关才真正登录。
       */
      if (check.totpEnabled) {
        return sendJson(res, 200, {
          needTotp: true,
          username: check.user.username,
          ticket: issueTicket(check.user.id)
        })
      }
      const s = await startSession(check.user.id, sessionMeta(req))
      return sendJson(res, 200, {
        token: s.token,
        expiresAt: s.expiresAt,
        user: check.user
      })
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /* 两步验证第二关：中间票 + 6 位动态口令（也收恢复码） */
  if (p === '/api/auth/totp/verify') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const ticket = str(body.ticket)
    const code = str(body.code).trim()
    const tk = totpTickets.get(ticket)
    if (!tk || tk.exp <= Date.now()) {
      totpTickets.delete(ticket)
      return sendJson(res, 400, {error: '验证超时了，请重新登录'})
    }
    if (++tk.tries > TICKET_TRIES) {
      totpTickets.delete(ticket)
      return sendJson(res, 400, {error: '错误次数太多，请重新登录'})
    }
    const acc = await accountForTotp(tk.userId)
    if (!acc?.secret) {
      totpTickets.delete(ticket)
      return sendJson(res, 400, {error: '这个账号没开两步验证，请重新登录'})
    }
    /*
     * 6 位纯数字 = 动态口令；其它形状当**恢复码**（用一次就作废）。
     */
    const looksLikeCode = /^\d{6}$/.test(code)
    let pass = false
    if (looksLikeCode) {
      const step = verifyTotp(acc.secret, code)
      // 同一个时间步只准用一次（防止别人截到屏幕上的码直接复用）
      if (step !== null && step > acc.lastStep) {
        await setTotpLastStep(tk.userId, step)
        pass = true
      }
    } else if (code) {
      pass = await consumeRecoveryCode(tk.userId, hashRecovery(code))
    }
    if (!pass) {
      return sendJson(res, 400, {
        error: looksLikeCode ? '动态口令不对' : '恢复码不对或已经用过'
      })
    }
    totpTickets.delete(ticket)
    const s = await startSession(tk.userId, sessionMeta(req))
    return sendJson(res, 200, {
      token: s.token,
      expiresAt: s.expiresAt,
      user: acc.user,
      recoveryUsed: !looksLikeCode
    })
  }

  /*
   * 以下都要先登录 —— 放在 `handleAuth` 里是**必须**的：
   * `route()` 里 `p.startsWith('/api/auth/')` 会先接走，
   * 写到下面的受保护区会被这里 404（踩过）。
   */
  const need = async (): Promise<User | null | undefined> => {
    const u = await authUser(req, res, url)
    /* `undefined` = 数据库不通，`authUser` 已经写过 503 了 */
    if (u === undefined) return undefined
    if (!u) sendJson(res, 401, {error: '请先登录'})
    return u
  }

  /* 这个账号现在在哪些设备上登着 */
  if (p === '/api/auth/sessions') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const u = await need()
    if (!u) return
    const sessions = await listSessions(u.id, bearerToken(req, url))
    return sendJson(res, 200, {sessions})
  }

  /* 踢掉某一台（只能踢自己的） */
  if (p === '/api/auth/sessions/revoke' && method === 'POST') {
    const u = await need()
    if (!u) return
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const id = Number(body.id)
    if (!Number.isFinite(id)) return sendJson(res, 400, {error: '缺 id'})
    const ok = await revokeSession(u.id, id)
    if (!ok)
      return sendJson(res, 404, {error: '没找到这条会话（可能已经下线）'})
    return sendJson(res, 200, {ok: true})
  }

  /* 除本机以外全部下线 */
  if (p === '/api/auth/sessions/revoke-others' && method === 'POST') {
    const u = await need()
    if (!u) return
    const n = await revokeOtherSessions(u.id, bearerToken(req, url))
    return sendJson(res, 200, {ok: true, revoked: n})
  }

  /* 两步验证状态（「个人信息」页显示用） */
  if (p === '/api/auth/totp' && method === 'GET') {
    const u = await need()
    if (!u) return
    return sendJson(res, 200, await getTotpState(u.id))
  }

  /* 开始绑定：给一份新密钥 + 二维码（先不动正式配置，等输码确认） */
  if (p === '/api/auth/totp/setup' && method === 'POST') {
    const u = await need()
    if (!u) return
    if (!u.isAdmin) return sendJson(res, 403, {error: '两步验证只对管理员开放'})
    const secret = generateSecret()
    await setTotpPending(u.id, secret)
    const otpauth = otpauthUrl({
      secret,
      label: u.username,
      issuer: '开单分析'
    })
    const qr = await QRCode.toString(otpauth, {
      type: 'svg',
      margin: 1,
      width: 208,
      color: {dark: '#0d1117', light: '#ffffff'}
    })
    return sendJson(res, 200, {secret, otpauth, qr})
  }

  /* 输一次 6 位码确认 —— 对了才真正开启，并把恢复码交出去（只显示这一次） */
  if (p === '/api/auth/totp/enable' && method === 'POST') {
    const u = await need()
    if (!u) return
    if (!u.isAdmin) return sendJson(res, 403, {error: '两步验证只对管理员开放'})
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const pending = await readTotpPending(u.id)
    if (!pending)
      return sendJson(res, 400, {error: '请先生成二维码（刷新页面重来一次）'})
    const step = verifyTotp(pending, str(body.code))
    if (step === null)
      return sendJson(res, 400, {
        error: '口令不对 —— 核对一下手机时间是否自动校准，或等下一组再试'
      })
    const codes = generateRecoveryCodes(8)
    await enableTotp(u.id, pending, codes.map(hashRecovery))
    /*
     * ⚠️ **不要**把这一步用掉的步号写进 `totp_last_step`。
     * 开启只是个配置动作，不是登录；写了的话，用户「刚开完就用同一个码登录」
     * 会被防重放挡掉（实测过），得傻等 30 秒。
     */
    return sendJson(res, 200, {ok: true, recoveryCodes: codes})
  }

  /* 关掉：要密码 + 一个有效口令（防别人拿到你手机就关掉） */
  if (p === '/api/auth/totp/disable' && method === 'POST') {
    const u = await need()
    if (!u) return
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    if (!(await verifyUserPassword(u.id, str(body.password))))
      return sendJson(res, 400, {error: '密码不对'})
    const acc = await accountForTotp(u.id)
    if (acc?.secret) {
      const code = str(body.code).trim()
      const step = /^\d{6}$/.test(code) ? verifyTotp(acc.secret, code) : null
      const rec =
        step === null && code
          ? await consumeRecoveryCode(u.id, hashRecovery(code))
          : false
      if (step === null && !rec)
        return sendJson(res, 400, {error: '动态口令不对'})
    }
    await disableTotp(u.id)
    return sendJson(res, 200, {ok: true})
  }

  sendJson(res, 404, {error: 'Not Found'})
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
    // 下载分发：线上是 Caddy 发（请求到不了这儿），本地自己发一份
    if (p === '/dl' || p.startsWith('/dl/')) {
      serveDownload(res, p)
      return
    }
    // 开发模式下前端交给 Vite 中间件（改完立刻生效，不需要 build）
    if (viteDev?.handle(req, res)) return
    serveStatic(res, p)
    return
  }

  /* ---- 认证（公开接口） ---- */
  if (p.startsWith('/api/auth/')) {
    await handleAuth(req, res, url, p)
    return
  }

  /*
   * 除了上面 `isPublicApi()` 里那几个（行情 / 币种 / 图标 / 下载…），
   * 其余都要登录 —— 分析、存档、知识库、标签、用量、账户、服务器监测
   * 都是「用户自己的东西」。
   */
  /*
   * ⚠️ 数据库出错**不能当成 401**（`authUser` 已经把它写成了 503）——
   *    客户端见到 401 会把本地 token 删掉，那就等于「库抖一下 = 永久登出」。
   */
  const user = await authUser(req, res, url)
  if (user === undefined) return
  if (!isPublicApi(p) && !user) {
    sendJson(res, 401, {error: '请先登录'})
    return
  }
  /** 受保护分支用这个（能走到那儿说明已经登录了） */
  const me = user as User

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

  /*
   * 服务器 / 进程 / 数据库的实时状态。
   * 给「我的 → 管理 → 服务器」那半用（前端按秒轮询，自己在图上攒曲线）。
   * 只读、不落库；数据库不通也不会报错，而是把 `db.ok=false` 带回来。
   *
   * ⚠️ **要管理员**：用户 2026-10-04「服务器挪到管理界面」之后，这页只对管理员可见；
   * 接口跟着收紧 —— 里面有主机名、负载、磁盘、监听端口（`ports`），
   * 不该让普通账号拿到。
   */
  if (p === '/api/server-status') {
    if (!me.isAdmin) return sendJson(res, 403, {error: '需要管理员权限'})
    // `?minutes=` 决定曲线给多长（默认 30 分钟，封顶 120 —— 后端最多留 2 小时）
    const raw = Number(url.searchParams.get('minutes') ?? 30)
    const minutes = Number.isFinite(raw) ? Math.min(120, Math.max(1, raw)) : 30
    const status = await collectServerStatus()
    sendJson(res, 200, {...status, history: recentSamples(minutes)})
    return
  }

  if (p === '/api/config') {
    const rules = await loadRules()
    const env = process.env
    // 知识库只报一个总数（已经不再分「该做 / 不该做」）—— 只数**这个用户自己的**
    const rows = await query<{n: string}>(
      'SELECT count(*)::text AS n FROM knowledge WHERE user_id = $1',
      [me.id]
    ).catch(() => [] as {n: string}[])
    const knowledge = {total: Number(rows[0]?.n ?? 0)}
    const head = await usageHeadline(me.id).catch(() => ({
      todayCalls: 0,
      todayCostUsd: 0,
      allCalls: 0,
      allCostUsd: 0
    }))
    // 每个用户自己的 DeepSeek 配置（没填就回落 .env 那份）
    const cfg = loadConfig({llm: (await resolveUserLlm(me.id)).llm})
    sendJson(res, 200, {
      hasApiKey: Boolean(cfg.llm.apiKey),
      exchange: env.EXCHANGE ?? 'binance',
      marketType: env.MARKET_TYPE ?? 'swap',
      timeframes: cfg.timeframes.join(','),
      /** 主周期默认看多少天（前端传的是「图上那段」的天数） */
      lookback: {days: cfg.lookbackDays},
      model: cfg.llm.model,
      provider: 'deepseek',
      user: {id: me.id, username: me.username},
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

  /*
   * 合约行情的置顶币种（每个用户最多 5 个）。
   * 用户 2026-10-04：「合约行情添加币种置顶功能最多 5 个，无视排行和用户绑定」。
   * 只存 base（BTC），按 user_id 隔离。
   */
  if (p === '/api/pins') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const pins = await listPins(me.id)
    return sendJson(res, 200, {pins, max: MAX_PINS})
  }

  /** 置顶 / 取消置顶（行情表那颗星按一下就是切换） */
  if (p === '/api/pins/toggle' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const r = await togglePin(me.id, str(body.base))
      return sendJson(res, 200, {...r, max: MAX_PINS})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /* ---- 用量统计 ---- */
  if (p === '/api/usage' || p === '/api/usage/summary') {
    const days = url.searchParams.get('days')
    const recent = url.searchParams.get('recent')
    try {
      const [summary, headline] = await Promise.all([
        usageSummary({
          userId: me.id,
          days: Number(days ?? 30),
          recent: Number(recent ?? 10),
          kind: url.searchParams.get('kind'),
          // 只看某把密钥的用量（模型配置页里点某一把）
          keyId: Number(url.searchParams.get('keyId')) || null
        }),
        usageHeadline(me.id)
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
        userId: me.id,
        days: Number(url.searchParams.get('days') ?? 30),
        kind: url.searchParams.get('kind'),
        keyId: Number(url.searchParams.get('keyId')) || null,
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
    const config = loadConfig({llm: (await resolveUserLlm(me.id)).llm})
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

  /*
   * 「我的 → 模型配置」：**多把密钥**（2026-10-04）。
   *
   * 用户原话：「可以绑定多个 key 和模型，可以给命名，默认给一个，
   * 只有新增编辑时才弹窗，用量移到此界面，统计数据分开显示和 key 绑定」。
   *
   * 真 Key **不出网**：只回掩码（`sk-a****3456`），前端也用掩码判断「没改」。
   */
  if (p === '/api/llm-keys' || p.startsWith('/api/llm-keys/')) {
    const bodyOf = async () => {
      const b = await readJsonBody(req).catch(() => null)
      if (!b) throw new Error('请求体不是合法 JSON')
      return b
    }

    // 列表（没有密钥时会自动建一把「默认」，见 db/llm-keys.ts）
    if (p === '/api/llm-keys' && method === 'GET') {
      const resolved = await resolveUserLlm(me.id)
      const [keys, models, stats] = await Promise.all([
        listLlmKeys(me.id),
        fetchModels(loadConfig({llm: resolved.llm})).catch(() => null),
        usageByKey(me.id)
      ])
      const byId = new Map(stats.map(s => [s.keyId, s]))
      return sendJson(res, 200, {
        keys: keys.map(k => ({
          id: k.id,
          name: k.name,
          /** 掩码；真 Key 只在管理员那页给 */
          apiKey: maskKey(k.apiKey),
          apiKeySet: Boolean(k.apiKey),
          baseUrl: k.baseUrl,
          model: k.model,
          reasoningEffort: k.reasoningEffort,
          isDefault: k.isDefault,
          createdAt: k.createdAt,
          updatedAt: k.updatedAt,
          /** 这把 key 的用量（分开统计，跟 key 绑定） */
          stats: byId.get(k.id) ?? {calls: 0, costUsd: 0}
        })),
        models,
        /** 当前实际生效的那把（默认） */
        defaultId: resolved.keyId
      })
    }

    // 新增
    if (p === '/api/llm-keys' && method === 'POST') {
      try {
        const body = await bodyOf()
        const key = await createLlmKey(me.id, {
          name: str(body.name),
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          reasoningEffort:
            typeof body.reasoningEffort === 'string'
              ? body.reasoningEffort
              : undefined
        })
        return sendJson(res, 201, {ok: true, id: key.id})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    const m = p.match(/^\/api\/llm-keys\/(\d+)(\/default)?$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])

    // 设为默认
    if (m[2] === '/default') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      const ok = await setDefaultLlmKey(me.id, id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '密钥不存在'}
      )
    }

    if (method === 'PUT' || method === 'PATCH') {
      try {
        const body = await bodyOf()
        const saved = await updateLlmKey(me.id, id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          reasoningEffort:
            typeof body.reasoningEffort === 'string'
              ? body.reasoningEffort
              : undefined
        })
        return sendJson(
          res,
          saved ? 200 : 404,
          saved ? {ok: true, id: saved.id} : {error: '密钥不存在'}
        )
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    if (method === 'DELETE') {
      const ok = await deleteLlmKey(me.id, id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '密钥不存在'}
      )
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /*
   * 「我的 → 个人信息 → 交易所」：**多套交易所 API Key**（2026-10-04）。
   *
   * 用户原话：「个人信息下添加交易所内容，可以新增交易所和 key，支持多个」。
   * 「开单分析 → 交易所账户」那一格用**默认**那套查余额 / 持仓 / 挂单 / 订单。
   *
   * ⚠️ 真 Key / Secret **不出网**：只回掩码（`publicExchangeKey`），
   *    前端也用掩码判断「这一栏没改」。
   */
  if (p === '/api/exchange-keys' || p.startsWith('/api/exchange-keys/')) {
    const bodyOf = async () => {
      const b = await readJsonBody(req).catch(() => null)
      if (!b) throw new Error('请求体不是合法 JSON')
      return b
    }
    /** 没传 / 不是字符串都当「没填」（`undefined` 让仓储层用默认值） */
    const cred = (v: unknown): string | undefined =>
      typeof v === 'string' ? v : undefined

    // 列表（一套都没有时会自动建一套「默认」，见 db/exchange-keys.ts）
    if (p === '/api/exchange-keys' && method === 'GET') {
      const keys = await listExchangeKeys(me.id)
      return sendJson(res, 200, {
        keys: keys.map(publicExchangeKey),
        exchanges: EXCHANGE_CATALOG,
        marketTypes: [...MARKET_TYPES]
      })
    }

    // 新增
    if (p === '/api/exchange-keys' && method === 'POST') {
      try {
        const body = await bodyOf()
        const key = await createExchangeKey(me.id, {
          exchange: str(body.exchange),
          name: str(body.name),
          apiKey: cred(body.apiKey),
          secret: cred(body.secret),
          password: cred(body.password),
          marketType: str(body.marketType),
          sandbox: body.sandbox === true
        })
        return sendJson(res, 201, {
          ok: true,
          id: key.id,
          key: publicExchangeKey(key)
        })
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    const m = p.match(/^\/api\/exchange-keys\/(\d+)(\/default)?$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])

    // 设为默认
    if (m[2] === '/default') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      const ok = await setDefaultExchangeKey(me.id, id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '这一套不存在'}
      )
    }

    if (method === 'PUT' || method === 'PATCH') {
      try {
        const body = await bodyOf()
        const saved = await updateExchangeKey(me.id, id, {
          exchange: str(body.exchange),
          name: str(body.name),
          apiKey: cred(body.apiKey),
          secret: cred(body.secret),
          password: cred(body.password),
          marketType: str(body.marketType),
          sandbox: typeof body.sandbox === 'boolean' ? body.sandbox : undefined
        })
        return sendJson(
          res,
          saved ? 200 : 404,
          saved
            ? {ok: true, id: saved.id, key: publicExchangeKey(saved)}
            : {error: '这一套不存在'}
        )
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    if (method === 'DELETE') {
      const ok = await deleteExchangeKey(me.id, id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '这一套不存在'}
      )
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /*
   * 交易所资产（2026-10-05，方案见 docs/EXCHANGE.md）——
   *   GET  /api/exchange/overview?id=   读库里**最新一条快照**（毫秒级，不打交易所）
   *   POST /api/exchange/refresh?id=    现在去拉一次 + 落库（用户点 ⟳ 用）
   * 只统计「USDT 合约 + C2C」；现货账户直接告诉前端“不参与统计”。
   * 前端流程：先渲染快照 → 发现 ageSec 太大再自动调 refresh（stale-while-revalidate）。
   */
  if (
    (p === '/api/exchange/overview' && method === 'GET') ||
    (p === '/api/exchange/refresh' && method === 'POST')
  ) {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    const account = publicExchangeKey(key)

    // 现货账户不参与统计（别硬算成 0，会让人以为真的没钱）
    if (key.marketType !== 'swap') {
      return sendJson(res, 200, {
        account,
        noSnapshot: true,
        canRefresh: false,
        reason: '这套账户是现货，不参与统计（只算 USDT 合约 + C2C）'
      })
    }
    if (!key.apiKey || !key.secret) {
      return sendJson(res, 200, {
        account,
        noSnapshot: true,
        canRefresh: false,
        reason: '这一套还没填 API Key（去「我的 → 个人信息 → 交易所」填）'
      })
    }

    // ① 读库（快）
    if (method === 'GET') {
      try {
        const snap = await latestSnapshot(me.id, key.id)
        if (!snap) {
          return sendJson(res, 200, {
            account,
            noSnapshot: true,
            /* 只是还没采过 —— 跟「现货/没填 key」不同，这个刷一下就有的 （前端据此自动拉一次） */
            canRefresh: true,
            reason: '还没采过这个账户（点一下刷新）'
          })
        }
        return sendJson(res, 200, {
          account,
          noSnapshot: false,
          overview: {
            ...snap.overview,
            account: {
              exchange: account.exchange,
              name: account.name,
              marketType: account.marketType,
              sandbox: account.sandbox
            }
          },
          source: snap.source,
          ageSec: snap.ageSec,
          stale: snap.stale,
          err: snap.err
        })
      } catch (e) {
        return fail(res, 'exchange/overview', e)
      }
    }

    // ② 去拉一次 + 落库（慢，~2s）
    try {
      const ov = await fetchExchangeOverview({
        exchange: key.exchange,
        apiKey: key.apiKey,
        secret: key.secret,
        password: key.password,
        marketType: key.marketType,
        sandbox: key.sandbox
      })
      await saveSnapshot(me.id, key.id, ov, {source: 'manual'})
      /*
       * 推给订阅者：别人（或自己另一个 tab）正开着 `/api/exchange/stream` 时
       * 立刻看到新数，不用干等 5 分钟采样。
       */
      publishSnapshot(key.id, ov, 'manual')
      return sendJson(res, 200, {
        account,
        noSnapshot: false,
        overview: {
          ...ov,
          account: {
            exchange: account.exchange,
            name: account.name,
            marketType: account.marketType,
            sandbox: account.sandbox
          }
        },
        source: 'manual',
        ageSec: 0,
        stale: false,
        err: null
      })
    } catch (e) {
      return fail(res, 'exchange/refresh', e)
    }
  }

  /*
   * 成交账本（WS 实时落 + 断线后 REST 补）—— **不需要交易对**。
   * 老接口「币安必须给交易对才能查成交」那套已经不需要了（M3）。
   */
  if (p === '/api/exchange/fills' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    try {
      const fills = await listFills(
        me.id,
        key.id,
        num(url.searchParams.get('limit')) ?? 60
      )
      return sendJson(res, 200, {fills})
    } catch (e) {
      return fail(res, 'exchange/fills', e)
    }
  }

  /*
   * 当前挂单 —— **按需打交易所**，不进快照：
   * 挂单是秒级变化的东西，存下来只会是过期数据（方案里的「实时层」）。
   * 慢接口（~1s），所以失败也回 200 + `error`，不让整页空着（跟老接口同一个风格）。
   */
  if (p === '/api/exchange/open-orders' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret) {
      return sendJson(res, 200, {
        openOrders: null,
        error: '这一套还没填 API Key'
      })
    }
    try {
      const rows = await fetchOpenOrders({
        exchange: key.exchange,
        apiKey: key.apiKey,
        secret: key.secret,
        password: key.password,
        marketType: key.marketType,
        sandbox: key.sandbox
      })
      /* 只回界面要用的七个字段（cost/status 这些挂单列表不显示） */
      return sendJson(res, 200, {
        openOrders: rows.map(o => ({
          id: o.id,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          price: o.price,
          amount: o.amount,
          datetime: o.datetime
        })),
        error: null
      })
    } catch (e) {
      return sendJson(res, 200, {openOrders: null, error: humanize(e)})
    }
  }

  /*
   * 合约下单（2026-10-05）—— K 线页底部那个下单模块用的三条接口。
   *
   * ⚠️ `POST /api/exchange/trade/order` 走的**是币安的测试接口**
   *    （`/fapi/v1/order/test`，用户 2026-10-05 定的）：只校验参数 / 权限 / 保证金，
   *    **不进撮合、不真开仓**。要放开真下单就是改 `placeTestOrder` 里那个接口名，
   *    但界面 / 文档上「测试单」的说法必须一起改 —— 别让人以为一直是测试的。
   */

  /* 面板初始化：可用余额 + 当前/最大杠杆 + 数量价格精度（都打交易所，单项失败不拖垮整体） */
  if (p === '/api/exchange/trade' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (key.marketType !== 'swap')
      return sendJson(res, 200, {
        ready: false,
        account: publicExchangeKey(key),
        reason: '这套账户是现货，不能下合约单（去「交易所」加一套 U 本位合约的 Key）'
      })
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {
        ready: false,
        account: publicExchangeKey(key),
        reason: '这一套还没填 API Key（去「我的 → 个人信息 → 交易所」填）'
      })
    try {
      const info = await collectTradeInfo(
        {
          exchange: key.exchange,
          apiKey: key.apiKey,
          secret: key.secret,
          password: key.password,
          marketType: key.marketType,
          sandbox: key.sandbox
        },
        str(url.searchParams.get('symbol'), 'BTCUSDT')
      )
      return sendJson(res, 200, {
        ready: true,
        account: publicExchangeKey(key),
        ...info
      })
    } catch (e) {
      return sendJson(res, 200, {
        ready: false,
        account: publicExchangeKey(key),
        reason: humanizeTrade(e)
      })
    }
  }

  /* 调杠杆（只调这一个交易对） */
  if (p === '/api/exchange/trade/leverage' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    try {
      const r = await setSymbolLeverage(
        {
          exchange: key.exchange,
          apiKey: key.apiKey,
          secret: key.secret,
          password: key.password,
          marketType: key.marketType,
          sandbox: key.sandbox
        },
        str(body.symbol, 'BTCUSDT'),
        Number(body.leverage)
      )
      return sendJson(res, 200, {ok: true, ...r, error: null})
    } catch (e) {
      return sendJson(res, 200, {ok: false, error: humanizeTrade(e)})
    }
  }

  /* 下单（**测试单**：只校验，不进撮合） */
  if (p === '/api/exchange/trade/order' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    const type = str(body.type, 'market') === 'limit' ? 'limit' : 'market'
    const side = str(body.side, 'long') === 'short' ? 'short' : 'long'
    try {
      const params = await placeTestOrder(
        {
          exchange: key.exchange,
          apiKey: key.apiKey,
          secret: key.secret,
          password: key.password,
          marketType: key.marketType,
          sandbox: key.sandbox
        },
        key.id,
        {
          symbol: str(body.symbol, 'BTCUSDT'),
          side,
          type,
          quantity: Number(body.quantity),
          price: body.price === undefined ? undefined : Number(body.price)
        }
      )
      return sendJson(res, 200, {ok: true, test: true, order: params, error: null})
    } catch (e) {
      return sendJson(res, 200, {ok: false, error: humanizeTrade(e)})
    }
  }

  /*
   * 净资产曲线（M4）—— 读快照序列，不连交易所。
   *
   * `range` = `1d` / `7d` / `30d` / `180d` / `1y` / `all`。
   * ⚠️ 桶宽**不写死**：按实际跨度算（span / 360，取 5 分钟的整数倍）——
   *    这样加跨度不用改代码，返回点数也始终 ≤ ~360。
   * 桶内取 close / max / min（**不取平均**，见 docs），前端用 close 画折线 +
   * high/low 画区间带。
   */
  if (p === '/api/exchange/history' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    /** 跨度 → 小时数；`all` = 0（不设下界） */
    const SPANS: Record<string, number> = {
      '1d': 24,
      '7d': 168,
      '30d': 720,
      '180d': 4320,
      '1y': 8760,
      all: 0
    }
    const asked = (url.searchParams.get('range') ?? '1d').trim().toLowerCase()
    const range = Object.prototype.hasOwnProperty.call(SPANS, asked)
      ? asked
      : '1d'
    const hours = SPANS[range] || null
    try {
      // 真实跨度：`all` 时看库里最早那条，其余按 range 算
      const spanHours = hours ?? (await firstSnapshotHours(me.id, key.id))
      const bucket = Math.max(
        300,
        Math.ceil((spanHours * 3600) / 360 / 300) * 300
      )
      const points = await listCurve(me.id, key.id, hours, bucket)
      return sendJson(res, 200, {points, range, bucketSec: bucket})
    } catch (e) {
      return fail(res, 'exchange/history', e)
    }
  }

  /*
   * 交易所资产 · 实时推送（SSE，M2）—— 事件语义见 `handleExchangeStream`。
   * 认证走 `?token=`（EventSource 发不了请求头），见 `bearerToken`。
   */
  if (p === '/api/exchange/stream' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    /*
     * 不参与统计的两种情况**用 SSE 事件拒绝**，不回 JSON：
     * EventSource 拿到非 SSE 响应只会静默重连，前端连原因都看不到，
     * 只能干看着它每 3 秒重试一次。
     */
    let reject: string | null = null
    if (key.marketType !== 'swap') {
      reject = '这套账户是现货，不参与统计（只算 USDT 合约 + C2C）'
    } else if (!key.apiKey || !key.secret) {
      reject = '这一套还没填 API Key（去「我的 → 个人信息 → 交易所」填）'
    }
    await handleExchangeStream(
      req,
      res,
      me.id,
      key.id,
      publicExchangeKey(key),
      reject
    )
    return
  }

  /*
   * 老接口（单条配置）—— 留着给已经在手机上的旧版 App 用，
   * 内部映射到**默认那把**密钥。新前端用 /api/llm-keys。
   */
  if (p === '/api/llm-config') {
    const resolved = await resolveUserLlm(me.id)
    const own = await getDefaultLlmKey(me.id)
    const effective = loadConfig({llm: resolved.llm}).llm
    if (method === 'GET') {
      const models = await fetchModels(loadConfig({llm: resolved.llm})).catch(
        () => null
      )
      return sendJson(res, 200, {
        apiKey: maskKey(own?.apiKey ?? ''),
        apiKeySet: Boolean(own?.apiKey),
        baseUrl: own?.baseUrl ?? '',
        model: own?.model ?? '',
        reasoningEffort: own?.reasoningEffort ?? '',
        effective: {
          baseUrl: effective.baseUrl,
          model: effective.model,
          hasApiKey: Boolean(effective.apiKey),
          reasoningEffort: effective.reasoningEffort
        },
        models
      })
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      try {
        await saveUserLlm(me.id, {
          apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          reasoningEffort:
            typeof body.reasoningEffort === 'string'
              ? body.reasoningEffort
              : undefined
        })
        return sendJson(res, 200, {ok: true})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /* ---- 管理员：账号管理（新建用户 / 改密码 / 查看各自的 DS 配置） ---- */
  if (p === '/api/admin/users' || p.startsWith('/api/admin/users/')) {
    if (!me.isAdmin) return sendJson(res, 403, {error: '需要管理员权限'})

    // 列表：所有人 + 各自的密钥 + 数据条数
    if (p === '/api/admin/users' && method === 'GET') {
      const users = await listUsersForAdmin()
      return sendJson(res, 200, {
        users: users.map(u => ({
          id: u.id,
          username: u.username,
          isAdmin: u.isAdmin,
          createdAt: u.createdAt,
          stats: u.stats,
          // 管理员要「查看 ds 的 api 数据」—— 明文和掩码都给，
          // 前端默认显示掩码，点「显示」才展开
          llmKeys: u.llmKeys.map(k => ({
            id: k.id,
            name: k.name,
            apiKey: k.apiKey,
            apiKeyMasked: maskKey(k.apiKey),
            apiKeySet: Boolean(k.apiKey),
            baseUrl: k.baseUrl,
            model: k.model,
            reasoningEffort: k.reasoningEffort,
            isDefault: k.isDefault,
            updatedAt: k.updatedAt
          }))
        }))
      })
    }

    // 新建用户
    if (p === '/api/admin/users' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      try {
        const created = await createUser({
          username: str(body.username),
          password: str(body.password),
          isAdmin: body.isAdmin === true
        })
        return sendJson(res, 201, {ok: true, user: created})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    const m = p.match(/^\/api\/admin\/users\/(\d+)(\/password)?$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])

    // 改某个人的密码
    if (m[2] === '/password') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      try {
        const ok = await setUserPassword(id, body.password)
        return sendJson(
          res,
          ok ? 200 : 404,
          ok ? {ok: true} : {error: '用户不存在'}
        )
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    // 删号（⚠️ 会级联删掉这个人的分析 / 知识库 / 用量）
    if (method === 'DELETE') {
      if (id === me.id) return sendJson(res, 400, {error: '不能删掉自己'})
      const ok = await deleteUser(id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '用户不存在'}
      )
    }

    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /* ---- 切换模型：写进**这个用户自己的**配置（不再动服务器 .env） ---- */
  if (p === '/api/account/model') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
    const config = loadConfig({llm: (await resolveUserLlm(me.id)).llm})
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

    await saveUserLlm(me.id, {model})
    const next = loadConfig({llm: (await resolveUserLlm(me.id)).llm})
    sendJson(res, 200, {
      ok: true,
      model: next.llm.model,
      persisted: true,
      warning: null
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
    await handleAnalyze(url, res, me)
    return
  }

  if (p === '/api/analyze/stream') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    await handleAnalyzeStream(url, req, res, me)
    return
  }

  /* ---- 分析存档 ---- */
  if (p === '/api/analyses') {
    try {
      const [list, stats] = await Promise.all([
        listAnalyses({
          userId: me.id,
          symbol: url.searchParams.get('symbol') ?? undefined,
          grade: url.searchParams.get('grade') ?? undefined,
          verdict: url.searchParams.get('verdict') ?? undefined,
          tag: url.searchParams.get('tag') ?? undefined,
          actionableOnly: url.searchParams.get('actionable') === '1',
          limit: Number(url.searchParams.get('limit') ?? 30),
          offset: Number(url.searchParams.get('offset') ?? 0)
        }),
        analysisStats(Number(url.searchParams.get('days') ?? 365), me.id)
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
      const ok = await deleteAnalysis(id, me.id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '记录不存在'}
      )
    }
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const row = await getAnalysis(id, me.id).catch(() => null)
    if (!row) return sendJson(res, 404, {error: '记录不存在'})
    return sendJson(res, 200, {analysis: row})
  }

  /* ---- 知识库 ---- */
  if (p === '/api/knowledge') {
    if (method === 'GET') return handleListCases(url, res, me)
    if (method === 'POST') return handleCollectCase(req, res, me)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p === '/api/knowledge/tags') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    return handleListTags(res, me)
  }
  /* ---- 标签模板（我自己维护，AI 只能从这里挑） ---- */
  if (p === '/api/tag-templates') {
    if (method === 'GET') return handleListTags(res, me)
    if (method === 'POST') return handleAddTagTemplate(req, res, me)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p.startsWith('/api/tag-templates/')) {
    const mm = p.match(/^\/api\/tag-templates\/(\d+)(\/move)?$/)
    if (!mm) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(mm[1])
    if (mm[2] === '/move') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      return handleMoveTagTemplate(id, req, res, me)
    }
    if (method === 'PUT') return handleUpdateTagTemplate(id, req, res, me)
    if (method === 'DELETE') return handleDeleteTagTemplate(id, res, me)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  // 带进度地收录一个案例（SSE）—— EventSource 只能发 GET，参数走 query
  if (p === '/api/knowledge/stream') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    return handleCollectStream(url, req, res, me)
  }
  if (p.startsWith('/api/knowledge/')) {
    const m = p.match(/^\/api\/knowledge\/(\d+)(\/reedit)?$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])
    if (m[2] === '/reedit') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      return handleReeditCase(id, req, res, me)
    }
    if (method === 'DELETE') {
      const ok = await deleteCase(id, me.id)
      return sendJson(
        res,
        ok ? 200 : 404,
        ok ? {ok: true} : {error: '案例不存在'}
      )
    }
    if (method === 'PATCH') return handleUpdateCase(id, req, res, me)
    return handleGetCase(id, res, me)
  }

  // 「下载」页的数据：磁盘上的 APK + `downloads/releases.json` 里的介绍
  if (p === '/api/downloads') {
    return sendJson(res, 200, listDownloads())
  }

  sendJson(res, 404, {error: 'Not Found'})
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`
  )
  applyCors(req, res)
  /*
   * CORS 预检：浏览器跨域发 `POST + Authorization`（或 JSON body）前会先问一发
   * OPTIONS。以前没有这个分支，OPTIONS 会掉进业务路由 —— 对
   * `/api/analyze`、`/api/auth/login` 这种「方法不对就 405」的接口，预检直接失败
   * （手机 App 首当其冲）。预检不带业务逻辑，回 204 + 上面的 CORS 头即可。
   */
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
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
  /** 管理员账号的情况（下面 listen 日志里要提示） */
  let adminNote = ''
  try {
    await ensureSchema()
    /*
     * 交易所资产的实时层（M2，方案 docs/EXCHANGE.md）：
     * 给每套合约账户写一条「启动锚点」快照并起用户数据流（listenKey + 裸 WS），
     * 再起 5 分钟采样（兼作 REST 对账；C2C 钱包没有 WS 事件，只能靠它）。
     * ⚠️ 不 await：联网慢不拖启动，内部失败只告警。
     */
    startExchangeStreams()
    startSnapshotSampler()
    /*
     * 检查有没有管理员账号（2026-10-04 起不开放注册，账号由管理员创建）。
     * ⚠️ **不建号、不内置密码** —— 管理员账号（用户名 + 密码哈希）
     * 随**本地数据库同步**一起上来。
     */
    const a = await ensureAdmin()
    if (a.promoted) {
      adminNote = `「${ADMIN_USERNAME}」已提升为管理员`
    } else if (!a.hasAdmin) {
      adminNote =
        '⚠️ 还没有管理员账号 —— 把本地数据库同步上来（代码不再内置默认密码）'
    }
    /*
     * 把 `.env` 里那份大模型配置搬进管理员账号（只搬一次，搬完 .env 就能删了）。
     * 用户 2026-10-04：「去掉 apikey，原有的配置移到管理员的账户」。
     */
    if (await seedAdminLlmFromEnv()) {
      adminNote +=
        (adminNote ? '；' : '') + '已把 .env 里的大模型配置搬到管理员账号'
    }
    /*
     * 老的单条 `user_llm` → 多把密钥里的「默认」那把
     * （只搬一次，搬完把老表清空，免得用户删光密钥后被老数据复活）。
     */
    const migrated = await migrateLegacyLlm()
    if (migrated) {
      console.log(`  密钥    已把 ${migrated} 个账号的老配置搬成「默认」密钥`)
    }
    /*
     * 多密钥之前的用量流水没有 llm_key_id（那列是后加的）→
     * 密钥卡上写「调用 0」，下面用量统计却写「206 次」看着像算错了。
     * 把「只有一把密钥」的账号的老账认到那把上（判定见函数注释）。
     */
    const claimed = await backfillUsageKeys()
    if (claimed) {
      console.log(`  用量    已把 ${claimed} 条老流水认到那把唯一的密钥上`)
    }
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
        /*
         * ⚠️ 三种结果都要看得见：**刷成功了**、**该刷但失败了**、**库里还新所以没刷**。
         * 原来只打成功那条 —— 于是「本地币种表一直是旧的」在日志里**完全静默**，
         * 用户 2026-10-05 就是这么问的：「我不是有逻辑要刷新本地币种吗」。
         */
        if (r.failed) console.warn(`  币种表  ⚠️  ${r.reason}`)
        else if (r.refreshed) console.log(`  币种表  ${r.reason} → ${r.count} 个`)
        else console.log(`  币种表  ${r.reason}`)
      })
      .catch(e => console.warn(`  币种表  ⚠️  ${(e as Error).message}`))
  }
  kickContracts()
  setInterval(kickContracts, CONTRACTS_MAX_AGE_MS).unref()

  /*
   * 历史流水只留最近 N 天（默认 90 = 3 个月）。
   * 用户 2026-10-04：「历史统计数据保存 3 个月的」。
   *
   * ⚠️ 只删 `analyses` / `llm_usage` 两张**流水表** ——
   *    `knowledge`（自己一条条攒的经验案例）和提示词**绝不碰**。
   *    想全留着：`.env` 里写 `KEEP_DAYS=0`。
   *
   * 跟币种表一个套路：不 await（别拖住启动），失败只告警。
   */
  const pruneOld = () => {
    const days = loadConfig().keepDays
    void pruneOldData(days)
      .then(r => {
        if (r.analyses || r.usage) {
          console.log(
            `  清理流水  保留 ${r.keepDays} 天：删掉分析 ${r.analyses} 条、用量 ${r.usage} 条`
          )
        }
      })
      .catch(e => console.warn(`  清理流水  ⚠️  ${(e as Error).message}`))
  }
  pruneOld()
  // 一天一次就够（别用 CONTRACTS_MAX_AGE_MS，那是币种表的刷新周期）
  setInterval(pruneOld, 24 * 60 * 60 * 1000).unref()

  /*
   * 服务器监测的采样：每 5 秒一次，进程内滚动保留 2 小时。
   * 这样前端切「15 分钟 / 1 小时」时**立刻**就有历史曲线，不用自己攒。
   */
  startSampling()

  /*
   * 清掉过期的登录会话（启动一次 + 每天一次就够）。
   * 用户系统 2026-10-04 加的。
   */
  const kickSessions = () => {
    void cleanupSessions()
      .then(n => {
        if (n) console.log(`  会话    清掉 ${n} 条过期登录`)
      })
      .catch(() => undefined)
  }
  kickSessions()
  setInterval(kickSessions, 24 * 60 * 60 * 1000).unref()

  /*
   * 交易所预热：把 `getExchange()` 里那次 `loadMarkets()` 在启动时就打掉。
   *
   * ⚠️ 解决的就是「**第一发 2.7s**」：实测同一个新进程里
   *    第一发 1940ms（拋下 loadMarkets）· 第二发 333ms（交易所已热），
   *    差值 ~1.6s 就是它（上游下载 exchangeInfo 实测 485ms + ccxt 解析 528 个合约）。
   *    每个进程只付一次，但**每次部署 / 重启都由第一个用户付**。
   *
   * 不 await（联网慢不拖启动）；失败只告警 —— 真正取数时 `getExchange` 会再试。
   */
  const kickExchange = () => {
    const config = loadConfig()
    void warmExchange({
      exchangeId: config.exchange,
      marketType: config.marketType,
      apiBase: config.apiBase
    })
      .then(() => {
        console.log('  交易所  实例已预热（loadMarkets 完成）')
        /*
         * 交易所热了之后，再把常用几个币的 K 线先取好。
         * 顺序不能反 —— 现在 `getExchange` 不用再等 `loadMarkets`。
         */
        void warmCandlesCache()
          .then(async r => {
            console.log(
              `  K 线    常点币已预热 ${r.ok}/${r.total}（${WARM_TIMEFRAMES.join(
                '/'
              )}，点币种跳图不等交易所）`
            )
            const t = await warmTickerCache(r.bases)
            console.log(
              `  行情条  已预热 ${t.ok}/${t.total}（点币种顶部行情不等交易所）`
            )
          })
          .catch(() => {
            /* 内部已经逐个 try 过了，这里只是兜底 */
          })
      })
      .catch(e =>
        console.warn(`  交易所  ⚠️ 预热失败：${(e as Error).message}`)
      )
  }
  kickExchange()

  /*
   * K 线缓存的**后台保活**：让「预热过 / 看过一次」的 (币, 周期) 永远停在
   * 「没跨热线」那条快路上 —— 否则预热只顶一个周期那么久（用户：
   * 「不是添加了行情预热功能吗 60 个币种怎么还是慢」）。详见 `data/kline-store.ts`。
   */
  startKlineKeepWarm()

  /*
   * 市值排名（CoinGecko）：也跟着预热一次 —— 不预热的话第一个打开行情页的人
   * 会看到第二行没有「No.x」（`marketCapRanks()` 同步返回空 Map，后台才去拉）。
   * 之后每 6 小时由 `data/marketcap.ts` 自己按 TTL 在后台刷。
   */
  void refreshMarketCapRanks()
    .then(n => {
      if (n)
        console.log(`  排名    市值排名已就绪（${n} 个币，来源 CoinGecko）`)
    })
    .catch(() => {
      /* 内部已经吞过异常了，这里只是兜底 */
    })

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
    if (adminNote) console.log(`  账号    ${adminNote}`)
    for (const w of rules.warnings) console.log(`  ⚠️  ${w}`)
    console.log('')
    console.log('  按 Ctrl+C 停止。')
    console.log('')
  })
}

/** 退出时把 Vite 与数据库连接池关干净，别留孤儿进程 */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    /*
     * 退出前：给交易所那边写一条「关闭锚点」快照 + 删 listenKey 断流。
     * ⚠️ 给 5 秒上限 —— docker stop 默认 10 秒后就 SIGKILL，别卡在联网上
     *    （写锚点要每条 key 打一次 REST，约 2s/条）。
     */
    void Promise.race([
      stopExchangeStreams(),
      new Promise(r => setTimeout(r, 5000))
    ])
      .catch(() => undefined)
      .then(() => Promise.resolve(viteDev?.close()))
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
