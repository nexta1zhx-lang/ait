<script setup lang="ts">
/**
 * 「交易所账户」面板 —— **2026-10-05 大改版**（用户：「交易所行情账户界面大优化，
 * 根据返回的数据格式先模拟一套数据看看效果」）。
 *
 * 老版（见 git 历史）是**六个 panel 一路往下堆**：余额 / 持仓 / 挂单 / 盈亏 / 订单 +
 * 更新于，手机上要滚很久才看得到订单，余额里几十个零头币也是一条不落地全列出来。
 *
 * 这一版按「先看总数 → 再看分类」重排：
 *   ① 顶部**总览卡**：总资产估值 + 可用/占用 + **资产分布条**（一眼看出仓位结构）
 *   ② 三张**指标卡**：持仓浮盈 / 已实现盈亏 / 挂单数（带涨跌色）
 *   ③ 下面收进 **二级 tab**（余额 / 持仓 / 挂单 / 盈亏 / 订单）—— 不再一长条
 *   ④ 每个 tab 里都是「卡片行」：左边币种/交易对 + 右边数字（`--mono` + tabular-nums）
 *   ⑤ 余额默认**折掉小额与零头**（按 ≥$1 分档，可一键展开）—— 币圈账户里
 *      零头币通常占一大半行数，折掉之后一屏就能看完主要持仓
 *
 * ⚠️ **组件是纯展示的**：数据全靠 `data` prop 传进来（自己不发请求）——
 *    这样预览页可以直接喂 mock（`exchangeMock.ts`）调样式，
 *    真数据那条路还是 `ExchangeAccountPanel.vue` 在拉。
 * ⚠️ 数字一律 `--mono` + `tabular-nums`（全站约定，见 style.css 末尾那条聚合规则）。
 */
import {computed, ref} from 'vue'
import type {
  ExchangeAccountResult,
  ExchangeBalanceRow,
  ExchangeOrderRow
} from '../api'
import {CHART_COLORS} from '../chart-theme'
import {bjTime, fixed, fmt} from '../format'
import SegTabs from './SegTabs.vue'

const props = defineProps<{
  data: ExchangeAccountResult | null
  loading?: boolean
  /** 拉数据这一层失败（不是「余额查询失败」那种局部错误） */
  error?: string
  /** 订单要查哪个交易对（币安这类必须给）—— 受控，由外层持有 */
  symbol?: string
}>()

const emit = defineEmits<{
  (e: 'search', symbol: string): void
  (e: 'update:symbol', v: string): void
}>()

/* ---------------- 顶部总览 ---------------- */

const acct = computed(() => props.data?.account ?? null)
const bal = computed(() => props.data?.balance ?? null)

/** 是不是现货账户（现货没有持仓 / 已实现盈亏那两块） */
const isSpot = computed(() => acct.value?.marketType === 'spot')

/**
 * 余额行：按**折 USDT 的估值**从大到小；查不到价的（`usdt === null`）垫底。
 * `toSorted` 在旧 WebView 上不一定有，所以用拷贝 + sort（跟仓库其它地方一致）。
 */
const balAll = computed(() => {
  const rows = bal.value?.rows ?? []
  return [...rows].sort(
    (a, b) => (b.usdt ?? -1) - (a.usdt ?? -1) || b.total - a.total
  )
})

/** 小额门槛：< $1 或查不到价或清零的，默认折起来 */
const DUST_USD = 1
function isDust(r: ExchangeBalanceRow): boolean {
  return r.total <= 0 || r.usdt === null || r.usdt < DUST_USD
}
const showDust = ref(false)
const balVisible = computed(() =>
  showDust.value ? balAll.value : balAll.value.filter(r => !isDust(r))
)
const dustCount = computed(() => balAll.value.filter(isDust).length)

