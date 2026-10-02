<script setup lang="ts">
/**
 * 分析过程面板（纯展示）。
 *
 * 跑的时候逐步列出来，出结果后可以收成一行，点一下还能展开。
 * 开单分析和案例提炼共用 —— 两边各自把 `steps` 传进来就行，
 * 面板不碰任何全局状态。
 */
import {computed, ref} from 'vue'
import type {AnalyzeStep} from '../api'
import {useStepClock} from '../steps'

const props = defineProps<{
  steps: AnalyzeStep[]
  /** 已经出结果了 → 允许收成一行 */
  done?: boolean
  /** 还在跑 */
  running?: boolean
  /** 一条步骤都没有时给的提示 */
  hint?: string
  /** 展开状态（受控）。不传就面板自己管 */
  open?: boolean
}>()

const emit = defineEmits<{(e: 'update:open', v: boolean): void}>()

const localOpen = ref(true)
const isOpen = computed(() => props.open ?? localOpen.value)

function setOpen(v: boolean) {
  if (props.open === undefined) localOpen.value = v
  emit('update:open', v)
}

const STEP_ICON: Record<AnalyzeStep['state'], string> = {
  running: '◌',
  done: '●',
  error: '✕'
}

const {msOf, msText, totalText} = useStepClock(() => props.steps)

/** 跑挂了就不要写「完成」—— 那是在骗自己 */
const hasError = computed(() => props.steps.some(s => s.state === 'error'))
const headText = computed(() =>
  props.running ? '进行中' : hasError.value ? '出错' : '完成'
)
</script>

<template>
  <!-- 出结果后收成一行，点一下看全过程 -->
  <button
    v-if="done && !isOpen && steps.length"
    type="button"
    class="panel steps-collapsed"
    @click="setOpen(true)"
  >
    <span class="t">分析过程 · 共 {{ totalText }}</span>
    <span class="dim">{{ steps.map(x => x.label).join(' → ') }}</span>
    <span class="dim">展开 ▾</span>
  </button>

  <section v-if="!done || isOpen" class="panel">
    <div class="steps-head">
      <h3>分析过程</h3>
      <button
        v-if="done && steps.length"
        type="button"
        class="ghost tiny"
        @click="setOpen(false)"
      >
        收起
      </button>
      <span v-else-if="steps.length" class="dim" :class="{bad: hasError}">
        {{ headText }} · 共 {{ totalText }}
      </span>
    </div>
    <ol v-if="steps.length" class="steps">
      <li
        v-for="s in steps"
        :key="s.id"
        class="step"
        :class="[s.state, {active: s.state === 'running'}]"
      >
        <span class="dot">{{ STEP_ICON[s.state] }}</span>
        <span class="body">
          <b>{{ s.label }}</b>
          <em v-if="s.detail">{{ s.detail }}</em>
        </span>
        <span class="ms">{{ msText(msOf(s)) }}</span>
      </li>
    </ol>
    <p v-else-if="hint" class="hint">{{ hint }}</p>
  </section>
</template>
