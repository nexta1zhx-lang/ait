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
 *      ⇒ 自己连裸 WS：`POST /fapi/v1/listenKey` + `wss://fstream.binance.com/private/ws/<key>`
 *      （**必须带 `/private`**：少了它连接照样 101 + 回 ping，但一个业务帧都不推，
 *        见 `streamUrl()` 的注释）。
 *      listenKey 的增删改用 ccxt 的隐式方法（已验证可用），WS 用 `ws` 包。
 *   ② **WS 负责实时，REST 只管兜底**（2026-10-06 第二轮订正，见 docs 第 27 节）：
 *      · 连上（含重连成功）后立刻 REST 拉一次对账 —— **这是真正确定的补账点**（断线期间的事件币安不补发）；
 *      · 平时成交 / 挂单 / 账本 / 快照**各 1 小时**一轮（空转 2 小时、睡着 4 小时），
 *        只当「防我们自己出 bug」的安全网；余额采样守 1 小时（曲线要连续）。
 *      · ⚠️ 流降级时自动退回正常档（见 `tierNow`）。
 *   ③ **C2C 钱包没有 WS 事件**（用户数据流只覆盖合约）⇒ C2C 只能靠那条 1 小时采样。
 *
 * 生命周期（2026-10-06 补全，用户：「不能只有启动没有终止」）：
 *   · 起：进程启动 `startExchangeStreams()` 逐套 key 写启动锚点 + 连 WS（错开 1 秒）；
 *   · 止：**只有两种** —— ① 进程退出（写关闭锚点 + DELETE listenKey）；
 *     ② **没人看 + 空仓无挂单**够久（`WS_SLEEP_AFTER_MS`）⇒ 只断连接，
 *     listenKey 照续、随时连回来（见 `sleepWs` / `wakeWs`）。
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
  deleteOpenOrder,
  replaceOpenOrders,
  saveSnapshot,
  upsertFill,
  upsertIncome,
  upsertOpenOrder,
  type FillInput,
  type IncomeInput,
  type OpenOrderInput
} from './db/exchange-store'
import {listOpenOrders} from './data/exchange-trade'
import {query, queryOne} from './db/client'
import {takeWeight} from './util/rate-budget'
import {noteRateLimit} from './util/rate-cool'

/**
 * 动手打交易所之前先跟**全局权重预算**报一声。
 * ⚠️ 预算必须全局：币安按**出口 IP** 算权重，一台服务器一个出口给所有用户共用。
 */
const chargeWeight = (weight: number, tag: string): Promise<void> =>
  takeWeight(weight, tag)

/** 数字兜底：拿不到 / 不是数就给 `null`（**别给 0** —— 0 会被当成「委托价就是 0」） */
function numOrNull(v: unknown): number | null {
  const x = Number(v)
  return Number.isFinite(x) && x !== 0 ? x : null
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * 保留 8 位小数。
 * ⚠️ 跟 `position-cache` / `exchange-overview` 里那个 `r8` 同一个精度 ——
 *    这三个地方算出来的是**同一个数**（同一屏上可能同时出现），精度不一致就会
 *    「左栏 8.09988529、右边 8.0998853」这种看着像 bug 的差。
 */
function r8(x: number): number {
  return Math.round(x * 1e8) / 1e8
}

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
/**
 * `ACCOUNT_UPDATE` 之后**再去问一次 REST 快照**的最小间隔（秒）。
 *
 * ⚠️ 2026-10-06 更正：这个数原来注释写的是「别全写库」，而且**只拦了写库**
 *    （`saveSnapshot` 的 `minGapSec`），**请求本身一次都没拦** ——
 *    一秒来 5 条 `ACCOUNT_UPDATE` 就是 5 发 REST（每发 21 权重）。
 *    现在事件里带的数据**当场就用**（见 `applyAccountUpdate`），REST 只补它没有的
 *    汇总口径，并且**真的按这个间隔拦请求**。
 *
 * ★ 2026-10-06 第三轮（路径修好之后，事件真的会来了）：20 秒 → **180 秒**。
 *    余额 / 持仓在事件里就更新完了（0 权重），快照只为「可用余额 / 保证金余额 /
 *    资产明细 / C2C / 现货」这些**事件里没有的汇总字段**，以及曲线 —— 三分钟一次足够。
 */
const WS_SNAPSHOT_GAP_SEC = 180
/**
 * **兜底的基准节奏**（有仓 / 有单 / 刚有动静的账户）。
 *
 * ★ 2026-10-06 第二次收敛（用户：「用户在线就没必要频繁对账，用户感觉不对可以刷新页面，
 *   移动端做下滑刷新」「在线不是有推送和计算吗，只有没数据才请求」）。
 *
 * 第一版把成交对账钉死在 **60 秒**，理由是「WS 会丢事件，兜底要勤」。但把账算清楚就
 * 发现：**实时那条路本来就是 WS 推送 + 本地标记价重算**，REST 对账只是「怕丢事件」的
 * 保险，而它的代价（成交 5 权重/币 × 最多 8 个币 = ≤40/分钟）是全套最贵的一项之一。
 * 用户给的方案很明确：**在线不靠 REST，感觉不对自己刷（下拉刷新）**。所以：
 *
 *   · 在线 ⇒ **不再全速**，就按这张表的基准走（成交 5 分钟 / 挂单 10 分钟 / 账本 30 分钟）；
 *   · 只在「**没有数据**」时才立刻请求 —— 冷启动没底稿、刚下单/平仓、WS 报哑或重连、
 *     用户手动刷新（含下拉），以及「数据已经旧了」时打开页面（见 `FRESH_MS`）；
 *   · 用户按下刷新 ⇒ `force`，无视一切节流，当场把这套账户的账对平。
 *
 * 各项「为什么是这个数」：
 *   · **成交 5 分钟** —— 丢一笔只影响「盈亏 / 成交」两个列表，而这俩用户随时能刷；
 *   · **挂单 10 分钟** —— 40 权重是全场最贵的一发；挂单的**变动** WS 会推，这里纯兜底；
 *   · **钱账本 30 分钟** —— 资金费 8 小时才结一次，勤也没用。
 */
/*
 * ★★ 2026-10-06 第二轮（用户数据流的路径修好之后）用户拍的口径：
 *   「更激进：前三个都拉到 1 小时，只留『重连 + 写操作 + 页面打开』」。
 *
 * 为什么敢：
 *   · 实时数据现在**真的走 WS**（`/private/ws/`，成交 18 毫秒落库，实测）；
 *   · 历史上那些「WS 丢事件」的实证，其实全是**路径错**（见 docs 第 26 节）——
 *     「偶发丢帧」很可能根本不存在；
 *   · 真正确定的丢事件场景只有**断线**，而 `reconcile('ws')` 在重连后立刻补一次。
 *
 * ⚠️ 所以这三条只当「防我们自己出 bug 的安全网」，不再是实时性的来源。
 * ⚠️ 但**余额曲线**（`sample`）不跟着拉长：C2C 钱包没有 WS 事件、汇总口径也只有 REST 有，
 *    曲线稀疏了就不好看了（用户明确要「余额要管、曲线不能断」）⇒ 睡觉的账户也照 1 小时采。
 */
const FILL_RECONCILE_MS = 60 * 60 * 1000
const ORDERS_RECONCILE_MS = 60 * 60 * 1000
const INCOME_RECONCILE_MS = 60 * 60 * 1000
/**
 * 打开页面时「数据旧到这个程度」就顺手补一次（用户：「只有没数据才请求」）。
 *
 * ⚠️ 不是「一打开就打交易所」：SSE 刚推过的账户（60 秒内）**一次都不请求**。
 */
const FRESH_MS = 60 * 1000
/**
 * 手动刷新（含下拉）的最小间隔 —— 前端也会防抖，这里再兜一道，
 * 免得「连点几下」把这一套账户的权重全花在一秒钟里。
 */
const FORCED_MIN_MS = 3 * 1000
/** 每次定期对账往前看多久（重叠靠 `unique(key_id, trade_id)` 去重） */
const FILL_SAFETY_MS = 24 * 3600 * 1000
/**
 * **空转时**的对账间隔（2026-10-06，用户问「长时间没有仓位或者用户不在线呢」）。
 *
 * ⚠️ 为什么必须有：币安权重是**按出口 IP** 算的，一台服务器所有用户共用 2400/分钟。
 *    而上面那几个定时器原来是**每套 Key 都跑、不管有没有仓位、不管用户上没上线**：
 *      挂单对账 40/2min + 钱账本 30/10min + 全量快照 ~21/5min ≈ **27 权重/分钟/套**
 *    ⇒ **约 88 套闲置账户就能把整个出口 IP 的额度吃光**。
 *    一个几个月没登录、没有任何仓位的账户，不该跟正在交易的账户花一样多。
 *
 * 判据（`isIdle()`）：**没持仓 + 没挂单 + 最近也没动静**。
 * 空转时把三类对账降到 30 分钟一轮（≈7 权重/分钟/套）。
 *
 * ⚠️ 2026-10-06 补了一档（原来漏了）：**成交对账也必须一起降**。
 *    第一版只降了挂单 / 钱账本 / 快照，`backfillFills` 还是 60 秒一轮，
 *    而它按「最近 30 天交易过的币 ∪ 持仓」逐币查（`fetchMyTrades` 权重 5/币，
 *    最多 8 个币 = 40 权重）—— **空转账户身上最贵的一项恰恰是它**
 *    （≤40/分钟，比挂单那 40/2分钟 还高一倍）。空转账户没有仓位，
 *    真来了新成交靠私有 WS 那条路就够，所以降到 10 分钟一轮。
 *
 * ⚠️ **私有 WS 和 listenKey 照旧连着**，所以「突然来一张新挂单 / 新成交」还是秒级
 *    （币安会推 `ORDER_TRADE_UPDATE`）—— 降频降的是**对账**，不是实时性。
 *    （⚠️ 例外：**空仓 + 无挂单 + 没人看**够久了，那条 WS 会主动断开省连接，
 *      见 `WS_SLEEP_AFTER_MS`；一有人来 / 一有敞口立刻连回去。）
 */
const ORDERS_RECONCILE_MS_IDLE = 2 * 60 * 60 * 1000
const INCOME_RECONCILE_MS_IDLE = 2 * 60 * 60 * 1000
const FILL_RECONCILE_MS_IDLE = 2 * 60 * 60 * 1000
/** 空转时全量快照的间隔（它是**钱包 / C2C 唯一的取数路**，但空账户的钱不会变） */
const SAMPLE_IDLE_MS = 60 * 60 * 1000
/** 多久没动静才算「空转」（刚下过单 / 刚平过仓的不算） */
const IDLE_MS = 10 * 60 * 1000
/**
 * **睡着**——比空转再降一档（2026-10-06，用户：「长时间用户不在线就不用管和合约和订单，
 * 余额要管要做曲线图」）。
 *
 * 判据（`isAsleep()`）：已空转 **且没人订阅**（`listenerCount() === 0`，就是「不在线」）
 * **且**连着 `HIBERNATE_MS` 没动静。睡着之后：
 *
 *   · 成交 / 挂单 / 钱账本三类对账 —— **全部降到 `ASLEEP_MS` 一轮**
 *     （合约和订单不用管了；真来了单子 WS 会推，`onOrder` 会把账户叫醒）；
 *   · **余额照管**：全量快照也 `ASLEEP_MS` 一轮（`sampleIfDue`），资产曲线不断档；
 *   · **私有 WS 只在「空仓无挂单」时才断**（`WS_SLEEP_AFTER_MS`，见下面那段终止流程）——
 *     这一档降的是「我们自己主动去问」的频率，不是实时性。
 *
 * 各档一小时的总权重（一套 Key）：
 *
 * | 档 | 成交 | 挂单 | 钱账本 | 快照 | 合计 | 每分钟 |
 * |---|---|---|---|---|---|---|
 * | 活跃（有仓 / 有单） | ≤2400 | 1200 | 180 | 252 | ≈4000 | ≈67 |
 * | 空转 | 240 | 80 | 60 | 42 | ≈420 | ≈7 |
 * | 睡着 | 40 | 40 | 30 | 21 | ≈131 | ≈2.2 |
 *
 * ⚠️ 为什么**余额必须留下**：`exchange_snapshots` 是资产曲线**唯一**的源，而且曲线是
 *    分档归档的（5m→1h→1d，见 `exchange-archive.ts`）—— 睡着期间断采，
 *    曲线上就会留一段假的空洞（用户明确要求「余额要管」）。
 *    余额其实只有资金费（8 小时一次）会动，1 小时采一次已经很富余；
 *    真嫌贵可以按资金费周期拉到 4 小时，成本再降 4 倍。
 */
const ASLEEP_MS = 60 * 60 * 1000
/** 空转多久、又没人看着，才算「睡着」 */
const HIBERNATE_MS = 2 * 60 * 60 * 1000
/** 钱账本每次回看的跨度（币安只给最近 7 天） */
const INCOME_LOOKBACK_MS = 7 * 24 * 3600 * 1000
/**
 * 用户数据流多久**毫无动静**（数据帧和 ping 都没有）就当它哑了。
 *
 * ⚠️ 必须**大于币安的 ping 周期（3 分钟）**：币安每 3 分钟发一个 ping 帧，
 *    所以「4 分钟没动静」才算异常。第一版写的 2 分钟会在一段安静期里
 *    把健康的流误报成降级（2026-10-06 我自己就被这个误判带偏过 ——
 *    真正的结论是「空闲时本来就没有数据帧」）。
 *
 * 用途：告诉前端「这套账户现在是降级的，你那边该自己兜底刷」——
 * 前端不用猜（它只看得到我们这条 SSE，看不到上游那条）。
 */
const WS_DEAF_MS = 4.5 * 60 * 1000

/**
 * ★ **上游 WS 的终止流程**（2026-10-06，用户：「不能只有启动没有终止，也要看用户在不在线」）。
 *
 * 条件（全满足才断）：**没人看**（`listenerCount() === 0`）+ **空仓且无挂单** +
 * 安静（账户没动静、也没人来过）超过 `WS_SLEEP_AFTER_MS` ⇒ 关掉到币安的那条 WS。
 *
 * 断的是什么、不断的是什么：
 *   · 断 —— 只是那条 WebSocket 连接（以及跟着它的标记价订阅）；
 *   · **不断** —— listenKey **照旧 25 分钟续一次**（`KEEPALIVE_MS`）。理由两条：
 *     ① 续期只要 1 次/25 分钟，几乎零成本；② 币安一个账户的 listenKey 是**共享**的，
 *     我们停续会让它在 60 分钟后过期，顺手把用户自己那个量化程序的流也踢下线。
 *     留着 key ⇒ 醒来时**一次 REST 都不用打**，直接 `open()` 连回去。
 *
 * ⚠️ 为什么「有持仓 / 有挂单」就**不许**断（用户选的方案）：持仓期间的消息
 *    （止损触发、强平提醒、部分成交）是真要看的 —— 赌「反正有 REST 1 小时兜底」
 *    意味着用户不在线时账本会漂最多 1 小时。空仓无单时没有任何东西可错过，才敢断。
 *
 * 代价就是一条空闲 TCP：WS **不吃权重**（权重只算 REST），币安侧只有
 * 300 次握手 / 5 分钟 / IP 的限制，稳态连着不花钱 —— 所以断的是「整洁」，
 * 不是「省钱」。真金白银的省在 REST 那三档（见 `TIER_GAPS`）。
 */
const WS_SLEEP_AFTER_MS = Number(
  process.env.EXCHANGE_WS_SLEEP_MS ?? 10 * 60 * 1000
)

/**
 * `deaf`（连 ping 都收不到）持续这么久 ⇒ 认定是**半开连接**，强制重连一次。
 *
 * ⚠️ 为什么要（2026-10-06 补）：NAT / 代理 / 负载均衡会**静默**吞掉连接 ——
 *    TCP 还以为活着，我们既不收事件也不收 ping，而 `close` 事件永远不来。
 *    只靠 `deaf` 标记只是「改用 REST 兜底」，那条死连接会一直挂到进程重启，
 *    用户不在线时正好是最需要它自愈的时候。
 */
const WS_DEAF_RESTART_MS = Number(
  process.env.EXCHANGE_WS_DEAF_RESTART_MS ?? 10 * 60 * 1000
)

/**
 * 条件单（`ALGO_UPDATE` 的 `o.X`）里哪些状态表示「这张单已经不在场上了」。
 *
 * ⚠️ 币安的条件单事件字段是 `aid`（不是普通单的 `i`）、状态在 `X` 里：
 *    实测见过 `CANCELED`（撤单）；`TRIGGERED` 表示**已经触发**（接下来会是真正的
 *    订单进场，由 `ORDER_TRADE_UPDATE` 接管）。其余状态（`NEW` 等）当作「还挂着」。
 */
const ALGO_GONE = new Set([
  'CANCELED',
  'EXPIRED',
  'REJECTED',
  'FINISHED',
  'TRIGGERED'
])
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
  /** 这套 Key 什么时候建的（`seedActivity` 拿它当「这辈子最早的动静」） */
  created_at: Date
}

