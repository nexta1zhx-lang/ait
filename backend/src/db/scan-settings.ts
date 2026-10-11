/**
 * **自动化预测**的扫描参数（每用户一份，用户 2026-10-12）。
 *
 * 这一份原来只活在设计稿的"可调参数"表里（打算做成 env / 命令行开关），
 * 用户要求「可调参数改为前端配置 留着」—— 于是它变成**存库 + 网页上改**，
 * 跟 `db/stats-settings.ts`（账户统计的收益率基准）一个路数。
 *
 * 为什么存库而不是 localStorage：这些参数**后端要用**（扫描器按它们挑币、按它们限花费），
 * 只放浏览器就等于"网页开着才算数"——而扫描恰恰是在网页没开的时候跑。
 *
 * 一处定义、三处用：① 网页表单读它填默认值 ② 扫描器按它跑 ③ `normalize` 决定脏值怎么落。
 * ⚠️ 字段加减只改这里（`DEFAULT_SCAN_PARAMS` 是唯一真源），别在别处再写一套数字。
 */
import {query, queryOne} from './client'

/** 三条「结构性」规则的开关 + 阈值（C 类爆拉默认关，见下面 `rules.rally` 的注释） */
export interface ScanParams {
  /** 主周期（扫描看哪一档 K 线）—— 决定"多久扫一次"和规则里"24h"是几根 */
  timeframe: '15m' | '1h' | '4h'
  /** 每条规则各取成交额最大的前几名 */
  perRule: number
  /** 合并去重后总量上限（防某一类在剧烈行情里刷出上百个） */
  maxPicks: number
  /** 24h 成交额门槛（USDT）—— 低于这个数滑点吃光利润 */
  minTurnover: number
  /** 上市不足这么多天的不要（没有历史结构可看） */
  minAgeDays: number
  /**
   * **市值排名前 N 不扫**（0 = 不排除）。
   *
   * 用户 2026-10-12：「市值前 30 不扫」。
   * 起因是按成交额排序 ⇒ BTC / ETH 这类大票永远霸榜（首轮实测前三就是 BTC/ETH/SOL），
   * 而它们的"放量突破"是宏观事件、不是一笔可做的单 —— 通知它们等于每天喊"大盘动了"。
   * 排名来自 CoinGecko 那份缓存（`data/marketcap.ts`）；**拿不到排名时这条不生效**
   *（`ScanResult.rankMissing` 会标出来，网页上也会提示）。
   */
  excludeTopRank: number
  rules: {
    /** A 放量突破：收盘破前 20 根最高 + 放量 */
    breakout: boolean
    /** B 深跌转折：跌透了刚抬头 */
    dip: boolean
    /**
     * C 爆拉：24h 已经涨了很多。
     *
     * ⚠️ **默认关**，理由是实测：42 个"单日 +50%"的爆拉事件里 AI **全部**判"不能做"，
     * 而这些币之后 6h 平均还摸到 +31%（见 `docs/AI-PROMPT-EXPERIMENTS.md` 第 4 节）
     * —— 进池基本只产生"不能做"的回答 + 账单。想开就在网页上打开（这一格就是留给它的）。
     */
    rally: boolean
    /** D 量能异动：量能突然放大但价还没走出去 */
    volume: boolean
  }
  /** A 的量比门槛（近 3 根均量 / 前 21 根均量） */
  breakoutVol: number
  /** B 的跌幅门槛（%，正数：写 12 = 24h 跌 12% 以上） */
  dipPct: number
  /** B 的量比门槛 */
  dipVol: number
  /** C 的涨幅门槛（%，正数） */
  rallyPct: number
  /** D 的量比门槛 */
  spikeVol: number
}

export const DEFAULT_SCAN_PARAMS: ScanParams = {
  timeframe: '1h',
  perRule: 4,
  maxPicks: 12,
  minTurnover: 3_000_000,
  minAgeDays: 14,
  excludeTopRank: 30,
  rules: {breakout: true, dip: true, rally: false, volume: true},
  breakoutVol: 2,
  dipPct: 12,
  dipVol: 1.3,
  rallyPct: 20,
  spikeVol: 4
}

