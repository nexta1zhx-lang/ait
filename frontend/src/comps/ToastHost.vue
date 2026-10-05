<script setup lang="ts">
/**
 * 全站唯一的「信息提示」渲染点（挂在 `App.vue`，`Teleport` 到 body）。
 *
 * ⚠️ 别在页面里再写一份 —— 状态在 `../toast.ts`，这里只负责画。
 * ⚠️ `role="status"` + `aria-live="polite"`：读屏软件也要能听到「挂单失败了」这种话。
 */
import {hideToast, toast} from '../toast'
</script>

<template>
  <Teleport to="body">
    <div
      v-if="toast"
      :key="toast.id"
      class="toast"
      :class="toast.tone"
      role="status"
      aria-live="polite"
      title="点一下关掉"
      @click="hideToast"
    >
      {{ toast.text }}
    </div>
  </Teleport>
</template>
