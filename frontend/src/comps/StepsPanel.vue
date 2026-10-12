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

const props = withDefaults(
  defineProps<{
    steps: AnalyzeStep[]
    /** 已经出结果了 → 允许收成一行 */
    done?: boolean
    /** 还在跑 */
    running?: boolean
    /** 一条步骤都没有时给的提示 */
    hint?: string
    /**
     * 展开状态（受控）。不传就面板自己管（初值 = 展开）。
     *
     * ⚠️ 这个 `default: undefined` **不能删**：Vue 对 Boolean 类型的 prop
     *    会把「没传」铸成 `false`，那样 `props.open === undefined` 永远不成立，
     *    「添加案例」那边的面板（它不传 `open`）就一进来是收着的（踩过）。
     *    `withDefaults` 显式给个 `undefined` 才让它保持「没传」。
     */
    open?: boolean
  }>(),
  {open: undefined}
)

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
  <!--
    收起态 = **一颗小按钮**（图标 + 「分析过程」+ 用时）。
    ★ 2026-10-13 用户：「预测结果 分析过程默认放在一个按钮图标里，可以打开缩进去」
      ⇒ 以前只有「出结果之后」才允许收起来，一进页面（还没跑）那张占半个屏的
        提示面板是钉在那儿的；现在**任何时候**都能收，且默认就是收着的
        （初值见 `analyze.ts` 的 `showSteps`）。
     ★ 同一天用户又把两颗分开定死：「过程在结果出来后折叠」（这条，跑完自己收成一行）
       +「分析完成后不收起」（那是结论卡，**不归这个面板管**，见 `AnalyzeView`）。
  -->
  <button
    v-if="!isOpen && (steps.length || hint)"
    type="button"
    class="steps-toggle"
    :aria-expanded="false"
    @click="setOpen(true)"
  >
    <!-- 就是三条横线的小图标（内联，不引图标库） -->
    <svg class="ic" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
    <span>分析过程</span>
    <span v-if="steps.length" class="dim" :class="{bad: hasError}">
      {{ headText }} · 共 {{ totalText }}
    </span>
    <span class="caret">▾</span>
  </button>

  <section v-if="isOpen" class="panel steps-panel">
    <div class="steps-head">
      <h3>分析过程</h3>
      <span v-if="steps.length" class="dim" :class="{bad: hasError}">
        {{ headText }} · 共 {{ totalText }}
      </span>
      <button type="button" class="ghost tiny" @click="setOpen(false)">
        收起 ▴
      </button>
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

<style scoped>
/*
 * 收起态那颗小按钮：以前收起态用的是 `.panel`（整宽一块），
 * 现在要能一进页面就收着，整宽一块反而更占地 ⇒ 做成一颗 pill。
 */
.steps-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 12px;
  font-weight: var(--fw-mid);
  cursor: pointer;
}

.steps-toggle .ic,
.steps-toggle .caret {
  flex: 0 0 auto;
}

.steps-toggle .caret {
  font-size: 9px;
}

/* 展开态头部：标题靠左，「进行中 · 共 xxms」和「收起」靠右 */
.steps-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.steps-head h3 {
  margin: 0;
}

.steps-head .ghost.tiny {
  margin-left: auto;
}
</style>
