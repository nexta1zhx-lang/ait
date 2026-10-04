/**
 * M1 验证脚本（**临时**）：`fetchExchangeOverview` 到底能不能取到正确的数。
 *
 * 跑法：npx tsx backend/src/scripts/probe-overview.ts
 * ⚠️ 只读；凭据只在这个进程里用，不打印。
 */
import 'dotenv/config'
import {ensureSchema, getPool, query} from '../db/client'
import {fetchExchangeOverview} from '../data/exchange-overview'

interface KeyRow {
  id: number
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
    `SELECT id, exchange, name, api_key, secret, password, market_type, sandbox
       FROM user_exchange_keys
      WHERE api_key <> '' AND secret <> ''
      ORDER BY id LIMIT 1`
  )
  const row = rows[0]
  if (!row) {
    console.log('库里没有可用 key')
    return
  }
  console.log(`用第 ${row.id} 套：${row.exchange} · ${row.name} · ${row.market_type}\n`)

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
}

main()
  .catch(e => console.error('\n❌ 出错:', (e as Error).message))
  .finally(() => {
    void getPool().end()
    setTimeout(() => process.exit(0), 200)
  })
