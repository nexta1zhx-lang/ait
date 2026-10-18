/**
 * 合约持仓的**前端唯一来源**。
 *
 * ⚠️ 别在别处再自己拉一份：以前 K 线叠加、下单页「仓位」格各按自己的定时器打
 * `/trade/positions`，同一屏的左侧栏和图上会**显示两个不同的持仓数**。
 *
 * 三条约定：
 *   · 后端常驻流一有变化就**通过 SSE 推**（事件 `positions`，见 `api.ts` 的 `PositionsPatch`）；
 *   · 只有「有人绑定了、SSE 又一直没来」时才拉一次 REST 兜底（后端有缓存，很便宜）；
 *   · 多个组件用**同一个 key** 只会开一条订阅（引用计数）。
 *
 * ## 形状约定
 *
 * 对外一律是 `TradePositionRow`（`symbol` = **币安原始符号**），
 * 跟 `/api/exchange/trade/positions` 那条接口一模一样 —— 这样 K 线叠加和下单页
 * 换过来的时候**一行比对逻辑都不用改**。
 */
import {computed, ref} from 'vue'
import {
  exchangeStream,
  fetchTradePositions,
  type AutoStopPush,
  type AutoTpPush,
  type FuturesPosition,
  type PositionsPatch,
  type TradePositionRow
} from './api'

/** 兜底轮询间隔：SSE 静默这么久才自己去拉一次 */
const FALLBACK_MS = 60_000

/**
 * 「SSE 不可信、刚用 REST 兜了一次」的计数器（只在**兜底轮询真的发出去**时 +1）。
 *
 * 谁用：K 线那几条挂单线 —— 它们的数据没有轮询了，全靠 SSE 事件推；
 * 万一连 SSE 都断着，就跟着这里一起补一次，不至于一直冻着。
 */
export const positionsFallbackAt = ref(0)
const availableBalances = ref<Record<number, {value: number; at: number}>>({})

export function setAvailableBalance(
  keyId: number | undefined,
  value: number | null | undefined,
  at = Date.now()
): void {
  if (typeof keyId !== 'number' || keyId <= 0) return
  if (value === null || value === undefined || !Number.isFinite(Number(value)))
    return
  if ((availableBalances.value[keyId]?.at ?? 0) > at) return
  availableBalances.value = {
    ...availableBalances.value,
    [keyId]: {value: Number(value), at}
  }
}

/**
 * 这套账户现在的**权益** = 钱包余额 + 未实现盈亏 —— 后端那三条上限
 * （`assertOrderLimits`）、面板的「5 倍额度」用的都是这个口径。
 *
 * 数据来自常驻流（SSE 每次推持仓都带），所以它**跟着行情实时动**；
 * 拿不到（还没读到）时返回 `null`，调用方退回自己手上那份。
 */
export function accountEquityOf(keyId: number | undefined): number | null {
  if (typeof keyId !== 'number' || keyId <= 0) return null
  const k = perKey.value[keyId]
  if (!k) return null
  const wallet = Number(k.wallet ?? 0)
  if (!(wallet > 0)) return null
  return wallet + Number(k.unrealized ?? 0)
}

export function availableBalanceOf(keyId: number | undefined): number | null {
  if (typeof keyId !== 'number' || keyId <= 0) return null
  return availableBalances.value[keyId]?.value ?? null
}

/** SSE 数据比这个新就认为「推送还活着」，兜底轮询跳过 */
const FRESH_MS = 30_000

interface KeyRows {
  at: number
  live: boolean
  rows: TradePositionRow[]
  /**
   * 账户级那几个数（2026-10-06 加，为「MM 保证金率」）：
   * 保证金率 = `maintMargin` ÷ `margin`，到 100% 就是强平。
   * ⚠️ 只有 SSE 的 `positions` 增量里才有（REST 兜底那发后端也回，见 `load`）。
   */
  wallet: number
  unrealized: number
  margin: number
  maintMargin: number
}

