<script setup lang="ts">
/**
 * 「交易所资产」的**真数据容器**（M3）。
 *
 * 干三件事：
 *   ① **先读库里最新一条快照**渲染（毫秒级，不打交易所）→ 旧了就后台刷新
 *      （stale-while-revalidate，所以界面永远不会有 loading 空等）
 *   ② **订阅 SSE**：WS 一有动静后端就落一条并推过来 → 数字秒跳，
 *      不用等 5 分钟采样、也不用用户手动 ⟳
 *   ③ 下面两个 tab 各取所需：**成交/盈亏读后端账本**（WS 实时落 + 断线后 RESF 补，
 *      **不需要交易对**），**挂单打交易所**（秒级变化的东西，不进快照）
 *
 * ⚠️ 分层（跟已经删掉的老面板不同）：老的把 5 个交易所调用塞进一个请求、
 *    每次都要现拉；这个首屏只读库，慢的东西（挂单）拆开按需查。
 */
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import ExchangeAccountBoard from './ExchangeAccountBoard.vue'
import TransferSheet from './TransferSheet.vue'
import ReduceSheet from './ReduceSheet.vue'
import type {PositionRef} from './ExchangeAccountBoard.vue'
import {usePullRefresh} from '../pull-refresh'
import {testOrder} from '../settings'
import {askConfirm} from '../confirm'
import {showToast} from '../toast'
import {isForeground} from '../live'
import {
  closeTradePositions,
  exchangeStream,
  fetchExchangeCurve,
  fetchExchangeFills,
  fetchExchangeKeys,
  fetchExchangeIncome,
  fetchExchangeOpenOrders,
  fetchExchangePositionHistory,
  fetchExchangeOverview,
  fetchRate,
  isAuthError,
  refreshExchangeOverview,
  type CurvePoint,
  type ExchangeIncomeRow,
  type ExchangeIncomeTotals,
  type ExchangeKey,
  type ExchangeOpenOrder,
  type ExchangeOverview,
  type ExchangePositionCycle,
  type ExchangeSnapshotResult,
  type ExchangeTrade,
  type FuturesAsset,
  type FuturesPosition
} from '../api'

/**
 * 快照超过这么久就后台刷一次（后端采样是 5 分钟，这里更积极）。
 *
 * ⚠️ 2026-10-05 从 60s 收到 **15s**：用户反馈「持仓…出来太慢」——
 *    后端采样本身是 5 分钟一次，页面一打开如果快照已经 40 秒没更新，
 *    就得等一分钟才看见刚开的仓。现在 15 秒以上的旧快照一进页面就刷。
 *    不会变成轮询：刷完 age 归零，要等它再旧过 15 秒才可能触发下一次。
 */
const REFRESH_AFTER_SEC = 15
/** 成交列表最多留多少条 */
const FILLS_MAX = 60
/** 「盈亏」看最近几天（`0` = 全部历史） */
const INCOME_DAYS = 7
/** 盈亏明细最多留多少条 */
const INCOME_MAX = 200
/** 仓位历史最多列多少段 */
const CYCLES_MAX = 50

const keys = ref<ExchangeKey[]>([])

/**
 * 选中的那一格：`'all'` = **全部**（多套 Key 加起来看），否则是某个 key 的 id（字符串）。
 *
 * 用户 2026-10-05：「交易所账户页面不要下拉框切换，改为 tab 全部 然后是每个 key 的名称」。
 * 用字符串是因为 `SegTabs` 的泛型是 `string | number`，混着传会被 TS 挑刺。
 *
 * ⚠️ 初值故意是**空串**而不是 `'all'`：挂载时一定会被赋成「全部」（或多套里的第一套），
 *    下面的 `watch(picked)` 才会动起来把数据拉进来。初值就写 `'all'` 的话，
 *    赋同样的值不触发 watch ⇒ 永远停在「正在取账户快照…」。
 */
const picked = ref<string>('')

const data = ref<ExchangeOverview | null>(null)
/** 「没有数据」的原因（现货 / 没填 key / 还没采过）—— 有值时界面直接说原因 */
const reason = ref('')
const err = ref('')

const refreshing = ref(false)

/**
 * 美元 → 人民币汇率（USDT / CNY 切换用）。
 * ⚠️ 取不到就不报错：`ExchangeAccountBoard` 那边退回 7.1 显示，
 *    汇率这种附属信息不该挡住整页资产。
 */
const rate = ref(0)

/* ---------------- 看哪几套 Key ---------------- */

/** 这次要看哪几套（「全部」= 所有；选中的那套被删了就退回全部） */
const activeTargets = computed<ExchangeKey[]>(() => {
  if (picked.value === 'all') return keys.value
  const hit = keys.value.filter(k => String(k.id) === picked.value)
  return hit.length ? hit : keys.value
})

/** 看的是**多套**（合并视图）—— 单套时不合并、也不打 key 标签，跟以前一模一样 */
const multi = computed(() => activeTargets.value.length > 1)

/**
 * **全部** Key（跟 `activeTargets` 的区别：那个是当前 tab 选中的）。
 * ⚠️ 盈亏汇总要算全部账户 —— 只算选中的那套，切 tab 时「净盈亏」会跳来跳去。
 */
const listAll = computed<ExchangeKey[]>(() => keys.value)

/** board 顶部那排 tab 的选项：`全部` + 每套的名字（只有一套时不摆 tab） */
const accountOptions = computed(() => {
  const list = keys.value.map(k => ({value: String(k.id), label: k.name}))
  return keys.value.length > 1 ? [{value: 'all', label: '全部'}, ...list] : list
})

/* ---------------- 每套 Key 各自的快照 → 合并成一份 ---------------- */

/** keyId → 那套的最新快照 */
const parts = ref<Record<number, ExchangeOverview>>({})
/** keyId → 那套「没数据」的原因 */
const partReasons = ref<Record<number, string>>({})

/**
 * keyId → 最近一次拿到**整份快照**的时刻（改造 P2）。
 *
 * ⚠️ 只记「整份」（`snapshot` 事件 / 首次读库 / 手动刷新），
 *    **不算** `positions` 补丁 —— 那个只带持仓，钱包 / C2C / 现货还是上一份快照的。
 *    兜底定时器靠它判断「这份数据整体是不是太旧了」。
 */
