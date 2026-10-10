<script setup lang="ts">
/**
 * K 线块**顶部**那条行情（币安期货页顶部那种排法）：
 *
 *   左 = 币种（下拉，外层用 #symbol 插进来）
 *   中 = 现价（大字）+ 24h 涨跌额 / 涨跌幅 + 24h 位置条
 *   右 = 成交额 / 资金费率
 *
 * 数据来自「../ticker」（15 秒刷一次），拿不到就显示「—」，不挡页面。
 */
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import {bjTime, fixed, fmt, price} from '../format'
import {lockLeftMs, lockText, lockUntilOf} from '../blacklist'
import {freshLivePrice, nowTick, ticker} from '../ticker'
import {priceDigitsOf} from '../store'

const props = defineProps<{symbol: string}>()

/** 涨了绿、跌了红 —— 跟图上蜡烛一套 */
const tone = computed(() => {
  const v = ticker.value?.change24hPct
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return ''
  return Number(v) >= 0 ? 'up' : 'down'
})

/**
 * 现价。
 *
 * ★ 优先用 **K 线 WS 推来的实时价**（秒级），拿不到才退回 15 秒那份轮询 ——
 * 用户 2026-10-03：「价格颜色跟随当前行情变化闪动」，15 秒才动一次是闪不起来的。
 * 两边都是「现价」同一个东西，不存在对不上的问题。
 */
const last = computed(() => freshLivePrice.value ?? ticker.value?.last ?? null)

/**
 * 价格显示几位小数 —— 跟合约 `tickSize` 走（见 `store.priceDigitsOf`）。
 *
 * ⚠️ 这里原来直接用 `fmt()`，而 `fmt` 会把整数价格的小数位吃掉 ⇒ 同一行里出现
 *    「24h 低 84,910 · 高 86,976.1」（用户 2026-10-06：「精度没统一」）。
 *    现价 / 涨跌额 / 24h 高低一律走下面这个 `pxText`，位数就齐了。
 * 合约表还没到 → 退回按现价的量级猜（跟 `fmt` 一个口径）。
 */
const priceDigits = computed(() => priceDigitsOf(props.symbol, last.value))

/** 价格文案 */
function pxText(v: unknown): string {
  return price(v, priceDigits.value)
}

const lastText = computed(() => pxText(last.value))

/**
 * 价格跳一下。
 *
 * **闪的颜色跟的是这一跳的方向**（往上跳闪绿、往下跳闪红），不是 24h 涨跌 ——
 * 所以 24h 明明是绿的，往下跳那一下也会红一下，跟交易所一个感觉。
 * CSS 那边靠 `--tk-base`（基色）实现「从跳的色淡回基色」。
 *
 * ⚠️ 不加阴影（用户 2026-10-03：「闪动不要加阴影」）—— 只改颜色 + 一点亮度。
 *
 * ⚠️ 连着两次同一个方向时，光把 class 设成同一个值**不会重新播动画**，
 * 所以先清空、下一帧再设，强制它从头播。
 */
const blip = ref<'' | 'up' | 'down'>('')
let prevPrice = 0
let blipTimer: ReturnType<typeof setTimeout> | null = null

function fire(dir: 'up' | 'down'): void {
  blip.value = ''
  requestAnimationFrame(() => (blip.value = dir))
  if (blipTimer) clearTimeout(blipTimer)
  blipTimer = setTimeout(() => (blip.value = ''), 800)
}

watch(last, v => {
  const n = Number(v)
  if (!Number.isFinite(n)) return
  if (prevPrice && n !== prevPrice) fire(n > prevPrice ? 'up' : 'down')
  prevPrice = n
})

onBeforeUnmount(() => {
  if (blipTimer) clearTimeout(blipTimer)
})

/**
 * 涨跌额与涨跌幅**分开**（原来是拼成一串「739.7  +0.86%」）：
 * 拆开才能各自排版 —— 额度淡一点、百分比加粗，读数更有层次。
 * 正数显式带 `+`（以前不带，跟下面那颗百分比对不齐，看着像缺了一块）。
 */
