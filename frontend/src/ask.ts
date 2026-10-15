/**
 * 「数据问答」的**前端那份状态**（2026-10-16）。
 *
 * 为什么放模块作用域：`MeView` 里除「交易所账户 / 账户统计」之外的格子都是
 * **切走就卸载**（见那里的说明），会话要是挂在组件里，切一下 tab 就全没了。
 *
 * 结构：**多会话**（`AskThread[]`，每个会话一串问答）—— 就是主流聊天应用那套
 *（左侧历史 / 今天·昨天·7 天内分组 / 可折叠），用户 2026-10-16 要的。
 *
 * ⚠️ 落 localStorage 只存**问题和回答**，不存「取值过程」：那是一跑一变的快照，
 *    再打开时摆一堆过期的工具调用反而误导人（`unverified` 例外，它是个判据）。
 */
import {computed, ref} from 'vue'
import {askStream, type AskReply, type AskStep, type AskTurn} from './api'

/** 一轮问答 */
export interface AskExchange {
  question: string
  /** 模型给的那段话；**流式**下这里是逐字长出来的（旁白会被 `drop` 撤掉） */
  answer: string
  steps: AskStep[]
  /** 没查库就答（后端判的）—— 要显眼地标出来 */
  unverified: boolean
  error: string
  model: string
  costUsd: number
  latencyMs: number
  /** 有没有真答出来（用来决定要不要进多轮历史） */
  ok: boolean
  /** 正在流式接收（显示光标 + 不让再发） */
  streaming: boolean
  /** 走到第几轮 / 一共最多几轮（写「正在查库…第 2/4 轮」） */
  round: number
  roundMax: number
}

/** 一个会话（左侧列表里的一条） */
export interface AskThread {
  id: string
  /** 标题 = 第一句问题（截断），跟主流聊天应用一样 */
  title: string
  createdAt: number
  updatedAt: number
  turns: AskExchange[]
}

const KEY = 'ca_ask_threads'
/** 老格式（v1）：一整个扁平时间线，没有会话的概念 —— 迁移时包成一条 */
const KEY_OLD = 'ca_ask_log'
/*
 * ⚠️ 折叠状态这个 key 特意从 `ca_ask_side` 换成 `_v2`：v1 那份里存着**代码自己写的**
 *    `0`（第一版在窄屏挂载时会「自动收起」并**持久化**），于是刷新回来永远是收起的
 *    —— 用户 2026-10-16 的原话「为什么看不到」。换 key 等于把那条脏状态丢掉。
 */
const KEY_SIDE = 'ca_ask_side_v2'

/** 最多留多少个会话 / 每个会话最多多少轮（localStorage 不该变成数据库） */
const KEEP_THREADS = 50
const KEEP_TURNS = 60

export const askThreads = ref<AskThread[]>([])
export const activeId = ref<string>('')
export const askBusy = ref(false)

/**
 * 左侧历史栏展开着吗。
 *
 * **默认就是展开的**（用户 2026-10-16：「左侧聊天历史，可折叠」—— 先得看得见，
 * 收起是他自己的动作）。之后按他的按钮记着，存 localStorage。
 */
export const sideOpen = ref(true)

/** 当前会话 */
export const activeThread = computed<AskThread | null>(
  () => askThreads.value.find(t => t.id === activeId.value) ?? null
)

/** 当前会话里的问答（没有会话就是空的） */
export const activeTurns = computed<AskExchange[]>(
  () => activeThread.value?.turns ?? []
)

export type GroupLabel = '今天' | '昨天' | '7 天内' | '更早'

/** 这条会话属于哪一组（左侧按它分段，跟主流聊天应用一样） */
export function groupOf(ts: number, now: number = Date.now()): GroupLabel {
  const day = 86_400_000
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const t0 = start.getTime()
  if (ts >= t0) return '今天'
  if (ts >= t0 - day) return '昨天'
  if (ts >= t0 - 6 * day) return '7 天内'
  return '更早'
}

