<script setup lang="ts">
/**
 * K 线页底部的**合约下单模块**（2026-10-05）。
 *
 * 用户原话：「在 k 线页面底部新增下单模块，多空 / 滑动条 / 余额 / 杠杆；
 * 下单模式就两种，默认市价和限价」。之后又定了几条样式：
 *   · **报错一律走提示（toast），不占内容区**（顶部中间、3.5 秒自动关）
 *   · 杠杆挪到顶部那一排当**小标签**，点开弹层选（默认 10x，最高 20x）
 *   · 仓位按 **USDT** 算 / 显示
 *   · 仓位滑动条**每 25% 一个节点**，带阻尼 + 过节点震一下
 *   · 做多做空**各一颗按钮**（按哪颗就是哪个方向）
 *
 * ★ 2026-10-05 又改了一版（用户）：
 *   · 顶部两格从「市价 / 限价」换成 **「开单」/「仓位」**；
 *     市价降级成开单页里的一个开关 —— **开着 = 市价单（价格框禁用不能改）**，
 *     关掉 = 可以填价格，填的就是限价单。
 *   · 「仓位」那格：**列出账户里所有币的持仓**（一个可滚动列表），
 *     每条自带「平仓 / 全平」两颗（2026-10-07 改口径：只平一部分叫**平仓**、
 *     整条平掉叫**全平**）；顶栏的「一键平仓」把账户里有持仓的全平一遍。
 *   · **「补仓」整块删掉**（用户：「没有补仓」）。
 *
 * ★ 2026-10-05 第三版（用户）：
 *   · 顶栏**删掉账户昵称和「测试单」那句标签**，整行只剩「开单/仓位 · 杠杆 · 一键平仓」；
 *     「一键平仓」挪到**最右**，点之前弹全站那个确认框（`askConfirm`）二次确认。
 *   · 账户名 + 可用余额挪到**价格那一行的右侧**：账户是个小标签（`.ktag`），
 *     余额跟在后面 —— 顶栏不再横着拉那么长。
 *   · 「测试单」从页面标签变成「配置 → **测试下单**」里的一个开关
 *     （`settings.ts` 的 `testOrder`，默认**开**）。关掉就是**真下单 / 真平仓**
 *     （`/fapi/v1/order`，会真扣保证金）。
 * ⚠️ 顶栏原来那枚常驻的红色「真单」章**已删**（用户 2026-10-07：「提示层真单的那种
 *    去掉，都是真单」+「那个章现在只是噪音」）—— 只有真·测试单那一档才留标记。
 *
 * 余额 / 杠杆都是**绑定那套合约 Key** 的真实数据（`/api/exchange/trade`）：
 *   · 可用余额 → `fapi/v2/balance`
 *   · 当前杠杆 → `fapi/v2/positionRisk`（选了杠杆调 `fapi/v1/leverage` 真设上去）
 *     ⚠️ v1 那个 404 了、v3 在没持仓时回空数组，具体坑见 `data/exchange-trade.ts`
 *
 * 数量不是自己拍的：`数量 = 可用余额 × 仓位% × 杠杆 ÷ 价格`，再按这个合约的
 * 步长向下取整（精度是后端从交易所 exchangeInfo 里读来的）。
 * 真正的取整 / 最小量 / 最小名义价值校验都在后端再做一遍 —— 这儿只是让界面
 * 先显示成「将要发出去的那个数」。
 */
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {
  closeTradePositions,
  fetchTradeInfo,
  placeOrder,
  setTradeLeverage,
  type TradeInfoResult,
  type TradePositionRow
} from '../api'
import {
  bindPositions,
  positionsAt,
  positionsErr,
  positionsRows,
  refreshPositions
} from '../positions'
import {pickSymbol, prefetchSymbol} from '../analyze'
import {fmt, price, usd} from '../format'
import {isForeground, onForegroundChange} from '../live'
import {testOrder} from '../settings'
import {contracts} from '../store'
import {askConfirm} from '../confirm'
import {freshLivePrice, ticker} from '../ticker'
import {showToast} from '../toast'
import {loadTradeKeys, tradeKey} from '../trade-account'
import {useSwipeTabs} from '../swipe-tabs'
import ReduceSheet from './ReduceSheet.vue'

const props = defineProps<{
  /** 当前币种（基础币，如 BTC） */
  symbol: string
  /** 这一页是不是当前页 —— 切走再回来要重新读一次余额 */
  active: boolean
}>()

/**
 * 头行那颗「当前下单账户」要能点开「配置 → 下单账户」—— 弹层归外层页面（`AnalyzeView`）管，
 * 这里只把「点了」这件事报上去（`@config`）。
 */
const emit = defineEmits<{config: []}>()

/**
 * 用哪套交易所 Key —— 「配置」弹层里切（用户 2026-10-05：「配置中可切换用户」）。
 * `undefined` = 后端按默认那套处理。
 */
const keyId = computed(() => tradeKey.value?.id)

/** 币安原始符号（BTCUSDT）：合约表里查不到就按 `币种 + USDT` 兜底 */
const exSymbol = computed(
  () =>
    contracts.value.find(c => c.base === props.symbol)?.symbol ||
    `${String(props.symbol).toUpperCase()}USDT`
)

const info = ref<TradeInfoResult | null>(null)
const loading = ref(false)
const busy = ref(false)
const levBusy = ref(false)
/**
 * 面板上这个杠杆值，**跟交易所确认过**了吗。
 *
 * 没确认过（读不到当前杠杆）就不能直接下单 —— 否则界面上写着 10x、
 * 交易所那边其实是 20x，仓位大小对不上（杠杆决定爆仓价，这个不能糊）。
 * 所以下单前先补一次 `setLeverage`，失败了就停手。
 */
const levConfirmed = ref(false)

/**
 * 顶部两格：「开单」/「仓位」。
 *
 * 用户 2026-10-05：「下单区域限价去掉不需要，改成开单和仓位」——
 * 原来那两颗「市价 / 限价」换成了这两格；市价/限价降级成开单页里的一个开关。
 */
const tab = ref<'open' | 'position'>('open')

/**
 * 顶部两格的顺序 —— **也是左右滑动切换的顺序**。
 *
 * 用户 2026-10-06：「底部开单和仓位可滑动切换，注意不要滑动切换一级 tab 了」。
 * 所以在 `.ord` 上：① 挂自己的滑动手势（见下面 `useSwipeTabs`）；
 * ② 标 `data-no-swipe`，让「开单分析」那一级 tab 的滑动别把它抢走
 * （`swipe-tabs.ts` 那条「标了 `data-no-swipe` 的元素不抢」）。
 */
const TABS = [{value: 'open' as const}, {value: 'position' as const}]

/**
 * 市价开关（开单页）：**开着 = 市价单**，左边价格框禁用不能改；
 * **关掉 = 可填价格**，那就是限价单。
 *
 * 用户 2026-10-05：「市价开启左侧价格不让调，关闭可以填价格就是开限价单」。
 */
const marketOn = ref(true)
/**
 * 方向：做多 / 做空。
 * 用户 2026-10-05：「做多做空不要切换了直接两个按钮吧」—— 所以它不再是「开关状态」，
 * 只是「这颗按钮按下去时带的方向」，按下那一刻才写进来（见 `submit()`）。
 */
const side = ref<'long' | 'short'>('long')
/** 正在提交的是哪一边 —— 只有那一颗显示「提交中…」，另一颗只是变灰 */
const busySide = ref<'long' | 'short' | null>(null)
/** 仓位：占可用余额的百分比（滑动条的值，已经过阻尼） */
const pct = ref(0)
/** 杠杆：用户 2026-10-05 定「默认 10 倍、最高 20 倍」 */
const lev = ref(10)
const priceInput = ref('')
/** 杠杆选值弹层开着没 */
const levOpen = ref(false)

