<script setup lang="ts">
/**
 * 预测历史 —— 每次分析留下的**那一句话**。
 *
 * 2026-10-11 重置：分析只输出一句话（能不能做 / 进场 / 止损），
 * 所以存档也只剩它：**币种 · 时间 · 那一句话**。
 * 筛选就两个：币种 + 时间段，别的都不需要。
 *
 * ★ 2026-10-11 晚：用户把输出格式放开之后，模型改写「小标题 + 分点」的长文，
 *   存进来的也是一整篇 ⇒ 这一列塞不下。所以这里只取**第一句**（`markdownToPlain`），
 *   想看全文去点开那条（原文照旧整段存在库里）。
 *
 * ★ 2026-10-12：用户把「实时分析」和「预测历史」两格合并成「预测结果」，
 *   于是这个列表**挂在分析那一格的下面**（`AnalyzeView` 的左栏，`embedded` 模式）。
 *   挂上去之后它不能再自己撑高 / 自己滚 —— 外层 `.scroll-body` 已经在滚了，
 *   两层滚动条在手机上最难用（`embedded` 那个 prop 就是干这个的）。
 */
import {computed, onMounted, ref} from 'vue'
import {
  deletePrediction,
  fetchPredictions,
  type PredictionRow
} from '../api'
import {ago, bjTime, fmt} from '../format'
import {askConfirm} from '../confirm'
import {markdownToPlain} from '../markdown'

/**
 * `embedded`：嵌在**自己会滚**的父容器里（合并后的「预测结果」那一格）。
 * 这时列表不再 `flex: 1 1 auto` 撑满、也不再自己 `overflow-y: auto`。
 */
const props = withDefaults(defineProps<{embedded?: boolean}>(), {embedded: false})

/** 列表里那一行：抹成一句纯文字，太长就截断 */
function summary(line: string | null | undefined): string {
  if (!line || !line.trim()) return '（这条没留下结论）'
  return markdownToPlain(line, 88)
}

const PAGE = 50

/** 时间段选项 —— 「全部」给个足够大的天数，后端按 `now() - N days` 拦 */
const RANGES = [
  {value: 7, label: '7 天'},
  {value: 30, label: '30 天'},
  {value: 90, label: '90 天'},
  {value: 3650, label: '全部'}
]

const days = ref(30)
const symbolInput = ref('')
/** 真正查下去的那个币种（输入框敲回车 / 点「筛选」才生效） */
const symbol = ref('')

const rows = ref<PredictionRow[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')

/** 筛过东西没有 —— 决定空状态那句话怎么说 */
const filtered = computed(
  () => Boolean(symbol.value) || days.value !== RANGES[1].value
)

async function load(more = false) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const offset = more ? rows.value.length : 0
    const page = await fetchPredictions({
      days: days.value,
      symbol: symbol.value,
      limit: PAGE,
      offset
    })
    rows.value = more ? [...rows.value, ...page.rows] : page.rows
    total.value = page.total
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(() => void load())

function apply() {
  symbol.value = symbolInput.value.trim().toUpperCase()
  void load()
}

async function setDays(v: number) {
  days.value = v
  await load()
}

async function remove(row: PredictionRow) {
  const yes = await askConfirm({
    title: `删掉 ${row.symbol} 这条记录？`,
    body: '删了就不在预测历史里了。',
    okText: '删掉',
    danger: true
  })
  if (!yes) return
  try {
    await deletePrediction(row.id)
    rows.value = rows.value.filter(r => r.id !== row.id)
    total.value = Math.max(0, total.value - 1)
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>

<template>
  <section class="panel hist-panel warm-skin" :class="{embedded: props.embedded}">
    <h2>
      预测历史
      <span class="tag">共 {{ total }} 条</span>
    </h2>

    <!-- 筛选：币种 + 时间段 -->
    <div class="filter-row">
      <input
        v-model="symbolInput"
        class="sym"
        type="search"
        placeholder="币种（空 = 全部）"
        spellcheck="false"
        @keyup.enter="apply"
      />
      <button class="ghost" :disabled="loading" @click="apply">筛选</button>
      <div class="ranges">
        <button
          v-for="r in RANGES"
          :key="r.value"
          type="button"
          class="range"
          :class="{on: days === r.value}"
          @click="setDays(r.value)"
        >
          {{ r.label }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error">{{ error }}</div>
    <p v-else-if="loading && !rows.length" class="dim">读取中…</p>
    <p v-else-if="!rows.length" class="dim">
      {{ filtered ? '这个条件下没有记录。' : '还没有记录。跑一次分析，结论就自动存这儿了。' }}
    </p>

    <div v-else class="pred-list">
      <article v-for="r in rows" :key="r.id" class="row">
        <div class="meta">
          <b class="sym-name">{{ r.symbol }}</b>
          <span class="time" :title="bjTime(r.createdAt)">{{
            ago(r.createdAt)
          }}</span>
          <span v-if="r.price !== null" class="dim px">
            当时 {{ fmt(r.price) }}
          </span>
          <button
            type="button"
            class="ghost danger del"
            title="删掉这条"
            @click="remove(r)"
          >
            ✕
          </button>
        </div>
        <p class="line">{{ summary(r.line) }}</p>
      </article>

      <div v-if="rows.length < total" class="hist-more">
        <a role="button" @click="load(true)">
          {{ loading ? '读取中…' : `看更早的（还有 ${total - rows.length} 条）` }}
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pred-list {
  /* 左栏宽度就那么大，一句话常常要换行 —— 行距松一点更好扫 */
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 宽屏左栏是定高的：列表自己滚，筛选栏 / 标题钉在上面 */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* 嵌在会滚的父容器里（合并后的「预测结果」）：高度交给内容，自己不滚 */
.hist-panel.embedded {
  flex: 0 0 auto;
}
.hist-panel.embedded .pred-list {
  flex: 0 0 auto;
  overflow: visible;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.filter-row .sym {
  width: 150px;
}

.ranges {
  display: flex;
  gap: 4px;
}

.range {
  padding: 3px 9px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--dim);
  cursor: pointer;
}

.range.on {
  border-color: var(--blue);
  color: var(--blue);
}

.row {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
}

.meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 4px;
}

.meta .sym-name {
  font-size: 13px;
}

.meta .px {
  font-variant-numeric: tabular-nums;
}

.meta .del {
  margin-left: auto;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1.4;
}

.line {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
