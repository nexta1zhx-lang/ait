import crypto from 'node:crypto'
import {query, queryOne} from './client'
import {DEFAULT_KEY_NAME, createLlmKey, type LlmKey} from './llm-keys'
import {describeDevice} from '../util/device'

/**
 * 用户系统（2026-10-04）。
 *
 * 设计上的几个取舍：
 *   · **用户名 + 密码**，密码用 Node 自带的 `scrypt` 加盐哈希（不引 bcrypt 依赖）
 *   · 登录发一个随机 token 存 `sessions`，前端放 localStorage、请求带
 *     `Authorization: Bearer <token>`（SSE 带不了请求头，所以也允许 `?token=`）
 *   · 每个用户有自己的 DeepSeek 配置（`user_llm`）—— 空串表示没设，回落到 `.env`
 *   · 预测历史 / 知识库 / 标签模板 / 用量都按 `user_id` 隔离；
 *     **第一个注册的账号**会把之前没有归属的老数据认领走
 *   · **多端登录**：每个设备一条会话，互不影响；账号能看到有哪些设备在线、
 *     单独踢掉某一台（本文件下面的 listSessions / revokeSession）
 *   · **两步验证**（TOTP）：只有管理员能开，见 `util/totp.ts` + 下面的 TOTP 一节
 */

export interface User {
  id: number
  username: string
  /** 管理员能看到「我的 → 管理」，别人看不到 */
  isAdmin: boolean
  createdAt: string
}

interface UserRaw {
  id: string
  username: string
  is_admin: boolean
  created_at: Date
}

const mapUser = (r: UserRaw): User => ({
  id: Number(r.id),
  username: r.username,
  isAdmin: Boolean(r.is_admin),
  createdAt: r.created_at.toISOString()
})

/* ------------------------------------------------------------------ */
/* 密码                                                                */
/* ------------------------------------------------------------------ */

const SCRYPT_KEYLEN = 64

/** `scrypt$<salt>$<hash>` —— 每次注册都换随机盐 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `scrypt$${salt}$${hash}`
}

/** 常量时间比较，别让「密码错在哪一位」从耗时里漏出去 */
function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, hash] = parts
  const got = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  const a = Buffer.from(got, 'hex')
  const b = Buffer.from(hash, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface Credentials {
  username: string
  password: string
}

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}$/
const PASSWORD_MIN = 6

function cleanUsername(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!USERNAME_RE.test(s))
    throw new Error('用户名只能 2~20 位（中英文、数字、下划线、减号）')
  return s
}

