/**
 * 账户统计的**每用户配置**（收益率基准 + 金额显示单位）。
 *
 * 用户 2026-10-09：「在配置里面选择的配置，要保存到个人的后端和个人信息中」。
 *
 * 以前这两项只写浏览器 `localStorage`（key `ait-account-stats-settings`），
 * 后果是**换设备 / 换 App / 清了浏览器数据就丢**，而且服务端完全不知情
 * （收益率是服务端算出来的口径，配置只存在客户端就更别扭了）。
 *
 * 现在按 `user_id` 存库：前端进页面读它、改完写它，个人信息里也能看到并改。
 * `localStorage` 只留作**首屏兜底**（网络失败时先用上次那份，别闪一下默认值）。
 */
import {query, queryOne} from './client'

export interface StatsSettings {
  /** 收益率基准金额（USDT），必须 > 0 */
  benchmark: number
  /** 金额显示单位 */
  currency: 'usd' | 'cny'
}

/** 没配置过时的默认值（跟前端原来的兜底一致） */
export const DEFAULT_STATS_SETTINGS: StatsSettings = {benchmark: 1000, currency: 'usd'}

/** 读某用户的配置；没配置过返回默认值（**不写库**，避免读一下就有副作用） */
export async function getStatsSettings(userId: number): Promise<StatsSettings> {
  const row = await queryOne<{benchmark: string | number; currency: string}>(
    'SELECT benchmark, currency FROM user_stats_settings WHERE user_id = $1',
    [userId]
  )
  if (!row) return {...DEFAULT_STATS_SETTINGS}
  const benchmark = Number(row.benchmark)
  return {
    benchmark:
      Number.isFinite(benchmark) && benchmark > 0
        ? benchmark
        : DEFAULT_STATS_SETTINGS.benchmark,
    currency: row.currency === 'cny' ? 'cny' : 'usd'
  }
}

/**
 * 存配置（upsert）。
 *
 * 校验口径跟前端弹窗一致：基准必须是**有限正数**；单位只认 `usd` / `cny`，
 * 其它一律落回 `usd`（不报错 —— 免得一个脏值把整次保存挡掉）。
 */
export async function saveStatsSettings(
  userId: number,
  input: unknown
): Promise<StatsSettings> {
  const raw = (input ?? {}) as {benchmark?: unknown; currency?: unknown}
  const benchmark = Number(raw.benchmark)
  if (!Number.isFinite(benchmark) || benchmark <= 0) {
    throw new Error('收益率基准必须大于 0')
  }
  const currency: StatsSettings['currency'] = raw.currency === 'cny' ? 'cny' : 'usd'
  await query(
    `INSERT INTO user_stats_settings (user_id, benchmark, currency, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
        SET benchmark = EXCLUDED.benchmark,
            currency = EXCLUDED.currency,
            updated_at = now()`,
    [userId, benchmark, currency]
  )
  return {benchmark, currency}
}