/* ---------------- 提示（toast）：报错 / 结果一律走这儿，不占内容区 ----------------
 *
 * ⚠️ 本组件**不再自己画** toast：走全站那一条（`../toast` 的 `showToast`，
 *    画在 `App.vue` 的 `ToastHost` 里），层级 / 停留时间都归它管
 *    （它压在弹层之上，所以「弹层里调杠杆失败」照样看得见）。
 */
/** 弹一条提示；默认按失败算（这个模块里多半是报错），跟以前一样 */
function say(text: string, tone: 'ok' | 'bad' = 'bad'): void {
  showToast(text, tone)
}

onBeforeUnmount(() => {
  unbindPos?.()
  unbindPos = null
  stopForeground?.()
  stopForeground = null
})

/**
 * 触控震动。
 * Android WebView / Chrome 有 `navigator.vibrate`；iOS Safari 没有 —— 静默跳过，
 * 不为了震一下去装个原生插件（这套 UI 在两边都要能用）。
 */
function buzz(pattern: number | number[] = 12): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* 不支持 / 被策略拦了都无所谓 */
  }
}

/** 请求序号：换币之后兜回来的旧结果直接作废 */
let seq = 0

/** 正在飞的那一发（`币种@KeyId`）和它的请求代次 —— 只有代次没被顶掉才去重复用 */
let pendingKey = ''
let pendingSeq = 0
/** 上一次**成功**读回来的是哪一发、什么时候 */
let loadedKey = ''
let loadedAt = 0
/** 同一份下单信息这么久内不重读（来回切 tab 时别每秒都去问余额） */
const INFO_FRESH_MS = 30_000

const ready = computed(() => info.value?.ready === true)
const base = computed(() => info.value?.base || props.symbol)
const available = computed(() => Number(info.value?.balance?.available ?? 0))
const availableText = computed(() =>
  // 余额那一项没读到时显示「—」：显示 0 会让人以为账户真的没钱（原因走 toast）
  info.value?.balance && !info.value.balanceError
    ? fmt(available.value, 2)
    : '—'
)

/** 交易所允许的最大杠杆（读不到就按 125 兜底） */
const exchangeMaxLev = computed(() => {
  const m = Math.floor(Number(info.value?.maxLeverage ?? 0))
  return m >= 1 ? m : 125
})

/**
 * 杠杆能选的档位：**最高 20 倍**（用户 2026-10-05 定）。
 * 交易所那边上限更低（冷门币可能只有 5x）时不硬撑，按它来。
 */
const LEV_STEPS = [1, 2, 3, 5, 10, 15, 20]
/** 面板打开时的杠杆（用户 2026-10-05：「杠杆默认 10 倍」） */
const DEFAULT_LEVERAGE = 10
const levOptions = computed(() =>
  LEV_STEPS.filter(v => v <= Math.min(20, exchangeMaxLev.value))
)
const maxLev = computed(() => levOptions.value[levOptions.value.length - 1] ?? 10)

/**
 * 一个杠杆值落到哪个**可选档位**上（交易所上限更低时不硬撑 —— 冷门币可能只有 5x）。
 *
 * 用户 2026-10-05 定「默认 10 倍、最高 20 倍」：
 *   · 传进来读不到（0）→ 用 **10**（或这币的上限，取其小）
 *   · 传进来**不在档位里**（8x、50x）→ 取不超过它的最大档
 *     （50x → 20x，因为上限就是 20；8x → 5x）
 *   · ⚠️ 现在**只拿它来夹 `DEFAULT_LEVERAGE`**，不再拿交易所当前值当默认
 *     （那是 20x，会把「默认 10 倍」顶掉，见 `load()` 里那段注释）。
 */
function fitLeverage(l: number): number {
  const opts = levOptions.value
  const top = opts[opts.length - 1] ?? 10
  const fallback = Math.min(10, top)
  if (!(l >= 1)) return fallback
  const fit = opts.filter(v => v <= l)
  return fit.length ? fit[fit.length - 1] : opts[0]
}

const amountPrecision = computed(() => Number(info.value?.amountPrecision ?? 3))
const pricePrecision = computed(() => Number(info.value?.pricePrecision ?? 2))

/** 标记价：期货算保证金 / 名义价值就看它（拿不到退回现价） */
const markRef = computed(() => {
  const m = Number(ticker.value?.markPrice)
  if (Number.isFinite(m) && m > 0) return m
  return Number(freshLivePrice.value ?? ticker.value?.last ?? 0) || 0
})

/** 现价：给限价单「一键用现价」那颗按钮用 */
const lastRef = computed(
  () => Number(freshLivePrice.value ?? ticker.value?.last ?? 0) || 0
)

const priceNum = computed(() => {
  const v = Number(priceInput.value)
  return Number.isFinite(v) && v > 0 ? v : 0
})

/** 算数量用的参考价：限价单（市价开关关掉）用自己的委托价，市价单用标记价 */
const refPrice = computed(() =>
  marketOn.value ? markRef.value : priceNum.value
)

/* ---------------- 仓位滑动条：25% 一个节点 + 阻尼 + 震动 ---------------- */

/** 节点（%）——用户 2026-10-05：「每 25% 一个节点加点阻尼」 */
const NODES = [0, 25, 50, 75, 100]
/** 阻尼半径（个百分点）：离节点 9 个点以内开始被「吸」，越近吸得越紧 */
const DAMP_RANGE = 9
/** 吸的程度：0 = 不吸，1 = 硬贴上去。0.72 = 「明显有节点，但还能卡在两档之间」 */
const DAMP_PULL = 0.72

/** 离得最近的节点下标（判断「跨过节点了没」，用来震一下） */
const nodeIndex = (v: number): number => Math.round(v / 25)

function damp(raw: number): number {
  const node = Math.min(100, Math.max(0, nodeIndex(raw) * 25))
  const d = raw - node
  const pull = Math.max(0, 1 - Math.abs(d) / DAMP_RANGE) * DAMP_PULL
  return Math.min(100, Math.max(0, node + d * (1 - pull)))
}

/**
 * 滑动条：**自己接管**（不用 v-model）——
 * 拿到原始值先过阻尼，再把阻尼后的值写回 input（滑块跟着被「吸」过去），
 * 跨过 25% 节点时震一下。
 */
function onPctInput(e: Event): void {
  const el = e.target as HTMLInputElement
  const v = Math.round(damp(Number(el.value) || 0))
  if (nodeIndex(v) !== nodeIndex(pct.value)) buzz()
  pct.value = v
  el.value = String(v)
}

/* ---------------- 数字 ---------------- */

/** 这一单占用的保证金（USDT）—— 界面上「仓位」显示的就是它 */
const margin = computed(() => available.value * (pct.value / 100))

/** 按交易所步长**向下**取整（宁可小一点，也别超余额 / 超精度） */
function floorTo(v: number, decimals: number): number {
  if (!(v > 0)) return 0
  const f = Math.pow(10, Math.max(0, Math.min(12, decimals)))
  return Math.floor(v * f + 1e-9) / f
}

const quantity = computed(() => {
  const p = refPrice.value
  if (!(p > 0) || margin.value <= 0) return 0
  return floorTo((margin.value * lev.value) / p, amountPrecision.value)
})

/** 名义价值（USDT） */
const notional = computed(() => quantity.value * refPrice.value)

