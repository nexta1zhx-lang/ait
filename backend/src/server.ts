#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {createHash, randomBytes} from 'node:crypto'
import QRCode from 'qrcode'
import {loadConfig, ROOT_DIR} from './config'
import {
  CONTRACTS_MAX_AGE_MS,
  DATA_DIR,
  ensureContractsFresh,
  loadContracts
} from './contracts'
import {marketCapRanks, rankOf, refreshMarketCapRanks} from './data/marketcap'
import {fullSystem, hashOf, loadPolishRules, loadRules} from './rules'
import {buildSystemPrompt} from './llm/prompt'
import {ensureTonePresets, TONE_PRESETS} from './llm/tone-presets'
import {
  createDoc,
  deleteDoc,
  ensurePolishDoc,
  getVersion,
  listDocs,
  listVersions,
  restoreVersion,
  updateDoc,
  type DocKind
} from './db/prompts'
import {
  checkDb,
  closePool,
  dbHelpMessage,
  ensureSchema,
  query
} from './db/client'
import {collectServerStatus, recentSamples, startSampling} from './system'
import {
  createProxyUser,
  deleteProxyUser,
  importProxyUsersFromAgent,
  listProxyUsers,
  NODE,
  nodeUrl,
  proxyHealth,
  qrDataUrl,
  rotateProxyPassword,
  rotateProxyUuid,
  setProxyUserEnabled,
  setProxyUserNote,
  subUrl,
  syncProxyUsers,
  type ProxyUser
} from './proxy'
import {rustDeskSnapshot, setRustDeskNote} from './rustdesk'
import {getMacServices, setMacPassword} from './mac-services'
import {pruneOldData} from './db/prune'
import {
  recordUsage,
  usageByKey,
  usageCalls,
  usageHeadline,
  usageSummary
} from './db/usage'
import {deleteAnalysis, listAnalyses, saveAnalysis} from './db/analyses'
import {MAX_QUESTION_CHARS, askData, type AskAnswer} from './ask/run'
import {
  askThreadHistory,
  appendAskTurn,
  createAskThread,
  deleteAskThread,
  getAskThread,
  importAskThreads,
  listAskThreads,
  ownsAskThread,
  renameAskThread,
  type ImportedThread,
  type NewAskTurn
} from './db/ask-threads'
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
  userByName,
  userByToken,
  verifyUserPassword,
  type SessionMeta,
  type User
} from './db/users'
import {
  disablePushToken,
  dropPushToken,
  listPushDevices,
  listPushTokens,
  notePushError,
  savePushToken
} from './db/push'
import {latestAlertId, listAlerts} from './db/persist'
import {pushConfigured, pushStatus, sendPush} from './notify/push'
import {clientIp} from './util/device'
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecovery,
  otpauthUrl,
  verifyTotp
} from './util/totp'
import {MAX_PINS, listPins, togglePin} from './db/pins'
import {listHealthCards} from './data/position-live'
import {
  backfillReviews,
  countReviews,
  getReview,
  listCycleDetails,
  summarizeRange,
  listReviews,
  syncPositionJournal,
  type ReviewQuery
} from './data/trade-review'
import {
  BLACKLIST_DEFAULT_HOURS,
  BLACKLIST_MAX_HOURS,
  listBlacklist,
  lockBase,
  lockedUntil,
  unlockBase
} from './db/blacklist'
import {getStatsSettings, saveStatsSettings} from './db/stats-settings'
import {getScanParams, saveScanParams} from './db/scan-settings'
import {
  createKlineAlert,
  deleteKlineAlert,
  getKlineDrawings,
  listKlineAlerts,
  normalizeBase,
  rearmKlineAlert,
  saveKlineDrawings
} from './db/kline-alerts'
import {noteAlertChanged, startPriceAlerts} from './price-alerts'
import {
  createJournalCategory,
  deleteJournalCategory,
  deleteJournalEntry,
  getJournalPrefs,
  listJournalCategories,
  listJournalEntries,
  MAX_BODY,
  saveJournalEntry,
  saveJournalPrefs,
  setJournalPinned,
  updateJournalCategory
} from './db/journals'
import {
  createAnnotationTag,
  deleteAnnotationTag,
  deleteSymbolAnnotation,
  listAnnotationTags,
  listLatestAnnotations,
  listSymbolAnnotations,
  updateAnnotationTag,
  saveSymbolAnnotation
} from './db/annotations'
import {polishText} from './llm/polish'
import {pickCandidates} from './scan/rules'
import {
  MARKET_TYPES,
  MAX_EXCHANGE_KEYS,
  createExchangeKey,
  deleteExchangeKey,
  getDefaultExchangeKey,
  getExchangeKey,
  listExchangeKeys,
  maskCred,
  reorderExchangeKeys,
  setDefaultExchangeKey,
  setExchangeKeyHidden,
  updateExchangeKey,
  type ExchangeKey
} from './db/exchange-keys'
import {
  EXCHANGE_CATALOG,
  createExchange,
  humanize,
  type ExchangeCredentials
} from './data/exchange-account'
import {hydrateMarketsCache} from './data/ccxt-markets'
import {
  getPositions,
  isStreamActive,
  liveStateOf,
  subscribePositions
} from './data/position-cache'
import {listPositionHistory, positionMetaOf, type PositionMeta} from './data/position-history'
import {
  ensureAutoStop,
  ensureReduceProtection,
  ensureStopLossFull,
  ensureTakeProfitFull,
  type AutoStopResult
} from './data/auto-stop'
import {RateBudgetError, takeWeight} from './util/rate-budget'
import {
  assertOrderLimits,
  cancelOrphanOrders,
  cancelTradeOrder,
  cancelTradeOrders,
  closePositions,
  collectTradeInfo,
  knownLeverage,
  specFor,
  stepToDecimals,
  type TradeInfo,
  humanizeTrade,
  listOpenOrders,
  modifyTradeOrder,
  placeOrder,
  placeStopOrder,
  setSymbolLeverage,
  type OpenOrderRow
} from './data/exchange-trade'
import {fetchExchangeOverview} from './data/exchange-overview'
import {
  transferPermissions,
  universalTransfer,
  walletAvailable,
  type Wallet
} from './data/exchange-transfer'
import {
  firstSnapshotHours,
  incomeTotals,
  latestSnapshot,
  listCurve,
  listFills,
  listIncome,
  listOpenOrdersDb,
  saveSnapshot,
  type OpenOrderInput
} from './db/exchange-store'
import {
  exchangeAnalytics,
  importC2cOrders,
  latestC2cOrderTimestamp,
  listC2cOrderHistory,
  type C2cOrderInput
} from './db/exchange-analytics'
import {
  candleRejectStats,
  candleStoreStats,
  closesAtOrBefore,
  recentKlineRecon
} from './db/candle-store'
import {loadSymbols, symbolTableStats} from './db/symbols'
import {
  emit,
  reconcileKeyOrders,
  wakeExchangeStream,
  startExchangeStreams,
  startSnapshotSampler,
  stopExchangeStreams,
  subscribeExchange,
  publishSnapshot
} from './exchange-stream'
import {startExchangeArchiver} from './exchange-archive'
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
import {oneLineCost, usdToCny} from './llm/pricing'
import {fetchBalance, fetchModels, type ModelsResult} from './llm/account'
import {hasBuiltFrontend, mountViteDev, type ViteDev} from './devtools/vite-dev'
import {stepRecorder, type AnalyzeStep, type OnStep} from './step'
import {runAnalysis} from './analysis/run'
import {runPersistTick, runSessionOnce} from './analysis/persist'
import {
  MAX_ACTIVE_PER_USER,
  CADENCES,
  DEFAULT_DAYS,
  cadenceOf,
  countActive,
  createSession as createPersistSession,
  listSessions as listPersistSessions,
  sessionTimeline,
  getSession as getPersistSession,
  stopSession as stopPersistSession
} from './db/persist'
import {
  TF_MS,
  computeRecentSR,
  fetchCandles,
  fetchCandlesRange,
  fetchMarketList,
  fetchSnapshot,
  fetchTickerInfo,
  resolveTradable,
  warmExchange,
  type MarketRow,
  type TickerInfo
} from './data/market'
import {
  STORE_MAX_LIMIT,
  getLatestCandles,
  getRangeCandles,
  klineStoreStats
} from './data/kline-store'
import {
  alignShutdownToMinute,
  discoverContracts,
  klineRecorderStats,
  runFullStaleSweep,
  runGapCheck,
  runKlineRecon,
  startKlineRecorder,
  stopKlineRecorder
} from './data/kline-recorder'
import {
  observeMarkPrice,
  subscribeKline,
  subscribeMarkPrice,
  subscribeTickers,
  type MarkInfo
} from './data/kline-stream'
import {buildContext} from './context/builder'
import {claimSingleInstance} from './util/single-instance'
import {judge, type JudgeMeta, type JudgeResult} from './llm/client'
import {Candle, MarketSnapshot, MarketType, Timeframe} from './types'

const PORT = Number(process.env.PORT || 8787)
/** 前端构建产物（npm run ui:build 生成） */
const PUBLIC_DIR = path.join(ROOT_DIR, 'frontend', 'dist')
const VALID_TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d']

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

  /*
   * 静态资源目录（/assets、/fonts）里的文件**必须**命中，命不中就是真 404 ——
   * 绝不能回落 index.html。
   *
   * 为什么：这两个目录里的文件名带内容哈希、响应头是 `immutable`。浏览器一旦
   * 拿着**旧的** index.html 去要旧名字的 js / css，这里回一坨 HTML（200 +
   * text/html）⇒ 浏览器按 ES module 解析失败 ⇒ **整页白屏，而线索只在控制台**。
   * 回 404 至少让「取不到」表现为「取不到」，而不是伪装成成功的 HTML。
   */
  if (/^(assets|fonts)[/\\]/.test(safeRel)) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end('404 Not Found\n')
    return
  }

  // 其余路径交给前端路由（/usage、/journal …），刷新也能打开
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
  /**
   * **别的应用**（同一个下载目录里的其它 APK，比如梯子）—— 想给它们起个好名字就登记在这。
   * `file` 对上文件名即可，没登记的按文件名猜。
   */
  apps?: {file?: string; name?: string; desc?: string; require?: string}[]
}

/** `entry-advisor-0.1.0.apk` → `0.1.0` */
function versionFromFile(file: string): string {
  const m = file.match(/(\d+(?:\.\d+)*)(?=\.apk$)/i)
  return m ? m[1] : file.replace(/\.apk$/i, '')
}

/**
 * **别的应用**的包名 / 版本（`ClashMetaForAndroid-2.11.35-arm64.apk` →
 * `ClashMetaForAndroid` + `2.11.35`）。纯粹是显示用 —— 猜不准也不影响下载，
 * 想要准确的名字在 `releases.json` 的 `apps` 里登记。
 */
function appNameOf(file: string): {name: string; version: string} {
  const base = file
    .replace(/\.apk$/i, '')
    .replace(/[-_](arm64[-_]?v8a|arm64|armv7a?|armeabi[-_]?v7a|universal|x86|x86_64)$/i, '')
  const m = base.match(/^(.*?)[-_ ](v?\d+(?:\.\d+)*)$/)
  if (m) return {name: m[1].replace(/[-_]+/g, ' ').trim(), version: m[2].replace(/^v/i, '')}
  return {name: base.replace(/[-_]+/g, ' ').trim(), version: ''}
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

/** 文件的大小 / 时间 / md5；清单里写了但文件不在（本地没打包）时返回 0 */
function diskInfo(file: string): {size: number; mtime: number; md5: string | null} {
  try {
    const st = fs.statSync(file)
    return {size: st.size, mtime: Math.round(st.mtimeMs), md5: fileMd5(file)}
  } catch {
    return {size: 0, mtime: 0, md5: null}
  }
}

/**
 * 列清单：`releases.json` 的介绍 + 磁盘上真实的文件信息（大小 / md5 / 时间）。
 *
 * 回两组：`releases`（**这个 app** 的包，`releases.json` 里登记过）和
 * `apps`（下载目录里**别的应用**的 APK）—— 两类混在一张表里排会出事：
 * 别的包文件名里的数字（`FlClash-0.8.99-arm64.apk` → 被当成版本 `64`）会排到最前，
 * 把「最新版」那个按钮指到不相干的包上。
 */
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

  const entries = doc.releases ?? []
  const releases = entries
    .filter((m): m is ReleaseMeta & {file: string} => Boolean(m.file))
    .map(m => {
      const {size, mtime, md5} = diskInfo(path.join(DOWNLOAD_DIR, m.file))
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

  /* —— 其余 APK = **别的应用**（同一个目录里放的，比如梯子），单独一组 —— */
  const declared = new Set(entries.map(m => m.file).filter(Boolean))
  const apps = onDisk
    .filter(f => !declared.has(f))
    .map(f => {
      const named = (doc.apps ?? []).find(a => a.file === f)
      const guess = appNameOf(f)
      const {size, mtime, md5} = diskInfo(path.join(DOWNLOAD_DIR, f))
      return {
        file: f,
        url: `/dl/${encodeURIComponent(f)}`,
        name: named?.name?.trim() || guess.name,
        version: guess.version,
        desc: named?.desc ?? '',
        require: named?.require ?? '',
        size,
        mtime,
        /** 从文件名猜出来的名字，界面上标一下「按文件名」 */
        guessed: !named?.name,
        md5
      }
    })
    .filter(a => a.size > 0)
    .sort((a, b) => b.mtime - a.mtime)

  // ⚠️ 只回清单，**不回 `DOWNLOAD_DIR` 这个绝对路径** ——
  //    接口是公开的，没必要把容器里的目录结构说出去。
  return {
    app: doc.app ?? {},
    releases,
    apps
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
 * `?query` 里的**可选数字**：没给 / 给空 = `undefined`。
 *
 * ⚠️⚠️ **不能拿上面那个 `num()` 来读 query**（2026-10-16 踩的）：
 *    `URLSearchParams.get('杠杆')` 对**没给的键返回 `null`**，而 `Number(null)` 是
 *    **0**（不是 NaN）⇒ 「没给」会被读成 0：
 *      · 没带杠杆的仓位 → 存成 `0x`、界面上显示 0 倍
 *      · 没带开仓价的仓位 → 喂给模型的提示词里写「均价 0.000」
 *    `body` 那条路没这个毛病（`Number(undefined)` 是 NaN），所以这条只给 query 用。
 */
const numQ = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
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
  /** 被隐藏了（只在「个人信息 → 交易所」那个管理列表里出现） */
  hidden: k.hidden,
  createdAt: k.createdAt,
  updatedAt: k.updatedAt
})

/** 从库里的 Key 摊平成连交易所要的那几个字段（省得每条路由各抄一遍） */
const exchangeCredsOf = (k: ExchangeKey): ExchangeCredentials => ({
  exchange: k.exchange,
  apiKey: k.apiKey,
  secret: k.secret,
  password: k.password,
  marketType: k.marketType,
  sandbox: k.sandbox
})

/**
 * **下单前**这个方向有多少张（判断「这一单是不是加仓」用）。
 *
 * ⚠️ 不能只看常驻流：流还没起来（刚进页面 / 页面在后台）时 `liveStateOf` 是 `null`，
 *    数量会被读成 0 ⇒ 加仓被当成「开新仓」，止损 / 止盈就不会放回 100%
 *    （用户 2026-10-24：「我加仓之后止损并没有自动加仓到百分之百」）。
 *    这时退回读一次持仓（缓存命中是零权重，不会明显拖慢下单）。
 * ⚠️ 读不到就算 0：宁可少改一次保护单，也不能把这一单卡住。
 */
async function amountBeforeAdd(
  keyId: number,
  creds: ExchangeCredentials,
  symbol: string,
  side: 'long' | 'short'
): Promise<number> {
  const sumOf = (
    rows: {symbol?: unknown; raw?: unknown; side?: unknown; amount?: unknown}[] | undefined
  ): number => {
    const hit = (rows ?? []).find(
      p =>
        String(p.raw ?? p.symbol ?? '').toUpperCase() === symbol &&
        (String(p.side ?? 'long') === 'short' ? 'short' : 'long') === side
    )
    return Math.abs(Number(hit?.amount) || 0)
  }
  const live = liveStateOf(keyId)
  if (live) return sumOf(live.positions)
  try {
    return sumOf(await getPositions(keyId, creds))
  } catch {
    return 0
  }
}

/**
 * 库里那条挂单（`OpenOrderInput`）→ **跟实时那条接口逐字一致的形状**。
 *
 * ⚠️ 字段名一个都不能改：K 线 / 「我的」页都直接吃它（`price` / `stopPrice` / `time`…）。
 * ⚠️ 给两处共用：`/api/exchange/open-orders`（读库那条）和
 *   `/api/exchange/trade/open-orders` 的**实时读不到时的快照兜底**（见那里）。
 */
const orderRowOfInput = (o: OpenOrderInput) => ({
  id: o.orderId,
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  posSide: o.posSide,
  price: o.price,
  stopPrice: o.stopPrice,
  amount: o.amount,
  filled: o.filled,
  reduceOnly: o.reduceOnly,
  time: o.time
})

/**
 * 动手打交易所之前先跟**全局权重预算**报一声（改造 P3）。
 *
 * 为什么必须全局：币安按**出口 IP** 算权重，而一台服务器只有一个出口 IP 给所有用户用。
 * 详见 `util/rate-budget.ts` 的说明。
 */
async function chargeExchange(weight: number, tag: string): Promise<void> {
  await takeWeight(weight, tag)
}

const C2C_SYNC_PAGE_SIZE = 100
const C2C_SYNC_MAX_PAGES = 1000
const C2C_SYNC_RANGE_MS = 30 * 24 * 60 * 60 * 1000
const C2C_SYNC_INITIAL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000

interface C2cHistoryExchange {
  request(
    path: string,
    api: string,
    method: string,
    params: Record<string, number>
  ): Promise<unknown>
}

function mapBinanceC2cOrder(
  value: unknown,
  page: number,
  index: number
): C2cOrderInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`币安 C2C 第 ${page} 页第 ${index + 1} 条记录格式无效`)
  }
  const row = value as Record<string, unknown>
  const orderStatus = str(row.orderStatus).toUpperCase()
  const asset = str(row.asset).toUpperCase()
  if (!orderStatus || !asset) {
    throw new Error(`币安 C2C 第 ${page} 页第 ${index + 1} 条记录缺少状态或资产`)
  }
  if (orderStatus !== 'COMPLETED' || asset !== 'USDT') return null

  const orderId = str(row.orderNumber).trim()
  const tradeType = str(row.tradeType).toUpperCase()
  const fiat = str(row.fiat).trim().toUpperCase()
  const fiatTotal = num(row.totalPrice)
  const price = num(row.unitPrice)
  const quantity = num(row.amount)
  const rawTimestamp = row.createTime
  const timestampMs =
    typeof rawTimestamp === 'number' || /^\d+$/.test(String(rawTimestamp ?? ''))
      ? Number(rawTimestamp)
      : Date.parse(String(rawTimestamp ?? ''))

  if (
    !orderId ||
    orderId.length > 80 ||
    (tradeType !== 'BUY' && tradeType !== 'SELL') ||
    !fiat ||
    fiat.length > 16 ||
    fiatTotal === undefined ||
    fiatTotal < 0 ||
    price === undefined ||
    price <= 0 ||
    quantity === undefined ||
    quantity <= 0 ||
    !Number.isFinite(timestampMs)
  ) {
    throw new Error(`币安 C2C 第 ${page} 页第 ${index + 1} 条已完成订单字段无效`)
  }

  return {
    orderId,
    side: tradeType === 'BUY' ? 'Buy' : 'Sell',
    asset: 'USDT',
    fiat,
    fiatTotal,
    price,
    quantity,
    timestamp: new Date(timestampMs).toISOString()
  }
}

async function fetchBinanceC2cOrders(
  exchange: C2cHistoryExchange,
  from: number,
  to: number
): Promise<{orders: C2cOrderInput[]; pages: number}> {
  const orders: C2cOrderInput[] = []
  let pages = 0

  for (let rangeStart = from; rangeStart <= to;) {
    const rangeEnd = Math.min(rangeStart + C2C_SYNC_RANGE_MS - 1, to)
    let page = 1
    while (true) {
      await chargeExchange(1, 'Binance C2C 历史')
      const response = await exchange.request(
        'c2c/orderMatch/listUserOrderHistory',
        'sapi',
        'GET',
        {
          startTimestamp: rangeStart,
          endTimestamp: rangeEnd,
          page,
          rows: C2C_SYNC_PAGE_SIZE
        }
      )
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error('币安 C2C 历史接口返回格式无效')
      }
      const result = response as Record<string, unknown>
      if (result.success === false) {
        const message = str(result.message, '未知错误')
        throw new Error(`币安 C2C 历史查询失败：${message}`)
      }
      if (!Array.isArray(result.data)) {
        throw new Error('币安 C2C 历史接口缺少订单列表')
      }

      for (const [index, value] of result.data.entries()) {
        const order = mapBinanceC2cOrder(value, page, index)
        if (order) orders.push(order)
      }
      pages++

      const total = num(result.total)
      const hasMoreByTotal =
        total !== undefined &&
        total > 0 &&
        page * C2C_SYNC_PAGE_SIZE < total
      const hasMore = result.data.length === C2C_SYNC_PAGE_SIZE || hasMoreByTotal
      if (!hasMore) break
      if (pages >= C2C_SYNC_MAX_PAGES) {
        throw new Error('本次 C2C 更新超过分页上限，请稍后重试')
      }
      page++
    }
    rangeStart = rangeEnd + 1
  }

  return {orders, pages}
}

/**
 * @param human 把这个错翻成**人话**再回给前端（原始报错照旧打日志）。
 *
 * ⚠️ 交易所那几条路**必须**传 `humanize`：ccxt 的原始报错里带着整条 URL ——
 *   `binance GET https://fapi.binance.com/fapi/v2/positionRisk?timestamp=…&signature=<签名> request timed out (10000 ms)`
 *   （2026-10-06 用户截图里弹的就是这句）。用户看不懂，而且**把自己请求的签名画在页面上**。
 */
