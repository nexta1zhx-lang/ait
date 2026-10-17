/**
 * 「数据问答」的前端那份状态。
 *
 * 为什么放模块作用域：`MeView` 里除「交易所账户 / 账户统计」之外的格子都是
 * **切走就卸载**（见那里的说明），会话要是挂在组件里，切一下 tab 就全没了。
 *
 * 结构：**多会话**（`AskThread[]`，每个会话一串问答）—— 就是主流聊天应用那套
 *（左侧历史 / 今天·昨天·7 天内分组 / 可折叠），用户 2026-10-16 要的。
 *
 * ★ 2026-10-17：**会话改成存服务器**（用户：「现在服务器数据问答的数据有保存在数据库吗」→
 *   选「要存 —— 多设备能续上，服务端留一份」）。以前只往 `llm_usage` 记一条花费，
 *   问题 / 回答全在浏览器 localStorage 里，换设备就没了。
 *
 *   口径：
 *   · **服务端是唯一权威** —— 这里不再把会话写回 localStorage（只留「侧栏折叠」和
 *     一次性迁移用的旧 key）。两边都存必然打架（哪边新？谁覆盖谁？）。
 *   · **正文懒加载**：列表只拿 id / 标题 / 时间，点开某个会话才 `GET /api/ask/threads/:id`
 *     （一个聊了很久的会话可能上百轮，进页面就全拉一遍没意义）。
 *   · 新建的会话**先在本地当草稿**（`id = 0`）：问第一句时后端才建真的，
 *     建好立刻用 `thread` 事件把 id 推回来（见 `onThread`）—— 这样点「新对话」
 *     不会在库里留一堆空会话。
 *   · 老浏览器里那批会话**一次性搬进库**（`migrateLegacy`），搬完删掉本地那两个 key。
 */
import {computed, ref} from 'vue'
import {
  askStream,
  deleteAskThread,
  getAskThread,
  importAskThreads,
  listAskThreads,
  type AskReply,
  type AskStep,
  type AskThreadBrief,
  type AskTurn,
  type StoredAskTurn
} from './api'

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
  /** 用户按了「终止」—— 半截回答要留住并标出来（不是"失败"） */
  stopped: boolean
  /** 正在流式接收（显示光标 + 不让再发） */
  streaming: boolean
  /** 走到第几轮 / 一共最多几轮（写「正在查库…第 2/4 轮」） */
  round: number
  roundMax: number
}

/** 一个会话（左侧列表里的一条） */
export interface AskThread {
  /** 服务端的 id；**`0` = 还没落库的草稿**（问第一句时后端才建） */
  id: number
  /** 标题 = 第一句问题（截断），跟主流聊天应用一样 */
  title: string
  createdAt: number
  updatedAt: number
  turns: AskExchange[]
  /** 正文拉下来了没（点开才拉；草稿 / 刚问完的那条是 `true`） */
  loaded: boolean
}

/** 老的前端存档（2026-10-16 ~ 10-17：会话只在这个浏览器的 localStorage 里） */
const KEY_LEGACY = 'ca_ask_threads'
/** 更老的格式（v1）：一整个扁平时间线，没有会话的概念 —— 迁移时包成一条 */
const KEY_OLD = 'ca_ask_log'
/** 搬完了打个标：不然每次进页面都拿同一批本地数据往库里塞一份 */
const KEY_IMPORTED = 'ca_ask_imported_v1'
/*
 * ⚠️ 折叠状态这个 key 特意从 `ca_ask_side` 换成 `_v2`：v1 那份里存着**代码自己写的**
 *    `0`（第一版在窄屏挂载时会「自动收起」并**持久化**），于是刷新回来永远是收起的
 *    —— 用户 2026-10-16 的原话「为什么看不到」。换 key 等于把那条脏状态丢掉。
 */
const KEY_SIDE = 'ca_ask_side_v2'

export const askThreads = ref<AskThread[]>([])
/** 当前会话的 id（`0` = 草稿 / 没有会话） */
export const activeId = ref<number>(0)
export const askBusy = ref(false)
/** 正在拉某个会话的正文（切过去时先转圈，别显示成「这个会话是空的」） */
export const turnsLoading = ref(false)

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

/* ---------------- 形状 ---------------- */

function emptyTurn(question: string): AskExchange {
  return {
    question,
    answer: '',
    steps: [],
    unverified: false,
    error: '',
    model: '',
    costUsd: 0,
    latencyMs: 0,
    ok: false,
    stopped: false,
    streaming: true,
    round: 0,
    roundMax: 0
  }
}

