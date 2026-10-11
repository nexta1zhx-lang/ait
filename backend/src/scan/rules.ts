/**
 * **自动化的第一步：选币（候选池）**。
 *
 * 职责只有一个：从全市场（当前 525 个 U 本位永续）里挑出**少数几个值得花一次钱问 AI 的**。
 * 不调 AI、不落 `analyses`、不推通知 —— 那些是后面几段的事。
 *
 * ## 为什么不是"全市场都问一遍"
 *
 * `docs/AI-PROMPT-EXPERIMENTS.md` 里三批实测（≈490 次调用）的结论是
 * **让 AI 判"能不能做"没跑赢随机**；唯一稳定跑赢的是一条零成本规则。所以这里的定位是：
 *
 *   · **四条结构性规则（纯 SQL，0 成本、0 上游权重）负责"值得看一眼"**；
 *   · AI 只负责"把这几个用一句人话说清楚"（快讯式）；
 *   · 通知只在结论有意义时发。
 *
 * ## 数据从哪来
 *
 * 只读**本地 `candles`**（底座的 1h 有 6 个月、1d 有 1.5 年，全市场都在），
 * 所以"扫 525 个币"这件事本身免费，而且**可复现**（同一时刻同参数结果一样）——
 * 这是后面能做后验复盘的前提。⚠️ 不用 `quote_volume` 列（实测基本是 0），
 * 成交额一律用 `sum(close * volume)` 估。
 *
 * ## 四类规则
 *
 * | | 判据 | 抓什么 |
 * |---|---|---|
 * | A 放量突破 | 收盘 > 前 20 根最高，且近 3 根均量 ≥ N× 前 21 根均量 | 真突破 |
 * | B 深跌转折 | 24h ≤ −N%，最近 3 根不再创新低，拐头，放量 | 跌透了刚抬头 |
 * | C 爆拉 | 24h ≥ +N%（**默认关**，见 `ScanParams.rules.rally`） | 已经在飞的 |
 * | D 量能异动 | 近 3 根均量 ≥ N× 基准，且不满足 A | 有事正在发生，价还没动 |
 *
 * ⚠️ 判突破用 **收盘价**而不是最高价 —— 插针不算突破（这是最容易误报的地方）。
 * ⚠️ 一律用**最后一根已收盘的 K 线**当"现在"（`at` = 那根的 `open_time` + 一根），
 *    正在长的那根不参与，否则同一时刻重跑结果会变。
 */
import {query} from '../db/client'
import {marketCapRanks, rankOf} from '../data/marketcap'
import type {ScanParams} from '../db/scan-settings'

/** 规则代号 —— 前端原样显示，别改字面量 */
export type RuleKey = 'A' | 'B' | 'C' | 'D'

export const RULE_LABELS: Record<RuleKey, string> = {
  A: '放量突破',
  B: '深跌转折',
  C: '爆拉',
  D: '量能异动'
}

/** 一条候选 */
export interface ScanPick {
  /** 币种简称（`BTC`；实测也有 `哈基米` 这类中文名） */
  base: string
  /** ccxt 统一符号（`BTC/USDT:USDT`） */
  symbol: string
  /** 命中的规则（可能多条，如 `['A','D']`） */
  rules: RuleKey[]
  /** 规则中文名，给 AI 和界面看 */
  ruleLabels: string[]
  /** 最后一根已收盘 K 线的收盘价 */
  price: number
  /** 24h 涨跌 %（收盘对收盘） */
  pct24: number
  /** 24h 成交额（USDT，估算 = Σ close×volume） */
  turnover24: number
  /** 量比：近 3 根均量 / 前 21 根均量 */
  volRatio: number
  /** 现价 / 前 20 根最高 − 1（离突破多远，负数 = 还没破） */
  vsHigh20: number
  /** 现价 / 24h 最低 − 1（离底部多远） */
  offLow24: number
  /** 市值排名（CoinGecko 缓存，可能为 null） */
  rank: number | null
}

export interface ScanResult {
  /** 这一轮看的"现在"（最后一根已收盘 K 线的收盘时刻，ISO，UTC） */
  at: string
  timeframe: ScanParams['timeframe']
  /** 参与打分的币数（过了状态 / 新币 / 成交额门槛，且数据够长） */
  scanned: number
  /** 因为「市值前 N」被排掉的有几个（给界面用；`rankMissing` 时会明显偏少） */
  excludedTop: number
  /**
   * 市值排名没拉到（CoinGecko 挂了 / 没缓存）⇒「市值前 N 不扫」**这条没生效**。
   * ⚠️ 必须报出来：不然会静默地把大票又放回候选里，而人以为它一直开着。
   */
  rankMissing: boolean
  /** 各类规则命中的**原始**个数（去重 / 配额之前的，用来看阈值松紧） */
  ruleHits: Record<RuleKey, number>
  picks: ScanPick[]
  /** 这一轮跑了多少毫秒 */
  ms: number
}

/** 24 小时 = 几根主周期 K 线 */
function barsPerDay(timeframe: ScanParams['timeframe']): number {
  return timeframe === '15m' ? 96 : timeframe === '1h' ? 24 : 6
}

