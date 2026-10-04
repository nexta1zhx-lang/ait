import {query} from './client'

/**
 * 知识库标签模板 —— **全部由我自己维护**（`/knowledge` 页面上能加、改名、删、调顺序）。
 *
 * 作用：案例标签只能从这份清单里挑。
 *   · AI 提炼时清单直接写进 prompt
 *   · AI 返回后代码再过滤一遍（自造的词丢掉）
 *   · 弹窗里就列这些，点一下勾上，没有「自己输一个新标签」的入口
 *
 * ⚠️ **代码里没有任何写死的默认模板**。
 *   删光了就是真的空了（AI 不会再给标签，也不会自己蹦回默认值）——
 *   想要什么标签完全由我在页面上定。
 *   空表的初始内容靠一次性的迁移 / 手工添加，不靠程序播种。
 */

/** 标签最多几个字（太长的会挤爆卡片） */
const MAX_NAME = 12

export interface TagTemplate {
  id: number
  name: string
  sort: number
}

interface Raw {
  id: string
  name: string
  sort: number
}

const map = (r: Raw): TagTemplate => ({
  id: Number(r.id),
  name: r.name,
  sort: r.sort
})

/** 全部模板，按我排的顺序 */
export async function listTagTemplates(
  userId: number | null
): Promise<TagTemplate[]> {
  const rows = await query<Raw>(
    'SELECT id, name, sort FROM tag_templates WHERE user_id = $1 ORDER BY sort, id',
    [userId]
  )
  return rows.map(map)
}

/**
 * 当前模板里的标签名（AI 过滤 + 弹窗 chip 用）。
 *
 * 空就是空 —— 不做任何“兜底默认”。
 */
export async function loadTagTemplates(
  userId: number | null
): Promise<string[]> {
  return (await listTagTemplates(userId)).map(r => r.name)
}

function clean(name: unknown): string {
  const s = String(name ?? '').trim()
  if (!s) throw new Error('标签不能为空')
  if (s.length > MAX_NAME) throw new Error(`标签最多 ${MAX_NAME} 个字`)
  return s
}

export async function addTagTemplate(
  userId: number | null,
  name: unknown
): Promise<TagTemplate> {
  const v = clean(name)
  const exists = await query<{id: string}>(
    'SELECT id FROM tag_templates WHERE user_id = $1 AND name = $2',
    [userId, v]
  )
  if (exists.length) throw new Error(`「${v}」已经在模板里了`)

  const row = await query<Raw>(
    `INSERT INTO tag_templates (user_id, name, sort)
     VALUES ($1, $2, COALESCE((SELECT max(sort) + 1 FROM tag_templates WHERE user_id = $1), 0))
     RETURNING id, name, sort`,
    [userId, v]
  )
  return map(row[0])
}

export async function renameTagTemplate(
  userId: number | null,
  id: number,
  name: unknown
): Promise<TagTemplate | null> {
  const v = clean(name)
  const dup = await query<{id: string}>(
    'SELECT id FROM tag_templates WHERE user_id = $1 AND name = $2 AND id <> $3',
    [userId, v, id]
  )
  if (dup.length) throw new Error(`「${v}」已经在模板里了`)

  const rows = await query<Raw>(
    'UPDATE tag_templates SET name = $3 WHERE id = $2 AND user_id = $1 RETURNING id, name, sort',
    [userId, id, v]
  )
  return rows.length ? map(rows[0]) : null
}

export async function deleteTagTemplate(
  userId: number | null,
  id: number
): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM tag_templates WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}

/**
 * 上下挪一格。
 *
 * 不用唯一约束的 sort，直接用「和邻居换 sort」——
 * 播种时可能有并列值，交换法在任何情况下都能正确换位。
 */
export async function moveTagTemplate(
  userId: number | null,
  id: number,
  dir: 'up' | 'down'
): Promise<boolean> {
  const all = await listTagTemplates(userId)
  const i = all.findIndex(t => t.id === id)
  if (i === -1) return false
  const j = dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= all.length) return false

  const a = all[i]
  const b = all[j]
  // 并列时先拉开，保证交换真的换位
  const sa =
    a.sort === b.sort ? (dir === 'up' ? b.sort - 1 : b.sort + 1) : b.sort
  const sb = a.sort === b.sort ? b.sort : a.sort
  await query(
    'UPDATE tag_templates SET sort = $3 WHERE id = $2 AND user_id = $1',
    [userId, a.id, sa]
  )
  await query(
    'UPDATE tag_templates SET sort = $3 WHERE id = $2 AND user_id = $1',
    [userId, b.id, sb]
  )
  return true
}
