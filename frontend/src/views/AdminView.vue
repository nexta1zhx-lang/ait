<script setup lang="ts">
/**
 * 「我的 → 管理」（**只有管理员看得到**）。
 *
 * 用户 2026-10-04：「管理员账号我的页面加上管理界面，可以新增用户改密码查看 ds 的 api 数据」。
 *
 * 管理这半能：
 *   · 新增用户（含是否给管理员权限）
 *   · 改某个人的密码（改完那个人会被踢下线）
 *   · 查看每个人自己的 DeepSeek 配置（Key 默认打码，点「显示」看明文）
 *   · 删号（⚠️ 会把他名下的预测历史 / 知识库 / 用量一起删掉，要二次确认）
 *
 * 用户 2026-10-04（本轮）：「**服务器挪到管理界面 改为 tab 一个是用户管理 一个是服务器**」
 *   → 顶部一条二级 tab，「服务器」那半就是原来的 `ServerStatusView`（原样搬进来，一行未改）。
 *   ★ 那半用 `v-if` 挂：切到「用户管理」时就卸载，它内部的 3 秒轮询和 echarts 实例跟着停掉。
 *   当前 tab 由父页（`MeView`）持着，落地址栏 `?t=server` —— 所以组件这边受控。
 */
import {onMounted, ref} from 'vue'
import {
  createAdminUser,
  deleteAdminUser,
  fetchAdminUsers,
  setAdminUserPassword,
  type AdminUser
} from '../api'
import {user} from '../session'
import {bjTime} from '../format'
import {askConfirm} from '../confirm'
import SegTabs from '../comps/SegTabs.vue'
import ServerStatusView from './ServerStatusView.vue'

type AdminTab = 'users' | 'server'

const TABS: {value: AdminTab; label: string}[] = [
  {value: 'users', label: '用户管理'},
  {value: 'server', label: '服务器'}
]

const props = defineProps<{tab?: AdminTab}>()
const emit = defineEmits<{'update:tab': [AdminTab]}>()

const users = ref<AdminUser[]>([])
const loading = ref(false)
const error = ref('')
const msg = ref('')

/** 哪些行把 Key 展开成明文 */
const revealed = ref<Set<number>>(new Set())

/** 正在改谁（null = 没在改） */
const editingId = ref<number | null>(null)
const newPassword = ref('')

// 新增用户表单
const nuName = ref('')
const nuPass = ref('')
const nuAdmin = ref(false)
const creating = ref(false)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    users.value = (await fetchAdminUsers()).users
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function flash(text: string): void {
  msg.value = text
  window.setTimeout(() => {
    if (msg.value === text) msg.value = ''
  }, 3000)
}

async function create(): Promise<void> {
  msg.value = ''
  error.value = ''
  if (nuName.value.trim().length < 2 || nuPass.value.length < 6) {
    error.value = '用户名至少 2 位、密码至少 6 位'
    return
  }
  creating.value = true
  try {
    await createAdminUser({
      username: nuName.value.trim(),
      password: nuPass.value,
      isAdmin: nuAdmin.value
    })
    nuName.value = ''
    nuPass.value = ''
    nuAdmin.value = false
    flash('已创建')
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    creating.value = false
  }
}

function startEdit(id: number): void {
  editingId.value = id
  newPassword.value = ''
  msg.value = ''
  error.value = ''
}