/** 超过一屏就先列 8 条，剩下的「展开」—— 币多了列表会淹没下面几块 */
const BAL_HEAD = 8
const showAllBal = ref(false)
const balShown = computed(() =>
  showAllBal.value ? balVisible.value : balVisible.value.slice(0, BAL_HEAD)
)

/**
 * 可用 / 占用 ≈ 把每一行按 `usdt / total` 的比例摊回自由 / 冻结上。
 * ⚠️ 接口只给了每一行**总量**的 USDT 估值（`usdt`），没有分开给可用/占用，
 *    所以这里只能按比例估算 —— 界面上标成「估」，别当成精确值。
 */
const split = computed(() => {
  let free = 0
  let used = 0
  let counted = 0
  let skipped = 0
  for (const r of balAll.value) {
    if (r.usdt === null) {
      skipped++
      continue
    }
    counted++
    const k = r.total > 0 ? r.usdt / r.total : 0
    free += r.free * k
    used += r.used * k
  }
  return {free, used, counted, skipped}
})

/** 资产分布：前 5 个币 + 「其他」，画成一条**堆叠横条** + 图例 */
const ALLOC_TOP = 5
const alloc = computed(() => {
  const rows = balAll.value.filter(r => (r.usdt ?? 0) > 0)
  const total = rows.reduce((s, r) => s + (r.usdt as number), 0)
  const head = rows.slice(0, ALLOC_TOP)
  const tail = rows.slice(ALLOC_TOP)
  const items = head.map(r => ({
    key: r.currency,
    label: r.currency,
    value: r.usdt as number,
    color: colorOf(r.currency),
    pct: total > 0 ? ((r.usdt as number) / total) * 100 : 0
  }))
  if (tail.length) {
    const v = tail.reduce((s, r) => s + (r.usdt as number), 0)
    items.push({
      key: '__other__',
      label: `其他 ${tail.length} 个`,
      value: v,
      color: '#3b4149',
      pct: total > 0 ? (v / total) * 100 : 0
    })
  }
  return {items, total}
})

/* ---------------- 持仓 ---------------- */

const pos = computed(() => props.data?.positions ?? [])
const posPnl = computed(() =>
  pos.value.reduce((s, p) => s + (Number.isFinite(p.unrealizedPnl) ? p.unrealizedPnl : 0), 0)
)
const posLong = computed(
  () => pos.value.filter(p => p.side.toLowerCase() !== 'short').length
)

/** 强平价离标记价还有多远（%）：爆仓距离，一眼看出哪个仓位危险 */
function liqGap(p: {markPrice: number; liquidationPrice: number | null}): number | null {
  const liq = p.liquidationPrice
  if (!liq || !p.markPrice) return null
  return ((liq - p.markPrice) / p.markPrice) * 100
}

/* ---------------- 挂单 ---------------- */

const openOrders = computed(() => props.data?.openOrders ?? [])
/** 按交易对分组：同一对的几个档位挨在一起看才有意义 */
const orderGroups = computed(() => {
  const m = new Map<string, ExchangeOrderRow[]>()
  for (const o of openOrders.value) {
    const k = o.symbol || '—'
    const arr = m.get(k)
    if (arr) arr.push(o)
    else m.set(k, [o])
  }
  return [...m.entries()].map(([symbol, rows]) => ({symbol, rows}))
})

/* ---------------- 已实现盈亏 ---------------- */

const income = computed(() => props.data?.income ?? [])
const incomeTotal = computed(() =>
  income.value.reduce((s, r) => s + (Number.isFinite(r.income) ? r.income : 0), 0)
)
/** 按币种汇总：逐笔明细看着累，「哪个币赚了/亏了」才是要看的 */
const incomeGroups = computed(() => {
  const m = new Map<
    string,
    {symbol: string; sum: number; count: number; last: string | null}
  >()
  for (const r of income.value) {
    const k = r.symbol || '—'
    const g = m.get(k) ?? {symbol: k, sum: 0, count: 0, last: null}
    g.sum += r.income
    g.count++
    if (r.time && (!g.last || r.time > g.last)) g.last = r.time
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))
})