let snapAt: Record<number, number> = {}

/** keyId → 这套的 SSE 最后一次有动静的时刻（数据事件或 20 秒一次的心跳都算） */
let streamAt: Record<number, number> = {}

/**
 * 这些账户的 SSE **还活着吗**（心跳 20 秒一次，3 拍没来就当断了）。
 *
 * 活着 ⇒ 后端的 5 分钟采样 / 事件快照都会经同一条流推过来 ⇒
 * **前端一次交易所都不用打**。这是 2026-10-06 收敛掉的稳态最大一项
 * （原先每 90 秒 25 权重/套）。
 */
const STREAM_ALIVE_MS = 60_000

function streamAlive(keyId: number): boolean {
  return Date.now() - (streamAt[keyId] ?? 0) < STREAM_ALIVE_MS
}

/**
 * keyId → 后端报告「上游用户数据流哑了」。
 *
 * ⚠️ 为什么单开一个标记：**SSE 活着 ≠ 数据在动**。
 *    我们这条 SSE 每 20 秒有心跳，心跳能一直来；但上游那条币安用户数据流
 *    可能「连上了却一帧不推」（假 IP，见 `backend/src/data/kline-stream.ts` 头部），
 *    这时如果还按「流活着就别刷」收敛，界面就会**一直停在旧数上** ——
 *    用户最早提的「开仓半天交易所页面才有数据」就是这么来的。
 *    所以只有后端说「哑了」时，前端才恢复自己兜底刷。
 */
const deaf = ref<Record<number, boolean>>({})

/**
 * 把几套快照**加总**成一份（「全部」那一格用）。
 *
 * ⚠️ 只有一套时**原样返回** —— 保留 `account.name`、也不给行打 key 标签，
 *    单账户的界面跟以前完全一样。
 */
function mergeOverviews(
  list: {key: ExchangeKey; ov: ExchangeOverview}[]
): ExchangeOverview | null {
  if (!list.length) return null
  if (list.length === 1) return list[0]!.ov

  const sum = (f: (o: ExchangeOverview) => number): number =>
    list.reduce((a, p) => a + (Number(f(p.ov)) || 0), 0)

  /* 合约多资产：按币种加总（普通 U 本位账户只有 USDT 一行，但别假设） */
  const assetMap = new Map<string, FuturesAsset>()
  for (const p of list)
    for (const a of p.ov.futures?.assets ?? []) {
      const cur = assetMap.get(a.asset)
      if (cur) {
        cur.wallet += a.wallet
        cur.available += a.available
        cur.unrealized += a.unrealized
      } else {
        assetMap.set(a.asset, {
          asset: a.asset,
          wallet: a.wallet,
          available: a.available,
          unrealized: a.unrealized
        })
      }
    }

  /* C2C 钱包：同样按币种加总 */
  const c2cMap = new Map<string, {asset: string; balance: number; usdt: number | null}>()
  for (const p of list)
    for (const a of p.ov.c2c?.assets ?? []) {
      const cur = c2cMap.get(a.asset)
      if (cur) {
        cur.balance += a.balance
        cur.usdt = (cur.usdt ?? 0) + (a.usdt ?? 0)
      } else {
        c2cMap.set(a.asset, {
          asset: a.asset,
          balance: a.balance,
          usdt: a.usdt
        })
      }
    }

  /* 持仓：直接拼起来，**每条标上它来自哪套 Key**（用户：「其余针对 key 数据加标签」） */
  const positions: FuturesPosition[] = []
  for (const p of list)
    for (const pos of p.ov.futures?.positions ?? [])
      /* `keyId` 是给「减仓 / 平仓」用的（要知道拿哪套凭据去下单） */
      positions.push({...pos, keyName: p.key.name, keyId: p.key.id})

  const anyC2c = list.some(p => p.ov.c2c)
  /* 现货：**只要有一套报了数**就显示合计（都没报就 null，整块不出现）。
     老快照没有 spot 字段 ⇒ 那一套按 0 算，跟 `netOf` 的口径一致。 */
  const anySpot = list.some(p => p.ov.spot)

  return {
    account: {
      exchange: 'multi',
      name: '全部',
      sandbox: false,
      marketType: 'swap'
    },
    /* 取**最旧**那份的时间：合并视图的「几分钟前」按最差的说，别报喜不报忧 */
    takenAt: list.map(p => p.ov.takenAt).sort()[0] ?? new Date().toISOString(),
    /*
     * 合约那一块的「活」时间同样按**最差**的说：只要有一套没收到过推送，
     * 合并视图就不敢说自己是实时的（宁可说旧，也别把一套死的藏起来）。
     */
    liveAt: list.every(p => p.ov.liveAt)
      ? list.map(p => p.ov.liveAt!).sort()[0]
      : undefined,
    futures: {
      wallet: sum(o => o.futures?.wallet ?? 0),
      unrealized: sum(o => o.futures?.unrealized ?? 0),
      margin: sum(o => o.futures?.margin ?? 0),
      available: sum(o => o.futures?.available ?? 0),
      used: sum(o => o.futures?.used ?? 0),
      assets: [...assetMap.values()],
      positions
    },
    c2c: anyC2c
      ? {
          active: list.some(p => p.ov.c2c?.active),
          totalUsdt: sum(o => o.c2c?.totalUsdt ?? 0),
          assets: [...c2cMap.values()]
        }
      : null,
    spot: anySpot ? {usdt: sum(o => o.spot?.usdt ?? 0)} : null,
    stats: {
      longCount: sum(o => o.stats?.longCount ?? 0),
      shortCount: sum(o => o.stats?.shortCount ?? 0),
      notional: sum(o => o.stats?.notional ?? 0),
      unrealized: sum(o => o.stats?.unrealized ?? 0)
    }
  }
}

