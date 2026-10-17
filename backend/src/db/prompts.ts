/**
 * AI 提示词文档 —— 「角色设定 / 规则正文」全部存这里（可多份、可启停、可排序）。
 *
 * 设计意图：
 *   · 我可以同时存好几份规则 / 角色（不同风格、不同版本），用 enabled 切换生效的
 *   · 每次保存都会往 `ai_doc_versions` 留一版，可以看旧文、可以回滚
 *   · 拼 prompt 时只读「启用的」，按 kind 分组、按 sort 排序
 *
 * 每份文档的 `name` 会作为小标题写进 prompt（`## 文档名`），
 * 所以命名尽量让人（和模型）一眼知道自己读的是哪一节。
 */
import {query, queryOne} from './client'

export type DocKind = 'role' | 'rule' | 'extract' | 'predict' | 'polish'

/** 把数据库里读回来的 kind 收敛成已知的几种之一（认不出的当规则正文） */
function asKind(v: unknown): DocKind {
  return v === 'role' || v === 'extract' || v === 'predict' || v === 'polish'
    ? (v as DocKind)
    : 'rule'
}

export interface AiDoc {
  id: number
  kind: DocKind
  name: string
  content: string
  enabled: boolean
  sort: number
  updatedAt: string
}

export interface AiDocVersion {
  id: number
  docId: number
  name: string
  kind: DocKind
  content: string
  chars: number
  savedAt: string
}

interface DocRow {
  id: string | number
  kind: string
  name: string
  content: string
  enabled: boolean
  sort: number
  updated_at: Date
}

function mapDoc(r: DocRow): AiDoc {
  return {
    id: Number(r.id),
    kind: asKind(r.kind),
    name: r.name,
    content: r.content,
    enabled: r.enabled,
    sort: Number(r.sort),
    updatedAt: new Date(r.updated_at).toISOString()
  }
}

/** 全部文档（UI 列表用，带正文） */
export async function listDocs(): Promise<AiDoc[]> {
  const rows = await query<DocRow>(
    `SELECT id, kind, name, content, enabled, sort, updated_at
       FROM ai_docs
      ORDER BY kind DESC, sort, id`
  )
  return rows.map(mapDoc)
}

export async function getDoc(id: number): Promise<AiDoc | null> {
  const row = await queryOne<DocRow>(
    `SELECT id, kind, name, content, enabled, sort, updated_at
       FROM ai_docs WHERE id = $1`,
    [id]
  )
  return row ? mapDoc(row) : null
}

/** 新建一份文档（新建也留一版历史，方便看「一开始长啥样」） */
export async function createDoc(input: {
  kind: DocKind
  name: string
  content?: string
}): Promise<AiDoc> {
  const row = await queryOne<DocRow>(
    `INSERT INTO ai_docs (kind, name, content, sort)
     VALUES ($1, $2, $3, COALESCE((SELECT max(sort) + 1 FROM ai_docs WHERE kind = $1), 0))
     RETURNING id, kind, name, content, enabled, sort, updated_at`,
    [input.kind, input.name.trim() || '未命名', input.content ?? '']
  )
  const doc = mapDoc(row as DocRow)
  await snapshot(doc)
  return doc
}

/**
 * 改一份文档。
 *
 * 只要正文/名字真的变了，就先把**改动后**的内容存进历史表
 * （这样「保存一次 = 一条历史」，回滚就是把它写回去）。
 */
export async function updateDoc(
  id: number,
  patch: {
    kind?: DocKind
    name?: string
    content?: string
    enabled?: boolean
    sort?: number
  }
): Promise<AiDoc | null> {
  const before = await getDoc(id)
  if (!before) return null

  const next = {
    kind: patch.kind ?? before.kind,
    name: (patch.name ?? before.name).trim() || before.name,
    content: patch.content ?? before.content,
    enabled: patch.enabled ?? before.enabled,
    sort: patch.sort ?? before.sort
  }

  const row = await queryOne<DocRow>(
    `UPDATE ai_docs
        SET kind = $2, name = $3, content = $4, enabled = $5, sort = $6,
            updated_at = now()
      WHERE id = $1
      RETURNING id, kind, name, content, enabled, sort, updated_at`,
    [id, next.kind, next.name, next.content, next.enabled, next.sort]
  )
  const doc = mapDoc(row as DocRow)

  const contentChanged =
    doc.content !== before.content ||
    doc.name !== before.name ||
    doc.kind !== before.kind
  if (contentChanged) await snapshot(doc)
  return doc
}

export async function deleteDoc(id: number): Promise<boolean> {
  // RETURNING 不能少：不然 rows 是空的，会被当成「没删到」而返回 404
  const rows = await query(`DELETE FROM ai_docs WHERE id = $1 RETURNING id`, [
    id
  ])
  return rows.length > 0
}

/** 把某份文档的当前内容存进历史表 */
async function snapshot(doc: AiDoc): Promise<void> {
  await query(
    `INSERT INTO ai_doc_versions (doc_id, kind, name, content, chars)
     VALUES ($1, $2, $3, $4, $5)`,
    [doc.id, doc.kind, doc.name, doc.content, doc.content.length]
  )
}

