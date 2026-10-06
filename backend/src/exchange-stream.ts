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
import {
  createExchange,
  wsAgent,
  type ExchangeCredentials
} from './data/exchange-account'
import {
  fetchExchangeOverview,
  type ExchangeOverview
} from './data/exchange-overview'
import {fetchIncomeHistory, incomeDedupeKey} from './data/exchange-trade'
import {subscribeMarkPrice} from './data/kline-stream'
import {
  publishLive,
  setStreamActive,
  withMark,
  type LivePosition
} from './data/position-cache'
import {
  saveSnapshot,
  upsertFill,
  upsertIncome,
  type FillInput,
  type IncomeInput
} from './db/exchange-store'
import {query, queryOne} from './db/client'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * 标记价合并窗口（毫秒）。
 *
 * 订了几个币就有几路 `@markPrice@1s`（每个币 1 秒 1 条），一条一条推给前端太吵；
 * 攒 `MARK_BATCH_MS` 一起重算推一次 —— 界面上 1 秒跳一次足够了。
 */
const MARK_BATCH_MS = 1000

/** 采样间隔：5 分钟（曲线用；同时兼作 REST 兜底对账） */
const SAMPLE_MS = 5 * 60 * 1000
/** listenKey 30 分钟过期，25 分钟续一次留点余量 */
const KEEPALIVE_MS = 25 * 60 * 1000
/** ACCOUNT_UPDATE 触发的快照最短间隔（秒）—— 一秒来几条事件时别全写库 */
const WS_SNAPSHOT_GAP_SEC = 20
/**
 * **定期 REST 对账成交**的间隔（2026-10-06 加）。
 *
 * ⚠️ 为什么非加不可：原来补成交**只在连上/重连时**跑一次。而本地网络下
 *    用户数据流经常「连上了却一帧不推」（假 IP，见 `kline-stream.ts` 头部），
 *    于是**成交永远补不回来** —— 用户实测：11:02 减仓那笔（已实现 -0.1299）
 *    一直到 11:07 都不在账本里，盈亏因此差了 6 倍。
 *    ⇒ 不能把「钱记得对不对」押在一条 WS 上，REST 得定期兜。
 */
const FILL_RECONCILE_MS = 60 * 1000
/** 每次定期对账往前看多久（重叠靠 `unique(key_id, trade_id)` 去重） */
const FILL_SAFETY_MS = 24 * 3600 * 1000
/**
 * **定期对账钱账本**（`/fapi/v1/income`）的间隔。
 *
 * ⚠️ 这个接口**权重 30**（比一般的贵 6 倍），别跟着成交那 60 秒一起跑。
 *    资金费 8 小时才结一次，10 分钟一轮足够早发现。
 */
const INCOME_RECONCILE_MS = 10 * 60 * 1000
/** 钱账本每次回看的跨度（币安只给最近 7 天） */
const INCOME_LOOKBACK_MS = 7 * 24 * 3600 * 1000
/**
 * 用户数据流多久没推任何帧就当**它哑了**。
 *
 * 用途：告诉前端「这套账户现在是降级的，你那边该自己兜底刷」——
 * 前端就不用猜（它只看得到我们这条 SSE，看不到上游那条）。
 */
const WS_DEAF_MS = 2 * 60 * 1000
/** 多久检查一次「哑了没」 */
const WS_HEALTH_MS = 30 * 1000
/** 重连补成交：最多盯几个交易对（每个一次 fetchMyTrades，权重 5） */
const BACKFILL_MAX_SYMBOLS = 8
/** 重连补成交：单页条数 / 最多翻几页（翻满就记日志，不无限翻） */
const BACKFILL_PAGE = 500
const BACKFILL_MAX_PAGES = 4
/**
 * 新绑的账户首次回补多久的成交。
 * ⚠️ 币安 `/fapi/v1/userTrades` **只给最近 7 天**（不传 startTime/endTime 时），
 *    所以别顶着 7 天边界写，留一小时的余量。
 */
const BACKFILL_FIRST_MS = 7 * 24 * 3600 * 1000 - 3600 * 1000

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

