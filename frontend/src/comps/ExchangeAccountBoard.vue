<script setup lang="ts">
/**
 * 「交易所资产」面板 —— **移动端优先**（用户 2026-10-05：先设计移动端界面）。
 *
 * 范围（用户原话：「只统计这两个维度的钱，不算现货」）：
 *   · USDT 合约（USDⓈ-M）`fapi/v2/account` + `fapi/v2/balance`
 *   · C2C 钱包 `sapi/v1/asset/wallet/balance?needBalanceDetail=true`
 *   ⇒ 现货不参与统计，老版那套「按币种估值的现货余额列表」整块删了。
 *
 * 排版（手机一屏从上往下）：
 *   ① **净资产** = 合约保证金余额 + C2C（一个大数 + 占比条 + 两行分解）
 *   ② 合约明细四格：钱包余额 / 未实现盈亏 / 可用 / 占用
 *   ③ **仓位统计**：名义总额、未实现盈亏、多空占比条（用户要的「统计仓位」）
 *   ④ 二级 tab：持仓 / 挂单 / 盈亏 / 成交 / 资产明细
 *   ⑤ tab 内容（卡片行）
 *
 * ⚠️ **组件是纯展示的**：数据全走 props（自己不发请求）⇒ 真数据由
 *    `ExchangeAccountLivePanel.vue` 传进来。
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
   * 绑定的账户（**多套 key 时顶部变下拉切换**）。
   * ⚠️ 纯展示：切换只往上 emit，重新取数由外层负责。
   */
  accounts?: {id: number; name: string}[]
  /** 当前选中的账户 id（配合 `update:modelValue`） */
  modelValue?: number | null
  /** 净资产曲线（“快照序列 → 图”，可能还没攒够点） */
  curve?: CurvePoint[]
  /** 当前跨度：1d / 7d / 30d（受控） */
  curveRange?: string
  /** 后端用的桶宽（秒）—— 算「断档」要靠它 */
  curveBucketSec?: number
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'update:modelValue', id: number): void
  (e: 'update:curveRange', range: string): void
}>()

/** 下拉选中的值从 DOM 出来是字符串，这里转回数字再往上抛 */
function onPick(v: string): void {
  const id = Number(v)
  if (Number.isFinite(id)) emit('update:modelValue', id)
}

const acct = computed(() => props.data?.account ?? null)
const fx = computed(() => props.data?.futures ?? null)
const c2c = computed(() => props.data?.c2c ?? null)
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

/* ---------------- ① 净资产 = 合约保证金余额 + C2C ---------------- */

/** 合约那边的「钱」用的是**保证金余额**（= 钱包 + 浮盈），不是钱包余额 */
const futuresValue = computed(() => fx.value?.margin ?? 0)
const c2cValue = computed(() => c2c.value?.totalUsdt ?? 0)
const netValue = computed(() => futuresValue.value + c2cValue.value)
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

/** 按交易对分组挂单 */
const orderGroups = computed(() => {
  const m = new Map<string, ExchangeOpenOrder[]>()
  for (const o of props.openOrders ?? []) {
    const arr = m.get(o.symbol)
    if (arr) arr.push(o)
    else m.set(o.symbol, [o])
  }
  return [...m.entries()].map(([symbol, rows]) => ({symbol, rows}))
})

/** 已实现盈亏：按币种汇总（逐笔看着累） */
const incomeRows = computed(() => props.income ?? [])
const incomeTotal = computed(() =>
  incomeRows.value.reduce(
    (s, r) => s + (Number.isFinite(r.income) ? r.income : 0),
    0
  )
)
const incomeGroups = computed(() => {
  const m = new Map<string, {symbol: string; sum: number; count: number}>()
  for (const r of incomeRows.value) {
    const g = m.get(r.symbol) ?? {symbol: r.symbol, sum: 0, count: 0}
    g.sum += r.income
    g.count++
    m.set(r.symbol, g)
  }
  return [...m.values()].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))
})

/* ---------------- 格式化 ---------------- */

