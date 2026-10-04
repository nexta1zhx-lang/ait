/** 所有后端接口的类型与调用 */

import {ref} from 'vue'
import {isNativeShell} from './platform'
import {isForeground, onForegroundChange} from './live'

/* ---------------- 登录态 ---------------- */

/**
 * 登录 token。
 *
 * 放在**模块作用域**（不是组件里），所有请求共用；写进 localStorage，
 * 刷新页面不用重新登录。请求带 `Authorization: Bearer <token>`，
 * SSE 带不了请求头，所以拼成 `?token=`（后端两种都认）。
 */
const TOKEN_KEY = 'ca_token'

export const authToken = ref<string>(
  typeof localStorage === 'undefined'
    ? ''
    : (localStorage.getItem(TOKEN_KEY) ?? '')
)

export function setAuthToken(token: string): void {
  authToken.value = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 隐私模式 / WebView 里可能不让写，忽略 */
  }
}

/** 往路径上拼 token（SSE 用） */
function withToken(path: string): string {
  const t = authToken.value
  if (!t) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`
}

export interface AuthUser {
  id: number
  username: string
  /** 管理员才能看到「我的 → 管理」 */
  isAdmin: boolean
}

export const authMe = () => get<{user: AuthUser}>('/api/auth/me')

/**
 * 登录第一关的结果。
 * 开了两步验证的账号**不会**直接给 token，而是回 `{needTotp, ticket}`，
 * 要拿 ticket 去过 `/api/auth/totp/verify` 才算登录完成。
 */
export type LoginResult =
  | {token: string; expiresAt: string; user: AuthUser}
  | {needTotp: true; username: string; ticket: string}

export const authLogin = (username: string, password: string) =>
  post<LoginResult>('/api/auth/login', {username, password})

/** 登录第二关：6 位动态口令，或一个恢复码（用一次就作废） */
export const authTotpVerify = (ticket: string, code: string) =>
  post<{
    token: string
    expiresAt: string
    user: AuthUser
    recoveryUsed?: boolean
  }>('/api/auth/totp/verify', {ticket, code})

/* ---------------- 登录设备（多端登录） ---------------- */

/** 「登录设备」里的一台 */
export interface DeviceSession {
  id: number
  /** 已解析好的名字，如「iPhone · Safari」 */
  device: string
  userAgent: string
  ip: string
  createdAt: string
  lastSeenAt: string
  /** 就是当前这台 */
  current: boolean
}

export const fetchSessions = () =>
  get<{sessions: DeviceSession[]}>('/api/auth/sessions')

/** 踢掉某一台（只能踢自己的） */
export const revokeSession = (id: number) =>
  post<{ok: boolean}>('/api/auth/sessions/revoke', {id})

/** 除本机以外全部下线 */
export const revokeOtherSessions = () =>
  post<{ok: boolean; revoked: number}>('/api/auth/sessions/revoke-others', {})

/* ---------------- 两步验证（TOTP，只给管理员） ---------------- */

export interface TotpState {
  enabled: boolean
  /** 扫了码但还没输码确认 */
  pending: boolean
  /** 还能用的恢复码个数 */
  recoveryLeft: number
}

export const fetchTotpState = () => get<TotpState>('/api/auth/totp')

/** 开始绑定：拿密钥 + 二维码（还没生效，等 enable 确认） */
export const setupTotp = () =>
  post<{secret: string; otpauth: string; qr: string}>(
    '/api/auth/totp/setup',
    {}
  )

/** 输一次 6 位码确认开启；返回的恢复码**只显示这一次** */
export const enableTotp = (code: string) =>
  post<{ok: boolean; recoveryCodes: string[]}>('/api/auth/totp/enable', {
    code
  })

/** 关掉（要密码 + 一个有效口令） */
export const disableTotp = (password: string, code: string) =>
  post<{ok: boolean}>('/api/auth/totp/disable', {password, code})

export const authRegister = (username: string, password: string) =>
  post<{token: string; expiresAt: string; user: AuthUser}>(
    '/api/auth/register',
    {username, password}
  )

export const authLogout = () =>
  post<{ok: boolean}>('/api/auth/logout', {}).catch(() => ({ok: false}))

/** 改密码（成功后所有会话失效，要重新登录） */
export const authChangePassword = (oldPassword: string, newPassword: string) =>
  post<{ok: boolean}>('/api/auth/password', {oldPassword, newPassword})

/* ---------------- 管理员：账号管理 ---------------- */

/** 某个用户的某把密钥（管理员视角，`apiKey` 是明文） */
export interface AdminUserLlmKey {
  id: number
  name: string
  apiKey: string
  /** 掩码（`sk-a****3456`），默认显示这个 */
  apiKeyMasked: string
  apiKeySet: boolean
  baseUrl: string
  model: string
  reasoningEffort: string
  isDefault: boolean
  updatedAt: string
}

export interface AdminUser {
  id: number
  username: string
  isAdmin: boolean
  createdAt: string
  /** 这个用户有多少条分析 / 知识库 */
  stats: {analyses: number; knowledge: number}
  /** 他自己的所有密钥（可能不止一把） */
  llmKeys: AdminUserLlmKey[]
}

export const fetchAdminUsers = () =>
  get<{users: AdminUser[]}>('/api/admin/users')

export const createAdminUser = (body: {
  username: string
  password: string
  isAdmin?: boolean
}) => post<{ok: boolean; user: AuthUser}>('/api/admin/users', body)

export const setAdminUserPassword = (id: number, password: string) =>
  post<{ok: boolean}>(`/api/admin/users/${id}/password`, {password})

/** ⚠️ 删号会级联删掉这个人的分析 / 知识库 / 用量 */
export const deleteAdminUser = (id: number) =>
  del<{ok: boolean}>(`/api/admin/users/${id}`)

/* ---------------- 合约行情置顶（每个用户最多 5 个） ---------------- */

/**
 * 用户 2026-10-04：「合约行情添加币种置顶功能最多 5 个，无视排行和用户绑定」。
 * 置顶的币永远排在最前，跟排序/搜索无关；存在库里，所以换设备也带着。
 */
export const fetchPins = () => get<{pins: string[]; max: number}>('/api/pins')

/** 置顶 / 取消置顶（同一颗星按一下就是切换），回来的是切换后的完整列表 */
export const togglePin = (base: string) =>
  post<{pins: string[]; pinned: boolean; max: number}>('/api/pins/toggle', {
    base
  })

/* ---------------- 通用 ---------------- */

/**
 * 接口基址。
 *
 * · Web（线上 / 本地开发）：留空 → 继续走相对路径 `/api/...`，同源，由后端
 *   或 Vite 代理转发，行为跟以前**完全一样**；
 * · 原生壳（Android / iOS app）：页面跑在 `https://localhost` / `capacitor://localhost`
 *   下，**没有同源后端**，相对路径会打到 WebView 自己身上（全部 404），
 *   所以这里必须指向线上服务器。
 *
 * 打包时可以用 `VITE_API_BASE` 覆盖（想指到测试服就传这个）。
 */
export const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (isNativeShell() ? 'https://bitcoooin.cn' : '')

/** 把 `/api/xxx` 拼成能用的地址（Web 上原样返回，所以 Web 侧零影响） */
export const apiUrl = (path: string): string => `${API_BASE}${path}`

/** 开一条 SSE。**必须走绝对地址**，否则原生壳里连不上；顺手带上登录 token */
const openSse = (path: string): EventSource =>
  new EventSource(apiUrl(withToken(path)))

/**
 * **长期订阅**（K 线 / 全市场行情）专用的 SSE 壳。
 *
 * 裸 `EventSource` 在手机上有两个不够用的地方，这个壳就是来补这两块的：
 *
 *   ① **僵尸连接**：App 切后台 / 锁屏时 WebView 被系统挂起，底层 socket 其实已经
 *      断了，可是浏览器不一定马上知道 —— 不报 error、也不触发它自己那套重连，
 *      界面就定格在那儿（看着像「卡死」，等多久都不动）。所以这里挂了**看门狗**：
 *      `idleMs` 之内一个事件都没收到，就判定连接已死，主动拆掉重连。
 *      ⚠️ 这一条**依赖后端喂心跳**：后端 20 秒推一次 `event: heartbeat`
 *         （`server.ts` 里的 `beat`）。**不能**用 SSE 注释行（`: ping`）——
 *         注释行浏览器压根不派发给 JS，前端看不见，看门狗只能瞎猜。
 *
 *   ② **回前台要立刻恢复**：不能干等浏览器那套指数退避（最久几十秒）。
 *      这里直接盯着 `live.ts` 的前台信号：切后台**当场断开**（别在后台耗电，
 *      也别留着僵尸连接），回前台**立刻重连**，并回调 `onReconnect` 让上层把
 *      断开期间漏掉的数据补回来（K 线重拉一段、行情重拉整表）。
 *
 * `onReconnect` 只在**真的断过一段时间**的重连上回调：快速抖动（几秒内又连回来）
 * 漏掉的东西很少，下一批推送就盖上了，不值得把整份底稿重拉一遍 —— 否则网络一抖
 * 就会看到一连串全量请求。首连也不回调（上层订阅前基本都自己取过底稿了）。
 *
 * ⚠️ **任务型的一次性流不要用它**（`analyzeStream` / `collectStream`）：那两种流断了
 *    重连没有意义 —— 后端那份任务还在跑，重连只会再开一个任务、白花一次钱。
 *
 * @param events 要转发的**具名事件**（后端 `send('kline', ...)` 里的那个名字）
 * @param onEvent 收到事件时回调（消息体已经 `JSON.parse` 过了）
 * @param opts.idleMs 多久没动静算死（默认 75 秒；后端心跳 20 秒，留了三拍余量）
 * @param opts.onReconnect 断够了时间又连回来时回调，用来补数据
 * @returns 取消函数，组件卸载时务必调用
 */
function liveSse(
  path: string,
  events: string[],
  onEvent: (name: string, data: unknown) => void,
  opts: {idleMs?: number; onReconnect?: () => void} = {}
): () => void {
  const idleMs = opts.idleMs ?? 75_000
  /** 断开超过这么久才值得重拉底稿（快抖就交给下一批推送） */
  const RESYNC_GAP_MS = 10_000

  let es: EventSource | null = null
  let watchdog: ReturnType<typeof setInterval> | null = null
  /** 最近一次「收到任何东西」的时刻：数据事件和心跳都算 */
  let lastAt = 0
  /** 是否成功连上过 —— 用来区分「首连」和「重连」 */
  let connected = false
  let stopped = false

  /** 只关连接，**别停看门狗** —— 看门狗自己重连时还要接着用 */
  const closeSocket = (): void => {
    es?.close()
    es = null
  }

  const connect = (): void => {
    if (stopped || es) return
    // 先记下断了多久，再刷新 lastAt（否则看门狗会把「正在连」当成又死了一次）
    const gap = Date.now() - lastAt
    lastAt = Date.now()
    const cur = openSse(path)
    es = cur

    // 浏览器层的 `open`：每次（重）连上都会来一次
    cur.addEventListener('open', () => {
      lastAt = Date.now()
      if (connected && gap > RESYNC_GAP_MS) opts.onReconnect?.()
      connected = true
    })

    // 后端 20 秒一次的心跳：只喂看门狗，不往上层转发
    cur.addEventListener('heartbeat', () => {
      lastAt = Date.now()
    })

    for (const name of events) {
      cur.addEventListener(name, e => {
        lastAt = Date.now()
        try {
          onEvent(name, JSON.parse((e as MessageEvent).data))
        } catch {
          /* 一条坏消息不影响后面的 */
        }
      })
    }
  }

  // 已经在前台才连（一打开就在后台的，等切回前台再连）
  if (isForeground()) connect()

  // 看门狗：前台还一直没消息 = 连接已经死了，拆了重连
  watchdog = setInterval(() => {
    if (stopped || !es) return
    if (Date.now() - lastAt <= idleMs) return
    closeSocket()
    connect()
  }, 5_000)

  // 切后台当场断开，回前台立刻重连（连上会走上面的 `open` → `onReconnect`）
  const offForeground = onForegroundChange(active => {
    if (stopped) return
    if (active) connect()
    else closeSocket()
  })

  return () => {
    stopped = true
    if (watchdog) clearInterval(watchdog)
    watchdog = null
    closeSocket()
    offForeground()
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  // 带上登录态（公开接口带了也无害）
  const headers = new Headers(init?.headers)
  if (authToken.value) headers.set('Authorization', `Bearer ${authToken.value}`)
  const res = await fetch(apiUrl(url), {...init, headers})
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
    /*
     * 401 = 登录过期：把本地 token 清掉，App 会退回登录页。
     *
     * ⚠️ **只有 401 才算「登录失效」** —— 网络不通 / 5xx（部署窗口容器重建、
     *    数据库抽一下）绝不能清 token，否则一次抖动就把人永久踢下线。
     *    所以给这个错误打个 `auth` 标记（`initAuth` 靠它区分）。
     */
    if (res.status === 401) {
      setAuthToken('')
      const err = new Error(msg) as Error & {auth?: boolean}
      err.auth = true
      throw err
    }
    throw new Error(msg)
  }
  return data as T
}

/** 这个错误是「登录失效（401）」吗 —— 网络不通 / 5xx 都不是 */
export const isAuthError = (e: unknown): boolean =>
  Boolean((e as {auth?: boolean} | null)?.auth)

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

/*
 * 2026-10-04：原来这里的「AI 提示词文档」一整节（列表 / 增删改 / 版本 / 预览）全删了。
 * 用户说「AI 提示词界面没什么用，都要和代码绑定，直接去掉相关逻辑，写死代码」——
 * 提示词现在是 `backend/src/llm/prompts.ts` 里的常量，前端不再碰它。
 */

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
  /** 当前登录用户（用户系统 2026-10-04） */
  user?: {id: number; username: string; isAdmin: boolean}
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

/** 切换模型（写进**当前用户自己的**配置） */
export const switchModel = (model: string) =>
  post<{
    ok: boolean
    model: string
    persisted: boolean
    warning: string | null
  }>('/api/account/model', {model})

/* ---------------- 大模型密钥（多把） ---------------- */

/** 一把密钥的用量（跟 key 绑定，分开统计） */
export interface LlmKeyStats {
  calls: number
  costUsd: number
}

export interface LlmKey {
  id: number
  /** 自己起的名字，如「主力」「备用」 */
  name: string
  /** 脱敏后的 Key（`sk-a****3456`）；真 Key 只在管理员那页给 */
  apiKey: string
  apiKeySet: boolean
  baseUrl: string
  model: string
  reasoningEffort: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
  /** 这把 key 花了多少、调了多少次 */
  stats: LlmKeyStats
}

export interface LlmKeysResult {
  keys: LlmKey[]
  models: {
    current: string
    available: ModelOption[]
    fromApi: boolean
    error: string | null
  } | null
  /** 当前实际生效的那把（分析就用它） */
  defaultId: number | null
}

export interface LlmKeyInput {
  name?: string
  /** 留空 / 传掩码 = 不改 */
  apiKey?: string
  baseUrl?: string
  model?: string
  reasoningEffort?: string
}

export const fetchLlmKeys = () => get<LlmKeysResult>('/api/llm-keys')

export const createLlmKey = (body: LlmKeyInput) =>
  post<{ok: boolean; id: number}>('/api/llm-keys', body)

export const updateLlmKey = (id: number, body: LlmKeyInput) =>
  put<{ok: boolean; id: number}>(`/api/llm-keys/${id}`, body)

export const deleteLlmKey = (id: number) =>
  del<{ok: boolean}>(`/api/llm-keys/${id}`)

export const setDefaultLlmKey = (id: number) =>
  post<{ok: boolean}>(`/api/llm-keys/${id}/default`, {})

/* ---------------- 交易所账户（多套，2026-10-04） ---------------- */

export interface ExchangeCatalogEntry {
  id: string
  label: string
}

export interface ExchangeKey {
  id: number
  /** ccxt 交易所 id，如 binance / okx */
  exchange: string
  name: string
  /** 脱敏后的 API Key（`abcd****wxyz`）；真凭据只在服务端 */
  apiKey: string
  apiKeySet: boolean
  secret: string
  secretSet: boolean
  password: string
  passwordSet: boolean
  /** spot = 现货，swap = 合约 */
  marketType: string
  sandbox: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface ExchangeKeysResult {
  keys: ExchangeKey[]
  /** 下拉里能选的交易所（ccxt id + 中文名） */
  exchanges: ExchangeCatalogEntry[]
  marketTypes: string[]
}

export interface ExchangeKeyInput {
  exchange?: string
  name?: string
  /** 留空 / 传掩码 = 不改 */
  apiKey?: string
  secret?: string
  password?: string
  marketType?: string
  sandbox?: boolean
}

export interface ExchangeBalanceRow {
  currency: string
  free: number
  used: number
  total: number
  /** 折 USDT 的估值；查不到价时是 null */
  usdt: number | null
}

export interface ExchangeOrderRow {
  id: string
  datetime: string | null
  symbol: string
  side: string
  type: string
  price: number
  amount: number
  cost: number
  status: string
  fee: number
  feeCurrency: string
}

/** 当前持仓（合约） */
export interface ExchangePositionRow {
  symbol: string
  /** long / short */
  side: string
  contracts: number
  notional: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number | null
  leverage: number
  unrealizedPnl: number
  percentage: number | null
}

/** 已实现盈亏（币安合约专属） */
export interface ExchangeIncomeRow {
  symbol: string
  income: number
  time: string | null
}

export interface ExchangeAccountResult {
  account: ExchangeKey
  balance: {
    rows: ExchangeBalanceRow[]
    totalUsdt: number
    partial: boolean
    updatedAt: string
  } | null
  /** 当前持仓（现货账户恒为空数组） */
  positions: ExchangePositionRow[] | null
  /** 当前挂单（不需要交易对） */
  openOrders: ExchangeOrderRow[] | null
  /** 历史订单 / 成交（币安这类要交易对） */
  orders: {
    kind: 'orders' | 'trades'
    rows: ExchangeOrderRow[]
    /** 交易所不给无交易对的订单，需要用户指定一个（币安） */
    needSymbol: boolean
    /** 这次实际查了哪些交易对 */
    tried: string[]
  } | null
  /** 已实现盈亏（非币安为 null） */
  income: ExchangeIncomeRow[] | null
  balanceError: string | null
  positionsError: string | null
  openOrdersError: string | null
  ordersError: string | null
  incomeError: string | null
}

export const fetchExchangeKeys = () =>
  get<ExchangeKeysResult>('/api/exchange-keys')

export const createExchangeKey = (body: ExchangeKeyInput) =>
  post<{ok: boolean; id: number; key: ExchangeKey}>('/api/exchange-keys', body)

export const updateExchangeKey = (id: number, body: ExchangeKeyInput) =>
  put<{ok: boolean; id: number; key: ExchangeKey}>(
    `/api/exchange-keys/${id}`,
    body
  )

export const deleteExchangeKey = (id: number) =>
  del<{ok: boolean}>(`/api/exchange-keys/${id}`)

export const setDefaultExchangeKey = (id: number) =>
  post<{ok: boolean}>(`/api/exchange-keys/${id}/default`, {})

/**
 * 查某套账户的余额 + 订单历史（不传 id 用默认那套）。
 * `symbol`：指定查哪个交易对的订单（币安这类必须给）。
 */
export const fetchExchangeAccount = (
  id?: number,
  limit = 50,
  symbol?: string
) =>
  get<ExchangeAccountResult>(
    `/api/exchange/account?${id ? `id=${id}&` : ''}limit=${limit}` +
      (symbol ? `&symbol=${encodeURIComponent(symbol)}` : '')
  )

/** 改自己的用户名（「个人信息」页） */
export const authRename = (username: string) =>
  post<{ok: boolean; user: AuthUser}>('/api/auth/profile', {username})

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

/* ---------------- 头部行情条 ---------------- */

/** 底部涨幅那一行的档位（跟后端 CHANGE_WINDOWS 一一对应） */
export type ChangeWindow = 'd1' | 'd3' | 'd7' | 'm1' | 'm3' | 'y1'

/** 顶部那条行情（价格 / 24h / 标记指数 / 资金费率 / 持仓量 / 多周期涨幅） */
export interface TickerInfo {
  symbol: string
  pair: string
  marketType: string
  last: number | null
  change24h: number | null
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  volume24h: number | null
  quoteVolume24h: number | null
  markPrice: number | null
  indexPrice: number | null
  fundingRate: number | null
  fundingIntervalHours: number | null
  nextFundingAt: number | null
  openInterest: number | null
  openInterestValue: number | null
  changes: Record<ChangeWindow, number | null>
  updatedAt: number
}

/** 拉头部行情（后端有 15 秒缓存，刷勤一点也不会真打交易所） */
export const fetchTicker = (symbol: string, market?: string) => {
  const qs = new URLSearchParams({symbol})
  if (market) qs.set('market', market)
  return get<TickerInfo>(`/api/ticker?${qs}`)
}

/**
 * 订阅 K 线实时推送（SSE）。
 *
 * 上游是币安合约 WS（后端中转，见 `backend/src/data/kline-stream.ts`）；
 * 推来的就是一根 K 线，**正在长的那根也会推**（`timestamp` 跟当前最后一根相同就是同一根在更新）。
 *
 * 断线 / 切后台全交给 `liveSse`（切后台断开、回前台重连、看门狗收僵尸连接），
 * 这里只需把 `onReconnect` 透出去 —— **只重订不补数据的话图上会在中间缺一段**
 * （最后一根虽然在动，前面是空的）。
 *
 * @param onReconnect 断够了时间又连回来时回调（用来重拉 K 线）
 * @returns 取消函数，组件卸载时务必调用
 */
export function klineStream(
  symbol: string,
  timeframe: string,
  onCandle: (c: Candle) => void,
  onReconnect?: () => void
): () => void {
  const qs = new URLSearchParams({symbol, timeframe})
  return liveSse(
    `/api/kline/stream?${qs}`,
    ['kline'],
    (_name, data) => {
      const d = data as {candle?: Candle}
      if (d?.candle) onCandle(d.candle)
    },
    /* 闲置判定给得宽：冷门币可能几十秒没成交，但 20 秒一次的心跳会把它刷新 */
    {idleMs: 75_000, onReconnect}
  )
}

/* ---------------- 合约行情列表 ---------------- */

/** 合约行情列表的一行（列照着币安「合约行情」页来） */
export interface MarketRow {
  base: string
  symbol: string
  pair: string
  last: number | null
  change24hPct: number | null
  high24h: number | null
  low24h: number | null
  volume24h: number | null
  quoteVolume24h: number | null
  /**
   * 全网市值排名（1 = BTC，来源 CoinGecko）。
   * 不在前 500 名的币是 null（界面就只显示成交额）。
   */
  rank?: number | null
}

/**
 * 全部合约的 24h 行情（后端 5 秒缓存，按成交额从大到小）。
 *
 * 币安那边一次请求就是**全量**（740 个合约 ~100KB），所以别刷太勤：
 * 页面上 5 秒一次刚好，跟后端缓存同一档。
 */
export const fetchMarkets = (market?: string) => {
  const qs = new URLSearchParams()
  if (market) qs.set('market', market)
  const q = qs.toString()
  return get<{rows: MarketRow[]; updatedAt: number}>(
    `/api/markets${q ? `?${q}` : ''}`
  )
}

/** 一批行情增量里的一个币（后端把币安的字符串都转成数字了） */
export interface TickerPatch {
  /** 交易所原始交易对（BTCUSDT），拿来跟 `MarketRow.pair` 对上 */
  pair: string
  last: number
  change24hPct: number
  high24h: number
  low24h: number
  volume24h: number
  quoteVolume24h: number
}

/**
 * 订阅**全市场行情**实时推送（SSE）。
 *
 * 上游是币安的 `!ticker@arr`（一条流管所有币，后端中转）：
 * **每秒一批，但每批里只有刚变过的两三百个币**，所以必须先拿一次
 * `fetchMarkets()` 当底稿，再拿增量按 `pair` 往里盖。
 *
 * 断线 / 切后台全交给 `liveSse`；`onReconnect` 是「断够了时间又连回来了」的回调 ——
 * 中间漏掉的增量不追了，**直接重拉一次整表**最省事（一张表 ~100KB，不是增量）。
 *
 * @returns 取消函数，组件卸载时务必调用
 */
export function tickerStream(
  onBatch: (updates: TickerPatch[]) => void,
  onReconnect?: () => void
): () => void {
  return liveSse(
    '/api/tickers/stream',
    ['ticker'],
    (_name, data) => {
      const d = data as {updates?: TickerPatch[]}
      if (d?.updates?.length) onBatch(d.updates)
    },
    /* 这条流每秒都有数据，30 秒没动静基本可以确定是死了 */
    {idleMs: 30_000, onReconnect}
  )
}

/**
 * 币种图标（后端代理几套公开图标集 + 按顺序兜底，顺带缓存）。
 *
 * 走我们自己的域名：图标源在国内不一定连得上，自己的域名一定连得上。
 * 拿不到会 404，组件那边退回首字母的圆形占位。
 *
 * ⚠️ `?v=2` 是**刻意加的缓存破解**：后端 2026-10-03 换过图标源
 * （老的 spothq 那套只覆盖 16%，新币基本全缺），而旧的 404 响应在浏览器里
 * 缓存了 **一天**（`max-age=86400`）。不加这个参数，已经打开过页面的用户
 * 这一天里看到的还是首字母占位。换源/改图标逻辑时**把这个数字 +1**。
 */
export const ICON_VERSION = 2

export const iconUrl = (base: string): string =>
  apiUrl(
    `/api/icon/${encodeURIComponent(base.trim().toLowerCase())}?v=${ICON_VERSION}`
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
  /** 形状标签，按概率从高到低（最多 2 个；池子里没有的会新造） */
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
  const es = openSse(url)
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
    sr: {
      timeframe: string
      bars: number
      resistance: number
      support: number
    }[]
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

  const es = openSse('/api/knowledge/stream?' + qs.toString())
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
  /** 用的哪把密钥（名字；没绑定 / 已删就是 null） */
  keyName: string | null
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
  /** 按**密钥**分开的统计（`key` 就是 llm_key_id） */
  byKey: UsageBucket[]
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
  /** 只看某把密钥（llm_key_id）；不传 / 0 = 全部 */
  keyId?: number | null
}

function usageQs(q: UsageQuery, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams({days: String(q.days)})
  if (q.kind) p.set('kind', q.kind)
  if (q.keyId) p.set('keyId', String(q.keyId))
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

/* ---------------- 下载 ---------------- */

export interface DownloadApp {
  name?: string
  packageId?: string
  desc?: string
  require?: string
  sizeHint?: string
  install?: string[]
}

export interface DownloadRelease {
  version: string
  file: string
  /** `/dl/xxx.apk` —— 线上由 Caddy 发，本地由后端发 */
  url: string
  title: string
  date: string
  notes: string[]
  /** 清单里登记过介绍 / 只是磁盘上捡到的 */
  listed: boolean
  /** 字节数 */
  size: number
  mtime: number
  md5: string | null
  deprecated: boolean
  /** 版本号最大的那个（且没被标 deprecated） */
  latest: boolean
}

export interface DownloadsResult {
  app: DownloadApp
  releases: DownloadRelease[]
}

export const fetchDownloads = () => get<DownloadsResult>('/api/downloads')

/**
 * 下载链接 —— 原生壳里页面跑在 `https://localhost`，相对路径 `/dl/x.apk`
 * 会打到 WebView 自己身上，所以必须补上 `API_BASE`。
 */
export const downloadUrl = (url: string): string => apiUrl(url)

/* ---------------- 服务器状态（「我的 → 服务器」） ---------------- */

/** 曲线上的一个点（后端每 5 秒采一个，进程内滚动保留 2 小时） */
export interface ServerSample {
  t: number
  cpu: number
  mem: number
  rss: number
  heap: number
}

/**
 * 服务器 / 进程 / 数据库的实时快照。
 *
 * ⚠️ 跟后端 `backend/src/system.ts` 的 `ServerStatus` 是**同一份结构**，
 *    改一边要同步改另一边。
 */
/**
 * 一组外围服务的监测结果（docker 容器 / 监听端口）。
 *
 * ⚠️ 跟后端 `system.ts` 的 `ServiceGroup` 对应。
 * **拿不到就是 `ok:false` + `error`** —— 页面要照实说「取不到」，
 * 不能当成「都正常」。
 */
export interface ServiceGroup {
  ok: boolean
  error?: string
  items: {name: string; detail: string; status: string; up: boolean}[]
}

export interface ServerStatus {
  now: number
  host: {
    platform: string
    arch: string
    release: string
    hostname: string
    cpuModel: string
    cpuCount: number
    /** 1 / 5 / 15 分钟平均负载 */
    load: [number, number, number]
    uptimeSec: number
    memTotalB: number
    /**
     * 还能用的内存（后端按平台算的口径，**不是** `freemem()`）——
     * 用 `memTotalB - memAvailB` 才是「用了多少」。
     */
    memAvailB: number
    memUsedPct: number
    /** 内存口径来源：`vm_stat` / `MemAvailable` / `freemem` */
    memSource: string
    diskTotalB: number | null
    diskFreeB: number | null
    diskUsedPct: number | null
  }
  proc: {
    pid: number
    nodeVersion: string
    uptimeSec: number
    /** 进程 CPU 使用率（%），按两次采样的差值算 —— 第一个点可以忽略 */
    cpuPct: number
    rssB: number
    heapUsedB: number
    heapTotalB: number
    externalB: number
  }
  db: {
    ok: boolean
    version: string | null
    error?: string
    sizeB: number | null
    connections: number | null
    maxConnections: number | null
    /** 行数；-1 = 这张表不存在 */
    tables: {name: string; rows: number}[]
  }
  /** 外围服务：docker 容器 + 监听端口 */
  services: {
    docker: ServiceGroup
    ports: ServiceGroup
  }
  tookMs: number
  /** 采样历史（长度由 `minutes` 决定）—— 曲线画的就是它 */
  history: ServerSample[]
}

/**
 * 采一次服务器状态。
 *
 * `minutes` 决定 `history` 回多长（后端封顶 120 分钟）。
 */
export const fetchServerStatus = (minutes = 30) =>
  get<ServerStatus>(`/api/server-status?minutes=${minutes}`)