/** 按当前选中的那几套，把 `parts` 重新合成一份给界面 */
function rebuild(): void {
  const got: {key: ExchangeKey; ov: ExchangeOverview}[] = []
  const miss: string[] = []
  for (const k of activeTargets.value) {
    const ov = parts.value[k.id]
    if (ov) got.push({key: k, ov})
    else if (partReasons.value[k.id])
      miss.push(`${k.name}：${partReasons.value[k.id]}`)
  }
  if (!got.length) {
    data.value = null
    reason.value = miss.join('；') || '这些账户暂时都没有数据'
    return
  }
  reason.value = ''
  data.value = mergeOverviews(got)
}

const openOrders = ref<ExchangeOpenOrder[]>([])
const ordersErr = ref('')
const loadingOrders = ref(false)
/**
 * 拿到「旧值」之后补发一次的定时器（见 `loadOrders`）。
 * ⚠️ 要有它：不加的话每次 `stale` 都会排一个补发，切几下 tab 就能攒出一串请求。
 */
let ordersRetryTimer: ReturnType<typeof setTimeout> | null = null

const fills = ref<ExchangeTrade[]>([])

/** 净资产曲线（M4）：默认看 1 天 */
const curve = ref<CurvePoint[]>([])
const curveRange = ref('1d')
const curveBucketSec = ref(300)
/** 上次取曲线的时间 —— SSE 事件来得勤，靠它节流（别每个快照都拉一遍） */
let curveAt = 0

/* ---------------- 减仓 / 平仓（持仓卡片底部那两颗按钮） ---------------- */

/**
 * 操作结果提示 —— 走全站那一条（`../toast` 的 `showToast`，画在 `App.vue` 的 `ToastHost`）。
 *
 * ⚠️ 以前这一页自己攒了一份「面板底下一行小字」（`posMsg` + 4s 定时器）：
 *    有了全站 toast 之后就该归它，位置 / 停留时间 / 层级都别再各写一套。
 *    `tone` 缺省是成功（这个方法里多数是「✅ 已平仓」这种）。
 */
function sayMsg(text: string, tone: 'ok' | 'bad' = 'ok'): void {
  showToast(text, tone)
}

/** 正在提交（两颗按钮一起禁点） */
const posBusy = ref(false)

/** 正在减仓的那一条（null = 弹层关着） */
const reduceRow = ref<PositionRef | null>(null)

/** 那条持仓现在多大（从当前视图里找；找不到就 0，弹层只是少显示一行估算） */
const reducePos = computed<FuturesPosition | null>(() => {
  const r = reduceRow.value
  if (!r) return null
  const rows = data.value?.futures?.positions ?? []
  return (
    rows.find(
      p =>
        p.symbol === r.symbol &&
        p.side === r.side &&
        (!r.keyId || !p.keyId || p.keyId === r.keyId)
    ) ?? null
  )
})
const reduceAmount = computed(() => reducePos.value?.amount ?? 0)
const reduceNotional = computed(() => reducePos.value?.notional ?? 0)

/**
 * 币种简写（`1000LUNCUSDT` → `1000LUNC`），跟板子里同一个写法。
 * ⚠️ 持仓是 ccxt 统一写法（`1000LUNC/USDT:USDT`），所以先按 `/` 切一刀再剥 USDT ——
 *    不然弹层标题会写成「1000LUNC/USDT:」。
 */
function baseOf(symbol: string): string {
  const s = String(symbol).toUpperCase()
  return s.split('/')[0].replace(/USDT$/, '') || s
}

function openReduce(p: PositionRef): void {
  if (posBusy.value) return
  reduceRow.value = p
}

/** 减仓：市价 reduceOnly 只平一部分（真单，⚠️ 会真成交） */
async function confirmReduce(pct: number): Promise<void> {
  const r = reduceRow.value
  if (!r || posBusy.value) return
  posBusy.value = true
  try {
    const res = await closeTradePositions(
      {symbol: r.symbol, side: r.side, pct},
      r.keyId,
      /* ⚠️ 跟「配置 → 测试下单」保持一致：开着测试单就只校验，不然这里会真成交 */
      testOrder.value
    )
    if (res.ok) {
      reduceRow.value = null
      sayMsg(
        res.test
          ? `测试减仓通过校验：${baseOf(r.symbol)} ${pct}%（没进撮合）`
          : `已减仓 ${baseOf(r.symbol)} ${pct}%`
      )
      void doRefresh()
    } else {
      sayMsg(res.error || '减仓失败', 'bad')
    }
  } catch (e) {
    sayMsg(msg(e), 'bad')
  } finally {
    posBusy.value = false
  }
}

/** 平仓：整条市价全平（真单） */
async function closeRow(p: PositionRef): Promise<void> {
  if (posBusy.value) return
  const name = baseOf(p.symbol)
  const test = testOrder.value
  const ok = await askConfirm({
    title: `平掉 ${name} 这一条持仓？`,
    body: test
      ? {t: '测试单只发到币安测试接口，不进撮合、不会真平。', tone: 'num'}
      : {t: '真单：按市价全平这一条，会真的成交。', tone: 'warn'},
    okText: '平掉',
    danger: !test
  })
  if (!ok) return
  posBusy.value = true
  try {
    const res = await closeTradePositions(
      {symbol: p.symbol, side: p.side},
      p.keyId,
      testOrder.value
    )
    if (res.ok) {
      sayMsg(res.test ? `测试平仓通过校验：${name}（没进撮合）` : `已平仓 ${name}`)
      void doRefresh()
    } else {
      sayMsg(res.error || '平仓失败', 'bad')
    }
  } catch (e) {
    sayMsg(msg(e), 'bad')
  } finally {
    posBusy.value = false
  }
}

/**
 * 已实现盈亏 = 账本里带 realized 的那些（一笔成交一条）；多套时跟着成交一起带 key 名
 *
 * ★ 2026-10-06 换成钱账本（`/api/exchange/income`）—— 这里只留容器，
 *   取数在 `loadIncome()`（那个才是权威口径：已实现 + 手续费 + 资金费）。
 */
const income = ref<ExchangeIncomeRow[]>([])
/** 盈亏汇总（已实现 / 手续费 / 资金费 / 净）—— 后端按交易所口径算好的 */
const incomeTotals = ref<ExchangeIncomeTotals | null>(null)

/**
 * **仓位历史**（用户 2026-10-06 定的口径）：开仓 → 全平算一笔。
 * ⚠️ 不是 income 的分类统计 —— 那个只用来给持仓卡上的「已结」供数。
 */
