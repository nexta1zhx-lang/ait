/**
 * **持久化分析**的前端状态（2026-10-15）。
 *
 * 用户 2026-10-15：「在 k 线界面顶部加入持久化分析的图标，点击图标弹窗确定要加入持久化分析，
 * 每隔 15 分钟分析一次，最长不超过 8 小时」「结论变化时站内提示 + 同时往 Telegram 发一条」。
 *
 * 分工：
 *   · **后端**负责按 15 分钟真跑（`analysis/persist.ts` 的 ticker）—— 网页关着也跑；
 *   · 这里只负责**看到**：拉会话列表、算出「还剩多久 / 下一次什么时候」、结论跨档时弹一条站内提示。
 *
 * ⚠️ 为什么用轮询而不是新开一条 SSE：一页最多 3 个会话、30 秒拉一次（就是个几十字节的 JSON），
 *    而结论**变化**是本轮唯一要"实时"的东西 —— 换个说法：Telegram 那条已经覆盖了"人不在电脑前"，
 *    站内这条只要在页面开着时不漏就行，轮询足够，不值得再多一条长连接。
 */
import {ref} from 'vue'
import {
  fetchPersist,
  startPersist,
  stopPersist,
  runPersistNow,
  type PersistLimits,
  type PersistSession,
  type PersistTimelineRow
} from './api'
import {crossedActionable} from './markdown'
import {showToast} from './toast'

export type PersistRow = PersistSession & {timeline: PersistTimelineRow[]}

/** 会话列表（在跑的在前，后端已经排好） */
export const persistSessions = ref<PersistRow[]>([])
export const persistLimits = ref<PersistLimits>({
  maxActive: 3,
  maxMs: 8 * 60 * 60_000,
  intervalMs: 15 * 60_000
})
export const persistBusy = ref(false)
export const persistError = ref('')

/** 上一次看到的每个会话的「最近结论」（用来判跨档）—— key = 会话 id */
const lastSeen = new Map<number, {at: string | null; verdict: string | null}>()

/** 这个币有没有正在跑的会话（图标状态用它） */
export function activeSessionOf(
  base: string
): PersistRow | null {
  const sym = String(base).trim().toUpperCase()
  return (
    persistSessions.value.find(
      s => s.status === 'active' && s.symbol.toUpperCase() === sym
    ) ?? null
  )
}

/**
 * 拉一次（页面开着时每 30 秒一次）。
 *
 * 只有**「可做」的进出**（观望 → 可做 / 可做 → 走弱）才弹一条站内提示：
 * 32 条里通常只有几条有意义，而且"不可做 ↔ 观望"本来就是一回事，每条都弹就是噪音。
 * 判据在 `markdown.ts` 的 `crossedActionable()`（跟后端同一套）。
 */
export async function refreshPersist(quiet = false): Promise<void> {
  try {
    const r = await fetchPersist()
    if (r.error) throw new Error(r.error)
    const rows = (r.sessions ?? []) as PersistRow[]
    for (const s of rows) {
      const prev = lastSeen.get(s.id)
      lastSeen.set(s.id, {at: s.lastAt, verdict: s.lastVerdict})
      /* 第一次看到不算"变化"（刚打开页面就把历史变化全弹一遍是灾难） */
      if (!prev || !s.lastAt || prev.at === s.lastAt) continue
      /* 判据跟后端一致：只有「可做」进出才弹（不可做 ↔ 观望 是噪音） */
      if (!crossedActionable(prev.verdict, s.lastVerdict ?? '')) continue
      const label = (v: string): string =>
        v === 'go' ? '可做' : v === 'no' ? '不可做' : '观望'
      showToast(
        `${s.symbol} 结论变化：${label(prev.verdict)} → ${label(s.lastVerdict)}` +
          `（持久化分析第 ${s.runs} 次）`,
        s.lastVerdict === 'go' ? 'ok' : 'bad'
      )
    }
    persistSessions.value = rows
    persistLimits.value = r.limits ?? persistLimits.value
    persistError.value = ''
  } catch (e) {
    persistError.value = (e as Error).message
    if (!quiet) showToast(`持久化分析读取失败：${persistError.value}`, 'bad')
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let onVisible: (() => void) | null = null

/**
 * 页面挂载时开轮询（返回一个「撤掉」的函数）。
 *
 * ⚠️ 只在**页面可见**时才拉：切后台那会儿没人看，白打接口（跟前端其它轮询一个口径）。
 *    Telegram 那条覆盖「人不在电脑前」，所以这里不需要在后台也收。
 */
export function bindPersist(): () => void {
  void refreshPersist(true)
  if (!timer) {
    onVisible = () => {
      if (document.visibilityState === 'visible') void refreshPersist(true)
    }
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshPersist(true)
    }, 30_000)
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    onVisible = null
    if (timer) clearInterval(timer)
    timer = null
  }
}

/** 加入（弹层里那颗确认按钮） */
export async function addPersist(input: {
  base: string
  timeframe: string
  days: number
}): Promise<boolean> {
  persistBusy.value = true
  persistError.value = ''
  try {
    const r = await startPersist({
      symbol: input.base,
      market: 'swap',
      timeframe: input.timeframe,
      days: input.days
    })
    if (r.error) throw new Error(r.error)
    await refreshPersist(true)
    showToast(`${input.base} 已加入持久化分析（每 15 分钟一次，最长 8 小时）`)
    return true
  } catch (e) {
    persistError.value = (e as Error).message
    showToast(persistError.value, 'bad')
    return false
  } finally {
    persistBusy.value = false
  }
}

export async function removePersist(id: number): Promise<void> {
  persistBusy.value = true
  try {
    const r = await stopPersist(id)
    if (r.error) throw new Error(r.error)
    lastSeen.delete(id)
    await refreshPersist(true)
    showToast('已停止持久化分析')
  } catch (e) {
    showToast((e as Error).message, 'bad')
  } finally {
    persistBusy.value = false
  }
}

/** 立刻跑一轮（不等到下一个 15 分钟） */
export async function runPersistOnce(id: number): Promise<void> {
  persistBusy.value = true
  try {
    const r = await runPersistNow(id)
    if (r.error) throw new Error(r.error)
    await refreshPersist(true)
    showToast('这一轮跑完了')
  } catch (e) {
    showToast(`这一轮失败：${(e as Error).message}`, 'bad')
  } finally {
    persistBusy.value = false
  }
}

/** 剩余时长（人话：`7h24m`） */
export function leftText(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now()
  if (!(ms > 0)) return '已结束'
  const min = Math.floor(ms / 60_000)
  const h = Math.floor(min / 60)
  return h > 0 ? `${h}h${String(min % 60).padStart(2, '0')}m` : `${min}m`
}

/** 还剩几轮（32 次上限里） */
export function leftRuns(runs: number): number {
  return Math.max(0, 32 - runs)
}
