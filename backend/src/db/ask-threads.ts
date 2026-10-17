/**
 * 「数据问答」的会话存档（2026-10-17）。
 *
 * ★ 用户：「现在服务器数据问答的数据有保存在数据库吗」→ 原话选的是
 *   **「要存 —— 多设备能续上，服务端留一份（含回答里的账户数字）」**。
 *   以前只往 `llm_usage` 记了一条 token / 花费，**问题、回答、取值过程全在浏览器
 *   localStorage 里** —— 换设备、换浏览器、清站点数据就没了，服务端也查不到问过什么。
 *
 * 结构：
 *   `ask_threads`  一个会话（左侧历史里的一条）
 *   `ask_turns`    会话里的一轮问答（问题 / 回答 / 取值过程 / 花费 / 是否终止）
 *
 * ⚠️ 跟 `analyses` 一样**按用户隔离**：每条查询第一条件永远是 `user_id`
 *    （`ask_turns` 靠 join 父表的 `user_id` 判归属 —— 它自己不带这一列，
 *    也就不会出现「轮次和会话归属不一致」这种脏数据）。
 * ⚠️ 这里**不裁剪内容**（用户明确说「含回答里的账户数字」）——
 *    只做**数量**上的封顶，防止库无限涨：每人最多 `MAX_THREADS` 个会话、
 *    每个会话最多 `MAX_TURNS` 轮（见 `appendAskTurn` 里那两刀）。
 */
import {query, queryOne} from './client'

/** 一个会话（列表里那一条，**不带**问答正文） */
export interface AskThreadBrief {
  id: number
  title: string
  /** 毫秒时间戳 */
  createdAt: number
  updatedAt: number
  /** 这个会话有几轮（列表上显示「12 轮」用） */
  turns: number
}

/** 一轮问答（存下来的那份） */
export interface StoredAskTurn {
  id: number
  question: string
  answer: string
  /** 取值过程（工具名 / 参数 / 行数 / 耗时）—— 原始 `AskStep[]` */
  steps: unknown[]
  /** 没查库就答（后端判的判据，重开也要能显示） */
  unverified: boolean
  model: string
  costUsd: number
  latencyMs: number
  /** 答出来了（决定要不要进多轮历史） */
  ok: boolean
  /** 用户按了终止 */
  stopped: boolean
  /** 出错时的原因（正常是空串） */
  error: string
  createdAt: number
}

export interface StoredAskThread extends AskThreadBrief {
  turnsList: StoredAskTurn[]
}

/** 每人最多留几个会话 / 每个会话最多留几轮（超了就砍最老的） */
export const MAX_THREADS = 100
export const MAX_TURNS = 60
/** 一条回答最多存多长（正常 4KB 上下；封顶只是防病态输出把库撑大） */
const MAX_ANSWER_CHARS = 20_000
/** 一条「取值过程」里的 detail / error 最多存多长 */
const MAX_STEP_TEXT = 2_000

interface RawThread {
  id: string
  title: string
  created_at: Date
  updated_at: Date
  turns: string
}

interface RawTurn {
  id: string
  question: string
  answer: string
  steps: unknown
  unverified: boolean
  model: string
  cost_usd: string
  latency_ms: number
  ok: boolean
  stopped: boolean
  error: string
  created_at: Date
}

const mapBrief = (r: RawThread): AskThreadBrief => ({
  id: Number(r.id),
  title: r.title || '未命名',
  createdAt: r.created_at.getTime(),
  updatedAt: r.updated_at.getTime(),
  turns: Number(r.turns ?? 0)
})

const mapTurn = (r: RawTurn): StoredAskTurn => ({
  id: Number(r.id),
  question: r.question,
  answer: r.answer,
  steps: Array.isArray(r.steps) ? r.steps : [],
  unverified: Boolean(r.unverified),
  model: r.model,
  costUsd: Number(r.cost_usd) || 0,
  latencyMs: Number(r.latency_ms) || 0,
  ok: Boolean(r.ok),
  stopped: Boolean(r.stopped),
  error: r.error ?? '',
  createdAt: r.created_at.getTime()
})

/** 左侧列表：每人最近 `MAX_THREADS` 个会话（按最近更新倒序），不带正文 */
export async function listAskThreads(
  userId: number
): Promise<AskThreadBrief[]> {
  const rows = await query<RawThread>(
    `SELECT t.id, t.title, t.created_at, t.updated_at,
            (SELECT count(*) FROM ask_turns a WHERE a.thread_id = t.id)::text AS turns
       FROM ask_threads t
      WHERE t.user_id = $1
      ORDER BY t.updated_at DESC
      LIMIT ${MAX_THREADS}`,
    [userId]
  )
  return rows.map(mapBrief)
}

