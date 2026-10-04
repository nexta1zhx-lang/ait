import {query, queryOne} from './client'
import {ReasoningEffort} from '../types'

/**
 * 每个用户的大模型密钥（2026-10-04 从「一人一把」升级成「一人多把」）。
 *
 * 用户原话：「模型配置页面更改可以绑定多个 key 和模型，可以给命名，
 * 默认给一个，只有新增编辑时才弹窗，用量移到此界面，统计数据分开显示和 key 绑定」。
 *
 * 规则：
 *   · 每个人可以有**多把** Key，各自带名字 / 接口地址 / 模型 / 思考力度
 *   · 其中**恰好一把**是「默认」（用部分唯一索引 `user_llm_keys_default_idx` 保证）
 *   · 分析 / 提炼就用**默认那把**；用量会记到具体是哪把（`llm_usage.llm_key_id`）
 *   · 一把都没有时**自动建一把「默认」**（用户说的「默认给一个」），
 *     所以前端永远至少有一行可编辑
 *
 * 老的单条 `user_llm` 已废弃：`migrateLegacyLlm()` 把它搬成「默认」那把。
 */

/** 自动建出来的那把叫什么 */
export const DEFAULT_KEY_NAME = '默认'

/** 名字 / Key 的长度上限（太长的会挤爆列表） */
const MAX_NAME = 20
const MAX_KEY = 200
const MAX_BASE_URL = 200

