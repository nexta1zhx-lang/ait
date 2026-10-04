<script setup lang="ts">
/**
 * 右上角的**个人账户**（2026-10-04 改版）。
 *
 * 用户原话：「pc 端个人账户和退出放右上角」。
 * 所以这里收起了原来的「模型下拉」（模型现在跟**密钥**绑了，见「模型配置」页），
 * 换成：余额徽标 + 用户名（点开是「个人信息 / 退出登录」）。
 *
 * 同一份 UI 两处用：
 *   · 全局顶栏 —— 宽屏看这里
 *   · 「模型配置」页里的用量区 —— 窄屏顶栏收起来了，只在那儿露
 *     （外层给它挂 `usage-account` 控制显隐）
 */
import {onBeforeUnmount, ref, watch} from 'vue'
import {useRouter} from 'vue-router'
import {balanceBadge, refreshBalance, refreshingBalance} from '../store'
import {logout, user} from '../session'

const router = useRouter()
const open = ref(false)
const el = ref<HTMLElement | null>(null)

/** 点页面别处就把菜单收起来 */
function onDocDown(e: MouseEvent): void {
  if (!el.value) return
  if (!el.value.contains(e.target as Node)) open.value = false
}
watch(open, v => {
  if (v) document.addEventListener('mousedown', onDocDown, true)
  else document.removeEventListener('mousedown', onDocDown, true)
})
onBeforeUnmount(() =>
  document.removeEventListener('mousedown', onDocDown, true)
)

function goProfile(): void {
  open.value = false
  void router.push({path: '/me', query: {p: 'profile'}})
}

async function doLogout(): Promise<void> {
  open.value = false
  await logout()
}
</script>

<template>
  <div v-if="user" ref="el" class="account">
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

    <div class="who">
      <button type="button" class="who-btn" @click="open = !open">
        <span class="avatar">{{ user.username.slice(0, 1) }}</span>
        <span class="name">{{ user.username }}</span>
        <svg viewBox="0 0 12 8" class="caret" aria-hidden="true">
          <path
            d="M1 1.5 6 6.5l5-5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>

      <div v-if="open" class="menu">
        <button type="button" @click="goProfile">个人信息</button>
        <button type="button" class="out" @click="doLogout">退出登录</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account {
  display: flex;
  align-items: center;
  gap: 10px;
}
.who {
  position: relative;
}
.who-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 10px 3px 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--text);
  font-size: 12.5px;
  cursor: pointer;
}
/* 悬停：触屏不应用（全站约定，见 style.css 里 `.seg` 上面那段说明） */
@media (hover: hover) {
  .who-btn:hover {
    border-color: var(--blue);
  }
}
.avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: var(--fw-mid, 500);
}
.caret {
  width: 10px;
  height: 7px;
  opacity: 0.6;
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 80;
  min-width: 132px;
  padding: 5px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 10px);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.menu button {
  text-align: left;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--r-xs, 8px);
  background: none;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}
/* 悬停：触屏不应用 */
@media (hover: hover) {
  .menu button:hover {
    background: var(--blue-soft);
    color: var(--blue);
  }
}
.menu button.out {
  color: var(--bad);
}
</style>
