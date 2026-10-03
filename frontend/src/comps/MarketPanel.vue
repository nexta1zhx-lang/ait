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
 *      每秒一批、每批只含刚变过的两三百个币），按 `pair` 盖到那行上
 *   3. 兜底：SSE 静默超 15 秒（后端上游也挂了）才临时开 REST 轮询；
 *      每 5 分钟重新拉一次全表，把新上的币检进来
 *
 * 只渲染前 `MAX_ROWS` 行：币安 USDT 本位有 500+ 个合约，
 * 全塞进 DOM 里每秒重绘一次会让滑动发涩 —— 搜索/排序仍然吃全量数据。
 */
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {
  fetchMarkets,
  iconUrl,
  tickerStream,
  type MarketRow,
  type TickerPatch
} from '../api'
import {decimalsFor, fmt} from '../format'
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

/**
 * 手机端下滑时把搜索框收起来（用户：「移动端下滑搜索框自动收起」）。
 *
 * 只看**方向**：往下滑过几像素就收，往上滑、或者滑回顶部就放 ——
 * 不看绝对位置（“滚到 200px 以下就藏”那种，往上滑时还得先滑到底才肯出来，很难用）。
 * 加个 6px 的容差：手指停住时的抖动不该让它来回抽。
 *
 * 样式只在窄屏生效（见 `style.css` 的 `@media (max-width: 900px)`），
 * 所以这里的 `compact` 在桌面端不会造成任何变化。
 */
const compact = ref(false)
let lastTop = 0

function onListScroll(e: Event): void {
  const y = (e.target as HTMLElement).scrollTop
  if (y <= 8 || y < lastTop - 6) compact.value = false
  else if (y > lastTop + 6) compact.value = true
  lastTop = y
}

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

/** 一批增量：只认表里已有的币（非永续 / 非 USDT 的自然被挡在外面） */
function applyBatch(updates: TickerPatch[]): void {
  let hit = 0
  for (const u of updates) {
    const row = byPair.get(u.pair.toUpperCase())
    if (!row) continue
    row.last = u.last
    row.change24hPct = u.change24hPct
    row.high24h = u.high24h
    row.low24h = u.low24h
    row.volume24h = u.volume24h
    row.quoteVolume24h = u.quoteVolume24h
    hit++
  }
  if (!hit) return
  lastEventAt = Date.now()
  version.value++
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
    unsubscribe = tickerStream(applyBatch)
  }
  if (!aliveTimer) aliveTimer = setInterval(checkAlive, 5000)
  if (!resyncTimer)
    resyncTimer = setInterval(() => void loadSnapshot(), RESYNC_MS)
}

function stop(): void {
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
 * 两个条件缺一个都停：切到别的 tab 不该继续收推送，手机锁屏/切后台也不该。
 */
function shouldRun(): boolean {
  return props.active !== false && !document.hidden
}

/** 状态变了就重新对齐（切 tab / 切后台 / 页面切回前台都会走到这） */
function sync(): void {
  if (stopped) return
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

onMounted(() => {
  sync()
  document.addEventListener('visibilitychange', sync)
  if (bodyEl.value && typeof ResizeObserver !== 'undefined') {
    bodyRO = new ResizeObserver(() => measureScrollbar())
    bodyRO.observe(bodyEl.value)
  }
  void nextTick(measureScrollbar)
})

onBeforeUnmount(() => {
  stopped = true
  stop()
  bodyRO?.disconnect()
  bodyRO = null
  document.removeEventListener('visibilitychange', sync)
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

/* ---------------- 排序 / 筛选 ---------------- */

const shown = computed<MarketRow[]>(() => {
  void version.value // 增量改的是 Map 里的对象（非响应式），靠这个版本号触发重算
  const q = keyword.value.trim().toUpperCase()
  /*
   * 配置里的「行情过滤」：24h 成交额低于阀值的合约直接不列（搜也不给）。
   * 阈值是「百万 USDT」× 1e6；`0` = 不过滤。没成交额（null）的当 0，照样会被滤掉。
   */
  const floor = marketMinVolUsd.value
  let list = [...byPair.values()]
  if (floor > 0) list = list.filter(r => (r.quoteVolume24h ?? 0) >= floor)
  if (q) {
    // 搜索时不切榜单：按成交额排，找币最顺
    return list
      .filter(r => r.base.includes(q))
      .sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
  }
  const desc = sortDir.value === 'desc'
  // 两列都是**全量排序**（不再按涨/跌筛掉一半）：涨跌幅升序就是「跌得最狠的在前」
  const field = (r: MarketRow) =>
    (sortKey.value === 'volume' ? r.quoteVolume24h : r.change24hPct) ?? 0
  return list.sort((a, b) => {
    const d = field(b) - field(a)
    return desc ? d : -d
  })
})

const total = computed(() => shown.value.length)
const visible = computed(() => shown.value.slice(0, MAX_ROWS))

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
  <div class="mkt" :class="{compact}">
    <!-- 搜索：榜单按钮（成交额 / 涨幅 / 跌幅）已按用户要求删掉，排序全在表头上 -->
    <div class="mkt-bar">
      <input
        v-model="keyword"
        class="mkt-search"
        placeholder="搜币种，如 BTC"
      />
    </div>

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
            <col style="width: 30%" />
            <col style="width: 24%" />
            <col style="width: 22%" />
            <col style="width: 24%" />
          </colgroup>
          <thead>
            <tr>
              <th>币种</th>
              <th class="r">最新价</th>
              <!--
                表头直接当排序钮：点标题那几个字 = 切到这一列，点 ▲ / ▼ = 要哪个方向。
                ⚠️ 箭头必须包成 `<button>` 再挂 @click，**不能直接挂 `<svg>`** ——
                SVG 默认只在自己**画出来的那块** 响应指针，三角形旁边一圈是死的，
                手指稍偏一点就「点了没反应」（用户：「点击切换没有生效」）。
              -->
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
              <th class="r sortable" :class="{on: sortKey === 'volume'}">
                <span class="scell">
                  <span class="s-label" @click="sortBy('volume')">成交额</span>
                  <span class="sarr">
                    <button
                      type="button"
                      class="sbtn"
                      :class="{on: sortKey === 'volume' && sortDir === 'asc'}"
                      aria-label="成交额升序（从小到大）"
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
                      aria-label="成交额降序（从大到小）"
                      @click="setSort('volume', 'desc')"
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

      <div ref="bodyEl" class="mkt-body" @scroll="onListScroll">
        <table class="table fixed">
          <colgroup>
            <col style="width: 30%" />
            <col style="width: 24%" />
            <col style="width: 22%" />
            <col style="width: 24%" />
          </colgroup>
          <tbody>
            <tr v-if="!visible.length">
              <td colspan="4" class="empty">
                {{ error ? '拉不到行情' : '没有匹配的合约' }}
              </td>
            </tr>
            <tr
              v-for="r in visible"
              :key="r.symbol"
              class="mkt-row"
              :class="{on: r.base === symbol.toUpperCase()}"
              :title="`切到 ${r.base}`"
              @click="emit('pick', r.base)"
            >
              <td class="s">
                <span class="icell">
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
                  <span class="icell-t">{{ r.base }}</span>
                </span>
              </td>
              <td class="r num">{{ priceText(r.last) }}</td>
              <td class="r num">
                <!-- 24h 涨跌幅：包一层色块，像交易所那样一眼能扫（用户：加上背景） -->
                <span class="chg" :class="toneOf(r.change24hPct)">
                  {{ pctText(r.change24hPct) }}
                </span>
              </td>
              <td class="r num dim">{{ bigText(r.quoteVolume24h) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
