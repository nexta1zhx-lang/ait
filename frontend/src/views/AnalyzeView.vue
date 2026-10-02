<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {RouterLink} from 'vue-router'
import SymbolCombo from '../comps/SymbolCombo.vue'
import KlineChart from '../comps/KlineChart.vue'
import SegTabs from '../comps/SegTabs.vue'
import CollectForm from '../comps/CollectForm.vue'
import StepsPanel from '../comps/StepsPanel.vue'
import {tagsOf, type Heat} from '../api'
import {
  CHART_BARS,
  LEFT_TABS,
  LIVE_TABS,
  RUN_MODES,
  chartFrom,
  chartRange,
  chartTf,
  chartUntil,
  clearChartRange,
  error,
  history,
  historyError,
  historyGo,
  historyPage,
  historyPageSize,
  historyPages,
  historyTotal,
  leftTab,
  liveTab,
  loadHistory,
  loading,
  pickSymbol,
  rangeDrawing,
  result,
  run,
  runMode,
  setHistoryPageSize,
  setRunMode,
  showSteps,
  spanText,
  steps,
  symbol,
  testAt,
  testMode,
  timeframesText
} from '../analyze'
import {contracts, config} from '../store'
import {VERDICT_TEXT, bjShort, bjTime, fixed, fmt, signedPct} from '../format'

// 结论、分析过程、报错都在 ../analyze 的模块作用域里，
// 切到别的页面再回来不会丢；这里只负责首次进页面把历史拉一次。
onMounted(() => void loadHistory(symbol.value))

/* ---------- 历史列表：能放几行就放几行，列表自己不出滚动条 ---------- */
const histBox = ref<HTMLElement | null>(null)
let histRO: ResizeObserver | null = null

/** 左边栏可视高度 ÷ 单行高度 = 这一页该放几条 */
function measureHistoryRows(): void {
  const box = histBox.value
  if (!box) return
  const h = box.clientHeight
  if (h <= 0) return
  // 拿真实渲染出来的行高算，别猜 CSS
  const row = box.querySelector('li')?.getBoundingClientRect().height || 28
  setHistoryPageSize(Math.floor(h / row))
}

// tab 切过来时 ul 才存在，ref 一挂上就量；窗口缩放由 ResizeObserver 接着管
watch(histBox, el => {
  histRO?.disconnect()
  histRO = null
  if (!el) return
  histRO = new ResizeObserver(() => measureHistoryRows())
  histRO.observe(el)
  void nextTick(measureHistoryRows)
})

// 第一页拉回来的行渲染完了，才量得到真实行高
watch(
  () => history.value.length,
  () => void nextTick(measureHistoryRows)
)

onBeforeUnmount(() => histRO?.disconnect())

// 离开「实时 / 添加案例」就不用再等着我拖了（图也会退回普通模式）
watch([leftTab, runMode], () => {
  const ok = leftTab.value === 'add' || testMode.value
  if (!ok) rangeDrawing.value = false
})

const onChartError = (msg: string) => (error.value = msg)

/** 图上是「添加案例」还是「测试」在圈范围 —— 两个 tab 共用同一段选择 */
const chartSelectable = computed(
  () => leftTab.value === 'add' || testMode.value
)

/** 测试模式下那一段的时间跨度 */
const testSpan = computed(() => {
  const r = chartRange.value
  if (!r) return ''
  const h = (r.to - r.from) / 3_600_000
  return h >= 24
    ? `${Math.round((h / 24) * 10) / 10} 天`
    : `${Math.round(h)} 小时`
})

/** 图上拖完一段 → 记下范围，顺手退出拖动模式（图恢复可拖） */
function onPickRange(v: {from: number; to: number; bars: number}) {
  chartRange.value = v
  rangeDrawing.value = false
}

/* ---------------- 结论渲染 ---------------- */

const judge = computed(() => result.value?.judge)

