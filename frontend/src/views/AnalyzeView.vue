<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import {RouterLink} from 'vue-router'
import SymbolCombo from '../comps/SymbolCombo.vue'
import KlineChart from '../comps/KlineChart.vue'
import DataTable, {type Column} from '../comps/DataTable.vue'
import SegTabs from '../comps/SegTabs.vue'
import {
  analyzeStream,
  type AnalyzeResult,
  type AnalyzeStep,
  type ChecklistItem,
  type Heat,
  type TfStat
} from '../api'
import {contracts, config, refreshConfig} from '../store'
import {
  GRADE_TEXT,
  VERDICT_TEXT,
  fixed,
  fmt,
  signedPct,
  structureFull,
  structureText,
  TREND_TEXT
} from '../format'

/* ---------------- 表单 ---------------- */

const symbol = ref('BTC')
const chartTf = ref('1h')

const loading = ref(false)
const error = ref('')
const result = ref<AnalyzeResult | null>(null)
/** 分析过程：后端用 SSE 一步步推过来 */
const steps = ref<AnalyzeStep[]>([])
/** 心跳，用来给「进行中」那一步算实时耗时 */
const tick = ref(0)
const runStartedAt = ref(0)
let ticker: number | undefined
let closeStream: (() => void) | null = null
/** 每一步的开始时刻，用来给「进行中」那一步算实时耗时 */
const stepStartedAt = new Map<string, number>()

/** 周期和假设胜率都由后端配置决定，页面上不再让用户填 */
const timeframesText = computed(
  () => config.value?.timeframes ?? '15m,1h,4h,1d'
)

/** 左侧三个 tab：结论 / Checklist / 市场与周期 */
const LEFT_TABS = [
  {value: 'verdict', label: 'AI 结论'},
  {value: 'checklist', label: 'Checklist'},
  {value: 'market', label: '市场与周期'}
]
const leftTab = ref<'verdict' | 'checklist' | 'market'>('verdict')

/** 换币种：清掉上一只币的结论，图表由 KlineChart 自己重画 */
function pickSymbol(v: string) {
  symbol.value = v
  result.value = null
  steps.value = []
  error.value = ''
}

function stop() {
  closeStream?.()
  closeStream = null
  window.clearInterval(ticker)
  ticker = undefined
  loading.value = false
}

function run() {
  const s = symbol.value.trim().toUpperCase()
  if (!s) {
    error.value = '请先选择币种'
    return
  }
  if (loading.value) return

  symbol.value = s
  error.value = ''
  result.value = null
  steps.value = []
  stepStartedAt.clear()
  leftTab.value = 'verdict'
  loading.value = true
  runStartedAt.value = Date.now()
  ticker = window.setInterval(() => (tick.value = Date.now()), 200)

  closeStream = analyzeStream(s, {
    onStep(step) {
      const i = steps.value.findIndex(x => x.id === step.id)
      if (i === -1) steps.value.push(step)
      else steps.value[i] = step
      if (step.state === 'running') stepStartedAt.set(step.id, Date.now())
      tick.value = Date.now()
    },
    onDone(r) {
      // 后端给的 steps 是完整终态，直接覆盖，免得漏掉最后几步的耗时
      if (r.steps?.length) steps.value = r.steps
      result.value = r
      stop()
      void refreshConfig()
    },
    onError(msg) {
      error.value = msg
      const running = steps.value.find(x => x.state === 'running')
      if (running) {
        running.state = 'error'
        running.detail = msg
      }
      stop()
    }
  })
}

onBeforeUnmount(stop)

/* ---------------- 分析过程渲染 ---------------- */

const STEP_ICON: Record<AnalyzeStep['state'], string> = {
  running: '◌',
  done: '●',
  error: '✕'
}

/** 某一步花了多久：完成看后端给的 ms，进行中按本地时钟现算 */
function stepMs(s: AnalyzeStep): number {
  void tick.value
  if (s.state !== 'running') return s.ms ?? 0
  const t0 = stepStartedAt.get(s.id) ?? runStartedAt.value
  return Math.max(0, Date.now() - t0)
}

