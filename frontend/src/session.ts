import {ref} from 'vue'
import {
  authLogin,
  authLogout,
  authMe,
  authRegister,
  authRename,
  authToken,
  authTotpVerify,
  isAuthError,
  setAuthToken,
  type AuthUser
} from './api'

/**
 * 登录态（用户系统 2026-10-04）。
 *
 * token 存在 `api.ts` 里（所有请求共用），这里只管「当前用户是谁」。
 * 页面启动时 `initAuth()` 拿本地 token 去问 `/api/auth/me`：
 * · 有 token 且没过期 → 直接进 App
 * · 没有 / 过期 → 显示登录页
 */
export const user = ref<AuthUser | null>(null)
/** 是否已经问过服务器了（没问完别急着决定显示登录页还是 App） */
export const authReady = ref(false)

/**
 * 本地开发**免登录**（2026-10-16）。
 *
 * 只在 vite 开发模式、且后端显式设了 `DEV_AUTO_LOGIN` 时才拿得到
 * （后端 `/api/auth/dev-login` 那两道闸：`NODE_ENV !== production` + 显式设了变量，
 * 线上两者都不成立 ⇒ 404）。拿到的是**正常的会话 token**，不是绕过鉴权的后门。
 *
 * `main.ts` 在 `mount` 之前调一次（那时本地可能**压根没有** token）；
 * `initAuth()` 在「本地有 token 但已经失效」时再补一次 ——
 * 那一路是后者管不到的：`api.ts` 收到 401 会把 token 清掉，接着就停在登录页，
 * 表现就是「明明开了 DEV_AUTO_LOGIN 还是弹登录页」。
 *
 * @returns 拿到 token（并已写进 `authToken`）就算 true
 */
export async function devAutoLogin(): Promise<boolean> {
  if (!import.meta.env.DEV || authToken.value) return false
  try {
    const r = await fetch('/api/auth/dev-login')
    if (!r.ok) return false
    const d = (await r.json()) as {token?: string}
    if (!d.token) return false
    setAuthToken(d.token)
    return true
  } catch {
    /* 后端没起 —— 当没有，照常显示登录页 */
    return false
  }
}

/** 启动时跑一次 */
export async function initAuth(): Promise<void> {
  if (!authToken.value) {
    authReady.value = true
    return
  }
  /*
   * ⚠️ 「连不上服务器」不能跟「没登录」混为一谈：App 冷启动时正好撞上部署窗口
   *（容器重建几秒）/ 手机刚出隧道没信号，`/api/auth/me` 都会失败。
   * 那时如果直接显示登录页，用户就会以为「token 被卡掉了」（其实 token 还在）。
   * 所以：**只有 401 才算未登录**，其它错误重试两次再认。
   */
  for (let i = 0; i < 3; i++) {
    try {
      user.value = (await authMe()).user
      authReady.value = true
      return
    } catch (e) {
      if (isAuthError(e) || i === 2) break
      await new Promise(r => setTimeout(r, 700 * (i + 1)))
    }
  }
  // token 失效 / 网络一直不通：当未登录（api.ts 里 401 已顺手清掉本地 token）
  user.value = null
  /*
   * token 是被**踢掉 / 过期**（401 把本地那份清掉了）时，本地开发这里再要一条 ——
   * 不然就只有「本地压根没 token」那一次免登录，被踢一次之后就再也自动不进来了。
   *
   * ⚠️ 只在 token 真被清掉时补：`authToken` 还在说明是**网络问题**，
   *    那时候另开一条会话纯属浪费（而且会把「登录设备」列表刷得都是记录）。
   */
  if (!authToken.value && (await devAutoLogin())) {
    try {
      user.value = (await authMe()).user
    } catch {
      user.value = null
    }
  }
  authReady.value = true
}

/**
 * 登录第一步。
 *
 * 账号开了两步验证（`admin` 可以开）时**不会**直接登录成功，
 * 而是把中间票交回去，让 `LoginView` 显示 6 位口令输入框 ——
 * 那时调 `loginTotp(ticket, code)` 才算登完。
 */
export async function login(
  username: string,
  password: string
): Promise<{needTotp: boolean; ticket?: string}> {
  const r = await authLogin(username, password)
  if ('needTotp' in r) return {needTotp: true, ticket: r.ticket}
  setAuthToken(r.token)
  user.value = r.user
  return {needTotp: false}
}

/** 登录第二步：6 位动态口令（或一个恢复码） */
export async function loginTotp(
  ticket: string,
  code: string
): Promise<{recoveryUsed: boolean}> {
  const r = await authTotpVerify(ticket, code)
  setAuthToken(r.token)
  user.value = r.user
  return {recoveryUsed: Boolean(r.recoveryUsed)}
}

export async function register(
  username: string,
  password: string
): Promise<void> {
  const r = await authRegister(username, password)
  setAuthToken(r.token)
  user.value = r.user
}

export async function logout(): Promise<void> {
  /*
   * ⚠️ 先注销推送 token，**再**退登录 —— 反过来就没 token 可用、接口会 401，
   * 那台手机之后还会收到上一个人的「转可做」提醒。
   *
   * 用**动态 import**：`push.ts` 要 router / analyze，静态 import 进来容易绕成环
   *（这个模块被它们间接依赖），而且只有这一处用得上。
   */
  const {unregisterPush} = await import('./push')
  await unregisterPush().catch(() => undefined)
  await authLogout()
  setAuthToken('')
  user.value = null
  /*
   * ⚠️ 刷新一下整页。
   * 分析结果 / 行情面板 / 图表实例都是**模块作用域**（切页不丢），
   * 而且「开单分析」「合约」还在 KeepAlive 里缓存着 ——
   * 不整页刷新的话，同一台设备换个人登录会先看到上一个人的结论。
   */
  window.location.reload()
}

/** 改自己的用户名（「个人信息」页）—— 就地更新顶栏显示的名字 */
export async function rename(username: string): Promise<void> {
  const r = await authRename(username)
  user.value = r.user
}