/** 要盯的 key：填了凭据的**合约**账户（现货 USDT 只是顺带统计，主体仍是合约，见方案） */
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
 * 事件广播（给 `GET /api/exchange/stream` 那条 SSE 用）
 * ================================================================== */

/** 推给前端的事件（`snapshot` 的载荷形状**对齐** `/api/exchange/overview`） */
export type ExchangeEvent =
  | {type: 'snapshot'; source: string; overview: ExchangeOverview}
  | {
      type: 'fill'
      fill: {
        symbol: string
        side: string
        price: number
        amount: number
        fee: number
        realized: number
        ts: string
      }
    }
  | {type: 'backfill'; added: number}
  /** 钱账本（income）有新行 —— 前端「盈亏」tab 重拉一次 */
  | {type: 'income'; added: number}
  /**
   * 上游用户数据流「哑了 / 恢复了」。
   * ⚠️ 前端只能看见这条 SSE（心跳一直有），看不到上游那条 —— 所以要靠这个
   *    事件才知道「现在得自己 REST 兜底刷」。
   */
  | {type: 'health'; deaf: boolean}

/** key_id → 订阅者 */
const listenerSets = new Map<number, Set<(ev: ExchangeEvent) => void>>()

function emit(keyId: number, ev: ExchangeEvent): void {
  const set = listenerSets.get(keyId)
  if (!set?.size) return
  for (const fn of set) {
    try {
      fn(ev)
    } catch {
      /* 一个订阅者出错别连累别人（比如 SSE 往一个已断的响应里写） */
    }
  }
}

/**
 * 订阅某套 key 的实时事件。返回退订函数。
 * ⚠️ SSE 那边**一定要在 `close` 里调它**：连接断了还留在集合里，就会一直往
 *    一个死响应里写（响应对象被 GC 之前还不报错，纯漏）。
 */
