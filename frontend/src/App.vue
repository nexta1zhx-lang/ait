<script setup lang="ts">
import {computed, KeepAlive, onMounted, watch} from 'vue'
import {RouterLink, RouterView, useRoute} from 'vue-router'
import AccountBar from './comps/AccountBar.vue'
import ConfirmDialog from './comps/ConfirmDialog.vue'
import ToastHost from './comps/ToastHost.vue'
import LoginView from './views/LoginView.vue'
import {authReady, initAuth, user} from './session'
import {authToken} from './api'
import {bootstrap, notices, resetStore} from './store'

/*
 * 主菜单：宽屏在顶栏，窄屏在底部（样式见 style.css 的窄屏那段）。
 *
 * `d` 是 24×24 viewBox 里的 path —— 窄屏底栏要「图标 + 文字」，项目里没引图标库，
 * 就手写几条最简描边路径（跟 KlineChart 里那个日历图标一个路子），
 * 描边颜色统一走 `currentColor`，高亮时跟文字一起变蓝。
 */
const NAV = [
  {
    to: '/contracts',
    label: '合约',
    // 一上一下两支箭头：合约的多空两头
    d: [
      'M8.5 20V4',
      'M8.5 4 5.9 6.6M8.5 4l2.6 2.6',
      'M15.5 4v16',
      'M15.5 20l-2.6-2.6M15.5 20l2.6-2.6'
    ]
  },
  {
    to: '/analyze',
    label: '开单分析',
    // 两根 K 线
    d: ['M5 9h4v6H5z', 'M7 5v4M7 15v4', 'M15 6h4v8h-4z', 'M17 3v3M17 14v7']
  },
  {
    to: '/me',
    label: '我的',
    // 人形：这页现在是「我的」—— 交易所账户 / 复盘 / 个人信息 / 管理都在里面
    d: ['M12 11.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20.5a7.5 7.5 0 0 1 15 0']
  }
  /*
   * ⚠️ 2026-10-04 两次改版：
   *   ① `/` 不再是开单分析（默认落 `/contracts`，见 router.ts）；
   *      「预测历史」+「历史知识库」并成「历史」一页；
   *   ② 随后「历史」+「用量」进一步并成**「我的」**（`/me`，页内分若干段）。
   *
   * ⚠️ 2026-10-06 再把 tab 捋一遍（用户：「交易所账户移动到我的，预测历史和知识库
   *    放到…复盘，模型配置移动到个人信息」，随后又定「复盘不放在底下，
   *    放在交易所账户后面一个 tab」）：
   *    · 「我的」（`/me`）= 交易所账户 + 复盘（预测历史 / 知识库）+ 个人信息
   *      （模型配置并在里头）+ 管理 —— **全在这一页里**，底栏不再多一格。
   *
   * ⚠️ `/download`（下载页）**故意不进这张表** ——
   * 用户 2026-10-04：「下载界面是独立的，不和其他界面一起，tab 不要」。
   * 它是个单独的落地页，只能从 `/download` 直接进（别人拿到链接就能下载）。
   * 进了这张表就会同时出现在顶栏和窄屏底栏，那就是一个 tab 了。
   */
]

/**
 * 要缓存的页面（按组件名）—— 切换底栏 tab 时**不要重置状态**的就这两页。
 * 不带 `KeepAlive` 的话路由一变组件就卸载重建，回到「合约」/「开单分析」时
 * 搜索词、榜单排序、滚动位置、图上缩放全没了 —— 看着就像重新刷新了一次。
 *
 * ⚠️ 代价：组件留在内存里，后台的实时推送不会自己停 —— 所以这两页里各自用
 * `onActivated` / `onDeactivated` 把 `active` 传给 `MarketPanel` / `KlineChart`，
 * 收到 `false` 会把 SSE 断掉，回来自动重订。
 */
/*
 * 缓存的页（`<KeepAlive :include>`）：切走不卸载，切回来原地接着看。
 *
 * ⚠️ 进了这个名单，**页里的订阅 / 定时器就不会自己停了** —— 每一页都得自己
 *    用 `onActivated` / `onDeactivated` 盯住「在场」（`ContractsView` 看行情推送、
 *    `MeView` 看交易所那两条 SSE 和下面几格），别只靠「组件卸载」。
 * ⚠️ `MeView` 是 2026-10-06 加的（用户：「交易所页面是 me 吗加页面缓存」）：
 *    「我的 → 交易所账户」那一格本来就在页内缓存了，但**离开这一页再回来**要
 *    重新拉 Key / 读库 / 订阅 SSE —— 现在也不会了。
 */
const CACHED_VIEWS = ['AnalyzeView', 'ContractsView', 'MeView']