/* ---------------- 订单 / 成交 ---------------- */

const orders = computed(() => props.data?.orders ?? null)
const orderRows = computed(() => orders.value?.rows ?? [])
const isTrades = computed(() => orders.value?.kind === 'trades')

/* ---------------- 二级 tab ---------------- */

type Tab = 'bal' | 'pos' | 'ord' | 'inc' | 'hist'
const tab = ref<Tab>('bal')
/** 标签上带条数；为 0 就不加数字，免得一排全是 0 */
function withCount(label: string, n: number): string {
  return n > 0 ? `${label} ${n}` : label
}
const tabs = computed(() => {
  /*
   * 最后一格叫「结算」还是「订单」，看接口给的是 `kind`：
   * trades = 逐笔成交（币安合约走这条），orders = 历史订单。
   */
  const t: {value: Tab; label: string}[] = [
    {value: 'bal', label: withCount('余额', balVisible.value.length)},
    {value: 'pos', label: withCount('持仓', pos.value.length)},
    {value: 'ord', label: withCount('挂单', openOrders.value.length)},
    {value: 'inc', label: withCount('盈亏', income.value.length)},
    {value: 'hist', label: isTrades.value ? '成交' : '订单'}
  ]
  return t
})

/* ---------------- 格式化小工具 ---------------- */

/**
 * 金额：**带千分位**。
 * ⚠️ 没用 `format.ts` 的 `usd()` —— 它是 `'$' + n.toFixed(2)`，$31115.34 这种
 *    六位数连逗号都没有，总资产上很难读。这里只在这个面板内用。
 */
function money(v: number): string {
  return (
    '$' +
    v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})
  )
}
/** 带正负号（负号用真减号，比 `-` 齐） */
function signedMoney(v: number): string {
  return (v >= 0 ? '+' : '−') + money(Math.abs(v))
}
/** 带正负号的裸数字（USDT 计价那种） */
function signedNum(v: number): string {
  return (v >= 0 ? '+' : '−') + fmt(Math.abs(v), 2)
}
/** 币的数量：越小的币要越多小数位才看得出差别 */
function qty(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  return fmt(v, a === 0 ? 0 : a < 0.01 ? 8 : a < 1 ? 6 : a < 1000 ? 4 : 2)
}
/** 占比 */
function share(v: number, total: number): string {
  return total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '—'
}
function tone(v: number): string {
  return v >= 0 ? 'up' : 'down'
}
/**
 * 币种配色：按名字哈希取色板里的一格 —— **同名永远同色**，
 * 这样分布条、列表、图例三处能对上（跟 PieChart 用的是同一套色）。
 */
function colorOf(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return CHART_COLORS[h % CHART_COLORS.length] as string
}
function sideText(side: string): string {
  const s = side.toLowerCase()
  if (s === 'buy') return '买'
  if (s === 'sell') return '卖'
  if (s === 'long') return '多'
  if (s === 'short') return '空'
  return side
}
/**
 * 持仓方向**专用**：多 / 空。
 * ⚠️ 不能跟订单的买/卖 混 —— 现货订单说「买/卖」是成交方向，
 *    合约持仓说「多/空」是仓位方向，写反了读起来会很怪（两个界面都有这两个词）。
 */
function posText(side: string): string {
  return side.toLowerCase() === 'short' ? '空' : '多'
}
</script>

