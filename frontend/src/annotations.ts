/**
 * 币种标注的**前端那份状态**（用户 2026-10-20）。
 *
 * 跟 `pins.ts` / `blacklist.ts` 一个路数：数据放模块作用域（切页不丢），
 * 拉回来按新鲜度窗口 + 请求序号防串，多个页面共用同一份。
 *
 * 三份数据：
 *   · `annotationTags`     —— 标签词表（弹窗里勾选 / 维护）；
 *   · `latestAnnotations`  —— base → 最新一条（行情列表那行标签 + 顶部按钮亮不亮）；
 *   · `annotationHistory`  —— base → 全部历史（K 线底部那块）。
 *
 * ⚠️ 写操作先**就地改缓存**再后台重拉：保存后横幅 / 行情列表要立刻变，
 *    不能让用户等一次往返。后台重拉用请求序号兜住，旧响应不会把新数据盖回去。
 */
import {ref} from 'vue'
import {
  createAnnotationTag,
  createSymbolAnnotation,
  deleteAnnotationTag,
  deleteSymbolAnnotation,
  fetchAnnotationHistory,
  fetchAnnotationSummary,
  updateAnnotationTag,
  type AnnotationTag,
  type SymbolAnnotation
} from './api'
import {ago} from './format'

/** 标签词表（按维护顺序） */
export const annotationTags = ref<AnnotationTag[]>([])

/* ---------------- 三色系标签（2026-10-20） ---------------- */

/**
 * 标签的色系（用户 2026-10-20：「改为三色系，扁平化 / 无边框」）。
 *
 * 颜色存在 `annotation_tags.color` 里，就存下面这三个值：
 *   · 红 `#e35561` —— 风险类（多空双爆 / 貔貅 / 杀猪盘 / 大单砸盘 / 死水 / 易插针 / 爆仓预警）
 *   · 绿 `#5dc887` —— 机会类（爆量 / 主升浪 / V反 / 突破 / 龙头）
 *   · 黄 `#f6d758` —— 观察类（蓄势 / 异动 / 洗盘 / 变盘）
 * ⚠️ 不在三色里的老颜色（以前那套 10 色调色板）一律当**灰**（「其它」那档）。
 */
export const TAG_FAMILY_COLORS = {
  red: '#e35561',
  green: '#5dc887',
  yellow: '#f6d758'
} as const

export type TagFamily = keyof typeof TAG_FAMILY_COLORS | 'gray'

/** 色系 → 展示名（弹窗里分组用） */
export const TAG_FAMILY_LABEL: Record<TagFamily, string> = {
  red: '红色系',
  green: '绿色系',
  yellow: '黄色系',
  gray: '其它'
}

/**
 * 色系的**皮肤**：同色系深底 + 亮字，扁平无边框（照着用户给的参照图取的色）。
 *
 * 灰那档用一层极淡的白（`rgba(255,255,255,.07)`）：它压在行情行的暖色底、
 * 弹窗的冷色底上都成立，不用另配两套主题色。
 *
 * ⚠️ 红色 2026-10-20 用户：「红色的背景色加一点深度」—— 底从 `#392127` 压到
 *    `#4a2029`（更沉、更红），亮字还是 `#e35561`，对比反而更清楚。
 */
const FAMILY_SKIN: Record<TagFamily, {bg: string; fg: string}> = {
  red: {bg: '#4a2029', fg: '#e35561'},
  green: {bg: '#20362e', fg: '#5dc887'},
  yellow: {bg: '#3c3925', fg: '#f6d758'},
  gray: {bg: 'rgba(255, 255, 255, 0.07)', fg: '#9aa0a8'}
}

/**
 * 内置的色系归属：老数据 / 后端还没写颜色的标签，按名字兜底。
 *
 * 用户 2026-10-20 给的名单，顺序照抄（红 7 / 绿 5 / 黄 4）。
 * 名单外的标签 → 灰（「其它」那档），用户也可以在「管理标签」里改成红 / 绿 / 黄。
 */
