<script setup lang="ts">
/**
 * **周期复盘**（2026-10-22 晚，按用户要求整体重做）。
 *
 * 用户原话：
 *   「每笔和总结去掉，我可以自定义选择一段周期的时间进行总结。补历史去掉、默认同步去掉。
 *     下拉框都采用自定义样式……文字之间看上去没有差异化，能不能每一个里面都有一个小方块。」
 *
 * 所以这一页只有一件事：**选一个时间范围 → 看这一段的总结**。
 *   · 没有「每笔 / 总结」两个 tab；
 *   · 没有「补历史」按钮，也没有后台每分钟同步 —— 数据直接从成交账本算
 *     （后端 `summarizeRange`，不读 `trade_reviews`）；
 *   · 账户 / 周期都用自定义控件（`SelectPick` + `LedgerRangeSheet`），不用原生 `<select>`。
 */
import {computed, onMounted, ref} from 'vue'
import SelectPick from '../comps/SelectPick.vue'
import LedgerRangeSheet from '../comps/LedgerRangeSheet.vue'
import {
  fetchRangeSummary,
  fetchPositionCycles,
  type RangeSummary,
  type ReviewAccount,
  type CycleDetail
} from '../api'
import {fixed} from '../format'
import {rangeToInterval, bjDayValue, type RangeKey} from '../ledger'

const summary = ref<RangeSummary | null>(null)
const accounts = ref<ReviewAccount[]>([])
const keyId = ref<number | null>(null)
const loading = ref(false)
const error = ref('')

/** 周期：默认近 90 天（够覆盖全部历史；要更窄再选） */
const rangeKey = ref<RangeKey>('90d')
const fromMs = ref<number | null>(null)
const toMs = ref<number | null>(null)
const sheetOpen = ref(false)

/* 仓位明细（单位是仓位周期，不是单张成交） */
const cycles = ref<CycleDetail[]>([])
const openId = ref<string | null>(null)

const accountOptions = computed(() => [
  {value: 'all', label: '全部账户'},
  ...accounts.value.map(a => ({value: String(a.id), label: a.name}))
])

const accountValue = computed(() => (keyId.value ? String(keyId.value) : 'all'))

