<script setup lang="ts">
/**
 * 「我的」页：把原来分散的几页收进来，页内分四段
 * （预测历史 / 知识库 / 用量 / 服务器）。
 *
 * 沿革（用户 2026-10-04 连着改了几轮，以最后一条为准）：
 *   ① 「历史 tab 改成我的，用量 tab 放进去合并，我的 tab 添加服务器监测」
 *      → 一级是「历史 / 用量 / 服务器」，「预测历史 / 知识库」是「历史」里的二级
 *   ② 「**历史去掉，预测历史和知识库直接一级**」
 *      → 去掉「历史」这一层，四段平铺
 *   ③ 「**服务器挪到管理界面 改为 tab 一个是用户管理 一个是服务器**」
 *      → 「服务器」不再是独立一格，并进「管理」里做**二级 tab**
 *        （只有管理员能进「管理」，所以服务器监测也归到管理员名下）
 *
 * ⚠️ 子页用 **`?p=`** 记（别用 `?tab=`）：`HistoryView` 里筛选栏那几个
 *    `SegTabs` 都吃自己的 ref、不占 query，`?tab=kb` 现在只剩**老链接兼容**
 *    （`router.ts` 里把 `/history?tab=kb` 转成 `/me?p=kb`）。
 *    「管理」里的二级 tab 用 `?t=` 记，`/me?p=admin&t=server` 分享出去能直接落在服务器那半。
 */
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import SegTabs from '../comps/SegTabs.vue'
import HistoryView from './HistoryView.vue'
import LlmConfigView from './LlmConfigView.vue'
import ProfileView from './ProfileView.vue'
import AdminView from './AdminView.vue'
import {user} from '../session'
import {useSwipeTabs} from '../swipe-tabs'

type Pane = 'records' | 'kb' | 'llm' | 'profile' | 'admin'

/** 「管理」里那两半 */
export type AdminTab = 'users' | 'server'

/**
 * 一级 tab。
 *
 * 用户 2026-10-04（最新一轮）：
 *   「用量移到此界面」→ **用量并进「模型配置」**，不再单独占一格；
 *   「新增个人信息界面，可以改信息和退出」→ 多一格「个人信息」。
 */
const PANES: {value: Pane; label: string}[] = [
  {value: 'records', label: '预测历史'},
  {value: 'kb', label: '知识库'},
  // 密钥（多把）+ 用量统计都在这里
  {value: 'llm', label: '模型配置'},
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

/** 解析 `?p=`；不认识的都落到「预测历史」 */
function readPane(v: unknown): Pane {
  // ⚠️ 老链接兼容：`?p=history` 是原来那个一级，现在等于「预测历史」；
  //    单独的「用量」已并进「模型配置」；「服务器」并进「管理」
  if (v === 'history') return 'records'
  if (v === 'usage') return 'llm'
  if (v === 'status') return 'admin'
  if (
    v === 'records' ||
    v === 'kb' ||
    v === 'llm' ||
    v === 'profile' ||
    v === 'admin'
  )
    return v
  return 'records'
}

/** 管理页里当前看的是哪一半；只有 `?t=server` 才算服务器，其余都当用户管理 */
function readAdminTab(v: unknown): AdminTab {
  return v === 'server' ? 'server' : 'users'
}

const pane = ref<Pane>('records')
const adminTab = ref<AdminTab>('users')

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
    pane.value = 'records'
    adminTab.value = 'users'
    return
  }
  pane.value = readPane(raw)
  // 老链接：`?p=status` 以前是独立的一格，现在直接落在「管理 → 服务器」
  // （它没有 `?t=`，所以要单独兜一下）
  adminTab.value = raw === 'status' ? 'server' : readAdminTab(route.query.t)
}

applyRoute()

// 浏览器前进 / 后退、以及老书签（`/history?id=1` → `/me?p=records&id=1`）都要跟上
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

/* ---------------- 窄屏：左右滑动切换一级 tab ---------------- */

/**
 * 手势区 = 整页 `.me`（tab 行 + 内容区）。
 *
 * 用户 2026-10-04：「一级 tab（底下一小段线那种）可滑动切换」。
 * ⚠️ 上面那排 `.me-tabs` 在窄屏是 `overflow-x: auto` 的**横向可滚**排
 *    （六个 tab 在 360px 上会溢出）—— 那种情况归它自己滚，`../swipe-tabs`
 *    里那条「能横滚的元素不抢」会自己挡下来，这里不用特殊处理。
 * 切开时走 `setPane`（而不是直接改 `pane`），地址栏的 `?p=` 会跟着走。
 */
