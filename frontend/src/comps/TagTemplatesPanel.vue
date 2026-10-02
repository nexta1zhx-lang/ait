<script setup lang="ts">
/**
 * 标签模板编辑器。
 *
 * 案例的标签只能从这份清单里挑（AI 提炼时清单直接写进 prompt，
 * 返回后还会按它再过滤一遍），所以清单得由我自己维护：
 * 加一个、改名、删、↑↓ 调顺序。
 *
 * 挂在 `/knowledge` 页面上（默认收起，点开才编辑）。
 */
import {computed, onMounted, ref} from 'vue'
import {
  addTagTemplate,
  deleteTagTemplate,
  fetchTags,
  moveTagTemplate,
  renameTagTemplate,
  type TagTemplate
} from '../api'

const emit = defineEmits<{(e: 'changed'): void}>()

const list = ref<TagTemplate[]>([])
const legacy = ref<string[]>([])
const open = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')

/** 正在改名的那条 */
const editId = ref(0)
const editName = ref('')
const newName = ref('')

async function load() {
  loading.value = true
  try {
    const d = await fetchTags()
    list.value = d.templates
    legacy.value = d.legacy
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 改完通知外面（弹窗里的 chip 要跟着换） */
async function after(keepOpenMessage: string) {
  await load()
  emit('changed')
  notice.value = keepOpenMessage
  window.setTimeout(() => (notice.value = ''), 2200)
}

async function add() {
  const v = newName.value.trim()
  if (!v || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await addTagTemplate(v)
    newName.value = ''
    await after(`已加上「${v}」`)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function startEdit(t: TagTemplate) {
  editId.value = t.id
  editName.value = t.name
}

function cancelEdit() {
  editId.value = 0
  editName.value = ''
}

async function saveEdit() {
  const v = editName.value.trim()
  if (!v || !editId.value) return cancelEdit()
  busy.value = true
  error.value = ''
  try {
    await renameTagTemplate(editId.value, v)
    cancelEdit()
    await after(`改好了`)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function remove(t: TagTemplate) {
  if (t.n > 0) {
    if (
      !confirm(
        `「${t.name}」还有 ${t.n} 条案例在用。\n\n` +
          `删掉模板不影响那些案例 —— 它们身上的标签会变成「模板外」，\n` +
          `你可以点开卡片一个个清掉。\n\n确定要删吗？`
      )
    )
      return
  } else if (!confirm(`删掉模板「${t.name}」？`)) {
    return
  }
  busy.value = true
  try {
    await deleteTagTemplate(t.id)
    await after('已删掉')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function move(t: TagTemplate, dir: 'up' | 'down') {
  if (busy.value) return
  busy.value = true
  try {
    await moveTagTemplate(t.id, dir)
    await load()
    emit('changed')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

const summary = computed(
  () =>
    `标签模板 ${list.value.length} 个` +
    (list.value.length ? ` · ${list.value.map(t => t.name).join(' / ')}` : '')
)
</script>

<template>
  <div class="tt-panel">
    <button type="button" class="tt-head" @click="open = !open">
      <span class="t">{{ open ? '▾' : '▸' }} 标签模板</span>
      <span class="dim">{{ summary }}</span>
      <span class="dim">{{ open ? '收起' : '点开改' }}</span>
    </button>

    <div v-if="open" class="tt-body">
      <p class="hint">
        案例标签<b>只能从这份清单里挑</b>。AI 提炼时会把清单原样写进 prompt，
        返回后还会按它再过滤一遍 —— 它自己造的词一律丢掉。
        改完立刻生效，不用重启。
        <br />
        清单<b>完全归我管</b>：代码里没有任何写死的默认模板，
        <b>全部都可以删</b>，删光了 AI 就不会再给标签（也不会自己蹦回默认值）。
      </p>

      <ol class="tt-list">
        <li v-for="(t, i) in list" :key="t.id" class="tt-item">
          <template v-if="editId === t.id">
            <input
              v-model="editName"
              class="tt-input"
              maxlength="12"
              @keydown.enter="saveEdit"
              @keydown.esc="cancelEdit"
            />
            <button type="button" class="ghost tiny" @click="saveEdit">
              保存
            </button>
            <button type="button" class="ghost tiny" @click="cancelEdit">
              取消
            </button>
          </template>
          <template v-else>
            <span class="tt-name">{{ t.name }}</span>
            <span v-if="t.n" class="tt-count">{{ t.n }} 条在用</span>
            <span class="tt-ops">
              <button
                type="button"
                class="ghost tiny"
                title="改名"
                @click="startEdit(t)"
              >
                改名
              </button>
              <button
                type="button"
                class="ghost tiny"
                :disabled="i === 0"
                title="往上挪"
                @click="move(t, 'up')"
              >
                ↑
              </button>
              <button
                type="button"
                class="ghost tiny"
                :disabled="i === list.length - 1"
                title="往下挪"
                @click="move(t, 'down')"
              >
                ↓
              </button>
              <button
                type="button"
                class="ghost tiny"
                title="删掉这个模板"
                @click="remove(t)"
              >
                删
              </button>
            </span>
          </template>
        </li>
        <li v-if="!list.length && !loading" class="tt-item empty">
          清单是空的 —— 在下面加一个，或者把要用的标签一个个加回来。
          空着也行：AI 提炼时就不打标签了。
        </li>
      </ol>

      <div class="tt-add">
        <input
          v-model="newName"
          class="tt-input"
          maxlength="12"
          placeholder="+ 加一个模板，回车（2~6 个字最好用）"
          @keydown.enter="add"
        />
        <button type="button" class="ghost tiny" :disabled="busy" @click="add">
          加上去
        </button>
      </div>

      <p v-if="legacy.length" class="tt-legacy">
        老记录里还有 {{ legacy.length }} 个不在模板里的标签：{{
          legacy.join('、')
        }}
        —— 点开对应卡片可以清掉。
      </p>

      <p v-if="notice" class="tt-notice">{{ notice }}</p>
      <p v-if="error" class="error">❌ {{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.tt-panel {
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel-2);
}

.tt-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.tt-head:hover {
  background: rgba(255, 255, 255, 0.03);
}

.tt-head .t {
  font-weight: 600;
  white-space: nowrap;
}

.tt-head .dim {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tt-head .dim:last-child {
  margin-left: auto;
  flex: 0 0 auto;
}

.tt-body {
  padding: 0 10px 10px;
  border-top: 1px dashed var(--border);
}

.tt-body .hint {
  margin: 8px 0;
  font-size: 11.5px;
  line-height: 1.6;
}

.tt-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.tt-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
  font-size: 12px;
}

.tt-item.empty {
  color: var(--muted);
  font-size: 11.5px;
}

.tt-name {
  font-weight: 600;
  font-family: var(--mono);
}

.tt-count {
  font-size: 10.5px;
  color: var(--muted);
}

.tt-ops {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.tt-ops .ghost.tiny {
  padding: 2px 7px;
  font-size: 10.5px;
}

.tt-input {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  padding: 4px 8px;
  font-size: 12px;
}

.tt-add {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.tt-add .ghost.tiny {
  flex: 0 0 auto;
  padding: 4px 10px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 7px;
}

.tt-legacy {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}

.tt-notice {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--ok);
}
</style>
