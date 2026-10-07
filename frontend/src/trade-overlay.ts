/**
 * 「画在 K 线上的订单信息」（2026-10-06）。
 *
 * 用户：「配置界面可以配置订单设置，1.仓位 2.订单历史 3.仓位委托 4.强平价格」
 *      「是控制和 k 线联动的价格或历史是否显示在 k 线上」——
 * 就是币安合约图那套叠加层：
 *
 *   · **仓位**     → 持仓的**开仓均价**（多空各一条）
 *   · **强平价格** → 强平价
 *   · **仓位委托** → 当前挂单（每张单一条）
 *   · **订单历史** → 成交历史（图上的买卖点）
 *
 * 数据都来自**当前交易对**的实时接口（`/api/exchange/trade/positions|open-orders|history`），
 * 跟着「配置 → 下单账户」那套 Key 走；开关在 `settings.ts`（`chartShow*` 四个）。
 *
 * 为什么单独抽一个模块（而不是塞进 `KlineChart`）：
 *   · 取数 / 缓存 / 去重 / 防串币这一套跟画图没关系，混在 2000 多行的图里更乱；
 *   · 以后别的图（比如「合约」页的迷你图）想画同一套，直接读这里的响应式状态。
 *
 * ⚠️ 只有**主图**（`KlineChart` 里 `active` 为真的那张）会调 `refreshTradeOverlay` ——
 *    桌面端左栏那张小图不取数，不然一次进页面要打两遍交易所。
 */
import {computed, ref} from 'vue'
import {
  cleanupOrphanOrders,
  exchangeStream,
  fetchTradeHistory,
  fetchTradeOpenOrders,
  type TradeFill,
  type TradeOpenOrder,
  type TradePositionRow
} from './api'
import {
  bindPositions,
  positionsAt,
  positionsErr,
  positionsOf
} from './positions'
import {
  chartShowHistory,
  chartShowLiq,
  chartShowOrders,
  chartShowPosition
} from './settings'
import {contracts} from './store'

/** 这批数据是**哪个交易对**的（币安原始符号）。换币时先清空再拉，别让上一个币的线留在图上 */
export const overlaySymbol = ref('')
/**
 * 当前这个币的持仓（双向持仓模式下多空各一条）。
 *
 * 从共享 store（`./positions`）取，跟交易所界面 / 下单页**同一份数据** ——
 *   ⚠️ 别改回「自己按定时器拉」：那样同一屏的左侧栏和图上会显示两个不同的持仓数。
 */
export const overlayPositions = computed<TradePositionRow[]>(() =>
  overlaySymbol.value ? positionsOf(overlaySymbol.value) : []
)
/** 当前这个币的挂单 */
export const overlayOrders = ref<TradeOpenOrder[]>([])
/** 当前这个币的成交历史 */
export const overlayFills = ref<TradeFill[]>([])
/** 取数出错的原因（界面上不弹，只用来判断「这次没拿到」） */
export const overlayErr = ref('')
/** 这几条挂单线是最近一次对账的快照（最多滞后 2 分钟），不是实时读到的 */
export const overlayStale = ref(false)

/**
 * 币种（`1000BONK`）→ 币安原始符号（`1000BONKUSDT`）。
 * 走合约表（`store.contracts`）拿准确的那个；查不到就按「币种 + USDT」兜底。
 */
export function baseToExSymbol(base: string): string {
  const b = String(base ?? '').toUpperCase()
  return contracts.value.find(c => c.base === b)?.symbol || `${b}USDT`
}

/** 四样里还有开着的吗（全关 = 一个交易所都不用打） */
export function overlayEnabled(): boolean {
  return (
    chartShowPosition.value ||
    chartShowLiq.value ||
    chartShowOrders.value ||
    chartShowHistory.value
  )
}

/**
 * 换币 / 关掉叠加层时把上一批数据扔掉。
 *
 * ⚠️ 必须丢干净：`overlaySymbol` 没换过来的话，图上会拿**上一个币的持仓价**
 *    去画这个币的线 —— 那比不画还糟。
 */
export function clearTradeOverlay(): void {
  overlaySymbol.value = ''
  overlayOrders.value = []
  overlayFills.value = []
  overlayErr.value = ''
  overlayStale.value = false
}

/* ---------------- 持仓：绑到共享 store（改造 P1） ---------------- */

