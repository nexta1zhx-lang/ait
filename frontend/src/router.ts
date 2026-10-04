import {createRouter, createWebHashHistory, createWebHistory} from 'vue-router'
import {isNativeShell} from './platform'
import AnalyzeView from './views/AnalyzeView.vue'
import ContractsView from './views/ContractsView.vue'
import HistoryView from './views/HistoryView.vue'
import UsageView from './views/UsageView.vue'
import DownloadView from './views/DownloadView.vue'

export const routes = [
  /*
   * `/` **不再是开单分析**（用户 2026-10-04：默认落在「合约」）——
   * 打开 App / 网站先看到的是一片市场列表。开单分析挪到 `/analyze`。
   */
  {path: '/', redirect: '/contracts'},
  {
    path: '/contracts',
    name: 'contracts',
    component: ContractsView,
    meta: {title: '合约', nav: '合约'}
  },
  {
    path: '/analyze',
    name: 'analyze',
    component: AnalyzeView,
    meta: {title: '开单分析', nav: '开单分析'}
  },
  {
    path: '/history',
    name: 'history',
    component: HistoryView,
    meta: {title: '历史', nav: '历史'}
  },
  /*
   * 「历史知识库」2026-10-04 已合并进「历史」页（用户：「预测历史和历史知识库
   * 合并，改叫历史」）。老书签走这里 —— 带上 `tab=kb` 直接落到知识库那半。
   */
  {path: '/knowledge', redirect: {path: '/history', query: {tab: 'kb'}}},
  {
    path: '/usage',
    name: 'usage',
    component: UsageView,
    meta: {title: '用量与花费', nav: '用量'}
  },
  {
    path: '/download',
    name: 'download',
    component: DownloadView,
    meta: {title: '下载 App', nav: '下载'}
  },
  /*
   * 「AI 提示词」页 2026-10-04 已删（用户：「没什么用，都要和代码绑定」）——
   * 提示词现在是 `backend/src/llm/prompts.ts` 里的常量。
   * 老书签 / 老链接进 /prompts 会被下面那条捕到，直接回落地页，不留白屏。
   */
  {path: '/prompts', redirect: '/contracts'},
  {path: '/:pathMatch(.*)*', redirect: '/contracts'}
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
