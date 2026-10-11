/**
 * 市值排名（数据来自 CoinGecko 免费接口）。
 *
 * 用户 2026-10-04：「24h 替换成市值排名 如 no.1」—— 币种那格第二行想看到
 * 「这币在全网市值里排第几」（BTC = No.1 这种一眼能认的参照）。
 *
 * 为什么是 CoinGecko：
 *   · 币安**不提供**市值（只有成交量/额），必须找外部源
 *   · 实测本机可达：`api.coingecko.com` 200 ✓（coincap 直接连不上：000）
 *   · 免费、无需 key、一次请求就能拿 250 名
 *
 * 怎么用（见 server.ts 的 handleMarkets）：
 *   `marketCapRanks()` **同步**返回当前这份排名（拿不到就返回空 Map，不影响行情）；
 *   过期了在**后台**刷，用户这一发先用旧的 —— 排名几小时变不了几名。
 */

import fs from 'node:fs'
import path from 'node:path'
import {ROOT_DIR} from '../config'

const CG_URL = 'https://api.coingecko.com/api/v3/coins/markets'

/**
 * 落盘那份（跟 `contracts.ts` 的 `data/contracts.json` 一个路数）。
 *
 * ★ 2026-10-12 加。起因：用户「市值前 30 不扫」这条要有排名才能生效，而 CoinGecko
 *   免费接口会 **429**（实测挨了两三次就限流）。只放内存的后果是：
 *   · 一重启就没排名 ⇒ 大票又被放回候选里（**静默**失效，人以为这条一直开着）；
 *   · `npm run scan:pick` 这种短命进程每次都要重新拉，等于每次都可能撞限流。
 *   落盘之后：拉不到就用盘上那份（排名几小时变不了几名），重启也带着。
 */
const RANKS_FILE = path.join(ROOT_DIR, 'data', 'marketcap-ranks.json')

/** 拉几页（每页 250）。前 500 名覆盖我们 528 个合约里绝大多数 */
const PAGES = 2
/** 多久重拉一次 —— 市值排名一天也变不了几名，6 小时足够 */
const TTL_MS = 6 * 3600_000
/** 拉挂了之后隔多久再试（别每个请求都去撞，CoinGecko 有频率限制） */
const RETRY_MS = 5 * 60_000

export type RankMap = Map<string, number>

let cache: {at: number; ranks: RankMap} | null = null
/** 盘上那份读过了没有（只读一次） */
let loadedFromDisk = false

/** 把这份排名写进 `data/marketcap-ranks.json`（失败就算了，不影响行情） */
function saveToDisk(at: number, ranks: RankMap): void {
  try {
    fs.writeFileSync(
      RANKS_FILE,
      JSON.stringify({at, ranks: Object.fromEntries(ranks)}),
      'utf8'
    )
  } catch {
    /* 盘写不进去（只读挂载之类）不影响功能 */
  }
}

/** 读盘上那份（只在内存空的时候读一次） */
function loadFromDisk(): void {
  if (loadedFromDisk) return
  loadedFromDisk = true
  try {
    const raw = JSON.parse(fs.readFileSync(RANKS_FILE, 'utf8')) as {
      at?: number
      ranks?: Record<string, number>
    }
    const entries = Object.entries(raw.ranks ?? {}).filter(
      ([k, v]) => k && Number.isFinite(Number(v))
    )
    if (!entries.length) return
    cache = {at: Number(raw.at) || 0, ranks: new Map(entries.map(([k, v]) => [k, Number(v)]))}
  } catch {
    /* 没有 / 坏了都当没有 */
  }
}
/** 最近一次失败的时间（用来退避） */
let failedAt = 0
let inflight: Promise<number> | null = null

interface CgCoin {
  symbol?: string
  market_cap_rank?: number | null
}

/**
 * 本地开发要走的出网代理：优先仓库里那个 `EXCHANGE_PROXY`，退回 `HTTPS_PROXY`。
 * 没配（生产）就是 null —— 直连。
 */
function proxyUrl(): string | null {
  const p = (process.env.EXCHANGE_PROXY || process.env.HTTPS_PROXY || '').trim()
  return /^https?:\/\//.test(p) ? p : null
}

/**
 * 取一次 JSON（外部接口）。
 *
 * ⚠️⚠️ **为什么不让 `fetch` 自己走代理**（2026-10-12 用户报「合约界面的币种市值排行怎么没了」）：
 *   Node 的「环境变量代理」是**进程启动那一刻**读的（`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`），
 *   而本项目的这些变量是 **dotenv 在运行时**灌进 `process.env` 的 —— 对 `fetch` 来说太晚了，
 *   它永远走直连。本机直连 `api.coingecko.com` 是连不通的（实测 10 秒 connect timeout），
 *   于是整套「市值排名」静默失效：接口不报错，只是每行少了 No.x。
 *
 *   所以这里跟仓库里那几处（ws / ccxt 的 `wsAgent()`）一样**自己建 agent**，
 *   用的是同一个包 `https-proxy-agent`，不依赖启动环境 —— 这样 `npm run web` 怎么起都对。
 */
