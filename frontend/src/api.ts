/** 所有后端接口的类型与调用 */

import {ref} from 'vue'
import {isNativeShell} from './platform'
import {isForeground, notifyNetworkResume, onForegroundChange} from './live'

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
  /*
   * ⚠️ 换 token（登录 / 登出 / 401）时把长连接**立刻**全关掉：`sharedSse` 有 30 秒
   *    宽限期，不主动关的话上一条会话的连接会多活半分钟（数据虽没人渲染，但没必要留着）。
   */
  if (token !== authToken.value) closeAllStreams()
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

/* ---------------- 代理订阅（梯子）用户 ---------------- */

/**
 * 每人一个独立 UUID + 一条带 BasicAuth 的订阅地址。
 * 订阅地址 / 节点链接都由后端拼好（前端不需要知道 REALITY 那些参数）。
 */
export interface ProxyUser {
  id: number
  name: string
  note: string
  enabled: boolean
  uuid: string
  /** 直接丢给 Clash 的「订阅」栏（用户名密码内嵌在 URL 里） */
  subUrl: string
  /** 单节点 vless:// 链接 */
  nodeUrl: string
  /** 上次成功下发到宿主机的时间；null = 还没成功过 */
  syncedAt: string | null
  createdAt: string
}

export interface ProxyNodeInfo {
  server: string
  port: number
  sni: string
  domain: string
}

export interface ProxyHealth {
  ok: boolean
  error?: string
  xrayActive?: boolean
  subActive?: boolean
  inboundPort?: number
  enabledUsers?: number
}

export const fetchProxyUsers = () =>
  get<{users: ProxyUser[]; node: ProxyNodeInfo; health: ProxyHealth}>(
    '/api/admin/proxy'
  )

export const createProxyUser = (body: {name: string; note?: string}) =>
  post<{ok: boolean; user: ProxyUser}>('/api/admin/proxy', body)

export const setProxyUserEnabled = (id: number, enabled: boolean) =>
  post<{ok: boolean; user: ProxyUser; health: ProxyHealth}>(
    `/api/admin/proxy/${id}/enabled`,
    {enabled}
  )

export const setProxyUserNote = (id: number, note: string) =>
  patchReq<{ok: boolean; user: ProxyUser}>(`/api/admin/proxy/${id}`, {note})

/** 换订阅密码：订阅地址跟着变，客户端要重新拉一次 */
export const rotateProxyPassword = (id: number) =>
  post<{ok: boolean; user: ProxyUser}>(`/api/admin/proxy/${id}/password`, {})

/** 换节点 UUID：旧节点链接立刻作废 */
export const rotateProxyUuid = (id: number) =>
  post<{ok: boolean; user: ProxyUser}>(`/api/admin/proxy/${id}/uuid`, {})

export const deleteProxyUser = (id: number) =>
  del<{ok: boolean; users: ProxyUser[]; health: ProxyHealth}>(
    `/api/admin/proxy/${id}`
  )

/** 手动重新下发（宿主机掉线过、或状态对不上时点一下） */
export const syncProxyUsers = () =>
  post<{ok: boolean; error?: string; users: ProxyUser[]; health: ProxyHealth}>(
    '/api/admin/proxy/sync',
    {}
  )

/** 二维码：`what=sub` 是订阅地址，其余是单节点链接 */
export const proxyQr = (id: number, what: 'sub' | 'node') =>
  get<{what: 'sub' | 'node'; dataUrl: string}>(
    `/api/admin/proxy/${id}/qr?what=${what}`
  )

/* ---------------- 远程桌面（RustDesk） ---------------- */

export interface RustDeskDevice {
  /** RustDesk 的设备 ID（客户端上显示的那串数字） */
  id: string
  /** 我们自己起的别名（存在应用库里，服务端没有这个概念） */
  note: string
  createdAt: string | null
  ip: string | null
  lastSeenAt: string | null
  /** 最近 24 小时上线过几次 —— 比单纯的「在线/离线」诚实 */
  events24h: number
}

export interface RustDeskEndpoint {
  ip: string
  port: number
}

export type RustDeskActivity =
  | {kind: 'online'; at: string; deviceId: string; ip: string | null}
  | {
      kind: 'relay'
      at: string
      id: string
      from: RustDeskEndpoint | null
      to: RustDeskEndpoint | null
      closedAt: string | null
      seconds: number | null
    }

export interface RustDeskPort {
  port: number
  proto: string
  what: string
}

export interface RustDeskServerInfo {
  idServer: string
  /** 客户端要填的那个 key */
  key: string | null
  webClient: string
  diagUrl: string
  ports: RustDeskPort[]
  dbPath: string
  /** 日志回看窗口（例如 `72h`）——「最后活动」最早只能追到这里 */
  logSince: string
}

export interface RustDeskHealth {
  ok: boolean
  error?: string
  hbbs?: boolean
  hbbr?: boolean
  peers?: number
  sessions?: number
}

export interface RustDeskSnapshot {
  /** 给新设备用的那一堆参数（agent 连不上时为 null） */
  server: RustDeskServerInfo | null
  devices: RustDeskDevice[]
  activity: RustDeskActivity[]
  health: RustDeskHealth
}

export const fetchRustDesk = () => get<RustDeskSnapshot>('/api/admin/rustdesk')

/** 存别名 —— 只写应用库，不碰宿主机（那个 agent 是只读的） */
export const setRustDeskNote = (id: string, note: string) =>
  patchReq<{ok: boolean}>(`/api/admin/rustdesk/${id}`, {note})

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

/* ---------------- 黑名单（每用户，2026-10-10） ---------------- */

/**
 * 锁着的币 + 各自解锁时刻（用户 2026-10-10：「加入黑名单后 24 小时不得开单」→ 2026-10-17 改 8 小时）。
 *
 * ⚠️ 只有**读**和**锁**，没有「解锁」：这是给自己上锁用的，到期自动失效
 *    （留个解锁按钮就等于没锁）。`hours` 是后端定的时长（24）。
 */
export const fetchBlacklist = () =>
  get<{entries: {base: string; until: string}[]; hours: number}>('/api/blacklist')