const quantityText = computed(() =>
  quantity.value > 0
    ? quantity.value.toFixed(Math.min(12, amountPrecision.value))
    : '—'
)

/** 「就差选个仓位」这一句是**中性提示**，不是报错 —— 只有它允许显示在内容区 */
const PCT_HINT = '拖一下「仓位」滑动条选个大小'

/**
 * 现在不能下单的原因（空 = 能下）。
 *
 * ⚠️ 它**不显示在内容区**（用户 2026-10-05：「报错不要占用内容，改用提示」）——
 * 只在点那颗按钮时弹一条 toast 说明为什么没下出去。
 */
const blocker = computed(() => {
  if (loading.value) return '正在读合约账户…'
  if (!info.value) return '还没连上交易所'
  if (!info.value.ready) return info.value.reason || '现在下不了单'
  /* 余额都没读到就别拿它算仓位 —— 把真正的原因（IP 白名单 / 网络）摆出来 */
  if (info.value.balanceError) return info.value.balanceError
  if (available.value <= 0) return '合约账户没有可用余额（先划转一点保证金）'
  if (pct.value <= 0) return PCT_HINT
  if (!marketOn.value && !(priceNum.value > 0)) return '限价单要先填价格'
  if (!(refPrice.value > 0)) return '还没拿到价格，稍等一下'
  const minA = Number(info.value.minAmount ?? 0)
  if (minA && quantity.value < minA)
    return `数量太小：这个合约最少要 ${minA} ${base.value}`
  const minC = Number(info.value.minCost ?? 0)
  if (notional.value > 0 && minC && notional.value < minC)
    return `名义价值不够：这一单约 ${notional.value.toFixed(2)} USDT，最少要 ${minC}`
  if (quantity.value <= 0) return '数量太小，按这个合约的精度取整之后是 0'
  return ''
})

/**
 * 杆子底下那四格里的数值。
 *
 * 全是**定宽数字**（`tabular-nums`）+ 固定两列两行 —— 数值怎么变都不改高度，
 * 这样「下单区域高度固定」（用户 2026-10-05）才不会因为数字长短把 K 线图挤上挤下。
 *
 * ⚠️ 报错**不放这儿**（用户：「报错不要占用内容」）：真正的毛病（余额读不到 /
 *    数量太小 / 网络不通）都在点下单时弹一条顶部提示。
 */
const notionalText = computed(() =>
  notional.value > 0 ? fmt(notional.value, 2) : '—'
)

/** 「仓位」那一格显示的数（用户 2026-10-05：按 USDT 算） */
const marginText = computed(() =>
  available.value > 0 ? fmt(margin.value, 2) : '—'
)

/* ---------------- 数据 ---------------- */

/**
 * 限价预填：**标记价**。
 *
 * 用户 2026-10-05 说的「标的价」——三个候选里（现价 / 标记价 / 指数价）取标记价：
 * 期货挂单看它最稳（不会被一笔成交带偏）。要改成现价，把下面 `markRef` 换成
 * `lastRef` 就行（旁边那颗「现价」按钮本来就是给临时改用现价用的）。
 */
function prefillPrice(): void {
  const p = markRef.value
  if (!(p > 0)) return
  priceInput.value = p.toFixed(Math.min(12, pricePrecision.value))
}

function onPriceInput(e: Event): void {
  priceInput.value = (e.target as HTMLInputElement).value
}

/** 「现价」那颗按钮：把限价换成最新成交价（想立刻成交就点它） */
function useLast(): void {
  const p = lastRef.value
  if (!(p > 0)) return
  priceInput.value = p.toFixed(Math.min(12, pricePrecision.value))
}

async function load(): Promise<void> {
  const sym = exSymbol.value
  if (!sym) return
  /*
   * 切页回来（`watch(props.active)`）本来就要重读一次余额；但用户主场景是
   * **两个 tab 来回切**，几秒内切 4 轮就会白打 4 发交易所。所以同一份数据
   * 在这个窗口内不重读 —— `info` 还在（内容没被作废）且币种 / Key 都没变才跳。
   * 换币、换账户都会先把 `info` 清成 `null`，走不到这里。
   *
   * 「正在飞」那一发只在**代次没被顶掉**时才算数：换币 / 换账户会 `seq++`，
   * 旧代次的结果本来就要丢（A→B→A 快速来回时不能被旧的那发挡住，否则面板会空着）。
   */
  const k = `${sym}@${keyId.value ?? ''}`
  if (info.value == null && k === pendingKey && pendingSeq === seq) return
  if (info.value && k === loadedKey && Date.now() - loadedAt < INFO_FRESH_MS)
    return
  const my = ++seq
  pendingKey = k
  pendingSeq = my
  loading.value = true
  try {
    const r = await fetchTradeInfo(sym, keyId.value)
    if (my !== seq) return
    info.value = r
    loadedKey = k
    loadedAt = Date.now()
    /*
     * 杠杆：**默认 10 倍**（用户 2026-10-05 定了两次）。
     *
     * ⚠️ 不跟着**交易所当前值**走：以前是 `fitLeverage(交易所报的)`，
     *    而那两个账户上交易所值是 **20x**，于是「默认」实际变成了 20x
     *    —— 用户 2026-10-05 又提了一次「杠杆默认 10 倍」，这次按默认值来。
     *    交易所那边不等于 10x 时 `levConfirmed=false`，下单前会真设一次 10x，
     *    所以面板上写 10x 就一定按 10x 开（不会出现「写着 10、其实是 20」）。
     */
    const l = Math.floor(Number(r.leverage ?? 0))
    lev.value = fitLeverage(DEFAULT_LEVERAGE)
    levConfirmed.value = l === lev.value
    if (!priceInput.value) prefillPrice()
    /* 读失败的原因（没配 Key / 现货 / IP 白名单 / 网络）也走提示，不占内容区 */
    if (!r.ready) say(r.reason || '现在下不了单')
    else if (r.balanceError) say(r.balanceError)
  } catch (e) {
    if (my !== seq) return
    info.value = null
    say((e as Error).message)
  } finally {
    if (pendingSeq === my) pendingKey = ''
    if (my === seq) loading.value = false
  }
}

/* ---------------- 杠杆 ---------------- */

/** 选一个杠杆：去交易所真设一次（有持仓 / 挂单时交易所会拒，原样弹出来） */
async function pickLeverage(v: number): Promise<void> {
  if (levBusy.value) return
  const want = Math.floor(v)
  if (!(want >= 1) || want === lev.value) {
    levOpen.value = false
    return
  }
  levBusy.value = true
  try {
    const r = await setTradeLeverage(exSymbol.value, want, keyId.value)
    if (r.ok) {
      lev.value = Math.floor(Number(r.leverage ?? want))
      levConfirmed.value = true
      levOpen.value = false
      say(`杠杆已设为 ${lev.value}x`, 'ok')
    } else {
      // 失败就留在弹层里，方便换个值再试
      say(r.error || '调杠杆失败')
    }
  } catch (e) {
    say((e as Error).message)
  } finally {
    levBusy.value = false
  }
}

/** 下单前把杠杆补设一次（读不到当前杠杆时才用得上）；设不上就别下单 */
async function ensureLeverage(): Promise<boolean> {
  if (levConfirmed.value) return true
  try {
    const r = await setTradeLeverage(
      exSymbol.value,
      Math.floor(lev.value),
      keyId.value
    )
    if (r.ok) {
      levConfirmed.value = true
      return true
    }
    say(r.error || '调杠杆失败')
    return false
  } catch (e) {
    say((e as Error).message)
    return false
  }
}