/** 一根多少毫秒（算 `at` 用） */
const TF_MS: Record<ScanParams['timeframe'], number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000
}

/** SQL 里那一行的形状（时间字段是 Date，别当字符串用） */
interface AggRow {
  base: string
  symbol: string
  c0: number | null
  c3: number | null
  c_prev: number | null
  hi20: number | null
  lo3: number | null
  lo21: number | null
  low24: number | null
  v3: number | null
  v21: number | null
  turnover24: number | null
  bar_time: Date | null
  n: string | number
}

/**
 * 一条 SQL 把每个币的聚合一次算完（窗口函数 + FILTER）。
 *
 * 参数：$1 交易所 $2 市场类型 $3 周期 $4 截止时刻（null = 用库里最新）
 *      $5 回看秒数 $6 一天的根数 $7 成交额门槛 $8 排除的 base $9 最小上市天数
 */
const AGG_SQL = `
WITH t AS (
  SELECT COALESCE($4::timestamptz,
                  (SELECT max(open_time) FROM candles
                    WHERE exchange = $1 AND market_type = $2 AND interval = $3)) AS m
), scope AS (
  SELECT c.symbol, c.open_time, c.high, c.low, c.close, c.volume,
         row_number() OVER (PARTITION BY c.symbol ORDER BY c.open_time DESC) AS rn
    FROM candles c, t
   WHERE c.exchange = $1 AND c.market_type = $2 AND c.interval = $3
     AND c.open_time <= t.m
     AND c.open_time >  t.m - make_interval(secs => $5::int)
), agg AS (
  SELECT symbol,
    max(close)  FILTER (WHERE rn = 1)      AS c0,
    max(close)  FILTER (WHERE rn = 4)      AS c3,
    max(close)  FILTER (WHERE rn = $6 + 1) AS c_prev,
    max(high)   FILTER (WHERE rn BETWEEN 2 AND 21)  AS hi20,
    min(low)    FILTER (WHERE rn BETWEEN 1 AND 3)   AS lo3,
    min(low)    FILTER (WHERE rn BETWEEN 4 AND 24)  AS lo21,
    min(low)    FILTER (WHERE rn BETWEEN 1 AND $6)  AS low24,
    avg(volume) FILTER (WHERE rn BETWEEN 1 AND 3)   AS v3,
    avg(volume) FILTER (WHERE rn BETWEEN 4 AND 24)  AS v21,
    sum(close * volume) FILTER (WHERE rn BETWEEN 1 AND $6) AS turnover24,
    max(open_time) FILTER (WHERE rn = 1)   AS bar_time,
    count(*)                               AS n
  FROM scope
  GROUP BY symbol
)
SELECT a.symbol, s.base, a.c0, a.c3, a.c_prev, a.hi20, a.lo3, a.lo21, a.low24,
       a.v3, a.v21, a.turnover24, a.bar_time, a.n
  FROM agg a
  JOIN symbols s ON s.symbol = a.symbol
                  AND s.exchange = $1 AND s.market_type = $2
 WHERE s.status = 'TRADING'
   AND (s.onboard_at IS NULL
        OR s.onboard_at <= (SELECT m FROM t) - make_interval(days => $9::int))
   AND a.n >= $6 + 24
   AND a.v21 > 0
   AND a.turnover24 >= $7
   AND NOT (s.base = ANY($8::text[]))
 ORDER BY a.turnover24 DESC
`

/** 兜住 null（K 线里的 0 是真的 0，别把 0 当缺失） */
function safe(v: number | null): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 挑这一轮的候选。
 *
 * @param userId 拿黑名单用（null = 不排除任何币）
 * @param params 扫描参数（网页上配的那份）
 * @param at     只看到这一刻为止（毫秒）；null = 库里最新那根已收盘的
 *               —— 这个口子留着做"回放复盘"（同一时刻重跑结果必须一致）
 */
