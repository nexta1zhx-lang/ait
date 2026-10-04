<script setup lang="ts">
import {KeepAlive, onMounted, watch} from 'vue'
import {RouterLink, RouterView, useRoute} from 'vue-router'
import AccountBar from './comps/AccountBar.vue'
import {bootstrap, notices} from './store'

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
    to: '/history',
    label: '历史',
    // 表盘
    d: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5v5l3.2 2']
  },
  {
    to: '/usage',
    label: '用量',
    // 柱状图
    d: ['M6 20v-6M12 20V4M18 20v-9', 'M3.5 20h17']
  }
  /*
   * ⚠️ 2026-10-04 改版：`/` 不再是开单分析（默认落 `/contracts`，见 router.ts）；
   * 「预测历史」+「历史知识库」两页合并成「历史」一页（页内再分段，见 HistoryView）。
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
const CACHED_VIEWS = ['AnalyzeView', 'ContractsView']

/**
 * 「一屏塞下、内部各自滚动」的页：开单分析 / 历史 / 合约。
 * 其它页还是普通长文档。页面高度归 body 管，所以在这里切一个 class。
 */
const FIXED_VIEWPORT_PATHS = ['/analyze', '/history', '/contracts']

const route = useRoute()
watch(
  () => route.path,
  p => {
    document.body.classList.toggle(
      'fixed-viewport',
      FIXED_VIEWPORT_PATHS.includes(p)
    )
    /*
     * 下载页是个**独立落地页**：不挂站内导航（顶栏 / 底栏都不出）。
     * 窄屏底栏是 `position: fixed` 的，不关掉会盖在落地页上。
     */
    document.body.classList.toggle('bare', p === '/download')
  },
  {immediate: true}
)

onMounted(bootstrap)
</script>

<template>
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
