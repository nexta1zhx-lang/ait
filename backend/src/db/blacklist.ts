/**
 * **黑名单**：把某个币锁住，不让开单（用户 2026-10-10）。
 *
 * 用户原话：「在 k 线界面收藏按钮旁加个图标，点击后弹窗确认，加入黑名单后 24 小时
 * 不得开单，右侧显示倒计时，做单按钮禁用」。
 * ★ 2026-10-17 用户改口：「黑名单机制改为 8 小时」。
 * ★ 2026-10-18 用户：「黑名单机制修改，可选择封禁时间，最大 24 小时……
 *   点击 8 次可取消封禁，需弹窗，像进入开发者模式那样」
 *   ⇒ 时长变成**每次自己选**（1 – 24 小时，默认 `BLACKLIST_DEFAULT_HOURS`）；
 *     另外多了一个 `unlockBase()`：只给前端那个「连点 8 下」的手势用，
 *     页面上**没有**解锁按钮 —— 摩擦还在，只是从「改库」变成「连点 8 下 + 再确认一次」。
 *
 * 用途是**给自己上锁**（防手痒、报复性开单），所以三条口径：
 *   · **只锁开单**，不锁平仓 —— 手里有仓还得能跑（锁住不让出是要出事的）；
 *   · 默认**不能提前解除**（界面上那颗图标是禁用的样子），到期自动失效；
 *   · 按 `user_id` + `base` 存库，换设备也带着（跟 `user_pins` 一个路数）。
 *
 * 有效性判定一律用数据库的 `now()`（`until > now()`）—— 前端那份倒计时只是显示。
 */
import {query, queryOne} from './client'
import {normalizeBase} from './pins'

/** 没选时长时锁多久（小时）—— 2026-10-17 用户定的 8（原来是写死 24） */
export const BLACKLIST_DEFAULT_HOURS = 8

/** 一次最多锁多久（小时）—— 用户 2026-10-18：「可选择封禁时间，最大 24 小时」 */
export const BLACKLIST_MAX_HOURS = 24

/**
 * 把外面传进来的小时数收敛成合法值。
 *
 * 前端给的是滑条 / 档位，正常不会越界；但接口是公开的（同一账号的任何客户端都能调），
 * 所以这里必须自己夹一遍 —— 不夹的话 `hours: 0` 等于没锁、`hours: 9999` 等于永久封。
 */
export function clampHours(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 1) return BLACKLIST_DEFAULT_HOURS
  return Math.min(BLACKLIST_MAX_HOURS, n)
}

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
 * 把一个币关进去 `hours` 小时（不传就用默认 8；上限 24，见 `clampHours`）。
 *
 * ⚠️ **已经在锁里的不续期**（不把 until 往后推）：前台那颗图标锁着的时候就不往「加锁」
 *    这条路上走了，能走到这儿说明是（比如）另一个设备刚点过 —— 那种情况下把时间越推越远
 *    不合适，用户看到的就是「我明明只锁了 8 小时，怎么越锁越久」。
 * @returns 这一条最后的解锁时刻 + 是不是本来就在锁里
 */
export async function lockBase(
  userId: number,
  rawBase: string,
  hours: number = BLACKLIST_DEFAULT_HOURS
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
  /* 只能给「最近交易过」的币上锁，理由见 `hasRecentTrade` */
  if (!(await hasRecentTrade(userId, base))) {
    throw new Error(
      `最近 ${TRADE_LOOKBACK_DAYS} 天没有 ${base} 的成交记录 —— ` +
        `黑名单是给刚交易过的币上锁用的，这个币现在不能加`
    )
  }
  const rows = await query<{until: Date}>(
    `INSERT INTO user_blacklist (user_id, base, until)
     VALUES ($1, $2, now() + make_interval(hours => $3::int))
     ON CONFLICT (user_id, base)
       DO UPDATE SET until = now() + make_interval(hours => $3::int)
     RETURNING until`,
    [userId, base, clampHours(hours)]
  )
  return {
    entry: {base, until: new Date(String(rows[0]!.until)).toISOString()},
    already: false
  }
}

/**
 * 提前解除（用户 2026-10-18：「点击 8 次可取消封禁，需弹窗，像进入开发者模式那样」）。
 *
 * ⚠️ 这个函数**只给那个连点手势用**：页面上没有「解锁」按钮，接口也不在导航里露出。
 *    连点 8 下 + 再确认一次，是「明知道自己在干什么」的代价，不是随手一点。
 * @returns 之前是否真的锁着（`false` = 本来就没锁 / 已经过期）
 */
export async function unlockBase(
  userId: number,
  rawBase: string
): Promise<boolean> {
  const base = normalizeBase(rawBase)
  const rows = await query<{base: string}>(
    'DELETE FROM user_blacklist WHERE user_id = $1 AND base = $2 RETURNING base',
    [userId, base]
  )
  return rows.length > 0
}

/**
 * 加黑名单的门槛：最近这么多天得有成交（用户 2026-10-14）。
 *
 * 用户原话：「加入黑名单只能是近 5 天有过交易记录的」。
 * 道理：黑名单是给**刚做过、怕自己手痒又冲回去**的币上锁用的，
 * 随便挑一个没碰过的币也能锁，锁的就不是「刚做过的单」了。
 */
export const TRADE_LOOKBACK_DAYS = 5

/**
 * 这个币最近 `TRADE_LOOKBACK_DAYS` 天有成交吗。
 *
 * 口径：只认**本地成交账本** `exchange_fills`（按 `user_id`）——
 * 它是这套系统里「你确实交易过这个币」的权威记录，一次查询就够，
 * 不用为了点一下锁去问交易所。
 *
 * ⚠️ 币种映射是 `base || 'USDT'`：正好跟 `normalizeBase()` 反过来
 *    （那个把尾巴上的 USDT 剥掉）。这套系统只做 U 本位 USDT 合约，够用。
 */
export async function hasRecentTrade(
  userId: number | null,
  base: string
): Promise<boolean> {
  if (userId === null) return false
  const row = await queryOne<{ok: number}>(
    `SELECT 1 AS ok FROM exchange_fills
      WHERE user_id = $1
        AND upper(symbol) = $2 || 'USDT'
        AND ts > now() - interval '${TRADE_LOOKBACK_DAYS} days'
      LIMIT 1`,
    [userId, base]
  )
  return row !== null
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
