<script setup lang="ts">
/**
 * 案例详情弹窗。
 *
 * 卡片上只放「币种 + 简略描述 + 图」，其余（经验、为什么这样走、标签、
 * 重提炼、删除）都在这里，点卡片弹出来。
 */
import {computed, ref, watch} from 'vue'
import MiniKline from './MiniKline.vue'
import {deleteCase, reeditCase, updateCase, type KnowledgeCase} from '../api'
import {bjTime, moveCls, moveText} from '../format'

const props = defineProps<{
  open: boolean
  data: KnowledgeCase | null
  /** 固定的标签模板 —— 只能从这里面挑，点一下勾上 / 再点一下取消 */
  templates: string[]
  /** 已经用过的标签 */
  allTags: {tag: string; n: number}[]
}>()

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'changed'): void
}>()

/** 一条案例最多打几个标签 —— 跟后端 MAX_TAGS 保持一致 */
const MAX_TAGS = 4

const lesson = ref('')
const note = ref('')
const tags = ref<string[]>([])
const saving = ref(false)
const busy = ref(false)
const error = ref('')
/** 选满 4 个时点了没勾上的那个 chip → 给一句提示 */
const hint = ref('')

/**
 * 每次弹窗打开 / 换了一条案例，就把草稿重置成库里的值。
 *
 * ⚠️ 必须连 `open` 一起看：关掉再点开**同一条**卡片时 `data` 是同一个对象引用，
 * 只监听 data 的话不会重新触发 —— 上一次没保存的改动会留在草稿里（踩过）。
 */
watch(
  () => [props.open, props.data] as const,
  ([isOpen]) => {
    const c = props.data
    if (!isOpen || !c) return
    lesson.value = c.lesson
    note.value = c.note
    tags.value = [...c.tags]
    hint.value = ''
    error.value = ''
  },
  {immediate: true}
)

function close() {
  emit('update:open', false)
}

/**
 * 模板之外的标签（老记录里那些）—— 只显示、能删，加不了新的。
 *
 * ⚠️ **不计入 4 个限额**：老记录普遍带着 4~5 个自造标签，
 * 要是把它们也算上，限额永远是满的 → 所有模板 chip 都是灰的、点不动。
 */
const legacyTags = computed(() => {
  const known = new Set(props.templates)
  return tags.value.filter(t => !known.has(t))
})

/** 已经选上的模板标签（只数这些） */
const pickedCount = computed(
  () => tags.value.filter(t => props.templates.includes(t)).length
)
const atLimit = computed(() => pickedCount.value >= MAX_TAGS)

/** 点一下勾上 / 再点一下取消 */
function toggleTag(t: string) {
  hint.value = ''
  if (tags.value.includes(t)) {
    tags.value = tags.value.filter(x => x !== t)
    return
  }
  if (atLimit.value) {
    hint.value = `最多 ${MAX_TAGS} 个 —— 先点掉一个再选它`
    return
  }
  tags.value = [...tags.value, t]
}

function removeTag(t: string) {
  tags.value = tags.value.filter(x => x !== t)
  hint.value = ''
}

/** 老标签一次清干净 */
function clearLegacy() {
  const known = new Set(props.templates)
  tags.value = tags.value.filter(t => known.has(t))
  hint.value = ''
}

