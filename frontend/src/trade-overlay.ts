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
import {ref} from 'vue'
import {
  fetchTradeHistory,
  fetchTradeOpenOrders,
  fetchTradePositions,
  type TradeFill,
  type TradeOpenOrder,
  type TradePositionRow
} from './api'
import {
  chartShowHistory,
  chartShowLiq,
  chartShowOrders,
  chartShowPosition
} from './settings'
import {contracts} from './store'

/** 这批数据是**哪个交易对**的（币安原始符号）。换币时先清空再拉，别让上一个币的线留在图上 */
export const overlaySymbol = ref('')
/** 当前这个币的持仓（双向持仓模式下多空各一条） */
export const overlayPositions = ref<TradePositionRow[]>([])
/** 当前这个币的挂单 */
export const overlayOrders = ref<TradeOpenOrder[]>([])
/** 当前这个币的成交历史 */
export const overlayFills = ref<TradeFill[]>([])
/** 取数出错的原因（界面上不弹，只用来判断「这次没拿到」） */
export const overlayErr = ref('')

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
  overlayPositions.value = []
  overlayOrders.value = []
  overlayFills.value = []
  overlayErr.value = ''
}

/** 同一时刻只允许一发在飞（15 秒轮询 + 换币 + 回前台可能撞一起） */
let inflight = false
/**
 * 在飞的时候又来了新的取数请求 → 先记一笔，等这一发放完**立刻补**。
 *
 * ⚠️ 不能直接扔掉：用户在配置里把「订单历史」打开，要是这一发刚好跟 15 秒轮询
 *    撞上被丢了，图上就得**再等 15 秒**才出现成交点 —— 看着像开关没生效。
 */
let pendingAsk: {base: string; keyId?: number} | null = null
/** 请求序号：晚发的赢，早发的回来直接扔掉（防「换币后旧币的数据后到」） */
let seq = 0

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
    overlayPositions.value = []
    overlayOrders.value = []
    overlayFills.value = []
  }
  const wantPos = chartShowPosition.value || chartShowLiq.value
  const wantOrd = chartShowOrders.value
  const wantFill = chartShowHistory.value
  const jobs: Promise<unknown>[] = []
  let err = ''

  if (wantPos) {
    jobs.push(
      fetchTradePositions(keyId)
        .then(r => {
          if (my !== seq || overlaySymbol.value !== symbol) return
          if (!r.ok) {
            err = r.error || '读不到持仓'
            return
          }
          const rows = (r.positions ?? []).filter(
            p => String(p.symbol).toUpperCase() === symbol
          )
          overlayPositions.value = rows
        })
        .catch(e => {
          if (my === seq) err = (e as Error).message
        })
    )
  } else if (overlaySymbol.value === symbol) {
    overlayPositions.value = []
  }

  if (wantOrd) {
    jobs.push(
      fetchTradeOpenOrders(symbol, keyId)
        .then(r => {
          if (my !== seq || overlaySymbol.value !== symbol) return
          if (!r.ok) {
            err = r.error || '读不到挂单'
            return
          }
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
}
