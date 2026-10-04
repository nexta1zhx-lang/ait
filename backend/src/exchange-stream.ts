/**
 * 交易所资产 · **实时层**（M2，方案见 `docs/EXCHANGE.md`）。
 *
 * 干什么：每条「币安合约」的 key 开一条常驻的**用户数据流**，实时收
 *   · `ORDER_TRADE_UPDATE` —— 下单 / 成交 / 撤单 → 成交写进 `exchange_fills`（幂等）
 *   · `ACCOUNT_UPDATE`      —— 余额 / 仓位变了 → 拉一次完整快照落库（节流 20s）
 *   · `listenKeyExpired`    —— 重建
 *
 * ⚠️⚠️ 三个实测/设计上的硬约束（别改）：
 *   ① **ccxt 社区版做不了**（`watchOrders()` 抛 "not supported yet"，ccxt.pro 才有）
 *      ⇒ 自己连裸 WS：`POST /fapi/v1/listenKey` + `wss://fstream.binance.com/ws/<key>`。
 *      listenKey 的增删改用 ccxt 的隐式方法（已验证可用），WS 用 `ws` 包。
 *   ② **WS 不能替代 REST**：断线期间事件会丢，而这是钱 ⇒
 *      · 连上（含重连成功）后立刻 REST 拉一次对账；
 *      · 另外每 5 分钟还有一次全量采样（`startSnapshotSampler`）——**那次就是兜底对账**，
 *        所以不用再单独搞一个 15 分钟的对账任务。
 *   ③ **C2C 钱包没有 WS 事件**（用户数据流只覆盖合约）⇒ C2C 只能靠 5 分钟轮询。
 *
 * ⚠️ 单实例假设：多副本会重复订阅同一个 key（要分布式锁 / 指定主副本），见 docs。
 */
import {WebSocket} from 'ws'
import {createExchange, type ExchangeCredentials} from './data/exchange-account'
import {fetchExchangeOverview} from './data/exchange-overview'
import {saveSnapshot, upsertFill} from './db/exchange-store'
import {query} from './db/client'

/** 采样间隔：5 分钟（曲线用；同时兼作 REST 兜底对账） */
const SAMPLE_MS = 5 * 60 * 1000
/** listenKey 30 分钟过期，25 分钟续一次留点余量 */
const KEEPALIVE_MS = 25 * 60 * 1000
/** ACCOUNT_UPDATE 触发的快照最短间隔（秒）—— 一秒来几条事件时别全写库 */
const WS_SNAPSHOT_GAP_SEC = 20

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

/** 要盯的 key：填了凭据的**合约**账户（现货不参与统计，见方案） */
async function listKeys(): Promise<KeyRow[]> {
  return query<KeyRow>(
    `SELECT id, user_id, exchange, name, api_key, secret, password, market_type, sandbox
       FROM user_exchange_keys
      WHERE api_key <> '' AND secret <> '' AND market_type = 'swap'
      ORDER BY id`
  )
}

function credsOf(r: KeyRow): ExchangeCredentials {
  return {
    exchange: r.exchange,
    apiKey: r.api_key,
    secret: r.secret,
    password: r.password,
    marketType: r.market_type,
    sandbox: r.sandbox
  }
}

/** 用户数据流的 WS 地址（沙盒是另一台主机） */
function streamUrl(listenKey: string, sandbox: boolean): string {
  const host = sandbox ? 'wss://stream.binancefuture.com' : 'wss://fstream.binance.com'
  return `${host}/ws/${listenKey}`
}

/* ==================================================================
 * 一条 key = 一条流
 * ================================================================== */

class KeyStream {
  private ws: WebSocket | null = null
  private ex: any = null
  private listenKey = ''
  private stopped = false
  private retry = 0
  private keepTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  /** 连上过没有（用来判断是不是「重连」） */
  private everConnected = false

  constructor(private readonly row: KeyRow) {}

  private get tag(): string {
    return `[exch:${this.row.id}]`
  }

