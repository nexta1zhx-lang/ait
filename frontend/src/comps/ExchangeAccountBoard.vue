<script setup lang="ts">
/**
 * 「交易所资产」面板 —— **移动端优先**。
 *
 * 范围：
 *   · USDT 合约（USDⓈ-M）`fapi/v2/account` + `fapi/v2/positionRisk`
 *   · C2C 钱包 `sapi/v1/asset/wallet/balance?needBalanceDetail=true`
 *   · 现货 —— **只算 USDT 一个数**（用户：「现货统计也加上，只要 usdt 的统计简单化」）
 *   ⇒ 老版那套「按币种估值的现货余额列表」仍然是删掉的状态：别的币种不折价、不进净值。
 *
 * 排版（手机一屏从上往下）：
 *   ① **净资产** = 合约保证金余额 + C2C + 现货 USDT（一个大数 + 占比条 + 分解行）
 *   ② 合约明细四格：钱包余额 / 未实现盈亏 / 可用 / 占用
 *   ③ **仓位统计**：名义总额、未实现盈亏、多空占比条
 *   ④ 二级 tab：持仓 / 挂单 / 盈亏 / 成交 / 资产明细
 *   ⑤ tab 内容（卡片行）
 *
 * ⚠️ **组件是纯展示的**：数据全走 props（自己不发请求）⇒ 真数据由
 *    `ExchangeAccountLivePanel.vue` 传进来。
 *    （「划转」那颗按钮也只 `emit('transfer')`，弹层和取数都在容器那一层。）
 * ⚠️ 顶部的「几分钟前」是**架构的一部分**：先渲染上一份快照、后台再刷新，
 *    所以界面上必须让用户看到「这份数据有多旧」，而不是空等一个 loading。
 */
import {
  computed,
  defineAsyncComponent,
  onMounted,
  nextTick,
  onUnmounted,
  ref,
  watch
} from 'vue'
import {
  type CurvePoint,
  type ExchangeIncomeRow,
  type ExchangeIncomeTotals,
  type ExchangeOpenOrder,
  type ExchangeOverview,
  type ExchangePositionCycle,
  type ExchangePositionOrder,
  type ExchangeTrade
} from '../api'
import {ago, bjTime, bjTimeSec, fixed, fmt} from '../format'
import {
  exchangeCurrency,
  naturalDirOf,
  posShowValue,
  posSort,
  posSortDir
} from '../settings'
import {orderKind, pairOf, tpSlOf, typeText, type OrderEditTarget, type TpSlTarget} from '../tpsl'
import SegTabs from './SegTabs.vue'
import SettingsSheet from './SettingsSheet.vue'

/**
 * 曲线用 echarts（~580KB），**单独一个 chunk 异步载**：
 * `/analyze` 是主包里的静态路由，直接 import 会让 echarts 进主包，
 * 连只看「合约」页的人都得替它付费。而这块面板本身是 `v-else-if` 挂的，
 * 所以只有真的点开「交易所账户」时才会去下载。
 */
const ExchangeCurveChart = defineAsyncComponent(
  () => import('./ExchangeCurveChart.vue')
)

const props = defineProps<{
  data: ExchangeOverview | null
  /** 挂单是**打交易所按需查**的（慢），单独传（可能还没拉到 / 单独失败） */
  openOrders?: ExchangeOpenOrder[]
  /** 成交/盈亏来自**后端账本**（WS 实时落 + 断线后 REST 补） */
  trades?: ExchangeTrade[]
  /** 钱账本逐笔（已实现 / 手续费 / 资金费 …）—— 持仓卡上那行「已实现盈利」用它 */
  income?: ExchangeIncomeRow[]
  /** **仓位历史**：开仓 → 全平一笔（「盈亏」那一格的主体，用户 2026-10-06 定的） */
  cycles?: ExchangePositionCycle[]
  /** 还没平完的仓位（减仓的已实现盈亏就在这些的详情里） */
  openCycles?: ExchangePositionCycle[]
  /** 账本里最早的成交（这个时间之前的历史不在账本里） */
  cyclesSince?: string | null
  /** 挂单正在拉（慢接口，单独转圈） */
  loadingOrders?: boolean
  /** 正在刷新快照（⟳ 转圈 + 禁点） */
  refreshing?: boolean
  /**
   * 「没有数据」的原因（现货 / 还没采过 / 这些账户都没数据）。
   * ⚠️ 这是**终态文案**，底部唯一还会画字的地方 —— 首屏那次加载已经故意留白了
   *    （见模板末尾那段注释），所以「取不到数据」必须靠它说清楚，别再回车轱辘转圈。
   */
  reason?: string
  /**
   * 顶部那排账户 tab 的选项：`全部` + 每套 Key 的名字（**只有一套时外层就不传 tab**，
   * 退化成原来那个名字标签）。
   * ⚠️ 纯展示：切换只往上 emit，重新取数由外层负责。
   */
  accounts?: {value: string; label: string}[]
  /** 当前选中的那一格（`'all'` 或 key id 的字符串形式） */
  modelValue?: string
  /** 净资产曲线（“快照序列 → 图”，可能还没攒够点） */
  curve?: CurvePoint[]
  /** 当前跨度：1d / 7d / 30d（受控） */
  curveRange?: string
  /** 后端用的桶宽（秒）—— 算「断档」要靠它 */
  curveBucketSec?: number
  /** 美元 → 人民币汇率（USDT / CNY 切换用；拿不到就退回 7.1） */
  rate?: number
  /**
   * **最新成交价**（币安原始交易对 → 价）—— 持仓卡第一格「当前价」。
   *
   * ⚠️ 跟「标记价」是**两个数**：现价是最后一笔成交，标记价是币安防插针那个加权价
   *    （浮盈 / 强平都按标记价算）。行情那条流在容器那层（`last-price.ts`）。
   *    拿不到某个币就是空的 —— 界面显示「—」，**别拿标记价顶上去**冒充现价。
   */
  lastPrice?: Record<string, number>
  /** `incomeTotals`（后端按交易所口径算好的那几项合计）—— 资金动向顶部那一行 */
  incomeTotals?: ExchangeIncomeTotals
  /**
   * 这一本钱账本涵盖几天（后端 `?days=`）—— 资金动向右上角写「近 N 天」，
   * 免得人以为这就是账户的**全部**历史。
   */
  incomeDays?: number
  /** 正在提交「平仓 / 全平」（按钮转圈 + 禁点） */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'update:modelValue', id: number): void
  (e: 'update:curveRange', range: string): void
  /** 点「划转」——弹层由外层（LivePanel）挂，它才知道当前是哪套 Key */
  (e: 'transfer'): void
  /** 点「平仓」（只平一部分）——弹层由外层挂（选百分比 → 调接口） */
  (e: 'reduce', pos: PositionRef): void
  /** 点「全平」（整条平掉）——同样交给外层（它知道是哪套 Key） */
  (e: 'close', pos: PositionRef): void
  /**
   * 点「止盈/止损」——把**这一条持仓 + 它已经挂着的止盈止损**整个交上去，
   * 弹层只管画和填，不再回头推（它拿不到开仓价 / 标记价 / 数量）。
   */
  (e: 'tpsl', target: TpSlTarget): void
  /**
   * 点「一键平仓」——把**当前全部**持仓的标识交上去（外层才知道用哪套 Key、
   * 也才知道现在是不是测试单）。⚠️ 交的是**全部**，不是屏幕上铺出来的那几条：
   * 窄屏一屏只铺 20 条，一键平仓不能漏掉后面那些。
   */
  (e: 'closeAll', rows: PositionRef[]): void
  /**
   * 点**币种标题行** = 去「开单分析」看这个币的 K 线。
   * 交出去的是**币种简写**（`1000BONK`），跟分析页那套全局币种同一个写法。
   */
  (e: 'openChart', base: string): void
  /**
   * 点「挂单」列表里的一行 = 改这张单。
   * 交出去的是**这一张单 + 它对应的仓位 / 标记价**（见 `orderEditOf`）——
   * 外层要拿它去调改单 / 撤单接口（只有外层知道用哪套 Key）。
   */
  (e: 'editOrder', target: OrderEditTarget): void
  /**
   * 换二级 tab（`pos` / `ord` / `inc` / `trades` / `flow`）。
   *
   * 容器收到就**重读那一份**——
   * 挂单 / 仓位历史 / 成交平时只靠 SSE 事件触发重读，切过去时先自己拉一次最新的，
   * 免得「点进去还是几分钟前那份」。三份都是**读库**（毫秒级、零权重）。
   */
  (e: 'tab', tab: string): void
}>()

/** 交给外层的「这是哪一条持仓」——带着 keyId，外层才知道用哪套 Key 去平 */
export interface PositionRef {
  symbol: string
  side: 'long' | 'short'
  keyId?: number
  keyName?: string
}

/** tab 选中的那一格（`'all'` / key id 字符串）：只读 prop，切换往上 emit */
const picked = computed({
  get: () => props.modelValue ?? '',
  set: (v: string) => emit('update:modelValue', v)
})
/** 只有一套 key 时不渲染 tab，退化成原来那个名字标签 */
const showAcctTabs = computed(() => (props.accounts?.length ?? 0) > 1)
const acctLabel = computed(() => props.accounts?.[0]?.label ?? '')

const acct = computed(() => props.data?.account ?? null)
const fx = computed(() => props.data?.futures ?? null)
const c2c = computed(() => props.data?.c2c ?? null)
/** 现货（只 USDT）；老快照 / 没权限时是 null */
const spot = computed(() => props.data?.spot ?? null)
const stats = computed(
  () =>
    props.data?.stats ?? {
      longCount: 0,
      shortCount: 0,
      notional: 0,
      unrealized: 0
    }
)
const positions = computed(() => props.data?.futures?.positions ?? [])

/* ---------------- ① 净资产 = 合约保证金余额 + C2C + 现货 USDT ---------------- */

/** 合约那边的「钱」用的是**保证金余额**（= 钱包 + 浮盈），不是钱包余额 */
const futuresValue = computed(() => fx.value?.margin ?? 0)
const c2cValue = computed(() => c2c.value?.totalUsdt ?? 0)
/** 现货只算 USDT 那一个数（用户 2026-10-05：「只要 usdt 的统计简单化」） */
const spotValue = computed(() => spot.value?.usdt ?? 0)
/* ⚠️ 三项相加的口径必须跟后端 `netOf()` / `listCurve()` 完全一致，不然曲线对不上 */
const netValue = computed(
  () => futuresValue.value + c2cValue.value + spotValue.value
)
function pctOf(v: number): number {
  return netValue.value > 0 ? (v / netValue.value) * 100 : 0
}

/* ---------------- ③ 多空分布 ---------------- */

const longNotional = computed(() =>
  positions.value
    .filter(p => p.side !== 'short')
    .reduce((s, p) => s + p.notional, 0)
)
const shortNotional = computed(() =>
  positions.value
    .filter(p => p.side === 'short')
    .reduce((s, p) => s + p.notional, 0)
)
const lsTotal = computed(() => longNotional.value + shortNotional.value)
/**
 * 币种简写。
 *
 * ⚠️ 这个板子上的 symbol 有**两种写法**，都要认：
 *    · 快照里的持仓是 ccxt 统一写法 `1000LUNC/USDT:USDT`（`fetchPositions` 来的）
 *    · 账本 / 挂单那些是币安原始写法 `1000LUNCUSDT`
 *   原来只 `replace(/USDT$/)`，统一写法就切成了 `1000LUNC/USDT:` —— 界面上真出现了这个。
 */
function baseOf(symbol: string): string {
  const s = String(symbol).toUpperCase()
  const head = s.split('/')[0]
  return head.replace(/USDT$/, '') || s
}

/** 归一成币安原始交易对（跨数据源比对用：`1000LUNC/USDT:USDT` 与 `1000LUNCUSDT` 等价） */
/* `pairOf` 搬去 `../tpsl` 了（弹层那边也要比同一批单），这里直接用它的 */

/** 这个币现在的最新成交价（拿不到给 `null`） */
function lastOf(p: FuturesPosition): number | null {
  const v = props.lastPrice?.[pairOf(p.raw ?? p.symbol)]
  return typeof v === 'number' && v > 0 ? v : null
}

/** 交给外层的持仓标识（带 keyId，外层才知道用哪套 Key） */
function posRef(p: FuturesPosition): PositionRef {
  return {symbol: p.symbol, side: p.side, keyId: p.keyId, keyName: p.keyName}
}

/**
 * 「这一条持仓 + 它的止盈止损」——点「止盈/止损」时整个交给外层。
 *
 * ⚠️ 已有的那几张只能从 `openOrders` 里找（那是**交易所上的条件单**，用户在币安 App
 *    手动挂的也算），见 `tpsl.ts` 的 `tpSlOf`。
 * ⚠️ 交上去的是**全部**张数（不是第一张）：部分平仓会有好几张，弹层要让每一张都能
 *    改价 / 改比例 / 撤（用户 2026-10-06：「由于有部分平仓的多个平价价格和百分比
 *    要显示可点击修改」）。
 */
function tpslOf(p: FuturesPosition): TpSlTarget {
  const hit = tpSlOf(props.openOrders, p)
  return {
    symbol: p.symbol,
    raw: p.raw ?? pairOf(p.symbol),
    side: p.side === 'short' ? 'short' : 'long',
    keyId: p.keyId,
    name: baseOf(p.symbol),
    entry: p.entryPrice,
    mark: p.markPrice,
    amount: p.amount,
    profit: hit.profit,
    stop: hit.stop
  }
}

/**
 * 卡片最底行那两条：**只报价，不写「止盈 / 止损」两个字** —— `0.06924 / 0.05115`。
 * 没挂的那一条才写字：「未止盈」/「未止损」。
 *
 * 用户 2026-10-06：「止盈止损简约 只显示价格，止盈的/止损的，未设置显示未止盈或未止损，
 * **只显示百分比最多的一个价格即可**」，随后又定：「去掉止盈止损文字只显示价格，
 * 类似 `未止盈/0.01`」。
 * ⇒ 两条靠**颜色 + 位置**认（左=止盈绿、右=止损红，`/` 分隔），
 *   同一个方向挂着好几张（部分平仓）时**只报比例最大的那张**，其余张数塞进悬停提示，
 *   不占版面。⚠️ 别再把百分比铺在卡片上（那是弹层里的事）。
 */
function tpSlLine(p: FuturesPosition): {
  kind: 'profit' | 'stop'
  text: string
  none: boolean
  title: string
}[] {
  const hit = tpSlOf(props.openOrders, p)
  return (['profit', 'stop'] as const).map(kind => {
    const list = hit[kind]
    const word = kind === 'profit' ? '止盈' : '止损'
    if (!list.length)
      return {
        kind,
        text: `未${word}`,
        none: true,
        title: `这一条还没挂${word}（左边是止盈、右边是止损） —— 点右边那颗「止盈/止损」去设`
      }
    /* 比例最大的那张 —— 它是这张仓位里最“主要”的一单 */
    const top = list.reduce((a, b) => (b.pct > a.pct ? b : a))
    const others = list.filter(o => o !== top)
    return {
      kind,
      /* ⚠️ 只报价—— 认哪条靠颜色 + 位置 + 悬停 */
      text: fmt(top.price),
      none: false,
      title:
        `${word}触发价 ${fmt(top.price)}（平掉 ${top.pct.toFixed(0)}%，这条里比例最大的一张）` +
        (others.length
          ? ` · 另有 ${others.length} 张：` +
            others.map(o => `${fmt(o.price)} ${o.pct.toFixed(0)}%`).join('、')
          : '') +
        ' —— 点右边那颗「止盈/止损」可以改 / 撤 / 加'
    }
  })
}

