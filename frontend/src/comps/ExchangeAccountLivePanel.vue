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
import {testOrder} from '../settings'
import {
  closeTradePositions,
  exchangeStream,
  fetchExchangeCurve,
  fetchExchangeFills,
  fetchExchangeKeys,
  fetchExchangeOpenOrders,
  fetchExchangeOverview,
  fetchRate,
  isAuthError,
  refreshExchangeOverview,
  type CurvePoint,
  type ExchangeIncomeRow,
  type ExchangeKey,
  type ExchangeOpenOrder,
  type ExchangeOverview,
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

const fills = ref<ExchangeTrade[]>([])

/** 净资产曲线（M4）：默认看 1 天 */
const curve = ref<CurvePoint[]>([])
const curveRange = ref('1d')
const curveBucketSec = ref(300)
/** 上次取曲线的时间 —— SSE 事件来得勤，靠它节流（别每个快照都拉一遍） */
let curveAt = 0

/* ---------------- 减仓 / 平仓（持仓卡片底部那两颗按钮） ---------------- */

/** 操作结果提示（这一页没有全局 toast，就摆在面板底下，4 秒自己消失） */
const posMsg = ref('')
let posMsgTimer: ReturnType<typeof setTimeout> | null = null
function sayMsg(text: string): void {
  posMsg.value = text
  if (posMsgTimer) clearTimeout(posMsgTimer)
  posMsgTimer = setTimeout(() => {
    posMsg.value = ''
  }, 4000)
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
          ? `✅ 测试减仓通过校验：${baseOf(r.symbol)} ${pct}%（没进撮合）`
          : `✅ 已减仓 ${baseOf(r.symbol)} ${pct}%`
      )
      void doRefresh()
    } else {
      sayMsg(res.error || '减仓失败')
    }
  } catch (e) {
    sayMsg(msg(e))
  } finally {
    posBusy.value = false
  }
}

/** 平仓：整条市价全平（真单） */
async function closeRow(p: PositionRef): Promise<void> {
  if (posBusy.value) return
  const name = baseOf(p.symbol)
  const warn = testOrder.value ? '（当前是测试单，只校验、不会真平）' : '，市价全平，真成交。'
  if (!window.confirm(`平掉 ${name} 这一条持仓？${warn}`)) return
  posBusy.value = true
  try {
    const res = await closeTradePositions(
      {symbol: p.symbol, side: p.side},
      p.keyId,
      testOrder.value
    )
    if (res.ok) {
      sayMsg(res.test ? `✅ 测试平仓通过校验：${name}（没进撮合）` : `✅ 已平仓 ${name}`)
      void doRefresh()
    } else {
      sayMsg(res.error || '平仓失败')
    }
  } catch (e) {
    sayMsg(msg(e))
  } finally {
    posBusy.value = false
  }
}

/** 已实现盈亏 = 账本里带 realized 的那些（一笔成交一条）；多套时跟着成交一起带 key 名 */
const income = computed<ExchangeIncomeRow[]>(() =>
  fills.value
    .filter(f => Number(f.realized ?? 0) !== 0)
    .map(f => ({
      symbol: f.symbol,
      income: Number(f.realized),
      time: f.datetime,
      keyName: f.keyName
    }))
)

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
      next[id] = r.overview
      delete nextReason[id]
    }
    if ((r.ageSec ?? 0) > REFRESH_AFTER_SEC) stale = true
    if (r.err) err.value = `上次采集不完整：${r.err}`
  }
  parts.value = next
  partReasons.value = nextReason
  rebuild()
  if (stale) void doRefresh()
}

/**
 * 去拉一次新的（慢，~2 秒/套）。⚠️ 并发保护：SSE 和自动刷新可能同时想刷。
 * 多套时**串行**刷（并发打交易所容易被限频）。
 */