const changeAbs = computed(() => {
  const v = ticker.value?.change24h
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  return `${n >= 0 ? '+' : ''}${pxText(n)}`
})

const changePct = computed(() => {
  const v = ticker.value?.change24hPct
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  return `${n >= 0 ? '+' : ''}${fixed(n, 2)}%`
})

/**
 * 现价落在 24h 区间（最低 ~ 最高）里的位置，0~100。
 * 拿不到、或高低相等 → null（那一小条整个不画，不画一条假的）。
 */
const rangePos = computed<number | null>(() => {
  const d = ticker.value
  const hi = Number(d?.high24h)
  const lo = Number(d?.low24h)
  // 用「现价」（含实时价）—— 这样那条位置条也跟着行情实时走
  const px = Number(last.value)
  if (![hi, lo, px].every(n => Number.isFinite(n)) || hi <= lo) return null
  return Math.min(100, Math.max(0, ((px - lo) / (hi - lo)) * 100))
})

const rangeTitle = computed(() => {
  const d = ticker.value
  return `24h 低 ${pxText(d?.low24h)} · 高 ${pxText(d?.high24h)}`
})

/** 成交额：中文量级，别糊一长串数字 */function big(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return fmt(n, 0)
}

/** 资金费率：0.0001 → 0.01000%（跟交易所一样留 5 位） */
const fundingText = computed(() => {
  const r = ticker.value?.fundingRate
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return '—'
  return `${fixed(Number(r) * 100, 5)}%`
})

/** 下一次结算倒计时 hh:mm:ss */
const countdown = computed(() => {
  const at = ticker.value?.nextFundingAt
  if (!at) return ''
  const left = at - nowTick.value
  if (left <= 0) return '结算中…'
  const s = Math.floor(left / 1000)
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
})

const fundingLabel = computed(() => {
  const h = ticker.value?.fundingIntervalHours
  return h ? `资金费率 (${h}时)` : '资金费率'
})

/**
 * 右侧那两块（两行）。
 *
 * ★ 2026-10-05 用户精简：
 *   · 原来 8 项（标记价格 / 24h 高低 / 指数价格 / 成交量 / 成交额 / 持仓量 / 资金费率）
 *     → 只剩 **成交额 + 资金费率**；价格在中间那颗大字里，其余与下单无关
 *   · 多周期涨幅那一行原本在图**底部**（`#bottom` 插槽），现在挪到这块的上面
 *     （底下让给下单模块了）
 */
const rows = computed(() => {
  const d = ticker.value
  return [{k: '24h成交额', v: big(d?.quoteVolume24h)}]
})

/**
 * **黑名单倒计时**（用户 2026-10-10）：「加入黑名单后 24 小时不得开单，**右侧显示倒计时**」。
 *
 * 就摆在价格那一行的右端（MM 徽章那一排）—— 在 K 线上看盘时一眼能看到还剩多久。
 *
 * ⚠️ 跟着 `nowTick`（每秒跳）走：在这里直接读 `Date.now()` 的话模板不会重算，
 *    那串数字会定住不动。
 */
const lockLeft = computed(() => lockLeftMs(props.symbol, nowTick.value))
const lockLabel = computed(() => lockText(lockLeft.value))
const lockTitle = computed(() => {
  const until = lockUntilOf(props.symbol)
  return (
    `${props.symbol.toUpperCase()} 在黑名单里：还有 ${lockLabel.value} 才能开单` +
    (until > 0 ? `（约 ${bjTime(until)} 解锁）` : '')
  )
})
</script>

