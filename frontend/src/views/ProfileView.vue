<script setup lang="ts">
/**
 * 「我的 → 个人信息」。
 *
 * 用户原话：「新增个人信息界面，可以改信息和退出」。
 * 这里能改**用户名**、改**密码**、**看登录设备 / 踢设备**、退出登录。
 *
 * 改密码后**所有会话失效**（后端会踢掉），所以成功就直接退出登录。
 *
 * 2026-10-04 又加了：
 *   · **登录设备**（用户：「账户支持多端登录」）—— 每个设备一条会话，
 *     能看到设备名 / IP / 最后活跃，也能单独把某一台踢下线
 *   · **两步验证**（用户：「admin 这个账号设备认证可以做吗」→ 选了 TOTP）——
 *     ⚠️ **只有管理员看得到这块**（后端也按 is_admin 挡着）
 */
import {computed, onMounted, ref} from 'vue'
import {
  authChangePassword,
  disableTotp,
  enableTotp,
  fetchSessions,
  fetchStatsSettings,
  fetchTotpState,
  revokeOtherSessions,
  revokeSession,
  saveStatsSettings as saveStatsSettingsApi,
  setupTotp,
  type DeviceSession
} from '../api'
import {logout, rename, user} from '../session'
import {bjTime} from '../format'
import {askConfirm} from '../confirm'
import {shellInfo, type ShellInfo} from '../native'
import SegTabs from '../comps/SegTabs.vue'
import ExchangeKeys from '../comps/ExchangeKeys.vue'
import LlmConfigView from './LlmConfigView.vue'

/*
 * 用户 2026-10-04（本轮）：「个人信息下添加交易所内容（可新增交易所和 key，
 * 支持多个）；其余内容放两个 tab —— 账户信息 / 登录设备」。
 *
 * 所以这页现在顶上一条分段 tab：
 *   · 账户信息：身份卡 + 基本信息 + 两步验证 + 修改密码 + 退出
 *   · 交易所：绑多套交易所 API Key
 *   · 登录设备：多端登录的会话列表（踢设备）
 *
 * 用户 2026-10-06：「模型配置移动到个人信息」——
 * 又从「我的」把「模型配置」（多把大模型密钥 + 用量统计）搬进来当第四段，
 * 不再单独占一格。
 */
type ProfTab = 'account' | 'exchange' | 'llm' | 'devices'

const TABS: {value: ProfTab; label: string}[] = [
  {value: 'account', label: '账户信息'},
  {value: 'exchange', label: '交易所'},
  {value: 'llm', label: '模型配置'},
  {value: 'devices', label: '登录设备'}
]

const tab = ref<ProfTab>('account')

const name = ref('')
const nameBusy = ref(false)
const nameMsg = ref('')
const nameErr = ref('')

const oldPw = ref('')
const newPw = ref('')
const pwBusy = ref(false)
const pwMsg = ref('')
const pwErr = ref('')

/* ------------------------- 登录设备 ------------------------- */

const sessions = ref<DeviceSession[]>([])
const sessBusy = ref(false)
const sessMsg = ref('')
const sessErr = ref('')

async function loadSessions(): Promise<void> {
  sessErr.value = ''
  try {
    sessions.value = (await fetchSessions()).sessions
  } catch (e) {
    sessErr.value = (e as Error).message
  }
}

/** 「最后活跃」：今天显示时分秒，其它天显示到分钟 */
function seenText(iso: string): string {
  const t = bjTime(iso)
  const today = bjTime(new Date().toISOString()).slice(0, 10)
  return t.startsWith(today) ? t.slice(-8) : t.slice(5, 16)
}

async function kick(s: DeviceSession): Promise<void> {
  if (sessBusy.value) return
  const label = s.current ? '本机' : s.device
  const ok = await askConfirm({
    title: `让「${label}」下线？`,
    body: s.current
      ? '这就是你现在这台，退出后要重新登录。'
      : '那台设备下次操作时要重新登录。',
    okText: '下线'
  })
  if (!ok) return
  sessBusy.value = true
  sessMsg.value = ''
  sessErr.value = ''
  try {
    await revokeSession(s.id)
    if (s.current) {
      // 把自己踢了 = 登出
      await logout()
      return
    }
    sessMsg.value = '已下线一台'
    await loadSessions()
  } catch (e) {
    sessErr.value = (e as Error).message
  } finally {
    sessBusy.value = false
  }
}