const totalMs = computed(() => {
  void tick.value
  return steps.value.reduce((sum, s) => sum + stepMs(s), 0)
})

function stepTime(s: AnalyzeStep): string {
  const ms = stepMs(s)
  if (!ms) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/* ---------------- 结论渲染 ---------------- */

const judge = computed(() => result.value?.judge)
const guard = computed(() => result.value?.guardrails)

const gradeText = computed(() => GRADE_TEXT[judge.value?.grade ?? 'unclear'])
const gradeCls = computed(() => (judge.value?.grade ?? 'unclear').toLowerCase())
const verdictInfo = computed(
  () => VERDICT_TEXT[judge.value?.verdict ?? ''] ?? ['—', '']
)

const costLine = computed(() => {
  const r = result.value
  if (!r) return ''
  const u = r.meta.usage
  return (
    `本次调用 ${u.text}` +
    (u.attempts > 1 ? ` · 重试 ${u.attempts} 次` : '') +
    (u.callId === null ? '（未记入统计）' : '')
  )
})

const STAT_ICON: Record<string, [string, string]> = {
  pass: ['✅', 'ok'],
  fail: ['❌', 'bad'],
  warn: ['⚠️', 'warn']
}
const iconOf = (c: ChecklistItem) => STAT_ICON[c.status] ?? STAT_ICON.warn

const passCount = computed(
  () => judge.value?.checklist?.filter(c => c.status === 'pass').length ?? 0
)

/** K 线图上的关键价位 */
const chartPlan = computed(() => {
  const j = judge.value
  if (!j) return null
  return {entry: j.entry, stopLoss: j.stopLoss, takeProfits: j.takeProfits}
})

const expRow = computed(() => result.value?.expectancy ?? null)
const position = computed(() => guard.value?.position ?? null)
const tps = computed(() => judge.value?.takeProfits ?? [])
const entryPrice = computed(
  () => judge.value?.entry?.price ?? result.value?.price ?? NaN
)

const heatRows = computed(() => {
  const h: Heat | undefined = result.value?.heat
  if (!h) return []
  const num = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(Number(v))
      ? null
      : Number(v)
  const pctText = (v: number | null, digits = 2) =>
    v === null ? '—' : signedPct(v, digits)
  const rows: {k: string; v: string; cls?: string}[] = []
  const ch = num(h.change24hPct)
  rows.push({
    k: '24h 涨跌',
    v: pctText(ch),
    cls: ch === null ? '' : ch >= 0 ? 'ok' : 'bad'
  })
  rows.push({
    k: '24h 振幅',
    v: num(h.amplitude24hPct) === null ? '—' : fixed(h.amplitude24hPct, 2) + '%'
  })
  rows.push({k: '24h 高 / 低', v: `${fmt(h.high24h)} / ${fmt(h.low24h)}`})
  rows.push({
    k: '24h 成交额',
    v: num(h.quoteVolume24h) === null ? '—' : fmt(h.quoteVolume24h, 0)
  })
  rows.push({
    k: '资金费率',
    v:
      num(h.fundingRate) === null
        ? '—'
        : (Number(h.fundingRate) * 100).toFixed(4) + '%'
  })
  rows.push({
    k: '持仓量',
    v: num(h.openInterest) === null ? '—' : fmt(h.openInterest, 0)
  })
  const oiCh = num(h.openInterestChangePct)
  rows.push({
    k: '持仓量变化',
    v: pctText(oiCh),
    cls: oiCh === null ? '' : oiCh >= 0 ? 'ok' : 'bad'
  })
  rows.push({
    k: '多空人数比',
    v: num(h.longShortRatio) === null ? '—' : fixed(h.longShortRatio, 2)
  })
  return rows
})

const tfCols: Column<TfStat>[] = [
  {key: 'timeframe', label: '周期', strong: true},
  {key: 'close', label: '收盘', align: 'right', value: r => r.close},
  {key: 'trend', label: '趋势', value: r => r.trend},
  {
    key: 'netChangePct',
    label: '净涨跌',
    align: 'right',
    value: r => r.netChangePct
  },
  {key: 'rangePct', label: '振幅', align: 'right', value: r => r.rangePct},
  {key: 'volRatio', label: '量比', align: 'right', value: r => r.volRatio},
  {key: 'structure', label: '结构', align: 'right'}
]
</script>

<template>
  <div class="analyze">
    <!-- ============ 顶部：查询 + 分析过程 ============ -->
    <section class="panel query-bar">
      <div class="query-left">
        <label class="field">
          <span>币种</span>
          <SymbolCombo
            v-model="symbol"
            :contracts="contracts"
            @pick="pickSymbol"
            @submit="run"
          />
        </label>
        <button class="btn-block" :disabled="loading" @click="run">
          {{ loading ? '判断中…' : '让 AI 判断' }}
        </button>
        <p class="hint">
          看周期 {{ timeframesText }} · 模型 {{ config?.model ?? '—' }}
        </p>
      </div>

      <div class="query-right">
        <div class="steps-head">
          <h3>分析过程</h3>
          <span v-if="steps.length" class="dim">
            {{ loading ? '进行中' : '完成' }} · 共
            {{ (totalMs / 1000).toFixed(1) }}s
          </span>
        </div>
        <ol v-if="steps.length" class="steps">
          <li
            v-for="s in steps"
            :key="s.id"
            class="step"
            :class="[s.state, {active: s.state === 'running'}]"
          >
            <span class="dot">{{ STEP_ICON[s.state] }}</span>
            <span class="body">
              <b>{{ s.label }}</b>
              <em v-if="s.detail">{{ s.detail }}</em>
            </span>
            <span class="ms">{{ stepTime(s) }}</span>
          </li>
        </ol>
        <p v-else class="hint">
          点「让 AI 判断」后，这里会逐步写出：读规则 → 取知识库 → 拉行情 →
          拼上下文 → 调模型 → 护栏校验 → 存档。
        </p>
      </div>
    </section>

    <div v-if="error" class="error">❌ {{ error }}</div>

    <!-- ============ K 线（整行，高度收窄） ============ -->
    <KlineChart
      class="chart-slim"
      :symbol="symbol"
      :timeframe="chartTf"
      :plan="chartPlan"
      @update:timeframe="chartTf = $event"
      @error="error = $event"
    />

    <!-- ============ 两列：左 tab / 右三块 ============ -->
    <div class="split">
      <!-- 左 -->
      <div class="col">
        <div class="tab-row">
          <SegTabs v-model="leftTab" :options="LEFT_TABS" />
          <RouterLink
            v-if="result?.analysisId"
            class="archived-link"
            :to="`/history?id=${result.analysisId}`"
          >
            已存档 #{{ result.analysisId }} → 去复盘
          </RouterLink>
        </div>

        <section v-if="!result" class="panel">
          <p class="hint">
            还没有结论。选个币，点「让 AI 判断」；判断完这里会出现
            档位、理由、Checklist 和市场数据。
          </p>
        </section>

        <!-- ── tab 1：AI 结论 ── -->
        <section v-else-if="leftTab === 'verdict'" class="panel">
          <div class="grade-row">
            <div class="grade" :class="gradeCls">{{ gradeText }}</div>
            <div class="grade-title">
              <span class="pill" :class="verdictInfo[1]">{{
                verdictInfo[0]
              }}</span>
              <span class="conf">把握 {{ result.judge.confidence }}/100</span>
              <span v-if="costLine" class="conf">{{ costLine }}</span>
            </div>
          </div>

          <p class="hint" style="margin-top: 10px">
            {{ result.judge.gradeReason }}
          </p>
          <div v-if="result.judge.verdictReason" class="reasoning">
            {{ result.judge.verdictReason }}
          </div>

          <div class="stats">
            <div class="stat">
              <span class="k">当前价</span>
              <span class="v">{{ fmt(result.price) }}</span>
            </div>
            <div class="stat">
              <span class="k">24h 涨跌</span>
              <span
                class="v"
                :class="
                  result.change24hPct == null
                    ? ''
                    : result.change24hPct >= 0
                      ? 'ok'
                      : 'bad'
                "
              >
                {{ signedPct(result.change24hPct) }}
              </span>
            </div>
            <div class="stat">
              <span class="k">资金费率</span>
              <span class="v">
                {{
                  result.fundingRate == null
                    ? '—'
                    : (Number(result.fundingRate) * 100).toFixed(4) + '%'
                }}
              </span>
            </div>
            <div class="stat">
              <span class="k">波段高 / 低</span>
              <span class="v">
                {{ fmt(result.structure?.swingHigh) }} /
                {{ fmt(result.structure?.swingLow) }}
              </span>
            </div>
            <div class="stat">
              <span class="k">规则版本</span>
              <span class="v">{{ result.meta.rules.hash }}</span>
            </div>
            <div class="stat">
              <span class="k">知识库</span>
              <span class="v">
                {{ result.meta.knowledgeUsed ? '已注入经验' : '无经验可引' }}
              </span>
            </div>
          </div>

          <template v-if="result.judge.knowledgeRefs?.length">
            <h3 style="margin-top: 16px">
              知识库参考 <span class="tag">来自我的案例</span>
            </h3>
            <ul class="checklist">
              <li
                v-for="k in result.judge.knowledgeRefs"
                :key="k.lesson"
                class="ok"
              >
                <span class="rule">{{ k.lesson }}</span>
                <span class="note">{{ k.symbol }} {{ k.timeframe }}</span>
              </li>
            </ul>
          </template>
        </section>

        <!-- ── tab 2：Checklist ── -->
        <section v-else-if="leftTab === 'checklist'" class="panel">
          <h2>
            Checklist
            <span class="tag">{{ passCount }}/{{ judge?.checklist?.length }} 通过</span>
          </h2>
          <ul class="checklist big">
            <li v-if="!judge?.checklist?.length" class="muted">
              （AI 没有返回 Checklist）
            </li>
            <li
              v-for="c in judge?.checklist ?? []"
              :key="c.item"
              :class="iconOf(c)[1]"
            >
              <span>{{ iconOf(c)[0] }}</span>
              <span class="rule">{{ c.item }}</span>
              <span v-if="c.evidence" class="note">{{ c.evidence }}</span>
            </li>
          </ul>
        </section>

        <!-- ── tab 3：市场与周期 ── -->
        <template v-else>
          <section class="panel">
            <h2>市场热度 <span class="tag">交易所数据</span></h2>
            <div class="heat-grid">
              <div v-for="r in heatRows" :key="r.k" class="heat-row">
                <span class="k">{{ r.k }}</span>
                <span class="v" :class="r.cls">{{ r.v }}</span>
              </div>
            </div>
          </section>

          <section class="panel">
            <h2>
              多周期趋势
              <span class="tag">代码统计 · AI 据此判断周期是否一致</span>
            </h2>
            <DataTable :columns="tfCols" :rows="result.timeframes">
              <template #close="{row}">{{ fmt(row.close) }}</template>
              <template #trend="{row}">
                <span
                  :class="
                    row.trend === 'up'
                      ? 'v ok'
                      : row.trend === 'down'
                        ? 'v bad'
                        : 'v muted'
                  "
                >
                  {{ TREND_TEXT[row.trend] ?? row.trend }}
                </span>
              </template>
              <template #netChangePct="{row}">
                <span :class="row.netChangePct >= 0 ? 'v ok' : 'v bad'">
                  {{ signedPct(row.netChangePct) }}
                </span>
              </template>
              <template #rangePct="{row}">
                {{ fixed(row.rangePct, 2) }}%
              </template>
              <template #volRatio="{row}">
                {{ fixed(row.volRatio, 2) }}
              </template>
              <template #structure="{row}">
                <span :title="structureFull(row.structure)">
                  {{ structureText(row.structure) }}
                </span>
              </template>
            </DataTable>
          </section>
        </template>
      </div>

      <!-- 右：怎么做 / 必须走 / 守住 -->
      <aside class="col side">
        <section class="panel">
          <h2>怎么做 <span class="tag">代码计算</span></h2>
          <template v-if="result">
            <div class="plan">
              <div class="plan-row">
                <span class="k">入场</span>
                <span class="v">
                  {{ fmt(entryPrice) }}
                  <em>{{
                    result.judge.entry?.type === 'limit' ? '限价' : '市价'
                  }}</em>
                </span>
              </div>
              <div class="plan-row">
                <span class="k">止损</span>
                <span
                  class="v"
                  :class="result.judge.stopLoss != null ? 'bad' : 'muted'"
                >
                  <template v-if="result.judge.stopLoss != null">
                    {{ fmt(result.judge.stopLoss) }}
                    <em>
                      {{
                        signedPct(
                          ((result.judge.stopLoss - entryPrice) / entryPrice) *
                            100
                        )
                      }}
                    </em>
                  </template>
                  <template v-else>写不出止损 → 不做</template>
                </span>
              </div>
              <div class="plan-row">
                <span class="k">止盈</span>
                <span class="v" :class="tps.length ? 'ok' : 'muted'">
                  <template v-if="!tps.length">—</template>
                  <template v-for="(t, i) in tps" :key="t.label">
                    <br v-if="i" />
                    {{ fmt(t.price) }}
                    <em
                      >{{ t.label }} {{ fmt(t.r, 1) }}R<span
                        v-if="t.reducePercent"
                      >
                        减{{ t.reducePercent }}%</span
                      ></em
                    >
                  </template>
                </span>
              </div>
              <div class="plan-row">
                <span class="k">期望值</span>
                <span
                  v-if="expRow"
                  class="v"
                  :class="expRow.positive ? 'ok' : 'bad'"
                >
                  {{ expRow.expectancyR }}R
                  <em>
                    胜率 {{ Math.round(expRow.winRate * 100) }}% × 加权
                    {{ expRow.weightedR }}R
                  </em>
                </span>
                <span v-else class="v muted">无法计算（没有止损或止盈）</span>
              </div>
              <template v-if="position">
                <div class="plan-row">
                  <span class="k">仓位</span>
                  <span class="v">
                    {{ fmt(position.quantity, 4) }}
                    <em>名义 {{ fmt(position.notional) }} U</em>
                  </span>
                </div>
                <div class="plan-row">
                  <span class="k">风险</span>
                  <span class="v">
                    {{ fmt(position.riskAmount) }} U
                    <em>账户 {{ position.riskPercent }}%</em>
                  </span>
                </div>
                <div class="plan-row">
                  <span class="k">杠杆</span>
                  <span class="v">
                    {{ fmt(position.requiredLeverage, 2) }}x
                    <em>建议 {{ fmt(position.leverageUsed, 2) }}x</em>
                  </span>
                </div>
              </template>
              <div v-else class="plan-row">
                <span class="k">仓位</span>
                <span class="v muted">未计算（不可做或缺少止损）</span>
              </div>
              <div
                v-if="guard && !guard.passed && guard.violations.length"
                class="plan-row"
              >
                <span class="k">护栏</span>
                <span class="v bad">
                  {{ guard.violations.map(v => v.desc || v.id).join('；') }}
                </span>
              </div>
            </div>
          </template>
          <p v-else class="hint">
            仓位与杠杆由代码算，不采信 AI 的算术。有结论后这里会填上。
          </p>
        </section>

        <section class="panel">
          <h2>什么情况下必须走</h2>
          <ul v-if="result" class="checklist">
            <li v-if="!result.judge.exitTriggers?.length" class="muted">
              （本次没有给出）
            </li>
            <li v-for="e in result.judge.exitTriggers" :key="e" class="warn">
              <span class="rule">{{ e }}</span>
            </li>
          </ul>
          <p v-else class="hint">
            AI 会给「动能衰竭 / 冲高兑现」这类离场触发条件。
          </p>
        </section>

        <section class="panel coach-panel">
          <h2>⚠️ 当前最该守住的</h2>
          <p v-if="result" class="coach-line">
            {{ result.judge.coachLine || '（AI 没给）' }}
          </p>
          <p v-else class="hint">每次判断 AI 都会留一句提醒，防止犯病。</p>
        </section>
      </aside>
    </div>
  </div>
</template>
