<script setup lang="ts">
/**
 * 「交易所资产」面板 —— **移动端优先**（用户 2026-10-05：先设计移动端界面）。
 *
 * 范围（用户 2026-10-05 追加了现货）：
 *   · USDT 合约（USDⓈ-M）`fapi/v2/account` + `fapi/v2/positionRisk`
 *   · C2C 钱包 `sapi/v1/asset/wallet/balance?needBalanceDetail=true`
 *   · 现货 —— **只算 USDT 一个数**（用户：「现货统计也加上，只要 usdt 的统计简单化」）
 *   ⇒ 老版那套「按币种估值的现货余额列表」仍然是删掉的状态：别的币种不折价、不进净值。
 *
 * 排版（手机一屏从上往下）：
 *   ① **净资产** = 合约保证金余额 + C2C + 现货 USDT（一个大数 + 占比条 + 分解行）
 *   ② 合约明细四格：钱包余额 / 未实现盈亏 / 可用 / 占用
 *   ③ **仓位统计**：名义总额、未实现盈亏、多空占比条（用户要的「统计仓位」）
 *   ④ 二级 tab：持仓 / 挂单 / 盈亏 / 成交 / 资产明细
 *   ⑤ tab 内容（卡片行）
 *
 * ⚠️ **组件是纯展示的**：数据全走 props（自己不发请求）⇒ 真数据由
 *    `ExchangeAccountLivePanel.vue` 传进来。
 *    （「划转」那颗按钮也只 `emit('transfer')`，弹层和取数都在容器那一层。）
 * ⚠️ 顶部的「几分钟前」是**架构的一部分**：先渲染上一份快照、后台再刷新，
 *    所以界面上必须让用户看到「这份数据有多旧」，而不是空等一个 loading。
 */
import {computed, defineAsyncComponent, ref} from 'vue'
import {
  type CurvePoint,
  type ExchangeIncomeRow,
  type ExchangeOpenOrder,
  type ExchangeOverview,
  type ExchangeTrade
} from '../api'
import {bjTime, fixed, fmt} from '../format'
import {exchangeCurrency} from '../settings'
import SegTabs from './SegTabs.vue'

/**
 * 曲线用 echarts（~580KB），**单独一个 chunk 异步载**：
 * `/analyze` 是主包里的静态路由，直接 import 会让 echarts 进主包，
 * 连只看「合约」页的人都得替它付费。而这块面板本身是 `v-else-if` 挂的，
 * 所以只有真的点开「交易所账户」时才会去下载。
 */
const ExchangeCurveChart = defineAsyncComponent(
  () => import('./ExchangeCurveChart.vue')
)

const props = defineProps<{
  data: ExchangeOverview | null
  /** 挂单是**打交易所按需查**的（慢），单独传（可能还没拉到 / 单独失败） */
  openOrders?: ExchangeOpenOrder[]
  /** 成交/盈亏来自**后端账本**（WS 实时落 + 断线后 REST 补） */
  trades?: ExchangeTrade[]
  income?: ExchangeIncomeRow[]
  /** 挂单正在拉（慢接口，单独转圈） */
  loadingOrders?: boolean
  /** 正在刷新快照（⟳ 转圈 + 禁点） */
  refreshing?: boolean
  /**
   * 「没有数据」的原因（现货 / 还没采过 / 这些账户都没数据）。
   * ⚠️ 有值时把底部的转圈换成这句话 —— 不然「取不到数据」会一直转下去。
   */
  reason?: string
  /**
   * 顶部那排账户 tab 的选项：`全部` + 每套 Key 的名字（**只有一套时外层就不传 tab**，
   * 退化成原来那个名字标签）。
   * ⚠️ 纯展示：切换只往上 emit，重新取数由外层负责。
   */
  accounts?: {value: string; label: string}[]
  /** 当前选中的那一格（`'all'` 或 key id 的字符串形式） */
  modelValue?: string
  /** 净资产曲线（“快照序列 → 图”，可能还没攒够点） */
  curve?: CurvePoint[]
  /** 当前跨度：1d / 7d / 30d（受控） */
  curveRange?: string
  /** 后端用的桶宽（秒）—— 算「断档」要靠它 */
  curveBucketSec?: number
  /** 美元 → 人民币汇率（USDT / CNY 切换用；拿不到就退回 7.1） */
  rate?: number
  /** 正在提交「减仓 / 平仓」（按钮转圈 + 禁点） */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'update:modelValue', id: number): void
  (e: 'update:curveRange', range: string): void
  /** 点「划转」——弹层由外层（LivePanel）挂，它才知道当前是哪套 Key */
  (e: 'transfer'): void
  /** 点「减仓」——弹层由外层挂（选百分比 → 调接口） */
  (e: 'reduce', pos: PositionRef): void
  /** 点「平仓」——同样交给外层（它知道是哪套 Key） */
  (e: 'close', pos: PositionRef): void
}>()

/** 交给外层的「这是哪一条持仓」——带着 keyId，外层才知道用哪套 Key 去平 */
export interface PositionRef {
  symbol: string
  side: 'long' | 'short'
  keyId?: number
  keyName?: string
}

/** tab 选中的那一格（`'all'` / key id 字符串）：只读 prop，切换往上 emit */
const picked = computed({
  get: () => props.modelValue ?? '',
  set: (v: string) => emit('update:modelValue', v)
})
/** 只有一套 key 时不渲染 tab，退化成原来那个名字标签 */
const showAcctTabs = computed(() => (props.accounts?.length ?? 0) > 1)
const acctLabel = computed(() => props.accounts?.[0]?.label ?? '')

