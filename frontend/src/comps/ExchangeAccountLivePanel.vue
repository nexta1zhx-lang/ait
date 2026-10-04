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
 * ⚠️ 跟老容器（`ExchangeAccountPanel.vue`）的区别：老的把 5 个交易所调用塞进
 *    一个请求、每次都要现拉；这个首屏只读库，慢的东西拆开按需查。
 */
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'
import ExchangeAccountBoard from './ExchangeAccountBoard.vue'
import {
  exchangeStream,
  fetchExchangeFills,
  fetchExchangeKeys,
  fetchExchangeOpenOrders,
  fetchExchangeOverview,
  isAuthError,
  refreshExchangeOverview,
  type ExchangeIncomeRow,
  type ExchangeKey,
  type ExchangeOpenOrder,
  type ExchangeOverview,
  type ExchangeSnapshotResult,
  type ExchangeTrade
} from '../api'

/** 快照超过这么久就后台刷一次（后端采样是 5 分钟，这里更积极一点） */
const REFRESH_AFTER_SEC = 60
/** 成交列表最多留多少条 */
const FILLS_MAX = 60

const keys = ref<ExchangeKey[]>([])
const picked = ref<number | undefined>(undefined)

const data = ref<ExchangeOverview | null>(null)
/** 「没有数据」的原因（现货 / 没填 key / 还没采过）—— 有值时界面直接说原因 */
const reason = ref('')
const err = ref('')

const refreshing = ref(false)
/** SSE 连上过（界面角上点一下「实时」） */
const live = ref(false)

const openOrders = ref<ExchangeOpenOrder[]>([])
const ordersErr = ref('')
const loadingOrders = ref(false)

const fills = ref<ExchangeTrade[]>([])

/** 已实现盈亏 = 账本里带 realized 的那些（一笔成交一条） */
const income = computed<ExchangeIncomeRow[]>(() =>
  fills.value
    .filter(f => Number(f.realized ?? 0) !== 0)
    .map(f => ({symbol: f.symbol, income: Number(f.realized), time: f.datetime}))
)

const loading = computed(() => !data.value && !reason.value && !err.value)

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 把一份快照结果贴到界面上（`noSnapshot` 不算错误，是把原因说出来） */
function applySnapshot(r: ExchangeSnapshotResult): void {
  if (r.noSnapshot) {
    reason.value = r.reason ?? '这个账户暂时没有数据'
    data.value = null
    return
  }
  if (r.err) {
    err.value = `上次采集不完整：${r.err}`
  } else {
    err.value = ''
  }
  reason.value = ''
  if (r.overview) data.value = r.overview
}

/** 去拉一次新的（慢，~2 秒）。⚠️ 并发保护：SSE 和轮询可能同时想刷 */
async function doRefresh(id: number | undefined = picked.value): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    applySnapshot(await refreshExchangeOverview(id))
  } catch (e) {
    if (isAuthError(e)) return
    err.value = `刷新失败：${msg(e)}`
  } finally {
    refreshing.value = false
  }
}

async function loadSnapshot(id: number | undefined): Promise<void> {
  try {
    const r = await fetchExchangeOverview(id)
    applySnapshot(r)
    /*
     * 旧了就后台刷 —— 用户看到的是上一份快照（可能几小时前的），
     * 但界面不空等，数字一会儿自己会变。
     * `canRefresh` 为 false 的是「刷也没用」的两种情况（现货 / 没填 key）。
     */
    const stale = !r.noSnapshot && (r.ageSec ?? 0) > REFRESH_AFTER_SEC
    if ((stale || r.noSnapshot) && r.canRefresh !== false) void doRefresh(id)
  } catch (e) {
    if (isAuthError(e)) return
    err.value = `读取快照失败：${msg(e)}`
  }
}

async function loadFills(id: number | undefined): Promise<void> {
  try {
    fills.value = (await fetchExchangeFills(id, FILLS_MAX)).fills ?? []
  } catch (e) {
    if (!isAuthError(e)) err.value = `读取成交失败：${msg(e)}`
  }
}

