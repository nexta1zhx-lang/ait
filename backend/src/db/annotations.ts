/**
 * **币种标注**（用户 2026-10-20）。
 *
 * 用户：「加入新功能，标注模块……在合约行情界面会显示我对币种的标注数据，
 * 大概就是杂毛，异能等这些标签能显示标注的时间多长时间之前……在 K 线页面顶部
 * 右侧加一个按钮在测试旁第一个，点击之后可以底部弹窗可以打标签和描述，
 * 标签是可选的可维护的」。
 *
 * 两张表（建表见 `schema.ts`）：
 *   · `annotation_tags`    —— 标签词表（杂毛 / 异能 …），只用来给弹窗挑；
 *   · `symbol_annotations` —— 一条标注 = 币 + 当时选中的标签名 + 描述 + 时刻。
 *
 * 三条口径：
 *   · **按用户隔离**：所有读写都带 `user_id`，换设备看的是同一份；
 *   · 标签存**名字快照**：改名时把历史里的同名标签一起改（维护同一份词表），
 *     删除标签则不动历史 —— 历史是记录，词表只是可选集合；
 *   · 时间只由服务端 `now()` 决定，不接前端传的时间（标注 = 按下保存的那一刻）。
 */
import {query, queryOne} from './client'
import {normalizeBase} from './pins'

/** 一条标注最多选几个标签 */
export const MAX_TAGS_PER_ANNOTATION = 8
/** 单个标签名最多几个字 */
export const MAX_TAG_NAME = 12
/** 描述最多几个字 */
export const MAX_NOTE = 500
/** 每个用户最多维护几个标签 */
export const MAX_TAGS_PER_USER = 50
/** 某个币最多回多少条历史（再久远的也不该无限铺） */
export const MAX_HISTORY = 200

/**
 * **三色系**（用户 2026-10-20：「改为三色系」）。
 *
 * 标签颜色只认这三个值，前端按它画扁平胶囊：
 *   · 红 `#e35561` 风险类  · 绿 `#5dc887` 机会类  · 黄 `#f6d758` 观察类
 * 其它颜色（老调色板里的、用户自己填的）前端一律当**灰**（= 还没归类）。
 */
export const TAG_FAMILY_COLORS = {
  red: '#e35561',
  green: '#5dc887',
  yellow: '#f6d758'
} as const

/**
 * 第一次用标注功能时播种的标签词表 —— 三色系那 16 个（用户 2026-10-20 给的名单）。
 *
 * 只播一次（`users.annotation_tags_seeded_at`），用户删光后不会再长回来。
 */
export const DEFAULT_TAGS = [
  {name: '多空双爆', color: TAG_FAMILY_COLORS.red},
  {name: '貔貅', color: TAG_FAMILY_COLORS.red},
  {name: '杀猪盘', color: TAG_FAMILY_COLORS.red},
  {name: '大单砸盘', color: TAG_FAMILY_COLORS.red},
  {name: '死水', color: TAG_FAMILY_COLORS.red},
  {name: '易插针', color: TAG_FAMILY_COLORS.red},
  {name: '爆仓预警', color: TAG_FAMILY_COLORS.red},
  {name: '爆量', color: TAG_FAMILY_COLORS.green},
  {name: '主升浪', color: TAG_FAMILY_COLORS.green},
  {name: 'V反', color: TAG_FAMILY_COLORS.green},
  {name: '突破', color: TAG_FAMILY_COLORS.green},
  {name: '龙头', color: TAG_FAMILY_COLORS.green},
  {name: '蓄势', color: TAG_FAMILY_COLORS.yellow},
  {name: '异动', color: TAG_FAMILY_COLORS.yellow},
  {name: '洗盘', color: TAG_FAMILY_COLORS.yellow},
  {name: '变盘', color: TAG_FAMILY_COLORS.yellow}
] as const

/**
 * 老调色板：**只用来给「没指定颜色」的标签补一个占位色**（库里的 `color` 不能空）。
 *
 * ⚠️ 2026-10-20 起这些颜色前端不认（不在 `TAG_FAMILY_COLORS` 里 ⇒ 画成灰），
 *    用户想让它有颜色，就在「管理标签」里点红 / 绿 / 黄。
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

export interface AnnotationTag {
  id: number
  name: string
  /** #rrggbb（空串 = 还没挑，列表接口会补一个默认色） */
  color: string
}