function cleanPassword(v: unknown): string {
  const s = String(v ?? '')
  if (s.length < PASSWORD_MIN) throw new Error(`密码至少 ${PASSWORD_MIN} 位`)
  if (s.length > 128) throw new Error('密码太长了')
  return s
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

/** 登录有效期：30 天 */
const SESSION_DAYS = 30

export interface SessionResult {
  token: string
  expiresAt: string
}

/** 登录时顺手记下的设备信息（只用来在「登录设备」里显示，不做任何安全判定） */
export interface SessionMeta {
  userAgent?: string
  ip?: string
}

/**
 * 建一条会话（= 在一台设备上登录）。
 * ⚠️ 多端登录就靠它：**每次登录都是独立一行**，互相不干扰。
 */
export async function startSession(
  userId: number,
  meta: SessionMeta = {}
): Promise<SessionResult> {
  const token = crypto.randomBytes(32).toString('hex')
  const rows = await query<{expires_at: Date}>(
    `INSERT INTO sessions (token, user_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${SESSION_DAYS} days')
     RETURNING expires_at`,
    [
      token,
      userId,
      String(meta.userAgent ?? '').slice(0, 400),
      String(meta.ip ?? '').slice(0, 64)
    ]
  )
  return {
    token,
    expiresAt: (rows[0]?.expires_at ?? new Date()).toISOString()
  }
}

/** 按 token 找用户；过期的会顺手删掉 */
export async function userByToken(token: string): Promise<User | null> {
  const t = String(token ?? '').trim()
  if (!t) return null
  const row = await queryOne<UserRaw & {expired: boolean}>(
    `SELECT u.id, u.username, u.is_admin, u.created_at,
            (s.expires_at <= now()) AS expired
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [t]
  )
  if (!row) return null
  if (row.expired) {
    await query('DELETE FROM sessions WHERE token = $1', [t]).catch(() => [])
    return null
  }
  return mapUser(row)
}

export async function deleteSession(token: string): Promise<void> {
  await query('DELETE FROM sessions WHERE token = $1', [token])
}

/** 「登录设备」里的一行 */
export interface SessionInfo {
  id: number
  device: string
  userAgent: string
  ip: string
  createdAt: string
  lastSeenAt: string
  /** 就是当前这台（前端会标「本机」，不给踢自己） */
  current: boolean
}

interface SessionRaw {
  id: string
  user_agent: string
  ip: string
  created_at: Date
  last_seen_at: Date
}

/** 这个账号当前在哪些设备上登着（最近活跃的排前面） */
export async function listSessions(
  userId: number,
  currentToken: string
): Promise<SessionInfo[]> {
  const rows = await query<SessionRaw & {token: string}>(
    `SELECT id::text, token, user_agent, ip, created_at, last_seen_at
       FROM sessions
      WHERE user_id = $1 AND expires_at > now()
      ORDER BY last_seen_at DESC, id DESC`,
    [userId]
  )
  return rows.map(r => ({
    id: Number(r.id),
    device: describeDevice(r.user_agent).label,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    current: r.token === currentToken
  }))
}

/** 踢掉某一台（只能踢自己的；返回有没有踢到） */
export async function revokeSession(
  userId: number,
  id: number
): Promise<boolean> {
  const rows = await query<{token: string}>(
    'DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token',
    [id, userId]
  )
  return rows.length > 0
}

/** 踢掉除本机以外的所有设备（换密码之外的手动保险） */
export async function revokeOtherSessions(
  userId: number,
  keepToken: string
): Promise<number> {
  const rows = await query<{token: string}>(
    'DELETE FROM sessions WHERE user_id = $1 AND token <> $2 RETURNING token',
    [userId, keepToken]
  )
  return rows.length
}

/** 刷新「最后活跃」（调用方自己限流，别每个请求都写） */
export async function touchSession(token: string): Promise<void> {
  await query('UPDATE sessions SET last_seen_at = now() WHERE token = $1', [
    token
  ])
}

/**
 * CLI / 脚本用：当前唯一那个用户的 id（第一个账号）。
 * 没有用户时返回 null —— 那样写进去的记录不属于任何人（网页上看不到）。
 */
export async function defaultUserId(): Promise<number | null> {
  const row = await queryOne<{id: string}>(
    'SELECT id FROM users ORDER BY id LIMIT 1'
  )
  return row ? Number(row.id) : null
}

/** 顺手清一次过期会话（启动 + 每天跑一次即可） */
export async function cleanupSessions(): Promise<number> {
  const rows = await query<{token: string}>(
    'DELETE FROM sessions WHERE expires_at <= now() RETURNING token'
  )
  return rows.length
}

/* ------------------------------------------------------------------ */
/* 注册 / 登录                                                         */
/* ------------------------------------------------------------------ */

export interface AuthResult {
  token: string
  expiresAt: string
  user: User
}

/**
 * 注册。
 * ⚠️ 用户名唯一靠 `users_username_idx`（lower(username)），
 * 这里先查一次给出友好提示，真正的并发唯一性由索引兜底。
 */
export async function register(input: Credentials): Promise<AuthResult> {
  const username = cleanUsername(input.username)
  const password = cleanPassword(input.password)

  const exists = await query<{id: string}>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [username]
  )
  if (exists.length) throw new Error('这个用户名已经被注册了')

  const rows = await query<UserRaw>(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, $2)
     RETURNING id, username, is_admin, created_at`,
    [username, hashPassword(password)]
  )
  const user = mapUser(rows[0])

  // 第一个账号：把没有归属的老数据（预测历史 / 知识库 / 标签模板 / 用量）
  // 全部认领走 —— 用户要求「老数据归第一个注册的账号」。
  const total = await query<{n: string}>(
    'SELECT count(*)::text AS n FROM users'
  )
  if (Number(total[0]?.n ?? 0) === 1) await claimLegacyData(user.id)

  const session = await startSession(user.id)
  return {...session, user}
}

/** 密码验过之后、真正发 token 之前的那一步（登录要分两阶段，见 server.ts） */
export interface LoginCheck {
  user: User
  /** 这个账号开没开两步验证 */
  totpEnabled: boolean
  /** 已经启用的 TOTP 密钥（base32） */
  totpSecret: string
  /** 最近用掉的时间步，防重放 */
  totpLastStep: number
}

/**
 * 校验用户名 + 密码。
 * ⚠️ **只验证，不发 token** —— 开了两步验证的账号还要过第二关
 * （见 server.ts 的 `/api/auth/login` 与 `/api/auth/totp`）。
 */
export async function checkLogin(input: Credentials): Promise<LoginCheck> {
  const username = String(input.username ?? '').trim()
  const password = String(input.password ?? '')
  if (!username || !password) throw new Error('请输入用户名和密码')

  const row = await queryOne<
    UserRaw & {
      password_hash: string
      totp_enabled: boolean
      totp_secret: string
      totp_last_step: string
    }
  >(
    `SELECT id, username, is_admin, created_at, password_hash,
            totp_enabled, totp_secret, totp_last_step
       FROM users WHERE lower(username) = lower($1)`,
    [username]
  )
  // 用户不存在 / 密码不对 给同一句提示，别帮人猜用户名
  if (!row || !verifyPassword(password, row.password_hash))
    throw new Error('用户名或密码不对')

  return {
    user: mapUser(row),
    totpEnabled: Boolean(row.totp_enabled) && Boolean(row.totp_secret),
    totpSecret: row.totp_secret,
    totpLastStep: Number(row.totp_last_step ?? 0)
  }
}

/**
 * 一步到位的登录（校验 + 发 token）。
 * ⚠️ **开了两步验证的账号不能用它** —— 会直接抛错，要走 checkLogin + 第二关。
 * 给 CLI / 脚本用。
 */
export async function login(
  input: Credentials,
  meta: SessionMeta = {}
): Promise<AuthResult> {
  const check = await checkLogin(input)
  if (check.totpEnabled) {
    throw new Error('这个账号开了两步验证，请在网页上登录并输入动态口令')
  }
  const session = await startSession(check.user.id, meta)
  return {...session, user: check.user}
}

/** 老数据（user_id IS NULL）归给第一个用户 */
export async function claimLegacyData(userId: number): Promise<void> {
  for (const t of ['analyses', 'knowledge', 'tag_templates', 'llm_usage']) {
    await query(`UPDATE ${t} SET user_id = $1 WHERE user_id IS NULL`, [
      userId
    ]).catch(e =>
      console.warn(`[users] 认领 ${t} 老数据失败:`, (e as Error).message)
    )
  }
}

/* ------------------------------------------------------------------ */
/* 两步验证（TOTP）                                                     */
/* ------------------------------------------------------------------ */

/** 给「个人信息」页显示的两步验证状态 */
export interface TotpState {
  enabled: boolean
  /** 扫了码但还没确认（有值 = 停在绑定中） */
  pending: boolean
  /** 还能用的恢复码个数 */
  recoveryLeft: number
}

export async function getTotpState(userId: number): Promise<TotpState> {
  const row = await queryOne<{
    totp_enabled: boolean
    totp_secret: string
    totp_pending: string
    recovery: {n: number}[]
  }>(
    `SELECT totp_enabled, totp_secret, totp_pending,
            COALESCE((SELECT jsonb_agg(1) FROM jsonb_array_elements(totp_recovery)), '[]'::jsonb) AS recovery
       FROM users WHERE id = $1`,
    [userId]
  )
  if (!row) return {enabled: false, pending: false, recoveryLeft: 0}
  return {
    enabled: Boolean(row.totp_enabled) && Boolean(row.totp_secret),
    pending: Boolean(row.totp_pending),
    recoveryLeft: Array.isArray(row.recovery) ? row.recovery.length : 0
  }
}

/** 记下待确认的密钥（扫码之后、输码确认之前） */
export async function setTotpPending(
  userId: number,
  secret: string
): Promise<void> {
  await query('UPDATE users SET totp_pending = $2 WHERE id = $1', [
    userId,
    secret
  ])
}

export async function readTotpPending(userId: number): Promise<string> {
  const row = await queryOne<{totp_pending: string}>(
    'SELECT totp_pending FROM users WHERE id = $1',
    [userId]
  )
  return row?.totp_pending ?? ''
}

/** 确认开启：把 pending 搬到正式列，并把恢复码的 hash 存下来 */
export async function enableTotp(
  userId: number,
  secret: string,
  recoveryHashes: string[]
): Promise<void> {
  await query(
    `UPDATE users
        SET totp_secret = $2, totp_enabled = true, totp_pending = '',
            totp_recovery = $3::jsonb, totp_last_step = 0
      WHERE id = $1`,
    [userId, secret, JSON.stringify(recoveryHashes)]
  )
}

/** 关掉两步验证（同时清掉恢复码和历史步号） */
export async function disableTotp(userId: number): Promise<void> {
  await query(
    `UPDATE users
        SET totp_secret = '', totp_enabled = false, totp_pending = '',
            totp_recovery = '[]'::jsonb, totp_last_step = 0
      WHERE id = $1`,
    [userId]
  )
}

/** 防重放：同一个时间步的 6 位码只准成功一次 */
export async function setTotpLastStep(
  userId: number,
  step: number
): Promise<void> {
  await query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [
    userId,
    step
  ])
}

