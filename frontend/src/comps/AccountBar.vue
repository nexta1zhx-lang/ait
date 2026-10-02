<script setup lang="ts">
/**
 * 模型切换 + 余额（点一下刷新）。
 *
 * 同一份 UI 在**两处**用（用户 2026-10-03「模型价格…只针对移动端」）：
 *   · 全局顶栏 —— 宽屏看这里
 *   · 「用量」页 —— 窄屏顶栏整个收起来了，只在那儿露（外层给它挂 `usage-account` 控制显隐）
 *
 * 切模型会写进 `.env`（重启也保留），所以成功/失败都在这儿就地回一句话，
 * 免得两个调用方各写一套提示。
 */
import {ref} from 'vue'
import {
  balanceBadge,
  changeModel,
  config,
  modelOptions,
  refreshBalance,
  refreshingBalance,
  switchingModel
} from '../store'

const msg = ref('')
const err = ref('')

async function onModel(v: string): Promise<void> {
  msg.value = ''
  err.value = ''
  const e = await changeModel(v)
  if (e) err.value = e
  else msg.value = `已切到 ${v}，下一次判断就用它`
}
</script>

<template>
  <div v-if="config" class="account">
    <label
      class="model-pick"
      title="切换判断用的模型（会写进 .env，重启也保留）"
    >
      <span class="dim">模型</span>
      <select
        :value="config.model"
        :disabled="switchingModel"
        @change="onModel(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="m in modelOptions" :key="m.id" :value="m.id">
          {{ m.id }}{{ m.priced ? '' : '（无价目）' }}
        </option>
      </select>
    </label>
    <button
      type="button"
      class="badge balance"
      :class="balanceBadge.cls"
      :title="balanceBadge.title"
      :disabled="refreshingBalance"
      @click="refreshBalance"
    >
      {{ refreshingBalance ? '余额 …' : balanceBadge.text }}
    </button>
    <span v-if="msg" class="acct-msg dim">{{ msg }}</span>
    <span v-if="err" class="acct-msg bad">{{ err }}</span>
  </div>
</template>