  /** 起流（含建 listenKey）。失败会自己退避重试，不抛给调用方。 */
  async start(): Promise<void> {
    this.stopped = false
    try {
      this.ex = createExchange(credsOf(this.row))
      await this.ex.loadMarkets()
      this.listenKey = String(
        (await this.ex.fapiPrivatePostListenKey())?.listenKey ?? ''
      )
      if (!this.listenKey) throw new Error('没拿到 listenKey')
      console.log(`${this.tag} listenKey 就绪（${this.listenKey.length} 位）`)
      this.open()
      this.keepTimer = setInterval(() => void this.keepAlive(), KEEPALIVE_MS)
    } catch (e) {
      console.warn(
        `${this.tag} 起流失败：${(e as Error).message.slice(0, 160)}`
      )
      this.retryLater()
    }
  }

  private open(): void {
    const ws = new WebSocket(streamUrl(this.listenKey, this.row.sandbox))
    this.ws = ws
    ws.on('open', () => {
      const isReconnect = this.everConnected
      this.everConnected = true
      this.retry = 0
      console.log(`${this.tag} WS 已连（用户数据流${isReconnect ? '·重连' : ''}）`)
      /*
       * ⚠️ 连上（尤其是**重连**）之后必须 REST 对账一次 ——
       * 断线那段时间的事件是丢的，账目会漂。
       */
      void this.snapshot(isReconnect ? 'ws' : 'boot', WS_SNAPSHOT_GAP_SEC)
    })
    ws.on('message', (d: Buffer) => void this.onMessage(String(d)))
    ws.on('error', (e: Error) =>
      console.warn(`${this.tag} WS 错误：${e.message.slice(0, 140)}`)
    )
    ws.on('close', () => {
      if (this.stopped) return
      console.warn(`${this.tag} WS 断开`)
      this.retryLater()
    })
  }

  private async onMessage(raw: string): Promise<void> {
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      return
    }
    const e = String(ev?.e ?? '')
    if (e === 'ORDER_TRADE_UPDATE') {
      await this.onOrder(ev?.o ?? {})
      return
    }
    if (e === 'ACCOUNT_UPDATE') {
      // 余额/仓位变了 → 事件里**没有** totalMarginBalance 这种汇总字段，
      // 所以拉一次完整的（节流 20s，一天最多几千次也够便宜）
      await this.snapshot('ws', WS_SNAPSHOT_GAP_SEC)
      return
    }
    if (e === 'listenKeyExpired') {
      console.warn(`${this.tag} listenKey 过期，重建`)
      this.restart()
    }
  }

  /**
   * 一笔订单事件 → 成交写账本。
   *
   * ⚠️ `NEW` / `CANCELED` / `EXPIRED` 只是**挂单状态变化**，不是成交 ——
   * 方案里定的「只存成交」，所以只处理 `x=TRADE` / `X=FILLED` 且带 tradeId 的。
   */
  private async onOrder(o: any): Promise<void> {
    const tradeId = String(o?.t ?? '')
    const lastQty = Number(o?.l ?? 0)
    if (!tradeId || tradeId === '0' || !(lastQty > 0)) return

    try {
      const isNew = await upsertFill(this.row.user_id, this.row.id, {
        orderId: String(o?.i ?? ''),
        tradeId,
        symbol: String(o?.s ?? ''),
        side: String(o?.S ?? '').toLowerCase(),
        price: Number(o?.L ?? 0),
        amount: lastQty,
        fee: Math.abs(Number(o?.n ?? 0)),
        feeCcy: String(o?.N ?? ''),
        realized: Number(o?.rp ?? 0),
        ts: new Date(Number(o?.T ?? Date.now())),
        raw: o
      })
      if (isNew) {
        console.log(
          `${this.tag} 成交 ${o?.s} ${o?.S} ${lastQty}@${o?.L}` +
            (Number(o?.rp) ? ` 已实现 ${o.rp}` : '')
        )
      }
    } catch (err) {
      console.warn(`${this.tag} 写成交失败：${(err as Error).message.slice(0, 140)}`)
    }
  }

  /**
   * 拉一次完整快照写库。
   * ⚠️ **失败就只记日志、不写库** —— 绝不能把「拉不到」写成一条 0 的快照，
   *    那会在资产曲线上戳出一个假的「跌到 0」。
   */
  async snapshot(source: 'boot' | 'ws' | 'poll' | 'shutdown', minGapSec = 0): Promise<void> {
    try {
      const ov = await fetchExchangeOverview(credsOf(this.row))
      const wrote = await saveSnapshot(this.row.user_id, this.row.id, ov, {
        source,
        minGapSec
      })
      if (wrote) {
        const net = ov.futures.margin + (ov.c2c?.totalUsdt ?? 0)
        console.log(`${this.tag} 快照已写（${source}）净资产 ${net}`)
      }
    } catch (e) {
      console.warn(`${this.tag} 取数失败：${(e as Error).message.slice(0, 140)}`)
    }
  }

  /** listenKey 续期（币安要求 30 分钟内至少 PUT 一次） */
  private async keepAlive(): Promise<void> {
    if (this.stopped) return
    try {
      if (typeof this.ex?.fapiPrivatePutListenKey !== 'function') return
      await this.ex.fapiPrivatePutListenKey({listenKey: this.listenKey})
    } catch (e) {
      console.warn(
        `${this.tag} 续期失败（${(e as Error).message.slice(0, 100)}），重建流`
      )
      this.restart()
    }
  }

  /** 断了之后**指数退避**重连（1s → 2 → 4 … 最多 60s） */
  private retryLater(): void {
    if (this.stopped) return
    this.retry++
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.retry, 6))
    console.log(`${this.tag} ${wait / 1000}s 后重连（第 ${this.retry} 次）`)
    this.retryTimer = setTimeout(() => void this.restart(), wait)
  }

  private restart(): void {
    if (this.stopped) return
    this.cleanup()
    this.stopped = false
    void this.start()
  }

  private cleanup(): void {
    this.stopped = true
    if (this.keepTimer) clearInterval(this.keepTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.keepTimer = null
    this.retryTimer = null
    try {
      this.ws?.removeAllListeners()
      this.ws?.close()
    } catch {
      /* 关不干净无所谓 */
    }
    this.ws = null
  }

  /** 优雅退出：删 listenKey + 断 WS + 关实例 */
  async stop(): Promise<void> {
    this.cleanup()
    try {
      if (this.listenKey && typeof this.ex?.fapiPrivateDeleteListenKey === 'function') {
        await this.ex.fapiPrivateDeleteListenKey({listenKey: this.listenKey})
      }
      await this.ex?.close?.()
    } catch {
      /* 收尾失败无所谓 */
    }
    this.listenKey = ''
  }
}

