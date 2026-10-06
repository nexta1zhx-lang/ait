<script setup lang="ts">
/**
 * 「我的 → 个人信息 → 模型配置」：**多把大模型密钥** + 用量统计（2026-10-04 改版）。
 *
 * 用户原话：「可以绑定多个 key 和模型，可以给命名，默认给一个，
 * 只有新增编辑时才弹窗，用量移到此界面，合理化布局，统计数据分开显示和 key 绑定」。
 *
 * 三件事：
 *   ① 密钥列表 —— 每把显示名字 / 掩码 / 模型 / **它自己的用量**，可编辑 / 设默认 / 删
 *   ② 只有「新增 / 编辑」才弹窗（平时就是一张清单）
 *   ③ 用量统计并进这一页，并且能按密钥筛（统计跟 key 绑定）
 *
 * ⚠️ 真 Key 不出网：接口只回掩码（`sk-a****3456`），输入框留空 = 不改。
 */
import {computed, onMounted, ref} from 'vue'
import SegTabs from '../comps/SegTabs.vue'
import UsageView from './UsageView.vue'
import {
  createLlmKey,
  deleteLlmKey,
  fetchLlmKeys,
  fetchUsageSummary,
  setDefaultLlmKey,
  updateLlmKey,
  type LlmKey
} from '../api'
import {cny, usd} from '../format'
import {askConfirm} from '../confirm'
import {refreshConfig} from '../store'

const keys = ref<LlmKey[]>([])
const modelIds = ref<string[]>([])
const loading = ref(false)
const error = ref('')
const msg = ref('')

/** 美元 → 人民币（跟用量页同一个来源） */
const rate = ref(7.1)

/* ---------------- 弹窗（只在新增 / 编辑时出现） ---------------- */

const editing = ref<null | {id: number | null}>(null)
const form = ref({
  name: '',
  apiKey: '',
  baseUrl: '',
  model: '',
  reasoningEffort: 'none'
})
const saving = ref(false)

const EFFORTS = [
  {value: 'none', label: 'none（不思考，最快最省）'},
  {value: 'auto', label: 'auto（让模型自己决定）'},
  {value: 'minimal', label: 'minimal'},
  {value: 'low', label: 'low'},
  {value: 'medium', label: 'medium'},
  {value: 'high', label: 'high（想得最多）'}
]

const isNew = computed(() => editing.value?.id === null)
const title = computed(() => (isNew.value ? '新增密钥' : '编辑密钥'))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await fetchLlmKeys()
    keys.value = r.keys
    modelIds.value = r.models?.available?.map(m => m.id) ?? []
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function flash(t: string): void {
  msg.value = t
  window.setTimeout(() => {
    if (msg.value === t) msg.value = ''
  }, 3000)
}

function openNew(): void {
  error.value = ''
  editing.value = {id: null}
  form.value = {
    name: `密钥 ${keys.value.length + 1}`,
    apiKey: '',
    baseUrl: '',
    model: '',
    reasoningEffort: 'none'
  }
}

function openEdit(k: LlmKey): void {
  error.value = ''
  editing.value = {id: k.id}
  form.value = {
    name: k.name,
    // 留空 = 不改（掩码不能当 Key 存回去）
    apiKey: '',
    baseUrl: k.baseUrl,
    model: k.model,
    reasoningEffort: k.reasoningEffort.trim() || 'none'
  }
}

function close(): void {
  editing.value = null
  error.value = ''
}

