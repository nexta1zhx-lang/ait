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
 *
 * ★ 2026-10-11（用户：「管理界新增用户弹窗，用户卡片优化显示和布局，管理页面样式同步」）：
 *   · 「新增用户」从占一张卡改成**标题右边一颗按钮 + 底部弹层**（`.sheet`，跟「个人信息」
 *     那颗「编辑」同一套）；创建成功自动关掉，提示回到名单那张卡里显示；
 *   · 每个用户从「一条分隔线 + 一行字段」改成**一张卡**：身份（头像/名字/徽章 + 副行）
 *     → 密钥 → 操作（右对齐），卡面跟账户页那套小卡一致；
 *   · 整页挂 `.warm-skin` + 胶囊分段 tab，跟「账户 / 个人信息 / 合约」统一风格；
 *     顺手修掉 `.btn.danger` 那条 `color-mix()` 描边（安卓 WebView 算不出来）。
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
import ProxyUsersPanel from '../comps/ProxyUsersPanel.vue'
import RustDeskPanel from '../comps/RustDeskPanel.vue'

type AdminTab = 'users' | 'server' | 'proxy' | 'rustdesk'

const TABS: {value: AdminTab; label: string}[] = [
  {value: 'users', label: '用户管理'},
  {value: 'server', label: '服务器'},
  {value: 'proxy', label: '代理订阅'},
  {value: 'rustdesk', label: '远程桌面'}
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

// 新增用户表单（★ 2026-10-11 起放在弹层里）
const nuName = ref('')
const nuPass = ref('')
const nuAdmin = ref(false)
const creating = ref(false)

/** 「新增用户」弹层开关（用户 2026-10-11：「管理界新增用户弹窗」） */
const createOpen = ref(false)

/** 打开弹层：先清掉上一次失败的提示，别让旧红字跟着进来 */
function openCreate(): void {
  error.value = ''
  msg.value = ''
  createOpen.value = true
}

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
    // 建完自己关掉：提示回到名单那张卡里显示（`flash`）
    createOpen.value = false
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
  <div class="admin warm-skin">
    <SegTabs
      class="adm-tabs"
      :model-value="props.tab ?? 'users'"
      :options="TABS"
      @update:model-value="v => emit('update:tab', v as AdminTab)"
    />

    <!-- 服务器那半自己带面板和头部，不再套一层 -->
    <ServerStatusView v-if="props.tab === 'server'" />

    <!-- 代理订阅（梯子）：同样自带面板 -->
    <ProxyUsersPanel v-else-if="props.tab === 'proxy'" />

    <!-- 远程桌面（RustDesk）：只读，同样自带面板 -->
    <RustDeskPanel v-else-if="props.tab === 'rustdesk'" />

    <div v-else class="adm-users">
      <section class="panel">
        <h2>
          用户 <small v-if="users.length">共 {{ users.length }} 个</small>
          <span class="spacer" />
          <!--
            ★ 2026-10-11（用户：「管理界新增用户弹窗」）—— 原来「新增用户」自己占一张卡
            （两个输入框 + 管理员勾选 + 创建键一行铺着），现在收成标题右边这颗按钮，
            点开是底部弹层（跟「我的 → 个人信息」那颗「编辑」同一套 `.sheet`）。
          -->
          <button class="btn primary add-btn" type="button" @click="openCreate">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            新增用户
          </button>
        </h2>
        <p v-if="loading" class="dim">载入中…</p>
        <!-- 提示条留在这张卡里（新增那个弹层开着时由弹层自己显示，见下面 `!createOpen`） -->
        <p v-if="error && !createOpen" class="err">{{ error }}</p>
        <p v-if="msg && !createOpen" class="ok">{{ msg }}</p>

        <div v-for="u in users" :key="u.id" class="urow">
          <div class="uhead">
            <span class="avatar">{{ u.username.slice(0, 1) }}</span>
            <div class="u-id">
              <div class="u-line">
                <b>{{ u.username }}</b>
                <span v-if="u.isAdmin" class="badge">管理员</span>
                <span v-if="u.id === user?.id" class="badge me">我</span>
              </div>
              <div class="u-meta">
                <span class="dim small">建于 {{ bjTime(u.createdAt) }}</span>
                <span class="dim small">
                  {{ u.stats.analyses }} 条预测 · {{ u.stats.knowledge }} 条知识库
                </span>
              </div>
            </div>
          </div>

          <div v-if="u.llmKeys.length" class="u-keys">
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
          </div>
          <p v-else class="dim small u-nokeys">还没配密钥</p>

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

    <!--
      ★ 2026-10-11「新增用户」弹层（用户：「管理界新增用户弹窗」）。
      跟「我的 → 个人信息」那颗「编辑」同一套：底部 `.sheet` + 自己挂 `warm-skin`
      （`Teleport` 到 body，继承不到页面那棵树的变量）。创建成功就自己关掉，
      提示条回到上面那张卡里显示（`flash`）。
    -->
    <Teleport to="body">
      <div v-if="createOpen" class="sheet-mask" @click="createOpen = false" />
      <section
        v-if="createOpen"
        class="sheet warm-skin adm-sheet"
        role="dialog"
        aria-label="新增用户"
      >
        <header class="sheet-head">
          <b>新增用户</b>
          <button
            type="button"
            class="sheet-x"
            title="关闭"
            @click="createOpen = false"
          >
            ✕
          </button>
        </header>

        <div class="sheet-row">
          <span class="rk">用户名</span>
          <input
            v-model="nuName"
            type="text"
            maxlength="20"
            placeholder="2~20 位"
          />
        </div>
        <div class="sheet-row">
          <span class="rk">初始密码</span>
          <input v-model="nuPass" type="text" placeholder="≥6 位" />
        </div>
        <div class="sheet-row">
          <span class="rk">管理员</span>
          <!--
            用全站那颗开关（跟「配置 → 测试下单」同一颗），别用原生 checkbox ——
            原生那颗在暖色弹层里是个灰方块，跟前后的胶囊完全不搭。
          -->
          <button
            type="button"
            class="switch"
            :class="{on: nuAdmin}"
            role="switch"
            :aria-checked="nuAdmin"
            :aria-label="nuAdmin ? '管理员' : '普通账号'"
            :title="nuAdmin ? '能进「管理」这一格' : '普通账号 —— 看不到「管理」那一格'"
            @click="nuAdmin = !nuAdmin"
          >
            <span />
          </button>
        </div>

        <p v-if="error" class="err">{{ error }}</p>
        <p v-if="msg" class="ok">{{ msg }}</p>
        <div class="row">
          <button
            class="btn primary"
            type="button"
            :disabled="creating"
            @click="create"
          >
            {{ creating ? '创建中…' : '创建' }}
          </button>
          <span class="dim small">建完可以直接把用户名 / 初始密码发给他</span>
        </div>
      </section>
    </Teleport>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/*
 * 二级 tab（用户管理 / 服务器）—— 跟「我的」那几格同一套**胶囊分段器**
 * （全局 `.seg` 是「矩形 + 按钮之间画分隔线」的老样子，现在统一换成胶囊）。
 */
.adm-tabs {
  flex: 0 0 auto;
  align-self: flex-start;
  max-width: 100%;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: linear-gradient(120deg, rgb(19, 19, 21), rgb(18, 15, 13));
  overflow-x: auto;
  scrollbar-width: none;
}
.adm-tabs::-webkit-scrollbar {
  display: none;
}
/* ⚠️ 按钮在子组件（`SegTabs.vue`）里 ⇒ 必须 `:deep()` */
.adm-tabs :deep(button) {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
}
.adm-tabs :deep(button.active) {
  background: linear-gradient(
    112deg,
    rgba(255, 217, 158, 0.25) 0%,
    rgba(255, 193, 107, 0.15) 52%,
    rgba(243, 154, 63, 0.09) 100%
  );
  color: #ffd291;
  box-shadow: inset 0 0 0 1px rgba(255, 193, 107, 0.12);
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
/* 段标题跟「账户 / 个人」那两页同一档（13px）；它右边那颗「新增用户」靠 `.spacer` 顶到最右 */
h2 {
  margin: 0 0 12px;
  font-size: 13px;
}
h2 small {
  color: var(--muted);
  font-size: 11.5px;
  margin-left: 6px;
}
/* 标题右边那颗「新增用户」：暖色胶囊 + 一颗加号（内联 SVG，别用 ＋ 字符） */
.add-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 11px;
  font-size: 12px;
  border-radius: 999px;
}
.add-btn svg {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
/* ⚠️ `.chk`（原生勾选框那一行）2026-10-11 删了：弹层里改用全站那颗 `.switch` */
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
/*
 * ⚠️ 原来用 `color-mix(in srgb, var(--bad) 40%, transparent)` 画描边 —— 那台机器的
 *    **安卓 System WebView 算不出来**（账户统计那页 2026-10-09 的坑），描边会退成
 *    `currentColor`（这里就是 `--bad` 的红），整颗按钮看着像实心红。改成写死的 rgba。
 */
.btn.danger {
  color: var(--bad);
  border-color: rgba(255, 116, 128, 0.4);
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
/*
 * ★ 2026-10-11「用户卡片优化显示和布局」：原来一个人是「一条分隔线 + 一行挤在一起的
 * 字段」，现在一人一张**卡**（写法跟账户页那些小卡一致：暖描边 + 极淡的斜向渐变），
 * 卡内三段：① 身份（头像 / 名字 / 徽章 + 副行）② 密钥 ③ 操作（右对齐）。
 */
.urow {
  padding: 12px 14px;
  border: 1px solid rgba(48, 39, 29, 0.72);
  border-radius: 12px;
  background:
    radial-gradient(ellipse at 12% 0%, rgba(120, 136, 163, 0.09), transparent 62%),
    linear-gradient(145deg, rgb(21, 22, 24), rgb(24, 19, 16));
}
.urow + .urow {
  margin-top: 10px;
}
.uhead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.u-id {
  min-width: 0;
}
.u-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.u-line b {
  font-size: 14px;
}
/* 副行：建于 xx ·（右）几条分析 / 几条知识库 —— 原来它们跟名字挤在同一行里 */
.u-meta {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 2px;
}
/* 密钥那一段跟身份之间一条淡分隔线（`.u-nokeys` 是「还没配密钥」那种同理） */
.u-keys,
.u-nokeys {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.u-nokeys {
  margin-bottom: 0;
}
/* 头像：暖色（`--blue*` 在暖色皮肤里就是琥珀，跟「我的」那张身份卡同一个头像写法） */
.avatar {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: var(--fw-mid, 500);
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
  /* 操作靠右站：卡片右下角那一组（改密码 / 保存 / 取消 / 删除） */
  justify-content: flex-end;
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

/* ==================== ★ 2026-10-11：新增用户弹层 ==================== */
/*
 * 一行一字段（标签在左、控件贴右），跟「我的 → 个人信息」那颗「编辑」、
 * 以及「交易所账户」那几颗弹层是同一套写法。
 */
.adm-sheet .sheet-row {
  padding: 10px 0;
}
.adm-sheet .rk {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
}
/*
 * ⚠️ 必须显式 `width: auto`：`style.css` 里那条全局 `input:not([type=checkbox]…)`
 *    是给竖排表单写的（`width: 100%`），放在这种「标签 + 输入框 + 按钮」的横排里
 *    会把按钮挤成两行（「个人信息」那颗「编辑」弹层实测过）。
 */
.adm-sheet .sheet-row input[type='text'] {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
/* 「管理员」那一行：开关贴右（跟配置弹层那颗一个位置） */
.adm-sheet .switch {
  margin-left: auto;
}
.adm-sheet .err,
.adm-sheet .ok {
  margin: 0 0 2px;
}
.adm-sheet .row {
  margin-top: 8px;
}
</style>
