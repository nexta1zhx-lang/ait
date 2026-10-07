/**
 * 合约**生命周期**表（表结构见 `schema.ts` 的 `symbols`）。
 *
 * 回答两个问题，别的什么都不做：
 *   1. 这个币现在该不该有实时数据（`status === 'TRADING'`）？
 *   2. 它什么时候上线的（`onboard_at`）、什么时候下架的（`delisted_at`）？
 *
 * ⚠️ `delisted_at` **只在 TRADING → 其它 的那一刻写一次**，之后不再改
 *    （否则每天刷新都会把它顶成"今天"，"什么时候下架的"就没意义了）。
 *    重新上架（其它 → TRADING）会把它清回 NULL。
 *
 * ⚠️ 这张表是**记账 / 重启后恢复**用的；读路径不查它 —— 底座把整份读进内存
 *    （`kline-recorder.ts` 的 `lifecycle`），读路径查内存，0 I/O。
 */
import {getPool, query, queryOne} from './client'

export interface SymbolRow {
  exchange: string
  marketType: string
  pair: string
  symbol: string
  base: string
  status: string
  /** 币安 `onboardDate`（毫秒）；拿不到就是 null */
  onboardAt: number | null
}

export interface SymbolRecord extends Omit<SymbolRow, 'onboardAt'> {
  onboardAt: Date | null
  delistedAt: Date | null
  lastSeenAt: Date
}

const BATCH_ROWS = 300

/**
 * 把一次发现的原始清单灌进来（幂等）。
 *
 * ⚠️ 撞键时 `delisted_at` 的三条分支顺序不能换：先判「现在是不是 TRADING」
 *    （是 ⇒ 清空），再判「以前是 TRADING 吗」（是 ⇒ 记下这一刻），
 *    否则都不是 ⇒ 保持原值（下架时间一旦记下就不再被覆盖）。
 */
export async function upsertSymbols(rows: SymbolRow[]): Promise<number> {
  if (!rows.length) return 0
  let written = 0
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS)
    const values: unknown[] = []
    const tuples = chunk.map((r, n) => {
      const b = n * 7
      values.push(
        r.exchange,
        r.marketType,
        r.pair,
        r.symbol,
        r.base,
        r.status,
        r.onboardAt === null ? null : new Date(r.onboardAt).toISOString()
      )
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::timestamptz)`
    })
    /* 用 `getPool().query` 而不是 `query(...)`：要 `rowCount`（受影响行数）—— 返回
       类型是 `QueryResultRow[]` 的那个封装把它丢了，见 `candle-store.ts` 的 `saveCandles` */
    const res = await getPool().query(
      `INSERT INTO symbols (exchange, market_type, pair, symbol, base, status, onboard_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (exchange, market_type, pair) DO UPDATE SET
         symbol       = EXCLUDED.symbol,
         base         = EXCLUDED.base,
         status       = EXCLUDED.status,
         onboard_at   = COALESCE(symbols.onboard_at, EXCLUDED.onboard_at),
         delisted_at  = CASE
                          WHEN EXCLUDED.status = 'TRADING' THEN NULL
                          WHEN symbols.status  = 'TRADING' THEN now()
                          ELSE symbols.delisted_at
                        END,
         last_seen_at = now(),
         updated_at   = now()`,
      values
    )
    written += res.rowCount ?? 0
  }
  return written
}

/** 整份读回来（底座启动时灌进内存镜像用） */
export async function loadSymbols(
  exchange: string,
  marketType: string
): Promise<SymbolRecord[]> {
  const rows = await query<{
    pair: string
    symbol: string
    base: string
    status: string
    onboard_at: Date | null
    delisted_at: Date | null
    last_seen_at: Date
  }>(
    `SELECT pair, symbol, base, status, onboard_at, delisted_at, last_seen_at
       FROM symbols
      WHERE exchange = $1 AND market_type = $2`,
    [exchange, marketType]
  )
  return rows.map(r => ({
    exchange,
    marketType,
    pair: r.pair,
    symbol: r.symbol,
    base: r.base,
    status: r.status,
    onboardAt: r.onboard_at ? new Date(r.onboard_at) : null,
    delistedAt: r.delisted_at ? new Date(r.delisted_at) : null,
    lastSeenAt: new Date(r.last_seen_at)
  }))
}

export interface SymbolTableStats {
  rows: number
  trading: number
  /** 不是 TRADING 的（下架 / 交割中 / 待上线） */
  other: number
  /** 下面这两个是"最年轻的"—— 用来一眼看出清单有多新 */
  newestOnboardAt: Date | null
  lastSeenAt: Date | null
}

export async function symbolTableStats(): Promise<SymbolTableStats> {
  const row = await queryOne<{
    n: string
    trading: string
    newest: Date | null
    seen: Date | null
  }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE status = 'TRADING')::text AS trading,
            max(onboard_at) AS newest,
            max(last_seen_at) AS seen
       FROM symbols`
  )
  const rows = Number(row?.n ?? 0)
  const trading = Number(row?.trading ?? 0)
  return {
    rows,
    trading,
    other: rows - trading,
    newestOnboardAt: row?.newest ? new Date(row.newest) : null,
    lastSeenAt: row?.seen ? new Date(row.seen) : null
  }
}
