<script setup lang="ts">
/**
 * 「管理 → 代理订阅」—— 梯子用户的增删改查（2026-10-12）。
 *
 * 每人一个独立 UUID + 一条带 BasicAuth 的订阅地址。应用库是权威副本，
 * 每次改动后端会**整体**下发给宿主机的 xrayd 服务（见 backend/src/proxy.ts）。
 *
 * 这一页要解决的实际问题：以前加人得 SSH 上去跑脚本、还得手抄地址；
 * 现在在这儿点两下，订阅地址 / 二维码直接发给对方。
 *
 * ⚠️ 样式照 `AdminView.vue` 那半张卡抄（`.panel` / `.btn` / 行卡片那一套都是
 *    **各组件自己 scoped 定义**的，不是全局的）—— 少抄一条就会「一加就变形」。
 */
import {computed, onMounted, ref} from 'vue'
import {bjTime} from '../format'
import {askConfirm} from '../confirm'
import {copyText} from '../clipboard'
import {showToast} from '../toast'
import {
  createProxyUser,
  deleteProxyUser,
  fetchProxyUsers,
  proxyQr,
  rotateProxyPassword,
  rotateProxyUuid,
  setProxyUserEnabled,
  setProxyUserNote,
  syncProxyUsers,
  type ProxyHealth,
  type ProxyNodeInfo,
  type ProxyUser
} from '../api'

const users = ref<ProxyUser[]>([])
const node = ref<ProxyNodeInfo | null>(null)
const health = ref<ProxyHealth>({ok: false})
const loading = ref(true)
const busy = ref('')
const error = ref('')

const createOpen = ref(false)
const newName = ref('')
const newNote = ref('')

/** 二维码弹层：给谁、看哪种（订阅地址 / 单节点链接） */
const qr = ref<{user: ProxyUser; what: 'sub' | 'node'; dataUrl: string} | null>(null)

const enabledCount = computed(() => users.value.filter(u => u.enabled).length)

/**
 * 后端版本太旧时（没有 `/api/admin/proxy` 这个路由）拿到的是 404 "Not Found"，
 * 那时候说「宿主机连不上」是误导 —— 实测就踩过：本地 dev server 还是旧代码，
 * 页面显示「xrayd 连不上」，其实根本没走到 agent。
 */
const staleBackend = computed(() => /not\s*found|404/i.test(error.value))

/** 宿主机上启用的人数 —— 和库里对不上就是没同步上 */
const drift = computed(
  () =>
    health.value.ok &&
    typeof health.value.enabledUsers === 'number' &&
    health.value.enabledUsers !== enabledCount.value
)

async function copy(text: string, label: string): Promise<void> {
  /*
   * ⚠️ 复制这件事**收在 `clipboard.ts` 一处**（2026-10-13）：这一页原来自己写了一份
   *    「有 clipboard API 就用新的，没有才退老的」—— 装机版 App 的 WebView 里
   *    那个 API **在、但会 reject**，于是永远走不到退路，用户报「代理订阅的复制
   *    在 app 里不生效」。现在交给 `copyText()`：新的失败就退老的，还返回成没成。
   */
  if (await copyText(text)) showToast(`${label}已复制`)
  else showToast('复制失败，长按手动选中吧', 'bad')
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await fetchProxyUsers()
    users.value = r.users
    node.value = r.node
    health.value = r.health
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 统一的「跑一个动作」包装：转圈 + 报错 + 刷新 */
async function run(key: string, fn: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = key
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
    await load()
  }
}

const doCreate = () =>
  run('create', async () => {
    const created = await createProxyUser({name: newName.value.trim(), note: newNote.value.trim()})
    createOpen.value = false
    newName.value = ''
    newNote.value = ''
    showToast(`已创建 ${created.user.name}`)
    await copy(created.user.subUrl, '订阅地址')
  })

const toggle = (u: ProxyUser) =>
  run(`toggle-${u.id}`, async () => {
    await setProxyUserEnabled(u.id, !u.enabled)
    showToast(u.enabled ? `已停用 ${u.name}` : `已启用 ${u.name}`)
  })

const setNote = (u: ProxyUser) =>
  run(`note-${u.id}`, async () => {
    await setProxyUserNote(u.id, u.note)
    showToast('备注已存')
  })

const resetPassword = (u: ProxyUser) =>
  run(`pw-${u.id}`, async () => {
    const r = await rotateProxyPassword(u.id)
    showToast(`${u.name} 的新订阅密码已生成`)
    await copy(r.user.subUrl, '新订阅地址')
  })

const resetUuid = async (u: ProxyUser): Promise<void> => {
  const ok = await askConfirm({
    title: '换节点 UUID？',
    lines: [`${u.name} 旧的节点链接会立刻失效，订阅拉一次即可恢复。`],
    confirmText: '换掉'
  })
  if (!ok) return
  await run(`uuid-${u.id}`, async () => {
    await rotateProxyUuid(u.id)
    showToast(`${u.name} 的节点已换新`)
  })
}

