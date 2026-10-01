import {Pool, PoolClient, QueryResultRow} from 'pg'
import {SCHEMA_SQL, MIGRATE_SQL} from './schema'

let pool: Pool | null = null

export function dbConfig() {
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'ca',
    password: process.env.PGPASSWORD ?? 'ca_local_dev',
    database: process.env.PGDATABASE ?? 'crypto_advisor'
  }
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      ...dbConfig(),
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    })
    pool.on('error', e => console.error('[db] 连接池错误:', e.message))
  }
  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query<T>(sql, params as never[])
  return res.rows
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}


/** 建表（幂等），启动时调用 */
export async function ensureSchema(): Promise<void> {
  // 先清掉结构不兼容的旧表，再建新表
  await getPool().query(MIGRATE_SQL)
  await getPool().query(SCHEMA_SQL)
}

/** 启动指引：连不上时给出人能照做的提示 */
export function dbHelpMessage(e: unknown): string {
  const {host, port} = dbConfig()
  const msg = (e as Error)?.message ?? String(e)
  return [
    `连接数据库失败（${host}:${port}）：${msg}`,
    '',
    '请检查：',
    '  1) Docker Desktop 是否已启动',
    '  2) 数据库容器是否在跑：  npm run db:up',
    '  3) 查看状态：            npm run db:status',
    '',
    '如果容器刚起来，Postgres 初始化需要几秒钟，稍等再试。'
  ].join('\n')
}

export interface DbStatus {
  ok: boolean
  version?: string
  error?: string
  counts?: Record<string, number>
}

/** 探测数据库可用性（不抛错） */
export async function checkDb(): Promise<DbStatus> {
  try {
    const v = await queryOne<{version: string}>('SELECT version() AS version')
    const counts: Record<string, number> = {}
    for (const t of ['knowledge', 'analyses', 'llm_usage']) {
      try {
        const r = await queryOne<{n: string}>(
          `SELECT count(*)::text AS n FROM ${t}`
        )
        counts[t] = Number(r?.n ?? 0)
      } catch {
        counts[t] = -1 // 表不存在
      }
    }
    return {
      ok: true,
      version: v?.version?.split(' ').slice(0, 2).join(' '),
      counts
    }
  } catch (e) {
    return {ok: false, error: (e as Error).message}
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