function fail(
  res: http.ServerResponse,
  tag: string,
  e: unknown,
  human?: (e: unknown) => string
): void {
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
  sendJson(res, 500, {error: human ? human(e) : err.message})
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
  const tfOk = (VALID_TFS as string[]).includes(tfParam)
  const timeframe = tfOk ? tfParam : '1h'
  /*
   * ⚠️ 不支持的周期以前**一声不吭**就按 `1h` 给 —— 2026-10-06 就是它把
   *   仓位明细里请求 `1m` 的图悄悄变成一小时 K 线（8 笔成交全挤在一根上）。
   *   行为不动（兼容老调用），但**留一行日志**：下次谁写错周期，日志里看得见。
   */
  if (!tfOk) {
    console.warn(
      `[/api/candles] 不支持的周期 ${String(tfParam)} ⇒ 按 1h 返回（支持：${VALID_TFS.join('/')}）`
    )
  }
  // 一屏最多 3000 根（前端「加载更多」会递加）
  const limit = Math.min(3000, Math.max(50, Number(q.get('limit')) || 300))
  const config = loadConfig({marketType: market})

  // 日期区间（毫秒）。只决定「画哪一段」，不影响分析用的数据。
  /*
   * ⚠️ 一律 `Math.round` 成**整数毫秒**：币安的 `startTime` 只认整数，
   *    传小数会被判 `starttime ... malformed`（2026-10-13 前端算内边距带出了
   *    `…469.32` 这种值，打回来就是 500）。区间是"哪一毫秒"没意义，抹掉小数最省事。
   */
  const fromReq = Math.round(Number(q.get('from')) || 0)
  const toReq = Math.round(Number(q.get('to')) || 0)
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
   * 「最新 N 根」走**三层读路径**（`data/kline-store.ts`）：**内存 → 库 → REST**。
   *   ① 内存里存的是**已收盘**那串（不变，不设 TTL）；
   *   ② 跨过一个桶就去**本地库**（底座常驻写）读一份 —— 毫秒级、0 权重；
   *   ③ 库里没有 / 库太旧（底座挂了）才退回交易所。
   * 「当前那根」由底座内存现取（`currentBar()`），所以图表上的最后一根永远是活的。
   * 带 from/to 的历史区间、以及超大 limit 照旧直接打交易所（很少发生）。
   */
  /*
   * 库内那一段（ranged 才走）。⚠️ **空数组要当成"未命中"** —— 见下面那段说明。
   */
  const fromDb = ranged
    ? await getRangeCandles({
        exchangeId: config.exchange,
        symbol,
        timeframe,
        limit,
        /*
         * ⚠️ 这里必须跟下面 REST 那条用**同一对数**：
         *    库内的那段走库（毫秒级、0 权重），库外的这一段才打交易所。
         *    两端口径（`rangeFrom`/`rangeTo` 与 maxCandles）必须一模一样，
         *    否则「库内 + 库外」拼起来会缺一段或重一段。
         */
        from: rangeFrom,
        to: rangeTo,
        marketType: config.marketType
      })
    : null

  /*
   * ⚠️⚠️ `getRangeCandles()` 只按「库的首尾覆不覆盖这个区间」判断，**不看中间有没有洞**：
   *    落在洞里时它返回的是**空数组**（不是 `null`），而 `??` 把空数组当"有值"
   *    ⇒ 打交易所那一层永远走不到 ⇒ 接口回 `candles: []`。
   *    2026-10-13 实测：IO 那笔仓位正好开平在 1m 的洞上，分享海报显示「没取到行情」。
   *    所以这里**空数组一律当未命中**，掉到 REST 那层去补（行情是公开数据，只花 IP 权重）。
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
      : (fromDb && fromDb.length ? fromDb : null) ??
        (await candlesCache(cacheKey, () =>
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
        ))

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

/**
 * 头部行情条缓存（`/api/ticker` 每次都要打交易所，必须缓存）。
 *
 * ⚠️ `ttl = stale = 15 秒`：过期就**阻塞**拉一份新的（`ticker.ts` 那边一分钟轮询一次，
 *    所以基本每次都真去拉）。15 秒是 2026-10-05 定的 —— 设宽了会「一分钟才动一下」
 *    （用户：「k 线上面成交量 / 高低价这些数据都没更新」）。
 *
 * ★ 2026-10-11：**启动预热撤掉了**（`warmTickerCache` / `warmPicks` 整块删除）。
 *   当初留它的理由是「冷启 1.07s」，而那一秒主要花在现拉 366 根日线上 —— 那条早改成
 *   读本地库了（`dailySeries`）；现在冷启实测 **0.15s**。反倒是预热自己：一次要对
 *   成交额前 60 ∪ 异动币各打两三趟上游，而这份缓存的 ttl 只有 15 秒 ⇒ 预热出来的
 *   东西**十几秒后就全过期**，只有正好在这 15 秒里点到名单里的币才享到那 5ms。
 *   顺带：首帧的资金费率 / 指数价现在优先吃 WS 那份（`data/mark-cache.ts`），
 *   这两样也不必再为此打 `/fapi/v1/premiumIndex`。
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
    /*
     * 顺手把这个币的标记价订上（只 U 本位永续有这条流）——
     * 资金费率 / 倒计时从此由 WS 秒级推，REST 这份只当底稿和兜底。
     */
    if (config.marketType === 'swap' && data.pair) demandMark(data.pair)
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

/**
 * 「基准时刻 → 各币那一刻的收盘价」（`GET /api/markets?since=` 用）。
 *
 * 那一刻的价是**库里翻出来的死数**（`closesAtOrBefore`），只有 `last` 在动 ——
 * 所以这份可以放心多缓一会儿（5 分钟）。
 * key 用**分钟对齐**的基准时刻：差几秒不该各查一遍库。
 */
const baseCloseCache = makeCache<Map<string, number>>(
  5 * 60_000,
  30 * 60_000,
  30
)

/**
 * `?since=` 参数（毫秒）→ 分钟对齐的基准时刻；缺省 / 非法返回 `null`。
 *
 * 前端传的是**基准时刻** —— 要么是「所选时区**当天 00:00**」（日切看「今日」，
 * 见前端 `settings.ts` 的 `dayStartMs`），要么是用户挑的**任意时刻**（`rankSinceMs`）。
 * ⚠️ 夹到「一分钟前」：未来时刻没有意义，不夹的话会算出 ~0% 还白占一档缓存。
 */
function baseSince(raw: string | null): number | null {
  const ms = num(raw)
  if (ms === undefined || ms <= 0) return null
  return Math.min(Math.floor(ms / 60_000) * 60_000, Date.now() - 60_000)
}

/**
 * 只回「基准时刻那一刻各币的收盘价」—— **换基准时那条轻量路**（2026-10-08）。
 *
 * 为什么要有它（用户 2026-10-08：「涨跌幅基准周期，切换慢是什么原因」）：
 * 原来换基准走的是 `?since=` 的整表重拉 —— 500+ 行 / ≈100KB，
 * 前端还要 `byPair.clear()` 重建、全表重渲染、顺便重排一次序。
 * 而"换基准"真正变的东西只有**一列**（`baseClose`）：`last` 是行情增量在刷、
 * 其余列一个都没动。所以这里只回那一列（525 个数 ≈ 10KB），前端就地替换。
 *
 * ⚠️ 跟 `handleMarkets` 共用 `baseCloseCache`（同一个 key 口径）⇒ 先整表后单查、
 *    或者来回切基准，都不会重复打库。
 */
async function handleMarketBase(
  url: URL,
  res: http.ServerResponse
): Promise<void> {
  const marketParam = url.searchParams.get('market')
  const market =
    marketParam && ['spot', 'swap', 'coinm'].includes(marketParam)
      ? (marketParam as MarketType)
      : undefined
  const config = loadConfig({marketType: market})
  const since = baseSince(url.searchParams.get('since'))
  if (!since) {
    sendJson(res, 400, {error: '需要一个基准时刻（?since=毫秒）'})
    return
  }
  if (config.marketType !== 'swap') {
    /* `candles` 只覆盖 U 本位永续（见 candle-store 顶部）⇒ 别的市场类型没有基准价 */
    sendJson(res, 200, {since, closes: {}})
    return
  }
  try {
    const bases = await baseCloseCache(
      `${config.exchange}|${config.marketType}|${since}`,
      () => closesAtOrBefore(since, {exchange: config.exchange, marketType: config.marketType})
    )
    sendJson(res, 200, {since, closes: Object.fromEntries(bases)})
  } catch (e) {
    sendJson(res, 502, {error: (e as Error).message})
  }
}

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
    let rows = ranks.size
      ? v.rows.map(r => ({...r, rank: rankOf(ranks, r.base)}))
      : v.rows
    /*
     * 换了基准（`?since=`）：补上每个币「基准时刻的收盘价」，前端拿它跟实时 `last`
     * 现算「基准时间 → 现在」的涨跌幅（见 `closesAtOrBefore`）。
     * ⚠️ 只对 swap 有意义 —— 那本 `candles` 库只覆盖 U 本位永续（见 candle-store 顶部）。
     */
    const since = baseSince(url.searchParams.get('since'))
    if (since && config.marketType === 'swap') {
      let bases: Map<string, number>
      try {
        bases = await baseCloseCache(
          `${config.exchange}|${config.marketType}|${since}`,
          () =>
            closesAtOrBefore(since, {
              exchange: config.exchange,
              marketType: config.marketType
            })
        )
      } catch {
        // 基准价查不到不该让整张表挂掉：那几格显示「—」就是了
        bases = new Map()
      }
      rows = rows.map(r => ({...r, baseClose: bases.get(r.symbol) ?? null}))
    }
    sendJson(res, 200, {rows, updatedAt: v.at})
  } catch (e) {
    sendJson(res, 502, {error: (e as Error).message})
  }
}

/* ------------------------------------------------------------------ */
/* 开单分析                                                            */
/* ------------------------------------------------------------------ */

/** `baseSymbol` / `AnalyzeOutcome` / `runAnalysis` 都搬去了 `analysis/run.ts`
 *（2026-10-15：持久化分析要直接调 `runAnalysis`，不能走 HTTP 绕回自己） */

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
/* `sourceText` 与 `runAnalysis` 已搬到 `analysis/run.ts`（2026-10-15）——
   持久化分析要直接调它，不能走 HTTP。 */

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
   * 下面 analyze 那条是**任务型**一次性流，不收僵尸，用注释行就行。
   */
  const beat = setInterval(() => send('heartbeat', {}), 20_000)

  /*
   * ⚠️⚠️ **只能听 `res` 的 close，绝不能听 `req` 的**（2026-10-06 查出来的大坑）。
   *
   * Node 16 起 `IncomingMessage` 的 `'close'` 在**请求收完**就触发 ——
   * 对一个 GET 来说就是「刚连上就触发」，于是 SSE 刚建好就被当成「客户端走了」
   * 收尾掉。症状极具迷惑性：
   *   · `open` / 连接时的底稿 `snapshot`（拆之前写进去的）**能收到**；
   *   · 之后所有**实时事件**（`positions` / `marks` / `fill` / `kline`）**一条都收不到**
   *     —— 因为 `unsubscribe()` 已经把订阅者删了，`emit()` 变成空转；
   *   · 浏览器那边表现为反复 `net::ERR_ABORTED`，而且**自动重连**，
   *     每秒一轮，看着像「连上了但没数据」。
   * 页面「持仓盈利不实时」就是这个 —— 跟 WS、跟算在哪都无关。
   */
  let closed = false
  const done = () => {
    if (closed) return
    closed = true
    clearInterval(beat)
    unsubscribe()
  }
  res.on('close', done)
}

/**
 * 标记价（`{sym}@markPrice@1s`）的**按需订阅**：谁看过这个币的行情条，就替谁订一会儿。
 *
 * ★ 2026-10-11：资金费率 / 指数价 / 下次收取时间**本来就是 WS 推的**
 *   （`markPriceUpdate` 里的 `r` / `i` / `T`）—— 以前这里只有「有持仓的币」才订
 *   （见 `data/kline-stream.ts` 的 `subscribeMarkPrice` 注释），于是行情条那两个数
 *   只能靠 REST `/fapi/v1/premiumIndex`。现在按「正在看的币」补订，走 WS 推给前端。
 *
 * ⚠️ 保留 10 分钟：前端每 60 秒会来一发 `/api/ticker`（兜底底稿）续期；
 *    用户一直不看了就自动退订，别白占一条流。
 */
const MARK_KEEP_MS = 10 * 60_000
const markDemand = new Map<string, {stop: () => void; timer: NodeJS.Timeout}>()

/** 让 `raw`（`BTCUSDT`）的标记价保持被订阅状态 */
function demandMark(rawSymbol: string): void {
  const raw = String(rawSymbol ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]+USDT$/.test(raw)) return
  const cur = markDemand.get(raw)
  if (cur) {
    clearTimeout(cur.timer)
    cur.timer = setTimeout(() => releaseMark(raw), MARK_KEEP_MS)
    return
  }
  /* 监听器本身不做事：把四件套转给前端的是下面那个 `observeMarkPrice` 旁听者 */
  const stop = subscribeMarkPrice(raw, () => undefined)
  markDemand.set(raw, {
    stop,
    timer: setTimeout(() => releaseMark(raw), MARK_KEEP_MS)
  })
}

function releaseMark(raw: string): void {
  const cur = markDemand.get(raw)
  if (!cur) return
  clearTimeout(cur.timer)
  cur.stop()
  markDemand.delete(raw)
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
  /*
   * 标记价那一批（资金费率 / 指数价 / 下次收取时间）——
   * 上游 `{sym}@markPrice@1s` 每秒一条，只订「有人正看着」的那几个币
   * （订阅见 `demandMark`）。前端拿它盖掉 60 秒一次那份 REST 底稿。
   */
  const stopMark = observeMarkPrice((pair, info: MarkInfo) =>
    send('mark', {updates: [{pair, ...info}]})
  )
  /** 这条连接收尾了没有（`res.on('close')` 里翻真，见下面那段注释） */
  let closed = false
  /* 心跳必须是具名事件，理由同上 */
  const beat = setInterval(() => send('heartbeat', {}), 20_000)

  /*
   * ⚠️⚠️ **只能听 `res` 的 close，绝不能听 `req` 的**（2026-10-06 查出来的大坑）。
   *
   * Node 16 起 `IncomingMessage` 的 `'close'` 在**请求收完**就触发 ——
   * 对一个 GET 来说就是「刚连上就触发」，于是 SSE 刚建好就被当成「客户端走了」
   * 收尾掉。症状极具迷惑性：
   *   · `open` / 连接时的底稿 `snapshot`（拆之前写进去的）**能收到**；
   *   · 之后所有**实时事件**（`positions` / `marks` / `fill` / `kline`）**一条都收不到**
   *     —— 因为 `unsubscribe()` 已经把订阅者删了，`emit()` 变成空转；
   *   · 浏览器那边表现为反复 `net::ERR_ABORTED`，而且**自动重连**，
   *     每秒一轮，看着像「连上了但没数据」。
   * 页面「持仓盈利不实时」就是这个 —— 跟 WS、跟算在哪都无关。
   */
  const done = () => {
    if (closed) return
    closed = true
    clearInterval(beat)
    unsubscribe()
    /* 标记价那个旁听也要摘掉，别让「没人看」的连接一直占着 */
    stopMark()
  }
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
 *   `positions` **持仓增量**：常驻流每次刷新持仓（REST 快照 或 标记价重算）都会推。
 *               载荷是 `PositionsPatch`（只有会随行情变的那几项）—— 前端拿着往
 *               已有快照上盖，**不用再打一次 `/trade/positions`**。
 *               这一条是 2026-10-06 改造（P1/P4）加的：交易所界面 / K 线叠加 /
 *               下单页从此**读同一份数据**，同屏不会再出现两个数。
 *   `backfill`  REST 补成交的汇总（前端收到重拉一次成交列表）
 *   `reject`    这套账户不参与统计（现货 / 没填 Key）—— ⚠️ **前端收到必须
 *               `es.close()`**，否则 EventSource 会自动重连，变成一个死循环。
 *   `heartbeat` 20 秒一次（**必须是具名事件**，理由见 `handleKlineStream`）
 *
 * ⚠️ 事件按 `key_id` 广播（`subscribeExchange`），key 是**校验过属于当前用户**的，
 *    所以不会串到别人账上。
 */
/**
 * 交易类写操作失败时**统一记一行日志**（2026-10-06）。
 *
 * ⚠️ 为什么必须记：这些接口失败时只把原因塞进 JSON 返回给前端，
 *    **后端一个字都不留** —— 于是「我试了几次都失败，你看日志」这句话
 *    在日志里**根本查不到**（用户 2026-10-06 就是这么问的）。
 *    挂条件单那类还有 `-2021 / -1106 / -4164` 这种靠猜的码，不记下来没法复盘。
 */
function failTrade(
  res: http.ServerResponse,
  what: string,
  keyId: number | undefined,
  e: unknown
): void {
  const msg = humanizeTrade(e)
  console.warn(
    `[交易所] ${what} 失败${keyId ? `（key=${keyId}）` : ''}：${String(msg).slice(0, 200)}`
  )
  sendJson(res, 200, {ok: false, error: msg})
}

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
    if (ev.type === 'income') return send('income', {added: ev.added})
    /* 挂单变了 → 前端重读一次（**本地读**，毫秒级，见 docs 第 16 节） */
    if (ev.type === 'orders') return send('orders', {reason: ev.reason})
    if (ev.type === 'health') return send('health', {deaf: ev.deaf})
    /*
     * 自动止损挂完了（后台挂的，见下单那段）—— **原样**推给前端：
     * 面板要拿它拼提示（挂在哪 / 跳过了手工止损 / 为什么失败）。
     */
    if (ev.type === 'auto-stop') {
      const {type: _t, ...rest} = ev
      return send('auto-stop', rest)
    }
    /* 加仓后止盈放大（见下单那段）—— 同样原样推，面板拼一句提示 */
    if (ev.type === 'auto-tp') {
      const {type: _t, ...rest} = ev
      return send('auto-tp', rest)
    }
    if (ev.type === 'auto-sl') {
      const {type: _t, ...rest} = ev
      return send('auto-sl', rest)
    }
    /* 减仓后止盈止损收数量（见平仓那段）—— 同样原样推 */
    if (ev.type === 'auto-protect') {
      const {type: _t, ...rest} = ev
      return send('auto-protect', rest)
    }
    return send('backfill', {added: ev.added})
  })

  /*
   * 持仓增量（改造 P1/P4）—— 连上先补一条**底稿**（常驻流内存里那份），
   * 之后每次持仓变化（REST 快照 / 标记价重算）都会推。前端几个页面靠它同步。
   */
  const liveNow = liveStateOf(keyId)
  if (liveNow) {
    send('positions', {
      at: new Date(liveNow.at).toISOString(),
      live: liveNow.live,
      wallet: liveNow.wallet,
      available: liveNow.available,
      unrealized: liveNow.unrealized,
      margin: liveNow.margin,
      stats: liveNow.stats,
      positions: liveNow.positions
    })
  }
  const unsubPositions = subscribePositions(keyId, ev => send('positions', ev.patch))
  /* 心跳必须是具名事件，理由同上 */
  const beat = setInterval(() => send('heartbeat', {}), 20_000)

  /*
   * ⚠️⚠️ **只能听 `res` 的 close，绝不能听 `req` 的**（2026-10-06 查出来的大坑）。
   *
   * Node 16 起 `IncomingMessage` 的 `'close'` 在**请求收完**就触发 ——
   * 对一个 GET 来说就是「刚连上就触发」，于是 SSE 刚建好就被当成「客户端走了」
   * 收尾掉。症状极具迷惑性：
   *   · `open` / 连接时的底稿 `snapshot`（拆之前写进去的）**能收到**；
   *   · 之后所有**实时事件**（`positions` / `marks` / `fill` / `kline`）**一条都收不到**
   *     —— 因为 `unsubscribe()` 已经把订阅者删了，`emit()` 变成空转；
   *   · 浏览器那边表现为反复 `net::ERR_ABORTED`，而且**自动重连**，
   *     每秒一轮，看着像「连上了但没数据」。
   * 页面「持仓盈利不实时」就是这个 —— 跟 WS、跟算在哪都无关。
   */
  let closed = false
  const openedAt = Date.now()
  const done = () => {
    if (closed) return
    closed = true
    /*
     * ⚠️ 只在**短命连接**时打：SSE 正常是长连接，几毫秒就收尾说明有人在建连后
     *    立刻把响应结束掉（会话被踢 / 上游断了 / 前端重连风暴）。
     *    这条日志是 2026-10-06 定位「实时事件全丢了」的关键线索之一，别删。
     */
    const livedMs = Date.now() - openedAt
    if (livedMs < 3000) {
      console.warn(`[exchange/stream] key=${keyId} 连接只活了 ${livedMs}ms 就被收尾`)
    }
    clearInterval(beat)
    unsubscribe()
    unsubPositions()
  }
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

/* ──────────────── 图标**落盘**（用户 2026-10-07：「落盘成本最低」） ────────────────
 *
 * 之前只有「进程内存 + 浏览器 HTTP 缓存」这两层，重启一次就全没了 ——
 * 那几个币又要挨个去打 okx / coincap / spothq（还都是墙外，慢的时候一条 4 秒超时）。
 * 现在取到的字节写进 `data/icons/`，跟 `data/contracts.json` 一个套路：
 * 命中文件就不再打上游，重启也还在。
 *
 * 两条约定：
 *  · 有图 → `data/icons/<key>.<ext>`（ext 由 content-type 推，回读时反查回类型）；
 *  · **没图 → `data/icons/<key>.missing`**，文件里写一行取到的时间。
 *    ⚠️ 不留标记的话重启后又会为这 122 个币各打三趟上游（正是要省的那笔）；
 *    ⚠️ 但标记**不能永久**：图库会慢慢补上新币，所以 `.missing` 超过
 *       `ICON_MISS_TTL_MS`（30 天）就当「不知道」，重新问一次。
 *
 * ⚠️ 只落**能去问上游**的那些 key（`probeable`：纯 ASCII）——
 *    中文名的币（哈基米 / 龙虾…）上游必然没有，落盘只会在盘上堆没用的文件。
 * ⚠️ 磁盘只是**加速**：读写全部 best-effort，出错（没权限 / 盘满）只告警一次，
 *    绝不能让图标接口 500。
 */
const ICON_DIR = path.join(DATA_DIR, 'icons')

/** ext → content-type（回读时用；表里没有的按 `image/<ext>` 反推） */
const ICON_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon'
}

/** content-type → 扩展名（表里没有的用子类型本身：`image/apng` → `apng`） */
function iconExtOf(type: string): string {
  const hit = Object.entries(ICON_TYPES).find(([, t]) => t === type)
  if (hit) return hit[0]
  return (type.split('/')[1] || 'bin').replace(/[^a-z0-9+.-]/gi, '')
}

/** 扩展名 → content-type */
function iconTypeOf(ext: string): string {
  return ICON_TYPES[ext] ?? `image/${ext}`
}

/** `.missing` 记多久（到期重新问上游，见图库补图） */
const ICON_MISS_TTL_MS = 30 * 24 * 3600_000

