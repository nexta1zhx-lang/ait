<script setup lang="ts">
import {computed, onMounted, ref} from 'vue'
import SegTabs from '../comps/SegTabs.vue'
import {
  collectCase,
  deleteCase,
  listCases,
  type CollectResult,
  type KnowledgeBrief
} from '../api'
import {contracts, refreshConfig} from '../store'
import {bjTime} from '../format'

/* ---------------- 收录表单 ---------------- */

const symbol = ref('')
const timeframe = ref('4h')
const label = ref<'do' | 'dont'>('do')
const note = ref('')
const from = ref('')
const to = ref('')
const advanced = ref(false)

const collecting = ref(false)
const error = ref('')
const collected = ref<CollectResult | null>(null)

const TIMEFRAMES = [
  {value: '5m', label: '5 分钟'},
  {value: '15m', label: '15 分钟'},
  {value: '1h', label: '1 小时'},
  {value: '4h', label: '4 小时'},
  {value: '1d', label: '日线'}
]

const LABELS = [
  {value: 'do' as const, label: '✅ 我该做的'},
  {value: 'dont' as const, label: '❌ 我不该做的'}
]

const symbolList = computed(() => contracts.value.map(c => c.base))
const suggestions = computed(() => {
  const q = symbol.value.trim().toUpperCase()
  if (!q) return []
  return symbolList.value.filter(b => b.includes(q)).slice(0, 8)
})

async function collect() {
  const s = symbol.value.trim().toUpperCase()
  if (!s) {
    error.value = '请填写币种，例如 MAGMA'
    return
  }
  if ((from.value && !to.value) || (!from.value && to.value)) {
    error.value = '时间段要同时填起止'
    return
  }

  collecting.value = true
  error.value = ''
  collected.value = null
  try {
    const body: Record<string, unknown> = {
      symbol: s,
      timeframe: timeframe.value,
      label: label.value,
      note: note.value
    }
    if (from.value && to.value) {
      body.from = new Date(from.value + 'T00:00:00+08:00').getTime()
      body.to = new Date(to.value + 'T23:59:59+08:00').getTime()
    }
    collected.value = await collectCase(body)
    note.value = ''
    await load()
    await refreshConfig()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    collecting.value = false
  }
}

/* ---------------- 列表 ---------------- */

const filter = ref<'all' | 'do' | 'dont'>('all')
const cases = ref<KnowledgeBrief[]>([])
const total = ref(0)
const listError = ref('')

const FILTERS = [
  {value: 'all' as const, label: '全部'},
  {value: 'do' as const, label: '该做的'},
  {value: 'dont' as const, label: '不该做的'}
]

async function load() {
  try {
    const d = await listCases(filter.value)
    cases.value = d.cases
    total.value = d.total
    listError.value = ''
  } catch (e) {
    listError.value = (e as Error).message
  }
}

