<script setup lang="ts">
/**
 * 服务器监测（「我的 → 管理 → 服务器」）。
 *
 * 数据来自 `GET /api/server-status`（见 `backend/src/system.ts`）——
 * 后端只给**当下这一瞬**，曲线是这里按秒轮询、自己攒出来的（只留最近 3 分钟）。
 *
 * echarts 走**按需引入**（`echarts/core` + 用到的图表/组件）。
 * ⚠️ 别改成 `import * as echarts from 'echarts'`，那样会把整个 echarts 打进包里。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch
} from 'vue'
import {C, darkTooltip, echarts, type ECharts} from '../chart-theme'
import {fetchServerStatus, type ServerStatus} from '../api'
import {bjTime, int} from '../format'

/** 轮询间隔（毫秒）—— 后端每 5 秒采一个点，跟它对齐就行 */
const POLL_MS = 5000

/**
 * 曲线看多长（分钟）—— **固定值，不给选**。
 *
 * 用户 2026-10-04：「服务器图表选择周期去掉」。
 * 30 分钟 = 360 个点，画在常见的 400~900px 宽上大约 1~2px 一个，正合适。
 */
const WINDOW_MIN = 30

/** 跟项目主题一套色（style.css 的 --ok / --bad / --blue …）
 *  —— 现在统一从 `chart-theme.ts` 取，不在这里再抄一份 */

const s = ref<ServerStatus | null>(null)
const error = ref('')
const auto = ref(true)
const updatedAt = ref<number | null>(null)

const cpuEl = ref<HTMLElement | null>(null)
const memEl = ref<HTMLElement | null>(null)
const cpuChart = shallowRef<ECharts | null>(null)
const memChart = shallowRef<ECharts | null>(null)

let timer: number | null = null
let ro: ResizeObserver | null = null

/* ---------------- 小工具 ---------------- */

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