/**
 * **这条持仓自己**的净盈亏（`net` = 已实现 + 手续费 + 资金费，从它开仓那一刻算起）。
 *
 * ★ 2026-10-07 用户「核对持仓的已实现盈利数值不对」改的：
 *   以前这里把**这个交易对**账本里的行**全加起来** —— 于是 PUMP 这条刚开的仓位
 *   （它自己只有手续费 −$0.035）显示成 **−$0.40**，因为同一个币**前面已经平掉的三个来回**
 *   （−0.09 / −0.28 / …）也被算进来了。币安 App 在持仓行上给的是**这条持仓**的数。
 *   ⇒ 改成取「还没平完的那个仓位周期」的 `net`：那个周期就是「开仓（0 → 有量）到全平」，
 *     跟这条持仓一一对应，键（币 + 方向 + 哪套 Key）天然对得上，
 *     口径（已实现 + 手续费 + 资金费）跟 `仓位历史` 那一格也是同一个。
 *   ⚠️ 周期拿不到（账本还没覆盖到 / 接口失败）就画「—」——
 *      宁可不说，也别把「别的来回」或者 0 糊上去。
 */
function realizedOf(p: FuturesPosition): number | null {
  const pair = pairOf(p.raw ?? p.symbol)
  for (const c of openCycles.value) {
    if (pairOf(c.symbol) !== pair) continue
    if (c.side !== p.side) continue
    if (p.keyName && c.keyName && c.keyName !== p.keyName) continue
    return c.net
  }
  return null
}

/** 只有一个方向时（比如全是多仓），条子别画成 0% —— 那一段独占整条 */
const longPct = computed(() =>
  lsTotal.value > 0
    ? Math.max((longNotional.value / lsTotal.value) * 100, 2)
    : 0
)

/** 强平价距标记价还有多远（%）：<5% 变黄提醒 */
function liqGap(p: {
  markPrice: number
  liquidationPrice: number | null
}): number | null {
  const liq = p.liquidationPrice
  if (!liq || !p.markPrice) return null
  return Math.abs(((liq - p.markPrice) / p.markPrice) * 100)
}

/**
 * **北京时间当天 12:00**（毫秒时间戳）；要是现在还没到 12 点，就退回**昨天** 12:00。
 *
 * 用户 2026-10-06 的口径：「对比北京时间 12 点，如果今天盈利就绿色否则红色」——
 * 12 点这个锚点就是「今天」的起算点。
 * 曲线里的 `t` 是 UTC ISO，这里按**固定 +8 小时**折算（中国没有夏令时，写死偏移足够，
 * 不必为这一处引时区库）；`getUTC*` 读出来正好是北京时间的读数。
 */
function beijingNoon(now: number): number {
  const day = 86_400_000
  const shifted = now + 8 * 3600_000
  const noon = Math.floor(shifted / day) * day + 12 * 3600_000 - 8 * 3600_000
  return noon > now ? noon - day : noon
}

/**
 * **净资产缩略走势**（`净资产` 那个大数旁边那根小折线）。
 *
 * 用户 2026-10-06：「净资产旁 加缩略走势图」→「缩略图再宽一点，对比北京时间 12 点，
 * 如果今天盈利就绿色否则红色」。
 *
 * ⚠️ 这里**自绘 SVG**、绝不碰 echarts：那个 chunk 有 580KB，而这张图只要一根折线 +
 *    一块淡填充。展开的大图仍然走 `ExchangeCurveChart`（`v-if`，折叠时连 chunk 都不下）。
 * ⚠️ 数据用 `props.curve` —— 容器早就按当前跨度取好了，跟大图**是同一份**；
 *    点数不够（<2）就返回 `null`，那一块直接不画（宁可没有，也别画一条假的直线）。
 */

/**
 * 缩略走势要用的几何 + 涨跌。
 * · `line` / `area`：折线 / 填充的坐标串（viewBox 是 `0 0 100 30`）
 * · `pct`：较下面那个 12:00 的涨跌（%）；曲线还没覆盖到锚点时是 `null`
 * · `at`：实际用的锚点（毫秒），提示语里要写出来
 */
type Spark = {line: string; area: string; pct: number | null; at: number}

const spark = computed<Spark | null>(() => {
  const pts = (props.curve ?? []).filter(c => Number.isFinite(Number(c.close)))
  if (pts.length < 2) return null
  const vals = pts.map(c => Number(c.close))
  const W = 100
  const H = 30
  const pad = 3
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  /* ⚠️ 全程一模一样时 `max - min = 0`，别除以 0 —— 那就画成中间一条直线 */
  const span = max - min || 1
  const xy = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W
    const y = H - pad - ((v - min) / span) * (H - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  /*
   * 锚点之前**最后一条**当基准（曲线是按时桶升序的，过了锚点就直接停）。
   * ⚠️ 一条都没有 ⇒ 这份历史还没覆盖到那个 12:00（账户不满一天），
   *    `pct` 给 `null`，颜色保持主色 —— 宁可不表态，也别拿「开仓以来」冒充「今天」。
   */
  const at = beijingNoon(Date.now())
  let base: number | null = null
  for (const c of pts) {
    const t = Date.parse(c.t)
    if (!Number.isFinite(t) || t > at) break
    base = Number(c.close)
  }
  const line = xy.join(' ')
  const pct =
    base !== null && base > 0 ? ((vals[vals.length - 1]! - base) / base) * 100 : null
  return {line, area: `0,${H} ${line} ${W},${H}`, pct, at}
})

/**
 * 缩略图的颜色：较那个 12:00 **盈利 → 绿**，否则（亏损 / 持平）**红**；
 * 拿不到锚点（`pct === null`）时返回空串，颜色保持主题主色。
 */
const sparkTone = computed<string>(() => {
  const pct = spark.value?.pct
  if (pct === null || pct === undefined) return ''
  return pct > 0 ? 'up' : 'down'
})

/** 缩略图的提示语：把「较哪个 12:00、涨跌多少」写出来 —— 光有颜色没法核对 */
const sparkTitle = computed<string>(() => {
  const s = spark.value
  const tip = curveOpen.value ? '收起走势图' : '净资产走势（点一下展开大图）'
  if (!s || s.pct === null) return tip
  const d = new Date(s.at + 8 * 3600_000)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
  return `较北京 ${stamp} 12:00 ${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}% · ${tip}`
})

/* ---------------- ④ tab ---------------- */

type Tab = 'pos' | 'ord' | 'inc' | 'trades' | 'flow'
const tab = ref<Tab>('pos')
/* 换 tab 告诉容器一声（它按这一格重读对应的那份数据，见 `(e: 'tab')` 的说明） */
watch(tab, t => emit('tab', t))
/**
 * 持仓列表的排序条件（用户 2026-10-07：「持仓……顶部加排序条件」）——
 * 值存在 `settings.ts` 的 `posSort` 里（跟「价值 / 数量」一样是全局显示偏好）。
 */
const POS_SORTS = [
  {value: 'symbol' as const, label: '币种', title: '按币种排（原来的顺序）'},
  {value: 'pnl' as const, label: '盈亏', title: '按未实现盈亏排'},
  {value: 'value' as const, label: '价值', title: '按仓位价值（名义）排'},
  {value: 'liq' as const, label: '距强平', title: '按距强平远近排'}
]
type PosSortValue = (typeof POS_SORTS)[number]['value']

/*
 * 换档位时方向回到这一档的默认（「升 / 降」那颗箭头翻过之后不会跟着跑到别的条件上）。
 */
watch(posSort, v => (posSortDir.value = naturalDirOf(v)))

/**
 * 这一颗按钮上该画哪个方向的箭头（用户 2026-10-07：「升序降序符号显示在每个按钮中，
 * 点击切换」）：
 *   · **当前这一档** → 用户设的方向（亮着）
 *   · 其余档 → 它的**默认方向**（压淡，点进去就是这个方向）
 * 一条 SVG 转 180°（别用 ↑↓ 字符：安卓 WebView 的兜底字体里不保证有字形）。
 */
function dirOf(v: PosSortValue): 'asc' | 'desc' {
  return v === posSort.value ? posSortDir.value : naturalDirOf(v)
}

/** 按钮的悬停说明：点它会发生什么 */
function sortTitle(v: PosSortValue): string {
  const base = POS_SORTS.find(s => s.value === v)?.title ?? ''
  if (v !== posSort.value) return `${base}｜点一下按这一档排`
  return posSortDir.value === 'asc' ? `${base}｜现在：升序 —— 点一下改降序` : `${base}｜现在：降序 —— 点一下改升序`
}

/** 点排序按钮：点别的档 = 换档（方向回这一档的默认）；**点当前这档 = 翻方向** */
function pickSort(v: PosSortValue): void {
  if (v === posSort.value) {
    posSortDir.value = posSortDir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  posSort.value = v
}

/** 净资产走势默认**折叠**；点标题旁边那个小图标展开 */
const curveOpen = ref(false)
/** 「配置」底部弹窗（用户 2026-10-07：「在账户切换的最右侧添加配置，点击底部弹窗」） */
const cfgOpen = ref(false)
function withCount(label: string, n: number): string {
  return n > 0 ? `${label} ${n}` : label
}
const tabs = computed(() => [
  {value: 'pos' as Tab, label: withCount('持仓', positions.value.length)},
  {
    value: 'ord' as Tab,
    label: withCount('挂单', props.openOrders?.length ?? 0)
  },
  {
    value: 'inc' as Tab,
    /* ⚠️ 只数**已平仓**的：这一格现在只列它们（见 `visibleCycles`） */
    label: withCount('仓位历史', props.cycles?.length ?? 0)
  },
  /* 用户 2026-10-06：「成交改名成交历史」 */
  {value: 'trades' as Tab, label: '成交历史'},
  /*
   * 用户 2026-10-06：「资产 tab 去掉换成资金动向，显示所有资金事件怎么变的数据」。
   * ⇒ 原来那一格（合约多资产 / C2C 钱包 / 现货 USDT 的三张余额表）**删掉**：
   *   那几个数在净资产那一段的「币种占比」图例里本来就有，重复占一格不划算。
   *   现在这一格读的是一整本**钱账本**（`/api/exchange/income`）。
   */
  {value: 'flow' as Tab, label: '资金动向'}
])

/**
 * 条件单要看的那个价（触发价）；普通委托才看 `price` —— 返回 `null` 表示这类单没有
 */
function triggerOf(o: ExchangeOpenOrder): number | null {
  const v = Number(o.stopPrice ?? 0)
  return v > 0 ? v : null
}

/** 这张挂单对着的**那条持仓**（「全部」那一格里两套账户可能有同一个币 ⇒ 还要比 Key 名） */
function positionOfOrder(o: ExchangeOpenOrder): FuturesPosition | undefined {
  const pair = pairOf(o.symbol)
  return positions.value.find(x => {
    if (pairOf(x.raw ?? x.symbol) !== pair) return false
    return !(x.keyName && o.keyName && x.keyName !== o.keyName)
  })
}

/**
 * 这张单**要平掉多少张**。
 *
 * ⚠️ 全平型条件单（币安 `closePosition: true`，接口里 `quantity:"0.0"`，我们存进来就是
 *    `amount = 0`）**没有自己的数量** —— 它平的是**整条持仓**。所以按持仓量报：
 *    不然那一格写着「数量 0」，看着像张废单（用户 2026-10-07 在手机挂的「全部止损」就是这种单）。
 */
function orderQty(o: ExchangeOpenOrder): number {
  const amt = Math.abs(Number(o.amount ?? 0))
  if (amt) return amt
  return Math.abs(Number(positionOfOrder(o)?.amount ?? 0))
}

/**
 * 这一张单平掉当前仓位的百分之多少。
 *
 * ⚠️ 口径跟 `tpsl.ts` 的 `tpSlOf`（持仓卡 / 弹层）**必须一致**，不然同一张单两处两个数：
 *    · 数量为 0 = 币安 `closePosition: true` 的**全平型**条件单 ⇒ 100%（不是 0%）；
 *    · 「全部」那一格里两套账户可能有同一个币 ⇒ 还要比 Key 名。
 */
function closePctOf(o: ExchangeOpenOrder): number | null {
  const held = Math.abs(Number(positionOfOrder(o)?.amount ?? 0))
  if (!held) return null
  const amt = Math.abs(Number(o.amount ?? 0))
  return amt ? Math.min(999, (amt / held) * 100) : 100
}

/**
 * 点「挂单」里的一行 → 拼出改单弹层要的那一坨。
 *
 * ⚠️ 弹层需要的东西**只有板子手上同时有**：挂单本身（币安原始符号 / 类型 / 方向 / 现价）
 *    和这条币的**持仓**（算「平仓比例」）以及**标记价**（判「压在现价上」）。
 *    所以跟 `tpslTarget` 一样，点的那一刻整坨交上去，弹层不回头推。
 * ⚠️ `keyId` 拿不到就留空 —— 外层（LivePanel）自己知道当前选的是哪套 Key，
 *    单套账户时挂单里压根没有 `keyName`。
 */
function orderEditOf(o: ExchangeOpenOrder): OrderEditTarget {
  const pair = pairOf(o.symbol)
  const p = positionOfOrder(o)
  const base = baseOf(o.symbol)
  return {
    id: o.id,
    raw: pair,
    keyName: o.keyName,
    name: base,
    type: o.type,
    side: o.side === 'buy' ? 'buy' : 'sell',
    price: Number(o.price ?? 0) || 0,
    stopPrice: Number(o.stopPrice ?? 0) || 0,
    /* ⚠️ 全平型条件单没有自己的数量 ⇒ 按持仓量带进去（弹层开出来就是 100%，见 `orderQty`） */
    amount: orderQty(o) || 0,
    held: Math.abs(Number(p?.amount ?? 0)),
    /* 标记价：持仓上有就用它；没有（比如挂着的是**开仓**单、还没仓位）就退回最新成交价 */
    mark: Number(p?.markPrice ?? 0) || props.lastPrice?.[pair] || 0
  }
}

/**
 * 按交易对分组挂单。
 * ⚠️ 分组的 key 里要带**账户名** —— 「全部」那一格里，同一个币在 A 账户和 B 账户
 *    各挂了一单，只按 symbol 分会把两套的挂单混进一组、数不清是哪家的。
 */
const orderGroups = computed(() => {
  const m = new Map<
    string,
    {symbol: string; keyName?: string; rows: ExchangeOpenOrder[]}
  >()
  for (const o of props.openOrders ?? []) {
    const k = `${o.keyName ?? ''}|${o.symbol}`
    const g = m.get(k)
    if (g) g.rows.push(o)
    else m.set(k, {symbol: o.symbol, keyName: o.keyName, rows: [o]})
  }
  return [...m.values()]
})

/**
 * 仓位历史 —— **开仓到全平算一笔**。
 *
 * ⚠️ 不是「把 income 按类型加起来」的统计。减仓不单独算一笔，
 *    它的已实现盈亏归到整段头上，同时逐笔留在详情里。
 * ⚠️ **未平**的单独一组放前面：减仓就发生在未平那一段里 ——
 *    只列已平的段，用户会找不到「刚才减仓赚了多少」。
 */
const closedCycles = computed(() => props.cycles ?? [])
/** 「还没平完」的那一份（拆出去做别的用；仓位历史**不再显示**它，见 `visibleCycles`） */
const openCycles = computed(() => props.openCycles ?? [])

/* ---------------- 分页：默认 20 条 + 窄屏滚动加载 ---------------- */

/**
 * 每个 tab **默认先铺 20 条**（用户 2026-10-06：「持仓/挂单/历史/成交 4 个 tab
 * 默认加载 20 条数据，移动端滚动加载，PC 端先不管」）。
 *
 * ⚠️ 数据本身还是整份取回来的（成交 60 / 仓位历史 50，见
 *    `ExchangeAccountLivePanel` 里那几个 `*_MAX`）——这里只管**铺多少条**，
 *    滚到底再多铺一批。真要「翻页取数」得后端另开接口，那是另一件事。
 * ⚠️ 宽屏保持原样**全部铺出来**——
 *    那边只是个 460px 的小框，底下垫一句「还有 N 条」反而像数据没到齐。
 */
const PAGE = 20
/** 窄屏断点（跟 CSS 的 ≤900px 对齐） */
const MOBILE_MAX = 900
const isMobile = ref(
  typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX
)
function onViewport(): void {
  isMobile.value = window.innerWidth <= MOBILE_MAX
}
onMounted(() => window.addEventListener('resize', onViewport))
onUnmounted(() => window.removeEventListener('resize', onViewport))

/** 这一格现在铺了多少条 */
const shown = ref(PAGE)
/** 这一格最多铺几条（宽屏不限量） */
const cap = computed(() =>
  isMobile.value ? shown.value : Number.POSITIVE_INFINITY
)

/** 当前 tab 一共多少条 —— 决定还能不能再「加载更多」 */
const tabTotal = computed(() => {
  if (tab.value === 'pos') return positions.value.length
  if (tab.value === 'ord')
    return orderGroups.value.reduce((n, g) => n + g.rows.length, 0)
  if (tab.value === 'inc') return closedCycles.value.length
  if (tab.value === 'trades') return props.trades?.length ?? 0
  if (tab.value === 'flow') return props.income?.length ?? 0
  return 0
})

/*
 * 每个二级 tab 的「滚到哪 + 铺了几条」——用户 2026-10-07：「交易所页面滚动条加缓存」。
 *
 * ⚠️ 两个都要记：`shown` 决定内容有多长，只恢复 `scrollTop` 的话，
 *    换回来时内容只有 20 条、写进去的位置会被**最大滚动距离**夹掉（等于没恢复）。
 */
const scrollMem = new Map<Tab, {top: number; shown: number}>()

/**
 * 把**某一格**的滚动状态记下来（滚动时顺手写：`display:none` 之后就读不到了）。
 *
 * ⚠️ 要传「是哪一格」，别用 `tab.value`：`watch(tab)` 里 `tab.value` 已经是**新**那一格，
 *    拿它存会把旧那格的 `top/shown` 覆盖到新那格头上（症状：切回来位置还是不对）。
 */
function rememberScroll(of: Tab): void {
  const el = bodyEl.value
  if (!el) return
  scrollMem.set(of, {top: el.scrollTop, shown: shown.value})
}

/**
 * 把某一格摆回上次的位置。
 *
 * ⚠️ 顺序要死抠：`shown` 是**异步渲染**的，只在下一帧写 `scrollTop` 会被
 *    「当时那个高度」的**最大滚动距离**夹掉（实测：49 条那格回到 2657 却只落在 37）。
 *    所以 `nextTick`（等 Vue 把节点铺出来）→ 一帧后再写，再留一帧**复核**一次
 *    （布局还没稳就补写，稳了就不再写）。
 */
function restoreScroll(t: Tab): void {
  const mem = scrollMem.get(t)
  if (!mem) return
  shown.value = Math.max(shown.value, mem.shown)
  const top = mem.top
  const write = (): void => {
    const el = bodyEl.value
    if (!el) return
    if (el.scrollTop !== top) el.scrollTop = top
  }
  void nextTick(() => {
    requestAnimationFrame(() => {
      write()
      requestAnimationFrame(() => {
        const el = bodyEl.value
        if (el && el.scrollTop !== top) write()
      })
    })
  })
}

/** 换一格：先把离开那格记住，再铺新那格的条数、摆回它的位置 */
watch(tab, (now, was) => {
  if (was) rememberScroll(was)
  shown.value = scrollMem.get(now)?.shown ?? PAGE
  restoreScroll(now)
})

/**
 * 按当前条件排完的持仓（`visiblePositions` 再在它上面切「先铺 N 条」）。
 * ⚠️ `symbol` 这一档**原样返回**：后端本来就是按币种给的，再排一次只会白花时间。
 * ⚠️ 用 `slice()` 拷一份再排 —— `sort` 是原地改数组，直接在 computed 的源上排会把
 *    `positions` 自己也换掉（那是个 props 派生的 computed，改它等于改上游）。
 */
const sortedPositions = computed(() => {
  const list = positions.value
  const asc = posSortDir.value === 'asc'
  const sign = asc ? 1 : -1
  const by = posSort.value
  /*
   * 币种：**升序就是后端给的原样**（它本来就按币种给的），降序才反过来 ——
   * 这样默认那一档跟以前**逐字一致**，不会因为前端重排一次而换顺序。
   */
  if (by === 'symbol') return asc ? list : [...list].reverse()
  const copy = [...list]
  if (by === 'pnl') return copy.sort((a, b) => (a.unrealizedPnl - b.unrealizedPnl) * sign)
  if (by === 'value')
    return copy.sort((a, b) => ((a.notional ?? 0) - (b.notional ?? 0)) * sign)
  /* 距强平：**没有强平价的永远排最后**（不参与方向），不然翻一下它们就跑到最前面 */
  return copy.sort((a, b) => {
    const ga = liqGap(a)
    const gb = liqGap(b)
    if (ga === null && gb === null) return 0
    if (ga === null) return 1
    if (gb === null) return -1
    return (ga - gb) * sign
  })
})

const visiblePositions = computed(() =>
  cap.value === Number.POSITIVE_INFINITY
    ? sortedPositions.value
    : sortedPositions.value.slice(0, cap.value)
)

/** 「一键平仓」交上去的全部持仓标识（不是屏幕上铺出来的那几条） */
const posRefAll = computed(() => positions.value.map(posRef))

const visibleTrades = computed(() => {
  const list = props.trades ?? []
  return cap.value === Number.POSITIVE_INFINITY
    ? list
    : list.slice(0, cap.value)
})

/** 资金动向：整本钱账本（后端已按时间倒序、跨账户合并好） */
const visibleFlow = computed(() => {
  const list = props.income ?? []
  return cap.value === Number.POSITIVE_INFINITY
    ? list
    : list.slice(0, cap.value)
})

/** 仓位历史：**只列已完全平仓的**（用户 2026-10-06：「只显示已完全平仓的数据」） */
const visibleCycles = computed(() => {
  const c = cap.value
  return {
    closed:
      c === Number.POSITIVE_INFINITY
        ? closedCycles.value
        : closedCycles.value.slice(0, c)
  }
})

/** 挂单是按交易对分组的 —— 按组的顺序一条条数，凑满额度就停 */
const visibleOrderGroups = computed(() => {
  const c = cap.value
  if (c === Number.POSITIVE_INFINITY) return orderGroups.value
  const out: typeof orderGroups.value = []
  let left = c
  for (const g of orderGroups.value) {
    if (left <= 0) break
    const rows = g.rows.slice(0, left)
    left -= rows.length
    out.push({...g, rows})
  }
  return out
})

/** 列表容器（滚动加载挂在它身上） */
const bodyEl = ref<HTMLElement | null>(null)

/**
 * 快滚到底了就再铺一批。
 *
 * ⚠️ 只在窄屏做：宽屏 `cap` 是 `Infinity`，`shown` 加了也不起作用。
 * ⚠️ 留 **40px 余量**：手指滑到「差一点点到底」时就该把下一批接上，
 *    等真滚到底才铺会先空一下再跳出来。
 */
function onBodyScroll(): void {
  const el = bodyEl.value
  if (!el) return
  /* 顺手记一下位置（切 tab / 切走再回来要摆回去，见 `scrollMem`） */
  rememberScroll(tab.value)
  if (!isMobile.value) return
  if (shown.value >= tabTotal.value) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    shown.value += PAGE
  }
}

/**
 * 点开了哪一笔的**详情弹窗**（`null` = 关着）。
 *
 * ⚠️ 2026-10-06 用户：「详情改为底部弹窗」—— 以前是 `.cyc` 里原地展开
 *    （`expanded` 那套 Set + `.cyc-orders`），点一下整张卡长出一截，列表跟着跳；
 *    现在整张卡点开就是底部弹层（读的还是同一份 `orders`）。
 */
const openCycle = ref<ExchangePositionCycle | null>(null)


function cycleKey(c: ExchangePositionCycle): string {
  return `${c.keyName ?? ''}|${c.symbol}|${c.side}|${c.openAt}`
}


/** 持仓时长说人话：`34 秒` / `3 分` / `2 小时 5 分` / `1 天 3 小时` */
function holdText(sec: number): string {
  if (!(sec > 0)) return '—'
  if (sec < 60) return `${Math.round(sec)} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时 ${min % 60} 分`
  return `${Math.floor(hr / 24)} 天 ${hr % 24} 小时`
}

/**
 * 逐笔那一行的动作标签。
 * ⚠️ 一段里的**最后一笔减仓就是「平仓」** —— 算法上仓位归零的那一笔才收尾
 *    （减仓和全平都说成「减仓」会让人以为这段还开着）。
 */
function orderAction(
  c: ExchangePositionCycle,
  o: ExchangePositionOrder,
  i: number
): string {
  /* 第一笔**建仓**的成交就是「开仓」——
     以前一律写「加仓」，看着像是「在已有仓位上又加了一笔」。 */
  if (!o.reduce) return i === 0 ? '开仓' : '加仓'
  if (c.closed && i === c.orders.length - 1) return '平仓'
  return '减仓'
}

/* ---------------- 格式化 ---------------- */

/* ---------------- 货币：USDT / CNY 快捷切换 ---------------- */

/** 当前按哪种货币看（**全局持久化**，见 `settings.ts`） */
const currency = exchangeCurrency
/** 汇率：接口没回来之前先用 7.1（跟后端 `USD_CNY` 的默认值一致） */
const cnyRate = computed(() =>
  props.rate && props.rate > 0 ? props.rate : 7.1
)

function toggleCurrency(): void {
  exchangeCurrency.value = exchangeCurrency.value === 'cny' ? 'usd' : 'cny'
}

/** 金额带千分位（`format.ts` 的 `usd()` 不加逗号，六位数很难读） */
function money(v: number): string {
  if (currency.value === 'cny') {
    return (
      '¥' +
      (v * cnyRate.value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    )
  }
  return (
    '$' +
    v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })
  )
}