/** 要盯的 key：填了凭据的**合约**账户（现货 USDT 只是顺带统计，主体仍是合约，见方案） */
async function listKeys(): Promise<KeyRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT id, user_id, exchange, name, api_key, secret, password, market_type, sandbox,
            created_at
       FROM user_exchange_keys
      WHERE api_key <> '' AND secret <> '' AND market_type = 'swap'
      ORDER BY id`
  )
  /*
   * ⚠️ `id` / `user_id` 是 BIGINT，`pg` 返回的是**字符串** —— 一定要在这里转成数字，
   *    否则 `KeyRow.id: number` 这个类型就在说谎，而下游（`emit` / `streams` 的键）
   *    会跟别处 `Number()` 过的值对不上（2026-10-06 那个「事件静默丢失」的根因）。
   *    `keyOf()` 那层也兜了一道，但源头也别留着坑。
   */
  return rows.map(r => ({
    id: Number(r.id),
    user_id: Number(r.user_id),
    exchange: String(r.exchange ?? ''),
    name: String(r.name ?? ''),
    api_key: String(r.api_key ?? ''),
    secret: String(r.secret ?? ''),
    password: String(r.password ?? ''),
    market_type: String(r.market_type ?? ''),
    sandbox: r.sandbox === true,
    /* ⚠️ `timestamptz` 出来就是 `Date`；真缺了当 0（epoch），别让 `toISOString()` 抛 */
    created_at: r.created_at instanceof Date ? r.created_at : new Date(0)
  }))
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

/**
 * 用户数据流的 WS 地址（沙盒是另一台主机）。
 *
 * ★★ 2026-10-06 实测（真账户 + 真事件）：**必须带 `/private`**。
 *
 * ⚠️ `/ws/<listenKey>` 是个**陷阱**：它会正常返回 101、还会回 ping，
 *    但**一个业务帧都不推** —— 看起来跟「账户没动静」完全一样。
 *    这个坑我们查了一整轮：两个出口 IP、两台机器、两个账户、五条路径、
 *    伪造 listenKey 对照（伪造 key 与真 key 表现一模一样，所以「连上+有 ping」不能作为证据）、
 *    关 permessage-deflate / 换浏览器 UA …… 全都没用，真相就是**少了 `/private`**。
 *
 * 对照实测（同一个 key、同一秒、同一个连接参数）：
 *   `/ws/<lk>`           → 0 帧 / 0.3 KB（只有握手）
 *   `/private/ws/<lk>`   → 收到 `ACCOUNT_UPDATE`（划转的 WITHDRAW / DEPOSIT 两条都到了）
 *   `/pm/ws/`、`/pm-classic/ws/`、`/stream?streams=` → 都是 0 帧
 *
 * ⚠️ 公共行情（`/market/ws`）用的是**另一个** path，别混：那个没有 `/private`。
 * ⚠️ 沙盒（testnet）这台主机没验证过，保持原来的写法。
 */
function streamUrl(listenKey: string, sandbox: boolean): string {
  const host = sandbox ? 'wss://stream.binancefuture.com' : 'wss://fstream.binance.com'
  return sandbox ? `${host}/ws/${listenKey}` : `${host}/private/ws/${listenKey}`
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
   * **挂单变了**（挂上 / 撤了 / 成交了 / 过期了）。
   *
   * ★ 2026-10-06 加，用户原话：「挂单不是秒级查询啊，有变动才改，其余存库不就行了」——
   *   现在挂单**存库**（`exchange_open_orders`），WS 的 `ORDER_TRADE_UPDATE`
   *   负责秒级改，REST 只做兜底对账；前端拿的是本地读（毫秒级）。
   *   前端收到这条就重读一次（本地，几乎零成本）。
   */
  | {type: 'orders'; reason: string}
  | {type: 'health'; deaf: boolean}

/** key_id → 订阅者 */
const listenerSets = new Map<number, Set<(ev: ExchangeEvent) => void>>()

/**
 * 把 key_id 归一成**数字**。⚠️⚠️ 这两个函数（`emit` / `subscribeExchange`）**必须**
 * 用同一把钥匙，所以统一走这里。
 *
 * ★ 2026-10-06 查出来的大 bug：`user_exchange_keys.id` 是 **BIGSERIAL（bigint）**，
 *   `pg` 为了不丢精度把 bigint 返回成**字符串**（`'7'`），而
 *   `db/exchange-keys.ts` 那边又 `Number()` 回了数字 `7`。
 *   于是 `subscribeExchange(7)` 往 map 里写**数字键**，
 *   而 `emit(this.row.id)` 传进来的是**字符串**，拿它去查 —— 永远查不到，`if (!set?.size) return` 就把事件**静默丢掉**。
 *
 *   症状特别有迷惑性：SSE 连上时的 `open` / `snapshot`（直接写响应、不走 map）
 *   一切正常，**连接时的底稿也正常**，而之后所有实时事件（`positions` / `marks` /
 *   `fill` / `income` / `backfill`）**一条都收不到** —— 因为 emit 全程空转。
 *   用户的「持仓盈利不实时」「最近成交不实时」都是它。
 *   而且 `[...map.keys()].join(',')` 里 `7` 和 `'7'` 打印出来一模一样，
 *   日志看着像「key 在、订阅者却是 0」，极难看出来 —— 所以**别再猜类型，一律 Number()**。
 */
function keyOf(keyId: number | string): number {
  return Number(keyId)
}

/**
 * 这套 key 现在有几个 SSE 订阅者。
 *
 * 「有没有人看」是「用户在不在这」的**唯一**可靠信号（前端只要有人开着这个账户的
 * 页面就一直挂着 SSE，见 `ExchangeAccountLivePanel.startStreams()`）——
 * 沉睡那一档（见 `ASLEEP_MS`）就靠它：有人在看就绝不省他那一份。
 */
function listenerCount(keyId: number | string): number {
  return listenerSets.get(keyOf(keyId))?.size ?? 0
}

/** 毫秒 → 「10 分钟 / 45 秒」这种给人看的写法（日志 / 断流原因用） */
function humanMs(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 60_000)} 分钟`
    : `${Math.round(ms / 1000)} 秒`
}

