<script setup lang="ts">
/**
 * 合约行情（参考币安「合约行情」页）。
 *
 * 一屏把全市场看一遍：
 *   · 币种（带图标）/ 最新价 / 24h 涨跌 / 24h 成交额
 *   · 顶部三档榜单（成交额 / 涨幅 / 跌幅）+ 搜索框筛币种
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
import SegTabs from './SegTabs.vue'
import {
  fetchMarkets,
  iconUrl,
  tickerStream,
  type MarketRow,
  type TickerPatch
} from '../api'
import {decimalsFor, fmt} from '../format'

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

const emit = defineEmits<{(e: 'pick', base: string): void}>()

const MAX_ROWS = 120
/** 好久没收到 SSE 就认为推送断了，改用 REST 顶一会儿 */
const STALE_MS = 15_000
/** 全表重拉（检新上市 / 下架的币） */
const RESYNC_MS = 5 * 60_000

const BOARDS = [
  {value: 'volume', label: '成交额'},
  {value: 'up', label: '涨幅'},
  {value: 'down', label: '跌幅'}
]

const board = ref<'volume' | 'up' | 'down'>('volume')
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
const updatedAt = ref(0)
const loading = ref(false)
const error = ref('')

/** 没有图标的币（退回首字母圆形占位） */
const failed = ref<string[]>([])

/** 「更新于 x 秒前」要自己跳秒，不然看着像卡住了 */
const nowTick = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

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
  updatedAt.value = lastEventAt
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
  clock = setInterval(() => (nowTick.value = Date.now()), 1000)
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
  if (clock) clearInterval(clock)
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
  const list = [...byPair.values()]
  if (q) {
    // 搜索时不切榜单：按成交额排，找币最顺
    return list
      .filter(r => r.base.includes(q))
      .sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
  }
  if (board.value === 'up') {
    return list
      .filter(r => (r.change24hPct ?? 0) > 0)
      .sort((a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0))
  }
  if (board.value === 'down') {
    return list
      .filter(r => (r.change24hPct ?? 0) < 0)
      .sort((a, b) => (a.change24hPct ?? 0) - (b.change24hPct ?? 0))
  }
  // 成交额榜：实时值在变，每次都重排（几百行，一秒一次没压力）
  return list.sort((a, b) => (b.quoteVolume24h ?? 0) - (a.quoteVolume24h ?? 0))
})

const total = computed(() => shown.value.length)
const visible = computed(() => shown.value.slice(0, MAX_ROWS))

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

const agoText = computed(() => {
  if (!updatedAt.value) return ''
  const s = Math.max(0, Math.round((nowTick.value - updatedAt.value) / 1000))
  return s <= 1 ? '刚刚更新' : `${s} 秒前更新`
})
</script>

<template>
  <div class="mkt">
    <!-- 榜单 + 搜索 -->
    <div class="mkt-bar">
      <SegTabs v-model="board" :options="BOARDS" />
      <input
        v-model="keyword"
        class="mkt-search"
        placeholder="搜币种，如 BTC"
      />
    </div>

    <div class="mkt-meta">
      <span>共 {{ total }} 个合约</span>
      <span class="dim">{{ agoText }}</span>
      <button class="ghost tiny" :disabled="loading" @click="loadSnapshot">
        刷新
      </button>
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
              <th class="r">涨跌幅</th>
              <th class="r">成交额</th>
            </tr>
          </thead>
        </table>
      </div>

      <div ref="bodyEl" class="mkt-body">
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
