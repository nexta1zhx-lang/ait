<script setup lang="ts">
import {computed, onMounted, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import SegTabs from '../comps/SegTabs.vue'
import DataTable, {type Column} from '../comps/DataTable.vue'
import SymbolCombo from '../comps/SymbolCombo.vue'
import PieChart, {type PieItem} from '../comps/PieChart.vue'
import {
  deleteAnalysis,
  fetchAnalyses,
  fetchAnalysis,
  tagsOf,
  type AnalysisDetail,
  type AnalysisRow,
  type AnalysisStats,
  type JudgeResultLike
} from '../api'
import {
  GRADE_TEXT,
  VERDICT_LABEL,
  VERDICT_TEXT,
  ago,
  bjTime,
  cny,
  fixed,
  fmt,
  int,
  ms,
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

/** 结论筛选 —— 选项直接取自 `VERDICT_LABEL`，跟 AI 给的那三个结论一字不差 */
const VERDICTS = [
  {value: '', label: '全部结论'},
  ...(['go', 'wait', 'no_go'] as const).map(v => ({
    value: v as string,
    label: VERDICT_LABEL[v]
  }))
]

const days = ref(90)
const symbol = ref(
  typeof route.query.symbol === 'string' ? route.query.symbol : ''
)
const grade = ref('')
const verdict = ref('')
/** 只看某个形状标签（空 = 全部）—— 点下面那排标签就切 */
const tag = ref(typeof route.query.tag === 'string' ? route.query.tag : '')
const actionable = ref(false)

/** 再点一下同一个标签 = 取消筛选 */
function pickTag(name: string): void {
  tag.value = tag.value === name ? '' : name
}

/** 结论筛选（跟上面那个 SegTabs 是同一个状态）—— 点饼图就等于点那个 tab */
function pickVerdict(v: string): void {
  verdict.value = verdict.value === v ? '' : v
}

/** 币种筛选（跟 SymbolCombo 同一个状态） */
function pickSymbol(s: string): void {
  symbol.value = symbol.value.trim().toUpperCase() === s ? '' : s
}

/** 一键清掉所有筛选（时间范围保留） */
function clearFilters(): void {
  symbol.value = ''
  verdict.value = ''
  tag.value = ''
  actionable.value = false
}

/** 现在是「在看哪几条」的一句话（没有筛选就是空） */
const filterText = computed(() => {
  const parts: string[] = []
  if (symbol.value.trim()) parts.push(`币 ${symbol.value.trim().toUpperCase()}`)
  if (verdict.value) parts.push(`结论 ${verdictText(verdict.value)}`)
  if (tag.value) parts.push(`标签 ${tag.value}`)
  if (actionable.value) parts.push('只看可做')
  return parts.length ? `正在看：${parts.join(' · ')}` : ''
})

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
  tag: tag.value,
  actionable: actionable.value,
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
watch([days, symbol, grade, verdict, tag, actionable], () => {
  offset.value = 0
  load()
})

const rmb = (usdValue: unknown) => cny((Number(usdValue) || 0) * rate.value)

/* ---------------- 左边三张饼图 ---------------- */

const verdictItems = computed<PieItem[]>(() =>
  (stats.value?.byVerdict ?? []).map(v => ({
    key: v.verdict,
    // 老记录没写结论（null）→ 单独归一类；其余一律用同一份中文说法
    label: VERDICT_LABEL[v.verdict] ?? '没写结论',
    value: v.calls
  }))
)

const tagItems = computed<PieItem[]>(() =>
  (stats.value?.byTag ?? []).map(t => ({
    key: t.name,
    label: t.name,
    value: t.calls,
    note: t.avgProbability === null ? undefined : `均 ${t.avgProbability}%`
  }))
)

const symbolItems = computed<PieItem[]>(() =>
  (stats.value?.bySymbol ?? []).map(s => ({
    key: s.symbol,
    label: s.symbol,
    value: s.calls
  }))
)

/* ---------------- 列表 ---------------- */

const listCols: Column<AnalysisRow>[] = [
  {key: 'createdAt', label: '时间', strong: true, width: '132px'},
  {key: 'symbol', label: '币种', width: '100px'},
  // 唯一不给宽度的列 —— 它平分剩下的宽度，标签排不完就在格子里换行
  {
    key: 'tags',
    label: '标签',
    wrap: true,
    value: r => (r.tags ?? []).map(t => t.name).join(',')
  },
  {key: 'verdict', label: '结论', width: '84px'},
  {
    key: 'price',
    label: '当时价',
    align: 'right',
    width: '100px',
    value: r => r.price ?? 0
  },
  {
    key: 'costUsd',
    label: '花费',
    align: 'right',
    width: '72px',
    value: r => r.costUsd ?? 0
  },
  {key: 'actions', label: '操作', width: '96px'}
]

const gradeText = (g: string | null) => (g ? (GRADE_TEXT[g] ?? `${g} 档`) : '—')
const verdictText = (v: string | null) =>
  v ? (VERDICT_TEXT[v]?.[0] ?? v) : '—'
const verdictTone = (v: string | null) =>
  v ? (VERDICT_TEXT[v]?.[1] ?? '') : 'dim'
const num = (v: number | null) => (v === null ? '—' : fixed(v, 4))

/* 新记录的预测内容都在 result 里（标签用 tagsOf 取，兼容老记录） */
const strOf = (r: JudgeResultLike | null, k: string) => {
  const v = r?.[k]
  return typeof v === 'string' ? v.trim() : ''
}
const outlookOf = (r: JudgeResultLike | null) => strOf(r, 'outlook')
const recOf = (r: JudgeResultLike | null) => strOf(r, 'recommendation')
/** 走势概率；老记录没有 → 0（页面上就不显示百分比） */
const probOf = (r: JudgeResultLike | null) => {
  const n = Number(r?.probability)
  return Number.isFinite(n) ? Math.round(n) : 0
}

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

/* ---------------- 删除 ---------------- */

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
  <div class="hist">
    <!-- 顶部筛选：时间范围是全局的（左右都受影响），其余对应右边列表 -->
    <section class="panel filter-bar">
      <SegTabs v-model="days" :options="RANGES" />
      <div style="width: 150px">
        <SymbolCombo v-model="symbol" :contracts="contracts" />
      </div>
      <SegTabs v-model="verdict" :options="VERDICTS" />
      <label class="chk">
        <input v-model="actionable" type="checkbox" />
        只看「可做」
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

    <div class="hist-split">
      <!-- ── 左：三张饼图（点扇区或图例就筛，跟上面的筛选联动） ── -->
      <aside class="col charts">
        <section class="panel">
          <h2>
            结论分布 <span class="tag">最近 {{ days }} 天</span>
          </h2>
          <PieChart
            :items="verdictItems"
            :active-key="verdict"
            empty-text="这段时间没有记录"
            @pick="pickVerdict"
          />
        </section>

        <section class="panel">
          <h2>标签分布 <span class="tag">按出现次数</span></h2>
          <PieChart
            :items="tagItems"
            :active-key="tag"
            :top="7"
            empty-text="还没有带概率的标签"
            @pick="pickTag"
          />
        </section>

        <section class="panel">
          <h2>币种分布 <span class="tag">按分析次数</span></h2>
          <PieChart
            :items="symbolItems"
            :active-key="symbol.trim().toUpperCase()"
            :top="7"
            empty-text="还没有记录"
            @pick="pickSymbol"
          />
        </section>
      </aside>

      <!-- ── 右：记录列表 ── -->
      <div class="col list">
        <section class="panel">
          <h2>
            分析记录 <span class="tag">共 {{ int(total) }} 条</span>
            <span v-if="filterText" class="picked">
              {{ filterText }}
              <button class="ghost tiny" @click="clearFilters">清掉筛选</button>
            </span>
          </h2>

          <div class="only-desktop">
          <DataTable
            :columns="listCols"
            :rows="rows"
            fixed
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
            <template #tags="{row}">
              <!-- 列表里一最多摆 3 个 —— 再多就换行把行高撑起来了；
                   多的只报个数，想看全部进详情 -->
              <span v-if="(row.tags ?? []).length" class="tags">
                <span
                  v-for="t in row.tags.slice(0, 3)"
                  :key="t.name"
                  class="tag"
                >
                  {{ t.name }}
                  <i v-if="t.probability">{{ t.probability }}%</i>
                </span>
                <span
                  v-if="row.tags.length > 3"
                  class="tag more"
                  :title="
                    row.tags
                      .slice(3)
                      .map(t => t.name)
                      .join('、')
                  "
                >
                  +{{ row.tags.length - 3 }}
                </span>
              </span>
              <span v-else class="dim">—</span>
            </template>
            <template #verdict="{row}">
              <span :class="['v', verdictTone(row.verdict)]">
                {{ verdictText(row.verdict) }}
              </span>
            </template>
            <template #costUsd="{row}">{{ rmb(row.costUsd) }}</template>
            <template #actions="{row}">
              <button class="ghost tiny" @click="open(row.id)">详情</button>
              <button class="ghost tiny danger" @click="remove(row.id)">
                删
              </button>
            </template>
          </DataTable>
          </div>

          <!-- 手机端：7 列表格塞不下（实测 584px 挤在 390px 屏幕里）→ 卡片 -->
          <ul class="hist-cards">
            <li v-if="!rows.length" class="hc-empty dim">
              这段时间没有分析记录
            </li>
            <li v-for="row in rows" :key="row.id" @click="open(row.id)">
              <div class="hc-top">
                <b>{{ row.symbol }}</b>
                <span class="dim hc-tf">{{ row.timeframes.join(' · ') }}</span>
                <span :class="['v', verdictTone(row.verdict)]">
                  {{ verdictText(row.verdict) }}
                </span>
              </div>
              <div class="hc-meta dim">
                {{ bjTime(row.createdAt) }} · 当时价 {{ fmt(row.price) }} ·
                {{ rmb(row.costUsd) }}
              </div>
              <div v-if="(row.tags ?? []).length" class="tags">
                <span v-for="t in row.tags.slice(0, 3)" :key="t.name" class="tag">
                  {{ t.name }}
                  <i v-if="t.probability">{{ t.probability }}%</i>
                </span>
                <span v-if="row.tags.length > 3" class="tag more">
                  +{{ row.tags.length - 3 }}
                </span>
              </div>
            </li>
          </ul>

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
      </div>
    </div>

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
            <span class="grade" :class="verdictTone(detail.verdict)">
              {{
                probOf(detail.result)
                  ? `概率 ${probOf(detail.result)}%`
                  : gradeText(detail.grade)
              }}
            </span>
            <span :class="['v', verdictTone(detail.verdict)]">
              {{ verdictText(detail.verdict) }}
            </span>
          </div>

          <!-- 形状标签 + 概率 -->
          <div v-if="tagsOf(detail.result).length" class="tags">
            <span v-for="t in tagsOf(detail.result)" :key="t.name" class="tag">
              {{ t.name }}
              <i v-if="t.probability">{{ t.probability }}%</i>
            </span>
          </div>

          <p v-if="outlookOf(detail.result)" class="quote">
            <b>走势</b>{{ outlookOf(detail.result) }}
          </p>
          <p v-if="detail.gradeReason" class="quote">
            <b>理由</b>{{ detail.gradeReason }}
          </p>
          <p v-if="detail.verdictReason" class="quote">
            <b>老记录的结论理由</b>{{ detail.verdictReason }}
          </p>
          <p v-if="recOf(detail.result)" class="quote">
            <b>推荐</b>{{ recOf(detail.result) }}
          </p>

          <!-- 行情快照 -->
          <h3>当时的行情</h3>
          <div class="kv">
            <div>
              <span>现价</span
              ><b>{{ num(detail.snapshot?.price ?? detail.price) }}</b>
            </div>
            <div>
              <span>看的周期</span>
              <b>{{ detail.timeframes.join(' · ') }}</b>
            </div>
            <div>
              <span>图表周期</span><b>{{ detail.chartTimeframe ?? '—' }}</b>
            </div>
          </div>
          <p v-if="detail.snapshot?.structure" class="dim">
            {{ structureFull(detail.snapshot?.structure) }}
          </p>

          <!-- 各周期行情：新记录存的是切段读出来的文字 -->
          <div v-if="(detail.snapshot?.blocks ?? []).length" class="tf-grid">
            <div v-for="b in detail.snapshot?.blocks ?? []" :key="b.timeframe">
              <b>{{ b.timeframe }}</b>
              <span class="dim" style="font-size: 11px">
                {{ b.bars }} 根{{ b.primary ? ' · 主周期' : '' }}
              </span>
            </div>
          </div>

          <div
            v-else-if="(detail.snapshot?.timeframes ?? []).length"
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
              <span>提示词版本</span>
              <b title="提示词 hash（正文 + 输出契约），任一处改了这里就变">
                {{ detail.rulesHash ? detail.rulesHash.slice(0, 12) : '—' }}
              </b>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 10px">
            <button class="ghost danger" @click="remove(detail.id)">
              删除这条
            </button>
          </div>

          <!-- 当时的提示词正文 -->
          <details v-if="detail.rules?.body" class="rules">
            <summary>
              当时的提示词正文
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
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 左饼图 / 右列表 */
.hist {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hist-split {
  display: grid;
  grid-template-columns: minmax(0, 340px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

/*
 * 整页塞下时（`body.fixed-viewport`，跟开单分析同一套）：
 * 顶部筛选固定，左右两列各自内部滚 —— 页面本身不滚。
 *
 * ⚠️ 只在**宽屏（两列）**下这么做。窄屏是单列，网格一旦有确定高度，
 * 两行会被**均分**（各 122px），内容直接溢出到看不见 —— 那时候改成整页滚。
 */
@media (min-width: 1101px) {
  body.fixed-viewport .hist {
    flex: 1 1 auto;
    min-height: 0;
  }

  body.fixed-viewport .hist-split {
    flex: 1 1 auto;
    min-height: 0;
    align-items: stretch;
  }

  body.fixed-viewport .hist-split > .col {
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 4px;
  }
}

.charts {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 列表在栏内滚的时候，翻页条钉在底部，不用滚到底才能翻页 */
body.fixed-viewport .list .pager {
  position: sticky;
  bottom: 0;
  margin-bottom: 0;
  padding-bottom: 4px;
  background: var(--panel, #14171c);
}

/* 窄屏退成单列：整页滚，两列不再各自内部滚 */
@media (max-width: 1100px) {
  .hist-split {
    grid-template-columns: minmax(0, 1fr);
  }
  body.fixed-viewport .hist {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  body.fixed-viewport .hist-split {
    flex: 0 0 auto;
    align-items: start;
  }
}

/* ==================== 手机端：列表换卡片 ==================== */
/*
 * 7 列表格在手机上没救（实测 584px 宽挤在 390px 屏幕里，只能横着拖），
 * 所以窄屏整张表换成一叠卡片 —— 卡片用同一批数据，只是换个排法。
 */
.hist-cards {
  display: none;
  list-style: none;
  margin: 0;
  padding: 0;
  flex-direction: column;
  gap: 8px;
}

.hist-cards > li {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--panel-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
}

.hist-cards > li:hover {
  border-color: var(--blue);
}

.hist-cards .hc-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.hist-cards .hc-top b {
  font-size: 14px;
}

.hist-cards .hc-tf {
  font-size: 11px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist-cards .hc-meta {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.hist-cards .tags {
  margin-top: 0;
}

.hist-cards .hc-empty {
  border: 0;
  background: none;
  cursor: default;
}

@media (max-width: 900px) {
  .only-desktop {
    display: none;
  }
  .hist-cards {
    display: flex;
  }
  /*
   * 饼图从「竖着一列」改成铺网格：手机上横着放两三张，少滚很多。
   * ⚠️ 必须写在这里（scoped）—— scoped 会加一层属性选择器，特异性高于
   * style.css 里的媒体查询，全局那条压不过它。
   */
  .charts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px;
  }
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* 「正在看：… 清掉筛选」那一小块 */
.picked {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--blue, #58a6ff);
}

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

.list {
  margin: 6px 0;
  padding-left: 18px;
  line-height: 1.7;
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