/** 把一个币关进去；回来的是**锁完之后的完整列表**（跟前端那份对齐） */
export const lockBase = (base: string) =>
  post<{
    entries: {base: string; until: string}[]
    hours: number
    /** 本来就在锁里（没续期） */
    already: boolean
    /** 这一条的解锁时刻 */
    until: string
    error: string | null
  }>('/api/blacklist', {base})

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
 * ⚠️ 直接调它的都是「长期订阅」，而长期订阅请走下面的 `sharedSse`（带宽限复用，
 *    切页来回不再重连）—— 这里只负责**一条连接**的生命周期。
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
): {stop: () => void; addEvents: (names: string[]) => void} {
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

    for (const name of events) attach(cur, name)
  }

  /**
   * 给**这条（当前）连接**挂一个具名事件的监听。
   *
   * ⚠️ 抽成函数是因为要支持"**就地加事件**"：同一条 path 被多个组件共用，
   *    而它们要的事件名单不一样（见 `sharedSse`）。原来那种情况会**拆掉连接重建**
   *    —— 重建间隙里的事件就丢了，而 SSE 恰恰是"错过就不再来"的东西。
   */
  const attach = (holder: EventSource, name: string): void => {
    holder.addEventListener(name, e => {
      lastAt = Date.now()
      opts.onAlive?.()
      try {
        onEvent(name, JSON.parse((e as MessageEvent).data))
      } catch {
        /* 一条坏消息不影响后面的 */
      }
    })
  }

  /**
   * 就地补监听（当前连接 + 后续重连都生效）。
   *
   * `events` 是**调用方传进来的那个数组**（`sharedSse` 里就是 `e.events`），
   * 所以往里 push 之后，`connect()` 下次重连时也会自动带上 —— 不用改两处。
   */
  const addEvents = (names: string[]): void => {
    for (const name of names) {
      if (events.includes(name)) continue
      events.push(name)
      if (es) attach(es, name)
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

  return {
    stop: () => {
      stopped = true
      if (watchdog) clearInterval(watchdog)
      watchdog = null
      closeSocket()
      offForeground()
    },
    addEvents
  }
}

/* ==================================================================
 * 长连接的**复用层**（2026-10-06，用户：「切换页面 SSE 会断开重连吗……可以做一个
 * 前端全局的吗」）。
 *
 * 在那之前，5 条流全是「跟着组件走」的：`liveSse` 的取消函数一调就 `close()`，
 * 而调用方全是「组件卸载 / 引用计数到 0 就立刻调」⇒ **切一级 tab 必然断一条、
 * 切回来再新开一条**。断开本身不贵（上游币安 WS 是后端在维持，短暂离开不会断），
 * 贵的是那一轮 `wake()` 补账：打开页面若数据旧了（>60 秒）会补快照 + 成交 + 账本，
 * 来回切几次就是白花花的权重。
 *
 * 所以这里在 `liveSse` 外面包一层：**最后一个人走了先不关，留 `STREAM_GRACE_MS`
 * 宽限**；这期间有人再订同一条 path 就**直接复用**（同一条 HTTP 连接、同一个看门狗，
 * 不会重连、不会触发 `wake`）。
 *
 * ⚠️ 为什么不干脆做成「登录后一直连着」的全局常连：后端有两处优化**正是靠
 *    「有没有人在订阅」判断的** ——
 *      · 「没人看就不补展示字段」（省那 25 权重快照，§29）；
 *      · 沉睡档的判据里明确有「没人订阅」（空转 + 空仓 + 连着 2 小时没动静才睡，§18）。
 *    常连会让这两处永远为假（每套账户的上游 WS + 每 2 分钟一轮挂单对账就一直跑）。
 *    宽限期只是把这两处**推迟最多 30 秒**，节省基本全保住 —— 这才是划算的那个做法。
 *
 * ⚠️ 复用是**按 path** 的，所以「合约」页和「我的」页订同一个 Key 时会共用同一条连接
 *    （以前是各开各的两条）。事件按订阅者各自关心的名字分发，互不影响。
 * ================================================================== */

/** 最后一个人走了之后，连接还留多久（够来回切一次页） */
const STREAM_GRACE_MS = 30_000
/**
 * 最多允许几条「已经没人听、只是在等宽限到期」的连接。
 *
 * ⚠️ 必须封顶：浏览器对同一个域名（HTTP/1.1）一共只给 **6 条**连接，而 SSE 是
 *    **长期占着不还**的。稳态下本来就有 3~4 条活着（「我的」页 2 套账户 + 全市场行情，
 *    「合约」页还有 K 线），再加上换币时那条 path 各不相同的 K 线流——不封顶的话，
 *    攒够 6 条之后**新的请求会全部排在队列里**永远发不出去
 *    （2026-10-06 实测：页面里的 REST 全部挂住、连新标签页都打不开）。
 *
 * ★ 2026-10-09：**2 → 5**。用户的原话：
 *   「我是两个 tab 页：行情 tab 页和合约开单分析 tab 页，两个来回跳」——
 *   这是他的**主要使用场景**，而那两条页各占一条流（`tickers` + `kline`），
 *   再加上「我的」页那两条账户流，**积压必然超过 2** ⇒ 上限一到就把最老的
 *   **立刻关掉**（`trimLingeringStreams` 不给宽限期）⇒ 切回来只能重连。
 *   线上实测（用户来回切的那一分钟）：**13 次 SSE 重连**，每次重连还会带出
 *   一整轮 `wake()` 补账。
 *
 *   为什么现在敢放大：**线上是 HTTP/2**。Caddy 的接入日志里 App 的请求
 *   `"proto": "HTTP/2.0"`，HTTP/2 是**多路复用**的，那条「同域 6 条连接」
 *   的硬上限根本不存在（Caddy 前面还有 h2；我们没走 HTTP/1.1）。
 *   留一个上限只是防「某种环境下真退回 HTTP/1.1」时把连接占满 ——
 *   5 条加上活跃的那几条，离 6 还有余量，同时足够覆盖「来回切两个 tab」。
 */
const STREAM_MAX_LINGER = 5
/** `liveSse` 的默认闲置判定（没人传 `idleMs` 时用它） */
const STREAM_IDLE_MS = 75_000

interface StreamSub {
  /** 这条流要转发哪些具名事件 */
  events: string[]
  onEvent: (name: string, data: unknown) => void
  onReconnect?: () => void
  onAlive?: () => void
}

interface SharedStream {
  path: string
  events: string[]
  idleMs: number
  subs: Set<StreamSub>
  stop: () => void
  /** 宽限倒计时（有人回来就清掉） */
  timer: ReturnType<typeof setTimeout> | null
  /** 建立顺序 —— 挑最老的僵尸连接来关 */
  seq: number
}

const sharedStreams = new Map<string, SharedStream>()
let streamSeq = 0

/** 真关掉（复用层内部用；外面看到的是宽限之后的关闭） */
function dropStream(e: SharedStream): void {
  if (e.timer) clearTimeout(e.timer)
  e.timer = null
  sharedStreams.delete(e.path)
  e.stop()
}

/** 僵尸连接太多时，先把最老的关掉 */
function trimLingeringStreams(): void {
  const idle = [...sharedStreams.values()]
    .filter(e => !e.subs.size)
    .sort((a, b) => a.seq - b.seq)
  while (idle.length > STREAM_MAX_LINGER) dropStream(idle.shift()!)
}

function spawnStream(path: string, events: string[], idleMs: number): SharedStream {
  const e: SharedStream = {
    path,
    events: [...events],
    idleMs,
    subs: new Set(),
    stop: () => undefined,
    timer: null,
    seq: ++streamSeq
  }
  const conn = liveSse(
    path,
    e.events,
    (name, data) => {
      /*
       * ⚠️ 先复制一份再遍历：回调里完全可能有人 `unsubscribe`（比如收到 `reject`
       *    就把自己绑的那套账户退了），直接在 Set 上迭代会漏掉后面的订阅者。
       */
      for (const s of [...e.subs]) {
        if (!s.events.includes(name)) continue
        try {
          s.onEvent(name, data)
        } catch {
          /* 一个订阅者出错不能影响别人 */
        }
      }
    },
    {
      /* 断线是**这条连接**的事 ⇒ 广播给所有订阅者（各自决定补什么底稿） */
      onReconnect: () => {
        for (const s of [...e.subs]) s.onReconnect?.()
      },
      onAlive: () => {
        for (const s of [...e.subs]) s.onAlive?.()
      },
      idleMs
    }
  )
  e.stop = conn.stop
  e.addEvents = conn.addEvents
  return e
}

/**
 * 订阅一条长连接（**带宽限复用**）。语义跟 `liveSse` 一样，返回取消函数。
 *
 * 同一个 path 被多个消费者订时只有一条连接，每个订阅者的回调都会收到（按各自
 * `events` 过滤）；选项（`idleMs`）取**最严**的那个，不一致时重建一次。
 */
function sharedSse(
  path: string,
  events: string[],
  sub: StreamSub,
  idleMs = STREAM_IDLE_MS
): () => void {
  const live = sharedStreams.get(path)
  let e: SharedStream
  const merged = live
    ? [...live.events, ...events.filter(n => !live.events.includes(n))]
    : [...events]
  /*
   * 复用条件：事件名单够用 **且** 闲置判定不比它宽（更宽会被看门狗误判成活/死）。
   * 不满足就带着老订阅者一起重建 —— 一条消息都别丢。
   * （现有调用方每条 path 的事件名单都是固定的，重建这条路基本走不到，留着防以后。）
   */
  /*
   * ★ 复用优先，缺事件就**就地补**（2026-10-08 改）。
   *
   * 原来这里只在「新名单是老名单的**子集**」时才复用，否则 `dropStream(live)` **拆掉重建**。
   * 现在：名单不够就地 `addEvents`（给当前连接加监听，重连后也自动带上），
   * **连接一条都不拆**。只有 `idleMs` 更宽（看门狗口径不一致）时才重建 —— 那种情况
   * 现有调用方走不到（每条 path 的 idleMs 是固定的）。
   *
   * ⚠️ **别把这一条当成「三格不实时」的原因**（我一开始就是这么误判的，后来对着代码和
   *    线上日志推翻了）：`/api/exchange/stream` 的三个订阅者
   *    （`positions.ts` / `trade-overlay.ts` / 交易所账户那一格）传的**是同一个常量
   *    `EXCHANGE_EVENTS`**（`exchangeStream()` 里写死的那一份），三条路的事件名单**完全相同**
   *    ⇒ 上面那个条件恒成立 ⇒ **这条 path 本来就不会重建**。
   *    线上那句 `[exchange/stream] 连接只活了 2xxx ms 就被收尾` 也不是它 ——
   *    那是我自己刷页面时"最后一个订阅者走了、`STREAM_GRACE_MS` 到了"的正常收尾
   *    （我另挂一条探针实测过：0s open、20s / 40s 心跳，一直稳）。
   *    真正的成因见 `docs/EXCHANGE.md` §57.2：周期范围的 `to` 冻在挂载那一刻
   *    （`ExchangeAccountLivePanel.rangeOf`）+ 下单时页面上没有订阅者（`观察者 0`）。
   *
   * 那为什么还改：这是个**真存在的坑**，只是现在没人踩 —— 以后任何一条 path 若出现
   *   「小名单先订、大名单后订」，就会拆连接，而**重建的间隙里事件全丢**
   *   （SSE 是"错过就不再来"的）。就地补监听把这条路彻底堵死，成本是零。
   */
  if (live && idleMs >= live.idleMs) {
    e = live
    /* 还在宽限里 ⇒ 撤销关闭，这条连接就活了 */
    if (e.timer) {
      clearTimeout(e.timer)
      e.timer = null
    }
    const missing = merged.filter(n => !e.events.includes(n))
    if (missing.length) e.addEvents(missing)
  } else {
    const old = live ? {subs: [...live.subs], idleMs: live.idleMs} : null
    if (live) dropStream(live)
    e = spawnStream(path, merged, Math.min(idleMs, old?.idleMs ?? idleMs))
    if (old) for (const s of old.subs) e.subs.add(s)
    sharedStreams.set(path, e)
  }
  e.subs.add(sub)
  trimLingeringStreams()

  return () => {
    if (!e.subs.delete(sub)) return
    if (e.subs.size) return
    /* 最后一个人走了：**先不关** —— 这 30 秒里有人切回来就直接复用 */
    e.timer = setTimeout(() => dropStream(e), STREAM_GRACE_MS)
  }
}

/**
 * 把所有长连接**立刻**全关（不等宽限）—— 登出 / 换 token 时用。
 *
 * ⚠️ 不关的话，登出之后那条连接最多还会多活 30 秒（数据虽然没人渲染，但没必要留着）。
 */
export function closeAllStreams(): void {
  for (const e of [...sharedStreams.values()]) dropStream(e)
}

/* ------------------------------------------------------------------ */
/* 网络自愈：超时 · 重试 · 恢复探活                                     */
/* ------------------------------------------------------------------ */

/**
 * 单次请求的超时（毫秒）。
 *
 * ⚠️ **必须有**：`fetch()` 在浏览器 / WebView 里**没有默认超时**。链路被黑洞
 *    （丢包、但**不回 RST**）时，请求会一直挂着 —— 界面既不报错也不刷新，用户
 *    只能杀进程重开。2026-10-14 实测：5G 断约 10 分钟，App 整片数据僵死，
 *    「大退」才恢复。
 *
 * 12 秒是折中：`/api/exchange/trade/*` 要现问交易所，正常也可能几秒；线上实测
 * 3 小时内只有 1 个非流式请求超过 5 秒。个别接口想放宽就自己传 `timeoutMs`
 * （传 0 = 不限时，等于老行为）。
 */
const REQ_TIMEOUT_MS = 12_000

/** 幂等读取（GET）失败后最多再试几次。写操作**永不重试**，理由见 `req`。 */
const REQ_RETRY_MAX = 2

/** 重试退避（毫秒） */
const REQ_RETRY_BACKOFF_MS = [600, 1_500]

/** 出故障后探活的间隔 / 一轮探活最长持续多久 */
const PROBE_INTERVAL_MS = 5_000
const PROBE_MAX_MS = 15 * 60_000

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * 网络层错误（连不上 / 超时 / 中途断了）。
 *
 * 刻意跟 HTTP 错误（4xx / 5xx）分开：**只有这一类值得重试** —— HTTP 错误是
 * 服务器明确答复过的，重试还是同一个结果。
 */
class NetworkError extends Error {
  constructor(
    message: string,
    /** 调用方主动取消（自己传了 signal）时不该重试 */
    readonly retryable = true
  ) {
    super(message)
  }
}

/**
 * 发一次请求并读完 body，**超时覆盖「建连 + 收完」全过程**。
 *
 * ⚠️ 只给 `fetch()` 加超时是不够的：`fetch` 拿到响应头就 resolve 了，后面
 *    `res.json()` 还要继续收 body —— 链路半死时卡住的正是这一步。
 */
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  /** 探活自己发的请求传 `false`：失败是预期的，别去触发新一轮探活 */
  note = true
): Promise<{res: Response; data: unknown}> {
  const ac = timeoutMs > 0 ? new AbortController() : null
  const outer = init.signal
  const relay = (): void => ac?.abort()
  if (ac && outer) {
    if (outer.aborted) ac.abort()
    else outer.addEventListener('abort', relay, {once: true})
  }
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, ac ? {...init, signal: ac.signal} : init)
    let data: unknown = null
    try {
      data = await res.json()
    } catch (e) {
      // 解析失败 = 真的不是 JSON（有的接口本来就没 body）；
      // 但**被超时中断**不是解析失败，得往上抛，否则会被当成「成功但空」
      if (ac?.signal.aborted) throw e
    }
    return {res, data}
  } catch {
    if (note) noteTrouble()
    throw new NetworkError(
      outer?.aborted ? '请求已取消' : '网络不通（超时或连接中断）',
      !outer?.aborted
    )
  } finally {
    if (timer) clearTimeout(timer)
    outer?.removeEventListener('abort', relay)
  }
}

