/**
 * **FCM 推送**（2026-10-15 用户：「加入 app 推送」）。
 *
 * 走的是 **HTTP v1**（`https://fcm.googleapis.com/v1/projects/<项目>/messages:send`）——
 * 老的那套 `fcm/send` + server key 已经被 Google 摘掉了，别再往回写。
 *
 * 凭据要的是**服务账号私钥**（Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥），
 * 存哪儿由环境变量说：
 *   · `FCM_SERVICE_ACCOUNT_FILE` —— 文件路径（服务器上放 `/opt/crypto-advisor/firebase-sa.json`）；
 *   · `FCM_SERVICE_ACCOUNT`      —— 整段 JSON 直接塞进环境变量（单行）。
 * 两个都没配 ⇒ **只打一行日志**（跟 Telegram 那边一个规矩：通知永远不许影响主流程）。
 *
 * ⚠️ 用 node 自带的 `crypto` 手搓 RS256 JWT，**不引第三方包**：就一个签名 + 一次换 token，
 *    为它拉一个 `google-auth-library`（连带一串依赖）不划算。
 * ⚠️ 私钥**绝不出现在日志里**：出错只打错误码 / 状态码，不打请求体、不打 credentials。
 */
import {createSign} from 'node:crypto'
import {readFileSync} from 'node:fs'

/** 服务账号 JSON 里我们用到的字段 */
interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

interface Creds {
  sa: ServiceAccount
  /** 读文件失败时给个明确的人话（别只在日志里留一个 ENOENT） */
  from: string
}

/** 已换到的 access_token（进程内缓存；FCM 那边有效期 1 小时，提前 60 秒重换） */
let cached: {token: string; exp: number} | null = null

function envOf(name: string): string {
  return (process.env[name] ?? '').trim().replace(/^["']|["']$/g, '')
}

let credsCache: Creds | null | undefined

/**
 * 读服务账号凭据（读不到返回 null，**并把原因留在 `credsError` 里**给人看）。
 *
 * ⚠️ 缓存「读失败」这件事，但要缓存**原因**而不是简单一个 null ——
 *    不然排查时只能看到「没配」，看不出是路径写错了还是 JSON 坏了。
 */
let credsError = ''

function creds(): Creds | null {
  if (credsCache !== undefined) return credsCache
  const file = envOf('FCM_SERVICE_ACCOUNT_FILE')
  const inline = envOf('FCM_SERVICE_ACCOUNT')
  let text = ''
  let from = ''
  if (file) {
    from = file
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      credsError = `读不了 ${file}（${(e as NodeJS.ErrnoException).code ?? 'error'}）`
      credsCache = null
      return null
    }
  } else if (inline) {
    from = 'FCM_SERVICE_ACCOUNT（环境变量）'
    text = inline
  } else {
    credsError = '没配 FCM_SERVICE_ACCOUNT_FILE / FCM_SERVICE_ACCOUNT'
    credsCache = null
    return null
  }
  try {
    const sa = JSON.parse(text) as ServiceAccount
    if (!sa.project_id || !sa.client_email || !sa.private_key) {
      credsError = `${from} 里少了 project_id / client_email / private_key（是不是拿错了别的 JSON？）`
      credsCache = null
      return null
    }
    credsError = ''
    credsCache = {sa, from}
    return credsCache
  } catch {
    credsError = `${from} 不是合法 JSON`
    credsCache = null
    return null
  }
}

export function pushConfigured(): boolean {
  return creds() !== null
}

/** 给状态展示用的一句话（页面/日志里显示「推送为什么没生效」） */
export function pushStatus(): {ok: boolean; detail: string} {
  const c = creds()
  return c
    ? {ok: true, detail: `已配置（项目 ${c.sa.project_id}）`}
    : {ok: false, detail: credsError || '没配'}
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url')

/** 换一个 access_token（带进程内缓存） */
async function accessToken(): Promise<string | null> {
  const now = Date.now()
  if (cached && cached.exp > now) return cached.token
  const c = creds()
  if (!c) return null
  const iat = Math.floor(now / 1000)
  const header = b64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}))
  const claims = b64url(
    JSON.stringify({
      iss: c.sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600
    })
  )
  let assertion = ''
  try {
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    assertion = `${header}.${claims}.${signer.sign(c.sa.private_key, 'base64url')}`
  } catch {
    /* 私钥格式不对（换行被吃掉是最常见的）—— 别把私钥打出来 */
    console.warn('[push] 服务账号私钥不能用来签名（`\\n` 有没有被转义掉？）')
    return null
  }
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }),
      signal: AbortSignal.timeout(15_000)
    })
    const body = (await res.json().catch(() => null)) as
      | {access_token?: string; expires_in?: number; error?: string}
      | null
    if (!res.ok || !body?.access_token) {
      console.warn(`[push] 换 access_token 失败：${res.status} ${body?.error ?? ''}`)
      return null
    }
    cached = {
      token: body.access_token,
      // 提前 60 秒重换，别卡在过期那一秒上
      exp: now + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000
    }
    return cached.token
  } catch (e) {
    console.warn(`[push] 换 access_token 出错：${(e as Error).name || 'error'}`)
    return null
  }
}

export interface PushMessage {
  title: string
  body: string
  /** 点开通知时 App 拿来跳转（`symbol` / `timeframe` 这种） */
  data?: Record<string, string>
}

export type PushResult =
  | {ok: true}
  /** token 废了（FCM 明确说的）—— 调用方该把它标死 */
  | {ok: false; dead: true; reason: string}
  | {ok: false; dead: false; reason: string}

/**
 * 发一条到一个 token（best-effort，**不抛**）。
 */
export async function sendPush(
  token: string,
  msg: PushMessage
): Promise<PushResult> {
  const c = creds()
  if (!c) {
    console.log(`[push] 没配 FCM 服务账号（${credsError}），跳过推送`)
    return {ok: false, dead: false, reason: 'not-configured'}
  }
  const at = await accessToken()
  if (!at) return {ok: false, dead: false, reason: 'no-access-token'}

  const message = {
    message: {
      token,
      notification: {title: msg.title, body: msg.body},
      data: msg.data ?? {},
      android: {
        // 「转可做」这种是要马上看的，别等系统攒批
        priority: 'HIGH' as const,
        notification: {channel_id: 'ait-alert', default_sound: true}
      }
    }
  }
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${c.sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${at}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(15_000)
      }
    )
    if (res.ok) return {ok: true}
    const body = (await res.json().catch(() => null)) as
      | {error?: {status?: string; message?: string}}
      | null
    const status = body?.error?.status ?? ''
    const detail = `${res.status} ${status || body?.error?.message || ''}`.trim()
    /*
     * 只有这两种是「这条 token 真没了」：UNREGISTERED（卸载/清数据）
     * 和 NOT_FOUND（项目换了 / token 被删）。其余（额度、5xx）下次还发。
     */
    const dead = status === 'UNREGISTERED' || status === 'NOT_FOUND'
    return {ok: false, dead, reason: detail}
  } catch (e) {
    return {ok: false, dead: false, reason: (e as Error).name || 'error'}
  }
}
