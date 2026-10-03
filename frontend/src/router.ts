import {createRouter, createWebHashHistory, createWebHistory} from 'vue-router'
import {isNativeShell} from './platform'
import AnalyzeView from './views/AnalyzeView.vue'
import HistoryView from './views/HistoryView.vue'
import KnowledgeView from './views/KnowledgeView.vue'
import UsageView from './views/UsageView.vue'
import PromptsView from './views/PromptsView.vue'

export const routes = [
  {
    path: '/',
    name: 'analyze',
    component: AnalyzeView,
    meta: {title: '开单分析', nav: '开单分析'}
  },
  {
    path: '/history',
    name: 'history',
    component: HistoryView,
    meta: {title: '预测历史', nav: '预测历史'}
  },
  {
    path: '/knowledge',
    name: 'knowledge',
    component: KnowledgeView,
    meta: {title: '历史知识库', nav: '历史知识库'}
  },
  {
    path: '/prompts',
    name: 'prompts',
    component: PromptsView,
    meta: {title: 'AI 提示词', nav: 'AI 提示词'}
  },
  {
    path: '/usage',
    name: 'usage',
    component: UsageView,
    meta: {title: '用量与花费', nav: '用量'}
  },
  {path: '/:pathMatch(.*)*', redirect: '/'}
]

export const router = createRouter({
  /*
   * 原生壳（App）里没有后端做 SPA 回退，`history` 模式下刷新或直达
   * 子路径会 404 白屏 → 换成 `hash`（地址变成 `#/history`，功能一样）。
   * Web 上继续用 `history`，线上地址 `/history?id=106` 一点都不能变。
   */
  history: isNativeShell() ? createWebHashHistory() : createWebHistory(),
  routes
})

router.afterEach(to => {
  const t = (to.meta.title as string) ?? ''
  document.title = t ? `${t} · 开单分析` : '开单分析'
})
