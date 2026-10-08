<script setup lang="ts">
/**
 * 「我的」页：页内分四段
 * （**交易所账户 / 复盘 / 个人信息 / 管理**）。
 *
 * 沿革（用户 2026-10-06 本轮改版，以最后一条为准）：
 *   · 「交易所账户移动到我的」→ 从「开单分析」的一级 tab 搬进来，排在**第一个**；
 *   · 「预测历史和知识库合放二级，一级叫做复盘」+「复盘不放在底下，
 *     放在交易所账户后面一个 tab」→ 紧跟交易所账户的第二格
 *     （`ReplayPane`，里面再分预测历史 / 知识库）；
 *   · 「模型配置移动到个人信息」→ 并进「个人信息」（`ProfileView` 的一段 tab），
 *     不再单独占一格。
 * 旧版那五段（预测历史 / 知识库 / 模型配置 / 个人信息 / 管理）见 git 历史。
 *
 * ⚠️ 子页用 **`?p=`** 记。老链接（`?p=records|kb|history`）由 `router.ts` 换成
 *    `?p=replay&r=…`；`?p=llm|usage` 在这里映射成「个人信息」（模型配置已经进去了）。
 *    复盘的二级 tab 用 **`?r=`** 记（`ReplayPane` 自己管）。
 *    「管理」里的二级 tab 用 `?t=` 记，`/me?p=admin&t=server` 分享出去能直接落在服务器那半。
 */
