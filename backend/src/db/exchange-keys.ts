import {query, queryOne} from './client'

/**
 * 每个用户的**交易所 API Key**（2026-10-04，可以绑多套）。
 *
 * 用户原话：「个人信息下添加交易所内容，可以新增交易所和 key，支持多个」。
 *
 * 规则：
 *   · 一个用户可以有**多套**，各自带名字 / 交易所 / 市场类型（现货 / 合约）
 *   · 其中**恰好一套**是「默认」（用部分唯一索引 `user_exchange_keys_default_idx` 保证）
 *   · 「开单分析 → 交易所账户」那一格查余额 / 订单历史时用它
 *   · **没有就自动建一套**（跟大模型密钥一个思路），前端永远有一行可编辑
 *
 * ⚠️ 真 Key **不出网**：列表接口只回掩码（`abcd****wxyz`），
 * 前端也用掩码判断「这一栏没改」。真正的明文只在**服务端**拿去连交易所。
 */

/** 自动建出来的那套叫什么 */
export const DEFAULT_EXCHANGE_KEY_NAME = '默认'

/** 名字 / 密钥的长度上限（太长的会挤爆列表） */
const MAX_NAME = 20
const MAX_CRED = 200

/** 支持的市场类型 */
export const MARKET_TYPES = ['swap', 'spot'] as const
export type ExchangeMarketType = (typeof MARKET_TYPES)[number]

