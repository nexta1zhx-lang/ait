<script setup lang="ts">
/**
 * 「系统管理 → 代码编辑器」—— VS Code Web 的登录密码。
 *
 * VS Code 那边是 `code serve-web --without-connection-token`，本身没有密码；
 * 对外只有 Caddyfile 里 `code.bitcoooin.cn` 的 Basic Auth 这一道门。
 * 这一页只做两件事：显示隧道 / Caddy 状态，重设那一个密码。
 *
 * ⚠️ 原密码是 bcrypt 哈希，取不回来；忘了只能在这里重设。
 */
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {fetchCodeWeb, setCodeWebPassword, type CodeWebInfo} from '../api'
import {isNativeShell} from '../platform'
import {showToast} from '../toast'

const POLL_MS = 30_000

const info = ref<CodeWebInfo | null>(null)
const loading = ref(false)
const loadError = ref('')
const saveError = ref('')
const password = ref('')
const confirm = ref('')
const saving = ref(false)

let timer: number | null = null

const canSave = computed(
  () =>
    password.value.length >= 8 &&
    password.value === confirm.value &&
    !saving.value
)

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    info.value = await fetchCodeWeb()
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
    await setCodeWebPassword(password.value)
    password.value = ''
    confirm.value = ''
    showToast('登录密码已修改')
    await load()
  } catch (e) {
    saveError.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

function open(): void {
  const url = info.value?.url
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
  <div class="cw">
    <section class="panel">
      <h2>
        代码编辑器
        <small>VS Code Web</small>
        <span class="spacer" />
        <span
          v-if="info"
          class="dot"
          :class="info.online ? 'ok' : 'bad'"
        />
        <b
          v-if="info"
          class="svc"
          :class="info.online ? 'ok' : 'bad'"
        >
          {{ info.online ? '在线' : '离线' }}
        </b>
        <button class="mini" type="button" @click="load()">刷新</button>
      </h2>

      <p v-if="loading && !info" class="dim">载入中…</p>
      <p v-if="loadError" class="err">{{ loadError }}</p>
      <p v-if="info?.error" class="err">{{ info.error }}</p>

      <template v-if="info">
        <div class="kv">
          <span class="rk">地址</span>
          <code>{{ info.url }}</code>
          <button class="mini" type="button" @click="open">打开</button>
        </div>
        <div class="kv">
          <span class="rk">用户名</span>
          <code>{{ info.username || '（未配置）' }}</code>
        </div>
        <div class="kv">
          <span class="rk">Caddy</span>
          <span class="dim small">
            {{ info.caddyUp ? '容器在跑' : '容器没跑 / 连不上宿主机' }}
          </span>
        </div>
        <div class="kv">
          <span class="rk">反向隧道</span>
          <span class="dim small">
            {{
              info.tunnelUp
                ? `127.0.0.1:${info.port} 通`
                : `127.0.0.1:${info.port} 不通 —— 检查 Mac 上的 serve-web 和 ssh -R`
            }}
          </span>
        </div>
      </template>

      <p class="foot dim small">
        VS Code 以 <code>--without-connection-token</code> 启动，本身没有密码；
        外面这层登录框来自 Caddy 的 Basic Auth。
      </p>
    </section>

    <section class="panel">
      <h2>
        修改登录密码
        <small>只影响 {{ info?.domain || 'code.bitcoooin.cn' }}</small>
      </h2>

      <p class="dim small tip">
        原密码存的是 bcrypt 哈希，取不回来；这里只能重设。
        改完旧密码立刻失效，已经打开的页面下次请求会重新要密码。
      </p>

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
.cw {
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
.kv {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line, var(--border));
}
.kv:last-of-type {
  border-bottom: none;
}
.rk {
  flex: 0 0 88px;
  color: var(--muted);
  font-size: 12px;
}
.kv code {
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
</style>