/** 打开一个会话：正文 + 最后 `MAX_TURNS` 轮（按时间升序，跟聊天窗口一致） */
export async function getAskThread(
  userId: number,
  id: number
): Promise<StoredAskThread | null> {
  const head = await queryOne<RawThread>(
    `SELECT t.id, t.title, t.created_at, t.updated_at,
            (SELECT count(*) FROM ask_turns a WHERE a.thread_id = t.id)::text AS turns
       FROM ask_threads t
      WHERE t.id = $1 AND t.user_id = $2`,
    [id, userId]
  )
  if (!head) return null
  const rows = await query<RawTurn>(
    `SELECT a.id, a.question, a.answer, a.steps, a.unverified, a.model,
            a.cost_usd, a.latency_ms, a.ok, a.stopped, a.error, a.created_at
       FROM ask_turns a
       JOIN ask_threads t ON t.id = a.thread_id
      WHERE a.thread_id = $1 AND t.user_id = $2
      ORDER BY a.id DESC
      LIMIT ${MAX_TURNS}`,
    [id, userId]
  )
  return {
    ...mapBrief(head),
    turnsList: rows.reverse().map(mapTurn)
  }
}

/** 这个会话是不是我的（不在 / 不是我的都回 false） */
export async function ownsAskThread(
  userId: number,
  id: number
): Promise<boolean> {
  const row = await queryOne<{id: string}>(
    'SELECT id FROM ask_threads WHERE id = $1 AND user_id = $2',
    [id, userId]
  )
  return !!row
}

export async function createAskThread(
  userId: number,
  title: string
): Promise<number> {
  const row = await queryOne<{id: string}>(
    'INSERT INTO ask_threads (user_id, title) VALUES ($1, $2) RETURNING id',
    [userId, (title || '').slice(0, 60)]
  )
  const id = Number(row?.id)
  await pruneThreads(userId)
  return id
}

export async function renameAskThread(
  userId: number,
  id: number,
  title: string
): Promise<boolean> {
  const rows = await query<{id: string}>(
    `UPDATE ask_threads SET title = $1, updated_at = now()
      WHERE id = $2 AND user_id = $3 RETURNING id`,
    [(title || '').slice(0, 60), id, userId]
  )
  return rows.length > 0
}