const NAME_FAMILY: Record<string, TagFamily> = {
  多空双爆: 'red',
  貔貅: 'red',
  杀猪盘: 'red',
  大单砸盘: 'red',
  死水: 'red',
  易插针: 'red',
  爆仓预警: 'red',
  爆量: 'green',
  主升浪: 'green',
  V反: 'green',
  突破: 'green',
  龙头: 'green',
  蓄势: 'yellow',
  异动: 'yellow',
  洗盘: 'yellow',
  变盘: 'yellow'
}

/** `#rrggbb` → 色系；不是三色之一的（含空串）返回空 */
export function familyOfColor(raw: unknown): TagFamily | null {
  const c = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (c === TAG_FAMILY_COLORS.red) return 'red'
  if (c === TAG_FAMILY_COLORS.green) return 'green'
  if (c === TAG_FAMILY_COLORS.yellow) return 'yellow'
  return null
}

/**
 * 标签名 → 色系。
 *
 * 先看词表里存的颜色（用户自己归的类最算数），再看内置名单，最后兜到灰。
 * 词表里查不到（比如词表还没拉到 / 标签已被删）就按名字走内置名单。
 */
export function tagFamilyOf(rawName: string): TagFamily {
  const name = String(rawName ?? '').trim()
  const found = annotationTags.value.find(t => t.name === name)
  const byColor = familyOfColor(found?.color)
  if (byColor) return byColor
  return NAME_FAMILY[name] ?? 'gray'
}

/**
 * 标签胶囊的内联样式：**扁平无边框**，只有一层同色系深底 + 亮字。
 *
 * 三个地方共用：行情行内标签、弹窗里的标签、K 线底部历史标签。
 * `active` 只给弹窗用（选中时字重 + 一圈本色细环，见 `AnnotationSheet` 的 CSS）。
 */
export function tagChipStyle(rawName: string): Record<string, string> {
  const skin = FAMILY_SKIN[tagFamilyOf(rawName)]
  return {color: skin.fg, background: skin.bg}
}

/** 「管理标签」里那枚**当前色系**的小圆点用什么色（灰 = 还没归类，给一层淡白） */
export function tagFamilyDotColor(rawName: string): string {
  const family = tagFamilyOf(rawName)
  return family === 'gray'
    ? 'rgba(255, 255, 255, 0.16)'
    : FAMILY_SKIN[family].fg
}
/** base（大写）→ 最新一条 */
export const latestAnnotations = ref<Record<string, SymbolAnnotation>>({})
/** base（大写）→ 全部历史（新的在前） */
export const annotationHistory = ref<Record<string, SymbolAnnotation[]>>({})
/**
 * 「现在」—— 每分钟推一下。
 *
 * `ago()` 自己读 `Date.now()`，不会因为时间流逝触发重渲染；模板里通过
 * `agoText()` 引用这个 ref，一分钟一次就能让「3 分钟前」自己走。
 */
export const annotationClock = ref(Date.now())

if (typeof window !== 'undefined') {
  window.setInterval(() => {
    annotationClock.value = Date.now()
  }, 60_000)
}

/** 汇总（每个币最新一条）的新鲜度窗口 —— 跟置顶 / 黑名单一个量级 */
const SUMMARY_FRESH_MS = 20_000
/** 某个币历史的缓存时间；保存 / 删除后走 force 绕过 */
const HISTORY_FRESH_MS = 10_000

let summaryAt = 0
let summaryInFlight: Promise<void> | null = null
/**
 * 汇总的「本地改过几次」。
 *
 * 拉汇总的请求可能在保存之前就发出去了、保存之后才回来 —— 那份里没有新标注。
 * 每次本地写操作 +1，回来时对不上就整份丢掉，别让旧数据把刚写的盖回去。
 */
let summaryRevision = 0

const historySeq = new Map<string, number>()
const historyAt = new Map<string, number>()
const historyInFlight = new Map<string, Promise<void>>()

/** 币种写法归一（`btc` / `BTC/USDT:USDT` / `BTCUSDT` → `BTC`） */
export function annotationBaseOf(raw: string): string {
  let s = String(raw ?? '')
    .trim()
    .toUpperCase()
  if (s.includes('/')) s = s.split('/')[0] ?? ''
  s = s.replace(/[^A-Z0-9]/g, '')
  if (s.endsWith('USDT') && s.length > 4) s = s.slice(0, -4)
  return s
}

