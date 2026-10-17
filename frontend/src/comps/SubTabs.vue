<script setup lang="ts" generic="T extends string | number">
/**
 * 二级 tab（页内切换）。
 *
 * 用户 2026-10-18 连着改了几版，最后定成**最简单的那种**：
 *   「一级不变，二级改为简单，选中高亮」→「**只要字体，不要背景**」——
 *   所以这里没有轨道、没有外框、没有渐变、没有滑块、也没有高亮底色：
 *   就是一排纯文字，选中那颗**只把字染琥珀、加重一点**。
 *
 * 主次关系全靠一级 tab（`style.css` 的 `.tab-row`：13px / 选中底横线）压着 ——
 * 二级比它小一号、也不抢那条横线的位置。
 *
 * ⚠️ 内边距写死小值：全站 `button` 默认 `padding: 9px 20px`，一排格子会被撑爆（踩过）。
 */
defineProps<{
  modelValue: T
  options: {value: T; label: string; badge?: string | number}[]
}>()

const emit = defineEmits<{(e: 'update:modelValue', v: T): void}>()
</script>

<template>
  <div class="sub-tabs" role="tablist">
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      role="tab"
      :aria-selected="o.value === modelValue"
      :class="{on: o.value === modelValue}"
      @click="emit('update:modelValue', o.value)"
    >
      {{ o.label }}
      <span v-if="o.badge !== undefined" class="st-badge">{{ o.badge }}</span>
    </button>
  </div>
</template>

<style scoped>
.sub-tabs {
  display: flex;
  align-items: center;
  gap: 0;
  max-width: 100%;
  /* 窄屏挤不下时自己横着滚，不把页面撑破 */
  overflow-x: auto;
  scrollbar-width: none;
}

.sub-tabs::-webkit-scrollbar {
  display: none;
}

.sub-tabs button {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  /* 跟「我的 → 管理 / 模型配置」那排二级 tab 同一档（11.5px），比一级（13px）小一号 */
  font-size: 11.5px;
  font-weight: 400;
  white-space: nowrap;
  transition: color 0.16s ease;
}

/* 选中：**只换字体颜色**（用户 2026-10-18：「只要字体，不要背景」） */
.sub-tabs button.on {
  color: var(--accent);
  font-weight: var(--fw-mid);
}

/* 计数：淡数字，不画框 */
.st-badge {
  font-size: 10px;
  font-weight: 400;
  line-height: 1;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

.sub-tabs button.on .st-badge {
  opacity: 0.9;
}

</style>