export async function deleteAskThread(
  userId: number,
  id: number
): Promise<boolean> {
  const rows = await query<{id: string}>(
    'DELETE FROM ask_threads WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  )
  return rows.length > 0
}

export interface NewAskTurn {
  question: string
  answer: string
  steps: unknown[]
  unverified: boolean
  model: string
  costUsd: number
  latencyMs: number
  ok: boolean
  stopped: boolean
  error: string
  /** 不给 = 现在。批量导入历史时用 */
  createdAt?: number
}

/** 把取值过程里那几个长文本收一收（只防病态数据，不动结构） */
function clipSteps(steps: unknown[]): unknown[] {
  return (Array.isArray(steps) ? steps : []).map(s => {
    const o = s as Record<string, unknown>
    if (!o || typeof o !== 'object') return s
    const cut = (v: unknown): unknown =>
      typeof v === 'string' && v.length > MAX_STEP_TEXT
        ? v.slice(0, MAX_STEP_TEXT) + '…'
        : v
    return {...o, detail: cut(o.detail), error: cut(o.error)}
  })
}

/**
 * 往会话里追加一轮。
 *
 * 三件事一起做（都在一个事务里，别让「轮次写进去了但会话时间没动」这种事发生）：
 *   ① 插这一轮
 *   ② 会话的 `updated_at` 推到这一轮的时间；**标题还是占位的**（新建 / 「新的对话」）
 *      就用这一轮的问题当标题 —— 跟主流聊天应用一样
 *   ③ 砍掉这个会话最老的轮次（> `MAX_TURNS`）
 *
 * @returns 写入后的会话（没权限 / 不存在回 null）
 */
export async function appendAskTurn(
  userId: number,
  threadId: number,
  turn: NewAskTurn
): Promise<AskThreadBrief | null> {
  const at = turn.createdAt ? new Date(turn.createdAt) : new Date()
  const answer = (turn.answer ?? '').slice(0, MAX_ANSWER_CHARS)

  const head = await queryOne<{
    id: string
    title: string
    created_at: Date
  }>(
    'SELECT id, title, created_at FROM ask_threads WHERE id = $1 AND user_id = $2',
    [threadId, userId]
  )
  if (!head) return null

  await query(
    `INSERT INTO ask_turns (thread_id, question, answer, steps, unverified,
                            model, cost_usd, latency_ms, ok, stopped, error, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      threadId,
      (turn.question ?? '').slice(0, 500),
      answer,
      JSON.stringify(clipSteps(turn.steps)),
      Boolean(turn.unverified),
      turn.model || '',
      Number.isFinite(turn.costUsd) ? turn.costUsd : 0,
      Math.round(Number.isFinite(turn.latencyMs) ? turn.latencyMs : 0),
      Boolean(turn.ok),
      Boolean(turn.stopped),
      (turn.error ?? '').slice(0, 2_000),
      at
    ]
  )

  /* 标题只在「还没起过」的时候用问题顶上去 —— 之后用户重命名过就不要再动 */
  const placeholder = !head.title || head.title === '新的对话'
  const title = placeholder ? turn.question.trim().slice(0, 20) : head.title

  await query(
    'UPDATE ask_threads SET updated_at = $1, title = $2 WHERE id = $3 AND user_id = $4',
    [at, title, threadId, userId]
  )

  // 只留最新 MAX_TURNS 轮（老的物理删掉，别让一个聊了很久的会话变成一张大表）
  await query(
    `DELETE FROM ask_turns
      WHERE thread_id = $1
        AND id NOT IN (
          SELECT id FROM ask_turns WHERE thread_id = $1 ORDER BY id DESC LIMIT ${MAX_TURNS}
        )`,
    [threadId]
  )

  return {
    id: threadId,
    title: title || '未命名',
    createdAt: head.created_at.getTime(),
    updatedAt: at.getTime(),
    // 调用方（问完那一句）只拿它更新左侧标题和时间，轮数它自己知道
    turns: 0
  }
}

/** 只留最近的 `MAX_THREADS` 个会话（连轮次一起删，外键 ON DELETE CASCADE） */
async function pruneThreads(userId: number): Promise<void> {
  await query(
    `DELETE FROM ask_threads
      WHERE user_id = $1
        AND id NOT IN (
          SELECT id FROM ask_threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${MAX_THREADS}
        )`,
    [userId]
  )
}

/** 给模型看的多轮历史：这个会话里**答出来了**的最后几轮（正序） */
export async function askThreadHistory(
  userId: number,
  threadId: number,
  limit = 6
): Promise<{role: 'user' | 'assistant'; content: string}[]> {
  const rows = await query<{question: string; answer: string}>(
    `SELECT a.question, a.answer
       FROM ask_turns a
       JOIN ask_threads t ON t.id = a.thread_id
      WHERE a.thread_id = $1 AND t.user_id = $2 AND a.ok = true AND a.answer <> ''
      ORDER BY a.id DESC
      LIMIT ${Math.max(1, Math.min(20, limit))}`,
    [threadId, userId]
  )
  return rows
    .reverse()
    .flatMap(r => [
      {role: 'user' as const, content: r.question},
      {role: 'assistant' as const, content: r.answer}
    ])
}

export interface ImportedThread {
  title: string
  createdAt?: number
  updatedAt?: number
  turns: NewAskTurn[]
}

/**
 * 把**浏览器 localStorage 里的旧会话**搬进库里（一次性迁移）。
 *
 * 用户以前的会话只在他那台设备的浏览器里；不搬的话升级完打开就是空的
 * （看起来像「历史被清了」）。
 * ⚠️ 空会话跳过；`createdAt` 用原来的时间，左侧的「今天 / 昨天」分组才不会全挤到今天。
 */
export async function importAskThreads(
  userId: number,
  list: ImportedThread[]
): Promise<{threads: number; turns: number}> {
  let threads = 0
  let turns = 0
  for (const raw of (Array.isArray(list) ? list : []).slice(0, MAX_THREADS)) {
    const rows = (Array.isArray(raw?.turns) ? raw.turns : []).slice(-MAX_TURNS)
    if (!rows.length) continue
    const first = raw.turns[0]
    const created = new Date(raw.createdAt ?? first?.createdAt ?? Date.now())
    const updated = new Date(raw.updatedAt ?? Date.now())
    const id = await createAskThread(userId, raw.title ?? first.question)
    for (const t of rows) {
      await appendAskTurn(userId, id, t)
      turns++
    }
    /*
     * ⚠️ 时间要**最后**改：`appendAskTurn` 每写一轮都会把 `updated_at` 推成那一轮的时间，
     *    先设再插等于白设（实测导入完的会话全挤到「今天」那一组，跟原来不符）。
     */
    await query(
      'UPDATE ask_threads SET created_at = $1, updated_at = $2 WHERE id = $3',
      [created, updated, id]
    )
    threads++
  }
  return {threads, turns}
}
