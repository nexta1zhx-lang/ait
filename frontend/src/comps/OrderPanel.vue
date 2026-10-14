<script setup lang="ts">
/**
 * K 线页底部的**合约下单模块**（2026-10-05）。
 *
 * 用户原话：「在 k 线页面底部新增下单模块，多空 / 滑动条 / 余额 / 杠杆；
 * 下单模式就两种，默认市价和限价」。之后又定了几条样式：
 *   · **报错一律走提示（toast），不占内容区**（顶部中间、3.5 秒自动关）
 *   · 杠杆挪到顶部那一排当**小标签**，点开弹层选（默认 10x；2026-10-14 起**最高也只给到 10x**）
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
 * ★ 2026-10-14 第四版（用户：「k线页面，底下开单和仓位重构」+「取消限价，优化样式」）：
 *   · **取消限价** —— 这个面板**只发市价单**（`type: 'market'`）。价格那一行
 *     （市价开关 + 价格输入框 + 「现价」）整行删掉；算数量一律用**标记价**（`refPrice`），
 *     它还会跟下单请求一起发给后端做「最小名义价值」体检（不发给交易所）。
 *   · **不再有滑动条**：这一单固定按「**5 倍额度**」开 =
 *     `min(5 × 账户权益, 可用保证金 × 杠杆)`（后端 `MAX_ORDER_EQUITY_RATIO` 同口径）。
 *     够不到 5 倍时，算出来那个数天然就是**最多能开**的量，界面上如实说明。
 *   · **浮盈加仓 50% / 100%**：有持仓且浮盈 > 0 才出现，保证金 = 浮盈 × pct%。
 *   · 版式重做：额度那张卡片（大号「仓位价值」+ 右上 `5×` 标 + 「成交后总杠杆」预演）
 *     + 三格小卡（保证金 / 数量 / 可用）+ 一整行「加仓 · 做多 · 做空」。
 *   · 杠杆最高 **10x**（`LEV_UI_MAX`，后端 `MAX_SYMBOL_LEVERAGE` 硬拦）。
 *
 * 余额 / 杠杆都是**绑定那套合约 Key** 的真实数据（`/api/exchange/trade`）：
 *   · 可用余额 → `fapi/v2/balance`
 *   · 当前杠杆 → `fapi/v2/positionRisk`（选了杠杆调 `fapi/v1/leverage` 真设上去）
 *     ⚠️ v1 那个 404 了、v3 在没持仓时回空数组，具体坑见 `data/exchange-trade.ts`
 *
 * 数量不是自己拍的：`数量 = 5 倍额度 ÷ 标记价`，再按这个合约的步长向下取整
 *（精度是后端从交易所 exchangeInfo 里读来的）。
 * 真正的取整 / 最小量 / 最小名义价值校验都在后端再做一遍 —— 这儿只是让界面
 * 先显示成「将要发出去的那个数」；顶格差一点保证金时后端还会**自动下调数量重试一次**
 *（见 `placeOrder` 的 `MAX_AUTO_SHRINK`），那种情况会在提示里说明调了多少。
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
  availableBalanceOf,
  bindPositions,
  positionsAt,
  positionsErr,
  positionsRows,
  refreshPositions,
  setAvailableBalance
} from '../positions'
import {pickSymbol, prefetchSymbol} from '../analyze'
import {fmt, price, usd} from '../format'
import {isForeground, onForegroundChange, onNetworkResume} from '../live'
import {testOrder} from '../settings'
import {contracts} from '../store'
import {askConfirm} from '../confirm'
import {freshLivePrice, nowTick, ticker} from '../ticker'
import {showToast} from '../toast'
import {loadTradeKeys, tradeKey} from '../trade-account'
import {sweepOrphansAfterClose, sweepOrphansForAccount} from '../trade-overlay'
import {lockLeftMs, lockText} from '../blacklist'
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

/* ---------------- 黑名单（用户 2026-10-10） ---------------- */

/**
 * 这个币还锁多久（毫秒）；`0` = 没锁。
 *
 * ⚠️ 跟着 `nowTick`（每秒跳）走 —— 直接读 `Date.now()` 的话模板不会重算。
 * ⚠️ 这里只管**按钮禁不禁用**；真正拦下单的是后端那道闸。
 */
