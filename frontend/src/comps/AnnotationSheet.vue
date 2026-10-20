<script setup lang="ts">
/**
 * **币种标注**底部弹窗（2026-10-20）。
 *
 * 用户：「在 K 线页面顶部右侧加一个按钮在测试旁第一个，点击之后可以底部弹窗
 * 可以打标签和描述，标签是可选的可维护的」。
 *
 * 两块（2026-10-20 用户：「不需要加描述了，简单一点」——描述那格整块删掉）：
 *   ① 标签多选（按色系分组，一条最多 8 个）；
 *   ② 快速加标签（输入 + 回车，加完顺手选中）+「管理标签」（改名 / 色系 / 删除）。
 *
 * 用全站统一的 `.sheet` 底部弹层（跟 `BanSheet` 一样 `Teleport to="body"`），
 * 样式大部分写在 `style.css`，这里只补弹窗自己的那几块。
 */
import {computed, ref, watch} from 'vue'
import {
  addAnnotationTag,
  addSymbolAnnotation,
  agoText,
  annotationTags,
  ensureAnnotationTags,
  historyOf,
  loadAnnotationHistory,
  removeSymbolAnnotation,
  removeTag,
  tagChipStyle,
  TAG_FAMILY_COLORS,
  TAG_FAMILY_LABEL,
  tagFamilyDotColor,
  tagFamilyOf,
  updateTag,
  type TagFamily
} from '../annotations'
import type {SymbolAnnotation} from '../api'
import {askConfirm} from '../confirm'
import {bjShort, bjTime} from '../format'
import {showToast} from '../toast'

const props = defineProps<{
  open: boolean
  /** 要标注的币（基础币，`BTC`） */
  base: string
}>()

const emit = defineEmits<{(e: 'close'): void}>()

/** 一条标注最多选几个标签（跟后端 MAX_TAGS_PER_ANNOTATION 一致） */
const MAX_PICK = 8

const baseUpper = computed(() => String(props.base ?? '').trim().toUpperCase())
const selected = ref<string[]>([])
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
/**
 * 历史面板开着没有（用户 2026-10-20：「底下的去掉，历史放在标签弹窗，
 * 加一个图标可弹窗看历史」—— 就是标题右边那颗时钟）。
 */
const historyOpen = ref(false)
/** 这个币的历史（模块级缓存，见 `annotations.historyOf`） */
const entries = computed(() => historyOf(baseUpper.value))
/** 正在删的那条历史 */
const histBusyId = ref(0)
/** 管理区里正在展开「换色系」的那条标签（0 = 都收着） */
const famEditId = ref(0)

/**
 * 词表按色系分组（用户 2026-10-20：「按颜色分类可选择标签」）。
 *
 * 顺序固定 红 → 绿 → 黄 → 灰，空的组不渲染；组里保持词表原来的维护顺序。
 */
const tagGroups = computed(() => {
  const order: TagFamily[] = ['red', 'green', 'yellow', 'gray']
  return order
    .map(family => ({
      family,
      label: TAG_FAMILY_LABEL[family],
      tags: annotationTags.value.filter(t => tagFamilyOf(t.name) === family)
    }))
    .filter(g => g.tags.length > 0)
})

/** 管理区里可以点的那三个色系（灰 = 还没归类，不给按钮） */
const FAMILY_CHOICES: {family: keyof typeof TAG_FAMILY_COLORS; hex: string}[] = [
  {family: 'red', hex: TAG_FAMILY_COLORS.red},
  {family: 'green', hex: TAG_FAMILY_COLORS.green},
  {family: 'yellow', hex: TAG_FAMILY_COLORS.yellow}
]

/** 保存键：有币、有内容、没在提交（标签正在改也别急着保存） */
const canSave = computed(
  () =>
    Boolean(baseUpper.value) &&
    !busy.value &&
    !tagBusy.value &&
    selected.value.length > 0
)