function emit(keyId: number | string, ev: ExchangeEvent): void {
  const set = listenerSets.get(keyOf(keyId))
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
  keyId: number | string,
  fn: (ev: ExchangeEvent) => void
): () => void {
  /* ⚠️ 归一成数字，跟 `emit` 用同一把钥匙（见 `keyOf` 那段） */
  const id = keyOf(keyId)
  let set = listenerSets.get(id)
  if (!set) {
    set = new Set()
    listenerSets.set(id, set)
  }
  const bucket = set
  bucket.add(fn)
  /*
   * ★ 「有人来了」—— 睡着过的账户立刻醒：把沉睡期间可能漏掉的账补一次
   *   （见 `KeyStream.wake`）。放在**加完订阅**之后：唤醒里会 `emit` 快照，
   *   这一条订阅得先在里面，不然刚连上这一下看不到新数。
   */
  streams.get(id)?.wakeOnView('有人打开页面')
  return () => {
    bucket.delete(fn)
    if (!bucket.size) listenerSets.delete(id)
  }
}

/**
 * **三档**：这一套账户现在按哪个节奏对账。
 *
 * | 档 | 判据 | 说明 |
 * |---|---|---|
 * | `normal` | 有仓 / 有单 / 10 分钟内有动静 | 按上面那张**基准节奏**走（成交 5 分钟…） |
 * | `idle` | 无仓无单 + 10 分钟没动静 | 再降一档 |
 * | `asleep` | 空转 + 2 小时没动静 | 基本不管合约和订单，只留余额采样 |
 *
 * ⚠️ **没有「在线档」**（2026-10-06 用户明确否掉的）：「用户在线就没必要频繁对账，
 *    感觉不对可以刷新页面」—— 在线的实时性由 **WS 推送 + 本地标记价重算** 保证，
 *    REST 只是兜底，所以在线**也不提速**。
 *
 * ⚠️ 档位只影响「我们自己主动去问」的频率；用户一刷新（`wake(..., force)`）
 *    或者一打开页面（数据旧了，见 `FRESH_MS`）当场就对平。
 */
type Tier = 'normal' | 'idle' | 'asleep'

/**
 * 三档的对账间隔（毫秒）—— **一张表看全**，别散成一堆三元表达式。
 * `sample: 0` = 快照不拦（就是外层那个 5 分钟定时器的节奏）。
 */
const TIER_GAPS: Record<
  Tier,
  {fill: number; orders: number; income: number; sample: number}