/** 左侧列表：分组 + 组内按最近更新倒序（空的组不出现） */
export const threadGroups = computed<{label: GroupLabel; items: AskThread[]}[]>(() => {
  const order: GroupLabel[] = ['今天', '昨天', '7 天内', '更早']
  const sorted = [...askThreads.value].sort((a, b) => b.updatedAt - a.updatedAt)
  return order
    .map(label => ({
      label,
      items: sorted.filter(t => groupOf(t.updatedAt) === label)
    }))
    .filter(g => g.items.length > 0)
})

/* ---------------- 存取 ---------------- */

function shapeTurn(raw: unknown): AskExchange | null {
  const o = raw as Partial<AskExchange> | null
  if (!o || typeof o.question !== 'string') return null
  return {
    question: o.question,
    answer: String(o.answer ?? ''),
    // 「取值过程」是当时的快照，不恢复（见文件头那段）；但「没查库」这个**判据**要留着 ——
    // 丢了的话一条没查库的回答重开后会看着跟正常回答一样
    steps: [],
    unverified: Boolean(o.unverified),
    error: String(o.error ?? ''),
    model: String(o.model ?? ''),
    costUsd: Number(o.costUsd) || 0,
    latencyMs: Number(o.latencyMs) || 0,
    ok: Boolean(o.ok),
    streaming: false,
    round: 0,
    roundMax: 0
  }
}

function shapeThread(raw: unknown): AskThread | null {
  const o = raw as Partial<AskThread> | null
  if (!o || typeof o.id !== 'string') return null
  const turns = (Array.isArray(o.turns) ? o.turns : [])
    .map(shapeTurn)
    .filter((t): t is AskExchange => t !== null)
    .slice(-KEEP_TURNS)
  const createdAt = Number(o.createdAt) || Date.now()
  return {
    id: o.id,
    title: String(o.title ?? '').slice(0, 40) || '未命名',
    createdAt,
    updatedAt: Number(o.updatedAt) || createdAt,
    turns
  }
}

/** 起一个能排序、不撞的 id（时间戳 36 进制 + 4 位随机，够用） */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 启动时读一次（`AskView` 挂载时调） */
export function loadAsk(): void {
  if (askThreads.value.length) return
  let list: AskThread[] = []
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed))
        list = parsed.map(shapeThread).filter((t): t is AskThread => t !== null)
    }
    /*
     * 老格式（v1，扁平时间线）迁移：包成一条会话，叫「之前的对话」。
     * 迁完把老 key 删掉 —— 不删的话下次它还在，会被反复迁一遍。
     */
    if (!list.length) {
      const old = localStorage.getItem(KEY_OLD)
      if (old) {
        const parsed = JSON.parse(old)
        if (Array.isArray(parsed)) {
          const turns = parsed
            .map(shapeTurn)
            .filter((t): t is AskExchange => t !== null)
          if (turns.length) {
            const now = Date.now()
            list = [
              {
                id: newId(),
                title: '之前的对话',
                createdAt: now,
                updatedAt: now,
                turns
              }
            ]
          }
        }
        localStorage.removeItem(KEY_OLD)
      }
    }
  } catch {
    /* 隐私模式 / 内容坏了：当没存过 */
  }

  askThreads.value = list.slice(-KEEP_THREADS)
  activeId.value = askThreads.value.at(-1)?.id ?? ''
  try {
    const s = localStorage.getItem(KEY_SIDE)
    if (s === '1') sideOpen.value = true
    else if (s === '0') sideOpen.value = false
  } catch {
    /* 忽略 */
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(askThreads.value.slice(-KEEP_THREADS)))
  } catch {
    /* 写不进去也不影响这一屏 */
  }
}

/* ---------------- 会话操作 ---------------- */

/** 开一个新会话并切过去 */
export function newThread(): AskThread {
  const now = Date.now()
  const t: AskThread = {
    id: newId(),
    title: '新的对话',
    createdAt: now,
    updatedAt: now,
    turns: []
  }
  askThreads.value = [...askThreads.value, t].slice(-KEEP_THREADS)
  activeId.value = t.id
  save()
  return t
}

export function selectThread(id: string): void {
  activeId.value = id
  save()
}

export function deleteThread(id: string): void {
  if (id === activeId.value) stopAsk()
  askThreads.value = askThreads.value.filter(t => t.id !== id)
  if (activeId.value === id) activeId.value = askThreads.value.at(-1)?.id ?? ''
  save()
}

