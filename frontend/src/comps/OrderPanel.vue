<script setup lang="ts">
/**
 * K 线页底部的**合约下单模块**（2026-10-05）。
 *
 * 用户原话：「在 k 线页面底部新增下单模块，多空 / 滑动条 / 余额 / 杠杆；
 * 下单模式就两种，默认市价和限价」。之后又定了几条样式：
 *   · **报错一律走提示（toast），不占内容区**（顶部中间、3.5 秒自动关）
 *   · 杠杆挪到「市价 / 限价」旁边当**小标签**，点开弹层选（默认 10x，最高 20x）
 *   · 仓位按 **USDT** 算 / 显示
 *   · 仓位滑动条**每 25% 一个节点**，带阻尼 + 过节点震一下
 *   · 做多 / 做空合成**一个按钮**，方向用旁边的开关切
 *
 * ★ 下单走的是币安的**测试接口**（`/fapi/v1/order/test`，用户 2026-10-05 定的）：
 *   只校验参数 / 权限 / 保证金，**不进撮合、不真开仓** —— 所以模块里写着「测试单」。
 *   以后要放开真下单，是后端换接口名的事，这里把「测试单」那几个字一起去掉即可。
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
  fetchTradeInfo,
  placeTestOrder,
  setTradeLeverage,
  type TradeInfoResult
} from '../api'
import {fmt} from '../format'
import {contracts} from '../store'
import {freshLivePrice, ticker} from '../ticker'

const props = defineProps<{
  /** 当前币种（基础币，如 BTC） */
  symbol: string
  /** 这一页是不是当前页 —— 切走再回来要重新读一次余额 */
  active: boolean
}>()

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

/** 市价（默认）/ 限价 */
const mode = ref<'market' | 'limit'>('market')
/** 方向：做多 / 做空 —— 只决定那颗按钮叫什么、什么颜色 */
const side = ref<'long' | 'short'>('long')
/** 仓位：占可用余额的百分比（滑动条的值，已经过阻尼） */
const pct = ref(0)
/** 杠杆：用户 2026-10-05 定「默认 10 倍、最高 20 倍」 */
const lev = ref(10)
const priceInput = ref('')
/** 杠杆选值弹层开着没 */
const levOpen = ref(false)

/* ---------------- 提示（toast）：报错 / 结果一律走这儿，不占内容区 ---------------- */

const TOAST_MS = 3500

const toast = ref<{text: string; tone: 'ok' | 'bad'} | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

/** 弹一条提示，3.5 秒后自己关（再弹一条会把计时重置） */
function say(text: string, tone: 'ok' | 'bad' = 'bad'): void {
  toast.value = {text, tone}
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), TOAST_MS)
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
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
const levOptions = computed(() =>
  LEV_STEPS.filter(v => v <= Math.min(20, exchangeMaxLev.value))
)
const maxLev = computed(() => levOptions.value[levOptions.value.length - 1] ?? 10)