/* ---------------- 下单 ---------------- */

/**
 * 下单 `dir` = 按的是哪颗按钮（做多 / 做空）。
 * 两颗按钮各管一边、不共享状态：按下去就以这个方向提交，
 * 不用先在别处把方向拨对（用户 2026-10-05 去掉那个切换开关）。
 */
async function submit(dir: 'long' | 'short'): Promise<void> {
  if (busy.value || levBusy.value) return
  side.value = dir
  /* 报错统一走提示：先把「为什么下不了」弹出来，不占内容区 */
  if (blocker.value) {
    buzz([20, 60, 20])
    say(blocker.value)
    return
  }
  busy.value = true
  busySide.value = dir
  try {
    if (!(await ensureLeverage())) {
      buzz([20, 60, 20])
      return
    }
    const r = await placeOrder(
      {
        symbol: exSymbol.value,
        side: side.value,
        type: marketOn.value ? 'market' : 'limit',
        quantity: quantity.value,
        // 市价单也带上参考价：后端拿它做「最小名义价值」的体检（不发给交易所）
        price: refPrice.value
      },
      keyId.value,
      testOrder.value
    )
    if (r.ok && r.order) {
      const o = r.order
      const dir = o.side === 'BUY' ? '做多' : '做空'
      const px = o.type === 'LIMIT' ? `限价 ${price(o.price, pricePrecision.value)}` : '市价'
      const body = `${dir} ${o.quantity} ${base.value} · ${px}`
      buzz(12)
      say(
        o.test
          ? `测试单通过校验：${body}（没进撮合、没真开仓）`
          : `已下单：${body}` +
              (o.orderId ? ` · 单号 ${o.orderId}` : ''),
        'ok'
      )
    } else {
      buzz([20, 60, 20])
      say(r.error || '下单失败')
    }
  } catch (e) {
    buzz([20, 60, 20])
    say((e as Error).message)
  } finally {
    busy.value = false
    busySide.value = null
  }
}

/* ---------------- 「仓位」那一格：列出所有持仓，**逐个**平仓 ---------------- */

/**
 * 账户里**所有**持仓（跨交易对）。
 *
 * 用户 2026-10-05：「仓位 平仓是针对每一个仓位的，没有补仓」
 * —— 所以这一格是一个**列表**，每一行自带一颗「平仓」，不再有「补仓」。
 *
 * 数据读共享 store（`./positions`，SSE 推）—— 跟交易所界面 / K 线叠加同源。
 *   这一格只负责「显示 + 排序 + 平仓」。
 */
const positions = computed<TradePositionRow[]>(() => positionsRows.value)
/** 还没读到过任何一份数据（`positionsAt` 为 0）= 正在读 */
const posLoading = computed(() => positionsAt.value === 0 && !posErr.value)
/** 读失败的原因：**列表里那一行小字**（不弹 toast —— 切过来看见空列表总得知道为什么） */
const posErr = computed(() => positionsErr.value)

/**
 * 持仓列表的**排序方式**（用户 2026-10-06）。
 *
 * 第一版是顶栏一颗「按盈利 / 按价值」二态切换，用户随后改成：
 * 「不再点击切换改为点击底部弹窗可选择 按价值升序降序 或者 按盈利升序降序」——
 * 所以现在是**四选一**：`字段 + 方向`，从底部弹出来选。
 *
 * 只存在内存里（没落 localStorage）：这是「这会儿想先看哪一批」的临时视角，
 * 刷新页面回到默认的「按盈利 · 从大到小」。
 */
type PosSort = 'value-desc' | 'value-asc' | 'pnl-desc' | 'pnl-asc'

const posSort = ref<PosSort>('pnl-desc')
/** 排序弹层开着没 */
const sortOpen = ref(false)

/** 顶栏那颗按钮上的字：`价值 ↓`（短，别把顶栏撑高） */
const posSortText = computed(() => {
  const [field, dir] = posSort.value.split('-') as ['value' | 'pnl', 'desc' | 'asc']
  return `${field === 'pnl' ? '盈利' : '价值'} ${dir === 'desc' ? '↓' : '↑'}`
})

function pickSort(v: PosSort): void {
  posSort.value = v
  sortOpen.value = false
  buzz(8)
}

/** 一条持仓的**身份**（排序冻结用；多账户时必须带账户名，否则两套的同名币会串） */
function posKey(p: TradePositionRow): string {
  return `${p.keyName ?? ''}|${p.symbol}|${p.side}`
}

/** 按某种方式排一份（只在 `frozenOrder` 重算时用一次） */
function sortPositions(arr: TradePositionRow[], mode: PosSort): TradePositionRow[] {
  const [field, dir] = mode.split('-') as ['value' | 'pnl', 'desc' | 'asc']
  const sign = dir === 'desc' ? -1 : 1
  return [...arr].sort(
    (a, b) =>
      sign * (field === 'pnl' ? a.unrealized - b.unrealized : a.notional - b.notional)
  )
}

/**
 * 列表的**显示顺序**（身份串的数组）。
 *
 * ⚠️⚠️ 为什么不能每次渲染都按盈利重排（用户 2026-10-06：
 *    「我开了一个 ain 但是一直在跳」）：
 *    未实现盈亏**每秒都在变**，两个仓位数值接近时（实测 RLC −0.39 / 1000BONK −0.47）
 *    排名**每秒翻一次** —— 12 次采样出现 7 种不同顺序，看着就是列表上下乱跳。
 *
 * ⇒ 顺序**冻结**，只在两种情况重排：
 *    ① 用户改了排序方式（`posSort`）；
 *    ② **持仓集合**变了（开新仓 / 平掉 / 换了一批）。
 *   中间的盈亏波动**只改数字、不改位置**。
 */
const frozenOrder = ref<string[]>([])

watch(
  [
    posSort,
    /*
     * ⚠️ 依赖的是「身份集合」的**字符串**，不是持仓数组本身 ——
     *    数组每秒都会被 SSE 换成新的一份，挂在它上面等于没冻结。
     */
    () => positions.value.map(posKey).sort().join('\u0001')
  ],
  () => {
    frozenOrder.value = sortPositions(positions.value, posSort.value).map(posKey)
  },
  {immediate: true}
)

/** 排完序的持仓（列表按它渲染）—— 顺序来自 `frozenOrder`，**不现排** */
const sortedPositions = computed(() => {
  const rank = new Map(frozenOrder.value.map((k, i) => [k, i]))
  return [...positions.value].sort(
    (a, b) =>
      (rank.get(posKey(a)) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(posKey(b)) ?? Number.MAX_SAFE_INTEGER)
  )
})

/** 弹层里那四行（顺序就是弹层里的顺序） */
const SORT_OPTIONS: {v: PosSort; label: string; hint: string}[] = [
  {v: 'pnl-desc', label: '按盈利 · 降序', hint: '赚得多的排前面'},
  {v: 'pnl-asc', label: '按盈利 · 升序', hint: '亏得多的排前面'},
  {v: 'value-desc', label: '按价值 · 降序', hint: '仓位价值大的排前面'},
  {v: 'value-asc', label: '按价值 · 升序', hint: '仓位价值小的排前面'}
]

/**
 * 点持仓里的**币种** → 上面那张 K 线切到这只币（用户 2026-10-06：「k线联动」
 * 「点击仓位中币种可以切换到该k线」）。
 *
 * 走的是分析页那套全局币种（`analyze.ts` 的 `pickSymbol`）——
 * 跟「合约」页点一行、顶部币种下拉选一个，是**同一条路**：
 * 换完 K 线 / 行情条 / 历史结论一起跟着走。
 * `prefetchSymbol` 先把这只币的 K 线发出去，免得切过去的第一屏等网络。
 */