/* ==================================================================
 * 对外：启动 / 停止 / 采样
 * ================================================================== */

const streams = new Map<number, KeyStream>()
let sampler: NodeJS.Timeout | null = null

/**
 * 启动：给每条合约 key 写一条**启动锚点**快照，然后起流。
 * 不 await（联网慢不拖启动），失败只告警。
 */
export function startExchangeStreams(): void {
  void (async () => {
    try {
      const keys = await listKeys()
      if (!keys.length) return
      console.log(`  交易所资产  盯 ${keys.length} 套合约账户`)
      for (const row of keys) {
        const s = new KeyStream(row)
        streams.set(row.id, s)
        // 锚点：进程启动这一刻先落一条（曲线两端都要有点，见 docs）
        await s.snapshot('boot')
        await s.start()
        // ⚠️ 错开握手：币安 WS 连接限 300 次/5 分钟/IP ⇒ 限速 1 条/秒
        await new Promise(r => setTimeout(r, 1000))
      }
    } catch (e) {
      console.warn('  交易所资产  启动失败：', (e as Error).message.slice(0, 160))
    }
  })()
}

/** 5 分钟采样（曲线 + 兜底对账；C2C 只能靠它） */
export function startSnapshotSampler(): void {
  if (sampler) return
  sampler = setInterval(() => {
    void (async () => {
      for (const s of streams.values()) {
        // 采样点就是 REST 全量拉，跟对账是同一件事
        await s.snapshot('poll')
      }
    })()
  }, SAMPLE_MS)
}

/** 进程退出：写**关闭锚点** + 断流删 listenKey */
export async function stopExchangeStreams(): Promise<void> {
  if (sampler) clearInterval(sampler)
  sampler = null
  for (const s of streams.values()) {
    await s.snapshot('shutdown')
    await s.stop()
  }
  streams.clear()
}