/* ---------------- 读 ---------------- */

/**
 * 拉「每个币最新一条」+ 标签词表（行情列表 + 顶部按钮亮态用）。
 * @param force 绕过新鲜度窗口（写操作之后对齐用）
 */
export async function ensureAnnotations(force = false): Promise<void> {
  if (!force && Date.now() - summaryAt < SUMMARY_FRESH_MS) return
  if (summaryInFlight) return summaryInFlight

  const rev = summaryRevision
  const req = fetchAnnotationSummary().then(r => {
    // 本地已经改过（保存 / 改名 / 删标签）⇒ 这份是旧的，整份丢掉
    if (rev !== summaryRevision) return
    if (Array.isArray(r.tags)) annotationTags.value = r.tags
    if (r.latest && typeof r.latest === 'object') {
      latestAnnotations.value = r.latest
    }
    summaryAt = Date.now()
  })
  summaryInFlight = req
  try {
    await req
  } finally {
    if (summaryInFlight === req) summaryInFlight = null
  }
}

/**
 * 拉某个币的全部历史（K 线底部用）。
 * @param force 绕过缓存（保存 / 删除后立刻对齐）
 */
export async function loadAnnotationHistory(
  rawBase: string,
  force = false
): Promise<void> {
  const base = annotationBaseOf(rawBase)
  if (!base) return
  if (!force && Date.now() - (historyAt.get(base) ?? 0) < HISTORY_FRESH_MS) {
    return
  }
  const running = historyInFlight.get(base)
  if (running && !force) return running

  const seq = (historySeq.get(base) ?? 0) + 1
  historySeq.set(base, seq)
  const req = fetchAnnotationHistory(base).then(r => {
    // 期间又发过一发新的（或者本地写过）⇒ 这份作废
    if (historySeq.get(base) !== seq) return
    if (Array.isArray(r.tags)) annotationTags.value = r.tags
    const entries = Array.isArray(r.entries) ? r.entries : []

    const nextHistory = {...annotationHistory.value}
    if (entries.length) nextHistory[base] = entries
    else delete nextHistory[base]
    annotationHistory.value = nextHistory

    const nextLatest = {...latestAnnotations.value}
    if (entries.length) nextLatest[base] = entries[0]!
    else delete nextLatest[base]
    latestAnnotations.value = nextLatest
    historyAt.set(base, Date.now())
  })
  historyInFlight.set(base, req)
  try {
    await req
  } finally {
    if (historyInFlight.get(base) === req) historyInFlight.delete(base)
  }
}

/** 这个币最新一条（没有 → null） */
export function annotationOf(rawBase: string): SymbolAnnotation | null {
  return latestAnnotations.value[annotationBaseOf(rawBase)] ?? null
}

/** 这个币的全部历史（没有 → 空数组） */
export function historyOf(rawBase: string): SymbolAnnotation[] {
  return annotationHistory.value[annotationBaseOf(rawBase)] ?? []
}

/** 「3 分钟前」—— 引用 `annotationClock` 让时间自己走 */
export function agoText(at: string): string {
  annotationClock.value // 建立响应式依赖，别删
  return ago(at)
}

/** 弹窗打开时确保词表已到（空词表 / force 才真发请求） */
export async function ensureAnnotationTags(force = false): Promise<void> {
  if (!force && annotationTags.value.length) return
  await ensureAnnotations(force)
}

/* ---------------- 写 ---------------- */

/**
 * 追加一条标注。
 *
 * 先就地写进 `latestAnnotations` / `annotationHistory`（有缓存才写），
 * 再后台强制重拉这个币 —— 横幅、行情列表、历史区当场就能看到。
 */