import {computed, onActivated, onDeactivated, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {useScrollMemory} from '../scroll'
import PaneShell from '../comps/PaneShell.vue'
import ExchangeAccountLivePanel from '../comps/ExchangeAccountLivePanel.vue'
import ReplayPane from './ReplayPane.vue'
import ProfileView from './ProfileView.vue'
import AdminView from './AdminView.vue'
import {user} from '../session'

type Pane = 'exchange' | 'replay' | 'profile' | 'admin'

/** 「管理」里那两半 */
export type AdminTab = 'users' | 'server'

/**
 * 一级 tab。用户 2026-10-06：「将交易所账户放到第一个」「复盘…放在交易所账户后面」。
 * 顺序：交易所账户 / 复盘 / 个人信息 / 管理（管理只有管理员看得到）。
 */
const PANES: {value: Pane; label: string}[] = [
  {value: 'exchange', label: '交易所账户'},
  {value: 'replay', label: '复盘'},
  {value: 'profile', label: '个人信息'},
  // 只有管理员看得到。里面还有二级 tab：用户管理 / 服务器
  {value: 'admin', label: '管理'}
]

/** 非管理员看不到「管理」那一段 */
const panes = computed(() =>
  PANES.filter(p => p.value !== 'admin' || Boolean(user.value?.isAdmin))
)

const route = useRoute()
const router = useRouter()

/** 解析 `?p=`；不认识的都落到「交易所账户」 */
function readPane(v: unknown): Pane {
  // ⚠️ 老链接兼容：模型配置 / 用量都并进了「个人信息」；
  //    预测历史 / 知识库由 `router.ts` 换成 `?p=replay&r=…`（这里再兜一层，别渲染出空白）。
  if (v === 'llm' || v === 'usage') return 'profile'
  if (v === 'records' || v === 'kb' || v === 'history') return 'replay'
  if (v === 'status') return 'admin'
  if (v === 'exchange' || v === 'replay' || v === 'profile' || v === 'admin')
    return v
  return 'exchange'
}

/** 管理页里当前看的是哪一半；只有 `?t=server` 才算服务器，其余都当用户管理 */
function readAdminTab(v: unknown): AdminTab {
  return v === 'server' ? 'server' : 'users'
}

const pane = ref<Pane>(readPane(route.query.p))

/*
 * 滚动位置记忆（用户 2026-10-07：「交易所页面滚动条加缓存」）。
 *
 * ⚠️ 必须挂在**这一页**上：`<KeepAlive>` 停用「我的」时会把 DOM 整棵**摘出文档**
 *    再插回来，`scrollTop` 那时已经归零。交易所那一格有两个滚动容器
 *    —— `PaneShell` 的 `.tabpane-body`（整页）和板子里的 `.tabs-body`（列表，
 *    窄屏每 20 条铺一批）—— 都在这个根节点底下，`../scroll` 那套
 *    「捕获阶段记 + 激活时挨个摆回去」一次把两个都管了
 *    （跟合约页 / 开单分析页同一套）。
 *
 * ⚠️ 根节点是 `PaneShell` 这个**组件**（页面最外层就是它，没有多余包装），
 *    所以取它的 `$el`（`.tabpane` 那个 div）—— `../scroll` 要的是真元素。
 */
const rootRef = ref<{$el?: HTMLElement} | null>(null)
useScrollMemory(() => rootRef.value?.$el ?? null)
const adminTab = ref<AdminTab>('users')

/**
 * 交易所账户那一格**只要进来过一次就一直留着**（`v-show` 藏起来，不卸载）。
 *
 * 用户 2026-10-06：「为什么进入时有正在获取交易快照」「该页面要做缓存」——
 * 以前这里是 `v-if`，每次切回来都重新挂载：重新拉 Key、重新读库、
 * 重新订阅 SSE，中间那段就是「正在取账户快照…」。
 * 现在第一次进来才挂载，之后数据（和图表实例）都留着，切回去是**原地接着看**。
 *
 * ⚠️ 代价：组件活着 ⇒ 两条 SSE 不会自己停。所以给它传 `:active`，
 *    由它自己在切走时停流、切回来时重连（见 `ExchangeAccountLivePanel.startWork`）。
 */
/**
 * 这一页现在是不是**当前页**。
 *
 * ⚠️ 2026-10-06 给 `<KeepAlive>` 的名单里加了 `MeView`（用户：「交易所页面是 me 吗
 *    加页面缓存」）—— 从此切到「合约 / 开单分析」时这一页**不再卸载**，好处是切回来
 *    不用重新拉 Key / 读库 / 订阅 SSE，`?p=` 那段也原地保留。
 *    代价是子页里那些**订阅和定时器不会自己停**，所以必须自己盯住真正的「在场」：
 *    `onActivated` / `onDeactivated` 是 KeepAlive 的进出信号，比看路由可靠
 *    （「合约」页也是这么干的，见 `ContractsView` 的 `pageAlive`）。
 */
const pageAlive = ref(true)
onActivated(() => {
  pageAlive.value = true
})
onDeactivated(() => {
  pageAlive.value = false
})

const exchangeMounted = ref(pane.value === 'exchange')
watch(pane, p => {
  if (p === 'exchange') exchangeMounted.value = true
})

function applyRoute(): void {
  const raw = route.query.p
  // 「管理」只有管理员能进（`panes` 里本来就没这一格，但地址栏可以直接写）。
  // ⚠️ `user` 还没就绪时（null）**不要**踢走 —— 先按地址栏来，真不是管理员的话
  //    管理接口会 403，那种「闪一下又跳走」反而更费解。
  if (
    (raw === 'admin' || raw === 'status') &&
    user.value &&
    !user.value.isAdmin
  ) {
    pane.value = 'exchange'
    adminTab.value = 'users'
    return
  }
  pane.value = readPane(raw)
  // 老链接：`?p=status` 以前是独立的一格，现在直接落在「管理 → 服务器」
  // （它没有 `?t=`，所以要单独兜一下）
  adminTab.value = raw === 'status' ? 'server' : readAdminTab(route.query.t)
}

applyRoute()

// 浏览器前进 / 后退、以及老书签（`/me?p=records&id=1` 之类）都要跟上
watch([() => route.query.p, () => route.query.t], applyRoute)

/** 只把字符串型的 query 带下去（`?id=` 那种要留着，抽屉靠它自动弹） */
function writeQuery(p: Pane, t: AdminTab): void {
  const q: Record<string, string> = {}
  for (const [k, val] of Object.entries(route.query)) {
    if (typeof val === 'string') q[k] = val
  }
  q.p = p
  // ⚠️ 二级 tab 只在「管理 → 服务器」时才写进地址栏，`?t=users` 是多余的
  if (p === 'admin' && t === 'server') q.t = 'server'
  else delete q.t
  // 复盘的二级 tab（`?r=`）只有停在这一格时才有意义，切走就顺手清掉
  if (p !== 'replay') delete q.r
  void router.replace({query: q})
}

function setPane(v: Pane): void {
  pane.value = v
  // 顺手写回地址栏，刷新 / 分享链接能停在原来那段
  writeQuery(v, adminTab.value)
}

function setAdminTab(v: AdminTab): void {
  adminTab.value = v
  writeQuery('admin', v)
}
</script>

<template>
  <PaneShell
    ref="rootRef"
    :class="{
      'no-bar': pane === 'exchange' || (pane === 'replay' && route.query.r === 'stats'),
      'stats-pane': pane === 'replay' && route.query.r === 'stats'
    }"
    :model-value="pane"
    :options="panes"
    @update:model-value="setPane"
  >
    <!--
      交易所账户：**缓存**（第一次进来才挂载，之后 `v-show` 藏着不卸载）——
      见 `exchangeMounted` 那段说明。切走时 `:active=false` 会把它的 SSE / 定时器停掉。
    -->
    <template v-if="exchangeMounted">
      <ExchangeAccountLivePanel
        v-show="pane === 'exchange'"
        :active="pane === 'exchange' && pageAlive"
      />
    </template>
    <!--
      其余几格：**切走这一格就卸载**，另外**离开这一页（`pageAlive=false`）也卸载** ——
      它们没有交易所那套「留着别重拉」的诉求（列表类，重挂一次很便宜），
      但各自的订阅 / 轮询必须停（`ServerStatusView` 就在轮询）。
    -->
    <ReplayPane v-if="pageAlive && pane === 'replay'" />
    <ProfileView v-else-if="pageAlive && pane === 'profile'" />
    <!-- 「管理」里再分两个 tab：用户管理 / 服务器；ServerStatusView 是 v-if 里挂的，
         切到用户管理那半就卸载 → 它自己的轮询和图表会一起停掉 -->
    <AdminView
      v-else-if="pageAlive && pane === 'admin'"
      :tab="adminTab"
      @update:tab="setAdminTab"
    />
  </PaneShell>
</template>

<style scoped>
/*
 * 交易所账户那一格：**不露滚动条**（用户 2026-10-06：
 * 「整体页面在移动端不要出现滚动条样式」→「该页面滚条样式不要出现」）。
 *
 * ⚠️ 滚动容器是 `PaneShell` 的 `.tabpane-body`（子组件里的元素），
 *    所以要用 `:deep()`；类名挂在 `PaneShell` 根上（`no-bar`）。
 * ⚠️ 只在这一格关掉 —— 其它几格（复盘 / 个人信息 / 管理）的滚动条不动。
 */
.tabpane.no-bar :deep(.tabpane-body) {
  scrollbar-width: none;
}
.tabpane.no-bar :deep(.tabpane-body::-webkit-scrollbar) {
  display: none;
}
.tabpane.stats-pane :deep(.tabpane-body) {
  padding-bottom: calc(var(--tabbar-h, 59px) + env(safe-area-inset-bottom) + 18px);
}
</style>