/** 第二关要用的东西：这个账号 + 已启用的密钥 + 上次用掉的步号 */
export async function accountForTotp(userId: number): Promise<{
  user: User
  secret: string
  lastStep: number
} | null> {
  const row = await queryOne<
    UserRaw & {totp_secret: string; totp_last_step: string}
  >(
    `SELECT id, username, is_admin, created_at, totp_secret, totp_last_step
       FROM users WHERE id = $1`,
    [userId]
  )
  if (!row) return null
  return {
    user: mapUser(row),
    secret: row.totp_secret ?? '',
    lastStep: Number(row.totp_last_step ?? 0)
  }
}

/** 用掉一个恢复码（命中就把它从列表里删掉，一个只能用一次） */
export async function consumeRecoveryCode(
  userId: number,
  hash: string
): Promise<boolean> {
  const rows = await query<{id: string}>(
    `UPDATE users
        SET totp_recovery = (
              SELECT COALESCE(jsonb_agg(v), '[]'::jsonb)
                FROM jsonb_array_elements_text(totp_recovery) AS v
               WHERE v <> $2
            )
      WHERE id = $1
        AND totp_recovery @> to_jsonb($2::text)
      RETURNING id`,
    [userId, hash]
  )
  return rows.length > 0
}

/* ------------------------------------------------------------------ */
/* 管理员：播种 / 建号 / 改密 / 查看                                    */
/* ------------------------------------------------------------------ */

