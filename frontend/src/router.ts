import {createRouter, createWebHistory} from 'vue-router'
import AnalyzeView from './views/AnalyzeView.vue'
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
    path: '/knowledge',
    name: 'knowledge',
    component: KnowledgeView,
    meta: {title: '知识库', nav: '知识库'}
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
  history: createWebHistory(),
  routes
})

router.afterEach(to => {
  const t = (to.meta.title as string) ?? ''
  document.title = t ? `${t} · 开单分析` : '开单分析'
})
