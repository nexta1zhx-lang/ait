<script setup lang="ts">
/**
 * AI 提示词。
 *
 * 每次分析发给模型的东西里，「分析预测提示词」在这里维护 ——
 * 存数据库（`ai_docs`，kind=predict），可以有多份、可以随时启停；
 * 分析时**只读打勾的那些**，拼成一份 system prompt。
 * 每次保存留一版历史，改坏了能回滚。
 *
 * 输出 JSON 契约不在这里：那是程序接口，写死在代码里。
 */
import {computed, onMounted, ref, watch} from 'vue'
import {
  createAiDoc,
  deleteAiDoc,
  fetchAiDocs,
  fetchAiPreview,
  fetchAiVersion,
  fetchAiVersions,
  restoreAiVersion,
  updateAiDoc,
  type AiAssembly,
  type AiDoc,
  type AiDocVersion,
  type DocKind
} from '../api'
import {bjTime} from '../format'
import {refreshConfig} from '../store'

const docs = ref<AiDoc[]>([])
const assembly = ref<AiAssembly | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')

/** 分析预测 —— 开单分析读的就是它（可以有备选，但只有打勾的会生效） */
const predicts = computed(() => docs.value.filter(d => d.kind === 'predict'))
/** 知识库提炼那份（收录案例时用，跟开单分析不是一条链路） */
const extracts = computed(() => docs.value.filter(d => d.kind === 'extract'))

/** 类型 → 中文名（role / rule 是旧版留下的，不再参与分析） */
const KIND_TEXT: Record<DocKind, string> = {
  predict: '分析预测',
  extract: '知识库提炼',
  role: '角色设定（旧）',
  rule: '规则正文（旧）'
}
const kindText = (k: DocKind) => KIND_TEXT[k]

/** 某一类的清单（排序 / 上下移都用它） */
const listOf = (k: DocKind) =>
  k === 'extract' ? extracts.value : predicts.value

/**
 * 右列显示什么。
 *
 * 左列是清单，右列是「点出来的东西」—— 看正文 / 编辑 / 历史版本 / 拼好的全文，
 * 四种状态互斥，永远只显示一个。
 */
type View = 'none' | 'doc' | 'edit' | 'history' | 'preview'
const view = ref<View>('none')
/** 右列正在看的那一份 */
const current = ref<AiDoc | null>(null)

const draftName = ref('')
const draftContent = ref('')
const saving = ref(false)

const versions = ref<AiDocVersion[]>([])
const previewVersion = ref<{chars: number; content: string} | null>(null)

const previewText = ref('')

