/**
 * **黑名单**：把某个币锁住，不让开单（用户 2026-10-10）。
 *
 * 用户原话：「在 k 线界面收藏按钮旁加个图标，点击后弹窗确认，加入黑名单后 24 小时
 * 不得开单，右侧显示倒计时，做单按钮禁用」。
 *
 * 用途是**给自己上锁**（防手痒、报复性开单），所以三条口径：
 *   · **只锁开单**，不锁平仓 —— 手里有仓还得能跑（锁住不让出是要出事的）；
 *   · **不能提前解除**：到期自动失效，接口里没有「解锁」（要改就得改库，从而有摩擦）；
 *   · 按 `user_id` + `base` 存库，换设备也带着（跟 `user_pins` 一个路数）。
 *
 * 有效性判定一律用数据库的 `now()`（`until > now()`）—— 前端那份倒计时只是显示。
 */
import {query, queryOne} from './client'
import {normalizeBase} from './pins'

/** 锁多久（小时）。用户要的就是 24 —— 写死，别做成可配。 */
export const BLACKLIST_HOURS = 24

export interface BlacklistEntry {
  /** 币种简称（`BTC`） */
  base: string
  /** 解封时刻（ISO 字符串） */
  until: string
}

/** 还在锁里的那几个（过期的不返回，也不用清库 —— 判定带 `until > now()` 就够了） */
export async function listBlacklist(userId: number | null): Promise<BlacklistEntry[]> {
  if (userId === null) return []
  const rows = await query<{base: string; until: Date}>(
    `SELECT base, until FROM user_blacklist
      WHERE user_id = $1 AND until > now()
      ORDER BY until DESC`,
    [userId]
  )
  return rows.map(r => ({
    base: r.base,
    until: new Date(String(r.until)).toISOString()
  }))
}

/**
 * 把一个币关进去 24 小时。
 *
 * ⚠️ **已经在锁里的不续期**（不把 until 往后推）：前台那颗图标在锁着的时候是禁用的，
 *    能走到这儿说明是（比如）另一个设备刚点过 —— 那种情况下把时间越推越远不合适，
 *    用户看到的就是「我明明只锁了 24 小时，怎么越锁越久」。
 * @returns 这一条最后的解锁时刻 + 是不是本来就在锁里
 */
export async function lockBase(
  userId: number,
  rawBase: string
): Promise<{entry: BlacklistEntry; already: boolean}> {
  const base = normalizeBase(rawBase)
  const now = await queryOne<{until: Date}>(
    'SELECT until FROM user_blacklist WHERE user_id = $1 AND base = $2 AND until > now()',
    [userId, base]
  )
  if (now) {
    return {
      entry: {base, until: new Date(String(now.until)).toISOString()},
      already: true
    }
  }
  const rows = await query<{until: Date}>(
    `INSERT INTO user_blacklist (user_id, base, until)
     VALUES ($1, $2, now() + interval '${BLACKLIST_HOURS} hours')
     ON CONFLICT (user_id, base)
       DO UPDATE SET until = now() + interval '${BLACKLIST_HOURS} hours'
     RETURNING until`,
    [userId, base]
  )
  return {
    entry: {base, until: new Date(String(rows[0]!.until)).toISOString()},
    already: false
  }
}

/**
 * 这个币现在锁着吗（后端**下单前**的那道闸）。
 * @returns 解锁时刻；没锁 / 已过期 → `null`
 */
export async function lockedUntil(
  userId: number | null,
  rawBase: string
): Promise<Date | null> {
  if (userId === null) return null
  let base: string
  try {
    base = normalizeBase(rawBase)
  } catch {
    /* 写法认不出来（不是币种）就不用拦，交给下面下单那步去报错 */
    return null
  }
  const row = await queryOne<{until: Date}>(
    'SELECT until FROM user_blacklist WHERE user_id = $1 AND base = $2 AND until > now()',
    [userId, base]
  )
  return row ? new Date(String(row.until)) : null
}