function resetForm(): void {
  selected.value = []
  error.value = ''
  busy.value = false
  manage.value = false
  newTag.value = ''
  tagBusy.value = false
  editId.value = 0
  editName.value = ''
  historyOpen.value = false
  histBusyId.value = 0
  famEditId.value = 0
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
    const tag = await updateTag(id, {name})
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

/** 标题右边那颗时钟：开关历史面板（打开时顺手拉一次最新的） */
function toggleHistory(): void {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) {
    void loadAnnotationHistory(baseUpper.value, true).catch(e => {
      error.value = (e as Error).message
    })
  }
}

/** 管理区里那颗圆点：点一下展开三种颜色，再点收起来 */
function toggleFamEdit(id: number): void {
  famEditId.value = famEditId.value === id ? 0 : id
}

/** 删一条历史（确认后删；删完列表由 store 自己回退） */
async function removeEntry(entry: SymbolAnnotation): Promise<void> {
  if (histBusyId.value) return
  const ok = await askConfirm({
    title: '删掉这条标注？',
    body: [entry.tags.join(' · ') || '（没标签）', bjTime(entry.at)],
    okText: '删除',
    danger: true
  })
  if (!ok) return
  histBusyId.value = entry.id
  try {
    await removeSymbolAnnotation(entry.id, baseUpper.value)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    histBusyId.value = 0
  }
}

