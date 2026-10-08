<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue'
import {
  fetchC2cOrderHistory,
  fetchExchangeAnalytics,
  fetchExchangeKeys,
  fetchRate,
  importC2cOrders,
  syncC2cOrders,
  type C2cHistoryOrder,
  type ExchangeKey,
  type ExchangeAnalytics,
  type PositionStatistics
} from '../api'
import {echarts, type ECharts} from '../chart-theme'
import {parseBinanceC2cFile} from '../binance-c2c'

/* 局部暖金与石墨色板，避免影响其它页面。 */
const P = {
  accent: '#ffc16b',
  ok: '#72d6a0',
  bad: '#ff7480',
  text: '#aaa398',
  strong: '#fff5e7',
  grid: '#382d21',
  panel: '#0d0c0b'
}

/** 暖灰底 tooltip（跟 chart-theme 的同形，只换色） */
const warmTooltip = {
  backgroundColor: 'rgba(18,16,13,.94)',
  borderColor: P.grid,
  borderWidth: 1,
  padding: [6, 10],
  textStyle: {color: P.strong, fontSize: 12},
  extraCssText: 'backdrop-filter: blur(6px); border-radius: 8px;'
}

const from = ref('')
const to = ref('')
const benchmark = ref('1000')
const currency = ref<'usd' | 'cny'>('usd')
const draftBenchmark = ref('1000')
const draftCurrency = ref<'usd' | 'cny'>('usd')
const usdCny = ref(7.1)
const rateError = ref('')
const exchangeKeys = ref<ExchangeKey[]>([])
const selectedKeyId = ref<number | null>(null)
const analytics = ref<ExchangeAnalytics | null>(null)
const positions = ref<PositionStatistics | null>(null)
const accountName = ref('')
const loading = ref(false)
const error = ref('')
const showDatePicker = ref(false)
const showConfig = ref(false)
const showC2cHistory = ref(false)
const capitalTrackEl = ref<HTMLElement | null>(null)
const capitalSlide = ref(0)
const chartTrackEl = ref<HTMLElement | null>(null)
const chartSlide = ref(0)
const chartLabels = ['ROI', 'PnL', 'DD', 'W/L', 'L/S']
const performanceTab = ref<'performance' | 'breakdown'>('performance')
const c2cHistory = ref<C2cHistoryOrder[]>([])
const c2cHistoryPage = ref(1)
const c2cHistoryTotal = ref(0)
const c2cHistoryLoading = ref(false)
const c2cHistoryError = ref('')
const c2cHistoryMessage = ref('')
const c2cImporting = ref(false)
const c2cUpdating = ref(false)
const c2cFileInput = ref<HTMLInputElement | null>(null)
const draftFrom = ref('')
const draftTo = ref('')
const beijingToday = () => new Date(Date.now() + 8 * 60 * 60 * 1000)
const calendarMonth = ref(monthStart(beijingToday()))
const roiChartEl = ref<HTMLElement | null>(null)
const dailyChartEl = ref<HTMLElement | null>(null)
const drawdownChartEl = ref<HTMLElement | null>(null)
const outcomesChartEl = ref<HTMLElement | null>(null)
const directionChartEl = ref<HTMLElement | null>(null)
const charts = new Map<string, ECharts>()
let chartObserver: ResizeObserver | null = null
let loadSequence = 0
let historySequence = 0
const c2cHistoryPageSize = 20

const selectedKey = computed(() =>
  exchangeKeys.value.find(key => key.id === selectedKeyId.value) ?? null
)
const currencyLabel = computed(() => currency.value === 'usd' ? '美元' : '人民币')
const currencySymbol = computed(() => currency.value === 'usd' ? '$' : '¥')
const dailyRows = computed(() => positions.value?.daily ?? [])
const profitableSymbols = computed(() =>
  (positions.value?.breakdown.bySymbol ?? [])
    .filter(group => group.net > 0)
    .sort((a, b) => b.net - a.net)
    .slice(0, 3)
)
const losingSymbols = computed(() =>
  (positions.value?.breakdown.bySymbol ?? [])
    .filter(group => group.net < 0)
    .sort((a, b) => a.net - b.net)
    .slice(0, 3)
)
const directionBreakdown = computed(() => positions.value?.breakdown.byDirection ?? [])
const durationBreakdown = computed(() => positions.value?.breakdown.byHoldDuration ?? [])
const compactDateRange = computed(() => {
  if (from.value && to.value) return `${displayDate(from.value)}–${displayDate(to.value)}`
  if (from.value) return `${displayDate(from.value)} 起`
  if (to.value) return `至 ${displayDate(to.value)}`
  return '全部日期'
})
const c2cHistoryPages = computed(() =>
  Math.max(1, Math.ceil(c2cHistoryTotal.value / c2cHistoryPageSize))
)
const c2cActionLoading = computed(() => c2cImporting.value || c2cUpdating.value)
const c2cHistoryStart = computed(() =>
  c2cHistoryTotal.value ? (c2cHistoryPage.value - 1) * c2cHistoryPageSize + 1 : 0
)
const c2cHistoryEnd = computed(() =>
  Math.min(c2cHistoryPage.value * c2cHistoryPageSize, c2cHistoryTotal.value)
)
const investedUsdt = computed(() => analytics.value?.capital.netUsdt ?? 0)
const capitalTone = computed(() =>
  investedUsdt.value > 0 ? 'waiting' : investedUsdt.value < 0 ? 'recovered' : 'balanced'
)
const capitalStatus = computed(() =>
  investedUsdt.value > 0
    ? '待回本'
    : investedUsdt.value < 0
      ? '已净回收'
      : '收支平衡'
)
const drawdownRows = computed(() => {
  const base = Number(benchmark.value)
  if (!(base > 0)) return []
  let equity = base
  let peak = base
  return dailyRows.value.map(row => {
    equity += row.net
    peak = Math.max(peak, equity)
    return {
      date: row.date,
      drawdown: peak > 0 ? (equity - peak) / peak * 100 : 0
    }
  })
})

const roi = computed(() => {
  const base = Number(benchmark.value)
  if (!analytics.value || !Number.isFinite(base) || base <= 0) return null
  return positions.value ? (positions.value.net / base) * 100 : null
})

const drawdownPct = computed(() => {
  const base = Number(benchmark.value)
  if (!Number.isFinite(base) || base <= 0) return null
  let equity = base
  let peak = base
  let maxDrawdown = 0
  for (const row of dailyRows.value) {
    equity += row.net
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100)
  }
  return maxDrawdown
})

const profitFactor = computed(() => {
  const trades = positions.value
  if (!trades || (trades.grossLoss <= 0 && trades.grossProfit <= 0)) return null
  if (trades.grossLoss <= 0) return Number.POSITIVE_INFINITY
  return trades.grossProfit / trades.grossLoss
})

function money(value: number, digits = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

function displayMoney(value: number, digits = 2): string {
  const converted = currency.value === 'cny' ? value * usdCny.value : value
  return `${currencySymbol.value}${money(converted, digits)}`
}

function roiValue(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function dateStart(value: string): number | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  const valueMs = Date.UTC(year, month - 1, day)
  return Number.isFinite(valueMs) ? valueMs - 8 * 60 * 60 * 1000 : null
}

function dateKey(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-')
}

function displayDate(value: string): string {
  return value ? value.replaceAll('-', '.') : ''
}

const monthLabel = computed(() =>
  `${calendarMonth.value.getUTCFullYear()}年${calendarMonth.value.getUTCMonth() + 1}月`
)

const calendarCells = computed(() => {
  const first = monthStart(calendarMonth.value)
  const mondayOffset = (first.getUTCDay() + 6) % 7
  const selectedFrom = draftFrom.value
  const selectedTo = draftTo.value
  const today = dateKey(beijingToday())
  return Array.from({length: 42}, (_, index) => {
    const date = new Date(first)
    date.setUTCDate(index - mondayOffset + 1)
    const key = dateKey(date)
    return {
      key,
      day: date.getUTCDate(),
      currentMonth: date.getUTCMonth() === first.getUTCMonth(),
      today: key === today,
      selected: key === selectedFrom || key === selectedTo,
      inRange: Boolean(selectedFrom && selectedTo && key > selectedFrom && key < selectedTo)
    }
  })
})

const activeQuickRange = computed(() => {
  if (!draftFrom.value && !draftTo.value) return 'all'
  const today = beijingToday()
  const end = dateKey(today)
  for (const days of [7, 30, 90]) {
    const start = new Date(today)
    start.setUTCDate(start.getUTCDate() - days + 1)
    if (draftFrom.value === dateKey(start) && draftTo.value === end) return `${days}`
  }
  return ''
})

function chooseQuickRange(days: number | null): void {
  if (days === null) {
    draftFrom.value = ''
    draftTo.value = ''
    calendarMonth.value = monthStart(beijingToday())
    return
  }
  const end = beijingToday()
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - days + 1)
  draftFrom.value = dateKey(start)
  draftTo.value = dateKey(end)
  calendarMonth.value = monthStart(start)
}

function shiftMonth(delta: number): void {
  const next = new Date(calendarMonth.value)
  next.setUTCMonth(next.getUTCMonth() + delta)
  calendarMonth.value = monthStart(next)
}

function chooseDate(key: string): void {
  if (!draftFrom.value || draftTo.value || key < draftFrom.value) {
    draftFrom.value = key
    draftTo.value = ''
    return
  }
  draftTo.value = key
}

function clearDateRange(): void {
  draftFrom.value = ''
  draftTo.value = ''
}

function openDatePicker(): void {
  draftFrom.value = from.value
  draftTo.value = to.value
  const initial = from.value || dateKey(beijingToday())
  const parts = initial.split('-').map(Number)
  calendarMonth.value = monthStart(new Date(Date.UTC(parts[0], parts[1] - 1, 1)))
  showDatePicker.value = true
}