async function kickOthers(): Promise<void> {
  if (sessBusy.value) return
  const ok = await askConfirm({
    title: '除本机以外的所有设备都下线？',
    okText: '全部下线'
  })
  if (!ok) return
  sessBusy.value = true
  sessMsg.value = ''
  sessErr.value = ''
  try {
    const r = await revokeOtherSessions()
    sessMsg.value = r.revoked ? `已下线 ${r.revoked} 台` : '没有别的设备在线'
    await loadSessions()
  } catch (e) {
    sessErr.value = (e as Error).message
  } finally {
    sessBusy.value = false
  }
}

const otherCount = computed(() => sessions.value.filter(s => !s.current).length)

/* ------------------------- 两步验证 ------------------------- */

const isAdmin = computed(() => Boolean(user.value?.isAdmin))
const totpOn = ref(false)
const recoveryLeft = ref(0)
const totpBusy = ref(false)
const totpErr = ref('')
const totpMsg = ref('')

/** 绑定中：二维码 + 密钥 + 输码框 */
const bindOpen = ref(false)
const bindSecret = ref('')
const bindQr = ref('')
const bindCode = ref('')
/** 开启成功后一次性给出的恢复码 */
const recoveryCodes = ref<string[]>([])

/** 关闭两步验证 */
const offOpen = ref(false)
const offPw = ref('')
const offCode = ref('')

async function loadTotp(): Promise<void> {
  if (!isAdmin.value) return
  try {
    const s = await fetchTotpState()
    totpOn.value = s.enabled
    recoveryLeft.value = s.recoveryLeft
  } catch {
    /* 拉不到就当没开，不打扰用户 */
  }
}

async function startBind(): Promise<void> {
  totpBusy.value = true
  totpErr.value = ''
  totpMsg.value = ''
  recoveryCodes.value = []
  try {
    const r = await setupTotp()
    bindSecret.value = r.secret
    bindQr.value = r.qr
    bindCode.value = ''
    bindOpen.value = true
  } catch (e) {
    totpErr.value = (e as Error).message
  } finally {
    totpBusy.value = false
  }
}

async function confirmBind(): Promise<void> {
  if (totpBusy.value) return
  totpBusy.value = true
  totpErr.value = ''
  try {
    const r = await enableTotp(bindCode.value.trim())
    recoveryCodes.value = r.recoveryCodes
    totpOn.value = true
    recoveryLeft.value = r.recoveryCodes.length
    bindOpen.value = false
    totpMsg.value = '两步验证已开启'
  } catch (e) {
    totpErr.value = (e as Error).message
  } finally {
    totpBusy.value = false
  }
}

async function confirmOff(): Promise<void> {
  if (totpBusy.value) return
  totpBusy.value = true
  totpErr.value = ''
  totpMsg.value = ''
  try {
    await disableTotp(offPw.value, offCode.value.trim())
    totpOn.value = false
    recoveryLeft.value = 0
    recoveryCodes.value = []
    offOpen.value = false
    offPw.value = ''
    offCode.value = ''
    totpMsg.value = '两步验证已关闭'
  } catch (e) {
    totpErr.value = (e as Error).message
  } finally {
    totpBusy.value = false
  }
}

async function copySecret(): Promise<void> {
  try {
    await navigator.clipboard.writeText(bindSecret.value)
    totpMsg.value = '密钥已复制'
  } catch {
    totpErr.value = '复制失败，手动抄一下吧'
  }
}

/* ------------------------- 基本信息 ------------------------- */

/* ------------------- 账户统计配置（2026-10-09） ------------------- */

const statsBenchmark = ref('1000')
const statsCurrency = ref<'usd' | 'cny'>('usd')
const statsBusy = ref(false)
const statsMsg = ref('')
const statsErr = ref('')

async function loadStatsSettings(): Promise<void> {
  try {
    const {settings} = await fetchStatsSettings()
    statsBenchmark.value = String(settings.benchmark)
    statsCurrency.value = settings.currency
  } catch (e) {
    statsErr.value = (e as Error).message
  }
}