/** 库里那一轮 → 前端这一轮（**取值过程也恢复**：现在它是存下来的，不是过期的现场快照） */
function shapeStored(t: StoredAskTurn): AskExchange {
  return {
    question: String(t.question ?? ''),
    answer: String(t.answer ?? ''),
    steps: Array.isArray(t.steps) ? t.steps : [],
    unverified: Boolean(t.unverified),
    error: String(t.error ?? ''),
    model: String(t.model ?? ''),
    costUsd: Number(t.costUsd) || 0,
    latencyMs: Number(t.latencyMs) || 0,
    ok: Boolean(t.ok),
    stopped: Boolean(t.stopped),
    streaming: false,
    round: 0,
    roundMax: 0
  }
}

function shapeBrief(t: AskThreadBrief): AskThread {
  return {
    id: Number(t.id),
    title: String(t.title ?? '') || '未命名',
    createdAt: Number(t.createdAt) || Date.now(),
    updatedAt: Number(t.updatedAt) || Number(t.createdAt) || Date.now(),
    turns: [],
    loaded: false
  }
}

/* ---------------- 存取 ---------------- */

/** 老的 localStorage 存档 → 投给后端一次（一次性） */
async function migrateLegacy(): Promise<boolean> {
  let payload: Parameters<typeof importAskThreads>[0] = []
  try {
    if (localStorage.getItem(KEY_IMPORTED) === '1') return false
    const raw = localStorage.getItem(KEY_LEGACY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed))
        payload = parsed
          .map((t: Record<string, unknown>) => ({
            title: String(t?.title ?? '') || '未命名',
            createdAt: Number(t?.createdAt) || undefined,
            updatedAt: Number(t?.updatedAt) || undefined,
            turns: (Array.isArray(t?.turns) ? t.turns : []).map(
              (x: Record<string, unknown>) => ({
                question: String(x?.question ?? ''),
                answer: String(x?.answer ?? ''),
                unverified: Boolean(x?.unverified),
                model: String(x?.model ?? ''),
                costUsd: Number(x?.costUsd) || 0,
                latencyMs: Number(x?.latencyMs) || 0,
                ok: Boolean(x?.ok),
                stopped: Boolean(x?.stopped),
                error: String(x?.error ?? ''),
                // 老数据没有逐轮时间：用那条会话的更新时间当近似（只影响排序兜底）
                createdAt: Number(t?.updatedAt) || undefined
              })
            )
          }))
          .filter(t => t.turns.length > 0)
    }
    /* v1（扁平时间线）→ 包成一条「之前的对话」 */
    if (!payload.length) {
      const old = localStorage.getItem(KEY_OLD)
      if (old) {
        const parsed = JSON.parse(old)
        if (Array.isArray(parsed) && parsed.length) {
          payload = [
            {
              title: '之前的对话',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              turns: parsed.map((x: Record<string, unknown>) => ({
                question: String(x?.question ?? ''),
                answer: String(x?.answer ?? ''),
                unverified: Boolean(x?.unverified),
                model: String(x?.model ?? ''),
                costUsd: Number(x?.costUsd) || 0,
                latencyMs: Number(x?.latencyMs) || 0,
                ok: Boolean(x?.ok),
                stopped: Boolean(x?.stopped),
                error: String(x?.error ?? '')
              }))
            }
          ]
        }
      }
    }
  } catch {
    /* 隐私模式 / 内容坏了：当没存过 */
    return false
  }

  if (!payload.length) {
    // 没东西可搬：直接打标，别每次进页面都翻一遍 localStorage
    try {
      localStorage.setItem(KEY_IMPORTED, '1')
    } catch {
      /* 忽略 */
    }
    return false
  }

  try {
    await importAskThreads(payload)
    try {
      localStorage.removeItem(KEY_LEGACY)
      localStorage.removeItem(KEY_OLD)
      localStorage.setItem(KEY_IMPORTED, '1')
    } catch {
      /* 忽略（下次会再搬一次 —— 服务端多一份重复历史，比丢历史好） */
    }
    return true
  } catch {
    /* 网络不好 / 未登录：下次进来再搬 */
    return false
  }
}

function readSide(): void {
  try {
    const s = localStorage.getItem(KEY_SIDE)
    if (s === '1') sideOpen.value = true
    else if (s === '0') sideOpen.value = false
  } catch {
    /* 忽略 */
  }
}