const acct = computed(() => props.data?.account ?? null)
const fx = computed(() => props.data?.futures ?? null)
const c2c = computed(() => props.data?.c2c ?? null)
/** 现货（只 USDT）；老快照 / 没权限时是 null */
const spot = computed(() => props.data?.spot ?? null)
const stats = computed(
  () =>
    props.data?.stats ?? {
      longCount: 0,
      shortCount: 0,
      notional: 0,
      unrealized: 0
    }
)
const positions = computed(() => props.data?.futures?.positions ?? [])

/* ---------------- ① 净资产 = 合约保证金余额 + C2C + 现货 USDT ---------------- */

/** 合约那边的「钱」用的是**保证金余额**（= 钱包 + 浮盈），不是钱包余额 */
const futuresValue = computed(() => fx.value?.margin ?? 0)
const c2cValue = computed(() => c2c.value?.totalUsdt ?? 0)
/** 现货只算 USDT 那一个数（用户 2026-10-05：「只要 usdt 的统计简单化」） */
const spotValue = computed(() => spot.value?.usdt ?? 0)
/* ⚠️ 三项相加的口径必须跟后端 `netOf()` / `listCurve()` 完全一致，不然曲线对不上 */
const netValue = computed(
  () => futuresValue.value + c2cValue.value + spotValue.value
)
function pctOf(v: number): number {
  return netValue.value > 0 ? (v / netValue.value) * 100 : 0
}

/** 「几分钟前」——快照架构下这是关键信息（先看旧的，后台再刷） */
const ageText = computed(() => {
  const t = props.data?.takenAt
  if (!t) return ''
  const ms = Date.now() - new Date(t).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚更新'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`
})
/** 超过 5 分钟就提示一下（快照 TTL 是 5 分钟） */
const stale = computed(() => {
  const t = props.data?.takenAt
  if (!t) return false
  return Date.now() - new Date(t).getTime() > 5 * 60 * 1000
})

/* ---------------- ③ 多空分布 ---------------- */

const longNotional = computed(() =>
  positions.value
    .filter(p => p.side !== 'short')
    .reduce((s, p) => s + p.notional, 0)
)
const shortNotional = computed(() =>
  positions.value
    .filter(p => p.side === 'short')
    .reduce((s, p) => s + p.notional, 0)
)
const lsTotal = computed(() => longNotional.value + shortNotional.value)
/**
 * 币种简写（用户 2026-10-05：「合约币种简写」）。
 *
 * ⚠️ 这个板子上的 symbol 有**两种写法**，都要认：
 *    · 快照里的持仓是 ccxt 统一写法 `1000LUNC/USDT:USDT`（`fetchPositions` 来的）
 *    · 账本 / 挂单那些是币安原始写法 `1000LUNCUSDT`
 *   原来只 `replace(/USDT$/)`，统一写法就切成了 `1000LUNC/USDT:` —— 界面上真出现了这个。
 */
function baseOf(symbol: string): string {
  const s = String(symbol).toUpperCase()
  const head = s.split('/')[0]
  return head.replace(/USDT$/, '') || s
}

/** 归一成币安原始交易对（跨数据源比对用：`1000LUNC/USDT:USDT` 与 `1000LUNCUSDT` 等价） */
function pairOf(symbol: string): string {
  const s = String(symbol).toUpperCase()
  return s.includes('/') ? `${s.split('/')[0]}USDT` : s
}

/** 交给外层的持仓标识（带 keyId，外层才知道用哪套 Key） */
function posRef(p: FuturesPosition): PositionRef {
  return {symbol: p.symbol, side: p.side, keyId: p.keyId, keyName: p.keyName}
}

/**
 * 这个交易对的**已实现盈亏**（用户 2026-10-05：「已结盈利小字在下面」）。
 *
 * ⚠️ 数据来自后端账本（`income` 那批：成交带 realized 的那些），
 *    所以**只有账本里有这个币的记录时**才有值 —— 没有就返回 `null`，那一行不显示
 *    （宁可不说，也别显示成 0 让人以为「这个仓位从来没赚过钱」）。
 * ⚠️ 多套账户合起来看时按 `symbol + keyName` 匹配，别把两套账户的同名币加一起。
 */
function realizedOf(p: FuturesPosition): number | null {
  const rows = props.income ?? []
  let sum = 0
  let hit = false
  for (const r of rows) {
    if (pairOf(r.symbol) !== pairOf(p.symbol)) continue
    if (p.keyName && r.keyName && r.keyName !== p.keyName) continue
    sum += Number(r.income ?? 0)
    hit = true
  }
  return hit ? sum : null
}

/** 只有一个方向时（比如全是多仓），条子别画成 0% —— 那一段独占整条 */
const longPct = computed(() =>
  lsTotal.value > 0
    ? Math.max((longNotional.value / lsTotal.value) * 100, 2)
    : 0
)

/** 强平价距标记价还有多远（%）：<5% 变黄提醒 */
function liqGap(p: {
  markPrice: number
  liquidationPrice: number | null
}): number | null {
  const liq = p.liquidationPrice
  if (!liq || !p.markPrice) return null
  return Math.abs(((liq - p.markPrice) / p.markPrice) * 100)
}

/* ---------------- ④ tab ---------------- */

type Tab = 'pos' | 'ord' | 'inc' | 'trades' | 'bags'
const tab = ref<Tab>('pos')
/** 净资产走势默认**折叠**（用户要求）；点标题旁边那个小图标展开 */
const curveOpen = ref(false)
function withCount(label: string, n: number): string {
  return n > 0 ? `${label} ${n}` : label
}
const tabs = computed(() => [
  {value: 'pos' as Tab, label: withCount('持仓', positions.value.length)},
  {
    value: 'ord' as Tab,
    label: withCount('挂单', props.openOrders?.length ?? 0)
  },
  {value: 'inc' as Tab, label: withCount('盈亏', props.income?.length ?? 0)},
  {value: 'trades' as Tab, label: '成交'},
  {value: 'bags' as Tab, label: '资产'}
])