export interface SymbolAnnotation {
  id: number
  /** 基础币（BTC，不带 /USDT） */
  base: string
  /** 标签名数组（如 ["杂毛","异能"]；空数组 = 只写了描述） */
  tags: string[]
  /** 描述（空串 = 只选了标签） */
  note: string
  /** 标注时刻（ISO） */
  at: string
}

/** base（大写）→ 最新一条标注 */
export type LatestAnnotations = Record<string, SymbolAnnotation>

interface AnnotationRow {
  id: string | number
  base: string
  tags: unknown
  note: string | null
  created_at: Date | string
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v)
}

/** 数据库里的 JSONB → 字符串数组（坏数据跳过，不让一条脏记录拖垮整页） */
function tagsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const raw of v) {
    if (typeof raw !== 'string') continue
    const s = raw.trim()
    if (s) out.push(s)
  }
  return out
}

function mapAnnotation(r: AnnotationRow): SymbolAnnotation {
  return {
    id: Number(r.id),
    base: String(r.base ?? '').toUpperCase(),
    tags: tagsOf(r.tags),
    note: r.note ?? '',
    at: iso(r.created_at)
  }
}

/**
 * 标签名归一：压掉多余空白、去首尾、限长。
 *
 * 空名字 / 超长直接报错（不悄悄截断）—— 弹窗里能立刻看到原因；
 * 空白折叠是为了防止「杂  毛」和「杂 毛」变成两个看起来一样的标签。
 */
function cleanTagName(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  if (!s) throw new Error('标签不能为空')
  if (s.length > MAX_TAG_NAME) throw new Error(`标签最多 ${MAX_TAG_NAME} 个字`)
  return s
}

/** 校验 + 去重（不区分大小写）+ 截到上限；坏条目跳过 */
function cleanTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    let name: string
    try {
      name = cleanTagName(raw)
    } catch {
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= MAX_TAGS_PER_ANNOTATION) break
  }
  return out
}

/** 颜色归一成小写 `#rrggbb`；不合法返回空串（调用方决定报错还是用默认色） */
function cleanColor(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(s) ? s : ''
}

/** 按顺序取一个默认色（标签多了会循环） */
function defaultColorAt(index: number): string {
  return TAG_COLORS[((index % TAG_COLORS.length) + TAG_COLORS.length) % TAG_COLORS.length]!
}

/**
 * 第一次列标签时播种默认词表。
 *
 * `ON CONFLICT DO NOTHING` 兜住并发（两个请求同时第一次进来也只会各插一份）；
 * 标记列写成 `WHERE ... IS NULL`，后到的那个不会把时间改成更晚的。
 */
