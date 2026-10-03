/**
 * 页面配置 + 「K 线显示多少根」。
 *
 * 配置两条：
 *  1. `keepChartZoom` —— 保持 K 线缩放样式（**默认打开**）
 *  2. `chartBars` —— 上一个用过的根数
 *
 * ⚠️ `chartBars` 是**全局一份、所有币种共用**（用户 2026-10-03：
 * 「保持 k 线缩放的根数是所有币种都要」）。
 * 以前是「每个币各记一段 {from,to}」，结果一个币一个样：没看过的币又回到默认那屏。
 * 现在只记**根数**这一个数 —— 在哪个币上缩到多少根，切到别的币也是这么多根，
 * 右边缘始终贴齐最新一根（留 `RIGHT_GAP` 格空档）。
 *
 * 跟着 localStorage 走。
 */
import {computed, ref, watch} from 'vue'

const KEY = 'ca-settings-v2'
/**
 * 旧键。里面那个「每个币各记一段」的 `chartWindows` **不迁移**（两个原因）：
 *  ① 它是按币种分存的，跟现在「全局一份」不是一回事；
 *  ② KlineChart 当时在「换币」那个 watcher 里读的是 `props.symbol`，而回调跑起来时
 *     它已经是**新币**了 —— 于是**旧币**的可见区间被写到新币名下（换过去只在最右边
 *     露出十几根、看着像空图）。里面全是脏数据。
 * 所以只把 `keepChartZoom` 这个开关搬过来。
 */
const OLD_KEY = 'ca-settings-v1'

interface Stored {
  keepChartZoom?: boolean
  /** 所有币种共用的显示根数 */
  chartBars?: number
  /** 行情过滤：24h 成交额低于这个数（**百万 USDT**）的合约不显示。0 = 不过滤 */
  marketMinVolM?: number
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Stored
      // 只取认得的字段 —— 旧的 `chartWindows` 别跟着写回去
      return {
        keepChartZoom: v.keepChartZoom,
        chartBars: v.chartBars,
        marketMinVolM: v.marketMinVolM
      }
    }
    // 第一次跑：从 v1 只捡开关
    const old = localStorage.getItem(OLD_KEY)
    if (!old) return {}
    const prev = JSON.parse(old) as Stored
    return {keepChartZoom: prev.keepChartZoom}
  } catch {
    // 无痕模式 / 被禁用，读取会抛，当没有配置
    return {}
  }
}

const saved = read()

/**
 * 「保持 K 线缩放样式」。
 *
 * 打开：图上显示多少根**全局共用**（见 `chartBars`）—— 换币 / 换周期 / 切页回来都一样。
 * 关掉：老行为 —— 每次重画都铺默认那一屏（`DEFAULT_BARS`）。
 *
 * ⚠️ 「看某一刻」（把某一根摆中间）是用户明确点的动作，**以它为准**。
 */
export const keepChartZoom = ref(saved.keepChartZoom !== false)

/**
 * 所有币种共用的「显示多少根」。`0` = 还没缩过 → 图那边用 `DEFAULT_BARS`。
 *
 * 太窄的（拖到极限那种一条缝）不记，否则切一个币就只剩几根。
 */
export const MIN_SAVED_BARS = 5
export const chartBars = ref(saved.chartBars ?? 0)

/**
 * 「行情过滤」：24h 成交额**低于**这个数（单位：**百万 USDT**）的合约，
 * 合约行情列表里就不显示。`0` = 不过滤（默认）。
 *
 * 用户 2026-10-03：「行情过滤 可以配置 24h 成交多少 m，大于这个数合约行情才显示」。
 * ⚠️ 只影响**行情列表**（和它标题右边的总数），不影响 K 线 / 分析取数。
 */
export const marketMinVolM = ref(Math.max(0, saved.marketMinVolM ?? 0))

/** 阈值换算成 USDT 原值（列表那边直接比） */
export const marketMinVolUsd = computed(() => marketMinVolM.value * 1e6)

/** 图上现在显示多少根（实时，来自图上报的可见区间；只给配置面板看） */
export const shownBars = ref(0)
/** 这是哪个币 · 哪个周期（`BTC · 1h`） */
export const shownKey = ref('')

/** 图上报一次「我现在显示 N 根 / 是哪个币 · 哪个周期」 */
export function rememberShown(n: number, key: string): void {
  if (Number.isFinite(n) && n > 0) shownBars.value = Math.round(n)
  shownKey.value = key
}

/**
 * 存下「现在显示多少根」（全局一份）。
 *
 * 调用时机（用户说的「在关闭 K 线图或者切换 K 线图保存」）：
 * 换币 / 换周期 / 切走这一格 / 组件销毁 —— 见 `KlineChart` 里那几处。
 */
export function saveChartBars(n: number | null | undefined): void {
  if (!Number.isFinite(n) || !n || n < MIN_SAVED_BARS) return
  const v = Math.round(n)
  if (v === chartBars.value) return // 没变就别写 localStorage
  chartBars.value = v
}

watch(
  [keepChartZoom, chartBars, marketMinVolM],
  () => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          keepChartZoom: keepChartZoom.value,
          chartBars: chartBars.value,
          marketMinVolM: marketMinVolM.value
        })
      )
    } catch {
      // 写不了就算了，不影响用
    }
  },
  {deep: true}
)