/** 管理员账号名 */
export const ADMIN_USERNAME = 'admin'

export interface EnsureAdminResult {
  /** 库里已经有管理员（正常情况） */
  hasAdmin: boolean
  /** `admin` 这个名字被普通用户占了 → 已把他提成管理员 */
  promoted: boolean
}

/**
 * 启动时**只检查**有没有管理员账号 —— **不建号、不内置密码**。
 *
 * ⚠️⚠️ 2026-10-04：原来这里会拿写死的 `admin` / `123456` 播种一个管理员，
 * 而仓库是公开的 —— 等于把后台钥匙挂在门上（读一眼源码就能登进管理页，
 * 而管理页能看到全部用户的 DeepSeek Key 明文）。**已删除。**
 *
 * 管理员账号（用户名 + 密码哈希）随**本地数据库同步**一起上来，所以这里：
 * · 已经有管理员 → 什么都不做（**绝不覆盖人家改过的密码**）
 * · `admin` 这个名字被普通用户占了 → 直接把他提成管理员
 * · 都没有 → 返回 `hasAdmin: false`，由调用方提示「把本地数据库同步上来」
 */
export async function ensureAdmin(): Promise<EnsureAdminResult> {
  const admins = await query<{id: string}>(
    'SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1'
  )
  if (admins.length) return {hasAdmin: true, promoted: false}

  const taken = await query<{id: string}>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [ADMIN_USERNAME]
  )
  if (taken.length) {
    await query('UPDATE users SET is_admin = true WHERE id = $1', [
      Number(taken[0].id)
    ])
    return {hasAdmin: true, promoted: true}
  }

  return {hasAdmin: false, promoted: false}
}