/** 盘上出过错就只告警一次（别一个图标一条日志把日志刷爆） */
let iconDiskWarned = false
function warnIconDisk(what: string, e: unknown): void {
  if (iconDiskWarned) return
  iconDiskWarned = true
  console.warn(`[icon] 落盘${what}失败（只提示一次，不影响出图）:`, (e as Error).message)
}

/**
 * 读盘：`{buf,type}` = 有图；`null` = 有「上游没有」的标记；`undefined` = 盘上没有记录。
 *
 * ⚠️ 三个返回值要分清 —— `undefined` 才代表「还得去问上游」（`null` 是明确知道没有）。
 */
function loadIconFile(
  key: string
): {buf: Buffer; type: string} | null | undefined {
  let files: string[]
  try {
    // 一次 readdir 拿到这个 key 的所有文件（`.tmp` 那种写了一半的跳过），
    // 不去按扩展名挨个 existsSync —— 扩展名是什么由写盘那刻决定
    files = fs.readdirSync(ICON_DIR).filter(f => f.startsWith(`${key}.`))
  } catch {
    return undefined // 目录还没有 = 什么都没缓存过
  }
  if (!files.length) return undefined
  if (files.includes(`${key}.missing`)) {
    try {
      const at = Date.parse(
        fs.readFileSync(path.join(ICON_DIR, `${key}.missing`), 'utf8').trim()
      )
      // 标记过期 ⇒ 当「不知道」，重新问一次（图库会慢慢补上新币）
      if (Number.isFinite(at) && Date.now() - at < ICON_MISS_TTL_MS) return null
    } catch (e) {
      warnIconDisk('读', e)
    }
    return undefined
  }
  for (const f of files) {
    if (f.endsWith('.tmp')) continue
    try {
      const buf = fs.readFileSync(path.join(ICON_DIR, f))
      if (buf.length) return {buf, type: iconTypeOf(f.slice(key.length + 1))}
    } catch (e) {
      warnIconDisk('读', e)
    }
  }
  return undefined
}

/** 写盘（先写 `.tmp` 再 rename：并发请求同一个币时不会读到写了一半的文件） */
function saveIconFile(
  key: string,
  hit: {buf: Buffer; type: string} | null
): void {
  try {
    fs.mkdirSync(ICON_DIR, {recursive: true})
    if (!hit) {
      const file = path.join(ICON_DIR, `${key}.missing`)
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, new Date().toISOString(), 'utf8')
      fs.renameSync(tmp, file)
      return
    }
    const file = path.join(ICON_DIR, `${key}.${iconExtOf(hit.type)}`)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, hit.buf)
    fs.renameSync(tmp, file)
  } catch (e) {
    warnIconDisk('写', e)
  }
}

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
      /*
       * 先看盘上有没有（重启后就不用再打上游了）。
       * `undefined` = 盘上没记录 ⇒ 才去问那三个源，问完**不管有没有都落盘**。
       */
      const onDisk = loadIconFile(key)
      if (onDisk !== undefined) {
        hit = onDisk
      } else {
        const stripped = key.replace(/^\d+/, '')
        const keys = stripped && stripped !== key ? [key, stripped] : [key]
        hit = await fetchIcon(keys)
        saveIconFile(key, hit)
      }
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
  /* ⚠️ 只能听 `res` 的 close（`req` 的 close 在请求收完就触发，等于立刻「已关闭」） */
  res.on('close', () => (closed = true))

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
/* AI 提示词文档（分析预测 / 润色，全部存数据库）                         */
/* ------------------------------------------------------------------ */

/** 提示词文档类型（认不出的返回 null，由调用方决定默认值） */
const asDocKind = (v: unknown): DocKind | null =>
  v === 'predict' || v === 'extract' || v === 'role' || v === 'rule' || v === 'polish'
    ? (v as DocKind)
    : null

/** 列表 + 「这次真正会发出去什么」的概览 */
async function handleListAiDocs(res: http.ServerResponse): Promise<void> {
  try {
    const [docs, bundle] = await Promise.all([listDocs(), loadRules()])
    /*
     * 提炼那几份（kind=extract）已经不参与拼装了（知识库模块删了），
     * 但**数据留在库里**、提示词页也还列着，所以这里照旧给它一份概览 ——
     * 光看字数与 hash 就能知道「那份东西还在」。
     */
    const extracts = docs.filter(d => d.kind === 'extract' && d.enabled)
    const extractText = extracts.map(d => d.content.trim()).filter(Boolean).join('\n\n')
    sendJson(res, 200, {
      docs,
      /** 「+ 新建分析预测」用的语气预设（同一份定义在 `llm/tone-presets.ts`、启动时会播种） */
      tones: TONE_PRESETS,
      assembly: {
        enabled: bundle.bodyEnabled,
        origin: bundle.origin,
        sources: bundle.sources,
        hash: bundle.hash,
        predictChars: bundle.system.length,
        extractChars: extractText.length,
        extractSources: extracts.map(d => `提炼：${d.name}`),
        extractHash: hashOf(extractText),
        updatedAt: bundle.updatedAt,
        warnings: bundle.warnings
      }
    })
  } catch (e) {
    sendJson(res, 503, {error: dbHelpMessage(e)})
  }
}

async function handleCreateAiDoc(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
  const kind = asDocKind(body.kind) ?? 'predict'
  const name = str(body.name).trim()
  if (!name) return sendJson(res, 400, {error: '请给这份文档起个名字'})
  try {
    const doc = await createDoc({
      kind,
      name,
      content: typeof body.content === 'string' ? body.content : ''
    })
    sendJson(res, 200, {doc})
  } catch (e) {
    sendJson(res, 503, {error: dbHelpMessage(e)})
  }
}

async function handleUpdateAiDoc(
  id: number,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readJsonBody(req).catch(() => null)
  if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
  const patch: Parameters<typeof updateDoc>[1] = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.content === 'string') patch.content = body.content
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  const kind = asDocKind(body.kind)
  if (kind) patch.kind = kind
  if (body.sort !== undefined) patch.sort = Number(body.sort) || 0
  try {
    const doc = await updateDoc(id, patch)
    if (!doc) return sendJson(res, 404, {error: '文档不存在'})
    sendJson(res, 200, {doc})
  } catch (e) {
    sendJson(res, 503, {error: dbHelpMessage(e)})
  }
}

async function handleDeleteAiDoc(
  id: number,
  res: http.ServerResponse
): Promise<void> {
  try {
    const ok = await deleteDoc(id)
    sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '文档不存在'})
  } catch (e) {
    sendJson(res, 503, {error: dbHelpMessage(e)})
  }
}

async function handleListAiVersions(
  docId: number,
  res: http.ServerResponse
): Promise<void> {
  try {
    sendJson(res, 200, {versions: await listVersions(docId)})
  } catch (e) {
    sendJson(res, 503, {error: dbHelpMessage(e)})
  }
}

async function handleGetAiVersion(
  versionId: number,
  res: http.ServerResponse
): Promise<void> {
  try {
    const v = await getVersion(versionId)
    if (!v) return sendJson(res, 404, {error: '版本不存在'})
    sendJson(res, 200, {version: v})
  } catch (e) {
    sendJson(res, 503, {error: dbHelpMessage(e)})
  }
}

async function handleRestoreAiVersion(
  versionId: number,
  res: http.ServerResponse
): Promise<void> {
  try {
    const doc = await restoreVersion(versionId)
    if (!doc) return sendJson(res, 404, {error: '版本不存在'})
    sendJson(res, 200, {doc})
  } catch (e) {
    sendJson(res, 503, {error: dbHelpMessage(e)})
  }
}

/**
 * 看看这次真正发出去的 system prompt 长什么样（分析预测那一份）。
 */