/*
 * ---- 「链路恢复」探活 ----
 *
 * 不能只靠 `window` 的 `online` 事件：断的往往只是**路径**（丢包不回 RST），
 * 接口一直连着、系统始终认为有网，`online` 永远不触发 —— 2026-10-14 那次 5G
 * 就是这样。所以只能自己戳：一旦有请求因为网络挂了，就周期性请求
 * `/api/health`；通了就广播 `notifyNetworkResume()`，让各页面把数据重拉一遍。
 */

/** 有请求因为网络挂了 —— 0 = 当前没故障 */
let troubleSince = 0

/** 探活循环在跑吗（防重入） */
let probing = false

function noteTrouble(): void {
  if (!troubleSince) troubleSince = Date.now()
  if (!probing) void probeUntilOnline()
}

async function probeUntilOnline(): Promise<void> {
  probing = true
  // 截止时间**进循环前**算定：否则每次失败都会把窗口往后推，永远出不来
  const deadline = Date.now() + PROBE_MAX_MS
  try {
    while (troubleSince && Date.now() <= deadline) {
      await sleep(PROBE_INTERVAL_MS)
      // 后台不戳（省电 / 省流量）：回前台时各页面本来就会补一次数据
      if (!isForeground()) continue
      let ok = false
      try {
        const {res} = await fetchJson(apiUrl('/api/health'), {}, 3_000, false)
        ok = res.ok
      } catch {
        /* 还不通，接着等 */
      }
      if (ok) {
        troubleSince = 0
        notifyNetworkResume()
      }
    }
  } finally {
    probing = false
    // 探满一轮还没通：清掉标记收工；下次再有请求失败会重新开一轮（= 一直自愈）
    if (troubleSince && Date.now() > deadline) troubleSince = 0
  }
}

async function req<T>(
  url: string,
  init?: RequestInit,
  opts: {timeoutMs?: number} = {}
): Promise<T> {
  // 带上登录态（公开接口带了也无害）
  const headers = new Headers(init?.headers)
  if (authToken.value) headers.set('Authorization', `Bearer ${authToken.value}`)
  const timeoutMs = opts.timeoutMs ?? REQ_TIMEOUT_MS
  const method = (init?.method ?? 'GET').toUpperCase()
  /*
   * ⚠️ **只有 GET 重试**。POST / PUT / PATCH / DELETE 一律一次到底 —— 下单、
   *    平仓、改杠杆重试一次就是**重复的真操作**，宁可让用户看到错误自己决定。
   *    （超时对两者都生效：超时 ≠ 重试。）
   */
  const attempts = method === 'GET' ? REQ_RETRY_MAX + 1 : 1

  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(
        REQ_RETRY_BACKOFF_MS[
          Math.min(attempt - 1, REQ_RETRY_BACKOFF_MS.length - 1)
        ]
      )
    }
    try {
      const {res, data} = await fetchJson(
        apiUrl(url),
        {...init, headers},
        timeoutMs
      )
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
        // 服务器明确答复过（4xx / 5xx）：重试也是同样的结果，直接抛
        throw new Error(msg)
      }
      return data as T
    } catch (e) {
      // 只有网络层错误才重试；HTTP 错误（含 401）立刻上抛
      if (!(e instanceof NetworkError) || !e.retryable) throw e
      lastError = e
    }
  }
  throw lastError ?? new Error('请求失败')
}

/** 这个错误是「登录失效（401）」吗 —— 网络不通 / 5xx 都不是 */
export const isAuthError = (e: unknown): boolean =>
  Boolean((e as {auth?: boolean} | null)?.auth)

const get = <T>(url: string, opts?: {timeoutMs?: number}) =>
  req<T>(url, undefined, opts)

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
 * 2026-10-04：这里的「AI 提示词文档」一节曾经删过（当时提示词写死在代码里）。
 * ★ 2026-10-10 又搬回来了：提示词重新放回数据库（`ai_docs`，kind=predict），
 *   在「我的 → AI 提示词」里改，即改即生效。
 */

/* ---------------- AI 提示词文档（存数据库） ---------------- */

/**
 * predict = 开单分析用的那份（唯一一条链路）；
 * extract = 知识库提炼；
 * role / rule = 旧版留下的，不再参与分析。
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

/** 语气预设（后端 `llm/tone-presets.ts` 定义，这里只用来渲染「新建」下拉） */
export interface TonePreset {
  id: string
  label: string
  hint: string
  name: string
  output: string
}

export const fetchAiDocs = () =>
  get<{docs: AiDoc[]; tones: TonePreset[]; assembly: AiAssembly}>('/api/ai-docs')

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
  /** 最多能绑几套（后端说了算，别在前端写死） */
  max?: number
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

/**
 * 拖拽排序：传**拖完之后的完整顺序**（用户 2026-10-10）。
 * 落库之后，各页的账户 tab（交易所账户 / 账户统计 / 配置里选下单账户）都按它排。
 */
export const reorderExchangeKeys = (ids: number[]) =>
  post<{ok: boolean}>('/api/exchange-keys/order', {ids})

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
  /** 维持保证金（USDT）—— 2026-10-06 加，账户级「MM 保证金率」的分子 */
  maintMargin?: number
  /** 维持保证金率（0.004 = 0.4%），前端按它随标记价重算 */
  mmr?: number
  /** 账本侧信息（开仓时间 / 已实现盈利）—— 常驻流每次推送都带，见 `PositionMeta` */
  meta?: PositionMeta | null
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
  /**
   * **合约那一半最后一帧推送**的时间（ISO；没推送过就没有）。
   *
   * ⚠️ 必须跟 `takenAt` 分开：`takenAt` 是「整份快照」（现货 / C2C / 可用余额 /
   *    资产明细）的时间，而钱包余额 / 持仓 / 浮盈是币安推送来的（秒级、0 权重）——
   *    两个时间戳混成一个标签，界面就会替 C2C / 现货报喜。
   */
  liveAt?: string
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
  /**
   * 哪套 Key 的 id —— 面板取数时**按账户贴上去**的（后端那份载荷里没有）。
   * 「全部撤单」要撤的每一张都得知道自己归谁（一条请求里可能混着两套账户）。
   */
  keyId?: number
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
/**
 * 账本三格（仓位历史 / 成交历史 / 资金动向）共用的**筛选条件**。
 *
 * `from` / `to` 是**毫秒时间戳含端点** —— 时区在前端算好（「今天」= 北京时间今天 0 点到现在），
 * 后端只当两个毫秒数用（见 `server.ts` 的 `ledgerRange`）。
 */
export interface LedgerQuery {
  from?: number | null
  to?: number | null
  /** 只看这几种 `income_type`（资金动向我们自己那本账的类型） */
  types?: string[] | null
}

/** 拼成 query string（空值一律不拼，后端按「不限」处理） */
function ledgerQs(q: LedgerQuery = {}): string {
  const parts: string[] = []
  if (q.from) parts.push(`from=${Math.round(q.from)}`)
  if (q.to) parts.push(`to=${Math.round(q.to)}`)
  if (q.types?.length) parts.push(`types=${encodeURIComponent(q.types.join(','))}`)
  return parts.join('&')
}

export const fetchExchangeIncome = (id?: number, days = 7, limit = 200, q: LedgerQuery = {}) =>
  get<{
    totals: ExchangeIncomeTotals
    rows: ExchangeIncomeRow[]
    days: number
    error: string | null
  }>(
    `/api/exchange/income?days=${days}&limit=${limit}` +
      (ledgerQs(q) ? `&${ledgerQs(q)}` : '') +
      (id ? `&id=${id}` : '')
  )

export interface ExchangeAnalytics {
  capital: {
    orders: number
    depositsUsdt: number
    withdrawalsUsdt: number
    netUsdt: number
    depositsCny: number
    withdrawalsCny: number
  }
}

export interface PositionStatistics {
  closedCount: number
  wins: number
  losses: number
  breakeven: number
  grossProfit: number
  grossLoss: number
  net: number
  realized: number
  fees: number
  funding: number
  longCount: number
  shortCount: number
  averageHoldSec: number
  breakdown: {
    bySymbol: {key: string; closedCount: number; wins: number; net: number}[]
    byDirection: {key: 'long' | 'short'; closedCount: number; wins: number; net: number}[]
    byHoldDuration: {key: 'short' | 'medium' | 'long'; closedCount: number; wins: number; net: number}[]
    incompleteHoldCount: number
    profitConcentration: {selectedCount: number; totalCount: number; amount: number; sharePct: number}
    lossConcentration: {selectedCount: number; totalCount: number; amount: number; sharePct: number}
    entryReasonAvailable: false
  }
  daily: {date: string; net: number; cumulative: number; count: number}[]
}

export interface C2cOrderInput {
  orderId: string
  side: 'Buy' | 'Sell'
  asset: 'USDT'
  fiat: string
  fiatTotal: number
  price: number
  quantity: number
  timestamp: string
}

export interface C2cHistoryOrder {
  orderId: string
  side: 'Buy' | 'Sell'
  asset: 'USDT'
  fiat: string
  fiatTotal: number
  price: number
  quantity: number
  timestamp: string
}

export interface C2cHistoryPage {
  orders: C2cHistoryOrder[]
  page: number
  pageSize: number
  total: number
}

export interface C2cSyncResult {
  ok: boolean
  from: number
  to: number
  pages: number
  received: number
  inserted: number
  skippedDuplicates: number
}