function applyDateRange(): void {
  from.value = draftFrom.value
  to.value = draftTo.value
  showDatePicker.value = false
  void load()
}

function showCapitalSlide(index: number): void {
  const track = capitalTrackEl.value
  if (!track) return
  const next = Math.max(0, Math.min(1, index))
  track.scrollTo({left: next * track.clientWidth, behavior: 'smooth'})
}

function showChartSlide(index: number): void {
  const track = chartTrackEl.value
  if (!track) return
  const next = Math.max(0, Math.min(chartLabels.length - 1, index))
  track.scrollTo({left: next * track.clientWidth, behavior: 'smooth'})
}

function syncChartSlide(): void {
  const track = chartTrackEl.value
  if (!track) return
  chartSlide.value = Math.max(
    0,
    Math.min(chartLabels.length - 1, Math.round(track.scrollLeft / Math.max(1, track.clientWidth)))
  )
}

function amountTone(value: number): 'positive' | 'negative' | 'neutral' {
  return value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'
}

function durationLabel(key: 'short' | 'medium' | 'long'): string {
  if (key === 'short') return '短线'
  if (key === 'medium') return '中线'
  return '长线'
}

function syncCapitalSlide(): void {
  const track = capitalTrackEl.value
  if (!track) return
  capitalSlide.value = Math.round(track.scrollLeft / Math.max(1, track.clientWidth))
}

function openConfig(): void {
  draftBenchmark.value = benchmark.value
  draftCurrency.value = currency.value
  showConfig.value = true
}

function saveConfig(): void {
  const base = Number(draftBenchmark.value)
  if (!Number.isFinite(base) || base <= 0) {
    error.value = '收益率基准必须大于 0'
    return
  }
  benchmark.value = String(base)
  currency.value = draftCurrency.value
  try {
    localStorage.setItem('ait-account-stats-settings', JSON.stringify({
      benchmark: benchmark.value,
      currency: currency.value
    }))
  } catch (e) {
    error.value = `保存配置失败：${(e as Error).message}`
    return
  }
  error.value = ''
  showConfig.value = false
  void nextTick(renderCharts)
}

function dateEnd(value: string): number | null {
  const start = dateStart(value)
  return start === null ? null : start + 24 * 60 * 60 * 1000 - 1
}

async function load(): Promise<void> {
  if (from.value && dateStart(from.value) === null) {
    error.value = '开始日期无效'
    return
  }
  if (to.value && dateEnd(to.value) === null) {
    error.value = '结束日期无效'
    return
  }
  if (from.value && to.value && from.value > to.value) {
    error.value = '开始日期不能晚于结束日期'
    return
  }
  const sequence = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await fetchExchangeAnalytics(
      {from: dateStart(from.value), to: dateEnd(to.value)},
      selectedKeyId.value ?? undefined
    )
    if (sequence !== loadSequence) return
    analytics.value = result.analytics
    positions.value = result.positions
    accountName.value = result.account.name
    await nextTick()
    renderCharts()
  } catch (e) {
    if (sequence === loadSequence) error.value = (e as Error).message
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

function selectAccount(id: number): void {
  selectedKeyId.value = id
  void load()
  if (showC2cHistory.value) {
    c2cHistoryPage.value = 1
    c2cHistoryError.value = ''
    c2cHistoryMessage.value = ''
    void loadC2cHistory(1)
  }
}

function openC2cHistory(): void {
  showC2cHistory.value = true
  c2cHistoryPage.value = 1
  c2cHistoryError.value = ''
  c2cHistoryMessage.value = ''
  void loadC2cHistory(1)
}

async function loadC2cHistory(page: number): Promise<void> {
  const keyId = selectedKeyId.value
  if (!keyId) return
  const sequence = ++historySequence
  c2cHistoryLoading.value = true
  c2cHistoryError.value = ''
  c2cHistory.value = []
  c2cHistoryTotal.value = 0
  try {
    const result = await fetchC2cOrderHistory(keyId, page, c2cHistoryPageSize)
    if (sequence !== historySequence || keyId !== selectedKeyId.value) return
    c2cHistory.value = result.orders
    c2cHistoryPage.value = result.page
    c2cHistoryTotal.value = result.total
  } catch (e) {
    if (sequence === historySequence) c2cHistoryError.value = (e as Error).message
  } finally {
    if (sequence === historySequence) c2cHistoryLoading.value = false
  }
}

function chooseC2cFile(): void {
  if (!c2cActionLoading.value && selectedKeyId.value) {
    c2cFileInput.value?.click()
  }
}

async function importC2cFile(event: Event): Promise<void> {
  const input = event.currentTarget
  if (!(input instanceof HTMLInputElement)) return
  const file = input.files?.[0]
  input.value = ''
  const keyId = selectedKeyId.value
  if (!file || !keyId || c2cActionLoading.value) return

  const keyName = selectedKey.value?.name ?? '当前账户'
  c2cImporting.value = true
  c2cHistoryError.value = ''
  c2cHistoryMessage.value = ''
  try {
    const parsed = await parseBinanceC2cFile(file)
    if (!parsed.orders.length) {
      c2cHistoryMessage.value =
        `文件中没有可导入的已完成 USDT 订单，已忽略 ${parsed.ignored} 条。`
      return
    }
    const result = await importC2cOrders(keyId, parsed.orders)
    c2cHistoryMessage.value =
      `已导入到“${keyName}”：新增 ${result.inserted} 笔，重复跳过 ${result.skippedDuplicates} 笔，忽略 ${parsed.ignored} 条。`
    if (selectedKeyId.value === keyId) {
      await Promise.all([loadC2cHistory(1), load()])
    }
  } catch (e) {
    c2cHistoryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    c2cImporting.value = false
  }
}

async function updateC2cHistory(): Promise<void> {
  const keyId = selectedKeyId.value
  if (!keyId || c2cActionLoading.value) return
  const keyName = selectedKey.value?.name ?? '当前账户'
  c2cUpdating.value = true
  c2cHistoryError.value = ''
  c2cHistoryMessage.value = ''
  try {
    const result = await syncC2cOrders(keyId)
    c2cHistoryMessage.value = result.received
      ? `“${keyName}”更新完成：新增 ${result.inserted} 笔，重复跳过 ${result.skippedDuplicates} 笔。`
      : `“${keyName}”已更新，没有发现新订单。`
    if (selectedKeyId.value === keyId) {
      await Promise.all([loadC2cHistory(1), load()])
    }
  } catch (e) {
    c2cHistoryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    c2cUpdating.value = false
  }
}

function formatOrderTime(value: string): string {
  const time = new Date(value)
  return Number.isNaN(time.getTime())
    ? '—'
    : time.toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})
}

const cards = computed(() => {
  const trades = positions.value
  if (!trades) return []
  return [
    {
      label: '实现盈亏',
      value: `${trades.net >= 0 ? '+' : '−'}${displayMoney(Math.abs(trades.net))}`,
      sub: `已平仓位汇总 · 含手续费与资金费`,
      tone: trades.net >= 0 ? 'ok' : 'bad'
    },
    {
      label: '累计收益率',
      value: roi.value === null ? '—' : roiValue(roi.value),
      sub: `基准 ${money(Number(benchmark.value) || 0)} USDT`,
      tone: roi.value === null ? '' : roi.value >= 0 ? 'ok' : 'bad'
    },
    {
      label: '最大回撤',
      value: drawdownPct.value === null ? '—' : `−${drawdownPct.value.toFixed(2)}%`,
      sub: '按基准本金与累计已实现盈亏计算',
      tone: 'bad'
    },
    {
      label: '胜率',
      value: trades.wins + trades.losses
        ? `${((trades.wins / (trades.wins + trades.losses)) * 100).toFixed(1)}%`
        : '—',
      sub: `盈利 ${trades.wins} · 亏损 ${trades.losses} · 持平 ${trades.breakeven}`
    },
    {
      label: '盈亏比',
      value: profitFactor.value === null
        ? '—'
        : Number.isFinite(profitFactor.value)
          ? profitFactor.value.toFixed(2)
          : '∞',
      sub: '盈利总额 ÷ 亏损总额'
    },
    {
      label: '平均持仓时长',
      value: duration(trades.averageHoldSec),
      sub: '仅统计日期范围内已全平仓位'
    }
  ]
})

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const days = Math.floor(hours / 24)
  return days ? `${days} 天 ${Math.floor((hours % 24))} 小时` : `${hours} 小时`
}

function chartFor(key: string, el: HTMLElement | null): ECharts | null {
  if (!el || el.clientWidth === 0 || el.clientHeight === 0) return null
  let instance = charts.get(key)
  if (!instance) {
    instance = echarts.init(el)
    charts.set(key, instance)
  }
  return instance
}

function renderCharts(): void {
  const rows = dailyRows.value
  const roiChart = chartFor('roi', roiChartEl.value)
  const dailyChart = chartFor('daily', dailyChartEl.value)
  const drawdownChart = chartFor('drawdown', drawdownChartEl.value)
  const outcomesChart = chartFor('outcomes', outcomesChartEl.value)
  const directionChart = chartFor('direction', directionChartEl.value)
  if (roiChart && dailyChart && drawdownChart && outcomesChart && directionChart) {
    renderPerformanceCharts({roiChart, dailyChart, drawdownChart, outcomesChart, directionChart}, rows)
  }
}

