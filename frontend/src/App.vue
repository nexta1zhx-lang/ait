<script setup lang="ts">
import {onMounted, watch} from 'vue'
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
    to: '/',
    label: '开单分析',
    // 两根 K 线
    d: ['M5 9h4v6H5z', 'M7 5v4M7 15v4', 'M15 6h4v8h-4z', 'M17 3v3M17 14v7']
  },
  {
    to: '/history',
    label: '预测历史',
    // 表盘
    d: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5v5l3.2 2']
  },
  {
    to: '/knowledge',
    label: '历史知识库',
    // 摊开的书
    d: [
      'M12 6.6C10.6 5.1 8.7 4.5 6.6 4.5H4.2v12.7h2.4c2.1 0 4 .6 5.4 2.1z',
      'M12 6.6c1.4-1.5 3.3-2.1 5.4-2.1h2.4v12.7h-2.4c-2.1 0-4 .6-5.4 2.1z'
    ]
  },
  {
    to: '/usage',
    label: '用量',
    // 柱状图
    d: ['M6 20v-6M12 20V4M18 20v-9', 'M3.5 20h17']
  }
]

/**
 * 开单分析 / 预测历史要「一屏塞下、内部各自滚动」，其它页还是普通长文档。
 * 页面高度归 body 管，所以在这里切一个 class，别影响别的路由。
 */
const route = useRoute()
watch(
  () => route.path,
  p => {
    document.body.classList.toggle(
      'fixed-viewport',
      p === '/' || p === '/history'
    )
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

  <RouterView />
</template>
