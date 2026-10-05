<script setup lang="ts">
/**
 * 知识库卡片面板。
 *
 * 卡片只放「币种 + 简略描述 + 那段行情的图」；经验、为什么这样走、
 * 标签编辑、重提炼、删除都在点开后的详情弹窗里。
 *
 * AI 只客观说这是拉升 / 下跌 / 横盘，**不套我的 A/B/C 档**；
 * 也不再分「该做 / 不该做」，一个案例就是「一种形状 + 一句经验」。
 */
import {onMounted, ref, watch} from 'vue'
import MiniKline from './MiniKline.vue'
import SegTabs from './SegTabs.vue'
import CaseDetailModal from './CaseDetailModal.vue'
import {fetchTags, listCases, type KnowledgeCase} from '../api'
import {refreshConfig} from '../store'
import {moveCls, moveText} from '../format'

const props = defineProps<{compact?: boolean}>()

const MOVE_OPTIONS = [
  {value: 'all' as const, label: '全部走势'},
  {value: 'up' as const, label: '↑ 拉升'},
  {value: 'down' as const, label: '↓ 下跌'},
  {value: 'range' as const, label: '→ 横盘'}
]

const moveType = ref<'all' | 'up' | 'down' | 'range'>('all')
const activeTag = ref('')
const keyword = ref('')
const symbolQ = ref('')

const cases = ref<KnowledgeCase[]>([])
const allTags = ref<{tag: string; n: number}[]>([])
/** 我维护的标签模板（弹窗里点这些挑）—— 只取名字用 */
const templates = ref<string[]>([])
const loading = ref(false)
const error = ref('')

let timer: number | undefined
function debounceLoad() {
  clearTimeout(timer)
  timer = window.setTimeout(load, 350)
}