/** AI 挑的标签（模板外的不做过滤，标出来给人看） */
const tags = computed(() => tagsOf(result.value?.judge))

/** 结论头那颗徽标 —— 不再判档，直接显示**走势概率** */
const probText = computed(() =>
  judge.value ? `概率 ${judge.value.probability}%` : '未判断'
)
const verdictInfo = computed(
  () => VERDICT_TEXT[judge.value?.verdict ?? ''] ?? ['—', '']
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
</script>

<template>
  <div class="analyze">
    <!-- ============ 查询 ============ -->
    <section class="panel query-bar">
      <label class="field">
        <span>币种</span>
        <SymbolCombo
          v-model="symbol"
          :contracts="contracts"
          @pick="pickSymbol"
          @submit="run"
        />
      </label>
      <label class="field mode-field" :class="{on: testMode}">
        <span>模式</span>
        <SegTabs
          :model-value="runMode"
          :options="RUN_MODES"
          @update:model-value="setRunMode"
        />
      </label>
      <label
        class="field days-field"
        title="我在图上看的那个周期（主周期），就看图上这一段；其余周期按它跟着取"
      >
        <span>范围</span>
        <b class="days-readonly"> 图上 {{ CHART_BARS }} 根 ≈ {{ spanText }} </b>
      </label>
      <button class="btn-run" :disabled="loading" @click="run">
        {{ loading ? '判断中…' : testMode ? '按这段行情判断' : '让 AI 判断' }}
      </button>
      <span class="hint">
        看周期 {{ timeframesText }} · 图上 {{ CHART_BARS }} 根 ≈
        {{ spanText }} · 模型 {{ config?.model ?? '—' }}
      </span>
    </section>

    <div v-if="error" class="error">❌ {{ error }}</div>

    <!-- ============ 左右布局 ============ -->
    <div class="split">
      <!-- ── 左：实时分析 / 历史分析 ── -->
      <div class="col">
        <div class="tab-row">
          <SegTabs v-model="leftTab" :options="LEFT_TABS" />
          <RouterLink
            v-if="leftTab === 'live' && result?.analysisId"
            class="archived-link"
            :to="`/history?id=${result.analysisId}`"
          >
            已存档 #{{ result.analysisId }} → 去复盘
          </RouterLink>
        </div>

        <!-- ① 实时分析 -->
        <template v-if="leftTab === 'live'">
          <div class="scroll-body">
            <!-- 测试模式：跟「添加案例」一样，先在图上圈一段 -->
            <section v-if="testMode" class="panel test-panel">
              <h2>
                测试 · 圈一段行情
                <span class="tag">不存档</span>
              </h2>
              <p class="hint">
                点「画范围」，再到右边 K 线上<b>横着拖一段</b>。 AI
                会把这一段的<b>结束时刻</b>当成「当时」来判 ——
                只看得到那一刻之前<b>已经收盘</b>的 K 线，之后的一根都不给。
              </p>

              <div class="follow-row" :class="{picked: !!chartRange}">
                <span class="k">{{ chartRange ? '范围' : '范围' }}</span>
                <span class="v">
                  <template v-if="chartRange">
                    {{ bjTime(chartRange.from) }} → {{ bjTime(chartRange.to) }}
                    <em>
                      {{ chartRange.bars }} 根 · 约 {{ testSpan }} · 判断时点是
                      {{ bjTime(chartRange.to) }}
                    </em>
                  </template>
                  <template v-else-if="rangeDrawing">
                    在右边图上拖一段…
                    <em>横向拖，松手就选好（按 Esc 取消）</em>
                  </template>
                  <template v-else>
                    还没选
                    <em>点右边「画范围」开始</em>
                  </template>
                </span>

                <button
                  type="button"
                  class="ghost tiny range-btn"
                  :class="{on: rangeDrawing}"
                  :title="
                    rangeDrawing
                      ? '在图上横向拖一段，松手就算选好（Esc 取消）'
                      : '在图上拖出一段 K 线，以这一段的结尾为判断时点'
                  "
                  @click="rangeDrawing = !rangeDrawing"
                >
                  {{ rangeDrawing ? '取消' : chartRange ? '重画' : '画范围' }}
                </button>
                <button
                  v-if="chartRange"
                  type="button"
                  class="ghost tiny"
                  title="清掉范围，重新圈"
                  @click="clearChartRange"
                >
                  清掉
                </button>
              </div>
            </section>

            <!-- 测试模式：必须一眼看出来这不是实时那一局 -->
            <div v-if="testAt" class="test-banner">
              <b>⏱ 测试模式 · 判断时点 {{ bjTime(testAt) }}</b>
              <span
                >AI 只看得到这一刻之前已收盘的 K 线；资金费率 / 持仓量 /
                多空比拿不到、留空。<b>本次不存档。</b></span
              >
            </div>

            <StepsPanel
              :steps="steps"
              :done="!!result"
              :running="loading"
              :open="showSteps"
              :hint="
                testMode
                  ? '点「按这段行情判断」后，这里会逐步写出：读分析预测提示词 → 取可用的标签 → 拉那一刻的行情 → 拼上下文 → 调模型（测试跑不存档）。'
                  : '点「让 AI 判断」后，这里会逐步写出：读分析预测提示词 → 取可用的标签 → 拉行情 → 拼上下文 → 调模型 → 存档。'
              "
              @update:open="showSteps = $event"
            />

            <template v-if="result">
              <SegTabs
                v-model="liveTab"
                :options="LIVE_TABS"
                class="sub-tabs"
              />

              <!-- tab 1：AI 结论 -->
              <section v-if="liveTab === 'verdict'" class="panel">
                <div class="grade-row">
                  <div class="grade" :class="verdictInfo[1]">
                    {{ probText }}
                  </div>
                  <div class="grade-title">
                    <span class="pill" :class="verdictInfo[1]">{{
                      verdictInfo[0]
                    }}</span>
                  </div>
                </div>

                <!-- 形状标签 + 每个标签的概率 -->
                <div v-if="tags.length" class="tf-strip">
                  <span v-for="t in tags" :key="t.name" class="tag">
                    {{ t.name }}
                    <i v-if="t.probability">{{ t.probability }}%</i>
                  </span>
                </div>

                <!-- 走势预测：最大概率会走成什么样 + 它的概率 -->
                <p v-if="judge?.outlook" class="reasoning">
                  <b>走势 {{ judge.probability }}%</b>{{ judge.outlook }}
                </p>

                <p v-if="judge?.reason" class="reasoning">
                  <b>理由</b>{{ judge.reason }}
                </p>

                <p v-if="judge?.recommendation" class="reasoning">
                  <b>推荐</b>{{ judge.recommendation }}
                </p>

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
                    <span class="k">拉了多少行情</span>
                    <span class="v">
                      {{ result.blocks.length }} 个周期 · 主周期
                      {{ result.primary }}
                    </span>
                  </div>
                  <div class="stat">
                    <span class="k">提示词版本</span>
                    <span class="v">{{ result.meta.rules.hash }}</span>
                  </div>
                  <div class="stat">
                    <span class="k">可用标签</span>
                    <span class="v">{{ result.meta.tagCount }} 个</span>
                  </div>
                </div>
              </section>

              <!-- tab 2（最后一个）：市场与周期 -->
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
                    各周期行情
                    <span class="tag">发给 AI 的就是这些文字</span>
                  </h2>
                  <div class="blocks">
                    <details
                      v-for="b in result.blocks"
                      :key="b.timeframe"
                      class="block"
                      :open="b.primary"
                    >
                      <summary>
                        <b>{{ b.timeframe }}</b>
                        <span v-if="b.primary" class="tag">主周期</span>
                        <span class="dim">
                          {{
                            b.days === null ? '图上那段' : `最近 ${b.days} 天`
                          }}
                          · {{ b.bars }} 根 · {{ b.from }} → {{ b.to }}
                        </span>
                      </summary>
                      <pre class="block-text">{{ b.text }}</pre>
                    </details>
                  </div>
                </section>
              </template>
            </template>
          </div>
        </template>

        <!-- ② 历史分析：只在切到这个 tab 时显示 -->
        <div v-else-if="leftTab === 'history'" class="scroll-body">
          <section class="panel hist-panel">
            <h2>
              {{ symbol }} 的历史分析
              <span class="tag">共 {{ historyTotal }} 条</span>
            </h2>
            <div v-if="historyError" class="dim">
              （读取失败：{{ historyError }}）
            </div>
            <ul v-else ref="histBox" class="hist">
              <li v-for="h in history" :key="h.id">
                <RouterLink :to="`/history?id=${h.id}`">
                  <span class="t">{{ bjShort(h.createdAt) }}</span>
                  <!-- 跟「预测历史」同一套标签体系，这里左右只摆得下两个 -->
                  <span class="tags">
                    <span
                      v-for="t in (h.tags ?? []).slice(0, 2)"
                      :key="t.name"
                      class="tag"
                    >
                      {{ t.name }}
                      <i v-if="t.probability">{{ t.probability }}%</i>
                    </span>
                    <span v-if="!(h.tags ?? []).length" class="dim">—</span>
                  </span>
                  <span
                    class="v"
                    :class="
                      h.verdict ? (VERDICT_TEXT[h.verdict]?.[1] ?? '') : 'dim'
                    "
                  >
                    {{
                      h.verdict
                        ? (VERDICT_TEXT[h.verdict]?.[0] ?? h.verdict)
                        : '—'
                    }}
                  </span>
                </RouterLink>
              </li>
            </ul>
            <p v-if="!historyError && !history.length" class="hint">
              {{ symbol }} 还没有分析记录。
              <template v-if="historyPages > 1">
                （第 {{ historyPage }} 页是空的，翻回第 1 页看看）
              </template>
            </p>

            <!-- 分页：一页放不下就翻 -->
            <div v-if="historyPages > 1" class="pager">
              <button
                class="ghost tiny"
                :disabled="historyPage <= 1"
                @click="historyGo(-1)"
              >
                上一页
              </button>
              <span class="dim">
                第 {{ historyPage }} / {{ historyPages }} 页 · 每页
                {{ historyPageSize }}
              </span>
              <button
                class="ghost tiny"
                :disabled="historyPage >= historyPages"
                @click="historyGo(1)"
              >
                下一页
              </button>
            </div>

            <div v-if="historyTotal > history.length" class="hist-more">
              <RouterLink :to="`/history?symbol=${symbol}`">
                去「历史」页看全部 {{ historyTotal }} 条 →
              </RouterLink>
            </div>
          </section>
        </div>

        <!-- ③ 添加案例：币种/周期/时间段都跟随右侧，AI 提炼后入库 -->
        <div v-else class="scroll-body">
          <CollectForm
            compact
            :symbol="symbol"
            :timeframe="chartTf"
            :start-date="chartFrom"
            :range="chartRange"
            :drawing="rangeDrawing"
            @draw-range="rangeDrawing = $event"
            @clear:select="clearChartRange"
          />
        </div>
      </div>

      <!-- ── 右：K 线（整屏高度） ── -->
      <aside class="col side">
        <KlineChart
          class="chart-side"
          :symbol="symbol"
          :timeframe="chartTf"
          :from="chartFrom"
          :until="chartUntil"
          :selectable="chartSelectable"
          :range="chartRange"
          :drawing="rangeDrawing"
          @update:timeframe="chartTf = $event"
          @update:from="chartFrom = $event"
          @update:drawing="rangeDrawing = $event"
          @select="onPickRange"
          @clear:select="clearChartRange"
          @error="onChartError"
        />
      </aside>
    </div>
  </div>
</template>
