/**
 * 把账户里**所有币种**的杠杆统一设成一个值（默认 10x）。
 *
 * 用法（在服务器上跑；本机跑要带 EXCHANGE_PROXY 走白名单出口，否则币安回 -2015）：
 *   node scripts/set-leverage.mjs --dry-run        # 只列现状 + 打算怎么改，**一个请求都不发**
 *   node scripts/set-leverage.mjs                  # 真改（默认 10x，默认跑所有合约账户）
 *   KEY_IDS=9 node scripts/set-leverage.mjs        # 只跑 9 号账户
 *   LEVERAGE=5 node scripts/set-leverage.mjs       # 换个目标值
 *
 * 它做什么：
 *   ① 从库里读合约账户的 Key（跟 `userstream-probe.mjs` 一个取法；也可用
 *      `API_KEY` / `API_SECRET` 走环境变量）；
 *   ② `loadMarkets()` 拿这个交易所**全部** U 本位永续（linear swap、状态 TRADING）；
 *   ③ 一次 `positionRisk` 拿到每个币**当前**杠杆 + 有没有持仓；
 *   ④ 只对「和目标不一样」的币发 `POST /fapi/v1/leverage`，逐个报结果。
 *
 * ⚠️ 有持仓 / 挂单的币**改不了**（币安会拒），脚本会跳过并单列出来 —— 这是交易所的限制，
 *    不是脚本的问题；等那些仓位平掉再跑一次就行。
 * ⚠️ 报 `-2027 / 超过该币最大杠杆` 的币（冷门币有的只允许 5x），也单独列出来。
 * ⚠️ 别在交易高峰跑：几百个请求虽然不重，但会占一点权重。脚本按 ~7 个/秒 走，
 *    撞上限（429 / -1003）会自己退避重试一次。
 */
import ccxt from 'ccxt'

const DRY = process.argv.includes('--dry-run')
const TARGET = Math.max(1, Math.floor(Number(process.env.LEVERAGE || 10)))
const PROXY = process.env.EXCHANGE_PROXY || process.env.HTTPS_PROXY || ''
/** 每个请求之间歇一下（毫秒）—— 约 7 个/秒，离权重上限很远 */
const PACE_MS = 150

const sleep = ms => new Promise(r => setTimeout(r, ms))
const pad = (s, n) => String(s).padEnd(n)

async function agent() {
  if (!PROXY) return undefined
  const {HttpsProxyAgent} = await import('https-proxy-agent')
  return new HttpsProxyAgent(PROXY)
}

/** 库里那几套合约 Key（只取 id / 名字 / 凭据，别的不要） */
async function loadKeys() {
  if (process.env.API_KEY && process.env.API_SECRET) {
    return [
      {
        id: 0,
        name: '(环境变量)',
        apiKey: process.env.API_KEY,
        secret: process.env.API_SECRET,
        password: ''
      }
    ]
  }
  const {default: pg} = await import('pg')
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
  const only = (process.env.KEY_IDS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
  const sql =
    `SELECT id, name, api_key, secret, password FROM user_exchange_keys
      WHERE exchange = 'binance' AND market_type = 'swap'
        AND coalesce(api_key, '') <> ''` +
    (only.length ? ` AND id = ANY($1::bigint[])` : '') +
    ' ORDER BY id'
  const {rows} = await c.query(sql, only.length ? [only] : [])
  await c.end()
  return rows.map(r => ({
    id: Number(r.id),
    name: r.name || '',
    apiKey: r.api_key,
    secret: r.secret,
    password: r.password || ''
  }))
}

/**
 * 这个交易所的全部 U 本位永续（状态 TRADING）。
 *
 * ⚠️ 币安**原始接口要的是 `BTCUSDT`**，不是 ccxt 的 `BTC/USDT:USDT` ——
 *    `positionRisk` 回的也是前者。用错了（踩过）会「当前杠杆一个都读不到、
 *    设置请求全失败」，而且试运行看着还挺正常。所以这里把两个格式都带着：
 *    `id` 走接口，`label` 只用来打印。
 */
function allLinearSwaps(ex) {
  return Object.values(ex.markets)
    .filter(m => m && m.swap && m.linear && m.active !== false)
    .map(m => ({id: String(m.id).toUpperCase(), label: String(m.symbol)}))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 当前杠杆（原始 symbol → leverage）+ 有持仓的（原始 symbol → 数量） */
async function currentState(ex) {
  const rows = (await ex.fapiPrivateV2GetPositionRisk()) ?? []
  const lev = {}
  const held = {}
  for (const r of rows) {
    const s = String(r?.symbol ?? '').toUpperCase()
    if (!s) continue
    const l = Math.floor(Number(r?.leverage))
    if (Number.isFinite(l) && l > 0) lev[s] = l
    const amt = Number(r?.positionAmt)
    if (Number.isFinite(amt) && amt !== 0) held[s] = amt
  }
  return {
    lev,
    held,
    /** 诊断用：接口一共回了多少行、前几个原始符号长什么样 */
    rowCount: rows.length,
    sample: rows.slice(0, 3).map(r => String(r?.symbol))
  }
}

/** 币安每个币允许的最大杠杆（第一档）—— 只用来把失败原因说清楚 */
async function maxLevMap(ex) {
  try {
    const rows = (await ex.fapiPrivateGetLeverageBracket()) ?? []
    const out = {}
    for (const r of rows) {
      const s = String(r?.symbol ?? '').toUpperCase()
      const first = Array.isArray(r?.brackets) ? r.brackets[0] : null
      const m = Math.floor(Number(first?.initialLeverage))
      if (s && Number.isFinite(m) && m > 0) out[s] = m
    }
    return out
  } catch {
    return {}
  }
}

/** 改一个币的杠杆；撞限流退避重试一次。返回 {ok} 或 {err} */
async function setOne(ex, symbol, leverage, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      await ex.fapiPrivatePostLeverage({symbol, leverage})
      return {ok: true}
    } catch (e) {
      const msg = String(e?.message || e)
      if (i === 0 && (msg.includes('-1003') || msg.includes('429') || msg.includes('Too many'))) {
        await sleep(2000)
        continue
      }
      return {err: msg}
    }
  }
  return {err: '重试后仍失败'}
}

