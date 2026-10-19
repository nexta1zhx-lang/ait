<script setup lang="ts">
/**
 * 「系统管理 → Mac 服务」—— Mac 上那两个 Web 服务的入口状态 + 登录密码。
 *
 * 现在这一页管两个：
 *   · `code.bitcoooin.cn` → VS Code Web（`code serve-web`）
 *   · `chat.bitcoooin.cn` → DeepSeek Harness（`dsh --profile remote`）
 * 两个服务自己都不做认证，对外只有 Caddy 的 Basic Auth；而且在 Caddyfile 里
 * 共用同一个账号和哈希 ⇒ 这一页只放**一个**改密码表单，改完两边一起生效。
 *
 * ⚠️ 原密码存的是 bcrypt 哈希，取不回来；忘了只能在这里重设。
 */
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {
  fetchMacServices,
  setMacPassword,
  type MacServicesInfo
} from '../api'
import {isNativeShell} from '../platform'
import {showToast} from '../toast'

const POLL_MS = 30_000

const info = ref<MacServicesInfo | null>(null)
const loading = ref(false)
const loadError = ref('')
const saveError = ref('')
const password = ref('')
const confirm = ref('')
const saving = ref(false)

let timer: number | null = null

/** 有几个入口在用这套账号 */
const configured = computed(
  () => info.value?.services.filter(s => s.configured) ?? []
)

const onlineCount = computed(
  () => info.value?.services.filter(s => s.up).length ?? 0
)

const canSave = computed(
  () =>
    password.value.length >= 8 &&
    password.value === confirm.value &&
    !saving.value &&
    configured.value.length > 0
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    info.value = await fetchMacServices()
  } catch (e) {
    loadError.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  saveError.value = ''
  if (password.value.length < 8) {
    saveError.value = '密码至少 8 位'
    return
  }
  // 不一致时页面上那行提示已经在了，不用再叠一条
  if (password.value !== confirm.value) return
  saving.value = true
  try {
    await setMacPassword(password.value)
    password.value = ''
    confirm.value = ''
    showToast('登录密码已修改（所有 Mac 服务一起生效）')
    await load()
  } catch (e) {
    saveError.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

function open(url: string): void {
  if (!url) return
  // 原生壳里交给系统浏览器（同 ProfileView 的下载按钮），网页版新开标签页
  if (isNativeShell()) window.location.href = url
  else window.open(url, '_blank', 'noopener')
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), POLL_MS)
})

onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
})
</script>