async function handleAiPreview(
  url: URL,
  res: http.ServerResponse,
  user: User
): Promise<void> {
  /* 只留分析预测那份 —— 提炼那份（kind=extract）已随知识库模块下线，数据仍在库里 */
  const bundle = await loadRules()
  sendJson(res, 200, {
    system: buildSystemPrompt(bundle.system),
    enabled: bundle.bodyEnabled,
    sources: bundle.sources,
    hash: bundle.hash
  })
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
 *
 * ★ 2026-10-11：这一次写库现在还**顺带做滑动续期**（`touchSession` 里一起改
 *   `expires_at`）—— 所以节流不只为了省写，也顺手把「活动就续期」的频率
 *   压到每分钟一次，见 `db/users.ts` 的 `SESSION_RENEW_DAYS`。
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
 * 其余（分析、存档、用量、账户、服务器监测）全要登录。
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

  /*
   * **本地开发的「免登录」**（2026-10-15 用户：「就是我不想每次登录」）。
   *
   * 两道闸，缺一不可 —— 谁想开都得**同时**满足：
   *   ① `NODE_ENV !== 'production'`：线上容器里是 `production`（`docker-compose.prod.yml`
   *      和 `Dockerfile` 都写死了），命中这条直接 404，连存在都不承认；
   *   ② 显式设了 `DEV_AUTO_LOGIN`（值是用户名；写 `1` 就当 `admin`）——
   *      不是"没配就默认开"，没配就永远走不到。
   *
   * 命中后发的是一条**正常的会话 token**（照样落 `sessions` 表、同样 30 天、
   * 「登录设备」里能看到、也能踢），不是绕过鉴权的后门：只是省掉输密码 + 动态口令。
   */
  if (p === '/api/auth/dev-login') {
    if (method !== 'GET') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const flag = process.env.DEV_AUTO_LOGIN
    if (process.env.NODE_ENV === 'production' || !flag) {
      return sendJson(res, 404, {error: 'Not Found'})
    }
    const username = flag === '1' ? 'admin' : flag
    const u = await userByName(username)
    if (!u) {
      return sendJson(res, 400, {
        error: `DEV_AUTO_LOGIN 指定的用户不存在：${username}`
      })
    }
    const s = await startSession(u.id, sessionMeta(req))
    console.log(`  [dev] 免登录：${username}（DEV_AUTO_LOGIN 开的，线上没有这条）`)
    return sendJson(res, 200, {token: s.token, expiresAt: s.expiresAt, user: u})
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
   * 其余都要登录 —— 分析、存档、用量、账户、服务器监测
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

  /* ---- 盘中体检 / 盘后复盘（2026-10-22）----
   *
   * ⚠️ **只读**：这几个接口不参与下单、不改参数、不拦任何请求。
   *    用户原话：「我不希望你再对我的开单有限制……开单之后给我状态和改进的点」。
   *    数据见 `data/position-live.ts`（体检卡）与 `data/trade-review.ts`（复盘）。
   */
  if (p === '/api/positions/live') {
    if (method !== 'GET') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const cards = await listHealthCards(me.id)
    return sendJson(res, 200, {cards, at: Date.now()})
  }

  if (p === '/api/reviews' && method === 'GET') {
    const kind = url.searchParams.get('kind') === 'summary' ? 'summary' : 'trade'
    const limit = Number(url.searchParams.get('limit') ?? 50) || 50
    const keyRaw = Number(url.searchParams.get('keyId'))
    const keyId = Number.isFinite(keyRaw) && keyRaw > 0 ? keyRaw : null
    const resultRaw = url.searchParams.get('result')
    const holdRaw = url.searchParams.get('hold')
    const query: ReviewQuery = {
      keyId,
      result: resultRaw === 'win' || resultRaw === 'loss' ? resultRaw : null,
      hold: holdRaw === 'lt30' || holdRaw === 'gte30' ? holdRaw : null,
      order: url.searchParams.get('order') === 'desc' ? 'desc' : 'asc'
    }
    const [reviews, keys, total] = await Promise.all([
      listReviews(me.id, kind, limit, query),
      listExchangeKeys(me.id, {all: true}),
      countReviews(me.id, kind, query)
    ])
    /* 账户清单一起回：前端那颗筛选器照着画，省得再请求一次 */
    const accounts = keys.map(k => ({id: k.id, name: k.name}))
    return sendJson(res, 200, {reviews, kind, accounts, total})
  }

  /*
   * 周期总结（2026-10-22 晚）：自己选一段时间 → 出这一段的总结。
   * ⚠️ 直接从成交账本算，**不读 `trade_reviews`** —— 所以没有「补历史」、也没有默认同步。
   */
  if (p === '/api/review-summary' && method === 'GET') {
    const fromRaw = Number(url.searchParams.get('from'))
    const toRaw = Number(url.searchParams.get('to'))
    const keyRaw = Number(url.searchParams.get('keyId'))
    const summary = await summarizeRange(
      me.id,
      Number.isFinite(keyRaw) && keyRaw > 0 ? keyRaw : null,
      Number.isFinite(fromRaw) && fromRaw > 0 ? fromRaw : null,
      Number.isFinite(toRaw) && toRaw > 0 ? toRaw : null
    )
    const keys = await listExchangeKeys(me.id, {all: true})
    return sendJson(res, 200, {
      summary,
      accounts: keys.map(k => ({id: k.id, name: k.name}))
    })
  }

  /*
   * 仓位明细（2026-10-22 晚）：**单位是仓位周期**（0 → 加仓 → 减仓 → 归零），
   * 不是单张成交 —— 用户：「不要以每笔为单位，因为一次交易可能拆成多个订单」。
   */
  if (p === '/api/position-cycles' && method === 'GET') {
    const fromRaw = Number(url.searchParams.get('from'))
    const toRaw = Number(url.searchParams.get('to'))
    const keyRaw = Number(url.searchParams.get('keyId'))
    const limit = Number(url.searchParams.get('limit') ?? 200) || 200
    const cycles = await listCycleDetails(
      me.id,
      Number.isFinite(keyRaw) && keyRaw > 0 ? keyRaw : null,
      Number.isFinite(fromRaw) && fromRaw > 0 ? fromRaw : null,
      Number.isFinite(toRaw) && toRaw > 0 ? toRaw : null,
      limit
    )
    return sendJson(res, 200, {cycles})
  }

  if (p === '/api/reviews/summary' && method === 'GET') {
    const summaries = await listReviews(me.id, 'summary', 50)
    return sendJson(res, 200, {summaries})
  }

  if (p.startsWith('/api/reviews/') && method === 'GET') {
    const id = Number(p.slice('/api/reviews/'.length))
    if (!Number.isFinite(id)) return sendJson(res, 400, {error: 'id 不合法'})
    const review = await getReview(me.id, id)
    if (!review) return sendJson(res, 404, {error: '没有这条复盘'})
    return sendJson(res, 200, {review})
  }

  /*
   * 给历史仓位补复盘（这张表上线之前平掉的单子没有 plan）。
   * 幂等：已经复盘过的那一笔会跳过。只在用户自己点「补历史」时跑一次。
   */
  if (p === '/api/reviews/backfill' && method === 'POST') {
    const keys = await listExchangeKeys(me.id, {all: true})
    let created = 0
    for (const k of keys) {
      try {
        created += await backfillReviews(me.id, k.id)
      } catch (e) {
        console.error(`[reviews] 回填 ${k.id} 失败：`, (e as Error).message)
      }
    }
    return sendJson(res, 200, {ok: true, created})
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

  /* ---- 黑名单（每用户，2026-10-10）---- */
  /*
   * 用户：「在 k 线界面收藏按钮旁加个图标，点击后弹窗确认，加入黑名单后 24 小时不得开单」
   * → 2026-10-17「黑名单机制改为 8 小时」
   * → 2026-10-18「可选择封禁时间，最大 24 小时……点击 8 次可取消封禁」：
   *   时长改成**每次自己选**（`hours`，1 – 24，见 `db/blacklist.ts` 的 `clampHours`）。
   *
   * `hours` / `maxHours` 一起回给前端：那是「默认值」和「上限」，前端那颗选择器照着画。
   */
  if (p === '/api/blacklist' && method === 'GET') {
    const entries = await listBlacklist(me.id)
    return sendJson(res, 200, {
      entries,
      hours: BLACKLIST_DEFAULT_HOURS,
      maxHours: BLACKLIST_MAX_HOURS
    })
  }

  /** 关进去 `hours` 小时（默认 8、上限 24），前端那颗 🚫 按一下才走到这儿 */
  if (p === '/api/blacklist' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const r = await lockBase(me.id, str(body.base), Number(body.hours))
      return sendJson(res, 200, {
        entries: await listBlacklist(me.id),
        hours: BLACKLIST_DEFAULT_HOURS,
        maxHours: BLACKLIST_MAX_HOURS,
        already: r.already,
        until: r.entry.until,
        error: null
      })
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /**
   * 提前解除 —— **只服务前端那个「连点 8 下」的手势**（用户 2026-10-18）。
   *
   * ⚠️ 别在页面上给它加按钮入口：这个锁是给自己上的，随手能解开就等于没锁；
   *    连点 8 下 + 一次性确认，是刻意留的那点摩擦。
   */
  if (p === '/api/blacklist/unlock' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const had = await unlockBase(me.id, str(body.base))
      return sendJson(res, 200, {
        entries: await listBlacklist(me.id),
        removed: had,
        error: null
      })
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /* ---- 币种标注（2026-10-20，见 db/annotations.ts）----
   *
   * 用户：「合约行情界面显示我对币种的标注数据……K 线页面顶部右侧加一个按钮，
   * 点击之后底部弹窗可以打标签和描述，标签可选可维护」。
   *
   *   GET    /api/annotations             每个币最新一条（行情列表用）+ 标签词表
   *   GET    /api/annotations?base=BTC    这个币的全部历史（K 线底部用）+ 标签词表
   *   POST   /api/annotations             追加一条（body: base / tags / note）
   *   DELETE /api/annotations/:id         删一条（只能删自己的）
   *   POST   /api/annotation-tags         新增标签（body: name / color?）
   *   POST   /api/annotation-tags/:id     改标签名或颜色（改名时历史里的同名标签一起改）
   *   DELETE /api/annotation-tags/:id     删标签（不动历史里的名字）
   *
   * ⚠️ 全是纯读库 / 写库，不打交易所、不计权重；**全部要登录**，按 me.id 隔离。
   */
  if (p === '/api/annotations' && method === 'GET') {
    try {
      const rawBase = str(url.searchParams.get('base') ?? '').trim()
      if (rawBase) {
        const [tags, entries] = await Promise.all([
          listAnnotationTags(me.id),
          listSymbolAnnotations(me.id, rawBase)
        ])
        return sendJson(res, 200, {tags, entries, error: null})
      }
      const [tags, latest] = await Promise.all([
        listAnnotationTags(me.id),
        listLatestAnnotations(me.id)
      ])
      return sendJson(res, 200, {tags, latest, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  if (p === '/api/annotations' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const entry = await saveSymbolAnnotation(me.id, {
        base: body.base,
        tags: body.tags,
        note: body.note
      })
      return sendJson(res, 200, {entry, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  const annotationMatch = /^\/api\/annotations\/(\d+)$/.exec(p)
  if (annotationMatch && method === 'DELETE') {
    try {
      const ok = await deleteSymbolAnnotation(me.id, Number(annotationMatch[1]))
      return sendJson(res, ok ? 200 : 404, {
        ok,
        error: ok ? null : '没这条标注'
      })
    } catch (e) {
      return sendJson(res, 400, {ok: false, error: (e as Error).message})
    }
  }

  if (p === '/api/annotation-tags' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const r = await createAnnotationTag(me.id, body.name, body.color)
      return sendJson(res, 200, {tag: r.tag, tags: r.tags, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  const annotationTagMatch = /^\/api\/annotation-tags\/(\d+)$/.exec(p)
  if (annotationTagMatch && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const r = await updateAnnotationTag(
        me.id,
        Number(annotationTagMatch[1]),
        {name: body.name, color: body.color}
      )
      return sendJson(res, 200, {tag: r.tag, tags: r.tags, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  if (annotationTagMatch && method === 'DELETE') {
    try {
      const tags = await deleteAnnotationTag(me.id, Number(annotationTagMatch[1]))
      return sendJson(res, 200, {tags, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

/**
 * **面板那条「走内存快照」的近路**（2026-10-21）。
 *
 * 常驻流（`data/position-cache`）一直在推「可用余额 / 钱包 / 持仓（含杠杆和账本侧信息）」，
 * 跟 `/api/exchange/trade/positions` 是同一份。下单面板只要这些 + 合约规格，
 * 所以能拼出来就**一次交易所都不打**（实测 130~165ms → 5ms 上下）。
 *
 * 什么时候拼不出来（返回 null，调用方退回真打交易所）：
 *   · 这套 Key 的常驻流没在跑（刚启动 / 断流）；
 *   · 这个币**没有持仓**、而且我们也没记过它的杠杆（`positionRisk` 里才有，别拿 10 倍糊弄）；
 *   · 合约规格在本地表里查不到（`specFor` 会自己去问一次）。
 *
 * ⚠️ 返回的 `positionMeta` 是常驻流顺手查好的（开仓时间 / 已实现盈利），
 *    走这条路反而**省了**原来那两发账本查询。
 */
async function tradeInfoFromLive(
  key: ExchangeKey,
  creds: ExchangeCredentials,
  rawSymbol: string
): Promise<{info: TradeInfo; positionMeta: PositionMeta | null} | null> {
  if (!isStreamActive(key.id)) return null
  const live = liveStateOf(key.id)
  if (!live) return null
  // 快照太旧（刚起流、还没推到第一份）就别拿它冒充实时 —— 老老实实打一次交易所
  if (!(live.at > 0) || Date.now() - live.at > 30_000) return null
  let spec: Awaited<ReturnType<typeof specFor>>
  try {
    spec = await specFor(creds, rawSymbol)
  } catch {
    return null
  }
  const row = live.positions.find(p => p.raw === spec.symbol) ?? null
  const memo = row?.leverage
    ? {lev: Number(row.leverage), max: knownLeverage(key.id, spec.symbol)?.max ?? null}
    : knownLeverage(key.id, spec.symbol)
  // 杠杆不知道就别猜（数量 / 所需保证金都会跟着错）
  if (!memo || !(memo.lev > 0)) return null

  return {
    info: {
      symbol: spec.symbol,
      base: spec.base,
      balance: {
        available: live.available,
        wallet: live.wallet,
        unrealized: live.unrealized
      },
      leverage: memo.lev,
      maxLeverage: memo.max,
      position: row
        ? {
            side: row.side === 'short' ? 'short' : 'long',
            amount: Math.abs(Number(row.amount) || 0),
            entryPrice: Number(row.entryPrice) || 0,
            markPrice: Number(row.markPrice) || 0,
            unrealized: Number(row.unrealizedPnl) || 0,
            notional: Number(row.notional) || 0,
            maintMargin: Number(row.maintMargin) || 0,
            mmr: Number(row.mmr) || 0,
            leverage: Number(row.leverage) || memo.lev,
            liquidationPrice:
              row.liquidationPrice != null && Number(row.liquidationPrice) > 0
                ? Number(row.liquidationPrice)
                : null
          }
        : null,
      amountPrecision: stepToDecimals(spec.stepSize),
      pricePrecision: stepToDecimals(spec.tickSize),
      minAmount: spec.minQty,
      minCost: spec.minNotional,
      balanceError: null,
      errors: []
    },
    positionMeta: row?.meta ?? null
  }
}

  /* ---- 账户统计配置（每用户，2026-10-09）---- */
  /*
   * 用户 2026-10-09：「在配置里面选择的配置，要保存到个人的后端和个人信息中」。
   * 之前只有浏览器 localStorage，换设备就丢；现在按用户存库，
   * 账户统计页和「个人信息 → 账户信息」两处读写的都是这一份。
   */
  if (p === '/api/stats-settings') {
    if (method === 'GET') {
      const settings = await getStatsSettings(me.id)
      return sendJson(res, 200, {settings, error: null})
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      try {
        const settings = await saveStatsSettings(me.id, body)
        // 配置直接改变收益率口径 ⇒ 前端拿到后要重算，这里不回统计值，由前端自己再拉
        return sendJson(res, 200, {settings, error: null})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /* ---- 持久化分析：手动把某个币加入「每 15 分钟问一次 AI」（2026-10-15） ----
   *
   * 用户 2026-10-15：「在 k 线界面顶部加入持久化分析的图标，点击图标弹窗确定要加入持久化分析，
   * 每隔 15 分钟分析一次，最长不超过 8 小时」。
   *
   *   · `GET    /api/persist`            —— 列表（含每个会话的结论时间线）
   *   · `POST   /api/persist`            —— 加入（body: symbol / market / timeframe；
   *                                        **周期同时决定频率**：15m ⇒ 每 15 分钟 / 8 小时，
   *                                        1h ⇒ 每小时 / 16 小时，见 `db/persist.ts` 的 `CADENCES`）
   *   · `DELETE /api/persist?id=`        —— 停止
   *   · `POST   /api/persist/run?id=`    —— 立刻跑一轮（等结果，给人手动试一次用）
   *
   * ⚠️ 真正"每 15 分钟跑"的是后台 ticker（见文件末尾 `startPersistTicker`），
   *    这些接口只管会话的增删查 —— 网页关着也照跑。
   */
  if (p === '/api/persist') {
    if (method === 'GET') {
      const sessions = await listPersistSessions(me.id)
      const withTimeline = await Promise.all(
        sessions.map(async s => ({...s, timeline: await sessionTimeline(s)}))
      )
      return sendJson(res, 200, {
        sessions: withTimeline,
        /* 节奏表直接给前端（界面上要显示"每 N 分钟一次 / 最长 N 小时 / ≈N 次"） */
        limits: {maxActive: MAX_ACTIVE_PER_USER, cadences: CADENCES},
        error: null
      })
    }
    if (method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      const symbol = String(body.symbol ?? '').trim().toUpperCase()
      if (!symbol) return sendJson(res, 400, {error: '缺 symbol'})
      /*
       * ⚠️ `market` 必须收口到 `MarketType` 那三个值：从前这里是 `String(body.market ?? 'swap')`
       *    直接透传，前端一旦漏传/传错（比如 `perp`），会安静地建出一个**永远取不到行情**的会话
       *    —— 三轮失败后暂停，用户看到的只是「加了但一直没结论」。宁可当场落回 swap。
       */
      const rawMarket = String(body.market ?? 'swap').trim().toLowerCase()
      const marketType: MarketType = rawMarket === 'spot' || rawMarket === 'coinm' ? rawMarket : 'swap'
      /*
       * ⚠️ 周期**必须**是 `CADENCES` 里那两个（15m / 1h）：它同时决定"多久问一次"和"盯多久"，
       *    传个别的过来（比如 4h）会让整个会话的节奏对不上，所以直接挡掉、别默默落回默认。
       */
      const timeframe = String(body.timeframe ?? '15m')
      if (!CADENCES.some(c => c.timeframe === timeframe)) {
        return sendJson(res, 200, {
          error: `只支持 ${CADENCES.map(c => c.timeframe).join(' / ')} 两个周期`
        })
      }
      /* 「回看天数」不再让人选（2026-10-16 用户：「回看几天的去掉」）—— 固定默认，不读 body */
      const days = DEFAULT_DAYS
      /*
       * 配额：同时最多 3 个会话。满了要说清"去停一个"，别静默失败。
       * ⚠️ 同一个币重复点：库里那条 `(user_id, symbol) WHERE status='active'` 唯一索引会挡，
       *    这里先查一次给出人话错误。
       */
      const active = await countActive(me.id)
      if (active >= MAX_ACTIVE_PER_USER)
        return sendJson(res, 200, {
          error: `同时最多盯 ${MAX_ACTIVE_PER_USER} 个币 —— 先去停掉一个再加`
        })
      /*
       * 加入时就把符号解析成交易所认得的那一个（`resolveTradable` 跟取数是同一条路）。
       * 解析不出来**当场**报错、别建会话：持久化是「加完就不管了」，错误要在这里看得见。
       */
      let ccxt: string
      try {
        ccxt = await resolveTradable({exchangeId: 'binance', symbol, marketType})
      } catch (e) {
        return sendJson(res, 200, {error: (e as Error).message})
      }
      try {
        const created = await createPersistSession({
          userId: me.id,
          symbol,
          ccxtSymbol: ccxt,
          exchange: 'binance',
          marketType,
          timeframe,
          days
        })
        return sendJson(res, 200, {session: created, error: null})
      } catch (e) {
        const msg = (e as Error).message
        return sendJson(res, 200, {
          error: /duplicate key|unique/i.test(msg)
            ? `${symbol} 已经在持久化分析里了`
            : msg
        })
      }
    }
    if (method === 'DELETE') {
      const id = Number(url.searchParams.get('id'))
      if (!Number.isFinite(id) || id <= 0) return sendJson(res, 400, {error: '缺 id'})
      const ok = await stopPersistSession(me.id, id)
      return sendJson(res, 200, {ok, error: ok ? null : '这个会话不在了（或不属于你）'})
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  if (p === '/api/persist/run') {
    if (method !== 'POST') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const id = Number(url.searchParams.get('id'))
    const s = Number.isFinite(id) && id > 0 ? await getPersistSession(id) : null
    if (!s || s.userId !== me.id) return sendJson(res, 200, {error: '这个会话不在了（或不属于你）'})
    if (s.status !== 'active') return sendJson(res, 200, {error: '这个会话已经结束了'})
    /* 手动跑一轮：跑完把结论带回来（等价于调度器那一跳对这个会话做的事） */
    const out = await runSessionOnce(s)
    if (!out.ok) return sendJson(res, 200, {error: out.error ?? '这一轮失败'})
    return sendJson(res, 200, {ok: true, result: out, error: null})
  }

  /* ---- 提醒流水（给 App 里那个前台服务轮询；2026-10-16） ----
   *
   * `GET /api/persist/alerts?since=<id>` —— 比 `since` 新的「转可做」提醒（老的在前）。
   *
   * 为什么要这个接口：手机上**没有谷歌服务**时 FCM 用不了（华为），改成 App 自己跑一个
   * 前台服务定时问一句"有没有新提醒"。所以 `since` 这个锚点必须由服务端给，
   * 而且**第一次不带 since** 时返回 `latest`（当前最大 id）让人从"现在"开始 —— 否则
   * 一打开就把历史提醒全弹一遍。
   */
  if (p === '/api/persist/alerts') {
    if (method !== 'GET') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const raw = url.searchParams.get('since')
    /* 不带 since ⇒ 只回锚点（客户端从"现在"开始看） */
    if (raw === null) {
      return sendJson(res, 200, {alerts: [], latest: await latestAlertId(me.id), error: null})
    }
    const since = Number(raw)
    const alerts = await listAlerts(me.id, Number.isFinite(since) && since > 0 ? since : 0)
    return sendJson(res, 200, {
      alerts,
      latest: alerts.length ? alerts[alerts.length - 1]!.id : Math.max(0, since),
      error: null
    })
  }

  /* ---- App 推送 token（2026-10-15 用户：「加入 app 推送」） ----
   *
   *   · `POST   /api/push/token`  —— App 启动时把 FCM token 报上来（body: token / platform / device）
   *   · `DELETE /api/push/token`  —— 退出登录时注销这一条（`?token=`）
   *
   * ⚠️ 发通知**不在这里**：那是后台跑持久化分析时顺手发的（`analysis/persist.ts` 的 `pushAlert`），
   *    网页关着、App 没开也照发。
   */
  /*
   * 推送的**状态与自检**（给「我的」那张卡用）：
   *   · `GET  /api/push/status` —— 服务端配没配 + 这台账号报了哪些设备
   *   · `POST /api/push/test`   —— 现在发一条，用来验证整条链
   *     （不然要等"转可做"，而模型大多数时候给的是不可做/观望，等一整天也可能没有）
   */
  if (p === '/api/push/status') {
    if (method !== 'GET') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const st = pushStatus()
    const devices = await listPushDevices(me.id)
    return sendJson(res, 200, {
      configured: st.ok,
      detail: st.detail,
      devices: devices.map(d => ({
        device: d.device || '（没报设备名）',
        platform: d.platform,
        disabled: d.disabledAt !== null,
        lastError: d.lastError
      })),
      error: null
    })
  }

  if (p === '/api/push/test') {
    if (method !== 'POST') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const tokens = await listPushTokens(me.id)
    if (!tokens.length) {
      return sendJson(res, 200, {
        sent: 0,
        devices: 0,
        configured: pushConfigured(),
        error: '这个账号还没有设备上报过 —— 要在 App 里打开一次（旧包没有推送功能）'
      })
    }
    let sent = 0
    for (const t of tokens) {
      const r = await sendPush(t.token, {
        title: 'Ait 测试推送',
        body: `看到这条就说明通了 · 第 ${tokens.length} 台设备里的这一台`,
        data: {symbol: '', test: '1'}
      })
      if (r.ok) sent++
      else if (r.dead) await disablePushToken(t.token, r.reason).catch(() => undefined)
      else await notePushError(t.token, r.reason).catch(() => undefined)
    }
    return sendJson(res, 200, {
      sent,
      devices: tokens.length,
      configured: pushConfigured(),
      error: sent ? null : '一条都没发出去 —— 看服务端日志里 [push] 那几行'
    })
  }

  if (p === '/api/push/token') {
    const body = method === 'POST' ? await readJsonBody(req).catch(() => null) : null
    const rawToken =
      method === 'POST'
        ? str(body?.token)
        : (url.searchParams.get('token') ?? '').trim()
    if (!rawToken) return sendJson(res, 400, {error: '缺 token'})
    if (method === 'POST') {
      await savePushToken({
        userId: me.id,
        token: rawToken,
        platform: str(body?.platform) || 'android',
        device: str(body?.device)
      })
      return sendJson(res, 200, {ok: true, error: null})
    }
    if (method === 'DELETE') {
      await dropPushToken(me.id, rawToken)
      return sendJson(res, 200, {ok: true, error: null})
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /* ---- 自动化预测：扫描参数 + 当前这一轮的候选（2026-10-12） ----
   *
   * 用户 2026-10-12：「可调参数 改为前端配置 留着」「新建一个页面叫自动化预测…
   * 显筛选的币种」。所以这两条接口服务「开单分析 → 自动化预测」那一页：
   *   · `/api/scan/settings` —— 参数读写（跟 `/api/stats-settings` 一个路数：按用户存库）
   *   · `/api/scan/picks`    —— **只挑候选**（纯 SQL 读本地 K 线，不调模型、不花钱）
   *
   * ⚠️ `picks` 是只读快照：它不落库、不写 `analyses`、也不发通知。
   *    真正的后台定时扫描是后面那一段的事（`scan/scanner.ts`），这一版先让人能在网页上看清"筛出来的币种"。
   */
  if (p === '/api/scan/settings') {
    if (method === 'GET') {
      return sendJson(res, 200, {params: await getScanParams(me.id), error: null})
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      // 脏值不报错，`normalizeScanParams` 自己收口（能修的修、不能修的落回默认）
      return sendJson(res, 200, {params: await saveScanParams(me.id, body), error: null})
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  if (p === '/api/scan/picks') {
    if (method !== 'GET') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const atRaw = Number(url.searchParams.get('at'))
    try {
      const params = await getScanParams(me.id)
      const result = await pickCandidates({
        userId: me.id,
        params,
        at: Number.isFinite(atRaw) && atRaw > 0 ? atRaw : null
      })
      return sendJson(res, 200, {params, ...result, error: null})
    } catch (e) {
      return sendJson(res, 502, {error: (e as Error).message})
    }
  }

  /* ---- K 线画线 + 穿线提醒（2026-10-17） ----
   *
   * 用户 2026-10-17：「k 线界面…改为划线模式…点击画的线可以添加超过该线提醒，
   * 在自动化预测显示所有的提醒」。
   *
   * · 画线存库（`kline_drawings`）：手机和电脑看的是同一套线；
   * · 提醒存库 + **服务器自己盯价**（`price-alerts.ts`）：网页没开也会响。
   *
   * ⚠️ `symbol` 一律收成**基础币**（`normalizeBase`：`DOGE` / `doge` / `DOGEUSDT` 都进同一格），
   *    盯价那边再拼成币安原始交易对。
   */
  if (p === '/api/kline/drawings') {
    const symbol = normalizeBase(url.searchParams.get('symbol') ?? '')
    if (method === 'GET') {
      if (!symbol) return sendJson(res, 400, {error: '缺 symbol'})
      return sendJson(res, 200, {
        symbol,
        items: await getKlineDrawings(me.id, symbol),
        error: null
      })
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      const sym = normalizeBase(body?.symbol ?? symbol)
      const items = Array.isArray(body?.items) ? (body.items as unknown[]) : null
      if (!sym) return sendJson(res, 400, {error: '缺 symbol'})
      if (!items) return sendJson(res, 400, {error: 'items 要是数组'})
      /* 一条线最多几十字节，几十条也就几 KB —— 再大基本是有人乱塞，直接拒 */
      if (items.length > 200) return sendJson(res, 400, {error: '线太多了（上限 200 条）'})
      await saveKlineDrawings(me.id, sym, items)
      return sendJson(res, 200, {symbol: sym, count: items.length, error: null})
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  if (p === '/api/kline/alerts' || p.startsWith('/api/kline/alerts/')) {
    const rest = p.slice('/api/kline/alerts'.length).replace(/^\//, '')
    if (!rest && method === 'GET') {
      return sendJson(res, 200, {alerts: await listKlineAlerts(me.id), error: null})
    }
    if (!rest && method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      const symbol = normalizeBase(body?.symbol)
      const price = Number(body?.price)
      const op = body?.op === 'below' ? 'below' : 'above'
      if (!symbol) return sendJson(res, 400, {error: '缺 symbol'})
      if (!Number.isFinite(price) || price <= 0) {
        return sendJson(res, 400, {error: '价格要是正数'})
      }
      const alert = await createKlineAlert({
        userId: me.id,
        symbol,
        price,
        op,
        note: str(body?.note).slice(0, 120)
      })
      /* 立刻捞进盯价那张表，不用等下一分钟的 reload */
      await noteAlertChanged()
      return sendJson(res, 200, {alert, error: null})
    }
    const id = Number(rest.split('/')[0])
    if (!Number.isFinite(id) || id <= 0) return sendJson(res, 400, {error: 'id 不对'})
    if (method === 'DELETE') {
      const ok = await deleteKlineAlert(me.id, id)
      if (ok) await noteAlertChanged()
      return sendJson(res, ok ? 200 : 404, {ok, error: ok ? null : '没这条提醒'})
    }
    /* 重新盯：响过的再挂回去（用户 2026-10-17：「这条我还想它下次再响」） */
    if (method === 'POST' && rest.endsWith('/arm')) {
      const ok = await rearmKlineAlert(me.id, id)
      if (ok) await noteAlertChanged()
      return sendJson(res, ok ? 200 : 404, {ok, error: ok ? null : '没这条提醒'})
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /* ---- 日记（2026-10-18） ----
   *
   * 用户：「日记模块可以加入某些币种，总结」→「是我手动写日记，不一定每天」
   * → 当天又改口：「**不要自动按月总结了，默认排版，不显示什么总结，就是每日感想，可以筛选**」。
   *
   *   GET    /api/journal/entries            倒序列出（?coin=&q=&month=&category=&limit=&offset=）
   *   POST   /api/journal/entries            新建 / 更新一条（带 id 就是更新）
   *   DELETE /api/journal/entries/:id        删一条
   *   POST   /api/journal/entries/:id/pin    置顶 / 取消置顶（body: {pinned}）
   *   GET    /api/journal/categories         分类列表（首次自动种 仓位 / 经验 / 回忆录）
   *   POST   /api/journal/categories         新增一个分类（body: {name, color?}）
   *
   * ⚠️ 全是纯读库 + 写库：**不打交易所、不计权重、不调模型**。
   * ⚠️ 不再有 `/api/journal`（按月统计）、`/summary`（月度总结）、`/months`、`/coin` —— 都已删。
   */
  /*
   * 文件夹筛选的**服务器配置**（用户 2026-10-20：「文件夹可多选显示，保存到服务器配置中」）。
   *
   *   GET /api/journal/prefs   → `{categories: number[]}`（空 = 全部）
   *   PUT /api/journal/prefs   → body `{categories: number[]}`，只留用户真有的分类
   */
  if (p === '/api/journal/prefs') {
    if (method === 'GET') {
      try {
        const categories = await getJournalPrefs(me.id)
        return sendJson(res, 200, {categories, error: null})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      try {
        const categories = await saveJournalPrefs(me.id, body.categories)
        return sendJson(res, 200, {categories, error: null})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  if (p === '/api/journal/entries' && method === 'GET') {
    try {
      const list = await listJournalEntries(me.id, {
        coin: str(url.searchParams.get('coin') ?? ''),
        q: str(url.searchParams.get('q') ?? ''),
        /* 月份可以多选：`months=2026-09,2026-10`（老的 `month=` 也认） */
        months: str(url.searchParams.get('months') ?? url.searchParams.get('month') ?? '')
          .split(',')
          .map(m => m.trim())
          .filter(Boolean),
        /* 分类也可以多选：`categories=3,5`（老的 `category=` 还认，单值） */
        categories: (
          url.searchParams.get('categories') ??
          url.searchParams.get('category') ??
          ''
        )
          .split(',')
          .map(v => Number(v) || 0)
          .filter(v => v > 0),
        limit: Number(url.searchParams.get('limit') ?? 0) || undefined,
        offset: Number(url.searchParams.get('offset') ?? 0) || 0
      })
      return sendJson(res, 200, {...list, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  if (p === '/api/journal/entries' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const entry = await saveJournalEntry(me.id, {
        id: Number(body.id) || null,
        title: str(body.title),
        body: str(body.body),
        coins: body.coins,
        categoryId: Number(body.categoryId) || null
      })
      return sendJson(res, 200, {entry, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /* 置顶 / 取消置顶 —— 必须排在下面那条 DELETE 前面：
     否则 `/entries/12/pin` 会被当成 id = "12/pin" 直接吃掉（Number → NaN）。 */
  const pinMatch = /^\/api\/journal\/entries\/(\d+)\/pin$/.exec(p)
  if (pinMatch && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    const id = Number(pinMatch[1])
    const ok = await setJournalPinned(me.id, id, body?.pinned !== false)
    return sendJson(res, ok ? 200 : 404, {ok, error: ok ? null : '没这条日记'})
  }

  if (p.startsWith('/api/journal/entries/') && method === 'DELETE') {
    const id = Number(p.slice('/api/journal/entries/'.length))
    if (!Number.isFinite(id) || id <= 0) return sendJson(res, 400, {error: 'id 不对'})
    const ok = await deleteJournalEntry(me.id, id)
    return sendJson(res, ok ? 200 : 404, {ok, error: ok ? null : '没这条日记'})
  }

  /* 分类：列 / 新增（用户 2026-10-18：「添加分类……筛选某一个分类」） */
  if (p === '/api/journal/categories' && method === 'GET') {
    try {
      return sendJson(res, 200, {categories: await listJournalCategories(me.id), error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /* 改 / 删一个分类（用户 2026-10-18：「分类可以编辑删除」） */
  const catMatch = /^\/api\/journal\/categories\/(\d+)$/.exec(p)
  if (catMatch && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const category = await updateJournalCategory(me.id, Number(catMatch[1]), {
        name: body.name,
        color: body.color
      })
      return sendJson(res, 200, {category, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  if (catMatch && method === 'DELETE') {
    try {
      const ok = await deleteJournalCategory(me.id, Number(catMatch[1]))
      return sendJson(res, ok ? 200 : 404, {ok, error: ok ? null : '没这个分类'})
    } catch (e) {
      return sendJson(res, 400, {ok: false, error: (e as Error).message})
    }
  }

  if (p === '/api/journal/categories' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      const category = await createJournalCategory(me.id, {
        name: body.name,
        color: body.color
      })
      return sendJson(res, 200, {category, error: null})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
  }

  /* 日记正文交给模型润色（用户 2026-10-18：「标题旁加个 ai 的图标，可以美化正文部分」）。
   *
   * 只改写法、不改事实；**不落库** —— 结果回给前端做预览，用户点「用这段」才随正常保存写进去。
   * 记账走 `recordUsage`（kind='polish'），跟别的模型调用一个口径。
   */
  if (p === '/api/journal/polish' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const text = str(body.text).trim().slice(0, MAX_BODY)
    if (!text) return sendJson(res, 400, {error: '先写点正文再美化'})
    try {
      const resolved = await resolveUserLlm(me.id)
      const config = loadConfig({llm: resolved.llm})
      await ensurePolishDoc()
      const prompt = await loadPolishRules()
      const r = await polishText(text, config, prompt.system)
      await recordUsage({
        userId: me.id,
        llmKeyId: resolved.keyId,
        kind: 'polish',
        model: r.model,
        usage: r.usage,
        attempts: r.attempts,
        latencyMs: r.latencyMs
      })
      return sendJson(res, 200, {text: r.text, error: null})
    } catch (e) {
      return sendJson(res, 200, {text: '', error: (e as Error).message})
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
          // 任意区间（用的是「带日历图标的日期输入框」，见 `UsageView`）
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
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
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
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

    /*
     * 列表（一套都没有时会自动建一套「默认」，见 db/exchange-keys.ts）。
     * `?all=1` = 连**被隐藏**的一起给（只有「个人信息 → 交易所」那个管理列表会带；
     * 其余页面走默认值 ⇒ 隐藏的账户一概不渲染，用户 2026-10-18）。
     */
    if (p === '/api/exchange-keys' && method === 'GET') {
      const keys = await listExchangeKeys(me.id, {
        all: url.searchParams.get('all') === '1'
      })
      return sendJson(res, 200, {
        keys: keys.map(publicExchangeKey),
        exchanges: EXCHANGE_CATALOG,
        marketTypes: [...MARKET_TYPES],
        /** 最多能绑几套（前端拿它禁用「新增」按钮，别自己写死一个数） */
        max: MAX_EXCHANGE_KEYS
      })
    }

    /*
     * 拖拽排序（用户 2026-10-10）：传**拖完之后的完整顺序**。
     * ⚠️ 必须放在下面那条 `/api/exchange-keys/(\d+)` 正则**前面**：
     *    正则只认数字，`order` 本来不会撞，但先匹配更保险、也更好读。
     */
    if (p === '/api/exchange-keys/order' && method === 'POST') {
      try {
        const body = await bodyOf()
        const ids = Array.isArray(body.ids) ? (body.ids as unknown[]) : []
        await reorderExchangeKeys(me.id, ids.map(v => Number(v)))
        return sendJson(res, 200, {ok: true})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
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

    const m = p.match(/^\/api\/exchange-keys\/(\d+)(\/default|\/hidden)?$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])

    /*
     * 隐藏 / 显示（用户 2026-10-18：「添加隐藏按钮，隐藏后不再渲染」）。
     * body: `{hidden: true|false}` —— 隐藏后各页（我的账户 tab / 账户统计 /
     * 下单账户 / K 线顶栏）都拿不到这一套，只有本管理列表 `?all=1` 还看得到。
     */
    if (m[2] === '/hidden') {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      try {
        const body = await bodyOf()
        const ok = await setExchangeKeyHidden(me.id, id, body.hidden !== false)
        return sendJson(
          res,
          ok ? 200 : 404,
          ok ? {ok: true} : {error: '这一套不存在'}
        )
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

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
        return fail(res, 'exchange/overview', e, humanize)
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
      /*
       * ★ 2026-10-06：手动刷新 = **用户觉得不对**（用户原话：「用户感觉不对可以刷新页面」）
       *   ⇒ 一次把它**全对平**：成交 / 挂单 / 钱账本都现场补一轮。
       *   快照刚在上面拉过了（`skipSnapshot`），别再问一遍那 21 权重。
       *   `force` 会无视平时那些降频档 —— 这是用户明确的一次请求，值得。
       */
      /*
       * ⚠️ `auto=1` = 前端自己兜底刷的那次（快照旧了 / 流没活着）。
       *    那种「顺手刷一下」**不该**顺便把成交 / 挂单 / 钱账本也全对一遍 ——
       *    一台机器上开着好几个页面时，重启一次能瞬间叠出十几发强制补账。
       *    强制补账只留给**用户主动**那一下（按钮 / 下拉）。
       */
      if (url.searchParams.get('auto') !== '1') {
        wakeExchangeStream(key.id, '手动刷新', {force: true, skipSnapshot: true})
      }
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
      return fail(res, 'exchange/refresh', e, humanize)
    }
  }

  /*
   * 成交账本（WS 实时落 + 断线后 REST 补）—— **不需要交易对**。
   * 老接口「币安必须给交易对才能查成交」那套已经不需要了（M3）。
   * ★ 2026-10-06：`/api/exchange/trade/history`（K 线买卖点）也改读这里，
   *   一个账户的成交只有这一个来源 —— 那套 REST 版曾是「减仓了但账上没这笔」的另一半原因。
   */
  /*
   * 账本三格（仓位历史 / 成交历史 / 资金动向）共用的**筛选参数**：
   *   `from` / `to` —— 毫秒时间戳（含端点）；时区由前端算（北京时间那天几点到几点），
   *                    这边只当两个毫秒数用，免得「今天」在两种时区里解释两遍。
   *   `types`       —— 资金动向的类型过滤（逗号分隔的 `income_type`，如 `REALIZED_PNL,COMMISSION`）。
   */
  const ledgerRange = (): {
    from: number | null
    to: number | null
    types: string[] | null
    other: boolean
  } => {
    const f = num(url.searchParams.get('from'))
    const t = num(url.searchParams.get('to'))
    const all = String(url.searchParams.get('types') ?? '')
      .split(',')
      .map(x => x.trim().toUpperCase())
      .filter(Boolean)
    /*
     * `OTHER` 是界面上那颗「其它」——**不是**一个真的 `income_type`，
     * 而是「不在已知那几个里的」（币安还有 `AUTO_EXCHANGE` 之类）。
     * 这里把它摘出来单独当一个标志，SQL 那边翻成 `income_type <> ALL(已知)`。
     */
    const other = all.includes('OTHER')
    const types = all.filter(x => x !== 'OTHER')
    return {
      from: f && f > 0 ? Math.round(f) : null,
      to: t && t > 0 ? Math.round(t) : null,
      types: types.length ? types : null,
      other
    }
  }

  if (p === '/api/exchange/analytics' && method === 'GET') {
    const requestedIdRaw = url.searchParams.get('id')
    const requestedId = requestedIdRaw === null ? null : Number(requestedIdRaw)
    if (requestedIdRaw !== null && (!Number.isInteger(requestedId) || Number(requestedId) <= 0)) {
      return sendJson(res, 400, {error: '账户 ID 无效'})
    }
    const key = requestedId !== null
      ? await getExchangeKey(me.id, requestedId)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    try {
      const from = num(url.searchParams.get('from'))
      const to = num(url.searchParams.get('to'))
      const analytics = await exchangeAnalytics(me.id, key.id, {
        from: from && from > 0 ? from : null,
        to: to && to > 0 ? to : null
      })
      const positions = await listPositionHistory(me.id, key.id, 1, undefined, {
        from: from && from > 0 ? from : null,
        to: to && to > 0 ? to : null
      })
      return sendJson(res, 200, {
        account: {id: key.id, name: key.name},
        analytics,
        positions: {...positions.summary, breakdown: positions.breakdown, daily: positions.daily}
      })
    } catch (e) {
      return fail(res, 'exchange/analytics', e)
    }
  }

  if (p === '/api/exchange/c2c-history' && method === 'GET') {
    const id = num(url.searchParams.get('id'))
    if (id === undefined || !Number.isInteger(id) || id <= 0) {
      return sendJson(res, 400, {error: '账户 ID 无效'})
    }
    const key = await getExchangeKey(me.id, id)
    if (!key) return sendJson(res, 404, {error: '交易所账户不存在'})
    const page = num(url.searchParams.get('page') ?? '1')
    const pageSize = num(url.searchParams.get('pageSize') ?? '20')
    if (
      page === undefined ||
      pageSize === undefined ||
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return sendJson(res, 400, {error: '分页参数无效'})
    }
    try {
      const history = await listC2cOrderHistory(me.id, key.id, page, pageSize)
      return sendJson(res, 200, history)
    } catch (e) {
      return fail(res, 'exchange/c2c-history', e)
    }
  }

  if (p === '/api/exchange/c2c-import' && method === 'POST') {
    try {
      const body = await readJsonBody(req, 4 * 1024 * 1024)
      const keyId = num(body.id)
      if (keyId === undefined || !Number.isSafeInteger(keyId) || keyId <= 0) {
        return sendJson(res, 400, {error: '账户 ID 无效'})
      }
      const key = await getExchangeKey(me.id, keyId)
      if (!key) return sendJson(res, 404, {error: '交易所账户不存在'})

      if (!Array.isArray(body.orders) || body.orders.length > 10000) {
        return sendJson(res, 400, {error: '订单数据无效或超过 10000 条'})
      }

      const orders: C2cOrderInput[] = []
      for (const [index, value] of body.orders.entries()) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return sendJson(res, 400, {error: `第 ${index + 1} 笔订单格式无效`})
        }
        const row = value as Record<string, unknown>
        const orderId = str(row.orderId).trim()
        const side = row.side
        const asset = row.asset
        const fiat = str(row.fiat).trim().toUpperCase()
        const fiatTotal = num(row.fiatTotal)
        const price = num(row.price)
        const quantity = num(row.quantity)
        const timestamp = str(row.timestamp)
        const time = Date.parse(timestamp)
        if (
          !orderId ||
          orderId.length > 80 ||
          (side !== 'Buy' && side !== 'Sell') ||
          asset !== 'USDT' ||
          !fiat ||
          fiat.length > 16 ||
          fiatTotal === undefined ||
          fiatTotal < 0 ||
          price === undefined ||
          price <= 0 ||
          quantity === undefined ||
          quantity <= 0 ||
          !Number.isFinite(time)
        ) {
          return sendJson(res, 400, {error: `第 ${index + 1} 笔订单字段无效`})
        }
        orders.push({
          orderId,
          side,
          asset,
          fiat,
          fiatTotal,
          price,
          quantity,
          timestamp: new Date(time).toISOString()
        })
      }

      const inserted = await importC2cOrders(me.id, key.id, orders)
      return sendJson(res, 200, {
        ok: true,
        received: orders.length,
        inserted,
        skippedDuplicates: orders.length - inserted
      })
    } catch (e) {
      return fail(res, 'exchange/c2c-import', e)
    }
  }

  if (p === '/api/exchange/c2c-sync' && method === 'POST') {
    try {
      const body = await readJsonBody(req)
      const keyId = num(body.id)
      if (keyId === undefined || !Number.isSafeInteger(keyId) || keyId <= 0) {
        return sendJson(res, 400, {error: '账户 ID 无效'})
      }
      const key = await getExchangeKey(me.id, keyId)
      if (!key) return sendJson(res, 404, {error: '交易所账户不存在'})
      if (key.exchange.toLowerCase() !== 'binance') {
        return sendJson(res, 400, {error: 'C2C 历史更新仅支持币安账户'})
      }
      if (key.sandbox) {
        return sendJson(res, 400, {error: 'C2C 历史更新仅支持币安正式账户'})
      }

      const latestTimestamp = await latestC2cOrderTimestamp(me.id, key.id)
      const endTimestamp = Date.now()
      const startTimestamp =
        latestTimestamp ?? endTimestamp - C2C_SYNC_INITIAL_LOOKBACK_MS
      const fetched = startTimestamp <= endTimestamp
        ? await fetchBinanceC2cOrders(
            createExchange(exchangeCredsOf(key)),
            startTimestamp,
            endTimestamp
          )
        : {orders: [], pages: 0}
      const inserted = await importC2cOrders(me.id, key.id, fetched.orders)

      return sendJson(res, 200, {
        ok: true,
        from: startTimestamp,
        to: endTimestamp,
        pages: fetched.pages,
        received: fetched.orders.length,
        inserted,
        skippedDuplicates: fetched.orders.length - inserted
      })
    } catch (e) {
      return fail(res, 'exchange/c2c-sync', e, humanize)
    }
  }

  if (p === '/api/exchange/fills' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    try {
      const rg = ledgerRange()
      const fills = await listFills(
        me.id,
        key.id,
        num(url.searchParams.get('limit')) ?? 60,
        str(url.searchParams.get('symbol'), '') || undefined,
        {from: rg.from, to: rg.to}
      )
      return sendJson(res, 200, {fills})
    } catch (e) {
      return fail(res, 'exchange/fills', e)
    }
  }

  /*
   * 仓位历史（「开仓 → 全平」一个来回算一笔，像币安「仓位历史」）。
   *
   * ★ 2026-10-06 新增，按用户的原话做的：
   *   「盈亏界面不是统计数据，是每笔仓位的概念 —— 开仓到结仓中间的盈利，
   *     减仓不单独算一笔、全平才算；要币种 / 盈利 / 开仓均价 / 平仓均价 /
   *     开平仓时间 / 持仓时间，点开能看每笔订单，减仓那几笔要有实现盈利」
   *
   * ⚠️ 数据来自**成交账本**（`exchange_fills`），不是 income 的分类汇总。
   *    账本覆盖**币安保留期**内的数据（约 3 个月；见 `BINANCE_RETENTION_MS`），
   *    返回里带 `since`，界面上要说明白「这段之前的历史没进来」。
   */
  if (p === '/api/exchange/position-history' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    try {
      const rg = ledgerRange()
      const r = await listPositionHistory(
        me.id,
        key.id,
        num(url.searchParams.get('limit')) ?? 50,
        str(url.searchParams.get('symbol'), '') || undefined,
        {from: rg.from, to: rg.to}
      )
      return sendJson(res, 200, {...r, error: null})
    } catch (e) {
      return fail(res, 'exchange/position-history', e)
    }
  }

  /*
   * 钱账本（`/fapi/v1/income` 的落库版）—— 「盈亏」tab 的数据源。
   *
   * ★ 2026-10-06 新增，回答用户那三个问题：
   *   · **盈亏怎么算**：已实现 `REALIZED_PNL` + 手续费 `COMMISSION` + 资金费 `FUNDING_FEE`
   *     + 其它，四类**直接相加**（币安这两类本来就是负数）—— 这才是净的。
   *     之前「盈亏」tab 只加 `fills.realized`（毛数），手续费和资金费根本没算。
   *   · **资金费算吗**：算，就在 `FUNDING_FEE` 里。
   *   · **减仓还会出现吗**：会 —— 减仓那笔成交号同时是 `REALIZED_PNL` 的 `tranId`，
   *     两边同一把钥匙，不会再出现「成交有、盈亏没有」。
   *
   * ⚠️ **纯本地读，不打交易所**（数据由 `exchange-stream` 的定期对账灌进来）。
   */
  if (p === '/api/exchange/income' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    try {
      /* `days=0` ⇒ 全部历史（`incomeTotals(…, null)`）；`from`/`to` 再叠一层（两个都生效） */
      const days = num(url.searchParams.get('days')) ?? 7
      const rg = ledgerRange()
      const [totals, rows] = await Promise.all([
        incomeTotals(me.id, key.id, days || null, rg),
        listIncome(me.id, key.id, num(url.searchParams.get('limit')) ?? 200, rg)
      ])
      return sendJson(res, 200, {totals, rows, days, error: null})
    } catch (e) {
      return fail(res, 'exchange/income', e)
    }
  }

  /*
   * 当前挂单 —— ★ 2026-10-06 改成**本地读**（用户原话：「挂单不是秒级查询啊，
   * 有变动才改，其余存库不就行了」）。
   *
   * 为什么改：挂单的**变动**币安会经用户数据流主动推（`ORDER_TRADE_UPDATE`），
   * 根本不用轮询；而原来这里每次都现打一次「不带交易对」的挂单查询 ——
   * 币安那边 **40 权重** + 一个来回（经隧道 0.7~1.2 秒）：
   *   · 点开账户页要等 2 秒（用户报的）；
   *   · 别的 tab / 别的页面想看还得各自再打一次；
   *   · 权重全服务器共用，几个页面点几下就是几百。
   *
   * 现在：读库（毫秒级）+ SSE `orders` 事件推实时变更；
   * REST 只在对账时打（连上 / 重连 / 每 2 分钟，见 `reconcileOrders`）。
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
      const rows = await listOpenOrdersDb(me.id, key.id)
      /*
       * ⚠️ 形状必须跟原来那条接口**逐字一致**（前端 / K 线都直接吃它）：
       *    `id` / `price` / `stopPrice` / `time` 这些字段名一个都不能改。
       *    （映射收在 `orderRowOfInput` 里，实时那条的兜底也用同一份。）
       */
      return sendJson(res, 200, {
        openOrders: rows.map(orderRowOfInput),
        stale: false,
        source: 'db',
        error: null
      })
    } catch (e) {
      return fail(res, 'exchange/open-orders', e, humanize)
    }
  }

  /*
   * 美元 → 人民币汇率（很轻，不打任何外部接口）。
   *
   * 「交易所账户」那个 USDT / CNY 快捷切换用的：汇率跟用量页 / 历史页**同一个源**
   * （`llm/pricing.ts` 的 `usdToCny`，读 `USD_CNY` 环境变量，默认 7.1），
   * 免得同一个站里两处换算出两个数。
   */
  if (p === '/api/rate' && method === 'GET') {
    return sendJson(res, 200, {usdCny: usdToCny(1)})
  }

  /*
   * 合约下单（2026-10-05）—— K 线页底部那个下单模块用的几条接口。
   *
   * ⚠️ 下单 / 平仓有**两种模式**，由请求体里的 `test` 决定（用户 2026-10-05 追加）：
   *    · `test !== false`（**默认**）→ 币安的测试接口 `/fapi/v1/order/test`：
   *      只校验参数 / 权限 / 保证金，**不进撮合、不真开仓**。
   *    · `test === false` → `/fapi/v1/order` —— **真下单 / 真平仓**（会真扣保证金）。
   *      前端那个开关在「配置 → 测试下单」里。
   * ⚠️ 所以**别把 `test` 默认成 false**：漏传必须落在安全那一侧（见 `placeOrder`）。
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
      const symbol = str(url.searchParams.get('symbol'), 'BTCUSDT')
      const creds = {
        exchange: key.exchange,
        apiKey: key.apiKey,
        secret: key.secret,
        password: key.password,
        marketType: key.marketType,
        sandbox: key.sandbox
      }
      /*
       * ★ 2026-10-21 用户：「仓位价值 / 开仓那些为什么出来这么慢？」
       *
       * 原因：这个接口每次都要**现打 3 次交易所**（余额 / 持仓+杠杆 / 最大杠杆），
       * 实测 130~165ms（而且跟同一个账户的常驻流抢同一份权重预算）。
       * 但常驻流（`position-cache`）**一直在推**余额和持仓 —— 面板要的这些里头
       * 绝大部分它都有。所以：流在跑、且这个币的杠杆也知道（`positionRisk` 里有，
       * 或者用户刚调过），就直接用内存那份拼出来，**一次交易所都不打**
       * （实测 5ms 上下）。缺杠杆 / 流没跑 ⇒ 老老实实走下面原来那条。
       */
      const liveFast = await tradeInfoFromLive(key, creds, symbol)
      if (liveFast) {
        return sendJson(res, 200, {
          ready: true,
          account: publicExchangeKey(key),
          ...liveFast.info,
          positionMeta: liveFast.positionMeta ?? null
        })
      }
      const info = await collectTradeInfo(creds, symbol, key.id)
      /*
       * 持仓的**账本侧**信息（用户 2026-10-14：「底下加上已开仓时间，已实现盈利」）：
       * 这两样币安的 `positionRisk` 里**都没有**，只能从**本地账本**还原 ——
       *   · 已开仓时间 = 这一段仓位的**第一笔成交**时间（`buildCycles` 扫出来的 openAt）；
       *   · 已实现盈利 = 这一段里**减仓那几笔**的已实现盈亏（净：扣手续费、加资金费）。
       * ⚠️ 只有**真有持仓**时才算（两发本地查询，很便宜，但没必要每次都打）。
       * ⚠️ 账本覆盖不到的老仓位 (`partial`) 会给出残值 —— 前端照实显示，不编。
       */
      let positionMeta: PositionMeta | null = null
      if (info.position) {
        try {
          positionMeta = await positionMetaOf(me.id, key.id, info.symbol)
        } catch {
          /* 账本读不到就不给这两项（面板会显示 `—`），别把整个接口带崩 */
        }
      }
      return sendJson(res, 200, {
        ready: true,
        account: publicExchangeKey(key),
        ...info,
        positionMeta
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
        Number(body.leverage),
        key.id
      )
      return sendJson(res, 200, {ok: true, ...r, error: null})
    } catch (e) {
      return failTrade(res, '改杠杆', key.id, e)
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
      /*
       * ⚠️ `test !== false` —— 只有前端**明确**传 `false` 才真下单。
       *    漏传 / 传了别的值一律当测试单。
       */
      const test = body.test !== false
      const creds = {
        exchange: key.exchange,
        apiKey: key.apiKey,
        secret: key.secret,
        password: key.password,
        marketType: key.marketType,
        sandbox: key.sandbox
      }
      /*
       * 黑名单（用户 2026-10-10）：锁着的币**不让开单**。
       *
       * ⚠️ 只拦**开仓**（`!reduceOnly`）—— 减仓 / 平仓照常放行：手里有仓就必须跑得掉，
       *    把出口一起锁上是会出事的。平仓走的是另一个接口，本来也不经过这里。
       * ⚠️ 前端按钮也会禁用，但那只是样子：**这道闸在后端**，绕开界面直接打接口也拦。
       */
      if (!body.reduceOnly) {
        const lock = await lockedUntil(me.id, str(body.symbol, 'BTCUSDT'))
        if (lock) {
          const leftMin = Math.max(1, Math.ceil((lock.getTime() - Date.now()) / 60000))
          const hh = Math.floor(leftMin / 60)
          const left = hh > 0 ? `${hh} 小时 ${leftMin % 60} 分` : `${leftMin} 分`
          return sendJson(res, 200, {
            ok: false,
            error:
              `${String(str(body.symbol, '')).toUpperCase()} 在黑名单里：` +
              `还要 ${left} 才能开单（到点自动解除）`
          })
        }
      }

      /*
       * 开单前的体检：现在只剩 `assertTradable`（Key 权限 / IP 白名单）。
       *
       * ★ 2026-10-19 用户：「不是带有浮盈的时候才能加仓，只要有保证金够的时候可用、
       *   余额够都可以加仓」—— 「同向加仓 ≤ 该币浮盈 × 持仓杠杆」也删了。
       *   加仓和开仓同一把尺子：只看可用保证金，够不够由交易所自己的保证金校验兜底。
       * 跟黑名单一样**只拦开仓**：减仓 / 平仓放行（手里有仓必须跑得掉）。
       */
      if (!body.reduceOnly) {
        await assertOrderLimits(
          creds,
          str(body.symbol, 'BTCUSDT'),
          Number(body.quantity),
          body.price === undefined ? undefined : Number(body.price),
          side
        )
      }
      /*
       * **下单前**这个方向有多少张 —— 三处要用：
       *   · 自动止损判断「这一单到底落地上没有」；
       *   · 判断这一单是不是**加仓**（加仓才把 100% 的止盈 / 止损放回 100%）；
       *   · 加仓后把已有止盈放大到全部仓位（用户 2026-10-15）。
       * ⚠️ 必须 symbol + side 一起挑：双向持仓同一个币有两条。
       * ⚠️ 走 `amountBeforeAdd`（流没起来时退回读持仓缓存），不然会被读成 0。
       */
      const symBefore = str(body.symbol, 'BTCUSDT').toUpperCase()
      const beforeAmount = await amountBeforeAdd(
        key.id,
        creds,
        symBefore,
        side
      )
      const order = await placeOrder(
        creds,
        key.id,
        {
          symbol: str(body.symbol, 'BTCUSDT'),
          side,
          type,
          quantity: Number(body.quantity),
          price: body.price === undefined ? undefined : Number(body.price),
          reduceOnly: body.reduceOnly === true,
          test
        }
      )
      /* 真单才会真的多/少一张挂单；测试单没进撮合，不用作废缓存 */
      if (!test) void reconcileKeyOrders(key.id)
      /*
       * ★ 2026-10-15：**开仓 / 加仓**成功后自动挂一张止损（用户：「开仓后自动加入
       *   −4% 个点的全部仓位止损」）。
       *
       * 三条交代：
       *   · 百分比**由前端配置**（`settings.ts` 的「开仓自动止损」，`autoStop` 传过来）——
       *     后端不写死数字，0 / 不传就是不做；
       *   · **只挂开仓那一侧**（`reduceOnly` 的减仓单不挂，它本来就是往外跑的）；
       *   · 挂失败**绝不影响这一单**：结果只作为 `autoStop` 附带回报，`ok` 仍是 true
       *     —— 已经成交的单不能被一张止损的错说成失败。
       *   ⚠️ 2026-10-15 改成**丢后台**（见下面那段）：不再占这一单的响应，
       *     挂完推 `auto-stop` 给面板补一句。
       */
      const autoPct = Number(body.autoStop ?? 0)
      const isAdd = !test && order.reduceOnly !== true && beforeAmount > 0
      if (
        !isAdd &&
        !test &&
        order.reduceOnly !== true &&
        Number.isFinite(autoPct) &&
        autoPct > 0
      ) {
        /*
         * ★ 2026-10-15（用户：「后台挂」）：**丢到后台去挂，不占这一单的响应**。
         *
         * 等着它有代价：成交要落地、止损要真挂上去，实测多等 3 秒左右（关掉 0.3 秒）。
         * 而「有没有保护」这件事可以晚一两秒再说 —— 挂完推一条 `auto-stop` 事件，
         * 面板补一句提示（挂在哪 / 跳过了手工止损 / 为什么失败）。
         * ⚠️ `void` + `catch`：这条链上的任何异常都不许回到这一单上（它已经成交了）。
         */
        void ensureAutoStop({
          userId: me.id,
          keyId: key.id,
          creds,
          symbol: symBefore,
          side,
          pct: autoPct,
          before: beforeAmount
        })
          .then(r => emit(key.id, {type: 'auto-stop', symbol: symBefore, ...r}))
          .catch(e => {
            emit(key.id, {
              type: 'auto-stop',
              symbol: symBefore,
              ok: false,
              error: e instanceof Error ? e.message : String(e)
            })
          })
      }
      /*
       * 加仓后把「加仓前就是 100%」的止损放回 100%（**手工挂的那张也算**，触发价不动）。
       * 自动止损先跑完（如果启用），避免两个后台任务同时撤挂同一张单。
       */
      if (isAdd) {
        const adjustStop = (): void => {
          void ensureStopLossFull({
            userId: me.id,
            keyId: key.id,
            creds,
            symbol: symBefore,
            side,
            before: beforeAmount
          })
            .then(r => emit(key.id, {type: 'auto-sl', symbol: symBefore, ...r}))
            .catch(e => {
              emit(key.id, {
                type: 'auto-sl',
                symbol: symBefore,
                ok: false,
                error: e instanceof Error ? e.message : String(e)
              })
            })
        }
        if (
          Number.isFinite(autoPct) &&
          autoPct > 0 &&
          !test &&
          order.reduceOnly !== true
        ) {
          /* 两个后台任务都入保护单队列，确保自动止损先完成再扩数量。 */
          void ensureAutoStop({
            userId: me.id,
            keyId: key.id,
            creds,
            symbol: symBefore,
            side,
            pct: autoPct,
            before: beforeAmount
          })
            .then(r => {
              emit(key.id, {type: 'auto-stop', symbol: symBefore, ...r})
              adjustStop()
            })
            .catch(e => {
              emit(key.id, {
                type: 'auto-stop',
                symbol: symBefore,
                ok: false,
                error: e instanceof Error ? e.message : String(e)
              })
              adjustStop()
            })
        } else {
          adjustStop()
        }
      }
      /*
       * ★ 2026-10-15 晚（用户：「有仓位止盈的话，加仓之后把加仓的单子也要放到
       *   止盈里面去，变成百分之百」；2026-10-24：「如果原来都是 100% 的状态，
       *   都要自动改为 100%」）：**加仓**成功后，把加仓前就是 100% 的止盈
       *   （含手工挂的）数量改成加仓后的全部仓位（触发价不动）。
       *
       * 跟自动止损一样丢后台（那一单已经成交了，不能被止盈的错拖成失败），
       * 改完推 `auto-tp` 给面板补一句。
       * ⚠️ 只在**加仓**时做（`beforeAmount > 0`）：开新仓的止盈是用户自己的事。
       */
      if (!test && order.reduceOnly !== true && beforeAmount > 0) {
        void ensureTakeProfitFull({
          userId: me.id,
          keyId: key.id,
          creds,
          symbol: symBefore,
          side,
          before: beforeAmount
        })
          .then(r => emit(key.id, {type: 'auto-tp', symbol: symBefore, ...r}))
          .catch(e => {
            emit(key.id, {
              type: 'auto-tp',
              symbol: symBefore,
              ok: false,
              error: e instanceof Error ? e.message : String(e)
            })
          })
      }
      return sendJson(res, 200, {ok: true, test, order, autoStop: null, error: null})
    } catch (e) {
      return failTrade(res, '下单', key.id, e)
    }
  }

  /*
   * **常驻流内存里**的实时持仓状态（0 权重、不碰交易所）。
   *
   * 用途：页面**重新激活**（底栏切回来 / 从别的 tab 回来）时先对齐一次。
   * `sharedSse` 会复用 30 秒内的旧连接，而复用**不会重发底稿** ——
   * 只等下一次标记价推送的话，页面上那份 `parts` 最多要旧 3 秒；
   * K 线那边 `bindPositions()` 一绑就自己 GET 一份，所以会出现
   * 「同一时刻『我的』比 K 线慢一拍」。
   *
   * ⚠️ 只读内存：常驻流没跑就是 `state: null`，**绝不在这一发里打交易所**
   * （要 REST 的那条路是 `/api/exchange/trade/positions`）。
   */
  if (p === '/api/exchange/live-state' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, state: null, error: '这一套还没填 API Key'})
    const st = liveStateOf(key.id)
    return sendJson(res, 200, {
      ok: true,
      /* 形状跟 SSE 的 `positions` 事件**逐字一致** —— 前端同一个函数盖上去 */
      state: st
        ? {
            at: new Date(st.at).toISOString(),
            live: st.live,
            wallet: st.wallet,
            available: st.available,
            unrealized: st.unrealized,
            margin: st.margin,
            stats: st.stats,
            positions: st.positions
          }
        : null,
      error: null
    })
  }

  /*
   * 所有持仓（面板「仓位」那一格 + K 线叠加用的列表）。
   *
   * ★ 2026-10-06 改造（P1/P3）：**不再每次都直连交易所**，改成读
   *   `data/position-cache.ts` 那个统一来源 ——
   *   · 常驻流在跑 → 读内存（跟「交易所界面」是**同一份数据**，同屏不会再打架）；
   *   · 流没在跑 → 退回 REST，但带 TTL + 单飞 + 权重预算（多个轮询器合成一发）。
   */
  if (p === '/api/exchange/trade/positions' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    try {
      /*
       * `?fresh=1`：**绕过后端缓存**（下单 / 平仓之后前端要立刻看到结果）。
       * 平时不传 —— 走缓存/常驻流，多个轮询器合成一发，别把出口 IP 打封。
       */
      const fresh = url.searchParams.get('fresh') === '1'
      const positions = await getPositions(
        key.id,
        exchangeCredsOf(key),
        fresh ? {force: true} : {}
      )
      /*
       * ★ 2026-10-06：顺带把**账户级**那几个数回给前端 —— 保证金率（MM）要
       *   维持保证金 ÷ 保证金余额，只有持仓列表的话前端算不出来。
       *   都取自常驻流内存里的那一份（**不打交易所**），没有就是 null。
       */
      const live = liveStateOf(key.id)
      return sendJson(res, 200, {
        ok: true,
        positions,
        wallet: live?.wallet ?? null,
        available: live?.available ?? null,
        unrealized: live?.unrealized ?? null,
        margin: live?.margin ?? null,
        maintMargin: live?.stats.maintMargin ?? null,
        live: live?.live ?? false,
        error: null
      })
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        error: e instanceof RateBudgetError ? e.message : humanizeTrade(e)
      })
    }
  }

  /*
   * 当前挂单（K 线上那条「仓位委托」价格线要的）。
   *
   * ⚠️ 跟上面 `/trade/positions` 分开：挂单变得比持仓勤（随时可能成交 / 撤单），
   *    而且**只关心当前这个交易对**（图上就画这一个币），所以 `symbol` 必传更省。
   */
  if (p === '/api/exchange/trade/open-orders' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    const symbolQ = str(url.searchParams.get('symbol'), '') || undefined
    try {
      /*
       * ⚠️ 不带交易对查挂单在币安那边是 **40 权重/条**（带交易对才 1）——
       *    前端最容易把这里打爆（2026-10-06 就是这么把出口 IP 打进 `-1003` 的），
       *    所以先跟预算报一声。
       */
      await chargeExchange(symbolQ ? 1 : 40, 'openOrders')
      const orders = await listOpenOrders(exchangeCredsOf(key), symbolQ)
      return sendJson(res, 200, {ok: true, orders, stale: false, error: null})
    } catch (e) {
      const why = e instanceof RateBudgetError ? e.message : humanizeTrade(e)
      /*
       * 实时读不到（或限流被拦）就退回最近一次对账的快照（`exchange_open_orders`），
       * 带 `stale: true` 让前端标出来。只有读这么兜，改单 / 撤单照旧老实报错。
       */
      try {
        const rows = await listOpenOrdersDb(me.id, key.id)
        const pick = symbolQ
          ? rows.filter(o => o.symbol.toUpperCase() === symbolQ.toUpperCase())
          : rows
        if (pick.length) {
          console.warn(
            `[exch] 挂单实时读不到（${why.slice(0, 60)}）⇒ 退回对账快照 ${pick.length} 条`
          )
          return sendJson(res, 200, {
            ok: true,
            orders: pick.map(orderRowOfInput),
            stale: true,
            error: why
          })
        }
      } catch {
        /* 读库也挂了：按原来的报错走 */
      }
      return sendJson(res, 200, {ok: false, error: why})
    }
  }

  /*
   * 成交历史（K 线上那些买卖点 = 「订单历史」）。
   *
   * ★ 2026-10-06 统一：**改读后端账本**（`exchange_fills`），不再直连币安
   *   `userTrades`。两个来源并存过一段，症状就是用户遇到的那个 ——
   *   同一笔减仓，K 线有、账户页「最近成交」没有（或反过来），
   *   而且 REST 那路要交易对、要 5 权重、还只能回 7 天。
   *   账本这份是 WS 实时落 + 定期 REST 对账补的，一个账户只有它一份。
   *
   * ⚠️ 行情要求 `symbol`（交易所原始符号，如 `1000BONKUSDT`），但只是**过滤**：
   *    账本本来就按账户存着，过滤不到就返回空数组（不再回 400 让前端没法渲染）。
   */
  if (p === '/api/exchange/trade/history' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    const symbol = str(url.searchParams.get('symbol'), '')
    if (!symbol) return sendJson(res, 400, {error: '缺 symbol'})
    try {
      const limit = Math.min(1000, Math.max(1, num(url.searchParams.get('limit')) ?? 100))
      const rows = await listFills(me.id, key.id, limit, symbol)
      const trades = rows.map(r => ({
        id: r.id,
        symbol: r.symbol,
        side: r.side,
        price: r.price,
        amount: r.amount,
        fee: r.fee,
        realizedPnl: r.realized,
        time: r.datetime ? Date.parse(r.datetime) : 0
      }))
      return sendJson(res, 200, {ok: true, trades, error: null})
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        error: humanizeTrade(e)
      })
    }
  }

  /*
   * 止盈 / 止损单（用户 2026-10-06：K 线上按住仓位线上下拖 → 松手弹确认单 → 挂这张）。
   *
   * ⚠️ 跟下单一样 `test !== false` 才是测试单：漏传一律当**测试单**（只校验）。
   * ⚠️ `orderId` 有值 = **改单**（先撤旧的再挂新的）；测试单模式**不会**撤单。
   */
  if (p === '/api/exchange/trade/stop-order' && method === 'POST') {
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
      const r = await placeStopOrder(
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
          side: str(body.side, 'sell') === 'buy' ? 'buy' : 'sell',
          kind: str(body.kind, 'stop') === 'profit' ? 'profit' : 'stop',
          stopPrice: Number(body.stopPrice),
          quantity: Number(body.quantity),
          posSide: body.posSide === undefined ? undefined : str(body.posSide, 'BOTH'),
          orderId: body.orderId === undefined ? undefined : str(body.orderId, ''),
          /* 同下单：`test !== false` 才是测试单，漏传一律当测试单 */
          test: body.test !== false
        }
      )
      if (r.test === false) void reconcileKeyOrders(key.id)
      return sendJson(res, 200, {ok: true, ...r, error: null})
    } catch (e) {
      return failTrade(res, '挂止盈/止损', key.id, e)
    }
  }

  /*
   * 改一张挂单（用户 2026-10-06：「挂单可以修改」）。
   *
   * 限价单走交易所的改单接口（单号不变），止盈 / 止损走撤旧挂新 ——
   * 分流在 `modifyTradeOrder` 里，路由这层只是把参数递下去。
   *
   * ⚠️ 跟撤单一样**没有测试版**：改了就是真改了。前端点「保存」之前要确认。
   */
  if (p === '/api/exchange/trade/modify-order' && method === 'POST') {
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
      const r = await modifyTradeOrder(exchangeCredsOf(key), key.id, {
        symbol: str(body.symbol, 'BTCUSDT'),
        orderId: str(body.orderId, ''),
        price: Number(body.price),
        quantity: body.quantity === undefined ? undefined : Number(body.quantity)
      })
      /* 改完挂单缓存立刻作废（不然那条线还画在旧价上） */
      void reconcileKeyOrders(key.id)
      return sendJson(res, 200, {ok: true, ...r, error: null})
    } catch (e) {
      return failTrade(res, '改单', key.id, e)
    }
  }

  /*
   * 一次撤掉**一串**挂单（用户 2026-10-07：「挂单顶部也加过滤条件，右侧加全部撤仓」）。
   *
   * ⚠️ 真动作、**没有测试版**（跟单张撤单一样）⇒ 前端点之前必须二次确认；
   *    这条接口自己**不认**「测试下单」开关，也没有金额概念 —— 撤了就是撤了。
   *
   * 载荷：`{items: [{keyId?, symbol, orderId}]}`。
   * ⚠️ 每项**各自带 `keyId`**：挂单那一格在「全部」时横跨两套账户，
   *    一条请求里就混着两家，得按账户分开撤（也顺便各撤各的缓存）。
   */
  if (p === '/api/exchange/trade/cancel-orders' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const raw = Array.isArray(body.items) ? body.items : []
    const groups = new Map<
      number | null,
      {symbol: string; orderId: string; conditional: boolean}[]
    >()
    for (const it of raw.slice(0, 200)) {
      const symbol = str(it?.symbol, '')
      const orderId = str(it?.orderId, '')
      if (!symbol || !orderId) continue
      const kid = num(it?.keyId) || null
      const list = groups.get(kid) ?? []
      list.push({symbol, orderId, conditional: it?.conditional === true})
      groups.set(kid, list)
    }
    const cancelled: {symbol: string; orderId: string}[] = []
    const failed: {symbol: string; orderId: string; error: string}[] = []
    for (const [kid, list] of groups) {
      const key = kid
        ? await getExchangeKey(me.id, kid)
        : await getDefaultExchangeKey(me.id)
      if (!key) {
        for (const it of list) failed.push({...it, error: '找不到这一套账户'})
        continue
      }
      if (!key.apiKey || !key.secret) {
        for (const it of list)
          failed.push({...it, error: `${key.name} 还没填 API Key`})
        continue
      }
      try {
        const r = await cancelTradeOrders(
          {
            exchange: key.exchange,
            apiKey: key.apiKey,
            secret: key.secret,
            password: key.password,
            marketType: key.marketType,
            sandbox: key.sandbox
          },
          list
        )
        cancelled.push(...r.cancelled)
        failed.push(...r.failed)
        /* 撤完立刻作废缓存（别让 K 线上那些线还画着） */
        void reconcileKeyOrders(key.id)
      } catch (e) {
        return failTrade(res, '批量撤单', key.id, e)
      }
    }
    return sendJson(res, 200, {
      ok: failed.length === 0,
      cancelled: cancelled.length,
      failed,
      error: null
    })
  }

  /*
   * 撤一张挂单。
   *
   * ⚠️ 撤单**没有测试版**：发了就是真撤。前面那个「测试下单」开关管不到它 ——
   *    前端在撤之前得自己确认一次（见 `OrderPanel` / `KlineChart`）。
   */
  if (p === '/api/exchange/trade/cancel-order' && method === 'POST') {
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
      const r = await cancelTradeOrder(
        {
          exchange: key.exchange,
          apiKey: key.apiKey,
          secret: key.secret,
          password: key.password,
          marketType: key.marketType,
          sandbox: key.sandbox
        },
        str(body.symbol, 'BTCUSDT'),
        str(body.orderId, ''),
        body.conditional === true
      )
      /* 撤单没有测试版：撤了就是真撤了，缓存立刻作废（别让那条线还画着） */
      void reconcileKeyOrders(key.id)
      return sendJson(res, 200, {ok: true, ...r, error: null})
    } catch (e) {
      return failTrade(res, '撤单', key.id, e)
    }
  }

  /*
   * 清掉「仓位已经没了、单却还挂着」的残留平仓单（用户 2026-10-06：
   * 「没有仓位所有挂单都应该取消才对，为什么还显示在图上」）。
   *
   * `?symbol=` 给了就只清这一个交易对（K 线页每 15 秒刷数据时顺手清当前这个币），
   * 不给就盘点整个账户（进页面时 + 每分钟一次）。
   *
   * ⚠️ 这里**不认**「测试下单」开关：撤的就是交易所上真挂着的单。
   *    安全边界在 `cancelOrphanOrders` 里 —— 只碰 `reduceOnly`，且持仓读不到就整体不动。
   */
  if (p === '/api/exchange/trade/cleanup-orders' && method === 'POST') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    try {
      const symbolQ = str(url.searchParams.get('symbol'), '') || undefined
      /* 不带交易对查挂单 = 40 权重/条；这一路是 2026-10-06 把 IP 打封的元凶，必须报预算 */
      await chargeExchange(symbolQ ? 1 : 40, 'cleanupOrders')
      const r = await cancelOrphanOrders(exchangeCredsOf(key), symbolQ)
      /* 撤了一批 → 缓存作废（不然「撤了还在」又要被报一遍） */
      void reconcileKeyOrders(key.id)
      return sendJson(res, 200, {ok: true, ...r, error: null})
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        error: e instanceof RateBudgetError ? e.message : humanizeTrade(e)
      })
    }
  }

  /*
   * 平仓（**测试单**，跟下单同一个接口）。K 线页下单模块里「仓位 → 平仓」用的。
   *
   * · `symbol` 给了就只平这个交易对；带上 `side` 就只平那一条（面板上每一行一颗）
   * · **都不给 = 一键平仓**：把有持仓的全平一遍（顶栏那颗）
   */
  if (p === '/api/exchange/trade/close' && method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    const sideRaw = str(body.side, '')
    const side =
      sideRaw === 'long' || sideRaw === 'short' ? sideRaw : undefined
    /* `pct` 是「减仓」用的（部分平仓，0~100）；不传 = 全平 */
    const pct = body.pct === undefined ? undefined : Number(body.pct)
    try {
      /* 同下单：`test !== false` 才是测试单，漏传一律当测试单 */
      const test = body.test !== false
      /*
       * 减仓要拿来当基准的「减之前有多少张」—— 必须在 `closePositions` **之前**取，
       * 之后取到的已经是减完的数量（止盈止损就按错的数去收了）。
       */
      const sym0 = str(body.symbol, '').toUpperCase()
      const wasPos = sym0
        ? liveStateOf(key.id)?.positions?.find(
            p =>
              String(p.raw ?? '').toUpperCase() === sym0 &&
              /* 双向持仓同一个币有两条 ⇒ 给了方向就按方向挑 */
              (side === undefined ||
                (p.side === 'short' ? 'short' : 'long') === side)
          )
        : undefined
      const r = await closePositions(
        {
          exchange: key.exchange,
          apiKey: key.apiKey,
          secret: key.secret,
          password: key.password,
          marketType: key.marketType,
          sandbox: key.sandbox
        },
        key.id,
        body.symbol ? {symbol: str(body.symbol, 'BTCUSDT'), side, pct} : undefined,
        test
      )
      if (!test) void reconcileKeyOrders(key.id)
      /*
       * ★ 2026-10-18（用户：「还有加仓加那么减仓呢，仓位止盈止损都要重新计算」）：
       *   **减仓之后，止盈和止损的数量都收到「剩余仓位」**。
       *
       * 三条口径：
       *   · **触发价一个都不动**（减仓不改开仓均价；止盈价也是用户定的）；
       *   · 只收**超过**剩余仓位的那张（本来就是部分止盈 / 止损的，不动）；
       *   · 全平 / 没有止盈止损 / 某一类有多张（分批）⇒ 不碰。
       * 跟下单那边一样是**后台**的（平仓响应不等它），结果走 `auto-protect` 推给前端。
       * ⚠️ 手工挂的止损也收 —— 用户要的是「仓位变了保护单就对得上」；只改数量，不改价。
       */
      const partial = pct !== undefined && pct > 0 && pct < 100
      if (!test && partial) {
        const sym = str(body.symbol, '').toUpperCase()
        if (sym) {
          const sideNow = side ?? (wasPos?.side === 'short' ? 'short' : 'long')
          void ensureReduceProtection({
            userId: me.id,
            keyId: key.id,
            creds: {
              exchange: key.exchange,
              apiKey: key.apiKey,
              secret: key.secret,
              password: key.password,
              marketType: key.marketType,
              sandbox: key.sandbox
            },
            symbol: sym,
            side: sideNow,
            /* 减之前有多少张（见上面 `wasPos` 的取值时机） */
            before: Math.abs(Number(wasPos?.amount) || 0)
          })
            .then(x => emit(key.id, {type: 'auto-protect', symbol: sym, ...x}))
            .catch(e => {
              emit(key.id, {
                type: 'auto-protect',
                symbol: sym,
                ok: false,
                error: e instanceof Error ? e.message : String(e)
              })
            })
        }
      }
      return sendJson(res, 200, {ok: true, test, ...r, error: null})
    } catch (e) {
      return failTrade(res, '平仓/减仓', key.id, e)
    }
  }

  /*
   * 万能划转（2026-10-05）—— 「交易所账户」页上那个划转弹层用的三条。
   *
   * ⚠️⚠️ 这是**真金白银**：币安没有「划转测试接口」（不像下单有 `/order/test`），
   *    调一次就真动钱。所以：
   *      · 方向只放行**验过能用**的六种组合（见 `data/exchange-transfer.ts`）
   *      · `permitsUniversalTransfer` 没开的 Key 在前端就会被拦下来
   *      · 金额 / 方向由前端二次确认，这里只做参数校验，不替用户做决定
   */
  if (p === '/api/exchange/transfer' && method === 'POST') {
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
      const r = await universalTransfer(
        {
          exchange: key.exchange,
          apiKey: key.apiKey,
          secret: key.secret,
          password: key.password,
          marketType: key.marketType,
          sandbox: key.sandbox
        },
        {
          from: str(body.from, '') as Wallet,
          to: str(body.to, '') as Wallet,
          amount: Number(body.amount),
          asset: body.asset === undefined ? undefined : str(body.asset, 'USDT')
        }
      )
      return sendJson(res, 200, {ok: true, transfer: r, error: null})
    } catch (e) {
      return sendJson(res, 200, {ok: false, error: (e as Error).message})
    }
  }

  /* 某个钱包里 USDT 能划走多少（划转弹层的「全部」按钮 + 余额提示，实时读） */
  if (p === '/api/exchange/wallet' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    try {
      const balance = await walletAvailable(
        {
          exchange: key.exchange,
          apiKey: key.apiKey,
          secret: key.secret,
          password: key.password,
          marketType: key.marketType,
          sandbox: key.sandbox
        },
        str(url.searchParams.get('wallet'), 'futures') as Wallet
      )
      return sendJson(res, 200, {ok: true, ...balance, error: null})
    } catch (e) {
      /* `humanize` 能认出「连不上交易所」那类网络错误 —— 别把 OpenSSL 原文甩给用户 */
      return sendJson(res, 200, {ok: false, error: humanize(e)})
    }
  }

  /*
   * 这套 Key 的划转权限（`permitsUniversalTransfer`）。
   * ⚠️ 单独一条：没开这个开关时币安只回通用的 `-2015`，界面上说不清原因 ——
   *    先问一次就能把「去币安勾上『允许通用划转』」直接摆出来。
   */
  if (p === '/api/exchange/permissions' && method === 'GET') {
    const idRaw = num(url.searchParams.get('id'))
    const key = idRaw
      ? await getExchangeKey(me.id, idRaw)
      : await getDefaultExchangeKey(me.id)
    if (!key) return sendJson(res, 404, {error: '还没有配置交易所 API Key'})
    if (!key.apiKey || !key.secret)
      return sendJson(res, 200, {ok: false, error: '这一套还没填 API Key'})
    try {
      const permissions = await transferPermissions({
        exchange: key.exchange,
        apiKey: key.apiKey,
        secret: key.secret,
        password: key.password,
        marketType: key.marketType,
        sandbox: key.sandbox
      })
      return sendJson(res, 200, {ok: true, permissions, error: null})
    } catch (e) {
      return sendJson(res, 200, {ok: false, error: humanize(e)})
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
    /*
     * ⚠️ 这里必须自己 catch 并**打出来**：`handleExchangeStream` 是在 `writeHead(200)`
     *    之后跑的，中途抛错会让外层那个通用 catch 去 `sendJson(500)`，
     *    而那一下本身会再抛 `ERR_HTTP_HEADERS_SENT` —— 真实的错因被埋掉，
     *    外面只看到「SSE 连上就断」。（2026-10-06 就是靠这一行才定位到。）
     */
    await handleExchangeStream(
      req,
      res,
      me.id,
      key.id,
      publicExchangeKey(key),
      reject
    ).catch((e: Error) => {
      console.error('[exchange/stream] 处理异常：', e?.stack ?? e)
      try {
        res.end()
      } catch {
        /* 已经断了就算了 */
      }
    })
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

  /* ---- 管理员：代理订阅（梯子）用户管理（2026-10-12） ----
   *
   * 应用库是权威副本，每次改动都整体下发给宿主机的 xrayd 服务（见 ./proxy.ts）。
   * 提交新用户 / 加子域名时只需要动这一个模块。
   */
  if (p === '/api/admin/proxy' || p.startsWith('/api/admin/proxy/')) {
    if (!me.isAdmin) return sendJson(res, 403, {error: '需要管理员权限'})

    /** 给前端的形状：订阅地址 / 节点链接都在服务端拼好，前端不用知道 REALITY 参数 */
    const shape = (u: ProxyUser) => ({
      id: u.id,
      name: u.name,
      note: u.note,
      enabled: u.enabled,
      uuid: u.uuid,
      subUrl: subUrl(u),
      nodeUrl: nodeUrl(u),
      syncedAt: u.syncedAt,
      createdAt: u.createdAt
    })

    if (p === '/api/admin/proxy' && method === 'GET') {
      // 库里空着（第一次打开这一页）→ 先把宿主机上已有的用户收进来，
      // 免得后面任何一次下发把他们整体抹掉。失败不影响列列表。
      if ((await listProxyUsers()).length === 0) {
        const added = await importProxyUsersFromAgent().catch(() => 0)
        // 导入的是**新密码**，得立刻下发一次，页面上显示的订阅地址才马上能用
        if (added > 0) await syncProxyUsers()
      }
      const users = await listProxyUsers()
      return sendJson(res, 200, {
        users: users.map(shape),
        node: NODE,
        health: await proxyHealth()
      })
    }

    // 手动从宿主机导入（比如先用命令行加了人，再回到页面上管理）
    if (p === '/api/admin/proxy/import' && method === 'POST') {
      try {
        const added = await importProxyUsersFromAgent()
        const r = await syncProxyUsers()
        return sendJson(res, 200, {
          ok: r.ok,
          added,
          error: r.error,
          users: (await listProxyUsers()).map(shape),
          health: await proxyHealth()
        })
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    // 新建
    if (p === '/api/admin/proxy' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      try {
        const created = await createProxyUser({
          name: str(body.name),
          note: str(body.note)
        })
        return sendJson(res, 201, {ok: true, user: shape(created)})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    // 手动重新下发（宿主机掉线过 / 状态对不上时点一下）
    if (p === '/api/admin/proxy/sync' && method === 'POST') {
      const r = await syncProxyUsers()
      return sendJson(res, r.ok ? 200 : 502, {
        ok: r.ok,
        error: r.error,
        users: r.users.map(shape),
        health: await proxyHealth()
      })
    }

    const m = p.match(
      /^\/api\/admin\/proxy\/(\d+)(\/(enabled|password|uuid|qr))?$/
    )
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])
    const action = m[3]

    // 二维码（订阅地址 / 单节点链接）—— 单独取，免得列表里塞一堆 base64
    if (action === 'qr') {
      if (method !== 'GET') return sendJson(res, 405, {error: 'Method Not Allowed'})
      const u = (await listProxyUsers()).find(x => x.id === id)
      if (!u) return sendJson(res, 404, {error: '用户不存在'})
      const what = new URL(req.url ?? '/', 'http://x').searchParams.get('what')
      const text = what === 'sub' ? subUrl(u) : nodeUrl(u)
      return sendJson(res, 200, {
        what: what === 'sub' ? 'sub' : 'node',
        dataUrl: await qrDataUrl(text)
      })
    }

    // 存备注（不碰宿主机）
    if (!action && method === 'PATCH') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      const u = await setProxyUserNote(id, str(body.note))
      return u ? sendJson(res, 200, {ok: true, user: shape(u)}) : sendJson(res, 404, {error: '用户不存在'})
    }

    // 删人：先把库里的行删掉，再整体下发（少了这个人，宿主机那边他立刻连不上）
    if (!action && method === 'DELETE') {
      try {
        const ok = await deleteProxyUser(id)
        if (!ok) return sendJson(res, 404, {error: '用户不存在'})
        return sendJson(res, 200, {
          ok: true,
          users: (await listProxyUsers()).map(shape),
          health: await proxyHealth()
        })
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    if (method !== 'POST') return sendJson(res, 405, {error: 'Method Not Allowed'})

    try {
      // 停用 / 启用
      if (action === 'enabled') {
        const body = await readJsonBody(req).catch(() => null)
        if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
        const u = await setProxyUserEnabled(id, body.enabled === true)
        if (!u) return sendJson(res, 404, {error: '用户不存在'})
        return sendJson(res, 200, {ok: true, user: shape(u), health: await proxyHealth()})
      }

      // 换订阅密码（订阅地址变了，客户端要重新拉一次）
      if (action === 'password') {
        const u = await rotateProxyPassword(id)
        return u
          ? sendJson(res, 200, {ok: true, user: shape(u)})
          : sendJson(res, 404, {error: '用户不存在'})
      }

      // 换节点 UUID（旧节点链接立刻作废）
      if (action === 'uuid') {
        const u = await rotateProxyUuid(id)
        return u
          ? sendJson(res, 200, {ok: true, user: shape(u)})
          : sendJson(res, 404, {error: '用户不存在'})
      }
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }

    return sendJson(res, 404, {error: 'Not Found'})
  }

  // 删人的 DELETE 已经并到上面那段 `/:id` 里了

  /* ---- 管理员：Mac 服务（VS Code Web / DeepSeek Harness）的登录密码 ----
   *
   * 这两个服务都在 Mac 上跑，经反向隧道由这台服务器转出去；Caddyfile 里
   * `code.bitcoooin.cn` 和 `chat.bitcoooin.cn` 各有一个 basic_auth，用的是同一个
   * 账号和哈希。这里改的就是那两行 bcrypt 哈希（见 ./mac-services.ts）。
   */
  if (p === '/api/admin/mac' || p.startsWith('/api/admin/mac/')) {
    if (!me.isAdmin) return sendJson(res, 403, {error: '需要管理员权限'})

    if (p === '/api/admin/mac' && method === 'GET') {
      return sendJson(res, 200, await getMacServices())
    }

    if (p === '/api/admin/mac/password' && method === 'POST') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      try {
        await setMacPassword(str(body.password))
        return sendJson(res, 200, {ok: true})
      } catch (e) {
        return sendJson(res, 400, {error: (e as Error).message})
      }
    }

    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /* ---- 管理员：远程桌面（RustDesk）—— 只读页面，唯一能改的是别名 ---- */
  if (p === '/api/admin/rustdesk' || p.startsWith('/api/admin/rustdesk/')) {
    if (!me.isAdmin) return sendJson(res, 403, {error: '需要管理员权限'})

    // 一页要的全部数据：接入信息 + 设备清单 + 最近活动（宿主机 agent 读出来）
    if (p === '/api/admin/rustdesk' && method === 'GET') {
      return sendJson(res, 200, await rustDeskSnapshot())
    }

    // 存别名 —— 只动应用库，**不碰宿主机**（agent 是只读的）
    const m = p.match(/^\/api\/admin\/rustdesk\/(\d{1,20})$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    if (method !== 'PATCH') return sendJson(res, 405, {error: 'Method Not Allowed'})
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    try {
      await setRustDeskNote(m[1], str(body.note))
      return sendJson(res, 200, {ok: true})
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
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

    // 删号（⚠️ 会级联删掉这个人的分析 / 用量）
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
  if (p === '/api/markets/base') {
    await handleMarketBase(url, res)
    return
  }
  if (p === '/api/markets') {
    await handleMarkets(url, res)
    return
  }
  if (p === '/api/kline/recorder' && method === 'GET') {
    /*
     * 底座自检 + 读路径自检（2026-10-07 P1 起读路径就用这座库）。
     * `?db=1` 顺带把库里每档的行数与覆盖区间带上；`store` 是三层读路径的命中计数
     * （`memory/db/rest/live`）—— 常态应该是 `db` 涨、`rest` 几乎不动。
     */
    try {
      const st = await klineRecorderStats()
      if (url.searchParams.get('db')) {
        /*
         * `?db=1` 走**估计值**（`pg_class.reltuples`）+ 每档索引端点探测；不再是全表 `count(*)`
         * —— 11M 行 / 5.5GB 时那条要几十秒，还把磁盘占住（与 2026-10-07 线上事故同类）。
         * 真要精确值就用 `?db=exact`。
         */
        const exact = url.searchParams.get('db') === 'exact'
        return sendJson(res, 200, {
          ...st,
          store: klineStoreStats(),
          db: await candleStoreStats({exact})
        })
      }
      return sendJson(res, 200, {...st, store: klineStoreStats()})
    } catch (e) {
      return fail(res, 'kline/recorder', e)
    }
  }
  if (p === '/api/kline/recon' && method === 'GET') {
    /*
     * 第 3 档「抽样对账」的查看 / 手动触发。
     *
     *   GET /api/kline/recon          → 最近几轮结果 + 写入前校验的丢弃计数
     *   GET /api/kline/recon?run=1    → 立刻跑一轮（3 币 × 5 档 = 30 权重，十几秒）
     *
     * 为什么要手动入口：定时那轮是 24 小时一次，发布后想当场确认"库和交易所是一致的"
     * 不该等一天。`?run=1` 跟定时那轮走的是同一个函数，结果同样落 `kline_recon`。
     */
    try {
      if (url.searchParams.get('run')) {
        const r = await runKlineRecon('manual')
        return sendJson(res, 200, {...r, recent: await recentKlineRecon(15)})
      }
      const limit = Number(url.searchParams.get('limit') ?? 20)
      return sendJson(res, 200, {
        recon: (await klineRecorderStats()).recon,
        rejects: candleRejectStats(),
        recent: await recentKlineRecon(Number.isFinite(limit) ? limit : 20)
      })
    } catch (e) {
      return fail(res, 'kline/recon', e)
    }
  }
  if (p === '/api/kline/contracts' && method === 'GET') {
    /*
     * 合约**生命周期**（新币 / 下架）：清单、最近一次发现的结果、表里的统计。
     *
     *   GET /api/kline/contracts            → 最近一次发现 + 表统计（0 权重）
     *   GET /api/kline/contracts?list=1     → 顺便把**非 TRADING** 的那些列出来（排查用）
     *   GET /api/kline/contracts?run=1      → 立刻跑一次发现（权重 1，约 1.1MB，十几秒）
     *
     * 为什么要有手动入口：定时那轮 24 小时一次，想当场确认"新币有没有被订上"不该等一天。
     */
    try {
      if (url.searchParams.get('run')) {
        const r = await discoverContracts('manual')
        return sendJson(res, 200, {
          ...r,
          discovery: (await klineRecorderStats()).discovery,
          table: await symbolTableStats()
        })
      }
      const out: Record<string, unknown> = {
        discovery: (await klineRecorderStats()).discovery,
        table: await symbolTableStats()
      }
      if (url.searchParams.get('list')) {
        const cfg = loadConfig()
        const rows = await loadSymbols(cfg.exchange, cfg.marketType)
        out.gone = rows
          .filter(r => r.status !== 'TRADING')
          .map(r => ({
            pair: r.pair,
            status: r.status,
            onboardAt: r.onboardAt ? r.onboardAt.toISOString() : null,
            delistedAt: r.delistedAt ? r.delistedAt.toISOString() : null
          }))
      }
      return sendJson(res, 200, out)
    } catch (e) {
      return fail(res, 'kline/contracts', e)
    }
  }
  if (p === '/api/kline/gaps' && method === 'GET') {
    /*
     * 第 2 档「缺口巡检」的查看 / 手动触发。
     *
     *   GET /api/kline/gaps          → 最近一次巡检的统计 + 待修队列长度
     *   GET /api/kline/gaps?run=1    → 立刻巡一遍（0 权重，只查库；发现缺口会排进修复队列）
     *
     * 为什么要有手动入口：定时那轮 5 分钟一次，发布后想当场确认"洞补上没有"不该干等。
     */
    try {
      const before = await klineRecorderStats()
      const run = url.searchParams.get('run')
      if (run === 'full') {
        /*
         * `?run=full`：**手动**的全量残桶体检 —— 4 桶 × 5 档 × 全部币，实测一轮 4 分 40 秒。
         * 定时路径不再跑它（改成记账复核，见 candle-store 的 verifyPendingChecks）；
         * 这个入口是给**上线时把历史遗留理一遍**用的。
         */
        const r = await runFullStaleSweep('manual-full')
        const after = await klineRecorderStats()
        return sendJson(res, 200, {...r, gaps: after.gaps, pendingRepairs: after.pendingRepairs})
      }
      if (run === 'audit') {
        /*
         * 连续性审计搬成**手动脚本**了（用户 2026-10-08：默认历史数据没问题，
         * 有缺失时手动跑一遍就行）—— `npm run candles:audit`。
         * 这里保留一句提示，别让人以为线上没有这个能力。
         */
        return sendJson(res, 200, {
          error: '连续性审计已改成手动脚本：npm run candles:audit（-- --repair 顺手补）'
        })
      }
      if (run) {
        const r = await runGapCheck('manual')
        const after = await klineRecorderStats()
        return sendJson(res, 200, {...r, pendingRepairs: after.pendingRepairs})
      }
      return sendJson(res, 200, {gaps: before.gaps, pendingRepairs: before.pendingRepairs})
    } catch (e) {
      return fail(res, 'kline/gaps', e)
    }
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

  /* ---- 预测历史（每次分析存的那一句话） ---- */
  if (p === '/api/analyses') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    try {
      const symbol = (url.searchParams.get('symbol') ?? '').trim()
      const page = await listAnalyses({
        userId: me.id,
        symbol: symbol || undefined,
        days: Math.max(1, Number(url.searchParams.get('days') ?? 30)),
        limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50))),
        offset: Math.max(0, Number(url.searchParams.get('offset') ?? 0))
      })
      sendJson(res, 200, page)
    } catch (e) {
      sendJson(res, 503, {error: dbHelpMessage(e)})
    }
    return
  }
  if (p.startsWith('/api/analyses/')) {
    const m = p.match(/^\/api\/analyses\/(\d+)$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    if (method !== 'DELETE')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    try {
      const ok = await deleteAnalysis(me.id, Number(m[1]))
      sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '没这条记录'})
    } catch (e) {
      sendJson(res, 503, {error: dbHelpMessage(e)})
    }
    return
  }

  /* ---- 数据问答（2026-10-16）----
   *
   * 「用自然语言问自己库里的数据」。模型能做的只有「选工具 + 给参数」——
   * `grade` / `verdict` 这些口径和 SQL 都写死在 `ask/tools.ts` 的 6 个工具里
   * （为什么不让模型直接写 SQL：越权 + 口径会飘，见那个文件的说明）。
   *
   * 答不出来 / 模型报错都回 **200 + `{error}`**：前端把它当一条「这次没答上来」的
   * 气泡渲染，不该变成一个「请求失败」的 toast。
   */
  if (p === '/api/ask') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return sendJson(res, 400, {error: (e as Error).message})
    }
    const question = str(body.question).trim()
    if (!question) return sendJson(res, 400, {error: '缺少 question'})
    if (question.length > MAX_QUESTION_CHARS)
      return sendJson(res, 400, {
        error: `问题太长了（上限 ${MAX_QUESTION_CHARS} 字）`
      })

    /*
     * 会话（2026-10-17）：给了 `threadId` 就用它 —— **多轮历史从库里取**（不信前端
     * 塞进来的那份）；没给就现开一个（标题 = 这一句问题），跟流式那条同一个口径。
     */
    const asked = Number(body.threadId) || 0
    let threadId = asked && (await ownsAskThread(me.id, asked)) ? asked : 0
    try {
      if (!threadId) threadId = await createAskThread(me.id, question)
      const history = await askThreadHistory(me.id, threadId)
      const out = await askData({userId: me.id, question, history})
      await saveAskTurn(me.id, threadId, question, out)
      return sendJson(res, 200, {...out, threadId})
    } catch (e) {
      return sendJson(res, 200, {error: (e as Error).message, threadId})
    }
  }

  /* ---- 数据问答的会话（2026-10-17）：多设备能续上 ---- */
  if (p === '/api/ask/threads') {
    if (method === 'GET') {
      const threads = await listAskThreads(me.id)
      return sendJson(res, 200, {threads})
    }
    if (method === 'POST') {
      const body = await readJsonBody(req).catch(() => ({}) as Record<string, unknown>)
      const id = await createAskThread(me.id, str(body.title) || '新的对话')
      return sendJson(res, 200, {id})
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p === '/api/ask/threads/import') {
    if (method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    const body = await readJsonBody(req).catch(() => null)
    if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
    const out = await importAskThreads(me.id, importThreads(body.threads))
    return sendJson(res, 200, out)
  }
  if (p.startsWith('/api/ask/threads/')) {
    const m = p.match(/^\/api\/ask\/threads\/(\d+)$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])
    if (method === 'GET') {
      const thread = await getAskThread(me.id, id)
      return sendJson(res, thread ? 200 : 404, thread ?? {error: '会话不存在'})
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req).catch(() => null)
      if (!body) return sendJson(res, 400, {error: '请求体不是合法 JSON'})
      const ok = await renameAskThread(me.id, id, str(body.title))
      return sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '会话不存在'})
    }
    if (method === 'DELETE') {
      const ok = await deleteAskThread(me.id, id)
      return sendJson(res, ok ? 200 : 404, ok ? {ok: true} : {error: '会话不存在'})
    }
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }

  /*
   * 流式版。
   *
   * ★ 2026-10-16：主力改成 **`POST /api/ask/stream`**（问题 + 历史走 body）——
   *   原来只有 GET，历史塞在 URL 里，中文一编码就把请求头顶爆（431），
   *   见 `handleAskStream` 那段说明。GET（`?q=`）留着兼容命令行 / 老页面。
   */
  if (p === '/api/ask/stream') {
    if (method !== 'GET' && method !== 'POST')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    await handleAskStream(req, url, res, me)
    return
  }

  /* ---- AI 提示词文档（分析预测 / 润色，全部存数据库） ---- */
  if (p === '/api/ai-docs') {
    if (method === 'GET') return handleListAiDocs(res)
    if (method === 'POST') return handleCreateAiDoc(req, res)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p === '/api/ai-preview') {
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    return handleAiPreview(url, res, me)
  }
  if (p.startsWith('/api/ai-docs/')) {
    const mv = p.match(/^\/api\/ai-docs\/(\d+)\/versions$/)
    if (mv) {
      if (method !== 'GET')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      return handleListAiVersions(Number(mv[1]), res)
    }
    const m = p.match(/^\/api\/ai-docs\/(\d+)$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    const id = Number(m[1])
    if (method === 'PUT') return handleUpdateAiDoc(id, req, res)
    if (method === 'DELETE') return handleDeleteAiDoc(id, res)
    return sendJson(res, 405, {error: 'Method Not Allowed'})
  }
  if (p.startsWith('/api/ai-versions/')) {
    const mr = p.match(/^\/api\/ai-versions\/(\d+)\/restore$/)
    if (mr) {
      if (method !== 'POST')
        return sendJson(res, 405, {error: 'Method Not Allowed'})
      return handleRestoreAiVersion(Number(mr[1]), res)
    }
    const m = p.match(/^\/api\/ai-versions\/(\d+)$/)
    if (!m) return sendJson(res, 404, {error: 'Not Found'})
    if (method !== 'GET')
      return sendJson(res, 405, {error: 'Method Not Allowed'})
    return handleGetAiVersion(Number(m[1]), res)
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

/**
 * 把一次问答的结果落进 `ask_turns`（2026-10-17）。
 *
 * ⚠️ 这是**旁路**：存不上不能把这一问搞挂（用户已经拿到回答了）——
 *    跟 `recordUsage` 一个道理，失败只写日志。
 * ⚠️ 终止（`aborted`）也存：半截回答 + `stopped=true`，重开时跟刚才看到的一致。
 */
async function saveAskTurn(
  userId: number,
  threadId: number,
  question: string,
  out: AskAnswer
): Promise<void> {
  const turn: NewAskTurn = {
    question,
    answer: out.answer,
    steps: out.steps,
    unverified: !out.verified,
    model: out.model,
    costUsd: out.costUsd,
    latencyMs: out.latencyMs,
    ok: Boolean(out.answer) && !out.aborted,
    stopped: out.aborted,
    error: ''
  }
  try {
    await appendAskTurn(userId, threadId, turn)
  } catch (e) {
    console.error('[ask] 会话落库失败：', (e as Error).message)
  }
}

/**
 * 前端 localStorage 里那批旧会话 → `importAskThreads` 认的形状。
 *
 * 只认形状对得上的（别让浏览器里乱七八糟的东西直接进库），一轮都没有的会话丢掉。
 * `createdAt` 用原来的时间：左侧的「今天 / 昨天 / 7 天内」分组才不会全挤到今天。
 */
function importThreads(raw: unknown): ImportedThread[] {
  if (!Array.isArray(raw)) return []
  const list: ImportedThread[] = []
  for (const item of raw) {
    const o = item as Record<string, unknown>
    if (!o || typeof o !== 'object') continue
    const turns: NewAskTurn[] = []
    for (const t of Array.isArray(o.turns) ? o.turns : []) {
      const x = t as Record<string, unknown>
      if (!x || typeof x.question !== 'string') continue
      turns.push({
        question: x.question.slice(0, 500),
        answer: typeof x.answer === 'string' ? x.answer : '',
        steps: Array.isArray(x.steps) ? x.steps : [],
        unverified: Boolean(x.unverified),
        model: typeof x.model === 'string' ? x.model : '',
        costUsd: Number(x.costUsd) || 0,
        latencyMs: Number(x.latencyMs) || 0,
        ok: Boolean(x.ok),
        stopped: Boolean(x.stopped),
        error: typeof x.error === 'string' ? x.error : '',
        createdAt: Number(x.createdAt) || undefined
      })
    }
    if (!turns.length) continue
    list.push({
      title:
        typeof o.title === 'string' && o.title.trim()
          ? o.title.slice(0, 60)
          : turns[0]!.question.slice(0, 20),
      createdAt: Number(o.createdAt) || undefined,
      updatedAt: Number(o.updatedAt) || undefined,
      turns
    })
  }
  return list
}

/**
 * 「数据问答」收到的历史轮次 —— 只认形状对得上的那几轮，其余丢掉
 *（别让前端塞进来的东西进 prompt）。POST 与流式两条路共用。
 */
function askHistory(raw: unknown): {role: 'user' | 'assistant'; content: string}[] {
  return (Array.isArray(raw) ? raw : [])
    .map(t => t as {role?: unknown; content?: unknown})
    .filter(
      t =>
        (t?.role === 'user' || t?.role === 'assistant') &&
        typeof t?.content === 'string'
    )
    .map(t => ({
      role: t.role as 'user' | 'assistant',
      content: (t.content as string).slice(0, 4000)
    }))
}

/**
 * 数据问答的**流式**版（Server-Sent Events）。
 *
 * 事件：`round`（进入第 N 轮）· `step`（一个工具跑完）· `delta`（回答逐字增量）·
 *      `done`（最后那份完整结果，前端拿它盖掉 delta 拼出来的）· `failed`。
 *
 * ⚠️ 跟 `handleAnalyzeStream` 一样：这是**任务型**的流，断了不重连
 *    （重连等于再问一遍、再花一次钱）。所以前端那边也该这么对待它。
 *
 * ⚠️⚠️ **多轮历史必须走 POST body，不能塞 URL**（2026-10-16 修的一个真 bug）：
 *    原来前端用 `EventSource` 发 GET，把历史放在 `?h=<JSON>` 里 ——
 *    中文经 URL 编码**每个字变 9 个字符**，上一轮那篇长回答（4KB+）一编码就是几十 KB，
 *    直接顶爆 Node 默认的 **16KB 请求头上限** ⇒ **431 Request Header Fields Too Large**
 *    ⇒ 流根本建不起来，界面就"卡在正在查库"。POST body 没这个上限。
 *    顺带：POST 还能带 `Authorization` 头，**token 不用再出现在 URL 里**。
 *    GET 那条留着（`?q=`）—— 命令行 / 老页面还能用。
 */
async function handleAskStream(
  req: http.IncomingMessage,
  url: URL,
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

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /* 问题与历史：POST 从 body 取（正常路径），GET 从 query 取（命令行 / 老页面） */
  let question = ''
  let history: unknown = []
  /** 会话 id（0 = 还没有，现开一个）—— 见下面「会话落库」那段 */
  let threadId = 0
  if (req.method === 'POST') {
    const body = await readJsonBody(req).catch(() => null)
    if (!body) {
      send('failed', {error: '请求体不是合法 JSON'})
      res.end()
      return
    }
    question = str(body.question).trim()
    history = body.history
    threadId = Number(body.threadId) || 0
  } else {
    question = (url.searchParams.get('q') ?? '').trim()
    try {
      history = JSON.parse(url.searchParams.get('h') ?? '[]')
    } catch {
      history = []
    }
  }

  if (!question) {
    send('failed', {error: '缺少问题'})
    res.end()
    return
  }
  if (question.length > MAX_QUESTION_CHARS) {
    send('failed', {error: `问题太长了（上限 ${MAX_QUESTION_CHARS} 字）`})
    res.end()
    return
  }

  /*
   * 页面切走 / 用户按「终止」⇒ **真把这一跑停掉**。
   *
   * ⚠️ 只能听 `res` 的 close（`req` 的 close 在请求收完就触发，等于立刻"已关闭"）。
   * ⚠️ 别用 `req.on('aborted')`：HTTP/2 / 代理后面不保证触发，而且它和 `res.close`
   *    会在同一次断开里都来，容易写出「取消两遍」的代码。听一个就够。
   */
  const ac = new AbortController()
  let closed = false
  res.on('close', () => {
    closed = true
    if (!ac.signal.aborted) {
      ac.abort()
      // 一行诊断：终止到底有没有传到（见 `test: true` 那套验证里怎么用它）
      console.log('[ask] 连接断开（页面关了 / 用户按了终止）→ 取消这一跑')
    }
  })

  // 心跳：前端那条看门狗靠它判断连接还活着（见 `liveSse` 的说明）
  const beat = setInterval(() => {
    if (!closed) send('heartbeat', {})
  }, 20_000)

  /*
   * 会话（2026-10-17）：**先落一个壳**再开跑。
   *
   * 为什么在跑之前建：这一问可能要十几秒，建会话是毫秒级；先建好就能
   *   ① 立刻把 id 推给前端（`thread` 事件）—— 中途终止 / 断线也认得是哪个会话；
   *   ② 顺手把标题定成这一句问题（后端 `appendAskTurn` 只在标题还是占位时才动它）。
   * ⚠️ 给了 `threadId` 但**不是这个人的**（改过 url / 删掉了）⇒ 当没给，现开一个，
   *    别报到别人会话里去。
   */
  let threadTitle = ''
  try {
    if (!threadId || !(await ownsAskThread(user.id, threadId))) {
      threadId = await createAskThread(user.id, question)
    }
    const head = await getAskThread(user.id, threadId)
    threadTitle = head?.title ?? ''
    if (!closed) send('thread', {id: threadId, title: threadTitle})
  } catch (e) {
    // 建会话失败也不拦着这一问（回答本身不依赖它）
    console.error('[ask] 建会话失败：', (e as Error).message)
    threadId = 0
  }

  try {
    const out = await askData(
      {
        userId: user.id,
        question,
        /* 会话里已经有几轮 ⇒ 历史**从库里取**（不信前端塞进来的那份） */
        history: threadId
          ? await askThreadHistory(user.id, threadId).catch(() => askHistory(history))
          : askHistory(history),
        signal: ac.signal
      },
      e => {
        if (!closed) send(e.type, e)
      }
    )
    if (threadId) await saveAskTurn(user.id, threadId, question, out)
    if (!closed) send('done', {...out, threadId})
  } catch (e) {
    /*
     * 用户终止时 `signal` 会把请求打断，于是这里会收到一个 abort 错误 ——
     * 那不是"失败"，别弹一条红色的错误气泡（他已经按了终止、也知道自己在终止）。
     */
    if (!closed && !ac.signal.aborted) send('failed', {error: (e as Error).message})
  } finally {
    clearInterval(beat)
    res.end()
  }
}

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
  /*
   * ★ 先拦「第二个实例」（2026-10-16）。
   *
   * 必须排在最前面：本机同时跑两个后端 = 两套交易所流 + 两套补历史挤**同一条**
   * 按出口 IP 算的权重预算（见 `util/rate-budget.ts`），报出来是
   * 「取数失败：交易所请求太频繁」，而且两个实例互相甩锅、很难查。
   * 拿不到锁就直接退出（急着手动起第二个：`ALLOW_MULTI_SERVER=1`）。
   */
  claimSingleInstance(PORT)

  /*
   * ★ 先占端口，再干重活（2026-10-07 线上事故）。
   *
   * 原来顺序是「DB schema → markets → 资产流 → 归档 → 管理员 → 币种表 → K 线底座 → `listen()`」，
   * 中间**任何一步慢**都等于「Caddy 拿不到上游 ⇒ **全站 502**」：那天 K 线表涨到 10.45M 行 /
   * 3.8GB 之后退化成的全表扫，让容器起来到 listen 用了 **3 分 27 秒** ⇒ 502 也持续 3 分 27 秒。
   * 端口先占上：静态页、健康检查立刻可用，重活再慢也只影响真正用它们的接口。
   */
  const rules = await loadRules()
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
    console.log(
      `  提示词  ${rules.sources.join('、') || '（数据库里没有启用的文档）'}`
    )
    for (const w of rules.warnings) console.log(`  ⚠️  ${w}`)
  })

  /** 管理员账号的情况（要等下面的 DB 初始化才知道，所以 banner 之后再补一行） */
  let adminNote = ''
  try {
    await ensureSchema()
    /*
     * markets（`exchangeInfo`，1.1MB）**必须最先**从库里灌进内存 —— 底下每一路
     * （交易所资产流 / 快照采样 / K 线底座 / 预热）都会 `getExchange()` 建实例，
     * 而 `attachMarkets()` 判"够不够新"看的是**内存里这份缓存**：
     * 抢在它之前建实例 ⇒ `fresh()` 为假 ⇒ **开机白下 1.1MB**（本地隧道 25 秒）。
     * 2026-10-07 实测抓到的就是这条：`startExchangeStreams()` 排在灌缓存之前，
     * `ccxt_markets.updated_at` 每次开机都被刷成启动那一刻。
     */
    await hydrateMarketsCache().catch((e: Error) =>
      console.warn(`  交易所  markets 读库失败：${e.message.slice(0, 80)}`)
    )
    /*
     * 交易所资产的实时层（M2，方案 docs/EXCHANGE.md）：
     * 给每套合约账户写一条「启动锚点」快照并起用户数据流（listenKey + 裸 WS），
     * 再起 5 分钟采样（兼作 REST 对账；C2C 钱包没有 WS 事件，只能靠它）。
     * ⚠️ 不 await：联网慢不拖启动，内部失败只告警。
     */
    startExchangeStreams()
    startSnapshotSampler()
    /*
     * 快照的**归档 + 清理**（2026-10-06）：5m 留 7 天、聚合成 1h 留 90 天、
     * 再聚合成 1d 永久。不跑的话 `exchange_snapshots` 会无限长
     * （一套 key ≈ 128 MB/年）。启动时先跑一次，把停机那段断档补上。
     */
    startExchangeArchiver()
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
     * 语气预设（2026-10-12 用户：「你直接后端给我预设上去」）：
     * 库里没有同名那份就补一份 —— **默认关着**，用户想用哪个就打哪个的勾。
     * 预设表在 `llm/tone-presets.ts`（同一份还通过 `/api/ai-docs` 发给前端当新建模板）。
     */
    const tonesAdded = await ensureTonePresets().catch(() => [] as string[])
    if (tonesAdded.length) {
      console.log(
        `  语气预设  补了 ${tonesAdded.length} 份（都没打勾）：${tonesAdded.join('、')}`
      )
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

  /* 端口在 `main()` 开头就占了（见那儿的说明）⇒ banner 剩下的两行补在这里 */
  if (adminNote) console.log(`  账号    ${adminNote}`)
  console.log('')
  console.log('  按 Ctrl+C 停止。')

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
   * ⚠️ 只删 `analyses` / `llm_usage` 两张**流水表** —— 提示词**绝不碰**。
   *    想全留着：`.env` 里写 `KEEP_DAYS=0`。
   *
   * 跟币种表一个套路：不 await（别拖住启动），失败只告警。
   */
  const pruneOld = () => {
    const days = loadConfig().keepDays
    void pruneOldData(days)
      .then(r => {
        if (r.usage) {
          console.log(
            `  清理流水  保留 ${r.keepDays} 天：删掉用量 ${r.usage} 条`
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
   * K 线画线的穿线提醒（2026-10-17）：**服务器自己盯价**，网页没开也响。
   * 盯的是 `kline-stream` 那条全市场行情（`!ticker@arr`，零权重）；
   * 它同时也让那条流常开 —— 前端没在看行情时提醒照样有效。
   */
  startPriceAlerts()

  /*
   * 持仓日志（2026-10-22）：默认**不跑**了 ——
   * 用户当晚改口：「复盘改成自己选一段周期来总结，补历史去掉、默认同步也去掉」。
   *
   * 现在复盘页直接从成交账本算（`summarizeRange`），不需要提前落 `position_plans`；
   * 这一跳留着只作手动/脚本入口（`syncPositionJournal` 仍在 `data/trade-review.ts`），
   * 不再挂定时器 —— 免得每分钟白跑一轮 SQL。
   */


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
   * 持久化分析（2026-10-15 用户：「每隔 15 分钟分析一次，最长不超过 8 小时」）。
   *
   * 调度口径：**一个对齐到 15m 收线（+20 秒）的定时器 + 库里每个会话的 `next_at`**，
   * 而不是给每个会话起一个 `setInterval`：
   *   · 会话状态在库里 ⇒ 进程重启接着跑，没错过的轮次（`next_at <= now()` 才算该跑）；
   *   · 对齐 :00/:15/:30/:45 + 20 秒 ⇒ 每次喂给 AI 的都是**刚收线**的那根，同一会话各轮口径一致；
   *   · 失败/慢一轮也不会把后面的挤乱（每一跑自己算下一跳）。
   *
   * ⚠️ `runPersistTick` 里已经逐个跑（不并发）：上游权重 + 模型限流都不喜欢同时打五发。
   *    失败只告警 —— 一条分析挂了不该影响别的会话，更不该让进程出事。
   */
  const kickPersist = (): void => {
    void runPersistTick()
      .then(rs => {
        for (const r of rs) {
          if (r.ok) {
            console.log(
              `  持久化  ${r.symbol} 第 ${r.sessionId} 号会话跑完：` +
                `${r.verdict ?? '?'}${r.alerted ? `（上一轮 ${r.previousVerdict ?? '无'} ⇒ 转可做，已通知）` : ''}`
            )
          }
        }
      })
      .catch(e => console.warn(`  持久化  ⚠️  ${(e as Error).message}`))
  }
  const persistLoop = (): void => {
    /* 按**最小**的间隔起跳（15m）：1h 的会话 next_at 永远落在整点 +20 秒，从这一跳里也会被捞到 */
    const step = Math.min(...CADENCES.map(c => c.intervalMs))
    const now = Date.now()
    /* 下一跳 = 下一个 :00/:15/:30/:45 + 20 秒（跟 `nextRunAt` 同一口径） */
    const aligned = Math.floor((now + 20_000) / step) * step + 20_000
    const next = aligned > now ? aligned : aligned + step
    const timer = setTimeout(() => {
      kickPersist()
      persistLoop()
    }, next - now)
    timer.unref()
  }
  persistLoop()

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
      })
      .catch(e =>
        console.warn(`  交易所  ⚠️ 预热失败：${(e as Error).message}`)
      )
  }
  /*
   * markets（`exchangeInfo`，1.1MB）先从库里灌进内存，再预热实例 —— 顺序不能反：
   * 反了预热就会真去下 1.1MB（本地隧道 25 秒）。见 `data/ccxt-markets.ts`。
   */
  /*
   * ★ K 线底座（常驻 1m 推送流 → 落库 7 天 → 滚出高周期）——
   *   2026-10-07 起它**同时是读路径的第二层**：`/api/candles` 走「内存 → 库 → REST」，
   *   库里那份（已收盘的桶）+ 底座内存里的当前根（`currentBar()`）就够画图了。
   *   预热与保活那两套因此一并删掉（见 docs/EXCHANGE.md §37）。
   *
   * ⚠️ 它第一步就是 `listPerpetualSymbols()`（要 `markets`）—— 所以必须排在开头那次
   *   `hydrateMarketsCache()` 之后（现在天然满足）。
   */
  /* markets 已经在 `main()` 最开头灌进内存了（见那儿的说明），这里不重复读一次库 */
  kickExchange()
  startKlineRecorder()

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
}

/**
 * 优雅退出的总预算：交易所关流（≤5 秒）+ 等整分钟（≤62 秒）+ 落库，留点余量。
 * ⚠️ 必须**小于** `docker-compose.prod.yml` 里 app 的 `stop_grace_period`（75 秒），
 *    否则到点被 SIGKILL，等整分钟白等（见下面的 SIGTERM 处理）。
 */
const SHUTDOWN_BUDGET_MS = 70_000
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * 退出时把 Vite 与数据库连接池关干净，别留孤儿进程。
 *
 * ★ 2026-10-11：**SIGTERM 时等这一分钟收盘再退**（`alignShutdownToMinute()`）——
 *   配合 K 线底座的 `hydrateAggs()`，这样容器重建 / 发布重启**不会再掉一根桶**
 *   （见 docs/EXCHANGE.md 第 58 节）。三个时间预算要一起看，别只改一个：
 *     · 交易所关流（写锚点 + 删 listenKey）≤ 5 秒（跟以前一样，别卡在联网上）；
 *     · 等整分钟 ≤ 60 秒 + 6 秒余量（余量按实测定，见 SHUTDOWN_CLOSE_MARGIN_MS）；
 *     · 前两步**并行**，所以合计 ≤ 66 秒 + 落库，留够 `SHUTDOWN_BUDGET_MS`（70 秒）——
 *       必须**小于** `docker-compose.prod.yml` 里 app 的 `stop_grace_period`（75 秒），
 *       否则到点被 SIGKILL，这一分钟的 1m 照样丢。
 * ⚠️ Ctrl+C 发的是 SIGINT：开发时不等（否则按一下要干等最多 60 秒）。等整分钟这件事
 *    只对「编排器让你退」有意义。
 */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    const waitForMinute = sig === 'SIGTERM'
    void Promise.race([
      (async () => {
        /*
         * ① 交易所关流（写「关闭锚点」快照 + 删 listenKey 断流，约 2 秒/条 key）
         * ② 等整分钟再落库（K 线那边）
         * 两件事互不相干（关的是账户流，K 线那条 WS 自己一条连接、也不共用 agent 的销毁），
         * 所以**并行**跑：总时长取两者较大者（≤5 秒 / ≤66 秒），而不是相加。
         */
        await Promise.all([
          Promise.race([stopExchangeStreams(), sleep(5000)]),
          /* 只有 SIGTERM 才等整分钟；SIGINT（Ctrl+C）不等，见函数头说明 */
          waitForMinute ? alignShutdownToMinute() : Promise.resolve(0)
        ])
        /* ③ K 线底座：把攒着的那批点落库再关（最多几秒） */
        await stopKlineRecorder()
      })(),
      sleep(SHUTDOWN_BUDGET_MS)
    ])
      .catch(() => undefined)
      .then(() => Promise.resolve(viteDev?.close()))
      .catch(() => undefined)
      .then(() => closePool())
      .catch(() => undefined)
      .then(() => process.exit(0))
  })
}

/*
 * ★ 兜一句「没人接的 Promise 拒绝」（2026-10-06 加）。
 *
 * ⚠️ 为什么要：WS 事件分发、后台对账定时器都是 `void asyncFn()` 发出去的。
 *    Node 15+ 默认对未处理的拒绝是**打印堆栈后退出进程** ——
 *    一个一帧坏数据 / 一次 DB 抖动能把整个服务带走（流全断、账全停），
 *    而退出前的堆栈在被重定向的日志里很容易被忽略。
 *    这里记一行**带标记**的日志，然后**继续跑**：交易相关的服务宁可降级也别猝死。
 */
process.on('unhandledRejection', (e: unknown) => {
  const err = e as Error
  console.warn(
    `[server] 未处理的 Promise 拒绝（已兜住，没退出）：${err?.message ?? e}`
  )
})

main().catch(e => {
  console.error('启动失败：', (e as Error).message)
  process.exitCode = 1
})