/** 启动时拉一次（`AskView` 挂载时调） */
export async function loadAsk(): Promise<void> {
  readSide()

  let list: AskThreadBrief[] = []
  try {
    list = (await listAskThreads()).threads
  } catch {
    /* 网络 / 未登录：这一屏先空着，问一句时后端自己会建会话 */
    return
  }

  // 库里空的 → 看看这个浏览器里还有没有老存档，有就搬进去（只搬一次）
  if (!list.length && (await migrateLegacy())) {
    try {
      list = (await listAskThreads()).threads
    } catch {
      list = []
    }
  }

  askThreads.value = list.map(shapeBrief)
  // 保留当前选中（刷新时不该跳走）；没有就选最近那条
  const keep = askThreads.value.find(t => t.id === activeId.value)
  activeId.value = keep?.id ?? askThreads.value[0]?.id ?? 0
  if (activeId.value) await loadThread(activeId.value)
}

/** 拉一个会话的正文（已经拉过的跳过；`force` 时重拉） */
export async function loadThread(id: number, force = false): Promise<void> {
  const t = askThreads.value.find(x => x.id === id)
  if (!t || t.id === 0) return
  if (t.loaded && !force) return

  turnsLoading.value = true
  try {
    const d = await getAskThread(id)
    t.turns = (d.turnsList ?? []).map(shapeStored)
    t.title = d.title || t.title
    t.createdAt = Number(d.createdAt) || t.createdAt
    t.updatedAt = Number(d.updatedAt) || t.updatedAt
    t.loaded = true
  } catch (e) {
    /*
     * 404 = 这条会话已经不在了（另一台设备删了 / 库里清过）⇒ 本地也删掉，
     * 别让它挂在左侧、点开永远是空的。
     */
    const msg = e instanceof Error ? e.message : String(e)
    if (/不存在|404/.test(msg)) {
      askThreads.value = askThreads.value.filter(x => x.id !== id)
      if (activeId.value === id) activeId.value = askThreads.value[0]?.id ?? 0
    }
  } finally {
    turnsLoading.value = false
  }
}

/* ---------------- 会话操作 ---------------- */

/** 开一个新会话并切过去（**本地草稿**，问第一句时后端才建真的） */
export function newThread(): AskThread {
  const now = Date.now()
  /*
   * 已经有一条空草稿就复用 —— 连点两下「新对话」不该攒出两条空会话
   * （服务端不会存它们，但左侧列表会多两条一样的「新的对话」）。
   */
  const draft = askThreads.value.find(t => t.id === 0 && !t.turns.length)
  if (draft) {
    activeId.value = 0
    return draft
  }
  const t: AskThread = {
    id: 0,
    title: '新的对话',
    createdAt: now,
    updatedAt: now,
    turns: [],
    loaded: true
  }
  askThreads.value = [t, ...askThreads.value]
  activeId.value = 0
  return t
}

export function selectThread(id: number): void {
  activeId.value = id
  if (id) void loadThread(id)
}