/**
 * 交易所报的杠杆落到哪个档位上。
 *
 * 用户 2026-10-05 定「**默认 10 倍**、最高 20 倍」：
 *   · 读不到（没配 Key / 读失败）→ 就用 **10**
 *   · 读到但**不在档位里**（比如 8x、50x）→ 取不超过它的最大档
 *     （50x → 20x，因为上限就是 20；8x → 5x）
 * ⚠️ 这种情况**不算「确认过」**（见下面 `levConfirmed`）：面板显示 5x 而交易所是 8x
 *    就是骗人，所以下单前会真把它设成显示的那个值。
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

/** 算数量用的参考价：限价单用自己的委托价，市价单用标记价 */
const refPrice = computed(() =>
  mode.value === 'limit' ? priceNum.value : markRef.value
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
  if (mode.value === 'limit' && !(priceNum.value > 0)) return '限价单要先填价格'
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
  const my = ++seq
  loading.value = true
  try {
    const r = await fetchTradeInfo(sym)
    if (my !== seq) return
    info.value = r
    /*
     * 杠杆：交易所报的那个值如果在档位里就直接用它（那是事实）；
     * 不在档位里 / 读不到 → 落到最接近的档位（默认 10x），并且**标记成没确认**，
     * 下单前会真设一次，免得「面板写 5x、交易所其实 8x」。
     */
    const l = Math.floor(Number(r.leverage ?? 0))
    lev.value = fitLeverage(l)
    levConfirmed.value = l >= 1 && levOptions.value.includes(l)
    if (!priceInput.value) prefillPrice()
    /* 读失败的原因（没配 Key / 现货 / IP 白名单 / 网络）也走提示，不占内容区 */
    if (!r.ready) say(r.reason || '现在下不了单')
    else if (r.balanceError) say(r.balanceError)
  } catch (e) {
    if (my !== seq) return
    info.value = null
    say((e as Error).message)
  } finally {
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
    const r = await setTradeLeverage(exSymbol.value, want)
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
    const r = await setTradeLeverage(exSymbol.value, Math.floor(lev.value))
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

async function submit(): Promise<void> {
  if (busy.value || levBusy.value) return
  /* 报错统一走提示：先把「为什么下不了」弹出来，不占内容区 */
  if (blocker.value) {
    buzz([20, 60, 20])
    say(blocker.value)
    return
  }
  busy.value = true
  try {
    if (!(await ensureLeverage())) {
      buzz([20, 60, 20])
      return
    }
    const r = await placeTestOrder({
      symbol: exSymbol.value,
      side: side.value,
      type: mode.value,
      quantity: quantity.value,
      // 市价单也带上参考价：后端拿它做「最小名义价值」的体检（不发给交易所）
      price: refPrice.value
    })
    if (r.ok && r.order) {
      const o = r.order
      const dir = o.side === 'BUY' ? '做多' : '做空'
      const px = o.type === 'LIMIT' ? `限价 ${fmt(o.price)}` : '市价'
      buzz(12)
      say(
        `✅ 测试单通过校验：${dir} ${o.quantity} ${base.value} · ${px}` +
          '（没进撮合、没真开仓）',
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
  }
)

/* 切到限价：价格空着就先填上标记价 */
watch(mode, m => {
  if (m === 'limit' && !(priceNum.value > 0)) prefillPrice()
})

onMounted(() => {
  if (props.active) void load()
})
</script>

<template>
  <div class="ord">
    <div class="ord-head">
      <b class="ord-title">下单</b>
      <span class="tag" title="只提交到币安的测试接口，不进撮合、不真开仓">
        测试单
      </span>
      <div class="seg ord-mode">
        <button
          type="button"
          :class="{active: mode === 'market'}"
          title="市价：按对手价立刻成交"
          @click="mode = 'market'"
        >
          市价
        </button>
        <button
          type="button"
          :class="{active: mode === 'limit'}"
          title="限价：挂在指定价格上等成交"
          @click="mode = 'limit'"
        >
          限价
        </button>
      </div>
      <!-- 杠杆：小标签，点开弹层选（用户 2026-10-05：默认 10 倍、最高 20 倍） -->
      <button
        type="button"
        class="ghost tiny ord-lev"
        :class="{set: levConfirmed}"
        :title="`杠杆 ${lev}x —— 点一下改（最高 ${maxLev}x）`"
        @click="levOpen = true"
      >
        {{ lev }}x
      </button>
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
        「重试」不放在这一行 —— 它只在读不到余额时出现，放在行里会让整个行情头
        多占一行（用户 2026-10-05：「下单区域高度固定」）。挪到下面跟下单按钮同一行，
        那一行本来就够高，露不露都不改高度。
      -->
      <span class="ord-avail">        可用 <b>{{ availableText }}</b> USDT
      </span>
    </div>

    <label class="ord-field ord-price">
      <span>价格</span>
      <!--
        市价模式下**不显示**那个参考价（留占位符「市价」）：
        输入框是禁用的，里面却顶着一个数，看着像「这一单会按这个价成交」。
        限价模式才把 `priceInput` 摆出来 —— 切回市价时值留着，切回来不用重填。
      -->
      <input
        :value="mode === 'limit' ? priceInput : ''"
        inputmode="decimal"
        :disabled="mode === 'market'"
        :placeholder="mode === 'market' ? '市价' : '限价'"
        @input="onPriceInput"
      />
      <!--
        「现价」只在限价模式露面。
        ⚠️ 它以前挤在「价格 + 数量」并排那一格里，手机上根本放不下（用户 2026-10-05）
        —— 现在「数量」挪到杆子下面了，这一行整行都是价格的，按钮自然有位置。
      -->
      <button
        v-if="mode === 'limit'"
        type="button"
        class="ghost tiny ord-fill"
        title="用最新成交价填进去"
        @click="useLast"
      >
        现价
      </button>
    </label>
    <!-- 仓位：按 USDT 算（用户 2026-10-05）—— 每 25% 一个节点，带阻尼 + 震动 -->
    <label class="ord-field ord-slider ord-pos">
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
        ><em>名义价值</em><b>{{ notionalText }} USDT</b></span
      >
    </div>

    <!-- 右侧：方向开关 + 那颗下单按钮（用户：「做多做空放右侧」） -->
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
      <div class="seg ord-side">
        <button
          type="button"
          class="long"
          :class="{active: side === 'long'}"
          title="做多（买入开仓）"
          @click="side = 'long'"
        >
          做多
        </button>
        <button
          type="button"
          class="short"
          :class="{active: side === 'short'}"
          title="做空（卖出开仓）"
          @click="side = 'short'"
        >
          做空
        </button>
      </div>
      <button
        type="button"
        class="ord-submit"
        :class="side"
        :disabled="busy || levBusy"
        @click="submit"
      >
        {{
          busy ? '提交中…' : side === 'long' ? `做多 ${base}` : `做空 ${base}`
        }}
      </button>
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

    <!-- 提示：3.5 秒自己关；点一下也关。⚠️ z-index 要压过弹层（见 style.css） -->
    <Teleport to="body">
      <div
        v-if="toast"
        class="toast ord-toast"
        :class="toast.tone"
        title="点一下关掉"
        @click="toast = null"
      >
        {{ toast.text }}
      </div>
    </Teleport>
  </div>
</template>