<template>
  <div class="ms">
    <section class="panel">
      <h2>
        Mac 服务
        <small v-if="info?.services.length">
          在线 {{ onlineCount }} / {{ info.services.length }}
        </small>
        <span class="spacer" />
        <span v-if="info" class="dot" :class="info.caddyUp ? 'ok' : 'bad'" />
        <b v-if="info" class="svc" :class="info.caddyUp ? 'ok' : 'bad'">
          {{ info.caddyUp ? 'Caddy 正常' : 'Caddy 异常' }}
        </b>
        <button class="mini" type="button" @click="load()">刷新</button>
      </h2>

      <p v-if="loading && !info" class="dim">载入中…</p>
      <p v-if="loadError" class="err">{{ loadError }}</p>
      <p v-if="info?.error" class="err">{{ info.error }}</p>

      <p v-if="info && !info.services.length" class="dim">还没有配置任何服务。</p>

      <div v-for="s in info?.services ?? []" :key="s.key" class="srow">
        <div class="shead">
          <span class="dot" :class="s.up ? 'ok' : 'bad'" />
          <div class="s-id">
            <div class="s-line">
              <b>{{ s.name }}</b>
              <span v-if="!s.configured" class="badge bad">未配置</span>
              <span v-else-if="!s.up" class="badge bad">隧道不通</span>
              <span v-else class="badge">在线</span>
            </div>
            <div class="s-meta">
              <span>{{ s.detail }}</span>
              <span class="mono">127.0.0.1:{{ s.port }}</span>
            </div>
          </div>
        </div>
        <div class="sacts">
          <code class="surl">{{ s.url }}</code>
          <button class="mini" type="button" @click="open(s.url)">打开</button>
        </div>
      </div>

      <p class="foot dim small">
        这两个服务都跑在 Mac 上，经反向隧道由这台服务器转出去。
        连不上时先看 Mac 上的进程和那条 <code>ssh -R</code>；
        隧道在，这里就会显示「在线」。
      </p>
    </section>

    <section class="panel">
      <h2>
        修改登录密码
        <small v-if="configured.length">
          {{ configured.map(s => s.site).join(' / ') }}
        </small>
      </h2>

      <p class="dim small tip">
        原密码存的是 bcrypt 哈希，取不回来；这里只能重设。
        {{ configured.length > 1 ? '几个入口共用一套账号，改一次一起生效。' : '' }}
        改完旧密码立刻失效，已经打开的页面下次请求会重新要密码。
      </p>

      <label class="field">
        <span>用户名</span>
        <input :value="info?.username || '（未配置）'" type="text" disabled />
      </label>
      <label class="field">
        <span>新密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="new-password"
          placeholder="至少 8 位"
        />
      </label>
      <label class="field">
        <span>再输一次</span>
        <input
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          placeholder="再输一次"
          @keyup.enter="save"
        />
      </label>

      <p v-if="password && confirm && password !== confirm" class="err">
        两次输入的密码不一致
      </p>
      <p v-if="saveError" class="err">{{ saveError }}</p>

      <div class="row">
        <button
          class="btn primary"
          type="button"
          :disabled="!canSave"
          @click="save"
        >
          {{ saving ? '保存中…' : '修改密码' }}
        </button>
        <span class="dim small">保存后会校验 Caddyfile 并热重载，不会断站</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ms {
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
  flex-wrap: wrap;
}
h2 small {
  color: var(--muted);
  font-size: 11.5px;
  margin-left: 2px;
}
.spacer {
  flex: 1 1 auto;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--muted);
}
.dot.ok {
  background: var(--ok, #7ed3a3);
}
.dot.bad {
  background: var(--bad);
}
.svc {
  font-size: 11.5px;
  font-weight: var(--fw-mid, 500);
}
.svc.ok {
  color: var(--ok, #7ed3a3);
}
.svc.bad {
  color: var(--bad);
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

/* ==================== 一个服务一行（跟「远程桌面」那张卡同一套写法） ==================== */
.srow {
  padding: 12px 14px;
  border: 1px solid rgba(48, 39, 29, 0.72);
  border-radius: 12px;
  background:
    radial-gradient(ellipse at 12% 0%, rgba(120, 136, 163, 0.09), transparent 62%),
    linear-gradient(145deg, rgb(21, 22, 24), rgb(24, 19, 16));
}
.srow + .srow {
  margin-top: 10px;
}
.shead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.s-id {
  min-width: 0;
}
.s-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.s-line b {
  font-size: 14px;
}
.badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
}
.badge.bad {
  color: var(--bad);
  border-color: rgba(255, 116, 128, 0.4);
}
.s-meta {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 2px;
  color: var(--muted);
  font-size: 11.5px;
}
.mono {
  font-family: var(--mono, ui-monospace);
  opacity: 0.7;
}
.sacts {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line, var(--border));
}
.surl {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--mono, ui-monospace);
  font-size: 12px;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--panel-2);
  color: var(--text);
}

.tip {
  margin: 0 0 10px;
  line-height: 1.6;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 10px;
}
.field > span {
  font-size: 12px;
  color: var(--muted);
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
.btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.err {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--bad);
}
.foot {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  line-height: 1.6;
}
.foot code {
  font-family: var(--mono, ui-monospace);
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 6px;
  background: var(--panel-2);
}
</style>
