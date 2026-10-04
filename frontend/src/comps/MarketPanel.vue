<script setup lang="ts">
/**
 * 合约行情（参考币安「合约行情」页）。
 *
 * 一屏把全市场看一遍：
 *   · 币种（带图标）/ 最新价 / 24h 涨跌 / 24h 成交额
 *   · 表头点一下就能按涨跌幅 / 成交额排（▲ 升序、▼ 降序，各是一个按钮）
 *   · 上面只有搜索框（榜单按钮「成交额 / 涨幅 / 跌幅」已按用户要求去掉）
 *   · 点一行 = 切币种（把下方行情、K 线、历史全换过去）
 *
 * 数据怎么来（**实时推送**，不再自己轮询）：
 *   1. 挂载时 `GET /api/markets` 拉一次**全表**当底稿
 *   2. 之后只吃 SSE `/api/tickers/stream` 的增量（后端从币安 `!ticker@arr` 中转，
 *      每秒一批、每批只含刚变过的两三百个币），按 `pair` 盖到那行上；
 *      ⚠️ 刷入走**帧率合并**（`pending` 缓冲 + `requestAnimationFrame`），
 *      一帧内到达的多批只重算一次
 *   3. 兜底：SSE 静默超 15 秒（后端上游也挂了）才临时开 REST 轮询；
 *      每 5 分钟重新拉一次全表，把新上的币检进来
 *
 * 只渲染前 `MAX_ROWS` 行：币安 USDT 本位有 500+ 个合约，
 * 全塞进 DOM 里每秒重绘一次会让滑动发涩 —— 搜索/排序仍然吃全量数据。
 */
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {
  fetchMarkets,
  fetchPins,
  iconUrl,
  tickerStream,
  togglePin,
  type MarketRow,
  type TickerPatch
} from '../api'
import {decimalsFor, fmt} from '../format'
import {isForeground, onForegroundChange} from '../live'
import {marketMinVolUsd} from '../settings'

const props = defineProps<{
  /** 当前选中的币种（高亮那一行） */
  symbol: string
  /**
   * 这一格正被看着吗（窄屏切到别的 tab 就 false）。
   *
   * ⚠️ 组件是**常驻**的（外层用 `v-show`），所以不能再拿「挂载/卸载」当开关 ——
   * 靠这个属性停掉推送和轮询，回来时补一次全表。
   */
  active?: boolean
  /** REST 兜底的轮询间隔（毫秒）—— 只在 SSE 静默时才用得上 */
  intervalMs?: number
}>()

const emit = defineEmits<{
  (e: 'pick', base: string): void
  /** 名单里有几个币（标题右侧那个「共 N 个合约」在父组件里显示） */
  (e: 'count', n: number): void
}>()

const MAX_ROWS = 120
/** 好久没收到 SSE 就认为推送断了，改用 REST 顶一会儿 */
const STALE_MS = 15_000
/** 全表重拉（检新上市 / 下架的币） */
const RESYNC_MS = 5 * 60_000

/**
 * 排序状态：**按哪一列**（`sortKey`）+ **哪个方向**（`sortDir`）。
 *
 * 用户 2026-10-03：「涨跌幅和成交额旁加图标可以切换排行」，
 * 又提「成交量没法双向点击，图标换个分开的」——
 * 所以表头上那颗上下箭头是**两个分开的点击目标**：点 ▲ 升序、点 ▼ 降序。
 * 点标题文字本身 = 切到这一列，方向用最顺的那个（两列都是「从大到小」）。
 *
 * ⚠️ 2026-10-03 又一轮：「成交 / 涨幅 / 跌涨都去掉，**每次都是全量**」——
 * 上面那排榜单按钮删了，涨跌幅那一列也**不再筛掉涨/跌**（以前降序只留涨的、
 * 升序只留跌的），现在就是一个普通排序：两个方向都是**全量**。
 */
type SortKey = 'volume' | 'change'
const sortKey = ref<SortKey>('volume')
const sortDir = ref<'asc' | 'desc'>('desc')

function setSort(key: SortKey, dir: 'asc' | 'desc'): void {
  sortKey.value = key
  sortDir.value = dir
}