async function save() {
  if (!props.data) return
  saving.value = true
  error.value = ''
  try {
    await updateCase(props.data.id, {
      lesson: lesson.value,
      note: note.value,
      tags: tags.value
    })
    emit('changed')
    close()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function reedit() {
  if (!props.data) return
  if (
    !confirm(
      `用这条案例存下的 K 线重新跑一次 AI 提炼？\n\n` +
        `· 会覆盖现在的走势类型 / 标题 / 经验 / AI 建议标签\n` +
        `· 不会重新拉行情\n` +
        `· 花费约 ¥0.02`
    )
  )
    return
  busy.value = true
  error.value = ''
  try {
    const r = await reeditCase(props.data.id)
    lesson.value = r.lesson
    tags.value = [...r.tags]
    emit('changed')
    close()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!props.data) return
  if (
    !confirm(`删除「${props.data.symbol} ${props.data.timeframe}」这条案例？`)
  )
    return
  busy.value = true
  try {
    await deleteCase(props.data.id)
    emit('changed')
    close()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && data" class="case-mask" @click.self="close">
      <div class="case-modal">
        <!-- 头 -->
        <header class="cm-head">
          <b class="cm-sym">{{ data.symbol }}</b>
          <span class="cm-tf">{{ data.timeframe }}</span>
          <span class="cm-move" :class="moveCls(data.moveType)">
            {{ moveText(data.moveType) }}
          </span>
          <span class="cm-title">{{ data.title }}</span>
          <span class="cm-spacer" />
          <span class="cm-time">{{ bjTime(data.createdAt) }}</span>
          <button class="ghost" title="关闭" @click="close">✕</button>
        </header>

        <!-- 图 -->
        <div class="cm-chart">
          <MiniKline
            :candles="data.candles"
            :show-volume="false"
            :height="220"
          />
          <div class="cm-chart-meta">
            <span class="dim">
              {{ bjTime(data.windowStart) }} → {{ bjTime(data.windowEnd) }} ·
              {{ data.candles.length }} 根
            </span>
            <span v-if="data.stats" class="dim">
              整段 {{ (data.stats.changePct ?? 0) >= 0 ? '+' : ''
              }}{{ data.stats.changePct ?? 0 }}% · 振幅
              {{ data.stats.rangePct ?? 0 }}% · 最大回撤 -{{
                data.stats.maxDrawdownPct ?? 0
              }}%<template v-if="data.stats.volTrend != null">
                · 后半段量 {{ data.stats.volTrend }} 倍</template
              >
            </span>
          </div>
        </div>

        <!-- 经验 + 标签 -->
        <div class="cm-body">
          <label class="cm-field">
            <span>经验条（这句话会喂给 AI 做开单判断）</span>
            <textarea v-model="lesson" rows="3" />
          </label>

          <div class="cm-field">
            <span>
              标签（从模板里挑，已选 {{ pickedCount }} / {{ MAX_TAGS }}）
            </span>
            <div v-if="templates.length" class="cm-tags">
              <button
                v-for="t in templates"
                :key="t"
                type="button"
                class="tag-chip"
                :class="{
                  on: tags.includes(t),
                  dim: !tags.includes(t) && atLimit
                }"
                :title="
                  !tags.includes(t) && atLimit
                    ? `最多 ${MAX_TAGS} 个，先点掉一个`
                    : '点一下勾上，再点一下取消'
                "
                @click="toggleTag(t)"
              >
                {{ tags.includes(t) ? '✓ ' : '+ ' }}{{ t }}
              </button>
            </div>
            <p v-else class="cm-hint">
              还没有标签模板 —— 去「历史知识库」页顶部的「标签模板」加几个，
              加完这里就能点了。
            </p>
            <p v-if="hint" class="cm-hint">{{ hint }}</p>
          </div>

          <div v-if="legacyTags.length" class="cm-field">
            <span>
              老记录里的标签（不在模板里，建议清掉 —— 它们不算在
              {{ MAX_TAGS }} 个限额里）
            </span>
            <div class="cm-tags">
              <span v-for="t in legacyTags" :key="t" class="tag-chip on old">
                {{ t }}
                <em class="x" title="删掉" @click="removeTag(t)">✕</em>
              </span>
              <button
                type="button"
                class="tag-chip clear"
                title="把这个案例身上的老标签一次清掉"
                @click="clearLegacy"
              >
                全清掉
              </button>
            </div>
          </div>

          <label class="cm-field">
            <span>我的备注</span>
            <input v-model="note" />
          </label>

          <details v-if="data.why" class="cm-why">
            <summary>为什么会这样走</summary>
            <p>{{ data.why }}</p>
            <div class="feat">
              <span v-if="data.features.structure">
                结构：{{ data.features.structure }}
              </span>
              <span v-if="data.features.volume">
                量能：{{ data.features.volume }}
              </span>
              <span v-if="data.features.rhythm">
                节奏：{{ data.features.rhythm }}
              </span>
              <template v-if="!data.why">
                <span v-if="data.features.pre"
                  >拉升前：{{ data.features.pre }}</span
                >
                <span v-if="data.features.rally"
                  >拉升：{{ data.features.rally }}</span
                >
                <span v-if="data.features.post"
                  >拉升后：{{ data.features.post }}</span
                >
              </template>
            </div>
          </details>

          <div v-if="error" class="error">❌ {{ error }}</div>
        </div>

        <!-- 底部 -->
        <footer class="cm-actions">
          <button class="ghost" :disabled="busy" @click="reedit">重提炼</button>
          <button class="danger" :disabled="busy" @click="remove">删除</button>
          <span class="cm-spacer" />
          <button class="ghost" :disabled="saving" @click="close">取消</button>
          <button :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.case-mask {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(3px);
}

.case-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(720px, 100%);
  max-height: min(88vh, 880px);
  padding: 14px 16px 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
  overflow-y: auto;
}

/*
 * 手机上整屏铺满。
 * 原来两侧各留 24px（`.case-mask` 的 padding），390px 屏上白白少 48px 宽，
 * 而弹窗里全是长文本 + 标签 —— 窄屏直接当整页用更好。
 */
@media (max-width: 640px) {
  .case-mask {
    padding: 0;
  }
  .case-modal {
    width: 100%;
    height: 100%;
    max-height: 100%;
    padding: 12px 12px 10px;
    border: 0;
    border-radius: 0;
  }
}

.cm-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.cm-sym {
  font-size: 15px;
  letter-spacing: 0.4px;
}

.cm-tf {
  color: var(--muted);
}

.cm-move {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  white-space: nowrap;
}
.cm-move.up {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 55%, transparent);
}
.cm-move.down {
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 55%, transparent);
}
.cm-move.range {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 55%, transparent);
}
.cm-move.none {
  color: var(--muted);
}

