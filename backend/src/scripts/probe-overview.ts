/**
 * M1 验证脚本（**临时**）：`fetchExchangeOverview` 到底能不能取到正确的数。
 *
 * 跑法：npx tsx backend/src/scripts/probe-overview.ts
 * ⚠️ 只读；凭据只在这个进程里用，不打印。
 */
import 'dotenv/config'
import {ensureSchema, getPool, query} from '../db/client'
import {latestSnapshot, saveSnapshot} from '../db/exchange-store'
import {fetchExchangeOverview} from '../data/exchange-overview'

/** 库里就一个用户（实测），写快照要 user_id，这个值从 key 行里读 */
const USER_ID = 1

interface KeyRow {
  id: number
  user_id: number
  exchange: string
  name: string
  api_key: string
  secret: string
  password: string
  market_type: string
  sandbox: boolean
}

async function main(): Promise<void> {
  // ① 先把建表跑一遍 —— SCHEMA_SQL 有语法错的话服务会**开不起来**，这里先验
  await ensureSchema()
  const t = await query<{table_name: string; n: string}>(
    `SELECT c.relname AS table_name, c.reltuples::bigint::text AS n
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = current_schema()
        AND c.relname IN ('exchange_snapshots', 'exchange_fills')
      ORDER BY c.relname`
  )
  console.log(
    '建表:',
    t.map(x => x.table_name).join(', ') || '❌ 两张表都没建出来（SCHEMA_SQL 有问题）'
  )
  const idx = await query<{indexname: string}>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename IN ('exchange_snapshots', 'exchange_fills') ORDER BY indexname`
  )
  console.log('索引:', idx.map(x => x.indexname).join(', ') || '(没有)' + '\n')

  const rows = await query<KeyRow>(
    `SELECT id, user_id, exchange, name, api_key, secret, password, market_type, sandbox
       FROM user_exchange_keys
      WHERE api_key <> '' AND secret <> ''
      ORDER BY id LIMIT 1`
  )
  const row = rows[0]
  if (!row) {
    console.log('库里没有可用 key')
    return
  }
  console.log(
    `用第 ${row.id} 套（user_id=${row.user_id}）：${row.exchange} · ${row.name} · ${row.market_type}\n`
  )

  const t0 = Date.now()
  const ov = await fetchExchangeOverview({
    exchange: row.exchange,
    apiKey: row.api_key,
    secret: row.secret,
    password: row.password,
    marketType: row.market_type,
    sandbox: row.sandbox
  })
  console.log(`取数耗时 ${Date.now() - t0}ms\n`)

  console.log('合约:', JSON.stringify(ov.futures.wallet !== undefined ? {
    钱包: ov.futures.wallet,
    浮盈: ov.futures.unrealized,
    保证金: ov.futures.margin,
    可用: ov.futures.available,
    占用: ov.futures.used,
    资产行: ov.futures.assets.length,
    持仓: ov.futures.positions.length
  } : null))
  console.log('C2C :', JSON.stringify(ov.c2c))
  console.log('统计:', JSON.stringify(ov.stats))
  console.log('\n净资产 =', ov.futures.margin + (ov.c2c?.totalUsdt ?? 0))
  if (ov.futures.positions[0]) {
    console.log('一个持仓的形状:', JSON.stringify(ov.futures.positions[0]))
  }

  /* ---------------- 存取往返（验 SQL + 形状） ---------------- */
  console.log('\n[往返] saveSnapshot → latestSnapshot')
  await saveSnapshot(row.user_id, row.id, ov, {source: 'manual'})
  const back = await latestSnapshot(row.user_id, row.id)
  if (!back) {
    console.log('  ❌ 读不回来')
    return
  }
  console.log(
    '  读回来:',
    JSON.stringify({
      source: back.source,
      ageSec: back.ageSec,
      stale: back.stale,
      钱包: back.overview.futures.wallet,
      保证金: back.overview.futures.margin,
      可用: back.overview.futures.available,
      资产行: back.overview.futures.assets.length,
      持仓: back.overview.futures.positions.length,
      C2C: back.overview.c2c,
      统计: back.overview.stats
    })
  )
  const rowsN = await query<{n: string}>(
    `SELECT count(*)::text AS n FROM exchange_snapshots WHERE key_id = $1`,
    [row.id]
  )
  console.log('  这张表里现在有', rowsN[0]?.n, '条（第', row.id, '套 key）')
}

main()
  .catch(e => console.error('\n❌ 出错:', (e as Error).message))
  .finally(() => {
    void getPool().end()
    setTimeout(() => process.exit(0), 200)
  })