async function savePassword(id: number): Promise<void> {
  msg.value = ''
  error.value = ''
  if (newPassword.value.length < 6) {
    error.value = '密码至少 6 位'
    return
  }
  try {
    await setAdminUserPassword(id, newPassword.value)
    editingId.value = null
    newPassword.value = ''
    flash('密码已改（那个人需要重新登录）')
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function removeUser(u: AdminUser): Promise<void> {
  const ok = await askConfirm({
    title: `确定删除用户「${u.username}」？`,
    body: [
      {t: `他名下的 ${u.stats.analyses} 条预测历史、${u.stats.knowledge} 条知识库和用量记录会一起删除。`, tone: 'num'},
      {t: '删掉就恢复不了了。', tone: 'warn'}
    ],
    okText: '删除用户',
    danger: true
  })
  if (!ok) return
  msg.value = ''
  error.value = ''
  try {
    await deleteAdminUser(u.id)
    flash('已删除')
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

function toggleReveal(id: number): void {
  const s = new Set(revealed.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  revealed.value = s
}

onMounted(load)
</script>

<template>
  <div class="admin">
    <SegTabs
      class="adm-tabs"
      :model-value="props.tab ?? 'users'"
      :options="TABS"
      @update:model-value="v => emit('update:tab', v as AdminTab)"
    />

    <!-- 服务器那半自己带面板和头部，不再套一层 -->
    <ServerStatusView v-if="props.tab === 'server'" />

    <div v-else class="adm-users">
      <section class="panel">
        <h2>新增用户</h2>
        <div class="new-row">
          <input v-model="nuName" type="text" placeholder="用户名（2~20 位）" />
          <input v-model="nuPass" type="text" placeholder="初始密码（≥6 位）" />
          <label class="chk">
            <input v-model="nuAdmin" type="checkbox" />
            <span>管理员</span>
          </label>
          <button
            class="btn primary"
            type="button"
            :disabled="creating"
            @click="create"
          >
            {{ creating ? '创建中…' : '创建' }}
          </button>
        </div>
        <p v-if="error" class="err">{{ error }}</p>
        <p v-if="msg" class="ok">{{ msg }}</p>
      </section>

      <section class="panel">
        <h2>
          用户 <small v-if="users.length">共 {{ users.length }} 个</small>
        </h2>
        <p v-if="loading" class="dim">载入中…</p>

        <div v-for="u in users" :key="u.id" class="urow">
          <div class="uhead">
            <span class="avatar">{{ u.username.slice(0, 1) }}</span>
            <b>{{ u.username }}</b>
            <span v-if="u.isAdmin" class="badge">管理员</span>
            <span v-if="u.id === user?.id" class="badge me">我</span>
            <span class="dim small">建于 {{ bjTime(u.createdAt) }}</span>
            <span class="spacer" />
            <span class="dim small">
              {{ u.stats.analyses }} 条分析 · {{ u.stats.knowledge }} 条知识库
            </span>
          </div>

          <div v-for="k in u.llmKeys" :key="k.id" class="llm">
            <span class="k">密钥</span>
            <b class="kname">{{ k.name }}</b>
            <span v-if="k.isDefault" class="badge">默认</span>
            <code v-if="k.apiKeySet" class="v">
              {{ revealed.has(k.id) ? k.apiKey : k.apiKeyMasked }}
            </code>
            <code v-else class="v dim">未填</code>
            <button
              v-if="k.apiKeySet"
              class="mini"
              type="button"
              @click="toggleReveal(k.id)"
            >
              {{ revealed.has(k.id) ? '隐藏' : '显示' }}
            </button>
            <span class="k">模型</span>
            <code class="v">{{ k.model || '（默认）' }}</code>
            <template v-if="k.baseUrl">
              <span class="k">接口</span>
              <code class="v">{{ k.baseUrl }}</code>
            </template>
          </div>
          <p v-if="!u.llmKeys.length" class="dim small">还没配密钥</p>

          <div class="actions">
            <template v-if="editingId === u.id">
              <input
                v-model="newPassword"
                type="text"
                class="pw"
                placeholder="新密码（≥6 位）"
                @keyup.enter="savePassword(u.id)"
              />
              <button
                class="btn primary"
                type="button"
                @click="savePassword(u.id)"
              >
                保存
              </button>
              <button class="btn" type="button" @click="editingId = null">
                取消
              </button>
            </template>
            <template v-else>
              <button class="btn" type="button" @click="startEdit(u.id)">
                改密码
              </button>
              <button
                v-if="u.id !== user?.id"
                class="btn danger"
                type="button"
                @click="removeUser(u)"
              >
                删除
              </button>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.adm-tabs {
  flex: 0 0 auto;
}
/*
 * 只有「用户管理」这半限宽（表单和名单太宽不好读）；
 * 「服务器」那半要铺满 —— 它里面是两列图表，限到 760px 会挤成一团。
 */
.adm-users {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}
.panel {
  padding: 16px;
}
h2 {
  margin: 0 0 12px;
  font-size: 14px;
}
h2 small {
  color: var(--muted);
  font-size: 12px;
  margin-left: 6px;
}
.new-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.new-row input[type='text'] {
  flex: 1 1 160px;
  min-width: 0;
  padding: 8px 10px;
  font-size: 13px;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
}
.btn {
  padding: 8px 14px;
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
.btn.danger {
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 40%, transparent);
}
.mini {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.urow {
  border-top: 1px solid var(--border);
  padding: 12px 0;
}
.urow:first-of-type {
  border-top: 0;
}
.uhead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: var(--fw-mid, 500);
}
.uhead b {
  font-size: 14px;
}
.badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--blue-soft);
  color: var(--blue);
}
.badge.me {
  background: var(--panel-2);
  color: var(--muted);
}
.spacer {
  flex: 1 1 auto;
}
.llm {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 8px 0 0;
  font-size: 11.5px;
}
.llm .k {
  color: var(--muted);
}
.llm + .llm {
  margin-top: 6px;
}
.kname {
  font-size: 12.5px;
  font-weight: var(--fw-mid, 500);
}
.llm .v {
  font-family: var(--mono);
  color: var(--text);
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.pw {
  padding: 7px 10px;
  font-size: 13px;
  flex: 1 1 160px;
  min-width: 0;
}
.dim {
  color: var(--muted);
}
.small {
  font-size: 11.5px;
}
.err {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--bad);
}
.ok {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: var(--ok);
}
</style>
