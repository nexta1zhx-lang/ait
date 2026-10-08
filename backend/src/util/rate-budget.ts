/**
 * 交易所**权重预算**（2026-10-06 加，改造 P3）。
 *
 * 为什么要有：币安合约按**出口 IP** 算权重（2400/分钟），而我们是**一台服务器
 * 一个出口 IP 给所有用户用** —— 前端多少标签页、多少个人在点，都往同一条预算里挤。
 * 之前后端对前端接口**一个闸都没有**，2026-10-06 就因为「账户级盘点挂单」
 * （不带 symbol 查挂单，40 权重/条）把 IP 打进 `-1003` 黑名单 8 分钟。
 *
 * 做法：**滑动窗口**。每次要打交易所之前先 `takeWeight(n)`，
 * 窗口里已用的权重 + 这次的 > 上限就等（最多等 `MAX_WAIT_MS`，再等不到就抛，
 * 让接口回一句人话而不是把请求挂死）。
 *
 * ⚠️ 上限故意**远低于**币安真实上限（默认 1200 / 2400）：
 *    ① 还有别的进程/别的代码在打同一个 IP（底座灌历史/回补、行情 REST 兜底、划转…），
 *       预算留一半给它们，不然「这边限额了」那边照样把 IP 打封；
 *    ② 权重表是币安文档里的静态值，实际会变，宁可保守。
 *    `EXCHANGE_WEIGHT_LIMIT` 可覆盖（本地调试想看效果就调小）。
 *
 * ⚠️ 这里是**全局**的（不分 key / 不分用户）—— 正因为限流是按 IP，所以必须全局。
 */
import {coolingLeftMs, coolingMessage} from './rate-cool'

const WINDOW_MS = 60_000

function limitOf(): number {
  const v = Number(process.env.EXCHANGE_WEIGHT_LIMIT)
  return Number.isFinite(v) && v > 0 ? v : 1200
}

/** 单次最多等这么久（等不到就抛，别把 HTTP 请求挂在那儿几十秒） */
const MAX_WAIT_MS = 5_000

/**
 * ★ 后台类最多只能吃掉窗口的这么大比例（剩下的是给前台留的**保留额度**）。
 *
 * 为什么要有它（2026-10-08，用户要求；线上实测抓到的）：
 * 发布冷启动时 K 线要补 `灌历史 2100 个任务` + `525 个币的缺口`，而账户侧和它
 * **挤同一个窗口** ⇒ 用户刚打开页面想看账户，拿到的是我们自己限流的
 * 「取数失败：交易所请求太频繁，稍等几秒再试」。等 K 线补完会自愈，但那几分钟
 * 恰好是用户最可能来点的时候（刚发完版本）。
 *
 * 现在：后台最多吃 `70%`，前台可以用满 100%。后台被这条挡住时会走**退避重试**
 * （`paced()` 那套），所以表现是「补数慢一点」而不是「补数失败」。
 *
 * ⚠️ 前台不设自己的上限（它本来就该优先）；总上限仍然管着两类之和。
 * `EXCHANGE_BG_SHARE` 可覆盖（本地调试想看效果就调小，比如 0.2）。
 */
function bgShare(): number {
  const v = Number(process.env.EXCHANGE_BG_SHARE)
  if (!Number.isFinite(v)) return 0.7
  return Math.min(1, Math.max(0, v))
}

/**
 * 权重类别（2026-10-08 加，见下面 `BG_SHARE`）：
 *   · `fg`（前台）= 有人在等结果的：账户查询、下单、K 线的按需补数…
 *   · `bg`（后台）= 没人等、纯补数：K 线底座补缺口 / 灌历史、`candles:audit --repair`…
 */
export type WeightClass = 'fg' | 'bg'

interface Slot {
  at: number
  w: number
  cls: WeightClass
}

let slots: Slot[] = []

/**
 * 串行化队列：只用来**串住「查额度 + 占额度」这一步**（典型的 check-then-act，
 * 不串的话几个并发会同时看到「还有额度」然后一起冲进去）。
 *
 * ⚠️ **等待不能放在这个链里** —— 一放进去，一个在等额度的调用就把整条链堵住，
 *    后面那些本来额度够的请求也得跟着等（实测踩过）。所以等是在链**外面**轮询的。
 */
let chain: Promise<unknown> = Promise.resolve()

const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms))

/** 扔窗口外的记录 */
function prune(now: number): void {
  if (!slots.length) return
  slots = slots.filter(s => now - s.at < WINDOW_MS)
}

function usedOf(): number {
  let sum = 0
  for (const s of slots) sum += s.w
  return sum
}

/** 窗口里**后台类**已经吃掉多少（前台那部分不算进来） */
function bgUsedOf(): number {
  let sum = 0
  for (const s of slots) if (s.cls === 'bg') sum += s.w
  return sum
}

/** 预算不够时给接口用的一句人话 */
export class RateBudgetError extends Error {
  constructor(
    public readonly weight: number,
    public readonly used: number,
    /** 哪一类被挡的 —— 后台被**保留额度**挡住时不该吓人，见 `bgShare()` */
    public readonly cls: WeightClass = 'fg'
  ) {
    super(
      cls === 'bg'
        ? '后台补数正在给交互请求让路（保留额度），稍后继续'
        : '交易所请求太频繁（后端限流保护），稍等几秒再试'
    )
    this.name = 'RateBudgetError'
  }
}