/**
 * 总杠杆倍数（用户 2026-10-05：「仓位统计显示总杠杆倍数」）。
 *
 * 口径：**名义总额 ÷ 保证金余额** —— 账户级别的真实杠杆（不是各仓杠杆相加，
 * 那个数没有意义：不同仓位的保证金口径不一样）。保证金余额为 0 时不显示。
 */
const totalLev = computed(() => {
  const m = fx.value?.margin ?? 0
  return m > 0 ? stats.value.notional / m : 0
})
function signedMoney(v: number): string {
  return (v >= 0 ? '+' : '−') + money(Math.abs(v))
}
/** 币的数量：越小的币要越多小数位 */
function qty(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  return fmt(v, a === 0 ? 0 : a < 0.01 ? 8 : a < 1 ? 6 : a < 1000 ? 4 : 2)
}
function tone(v: number): string {
  return v >= 0 ? 'up' : 'down'
}
/**
 * 资金事件的类型名：币安 `incomeType` 的原值 → 中文。
 * ⚠️ 认不出来的**原样返回**（宁可露英文，也别显示成空白）。
 */
const FLOW_TEXT: Record<string, string> = {
  REALIZED_PNL: '已实现盈亏',
  COMMISSION: '手续费',
  FUNDING_FEE: '资金费',
  TRANSFER: '划转',
  INSURANCE_CLEAR: '强平清算',
  AUTO_EXCHANGE: '自动兑换',
  REFERRAL_KICKBACK: '推荐返佣',
  CROSS_COLLATERAL_TRANSFER: '跨币划转',
  INTERNAL_TRANSFER: '内部划转',
  WELCOME_BONUS: '体验金',
  COMMISSION_REBATE: '手续费返佣',
  API3_INCENTIVE: '空投奖励',
  FEE_RETURN: '手续费返还'
}
function flowText(t: string): string {
  const k = String(t ?? '').toUpperCase()
  return FLOW_TEXT[k] ?? k
}

/**
 * 资金事件的金额：跟 `signedMoney`（折算人民币那一套）**不是一回事** ——
 * 这些钱散在各种资产里（USDT / BNB / USDC），只报**原资产的数量**，不换汇。
 */
/**
 * 算式里的数（净盈亏那三项）：负号用**排版减号 `−`**。
 * ⚠️ `fixed()` 出来的是 ASCII 连字符 `-`（`-0.1729`），跟同一行里 `signedQty` 的 `−`
 *    不是一个字符，并排看粗细不一样。
 */
function calcNum(v: number, digits = 4): string {
  return (v < 0 ? '−' : '') + fixed(Math.abs(v), digits)
}

function signedQty(v: number): string {
  const a = Math.abs(v)
  const d = a === 0 ? 0 : a < 0.01 ? 6 : a < 1 ? 4 : 2
  return (v >= 0 ? '+' : '−') + fmt(a, d)
}

function sideText(side: string): string {
  const s = side.toLowerCase()
  if (s === 'buy') return '买'
  if (s === 'sell') return '卖'
  return side
}
/** 持仓方向专用：多 / 空（订单那边才是买/卖，两处别混） */
function posText(side: string): string {
  return side.toLowerCase() === 'short' ? '空' : '多'
}

/* ---------------- ⑥ 净资产曲线（M4） ---------------- */

/**
 * 可选跨度（**英文标签**，值跟后端 `/api/exchange/history` 的 range 对齐）。
 * `all` = 全部历史。
 */
const RANGES = [
  {value: '1d', label: '1D'},
  {value: '7d', label: '7D'},
  {value: '30d', label: '30D'},
  {value: '180d', label: '180D'},
  {value: '1y', label: '1Y'},
  {value: 'all', label: 'ALL'}
]
</script>