/**
 * 点标题文字：不是这一列 → 切过来（从大到小）；
 * 就是这一列 → **换个方向**。
 *
 * ⚠️ 以前「已经在排这一列了就直接 return」—— 默认就是成交额降序，
 * 于是点「成交额」这三个字一点反应都没有（用户：「点击切换没有生效」）。
 * 现在是「点一下换个方向」，任何一点都能看到东西在变。
 */
function sortBy(key: SortKey): void {
  if (sortKey.value !== key) return setSort(key, 'desc')
  sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc'
}

const keyword = ref('')

/**
 * 全表的实时底稿：`pair`（BTCUSDT）→ 那一行。
 *
 * ⚠️ 故意用**普通 Map**而不是 `ref`：一秒一批、一批两三百个币，
 * 走响应式代理纯属浪费；改完统一 `version.value++`，让下面的 computed 重算。
 */
const byPair = new Map<string, MarketRow>()
/** 增量版本号（`byPair` 里的对象是非响应式的，靠它触发重算） */
const version = ref(0)

/**
 * 帧率合并的缓冲：`pair` → 这一帧里**最后一条**增量。
 *
 * 数据本来就是一秒一批，但重连补推 / REST 兜底交错时可能一帧里来好几批 ——
 * 每条都 `version++` 会让同一帧渲染多次。攒在这里，`requestAnimationFrame` 里统一刷。
 * 同一个币在缓冲里只留最后一条（中间价差用户肉眼分辨不出，丢掉无损）。
 */
const pending = new Map<string, TickerPatch>()
/** 已排队的刷新（0 = 没有） */
let flushRaf = 0

const loading = ref(false)
const error = ref('')

/** 没有图标的币（退回首字母圆形占位） */
const failed = ref<string[]>([])

/* ---------------- 表头对齐表身 ---------------- */

/** 表身（真正滚的那一层） */
const bodyEl = ref<HTMLElement | null>(null)
/**
 * 表身滚动条的宽度。
 *
 * 表头和表身是两张表，表身有滚动条时会比表头窄这么多 —— 不给表头补上，
 * 两边的列就会错开几个像素（列宽是百分比，错开得很明显）。
 * 实时量：覆盖式滚动条（macOS 默认）算出来是 0，不需要补。
 */
const sbw = ref(0)

function measureScrollbar(): void {
  const el = bodyEl.value
  if (!el) return
  const w = Math.max(0, el.offsetWidth - el.clientWidth)
  if (w !== sbw.value) sbw.value = w
}

/*
 * ⚠️ 原来的「手机端下滑自动收起搜索框」（`compact` + `onListScroll`）2026-10-04 已删。
 * 它按滚动方向反复切换 `compact` → 每一下都改 `max-height`，触发布局 + 动画，
 * 滚动时明显掉帧（用户：「搜索框固定吧，滚动会导致帧率变低的感觉卡顿」）。
 * 现在搜索框**常驻** —— 它本来就在滚动容器 `.mkt-body` 之外，不随列表滚走。
 */

let unsubscribe: (() => void) | null = null
/** SSE 静默时的 REST 兜底轮询 */
let fallbackTimer: ReturnType<typeof setInterval> | null = null
/** 定期整表重同步 */
let resyncTimer: ReturnType<typeof setInterval> | null = null
let aliveTimer: ReturnType<typeof setInterval> | null = null
let lastEventAt = 0
let stopped = false