const cycles = ref<ExchangePositionCycle[]>([])
const openCycles = ref<ExchangePositionCycle[]>([])
const cyclesSince = ref<string | null>(null)

/** 读仓位历史（**纯本地**，不打交易所） */
async function loadCycles(): Promise<void> {
  const list = listAll.value
  const many = multi.value
  const closed: ExchangePositionCycle[] = []
  const open: ExchangePositionCycle[] = []
  let since: string | null = null
  for (const k of list) {
    try {
      const r = await fetchExchangePositionHistory(k.id, CYCLES_MAX)
      if (r.since && (!since || r.since < since)) since = r.since
      for (const c of r.cycles ?? [])
        closed.push(many ? {...c, keyName: k.name} : c)
      for (const c of r.open ?? []) open.push(many ? {...c, keyName: k.name} : c)
    } catch (e) {
      if (!isAuthError(e)) err.value = `读取仓位历史失败：${msg(e)}`
    }
  }
  cycles.value = closed
  openCycles.value = open
  cyclesSince.value = since
}

const loading = computed(() => !data.value && !reason.value && !err.value)

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 读当前选中那几套的快照（不合并、各自塞进 `parts`），读完整合一次。
 *
 * `refreshStale`：旧的 / 还没采过的，顺手后台刷一遍 ——
 * 用户看到的是上一份快照（可能几小时前的），界面不空等。
 */
async function loadSnapshots(): Promise<void> {
  const list = activeTargets.value
  if (!list.length) return
  const res = await Promise.all(
    list.map(k =>
      fetchExchangeOverview(k.id).then(
        r => ({k, r, e: null as unknown}),
        e => ({k, r: null, e})
      )
    )
  )
  const next = {...parts.value}
  const nextReason = {...partReasons.value}
  let stale = false
  for (const item of res) {
    if (item.e) {
      if (!isAuthError(item.e)) err.value = `读取快照失败：${msg(item.e)}`
      continue
    }
    const r = item.r as ExchangeSnapshotResult
    const id = item.k.id
    if (r.noSnapshot) {
      nextReason[id] = r.reason ?? '这个账户暂时没有数据'
      delete next[id]
      /* `canRefresh === false` 是「刷也没用」（现货 / 没填 key） */
      if (r.canRefresh !== false) stale = true
      continue
    }
    if (r.overview) {
      /* 库里那条的时间：后端给的 `ageSec` 反推出来 */
      const dbAt = Date.now() - (r.ageSec ?? 0) * 1000
      const knownAt = snapAt[id] ?? 0
      /*
       * ⚠️ **别拿更旧的盖掉更新鲜的** —— 常驻流一直在推（1 秒级），
       *    而库里那条 5 分钟才写一次。不加这个判断，换一次 tab 就会把
       *    刚推过来的新数**退回**成库里那份旧的（越刷新越旧，很难查）。
       */
      if (!(next[id] && dbAt <= knownAt)) {
        next[id] = r.overview
        snapAt = {...snapAt, [id]: dbAt}
      }
      delete nextReason[id]
    }
    /*
     * 该不该主动刷一次：看**手上这份数据多旧**（不是库里那行），
     * 而且**只在流不活着、或者后端说上游哑了的时候**才刷 ——
     * 流真正活着就说明后端会自己推（含 5 分钟采样），切 tab 不该白打一遍交易所。
     * ⚠️ 「后端说哑了」这一条不能省：SSE 心跳一直有，但上游可能一帧不推。
     */
    if (
      (!streamAlive(id) || deaf.value[id] === true) &&
      Date.now() - (snapAt[id] ?? 0) > REFRESH_AFTER_SEC * 1000
    )
      stale = true
    if (r.err) err.value = `上次采集不完整：${r.err}`
  }
  parts.value = next
  partReasons.value = nextReason
  rebuild()
  if (stale) void doRefresh(true)
}

/**
 * 去拉一次新的（慢，~2 秒/套）。⚠️ 并发保护：SSE 和自动刷新可能同时想刷。
 * 多套时**串行**刷（并发打交易所容易被限频）。
 */
/**
 * 上一次「用户手动刷新」的时间 —— **前端再防一道抖**（后端另有一道，见 `FORCED_MIN_MS`）。
 *
 * ⚠️ 用户要求：「不是每次刷新都要请求接口，要限流节流防抖」。下拉/按钮连点、
 *    手指抖动都算一次手势，别让它们变成一串请求打交易所。
 */
let lastManualAt = 0
const MANUAL_MIN_MS = 1500

/**
 * `auto = true` —— **前端自己兜底**触发的那次（快照旧了 / 流没活着 / 兜底定时器）。
 * 这种「顺手刷一下」**不该**把成交 / 挂单 / 钱账本也全对一遍（那是用户主动刷新才做的事，
 * 见 `wakeExchangeStream` 的 `force`）—— 用户明确说过「不是每次刷新都要请求接口」。
 */
async function doRefresh(auto = false): Promise<void> {
  if (refreshing.value) return
  if (Date.now() - lastManualAt < MANUAL_MIN_MS) return
  const list = activeTargets.value
  if (!list.length) return
  lastManualAt = Date.now()
  refreshing.value = true
  try {
    const next = {...parts.value}
    const nextReason = {...partReasons.value}
    /*
     * ★ 2026-10-06：**几套并发刷**（用户：「刷新图标为什么转那么久」）。
     *
     * 原来是 `for` 一套一套 await：一次刷新经出口隧道本来就要 0.4~0.7 秒
     * （后端那边也改成四路并发了，见 `fetchExchangeOverview`），
     * 两套串起来就是 1.5 秒、三套 2 秒多 —— 转圈转的就是这段。
     * 几套之间**互不依赖**（各自一份快照），并发出去总耗时 = 最慢那一套。
     */
    const results = await Promise.allSettled(
      list.map(k => refreshExchangeOverview(k.id, auto).then(r => ({k, r})))
    )
    let authDead = false
    for (const item of results) {
      if (item.status === 'rejected') {
        if (isAuthError(item.reason)) authDead = true
        else err.value = `刷新失败：${msg(item.reason)}`
        continue
      }
      const {k, r} = item.value
      if (r.overview) {
        /* 用户手动刷新拿到的新数据 ⇒ 合约那块也是刚问过的（同上） */
        next[k.id] = {...r.overview, liveAt: new Date().toISOString()}
        delete nextReason[k.id]
        snapAt = {...snapAt, [k.id]: Date.now()}
      } else if (r.reason) {
        nextReason[k.id] = r.reason
        delete next[k.id]
      }
    }
    /* ⚠️ 认不出身份就别往下写状态了：调用方会去重新登录（跟原来 `return` 同一个意思） */
    if (authDead) return
    parts.value = next
    partReasons.value = nextReason
    rebuild()
    // 用户主动刷新 = 想看到最新状态，曲线也顺手重拉
    void loadCurve()
  } finally {
    refreshing.value = false
  }
}

