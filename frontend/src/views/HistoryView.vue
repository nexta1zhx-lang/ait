<script setup lang="ts">
import {computed, onMounted, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import StatCards, {type StatCard} from '../comps/StatCards.vue'
import SegTabs from '../comps/SegTabs.vue'
import DataTable, {type Column} from '../comps/DataTable.vue'
import SymbolCombo from '../comps/SymbolCombo.vue'
import {
  OUTCOME_TEXT,
  OUTCOME_TONE,
  deleteAnalysis,
  fetchAnalyses,
  fetchAnalysis,
  settleAnalysis,
  type AnalysisDetail,
  type AnalysisRow,
  type AnalysisStats,
  type GradeStat,
  type OutcomeKind
} from '../api'
import {
  GRADE_TEXT,
  VERDICT_TEXT,
  ago,
  bjTime,
  cny,
  fixed,
  int,
  ms,
  pct,
  signedPct,
  structureFull,
  tok,
  usd
} from '../format'
import {contracts} from '../store'

const route = useRoute()
const router = useRouter()

/* ---------------- 筛选 ---------------- */

const RANGES = [
  {value: 7, label: '7 天'},
  {value: 30, label: '30 天'},
  {value: 90, label: '90 天'},
  {value: 365, label: '1 年'},
  {value: 3650, label: '全部'}
]

const GRADES = [
  {value: '', label: '全部档位'},
  {value: 'A', label: 'A 档'},
  {value: 'B', label: 'B 档'},
  {value: 'C', label: 'C 档'}
]

const VERDICTS = [
  {value: '', label: '全部结论'},
  {value: 'go', label: '可做'},
  {value: 'wait', label: '等'},
  {value: 'no_go', label: '不可做'}
]

const days = ref(90)
const symbol = ref(
  typeof route.query.symbol === 'string' ? route.query.symbol : ''
)
const grade = ref('')
const verdict = ref('')
const actionable = ref(false)
const pending = ref(false)

/* ---------------- 列表 ---------------- */

const rows = ref<AnalysisRow[]>([])
const total = ref(0)
const stats = ref<AnalysisStats | null>(null)
const rate = ref(7.1)
const limit = ref(20)
const offset = ref(0)
const loading = ref(true)
const error = ref('')
const updatedAt = ref<number | null>(null)

const query = computed(() => ({
  symbol: symbol.value.trim().toUpperCase(),
  grade: grade.value,
  verdict: verdict.value,
  actionable: actionable.value,
  pending: pending.value,
  days: days.value,
  limit: limit.value,
  offset: offset.value
}))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const page = await fetchAnalyses(query.value)
    rows.value = page.rows
    total.value = page.total
    stats.value = page.stats
    rate.value = page.rate || 7.1
    updatedAt.value = Date.now()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** 只换页，不动汇总 */
async function loadPage() {
  try {
    const page = await fetchAnalyses(query.value, {offset: offset.value})
    rows.value = page.rows
    total.value = page.total
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
watch([days, symbol, grade, verdict, actionable, pending], () => {
  offset.value = 0
  load()
})

const rmb = (usdValue: unknown) => cny((Number(usdValue) || 0) * rate.value)

/* ---------------- KPI ---------------- */

const goCount = computed(
  () => stats.value?.byGrade.reduce((s, g) => s + g.goCount, 0) ?? 0
)
const settledAll = computed(() => {
  const g = stats.value?.byGrade ?? []
  const settled = g.reduce((s, x) => s + x.settled, 0)
  const totalR = g.reduce((s, x) => s + (x.totalR ?? 0), 0)
  const wins = g.reduce(
    (s, x) => s + Math.round((x.winRate ?? 0) * x.settled),
    0
  )
  return {settled, totalR, wins}
})

const cards = computed<StatCard[]>(() => {
  const s = stats.value
  const {settled, totalR, wins} = settledAll.value
  return [
    {
      label: '分析次数',
      value: int(s?.total),
      sub: '每次分析都完整存档'
    },
    {
      label: '给出「可做」',
      value: int(goCount.value),
      sub: s?.total
        ? `占 ${pct(goCount.value / s.total)}，其余都是等/不做`
        : '还没有分析',
      tone: 'blue'
    },
    {
      label: '已结算',
      value: `${settled} / ${int(s?.total)}`,
      sub: settled ? `胜 ${wins} 次 · 胜率 ${pct(wins / settled)}` : '还没复盘',
      tone: settled ? '' : 'warn'
    },
    {
      label: '累计 R',
      value: settled ? fixed(totalR) : '—',
      sub: settled ? `平均每单 ${fixed(totalR / settled)}R` : '结算后才有',
      tone: totalR > 0 ? 'ok' : totalR < 0 ? 'bad' : ''
    },
    {
      label: '待复盘',
      value: int(s?.pending),
      sub: '「可做」但还没填结果',
      tone: s?.pending ? 'warn' : ''
    },
    {
      label: '累计花费',
      value: rmb(s?.costUsd),
      sub: `原价 ${usd(s?.costUsd)}`
    }
  ]
})

/* ---------------- 档位对比 ---------------- */

const gradeCols: Column<GradeStat>[] = [
  {key: 'grade', label: '档位', strong: true},
  {key: 'calls', label: '次数', align: 'right', value: r => r.calls},
  {key: 'goCount', label: '可做', align: 'right', value: r => r.goCount},
  {key: 'settled', label: '已结算', align: 'right', value: r => r.settled},
  {
    key: 'winRate',
    label: '胜率',
    align: 'right',
    value: r => r.winRate ?? -1
  },
  {key: 'avgR', label: '平均 R', align: 'right', value: r => r.avgR ?? 0},
  {key: 'totalR', label: '累计 R', align: 'right', value: r => r.totalR ?? 0}
]

const symbolCols: Column<{
  symbol: string
  calls: number
  settled: number
  avgR: number | null
}>[] = [
  {key: 'symbol', label: '币种', strong: true},
  {key: 'calls', label: '次数', align: 'right', value: r => r.calls},
  {key: 'settled', label: '已结算', align: 'right', value: r => r.settled},
  {key: 'avgR', label: '平均 R', align: 'right', value: r => r.avgR ?? 0}
]

/* ---------------- 列表 ---------------- */

const listCols: Column<AnalysisRow>[] = [
  {key: 'createdAt', label: '时间', strong: true},
  {key: 'symbol', label: '币种'},
  {key: 'grade', label: '档'},
  {key: 'verdict', label: '结论'},
  {
    key: 'confidence',
    label: '把握',
    align: 'right',
    value: r => r.confidence ?? 0
  },
  {
    key: 'entryPrice',
    label: '入场',
    align: 'right',
    value: r => r.entryPrice ?? 0
  },
  {key: 'stopLoss', label: '止损', align: 'right', value: r => r.stopLoss ?? 0},
  {
    key: 'expectancyR',
    label: '期望 R',
    align: 'right',
    value: r => r.expectancyR ?? 0
  },
  {key: 'outcome', label: '结果'},
  {key: 'rMultiple', label: 'R', align: 'right', value: r => r.rMultiple ?? 0},
  {key: 'costUsd', label: '花费', align: 'right', value: r => r.costUsd ?? 0},
  {key: 'actions', label: '操作'}
]

const gradeText = (g: string | null) => (g ? (GRADE_TEXT[g] ?? `${g} 档`) : '—')
const verdictText = (v: string | null) =>
  v ? (VERDICT_TEXT[v]?.[0] ?? v) : '—'
const verdictTone = (v: string | null) =>
  v ? (VERDICT_TEXT[v]?.[1] ?? '') : 'dim'
const num = (v: number | null) => (v === null ? '—' : fixed(v, 4))

/* ---------------- 详情 ---------------- */

const detail = ref<AnalysisDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref('')

async function open(id: number) {
  detailLoading.value = true
  detailError.value = ''
  detail.value = null
  try {
    const r = await fetchAnalysis(id)
    detail.value = r.analysis
    void router.replace({query: {...route.query, id: String(id)}})
  } catch (e) {
    detailError.value = (e as Error).message
  } finally {
    detailLoading.value = false
  }
}

function close() {
  detail.value = null
  detailError.value = ''
  const q = {...route.query}
  delete q.id
  void router.replace({query: q})
}

/* ---------------- 结算 ---------------- */

const settling = ref(false)
const settleMsg = ref('')
const form = ref({
  outcome: 'tp1' as OutcomeKind,
  price: '',
  rMultiple: '',
  mfePct: '',
  maePct: '',
  note: ''
})

const OUTCOMES = (Object.keys(OUTCOME_TEXT) as OutcomeKind[]).map(k => ({
  value: k,
  label: OUTCOME_TEXT[k]
}))

/** 选了结果先把 R 猜好，省得每次手算（止损 = -1，TP1/2/3 用计划里的 R） */
function guessR() {
  const d = detail.value
  if (!d) return ''
  const o = form.value.outcome
  if (o === 'sl') return '-1'
  if (o === 'breakeven' || o === 'skipped') return '0'
  if (o === 'tp1')
    return d.result?.takeProfits?.[0] ? fixed(d.result.takeProfits[0].r) : ''
  if (o === 'tp2')
    return d.result?.takeProfits?.[1] ? fixed(d.result.takeProfits[1].r) : ''
  if (o === 'tp3')
    return d.result?.takeProfits?.[2] ? fixed(d.result.takeProfits[2].r) : ''
  return ''
}

watch(
  () => form.value.outcome,
  () => {
    const g = guessR()
    if (g) form.value.rMultiple = g
  }
)

async function submitSettle() {
  const d = detail.value
  if (!d) return
  settling.value = true
  settleMsg.value = ''
  try {
    await settleAnalysis(d.id, {
      outcome: form.value.outcome,
      price: form.value.price === '' ? null : Number(form.value.price),
      rMultiple:
        form.value.rMultiple === '' ? null : Number(form.value.rMultiple),
      mfePct: form.value.mfePct === '' ? null : Number(form.value.mfePct),
      maePct: form.value.maePct === '' ? null : Number(form.value.maePct),
      note: form.value.note || null
    })
    settleMsg.value = '已结算'
    await load()
    await open(d.id)
  } catch (e) {
    settleMsg.value = (e as Error).message
  } finally {
    settling.value = false
  }
}

async function remove(id: number) {
  if (!window.confirm(`删除第 ${id} 条分析记录？不可恢复。`)) return
  try {
    await deleteAnalysis(id)
    if (detail.value?.id === id) close()
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

/* ---------------- 分页 ---------------- */

const page = computed(() => Math.floor(offset.value / limit.value) + 1)
const pages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))

function go(delta: number) {
  const next = offset.value + delta * limit.value
  if (next < 0 || next >= total.value) return
  offset.value = next
  loadPage()
}

/* 进来带 ?id= 就直接打开详情 */
onMounted(() => {
  const id = Number(route.query.id)
  if (Number.isInteger(id) && id > 0) void open(id)
})
</script>

<template>
  <div class="col">
    <!-- 筛选 -->
    <section
      class="panel"
      style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap"
    >
      <SegTabs v-model="days" :options="RANGES" />
      <div style="width: 150px">
        <SymbolCombo v-model="symbol" :contracts="contracts" />
      </div>
      <SegTabs v-model="grade" :options="GRADES" />
      <SegTabs v-model="verdict" :options="VERDICTS" />
      <label class="chk">
        <input v-model="actionable" type="checkbox" />
        只看「可做」
      </label>
      <label class="chk">
        <input v-model="pending" type="checkbox" />
        只看未结算
      </label>
      <span style="flex: 1"></span>
      <span v-if="updatedAt" class="dim">
        {{ ago(new Date(updatedAt).toISOString()) }}更新
      </span>
      <button class="ghost" :disabled="loading" @click="load">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </section>

    <div v-if="error" class="error">
      <b>读取失败</b>
      <div>{{ error }}</div>
      <div class="dim">数据库没起来？在项目目录执行 npm run db:up</div>
    </div>

    <StatCards :cards="cards" />

    <!-- 档位对比 -->
    <section class="panel">
      <h2>
        档位表现 <span class="tag">最近 {{ days }} 天</span>
      </h2>
      <DataTable
        :columns="gradeCols"
        :rows="stats?.byGrade ?? []"
        initial-sort="grade"
        empty="还没有分析记录"
      >
        <template #grade="{row}">
          <span :class="['grade', row.grade]">{{ row.grade }}</span>
        </template>
        <template #winRate="{row}">
          <span v-if="row.settled === 0" class="dim">待复盘</span>
          <span v-else :class="row.winRate >= 0.5 ? 'v ok' : 'v bad'">
            {{ pct(row.winRate) }}
          </span>
        </template>
        <template #avgR="{row}">
          <span v-if="row.settled === 0" class="dim">—</span>
          <span v-else :class="row.avgR > 0 ? 'v ok' : 'v bad'">
            {{ fixed(row.avgR) }}R
          </span>
        </template>
        <template #totalR="{row}">
          <span v-if="row.settled === 0" class="dim">—</span>
          <span v-else :class="row.totalR > 0 ? 'v ok' : 'v bad'">
            {{ fixed(row.totalR) }}R
          </span>
        </template>
      </DataTable>
      <p class="hint" style="margin-top: 10px">
        这张表是用来打脸的：如果 A 档的胜率和平均 R 长期不比 B
        档高，说明规则里的分档 跟实际结果对不上，该回去改
        <code>rules/</code> 里的档位定义，而不是改这里。
        没结算的记录不参与胜率统计。
      </p>
    </section>

    <!-- 按币种 -->
    <section v-if="(stats?.bySymbol ?? []).length" class="panel">
      <h2>做过哪些币</h2>
      <DataTable
        :columns="symbolCols"
        :rows="stats?.bySymbol ?? []"
        initial-sort="calls"
        empty="无数据"
      />
    </section>

    <!-- 列表 -->
    <section class="panel">
      <h2>
        分析记录 <span class="tag">共 {{ int(total) }} 条</span>
      </h2>
      <DataTable
        :columns="listCols"
        :rows="rows"
        initial-sort="createdAt"
        empty="这段时间没有分析记录。去「开单分析」跑一次，结果会自动存到这里。"
      >
        <template #createdAt="{row}">
          <a class="linkish" @click="open(row.id)">
            {{ bjTime(row.createdAt) }}
          </a>
        </template>
        <template #symbol="{row}">
          <b>{{ row.symbol }}</b>
          <div class="dim" style="font-size: 11px">
            {{ row.timeframes.join(' · ') }}
          </div>
        </template>
        <template #grade="{row}">
          <span :class="['grade', row.grade ?? '']">{{
            row.grade ?? '—'
          }}</span>
        </template>
        <template #verdict="{row}">
          <span :class="['v', verdictTone(row.verdict)]">
            {{ verdictText(row.verdict) }}
          </span>
        </template>
        <template #confidence="{row}">{{ row.confidence ?? '—' }}</template>
        <template #entryPrice="{row}">{{ num(row.entryPrice) }}</template>
        <template #stopLoss="{row}">
          {{ num(row.stopLoss) }}
          <div v-if="row.stopPct !== null" class="dim" style="font-size: 11px">
            {{ pct(row.stopPct) }}
          </div>
        </template>
        <template #expectancyR="{row}">
          <span v-if="row.expectancyR === null" class="dim">—</span>
          <span v-else :class="row.expectancyR > 0 ? 'v ok' : 'v bad'">
            {{ fixed(row.expectancyR) }}R
          </span>
        </template>
        <template #outcome="{row}">
          <span v-if="!row.outcome" class="dim">未结算</span>
          <span v-else :class="['v', OUTCOME_TONE[row.outcome]]">
            {{ OUTCOME_TEXT[row.outcome] }}
          </span>
        </template>
        <template #rMultiple="{row}">
          <span v-if="row.rMultiple === null" class="dim">—</span>
          <span v-else :class="row.rMultiple > 0 ? 'v ok' : 'v bad'">
            {{ fixed(row.rMultiple) }}
          </span>
        </template>
        <template #costUsd="{row}">{{ rmb(row.costUsd) }}</template>
        <template #actions="{row}">
          <button class="ghost tiny" @click="open(row.id)">详情</button>
          <button class="ghost tiny danger" @click="remove(row.id)">删</button>
        </template>
      </DataTable>

      <div class="pager">
        <button class="ghost" :disabled="page <= 1" @click="go(-1)">
          上一页
        </button>
        <span class="dim">
          第 {{ page }} / {{ pages }} 页 · 每页 {{ limit }}
        </span>
        <button class="ghost" :disabled="page >= pages" @click="go(1)">
          下一页
        </button>
      </div>
    </section>

    <!-- 详情 -->
    <div v-if="detail || detailLoading" class="overlay" @click.self="close">
      <div class="drawer">
        <button class="ghost close" @click="close">关闭</button>

        <p v-if="detailLoading" class="dim">读取中…</p>
        <div v-else-if="detailError" class="error">{{ detailError }}</div>

        <template v-else-if="detail">
          <h2 style="margin-top: 0">
            #{{ detail.id }} · {{ detail.symbol }}
            <span class="tag">{{ bjTime(detail.createdAt) }}</span>
          </h2>

          <!-- 结论 -->
          <div class="detail-head">
            <span :class="['grade', detail.grade ?? '']">
              {{ gradeText(detail.grade) }}
            </span>
            <span :class="['v', verdictTone(detail.verdict)]">
              {{ verdictText(detail.verdict) }}
            </span>
            <span class="dim">把握 {{ detail.confidence ?? '—' }}/100</span>
            <span
              v-if="detail.direction && detail.direction !== 'none'"
              class="v blue"
            >
              方向 {{ detail.direction === 'long' ? '做多' : '做空' }}
            </span>
          </div>

          <p v-if="detail.gradeReason" class="quote">
            <b>判档理由</b>{{ detail.gradeReason }}
          </p>
          <p v-if="detail.verdictReason" class="quote">
            <b>结论理由</b>{{ detail.verdictReason }}
          </p>

          <!-- 计划 -->
          <h3>计划</h3>
          <div class="kv">
            <div>
              <span>入场</span><b>{{ num(detail.entryPrice) }}</b>
            </div>
            <div>
              <span>止损</span><b>{{ num(detail.stopLoss) }}</b>
            </div>
            <div>
              <span>TP1</span><b>{{ num(detail.tp1Price) }}</b>
            </div>
            <div>
              <span>TP2</span><b>{{ num(detail.tp2Price) }}</b>
            </div>
            <div>
              <span>TP3</span><b>{{ num(detail.tp3Price) }}</b>
            </div>
            <div>
              <span>末段 R</span
              ><b>{{
                detail.rrFinal === null ? '—' : fixed(detail.rrFinal)
              }}</b>
            </div>
            <div>
              <span>期望值</span>
              <b :class="(detail.expectancyR ?? 0) > 0 ? 'v ok' : 'v bad'">
                {{
                  detail.expectancyR === null
                    ? '—'
                    : fixed(detail.expectancyR) + 'R'
                }}
              </b>
            </div>
            <div>
              <span>假设胜率</span>
              <b>{{
                detail.assumedWinRate === null
                  ? '—'
                  : pct(detail.assumedWinRate)
              }}</b>
            </div>
            <div>
              <span>止损幅度</span>
              <b>{{ detail.stopPct === null ? '—' : pct(detail.stopPct) }}</b>
            </div>
            <div>
              <span>仓位</span
              ><b>{{
                detail.positionQty === null ? '—' : fixed(detail.positionQty, 6)
              }}</b>
            </div>
            <div>
              <span>名义价值</span>
              <b>{{
                detail.positionNotional === null
                  ? '—'
                  : '$' + int(detail.positionNotional)
              }}</b>
            </div>
            <div>
              <span>杠杆</span>
              <b>{{
                detail.leverageUsed === null
                  ? '—'
                  : fixed(detail.leverageUsed) + 'x'
              }}</b>
            </div>
          </div>

          <!-- 护栏 -->
          <h3>
            护栏
            <span :class="detail.guardPassed ? 'v ok' : 'v bad'">
              {{ detail.guardPassed ? '通过' : '被拦下' }}
            </span>
          </h3>
          <ul v-if="detail.veto.length" class="list bad">
            <li v-for="(v, i) in detail.veto" :key="i">否决：{{ v }}</li>
          </ul>
          <ul v-if="detail.redLines.length" class="list bad">
            <li v-for="(v, i) in detail.redLines" :key="i">红线：{{ v }}</li>
          </ul>
          <p v-if="!detail.veto.length && !detail.redLines.length" class="dim">
            没有触发否决项与红线
          </p>

          <!-- Checklist -->
          <h3>
            Checklist
            <span class="tag">
              {{
                detail.result?.checklist?.filter(c => c.status === 'pass')
                  .length ?? 0
              }}
              / {{ detail.result?.checklist?.length ?? 0 }} 通过
            </span>
          </h3>
          <ul class="checklist">
            <li
              v-for="(c, i) in detail.result?.checklist ?? []"
              :key="i"
              :class="c.status"
            >
              <b>
                {{
                  c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌'
                }}
                {{ c.item }}
              </b>
              <div class="dim">{{ c.evidence }}</div>
            </li>
          </ul>

          <!-- 平仓触发 -->
          <template v-if="(detail.result?.exitTriggers ?? []).length">
            <h3>什么情况下必须走</h3>
            <ul class="list">
              <li v-for="(t, i) in detail.result.exitTriggers" :key="i">
                {{ t }}
              </li>
            </ul>
          </template>

          <p v-if="detail.result?.coachLine" class="coach">
            {{ detail.result.coachLine }}
          </p>

          <!-- 行情快照 -->
          <h3>当时的行情</h3>
          <div class="kv">
            <div>
              <span>现价</span
              ><b>{{ num(detail.snapshot?.price ?? detail.price) }}</b>
            </div>
            <div>
              <span>指标周期</span>
              <b>{{ detail.timeframes.join(' · ') }}</b>
            </div>
            <div>
              <span>图表周期</span><b>{{ detail.chartTimeframe ?? '—' }}</b>
            </div>
          </div>
          <p class="dim">{{ structureFull(detail.snapshot?.structure) }}</p>

          <div
            v-if="(detail.snapshot?.timeframes ?? []).length"
            class="tf-grid"
          >
            <div
              v-for="t in detail.snapshot?.timeframes ?? []"
              :key="t.timeframe"
            >
              <b>{{ t.timeframe }}</b>
              <span
                :class="
                  'v ' +
                  (t.trend === 'up' ? 'ok' : t.trend === 'down' ? 'bad' : 'dim')
                "
              >
                {{
                  t.trend === 'up'
                    ? '上升'
                    : t.trend === 'down'
                      ? '下跌'
                      : '震荡'
                }}
              </span>
              <div class="dim" style="font-size: 11px">
                量比 {{ fixed(t.volRatio) }} · 净涨跌
                {{ signedPct(t.netChangePct) }}
              </div>
            </div>
          </div>

          <!-- 引用的知识库 -->
          <template v-if="detail.knowledgeRefs.length">
            <h3>引用的知识库经验</h3>
            <ul class="list">
              <li v-for="(k, i) in detail.knowledgeRefs" :key="i">
                <span class="tag">{{ k.symbol }} {{ k.timeframe }}</span>
                {{ k.lesson }}
              </li>
            </ul>
          </template>

          <!-- 成本与来源 -->
          <h3>成本与来源</h3>
          <div class="kv">
            <div>
              <span>花费</span>
              <b
                >{{ rmb(detail.costUsd) }}
                <i class="dim">{{ usd(detail.costUsd) }}</i></b
              >
            </div>
            <div>
              <span>token</span>
              <b
                >{{ tok(detail.promptTokens) }} +
                {{ tok(detail.completionTokens) }}</b
              >
            </div>
            <div>
              <span>耗时</span><b>{{ ms(detail.latencyMs) }}</b>
            </div>
            <div>
              <span>尝试次数</span><b>{{ detail.attempts ?? '—' }}</b>
            </div>
            <div>
              <span>模型</span><b>{{ detail.model ?? '—' }}</b>
            </div>
            <div>
              <span>规则版本</span>
              <b title="规则文件内容的 hash，改了规则这里就变">
                {{ detail.rulesHash ? detail.rulesHash.slice(0, 12) : '—' }}
              </b>
            </div>
            <div>
              <span>护栏档</span
              ><b>{{ detail.guardrails?.minRr ?? '—' }}R 起</b>
            </div>
          </div>

          <!-- 结算 -->
          <h3>复盘结算</h3>
          <div v-if="detail.outcome" class="quote">
            <b>已结算：</b>{{ OUTCOME_TEXT[detail.outcome] }}
            <template v-if="detail.rMultiple !== null">
              · {{ fixed(detail.rMultiple) }}R
            </template>
            <template v-if="detail.outcomePrice !== null">
              · 出场 {{ fixed(detail.outcomePrice, 4) }}
            </template>
            <template v-if="detail.outcomeAt">
              · {{ bjTime(detail.outcomeAt) }}
            </template>
            <div
              v-if="detail.mfePct !== null || detail.maePct !== null"
              class="dim"
            >
              最大浮盈 {{ detail.mfePct === null ? '—' : pct(detail.mfePct) }} ·
              最大浮亏 {{ detail.maePct === null ? '—' : pct(detail.maePct) }}
            </div>
            <div v-if="detail.outcomeNote" class="dim">
              {{ detail.outcomeNote }}
            </div>
          </div>

          <div class="settle">
            <label>
              <span>结果</span>
              <select v-model="form.outcome">
                <option v-for="o in OUTCOMES" :key="o.value" :value="o.value">
                  {{ o.label }}
                </option>
              </select>
            </label>
            <label>
              <span>出场价</span>
              <input
                v-model="form.price"
                type="number"
                step="any"
                placeholder="选填"
              />
            </label>
            <label>
              <span>实际 R</span>
              <input
                v-model="form.rMultiple"
                type="number"
                step="0.01"
                placeholder="如 1.75"
              />
            </label>
            <label>
              <span>最大浮盈 %</span>
              <input
                v-model="form.mfePct"
                type="number"
                step="any"
                placeholder="选填"
              />
            </label>
            <label>
              <span>最大浮亏 %</span>
              <input
                v-model="form.maePct"
                type="number"
                step="any"
                placeholder="选填"
              />
            </label>
            <label class="wide">
              <span>备注</span>
              <input
                v-model="form.note"
                placeholder="为什么提前走 / 为什么没进"
              />
            </label>
          </div>
          <div style="display: flex; align-items: center; gap: 10px">
            <button class="primary" :disabled="settling" @click="submitSettle">
              {{ settling ? '保存中…' : '保存结算' }}
            </button>
            <button class="ghost danger" @click="remove(detail.id)">
              删除这条
            </button>
            <span v-if="settleMsg" class="dim">{{ settleMsg }}</span>
          </div>
          <p class="hint">
            R 的口径：止损 = −1R，TP1/2/3 = 计划里那档的 R。
            <b>「看了没做」也建议记一笔</b> ——
            事后涨了你没做，才是最能暴露问题的那类记录。
          </p>

          <!-- 规则原文 -->
          <details v-if="detail.rules?.body" class="rules">
            <summary>
              当时的规则原文
              <span class="tag">
                {{ detail.rules.hash.slice(0, 12) }} ·
                {{ detail.rules.sources.join('、') }}
              </span>
            </summary>
            <pre>{{ detail.rules.body }}</pre>
          </details>

          <details class="rules">
            <summary>原始 JSON（排查用）</summary>
            <pre>{{ JSON.stringify(detail.result, null, 2) }}</pre>
          </details>

          <p class="dim" style="margin-top: 8px">
            知识库引用 {{ detail.knowledgeRefs.length }} 条
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  padding: 16px;
}

.drawer {
  position: relative;
  width: min(920px, 100%);
  height: 100%;
  overflow: auto;
  background: var(--panel, #14171c);
  border: 1px solid var(--line, #2a2f38);
  border-radius: 12px;
  padding: 18px 20px 32px;
}

.close {
  position: absolute;
  top: 14px;
  right: 16px;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.quote {
  border-left: 3px solid var(--line, #2a2f38);
  padding: 6px 0 6px 10px;
  margin: 8px 0;
  color: var(--fg-dim, #9aa4b2);
  line-height: 1.7;
}

.quote b {
  display: block;
  color: var(--fg, #e6e9ef);
  font-size: 12px;
  margin-bottom: 2px;
}

.kv {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.kv > div {
  border: 1px solid var(--line, #2a2f38);
  border-radius: 8px;
  padding: 6px 9px;
}

.kv > div span {
  display: block;
  font-size: 11px;
  color: var(--fg-dim, #9aa4b2);
}

.list,
.checklist {
  margin: 6px 0;
  padding-left: 18px;
  line-height: 1.7;
}

.checklist {
  list-style: none;
  padding-left: 0;
}

.checklist > li {
  border-left: 3px solid var(--line, #2a2f38);
  padding: 4px 0 4px 10px;
  margin-bottom: 6px;
}

.checklist > li.pass {
  border-color: var(--ok, #3fb950);
}

.checklist > li.fail {
  border-color: var(--bad, #f85149);
}

.checklist > li.warn {
  border-color: var(--warn, #d29922);
}

.coach {
  border: 1px solid var(--warn, #d29922);
  border-radius: 8px;
  padding: 8px 10px;
  background: rgba(210, 153, 34, 0.08);
}

.tf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  margin-top: 8px;
}

.tf-grid > div {
  border: 1px solid var(--line, #2a2f38);
  border-radius: 8px;
  padding: 6px 9px;
}

.settle {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.settle label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--fg-dim, #9aa4b2);
}

.settle label.wide {
  grid-column: 1 / -1;
}

.settle input,
.settle select {
  background: var(--input-bg, #0d1014);
  border: 1px solid var(--line, #2a2f38);
  border-radius: 6px;
  color: inherit;
  padding: 5px 7px;
  font-size: 13px;
}

.rules {
  margin-top: 14px;
}

.rules summary {
  cursor: pointer;
  color: var(--fg-dim, #9aa4b2);
}

.rules pre {
  margin: 8px 0 0;
  max-height: 380px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.6;
  background: var(--input-bg, #0d1014);
  border: 1px solid var(--line, #2a2f38);
  border-radius: 8px;
  padding: 10px;
  white-space: pre-wrap;
}

.linkish {
  cursor: pointer;
  text-decoration: underline dotted;
}

.ghost.tiny {
  padding: 2px 7px;
  font-size: 11px;
}

.ghost.tiny.danger,
.ghost.danger {
  color: var(--bad, #f85149);
}
</style>