/** 拉一次全表（初载 / 兜底 / 重同步都用它） */
async function loadSnapshot(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const d = await fetchMarkets()
    if (stopped) return
    // 以整表为准：新上的币会进来，下架的自然没了
    byPair.clear()
    for (const r of d.rows) byPair.set(r.pair.toUpperCase(), r)
    version.value++
    error.value = ''
  } catch (e) {
    if (!stopped) error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** 把缓冲里的增量一次刷进表，然后触发一次重算（一帧最多一次） */
function flushPending(): void {
  flushRaf = 0
  if (!pending.size) return
  let hit = 0
  for (const [pair, u] of pending) {
    const row = byPair.get(pair)
    if (!row) continue
    row.last = u.last
    row.change24hPct = u.change24hPct
    row.high24h = u.high24h
    row.low24h = u.low24h
    row.volume24h = u.volume24h
    row.quoteVolume24h = u.quoteVolume24h
    hit++
  }
  pending.clear()
  if (hit) version.value++
}

/**
 * 一批增量：只认表里已有的币（非永续 / 非 USDT 的自然被挡在外面）。
 *
 * ⚠️ **不在这一帧就刷** —— 先按 `pair` 缓冲，攒到下一帧由 `flushPending()` 统一刷。
 * 这样同一帧里到达的多批只会触发一次 `version++`（一次 computed 重算 + 一次 vdom diff）。
 */
function applyBatch(updates: TickerPatch[]): void {
  let hit = 0
  for (const u of updates) {
    const pair = u.pair.toUpperCase()
    // 不是表里的币（非永续 / 非 USDT）直接丢，别占缓冲
    if (!byPair.has(pair)) continue
    pending.set(pair, u)
    hit++
  }
  if (!hit) return
  lastEventAt = Date.now()
  if (!flushRaf) flushRaf = requestAnimationFrame(flushPending)
}

/** 推送断了就 REST 顶一会儿（没断就把兜底关掉） */
function checkAlive(): void {
  if (Date.now() - lastEventAt > STALE_MS) {
    if (!fallbackTimer) {
      console.warn('[行情] 实时推送断了一会儿，临时改用轮询')
      fallbackTimer = setInterval(
        () => void loadSnapshot(),
        props.intervalMs ?? 5000
      )
    }
  } else if (fallbackTimer) {
    clearInterval(fallbackTimer)
    fallbackTimer = null
  }
}

/** 页签藏了就停：不该在后台一直推 / 一直打接口 */
function start(): void {
  if (stopped) return
  if (!unsubscribe) {
    lastEventAt = Date.now()
    /*
     * 第二个参数是「流断够了时间又连回来」的回调（切后台回来 / 看门狗收掉僵尸连接）：
     * 中间漏掉的增量**不追了**，直接重拉一次整表最省事。
     */
    unsubscribe = tickerStream(applyBatch, () => void loadSnapshot())
  }
  if (!aliveTimer) aliveTimer = setInterval(checkAlive, 5000)
  if (!resyncTimer)
    resyncTimer = setInterval(() => void loadSnapshot(), RESYNC_MS)
}

function stop(): void {
  // 排队的刷新和缓冲都作废：回来时 `sync()` 会重新拉整表，不差这几条
  if (flushRaf) cancelAnimationFrame(flushRaf)
  flushRaf = 0
  pending.clear()
  unsubscribe?.()
  unsubscribe = null
  if (aliveTimer) clearInterval(aliveTimer)
  aliveTimer = null
  if (fallbackTimer) clearInterval(fallbackTimer)
  fallbackTimer = null
  if (resyncTimer) clearInterval(resyncTimer)
  resyncTimer = null
}

/**
 * 该干活吗：**这一格正被看着** + 页面在前台。
 *
 * 两个条件缺一个都停：切到别的 tab 不该继续收推送，手机锁屏 / 切后台也不该。
 *
 * ⚠️ 前台判断走 `isForeground()`，**不是** `document.hidden`：原生壳里切后台 /
 *    锁屏不一定发 `visibilitychange`；就算发了，`document.hidden` 也可能回不到
 *    false（机型差异，详见 `live.ts` 顶部）。
 */
function shouldRun(): boolean {
  return props.active !== false && isForeground()
}

/** 状态变了就重新对齐（切 tab / 切后台 / 页面切回前台都会走到这） */
function sync(): void {
  if (stopped) return
  /*
   * ⚠️ 置顶要**在外面**拉，不能塞进 `shouldRun()` 那个分支里。
   * `shouldRun()` 还要求「页面在前台」，而后台判定（`isForeground()`）在有些环境里
   * 恒为 false（实测：VS Code 内置浏览器 `document.hidden` 一直是 true）——
   * 放进去的话那一格永远拿不到置顶（列表倒是正常，因为下面 `!byPair.size` 会补一次
   * 快照，于是现象特别迷惑：币都看得到、就是星全是灰的）。
   * 一发 GET 很小，跟「要不要收实时推送」是两回事。
   */
  void loadPins()
  if (shouldRun()) {
    // 回来先补一次全表：中间漏掉的增量不追了，直接拿最新的
    void loadSnapshot()
    start()
    return
  }
  stop()
  /*
   * ⚠️ 这儿**不能直接不管**：要是页面一打开就是后台（或在隐藏的 tab 里打开），
   * 一次都不拉表的话这一格永远是空的 —— 等用户切过来才补，第一眼就是「共 0 个合约」。
   * 所以没数据时补一次快照（只有一次，不会跟轮询一样没完没了）。
   */
  if (!byPair.size) void loadSnapshot()
}

watch(() => props.active, sync)

let bodyRO: ResizeObserver | null = null
/** 前台变化的取消函数：组件卸载时必须调，否则监听会一直挂着 */
let offForeground: (() => void) | null = null

onMounted(() => {
  sync()
  /*
   * 前后台翻转就重新对齐。
   *
   * ⚠️ 走 `onForegroundChange` 而不是自己听 `visibilitychange`：后者只覆盖 Web
   *    标签页级别，原生壳切后台 / 锁屏不一定发（见 `live.ts`）。
   */
  offForeground = onForegroundChange(sync)
  if (bodyEl.value && typeof ResizeObserver !== 'undefined') {
    bodyRO = new ResizeObserver(() => measureScrollbar())
    bodyRO.observe(bodyEl.value)
  }
  void nextTick(measureScrollbar)
})

onBeforeUnmount(() => {
  stopped = true
  stop() // 里面会取消排队的刷新 / 清掉缓冲
  offForeground?.()
  offForeground = null
  bodyRO?.disconnect()
  bodyRO = null
})

/* ---------------- 图标 ---------------- */

/** 这个币的图标拉不到？→ 用首字母圆形占位 */
const iconFailed = (base: string): boolean => failed.value.includes(base)

function markIconFailed(base: string): void {
  if (!failed.value.includes(base)) failed.value = [...failed.value, base]
}

/** 占位圆的颜色由币种名算出来（同一个币永远同一个色） */
function letterColor(base: string): string {
  let h = 0
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) % 360
  return `hsl(${h} 52% 38%)`
}

