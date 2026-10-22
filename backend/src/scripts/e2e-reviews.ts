/**
 * **端到端自测：盘中体检 + 盘后复盘**（一次性脚本，跑完可以删）。
 *
 * 用**独立的测试库**（`crypto_advisor_test`），不碰线上库、不连交易所：
 *   · 测试库里没有 exchange key ⇒ `startExchangeStreams()` 直接返回，不会去打币安；
 *   · 持仓用 `publishLive()` 在**同一个进程**里注水（模块实例共享，所以能注得进去）。
 *
 * 跑法：
 *   docker exec ca-postgres createdb -U ca crypto_advisor_test   # 第一次
 *   npx tsx backend/src/scripts/e2e-reviews.ts
 */
process.env.PGDATABASE = 'crypto_advisor_test'
process.env.PORT = '8799'
process.env.NODE_ENV = 'test'
/* 测试库没有 key ⇒ 不会抢交易所权重；这里关掉单实例保护才能起第二个进程 */
process.env.ALLOW_MULTI_SERVER = '1'

const PORT = 8799
const TOKEN = 'e2e-test-token'

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const db = (await import('../db/client.js')) as typeof import('../db/client')
  const {ensureSchema, query, closePool} = db
  await ensureSchema()

  /* ---- 清一个干净的测试用户 ---- */
  await query(`DELETE FROM users WHERE lower(username) = 'e2e'`)
  const [u] = await query<{id: string}>(
    `INSERT INTO users (username, password_hash) VALUES ('e2e', 'x') RETURNING id`
  )
  const userId = Number(u!.id)
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [TOKEN, userId]
  )

  /* ---- 成交账本：一段完整的多单（1.0 → 1.1，+10）---- */
  const k = await query<{id: string}>(
    `INSERT INTO user_exchange_keys (user_id, name, exchange, market_type, api_key, secret, is_default)
     VALUES ($1, 'e2e', 'binance', 'swap', '', '', true) RETURNING id`,
    [userId]
  )
  const keyId = Number(k[0]!.id)
  /* 15m K 线：最近 20 根，3 根最低 0.987 ⇒ 结构位止损约 1.3%（在 0.4~1.5 之间） */
  const rows: string[] = []
  const args: Date[] = []
  for (let i = 0; i < 20; i++) {
    args.push(new Date(Date.now() - (i + 1) * 15 * 60_000))
    rows.push(
      `('binance','swap','TEST/USDT:USDT','TESTUSDT','15m',$${i + 1},1.0,1.01,0.987,1.0,100,100,10,50,'ws')`
    )
  }
  await query(
    `INSERT INTO candles (exchange, market_type, symbol, pair, interval, open_time, open, high, low, close, volume, quote_volume, trades, taker_buy_volume, source)
     VALUES ${rows.join(',')} ON CONFLICT DO NOTHING`,
    args
  )

  const base = Date.now() - 60 * 60_000
  await query(
    `INSERT INTO exchange_fills (user_id, key_id, order_id, trade_id, symbol, side, price, amount, cost, fee, fee_ccy, realized, ts)
     VALUES
       ($1,$2,'o1','t1','TESTUSDT','buy', 1.0, 100, 100, 0.1, 'USDT', 0, $3),
       ($1,$2,'o2','t2','TESTUSDT','sell',0.96, 100, 96, 0.1, 'USDT', -4, $4)`,
    [userId, keyId, new Date(base), new Date(base + 20 * 60_000)]
  )

  /* ---- 起服务（导入就会 listen）---- */
  await import('../server.js')
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) break
    } catch {
      /* 还没起来 */
    }
    await wait(250)
  }

  const {publishLive} = (await import('../data/position-cache.js')) as typeof import('../data/position-cache')
  const {syncPositionJournal} = (await import('../data/trade-review.js')) as typeof import('../data/trade-review')

  const auth = {Authorization: `Bearer ${TOKEN}`}
  /* 一次性测试脚本：响应用 any，别为了它把接口类型铺一遍 */
  const get = async (p: string): Promise<{status: number; body: any}> => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {headers: auth})
    return {status: r.status, body: await r.json()}
  }

  const results: {name: string; ok: boolean; note: string}[] = []
  const check = (name: string, ok: boolean, note: string) => {
    results.push({name, ok, note})
    console.log(`${ok ? '✅' : '❌'} ${name} — ${note}`)
  }

  /* ================= 1. 空持仓 ================= */
  let r = await get('/api/positions/live')
  check('GET /api/positions/live（无仓）', r.status === 200 && r.body.cards.length === 0,
    `status=${r.status} cards=${r.body.cards?.length}`)

  /* ================= 2. 注入一个持仓 → 体检卡 ================= */
  const mark = 0.995
  publishLive(keyId, {
    wallet: 1000,
    available: 900,
    live: true,
    positions: [
      {
        symbol: 'TEST/USDT:USDT',
        raw: 'TESTUSDT',
        side: 'long',
        amount: 100,
        notional: 99.5,
        entryPrice: 1.0,
        markPrice: mark,
        liquidationPrice: null,
        leverage: 10,
        unrealizedPnl: -0.5,
        percentage: -5,
        maintMargin: 0.5,
        mmr: 0.005,
        meta: {openedAt: base, realized: 0, net: 0, fee: 0.2, funding: 0, partial: false}
      } as never
    ]
  })

  r = await get('/api/positions/live')
  const card = r.body.cards?.[0]
  check('GET /api/positions/live（有仓）', r.status === 200 && !!card,
    card ? `symbol=${card.symbol} r=${card.r} 持仓=${card.holdMin}分 占账户=${card.accountLeverage?.toFixed?.(2)}x` : 'no card')
  check('结构位止损已算出', !!card?.stopPrice, `stop=${card?.stopPrice?.toFixed?.(4)} pct=${card?.stopPct?.toFixed?.(2)}% src=${card?.stopSource}`)
  check('持仓 ≥30 分钟 → 触发时间止损提示', (card?.tips ?? []).some((t: {code: string}) => t.code === 'time-stop'),
    (card?.tips ?? []).map((t: {text: string}) => t.text).join(' | ') || '无提示')

  /* ================= 3. 平仓 → 自动生成复盘 ================= */
  const sync1 = await syncPositionJournal(userId)
  publishLive(keyId, {wallet: 1000, available: 1000, live: true, positions: []})
  const sync2 = await syncPositionJournal(userId)
  check('开仓补计划 / 平仓结算', sync1.opened === 1 && sync2.closed === 1 && sync2.reviews === 1,
    JSON.stringify({sync1, sync2}))

  r = await get('/api/reviews')
  const rev = r.body.reviews?.[0]
  check('GET /api/reviews', r.status === 200 && !!rev,
    rev ? `${rev.symbol} ${rev.side} ${rev.holdMin}分 net=${rev.net}` : '空')
  check('复盘带档位与基准', !!rev?.buckets && rev?.baselineWinrate !== null,
    `buckets=${rev?.buckets} baseline=${rev?.baselineWinrate}`)
  check('点评文案是「陈述」不是「命令」', !!rev?.verdict && !/应该|必须/.test((rev.verdict ?? '') + (rev.tip ?? '')),
    (rev?.verdict ?? '').slice(0, 60))

  r = await get(`/api/reviews/${rev?.id}`)
  check('GET /api/reviews/:id', r.status === 200 && r.body.review?.id === rev?.id, `status=${r.status}`)

  /* ================= 4. 补历史（幂等）================= */
  const b1 = await fetch(`http://127.0.0.1:${PORT}/api/reviews/backfill`, {method: 'POST', headers: auth})
  const j1: any = await b1.json()
  const b2 = await fetch(`http://127.0.0.1:${PORT}/api/reviews/backfill`, {method: 'POST', headers: auth})
  const j2: any = await b2.json()
  check('POST /api/reviews/backfill 幂等', j1.created >= 1 && j2.created === 0,
    `第一次 ${j1.created} 条，第二次 ${j2.created} 条`)

  /* ================= 5. 阶段总结 ================= */
  r = await get('/api/reviews/summary')
  check('GET /api/reviews/summary', r.status === 200 && Array.isArray(r.body.summaries),
    `${r.body.summaries?.length ?? 0} 条（20 笔一条，样本不足时为 0 是正常的）`)

  /* ================= 6. 下单接口零改动 ================= */
  const order = await fetch(`http://127.0.0.1:${PORT}/api/exchange/trade/order`, {
    method: 'POST',
    headers: {...auth, 'Content-Type': 'application/json'},
    body: JSON.stringify({symbol: 'TESTUSDT', side: 'long', type: 'market', quantity: 1, test: true})
  })
  const oj: any = await order.json()
  check('下单接口仍走原路径（没有前置拦截）', order.status === 200 && !/limit|限制|超过/.test(JSON.stringify(oj).slice(0, 200)),
    JSON.stringify(oj).slice(0, 120))

  const pass = results.filter(x => x.ok).length
  console.log(`\n===== ${pass}/${results.length} 通过 =====`)
  await closePool()
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(e => {
  console.error('E2E 失败：', e)
  process.exit(1)
})
