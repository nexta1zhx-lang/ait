<script setup lang="ts">
/**
 * 「开单分析 → 交易所账户」。
 *
 * 用户 2026-10-04：「实时分析 tab 后加入交易所账户信息，显示账户余额和订单历史」。
 *
 * 数据来自绑在「我的 → 个人信息 → 交易所」里的**多套** API Key；
 * 这里有个下拉切换看哪一套，默认落在「默认」那套上。
 * 只读：查余额 + 订单历史，不下单。
 *
 * ⚠️ 组件在切到这一格时用 `v-if` 挂着（见 AnalyzeView），
 * 切走就卸载 —— 它自己不轮询，所以不会在后台白打交易所。
 */
import {computed, onMounted, ref} from 'vue'
import {
  fetchExchangeAccount,
  fetchExchangeKeys,
  type ExchangeAccountResult,
  type ExchangeKey
} from '../api'
import {bjTime, fixed, fmt, usd} from '../format'

const keys = ref<ExchangeKey[]>([])
const selectedId = ref<number | null>(null)
const data = ref<ExchangeAccountResult | null>(null)
/** 订单要查哪个交易对（币安这类必须给；留空就先试全量 / 按持仓推） */
const orderSymbol = ref('')

const loading = ref(false)
/** 拉列表（哪几套账户）失败 */
const listErr = ref('')
/** 查余额 / 订单失败 */
const queryErr = ref('')

const selected = computed(
  () => keys.value.find(k => k.id === selectedId.value) ?? null
)

const balanceRows = computed(() => data.value?.balance?.rows ?? [])
const orderRows = computed(() => data.value?.orders?.rows ?? [])
/** 当前持仓 */
const positions = computed(() => data.value?.positions ?? [])
/** 当前挂单（不需要交易对） */
const openOrders = computed(() => data.value?.openOrders ?? [])
/** 已实现盈亏（币安合约才有） */
const incomeRows = computed(() => data.value?.income ?? [])
const incomeTotal = computed(() =>
  incomeRows.value.reduce((s, r) => s + r.income, 0)
)

/** 选中的这套还没填 Key —— 不用去问交易所，直接提示去绑 */
const needsSetup = computed(
  () => Boolean(selected.value) && !selected.value?.apiKeySet
)

function labelOf(k: ExchangeKey): string {
  return k.name || k.exchange
}

/** 先把「有哪几套账户」拉回来，再查默认那套的余额 / 订单 */
async function boot(): Promise<void> {
  listErr.value = ''
  try {
    const r = await fetchExchangeKeys()
    keys.value = r.keys
    // 优先落在「默认」那套；没有就第一套
    const def = r.keys.find(k => k.isDefault) ?? r.keys[0]
    selectedId.value = def?.id ?? null
  } catch (e) {
    listErr.value = (e as Error).message
    return
  }
  await load()
}

async function load(): Promise<void> {
  if (selectedId.value === null || needsSetup.value) {
    data.value = null
    queryErr.value = ''
    return
  }
  loading.value = true
  queryErr.value = ''
  try {
    data.value = await fetchExchangeAccount(
      selectedId.value,
      50,
      orderSymbol.value.trim() || undefined
    )
  } catch (e) {
    queryErr.value = (e as Error).message
    data.value = null
  } finally {
    loading.value = false
  }
}

/** 换一套账户看 */
function pick(id: number): void {
  selectedId.value = id
  data.value = null
  orderSymbol.value = ''
  void load()
}

/** 按键 / 点「查订单」：用输入的交易对重查 */
function searchOrders(): void {
  void load()
}

/** 订单方向：买绿卖红 */
function sideCls(side: string): string {
  const s = side.toLowerCase()
  if (s === 'buy') return 'buy'
  if (s === 'sell') return 'sell'
  return ''
}

/** 持仓方向：多绿空红 */
function posCls(side: string): string {
  return side.toLowerCase() === 'short' ? 'sell' : 'buy'
}
function posText(side: string): string {
  return side.toLowerCase() === 'short' ? '空' : '多'
}

onMounted(boot)
</script>