<template>
  <div class="exb">
    <!--
      账户切换：**tab 条**（用户 2026-10-05：不要下拉框，要「全部 + 每个 key 名称」）。
      ⚠️ 放在 `v-if="data"` **外面** —— 加载/报错时也能切到别的账户。
      只有一套 key 时 `accounts` 只有一项 ⇒ 不渲染，界面上不留一条没用的 tab。
    -->
    <!--
      「配置」挂在**这一行的最右边**（用户 2026-10-07：「在账户切换的最右侧添加配置，
      点击底部弹窗」）⇒ 单独包一层：tab 条自己横向滚，配置钉在右边不会跟着滚走。
      只有一套 key 时没有 tab 条，这一行就只剩右边那颗配置。
    -->
    <div class="acct-bar">
      <SegTabs
        v-if="showAcctTabs"
        v-model="picked"
        class="acct-tabs"
        :options="accounts!"
      />
      <!--
        「配置」**是颗图标**——
        用跟 K 线页那颗**同一个**滑轨图标（`AnalyzeView` 的 `.tk-cfg`）：
        两处点的是同一个弹层，图标一样才一眼认得是同一件事。
        ⚠️ 图标用**内联 SVG**，别写 `⚙` / `☰` 之类的字符（安卓 WebView 的兜底字体
           里不保证有字形，那颗按钮会变成空白 —— 这一页的刷新图标栽过一次）。
      -->
      <button
        class="ghost tiny cfg"
        title="配置"
        aria-label="配置"
        @click="cfgOpen = true"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8h7M17 8h3M4 16h3M13 16h7" />
          <circle cx="14" cy="8" r="2.6" />
          <circle cx="10" cy="16" r="2.6" />
        </svg>
      </button>
    </div>
    <template v-if="data">
      <!-- ① 净资产 -->
      <section class="panel hero">
        <div class="hero-h">
          <span class="hero-k">净资产</span>
          <!-- 只有一套 key 时没有 tab 条，在这儿当普通标签显示名字 -->
          <span v-if="!showAcctTabs && acctLabel" class="tag">
            {{ acctLabel }}
          </span>
          <span v-else-if="!showAcctTabs" class="tag">合约 + C2C</span>
          <span class="spacer" />
          <!--
            划转（用户 2026-10-05：「在交易所账户，各个里面添加划转功能」）。
            ⚠️ 这是真钱操作（币安没有划转测试接口），弹层里带常驻警示 + 二次确认。
          -->
          <button
            class="ghost tiny tr-open"
            title="万能划转：现货 / 资金(C2C) / USDT 合约 之间搬 USDT（真钱）"
            @click="emit('transfer')"
          >
            划转
          </button>
          <!--
            ⚠️ 2026-10-06 用户要求：「净资产…多少秒实时…刚刚更新这些状态去掉」——
            原来这里有「合约 实时 / 合约 N 秒前」和「刚刚更新 / N 分钟前」两颗时间标签
            （数据来自 `data.liveAt` / `data.takenAt`）。现在整块拿掉，
            净资产那一行只剩数字和它右边那几颗按钮。
            ⚠️ 别再照着「谁实时、谁不是」那套加回来：口径一变（比如又拆时间戳）
               又会变成替所有数字报喜的假标签，用户上一轮就是被它绕进去的。
          -->
          <!--
            USDT / CNY 快捷切换（用户 2026-10-05：「账户添加人民币汇率切换快捷 usdt cny」）——
            点一下整页金额就在 $ 和 ¥ 之间换（汇率跟用量页同源，见 `cnyRate`）。
          -->
          <button
            class="ghost tiny cur"
            :title="
              currency === 'usd'
                ? `按人民币看（1 USD = ${cnyRate} CNY）`
                : '按美元看'
            "
            @click="toggleCurrency"
          >
            {{ currency === 'usd' ? 'USDT' : 'CNY' }}
          </button>
          <!--
            刷新：**内联 SVG**，不是 `⟳` 那个字符 —— 那个字形在 Android WebView
            的兜底字体里没有，App 里是一颗空白按钮（用户 2026-10-05：
            「交易所账户的刷新图标在 app 没有显示」）。
          -->
          <button
            class="ghost tiny rf"
            :class="{busy: refreshing}"
            :disabled="refreshing"
            title="立即刷新"
            aria-label="立即刷新"
            @click="emit('refresh')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6.02" />
              <path d="M20.5 3.5v5.2h-5.2" />
            </svg>
          </button>
        </div>

        <div class="hero-num">
          <div class="hero-v">{{ money(netValue) }}</div>
          <!--
            缩略走势图（用户 2026-10-06：「净资产旁 加缩略走势图」）——
            **点它 = 展开 / 收起下面那张大图**（跟折叠标题同一件事，多一个入口而已）。
            ★ 颜色按「较北京时间 12:00」的涨跌走（用户：「对比北京时间 12 点，如果今天
              盈利就绿色否则红色」）—— 见 `sparkTone` / `beijingNoon`。
          -->
          <button
            v-if="spark"
            type="button"
            class="spark"
            :class="[sparkTone, {open: curveOpen}]"
            :aria-expanded="curveOpen"
            :title="sparkTitle"
            @click="curveOpen = !curveOpen"
          >
            <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
              <polygon class="spark-area" :points="spark.area" />
              <polyline
                class="spark-line"
                :points="spark.line"
                vector-effect="non-scaling-stroke"
              />
            </svg>
          </button>
        </div>

        <!--
          ⑥ **币种占比 + 净资产走势**（合并成一块、可折叠）。
          用户 2026-10-05：「币种占比和资产走势放到一起可折叠」。

          · 标题右侧那串百分比摘要（合约 65% / C2C 35% / 现货 0%）**去掉**；
            · 展开后**仍然保留**「币种占比」的占比条 + 图例（跟标题留出间距）。
          ⚠️ 标题是**「币种占比·资产走势」**，别改成「走势图」—— 2026-10-06 试过一版
             只写「走势图」，用户当场要求改回来（「大的走势图的…还是要的」）。
          ⚠️ 用 `v-if` 而不是 `v-show`：折叠时**根本不下载** echarts 那个 chunk，
          也不存在「容器 0 宽高时 init」那个坑（见 `ExchangeCurveChart.vue` 注释）。
        -->
        <div class="fold">
          <button
            class="fold-h"
            type="button"
            :aria-expanded="curveOpen"
            @click="curveOpen = !curveOpen"
          >
            <span class="fold-t">币种占比·资产走势</span>
            <span class="spacer" />
            <svg
              class="chev"
              :class="{open: curveOpen}"
              viewBox="0 0 16 16"
              width="15"
              height="15"
              aria-hidden="true"
            >
              <path
                d="M5 6.5l3 3 3-3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <template v-if="curveOpen">
            <!-- 占比条 + 图例（原来在折叠区外面一直露着，现在跟走势收在一起） -->
            <div class="split-bar">
              <i class="fx" :style="{width: pctOf(futuresValue) + '%'}" />
              <i class="c2c" :style="{width: pctOf(c2cValue) + '%'}" />
              <i class="sp" :style="{width: pctOf(spotValue) + '%'}" />
            </div>
            <ul class="split-lg">
              <li>
                <i class="fx" />
                <span class="lb">USDT 合约</span>
                <b>{{ money(futuresValue) }}</b>
                <span class="pc">{{ pctOf(futuresValue).toFixed(1) }}%</span>
              </li>
              <li v-if="c2c">
                <i class="c2c" />
                <span class="lb">C2C 钱包</span>
                <b>{{ money(c2cValue) }}</b>
                <span class="pc">{{ pctOf(c2cValue).toFixed(1) }}%</span>
              </li>
              <li v-if="spot">
                <i class="sp" />
                <span class="lb">现货（USDT）</span>
                <b>{{ money(spotValue) }}</b>
                <span class="pc">{{ pctOf(spotValue).toFixed(1) }}%</span>
              </li>
            </ul>

            <ExchangeCurveChart
              :points="curve ?? []"
              :bucket-sec="curveBucketSec ?? 300"
            />
            <!--
              跨度切换在**底部**，纯文字、不给 tab 底色。
              ⚠️ 类名别叫 `.chip` —— 全局有 `.chip`（标签筛选那种胶囊，`.chip.on` 还带
              `--blue-soft` 底色），撞上了会把这里又变成带底色的胶囊。
            -->
            <div class="rngs">
              <button
                v-for="r in RANGES"
                :key="r.value"
                class="rng"
                :class="{on: (curveRange ?? '1d') === r.value}"
                @click="emit('update:curveRange', r.value)"
              >
                {{ r.label }}
              </button>
            </div>
          </template>
        </div>

        <p v-if="data.account.sandbox" class="hint">模拟盘（sandbox）</p>
      </section>

      <!--
        ③ **合约 · 仓位**（用户 2026-10-05：「仓位统计和资产走势下面的钱包信息合并，
        上面显示可用占用未实现，下面显示仓位总额多头空头」）。

        原来这里是两块：上面hero卡里「钱包余额/未实现/可用/占用」四格，
        下面「仓位统计」又重复了一遍「名义总额/未实现/多头/空头」。
        现在并成一块，两排三格，**未实现盈亏只出现一次**：
          上排 = 账户的钱（可用 / 占用 / 未实现）
          下排 = 仓位的事（仓位总额 / 多头 / 空头）
        ⚠️ 钱包余额那一格去掉了 —— 它在上面「币种占比」的图例里就是「USDT 合约」那一行。
      -->
      <section class="panel">
        <div class="pn-h">
          <h2>合约 · 仓位</h2>
          <!-- 总杠杆（用户 2026-10-05：「仓位统计显示总杠杆倍数」） -->
          <span
            v-if="totalLev > 0"
            class="lev-chip"
            :title="`总杠杆 = 名义总额 ÷ 保证金余额（${money(stats.notional)} ÷ ${money(fx?.margin ?? 0)}）`"
          >
            {{ totalLev.toFixed(2) }}x
          </span>
          <span class="dim tiny">
            {{ stats.longCount + stats.shortCount }} 个持仓 · 多
            {{ stats.longCount }} / 空 {{ stats.shortCount }}
          </span>
        </div>
        <div class="grid3">
          <div>
            <span class="k">可用余额</span
            ><b>{{ money(fx?.available ?? 0) }}</b>
          </div>
          <div>
            <span class="k">占用保证金</span><b>{{ money(fx?.used ?? 0) }}</b>
          </div>
          <div>
            <span class="k">未实现盈亏</span>
            <b :class="tone(fx?.unrealized ?? 0)">{{
              signedMoney(fx?.unrealized ?? 0)
            }}</b>
          </div>
        </div>
        <div class="grid3">
          <div>
            <span class="k">仓位总额</span><b>{{ money(stats.notional) }}</b>
          </div>
          <div>
            <span class="k">多头</span
            ><b class="up">{{ money(longNotional) }}</b>
          </div>
          <div>
            <span class="k">空头</span
            ><b class="down">{{ money(shortNotional) }}</b>
          </div>
        </div>
        <div v-if="lsTotal > 0" class="ls-bar">
          <i class="l" :style="{width: longPct + '%'}" />
          <i class="s" :style="{width: 100 - longPct + '%'}" />
        </div>
      </section>

      <!-- ④ tab -->
      <!--
        ⚠️ 外面这层**横向可滚**（滚条不画）：改名 + 加一格之后 5 个标签在 390px 上
           正好卡满（持仓 2 / 挂单 4 / 仓位历史 10 / 成交历史 / 资金动向），
           再窄一点的机型会把尾巴切掉。
      -->
      <div class="seg-scroll">
        <SegTabs v-model="tab" :options="tabs" />
      </div>

      <!--
        tab 内容区。
        ⚠️ 宽屏：**定高 + 内部自己滚**（46vh / 460px 封顶，用户 2026-10-05：
           「底部的几个 tab 内容价格高度，不要让外屏无限滚动」）。
        整页定在 1.2 屏，这一格**吃掉剩下的高度**并在里面滚
           （用户：「设置最大高度 120vh，我就想在仓位历史或者其他数据过多时
           不要无限滚动」）—— 见 `<style>` 末尾那个 `@media`。
      -->
      <div ref="bodyEl" class="tabs-body" @scroll.passive="onBodyScroll">
        <!-- 持仓 -->
        <section v-show="tab === 'pos'" class="panel">
          <!--
            顶栏（用户 2026-10-07：「持仓……顶部加排序条件 右侧加一键平仓 需二次弹窗确认」）——
            左边排序条件（自己排的四颗按钮，值存 `posSort`），右边「一键平仓」。
            ⚠️ 升 / 降箭头**长在每一颗按钮里**（用户 2026-10-07：「升序降序符号显示在每个
               按钮中点击切换」）：当前那一档亮着，其余档压淡、显示各自默认方向。
               不用 `SegTabs` 就是因为它不带「按钮里的图标 + 点当前档翻方向」这两件事。
            ⚠️ 「一键平仓」是**真钱**动作（除非「配置 → 测试下单」开着）：点了只是
               `emit('closeAll')`，**二次确认弹窗在外层**（那里才知道 Key 和测试单状态），
               别在这块板子上直接提交任何东西。
          -->
          <div v-if="positions.length" class="pos-h">
            <div class="seg pos-sort">
               <button
                 v-for="s in POS_SORTS"
                 :key="s.value"
                 type="button"
                 :class="{active: posSort === s.value}"
                 :title="sortTitle(s.value)"
                 @click="pickSort(s.value)"
               >
                 {{ s.label }}
                 <svg viewBox="0 0 12 12" :class="{up: dirOf(s.value) === 'asc'}">
                   <path d="M6 2.2v7.4M3.1 6.6 6 9.5l2.9-2.9" />
                 </svg>
               </button>
            </div>
            <span class="spacer" />
            <button
               class="ghost tiny close-all"
               :disabled="busy"
               title="把当前全部持仓按市价全平掉（会先弹一次确认）"
               @click="emit('closeAll', posRefAll)"
            >
               一键平仓
            </button>
          </div>
          <ul v-if="visiblePositions.length" class="poss">
            <!--
            一条持仓的版式（用户 2026-10-05 起逐条提，别把 USDT
                也念一遍）/ 方向 / 杠杆 / 来源标签；右边是**未实现盈亏**（最要紧的数）
              · **第二行四格**（一行，格内标签在上、数值在下）：
                开仓价 / 当前价 / 价值⇄数量 / 距强平
              · **第三行**：止盈 / 止损（**只报一个价，简写着**；没挂的写「未止盈」
                「未止损」）+ 右边「已实现盈利」
              · **第四行**：三颗按钮**平铺**整行
            -->
            <!--
              ⚠️ 2026-10-07 这一版把三样东西挪了位：
                「数量和价值放一块可切换显示 一行显示……已结放到和未止盈那一行右侧
                 改叫已实现盈利……按钮放最底下平铺」
              ⇒ 六格（3×2）压成**四格一行**（省掉一整行），「价值 / 数量」合成一格
                （价值 = 数量 × 当前价，同一件事的两种说法），显示哪个由**配置**里那个
                开关定（见 `settings.ts` 的 `posShowValue`）；
              ⇒ 「已结」从格子里出来，改名「已实现盈利」，落到**止盈/止损那一行的右边**；
              ⇒ 三颗按钮不再挤在止盈止损右边，单独一行等分铺开（`flex: 1 1 0`）。
            -->
            <li
              v-for="p in visiblePositions"
              :key="(p.keyName ?? '') + p.symbol + p.side"
            >
              <!--
              标题行整块可点 = 去「开单分析」看这个币的 K 线（用户 2026-10-06：
              「点击币种标题行区域切换到该币种的k线」）。
              ⚠️ `role="button"` + 键盘事件是因为它是个 `div`：鼠标点得到，
                 键盘（Tab + 回车）也得点得到。
            -->
              <div
                class="p-h"
                role="button"
                tabindex="0"
                :title="`看 ${baseOf(p.symbol)} 的 K 线（去「开单分析」）`"
                @click="emit('openChart', baseOf(p.symbol))"
                @keydown.enter.prevent="emit('openChart', baseOf(p.symbol))"
                @keydown.space.prevent="emit('openChart', baseOf(p.symbol))"
              >
                <span class="sym">{{ baseOf(p.symbol) }}</span>
                <span class="side" :class="p.side === 'short' ? 'sell' : 'buy'">
                  {{ posText(p.side) }}
                </span>
                <span class="lev">{{ p.leverage }}x</span>
                <!-- 「全部」那一格里同一币可能出现在两套账户 ⇒ 标出来源 -->
                <span v-if="p.keyName" class="ktag">{{ p.keyName }}</span>
                <span class="spacer" />
                <span class="pnl-wrap">
                  <span class="pnl" :class="tone(p.unrealizedPnl)">
                    {{ signedMoney(p.unrealizedPnl) }}
                    <em v-if="p.percentage !== null">
                      {{ p.percentage >= 0 ? '+' : '−'
                      }}{{ fixed(Math.abs(p.percentage), 2) }}%
                    </em>
                  </span>
                </span>
              </div>
              <!--
                四格 × 1 行，**格内标签在上、数值在下**（用户 2026-10-07：
                「简约化 竖着布局」→ 一行显示是 4 个 开仓价 当前价 价值可切换显示为数量 距强平）。
                ⚠️ 「标记价」这一格早撤了（跟「当前价」就差 0.02%），它的口径
                   （强平 / 浮盈按标记价算）留在「距强平」的悬停里。
                ⚠️ 格数要正好铺满一行：3 列时代是 3×2，现在 4 列 × 1 行 ⇒ 一格都不能多。
              -->
              <div class="kv">
                <div>
                  <span class="k">开仓价</span><b>{{ fmt(p.entryPrice) }}</b>
                </div>
                <div>
                  <span class="k">当前价</span
                  ><b>{{ lastOf(p) === null ? '—' : fmt(lastOf(p)!) }}</b>
                </div>
                <!--
                  「价值 / 数量」同一格：价值 = 数量 × 当前价，是同一件事的两种说法
                  。显示哪个由**配置**里那个开关定（`posShowValue`），
                  不在这儿点 —— 五条持仓各点一次没法横着比，见 `settings.ts` 那段说明。
                -->
                <div>
                  <span class="k">{{ posShowValue ? '价值' : '数量' }}</span>
                  <b>{{ posShowValue ? money(p.notional) : qty(p.amount) }}</b>
                </div>
                <!--
                ⚠️ 这一格是**距强平**（百分比），不是强平价本身（用户 2026-10-06：
                「强平价格换成距强平」）—— 强平价挪到 `title` 里，悬停能看。
                没有强平价（全仓 / 空仓时币安给 0）就画「—」，四格才是齐的。
              -->
                <div>
                  <span class="k">距强平</span>
                  <b
                    v-if="liqGap(p) !== null"
                    :class="{warn: liqGap(p)! < 5}"
                    :title="
                      `强平价 ${fmt(p.liquidationPrice!)}：标记价再走 ` +
                      `${liqGap(p)!.toFixed(1)}% 就到（强平按标记价算，不是当前价）`
                    "
                    >{{ liqGap(p)!.toFixed(1) }}%</b
                  >
                  <b
                    v-else
                    class="dim"
                    title="币安这一条没给强平价（全仓且账户风险很低时是 0）"
                    >—</b
                  >
                </div>
              </div>
              <div class="p-f">
                <!--
                止盈 / 止损：**简写**，只报一个价（用户 2026-10-06：「止盈止损简约
                只显示价格……只显示百分比最多的一个价格即可」）—— 多张时挑**比例最大**
                的那张，其余张数放在悬停里，不占版面。
              -->
                <span class="ts-mini-wrap">
                  <template v-for="(s, i) in tpSlLine(p)" :key="s.kind">
                    <i v-if="i" class="ts-sep">/</i>
                    <span
                      class="ts-mini"
                      :class="[s.kind, {none: s.none}]"
                      :title="s.title"
                      >{{ s.text }}</span
                    >
                  </template>
                </span>
                <span class="spacer" />
                <!--
                  「已实现盈利」—— 它就是这一行的
                  右半边。币安没给这条数据时留个「—」（别藏起来，不然人不知道是
                  「没有」还是「没读到」）。
                -->
                <span class="real-wrap">
                  <span class="real-k">已实现盈利</span>
                  <b
                    v-if="realizedOf(p) !== null"
                    :class="tone(realizedOf(p) ?? 0)"
                    title="这条持仓开盘至今的净盈亏（已实现 + 手续费 + 资金费，不含划转）"
                    >{{ signedMoney(realizedOf(p) ?? 0) }}</b
                  >
                  <b v-else class="dim" title="这条持仓的开仓记录还没进账本">—</b>
                </span>
              </div>
              <!--
                三颗按钮**单独一行、等分平铺**（用户 2026-10-07：「按钮放最底下平铺」）——
                以前它们挤在止盈止损右边，三颗小按钮加起来才 150px 左右，手指点不中。
                ⚠️ 2026-10-07 用户把两颗平仓按钮改名了：原来的「减仓」（只平一部分）→
                  **平仓**，原来的「平仓」（整条平掉）→ **全平**。只改**显示的字**，
                  `emit` 的名字（`reduce` / `close`）没动 —— 外层按它们接的手。
              -->
              <div class="p-btns">
                <button
                  type="button"
                  class="ghost tiny p-btn"
                  :disabled="busy"
                  title="看 / 设这一条的止盈止损（已挂的直接改价或撤掉）"
                  @click="emit('tpsl', tpslOf(p))"
                >
                  止盈/止损
                </button>
                <button
                  type="button"
                  class="ghost tiny p-btn"
                  :disabled="busy"
                  title="平仓（只平掉一部分）"
                  @click="emit('reduce', posRef(p))"
                >
                  平仓
                </button>
                <button
                  type="button"
                  class="ghost tiny p-btn"
                  :disabled="busy"
                  title="全平：这一条持仓整个平掉（市价）"
                  @click="emit('close', posRef(p))"
                >
                  全平
                </button>
              </div>
            </li>
          </ul>
          <p v-else class="dim">当前无持仓</p>
        </section>

        <!-- 挂单 -->
        <section v-show="tab === 'ord'" class="panel">
          <div v-if="loadingOrders" class="dim load">
            <span class="spin" />正在查询挂单…
          </div>
          <div v-else-if="visibleOrderGroups.length" class="grps">
            <div
              v-for="g in visibleOrderGroups"
              :key="(g.keyName ?? '') + g.symbol"
              class="grp"
            >
              <div class="grp-h">
                <span class="sym">{{ baseOf(g.symbol) }}</span>
                <span class="dim tiny">/USDT</span>
                <span v-if="g.keyName" class="ktag">{{ g.keyName }}</span>
                <span class="spacer" />
                <span class="dim tiny">{{ g.rows.length }} 单</span>
              </div>
              <ul class="rows">
                <li
                  v-for="o in g.rows"
                  :key="o.id"
                  role="button"
                  tabindex="0"
                  :title="`点一下改这张单（${typeText(o.type)}）`"
                  @click="emit('editOrder', orderEditOf(o))"
                  @keydown.enter.prevent="emit('editOrder', orderEditOf(o))"
                  @keydown.space.prevent="emit('editOrder', orderEditOf(o))"
                >
                  <div class="o-t">
                    <span class="side" :class="o.side === 'buy' ? 'buy' : 'sell'">
                      {{ sideText(o.side) }}
                    </span>
                    <span class="o-ty" :class="orderKind(o)">{{ typeText(o.type) }}</span>
                    <!-- 这张单平掉仓位的百分之多少（条件单最关键的一个数） -->
                    <span v-if="closePctOf(o) !== null" class="o-pc">
                      平 {{ fmt(closePctOf(o), 0) }}%
                    </span>
                    <span class="spacer" />
                    <span class="o-qty">数量 <b>{{ qty(orderQty(o)) }}</b></span>
                    <!-- 点得动的提示 -->
                    <span class="o-go" aria-hidden="true">›</span>
                  </div>
                  <div class="o-kv">
                    <!--
                      ⚠️ 条件单看**触发价**、普通委托看**委托价** —— 两列别混。
                      条件单没有 `price`，以前那一格就是一个「—」，等于什么都没说。
                    -->
                    <span v-if="triggerOf(o) !== null">
                      触发价 <b>{{ fmt(triggerOf(o)) }}</b>
                    </span>
                    <span v-else-if="o.price">委托价 <b>{{ fmt(o.price) }}</b></span>
                    <span v-else>市价，无委托价</span>
                    <span v-if="o.filled > 0">已成交 <b>{{ qty(o.filled) }}</b></span>
                    <span class="spacer" />
                    <span class="dim">{{ ago(o.time) }}</span>
                  </div>
                </li>
              </ul>
            </div>
          </div>
          <p v-else class="dim">当前没有挂单</p>
        </section>

        <!--
        仓位历史：
        **开仓 → 全平算一笔**，「盈利」是这一整段赚的；减仓不单独算一笔，
        但点开详情能逐笔看到每次减仓锁了多少。
      -->
        <section v-show="tab === 'inc'" class="panel">
          <div class="pn-h">
            <h2>仓位历史</h2>
            <span class="spacer" />
            <span
              v-if="cyclesSince"
              class="dim tiny"
              title="账本只有币安给的那段成交（约 7 天），更早的历史不在里面"
            >
              账本自 {{ bjTime(cyclesSince).slice(5, 16) }} 起
            </span>
            <span class="dim tiny">{{ closedCycles.length }} 笔已平</span>
          </div>

          <!--
            「仓位历史 1.只显示已完全平仓的数据 2.样式布局优化
              3.详情改为底部弹窗」⇒
            · 上面那段「持仓中（未平仓）」**整块删掉** —— 未平完的不算历史，
              且它的数（已平多少 / 还开着多少）在「持仓」那一格才是主场。
            · 卡片重排：标题行（币种 / 方向 / 标签 + 净盈亏）、3×2 事实网格、
              脚注一行（手续费 / 已实现 / N 笔明细 ›）。
            · 逐笔明细不再**原地展开**（`expanded` / `cyc-orders` 那套没了）⇒
              点整张卡 = 底部弹窗（`CycleSheet`，本组件 Teleport 出去的只读弹层）。
          -->
          <ul v-if="visibleCycles.closed.length" class="cycles">
            <li
              v-for="c in visibleCycles.closed"
              :key="cycleKey(c)"
              class="cyc"
              role="button"
              tabindex="0"
              :title="`看这一笔的 ${c.orders.length} 次成交明细`"
              @click="openCycle = c"
              @keydown.enter.prevent="openCycle = c"
              @keydown.space.prevent="openCycle = c"
            >
              <div class="cyc-h">
                <span class="sym">{{ baseOf(c.symbol) }}</span>
                <span class="dim tiny">/USDT</span>
                <span
                  class="side"
                  :class="c.side === 'short' ? 'sell' : 'buy'"
                >
                  {{ c.side === 'short' ? '空' : '多' }}
                </span>
                <span v-if="c.keyName" class="ktag">{{ c.keyName }}</span>
                <span
                  v-if="c.partial"
                  class="ktag warn"
                  title="账本里没有这一段的开仓记录（币安只给最近 7 天）"
                >
                  不完整
                </span>
                <span class="spacer" />
                <span class="pnl cyc-net" :class="tone(c.net)">{{
                  signedMoney(c.net)
                }}</span>
              </div>
              <!-- 事实网格：3 列 × 2 行（标签在上、值在下）——比原来 8 个「标签+值」挤成一排好认 -->
              <div class="cyc-grid">
                <span>
                  <i>开仓均价</i>
                  <b>{{ c.entryPrice === null ? '—' : fmt(c.entryPrice) }}</b>
                </span>
                <span>
                  <i>平仓均价</i>
                  <b>{{ c.exitPrice === null ? '—' : fmt(c.exitPrice) }}</b>
                </span>
                <!--
                  这一格以前是**持仓时长**；用户 2026-10-06：「持仓是持仓价值，持仓（时间）
                  放在最底下」⇒ 这里换成**持仓价值**（开仓名义价值 = 数量 × 开仓均价），
                  时长挪到下面的脚注。
                  ⚠️ 用 `money()`：跟「持仓」那一格的「价值」同一个口径（CNY 开关一起换算）。
                -->
                <span>
                  <i>持仓价值</i>
                  <b>{{
                    c.entryPrice === null ? '—' : money(c.qty * c.entryPrice)
                  }}</b>
                </span>
                <span>
                  <i>开仓时间</i>
                  <b>{{ bjTime(c.openAt).slice(5, 16) }}</b>
                </span>
                <span>
                  <i>平仓时间</i>
                  <b>{{ c.closeAt ? bjTime(c.closeAt).slice(5, 16) : '—' }}</b>
                </span>
                <span>
                  <i>数量</i>
                  <b>{{ qty(c.qty) }}</b>
                </span>
              </div>
              <!--
                脚注只剩两样（用户 2026-10-06：「持仓改为持仓时间放在最底下，
                手续费 / 资金费在明细中有就行」）：
                左边**持仓时间**（从上面那格挪下来的）、右边「N 笔明细 ›」。
                手续费 / 资金费点开明细看 —— 那两个数要带单位、还要摆得下，
                挤在脚注里只会把这一行撑长。
              -->
              <div class="cyc-foot">
                <span>持仓时间 {{ holdText(c.holdSec) }}</span>
                <span class="spacer" />
                <span class="cyc-more">{{ c.orders.length }} 笔明细 ›</span>
              </div>
            </li>
          </ul>
          <p v-else-if="!closedCycles.length" class="dim">
            账本里还没有完整的仓位（开一笔、平掉之后这里会出现）
          </p>

          <!-- 逐笔明细（读的是一整份 `orders`，点哪张卡就是哪一张） -->
          <Teleport to="body">
            <div
              v-if="openCycle"
              class="sheet-mask"
              @click="openCycle = null"
            />
            <section
              v-if="openCycle"
              class="sheet sheet-confirm cyc-sheet"
              role="dialog"
              aria-label="仓位明细"
            >
              <header class="sheet-head">
                <b>
                  {{ baseOf(openCycle.symbol) }} {{ openCycle.side === 'short' ? '空' : '多' }}
                  · 明细
                </b>
                <button
                  type="button"
                  class="sheet-x"
                  title="关闭"
                  @click="openCycle = null"
                >
                  ✕
                </button>
              </header>
              <ul class="cyc-orders">
                <li v-for="(o, i) in openCycle.orders" :key="o.id">
                  <!--
                    每一笔**只报这张单本身**（用户 2026-10-06：「明细样式再改，只显示订单，
                    时间写全放右侧，重新布局」）：方向 / 动作 + **右侧写全的时间**
                    （`10-06 11:48:47`，以前只写 `11:48:47` 还挤在左边）。
                    价值 / 手续费不再逐笔报 —— 那是「钱」的账，上面那行公式已经汇总了。
                  -->
                  <!--
                    两行的摆法（用户 2026-10-06 连着调了三轮，**这是定稿**）：
                      ① `时间` 后面紧跟 `买/卖` …… 最右是**这一笔的实现盈亏 + 行为**
                         （「买卖标签放在时间后」「行为放在最右侧」「实现盈利放在行为左侧」）
                      ② 「价格数量放在时间下」**换行**从左边起 …… 最右是价值
                    ⚠️ 别再调了。
                  -->
                  <div class="ord-1">
                    <span class="dim tiny ord-time">{{ bjTimeSec(o.time) }}</span>
                    <span class="side" :class="o.side === 'buy' ? 'buy' : 'sell'">
                      {{ o.side === 'buy' ? '买' : '卖' }}
                    </span>
                    <span class="spacer" />
                    <span
                      v-if="o.realized !== 0"
                      class="pnl ord-pnl"
                      :class="tone(o.realized)"
                    >
                      {{ signedMoney(o.realized) }}
                    </span>
                    <span class="ord-act">{{ orderAction(openCycle, o, i) }}</span>
                  </div>
                  <!--
                    第二行：价 / 量（各自带名字，不用乘号）＋ 右边**这一笔的仓位价值**
                    （用户 2026-10-06：「订单时间下面加上仓位价值」——时间在上一行右侧，
                    价值就跟在它下面，一竖列看下来是齐的）；最后是这一笔的实现盈亏。
                  -->
                  <div class="ord-2 dim tiny">
                    <span>价格 <b class="num ord-px">{{ fmt(o.price) }}</b></span>
                    <span>数量 <b class="num">{{ qty(o.amount) }}</b></span>
                    <span class="spacer" />
                    <!-- 价值永远在最后 ⇒ 它的右边缘 = 上一行「行为」那条竖线，每笔都齐 -->
                    <span class="ord-val">
                      价值 <b class="num">{{ fmt(o.price * o.amount, 2) }} USDT</b>
                    </span>
                  </div>
                </li>
              </ul>
            </section>
          </Teleport>
        </section>

        <!-- 成交（后端账本：WS 实时落 + 断线后 REST 补） -->
        <section v-show="tab === 'trades'" class="panel">
          <div class="pn-h">
            <h2>成交历史</h2>
            <span class="spacer" />
            <span class="dim tiny">实时记账本</span>
          </div>
          <!--
            一行两段。第二行的版式用户 2026-10-07 又定了一次（见 `.t-cols`）：
              ① 买卖方向 + 币种 + 账号标签（「测试」这种）………………… **成交金额**
                 （整块靠右、等宽数字，`价值` 贴着数字）
              ② **两行两列**：价格 / 数量 / 手续费 / 时间，每格**标签在左、数值在右**
                 （见 `.t-cols`）
            ⚠️ 改前第一行右边只有「价」、第二行左边挤三样、最右边再挂账号标签和
               时间 —— 一屏几十条里有三个对齐点，扫起来眼睛要来回跳。
          -->
          <ul v-if="visibleTrades.length" class="rows trades">
            <li v-for="t in visibleTrades" :key="`${t.keyName ?? ''}-${t.id}`">
              <div class="t-line">
                <span class="side" :class="t.side === 'buy' ? 'buy' : 'sell'">
                  {{ sideText(t.side) }}
                </span>
                <span class="sym">{{ baseOf(t.symbol) }}</span>
                <span class="dim tiny">/USDT</span>
                <!--
                  ⚠️ 「测试」这种账号标签**跟着币种走**（用户 2026-10-07：
                  「测试的账户标签放在币种后」）—— 原来挂在第二行最右边，
                  跟币种隔着大半行，扫的时候连不起来是哪套 key 的成交。
                -->
                <span v-if="t.keyName" class="ktag">{{ t.keyName }}</span>
                <span class="spacer" />
                <!--
                  右边这个数**自己报名字**，
                  而且 `价值` 两个字要**贴着数字**（用户紧接着补：「价值两个字不要
                  固定位置，靠右加间距」）—— 原来数字是 104px 定宽右对齐，`价值`
                  被钉在那一列的左边缘，金额一短（`0.77895`）俩之间就空出一大块。
                  现在整块靠右、标签紧贴数字，**数字的右边缘还是齐的**。
                -->
                <span class="t-amt num">
                  <em>价值</em>{{ fmt(t.cost) }}
                  <i>USDT</i>
                </span>
              </div>
              <div class="t-cols dim">
                <span class="t-pair">
                  <em>价格</em>
                  <span class="num">{{ fmt(t.price) }}</span>
                </span>
                <span class="t-pair">
                  <em>数量</em>
                  <span class="num">{{ qty(t.amount) }}</span>
                </span>
                <span class="t-pair">
                  <em>手续费</em>
                  <span class="num">{{
                    t.fee ? `${fmt(t.fee, 4)} ${t.feeCurrency ?? ''}` : '—'
                  }}</span>
                </span>
                <span class="t-pair">
                  <em>时间</em>
                  <span class="num">{{
                    t.datetime ? bjTimeSec(t.datetime) : ''
                  }}</span>
                </span>
              </div>
            </li>
          </ul>
          <p v-else class="dim">还没有成交记录（下单成交后会自动记进来）</p>
        </section>

        <!--
          资金动向（用户 2026-10-06：「资产 tab 去掉换成资金动向，显示**所有资金事件**
          怎么变的数据」）。
          ⇒ 原来那三张余额表（合约多资产 / C2C 钱包 / 现货 USDT）**整块删掉** ——
            那几个数在净资产那一段的「币种占比」图例里本来就有，重复占一格不划算。
          ★ 这一格读的是**钱账本**（`/api/exchange/income`，后端定期对账灌进来的）：
            每一笔**钱为什么动**都在里面 —— 已实现盈亏 / 手续费 / 资金费 / 划转 /
            强平清算…，正数进钱、负数出钱。
          ★★ 这里**不做合计**（用户 2026-10-06：「统计数据不要写，近 7 天多少笔保留」）：
            顶上只留「近 N 天 · X 笔」这一个计数，逐笔才是这一格要回答的问题 ——
            「钱是怎么变动的」。按类合计会跟下面「净 / 已实现 / 手续费 / 资金费」
            那一排数字重复，还占掉半屏。
          ⚠️ 金额按**各自资产**记（USDT / BNB / USDC 混着），**不折算**成 USDT —
            换汇只会让这些小数更糊。
        -->
        <section v-show="tab === 'flow'" class="panel">
          <div class="pn-h">
            <h2>资金动向</h2>
            <span
              v-if="incomeTotals"
              class="dim tiny"
              :title="`账本只涵盖最近 ${incomeDays ?? 7} 天（币安只给这么久），更早的不在里面`"
            >
              近 {{ incomeDays ?? 7 }} 天 · {{ incomeTotals.count }} 笔
            </span>
          </div>

          <ul v-if="visibleFlow.length" class="rows flows">
            <li v-for="r in visibleFlow" :key="`${r.keyName ?? ''}-${r.id}`">
              <!--
                一行两段（用户 2026-10-06：「资金动向格式化一下，目前布局行数据显示不是太好」）：
                  ① **币种**（这事发生在哪个币上）→ **类型标签** → **账号标签** ……… 金额（带资产单位，右对齐、定宽）
                  ② 什么时候（一行小字，右边对齐）
                ⚠️ 顺序 2026-10-07 用户又定了一次：「手续费放币种后面 标签放手续费后面」——
                   币种在最前（扫一眼先认出是哪只币），接着「钱为什么动」那颗类型标签
                   （这几行大多是「手续费」，所以他说的是「手续费」），再接着账号标签
                   （「测试」这种 —— 跟成交历史同一条规矩：账号标签跟着币种走）；
                   第二行只剩时间。
                ⚠️ 以前资产（USDT）孤零零挂在第二行左边、金额那格又没单位，
                   既说不清「多少钱」也对不齐 —— 现在资产跟着金额走。
                   划转那种没有交易对的，第一行第一格就写资产本身。
              -->
              <div class="fl-line">
                <span class="fl-what">
                  <span class="sym">{{
                    r.symbol ? baseOf(r.symbol) : r.asset
                  }}</span>
                  <span v-if="r.symbol" class="dim tiny">/USDT</span>
                </span>
                <span class="fl-tag">{{ flowText(r.incomeType) }}</span>
                <span v-if="r.keyName" class="ktag">{{ r.keyName }}</span>
                <span class="spacer" />
                <span class="fl-amt" :class="tone(r.amount)">
                  {{ signedQty(r.amount) }}
                  <!-- 有交易对时才补资产单位（没有的话第一格已经写了资产，别重复） -->
                  <i v-if="r.symbol">{{ r.asset }}</i>
                </span>
              </div>
              <!--
                第二行**靠右**：什么时候发生的（时间到秒）。
                用户 2026-10-06：「所属加样式标签和时间放在右侧，时间显示到秒」→
                2026-10-07 账号标签搬到第一行之后，这一行只剩时间。
              -->
              <div class="fl-sub dim tiny">
                <span class="fl-time">{{ bjTimeSec(r.datetime) }}</span>
              </div>
            </li>
          </ul>
          <p v-else class="dim">
            账本里还没有资金变动（成交 / 资金费 / 划转之后这里会逐笔出现）
          </p>
        </section>
      </div>
    </template>

    <p v-else-if="reason" class="dim no-data">{{ reason }}</p>
    <!--
      ⚠️ 首次挂载时**什么都不画** —— 这里原来是一颗全局 `.spin` + 「正在取账户快照…」。
      用户 2026-10-06：「该页面挂载时不要用全局的 loading，闪一下不好看」：
      实测那颗转圈只存在 **166→228ms（约 60ms）**，出现又消失比直接留白更扎眼。
      读库本来就是毫秒级的，真读不到会走上面那条 `reason`（那是终态，必须说清楚），
      所以这里留白是安全的 —— 别再把 loading 加回来。
    -->
    <!-- 这一页的「配置」（那颗按钮在账户切换行最右侧）；跟 K 线页是**同一个**弹层 -->
    <SettingsSheet :open="cfgOpen" @close="cfgOpen = false" />
  </div>