<template>
  <div class="tk-head">
    <div class="tk-left">
      <slot name="symbol" />
      <!--
        以前这儿还有个「永续 / 币本位永续 / 现货」的小标签，用户 2026-10-03 说去掉：
        「永续字样去掉」——全站就是 U 本位永续，写着是废话。
        （`typeTag` 那个 computed 一起删了，别留死代码。）
      -->
      <!--
        外层可以再塞东西（窄屏把「分析 / ＋ / 配置」摆这儿）。
        ⚠️ 包一层 `.tk-actions` 才能把**一整组**顶到最右边（光给最后一颗加 auto 会把 ＋ 落在半路）。
      -->
      <span class="tk-actions"><slot name="actions" /></span>
    </div>

    <div class="tk-mid" :class="tone">
      <div class="tk-price">
        <!-- 价格：跟行情染色 + 每跳一下闪一下（背景块已按用户要求去掉） -->
        <span class="tk-last" :class="[tone, blip && 'blip-' + blip]">
          {{ lastText }}
        </span>
        <span class="tk-chip">
          <svg class="tk-arrow" viewBox="0 0 10 6" aria-hidden="true">
            <path :d="tone === 'down' ? 'M0 0h10L5 6z' : 'M5 0l5 6H0z'" />
          </svg>
          <span class="tk-delta">{{ changeAbs }}</span>
          <b>{{ changePct }}</b>
        </span>
        <!--
          **黑名单倒计时**（用户 2026-10-10）：「加入黑名单后 24 小时不得开单，右侧显示倒计时」。
          跟 MM 徽章同一排（价格那一行的右端）—— 看盘时一眼看到还剩多久。
          ⚠️ 秒表跟着 `nowTick` 走（见上面 `lockLeft`），别改成自己读 `Date.now()`。
        -->
        <span v-if="lockLeft > 0" class="tk-lock" :title="lockTitle">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M7.5 10V7.2a4.5 4.5 0 0 1 9 0V10"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
            <rect
              x="4.5"
              y="10"
              width="15"
              height="10.5"
              rx="2.2"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            />
          </svg>
          <b class="num">{{ lockLabel }}</b>
        </span>
        <!--
          价格这一行的**最右边**（谁给内容由外层插槽决定，这个组件本身不认得具体徽章）——
          2026-10-07 用户：「mm放在 下面最右侧和价格那一排」：MM 保证金率就摆这儿。
          ⚠️ 位置是 `.tk-price` 的右端（`margin-left: auto`），不是币种那一行。
        -->
        <slot name="price-end" />
      </div>
      <!--
        ⚠️ 这一条**永远占着位置**（用户 2026-10-10：「k 线的 24 小时柱状条要给个占位」）：
           行情还没到 / 高低相等时只留**空的那条轨道** —— 一条横杠，不填满、不放现价点、
           也不写「—」。以前是整块不渲染 ⇒ 顶部这块高度跳一下（价格那几行跟着窜）。
      -->
      <div
        class="tk-range"
        :title="rangePos === null ? '24h 高低还没取到' : rangeTitle"
      >
        <span class="tk-range-label">24h</span>
        <span class="tk-range-track">
          <template v-if="rangePos !== null">
            <i class="tk-range-fill" :style="{width: rangePos + '%'}" />
            <em class="tk-range-dot" :style="{left: rangePos + '%'}" />
          </template>
        </span>
      </div>
    </div>

    <!-- `.tk-right` 把两项统计作为一个整体右对齐。 -->
    <div class="tk-right">
      <div class="tk-stats">
        <div v-for="r in rows" :key="r.k" class="tk-item">
          <span class="k">{{ r.k }}</span>
          <span class="v">{{ r.v }}</span>
        </div>
        <!-- 资金费率 + 倒计时摆一格，跟交易所一样 -->
        <div class="tk-item">
          <span class="k">{{ fundingLabel }}</span>
          <span class="v">
            <em class="tk-fund">{{ fundingText }}</em>
            <template v-if="countdown"> / {{ countdown }}</template>
          </span>
        </div>
      </div>
    </div>
    <!--
      ⚠️ 这里**不放报错文字**（用户 2026-10-03：「合约搜索没有 前端不要提示报错文字」）。
      用户边打字边筛合约时，每敲一个字都会去拉一次行情，搜到不存在的那只必然报错——
      这时候蹦一行红字毫无用处。取不到就把各格显示成「—」，不挡页面。
    -->
  </div>
</template>
