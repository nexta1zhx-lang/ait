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

/** 净资产 = 合约保证金余额 + C2C（折 USDT） */
export function netOf(ov: ExchangeOverview): number {
  return r8(ov.futures.margin + (ov.c2c?.totalUsdt ?? 0))
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
        c2c_total, c2c_detail, source, err)
     VALUES ($1, $2, '5m', now(), $3, now(), $3, now(),
             $4, $5, $6, $7, $8::jsonb, $9::jsonb,
             $10, $11::jsonb, $12, $13)`,
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
 */
export async function listFills(
  userId: number,
  keyId: number,
  limit = 60
): Promise<FillRow[]> {
  const cap = Math.min(500, Math.max(1, Math.round(limit) || 60))
  const rows = await query<Record<string, unknown>>(
    `SELECT trade_id, symbol, side, price, amount, cost, fee, fee_ccy,
            realized, ts
       FROM exchange_fills
      WHERE user_id = $1 AND key_id = $2
      ORDER BY ts DESC
      LIMIT $3`,
    [userId, keyId, cap]
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

/** 读最新一条（接口「秒开」靠它；不打交易所） */
export async function latestSnapshot(
  userId: number,
  keyId: number
): Promise<LatestSnapshot | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT taken_at, source, err, wallet, unrealized, margin, available,
            positions, assets, c2c_total, c2c_detail
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
