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
  type DocKind,
  type TonePreset
} from '../api'
import {askConfirm} from '../confirm'
import {bjTime} from '../format'
import {refreshConfig} from '../store'
import SelectPick from '../comps/SelectPick.vue'

const docs = ref<AiDoc[]>([])
const assembly = ref<AiAssembly | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')

/** 分析预测 —— 开单分析读的就是它（可以有备选，但只有打勾的会生效） */
const predicts = computed(() => docs.value.filter(d => d.kind === 'predict'))
/** 知识库提炼那份 —— 模块 2026-10-18 删了，这几份**数据留着**（不再参与任何拼装） */
const extracts = computed(() => docs.value.filter(d => d.kind === 'extract'))
/** 日记润色那份（日记页「AI 美化」用，2026-10-18） */
const polishes = computed(() => docs.value.filter(d => d.kind === 'polish'))

/** 类型 → 中文名（role / rule 是旧版留下的，不再参与分析） */
const KIND_TEXT: Record<DocKind, string> = {
  predict: '分析预测',
  extract: '知识库提炼',
  polish: '日记润色',
  role: '角色设定（旧）',
  rule: '规则正文（旧）'
}
const kindText = (k: DocKind) => KIND_TEXT[k]

/** 某一类的清单（排序 / 上下移都用它） */
const listOf = (k: DocKind) =>
  k === 'extract'
    ? extracts.value
    : k === 'polish'
      ? polishes.value
      : predicts.value

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
  tones.value = d.tones ?? []
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
    polish: ['润色提示词的名字', '新日记润色'],
    role: ['角色设定的名字', '新角色'],
    rule: ['规则的名字', '新规则']
  }
  const [title, def] = NAMES[kind]
  const name = window.prompt(title, def)
  if (!name) return
  await create(kind, name, '')
}

/*
 * ── 新建「分析预测」：先挑语气 ──────────────────────────────────────
 *
 * ★ 2026-10-12（用户：「在新建里面加，这几种语气」）：
 *   提示词现在**拆成两份拼**：一份正文（判断依据）、一份「# 输出」（语气）。
 *   所以这里新建出来的**只放「# 输出」那一节**（模板见 `../prompt-templates`），
 *   正文那份不用动 —— 打勾的两份会按顺序拼起来（页面上「看拼好的全文」能看到）。
 */
const toneOpen = ref(false)
const toneId = ref('')
/** 新建语气时那一格「名字」（`openTonePicker` / 那个输入框都用它 —— 原来漏了声明，点了就报错） */
const toneName = ref('')
/** 语气预设（**后端**给的：`GET /api/ai-docs` 的 `tones`） */
const tones = ref<TonePreset[]>([])

const tone = computed<TonePreset | null>(
  () => tones.value.find(t => t.id === toneId.value) ?? tones.value[0] ?? null
)
/** 下拉里的选项（`SelectPick` 要 label / value / title） */
const toneOptions = computed(() =>
  tones.value.map(t => ({value: t.id, label: t.label, title: t.hint}))
)

function openTonePicker(): void {
  toneId.value = tone.value?.id ?? ''
  toneName.value = tone.value?.name ?? '新分析预测'
  toneOpen.value = true
}

watch(toneId, () => {
  if (tone.value) toneName.value = tone.value.name
})

async function create(kind: DocKind, name: string, content: string): Promise<AiDoc | null> {
  try {
    const {doc} = await createAiDoc({kind, name, content})
    await refreshAssembly()
    startEdit(doc)
    return doc
  } catch (e) {
    error.value = (e as Error).message
    return null
  }
}

