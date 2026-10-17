/**
 * **画线的穿线提醒**（用户 2026-10-17）：「点击画的线可以添加超过该线提醒，
 * 在自动化预测显示所有的提醒」。
 *
 * 为什么在服务器盯：提醒的全部价值就在「网页没开的时候也会响」。前端那条
 * `/api/tickers/stream` 只在页面开着时连，手机睡了就断 —— 所以判定放后端。
 *
 * 数据来源是 `kline-stream` 那条**全市场**行情（币安 `!ticker@arr`）：
 * 一条流覆盖所有交易对、零权重，正好拿来盯几百条提醒。⚠️ 这个订阅本身就是
 * 「保持这条流常开」的引用 —— 别把它退订，否则提醒只在有人看行情时才生效。
 *
 * 判定口径（**只在穿过去那一下响**，不是「只要在线外就每秒响」）：
 *   · `above`：上一次见到时还在线下（`价 < 线`），这一批 ≥ 线 ⇒ 响；
 *   · `below`：上一次见到时还在线上，这一批 ≤ 线 ⇒ 响。
 * 新加的提醒拿当前价当「上一次」的初值：如果建的时候价已经在触发侧，那要等它
 * 回到另一边再穿回来才响（否则一建就响，纯噪音）。
 */
import {subscribeTickers, type TickerPatch} from './data/kline-stream'
import {listActiveAlerts, markAlertTriggered, type KlineAlert} from './db/kline-alerts'
import {disablePushToken, listPushTokens, notePushError} from './db/push'
import {sendPush} from './notify/push'
import {sendTelegram} from './notify/telegram'

/** 多久重新读一遍「还在等的提醒」（新加的 / 删掉的 / 重新盯的都能在一分钟内生效） */
const RELOAD_MS = 60_000

/** 正在等的那批（内存副本；触发一条就从里面摘掉一条） */
let active: KlineAlert[] = []
/** 交易对 → 这个交易对上的提醒（每秒一批几百个币，不能每来一个都把全表扫一遍） */
let byPair = new Map<string, KlineAlert[]>()
/** alert.id → 上一次见到时「在触发侧」吗（见文件头的判定口径） */
const wasFar = new Map<number, boolean>()
/** 交易对（DOGEUSDT）→ 最近一次见到的价（新提醒拿它当初值） */
const lastPrice = new Map<string, number>()

let stopTickers: (() => void) | null = null
let reloadTimer: ReturnType<typeof setInterval> | null = null
let reloading = false
let started = false

/** 基础币 → 币安原始交易对（`DOGE` → `DOGEUSDT`；已经是 `DOGEUSDT` 就别再拼） */
function pairOf(symbol: string): string {
  const s = String(symbol ?? '').toUpperCase()
  return s.endsWith('USDT') ? s : `${s}USDT`
}

/** 这个价算不算「已经穿到触发侧」 */
function isFar(a: {op: string; price: number}, price: number): boolean {
  return a.op === 'below' ? price <= a.price : price >= a.price
}

/** 读一遍还在等的提醒（失败只告警：数据库抖一下不能把提醒永久搞死） */
async function reload(): Promise<void> {
  if (reloading) return
  reloading = true
  try {
    active = await listActiveAlerts()
    byPair = new Map()
    for (const a of active) {
      const key = pairOf(a.symbol)
      const list = byPair.get(key)
      if (list) list.push(a)
      else byPair.set(key, [a])
    }
    const alive = new Set(active.map(a => a.id))
    for (const id of [...wasFar.keys()]) if (!alive.has(id)) wasFar.delete(id)
  } catch (e) {
    console.warn(`[alert] 读提醒失败：${(e as Error).message}`)
  } finally {
    reloading = false
    syncSubscription()
  }
}

/**
 * 有提醒才订阅行情（一条都没有就别白占一条上游 WS）。
 *
 * ⚠️ 反过来**不能**跟着「有没有人在看行情」走：网页关掉正是提醒最该干活的时候。
 */
function syncSubscription(): void {
  if (active.length && !stopTickers) {
    stopTickers = subscribeTickers(onTicker)
  } else if (!active.length && stopTickers) {
    stopTickers()
    stopTickers = null
  }
}

/** 给一条提醒定初值（有已知价就用它，没有就等第一批行情） */
function seed(a: KlineAlert): void {
  if (wasFar.has(a.id)) return
  const p = lastPrice.get(pairOf(a.symbol))
  if (typeof p === 'number') wasFar.set(a.id, isFar(a, p))
}

