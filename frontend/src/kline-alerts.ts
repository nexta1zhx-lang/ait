/**
 * **画线提醒**的前端那一份共享状态（2026-10-17）。
 *
 * 为什么要有这个文件：提醒有两个地方在显示 ——
 *   · K 线上那条线右端的铃铛 / 面板上的「取消提醒」（`comps/KlineChart.vue`）；
 *   · 自动化预测 → 「提醒」那一格（`views/AutoPredictView.vue`）。
 * 一开始两边各拉各的（K 线只在进页面 / 换币时拉一次），于是**不同步**：
 * 在提醒页删掉一条、或者服务器那边已经触发（铃铛该灭），K 线上还挂着旧状态；
 * 更糟的是 K 线那次「对不上就清掉挂接」会**把重新盯的线索也抹掉**。
 *
 * 现在只有这一份数据：谁改了（新建 / 删除 / 重新盯）就 `noteAlertsChanged()`，
 * 另一边立刻跟着变；服务器自己触发的（网页不开也会响那种）靠 `refresh()` 轮询。
 *
 * ⚠️ 轮询打的是 `/api/kline/alerts`（纯读库），**不碰交易所、不计权重**，可以随便刷。
 */
import {ref} from 'vue'
import {fetchKlineAlerts, type KlineAlert} from './api'

/** 这个账号的全部提醒（新的在前） */
export const klineAlerts = ref<KlineAlert[]>([])
/** 上一次成功拉到的时间（做「多久内不重复拉」用） */
export const klineAlertsAt = ref(0)

/** 这么新的就不重复拉了（两端同时要的时候只发一次） */
const FRESH_MS = 15_000
let inFlight: Promise<void> | null = null
/** 请求发出后本地又改过 ⇒ 回来的那份已经过期，扔掉 */
let revision = 0

/**
 * 拉一次。
 * @param force 忽略新鲜度（点「刷新」、刚改完、回到前台时用）
 */
export async function refreshKlineAlerts(force = false): Promise<void> {
  if (!force && Date.now() - klineAlertsAt.value < FRESH_MS) return
  if (inFlight) return inFlight
  const mine = revision
  const req = fetchKlineAlerts()
    .then(r => {
      if (revision !== mine) return
      klineAlerts.value = r.alerts
      klineAlertsAt.value = Date.now()
    })
    .catch(() => {
      /* 拉不到就先留着上一份：铃铛顶多晚一点灭，不能把已挂的提醒全抹掉 */
    })
  inFlight = req
  try {
    await req
  } finally {
    if (inFlight === req) inFlight = null
  }
}

/** 刚在任意一端改过（新建 / 删除 / 重新盯）→ 立刻重拉，让另一边同一步跟上 */
export async function noteAlertsChanged(): Promise<void> {
  revision++
  await refreshKlineAlerts(true)
}

/** 还在等的那几条（`active`）—— K 线上的铃铛只认这些 */
export function activeAlerts(base?: string): KlineAlert[] {
  const sym = base ? String(base).toUpperCase() : ''
  return klineAlerts.value.filter(
    a => a.status === 'active' && (!sym || a.symbol === sym)
  )
}

/** 按 id 找（找不到 = 那条已经被删了） */
export function alertById(id: number): KlineAlert | null {
  return klineAlerts.value.find(a => a.id === id) ?? null
}