/* ---------------- 置顶（每个用户最多 5 个） ---------------- */

/**
 * 用户 2026-10-04：「合约行情添加币种置顶功能最多 5 个，**无视排行和用户绑定**」。
 *
 * · 存库里（`/api/pins`），所以换设备 / 重装 app 都还在
 * · 置顶的**永远排在最前**，当前的排序和搜索只决定它们**之后**那一段
 * · 置顶的币**不受「行情过滤」影响** —— 那是手选的，成交额再小也给显示
 *   （搜索还是会过它，搜索是「我要找这个」，不该被置顶挡住）
 */
const pins = ref<string[]>([])
const pinMax = ref(5)
/** 星号操作的提示（超上限 / 失败） */
const pinTip = ref('')
const pinBusy = ref('')

const pinSet = computed(() => new Set(pins.value))
const isPinned = (base: string): boolean => pinSet.value.has(base)

async function loadPins(): Promise<void> {
  try {
    const r = await fetchPins()
    pins.value = r.pins
    pinMax.value = r.max
  } catch {
    /* 未登录 / 网络问题：当没有置顶，不影响看行情 */
  }
}

function flashPinTip(text: string, ms = 3200): void {
  pinTip.value = text
  window.setTimeout(() => {
    if (pinTip.value === text) pinTip.value = ''
  }, ms)
}

async function onTogglePin(base: string): Promise<void> {
  if (pinBusy.value) return
  pinBusy.value = base
  try {
    const r = await togglePin(base)
    pins.value = r.pins
    pinMax.value = r.max
    pinTip.value = ''
  } catch (e) {
    flashPinTip((e as Error).message)
  } finally {
    pinBusy.value = ''
  }
}

/* ---------------- 排序 / 筛选 ---------------- */

/**
 * 过了「行情过滤」的（**不含搜索**）。
 *
 * ⚠️ 下面 `shown` 必须 `[...filtered.value]` 再排 —— 不能就地 `sort` 这个 computed
 * 的返回值，那是它自己的缓存数组，就地排会把这个 computed 改脏。
 */
const filtered = computed<MarketRow[]>(() => {
  void version.value // 增量改的是 Map 里的对象（非响应式），靠这个版本号触发重算
  /*
   * 配置里的「行情过滤」：24h 成交额低于阀值的合约直接不列（搜也不给）。
   * 阈值是「百万 USDT」× 1e6；`0` = 不过滤。没成交额（null）的当 0，照样会被滤掉。
   * ⚠️ **置顶的不受这个阀值限制** —— 那是用户自己手选的，再小也要看得见。
   */
  const floor = marketMinVolUsd.value
  const list = [...byPair.values()]
  if (floor <= 0) return list
  return list.filter(r => (r.quoteVolume24h ?? 0) >= floor || isPinned(r.base))
})