/*
 * 移动端下拉刷新（用户：「移动端做下滑刷新」）—— 见 `pull-refresh.ts` 里那段说明：
 * 它是「后台对账降频」的前提，因为给得手动兜底，才敢把自动请求砍下来。
 * 触发的就是上面那个 `doRefresh()`（跟 ⟳ 按钮同一条路，一样有防抖）。
 */
const {
  pull: pullY,
  state: pullState,
  onTouchStart: onPullStart,
  onTouchMove: onPullMove,
  onTouchEnd: onPullEnd
} = usePullRefresh(() => doRefresh())

/** 成交账本：几套合起来、按时间倒序（多套时每条标出是哪套的） */
async function loadFills(): Promise<void> {
  const list = activeTargets.value
  const many = multi.value
  const all: ExchangeTrade[] = []
  for (const k of list) {
    try {
      const r = await fetchExchangeFills(k.id, FILLS_MAX)
      for (const t of r.fills ?? []) all.push(many ? {...t, keyName: k.name} : t)
    } catch (e) {
      if (!isAuthError(e)) err.value = `读取成交失败：${msg(e)}`
    }
  }
  all.sort((a, b) =>
    String(b.datetime ?? '').localeCompare(String(a.datetime ?? ''))
  )
  fills.value = all.slice(0, FILLS_MAX)
}

/**
 * 钱账本（`/fapi/v1/income` 的落库版）—— 「盈亏」tab 的数据源。
 *
 * ★ 2026-10-06 统一：**不再**从 `fills.realized` 现算（那是毛数，漏手续费和资金费）。
 *   这里读的是币安那本账：已实现 + 手续费 + 资金费 + 其它，四类直接相加才是净的。
 *   纯本地读，不打交易所（数据由后端定期对账灌进来）。
 */
async function loadIncome(): Promise<void> {
  const list = listAll.value
  const many = multi.value
  const rows: ExchangeIncomeRow[] = []
  const total: ExchangeIncomeTotals = {
    realized: 0,
    commission: 0,
    funding: 0,
    other: 0,
    net: 0,
    count: 0
  }
  let any = false
  for (const k of list) {
    try {
      const r = await fetchExchangeIncome(k.id, INCOME_DAYS, INCOME_MAX)
      if (!r.totals) continue
      any = true
      total.realized += r.totals.realized
      total.commission += r.totals.commission
      total.funding += r.totals.funding
      total.other += r.totals.other
      total.net += r.totals.net
      total.count += r.totals.count
      for (const row of r.rows ?? [])
        rows.push(many ? {...row, keyName: k.name} : row)
    } catch (e) {
      if (!isAuthError(e)) err.value = `读取盈亏失败：${msg(e)}`
    }
  }
  rows.sort((a, b) =>
    String(b.datetime ?? '').localeCompare(String(a.datetime ?? ''))
  )
  incomeTotals.value = any ? total : null
  income.value = rows.slice(0, INCOME_MAX)
}

/**
 * 挂单：几套合起来（多套时每条标出是哪套的），失败原因也带上账户名。
 *
 * ★ 2026-10-06 改两处（用户：「我点击交易所界面，订单过 2 秒才出来」）：
 *   ① **几套并发拉**，不再一套一套串（以前 2 套 = 2 个来回叠加，
 *      而这是经出口隧道打币安，一个来回就一秒上下）；
 *   ② 后端可能回的是**旧值**（`stale: true`，它同时在后台刷新的那份）——
 *      这种情况过 1.2 秒再问一次，那时缓存已经是新的、命中即回。
 *      ⇒ 界面上永远是「立刻有东西看」，不是白等一个转圈。
 */
async function loadOrders(): Promise<void> {
  const list = activeTargets.value
  const many = multi.value
  loadingOrders.value = true
  ordersErr.value = ''
  const res = await Promise.all(
    list.map(k =>
      fetchExchangeOpenOrders(k.id).catch(e => {
        if (isAuthError(e)) throw e
        return {openOrders: null, stale: false, error: msg(e)}
      })
    )
  )
  const out: ExchangeOpenOrder[] = []
  const errs: string[] = []
  let stale = false
  list.forEach((k, i) => {
    const r = res[i]
    if (!r) return
    if (r.error) errs.push(many ? `${k.name}：${r.error}` : r.error)
    if (r.stale) stale = true
    for (const o of r.openOrders ?? []) out.push(many ? {...o, keyName: k.name} : o)
  })
  openOrders.value = out
  ordersErr.value = errs.join('；')
  loadingOrders.value = false
  /* 拿到的是旧值 ⇒ 后台那份刷新完了再取一次（只补一发，不循环） */
  if (stale && !ordersRetryTimer) {
    ordersRetryTimer = setTimeout(() => {
      ordersRetryTimer = null
      void loadOrders()
    }, 1200)
  }
}

/**
 * 取净资产曲线。
 * ⚠️ 失败**不吵**（不往 `err` 里写）：主数字已经在了，曲线属于锦上添花。
 *
 * 多套时**按时间桶加总**（用户 2026-10-05 选的「都合并」）——
 * 区间带取各家上沿 / 下沿之和，正好是合并后的包络（单取 max 会偏窄）。
 */
