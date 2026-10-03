import {createRouter, createWebHashHistory, createWebHistory} from 'vue-router'
import {isNativeShell} from './platform'
import AnalyzeView from './views/AnalyzeView.vue'
import HistoryView from './views/HistoryView.vue'
import KnowledgeView from './views/KnowledgeView.vue'
import UsageView from './views/UsageView.vue'

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
    path: '/usage',
    name: 'usage',
    component: UsageView,
    meta: {title: '用量与花费', nav: '用量'}
  },
  /*
   * 「AI 提示词」页 2026-10-04 已删（用户：「没什么用，都要和代码绑定」）——
   * 提示词现在是 `backend/src/llm/prompts.ts` 里的常量。
   * 老书签 / 老链接进 /prompts 会被下面这条捕到，直接回首页，不留白屏。
   */
  {path: '/prompts', redirect: '/'},
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