async function saveStats(): Promise<void> {
  if (statsBusy.value) return
  const base = Number(statsBenchmark.value)
  if (!Number.isFinite(base) || base <= 0) {
    statsErr.value = '收益率基准必须大于 0'
    return
  }
  statsBusy.value = true
  statsMsg.value = ''
  statsErr.value = ''
  try {
    const {settings} = await saveStatsSettingsApi({
      benchmark: base,
      currency: statsCurrency.value
    })
    statsBenchmark.value = String(settings.benchmark)
    statsCurrency.value = settings.currency
    statsMsg.value = '已保存'
  } catch (e) {
    statsErr.value = (e as Error).message
  } finally {
    statsBusy.value = false
  }
}

onMounted(() => {
  name.value = user.value?.username ?? ''
  void loadSessions()
  void loadTotp()
  void loadShell()
  void loadStatsSettings()
})

/* ------------------------- App 体检单 ------------------------- */
/*
 * 只在原生壳里有内容（网页版 `shellInfo()` 返回 null，整块不渲染）。
 * 用途见 `native.ts` 的 `ShellInfo` 注释 —— 简而言之：
 * 「系统栏那条颜色不对」这类问题，分不出是「壳太旧」还是「WebView 没铺满」，
 * 把这几项摆在页面上就不用猜了。
 */
const shell = ref<ShellInfo | null>(null)

async function loadShell(): Promise<void> {
  try {
    shell.value = await shellInfo()
  } catch {
    /* 体检单拿不到不该报错给用户看 */
  }
}

async function saveName(): Promise<void> {
  nameMsg.value = ''
  nameErr.value = ''
  const v = name.value.trim()
  if (!v || v === user.value?.username) {
    name.value = user.value?.username ?? ''
    return
  }
  nameBusy.value = true
  try {
    await rename(v)
    nameMsg.value = '用户名已改'
  } catch (e) {
    nameErr.value = (e as Error).message
  } finally {
    nameBusy.value = false
  }
}

async function changePw(): Promise<void> {
  pwMsg.value = ''
  pwErr.value = ''
  if (newPw.value.length < 6) {
    pwErr.value = '新密码至少 6 位'
    return
  }
  pwBusy.value = true
  try {
    await authChangePassword(oldPw.value, newPw.value)
    // 后端已经把会话全踢了 → 直接回登录页
    await logout()
  } catch (e) {
    pwErr.value = (e as Error).message
  } finally {
    pwBusy.value = false
  }
}
</script>