/** 把一个标签归到某个色系（存的就是那个色系的代表色） */
async function setFamily(name: string, hex: string): Promise<void> {
  const tag = annotationTags.value.find(t => t.name === name)
  if (!tag || tagBusy.value) return
  if (String(tag.color ?? '').toLowerCase() === hex) return
  tagBusy.value = true
  error.value = ''
  try {
    await updateTag(tag.id, {color: hex})
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
        <b>{{ baseUpper || '—' }} · {{ historyOpen ? '历史标注' : '标注' }}</b>
        <span class="ann-head-btns">
          <!-- 时钟：开关历史面板（用户 2026-10-20：「加一个图标可弹窗看历史」） -->
          <button
            type="button"
            class="ghost tiny ann-ico"
            :class="{on: historyOpen}"
            :aria-label="historyOpen ? '返回标注' : '看历史标注'"
            :title="historyOpen ? '返回标注' : '历史标注'"
            :aria-pressed="historyOpen"
            @click="toggleHistory"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8.4" />
              <path d="M12 7.6V12l3 1.9" />
            </svg>
          </button>
          <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
        </span>
      </header>

      <!-- ================= 历史面板 ================= -->
      <template v-if="historyOpen">
        <p v-if="!entries.length" class="ann-hint">这个币还没有标注。</p>
        <ul v-else class="ann-hist">
          <li v-for="e in entries" :key="e.id" class="ann-hist-item">
            <div class="ann-hist-top">
              <span
                v-for="t in e.tags"
                :key="t"
                class="ann-hist-pill"
                :style="tagChipStyle(t)"
                >{{ t }}</span
              >
              <span v-if="!e.tags.length" class="ann-hist-pill ann-hist-only"
                >标注</span
              >
              <span class="ann-hist-time" :title="bjTime(e.at)"
                >{{ bjShort(e.at) }} · {{ agoText(e.at) }}</span
              >
              <button
                type="button"
                class="ann-ico ann-ico-del"
                :disabled="histBusyId === e.id"
                title="删掉这条标注"
                aria-label="删掉这条标注"
                @click="removeEntry(e)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 7h14M10 7V5.2h4V7M7.4 7l.7 12.1h7.8L16.6 7" />
                </svg>
              </button>
            </div>
            <p v-if="e.note" class="ann-hist-note">{{ e.note }}</p>
          </li>
        </ul>
        <button class="btn-run ann-save" @click="historyOpen = false">
          返回标签
        </button>
      </template>

      <!-- ================= 选标签 / 管理 ================= -->
      <template v-else>
        <p class="ann-lead">点几个标签就算标好了（可以多选）。</p>

        <!--
          ① 多选标签：**按色系分组**（红 / 绿 / 黄 / 灰），组名在左边，标签在里面排一排。
          用户 2026-10-20：「改为三色系、扁平化（无边框），按颜色分类可选择标签」。
        -->
        <div class="ann-pick">
          <div v-for="g in tagGroups" :key="g.family" class="ann-group">
            <span class="ann-group-k">{{ g.label }}</span>
            <button
              v-for="t in g.tags"
              :key="t.id"
              type="button"
              class="ann-pick-chip"
              :class="{on: selected.includes(t.name)}"
              :style="tagChipStyle(t.name)"
              :aria-pressed="selected.includes(t.name)"
              @click="toggleTag(t.name)"
            >
              {{ t.name }}
            </button>
          </div>
          <p v-if="!annotationTags.length" class="ann-hint">
            还没有标签，点右边的齿轮加一个。
          </p>
          <!-- 管理标签：一个齿轮图标（用户 2026-10-20：「管理标签改为管理的图标」） -->
          <button
            type="button"
            class="ghost tiny ann-ico ann-manage-btn"
            :class="{on: manage}"
            :aria-label="manage ? '收起管理' : '管理标签'"
            :title="manage ? '收起管理' : '管理标签'"
            :aria-pressed="manage"
            @click="manage = !manage"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3.1" />
              <path
                d="M12 3.4l1.5 1.9 2.3-.5.7 2.3 2.2 1-.9 2.2.9 2.2-2.2 1-.7 2.3-2.3-.5L12 20.6l-1.5-1.9-2.3.5-.7-2.3-2.2-1 .9-2.2-.9-2.2 2.2-1 .7-2.3 2.3.5z"
              />
            </svg>
          </button>
        </div>

        <!--
          ② 管理标签（齿轮展开）：新增 + 改名 / 换色系 / 删除。
          用户 2026-10-20：「新增也放在管理里」「颜色只显示当前的颜色，点击出现切换」
          「改名和删除换图标」。
        -->
        <div v-if="manage" class="ann-manage">
          <div class="ann-add">
            <input
              v-model="newTag"
              class="ann-add-input"
              type="text"
              maxlength="12"
              placeholder="新标签，如 插针"
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
                class="ann-ico"
                :disabled="tagBusy || !editName.trim()"
                title="保存"
                aria-label="保存"
                @click="submitEdit"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12.6l4.4 4.4L19 7.4" />
                </svg>
              </button>
              <button
                type="button"
                class="ann-ico"
                title="取消"
                aria-label="取消"
                @click="cancelEdit"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
                </svg>
              </button>
            </template>
            <template v-else>
              <!-- 只显示**当前**色系那一颗；点它才展开红 / 绿 / 黄三选一 -->
              <button
                type="button"
                class="ann-fam-now"
                :style="{background: tagFamilyDotColor(t.name)}"
                :title="`色系：${TAG_FAMILY_LABEL[tagFamilyOf(t.name)]}（点一下换）`"
                :aria-label="`「${t.name}」的色系：${TAG_FAMILY_LABEL[tagFamilyOf(t.name)]}，点一下换`"
                :aria-expanded="famEditId === t.id"
                @click="toggleFamEdit(t.id)"
              />
              <span class="ann-manage-name">{{ t.name }}</span>
              <span v-if="famEditId === t.id" class="ann-fam-pop">
                <button
                  v-for="f in FAMILY_CHOICES"
                  :key="f.family"
                  type="button"
                  class="ann-fam-dot"
                  :class="{on: tagFamilyOf(t.name) === f.family}"
                  :style="{background: f.hex}"
                  :title="`归到${TAG_FAMILY_LABEL[f.family]}`"
                  :aria-label="`把「${t.name}」归到${TAG_FAMILY_LABEL[f.family]}`"
                  :disabled="tagBusy"
                  @click="setFamily(t.name, f.hex)"
                />
              </span>
              <button
                type="button"
                class="ann-ico"
                title="改名"
                aria-label="改名"
                @click="startEdit(t)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4.8 19.2l.9-3.6L15.9 5.4l2.7 2.7L8.4 18.3z" />
                </svg>
              </button>
              <button
                type="button"
                class="ann-ico ann-ico-del"
                :disabled="tagBusy"
                title="删除"
                aria-label="删除"
                @click="deleteTag(t)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 7h14M10 7V5.2h4V7M7.4 7l.7 12.1h7.8L16.6 7" />
                </svg>
              </button>
            </template>
          </div>
        </div>

        <p v-if="error" class="error ann-err">{{ error }}</p>

        <button class="btn-run ann-save" :disabled="!canSave" @click="save">
          {{ busy ? '保存中…' : '保存标注' }}
        </button>
        <p class="ann-dim">
          时间按保存那一刻算；历史标注点标题右边那颗时钟看。
        </p>
      </template>
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

/*
 * 标签选择区：**按色系分组**，每组一行（左边一枚「红色系 / 绿色系 / …」的小字，
 * 右边标签平铺，放不下自己换行）。用户 2026-10-20：「按颜色分类可选择标签」。
 */
.ann-pick {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 8px;
}
.ann-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ann-group-k {
  flex: 0 0 auto;
  width: 46px;
  font-size: 11px;
  color: var(--muted);
}
/* 扁平胶囊：底色 / 字色由 `tagChipStyle()` 内联给（三色系），这里只管形状 */
.ann-pick-chip {
  flex: 0 0 auto;
  max-width: 100%;
  padding: 5px 9px;
  border: 0;
  /* 用户 2026-10-20：「标签选择圆角小一点」—— 999px 的胶囊改成小圆角方块感 */
  border-radius: 6px;
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
/* 选中 = 字重 + 一圈本色细环（无边框那套风格里，这是最不打断扁平感的选中态） */
.ann-pick-chip.on {
  font-weight: 600;
  box-shadow: 0 0 0 1px currentColor;
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
/*
 * 「管理标签」每行开头那枚**当前色系**的圆点：
 * 平时只显示一个（用户 2026-10-20：「颜色只显示当前的颜色，点击出现切换」），
 * 点它才在名字右边展开红 / 绿 / 黄三颗。
 */
.ann-fam-now {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 50%;
  cursor: pointer;
}
.ann-fam-pop {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--panel);
}
.ann-fam-dot {
  width: 13px;
  height: 13px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  opacity: 0.55;
}
.ann-fam-dot.on {
  opacity: 1;
  box-shadow: 0 0 0 1.5px var(--panel), 0 0 0 2.5px currentColor;
}
.ann-fam-dot:disabled {
  cursor: default;
}

/* 图标按钮（管理齿轮 / 改名 / 删除 / 保存 / 取消 / 历史时钟） */
.ann-ico {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 全局 `button` 带底色，图标按钮要自己关掉（否则会变成一块金底） */
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.ann-ico:disabled {
  opacity: 0.4;
  cursor: default;
}
.ann-ico svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ann-ico.on {
  color: var(--accent);
  background: var(--accent-soft, rgba(255, 193, 107, 0.13));
}
.ann-ico-del:hover:not(:disabled) {
  color: var(--bad, #e35561);
  background: var(--bad-soft, rgba(227, 85, 97, 0.14));
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

/* 标题右侧：历史时钟 + 关闭 */
.ann-head-btns {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* 历史面板（标题右边那颗钟点开）：一条一个卡片，标签 + 时间 + 删除 */
.ann-hist {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow: auto;
}
.ann-hist-item {
  padding: 7px 9px;
  border-radius: var(--r-xs, 8px);
  background: var(--panel-2);
}
.ann-hist-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}
.ann-hist-pill {
  flex: 0 0 auto;
  max-width: 100%;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--panel);
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.5;
  white-space: nowrap;
}
.ann-hist-only {
  opacity: 0.75;
}
.ann-hist-time {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--muted);
  font-size: 10.5px;
  white-space: nowrap;
}
.ann-hist-note {
  margin: 5px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
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
