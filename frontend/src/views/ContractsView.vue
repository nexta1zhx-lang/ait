<script setup lang="ts">
/*
 * 组件名要钉死：`App.vue` 的 `<KeepAlive :include="['AnalyzeView','ContractsView']">`
 * 是按**组件名**匹配的，名字对不上会**静默失效**（整页不再缓存，看不出错）。
 */
defineOptions({name: 'ContractsView'})

/**
 * 「合约」页 —— 全市场的合约行情列表。
 *
 * 2026-10-04 用户要求「合约行情提出来放里面」：这一块原来长在「开单分析」
 * 左栏的第一格，现在整页独占一页，窄屏底栏也多了一格「合约」。
 * 开单分析那边**桌面端照旧**（左行情 + 右 K 线），只是手机端不再摆这一格。
 */
import {onActivated, onDeactivated, ref} from 'vue'
import {useRouter} from 'vue-router'
import MarketPanel from '../comps/MarketPanel.vue'
import {pickSymbol, prefetchSymbol, symbol} from '../analyze'
import {useScrollMemory} from '../scroll'

const router = useRouter()

/** 「共 N 个合约」——行情表报上来的数，跟着筛选后的名单走 */
const marketCount = ref(0)

/**
 * 这一页现在是不是「当前页」。
 *
 * 2026-10-04 给 `<RouterView>` 加了 `KeepAlive`：切到别的底栏 tab 时组件**不再卸载**
 * （好处就是用户要的：切回来搜索词 / 榜单排序 / 滚动位置全在），
 * 代价是行情推送不会自己停 —— `MarketPanel` 的 `active=false` 会把它断掉。
 */
const pageAlive = ref(true)

/** 整页根节点：给「滚动位置记忆」用（列表滚到一半切走，回来得还在那儿） */
const rootRef = ref<HTMLElement | null>(null)
useScrollMemory(() => rootRef.value)
onActivated(() => {
  pageAlive.value = true
})
onDeactivated(() => {
  pageAlive.value = false
})

/**
 * 点一行 = 选中这个币 + 去「开单分析」看图。
 *
 * 这一页只负责选币，K 线不在这儿（用户 2026-10-04：
 * 「合约页只搬合约行情列表，K 线留在开单分析里」）。
 */
function onPickMarket(base: string): void {
  // 先发出去：跳到 /analyze 画图时直接命中（服务端是内存/本地库，很快）
  prefetchSymbol(base)
  pickSymbol(base)
  void router.push('/analyze')
}
</script>

<template>
  <!--
    复用开单分析那套 `.split.m-market`：
    窄屏的满屏 / 通栏 / 大行高规则全挂在 `.split.m-market` 上，照抄过来就一致；
    单栏由 `.mkt-page` 把两栏网格压成一条（见 style.css）。
  -->
  <div ref="rootRef" class="split m-market mkt-page">
    <div class="col">
      <div class="scroll-body">
        <section class="panel mkt-panel">
          <h2>
            合约行情
            <span v-if="marketCount" class="mkt-count">
              共 {{ marketCount }} 个合约
            </span>
          </h2>
          <MarketPanel
            :symbol="symbol"
            :active="pageAlive"
            @pick="onPickMarket"
            @count="marketCount = $event"
          />
        </section>
      </div>
    </div>
  </div>
</template>
