<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import StatCards, {type StatCard} from '../comps/StatCards.vue'
import CostTrend from '../comps/CostTrend.vue'
import SegTabs from '../comps/SegTabs.vue'
import DataTable, {type Column} from '../comps/DataTable.vue'
import {
  KIND_TEXT,
  fetchUsageCalls,
  fetchUsageSummary,
  type UsageBucket,
  type UsageRow,
  type UsageSummary
} from '../api'
import DateRangeCalendar from '../comps/DateRangeCalendar.vue'
import IconCalendar from '../comps/IconCalendar.vue'
import {bjTime, cny, int, ms, pct, tok, usd} from '../format'

/**
 * 用量统计。原来是一个独立页签，之后并进「模型配置」；★ 2026-10-12 起它是
 * 「我的 → 个人信息」里的第二个子 tab（账户信息 / 交易所 / 密钥配置 / **用量统计** / AI 提示词）。
 *
 * `keyId` 是"只看哪把密钥"（父组件传进来）—— 统计可以跟密钥绑定分开看。
 */
const props = withDefaults(defineProps<{keyId?: number | null}>(), {
  keyId: null
})

/* ---------------- 筛选 ---------------- */

/*
 * ★ 2026-10-18 用户：「用量统计没有案例了有日记提炼改一下」——
 *   「案例提炼」那档换成**日记提炼**（`polish`，日记正文美化），
 *   「数据问答」跟着改名成 **AI 助手**（它已经搬到开单分析，见 `LEFT_TABS`）。
 *   `extract`（老的知识库提炼）不再出现在筛选项里，只作为历史记录留在列表标签上。
 */
const KINDS = [
  {value: '' as const, label: '全部用途'},
  {value: 'judge' as const, label: '开单分析'},
  {value: 'polish' as const, label: '日记提炼'},
  {value: 'ask' as const, label: 'AI 助手'}
]

/*
 * ★ 2026-10-12 用户：「把『今天/7天/30天…』那排日期筛选，换成带日历图标的日期输入框
 *   （点开选任意区间，图标复用 K 线页那颗）」。
 *
 * 所以这里不再有「N 天」那排胶囊，改成 `from`/`to` 两个**北京自然日**（含头含尾），
 * 默认最近 30 天（跟以前一样）。日期全是 `YYYY-MM-DD` 字符串，比较 / 显示都不碰时区。
 */
const BJ = 'Asia/Shanghai'
const bjToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {timeZone: BJ}).format(new Date())
const bjShift = (day: string, n: number): string => {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const from = ref(bjShift(bjToday(), -29))
const to = ref(bjToday())
const kind = ref<'' | 'judge' | 'polish' | 'ask'>('')

const rangeText = computed(() =>
  from.value === to.value ? from.value : `${from.value} ~ ${to.value}`
)

/* ---------------- 日期弹层 ---------------- */

/*
 * 日历**不在这里画** —— 用共用的 `DateRangeCalendar`（就是「账户统计」那颗，
 * 用户 2026-10-12：「日历复用的是账户统计的日历」）。这里只管弹不弹、选了之后存哪。
 */
const pickerOpen = ref(false)

/** 这一页要的快捷项（比账户统计多一个「今天」） */
const QUICK = [
  {label: '今天', days: 1},
  {label: '近 7 天', days: 7},
  {label: '近 30 天', days: 30},
  {label: '近 90 天', days: 90}
]

/** 点弹层外面 / 按 Esc 关掉 */
function onDocDown(e: PointerEvent): void {
  if (!pickerOpen.value) return
  if ((e.target as HTMLElement)?.closest?.('.rng')) return
  pickerOpen.value = false
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && pickerOpen.value) pickerOpen.value = false
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocDown, true)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onKey)
})

function applyRange(v: {from: string; to: string}): void {
  // 应用时把空的补成「今天」——统计口径上两头都得有日子
  from.value = v.from || bjToday()
  to.value = v.to || v.from || bjToday()
  if (from.value > to.value) [from.value, to.value] = [to.value, from.value]
  pickerOpen.value = false
}

