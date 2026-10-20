<script setup lang="ts">
/**
 * **币种标注**底部弹窗（2026-10-20）。
 *
 * 用户：「在 K 线页面顶部右侧加一个按钮在测试旁第一个，点击之后可以底部弹窗
 * 可以打标签和描述，标签是可选的可维护的」。
 *
 * 三块：
 *   ① 标签多选（词表里点，选中高亮；一条最多 8 个）；
 *   ② 快速加标签（输入 + 回车，加完顺手选中）+「管理标签」（改名 / 删除）；
 *   ③ 描述（500 字，可空）—— 标签和描述至少写一样，否则保存键是灰的。
 *
 * 用全站统一的 `.sheet` 底部弹层（跟 `BanSheet` 一样 `Teleport to="body"`），
 * 样式大部分写在 `style.css`，这里只补弹窗自己的那几块。
 */
import {computed, ref, watch} from 'vue'
import {
  addAnnotationTag,
  addSymbolAnnotation,
  annotationTags,
  ensureAnnotationTags,
  removeTag,
  renameTag
} from '../annotations'
import {askConfirm} from '../confirm'
import {showToast} from '../toast'

const props = defineProps<{
  open: boolean
  /** 要标注的币（基础币，`BTC`） */
  base: string
}>()

const emit = defineEmits<{(e: 'close'): void}>()

/** 一条标注最多选几个标签（跟后端 MAX_TAGS_PER_ANNOTATION 一致） */
const MAX_PICK = 8
/** 描述上限（跟后端 MAX_NOTE 一致） */
const MAX_NOTE = 500

const baseUpper = computed(() => String(props.base ?? '').trim().toUpperCase())
const selected = ref<string[]>([])
const note = ref('')
const error = ref('')
const busy = ref(false)

/** 管理标签那一块展开着没有 */
const manage = ref(false)
/** 新标签输入 */
const newTag = ref('')
/** 标签写操作忙不忙（跟保存分开，保存键不被它连坐） */
const tagBusy = ref(false)
/** 正在改名的那条 */
const editId = ref(0)
const editName = ref('')

/** 保存键：有币、有内容、没在提交（标签正在改也别急着保存） */
const canSave = computed(
  () =>
    Boolean(baseUpper.value) &&
    !busy.value &&
    !tagBusy.value &&
    (selected.value.length > 0 || note.value.trim().length > 0)
)

function resetForm(): void {
  selected.value = []
  note.value = ''
  error.value = ''
  busy.value = false
  manage.value = false
  newTag.value = ''
  tagBusy.value = false
  editId.value = 0
  editName.value = ''
}

/** 每次打开都是干净的一份；词表没到就顺手拉一次 */
watch(
  () => props.open,
  on => {
    if (!on) return
    resetForm()
    void ensureAnnotationTags().catch(e => {
      error.value = (e as Error).message
    })
  }
)

/** 弹窗开着的时候换了币（正常被遮罩挡住，理论上不会）—— 表单跟着重置 */
watch(
  () => props.base,
  () => {
    if (props.open) resetForm()
  }
)

function toggleTag(name: string): void {
  const i = selected.value.indexOf(name)
  if (i >= 0) {
    selected.value.splice(i, 1)
    return
  }
  if (selected.value.length >= MAX_PICK) {
    error.value = `一条标注最多选 ${MAX_PICK} 个标签`
    return
  }
  error.value = ''
  selected.value.push(name)
}