async function save(): Promise<void> {
  if (saving.value || !editing.value) return
  error.value = ''
  saving.value = true
  try {
    const body = {
      name: form.value.name.trim(),
      apiKey: form.value.apiKey.trim() || undefined,
      baseUrl: form.value.baseUrl.trim(),
      model: form.value.model.trim(),
      reasoningEffort: form.value.reasoningEffort
    }
    if (editing.value.id === null) await createLlmKey(body)
    else await updateLlmKey(editing.value.id, body)
    close()
    flash('已保存')
    await load()
    await refreshConfig()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function makeDefault(k: LlmKey): Promise<void> {
  error.value = ''
  try {
    await setDefaultLlmKey(k.id)
    flash(`已把「${k.name}」设为默认，下一次分析就用它`)
    await load()
    await refreshConfig()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function remove(k: LlmKey): Promise<void> {
  const ok = await askConfirm({
    title: `确定删除密钥「${k.name}」？`,
    body: '已经产生的用量记录不会删，只是之后不再用它。',
    okText: '删除',
    danger: true
  })
  if (!ok) return
  error.value = ''
  try {
    await deleteLlmKey(k.id)
    flash('已删除')
    await load()
    await refreshConfig()
  } catch (e) {
    error.value = (e as Error).message
  }
}

/* ---------------- 用量：按密钥筛 ---------------- */

const filterKey = ref<number | null>(null)

const keyFilters = computed(() => [
  {value: null as number | null, label: '全部密钥'},
  ...keys.value.map(k => ({
    value: k.id as number | null,
    label: k.isDefault ? `${k.name}（默认）` : k.name
  }))
])

onMounted(async () => {
  await load()
  // 顺手拿一次汇率（跟用量页同一个接口，很轻）
  void fetchUsageSummary({days: 1}, 1)
    .then(s => {
      if (s?.rate) rate.value = s.rate
    })
    .catch(() => undefined)
})
</script>

<template>
  <div class="llm">
    <p v-if="error" class="err">{{ error }}</p>
    <p v-if="msg" class="ok">{{ msg }}</p>

    <!-- ① 密钥列表 -->
    <section class="panel keys">
      <div class="keys-head">
        <h2>
          我的密钥
          <small v-if="keys.length">{{ keys.length }} 把</small>
        </h2>
        <span class="dim tiny">分析用<b class="hl">默认</b>那把</span>
        <span class="spacer" />
        <button class="btn primary" type="button" @click="openNew">
          ＋ 新增密钥
        </button>
      </div>

      <p v-if="loading && !keys.length" class="dim">载入中…</p>

      <div v-for="k in keys" :key="k.id" class="krow">
        <div class="k-line">
          <b class="k-name">{{ k.name }}</b>
          <span v-if="k.isDefault" class="badge">默认</span>
          <span v-if="!k.apiKeySet" class="badge warn">未填 Key</span>
        </div>
        <div class="k-line">
          <code class="k-key">{{ k.apiKeySet ? k.apiKey : '—' }}</code>
          <span class="k-meta">{{ k.model || '默认模型' }}</span>
          <span v-if="k.baseUrl" class="k-meta dim">{{ k.baseUrl }}</span>
        </div>
        <div class="k-foot">
          <span class="k-stat">
            <i>调用</i>
            <b :title="`这把密钥累计调用 ${k.stats.calls} 次（全部时间）`">{{
              k.stats.calls
            }}</b>
          </span>
          <span class="k-stat">
            <i>花费</i>
            <b
              :title="`这把密钥累计花费 ${usd(k.stats.costUsd)}（全部时间）`"
              >{{ cny(k.stats.costUsd * rate) }}</b
            >
          </span>
          <span class="spacer" />
          <button class="mini" type="button" @click="openEdit(k)">编辑</button>
          <button
            v-if="!k.isDefault"
            class="mini"
            type="button"
            @click="makeDefault(k)"
          >
            设为默认
          </button>
          <button
            v-if="keys.length > 1"
            class="mini danger"
            type="button"
            @click="remove(k)"
          >
            删除
          </button>
        </div>
      </div>
    </section>

    <!-- ② 用量统计（跟密钥绑定） -->
    <section class="panel usage-bar">
      <h2>用量统计</h2>
      <span class="spacer" />
      <SegTabs v-model="filterKey" :options="keyFilters" />
    </section>

    <UsageView :key-id="filterKey" />

    <!-- ③ 新增 / 编辑弹窗 -->
    <Teleport to="body">
      <div v-if="editing" class="k-mask" @click.self="close">
        <div class="k-modal">
          <h3>{{ title }}</h3>

          <label>
            <span>名称</span>
            <input
              v-model="form.name"
              type="text"
              placeholder="如：主力 / 备用"
            />
          </label>

          <label>
            <span>API Key</span>
            <input
              v-model="form.apiKey"
              type="password"
              autocomplete="off"
              :placeholder="isNew ? 'sk-...' : '留空 = 不改（只显示掩码）'"
            />
          </label>

          <label>
            <span>接口地址</span>
            <input
              v-model="form.baseUrl"
              type="text"
              placeholder="https://api.deepseek.com"
            />
          </label>

          <label>
            <span>模型</span>
            <input
              v-model="form.model"
              type="text"
              list="llm-key-models"
              placeholder="deepseek-flash"
            />
            <datalist id="llm-key-models">
              <option v-for="m in modelIds" :key="m" :value="m" />
            </datalist>
          </label>

          <label>
            <span>思考力度</span>
            <select v-model="form.reasoningEffort">
              <option v-for="e in EFFORTS" :key="e.value" :value="e.value">
                {{ e.label }}
              </option>
            </select>
          </label>

          <p v-if="error" class="err">{{ error }}</p>

          <div class="k-actions">
            <button class="btn" type="button" @click="close">取消</button>
            <button
              class="btn primary"
              type="button"
              :disabled="saving"
              @click="save"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.llm {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.keys-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
h2 {
  margin: 0;
  font-size: 14px;
}
h2 small {
  margin-left: 6px;
  color: var(--muted);
  font-size: 12px;
}
.tiny {
  font-size: 11.5px;
}
.hl {
  color: var(--blue);
  margin: 0 2px;
}
.spacer {
  flex: 1 1 auto;
}

.krow {
  border-top: 1px solid var(--border);
  padding: 12px 0;
}
.krow:first-of-type {
  border-top: 0;
}
.k-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.k-name {
  font-size: 14px;
}
.badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--blue-soft);
  color: var(--blue);
}
.badge.warn {
  background: var(--warn);
  color: #1a1406;
}
.k-key {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  overflow-wrap: anywhere;
}
.k-meta {
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.k-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.k-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}
.k-stat i {
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
}
.k-stat b {
  font-size: 13px;
  font-family: var(--mono);
}
.mini {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.mini.danger {
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 40%, transparent);
}
.btn {
  padding: 8px 16px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 10px);
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
}
.btn.primary {
  border-color: transparent;
  background: var(--accent, #d3b583);
  color: var(--accent-ink, #17140f);
  font-weight: var(--fw-mid, 500);
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.usage-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

/* 弹窗 */
.k-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.k-modal {
  width: 100%;
  max-width: 380px;
  max-height: 88vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg, 18px);
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.k-modal h3 {
  margin: 0;
  font-size: 15px;
}
.k-modal label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.k-modal label span {
  font-size: 12px;
  color: var(--muted);
}
.k-modal input,
.k-modal select {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 13px;
}
.k-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.err {
  margin: 0;
  color: var(--bad);
  font-size: 12.5px;
}
.ok {
  margin: 0;
  color: var(--ok);
  font-size: 12.5px;
}
.dim {
  color: var(--muted);
}
</style>
