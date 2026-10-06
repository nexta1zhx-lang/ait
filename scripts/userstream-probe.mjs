/**
 * 币安 U 本位合约「用户数据流到底推不推」一次性探针 —— 自包含，只需要 node_modules 里的
 * ccxt / ws / pg（走项目既有的依赖，不用装新东西）。
 *
 * 为什么要有它：我们实测到「listenKey 有效、连接 open、币安还在 ping，但业务事件一个字节都不来」，
 * 而同一台机器/同一个代理连 fstream.binance.com 的**公共行情流**是正常的（654 帧 / 75 KB）。
 * 所以要拿**不同的出口**（比如线上服务器）跑同一个探针来对照：换出口能不能收到。
 *
 * 用法（在项目根目录，node_modules 装好的地方）：
 *   node scripts/userstream-probe.mjs            # 默认读库里 key 7 的凭据
 *   KEY_ID=9 node scripts/userstream-probe.mjs
 *   API_KEY=xxx API_SECRET=yyy node scripts/userstream-probe.mjs
 *
 * 它会：① POST /fapi/v1/listenKey（打印返回的 key）② 连两条 /ws/<listenKey>
 *       ③ 造一个**免费可逆**的真事件：合约钱包 → 现货 转 1 USDT，20 秒后转回
 *       ④ 全程打印收到的每一帧
 *
 * 判读：
 *   · 出现 ★★★ 帧 ⇒ 这条出口能收到事件，把用户数据流放在这台机器上就对了
 *   · 只有 ping、收到字节 ≈0.3KB（= 只有握手）、0 帧 ⇒ 这条出口也收不到，问题不在「谁抢流」
 */
import WebSocket from 'ws'
import ccxt from 'ccxt'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const PROXY = process.env.EXCHANGE_PROXY || process.env.HTTPS_PROXY || ''
async function agent() {
  if (!PROXY) return undefined
  const {HttpsProxyAgent} = await import('https-proxy-agent')
  return new HttpsProxyAgent(PROXY)
}

async function creds() {
  if (process.env.API_KEY && process.env.API_SECRET) {
    return {apiKey: process.env.API_KEY, secret: process.env.API_SECRET, from: '环境变量'}
  }
  const {default: pg} = await import('pg')
  /*
   * 库连接：优先 `DATABASE_URL`，其次**沿用项目的 PG* 那套**（线上容器里是
   * `PGHOST=db / PGPORT / PGUSER / PGPASSWORD / PGDATABASE`，`pg` 会自己读），
   * 都没有才退回本机开发的默认值。
   */
  const c = new pg.Client(
    process.env.DATABASE_URL
      ? {connectionString: process.env.DATABASE_URL}
      : process.env.PGHOST
        ? {}
        : {
            host: '127.0.0.1',
            port: 5432,
            user: 'ca',
            password: 'ca_local_dev',
            database: 'crypto_advisor'
          }
  )
  await c.connect()
  const id = Number(process.env.KEY_ID ?? 7)
  const r = await c.query('SELECT api_key, secret FROM user_exchange_keys WHERE id = $1', [id])
  await c.end()
  if (!r.rows[0]) throw new Error(`库里没有 key ${id}`)
  return {apiKey: r.rows[0].api_key, secret: r.rows[0].secret, from: `数据库 key=${id}`}
}

async function main() {
  const c = await creds()
  log(`凭据来源：${c.from}（key 尾号 …${String(c.apiKey).slice(-6)}）`)
  const ex = new ccxt.binanceusdm({
    apiKey: c.apiKey,
    secret: c.secret,
    enableRateLimit: true,
    options: {defaultType: 'future', fetchMarkets: ['linear']},
    /* 只能给一个代理（ccxt 同时给 http/https 会直接拒） */
    ...(PROXY ? {httpProxy: PROXY} : {})
  })
  if (PROXY) log(`走代理：${PROXY}`)
  await ex.loadMarkets()

  const lk = String((await ex.fapiPrivatePostListenKey())?.listenKey ?? '')
  log(`listenKey = ${lk}`)

  let frames = 0
  const socks = []
  const ag = await agent()
  /*
   * 官方文档给的路径是第一条；另外两条是**同一个 listenKey 的其它已知写法**
   * （统一账户 `/pm/ws/`、组合流 `/stream?streams=`）—— 一次全连上，谁收到帧就是它。
   */
  const urls = [
    ['A /ws/', `wss://fstream.binance.com/ws/${lk}`],
    ['B /pm/ws/', `wss://fstream.binance.com/pm/ws/${lk}`],
    ['C /stream?streams=', `wss://fstream.binance.com/stream?streams=${lk}`]
  ]
  for (const [name, url] of urls) {
    const w = new WebSocket(url, {agent: ag})
    socks.push({name, w})
    w.on('open', () => log(`[${name}] open ✓ ${new Date().toISOString()}`))
    w.on('message', (d) => {
      frames++
      log(`★★★ [${name}] 事件帧 ${new Date().toISOString()} ${String(d).slice(0, 260)}`)
    })
    w.on('ping', () => log(`[${name}] ping ${new Date().toISOString()}`))
    w.on('close', (code, r) => log(`[${name}] close ${code} ${String(r).slice(0, 80)}`))
    w.on('error', e => log(`[${name}] error ${e.message.slice(0, 140)}`))
    w.on('unexpected-response', (_req, res) => log(`[${name}] 非 101 响应：${res.statusCode}`))
    await sleep(1500)
  }

  log('→ 造真事件：合约钱包 → 现货 1 USDT（免费、可逆，会推 ACCOUNT_UPDATE）')
  try {
    log('  ', JSON.stringify(await ex.sapiPostAssetTransfer({
      type: 'UMFUTURE_MAIN', asset: 'USDT', amount: 1
    })))
  } catch (e) {
    log(`   划转失败（可以改成：趁探针在跑，用币安 App 挂一张远价限价单再撤掉）：${e.message.slice(0, 160)}`)
  }
  await sleep(22_000)
  log('← 还原：现货 → 合约钱包 1 USDT')
  try {
    log('  ', JSON.stringify(await ex.sapiPostAssetTransfer({
      type: 'MAIN_UMFUTURE', asset: 'USDT', amount: 1
    })))
  } catch (e) {
    log(`   还原失败：${e.message.slice(0, 160)}`)
  }
  await sleep(15_000)
  log(`=== 结束：共收到 ${frames} 个事件帧`)
  for (const {name, w} of socks) {
    const kb = (((w._socket || {}).bytesRead || 0) / 1024).toFixed(1)
    log(`    [${name}] 收到字节 = ${kb} KB（约 0.3 = 只有握手；只有心跳也几乎不涨）`)
  }
  /* ⚠️ 必须显式退出：WS socket 还开着，node 自己不会结束（本地实测会一直挂着） */
  process.exit(frames > 0 ? 0 : 2)
}

main().catch(e => log(`挂了：${String(e?.message).slice(0, 300)}`))
