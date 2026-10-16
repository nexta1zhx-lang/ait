/**
 * **App 后台提醒**（2026-10-16 用户选的那条路）。
 *
 * 背景：用户的华为手机**没有谷歌服务（GMS）**，FCM（`@capacitor/push-notifications`）
 * 在那台机器上注册不上 —— 不报错也不给 token，路是死的。所以改成：
 * **App 自己跑一个前台服务**（原生 `AlertWatchService`）定时问服务端"有没有新的「转可做」提醒"，
 * 有就发一条**本地通知**。完全不依赖谷歌 / 华为任何推送服务。
 *
 * 这里只做三件事：
 *   ① 登录后把 token 交给原生服务（它要用它调 `/api/persist/alerts`）；
 *   ② 给「我的 → 推送」那张卡一份状态（开着没 / 有没有拿到 token / 通知权限给了没）；
 *   ③ 「发一条测试提醒」—— 不用等真实的「转可做」（那可能要等一整天）。
 *
 * ⚠️⚠️ 跟 `native.ts` / `push.ts` 同一个约定：**不 `import` Capacitor 插件**，
 *     一律从 `window.Capacitor.Plugins.AlertWatch` 上取 —— Web 端没有这个插件。
 */
import {ref, watch} from 'vue'
import {authToken} from './api'
import {isNativeShell} from './platform'

/** 原生那边用到的这一小块 */
interface AlertWatchPlugin {
  start(o: {token: string; base: string}): Promise<AlertWatchStatus>
  stop(): Promise<AlertWatchStatus>
  status(): Promise<AlertWatchStatus>
  testNotify(): Promise<AlertWatchStatus>
}

export interface AlertWatchStatus {
  /** 用户开没开这个开关（存在原生 SharedPreferences 里，App 重开还记得） */
  enabled: boolean
  /** 原生服务手里有没有登录 token（没有就轮询不了） */
  hasToken: boolean
  /** Android 13+ 的通知权限给了没 */
  notificationsGranted: boolean
  /** 已经看到哪一条提醒了（-1 = 还没起步） */
  since: number
}

/** 最近一次拿到的状态（`null` = 还没问过） */
export const watchStatus = ref<AlertWatchStatus | null>(null)
/** 这台设备支不支持（原生壳 + 有这个插件） */
export const watchSupported = ref(false)
/** 正在开/关（按钮上转圈用） */
export const watchBusy = ref(false)
/** 最近一次的错误（人话） */
export const watchError = ref('')

function plugin(): AlertWatchPlugin | undefined {
  const cap = (globalThis as unknown as {
    Capacitor?: {Plugins?: {AlertWatch?: AlertWatchPlugin}}
  }).Capacitor
  return cap?.Plugins?.AlertWatch
}

/** 这台设备支持吗（原生壳 && 装了 0.2.14+ 的包） */
export function detectWatch(): boolean {
  watchSupported.value = isNativeShell() && !!plugin()
  return watchSupported.value
}

async function call(fn: (p: AlertWatchPlugin) => Promise<AlertWatchStatus>): Promise<void> {
  const p = plugin()
  if (!p) return
  watchBusy.value = true
  watchError.value = ''
  try {
    watchStatus.value = await fn(p)
  } catch (e) {
    watchError.value = (e as Error).message
  } finally {
    watchBusy.value = false
  }
}

/** 刷新状态（进页时调一次） */
export async function refreshWatch(): Promise<void> {
  detectWatch()
  if (!watchSupported.value) return
  await call(p => p.status())
}

/** 打开（把当前 token 一并交给原生；登录后也会自动调一次） */
export async function enableWatch(): Promise<void> {
  detectWatch()
  if (!watchSupported.value) return
  /*
   * ⚠️ 把**当前站点的 origin** 一起交下去：后台服务轮询的就是它。
   *    这样"本地前端 + 局域网后端"和"线上"用的是同一个包，不用改 Java 里的域名。
   */
  await call(p => p.start({token: authToken.value, base: location.origin}))
}

/** 关掉（用户在卡上点的那个开关） */
export async function disableWatch(): Promise<void> {
  detectWatch()
  if (!watchSupported.value) return
  await call(p => p.stop())
}

/** 立刻来一条本地通知（验"通知这条路通不通"，不用等真实的转可做） */
export async function testNotify(): Promise<void> {
  detectWatch()
  if (!watchSupported.value) return
  await call(p => p.testNotify())
}

/**
 * 挂在 `main.ts` 里：**登录态一变就补一次 token**。
 *
 * ⚠️ 只在开关已经打开时才补：用户明确关掉的，不该被我们"贴心"地又打开。
 *    （原生那边 `enabled` 是落地存储的，所以这里查一下状态。）
 */
export function bindWatch(): () => void {
  detectWatch()
  if (!watchSupported.value) return () => undefined
  void refreshWatch().then(() => {
    if (watchStatus.value?.enabled && authToken.value) void enableWatch()
  })
  const stop = watch(authToken, t => {
    if (t && watchStatus.value?.enabled) void enableWatch()
  })
  return () => stop()
}