function renderPerformanceCharts(
  chartSet: Record<'roiChart' | 'dailyChart' | 'drawdownChart' | 'outcomesChart' | 'directionChart', ECharts>,
  rows: PositionStatistics['daily']
): void {
  const {roiChart, dailyChart, drawdownChart, outcomesChart, directionChart} = chartSet
  const dates = rows.map(row => row.date.slice(5))
  const axisLabel = {
    color: P.text,
    fontSize: 11,
    hideOverlap: true,
    interval: Math.max(0, Math.ceil(rows.length / 6) - 1)
  }
  const axisLine = {lineStyle: {color: P.grid}}
  if (!rows.length) {
    roiChart.clear()
    dailyChart.clear()
    drawdownChart.clear()
  } else {
    roiChart.setOption({
      animationDuration: 240,
      grid: {left: 48, right: 18, top: 16, bottom: 28},
      tooltip: {
        ...warmTooltip,
        trigger: 'axis',
        formatter: (params: {dataIndex: number}[]) => {
          const row = rows[params[0]?.dataIndex]
          if (!row) return ''
          const cumulativeReturn = Number(benchmark.value) > 0
            ? row.cumulative / Number(benchmark.value) * 100
            : 0
          return `${row.date}<br/>平仓 ${row.count} 笔<br/>` +
            `累计盈亏 ${displayMoney(row.cumulative)}<br/>累计收益率 ${roiValue(cumulativeReturn)}`
        }
      },
      xAxis: {type: 'category', data: dates, axisLabel, axisLine, axisTick: {show: false}},
      yAxis: {
        type: 'value',
        axisLabel: {color: P.text, fontSize: 11, formatter: (value: number) => `${value.toFixed(1)}%`},
        splitLine: {lineStyle: {color: P.grid, type: 'dashed'}}
      },
      series: [{
        name: '累计收益率',
        type: 'line',
        data: rows.map(row => Number(benchmark.value) > 0 ? row.cumulative / Number(benchmark.value) * 100 : 0),
        symbol: 'none',
        smooth: 0.2,
        lineStyle: {color: P.accent, width: 2},
        areaStyle: {color: P.accent, opacity: 0.08}
      }]
    }, true)

    dailyChart.setOption({
      animationDuration: 240,
      grid: {left: 52, right: 12, top: 12, bottom: 28},
      tooltip: {
        ...warmTooltip,
        trigger: 'axis',
        formatter: (params: {dataIndex: number}[]) => {
          const row = rows[params[0]?.dataIndex]
          return row ? `${row.date}<br/>已平仓 ${row.count} 笔<br/>当日净盈亏 ${displayMoney(row.net)}` : ''
        }
      },
      xAxis: {type: 'category', data: dates, axisLabel, axisLine, axisTick: {show: false}},
      yAxis: {
        type: 'value',
        axisLabel: {color: P.text, fontSize: 11, formatter: (value: number) => money(value, 0)},
        splitLine: {lineStyle: {color: P.grid, type: 'dashed'}}
      },
      series: [{
        name: '每日净盈亏',
        type: 'bar',
        data: rows.map(row => ({
          value: currency.value === 'cny' ? row.net * usdCny.value : row.net,
          itemStyle: {color: row.net >= 0 ? P.ok : P.bad, borderRadius: [3, 3, 0, 0]}
        })),
        barMaxWidth: 22
      }]
    }, true)

    const ddRows = drawdownRows.value
    drawdownChart.setOption({
      animationDuration: 240,
      grid: {left: 48, right: 14, top: 12, bottom: 28},
      tooltip: {
        ...warmTooltip,
        trigger: 'axis',
        formatter: (params: {dataIndex: number}[]) => {
          const row = ddRows[params[0]?.dataIndex]
          return row ? `${row.date}<br/>回撤 ${row.drawdown.toFixed(2)}%` : ''
        }
      },
      xAxis: {type: 'category', data: dates, axisLabel, axisLine, axisTick: {show: false}},
      yAxis: {
        type: 'value',
        max: 0,
        axisLabel: {color: P.text, fontSize: 11, formatter: (value: number) => `${value.toFixed(1)}%`},
        splitLine: {lineStyle: {color: P.grid, type: 'dashed'}}
      },
      series: [{
        name: '回撤',
        type: 'line',
        data: ddRows.map(row => row.drawdown),
        symbol: 'none',
        lineStyle: {color: P.bad, width: 2},
        areaStyle: {color: P.bad, opacity: 0.08}
      }]
    }, true)
  }

  const trades = positions.value
  if (!trades) {
    outcomesChart.clear()
    directionChart.clear()
    return
  }
  const pieBase = {
    animationDuration: 240,
    tooltip: {...warmTooltip, trigger: 'item' as const, formatter: '{b}: {c} ({d}%)'},
    series: [{
      type: 'pie' as const,
      radius: ['48%', '72%'],
      center: ['50%', '52%'],
      label: {color: P.text, fontSize: 11, formatter: '{b} {d}%'},
      labelLine: {length: 7, length2: 5, lineStyle: {color: P.grid}},
      itemStyle: {borderColor: P.panel, borderWidth: 3}
    }]
  }
  outcomesChart.setOption({
    ...pieBase,
    color: [P.ok, P.bad, P.text],
    series: [{
      ...pieBase.series[0],
      data: [
        {name: '盈利', value: trades.wins},
        {name: '亏损', value: trades.losses},
        {name: '持平', value: trades.breakeven}
      ]
    }]
  }, true)
  directionChart.setOption({
    ...pieBase,
    color: [P.accent, P.text],
    series: [{
      ...pieBase.series[0],
      data: [
        {name: '多仓', value: trades.longCount},
        {name: '空仓', value: trades.shortCount}
      ]
    }]
  }, true)
}

onMounted(() => {
  try {
    const saved = localStorage.getItem('ait-account-stats-settings')
    if (saved) {
      const parsed = JSON.parse(saved) as {benchmark?: unknown; currency?: unknown}
      const base = Number(parsed.benchmark)
      if (Number.isFinite(base) && base > 0) benchmark.value = String(base)
      currency.value = parsed.currency === 'cny' ? 'cny' : 'usd'
    }
  } catch (e) {
    error.value = `读取配置失败：${(e as Error).message}`
  }
  const end = beijingToday()
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 29)
  from.value = dateKey(start)
  to.value = dateKey(end)
  void Promise.all([loadKeys(), loadRate()])
  chartObserver = new ResizeObserver(() => renderCharts())
  for (const el of [roiChartEl.value, dailyChartEl.value, drawdownChartEl.value, outcomesChartEl.value, directionChartEl.value]) {
    if (el) chartObserver.observe(el)
  }
})

