/**
 * **App 推送（FCM）接线**（2026-10-15 用户：「加入 app 推送」）。
 *
 * 干三件事，全都只在**原生壳**里生效（浏览器里这一整个模块是空操作）：
 *   ① 申请权限 → 注册 → 把 FCM token 报给后端（`POST /api/push/token`）；
 *   ② **前台**收到通知：弹一条站内提示（App 开着时系统通知栏也可能不响，不弹就等于没通知）；
 *   ③ 用户**点通知**：把数据带过去跳 K 线（`data.symbol` 是后端发通知时塞的）。
 *
 * ⚠️⚠️ 跟 `native.ts` / `back-button.ts` 同一个约定：**不 `import` `@capacitor/*`**，
 *     一律从 `window.Capacitor.Plugins` 这个全局对象上取 —— Web 端不装这个插件，
 *     静态 import 会让打包/运行在 Web 上就炸。这里用到的只有两三个方法，自己声明类型即可。
 *
 * ⚠️ 权限**只在用户主动加入「持久化分析」之后才有意义**，但那颗按钮在很多地方都能点，
 *    所以策略是：登录后就注册（token 只是为了让**服务端以后能发**），真正的打扰由
 *    后端把控（只有"转可做"才发一条）。第一次申请权限时系统会弹框，用户点了拒绝就拉倒。
 */
import {ref, watch} from 'vue'
import {authToken, deletePushToken, postPushToken} from './api'
import {pickSymbol} from './analyze'
import {router} from './router'
import {isNativeShell, shellPlatform} from './platform'
import {showToast} from './toast'

/* ---------------- Capacitor 里我们用到的这一小块 ---------------- */

interface PermissionStatus {
  receive?: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'
}

interface PushNotificationSchema {
  title?: string
  body?: string
  data?: Record<string, string>
}

interface PushPlugin {
  checkPermissions(): Promise<PermissionStatus>
  requestPermissions(): Promise<PermissionStatus>
  register(): Promise<void>
  createChannel?(ch: {
    id: string
    name: string
    description?: string
    importance?: number
    visibility?: number
  }): Promise<void>
  addListener(
    event: 'registration' | 'registrationError' | 'pushNotificationReceived' | 'pushNotificationActionPerformed',
    cb: (payload: unknown) => void
  ): Promise<unknown>
}

/** Android 上通知要落进哪个渠道（跟后端 `notify/push.ts` 里写的 `channel_id` 必须一样） */
const CHANNEL_ID = 'ait-alert'

function plugin(): PushPlugin | undefined {
  const cap = (globalThis as unknown as {
    Capacitor?: {Plugins?: {PushNotifications?: PushPlugin}}
  }).Capacitor
  return cap?.Plugins?.PushNotifications
}

/**
 * 设备名（只给人看，出现在服务端日志/排查里）。
 *
 * ⚠️ 不用 `Capacitor.getPlatform()` 拼 —— 那玩意只能告诉你 android / ios，
 *    而「我到底有几台设备在收」要看得出是哪台。UA 里够用的就取一段。
 */
function deviceName(): string {
  const ua = navigator.userAgent
  const m = /Android[^;)]*;\s*([^;)]+)/i.exec(ua)
  const model = (m?.[1] ?? '').trim()
  return `${shellPlatform() === 'ios' ? 'iOS' : 'Android'}${model ? ` · ${model}` : ''}`
}

/** 已经报给后端的 token（避免每次启动重复 POST / 换用户时漏报） */
let reportedFor: string | null = null
let registering = false

/**
 * **本机（这台手机）的推送状态** —— 给「我的 → 推送」那张卡显示。
 *
 * ★ 2026-10-16 加：用户在华为手机上问「为什么收不到」。这种事只靠服务端日志看不出来
 *   （服务端只知道"有没有设备上报过"），而手机上发生的事（插件有没有、权限给没给、
 *   注册时报了什么错）必须在**手机自己的界面上**看得见 —— 否则永远只能猜。
 */
export interface PushLocalState {
  /** 是不是原生壳（网页上这份状态没意义） */
  native: boolean
  /** 有没有 `PushNotifications` 插件（旧 APK 里没有 —— 那就永远注册不了） */
  hasPlugin: boolean
  /** 通知权限：granted / denied / prompt / 还没问 */
  permission: string
  /** 从 FCM 拿到的 token（只显示前 12 位，够对账又不至于把它抄走） */
  token: string
  /** 上报给后端成功了没 */
  reported: boolean
  /** 注册/上报失败的原因（人话） */
  error: string
}

export const pushLocal = ref<PushLocalState>({
  native: false,
  hasPlugin: false,
  permission: 'unknown',
  token: '',
  reported: false,
  error: ''
})