/** 数值字段的上下限 —— 网页上填歪了（负数 / 巨大值）在这里收口，别让扫描器去兜 */
const LIMITS = {
  perRule: [1, 30],
  maxPicks: [1, 60],
  minTurnover: [0, 1e12],
  minAgeDays: [0, 3650],
  excludeTopRank: [0, 500],
  breakoutVol: [1, 100],
  dipPct: [0, 100],
  dipVol: [1, 100],
  rallyPct: [0, 10000],
  spikeVol: [1, 100]
} as const satisfies Record<string, readonly [number, number]>

function clampNum(v: unknown, fallback: number, range: readonly [number, number]): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(range[1], Math.max(range[0], n))
}

/**
 * 把外面传进来的东西收成一份合法参数。
 *
 * 口径：**能修的修、不能修的落回默认**，不报错 —— 一个脏字段不该把整次保存挡掉
 * （跟 `saveStatsSettings` 一致）。
 */
export function normalizeScanParams(input: unknown): ScanParams {
  const raw = (input ?? {}) as Partial<Omit<ScanParams, 'rules'>> & {
    rules?: Partial<ScanParams['rules']>
  }
  const d = DEFAULT_SCAN_PARAMS
  const tf = raw.timeframe
  const rules: Partial<ScanParams['rules']> = raw.rules ?? {}
  return {
    timeframe: tf === '15m' || tf === '1h' || tf === '4h' ? tf : d.timeframe,
    perRule: Math.round(clampNum(raw.perRule, d.perRule, LIMITS.perRule)),
    maxPicks: Math.round(clampNum(raw.maxPicks, d.maxPicks, LIMITS.maxPicks)),
    minTurnover: clampNum(raw.minTurnover, d.minTurnover, LIMITS.minTurnover),
    minAgeDays: clampNum(raw.minAgeDays, d.minAgeDays, LIMITS.minAgeDays),
    excludeTopRank: Math.round(
      clampNum(raw.excludeTopRank, d.excludeTopRank, LIMITS.excludeTopRank)
    ),
    rules: {
      breakout: rules.breakout ?? d.rules.breakout,
      dip: rules.dip ?? d.rules.dip,
      rally: rules.rally ?? d.rules.rally,
      volume: rules.volume ?? d.rules.volume
    },
    breakoutVol: clampNum(raw.breakoutVol, d.breakoutVol, LIMITS.breakoutVol),
    dipPct: clampNum(raw.dipPct, d.dipPct, LIMITS.dipPct),
    dipVol: clampNum(raw.dipVol, d.dipVol, LIMITS.dipVol),
    rallyPct: clampNum(raw.rallyPct, d.rallyPct, LIMITS.rallyPct),
    spikeVol: clampNum(raw.spikeVol, d.spikeVol, LIMITS.spikeVol)
  }
}

/** 读某用户的参数；没配过返回默认值（**不写库**，避免读一下就有副作用） */
export async function getScanParams(userId: number | null): Promise<ScanParams> {
  if (userId === null) return {...DEFAULT_SCAN_PARAMS}
  const row = await queryOne<{params: unknown}>(
    'SELECT params FROM user_scan_settings WHERE user_id = $1',
    [userId]
  )
  if (!row) return {...DEFAULT_SCAN_PARAMS}
  return normalizeScanParams(row.params)
}

/** 存参数（upsert） */
export async function saveScanParams(
  userId: number,
  input: unknown
): Promise<ScanParams> {
  const params = normalizeScanParams(input)
  await query(
    `INSERT INTO user_scan_settings (user_id, params, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
        SET params = EXCLUDED.params,
            updated_at = now()`,
    [userId, JSON.stringify(params)]
  )
  return params
}