<template>
  <div class="profile">
    <SegTabs class="prof-tabs" v-model="tab" :options="TABS" />

    <section v-if="tab === 'account'" class="panel who">
      <span class="avatar">{{ (user?.username ?? '?').slice(0, 1) }}</span>
      <div class="who-text">
        <b>{{ user?.username }}</b>
        <small>
          {{ user?.isAdmin ? '管理员' : '普通账号' }}
        </small>
      </div>
    </section>

    <section v-if="tab === 'account'" class="panel">
      <h2>基本信息</h2>
      <label>
        <span>用户名</span>
        <input
          v-model="name"
          type="text"
          maxlength="20"
          placeholder="2~20 位，中英文 / 数字 / _ -"
          @keyup.enter="saveName"
        />
      </label>
      <p v-if="nameErr" class="err">{{ nameErr }}</p>
      <p v-if="nameMsg" class="ok">{{ nameMsg }}</p>
      <div class="row">
        <button
          class="btn primary"
          type="button"
          :disabled="nameBusy"
          @click="saveName"
        >
          {{ nameBusy ? '保存中…' : '保存' }}
        </button>
      </div>
    </section>

    <!--
      账户统计配置（用户 2026-10-09：「在配置里面选择的配置，要保存到个人的后端和个人信息中」）。
      跟「我的 → 账户统计」右上角齿轮里的是**同一份**（服务端 /api/stats-settings，
      按用户存库），两处改哪边都会同步 —— 所以这里也放一个入口，省得非要进统计页才能改。
    -->
    <section v-if="tab === 'account'" class="panel">
      <h2>账户统计配置</h2>
      <p class="hint">
        收益率基准与金额显示单位；跟「我的 → 账户统计」右上角配置里的是同一份（存在服务器上，换设备也在）。
      </p>
      <label>
        <span>收益率基准金额（USDT）</span>
        <input
          v-model="statsBenchmark"
          type="number"
          min="0.01"
          step="any"
          inputmode="decimal"
        />
      </label>
      <label>
        <span>金额显示单位</span>
        <div class="seg-inline">
          <button
            type="button"
            :class="{on: statsCurrency === 'usd'}"
            @click="statsCurrency = 'usd'"
          >
            美元
          </button>
          <button
            type="button"
            :class="{on: statsCurrency === 'cny'}"
            @click="statsCurrency = 'cny'"
          >
            人民币
          </button>
        </div>
      </label>
      <p v-if="statsErr" class="err">{{ statsErr }}</p>
      <p v-if="statsMsg" class="ok">{{ statsMsg }}</p>
      <div class="row">
        <button class="btn primary" type="button" :disabled="statsBusy" @click="saveStats">
          {{ statsBusy ? '保存中…' : '保存' }}
        </button>
      </div>
    </section>

    <!-- 交易所：绑多套 Key（用户 2026-10-04 新增，独立成一个 tab） -->
    <ExchangeKeys v-if="tab === 'exchange'" />

    <!-- 模型配置：多把大模型密钥 + 用量统计（用户 2026-10-06 从「我的」搬进来） -->
    <LlmConfigView v-if="tab === 'llm'" />

    <section v-if="tab === 'devices'" class="panel">
      <h2>
        登录设备
        <small v-if="sessions.length">共 {{ sessions.length }} 台</small>
      </h2>

      <p class="note">
        同一账号可以在多台设备上同时登着，互不影响。看到不认识的就把它踢下线。
      </p>

      <ul class="devices">
        <li v-for="s in sessions" :key="s.id" :class="{on: s.current}">
          <div class="d-main">
            <b>{{ s.device }}</b>
            <span v-if="s.current" class="badge">本机</span>
          </div>
          <div class="d-sub">
            <span v-if="s.ip">{{ s.ip }}</span>
            <span>最后活跃 {{ seenText(s.lastSeenAt) }}</span>
            <span class="dim"
              >登录于 {{ bjTime(s.createdAt).slice(5, 16) }}</span
            >
          </div>
          <div class="d-act">
            <button
              class="mini"
              type="button"
              :disabled="sessBusy"
              @click="kick(s)"
            >
              {{ s.current ? '退出登录' : '下线' }}
            </button>
          </div>
        </li>
      </ul>

      <p v-if="sessErr" class="err">{{ sessErr }}</p>
      <p v-if="sessMsg" class="ok">{{ sessMsg }}</p>
      <div class="row">
        <button
          class="btn"
          type="button"
          :disabled="sessBusy || otherCount === 0"
          @click="kickOthers"
        >
          除本机外全部下线{{ otherCount ? `（${otherCount}）` : '' }}
        </button>
        <button
          class="btn"
          type="button"
          :disabled="sessBusy"
          @click="loadSessions"
        >
          刷新
        </button>
      </div>
    </section>

    <!-- 两步验证：只有管理员看得到（后端也按 is_admin 挡着） -->
    <section v-if="isAdmin && tab === 'account'" class="panel">
      <h2>
        两步验证
        <small v-if="totpOn" class="state-on">已开启</small>
        <small v-else>未开启</small>
      </h2>

      <p class="note">
        开启后，登录这个账号除了密码还要输认证器 App 里的 6 位动态口令。
        建议管理员账号一定开着 —— 它是唯一能管账号的号。
      </p>

      <p v-if="totpErr" class="err">{{ totpErr }}</p>
      <p v-if="totpMsg" class="ok">{{ totpMsg }}</p>

      <!-- 一次性恢复码 -->
      <div v-if="recoveryCodes.length" class="recover">
        <b>把这 8 个恢复码抄下来（只显示这一次）</b>
        <p class="note">
          手机丢了或换手机时，输一个就能登录（<b>用过的作废</b>）。
          别截图存相册，手写在纸上更稳妥。
        </p>
        <ul class="codes">
          <li v-for="c in recoveryCodes" :key="c">
            <code>{{ c }}</code>
          </li>
        </ul>
      </div>

      <!-- 绑定中 -->
      <template v-else-if="bindOpen">
        <ol class="steps">
          <li>
            手机装个认证器 App（Google Authenticator / 1Password / Microsoft
            Authenticator 都行）
          </li>
          <li>扫下面这个码（扫不了就手动输密钥）</li>
          <li>把 App 里显示的 6 位数字填到下面，点确认</li>
        </ol>
        <div class="qr" v-html="bindQr" />
        <div class="secret">
          <code>{{ bindSecret }}</code>
          <button class="mini" type="button" @click="copySecret">复制</button>
        </div>
        <div class="row">
          <input
            v-model="bindCode"
            class="code"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="6 位数字"
            @keyup.enter="confirmBind"
          />
          <button
            class="btn primary"
            type="button"
            :disabled="totpBusy || bindCode.length < 6"
            @click="confirmBind"
          >
            {{ totpBusy ? '校验中…' : '确认开启' }}
          </button>
          <button class="btn" type="button" @click="bindOpen = false">
            取消
          </button>
        </div>
      </template>

      <!-- 已开启 → 关闭 -->
      <template v-else-if="totpOn">
        <p class="note">
          还剩 <b>{{ recoveryLeft }}</b> 个恢复码没用。
        </p>
        <div v-if="!offOpen" class="row">
          <button class="btn" type="button" @click="offOpen = true">
            关闭两步验证
          </button>
        </div>
        <template v-else>
          <label>
            <span>密码</span>
            <input
              v-model="offPw"
              type="password"
              autocomplete="current-password"
            />
          </label>
          <label>
            <span>动态口令（或一个恢复码）</span>
            <input
              v-model="offCode"
              class="code"
              type="text"
              inputmode="numeric"
              maxlength="12"
              placeholder="6 位数字"
            />
          </label>
          <div class="row">
            <button
              class="btn primary"
              type="button"
              :disabled="totpBusy || !offPw || offCode.length < 6"
              @click="confirmOff"
            >
              {{ totpBusy ? '提交中…' : '确认关闭' }}
            </button>
            <button class="btn" type="button" @click="offOpen = false">
              取消
            </button>
          </div>
        </template>
      </template>

      <!-- 未开启 → 开启 -->
      <div v-else class="row">
        <button
          class="btn primary"
          type="button"
          :disabled="totpBusy"
          @click="startBind"
        >
          {{ totpBusy ? '生成中…' : '开启两步验证' }}
        </button>
      </div>
    </section>

    <section v-if="tab === 'account'" class="panel">
      <h2>修改密码</h2>
      <label>
        <span>原密码</span>
        <input
          v-model="oldPw"
          type="password"
          autocomplete="current-password"
        />
      </label>
      <label>
        <span>新密码</span>
        <input
          v-model="newPw"
          type="password"
          autocomplete="new-password"
          placeholder="至少 6 位"
        />
      </label>
      <p v-if="pwErr" class="err">{{ pwErr }}</p>
      <p v-if="pwMsg" class="ok">{{ pwMsg }}</p>
      <div class="row">
        <button
          class="btn primary"
          type="button"
          :disabled="pwBusy"
          @click="changePw"
        >
          {{ pwBusy ? '提交中…' : '修改密码' }}
        </button>
        <span class="dim tiny">改完所有设备都要重新登录</span>
      </div>
    </section>

    <section v-if="tab === 'account' && shell" class="panel">
      <h2>App 信息</h2>
      <p class="note">
        这一块是给「状态栏 / 安全区颜色不对」这类问题留的体检单。
        <br />
        <b>原生壳版本</b>：我们用的是远程加载（`server.url`），
        <b>前端永远是线上最新版，而壳可能还是几个月前装的那个</b> ——
        所以改完原生代码觉得「没生效」时，先看这一项。
        <br />
        <b>WebView</b>：≥140 才会让页面铺满整屏（状态栏透明、透出页面背景）；
        低于 140 时状态栏背后是原生那层底色。
      </p>
      <ul class="kvs">
        <li>
          <span>原生壳版本</span><b>{{ shell.version }} ({{ shell.build }})</b>
        </li>
        <li>
          <span>平台</span><b>{{ shell.platform }}</b>
        </li>
        <li>
          <span>WebView 主版本</span><b>{{ shell.webview }}</b>
        </li>
        <li>
          <span>env(safe-area-inset-top)</span>
          <b>{{ shell.envTop }} px</b>
        </li>
        <li>
          <span>env(safe-area-inset-bottom)</span>
          <b>{{ shell.envBottom }} px</b>
        </li>
        <li>
          <span>SystemBars 注入 top</span>
          <b>{{ shell.cssTop || '（未注入）' }}</b>
        </li>
        <li>
          <span>SystemBars 注入 bottom</span>
          <b>{{ shell.cssBottom || '（未注入）' }}</b>
        </li>
        <li>
          <span>系统深色模式</span><b>{{ shell.dark ? '是' : '否' }}</b>
        </li>
      </ul>
    </section>

    <section v-if="tab === 'account'" class="panel">
      <h2>退出</h2>
      <div class="row">
        <button class="btn" type="button" @click="logout">退出登录</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.profile {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/*
 * 账户信息 / 交易所那几段是表单，太宽了不好读，压到 560px。
 * 「模型配置」（`.llm`）自带密钥表 + 用量统计，要占满整行，所以不在这里限宽。
 * （以前是 `.profile` 自己 `max-width: 560px`，会把整页连同那一格一起压窄。）
 */
.profile > section.panel {
  max-width: 560px;
}
.who {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--blue-soft);
  color: var(--blue);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: var(--fw-mid, 500);
}
.who-text b {
  display: block;
  font-size: 15px;
}
.who-text small {
  color: var(--muted);
  font-size: 12px;
}
h2 {
  margin: 0 0 12px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
h2 small {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: var(--fw-normal, 400);
}
h2 small.state-on {
  color: var(--ok);
}
label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
label span {
  font-size: 12px;
  color: var(--muted);
}
/* 说明小字（账户统计配置那块用） */
.hint {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}
/* 「美元 / 人民币」这种两选一：并排两个按钮，选中的那种高亮 */
.seg-inline {
  display: flex;
  gap: 6px;
}
.seg-inline button {
  flex: 1 1 0;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--muted);
  font-size: 12px;
}
.seg-inline button.on {
  border-color: var(--accent);
  color: var(--accent);
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  font-size: 14px;
}
/* 口令输入：等宽 + 居中，方便对着手机抄 */
input.code {
  font-family: var(--mono);
  letter-spacing: 2px;
  text-align: center;
}
/*
 * 「App 信息」体检单的键值行。
 * 左标签 / 右值，值用等宽字体 —— 版本号、像素数这种一眼要比对的东西，
 * 等宽更好读。窄屏也不折行（min-width:0 + 右对齐）。
 */