</template>

<style scoped>
.exb {
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
.warn {
  color: var(--warn, #f0b429);
}
.up {
  color: var(--ok, #5eba89);
}
.down {
  color: var(--bad, #e55361);
}
.load {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  font-size: 13px;
}

/* 「没有数据」那一句：比转圈那句稍微显眼一点（它是终态，不是过渡态） */
.no-data {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.7;
}

/* ---------------- ① 净资产 ---------------- */

.hero-h {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hero-k {
  font-size: 12px;
  color: var(--muted);
}
.rf {
  padding: 2px 8px;
  font-size: 13px;
  line-height: 1.2;
}
/* 手机上这是整页最该看见的数 —— 30px 别再小 */
.hero-v {
  font-size: 30px;
  font-weight: var(--fw-mid, 600);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}
/* 大数 + 缩略走势：一行两端（图靠右）。间距从 `.hero-v` 的 margin 挪到这儿 */
.hero-num {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 0 10px;
}
/*
 * 缩略走势图（净资产旁边那根小折线）。点它展开大图。
 * ⚠️ `preserveAspectRatio="none"` 会让线在横向拉伸时变粗，所以折线上挂了
 *    `vector-effect="non-scaling-stroke"`（描边宽度不跟着缩放）。
 * ⚠️ 宽度在**这里**定（viewBox 是 0~100 的坐标系，靠 CSS 拉伸）：
 *    用户 2026-10-06「缩略图再宽一点」→ 96px 加宽到 136px。
 */
.spark {
  flex: 0 0 auto;
  margin-left: auto;
  width: 136px;
  height: 30px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  cursor: pointer;
  opacity: 0.9;
}
/* 较北京 12:00 盈利 / 亏损 —— 跟 `.up` / `.down` 同一套色（红绿只在**这里**用） */
.spark.up {
  color: var(--ok, #5eba89);
}
.spark.down {
  color: var(--bad, #e55361);
}
/* 展开时就实心（`opacity: .9` 是静止态）。⚠️ 也**不做 hover**（见上，全页不留悬停态） */
.spark.open {
  opacity: 1;
}
.spark svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.spark-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.spark-area {
  fill: currentColor;
  stroke: none;
  opacity: 0.14;
}
.split-bar {
  display: flex;
  gap: 2px;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--panel-2);
}
.split-bar i {
  display: block;
  height: 100%;
  transition: width 0.2s;
}
.split-bar .fx,
.split-bar .c2c,
.split-bar .sp {
  min-width: 2px;
}
.split-lg {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}
.split-lg li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}
.split-lg i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.split-lg .lb {
  color: var(--muted);
}
.split-lg b {
  margin-left: auto;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.split-lg .pc {
  min-width: 46px;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
/* 合约 / C2C / 现货三个色：合约用主色（暖沙），C2C 用蓝，现货用青，跟全站色系不打架 */
.fx {
  background: var(--accent, #d3b583);
}
.c2c {
  background: #5b8def;
}
.sp {
  background: #4cc4b0;
}

/*
 * 三格（用户 2026-10-05 合并后的「合约 · 仓位」那块）：两排，每排三个。
 * ⚠️ 手机上三列会有点挤（112px × 3 + 间距 ≈ 356px，390 宽的屏正好），
 *    所以窄屏降到 `minmax(86px, 1fr)` —— 数字是等宽的，挤一点也读得清。
 */
.grid3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.16));
}
.grid3 + .grid3 {
  /* 第二排（仓位总额 / 多头 / 空头）—— 不再来一条分隔线，看着是一张表 */
  margin-top: 10px;
  padding-top: 0;
  border-top: 0;
}
.grid3 > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.grid3 .k {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}
.grid3 b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 四格：手机 2×2、宽一点自动 4 列（不写死断点，靠 minmax） */
.grid4 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.16));
}
.grid4 > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.grid4 .k {
  font-size: 11px;
  color: var(--muted);
}
.grid4 b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------- ③ 多空条 ---------------- */

.ls-bar {
  display: flex;
  gap: 2px;
  height: 6px;
  margin-top: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--panel-2);
}
.ls-bar i {
  display: block;
  height: 100%;
}
.ls-bar .l {
  background: var(--ok, #5eba89);
}
.ls-bar .s {
  background: var(--bad, #e55361);
}

/* ---------------- 通用小标题 / 卡片行 ---------------- */

.pn-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
/*
 * 「持仓」那一格的顶栏：左排序条件、右一键平仓。
 * ⚠️ 排序那四颗按钮比全站的 `.seg` 小一档（11.5px / 5px 内边距）——
 *    它要跟「一键平仓」挤在同一行，390px 上两者合计约 300 / 358px。
 * ⚠️ 箭头（10px）长在**按钮里面**：当前那一档满色，其余档压淡 —— 见 `dirOf()`。
 */
.pos-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.pos-h .pos-sort button {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 5px 8px;
  font-size: 11.5px;
  /* 窄屏下 flex 会先压按钮宽 —— 压到装不下就换行（实测 320 那档按钮高 27 → 61）。
     这一行必须**一行放得下**，装不下靠下面两条 `@media` 收，不许折行。 */
  white-space: nowrap;
}
/*
 * 窄屏兜底：360 / 320 这两档行宽只有 ~300 / ~258px，四颗按钮 + 一键平仓要一起塞下。
 * ≤380 收内边距和字号；≤340（老 320 机）箭头只留**当前那一档**（其余三颗光剩字）——
 * 少三支 10px 箭头刚好省出 39px，比让整行折成两行好。
 */
@media (max-width: 380px) {
  .pos-h .pos-sort button {
    padding: 5px 6px;
    font-size: 11px;
  }
}
@media (max-width: 340px) {
  .pos-h .pos-sort button:not(.active) svg {
    display: none;
  }
}
.pos-h .pos-sort button svg {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.35;
  transition: transform 0.15s ease;
}
.pos-h .pos-sort button.active svg {
  opacity: 1;
}
/* 升序 = 箭头朝上（同一支箭头转 180°） */
.pos-h .pos-sort button svg.up {
  transform: rotate(180deg);
}
.pos-h .close-all {
  flex: 0 0 auto;
}
.pn-h.mt {
  margin-top: 16px;
}
.pn-h h2 {
  margin: 0;
  font-size: 14px;
}
.sub-h {
  margin: 12px 0 2px;
}
/*
 * 「底部几个 tab 的内容」定高 + 自己滚（用户 2026-10-05：
 * 「底部的几个 tab 内容价格高度，不要让外屏无限滚动」）。
 *
 * 高度取视口的 46%（手机上 ≈390px，正好装 3~4 条持仓），插到 460px 封顶 ——
 * 桌面端不至于空出一大片。内容少的时候自然高度，不会被撑成空白。
 *
 * ★ 2026-10-06 窄屏改成**吃掉整页剩下的高度**（不再用 46vh 那把尺子）：
 *   整页定在 1.2 屏，头几块按内容高，剩下多少全给这一格，超出就在里面滚
 *   —— 见文件末尾那个 `@media`。目的还是同一条：数据再多也别把页面撑成无限长。
 */
.tabs-body {
  max-height: min(46vh, 460px);
  overflow-y: auto;
  overscroll-behavior: contain;
  /*
   * 滚条**不画出来**（用户 2026-10-06：「该页面滚条样式不要出现」）——
   * 这一页窄屏整页只有一个滚动条、宽屏这一格也只占 460px，
   * 再挤进一条细滚动条只添噪音；手指一划 / 滚轮照样滚。
   */
  scrollbar-width: none;
}
.tabs-body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.poss,
.incs,
.cycles,
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
/* 仓位历史的一段（开仓 → 全平） */
/*
 * 「仓位历史 1.只显示已完全平仓的数据 2.样式布局优化
 *   3.详情改为底部弹窗」
 *   ⇒ 未平那些**整块不显示了**，所以 `.cyc.open`（左边那条浅竖线）这套也删了；
 *   现在每段就是一张能点的卡（`.cyc:not(.open)` 那两条只留一条通用规则）。
 */
/*
 * ★ 仓位历史的边界：2026-10-06 一天里改了三轮，区分度指的是
 *      **每一个历史（条目）**」—— 也就是说：**要的是「一条一条分得开」，
 *      不要的是「铺底」**；
 *   ③ 于是定了「每段自己一个圈（1px 描边 + 10px 圆角）、底仍然透明」；
 *   ④ 用户 2026-10-07：「仓位历史行数据边框去掉用分割线看看」⇒ 圈也撤了，
 *      回到**「段与段之间一条分割线」**（`.cyc + .cyc` 的上边线）+ 上下 10px 留白。
 *   ⇒ 记住这条口径：**背景可以不要，边界必须有** —— 但边界可以是**一条线**，
 *     不必是围一圈；`gap` 也要归零，不然「线 + 空档」会变成双层间隔。
 *
 *   段内部的层次（同一轮里定的，别再压平）：
 *        RLC /USDT  多  测试                        +$7.14   ← 16px 粗体，第一眼
 *        开仓均价   平仓均价   持仓                            ← 标签 10.5px 压暗
 *        0.8031    0.94736   8 小时 32 分                    ← 六个值一律 12.5px 白字
 *        手续费 0.0436   资金费用 +0.1047            8 笔明细 ›
 */
.cycles {
  display: flex;
  flex-direction: column;
  /* 段间靠分割线分（见下），不留空档 */
  gap: 0;
}
.cycles .cyc {
  /* 左右不缩进：跟资金动向 / 成交历史那两份列表的左右边界对齐 */
  padding: 10px 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
}
/* 分割线画在**后一段**的头顶（第一段上面不画，上面是列表的标题行） */
.cycles .cyc + .cyc {
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.18));
}
/*
 * ⚠️ **不给悬浮态**（用户 2026-10-07：「不需要 hover 效果」）——
 *    这一整段是可点的（点开明细弹层），但铺一层底色会像「选中」；
 *    用户本来就否过铺底，反馈留给「点开后弹层升起来」本身。
 */
.cycles .cyc:focus-visible {
  outline: 1px solid var(--accent-line, var(--border));
  outline-offset: 1px;
}
.cyc-h {
  display: flex;
  align-items: center;
  gap: 8px;
  /*
   * ⚠️ **标题下面不画线**（用户 2026-10-06：「仓位历史标题下不要加横线分离」）——
   * 段落的分界已经由 `.cyc + .cyc` 那条分割线负责了，里面再来一条线是多一层噪音。
   * 标题和数据之间靠 `padding-bottom` 的留白分开就够了。
   */
  padding-bottom: 5px;
  user-select: none;
}
/* 段标题里的币种名**提一档**：一屏十段全靠它认币（别跟网格里的值一个字号） */
.cyc-h .sym {
  font-size: 14px;
  font-weight: var(--fw-mid, 600);
}
/*
 * 这一笔的净盈亏（卡右上角，弹层里也是主角）。
 * ⚠️ 字号**故意不放大**（用户 2026-10-06：「盈利的金额字体不要放大」）——
 *    就跟着下面 `.pnl` 那条 13px 走（本组件后写、同级覆盖 `.cyc-net` 原来的 15px）。
 *    别再给它加 `font-size`。
 */
.cyc-net {
  font-weight: var(--fw-mid, 500);
}
/*
 * 事实网格：**3 列 × N 行**（标签在上、值在下）。
 * 原来是 8 个「标签 值」靠 `flex-wrap` 挤成一两行，读起来得自己配对；
 * 现在一列一个字段，两边对齐。
 */
.cyc-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 10px;
  margin-top: 8px;
}
.cyc-grid span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.cyc-grid i {
  font-style: normal;
  font-size: 10.5px;
  color: var(--muted);
}
.cyc-grid b {
  font-size: 12.5px;
  font-weight: var(--fw-mid, 500);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/*
 * ⚠️ 用户 2026-10-06 明确否掉了「网格里分两档」：
 *   「持仓时间什么的内容都改为白色吧，这个不用区分」⇒ 六个值**一律** 12.5px 白字。
 *   别再给开仓/平仓均价加粗放大，也别把时间 / 数量压成灰的。
 */
/* 脚注：手续费 / 资金费用 / 「N 笔明细 ›」——**不画线**（标题线已经在头顶了，
   脚注再来一条会跟下一段的标题线贴在一起，看着像双线）*/
.cyc-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 7px;
  font-size: 11px;
  color: var(--dim, #999);
}
.cyc-more {
  color: var(--muted);
}
/*
 * 明细弹层：**高度卡在 66vh**（用户 2026-10-06：「弹窗高度要限制」），
 * 而且**滚的只有订单那一段**——
 * 标题 / 净盈亏 / 六格事实都钉在上面，翻明细时它们不动。
 * ⚠️ 弹层自己是 `flex` 列、**不滚**（`overflow: hidden`），明细那条 `flex:1 + overflow:auto`
 *    才是滚动容器；`min-height: 0` 不能省 —— 少了它 flex 子项不会收缩、整个弹层又会被撑开。
 */
.cyc-sheet {
  display: flex;
  flex-direction: column;
  max-height: 66vh;
  overflow: hidden;
}
.cyc-sheet .sheet-head {
  flex: 0 0 auto;
}
/*
 * 逐笔明细（只在**弹层**里出现）：**时间轴**画法（用户 2026-10-06：
 * 「订单区域每一笔用一个点加连接线样式」）—— 每一笔左边一个点、点与点之间连一条线，
 * 一眼看出「什么时候开的、中间减了几次、最后平的」。
 *
 * 每一笔两行（**只报这张单**）：
 *   ● 10-06 11:48:47  买                +$1.18  减仓   ← 盈亏在行为的左边，行为最右
 *   │ 价格 0.8934  数量 6.6             价值 5.90 USDT   ← 换行从左边起
 *
 * ⚠️ 这一段是弹层里**唯一会滚**的区域（见上面 `.cyc-sheet`）；
 *    分隔线不用画了 —— 时间轴那条线本身就是节奏。
 */
.cyc-orders {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  /* 滚条不画（跟这一页别处一个规矩） */
  scrollbar-width: none;
}
.cyc-orders::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.cyc-orders li {
  position: relative;
  display: block;
  padding: 5px 0 5px 18px;
  font-size: 12px;
}
/* 那个「点」：整条时间轴上一个节点 */
.cyc-orders li::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 9px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted, #8d9099);
}
/* 「连接线」：从上往下串起来（最后一笔不再往下画） */
.cyc-orders li::after {
  content: '';
  position: absolute;
  left: 6px;
  top: 17px;
  bottom: -1px;
  width: 1px;
  background: var(--border, #26282e);
}
.cyc-orders li:last-child::after {
  display: none;
}
/* 开仓那一笔的点**提亮**：整个故事从这儿开始 */
.cyc-orders li:first-child::before {
  background: var(--accent, #d3b583);
}
.ord-1 {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 钱那一行（价值 / 手续费 / 这笔的盈亏）——带单位，所以自己占一行 */
.ord-2 {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}
.ord-2 b {
  font-weight: var(--fw-mid, 500);
  color: var(--text, #e8e8e8);
}
/* 时间：**写全**（`10-06 11:48:47`，含日期和秒）在左、等宽数字 ⇒ 几行看下来是齐的 */
.cyc-orders .ord-time {
  flex: 0 0 auto;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
/* 开 / 加 / 减 / 平：动作标签，定宽两个字 */
.cyc-orders .ord-act {
  flex: 0 0 auto;
  min-width: 24px;
  font-size: 11px;
  color: var(--muted);
}
.cyc-orders .ord-px {
  color: var(--text, #e8e8e8);
  font-weight: var(--fw-mid, 500);
}
.cyc-orders .ord-pnl {
  flex: 0 0 auto;
}
/* 这一笔的**仓位价值**（价格 × 数量）—— 跟上一行的时间落同一条右边界 */
.ord-val {
  flex: 0 0 auto;
  white-space: nowrap;
}
/* 持仓 / 挂单两个列表：`gap` 都归零，条目之间靠一条底线分 */
.poss,
.grps {
  display: flex;
  flex-direction: column;
  gap: 0;
}
/*
 * 持仓一条——
 * 底 / 描边 / 圆角全撤，跟仓位历史 / 成交 / 挂单统一成**透明底 + 一条线**；
 * 左右也不再缩进，两端贴面板内边。
 * ⚠️ 别再加左侧色条。
 */
.poss li {
  padding: 8px 0;
  border-bottom: 1px solid var(--line, rgba(128, 128, 128, 0.18));
}
/* 最后一条不画（整份列表不拖尾巴线，跟另外三份列表一致） */
.poss li:last-child {
  border-bottom: 0;
}
/*
 * 标题行：**整行可点**（去这个币的 K 线）⇒ 手型光标；**不给悬停态**（见下）。
 */
.p-h {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  cursor: pointer;
}
/*
 * ⚠️ **只留键盘焦点**，不给悬浮态（用户 2026-10-07：「不需要 hover 效果」）——
 *    手机 WebView 里悬停本来就是虚的，安卓还会在**点完之后把 `:hover` 粘住**，
 *    点一行结果那一行一直亮着，看着像「选中」。
 */
.p-h:focus-visible .sym {
  text-decoration: underline;
}
.p-h:focus-visible {
  outline: 1px solid var(--accent-line, var(--border));
  outline-offset: 2px;
  border-radius: 4px;
}
.sym {
  font-size: 13px;
  font-weight: var(--fw-mid, 500);
}
.side {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  flex: 0 0 auto;
}
.side.buy {
  color: var(--ok, #5eba89);
  background: var(--ok-soft, rgba(94, 186, 137, 0.14));
}
.side.sell {
  color: var(--bad, #e55361);
  background: var(--bad-soft, rgba(227, 85, 97, 0.14));
}
.lev {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--line, rgba(128, 128, 128, 0.24));
  border-radius: 4px;
  padding: 0 4px;
}
.pnl {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 500;
}
.pnl em {
  font-style: normal;
  font-size: 11px;
  opacity: 0.8;
}
/*
 * 四格数据（用户 2026-10-06 定的顺序。
 *
 * ⚠️ **固定四列**，不要 `auto-fit`：四格要正好铺满**一行**，
 *    窄一点就折成 3+1（第二行只剩一格，看着像漏了东西）。
 */
/* 四格：4 列 × 1 行，**格内标签在上、数值在下** */
.kv {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px 8px;
  margin-top: 8px;
}
.kv > div {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.kv .k {
  font-size: 11px;
  color: var(--muted);
}
.kv b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
}
/*
 * 「距强平」是六格里唯一会变成警示色的（<5% = 快到强平了）。
 *
 * ⚠️ 2026-10-06 之前它是一颗**标签**摆在卡片顶部；用户说「距强平不要标签了，
 *    强平价格换成距强平」⇒ 现在它是一个正式的格（跟旁边五格一个字号、正常颜色），
 *    强平价本身挪进 `title`。别再加回标签。
 */
.kv b.warn {
  color: var(--warn, #e0a33e);
}
/* 未实现盈亏靠右（这一条里最要紧的数）；「已结」2026-10-07 搬到底行右边了 */

.pnl-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  margin-left: auto;
  min-width: 0;
}
/*
 * 止盈 / 止损：**简写**，只报一个价，
 * 跟右边的「已实现盈利」**同一行**。
 * ⚠️ 没挂的那一条写「未止盈 / 未止损」，压暗 —— 别藏起来，不然人不知道是没设还是没读到。
 */
/* 两条简写包一层：中间那个 `/` 只是分隔（没它两个裸数字会连成一片） */
.ts-mini-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex: 0 0 auto;
}
.ts-sep {
  font-style: normal;
  opacity: 0.45;
}
.ts-mini {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
  white-space: nowrap;
}
.ts-mini.profit {
  color: var(--ok, #5eba89);
}
.ts-mini.stop {
  color: var(--bad, #e55361);
}
.ts-mini.none {
  color: var(--muted);
  opacity: 0.8;
}
/*
 * 底数第一行：左边两条止盈 / 止损简写，右边「已实现盈利」。
 *
 * ⚠️ 390px 上这两样加起来要能放下（止盈止损最长约 170px + 已实现盈利约 120px），
 *    所以：`已实现盈利` 那个标签用 11px、值用 mono 11.5px；
 *    留 `flex-wrap` 兜底 —— 更长的一对价格就折行，折行总比把小字挤成一条线强。
 */
.p-f {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--muted);
}
/* 右边那颗「已实现盈利」：标签压暗、数值按盈亏上色 */
.real-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex: 0 0 auto;
  white-space: nowrap;
}
.real-k {
  font-size: 11px;
}
.real-wrap b {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 500;
}
/*
 * 最底下一行：三颗按钮**等分平铺**（用户 2026-10-07：「按钮放最底下平铺」）。
 * ⚠️ `flex: 1 1 0` + `min-width: 0`：三等分整行宽，长一点的字也不会把某一颗挤扁。
 * ⚠️ 上下只留 5px（用户 2026-10-07：「持仓 按钮上下间距小一点」）—— 上面离
 *    「止盈止损 / 已实现盈利」那一行 5px，下面离卡片底线由 `.poss li` 的 8px 兜住。
 */
.p-btns {
  display: flex;
  gap: 8px;
  margin-top: 5px;
}
/* 底部那三颗按钮：上下内边距 6 → 5（按钮本身也别太胖） */
.p-btn {
  flex: 1 1 0;
  min-width: 0;
  padding: 5px 4px;
  font-size: 11.5px;
}
/*
 * 三颗按钮**一个样**（用户 2026-10-07：「三个按钮都简约化 和现在减仓一样」）——
 * 都是 `ghost` 的中性色（`--text` 字 + `--border` 线），不靠颜色分主次。
 * ⚠️ 别再给某颗加颜色（当天先试过「主动作暖沙 + 平仓红」，用户看过后否了）；
 *    要强调哪一颗，用**文字**（比如按钮上写清动作）而不是颜色。
 * ⚠️ 也别给它们起 `danger` 这种名字 —— 全局有一条 `button.danger`
 *    （透明底 / `--muted` 字 / 2px 内边距），会把它改成跟另外两颗不一样的东西。
 */
/*
 * 挂单组：
 *   ① 「挂单也不需要背景边框还能用什么方式」→ 先改成段间一条分割线；
 *   ② 「只在行数据加底线」→ 撤掉组间那条、组头那条，把线画到**订单行**上；
 *   ③ 「是按币种区分」⇒ 纠正成：**这条底线分的是「币种」，不是「每一单」** ——
 *      所以一单一条线撤掉，只在**每一组币种的末尾**留一条（挂在最后一单的下面）。
 *   ⇒ 视觉上：组头（无上下线）→ 这个币的几单连排（靠 8px 行距分）→ **一条底线** → 下一组。
 *      线是「挂在行数据上」的（贴在最后一单底部），不是围在组外面的一圈框。
 *   ⇒ 最后一组的末尾**不画**（整份列表不拖一条尾巴线，跟成交 / 资金动向一致）。
 *   ⇒ 组内不再画线，靠留白顶住：组头上面 12px、单与单之间 16px（8+8）。
 */
.grps .grp {
  padding: 12px 0 4px;
}
/* 组头下面不画线（③ 之后这里只剩留白） */
.grps .grp .grp-h {
  padding-bottom: 2px;
  border-bottom: 0;
}
.grp-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
}
/*
 * ⚠️ `:not(.trades)` —— 成交那份列表**自己就是一块块卡**（见下面 `.trades li`），
 *    再叠一层「每行一条分隔线」会跟卡边打架（第一张卡还会被 `:first-child`
 *    抹掉上边，看着像缺了一条边）。
 */
.rows:not(.trades) li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  font-size: 12.5px;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.12));
}
.rows:not(.trades) li:first-child {
  border-top: 0;
}
/*
 * 挂单那一组的一行是**两行**（见 `.o-t` / `.o-kv`），所以这一组要覆盖掉上面的单行 flex。
 * ⚠️ 只覆盖 `.grps` 里的 —— `.rows li` 本体还被「资产明细」那三个列表用着（单行 flex）。
 * ⚠️ 线也在这儿盖：`.rows:not(.trades) li` 的 `border-top` 跟这条**同权重**（都是 0,2,1），
 *    只能靠**写在后面**赢（写在前面会被它盖回去 ⇒ 上下一堆双线）。
 * ⚠️ 线**按币种分组**，不按单：一单一条已撤，
 *    只在每组最后一单下面留一条。
 */
.grps .rows li {
  display: block;
  padding: 8px 0;
  cursor: pointer;
  border-top: 0;
  border-bottom: 0;
}
.grps .grp .rows li:last-child {
  border-bottom: 1px solid var(--line, rgba(128, 128, 128, 0.16));
}
/* 整份列表的最后一组不画（不拖一条尾巴线） */
.grps .grp:last-child .rows li:last-child {
  border-bottom: 0;
}
/*
 * 点得动的那一行：**只有键盘焦点**给一点点底（用户 2026-10-07：「不需要 hover 效果」，
 * 安卓点完会把 `:hover` 粘住 ⇒ 一行一直亮着，像「选中」）。
 */
.grps .rows li:focus-visible {
  background: var(--hover, rgba(255, 255, 255, 0.03));
  border-radius: 8px;
}
.grps .rows li:focus-visible {
  outline: 1px solid var(--accent-line, var(--border));
  outline-offset: -1px;
}
/* 行尾那颗「›」——告诉人这一行点得动 */
.o-go {
  flex: 0 0 auto;
  color: var(--muted);
  opacity: 0.7;
}
/*
 * 挂单一行 = **两行**：
 *   ① 买/卖 + 类型（中文）+ 平仓比例 …………… 数量
 *   ② 触发价 / 委托价 (+ 已成交) ………………… 挂了多久
 * 用户 2026-10-06：「挂单页面数据我看不懂」⇒ 类型说中文、价格按类型换列、
 * 数字都带上字头（原来只有 `TAKE_PROFIT_MARKET / — / × 3303` 三个光秃秃的值）。
 */
.o-t,
.o-kv {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}
.o-kv {
  margin-top: 3px;
  font-size: 12px;
  color: var(--dim, #999);
}
.o-kv b {
  color: var(--text, #e8e8e8);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-mid, 500);
}
/* 止盈绿 / 止损红 —— 跟持仓卡那行「止盈/止损」同一个色 */
.o-ty {
  flex: 0 0 auto;
  white-space: nowrap;
}
.o-ty.profit {
  color: var(--ok, #5eba89);
}
.o-ty.stop {
  color: var(--bad, #e55361);
}
.o-ty.plain {
  color: var(--muted);
}
/* 平仓比例：这颗是「这张单要平掉多少仓」，条件单最关键的一个数 */
.o-pc {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--muted);
  background: var(--panel-2, rgba(128, 128, 128, 0.12));
}
.o-qty {
  flex: 0 0 auto;
  white-space: nowrap;
  color: var(--dim, #999);
}
.o-qty b {
  color: var(--text, #e8e8e8);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-mid, 500);
}
/*
 * 逐笔：跟「成交历史」同一套画法（**不画卡**，一行一条淡分隔线就够区分）。
 * ⚠️ 别用 `.rows li` 那套（那是单行 flex），这一行是两行。
 */
/*
 * ⚠️ 选择器必须写成 `.rows.flows li`（两个类）：`.rows li` 那条**老规则是单行 flex**，
 *    跟 `.flows li` 特异性一样（都是 0,1,1），而它在文件里**排在后面** ⇒ 会反过来把
 *    这里的 `display:block` 顶掉：li 变成横向 flex，里面那两行变成两个 flex item
 *    被压成「内容宽」，每行的右边缘就对不齐了。
 */
.rows.flows {
  display: flex;
  flex-direction: column;
}
.rows.flows li {
  display: block;
  padding: 9px 0;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.14));
}
.rows.flows li:first-child {
  border-top: 0;
  padding-top: 0;
}
.fl-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
/* 这事发生在哪个币上（没有交易对的资金事件就写资产本身） */
.fl-what {
  display: flex;
  align-items: baseline;
  gap: 3px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/*
 * 金额：**定宽 + 右对齐 + 等宽数字** —— 一列看下来小数点是对齐的，
 * 一眼能扫出「哪几笔钱大」。以前它是被 `spacer` 顶到最右边的自由宽度，
 * 位数一多一少就参差不齐。
 */
.fl-amt {
  flex: 0 0 auto;
  min-width: 104px;
  text-align: right;
  white-space: nowrap;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-weight: var(--fw-mid, 500);
}
.fl-amt i {
  font-style: normal;
  margin-left: 4px;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--muted);
}
/* 类型那颗小标签：钱动的原因（已实现盈亏 / 手续费 / 资金费 / 划转…） */
.fl-tag {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--muted);
  background: var(--panel-2, rgba(128, 128, 128, 0.12));
}
.fl-sub {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 3px;
  font-size: 11.5px;
}
/*
 * 时间（资金动向 `.fl-time`）：等宽数字，右边那一列上下是对齐的。
 * ⚠️ 成交历史的时间 2026-10-07 起进了 `.t-cols` 那个两行两列的网格
 *    （`时间 10-06 20:32:03`），那边靠 `.t-pair .num` 吃等宽，所以这里不再带
 *    `.t-time`。
 */
.fl-time {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
/* 二级 tab 那一条：窄屏可以横向划，滚条不画（跟这一页别处一个规矩） */
.seg-scroll {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.seg-scroll::-webkit-scrollbar {
  height: 0;
}
.incs li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 13px;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.16));
}
.incs li:first-child {
  border-top: 0;
}
/*
 * 成交：
 *   · 「看不太懂，不需要边框，只要能区分就行」→ **不套卡**（描边 / 圆角撤掉），
 *     一屏几十条画框太吵；行与行之间一条**极淡的分隔线**就够了
 *     （`.rows:not(.trades) li` 那套不适用，这里单独给，免得又跟 `:first-child` 打架）。
 *   · 「成交历史也格式化…也是到秒」→ 版式对齐**资金动向**：第一行「方向 + 币种
 *     …… 成交金额」，第二行「价 / 数量 / 手续费 …… 账号标签 + 时间（到秒）」。
 *     右边两列都是定宽右对齐，一列扫下来是齐的。
 */
.rows.trades {
  display: flex;
  flex-direction: column;
}
.trades li {
  display: block;
  padding: 9px 0;
  font-size: 12.5px;
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.14));
}
.trades li:first-child {
  border-top: 0;
  padding-top: 0;
}
.t-line {
  display: flex;
  align-items: center;
  /*
   * ⚠️ 间距 8→6（用户 2026-10-07 把账号标签搬到这一行之后）：
   *    这一行现在是「方向 + 币种 + /USDT + 标签 + 金额」五个 flex 子项、
   *    五个 gap 加一次 `margin-left`，8px 那版实测最宽的一条**溢出 11px**
   *    （长币种 + 长金额，比如 `1000000MOG` + `价值 16.3378 USDT`）。
   */
  gap: 6px;
}
/*
 * 成交那块的「价值 xxxx USDT」：
 * ⚠️ **不给定宽**（用户 2026-10-06：「价值两个字不要固定位置，靠右加间距」）——
 *    资金动向那边是纯数字，104px 定宽右对齐正合适；这边前面挂了「价值」两个字，
 *    一定宽就把标签钉在列左边缘、数字甩到最右边，金额一短中间空一大块。
 *    改成**整块 nowrap 靠右**：标签贴着数字，数字的右边缘照样落在那条竖线上
 *    （靠右 = 右对齐，对齐的是右边缘，不是左边缘）。
 * `.fl-amt` 那边仍然用 104px 定宽，两份列表的右边缘依旧是同一条线。
 */
.t-amt {
  flex: 0 0 auto;
  /* 万一币种名很长，别让两块粘在一起 */
  margin-left: 6px;
  text-align: right;
  white-space: nowrap;
  font-weight: var(--fw-mid, 500);
}
/* 「价值」两个字：跟着数字走，所以自己不带任何定宽 */
.t-amt em {
  font-style: normal;
  margin-right: 6px;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--muted);
}
.t-amt i {
  font-style: normal;
  margin-left: 4px;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--muted);
}
/*
 * ⚠️ 窄屏兜底（≤380px，360 的安卓机很常见）：第一行要塞下「方向 + 币种 + /USDT
 *    + 账号标签 + 金额」五样，实测 360 屏**十条里有一半**会把币种名截成
 *    `1000…`（`.trades .t-line .sym` 那道省略号兜底）。
 *    这里省掉金额尾巴上那个 `USDT` —— 同一行的 `/USDT` 就在币种旁边，
 *    这个单位本来就是重复的；宁可少一个重复的单位，也不要把币种名吃掉。
 */