/** 现在绑的是哪套 Key（`undefined` = 没绑）。同一个 key 不重复绑 */
let boundKey: number | undefined | null = null
let unbindPositions: (() => void) | null = null
let stopOverlayEvents: (() => void) | null = null

/**
 * 挂单 / 成交**刚变过**（SSE 推来的）—— 值一变就说明该重读了。
 *
 * 为什么要有它：图上那几条止盈止损线（`overlayOrders`）原先只靠一条 **15 秒**的轮询，
 * 手机上挂一张 / 撤一张，图上最多要等 15 秒才动
 * （用户 2026-10-07：「k线止盈止损渲染感觉慢了一步」；实测确实 **15.3 秒**）。
 * 那条轮询已经删了，现在**全靠这个信号**（持仓那条线早就走 SSE 了）。
 */
export const overlayBump = ref(0)

/**
 * 绑定 / 换绑持仓来源（K 线页调；换「下单账户」时重绑）。
 *
 * 四个开关全关时**什么都不绑** —— 一个请求都不发（跟 `overlayEnabled()` 的口径一致）。
 */
export function bindOverlayPositions(keyId?: number): void {
  if (!overlayEnabled()) {
    unbindOverlayPositions()
    return
  }
  if (boundKey === keyId) return
  unbindOverlayPositions()
  unbindPositions = bindPositions([keyId])
  /*
   * 挂单 / 成交的**变动信号**也订上（同一条 SSE，`sharedSse` 按 path 复用，
   * 不会多开连接）—— 后端 WS 一看到挂单变动 / 新成交就推，我们自己的操作、
   * 币安 App 上的操作都一样会推。
   *
   * ⚠️ 推来的只是「该重读了」这个信号；线本身照旧直连交易所那次读（带 symbol、权重 1）。
   */
  stopOverlayEvents = exchangeStream(keyId, {
    orders: () => overlayBump.value++,
    fill: () => overlayBump.value++,
    /* 上游用户数据流哑了 / 恢复了：这两下都值得补读一次 */
    health: () => overlayBump.value++,
    /* 长连接断够了又连回来：补一次断线期间漏的 */
    reconnect: () => overlayBump.value++
  })
  boundKey = keyId
}

/** 解绑（K 线页卸载时调，别把订阅漏在那儿） */
export function unbindOverlayPositions(): void {
  unbindPositions?.()
  unbindPositions = null
  stopOverlayEvents?.()
  stopOverlayEvents = null
  boundKey = null
}

/** 同一时刻只允许一发在飞（SSE 事件 + 换币 + 回前台可能撞一起） */
let inflight = false
/**
 * 在飞的时候又来了新的取数请求 → 先记一笔，等这一发放完**立刻补**。
 *
 * ⚠️ 不能直接扔掉：用户在配置里把「订单历史」打开，要是这一发刚好跟别的一发
 *    撞上被丢了，图上就得等下一个触发点才出现成交点 —— 看着像开关没生效。
 */
let pendingAsk: {base: string; keyId?: number} | null = null
/** 请求序号：晚发的赢，早发的回来直接扔掉（防「换币后旧币的数据后到」） */
let seq = 0

/**
 * 乐观插入一张**刚挂上去**的单 —— 让图上的线跟提示**同时**出现。
 *
 * 用户 2026-10-07：「我挂单成功，止盈止损已经提示出来了。但是感觉绘制那条线的时候，
 * 有将近 1 秒钟的延迟」—— 那 1 秒全在 `pullOverlay()` 里那次**直连交易所**的读
 * （本地走 SSH 代理 300~500ms，撞上飞在半路的那一发还要再等）。
 * 接口本来就回了单号，没必要为了「让线出现」先跑一趟交易所：
 *
 *   · 这里先把这张单按**交易所载荷的形状**塞进 `overlayOrders`（提示一弹线就在）；
 *   · 紧接着那次重读照发（`refreshTradeOverlay`）——那是**校准**（真值回来覆盖这条），
 *     SSE 的 `orders` 事件也会补一发，所以这条乐观数据活不过一两秒，错了也会被纠正。
 *
 * ⚠️ 只在**真单**成功之后调：测试单根本没挂上去，塞进来会画一条假线。
 * ⚠️ 只收**当前这张图上那个币**：换币的一瞬间可能把别的币插进来。
 *
 * @param replaceId 改单时**被撤掉的旧单号**（后端撤旧挂新，两张不会同时在场上）
 */