.cm-title {
  color: var(--muted);
  font-size: 12px;
}

.cm-spacer {
  flex: 1 1 auto;
}

.cm-time {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

.cm-chart-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 5px;
  font-size: 11px;
}

.cm-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cm-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cm-field > span {
  font-size: 11px;
  color: var(--muted);
}

.cm-field textarea,
.cm-field input {
  font-size: 12.5px;
  padding: 7px 9px;
  resize: vertical;
}

.cm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  font: inherit;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.tag-chip:hover {
  border-color: var(--blue);
  color: var(--text);
}

.tag-chip.on {
  border-color: var(--blue);
  color: var(--blue);
  background: color-mix(in srgb, var(--blue) 12%, transparent);
}

.tag-chip em {
  font-style: normal;
  font-size: 10px;
  opacity: 0.65;
  cursor: pointer;
}

.tag-chip em:hover {
  opacity: 1;
}

/* 老记录里的自造标签：暗一点，提示该清掉 */
.tag-chip.old {
  border-color: var(--border);
  border-style: dashed;
  color: var(--muted);
  background: transparent;
}

.tag-chip:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 选满了：没勾上的变灰（但还能点，点了会告诉我要先取消一个） */
.tag-chip.dim {
  opacity: 0.45;
}

/* 「全清掉」：老标签那一组右边的动作 */
.tag-chip.clear {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 55%, transparent);
  border-style: solid;
}

.tag-chip.clear:hover {
  color: #06121f;
  background: var(--warn);
  border-color: var(--warn);
}

.cm-hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--warn);
}

.cm-why {
  font-size: 12px;
  color: var(--muted);
}

.cm-why summary {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--blue);
}

.cm-why p {
  margin: 7px 0;
  line-height: 1.7;
}

.cm-why .feat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
  line-height: 1.65;
}

.cm-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.cm-actions button {
  padding: 6px 16px;
}
</style>