async function loadCurve(): Promise<void> {
  const list = activeTargets.value
  if (!list.length) return
  const range = curveRange.value
  const res = await Promise.all(
    list.map(k => fetchExchangeCurve(k.id, range).catch(() => null))
  )
  const ok = res.filter(Boolean) as {
    points: CurvePoint[]
    bucketSec: number
  }[]
  if (!ok.length) {
    curve.value = []
    return
  }
  curveBucketSec.value = ok[0]!.bucketSec ?? 300
  if (ok.length === 1) {
    curve.value = ok[0]!.points ?? []
    curveAt = Date.now()
    return
  }
  const byT = new Map<string, CurvePoint>()
  for (const r of ok)
    for (const p of r.points ?? []) {
      const cur = byT.get(p.t)
      if (cur) {
        cur.close += p.close
        cur.high += p.high
        cur.low += p.low
      } else {
        byT.set(p.t, {...p})
      }
    }
  curve.value = [...byT.values()].sort((a, b) =>
    a.t < b.t ? -1 : a.t > b.t ? 1 : 0
  )
  curveAt = Date.now()
}

/* ---------------- SSE ---------------- */

/**
 * 每个账户一条 SSE（后端本来就按 key_id 分流）。
 * 多套时就是几条并行 —— 数量就是账户数，不会爆。
 */
let stops: (() => void)[] = []

function stopStreams(): void {
  for (const s of stops) s()
  stops = []
}

/** 这套 key 现在是不是「正在看的那几套」之一 */
function keyIsActive(id: number): boolean {
  return activeTargets.value.some(k => k.id === id)
}

/**
 * 给**每一套**账户都开一条 SSE（不是只给「正在看的那几套」）。
 *
 * ★ 2026-10-06 改造：以前每次换 tab 都 `stopStreams()` + 重新订阅 ——
 *   换一次格就是一轮断开重连（后端还会重发一遍底稿），而且新数据要等一轮才到。
 *   SSE 本身**不占交易所权重**（就是一条 HTTP 长连接），按账户数开一次就够了 ⇒
 *   换 tab 从此不碰连接，切过去就是活的。
 */
function startStreams(): void {
  stopStreams()
  for (const k of keys.value) {
    stops.push(
      exchangeStream(k.id, {
        /* 有心跳/数据 = 这条流还活着 → 兜底定时器就不用打交易所（见 startSnapTimer） */
        alive: () => {
          streamAt = {...streamAt, [k.id]: Date.now()}
        },
        snapshot: r => {
          const next = {...parts.value}
          const nextReason = {...partReasons.value}
          if (r.noSnapshot) {
            nextReason[k.id] = r.reason ?? '这个账户暂时没有数据'
            delete next[k.id]
          } else if (r.overview) {
            /*
             * 后端主动推来的快照 = 新鲜数据 ⇒ 合约那块也算「活的」
             * （`takenAt` 用它自己的采集时间，`liveAt` 记我们收到的时间）。
             */
            next[k.id] = {...r.overview, liveAt: new Date().toISOString()}
            delete nextReason[k.id]
            snapAt = {...snapAt, [k.id]: Date.now()}
          }
          parts.value = next
          partReasons.value = nextReason
          if (keyIsActive(k.id)) rebuild()
          /* 曲线只看「正在看的那几套」；SSE 来得勤，最多每分钟重拉一次 */
          if (keyIsActive(k.id) && Date.now() - curveAt > 60_000) void loadCurve()
        },
        /*
         * 持仓增量（改造 P1/P4）—— 后端常驻流每次刷新持仓都会推。
         *
         * ⚠️ 只往**已有快照**上盖（没有底稿就先不管：`snapshot` 事件马上就到，
         *    凭空造一份缺 wallet/assets/c2c 的快照反而会让净资产算错）。
         * ⚠️ **不动 `snapAt`**：这份补丁里只有持仓，钱包 / C2C / 现货还是上一份快照的，
         *    所以那条「太久没整份快照就刷一次」的兜底定时器不该被它喂饱。
         */
        positions: p => {
          const cur = parts.value[k.id]
          if (!cur) return
          parts.value = {
            ...parts.value,
            [k.id]: {
              ...cur,
              /*
               * ★ 2026-10-06：这里**只盖 `liveAt`，不碰 `takenAt`**。
               *
               * ⚠️ 原来写的是 `takenAt: p.at`，于是那颗「几分钟前」的标签在**有持仓**
               *    的账户上永远显示「刚刚更新」—— 因为持仓/浮盈每秒都在推。
               *    可它旁边那几项（C2C / 现货 / 可用余额）其实还是上一份快照的，
               *    最长可能一小时前 —— 标签在**替它们报喜**（用户就是这么被绕进去的）。
               *    现在拆成两个时间：`liveAt` = 合约那块（WS，秒级），
               *    `takenAt` = 整份快照（现货 / C2C / 可用余额）。
               */
              liveAt: p.at,
              futures: {
                ...cur.futures,
                positions: p.positions,
                wallet: p.wallet,
                unrealized: p.unrealized,
                margin: p.margin
              },
              stats: p.stats
            }
          }
          if (keyIsActive(k.id)) rebuild()
        },
        fill: t => {
          /*
           * ⚠️ 流是**全部账户**都订着的，所以别的账户成交时不能往这张列表里塞
           *    （列表只显示「正在看的那几套」）。换 tab 会 `loadFills()` 重拉。
           */
          if (!keyIsActive(k.id)) return
          // 同一笔可能「实时事件」和「REST 回补」都给到 → 按 tradeId 去重
          if (fills.value.some(f => f.id === t.id)) return
          const tagged = keys.value.length > 1 ? {...t, keyName: k.name} : t
          fills.value = [tagged, ...fills.value].slice(0, FILLS_MAX)
          /* 仓位历史是从成交推出来的 —— 新成交可能刚开一段、也可能刚平掉一段 */
          void loadCycles()
        },
        backfill: () => {
          if (keyIsActive(k.id)) {
            void loadFills()
            /* REST 补回来的成交同样会改变「这一段平没平完」 */
            void loadCycles()
          }
        },
        /* 钱账本对账到新记录 → 手续费 / 资金费变了，持仓卡上的「已结」要跟着动 */
        income: () => void loadIncome(),
        /*
         * 挂单变了（WS 实时 / 2 分钟对账 / 写操作后主动对账）→ 重读一次。
         * ★ 挂单现在**存库**，所以这一下是本地读（毫秒级、零权重），
         *   不是又去打币安 40 权重 —— 可以放心收一条刷一次。
         */
        orders: () => {
          if (keyIsActive(k.id)) void loadOrders()
        },
        /*
         * 上游用户数据流哑了 / 恢复了。
         * ⚠️ 只记标记，**马上刷一次**那次由兜底定时器（20 秒一轮）去做 ——
         *    事件可能连着来几次，不该每个都打一遍交易所。
         */
        health: d => {
          deaf.value = {...deaf.value, [k.id]: d}
          if (d && keyIsActive(k.id)) void doRefresh()
        },
        reject: r => {
          /*
           * 这套账户不参与统计（现货 / 没填 key）。
           * ⚠️ 以前这里会**关掉订阅**（`liveSse` 不知道「这条流永远不会有数据」，
           *    EventSource 会一直重连）。多套之后不能整体关 —— 只把这一套的原因
           *    记下来，其余几套的流照旧。
           */
          partReasons.value = {...partReasons.value, [k.id]: r}
          const next = {...parts.value}
          delete next[k.id]
          parts.value = next
          if (keyIsActive(k.id)) rebuild()
        },
        reconnect: () => {
          void loadSnapshots()
          if (keyIsActive(k.id)) {
            void loadFills()
            void loadCurve()
          }
        }
      })
    )
  }
}