async function createTone(): Promise<void> {
  const t = tone.value
  if (!t) return
  const name = toneName.value.trim() || t.name
  toneOpen.value = false
  const doc = await create('predict', name, t.output)
  if (!doc) return
  if (!t.output) return

  /*
   * 语气是**单选**的：新建的那份默认打勾，于是必须把其它「语气」份关掉 ——
   * 否则两份 `# 输出` 会按顺序拼在一起（模型收到两套互相打架的排版要求）。
   * 判据用**内容里有没有「# 输出」**，不靠名字 —— 用户把名字改乱了也照样认得出。
   */
  const others = predicts.value.filter(
    d => d.id !== doc.id && d.enabled && d.content.includes('# 输出')
  )
  for (const o of others) {
    try {
      await updateAiDoc(o.id, {enabled: false})
    } catch (e) {
      error.value = (e as Error).message
    }
  }
  if (others.length) await refreshAssembly()
  flash(
    others.length
      ? `已新建并启用「${name}」；原来的「${others.map(o => o.name).join('、')}」已自动关掉（语气只能留一份）`
      : `已新建并启用「${name}」—— 正文那份（分析预测）不用动，会按顺序拼起来`
  )
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

/**
 * 删掉一份提示词。
 *
 * ⚠️ 走站内那份确认框（`askConfirm`），别用 `window.confirm`：系统那种改不了样式，
 *    手机上还会被浏览器弹成一条横幅（用户 2026-10-17：「清掉用自己弹窗，不要系统级」）。
 */
async function remove(d: AiDoc) {
  const ok = await askConfirm({
    title: `删掉「${d.name}」？`,
    body: [{t: '它的历史版本会一起删，找不回来。', tone: 'warn'}],
    okText: '删掉',
    danger: true
  })
  if (!ok) return
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
  const ok = await askConfirm({
    title: `把「${v.name}」恢复到这个版本？`,
    body: [{t: `${bjTime(v.savedAt)} 那一版`, tone: 'num'}, '现在的内容会先留一版历史，恢复错了还能回去。'],
    okText: '恢复'
  })
  if (!ok) return
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
      <h2>AI 提示词 <span class="tag">分析预测 + 日记润色（+ 提炼留档）</span></h2>

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
                : '知识库模块已删，这几份只留档、不参与拼装'
            "
          >
            知识库提炼（留档）{{ extracts.filter(d => d.enabled).length }} 份 ·
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
      <button class="ghost tiny add" @click="openTonePicker">
        + 新建分析预测
      </button>

      <!--
        新建：先挑**语气**（2026-10-12 用户：「在新建里面加，这几种语气」）。
        建出来的这份**只有「# 输出」那一节** —— 正文那份不用动，打勾的两份按顺序拼。
      -->
      <div v-if="toneOpen" class="new-tone">
        <label class="nt-row">
          <span class="nt-label">语气</span>
          <SelectPick v-model="toneId" :options="toneOptions" aria-label="语气模板" />
        </label>
        <label class="nt-row">
          <span class="nt-label">名字</span>
          <input v-model="toneName" class="nt-input" type="text" spellcheck="false" />
        </label>
        <p class="nt-hint">{{ tone?.hint }}</p>
        <div class="nt-actions">
          <button class="ghost tiny" @click="toneOpen = false">取消</button>
          <button class="tiny" @click="createTone">创建</button>
        </div>
      </div>

      <!-- 知识库提炼（模块已删，数据留在这儿备查） -->
      <h3 class="group">
        知识库提炼 <span class="dim">模块已删 —— 这几份留着备查，不再参与拼装</span>
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
          没有提炼提示词（知识库模块已删，这里空着也不影响任何功能）
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

      <!-- 日记润色（2026-10-18）-->
      <h3 class="group">
        日记润色 <span class="dim">日记页那颗 ✨ 让 AI 改写正文时用</span>
      </h3>
      <ul class="docs">
        <li
          v-for="d in polishes"
          :key="d.id"
          :class="{off: !d.enabled, on: current?.id === d.id}"
          @click="openDoc(d)"
        >
          <label class="pick" title="打勾才会生效" @click.stop>
            <input type="checkbox" :checked="d.enabled" @change="toggle(d)" />
          </label>
          <span class="name">{{ d.name }}</span>
          <span class="meta">{{ d.content.length }} 字</span>
          <span class="arrow">›</span>
        </li>
        <li v-if="!polishes.length" class="empty">
          还没有润色提示词 —— 日记里点 ✨ 会先按默认那份种一条进来
        </li>
      </ul>
      <button class="ghost tiny add" @click="addDoc('polish')">
        + 新建润色提示词
      </button>
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
          <span class="tag">只含提示词，不含行情</span>
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

/* ---------------- 新建「分析预测」里的语气选择 ---------------- */

/*
 * ★ 2026-10-12（用户：「在新建里面加，这几种语气」）：
 * 点「+ 新建分析预测」先在这儿挑语气 —— 建出来的那份**只有「# 输出」那一节**，
 * 正文那份（分析预测）不用动，打勾的两份按顺序拼起来。
 */
.new-tone {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 10px 11px;
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
  font-size: 13px;
}

.nt-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nt-label {
  flex: none;
  width: 28px;
  color: var(--muted);
  font-size: 12px;
}

/* 下拉壳（`SelectPick` 的 `.pk`）和输入框各占剩下的整行 */
.nt-row .pk,
.nt-input {
  flex: 1;
  min-width: 0;
}

.nt-input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.nt-hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.nt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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