@media (max-width: 380px) {
  .t-amt i {
    display: none;
  }
}
/*
 * ⚠️ 兜底：这一行的五个子项加起来是有可能超出整行的（长币种 + 长金额），
 *    flex 默认按「最小内容宽」拒绝收缩 ⇒ 直接撑破行框、压到面板边上。
 *    给币种开一个可收缩的口子（只有它收，其余 `flex: 0 0 auto` 不动），
 *    真超了也只是把币种名尾巴省略掉，行本身不会破。
 */
.trades .t-line .sym {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 成交第二行（用户 2026-10-07：「下面文字和内容列…」→ 先说「竖着布局居中」，
 * 看到效果后改成**「文字在左内容在右」**）：
 * **两行两列、每格「标签在左、数值在右」**：
 *     价格 0.1212            数量 134.8
 *     手续费 0.0082 USDT     时间 10-06 20:32:03
 * ⚠️ **不能四项横排一行**：`价格 0.1212 / 数量 134.8 / 手续费 0.0082 USDT /
 *    时间 10-06 20:32:03` 一行要 380px，390 屏的行宽只有 340px —— 挤不下，
 *    所以分成两行两列。
 * ⚠️ 两列都**靠左**（用户 2026-10-07：「历史成交还是左对齐吧」）：早先是
 *    `space-between`（右列贴着行右边缘、跟第一行的金额对齐），但这样中间空出一大块、
 *    扫起来要从左看到右；现在整块往左收，两列各自还是一列对齐的
 *    （列宽 `max-content`，`column-gap` 就是两列之间的固定间距）。
 * ⚠️ 原来这一行是横向 flex + `gap:10px`，窄屏必挤成一条 3+1 的折行
 *    （实测行高 34.5px，就是「价格 数量 手续费」换行又把「标签 时间」顶下去）。
 */
.t-cols {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, max-content));
  justify-content: space-between;
  column-gap: 16px;
  row-gap: 2px;
  margin-top: 5px;
  font-size: 11.5px;
}
.t-pair {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}
/*
 * 「价格 / 数量 / 时间」两个字、「手续费」三个字 —— 统一按**三个字宽**占位。
 * ⚠️ 里面是**汉字左对齐**（用户 2026-10-07：「成交历史价格和手续费左对齐，汉字」）——
 *    先做过一版右对齐（两个字的标签靠在三字框右边、让数值从同一起点起），
 *    但汉字那一列看着是参差的，用户要的是**标签本身左对齐**。
 *    保持 `3em` 宽：四个标签的**左边缘**一条线，后面的数值也就还从同一个位置起
 *    （`3em` 一去掉，`价格` 和 `手续费` 后面的数值就会差 10px）。
 */
