/**
 * 页面配置 + 「每个币看的是哪一段 K 线」。
 *
 * 配置目前只有一条：`keepChartZoom` 保持 K 线缩放样式 —— **默认打开**。
 *
 * 打开时的意思（用户 2026-10-03 定的）：每张图都显示**这个币上次看到的那段范围** ——
 * 换币 / 换周期 / 切页回来，回到某个币还是它自己那段。
 * **不是**「选一个显示多少根」的档位，而是「当前币种查看的效果」：
 * 换币 / 关掉 / 切走这一格时自动存，回来还原。
 *
 * 所以存的是 `chartWindows: { 'BTC@1h': {from, to} }`，跟着 localStorage 走。
 */
import {ref, watch} from 'vue'

const KEY = 'ca-settings-v2'
/**
 * 旧键。里面的 `chartWindows` **全是错的**，不迁移：
 * KlineChart 以前在「换币」那个 watcher 里读的是 `props.symbol`，
 * 而回调跑起来时它已经是**新币**了 —— 于是**旧币**的可见区间被写到新币名下。
 * 症状：切过去只在最右边露出十几根（看着像空图）、新币再也拿不到默认那一屏。
 * 所以 v1 → v2 只把 `keepChartZoom` 这个开关搬过来，区间全部丢弃重记。
 */
const OLD_KEY = 'ca-settings-v1'

/** 图上当前那段可见区间（按「第几根到第几根」记，跟具体时间 / 价格无关） */
export interface ChartWindow {
  from: number
  to: number
}

interface Stored {
  keepChartZoom?: boolean
  chartWindows?: Record<string, ChartWindow>
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Stored
    // 第一次跑 v2：从 v1 只捡开关，区间不带过来
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
 * 打开：每个币（+ 周期）各记一段，回来照它还原（见 `chartWindows`）。
 * 关掉：老行为 —— 每次重画都把最近一段铺满。
 *
 * ⚠️ 「看某一刻」（把某一根摆中间）是用户明确点的动作，**以它为准**，
 *    点完也会把那段存进对应币种。
 */
export const keepChartZoom = ref(saved.keepChartZoom !== false)

/** `BTC@1h` → 那段范围 */
export const chartWindows = ref<Record<string, ChartWindow>>(
  saved.chartWindows ?? {}
)

/** 键：**只按币种** —— 用户 2026-10-03：「切换周期也算 保留当前查看的多少根 k」。
 *  所以换个周期回来，看的还是同样多根；每个币各记一段。 */
export const windowKey = (symbol: string): string => symbol.trim().toUpperCase()

/** 取这个币记下的那段（没记过就是 null） */
export function getChartWindow(symbol: string): ChartWindow | null {
  return chartWindows.value[windowKey(symbol)] ?? null
}

/**
 * 存下「这个币现在看到的那段」。
 *
 * 调用时机（用户说的「在关闭 K 线图或者切换 K 线图保存」）：
 * 换币 / 换周期 / 切走这一格 / 页面切后台 / 组件销毁 —— 见 `KlineChart` 里那几处。
 * 太窄的（拖到极限那种一条缝）不记，否则下次回到这个币就只剩几根。
 */
export function saveChartWindow(
  symbol: string,
  w: ChartWindow | null | undefined
): void {
  if (!symbol.trim()) return
  if (!w || !Number.isFinite(w.from) || !Number.isFinite(w.to)) return
  if (w.to - w.from < 5) return
  const key = windowKey(symbol)
  const cur = chartWindows.value[key]
  // 跟记着的差不多就别动（省得每次切都写 localStorage）
  if (cur && Math.abs(cur.from - w.from) < 1 && Math.abs(cur.to - w.to) < 1)
    return
  chartWindows.value = {...chartWindows.value, [key]: {from: w.from, to: w.to}}
}

/* ---------------- 配置面板要显示的那点信息 ---------------- */

/** 当前图上显示多少根（实时，来自图上报的可见区间） */
export const shownBars = ref(0)
/** 这是哪个币 · 哪个周期（`BTC · 1h`） */
export const shownKey = ref('')

/** 图上报一次「我现在显示 N 根 / 是哪个币」*/
export function rememberShown(n: number, key: string): void {
  if (Number.isFinite(n) && n > 0) shownBars.value = Math.round(n)
  shownKey.value = key
}

/** 已经记住几个币（配置面板给用户看个数） */
export const rememberedCount = (): number =>
  Object.keys(chartWindows.value).length
watch(
  [keepChartZoom, chartWindows],
  () => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          ...read(),
          keepChartZoom: keepChartZoom.value,
          chartWindows: chartWindows.value
        })
      )
    } catch {
      // 写不了就算了，不影响用
    }
  },
  {deep: true}
)