/* ---------------- 数据 ---------------- */

const summary = ref<UsageSummary | null>(null)
const rows = ref<UsageRow[]>([])
const total = ref(0)
const limit = ref(50)
const offset = ref(0)
const loading = ref(true)
const error = ref('')

const query = computed(() => ({
  /** ⚠️ 后端还认 `days`（老口径 / 兜底），这里固定给个值，实际按 `from`/`to` 走 */
  days: 30,
  from: from.value,
  to: to.value,
  kind: kind.value,
  keyId: props.keyId
}))

const rate = computed(() => summary.value?.rate ?? 7.1)
const rmb = (usdValue: unknown) => cny((Number(usdValue) || 0) * rate.value)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [s, page] = await Promise.all([
      fetchUsageSummary(query.value, 10),
      fetchUsageCalls(query.value, {limit: limit.value, offset: offset.value})
    ])
    summary.value = s
    rows.value = page.rows
    total.value = page.total
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** 只换明细页，不动汇总 */
async function loadPage() {
  try {
    const page = await fetchUsageCalls(query.value, {
      limit: limit.value,
      offset: offset.value
    })
    rows.value = page.rows
    total.value = page.total
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
watch([from, to, kind, () => props.keyId], () => {
  offset.value = 0
  load()
})

/* ---------------- KPI ---------------- */

const t = computed(() => summary.value?.totals)
const perCall = computed(() =>
  (t.value?.calls ?? 0) > 0
    ? (t.value?.costUsd ?? 0) / (t.value?.calls ?? 1)
    : 0
)
const hitRate = computed(() =>
  (t.value?.promptTokens ?? 0) > 0
    ? (t.value?.cacheHitTokens ?? 0) / (t.value?.promptTokens ?? 1)
    : 0
)

const cards = computed<StatCard[]>(() => {
  const tt = t.value
  const s = summary.value
  return [
    {
      label: '当期花费',
      value: cny((tt?.costUsd ?? 0) * rate.value),
      sub: `原价 ${usd(tt?.costUsd)}`
    },
    {
      label: '今日 / 累计',
      value: cny(s?.today.costCny),
      sub: `累计 ${cny(s?.allTime.costCny)}（${s?.allTime.calls ?? 0} 次）`,
      tone: 'blue'
    },
    {
      label: '调用次数',
      value: int(tt?.calls),
      sub: '每次都真实调用了大模型'
    },
    {
      label: '平均单次',
      value: cny(perCall.value * rate.value),
      sub: `原价 ${usd(perCall.value)}`
    },
    {
      label: '总 token',
      value: tok(tt?.totalTokens),
      sub: `输入 ${tok(tt?.promptTokens)} · 输出 ${tok(tt?.completionTokens)}`
    },
    {
      label: '缓存命中率',
      value: pct(hitRate.value),
      sub: `命中 ${tok(tt?.cacheHitTokens)} token`,
      tone: hitRate.value >= 0.5 ? 'ok' : 'warn'
    },
    {
      label: '预估 100 次分析',
      value: cny(perCall.value * 100 * rate.value),
      sub: '按当前平均单价推算'
    },
    {
      label: '计价方式',
      value: tt?.calls ? '高峰全价' : '暂无记录',
      sub: '其余时段按高峰价减半',
      tone: tt?.calls ? '' : 'warn'
    }
  ]
})

/* ---------------- token 构成 ---------------- */

const composition = computed(() => {
  const tt = t.value
  const hit = tt?.cacheHitTokens ?? 0
  const miss = Math.max(0, (tt?.promptTokens ?? 0) - hit)
  const out = tt?.completionTokens ?? 0
  const all = hit + miss + out
  if (!all) return []
  return [
    {
      key: 'hit',
      label: '输入 · 缓存命中',
      n: hit,
      w: hit / all,
      color: 'var(--ok)'
    },
    {
      key: 'miss',
      label: '输入 · 未命中',
      n: miss,
      w: miss / all,
      color: 'var(--warn)'
    },
    {key: 'out', label: '输出', n: out, w: out / all, color: 'var(--data-3)'}
  ]
})

/* ---------------- 表格 ---------------- */

const bucketCols: Column<UsageBucket>[] = [
  {key: 'label', label: '名称', strong: true},
  {key: 'calls', label: '次数', align: 'right', value: r => r.calls},
  {key: 'tokens', label: 'tokens', align: 'right', value: r => r.totalTokens},
  {key: 'cost', label: '花费', align: 'right', value: r => r.costUsd},
  {
    key: 'avg',
    label: '单次均价',
    align: 'right',
    value: r => (r.calls > 0 ? r.costUsd / r.calls : 0)
  }
]

const dayCols: Column<UsageBucket>[] = [
  {key: 'key', label: '日期', strong: true},
  {key: 'calls', label: '次数', align: 'right', value: r => r.calls},
  {
    key: 'promptTokens',
    label: '输入',
    align: 'right',
    value: r => r.promptTokens
  },
  {
    key: 'completionTokens',
    label: '输出',
    align: 'right',
    value: r => r.completionTokens
  },
  {
    key: 'totalTokens',
    label: '合计',
    align: 'right',
    value: r => r.totalTokens
  },
  {key: 'costUsd', label: '花费', align: 'right', value: r => r.costUsd}
]

const callCols: Column<UsageRow>[] = [
  {key: 'createdAt', label: '时间', strong: true},
  {key: 'kind', label: '用途'},
  {key: 'model', label: '模型'},
  // 这一列是后来加的：用量跟**哪把密钥**绑定（没绑定 / 已删就是 —）
  {key: 'keyName', label: '密钥', value: r => r.keyName ?? '—'},
  {key: 'symbol', label: '币种 / 周期'},
  {
    key: 'promptTokens',
    label: '输入',
    align: 'right',
    value: r => r.promptTokens
  },
  {
    key: 'cacheHitTokens',
    label: '命中',
    align: 'right',
    value: r => r.cacheHitTokens
  },
  {
    key: 'completionTokens',
    label: '输出',
    align: 'right',
    value: r => r.completionTokens
  },
  {key: 'costUsd', label: '花费', align: 'right', value: r => r.costUsd},
  {
    key: 'latencyMs',
    label: '耗时',
    align: 'right',
    value: r => r.latencyMs ?? 0
  },
  {key: 'attempts', label: '状态', align: 'right', value: r => r.attempts}
]

/* ---------------- 分页 ---------------- */

const page = computed(() => Math.floor(offset.value / limit.value) + 1)
const pages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))