/**
 * 按交易对分组挂单。
 * ⚠️ 分组的 key 里要带**账户名** —— 「全部」那一格里，同一个币在 A 账户和 B 账户
 *    各挂了一单，只按 symbol 分会把两套的挂单混进一组、数不清是哪家的。
 */
const orderGroups = computed(() => {
  const m = new Map<string, {symbol: string; keyName?: string; rows: ExchangeOpenOrder[]}>()
  for (const o of props.openOrders ?? []) {
    const k = `${o.keyName ?? ''}|${o.symbol}`
    const g = m.get(k)
    if (g) g.rows.push(o)
    else m.set(k, {symbol: o.symbol, keyName: o.keyName, rows: [o]})
  }
  return [...m.values()]
})

/** 已实现盈亏：按（账户 + 币种）汇总（逐笔看着累） */
const incomeRows = computed(() => props.income ?? [])
const incomeTotal = computed(() =>
  incomeRows.value.reduce(
    (s, r) => s + (Number.isFinite(r.income) ? r.income : 0),
    0
  )
)
const incomeGroups = computed(() => {
  const m = new Map<
    string,
    {symbol: string; keyName?: string; sum: number; count: number}
  >()
  for (const r of incomeRows.value) {
    const k = `${r.keyName ?? ''}|${r.symbol}`
    const g = m.get(k) ?? {symbol: r.symbol, keyName: r.keyName, sum: 0, count: 0}
    g.sum += r.income
    g.count++
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))
})

/* ---------------- 格式化 ---------------- */

/* ---------------- 货币：USDT / CNY 快捷切换 ---------------- */

/** 当前按哪种货币看（**全局持久化**，见 `settings.ts`） */
const currency = exchangeCurrency
/** 汇率：接口没回来之前先用 7.1（跟后端 `USD_CNY` 的默认值一致） */
const cnyRate = computed(() =>
  props.rate && props.rate > 0 ? props.rate : 7.1
)

function toggleCurrency(): void {
  exchangeCurrency.value = exchangeCurrency.value === 'cny' ? 'usd' : 'cny'
}

