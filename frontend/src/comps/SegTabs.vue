<script setup lang="ts" generic="T extends string | number">
/** 通用分段选择器 */

defineProps<{
  modelValue: T
  options: {value: T; label: string}[]
}>()

const emit = defineEmits<{(e: 'update:modelValue', v: T): void}>()
</script>

<template>
  <div class="seg">
    <button
      v-for="o in options"
      :key="String(o.value)"
      type="button"
      :class="{active: o.value === modelValue}"
      @click="emit('update:modelValue', o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>
