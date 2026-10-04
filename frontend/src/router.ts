import {createRouter, createWebHashHistory, createWebHistory} from 'vue-router'
import {isNativeShell} from './platform'
import AnalyzeView from './views/AnalyzeView.vue'
import ContractsView from './views/ContractsView.vue'
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
  /*
   * 「我的」= 历史 + 用量 + 服务器监测（用户 2026-10-04：历史 tab 改成我的，
   * 用量放进去合并，再加一页服务器监测）。子页用 `?p=history|usage|status`。
   *
   * ⚠️ 子页用 `p` 而不是 `tab` —— `HistoryView` 自己占着 `?tab=kb`。
   */
  {
    path: '/me',
    name: 'me',
    /*
     * 懒加载：这一页带着 echarts（~580KB），不该让首屏替它买单。
     * 默认落地页是「合约」，不进来就不会载。
     */
    component: () => import('./views/MeView.vue'),
    meta: {title: '我的', nav: '我的'}
  },
  /*
   * 老书签 / 老链接（含 `/history?id=106` 这种详情链接）→ 「我的」对应那段，
   * query 原样带过去（`id` 会被 HistoryView 读到并直接弹详情）。
   */
  {
    path: '/history',
    redirect: to => ({
      path: '/me',
      // ⚠️ 老链接有两种：`/history?id=106`（详情）和 `/history?tab=kb`（知识库）
      query: {...to.query, p: to.query.tab === 'kb' ? 'kb' : 'records'}
    })
  },
  {
    path: '/usage',
    redirect: to => ({path: '/me', query: {...to.query, p: 'usage'}})
  } /*
   * 「历史知识库」2026-10-04 已并进「历史」那一半，老链接带上 `tab=kb`
   * 直接落到知识库那半（`p` 用来定位到「我的 → 历史」）。
   */,
  {path: '/knowledge', redirect: {path: '/me', query: {p: 'kb'}}},
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