function go(delta: number) {
  const next = offset.value + delta * limit.value
  if (next < 0 || next >= total.value) return
  offset.value = next
  loadPage()
}

const kindText = (k: string) => KIND_TEXT[k] ?? k
const symbolText = (r: UsageRow) =>
  r.symbol ? r.symbol + (r.timeframe ? ' ' + r.timeframe : '') : '—'
</script>

<template>
  <div class="col usage">
    <!-- 筛选 -->
    <section
      class="panel"
      style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap"
    >
      <!--
        日期：**带日历图标的输入框**（用户 2026-10-12 要求换掉「今天/7天/30天…」那排胶囊，
        点开选任意区间；图标用的是 K 线页那颗 —— 共用组件 `IconCalendar`）。
      -->
      <div class="rng">
        <button
          type="button"
          class="rng-btn"
          :class="{on: pickerOpen}"
          title="点开选日期（任意区间）"
          @click="pickerOpen = !pickerOpen"
        >
          <IconCalendar :size="14" />
          <span class="rng-text">{{ rangeText }}</span>
          <span class="rng-caret">▾</span>
        </button>

        <div v-if="pickerOpen" class="rng-pop">
          <DateRangeCalendar
            :from="from"
            :to="to"
            :quick="QUICK"
            :clear-text="null"
            @apply="applyRange"
          />
        </div>
      </div>

      <SegTabs v-model="kind" :options="KINDS" />
    </section>

    <div v-if="error" class="error">
      <b>读取失败</b>
      <div>{{ error }}</div>
      <div class="dim">数据库没起来？在项目目录执行 npm run db:up</div>
    </div>

    <StatCards :cards="cards" />

    <!-- 趋势 -->
    <section class="panel">
      <h2>
        每天花费 <span class="tag">{{ rangeText }}</span>
      </h2>
      <CostTrend
        :days="summary?.byDay ?? []"
        :rate="rate"
        :loading="loading && !summary"
      />
    </section>

    <!-- token 构成 -->
    <section v-if="composition.length" class="panel">
      <h2>token 构成</h2>
      <div class="stack">
        <div
          v-for="c in composition"
          :key="c.key"
          :style="{width: c.w * 100 + '%', background: c.color}"
          :title="`${c.label} ${tok(c.n)}（${pct(c.w)}）`"
        />
      </div>
      <div class="stack-legend">
        <span v-for="c in composition" :key="c.key">
          <i :style="{background: c.color}" />
          {{ c.label }}
          <b>{{ tok(c.n) }}</b>
          <em>{{ pct(c.w) }}</em>
        </span>
      </div>
      <p class="hint" style="margin-top: 10px">
        缓存命中比未命中便宜几十倍。规则前缀不变时命中率会自然升高 ——
        改一次规则会短暂掉下去再回升。
      </p>
    </section>

    <!-- 按天 -->
    <section class="panel">
      <h2>
        按天 <span class="tag">{{ summary?.byDay.length ?? 0 }} 天有记录</span>
      </h2>
      <DataTable
        :columns="dayCols"
        :rows="summary?.byDay ?? []"
        initial-sort="key"
        empty="这段时间没有记录"
      >
        <template #costUsd="{row}">
          {{ rmb(row.costUsd)
          }}<span class="dim"> / {{ usd(row.costUsd) }}</span>
        </template>
      </DataTable>
    </section>

    <!-- 按用途 / 模型 -->
    <section class="panel">
      <h2>按用途与模型</h2>
      <div class="two">
        <div>
          <h3>用途</h3>
          <DataTable
            :columns="bucketCols"
            :rows="summary?.byKind ?? []"
            empty="无数据"
          >
            <template #label="{row}">{{ kindText(row.key) }}</template>
            <template #tokens="{row}">{{ tok(row.totalTokens) }}</template>
            <template #cost="{row}">
              {{ rmb(row.costUsd)
              }}<span class="dim"> / {{ usd(row.costUsd) }}</span>
            </template>
            <template #avg="{row}">
              {{ rmb(row.calls ? row.costUsd / row.calls : 0) }}
            </template>
          </DataTable>
        </div>
        <div>
          <h3>模型</h3>
          <DataTable
            :columns="bucketCols"
            :rows="summary?.byModel ?? []"
            empty="无数据"
          >
            <template #tokens="{row}">{{ tok(row.totalTokens) }}</template>
            <template #cost="{row}">
              {{ rmb(row.costUsd)
              }}<span class="dim"> / {{ usd(row.costUsd) }}</span>
            </template>
            <template #avg="{row}">
              {{ rmb(row.calls ? row.costUsd / row.calls : 0) }}
            </template>
          </DataTable>
        </div>
      </div>
    </section>

    <!-- 明细 -->
    <section class="panel">
      <h2>
        调用明细 <span class="tag">共 {{ int(total) }} 条</span>
      </h2>
      <DataTable
        :columns="callCols"
        :rows="rows"
        initial-sort="createdAt"
        empty="这段时间没有调用记录"
      >
        <template #createdAt="{row}">{{ bjTime(row.createdAt) }}</template>
        <template #kind="{row}">
          {{ kindText(row.kind) }}
          <span v-if="row.attempts > 1" class="v warn" title="重试了">
            ×{{ row.attempts }}
          </span>
        </template>
        <template #model="{row}">{{ row.model }}</template>
        <template #symbol="{row}">{{ symbolText(row) }}</template>
        <template #costUsd="{row}">
          {{ rmb(row.costUsd) }}
          <span class="dim">{{ usd(row.costUsd) }}</span>
        </template>
        <template #latencyMs="{row}">{{ ms(row.latencyMs) }}</template>
        <template #attempts="{row}">
          <span v-if="row.attempts > 1" class="v warn"
            >重试 {{ row.attempts }} 次</span
          >
          <span v-else class="v ok">一次成功</span>
        </template>
      </DataTable>

      <div class="pager">
        <button class="ghost" :disabled="page <= 1" @click="go(-1)">
          上一页
        </button>
        <span class="dim"
          >第 {{ page }} / {{ pages }} 页 · 每页 {{ limit }}</span
        >
        <button class="ghost" :disabled="page >= pages" @click="go(1)">
          下一页
        </button>
      </div>
    </section>

    <footer class="hint">
      <p>
        计价基准：DeepSeek 官方价目表（美元 / 1M token，高峰价）。高峰时段 =
        **北京时间**周一至周五（不含中国法定节假日）9:00-12:00 与 14:00-18:00，
        其余时段（含周末、节假日全天）按高峰价**减半**。每笔都存了当时的单价快照，
        官方调价不影响历史记录；改过判定规则后用
        <code>npm run reprice</code> 重算旧记录。
      </p>
      <p style="margin-top: 6px">
        汇率 USD_CNY = {{ rate }}（.env 可改）；单价可用 LLM_PRICE_INPUT_HIT /
        LLM_PRICE_INPUT_MISS / LLM_PRICE_OUTPUT 覆盖。
      </p>
    </footer>
  </div>