const swipeRef = ref<HTMLElement | null>(null)
const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeTabs<Pane>({
  host: () => swipeRef.value,
  list: () => panes.value,
  current: () => pane.value,
  set: v => setPane(v)
})

/**
 * 切一级 tab 时内容「滑入」——跟「开单分析」那排一级 tab 同一套。
 *
 * 用户 2026-10-05：「我的里面 tab 也加上切换动画丝滑一点」。
 * 方向跟着 tab 顺序：**往后翻 = 从右滑入**（跟翻页 / 滑动同一个方向）。
 *
 * ⚠️ 只挂 260ms 的临时类：动画播完就摘。理由跟 `AnalyzeView` 那份一样：
 *   ① 不摘的话同一个方向连划两次，class 值不变，动画不会重播；
 *   ② `transform` 长期存在会变成 `fixed` 后代的「包含块」。
 */
const paneAnim = ref<'' | 'l' | 'r'>('')
let paneAnimTimer: number | null = null
watch(pane, (nv, ov) => {
  const i = panes.value.findIndex(p => p.value === nv)
  const j = panes.value.findIndex(p => p.value === ov)
  if (i < 0 || j < 0 || i === j) return
  paneAnim.value = i > j ? 'l' : 'r'
  if (paneAnimTimer) window.clearTimeout(paneAnimTimer)
  paneAnimTimer = window.setTimeout(() => (paneAnim.value = ''), 260)
})
onBeforeUnmount(() => {
  if (paneAnimTimer) window.clearTimeout(paneAnimTimer)
})

/*
 * ⚠️ 「历史」那一半里面还有自己的固定布局（`body.fixed-viewport .pane-kb` 那套），
 * 所以这个 class 一直得有。
 *
 * 用户 2026-10-04：「除了顶部 tab，其余内容都是单页滚动，在内容区滚动」——
 * 现在所有子页统一成「整页不滚，只有下面 .me-pane 自己滚」，
 * 所以**进来就开、离开才关**（不再按子页切）。
 *
 * ⚠️ `/me` 现在**也在 App.vue 的 `FIXED_VIEWPORT_PATHS` 里**：那条 watch 盯的是
 * `[route.path, user.id]`，但 vue-router 换 query（`?p=`）也会重跑它；
 * 它不在表里时会把这里的 class 一起 toggle 掉（切一次子页就丢，整页变回可滚）。
 * 这里再 add 一次只是首帧兜底，真正的开关交给 App.vue。
 */
onMounted(() => document.body.classList.add('fixed-viewport'))

/*
 * ⚠️ **卸载时不要 `remove`** —— App.vue 那个按 `route.path` 的 watch 同样在跑
 * （`/analyze`、`/contracts` 是要这个 class 的），它的回调比 `onBeforeUnmount`
 * 早执行，这里再 remove 一下会把刚加上的 class 抹掉，跳过去以后整页就变成能滚的了。
 * 离开 `/me` 时 App.vue 自己会 `toggle(false)`，够用。
 */
</script>

<template>
  <div
    ref="swipeRef"
    class="me"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchEnd"
  >
    <SegTabs
      class="me-tabs"
      :model-value="pane"
      :options="panes"
      @update:model-value="setPane"
    />
    <!--
      「预测历史」和「知识库」是**同一个组件**（`HistoryView`）的两半，
      靠 `pane` 属性切；它内部用 `v-show`，所以来回切时筛选/翻页/滚动都留着。
      用量 / 服务器是另外两页。
      用 v-if 而不是 v-show：切走就卸载，服务器监测那边的轮询和图表会自己停掉。
    -->
    <div class="me-pane" :class="paneAnim ? 'pane-' + paneAnim : ''">
      <HistoryView v-if="pane === 'records' || pane === 'kb'" :pane="pane" />
      <LlmConfigView v-else-if="pane === 'llm'" />
      <ProfileView v-else-if="pane === 'profile'" />
      <!-- 「管理」里再分两个 tab：用户管理 / 服务器；ServerStatusView 是 v-if 里挂的，
           切到用户管理那半就卸载 → 它自己的轮询和图表会一起停掉 -->
      <AdminView v-else :tab="adminTab" @update:tab="setAdminTab" />
    </div>
  </div>
</template>

<style scoped>
/*
 * 一屏铺满：顶部 tab 固定不动，下面的内容区自己滚（`overflow-y: auto`）。
 * 高度来自 `body.fixed-viewport #app`（`height: 100vh` 的 flex 列）——
 * `.me` 用 `flex: 1 1 auto` 把剩余高度全占了，`min-height: 0` 是必须的，
 * 否则 flex 子项不肯缩，`overflow` 就不生效、又变回整页滚。
 */