export function addLocalOrder(o: TradeOpenOrder, replaceId?: string): void {
  if (!o?.id) return
  if (String(o.symbol).toUpperCase() !== overlaySymbol.value) return
  overlayOrders.value = [
    ...overlayOrders.value.filter(x => x.id !== o.id && x.id !== replaceId),
    o
  ]
}

/** 把一条**已经不在场上**的单从列表里摘掉（撤单成功后立刻用，别等重读） */
export function dropLocalOrder(id: string): void {
  if (!id) return
  overlayOrders.value = overlayOrders.value.filter(x => x.id !== id)
}

/**
 * 拉一次当前交易对的订单信息（只拉**开着的那几样**）。
 *
 * `base` 是界面上那个币种（`1000BONK`），`keyId` 是「配置 → 下单账户」那套 Key。
 */
export async function refreshTradeOverlay(
  base: string,
  keyId?: number
): Promise<void> {
  const symbol = baseToExSymbol(base)
  if (!symbol || !overlayEnabled()) return
  if (inflight) {
    pendingAsk = {base, keyId}
    return
  }
  inflight = true
  const my = ++seq
  if (overlaySymbol.value !== symbol) {
    overlaySymbol.value = symbol
    overlayOrders.value = []
    overlayFills.value = []
    overlayStale.value = false
  }
  /* 持仓走共享 store（见 `overlayPositions`），这里只拉挂单和成交 */
  const wantOrd = chartShowOrders.value
  const wantFill = chartShowHistory.value
  const jobs: Promise<unknown>[] = []
  let err = ''

  if (wantOrd) {
    jobs.push(
      fetchTradeOpenOrders(symbol, keyId)
        .then(r => {
          if (my !== seq || overlaySymbol.value !== symbol) return
          if (!r.ok) {
            err = r.error || '读不到挂单'
            return
          }
          /* 快照也照画，但要标出来（见 `.ord-note`），别让人拿旧价去改单 */
          overlayStale.value = !!r.stale
          overlayOrders.value = (r.orders ?? []).filter(
            o => String(o.symbol).toUpperCase() === symbol
          )
        })
        .catch(e => {
          if (my === seq) err = (e as Error).message
        })
    )
  } else if (overlaySymbol.value === symbol) {
    overlayOrders.value = []
    overlayStale.value = false
  }

  if (wantFill) {
    jobs.push(
      fetchTradeHistory(symbol, keyId)
        .then(r => {
          if (my !== seq || overlaySymbol.value !== symbol) return
          if (!r.ok) {
            err = r.error || '读不到成交历史'
            return
          }
          overlayFills.value = (r.trades ?? []).filter(
            t => String(t.symbol).toUpperCase() === symbol
          )
        })
        .catch(e => {
          if (my === seq) err = (e as Error).message
        })
    )
  } else if (overlaySymbol.value === symbol) {
    overlayFills.value = []
  }

  try {
    await Promise.all(jobs)
  } finally {
    if (my === seq) overlayErr.value = err
    inflight = false
    /* 刚才被挡下的那一发，现在补上 */
    const again = pendingAsk
    pendingAsk = null
    if (again) void refreshTradeOverlay(again.base, again.keyId)
  }

  /*
   * 顺手看一眼：这个币**已经没仓位了，平仓单却还挂着**吗（用户 2026-10-06：
   * 「没有仓位所有挂单都应该取消才对，为什么还显示在图上」）。
   *
   * 就地清掉 —— 手上正好有这个币的持仓和挂单，不用再多打一次接口。
   * ⚠️ **必须确认「持仓真的读到过」**才敢这么判：读不到持仓时「一条都没有」跟
   *    「没读出来」长得一模一样，误判就是误撤。
   *    改造后持仓来自共享 store ⇒ 判据是 `positionsAt > 0`（成功读到过至少一次）
   *    **而且**这一轮没有读失败（`positionsErr` 有值就说明这份数据不可信）。
   */
  const wantPos = chartShowPosition.value || chartShowLiq.value
  const posTrusted =
    positionsAt.value > 0 && my === seq && overlaySymbol.value === symbol
  if (wantPos && wantOrd && posTrusted && !positionsErr.value) {
    const live = new Set(overlayPositions.value.map(p => p.side))
    const hasOrphan = overlayOrders.value.some(o => o.reduceOnly && !live.has(closesSide(o)))
    if (hasOrphan) {
      const swept = await cleanOrphans(symbol, keyId)
      /* 撤掉了就立刻重画一次（不然那几条线要等下一个触发点才消失） */
      if (swept.cancelled) void refreshTradeOverlay(base, keyId)
    }
  }
}

