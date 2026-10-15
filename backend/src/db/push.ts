/**
 * **App 推送的 token 仓储**（2026-10-15 用户：「加入 app 推送」）。
 *
 * 一个用户多台设备 = 多行。token 由 App 启动时报上来（`POST /api/push/token`），
 * 服务端拿它发 FCM（见 `notify/push.ts`）。
 *
 * ⚠️ token 是会变的（重装 / 清数据 / FCM 自己轮换）：上报走 UPSERT（同一个 token 换用户也要跟着变），
 *    发失败且 FCM 明确说「这个 token 没了」时**标死**（`disabled_at`），
 *    否则每次都会拿着一条废 token 白跑一趟。
 */
import {query} from './client'

export interface PushTokenRow {
  token: string
  userId: number
  platform: string
  device: string
  disabledAt: string | null
  lastError: string | null
}

interface Raw {
  token: string
  user_id: string
  platform: string
  device: string
  disabled_at: Date | null
  last_error: string | null
}

const COLS = 'token, user_id, platform, device, disabled_at, last_error'

const map = (r: Raw): PushTokenRow => ({
  token: r.token,
  userId: Number(r.user_id),
  platform: r.platform,
  device: r.device,
  disabledAt: r.disabled_at ? new Date(r.disabled_at).toISOString() : null,
  lastError: r.last_error
})

/**
 * 上报 / 换新一条 token。
 *
 * ★ UPSERT 而不是 INSERT：同一台设备重装后 FCM 给的 token 会变，但**同一个 token
 *   也可能换了用户**（同一台手机换账号登录）—— 所以 `user_id` 跟着覆盖，
 *   并且**顺手把 disabled_at 清掉**（这次是真的又收到了上报，说明它还活着）。
 */
export async function savePushToken(input: {
  userId: number
  token: string
  platform?: string
  device?: string
}): Promise<void> {
  const token = input.token.trim()
  if (!token) return
  await query(
    `INSERT INTO push_tokens (token, user_id, platform, device)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            platform = EXCLUDED.platform,
            device = EXCLUDED.device,
            disabled_at = NULL,
            last_error = NULL,
            updated_at = now()`,
    [
      token,
      input.userId,
      (input.platform ?? 'android').slice(0, 16),
      (input.device ?? '').slice(0, 120)
    ]
  )
}

/** 这个用户**还能用**的 token（标死的不算） */
export async function listPushTokens(userId: number): Promise<PushTokenRow[]> {
  const rows = await query<Raw>(
    `SELECT ${COLS} FROM push_tokens
      WHERE user_id = $1 AND disabled_at IS NULL
      ORDER BY updated_at DESC`,
    [userId]
  )
  return rows.map(map)
}

/**
 * 这个用户的**全部**设备记录（含已经标死的）—— 给「我的 → 设备」那张卡看，
 * 用来回答「为什么我手机收不到」：没上报过？被标死了？上次错在什么？
 */
export async function listPushDevices(userId: number): Promise<PushTokenRow[]> {
  const rows = await query<Raw>(
    `SELECT ${COLS} FROM push_tokens WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId]
  )
  return rows.map(map)
}

/** 主动注销（App 里退出登录 / 关掉推送开关时调） */
export async function dropPushToken(userId: number, token: string): Promise<void> {
  await query('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2', [
    userId,
    token.trim()
  ])
}

/** FCM 说这条 token 已经没用了（`UNREGISTERED` / `NOT_FOUND`）⇒ 标死，别再发 */
export async function disablePushToken(token: string, reason: string): Promise<void> {
  await query(
    `UPDATE push_tokens
        SET disabled_at = now(), last_error = $2, updated_at = now()
      WHERE token = $1 AND disabled_at IS NULL`,
    [token, reason.slice(0, 200)]
  )
}

/** 发失败但**不是** token 废了（额度 / 5xx）⇒ 只记一句，下次还发 */
export async function notePushError(token: string, reason: string): Promise<void> {
  await query(
    'UPDATE push_tokens SET last_error = $2, updated_at = now() WHERE token = $1',
    [token, reason.slice(0, 200)]
  )
}