/** 某份文档的历史版本（新的在前，不带正文，省流量） */
export async function listVersions(
  docId: number,
  limit = 30
): Promise<Omit<AiDocVersion, 'content'>[]> {
  const rows = await query<{
    id: string | number
    doc_id: string | number
    name: string
    kind: string
    chars: number
    saved_at: Date
  }>(
    `SELECT id, doc_id, name, kind, chars, saved_at
       FROM ai_doc_versions
      WHERE doc_id = $1
      ORDER BY saved_at DESC, id DESC
      LIMIT $2`,
    [docId, limit]
  )
  return rows.map(r => ({
    id: Number(r.id),
    docId: Number(r.doc_id),
    name: r.name,
    kind: asKind(r.kind),
    chars: Number(r.chars),
    savedAt: new Date(r.saved_at).toISOString()
  }))
}

/** 看某一版历史的具体内容 */
export async function getVersion(
  versionId: number
): Promise<AiDocVersion | null> {
  const row = await queryOne<{
    id: string | number
    doc_id: string | number
    name: string
    kind: string
    content: string
    chars: number
    saved_at: Date
  }>(
    `SELECT id, doc_id, name, kind, content, chars, saved_at
       FROM ai_doc_versions WHERE id = $1`,
    [versionId]
  )
  if (!row) return null
  return {
    id: Number(row.id),
    docId: Number(row.doc_id),
    name: row.name,
    kind: asKind(row.kind),
    content: row.content,
    chars: Number(row.chars),
    savedAt: new Date(row.saved_at).toISOString()
  }
}

/** 回滚到某一版（会把「回滚后」的内容再存一版，历史不会丢） */
export async function restoreVersion(versionId: number): Promise<AiDoc | null> {
  const v = await getVersion(versionId)
  if (!v) return null
  return updateDoc(v.docId, {
    kind: v.kind,
    name: v.name,
    content: v.content
  })
}

/**
 * 拼 prompt 要用的：**启用的**文档，按 kind 分组拼好。
 *
 * role → 角色设定（开单分析）；rule → 规则正文；predict → 分析预测；
 * polish → 日记润色；extract → 知识库提炼（模块已删，数据保留、不再拼装）。
 * 返回的顺序就是拼接顺序。几块互不干扰，各自拼各自的。
 */
/**
 * **日记润色**的默认提示词（用户 2026-10-18：「提示词放在数据库中，写的间距小一点，
 * 可以加符号」）。
 *
 * 库里一份都没有时种这一份进去 —— 之后就在「我的 → AI 提示词」里改，代码不再兜底。
 * ⚠️ 写紧凑一点（一行一条，不要空行隔开），在提示词页面里一眼能看完。
 */
export const DEFAULT_POLISH_PROMPT = `你是中文交易日记的编辑，只做写法上的整理，不改事实。
必须遵守：
1. 事实原样保留：币种、时间、价格、数量、盈亏、方向、情绪，一个字都不改；用户没写的数字绝不编。
2. 不加交易建议、不加评价、不灌鸡汤，不替用户下结论。
3. 不要前言后语（不写「好的」「以下是整理后的版本」），直接输出整理后的正文。
4. 口语化、短句，像人在本子上写；可以分段，可以用 \`-\` 或 \`1.\` 列表。
5. 允许用符号帮助阅读：✅ ❌ ⚠️ ⬆ ⬇ 🔴 🟢 之类都可以，但别堆砌，一条一个就够。
6. 篇幅跟原文相当，最多 1.6 倍；原文只有一两句就保持一两句。
7. 用 Markdown（加粗、列表、空行分段），不要代码块，不要 # 标题。`

/** 没有「日记润色」提示词时种一份默认的（只种一次） */
export async function ensurePolishDoc(): Promise<void> {
  try {
    const row = await queryOne<{n: string}>(
      `SELECT count(*)::text AS n FROM ai_docs WHERE kind = 'polish'`
    )
    if (Number(row?.n ?? 0) > 0) return
    await createDoc({kind: 'polish', name: '日记润色', content: DEFAULT_POLISH_PROMPT})
  } catch {
    /* 种不进去不影响主流程：润色那条路会拿到空提示词，`polishText` 会报错让人去写 */
  }
}

export async function getEnabledDocs(): Promise<{
  role: AiDoc[]
  rule: AiDoc[]
  extract: AiDoc[]
  predict: AiDoc[]
  polish: AiDoc[]
  updatedAt: string | null
}> {
  const rows = await query<DocRow>(
    `SELECT id, kind, name, content, enabled, sort, updated_at
       FROM ai_docs
      WHERE enabled = TRUE AND content <> ''
      ORDER BY kind DESC, sort, id`
  )
  const docs = rows.map(mapDoc)
  const pick = (k: DocKind) => docs.filter(d => d.kind === k)
  const times = docs.map(d => d.updatedAt).sort()
  return {
    role: pick('role'),
    rule: pick('rule'),
    extract: pick('extract'),
    predict: pick('predict'),
    polish: pick('polish'),
    updatedAt: times.length ? times[times.length - 1] : null
  }
}