async function load() {
  loading.value = true
  try {
    const d = await fetchAiDocs()
    docs.value = d.docs
    assembly.value = d.assembly
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(load)

function flash(msg: string) {
  notice.value = msg
  window.setTimeout(() => {
    if (notice.value === msg) notice.value = ''
  }, 2600)
}

/**
 * 手机上（≤1000px）是「一次只显示一块」：点开一份就把清单收起来
 * （规则见 style 里的 `.prompts.v-*`），所以打开时要把页面带回顶部，
 * 否则右列在屏幕外、看起来像没反应。
 */
watch(view, v => {
  if (v === 'none') return
  if (!window.matchMedia('(max-width: 1000px)').matches) return
  window.scrollTo({top: 0, behavior: 'smooth'})
})

/* ---------------- 右列：点开看 / 编辑 / 历史 ---------------- */

/** 点左边一条 → 右边显示它的正文 */
function openDoc(d: AiDoc) {
  current.value = d
  previewVersion.value = null
  view.value = 'doc'
}

/** 右列回到空态 */
function closeView() {
  view.value = 'none'
  current.value = null
  previewVersion.value = null
}

/** 从历史 / 编辑退回「看正文」 */
function backToDoc() {
  view.value = current.value ? 'doc' : 'none'
}

function startEdit(d: AiDoc) {
  current.value = d
  draftName.value = d.name
  draftContent.value = d.content
  previewVersion.value = null
  view.value = 'edit'
}

/** 取消编辑 → 退回「看正文」 */
function cancelEdit() {
  previewVersion.value = null
  backToDoc()
}

async function save() {
  const id = current.value?.id ?? 0
  if (!id) return
  saving.value = true
  try {
    const {doc} = await updateAiDoc(id, {
      name: draftName.value,
      content: draftContent.value
    })
    const i = docs.value.findIndex(d => d.id === id)
    if (i >= 0) docs.value[i] = doc
    await refreshAssembly()
    // 保存完停在右列继续看（而不是把右列关掉）
    current.value = doc
    view.value = 'doc'
    flash('已保存（这一版进了历史，可回滚）')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function refreshAssembly() {
  const d = await fetchAiDocs()
  docs.value = d.docs
  assembly.value = d.assembly
  // 右列指向的得换成新对象 —— 否则列表里的改动（启停 / 顺序）右边看不到
  if (current.value) {
    const id = current.value.id
    current.value = d.docs.find(x => x.id === id) ?? null
    if (!current.value) view.value = 'none'
  }
  await refreshConfig()
}

/** 新建：先建一份空的，然后立刻进入编辑 */
async function addDoc(kind: DocKind) {
  const NAMES: Record<DocKind, [string, string]> = {
    predict: ['提示词的名字', '新分析预测'],
    extract: ['提炼提示词的名字', '新提炼提示词'],
    role: ['角色设定的名字', '新角色'],
    rule: ['规则的名字', '新规则']
  }
  const [title, def] = NAMES[kind]
  const name = window.prompt(title, def)
  if (!name) return
  try {
    const {doc} = await createAiDoc({kind, name, content: ''})
    await refreshAssembly()
    startEdit(doc)
  } catch (e) {
    error.value = (e as Error).message
  }
}

/** 复制一份再改 —— 这就是「我自己有好几个版本」最顺手的入口 */
async function duplicate(d: AiDoc) {
  try {
    const {doc} = await createAiDoc({
      kind: d.kind,
      name: `${d.name} 副本`,
      content: d.content
    })
    await refreshAssembly()
    flash(`已复制出一份「${doc.name}」`)
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function toggle(d: AiDoc) {
  try {
    await updateAiDoc(d.id, {enabled: !d.enabled})
    await refreshAssembly()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function move(d: AiDoc, dir: -1 | 1) {
  const list = listOf(d.kind)
  const i = list.findIndex(x => x.id === d.id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return
  try {
    // 跟邻居交换 sort
    await updateAiDoc(list[i].id, {sort: list[j].sort})
    await updateAiDoc(list[j].id, {sort: list[i].sort})
    await refreshAssembly()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function remove(d: AiDoc) {
  if (!window.confirm(`确定删掉「${d.name}」？（它的历史版本会一起删）`)) return
  try {
    await deleteAiDoc(d.id)
    if (current.value?.id === d.id) closeView()
    await refreshAssembly()
    flash('已删除')
  } catch (e) {
    error.value = (e as Error).message
  }
}

/* ---------------- 历史版本 ---------------- */

async function openHistory(d: AiDoc) {
  current.value = d
  previewVersion.value = null
  view.value = 'history'
  versions.value = []
  try {
    versions.value = (await fetchAiVersions(d.id)).versions
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function lookVersion(v: AiDocVersion) {
  try {
    const {version} = await fetchAiVersion(v.id)
    previewVersion.value = {
      chars: version.content.length,
      content: version.content
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function restore(v: AiDocVersion) {
  if (!window.confirm(`把「${v.name}」恢复到 ${bjTime(v.savedAt)} 那一版？`)) {
    return
  }
  try {
    await restoreAiVersion(v.id)
    await refreshAssembly()
    if (current.value) await openHistory(current.value)
    flash('已恢复（恢复动作本身也留了一版）')
  } catch (e) {
    error.value = (e as Error).message
  }
}

/* ---------------- 预览 ---------------- */

async function openPreview() {
  current.value = null
  view.value = 'preview'
  previewText.value = '读取中…'
  try {
    previewText.value = (await fetchAiPreview()).system
  } catch (e) {
    previewText.value = `读取失败：${(e as Error).message}`
  }
}
</script>

<template>
  <div class="prompts" :class="`v-${view}`">
    <!-- ── 左：清单（点一条，右边就显示它） ── -->
    <section class="panel list">
      <h2>AI 提示词 <span class="tag">分析预测 + 知识库提炼</span></h2>

      <p class="hint">
        分析时读的就是<b>分析预测</b>那一份（打勾才生效；有多份时按顺序拼起来）。
        每次保存留一版历史，改坏了能回滚。
        <br />
        输出 JSON 的<b>格式</b>写死在代码里，不在这里管。
      </p>

      <!-- 这次会发什么 -->
      <div class="summary">
        <template v-if="assembly">
          <span v-if="assembly.enabled" class="ok">
            ✅ 分析会发：分析预测
            {{ predicts.filter(d => d.enabled).length }} 份 ·
            {{ assembly.predictChars }} 字 · {{ assembly.hash }}
          </span>
          <span v-else class="warn">
            ⚠️ 没有启用的分析预测提示词 —— 分析会直接报错
          </span>
          <span
            class="badge"
            :class="assembly.extractChars ? 'ok' : 'warn'"
            :title="
              assembly.extractChars
                ? assembly.extractSources.join('、')
                : '收录案例会直接报错'
            "
          >
            知识库提炼 {{ extracts.filter(d => d.enabled).length }} 份 ·
            {{ assembly.extractChars }} 字 · {{ assembly.extractHash }}
          </span>
        </template>
        <button type="button" class="ghost tiny" @click="openPreview">
          看拼好的全文
        </button>
      </div>

      <div v-if="error" class="error">❌ {{ error }}</div>
      <div v-if="notice" class="notice">✔ {{ notice }}</div>

      <!-- 分析预测（开单分析读这一份） -->
      <h3 class="group">
        分析预测 <span class="dim">怎么读行情 / 怎么预测 / 怎么给概率</span>
      </h3>
      <ul class="docs">
        <li
          v-for="d in predicts"
          :key="d.id"
          :class="{off: !d.enabled, on: current?.id === d.id}"
          @click="openDoc(d)"
        >
          <label class="pick" title="打勾才会发给模型" @click.stop>
            <input type="checkbox" :checked="d.enabled" @change="toggle(d)" />
          </label>
          <span class="name">{{ d.name }}</span>
          <span class="meta">{{ d.content.length }} 字</span>
          <span class="arrow">›</span>
        </li>
        <li v-if="!predicts.length" class="empty">
          还没有分析预测提示词 —— 没有它分析会直接报错
        </li>
      </ul>
      <button class="ghost tiny add" @click="addDoc('predict')">
        + 新建分析预测
      </button>

      <!-- 知识库提炼 -->
      <h3 class="group">
        知识库提炼 <span class="dim">收录案例时让 AI 怎么读这段行情</span>
      </h3>
      <ul class="docs">
        <li
          v-for="d in extracts"
          :key="d.id"
          :class="{off: !d.enabled, on: current?.id === d.id}"
          @click="openDoc(d)"
        >
          <label class="pick" title="打勾才会拼进 prompt" @click.stop>
            <input type="checkbox" :checked="d.enabled" @change="toggle(d)" />
          </label>
          <span class="name">{{ d.name }}</span>
          <span class="meta">{{ d.content.length }} 字</span>
          <span class="arrow">›</span>
        </li>
        <li v-if="!extracts.length" class="empty">
          还没有提炼提示词 —— 没有它「添加案例」会直接报错
        </li>
      </ul>
      <button class="ghost tiny add" @click="addDoc('extract')">
        + 新建提炼提示词
      </button>
      <p class="hint" style="margin-top: 6px">
        正文里写
        <code>&#123;&#123;标签&#125;&#125;</code> 的话，标签清单就插在那一行；
        没写就接在末尾。
      </p>
    </section>

    <!-- ── 右：点出来的内容 ── -->
    <section class="panel detail">
      <!-- 手机上才显示：清单被收起来了，给一条退路 -->
      <button
        v-if="view !== 'none'"
        type="button"
        class="ghost tiny back"
        @click="closeView"
      >
        ‹ 返回清单
      </button>

      <!-- 拼好的全文 -->
      <template v-if="view === 'preview'">
        <h2>
          这次真正发出去的 system prompt
          <span class="tag">不含知识库经验与行情</span>
        </h2>
        <pre class="preview">{{ previewText }}</pre>
        <div class="edit-ops">
          <span class="spacer" />
          <button class="ghost tiny" @click="closeView">关闭</button>
        </div>
      </template>

      <!-- 历史版本 -->
      <template v-else-if="view === 'history' && current">
        <h2>
          历史版本 <span class="tag">{{ current.name }}</span>
        </h2>
        <p class="hint">
          每次保存（或恢复）都留一版。点「看这版」先在下面预览，确认了再「恢复这版」。
        </p>
        <ul class="versions">
          <li v-for="v in versions" :key="v.id">
            <span class="t">{{ bjTime(v.savedAt) }}</span>
            <span class="meta">{{ v.chars }} 字</span>
            <span class="spacer" />
            <button class="ghost tiny" @click="lookVersion(v)">看这版</button>
            <button class="ghost tiny" @click="restore(v)">恢复这版</button>
          </li>
          <li v-if="!versions.length" class="empty">
            还没有历史（保存一次就有了）
          </li>
        </ul>
        <pre v-if="previewVersion" class="preview">{{
          previewVersion.content
        }}</pre>
        <div class="edit-ops">
          <span class="spacer" />
          <button class="ghost tiny" @click="backToDoc">返回正文</button>
        </div>
      </template>

      <!-- 编辑 -->
      <template v-else-if="view === 'edit' && current">
        <h2>
          编辑
          <span class="tag">{{ kindText(current.kind) }}</span>
          <span class="dim">{{ current.name }}</span>
        </h2>
        <label class="field">
          <span>名字（会作为小标题写进 prompt）</span>
          <input v-model="draftName" />
        </label>
        <label class="field">
          <span>正文（Markdown 原样写）</span>
          <textarea v-model="draftContent" rows="20" class="editor" />
        </label>
        <div class="edit-ops">
          <span class="dim">{{ draftContent.length }} 字</span>
          <span class="spacer" />
          <button class="ghost" @click="cancelEdit">取消</button>
          <button :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </template>

      <!-- 看正文 -->
      <template v-else-if="view === 'doc' && current">
        <header class="detail-head">
          <h2>{{ current.name }}</h2>
          <span class="tag">{{ kindText(current.kind) }}</span>
          <span class="meta">
            {{ current.content.length }} 字 · 改于
            {{ bjTime(current.updatedAt) }}
          </span>
          <span v-if="!current.enabled" class="warn-badge">未启用</span>
        </header>

        <div class="detail-ops">
          <button class="ghost tiny" @click="startEdit(current)">编辑</button>
          <button class="ghost tiny" @click="openHistory(current)">
            历史版本
          </button>
          <button
            class="ghost tiny"
            title="拼进 prompt 时往上挪一位"
            @click="move(current, -1)"
          >
            ↑ 上移
          </button>
          <button
            class="ghost tiny"
            title="拼进 prompt 时往下挪一位"
            @click="move(current, 1)"
          >
            ↓ 下移
          </button>
          <button class="ghost tiny" @click="duplicate(current)">
            复制一份
          </button>
          <span class="spacer" />
          <button class="ghost tiny danger" @click="remove(current)">
            删掉
          </button>
        </div>

        <pre class="preview doc-body">{{
          current.content || '（正文还空着，点「编辑」写点东西）'
        }}</pre>
      </template>

      <!-- 还没点任何一份 -->
      <template v-else>
        <div class="empty-detail">
          <p>👈 <b>点左边任意一份</b>，这里就显示它的正文。</p>
          <p class="dim">
            看完点「编辑」改，改坏了点「历史版本」回滚；上面「看拼好的全文」能看这次真正发出去的东西。
          </p>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
/* 两列：左边清单，右边显示点出来的内容 */
.prompts {
  display: grid;
  grid-template-columns: minmax(0, 350px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

/* 只在窄屏出现（桌面本来就是左右两栏并排） */
.prompts .back {
  display: none;
}

@media (max-width: 1000px) {
  .prompts {
    grid-template-columns: minmax(0, 1fr);
  }
  /* 单列时 sticky 没意义，反而会跟滚动打架 */
  .prompts .list {
    position: static;
  }
  .prompts .back {
    display: inline-flex;
    margin-bottom: 8px;
  }
  /*
   * 一次只显示一块。
   * 手机上清单很长（两份文档 + 两个分组标题 + 说明），
   * 点了文档后正文落在整张清单的下方 —— 不清空就等于「点了没反应」。
   */
  .prompts.v-doc .list,
  .prompts.v-edit .list,
  .prompts.v-history .list,
  .prompts.v-preview .list {
    display: none;
  }
  /* 还没点任何一份时，右边的空态提示也不用占一屏 */
  .prompts.v-none .detail {
    display: none;
  }
}

.prompts .list {
  position: sticky;
  top: 12px;
}

/* ---------------- 左列：清单 ---------------- */

/* 左列只有 350px，这三条挤在一行会各自断成三四行 —— 直接竖排、每条占一行 */
.summary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  margin-top: 9px;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.65;
}

/* 竖排后不需要「推到右边」这件事 */
.summary .spacer {
  display: none;
}

.summary .ok {
  color: var(--ok);
}
.summary .warn {
  color: var(--warn);
}
.spacer {
  margin-left: auto;
}

.notice {
  margin: 8px 0;
  padding: 6px 10px;
  border-radius: 7px;
  background: var(--ok-soft);
  color: var(--ok);
  font-size: 12px;
}

.group {
  margin: 16px 0 6px;
  font-size: 13px;
}
.group .dim {
  font-size: 11px;
  font-weight: 400;
}

.docs,
.versions {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.docs li,
.versions li {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  margin-bottom: 5px;
}

/* 清单每一条都能点 —— 点了右边就显示它 */
.docs li {
  cursor: pointer;
}

.docs li:hover {
  border-color: var(--blue);
}

.docs li.on {
  border-color: var(--blue);
  background: color-mix(in srgb, var(--blue) 9%, transparent);
}

.docs li.on .name {
  color: var(--blue);
}

.docs li.off {
  opacity: 0.5;
}

.docs li.empty,
.versions li.empty {
  border-style: dashed;
  color: var(--muted);
  justify-content: center;
  cursor: default;
}

.docs li.empty:hover {
  border-color: var(--border);
}

.pick {
  display: flex;
  align-items: center;
}

.docs .name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.meta,
.versions .t {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.docs .meta {
  flex: 0 0 auto;
}

.docs .arrow {
  margin-left: auto;
  color: var(--muted);
  font-size: 14px;
  line-height: 1;
}

.ghost.tiny.danger {
  color: var(--bad);
}

.add {
  margin-top: 2px;
}

/* ---------------- 右列：点出来的内容 ---------------- */

.detail {
  min-height: 320px;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-bottom: 9px;
}

.detail-head h2 {
  margin: 0;
  font-size: 15px;
}

.warn-badge {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
  color: var(--warn);
  font-size: 10.5px;
}

.detail-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 9px;
  margin-bottom: 9px;
  border-bottom: 1px dashed var(--border);
}

/* 空态：还没点任何一份 */
.empty-detail {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 260px;
  text-align: center;
  color: var(--muted);
  font-size: 12.5px;
}

.empty-detail p {
  margin: 0;
  line-height: 1.7;
}

.empty-detail .dim {
  font-size: 11.5px;
  max-width: 42ch;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 9px;
  font-size: 12px;
}

.field > span {
  color: var(--muted);
}

.editor {
  min-height: 42vh;
  padding: 10px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}

.edit-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview {
  max-height: 420px;
  overflow: auto;
  margin: 8px 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.25);
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 看正文时给足高度，长文档能一屏看更多 */
.doc-body {
  max-height: none;
  min-height: 300px;
  margin: 0;
  background: rgba(0, 0, 0, 0.18);
}

/*
 * 窄屏覆盖必须写在最后 —— 同特异性下靠「后写的赢」，
 * 放前面会被上面那几条基样式盖掉。
 */
@media (max-width: 1000px) {
  /* 正文 / 预览：手机高度有限，不用桌面那套 420px + 11.5px */
  .preview {
    max-height: 56vh;
    font-size: 11px;
  }
  .doc-body {
    min-height: 200px;
  }
  /* 编辑框给足高度，手机上敲长篇很难受 */
  .editor {
    min-height: 52vh;
  }
}
</style>
