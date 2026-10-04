<script setup lang="ts">
/**
 * 登录页（用户系统 2026-10-04）。
 *
 * ⚠️ **不开放注册**（用户 2026-10-04：「不开放注册」）——
 * 账号一律由管理员在「我的 → 管理」里创建，所以这里只有登录。
 * 未登录时 `App.vue` 会直接显示这一页（不挂站内导航）。
 *
 * 2026-10-04 又加了**第二关**：管理员开了两步验证（TOTP）后，
 * 密码过了还要输 6 位动态口令（或一个恢复码）——
 * 见 session.ts 的 login / loginTotp。
 */
import {computed, ref} from 'vue'
import {login, loginTotp} from '../session'

const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

/** 非空 = 密码已经过了，正等 6 位口令 */
const ticket = ref('')
const code = ref('')
const codeInput = ref<HTMLInputElement | null>(null)

const canSubmit = computed(
  () => username.value.trim().length >= 2 && password.value.length >= 6
)
/** 6 位数字，或恢复码（XXXXX-XXXXX，长度 11） */
const canVerify = computed(
  () => /^\d{6}$/.test(code.value) || code.value.length >= 10
)

async function submit(): Promise<void> {
  if (busy.value) return
  error.value = ''
  if (!canSubmit.value) return
  busy.value = true
  try {
    const r = await login(username.value.trim(), password.value)
    if (r.needTotp) {
      ticket.value = r.ticket ?? ''
      code.value = ''
      // 输入框是 v-if 刚插进来的，等一帧再聚焦
      requestAnimationFrame(() => codeInput.value?.focus())
    }
    // 不需要第二关的话 login() 里已经把 user 填上了，App.vue 会自己换页
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function verify(): Promise<void> {
  if (busy.value || !canVerify.value) return
  error.value = ''
  busy.value = true
  try {
    const r = await loginTotp(ticket.value, code.value.trim())
    if (r.recoveryUsed) {
      // 恢复码用掉一个，提醒一句（不拦着登录）
      console.warn('[auth] 本次用了恢复码，建议重新绑定一次两步验证')
    }
  } catch (e) {
    error.value = (e as Error).message
    code.value = ''
  } finally {
    busy.value = false
  }
}

/** 回到第一步（用户名密码输错 / 换账号） */
function back(): void {
  ticket.value = ''
  code.value = ''
  password.value = ''
  error.value = ''
}
</script>

<template>
  <div class="login">
    <div class="card">
      <h1>开单分析</h1>
      <p class="sub">登录后才能看自己的预测历史、知识库和模型配置</p>

      <!-- 第二关：两步验证 -->
      <form v-if="ticket" @submit.prevent="verify">
        <p class="who">
          ✓ 密码对了 —— <b>{{ username }}</b> 开了两步验证
        </p>
        <label>
          <span>动态口令</span>
          <input
            ref="codeInput"
            v-model="code"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            placeholder="6 位数字"
            maxlength="12"
            @input="code = code.trim()"
          />
        </label>
        <p class="hint">
          打开认证器 App（Google Authenticator / 1Password）看当前这 6 位。
          手机丢了就输一个<b>恢复码</b>（XXXXX-XXXXX）。
        </p>

        <p v-if="error" class="err">{{ error }}</p>

        <button class="submit" type="submit" :disabled="busy || !canVerify">
          {{ busy ? '验证中…' : '验证' }}
        </button>
        <button class="link" type="button" @click="back">返回重新输密码</button>
      </form>

      <!-- 第一关：用户名 + 密码 -->
      <form v-else @submit.prevent="submit">
        <label>
          <span>用户名</span>
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            placeholder="请输入用户名"
          />
        </label>
        <label>
          <span>密码</span>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
          />
        </label>

        <p v-if="error" class="err">{{ error }}</p>

        <button class="submit" type="submit" :disabled="busy">
          {{ busy ? '登录中…' : '登录' }}
        </button>
      </form>

      <p class="tip">不开放自行注册 —— 需要账号请联系管理员创建。</p>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  /* 登录页不挂站内导航，自己撑起整屏 */
  box-sizing: border-box;
}
.card {
  width: 100%;
  max-width: 360px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-lg, 18px);
  padding: 26px 22px 20px;
}
h1 {
  margin: 0 0 6px;
  font-size: 20px;
  color: var(--text);
}
.sub {
  margin: 0 0 18px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.6;
}
form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
label span {
  font-size: 12px;
  color: var(--muted);
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  font-size: 14px;
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--bad);
}
.submit {
  margin-top: 4px;
  padding: 10px 0;
  font-size: 14px;
  border: 0;
  border-radius: var(--r-sm, 10px);
  background: var(--accent, #d3b583);
  color: var(--accent-ink, #17140f);
  font-weight: var(--fw-mid, 500);
  cursor: pointer;
}
.submit:disabled {
  opacity: 0.6;
  cursor: default;
}
.tip {
  margin: 16px 0 0;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
}
/* 第二关（两步验证）用到的几条 */
.who {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.who b {
  color: var(--text);
}
.hint {
  margin: 0;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.6;
}
/* 口令输入：等宽 + 大字 + 居中，方便对着手机抄 */
input[inputmode='numeric'] {
  font-family: var(--mono);
  font-size: 18px;
  letter-spacing: 3px;
  text-align: center;
  padding: 10px 11px;
}
.link {
  margin-top: 2px;
  padding: 4px 0;
  font-size: 12px;
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  text-decoration: underline;
}
</style>