/** keyId → 那套账户的持仓 */
const perKey = ref<Record<number, KeyRows>>({})
/** 最近一次读数的错误（界面上顶多提示一句） */
export const positionsErr = ref('')

/**
 * 自动止损的推送（后端后台挂完之后推的）+ 界面这一侧的订阅口。
 *
 * ⚠️ 只有**这条流活着**才收得到（页面在后台时会断开，那是设计如此）——
 *    收不到也不影响止损：它该挂还是挂了，只是少一句提示。
 */
const autoStopListeners = new Set<(r: AutoStopPush) => void>()

/** 订阅「自动止损挂完了」；返回退订函数（组件卸载时调） */
export function onAutoStop(cb: (r: AutoStopPush) => void): () => void {
  autoStopListeners.add(cb)
  return () => autoStopListeners.delete(cb)
}

/**
 * 订阅「加仓后止盈放大完了」（后台改的；见 `POST /api/exchange/trade/order`）。
 * 同样只有这条流活着才收得到 —— 收不到不影响止盈已经改好了。
 */
const autoTpListeners = new Set<(r: AutoTpPush) => void>()

export function onAutoTp(cb: (r: AutoTpPush) => void): () => void {
  autoTpListeners.add(cb)
  return () => autoTpListeners.delete(cb)
}

/** 每个 key 的订阅（引用计数到 0 才真的退订） */
const stops = new Map<number, () => void>()
const refs = new Map<number, number>()
let pollTimer: ReturnType<typeof setInterval> | null = null

/* ---------------- 对外只读状态 ---------------- */

/** 所有绑定账户的持仓（合并；每条带 `keyName` 的由调用方自己按需加） */
export const positionsRows = computed<TradePositionRow[]>(() => {
  const out: TradePositionRow[] = []
  for (const k of Object.values(perKey.value)) out.push(...k.rows)
  /* 名义大的排前面：跟后端 `listPositions` 一个排序，切过来不会「跳一下」 */
  out.sort((a, b) => (b.notional ?? 0) - (a.notional ?? 0))
  return out
})

/** 按**币安原始符号**分好组（K 线叠加 / 下单页都是「只要这个币的」） */
export const positionsBySymbol = computed<Map<string, TradePositionRow[]>>(() => {
  const m = new Map<string, TradePositionRow[]>()
  for (const r of positionsRows.value) {
    const key = String(r.symbol ?? '').toUpperCase()
    const hit = m.get(key)
    if (hit) hit.push(r)
    else m.set(key, [r])
  }
  return m
})

/** 数据时间（毫秒，取**最新**的那一套） */
export const positionsAt = computed(() => {
  let at = 0
  for (const k of Object.values(perKey.value)) if (k.at > at) at = k.at
  return at
})

/**
 * **某套账户的风险读数**（2026-10-06，用户要「配置旁显示 MM 合约保证金率」）。
 *
 * · `maintMargin` = Σ 维持保证金（后端随标记价重算过 ⇒ 一秒都在动）
 * · `margin` = 保证金余额 = 钱包 + 浮盈
 * · `ratio` = 保证金率 %，**到 100 就是强平**（跟币安界面同一个口径）
 *
 * 没有任何仓位 / 还没拿到数 ⇒ `null`（界面**不显示**，别摆一个假的 0%）。
 */
export function accountRiskOf(keyId: number | undefined): {
  maintMargin: number
  margin: number
  ratio: number | null
} | null {
  if (typeof keyId !== 'number' || keyId <= 0) return null
  const k = perKey.value[keyId]
  if (!k) return null
  const ratio = k.margin > 0 ? (k.maintMargin / k.margin) * 100 : null
  return {maintMargin: k.maintMargin, margin: k.margin, ratio}
}

/** 某个交易对现在的持仓（原始符号；没有就是空数组） */
export function positionsOf(rawSymbol: string): TradePositionRow[] {
  return positionsBySymbol.value.get(String(rawSymbol).toUpperCase()) ?? []
}

