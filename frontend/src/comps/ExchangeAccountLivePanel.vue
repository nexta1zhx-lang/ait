<script setup lang="ts">
/**
 * 「交易所资产」的**真数据容器**（M3）。
 *
 * 干三件事：
 *   ① **先读库里最新一条快照**渲染（毫秒级，不打交易所）→ 旧了就后台刷新
 *   ② **订阅 SSE**：WS 一有动静后端就落一条并推过来 → 数字秒跳，
 *      不用等 5 分钟采样、也不用用户手动 ⟳
 *   ③ 下面两个 tab 各取所需：**成交/盈亏读后端账本**（WS 实时落 + 断线后 RESF 补，
 *      **不需要交易对**），**挂单打交易所**（秒级变化的东西，不进快照）
 *
 * ⚠️ 分层（跟已经删掉的老面板不同）：老的把 5 个交易所调用塞进一个请求、
 *    每次都要现拉；这个首屏只读库，慢的东西（挂单）拆开按需查。
 */
import {computed, onMounted, onUnmounted, reactive, ref, watch} from 'vue'
import {useRouter} from 'vue-router'
import ExchangeAccountBoard from './ExchangeAccountBoard.vue'
import TransferSheet from './TransferSheet.vue'
import ReduceSheet from './ReduceSheet.vue'
import TpSlSheet from './TpSlSheet.vue'
import OrderEditSheet from './OrderEditSheet.vue'
import type {PositionRef} from './ExchangeAccountBoard.vue'
import {pickSymbol, prefetchSymbol} from '../analyze'
import {bindLastPrices, lastPrices} from '../last-price'
import {
  closeSideOf,
  pairOf,
  type OrderEditTarget,
  type TpSlAction,
  type TpSlTarget
} from '../tpsl'
import {usePullRefresh} from '../pull-refresh'
import {testOrder} from '../settings'
import {askConfirm} from '../confirm'
import {showToast} from '../toast'
import {isForeground} from '../live'
import {setAvailableBalance} from '../positions'
import {bjTime} from '../format'
import LedgerRangeSheet from './LedgerRangeSheet.vue'
import {bjDayStart, rangeToInterval, TYPE_NAME, type RangeKey} from '../ledger'
import {
  cancelTradeOrder,
  cancelTradeOrders,
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
  modifyTradeOrder,
  placeStopOrder,
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
/**
 * 账本三格**一次取多少条**（留着的上限也一起用）。
 *
 * ⚠️ 2026-10-07 从 `60 / 200 / 50` 放大到 `500`：这三格现在带**周期范围**（用户
 *    「默认显示 7 天，右侧一个按钮选周期范围」），选 30 / 90 天时还按原来那几十条
 *    就是「筛出来的比实际少」——那是静默的假数据，最不能留。
 *    · 后端那边 `listFills` / `listIncome` / `listPositionHistory` 各自还有硬上限 500/2000/500；
 *    · 列表还是**按需铺**的（窄屏一屏 20 条，滚到底再铺一批，见 board 的 `PAGE`），
 *      所以放大上限只是「允许往下滚更多」，不是一上来就渲染五百行。
 */
const LEDGER_MAX = 500

/* ---------------- 账本三格的筛选（周期范围 + 币种 + 资金类型） ---------------- */

/** 三格：仓位历史 / 成交历史 / 资金动向 */
type LedgerTab = 'inc' | 'trades' | 'flow'

interface LedgerFilter {
  range: RangeKey
  /** 毫秒（含端点）；`null` = 不限 */
  from: number | null
  to: number | null
  /** 币种**简称**（`PUMP`，`''` = 全部）—— **本地筛**，这样下拉里始终有全部可选 */
  symbol: string
  /** 资金类型（`income_type`，`null` = 全部）—— **后端筛**，合计口径才跟列表一致 */
  types: string[] | null
}

/**
 * 默认：近 7 天 + 全部币种 + 全部类型（用户 2026-10-07：「默认显示 7 天的数据」）。
 *
 * ⚠️ 这里的 `from`/`to` 只是**弹层回显用的快照**，**别拿去请求**
 *    （相对范围每次请求现算，见 `rangeOf`；否则 `to` 一旦冻住，
 *    页面打开之后的新数据就永远读不出来了）。
 */
function defaultFilter(): LedgerFilter {
  const to = Date.now()
  return {range: '7d', from: bjDayStart(to, 6), to, symbol: '', types: null}
}

/**
 * ⚠️ 三格**各自独立**：三格是三个不同的列表，共用一份筛选会出现
 *    「在成交历史里选了 30 天，仓位历史也跟着变」，而它们右上角各有各的按钮。
 */
const filters = reactive<Record<LedgerTab, LedgerFilter>>({
  inc: defaultFilter(),
  trades: defaultFilter(),
  flow: defaultFilter()
})

/**
 * 交给 api 的范围参数（币种不传 —— 本地筛）。
 *
 * ⚠️ **相对范围（今天 / 近 N 天）必须每次现算，不能直接用 `f.filters[].from/to`。**
 *    那两个字段是「组件挂载那一刻」或「弹层里点完成那一刻」的快照，`to` **冻在过去**。
 *    拿它去请求的后果是：**页面打开之后**发生的成交 / 平仓 / 手续费全落在窗口外，
 *    重读多少次都读不回来 —— 用户 2026-10-08 报的「仓位历史 / 成交 / 资金动向
 *    根本不实时」就是这么来的（当时兜底定时器每 20 秒确实都在读库，读的却是一个
 *    过期的 `to`，所以「查了但永远是旧数据」）。
 *    只有**自定义**范围才该用用户选死的 from/to（那是他要的固定区间）。
 */
function rangeOf(tab: LedgerTab): {from: number | null; to: number | null; types?: string[] | null} {
  const f = filters[tab]
  const win = f.range === 'custom' ? {from: f.from, to: f.to} : rangeToInterval(f.range)
  return tab === 'flow' ? {...win, types: f.types} : win
}

/** 按钮上那行字 */
function rangeLabel(tab: LedgerTab): string {
  const f = filters[tab]
  switch (f.range) {
    case 'today':
      return '今天'
    case '30d':
      return '近 30 天'
    case '90d':
      return '近 90 天'
    case 'custom':
      return f.from && f.to
        ? `${bjDay(f.from)}→${bjDay(f.to)}`
        : '自定义'
    default:
      return '近 7 天'
  }
}

/**
 * 这一格现在有没有在筛（不是默认的「近 7 天 + 全部币种 + 全部类型」）。
 * 空列表的文案要分开：默认状态是「还没有数据」，筛过之后是「这个条件下没有」。
 */
function filtered(tab: LedgerTab): boolean {
  const f = filters[tab]
  return !!f.symbol || f.range !== '7d' || !!f.types?.length
}

/** 范围/类型不是默认值 —— 那颗按钮要不要高亮（币种不算：它在左边下拉里看得见） */
function rangeOn(tab: LedgerTab): boolean {
  const f = filters[tab]
  return f.range !== '7d' || !!f.types?.length
}

function bjDay(ms: number): string {
  return bjTime(ms).slice(5, 10)
}

/** 资金动向按钮上的类型摘要（没筛就是空串，按钮显示范围） */
function typesLabel(tab: LedgerTab): string {
  const t = filters[tab].types
  if (tab !== 'flow' || !t?.length) return ''
  const names = t.map(v => TYPE_NAME[v] ?? v)
  return names.length <= 2 ? names.join('+') : `${names[0]}等${names.length}种`
}

/** 哪一格开着「周期范围」弹窗（`null` = 关着） */
const rangeSheet = ref<LedgerTab | null>(null)

/** 那一格现在筛出多少笔（弹窗底部那句「当前筛出 N 笔」） */
const rangeCount = computed(() => {
  const tab = rangeSheet.value
  if (!tab) return null
  if (tab === 'inc') return cycles.value.filter(c => hitSymbol(c.symbol, filters.inc.symbol)).length
  if (tab === 'trades') return fills.value.filter(t => hitSymbol(t.symbol, filters.trades.symbol)).length
  return income.value.filter(r => hitSymbol(r.symbol, filters.flow.symbol)).length
})

/** 跟 board 里那份同一个口径：比**币种简称**（下拉给的就是简称） */
function hitSymbol(sym: string, want: string): boolean {
  return !want || baseOf(sym) === want
}

const RANGE_TITLE: Record<LedgerTab, string> = {
  inc: '仓位历史',
  trades: '成交历史',
  flow: '资金动向'
}

/** 面板里换了币种（下拉里选的；`''` = 全部）—— 只改本地视图，不用重取 */
function onLedgerFilter(e: {tab: LedgerTab; symbol: string}): void {
  filters[e.tab].symbol = e.symbol
}

/** 面板里点了「周期范围」—— 弹窗在这一层挂（它才知道怎么重取） */
function onLedgerRange(e: {tab: LedgerTab}): void {
  rangeSheet.value = e.tab
}

/** 弹窗点了「完成」：换范围（可能要重新取数），币种不动 */
function onRangeApply(v: {
  range: RangeKey
  from: number | null
  to: number | null
  types: string[] | null
}): void {
  const tab = rangeSheet.value
  if (!tab) return
  const f = filters[tab]
  f.range = v.range
  f.from = v.from
  f.to = v.to
  if (tab === 'flow') f.types = v.types
  void reloadLedger(tab)
}

/** 按新的范围把那格重取一次 */
function reloadLedger(tab: LedgerTab): void {
  if (tab === 'inc') void loadCycles()
  else if (tab === 'trades') void loadFills()
  else void loadIncome()
}

const keys = ref<ExchangeKey[]>([])

/**
 * 这一格现在是不是「用户正在看的」。
 *
 * 「该页面要做缓存」）：`MeView` 现在把它**留着不卸载**
 *   （`v-show`），所以切到别的格只是「看不见」，组件还活着 —— 那两条 SSE、兜底定时器
 *   得自己按这个开关停/开，不能在没人看的时候还挂着。
 *   默认 `true`（独立使用时不传也对）。
 */
const props = defineProps<{active?: boolean}>()
const live = computed(() => props.active !== false)


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

/*
 * **刚打开页面时别急着判定「流死了」**。
 *
 * 用户反馈：「怎么感觉刷新后进入该页面就会请求」——他看对了。
 * 打开页面那一瞬间 `streamAt` 还是 0（SSE 才刚发出去，还没收到第一帧），
 * 而库里那份快照是 5 分钟采样写一次（早就旧过 15 秒）⇒
 * `!streamAlive && age > 15s` 成立 ⇒ **每次进页面都白打一轮交易所**（实测：
 * 进页面 483ms 时就并发发出两条 `POST /api/exchange/refresh?auto=1`，
 * 每条约 2 秒 / 25 权重，还会撞上出口超时弹「刷新失败」）。
 *
 * 但后端内存里就有最新那份快照、握手后立刻推过来（同一时刻的流完全正常）——
 * 所以给「刚打开 + 还没收到任何一帧」一段宽限期：
 *   · 宽限期内收到帧 ⇒ `streamAt` 有值 ⇒ 不再算旧，**一次交易所都不打**；
 *   · 宽限期过了还是没人推（真断线）⇒ 重判一次，照旧走兜底刷（只晚 2.5 秒）。
 * ⚠️ 这段宽限**不会**变成轮询：只是「开机后重判一次」。
 */
/*
 * 宽限期上限 8 秒、每 1.2 秒重判一次（重判只是**再读一次库**，毫秒级、零交易所权重）。
 *
 * ⚠️ 为什么不是「等 2.5 秒就下结论」：后端在订阅那一刻会 `wakeOnView` ——
 *    数据旧过它自己的 `FRESH_MS`(60s) 时它**先自己去对平一轮再 emit**，
 *    经这条出口隧道实测要 2~4 秒才送第一帧。宽限期短于它，就会两头同时打交易所
 *    （实测 2.5 秒的版本在 3.4 秒时照样发了 refresh，等于白等）。
 */
const STREAM_GRACE_MS = 8000
const STREAM_GRACE_STEP_MS = 1200
let openedAt = 0
let graceTimer: ReturnType<typeof setTimeout> | null = null

/** 现在算不算「刚打开、SSE 还在握手」（这段时间不许判定流死了） */
function streamWarming(keyId: number): boolean {
  return !streamAlive(keyId) && Date.now() - openedAt < STREAM_GRACE_MS
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
 * ⚠️ 只有一套时**不加总、也不给行打 `keyName` 标签** —— 保留 `account.name`，
 *    单账户的界面跟以前完全一样。
 * ⚠️⚠️ 但**必须给每条持仓补上 `keyId`**（只是不写 `keyName`）：
 *    2026-10-07 实测的 bug —— 选了「币安」再点「一键平仓 / 平仓 / 全平」，
 *    请求里**没有 `?id=`**（`row.keyId` 是 undefined），后端 `idRaw` 为空就落到
 *    `getDefaultExchangeKey`（`ORDER BY is_default DESC, id` ⇒ 默认那套是**最早配的**
 *    「测试」），于是平的是**另一个账户**的仓。
 *    原来这里直接 `return list[0].ov`（一行 `keyId` 都不带），所以单套视图下
 *    那几颗真钱按钮全都只能给 `undefined`。
 */
function mergeOverviews(
  list: {key: ExchangeKey; ov: ExchangeOverview}[]
): ExchangeOverview | null {
  if (!list.length) return null

  if (list.length === 1) {
    const {key, ov} = list[0]!
    const fs = ov.futures
    if (!fs) return ov
    return {
      ...ov,
      futures: {
        ...fs,
        positions: (fs.positions ?? []).map(p => ({...p, keyId: key.id}))
      }
    }
  }

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

  /* 持仓：直接拼起来，**每条标上它来自哪套 Key** */
  const positions: FuturesPosition[] = []
  for (const p of list)
    for (const pos of p.ov.futures?.positions ?? [])
      /* `keyId` 是给「平仓 / 全平」用的（要知道拿哪套凭据去下单） */
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

/*
 * 平仓 / 全平（持仓卡片底部那两颗按钮）。
 * ⚠️ 2026-10-07 用户改口径：「减仓换成平仓，平仓换成全平」——只改**显示的字**，
 *    函数名（`confirmReduce` / `closeRow`）和接口没动。
 */

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

/** 正在平仓（只平一部分）的那一条（null = 弹层关着） */
const reduceRow = ref<PositionRef | null>(null)

/**
 * 正在看止盈止损的那一条（null = 弹层关着）。
 *
 * ⚠️ 存的是**板子点按钮时给的那一坨**（`TpSlTarget`：开仓价 / 标记价 / 数量 /
 *    已有的那两张单），不是 `PositionRef` —— 弹层要用这些算「预计收益」和改单，
 *    而它拿不到（持仓列表只在板子那儿）。代价是弹层开着时数据变新了它不知道，
 *    但**这正是我们要的**：人正在填的价不能被推送顶掉。
 */
const tpslTarget = ref<TpSlTarget | null>(null)

/* ---------------- 改挂单（「挂单」列表点一行。
 *
 * ⚠️ 跟 `tpslTarget` 一个道理：存板子点行时给的那一坨（`OrderEditTarget`），
 *    弹层只管填和校验，提交是这里的事（只有容器拿得到接口和 Key）。
 */
const editTarget = ref<OrderEditTarget | null>(null)
/** 改单 / 撤单正在提交（弹层那两颗按钮一起禁点） */
const orderBusy = ref(false)

/**
 * 这一坨数据（持仓 / 挂单）该用哪套 Key 去下单。
 *
 * 顺序：数据自己带的 `keyId`（现在**单套视图里也有**，见 `mergeOverviews`）→
 * 按 `keyName` 在**当前视图**里找 → 当前就选中一套时就是它 → 最后兜底第一套。
 *
 * ⚠️⚠️ **绝不能返回 `undefined` 就交上去** —— 后端 `?id=` 空 = `getDefaultExchangeKey`
 *    （默认那套是「最早配的」，不一定是人正在看的这套。
 *    所以这里一定会给出一个具体的 id。
 */
function resolveKeyId(keyId?: number, keyName?: string): number | undefined {
  if (keyId) return keyId
  const list = activeTargets.value
  if (keyName) return list.find(k => k.name === keyName)?.id ?? list[0]?.id
  if (picked.value !== 'all') {
    const hit = list.find(k => String(k.id) === picked.value)
    if (hit) return hit.id
  }
  return list[0]?.id
}

/**
 * 这一张挂单该用哪套 Key 去改。
 *
 * ⚠️ 「全部」那一格挂单里带 `keyName`，所以找得到；单套时挂单里没有名字，走前面那条。
 */
function keyIdOfOrder(t: OrderEditTarget): number | undefined {
  return resolveKeyId(t.keyId, t.keyName)
}

function openOrderEdit(t: OrderEditTarget): void {
  if (orderBusy.value) return
  editTarget.value = {...t, keyId: keyIdOfOrder(t)}
}

/** 改这张单（价格 / 数量）—— 后端按类型分流：限价单改单、条件单撤旧挂新 */
async function saveOrderEdit(v: {price: number; amount: number}): Promise<void> {
  const t = editTarget.value
  if (!t || orderBusy.value) return
  orderBusy.value = true
  try {
    const r = await modifyTradeOrder(
      {symbol: t.raw, orderId: t.id, price: v.price, quantity: v.amount},
      t.keyId
    )
    sayMsg(
      r.via === 'replace'
        ? `${t.name} 已改：撤旧挂新，新触发价 ${v.price}`
        : `${t.name} 已改：委托价 ${v.price}`,
      'ok'
    )
    editTarget.value = null
  } catch (e) {
    /* 失败**留着弹层**：人还能改个价重试（跟止盈止损那边一个处理） */
    sayMsg(`改单失败：${msg(e)}`, 'bad')
  } finally {
    orderBusy.value = false
    /* 挂单列表刷新（真单那条路后端也会推 `orders` 事件，这里再补一次本地读） */
    void loadOrders()
  }
}

/** 撤这张单（弹层里点两次才算数，见 `OrderEditSheet.onCancel`） */
async function cancelOrderEdit(): Promise<void> {
  const t = editTarget.value
  if (!t || orderBusy.value) return
  orderBusy.value = true
  try {
    await cancelTradeOrder(t.raw, t.id, t.keyId)
    sayMsg(`${t.name} 已撤单`, 'ok')
    editTarget.value = null
  } catch (e) {
    sayMsg(`撤单失败：${msg(e)}`, 'bad')
  } finally {
    orderBusy.value = false
    void loadOrders()
  }
}

/** 「全部撤单」正在提交 */
const cancellingAll = ref(false)

/** 这个 keyId 是哪套账户（理论上一定找得到，兜底给个说法） */
function keyNameOf(id?: number): string {
  return keys.value.find(k => k.id === id)?.name ?? '默认账户'
}

/**
 * 撤掉「挂单」列表里**现在这些**（用户 2026-10-07：「右侧加全部撤仓」+「需二次确认」）。
 *
 * 口径：**列表里有什么就撤什么** —— 跟着 tab 选中的账户、也跟着那一格的
 * 币种 / 类型筛选走（`items` 由 board 从筛过的列表里拼好，每项自带 `keyId`，
 * 因为「全部」那一格可能横跨两套账户）。
 *
 * ⚠️ 确认框里**不再写「真单 / 真撤」那类前缀**（用户 2026-10-07：「提示层真单的那种
 *    去掉，都是真单」）—— 只留一句人话说明代价（平仓保护没了），确认键走 `danger` 就够。
 */
async function cancelListedOrders(p: {
  items: {keyId?: number; symbol: string; orderId: string}[]
  what: string
}): Promise<void> {
  if (!p.items.length || cancellingAll.value) return
  const names = [...new Set(p.items.map(i => keyNameOf(i.keyId)))].join(' + ')
  const ok = await askConfirm({
    title: `撤掉这 ${p.items.length} 张挂单？`,
    body: [
      {t: `账户：${names}`, tone: 'num'},
      {t: `范围：${p.what}`, tone: 'num'},
      {t: '撤掉之后这些平仓保护就没了。', tone: 'warn'}
    ],
    okText: '全部撤单',
    danger: true
  })
  if (!ok) return
  cancellingAll.value = true
  try {
    const r = await cancelTradeOrders(p.items)
    if (r.failed?.length)
      sayMsg(
        `撤掉 ${r.cancelled} 张，${r.failed.length} 张没撤掉：${r.failed[0]?.error ?? ''}`,
        'bad'
      )
    else sayMsg(`已撤掉 ${r.cancelled} 张挂单`, 'ok')
  } catch (e) {
    sayMsg(`撤单失败：${msg(e)}`, 'bad')
  } finally {
    cancellingAll.value = false
    void loadOrders()
  }
}

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

/** 平仓：市价 reduceOnly **只平一部分**（真单，⚠️ 会真成交） */
async function confirmReduce(pct: number): Promise<void> {
  const r = reduceRow.value
  if (!r || posBusy.value) return
  posBusy.value = true
  try {
    const res = await closeTradePositions(
      {symbol: r.symbol, side: r.side, pct},
      /* ⚠️ **必须落到一个具体的 id**：不传就是后端拿默认 Key（另一套账户）去平 */
      resolveKeyId(r.keyId, r.keyName),
      /* ⚠️ 跟「配置 → 测试下单」保持一致：开着测试单就只校验，不然这里会真成交 */
      testOrder.value
    )
    if (res.ok) {
      reduceRow.value = null
      sayMsg(
        res.test
          ? `测试平仓通过校验：${baseOf(r.symbol)} ${pct}%（没进撮合）`
          : `已平仓 ${baseOf(r.symbol)} ${pct}%`
      )
      void doRefresh()
    } else {
      sayMsg(res.error || '全平失败', 'bad')
    }
  } catch (e) {
    sayMsg(msg(e), 'bad')
  } finally {
    posBusy.value = false
  }
}

/** 全平：**整条**市价全平（真单） */
async function closeRow(p: PositionRef): Promise<void> {
  if (posBusy.value) return
  const name = baseOf(p.symbol)
  const test = testOrder.value
  const ok = await askConfirm({
    title: `全平 ${name} 这一条持仓？`,
    body: test
      ? {t: '测试单只发到币安测试接口，不进撮合、不会真平。', tone: 'num'}
      : {t: '按市价全平这一条，会真的成交。', tone: 'warn'},
    okText: '全平',
    danger: !test
  })
  if (!ok) return
  posBusy.value = true
  try {
    const res = await closeTradePositions(
      {symbol: p.symbol, side: p.side},
      /* ⚠️ 同上：不传 id = 后端拿默认那套 Key（不是人正在看的这套） */
      resolveKeyId(p.keyId, p.keyName),
      testOrder.value
    )
    if (res.ok) {
      sayMsg(res.test ? `测试全平通过校验：${name}（没进撮合）` : `已全平 ${name}`)
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
 * 一键平仓：把**当前全部**持仓市价平掉（用户 2026-10-07：
 * 「右侧加一键平仓 需二次弹窗确认」）。
 *
 * ⚠️ 真钱动作（除非「配置 → 测试下单」开着）⇒ 先弹一次确认，弹窗里写明**哪套账户**、
 *    有几条、分别是哪些币；确认后**逐条串行**提交（一条失败不影响后面），最后报一条汇总。
 * ⚠️ 一条都不许「静默跳过」：失败的币名和原因都塞进那条汇总里。
 * ⚠️ 交上来的是板子那侧的**全部**持仓（不是屏幕上铺出来的那几条），别在这儿再切一次。
 * ⚠️ **用哪套 Key 只认 `resolveKeyId`**，别把 `row.keyId` 直接交出去 ——
 *    2026-10-07 的 bug 就是单套视图里 `keyId` 是空的，后端兜到默认那套「测试」。
 */
async function closeAllRows(rows: PositionRef[]): Promise<void> {
  if (posBusy.value || !rows.length) return
  const test = testOrder.value
  const names = rows.map(r => baseOf(r.symbol)).join(' / ')
  /*
   * ⚠️「全部」那一屏的持仓可能来自**好几套 Key** ⇒ 按 Key 去重后**各平一次**。
   *
   * ⚠️⚠️ **一律用 `resolveKeyId` 换成一个具体的 id**（单套视图也一样，
   *    平的却是「测试」。这里再也不许出现「不带 id 就发出去」。
   */
  const ids = [
    ...new Set(rows.map(r => resolveKeyId(r.keyId, r.keyName)).filter(k => !!k))
  ] as number[]
  /* 理论上到不了（页面只有在有 Key 时才渲染这颗按钮）；真到了就**别猜**，直接不发 */
  if (!ids.length) {
    sayMsg('不知道该用哪套账户去平 —— 先切一下账户再试', 'bad')
    return
  }
  const nameOf = (id: number): string =>
    keys.value.find(k => k.id === id)?.name ?? `key ${id}`
  /*
   * 标题里带上**账户**（用户 2026-10-07 报的正是「平的不是选择的账户」）——
   * 只写条数的话，人没法从弹窗上核对这一下要动的是哪套。
   */
  const scope = ids.length === 1 ? nameOf(ids[0]!) : `${ids.length} 套账户`
  const ok = await askConfirm({
    title: `平掉「${scope}」全部 ${rows.length} 条持仓？`,
    body: [
      test
        ? {t: '测试单只发到币安测试接口，不进撮合、不会真平。', tone: 'num'}
        : {t: `${names} 全部按市价平掉，会真的成交。`, tone: 'warn'},
      ...(ids.length > 1 ? [`分 ${ids.length} 套账户各平一次`] : [])
    ],
    okText: test ? '测试一遍' : '全部平掉',
    danger: !test
  })
  if (!ok) return
  posBusy.value = true
  let done = 0
  const failed: string[] = []
  try {
    for (const id of ids) {
      /*
       * ⚠️ **不传 `symbol`** —— 那是后端「把这个账户里所有持仓全平」那条路：
       *    它自己从交易所读持仓（币安原始符号 + 双向持仓的 `positionSide`），
       *    比前端逐条报符号再平更准。
       */
      const res = await closeTradePositions(undefined, id, test)
      const n = res.orders?.length ?? 0
      if (res.ok) done += n
      else failed.push(`${nameOf(id)}（${res.error || '失败'}）`)
    }
    if (failed.length) sayMsg(`平掉 ${done} 条，失败：${failed.join('、')}`, 'bad')
    else
      sayMsg(
        test ? `测试平仓通过校验：${done} 条（没进撮合）` : `已全部平仓：${done} 条`
      )
    void doRefresh()
  } catch (e) {
    sayMsg(msg(e), 'bad')
  } finally {
    posBusy.value = false
  }
}

/* ---------------- 点币种标题行 → 看这个币的 K 线 ---------------- */

const router = useRouter()

/**
 * 点持仓卡的币种标题行 = 选中这个币 + 去「开单分析」看图。
 *
 * ⚠️ 跟「合约」页点一行（`ContractsView.onPickMarket`）**逐字同一条路**：
 *    `prefetchSymbol` 先把 K 线请求发出去（服务端是内存/本地库，切过去基本已命中）、
 *    `pickSymbol` 换掉分析页那套全局币种（会清掉上一只币的结论 + 重拉历史）、
 *    最后才跳页 —— 顺序不能反，反了会看到上一只币的结论闪一下。
 */
function openChart(base: string): void {
  if (!base) return
  prefetchSymbol(base)
  pickSymbol(base)
  void router.push('/analyze')
}

/* ---------------- 止盈 / 止损（持仓卡片上那颗按钮。
 *
 * 弹层的所有输入都来自板子给的那一坨（`TpSlTarget`），这里**不回头推** ——
 * 板子那边才知道开仓均价 / 标记价 / 数量 / 已有的条件单（见 `tpsl.ts`）。
 */
function openTpSl(t: TpSlTarget): void {
  if (posBusy.value) return
  /*
   * ⚠️ 跟平仓那边同一条规矩：`keyId` **必须落成一个具体的 id** ——
   *    空着去挂条件单就挂到**默认那套**账户上了。
   *    `TpSlTarget` 里没有 `keyName`，认不出来时按「当前选中的那一套」算。
   */
  tpslTarget.value = {...t, keyId: resolveKeyId(t.keyId)}
}

/** 价格的小数位（只在提示文案里用） */
function fmtPrice(v: number): string {
  const a = Math.abs(v)
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8
  return v.toFixed(d)
}

/**
 * 弹层点了「确认」——**一次把列表里所有改动提交完**。
 *
 * 用户 2026-10-06：「止盈止损滑动条区分开」「由于有部分平仓的多个平价价格和百分比
 * 要显示可点击修改」「确认键没了」⇒ 弹层改成「多行 + 一颗确认」，这里就按顺序执行
 * 那几条动作（撤 / 改 / 挂），任何一条出错都记下来、成功的照旧。
 *
 * ⚠️ **真金白银**：`testOrder === false` 时交易所那边真挂 / 真改 / 真撤。
 *    `id` 有值 = 改单（后端先撤旧的再挂新的；测试模式不撤）。
 * ⚠️ `posSide` 按持仓方向给（`LONG` / `SHORT`）：**双向持仓模式**下币安认这个，
 *    不给会默认当成 LONG —— 空头的止损就挂到错的那一边。单向模式下后端忽略它、
 *    改走 `reduceOnly`（见后端 `placeStopOrder` 里的 `dual` 判断）。
 * ⚠️ 数量按百分比算，**后端再按合约精度向下取整**（取整后是 0 会报错，不会偷偷放大）。
 * ⚠️ **串行**执行，不并发：改单是「撤旧的 + 挂新的」两步，同一个交易对并发容易被
 *    币安按顺序拒（`-2011` 之类）；而且串行才能把每条的结果说清楚。
 */
async function saveTpSl(actions: TpSlAction[]): Promise<void> {
  const t = tpslTarget.value
  if (!t || posBusy.value || !actions.length) return
  posBusy.value = true
  let done = 0
  const bad: string[] = []
  /** 后端按现价校正过类型的那些，最后并进提示里 */
  const noteTips: string[] = []
  try {
    for (const a of actions) {
      const what = a.kind === 'profit' ? '止盈' : '止损'
      try {
        if (a.cancel && a.id) {
          const r = await cancelTradeOrder(t.raw, a.id, t.keyId)
          if (!r.ok) bad.push(`撤${what}：${r.error || '失败'}`)
          else done++
          continue
        }
        const r = await placeStopOrder(
          {
            symbol: t.raw,
            /* 平仓方向跟仓位反着来：多头的止盈 / 止损是**卖** */
            side: closeSideOf(t.side),
            kind: a.kind,
            stopPrice: a.price,
            quantity: (t.amount * a.pct) / 100,
            posSide: t.side === 'short' ? 'SHORT' : 'LONG',
            orderId: a.id
          },
          t.keyId,
          testOrder.value
        )
        if (!r.ok) {
          bad.push(`${a.id ? '改' : '挂'}${what} ${fmtPrice(a.price)}：${r.error || '失败'}`)
          continue
        }
        done++
        /*
         * ⚠️ 类型以后端**实际发出去**那个 `r.kind` 为准：币安只认「触发价相对现价在
         *    哪一侧」，跟我们填的那一行可能不一样（后端 `legalKind()` 校正过）。
         *    用 a.kind 会出现「提示说止盈、实际挂的是止损」。
         */
        if (r.kind && r.kind !== a.kind) {
          noteTips.push(
            `${fmtPrice(a.price)} 落在现价这一侧，按币安的规矩当成${
              r.kind === 'profit' ? '止盈' : '止损'
            }挂了`
          )
        }
      } catch (e) {
        bad.push(`${a.id ? '改' : '挂'}${what}：${msg(e)}`)
      }
    }
    if (bad.length) {
      /* 有失败的：弹层**留在原地**（人还能改价重试），把原因说出来 */
      sayMsg(`${done ? `成功 ${done} 处；` : ''}${bad.join('；')}`, 'bad')
    } else {
      const test = testOrder.value
      sayMsg(
        test
          ? `测试通过校验：${done} 处止盈止损（条件单没有测试接口，没真挂上去）`
          : `${t.name} 已提交 ${done} 处止盈止损${noteTips.length ? `（${noteTips.join('；')}）` : ''}`,
        'ok'
      )
      tpslTarget.value = null
    }
    /* 挂单列表刷新：真单那条路后端会推 `orders` 事件；这里再补一次**本地读** */
    void loadOrders()
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
 * **仓位历史**：开仓 → 全平算一笔。
 * ⚠️ 不是 income 的分类统计 —— 那个只用来给持仓卡上的「已结」供数。
 */
const cycles = ref<ExchangePositionCycle[]>([])
const openCycles = ref<ExchangePositionCycle[]>([])
const cyclesSince = ref<string | null>(null)

/*
 * 读仓位历史（**纯本地**，不打交易所）。
 *
 * ⚠️ 只读**当前视图里那几套**（`activeTargets`）—— 用户 2026-10-07：
 *    「仓位历史…没有根据账户分类显示」：以前这里读的是 `listAll`（全部账户），
 *    而 `many` 却按「选中的是不是多套」算 ⇒ 选「币安」时会把「测试」那些段
 *    也铺出来，**而且一条账号标签都不打**（`many=false`），根本分不出是谁的。
 *    同一处毛病资金动向也有（见 `loadIncome`）；成交 / 挂单 / 收支曲线早就按
 *    `activeTargets` 读了 —— 现在四处口径一致：**看哪套就只列哪套**，
 *    选「全部」时才合并、并且每条都带账号标签。
 */
async function loadCycles(): Promise<void> {
  const list = activeTargets.value
  const many = multi.value
  const closed: ExchangePositionCycle[] = []
  const open: ExchangePositionCycle[] = []
  let since: string | null = null
  for (const k of list) {
    try {
      const r = await fetchExchangePositionHistory(k.id, LEDGER_MAX, rangeOf('inc'))
      if (r.since && (!since || r.since < since)) since = r.since
      for (const c of r.cycles ?? [])
        closed.push(many ? {...c, keyName: k.name} : c)
      for (const c of r.open ?? []) open.push(many ? {...c, keyName: k.name} : c)
    } catch (e) {
      if (!isAuthError(e)) err.value = `读取仓位历史失败：${msg(e)}`
    }
  }
  /*
   * ⚠️ 合并完**必须自己再排一次**，不然「全部」是**按 key 一段一段接起来**的：
   *    后端每套返回的已经排好了（已平的按**平仓时间**倒序、没平完的按**开仓时间**倒序），
   *    但上面那个 for-循环是逐套 push ⇒ 顺序变成「第一套的全部，然后第二套的全部」。
   *    而 `keys` 的顺序是 `is_default DESC, id`，默认那套（本机是「测试」）永远在前面。
   *
   *    实测（2026-10-07 用户「选择全部显示的还是测试账户下的」，390px 窄屏）：
   *      测试 35 笔 + 币安 7 笔 = 42 笔，而窄屏默认只铺 20 条 ⇒ **第一屏 20 条
   *      100% 是「测试」的**，得滚到底才看得到「币安」那 7 笔（还沉在最底下）。
   *    成交历史 / 资金动向早就在合并后 `sort()` 了，这里漏了 —— 现在补齐。
   *    排序键照抄 `data/position-history.ts` 里那两个 `.sort()`，别自己发明一个。
   */
  const byClose = (a: ExchangePositionCycle, b: ExchangePositionCycle) =>
    String(b.closeAt ?? '').localeCompare(String(a.closeAt ?? ''))
  const byOpen = (a: ExchangePositionCycle, b: ExchangePositionCycle) =>
    String(b.openAt ?? '').localeCompare(String(a.openAt ?? ''))
  cycles.value = closed.sort(byClose)
  openCycles.value = open.sort(byOpen)
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
        setAvailableBalance(id, r.overview.futures?.available, dbAt)
      }
      delete nextReason[id]
    }
    /*
     * 该不该主动刷一次：看**手上这份数据多旧**（不是库里那行），
     * 而且**只在流不活着、或者后端说上游哑了的时候**才刷 ——
     * 流真正活着就说明后端会自己推（含 5 分钟采样），切 tab 不该白打一遍交易所。
     * ⚠️ 「后端说哑了」这一条不能省：SSE 心跳一直有，但上游可能一帧不推。
     */
    const warming = streamWarming(id)
    if (
      !warming &&
      (!streamAlive(id) || deaf.value[id] === true) &&
      Date.now() - (snapAt[id] ?? 0) > REFRESH_AFTER_SEC * 1000
    )
      stale = true
    /*
     * 还在握手就先不下结论：宽限期结束时**重判一次**——
     * 那会儿要是还没人推（`streamAt` 仍是 0），上面那条就会成立，照样兜底刷。
     */
    if (warming && graceTimer === null) {
      graceTimer = setTimeout(() => {
        graceTimer = null
        void loadSnapshots()
      }, STREAM_GRACE_STEP_MS)
    }
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
     * **几套并发刷**。
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
        setAvailableBalance(k.id, r.overview.futures?.available)
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
 * 移动端下拉刷新—— 见 `pull-refresh.ts` 里那段说明：
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
      const r = await fetchExchangeFills(k.id, LEDGER_MAX, rangeOf('trades'))
      for (const t of r.fills ?? []) all.push(many ? {...t, keyName: k.name} : t)
    } catch (e) {
      if (!isAuthError(e)) err.value = `读取成交失败：${msg(e)}`
    }
  }
  all.sort((a, b) =>
    String(b.datetime ?? '').localeCompare(String(a.datetime ?? ''))
  )
  fills.value = all.slice(0, LEDGER_MAX)
}

/**
 * 钱账本（`/fapi/v1/income` 的落库版）—— 「盈亏」tab 的数据源。
 *
 * **不再**从 `fills.realized` 现算（那是毛数，漏手续费和资金费）。
 *   这里读的是币安那本账：已实现 + 手续费 + 资金费 + 其它，四类直接相加才是净的。
 *   纯本地读，不打交易所（数据由后端定期对账灌进来）。
 */
async function loadIncome(): Promise<void> {
  /* ⚠️ 跟 `loadCycles` 同一个口径：只读**当前视图里那几套**（用户 2026-10-07：
     资金动向也要按账户分类显示）。`totals` 跟着一起变 —— 它就是这一格右上角
     「近 N 天 · M 笔」那个 M，列表筛了、合计不筛的话两个数对不上。 */
  const list = activeTargets.value
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
      /*
       * ⚠️ `days` 一律传 **0（全部历史）**，范围交给 `from/to` ——
       *    两个条件是**与**关系：传 `days=7` 再挑「近 30 天」会被那 7 天卡死
       *    （实测：30 天和 7 天返回的行数一模一样）。
       *    默认那一档本来就是「近 7 天」（`defaultFilter()` 里算好了 from/to）。
       */
      const r = await fetchExchangeIncome(k.id, 0, LEDGER_MAX, rangeOf('flow'))
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
  income.value = rows.slice(0, LEDGER_MAX)
}

/**
 * 挂单：几套合起来（多套时每条标出是哪套的），失败原因也带上账户名。
 *
 * 「我点击交易所界面，订单过 2 秒才出来」）：
 *   ① **几套并发拉**，不再一套一套串（以前 2 套 = 2 个来回叠加，
 *      而这是经出口隧道打币安，一个来回就一秒上下）；
 *   ② 后端可能回的是**旧值**（`stale: true`，它同时在后台刷新的那份）——
 *      这种情况过 1.2 秒再问一次，那时缓存已经是新的、命中即回。
 *      ⇒ 界面上永远是「立刻有东西看」，不是白等一个转圈。
 */
async function loadOrders(opts: {silent?: boolean} = {}): Promise<void> {
  const list = activeTargets.value
  const many = multi.value
  /*
   * ⚠️ `silent` = **不转那颗「正在查询挂单…」的圈**。兜底那 20 秒一轮的重读走静默
   *    （用户 2026-10-06 明确嫌过挂单那块的 loading 闪一下不好看），
   *    真·换账户 / 手动刷新才亮圈。
   */
  if (!opts.silent) loadingOrders.value = true
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
    /*
     * ⚠️ `keyId` 是**这里**贴上去的（后端那份载荷里没有）：挂单那一格的
     *    「全部撤单」要按账户把单分回各家，一条请求里可能混着两套账户。
     */
    for (const o of r.openOrders ?? []) out.push({...o, keyId: k.id, ...(many ? {keyName: k.name} : {})})
  })
  openOrders.value = out
  ordersErr.value = errs.join('；')
  if (!opts.silent) loadingOrders.value = false
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
 * 多套时**按时间桶加总**。
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
  /*
   * ⚠️ 桶宽取**最大**的那一套：几套的桶宽可能不一样（`all` 跨度是按各套最早那条
   *    快照算的），取最宽的那个，`ExchangeCurveChart` 里「间隔超过 2.5 个桶算断档」
   *    才不会把正常的稀疏点误判成断线。
   */
  curveBucketSec.value = Math.max(300, ...ok.map(r => r.bucketSec || 300))
  if (ok.length === 1) {
    curve.value = ok[0]!.points ?? []
    curveAt = Date.now()
    return
  }

  /*
   * 合并改成**按「各自最近的已知值」相加**。
   *
   * ⚠️ 以前是「同一个 `t` 上各家都有点才算进和」—— 可各套的采样时刻根本不齐
   *    （实测一套 152 个点、另一套 132 个），于是**只有一边有数据的桶，
   *    曲线就只剩那一套的值**（总账 ~28 掉到 ~13），看着就是
   *    「数据没有统计进去全部」。
   * ⚠️ 某套在最早那几个桶还没开始采（`t` 早于它的第一个点）时，
   *    用它的**第一个点**回填 —— 宁可把它当时的值算进去，也不要让总账缺一块。
   */
  const series = ok.map(r =>
    [...(r.points ?? [])].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  )
  const times = [...new Set(series.flat().map(p => p.t))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  /** 每套走到第几个点了 —— 只往前推，永远指向「≤ 当前 t 的最后一个点」 */
  const idx = series.map(() => 0)
  const merged: CurvePoint[] = []
  for (const t of times) {
    let close = 0
    let high = 0
    let low = 0
    let any = false
    for (let i = 0; i < series.length; i++) {
      const s = series[i]!
      let k = idx[i]!
      while (k < s.length - 1 && s[k + 1]!.t <= t) k++
      idx[i] = k
      const p = s[k]
      if (!p) continue
      close += p.close
      high += p.high
      low += p.low
      any = true
    }
    if (any) merged.push({t, close, high, low})
  }
  curve.value = merged
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
 * 以前每次换 tab 都 `stopStreams()` + 重新订阅 ——
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
             setAvailableBalance(k.id, r.overview.futures?.available)
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
         * ⚠️ **不动 `snapAt`**：这份补丁更新持仓 / 钱包 / 可用余额，C2C / 现货还是上一份快照的，
         *    所以那条「太久没整份快照就刷一次」的兜底定时器不该被它喂饱。
         */
        positions: p => {
          setAvailableBalance(k.id, p.available)
          const cur = parts.value[k.id]
          if (!cur) return
          parts.value = {
            ...parts.value,
            [k.id]: {
              ...cur,
              /*
               * 这里**只盖 `liveAt`，不碰 `takenAt`**。
               *
               * ⚠️ 原来写的是 `takenAt: p.at`，于是那颗「几分钟前」的标签在**有持仓**
               *    的账户上永远显示「刚刚更新」—— 因为持仓/浮盈每秒都在推。
               *    可它旁边那几项（C2C / 现货）其实还是上一份快照的，
               *    最长可能一小时前 —— 标签在**替它们报喜**。
               *    现在拆成两个时间：`liveAt` = 合约那块（WS，秒级），
               *    `takenAt` = 整份快照（现货 / C2C / 资产明细）。
               */
              liveAt: p.at,
              futures: {
                ...cur.futures,
                positions: p.positions,
                wallet: p.wallet,
                available: p.available,
                used: Math.max(p.margin - p.available, 0),
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
          /*
           * 同一笔可能「实时事件」和「REST 回补」都给到 → 按**成交号**去重。
           *
           * ⚠️ 2026-10-07 修：后端这条事件以前**没带 `id`**，而这里拿 `f.id === t.id` 判重复 ——
           *    `t.id` 是 `undefined`，列表里一旦躺了一条 `id: undefined` 的（就是上一笔），
           *    **后面每一笔都被这行挡掉**。表现就是用户报的
           *    「成交历史 / 仓位历史不是实时的，有延迟」：一个仓分 3 笔成交，只有第一笔
           *    触发重读，另外两笔丢了，得等 20 秒兜底。
           *    后端现在发的就是 `/api/exchange/fills` 的形状（`id` / `datetime` / `cost` /
           *    `feeCurrency` 都齐），所以这里能真正按成交号去重；`id` 缺失时**别去重**
           *    （宁可重复一下 —— 下一轮 `loadFills()` 会用整份覆盖回来）。
           */
          if (t.id && fills.value.some(f => f.id === t.id)) return
          /*
           * ⚠️ 只有「范围被**用户手动关到过去**」时才丢这笔 —— 他把成交历史筛成
           *    「8 月 1 号 → 8 月 10 号」的时候，刚成交的这笔不该冒在最上面。
           *
           * ⚠️ 判据必须是 `range === 'custom'`，**不能只看 `rf.to`**：`rf.to` 在
           *    「今天 / 近 N 天」这些相对范围下也是个**过期快照**（挂载那一刻的 now），
           *    于是 `rf.to < Date.now() - 1000` 从页面活过 1 秒之后**恒为真** ——
           *    所有实时成交都被这一行静默丢掉，而那正是用户报的
           *    「成交记录根本就没有实时变」（2026-10-08）。
           */
          const rf = filters.trades
          if (rf.range === 'custom' && rf.to && rf.to < Date.now() - 1000) return
          const tagged = keys.value.length > 1 ? {...t, keyName: k.name} : t
          fills.value = [tagged, ...fills.value].slice(0, LEDGER_MAX)
          /* 仓位历史是从成交推出来的 —— 新成交可能刚开一段、也可能刚平掉一段 */
          void loadCycles()
          /*
           * 钱账本（已实现 / 手续费）后端在**同一条 WS 帧里**也写了一份
           * （见 `writeIncomeFromFill`）⇒ 顺手重读一次。
           * 不然「资金动向」和持仓卡上那行「已实现盈利」要等下一轮 `income` 事件
           * （那是**对账**的节奏，几分钟）或者 20 秒兜底才动。
           */
          void loadIncome()
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
            /*
             * 「挂单数据没有更新，仓位历史也没更新」）：
             *   断线期间**挂单 / 仓位历史也变了**，可以前这里只补快照 / 成交 / 曲线，
             *   那两份列表就一直停在断线前那一份 —— 一直等到下一次 `orders` / `fill`
             *   事件才动，账户安静时能旧很久（后端重启、隧道抖动都算断线）。
             *   两下都是**读库**（毫秒级、零权重），补上不心疼；
             *   挂单那份走**静默**，别让「正在查询挂单…」闪出来。
             */
            void loadOrders({silent: true})
            void loadCycles()
            /*
             * ⚠️ 资金动向也要补（2026-10-08）—— 断线期间**手续费/已实现盈亏**会写进账本
             *    （后端从成交帧里就地写），重连时这份就旧了；而原来这里只补了
             *    快照/成交/曲线/挂单/仓位历史，**漏了它**（日常靠 20 秒兜底盖住，
             *    但那意味着"最久迟 20 秒才动"）。
             */
            void loadIncome()
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
 * 以前这里把**所有状态清空**再全部重拉 ——
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
 * 一上来加的是「整份快照超 90 秒就刷」，但**持仓/未实现盈亏
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
    /*
     * **兜底重读**挂单 + 仓位历史（用户：「挂单数据没有更新，
     *   仓位历史也没更新」「没有及时更新」）。
     *
     * 这两份以前**只有** SSE 的 `orders` / `fill` 事件会触发重读 —— 事件本身可能
     * 就不来：断线那阵子（重连只补快照/成交/曲线，见 `reconnect`）、后端重启、
     * 或者交易所那边对账窗口还没轮到。结果就是「数字明明变了，列表还是旧的」，
     * 只能靠手动刷新或者切账户。
     *
     * ⚠️ 敢放这儿的理由：两下都是**读我们自己的库**（挂单存库 / 仓位历史本地推），
     *    毫秒级、零交易所权重 —— 跟上面那个「打交易所的快照」不是一回事。
     * ⚠️ 挂单走 `silent`，别让「正在查询挂单…」每 20 秒闪一下。
     * ⚠️ 只在这一页（交易所账户这一格）活着的时候跑：`stopWork()` 会清掉这个定时器。
     */
    void loadOrders({silent: true})
    void loadCycles()
    /* 钱账本也读库（成交 / 资金费 / 划转都会往里写）⇒ 一并兜底 */
    void loadIncome()
    /*
     * ⚠️ 成交历史也要兜底（2026-10-08 补）—— 它原来是这三格里**唯一没有兜底**的：
     *    只靠 SSE 的 `fill` / `backfill` 事件触发重读。事件一丢（SSE 重连、后端重启、
     *    后端那条用户流哑了），列表就**停在旧数据**，只能切 tab 或刷新页面 ——
     *    用户报的「成交历史不是实时刷新的」就是这个。
     *    读的是我们自己的库（`exchange_fills`），毫秒级、零交易所权重，敢放这儿。
     *    这一格本来就没有加载态（不像挂单那条），所以不用传 `silent`。
     */
    void loadFills()

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

/**
 * 换了二级 tab ⇒ **重读那一格的数据**。
 *
 * 这三份平时只靠 SSE 事件触发重读，切过去时先自己拉一次：
 * 挂单（存库）、仓位历史（本地推）、成交（后端账本）—— 都是读库，毫秒级、零权重，
 * 所以每次切换都可以放心拉。
 */
function onTab(t: string): void {
  if (t === 'ord') void loadOrders({silent: true})
  else if (t === 'inc') void loadCycles()
  else if (t === 'trades') void loadFills()
  else if (t === 'flow') void loadIncome()
}

/* ---------------- 开 / 停这一页的数据流 ---------------- */
/**
 * 开始工作：订阅 SSE + 起兜底定时器，并在「手上还没有数据」时补一次读库。
 *
 * ⚠️ 有数据就不重读 —— 这正是**缓存**要的效果（用户 2026-10-06：
 *    「为什么进入时有正在获取交易快照」「该页面要做缓存」）。
 *    重连 SSE 时后端会把当前那份快照再推一遍，数字自己就更新了。
 */
function startWork(): void {
  if (!keys.value.length) return
  /* 打点：从这一刻起 `STREAM_GRACE_MS` 内不许判定「流死了」（见 `streamWarming`） */
  openedAt = Date.now()
  startStreams()
  startSnapTimer()
  startLastPrices()
  if (!data.value && !reason.value) void loadSnapshots()
  /*
   * ★ **进来就把三本台账读一遍**（2026-10-08 加）。
   *
   * 为什么：这三格原来只靠 SSE 事件触发重读。可是**下单往往不在这一页**
   *   （K 线页底部那个下单模块，那会儿这条账户流压根没有订阅者 ——
   *   线上日志实测过：用户 12:34 下单时那几行统计都是 `观察者 0`），
   *   于是"事件"这条路必然收不到 ⇒ 打开这一页看到的还是上次那份旧数据
   *   （快照那份被缓存挡住不重读，见下面那句的注释）。
   *   用户报的「仓位历史/成交/资金动向不实时」有一半就是这个场景。
   *
   * ⚠️ 敢在这儿读四份的理由：**全是读我们自己的库**（成交/仓位历史/钱账本/挂单），
   *    毫秒级、零交易所权重。所以"进页面必读"是划算的，也**不违反**当初
   *    「进页面别去打交易所」那条（那条说的是 `loadSnapshots()` 那个 25 权重的快照）。
   * ⚠️ 挂单走 `silent`，别让"正在查询挂单…"闪一下。
   * ⚠️ 快照**仍然**按缓存策略（`data.value` 有了就不重读）—— 它是打交易所的那一发。
   */
  void loadFills()
  void loadCycles()
  void loadIncome()
  void loadOrders({silent: true})
}

/** 停掉：两条 SSE + 三个定时器（没人看的时候一条请求都不发） */
function stopWork(): void {
  stopStreams()
  stopLastPrices()
  if (snapTimer) clearInterval(snapTimer)
  snapTimer = null
  if (ordersRetryTimer) clearTimeout(ordersRetryTimer)
  ordersRetryTimer = null
  if (graceTimer) clearTimeout(graceTimer)
  graceTimer = null
}

/* ---------------- 最新成交价（持仓卡第一格「当前价」） ---------------- */

/**
 * 挂上「全市场行情」那条流，只为了拿持仓这几个币的**最新成交价**。
 *
 * ⚠️ 跟标记价是两个数：现价是最后一笔成交，标记价是币安防插针那个加权价
 *    （浮盈 / 强平按标记价算）。持仓接口里只有标记价，所以这一格得靠行情。
 * ⚠️ 这条流是**全市场**的（一条流管所有币、不吃权重），而且 `api.ts` 的 `sharedSse`
 *    会按 path 复用 —— 跟「合约」页头部那条其实是同一条连接。
 * ⚠️ 只订阅**当前视图里这几个币**（`activeTargets` 变了就自动跟着变），
 *    不然每秒几百个币的增量全会写进响应式对象、白触发重渲染。
 */
let unbindLastPrices: (() => void) | null = null

function startLastPrices(): void {
  if (unbindLastPrices) return
  unbindLastPrices = bindLastPrices(() =>
    (data.value?.futures?.positions ?? []).map(p => p.raw ?? p.symbol)
  )
}

function stopLastPrices(): void {
  unbindLastPrices?.()
  unbindLastPrices = null
}

/*
 * ⚠️ `immediate` 用默认的 false —— 挂载那一刻由 `onMounted` 自己决定要不要开工，
 *    那时 `keys` 还没到，这里跑了也是空转。
 */
watch(live, on => {
  if (on) startWork()
  else stopWork()
})

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
   * 默认落在「全部」；
   * 只有一套时 `activeTargets` 就是它自己，效果跟以前一样。
   */
  picked.value = keys.value.length > 1 ? 'all' : String(keys.value[0]!.id)

  /*
   * 给每一套账户都开上 SSE、起兜底定时器（见 `startWork`）。
   * ⚠️ 切走再切回来**不会重走这里**（组件被缓存在 DOM 里），
   *    开关交给上面那个 `watch(live)`。
   */
  if (live.value) startWork()
})

onUnmounted(stopWork)
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
      :income-totals="incomeTotals"
      :cycles="cycles"
      :open-cycles="openCycles"
      :cycles-since="cyclesSince"
      :loading-orders="loadingOrders"
      :refreshing="refreshing"
      :curve="curve"
      :curve-range="curveRange"
      :curve-bucket-sec="curveBucketSec"
      :rate="rate"
      :last-price="lastPrices"
      :busy="posBusy"
      @update:curve-range="curveRange = $event"
      @refresh="doRefresh()"
      @transfer="transferOpen = true"
      @reduce="openReduce"
      @close="closeRow"
      @closeAll="closeAllRows"
      @tpsl="openTpSl"
      @open-chart="openChart"
      @edit-order="openOrderEdit"
      @tab="onTab"
      :cycles-filter="{
        symbol: filters.inc.symbol,
        range: rangeLabel('inc'),
        filtered: filtered('inc'),
        rangeOn: rangeOn('inc')
      }"
      :fills-filter="{
        symbol: filters.trades.symbol,
        range: rangeLabel('trades'),
        filtered: filtered('trades'),
        rangeOn: rangeOn('trades')
      }"
      :flow-filter="{
        symbol: filters.flow.symbol,
        range: rangeLabel('flow'),
        types: typesLabel('flow'),
        filtered: filtered('flow'),
        rangeOn: rangeOn('flow')
      }"
      :cancelling-orders="cancellingAll"
      @filter="onLedgerFilter"
      @range="onLedgerRange"
      @cancel-all="cancelListedOrders"
    />

    <!--
      「周期范围」底部弹窗（账本三格右上角那颗按钮打开）。
      ⚠️ 三个共用一个实例：开哪一格由 `rangeSheet` 决定，值也从那一格的 `filters` 里取
         （所以关掉再打开看到的是那一格**自己的**选择）。
    -->
    <LedgerRangeSheet
      :model-value="!!rangeSheet"
      :title="rangeSheet ? RANGE_TITLE[rangeSheet] : ''"
      :range="rangeSheet ? filters[rangeSheet].range : '7d'"
      :from="rangeSheet ? filters[rangeSheet].from : null"
      :to="rangeSheet ? filters[rangeSheet].to : null"
      :types="rangeSheet === 'flow' ? filters.flow.types : null"
      :type-filter="rangeSheet === 'flow'"
      :count="rangeCount"
      @update:model-value="v => !v && (rangeSheet = null)"
      @apply="onRangeApply"
    />

    <!--
      平仓弹层（用户 2026-10-05：「加个按钮减仓 弹窗选择百分比」。
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
      止盈 / 止损弹层（用户 2026-10-06：「按钮加上止盈/止损是一个按钮，点击显示
      当前仓位的止盈止损可以设置」）——
      跟减仓一样挂在**容器**这一层：只有它知道这一条是哪套 Key 的、拿得到下单接口。
      ⚠️ 那一坨目标数据是板子点按钮时给的（开仓价 / 标记价 / 数量 / 已有的**全部**条件单）。
      ⚠️ 弹层只负责收集，提交是 `saveTpSl()` 串行执行那一串动作。
    -->
    <TpSlSheet
      :open="!!tpslTarget"
      :target="tpslTarget"
      :test-order="testOrder"
      :busy="posBusy"
      @close="tpslTarget = null"
      @confirm="saveTpSl"
    />

    <!--
      改挂单弹层——
      「挂单」那一行点一下就是它。跟止盈止损一样挂在**容器**这一层：
      只有它知道这张单是哪套 Key 的、也只有它能调改单 / 撤单接口。
      ⚠️ 改单和撤单**都没有测试版**，所以弹层里那两颗按钮点下去就是真动作。
    -->
    <OrderEditSheet
      :open="!!editTarget"
      :target="editTarget"
      :busy="orderBusy"
      @close="editTarget = null"
      @save="saveOrderEdit"
      @cancel="cancelOrderEdit"
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

/*
 * 窄屏：整页内容**垫到 1.2 个屏高**（用户 2026-10-06：「高度固定一下为 120vh」）。
 *
 * 这一页在窄屏是**整页一个滚动条**（`.tabs-body` 的定高已撤，见
 * `ExchangeAccountBoard.vue` 末尾那个 `@media`）—— 内容不足一屏时页面就完全滚不动，
 * 「拉到顶再往下拉」的下拉刷新也没有余量。垫到 120vh 之后：
 * 页面正好 1.2 屏，永远有一点点可滚，切 tab / 换币时高度也不再跳。
 *
 * ⚠️ 用 `min-height` 而不是 `height`：`.live` 是**列向 flex 容器**，
 *    写死 `height` 会让子项按默认的 `flex-shrink: 1` **被压扁**
 *    （挂单 / 成交 / 资产多的时候尤其明显）。`min-height` 只保证「不少于 1.2 屏」，
 *    内容更长时照旧往下长 —— 那时多的部分本来也得滚，不该被裁掉。
 */
@media (max-width: 900px) {
  .live {
    /*
     * 少了垫、多了封 —— 两个一起就是「正好 1.2 屏」。
     * 用户 2026-10-06：「高度固定一下为 120vh」→「设置最大高度 120vh，
     * 我就想在仓位历史或者其他数据过多时不要无限滚动」。
     * 超出 120vh 的那部分不再让整页无限长，交给下面的 `.tabs-body` 内部滚
     * （见 `ExchangeAccountBoard.vue` 末尾那个 `@media`）。
     */
    height: 120vh;
  }
}
</style>