/** 这条平仓单平的是哪条持仓：双向模式听币安的，单向模式按「卖出平多」反推 */
function closesSide(o: TradeOpenOrder): 'long' | 'short' {
  if (o.posSide === 'LONG') return 'long'
  if (o.posSide === 'SHORT') return 'short'
  return o.side === 'sell' ? 'long' : 'short'
}

/** 账户级盘点 / 分币清理：同一时刻只跑一个（多个触发点可能撞上） */
let sweeping = false

/** 清一次残留平仓单，返回「撤了几张、哪几个币」——界面上一行提示用 */
export interface OrphanSweep {
  /** 真撤掉了几张 */
  cancelled: number
  /** 撤的是哪几个币（去重，界面上只报币种） */
  symbols: string[]
  /** 没撤成功的原因（有就说明「看着还在」） */
  error: string | null
  /** 这轮被节流跳过了（不到点）—— 不是出错，界面上什么都不用说 */
  skipped?: boolean
}

/** 账户级盘点的最小间隔（跟 K 线那个定时器同一个数，见 `ORPHAN_SWEEP_MS`） */
export const ORPHAN_SWEEP_MS = 300_000
/**
 * 上一次「账户级盘点」是什么时候（**跨标签页**，所以放 localStorage）。
 *
 * ⚠️ 为什么不能只记在内存里（2026-10-06 实测踩到）：不带交易对查挂单在币安那边
 *    **每条 40 权重**（带交易对才 1），一次盘点 = 80 权重；本地开着好几个标签页 /
 *    反复刷新时，每个页面挂载都会立刻盘一次 —— 几轮下来**整个 IP** 就被
 *    `-1003 Way too many requests` 封了（实测封了 8 分钟，本地开发和生产同一个出口）。
 *    所以这里按「跨标签页的时间戳」节流。
 */
const SWEEP_KEY = 'ca-orphan-sweep-at'

function sweepDue(): boolean {
  try {
    const last = Number(localStorage.getItem(SWEEP_KEY) || 0)
    return !Number.isFinite(last) || last <= 0 || Date.now() - last >= ORPHAN_SWEEP_MS
  } catch {
    /* 无痕模式读不了 localStorage：那就每次都盘（当没有节流） */
    return true
  }
}

function markSweep(): void {
  try {
    localStorage.setItem(SWEEP_KEY, String(Date.now()))
  } catch {
    /* 存不了就算了，下次顶多多盘一次 */
  }
}

/**
 * 清掉残留平仓单（`symbol` 不给 = 盘点整个合约账户）。
 *
 * ⚠️ **真撤单**，跟「测试下单」开关无关；安全边界在后端 `cancelOrphanOrders`
 *    （只碰 `reduceOnly`；持仓读不到就整体不动）。
 */
async function cleanOrphans(symbol?: string, keyId?: number): Promise<OrphanSweep> {
  if (sweeping) return {cancelled: 0, symbols: [], error: null}
  sweeping = true
  try {
    const r = await cleanupOrphanOrders(symbol, keyId)
    if (!r.ok) return {cancelled: 0, symbols: [], error: r.error || '清理挂单失败'}
    const list = r.cancelled ?? []
    return {
      cancelled: list.length,
      symbols: [...new Set(list.map(x => x.symbol))],
      error: r.failed?.length ? r.failed[0]!.error : null
    }
  } catch (e) {
    return {cancelled: 0, symbols: [], error: (e as Error).message}
  } finally {
    sweeping = false
  }
}

/**
 * 整个账户扫一遍「没仓位的残留平仓单」（进 K 线页时来一次，之后每 5 分钟一次）。
 *
 * 为什么要有这一路：上面那次是**跟着 K 线这个币**走的（只在看着某个币时清它），
 * 别的币（比如刚平掉的那条）得等切到它的图才轮到；这一路一次把账户清干净。
 */
export async function sweepOrphanOrders(keyId?: number): Promise<OrphanSweep> {
  if (!sweepDue()) return {cancelled: 0, symbols: [], error: null, skipped: true}
  markSweep()
  return cleanOrphans(undefined, keyId)
}
