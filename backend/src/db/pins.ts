/**
 * 合约行情的**置顶币种**（每个用户最多 5 个）。
 *
 * 用户 2026-10-04：「合约行情添加币种置顶功能最多 5 个，无视排行和用户绑定」。
 *
 * 三条要求分别对应：
 *   · 最多 5 个 → `MAX_PINS`，超了**报错**（不是悄悄顶掉最旧的，那样用户不知道丢了谁）
 *   · 无视排行 → 置顶的永远排在最前（排序/搜索都只是决定它们**之后**那一段）
 *   · 用户绑定 → 存库、按 `user_id` 隔离（换设备也能看到同一份置顶）
 *
 * 只存 `base`（`BTC`，不带 `/USDT`），跟 `MarketRow.base`、知识库的写法一致。
 */
import {query, queryOne} from './client'

/** 最多几个 */
export const MAX_PINS = 5

/** 允许的币种写法：大写字母数字，最长 20 位（`1000PEPE`、`BROCCOLI714` 都在这范围内） */
const BASE_RE = /^[A-Z0-9]{1,20}$/

/** `btc` / `BTCUSDT` / `BTC/USDT:USDT` 一律收成 `BTC` */
export function normalizeBase(v: unknown): string {
  let s = String(v ?? '')
    .trim()
    .toUpperCase()
  s = s.split(':')[0] ?? s
  if (s.includes('/')) s = s.split('/')[0]!
  else if (s.endsWith('USDT') && s.length > 4) s = s.slice(0, -4)
  if (!BASE_RE.test(s)) throw new Error('币种写法不对')
  return s
}

/** 这个用户置顶了哪些（按置顶顺序） */
export async function listPins(userId: number | null): Promise<string[]> {
  if (userId === null) return []
  const rows = await query<{base: string}>(
    `SELECT base FROM user_pins
      WHERE user_id = $1
      ORDER BY sort, created_at`,
    [userId]
  )
  return rows.map(r => r.base)
}

/**
 * 置顶 / 取消置顶（一个接口搞定，前端那颗星按一下就是切换）。
 * @returns 切换后的完整列表
 */
export async function togglePin(
  userId: number,
  rawBase: string
): Promise<{pins: string[]; pinned: boolean}> {
  const base = normalizeBase(rawBase)

  const exists = await queryOne<{base: string}>(
    'SELECT base FROM user_pins WHERE user_id = $1 AND base = $2',
    [userId, base]
  )
  if (exists) {
    await query('DELETE FROM user_pins WHERE user_id = $1 AND base = $2', [
      userId,
      base
    ])
    return {pins: await listPins(userId), pinned: false}
  }

  /*
   * 「计数 + 插入」写进**一条语句**：先查再用会出现「两个请求同时进来都看到 4 个」
   * 然后一起插成 6 个。这里让数据库自己数。
   */
  const rows = await query<{base: string}>(
    `INSERT INTO user_pins (user_id, base, sort)
     SELECT $1, $2, COALESCE((SELECT max(sort) + 1 FROM user_pins WHERE user_id = $1), 0)
      WHERE (SELECT count(*) FROM user_pins WHERE user_id = $1) < $3
     ON CONFLICT DO NOTHING
     RETURNING base`,
    [userId, base, MAX_PINS]
  )
  if (!rows.length) {
    throw new Error(`最多只能置顶 ${MAX_PINS} 个 —— 先取消一个再置顶`)
  }
  return {pins: await listPins(userId), pinned: true}
}

/** 清空某个用户的置顶（删号时跟着级联删，这个留给脚本用） */
export async function clearPins(userId: number): Promise<void> {
  await query('DELETE FROM user_pins WHERE user_id = $1', [userId])
}