async function load() {
  loading.value = true
  try {
    const d = await listCases({
      moveType: moveType.value,
      tag: activeTag.value,
      q: keyword.value.trim(),
      symbol: symbolQ.value.trim(),
      candles: true
    })
    cases.value = d.cases
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** 标签用全量拉（不受当前筛选影响），否则筛完就只剩一个标签了 */
async function loadTags() {
  try {
    const d = await fetchTags()
    allTags.value = d.tags
    templates.value = d.templates.map(t => t.name)
  } catch {
    /* 标签拉不到不影响主流程 */
  }
}

watch([moveType, activeTag], load)
watch([keyword, symbolQ], debounceLoad)

function toggleTag(tag: string) {
  activeTag.value = activeTag.value === tag ? '' : tag
}

/* ---------------- 就地改经验 / 改标签 ---------------- */

const editing = ref(0)
const draftLesson = ref('')
const draftNote = ref('')
const saving = ref(false)

/** 点开哪一条看详情（0 = 没开） */
const detail = ref<KnowledgeCase | null>(null)
const detailOpen = ref(false)

function openDetail(c: KnowledgeCase) {
  detail.value = c
  detailOpen.value = true
}

/** 弹窗里改完 / 删完 → 列表和标签都刷新一下 */
async function onChanged() {
  await load()
  await loadTags()
  await refreshConfig()
}

onMounted(() => {
  void load()
  void loadTags()
})
defineExpose({load, loadTags})
</script>

<template>
  <div class="kb-panel" :class="{compact: !!props.compact}">
    <!-- 筛选 -->
    <div class="kb-filter">
      <SegTabs v-model="moveType" :options="MOVE_OPTIONS" />
      <div class="kb-search">
        <input
          v-model="keyword"
          placeholder="搜经验 / 标签，如 放量突破"
          autocomplete="off"
        />
        <input
          v-model="symbolQ"
          class="kb-sym"
          placeholder="币种"
          autocomplete="off"
        />
      </div>
      <span class="kb-count">共 {{ cases.length }} 条</span>
    </div>

    <!-- 标签筛选：点一下只看这一类 -->
    <div v-if="allTags.length" class="kb-tagbar">
      <button
        v-for="t in allTags"
        :key="t.tag"
        type="button"
        class="tag-chip"
        :class="{on: activeTag === t.tag}"
        @click="toggleTag(t.tag)"
      >
        {{ t.tag }}<em>{{ t.n }}</em>
      </button>
      <button
        v-if="activeTag"
        type="button"
        class="tag-chip clear"
        @click="activeTag = ''"
      >
        清除 ✕
      </button>
    </div>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-else-if="loading && !cases.length" class="empty">读取中…</div>

    <div v-else-if="!cases.length" class="empty">
      没有匹配的案例。
      <template
        v-if="
          moveType === 'all' && !activeTag && !keyword.trim() && !symbolQ.trim()
        "
      >
        去「历史知识库」收录一条试试 —— 在 K 线上画一段就行。
      </template>
    </div>

    <div v-else class="kb-grid">
      <article
        v-for="c in cases"
        :key="c.id"
        class="kb-card"
        :class="moveCls(c.moveType)"
        :title="'点开看经验、为什么这样走、打标签'"
        @click="openDetail(c)"
      >
        <header class="kb-head">
          <span class="kb-sym-name">{{ c.symbol }}</span>
          <span class="kb-tf">{{ c.timeframe }}</span>
          <span class="kb-move" :class="moveCls(c.moveType)">
            {{ moveText(c.moveType) }}
          </span>
        </header>

        <!-- 简略描述：最多两行，看全在弹窗里 -->
        <p class="kb-desc">
          {{ c.lesson || '（还没写经验 —— 点开补一句）' }}
        </p>

        <!-- 那段行情（不画成交量，也不标拉伸区间） -->
        <div class="kb-thumb">
          <MiniKline
            :candles="c.candles"
            :show-volume="false"
            :height="props.compact ? 78 : 92"
          />
        </div>

        <div class="kb-tags">
          <button
            v-for="t in c.tags.slice(0, 3)"
            :key="t"
            type="button"
            class="tag-chip small"
            :class="{on: activeTag === t}"
            @click.stop="toggleTag(t)"
          >
            {{ t }}
          </button>
          <span v-if="c.tags.length > 3" class="tag-more">
            +{{ c.tags.length - 3 }}
          </span>
          <span v-else-if="!c.tags.length" class="tag-more">还没打标签</span>
        </div>
      </article>
    </div>

    <CaseDetailModal
      v-model:open="detailOpen"
      :data="detail"
      :templates="templates"
      :all-tags="allTags"
      @changed="onChanged"
    />
  </div>
</template>

<style scoped>
.kb-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

/* ---------------- 筛选 ---------------- */

.kb-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.kb-search {
  display: flex;
  gap: 6px;
  flex: 1 1 220px;
  min-width: 0;
}

.kb-search input {
  min-width: 0;
  flex: 1 1 auto;
  padding: 5px 9px;
  font-size: 12px;
}

.kb-search .kb-sym {
  flex: 0 0 84px;
}

.kb-count {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

/* ---------------- 卡片：网格铺满，一屏 4 列 ---------------- */

.kb-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  align-content: start;
}

@media (max-width: 1280px) {
  .kb-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 960px) {
  .kb-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 620px) {
  .kb-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.kb-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 9px 10px 8px;
  border: 1px solid var(--border);
  border-top: 3px solid var(--muted);
  border-radius: 9px;
  background: var(--panel-2);
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    transform 0.12s ease;
}

/* 悬停：触屏不应用（全站约定，见 style.css 里 `.seg` 上面那段说明） */
@media (hover: hover) {
  .kb-card:hover {
    border-color: var(--blue);
    transform: translateY(-1px);
  }
}

/* 顶边颜色跟走势：拉升绿 / 下跌红 / 横盘黄 */
.kb-card.up {
  border-top-color: var(--ok);
}
.kb-card.down {
  border-top-color: var(--bad);
}
.kb-card.range {
  border-top-color: var(--warn);
}

/* 简略描述：最多两行 */
.kb-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}

.kb-thumb {
  margin-top: auto;
}

.tag-more {
  font-size: 10.5px;
  color: var(--muted);
  align-self: center;
}

.kb-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.kb-sym-name {
  font-weight: 700;
  letter-spacing: 0.3px;
}

.kb-tf {
  color: var(--muted);
}

.kb-spacer {
  flex: 1 1 auto;
}

.kb-time {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

.kb-lesson {
  margin: 7px 0 4px;
  font-size: 13px;
  line-height: 1.5;
  font-weight: 600;
}

.kb-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--muted);
}

