/**
 * 交易所资产的落库层（2026-10-05，方案见 `docs/EXCHANGE.md`）。
 *
 * 分层：**取数**（`data/exchange-overview.ts`）只管连交易所、不碰库；
 * **落库**（本文件）只管读写快照、不连交易所。接口 / 定时任务 / WS 各取所需，
 * 不互相缠。
 *
 * ⚠️ pg 读 NUMERIC 出来是**字符串**（防精度丢），所以读的时候要 `Number()` 一遍。
 * ⚠️ 5m 原始行的 `high = low = 自身净值` —— 这样查曲线时 5m / 1h / 1d 三种粒度
 *    能用同一套 SQL（聚合出来的行才有真正的振幅，见 docs 的「聚合不取平均」）。
 */
import {query, queryOne} from './client'
import type {ExchangeOverview} from '../data/exchange-overview'

/** 这一条快照是谁写的 */
export type SnapshotSource =
  | 'poll' // 5 分钟定时采样
  | 'ws' // WS 事件触发
  | 'manual' // 用户点刷新
  | 'bind' // 刚绑上这套 key（锚点）
  | 'boot' // 进程启动（锚点）
  | 'shutdown' // 优雅退出（锚点）
  | 'snapshotApi' // 用币安日快照补的断档点
  | 'agg' // 归档聚合出来的 1h / 1d

export interface LatestSnapshot {
  /** 可以直接喂给前端 board 的那份 */
  overview: ExchangeOverview
  source: string
  /** 离现在多少秒（前端显示「3 分钟前」） */
  ageSec: number
  /** 超过 5 分钟（采样间隔）就算旧了 —— 前端据此决定要不要后台刷新 */
  stale: boolean
  /** 采集时那一侧失败留下的原因（有值说明这条数据不完整） */
  err: string | null
}

export interface SaveOptions {
  source?: SnapshotSource
  err?: string | null
  /**
   * 跟**上一条**最短间隔（秒）。>0 时太近就不写 —— WS 事件可能一秒来好几条，
   * 全写进去一天几千行纯浪费（曲线 5 分钟一个点就够了）。
   */
  minGapSec?: number
}

/**
 * 净值口径（**全仓库只有这一处**）：合约保证金余额 + C2C + 现货 USDT。
 *
 * ⚠️ 三处读的地方（`saveSnapshot` / `listCurve` / 前端 `ExchangeAccountBoard`）
 *    口径必须一致，不然列表上的「净资产」和曲线上的数会对不上。
 */
export function netOf(ov: ExchangeOverview): number {
  return r8(
    ov.futures.margin + (ov.c2c?.totalUsdt ?? 0) + (ov.spot?.usdt ?? 0)
  )
}

