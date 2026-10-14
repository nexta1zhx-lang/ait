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
  type AutoStopResult,
  type TradeInfoResult,
  type TradePositionRow
} from '../api'
import {
  accountEquityOf,
  availableBalanceOf,
  bindPositions,
  onAutoStop,
  positionsOf,
  positionsRows,
  refreshPositions,
  setAvailableBalance
} from '../positions'
import {fmt, price, usd} from '../format'
import {isForeground, onForegroundChange, onNetworkResume} from '../live'
import {autoStopOf, testOrder} from '../settings'
import {pickSymbol, prefetchSymbol} from '../analyze'
import {contracts} from '../store'
import {freshLivePrice, nowTick, ticker} from '../ticker'
import {showToast} from '../toast'
import {loadTradeKeys, tradeKey} from '../trade-account'
import {sweepOrphansAfterClose} from '../trade-overlay'
import {lockLeftMs, lockText} from '../blacklist'
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
/**
 * 正在读合约账户。
 * ⚠️ 初值是 `true`：面板**第一帧**就按「还没读到」渲染（见 `reading` 的那个占位），
 *    不然挂载那一瞬间会先闪一下「能开 0.00 USDT」再跳成真的数字。
 *    `load()` 一进来就把它按真实进度设掉，切币种 / 切账户也同样走 `reading`。
 */
const loading = ref(true)
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

/*
 * ★ 2026-10-14 用户：「**去掉仓位界面融合到一个开单，只显示当前开单仓位**」——
 *   原来顶部那两格「开单 / 仓位」（以及中间那个持仓列表）**整块删了**，
 *   面板只剩这一页：上面一块显示**这个币**的仓位（已开），下面一块算**还能开多少**（未开）。
 *   账户里别的币的持仓去「我的 → 交易所账户」看。
 */

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

/*
 * 开仓 / 加仓后的**自动止损是后台挂的**（后端不等它，见下单那段）⇒ 挂完从常驻流推一条
 * `auto-stop` 过来，这里补一句提示。下单那条 toast 只管这一单本身，不再等止损。
 */
const stopAutoStop = onAutoStop(r => {
  const text = autoStopText(r)
  if (!text) return
  /* `autoStopText` 是给「下单提示后面接一句」写的，这里自成一条 ⇒ 去掉开头的分隔符 */
  const note = text.replace(/^ · /, '')
  const bad = r.ok === false && r.skipped !== 'manual-stop'
  /* 带上币种（`1000PEPEUSDT` → `1000PEPE`）：一个账户同时开几个币时得知道说的是谁 */
  say(`${baseOf(r.symbol)} ${note}`, bad ? 'bad' : 'ok')
})

