/**
 * M0 验证脚本（**临时文件**，验完就删）。
 *
 * 第一轮已经确认（2026-10-05）：
 *   · ❌ ccxt 社区版**做不了**用户数据流：`watchOrders()` 直接抛
 *     "binance watchOrders() is not supported yet"（方法在，但只是基类占位，ccxt.pro 才有）
 *   · ✅ `fapiPrivatePostListenKey()` 通（长度 64）⇒ 凭据 + REST 没问题
 *   · ✅ `/fapi/v2/account` 字段全中；`positions` 会返回**全部 920 个槽位**（要过滤非零）
 *   · ⚠️ C2C 钱包在接口里的 `walletName` 实际是 **Funding**（返回的 10 个钱包里没有 "C2C"）
 *
 * 这一轮要验的是**最后一件事**：既然 ccxt 不行，那**自己连**裸 WS 能不能通 ——
 * 通了实时层就定了；不通整个"实时"方案就得推翻。
 *
 * 跑法：npx tsx backend/src/scripts/probe-ws.ts
 * ⚠️ 只读（listenKey + 连 WS），不下单不撤单；listenKey 值不打印。
 */
import 'dotenv/config'
import {query, getPool} from '../db/client'
import {createExchange} from '../data/exchange-account'
import {WebSocket} from 'ws'

const HOLD_MS = 15_000

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
  const rows = await query<KeyRow>(
    `SELECT id, exchange, name, api_key, secret, password, market_type, sandbox
       FROM user_exchange_keys
      WHERE api_key <> '' AND secret <> '' AND exchange = 'binance'
      ORDER BY id LIMIT 1`
  )
  const row = rows[0]
  if (!row) {
    console.log('库里没有币安合约的 key，跑不了')
    return
  }
  console.log(`用第 ${row.id} 套：${row.name} · ${row.market_type}\n`)

  const ex = createExchange({
    exchange: row.exchange,
    apiKey: row.api_key,
    secret: row.secret,
    password: row.password,
    marketType: row.market_type,
    sandbox: row.sandbox
  })

  /* ---------------- ② listenKey ---------------- */
  const r = await ex.fapiPrivatePostListenKey()
  const listenKey = String(r?.listenKey ?? '')
  console.log(`[1] listenKey 长度 ${listenKey.length}（值不打印）`)
  if (!listenKey) {
    console.log('    ❌ 没拿到 listenKey，后面没法验')
    return
  }

  /* ---------------- ①b 断档能不能补：币安有没有「历史权益」接口 ---------------- */
  console.log('\n[1b] 历史权益快照接口（决定「服务挂了那段时间能不能补」）')
  for (const type of ['FUTURES', 'SPOT']) {
    try {
      const snap: any = await ex.sapiGetAccountSnapshot({type, limit: 3})
      const code = snap?.code
      const list = snap?.snapshotVos ?? []
      console.log(
        `    ${type}: ${code ? `code=${code} msg=${snap?.msg}` : `✅ 有 ${list.length} 条`}` +
          (list[0] ? `（最早一条 ${new Date(Number(list[list.length - 1]?.updateTime ?? 0)).toISOString().slice(0, 10)}）` : '')
      )
      if (list[0]) console.log(`      一条的字段: ${Object.keys(list[0]).join(', ')}`)
    } catch (e) {
      console.log(`    ${type}: ❌ ${(e as Error).message.slice(0, 160)}`)
    }
  }

  /* ---------------- ② 连裸 WS ---------------- */
  // 合约用户数据流：主网是 fstream.binance.com（不是 stream.binance.com）
  const url = `wss://fstream.binance.com/ws/${listenKey}`
  console.log(`[2] 连 ${url.replace(listenKey, '<listenKey>')}`)

  let opened = 0
  let msgs = 0
  let closed: string | null = null
  const t0 = Date.now()

  const ws = new WebSocket(url)

  ws.on('open', () => {
    opened = 1
    console.log(`    ✅ open（${Date.now() - t0}ms）—— 连上了`)
  })
  ws.on('message', (data: Buffer) => {
    msgs++
    const s = String(data)
    let e = ''
    try {
      e = JSON.parse(s)?.e ?? ''
    } catch {
      /* 不是 JSON 也无所谓 */
    }
    console.log(`    📩 收到事件 e=${e || '(非 JSON)'}  前 160 字: ${s.slice(0, 160)}`)
  })
  ws.on('error', (e: Error) => console.log('    ❌ error:', e.message.slice(0, 200)))
  ws.on('close', (code: number, reason: Buffer) => {
    closed = `code=${code} reason=${String(reason).slice(0, 100)}`
    console.log(`    ⚠️ close ${closed}（${Date.now() - t0}ms）`)
  })

  await new Promise(res => setTimeout(res, HOLD_MS))

  /* ---------------- ③ 结论 ---------------- */
  console.log('\n[3] 结论')
  console.log(`    连上了吗: ${opened ? '是' : '否'}`)
  console.log(`    期间事件: ${msgs} 条（账户没动静就是 0 条，正常）`)
  console.log(`    断开情况: ${closed ?? '一直没断'}`)
  console.log(
    opened && !closed
      ? '    ⇒ 裸 WS 可用 ✅ 实时层就按这个写（自己管续期 + 重连 + 对账）'
      : '    ⇒ 有问题，得看上面报什么'
  )

  try {
    ws.close()
    // 顺手把 listenKey 关掉（别留一条活的到 60 分钟自动过期）
    if (typeof ex.fapiPrivateDeleteListenKey === 'function') {
      await ex.fapiPrivateDeleteListenKey({listenKey})
      console.log('    （已 DELETE listenKey）')
    }
    await ex.close?.()
  } catch {
    /* 收尾失败无所谓 */
  }
}

main()
  .catch(e => console.error('\n脚本本身出错:', e))
  .finally(() => {
    void getPool().end()
    setTimeout(() => process.exit(0), 300)
  })