async function loadOrders(id: number | undefined): Promise<void> {
  loadingOrders.value = true
  ordersErr.value = ''
  try {
    const r = await fetchExchangeOpenOrders(id)
    openOrders.value = r.openOrders ?? []
    ordersErr.value = r.error ?? ''
  } catch (e) {
    if (!isAuthError(e)) ordersErr.value = msg(e)
  } finally {
    loadingOrders.value = false
  }
}

/* ---------------- SSE ---------------- */

let stopStream: (() => void) | null = null

function startStream(id: number | undefined): void {
  stopStream?.()
  stopStream = exchangeStream(id, {
    snapshot: r => {
      live.value = true
      applySnapshot(r)
    },
    fill: t => {
      live.value = true
      // 同一笔可能「实时事件」和「REST 回补」都给到 → 按 tradeId 去重
      if (fills.value.some(f => f.id === t.id)) return
      fills.value = [t, ...fills.value].slice(0, FILLS_MAX)
    },
    backfill: () => void loadFills(id),
    reject: r => {
      /*
       * 这套账户不参与统计（现货 / 没填 key）。⚠️ **必须把订阅关掉** ——
       * `liveSse` 不知道「这条流永远不会有数据」，EventSource 会一直重连。
       */
      reason.value = r
      data.value = null
      live.value = false
      stopStream?.()
      stopStream = null
    },
    reconnect: () => {
      void loadSnapshot(id)
      void loadFills(id)
    }
  })
}

/* ---------------- 换账户 ---------------- */

watch(picked, id => {
  data.value = null
  reason.value = ''
  err.value = ''
  openOrders.value = []
  ordersErr.value = ''
  fills.value = []
  live.value = false
  void loadSnapshot(id)
  void loadFills(id)
  void loadOrders(id)
  startStream(id)
})

onMounted(async () => {
  try {
    keys.value = (await fetchExchangeKeys()).keys ?? []
  } catch (e) {
    if (!isAuthError(e)) err.value = `读取账户列表失败：${msg(e)}`
    return
  }
  if (!keys.value.length) return
  const def = keys.value.find(k => k.isDefault) ?? keys.value[0]
  picked.value = def.id
})

onUnmounted(() => {
  stopStream?.()
  stopStream = null
})
</script>

<template>
  <div class="live">
    <div v-if="keys.length > 1" class="bar">
      <select v-model.number="picked" aria-label="选择账户">
        <option v-for="k in keys" :key="k.id" :value="k.id">
          {{ k.name }}（{{ k.marketType === 'swap' ? '合约' : '现货' }}）
        </option>
      </select>
    </div>

    <div class="stat">
      <span v-if="refreshing" class="dim tiny">
        <span class="spin" />刷新中…
      </span>
      <span v-else-if="live" class="dot" title="正在接收实时推送">
        实时已连
      </span>
      <span class="spacer" />
      <button class="ghost tiny" :disabled="refreshing" @click="doRefresh()">
        刷新
      </button>
    </div>

    <p v-if="err" class="err">{{ err }}</p>

    <section v-if="!keys.length && !loading" class="panel empty">
      还没有配置交易所 API Key —— 去「我的 → 个人信息 → 交易所」加一套。
    </section>
    <section v-else-if="reason" class="panel empty">
      {{ reason }}
    </section>
    <ExchangeAccountBoard
      v-else
      :data="data"
      :open-orders="openOrders"
      :trades="fills"
      :income="income"
      :loading-orders="loadingOrders"
      @refresh="doRefresh()"
    />

    <p v-if="ordersErr" class="dim tiny">挂单查询失败：{{ ordersErr }}</p>
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
.bar select {
  width: 100%;
  padding: 7px 9px;
  font-size: 13px;
}
.stat {
  display: flex;
  align-items: center;
  gap: 8px;
}
.stat .dot {
  font-size: 11.5px;
  color: var(--ok, #5eba89);
}
.stat .dot::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--ok, #5eba89);
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