/** 金额带千分位（`format.ts` 的 `usd()` 不加逗号，六位数很难读） */
function money(v: number): string {
  return (
    '$' +
    v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  )
}
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
    <template v-if="data">
      <!-- ① 净资产 -->
      <section class="panel hero">
        <div class="hero-h">
          <span class="hero-k">净资产</span>
          <!-- 绑定的 key：多套就在这儿切；只有一套时当一个普通标签显示名字 -->
          <select
            v-if="(accounts?.length ?? 0) > 1"
            class="acct"
            :value="modelValue ?? ''"
            aria-label="切换账户"
            @change="onPick(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="a in accounts" :key="a.id" :value="a.id">
              {{ a.name }}
            </option>
          </select>
          <span v-else class="tag">{{
            accounts?.[0]?.name ?? '合约 + C2C'
          }}</span>
          <span class="spacer" />
          <span class="age" :class="{stale}" :title="bjTime(data.takenAt)">
            {{ ageText }}
          </span>
          <button
            class="ghost tiny rf"
            :class="{busy: refreshing}"
            :disabled="refreshing"
            title="立即刷新"
            @click="emit('refresh')"
          >
            ⟳
          </button>
        </div>

        <div class="hero-v">{{ money(netValue) }}</div>

        <div class="split-bar">
          <i class="fx" :style="{width: pctOf(futuresValue) + '%'}" />
          <i class="c2c" :style="{width: pctOf(c2cValue) + '%'}" />
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
        </ul>

        <!--
          ⑥ 净资产走势（M4）—— **默认折叠**在这个位置（钱包余额 / 未实现盈亏的上方）；
          折叠时这一行正好当作下面四格的小标题，展开才拉图。
          切换开关就是右边那个**小图标**（不占地方，也不给整行做 tab 背景）。
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
            <span class="fold-t">净资产走势</span>
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

        <!-- ② 合约明细：手机上排 2×2，别挤成一行小字 -->
        <div v-if="fx" class="grid4">
          <div>
            <span class="k">钱包余额</span><b>{{ money(fx.wallet) }}</b>
          </div>
          <div>
            <span class="k">未实现盈亏</span>
            <b :class="tone(fx.unrealized)">{{ signedMoney(fx.unrealized) }}</b>
          </div>
          <div>
            <span class="k">可用余额</span><b>{{ money(fx.available) }}</b>
          </div>
          <div>
            <span class="k">占用保证金</span><b>{{ money(fx.used) }}</b>
          </div>
        </div>

        <p v-if="data.account.sandbox" class="hint">模拟盘（sandbox）</p>
      </section>

      <!-- ③ 仓位统计 -->
      <section class="panel">
        <div class="pn-h">
          <h2>仓位统计</h2>
          <span class="dim tiny">
            {{ stats.longCount + stats.shortCount }} 个持仓 · 多
            {{ stats.longCount }} / 空 {{ stats.shortCount }}
          </span>
        </div>
        <div class="grid4">
          <div>
            <span class="k">名义总额</span><b>{{ money(stats.notional) }}</b>
          </div>
          <div>
            <span class="k">未实现盈亏</span>
            <b :class="tone(stats.unrealized)">{{
              signedMoney(stats.unrealized)
            }}</b>
          </div>
          <div>
            <span class="k">多头</span
            ><b class="up">{{ money(longNotional) }}</b>
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

      <!-- 持仓 -->
      <section v-show="tab === 'pos'" class="panel">
        <ul v-if="positions.length" class="poss">
          <li v-for="p in positions" :key="p.symbol + p.side">
            <div class="p-h">
              <span class="sym">{{ p.symbol }}</span>
              <span class="side" :class="p.side === 'short' ? 'sell' : 'buy'">
                {{ posText(p.side) }}
              </span>
              <span class="lev">{{ p.leverage }}x</span>
              <span class="spacer" />
              <span class="pnl" :class="tone(p.unrealizedPnl)">
                {{ signedMoney(p.unrealizedPnl) }}
                <em v-if="p.percentage !== null">
                  {{ p.percentage >= 0 ? '+' : '−'
                  }}{{ fixed(Math.abs(p.percentage), 2) }}%
                </em>
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
              <span>名义 {{ money(p.notional) }}</span>
              <span
                v-if="liqGap(p) !== null"
                :class="liqGap(p)! < 5 ? 'warn' : 'dim'"
              >
                距强平 {{ liqGap(p)!.toFixed(1) }}%
              </span>
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
          <div v-for="g in orderGroups" :key="g.symbol" class="grp">
            <div class="grp-h">
              <span class="sym">{{ g.symbol }}</span>
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
            <li v-for="g in incomeGroups" :key="g.symbol">
              <span class="sym">{{ g.symbol }}</span>
              <span class="dim tiny">{{ g.count }} 笔</span>
              <span class="spacer" />
              <span class="pnl" :class="tone(g.sum)">{{
                signedMoney(g.sum)
              }}</span>
            </li>
          </ul>
          <p class="sub-h dim tiny">最近明细</p>
          <ul class="rows">
            <li v-for="(r, i) in incomeRows.slice(0, 10)" :key="i">
              <span class="sym">{{ r.symbol }}</span>
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
          <li v-for="t in trades" :key="t.id">
            <div class="t-line">
              <span class="side" :class="t.side === 'buy' ? 'buy' : 'sell'">
                {{ sideText(t.side) }}
              </span>
              <span class="sym">{{ t.symbol }}</span>
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

      <!-- 资产明细（合约多资产 + C2C 钱包） -->
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
      </section>
    </template>

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
.split-bar .c2c {
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
/* 合约 / C2C 两个色：合约用主色（暖沙），C2C 用蓝，跟全站色系不打架 */
.fx {
  background: var(--accent, #d3b583);
}
.c2c {
  background: #5b8def;
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
.p-f {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--muted);
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
/* 账户下拉：挤在「净资产」旁边一行里，所以别太长、字号跟小标签一致 */
.acct {
  max-width: 46%;
  padding: 2px 6px;
  font-size: 12px;
  border-radius: 7px;
}
/* 刷新中：⟳ 转圈（keyframes spin 是全局的，见 style.css） */
.rf.busy {
  animation: spin 0.8s linear infinite;
  cursor: default;
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