/**
 * 置顶那一小段：按**置顶顺序**排（不参与当前排序）。
 * 只看 `filtered` 里现存的 —— 下架 / 还没拉到的就不显示，不造空行。
 */
const pinned = computed<MarketRow[]>(() => {
  if (!pins.value.length) return []
  const found = new Map<string, MarketRow>()
  for (const r of filtered.value) if (isPinned(r.base)) found.set(r.base, r)
  return pins.value
    .map(b => found.get(b))
    .filter((r): r is MarketRow => Boolean(r))
})

/** 其余那些（按当前排序 / 搜索排好），**不含置顶的** */
const rest = computed<MarketRow[]>(() => {
  const base = pinned.value.length
    ? filtered.value.filter(r => !isPinned(r.base))
    : filtered.value
  const q = keyword.value.trim().toUpperCase()
  if (q) {
    // 搜索时不切榜单：按成交额排，找币最顺
    return base
      .filter(r => r.base.includes(q))
      .sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
  }
  const desc = sortDir.value === 'desc'
  // 两列都是**全量排序**（不再按涨/跌筛掉一半）：涨跌幅升序就是「跌得最狠的在前」
  const field = (r: MarketRow) =>
    (sortKey.value === 'volume' ? r.quoteVolume24h : r.change24hPct) ?? 0
  return [...base].sort((a, b) => {
    const d = field(b) - field(a)
    return desc ? d : -d
  })
})

/**
 * 最后看到的顺序 = **置顶的（按置顶顺序）** + 其余（按当前排序）。
 * 用户说的「无视排行」就是这个意思。
 *
 * ⚠️ 搜索时置顶的**也要过一遍搜索** —— 否则搜「SOL」结果里最上面冒出 BTC，
 *    看着像搜索坏了。
 */
const shown = computed<MarketRow[]>(() => {
  const q = keyword.value.trim().toUpperCase()
  const head = q ? pinned.value.filter(r => r.base.includes(q)) : pinned.value
  return [...head, ...rest.value]
})

const total = computed(() => shown.value.length)
const visible = computed(() => shown.value.slice(0, MAX_ROWS))

/*
 * ⚠️ 2026-10-04：**「空闲时把一批币的 K 线提前取好」整块删掉了**
 *（原来这里有 `warmTargets` / `warmKey` / 一个 5 秒节流的 watch，向父组件 emit `warm`）。
 *
 * 那是「后端还没有 K 线缓存」年代的做法。现在后端有常驻缓存
 *（`backend/src/data/kline-store.ts`）并在**启动时**把「成交额前 60 ∪ 异动」
 * 预热带好（`server.ts` 的 `warmCandlesCache`），前端再暖一遍只是**重复劳动**：
 * 服务器每个 2ms 命中，但 60 个币 × 250 根 ≈ **1.5MB 白传给浏览器** ——
 * 一进 `/contracts` 一个都还没点，先下 1.5MB。
 * 用户 2026-10-04：「前端为什么要请求这么多 candles」。
 *
 * 现在只有「**真点了某一行**」才发一次请求（`@pick` → `prefetchSymbol`）。
 */

/* 总数要报给父组件（它拿去做标题右侧的「共 N 个合约」） */
watch(total, n => emit('count', n), {immediate: true})

// 行数变了（滚动条可能出现 / 消失）、尺寸变了，都要重新量一下滚动条宽度
watch(visible, () => void nextTick(measureScrollbar))

/* ---------------- 格式化 ---------------- */

/** 价格：按量级定小数位（跟图上的价格轴同一套规则） */
const priceText = (v: number | null): string =>
  v === null ? '—' : fmt(v, decimalsFor(v))