export function subscribeExchange(
  keyId: number,
  fn: (ev: ExchangeEvent) => void
): () => void {
  let set = listenerSets.get(keyId)
  if (!set) {
    set = new Set()
    listenerSets.set(keyId, set)
  }
  const bucket = set
  bucket.add(fn)
  return () => {
    bucket.delete(fn)
    if (!bucket.size) listenerSets.delete(keyId)
  }
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
  /** 最近一次取到的完整快照（补成交时靠它的持仓推交易对） */
  private lastOverview: ExchangeOverview | null = null
  /** 持仓币的标记价（币安原始符号 → 价）—— 改造 P4 逐笔重算未实现盈亏用 */
  private marks = new Map<string, number>()
  /** 已订的标记价流（币安原始符号 → 退订函数） */
  private markStops = new Map<string, () => void>()
  /** 标记价攒批的定时器（见 `MARK_BATCH_MS`） */
  private markTimer: NodeJS.Timeout | null = null
  /**
   * 上游最后推**任何一帧**的时间（0 = 还没推过）。
   *
   * ⚠️ 这是判断「流是不是哑了」的唯一依据 —— `open` 事件只能证明连上了，
   *    假 IP 那种情况连得上却一帧不推（见 `checkHealth`）。
   */
  private lastFrameAt = 0
  /** 当前是否处于「哑了」状态（用来只在翻转时发一次通知） */
  private deaf = false
  /** 定期对账的两个水位 */
  private lastFillReconcileAt = 0
  private lastIncomeReconcileAt = 0
  /** 定期对账 / 健康检查的定时器 */
  private reconTimer: NodeJS.Timeout | null = null
  private healthTimer: NodeJS.Timeout | null = null

  constructor(private readonly row: KeyRow) {}

  private get tag(): string {
    return `[exch:${this.row.id}]`
  }

  /**
   * 起流。`fresh = true` 才去建**新** listenKey，普通断线重连**复用旧的**。
   *
   * ⚠️ 别每次重连都 POST 一个新 listenKey：那个接口 **1 次 / 5 分钟**，
   *    而且一个账户最多留 60 个 key，建新的会把最老的挤掉 —— 可能顺手把用户
   *    自己那个量化程序的流踢下线。listenKey 能活 60 分钟、我们 25 分钟续一次，
   *    所以单纯断了的话直接拿旧的连回去就行。
   */
  async start(fresh = false): Promise<void> {
    this.stopped = false
    try {
      this.ex = createExchange(credsOf(this.row))
      await this.ex.loadMarkets()
      if (fresh || !this.listenKey) {
        this.listenKey = String(
          (await this.ex.fapiPrivatePostListenKey())?.listenKey ?? ''
        )
        if (!this.listenKey) throw new Error('没拿到 listenKey')
        console.log(`${this.tag} listenKey 就绪（${this.listenKey.length} 位）`)
      }
      setStreamActive(this.row.id, true)
      void this.open()
      if (!this.keepTimer) {
        this.keepTimer = setInterval(() => void this.keepAlive(), KEEPALIVE_MS)
      }
      /*
       * ★ 定期对账 + 健康检查（2026-10-06 加）。
       * ⚠️ 必须**无条件**起，不能等 `open` —— 假 IP 情况下 `open` 会触发
       *    （所以看起来一切正常），但一帧都不推，原来只在连上时对账一次，
       *    成交就永远补不回来了。
       */
      if (!this.reconTimer) {
        /*
         * ⚠️ 两个水位都置 **0**（不是 `Date.now()`）：这样第一轮 tick（60 秒后）
         *    就会把成交和钱账本都各对一次 —— 等 10 分钟才第一次拉 income
         *    意味着页面刚打开那几分钟「盈亏」是空的。
         */
        this.lastFillReconcileAt = 0
        this.lastIncomeReconcileAt = 0
        this.reconTimer = setInterval(
          () => void this.reconcileTick(),
          FILL_RECONCILE_MS
        )
      }
      if (!this.healthTimer) {
        // ⚠️ lastFrameAt 从起流算起 —— 否则刚起流就被判定成「哑了」
        this.lastFrameAt = Date.now()
        this.healthTimer = setInterval(() => this.checkHealth(), WS_HEALTH_MS)
      }
    } catch (e) {
      console.warn(
        `${this.tag} 起流失败：${(e as Error).message.slice(0, 160)}`
      )
      this.retryLater()
    }
  }

  private async open(): Promise<void> {
    // 本地开发要经代理才连得上（见 `data/exchange-account.ts` 的 `wsAgent()`）
    const ws = new WebSocket(streamUrl(this.listenKey, this.row.sandbox), {
      agent: await wsAgent()
    })
    this.ws = ws
    ws.on('open', () => {
      const isReconnect = this.everConnected
      this.everConnected = true
      this.retry = 0
      console.log(`${this.tag} WS 已连（用户数据流${isReconnect ? '·重连' : ''}）`)
      /*
       * ⚠️ 连上（尤其是**重连**）之后必须 REST 对账 ——
       * 断线那段时间的事件是丢的，账目会漂：快照要重拉、成交要补。
       */
      void this.reconcile(isReconnect ? 'ws' : 'boot')
    })
    ws.on('message', (d: Buffer) => void this.onMessage(String(d)))
    ws.on('error', (e: Error) =>
      console.warn(`${this.tag} WS 错误：${e.message.slice(0, 140)}`)
    )
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.stopped) return
      /*
       * 一定要把 close 码打出来 —— 1006 = 网络/被踢（看不出原因），
       * 400x = 币安主动拒（比如 listenKey 已经失效，要重建一个）。
       */
      const why = reason?.length ? ` ${String(reason).slice(0, 60)}` : ''
      console.warn(`${this.tag} WS 断开（${code}${why}）`)
      this.retryLater()
    })
  }

  /**
   * 连上 / 重连之后的对账：**先补快照，再补成交**。
   * ⚠️ 顺序不能反 —— 补成交要靠 `lastOverview` 里的持仓推交易对（可能刚开的仓，
   *    一笔成交都还没记过），所以得先把快照取回来。
   */
  private async reconcile(source: 'boot' | 'ws'): Promise<void> {
    await this.snapshot(source, WS_SNAPSHOT_GAP_SEC)
    await this.backfillFills()
  }

  /**
   * 用 REST **补断线期间漏掉的成交**（WS 断线期间的 `ORDER_TRADE_UPDATE` 是真丢了）。
   *
   * 交易对从两处凑：① 账本里最近 30 天交易过的币；② 当前有持仓的币。上限 8 个。
   * 起点 = 账本里最后一笔成交的时间（**往回多要 5 分钟**防边界漏单，重复的交给
   * `unique(key_id, trade_id)` 挡）；账本空的（新绑账户）就回补 7 天。
   *
   * ⚠️ 起点取「**安全窗口**」和「账本最后一笔」里**更早**的那个：
   *    只看安全窗口的话新绑账户补不到 7 天历史，只看最后一笔又会**跳过错单**
   *    （漏的正是账本里没有的那笔，实测踩过：11:02 减仓那笔一直补不回来）。
   *    重叠部分靠 `unique(key_id, trade_id)` 去重，扫多一遍没有任何代价。
   *
   * ⚠️ 每个币**单独 try/catch**：以前一个币抛错（比如某币已下线、接口回 `-1121`）
   *    整轮就中止，后面的币全都不补 —— 一个坏币能拖死整本账。
   */
  private async backfillFills(sinceOverride?: number): Promise<void> {
    let added = 0
    try {
      const syms = await this.symbolsToBackfill()
      if (!syms.length) return
      const fromLedger = await this.lastFillTs()
      const since = Math.min(sinceOverride ?? fromLedger, fromLedger)
      for (const raw of syms) {
        try {
          added += await this.backfillSymbol(raw, since)
        } catch (e) {
          console.warn(
            `${this.tag} 补 ${raw} 失败（跳过它继续）：${(e as Error).message.slice(0, 120)}`
          )
        }
        // 限速：userTrades 权重 5，合约总权重 2400/分钟 —— 慢一点无所谓
        await sleep(250)
      }
      if (added) {
        console.log(`${this.tag} REST 补成交 ${added} 笔`)
        emit(this.row.id, {type: 'backfill', added})
      }
    } catch (e) {
      console.warn(`${this.tag} 补成交失败：${(e as Error).message.slice(0, 140)}`)
    }
  }

  /** 补一个币的成交，返回新记了几笔 */
  private async backfillSymbol(raw: string, since: number): Promise<number> {
    const unified = this.ex?.market?.(raw)?.symbol ?? raw
    let cursor = since
    let added = 0
    for (let page = 0; page < BACKFILL_MAX_PAGES; page++) {
      const trades = await this.ex.fetchMyTrades(unified, cursor, BACKFILL_PAGE)
      if (!Array.isArray(trades) || !trades.length) break
      for (const t of trades) if (await this.saveTrade(t)) added++
      if (trades.length < BACKFILL_PAGE) break
      const lastTs = Number(trades[trades.length - 1]?.timestamp ?? 0)
      if (!(lastTs > cursor)) break
      // 下一页从最后一笔之后开始（重叠的那笔靠唯一键去重）
      cursor = lastTs + 1
    }
    return added
  }

  /** 要补哪些交易对（**交易所原始符号**，如 `BTCUSDT`；最多 8 个） */
  private async symbolsToBackfill(): Promise<string[]> {
    const rows = await query<{symbol: string}>(
      `SELECT symbol
         FROM exchange_fills
        WHERE key_id = $1 AND ts > now() - interval '30 days'
        GROUP BY symbol
        ORDER BY max(ts) DESC
        LIMIT $2`,
      [this.row.id, BACKFILL_MAX_SYMBOLS]
    )
    const set = new Set(rows.map(r => r.symbol).filter(Boolean))
    // 持仓存的是 ccxt 统一符号（BTC/USDT:USDT）→ 换成交易所原始符号
    for (const p of this.lastOverview?.futures.positions ?? []) {
      const raw = this.ex?.market?.(p.symbol)?.id ?? p.symbol
      if (raw) set.add(String(raw))
    }
    return [...set].slice(0, BACKFILL_MAX_SYMBOLS)
  }

  /** 账本里最后一笔成交的时间（往回多要 5 分钟，防边界漏单） */
  private async lastFillTs(): Promise<number> {
    const row = await queryOne<{t: string | null}>(
      `SELECT max(ts) AS t FROM exchange_fills WHERE key_id = $1`,
      [this.row.id]
    )
    const t = row?.t ? new Date(row.t).getTime() : Date.now() - BACKFILL_FIRST_MS
    return Math.max(0, t - 5 * 60 * 1000)
  }

  /**
   * 一笔 REST 查回来的成交 → 账本。
   * ⚠️ `symbol` 一律存**交易所原始符号**（WS 事件里的 `s` 就是这种，如 `BTCUSDT`）——
   *    否则同一笔成交会以两种写法进库，前端按币分组时就散了。
   */
  private async saveTrade(t: any): Promise<boolean> {
    const symbol = String(
      t?.info?.symbol ?? this.ex?.market?.(t?.symbol)?.id ?? t?.symbol ?? ''
    )
    const tradeId = String(t?.id ?? t?.info?.id ?? '')
    if (!symbol || !tradeId) return false
    const fill: FillInput = {
      orderId: String(t?.order ?? t?.info?.orderId ?? ''),
      tradeId,
      symbol,
      side: String(t?.info?.side ?? t?.side ?? '').toLowerCase(),
      price: Number(t?.price ?? 0),
      amount: Number(t?.amount ?? 0),
      fee: Math.abs(Number(t?.fee?.cost ?? t?.info?.commission ?? 0)),
      feeCcy: String(t?.fee?.currency ?? t?.info?.commissionAsset ?? ''),
      realized: Number(t?.info?.realizedPnl ?? 0),
      ts: new Date(Number(t?.timestamp ?? Date.now())),
      raw: t?.info ?? t
    }
    /*
     * ★ REST 这条路也顺手把钱账本写上（2026-10-06）。
     *
     * 为什么不全指望 `reconcileIncome()`：那个接口**权重 30**，10 分钟才跑一轮，
     * 刚减的仓要等最多 10 分钟才进「盈亏」。而这里的数据跟 income 接口同源
     * （`realizedPnl` / `commission`）、`tranId` 也用同一个成交号，
     * 所以两边写的是同一行 —— 60 秒一轮的成交对账顺带把盈亏也刷新了，
     * 10 分钟那个只管补 `FUNDING_FEE` / `TRANSFER` 这类**成交里没有**的。
     */
    const [isNew] = await Promise.all([
      upsertFill(this.row.user_id, this.row.id, fill),
      this.writeIncomeFromFill(fill).catch(() => undefined)
    ])
    return isNew
  }

  private async onMessage(raw: string): Promise<void> {
    // 收到任何一帧就算「流活着」—— 健康检查靠它（见 `checkHealth`）
    this.lastFrameAt = Date.now()
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
      this.restart(true)
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

    const fill: FillInput = {
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
    }

    try {
      const isNew = await upsertFill(this.row.user_id, this.row.id, fill)
      /*
       * ★ 钱账本同写一份（2026-10-06）：WS 这一帧里其实**同时带着**已实现盈亏和手续费，
       *   以前只把 `rp` 塞进成交表、手续费只留在成交行里没进「盈亏」口径。
       *   `tranId` 用**成交号** —— 跟 REST `/fapi/v1/income` 給的 `tranId` 是同一个，
       *   所以这两条路会自然撞在同一个唯一键上，不会记两遍。
       */
      await this.writeIncomeFromFill(fill)
      if (isNew) {
        console.log(
          `${this.tag} 成交 ${o?.s} ${o?.S} ${lastQty}@${o?.L}` +
            (Number(o?.rp) ? ` 已实现 ${o.rp}` : '')
        )
        emit(this.row.id, {
          type: 'fill',
          fill: {
            symbol: fill.symbol,
            side: fill.side,
            price: fill.price,
            amount: fill.amount,
            fee: fill.fee,
            realized: fill.realized,
            ts: fill.ts.toISOString()
          }
        })
      }
    } catch (err) {
      console.warn(`${this.tag} 写成交失败：${(err as Error).message.slice(0, 140)}`)
    }
  }

  /**
   * 把一帧成交拆成钱账本的两行：`REALIZED_PNL` 和 `COMMISSION`。
   *
   * ⚠️ 手续费记成**负数**（币安那边也是负的）—— 汇总时直接相加就能得到净收益，
   *    不用在展示层记「哪个类型要减」。
   * ⚠️ 只有非 0 才写：开仓那笔的 `rp` 是 0，写进去会白占行、还让「已实现」多一堆 0。
   */
  private async writeIncomeFromFill(f: FillInput): Promise<void> {
    const asset = f.feeCcy || 'USDT'
    const rows: IncomeInput[] = []
    if (f.realized !== 0) {
      rows.push({
        tranId: incomeDedupeKey({tranId: f.tradeId, tradeId: f.tradeId, asset}),
        incomeType: 'REALIZED_PNL',
        symbol: f.symbol,
        asset,
        amount: f.realized,
        ts: f.ts,
        tradeId: f.tradeId
      })
    }
    if (f.fee !== 0) {
      rows.push({
        tranId: incomeDedupeKey({tranId: f.tradeId, tradeId: f.tradeId, asset}),
        incomeType: 'COMMISSION',
        symbol: f.symbol,
        asset,
        amount: -Math.abs(f.fee),
        ts: f.ts,
        tradeId: f.tradeId
      })
    }
    if (!rows.length) return
    await upsertIncome(this.row.user_id, this.row.id, rows)
  }

  /**
   * **定期 REST 对账**（2026-10-06 加）—— 钱记得对不对不能押在一条 WS 上。
   *
   * 两条线，节奏不同：
   *   · 成交（`fetchMyTrades`，权重 5/币）：`FILL_RECONCILE_MS` 一轮，往前看 24 小时；
   *   · 钱账本（`/fapi/v1/income`，**权重 30**）：`INCOME_RECONCILE_MS` 一轮，回看 7 天。
   *
   * 都靠唯一键幂等，重叠扫同一段不会重复记账。
   */
  private async reconcileTick(): Promise<void> {
    if (this.stopped) return
    const now = Date.now()
    try {
      if (now - this.lastFillReconcileAt >= FILL_RECONCILE_MS) {
        this.lastFillReconcileAt = now
        await this.backfillFills(now - FILL_SAFETY_MS)
      }
      if (now - this.lastIncomeReconcileAt >= INCOME_RECONCILE_MS) {
        this.lastIncomeReconcileAt = now
        await this.reconcileIncome()
      }
    } catch (e) {
      console.warn(`${this.tag} 定期对账失败：${(e as Error).message.slice(0, 140)}`)
    }
  }

  /**
   * 拉交易所那本账（`/fapi/v1/income`）落库 —— **权威口径**，含资金费。
   * 详见 `data/exchange-trade.ts` 的 `fetchIncomeHistory`。
   */
  private async reconcileIncome(): Promise<void> {
    try {
      const list = await fetchIncomeHistory(credsOf(this.row), {
        startTime: Date.now() - INCOME_LOOKBACK_MS
      })
      if (!list.length) return
      const added = await upsertIncome(
        this.row.user_id,
        this.row.id,
        list.map(r => ({
          tranId: r.tranId,
          incomeType: r.incomeType,
          symbol: r.symbol,
          asset: r.asset,
          amount: r.amount,
          ts: new Date(r.ts),
          tradeId: r.tradeId,
          raw: r
        }))
      )
      if (added) {
        console.log(`${this.tag} 钱账本 +${added} 条（income 对账）`)
        emit(this.row.id, {type: 'income', added})
      }
    } catch (e) {
      console.warn(
        `${this.tag} income 对账失败：${(e as Error).message.slice(0, 140)}`
      )
    }
  }

  /**
   * 「上游那条用户数据流哑了吗」——哑了就告诉前端，让它自己兜底刷。
   *
   * ⚠️ 前端只能看到**我们这条 SSE**（心跳一直有），看不到上游那条 ——
   *    所以「SSE 活着」不等于「数据在动」，这个判断必须在后端做。
   */
  private checkHealth(): void {
    if (this.stopped) return
    const deaf = Date.now() - this.lastFrameAt > WS_DEAF_MS
    if (deaf === this.deaf) return
    this.deaf = deaf
    console.warn(
      deaf
        ? `${this.tag} 用户数据流 ${WS_DEAF_MS / 1000} 秒没推帧 —— 标记为降级（改用 REST 兜底）`
        : `${this.tag} 用户数据流恢复了`
    )
    emit(this.row.id, {type: 'health', deaf})
  }

  /* ---------------- 持仓实时重算（改造 P4） ---------------- */

  /**
   * ccxt 统一符号 → 币安原始符号（mark 流名要原始的）。
   * 认不出来就回空串 —— **宁可不订，也别去订一条不存在的流**。
   */
  private rawOf(unified: string): string {
    const id = String(this.ex?.market?.(unified)?.id ?? '')
    if (id) return id.toUpperCase()
    const s = String(unified ?? '').toUpperCase()
    return /^[A-Z0-9]+USDT$/.test(s) ? s : ''
  }

  /**
   * 让「订着的标记价」跟「手上的持仓」对齐：多退少补。
   * ⚠️ 只订**有持仓的币**（理由见 `subscribeMarkPrice` 的注释）。
   */
  private syncMarks(): void {
    const want = new Set<string>()
    for (const p of this.lastOverview?.futures.positions ?? []) {
      const raw = this.rawOf(p.symbol)
      if (raw) want.add(raw)
    }
    const dropped: string[] = []
    for (const [raw, stop] of [...this.markStops]) {
      if (!this.stopped && want.has(raw)) continue
      stop()
      this.markStops.delete(raw)
      this.marks.delete(raw)
      dropped.push(raw)
    }
    if (this.stopped) return
    const added: string[] = []
    for (const raw of want) {
      if (this.markStops.has(raw)) continue
      this.markStops.set(
        raw,
        subscribeMarkPrice(raw, (_sym, mark) => this.onMark(raw, mark))
      )
      added.push(raw)
    }
    /*
     * 只在**订阅集合真的变了**时打一行 —— 这是排查
     * 「未实现盈亏怎么不跳」的第一个抓手（订没订上、订的是哪几个币）。
     */
    if (added.length || dropped.length) {
      console.log(
        `${this.tag} 标记价订阅更新：持仓 ${want.size} 个币` +
          (added.length ? `，新订 ${added.join(' ')}` : '') +
          (dropped.length ? `，退订 ${dropped.join(' ')}` : '')
      )
    }
  }

  /** 一路标记价到了：先记下，攒一批再重算（见 `MARK_BATCH_MS`） */
  private onMark(raw: string, mark: number): void {
    if (this.stopped) return
    this.marks.set(raw.toUpperCase(), mark)
    if (this.markTimer) return
    this.markTimer = setTimeout(() => {
      this.markTimer = null
      this.pushLive(true)
    }, MARK_BATCH_MS)
  }

  /**
   * 把当前持仓写进**统一来源**（`position-cache`）—— 写一次就广播一次，
   * 前端所有页面（交易所板子 / K 线叠加 / 下单页）拿到的都是这一份。
   *
   * `live` = 这一份有没有叠过行情重算（`false` 就是刚拉回来的 REST 快照口径）。
   */
  private pushLive(live: boolean): void {
    const ov = this.lastOverview
    if (!ov) return
    const positions: LivePosition[] = ov.futures.positions.map(p => {
      const raw = this.rawOf(p.symbol)
      const mark = raw ? this.marks.get(raw) : undefined
      const row = withMark(p, live ? mark : undefined)
      return {...row, raw: raw || p.symbol}
    })
    publishLive(this.row.id, {
      wallet: ov.futures.wallet,
      positions,
      live: live && this.marks.size > 0
    })
  }

  /** 把订出去的标记价流全退掉 */
  private stopMarks(): void {
    if (this.markTimer) clearTimeout(this.markTimer)
    this.markTimer = null
    for (const stop of this.markStops.values()) stop()
    this.markStops.clear()
    this.marks.clear()
  }

  /**
   * 拉一次完整快照写库。
   * ⚠️ **失败就只记日志、不写库** —— 绝不能把「拉不到」写成一条 0 的快照，
   *    那会在资产曲线上戳出一个假的「跌到 0」。
   */
  async snapshot(
    source: 'boot' | 'ws' | 'poll' | 'shutdown',
    minGapSec = 0
  ): Promise<ExchangeOverview | null> {
    try {
      const ov = await fetchExchangeOverview(credsOf(this.row))
      const wrote = await saveSnapshot(this.row.user_id, this.row.id, ov, {
        source,
        minGapSec
      })
      this.lastOverview = ov
      /*
       * 持仓可能变了 → 标记价订阅跟着变；顺手把这一份（**REST 口径**）
       * 写进统一来源，前端三个页面立刻同步到同一个数。
       */
      this.syncMarks()
      this.pushLive(false)
      if (wrote) {
        const net = ov.futures.margin + (ov.c2c?.totalUsdt ?? 0)
        console.log(`${this.tag} 快照已写（${source}）净资产 ${net}`)
      }
      /*
       * ⚠️ **被节流拦下也要推**：数据是真拿到了（只是不值得再写一行库），
       * 前端要看的是此刻的钱，不是库里那一行。
       */
      emit(this.row.id, {type: 'snapshot', source, overview: ov})
      return ov
    } catch (e) {
      console.warn(`${this.tag} 取数失败：${(e as Error).message.slice(0, 140)}`)
      return null
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
      this.restart(true)
    }
  }

  /** 断了之后**指数退避**重连（1s → 2 → 4 … 最多 60s）。listenKey 能复用就复用。 */
  private retryLater(): void {
    if (this.stopped) return
    this.retry++
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.retry, 6))
    console.log(`${this.tag} ${wait / 1000}s 后重连（第 ${this.retry} 次）`)
    this.retryTimer = setTimeout(() => void this.restart(), wait)
  }

  private restart(fresh = false): void {
    if (this.stopped) return
    this.cleanup()
    this.stopped = false
    void this.start(fresh)
  }

  private cleanup(): void {
    this.stopped = true
    /* 流停了就不再是「持仓的权威来源」了：退掉标记价，别让 REST 走缓存走空 */
    this.stopMarks()
    setStreamActive(this.row.id, false)
    if (this.keepTimer) clearInterval(this.keepTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.reconTimer) clearInterval(this.reconTimer)
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.keepTimer = null
    this.retryTimer = null
    this.reconTimer = null
    this.healthTimer = null
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
/** 退出流程只跑一次 —— 连按两次 Ctrl+C（或 SIGINT + SIGTERM 一起来）别写两条锚点 */
let stopping = false

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
        await s.start(true)
        // ⚠️ 错开握手：币安 WS 连接限 300 次/5 分钟/IP ⇒ 限速 1 条/秒
        await sleep(1000)
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
  if (stopping) return
  stopping = true
  if (sampler) clearInterval(sampler)
  sampler = null
  for (const s of streams.values()) {
    await s.snapshot('shutdown')
    await s.stop()
  }
  streams.clear()
}

/** 调试用：现在盯了几条流 / 有几个 SSE 订阅者 */
export function exchangeStreamStatus(): {keys: number; listeners: number} {
  let listeners = 0
  for (const set of listenerSets.values()) listeners += set.size
  return {keys: streams.size, listeners}
}

/**
 * 把一条**外部取到的**快照推给订阅者。
 *
 * 为什么需要：`POST /api/exchange/refresh`（用户点 ⟳）是直接「取数 + 落库」，
 * 不经过 `KeyStream`，所以它自己不会 emit。不补这一下，用户点了刷新之后
 * **他自己另一个页面 / 另一个 tab 要等 5 分钟采样才看到新数**（只有那个请求的
 * 响应是新的）。
 */
export function publishSnapshot(
  keyId: number,
  overview: ExchangeOverview,
  source = 'manual'
): void {
  emit(keyId, {type: 'snapshot', source, overview})
}