async function ensureDefaultTags(userId: number): Promise<void> {
  const row = await queryOne<{seeded_at: Date | null}>(
    'SELECT annotation_tags_seeded_at AS seeded_at FROM users WHERE id = $1',
    [userId]
  )
  if (!row || row.seeded_at) return
  for (let i = 0; i < DEFAULT_TAGS.length; i++) {
    const t = DEFAULT_TAGS[i]!
    await query(
      `INSERT INTO annotation_tags (user_id, name, color, sort)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [userId, t.name, t.color, i]
    )
  }
  await query(
    `UPDATE users SET annotation_tags_seeded_at = now()
      WHERE id = $1 AND annotation_tags_seeded_at IS NULL`,
    [userId]
  )
}

/**
 * 这个用户的标签词表（按维护顺序）。
 *
 * 老标签（加颜色之前就存在的）`color` 是空串 —— 这里按顺序补一个调色板颜色并写回，
 * 保证前端永远拿得到能画出来的颜色；已有颜色的绝不覆盖。
 */
export async function listAnnotationTags(userId: number): Promise<AnnotationTag[]> {
  await ensureDefaultTags(userId)
  const rows = await query<{
    id: string | number
    name: string
    color: string | null
  }>(
    `SELECT id, name, color FROM annotation_tags
      WHERE user_id = $1
      ORDER BY sort, id`,
    [userId]
  )
  const out: AnnotationTag[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    let color = cleanColor(r.color)
    if (!color) {
      color = defaultColorAt(i)
      await query(
        `UPDATE annotation_tags SET color = $3
          WHERE id = $1 AND user_id = $2 AND (color = '' OR color IS NULL)`,
        [r.id, userId, color]
      )
    }
    out.push({id: Number(r.id), name: r.name, color})
  }
  return out
}

/**
 * 每个币**最新一条**标注 —— 合约行情列表用。
 *
 * `DISTINCT ON (base)` 配 `ORDER BY base, created_at DESC, id DESC`：
 * 同一个 `created_at`（同一毫秒连点两下）也不会挑错，id 更大的那条更新。
 */
export async function listLatestAnnotations(userId: number): Promise<LatestAnnotations> {
  const rows = await query<AnnotationRow>(
    `SELECT DISTINCT ON (base) id, base, tags, note, created_at
       FROM symbol_annotations
      WHERE user_id = $1
      ORDER BY base, created_at DESC, id DESC`,
    [userId]
  )
  const out: LatestAnnotations = {}
  for (const r of rows) {
    const a = mapAnnotation(r)
    out[a.base] = a
  }
  return out
}

/** 某个币的全部历史（新的在前）—— K 线底部那块用 */
export async function listSymbolAnnotations(
  userId: number,
  rawBase: unknown
): Promise<SymbolAnnotation[]> {
  const base = normalizeBase(rawBase)
  const rows = await query<AnnotationRow>(
    `SELECT id, base, tags, note, created_at
       FROM symbol_annotations
      WHERE user_id = $1 AND base = $2
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [userId, base, MAX_HISTORY]
  )
  return rows.map(mapAnnotation)
}

/**
 * 新建一条标注。
 *
 * ⚠️ 不接 id / 时间：这次只做「追加」，改历史 / 删除都走别的接口。
 * 提交上来的标签如果在词表里还没有，顺手补进去（正常前端只提交词表里选中的；
 * 补这一下是为了多端 / 旧客户端不会造出「词表里没有」的孤儿标签）。
 */
export async function saveSymbolAnnotation(
  userId: number,
  input: {base?: unknown; tags?: unknown; note?: unknown}
): Promise<SymbolAnnotation> {
  const base = normalizeBase(input.base)
  const tags = cleanTags(input.tags)
  const note = String(input.note ?? '')
    .trim()
    .slice(0, MAX_NOTE)
  if (!tags.length && !note) throw new Error('至少选一个标签或写一句描述')

  // 默认标签先播种，再补提交上来的（排序 / 颜色都不会因为先后顺序打架）
  await ensureDefaultTags(userId)
  const tagCount = await queryOne<{n: string}>(
    'SELECT count(*)::text AS n FROM annotation_tags WHERE user_id = $1',
    [userId]
  )
  let colorIndex = Number(tagCount?.n ?? 0)
  for (const name of tags) {
    await query(
      `INSERT INTO annotation_tags (user_id, name, color, sort)
       VALUES ($1, $2, $3,
               COALESCE((SELECT max(sort) + 1 FROM annotation_tags WHERE user_id = $1), 0))
       ON CONFLICT DO NOTHING`,
      [userId, name, defaultColorAt(colorIndex++)]
    )
  }

  const row = await queryOne<AnnotationRow>(
    `INSERT INTO symbol_annotations (user_id, base, tags, note)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id, base, tags, note, created_at`,
    [userId, base, JSON.stringify(tags), note]
  )
  if (!row) throw new Error('标注没写进去')
  return mapAnnotation(row)
}

/** 删一条（只能删自己的） */
export async function deleteSymbolAnnotation(
  userId: number,
  id: number
): Promise<boolean> {
  if (!Number.isFinite(id) || id <= 0) return false
  const rows = await query<{id: string}>(
    'DELETE FROM symbol_annotations WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}

/* ---------------- 标签词表维护 ---------------- */

/** 新增一个标签；重名（大小写不敏感）给一句人话。颜色不传就用调色板下一个。 */
export async function createAnnotationTag(
  userId: number,
  rawName: unknown,
  rawColor?: unknown
): Promise<{tag: AnnotationTag; tags: AnnotationTag[]}> {
  await ensureDefaultTags(userId)
  const name = cleanTagName(rawName)
  const wanted = String(rawColor ?? '').trim()
  const picked = wanted ? cleanColor(wanted) : ''
  if (wanted && !picked) throw new Error('颜色写法不对（要 #rrggbb）')
  const count = await queryOne<{n: string}>(
    'SELECT count(*)::text AS n FROM annotation_tags WHERE user_id = $1',
    [userId]
  )
  if (Number(count?.n ?? 0) >= MAX_TAGS_PER_USER) {
    throw new Error(`标签最多 ${MAX_TAGS_PER_USER} 个 —— 先删掉几个再加`)
  }
  const color = picked || defaultColorAt(Number(count?.n ?? 0))
  const row = await queryOne<{
    id: string | number
    name: string
    color: string | null
  }>(
    `INSERT INTO annotation_tags (user_id, name, color, sort)
     VALUES ($1, $2, $3,
             COALESCE((SELECT max(sort) + 1 FROM annotation_tags WHERE user_id = $1), 0))
     ON CONFLICT DO NOTHING
     RETURNING id, name, color`,
    [userId, name, color]
  )
  if (!row) throw new Error(`「${name}」已经有了`)
  return {
    tag: {
      id: Number(row.id),
      name: row.name,
      color: cleanColor(row.color) || color
    },
    tags: await listAnnotationTags(userId)
  }
}

/**
 * 改标签的**名字 / 颜色**（至少给一样）。
 *
 * 改名时**历史标注里的同名标签一起改**：用户维护的是同一份标签口径，改名之后旧记录里
 * 还挂着旧名字，行情列表和 K 线历史就会同时出现两个看起来是一回事的标签。
 * 改颜色不动历史（历史里存的是名字，颜色按词表名字现查）。
 *
 * ⚠️ 标签顺序要保住：`jsonb_array_elements ... WITH ORDINALITY` 再 `ORDER BY ord`，
 *    否则 `jsonb_agg` 可能把标签顺序打乱（历史区的展示顺序也跟着乱）。
 */
export async function updateAnnotationTag(
  userId: number,
  id: number,
  input: {name?: unknown; color?: unknown}
): Promise<{tag: AnnotationTag; tags: AnnotationTag[]}> {
  const existing = await queryOne<{name: string; color: string | null}>(
    'SELECT name, color FROM annotation_tags WHERE id = $1 AND user_id = $2',
    [id, userId]
  )
  if (!existing) throw new Error('这个标签不存在（或者不是你的）')

  const hasName = input.name !== undefined && String(input.name).trim() !== ''
  const hasColor = input.color !== undefined
  if (!hasName && !hasColor) throw new Error('没有要改的东西')

  const oldName = existing.name
  const name = hasName ? cleanTagName(input.name) : oldName
  let color = cleanColor(existing.color)
  if (hasColor) {
    const wanted = String(input.color ?? '').trim()
    color = wanted ? cleanColor(wanted) : ''
    if (!color) throw new Error('颜色写法不对（要 #rrggbb）')
  }
  if (!color) color = defaultColorAt(0)

  if (name !== oldName) {
    const dup = await queryOne<{id: string}>(
      `SELECT id FROM annotation_tags
        WHERE user_id = $1 AND lower(name) = lower($2) AND id <> $3`,
      [userId, name, id]
    )
    if (dup) throw new Error(`「${name}」已经有了`)
  }

  const row = await queryOne<{
    id: string | number
    name: string
    color: string | null
  }>(
    `UPDATE annotation_tags SET name = $3, color = $4
      WHERE id = $1 AND user_id = $2
      RETURNING id, name, color`,
    [id, userId, name, color]
  )
  if (!row) throw new Error('这个标签不存在（或者不是你的）')

  if (name !== oldName) {
    await query(
      `UPDATE symbol_annotations a
          SET tags = COALESCE((
            SELECT jsonb_agg(
                     CASE WHEN x.value = to_jsonb($2::text)
                          THEN to_jsonb($3::text)
                          ELSE x.value
                     END
                     ORDER BY x.ord)
              FROM jsonb_array_elements(a.tags) WITH ORDINALITY AS x(value, ord)
          ), '[]'::jsonb)
        WHERE a.user_id = $1
          AND a.tags @> jsonb_build_array($2::text)`,
      [userId, oldName, name]
    )
  }

  return {
    tag: {
      id: Number(row.id),
      name: row.name,
      color: cleanColor(row.color) || color
    },
    tags: await listAnnotationTags(userId)
  }
}

/**
 * 删一个标签 —— **不动历史标注里的名字**。
 *
 * 历史是「当时我给它贴了什么」，不是「现在词表里还有什么」；删词表只是以后不再提供
 * 这个选项。弹窗里的确认文案要把这一点说清楚。
 */
export async function deleteAnnotationTag(
  userId: number,
  id: number
): Promise<AnnotationTag[]> {
  if (Number.isFinite(id) && id > 0) {
    await query('DELETE FROM annotation_tags WHERE id = $1 AND user_id = $2', [
      id,
      userId
    ])
  }
  return listAnnotationTags(userId)
}