export interface ExchangeKey {
  id: number
  /** ccxt 交易所 id */
  exchange: string
  name: string
  apiKey: string
  secret: string
  /** okx / kucoin 这类要的 passphrase */
  password: string
  marketType: string
  sandbox: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

interface Raw {
  id: string
  exchange: string
  name: string
  api_key: string
  secret: string
  password: string
  market_type: string
  sandbox: boolean
  is_default: boolean
  created_at: Date
  updated_at: Date
}

const map = (r: Raw): ExchangeKey => ({
  id: Number(r.id),
  exchange: r.exchange,
  name: r.name,
  apiKey: r.api_key,
  secret: r.secret,
  password: r.password,
  marketType: r.market_type,
  sandbox: Boolean(r.sandbox),
  isDefault: Boolean(r.is_default),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString()
})

const COLS = `id, exchange, name, api_key, secret, password, market_type,
  sandbox, is_default, created_at, updated_at`

/** 掩码：`abcd1234wxyz` → `abcd****wxyz`（够认出是哪把，又偷不走） */
export function maskCred(v: string): string {
  const s = v.trim()
  if (!s) return ''
  if (s.length <= 8) return '****'
  return `${s.slice(0, 4)}****${s.slice(-4)}`
}

/** 前端回传的掩码不能当真 Key 存回去 */
export function isMask(v: string): boolean {
  return v.includes('****')
}

function cleanName(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim()
  if (!s) return fallback
  if (s.length > MAX_NAME) throw new Error(`名字最多 ${MAX_NAME} 个字`)
  return s
}

function cleanExchange(v: unknown, fallback = 'binance'): string {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  return s ? s.slice(0, 40) : fallback
}

function cleanMarketType(v: unknown, fallback = 'swap'): ExchangeMarketType {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
  return (MARKET_TYPES as readonly string[]).includes(s)
    ? (s as ExchangeMarketType)
    : (fallback as ExchangeMarketType)
}

function cleanCred(v: unknown): string {
  return String(v ?? '')
    .trim()
    .slice(0, MAX_CRED)
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/**
 * 这个用户的所有交易所 Key（默认那套排最前面）。
 * **一套都没有就自动建一套「默认」** —— 前端永远有东西可编辑。
 */
export async function listExchangeKeys(
  userId: number
): Promise<ExchangeKey[]> {
  let rows = await query<Raw>(
    `SELECT ${COLS} FROM user_exchange_keys
      WHERE user_id = $1
      ORDER BY is_default DESC, id`,
    [userId]
  )
  if (!rows.length) {
    await query(
      `INSERT INTO user_exchange_keys (user_id, exchange, name, is_default)
       VALUES ($1, 'binance', $2, true)`,
      [userId, DEFAULT_EXCHANGE_KEY_NAME]
    )
    rows = await query<Raw>(
      `SELECT ${COLS} FROM user_exchange_keys WHERE user_id = $1 ORDER BY id`,
      [userId]
    )
  }
  return rows.map(map)
}

export async function getExchangeKey(
  userId: number,
  id: number
): Promise<ExchangeKey | null> {
  const row = await queryOne<Raw>(
    `SELECT ${COLS} FROM user_exchange_keys WHERE user_id = $1 AND id = $2`,
    [userId, id]
  )
  return row ? map(row) : null
}

/** 默认那套（没有就返回 null） */
export async function getDefaultExchangeKey(
  userId: number
): Promise<ExchangeKey | null> {
  const row = await queryOne<Raw>(
    `SELECT ${COLS} FROM user_exchange_keys
      WHERE user_id = $1
      ORDER BY is_default DESC, id
      LIMIT 1`,
    [userId]
  )
  return row ? map(row) : null
}

/* ------------------------------------------------------------------ */
/* 增删改                                                              */
/* ------------------------------------------------------------------ */

export interface SaveExchangeKeyInput {
  exchange?: string
  name?: string
  /** 留空 / 传掩码 = 不改（编辑时前端只回显掩码） */
  apiKey?: string
  secret?: string
  password?: string
  marketType?: string
  sandbox?: boolean
}

/**
 * 新建一套。
 * ⚠️ 传掩码（`****`）时**当没填** —— 前端编辑时回显的就是掩码。
 */
export async function createExchangeKey(
  userId: number,
  input: SaveExchangeKeyInput
): Promise<ExchangeKey> {
  const existing = await query<{n: string}>(
    'SELECT count(*)::text AS n FROM user_exchange_keys WHERE user_id = $1',
    [userId]
  )
  const isFirst = Number(existing[0]?.n ?? 0) === 0
  const apiKey =
    typeof input.apiKey === 'string' && !isMask(input.apiKey)
      ? cleanCred(input.apiKey)
      : ''
  const secret =
    typeof input.secret === 'string' && !isMask(input.secret)
      ? cleanCred(input.secret)
      : ''
  const password =
    typeof input.password === 'string' && !isMask(input.password)
      ? cleanCred(input.password)
      : ''

  const row = await queryOne<Raw>(
    `INSERT INTO user_exchange_keys
       (user_id, exchange, name, api_key, secret, password, market_type,
        sandbox, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLS}`,
    [
      userId,
      cleanExchange(input.exchange),
      cleanName(input.name, `交易所 ${Date.now().toString().slice(-4)}`),
      apiKey,
      secret,
      password,
      cleanMarketType(input.marketType),
      input.sandbox === true,
      isFirst
    ]
  )
  return map(row as Raw)
}

/** 改一套（密钥留空 / 掩码 = 不动它） */
export async function updateExchangeKey(
  userId: number,
  id: number,
  input: SaveExchangeKeyInput
): Promise<ExchangeKey | null> {
  const current = await getExchangeKey(userId, id)
  if (!current) return null

  const cred = (
    v: unknown,
    keep: string
  ): string =>
    typeof v === 'string' && v.trim() && !isMask(v) ? cleanCred(v) : keep
  const name =
    typeof input.name === 'string'
      ? cleanName(input.name, current.name)
      : current.name
  const exchange =
    typeof input.exchange === 'string'
      ? cleanExchange(input.exchange, current.exchange)
      : current.exchange
  const marketType =
    typeof input.marketType === 'string'
      ? cleanMarketType(input.marketType, current.marketType as ExchangeMarketType)
      : current.marketType
  const sandbox =
    typeof input.sandbox === 'boolean' ? input.sandbox : current.sandbox

  const rows = await query<Raw>(
    `UPDATE user_exchange_keys
        SET exchange = $3, name = $4, api_key = $5, secret = $6,
            password = $7, market_type = $8, sandbox = $9, updated_at = now()
      WHERE user_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [
      userId,
      id,
      exchange,
      name,
      cred(input.apiKey, current.apiKey),
      cred(input.secret, current.secret),
      cred(input.password, current.password),
      marketType,
      sandbox
    ]
  )
  return rows.length ? map(rows[0]) : null
}

/**
 * 删一套。删的若是默认那套，**自动把剩下的第一套提为默认** ——
 * 免得用户删完发现「没有默认可用了」。
 */
export async function deleteExchangeKey(
  userId: number,
  id: number
): Promise<boolean> {
  const rows = await query<{is_default: boolean}>(
    'DELETE FROM user_exchange_keys WHERE user_id = $1 AND id = $2 RETURNING is_default',
    [userId, id]
  )
  if (!rows.length) return false
  if (rows[0].is_default) {
    await query(
      `UPDATE user_exchange_keys SET is_default = true
        WHERE id = (SELECT id FROM user_exchange_keys WHERE user_id = $1 ORDER BY id LIMIT 1)`,
      [userId]
    )
  }
  return true
}

/** 设为默认（两步走：先把别人取消，再把自己设上，避开唯一索引冲突） */
export async function setDefaultExchangeKey(
  userId: number,
  id: number
): Promise<boolean> {
  const exists = await getExchangeKey(userId, id)
  if (!exists) return false
  await query(
    `UPDATE user_exchange_keys SET is_default = false
      WHERE user_id = $1 AND is_default AND id <> $2`,
    [userId, id]
  )
  await query(
    'UPDATE user_exchange_keys SET is_default = true WHERE user_id = $1 AND id = $2',
    [userId, id]
  )
  return true
}