/** 确保注册 + 上报（幂等：同一个登录态调多少次都只注册一次） */
export async function registerPush(): Promise<void> {
  const native = isNativeShell()
  pushLocal.value = {...pushLocal.value, native, hasPlugin: !!plugin()}
  const p = plugin()
  if (!native || !p) {
    if (native && !p) {
      pushLocal.value.error =
        '这个 App 里没有推送插件（装的是 0.2.13 之前的包）—— 换新包才会注册'
    }
    return
  }
  if (registering) return
  if (!authToken.value) return
  registering = true
  try {
    let perm = await p.checkPermissions()
    if (perm.receive !== 'granted') perm = await p.requestPermissions()
    pushLocal.value = {...pushLocal.value, permission: perm.receive ?? 'unknown'}
    if (perm.receive !== 'granted') {
      // 用户拒绝了：不再纠缠（后端那边也不会发，因为没 token）
      pushLocal.value.error = '系统里没给通知权限 —— 去「设置 → 应用 → Ait → 通知」打开'
      return
    }
    /*
     * Android 的通知渠道要在**收到第一条之前**就建好，不然 FCM 带着
     * `channel_id: 'ait-alert'` 过来的消息会被系统直接丢掉（这条踩了很难查：
     * 服务端 200、客户端什么也没有）。
     */
    if (p.createChannel) {
      await p
        .createChannel({
          id: CHANNEL_ID,
          name: 'AI 转可做提醒',
          description: '持久化分析里结论转成「可做」时的提醒',
          importance: 4,
          visibility: 1
        })
        .catch(() => undefined)
    }
    await p.addListener('registration', payload => {
      const token = (payload as {value?: string})?.value ?? ''
      if (!token) return
      pushLocal.value = {...pushLocal.value, token, error: ''}
      void postPushToken({
        token,
        platform: shellPlatform(),
        device: deviceName()
      })
        .then(() => {
          reportedFor = authToken.value
          pushLocal.value = {...pushLocal.value, reported: true}
        })
        .catch(() => {
          pushLocal.value = {
            ...pushLocal.value,
            error: '拿到 token 了，但上报给服务器失败（网络？）'
          }
        })
    })
    await p.addListener('registrationError', e => {
      const raw = String((e as {error?: string})?.error ?? e)
      /* ⚠️ 华为这类**没有谷歌服务**的机器就卡在这儿：一句人话，别让人对着
         "MISSING_INSTANCEID_SERVICE" 发懵 */
      pushLocal.value = {
        ...pushLocal.value,
        error: /MISSING_INSTANCEID_SERVICE|SERVICE_NOT_AVAILABLE|Google/i.test(raw)
          ? `这台手机没有谷歌服务（GMS），FCM 推送用不了 —— ${raw}`
          : raw
      }
      console.warn('[push] 注册失败：', raw)
    })
    /* 前台收到：系统通知栏不一定响，弹一条站内提示（点开就是 K 线） */
    await p.addListener('pushNotificationReceived', payload => {
      const n = payload as PushNotificationSchema
      showToast(`${n.title ?? 'AI 提醒'}：${n.body ?? ''}`, 'ok')
    })
    /* 用户点通知：带 `data` 跳到那个币的 K 线 */
    await p.addListener('pushNotificationActionPerformed', payload => {
      const data = (payload as {notification?: PushNotificationSchema})?.notification?.data
      const sym = data?.symbol
      if (!sym) return
      pickSymbol(sym)
      void router.push('/analyze').catch(() => undefined)
    })
    await p.register()
  } catch (e) {
    console.warn('[push] 初始化出错：', (e as Error).message)
  } finally {
    registering = false
  }
}

/** 退出登录时把这条设备的 token 注销掉（不然换账号后还会收到上一个人的提醒） */
export async function unregisterPush(): Promise<void> {
  const p = plugin()
  if (!isNativeShell() || !p) return
  if (!reportedFor && !authToken.value) return
  try {
    /*
     * 拿不到 token 也没关系：后端那条记录留着会在下次上报时被 UPSERT 成新用户，
     * 而且发失败（token 废了）时会自己标死。这里尽力而为。
     */
    const token = await new Promise<string>(resolve => {
      const t = setTimeout(() => resolve(''), 3000)
      void p
        .addListener('registration', payload => {
          clearTimeout(t)
          resolve((payload as {value?: string})?.value ?? '')
        })
        .catch(() => {
          clearTimeout(t)
          resolve('')
        })
      void p.register().catch(() => {
        clearTimeout(t)
        resolve('')
      })
    })
    if (token) await deletePushToken(token).catch(() => undefined)
  } catch {
    /* 注销失败无所谓 */
  } finally {
    reportedFor = null
  }
}

/**
 * 挂在 `main.ts` 里：登录状态下注册一次，之后**登录态一变就补一次**
 *（首屏时可能还没登录 —— token 是登录后才有的）。
 *
 * 返回一个「摘掉」的函数（跟 `bindPersist()` 一个路数）。
 */
export function bindPush(): () => void {
  /* Web 上什么都不做（浏览器里没有 FCM，也没必要申请权限） */
  if (!isNativeShell()) return () => undefined
  void registerPush()
  const stop = watch(authToken, t => {
    if (t) void registerPush()
  })
  return () => stop()
}