/*
 * ⚠️ **右列那两格**（数量 / 时间，DOM 里是第 2、4 个子项 —— grid 是行优先排的）
 *    都是两个字，用不着三字框：`3em` 那一版里值离标签有 16.5px，用户
 *    2026-10-07：「时间和数量和内容近一点」⇒ 右列收成 `2em`。
 *    左列（价格 / 手续费）留 `3em`：`手续费` 正好三个字，收窄它会让**同一列**里
 *    「价格」和「手续费」后面的数值错开 10px。
 */
.t-cols .t-pair:nth-child(2n) em {
  min-width: 2em;
}
.t-pair em {
  flex: 0 0 auto;
  min-width: 3em;
  text-align: left;
  font-style: normal;
  font-size: 10.5px;
  opacity: 0.72;
}
.t-pair .num {
  white-space: nowrap;
}
.num {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
/*
 * 账户 tab 条（原来这儿是「净资产」旁边一个 `<select class="acct">`）。
 * key 名字可能长、套数可能多 ⇒ 横向滚动，不换行也不把按钮挤扁。
 *
 * ⚠️ 2026-10-07 外面多包了一层 `.acct-bar`：这条 tab 条右边多了一颗「配置」，
 *    配置**不跟着滚**⇒
 *    tab 条吃掉剩下的宽（`flex: 1 1 auto` + `min-width: 0`）并在自己里面滚。
 */
.acct-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.acct-bar .acct-tabs {
  flex: 1 1 auto;
  min-width: 0;
}
/*
 * 「配置」钉在最右，是颗**图标按钮**——
 * 高度对齐 tab 条那颗胶囊（32px），宽度按方形给，别用文字按钮的左右内边距。
 * ⚠️ 圆角跟旁边那颗胶囊一样取 `--r-xs`(8px)：默认的 10px 比胶囊圆，并排看得出不齐。
 */
.acct-bar .cfg {
  flex: 0 0 auto;
  margin-left: auto;
  border-radius: var(--r-xs);
  width: 36px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}
.acct-bar .cfg svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.acct-tabs {
  display: flex;
  flex: 0 0 auto;
  overflow-x: auto;
  scrollbar-width: none;
}
.acct-tabs::-webkit-scrollbar {
  display: none;
}
.acct-tabs :deep(button) {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 7px 14px;
}
/*
 * 刷新按钮的图标：**内联 SVG**（原来那个 `⟳` 字符在 Android WebView 里
 * 兜底字体没这个字形，App 上是一颗空白按钮）。
 * 尺寸对齐 `.ghost.tiny` 的高度，别把这一行撑高。
 */
.rf {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px 6px;
}

.rf svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 刷新中：整个按钮转圈（keyframes spin 是全局的，见 style.css） */
.rf.busy {
  animation: spin 0.8s linear infinite;
  cursor: default;
}

/* USDT / CNY 切换：跟「几分钟前」并排的一颗小标签，点了就换 */
.cur {
  padding: 3px 7px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: var(--fw-bold);
}

/* 仓位统计标题右边那颗「总杠杆」 */
.lev-chip {
  margin-right: auto;
  margin-left: 8px;
  padding: 1px 7px;
  border: 1px solid var(--accent-line);
  border-radius: 999px;
  background: var(--blue-soft);
  color: var(--blue);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: var(--fw-bold);
}

/* ---------------- ⑥ 净资产走势（折叠） ---------------- */

/*
 * 折叠块在 hero 卡里、四格上方。**不画自己的上边框** —— 下面 `.grid4`
 * 自带一条 `border-top`，折叠时那条线就当这一行的下划线，正好把四格隔开。
 */
.fold {
  margin-top: 10px;
}
.fold-h {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 0;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}
.fold-t {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
/*
 * 展开后第一件东西（币种占比条）跟标题拉开距离 ——
 * 用户 2026-10-06：「（保留下拉的币种占比）和标题保持间距」。
 */
.fold-h + .split-bar {
  margin-top: 10px;
}
.chev {
  flex: 0 0 auto;
  color: var(--muted);
  transition: transform 0.15s;
}
.chev.open {
  transform: rotate(180deg);
}

/*
 * 跨度切换：6 档铺满一行，**纯文字**，选中的只换字色。
 * ⚠️ 类名避开全局的 `.chip`（那是标签筛选的胶囊，见 style.css 4434）。
 */
.rngs {
  display: flex;
  justify-content: space-between;
  gap: 2px;
  margin-top: 2px;
}
.rng {
  flex: 1 1 auto;
  padding: 3px 0;
  font-size: 11.5px;
  text-align: center;
  color: var(--muted);
  background: none;
  border: 0;
}
.rng.on {
  color: var(--accent, #d3b583);
  font-weight: 600;
  background: none;
}

/*
 * 窄屏：整页内容**定在 1.2 屏**（`ExchangeAccountLivePanel` 那边 `.live { height: 120vh }`），
 * 多出来的部分由 `.tabs-body` **内部滚** ——
 * 用户 2026-10-06：「设置最大高度 120vh，我就想在仓位历史或者其他数据过多时不要无限滚动」。
 *
 * 所以窄屏的最终形态是一条 flex 链：
 *   `.live`（120vh）→ `.exb` 撑满它 → 头几块（账户 tab / 净资产 / 仓位统计 / tab 行）按内容高
 *   → `.tabs-body` 吃掉剩下的高度并自己滚。
 *
 * ⚠️ **`overscroll-behavior: auto`（放开滚动链）**：用户 2026-10-06 问
 *    「滚动能穿透吗，比方仓位历史滚动到顶部了就触发父容器滚动」——
 *    内层滚到顶/底之后再拉，就该接着滚外面那一层（默认行为）。
 *    基础样式里那条 `contain` 是给**宽屏**的小框定的（就 460px 高，
 *    一滑就带着整页飞，很烦），窄屏这里必须盖掉。
 *    ⚠️ 别改成 `contain`：那样内层滚到顶以后手指再怎么拉页面都不动，
 *      「卡住」的手感就是它来的。
 * ⚠️ 整页本身仍然可滚（120vh > 可视区），下拉刷新照旧成立。
 */
@media (max-width: 900px) {
  .exb {
    flex: 1 1 auto;
    min-height: 0;
  }
  /* 头几块按内容高，别被 flex 压扁 */
  .exb > .acct-bar,
  .exb > .panel,
  .exb > .seg {
    flex: 0 0 auto;
  }
  .tabs-body {
    flex: 1 1 0;
    min-height: 0;
    max-height: none;
    overflow-y: auto;
    /* 滚到头接着滚外面（见上面那段说明） */
    overscroll-behavior: auto;
  }
}
</style>