async function doRefresh(): Promise<void> {
  if (refreshing.value) return
  const list = activeTargets.value
  if (!list.length) return
  refreshing.value = true
  try {
    const next = {...parts.value}
    const nextReason = {...partReasons.value}
    for (const k of list) {
      try {
        const r = await refreshExchangeOverview(k.id)
        if (r.overview) {
          next[k.id] = r.overview
          delete nextReason[k.id]
        } else if (r.reason) {
          nextReason[k.id] = r.reason
          delete next[k.id]
        }
      } catch (e) {
        if (isAuthError(e)) return
        err.value = `刷新失败：${msg(e)}`
      }
    }
    parts.value = next
    partReasons.value = nextReason
    rebuild()
    // 用户主动刷新 = 想看到最新状态，曲线也顺手重拉
    void loadCurve()
  } finally {
    refreshing.value = false
  }
}

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

/** 挂单：几套合起来（多套时每条标出是哪套的），失败原因也带上账户名 */
async function loadOrders(): Promise<void> {
  const list = activeTargets.value
  const many = multi.value
  loadingOrders.value = true
  ordersErr.value = ''
  const out: ExchangeOpenOrder[] = []
  const errs: string[] = []
  for (const k of list) {
    try {
      const r = await fetchExchangeOpenOrders(k.id)
      if (r.error) errs.push(many ? `${k.name}：${r.error}` : r.error)
      for (const o of r.openOrders ?? [])
        out.push(many ? {...o, keyName: k.name} : o)
    } catch (e) {
      if (!isAuthError(e)) errs.push(many ? `${k.name}：${msg(e)}` : msg(e))
    }
  }
  openOrders.value = out
  ordersErr.value = errs.join('；')
  loadingOrders.value = false
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
 * 每个选中的账户一条 SSE（后端本来就按 key_id 分流）。
 * 多套时就是几条并行 —— 数量就是账户数，不会爆。
 */
let stops: (() => void)[] = []

function stopStreams(): void {
  for (const s of stops) s()
  stops = []
}

function startStreams(): void {
  stopStreams()
  const many = multi.value
  for (const k of activeTargets.value) {
    stops.push(
      exchangeStream(k.id, {
        snapshot: r => {
          const next = {...parts.value}
          const nextReason = {...partReasons.value}
          if (r.noSnapshot) {
            nextReason[k.id] = r.reason ?? '这个账户暂时没有数据'
            delete next[k.id]
          } else if (r.overview) {
            next[k.id] = r.overview
            delete nextReason[k.id]
          }
          parts.value = next
          partReasons.value = nextReason
          rebuild()
          // SSE 来得勤：最多每分钟把曲线也重拉一次
          if (Date.now() - curveAt > 60_000) void loadCurve()
        },
        fill: t => {
          // 同一笔可能「实时事件」和「REST 回补」都给到 → 按 tradeId 去重
          if (fills.value.some(f => f.id === t.id)) return
          fills.value = [many ? {...t, keyName: k.name} : t, ...fills.value].slice(
            0,
            FILLS_MAX
          )
        },
        backfill: () => void loadFills(),
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
          rebuild()
        },
        reconnect: () => {
          void loadSnapshots()
          void loadFills()
          void loadCurve()
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

watch(picked, () => {
  /* 换格：把上一格攒下的 parts 清掉（不然「全部」会把没在看的那套也算进来） */
  parts.value = {}
  partReasons.value = {}
  data.value = null
  reason.value = ''
  err.value = ''
  openOrders.value = []
  ordersErr.value = ''
  fills.value = []
  curve.value = []
  void loadSnapshots()
  void loadFills()
  void loadOrders()
  void loadCurve()
  startStreams()
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
   * 默认落在「全部」（用户 2026-10-05 要的就是先看总账）；
   * 只有一套时 `activeTargets` 就是它自己，效果跟以前一样。
   */
  picked.value = keys.value.length > 1 ? 'all' : String(keys.value[0]!.id)
})

onUnmounted(stopStreams)
</script>

<template>
  <div class="live">
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
    <p v-if="posMsg" class="dim tiny">{{ posMsg }}</p>
  </div>
</template>

<style scoped>
.live {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