/**
 * 立刻去拉一次（**绕过后端缓存**）—— 下单 / 平仓 / 减仓之后用，
 * 不然列表要等到常驻流下一次推（最多 20 秒）才反映刚才那一单。
 *
 * 不传 `ids` = 所有已绑定的账户。
 */
export function refreshPositions(ids?: (number | undefined)[]): void {
  const list = ids?.length ? ids : [...refs.keys()]
  for (const id of list) {
    if (typeof id === 'number' && id > 0) void load(id, true)
  }
}

/* ---------------- 写入 ---------------- */

function apply(keyId: number, next: KeyRows): void {
  const cur = perKey.value[keyId]
  /* 别让一份「更旧」的盖掉更新的（底稿和 SSE 可能前后脚到） */
  if (cur && cur.at > next.at) return
  perKey.value = {...perKey.value, [keyId]: next}
}

function clear(keyId: number): void {
  if (!perKey.value[keyId]) return
  const next = {...perKey.value}
  delete next[keyId]
  perKey.value = next
}

/** 一条持仓（ccxt 统一符号 + `raw`）→ 对外那个 REST 形状（原始符号 + `unrealized`） */
function toRow(p: FuturesPosition): TradePositionRow {
  return {
    symbol: String(p.raw ?? p.symbol ?? '').toUpperCase(),
    side: p.side === 'short' ? 'short' : 'long',
    amount: Number(p.amount ?? 0),
    entryPrice: Number(p.entryPrice ?? 0),
    markPrice: Number(p.markPrice ?? 0),
    unrealized: Number(p.unrealizedPnl ?? 0),
    notional: Number(p.notional ?? 0),
    leverage: Number(p.leverage ?? 0),
    liquidationPrice: p.liquidationPrice ?? null,
    /* 账本侧（开仓时间 / 已实现）—— 常驻流每次推送都带；没有就是 `null` */
    meta: p.meta ?? null
  }
}

/**
 * REST 兜底那份持仓**不带**账本侧信息（`meta`），但它有可能晚于 SSE 到、
 * 把 SSE 那份盖掉。所以这里把上一次同一个币、**数量与开仓价都对得上**的 `meta`
 * 继承过来 —— 否则每次 `refreshPositions()` 都会让「已实现 / 已开仓时间」闪成 `—`。
 */
function inheritMeta(keyId: number, p: TradePositionRow): TradePositionRow {
  const prev = perKey.value[keyId]?.rows ?? []
  const hit = prev.find(
    r =>
      r.symbol === p.symbol &&
      r.side === p.side &&
      Math.abs(r.amount - p.amount) < 1e-12 &&
      Math.abs(r.entryPrice - p.entryPrice) < 1e-12
  )
  return hit?.meta ? {...p, meta: hit.meta} : p
}

/* ---------------- 取数 ---------------- */

/**
 * 拉一次 REST 兜底（后端那边有 TTL + 单飞 + 权重预算，多拉几次也不贵）。
 *
 * ⚠️ 失败**不清空**手上这份 —— 拉不到就把旧数字留着（清空比旧数字糟得多）。
 */
async function load(keyId: number, fresh = false): Promise<void> {
  /* 记**发出**的时刻（本地钟）当这条数据的时间戳 ——
     晚发的赢，慢慢回来的 REST 不会盖掉更新的 SSE 推送（见 `apply`） */
  const startedAt = Date.now()
  try {
    const r = await fetchTradePositions(keyId, fresh)
    if (!r.ok) {
      positionsErr.value = r.error || '读不到持仓'
      return
    }
    positionsErr.value = ''
    setAvailableBalance(keyId, r.available)
    const rows = (r.positions ?? []).map(p => {
      const row: TradePositionRow = {
        ...p,
        symbol: String(p.symbol ?? '').toUpperCase()
      }
      return inheritMeta(keyId, row)
    })
    apply(keyId, {
      at: startedAt,
      live: Boolean(r.live),
      rows,
      wallet: Number(r.wallet ?? 0),
      unrealized: Number(r.unrealized ?? 0),
      margin: Number(r.margin ?? 0),
      /* 后端没回（没有常驻流）就按持仓逐条加起来 —— 口径一样 */
      maintMargin: Number(
        r.maintMargin ?? rows.reduce((sum, p) => sum + (p.maintMargin ?? 0), 0)
      )
    })
  } catch (e) {
    positionsErr.value = e instanceof Error ? e.message : String(e)
  }
}