export async function deleteThread(id: number): Promise<void> {
  if (id === activeId.value) stopAsk()
  // 草稿还没落库：本地删掉就完事
  if (id) {
    try {
      await deleteAskThread(id)
    } catch {
      /* 删不掉也先收起来：下次进来它还在，比卡着好 */
    }
  }
  askThreads.value = askThreads.value.filter(t => t.id !== id)
  if (activeId.value === id) activeId.value = askThreads.value[0]?.id ?? 0
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

/** 当前那条流的取消函数（切会话 / 清空 / 用户按终止时调） */
let stopStream: (() => void) | null = null

/**
 * 用户按了「终止」没有。
 *
 * ⚠️ 必须用这个标志区分「用户主动停」和「内部收尾」—— 两者都走 `stopStream()`，
 *    光看"流关了"分不出来。而且 `ask()` 的收尾要用它决定**是留半截回答还是报错**。
 */
let userStopped = false

/**
 * 当前那一跑的**收尾函数**。
 *
 * ⚠️⚠️ 这个是 2026-10-16 补的，补之前「终止」按了像没反应 —— 原因是：
 *    终止 = 关掉 SSE 连接，而**关了之后 `onDone` / `onError` 一个都不会再来**，
 *    于是收尾那几行（`streaming=false` / `askBusy=false`）永远不执行：
 *    界面一直停在「正在查库」、输入框一直禁用，再按一次终止也没用（`stopStream` 已置空）。
 *    所以终止必须**自己**把这一轮收掉，不能指望那条流再回话。
 */
let currentFinish: (() => void) | null = null

/**
 * 终止当前这一跑（用户按的按钮、或者离开 / 清空时顺手收掉）。
 *
 * ⚠️ 前端的「终止」= **关掉 SSE 连接**。后端那边的取数循环会跟着结束 ——
 *    它听的是 `res.close`（见 `server.ts` 的 `handleAskStream`）：
 *    连接一断就 `AbortController.abort()`，正在等的大模型请求和剩下的工具调用都停。
 *    所以这里不用再单独发一个"取消"请求。
 * ⚠️ 但**前端自己也要收尾**（见 `currentFinish` 那段）：关连接不会带回任何回调。
 * ⚠️ 后端会把这一轮**照样存下来**（半截回答 + `stopped`）：重开时看到的跟刚才一致。
 */
export function stopAsk(): void {
  if (!stopStream && !currentFinish) return
  userStopped = true
  stopStream?.()
  stopStream = null
  currentFinish?.()
}

/**
 * 问一句，追加进**当前会话** —— 流式。
 *
 * 历史只带**答得出来**的那几轮：把错误气泡当成上下文喂回去，
 * 只会让模型跟着一起绕。
 * ⚠️ 有了会话 id 之后后端**从库里取历史**（不信前端这份）；这里带的那份只在
 *    「还没有会话」时用得上（而那时多半是空的）。
 */
export async function ask(question: string): Promise<void> {
  const q = question.trim()
  if (!q || askBusy.value) return

  // 还没有会话（或当前会话被删了）→ 现开一个草稿
  const thread = activeThread.value ?? newThread()
  const isFirst = thread.turns.length === 0

  const history: AskTurn[] = thread.turns
    .filter(t => t.ok && t.answer)
    .slice(-6)
    .flatMap(t => [
      {role: 'user' as const, content: t.question},
      {role: 'assistant' as const, content: t.answer}
    ])

  thread.turns = [...thread.turns, emptyTurn(q)]
  // 第一句问题就是标题（跟主流聊天应用一样）
  if (isFirst) thread.title = q.slice(0, 20)
  thread.updatedAt = Date.now()

  // 拿数组里那一份（不是刚 push 的裸对象）来改，Vue 才盯得到
  const entry = thread.turns.at(-1)!
  askBusy.value = true
  userStopped = false

  await new Promise<void>(resolve => {
    const finish = (): void => {
      currentFinish = null
      entry.streaming = false
      /*
       * 用户按了终止：把半截回答留住并标出来。
       *
       * ⚠️ 这条**必须在 `onError` 之前判**：终止会让 SSE 那边以"连接中断"收尾，
       *    于是 `onError` 也会来 —— 不区分的话，用户按了终止会看到一句红色的
       *    「连接中断，请重试」，好像是他自己搞坏了什么。
       */
      if (userStopped) {
        entry.stopped = true
        entry.ok = false
        /*
         * 一个字都没出来（还在第一轮取数）→ 留一句人话，别让气泡是空的；
         * 已经有半截回答的**留着**（他可能正是靠那半截看出来它在瞎查）。
         */
        if (!entry.error && !entry.answer) entry.error = '已终止'
      }
      stopStream = null
      userStopped = false
      askBusy.value = false
      thread.loaded = true
      resolve()
    }
    currentFinish = finish
    stopStream = askStream(q, history, thread.id, {
      /*
       * 后端把会话建好了（草稿拿到了真 id）。
       *
       * ⚠️ 这是「同一屏」的替换：`activeId` 从 0 变成真 id 时，`AskView` 那个
       *    「换会话就重置展开状态」的 watcher 会看到 id 变了 —— 那边专门跳过
       *    0 → 非 0 这一跳（不然跑着跑着「取值过程」会被收起来）。
       */
      onThread: t => {
        if (!t.id) return
        const wasDraft = thread.id === 0
        thread.id = t.id
        if (t.title) thread.title = t.title
        if (wasDraft && activeId.value === 0) activeId.value = t.id
      },
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
        // 后端也可能自己判定被终止（它听的是连接断开，比前端更准）
        if (res.aborted) entry.stopped = true
        entry.ok = Boolean(entry.answer) && !entry.stopped
        // 兜底：`thread` 事件万一没收到，`done` 里还带了一份 id
        if (res.threadId && thread.id === 0) {
          thread.id = res.threadId
          if (activeId.value === 0) activeId.value = res.threadId
        }
        thread.updatedAt = Date.now()
        finish()
      },
      onError: message => {
        // 用户自己按的终止不算错误（见 `finish()` 里那段说明）
        if (!userStopped) entry.error = message
        finish()
      }
    })
  })
}