export async function addSymbolAnnotation(input: {
  base: string
  tags: string[]
  note: string
}): Promise<SymbolAnnotation> {
  const base = annotationBaseOf(input.base)
  const r = await createSymbolAnnotation({
    base,
    tags: input.tags,
    note: input.note
  })
  const entry = r.entry

  summaryRevision++

  const nextLatest = {...latestAnnotations.value}
  nextLatest[base] = entry
  latestAnnotations.value = nextLatest

  const current = annotationHistory.value[base]
  if (current) {
    const nextHistory = {...annotationHistory.value}
    nextHistory[base] = [entry, ...current.filter(e => e.id !== entry.id)]
    annotationHistory.value = nextHistory
  }
  historyAt.set(base, Date.now())

  void loadAnnotationHistory(base, true).catch(() => undefined)
  void ensureAnnotations(true).catch(() => undefined)
  return entry
}

/** 删一条（横幅 / 历史 / 行情列表一起回退） */
export async function removeSymbolAnnotation(
  id: number,
  rawBase: string
): Promise<void> {
  const base = annotationBaseOf(rawBase)
  await deleteSymbolAnnotation(id)
  summaryRevision++

  const current = annotationHistory.value[base]
  const left = current ? current.filter(e => e.id !== id) : null
  if (left) {
    const nextHistory = {...annotationHistory.value}
    if (left.length) nextHistory[base] = left
    else delete nextHistory[base]
    annotationHistory.value = nextHistory
  }

  const nextLatest = {...latestAnnotations.value}
  if (nextLatest[base]?.id === id) {
    const fallback = left?.[0]
    if (fallback) nextLatest[base] = fallback
    else delete nextLatest[base]
  }
  latestAnnotations.value = nextLatest
  historyAt.set(base, Date.now())

  void loadAnnotationHistory(base, true).catch(() => undefined)
  void ensureAnnotations(true).catch(() => undefined)
}

/** 新增标签（返回新标签，弹窗可以顺手选中它） */
export async function addAnnotationTag(name: string): Promise<AnnotationTag> {
  const r = await createAnnotationTag(name)
  // 词表由这一发响应说了算；把可能在路上的旧汇总作废
  summaryRevision++
  annotationTags.value = r.tags
  return r.tag
}

/**
 * 改标签名 / 色系。
 *
 * 改名：词表 + 缓存里所有历史 / 最新条目一起改（后端也会改历史）。
 * 改色：只动词表里那条记录 —— 历史里存的是名字，颜色按名字现查（见 `tagFamilyOf`）。
 * ⚠️ 颜色只能是 `TAG_FAMILY_COLORS` 里的三个值（或者灰：留空 / 老调色板色）。
 */
export async function updateTag(
  id: number,
  patch: {name?: string; color?: string}
): Promise<AnnotationTag> {
  const old = annotationTags.value.find(t => t.id === id)?.name ?? ''
  const r = await updateAnnotationTag(id, patch)
  summaryRevision++
  annotationTags.value = r.tags
  if (old && old !== r.tag.name) rewriteTagEverywhere(old, r.tag.name)
  return r.tag
}

/** 删标签：词表更新；历史标注里的旧名字保留 */
export async function removeTag(id: number): Promise<void> {
  const r = await deleteAnnotationTag(id)
  summaryRevision++
  annotationTags.value = r.tags
}

/** 把缓存里所有 `oldName` 换成 `newName`（标签改名用） */
function rewriteTagEverywhere(oldName: string, newName: string): void {
  const rewrite = (a: SymbolAnnotation): SymbolAnnotation =>
    a.tags.includes(oldName)
      ? {...a, tags: a.tags.map(t => (t === oldName ? newName : t))}
      : a

  let changed = false
  const nextLatest = {...latestAnnotations.value}
  for (const [base, a] of Object.entries(nextLatest)) {
    const b = rewrite(a)
    if (b !== a) {
      nextLatest[base] = b
      changed = true
    }
  }
  if (changed) latestAnnotations.value = nextLatest

  changed = false
  const nextHistory = {...annotationHistory.value}
  for (const [base, list] of Object.entries(nextHistory)) {
    let itemChanged = false
    const next = list.map(a => {
      const b = rewrite(a)
      if (b !== a) itemChanged = true
      return b
    })
    if (itemChanged) {
      nextHistory[base] = next
      changed = true
    }
  }
  if (changed) annotationHistory.value = nextHistory
}