.kvs {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kvs li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.kvs li:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.kvs li span {
  color: var(--muted);
  flex: 0 0 auto;
}
.kvs li b {
  font-weight: var(--fw-mid, 500);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-align: right;
  min-width: 0;
  overflow-wrap: anywhere;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
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
.mini {
  padding: 3px 10px;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.note {
  margin: 0 0 10px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--muted);
}
.tiny {
  font-size: 11.5px;
}
.dim {
  color: var(--muted);
}
.err {
  margin: 0 0 8px;
  color: var(--bad);
  font-size: 12.5px;
}
.ok {
  margin: 0 0 8px;
  color: var(--ok);
  font-size: 12.5px;
}

/* ---- 登录设备 ---- */
.devices {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
}
.devices li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 10px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.devices li:first-child {
  border-top: 0;
}
.d-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.d-main b {
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.devices li.on .d-main b {
  color: var(--blue);
}
.d-sub {
  grid-column: 1;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--muted);
}
.d-act {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
}
.badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  background: var(--blue-soft);
  color: var(--blue);
}

/* ---- 两步验证 ---- */
.steps {
  margin: 0 0 12px;
  padding-left: 20px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--muted);
}
.qr {
  width: 208px;
  height: 208px;
  /* ⚠️ 二维码必须白底深块才扫得出来，别跟暗色主题走 */
  background: #fff;
  border-radius: var(--r-sm, 10px);
  padding: 6px;
  margin-bottom: 10px;
}
.qr :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.secret {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.secret code {
  font-family: var(--mono);
  font-size: 12.5px;
  letter-spacing: 1px;
  padding: 5px 9px;
  border-radius: var(--r-xs, 8px);
  background: var(--panel-2);
  border: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.recover {
  padding: 12px;
  border-radius: var(--r-sm, 10px);
  background: var(--panel-2);
  border: 1px solid var(--border);
  margin-bottom: 10px;
}
.recover b {
  font-size: 13px;
}
.codes {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
}
.codes code {
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 1px;
  color: var(--text);
}
@media (max-width: 520px) {
  .codes {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