/** 侧栏展开 / 收起（**用户按的**才记） */
export function toggleSide(open?: boolean): void {
  sideOpen.value = open ?? !sideOpen.value
  try {
    localStorage.setItem(KEY_SIDE, sideOpen.value ? '1' : '0')
  } catch {
    /* 忽略 */
  }
}

/**
 * 只收起、**不记**（窄屏选完会话自动收抽屉用）。
 *
 * ⚠️ 别改成 `toggleSide(false)`：那不是用户的选择，记下来之后刷新回来还是收起的
 *    —— 用户看到的就是「历史栏不见了」（2026-10-16 踩过一次）。
 */
export function closeSideQuietly(): void {
  sideOpen.value = false
}

/* ---------------- 提问 ---------------- */

/** 当前那条流的取消函数（切会话 / 清空时要把上一次收掉） */
let stopStream: (() => void) | null = null

/** 收掉正在跑的那条流（后端那一跑停不了，但至少不再收数据） */
export function stopAsk(): void {
  stopStream?.()
  stopStream = null
}

/**
 * 问一句，追加进**当前会话** —— 流式。
 *
 * 历史只带**答得出来**的那几轮：把错误气泡当成上下文喂回去，
 * 只会让模型跟着一起绕。
 */
export async function ask(question: string): Promise<void> {
  const q = question.trim()
  if (!q || askBusy.value) return

  // 还没有会话（或当前会话被删了）→ 现开一个
  const thread = activeThread.value ?? newThread()
  const id = thread.id
  const target = askThreads.value.find(t => t.id === id)!
  const isFirst = target.turns.length === 0

  const history: AskTurn[] = target.turns
    .filter(t => t.ok && t.answer)
    .slice(-6)
    .flatMap(t => [
      {role: 'user' as const, content: t.question},
      {role: 'assistant' as const, content: t.answer}
    ])

  target.turns = [
    ...target.turns,
    {
      question: q,
      answer: '',
      steps: [],
      unverified: false,
      error: '',
      model: '',
      costUsd: 0,
      latencyMs: 0,
      ok: false,
      streaming: true,
      round: 0,
      roundMax: 0
    }
  ].slice(-KEEP_TURNS)
  // 第一句问题就是标题（跟主流聊天应用一样）
  if (isFirst) target.title = q.slice(0, 20)
  target.updatedAt = Date.now()

  // 拿数组里那一份（不是刚 push 的裸对象）来改，Vue 才盯得到
  const entry = askThreads.value.find(t => t.id === id)!.turns.at(-1)!
  askBusy.value = true

  await new Promise<void>(resolve => {
    const finish = (): void => {
      entry.streaming = false
      stopStream = null
      askBusy.value = false
      save()
      resolve()
    }
    stopStream = askStream(q, history, {
      onRound: (round, max) => {
        entry.round = round
        entry.roundMax = max
        // 新的一轮：上一轮那段文字要么已撤回、要么已是最终回答，不会再变
        if (entry.streaming) entry.answer = ''
      },
      onStep: step => {
        // 逐条追加：用户能**看着它查**，这也是流式最值的地方
        entry.steps = [...entry.steps, step]
      },
      onDelta: text => {
        entry.answer += text
      },
      // 这一轮只是旁白（模型说「我去查一下」那种），别让它混进回答
      onDrop: () => {
        entry.answer = ''
      },
      onDone: (res: AskReply) => {
        /*
         * `done` 带的是**完整结果**，直接盖掉 delta 拼出来的那份 ——
         * 网络抖动漏掉几片时，拼出来的会缺字，以它为准才可靠。
         */
        if (res.answer) entry.answer = res.answer
        entry.steps = res.steps ?? entry.steps
        entry.unverified = !res.verified
        entry.model = res.model ?? ''
        entry.costUsd = res.costUsd ?? 0
        entry.latencyMs = res.latencyMs ?? 0
        entry.ok = Boolean(entry.answer)
        const th = askThreads.value.find(t => t.id === id)
        if (th) th.updatedAt = Date.now()
        finish()
      },
      onError: message => {
        entry.error = message
        finish()
      }
    })
  })
}
