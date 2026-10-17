/**
 * 黑名单的**前端那份状态**（用户 2026-10-10）。
 *
 * 用户：「在 k 线界面收藏按钮旁加个图标，点击后弹窗确认，加入黑名单后 24 小时不得开单，
 * 右侧显示倒计时，做单按钮禁用」→ 2026-10-17：「黑名单机制改为 8 小时」
 * → 2026-10-18：「可选择封禁时间，最大 24 小时……点击 8 次可取消封禁」。
 * ⚠️ 默认时长和上限都是**后端**给的（`BLACKLIST_DEFAULT_HOURS` / `BLACKLIST_MAX_HOURS`），
 *    接口一起回过来；下面那两个数只是还没拿到接口时的兜底。
 *
 * 跟 `pins.ts` 一个路数：消息放模块作用域（切页不丢），拉回来按 revision 防串。
 *
 * ⚠️ **真正拦下单的是后端**（`/api/exchange/trade/order` 里那道闸）——
 *    这里只管三件事：倒计时怎么显示、按钮禁不禁用、点那颗小锁时弹什么确认框。
 *    前端这份数据坏掉 / 没拉到，最多是按钮看着能用，点了也会被后端拦住。
 */
import {ref} from 'vue'
import {fetchBlacklist, lockBase, unlockBase} from './api'

/** base（大写）→ 解锁时刻（毫秒）。到点自己就不算了，不用等接口 */
export const blacklistUntil = ref<Record<string, number>>({})
/** 默认锁多久（小时）—— 只用来写文案 / 当选择器的初始值；真值以后端回的为准 */
export const blacklistHours = ref(8)
/** 一次最多锁多久（小时）—— 用户 2026-10-18：「最大 24 小时」 */
export const blacklistMaxHours = ref(24)

const FRESH_MS = 20_000
let loadedAt = 0
let inFlight: Promise<void> | null = null
let revision = 0

function apply(entries: {base: string; until: string}[]): void {
  const next: Record<string, number> = {}
  for (const e of entries) {
    const at = Date.parse(e.until)
    if (Number.isFinite(at)) next[String(e.base).toUpperCase()] = at
  }
  blacklistUntil.value = next
}

export async function ensureBlacklist(): Promise<void> {
  if (Date.now() - loadedAt < FRESH_MS) return
  if (inFlight) return inFlight

  const mine = revision
  const req = fetchBlacklist().then(r => {
    /* 中间有人锁过一个（revision 变了）⇒ 这份回来得比它晚，扔掉，别把新的盖回去 */
    if (revision !== mine) return
    apply(r.entries ?? [])
    blacklistHours.value = r.hours || 8
    blacklistMaxHours.value = r.maxHours || 24
    loadedAt = Date.now()
  })
  inFlight = req
  try {
    await req
  } finally {
    if (inFlight === req) inFlight = null
  }
}

/**
 * 关进去 `hours` 小时。回来的是**锁完之后的完整列表**（后端给的），直接整份换上 ——
 * 别的设备刚锁的那些也就一起看到了。
 * @returns 这一条的解锁时刻（毫秒）
 */
export async function lockCurrentBase(
  base: string,
  hours = blacklistHours.value
): Promise<number> {
  const r = await lockBase(base, hours)
  if (r.error) throw new Error(r.error)
  revision++
  apply(r.entries ?? [])
  blacklistHours.value = r.hours || 8
  blacklistMaxHours.value = r.maxHours || 24
  loadedAt = Date.now()
  return Date.parse(r.until)
}

/**
 * 提前解除（用户 2026-10-18：「点击 8 次可取消封禁」）。
 *
 * ⚠️ 界面上**没有**解锁按钮 —— 只挂在「连点那颗 🚫 八下」的手势上，
 *    连点和二次确认就是给「给自己上锁」这件事留的摩擦。
 */
export async function unlockCurrentBase(base: string): Promise<boolean> {
  const r = await unlockBase(base)
  if (r.error) throw new Error(r.error)
  revision++
  apply(r.entries ?? [])
  loadedAt = Date.now()
  return r.removed
}

/**
 * 这个币还锁多久（毫秒）。`0` = 没锁 / 已经到期。
 *
 * ⚠️ `now` 由调用方传（一般传 `ticker.ts` 里那个每秒跳的 `nowTick`）——
 *    在这儿自己读 `Date.now()` 的话，模板不会因为时间流逝而重算，倒计时就定住了。
 */
export function lockLeftMs(base: string, now: number): number {
  const until = blacklistUntil.value[String(base ?? '').toUpperCase()] ?? 0
  return until > now ? until - now : 0
}

/** 毫秒 → `hh:mm:ss`（倒计时那枚小牌子用） */
export function lockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

/** 解锁时刻（毫秒）—— 只在标题里写「几点解锁」用；没锁 → 0 */
export function lockUntilOf(base: string): number {
  return blacklistUntil.value[String(base ?? '').toUpperCase()] ?? 0
}