/*
 * 「一屏塞下、内部各自滚动」的页：开单分析 / 合约 / 我的。
 * 其它页还是普通长文档。页面高度归 body 管，所以在这里切一个 class。
 *
 * ⚠️⚠️ `/me` **必须列在这里**。它跟别的页不一样：子页全靠 `?p=` 切，
 * 而 **query 一变这条 watch 就会重跑**（源是 `[route.path, user.id]`，但 vue-router
 * 换 query 也会触发重算 —— 实测换任何 query 都会再走一次回调）。以前 `/me` 不在表里，
 * 于是每切一次子页就 `toggle('fixed-viewport', false)`，把 `PaneShell` 自己加的类抹掉：
 * 顶部 tab 不再固定、整页变成可滚、内容区也不再内部滚 —— 表现就是「tab 下面那条
 * 滚动区坏掉、切页面后滚动全乱」。
 *
 * 这一页的子段**统一都是「内容区自己滚」**，所以一条路由一刀切正好；
 * `PaneShell` 里那次 add 只是首帧兜底。
 */
const FIXED_VIEWPORT_PATHS = ['/analyze', '/contracts', '/me']

const route = useRoute()

/**
 * 下载页是**公开落地页**（别人拿到链接就能下载 App），不能卡在登录后面。
 * 它只调 `/api/downloads`（公开接口），不需要 token。
 */
const isPublicPage = computed(() => route.path === '/download')

watch(
  () => [route.path, user.value?.id ?? 0] as const,
  ([p]) => {
    // 没登录时是登录页，不需要「整屏不滚」那套
    const loggedIn = Boolean(user.value)
    document.body.classList.toggle(
      'fixed-viewport',
      loggedIn && FIXED_VIEWPORT_PATHS.includes(p as string)
    )
    /*
     * 下载页是个**独立落地页**：不挂站内导航（顶栏 / 底栏都不出）。
     * 窄屏底栏是 `position: fixed` 的，不关掉会盖在落地页上。
     * ⚠️ 它跟登录态无关 —— 没登录的访客也要能看到干净的下载页。
     */
    document.body.classList.toggle('bare', p === '/download')
  },
  {immediate: true}
)

onMounted(async () => {
  // 先用本地 token 问一下「我是谁」，未登录就停在登录页
  await initAuth()
  if (user.value) await bootstrap()
})

/* 登录成功 → 拉全局配置；退出登录 → 清掉上一份数据 */
watch(user, u => {
  if (u) void bootstrap()
  else resetStore()
})

/*
 * token 被清掉（接口报 401 时 `api.ts` 会顺手清）也要退回登录页，
 * 否则页面上还挂着「已登录」的壳，但每个请求都失败。
 */
watch(authToken, t => {
  if (!t && user.value) user.value = null
})
</script>

<template>
  <!--
    没登录时只显示登录页（不挂导航）——
    预测历史 / 知识库 / 模型配置都是「用户自己的东西」。
  -->
  <div v-if="!authReady" class="boot-screen">载入中…</div>
  <LoginView v-else-if="!user && !isPublicPage" />

  <template v-else>
    <header class="topbar">
      <nav class="nav">
        <RouterLink v-for="n in NAV" :key="n.to" :to="n.to">
          {{ n.label }}
        </RouterLink>
      </nav>
      <!--
      模型 / 余额：宽屏就在这儿（跟导航同一行）。
      窄屏整个顶栏收起来，它们只留在「用量」页（用户 2026-10-03：只针对移动端）。
    -->
      <AccountBar />
    </header>

    <!--
    窄屏底部导航：图标 + 文字，平铺分列（每格等宽）。
    桌面端 `display: none`，菜单还在顶栏（见 style.css 的 `.tabbar`/窄屏那段）。
  -->
    <nav class="tabbar">
      <RouterLink v-for="n in NAV" :key="n.to" :to="n.to">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path v-for="(d, i) in n.d" :key="i" :d="d" />
        </svg>
        <span>{{ n.label }}</span>
      </RouterLink>
    </nav>

    <div v-if="notices.length" class="notice">{{ notices.join('\n') }}</div>

    <!--
    ⚠️ **只缓存两页**（用户 2026-10-04）：「历史」和「用量」不要缓存 ——
    那两页本来就该每次进来重拉一遍（新增的记录 / 花费），缓存反而会看到旧数据。

    ⚠️⚠️ `include` 是按**组件名**匹配的，名字对不上会**静默失效**（全都不缓存，
    看不出错）—— 所以两个被缓存的视图里都写了 `defineOptions({name: ...})`
    把名字钉死，不靠文件名推断。改动这两个名字要同步改这里。
  -->
    <RouterView v-slot="{Component}">
      <KeepAlive :include="CACHED_VIEWS">
        <component :is="Component" />
      </KeepAlive>
    </RouterView>
  </template>

  <!--
    ⚠️ 这两个摆在最外层（**不在上面那个 `v-if` 分支里**）：
    登录页也要能弹提示 / 确认（登录失败、退出登录确认），
    放进 `<template v-else>` 里的话没登录就一次都用不上。
    ⚠️ 全站各一份，别在页面里再写 —— 见 `toast.ts` / `confirm.ts` 顶部说明。
  -->
  <ToastHost />
  <ConfirmDialog />
</template>

<style scoped>
/* 启动时问服务器「我是谁」的一瞬间，别闪白屏 */
.boot-screen {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
}
</style>
