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
import {enteredGo} from './markdown'
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
 * 只有**转成「可做」**那一刻才弹一条站内提示（用户 2026-10-15：「只有可做才弹窗」）：
 * 32 条里通常只有几条有意义；"可做 → 走弱"和"不可做 ↔ 观望"都不弹（后两者是噪音）。
 * 判据在 `markdown.ts` 的 `enteredGo()`（跟后端同一套）。
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
      /* 判据跟后端一致：只在**转成可做**时弹 */
      if (!enteredGo(prev.verdict, s.lastVerdict ?? '')) continue
      const label = (v: string): string =>
        v === 'go' ? '可做' : v === 'no' ? '不可做' : '观望'
      showToast(
        `${s.symbol} 转可做：${prev.verdict ? `${label(prev.verdict)} → ` : ''}` +
          `可做（持久化分析第 ${s.runs} 次）`,
        'ok'
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

/**
 * 时间线里「+1h / +4h」那两格的显示口径（**两处共用这一份**：K 线弹层 + AI 分析）。
 *
 * ★ 2026-10-15 用户看着一列 `—` 问「为什么没数值」—— 那会儿每条记录都还不到 1 小时，
 *   本来就是「还没到点」。所以这里把那格分成三种情况：
 *     · 有数          → `+0.8%`（涨绿跌红）
 *     · **还没到点**  → `还剩 43m`（灰字倒计时；免得看着像坏了）
 *     · 过了点还是空  → `—`（那才是真缺那根 K 线，鼠标悬停给提示）
 */
export function chgText(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`
}

export function chgClass(v: number | null): string {
  return v === null ? '' : v >= 0 ? 'up' : 'down'
}

/** 离「那一刻 + `hours` 小时」还剩多久（人话）；已经过了就返回空串 */
export function untilText(createdAt: string, hours: number, now = Date.now()): string {
  const at = new Date(createdAt).getTime()
  if (!Number.isFinite(at)) return ''
  const ms = at + hours * 3600_000 - now
  if (!(ms > 0)) return ''
  const min = Math.ceil(ms / 60_000)
  if (min >= 120) {
    const h = Math.floor(min / 60)
    return `${h}h${String(min % 60).padStart(2, '0')}m`
  }
  return `${min}m`
}

/**
 * 时间线里「+1h / +4h」那一格要显示什么（**两处共用**：K 线弹层、AI 分析）。
 *
 * 行都长这样：`{createdAt, after1h, after4h}`（后端现算的）。
 *   · 有数        → `+0.8%`（`cls` = up/down）
 *   · 还没到点    → `43m后`（`cls` = pending，灰字倒计时）
 *   · 过了点还空  → `—`（`cls` 空；那才是真缺那根 K 线）
 *
 * ⚠️ 别写成「还剩 43m」：窄屏那两列只有 68px，长这样会被右边缘切掉
 *    （用户 2026-10-15 截图：「压缩了」）。列头已经写了 +1h / +4h，一个「后」够读。
 */
export interface AfterCell {
  text: string
  cls: string
}

export function afterCell(
  row: {createdAt: string; after1h: number | null; after4h: number | null},
  hours: 1 | 4
): AfterCell {
  const v = hours === 1 ? row.after1h : row.after4h
  if (v !== null) return {text: chgText(v), cls: chgClass(v)}
  const left = untilText(row.createdAt, hours)
  return left ? {text: `${left}后`, cls: 'pending'} : {text: '—', cls: ''}
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