const remove = async (u: ProxyUser): Promise<void> => {
  const ok = await askConfirm({
    title: `删掉 ${u.name}？`,
    lines: ['他的 UUID 立刻失效，订阅也拉不到了。'],
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  await run(`del-${u.id}`, async () => {
    const r = await deleteProxyUser(u.id)
    users.value = r.users
    health.value = r.health
    showToast(`已删除 ${u.name}`)
  })
}

const doSync = () =>
  run('sync', async () => {
    const r = await syncProxyUsers()
    if (!r.ok) throw new Error(r.error ?? '同步失败')
    users.value = r.users
    health.value = r.health
    showToast('已重新下发')
  })

async function openQr(u: ProxyUser, what: 'sub' | 'node'): Promise<void> {
  busy.value = `qr-${u.id}`
  try {
    const r = await proxyQr(u.id, what)
    qr.value = {user: u, what: r.what, dataUrl: r.dataUrl}
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="pxy">
    <section class="panel">
      <h2>
        代理订阅
        <small v-if="users.length">共 {{ users.length }} 个 · 启用 {{ enabledCount }} 个</small>
        <span class="spacer" />
        <button class="mini" type="button" :disabled="Boolean(busy)" @click="doSync">同步</button>
        <button class="btn primary add-btn" type="button" @click="createOpen = true">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新增用户
        </button>
      </h2>

      <!-- 先分清「后端太旧」和「真的连不上宿主机」—— 两种都表现为画面一片空 -->
      <p v-if="staleBackend" class="err">
        后端还是旧版本（没有 /api/admin/proxy 这个接口）：先把新版本发布上去
        （<code>bash scripts/release.sh</code>）；本地开发的话重启一下 dev server。
      </p>
      <template v-else>
        <p v-if="!health.ok && !loading" class="err">
          宿主机上的 xrayd 连不上，改人不会生效：{{ health.error }}
          <button class="mini" type="button" @click="doSync">重试</button>
        </p>
        <p v-else-if="drift" class="err">
          宿主机上是 {{ health.enabledUsers }} 个启用中的用户，这里显示 {{ enabledCount }} 个 —— 对不上。
          <button class="mini" type="button" @click="doSync">重新下发</button>
        </p>
        <p v-if="error" class="err">{{ error }}</p>
      </template>

      <p v-if="loading" class="dim">载入中…</p>
      <p v-else-if="!users.length" class="dim">
        还没有人 —— 点右上角「新增用户」。第一次打开这一页时，宿主机上已经存在的人会被自动导入进来。
      </p>

      <div v-for="u in users" :key="u.id" class="prow" :class="{off: !u.enabled}">
        <div class="phead">
          <span class="pavatar">{{ u.name.slice(0, 1).toUpperCase() }}</span>
          <div class="pid">
            <div class="pline">
              <b>{{ u.name }}</b>
              <span class="badge" :class="{me: !u.enabled}">
                {{ u.enabled ? '启用' : '已停用' }}
              </span>
            </div>
            <div class="pmeta">
              <span>建于 {{ bjTime(u.createdAt) }}</span>
              <span>{{ u.syncedAt ? '已下发 ' + bjTime(u.syncedAt) : '未下发' }}</span>
              <span class="uuid">{{ u.uuid }}</span>
            </div>
          </div>
        </div>

        <div class="pacts">
          <input
            v-model="u.note"
            class="pnote"
            type="text"
            placeholder="备注（给谁用的）"
            @change="setNote(u)"
          />
          <div class="pbtns">
            <button class="mini" type="button" @click="copy(u.subUrl, '订阅地址')">复制订阅</button>
            <button class="mini" type="button" @click="copy(u.nodeUrl, '节点链接')">复制节点</button>
            <button class="mini" type="button" @click="openQr(u, 'sub')">二维码</button>
            <button class="mini" type="button" :disabled="busy === `pw-${u.id}`" @click="resetPassword(u)">
              换密码
            </button>
            <button class="mini" type="button" :disabled="busy === `uuid-${u.id}`" @click="resetUuid(u)">
              换节点
            </button>
            <button class="mini" type="button" :disabled="busy === `toggle-${u.id}`" @click="toggle(u)">
              {{ u.enabled ? '停用' : '启用' }}
            </button>
            <button class="mini danger" type="button" :disabled="busy === `del-${u.id}`" @click="remove(u)">
              删除
            </button>
          </div>
        </div>
      </div>

      <p v-if="node" class="pfoot dim small">
        节点 {{ node.server }}:{{ node.port }} · SNI {{ node.sni }} · 订阅 https://{{ node.domain }}/sub/clash
      </p>
    </section>

    <!--
      新增用户弹层：跟「用户管理」那颗同一套（全局 `.sheet-mask` / `.sheet-head` /
      `.sheet-row`）。`Teleport` 到 body —— 弹层在别处，继承不到页面那棵树的
      CSS 变量，所以自带 `warm-skin`。
    -->
    <Teleport to="body">
      <div v-if="createOpen" class="sheet-mask" @click="createOpen = false" />
      <section
        v-if="createOpen"
        class="sheet warm-skin pxy-sheet"
        role="dialog"
        aria-label="新增代理用户"
      >
        <header class="sheet-head">
          <b>新增代理用户</b>
          <button type="button" class="sheet-x" title="关闭" @click="createOpen = false">✕</button>
        </header>
        <p class="dim small">
          名字就是订阅地址里的用户名 —— 字母 / 数字 / 下划线 / 中划线，1-32 位，不能和人重名。
        </p>
        <div class="sheet-row">
          <span class="rk">名字</span>
          <input
            v-model="newName"
            type="text"
            maxlength="32"
            placeholder="例如 zhangsan"
            @keyup.enter="doCreate"
          />
        </div>
        <div class="sheet-row">
          <span class="rk">备注</span>
          <input v-model="newNote" type="text" placeholder="可选，给谁用的" />
        </div>
        <p v-if="error" class="err">{{ error }}</p>
        <div class="pbtns end">
          <button class="btn" type="button" @click="createOpen = false">取消</button>
          <button
            class="btn primary"
            type="button"
            :disabled="!newName.trim() || busy === 'create'"
            @click="doCreate"
          >
            创建
          </button>
        </div>
      </section>

      <!-- 二维码 -->
      <div v-if="qr" class="sheet-mask" @click="qr = null" />
      <section v-if="qr" class="sheet warm-skin pxy-sheet" role="dialog" aria-label="二维码">
        <header class="sheet-head">
          <b>{{ qr.user.name }}</b>
          <button type="button" class="sheet-x" title="关闭" @click="qr = null">✕</button>
        </header>
        <img
          class="pqr"
          :src="qr.dataUrl"
          :alt="qr.what === 'sub' ? '订阅地址二维码' : '节点链接二维码'"
        />
        <p class="dim small">
          {{ qr.what === 'sub' ? '另一台设备扫码，把订阅地址复制过去' : 'Clash 手机端「扫码添加节点」扫这个' }}
        </p>
        <div class="pbtns end">
          <button
            class="btn"
            type="button"
            @click="openQr(qr.user, qr.what === 'sub' ? 'node' : 'sub')"
          >
            换成{{ qr.what === 'sub' ? '节点链接' : '订阅地址' }}
          </button>
          <button class="btn primary" type="button" @click="qr = null">关闭</button>
        </div>
      </section>
    </Teleport>
  </div>
</template>

<style scoped>
/* ==================== 卡 / 标题：与 AdminView 那半张卡一致 ==================== */
.pxy {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}
.panel {
  padding: 16px;
}
h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 13px;
}
h2 small {
  color: var(--muted);
  font-size: 11.5px;
  margin-left: 2px;
}
.spacer {
  flex: 1 1 auto;
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

/* ==================== 按钮（跟 AdminView / ExchangeKeys 同一套值） ==================== */
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
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 行内那些小按钮（比 `.btn` 小一号） */
.mini {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.mini:disabled {
  opacity: 0.45;
  cursor: default;
}
/* ⚠️ 写死 rgba，别用 color-mix —— 安卓 System WebView 算不出来（账户统计那页的坑） */
.mini.danger {
  color: var(--bad);
  border-color: rgba(255, 116, 128, 0.4);
}
.pbtns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pbtns.end {
  justify-content: flex-end;
  margin-top: 4px;
}

/* ==================== 一行一个人（跟「用户管理」那张卡同一套写法） ==================== */
.prow {
  padding: 12px 14px;
  border: 1px solid rgba(48, 39, 29, 0.72);
  border-radius: 12px;
  background:
    radial-gradient(ellipse at 12% 0%, rgba(120, 136, 163, 0.09), transparent 62%),
    linear-gradient(145deg, rgb(21, 22, 24), rgb(24, 19, 16));
}
.prow + .prow {
  margin-top: 10px;
}
.prow.off {
  opacity: 0.6;
}
.phead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pavatar {
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
.pid {
  min-width: 0;
}
.pline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.pline b {
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
.pmeta {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 2px;
  color: var(--muted);
  font-size: 11.5px;
}
.pmeta .uuid {
  font-family: var(--mono, ui-monospace);
  opacity: 0.7;
}
.pacts {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line, var(--border));
}
.pnote {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 9px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 10px);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}
.pfoot {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

/* ==================== 弹层里几处（其余用全局的 .sheet*） ==================== */
.pxy-sheet .sheet-row {
  padding: 10px 0;
}
.pxy-sheet .rk {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
}
/*
 * ⚠️ 必须显式 `width: auto`：全局那条 `input:not([type=checkbox])` 是给竖排表单写的
 *    （width:100%），在这种「标签 + 输入框」的横排里会把布局挤坏。
 */
.pxy-sheet .sheet-row input[type='text'] {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.pxy-sheet .err {
  margin: 0 0 2px;
}
.pqr {
  display: block;
  width: 220px;
  height: 220px;
  margin: 6px auto;
  image-rendering: pixelated;
  border-radius: 10px;
  background: #fff;
  padding: 6px;
}

.err {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--bad);
}
.err code {
  font-family: var(--mono, ui-monospace);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
}
.dim {
  color: var(--muted);
}
.small {
  font-size: 11.5px;
}
</style>