function r8(x: number): number {
  return Math.round(x * 1e8) / 1e8
}
function num(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** 上一条快照的时间（用来节流 + 算断档） */
async function lastTakenAt(userId: number, keyId: number): Promise<number | null> {
  const row = await queryOne<{t: string}>(
    `SELECT taken_at AS t FROM exchange_snapshots
      WHERE user_id = $1 AND key_id = $2 AND kind = '5m'
      ORDER BY taken_at DESC LIMIT 1`,
    [userId, keyId]
  )
  return row ? new Date(row.t).getTime() : null
}

/**
 * 写一条快照。
 *
 * `c2c_detail` 存的是**整个 c2c 对象**（含 `active` / `totalUsdt` / `assets`），
 * 不是只存 assets —— 读回来的时候不用再拼，少一处能对错的地方。
 */
export async function saveSnapshot(
  userId: number,
  keyId: number,
  ov: ExchangeOverview,
  opts: SaveOptions = {}
): Promise<boolean> {
  const {source = 'poll', err = null, minGapSec = 0} = opts

  if (minGapSec > 0) {
    const last = await lastTakenAt(userId, keyId)
    if (last !== null && Date.now() - last < minGapSec * 1000) return false
  }

  const net = netOf(ov)
  await query(
    `INSERT INTO exchange_snapshots
       (user_id, key_id, kind, taken_at, high, high_at, low, low_at,
        wallet, unrealized, margin, available, positions, assets,
        c2c_total, c2c_detail, spot_usdt, source, err)
     VALUES ($1, $2, '5m', now(), $3, now(), $3, now(),
             $4, $5, $6, $7, $8::jsonb, $9::jsonb,
             $10, $11::jsonb, $12, $13, $14)`,
    [
      userId,
      keyId,
      net, // 5m 行：high = low = 自身净值
      ov.futures.wallet,
      ov.futures.unrealized,
      ov.futures.margin,
      ov.futures.available,
      JSON.stringify(ov.futures.positions),
      JSON.stringify(ov.futures.assets),
      ov.c2c ? ov.c2c.totalUsdt : null,
      ov.c2c ? JSON.stringify(ov.c2c) : null,
      ov.spot ? ov.spot.usdt : null,
      source,
      err
    ]
  )
  return true
}

/** 一笔成交（从 WS 的 ORDER_TRADE_UPDATE 里拆出来的） */
export interface FillInput {
  orderId: string
  /** 币安事件里的 `t`，去重靠它 */
  tradeId: string
  symbol: string
  side: string
  price: number
  amount: number
  fee: number
  feeCcy: string
  /** 这一笔的已实现盈亏（事件里的 `rp`） */
  realized: number
  ts: Date
  raw: unknown
}

/**
 * 成交写账本 —— **幂等**（靠 `unique(key_id, trade_id)`）。
 * 返回 true = 这一笔是新的（第一次写）。
 * ⚠️ 重连后重放旧事件时全靠这个唯一键挡住，别改成普通 INSERT。
 */
export async function upsertFill(
  userId: number,
  keyId: number,
  f: FillInput
): Promise<boolean> {
  const rows = await query<{id: string}>(
    `INSERT INTO exchange_fills
       (user_id, key_id, order_id, trade_id, symbol, side, price, amount,
        cost, fee, fee_ccy, realized, ts, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     ON CONFLICT (key_id, trade_id) DO NOTHING
     RETURNING id`,
    [
      userId,
      keyId,
      f.orderId,
      f.tradeId,
      f.symbol,
      f.side,
      f.price,
      f.amount,
      r8(f.price * f.amount),
      f.fee,
      f.feeCcy || null,
      f.realized,
      f.ts,
      JSON.stringify(f.raw ?? {})
    ]
  )
  return rows.length > 0
}

/** 成交 tab 用的一行（数值都转回 number —— pg 的 NUMERIC 出来是字符串） */
export interface FillRow {
  /** 就是 `trade_id`，前端拿它当列表 key + 去重 */
  id: string
  symbol: string
  side: string
  price: number
  amount: number
  cost: number
  fee: number
  feeCurrency: string
  /** 这一笔的已实现盈亏（「盈亏」tab 就是把它按币加起来的） */
  realized: number
  datetime: string | null
}

/**
 * 账本里最近的成交。
 *
 * ⚠️ **不需要交易对** —— 这是 WS 实时落下来的（断线那段还有 REST 补），
 *    跟老接口「币安必须给交易对才能查成交」完全是两码事。
 *    `symbol` 是可选的**过滤**（K 线「订单历史」只要一个币），不是查询条件。
 */
export async function listFills(
  userId: number,
  keyId: number,
  limit = 60,
  symbol?: string
): Promise<FillRow[]> {
  const cap = Math.min(500, Math.max(1, Math.round(limit) || 60))
  const rows = await query<Record<string, unknown>>(
    `SELECT trade_id, symbol, side, price, amount, cost, fee, fee_ccy,
            realized, ts
       FROM exchange_fills
      WHERE user_id = $1 AND key_id = $2
        AND ($4::text IS NULL OR upper(symbol) = upper($4::text))
      ORDER BY ts DESC
      LIMIT $3`,
    [userId, keyId, cap, symbol ?? null]
  )
  return rows.map(r => ({
    id: String(r.trade_id ?? ''),
    symbol: String(r.symbol ?? ''),
    side: String(r.side ?? ''),
    price: num(r.price),
    amount: num(r.amount),
    cost: num(r.cost),
    fee: num(r.fee),
    feeCurrency: String(r.fee_ccy ?? ''),
    realized: num(r.realized),
    datetime: r.ts ? new Date(String(r.ts)).toISOString() : null
  }))
}

/* ---------------- 钱账本（exchange_income，2026-10-06） ---------------- */

/** 币安 income 里我们认得的类型（别的也照收，只是不单独统计） */
export const INCOME_TYPES = [
  'REALIZED_PNL',
  'COMMISSION',
  'FUNDING_FEE',
  'TRANSFER',
  'INSURANCE_CLEAR',
  'REFERRAL_KICKBACK',
  'COMMISSION_REBATE'
] as const

/** 一条收入（= 币安 `/fapi/v1/income` 的一行） */
export interface IncomeInput {
  /**
   * **去重键**（列名沿用币安的说法，但内容见 `data/exchange-trade.ts` 的
   * `incomeDedupeKey()`：成交类用 `tradeId:资产`，其它类用 `tranId:资产`）。
   *
   * ⚠️ **不是**币安那个 `tranId` 原值 —— 那个跟成交号对不上，两条写入路
   *    （WS 成交 / income 对账）会各记一遍，实测直接把手续费算成两倍。
   */
  tranId: string
  incomeType: string
  symbol: string
  asset: string
  /** 正数进钱、负数出钱 */
  amount: number
  ts: Date
  tradeId?: string
  raw?: unknown
}

/**
 * 批量写钱账本 —— **幂等**（靠 `unique(key_id, income_type, tran_id)`）。
 *
 * ⚠️ 两条写入路（WS 实时 / REST 对账）会推到同一批行上，全靠这个唯一键挡住重复，
 *    所以别改成普通 INSERT，也别把 `income_type` 从唯一键里拿掉
 *    （一笔成交同时有 REALIZED_PNL 和 COMMISSION，只用 tranId 会丢一条）。
 *
 * 返回**新写进去几条**。
 */
export async function upsertIncome(
  userId: number,
  keyId: number,
  list: IncomeInput[]
): Promise<number> {
  let added = 0
  for (const r of list) {
    const rows = await query<{id: string}>(
      `INSERT INTO exchange_income
         (user_id, key_id, tran_id, income_type, symbol, asset, amount, ts, trade_id, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (key_id, income_type, tran_id) DO NOTHING
       RETURNING id`,
      [
        userId,
        keyId,
        r.tranId,
        r.incomeType,
        r.symbol || null,
        r.asset || 'USDT',
        r.amount,
        r.ts,
        r.tradeId || null,
        JSON.stringify(r.raw ?? {})
      ]
    )
    if (rows.length) added++
  }
  return added
}

/** 钱账本里的一行（数字都转回 number —— pg 的 NUMERIC 出来是字符串） */
export interface IncomeRow {
  id: string
  /** 去重键，前端当 key 用 */
  tradeId: string
  incomeType: string
  symbol: string
  asset: string
  amount: number
  datetime: string
}

/** 最近的收入流水（「盈亏」tab 逐笔看的那份） */
export async function listIncome(
  userId: number,
  keyId: number,
  limit = 200
): Promise<IncomeRow[]> {
  const cap = Math.min(1000, Math.max(1, Math.round(limit) || 200))
  const rows = await query<Record<string, unknown>>(
    `SELECT id, tran_id, income_type, symbol, asset, amount, ts
       FROM exchange_income
      WHERE user_id = $1 AND key_id = $2
      ORDER BY ts DESC, id DESC
      LIMIT $3`,
    [userId, keyId, cap]
  )
  return rows.map(r => ({
    id: String(r.id),
    tradeId: String(r.tran_id ?? ''),
    incomeType: String(r.income_type ?? ''),
    symbol: String(r.symbol ?? ''),
    asset: String(r.asset ?? ''),
    amount: num(r.amount),
    datetime: r.ts ? new Date(String(r.ts)).toISOString() : ''
  }))
}

/**
 * 盈亏汇总 —— **交易所的口径**（正是用户那句「数据要统一用一套」）。
 *
 * `net` = 已实现 + 手续费 + 资金费 + 其它。⚠️ 手续费和资金费在币安那边本来就是
 * **负数**（出钱），所以这里是**相加**，不是相减。
 */
export interface IncomeTotals {
  realized: number
  commission: number
  funding: number
  other: number
  net: number
  count: number
}

/**
 * 汇总。`sinceDays` 给了就只算最近这些天（`null` = 全部历史）。
 *
 * ⚠️ `TRANSFER`（划转）**进「其它」但不进净**：那是**账户之间搬钱**，
 *    不是赚亏 —— 算进去会让「净盈亏」看着忽上忽下（实测 7 天里就有一笔 9.29 的划转，
 *    混进去净盈亏直接从 -0.42 变成 +8.87，完全没法看）。
 */
export async function incomeTotals(
  userId: number,
  keyId: number,
  sinceDays: number | null = null
): Promise<IncomeTotals> {
  const days = sinceDays === null ? null : Math.max(1, Math.round(sinceDays))
  const rows = await query<Record<string, unknown>>(
    `SELECT income_type, sum(amount) AS s, count(*) AS n
       FROM exchange_income
      WHERE user_id = $1 AND key_id = $2
        AND ($3::int IS NULL OR ts >= now() - make_interval(days => $3::int))
      GROUP BY income_type`,
    [userId, keyId, days]
  )
  let realized = 0
  let commission = 0
  let funding = 0
  let other = 0
  let count = 0
  for (const r of rows) {
    const type = String(r.income_type ?? '')
    const sum = num(r.s)
    count += num(r.n)
    if (type === 'REALIZED_PNL') realized += sum
    else if (type === 'COMMISSION' || type === 'COMMISSION_REBATE') commission += sum
    else if (type === 'FUNDING_FEE') funding += sum
    else if (type !== 'TRANSFER') other += sum
  }
  return {
    realized: r8(realized),
    commission: r8(commission),
    funding: r8(funding),
    other: r8(other),
    net: r8(realized + commission + funding + other),
    count
  }
}

/* ---------------- 资产曲线（M4） ---------------- */

/** 曲线上的一个点（一个时间桶） */
export interface CurvePoint {
  /** 桶起点（ISO） */
  t: string
  /** 桶内**最后一条**的净值 —— 折线画它（见 docs：「不是取平均」） */
  close: number
  /** 桶内最大：区间带上沿 */
  high: number
  /** 桶内最小：区间带下沿 */
  low: number
}

/**
 * 净资产序列（画曲线用）。
 *
 * `hours = null` ⇒ **不设下界**（看全部历史）。
 *
 * ★ 2026-10-06：归档（`exchange-archive.ts`）做了之后，这里要**三档一起读** ——
 *   5m 只留 7 天、1h 留 90 天、1d 永久，而三档的**时间区间互不重叠**
 *   （聚合完就把低档删掉），所以 `kind IN (...)` 一锅端再分桶就行，
 *   不用判断「这一段该读哪一档」，也不会重复计数。
 *
 * ⚠️ 区间带取的是**存下来的 `high` / `low` 列**，不是拿 payload 现算 ——
 *    1h / 1d 行的 `high`/`low` 是**整桶的包络**，现算会把它抹掉，
 *    而 5m 行的 `high = low = 自身净值`（见 `saveSnapshot`），两种口径本来就是同一套。
 *
 * ⚠️ 桶内**取 close / max / min，绝不取平均**：平均会把「中间爆过一次仓」这种
 *    真实的尖峰抹平（见 docs 的「聚合不取平均」）。
 * ⚠️ 净值口径 = `margin + c2c_total + spot_usdt`（`netOf()` 那一份），
 *    跟列表页那个「净资产」必须一致。
 */
export async function listCurve(
  userId: number,
  keyId: number,
  hours: number | null,
  bucketSec: number
): Promise<CurvePoint[]> {
  /** 净值口径 —— 全仓库唯一一处，跟 `netOf()` 保持一致 */
  const net = 'margin + coalesce(c2c_total, 0) + coalesce(spot_usdt, 0)'
  const rows = await query<Record<string, unknown>>(
    `SELECT to_timestamp(floor(extract(epoch FROM taken_at) / $4) * $4) AS t,
            max(coalesce(high, ${net})) AS high,
            min(coalesce(low, ${net})) AS low,
            (array_agg(${net} ORDER BY taken_at DESC))[1] AS close
       FROM exchange_snapshots
      WHERE user_id = $1 AND key_id = $2 AND kind IN ('5m', '1h', '1d')
        AND ($3::int IS NULL OR taken_at >= now() - make_interval(hours => $3::int))
      GROUP BY 1
      ORDER BY 1`,
    [
      userId,
      keyId,
      hours === null ? null : Math.max(1, Math.round(hours)),
      Math.max(60, Math.round(bucketSec))
    ]
  )
  return rows.map(r => ({
    t: new Date(String(r.t)).toISOString(),
    close: num(r.close),
    high: num(r.high),
    low: num(r.low)
  }))
}

/** 库里最早那条快照距现在多少小时（算桶宽用；没有快照时回 24） */
export async function firstSnapshotHours(
  userId: number,
  keyId: number
): Promise<number> {
  const row = await queryOne<{h: string | null}>(
    /* ⚠️ 三档都要看：`all` 跨度靠它算桶宽，只看 5m 会以为只有 7 天 */
    `SELECT extract(epoch FROM now() - min(taken_at)) / 3600 AS h
       FROM exchange_snapshots
      WHERE user_id = $1 AND key_id = $2 AND kind IN ('5m', '1h', '1d')`,
    [userId, keyId]
  )
  const h = num(row?.h)
  return h > 0 ? h : 24
}

/** 读最新一条（接口「秒开」靠它；不打交易所） */
export async function latestSnapshot(
  userId: number,
  keyId: number
): Promise<LatestSnapshot | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT taken_at, source, err, wallet, unrealized, margin, available,
            positions, assets, c2c_total, c2c_detail, spot_usdt
       FROM exchange_snapshots
      WHERE user_id = $1 AND key_id = $2 AND kind = '5m'
      ORDER BY taken_at DESC LIMIT 1`,
    [userId, keyId]
  )
  if (!row) return null

  const positions = (row.positions ?? []) as ExchangeOverview['futures']['positions']
  const takenAt = new Date(String(row.taken_at)).toISOString()
  const ageSec = Math.max(
    0,
    Math.round((Date.now() - new Date(takenAt).getTime()) / 1000)
  )
  const longCount = positions.filter(p => p.side !== 'short').length

  const overview: ExchangeOverview = {
    // account 由调用方用 key 补上（库里只存 key_id，不存名字这类展示字段）
    account: {exchange: '', name: '', sandbox: false, marketType: 'swap'},
    takenAt,
    futures: {
      wallet: num(row.wallet),
      unrealized: num(row.unrealized),
      margin: num(row.margin),
      available: num(row.available),
      used: r8(Math.max(num(row.margin) - num(row.available), 0)),
      assets: (row.assets ?? []) as ExchangeOverview['futures']['assets'],
      positions
    },
    c2c: (row.c2c_detail ?? null) as ExchangeOverview['c2c'],
    /* 老行没有这一列（NULL）⇒ 那块不显示，算净值时当 0（跟 `netOf` 一致） */
    spot:
      row.spot_usdt === null || row.spot_usdt === undefined
        ? null
        : {usdt: num(row.spot_usdt)},
    stats: {
      longCount,
      shortCount: positions.length - longCount,
      notional: r8(positions.reduce((s, p) => s + (p.notional || 0), 0)),
      unrealized: r8(positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0))
    }
  }

  return {
    overview,
    source: String(row.source ?? 'poll'),
    ageSec,
    stale: ageSec > 5 * 60,
    err: row.err === null || row.err === undefined ? null : String(row.err)
  }
}

/* ---------------- 当前挂单（exchange_open_orders，2026-10-06） ---------------- */

/** 一条挂单（对外形状跟 `data/exchange-trade.ts` 的 `OpenOrderRow` 对齐） */
export interface OpenOrderInput {
  orderId: string
  /** 币安原始符号（`1000BONKUSDT`） */
  symbol: string
  side: string
  /** 币安原始类型（`LIMIT` / `STOP_MARKET` / `TAKE_PROFIT_MARKET` …） */
  type: string
  posSide: string
  price: number | null
  stopPrice: number | null
  amount: number
  filled: number
  reduceOnly: boolean
  /** 下单时间（毫秒） */
  time: number
  raw?: unknown
}

/**
 * 写 / 更新一条挂单（幂等，靠 `unique(key_id, order_id)`）。
 *
 * 两个入口都会调它：① WS 的 `ORDER_TRADE_UPDATE`（变动时的秒级路径）；
 * ② REST 对账（兜底，把交易所真实那一份盖过来）。
 */
export async function upsertOpenOrder(
  userId: number,
  keyId: number,
  o: OpenOrderInput
): Promise<void> {
  await query(
    `INSERT INTO exchange_open_orders
       (user_id, key_id, order_id, symbol, side, type, pos_side, price, stop_price,
        amount, filled, reduce_only, ts, seen_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), $14)
     ON CONFLICT (key_id, order_id) DO UPDATE SET
       symbol      = EXCLUDED.symbol,
       side        = EXCLUDED.side,
       type        = EXCLUDED.type,
       pos_side    = EXCLUDED.pos_side,
       price       = EXCLUDED.price,
       stop_price  = EXCLUDED.stop_price,
       amount      = EXCLUDED.amount,
       filled      = EXCLUDED.filled,
       reduce_only = EXCLUDED.reduce_only,
       ts          = EXCLUDED.ts,
       seen_at     = now(),
       raw         = EXCLUDED.raw`,
    [
      userId,
      keyId,
      o.orderId,
      o.symbol,
      o.side,
      o.type,
      o.posSide,
      o.price,
      o.stopPrice,
      o.amount,
      o.filled,
      o.reduceOnly,
      new Date(o.time),
      o.raw ?? null
    ]
  )
}

/** 删掉一条挂单（成交 / 撤单 / 过期 / 被拒）。返回是否真的删掉了 */
export async function deleteOpenOrder(
  keyId: number,
  orderId: string
): Promise<boolean> {
  const rows = await query<Record<string, unknown>>(
    `DELETE FROM exchange_open_orders WHERE key_id = $1 AND order_id = $2
     RETURNING order_id`,
    [keyId, orderId]
  )
  return rows.length > 0
}

/**
 * 用 REST 查到的那一份**整体替换**某套 Key 的挂单（对账用）。
 *
 * ⚠️ 必须「**先全部标记、再删没见到的**」，不能先 `DELETE` 再插 ——
 *    中途失败会留下一个空列表，界面上就成了「一条挂单都没有」（比旧数据糟得多）。
 *    这里用一个事务：插/更新见到的 → 删掉本轮没见到的 → 一起提交。
 * 返回 `{added, removed}`（有没有变化，调用方好决定要不要推 SSE）。
 */
export async function replaceOpenOrders(
  userId: number,
  keyId: number,
  list: OpenOrderInput[]
): Promise<{added: number; removed: number}> {
  const before = await query<{order_id: string}>(
    `SELECT order_id FROM exchange_open_orders WHERE key_id = $1`,
    [keyId]
  )
  const had = new Set(before.map(r => String(r.order_id)))
  for (const o of list) await upsertOpenOrder(userId, keyId, o)
  const now = new Set(list.map(o => o.orderId))
  const gone = [...had].filter(id => !now.has(id))
  if (gone.length) {
    await query(
      `DELETE FROM exchange_open_orders
        WHERE key_id = $1 AND order_id = ANY($2::text[])`,
      [keyId, gone]
    )
  }
  const added = [...now].filter(id => !had.has(id)).length
  return {added, removed: gone.length}
}

/** 某套 Key 当前挂着的单（**本地读**，毫秒级，不打交易所） */
export async function listOpenOrdersDb(
  userId: number,
  keyId: number
): Promise<OpenOrderInput[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT order_id, symbol, side, type, pos_side, price, stop_price,
            amount, filled, reduce_only, ts
       FROM exchange_open_orders
      WHERE user_id = $1 AND key_id = $2
      ORDER BY ts DESC`,
    [userId, keyId]
  )
  return rows.map(r => ({
    orderId: String(r.order_id ?? ''),
    symbol: String(r.symbol ?? ''),
    side: String(r.side ?? ''),
    type: String(r.type ?? ''),
    posSide: String(r.pos_side ?? 'BOTH'),
    price: r.price === null || r.price === undefined ? null : num(r.price),
    stopPrice:
      r.stop_price === null || r.stop_price === undefined ? null : num(r.stop_price),
    amount: num(r.amount),
    filled: num(r.filled),
    reduceOnly: r.reduce_only === true,
    time: r.ts ? new Date(String(r.ts)).getTime() : 0
  }))
}