function dur(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分 ${sec % 60} 秒`
}

/** 使用率上色：<70 正常，<90 警告，否则危险 */
function toneOf(p: number | null | undefined): string {
  if (p === null || p === undefined) return ''
  if (p >= 90) return 'bad'
  if (p >= 70) return 'warn'
  return 'ok'
}

const overallOk = computed(() => Boolean(s.value?.db.ok))
/** 首屏还没拿到数据（且没有报错）—— 这会儿显 loading，别显「异常」 */
const loading = computed(() => !s.value && !error.value)

/* ---------------- 拉数 ---------------- */

async function load(manual = false): Promise<void> {
  try {
    /*
     * 曲线**全部来自后端的历史**（`?minutes=`）——
     * 前端不再自己攒点：那样选「1 小时」得等一小时，切走再回来还清零。
     */
    s.value = await fetchServerStatus(WINDOW_MIN)
    updatedAt.value = Date.now()
    error.value = ''
    render()
  } catch (e) {
    error.value = (e as Error).message || '取服务器状态失败'
    // 手动点的才打断自动刷新，自己挂的就静默重试
    if (manual) auto.value = false
  }
}

/* ---------------- 图表 ---------------- */

function render(): void {
  const h = s.value?.history ?? []
  // 还没采到点：先清空，不 setOption 出一张空坐标轴（首次启动的头几秒会有）
  if (!h.length) {
    cpuChart.value?.clear()
    memChart.value?.clear()
    return
  }
  /**
   * 轴上的时间：`HH:mm:ss`。
   *
   * 用户 2026-10-04：「坐标显示时间吧」—— 轴只要时分秒，日期不占地方；
   * 但不带日期又分不清哪天，所以**跨天**的那个点单独加上 `MM-DD`（窗口最多 1 小时，
   * 只有跨过零点时才会出现这种点）。完整时间在 tooltip 里。
   */
  const day0 = h.length ? new Date(h[0].t + 8 * 3600_000).getUTCDate() : 0
  function axisTime(v: number): string {
    const d = new Date(v + 8 * 3600_000) // 北京时间
    const p2 = (n: number) => String(n).padStart(2, '0')
    const hm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
    return d.getUTCDate() === day0
      ? hm
      : `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${hm}`
  }
  const xs = h.map(p => axisTime(p.t))
  /** tooltip 的标题时间 —— 跟轴一个口径 */
  const tipAt = (i: number): string => (h[i] ? axisTime(h[i].t) : '')

  /*
   * ⚠️ X 轴这里是 **`category`**，不是 `time`。
   *
   * 试过 `type: 'time'` + `data: [[t, v]]`：option 全对（`show: true`、颜色、
   * `formatter` 都能从 `getOption()` 里读回来），但 echarts **一个标签都不画**，
   * 连 `grid.bottom` 加到 60 也一样（Y 轴正常）。
   * 回到 `category` 并**显式给 `interval`** 才稳定出标签。
   *
   * ⚠️ 并且**绝对不能加 `hideOverlap: true`** —— 实测在点密（5 秒一个）时
   *    它会把标签判成互相重叠然后**全部隐藏**，轴上一个字都没有。
   *    自己算 `interval`（最多 6 个标签）更可靠。
   */
  const xAxis = {
    type: 'category' as const,
    boundaryGap: false,
    data: xs,
    axisLabel: {
      show: true,
      color: C.text,
      fontSize: 10,
      margin: 8,
      interval: Math.max(0, Math.ceil(xs.length / 6) - 1)
    },
    axisLine: {lineStyle: {color: C.grid}},
    axisTick: {show: false},
    splitLine: {show: false}
  }
  const dark = {
    textStyle: {color: C.text},
    grid: {left: 46, right: 14, top: 26, bottom: 30, containLabel: false}
  }

  cpuChart.value?.setOption({
    ...dark,
    tooltip: {
      ...darkTooltip,
      trigger: 'axis',
      formatter: (
        ps: {dataIndex: number; seriesName?: string; value?: number}[]
      ) => {
        const i = ps?.[0]?.dataIndex
        if (i === undefined) return ''
        // ⚠️ `category` 轴的 `value` 是**标量**（不是 `[时间, 值]`）——
        //    这里取 `value[1]` 会直接显示 `undefined`（改回 category 时漏改过）
        const rows = ps.map(x => `${x.seriesName}：${x.value}%`)
        return `${tipAt(i)}<br/>${rows.join('<br/>')}`
      }
    },
    legend: {
      data: ['CPU', '内存'],
      right: 4,
      top: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: {color: C.text, fontSize: 11}
    },
    xAxis,
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: {color: C.text, fontSize: 10, formatter: '{value}%'},
      splitLine: {lineStyle: {color: C.grid}}
    },
    series: [
      {
        name: 'CPU',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: h.map(p => p.cpu),
        lineStyle: {color: C.blue, width: 1.6},
        areaStyle: {color: 'rgba(66,165,245,.14)'}
      },
      {
        name: '内存',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: h.map(p => p.mem),
        lineStyle: {color: C.ok, width: 1.6},
        areaStyle: {color: 'rgba(38,166,154,.12)'}
      }
    ]
  })

  memChart.value?.setOption({
    ...dark,
    tooltip: {
      ...darkTooltip,
      trigger: 'axis',
      formatter: (
        ps: {dataIndex: number; seriesName?: string; value?: number}[]
      ) => {
        const i = ps?.[0]?.dataIndex
        if (i === undefined) return ''
        const rows = ps.map(x => `${x.seriesName}：${x.value} MB`)
        return `${tipAt(i)}<br/>${rows.join('<br/>')}`
      }
    },
    legend: {
      data: ['RSS', 'Heap'],
      right: 4,
      top: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: {color: C.text, fontSize: 11}
    },
    xAxis,
    yAxis: {
      type: 'value',
      axisLabel: {color: C.text, fontSize: 10, formatter: '{value}M'},
      splitLine: {lineStyle: {color: C.grid}}
    },
    series: [
      {
        name: 'RSS',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: h.map(p => p.rss),
        lineStyle: {color: C.violet, width: 1.6},
        areaStyle: {color: 'rgba(167,139,250,.12)'}
      },
      {
        name: 'Heap',
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: h.map(p => p.heap),
        lineStyle: {color: C.warn, width: 1.4}
      }
    ]
  })

  // 开发期调试钩子：浏览器控制台里能直接摸到图实例（生产构建会被摇掉）
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>
    w.__cpu = cpuChart.value
    w.__mem = memChart.value
  }
}

/** 首帧建图（容器这时才有尺寸） */
function initCharts(): void {
  // 容器没真实尺寸（藏着 / 布局未完成）时先别 init —— 否则 echarts 会刷一屏
  // 「Can't get DOM width or height」而且实例是坏的；等 ResizeObserver 报出尺寸再建
  const ready = (el: HTMLElement | null): el is HTMLElement =>
    !!el && el.clientWidth > 0 && el.clientHeight > 0
  if (ready(cpuEl.value) && !cpuChart.value) {
    cpuChart.value = echarts.init(cpuEl.value)
  }
  if (ready(memEl.value) && !memChart.value) {
    memChart.value = echarts.init(memEl.value)
  }
  render()
}

function onResize(): void {
  // 之前容器没尺寸、图还没建出来 → 这会儿可能露出来了，补建一次
  if (!cpuChart.value || !memChart.value) {
    initCharts()
    return
  }
  cpuChart.value.resize()
  memChart.value.resize()
}

// 换了窗口立刻重拉一次（后端会把那段历史一起回来，不用自己攒）
watch(auto, v => {
  if (v) void load()
})

onMounted(async () => {
  await load()
  /*
   * ⚠️ 必须等一个 tick 再建图。
   * `s` 一变，`<template v-if="s">` 那一大块是**下一个微任务**才挂到 DOM 上的，
   * `load()` 刚返回时 `.chart` 还在原处、“子孙”压根不存在，`echarts.init`
   * 会量到 0×0 并刷一屏 `Can't get DOM width or height`（而且这个实例是坏的）。
   */
  await nextTick()
  // 容器尺寸这会儿才稳定，建图放后面
  initCharts()
  // ⚠️ 用 ResizeObserver 而不是只监听 window：图表是跟着布局变的
  //    （比如切到别的子 tab 再切回来、抽屉展开）
  ro = new ResizeObserver(onResize)
  for (const el of [cpuEl.value, memEl.value]) {
    if (el) ro.observe(el)
  }
  window.addEventListener('resize', onResize)
  timer = window.setInterval(() => {
    if (auto.value) void load()
  }, POLL_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
  window.removeEventListener('resize', onResize)
  ro?.disconnect()
  cpuChart.value?.dispose()
  memChart.value?.dispose()
})
</script>