async function loadKeys(): Promise<void> {
  try {
    const result = await fetchExchangeKeys()
    exchangeKeys.value = result.keys
    selectedKeyId.value = result.keys.find(key => key.isDefault)?.id ?? result.keys[0]?.id ?? null
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function loadRate(): Promise<void> {
  try {
    const result = await fetchRate()
    if (!Number.isFinite(result.usdCny) || result.usdCny <= 0) {
      throw new Error('服务端返回的美元兑人民币汇率无效')
    }
    usdCny.value = result.usdCny
  } catch (e) {
    rateError.value = (e as Error).message
  }
}

watch(() => positions.value, () => renderCharts(), {deep: true})
watch(() => [selectedKeyId.value, benchmark.value, currency.value], () => renderCharts())

onBeforeUnmount(() => {
  chartObserver?.disconnect()
  for (const chart of charts.values()) chart.dispose()
  charts.clear()
})
</script>

<template>
  <section class="account-stats">
    <div class="account-switcher">
      <nav class="account-tabs" aria-label="统计账户">
        <button
          v-for="key in exchangeKeys"
          :key="key.id"
          type="button"
          role="tab"
          :aria-selected="selectedKeyId === key.id"
          :class="{active: selectedKeyId === key.id}"
          @click="selectAccount(key.id)"
        >
          <span>{{ key.name }}</span>
          <small>{{ key.marketType === 'swap' ? '合约' : '现货' }}</small>
        </button>
      </nav>
      <div class="toolbar-actions">
        <div class="toolbar-icon-row">
          <button class="history-trigger" type="button" aria-label="法币交易历史" title="法币交易历史" :disabled="!selectedKeyId" @click="openC2cHistory">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7.5V3.8M4 7.5h3.7M4.5 7.2A8.5 8.5 0 1 1 3.7 14" />
              <path d="M12 7.5v5l3.2 1.8" />
            </svg>
          </button>
          <button
            class="date-trigger"
            :class="{active: from || to}"
            type="button"
            aria-label="选择统计日期范围"
            title="选择统计日期范围"
            @click="openDatePicker"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
              <path d="M7.5 3.5v3M16.5 3.5v3M4 9.5h16M8 13h2M14 13h2M8 16.5h2" />
            </svg>
          </button>
          <button class="config-trigger" type="button" aria-label="账户统计配置" title="账户统计配置" @click="openConfig">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z" />
              <path d="m19.4 13.5 1.1.9-1.2 2.1-1.4-.5a7.8 7.8 0 0 1-1.5.9l-.3 1.5h-2.4l-.3-1.5a7.8 7.8 0 0 1-1.5-.9l-1.4.5-1.2-2.1 1.1-.9a6.2 6.2 0 0 1 0-1.8l-1.1-.9 1.2-2.1 1.4.5a7.8 7.8 0 0 1 1.5-.9l.3-1.5h2.4l.3 1.5a7.8 7.8 0 0 1 1.5.9l1.4-.5 1.2 2.1-1.1.9a6.2 6.2 0 0 1 0 1.8Z" />
            </svg>
          </button>
        </div>
        <span class="toolbar-date-range">{{ compactDateRange }}</span>
      </div>
    </div>
    <p v-if="!exchangeKeys.length && !loading" class="stats-empty">没有可统计的交易所账户。</p>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="rateError && currency === 'cny'" class="error">人民币汇率读取失败：{{ rateError }}</p>
    <section v-if="analytics" class="capital-carousel">
      <div class="capital-carousel-head">
        <span>资金概览</span>
        <div class="capital-carousel-controls stats-segments">
          <button type="button" aria-label="显示资金净额" :class="{active: capitalSlide === 0}" @click="showCapitalSlide(0)">资金净额</button>
          <button type="button" aria-label="显示法币交易资金流" :class="{active: capitalSlide === 1}" @click="showCapitalSlide(1)">法币交易资金流</button>
        </div>
      </div>
      <div ref="capitalTrackEl" class="capital-track" @scroll.passive="syncCapitalSlide">
        <article class="capital-hero capital-slide" :class="capitalTone">
          <div class="capital-copy">
            <div class="capital-overline">法币交易本金 · {{ accountName || selectedKey?.name }}</div>
            <div class="capital-value">
              {{ investedUsdt > 0 ? '−' : investedUsdt < 0 ? '+' : '' }}{{ displayMoney(Math.abs(investedUsdt)) }}
            </div>
            <div class="capital-status">{{ capitalStatus }}</div>
            <p>按法币交易净买入估算，不等同于账户实时亏损</p>
          </div>
          <div class="capital-orbit" aria-hidden="true">
            <span>资金状态</span>
            <strong>{{ capitalStatus }}</strong>
          </div>
        </article>
        <article class="c2c-panel capital-slide">
          <header class="section-heading">
            <div>
              <strong>法币交易资金流</strong>
              <span>{{ selectedKey?.name }} · 当前日期范围</span>
            </div>
            <span class="c2c-order-count">{{ money(analytics.capital.orders, 0) }} 笔订单</span>
          </header>
          <div class="c2c-flow">
            <div class="flow-side buy-flow">
              <span class="flow-label"><i></i> 买入 USDT</span>
              <strong>{{ money(analytics.capital.depositsUsdt) }} <small>USDT</small></strong>
              <span class="flow-fiat">人民币成交额 ¥{{ money(analytics.capital.depositsCny) }}</span>
            </div>
            <div class="flow-side sell-flow">
              <span class="flow-label"><i></i> 卖出 USDT</span>
              <strong>{{ money(analytics.capital.withdrawalsUsdt) }} <small>USDT</small></strong>
              <span class="flow-fiat">人民币成交额 ¥{{ money(analytics.capital.withdrawalsCny) }}</span>
            </div>
          </div>
          <div class="c2c-footer">每笔成交均可在右上角历史记录中查看</div>
        </article>
      </div>
      <div class="capital-dots" aria-label="切换资金概览">
        <button type="button" aria-label="资金净额" :class="{active: capitalSlide === 0}" @click="showCapitalSlide(0)"></button>
        <button type="button" aria-label="法币交易资金流" :class="{active: capitalSlide === 1}" @click="showCapitalSlide(1)"></button>
      </div>
    </section>
    <section v-if="cards.length" class="performance-section">
      <header class="performance-heading">
        <nav class="performance-switcher stats-segments" aria-label="统计视图切换" role="tablist">
          <button
            type="button"
            role="tab"
            :aria-selected="performanceTab === 'performance'"
            :class="{active: performanceTab === 'performance'}"
            @click="performanceTab = 'performance'"
          >交易表现</button>
          <button
            type="button"
            role="tab"
            :aria-selected="performanceTab === 'breakdown'"
            :class="{active: performanceTab === 'breakdown'}"
            @click="performanceTab = 'breakdown'"
          >盈亏分析</button>
        </nav>
      </header>
      <div v-if="performanceTab === 'performance'" class="metric-grid" role="tabpanel">
        <div v-for="card in cards" :key="card.label" class="metric-card" :class="card.tone">
          <div class="k">{{ card.label }}</div>
          <div class="v">{{ card.value }}</div>
          <div class="sub">{{ card.sub }}</div>
        </div>
      </div>
      <div v-else-if="positions?.breakdown" class="breakdown-content" role="tabpanel" aria-label="盈亏结构拆解">
        <header class="breakdown-intro">
          <strong>交易分析</strong>
          <span>按品种、方向、持仓时长与盈亏集中度拆解</span>
        </header>
        <section class="breakdown-group symbol-breakdown">
          <header><strong>品种贡献</strong><span>净盈亏</span></header>
          <div class="symbol-columns">
            <div>
              <small>主要盈利</small>
              <div v-if="profitableSymbols.length" class="breakdown-rows">
                <div v-for="group in profitableSymbols" :key="`profit-${group.key}`" class="breakdown-row">
                  <span>{{ group.key }}</span>
                  <strong class="positive">{{ displayMoney(group.net) }}</strong>
                  <small>{{ group.closedCount }} 笔</small>
                </div>
              </div>
              <p v-else class="breakdown-empty">暂无盈利品种</p>
            </div>
            <div>
              <small>主要亏损</small>
              <div v-if="losingSymbols.length" class="breakdown-rows">
                <div v-for="group in losingSymbols" :key="`loss-${group.key}`" class="breakdown-row">
                  <span>{{ group.key }}</span>
                  <strong class="negative">{{ displayMoney(group.net) }}</strong>
                  <small>{{ group.closedCount }} 笔</small>
                </div>
              </div>
              <p v-else class="breakdown-empty">暂无亏损品种</p>
            </div>
          </div>
        </section>
        <section class="breakdown-group">
          <header><strong>多空表现</strong><span>按仓位方向</span></header>
          <div class="breakdown-rows">
            <div v-for="group in directionBreakdown" :key="group.key" class="breakdown-row">
              <span>{{ group.key === 'long' ? '多头' : '空头' }}</span>
              <strong :class="amountTone(group.net)">{{ displayMoney(group.net) }}</strong>
              <small>{{ group.closedCount }} 笔</small>
            </div>
          </div>
        </section>
        <section class="breakdown-group">
          <header><strong>持仓时长</strong><span>短 ≤1 小时 · 中 1–24 小时 · 长 &gt;24 小时</span></header>
          <div class="breakdown-rows">
            <div v-for="group in durationBreakdown" :key="group.key" class="breakdown-row">
              <span>{{ durationLabel(group.key) }}</span>
              <strong :class="amountTone(group.net)">{{ displayMoney(group.net) }}</strong>
              <small>{{ group.closedCount }} 笔</small>
            </div>
          </div>
          <p v-if="positions?.breakdown.incompleteHoldCount" class="breakdown-note">
            {{ positions.breakdown.incompleteHoldCount }} 笔账本起始不完整，未计入时长分组
          </p>
        </section>
        <section class="breakdown-group concentration-breakdown">
          <header><strong>盈亏集中度</strong><span>净盈亏口径</span></header>
          <div class="concentration-cards">
            <div>
              <small>盈利前 5% 交易 · 占总盈利</small>
              <strong>{{ positions?.breakdown.profitConcentration.sharePct.toFixed(1) }}%</strong>
              <span>{{ displayMoney(positions?.breakdown.profitConcentration.amount ?? 0) }} · {{ positions?.breakdown.profitConcentration.selectedCount }} / {{ positions?.breakdown.profitConcentration.totalCount }} 笔</span>
            </div>
            <div>
              <small>最大 5 笔亏损 · 占总亏损</small>
              <strong>{{ positions?.breakdown.lossConcentration.sharePct.toFixed(1) }}%</strong>
              <span>{{ displayMoney(positions?.breakdown.lossConcentration.amount ?? 0) }} · {{ positions?.breakdown.lossConcentration.selectedCount }} / {{ positions?.breakdown.lossConcentration.totalCount }} 笔</span>
            </div>
          </div>
        </section>
        <p class="breakdown-note entry-reason-note">入场原因：当前没有策略信号标记，暂无法拆解。</p>
      </div>
      <p v-else class="breakdown-unavailable" role="tabpanel">
        盈亏分析数据暂不可用，请稍后刷新重试。
      </p>
    </section>
    <p v-else-if="!loading && !error" class="stats-empty">还没有可统计的交易数据。</p>

    <div v-if="positions" class="income-breakdown">
      <span>实现盈亏 {{ displayMoney(positions.realized) }}</span>
      <span>手续费 −{{ displayMoney(positions.fees) }}</span>
      <span>资金费 {{ displayMoney(positions.funding) }}</span>
    </div>

    <section class="charts-section">
        <header class="charts-heading">
          <div>
            <h2>收益分析</h2>
          </div>
          <p>按平仓日汇总 · 基准 {{ money(Number(benchmark) || 0) }} USDT</p>
        </header>
        <nav class="chart-switcher stats-segments" aria-label="图表切换" role="tablist">
          <button
            v-for="(label, index) in chartLabels"
            :key="label"
            type="button"
            role="tab"
            :aria-selected="chartSlide === index"
            :class="{active: chartSlide === index}"
            @click="showChartSlide(index)"
          >{{ label }}</button>
        </nav>
        <div ref="chartTrackEl" class="chart-track" @scroll.passive="syncChartSlide">
          <article class="chart-panel main-chart chart-slide">
            <div class="chart-heading">
              <div>
                <strong>累计收益率</strong>
                <span>净盈亏 ÷ 基准本金</span>
              </div>
              <span v-if="positions">{{ positions.closedCount }} 笔平仓</span>
            </div>
            <div ref="roiChartEl" class="pnl-chart"></div>
            <p v-if="positions && !dailyRows.length" class="chart-empty">当前账户和周期内暂无已平仓位</p>
          </article>
          <article class="chart-panel chart-slide">
            <div class="chart-heading"><div><strong>每日净盈亏</strong><span>{{ currencyLabel }} · 按平仓日</span></div></div>
            <div ref="dailyChartEl" class="small-chart"></div>
            <p v-if="positions && !dailyRows.length" class="chart-empty">暂无数据</p>
          </article>
          <article class="chart-panel chart-slide">
            <div class="chart-heading"><div><strong>收益回撤</strong><span>峰值至谷值的跌幅</span></div></div>
            <div ref="drawdownChartEl" class="small-chart"></div>
            <p v-if="positions && !dailyRows.length" class="chart-empty">暂无数据</p>
          </article>
          <article class="chart-panel chart-slide">
            <div class="chart-heading"><div><strong>仓位结果分布</strong><span>按净盈亏分类</span></div></div>
            <div ref="outcomesChartEl" class="small-chart"></div>
          </article>
          <article class="chart-panel chart-slide">
            <div class="chart-heading"><div><strong>交易方向分布</strong><span>已平仓位构成</span></div></div>
            <div ref="directionChartEl" class="small-chart"></div>
          </article>
        </div>
        <div class="chart-dots" aria-label="选择图表">
          <button
            v-for="(label, index) in chartLabels"
            :key="label"
            type="button"
            :aria-label="label"
            :class="{active: chartSlide === index}"
            @click="showChartSlide(index)"
          />
        </div>
    </section>

    <Teleport to="body">
      <div v-if="showDatePicker" class="date-modal-mask" @click.self="showDatePicker = false">
        <section class="date-modal" role="dialog" aria-modal="true" aria-label="选择日期范围">
          <header class="date-modal-head">
            <div>
              <h3>统计日期范围</h3>
              <p>{{ draftFrom ? displayDate(draftFrom) : '开始日期' }} <span>→</span> {{ draftTo ? displayDate(draftTo) : '结束日期' }}</p>
            </div>
            <button class="date-close" type="button" aria-label="关闭" @click="showDatePicker = false">×</button>
          </header>
          <nav class="quick-ranges" aria-label="快捷日期范围">
            <button type="button" :class="{active: activeQuickRange === '7'}" @click="chooseQuickRange(7)">近 7 天</button>
            <button type="button" :class="{active: activeQuickRange === '30'}" @click="chooseQuickRange(30)">近 30 天</button>
            <button type="button" :class="{active: activeQuickRange === '90'}" @click="chooseQuickRange(90)">近 90 天</button>
            <button type="button" :class="{active: activeQuickRange === 'all'}" @click="chooseQuickRange(null)">全部</button>
          </nav>
          <div class="calendar-head">
            <button type="button" aria-label="上个月" @click="shiftMonth(-1)">‹</button>
            <strong>{{ monthLabel }}</strong>
            <button type="button" aria-label="下个月" @click="shiftMonth(1)">›</button>
          </div>
          <div class="calendar-grid">
            <span v-for="day in ['一', '二', '三', '四', '五', '六', '日']" :key="day" class="weekday">{{ day }}</span>
            <button
              v-for="cell in calendarCells"
              :key="cell.key"
              type="button"
              class="calendar-day"
              :class="{outside: !cell.currentMonth, selected: cell.selected, inRange: cell.inRange, today: cell.today}"
              @click="chooseDate(cell.key)"
            >{{ cell.day }}</button>
          </div>
          <footer class="date-modal-actions">
            <button type="button" class="clear-range" @click="clearDateRange">清除日期</button>
            <button type="button" class="apply-range" @click="applyDateRange">应用</button>
          </footer>
        </section>
      </div>
      <div v-if="showConfig" class="date-modal-mask" @click.self="showConfig = false">
        <form class="date-modal config-modal" role="dialog" aria-modal="true" aria-label="账户统计配置" @submit.prevent="saveConfig">
          <header class="date-modal-head">
            <div>
              <h3>账户统计配置</h3>
              <p>配置收益率基准与金额显示单位</p>
            </div>
            <button class="date-close" type="button" aria-label="关闭" @click="showConfig = false">×</button>
          </header>
          <label class="config-field">
            <span>收益率基准金额（USDT）</span>
            <input v-model="draftBenchmark" type="number" min="0.01" step="any" inputmode="decimal" required />
            <small>累计收益率 = 已平仓位净盈亏 ÷ 基准金额</small>
          </label>
          <fieldset class="currency-setting">
            <legend>金额显示单位</legend>
            <label :class="{selected: draftCurrency === 'usd'}">
              <input v-model="draftCurrency" type="radio" value="usd" />
              美元
            </label>
            <label :class="{selected: draftCurrency === 'cny'}">
              <input v-model="draftCurrency" type="radio" value="cny" />
              人民币
            </label>
          </fieldset>
          <p class="config-rate">当前换算：1 美元 = {{ usdCny.toFixed(4) }} 元</p>
          <footer class="date-modal-actions">
            <button type="button" class="clear-range" @click="showConfig = false">取消</button>
            <button type="submit" class="apply-range">保存配置</button>
          </footer>
        </form>
      </div>
      <div v-if="showC2cHistory" class="date-modal-mask history-mask" @click.self="showC2cHistory = false">
        <section class="date-modal history-modal" role="dialog" aria-modal="true" aria-label="法币交易历史">
          <header class="date-modal-head history-head">
            <div>
              <h3>法币交易历史</h3>
              <p>{{ selectedKey?.name || accountName || '当前账户' }} · 共 {{ money(c2cHistoryTotal, 0) }} 笔记录</p>
            </div>
            <button class="date-close" type="button" aria-label="关闭" @click="showC2cHistory = false">×</button>
          </header>
          <input
            ref="c2cFileInput"
            class="history-file-input"
            type="file"
            accept=".csv,.zip"
            aria-label="选择币安 C2C 订单文件"
            @change="importC2cFile"
          />
          <div class="history-actions">
            <button
              type="button"
              class="history-action-button"
              :disabled="!selectedKeyId || c2cHistoryLoading || c2cActionLoading"
              @click="chooseC2cFile"
            >
              {{ c2cImporting ? '导入中…' : '导入' }}
            </button>
            <button
              type="button"
              class="history-action-button history-update-button"
              :disabled="!selectedKeyId || c2cHistoryLoading || c2cActionLoading"
              @click="updateC2cHistory"
            >
              {{ c2cUpdating ? '更新中…' : '更新' }}
            </button>
          </div>
          <p v-if="c2cHistoryMessage" class="history-action-message" role="status">
            {{ c2cHistoryMessage }}
          </p>
          <p v-if="c2cHistoryError" class="error">{{ c2cHistoryError }}</p>
          <div class="history-table-wrap">
            <table class="history-table">
              <thead>
                <tr>
                  <th>成交时间</th>
                  <th>方向</th>
                  <th>数量</th>
                  <th>成交价</th>
                  <th>法币金额</th>
                  <th>订单编号</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="order in c2cHistory" :key="order.orderId">
                  <td>{{ formatOrderTime(order.timestamp) }}</td>
                  <td><span class="history-side" :class="order.side === 'Buy' ? 'buy' : 'sell'">{{ order.side === 'Buy' ? '买入' : '卖出' }}</span></td>
                  <td>{{ money(order.quantity, 4) }} <small>{{ order.asset }}</small></td>
                  <td>{{ money(order.price, 4) }} <small>法币/USDT</small></td>
                  <td>{{ order.fiat }} {{ money(order.fiatTotal, 2) }}</td>
                  <td class="history-order-id" :title="order.orderId">{{ order.orderId }}</td>
                </tr>
                <tr v-if="!c2cHistoryLoading && !c2cHistory.length">
                  <td colspan="6" class="history-empty">当前账户还没有导入记录</td>
                </tr>
                <tr v-if="c2cHistoryLoading">
                  <td colspan="6" class="history-empty">正在读取记录…</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="mobile-history-list">
            <article v-for="order in c2cHistory" :key="order.orderId" class="mobile-history-card">
              <header>
                <time>{{ formatOrderTime(order.timestamp) }}</time>
                <span class="history-side" :class="order.side === 'Buy' ? 'buy' : 'sell'">{{ order.side === 'Buy' ? '买入' : '卖出' }}</span>
              </header>
              <div class="mobile-history-details">
                <div><small>数量</small><strong>{{ money(order.quantity, 4) }} {{ order.asset }}</strong></div>
                <div><small>成交价</small><strong>{{ money(order.price, 4) }} {{ order.fiat }}/USDT</strong></div>
                <div><small>法币金额</small><strong>{{ order.fiat }} {{ money(order.fiatTotal, 2) }}</strong></div>
              </div>
              <footer><small>订单编号</small><span :title="order.orderId">{{ order.orderId }}</span></footer>
            </article>
            <p v-if="!c2cHistoryLoading && !c2cHistory.length" class="mobile-history-empty">当前账户还没有导入记录</p>
            <p v-if="c2cHistoryLoading" class="mobile-history-empty">正在读取记录…</p>
          </div>
          <footer class="history-pagination">
            <span>显示 {{ c2cHistoryStart }}–{{ c2cHistoryEnd }} 条，共 {{ money(c2cHistoryTotal, 0) }} 条</span>
            <div>
              <button type="button" :disabled="c2cHistoryLoading || c2cHistoryPage <= 1" @click="loadC2cHistory(c2cHistoryPage - 1)">上一页</button>
              <strong>{{ c2cHistoryPage }} / {{ c2cHistoryPages }}</strong>
              <button type="button" :disabled="c2cHistoryLoading || c2cHistoryPage >= c2cHistoryPages" @click="loadC2cHistory(c2cHistoryPage + 1)">下一页</button>
            </div>
          </footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>

/*
 * 本页使用局部暖灰基底与低对比度的冷暖渐变，状态色只用于金额正负。
 * 弹窗 Teleport 到 body 后不会继承 `.account-stats` 变量，因此需在遮罩上重复定义。
 */
.account-stats,
.date-modal-mask {
  --panel: #0d0c0b;
  --panel-2: #19150f;
  --border: #30271d;
  --accent: #ffc16b;
  --accent-soft: color-mix(in srgb, #ffc16b 13%, transparent);
  --accent-line: color-mix(in srgb, #ffc16b 52%, transparent);
  --accent-ink: #231603;
  --blue: #ffc16b;
  --blue-soft: color-mix(in srgb, #ffc16b 13%, transparent);
  --ok: #72d6a0;
  --bad: #ff7480;
  --muted: #aaa398;
}

.account-stats {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  padding-right: 12px;
  margin-right: -12px;
  scrollbar-width: none;
}

.account-stats::-webkit-scrollbar {
  display: none;
}

.account-switcher {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.toolbar-actions {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

.toolbar-icon-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.toolbar-date-range {
  color: var(--muted);
  font-size: 8px;
  line-height: 1;
  white-space: nowrap;
}

.history-trigger {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 36px;
  height: 36px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--panel) 76%, #54402f), var(--panel) 55%, color-mix(in srgb, var(--panel) 78%, #242d36));
  color: var(--text);
  cursor: pointer;
}

.history-trigger svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.account-tabs {
  display: flex;
  min-width: 0;
  flex: 1;
  gap: 8px;
  overflow-x: auto;
  align-items: center;
  padding: 0;
  scrollbar-width: none;
}

.account-tabs::-webkit-scrollbar {
  display: none;
}

.account-tabs button {
  display: flex;
  box-sizing: border-box;
  flex: 0 0 auto;
  height: 36px;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  justify-content: center;
  min-width: 64px;
  padding: 5px 13px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: linear-gradient(145deg, color-mix(in srgb, #344153 30%, var(--panel)), color-mix(in srgb, #35404a 20%, var(--panel)) 55%, var(--panel));
  color: var(--text);
  text-align: left;
}

.account-tabs button.active {
  border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
  background: linear-gradient(
    112deg,
    color-mix(in srgb, #ffd99e 15%, transparent) 0%,
    color-mix(in srgb, #ffc16b 9%, transparent) 52%,
    color-mix(in srgb, #f39a3f 4%, transparent) 100%
  );
  color: #ffd291;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 5%, transparent);
}

.account-tabs button span {
  line-height: 1;
  max-width: 92px;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-tabs button small {
  line-height: 1;
  color: var(--muted);
  font-size: 8px;
  white-space: nowrap;
}

.config-trigger {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 36px;
  height: 36px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: linear-gradient(145deg, color-mix(in srgb, #344153 24%, var(--panel)), color-mix(in srgb, #35404a 18%, var(--panel)));
  color: var(--text);
}

.config-trigger svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.date-trigger {
  position: relative;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 36px;
  height: 36px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: linear-gradient(150deg, color-mix(in srgb, #6e5238 10%, var(--panel)), color-mix(in srgb, #25313a 14%, var(--panel)) 52%, var(--panel));
  color: var(--text);
  cursor: pointer;
}

.date-trigger svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}

.date-trigger.active {
  border-color: color-mix(in srgb, var(--accent) 52%, var(--border));
  background:
    linear-gradient(115deg, color-mix(in srgb, #ffe0ad 9%, transparent), transparent 54%),
    linear-gradient(145deg, color-mix(in srgb, #6e5238 15%, var(--panel)), color-mix(in srgb, #25313a 17%, var(--panel)));
  color: #ffd291;
}

.stats-empty,
.chart-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

.stats-empty {
  padding: 18px 12px;
  text-align: center;
}

.capital-hero {
  position: relative;
  display: flex;
  min-height: 152px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  overflow: hidden;
  padding: 22px 24px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  border-radius: 18px;
  background:
    radial-gradient(ellipse at 85% 12%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 37%),
    linear-gradient(115deg, var(--panel), color-mix(in srgb, var(--accent) 3%, var(--panel)));
}

.capital-carousel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.capital-carousel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
  color: var(--muted);
  font-size: 10px;
}

.stats-segments {
  display: flex;
  min-width: 0;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: linear-gradient(120deg, color-mix(in srgb, #29313d 20%, var(--panel)), color-mix(in srgb, #2c211b 15%, var(--panel)));
}

.stats-segments button {
  flex: 1 1 0;
  min-width: 0;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}

.stats-segments button.active {
  background: linear-gradient(
    112deg,
    color-mix(in srgb, #ffd99e 25%, transparent) 0%,
    color-mix(in srgb, #ffc16b 15%, transparent) 52%,
    color-mix(in srgb, #f39a3f 9%, transparent) 100%
  );
  color: #ffd291;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent);
}

.capital-track {
  display: flex;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}

.capital-track::-webkit-scrollbar {
  display: none;
}

.capital-slide {
  box-sizing: border-box;
  min-width: 100%;
  scroll-snap-align: start;
}

.capital-dots {
  display: flex;
  justify-content: center;
  gap: 6px;
}

.capital-dots button {
  width: 6px;
  height: 6px;
  min-width: 0;
  padding: 0;
  border-radius: 999px;
  background: linear-gradient(110deg, color-mix(in srgb, #8390a1 48%, var(--border)), var(--border));
  transition: width 160ms ease, background 160ms ease;
}

.capital-dots button.active {
  width: 19px;
  background: linear-gradient(100deg, #ffe0ad, #d8894d);
}

.capital-hero.waiting {
  border-color: color-mix(in srgb, var(--bad) 45%, var(--border));
  background:
    radial-gradient(ellipse at 85% 12%, color-mix(in srgb, var(--bad) 8%, transparent), transparent 38%),
    linear-gradient(115deg, color-mix(in srgb, #392c39 18%, var(--panel)), color-mix(in srgb, var(--bad) 4%, var(--panel)));
}

.capital-hero.recovered {
  border-color: color-mix(in srgb, var(--ok) 36%, var(--border));
  background:
    radial-gradient(ellipse at 85% 12%, color-mix(in srgb, var(--ok) 8%, transparent), transparent 38%),
    linear-gradient(115deg, color-mix(in srgb, #263a38 19%, var(--panel)), color-mix(in srgb, var(--ok) 4%, var(--panel)));
}

.capital-copy {
  position: relative;
  z-index: 1;
}

.capital-overline {
  color: var(--muted);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.capital-title {
  margin-top: 9px;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}

.capital-value {
  margin-top: 2px;
  color: var(--bad);
  font-size: clamp(29px, 7vw, 40px);
  font-weight: 750;
  letter-spacing: -0.035em;
  line-height: 1.15;
}

.capital-hero.recovered .capital-value {
  color: var(--ok);
}

.capital-hero.balanced .capital-value {
  color: var(--text);
}

.capital-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--bad) 38%, transparent);
  border-radius: 999px;
  background: linear-gradient(110deg, color-mix(in srgb, var(--bad) 9%, transparent), color-mix(in srgb, #826077 5%, transparent));
  color: var(--bad);
  font-size: 10px;
  font-weight: 650;
}

.capital-hero.recovered .capital-status {
  border-color: color-mix(in srgb, var(--ok) 27%, transparent);
  background: linear-gradient(110deg, color-mix(in srgb, var(--ok) 8%, transparent), color-mix(in srgb, #5c87a0 6%, transparent));
  color: var(--ok);
}

.capital-hero.balanced .capital-status {
  border-color: var(--border);
  background: linear-gradient(135deg, color-mix(in srgb, #29313d 20%, var(--panel)), var(--panel));
  color: var(--muted);
}

.capital-copy p {
  margin: 9px 0 0;
  color: var(--muted);
  font-size: 10px;
}

.capital-orbit {
  display: flex;
  width: 112px;
  height: 112px;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border));
  border-radius: 50%;
  background:
    radial-gradient(circle at 32% 25%, color-mix(in srgb, #ffe0ad 6%, transparent), transparent 50%),
    linear-gradient(145deg, color-mix(in srgb, #29313d 35%, var(--panel)), color-mix(in srgb, #2c211b 25%, var(--panel)));
  box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 5%, transparent), 0 0 24px color-mix(in srgb, var(--accent) 9%, transparent);
}

.capital-orbit span,
.capital-orbit small {
  color: var(--muted);
  font-size: 9px;
}

.capital-orbit strong {
  display: block;
  width: 100%;
  max-width: 95px;
  overflow: hidden;
  margin: 5px 0 2px;
  color: var(--text);
  font-size: 14px;
  text-overflow: ellipsis;
  text-align: center;
  white-space: normal;
}

.capital-hero.waiting .capital-orbit strong {
  color: var(--bad);
}

.capital-hero.recovered .capital-orbit strong {
  color: var(--ok);
}

.c2c-panel {
  display: flex;
  min-height: 150px;
  flex-direction: column;
  justify-content: space-between;
  padding: 15px 17px 13px;
  border: 1px solid var(--border);
  border-radius: 15px;
  background:
    radial-gradient(ellipse at 90% 10%, color-mix(in srgb, var(--blue) 9%, transparent), transparent 42%),
    linear-gradient(145deg, var(--panel), color-mix(in srgb, var(--blue) 3%, var(--panel)));
}

.section-heading,
.section-heading > div {
  display: flex;
  align-items: baseline;
}

.section-heading {
  justify-content: space-between;
  gap: 12px;
}

.section-heading > div {
  gap: 9px;
}

.section-heading strong {
  font-size: 13px;
}

.section-heading span {
  color: var(--muted);
  font-size: 10px;
}

.c2c-order-count {
  white-space: nowrap;
}

.c2c-flow {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: center;
  gap: 12px;
  padding: 17px 0 13px;
}

.flow-side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.flow-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 10px;
}

.flow-label i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: linear-gradient(135deg, #b7f0c5, #52a98b);
}

.sell-flow .flow-label i {
  background: linear-gradient(135deg, #ffb58b, #cc5c77);
}

.sell-flow {
  padding-left: 15px;
  border-left: 1px solid var(--border);
}

.flow-side > strong {
  color: var(--text);
  font-size: clamp(16px, 4.5vw, 22px);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.flow-side > strong small {
  color: var(--muted);
  font-size: 9px;
  font-weight: 500;
}

.flow-fiat {
  color: var(--muted);
  font-size: 10px;
}

.c2c-footer {
  padding-top: 8px;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 9px;
}

.performance-section,
.charts-section {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.performance-section {
  gap: 9px;
}

.performance-heading,
.charts-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.performance-switcher {
  display: flex;
  width: 100%;
}

.performance-switcher,
.chart-switcher {
  border-color: color-mix(in srgb, var(--accent) 14%, var(--border));
  background:
    radial-gradient(ellipse at 20% 0%, color-mix(in srgb, #b1896b 10%, transparent), transparent 55%),
    linear-gradient(110deg, color-mix(in srgb, #29313d 32%, var(--panel)), color-mix(in srgb, #39291f 26%, var(--panel)));
}

.performance-switcher button,
.chart-switcher button {
  border: 0;
  background: transparent;
}

.performance-switcher button.active,
.chart-switcher button.active {
  background: linear-gradient(
    112deg,
    color-mix(in srgb, #ffd99e 25%, transparent) 0%,
    color-mix(in srgb, #ffc16b 15%, transparent) 52%,
    color-mix(in srgb, #f39a3f 9%, transparent) 100%
  );
  color: #ffd291;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent);
}

.chart-switcher {
  width: 100%;
  min-height: 38px;
  border-radius: 999px;
}

.chart-switcher button {
  flex: 1 1 0;
  padding: 0 8px;
  border-radius: 999px;
}

.breakdown-intro {
  display: flex;
  grid-column: 1 / -1;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 1px 2px 2px;
}

.breakdown-intro strong {
  color: var(--text);
  font-size: 11px;
}

.breakdown-intro span,
.breakdown-unavailable {
  color: var(--muted);
  font-size: 10px;
}

.breakdown-unavailable {
  margin: 0;
  padding: 18px 8px;
  text-align: center;
}

.performance-heading h2,
.charts-heading h2 {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
}

.performance-heading p,
.charts-heading p {
  margin: 0 0 2px;
  color: var(--muted);
  font-size: 12px;
  text-align: right;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px 9px;
}

.metric-card {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  min-height: 62px;
  padding: 8px 9px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  border-radius: 11px;
  background:
    radial-gradient(ellipse at 12% 0%, color-mix(in srgb, #7888a3 9%, transparent), transparent 62%),
    linear-gradient(145deg, color-mix(in srgb, #29313d 27%, var(--panel)), color-mix(in srgb, #39291f 24%, var(--panel)));
}

.metric-card .k {
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.02em;
}

.metric-card .v {
  margin: 4px 0 2px;
  color: var(--text);
  font-size: clamp(12px, 1.35vw, 14px);
  font-weight: 600;
  line-height: 1.15;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

.metric-card .sub {
  align-self: flex-start;
  margin-top: auto;
  color: var(--muted);
  font-size: 9px;
  line-height: 1.25;
  white-space: normal;
  text-align: left;
}

/* 只有「盈亏正负」这类数据才上色，其余中性 */
.metric-card.ok .v {
  color: var(--ok);
}

.metric-card.bad .v {
  color: var(--bad);
}

.income-breakdown {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px 18px;
  color: var(--muted);
  font-size: 11px;
  margin-top: -11px;
  text-align: right;
}

.chart-panel {
  position: relative;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 15px;
  background:
    radial-gradient(ellipse at 90% 0%, color-mix(in srgb, #8295ae 9%, transparent), transparent 45%),
    linear-gradient(145deg, color-mix(in srgb, #29313d 27%, var(--panel)), color-mix(in srgb, #39291f 22%, var(--panel)));
  padding: 12px 12px 9px;
}

.charts-section {
  gap: 10px;
}

.chart-switcher {
  overflow-x: auto;
  scrollbar-width: none;
}

.history-table-wrap,
.mobile-history-list {
  scrollbar-width: none;
}

.account-tabs::-webkit-scrollbar,
.capital-track::-webkit-scrollbar,
.chart-switcher::-webkit-scrollbar,
.history-table-wrap::-webkit-scrollbar,
.mobile-history-list::-webkit-scrollbar {
  display: none;
}

.chart-track {
  display: flex;
  overflow-x: auto;
  gap: 0;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}

.chart-track::-webkit-scrollbar {
  display: none;
}

.chart-slide {
  box-sizing: border-box;
  flex: 0 0 100%;
  min-width: 0;
  scroll-snap-align: start;
}

.chart-dots {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
}

.chart-dots button {
  width: 6px;
  height: 6px;
  min-width: 0;
  padding: 0;
  border-radius: 99px;
  background: linear-gradient(110deg, color-mix(in srgb, #8390a1 48%, var(--border)), var(--border));
  transition: width 160ms ease, background 160ms ease;
}

.chart-dots button.active {
  width: 20px;
  background: linear-gradient(100deg, #ffe0ad, #d8894d);
}

.chart-slide.chart-panel {
  min-width: 0;
  padding: 12px 14px;
}

.chart-slide .chart-heading > div {
  gap: 7px;
}

.breakdown-content {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.breakdown-group {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  border-radius: 10px;
  background: linear-gradient(145deg, color-mix(in srgb, #29313d 18%, var(--panel)), color-mix(in srgb, #39291f 16%, var(--panel)));
}

.breakdown-group > header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
}

.breakdown-group > header strong {
  color: var(--text);
  font-size: 10px;
}

.breakdown-group > header span,
.symbol-columns > div > small,
.breakdown-row small,
.concentration-cards small,
.concentration-cards span,
.breakdown-note,
.breakdown-empty {
  color: var(--muted);
  font-size: 9px;
  line-height: 1.35;
}

.symbol-breakdown,
.concentration-breakdown {
  grid-column: 1 / -1;
}

.symbol-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.breakdown-rows {
  display: grid;
  gap: 5px;
  margin-top: 5px;
}

.breakdown-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.breakdown-row > span {
  overflow: hidden;
  color: var(--text);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.breakdown-row > strong {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.breakdown-empty {
  margin: 5px 0 0;
}

.breakdown-note {
  margin: 7px 0 0;
}

.concentration-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.concentration-cards > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.concentration-cards > div > strong {
  color: var(--text);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.concentration-cards > div > span {
  overflow-wrap: anywhere;
}

.entry-reason-note {
  grid-column: 1 / -1;
  margin-top: -2px;
}

.small-chart {
  width: 100%;
  height: 230px;
}

.main-chart {
  padding: 10px 12px 8px;
}

.chart-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 10px;
}

.chart-heading > div {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.chart-heading strong {
  font-size: 12px;
  line-height: 1.35;
}

.chart-heading span {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.4;
}

.chart-empty {
  margin: 12px 0 4px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
}

.pnl-chart {
  width: 100%;
  height: 260px;
}

.quick-ranges {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 16px 0 14px;
}

.quick-ranges button {
  min-height: 34px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: linear-gradient(135deg, #17191d, #171513);
  color: var(--muted);
  font-size: 11px;
}

.quick-ranges button.active {
  border-color: var(--accent-line);
  background: linear-gradient(112deg, color-mix(in srgb, #ffd99e 19%, transparent), color-mix(in srgb, #f39a3f 8%, transparent));
  color: #ffd291;
}

.chart-empty {
  display: grid;
  min-height: 80px;
  place-items: center;
}

.date-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(3px);
}

.date-modal {
  width: min(360px, 100%);
  padding: 17px;
  border: 1px solid var(--border);
  border-radius: 16px;
  background:
    radial-gradient(ellipse at 90% 0%, color-mix(in srgb, #8295ae 11%, transparent), transparent 46%),
    linear-gradient(145deg, color-mix(in srgb, #29313d 43%, var(--panel)), color-mix(in srgb, #39291f 31%, var(--panel)) 58%, color-mix(in srgb, #253541 29%, var(--panel)));
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.48);
}

.history-mask {
  overflow-y: auto;
}

.history-modal {
  display: flex;
  width: min(900px, 100%);
  max-height: min(78vh, 760px);
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  background:
    radial-gradient(ellipse at 90% 0%, color-mix(in srgb, #8295ae 9%, transparent), transparent 44%),
    linear-gradient(145deg, color-mix(in srgb, #29313d 27%, var(--panel)), color-mix(in srgb, #39291f 21%, var(--panel)) 58%, color-mix(in srgb, #253541 20%, var(--panel)));
}

.history-head {
  flex: 0 0 auto;
}

.history-file-input {
  display: none;
}

.history-actions {
  display: flex;
  flex: 0 0 auto;
  justify-content: flex-end;
  gap: 8px;
}

.history-action-button {
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, #8295ae 42%, var(--border));
  border-radius: 9px;
  background: linear-gradient(
    120deg,
    color-mix(in srgb, #526079 30%, var(--panel-2)),
    color-mix(in srgb, #69452f 20%, var(--panel-2))
  );
  color: var(--text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.history-update-button {
  border-color: color-mix(in srgb, #d39a65 48%, var(--border));
  background: linear-gradient(
    120deg,
    color-mix(in srgb, #d39a65 20%, var(--panel-2)),
    color-mix(in srgb, #7895b4 17%, var(--panel-2))
  );
}

.history-action-button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.history-action-message {
  flex: 0 0 auto;
  margin: -3px 0 0;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
  text-align: right;
}

.history-table-wrap {
  min-height: 0;
  max-height: 40vh;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 11px;
}

.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  text-align: left;
}

.mobile-history-list {
  display: none;
}

.history-table th,
.history-table td {
  padding: 11px 12px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.history-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: linear-gradient(110deg, color-mix(in srgb, #526079 34%, var(--panel-2)), color-mix(in srgb, #69452f 24%, var(--panel-2)));
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
}

.history-table tbody tr:last-child td {
  border-bottom: 0;
}

.history-table tbody tr:hover:not(:has(.history-empty)) {
  background: linear-gradient(90deg, color-mix(in srgb, #d39a65 9%, transparent), color-mix(in srgb, #7895b4 5%, transparent));
}

.history-table td small {
  color: var(--muted);
  font-size: 9px;
}

.history-side {
  display: inline-flex;
  min-width: 39px;
  justify-content: center;
  font-size: 10px;
  font-weight: 650;
}

.history-side.buy {
  color: var(--ok);
}

.history-side.sell {
  color: var(--bad);
}

.history-order-id {
  max-width: 145px;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
}

.history-empty {
  height: 100px;
  color: var(--muted);
  text-align: center !important;
}

.history-pagination {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  font-size: 10px;
}

.history-pagination > div {
  display: flex;
  align-items: center;
  gap: 9px;
}

.history-pagination strong {
  color: var(--text);
  font-size: 10px;
  white-space: nowrap;
}

.history-pagination button {
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: linear-gradient(135deg, color-mix(in srgb, #526079 24%, var(--panel-2)), color-mix(in srgb, #69452f 18%, var(--panel-2)));
  color: var(--text);
  font-size: 10px;
}

.history-pagination button:disabled {
  opacity: 0.4;
}

.date-modal-head,
.calendar-head,
.date-modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.date-modal > .date-modal-head {
  margin: 0 0 14px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
}

.history-modal > .date-modal-head {
  margin: 0;
  padding: 0;
}

.calendar-grid {
  padding: 7px 5px;
  border: 1px solid color-mix(in srgb, #8295ae 24%, var(--border));
  border-radius: 12px;
  background:
    linear-gradient(145deg, #101216, #11100f);
}

.date-modal-head h3 {
  margin: 0;
  font-size: 15px;
}

.date-modal-head p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 11px;
}

.date-modal-head p span {
  padding: 0 5px;
  color: var(--accent);
}

.date-close,
.calendar-head button {
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: linear-gradient(135deg, color-mix(in srgb, #526079 24%, var(--panel-2)), color-mix(in srgb, #69452f 18%, var(--panel-2)));
  color: var(--text);
  font-size: 18px;
  cursor: pointer;
}

.clear-range:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.calendar-head {
  margin-bottom: 9px;
}

.calendar-head strong {
  font-size: 13px;
}

.calendar-head button {
  width: 28px;
  height: 28px;
  font-size: 21px;
  line-height: 1;
}

.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px 2px;
}

.weekday {
  padding: 5px 0;
  color: var(--muted);
  font-size: 10px;
  text-align: center;
}

.calendar-day {
  position: relative;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: linear-gradient(145deg, color-mix(in srgb, #526079 11%, #111316), color-mix(in srgb, #69452f 8%, #11100f));
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}

.calendar-day:hover {
  background: linear-gradient(135deg, color-mix(in srgb, #526079 22%, var(--panel-2)), color-mix(in srgb, #69452f 17%, var(--panel-2)));
}

.calendar-day.outside {
  color: var(--muted);
  opacity: 0.42;
}

.calendar-day.inRange {
  border-radius: 8px;
  background: linear-gradient(90deg, color-mix(in srgb, #d39a65 19%, transparent), color-mix(in srgb, #7895b4 12%, transparent));
}

.calendar-day.selected {
  border-radius: 9px;
  background: linear-gradient(115deg, #ffe0ad, #d8894d);
  color: #151515;
  font-weight: 700;
  opacity: 1;
}

.calendar-day.today:not(.selected)::after {
  position: absolute;
  right: 5px;
  bottom: 4px;
  left: 5px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, #ffe0ad, #d8894d);
  content: '';
}

.date-modal-actions {
  gap: 8px;
  margin-top: 14px;
}

.clear-range,
.apply-range {
  min-height: 35px;
  padding: 0 13px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: linear-gradient(135deg, color-mix(in srgb, #526079 24%, var(--panel-2)), color-mix(in srgb, #69452f 18%, var(--panel-2)));
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}

.apply-range {
  min-width: 86px;
  border-color: var(--accent);
  background: linear-gradient(110deg, #ffe0ad, #d8894d);
  color: #151515;
  font-weight: 600;
}

.config-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-field {
  display: grid;
  gap: 7px;
  color: var(--text);
  font-size: 12px;
}

.config-field small,
.config-rate {
  color: var(--muted);
  font-size: 10px;
}

.config-field input {
  font-size: 13px;
}

.currency-setting {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
}

.currency-setting legend {
  margin-bottom: 6px;
  color: var(--text);
  font-size: 12px;
}

.currency-setting label {
  display: flex;
  box-sizing: border-box;
  justify-content: center;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 32px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: linear-gradient(135deg, color-mix(in srgb, #526079 24%, var(--panel-2)), color-mix(in srgb, #69452f 18%, var(--panel-2)));
  color: var(--muted);
  font-size: 10px;
}

.currency-setting label.selected {
  border-color: var(--accent);
  color: var(--accent);
}

.currency-setting input {
  accent-color: var(--accent);
}

.config-rate {
  margin: -8px 0 0;
}

@media (max-width: 640px) {
  .account-stats {
    gap: 16px;
  }

  .account-switcher {
    gap: 5px;
  }

  .toolbar-actions {
    gap: 3px;
  }

  .account-tabs {
    gap: 6px;
  }

  .account-tabs button {
    gap: 0;
    min-width: 60px;
    padding: 4px 9px;
  }

  .account-tabs button small {
    display: none;
  }

  .account-tabs button span {
    max-width: 80px;
    font-size: 11px;
  }

  .history-trigger,
  .config-trigger,
  .date-trigger {
    width: 34px;
    height: 34px;
    padding: 7px;
  }

  .metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  .metric-card {
    min-height: 56px;
    padding: 7px 6px;
    border-radius: 9px;
  }

  .metric-card .k {
    font-size: 9px;
  }

  .metric-card .v {
    margin: 4px 0 2px;
    font-size: 12px;
  }

  .metric-card .sub {
    width: 100%;
    font-size: 8px;
    text-align: left;
  }

  .breakdown-content {
    grid-template-columns: minmax(0, 1fr);
  }

  .symbol-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: 9px;
  }

  .performance-heading,
  .charts-heading {
    align-items: center;
    flex-direction: row;
    gap: 8px;
  }

  .performance-heading h2,
  .charts-heading h2 {
    font-size: 12px;
  }

  .performance-heading p,
  .charts-heading p {
    font-size: 10px;
    text-align: right;
  }

  .chart-heading > div {
    align-items: flex-start;
    flex-direction: column;
    gap: 5px;
  }

  .capital-hero {
    min-height: 137px;
    padding: 18px;
  }

  .capital-orbit {
    width: 86px;
    height: 86px;
  }

  .capital-copy p {
    max-width: 220px;
    line-height: 1.4;
  }

  .c2c-panel {
    padding: 13px;
  }

  .c2c-flow {
    gap: 4px;
  }

  .flow-fiat {
    font-size: 9px;
  }

  .chart-track {
    gap: 0;
  }

  .chart-slide.chart-panel {
    padding: 12px 11px 10px;
  }

  .chart-heading {
    margin-bottom: 9px;
  }

  .small-chart {
    height: 185px;
  }

  .pnl-chart {
    height: 215px;
  }

  .history-modal {
    width: 100%;
    max-height: 90vh;
    gap: 10px;
    padding: 14px 12px;
  }

  .history-action-button {
    min-height: 32px;
    padding: 0 12px;
  }

  .history-action-message {
    text-align: left;
  }

  .history-table-wrap {
    display: none;
  }

  .mobile-history-list {
    display: grid;
    min-height: 0;
    max-height: 54vh;
    gap: 8px;
    overflow-y: auto;
    padding: 1px 2px 2px;
  }

  .mobile-history-card {
    min-width: 0;
    padding: 11px;
    border: 1px solid color-mix(in srgb, #8295ae 34%, var(--border));
    border-radius: 12px;
    background:
      radial-gradient(ellipse at 90% 0%, color-mix(in srgb, #8295ae 18%, transparent), transparent 48%),
      linear-gradient(145deg, color-mix(in srgb, #526079 45%, var(--panel)), color-mix(in srgb, #69452f 30%, var(--panel)) 58%, color-mix(in srgb, #253541 38%, var(--panel)));
  }

  .mobile-history-card > header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  }

  .mobile-history-card time {
    color: var(--text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .mobile-history-card .history-side {
    min-width: 45px;
    padding: 3px 8px;
    border: 1px solid currentColor;
    border-radius: 999px;
    background: linear-gradient(110deg, color-mix(in srgb, currentColor 12%, transparent), transparent);
  }

  .mobile-history-details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px 8px;
    padding: 9px 0;
  }

  .mobile-history-details > div {
    display: grid;
    min-width: 0;
    gap: 3px;
  }

  .mobile-history-details small,
  .mobile-history-card footer small {
    color: var(--muted);
    font-size: 9px;
  }

  .mobile-history-details strong {
    overflow: hidden;
    color: var(--text);
    font-size: 11px;
    font-weight: 550;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-history-card > footer {
    display: flex;
    min-width: 0;
    gap: 8px;
    padding-top: 7px;
    border-top: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  }

  .mobile-history-card > footer span {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--muted);
    font-size: 9px;
  }

  .mobile-history-empty {
    margin: 0;
    padding: 26px 8px;
    color: var(--muted);
    font-size: 11px;
    text-align: center;
  }

  .history-pagination {
    align-items: center;
    font-size: 9px;
  }

  .history-pagination > div {
    gap: 6px;
  }

  .history-pagination button {
    min-height: 30px;
    padding: 0 8px;
  }
}

@media (max-width: 380px) {
  .account-tabs button {
    padding-right: 6px;
    padding-left: 6px;
  }

  .account-tabs button span {
    max-width: 58px;
  }

  .toolbar-actions {
    gap: 3px;
  }

  .history-trigger,
  .config-trigger,
  .date-trigger {
    width: 32px;
    height: 32px;
    padding: 6px;
  }

  .capital-orbit {
    width: 78px;
    height: 78px;
  }

  .capital-orbit strong {
    max-width: 62px;
    font-size: 11px;
  }
}

@media (min-width: 641px) and (max-width: 1024px) {
  .metric-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .small-chart {
    height: 230px;
  }
}
</style>