function gotoChart(p: TradePositionRow): void {
  const base = baseOf(p.symbol)
  if (!base || base === props.symbol) return
  prefetchSymbol(base)
  pickSymbol(base)
  buzz(8)
}

/** 列表里那一条的「币」：BTCUSDT → BTC */
function baseOf(symbol: string): string {
  return String(symbol).toUpperCase().replace(/USDT$/, '') || symbol
}

function posQty(p: TradePositionRow): string {
  return `${p.amount.toFixed(Math.min(12, amountPrecision.value))} ${baseOf(p.symbol)}`
}

function sideText(p: TradePositionRow): string {
  return p.side === 'long' ? '多' : '空'
}

/** 未实现盈亏：正负号 + 金额（跟别处一个写法） */
function pnlText(v: number): string {
  return `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`
}

/**
 * 单行里塞不下的那些（开仓数量 / 开仓价）——按住这一行就看见。
 * 手机上没有 hover，但长按会弹 `title`（iOS / Android WebView 都支持）。
 */
function posTitle(p: TradePositionRow): string {
  return (
    `${baseOf(p.symbol)} ${sideText(p)} ${p.leverage}x\n` +
    `开仓数量 ${posQty(p)}\n` +
    `开仓价 ${price(p.entryPrice, pricePrecision.value)}\n` +
    `仓位价值 ${usd(p.notional)}\n` +
    `未实现盈亏 ${pnlText(p.unrealized)}`
  )
}

/*
 * 平仓（只平一部分）—— 用户 2026-10-05：「加个按钮减仓 弹窗选择百分比」，
 * 2026-10-07 改口径：「减仓换成平仓，平仓换成全平」（按钮上的字见模板）。
 * 弹层（`ReduceSheet`）里选百分比，提交走同一个 close 接口。
 */

/** 正在平仓的那一条（null = 弹层关着） */
const reduceRow = ref<TradePositionRow | null>(null)

function openReduce(p: TradePositionRow): void {
  if (busy.value || levBusy.value) return
  reduceRow.value = p
}

async function confirmReduce(pct: number): Promise<void> {
  const p = reduceRow.value
  if (!p || busy.value) return
  busy.value = true
  try {
    const r = await closeTradePositions(
      {symbol: p.symbol, side: p.side, pct},
      keyId.value,
      testOrder.value
    )
    if (r.ok) {
      reduceRow.value = null
      buzz(12)
      const q = ((p.amount * pct) / 100).toFixed(Math.min(12, amountPrecision.value))
      say(
        r.test
          ? `测试平仓通过校验：${baseOf(p.symbol)} ${sideText(p)} ${pct}%（约 ${q}）—— 没进撮合`
          : `已平仓 ${baseOf(p.symbol)} ${sideText(p)} ${pct}%（约 ${q}）`,
        'ok'
      )
      void loadPositions()
    } else {
      buzz([20, 60, 20])
      say(r.error || '全平失败')
    }
  } catch (e) {
    say((e as Error).message)
  } finally {
    busy.value = false
  }
}

/**
 * 拉一次持仓列表。
 *
 * ★ 改造后持仓由共享 store 持有，这里只是让它**绕过后端缓存**立刻拉一次 ——
 *   下单 / 平仓 / 全平之后用，不然要等常驻流下一次推（最多 20 秒）。
 */
async function loadPositions(): Promise<void> {
  refreshPositions([keyId.value])
}

/**
 * 持仓来源的**绑定**（订阅常驻流的 SSE）。
 *
 * 什么时候绑：
 *   · 在「仓位」那一格（开单页不看持仓，没必要订）
 *   · 这一页是当前页 / App 在前台（`isForeground()`）—— 省流量，也免得在后台被限频
 * 什么时候解：上面任一条不满足就解绑，一个请求都不发。
 */
function posPollWanted(): boolean {
  return tab.value === 'position' && props.active && isForeground()
}

let unbindPos: (() => void) | null = null

function syncPosTimer(): void {
  if (!posPollWanted()) {
    unbindPos?.()
    unbindPos = null
    return
  }
  if (unbindPos) return
  unbindPos = bindPositions([keyId.value])
}

/** 前后台翻转：回前台立刻补一次，并重排订阅 */
let stopForeground: (() => void) | null = null

/**
 * 全平：**这一条**持仓整个平掉。
 *
 * 数量由后端按真实持仓算（不填数，免得手滑）；`side` 一起带上 ——
 * 双向持仓模式下同一个币有两条（多 / 空），不带方向会平错那条。
 *
 * ⚠️ 是否真平由「配置 → 测试下单」决定（`testOrder`）：关掉就是**真平仓**。
 */
async function closeOne(p: TradePositionRow): Promise<void> {
  if (busy.value || levBusy.value) return
  busy.value = true
  try {
    const r = await closeTradePositions(
      {symbol: p.symbol, side: p.side},
      keyId.value,
      testOrder.value
    )
    if (r.ok) {
      const n = (r.orders ?? []).length
      buzz(12)
      say(
        r.test
          ? `测试全平通过校验：${baseOf(p.symbol)} ${sideText(p)} ` +
              `${posQty(p)}（没进撮合、没真平仓）`
          : `已提交全平：${baseOf(p.symbol)} ${sideText(p)} ${posQty(p)}` +
              (n ? `（${n} 笔）` : ''),
        'ok'
      )
      void loadPositions()
    } else {
      buzz([20, 60, 20])
      say(r.error || '平仓失败')
    }
  } catch (e) {
    buzz([20, 60, 20])
    say((e as Error).message)
  } finally {
    busy.value = false
  }
}

/**
 * 一键平仓：不指定交易对 → 后端把**有持仓的全平一遍**。
 *
 * ⚠️ **必须二次确认**（用户 2026-10-05）：这是整账户级别的动作，一次误触就全没了。
 * ⚠️ 确认框里**不写「（真单）」**（用户 2026-10-07：「提示层真单的那种去掉，都是真单」）
 *    —— 只有真·测试单那一档才标注「测试单」。
 */
async function closeAll(): Promise<void> {
  if (busy.value || levBusy.value) return
  const test = testOrder.value
  const ok = await askConfirm({
    title: test ? '一键平仓（测试单）？' : '一键平仓？',
    body: test
      ? [
          '把账户里有持仓的币种全部平一遍。',
          {t: '测试单只发到币安测试接口，不进撮合、不会真平。', tone: 'num'}
        ]
      : [
          '把账户里有持仓的币种全部平掉，会真的成交、真的没仓位了。',
          {t: '这一步不可撤销。', tone: 'warn'}
        ],
    okText: '一键平仓',
    danger: !test
  })
  if (!ok) return
  busy.value = true
  try {
    const r = await closeTradePositions(undefined, keyId.value, testOrder.value)
    if (r.ok) {
      const n = (r.orders ?? []).length
      buzz(12)
      say(
        r.test
          ? `一键平仓测试单通过校验：${n} 笔（没进撮合、没真平仓）`
          : `已提交一键平仓：${n} 笔`,
        'ok'
      )
      void loadPositions()
    } else {
      buzz([20, 60, 20])
      say(r.error || '一键平仓失败')
    }
  } catch (e) {
    buzz([20, 60, 20])
    say((e as Error).message)
  } finally {
    busy.value = false
  }
}

/* ---------------- 跟着币种 / 页面走 ---------------- */

