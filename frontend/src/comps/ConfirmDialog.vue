<script setup lang="ts">
/**
 * 全站唯一的「确认框」渲染点（挂在 `App.vue`，`Teleport` 到 body）。
 *
 * 别直接用它 —— 业务里一律 `askConfirm({...})`（见 `../confirm.ts`）；
 * 这里只管把 `pendingConfirm` 画出来、把用户的选择交回去。
 *
 * 交互（规范见 `style.css` 那一节）：
 *   · 点遮罩 = 取消（**不执行**）
 *   · Esc = 取消，Enter = 确认
 *   · 打开后焦点落在确认键上（键盘 / 读屏用户不用去 Tab）
 */
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import {pendingConfirm, settleConfirm, type ConfirmLine} from '../confirm'

const okBtn = ref<HTMLButtonElement | null>(null)

/** 正文统一成 `{t, tone?}` 的行，模板里一次渲染 */
const lines = computed<{t: string; tone?: 'num' | 'warn'}[]>(() => {
  const b = pendingConfirm.value?.body
  if (!b) return []
  return (Array.isArray(b) ? b : [b]).map((l: ConfirmLine) =>
    typeof l === 'string' ? {t: l} : l
  )
})

function cancel(): void {
  settleConfirm(false)
}

function ok(): void {
  settleConfirm(true)
}

/** Esc / Enter 在**捕获**阶段接：确认框开着的时候，别让底下的弹层 / 页面先吃到这两个键 */
function onKey(e: KeyboardEvent): void {
  if (!pendingConfirm.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    ok()
  }
}

watch(
  () => pendingConfirm.value,
  v => {
    if (v) void nextTick(() => okBtn.value?.focus())
  }
)

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <!-- `@click.self`：只有点到遮罩本身才算取消，点卡片里面不算 -->
    <div v-if="pendingConfirm" class="dlg-mask" @click.self="cancel">
      <div
        class="dlg"
        :class="{danger: pendingConfirm.danger}"
        role="dialog"
        aria-modal="true"
      >
        <div class="dlg-head">
          <b class="dlg-title">{{ pendingConfirm.title }}</b>
        </div>
        <div v-if="lines.length" class="dlg-body">
          <p v-for="(l, i) in lines" :key="i" :class="l.tone">{{ l.t }}</p>
        </div>
        <div class="dlg-actions">
          <button type="button" class="ghost" @click="cancel">
            {{ pendingConfirm.cancelText ?? '取消' }}
          </button>
          <button
            ref="okBtn"
            type="button"
            :class="{'dlg-danger': pendingConfirm.danger}"
            @click="ok"
          >
            {{ pendingConfirm.okText ?? '确定' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