</template>

<style scoped>
.col {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---------------- 日期输入框 + 日历弹层 ---------------- */

/*
 * ★ 2026-10-12 用户：「把『今天/7天/30天…』那排日期筛选，换成带日历图标的日期输入框
 *   （点开选任意区间，图标复用 K 线页那颗）」。
 *
 * 样子做成**输入框**（跟「合约行情」那个搜索框同一套皮）：圆角框 + 左内嵌日历图标 +
 * 右侧小三角；点开往下弹一个手写日历（不引日期库）。区间是**北京自然日、含头含尾**。
 */
.rng {
  position: relative;
  min-width: 0;
}

.rng-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.rng-btn:hover,
.rng-btn.on {
  border-color: var(--accent-line);
}
.rng-btn :deep(svg) {
  color: var(--muted);
  flex: none;
}
.rng-text {
  white-space: nowrap;
}
.rng-caret {
  color: var(--muted);
  font-size: 10px;
}

.rng-pop {
  position: absolute;
  z-index: 40;
  top: calc(100% + 6px);
  left: 0;
  width: 268px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--panel);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
}

/*
 * ★ 2026-10-12 用户：「统计卡片缩小布局」。
 *
 * 顶部那 6 张 KPI 卡原来是 150px 起、数值 20px，一屏占得太多；这里**只在用量页**
 * 收小（全局 `.cards` 不动 —— 它是 `StatCards.vue` 的样式，别的地方还要按原样用）。
 */
.usage :deep(.cards) {
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
  gap: 8px;
}
.usage :deep(.card) {
  padding: 8px 10px;
  border-radius: 8px;
  gap: 1px;
}
.usage :deep(.card .k) {
  font-size: 10.5px;
}
.usage :deep(.card .v) {
  font-size: 16px;
}
.usage :deep(.card .sub) {
  font-size: 10.5px;
}

.two {
  display: grid;
  /*
   * ⚠️ 必须写 `minmax(0, 1fr)`，不能写 `1fr`。
   * `1fr` 的最小值是 auto = min-content，而表格的 min-content 是「所有列不许压缩」
   * 的宽度（实测 386px）→ 轨道被撑到比屏幕还宽，整页横向溢出。
   */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
}

@media (max-width: 760px) {
  .two {
    grid-template-columns: minmax(0, 1fr);
  }
}

footer {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
</style>
