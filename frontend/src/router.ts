import {createRouter, createWebHashHistory, createWebHistory} from 'vue-router'
import {isNativeShell} from './platform'
import AnalyzeView from './views/AnalyzeView.vue'
import ContractsView from './views/ContractsView.vue'
import DownloadView from './views/DownloadView.vue'

/**
 * 落地页：打开 App / 网站先看到的那个。
 *
 * `/` 重定向到这里；**Android 物理返回键也是「已经在落地页」时才真退出 App**
 * （见 `back-button.ts`）—— 所以这个常量要能对外引用，别在各处硬写字符串。
 */
export const LANDING_PATH = '/contracts'

export const routes = [
  /*
   * `/` **不再是开单分析**（用户 2026-10-04：默认落在「合约」）——
   * 打开 App / 网站先看到的是一片市场列表。开单分析挪到 `/analyze`。
   */
  {path: '/', redirect: LANDING_PATH},
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
   * 「我的」= 交易所账户 + 复盘 + 个人信息 + 管理（管理员才有）。
   *
   * 用户 2026-10-06：「交易所账户移动到我的…模型配置移动到个人信息」，
   * 以及「预测历史和知识库合放二级，一级叫做复盘」「复盘不放在底下，
   * 放在交易所账户后面一个 tab」——
   *    · 交易所账户从「开单分析」搬进来，排**第一个**；
   *    · 「复盘」（预测历史 / 知识库）是紧跟其后的第二格，内部二级 tab 用 `?r=`
   *      （见 `views/ReplayPane.vue`）；
   *    · 模型配置并进「个人信息」。
   * 子页用 `?p=exchange|replay|profile|admin`，管理的二级 tab 用 `?t=users|server`。
   *
   * ⚠️ 子页用 `p` 而不是 `tab` —— `HistoryView` 自己占着 `?tab=kb`（老链接）。
   */
  {
    path: '/me',
    name: 'me',
    /*
     * 懒加载：这一页带着 echarts（~580KB），不该让首屏替它买单。
     * 默认落地页是「合约」，不进来就不会载。
     */
    component: () => import('./views/MeView.vue'),
    /*
     * 老书签 / 老链接：`/me?p=records|kb`（预测历史 / 知识库）现在落在「我的 → 复盘」，
     * 在进这一页之前把 query 换成新写法（`p=replay` + `r=records|kb`），别渲染出一段空白。
     */
    beforeEnter: to => {
      const p = to.query.p
      if (p === 'records' || p === 'kb' || p === 'history') {
        return {
          path: '/me',
          query: {
            ...to.query,
            p: 'replay',
            r: p === 'kb' ? 'kb' : 'records'
          }
        }
      }
      return true
    },
    meta: {title: '我的', nav: '我的'}
  },
  /*
   * 老书签 / 老链接（含 `/history?id=106` 这种详情链接）→ 「我的 → 复盘」对应那半，
   * query 原样带过去（`id` 会被 HistoryView 读到并直接弹详情）。
   */
  {
    path: '/history',
    redirect: to => ({
      path: '/me',
      // ⚠️ 老链接有两种：`/history?id=106`（详情）和 `/history?tab=kb`（知识库）
      query: {
        ...to.query,
        p: 'replay',
        r: to.query.tab === 'kb' ? 'kb' : 'records'
      }
    })
  },
  // 「用量」并进了「模型配置」，而「模型配置」现在在「我的 → 个人信息」里
  {
    path: '/usage',
    redirect: to => ({path: '/me', query: {...to.query, p: 'profile'}})
  },
  // 「知识库」并进「我的 → 复盘」，落在那半
  {path: '/knowledge', redirect: {path: '/me', query: {p: 'replay', r: 'kb'}}},
  /*
   * `/replay` 一度是独立的一级页（2026-10-06 上午），随后用户改口「不放在底下」——
   * 留个转发，别让旧链接白屏：`?p=kb` 那种旧 query 一并翻成 `?r=kb`。
   */
  {
    path: '/replay',
    redirect: to => ({
      path: '/me',
      query: {...to.query, p: 'replay', r: to.query.p === 'kb' ? 'kb' : 'records'}
    })
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
   * 子路径会 404 白屏 → 换成 `hash`（地址变成 `#/me`，功能一样）。
   * Web 上继续用 `history`，线上地址 `/me?p=replay&id=106` 一点都不能变。
   */
  history: isNativeShell() ? createWebHashHistory() : createWebHistory(),
  routes
})

router.afterEach(to => {
  const t = (to.meta.title as string) ?? ''
  document.title = t ? `${t} · Ait` : 'Ait'
})