export const fetchExchangeAnalytics = (q: LedgerQuery = {}, id?: number) =>
  get<{
    account: {id: number; name: string}
    analytics: ExchangeAnalytics
    positions: PositionStatistics
  }>(
    `/api/exchange/analytics?${[
      ledgerQs(q),
      id ? `id=${encodeURIComponent(id)}` : ''
    ].filter(Boolean).join('&')}`
  )

export const fetchC2cOrderHistory = (id: number, page = 1, pageSize = 20) =>
  get<C2cHistoryPage>(
    `/api/exchange/c2c-history?id=${encodeURIComponent(id)}&page=${page}&pageSize=${pageSize}`
  )

export const importC2cOrders = (id: number, orders: C2cOrderInput[]) =>
  post<{
    ok: boolean
    received: number
    inserted: number
    skippedDuplicates: number
  }>('/api/exchange/c2c-import', {id, orders})

export const syncC2cOrders = (id: number) =>
  post<C2cSyncResult>('/api/exchange/c2c-sync', {id})

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
  /**
   * **开仓那一刻的杠杆**（后端 2026-10-13 起从持仓快照抄进账本）。
   * `null` = 没记录（更早的仓位补不回来）⇒ 海报上那颗 `Nx` 药丸不画，别编。
   */
  leverage: number | null
  /** 已实现（毛） */
  realized: number
  /** 手续费（正数） */
  fee: number
  /**
   * 这一段持仓期间的**资金费**（`FUNDING_FEE`，钱账本里那一项）。
   * 符号跟着钱走：**负 = 付出、正 = 收到**。
   */
  funding: number
  /** 净盈亏 = 已实现 − 手续费 **+ 资金费**（资金费带符号）—— 列表上显示的就是它 */
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
export const fetchExchangePositionHistory = (
  id?: number,
  limit = 50,
  q: LedgerQuery = {}
) =>
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
    `/api/exchange/position-history?limit=${limit}` +
      (ledgerQs(q) ? `&${ledgerQs(q)}` : '') +
      (id ? `&id=${id}` : '')
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
 * 带实时持仓、钱包和可用余额；`assets` / `c2c` / `spot` 等完整账户字段仍由快照更新。
 * 前端拿着这份往**已有快照**上盖就行。
 * 有了它，交易所界面 / K 线叠加 / 下单页看的是**同一份**持仓，同屏不会再出现两个数。
 */