/** 成交额：中文量级，别糊一长串 */
function bigText(v: number | null): string {
  if (v === null) return '—'
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`
  return fmt(v, 0)
}

function pctText(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

const toneOf = (v: number | null): string =>
  v === null ? 'dim' : v >= 0 ? 'up' : 'down'
</script>

<template>
  <div class="mkt">
    <!-- 搜索：榜单按钮（成交额 / 涨幅 / 跌幅）已按用户要求删掉，排序全在表头上 -->
    <div class="mkt-bar">
      <input
        v-model="keyword"
        class="mkt-search"
        placeholder="搜币种，如 BTC"
      />
    </div>

    <!-- 星号操作的提示（超上限等）；点一下关掉 -->
    <p v-if="pinTip" class="mkt-tip" @click="pinTip = ''">{{ pinTip }}</p>

    <div v-if="error" class="error">{{ error }}</div>

    <!--
      表头 / 表身分成**两层**（用户：「吸顶效果不好，改为布局」）：
      上面一层不滚、下面一层自己滚 —— 比 `position: sticky` 稳（不会抖动、不会被行盖住）。
      ⚠️ 两层是两张独立的表，靠**同一个 colgroup** 保证列宽一致；
      表身右边有滚动条会窄一点，所以表头补上等宽的右内边距（`sbw` 实时量，
      覆盖式滚动条的平台量出来是 0）。
    -->
    <div class="mkt-table">
      <div class="mkt-head" :style="{paddingRight: sbw + 'px'}">
        <table class="table fixed">
          <colgroup>
            <!--
              列宽写在 CSS 里（`.c-base` / `.c-last` / `.c-chg`）——
              窄屏要另给一套（最新价 / 涨跌幅用固定像素，剩下的全给币种，
              见 style.css 里 `.split.m-market` 那段）。
              ⚠️ 表头 / 表身是两张独立的表，**两处 colgroup 必须写成一模一样**。
            -->
            <col class="c-base" />
            <col class="c-last" />
            <col class="c-chg" />
          </colgroup>
          <thead>
            <tr>
              <!--
                币种这格现在装着 24h 成交额，所以「按成交额排」的箭头挂在这儿
                （它是默认排序，所以这排箭头一进页就是亮着的）。
                ⚠️ 箭头必须包成 `<button>` 再挂 @click，**不能直接挂 `<svg>`** ——
                SVG 默认只在自己**画出来的那块** 响应指针，三角形旁边一圈是死的，
                手指稍偏一点就「点了没反应」（用户：「点击切换没有生效」）。
              -->
              <th class="sortable vol" :class="{on: sortKey === 'volume'}">
                <span class="scell">
                  <!--
                    表头文案：用户 2026-10-04「币种改为 币种/市值/成交量」——
                    这一格现在装着三样东西（币种名 / 市值排名 / 24h 成交额），
                    表头把它们一次说清。
                    ⚠️ 得能截断：窄屏（320px）这格只剩 142px，八个汉字放不下 ——
                      给 `.s-label` 上 overflow+ellipsis，让它先缩，排序箭头保住。
                  -->
                  <span class="s-label" @click="sortBy('volume')"
                    >币种/市值/成交量</span
                  >
                  <span class="sarr">
                    <button
                      type="button"
                      class="sbtn"
                      :class="{on: sortKey === 'volume' && sortDir === 'asc'}"
                      aria-label="按 24h 成交额升序（从小到大）"
                      title="按 24h 成交额从小到大"
                      @click="setSort('volume', 'asc')"
                    >
                      <svg viewBox="0 0 10 6" aria-hidden="true">
                        <path d="M5 .4 9.6 5.6H.4z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="sbtn"
                      :class="{on: sortKey === 'volume' && sortDir === 'desc'}"
                      aria-label="按 24h 成交额降序（从大到小）"
                      title="按 24h 成交额从大到小"
                      @click="setSort('volume', 'desc')"
                    >
                      <svg viewBox="0 0 10 6" aria-hidden="true">
                        <path d="M5 5.6.4.4h9.2z" />
                      </svg>
                    </button>
                  </span>
                </span>
              </th>
              <th class="r">最新价</th>
              <th class="r sortable" :class="{on: sortKey === 'change'}">
                <span class="scell">
                  <span class="s-label" @click="sortBy('change')">涨跌幅</span>
                  <span class="sarr">
                    <button
                      type="button"
                      class="sbtn"
                      :class="{on: sortKey === 'change' && sortDir === 'asc'}"
                      aria-label="涨跌幅升序（跌得最狠在前）"
                      @click="setSort('change', 'asc')"
                    >
                      <svg viewBox="0 0 10 6" aria-hidden="true">
                        <path d="M5 .4 9.6 5.6H.4z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="sbtn"
                      :class="{on: sortKey === 'change' && sortDir === 'desc'}"
                      aria-label="涨跌幅降序（涨得最多在前）"
                      @click="setSort('change', 'desc')"
                    >
                      <svg viewBox="0 0 10 6" aria-hidden="true">
                        <path d="M5 5.6.4.4h9.2z" />
                      </svg>
                    </button>
                  </span>
                </span>
              </th>
            </tr>
          </thead>
        </table>
      </div>

      <div ref="bodyEl" class="mkt-body">
        <table class="table fixed">
          <colgroup>
            <!-- 和表头那组**必须一模一样**，否则表头跟表身对不上 -->
            <col class="c-base" />
            <col class="c-last" />
            <col class="c-chg" />
          </colgroup>
          <tbody>
            <tr v-if="!visible.length">
              <td colspan="3" class="empty">
                {{ error ? '拉不到行情' : '没有匹配的合约' }}
              </td>
            </tr>
            <tr
              v-for="(r, i) in visible"
              :key="r.symbol"
              class="mkt-row"
              :class="{
                on: r.base === symbol.toUpperCase(),
                pin: isPinned(r.base),
                // 置顶那一段和后面之间来一条分界线（第一行没有前一行，跳过）
                sep:
                  i > 0 && isPinned(visible[i - 1]!.base) && !isPinned(r.base)
              }"
              :title="`切到 ${r.base}`"
              @click="emit('pick', r.base)"
            >
              <td class="s">
                <span class="icell">
                  <!--
                    置顶那颗星：在图标左边，**点它只切置顶、不切币种**（@click.stop）。
                    ⚠️ 用 SVG 而不是 ★ 字符 —— 字形在不同机型宽度不一样，会把图标挤歪。
                  -->
                  <button
                    type="button"
                    class="pin-b"
                    :class="{on: isPinned(r.base)}"
                    :disabled="pinBusy === r.base"
                    :aria-label="
                      isPinned(r.base) ? `取消置顶 ${r.base}` : `置顶 ${r.base}`
                    "
                    :title="
                      isPinned(r.base)
                        ? '取消置顶'
                        : `置顶（最多 ${pinMax} 个，不受排行影响）`
                    "
                    @click.stop="onTogglePin(r.base)"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z"
                      />
                    </svg>
                  </button>
                  <img
                    v-if="!iconFailed(r.base)"
                    class="ico"
                    :src="iconUrl(r.base)"
                    alt=""
                    loading="lazy"
                    @error="markIconFailed(r.base)"
                  />
                  <span
                    v-else
                    class="ico ico-letter"
                    :style="{background: letterColor(r.base)}"
                  >
                    {{ r.base.slice(0, 1) }}
                  </span>
                  <!--
                    币名 + 成交额共用一个两行文本框（用户 2026-10-04：
                    「图标大一点 成交额和币种放在一起」）。
                    ⚠️ 两行都得能截断，所以每行各自 `overflow: hidden`，
                      外面这层只负责 `min-width: 0`（flex 子项的默认 min-width 是 auto，
                      不写就把整格顶宽）。
                  -->
                  <span class="icell-txt">
                    <span class="icell-t">{{ r.base }}</span>
                    <!--
                      第二行：市值排名 + 成交额。
                      用户 2026-10-04：「24h 替换成市值排名 如 no.1」——
                      原来的「24h 34.21亿」换成「No.1 · 34.21亿」。
                      `rank` 是后端从 CoinGecko 贴过来的（见 data/marketcap.ts）；
                      前 500 名之外的币没有这个数，那就退回去只显示成交额。
                    -->
                    <span class="icell-v">
                      <b v-if="r.rank" class="cap-rank">No.{{ r.rank }}</b>
                      <span v-if="r.rank" class="cap-sep">·</span>
                      <span class="cap-vol">{{
                        bigText(r.quoteVolume24h)
                      }}</span>
                    </span>
                  </span>
                </span>
              </td>
              <td class="r num">{{ priceText(r.last) }}</td>
              <td class="r num">
                <!-- 24h 涨跌幅：包一层色块，像交易所那样一眼能扫（用户：加上背景） -->
                <span class="chg" :class="toneOf(r.change24hPct)">
                  {{ pctText(r.change24hPct) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