async function runKey(key, proxyAgent) {
  const ex = new ccxt.binanceusdm({
    apiKey: key.apiKey,
    secret: key.secret,
    password: key.password,
    enableRateLimit: true,
    options: {defaultType: 'swap'},
    ...(proxyAgent ? {agent: proxyAgent} : {})
  })

  await ex.loadMarkets()
  const symbols = allLinearSwaps(ex)
  const {lev, held, rowCount, sample} = await currentState(ex)
  const maxLev = await maxLevMap(ex)

  const already = []
  const changed = []
  const skipped = []
  const failed = []
  /** 当前杠杆的分布（试运行时最有用的东西：一眼看出现在到底是什么状态） */
  const hist = {}

  console.log(
    `\n=== 账户 #${key.id} ${key.name || ''} ===\n` +
      `共 ${symbols.length} 个 U 本位永续 · 目标 ${TARGET}x · ${DRY ? '【试运行，不改】' : '真改'}\n` +
      `positionRisk 回了 ${rowCount} 行${rowCount ? `（例如 ${sample.join(', ')}）` : ''}`
  )

  let done = 0
  for (const {id, label} of symbols) {
    const now = lev[id]
    hist[now === undefined ? '读不到' : `${now}x`] =
      (hist[now === undefined ? '读不到' : `${now}x`] || 0) + 1
    if (now === TARGET) {
      already.push(label)
      continue
    }
    if (held[id] !== undefined) {
      skipped.push(`${label}（有持仓 ${held[id]}）`)
      continue
    }
    if (DRY) {
      changed.push(`${label} ${now ?? '?'}x → ${TARGET}x`)
      continue
    }
    const r = await setOne(ex, id, TARGET)
    if (r.ok) changed.push(`${label} ${now ?? '?'}x → ${TARGET}x`)
    else {
      const max = maxLev[id]
      const hint = max && max < TARGET ? `（该币最大 ${max}x）` : ''
      failed.push(`${label}${hint}：${r.err}`)
    }
    done++
    if (done % 50 === 0) console.log(`  …已处理 ${done} 个`)
    await sleep(PACE_MS)
  }

  console.log(
    `\n账户 #${key.id} 汇总：` +
      `已经是 ${TARGET}x ${already.length} 个 · ` +
      `${DRY ? '待改' : '改成功'} ${changed.length} 个 · ` +
      `跳过（有持仓）${skipped.length} 个 · 失败 ${failed.length} 个`
  )
  console.log(
    `当前杠杆分布：` +
      Object.entries(hist)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v} 个`)
        .join(' · ')
  )
  if (changed.length && changed.length <= 40) {
    console.log(`\n${DRY ? '待改' : '已改'}：\n  ` + changed.join('\n  '))
  } else if (changed.length) {
    console.log(
      `\n${DRY ? '待改' : '已改'}（前 40 个）：\n  ` +
        changed.slice(0, 40).join('\n  ') +
        `\n  …还有 ${changed.length - 40} 个`
    )
  }
  if (skipped.length) {
    console.log(`\n跳过（有持仓/挂单，交易所不让改）：\n  ` + skipped.join('\n  '))
  }
  if (failed.length) {
    console.log(`\n失败：\n  ` + failed.join('\n  '))
  }
  return {changed: changed.length, skipped: skipped.length, failed: failed.length}
}

async function main() {
  const keys = await loadKeys()
  if (!keys.length) {
    console.error('没有可用的合约 Key')
    process.exit(1)
  }
  const proxyAgent = await agent()
  console.log(
    `准备处理 ${keys.length} 个账户：` +
      keys.map(k => `#${k.id} ${k.name}`).join('、') +
      (PROXY ? `\n出口代理：${PROXY}` : '')
  )
  const total = {changed: 0, skipped: 0, failed: 0}
  for (const key of keys) {
    try {
      const r = await runKey(key, proxyAgent)
      total.changed += r.changed
      total.skipped += r.skipped
      total.failed += r.failed
    } catch (e) {
      console.error(`账户 #${key.id} 整体失败：${e?.message || e}`)
      total.failed++
    }
  }
  console.log(
    `\n===== 全部完成：${DRY ? '待改' : '已改'} ${total.changed} · ` +
      `跳过 ${total.skipped} · 失败 ${total.failed} =====`
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