const banLeft = computed(() => lockLeftMs(props.symbol, nowTick.value))
/** 锁着 ⇒ 做多 / 做空 两颗按钮都禁用 */
const locked = computed(() => banLeft.value > 0)

/** 提交那一刻现算一次（比模板里那个每秒刷的值更贴当下） */
function lockedNow(): boolean {
  return lockLeftMs(props.symbol, Date.now()) > 0
}
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
 * 方向：做多 / 做空。
 * 用户 2026-10-05：「做多做空不要切换了直接两个按钮吧」—— 所以它不再是「开关状态」，
 * 只是「这颗按钮按下去时带的方向」，按下那一刻才写进来（见 `submit()`）。
 */
const side = ref<'long' | 'short'>('long')
/** 正在提交的是哪一边 —— 只有那一颗显示「提交中…」，另一颗只是变灰 */
const busySide = ref<'long' | 'short' | null>(null)
/**
 * 杠杆：**用户 2026-10-14 定「最大只能设 10 倍」**（之前是 2026-10-05 的「最高 20 倍」）。
 * ⚠️ 真正拦的是后端 `MAX_SYMBOL_LEVERAGE`（设杠杆接口）—— 这里只管档位不给选超。
 */
const lev = ref(10)
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
  stopResume?.()
  stopResume = null
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
const available = computed(
  () =>
    availableBalanceOf(keyId.value) ??
    Number(info.value?.balance?.available ?? 0)
)
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
 * 杠杆**不设上限**（用户 2026-10-14 改的口径）：他要的是「所有币统一 10 倍」，
 * 由 `scripts/set-leverage.mjs` 去交易所设，面板只负责**跟随交易所显示**。
 * 所以这里只保留交易所自己的上限（冷门币可能只有 5x）和档位表本身。
 */
/** 可选的杠杆档位 */
const LEV_STEPS = [1, 2, 3, 5, 10, 15, 20]
/** 面板自己最多给到 10x（用户 2026-10-14：「杠杆设置最大只能设 10 倍」） */
const LEV_UI_MAX = 10
/**
 * 面板初值 —— **只有读不到交易所当前杠杆时才会用到它**
 * （正常情况下跟交易所同步，见 `load()` 里那段；用户 2026-10-14 提的「没有同步」）。
 */
const DEFAULT_LEVERAGE = 10
/**
 * 下单的两条硬上限（用户 2026-10-14 定）。真正拦人的是后端
 * （`MAX_ORDER_EQUITY_RATIO` / `MAX_ACCOUNT_LEVERAGE`），这里只用于文案：
 *   · **单笔开单的名义金额 ≤ 5 × 账户权益**（权益 = 钱包余额 + 未实现盈亏）
 *   · **账户总杠杆 ≤ 11 倍** = Σ持仓名义价值 ÷ 账户权益
 */
const ORDER_EQUITY_MAX = 5
const ACCOUNT_LEV_MAX = 11
const levOptions = computed(() =>
  LEV_STEPS.filter(v => v <= Math.min(LEV_UI_MAX, exchangeMaxLev.value))
)
const maxLev = computed(() => levOptions.value[levOptions.value.length - 1] ?? 10)

/**
 * 一个杠杆值落到哪个**可选档位**上（交易所上限更低时不硬撑 —— 冷门币可能只有 5x）。
 *
 * 用户 2026-10-14 定的口径：**跟交易所同步**、但**最高只给到 10x**（`LEV_UI_MAX`）。
 * 所以：
 *   · 传进来读不到（0）→ 用 `DEFAULT_LEVERAGE`（或这币的交易所上限，取其小）
 *   · 传进来**不在档位里**（8x）→ 取不超过它的最大档（8x → 5x）
 *   · 交易所那边写着 20x（以前手工设过）→ 落到档位上限 10x，
 *     下单前 `ensureLeverage()` 会把 10x 真写回交易所，界面显示和实际对得上
 */