/** 换币：整块重来（数字全都跟着上一个币算的，不能留） */
watch(exSymbol, () => {
  seq++
  info.value = null
  pct.value = 0
  priceInput.value = ''
  void load()
})

/* 切走再回来：余额可能变了，重新读一次（没有轮询，不会在后台打交易所） */
watch(
  () => props.active,
  on => {
    if (on) void load()
    /* 不在这一页了就把持仓订阅也放掉（一个请求都不发） */
    syncPosTimer()
  }
)

/*
 * 切到「仓位」那一格才去订持仓（「开单页不看持仓」那条老规矩）——
 * 订的是常驻流，但没必要为它白开一条 SSE。
 */
watch(tab, t => {
  syncPosTimer()
  if (t === 'position') void loadPositions()
})

/* 关掉「市价」= 要填价格开限价单：价格空着就先填上标记价 */
watch(marketOn, on => {
  if (!on && !(priceNum.value > 0)) prefillPrice()
})

/* ---------------- 窄屏：左右滑动切换「开单 / 仓位」 ---------------- */

/**
 * 手势区 = **整块下单模块**（模板里 `.ord` 那个 `ref`）。
 *
 * 用户 2026-10-06：「底部开单和仓位可滑动切换，注意不要滑动切换一级 tab 了」。
 *
 * ⚠️ `.ord` 上必须同时有 `data-no-swipe`（模板里那个属性）：
 *    「开单分析」页把一级 tab 的滑动手势铺在整个 `.split` 上，不加这个，
 *    在这里横划会先被它接走、切成别的 tab（用户明确要求不要）。
 *    注意 `.ord` 在下单区里、**不在** `KlineChart` 那个 `.chart-wrap`
 *    （`data-no-swipe`）范围内 —— 图那个属性盖不到它。
 * ⚠️ 调参与避让规则（输入框 / 横向可滚元素不抢）都在 `../swipe-tabs`；
 *    默认只在窄屏（≤900px）生效，跟一级 tab 的手感对齐。
 */
const rootRef = ref<HTMLElement | null>(null)
const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeTabs<'open' | 'position'>(
  {
    host: () => rootRef.value,
    list: () => TABS,
    current: () => tab.value,
    set: v => (tab.value = v)
  }
)

/*
 * 换了「下单账户」（配置弹层里切的）：余额 / 杠杆 / 持仓全是那套 Key 的，
 * 整块作废重读 —— 不重读的话界面上还挂着上一个账户的数。
 */
watch(
  () => tradeKey.value?.id,
  (nv, ov) => {
    if (nv === ov) return
    seq++
    info.value = null
    pct.value = 0
    /* 换了一套 Key ⇒ 持仓订阅要重绑（旧的先解掉，不然会串到上一个账户） */
    unbindPos?.()
    unbindPos = null
    void load()
    syncPosTimer()
    if (tab.value === 'position') void loadPositions()
  }
)

onMounted(async () => {
  /* 先把 Key 列表拿来（`tradeKey` 靠它算），不然第一发会打到默认那套上去 */
  await loadTradeKeys()
  if (props.active) void load()
  /*
   * 前后台翻转：回前台**立刻补一次**持仓，并把订阅按当前前后台状态重排
   * —— 切后台就解掉，别在后台一直占着。
   */
  stopForeground = onForegroundChange(on => {
    if (on && tab.value === 'position' && props.active) void loadPositions()
    syncPosTimer()
  })
  syncPosTimer()
})
</script>

