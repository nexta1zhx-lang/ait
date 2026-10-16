<script setup lang="ts">
/**
 * 「知识库」左栏面板（`AnalyzeView` 的 tab `?t=kb`）。
 *
 * ★ 2026-10-11：「预测历史」搬去 `comps/PredictHistory.vue` 了 ——
 *   旧的那半页（筛选项、三张饼图、7 列表格、详情抽屉）跟着整块删掉。
 *   这里只剩知识库这一块，`pane` 这个 prop 也就不需要了。
 *
 * ★ 2026-10-16：标题「已记录的案例」+ 下面那段说明**整块删掉** ——
 *   用户「和下面的介绍都删掉，太占位置了」。这一格本来就是「看卡片的」，
 *   标题和「去添加案例」那套说明常看就成了噪音（上面那排 tab 已经说明这是哪一格）。
 */
import {ref} from 'vue'
import KnowledgePanel from '../comps/KnowledgePanel.vue'
import TagTemplatesPanel from '../comps/TagTemplatesPanel.vue'

/** 标签模板改完要让它重新拉一遍标签 */
const panel = ref<InstanceType<typeof KnowledgePanel> | null>(null)
</script>

<template>
  <div class="hist">
    <!--
      知识库（原来单独一页 `/knowledge`，2026-10-04 合并进来）。
      内容跟老页面一字不差；原来那层 `<div class="col">` 去掉了 ——
      外壳 `.hist` 本来就是 flex 列，再套一层只会多出一层 gap。
    -->
    <div class="pane-kb">
      <section class="panel">
        <!-- 标签模板我自己维护，改完直接生效 -->
        <TagTemplatesPanel @changed="panel?.loadTags()" />

        <KnowledgePanel ref="panel" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.hist {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