async function remove(id: number) {
  if (!confirm('删除这条案例？')) return
  try {
    await deleteCase(id)
    await load()
    await refreshConfig()
  } catch (e) {
    listError.value = (e as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div class="col">
    <!-- 收录 -->
    <section class="panel">
      <h2>收录一个案例 <span class="tag">AI 提炼</span></h2>
      <p class="hint" style="margin-bottom: 12px">
        给我一个币种，我会自动去拉行情、找出<b>主拉升段</b>，只保留「拉升前 +
        拉升后」两段，再让 AI 提炼成一条经验。
      </p>

      <div class="fields">
        <label class="field">
          <span>币种</span>
          <input
            v-model="symbol"
            list="kb-symbols"
            placeholder="MAGMA"
            autocomplete="off"
            @keydown.enter="collect"
          />
          <datalist id="kb-symbols">
            <option v-for="b in symbolList" :key="b" :value="b" />
          </datalist>
          <span
            v-if="
              suggestions.length && !symbolList.includes(symbol.toUpperCase())
            "
            class="hint"
          >
            像这些：{{ suggestions.join(' · ') }}
          </span>
        </label>

        <div class="field-row">
          <label class="field">
            <span>周期</span>
            <select v-model="timeframe">
              <option v-for="t in TIMEFRAMES" :key="t.value" :value="t.value">
                {{ t.label }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>这是…</span>
            <select v-model="label">
              <option v-for="l in LABELS" :key="l.value" :value="l.value">
                {{ l.label }}
              </option>
            </select>
          </label>
        </div>

        <label class="field">
          <span>我的备注（可选）</span>
          <input
            v-model="note"
            placeholder="回调不破，右侧进的"
            @keydown.enter="collect"
          />
        </label>

        <details
          class="adv"
          :open="advanced"
          @toggle="advanced = ($event.target as HTMLDetailsElement).open"
        >
          <summary>只关心某一段时间？（可选）</summary>
          <div class="field-row" style="margin-top: 8px">
            <label class="field">
              <span>从</span>
              <input v-model="from" type="date" />
            </label>
            <label class="field">
              <span>到</span>
              <input v-model="to" type="date" />
            </label>
          </div>
        </details>
      </div>

      <button class="btn-block" :disabled="collecting" @click="collect">
        {{ collecting ? '拉行情 + 找拉升段 + AI 提炼中…' : '收录并提炼经验' }}
      </button>

      <div v-if="error" class="error" style="margin-top: 12px">
        ❌ {{ error }}
      </div>
    </section>

    <!-- 收录结果 -->
    <template v-if="collected">
      <section class="panel">
        <div class="grade-row">
          <div class="grade" :class="collected.grade.toLowerCase()">
            {{ collected.grade }} 档
          </div>
          <div class="grade-title">
            <span class="pill" :class="collected.label === 'do' ? 'go' : 'no'">
              {{ collected.label === 'do' ? '✅ 我该做的' : '❌ 我不该做的' }}
            </span>
            <span class="conf"
              >{{ collected.symbol }} · {{ collected.timeframe }}</span
            >
          </div>
        </div>

        <div style="margin-top: 10px">
          <div class="heat-row">
            <span class="k">案例</span
            ><span class="v">{{ collected.title }}</span>
          </div>
          <div class="heat-row">
            <span class="k">拉升</span>
            <span class="v ok">
              {{ collected.rallyMeta.changePct >= 0 ? '+' : ''
              }}{{ collected.rallyMeta.changePct }}%　{{
                collected.rallyMeta.bars
              }}
              根　力度 {{ collected.rallyMeta.atrMultiple }}×ATR<template
                v-if="collected.rallyMeta.volMultiple !== null"
              >
                　量能 {{ collected.rallyMeta.volMultiple }} 倍</template
              >
            </span>
          </div>
          <div class="heat-row">
            <span class="k">入库窗口</span>
            <span class="v">
              {{ bjTime(collected.window.start) }} →
              {{ bjTime(collected.window.end) }}　共
              {{ collected.window.bars }} 根
            </span>
          </div>
          <div class="heat-row">
            <span class="k">两段</span>
            <span class="v">
              前段 {{ collected.rallyFrom }} 根 · 拉升
              {{ collected.rallyTo - collected.rallyFrom + 1 }} 根 · 后段
              {{ collected.window.bars - collected.rallyTo - 1 }} 根
            </span>
          </div>
          <div class="heat-row">
            <span class="k">本次花费</span>
            <span class="v">
              {{
                collected.meta.mock
                  ? '模拟提炼，不计费'
                  : collected.meta.usage.text
              }}
            </span>
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>AI 提炼出来的样子</h2>
        <div>
          <div v-if="collected.features.pre" class="heat-row">
            <span class="k">拉升前</span
            ><span class="v">{{ collected.features.pre }}</span>
          </div>
          <div v-if="collected.features.rally" class="heat-row">
            <span class="k">拉升</span
            ><span class="v">{{ collected.features.rally }}</span>
          </div>
          <div v-if="collected.features.post" class="heat-row">
            <span class="k">拉升后</span
            ><span class="v">{{ collected.features.post }}</span>
          </div>
        </div>
        <p v-if="collected.whatWorked" class="reasoning">
          {{ collected.whatWorked }}
        </p>
      </section>

      <section class="panel coach-panel">
        <h2>★ 经验条</h2>
        <p class="coach-line">{{ collected.lesson || '（空）' }}</p>
        <p class="hint" style="margin-top: 8px">
          这条经验已进库，下次分析时会喂给 AI。
        </p>
        <div
          v-if="collected.meta.warning"
          class="notice"
          style="margin-top: 10px"
        >
          {{ collected.meta.warning }}
        </div>
      </section>
    </template>

    <!-- 列表 -->
    <section class="panel">
      <h2>
        我的知识库
        <span class="tag">{{ total }} 条</span>
      </h2>

      <SegTabs
        v-model="filter"
        :options="FILTERS"
        style="margin-bottom: 12px"
      />

      <div v-if="listError" class="error">{{ listError }}</div>

      <div v-else-if="!cases.length" class="empty">
        还没有案例。上面收录一个试试 —— 给个币种就行。
      </div>

      <div v-else class="kb-list">
        <div v-for="c in cases" :key="c.id" class="kb-item" :class="c.label">
          <div class="kb-head">
            <span class="kb-mark">{{ c.label === 'do' ? '✅' : '❌' }}</span>
            <span class="kb-title">
              {{ c.symbol }} {{ c.timeframe }}
              <template v-if="c.grade"> · {{ c.grade }}档</template>
            </span>
            <button
              type="button"
              class="danger"
              title="删除"
              @click="remove(c.id)"
            >
              ✕
            </button>
          </div>
          <div class="kb-lesson">{{ c.lesson || '（这条还没写经验）' }}</div>
          <div class="kb-meta">
            {{ c.title
            }}<template v-if="c.note"> · 备注：{{ c.note }}</template>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.col {
  max-width: 720px;
}
</style>