export interface PositionsPatch {
  /** 数据时间（ISO） */
  at: string
  /** 这一份有没有叠过「标记价本地重算」（false = 纯 REST 快照口径） */
  live: boolean
  wallet: number
  available: number
  unrealized: number
  /** 保证金余额 = 钱包 + 浮盈 */
  margin: number
  stats: {
    longCount: number
    shortCount: number
    notional: number
    unrealized: number
    /**
     * **Σ 维持保证金**（2026-10-06 加，用户要「MM 合约保证金率」）：
     * 保证金率 = 这个数 ÷ `margin`，**到 100% 就是强平**。
     * 后端随标记价本地重算过 ⇒ 它一秒都在动，不用等 REST 快照。
     */
    maintMargin?: number
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
export const fetchExchangeFills = (
  id?: number,
  limit = 60,
  q: LedgerQuery = {}
) =>
  get<{fills: ExchangeTrade[]}>(
    `/api/exchange/fills?limit=${limit}` +
      (ledgerQs(q) ? `&${ledgerQs(q)}` : '') +
      (id ? `&id=${id}` : '')
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
/** 账户流要转发的具名事件（下面两处要用同一份，提到外面免得写岔） */
const EXCHANGE_EVENTS = [
  'snapshot',
  'fill',
  'backfill',
  'reject',
  'positions',
  'income',
  'health',
  'orders',
  /** 自动止损挂完了（**后台挂**，见 `POST /api/exchange/trade/order` 的 `autoStop`） */
  'auto-stop'
]

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
     * **开仓 / 加仓后的自动止损挂完了**（2026-10-15，用户选的「后台挂」）。
     *
     * 下单响应不等它 —— 挂完从常驻流推这条过来，界面补一句提示。
     */
    autoStop?: (r: AutoStopPush) => void
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
  return sharedSse(
    `/api/exchange/stream${id ? `?id=${id}` : ''}`,
    EXCHANGE_EVENTS,
    {
      events: EXCHANGE_EVENTS,
      onEvent: (name, data) => {
        const d = data as Record<string, unknown> | null
        if (name === 'snapshot') on.snapshot?.(data as ExchangeSnapshotResult)
        else if (name === 'fill') on.fill?.(data as ExchangeTrade)
        else if (name === 'backfill') on.backfill?.(Number(d?.added ?? 0))
        else if (name === 'income') on.income?.(Number(d?.added ?? 0))
        else if (name === 'health') on.health?.(d?.deaf === true)
        else if (name === 'orders') on.orders?.(String(d?.reason ?? ''))
        else if (name === 'reject') on.reject?.(String(d?.reason ?? ''))
        else if (name === 'positions') on.positions?.(data as PositionsPatch)
        else if (name === 'auto-stop') on.autoStop?.(data as AutoStopPush)
      },
      onReconnect: on.reconnect,
      onAlive: on.alive
    }
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
/**
 * 这一段仓位的**账本侧**信息（开仓时间 / 已实现盈利）。
 *
 * 交易所的 `positionRisk` 里没有这两项 ⇒ 后端从本地账本还原，**两路都带**：
 *   · `/api/exchange/trade` 的 `positionMeta`
 *   · 常驻流 `positions` 推送里每条持仓的 `meta`（2026-10-14 加，用户：「我需要全部实时」）
 */
export interface PositionMeta {
  /** 开仓时间（毫秒；账本覆盖不到时是残值 / `null`） */
  openedAt: number | null
  /** 已实现盈亏（毛） */
  realized: number
  /** 净 = 已实现 − 手续费 + 资金费 */
  net: number
  fee: number
  funding: number
  /** 账本覆盖不到这一段（第一笔本身就是平仓）⇒ 上面的数只是残值 */
  partial: boolean
}

export interface TradePositionRow extends TradePosition {
  /** 币安原始符号（BTCUSDT） */
  symbol: string
  /**
   * 常驻流推过来的账本侧信息（开仓时间 / 已实现盈利）。
   * `undefined` = 这份数据没带（REST 兜底那份就没带），消费端要能退回到别处的同项。
   */
  meta?: PositionMeta | null
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
  /**
   * 成交时间（ISO 字符串）—— **老后端的兼容字段**。
   * 2026-10-10 之前这个接口只回 `datetime`，前端却按 `time` 取 ⇒ 图上成交点
   * 全部落到第一根 K 线（时间取不到）。后端已改成回 `time`，这里留着兜底：
   * 万一后端还没重启（新前端配老后端），`time` 缺失时就用它解析。
   */
  datetime?: string | null
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
  /**
   * 持仓的**账本侧**信息（2026-10-14 加，用户：「底下加上已开仓时间，已实现盈利」）。
   *
   * `positionRisk` 里**没有**这两项，后端从本地账本还原（`buildCycles`）：
   *   · `openedAt` —— 这一段仓位的**第一笔成交**时间（毫秒；账本不全时是残值）
   *   · `realized` —— 减仓那几笔的已实现盈亏（毛）；`net` = 扣手续费、加资金费之后
   * 没有持仓 / 账本读不到时是 `null`，面板显示 `—`。
   */
  positionMeta?: PositionMeta | null
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
  /**
   * **开仓 / 加仓成功后自动挂止损**：触发价 = 开仓均价 × (1 ∓ pct%)，数量覆盖全部仓位。
   *
   * 值 = 触发距离（**百分点**，`4` = 4%）。`0` / 不传 = 这次不要。
   * 百分比由前端配置（`settings.ts` 的「开仓自动止损」）带过来，后端不写死。
   * ⚠️ 只在**真单 + 开仓那一侧**生效（减仓单不带）。
   */
  autoStop?: number
}

/**
 * **自动止损挂完了**（从常驻流推过来 —— 后台挂，下单响应不等它）。
 * 字段跟 `AutoStopResult` 一一对应，外加「哪个币」。
 */
export interface AutoStopPush extends AutoStopResult {
  symbol: string
}

/** 自动止损的结果（附在下单响应里 —— 它成功与否都不影响那一单本身） */
export interface AutoStopResult {
  ok: boolean
  /** 没做 / 为什么没做 */
  skipped?: 'disabled' | 'no-position' | 'manual-stop' | 'unchanged'
  price?: number
  quantity?: number
  orderId?: string
  /** 撤掉的旧自动单（加仓时撤旧换新） */
  replaced?: string
  /** 已有**手工**止损时，把它的触发价带回来（前端提示用） */
  existingPrice?: number | null
  error?: string
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
  /**
   * 数量被后端**自动收口**过才有（用户 2026-10-14：顶格差一点保证金时
   * 后端按可用保证金下调一次数量，保证一次开单成功）。
   * 后端 `placeOrder` 的 `MAX_AUTO_SHRINK` 那段。
   */
  adjusted?: {from: number; to: number; reason: string}
}

/** 平仓单：比普通单多一个「平的是哪个方向」 */
export interface CloseOrderParams extends PlacedOrder {
  from: 'long' | 'short'
}

/** 止盈 / 止损单（K 线上拖出来的那张）：参数 + 改单撤掉的旧单号 + 测试单说明 */
export interface PlacedStopOrder extends PlacedOrder {
  canceled?: string
  /**
   * 说明：测试单模式下「哪一部分币安没给测」（条件单没有 test 接口），
   * 以及**类型被校正过**时为什么改。
   */
  note?: string
  /**
   * **实际发出去的类型** —— 可能跟请求的不一样：触发价相对**现价**在哪一侧，
   * 币安只接受那一种（见后端 `legalKind()`，`-2021` 那条）。
   * 提示语要用它，不然会出现「提示说挂的止盈、实际是止损」。
   */
  kind?: 'profit' | 'stop'
}

export const placeOrder = (
  input: OrderInput,
  id?: number,
  test = true
) =>
  post<{
    ok: boolean
    test?: boolean
    order?: PlacedOrder
    /** 自动止损的结果（没开这个功能 / 没触发时是 `null`） */
    autoStop?: AutoStopResult | null
    error: string | null
  }>(`/api/exchange/trade/order${id ? `?id=${id}` : ''}`, {...input, test})

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

/**
 * **常驻流内存里**的实时持仓状态（0 权重、不打交易所）。
 *
 * 回来的是 `state: null` 或一个跟 SSE `positions` 事件**一模一样**的补丁 ——
 * 页面重新激活时先盖这一份，别等下一次标记价推送（最多 3 秒）。
 */
export const fetchExchangeLiveState = (id?: number) =>
  get<{ok: boolean; state: PositionsPatch | null; error: string | null}>(
    `/api/exchange/live-state${id ? `?id=${id}` : ''}`
  )

/** 账户里**所有**持仓（面板「仓位」那一格列的列表） */
export const fetchTradePositions = (id?: number, fresh = false) =>
  get<{
    ok: boolean
    positions?: TradePositionRow[]
    /** 账户级那几个数（算「MM 保证金率」要用）；没有常驻流时是 null */
    wallet?: number | null
    available?: number | null
    unrealized?: number | null
    margin?: number | null
    maintMargin?: number | null
    live?: boolean
    error: string | null
  }>(
    `/api/exchange/trade/positions${id ? `?id=${id}` : ''}` +
      (fresh ? `${id ? '&' : '?'}fresh=1` : '')
  )

/**
 * 某个交易对当前的挂单（K 线上那条「仓位委托」价格线）。
 * `symbol` 传**币安原始符号**（`1000BONKUSDT`）。
 * `stale: true` = 实时没读到、给的是最近一次对账的快照（最多滞后 2 分钟）。
 */
export const fetchTradeOpenOrders = (symbol: string, id?: number) =>
  get<{ok: boolean; orders?: TradeOpenOrder[]; stale?: boolean; error: string | null}>(
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
 * 改一张挂单（用户 2026-10-06：「挂单可以修改」）。
 *
 * 后端按类型分流：**限价单**走交易所的改单接口（单号不变），**止盈 / 止损**
 * （条件单）走撤旧挂新 —— 币安条件单没有改单接口，它自己 App 里的「修改」也是撤+挂。
 * 所以 `price` 的含义跟着类型走：限价单 = **委托价**，条件单 = **触发价**。
 *
 * ⚠️ **真动作，没有测试版** —— 跟撤单一样，点之前先跟人确认一次。
 * ⚠️ `symbol` 传**币安原始符号**（`1000BONKUSDT`）。
 */
export const modifyTradeOrder = (
  key: {symbol: string; orderId: string; price: number; quantity?: number},
  id?: number
) =>
  post<{ok: boolean; error: string | null} & Partial<ModifiedOrder>>(
    `/api/exchange/trade/modify-order${id ? `?id=${id}` : ''}`,
    {...key}
  )

/** 改单的结果（后端 `ModifiedOrder` 的镜像） */
export interface ModifiedOrder {
  symbol: string
  orderId: string
  /** `edit` = 交易所的改单接口；`replace` = 撤旧挂新（条件单只能这样） */
  via: 'edit' | 'replace'
  type: string
  price: number
  quantity: number
  canceled?: string
  kind?: 'profit' | 'stop'
  /** 后端顺手纠正过什么（比如触发价跨过标记价 ⇒ 类型改成止损） */
  note?: string
}

/**
 * 撤一张挂单（**真动作**，没有测试版 —— 撤了就是撤了，调用前自己确认）。
 */
export const cancelTradeOrder = (symbol: string, orderId: string, id?: number) =>
  post<{ok: boolean; orderId?: string; error: string | null}>(
    `/api/exchange/trade/cancel-order${id ? `?id=${id}` : ''}`,
    {symbol, orderId}
  )

/**
 * 一次撤掉一串挂单（「挂单」那一格右上角那颗「全部撤单」）。
 *
 * ⚠️ **真动作，没有测试版** —— 调用前必须二次确认（见
 *    `ExchangeAccountLivePanel.cancelListedOrders`）。
 * ⚠️ 每项各自带 `keyId`：挂单那一格在「全部」时横跨两套账户。
 */
export const cancelTradeOrders = (
  items: {keyId?: number; symbol: string; orderId: string}[]
) =>
  post<{
    ok: boolean
    cancelled: number
    failed: {symbol: string; orderId: string; error: string}[]
    error: string | null
  }>('/api/exchange/trade/cancel-orders', {items})

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

/* ---------------- 账户统计配置（每用户，2026-10-09） ---------------- */

/**
 * 账户统计的配置：收益率基准 + 金额显示单位。
 *
 * 用户 2026-10-09：「在配置里面选择的配置，要保存到个人的后端和个人信息中」——
 * 以前只写 localStorage，换设备就丢。现在存服务端，账户统计页和
 * 「个人信息 → 账户信息」读写的是同一份。
 */
export interface StatsSettings {
  benchmark: number
  currency: 'usd' | 'cny'
}

export const fetchStatsSettings = () =>
  get<{settings: StatsSettings; error: string | null}>('/api/stats-settings')

export const saveStatsSettings = (input: StatsSettings) =>
  put<{settings: StatsSettings; error: string | null}>('/api/stats-settings', input)

/* ---------------- 自动化预测：扫描参数 + 候选币种（2026-10-12） ---------------- */

/**
 * 扫描参数 —— **字段与后端 `db/scan-settings.ts` 的 `ScanParams` 一一对应**，别只改一边。
 *
 * 用户 2026-10-12：「可调参数 改为前端配置 留着」—— 这些数原来写在方案文档里，
 * 现在存库、在「自动化预测」页上改。
 */
export interface ScanParams {
  timeframe: '15m' | '1h' | '4h'
  perRule: number
  maxPicks: number
  minTurnover: number
  minAgeDays: number
  /** **市值排名前 N 不扫**（0 = 不排除）—— 用户 2026-10-12：「市值前 30 不扫」 */
  excludeTopRank: number
  rules: {breakout: boolean; dip: boolean; rally: boolean; volume: boolean}
  breakoutVol: number
  dipPct: number
  dipVol: number
  rallyPct: number
  spikeVol: number
}

/** 一条候选（后端 `scan/rules.ts` 的 `ScanPick`） */
export interface ScanPick {
  base: string
  symbol: string
  rules: string[]
  ruleLabels: string[]
  price: number
  pct24: number
  turnover24: number
  volRatio: number
  vsHigh20: number
  offLow24: number
  rank: number | null
}

/** `/api/scan/picks` 的回应：参数 + 这一轮的结果 */
export interface ScanPicks {
  params: ScanParams
  /** 这一轮看的"现在"（最后一根已收盘 K 线的收盘时刻，ISO） */
  at: string
  timeframe: ScanParams['timeframe']
  /** 参与打分的币数（过了状态 / 新币 / 成交额门槛的） */
  scanned: number
  /** 因为「市值前 N」被排掉的有几个 */
  excludedTop: number
  /** 市值排名没拉到 ⇒「市值前 N 不扫」这条没生效（界面要提示出来） */
  rankMissing: boolean
  /** 各类规则命中的原始个数（去重配额之前） */
  ruleHits: Record<string, number>
  picks: ScanPick[]
  ms: number
  error: string | null
}

export const fetchScanSettings = () =>
  get<{params: ScanParams; error: string | null}>('/api/scan/settings')

export const saveScanSettings = (input: ScanParams) =>
  put<{params: ScanParams; error: string | null}>('/api/scan/settings', input)

/** 跑一轮选币（纯 SQL，不调模型、不花钱） */
export const fetchScanPicks = (at?: number) =>
  get<ScanPicks>(`/api/scan/picks${at ? `?at=${at}` : ''}`)

/* ---------------- K 线画线 + 穿线提醒（2026-10-17） ---------------- */

/**
 * 一条提醒 —— **字段与后端 `db/kline-alerts.ts` 的 `KlineAlert` 一一对应**。
 *
 * 用户 2026-10-17：「点击画的线可以添加超过该线提醒，在自动化预测显示所有的提醒」。
 * `op`：`above` = 涨过这条线，`below` = 跌破这条线。
 */
export interface KlineAlert {
  id: number
  /** 基础币（DOGE）—— 跟 K 线页的 `symbol` 同一个口径 */
  symbol: string
  price: number
  op: 'above' | 'below'
  note: string
  /** active = 还在盯；triggered = 已经响过（可以重新盯） */
  status: 'active' | 'triggered'
  createdAt: string
  triggeredAt: string | null
  /** 响的那一刻是多少价 */
  triggeredPrice: number | null
}

/** 这个币画的线（原样存，形状由 `chart-drawings.ts` 定义） */
export const fetchKlineDrawings = (symbol: string) =>
  get<{symbol: string; items: unknown[]; error: string | null}>(
    `/api/kline/drawings?symbol=${encodeURIComponent(symbol)}`
  )

export const saveKlineDrawings = (symbol: string, items: unknown[]) =>
  put<{symbol: string; count: number; error: string | null}>('/api/kline/drawings', {
    symbol,
    items
  })

export const fetchKlineAlerts = () =>
  get<{alerts: KlineAlert[]; error: string | null}>('/api/kline/alerts')

export const createKlineAlert = (input: {
  symbol: string
  price: number
  op: 'above' | 'below'
  note?: string
}) => post<{alert: KlineAlert; error: string | null}>('/api/kline/alerts', input)

export const deleteKlineAlert = (id: number) =>
  del<{ok: boolean; error: string | null}>(`/api/kline/alerts/${id}`)

/** 响过的再挂回去（还是那条线、那个价，重新等下一穿） */
export const rearmKlineAlert = (id: number) =>
  post<{ok: boolean; error: string | null}>(`/api/kline/alerts/${id}/arm`, {})

/* ---------------- 交易日记（2026-10-18） ---------------- */

/**
 * 日记 —— **字段与后端 `db/journals.ts` 的 `JournalEntry` / `JournalMonth` 一一对应**。
 *
 * 用户 2026-10-18：「日记模块可以加入某些币种，总结」→「是我手动写日记。也不一定是日记，
 * 有可能是一周才写一次。最后，都是按月给我汇总到一起」。
 */
export interface JournalCoin {
  base: string
  /** 这个币在我这篇里的一句话 */
  note: string
}

export interface JournalEntry {
  id: number
  /** `YYYY-MM-DD`（北京时间） */
  day: string
  title: string
  body: string
  coins: JournalCoin[]
  createdAt: string
  updatedAt: string
}

/** 月视图里「一个币」的统计 */
export interface JournalCoinStat {
  base: string
  /** 这个月有几篇提到它 */
  mentions: number
  /** 这个月涨跌幅（%），拿不到是 null */
  pct: number | null
  /** 这个月我在它上面成交几笔 */
  fills: number
  /** 这个月我在它上面的净盈亏（已实现 − 手续费） */
  pnl: number
}

/** 一个月的全部（条目 + 统计 + 月度总结） */
export interface JournalMonth {
  month: string
  entries: JournalEntry[]
  summary: string
  stats: {
    entries: number
    coins: JournalCoinStat[]
    fills: number
    pnl: number
    /** 交易过、但这个月一篇都没写的币（按成交笔数多的在前，页面只露前几个） */
    missing: {base: string; fills: number}[]
    /** 写到了、但这个月没交易过的币 */
    idle: string[]
  }
}

export const fetchJournal = (month: string) =>
  get<JournalMonth & {error: string | null}>(
    `/api/journal?month=${encodeURIComponent(month)}`
  )

/** 有日记的月份（新的在前）*/
export const fetchJournalMonths = () =>
  get<{months: string[]; error: string | null}>('/api/journal/months')

/** 新建 / 更新一条（带 `id` 就是更新）。回来的是这条 + 它所在的那个月的最新全份 */
export const saveJournalEntry = (input: {
  id?: number | null
  day: string
  title?: string
  body?: string
  coins?: JournalCoin[]
}) => post<JournalMonth & {entry: JournalEntry; error: string | null}>('/api/journal/entries', input)

export const deleteJournalEntry = (id: number) =>
  del<{ok: boolean; error: string | null}>(`/api/journal/entries/${id}`)

/** 存月度总结（自己写的那段） */
export const saveJournalSummary = (month: string, summary: string) =>
  put<{ok: boolean; month: string; error: string | null}>('/api/journal/summary', {
    month,
    summary
  })

/** 这个币在历次日记里被怎么说的（跨月反查） */
export const fetchJournalCoin = (base: string) =>
  get<{base: string; entries: JournalEntry[]; error: string | null}>(
    `/api/journal/coin?base=${encodeURIComponent(base)}`
  )

/* ---------------- 持久化分析（2026-10-15） ---------------- */

/**
 * 一条持久化分析会话 —— **字段与后端 `db/persist.ts` 的 `PersistSession` 一一对应**。
 *
 * 用户 2026-10-15：「在 k 线界面顶部加入持久化分析的图标，点击图标弹窗确定要加入持久化分析，
 * 每隔 15 分钟分析一次，最长不超过 8 小时」。
 */
export interface PersistSession {
  id: number
  symbol: string
  ccxtSymbol: string
  timeframe: string
  days: number
  startedAt: string
  endsAt: string
  /** 下一轮什么时候跑（对齐 :00/:15/:30/:45 + 20 秒） */
  nextAt: string
  /** 已经跑了几轮（最多 32） */
  runs: number
  failed: number
  status: 'active' | 'ended'
  endedReason: string | null
  /** 最近一条结论 */
  lastVerdict: 'go' | 'no' | 'wait' | null
  lastLine: string | null
  lastPrice: number | null
  lastAt: string | null
}

/** 时间线里一条：那次结论 + 那一刻的价格 + 之后的涨跌（复盘用） */
export interface PersistTimelineRow {
  id: number
  createdAt: string
  verdict: 'go' | 'no' | 'wait' | null
  line: string
  price: number | null
  /** 那一刻之后 15 分钟 / 1 小时的价格变化（%）；还没到点或取不到是 null */
  after15m: number | null
  after1h: number | null
}

/**
 * 一个周期的节奏（**后端 `db/persist.ts` 的 `CADENCES` 就是真源**，这里只是照着声明）。
 *
 * ★ 2026-10-16 用户：「选择周期要和调用次数匹配」—— 周期同时决定"多久问一次"和"盯多久"。
 */
export interface PersistCadence {
  timeframe: string
  /** 每轮间隔（毫秒） */
  intervalMs: number
  /** 会话最长多久（毫秒） */
  maxMs: number
  /** 最多几轮 */
  maxRuns: number
  /** 人话（「15 分钟」/「1 小时」） */
  label: string
}

export interface PersistLimits {
  /** 同时最多几个会话 */
  maxActive: number
  /** 支持的周期 + 各自的节奏（15m：每 15 分钟 / 8 小时；1h：每小时 / 16 小时） */
  cadences: PersistCadence[]
}

export interface PersistState {
  sessions: (PersistSession & {timeline: PersistTimelineRow[]})[]
  limits: PersistLimits
  error: string | null
}

export const fetchPersist = () => get<PersistState>('/api/persist')

/* ---------------- App 推送（FCM） ---------------- */

/**
 * 把 FCM token 报给后端（2026-10-15 用户：「加入 app 推送」）。
 * 后端存进 `push_tokens`，只在结论**转可做**时用它发通知。
 */
export const postPushToken = (input: {
  token: string
  platform?: string
  device?: string
}) => post<{ok: boolean; error: string | null}>('/api/push/token', input)

/** 推送状态 + 已上报的设备（「我的」那张卡用） */
export interface PushStatus {
  configured: boolean
  detail: string
  devices: {device: string; platform: string; disabled: boolean; lastError: string | null}[]
  error: string | null
}

export const fetchPushStatus = () => get<PushStatus>('/api/push/status')

/** 现在发一条测试推送（不然要等"转可做"，可能等一整天） */
export const testPush = () =>
  post<{sent: number; devices: number; configured: boolean; error: string | null}>(
    '/api/push/test',
    {}
  )

/** 退出登录时注销这一条（不注销的话换账号还会收到上一个人的提醒） */
export const deletePushToken = (token: string) =>
  del<{ok: boolean; error: string | null}>(
    `/api/push/token?token=${encodeURIComponent(token)}`
  )

/**
 * 加入：`symbol` 传基础币（BTC）或行情符号都行，后端会归一。
 *
 * ⚠️ **只有 `15m` / `1h` 两个周期**，而且周期同时决定"多久问一次"和"盯多久"
 *   （见 `PersistCadence`）；`days` 已去掉（后端固定默认值）。
 */
export const startPersist = (input: {
  symbol: string
  market?: string
  timeframe: string
}) => post<{session?: PersistSession; error: string | null}>('/api/persist', input)

export const stopPersist = (id: number) =>
  del<{ok: boolean; error: string | null}>(`/api/persist?id=${id}`)

/** 立刻跑一轮（等它跑完再回来，给人手动试一次用；平时是后台每 15 分钟自己跑） */
export const runPersistNow = (id: number) =>
  post<{ok?: boolean; error: string | null}>(`/api/persist/run?id=${id}`, {})

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

/**
 * 涨幅那一行的档位（跟后端 `CHANGE_WINDOWS` 一一对应）。
 *
 * ⚠️ `d1` = **今日涨跌（UTC 日切：昨收 → 现价）**，跟头部「24h 涨跌」（滚动 24 小时）不是一回事
 *    —— 用户 2026-10-07 拍的就是「两个都留，别显示成同一个数」。
 */
export type ChangeWindow = 'd1' | 'd3' | 'd7' | 'm1' | 'm3' | 'y1'

/**
 * 顶部那条行情（价格 / 24h / 标记指数 / 资金费率 / 持仓量 / 多周期涨幅）。
 *
 * ⚠️ 它只是**首帧底稿**：价格那几项随后由 SSE 的 `ticker` 事件覆盖，
 *    资金费率 / 指数价 / 下次收取时间由 SSE 的 `mark` 事件覆盖（见 `MarkPatch`）。
 *    所以这条 REST 60 秒一发就够了（`ticker.ts` 的 `SLOW_MS`）。
 */
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
  /** 每档的基点（第 N 天前那根 1d 的收盘）：配合 `last` 前端可**每秒重算**这一行 */
  changeBases: Record<ChangeWindow, {at: number; close: number} | null>
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
  return sharedSse(
    `/api/kline/stream?${qs}`,
    ['kline'],
    {
      events: ['kline'],
      onEvent: (_name, data) => {
        const d = data as {candle?: Candle}
        if (d?.candle) onCandle(d.candle)
      },
      onReconnect
    },
    /* 闲置判定给得宽：冷门币可能几十秒没成交，但 20 秒一次的心跳会把它刷新 */
    75_000
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
  /**
   * 「基准时刻」那一刻的收盘价（请求带了 `?since=` 才有，见后端 `closesAtOrBefore`）。
   * 前端拿它 + 实时 `last` 现算「基准时间 → 现在」的涨跌幅。查不到就是 `null`。
   */
  baseClose?: number | null
}

/**
 * 全部合约的 24h 行情（后端 5 秒缓存，按成交额从大到小）。
 *
 * 币安那边一次请求就是**全量**（740 个合约 ~100KB），所以别刷太勤：
 * 页面上 5 秒一次刚好，跟后端缓存同一档。
 *
 * 传了 `since`（毫秒）＝ 排行榜换基准：一般是「所选时区**当天 00:00**」
 * （见 `settings.ts` 的 `dayStartMs`）或用户挑的**任意时刻**（`rankSinceMs`）。
 * 后端会给每行补一个 `baseClose`（那一刻的收盘价），
 * 前端再把涨跌幅口径换成「基准时间 → 现在」。
 */
export const fetchMarkets = (market?: string, since?: number | null) => {
  const qs = new URLSearchParams()
  if (market) qs.set('market', market)
  if (since) qs.set('since', String(since))
  const q = qs.toString()
  return get<{rows: MarketRow[]; updatedAt: number}>(
    `/api/markets${q ? `?${q}` : ''}`
  )
}

/**
 * **只取基准时刻各币的收盘价**（换基准用的轻量路，≈10KB，2026-10-08）。
 *
 * 为什么不复用 `fetchMarkets(…, since)`：那要整表（500+ 行 / ≈100KB）重来一遍，
 * 而换基准真正变的只有 `baseClose` 一列 —— `last` 是行情增量在刷，别的列一个都没动。
 * 所以前端拿到这份之后**就地替换** `baseClose`，不重建整表、不重排。
 *
 * 返回的 `closes` 是 `{symbol: close}`（`symbol` 就是 `MarketRow.symbol`，
 * 如 `BTC/USDT:USDT`）；那一刻没成交的币不在里面 ⇒ 调用方该当成"没有基准价"。
 */
export const fetchMarketBase = (since: number, market?: string) => {
  const qs = new URLSearchParams({since: String(since)})
  if (market) qs.set('market', market)
  return get<{since: number; closes: Record<string, number>}>(
    `/api/markets/base?${qs.toString()}`
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
 * 一批**标记价**增量里的一个币 —— 就是币安 `markPriceUpdate` 那四个字段。
 *
 * 只有 `pair`（`BTCUSDT`）能落到具体币上；其余三个换币 / 换页都不影响，
 * 但 `fundingRate` 每 8 小时才变一次、`nextFundingTime` 定了就不动，
 * 所以实际每秒变的主要是 `markPrice` / `indexPrice`。
 */
export interface MarkPatch {
  /** 交易所原始交易对（BTCUSDT），跟 `TickerPatch.pair` 一个口径 */
  pair: string
  /** 标记价格 */
  markPrice: number
  /** 指数价格 */
  indexPrice: number | null
  /** 当期资金费率（小数，0.0001 = 0.01%） */
  fundingRate: number | null
  /** 下次资金费用时间（毫秒） */
  nextFundingTime: number | null
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
  onReconnect?: () => void,
  onMark?: (updates: MarkPatch[]) => void
): () => void {
  const names = ['ticker']
  if (onMark) names.push('mark')
  return sharedSse(
    '/api/tickers/stream',
    names,
    {
      events: names,
      onEvent: (name, data) => {
        const d = data as {updates?: TickerPatch[]}
        if (!d?.updates?.length) return
        if (name === 'mark') onMark?.(d.updates as unknown as MarkPatch[])
        else onBatch(d.updates)
      },
      onReconnect
    },
    /* 这条流每秒都有数据，30 秒没动静基本可以确定是死了 */
    30_000
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

/*
 * 已删除（2026-10-11）：`Heat`（资金费率 / 持仓量 / 多空比 / 24h 涨跌振幅成交额）。
 * 用户：「热度不要，不需要」—— 分析不再取它、提示词里没有它、页面上那块也没了。
 * 行情条 / 合约列表那套 24h 数据是另一条链（`TickerInfo`），不受影响。
 */

/**
 * AI 的判断结果 —— **就一句话**。
 *
 * ★ 2026-10-11：档位 / 标签 / 概率 / 理由 / 走势 / 推荐 全删了，
 *   只留一句话（能不能做 + 进场价 + 止损价）。内容由数据库那份提示词说了算。
 */
export interface Judge {
  line: string
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
  symbol: string
  exchange: string
  /** 是不是「回到某一刻」的测试跑（测试跑不存档） */
  testMode: boolean
  /** 测试跑的时间点（毫秒）；实时跑是 null */
  at: number | null
  price: number
  /**
   * 每个周期的 K 线是从哪儿来的：`db` = 本地库（底座写的），`rest` = 交易所现拉。
   * 只给「分析过程」里说明这次吃的是哪份数据。
   */
  sources: {timeframe: string; from: 'db' | 'rest'}[]
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

/** 这条案例从哪来：画一段收录的 / 从一笔仓位导入的 */
export type CaseSource = 'manual' | 'position'

/** 从仓位导入时那笔仓位的事实（后端 `knowledge.pos`） */
export interface CasePosition {
  side: 'long' | 'short'
  entryPrice: number | null
  exitPrice: number | null
  qty: number
  /** 净盈亏（已实现 − 手续费 + 资金费） */
  net: number
  /** 持仓秒数 */
  holdSec: number
  leverage: number | null
  /** 开仓时间（ISO） */
  openAt: string
  /** 全平时间；还没平完是 null */
  closeAt: string | null
}

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
  /** 从哪来的（卡片上给「仓位导入」那类打标） */
  source: CaseSource
  /** 从仓位导入时那笔仓位的事实；别的来源是 null */
  pos: CasePosition | null
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
  /** 这条案例从哪来的（画一段 = manual / 从仓位导入 = position） */
  source: CaseSource
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
  /** 只看这个来源的（不传 = 全部） */
  source?: CaseSource
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
  if (p.source) qs.set('source', p.source)
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

/** 收案例那条路（画一段 / 从仓位导入）共用的收尾 —— 事件名和收尾动作完全一样 */
function collectSse(
  path: string,
  handlers: {
    onStep: (step: AnalyzeStep) => void
    onDone: (result: CollectResult) => void
    onError: (message: string) => void
  }
): () => void {
  const es = openSse(path)
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

  return collectSse('/api/knowledge/stream?' + qs.toString(), handlers)
}

/**
 * 一笔要导入知识库的仓位（`collectFromPositionStream` 的参数）。
 *
 * 只有「那笔仓位是什么」这些事实 —— **窗口不由前端定**：
 * 取哪一段（开仓前 40 根 + 整段持仓 + 平仓后 6 根）和用哪个周期（按持仓时长换档）
 * 都在后端（`knowledge-service.ts` 的 `collectCase` / `pickTimeframe`）。
 */
export interface PositionCollectParams {
  /** 币种简称（存库 / 显示用，`1000BONK`） */
  symbol: string
  /** 交易所原始符号（拉 K 线用，`1000BONKUSDT`） */
  rawSymbol?: string
  side: 'long' | 'short'
  /** 开仓时间（毫秒） */
  openAt: number
  /** 全平时间（毫秒）；还没平完不传 */
  closeAt?: number | null
  entryPrice?: number | null
  exitPrice?: number | null
  qty?: number
  net?: number
  /** 持仓秒数（后端会按「还没平完 = 到现在」自己校一遍） */
  holdSec?: number
  leverage?: number | null
  keyName?: string
  note?: string
}

/**
 * 卡片上点「收录」→ 外层 → 导入弹层，一路传的那一份。
 *
 * 放在这里是因为它横跨三个文件（`ExchangeAccountBoard` 发出来、
 * `ExchangeAccountLivePanel` 接住、`PositionImportSheet` 收进去）——
 * 塞进任何一个 `.vue` 都得让另外两个去 import 组件里的类型。
 */
export interface PositionImportTarget {
  /** 卡片上那个名字（`BONK` / `1000BONK`）—— 弹层标题用 */
  name: string
  /** 还没平完的持仓（弹层里那句「还在持仓中」的文案） */
  open: boolean
  params: PositionCollectParams
}

/**
 * 从一笔仓位导入知识库（SSE，带进度）。
 *
 * ⚠️ 参数走 query：`EventSource` 只能发 GET，而这一串都是短数字 / 简称，
 *    撑不爆请求头（跟 `/api/ask/stream` 那边把长历史塞 URL 撞 431 不是一回事）。
 */
export function collectFromPositionStream(
  params: PositionCollectParams,
  handlers: {
    onStep: (step: AnalyzeStep) => void
    onDone: (result: CollectResult) => void
    onError: (message: string) => void
  }
): () => void {
  const qs = new URLSearchParams({symbol: params.symbol, side: params.side})
  qs.set('openAt', String(params.openAt))
  if (params.rawSymbol) qs.set('rawSymbol', params.rawSymbol)
  if (params.closeAt) qs.set('closeAt', String(params.closeAt))
  if (typeof params.entryPrice === 'number')
    qs.set('entryPrice', String(params.entryPrice))
  if (typeof params.exitPrice === 'number')
    qs.set('exitPrice', String(params.exitPrice))
  if (typeof params.qty === 'number') qs.set('qty', String(params.qty))
  if (typeof params.net === 'number') qs.set('net', String(params.net))
  if (typeof params.holdSec === 'number')
    qs.set('holdSec', String(params.holdSec))
  if (typeof params.leverage === 'number')
    qs.set('leverage', String(params.leverage))
  if (params.keyName) qs.set('keyName', params.keyName)
  if (params.note) qs.set('note', params.note)

  return collectSse(
    '/api/knowledge/from-position/stream?' + qs.toString(),
    handlers
  )
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
  /** 区间模式下的两头（`YYYY-MM-DD`）；按「最近 N 天」查时是 null */
  from: string | null
  to: string | null
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
  /**
   * 任意区间（`YYYY-MM-DD`，含头含尾的北京自然日）—— 日期输入框选的。
   * ★ 2026-10-12：给了它就不再按 `days` 算（`days` 只留着当兜底 / 兼容老调用）。
   */
  from?: string | null
  to?: string | null
  kind: '' | 'judge' | 'extract' | 'ask'
  /** 只看某把密钥（llm_key_id）；不传 / 0 = 全部 */
  keyId?: number | null
}

function usageQs(q: UsageQuery, extra: Record<string, string | number> = {}) {
  const p = new URLSearchParams({days: String(q.days)})
  if (q.from && q.to) {
    p.set('from', q.from)
    p.set('to', q.to)
  }
  if (q.kind) p.set('kind', q.kind)
  if (q.keyId) p.set('keyId', String(q.keyId))
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v))
  return p.toString()
}

export const KIND_TEXT: Record<string, string> = {
  judge: '开单分析',
  extract: '案例提炼',
  ask: '数据问答'
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

/* ---------------- 预测历史 ---------------- */

/**
 * 一次分析留下的**那一句话**（列表用）。
 *
 * 2026-10-11 重置：输出只剩一句话，存档也就只剩它。
 * 表里那些老列（档位 / 标签 / 仓位 / 结算…）留着读老记录，不再往里写。
 */
export interface PredictionRow {
  id: number
  symbol: string
  /** 分析时喂给 AI 的主周期（2026-10-15：「预测结果 每条数据要带周期」） */
  timeframe: string | null
  /** AI 给的结论原文 */
  line: string
  /** 分析那一刻的现价 */
  price: number | null
  createdAt: string
}

export interface PredictionQuery {
  /** 空 = 全部币种 */
  symbol?: string
  days: number
  limit: number
  offset: number
}

export const fetchPredictions = (q: PredictionQuery) => {
  const p = new URLSearchParams({
    days: String(q.days),
    limit: String(q.limit),
    offset: String(q.offset)
  })
  if (q.symbol) p.set('symbol', q.symbol)
  return get<{rows: PredictionRow[]; total: number}>(`/api/analyses?${p}`)
}

export const deletePrediction = (id: number) =>
  del<{ok: boolean}>(`/api/analyses/${id}`)

/* ---------------- 数据问答（「我的 → 数据问答」） ---------------- */

/** 这一轮模型调了哪个工具、拿到多少行 —— 前端「取值过程」摊开给用户看 */
export interface AskStep {
  tool: string
  /** 工具的中文短名 */
  label: string
  args: Record<string, unknown>
  ok: boolean
  ms: number
  rows: number
  detail: string
  error: string | null
}

export interface AskReply {
  answer: string
  steps: AskStep[]
  rounds: number
  /**
   * 真查过库吗。false = 这回答**没碰数据库**（模型直接开口了），
   * UI 必须标出来 —— 数据类问答最怕的就是它自己编。
   */
  verified: boolean
  model: string
  latencyMs: number
  costUsd: number
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /**
   * 这一问落在哪个会话里（2026-10-17 起服务端存档）。
   *
   * 新建的会话由**后端**在建好后立刻用 `thread` 事件推下来（见 `onThread`），
   * `done` 里再带一次 —— 就算中途漏了那个事件，收尾也认得这个 id。
   */
  threadId?: number
}

/** 多轮追问带回去的那几轮（后端只认 role + content） */
export interface AskTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 问一句 —— **流式版**（2026-10-16）。
 *
 * 后端 `GET /api/ask/stream` 边跑边推：`round`（第几轮）· `step`（一个工具跑完，立刻长进
 * 「取值过程」）· `delta`（回答逐字）· `done`（最后那份完整结果）· `failed`。
 *
 * 为什么要流式：这条链路**取数比写字慢得多**（3~4 轮工具调用 + 每轮一次大模型往返），
 * 不流的话用户盯着一个转圈十几秒，不知道里头在干什么；流式能让他**看着它查**。
 *
 * ⚠️ 跟 `analyzeStream` 一样是**任务型**的流：断了不重连（重连 = 再问一遍、再花一次钱），
 *    所以这里直接用裸 `EventSource`、收尾就关，不走 `liveSse` 那套看门狗重连。
 * @returns 取消函数（组件卸载 / 用户切走时调）
 */
export function askStream(
  question: string,
  /** 历史：**只有第一次问答（还没有会话）才用得上** —— 有会话时后端从库里取 */
  history: AskTurn[],
  /** 落到哪个会话；`0` / 不传 = 后端现开一个 */
  threadId: number,
  handlers: {
    onRound?: (round: number, max: number) => void
    onStep?: (step: AskStep) => void
    onDelta?: (text: string) => void
    /** 这一轮的文字作废（只是旁白，不是回答）*/
    onDrop?: () => void
    /**
     * 会话（2026-10-17）：开跑**之前**就会来一发 —— 新建的会话这时才有 id，
     * 前端拿它把本地那条「草稿会话」换成真的（中途终止也能认住是哪个会话）。
     */
    onThread?: (t: {id: number; title: string}) => void
    onDone: (reply: AskReply) => void
    onError: (message: string) => void
  }
): () => void {
  const ac = new AbortController()
  let finished = false

  const finish = (): void => {
    finished = true
    window.clearInterval(watchdog)
    ac.abort()
  }

  /**
   * 看门狗 —— 治「一直转」的那个东西。
   *
   * 后端每 20 秒推一次 `heartbeat`；**120 秒**没收到任何东西 = 死了
   *（一轮大模型调用实测十几秒，三轮也够）。真慢到 120 秒那种，让用户重问比干等好。
   */
  let lastAt = Date.now()
  const WATCHDOG_MS = 120_000
  const watchdog = window.setInterval(() => {
    if (finished) return
    if (Date.now() - lastAt <= WATCHDOG_MS) return
    finish()
    handlers.onError(
      '连接断了（两分钟没收到响应）。可能是这次查询太重或网络断了 —— 再问一次试试。'
    )
  }, 5_000)

  /** 一帧 SSE（`event: X\ndata: {...}`） */
  const frame = (raw: string): void => {
    let name = ''
    let data = ''
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!name) return
    lastAt = Date.now()
    let d: Record<string, any> | null = null
    try {
      d = data ? JSON.parse(data) : null
    } catch {
      d = null
    }
    if (name === 'round') handlers.onRound?.(Number(d?.round) || 1, Number(d?.max) || 1)
    else if (name === 'step' && d?.step) handlers.onStep?.(d.step as AskStep)
    else if (name === 'delta' && d?.text) handlers.onDelta?.(String(d.text))
    else if (name === 'drop') handlers.onDrop?.()
    else if (name === 'thread')
      handlers.onThread?.({
        id: Number(d?.id) || 0,
        title: String(d?.title ?? '')
      })
    else if (name === 'done') {
      finish()
      if (d) handlers.onDone(d as unknown as AskReply)
      else handlers.onError('结果是空的（解析失败）')
    } else if (name === 'failed') {
      finish()
      handlers.onError(String(d?.error ?? '问答失败'))
    }
    // `heartbeat` 只用来喂看门狗（上面已经刷了 `lastAt`）
  }

  /*
   * ⚠️⚠️ 为什么用 `fetch` 手搓 SSE，而不是 `EventSource`（2026-10-16 修）：
   *   `EventSource` 只能 GET，于是**问题和多轮历史只能塞进 URL** ——
   *   中文经 URL 编码每个字变 9 个字符，上一轮那篇长回答一编码就是几十 KB，
   *   直接顶爆服务端 16KB 的请求头上限 ⇒ **431** ⇒ 界面"卡在正在查库"。
   *   `fetch` 能 POST（body 无上限），还能带 `Authorization` 头（token 不必进 URL）。
   * ⚠️ 代价：得自己解 SSE 帧、自己做看门狗 —— 但 `EventSource` 那套自动重连
   *   对**任务型**的流本来就不能用（重连 = 后端从头再跑一遍，白花钱）。
   */
  void (async () => {
    try {
      const res = await fetch(apiUrl('/api/ask/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken.value
            ? {Authorization: `Bearer ${authToken.value}`}
            : {})
        },
        body: JSON.stringify({question, history, threadId}),
        signal: ac.signal
      })
      if (!res.ok) {
        // 4xx / 5xx：服务端一般是 JSON 错误（401 会顺手清本地 token，跟别的接口一致）
        const msg =
          ((await res.json().catch(() => null)) as {error?: string} | null)?.error ??
          `请求失败（HTTP ${res.status}）`
        if (res.status === 401) setAuthToken('')
        finish()
        handlers.onError(msg)
        return
      }
      if (!res.body) {
        finish()
        handlers.onError('这个浏览器不支持流式响应')
        return
      }

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const {done, value} = await reader.read()
        if (done) break
        buf += dec.decode(value, {stream: true})
        // 帧之间用空行分隔（后端 `res.write('event: x\ndata: {}\n\n')`）
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (raw.trim()) frame(raw)
        }
      }
      /*
       * 流关了却没收到 `done` / `failed`：后端被重启 / 崩了。
       * ⚠️ 这里必须报错收场 —— 不报的话 `askBusy` 和 `streaming` 就一直挂着，
       *    界面永远停在「正在查库」（这正是用户报的那个"卡住"）。
       */
      if (!finished) {
        finish()
        handlers.onError('连接中断（后端可能重启了）。再问一次试试。')
      }
    } catch (e) {
      if (finished) return
      finish()
      handlers.onError(
        (e as Error)?.name === 'AbortError'
          ? '已取消'
          : `请求失败：${(e as Error)?.message ?? '网络不通'}`
      )
    }
  })()

    /** 对外返回的「终止」：断掉这次 fetch（后端会跟着 `res.close` → abort） */
  return finish
}

/* ---------------- 数据问答的会话（2026-10-17，服务端存档） ---------------- */

/** 左侧列表里的一条会话（**不带**问答正文，点开才拉） */
export interface AskThreadBrief {
  id: number
  title: string
  /** 毫秒时间戳 */
  createdAt: number
  updatedAt: number
  /** 这个会话有几轮 */
  turns: number
}

/** 存下来的一轮问答 */
export interface StoredAskTurn {
  id: number
  question: string
  answer: string
  /** 取值过程（工具名 / 参数 / 行数 / 耗时） */
  steps: AskStep[]
  unverified: boolean
  model: string
  costUsd: number
  latencyMs: number
  ok: boolean
  stopped: boolean
  /** 出错的原因（正常是空串） */
  error: string
  createdAt: number
}

export interface StoredAskThread extends AskThreadBrief {
  turnsList: StoredAskTurn[]
}

/** 会话列表（按最近更新倒序） */
export const listAskThreads = () =>
  get<{threads: AskThreadBrief[]}>('/api/ask/threads')

/** 开一个空会话（正常路径是「问第一句时后端自己开」，这个给「先点新对话再慢慢想」用） */
export const createAskThread = (title: string) =>
  post<{id: number}>('/api/ask/threads', {title})

/** 打开一个会话：正文 + 最后 60 轮 */
export const getAskThread = (id: number) =>
  get<StoredAskThread>(`/api/ask/threads/${id}`)

export const renameAskThread = (id: number, title: string) =>
  patchReq<{ok: boolean}>(`/api/ask/threads/${id}`, {title})

export const deleteAskThread = (id: number) =>
  del<{ok: boolean}>(`/api/ask/threads/${id}`)

/**
 * 把浏览器里那批旧会话搬进库里（**一次性迁移**，见 `ask.ts` 的 `loadAsk`）。
 *
 * 不给 `id`：服务端按数组顺序新建，`createdAt` 用原来那个 —— 左侧的
 * 「今天 / 昨天 / 7 天内」分组才不会全挤到「今天」。
 */
export const importAskThreads = (
  threads: {
    title: string
    createdAt?: number
    updatedAt?: number
    turns: {
      question: string
      answer: string
      unverified?: boolean
      model?: string
      costUsd?: number
      latencyMs?: number
      ok?: boolean
      stopped?: boolean
      error?: string
      createdAt?: number
    }[]
  }[]
) =>
  post<{threads: number; turns: number}>('/api/ask/threads/import', {threads})

/**
 * 问一句（**非流式**的老路，POST /api/ask）。
 *
 * 还留着：别的调用点（脚本、测试）要一次拿到完整结果时更省事。
 * 网页走的是上面那条流式的。
 *
 * ⚠️ 默认那 12 秒超时**不够**：这一句后面可能是 4 轮「模型想 → 查库 → 再想」，
 *    所以单独放宽到 2 分钟（POST 本来就不重试，超时不会重复花钱）。
 */
export const askData = (question: string, history: AskTurn[]) =>
  req<AskReply & {error?: string}>(
    '/api/ask',
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({question, history})
    },
    {timeoutMs: 120_000}
  )

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
  /** 下载目录里**别的应用**的 APK（跟本 app 的历史版本分开列） */
  apps: DownloadOtherApp[]
}

/** 别的应用（同一个下载目录里放的，比如梯子）—— 名字没在 `releases.json.apps` 登记的话按文件名猜 */
export interface DownloadOtherApp {
  file: string
  url: string
  name: string
  version: string
  desc: string
  require: string
  /** 字节数 */
  size: number
  mtime: number
  /** 名字是按文件名猜出来的（界面上标一下，免得当成正式名字） */
  guessed: boolean
  md5: string | null
}

export const fetchDownloads = () => get<DownloadsResult>('/api/downloads')

/**
 * 下载链接 —— 原生壳里页面跑在 `https://localhost`，相对路径 `/dl/x.apk`
 * 会打到 WebView 自己身上，所以必须补上 `API_BASE`。
 */
export const downloadUrl = (url: string): string => apiUrl(url)

/* ---------------- 服务器状态（「我的 → 管理 → 服务器」） ---------------- */

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