function start(keyId: number): void {
  /* 底稿先拿一份（SSE 那条 `positions` 底稿也快，但这条接口是同步返回、更稳） */
  void load(keyId)
  stops.set(
    keyId,
    exchangeStream(keyId, {
      positions: (p: PositionsPatch) => {
        positionsErr.value = ''
        setAvailableBalance(keyId, p.available)
        apply(keyId, {
          /* 账户级那几个数（算保证金率要用）—— 每次持仓推送都会带上 */
          wallet: Number(p.wallet ?? 0),
          unrealized: Number(p.unrealized ?? 0),
          margin: Number(p.margin ?? 0),
          maintMargin: Number(p.stats?.maintMargin ?? 0),
          /*
           * ⚠️ 用**本地收到的时间**排队，不解析服务端的 `p.at` ——
           *    两边钟差一点的话，服务端时间戳会让「新旧判断」整个反过来。
           */
          at: Date.now(),
          live: Boolean(p.live),
          rows: (p.positions ?? []).map(toRow)
        })
      },
      /* 自动止损挂完了（后台挂）⇒ 转给订阅者（下单面板会补一句提示） */
      autoStop: r => {
        for (const cb of autoStopListeners) cb(r)
      },
      /* 加仓后止盈放大完了 ⇒ 同样转给订阅者 */
      autoTp: r => {
        for (const cb of autoTpListeners) cb(r)
      },
      /* 这套账户不参与统计（现货 / 没填 Key）→ 别留着上一份数据 */
      reject: () => clear(keyId),
      /* 断够了时间又连回来：补一次，别等下一轮推送 */
      reconnect: () => void load(keyId)
    })
  )
}

function syncPoll(): void {
  const want = refs.size > 0
  if (want && !pollTimer) {
    pollTimer = setInterval(() => {
      for (const keyId of refs.keys()) {
        /* SSE 还活着（刚推过）就不白拉一次 */
        const cur = perKey.value[keyId]
        if (cur && Date.now() - cur.at < FRESH_MS) continue
        void load(keyId)
        /*
         * ★ 这一拍**只有 SSE 哑了才会走到**（上面那句 `continue`）——所以它正好是
         *   「推送不可信了、谁都得自己 REST 兜底」的信号：K 线的挂单线也挂在这条上
         *   （见 `KlineChart.scheduleOverlayPull`），免得连 SSE 都断着的时候那几条线一直冻着。
         */
        positionsFallbackAt.value++
      }
    }, FALLBACK_MS)
    return
  }
  if (!want && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * 绑定一批账户的持仓。返回解绑函数（组件卸载时务必调用）。
 *
 * 同一个 key 被多个组件绑定时只开**一条** SSE 订阅，全部解绑才退。
 */
export function bindPositions(ids: (number | undefined)[]): () => void {
  const wanted = [
    ...new Set(ids.filter((x): x is number => typeof x === 'number' && x > 0))
  ]
  for (const id of wanted) {
    refs.set(id, (refs.get(id) ?? 0) + 1)
    if (!stops.has(id)) start(id)
  }
  syncPoll()

  return () => {
    for (const id of wanted) {
      const left = (refs.get(id) ?? 1) - 1
      if (left > 0) {
        refs.set(id, left)
        continue
      }
      refs.delete(id)
      stops.get(id)?.()
      stops.delete(id)
      clear(id)
    }
    syncPoll()
  }
}
