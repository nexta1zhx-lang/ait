<script setup lang="ts">
/**
 * 「我的 → 复盘」：预测历史、知识库和账户统计（二级 tab）。
 *
 * 用户 2026-10-06：「预测历史和知识库合放二级，一级叫做复盘」，
 * 随后又定了位置：「复盘不放在底下，放在交易所账户后面一个 tab」——
 * 所以它是「我的」里的一格（排在交易所账户后面），不是底栏的一级菜单。
 *
 * ⚠️ 二级 tab 用 **`?r=`** 记（`records` = 预测历史、`kb` = 知识库、`stats` = 账户统计）——
 *    不能再用 `?p=`：那是「我的」自己一级 tab 的位置（这一格是 `?p=replay`）。
 *    老链接（`/history?id=106`、`/knowledge`、`/me?p=kb`）由 `router.ts` 转过来。
 */
import {ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import SegTabs from '../comps/SegTabs.vue'
import HistoryView from './HistoryView.vue'
import AccountStatsView from './AccountStatsView.vue'

type Pane = 'records' | 'kb' | 'stats'

const PANES: {value: Pane; label: string}[] = [
  {value: 'records', label: '预测历史'},
  {value: 'kb', label: '知识库'},
  {value: 'stats', label: '账户统计'}
]

const route = useRoute()
const router = useRouter()

/** 解析 `?r=`；不认识的都落到「预测历史」 */
function readPane(v: unknown): Pane {
  if (v === 'kb' || v === 'stats') return v
  return 'records'
}

const pane = ref<Pane>(readPane(route.query.r))
const statsMounted = ref(pane.value === 'stats')

// 浏览器前进 / 后退、以及老书签（`/history?id=1` → `?p=replay&r=records&id=1`）都要跟上
watch(
  () => route.query.r,
  v => (pane.value = readPane(v))
)

/** 切页时把 `?r=` 写回地址栏（其余 query 保留：`?id=` 那种抽屉要靠它自动弹） */
function setPane(v: Pane): void {
  pane.value = v
  if (v === 'stats') statsMounted.value = true
  const q: Record<string, string> = {}
  for (const [k, val] of Object.entries(route.query)) {
    if (typeof val === 'string') q[k] = val
  }
  q.r = v
  void router.replace({query: q})
}
</script>

<template>
  <div class="replay-pane">
    <!--
      ⚠️ 这排 tab 用**最普通的 `SegTabs`**（不加任何自定义类）——
      用户 2026-10-06：「复盘下的两个 tab 样式统一和交易所账户下的二级 tab 一致」。
      交易所账户里「持仓 / 挂单 / 成交 / 盈亏」那排就是裸的 `.seg`（在一列 flex 里当
      flex item，撑满整行）；这里照抄，不套任何外壳（以前套过 `.page-tabs`，
      窄屏会变成带边框的「背景块」，跟那边对不上）。
    -->
    <SegTabs
      :model-value="pane"
      :options="PANES"
      @update:model-value="setPane"
    />
    <HistoryView v-show="pane !== 'stats'" :pane="pane === 'kb' ? 'kb' : 'records'" />
    <AccountStatsView v-if="statsMounted" v-show="pane === 'stats'" />
  </div>
</template>

<style scoped>
.replay-pane {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  min-width: 0;
}
</style>