export interface LlmKey {
  id: number
  name: string
  apiKey: string
  baseUrl: string
  model: string
  reasoningEffort: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

interface Raw {
  id: string
  name: string
  api_key: string
  base_url: string
  model: string
  reasoning_effort: string
  is_default: boolean
  created_at: Date
  updated_at: Date
}

const map = (r: Raw): LlmKey => ({
  id: Number(r.id),
  name: r.name,
  apiKey: r.api_key,
  baseUrl: r.base_url,
  model: r.model,
  reasoningEffort: r.reasoning_effort,
  isDefault: Boolean(r.is_default),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString()
})

const COLS = `id, name, api_key, base_url, model, reasoning_effort,
  is_default, created_at, updated_at`

/** 掩码：`sk-abcdef123456` → `sk-a****3456`（够认出是哪把 Key，又偷不走） */
export function maskKey(key: string): string {
  const k = key.trim()
  if (!k) return ''
  if (k.length <= 8) return '****'
  return `${k.slice(0, 4)}****${k.slice(-4)}`
}

/** 前端回传的掩码不能当真 Key 存回去 */
export function isMask(v: string): boolean {
  return v.includes('****')
}

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const

/** 'auto' / '' → null（不传参数，让模型自己决定） */
export function parseEffort(raw: unknown): ReasoningEffort {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (v === 'auto' || v === 'default' || v === '') return null
  return (EFFORTS as readonly string[]).includes(v)
    ? (v as ReasoningEffort)
    : null
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/**
 * 这个用户的所有密钥（默认那把排最前面）。
 * **一把都没有就自动建一把「默认」** —— 前端永远有东西可编辑。
 */
export async function listLlmKeys(userId: number): Promise<LlmKey[]> {
  let rows = await query<Raw>(
    `SELECT ${COLS} FROM user_llm_keys
      WHERE user_id = $1
      ORDER BY is_default DESC, id`,
    [userId]
  )
  if (!rows.length) {
    await query(
      `INSERT INTO user_llm_keys (user_id, name, is_default)
       VALUES ($1, $2, true)`,
      [userId, DEFAULT_KEY_NAME]
    )
    rows = await query<Raw>(
      `SELECT ${COLS} FROM user_llm_keys WHERE user_id = $1 ORDER BY id`,
      [userId]
    )
  }
  return rows.map(map)
}

export async function getLlmKey(
  userId: number,
  id: number
): Promise<LlmKey | null> {
  const row = await queryOne<Raw>(
    `SELECT ${COLS} FROM user_llm_keys WHERE user_id = $1 AND id = $2`,
    [userId, id]
  )
  return row ? map(row) : null
}

/** 默认那把（没有就返回 null —— 列表接口会顺手建一把） */
export async function getDefaultLlmKey(
  userId: number | null
): Promise<LlmKey | null> {
  if (userId === null) return null
  const row = await queryOne<Raw>(
    `SELECT ${COLS} FROM user_llm_keys
      WHERE user_id = $1
      ORDER BY is_default DESC, id
      LIMIT 1`,
    [userId]
  )
  return row ? map(row) : null
}

/** `loadConfig({llm})` 能吃的覆盖对象（空字段 = 用默认值） */
export interface LlmOverride {
  apiKey?: string
  baseUrl?: string
  model?: string
  reasoningEffort?: ReasoningEffort
}

export interface ResolvedLlm {
  /** 用的是哪把 Key（记进 llm_usage，统计按它分） */
  keyId: number | null
  keyName: string | null
  llm: LlmOverride
}

/**
 * 解析「这次分析用哪把 Key」—— 默认那把。
 * 返回的 `llm` 直接喂给 `loadConfig({llm})`。
 */
export async function resolveUserLlm(
  userId: number | null
): Promise<ResolvedLlm> {
  const key = await getDefaultLlmKey(userId)
  if (!key) return {keyId: null, keyName: null, llm: {}}
  const llm: LlmOverride = {}
  if (key.apiKey.trim()) llm.apiKey = key.apiKey.trim()
  if (key.baseUrl.trim()) llm.baseUrl = key.baseUrl.trim()
  if (key.model.trim()) llm.model = key.model.trim()
  if (key.reasoningEffort.trim())
    llm.reasoningEffort = parseEffort(key.reasoningEffort)
  return {keyId: key.id, keyName: key.name, llm}
}

/** 兼容旧调用点：只要覆盖对象 */
export async function getUserLlmOverride(
  userId: number | null
): Promise<LlmOverride> {
  return (await resolveUserLlm(userId)).llm
}

/* ------------------------------------------------------------------ */
/* 增删改                                                              */
/* ------------------------------------------------------------------ */

export interface SaveKeyInput {
  name?: string
  /** 留空 / 传掩码 = 不改（编辑时前端只回显掩码） */
  apiKey?: string
  baseUrl?: string
  model?: string
  reasoningEffort?: string
}

function cleanName(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim()
  if (!s) return fallback
  if (s.length > MAX_NAME) throw new Error(`名字最多 ${MAX_NAME} 个字`)
  return s
}

function cleanBaseUrl(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (s.length > MAX_BASE_URL) throw new Error('接口地址太长了')
  if (!/^https?:\/\//i.test(s)) throw new Error('接口地址要是 http(s):// 开头')
  return s
}

function cleanModel(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (s.length > 80 || /[\s=]/.test(s)) throw new Error('模型名不合法')
  return s
}

/**
 * 新建一把。
 * ⚠️ 传 `apiKey` 是掩码（`****`）时**当没填** —— 前端编辑时回显的就是掩码。
 */
export async function createLlmKey(
  userId: number,
  input: SaveKeyInput
): Promise<LlmKey> {
  const existing = await query<{n: string}>(
    'SELECT count(*)::text AS n FROM user_llm_keys WHERE user_id = $1',
    [userId]
  )
  const isFirst = Number(existing[0]?.n ?? 0) === 0
  const apiKey =
    typeof input.apiKey === 'string' && !isMask(input.apiKey)
      ? input.apiKey.trim().slice(0, MAX_KEY)
      : ''

  const row = await queryOne<Raw>(
    `INSERT INTO user_llm_keys
       (user_id, name, api_key, base_url, model, reasoning_effort, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLS}`,
    [
      userId,
      cleanName(input.name, `密钥 ${Date.now().toString().slice(-4)}`),
      apiKey,
      cleanBaseUrl(input.baseUrl) ?? '',
      cleanModel(input.model),
      String(input.reasoningEffort ?? '').trim(),
      isFirst
    ]
  )
  return map(row as Raw)
}

/** 改一把（Key 留空 / 掩码 = 不动它） */
export async function updateLlmKey(
  userId: number,
  id: number,
  input: SaveKeyInput
): Promise<LlmKey | null> {
  const current = await getLlmKey(userId, id)
  if (!current) return null

  const apiKey =
    typeof input.apiKey === 'string' &&
    input.apiKey.trim() &&
    !isMask(input.apiKey)
      ? input.apiKey.trim().slice(0, MAX_KEY)
      : current.apiKey
  const baseUrl =
    typeof input.baseUrl === 'string'
      ? (cleanBaseUrl(input.baseUrl) ?? '')
      : current.baseUrl
  const model =
    typeof input.model === 'string' ? cleanModel(input.model) : current.model
  const effort =
    typeof input.reasoningEffort === 'string'
      ? String(parseEffort(input.reasoningEffort) ?? '')
      : current.reasoningEffort
  const name =
    typeof input.name === 'string'
      ? cleanName(input.name, current.name)
      : current.name

  const rows = await query<Raw>(
    `UPDATE user_llm_keys
        SET name = $3, api_key = $4, base_url = $5, model = $6,
            reasoning_effort = $7, updated_at = now()
      WHERE user_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [userId, id, name, apiKey, baseUrl, model, effort]
  )
  return rows.length ? map(rows[0]) : null
}

/**
 * 删一把。删的若是默认那把，**自动把剩下的第一把提为默认** ——
 * 免得用户删完发现「没有默认可用了」。
 */
export async function deleteLlmKey(
  userId: number,
  id: number
): Promise<boolean> {
  const rows = await query<{is_default: boolean}>(
    'DELETE FROM user_llm_keys WHERE user_id = $1 AND id = $2 RETURNING is_default',
    [userId, id]
  )
  if (!rows.length) return false
  if (rows[0].is_default) {
    await query(
      `UPDATE user_llm_keys SET is_default = true
        WHERE id = (SELECT id FROM user_llm_keys WHERE user_id = $1 ORDER BY id LIMIT 1)`,
      [userId]
    )
  }
  return true
}

/** 设为默认（两步走：先把别人取消，再把自己设上，避开唯一索引冲突） */
export async function setDefaultLlmKey(
  userId: number,
  id: number
): Promise<boolean> {
  const exists = await getLlmKey(userId, id)
  if (!exists) return false
  await query(
    `UPDATE user_llm_keys SET is_default = false
      WHERE user_id = $1 AND is_default AND id <> $2`,
    [userId, id]
  )
  await query(
    'UPDATE user_llm_keys SET is_default = true WHERE user_id = $1 AND id = $2',
    [userId, id]
  )
  return true
}

/**
 * 只改默认那把（CLI 交互式补 Key、TTS 之类的老调用点用）。
 * 没有 Key 就自动建一把「默认」。
 */
export async function saveUserLlm(
  userId: number,
  input: SaveKeyInput
): Promise<void> {
  const key = await getDefaultLlmKey(userId)
  if (!key) {
    await createLlmKey(userId, {...input, name: DEFAULT_KEY_NAME})
    return
  }
  await updateLlmKey(userId, key.id, input)
}

/** 清空默认那把的 Key（其它字段不动） */
export async function clearUserLlmKey(userId: number): Promise<void> {
  const key = await getDefaultLlmKey(userId)
  if (!key) return
  await query(
    'UPDATE user_llm_keys SET api_key = $2, updated_at = now() WHERE id = $1',
    [key.id, '']
  )
}

/* ------------------------------------------------------------------ */
/* 老数据迁移                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把老的**单条** `user_llm` 搬成「默认」那把密钥。
 *
 * 只在「这个用户一把密钥都没有」时搬，搬完把老表那行**清空** ——
 * 这样用户以后把密钥删光也不会被老数据复活（也就天然幂等）。
 * 返回搬了几个用户。
 */
export async function migrateLegacyLlm(): Promise<number> {
  const rows = await query<{
    user_id: string
    api_key: string
    base_url: string
    model: string
    reasoning_effort: string
  }>(
    `SELECT l.user_id, l.api_key, l.base_url, l.model, l.reasoning_effort
       FROM user_llm l
      WHERE (l.api_key <> '' OR l.base_url <> '' OR l.model <> '')
        AND NOT EXISTS (
          SELECT 1 FROM user_llm_keys k WHERE k.user_id = l.user_id
        )`
  )
  for (const r of rows) {
    await query(
      `INSERT INTO user_llm_keys
         (user_id, name, api_key, base_url, model, reasoning_effort, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [
        Number(r.user_id),
        DEFAULT_KEY_NAME,
        r.api_key,
        r.base_url,
        r.model,
        r.reasoning_effort
      ]
    )
  }
  if (rows.length) {
    await query(
      `UPDATE user_llm SET api_key = '', base_url = '', model = '', reasoning_effort = ''`
    )
  }
  return rows.length
}

/**
 * 把「多密钥之前」的用量记录认领到那把唯一的密钥上。
 *
 * 背景：`llm_usage.llm_key_id` 是加多密钥时才有的列，**之前的流水全是 NULL**。
 * 于是「模型配置」页会出现自相矛盾的画面：密钥卡写「调用 0 / ¥0」，
 * 而下面用量统计写「206 次 / ¥2.08」（那点钱明明就是这把 Key 花的）。
 *
 * 判定故意保守 —— 只动说得清的那些：
 *   · 该用户**只有一把**密钥（有两把就分不清老账是哪把花的）；
 *   · 流水没绑密钥；
 *   · 流水**早于**这把密钥的创建时间 ⇒ 属于「多密钥之前」的老账。
 *     （反过来，某把密钥被删掉后由 `ON DELETE SET NULL` 留下的 NULL 记录，
 *      时间都晚于剩下这把的创建时间，不会被误领。）
 *
 * 幂等：认完就没 NULL 的了，再跑返回 0。
 *
 * @returns 认领了多少条流水
 */
export async function backfillUsageKeys(): Promise<number> {
  const rows = await query<{id: string}>(
    `UPDATE llm_usage u
        SET llm_key_id = k.id
       FROM user_llm_keys k
      WHERE u.user_id = k.user_id
        AND u.llm_key_id IS NULL
        AND u.created_at < k.created_at
        AND (SELECT count(*) FROM user_llm_keys k2 WHERE k2.user_id = u.user_id) = 1
      RETURNING u.id`
  )
  return rows.length
}