const rangeLabel = computed(() => {
  if (rangeKey.value !== 'custom') {
    const map: Record<string, string> = {
      today: '今天',
      '7d': '近 7 天',
      '30d': '近 30 天',
      '90d': '近 90 天'
    }
    return map[rangeKey.value] ?? '全部时间'
  }
  const {from, to} = rangeToInterval('custom', bjDayValue(fromMs.value), bjDayValue(toMs.value))
  if (!from || !to) return '全部时间'
  const p = (n: number) => String(n).padStart(2, '0')
  const d = (ms: number) => {
    const x = new Date(ms)
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
  }
  return `${d(from)} → ${d(to)}`
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const {from, to} = rangeToInterval(
      rangeKey.value,
      bjDayValue(fromMs.value),
      bjDayValue(toMs.value)
    )
    const [r, c] = await Promise.all([
      fetchRangeSummary({from: from ?? null, to: to ?? null, keyId: keyId.value}),
      fetchPositionCycles({from: from ?? null, to: to ?? null, keyId: keyId.value, limit: 200})
    ])
    summary.value = r.summary
    cycles.value = c.cycles
    if (r.accounts?.length) accounts.value = r.accounts
  } catch (e) {
    error.value = (e as Error)?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function pickAccount(v: string): void {
  keyId.value = v === 'all' ? null : Number(v)
  void load()
}

function applyRange(p: {range: RangeKey; from: number | null; to: number | null}): void {
  rangeKey.value = p.range
  fromMs.value = p.from
  toMs.value = p.to
  sheetOpen.value = false
  void load()
}

function rate(v: number): string {
  return `${Math.round(v * 100)}%`
}

/** 秒 → 人话（不足 1 分钟显示秒，别显示成「0 分钟」） */
function durText(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec < 60) return `${Math.round(sec)} 秒`
  const m = sec / 60
  if (m < 60) return `${Math.round(m)} 分钟`
  return holdText(Math.round(m))
}

function holdText(min: number): string {
  if (min < 60) return `${min} 分钟`
  if (min < 1440) return `${fixed(min / 60, 1)} 小时`
  return `${fixed(min / 1440, 1)} 天`
}

function toneOf(net: number): 'ok' | 'bad' | '' {
  return net > 0 ? 'ok' : net < 0 ? 'bad' : ''
}

function toggle(c: CycleDetail): void {
  const k = keyOfCycle(c)
  openId.value = openId.value === k ? null : k
}

/** 仓位周期的 key（同币同方向同开仓时刻） */
function keyOfCycle(c: CycleDetail): string {
  return `${c.symbol}|${c.side}|${c.openAt}`
}

/** `10-20 18:31` */
function mdhm(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 价格小数位：跟着量级走（0.0393 要 4~6 位，110000 要 1 位） */
function px(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1000) return v.toFixed(1)
  if (a >= 1) return v.toFixed(3)
  if (a >= 0.01) return v.toFixed(5)
  return v.toFixed(7)
}

/** 百分比带符号 */
function pctText(v: number | null): string {
  if (v === null) return '无分钟级数据'
  return `${v >= 0 ? '+' : ''}${fixed(v, 2)}%`
}

onMounted(load)
</script>

<template>
  <section class="rv">
    <!-- 工具条：账户 / 周期 / 条数 -->
    <header class="bar">
      <SelectPick
        v-if="accounts.length > 1"
        :model-value="accountValue"
        :options="accountOptions"
        aria-label="账户"
        @update:model-value="pickAccount"
      />
      <button type="button" class="range" @click="sheetOpen = true">
        <span class="dot" />
        {{ rangeLabel }}
        <span class="caret">▾</span>
      </button>
      <span class="n">{{ summary?.count ?? 0 }} 笔</span>
    </header>

    <p v-if="error" class="notice bad">{{ error }}</p>
    <p v-else-if="loading" class="notice">读取中…</p>
    <p v-else-if="summary && !summary.count" class="notice">这段时间没有已平仓的单子。</p>

    <template v-if="summary && summary.count">
      <!-- ① 四个数：净利 / 胜率 / 盈亏比 / 手续费 -->
      <div class="kpis">
        <div class="kpi" :class="toneOf(summary.net)">
          <span class="chip" />
          <span class="k">净利</span>
          <span class="v">
            {{ summary.net >= 0 ? '+' : '' }}{{ fixed(summary.net, 2) }}
            <em>U</em>
          </span>
        </div>
        <div class="kpi">
          <span class="chip" />
          <span class="k">胜率</span>
          <span class="v">{{ rate(summary.winRate) }}</span>
        </div>
        <div class="kpi">
          <span class="chip" />
          <span class="k">盈亏比</span>
          <span class="v">{{ fixed(summary.payoff, 2) }}</span>
        </div>
        <div class="kpi">
          <span class="chip" />
          <span class="k">手续费</span>
          <span class="v">{{ fixed(summary.fee, 2) }}</span>
        </div>
      </div>

      <!-- ② 副指标：一行，小字 -->
      <div class="sub">
        <span><b>毛利</b>{{ fixed(summary.grossProfit, 2) }}</span>
        <span><b>毛损</b>{{ fixed(summary.grossLoss, 2) }}</span>
        <span><b>中位持仓</b>{{ holdText(summary.medianHoldMin) }}</span>
        <span><b>最大单笔</b>{{ fixed(summary.maxWin, 2) }}</span>
        <span><b>最惨单笔</b>{{ fixed(summary.maxLoss, 2) }}</span>
      </div>

      <!-- ③ 按持仓时长 -->
      <section class="block">
        <h3>按持仓时长</h3>
        <div class="rows">
          <div v-for="b in summary.byHold" :key="b.key" class="row">
            <span class="sq" :class="toneOf(b.net)" />
            <span class="name">{{ b.label }}</span>
            <span class="num">{{ b.count }} 笔</span>
            <span class="num">{{ b.count ? rate(b.wins / b.count) : '—' }}</span>
            <span class="amt" :class="toneOf(b.net)">
              {{ b.net >= 0 ? '+' : '' }}{{ fixed(b.net, 2) }}
            </span>
          </div>
        </div>
      </section>

      <!-- ④ 按方向 -->
      <section class="block">
        <h3>按方向</h3>
        <div class="rows">
          <div v-for="b in summary.bySide" :key="b.key" class="row">
            <span class="sq" :class="toneOf(b.net)" />
            <span class="name">{{ b.label }}</span>
            <span class="num">{{ b.count }} 笔</span>
            <span class="num">{{ b.count ? rate(b.wins / b.count) : '—' }}</span>
            <span class="amt" :class="toneOf(b.net)">
              {{ b.net >= 0 ? '+' : '' }}{{ fixed(b.net, 2) }}
            </span>
          </div>
        </div>
      </section>

      <!-- ⑤ 赚最多 / 亏最多 -->
      <div class="cols">
        <section class="block">
          <h3>赚最多</h3>
          <div class="rows">
            <div v-for="b in summary.topSymbols" :key="b.key" class="row">
              <span class="sq ok" />
              <span class="name">{{ b.label }}</span>
              <span class="num">{{ b.count }} 笔</span>
              <span class="amt ok">+{{ fixed(b.net, 2) }}</span>
            </div>
          </div>
        </section>
        <section class="block">
          <h3>亏最多</h3>
          <div class="rows">
            <div v-for="b in summary.worstSymbols" :key="b.key" class="row">
              <span class="sq bad" />
              <span class="name">{{ b.label }}</span>
              <span class="num">{{ b.count }} 笔</span>
              <span class="amt bad">{{ fixed(b.net, 2) }}</span>
            </div>
          </div>
        </section>
      </div>
    </template>

    <!-- ⑥ 仓位明细：单位是「仓位周期」，不是单张成交 -->
    <section v-if="cycles.length" class="block">
      <h3>
        仓位明细
        <em class="cnt">{{ cycles.length }}</em>
        <span class="hint">点币种展开成交</span>
      </h3>
      <div class="rows">
        <div
          v-for="c in cycles"
          :key="keyOfCycle(c)"
          class="cyc"
          :class="toneOf(c.net)"
        >
          <div class="cyc-head">
            <span class="sq" :class="toneOf(c.net)" />
            <span class="time">{{ mdhm(c.openAt) }}</span>
            <button type="button" class="sym-btn" @click="toggle(c)">
              {{ c.symbol.replace(/USDT$/, '') }}
              <span class="chev" :class="{up: openId === keyOfCycle(c)}">▾</span>
            </button>
            <span class="side" :class="c.side">{{ c.side === 'long' ? '多' : '空' }}</span>
            <span class="num">持仓 {{ durText(c.holdSec) }}</span>
            <span class="amt" :class="toneOf(c.net)">
              {{ c.net >= 0 ? '+' : '' }}{{ fixed(c.net, 2) }}
            </span>
          </div>

          <!-- 第二行：开平 / 张数 / 成交笔数 / 最大浮盈 / 回撤 -->
          <div class="cyc-sub">
            <span>开 {{ px(c.entry) }} → 平 {{ px(c.exit) }}</span>
            <span>{{ fixed(c.qty, 4) }} 张</span>
            <span>{{ c.fills }} 笔成交</span>
            <span :class="c.mfePct !== null && c.mfePct >= 0 ? 'ok' : ''">
              最大浮盈 {{ pctText(c.mfePct) }}
            </span>
            <span :class="c.maePct !== null && c.maePct < 0 ? 'bad' : ''">
              回撤 {{ pctText(c.maePct) }}
            </span>
            <span v-if="c.resolution" class="res">{{ c.resolution }}</span>
          </div>

          <!-- 展开：账目数字 + 逐笔成交 -->
          <div v-if="openId === keyOfCycle(c)" class="cyc-detail">
            <div class="grid">
              <div class="cell"><span class="k">开仓均价</span><b>{{ px(c.entry) }}</b></div>
              <div class="cell"><span class="k">平仓均价</span><b>{{ px(c.exit) }}</b></div>
              <div class="cell"><span class="k">数量</span><b>{{ fixed(c.qty, 4) }}</b></div>
              <div class="cell"><span class="k">杠杆</span><b>{{ c.leverage ? fixed(c.leverage, 0) + '×' : '—' }}</b></div>
              <div class="cell"><span class="k">已实现</span><b>{{ fixed(c.realized, 2) }}</b></div>
              <div class="cell"><span class="k">手续费</span><b>{{ fixed(c.fee, 2) }}</b></div>
              <div class="cell"><span class="k">资金费</span><b>{{ fixed(c.funding, 2) }}</b></div>
              <div class="cell">
                <span class="k">最大浮盈</span>
                <b>
                  {{ c.mfeUsd === null ? '—' : fixed(c.mfeUsd, 2) + ' U' }}
                  <em v-if="c.mfePct !== null">（{{ pctText(c.mfePct) }}）</em>
                </b>
              </div>
              <div class="cell">
                <span class="k">最大回撤</span>
                <b>
                  {{ c.maeUsd === null ? '—' : fixed(c.maeUsd, 2) + ' U' }}
                  <em v-if="c.maePct !== null">（{{ pctText(c.maePct) }}）</em>
                </b>
              </div>
            </div>

            <table class="orders">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>方向</th>
                  <th>数量</th>
                  <th>价格</th>
                  <th>手续费</th>
                  <th>已实现</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(o, i) in c.orders" :key="i">
                  <td>{{ mdhm(o.time) }}</td>
                  <td :class="o.side === 'buy' ? 'ok' : 'bad'">
                    {{ o.side === 'buy' ? '买' : '卖' }}{{ o.reduce ? '（减）' : '' }}
                  </td>
                  <td>{{ fixed(o.amount, 4) }}</td>
                  <td>{{ px(o.price) }}</td>
                  <td>{{ fixed(o.fee, 3) }}</td>
                  <td :class="o.realized > 0 ? 'ok' : o.realized < 0 ? 'bad' : ''">
                    {{ o.realized === 0 ? '—' : fixed(o.realized, 3) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <LedgerRangeSheet
      v-model="sheetOpen"
      title="复盘 · 周期范围"
      :range="rangeKey"
      :from="fromMs"
      :to="toMs"
      :type-filter="false"
      :count="summary?.count ?? null"
      @apply="applyRange"
    />
  </section>
</template>

<style scoped>
.rv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* 外层 `.panel` 已经有内边距了，这里只留一点点，别叠成一大圈 */
  padding: 2px 0;
  min-height: 0;
  overflow-y: auto;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.range {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.range .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.range .caret {
  color: var(--muted);
  font-size: 10px;
}
.n {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}
.notice {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  background: var(--panel);
  color: var(--muted);
  font-size: 12px;
}
.notice.bad {
  color: var(--bad);
  background: var(--bad-soft);
}

/* ---- KPI ---- */
.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 10px;
  border-radius: var(--r-sm);
  background: var(--panel);
}
.kpi .chip {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--muted);
  opacity: 0.55;
}
.kpi.ok .chip {
  background: var(--ok);
  opacity: 1;
}
.kpi.bad .chip {
  background: var(--bad);
  opacity: 1;
}
.kpi .k {
  font-size: 11px;
  color: var(--muted);
}
.kpi .v {
  font-family: var(--mono);
  font-size: 17px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.3px;
}
.kpi .v em {
  font-style: normal;
  font-size: 10px;
  font-weight: var(--fw-normal);
  opacity: 0.55;
  margin-left: 2px;
}
.kpi.ok .v {
  color: var(--ok);
}
.kpi.bad .v {
  color: var(--bad);
}

.sub {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}
.sub b {
  color: var(--dim);
  font-weight: var(--fw-normal);
  margin-right: 4px;
}

/* ---- 分组 ---- */
.block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.block h3 {
  margin: 0;
  font-size: 11px;
  font-weight: var(--fw-normal);
  color: var(--muted);
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--r-sm);
  background: var(--panel);
  font-size: 12px;
}
/* 每一条前面的小方块：绿=赚、红=亏、灰=没有 */
.sq {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 2px;
  background: var(--muted);
  opacity: 0.45;
}
.sq.ok {
  background: var(--ok);
  opacity: 1;
}
.sq.bad {
  background: var(--bad);
  opacity: 1;
}
.row .name {
  min-width: 96px;
}
.row .num {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}
.row .amt {
  margin-left: auto;
  font-family: var(--mono);
  font-weight: var(--fw-mid);
}
.amt.ok {
  color: var(--ok);
}
.amt.bad {
  color: var(--bad);
}
.cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

/* ---- 仓位明细 ---- */
.block h3 .cnt {
  font-style: normal;
  color: var(--dim);
  margin-left: 6px;
}
.block h3 .hint {
  margin-left: 8px;
  color: var(--dim);
  font-size: 10px;
}
.cyc {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border-radius: var(--r-sm);
  background: var(--panel);
}
.cyc-head {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
}
/* 只有币种可点：点开看这一段的成交明细 */
.sym-btn {
  background: none;
  border: 0;
  padding: 0;
  color: var(--text);
  font: inherit;
  font-weight: var(--fw-mid);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 62px;
}
.sym-btn:hover {
  color: var(--accent);
}
.cyc-head .time {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}
.cyc-head .side {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
}
.cyc-head .side.long {
  color: var(--ok);
  background: var(--ok-soft);
}
.cyc-head .side.short {
  color: var(--bad);
  background: var(--bad-soft);
}
.cyc-head .num {
  font-size: 11px;
  color: var(--muted);
}
.cyc-head .amt {
  margin-left: auto;
  font-family: var(--mono);
  font-weight: var(--fw-bold);
}
.cyc-head .chev {
  color: var(--muted);
  font-size: 9px;
  transition: transform 0.15s;
}
.cyc-head .chev.up {
  transform: rotate(180deg);
}
.cyc-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
}
.cyc-sub .ok {
  color: var(--ok);
}
.cyc-sub .bad {
  color: var(--bad);
}
.cyc-sub .res {
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  color: var(--dim);
}
.cyc-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.cyc-detail .grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 12px;
}
.cyc-detail .cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cyc-detail .k {
  font-size: 10px;
  color: var(--muted);
}
.cyc-detail b {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: var(--fw-mid);
}
.cyc-detail b em {
  font-style: normal;
  font-weight: var(--fw-normal);
  color: var(--muted);
  font-size: 10px;
}
.orders {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  font-family: var(--mono);
}
.orders th,
.orders td {
  text-align: right;
  padding: 4px 6px;
  border-bottom: 1px solid var(--line);
}
.orders th:first-child,
.orders td:first-child {
  text-align: left;
}
.orders th {
  color: var(--muted);
  font-weight: var(--fw-normal);
}
.orders .ok {
  color: var(--ok);
}
.orders .bad {
  color: var(--bad);
}

@media (max-width: 720px) {
  .kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