/**
 * 把服务器 `.env` 里那份 LLM 配置**搬进管理员账号**（2026-10-04）。
 *
 * 用户要求：「去掉 apikey，原有的配置移到管理员的账户」——
 * 大模型配置不再放 `.env`，而是每个用户一份（现在是「多把密钥」里的一把）。
 * 这个函数只在**管理员一把密钥都没有**时搬一次：
 *   · 搬完 `.env` 里的 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_REASONING`
 *     就可以删掉了（删了也不影响 —— 每次启动只是发现「没东西可搬」）
 *   · 已经有密钥就**绝不覆盖**（不然用户改过的模型会被 .env 打回去）
 *
 * 返回 true = 这次真的搬了。
 */
export async function seedAdminLlmFromEnv(): Promise<boolean> {
  const apiKey = (process.env.LLM_API_KEY ?? '').trim()
  if (!apiKey) return false

  const admin = await queryOne<{id: string}>(
    'SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1'
  )
  if (!admin) return false
  const userId = Number(admin.id)

  const count = await query<{n: string}>(
    'SELECT count(*)::text AS n FROM user_llm_keys WHERE user_id = $1',
    [userId]
  )
  if (Number(count[0]?.n ?? 0) > 0) return false

  await createLlmKey(userId, {
    name: DEFAULT_KEY_NAME,
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL ?? '').trim(),
    model: (process.env.LLM_MODEL ?? '').trim(),
    reasoningEffort: (process.env.LLM_REASONING ?? '').trim()
  })
  return true
}

export interface AdminUserRow extends User {
  /** 他自己的大模型密钥（管理员要能查看，明文也在里面） */
  llmKeys: LlmKey[]
  /** 有多少条分析 / 知识库 */
  stats: {analyses: number; knowledge: number}
}

/** 管理员用：所有人 + 各自的密钥 + 数据条数 */
export async function listUsersForAdmin(): Promise<AdminUserRow[]> {
  const rows = await query<UserRaw & {analyses: string; knowledge: string}>(
    `SELECT u.id, u.username, u.is_admin, u.created_at,
            (SELECT count(*) FROM analyses  a WHERE a.user_id = u.id)::text AS analyses,
            (SELECT count(*) FROM knowledge k WHERE k.user_id = u.id)::text AS knowledge
       FROM users u
      ORDER BY u.id`
  )

  // 密钥一次全捞回来再按 user_id 分组（比每人查一次省事）
  const keyRows = await query<{
    user_id: string
    id: string
    name: string
    api_key: string
    base_url: string
    model: string
    reasoning_effort: string
    is_default: boolean
    created_at: Date
    updated_at: Date
  }>(
    `SELECT user_id, id, name, api_key, base_url, model, reasoning_effort,
            is_default, created_at, updated_at
       FROM user_llm_keys
      ORDER BY user_id, is_default DESC, id`
  )
  const byUser = new Map<number, LlmKey[]>()
  for (const k of keyRows) {
    const uid = Number(k.user_id)
    const list = byUser.get(uid) ?? []
    list.push({
      id: Number(k.id),
      name: k.name,
      apiKey: k.api_key,
      baseUrl: k.base_url,
      model: k.model,
      reasoningEffort: k.reasoning_effort,
      isDefault: Boolean(k.is_default),
      createdAt: k.created_at.toISOString(),
      updatedAt: k.updated_at.toISOString()
    })
    byUser.set(uid, list)
  }

  return rows.map(r => ({
    ...mapUser(r),
    llmKeys: byUser.get(Number(r.id)) ?? [],
    stats: {analyses: Number(r.analyses), knowledge: Number(r.knowledge)}
  }))
}