<template>
  <div class="status">
    <div class="st-head">
      <h2>服务器监测</h2>
      <template v-if="loading">
        <span class="dot" />
        <b class="dim">加载中…</b>
      </template>
      <template v-else>
        <span class="dot" :class="overallOk ? 'ok' : 'bad'" />
        <b :class="overallOk ? 'ok' : 'bad'">{{
          overallOk ? '运行正常' : '异常'
        }}</b>
      </template>
      <span class="when" v-if="updatedAt">
        {{ bjTime(updatedAt).slice(-8) }} 更新
      </span>
      <span class="spacer" />
      <label class="auto">
        <input v-model="auto" type="checkbox" />
        自动刷新
      </label>
      <button class="ghost tiny" @click="load(true)">刷新</button>
    </div>

    <p v-if="loading" class="loading">正在读取服务器状态…</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-if="s">
      <!-- 四张数：一眼看出哪一项快满了 -->
      <div class="cards">
        <div class="card">
          <span class="k">CPU 使用率</span>
          <span class="v" :class="toneOf(s.proc.cpuPct)"
            >{{ s.proc.cpuPct }}%</span
          >
          <span class="sub"
            >{{ s.host.cpuCount }} 核 · 负载
            {{ s.host.load[0].toFixed(2) }}</span
          >
        </div>
        <div class="card">
          <span class="k">内存使用率</span>
          <span class="v" :class="toneOf(s.host.memUsedPct)"
            >{{ s.host.memUsedPct }}%</span
          >
          <span class="sub">
            {{ bytes(s.host.memTotalB - s.host.memAvailB) }} /
            {{ bytes(s.host.memTotalB) }} · {{ s.host.memSource }}
          </span>
        </div>
        <div class="card">
          <span class="k">磁盘使用率</span>
          <span class="v" :class="toneOf(s.host.diskUsedPct)">
            {{ s.host.diskUsedPct === null ? '—' : s.host.diskUsedPct + '%' }}
          </span>
          <span class="sub">
            <template v-if="s.host.diskTotalB !== null">
              {{ bytes((s.host.diskTotalB ?? 0) - (s.host.diskFreeB ?? 0)) }} /
              {{ bytes(s.host.diskTotalB) }}
            </template>
            <template v-else>取不到</template>
          </span>
        </div>
        <div class="card">
          <span class="k">进程内存 (RSS)</span>
          <span class="v">{{ bytes(s.proc.rssB) }}</span>
          <span class="sub"
            >heap {{ bytes(s.proc.heapUsedB) }} /
            {{ bytes(s.proc.heapTotalB) }}</span
          >
        </div>
      </div>

      <!-- PC 上两块并排（≤900px 自动竖排）—— 用户 2026-10-04：「pc 上 cpu 和进程两列显示」 -->
      <div class="two">
        <div class="chart-box">
          <h3>
            CPU / 内存
            <span class="dim">最近 30 分钟 · 每 5 秒一个点</span>
          </h3>
          <div class="chart-holder">
            <div ref="cpuEl" class="chart" />
            <div v-if="!s.history.length" class="chart-overlay">
              <span class="spin" />
              等待采样…
            </div>
          </div>
        </div>
        <div class="chart-box">
          <h3>进程内存<span class="dim">MB</span></h3>
          <div class="chart-holder">
            <div ref="memEl" class="chart" />
            <div v-if="!s.history.length" class="chart-overlay">
              <span class="spin" />
              等待采样…
            </div>
          </div>
        </div>
      </div>

      <!-- 外围服务：docker 容器 + 监听端口 -->
      <div class="two">
        <section class="panel">
          <h3>
            Docker
            <span class="dim" v-if="s.services.docker.ok">
              {{ s.services.docker.items.length }} 个容器
            </span>
          </h3>
          <p v-if="!s.services.docker.ok" class="svc-none">
            取不到：{{ s.services.docker.error }}
          </p>
          <p v-else-if="!s.services.docker.items.length" class="svc-none">
            没有容器
          </p>
          <ul v-else class="svc">
            <li v-for="c in s.services.docker.items" :key="c.name">
              <span class="dot" :class="c.up ? 'ok' : 'bad'" />
              <b>{{ c.name }}</b>
              <span class="dim cut">{{ c.detail }}</span>
              <span class="spacer" />
              <span class="dim">{{ c.status }}</span>
            </li>
          </ul>
        </section>

        <section class="panel">
          <h3>
            监听端口
            <span class="dim" v-if="s.services.ports.ok">
              {{ s.services.ports.items.length }} 个
            </span>
          </h3>
          <p v-if="!s.services.ports.ok" class="svc-none">
            取不到：{{ s.services.ports.error }}
          </p>
          <p v-else-if="!s.services.ports.items.length" class="svc-none">
            没有监听
          </p>
          <ul v-else class="svc">
            <li
              v-for="(p, i) in s.services.ports.items"
              :key="`${p.name}-${p.detail}-${i}`"
            >
              <b>{{ p.name }}</b>
              <span class="dim cut">{{ p.detail }}</span>
              <span class="spacer" />
              <span class="dim">{{ p.status }}</span>
            </li>
          </ul>
        </section>
      </div>

      <div class="two">
        <section class="panel">
          <h3>主机</h3>
          <dl>
            <dt>主机名</dt>
            <dd>{{ s.host.hostname }}</dd>
            <dt>系统</dt>
            <dd>
              {{ s.host.platform }} {{ s.host.release }} ({{ s.host.arch }})
            </dd>
            <dt>CPU</dt>
            <dd>{{ s.host.cpuModel }} × {{ s.host.cpuCount }}</dd>
            <dt>负载</dt>
            <dd>
              {{ s.host.load[0].toFixed(2) }} /
              {{ s.host.load[1].toFixed(2) }} /
              {{ s.host.load[2].toFixed(2) }}
            </dd>
            <dt>开机时长</dt>
            <dd>{{ dur(s.host.uptimeSec) }}</dd>
            <dt>Node</dt>
            <dd>{{ s.proc.nodeVersion }} · PID {{ s.proc.pid }}</dd>
            <dt>进程运行</dt>
            <dd>{{ dur(s.proc.uptimeSec) }}</dd>
          </dl>
        </section>

        <section class="panel">
          <h3>数据库</h3>
          <p v-if="!s.db.ok" class="error">
            连不上：{{ s.db.error || '未知错误' }}
          </p>
          <dl v-else>
            <dt>版本</dt>
            <dd>{{ s.db.version }}</dd>
            <dt>库大小</dt>
            <dd>{{ bytes(s.db.sizeB) }}</dd>
            <dt>连接数</dt>
            <dd>{{ s.db.connections }} / {{ s.db.maxConnections }}</dd>
          </dl>
          <h3 class="mt">数据表</h3>
          <table class="tables">
            <tbody>
              <tr v-for="t in s.db.tables" :key="t.name">
                <td>{{ t.name }}</td>
                <td class="num">
                  {{ t.rows < 0 ? '（没有这张表）' : int(t.rows) }}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <p class="foot">
        每次采样耗时 {{ s.tookMs }} ms · 曲线由后端每 5 秒采一个点、滚动保留最近
        2 小时（只在进程内存里，不落库）
      </p>
    </template>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.st-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.st-head h2 {
  margin: 0;
  font-size: 16px;
}
.spacer {
  flex: 1 1 auto;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
}
.dot.ok {
  background: var(--ok);
}
.dot.bad {
  background: var(--bad);
}
.st-head b.ok {
  color: var(--ok);
  font-weight: var(--fw-bold);
}
.st-head b.bad {
  color: var(--bad);
  font-weight: var(--fw-bold);
}
.when {
  color: var(--muted);
  font-size: 12px;
}
.auto {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.card .k {
  color: var(--muted);
  font-size: 12px;
}
.card .v {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.card .v.ok {
  color: var(--ok);
}
.card .v.warn {
  color: var(--warn);
}
.card .v.bad {
  color: var(--bad);
}
.card .sub {
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.chart-box {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.chart-box h3 {
  margin: 0 0 6px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}
.chart-box .dim,
.foot {
  color: var(--muted);
  font-size: 11px;
  font-weight: normal;
}
.chart {
  height: 180px;
  min-width: 0;
}
.chart-holder {
  position: relative;
  min-width: 0;
}

/* 服务列表（docker 容器 / 监听端口） */
.svc {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12px;
  /* 端口动辄二三十条，限高自己滚 —— 否则这两个面板会把整页拉得很长 */
  max-height: 264px;
  overflow-y: auto;
  /* 同上：滚动条贴右边，内容离它 10px */
  padding-right: 10px;
  margin-right: -10px;
}
.svc li {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
}
.svc li:last-child {
  border-bottom: 0;
}
.svc b {
  font-weight: var(--fw-mid);
}
/* 镜像名 / 监听地址可能很长，让它先被挤掉 */
.svc .cut {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.svc .dot {
  align-self: center;
  flex: 0 0 auto;
}
.svc-none {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.two {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}
@media (max-width: 900px) {
  .two {
    grid-template-columns: minmax(0, 1fr);
  }
}

.panel {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.panel h3 {
  margin: 0 0 8px;
  font-size: 13px;
}
.panel h3.mt {
  margin-top: 14px;
}
.panel dl {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 4px 10px;
  margin: 0;
  font-size: 12px;
}
.panel dt {
  color: var(--muted);
}
.panel dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.tables {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.tables td {
  padding: 4px 0;
  border-bottom: 1px solid var(--border);
}
.tables tr:last-child td {
  border-bottom: 0;
}
.tables .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.foot {
  margin: 0;
}
</style>
