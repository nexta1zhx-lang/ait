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
  opts: {idleMs?: number; onReconnect?: () => void; onAlive?: () => void} = {}
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
      /* 心跳是「这条流还活着」最可靠的证据（见 `onAlive` 的说明） */
      opts.onAlive?.()
    })

    for (const name of events) {
      cur.addEventListener(name, e => {
        lastAt = Date.now()
        opts.onAlive?.()
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
  /** `PRICE_FILTER.tickSize` —— 价格必须是它的整数倍，也决定价格显示几位小数（见 `digitsForTick`） */
  tickSize?: number
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

/** 曲线上的一个点（一个时间桶） */
export interface CurvePoint {
  /** 桶起点（ISO） */
  t: string
  /** 桶内**最后一条**的净值（折线画它） */
  close: number
  /** 桶内最大（区间带上沿） */
  high: number
  /** 桶内最小（区间带下沿） */
  low: number
}

/**
 * 净资产曲线（M4）。
 *
 * `range` = `1d` / `7d` / `30d` —— 跨度越长后端桶越宽，返回点数始终 ≤ 400。
 * ⚠️ 桶内**不取平均**（见 docs）：平均会把「中间爆过一次仓」这种真实的尖峰抹平。
 */
export const fetchExchangeCurve = (id?: number, range = '1d') =>
  get<{points: CurvePoint[]; range: string; bucketSec: number}>(
    `/api/exchange/history?range=${encodeURIComponent(range)}` +
      (id ? `&id=${id}` : '')
  )

/**
 * 已实现盈亏那种「一条一条」的形状（新版「盈亏」tab 用）。
 * ⚠️ 数据来自**成交账本的 `realized`**，不是交易所的 income 接口（M3 起）。
 */
/**
 * 钱账本的一行 —— **字段名跟后端逐字对齐**（`db/exchange-store.ts` 的 `IncomeRow`）。
 *
 * ⚠️ 别在这里改名字（以前叫 `income` / `time` / `type`）：后端回的是
 *    `amount` / `datetime` / `incomeType`，两边不一致时 `Number(undefined)` 会变成
 *    **`NaN`** —— 界面上「已结」会显示成 `+$0.00`，看着像「没赚没亏」，
 *    其实是真的算错了（2026-10-06 踩过一次）。
 */
export interface ExchangeIncomeRow {
  id: string
  /** 去重键（成交类就是成交号 + 资产，见后端 `incomeDedupeKey`） */
  tradeId: string
  /** `REALIZED_PNL` / `COMMISSION` / `FUNDING_FEE` / `TRANSFER` … */
  incomeType: string
  symbol: string
  asset: string
  /** 正数进钱、负数出钱 */
  amount: number
  datetime: string
  /** 哪套 Key 的（只有「全部」那一格会带） */
  keyName?: string
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

/* ---------------- 交易所资产（新版：只算 USDT 合约 + C2C，2026-10-05） ---------------- */

/**
 * 为什么是这一套（用户定）：**只统计两个钱包，现货不参与**——
 *   · USDT 合约（USDⓈ-M）`fapi/v2/account`
 *   · C2C 钱包（⚠️ 接口里它叫 `Funding`）
 *
 * 数字不是每次现拉，而是**后端落库的快照**：先渲染上一份（毫秒级）、
 * 旧了再后台刷新（stale-while-revalidate），所以界面上永远要显示「几分钟前」。
 * WS 一旦有动静（下单/成交/余额变动），后端会立刻落一条并推过来（`exchangeStream`）。
 */

/** 合约账户里的多资产明细（`fapi/v2/account.assets[]`） */
export interface FuturesAsset {
  asset: string
  /** walletBalance */
  wallet: number
  available: number
  unrealized: number
}

/**
 * 一个仓位。
 * ⚠️ `amount` 就是 ccxt 的 `contracts`（仓量绝对值）—— 故意不叫 contracts，
 *    故意不叫 contracts，它就是快照里的字段（老接口那套 `ExchangePositionRow` 已删）。
 */
export interface FuturesPosition {
  symbol: string
  /** long / short */
  side: string
  amount: number
  notional: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number | null
  leverage: number
  unrealizedPnl: number
  /** ROE %（相对保证金） */
  percentage: number | null
  /**
   * **币安原始符号**（`BTCUSDT`）—— 2026-10-06 改造 P1 加。
   *
   * `symbol` 是 ccxt 统一写法（`BTC/USDT:USDT`，板子和平仓按钮吃这个），
   * K 线叠加 / 下单页按原始符号比对，两拨人不用各自再换一次。
   * 老快照里没有这个字段 ⇒ 用的时候要 `raw ?? symbol`。
   */
  raw?: string
  /**
   * 这条数据是哪套 Key 的 —— **只有「全部」那一格会带上**（前端合并时补的），
   * 单套账户时不带。用来在列表里标出来源（用户 2026-10-05：「其余针对 key 数据加标签」）。
   */
  keyName?: string
  /**
   * 同上，那套 Key 的 id —— 「减仓 / 平仓」要知道拿哪套凭据去下单
   * （用户 2026-10-05：持仓卡片底部加「减仓 / 平仓」）。
   */
  keyId?: number
}

/** 一份快照 —— 后端落库后读回来的那份（见 `docs/EXCHANGE.md`） */
export interface ExchangeOverview {
  /** 这套 Key 的展示信息（脱敏；真凭据只在服务端） */
  account: {
    exchange: string
    name: string
    sandbox: boolean
    marketType: string
  }
  /** 采集时间（ISO）—— 界面拿它算「几分钟前」 */
  takenAt: string
  futures: {
    /** 钱包余额（不含浮盈） */
    wallet: number
    unrealized: number
    /** 保证金余额 = 钱包 + 浮盈（净资产里合约那一半） */
    margin: number
    available: number
    /** 占用 = margin − available（后端推导，接口没直接给） */
    used: number
    /** ⚠️ 普通 U 本位账户**只有 USDT 一行**，别假设有很多币 */
    assets: FuturesAsset[]
    positions: FuturesPosition[]
  }
  /** C2C 钱包；不是币安 / 没接通就是 null */
  c2c: {
    active: boolean
    totalUsdt: number
    assets: {asset: string; balance: number; usdt: number | null}[]
  } | null
  /**
   * 现货钱包里的 **USDT**（只统计这一个币，用户 2026-10-05 定的）；
   * 读不到（老快照 / 没权限）就是 null。
   */
  spot: {usdt: number} | null
  /** 仓位统计（后端算好，前端不重复算） */
  stats: {
    longCount: number
    shortCount: number
    notional: number
    unrealized: number
  }
}

/** 当前挂单（后端 `listOpenOrders`：普通挂单 + **Algo 条件单**，不需要交易对） */
export interface ExchangeOpenOrder {
  id: string
  /** 币安原始符号（`1000BONKUSDT`）——跟合约表里的 symbol 对得上 */
  symbol: string
  side: string
  /** 币安原始订单类型（`LIMIT` / `STOP_MARKET` / `TAKE_PROFIT_MARKET` …） */
  type: string
  /** 币安原始持仓方向（`LONG` / `SHORT` / `BOTH`） */
  posSide: string
  /** 委托价（市价 / 条件单没有 ⇒ `null`） */
  price: number | null
  /** **触发价**（止盈 / 止损才有）——以前这个接口不带它，条件单只能显示成「委托」 */
  stopPrice: number | null
  amount: number
  filled: number
  reduceOnly: boolean
  /** 下单时间（毫秒） */
  time: number
  /** 哪套 Key 的（只有「全部」那一格会带，见 `FuturesPosition.keyName`） */
  keyName?: string
}

/* ---------------- 钱账本（`/fapi/v1/income`） ---------------- */

/** 币安 income 的类型（我们单独统计的那几种） */
export type IncomeType =
  | 'REALIZED_PNL'
  | 'COMMISSION'
  | 'FUNDING_FEE'
  | 'TRANSFER'
  | 'INSURANCE_CLEAR'
  | 'REFERRAL_KICKBACK'
  | 'COMMISSION_REBATE'

/**
 * 盈亏汇总 —— **交易所的口径**。
 *
 * `net` = 已实现 + 手续费 + 资金费 + 其它（币安那两类本来就是负数，**相加**）。
 * ⚠️ 划转（`TRANSFER`）不进 `net`：那是账户之间搬钱，不是赚亏。
 */
export interface ExchangeIncomeTotals {
  realized: number
  /** 手续费（已经是**负数**） */
  commission: number
  /** 资金费（有正有负；对多头多数时候是负的） */
  funding: number
  other: number
  /** 净盈亏 = 上面四个相加 */
  net: number
  count: number
}

/** 读钱账本（**纯本地**，不打交易所；数据由后端定期对账灌进来） */
export const fetchExchangeIncome = (id?: number, days = 7, limit = 200) =>
  get<{
    totals: ExchangeIncomeTotals
    rows: ExchangeIncomeRow[]
    days: number
    error: string | null
  }>(
    `/api/exchange/income?days=${days}&limit=${limit}` + (id ? `&id=${id}` : '')
  )

/* ---------------- 仓位历史（「开仓 → 全平」一笔的那种） ---------------- */

/** 仓位周期里的一笔成交（点开详情看的那份） */
export interface ExchangePositionOrder {
  /** 成交号 */
  id: string
  time: string
  side: 'buy' | 'sell'
  amount: number
  price: number
  fee: number
  /** 这一笔的已实现盈亏（**减仓 / 平仓那几笔才有**） */
  realized: number
  /** 是加仓还是减仓 */
  reduce: boolean
}

/**
 * 一个**仓位周期**：开仓（0 → 有量）到全平（回 0）。
 * 减仓不单独算一笔，它的已实现盈亏归到这一段头上（同时逐笔留在 `orders` 里）。
 */
export interface ExchangePositionCycle {
  symbol: string
  side: 'long' | 'short'
  /** 开仓均价（账本不全时为 `null`） */
  entryPrice: number | null
  /** 平仓均价 */
  exitPrice: number | null
  qty: number
  closedQty: number
  /** 已实现（毛） */
  realized: number
  /** 手续费（正数） */
  fee: number
  /** 净盈亏 = 已实现 − 手续费 —— 列表上显示的就是它 */
  net: number
  openAt: string
  /** 全平时间（`null` = 还没平完） */
  closeAt: string | null
  /** 持仓秒数 */
  holdSec: number
  closed: boolean
  /** 账本不完整（开仓发生在账本覆盖之前） */
  partial: boolean
  orders: ExchangePositionOrder[]
}

/** 仓位历史（**纯本地**读成交账本，不打交易所） */
export const fetchExchangePositionHistory = (id?: number, limit = 50) =>
  get<{
    /** 已全平的（最近平的在最前） */
    cycles: ExchangePositionCycle[]
    /** 还没平完的（最近开仓的在最前） */
    open: ExchangePositionCycle[]
    openCount: number
    /** 账本里最早的成交时间 —— 这个时间点之前的历史没进账本 */
    since: string | null
    error: string | null
  }>(
    `/api/exchange/position-history?limit=${limit}` + (id ? `&id=${id}` : '')
  )

/**
 * 一笔成交 —— 来自**后端账本**（WS 实时落 + 断线后 REST 补），
 * 所以不需要交易对，也不是「点一下查一次」。
 */
export interface ExchangeTrade {
  id: string
  symbol: string
  side: string
  price: number
  amount: number
  cost: number
  fee: number
  feeCurrency: string
  /** 这一笔的已实现盈亏（「盈亏」tab 就是把它按币加起来） */
  realized: number
  datetime: string | null
  /** 哪套 Key 的（只有「全部」那一格会带，见 `FuturesPosition.keyName`） */
  keyName?: string
}

/**
 * `/api/exchange/overview` 与 `/api/exchange/refresh` 的响应。
 *
 * ⚠️ 三种「没数据」都**不算错误**，用 `noSnapshot + reason` 表达：
 *    现货账户（不参与统计）/ 还没填 Key / 一次都还没采过。
 *    前两种 `canRefresh: false`（刷也没用），第三种是 `true`（刷一下就有）。
 */
export interface ExchangeSnapshotResult {
  account: ExchangeKey
  noSnapshot: boolean
  /** 刷一下能不能解决（现货 / 没填 key 就是 false） */
  canRefresh?: boolean
  overview?: ExchangeOverview
  /** 这条快照是谁写的：boot / ws / poll / manual / shutdown … */
  source?: string
  ageSec?: number
  /** 超过 5 分钟（采样间隔）→ 该去 refresh 了 */
  stale?: boolean
  /** 采集时某一侧失败留下的原因（有值 = 这条数据不完整） */
  err?: string | null
  reason?: string
}

/** 读库里**最新一条快照**（毫秒级，不打交易所） */
export const fetchExchangeOverview = (id?: number) =>
  get<ExchangeSnapshotResult>(`/api/exchange/overview${id ? `?id=${id}` : ''}`)

/**
 * 持仓**增量**（SSE 事件 `positions`，2026-10-06 改造 P1/P4）。
 *
 * 只带会随行情变的那几项 —— `wallet` / `assets` / `c2c` / `spot` 那些跟标记价
 * 无关的字段不在这里，前端拿着往**已有快照**上盖就行。
 * 有了它，交易所界面 / K 线叠加 / 下单页看的是**同一份**持仓，同屏不会再出现两个数。
 */
export interface PositionsPatch {
  /** 数据时间（ISO） */
  at: string
  /** 这一份有没有叠过「标记价本地重算」（false = 纯 REST 快照口径） */
  live: boolean
  wallet: number
  unrealized: number
  /** 保证金余额 = 钱包 + 浮盈 */
  margin: number
  stats: {
    longCount: number
    shortCount: number
    notional: number
    unrealized: number
  }
  positions: FuturesPosition[]
}

/**
 * 现在去拉一次 + 落库（用户点 ⟳ / 下拉刷新用）。
 *
 * `auto = true` —— **前端自己兜底**触发的那次（快照旧了 / 流没活着）。
 * 传给后端时它会**只拉这一份快照**，顺手把那几路 RST 对账（成交 / 挂单 / 钱账本）
 * 也全对一遍的「强制补账」留着给**用户主动**那一下（用户：
 * 「不是每次刷新都要请求接口」）。
 */
export const refreshExchangeOverview = (id?: number, auto = false) =>
  post<ExchangeSnapshotResult>(
    `/api/exchange/refresh?${id ? `id=${id}&` : ''}${auto ? 'auto=1' : ''}`,
    {}
  )

/** 读成交账本（WS 实时 + 断线补，**不需要交易对**） */
export const fetchExchangeFills = (id?: number, limit = 60) =>
  get<{fills: ExchangeTrade[]}>(
    `/api/exchange/fills?limit=${limit}${id ? `&id=${id}` : ''}`
  )

/**
 * 当前挂单（**打交易所**，按需查）。
 * 失败时 `openOrders` 是 null、`error` 有原因 —— 别把失败当成「没有挂单」。
 */
export const fetchExchangeOpenOrders = (id?: number) =>
  get<{
    openOrders: ExchangeOpenOrder[] | null
    /**
     * 后端回的是**旧值**（它同时在后台刷新）—— 上层过一秒再问一次。
     * ⚠️ 别把它当「数据有问题」：这是为了让点开的瞬间就有东西看。
     */
    stale?: boolean
    error: string | null
  }>(`/api/exchange/open-orders${id ? `?id=${id}` : ''}`)

/**
 * 订阅「交易所资产」实时推送（SSE）。
 *
 * 事件：
 *   `snapshot` 最新快照 —— 载荷跟 `fetchExchangeOverview` **一模一样**，直接替换
 *   `fill`     新成交 → 插到成交列表最前面（实时下单能当场看见）
 *   `backfill` 后端用 REST 补了一批断线期间的成交 → 重拉一次成交列表
 *   `income`   后端对账了一批钱账本（已实现/手续费/资金费）→ 重拉一次「盈亏」
 *   `orders`   挂单变了（WS 实时 / REST 对账）→ 重读一次挂单（**本地读**，毫秒级）
 *   `health`   **上游用户数据流哑了 / 恢复了** ⇒ 哑了的时候前端得自己 REST 兜底刷
 *              （⚠️ 这条 SSE 自己的心跳一直有，看不出上游死活，只能靠这个事件）
 *   `reject`   这套账户不参与统计（现货 / 没填 Key）→ ⚠️ **上层必须关掉订阅**：
 *              `liveSse` 不知道「这条流永远不会有数据了」，EventSource 会一直重连。
 *
 * 心跳（`heartbeat`）由 `liveSse` 自己吃掉，不会传上来。
 */
export function exchangeStream(
  id: number | undefined,
  on: {
    snapshot?: (r: ExchangeSnapshotResult) => void
    fill?: (t: ExchangeTrade) => void
    backfill?: (added: number) => void
    income?: (added: number) => void
    health?: (deaf: boolean) => void
    /**
     * **挂单变了**（挂上 / 撤了 / 成交 / 过期）→ 重读一次。
     *
     * ★ 2026-10-06：挂单改成**存库**（用户提的「有变动才改，其余存库不就行了」），
     *   所以这条重读是**本地读**（毫秒级、零权重），收到就能直接刷新界面。
     */
    orders?: (reason: string) => void
    reject?: (reason: string) => void
    /** 持仓增量（改造 P1/P4）：常驻流每次刷新持仓都会推 */
    positions?: (p: PositionsPatch) => void
    /**
     * 收到**任何**东西（数据事件或 20 秒一次的心跳）时回调。
     *
     * 用途：这套账户的流还活着 ⇒ 后端的定时采样会自己把快照推过来，
     * 前端就**不必**再自己打交易所兜底（省掉稳态里最大的一路请求）。
     * ⚠️ 心跳**只有这条回调看得到**（`liveSse` 不把它转发给 `onEvent`）。
     */
    alive?: () => void
    /** 断够了时间又连回来 → 重拉底稿（补断线期间漏的） */
    reconnect?: () => void
  }
): () => void {
  return liveSse(
    `/api/exchange/stream${id ? `?id=${id}` : ''}`,
    [
      'snapshot',
      'fill',
      'backfill',
      'reject',
      'positions',
      'income',
      'health',
      'orders'
    ],
    (name, data) => {
      const d = data as Record<string, unknown> | null
      if (name === 'snapshot') on.snapshot?.(data as ExchangeSnapshotResult)
      else if (name === 'fill') on.fill?.(data as ExchangeTrade)
      else if (name === 'backfill') on.backfill?.(Number(d?.added ?? 0))
      else if (name === 'income') on.income?.(Number(d?.added ?? 0))
      else if (name === 'health') on.health?.(d?.deaf === true)
      else if (name === 'orders') on.orders?.(String(d?.reason ?? ''))
      else if (name === 'reject') on.reject?.(String(d?.reason ?? ''))
      else if (name === 'positions') on.positions?.(data as PositionsPatch)
    },
    {onReconnect: on.reconnect, onAlive: on.alive}
  )
}

/* ---------------- 合约下单（K 线页底部那个模块，2026-10-05） ---------------- */

/**
 * ★ 下单有**两种模式**，由 `test` 决定（用户 2026-10-05 追加）：
 *   · `test !== false`（默认）→ 币安测试接口 `/fapi/v1/order/test`：只校验，不真开仓
 *   · `test === false` → `/fapi/v1/order`：**真下单 / 真平仓**（会真扣保证金）
 *   开关在「配置 → 测试下单」里（`settings.ts` 的 `testOrder`）。
 */

/** 合约账户余额（`/fapi/v2/balance`） */
export interface TradeBalance {
  /** 可用余额（能开新仓的那部分） */
  available: number
  wallet: number
  unrealized: number
}

/** 一条持仓 + 它的交易对（「仓位」那一格列出来的那种） */
export interface TradePositionRow extends TradePosition {
  /** 币安原始符号（BTCUSDT） */
  symbol: string
}

/** 当前持仓（`positionRisk` 里那一行） */
export interface TradePosition {
  side: 'long' | 'short'
  /** 持仓量（基础币，绝对值） */
  amount: number
  /** 开仓均价 */
  entryPrice: number
  markPrice: number
  /** 未实现盈亏（USDT） */
  unrealized: number
  /** 名义价值（USDT） */
  notional: number
  /** 这个交易对的杠杆 */
  leverage: number
  /** 强平价（逐仓 / 没持仓时是 `null`）—— 画在 K 线上那条「强平价格」 */
  liquidationPrice: number | null
}

/** 一张挂单（K 线上「仓位委托」那条价格线） */
export interface TradeOpenOrder {
  id: string
  /** 币安原始符号（1000BONKUSDT） */
  symbol: string
  side: 'buy' | 'sell'
  /** 币安原始订单类型（`LIMIT` / `STOP_MARKET` / `TAKE_PROFIT_MARKET` …） */
  type: string
  /** 币安原始持仓方向（`LONG` / `SHORT` / `BOTH`） */
  posSide: string
  /** 委托价（市价 / 条件单没有 ⇒ `null`，**别当 0 画**） */
  price: number | null
  /** 触发价 */
  stopPrice: number | null
  amount: number
  filled: number
  reduceOnly: boolean
  /** 下单时间（毫秒） */
  time: number
}

/** 一笔成交（K 线上那个买卖点） */
export interface TradeFill {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  price: number
  amount: number
  /** 这一笔已实现盈亏（USDT，可能是 `null`） */
  realizedPnl: number | null
  /** 手续费（计价币） */
  fee: number
  /** 成交时间（毫秒） */
  time: number
}

/**
 * 面板初始化那一把：余额 + 杠杆 + 精度。
 *
 * ⚠️ `ready: false` 时**不是错误**：没配 Key / 是现货账户 / 币安那边报错，
 *    原因都在 `reason` 里，面板照常摆出来、只是不能下单。
 */
export interface TradeInfoResult {
  ready: boolean
  account: ExchangeKey
  reason?: string
  /** 币安原始符号（BTCUSDT） */
  symbol?: string
  base?: string
  balance?: TradeBalance
  /** 当前杠杆（读不到是 null） */
  leverage?: number | null
  /** 交易所允许的最大杠杆（读不到是 null） */
  maxLeverage?: number | null
  /** 当前持仓（没持仓 / 读不到是 null） */
  position?: TradePosition | null
  /** 数量小数位（0.001 的步长 → 3） */
  amountPrecision?: number
  pricePrecision?: number
  /** 最小下单量（基础币） */
  minAmount?: number
  /** 最小名义价值（USDT） */
  minCost?: number
  /**
   * 余额没读到的原因（有值 = 可用余额不可信，面板要拦住并把这句摆出来）。
   * ⚠️ 跟 `errors` 不同：`errors` 是杠杆那类「读不到也能下单」的提示。
   */
  balanceError?: string | null
  /** 杠杆 / 最大杠杆没拿到的原因（提示用） */
  errors?: string[]
}

export const fetchTradeInfo = (symbol: string, id?: number) =>
  get<TradeInfoResult>(
    `/api/exchange/trade?symbol=${encodeURIComponent(symbol)}` +
      (id ? `&id=${id}` : '')
  )

/** 调这个交易对的杠杆（`POST /fapi/v1/leverage`） */
export const setTradeLeverage = (symbol: string, leverage: number, id?: number) =>
  post<{ok: boolean; symbol?: string; leverage?: number; error: string | null}>(
    `/api/exchange/trade/leverage${id ? `?id=${id}` : ''}`,
    {symbol, leverage}
  )

export interface OrderInput {
  /** 币安原始符号，如 BTCUSDT */
  symbol: string
  /** long = 买入 / short = 卖出 */
  side: 'long' | 'short'
  type: 'market' | 'limit'
  quantity: number
  /** 限价单 = 委托价；市价单 = 算数量用的参考价（只做最小名义价值的体检） */
  price?: number
  /** 只减仓（平仓用） */
  reduceOnly?: boolean
  /**
   * `true`（或不传）= 测试单，只校验不真开仓；
   * `false` = **真下单**（配置里「测试下单」关掉时才会传）。
   */
  test?: boolean
}

/** 后端复述回来的「实际发出去的参数」 */
export interface OrderParams {
  symbol: string
  side: 'BUY' | 'SELL'
  type: 'MARKET' | 'LIMIT'
  quantity: number
  price?: number
  timeInForce?: string
  positionSide?: 'LONG' | 'SHORT'
  reduceOnly?: boolean
}

/** 一张已经发出去的单：参数 + 走的哪种模式 + 交易所回的号（测试单没有） */
export interface PlacedOrder extends OrderParams {
  /** `true` = 测试单；`false` = **真单** */
  test: boolean
  orderId?: string
  status?: string
}

/** 平仓单：比普通单多一个「平的是哪个方向」 */
export interface CloseOrderParams extends PlacedOrder {
  from: 'long' | 'short'
}

/** 止盈 / 止损单（K 线上拖出来的那张）：参数 + 改单撤掉的旧单号 + 测试单说明 */
export interface PlacedStopOrder extends PlacedOrder {
  canceled?: string
  /** 测试单模式下说明「哪一部分币安没给测」（条件单没有 test 接口） */
  note?: string
}

export const placeOrder = (
  input: OrderInput,
  id?: number,
  test = true
) =>
  post<{ok: boolean; test?: boolean; order?: PlacedOrder; error: string | null}>(
    `/api/exchange/trade/order${id ? `?id=${id}` : ''}`,
    {...input, test}
  )

/**
 * 挂一张**止盈 / 止损**单（用户 2026-10-06：K 线上按住仓位线上下拖 → 确认单 → 发这张）。
 *
 * `key.orderId` 有值 = **改单**（后端先撤旧的再挂新的；测试单模式不会撤）。
 */
export const placeStopOrder = (
  key: {
    symbol: string
    side: 'buy' | 'sell'
    kind: 'profit' | 'stop'
    stopPrice: number
    quantity: number
    posSide?: string
    orderId?: string
  },
  id?: number,
  test = true
) =>
  post<{ok: boolean; test?: boolean; error: string | null} & Partial<PlacedStopOrder>>(
    `/api/exchange/trade/stop-order${id ? `?id=${id}` : ''}`,
    {...key, test}
  )

/**
 * 平仓 / 减仓。
 *
 * · 不传 `target` → **一键平仓**（账户里所有持仓全平）
 * · 只给 `symbol` → 平这个交易对
 * · `symbol + side` → 只平那一条（面板上每一行那颗「平仓」；双向持仓时一个币有两条）
 * · `symbol + side + pct` → **减仓**：只平掉这个仓位的 `pct`%（用户 2026-10-05
 *   「加个按钮减仓 弹窗选择百分比」）
 *
 * `test = false` 时是**真平仓**。
 */
export const closeTradePositions = (
  target?: {symbol?: string; side?: 'long' | 'short'; pct?: number},
  id?: number,
  test = true
) =>
  post<{
    ok: boolean
    test?: boolean
    orders?: CloseOrderParams[]
    error: string | null
  }>(`/api/exchange/trade/close${id ? `?id=${id}` : ''}`, {...(target ?? {}), test})

/** 账户里**所有**持仓（面板「仓位」那一格列的列表） */
export const fetchTradePositions = (id?: number, fresh = false) =>
  get<{ok: boolean; positions?: TradePositionRow[]; error: string | null}>(
    `/api/exchange/trade/positions${id ? `?id=${id}` : ''}` +
      (fresh ? `${id ? '&' : '?'}fresh=1` : '')
  )

/**
 * 某个交易对当前的挂单（K 线上那条「仓位委托」价格线）。
 * `symbol` 传**币安原始符号**（`1000BONKUSDT`）。
 */
export const fetchTradeOpenOrders = (symbol: string, id?: number) =>
  get<{ok: boolean; orders?: TradeOpenOrder[]; error: string | null}>(
    `/api/exchange/trade/open-orders?symbol=${encodeURIComponent(symbol)}` +
      (id ? `&id=${id}` : '')
  )

/** 某个交易对最近的成交（K 线上那些买卖点 = 「订单历史」） */
export const fetchTradeHistory = (symbol: string, id?: number, limit = 100) =>
  get<{ok: boolean; trades?: TradeFill[]; error: string | null}>(
    `/api/exchange/trade/history?symbol=${encodeURIComponent(symbol)}` +
      `&limit=${limit}` +
      (id ? `&id=${id}` : '')
  )

/**
 * 撤一张挂单（**真动作**，没有测试版 —— 撤了就是撤了，调用前自己确认）。
 */
export const cancelTradeOrder = (symbol: string, orderId: string, id?: number) =>
  post<{ok: boolean; orderId?: string; error: string | null}>(
    `/api/exchange/trade/cancel-order${id ? `?id=${id}` : ''}`,
    {symbol, orderId}
  )

/**
 * 清掉「仓位已经没了、单却还挂着」的残留平仓单（**真动作**）。
 *
 * `symbol` 传币安原始符号就只清这一个币，不传就盘点整个合约账户。
 * 只撤 `reduceOnly` 的单（开仓单不碰），持仓读不到时整个不动 —— 见后端
 * `cancelOrphanOrders`。
 */
export const cleanupOrphanOrders = (symbol?: string, id?: number) =>
  post<{
    ok: boolean
    positions?: number
    checked?: number
    cancelled?: {symbol: string; orderId: string; amount: number}[]
    failed?: {symbol: string; orderId: string; error: string}[]
    error: string | null
  }>(
    `/api/exchange/trade/cleanup-orders${id ? `?id=${id}` : ''}` +
      (symbol ? `${id ? '&' : '?'}symbol=${encodeURIComponent(symbol)}` : ''),
    {}
  )

/** 美元 → 人民币汇率（「交易所账户」USDT / CNY 切换用，跟用量页同一个源） */
export const fetchRate = () => get<{usdCny: number}>('/api/rate')

/* ---------------- 万能划转（2026-10-05） ---------------- */

/**
 * 能划的三个钱包。
 * ⚠️ `funding` 就是界面上那块「C2C 钱包」—— 币安接口里它的 `walletName` 实际叫
 *    `Funding`（真正的 C2C 账户不在万能划转里，币安会回 `-1102`）。
 */
export type TransferWallet = 'spot' | 'funding' | 'futures'

/** 某个钱包里 USDT 能划走多少（`/api/exchange/wallet`，实时读不打快照） */
export interface WalletBalance {
  wallet: TransferWallet
  asset: string
  /** 能划走的（现货/资金是 free，合约是 availableBalance） */
  available: number
  /** 钱包总额（含挂单锁定的那部分） */
  total: number
}

/** 这套 Key 的划转权限（`permitsUniversalTransfer` = 币安那个「允许通用划转」） */
export interface TransferPermissions {
  permitsUniversalTransfer: boolean
  enableReading: boolean
  enableFutures: boolean
  enableSpotAndMarginTrading: boolean
}

export interface TransferInput {
  from: TransferWallet
  to: TransferWallet
  amount: number
  asset?: string
}

export interface TransferResult {
  tranId: string
  type: string
  asset: string
  amount: number
  from: TransferWallet
  to: TransferWallet
}

export const fetchWalletBalance = (wallet: TransferWallet, id?: number) =>
  get<{ok: boolean; error: string | null} & Partial<WalletBalance>>(
    `/api/exchange/wallet?wallet=${wallet}${id ? `&id=${id}` : ''}`
  )

export const fetchTransferPermissions = (id?: number) =>
  get<{
    ok: boolean
    permissions?: TransferPermissions
    error: string | null
  }>(`/api/exchange/permissions${id ? `?id=${id}` : ''}`)

/**
 * 划一笔 —— ⚠️ **真钱操作**：币安没有划转的测试接口，调一次就真动钱。
 * 方向只放行「现货 / 资金(C2C) / USDTⓈ合约」之间**六种组合**（见后端注释）。
 */
export const exchangeTransfer = (input: TransferInput, id?: number) =>
  post<{ok: boolean; transfer?: TransferResult; error: string | null}>(
    `/api/exchange/transfer${id ? `?id=${id}` : ''}`,
    input
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
 *
 * ⚠️ **拿不到图标时后端回的是 200 + 一张它现画的首字母圆**（2026-10-05 改的），
 *    不是 404 —— 因为浏览器对 `<img>` 的 404 会在控制台打一行红字，
 *    528 个合约里 122 个没图标，一屏十几行红字（用户：「合约行情页面报错」）。
 *    Edge 那段说明在 `backend/src/server.ts` 的 `letterIcon`。
 *    组件那边 `.ico-letter` 那条退路还留着，只管真的网络错误。
 *
 * ⚠️ `?v=N` 是**刻意加的缓存破解**：
 *    · 2（2026-10-03）：后端换过图标源（老的 spothq 那套只覆盖 16%），
 *      而旧的 404 响应在浏览器里缓存了**一天**，不加参数已打开过页面的用户
 *      那一天里看到的还是首字母占位。
 *    · 3（2026-10-05）：「没图标」从 404 改成 200 + 首字母圆。
 *      不提版本的话，之前缓过 404 的浏览器会接着用那份 404（仍然报错 + 仍然走前端的占位）。
 *    换源 / 改图标逻辑时**把这个数字 +1**。
 */
export const ICON_VERSION = 3

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