/** 刚在网页上加了 / 重新盯了一条 —— 立刻捞进来，不用等下一分钟 */
export async function noteAlertChanged(): Promise<void> {
  await reload()
  for (const a of active) seed(a)
}

/** 穿线了：落库（幂等）+ 从内存摘掉 + 推给这个用户的所有设备 + Telegram */
async function fire(a: KlineAlert, price: number): Promise<void> {
  let won = false
  try {
    won = await markAlertTriggered(a.id, price)
  } catch (e) {
    console.warn(`[alert] 标记触发失败（${a.symbol} #${a.id}）：${(e as Error).message}`)
    return
  }
  if (!won) return
  active = active.filter(x => x.id !== a.id)
  wasFar.delete(a.id)
  const bucket = byPair.get(pairOf(a.symbol))
  if (bucket) {
    const rest = bucket.filter(x => x.id !== a.id)
    if (rest.length) byPair.set(pairOf(a.symbol), rest)
    else byPair.delete(pairOf(a.symbol))
  }

  const pair = pairOf(a.symbol)
  const dir = a.op === 'below' ? '跌破' : '上穿'
  const line = `${a.price}`
  console.log(`[alert] ${pair} ${dir} ${line}（现价 ${price}）· 用户 ${a.userId}`)

  void notify(a, price).catch(e =>
    console.warn(`[alert] 通知失败：${(e as Error).message}`)
  )
}

/** 通知（best-effort，跟 `analysis/persist.ts` 一个规矩：通知绝不拖累主流程） */
async function notify(a: KlineAlert, price: number): Promise<void> {
  const pair = pairOf(a.symbol)
  const dir = a.op === 'below' ? '跌破' : '上穿'
  const digits = Math.abs(a.price) >= 100 ? 2 : Math.abs(a.price) >= 1 ? 4 : 6
  const title = `${pair} ${dir} ${a.price.toFixed(digits)}`
  const body = `现价 ${price}${a.note ? ` · ${a.note}` : ''}`

  void sendTelegram(`⛳ ${title}\n${body}`)

  let tokens: {token: string}[] = []
  try {
    tokens = await listPushTokens(a.userId)
  } catch (e) {
    console.warn(`[alert] 读推送 token 失败：${(e as Error).message}`)
    return
  }
  let ok = 0
  for (const t of tokens) {
    const r = await sendPush(t.token, {
      title: `价格提醒 · ${title}`,
      body,
      data: {symbol: a.symbol, price: String(price), alert: '1'}
    })
    if (r.ok) ok++
    else if (r.dead) await disablePushToken(t.token, r.reason).catch(() => undefined)
    else if (r.reason !== 'not-configured' && r.reason !== 'no-access-token')
      await notePushError(t.token, r.reason).catch(() => undefined)
  }
  if (tokens.length) console.log(`[alert] 推送 ${ok}/${tokens.length} 台设备`)
}

/** 一批行情：登记最新价 → 逐条比对 */
function onTicker(patches: TickerPatch[]): void {
  if (!active.length) return
  for (const p of patches) {
    lastPrice.set(p.pair, p.last)
    const list = byPair.get(p.pair)
    if (!list) continue
    for (const a of list) {
      const far = isFar(a, p.last)
      const prev = wasFar.get(a.id)
      if (prev === undefined) {
        /* 头一次见到这个价：只登记，不响（见文件头「判定口径」） */
        wasFar.set(a.id, far)
        continue
      }
      if (far && !prev) void fire(a, p.last)
      else if (far !== prev) wasFar.set(a.id, far)
    }
  }
}

/** 启动（幂等）。DB 没起来也不慌：`reload()` 每分钟重试一次。 */
export function startPriceAlerts(): void {
  if (started) return
  started = true
  void reload().finally(() => {
    for (const a of active) seed(a)
    console.log(`  价格提醒  盯 ${active.length} 条（服务器自己盯，网页没开也响）`)
  })
  reloadTimer = setInterval(() => void reload(), RELOAD_MS)
  reloadTimer.unref()
}

/** 只在测试 / 退出时用 */
export function stopPriceAlerts(): void {
  if (reloadTimer) clearInterval(reloadTimer)
  reloadTimer = null
  stopTickers?.()
  stopTickers = null
  started = false
}