> = {
  normal: {
    fill: FILL_RECONCILE_MS,
    orders: ORDERS_RECONCILE_MS,
    income: INCOME_RECONCILE_MS,
    sample: 0
  },
  idle: {
    fill: FILL_RECONCILE_MS_IDLE,
    orders: ORDERS_RECONCILE_MS_IDLE,
    income: INCOME_RECONCILE_MS_IDLE,
    sample: SAMPLE_IDLE_MS
  },
  asleep: {
    fill: 4 * 60 * 60 * 1000,
    orders: 4 * 60 * 60 * 1000,
    income: 4 * 60 * 60 * 1000,
    /* ⚠️ 余额**不跟着睡觉**：曲线要连续（用户明确要求），而且 C2C 只有 REST 有 */
    sample: ASLEEP_MS
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
   * 上游最后推**数据帧**的时间（0 = 还没推过）。
   * ⚠️ 别拿它判死活：币安**只在有事件时推数据**，账户空闲就是长时间零帧。
   */
  private lastFrameAt = 0
  /**
   * 上游最后**任何动静**的时间 —— 数据帧**或**协议级 ping 都算。
   *
   * ⚠️ 判死活只能用它：币安每 3 分钟一个 ping 帧（控制帧，不进 `message` 回调）。
   *    只看数据帧会把「空闲」误判成「哑了」（2026-10-06 我就这么误判过一次）。
   */
  private lastAliveAt = 0
  /** 收到过几个 ping（排查用：0 = 连上了但连心跳都没收到） */
  private pings = 0
  /** 收到过几帧解析不了的（排查用，见 `onMessage`） */
  private badFrames = 0
  /** 收到过几个**事件帧**（`ORDER_TRADE_UPDATE` / `ACCOUNT_UPDATE` …）—— 排查「事件到没到」 */
  private dataFrames = 0
  /** 见过哪些事件类型（没见过的那种记一行，别刷屏） */
  private readonly seenEventTypes = new Set<string>()
  /** 见过的条件单状态（第一次见记一笔，供以后扩充） */
  private readonly algoStatuses = new Set<string>()
  /** 健康检查跑了几轮（只用来决定统计那一行多久打一次） */
  private healthTick = 0
  /** 这条 WS 是什么时候连上的（统计里报「连上几分钟」） */
  private connAt = 0
  /** 有没有一轮补账正在跑（挡住同一时刻的重复补账，见 `wake`） */
  private wakeBusy = false
  /** 补账期间又来了必须看到最新状态的那种（写操作）⇒ 跑完再来一轮 */
  private wakeAgain = false
  /** 当前是否处于「哑了」状态（用来只在翻转时发一次通知） */
  private deaf = false
  /**
   * 上游 WS 是不是被我们**主动断开**了（见 `WS_SLEEP_AFTER_MS`）。
   * ⚠️ 跟「断了在等重连」不是一回事：这个状态下**不要**判 deaf、**不要**自动重连，
   *    只在「有人来 / 账户又有敞口」时才连回去（`wakeWs`）。
   */
  private wsSleeping = false
  /** 最近一次「没人订阅」的开始时刻（0 = 现在有人看）—— 断流条件的计时起点 */
  private offlineSince = 0
  /** 最近一次因为 `deaf` 强制重连的时刻（防重连风暴） */
  private lastDeafRestartAt = 0
  /** 定期对账的三个水位 */
  private lastFillReconcileAt = 0
  private lastIncomeReconcileAt = 0
  private lastOrdersReconcileAt = 0
  /** 库里现在挂着几条单（判断空转用，见 `isIdle`） */
  private openOrderCount = 0
  /**
   * 最后一次**账户里真有动静**的时间 —— 空转 / 沉睡两档的判据就是它。
   *
   * ⚠️⚠️ **只许记「真的发生了什么」**（WS 数据帧 / 成交 / 挂单变动 / 用户下单订阅），
   *    **绝不能记「我们自己发起的那一发轮询」**（快照、挂单对账）。
   *    2026-10-06 抓到的实证：`snapshot()` 每轮都把它顶到「现在」，而采样定时器
   *    5 分钟就采一次 ⇒ `Date.now() - lastActivityAt` 永远 < `IDLE_MS`（10 分钟）
   *    ⇒ **空转那一档从来没生效过**（`f94cd99` 那个 commit 是空转的），
   *    新加的沉睡档更是永远进不去。自己问自己「有没有动静」，答案永远是有。
   */
  private lastActivityAt = Date.now()
  /** 当前是不是空转（只在翻转时打日志） */
  private idle = false
  /** 当前档位（见 `Tier`；只在换档时打日志） */
  private tier: Tier = 'normal'
  /** 上一次**用户手动**刷新（含下拉）的时间（节流用，见 `FORCED_MIN_MS`） */
  private lastForcedAt = 0
  /** 上一次因为 `ACCOUNT_UPDATE` 去问 REST 快照的时间（**真的拦请求**，见那个常量） */
  private lastWsSnapshotAt = 0
  /** activity 时钟有没有从库里种过一次（见 `seedActivity`） */
  private seededActivity = false
  /** 上一次全量采样的时间（空转时按 30 分钟拦） */
  private lastSampleAt = 0
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
      /* 要连回去了 ⇒ 不再是「睡着的流」（见 `WS_SLEEP_AFTER_MS`） */
      this.wsSleeping = false
      /*
       * 「没人看」的计时从起流这一刻算 —— 否则要等第一轮健康检查（30 秒后）
       * 才会记下这个起点，断流条件白等一个周期。
       */
      if (!listenerCount(this.row.id)) this.offlineSince = Date.now()
      void this.open()
      if (!this.keepTimer) {
        this.keepTimer = setInterval(() => void this.keepAlive(), KEEPALIVE_MS)
      }
      /*
       * ★ 定期对账 + 健康检查（2026-10-06 加）。
       * ⚠️ 必须**无条件**起，不能等 `open`：`open` 只证明连上了，
       *    证明不了**事件一定都会到**。丢事件有好几种真实原因
       *    （重连空档、listenKey 失效、进程重启、上游偶发丢帧），
       *    而原来只在连上时对账一次 ⇒ 丢一笔就永远补不回来。
       */
      if (!this.reconTimer) {
        /*
         * ⚠️ 两个水位都置 **0**（不是 `Date.now()`）：这样第一轮 tick（60 秒后）
         *    就会把成交和钱账本都各对一次 —— 等 10 分钟才第一次拉 income
         *    意味着页面刚打开那几分钟「盈亏」是空的。
         */
        this.lastFillReconcileAt = 0
        this.lastIncomeReconcileAt = 0
        this.lastOrdersReconcileAt = 0
        this.reconTimer = setInterval(
          () => void this.reconcileTick(),
          FILL_RECONCILE_MS
        )
        /*
         * ⚠️ 只在**第一次**起流时把 activity 时钟种一下（重启不该把睡着的账户叫醒，
         *    见 `seedActivity`）—— 放在定时器之后，播种是异步的，别挡着起流。
         */
        void this.seedActivity()
      }
      if (!this.healthTimer) {
        // ⚠️ 从起流算起 —— 否则刚起流就被判定成「哑了」
        this.lastFrameAt = Date.now()
        this.lastAliveAt = Date.now()
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
      this.connAt = Date.now()
      this.healthTick = 0
      console.log(`${this.tag} WS 已连（用户数据流${isReconnect ? '·重连' : ''}）`)
      /*
       * ⚠️ 连上（尤其是**重连**）之后必须 REST 对账 ——
       * 断线那段时间的事件是丢的，账目会漂：快照要重拉、成交要补。
       */
      void this.reconcile(isReconnect ? 'ws' : 'boot')
    })
    ws.on('message', (d: Buffer) => {
      /*
       * ⚠️ 必须 `.catch`（2026-10-06 加）：`onMessage` 是 async，里面任何一处抛
       *    （库里报错、解析出 NaN、字段缺失导致的 TypeError）原来都会变成
       *    **一次「没处理的 Promise 拒绝」** —— 事件静默消失，日志一个字没有，
       *    排查时跟「事件根本没到」**完全分不出来**。这个坑跟
       *    `badFrames` 那个 parse catch 是同一类，见 `onMessage`。
       */
      void this.onMessage(String(d)).catch((e: Error) =>
        console.warn(
          `${this.tag} WS 事件处理未捕获（事件丢了，等兜底）：${e.message.slice(0, 140)}`
        )
      )
    })
    /*
     * ★ 协议级 ping（2026-10-06 加）—— 这是**判断流死活**的唯一可靠信号。
     *
     * ⚠️ 我一开始把「没有数据帧」当成「流哑了」，那是**错的**：
     *    币安的用户数据流**只在有事件时推数据**，账户半天不动就是一个数据帧都没有。
     *    它真正的心跳是**协议级 ping**（币安每 3 分钟一个 ping 帧，10 分钟收不到 pong 才断），
     *    而 ping 是**控制帧**，`ws` 不会把它交给 `message` 回调 ——
     *    所以只数 `message` 会把「空闲但健康」误判成「哑了」。
     */
    ws.on('ping', () => {
      this.lastAliveAt = Date.now()
      this.pings++
      /* 头几个 ping 打出来，好确认这条连接到底有没有在收心跳 */
      if (this.pings <= 3) {
        console.log(`${this.tag} WS 收到第 ${this.pings} 个 ping（连接是活的）`)
      }
    })
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
    /*
     * 挂单也要对一次：断线那段 / 进程没起来那段的挂单变动是收不到的
     * （WS 事件只在连着的时候有）。⚠️ 放在最后 —— 它 40 权重，别挡着快照和成交。
     */
    this.lastOrdersReconcileAt = Date.now()
    await this.reconcileOrders(source)
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
        /* 补回来的成交同样可能改变持仓集合（离线期间开的仓就在这里被发现） */
        this.resyncAfterFill()
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
    /* 真记进来一笔新成交 = 账户里有动静（帐还没算完的账户别急着降频） */
    if (isNew) this.noteActivity()
    return isNew
  }

  private async onMessage(raw: string): Promise<void> {
    /* 数据帧：两条时间都推（`lastAliveAt` 才是判死活的） */
    this.lastFrameAt = Date.now()
    this.lastAliveAt = Date.now()
    this.noteActivity()
    let ev: any
    try {
      ev = JSON.parse(raw)
    } catch {
      /*
       * ★ 解析失败**不能静默**（2026-10-06 加）：经出口隧道时帧有可能被截断 / 拼坏，
       *   而「解析失败 → 直接 return」看起来跟「事件没来」**一模一样**，
       *   排查时能白找一整天。把前 120 个字符打出来（限流，别刷屏）。
       */
      this.badFrames++
      if (this.badFrames <= 5) {
        console.warn(
          `${this.tag} 上游推了一帧解析不了的（第 ${this.badFrames} 次，长度 ${raw.length}）：` +
            raw.slice(0, 120)
        )
      }
      return
    }
    const e = String(ev?.e ?? '')
    /*
     * ★ 事件帧统一在这儿计数 + 打头几行（2026-10-06 加）。
     *
     * 为什么值得：用户问过一次「减仓后没有推送事件吗」—— 那会儿**日志答不了**这个问题
     *   （只有订单事件自带一行，`ACCOUNT_UPDATE` 一条都不记）。现在「这条流到底进不进事件」
     *   看日志就能回答：`收到事件帧 e=…` 就是进了。
     */
    this.dataFrames++
    if (this.dataFrames <= 5) {
      console.log(`${this.tag} 收到事件帧 e=${e || '(空)'}`)
    }
    try {
      if (e === 'ORDER_TRADE_UPDATE') {
        await this.onOrder(ev?.o ?? {})
        return
      }
      if (e === 'ALGO_UPDATE') {
        await this.onAlgoUpdate(ev?.o ?? {})
        return
      }
      /*
       * `TRADE_LITE`：2026-10-06 实测同一次成交会**先**推它、紧接着推
       * `ORDER_TRADE_UPDATE`（字段少：`s/S/l/L/t/i`，没有手续费和已实现盈亏）。
       * 成交的完整信息走后者 ⇒ 这里**不处理**，但要让它别再落进「没见过的类型」那条日志。
       */
      if (e === 'TRADE_LITE') return
      if (e === 'ACCOUNT_UPDATE') {
        /*
         * ★ 2026-10-06（用户贴了币安文档问「有用到这个吗」）：**用上事件里带的数据**。
         *
         * 原来这里只把事件当触发信号，收到就去 REST 拉一次完整快照 ——
         * 事件里的 `a.B[].wb`（钱包余额）和 `a.P[]` 的 `pa/ep/up`（持仓量 / 开仓价 /
         * 未实现盈亏）**一个字都没用**。代价：成交/划转/资金费之后，界面要等
         * 一个 REST 来回（≈0.5~1 秒、21 权重）才动。
         */
        const {applied, newSymbols} = this.applyAccountUpdate(ev?.a ?? {})
        if (applied) {
          /* 持仓集合可能变了（新开 / 平掉）→ 标记价订阅跟着调，然后立刻推给前端 */
          this.syncMarks()
          this.pushLive(false)
        }
        /*
         * 事件里**没有**的是汇总口径：可用余额 / 保证金余额 / 资产明细 / C2C / 现货。
         * 那些仍然要靠 REST，但**真的要节流**（见 `WS_SNAPSHOT_GAP_SEC` 的注释）；
         * 例外：出现了**没见过的**仓位 ⇒ 立刻要一次，否则那一行会缺杠杆/强平价。
         */
        const due = Date.now() - this.lastWsSnapshotAt > WS_SNAPSHOT_GAP_SEC * 1000
        if (newSymbols.length || due) {
          this.lastWsSnapshotAt = Date.now()
          /* 本地已经更新过了 ⇒ 顺手把采样时钟也推一下，别让 5 分钟采样立刻再来一发 */
          this.lastSampleAt = Date.now()
          await this.snapshot('ws', WS_SNAPSHOT_GAP_SEC)
        }
        return
      }
      if (e === 'listenKeyExpired') {
        console.warn(`${this.tag} listenKey 过期，重建`)
        this.restart(true)
        return
      }
      /*
       * 没见过的事件类型（`MARGIN_CALL` / `ACCOUNT_CONFIG_UPDATE` /
       * `STRATEGY_UPDATE` / `CONDITIONAL_ORDER_TRIGGER_REJECT` …）**记一行**。
       * 币安增删事件类型我们是不知道的，静默忽略等于「有新信号却永远看不到」。
       */
      if (e && !this.seenEventTypes.has(e)) {
        this.seenEventTypes.add(e)
        console.log(`${this.tag} 收到没处理的事件类型 ${e}（先记一笔）`)
      }
    } catch (err) {
      /*
       * ★ 处理抛错**必须留痕**（2026-10-06 加）：否则一次 TypeError 就等于
       *   「这笔成交凭空消失」，下次再遇到又只能猜。
       */
      console.warn(
        `${this.tag} 处理事件 ${e || '(空)'} 失败（这笔先丢，等兜底对账）：` +
          `${(err as Error).message.slice(0, 140)}`
      )
    }
  }

  /**
   * `ACCOUNT_UPDATE` 里带的数据**当场就用**（2026-10-06）。
   *
   * 币安这个事件里有：
   *
   * ```json
   * {"a": {"B": [{"a": "USDT", "wb": "122624.12", "cw": "...", "bc": "50.12"}],
   *        "P": [{"s": "BTCUSDT", "pa": "1", "ep": "9000", "up": "0.12"}]}}
   * ```
   *
   * · `B[].wb` = **钱包余额**（USDT 本位合约就等于 `totalWalletBalance`）
   * · `P[].pa` = 持仓量（**有符号**，负 = 空）、`ep` = 开仓价、`up` = 未实现盈亏
   *
   * ⚠️ 两个坑：
   *   ① `P` 里**只有「这次变了」的仓位**，不是全量 ⇒ 必须**合并**，不能整份替换；
   *   ② 它**没有**杠杆 / 强平价 / 可用余额 / 资产明细 / C2C / 现货 ⇒
   *      那些还是得靠 REST 快照（分档 5/30/60 分钟那条路），这里只把
   *      「余额 + 持仓量 / 开仓价 / 未实现」这几项**立刻改对**。
   *
   * 返回 `applied` = 本地改到了没有；`newSymbols` = 出现的新交易对（那行缺杠杆 / 强平价，
   * 调用方会因此立刻去要一次 REST）。
   */
  private applyAccountUpdate(a: any): {applied: boolean; newSymbols: string[]} {
    const ov = this.lastOverview
    /* 还没有底稿（刚起流）⇒ 让 REST 那条路去拿，别瞎拼一份缺字段的 */
    if (!ov) return {applied: false, newSymbols: []}
    const bal: any[] = Array.isArray(a?.B) ? a.B : []
    const changed: any[] = Array.isArray(a?.P) ? a.P : []
    const usdt = bal.find(x => String(x?.a ?? '').toUpperCase() === 'USDT')
    const walletRaw = usdt ? Number(usdt.wb) : NaN
    const wallet = Number.isFinite(walletRaw) ? walletRaw : ov.futures.wallet
    if (!changed.length && !Number.isFinite(walletRaw)) {
      return {applied: false, newSymbols: []}
    }

    const next = [...ov.futures.positions]
    const newSymbols: string[] = []
    for (const p of changed) {
      const raw = String(p?.s ?? '').toUpperCase()
      if (!raw) continue
      /* 事件里是**币安原始符号**（BTCUSDT），快照里是 ccxt 统一符号（BTC/USDT:USDT） */
      const unified = String(this.ex?.market?.(raw)?.symbol ?? raw)
      const idx = next.findIndex(x => x.symbol === unified)
      const signed = Number(p?.pa ?? 0)
      const amount = Math.abs(signed)
      /* 平掉了（pa = 0）⇒ 从列表里摘掉，跟 REST 那份「过滤零仓」一个口径 */
      if (!(amount > 0)) {
        if (idx >= 0) next.splice(idx, 1)
        continue
      }
      const row = idx >= 0 ? next[idx]! : null
      if (!row) newSymbols.push(raw)
      const entryPrice = Number(p?.ep ?? row?.entryPrice ?? 0)
      const mark = this.marks.get(raw) ?? row?.markPrice ?? entryPrice
      const notional = amount * mark
      const merged = {
        ...(row ?? {
          symbol: unified,
          liquidationPrice: null as number | null,
          leverage: 0,
          percentage: null as number | null,
          /* ⚠️ 事件里没有维持保证金（那是分档费率算出来的）⇒ 新仓位先 0，
             调用方会因为 `newSymbols` 立刻去要一次 REST 快照补上 */
          maintMargin: 0,
          mmr: 0
        }),
        side: signed < 0 ? 'short' : 'long',
        amount,
        entryPrice,
        markPrice: mark,
        notional,
        unrealizedPnl: Number(p?.up ?? row?.unrealizedPnl ?? 0)
      }
      if (idx >= 0) next[idx] = merged
      else next.push(merged)
    }

    const unrealized = next.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0)
    this.lastOverview = {
      ...ov,
      futures: {
        ...ov.futures,
        wallet: r8(wallet),
        unrealized: r8(unrealized),
        /* 保证金余额 = 钱包 + 浮盈（跟 REST 的 totalMarginBalance 同一算法） */
        margin: r8(wallet + unrealized),
        positions: next
      }
    }
    return {applied: true, newSymbols}
  }

  /**
   * 一笔订单事件 → 成交写账本。
   *
   * ⚠️ `NEW` / `CANCELED` / `EXPIRED` 只是**挂单状态变化**，不是成交 ——
   * 方案里定的「只存成交」，所以只处理 `x=TRADE` / `X=FILLED` 且带 tradeId 的。
   */
  /* ---------------- 挂单（存库 + WS 实时维护 + REST 兜底对账） ---------------- */

  /**
   * 一条 `ORDER_TRADE_UPDATE` → 更新库里的挂单。
   *
   * ⚠️ 只有**真的改了**才推 SSE（`deleteOpenOrder` 会告诉我们原本在不在），
   *    不然「部分成交」那种高频事件会把前端刷爆。
   */
  private async syncOrderFromEvent(o: any): Promise<void> {
    this.noteActivity()
    const orderId = String(o?.i ?? '')
    const status = String(o?.X ?? '').toUpperCase()
    if (!orderId || !status) return
    try {
      if (status === 'NEW' || status === 'PARTIALLY_FILLED') {
        await upsertOpenOrder(this.row.user_id, this.row.id, {
          orderId,
          /* ⚠️ 用 `s`（币安原始符号），跟账本 / 接口一个口径 */
          symbol: String(o?.s ?? '').toUpperCase(),
          side: String(o?.S ?? '').toLowerCase(),
          type: String(o?.o ?? '').toUpperCase(),
          posSide: String(o?.ps ?? 'BOTH').toUpperCase(),
          price: numOrNull(o?.p),
          stopPrice: numOrNull(o?.sp),
          amount: Number(o?.q ?? 0),
          filled: Number(o?.z ?? 0),
          reduceOnly: o?.R === true,
          time: Number(o?.T ?? 0) || Date.now(),
          raw: o
        })
        this.openOrderCount++
        emit(this.row.id, {type: 'orders', reason: `ws:${status}`})
      } else {
        const removed = await deleteOpenOrder(this.row.id, orderId)
        if (removed) {
          this.openOrderCount = Math.max(0, this.openOrderCount - 1)
          emit(this.row.id, {type: 'orders', reason: `ws:${status}`})
        }
      }
    } catch (e) {
      console.warn(`${this.tag} 更新挂单失败：${(e as Error).message.slice(0, 140)}`)
    }
  }

  /**
   * REST **对账**挂单（兜底）：拿交易所那一份替换本地。
   *
   * 什么时候跑：连上 / 重连（`reconcile()`）、启动后第一轮、以及每 2 分钟一轮。
   * ⚠️ 带不带 symbol 差 40 倍权重（不带 = 40），所以**不能勤**；
   *    但正因为挂单现在有 WS 那条路，这里本来就只需要兜底。
   */
  /**
   * 全量采样（外层那个 5 分钟定时器调）——**曲线的源，也是钱包 / C2C 唯一的取数路**。
   *
   * 三档（`fetchExchangeOverview` ≈ 21 权重）：
   *   · 活跃 —— 5 分钟一次（外层定时器的节奏，这里不拦）；
   *   · 空转 —— `SAMPLE_IDLE_MS`（空账户的钱不会变）；
   *   · 睡着 —— `ASLEEP_MS`（**照采**，用户要求「余额要管要做曲线图」，断采曲线就断档）。
   */
  async sampleIfDue(): Promise<void> {
    const gap = TIER_GAPS[this.tierNow()].sample
    if (gap && Date.now() - this.lastSampleAt < gap) return
    this.lastSampleAt = Date.now()
    await this.snapshot('poll')
  }

  /**
   * 这套账户是不是**睡着**了：空转 + 没人订阅 + 连着 `HIBERNATE_MS` 没动静。
   *
   * ⚠️ 判据里的「没人订阅」就是用户说的**不在线** —— 前端只要有人开着这个账户的
   *    页面就一直挂着 SSE（`ExchangeAccountLivePanel.startStreams()`），
   *    所以有订阅 = 有人在看，那一份绝不能省。
   */
  isAsleep(): boolean {
    return this.tierNow() === 'asleep'
  }

  /**
   * 上游 WS 是不是**被我们主动断开**了（省连接，见 `WS_SLEEP_AFTER_MS`）。
   * ⚠️ 跟「断线在等重连」不是一回事：这个状态下不该判 `deaf`，也不该自动重连。
   */
  wsIsSleeping(): boolean {
    return this.wsSleeping
  }

  /**
   * 现在按哪一档（见 `Tier` / `TIER_GAPS`）。
   * ⚠️ **不看有没有人在线** —— 见 `Tier` 那段（用户 2026-10-06 明确否掉在线档）。
   */
  private tierNow(): Tier {
    /*
     * ★ 流降级（`deaf`：连 ping 都收不到）时必须用**正常档**兜底。
     *
     * ⚠️ 为什么：低频档的前提是「事件由 WS 实时维护，对账只是安全网」。
     *    流一哑，这个前提就没了 —— 而且哑的时候正好是「再没有事件来告诉我们账户有动静」，
     *    `lastActivityAt` 也不会更新 ⇒ 会一直停在空转/沉睡档，对账拉到 4 小时一轮，
     *    账本能滞后 4 小时。这条耦合别拆。
     */
    if (this.deaf) return 'normal'
    if (!this.isIdle()) return 'normal'
    return Date.now() - this.lastActivityAt > HIBERNATE_MS ? 'asleep' : 'idle'
  }

  /** 换档时打一行 —— 不然「到底有没有在省」完全看不见 */
  private noteTier(tier: Tier): void {
    if (tier === this.tier) return
    const from = this.tier
    this.tier = tier
    const text: Record<Tier, string> = {
      normal:
        '正常档 → 实时靠 WS 推送；对账只当安全网：成交/挂单/账本全 1 小时，余额 1 小时（曲线）',
      idle: '空转（无仓无单 10 分钟没动静）→ 对账全 2 小时，余额照 1 小时采',
      asleep: '睡着（空转 2 小时）→ 对账全 4 小时，余额照 1 小时采（曲线不断）'
    }
    console.log(`${this.tag} 档位 ${from} → ${tier}：${text[tier]}`)
  }

  /**
   * 有人回来了 —— **按需补账**（订阅 / 写操作 / 用户手动刷新都走这里）。
   *
   * ★ 2026-10-06 用户定的口径：「**只有没数据才请求**」「用户感觉不对可以刷新页面」。
   *   所以这里**不是**「一有人打开就打一遍交易所」，而是分两种：
   *
   *   · `force = true`（用户按了刷新 / 下拉刷新）—— 当场对平，只受 `FORCED_MIN_MS`
   *     （3 秒）拦住连点；
   *   · 否则 —— 只在**数据已经旧了**（`FRESH_MS` = 60 秒）时才补一轮。
   *     刚被 SSE 推过的账户一次请求都不发（切个 tab 回来不该打交易所）。
   *
   * 补什么：快照（余额 / 持仓）+ 成交 + 钱账本（+ 挂单，除非调用方马上自己要问一次）。
   */
  wake(
    reason: string,
    opts: {
      skipOrders?: boolean
      skipSnapshot?: boolean
      skipIncome?: boolean
      skipFills?: boolean
      force?: boolean
    } = {}
  ): void {
    const {
      skipOrders = false,
      force = false,
      skipSnapshot = false,
      skipIncome = false,
      skipFills = false
    } = opts
    this.lastActivityAt = Date.now()
    /* ★ 有人回来了（打开页面 / 手动刷新 / 写操作）⇒ 睡着的上游 WS 立刻连回去 */
    this.wakeWs(reason)
    const now = Date.now()
    if (force) {
      /* 连点几下别把这一套账户的权重全花在一秒里（前端另有防抖） */
      if (now - this.lastForcedAt < FORCED_MIN_MS) return
      this.lastForcedAt = now
    } else if (now - this.lastSampleAt < FRESH_MS) {
      /* 数据还新鲜 ⇒ 一次都不请求（用户：「只有没数据才请求」） */
      return
    }
    /*
     * ★ 同一套账户，**同一时刻只跑一轮补账**（2026-10-06 加）。
     *
     * ⚠️ 为什么必须拦：进程刚起来时 `lastSampleAt = 0`，而几个页面（甚至一个页面的
     *    几个订阅）会同时接上 SSE —— 每条订阅都调一次 `wake`、每个都判定「数据旧了」，
     *    于是 N 轮「快照 25 + 成交 5 + 账本 30 + 挂单 40」同时打出去。
     *    实测 2026-10-06 启动那一刻就是 **5 条** `补账（有人打开页面·数据旧了）`，
     *    紧接着这个 IP 就吃到一整段 `-1003`（2400/分钟）。
     *    而跑起来的那一轮干的活跟它们**一模一样**，多出来的全是白花。
     *
     * `force`（写操作 / 用户手动刷新）**不能就这么吞掉** ⇒ 记一笔，跑完再来一轮。
     */
    if (this.wakeBusy) {
      if (force) this.wakeAgain = true
      return
    }
    const wasAsleep = this.isAsleep()
    if (wasAsleep) this.tier = 'normal'
    console.log(
      wasAsleep
        ? `${this.tag} 醒（${reason}）：补一轮沉睡期间可能漏掉的账`
        : `${this.tag} 补账（${reason}${force ? '·无视节流' : '·数据旧了'}）`
    )
    this.runWake({skipOrders, skipSnapshot, skipIncome, skipFills, force})
  }

  /**
   * `wake` 的实际动作（拆出来是为了跑完能接着跑 `wakeAgain` 那一轮）。
   *
   * 补什么：快照（余额 / 持仓）+ 成交 + 钱账本（+ 挂单，除非调用方马上自己要问一次）。
   */
  private runWake(o: {
    skipOrders: boolean
    skipSnapshot: boolean
    skipIncome: boolean
    skipFills: boolean
    force: boolean
  }): void {
    this.wakeBusy = true
    void (async () => {
      /*
       * `skipSnapshot`：手动刷新那条路**自己刚拉过一份**全量快照（`/api/exchange/refresh`），
       * 别再问一遍那 21 权重 —— 只把「账本那几样」（成交 / 挂单 / 钱账本）对平。
       */
      if (!o.skipSnapshot) {
        /*
         * `minGapSec` 只管**要不要把这一份写进库**（`saveSnapshot`），请求和推送给前端
         * 那两步不受它约束。`force`（写操作）要的就是「这一笔之后」的一行 ⇒ 不节流，
         * 曲线在平仓那一刻有个点；非 `force`（SSE 反复重连那种）20 秒内别刷同样的行。
         */
        await this.snapshot('poll', o.force ? 0 : WS_SNAPSHOT_GAP_SEC)
      }
      this.lastSampleAt = Date.now()
      /* `skipFills`：页面打开那条轻量路 —— 成交由 WS 实时进账本，不用再扫交易所 */
      if (!o.skipFills) {
        this.lastFillReconcileAt = Date.now()
        await this.backfillFills()
      }
      /*
       * 写操作这条路（`skipIncome`）**不再单独跑 30 权重那一发**：成交对账
       * （`backfillFills` → `saveTrade`）已经把这一笔的已实现盈亏 / 手续费写进钱账本了
       * （同一个 `tranId`）。`income` 那个接口只补 `FUNDING_FEE` / `TRANSFER`
       * 这类**成交里没有**的，交给定时那一轮。
       */
      if (!o.skipIncome) {
        this.lastIncomeReconcileAt = Date.now()
        await this.reconcileIncome()
      }
      if (o.skipOrders) return
      this.lastOrdersReconcileAt = Date.now()
      await this.reconcileOrders('wake')
    })()
      .catch((e: Error) =>
        console.warn(`${this.tag} 补账失败：${e.message.slice(0, 140)}`)
      )
      .finally(() => {
        this.wakeBusy = false
        if (!this.wakeAgain) return
        this.wakeAgain = false
        /* 补账期间又来了写操作 ⇒ 再对一轮轻的（快照 + 成交），别再等 60 秒 */
        this.runWake({
          skipOrders: true,
          skipSnapshot: false,
          skipIncome: true,
          skipFills: false,
          force: true
        })
      })
  }

  /**
   * 从库里种一次 activity 时钟（只种一次，见 `seededActivity`）。
   *
   * ⚠️ 为什么需要：`lastActivityAt` 是**内存里的**，进程一重启就变成「现在」——
   *    一个几个月没人用的账户会重新被当成活跃账户，等满 `HIBERNATE_MS` 才肯睡。
   *    取两样里**更晚**的那个当「上次动静」：
   *      · 账本里最后一笔成交（交易过才有）；
   *      · 这套 Key 的**创建时间**（从没交易过的账户，就是「建完就没动过」）。
   *    读不到就当「刚有动静」，不省这一档。
   */
  private async seedActivity(): Promise<void> {
    if (this.seededActivity) return
    this.seededActivity = true
    try {
      const row = await queryOne<{t: string | null}>(
        `SELECT max(ts) AS t FROM exchange_fills WHERE key_id = $1`,
        [this.row.id]
      )
      const lastFill = row?.t ? new Date(row.t).getTime() : 0
      const created = this.row.created_at.getTime()
      const t = Math.max(lastFill, created)
      if (t > 0 && t < this.lastActivityAt) this.lastActivityAt = t
    } catch {
      /* 读不到就当「刚有动静」，不影响正确性 */
    }
  }

  /**
   * 有人打开页面 ⇒ 按需补一次（**轻量版**）。
   *
   * ★ 2026-10-06（WS 路径修好之后）：余额 / 持仓 / 成交 / 挂单现在都由事件**实时**维护
   *   （余额和持仓甚至 0 权重就地更新，见 `applyAccountUpdate`）⇒ 打开页面时
   *   **只有「汇总口径 + 资产曲线」需要 REST**。
   *   原来这里跑的是全量（快照 25 + 成交 ≤40 + 账本 30 + 挂单 40 ≈ 100+ 权重），
   *   一台机器上开几个页面就能叠出好几轮（启动那一刻实测 5 轮，直接把 IP 打进 `-1003`）。
   *
   * ⚠️ **流降级（`deaf`）时退回全量** —— 那时候事件可能真丢了，页面打开正是补账的机会。
   */
  wakeOnView(reason: string): void {
    if (this.deaf) {
      this.wake(`${reason}·流降级`)
      return
    }
    this.wake(reason, {skipOrders: true, skipIncome: true, skipFills: true})
  }

  /** 给写操作用（`reconcileKeyOrders`）—— 同一个动作，只是对外的口子 */
  async reconcileOrdersForced(): Promise<void> {
    await this.reconcileOrders('write')
  }

  private async reconcileOrders(reason: string): Promise<void> {
    try {
      await chargeWeight(40, 'openOrders')
      const rows = await listOpenOrders(credsOf(this.row))
      const list: OpenOrderInput[] = rows.map(r => ({
        orderId: r.id,
        symbol: r.symbol,
        side: r.side,
        type: r.type,
        posSide: r.posSide,
        price: r.price,
        stopPrice: r.stopPrice,
        amount: r.amount,
        filled: r.filled,
        reduceOnly: r.reduceOnly,
        time: r.time || Date.now(),
        raw: r
      }))
      const {added, removed} = await replaceOpenOrders(
        this.row.user_id,
        this.row.id,
        list
      )
      this.openOrderCount = list.length
      /* 真的多了 / 少了单子才算「账户里有动静」；对了一遍发现没变化不算 */
      if (added || removed) this.noteActivity()
      if (added || removed) {
        console.log(
          `${this.tag} 挂单对账（${reason}）：+${added} -${removed}，现存 ${list.length} 条`
        )
        emit(this.row.id, {type: 'orders', reason: `rest:${reason}`})
      }
    } catch (e) {
      /* 对账失败不清库（`replaceOpenOrders` 也不会在中途清），下一轮再说 */
      console.warn(
        `${this.tag} 挂单对账失败（${reason}）：${(e as Error).message.slice(0, 140)}`
      )
    }
  }

  /**
   * 有成交落地 ⇒ 持仓集合可能变了 ⇒ 顺手对齐一次。
   *
   * ★ 2026-10-06 加（用户问「用户不在线怎么办后续数据怎么更新」）：
   *   ⚠️ 原来 `syncMarks()` **只在 `snapshot()` 里调**，而快照是 **5 分钟**一次。
   *   所以「开了一个新仓」之后，那 5 分钟里**没有给这个币订标记价** ——
   *   未实现盈亏就一直停在开仓那一刻的数（有人看还是没人看都一样）。
   *   `ACCOUNT_UPDATE` 本来盖得住（币安开仓会推它），但它也会丢（跟成交事件
   *   同一类问题），丢了就没人补 → 所以这里用「有成交」当触发器。
   *
   * ⚠️ 走 `snapshot('ws')` 自带 **20 秒节流**（`WS_SNAPSHOT_GAP_SEC`）：
   *   一笔一笔成交连着来也只打一发，权重 25，不会失控。
   */
  private resyncAfterFill(): void {
    if (this.stopped) return
    void this.snapshot('ws', WS_SNAPSHOT_GAP_SEC)
  }

  /**
   * `ALGO_UPDATE` —— **条件单（止盈 / 止损）**的生命周期。
   *
   * ★ 2026-10-06 加：WS 路径修好（`/private/ws/`）之后**第一天就抓到**的第二个坑 ——
   *   币安把条件单搬到了 Algo Order 那套接口，它的事件类型是 **`ALGO_UPDATE`**，
   *   字段在 `o` 里、用 **`aid`**（不是普通单的 `i`）：
   *
   *   ```json
   *   {"e":"ALGO_UPDATE","o":{"aid":3000002234581230,"o":"TAKE_PROFIT_MARKET","s":"RLCUSDT",
   *     "S":"SELL","q":"17","tp":"1.5","X":"CANCELED","R":true,"wt":"MARK_PRICE","ps":"BOTH"}}
   *   ```
   *
   *   ⚠️ 原来只认 `ORDER_TRADE_UPDATE` ⇒ **撤掉的条件单一直留在界面的挂单列表里**
   *   （只能等 2 分钟一轮的 REST 挂单对账清掉，而 `openAlgoOrders` 那一路是 40 权重）。
   *
   * ⚠️ 条件单没有「成交」概念：`q` 是委托量、`filled` 记 0；真正触发之后是**另一张真单**
   *    进场，由 `ORDER_TRADE_UPDATE` 接管（那时这张条件单已经从场上消失）。
   */
  private async onAlgoUpdate(o: any): Promise<void> {
    const orderId = String(o?.aid ?? '')
    const status = String(o?.X ?? '').toUpperCase()
    if (!orderId || !status) return
    this.noteActivity()
    if (!this.algoStatuses.has(status)) {
      this.algoStatuses.add(status)
      console.log(`${this.tag} 条件单事件：${o?.s} ${o?.o} → ${status}`)
    }
    try {
      if (ALGO_GONE.has(status)) {
        if (await deleteOpenOrder(this.row.id, orderId)) {
          this.openOrderCount = Math.max(0, this.openOrderCount - 1)
          emit(this.row.id, {type: 'orders', reason: `algo:${status}`})
        }
        return
      }
      await upsertOpenOrder(this.row.user_id, this.row.id, {
        orderId,
        symbol: String(o?.s ?? '').toUpperCase(),
        side: String(o?.S ?? '').toLowerCase(),
        type: String(o?.o ?? '').toUpperCase(),
        posSide: String(o?.ps ?? 'BOTH').toUpperCase(),
        price: numOrNull(o?.p),
        /* ⚠️ 条件单的触发价在 `tp`（`sp` 是普通单那套的字段） */
        stopPrice: numOrNull(o?.tp),
        amount: Number(o?.q ?? 0),
        filled: 0,
        reduceOnly: o?.R === true,
        time: Number(o?.T ?? 0) || Date.now(),
        raw: o
      })
      this.openOrderCount++
      emit(this.row.id, {type: 'orders', reason: `algo:${status}`})
    } catch (e) {
      console.warn(
        `${this.tag} 更新条件单失败（先不动本地那张）：${(e as Error).message.slice(0, 140)}`
      )
    }
  }

  private async onOrder(o: any): Promise<void> {
    const tradeId = String(o?.t ?? '')
    const lastQty = Number(o?.l ?? 0)
    /*
     * ★ 一行把「这个事件到底长什么样」记全（2026-10-06 加）。
     *
     * 为什么值得：11:02 那笔减仓没进账本时，我手上**没有任何证据**说
     * 「事件到没到服务端」—— 只能靠猜（还猜错了，见 `checkHealth`）。
     * 订单事件本来就不多（用户自己下单才有），全记下来不影响日志量，
     * 下次再漏就是一行就能定位的事。
     */
    console.log(
      `${this.tag} 订单事件 s=${o?.s} x=${o?.x} X=${o?.X} t=${tradeId} l=${o?.l}`
    )
    /*
     * ★ 先处理**挂单生命周期**（2026-10-06）：挂单存库、由这条事件流实时维护。
     *   `X` = 订单状态：
     *     NEW / PARTIALLY_FILLED  → 还挂着（部分成交也算挂着，量要更新）
     *     FILLED / CANCELED / EXPIRED / REJECTED → 不在了
     *   ⚠️ 这一步**不受 `t`/`l` 的约束**：挂单事件本来就没有 tradeId。
     */
    await this.syncOrderFromEvent(o)
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
        /* 持仓集合可能变了（新开 / 平掉）→ 对齐一次，别让新仓的盈亏停 5 分钟 */
        this.resyncAfterFill()
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
  /**
   * 这套账户现在**有没有敞口**：有持仓或有挂单。
   *
   * 用途：断流条件之一（见 `WS_SLEEP_AFTER_MS`）—— 有敞口时 **不许**断，
   * 因为那正是「一个事件都不能错过」的时候。
   */
  private hasExposure(): boolean {
    const hasPos = (this.lastOverview?.futures.positions?.length ?? 0) > 0
    return hasPos || this.openOrderCount > 0
  }

  /** 这套账户是不是**空转**：没持仓、没挂单、最近也没动静。
   * 空转 ⇒ 对账降频（见 `ORDERS_RECONCILE_MS_IDLE`）。WS 不动。
   */
  private isIdle(): boolean {
    const hasPos = (this.lastOverview?.futures.positions?.length ?? 0) > 0
    return (
      !hasPos && this.openOrderCount === 0 && Date.now() - this.lastActivityAt > IDLE_MS
    )
  }

  /** 翻转时打一行 —— 不然「到底有没有在降频」完全看不见 */
  private noteIdle(): void {
    const now = this.isIdle()
    if (now === this.idle) return
    this.idle = now
    console.log(
      now
        ? `${this.tag} 空转（无持仓无挂单）→ 对账降频到 30 分钟一轮`
        : `${this.tag} 有动静 → 对账恢复 2 分钟一轮`
    )
  }

  private async reconcileTick(): Promise<void> {
    if (this.stopped) return
    const now = Date.now()
    try {
      /* ⚠️ 先判档再干活：下面的 gap 全看这一档 */
      this.noteIdle()
      const tier = this.tierNow()
      this.noteTier(tier)
      /*
       * 睡着 ⇒ 这一轮**什么都不对**，只留 `sampleIfDue` 那一路（余额曲线）。
       * 四类水位**故意不推进** —— 醒过来那一轮会把它们一次补上。
       */
      if (tier === 'asleep') return
      const gaps = TIER_GAPS[tier]
      if (now - this.lastFillReconcileAt >= gaps.fill) {
        this.lastFillReconcileAt = now
        await this.backfillFills(now - FILL_SAFETY_MS)
      }
      if (now - this.lastIncomeReconcileAt >= gaps.income) {
        this.lastIncomeReconcileAt = now
        await this.reconcileIncome()
      }
      if (now - this.lastOrdersReconcileAt >= gaps.orders) {
        this.lastOrdersReconcileAt = now
        await this.reconcileOrders('tick')
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
   *
   * 顺带承担两件**生命周期**的事（都是 2026-10-06 加的，跑在这里是因为它本来
   * 就是唯一的 30 秒心跳）：
   *   · **终止流程** —— 没人看 + 空仓无挂单够久 ⇒ `sleepWs()` 断掉上游 WS；
   *   · **半开连接自愈** —— `deaf` 持续够久 ⇒ 强制重连一次（`close` 事件可能永远不来）。
   */
  private checkHealth(): void {
    if (this.stopped) return
    /* 有人看吗 —— 断流 / 唤醒都靠这个信号（SSE 订阅 = 用户在线） */
    const watchers = listenerCount(this.row.id)
    if (watchers > 0) this.offlineSince = 0
    else if (!this.offlineSince) this.offlineSince = Date.now()
    if (this.wsSleeping) {
      /*
       * 我们**故意**断的：不判 deaf、不打统计（免得 5 分钟一行 0 帧刷屏）。
       * 一有人来 / 账户重新有敞口就立刻连回去（REST 1 小时兜底期间发现的也算）。
       */
      if (watchers > 0) this.wakeWs('有人打开页面')
      else if (this.hasExposure()) this.wakeWs('账户重新有持仓 / 挂单')
      return
    }
    /*
     * ⚠️ 判据是「**任何动静**都没有」（数据帧或 ping），不是「没有数据帧」——
     *    空闲的账户本来就不推数据。
     */
    const silentMs = Date.now() - this.lastAliveAt
    const deaf = silentMs > WS_DEAF_MS
    /*
     * ★ 线级统计（2026-10-06 加，用户问「减仓后没有推送事件吗」）。
     *
     * 排查「上游到底推没推」时，我们原来的日志**答不了**：
     * `ping` 是控制帧、`dataFrames` 是我们自己数的、`badFrames` 只记解析失败的。
     * **`bytesRead` 才是硬指标**，两种情况一眼分得开：
     *   · 字节只涨几十（心跳每 3 分钟一次，2~7 字节/帧）⇒ 业务帧**根本没到这条连接**；
     *   · 字节涨了不少而 `dataFrames` 还是 0 ⇒ 字节到了、我们没接住，那是**我们自己的问题**。
     * 第一轮 + 之后每 10 轮（5 分钟）打一行，不刷屏。
     */
    this.healthTick++
    if (this.healthTick === 1 || this.healthTick % 10 === 0) {
      const sock = (this.ws as unknown as {_socket?: {bytesRead?: number}})?._socket
      const kb = ((sock?.bytesRead ?? 0) / 1024).toFixed(1)
      const upMin = Math.round((Date.now() - this.connAt) / 60000)
      console.log(
        `${this.tag} 用户数据流统计：事件 ${this.dataFrames} 帧 / ping ${this.pings} 个 / ` +
          `收 ${kb} KB（连上 ${upMin} 分钟，已解析不了 ${this.badFrames}）`
      )
    }
    if (deaf !== this.deaf) {
      this.deaf = deaf
      console.warn(
        deaf
          ? `${this.tag} 用户数据流 ${Math.round(silentMs / 1000)} 秒连 ping 都没有 ` +
              `（收到过 ${this.pings} 个）—— 标记为降级（改用 REST 兜底）`
          : `${this.tag} 用户数据流恢复了（累计 ${this.pings} 个 ping）`
      )
      emit(this.row.id, {type: 'health', deaf})
    }
    if (deaf) this.restartIfStuck()
    if (this.shouldSleepWs()) this.sleepWs()
  }

  /* ---------------- 上游 WS 的终止 / 唤醒（生命周期） ---------------- */

  /**
   * 现在该不该**断掉**上游 WS —— 见 `WS_SLEEP_AFTER_MS` 的四条判据。
   *
   * ⚠️ 安静计时取「账户最后有动静」和「最后一个人离开」里**更晚**的那个：
   *    用户刚关页面但账户 1 分钟前才平过仓，两边都不该立刻断。
   */
  private shouldSleepWs(): boolean {
    if (this.stopped || this.wsSleeping || !this.ws) return false
    if (listenerCount(this.row.id) > 0) return false
    /*
     * ⚠️ **没拿到过快照就不许断**：`hasExposure()` 靠 `lastOverview` 判「空仓」，
     *    它为空说明我们**根本不知道**有没有持仓（启动时那一发被限流挡了、或者一直失败）。
     *    不知道就不动 —— 断流的代价是「持仓期间的事件全丢」，不能靠猜。
     */
    if (!this.lastOverview) return false
    if (this.hasExposure()) return false
    const quietFrom = Math.max(this.lastActivityAt, this.offlineSince)
    return Date.now() - quietFrom > WS_SLEEP_AFTER_MS
  }

  /**
   * 断掉上游 WS（**只断连接**，listenKey 照旧续期 —— 理由见 `WS_SLEEP_AFTER_MS`）。
   *
   * ⚠️ `removeAllListeners()` 必须在 `close()` 之前：不然我们自己那个
   *    `close` 处理函数会把它当成「意外断开」→ `retryLater()` → 白重连一次。
   */
  private sleepWs(): void {
    this.wsSleeping = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    /* 空仓 + 没人看 ⇒ 标记价（每秒 1 条/币）也没有意义了 */
    this.stopMarks()
    /* 流不再是「持仓的权威来源」⇒ 让 REST 别拿缓存里的旧持仓顶事（见 position-cache） */
    setStreamActive(this.row.id, false)
    try {
      this.ws?.removeAllListeners()
      this.ws?.close()
    } catch {
      /* 关不干净无所谓 */
    }
    this.ws = null
    this.deaf = false
    console.log(
      `${this.tag} 上游 WS 断开（没人看 + 空仓无挂单 ${humanMs(
        WS_SLEEP_AFTER_MS
      )}；listenKey 照续，页面一开就重连）`
    )
  }

  /**
   * 有人回来了 / 账户又有敞口 ⇒ 立刻把上游 WS 连回来。
   *
   * 不用 `restart()`：那样会把对账 / 健康 / 续期三个定时器全拆了重建
   * （顺带把水位清零、多打一轮 income）。这里只要那条连接，
   * 连上之后 `open()` 里挂的 `on('open')` 会自己 `reconcile('ws')` 把断线期间的账补上。
   */
  private wakeWs(reason: string): void {
    if (!this.wsSleeping || this.stopped) return
    this.wsSleeping = false
    this.lastAliveAt = Date.now()
    this.healthTick = 0
    setStreamActive(this.row.id, true)
    console.log(`${this.tag} 上游 WS 重连（${reason}）`)
    void this.open()
  }

  /**
   * `deaf` 太久 ⇒ 强制重连一次（半开连接自愈，见 `WS_DEAF_RESTART_MS`）。
   * 重连**复用 listenKey**（`restart(false)`），不打 POST。
   */
  private restartIfStuck(): void {
    if (Date.now() - Math.max(this.lastDeafRestartAt, this.lastAliveAt) < WS_DEAF_RESTART_MS)
      return
    this.lastDeafRestartAt = Date.now()
    this.lastAliveAt = Date.now()
    console.warn(
      `${this.tag} 上游 ${Math.round(WS_DEAF_RESTART_MS / 60000)} 分钟毫无动静，` +
        `多半是半开连接 —— 强制重连一次`
    )
    this.restart(false)
  }

  /**
   * 「账户里真有动静」的统一入口 —— **只许在真有事时调**（见 `lastActivityAt` 的告警）。
   * 睡着的流被它叫醒：REST 兜底期间发现的成交 / 挂单变动也算动静。
   */
  private noteActivity(): void {
    this.lastActivityAt = Date.now()
    this.wakeWs('账户有动静')
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
      /*
       * ⚠️ 这里**故意不碰** `lastActivityAt` —— 见那个字段的注释：
       *    我们自己拉快照不算「账户里有动静」，算了就永远进不了空转 / 沉睡。
       */
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
      /* 限流错要记进**全局冷却**（见 `util/rate-cool`）：止住接下来所有请求的重试 */
      noteRateLimit(e)
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
      /*
       * ★ 睡着的流（`wsSleeping`，见 `WS_SLEEP_AFTER_MS`）只**换一把新 key**，
       *   别顺手把连接连回来 —— 那会把「没人看就断」的决定白做一遍。
       *   key 也不能不管：它是共享的，过期了会连带踢掉用户的量化程序。
       */
      if (this.wsSleeping) {
        console.warn(
          `${this.tag} 续期失败（${(e as Error).message.slice(0, 100)}），` +
            `流是睡着的 ⇒ 只重建 listenKey，不连回去`
        )
        try {
          this.listenKey = String(
            (await this.ex?.fapiPrivatePostListenKey())?.listenKey ?? ''
          )
        } catch {
          /* 拿不到就等下一次续期再试 */
        }
        return
      }
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

/**
 * 让某套 Key **立刻**去对账一次挂单（写操作之后调）。
 *
 * 为什么需要：挂单这会儿是**存库**的（见 `reconcileOrders`）。刚下的单 / 刚撤的单
 * 理论上会经 WS `ORDER_TRADE_UPDATE` 在几百毫秒内落到库里，但**不能只靠它**
 * （今天已经抓到 WS 丢事件的实证）。写操作之后主动对一次，界面才是确定的。
 * 代价：一发 40 权重，只在用户真的下单 / 撤单时发生。
 */
export async function reconcileKeyOrders(keyId: number): Promise<void> {
  const s = streams.get(Number(keyId))
  if (!s) return
  /*
   * ⚠️ 写操作 = 「这套账户有人在用」⇒ 顺手把它从沉睡里叫醒（`skipOrders`：
   *    下面这句马上就要对一次挂单，别白问两遍那 40 权重）。
   *
   * ★ `force` + `skipIncome`（2026-10-06 加）：写操作之后**必须当场把持仓也对平**。
   *
   * ⚠️ 原来这里不带 `force` ⇒ `wake` 那一套被 `FRESH_MS`（60 秒）拦住：
   *    一分钟内已经采过一次快照，减完仓**就只对了一次挂单**，持仓数量（和由它算出来的
   *    浮盈）还停在减仓前 —— 只能等 WS 事件（本机常态会丢）或者那个 5 分钟一轮的成交对账。
   *    实测 2026-10-06：13:19:46 减了仓，界面到进程重启（13:20:12）靠 REST 补成交才动。
   *    代价：一发快照 25 + 成交对账 ≤8 币 ×5 —— 只在用户真下单 / 平仓 / 撤单时发生。
   */
  s.wake('写操作', {skipOrders: true, force: true, skipIncome: true})
  await s.reconcileOrdersForced()
}

/**
 * 「有人来 / 用户手动刷新」—— 让某套 key 立刻补账（见 `KeyStream.wake`）。
 *
 * 用途：① SSE 订阅时（有人打开页面）；
 *      ② `POST /api/exchange/refresh`（用户按 ⟳ / 下拉刷新）⇒ `force`。
 */
export function wakeExchangeStream(
  keyId: number | string,
  reason: string,
  opts: {
    skipOrders?: boolean
    skipSnapshot?: boolean
    skipIncome?: boolean
    force?: boolean
  } = {}
): void {
  streams.get(keyOf(keyId))?.wake(reason, opts)
}

/** 5 分钟采样（曲线 + 兜底对账；C2C 只能靠它） */
export function startSnapshotSampler(): void {
  if (sampler) return
  sampler = setInterval(() => {
    void (async () => {
      for (const s of streams.values()) {
        // 采样点就是 REST 全量拉，跟对账是同一件事
        // ⚠️ 走 `sampleIfDue()`：空转的账户会被拦成 30 分钟一次（见 `SAMPLE_IDLE_MS`）
        await s.sampleIfDue()
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
export function exchangeStreamStatus(): {
  keys: number
  listeners: number
  asleep: number
  /** 上游 WS 被主动断开的条数（没人看 + 空仓，见 `WS_SLEEP_AFTER_MS`） */
  sleeping: number
} {
  let listeners = 0
  for (const set of listenerSets.values()) listeners += set.size
  let asleep = 0
  let sleeping = 0
  for (const s of streams.values()) {
    if (s.isAsleep()) asleep++
    if (s.wsIsSleeping()) sleeping++
  }
  return {keys: streams.size, listeners, asleep, sleeping}
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
