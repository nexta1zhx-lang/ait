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

/**
 * 去掉「旧位置」那几个参数（`p` / `r` / `tab`），其余（`id` / `symbol` …）原样带过去。
 * 老链接转发时用 —— 别把旧参数带进新页面。
 */
function restQuery(query: Record<string, unknown>): Record<string, unknown> {
  const q: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query)) {
    if (k === 'p' || k === 'r' || k === 'tab') continue
    q[k] = v
  }
  return q
}

/**
 * 「预测历史 / 知识库」现在挂在「开单分析」的左栏，用 `?t=history|kb` 定位
 * （见 `views/AnalyzeView.vue` 里那段「左栏 tab 记进地址栏」）。
 */
function analyzeTab(
  tab: 'history' | 'kb',
  query: Record<string, unknown>
): {path: string; query: Record<string, unknown>} {
  return {path: '/analyze', query: {...restQuery(query), t: tab}}
}

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
   * ★ 2026-10-10：账户统计**留在「我的」里**（第二格，紧跟交易所账户）——
   *   用户：「账户统计不是放在底下的，是在『我的』里面，交易所账户后面」。
   *   `/stats` 只是那个短地址的转发（中途一度这么挂过），留着别让链接白屏。
   */
  {
    path: '/stats',
    redirect: to => ({
      path: '/me',
      query: {...restQuery(to.query), p: 'stats'}
    })
  },
  /*
   * 「我的」= 交易所账户 + 账户统计 + 个人信息 + 管理（管理员才有）。
   *
   * ★ 2026-10-10 把「复盘」拆了（用户：「去掉 1 级菜单里的复盘」「把预测历史和知识库
   *   挪到开单分析里，原有的历史分析去掉」「账户统计是在『我的』里面，交易所账户后面」）：
   *     · 预测历史 / 知识库 → 「开单分析」的左栏 tab（`?t=history|kb`）；
   *     · 账户统计          → **这一页的第二格**（`?p=stats`，紧跟交易所账户）。
   *
   * 子页用 `?p=exchange|stats|profile|model|admin`；
   * 二级 tab 用 `?t=` —— 管理是 `users|server`，模型配置是 `keys|usage|prompts`。
   * ★ 2026-10-12：「模型配置」从「个人信息」里搬出来成一级 tab（原来叫「AI 提示词」）。
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
     * 老书签 / 老链接：`/me?p=replay…`（复盘）那三段已经有新位置（见上面那段注释），
     * 在进这一页之前把 query 换成新写法，别渲染出一段空白。
     */
    beforeEnter: to => {
      const p = to.query.p
      if (p === 'replay' && to.query.r === 'stats')
        return {path: '/me', query: {...restQuery(to.query), p: 'stats'}}
      if (p === 'replay' || p === 'records' || p === 'kb' || p === 'history') {
        const kb = p === 'kb' || to.query.r === 'kb'
        return analyzeTab(kb ? 'kb' : 'history', to.query)
      }
      return true
    },
    meta: {title: '我的', nav: '我的'}
  },
  /*
   * 老书签 `/history` → 「开单分析 → 预测历史」，其余 query 原样带过去。
   */
  {
    path: '/history',
    redirect: to => analyzeTab('history', to.query)
  },
  /*
   * 「用量」→ 「我的 → 模型配置 → 用量统计」。
   * ★ 2026-10-12：模型配置从「个人信息」里搬出来成了**一级 tab**（标签就叫「模型配置」），
   *   里面三个子 tab：密钥配置 / 用量统计 / AI 提示词（`?t=keys|usage|prompts`）。
   *   所以老书签 `/usage` 现在落到 `?p=model&t=usage`。
   */
  {
    path: '/usage',
    redirect: to => ({path: '/me', query: {...to.query, p: 'model', t: 'usage'}})
  },
  /*
   * 知识库整块已删（用户 2026-10-18）—— 老书签落到「预测分析 → AI分析」，
   * 不让人打开一个空白页。
   */
  {path: '/knowledge', redirect: to => analyzeTab('history', to.query)},
  /*
   * `/replay` 一度是独立的一级页（2026-10-06 上午）—— 2026-10-10 整格取消了，
   * 旧链接按「预测历史 / 知识库」分流到「开单分析」。
   */
  {
    path: '/replay',
    redirect: to => analyzeTab('history', to.query)
  },
  {
    path: '/download',
    name: 'download',
    component: DownloadView,
    meta: {title: '下载 App', nav: '下载'}
  },
  /*
   * 「AI 提示词」现在挂在「我的」页里（个人信息后面那一格）——
   * 正文存数据库 `ai_docs`（kind=predict），网页上改、即改即生效。
   * 老书签 / 直接输 /prompts 一律转到「我的 · AI 提示词」。
   */
  {path: '/prompts', redirect: {path: '/me', query: {p: 'prompts'}}},
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