/* 换跨度（1d / 7d / 30d）只重拉曲线，不动快照 */
watch(curveRange, () => void loadCurve())

/* ---------------- 划转 ---------------- */

/** 弹层开着没 */
const transferOpen = ref(false)

/**
 * 划转针对哪套 Key。
 *
 * 「全部」那一格是**合并视图**，没有「一个账户」可划 ⇒ 退回默认那套（后端不传 id
 * 也是这个行为），用户若想划别套就在弹层里点账户名换（`pickTransferKey`）。
 */
const transferKeyId = computed<number | undefined>(() => {
  if (picked.value !== 'all') {
    const hit = keys.value.find(k => String(k.id) === picked.value)
    if (hit) return hit.id
  }
  return keys.value.find(k => k.isDefault)?.id ?? keys.value[0]?.id
})

/** 弹层里换了账户：当成切 tab，让整页跟着换过去（不然数字和弹层说的对不上） */
function pickTransferKey(id: number): void {
  picked.value = String(id)
}

/** 划完了：钱包里的钱换了位置 ⇒ 快照 / 曲线 / 挂单全部重读一遍 */
function onTransferred(): void {
  void doRefresh()
  void loadOrders()
}

/* ---------------- 换 tab ---------------- */

/*
 * 换 tab（全部 ↔ 某个账户）。
 *
 * ★ 2026-10-06 改造：以前这里把**所有状态清空**再全部重拉 ——
 *   切 A→B→A 要把两套都重读一遍，而且界面会先白一下；更贵的是
 *   `loadOrders()` 每套都打一次**不带 symbol 的挂单查询（币安 40 权重/条）**，
 *   再叠上快照 stale 触发的刷新 ⇒ 点一下就是几十上百权重。
 *
 * 现在：
 *   · `parts` / `partReasons` **不清** —— 它们是按 keyId 存的，`rebuild()` 只读
 *     `activeTargets`，留着别套的数据既不会串进视图，切回来还能秒开；
 *   · SSE **不动**（`startStreams()` 已经给每套都开好了，见上面）；
 *   · 只重拉「跟视图有关」的那几样：成交 / 挂单 / 曲线（挂单那一路现在有 10 秒缓存顶着）。
 */
watch(picked, () => {
  /*
   * ⚠️ 不置 `data.value = null`：`rebuild()` 马上会按新的 activeTargets 重算，
   *    中间那一下空白没必要（切到没数据的账户时 `rebuild()` 自己会给原因）。
   */
  err.value = ''
  void loadSnapshots()
  void loadFills()
  void loadIncome()
  void loadCycles()
  void loadOrders()
  void loadCurve()
})

/* ---------------- 整份快照的兜底定时器（改造 P2 + 2026-10-06 收敛） ---------------- */

/**
 * ⚠️ 改造前这个页面**没有定时器**：`loadSnapshots()` 只在挂载 / 切账户时跑一次，
 *    之后纯靠 SSE。WS 那边一旦不推，界面最长要等 **5 分钟采样**才动 ——
 *    用户 2026-10-06 报的「K 线有仓位了、交易所界面过一会儿才出来」就是这么来的。
 *
 * ★ 2026-10-06 收敛：一上来加的是「整份快照超 90 秒就刷」，但**持仓/未实现盈亏
 *   已经由 SSE 1 秒级推了**（那才是当初要修的），所以这个定时器现在只负责
 *   「万一流断了」这一种情况。改成：
 *
 *     这套账户的 SSE **还活着**（20 秒一次心跳）⇒ 后端的 5 分钟采样 / 事件快照
 *     都会经同一条流推过来 ⇒ **一次交易所都不打**；
 *     流断了（3 拍心跳没来）⇒ 才按 `SNAP_FRESH_MS` 的节奏去打兜底。
 *
 *   稳态下这一项从「每 90 秒 25 权重/套」降到 **0** —— 它是当时最大的一项。
 */
const SNAP_FRESH_MS = 90_000
const SNAP_CHECK_MS = 20_000
let snapTimer: ReturnType<typeof setInterval> | null = null

function startSnapTimer(): void {
  if (snapTimer) return
  snapTimer = setInterval(() => {
    /* 后台不刷（省流量，也免得在后台被交易所限频） */
    if (!isForeground()) return
    const now = Date.now()
    const need = activeTargets.value.some(k => {
      /* 这套压根没数据（现货 / 没填 key）→ 刷也没用，别去刷 */
      if (!parts.value[k.id]) return false
      /*
       * 流真正活着 → 后端会自己推，不用我们打交易所。
       * ⚠️ 但后端报告「上游哑了」时必须继续兜底 —— SSE 心跳还在，
       *    上游那条用户数据流却一帧不推，全靠这里把数字救回来。
       */
      if (streamAlive(k.id) && deaf.value[k.id] !== true) return false
      return now - (snapAt[k.id] ?? 0) > SNAP_FRESH_MS
    })
    if (need) void doRefresh(true)
  }, SNAP_CHECK_MS)
}