<template>
  <div class="exch-acc">
    <p v-if="listErr" class="err">{{ listErr }}</p>

    <!-- 一套都没绑：给个去绑的指引 -->
    <section v-if="!listErr && !keys.length" class="panel">
      <h2>交易所账户</h2>
      <p class="hint">
        还没绑定交易所。去
        <RouterLink to="/me?p=profile">我的 → 个人信息 → 账户信息 → 交易所</RouterLink>
        绑一套 API Key，这里就能看余额和订单历史了。
      </p>
    </section>

    <template v-else-if="keys.length">
      <!-- 顶部：选哪一套 + 刷新 -->
      <div class="acc-bar">
        <select
          class="acc-pick"
          :value="selectedId ?? undefined"
          @change="pick(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="k in keys" :key="k.id" :value="k.id">
            {{ labelOf(k) }}{{ k.isDefault ? ' · 默认' : '' }}
          </option>
        </select>
        <button class="ghost tiny" :disabled="loading" @click="load">
          {{ loading ? '查询中…' : '刷新' }}
        </button>
      </div>

      <!-- 选中的这套还没填 Key：直接给去绑的指引 -->
      <section v-if="needsSetup" class="panel">
        <h2>交易所账户</h2>
        <p class="hint">
          已选的「{{ labelOf(selected!) }}」这套<b>还没填 API Key / Secret</b>。
          去
          <RouterLink to="/me?p=profile"
            >我的 → 个人信息 → 账户信息 → 交易所</RouterLink
          >
          填上，或换上面下拉里的另一套。
        </p>
      </section>

      <p v-else-if="queryErr" class="err">{{ queryErr }}</p>

      <template v-else>
      <!-- 余额 -->
      <section class="panel">
        <h2>
          账户余额
          <small v-if="selected">
            {{ selected.exchange }} · {{ selected.marketType === 'spot' ? '现货' : '合约' }}
          </small>
        </h2>

        <p v-if="loading && !data" class="dim">查询中…</p>
        <p v-else-if="data?.balanceError" class="err">
          {{ data.balanceError }}
        </p>

        <template v-else-if="data?.balance">
          <div class="total">
            <span class="k">合计估值</span>
            <b>{{ usd(data.balance.totalUsdt) }}</b>
            <span v-if="data.balance.partial" class="dim tiny">
              （部分币查不到价，没算进去）
            </span>
          </div>
          <ul v-if="balanceRows.length" class="bal">
            <li v-for="r in balanceRows" :key="r.currency">
              <span class="cur">{{ r.currency }}</span>
              <span class="pair">
                <span class="dim">可用</span> {{ fmt(r.free) }}
                <span class="dim">占用</span> {{ fmt(r.used) }}
              </span>
              <span class="amt">{{ fmt(r.total) }}</span>
              <span class="usdt dim">
                {{ r.usdt === null ? '—' : usd(r.usdt) }}
              </span>
            </li>
          </ul>
          <p v-else class="dim">余额为 0</p>
        </template>
      </section>

      <!-- 当前持仓（合约） -->
      <section class="panel">
        <h2>
          当前持仓
          <small v-if="positions.length">{{ positions.length }} 个</small>
        </h2>
        <p v-if="loading && !data" class="dim">查询中…</p>
        <p v-else-if="data?.positionsError" class="err">
          {{ data.positionsError }}
        </p>
        <ul v-else-if="positions.length" class="ords">
          <li v-for="p in positions" :key="p.symbol + p.side">
            <div class="o-top">
              <span class="sym">{{ p.symbol }}</span>
              <span class="side" :class="posCls(p.side)">{{ posText(p.side) }}</span>
              <span v-if="p.leverage" class="dim tiny">{{ p.leverage }}x</span>
              <span class="spacer" />
              <span class="pnl" :class="p.unrealizedPnl >= 0 ? 'up' : 'down'">
                {{ p.unrealizedPnl >= 0 ? '+' : '' }}{{ fmt(p.unrealizedPnl) }}
                <em v-if="p.percentage !== null">
                  ({{ p.percentage >= 0 ? '+' : '' }}{{ fixed(p.percentage, 2) }}%)
                </em>
              </span>
            </div>
            <div class="o-sub">
              <span>数量 {{ fmt(p.contracts) }}</span>
              <span>开仓 {{ fmt(p.entryPrice) }}</span>
              <span>标记 {{ fmt(p.markPrice) }}</span>
              <span v-if="p.liquidationPrice">强平 {{ fmt(p.liquidationPrice) }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="dim">当前无持仓</p>
      </section>

      <!-- 当前挂单（币安合约不需要交易对） -->
      <section class="panel">
        <h2>
          当前挂单
          <small v-if="openOrders.length">{{ openOrders.length }} 个</small>
        </h2>
        <p v-if="loading && !data" class="dim">查询中…</p>
        <p v-else-if="data?.openOrdersError" class="err">
          {{ data.openOrdersError }}
        </p>
        <ul v-else-if="openOrders.length" class="ords">
          <li v-for="(o, i) in openOrders" :key="o.id || i">
            <div class="o-top">
              <span class="sym">{{ o.symbol }}</span>
              <span class="side" :class="sideCls(o.side)">
                {{ o.side === 'buy' ? '买' : o.side === 'sell' ? '卖' : o.side }}
              </span>
              <span class="dim tiny">{{ o.type }}</span>
              <span class="spacer" />
              <span class="dim tiny" v-if="o.datetime">
                {{ bjTime(o.datetime) }}
              </span>
            </div>
            <div class="o-sub">
              <span>价 {{ fmt(o.price) }}</span>
              <span>量 {{ fmt(o.amount) }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="dim">当前没有挂单</p>
      </section>

      <!-- 已实现盈亏（币安合约专属；别的交易所没有这块） -->
      <section v-if="data?.income" class="panel">
        <h2>
          已实现盈亏
          <small :class="incomeTotal >= 0 ? 'up' : 'down'">
            {{ incomeTotal >= 0 ? '+' : '' }}{{ fmt(incomeTotal) }} USDT
          </small>
        </h2>
        <ul v-if="incomeRows.length" class="ords">
          <li v-for="(r, i) in incomeRows" :key="i">
            <div class="o-top">
              <span class="sym">{{ r.symbol || '—' }}</span>
              <span class="spacer" />
              <span class="pnl" :class="r.income >= 0 ? 'up' : 'down'">
                {{ r.income >= 0 ? '+' : '' }}{{ fmt(r.income) }}
              </span>
            </div>
            <div class="o-sub">
              <span v-if="r.time" class="dim">{{ bjTime(r.time) }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="dim">还没有已实现盈亏</p>
      </section>

      <!-- 订单历史 -->
      <section class="panel">
        <h2>
          {{ data?.orders?.kind === 'trades' ? '成交记录' : '订单历史' }}
          <small v-if="orderRows.length">最近 {{ orderRows.length }} 条</small>
        </h2>

        <!-- 币安这类必须指定交易对才给订单 -->
        <div class="ord-search">
          <input
            v-model="orderSymbol"
            type="text"
            spellcheck="false"
            placeholder="交易对，如 BTC/USDT"
            @keyup.enter="searchOrders"
          />
          <button class="ghost tiny" :disabled="loading" @click="searchOrders">
            查订单
          </button>
        </div>
        <p v-if="data?.orders?.needSymbol" class="hint">
          这个交易所要指定交易对才能查订单。填一个（如 BTC/USDT）再点「查订单」；
          账户里有余额时会自动按持仓的币查。
        </p>
        <p
          v-else-if="data?.orders?.tried?.length"
          class="hint"
        >
          已查：{{ data.orders.tried.join('、') }}
        </p>

        <p v-if="loading && !data" class="dim">查询中…</p>
        <p v-else-if="data?.ordersError" class="err">{{ data.ordersError }}</p>

        <ul v-else-if="orderRows.length" class="ords">
          <li v-for="(o, i) in orderRows" :key="o.id || i">
            <div class="o-top">
              <span class="sym">{{ o.symbol }}</span>
              <span class="side" :class="sideCls(o.side)">
                {{ o.side === 'buy' ? '买' : o.side === 'sell' ? '卖' : o.side }}
              </span>
              <span class="dim tiny">{{ o.type }}</span>
              <span class="spacer" />
              <span class="dim tiny" v-if="o.datetime">
                {{ bjTime(o.datetime) }}
              </span>
            </div>
            <div class="o-sub">
              <span>价 {{ fmt(o.price) }}</span>
              <span>量 {{ fmt(o.amount) }}</span>
              <span>额 {{ fmt(o.cost) }}</span>
              <span v-if="o.fee" class="dim">
                费 {{ fmt(o.fee) }} {{ o.feeCurrency }}
              </span>
              <span v-if="o.status" class="dim">{{ o.status }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="dim">还没有订单</p>
      </section>

      <p v-if="data" class="updated dim tiny">
        更新于 {{ bjTime(data.balance?.updatedAt ?? data.account.updatedAt) }}
      </p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.exch-acc {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
h2 {
  margin: 0 0 10px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
h2 small {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: var(--fw-normal, 400);
}
.hint {
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
}
.err {
  margin: 0;
  color: var(--bad, #e5534b);
  font-size: 12.5px;
}
.tiny {
  font-size: 11.5px;
}
.acc-bar {
  display: flex;
  align-items: center;
  gap: 8px;
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
.acc-pick {
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 9px;
  font-size: 13px;
}
.total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.total .k {
  font-size: 12px;
  color: var(--muted);
}
.total b {
  font-size: 20px;
}
.bal,
.ords {
  list-style: none;
  margin: 0;
  padding: 0;
}
.bal li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.16));
  font-size: 12.5px;
}
.bal li:first-child {
  border-top: 0;
}
.bal .cur {
  font-weight: var(--fw-mid, 500);
  min-width: 44px;
}
.bal .pair {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-size: 11.5px;
}
.bal .amt {
  font-family: var(--mono);
}
.bal .usdt {
  min-width: 66px;
  text-align: right;
}
.ords li {
  padding: 8px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.16));
}
.ords li:first-child {
  border-top: 0;
}
.o-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.o-top .sym {
  font-weight: var(--fw-mid, 500);
  font-size: 13px;
}
.side {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
}
.side.buy {
  color: var(--ok, #5eba89);
  background: var(--ok-soft, rgba(94, 186, 137, 0.14));
}
.side.sell {
  color: var(--bad, #e35561);
  background: var(--bad-soft, rgba(227, 85, 97, 0.14));
}
.spacer {
  flex: 1 1 auto;
}
h2 small.up,
.pnl.up {
  color: var(--ok, #5eba89);
}
h2 small.down,
.pnl.down {
  color: var(--bad, #e35561);
}
.pnl em {
  font-style: normal;
  opacity: 0.75;
  font-size: 10.5px;
}
.o-sub {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--muted);
}
.updated {
  text-align: right;
}
</style>
