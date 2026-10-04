import {ref} from 'vue'
import {
  authLogin,
  authLogout,
  authMe,
  authRegister,
  authRename,
  authToken,
  authTotpVerify,
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

/** 启动时跑一次 */
export async function initAuth(): Promise<void> {
  if (!authToken.value) {
    authReady.value = true
    return
  }
  try {
    user.value = (await authMe()).user
  } catch {
    // token 失效 / 网络不通：当作未登录（api.ts 里 401 已顺手清掉本地 token）
    user.value = null
  } finally {
    authReady.value = true
  }
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