function fitLeverage(l: number): number {
  const opts = levOptions.value
  const top = opts[opts.length - 1] ?? LEV_UI_MAX
  const fallback = Math.min(DEFAULT_LEVERAGE, top)
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

/**
 * 算数量用的参考价 —— 一律 **标记价**（2026-10-14 起这个面板**只有市价单**，
 * 用户：「取消限价」）。
 *
 * 它还会跟着下单请求发给后端（`price` 那个字段）：后端拿它做「最小名义价值」
 * 的体检，**不发给交易所**。所以拿不到标记价时面板会拦住不让下单
 * （见 `blocker` 里那条「还没拿到价格」）。
 */
const refPrice = computed(() => markRef.value)

/* ---------------- 这一单开多大：固定按「5 倍额度」算 ---------------- */

/**
 * 账户权益（钱包余额 + 未实现盈亏）。
 * 后端那条「单笔开单 ≤ 5 × 权益」用的就是这个口径，两边必须一致。
 */
const equity = computed(() => {
  const b = info.value?.balance
  return b ? Number(b.wallet ?? 0) + Number(b.unrealized ?? 0) : 0
})

/**
 * 这一单的**目标名义价值**（USDT）= `min(5 × 权益, 可用保证金 × 杠杆)`。
 *
 *   · 前一项是用户定的额度（单笔最多 5 倍权益，后端 `MAX_ORDER_EQUITY_RATIO` 也拦）；
 *   · 后一项是**开得动的上限** —— 保证金被别的仓位占着时，够不到 5 倍。
 *
 * 取小的那个 ⇒「不足 5 倍」时这里天然就是**能开的最大值**，不用另算一套。
 */
const targetNotional = computed(() =>
  Math.max(
    0,
    Math.min(equity.value * ORDER_EQUITY_MAX, available.value * lev.value)
  )
)

/** 5 倍额度本身（文案用） */
const fiveNotional = computed(() => equity.value * ORDER_EQUITY_MAX)

/** 够不到 5 倍吗（保证金被占着 / 余额不够）—— 界面上要如实说，别装满分 */
const belowFive = computed(
  () =>
    ready.value &&
    equity.value > 0 &&
    available.value * lev.value < fiveNotional.value
)

/** 浮盈加仓的两档（用户 2026-10-14：「还有盈利可以选择加仓 50% 或者 100%」） */
const ADD_STEPS = [50, 100]

/** 当前持仓的**未实现盈利**（USDT）—— 加仓的钱从这里来 */
const posProfit = computed(() =>
  Math.max(0, Number(info.value?.position?.unrealized ?? 0))
)

/* ---------------- 数字 ---------------- */

/** 按交易所步长**向下**取整（宁可小一点，也别超余额 / 超精度） */
function floorTo(v: number, decimals: number): number {
  if (!(v > 0)) return 0
  const f = Math.pow(10, Math.max(0, Math.min(12, decimals)))
  return Math.floor(v * f + 1e-9) / f
}

const quantity = computed(() => {
  const p = refPrice.value
  return p > 0 ? floorTo(targetNotional.value / p, amountPrecision.value) : 0
})

/** 名义价值（USDT） */
const notional = computed(() => quantity.value * refPrice.value)

/** 这一单要占用的保证金（USDT）= 名义 ÷ 杠杆 */
const margin = computed(() => (lev.value > 0 ? notional.value / lev.value : 0))

const quantityText = computed(() =>
  quantity.value > 0
    ? quantity.value.toFixed(Math.min(12, amountPrecision.value))
    : '—'
)

/**
 * 浮盈加仓的数量：**保证金 = 浮盈 × pct%**，再受两道约束 —— 单笔不超过
 * 5 × 权益、不超过可用保证金（跟正常开单同一个口径；账户总杠杆那条后端会再拦）。
 */
function addQuantity(pctOfProfit: number): number {
  const addMargin = Math.min(
    (posProfit.value * pctOfProfit) / 100,
    available.value
  )
  const addNotional = Math.min(
    addMargin * lev.value,
    equity.value * ORDER_EQUITY_MAX
  )
  const p = refPrice.value
  return p > 0 ? floorTo(addNotional / p, amountPrecision.value) : 0
}

/** 加仓按钮上那行小字（大约多少币） */
function addHint(pctOfProfit: number): string {
  const q = addQuantity(pctOfProfit)
  if (!(q > 0)) return '浮盈不够开这一单'
  return `约 ${q.toFixed(Math.min(12, amountPrecision.value))} ${base.value}`
}

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
  /* 5 倍额度是按权益算的，权益读不到就没法算这一单开多大 */
  if (equity.value <= 0) return '读不到账户权益（钱包 + 浮盈），先别开'
  if (!(refPrice.value > 0)) return '还没拿到价格，稍等一下'
  const minA = Number(info.value.minAmount ?? 0)
  if (minA && quantity.value < minA)
    return `开不了：5 倍额度算出来的量比这个合约的最小下单量（${minA} ${base.value}）还小`
  const minC = Number(info.value.minCost ?? 0)
  if (notional.value > 0 && minC && notional.value < minC)
    return `名义价值不够：这一单约 ${notional.value.toFixed(2)} USDT，最少要 ${minC}`
  if (quantity.value <= 0) return '5 倍额度算出来的量按精度取整之后是 0'
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

/** 「保证金」那一格（这一单要占多少 USDT） */
const marginText = computed(() => (margin.value > 0 ? fmt(margin.value, 2) : '—'))

/** 「5 倍额度」那一格（文案用；0 位小数就够看） */
const fiveText = computed(() =>
  fiveNotional.value > 0 ? fmt(fiveNotional.value, 0) : '—'
)

/** 账户权益（钱包 + 浮盈）—— 5 倍额度就是拿它算的，文案里要报出这个底数 */
const equityText = computed(() =>
  equity.value > 0 ? fmt(equity.value, 0) : '—'
)

/**
 * 账户里**所有持仓**的名义价值合计（跨交易对，取绝对值）。
 * 后端那条「账户总杠杆 ≤ 11 倍」用的就是它当分子（`assertOrderLimits`）。
 */
const openNotional = computed(() =>
  positionsRows.value.reduce(
    (sum, p) => sum + Math.abs(Number(p.notional ?? 0) || 0),
    0
  )
)

/**
 * 这一单成交后的**预计账户总杠杆** = (现有持仓名义 + 本单名义) ÷ 权益。
 *
 * 摆出来是为了**别等挨拦才知道**：后端 `MAX_ACCOUNT_LEVERAGE` 那道闸就是按这个数
 * 判的，超了直接拒单（提示里也是这么写的）。这里是同一个口径的**预演**。
 * 权益读不到就返回 0 ⇒ 模板里那枚小标不显示（不占高度）。
 */
const levAfter = computed(() =>
  equity.value > 0 ? (openNotional.value + notional.value) / equity.value : 0
)

/** 预计总杠杆的文案；`0` = 读不到权益，不显示 */
const levAfterText = computed(() => (levAfter.value > 0 ? `${levAfter.value.toFixed(1)}x` : ''))

/** 会不会顶到、或顶穿那条 11 倍上限（顶到就标黄提醒） */
const levAfterWarn = computed(() => levAfter.value >= ACCOUNT_LEV_MAX)

/**
 * 能加仓吗：有持仓 + **有浮盈** + 面板可用。
 * 没盈利就**不给**加仓入口（用户 2026-10-14：「如果**还有盈利**还可以选择加仓」）；
 * `blocker` 非空时也不给 —— 连单都开不了的时候加仓更没意义。
 */
const canAdd = computed(
  () =>
    !blocker.value &&
    Number(info.value?.position?.amount ?? 0) > 0 &&
    posProfit.value > 0
)

/* ---------------- 数据 ---------------- */

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
    if (!r.balanceError) setAvailableBalance(keyId.value, r.balance?.available)
    loadedKey = k
    loadedAt = Date.now()
    /*
     * 杠杆：**跟交易所同步**（用户 2026-10-14：「但是杠杆没有和币安的同步」）。
     *
     * 以前这里按默认值来（2026-10-05 定的「默认 10 倍」），结果面板永远显示 10x ——
     * 你在币安手动设的值它不认，下单前还会把 10x 写回去顶掉。
     * 现在：**交易所报多少就显示多少**（夹到可选档位，最高 10x），
     * 只有读不到（`leverage` 为空）才退回默认值。
     * 夹过之后 `levConfirmed=false`，下单前会真设一次 ⇒ 面板上写几倍就按几倍开。
     */
    const l = Math.floor(Number(r.leverage ?? 0))
    lev.value = l >= 1 ? fitLeverage(l) : fitLeverage(DEFAULT_LEVERAGE)
    levConfirmed.value = l === lev.value
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
async function submit(
  dir: 'long' | 'short',
  /** 不传 = 用面板算好的那一单（5 倍额度）；加仓会传自己的量 */
  qtyOverride?: number,
  /** 文案前缀（如「加仓 50%（浮盈）」），只进提示 */
  note = ''
): Promise<void> {
  if (busy.value || levBusy.value) return
  /*
   * 黑名单：这个币锁着就**不让开单**（用户 2026-10-10）。
   * 按钮那边已经禁用了，这里再挡一次 —— 键盘 / 手势有可能绕过 disabled 的视觉判断。
   * （真下单时后端还会拦一道，见 `/api/exchange/trade/order`。）
   */
  if (lockedNow()) {
    say(`${props.symbol.toUpperCase()} 在黑名单里，还要 ${lockText(banLeft.value)} 才能开单`)
    return
  }
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
        /* 这个面板**只有市价单**（2026-10-14 用户：「取消限价」） */
        type: 'market',
        quantity: qtyOverride ?? quantity.value,
        // 带上参考价：后端拿它做「最小名义价值」的体检（不发给交易所）
        price: refPrice.value
      },
      keyId.value,
      testOrder.value
    )
    if (r.ok && r.order) {
      const o = r.order
      const dir = o.side === 'BUY' ? '做多' : '做空'
      const body = `${dir} ${o.quantity} ${base.value} · 市价`
      /*
       * 顶格差一点保证金时后端会**自动下调数量**重试（见后端 `MAX_AUTO_SHRINK`）——
       * 这事必须说出来：不然用户以为自己开满了 5 倍，实际少开了一点。
       */
      const adj = o.adjusted
        ? ` · 数量已从 ${o.adjusted.from} 自动调到 ${o.adjusted.to}（${o.adjusted.reason}）`
        : ''
      buzz(12)
      say(
        o.test
          ? `测试单通过校验：${note ? `${note} · ` : ''}${body}（没进撮合、没真开仓）${adj}`
          : `已下单${note ? `（${note}）` : ''}：${body}${adj}` +
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

/**
 * 浮盈加仓：**方向和当前持仓一致**，数量按「浮盈 × pct%」算
 * （用户 2026-10-14：「如果还有盈利 还可以选择加仓 50% 或者 100%」）。
 *
 * 没持仓 / 没浮盈时按钮根本不显示（`canAdd`），这里再挡一次 —— 按钮的
 * `disabled` 只是视觉，键盘 / 手势有可能绕过去。
 */
async function submitAdd(pctOfProfit: number): Promise<void> {
  const pos = info.value?.position
  if (!pos || !(pos.amount > 0)) {
    say('现在没有持仓，不能加仓')
    return
  }
  if (!(posProfit.value > 0)) {
    say('这个仓位还没有浮盈，不能加仓')
    return
  }
  const q = addQuantity(pctOfProfit)
  if (!(q > 0)) {
    say('浮盈不够开这一单（按这个合约的精度取整之后是 0）')
    return
  }
  /* 方向跟持仓一致（加多 / 加空），杠杆那套流程跟正常开单完全一样 */
  await submit(pos.side, q, `加仓 ${pctOfProfit}%（用浮盈）`)
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
      /*
       * 平掉一部分也可能把仓位清成 0（弹层里选 100%）—— 那几张「平仓保护」单
       * （止损 / 止盈 / 全平型条件单）不会自己消失，图上的线还在。
       * 这里立刻清一次（后端只撤**真的没仓位**的那几张，没清空就什么都不动）。
       */
      if (!r.test) void sweepOrphansAfterClose(baseOf(p.symbol), keyId.value)
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
 *   · 这一页是当前页 / App 在前台（`isForeground()`）—— 可用余额和持仓都由这条
 *     SSE 实时同步，离开页面或切后台时解绑。
 * 什么时候解：上面任一条不满足就解绑，一个请求都不发。
 */
function posPollWanted(): boolean {
  return props.active && isForeground()
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
/** 链路恢复：断网期间漏掉的持仓，网一回来得重新拉一次 */
let stopResume: (() => void) | null = null

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
      /*
       * 全平之后**立刻**清这个币的残留平仓单（用户 2026-10-10：「平仓后没有及时撤单，
       * 线还在」）—— 币安不会因为仓位归零就自动撤那几张止损 / 止盈单，
       * 而图上的线是照它们画的（图没错，是单真还在）。
       */
      if (!r.test) void sweepOrphansAfterClose(baseOf(p.symbol), keyId.value)
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
      /*
       * 一键平仓 = 整个账户全平 ⇒ 盘一遍账户的残留平仓单（`force`：无视 5 分钟节流，
       * 刚全平这一下该花那 80 权重）。不然那几条线要等下一个触发点才消失。
       */
      if (!r.test) void sweepOrphansForAccount(keyId.value, true)
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
  stopResume = onNetworkResume(() => {
    if (tab.value === 'position' && props.active) void loadPositions()
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
        原来是「市价 / 限价」那两格；限价后来降级成开单页里的一个开关，
        2026-10-14 用户又说「取消限价」⇒ 这个面板现在**只发市价单**，「开单」这一格
        就是「按 5 倍额度开、按哪颗按钮就是哪个方向」。
      -->
      <div class="seg ord-mode">
        <button
          type="button"
          :class="{active: tab === 'open'}"
          title="开单：按 5 倍额度市价开仓"
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
      <!-- 杠杆：小标签，点开弹层选（用户 2026-10-14：默认 10 倍、**最高也是 10 倍**）
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
        开多大（2026-10-14 重构）：**既没有滑动条、也没有限价了**
        （用户：「不再提供可拉滑动的开仓界面」+「取消限价」）——
        这一单固定按「5 倍额度」开 = `min(5 × 账户权益, 可用保证金 × 杠杆)`；
        保证金被别的仓位占着、够不到 5 倍时，那个数天然就是**最多能开**的量，
        如实显示（下面那行小字会说清楚），不装满分。
        · 右上 `5×` 那枚小标：这一单是按几倍权益算的；
        · 中间那行**大号数字**：这一单的仓位价值（USDT）——最该一眼看见的数；
        · 底下三格：保证金 / 数量 / 可用 —— 等宽小卡片，**高度不随数值变**
          （用户 2026-10-05：「下单区域高度固定」，上面的 K 线不能被顶来顶去）。
      -->
      <div class="ord-quota">
        <span class="ord-quota-lb">仓位价值</span>
        <span class="ord-quota-tag">5×</span>
        <b class="ord-quota-num"
          >{{ notionalText }}<i>USDT</i></b
        >
        <span class="ord-quota-sub">
          <span class="ord-quota-subtxt">
            <template v-if="belowFive"
              >保证金不够开满 5 倍 · 理想额度
              <b>{{ fiveText }}</b> USDT</template
            >
            <template v-else
              >单笔上限 = 5 × 账户权益（<b>{{ equityText }}</b> USDT）</template
            >
          </span>
          <!--
            成交后的**预计账户总杠杆**（后端那条 11 倍闸的预演，见 `levAfter`）——
            顶到上限就标黄：与其点下去被后端拒，不如提前看见。
            `levAfter` 是 0（权益读不到）时整颗不显示，行高不变。
          -->
          <span
            v-if="levAfterText"
            class="ord-levhint"
            :class="{warn: levAfterWarn}"
            :title="
              `这一单成交后：现有持仓名义 ${fmt(openNotional, 0)} + 本单 ${notionalText} = ` +
              `${levAfter.toFixed(1)}x（上限 ${ACCOUNT_LEV_MAX}x，超了后端会拒单）`
            "
          >
            总杠杆 {{ levAfterText }}
          </span>
        </span>
      </div>

      <!--
        底下那三格（用户 2026-10-05：「开多少 / 数量放底下」）：
        保证金(USDT) · 数量(币) · 可用(USDT)。
        ⚠️ 报错**不放这儿**（用户：「报错不占用内容」）——真正的原因都在点下单时弹提示，
           所以这一块永远只放数字、不会撑高。
        ⚠️ 加仓那两颗按钮**不放这儿**（它们是有浮盈才出现的，会把这个区撑高）——
           放下面那行按钮里，那行本来就固定高度。
      -->
      <div class="ord-read">
        <span class="ord-r"
          ><em>保证金</em
          ><b>{{ marginText }}<i>USDT</i></b></span
        >
        <span class="ord-r"><em>数量</em><b>{{ quantityText }} {{ base }}</b></span>
        <!--
          可用余额：读不到时是「—」（显示 0 会让人以为账户真没钱，原因走 toast）。
          真读到 0 的时候**标红 + 带一句怎么办**（用户 2026-10-05：「我怎么开仓位」——
          默认那套 Key 的钱在现货/资金钱包，合约里是 0，光看「可用 0 USDT」不知道下一步）。
        -->
        <span
          class="ord-r"
          :title="
            ready && available <= 0
              ? '合约账户没有可用余额 —— 先去「我的 → 交易所账户 → 划转」把 USDT 划到合约钱包，或在「配置 → 下单账户」换一套 Key'
              : undefined
          "
        >
          <em>可用</em>
          <b :class="{empty: ready && available <= 0}"
            >{{ availableText }}<i>USDT</i></b
          >
        </span>
      </div>

      <!-- 底下那一行：加仓（有浮盈才有）+ 两颗下单按钮（做多 / 做空），铺满整行 -->
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
          浮盈加仓（用户 2026-10-14：「如果还有盈利 还可以选择加仓 50% 或者 100%」）：
          只有**有持仓且浮盈 > 0**时才出现；方向跟持仓一致（加多 / 加空），
          数量 = 浮盈 × 50% / 100% 当保证金（见 `addQuantity`）。
          放这一行是为了**不改变上面那个「固定高度」的计算区**。
        -->
        <template v-if="canAdd">
          <button
            v-for="n in ADD_STEPS"
            :key="n"
            type="button"
            class="ghost tiny ord-add-b"
            :disabled="busy || levBusy"
            :title="`用浮盈加仓 ${n}%（${addHint(n)}）`"
            @click="submitAdd(n)"
          >
            加仓 {{ n }}%
          </button>
        </template>
        <!--
          直接两颗按钮（用户 2026-10-05：「做多做空不要切换了直接两个按钮吧」）——
          原来那颗「方向开关」得先把方向拨对、再点下单，两下才下得去，
          而且不点下单看不出会往哪个方向走。现在**按哪颗就是哪个方向**。
          ⚠️ 文案里不带币种：两颗并排，币名重复两遍反而挤（币种在头顶行情条上）。
        -->
        <button
          type="button"
          class="ord-submit long"
          :disabled="busy || levBusy || locked"
          :title="
            locked
              ? `${symbol.toUpperCase()} 在黑名单里：还有 ${lockText(banLeft)} 才能开单`
              : '做多（买入开仓）'
          "
          @click="submit('long')"
        >
          {{ busySide === 'long' ? '提交中…' : '做多' }}
        </button>
        <button
          type="button"
          class="ord-submit short"
          :disabled="busy || levBusy || locked"
          :title="
            locked
              ? `${symbol.toUpperCase()} 在黑名单里：还有 ${lockText(banLeft)} 才能开单`
              : '做空（卖出开仓）'
          "
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
          单笔开单 ≤ <b>{{ ORDER_EQUITY_MAX }}</b> 倍账户权益 · 账户总杠杆 ≤
          <b>{{ ACCOUNT_LEV_MAX }}x</b>
          <template v-if="levConfirmed">
            · 当前 {{ lev }}x（交易所那边就是这个）
          </template>
          <template v-else> · 交易所那边不是 {{ lev }}x，下单前会先设成它</template>
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