/** 金额带千分位（`format.ts` 的 `usd()` 不加逗号，六位数很难读） */
function money(v: number): string {
  if (currency.value === 'cny') {
    return (
      '¥' +
      (v * cnyRate.value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    )
  }
  return (
    '$' +
    v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  )
}

/**
 * 总杠杆倍数（用户 2026-10-05：「仓位统计显示总杠杆倍数」）。
 *
 * 口径：**名义总额 ÷ 保证金余额** —— 账户级别的真实杠杆（不是各仓杠杆相加，
 * 那个数没有意义：不同仓位的保证金口径不一样）。保证金余额为 0 时不显示。
 */
const totalLev = computed(() => {
  const m = fx.value?.margin ?? 0
  return m > 0 ? stats.value.notional / m : 0
})
function signedMoney(v: number): string {
  return (v >= 0 ? '+' : '−') + money(Math.abs(v))
}
/** 币的数量：越小的币要越多小数位 */
function qty(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  return fmt(v, a === 0 ? 0 : a < 0.01 ? 8 : a < 1 ? 6 : a < 1000 ? 4 : 2)
}
function tone(v: number): string {
  return v >= 0 ? 'up' : 'down'
}
function sideText(side: string): string {
  const s = side.toLowerCase()
  if (s === 'buy') return '买'
  if (s === 'sell') return '卖'
  return side
}
/** 持仓方向专用：多 / 空（订单那边才是买/卖，两处别混） */
function posText(side: string): string {
  return side.toLowerCase() === 'short' ? '空' : '多'
}

/* ---------------- ⑥ 净资产曲线（M4） ---------------- */

/**
 * 可选跨度（**英文标签**，值跟后端 `/api/exchange/history` 的 range 对齐）。
 * `all` = 全部历史。
 */
const RANGES = [
  {value: '1d', label: '1D'},
  {value: '7d', label: '7D'},
  {value: '30d', label: '30D'},
  {value: '180d', label: '180D'},
  {value: '1y', label: '1Y'},
  {value: 'all', label: 'ALL'}
]
</script>

<template>
  <div class="exb">
    <!--
      账户切换：**tab 条**（用户 2026-10-05：不要下拉框，要「全部 + 每个 key 名称」）。
      ⚠️ 放在 `v-if="data"` **外面** —— 加载/报错时也能切到别的账户。
      只有一套 key 时 `accounts` 只有一项 ⇒ 不渲染，界面上不留一条没用的 tab。
    -->
    <SegTabs
      v-if="showAcctTabs"
      v-model="picked"
      class="acct-tabs"
      :options="accounts!"
    />
    <template v-if="data">
      <!-- ① 净资产 -->
      <section class="panel hero">
        <div class="hero-h">
          <span class="hero-k">净资产</span>
          <!-- 只有一套 key 时没有 tab 条，在这儿当普通标签显示名字 -->
          <span v-if="!showAcctTabs && acctLabel" class="tag">
            {{ acctLabel }}
          </span>
          <span v-else-if="!showAcctTabs" class="tag">合约 + C2C</span>
          <span class="spacer" />
          <!--
            划转（用户 2026-10-05：「在交易所账户，各个里面添加划转功能」）。
            ⚠️ 这是真钱操作（币安没有划转测试接口），弹层里带常驻警示 + 二次确认。
          -->
          <button
            class="ghost tiny tr-open"
            title="万能划转：现货 / 资金(C2C) / USDT 合约 之间搬 USDT（真钱）"
            @click="emit('transfer')"
          >
            划转
          </button>
          <span class="age" :class="{stale}" :title="bjTime(data.takenAt)">
            {{ ageText }}
          </span>
          <!--
            USDT / CNY 快捷切换（用户 2026-10-05：「账户添加人民币汇率切换快捷 usdt cny」）——
            点一下整页金额就在 $ 和 ¥ 之间换（汇率跟用量页同源，见 `cnyRate`）。
          -->
          <button
            class="ghost tiny cur"
            :title="
              currency === 'usd'
                ? `按人民币看（1 USD = ${cnyRate} CNY）`
                : '按美元看'
            "
            @click="toggleCurrency"
          >
            {{ currency === 'usd' ? 'USDT' : 'CNY' }}
          </button>
          <!--
            刷新：**内联 SVG**，不是 `⟳` 那个字符 —— 那个字形在 Android WebView
            的兜底字体里没有，App 里是一颗空白按钮（用户 2026-10-05：
            「交易所账户的刷新图标在 app 没有显示」）。
          -->
          <button
            class="ghost tiny rf"
            :class="{busy: refreshing}"
            :disabled="refreshing"
            title="立即刷新"
            aria-label="立即刷新"
            @click="emit('refresh')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6.02" />
              <path d="M20.5 3.5v5.2h-5.2" />
            </svg>
          </button>
        </div>

        <div class="hero-v">{{ money(netValue) }}</div>

        <!--
          ⑥ **币种占比 + 净资产走势**（合并成一块、可折叠）。
          用户 2026-10-05：「币种占比和资产走势放到一起可折叠」。

          折叠时标题那一行就把三块的百分比摆出来（不然折叠起来等于把占比也藏了，
          净资产只剩一个光秃秃的大数）。展开才是完整的占比条 / 图例 / 曲线。
          ⚠️ 用 `v-if` 而不是 `v-show`：折叠时**根本不下载** echarts 那个 chunk，
          也不存在「容器 0 宽高时 init」那个坑（见 `ExchangeCurveChart.vue` 注释）。
        -->
        <div class="fold">
          <button
            class="fold-h"
            type="button"
            :aria-expanded="curveOpen"
            @click="curveOpen = !curveOpen"
          >
            <span class="fold-t">币种占比 · 净资产走势</span>
            <span class="fold-sum">
              <span class="fs fx"
                >合约 {{ pctOf(futuresValue).toFixed(0) }}%</span
              >
              <span v-if="c2c" class="fs c2c"
                >C2C {{ pctOf(c2cValue).toFixed(0) }}%</span
              >
              <span v-if="spot" class="fs sp"
                >现货 {{ pctOf(spotValue).toFixed(0) }}%</span
              >
            </span>
            <span class="spacer" />
            <svg
              class="chev"
              :class="{open: curveOpen}"
              viewBox="0 0 16 16"
              width="15"
              height="15"
              aria-hidden="true"
            >
              <path
                d="M5 6.5l3 3 3-3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <template v-if="curveOpen">
            <!-- 占比条 + 图例（原来在折叠区外面一直露着，现在跟走势收在一起） -->
            <div class="split-bar">
              <i class="fx" :style="{width: pctOf(futuresValue) + '%'}" />
              <i class="c2c" :style="{width: pctOf(c2cValue) + '%'}" />
              <i class="sp" :style="{width: pctOf(spotValue) + '%'}" />
            </div>
            <ul class="split-lg">
              <li>
                <i class="fx" />
                <span class="lb">USDT 合约</span>
                <b>{{ money(futuresValue) }}</b>
                <span class="pc">{{ pctOf(futuresValue).toFixed(1) }}%</span>
              </li>
              <li v-if="c2c">
                <i class="c2c" />
                <span class="lb">C2C 钱包</span>
                <b>{{ money(c2cValue) }}</b>
                <span class="pc">{{ pctOf(c2cValue).toFixed(1) }}%</span>
              </li>
              <li v-if="spot">
                <i class="sp" />
                <span class="lb">现货（USDT）</span>
                <b>{{ money(spotValue) }}</b>
                <span class="pc">{{ pctOf(spotValue).toFixed(1) }}%</span>
              </li>
            </ul>

            <ExchangeCurveChart
              :points="curve ?? []"
              :bucket-sec="curveBucketSec ?? 300"
            />
            <!--
              跨度切换在**底部**（用户要求），纯文字、不给 tab 底色。
              ⚠️ 类名别叫 `.chip` —— 全局有 `.chip`（标签筛选那种胶囊，`.chip.on` 还带
              `--blue-soft` 底色），撞上了会把这里又变成带底色的胶囊。
            -->
            <div class="rngs">
              <button
                v-for="r in RANGES"
                :key="r.value"
                class="rng"
                :class="{on: (curveRange ?? '1d') === r.value}"
                @click="emit('update:curveRange', r.value)"
              >
                {{ r.label }}
              </button>
            </div>
          </template>
        </div>

        <p v-if="data.account.sandbox" class="hint">模拟盘（sandbox）</p>
      </section>

      <!--
        ③ **合约 · 仓位**（用户 2026-10-05：「仓位统计和资产走势下面的钱包信息合并，
        上面显示可用占用未实现，下面显示仓位总额多头空头」）。

        原来这里是两块：上面hero卡里「钱包余额/未实现/可用/占用」四格，
        下面「仓位统计」又重复了一遍「名义总额/未实现/多头/空头」。
        现在并成一块，两排三格，**未实现盈亏只出现一次**：
          上排 = 账户的钱（可用 / 占用 / 未实现）
          下排 = 仓位的事（仓位总额 / 多头 / 空头）
        ⚠️ 钱包余额那一格去掉了 —— 它在上面「币种占比」的图例里就是「USDT 合约」那一行。
      -->
      <section class="panel">
        <div class="pn-h">
          <h2>合约 · 仓位</h2>
          <!-- 总杠杆（用户 2026-10-05：「仓位统计显示总杠杆倍数」） -->
          <span
            v-if="totalLev > 0"
            class="lev-chip"
            :title="`总杠杆 = 名义总额 ÷ 保证金余额（${money(stats.notional)} ÷ ${money(fx?.margin ?? 0)}）`"
          >
            {{ totalLev.toFixed(2) }}x
          </span>
          <span class="dim tiny">
            {{ stats.longCount + stats.shortCount }} 个持仓 · 多
            {{ stats.longCount }} / 空 {{ stats.shortCount }}
          </span>
        </div>
        <div class="grid3">
          <div>
            <span class="k">可用余额</span><b>{{ money(fx?.available ?? 0) }}</b>
          </div>
          <div>
            <span class="k">占用保证金</span><b>{{ money(fx?.used ?? 0) }}</b>
          </div>
          <div>
            <span class="k">未实现盈亏</span>
            <b :class="tone(fx?.unrealized ?? 0)">{{
              signedMoney(fx?.unrealized ?? 0)
            }}</b>
          </div>
        </div>
        <div class="grid3">
          <div>
            <span class="k">仓位总额</span><b>{{ money(stats.notional) }}</b>
          </div>
          <div>
            <span class="k">多头</span><b class="up">{{ money(longNotional) }}</b>
          </div>
          <div>
            <span class="k">空头</span
            ><b class="down">{{ money(shortNotional) }}</b>
          </div>
        </div>
        <div v-if="lsTotal > 0" class="ls-bar">
          <i class="l" :style="{width: longPct + '%'}" />
          <i class="s" :style="{width: 100 - longPct + '%'}" />
        </div>
      </section>

      <!-- ④ tab -->
      <SegTabs v-model="tab" :options="tabs" />

      <!--
        tab 内容区（用户 2026-10-05：「底部的几个 tab 内容价格高度，不要让外屏无限滚动」）：
        **定高 + 内部自己滚** —— 持仓/挂单/成交一多，原来会把整页（外屏）越撑越长，
        滑到下面找 tab 得翻半天。现在列表再长也只在这个框里滚。
        ⚠️ `overscroll-behavior: contain`：滚到底之后别把外层页面一起带走
          （手机上特别烦，一滑就滑飞）。
      -->
      <div class="tabs-body">
      <!-- 持仓 -->
      <section v-show="tab === 'pos'" class="panel">
        <ul v-if="positions.length" class="poss">
          <!--
            一条持仓的版式（用户 2026-10-05 逐条提的）：
              · 币种用**简写**（`1000LUNCUSDT` → `1000LUNC`），别把 USDT 也念一遍
              · **未实现盈亏靠右**，下面挂一行小字「已结」= 这个币到现在的已实现盈亏
              · 「名义」改叫「价值」，强平价 / 距强平**不要小字**（它不是附注，是要紧的数）
              · 底部两颗按钮：减仓（弹窗选百分比）/ 平仓
          -->
          <li v-for="p in positions" :key="(p.keyName ?? '') + p.symbol + p.side">
            <div class="p-h">
              <span class="sym">{{ baseOf(p.symbol) }}</span>
              <span class="side" :class="p.side === 'short' ? 'sell' : 'buy'">
                {{ posText(p.side) }}
              </span>
              <span class="lev">{{ p.leverage }}x</span>
              <!-- 「全部」那一格里同一币可能出现在两套账户 ⇒ 标出来源 -->
              <span v-if="p.keyName" class="ktag">{{ p.keyName }}</span>
              <span class="spacer" />
              <span class="pnl-wrap">
                <span class="pnl" :class="tone(p.unrealizedPnl)">
                  {{ signedMoney(p.unrealizedPnl) }}
                  <em v-if="p.percentage !== null">
                    {{ p.percentage >= 0 ? '+' : '−'
                    }}{{ fixed(Math.abs(p.percentage), 2) }}%
                  </em>
                </span>
                <span
                  v-if="realizedOf(p) !== null"
                  class="realized"
                  :class="tone(realizedOf(p) ?? 0)"
                  title="这个交易对到现在的已实现盈亏（手续费/资金费也算在里面）"
                >
                  已结 {{ signedMoney(realizedOf(p) ?? 0) }}
                </span>
              </span>
            </div>
            <div class="kv">
              <div>
                <span class="k">数量</span><b>{{ qty(p.amount) }}</b>
              </div>
              <div>
                <span class="k">开仓价</span><b>{{ fmt(p.entryPrice) }}</b>
              </div>
              <div>
                <span class="k">标记价</span><b>{{ fmt(p.markPrice) }}</b>
              </div>
              <div v-if="p.liquidationPrice">
                <span class="k">强平价</span
                ><b class="warn">{{ fmt(p.liquidationPrice) }}</b>
              </div>
            </div>
            <div class="p-f">
              <span class="p-val">价值 {{ money(p.notional) }}</span>
              <span
                v-if="liqGap(p) !== null"
                class="p-liq"
                :class="{warn: liqGap(p)! < 5}"
              >
                距强平 {{ liqGap(p)!.toFixed(1) }}%
              </span>
              <span class="spacer" />
              <button
                type="button"
                class="ghost tiny p-btn"
                :disabled="busy"
                title="减仓（只平掉一部分）"
                @click="emit('reduce', posRef(p))"
              >
                减仓
              </button>
              <button
                type="button"
                class="ghost tiny p-btn warn"
                :disabled="busy"
                title="平掉这一条持仓（市价全平）"
                @click="emit('close', posRef(p))"
              >
                平仓
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="dim">当前无持仓</p>
      </section>

      <!-- 挂单 -->
      <section v-show="tab === 'ord'" class="panel">
        <div v-if="loadingOrders" class="dim load">
          <span class="spin" />正在查询挂单…
        </div>
        <div v-else-if="orderGroups.length" class="grps">
          <div
            v-for="g in orderGroups"
            :key="(g.keyName ?? '') + g.symbol"
            class="grp"
          >
            <div class="grp-h">
              <span class="sym">{{ g.symbol }}</span>
              <span v-if="g.keyName" class="ktag">{{ g.keyName }}</span>
              <span class="spacer" />
              <span class="dim tiny">{{ g.rows.length }} 单</span>
            </div>
            <ul class="rows">
              <li v-for="o in g.rows" :key="o.id">
                <span class="side" :class="o.side === 'buy' ? 'buy' : 'sell'">
                  {{ sideText(o.side) }}
                </span>
                <span class="dim tiny">{{ o.type }}</span>
                <span class="spacer" />
                <span class="num">{{ fmt(o.price) }}</span>
                <span class="dim num">× {{ qty(o.amount) }}</span>
              </li>
            </ul>
          </div>
        </div>
        <p v-else class="dim">当前没有挂单</p>
      </section>

      <!-- 已实现盈亏 -->
      <section v-show="tab === 'inc'" class="panel">
        <div class="pn-h">
          <h2>已实现盈亏</h2>
          <span class="spacer" />
          <span v-if="incomeRows.length" class="pnl" :class="tone(incomeTotal)">
            {{ signedMoney(incomeTotal) }}
          </span>
        </div>
        <template v-if="incomeRows.length">
          <ul class="incs">
            <li v-for="g in incomeGroups" :key="(g.keyName ?? '') + g.symbol">
              <span class="sym">{{ g.symbol }}</span>
              <span v-if="g.keyName" class="ktag">{{ g.keyName }}</span>
              <span class="dim tiny">{{ g.count }} 笔</span>
              <span class="spacer" />
              <span class="pnl" :class="tone(g.sum)">{{
                signedMoney(g.sum)
              }}</span>
            </li>
          </ul>
          <p class="sub-h dim tiny">最近明细</p>
          <ul class="rows">
            <li
              v-for="(r, i) in incomeRows.slice(0, 10)"
              :key="`${r.keyName ?? ''}-${r.symbol}-${i}`"
            >
              <span class="sym">{{ r.symbol }}</span>
              <span v-if="r.keyName" class="ktag">{{ r.keyName }}</span>
              <span class="spacer" />
              <span class="pnl" :class="tone(r.income)">{{
                signedMoney(r.income)
              }}</span>
              <span class="dim tiny">{{ r.time ? bjTime(r.time) : '' }}</span>
            </li>
          </ul>
        </template>
        <p v-else class="dim">
          还没有已实现盈亏（有成交后会自动记进账本）
        </p>
      </section>

      <!-- 成交（后端账本：WS 实时落 + 断线后 REST 补） -->
      <section v-show="tab === 'trades'" class="panel">
        <div class="pn-h">
          <h2>最近成交</h2>
          <span class="spacer" />
          <span class="dim tiny">实时记账本</span>
        </div>
        <ul v-if="trades?.length" class="rows trades">
          <li v-for="t in trades" :key="`${t.keyName ?? ''}-${t.id}`">
            <div class="t-line">
              <span class="side" :class="t.side === 'buy' ? 'buy' : 'sell'">
                {{ sideText(t.side) }}
              </span>
              <span class="sym">{{ t.symbol }}</span>
              <span v-if="t.keyName" class="ktag">{{ t.keyName }}</span>
              <span class="spacer" />
              <span class="num">{{ fmt(t.price) }}</span>
            </div>
            <div class="t-sub dim tiny">
              <span>量 {{ qty(t.amount) }}</span>
              <span>额 {{ fmt(t.cost) }}</span>
              <span v-if="t.fee"
                >费 {{ fmt(t.fee, 4) }} {{ t.feeCurrency }}</span
              >
              <span class="spacer" />
              <span>{{ t.datetime ? bjTime(t.datetime) : '' }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="dim">还没有成交记录（下单成交后会自动记进来）</p>
      </section>

      <!-- 资产明细（合约多资产 + C2C 钱包 + 现货 USDT） -->
      <section v-show="tab === 'bags'" class="panel">
        <div class="pn-h"><h2>合约账户资产</h2></div>
        <ul class="rows">
          <li v-for="a in fx?.assets ?? []" :key="a.asset">
            <span class="sym">{{ a.asset }}</span>
            <span class="dim tiny">可用 {{ qty(a.available) }}</span>
            <span class="spacer" />
            <span class="num">{{ qty(a.wallet) }}</span>
            <span v-if="a.unrealized" class="pnl" :class="tone(a.unrealized)">
              {{ signedMoney(a.unrealized) }}
            </span>
          </li>
        </ul>

        <div class="pn-h mt">
          <h2>C2C 钱包</h2>
          <span class="spacer" />
          <span v-if="c2c" class="dim tiny">{{ money(c2c.totalUsdt) }}</span>
        </div>
        <ul v-if="c2c?.assets.length" class="rows">
          <li v-for="a in c2c.assets" :key="a.asset">
            <span class="sym">{{ a.asset }}</span>
            <span class="spacer" />
            <span class="num">{{ qty(a.balance) }}</span>
            <span class="dim num">{{
              a.usdt === null ? '—' : money(a.usdt)
            }}</span>
          </li>
        </ul>
        <p v-else class="dim">
          {{ c2c ? 'C2C 钱包是空的' : '这个账户没有 C2C 钱包' }}
        </p>

        <!--
          现货：**只列 USDT 一行**（用户 2026-10-05：「只要 usdt 的统计简单化」）。
          别的币种确实还在现货账户里，但这里不列、也不折价 —— 想全看请去币安 App。
        -->
        <template v-if="spot">
          <div class="pn-h mt">
            <h2>现货（USDT）</h2>
            <span class="spacer" />
            <span class="dim tiny">{{ money(spot.usdt) }}</span>
          </div>
          <ul class="rows">
            <li>
              <span class="sym">USDT</span>
              <span class="spacer" />
              <span class="num">{{ qty(spot.usdt) }}</span>
              <span class="dim num">{{ money(spot.usdt) }}</span>
            </li>
          </ul>
          <p class="dim tiny">⚠️ 只统计 USDT，现货里的其他币种不计入净资产</p>
        </template>
      </section>
      </div>
    </template>

    <p v-else-if="reason" class="dim no-data">{{ reason }}</p>
    <p v-else class="dim load"><span class="spin" />正在取账户快照…</p>
  </div>
</template>

<style scoped>
.exb {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.spacer {
  flex: 1 1 auto;
}
.tiny {
  font-size: 11.5px;
}
.dim {
  color: var(--muted);
}
.warn {
  color: var(--warn, #f0b429);
}
.up {
  color: var(--ok, #5eba89);
}
.down {
  color: var(--bad, #e55361);
}
.load {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 13px;
}

/* 「没有数据」那一句：比转圈那句稍微显眼一点（它是终态，不是过渡态） */
.no-data {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.7;
}

/* ---------------- ① 净资产 ---------------- */

.hero-h {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hero-k {
  font-size: 12px;
  color: var(--muted);
}
.age {
  font-size: 11.5px;
  color: var(--muted);
}
.age.stale {
  color: var(--warn, #f0b429);
}
.rf {
  padding: 2px 8px;
  font-size: 13px;
  line-height: 1.2;
}
/* 手机上这是整页最该看见的数 —— 30px 别再小 */
.hero-v {
  margin: 4px 0 10px;
  font-size: 30px;
  font-weight: var(--fw-mid, 600);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}
.split-bar {
  display: flex;
  gap: 2px;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--panel-2);
}
.split-bar i {
  display: block;
  height: 100%;
  transition: width 0.2s;
}
.split-bar .fx,
.split-bar .c2c,
.split-bar .sp {
  min-width: 2px;
}
.split-lg {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.split-lg li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}
.split-lg i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.split-lg .lb {
  color: var(--muted);
}
.split-lg b {
  margin-left: auto;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.split-lg .pc {
  min-width: 46px;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
/* 合约 / C2C / 现货三个色：合约用主色（暖沙），C2C 用蓝，现货用青，跟全站色系不打架 */
.fx {
  background: var(--accent, #d3b583);
}
.c2c {
  background: #5b8def;
}
.sp {
  background: #4cc4b0;
}

/*
 * 三格（用户 2026-10-05 合并后的「合约 · 仓位」那块）：两排，每排三个。
 * ⚠️ 手机上三列会有点挤（112px × 3 + 间距 ≈ 356px，390 宽的屏正好），
 *    所以窄屏降到 `minmax(86px, 1fr)` —— 数字是等宽的，挤一点也读得清。
 */
.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.16));
}
.grid3 + .grid3 {
  /* 第二排（仓位总额 / 多头 / 空头）—— 不再来一条分隔线，看着是一张表 */
  margin-top: 10px;
  padding-top: 0;
  border-top: 0;
}
.grid3 > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.grid3 .k {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.grid3 b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 折叠标题右边那串百分比摘要（折叠时也能看出占比） */
.fold-sum {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fold-sum .fs {
  color: var(--muted);
}
.fold-sum .fs::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 2px;
  vertical-align: 1px;
}
.fold-sum .fx::before {
  background: var(--accent, #d3b583);
}
.fold-sum .c2c::before {
  background: #5b8def;
}
.fold-sum .sp::before {
  background: #4cc4b0;
}

/* 四格：手机 2×2、宽一点自动 4 列（不写死断点，靠 minmax） */
.grid4 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.16));
}
.grid4 > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.grid4 .k {
  font-size: 11px;
  color: var(--muted);
}
.grid4 b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------- ③ 多空条 ---------------- */

.ls-bar {
  display: flex;
  gap: 2px;
  height: 6px;
  margin-top: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--panel-2);
}
.ls-bar i {
  display: block;
  height: 100%;
}
.ls-bar .l {
  background: var(--ok, #5eba89);
}
.ls-bar .s {
  background: var(--bad, #e55361);
}

/* ---------------- 通用小标题 / 卡片行 ---------------- */

.pn-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.pn-h.mt {
  margin-top: 16px;
}
.pn-h h2 {
  margin: 0;
  font-size: 14px;
}
.sub-h {
  margin: 12px 0 2px;
}
/*
 * 「底部几个 tab 的内容」定高 + 自己滚（用户 2026-10-05：
 * 「底部的几个 tab 内容价格高度，不要让外屏无限滚动」）。
 *
 * 高度取视口的 46%（手机上 ≈390px，正好装 3~4 条持仓），插到 460px 封顶 ——
 * 桌面端不至于空出一大片。内容少的时候自然高度，不会被撑成空白。
 */
.tabs-body {
  max-height: min(46vh, 460px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.poss,
.incs,
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.poss li {
  padding: 11px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.16));
}
.poss li:first-child {
  border-top: 0;
  padding-top: 0;
}
.p-h {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sym {
  font-size: 13px;
  font-weight: var(--fw-mid, 500);
}
.side {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  flex: 0 0 auto;
}
.side.buy {
  color: var(--ok, #5eba89);
  background: var(--ok-soft, rgba(94, 186, 137, 0.14));
}
.side.sell {
  color: var(--bad, #e55361);
  background: var(--bad-soft, rgba(227, 85, 97, 0.14));
}
.lev {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--line, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  padding: 0 4px;
}
.pnl {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 500;
}
.pnl em {
  font-style: normal;
  font-size: 11px;
  opacity: 0.8;
}
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(86px, 1fr));
  gap: 6px 10px;
  margin-top: 8px;
}
.kv > div {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.kv .k {
  font-size: 11px;
  color: var(--muted);
}
.kv b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 12.5px;
}
/*
 * 盈亏那一块（用户 2026-10-05）：
 *   未实现盈亏**靠右**、字号大一点（它是这一条里最要紧的数）；
 *   下面挂一行小字「已结 +x.xx」= 这个币到现在的已实现盈亏（账本里来的）。
 * 所以包一层 `.pnl-wrap`（纵向），`margin-left:auto` 顶到行尾 —— 原来靠 `.spacer` 顶，
 * 但那样右面只剩一个裸数字，下面是空的一行。
 */
.pnl-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-left: auto;
  min-width: 0;
}
.realized {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.p-f {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--muted);
}
/*
 * 「强平价 / 距强平」**不用小字**（用户 2026-10-05：「强平不要小写」）——
 * 这俩是要紧的数，别拿 `.dim` 那种淡灰埋了。跟同行正文一个字号、正常颜色，
 * 只有确实危险（<5%）时才转成警示色。
 */
.p-f .p-val,
.p-f .p-liq {
  font-size: 12px;
  color: var(--text);
}
.p-f .p-liq.warn {
  color: var(--warn, #e0a33e);
  font-weight: 500;
}
/* 底部那两颗按钮：靠右、别把「价值」挤走 */
.p-btn {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 11px;
}
.p-btn.warn {
  color: var(--warn, #e0a33e);
  border-color: color-mix(in srgb, var(--warn, #e0a33e) 45%, transparent);
}
.grps {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.grp-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}
.rows li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  font-size: 12.5px;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.12));
}
.rows li:first-child {
  border-top: 0;
}
.incs li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 13px;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.16));
}
.incs li:first-child {
  border-top: 0;
}
.trades li {
  display: block;
  padding: 8px 0;
}
.t-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.t-sub {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 3px;
}
.num {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
/*
 * 账户 tab 条（原来这儿是「净资产」旁边一个 `<select class="acct">`）。
 * key 名字可能长、套数可能多 ⇒ 横向滚动，不换行也不把按钮挤扁。
 */
.acct-tabs {
  display: flex;
  flex: 0 0 auto;
  overflow-x: auto;
  scrollbar-width: none;
}
.acct-tabs::-webkit-scrollbar {
  display: none;
}
.acct-tabs :deep(button) {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 7px 14px;
}
/*
 * 刷新按钮的图标：**内联 SVG**（原来那个 `⟳` 字符在 Android WebView 里
 * 兜底字体没这个字形，App 上是一颗空白按钮）。
 * 尺寸对齐 `.ghost.tiny` 的高度，别把这一行撑高。
 */
.rf {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 6px;
}

.rf svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 刷新中：整个按钮转圈（keyframes spin 是全局的，见 style.css） */
.rf.busy {
  animation: spin 0.8s linear infinite;
  cursor: default;
}

/* USDT / CNY 切换：跟「几分钟前」并排的一颗小标签，点了就换 */
.cur {
  padding: 3px 7px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: var(--fw-bold);
}

/* 仓位统计标题右边那颗「总杠杆」 */
.lev-chip {
  margin-right: auto;
  margin-left: 8px;
  padding: 1px 7px;
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  background: var(--blue-soft);
  color: var(--blue);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: var(--fw-bold);
}

/* ---------------- ⑥ 净资产走势（折叠） ---------------- */

/*
 * 折叠块在 hero 卡里、四格上方。**不画自己的上边框** —— 下面 `.grid4`
 * 自带一条 `border-top`，折叠时那条线就当这一行的下划线，正好把四格隔开。
 */
.fold {
  margin-top: 10px;
}
.fold-h {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}
.fold-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.chev {
  flex: 0 0 auto;
  color: var(--muted);
  transition: transform 0.15s;
}
.chev.open {
  transform: rotate(180deg);
}

/*
 * 跨度切换：6 档铺满一行，**纯文字**（用户：不要 tab 背景），选中的只换字色。
 * ⚠️ 类名避开全局的 `.chip`（那是标签筛选的胶囊，见 style.css 4434）。
 */
.rngs {
  display: flex;
  justify-content: space-between;
  gap: 2px;
  margin-top: 2px;
}
.rng {
  flex: 1 1 auto;
  padding: 3px 0;
  font-size: 11.5px;
  text-align: center;
  color: var(--muted);
  background: none;
  border: 0;
}
.rng.on {
  color: var(--accent, #d3b583);
  font-weight: 600;
  background: none;
}
</style>