<template>
  <div class="exb">
    <!-- 「拉数据」这一层就失败了：什么都不显示，只给错误 -->
    <section v-if="error" class="panel">
      <p class="err">{{ error }}</p>
    </section>

    <template v-else>
      <!-- ① 总览 -->
      <section class="panel ov">
        <div class="ov-h">
          <span class="ov-k">总资产估值</span>
          <span v-if="acct" class="tag">
            {{ acct.exchange }} · {{ isSpot ? '现货' : '合约' }}
          </span>
          <span class="spacer" />
          <span class="dim tiny">{{ loading && !data ? '查询中…' : '' }}</span>
        </div>

        <p v-if="loading && !data" class="dim load">
          <span class="spin" />
          正在向交易所查询…
        </p>

        <template v-else-if="bal">
          <div class="ov-v">{{ money(bal.totalUsdt) }}</div>
          <div class="ov-s">
            <span>可用 <b>{{ money(split.free) }}</b></span>
            <span class="sep">·</span>
            <span>占用 <b>{{ money(split.used) }}</b></span>
            <span class="dim tiny">（按各行总量折算）</span>
            <span class="spacer" />
            <span v-if="bal.partial" class="warn tiny">部分币无价</span>
          </div>

          <!-- 分布条：一眼看出仓位结构 -->
          <div v-if="alloc.items.length" class="alloc">
            <i
              v-for="a in alloc.items"
              :key="a.key"
              :style="{width: Math.max(a.pct, 0.6) + '%', background: a.color}"
              :title="`${a.label} ${money(a.value)}`"
            />
          </div>
          <ul v-if="alloc.items.length" class="alloc-lg">
            <li v-for="a in alloc.items" :key="a.key">
              <i :style="{background: a.color}" />
              <span class="lb">{{ a.label }}</span>
              <b>{{ money(a.value) }}</b>
              <span class="pc">{{ a.pct.toFixed(1) }}%</span>
            </li>
          </ul>
        </template>

        <p v-else-if="data?.balanceError" class="err">{{ data.balanceError }}</p>
        <p v-else-if="!loading" class="dim">这个账户没有余额数据</p>

        <p v-if="data" class="ov-t dim tiny">
          更新于 {{ bjTime(bal?.updatedAt ?? data.account.updatedAt) }}
        </p>
      </section>

      <!-- ② 三张指标卡（现货没有盈亏，就只摆两张） -->
      <div v-if="data" class="cards">
        <div class="card" :class="pos.length ? tone(posPnl) : ''">
          <div class="k">持仓浮盈</div>
          <div class="v">
            {{ pos.length ? signedMoney(posPnl) : '—' }}
          </div>
          <div class="sub">
            {{ pos.length ? `${pos.length} 个持仓（多 ${posLong} · 空 ${pos.length - posLong}）` : '当前无持仓' }}
          </div>
        </div>
        <div class="card" :class="income.length ? tone(incomeTotal) : ''">
          <div class="k">已实现盈亏</div>
          <div class="v">
            {{ income.length ? signedNum(incomeTotal) : '—' }}
          </div>
          <div class="sub">
            {{ income.length ? `最近 ${income.length} 笔 · USDT` : data.income ? '还没有记录' : '该账户无此数据' }}
          </div>
        </div>
        <div class="card">
          <div class="k">当前挂单</div>
          <div class="v">{{ openOrders.length }}</div>
          <div class="sub">
            {{ orderGroups.length ? `${orderGroups.length} 个交易对` : '没有挂单' }}
          </div>
        </div>
      </div>

      <!-- ③ 二级 tab -->
      <SegTabs v-if="data" v-model="tab" :options="tabs" />

      <!-- ④ 内容 -->
      <template v-if="data">
        <!-- 余额 -->
        <section v-show="tab === 'bal'" class="panel">
          <div class="pn-h">
            <h2>余额</h2>
            <span class="dim tiny">
              {{ balVisible.length }} 个币{{ split.skipped ? ` · ${split.skipped} 个无价` : '' }}
            </span>
            <span class="spacer" />
            <button
              v-if="dustCount"
              class="ghost tiny"
              :class="{on: showDust}"
              @click="showDust = !showDust"
            >
              {{ showDust ? '隐藏' : '显示' }}小额 {{ dustCount }}
            </button>
          </div>

          <ul v-if="balShown.length" class="coins">
            <li v-for="r in balShown" :key="r.currency">
              <span class="ci" :style="{background: colorOf(r.currency)}">
                {{ r.currency.slice(0, 1) }}
              </span>
              <div class="cm">
                <div class="cm-1">
                  {{ r.currency }}
                  <span v-if="r.used > 0" class="dim tiny">占用中</span>
                </div>
                <div class="cm-2">
                  可用 {{ qty(r.free) }}
                  <span v-if="r.used > 0">· 占用 {{ qty(r.used) }}</span>
                </div>
                <div class="bar">
                  <i
                    :style="{
                      width: share(r.usdt ?? 0, bal?.totalUsdt ?? 0) + '%',
                      background: colorOf(r.currency)
                    }"
                  />
                </div>
              </div>
              <div class="cr">
                <b>{{ qty(r.total) }}</b>
                <span class="usd">{{ r.usdt === null ? '—' : money(r.usdt) }}</span>
                <span class="pc">
                  {{ r.usdt === null ? '—' : share(r.usdt, bal?.totalUsdt ?? 0) }}
                </span>
              </div>
            </li>
          </ul>
          <p v-else class="dim">余额为 0</p>

          <button
            v-if="balVisible.length > BAL_HEAD"
            class="ghost tiny more"
            @click="showAllBal = !showAllBal"
          >
            {{ showAllBal ? '收起' : `展开全部 ${balVisible.length} 个` }}
          </button>
        </section>

        <!-- 持仓 -->
        <section v-show="tab === 'pos'" class="panel">
          <div class="pn-h">
            <h2>当前持仓</h2>
            <span class="dim tiny">{{ pos.length }} 个</span>
            <span class="spacer" />
            <span v-if="pos.length" class="pnl" :class="tone(posPnl)">
              {{ signedMoney(posPnl) }}
            </span>
          </div>
          <p v-if="props.data?.positionsError" class="err">
            {{ props.data.positionsError }}
          </p>
          <ul v-else-if="pos.length" class="poss">
            <li v-for="p in pos" :key="p.symbol + p.side">
              <div class="p-h">
                <span class="sym">{{ p.symbol }}</span>
                <span class="side" :class="p.side.toLowerCase() === 'short' ? 'sell' : 'buy'">
                  {{ posText(p.side) }}
                </span>
                <span v-if="p.leverage" class="lev">{{ p.leverage }}x</span>
                <span class="spacer" />
                <span class="pnl" :class="tone(p.unrealizedPnl)">
                  {{ signedMoney(p.unrealizedPnl) }}
                  <em v-if="p.percentage !== null">
                    {{ p.percentage >= 0 ? '+' : '−' }}{{ fixed(Math.abs(p.percentage), 2) }}%
                  </em>
                </span>
              </div>
              <div class="kv">
                <div>
                  <span class="k">数量</span><b>{{ qty(p.contracts) }}</b>
                </div>
                <div>
                  <span class="k">开仓价</span><b>{{ fmt(p.entryPrice) }}</b>
                </div>
                <div>
                  <span class="k">标记价</span><b>{{ fmt(p.markPrice) }}</b>
                </div>
                <div v-if="p.liquidationPrice">
                  <span class="k">强平价</span>
                  <b class="warn">{{ fmt(p.liquidationPrice) }}</b>
                </div>
              </div>
              <div class="p-f">
                <span v-if="p.notional">名义 {{ money(p.notional) }}</span>
                <!-- 幅值就行：多仓的强平价在下面、空仓在上面，方向自明；带负号反而费解 -->
                <span
                  v-if="liqGap(p) !== null"
                  :class="Math.abs(liqGap(p)!) < 5 ? 'warn' : 'dim'"
                >
                  距强平 {{ Math.abs(liqGap(p)!).toFixed(1) }}%
                </span>
              </div>
            </li>
          </ul>
          <p v-else class="dim">
            {{ isSpot ? '现货账户没有持仓' : '当前无持仓' }}
          </p>
        </section>

        <!-- 挂单 -->
        <section v-show="tab === 'ord'" class="panel">
          <div class="pn-h">
            <h2>当前挂单</h2>
            <span class="dim tiny">{{ openOrders.length }} 个</span>
          </div>
          <p v-if="props.data?.openOrdersError" class="err">
            {{ props.data.openOrdersError }}
          </p>
          <div v-else-if="orderGroups.length" class="grps">
            <div v-for="g in orderGroups" :key="g.symbol" class="grp">
              <div class="grp-h">
                <span class="sym">{{ g.symbol }}</span>
                <span class="spacer" />
                <span class="dim tiny">{{ g.rows.length }} 单</span>
              </div>
              <ul class="rows">
                <li v-for="o in g.rows" :key="o.id">
                  <span class="side" :class="o.side.toLowerCase() === 'buy' ? 'buy' : 'sell'">
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
            <span v-if="income.length" class="pnl" :class="tone(incomeTotal)">
              {{ signedNum(incomeTotal) }} USDT
            </span>
          </div>
          <p v-if="props.data?.incomeError" class="err">{{ props.data.incomeError }}</p>
          <template v-else-if="income.length">
            <ul class="incs">
              <li v-for="g in incomeGroups" :key="g.symbol">
                <span class="ci sm" :style="{background: colorOf(g.symbol)}" />
                <span class="sym">{{ g.symbol }}</span>
                <span class="dim tiny">{{ g.count }} 笔</span>
                <span class="spacer" />
                <span class="pnl" :class="tone(g.sum)">{{ signedNum(g.sum) }}</span>
              </li>
            </ul>
            <p class="sub-h dim tiny">最近明细</p>
            <ul class="rows">
              <li v-for="(r, i) in income.slice(0, 10)" :key="i">
                <span class="sym">{{ r.symbol || '—' }}</span>
                <span class="spacer" />
                <span class="pnl" :class="tone(r.income)">{{ signedNum(r.income) }}</span>
                <span class="dim tiny">{{ r.time ? bjTime(r.time) : '' }}</span>
              </li>
            </ul>
          </template>
          <p v-else-if="data.income" class="dim">还没有已实现盈亏</p>
          <p v-else class="dim">
            {{ isSpot ? '现货账户没有这一项' : '这个交易所不提供已实现盈亏' }}
          </p>
        </section>

        <!-- 订单 / 成交 -->
        <section v-show="tab === 'hist'" class="panel">
          <div class="pn-h">
            <h2>{{ isTrades ? '成交记录' : '订单历史' }}</h2>
            <span class="spacer" />
            <span class="dim tiny">{{ orderRows.length }} 条</span>
          </div>

          <div class="ord-search">
            <input
              :value="symbol ?? ''"
              type="text"
              spellcheck="false"
              placeholder="交易对，如 BTC/USDT"
              @input="emit('update:symbol', ($event.target as HTMLInputElement).value)"
              @keyup.enter="emit('search', symbol ?? '')"
            />
            <button class="ghost tiny" :disabled="loading" @click="emit('search', symbol ?? '')">
              查
            </button>
          </div>

          <p v-if="props.data?.ordersError" class="err">
            {{ props.data.ordersError }}
          </p>
          <p v-else-if="orders?.needSymbol && !orderRows.length" class="hint">
            这个交易所要指定交易对才能查订单。填一个（如 BTC/USDT）再点「查」。
          </p>
          <template v-else-if="orderRows.length">
            <p v-if="orders?.tried?.length" class="hint">
              已查：{{ orders.tried.join('、') }}
            </p>
            <ul class="rows trades">
              <li v-for="(o, i) in orderRows" :key="o.id || i">
                <div class="t-line">
                  <span class="side" :class="o.side.toLowerCase() === 'buy' ? 'buy' : 'sell'">
                    {{ sideText(o.side) }}
                  </span>
                  <span class="sym">{{ o.symbol }}</span>
                  <span class="spacer" />
                  <span class="num">{{ fmt(o.price) }}</span>
                </div>
                <div class="t-sub dim tiny">
                  <span>量 {{ qty(o.amount) }}</span>
                  <span>额 {{ fmt(o.cost) }}</span>
                  <span v-if="o.fee">费 {{ fmt(o.fee, 4) }} {{ o.feeCurrency }}</span>
                  <span class="spacer" />
                  <span>{{ o.datetime ? bjTime(o.datetime) : '' }}</span>
                </div>
              </li>
            </ul>
          </template>
          <p v-else class="dim">还没有记录</p>
        </section>
      </template>
    </template>
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
.err {
  margin: 0;
  color: var(--bad, #e55361);
  font-size: 12.5px;
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
  margin: 6px 0;
  font-size: 13px;
}

/* ---------------- 总览 ---------------- */

.ov-h {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ov-k {
  font-size: 12px;
  color: var(--muted);
}
.ov-v {
  margin-top: 2px;
  font-size: 30px;
  font-weight: var(--fw-mid, 600);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}
.ov-s {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 3px;
  font-size: 12px;
  color: var(--muted);
}
.ov-s b {
  color: var(--text);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.ov-s .sep {
  opacity: 0.5;
}
.ov-t {
  margin: 8px 0 0;
  text-align: right;
}
/* 分布条：一根横条按占比切段（最窄 0.6% 保证看得见） */
.alloc {
  display: flex;
  gap: 2px;
  height: 8px;
  margin-top: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--panel-2);
}
.alloc i {
  display: block;
  height: 100%;
}
.alloc-lg {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 2px 12px;
}
.alloc-lg li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}
.alloc-lg i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.alloc-lg .lb {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.alloc-lg b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.alloc-lg .pc {
  min-width: 44px;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ---------------- 各 tab 的小标题 ---------------- */

.pn-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.pn-h h2 {
  margin: 0;
  font-size: 14px;
}
.sub-h {
  margin: 12px 0 2px;
}

/* ---------------- 余额列表 ---------------- */

.coins {
  list-style: none;
  margin: 0;
  padding: 0;
}
.coins li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.16));
}
.coins li:first-child {
  border-top: 0;
}
/* 币种色块：用名字哈希上色，跟分布条同一个色 */
.ci {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: #0f1216;
}
.ci.sm {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.cm {
  flex: 1 1 auto;
  min-width: 0;
}
.cm-1 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: var(--fw-mid, 500);
}
.cm-2 {
  margin-top: 1px;
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  height: 3px;
  margin-top: 5px;
  border-radius: 999px;
  background: var(--panel-2);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
}
.cr {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  /* 位宽定死，一列数字才对得齐（`--mono` 只是让数字本身等宽） */
  min-width: 92px;
}
.cr b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 13px;
}
.cr .usd {
  font-size: 11.5px;
  color: var(--muted);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.cr .pc {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.more {
  display: block;
  width: 100%;
  margin-top: 10px;
}

/* ---------------- 持仓 ---------------- */

.poss {
  list-style: none;
  margin: 0;
  padding: 0;
}
.poss li {
  padding: 10px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.16));
}
.poss li:first-child {
  border-top: 0;
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
  grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
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

/* ---------------- 列表行（挂单 / 盈亏明细 / 成交） ---------------- */

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
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rows li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12.5px;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.12));
}
.rows li:first-child {
  border-top: 0;
}
.incs {
  list-style: none;
  margin: 0;
  padding: 0;
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
/* 成交：一行主信息 + 一行小字 */
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
.ord-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ord-search input {
  flex: 1 1 auto;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 13px;
}
.ghost.on {
  color: var(--blue, #d3b583);
  border-color: var(--blue, #d3b583);
}
</style>