.kb-note {
  opacity: 0.9;
}

.kb-move {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  white-space: nowrap;
}

.kb-move.up {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 55%, transparent);
}
.kb-move.down {
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 55%, transparent);
}
.kb-move.range {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 55%, transparent);
}
.kb-move.none {
  color: var(--muted);
}

/* ---------------- 标签 ---------------- */

.kb-tagbar,
.tag-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.kb-tagbar {
  padding-bottom: 2px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  line-height: 1.5;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

/* 悬停：触屏不应用 */
@media (hover: hover) {
  .tag-chip:hover:not(:disabled) {
    border-color: var(--blue);
    color: var(--text);
  }
}

.tag-chip.on {
  border-color: var(--blue);
  color: var(--blue);
  background: color-mix(in srgb, var(--blue) 12%, transparent);
}

.tag-chip em {
  font-style: normal;
  font-size: 10px;
  opacity: 0.7;
}

.tag-chip.small {
  padding: 1px 7px;
  font-size: 10.5px;
}

.tag-chip .x {
  cursor: pointer;
  opacity: 0.6;
}

/* 悬停：触屏不应用 */
@media (hover: hover) {
  .tag-chip .x:hover {
    opacity: 1;
  }
}

.tag-chip.clear {
  color: var(--muted);
}

.kb-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 5px 0 3px;
}

.tag-input {
  width: 120px;
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 999px;
}

/* ---------------- 为什么这样走 ---------------- */

.kb-why {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--muted);
}

.kb-why .k {
  display: block;
  font-size: 10.5px;
  opacity: 0.8;
}

.kb-why p {
  margin: 2px 0 0;
  line-height: 1.6;
}

/* ---------------- 图表 ---------------- */

.kb-chart {
  margin-top: 8px;
}

.kb-chart-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 6px;
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--muted);
}

.kb-chart-range {
  white-space: nowrap;
}

/* ---------------- 底部操作 ---------------- */

.kb-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
}

.kb-actions button {
  font-size: 11px;
}

/* ---------------- 编辑 ---------------- */

.kb-edit {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 8px;
}

.kb-edit-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.kb-edit-field > span {
  font-size: 11px;
  color: var(--muted);
}

.kb-edit-field textarea,
.kb-edit-field input {
  font-size: 12px;
  padding: 6px 8px;
  resize: vertical;
}

.kb-edit-actions {
  display: flex;
  gap: 6px;
}

.kb-edit-actions .btn-block {
  flex: 1 1 auto;
  padding: 6px 10px;
}

/* 窄栏（开单分析左栏）里收一收 */
.kb-panel.compact .kb-time {
  display: none;
}
.kb-panel.compact .kb-filter {
  gap: 6px;
}

/*
 * 手机覆盖必须写在**最后** —— 同特异性下靠「后写的赢」，
 * 放前面会被上面那些基样式（.kb-card / .kb-desc 等）盖掉。
 */
@media (max-width: 640px) {
  /* 搜索 + 币种各占整行，别挤成两个小框 */
  .kb-search {
    flex: 1 1 100%;
  }
  .kb-search .kb-sym {
    flex: 0 0 100px;
  }
  .kb-count {
    margin-left: auto;
  }
  /* 一列到底时卡片会很长，内边距收一点，一屏能多看一张 */
  .kb-card {
    padding: 8px 10px 7px;
  }
  /* 手机上一列铺满，描述多给一行也无所谓 */
  .kb-desc {
    font-size: 12.5px;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
}
</style>