/** 在链里试占一次额度；占到返回 true */
/**
 * 「把每一次取权重都打一行」—— 一份**不带密文**的调用日志。
 *
 * ⚠️ 为什么要有这个开关：用户问「有没有调用 API 的日志」。
 *    币安那套接口出问题时（`-2021` / `-1003` 限流 / 某个符号查不到），
 *    光看业务日志很难还原「那一刻到底发出去了哪些请求、花了多少权重」。
 *    `EXCHANGE_VERBOSE=1` 打开后每取一次权重记一行
 *    （`tag` 就是调用方标的口径，比如 `overview` / `openOrders` / `positionRisk`）。
 *
 * ⚠️ 跟 ccxt 的 `verbose` 不一样：**这个不会把 API Key 打到日志里**。
 *    要连请求 / 响应体一起看才用 ccxt 那个（见 `createExchange`，那条会打 key）。
 */
const VERBOSE = process.env.EXCHANGE_VERBOSE === '1'

function tryReserve(weight: number, cls: WeightClass): Promise<boolean> {
  const run = chain.then(() => {
    const now = Date.now()
    prune(now)
    const limit = limitOf()
    /* 总护栏：两类之和不能超窗口上限 */
    if (usedOf() + weight > limit) return false
    /*
     * 后台护栏：后台不能把前台那份**保留额度**也吃掉。
     * ⚠️ 这条检查**必须还在 `chain` 里**（否则又回到 check-then-act 竞态，见文件头）。
     */
    if (cls === 'bg' && bgUsedOf() + weight > limit * bgShare()) return false
    slots.push({at: now, w: weight, cls})
    if (VERBOSE) {
      console.log(
        `[api] +${weight} 权重（${cls}，窗口内 ${usedOf()}/${limit}` +
          `，其中后台 ${bgUsedOf()}）`
      )
    }
    return true
  })
  chain = run.catch(() => undefined)
  return run
}

/**
 * 取这么多权重；不够就等，等不到（超过 `maxWaitMs`）抛 `RateBudgetError`。
 *
 * ⚠️ 故意**不是「等到天荒地老」**：HTTP 请求挂几十秒比回一句「稍后再试」更糟。
 *    真要等更久（后台任务无所谓）就传大一点的 `maxWaitMs`。
 *
 * `weight <= 0` 或单次就超过上限的（理论不该有）直接放行 —— 否则会死等。
 */
export async function takeWeight(
  weight: number,
  tag: string,
  maxWaitMs = MAX_WAIT_MS,
  /** 缺省 `fg`（前台）—— 没人等结果的后台补数请显式传 `'bg'`，见 `bgShare()` */
  cls: WeightClass = 'fg'
): Promise<void> {
  if (!(weight > 0)) return
  if (VERBOSE) console.log(`[api] ${tag} 取权重 ${weight}`)
  const limit = limitOf()
  if (weight > limit) {
    console.warn(`[budget] ${tag} 单次权重 ${weight} 超过上限 ${limit}，放行`)
    return
  }

  const started = Date.now()
  /*
   * ★ 限流冷却期（收到过 `-1003`）里**先别挤**（2026-10-06 加，见 `util/rate-cool`）：
   *   币安那个窗口是滑动的，而这段时间里发出去的请求基本都是白打。
   *   冷却比 `maxWaitMs` 还长 ⇒ 直接拒绝（回一句人话比挂住强）；
   *   短于 `maxWaitMs` ⇒ 等它一会儿再走正常流程。
   */
  const cool = coolingLeftMs()
  if (cool > 0) {
    if (cool > maxWaitMs) {
      console.warn(`[budget] ${tag} ${coolingMessage()}`)
      throw new RateBudgetError(weight, budgetState().used, cls)
    }
    await sleep(cool)
  }
  for (;;) {
    if (await tryReserve(weight, cls)) return

    prune(Date.now())
    const oldest = slots[0]
    const need = oldest ? oldest.at + WINDOW_MS - Date.now() + 20 : 100
    if (Date.now() - started + need > maxWaitMs) {
      console.warn(
        `[budget] ${tag}（${cls}）权重 ${weight} 被拒` +
          `（窗口已用 ${usedOf()}/${limit}，其中后台 ${bgUsedOf()}/${Math.round(limit * bgShare())}）`
      )
      throw new RateBudgetError(weight, usedOf(), cls)
    }
    /* 分段睡：窗口滑动 / 有别的请求释放时能早点抢到 */
    await sleep(Math.min(need, 500))
  }
}

/** 现在的预算占用（诊断 / 日志用） */
export function budgetState(): {
  used: number
  limit: number
  windowMs: number
  /** 窗口里后台类占了多少 / 后台的上限（诊断"补数为什么慢了"一眼就够） */
  bgUsed: number
  bgLimit: number
} {
  const now = Date.now()
  prune(now)
  const limit = limitOf()
  return {
    used: usedOf(),
    limit,
    windowMs: WINDOW_MS,
    bgUsed: bgUsedOf(),
    bgLimit: Math.round(limit * bgShare())
  }
}