/** 新增标签：加完自动选中（最多 8 个的限制照旧） */
async function submitNewTag(): Promise<void> {
  const name = newTag.value.trim()
  if (!name || tagBusy.value) return
  tagBusy.value = true
  error.value = ''
  try {
    const tag = await addAnnotationTag(name)
    newTag.value = ''
    if (
      selected.value.length < MAX_PICK &&
      !selected.value.includes(tag.name)
    ) {
      selected.value.push(tag.name)
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    tagBusy.value = false
  }
}

function startEdit(tag: {id: number; name: string}): void {
  editId.value = tag.id
  editName.value = tag.name
  error.value = ''
}

function cancelEdit(): void {
  editId.value = 0
  editName.value = ''
}

/** 改名：后端会把历史标注里的同名标签一起改，前端把选中的那颗也换掉 */
async function submitEdit(): Promise<void> {
  const id = editId.value
  const name = editName.value.trim()
  if (!id || !name) return cancelEdit()
  const old = annotationTags.value.find(t => t.id === id)?.name ?? ''
  tagBusy.value = true
  error.value = ''
  try {
    const tag = await renameTag(id, name)
    if (old) {
      selected.value = selected.value.map(n => (n === old ? tag.name : n))
    }
    cancelEdit()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    tagBusy.value = false
  }
}

/** 删标签：历史里已经写下的名字保留，只是以后不再提供这个选项 */
async function deleteTag(tag: {id: number; name: string}): Promise<void> {
  const ok = await askConfirm({
    title: `删掉标签「${tag.name}」？`,
    body: [
      '历史标注里已经写下的这个名字会保留。',
      '删掉之后，新的标注里不再提供这个选项。'
    ],
    okText: '删除',
    danger: true
  })
  if (!ok) return
  tagBusy.value = true
  error.value = ''
  try {
    await removeTag(tag.id)
    selected.value = selected.value.filter(n => n !== tag.name)
    if (editId.value === tag.id) cancelEdit()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    tagBusy.value = false
  }
}

async function save(): Promise<void> {
  if (!canSave.value) return
  busy.value = true
  error.value = ''
  try {
    const entry = await addSymbolAnnotation({
      base: baseUpper.value,
      tags: [...selected.value],
      note: note.value.trim()
    })
    showToast(`${entry.base} 已标注`, 'ok')
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section
      v-if="open"
      class="sheet ann-sheet"
      role="dialog"
      aria-label="币种标注"
    >
      <header class="sheet-head">
        <b>{{ baseUpper || '—' }} · 标注</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
      </header>

      <p class="ann-lead">
        给这个币打几个标签、写一句当时的想法。标签可以多选，也可以不选。
      </p>

      <!-- ① 多选标签 -->
      <div class="ann-pick">
        <button
          v-for="t in annotationTags"
          :key="t.id"
          type="button"
          class="ann-pick-chip"
          :class="{on: selected.includes(t.name)}"
          :aria-pressed="selected.includes(t.name)"
          @click="toggleTag(t.name)"
        >
          {{ t.name }}
        </button>
        <button
          type="button"
          class="ghost tiny ann-manage-btn"
          @click="manage = !manage"
        >
          {{ manage ? '收起管理' : '管理标签' }}
        </button>
      </div>
      <p v-if="!annotationTags.length" class="ann-hint">
        还没有标签，在下面加一个（比如 杂毛、异能），或者直接写描述。
      </p>

      <!-- ② 快速加标签 -->
      <div class="ann-add">
        <input
          v-model="newTag"
          class="ann-add-input"
          type="text"
          maxlength="12"
          placeholder="新标签，如 杂毛"
          autocomplete="off"
          spellcheck="false"
          @keyup.enter="submitNewTag"
        />
        <button
          type="button"
          class="ghost tiny"
          :disabled="tagBusy || !newTag.trim()"
          @click="submitNewTag"
        >
          加
        </button>
      </div>

      <!-- ②' 管理：改名 / 删除 -->
      <div v-if="manage" class="ann-manage">
        <p v-if="!annotationTags.length" class="ann-hint">还没有标签。</p>
        <div v-for="t in annotationTags" :key="t.id" class="ann-manage-row">
          <template v-if="editId === t.id">
            <input
              v-model="editName"
              class="ann-add-input ann-edit-input"
              type="text"
              maxlength="12"
              autocomplete="off"
              spellcheck="false"
              @keyup.enter="submitEdit"
            />
            <button
              type="button"
              class="ghost tiny"
              :disabled="tagBusy || !editName.trim()"
              @click="submitEdit"
            >
              保存
            </button>
            <button type="button" class="ghost tiny" @click="cancelEdit">
              取消
            </button>
          </template>
          <template v-else>
            <span class="ann-manage-name">{{ t.name }}</span>
            <button type="button" class="ghost tiny" @click="startEdit(t)">
              改名
            </button>
            <button
              type="button"
              class="ghost tiny"
              :disabled="tagBusy"
              @click="deleteTag(t)"
            >
              删除
            </button>
          </template>
        </div>
      </div>

      <!-- ③ 描述 -->
      <label class="ann-note">
        <span>描述（可选）</span>
        <textarea
          v-model="note"
          rows="3"
          :maxlength="MAX_NOTE"
          placeholder="为什么标它？比如：刚插针、量能异常、走到前高……"
        />
        <em>{{ note.length }}/{{ MAX_NOTE }}</em>
      </label>

      <p v-if="error" class="error ann-err">{{ error }}</p>

      <button class="btn-run ann-save" :disabled="!canSave" @click="save">
        {{ busy ? '保存中…' : '保存标注' }}
      </button>
      <p class="ann-dim">
        时间按保存那一刻算；标签和描述至少写一样。历史标注在 K 线图下方，可折叠。
      </p>
    </section>
  </Teleport>
</template>

<style scoped>
.ann-lead {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted);
}

/* 选中 / 未选中的标签胶囊：一排铺开，标签多了自己换行 */
.ann-pick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.ann-pick-chip {
  flex: 0 0 auto;
  max-width: 100%;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1.2;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ann-pick-chip.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent);
}
.ann-manage-btn {
  margin-left: auto;
}

.ann-add {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.ann-add-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}
.ann-edit-input {
  flex: 1 1 90px;
}

.ann-hint {
  margin: 2px 0 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted);
}

/* 管理标签：一行一个，名字占满中间 */
.ann-manage {
  margin: 2px 0 10px;
  padding: 8px 0 2px;
  border-top: 1px solid var(--border);
}
.ann-manage-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.ann-manage-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}

.ann-note {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}
.ann-note textarea {
  width: 100%;
  min-height: 74px;
  resize: vertical;
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.55;
}
.ann-note em {
  align-self: flex-end;
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}

.ann-err {
  margin: 8px 0 0;
}
.ann-save {
  width: 100%;
  margin-top: 10px;
}
.ann-dim {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}
</style>