onBeforeUnmount(() => {
  stopAutoStop()
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

/* ---------------- 已开 / 未开：这个币的额度账 ---------------- */

/**
 * 账户权益（钱包余额 + 未实现盈亏）。
 * 后端那三条上限（`assertOrderLimits`）用的就是这个口径，两边必须一致。
 */
const equity = computed(() => {
  /* ★ 优先共享 store 那一份（常驻流每次推持仓都带钱包 + 浮盈 ⇒ 跟着行情实时动）；
     没有（还没读到 / 没绑流）才退回这份 REST 快照里的余额 */
  const live = accountEquityOf(keyId.value)
  if (live !== null) return live
  const b = info.value?.balance
  return b ? Number(b.wallet ?? 0) + Number(b.unrealized ?? 0) : 0
})

/**
 * **这个币**当前的持仓（`null` = 没持仓）—— 用户 2026-10-14：「只显示当前开单仓位」。
 *
 * ★ 两个来源，**优先共享 store**（`./positions`）：
 *   ① 它有常驻**用户数据流（SSE）**在推 —— 币安那边一成交就推过来（通常一两百毫秒），
 *      比我们开完单再发一次 `/api/exchange/trade`（一个来回）**更快**；
 *      用户说的「**平仓后没有及时切换、开仓后有延时**」就靠这个抹平；
 *   ② 退路是这次 `/api/exchange/trade` 带回的那一行（store 没绑定时，比如页面在后台）。
 *
 * ⚠️ 双向持仓时同一个币会有两条（多 / 空）⇒ 取名义大的那条（面板只展示一条）。
 */
const curPos = computed<TradePositionRow | null>(() => {
  const sym = exSymbol.value
  const rows = positionsOf(sym)
  const live = rows.length
    ? rows.reduce((a, b) =>
        Math.abs(Number(b.notional) || 0) > Math.abs(Number(a.notional) || 0) ? b : a
      )
    : null
  if (live) {
    /*
     * ⚠️ 币安 WS 的 `ACCOUNT_UPDATE` 里**没有杠杆** ⇒ 刚开的仓位在流里那一两秒是 `0`
     *    （要等下一次 REST 快照才补上）。面板上直接印就会闪一下「0x」——
     *    这里退回面板当前的杠杆（下单前 `ensureLeverage()` 已把它写到交易所，同一个值）。
     */
    return {...live, leverage: Number(live.leverage) || lev.value}
  }
  const p = info.value?.position
  if (!p || !(Number(p.amount) > 0)) return null
  return {
    ...p,
    symbol: sym,
    leverage: Number(p.leverage) || lev.value,
    keyName: tradeKey.value?.name
  }
})

/** 这个币**已经开着**的名义价值（USDT） */
const curNotional = computed(() =>
  curPos.value ? Math.abs(Number(curPos.value.notional) || 0) : 0
)

/**
 * 「这一份合约账户数据**还没到**」—— 正在读、且手上没有可用的那一份。
 *
 * 切币种 / 切账户会先把 `info` 清空再重读，那一小会儿面板本来会按
 * 「没持仓 + 权益 0」渲染 ⇒ 先闪一下「能开 0.00 USDT」再跳成「仓位」。
 * 用户 2026-10-14 明确要治这个（「切换会跳到未开仓在显示已开，未开是会先显示 0」）：
 * 这期间只显示一行占位，两块正文都不渲染。
 */
const reading = computed(() => !info.value && loading.value)

/** 有持仓吗（界面靠它分「已开 / 未开」两种样子） */
const opened = computed(() => curPos.value !== null)

/** 5 倍额度本身（USDT）= 5 × 权益 */
const fiveNotional = computed(() => equity.value * ORDER_EQUITY_MAX)

/*
 * 还能开多少 = 三条上限里**最紧**的那一条：
 *   ① 这个币的 5 倍额度还差多少（5 × 权益 − 已开）—— 后端 `symbolBudget` 同口径；
 *   ② 账户总杠杆那条还差多少（11 × 权益 − Σ现有持仓名义）—— 后端 `MAX_ACCOUNT_LEVERAGE`；
 *   ③ 可用保证金撑得起多少（可用 × 杠杆）。
 *
 * ★ 用户 2026-10-14 的原话：「**我都已经开仓了，剩余开仓应该是 0**」——
 *   所以①算的是**剩余**，开满时这里就是 0，界面上也如实写 0（不再装作还能开 5 倍）。
 */
const roomBySymbol = computed(() =>
  Math.max(0, fiveNotional.value - curNotional.value)
)
const roomByAccount = computed(() =>
  Math.max(0, equity.value * ACCOUNT_LEV_MAX - openNotional.value)
)
/**
 * 可用保证金撑得起多少名义价值 = `可用 × 杠杆`。
 *
 * ⚠️ 留 **0.5% 给手续费**（`FEE_SLACK`，跟后端 `autoShrinkQty` 同一个数）：
 *    交易所要的是「起始保证金 **+ 手续费**」，按可用顶格算出来的数量必被回 `-2019`；
 *    而后端的自动收口**只下调**（算出来跟原数量一样甚至更多就原样抛错）⇒
 *    用户看到的是「明明显示能开，点了一下说保证金不够」。
 *    （2026-10-15 实测踩到：可用 5.9、面板数量 14505、回 -2019。）
 */
const roomByMargin = computed(() => Math.max(0, available.value * lev.value * 0.995))

/** **还能开的名义价值**（USDT）—— 面板上那个大数字就是它 */
const roomNotional = computed(() =>
  Math.max(
    0,
    Math.min(roomBySymbol.value, roomByAccount.value, roomByMargin.value)
  )
)

/** 这个币的 5 倍额度已经用满（还有仓）—— 界面要明说，别让人以为是坏了 */
const fulled = computed(() => opened.value && roomBySymbol.value <= 0)

/** 当前持仓的**未实现盈利**（USDT）—— 加仓的钱从这里来（走实时那一份 `curPos`） */
const posProfit = computed(() =>
  Math.max(0, Number(curPos.value?.unrealized ?? 0))
)

/** 按交易所步长**向下**取整（宁可小一点，也别超余额 / 超精度） */
function floorTo(v: number, decimals: number): number {
  if (!(v > 0)) return 0
  const f = Math.pow(10, Math.max(0, Math.min(12, decimals)))
  return Math.floor(v * f + 1e-9) / f
}

const quantity = computed(() => {
  const p = refPrice.value
  return p > 0 ? floorTo(roomNotional.value / p, amountPrecision.value) : 0
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

/* ---------------- 加仓（滑动选金额） ---------------- */

/**
 * **加仓**：一个键位 + 弹层里滑动选「加仓金额（USDT）」
 * （用户 2026-10-15：「改为一个键位加仓 加仓在平仓左侧，点击加 弹窗显示 改为可滑动加仓」，
 *   并当面定了口径：滑的是**加仓金额**，上限取「可用保证金 / 额度 / 浮盈」允许的最大值）。
 */
const addOpen = ref(false)
/** 弹层里滑出来的加仓金额（USDT **名义价值**，不是保证金） */
const addValue = ref(0)

/** 最小加仓金额 = 交易所的最小名义价值（拿不到就按 5 USDT 兜底） */
const addMinCost = computed(() => Number(info.value?.minCost ?? 0) || 5)

/** 浮盈能撑多少名义价值：`浮盈 × 杠杆`（后端 `symbolBudget` 的 profitBudget 同口径） */
const profitRoom = computed(() => posProfit.value * lev.value)

/**
 * 这个币还能加到多少名义价值：**取「两条预算里够得着的那条」**
 * —— 后端 `symbolBudget` 是「累计 ≤ 5×权益」**或者**「本单 ≤ 浮盈×杠杆」，
 *    所以这里也是 `max(5 倍额度剩余, 浮盈预算)`，不是两者取小。
 */
const addRoom = computed(() => Math.max(roomBySymbol.value, profitRoom.value))

/** 加仓金额的**上限**：可用保证金那条、账户总杠杆那条、上面那条币种预算，三者取小 */
const addMax = computed(() =>
  Math.max(
    0,
    Math.min(
      // 0.5% 留给手续费（跟后端 `autoShrinkQty` 的 FEE_SLACK 同口径）
      available.value * lev.value * 0.995,
      roomByAccount.value,
      addRoom.value
    )
  )
)

/** 一笔加仓金额 → 数量（按合约精度向下取整） */
function addQty(usdt: number): number {
  const p = refPrice.value
  return p > 0 && usdt > 0 ? floorTo(usdt / p, amountPrecision.value) : 0
}

/** 滑动条当前值对应的**真实**名义价值 / 保证金（取整之后可能比滑到的小一点） */
const addQtyNum = computed(() => addQty(addValue.value))
const addRealNotional = computed(() => addQtyNum.value * refPrice.value)
const addRealMargin = computed(() =>
  lev.value > 0 ? addRealNotional.value / lev.value : 0
)
/** 滑动条已填充的比例（`--fill` 那个 CSS 变量用，`0~100`） */
const addFillPct = computed(() => {
  const lo = addMinCost.value
  const hi = Math.max(lo, addMax.value)
  if (!(hi > lo)) return 0
  return Math.max(0, Math.min(100, ((addValue.value - lo) / (hi - lo)) * 100))
})

/** 滑动条的步长：金额大就粗一点，不然手机上要划半天 */
const addStep = computed(() =>
  addMax.value >= 200 ? 1 : addMax.value >= 20 ? 0.5 : 0.1
)

/**
 * 打开加仓弹层：先把滑动条放在一个**中间偏右**的位置（不是顶格）——
 * 顶格一击就满仓太容易手滑，用户还得自己往回拖。
 */
function openAdd(): void {
  const pos = curPos.value
  if (!pos) {
    say('现在没有持仓，不能加仓')
    return
  }
  if (addBlocker.value) {
    buzz([20, 60, 20])
    say(addBlocker.value)
    return
  }
  const mid = Math.min(addMax.value, Math.max(addMinCost.value, addMax.value * 0.5))
  addValue.value = Math.round(mid * 100) / 100
  addOpen.value = true
}

/** 确认加仓：方向跟持仓一致，数量按滑动条的金额折算 */
async function confirmAdd(): Promise<void> {
  const pos = curPos.value
  if (!pos) return
  const q = addQtyNum.value
  if (!(q > 0)) {
    say('这个金额按合约精度取整之后是 0，再往右滑一点')
    return
  }
  addOpen.value = false
  await submit(pos.side, q, `加仓 ${fmt(addRealNotional.value, 2)} USDT`, true)
  /* 加完立刻重读（数量 / 浮盈 / 额度都要跟着变） */
  loadedKey = ''
  void load()
}

/**
 * 「现在能不能算这一单」的**前置检查**（空 = 没问题）。
 *
 * 额度那几条**不在**这里：加仓不看 5 倍额度（见 `addQuantity`），
 * 所以开仓和加仓各有一份自己的「不能下单」原因（`blocker` / `addBlocker`）。
 */
const preBlocked = computed(() => {
  if (loading.value) return '正在读合约账户…'
  if (!info.value) return '还没连上交易所'
  if (!info.value.ready) return info.value.reason || '现在下不了单'
  /* 余额都没读到就别拿它算仓位 —— 把真正的原因（IP 白名单 / 网络）摆出来 */
  if (info.value.balanceError) return info.value.balanceError
  if (available.value <= 0) return '合约账户没有可用余额（先划转一点保证金）'
  /* 额度是按权益算的，权益读不到就没法算 */
  if (equity.value <= 0) return '读不到账户权益（钱包 + 浮盈），先别开'
  if (!(refPrice.value > 0)) return '还没拿到价格，稍等一下'
  return ''
})

/**
 * **开仓**不能下单的原因（空 = 能下）。
 *
 * ⚠️ 它**不显示在内容区**（用户 2026-10-05：「报错不要占用内容，改用提示」）——
 * 只在点那颗按钮时弹一条 toast 说明为什么没下出去。
 */
const blocker = computed(() => {
  const pre = preBlocked.value
  if (pre) return pre
  /* 这个币 5 倍额度已经开满 —— 想再加只能用浮盈（那两颗加仓按钮） */
  if (fulled.value)
    return (
      `${props.symbol.toUpperCase()} 的 ${ORDER_EQUITY_MAX} 倍额度已经开满` +
      `（已开 ${curNotional.value.toFixed(2)} / 额度 ${fiveNotional.value.toFixed(2)} USDT）` +
      ` —— 想加仓就点下面的「加仓」（用浮盈加，额度另算）`
    )
  /* 额度被别的仓位 / 可用保证金卡住了 */
  if (!(roomNotional.value > 0)) {
    if (roomByAccount.value <= 0)
      return (
        `账户总杠杆已经顶到 ${ACCOUNT_LEV_MAX}x 上限` +
        `（现有持仓名义 ${openNotional.value.toFixed(2)} / 权益 ${equity.value.toFixed(2)}）` +
        ` —— 先平掉一点再开`
      )
    return '现在没有可开的空间（可用保证金不够）'
  }
  const minA = Number(info.value.minAmount ?? 0)
  if (minA && quantity.value < minA)
    return (
      `开不了：剩余额度算出来的量比这个合约的最小下单量` +
      `（${minA} ${base.value}）还小`
    )
  const minC = Number(info.value.minCost ?? 0)
  if (notional.value > 0 && minC && notional.value < minC)
    return `名义价值不够：这一单约 ${notional.value.toFixed(2)} USDT，最少要 ${minC}`
  if (quantity.value <= 0) return '剩余额度算出来的量按精度取整之后是 0'
  return ''
})

/**
 * **加仓**不能下单的原因（空 = 能加）。
 *
 * 跟 `blocker` 的区别就一条：**不看 5 倍额度**（加仓本来就是额度满了以后的事，
 * 后端对「用浮盈加」有单独预算，见 `addRoom`）。
 */
const addBlocker = computed(() => {
  const pre = preBlocked.value
  if (pre) return pre
  if (!opened.value) return '现在没有持仓，不能加仓'
  if (!(refPrice.value > 0)) return '还没拿到价格，稍等一下'
  if (!(addMax.value >= addMinCost.value))
    return (
      `现在能加的空间不到最小下单量` +
      `（${fmt(addMinCost.value, 2)} USDT）—— 先有点浮盈，或者平掉一点`
    )
  if (!(addQty(addMinCost.value) > 0))
    return '按这个合约的精度取整之后是 0'
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

/** 这个仓位的**保证金**（USDT）≈ 名义 ÷ 杠杆 —— 跟币安持仓页那个「保证金」同口径 */
const curMargin = computed(() => {
  const p = curPos.value
  const l = Number(p?.leverage) || lev.value || 1
  return p && l > 0 ? Math.abs(Number(p.notional) || 0) / l : 0
})

const curMarginText = computed(() =>
  curMargin.value > 0 ? fmt(curMargin.value, 2) : '—'
)

/**
 * 浮盈**占保证金的百分比**（仓位卡右上角括号里那个数）。
 * 加仓能加多少是照浮盈金额算的，但「赚了百分之几」才是判断要不要加的那一眼。
 */
const curRoeText = computed(() => {
  const p = curPos.value
  if (!p || !(curMargin.value > 0)) return ''
  const pct = (Number(p.unrealized) / curMargin.value) * 100
  if (!Number.isFinite(pct)) return ''
  return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`
})

/** 强平价（拿不到就是 `—`：逐仓 / 交易所没给这一行） */
const liqText = computed(() => {
  const v = Number(curPos.value?.liquidationPrice ?? 0)
  return v > 0 ? price(v, pricePrecision.value) : '—'
})

/** 「已开」那块里的名义价值（USDT） */
const curNotionalText = computed(() =>
  curNotional.value > 0 ? fmt(curNotional.value, 2) : '—'
)

/** 面板中间那个**大数字**：还能开多少（开满时就是 `0.00`，用户要的就是这个） */
const roomText = computed(() => fmt(Math.max(0, roomNotional.value), 2))


/* ---------------- 顶部：已开的币种（点一下切过去） ---------------- */

/**
 * 账户里**当前有持仓的币种**（用户 2026-10-14：「顶部加上已开的币种，点击可切换」）——
 * 在这只币的 K 线上看到一半、想换到另一只已开的币时，不用再点币种下拉翻。
 *
 * 数据读共享 store（`./positions`，SSE 推，跟「交易所账户」页同源）。
 * ⚠️ 按**基础币**去重：双向持仓时同一个币会有两条（多 / 空），顶部只该出现一枚。
 */
const heldSymbols = computed(() => {
  const seen = new Map<string, {base: string; pnl: number}>()
  for (const p of positionsRows.value) {
    const base = baseOf(p.symbol)
    if (!base) continue
    const hit = seen.get(base)
    if (hit) hit.pnl += Number(p.unrealized) || 0
    else seen.set(base, {base, pnl: Number(p.unrealized) || 0})
  }
  return [...seen.values()]
})

/** 点顶部的币 → 切 K 线（走分析页那套全局币种，跟「合约」页点一行是同一条路） */
function gotoSymbol(base: string): void {
  if (!base || base === String(props.symbol).toUpperCase()) return
  prefetchSymbol(base)
  pickSymbol(base)
  buzz(8)
}

/** 顶部那枚小字：浮盈（正负号 + 短数字） */
function pnlShort(v: number): string {
  if (!Number.isFinite(v) || !v) return ''
  const a = Math.abs(v)
  return `${v > 0 ? '+' : '−'}${a.toFixed(a < 1 ? 2 : 1)}`
}

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
 * **实时杠杆** = 这一单真开下去会占的杠杆 = 本单名义 ÷ 账户权益。
 *
 * 用户 2026-10-14：「右侧显示实时杠杆，**不够 5 倍数就是显示 4.3 这样**」——
 * 额度被可用保证金卡住时（比如只够 5700、权益 1328）就是 `4.3x`，
 * 够满 5 倍权益时就是 `5.0x`。没额度 / 读不到权益时不显示。
 */
const liveLevText = computed(() => {
  if (!(equity.value > 0) || !(notional.value > 0)) return ''
  return `${(notional.value / equity.value).toFixed(1)}x`
})

/* ---------------- 持仓的账本侧信息（已开仓时间 / 已实现盈利） ---------------- */

/**
 * 这一段仓位的**账本侧**信息（开仓时间 / 已实现盈利）。
 *
 * ★ 优先取**持仓流**里带的那一份（`LivePosition.meta`，2026-10-14 加）——
 *   它跟着每一轮持仓推送更新，减完仓的「已实现」不用等下一次 REST；
 *   退路才是打开面板那一次 `/api/exchange/trade` 的 `positionMeta`。
 *   用户：「我需要全部实时」。
 */
const posMeta = computed(
  () => curPos.value?.meta ?? info.value?.positionMeta ?? null
)

/**
 * **已经开了多久**（用户 2026-10-14：「开仓时间是开了多少分钟秒 小时 优化格式」）。
 *
 * 格式按长短分档，越久越粗：
 *   · 不满 1 分 → `42秒`
 *   · 不满 1 时 → `15分32秒`
 *   · 不满 1 天 → `3时05分`
 *   · 更久     → `2天4时`
 * ⚠️ 跟着 `nowTick`（每秒跳）走 —— 直接读 `Date.now()` 模板不会重算，秒数不会动。
 */
const heldText = computed(() => {
  const t = Number(posMeta.value?.openedAt ?? 0)
  if (!(t > 0)) return '—'
  const sec = Math.max(0, Math.floor((nowTick.value - t) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分${pad(sec % 60)}秒`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}时${pad(min % 60)}分`
  return `${Math.floor(hour / 24)}天${pad(hour % 24)}时`
})

/** 完整时间（放 title 里，那格显示的是「开了多久」） */
const openedAtTitle = computed(() => {
  const t = Number(posMeta.value?.openedAt ?? 0)
  if (!(t > 0)) return '本地账本里没有这一段仓位的开仓时间'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `已开仓时间 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())} · 已持仓 ${heldText.value}`
  )
})

/** 已实现盈利（**净**：已实现 − 手续费 + 资金费）；账本没这一段时是 `—` */
const realizedText = computed(() => {
  const m = posMeta.value
  if (!m) return '—'
  const v = Number(m.net) || 0
  return `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), 2)}`
})

/** 已实现盈利是正是负（配色用）；`null` = 没数据 */
const realizedUp = computed(() => {
  const m = posMeta.value
  return m ? (Number(m.net) || 0) >= 0 : null
})

/** 那两项的 `title`：把毛盈亏 / 手续费 / 资金费摊开说清楚 */
const realizedTitle = computed(() => {
  const m = posMeta.value
  if (!m) return '本地账本里没有这一段仓位（开仓可能发生在记账之前）'
  return (
    `已实现 ${fmt(Number(m.realized) || 0, 2)} · 手续费 ${fmt(Number(m.fee) || 0, 2)} · ` +
    `资金费 ${fmt(Number(m.funding) || 0, 2)}` +
    (m.partial ? '（账本不全，这是残值）' : '')
  )
})

/**
 * 自动止损结果 → 提示后面那一小句（`null` / 没开这个功能时是空串）。
 *
 * ⚠️ 手工止损那张**我们没动**，要明说 —— 否则用户以为「自动止损跳过了」= 裸奔，
 *    其实保护还在（只是价是他自己定的那个）。
 */
function autoStopText(r: AutoStopResult | null | undefined): string {
  if (!r) return ''
  if (r.ok && r.skipped === 'unchanged')
    return ` · 自动止损 ${fmt(Number(r.price) || 0, pricePrecision.value)}（已是最新）`
  if (r.ok)
    return (
      ` · 自动止损 ${fmt(Number(r.price) || 0, pricePrecision.value)}` +
      `（覆盖 ${fmt(Number(r.quantity) || 0, amountPrecision.value)} ${base.value}` +
      `${r.replaced ? '，已更新旧单' : ''}）`
    )
  if (r.skipped === 'manual-stop')
    return ` · 自动止损跳过：这个币已有手工止损${
      r.existingPrice ? `（${fmt(Number(r.existingPrice), pricePrecision.value)}）` : ''
    }，没动它`
  if (r.skipped === 'no-position') return ' · 自动止损跳过：没读到仓位'
  if (r.skipped === 'disabled') return ''
  return ` · 自动止损失败：${r.error || '未知原因'}（这一单已成交）`
}

/* ---------------- 数据 ---------------- */

/**
 * 上一份合约账户数据（按 `币种@账户` 存）。
 *
 * ★ 为什么要它（用户 2026-10-14：「**为什么会有加载的过程，能都优化掉**」）：
 *   面板的数据是 `/api/exchange/trade` 现拉的，切一次币就要等一个来回，
 *   这段时间只能摆「正在读合约账户…」。但**同一个币来回切**（尤其是顶栏那排
 *   已开的币种）根本不用重新问一遍 —— 记一份、命中就直接渲染，
 *   后台再静默重读一次（数据不新鲜就自己补上，界面不闪）。
 * ⚠️ 只留最近 6 份，别把一个会话摸过的币全攒着。
 */
const INFO_CACHE_MAX = 6
const infoCache = new Map<string, TradeInfoResult>()

/** 把一份读回来的数据落到面板状态上（缓存命中和真请求都走这里） */
function applyInfo(r: TradeInfoResult): void {
  info.value = r
  if (!r.balanceError) setAvailableBalance(keyId.value, r.balance?.available)
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
}

/**
 * 悄悄把某几个币的合约账户数据**先取回来**（预热缓存）。
 *
 * 顶栏那排「已开的币种」就是用户最常点的几个 ⇒ 提前拉好，点下去**直接出内容**，
 * 不会有「正在读」那一下。失败就拉倒（真要切过去时照常现拉）。
 */
function prefetchInfo(symbols: string[]): void {
  const key = keyId.value
  for (const base of symbols.slice(0, 4)) {
    const sym = String(base).toUpperCase().endsWith('USDT')
      ? String(base).toUpperCase()
      : `${String(base).toUpperCase()}USDT`
    const k = `${sym}@${key ?? ''}`
    if (infoCache.has(k) || sym === exSymbol.value) continue
    void fetchTradeInfo(sym, key)
      .then(r => {
        infoCache.set(k, r)
        while (infoCache.size > INFO_CACHE_MAX)
          infoCache.delete(String(infoCache.keys().next().value))
      })
      .catch(() => {})
  }
}

async function load(): Promise<void> {
  const sym = exSymbol.value
  if (!sym) return
  /*
   * ⚠️ 这里**没有再**把 `info` 清空 —— 缓存命中时先渲染旧的一份（0 等待），
   *    再让下面那次真请求把新数据补上（`applyInfo` 会覆盖它）。
   */
  const k = `${sym}@${keyId.value ?? ''}`
  const cached = infoCache.get(k) ?? null
  const fresh = info.value && k === loadedKey && Date.now() - loadedAt < INFO_FRESH_MS
  if (fresh && info.value) return
  if (cached && info.value !== cached) {
    /* 命中缓存 ⇒ 先渲染，不显示「正在读」 */
    applyInfo(cached)
    loadedKey = k
    loadedAt = 0
  }
  /* 手上已经有这个币的**新旧任一**数据 ⇒ 后台静默重读，不摆「正在读」 */
  loading.value = !info.value && !cached
  if (info.value == null && k === pendingKey && pendingSeq === seq) return
  const my = ++seq
  pendingKey = k
  pendingSeq = my
  try {
    const r = await fetchTradeInfo(sym, keyId.value)
    if (my !== seq) return
    infoCache.set(k, r)
    while (infoCache.size > INFO_CACHE_MAX)
      infoCache.delete(String(infoCache.keys().next().value))
    applyInfo(r)
    loadedKey = k
    loadedAt = Date.now()
    /* 读失败的原因（没配 Key / 现货 / IP 白名单 / 网络）也走提示，不占内容区 */
    if (!r.ready) say(r.reason || '现在下不了单')
    else if (r.balanceError) say(r.balanceError)
  } catch (e) {
    if (my !== seq) return
    if (!info.value) info.value = null
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
  /** 不传 = 用面板算好的那一单（**剩余额度**）；加仓会传自己的量 */
  qtyOverride?: number,
  /** 文案前缀（如「加仓 50%（浮盈）」），只进提示 */
  note = '',
  /**
   * 这一下是**加仓**吗（用浮盈往上加）。
   *
   * ⚠️ 加仓跟开仓的闸**不一样**：加仓不看「5 倍额度」（额度开满本来就是要加仓的前提），
   *    所以这里换用 `addBlocker` 判断 —— 见 `addQuantity` / 后端 `symbolBudget`。
   */
  isAdd = false
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
  const why = isAdd ? addBlocker.value : blocker.value
  if (why) {
    buzz([20, 60, 20])
    say(why)
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
        price: refPrice.value,
        /*
         * 开仓 / 加仓成功后自动挂止损（配置里可关）。
         * ⚠️ 减仓走的是 `/close` 那条路，不带这个 —— 「全部仓位的止损」只在往里开的时候挂。
         */
        autoStop: autoStopOf()
      },
      keyId.value,
      testOrder.value
    )
    if (r.ok && r.order) {
      const o = r.order
      const dir = o.side === 'BUY' ? '做多' : '做空'
      const body = `${dir} ${o.quantity} ${base.value} · 市价`
      /*
       * ★ 开完仓**立刻**重读一次合约账户（用户 2026-10-14：「**开单后界面没有及时换**」）。
       *
       * 为什么原来没换：面板的「已开 / 未开」是照 `/api/exchange/trade` 里的持仓判的，
       * 而那份数据有 `INFO_FRESH_MS` 的保鲜期 + 常驻流最多 20 秒才推一次 ——
       * 刚开完仓那几秒它还是旧的（没持仓），面板自然还停在「开单」那一块。
       * 这里把缓存键清掉（`loadedKey = ''`）逼 `load()` 真去打一次，
       * 持仓一回来就切到「仓位」那一块了。
       */
      loadedKey = ''
      void load()
      void loadPositions()
      /*
       * 顶格差一点保证金时后端会**自动下调数量**重试（见后端 `MAX_AUTO_SHRINK`）——
       * 这事必须说出来：不然用户以为自己开满了 5 倍，实际少开了一点。
       */
      const adj = o.adjusted
        ? ` · 数量已从 ${o.adjusted.from} 自动调到 ${o.adjusted.to}（${o.adjusted.reason}）`
        : ''
      /*
       * 自动止损那一句 —— 现在它**不在这个响应里**了（后端改成后台挂，见上）：挂完会从
       * 常驻流推 `auto-stop` 过来，由上面那个订阅补一条独立提示。
       * 这里仍然读一下 `r.autoStop`：万一哪天又改回同步返回，提示能自动接上。
       */
      const auto = autoStopText(r.autoStop)
      buzz(12)
      say(
        o.test
          ? `测试单通过校验：${note ? `${note} · ` : ''}${body}（没进撮合、没真开仓）${adj}`
          : `已下单${note ? `（${note}）` : ''}：${body}${adj}` +
              (o.orderId ? ` · 单号 ${o.orderId}` : '') +
              auto,
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

/** 列表里那一条的「币」：BTCUSDT → BTC */
function baseOf(symbol: string): string {
  return String(symbol).toUpperCase().replace(/USDT$/, '') || symbol
}

function posQty(p: TradePositionRow): string {
  return `${p.amount.toFixed(Math.min(12, amountPrecision.value))} ${baseOf(p.symbol)}`
}

/** 细节格里那格「数量」只放数字（币种在标题里 / 一眼就知道是这个币），省宽度 */
function posQtyNum(p: TradePositionRow): string {
  return p.amount.toFixed(Math.min(12, amountPrecision.value))
}

function sideText(p: TradePositionRow): string {
  return p.side === 'long' ? '多' : '空'
}

/** 未实现盈亏：正负号 + 金额（跟别处一个写法） */
function pnlText(v: number): string {
  return `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`
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
       * ★ 平完 / 减完**马上重读一次合约账户**（用户 2026-10-14：「平仓后没有及时切换」）——
       *   面板的「已开 / 未开」除了看共享 store，还看这一份（余额、杠杆、精度都在里头），
       *   不重读的话它要等下一次刷新才肯换回「开单」那一块。
       */
      loadedKey = ''
      void load()
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
      /* ★ 全平之后同样马上重读一次合约账户（同上：面板要立刻换回「开单」那一块） */
      loadedKey = ''
      void load()
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

/* ---------------- 跟着币种 / 页面走 ---------------- */

/**
 * 换币：重读这一只的合约账户数据。
 *
 * ⚠️ **不再把 `info` 清空**（用户 2026-10-14：「为什么会有加载的过程，能都优化掉」）：
 *    清空就等于那一瞬间面板没数据可渲染，只能摆「正在读合约账户…」。
 *    现在改成：`load()` 里先看缓存 ——
 *      · 这只币之前读过（来回切 / 顶栏那排已开的币种点一下）⇒ **立刻渲染**，不闪；
 *      · 从没读过 ⇒ 才摆一次「正在读」（这一下是真的要等交易所，省不掉）。
 */
watch(exSymbol, () => {
  seq++
  /*
   * ⚠️ 必须**当场决定**这一只币手上有没有数据可渲染：
   *   · 缓存里有 ⇒ 立刻换上（顶栏那排已开的币种点一下就属于这种，0 等待、不闪）；
   *   · 缓存里没有 ⇒ **必须清空** —— 留着上一只币的数据顶着一看就像「这只币的仓位」，
   *     数字全是别人的（用户看到会以为算错了，真下单时额度也是照错的那份算的）。
   *     这种情况就老老实实摆一次「正在读合约账户…」（那一下是真要等交易所的）。
   */
  const k = `${exSymbol.value}@${keyId.value ?? ''}`
  const cached = infoCache.get(k) ?? null
  if (info.value !== cached) info.value = cached
  loadedKey = cached ? k : ''
  loading.value = !cached
  void load()
})

/*
 * 顶栏那排「已开的币种」变了（开仓 / 平仓 / 换账户）：把它们的合约账户数据**先取回来**，
 * 点的时候直接出内容（见 `prefetchInfo`）。
 */
watch(
  () => heldSymbols.value.map(s => s.base).join(','),
  list => {
    if (props.active && list) prefetchInfo(list.split(','))
  }
)

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
 * ⚠️ 这里原来有一副**左右滑动切「开单 / 仓位」**的手势（`useSwipeTabs`）——
 *    2026-10-14 只有一页了，整副撤掉。`.ord` 上的 `data-no-swipe` **保留**：
 *    没有它，窄屏横划会被「开单分析」那一级 tab 接走（用户 2026-10-06 明确不要）。
 */

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
  }
)

onMounted(async () => {
  /* 先把 Key 列表拿来（`tradeKey` 靠它算），不然第一发会打到默认那套上去 */
  await loadTradeKeys()
  if (props.active) void load()
  /* 顺手把「已开的币种」预热一遍：点顶栏那排时不用等 */
  prefetchInfo(heldSymbols.value.map(s => s.base))
  /*
   * 前后台翻转：回前台**立刻补一次**持仓，并把订阅按当前前后台状态重排
   * —— 切后台就解掉，别在后台一直占着。
   */
  stopForeground = onForegroundChange(() => {
    syncPosTimer()
  })
  stopResume = onNetworkResume(() => {
    if (props.active) void loadPositions()
    syncPosTimer()
  })
  syncPosTimer()
})
</script>

<template>
  <!--
    ⚠️ `data-no-swipe`：窄屏「开单分析」一级 tab 的左右滑动把手势区铺在整个 `.split` 上，
    标上它才不会把这里的横划当成「切一级 tab」（用户 2026-10-06：
    「注意不要滑动切换一级 tab 了」）。
    （原来 `.ord` 自己还吃下横向手势来切「开单 / 仓位」，2026-10-14 只有一页了 ⇒ 撤掉。）
  -->
  <div class="ord" data-no-swipe>
    <!--
      头行（用户 2026-10-14：「去掉仓位界面融合到一个开单」）：
      原来那两格「开单 / 仓位」分段器**整块删掉** —— 现在只有这一页，
      头部只剩「杠杆 · 下单账户 · 一键平仓」。
    -->
    <div class="ord-head">
      <!--
        **已开的币种**（用户 2026-10-14：「顶部加上已开的币种，点击可切换」，
        后面又补一句「**币种切换和杠杆一行**」⇒ 就跟杠杆 / 账户挤在同一行里）。
        点一枚切到那只币的 K 线（跟「合约」页点一行同一条路）；当前这只高亮、带浮盈小字。
        一枚都没有时整块不出现（这一行就只剩杠杆和账户）。
        ⚠️ 它 `flex: 1 1 auto` + `overflow-x: auto`：币多了**自己横向滚**，
           不把杠杆那颗挤到第二行去。
      -->
      <div v-if="heldSymbols.length" class="ord-syms">
        <button
          v-for="s in heldSymbols"
          :key="s.base"
          type="button"
          class="ord-sym"
          :class="{on: s.base === String(symbol).toUpperCase()}"
          :title="`切到 ${s.base} 的 K 线（这个币现在有仓位）`"
          @click="gotoSymbol(s.base)"
        >
          {{ s.base }}
          <i :class="s.pnl >= 0 ? 'up' : 'down'">{{ pnlShort(s.pnl) }}</i>
        </button>
      </div>
      <!-- 杠杆：小标签，点开弹层选（用户 2026-10-14：默认 10 倍、**最高也是 10 倍**） -->
      <button
        type="button"
        class="ghost tiny ord-lev"
        :class="{set: levConfirmed}"
        :title="`杠杆 ${lev}x —— 点一下改（最高 ${maxLev}x）`"
        @click="levOpen = true"
      >
        {{ lev }}x
      </button>
      <!--
        ⚠️ 这里原来挂着一枚常驻的「真单」章（只在「配置 → 测试下单」关掉时出现）。
        用户 2026-10-07：「**提示层真单的那种去掉，都是真单**」「也去掉，那个章现在
        只是噪音」⇒ 整颗删掉。测试单那一档的标记照旧（只有真·测试单才标）。
      -->
      <!--
        当前**下单账户**：这一格用的是哪套交易所 Key。**点一下**开「配置」（那里能换，
        走 `config` 事件给外层页面）。名字是用户自己起的，可能挺长
        ⇒ `.ktag` 自带 `max-width` + 省略号。
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
        ⚠️ 这里原来是「一键平仓」（整账户全平）。用户 2026-10-14：「**右上角一键平仓去掉**」
        ⇒ 整颗删掉（连 `closeAll()` 一起）—— 那个动作仍然在「我的 → 交易所账户」页上，
        而且它平的是**整个账户**，摆在这个「只管当前币」的面板里本来就容易被误触。
      -->
    </div>

    <div class="ord-body">
    <div class="ord-page">
      <!--
        ================= 两种状态**只显示一种** =================
        用户 2026-10-14：「去掉仓位界面融合到一个开单」「区分开，**开单和仓位只能显示一个**，
        加仓在仓位上面」⇒
          · **有仓位** ⇒ 只显示「仓位」那一块：上面一行是「还能开 X + 加仓 50% / 100%」，
            下面那块是这个币的仓位（方向 / 数量 / 均价 / 浮盈 + 平仓 / 全平）；
          · **没仓位** ⇒ 只显示「开单」那一块：还能开多少 + 保证金 / 数量 / 可用 + 做多 / 做空。
        两块互斥（`v-if` / `v-else`），不会再并排堆着让人分不清「已开还是没开」。
      -->

      <!--
        ★ 还没读到这一份数据（切币种 / 切账户那一刻）先摆一行「正在读合约账户…」。
        用户 2026-10-14：「现在切换会跳到未开仓在显示已开，未开是会先显示 0，能优化吗」——
        原因是换币会先把 `info` 清空，面板那一瞬间按「没持仓 + 权益 0」渲染，
        于是先闪一下「能开 0.00 USDT」，等数据回来才切到「仓位」那一块。
        这里用一个**跟两块都长得不一样的占位**盖住那一瞬间（高度也留够，不跳）。
      -->
      <div v-if="reading" class="ord-loading">正在读合约账户…</div>

      <!-- ================= ① 有仓位：只显示仓位 ================= -->
      <template v-else-if="opened && curPos">
        <!--
          这个币的仓位（`curPos`）：左边一条色条按方向绿 / 红 + 一枚「已开」小标，
          右边是数量 / 杠杆 / 浮盈，底下一行是均价 / 价值 + 平仓 / 全平。
        -->
        <div
          class="ord-have open"
          :class="curPos.side === 'long' ? 'long' : 'short'"
        >
          <!--
            首行（用户 2026-10-14）：**方向 + 币种**（「方向旁 币种要加上」）＋ 杠杆；
            右边两行：上面浮动盈亏（含收益率），下面**「已实现」**（用户：「已实现放在未实现
            盈利下面」）。整块**不要背景、不要左侧色条**（用户：「去掉左侧的背景」）——
            方向和币种自己带颜色，够区分了。
          -->
          <div class="ord-have-top">
            <span
              class="ord-have-side"
              :class="curPos.side === 'long' ? 'side-long' : 'side-short'"
              >{{ sideText(curPos) }}</span
            >
            <b class="ord-have-sym">{{ baseOf(curPos.symbol) }}</b>
            <span class="ord-have-lev" title="这个交易对用的杠杆"
              >{{ curPos.leverage }}x</span
            >
            <span class="ord-have-nums">
              <span
                class="ord-have-pnl"
                :class="curPos.unrealized >= 0 ? 'pnl-up' : 'pnl-down'"
                :title="`未实现盈亏：${pnlText(curPos.unrealized)}（占保证金 ${curRoeText || '—'}）`"
                >{{ pnlText(curPos.unrealized) }}
                <i v-if="curRoeText">({{ curRoeText }})</i></span
              >
              <span class="ord-have-real" :title="realizedTitle"
                >已实现
                <b :class="{ok: realizedUp === true, bad: realizedUp === false}"
                  >{{ realizedText }}</b
                ></span
              >
            </span>
          </div>
          <!--
            细节两行（用户：「持有仓位显示一些细节」）：数量 / 开仓 / 标记 / 强平 / 价值 / 保证金。
            ⚠️ 开仓时间挪到**底下一行**（用户：「开仓时间改为已开仓时间和按钮一行」）。
          -->
          <div class="ord-have-grid">
            <!--
              ⚠️ 这几格**不写单位**（用户 2026-10-14：「单位 都去掉」）——
                 标签已经把意思说清了（数量 / 开仓价 / 仓位价值…），
                 单位（USDT / 币种）挂在数字后面只是噪音。数量那边想核对币种看 title。
            -->
            <span class="ord-hd" :title="`持仓数量：${posQty(curPos)}`"
              ><em>数量</em><b>{{ posQtyNum(curPos) }}</b></span
            >
            <span class="ord-hd"
              ><em>开仓价</em
              ><b>{{ price(curPos.entryPrice, pricePrecision) }}</b></span
            >
            <span class="ord-hd"
              ><em>标记价</em
              ><b>{{ price(curPos.markPrice, pricePrecision) }}</b></span
            >
            <span class="ord-hd"><em>强平价</em><b>{{ liqText }}</b></span>
            <span class="ord-hd"
              ><em>仓位价值</em><b>{{ curNotionalText }}</b></span
            >
            <span class="ord-hd"
              ><em>保证金</em><b>{{ curMarginText }}</b></span
            >
          </div>
          <!--
            底下一行：左边**已开仓时间**，右边两颗按钮（用户：「开仓时间改为已开仓时间
            和按钮一行」）。
          -->
          <div class="ord-have-bot">
            <span class="ord-have-meta" :title="openedAtTitle"
              >持仓 <b>{{ heldText }}</b></span
            >
            <!--
              加仓（用户 2026-10-15：「改为一个键位加仓 加仓在平仓左侧，点击加 弹窗显示
              改为可滑动加仓」）—— 一颗按钮，点开是弹层（滑动选加仓金额）。
              ⚠️ 常显、不可用时置灰（用户 2026-10-14：「加仓按钮要显示」）：
                 加不了的时候 `title` 会说清为什么。
            -->
            <button
              type="button"
              class="ghost tiny ord-have-b"
              :disabled="busy || levBusy || !!addBlocker"
              :title="
                addBlocker ||
                `加仓：最多 ${fmt(addMax, 2)} USDT（方向跟持仓一致，可滑动选金额）`
              "
              @click="openAdd()"
            >
              加仓
            </button>
            <button
              type="button"
              class="ghost tiny ord-have-b"
              :disabled="busy || levBusy"
              title="平仓（只平掉一部分）"
              @click="openReduce(curPos)"
            >
              平仓
            </button>
            <button
              type="button"
              class="ghost tiny ord-have-b"
              :disabled="busy || levBusy"
              :title="
                `全平：把 ${symbol.toUpperCase()} 这一条持仓整个平掉` +
                (testOrder ? '（测试单，只校验、不真平）' : '')
              "
              @click="closeOne(curPos)"
            >
              全平
            </button>
          </div>
        </div>
      </template>

      <!-- ================= ② 没仓位：只显示开单 ================= -->
      <template v-else>
        <!--
          开多大：**只显示这一块**（没持仓的时候）。大号数字 = 「能开」多少 =
          `min(5 × 权益, 可用 × 杠杆)`，开不满时就说清是谁把它卡小了。
        -->
        <!--
          这一格（用户 2026-10-14：「**能开（xxx）字样去掉**，右侧显示**实时杠杆**，
          不够 5 倍数就是显示 4.3 这样，**下面一大段字去掉**」）：
          一行放下「能开多少 + 实时杠杆」，别的字都不要 —— 面板整体要**一屏放得下**。
          实时杠杆 = 本单名义 ÷ 权益，额度被可用保证金卡住时就是 4.3x 这种。
        -->
        <div class="ord-quota">
          <!-- 用户 2026-10-14：「价值那一行…加上文字，**当前可开价值**」 -->
          <span class="ord-quota-lb">当前可开价值</span>
          <span class="ord-quota-row">
            <b class="ord-quota-num">{{ roomText }}<i>USDT</i></b>
            <span
              v-if="liveLevText"
              class="ord-lev-live"
              :class="{warn: levAfterWarn}"
              :title="
                `实时杠杆 ${liveLevText}（本单 ${notionalText} ÷ 权益 ${equityText}）` +
                ` · 上限 ${ORDER_EQUITY_MAX} 倍权益` +
                (levAfterText
                  ? ` · 成交后账户总杠杆 ${levAfterText}（上限 ${ACCOUNT_LEV_MAX}x）`
                  : '')
              "
            >
              <em>实时杠杆</em>{{ liveLevText }}
            </span>
          </span>
          <!--
            数量当**一行小字**贴在价值下面（用户 2026-10-14：「数量不用单独一个，
            用小字放在下面就行」）—— 它是这一单「买多少」，跟着价值看最顺。
          -->
          <span class="ord-quota-sub"
            >数量 <b>{{ quantityText }}</b
            ><i v-if="quantityText !== '—'">{{ base }}</i></span
          >
        </div>

        <!--
          下面两格：**所需保证金 / 账户可用**（两列并排）——
          高度**不随数值变**（用户 2026-10-05：「下单区域高度固定」，上面的 K 线不能被顶来顶去）。
          ⚠️ 报错**不放这儿**（用户：「报错不占用内容」）—— 真正的原因都在点下单时弹提示。
        -->
        <div class="ord-read">
          <!-- 用户 2026-10-14：「占用改为**所需保证金**」 -->
          <span class="ord-r"
            ><em>所需保证金</em
            ><b>{{ marginText }}<i>USDT</i></b></span
          >
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
            <em>账户可用</em>
            <b :class="{empty: ready && available <= 0}"
              >{{ availableText }}<i>USDT</i></b
            >
          </span>
        </div>

        <!-- 底下那一行：两颗下单按钮（做多 / 做空），铺满整行 -->
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
            ⚠️ 额度是 0 时它们**照样能点**（点了弹一句说明为什么开不了），
               禁用着不解释反而让人不知道卡在哪（用户 2026-10-05 定的）。
          -->
          <button
            type="button"
            class="ord-submit long"
            :disabled="busy || levBusy || locked"
            :title="
              locked
                ? `${symbol.toUpperCase()} 在黑名单里：还有 ${lockText(banLeft)} 才能开单`
                : `做多（买入开仓）· 能开 ${roomText} USDT`
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
                : `做空（卖出开仓）· 能开 ${roomText} USDT`
            "
            @click="submit('short')"
          >
            {{ busySide === 'short' ? '提交中…' : '做空' }}
          </button>
        </div>
      </template>
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

    <!--
      加仓弹层（用户 2026-10-15：「点击加 弹窗显示 改为可滑动加仓」）：
      滑动条滑的是**加仓金额（USDT 名义价值）**，上限是「可用保证金 / 账户总杠杆 /
      这个币的预算（5×额度剩余 或 浮盈×杠杆）」三者取小。
    -->
    <Teleport to="body">
      <div v-if="addOpen" class="sheet-mask" @click="addOpen = false" />
      <section v-if="addOpen" class="sheet" role="dialog" aria-label="加仓">
        <header class="sheet-head">
          <b>加仓 {{ symbol.toUpperCase() }}</b>
          <button
            type="button"
            class="ghost tiny"
            title="关掉"
            @click="addOpen = false"
          >
            ✕
          </button>
        </header>
        <p class="sheet-text">
          方向和持仓一致（{{ curPos ? sideText(curPos) : '' }}）· 最多
          <b>{{ fmt(addMax, 2) }} USDT</b>
          <span class="dim">（可用保证金 / 总杠杆 / 这个币的预算取最小）</span>
        </p>
        <label class="ord-field ord-slider">
          <span>{{ fmt(addValue, 2) }}</span>
          <span class="ord-bar">
            <input
              v-model.number="addValue"
              type="range"
              :min="addMinCost"
              :max="Math.max(addMinCost, addMax)"
              :step="addStep"
              :style="{'--fill': addFillPct + '%'}"
              :title="`加仓 ${fmt(addValue, 2)} USDT`"
            />
          </span>
        </label>
        <p class="tr-avail">
          约
          <b>{{ addQtyNum.toFixed(Math.min(12, amountPrecision)) }}</b>
          {{ base }} · 保证金 <b>{{ fmt(addRealMargin, 2) }}</b> USDT
          <span class="dim">（浮盈 {{ fmt(posProfit, 2) }} USDT）</span>
        </p>
        <button
          type="button"
          class="tr-go"
          :disabled="busy || !(addQtyNum > 0)"
          :title="testOrder ? '测试加仓（只校验）' : '加仓'"
          @click="confirmAdd()"
        >
          {{ busy ? '提交中…' : testOrder ? `测试加仓 ${fmt(addValue, 2)}` : `加仓 ${fmt(addValue, 2)} USDT` }}
        </button>
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
