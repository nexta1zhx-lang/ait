<script setup lang="ts">
import {ref} from 'vue'
import {RouterLink} from 'vue-router'
import KnowledgePanel from '../comps/KnowledgePanel.vue'
import TagTemplatesPanel from '../comps/TagTemplatesPanel.vue'

const panel = ref<InstanceType<typeof KnowledgePanel> | null>(null)
</script>

<template>
  <div class="col">
    <section class="panel">
      <h2>已记录的案例 <span class="tag">卡片</span></h2>
      <p class="hint" style="margin-bottom: 10px">
        这里只放已经记下来的。要加新案例，去
        <RouterLink to="/">开单分析</RouterLink>
        的「添加案例」tab —— 点「画范围」再在右边 K 线上拖一段，就只提炼那一段。
        点卡片看经验、为什么这样走、勾标签。
      </p>

      <!-- 标签模板我自己维护，改完直接生效 -->
      <TagTemplatesPanel @changed="panel?.loadTags()" />

      <KnowledgePanel ref="panel" />
    </section>
  </div>
</template>

<style scoped>
/* 铺满整屏，让卡片按 4 列排开 */
.col {
  max-width: none;
}
</style>