/** 管理员建号 */
export async function createUser(
  input: Credentials & {isAdmin?: boolean}
): Promise<User> {
  const username = cleanUsername(input.username)
  const password = cleanPassword(input.password)
  const exists = await query<{id: string}>(
    'SELECT id FROM users WHERE lower(username) = lower($1)',
    [username]
  )
  if (exists.length) throw new Error('这个用户名已经存在了')

  const rows = await query<UserRaw>(
    `INSERT INTO users (username, password_hash, is_admin)
     VALUES ($1, $2, $3)
     RETURNING id, username, is_admin, created_at`,
    [username, hashPassword(password), Boolean(input.isAdmin)]
  )
  return mapUser(rows[0])
}

/** 管理员改别人的密码（顺手把那个人的会话全踢掉） */
export async function setUserPassword(
  id: number,
  password: unknown
): Promise<boolean> {
  const pw = cleanPassword(password)
  const rows = await query<{id: string}>(
    'UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id',
    [id, hashPassword(pw)]
  )
  if (!rows.length) return false
  await query('DELETE FROM sessions WHERE user_id = $1', [id])
  return true
}

/**
 * 管理员删号。
 * ⚠️ `analyses / knowledge / tag_templates / llm_usage` 都是
 * `ON DELETE CASCADE` —— **数据会跟着一起没**，前端必须二次确认。
 */
export async function deleteUser(id: number): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM users WHERE id = $1 RETURNING id',
    [id]
  )
  return rows.length > 0
}

/**
 * 改自己的用户名（「个人信息」页用）。
 * 重名由 `users_username_idx`（lower(username)）兜底，这里先查一次给友好提示。
 */
export async function renameUser(
  userId: number,
  username: unknown
): Promise<User> {
  const name = cleanUsername(username)
  const dup = await query<{id: string}>(
    'SELECT id FROM users WHERE lower(username) = lower($1) AND id <> $2',
    [name, userId]
  )
  if (dup.length) throw new Error('这个用户名已经被占用了')
  const rows = await query<UserRaw>(
    'UPDATE users SET username = $2 WHERE id = $1 RETURNING id, username, is_admin, created_at',
    [userId, name]
  )
  if (!rows.length) throw new Error('用户不存在')
  return mapUser(rows[0])
}

/** 改密码（顺带把其它会话踢下线） */
export async function changePassword(
  userId: number,
  oldPassword: string,
  newPassword: string
): Promise<void> {
  const row = await queryOne<{password_hash: string}>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId]
  )
  if (!row || !verifyPassword(oldPassword, row.password_hash))
    throw new Error('原密码不对')
  const pw = cleanPassword(newPassword)
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    userId,
    hashPassword(pw)
  ])
  await query('DELETE FROM sessions WHERE user_id = $1', [userId])
}

/** 校验密码（关两步验证、看密钥明文这类敏感操作前要再验一次） */
export async function verifyUserPassword(
  userId: number,
  password: string
): Promise<boolean> {
  const row = await queryOne<{password_hash: string}>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId]
  )
  return (
    Boolean(row) &&
    verifyPassword(
      String(password ?? ''),
      (row as {password_hash: string}).password_hash
    )
  )
}

/* ------------------------------------------------------------------ */
/* 大模型密钥搬去 `db/llm-keys.ts` 了（2026-10-04）                      */
/* ------------------------------------------------------------------ */

/*
 * 这里原来放的是「每个用户单条大模型配置」（UserLlmRow / getUserLlm /
 * getUserLlmOverride / saveUserLlm / clearUserLlmKey / maskKey / parseEffort）。
 * 现在升级成**多把密钥**，整块搬到 `db/llm-keys.ts`：
 *   user_llm_keys 表 + listLlmKeys / createLlmKey / updateLlmKey /
 *   deleteLlmKey / setDefaultLlmKey / resolveUserLlm / maskKey / parseEffort
 * 老的单条表 `user_llm` 已废弃，数据由 migrateLegacyLlm() 搬过去。
 */