.me {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.me-tabs {
  flex: 0 0 auto;
}
.me-pane {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 滑到头别把滚动传递给整页 */
  overscroll-behavior: contain;
  scrollbar-width: thin;
  /*
   * 滚动条**贴容器右边**，但内容跟它拉开距离 ——
   * 用户 2026-10-04：「滚动条靠边和内容区保持距离」。
   *
   * 单个 `padding-right` 会把滚动条也一起往里推（那不是要的效果），
   * 所以再加一个等量的负 `margin-right` 把它推回边上：
   * 净效果 = 轨道在容器边缘、内容离轨道 12px。
   */
  padding-right: 12px;
  margin-right: -12px;
}

/*
 * 手机上这一排（历史 / 用量 / 服务器）走**底部横线**样式 ——
 * 用户 2026-10-04：「历史用量服务器移动端 tab 改为底部横线 tab」。
 *
 * 做法跟「开单分析」那排一级 tab（`style.css` 的 `.tab-row .seg`）**逐条对齐**：
 * 不要框、不要底色、靠左排，活动项底下一条 2px 短线；
 * ⚠️ **整排不要 `border-bottom`** —— 用户 2026-10-04：「一级 tab 不需要底部一条横线，
 *   类似滑轨那样」：只有活动项那一段短线，像滑块一样跟着走。
 * （下面「预测历史 / 知识库」那一排则是背景块，两级 tab 一眼能分开。）
 *
 * ⚠️⚠️ **里面的 `<button>` 必须用 `:deep()`** —— 它们长在 `SegTabs.vue` 里，
 *   而 scoped 样式编译出来是 `.me-tabs button[data-v-meview]`，
 *   子组件内部的元素带的是 `data-v-segtabs`，**根本匹配不上**。
 *   （`.me-tabs` 自己没事：它就在 `SegTabs` 的根元素上，Vue 会把父的
 *     `data-v` 也留给子组件的根元素。）
 */
@media (max-width: 900px) {
  .me-tabs {
    display: flex;
    width: auto;
    justify-content: flex-start;
    align-items: stretch;
    /* 相邻按钮之间靠 gap 拉开（`.seg` 默认是按钮紧贴 + 分隔线） */
    gap: 18px;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 0;
    /*
     * 窄屏放不下时**横向可滑**，不然最后一格（「服务器」/新加的段）会被
     * `#app` 的 `overflow: hidden` 直接裁掉、点都点不到
     * （实测 360px 视口：六个 tab 共 374px，溢出 38px，最后一格只露 17px）。
     * 滚动条本身藏掉 —— 顶部那一排要干净，滑动手感靠 `-webkit-overflow-scrolling`。
     */
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .me-tabs::-webkit-scrollbar {
    display: none;
  }
  .me-tabs :deep(button) {
    /* ⚠️ 基础 `.seg button` 是 `flex: 1 1 0`（等分撑满），这里必须放开，
       否则「靠左」会变成三个一样宽的方块 */
    flex: 0 0 auto;
    padding: 6px 2px 9px;
    border: 0;
    border-radius: 0;
    background: none;
    font-size: 13px;
    position: relative;
  }
  .me-tabs :deep(button.active) {
    background: none;
    color: var(--blue);
  }
  .me-tabs :deep(button.active::after) {
    content: '';
    position: absolute;
    left: 50%;
    /* 对齐 `.tab-row .seg`：贴着按钮底边，不是压在外面的下划线上 */
    bottom: 0;
    width: 18px;
    height: 2px;
    border-radius: 999px;
    background: var(--blue);
    transform: translateX(-50%);
  }

  /*
   * 切一级 tab 滑入 —— 跟「开单分析」那排（`style.css` 的 `.split.pane-l …`）一致。
   * `pane-l` = 往后翻（从右滑入）、`pane-r` = 往前翻（从左滑入）。
   * ⚠️ 类只挂 260ms（见 `paneAnim`）—— 动画完就摘，`transform` 不会长期存在。
   */
  .me-pane.pane-l {
    animation: me-pane-in-right 0.24s ease both;
  }
  .me-pane.pane-r {
    animation: me-pane-in-left 0.24s ease both;
  }
  @keyframes me-pane-in-right {
    from {
      opacity: 0.35;
      transform: translateX(18px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes me-pane-in-left {
    from {
      opacity: 0.35;
      transform: translateX(-18px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
}
</style>