export async function pickCandidates(opts: {
  userId: number | null
  params: ScanParams
  at?: number | null
}): Promise<ScanResult> {
  const t0 = Date.now()
  const {params} = opts
  const timeframe = params.timeframe
  const bars = barsPerDay(timeframe)

  /** 排除名单：黑名单里还在锁着的（按 base 比 —— SQL 里 `symbols.base` 才是展示口径） */
  let excluded: string[] = []
  if (opts.userId !== null) {
    const rows = await query<{base: string}>(
      `SELECT base FROM user_blacklist WHERE user_id = $1 AND until > now()`,
      [opts.userId]
    )
    excluded = rows.map(r => r.base)
  }

  // 回看：一天的根数 + 24 根（`lo21` 用到 24 根、`v21` 用到 24 根），再留些余量
  const lookbackSecs = (bars + 30) * Math.round(TF_MS[timeframe] / 1000)

  const rows = await query<AggRow>(AGG_SQL, [
    'binance',
    'swap',
    timeframe,
    opts.at ? new Date(opts.at).toISOString() : null,
    lookbackSecs,
    bars,
    params.minTurnover,
    excluded,
    params.minAgeDays
  ])

  const ranks = marketCapRanks()
  const ruleHits: Record<RuleKey, number> = {A: 0, B: 0, C: 0, D: 0}
  /** 市值排名前 N 被排除的个数 */
  let excludedTop = 0
  /** symbol → 候选（同一币命中多条规则时合并） */
  const bySymbol = new Map<string, ScanPick>()

  for (const r of rows) {
    const c0 = safe(r.c0)
    const cPrev = safe(r.c_prev)
    if (!c0 || !cPrev) continue

    /*
     * 「市值前 N 不扫」（用户 2026-10-12）：按成交额排必然把 BTC / ETH 顶在最前面，
     * 而它们的放量突破是宏观事件（不是一笔可做的单）—— 通知它们等于每天喊"大盘动了"。
     * ⚠️ 排名拿不到（`ranks` 空）时这条**不生效**，靠 `rankMissing` 报出去。
     */
    const rank = rankOf(ranks, r.base)
    if (params.excludeTopRank > 0 && rank !== null && rank <= params.excludeTopRank) {
      excludedTop += 1
      continue
    }

    const pct24 = (c0 / cPrev - 1) * 100
    const volRatio = safe(r.v3) / safe(r.v21)
    const hi20 = safe(r.hi20)
    const low24 = safe(r.low24)
    const vsHigh20 = hi20 > 0 ? c0 / hi20 - 1 : 0
    const offLow24 = low24 > 0 ? c0 / low24 - 1 : 0

    const keys: RuleKey[] = []
    // A 放量突破：收盘破前高 + 放量（用收盘，插针不算）
    if (params.rules.breakout && vsHigh20 > 0 && volRatio >= params.breakoutVol) keys.push('A')
    // B 深跌转折：24h 跌够 + 不再创新低 + 拐头 + 放量
    if (
      params.rules.dip &&
      pct24 <= -params.dipPct &&
      safe(r.lo3) > safe(r.lo21) &&
      c0 > safe(r.c3) &&
      volRatio >= params.dipVol
    )
      keys.push('B')
    // C 爆拉
    if (params.rules.rally && pct24 >= params.rallyPct) keys.push('C')
    // D 量能异动（已经算突破的不重复算）
    if (params.rules.volume && volRatio >= params.spikeVol && !keys.includes('A')) keys.push('D')

    if (!keys.length) continue
    for (const k of keys) ruleHits[k] += 1

    const prev = bySymbol.get(r.symbol)
    if (prev) {
      for (const k of keys) if (!prev.rules.includes(k)) prev.rules.push(k)
      prev.ruleLabels = prev.rules.map(k => RULE_LABELS[k])
      continue
    }

    bySymbol.set(r.symbol, {
      base: r.base,
      symbol: r.symbol,
      rules: keys,
      ruleLabels: keys.map(k => RULE_LABELS[k]),
      price: c0,
      pct24,
      turnover24: safe(r.turnover24),
      volRatio,
      vsHigh20,
      offLow24,
      rank
    })
  }

  /*
   * 配额：**先按规则分类各取前 N，再合并**。
   *
   * 为什么不直接按成交额排前 12：剧烈行情里会被 D 类（量能异动）刷屏 ——
   * 那是"吵"的一类，不是"值得看"的一类。每类各留几个，四类才有均等的曝光机会。
   * 类内排序：成交额降序 → 命中规则条数降序（多重信号更值钱）。
   */
  const all = [...bySymbol.values()]
  const byRule: Record<RuleKey, ScanPick[]> = {A: [], B: [], C: [], D: []}
  for (const p of all) for (const k of p.rules) byRule[k].push(p)

  const picked: ScanPick[] = []
  const taken = new Set<string>()
  for (const k of ['A', 'B', 'C', 'D'] as RuleKey[]) {
    byRule[k].sort((a, b) => b.turnover24 - a.turnover24 || b.rules.length - a.rules.length)
    for (const p of byRule[k].slice(0, params.perRule)) {
      if (taken.has(p.symbol)) continue
      taken.add(p.symbol)
      picked.push(p)
    }
  }

  // 全局再排一次 + 总量上限（口径与类内一致，保证"最值钱的在最上面"）
  picked.sort((a, b) => b.turnover24 - a.turnover24 || b.rules.length - a.rules.length)
  const final = picked.slice(0, params.maxPicks)

  /*
   * "现在" = 最后一根已收盘 K 线的**收盘时刻**：库里 `bar_time` 是那根的 open_time，
   * 所以要加一根的时长。一行都没有（空库 / 时间点太早）就退回"现在"。
   */
  let lastBar: Date | null = null
  for (const r of rows) {
    if (!r.bar_time) continue
    const d = new Date(r.bar_time)
    if (!lastBar || d > lastBar) lastBar = d
  }
  const at = lastBar
    ? new Date(lastBar.getTime() + TF_MS[timeframe]).toISOString()
    : new Date().toISOString()

  return {
    at,
    timeframe,
    scanned: rows.length,
    excludedTop,
    rankMissing: ranks.size === 0,
    ruleHits,
    picks: final,
    ms: Date.now() - t0
  }
}