async function fetchJson(url: string): Promise<unknown> {
  const proxy = proxyUrl()
  if (!proxy) {
    const res = await fetch(url, {signal: AbortSignal.timeout(12_000)})
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`)
    return res.json()
  }

  const [{HttpsProxyAgent}, https] = await Promise.all([
    import('https-proxy-agent'),
    import('node:https')
  ])
  return await new Promise<unknown>((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: new HttpsProxyAgent(proxy) as never,
        /*
         * ⚠️ `user-agent` **不能省**：`https.get` 默认不发 UA（`fetch` 会带 `undici`），
         *    而 CoinGecko 前面那层 Cloudflare 对**空 UA 直接 403**（实测：
         *    同一 URL 经代理 curl=200、空 UA=403）。
         */
        headers: {'accept': 'application/json', 'user-agent': 'ait/1.0'},
        timeout: 12_000
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`CoinGecko ${res.statusCode}`))
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error('CoinGecko 返回的不是 JSON'))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('CoinGecko 超时（12 秒）')))
    req.on('error', reject)
  })
}

async function fetchPage(page: number): Promise<RankMap> {
  const url =
    `${CG_URL}?vs_currency=usd&order=market_cap_desc` +
    `&per_page=250&page=${page}&sparkline=false`
  const list = (await fetchJson(url)) as CgCoin[]
  const out: RankMap = new Map()
  for (const c of list) {
    const sym = String(c.symbol ?? '').toUpperCase()
    const rank = Number(c.market_cap_rank)
    if (!sym || !Number.isFinite(rank) || rank <= 0) continue
    // 同名币（少见，比如好几个都叫 SATS）：留排名更靠前的那个
    const old = out.get(sym)
    if (old === undefined || rank < old) out.set(sym, rank)
  }
  return out
}

/** 现在就重拉（启动预热用）。并发调用只跑一次。 */
export async function refreshMarketCapRanks(): Promise<number> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const merged: RankMap = new Map()
      for (let p = 1; p <= PAGES; p++) {
        const m = await fetchPage(p)
        for (const [k, v] of m) {
          const old = merged.get(k)
          if (old === undefined || v < old) merged.set(k, v)
        }
      }
      if (!merged.size) throw new Error('返回是空的')
      cache = {at: Date.now(), ranks: merged}
      saveToDisk(cache.at, merged)
      failedAt = 0
      return merged.size
    } catch (e) {
      // ⚠️ 失败**不能**把旧数据清掉：行情页照样要能看，只是第二行少个排名
      failedAt = Date.now()
      console.warn(
        `[marketcap] 市值排名拉取失败（继续用上次那份）：${(e as Error).message}`
      )
      return cache?.ranks.size ?? 0
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * 拿当前的排名表（**同步**，永远不会抛）。
 * 没有数据 / 数据过期 → 在后台刷一份，这次先给旧的（空 Map 也能用）。
 */
export function marketCapRanks(): RankMap {
  if (!cache) loadFromDisk()
  const now = Date.now()
  const stale = !cache || now - cache.at > TTL_MS
  const backedOff = failedAt && now - failedAt < RETRY_MS
  if (stale && !backedOff && !inflight) {
    void refreshMarketCapRanks().catch(() => undefined)
  }
  return cache?.ranks ?? new Map()
}

/**
 * 某个币种的市值排名（查不到就是 null）。
 *
 * ⚠️ 币安为了显示好看，会把「总量巨大、单价极低」的币**按倍数挂牌**：
 * `1000PEPE` / `1000SHIB` / `1000BONK` / `1MBABYDOGE` / `1000000MOG`…
 * 而 CoinGecko 用的是原始符号（pepe / shib / bonk / babydoge / mog），
 * 直接按符号查会**全部落空** —— 实测 528 个合约里有 13 个是这种，
 * 而且偏偏都是热门币，所以这里去掉前缀再查一次。
 */
export function rankOf(ranks: RankMap, base: string): number | null {
  const b = base.toUpperCase()
  const direct = ranks.get(b)
  if (direct) return direct
  const m = /^(?:1000000|100000|10000|1M|1000)(.+)$/.exec(b)
  if (m?.[1]) return ranks.get(m[1]) ?? null
  return null
}