onMounted(async () => {
  /* 汇率：跟账户列表一起并行拿，拿不到也无所谓（只用默认值） */
  void fetchRate()
    .then(r => {
      rate.value = Number(r?.usdCny) || 0
    })
    .catch(() => undefined)

  try {
    keys.value = (await fetchExchangeKeys()).keys ?? []
  } catch (e) {
    if (!isAuthError(e)) err.value = `读取账户列表失败：${msg(e)}`
    return
  }
  if (!keys.value.length) return
  /*
   * 默认落在「全部」（用户 2026-10-05 要的就是先看总账）；
   * 只有一套时 `activeTargets` 就是它自己，效果跟以前一样。
   */
  picked.value = keys.value.length > 1 ? 'all' : String(keys.value[0]!.id)

  /* 给每一套账户都开上 SSE（只在挂载时开一次，换 tab 不再断开重连） */
  startStreams()

  /* 兜底：整份快照太久没更新就自己刷（改造 P2，见上面那段说明） */
  startSnapTimer()
})

onUnmounted(() => {
  stopStreams()
  if (snapTimer) clearInterval(snapTimer)
  snapTimer = null
  if (ordersRetryTimer) clearTimeout(ordersRetryTimer)
  ordersRetryTimer = null
})
</script>

<template>
  <div
    class="live"
    @touchstart.passive="onPullStart"
    @touchmove.passive="onPullMove"
    @touchend.passive="onPullEnd"
    @touchcancel.passive="onPullEnd"
  >
    <!--
      下拉刷新的指示条：**绝对定位、不占位**（拉的时候页面不会跳一下）。
      三段文案 = 三种状态：还没拉到阈值 / 松开就刷 / 正在刷。
    -->
    <div
      class="pull"
      :class="{on: pullState !== 'idle', busy: pullState === 'busy'}"
      :style="{transform: `translate(-50%, ${pullY}px)`}"
      aria-hidden="true"
    >
      <span class="pull-dot" />
      {{
        pullState === 'busy'
          ? '刷新中…'
          : pullState === 'ready'
            ? '松开刷新'
            : '下拉刷新'
      }}
    </div>
    <p v-if="err" class="err">{{ err }}</p>

    <section v-if="!keys.length && !loading" class="panel empty">
      还没有配置交易所 API Key —— 去「我的 → 个人信息 → 交易所」加一套。
    </section>
    <!--
      ⚠️ 板子**始终挂着**（不再是 `v-else-if="reason"` 把它整块换掉）——
      顶部那排账户 tab 就在板子里，某套账户没数据时也得能切回别的账户。
      「没有数据」的原因改成板子底部一行字（见 `:reason`）。
    -->
    <ExchangeAccountBoard
      v-else
      v-model="picked"
      :accounts="accountOptions"
      :data="data"
      :reason="reason"
      :open-orders="openOrders"
      :trades="fills"
      :income="income"
      :cycles="cycles"
      :open-cycles="openCycles"
      :cycles-since="cyclesSince"
      :loading-orders="loadingOrders"
      :refreshing="refreshing"
      :curve="curve"
      :curve-range="curveRange"
      :curve-bucket-sec="curveBucketSec"
      :rate="rate"
      :busy="posBusy"
      @update:curve-range="curveRange = $event"
      @refresh="doRefresh()"
      @transfer="transferOpen = true"
      @reduce="openReduce"
      @close="closeRow"
    />

    <!--
      减仓弹层（用户 2026-10-05：「加个按钮减仓 弹窗选择百分比」）——
      跟划转一样挂在容器这一层：只有它知道那一条持仓是哪套 Key 的。
    -->
    <ReduceSheet
      :open="!!reduceRow"
      :name="reduceRow ? baseOf(reduceRow.symbol) : ''"
      :side="reduceRow?.side ?? 'long'"
      :amount="reduceAmount"
      :notional="reduceNotional"
      :test-order="testOrder"
      :busy="posBusy"
      @close="reduceRow = null"
      @confirm="confirmReduce"
    />

    <!--
      划转弹层（用户 2026-10-05：「各个里面添加划转功能」）——
      挂在**容器**这一层：只有它知道当前选的是哪套 Key、一共有几套。
      ⚠️ 真钱操作（币安没有划转测试接口），权限和「能划走多少」都在弹层里现读。
    -->
    <TransferSheet
      :open="transferOpen"
      :key-id="transferKeyId"
      :keys="keys"
      @close="transferOpen = false"
      @pick-key="pickTransferKey"
      @done="onTransferred"
    />

    <p v-if="ordersErr" class="dim tiny">挂单查询失败：{{ ordersErr }}</p>
  </div>
</template>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 下拉指示条挂在它上面（absolute），所以它得是定位祖先 */
  position: relative;
}
/*
 * 下拉刷新指示条（移动端）。
 * ⚠️ `translate(-50%, Npx)` 里的 N 由脚本给（阻尼后的拖动距离）——
 *    初始 `translate(-50%, 0)` 时它还压在顶部内容上，所以平时 `opacity: 0`
 *    并且 `pointer-events: none`（绝不挡点击）。
 */
.pull {
  position: absolute;
  top: -34px;
  left: 50%;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--fg-dim, #8b93a1);
  background: var(--card, #171b22);
  box-shadow: 0 2px 10px rgb(0 0 0 / 35%);
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
  white-space: nowrap;
}
.pull.on {
  opacity: 1;
}
.pull-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #4c8dff);
}
.pull.busy .pull-dot {
  animation: pull-spin 0.9s linear infinite;
}
@keyframes pull-spin {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.2;
  }
  100% {
    opacity: 1;
  }
}
.spacer {
  flex: 1 1 auto;
}
.tiny {
  font-size: 11.5px;
}
.dim {
  color: var(--muted);
}
.err {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--bad, #e55361);
  background: color-mix(in srgb, var(--bad, #e55361) 12%, transparent);
}
.empty {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.6;
}
</style>