<template>
  <!--
    ⚠️ `data-no-swipe`：窄屏「开单分析」一级 tab 的左右滑动把手势区铺在整个 `.split` 上，
    这里得自己吃下横向手势 —— 横划是切「开单 / 仓位」（见下面 `useSwipeTabs`），
    不能被当成「切一级 tab」（用户 2026-10-06：「注意不要滑动切换一级 tab 了」）。
  -->
  <div
    ref="rootRef"
    class="ord"
    data-no-swipe
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchEnd"
  >
    <div class="ord-head">
      <!--
        两格：开单 / 仓位（用户 2026-10-05）。
        原来是「市价 / 限价」，限价那格不要了 —— 市价降级成开单页里的一个开关
        （见下面价格那一行的 `.ord-market`）。
      -->
      <div class="seg ord-mode">
        <button
          type="button"
          :class="{active: tab === 'open'}"
          title="开单：市价 / 限价下单"
          @click="tab = 'open'"
        >
          开单
        </button>
        <button
          type="button"
          :class="{active: tab === 'position'}"
          title="仓位：看当前持仓，逐个平仓"
          @click="tab = 'position'"
        >
          仓位
        </button>
      </div>
      <!-- 杠杆：小标签，点开弹层选（用户 2026-10-05：默认 10 倍、最高 20 倍）
           ⚠️ **「仓位」那一格不显示它**（用户 2026-10-06：「仓位界面不要显示杠杆配置」）——
           那一格显示的东西按下面那颗「排序方式」的语义走。 -->
      <button
        v-if="tab === 'open'"
        type="button"
        class="ghost tiny ord-lev"
        :class="{set: levConfirmed}"
        :title="`杠杆 ${lev}x —— 点一下改（最高 ${maxLev}x）`"
        @click="levOpen = true"
      >
        {{ lev }}x
      </button>
      <!--
        排序方式（用户 2026-10-06）——跟杠杆那颗同位置、同版式，只在「仓位」那一格出现。
        点一下**从底部弹出**四选一（按价值 / 按盈利 × 升序 / 降序），
        按钮上是箭头图标 + 当前这一种（「不再点击切换」）。
      -->
      <button
        v-else
        type="button"
        class="ghost tiny ord-sort"
        :title="`排序方式：${posSortText} —— 点一下换一种`"
        @click="sortOpen = true"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" class="ord-sort-ico">
          <path d="M8 4v16M8 20l-3.4-3.4M8 20l3.4-3.4M16 20V4M16 4l-3.4 3.4M16 4l3.4 3.4" />
        </svg>
        {{ posSortText }}
      </button>
      <!--
        ⚠️ 这里原来挂着一枚常驻的「真单」章（只在「配置 → 测试下单」关掉时出现）。
        用户 2026-10-07：「**提示层真单的那种去掉，都是真单**」「也去掉，那个章现在
        只是噪音」⇒ 整颗删掉。测试单那一档的标记照旧（只有真·测试单才标）。
      -->
      <!--
        当前**下单账户**（用户 2026-10-07：「加上当前账户放在 tab 旁」→ 位置换成
        「放在一键平仓旁」）：这一格用的是哪套交易所 Key。
        原来只有「开单」那一页**价格行尾**看得见，切到「仓位」就没影了；
        摆在这儿两页都在，且紧挨着「一键平仓」（用户 2026-10-07：「上面保留，下面去掉」
        —— 价格行那颗已经删掉，账户名只此一处）。
        **点一下**开「配置」（那里能换：下单账户）——「配置」弹层归外层页面管，走 `config` 事件。
        名字是用户自己起的，可能挺长 ⇒ `.ktag` 自带 `max-width` + 省略号。
      -->
      <button
        v-if="tradeKey"
        type="button"
        class="ktag head-acct"
        :title="`下单账户：${tradeKey.name} —— 点一下换（配置 → 下单账户）`"
        @click="emit('config')"
      >
        {{ tradeKey.name }}
      </button>
      <!--
        一键平仓：**最右**（用户 2026-10-05：「一键平仓最右侧，需要二次确认」）——
        不指定交易对，后端把**有持仓的全平一遍**；`closeAll()` 里先 confirm。
      -->
      <button
        type="button"
        class="ghost tiny ord-close-all"
        :disabled="busy || levBusy"
        :title="
          testOrder
            ? '一键平仓：账户里有持仓的全部平掉（测试单，只校验、不真平）'
            : '一键平仓：账户里有持仓的全部平掉'
        "
        @click="closeAll"
      >
        一键平仓
      </button>
    </div>

    <!--
      两页**叠在同一个格子里**（`.ord-page` 都是 `grid-area: 1/1`）——
      身子高度永远等于高的那一页（开单），切页高度不变，上面的 K 线不会跳
      （用户 2026-10-05 反复强调：「下单区域高度固定」）。
      不用的那一页只是 `visibility: hidden`：它**还占着高度**，这正是要的效果。
    -->
    <div class="ord-body">
    <!-- ============ 开单 ============ -->
    <div class="ord-page" :class="{off: tab !== 'open'}">
      <!--
        价格那一行：左边是「价格 + 市价开关 + 输入框（限价时多一颗现价）」，
        **右边顶到行尾**放「账户标签 + 可用余额」
        （用户 2026-10-05：「价格那行输入价格太长了，缩短右侧放账户和余额可用 账户用标签的形式」）。
        ⚠️ 右边那两样**放在 `<label>` 外面**：label 里点哪儿都会去聚焦价格框，
           放里面的话点一下账户标签就弹键盘。
      -->
      <div class="ord-price-row">
        <label class="ord-field ord-price">
          <span>价格</span>
          <!--
            市价开关（用户 2026-10-05：「市价开启左侧价格不让调，关闭可以填价格就是开限价单」）：
            开着 = 市价单，右边价格框禁用、改不了；关掉 = 可以填价格，填的就是限价单。
            `.prevent` 是为了别让外层 `<label>` 把这次点击当成「去聚焦输入框」。
          -->
          <button
            type="button"
            class="ord-market"
            :class="{on: marketOn}"
            :aria-label="marketOn ? '市价' : '限价'"
            :title="
              marketOn
                ? '市价：按对手价立刻成交（点一下关掉就能填价格开限价单）'
                : '限价：挂在指定价格上等成交（点一下切回市价）'
            "
            @click.prevent="marketOn = !marketOn"
          >
            {{ marketOn ? '市价' : '限价' }}
          </button>
          <!--
            市价模式下**不显示**那个参考价（留占位符「市价」）：
            输入框是禁用的，里面却顶着一个数，看着像「这一单会按这个价成交」。
            限价模式才把 `priceInput` 摆出来 —— 切回市价时值留着，切回来不用重填。
          -->
          <input
            :value="marketOn ? '' : priceInput"
            inputmode="decimal"
            :disabled="marketOn"
            :placeholder="marketOn ? '市价' : '限价'"
            @input="onPriceInput"
          />
          <!--
            「现价」只在限价模式露面。
            ⚠️ 它以前挤在「价格 + 数量」并排那一格里，手机上根本放不下（用户 2026-10-05）
            —— 现在「数量」挪到杆子下面了，这一行整行都是价格的，按钮自然有位置。
          -->
          <button
            v-if="!marketOn"
            type="button"
            class="ghost tiny ord-fill"
            title="用最新成交价填进去"
            @click="useLast"
          >
            现价
          </button>
        </label>
        <!-- 右侧一组：**可用余额**（`margin-left: auto` 顶到行尾）。
             ⚠️ 账户名原来也在这儿（用户 2026-10-05：「价格那行…右侧放账户和余额」），
             2026-10-07 挪到头行去了（那行 `开单/仓位` 两页都在）——用户：
             「上面保留，下面去掉」。这里只剩余额。 -->
        <span class="ord-right">
          <!--
            可用余额：读不到时是「—」（显示 0 会让人以为账户真没钱，原因走 toast）。
            真读到 0 的时候**标红 + 带一句怎么办**（用户 2026-10-05：「我怎么开仓位」——
            默认那套 Key 的钱在现货/资金钱包，合约里是 0，光看「可用 0 USDT」不知道下一步）。
          -->
          <span
            class="ord-avail"
            :class="{empty: ready && available <= 0}"
            :title="
              ready && available <= 0
                ? '合约账户没有可用余额 —— 先去「我的 → 交易所账户 → 划转」把 USDT 划到合约钱包，或在「配置 → 下单账户」换一套 Key'
                : undefined
            "
          >
            可用 <b>{{ availableText }}</b> USDT
          </span>
        </span>
      </div>
      <!--
        仓位：按 USDT 算（用户 2026-10-05）—— 每 25% 一个节点，带阻尼 + 震动

        ⚠️ 这一行的类名**不能叫 `ord-pos`**：那是下面**持仓列表**（`<ul class="ord-pos">`）
           的类，它带着 `flex: 1 1 0` + `min-height: 0` + `overflow-y: auto`
           （列表要「吃掉剩余高度、自己在里面滚」）—— 套在滑轨这一行上会把
           这一行压成 **0 高 + 自动裁剪**，滑轨整个看不见（用户 2026-10-05
           报「滑轨的怎么没有了」就是这个）。现在叫 `ord-pct`。
      -->
      <label class="ord-field ord-slider ord-pct">
        <span>仓位</span>
        <!--
          ⚠️ 刻度是**自己画的**（`.ord-ticks`），没用 `<datalist>` ——
          datalist 的刻度在 Chrome 上画在轨道里、样式改不动，还不一定显示；
          自己画才能跟「方形滑块」这套简约外观配套，位置也能算准（见 CSS）。
        -->
        <span class="ord-bar">
          <input
            :value="pct"
            type="range"
            min="0"
            max="100"
            step="1"
            :disabled="!ready"
            :style="{'--fill': pct + '%'}"
            :title="`可用余额的 ${pct}%（每 25% 一个节点）`"
            @input="onPctInput"
          />
          <span class="ord-ticks" aria-hidden="true">
            <i v-for="n in NODES" :key="n" :style="{left: n + '%'}" />
          </span>
        </span>
      </label>

      <!--
        杆子底下的**开仓计算**（用户 2026-10-05：「杆子底部放百分比」「开多少 / 数量放底下」）：
          仓位% · 保证金(USDT) · 数量(币) · 名义价值(USDT)
        固定两列 × 两行 —— 高度**不随数值变**（用户：「下单区域高度固定」），
        报错一律走顶部提示，所以这一块永远只放数字、不会撑高。
      -->
      <div class="ord-read">
        <span class="ord-r"><em>仓位</em><b>{{ pct }}%</b></span>
        <span class="ord-r"><em>保证金</em><b>{{ marginText }} USDT</b></span>
        <span class="ord-r"><em>数量</em><b>{{ quantityText }} {{ base }}</b></span>
        <span class="ord-r"
          ><em>仓位价值</em><b>{{ notionalText }} USDT</b></span
        >
      </div>

      <!-- 右下角那一行：两颗下单按钮（做多 / 做空），都在右边 -->
      <div class="ord-actions">
        <!-- 读不到余额时才有：重新拉一次（放在这一行，不占头部额外高度） -->
        <button
          v-if="!ready && !loading"
          type="button"
          class="ghost tiny ord-retry"
          title="重新读一次余额和杠杆"
          @click="load"
        >
          重试
        </button>
        <!--
          直接两颗按钮（用户 2026-10-05：「做多做空不要切换了直接两个按钮吧」）——
          原来那颗「方向开关」得先把方向拨对、再点下单，两下才下得去，
          而且不点下单看不出会往哪个方向走。现在**按哪颗就是哪个方向**。
          ⚠️ 文案里不带币种：两颗并排，币名重复两遍反而挤（币种在头顶行情条上）。
        -->
        <button
          type="button"
          class="ord-submit long"
          :disabled="busy || levBusy"
          title="做多（买入开仓）"
          @click="submit('long')"
        >
          {{ busySide === 'long' ? '提交中…' : '做多' }}
        </button>
        <button
          type="button"
          class="ord-submit short"
          :disabled="busy || levBusy"
          title="做空（卖出开仓）"
          @click="submit('short')"
        >
          {{ busySide === 'short' ? '提交中…' : '做空' }}
        </button>
      </div>
    </div>

    <!-- ============ 仓位 ============ -->
    <div class="ord-page" :class="{off: tab !== 'position'}">
      <!--
        持仓列表（用户 2026-10-05：「平仓是针对每一个仓位的，没有补仓」）：
        账户里**所有币**的持仓，**一行一条**，各自带「平仓 / 全平」。

        ⚠️ 列表**高度封顶、超出自己滚，但滚动条不画出来** —— 下单区整体高度是钉死的
           （用户：「下单区域高度固定」），这么窄的格子里再占掉 6px 滚动条不划算，
           手指一划就能滚（用户 2026-10-05：「滚动条不显示」）。
        ⚠️ **没有「刷新持仓」按钮**了（用户 2026-10-05：「刷新持仓按钮去掉」）——
           列表**不需要自己刷**：改造（2026-10-06 P1）之后持仓由后端常驻流经 SSE 推，
           开仓 / 平仓一秒钟内自己就变（见脚本 `syncPosTimer`，它只负责订阅）。
           想立刻看到结果就切走再切回来（`watch(tab)` 会让 store 绕缓存拉一次）。
      -->
      <ul v-if="positions.length" class="ord-pos">
        <li
          v-for="p in sortedPositions"
          :key="p.symbol + p.side"
          :title="posTitle(p)"
        >
          <!--
            单行（用户 2026-10-05：「列表单行显示…币种 方向 杠杆标签 仓位价值
            未实现盈利 按钮」）：
              币种 · 方向 · 杠杆 · 仓位价值 …… 未实现盈亏 · 平仓 / 全平
            开仓数量 / 开仓价单行塞不下（窄屏会截断），挪进 `title` —— 要核对
            数量时手指按住这一行就看见了。
            ⚠️ 币种是一颗**按钮**（用户 2026-10-06：「点击仓位中币种可以切换到该k线」）：
              点一下上面那张 K 线就切到这只币，跟「合约」页点一行是同一条路。
          -->
          <div class="op-row">
            <button
              type="button"
              class="op-sym"
              :class="{on: baseOf(p.symbol) === props.symbol}"
              :title="`切到 ${baseOf(p.symbol)} 的 K 线`"
              @click="gotoChart(p)"
            >
              {{ baseOf(p.symbol) }}
            </button>
            <span
              class="op-side"
              :class="p.side === 'long' ? 'side-long' : 'side-short'"
              >{{ sideText(p) }}</span
            >
            <!-- 杠杆：一枚小标签（用户：「杠杆标签」），一眼跟数值/盈亏分开 -->
            <span class="op-lev" :title="`${baseOf(p.symbol)} 这个交易对用的杠杆`"
              >{{ p.leverage }}x</span
            >
            <span class="op-val" :title="`仓位价值：${usd(p.notional)}`"
              >{{ usd(p.notional) }}</span
            >
            <span class="spacer" />
            <b
              class="op-pnl"
              :class="p.unrealized >= 0 ? 'pnl-up' : 'pnl-down'"
              >{{ pnlText(p.unrealized) }}</b
            >
            <button
              type="button"
              class="op-act op-reduce"
              :disabled="busy || levBusy"
              :title="`平仓（只平掉一部分）`"
              @click="openReduce(p)"
            >
              平仓
            </button>
            <button
              type="button"
              class="op-act op-close"
              :disabled="busy || levBusy"
              :title="
                `全平：把 ${baseOf(p.symbol)} 这一条持仓整个平掉` +
                (testOrder ? '（测试单，只校验、不真平）' : '')
              "
              @click="closeOne(p)"
            >
              全平
            </button>
          </div>
        </li>
      </ul>

      <!-- 空列表 / 读失败：把原因摆在原地，别让人以为界面坏了 -->
      <p v-else class="ord-empty">
        {{ posLoading ? '正在读持仓…' : posErr || '现在没有持仓' }}
      </p>

      <!-- 这一格只剩「余额没读到时重试」这一颗了；没有就不占行高 -->
      <div v-if="!ready && !loading" class="ord-actions">
        <button
          type="button"
          class="ghost tiny ord-retry"
          title="重新读一次余额和杠杆"
          @click="load"
        >
          重试
        </button>
      </div>
    </div>
    </div>

    <!-- 杠杆选值：从底部弹出来 -->
    <Teleport to="body">
      <div v-if="levOpen" class="sheet-mask" @click="levOpen = false" />
      <section v-if="levOpen" class="sheet" role="dialog" aria-label="选择杠杆">
        <header class="sheet-head">
          <b>杠杆</b>
          <button
            type="button"
            class="ghost tiny"
            title="关掉"
            @click="levOpen = false"
          >
            ✕
          </button>
        </header>
        <div class="ord-lev-grid">
          <button
            v-for="v in levOptions"
            :key="v"
            type="button"
            :class="{on: v === lev}"
            :disabled="levBusy"
            @click="pickLeverage(v)"
          >
            {{ v }}x
          </button>
        </div>
        <p class="sheet-foot">
          最高 <b>{{ maxLev }}x</b>
          <template v-if="levConfirmed">
            · 当前 {{ lev }}x（交易所那边就是这个）
          </template>
          <template v-else> · 还没读到交易所当前的杠杆，下单前会先设成它</template>
        </p>
      </section>
    </Teleport>

    <!-- 排序弹层：四选一（用户 2026-10-06：「点击底部弹窗可选择…升序降序」） -->
    <Teleport to="body">
      <div v-if="sortOpen" class="sheet-mask" @click="sortOpen = false" />
      <section v-if="sortOpen" class="sheet" role="dialog" aria-label="排序方式">
        <header class="sheet-head">
          <b>排序方式</b>
          <button type="button" class="ghost tiny" title="关掉" @click="sortOpen = false">
            ✕
          </button>
        </header>
        <div class="ord-sort-list">
          <button
            v-for="o in SORT_OPTIONS"
            :key="o.v"
            type="button"
            class="ord-sort-item"
            :class="{on: posSort === o.v}"
            :title="o.hint"
            @click="pickSort(o.v)"
          >
            <b>{{ o.label }}</b>
            <em>{{ o.hint }}</em>
            <span v-if="posSort === o.v" class="ord-sort-tick">✓</span>
          </button>
        </div>
        <p class="sheet-foot">影响「仓位」那一格的持仓列表怎么排。</p>
      </section>
    </Teleport>

    <!-- 平仓弹层：选百分比（只平一部分），提交走同一个 close 接口 -->
    <ReduceSheet
      :open="!!reduceRow"
      :name="reduceRow ? baseOf(reduceRow.symbol) : ''"
      :side="reduceRow?.side ?? 'long'"
      :amount="reduceRow?.amount ?? 0"
      :notional="reduceRow?.notional ?? 0"
      :test-order="testOrder"
      :busy="busy"
      @close="reduceRow = null"
      @confirm="confirmReduce"
    />
  </div>
</template>
