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

/**
 * 标签可选颜色（跟后端 `db/annotations.ts` 的 `TAG_COLORS` 保持同一套）。
 *
 * 前端用它画：行情行内彩色标签、弹窗里选中 / 未选中的标签、历史区的标签，
 * 以及「管理标签」最底下那个颜色圆圈的快捷选项。
 */
export const TAG_COLORS = [
  '#f07178', // 红
  '#f0b429', // 黄
  '#72d6a0', // 绿
  '#7aa2f7', // 蓝
  '#c792ea', // 紫
  '#e08aa8', // 粉
  '#ff9e64', // 橙
  '#4dd0e1', // 青
  '#a3be8c', // 橄榄
  '#d3b583' // 主题金
] as const

/** 标签名的兜底色：词表里删掉的旧标签 / 颜色为空时按名字散列到调色板 */
function fallbackTagColor(name: string): string {
  let h = 0
  const s = String(name ?? '')
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0
  }
  return TAG_COLORS[h % TAG_COLORS.length]!
}

function hexRgb(hex: string): {r: number; g: number; b: number} {
  const s = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : 'd3b583'
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16)
  }
}

/** 标签名 → 颜色（词表里有就用词表的，没有就按名字散列一个） */
export function tagColorOf(rawName: string): string {
  const name = String(rawName ?? '')
  const found = annotationTags.value.find(t => t.name === name)
  const c = String(found?.color ?? '').trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(c) ? c : fallbackTagColor(name)
}

/**
 * 标签胶囊的内联样式：淡色底 + 本色字 + 半透明描边。
 *
 * 不用 `color-mix()` —— 安卓 System WebView 不一定算得出来（见 style.css 里的提醒）。
 * `active` = 这个标签在弹窗里被选中：底色更深、描边更实。
 */
export function tagChipStyle(
  rawName: string,
  active = false
): Record<string, string> {
  const color = tagColorOf(rawName)
  const {r, g, b} = hexRgb(color)
  const alpha = active ? 0.3 : 0.13
  const line = active ? 0.75 : 0.38
  return {
    color,
    background: `rgba(${r}, ${g}, ${b}, ${alpha})`,
    borderColor: `rgba(${r}, ${g}, ${b}, ${line})`
  }
}

/** 标签词表（按维护顺序） */
export const annotationTags = ref<AnnotationTag[]>([])
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
 * 改标签的名字 / 颜色。
 *
 * 改名：词表 + 缓存里所有历史 / 最新条目一起改（后端也会改历史）。
 * 改色：词表里的颜色换掉即可 —— 历史里存的是名字，颜色按词表现查。
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
