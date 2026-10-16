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
import {computed, onMounted, ref, watch} from 'vue'
import {
  authChangePassword,
  disableTotp,
  enableTotp,
  fetchPushStatus,
  fetchSessions,
  fetchTotpState,
  testPush,
  type PushStatus,
  revokeOtherSessions,
  revokeSession,
  setupTotp,
  type DeviceSession
} from '../api'
import {logout, rename, user} from '../session'
import {isNativeShell} from '../platform'
import {pushLocal} from '../push'
import {
  disableWatch,
  enableWatch,
  refreshWatch,
  testNotify,
  watchBusy,
  watchError,
  watchStatus,
  watchSupported as watchSupportedValue
} from '../watch'
import {bjTime} from '../format'
import {askConfirm} from '../confirm'
import {shellInfo, type ShellInfo} from '../native'
import SegTabs from '../comps/SegTabs.vue'
import ExchangeKeys from '../comps/ExchangeKeys.vue'

/*
 * 用户 2026-10-04（本轮）：「个人信息下添加交易所内容（可新增交易所和 key，
 * 支持多个）；其余内容放两个 tab —— 账户信息 / 登录设备」。
 *
 * 所以这页现在顶上一条分段 tab：
 *   · 账户信息：身份卡（右上「编辑」改用户名/密码 · 退出登录的图标按钮）+ 两步验证
 *     + 登录设备 + App 体检单
 *   · 交易所：绑多套交易所 API Key
 *   · 模型配置：多把大模型密钥 + 用量统计
 *
 * 用户 2026-10-06：「模型配置移动到个人信息」——
 * 又从「我的」把「模型配置」（多把大模型密钥 + 用量统计）搬进来当第四段，
 * 不再单独占一格。
 *
 * ★ 2026-10-11（用户两轮：
 *   「账户统计配置去掉，基本信息和修改密码放到顶部账户旁添加按钮弹窗修改，样式和账户统一风格一致」
 *   →「退出字样去掉，退出登录放到用户卡片里面图标按钮显示，登录设备 tab 去掉，内容放到账户信息下面」）：
 *   · **删掉「账户统计配置」那张卡**（2026-10-09 加的重复入口）—— 那份配置跟
 *     「我的 → 账户统计」右上角齿轮里的是同一份（按用户存库），统计页照旧能改；
 *   · 「基本信息」（用户名）与「修改密码」从两张卡片**收进身份卡右边那颗「编辑」的弹层**
 *     （底部弹层 `.sheet`，跟「交易所账户」页的弹层同一套）；
 *   · 「退出」那张卡没了，退出登录变成身份卡里的**图标按钮**（`title`/`aria-label` 是它的
 *     可读文案）；「编辑」也去掉了汉字，两颗都是纯图标；
 *   · 退出**先弹二次确认**（用户：「退出要确认弹窗」）—— 32px 的小图标紧挨着「编辑」，
 *     误触一下就登出太糙了；
 *   · 「登录设备」不再是独立 tab（四格收成三格），那一段并进「账户信息」、排在「两步验证」
 *     后面，列表给了高度上限（`max-height: 46vh`）自己滚；
 *   · 整页挂 `.warm-skin` + 胶囊分段 tab，跟「交易所账户 / 账户统计」统一风格。
 */
type ProfTab = 'account' | 'exchange'

/**
 * 顶上那条分段 tab。
 * ★ 2026-10-11（用户：「登录设备 tab 去掉，内容放到账户信息下面」）——
 *   原来第四格是「登录设备」，现在那一段并进「账户信息」里的最后一张卡，
 *   tab 只剩三格。⚠️ 这一段不在地址栏里（`tab` 就是组件内的 ref），所以没有老链接要兜。
 */
/*
 * ★ 2026-10-12：「模型配置」那一格搬走了 —— 用户「ai 提示词 tab 改为模型配置，
 *   个人信息中的模型配置内容提出到这个页面和 ai 提示词合并改为 3 个子 tab」。
 *   现在它在「我的 → 模型配置」（`ModelPaneView`：密钥配置 / 用量统计 / AI 提示词），
 *   这一页只剩账户信息 / 交易所两格。
 */
const TABS: {value: ProfTab; label: string}[] = [
  {value: 'account', label: '账户信息'},
  {value: 'exchange', label: '交易所'}
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

/* ------------------- 账号设置弹层（2026-10-11） ------------------- */

/*
 * 用户名 + 修改密码收进这颗「编辑」按钮的弹层（用户 2026-10-11：
 * 「基本信息和修改密码放到顶部账户旁添加按钮弹窗修改」）。
 *
 * ⚠️ 每次打开都重新对齐：用户名拉回当前账号（上次可能改了没保存），密码框和提示清空
 *    —— 不然上次输错的红字、或半截密码会留在框里，看着像「已经填好了」。
 * ⚠️ 原来这页还有一张「账户统计配置」卡（2026-10-09 加的入口），**2026-10-11 删了**
 *    （用户：「账户统计配置去掉」）—— 那份配置没丢：它跟「我的 → 账户统计」右上角齿轮里
 *    的是**同一份**（`/api/stats-settings`，按用户存库），统计页那边照旧能改。
 */
const editOpen = ref(false)
watch(editOpen, on => {
  if (!on) return
  name.value = user.value?.username ?? ''
  oldPw.value = ''
  newPw.value = ''
  nameMsg.value = ''
  nameErr.value = ''
  pwMsg.value = ''
  pwErr.value = ''
})

/**
 * 退出登录：**先二次确认**（用户 2026-10-11：「退出要确认弹窗」）。
 *
 * 它现在是一颗 32px 的小图标，紧挨着「编辑」那颗 —— 误触一下就登出太糙了。
 * 走全站那个确认框（`askConfirm` → `ConfirmDialog`，暖色皮肤下它也是暖的）。
 */
async function logoutAsk(): Promise<void> {
  const ok = await askConfirm({
    title: '退出登录？',
    body: '这台设备要重新登录才能进来。',
    okText: '退出'
  })
  if (ok) await logout()
}

onMounted(() => {
  name.value = user.value?.username ?? ''
  void loadSessions()
  void loadTotp()
  void loadShell()
  void loadPush()
  void refreshWatch()
  /* 不在原生壳里那几行不显示；是壳里就顺手让它把本机状态刷一遍 */
  if (isNativeShell()) void import('../push').then(m => m.registerPush())
})

/* ------------------------- 推送（FCM，2026-10-15） ------------------------- */

/**
 * 「结论转可做」会给手机推一条。这张卡是**排查用的**：
 *   · 服务端配没配（凭据在 `.env` 里，线上配好了才发得出去）；
 *   · 这台账号报了哪些设备（没上报过 / 被标死 / 上次错在什么）；
 *   · 「发一条测试」—— 不然要等"转可做"才知道通不通，而模型大多数时候给的是不可做/观望。
 */
/**
 * 「App 后台提醒」那一段（2026-10-16 用户选的方案）——**不依赖谷歌服务的推送**。
 * 详见 `frontend/src/watch.ts` 与原生 `AlertWatchService.java`。
 */
const watchInfo = watchStatus
const watchOn = computed(() => !!watchInfo.value?.enabled)
const watchOk = watchSupportedValue
const watchErr = watchError
const watchIsBusy = watchBusy

async function toggleWatch(): Promise<void> {
  if (!watchOk.value) return
  if (watchOn.value) await disableWatch()
  else await enableWatch()
}

const pushInfo = ref<PushStatus | null>(null)
const pushBusy = ref(false)
const pushMsg = ref('')

async function loadPush(): Promise<void> {
  try {
    pushInfo.value = await fetchPushStatus()
  } catch {
    /* 拿不到不报错给用户看（这一块只是排查用） */
  }
}

async function sendTestPush(): Promise<void> {
  pushBusy.value = true
  pushMsg.value = ''
  try {
    const r = await testPush()
    if (r.error) pushMsg.value = r.error
    else pushMsg.value = `发出 ${r.sent}/${r.devices} 台 —— 手机上应该马上就弹了`
    await loadPush()
  } catch (e) {
    pushMsg.value = (e as Error).message
  } finally {
    pushBusy.value = false
  }
}

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
  <div class="profile warm-skin">
    <SegTabs class="prof-tabs" v-model="tab" :options="TABS" />

    <section v-if="tab === 'account'" class="panel who">
      <span class="avatar">{{ (user?.username ?? '?').slice(0, 1) }}</span>
      <div class="who-text">
        <b>{{ user?.username }}</b>
        <small>
          {{ user?.isAdmin ? '管理员' : '普通账号' }}
        </small>
      </div>
      <!--
        ★ 2026-10-11（用户：「基本信息和修改密码放到顶部账户旁添加按钮弹窗修改」+
        「退出字样去掉，退出登录放到用户卡片里面图标按钮显示」→「退出要确认弹窗，编辑不要汉字」）——
        用户名 / 改密码收进「编辑」的弹层，退出登录收成图标按钮。
        两颗**都是纯图标**（用户要求「编辑不要汉字」）：图形 + `title`/`aria-label` 说明，
        不写文字 —— 这一行省下来的宽度留给用户名。
      -->
      <div class="who-act">
        <button
          class="who-edit"
          type="button"
          title="改用户名 / 改密码"
          aria-label="改用户名 / 改密码"
          @click="editOpen = true"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 20h4.2L19 9.2a2.1 2.1 0 0 0 0-3L17.8 5a2.1 2.1 0 0 0-3 0L4 15.8V20Z" />
            <path d="M13.6 5.4 18.6 10.4" />
          </svg>
        </button>
        <button
          class="who-out"
          type="button"
          title="退出登录"
          aria-label="退出登录"
          @click="logoutAsk"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 4h3.2A1.8 1.8 0 0 1 20 5.8v12.4A1.8 1.8 0 0 1 18.2 20H15" />
            <path d="M10.5 8.5 7 12l3.5 3.5" />
            <path d="M7 12h8.5" />
          </svg>
        </button>
      </div>
    </section>

    <!-- 交易所：绑多套 Key（用户 2026-10-04 新增，独立成一个 tab） -->
    <ExchangeKeys v-if="tab === 'exchange'" />


    <!-- 登录设备：★ 2026-10-11 整段挪到「账户信息」那格的末尾（原来是独立的第四个 tab） -->

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

    <!-- 修改密码：★ 2026-10-11 从这一页的卡片挪进「编辑」弹层（见文件末尾那个弹层） -->

    <!--
      登录设备：★ 2026-10-11 从原来那个独立 tab 挪进来（用户：「登录设备 tab 去掉，
      内容放到账户信息下面」）—— 放在「两步验证」后面（同属账号安全这一类），
      列表给个高度上限、自己滚：这一页跟「账户页」一个口径，不让长列表把整页拖长。
    -->
    <section v-if="tab === 'account'" class="panel">
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
      <h2>推送</h2>
      <p class="note">
        「持久化分析」的结论**转成可做**时，会给装了 App 的手机推一条（App 关着也能收到）。
        <br />
        <b>服务端</b>：{{ pushInfo ? (pushInfo.configured ? '已配置 ✓' : `没配 —— ${pushInfo.detail}`) : '读取中…' }}
        <br />
        设备是**新包装上、打开过一次**才会上报；旧包（没有推送功能）永远收不到。
      </p>
      <ul v-if="pushInfo?.devices.length" class="kvs">
        <li v-for="(d, i) in pushInfo.devices" :key="i">
          <span>{{ d.device }}<template v-if="d.disabled"> · 已失效</template></span>
          <b>{{
            d.disabled ? '需要重新打开 App 上报' : d.lastError ? `上次失败：${d.lastError}` : '正常'
          }}</b>
        </li>
      </ul>
      <p v-else-if="pushInfo" class="note">
        这个账号还没有设备上报过 —— 要在**新包**（0.2.13+）里**打开一次 App** 才会注册。
      </p>

      <!--
        **本机（这台手机）的状态** —— 2026-10-16 加的，起因是用户在华为手机上问「收不到」：
        服务端只能说"有没有设备上报过"，手机上真正发生的事（插件、权限、注册报错）
        得在手机自己的界面上看得见，否则永远只能猜。
      -->
      <!--
        ★ 「App 后台提醒」= **不依赖谷歌服务**的那条路（2026-10-16 用户选的）。
        华为这类没有 GMS 的机器 FCM 用不了，只能让 App 自己跑个前台服务轮询 + 发本地通知。
        这一段在原生的 `AlertWatchService.java` / `frontend/src/watch.ts`。
      -->
      <div v-if="watchOk" class="watch-box">
        <div class="row">
          <button
            class="btn"
            type="button"
            :disabled="watchIsBusy"
            @click="toggleWatch"
          >
            {{ watchIsBusy ? '…' : watchOn ? '关掉后台提醒' : '打开后台提醒（推荐）' }}
          </button>
          <button class="btn" type="button" :disabled="watchIsBusy" @click="refreshWatch">
            刷新
          </button>
        </div>
        <ul class="kvs">
          <li>
            <span>后台提醒</span>
            <b>{{ watchOn ? '已打开' : '没打开' }}</b>
          </li>
          <li>
            <span>登录凭据已交给后台</span>
            <b>{{ watchInfo?.hasToken ? '是' : '否（打开 App 会自己补上）' }}</b>
          </li>
          <li>
            <span>通知权限</span>
            <b>{{ watchInfo?.notificationsGranted ? '已允许' : '没允许（通知会被系统丢掉）' }}</b>
          </li>
        </ul>
        <p class="note">
          打开后：通知栏会挂一条**不显眼**的「Ait 正在盯着」（前台服务必须有它），
          App 关掉也照跑；结论转「可做」时弹一条通知，点它进 App。
          <br />
          ⚠️ **华为/小米这类要手动放行**：设置 → 应用启动管理 → 允许「Ait」**自启动 + 后台运行**，
          并把「电池优化」设为**不允许优化** —— 不然系统会在几十分钟后把它清掉。
        </p>
        <div class="row">
          <button class="btn" type="button" :disabled="watchIsBusy" @click="testNotify">
            发一条测试提醒
          </button>
        </div>
        <p v-if="watchErr" class="err">{{ watchErr }}</p>
      </div>

      <ul v-if="pushLocal.native" class="kvs">
        <li>
          <span>本机推送插件</span>
          <b>{{ pushLocal.hasPlugin ? '有' : '没有（旧包，换 0.2.13+）' }}</b>
        </li>
        <li>
          <span>本机通知权限</span>
          <b>{{
            pushLocal.permission === 'granted'
              ? '已允许'
              : pushLocal.permission === 'denied'
                ? '被拒绝'
                : pushLocal.permission
          }}</b>
        </li>
        <li>
          <span>本机 FCM token</span>
          <b>{{ pushLocal.token ? pushLocal.token.slice(0, 12) + '…' : '还没拿到' }}</b>
        </li>
        <li>
          <span>已上报服务器</span><b>{{ pushLocal.reported ? '是' : '否' }}</b>
        </li>
      </ul>
      <p v-if="pushLocal.error" class="err">{{ pushLocal.error }}</p>
      <p v-if="pushMsg" class="ok">{{ pushMsg }}</p>
      <div class="row">
        <button class="btn" type="button" :disabled="pushBusy" @click="sendTestPush">
          {{ pushBusy ? '发送中…' : '发一条测试推送' }}
        </button>
        <button class="btn" type="button" :disabled="pushBusy" @click="loadPush">刷新</button>
      </div>
    </section>

    <!-- 退出：★ 2026-10-11 卡片删了（「退出字样去掉」），退出登录收成身份卡里那颗图标按钮 -->

    <!--
      ★ 2026-10-11「账号设置」弹层（用户：「基本信息和修改密码放到顶部账户旁添加按钮弹窗修改」）。

      两个决定：
        · **做成底部弹层**，不是居中小框 —— 这一页的表单弹层跟「交易所账户」那一页
          （划转 / 平仓 / 配置）是同一套 `.sheet`，而「和账户统一风格一致」就是要同一套；
          底部弹层在手机上也更好按（拇指够得到），居中框更适合「确认一件事」。
        · **挂 `warm-skin`**：`Teleport` 到 body 之后继承不到页面那棵树的变量
          （`.profile` 上那份），所以每个弹层都得自己挂一次 —— 见 `style.css` 那一节。
    -->
    <Teleport to="body">
      <div v-if="editOpen" class="sheet-mask" @click="editOpen = false" />
      <section
        v-if="editOpen"
        class="sheet warm-skin edit-sheet"
        role="dialog"
        aria-label="账号设置"
      >
        <header class="sheet-head">
          <b>账号设置</b>
          <button
            type="button"
            class="sheet-x"
            title="关闭"
            @click="editOpen = false"
          >
            ✕
          </button>
        </header>

        <!-- 用户名：一行「标签 —— 输入框 —— 保存」，跟配置弹层一个排版 -->
        <div class="sheet-row">
          <span class="rk">用户名</span>
          <input
            v-model="name"
            type="text"
            maxlength="20"
            placeholder="2~20 位，中英文 / 数字 / _ -"
            @keyup.enter="saveName"
          />
          <button
            class="btn primary"
            type="button"
            :disabled="nameBusy"
            @click="saveName"
          >
            {{ nameBusy ? '保存中…' : '保存' }}
          </button>
        </div>
        <p v-if="nameErr" class="err">{{ nameErr }}</p>
        <p v-if="nameMsg" class="ok">{{ nameMsg }}</p>

        <!-- 修改密码：两行输入 + 一颗按钮（改完所有会话都会被踢，见 `changePw`） -->
        <div class="sheet-row col">
          <span class="rk">修改密码</span>
          <input
            v-model="oldPw"
            type="password"
            autocomplete="current-password"
            placeholder="原密码"
          />
          <input
            v-model="newPw"
            type="password"
            autocomplete="new-password"
            placeholder="新密码（至少 6 位）"
          />
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
        </div>
      </section>
    </Teleport>
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
 * （2026-10-12 起「模型配置」不在这一页了 —— 它自带宽表格、要占满整行，
 *  所以这条「限宽」以前才要给它让路；现在这一页两格都是表单，一律限宽。）
 */
.profile > section.panel {
  max-width: 560px;
}
.who {
  display: flex;
  align-items: center;
  gap: 12px;
}.avatar {
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
/*
 * 身份卡右侧那一组按钮：「编辑」（改用户名 / 改密码）+ 退出登录。
 * ★ 2026-10-11 用户：「编辑不要汉字」⇒ 两颗**都是纯图标的正方形**（32×32）。
 * 主次靠底色分：「编辑」是暖色胶囊（主操作），退出是中性底 + muted（次要）。
 */
.who-act {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  margin-left: auto;
}
.who-edit {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid rgba(255, 193, 107, 0.22);
  border-radius: 999px;
  background: rgba(255, 193, 107, 0.07);
  color: #ffd291;
  cursor: pointer;
}
/*
 * 退出登录：**只有图标**（用户 2026-10-11：「退出字样去掉，退出登录放到用户卡片里面
 * 图标按钮显示」）。中性底 + muted —— 它旁边那颗「编辑」是主操作，别抢一样的权重。
 */
.who-out {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--muted);
  cursor: pointer;
}
.who-edit svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.who-out svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
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
.watch-box {
  margin: 4px 0 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.watch-box .note {
  margin: 8px 0;
}

.watch-box .row {
  gap: 8px;
  flex-wrap: wrap;
}

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
  /*
   * ★ 2026-10-11：这段从独立 tab 挪进「账户信息」之后跟别的内容挤在一页里了
   * （实测 admin 账号 21 台设备），给个高度上限让它自己滚 —— 口径跟账户页一致：
   * 长列表内滚，不让整页无限长。滚条不画（跟这一页其它滚动容器一个规矩）。
   */
  max-height: 46vh;
  overflow-y: auto;
  scrollbar-width: none;
}
.devices::-webkit-scrollbar {
  display: none;
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

/* ==================== ★ 2026-10-11：跟「交易所账户」统一风格 ==================== */
/*
 * 用户：「样式和账户统一风格一致」。
 * 底色/描边/主色那套变量挂在模板根节点的 `warm-skin` 上（定义见 `style.css` 那一节，
 * 跟「账户统计 / 交易所账户 / 合约」是同一份），这里只补两处**形状**：
 * 分段 tab 换成胶囊、段标题对齐到 13px，以及新弹层里的排版。
 */

/*
 * 分段 tab（账户信息 / 交易所 / 模型配置 / 登录设备）—— 换成账户页那套**胶囊分段器**
 * （全局 `.seg` 是「矩形 + 按钮之间画分隔线」的老样子，账户页也是在那页里换掉的）。
 */
.prof-tabs {
  align-self: flex-start;
  max-width: 100%;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: linear-gradient(120deg, rgb(19, 19, 21), rgb(18, 15, 13));
  overflow-x: auto;
  scrollbar-width: none;
}
.prof-tabs::-webkit-scrollbar {
  display: none;
}
/* ⚠️ 按钮在子组件（`SegTabs.vue`）里 ⇒ 必须 `:deep()` 才够得着 */
.prof-tabs :deep(button) {
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
.prof-tabs :deep(button.active) {
  background: linear-gradient(
    112deg,
    rgba(255, 217, 158, 0.25) 0%,
    rgba(255, 193, 107, 0.15) 52%,
    rgba(243, 154, 63, 0.09) 100%
  );
  color: #ffd291;
  box-shadow: inset 0 0 0 1px rgba(255, 193, 107, 0.12);
}

/* 段标题：跟账户页的段标题同一档（那边 `.pn-h h2` 也是 13px / 600） */
h2 {
  font-size: 13px;
}

/*
 * 「账号设置」弹层的内容排版 —— 跟「配置」那个弹层同一套写法（标签在左、控件贴右，
 * 一条一行；`.col` 那种是上下堆）。
 * ⚠️ `Teleport` 之后 scoped 样式仍然生效（`data-v` 写在元素上），但**变量**吃不到页面
 *    那棵树 —— 所以弹层自己挂了 `warm-skin`（见模板那段说明）。
 */
.edit-sheet .sheet-row {
  padding: 10px 0;
}
.edit-sheet .sheet-row.col {
  gap: 10px;
}
.edit-sheet .rk {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
}
/* 一行那种：输入框吃掉中间，两边是标签和按钮 */
.edit-sheet .sheet-row:not(.col) input {
  flex: 1 1 auto;
  /* ⚠️ 必须显式 `width: auto`：本页顶上那条 `input { width: 100% }` 是给竖排表单写的，
     它会让输入框一个人占满整行，把「保存」挤成两行（实测 393px 下按钮只有 ~34px 宽）。 */
  width: auto;
  min-width: 0;
}
/* 按钮永远整颗、不折行（同「换行会被挤扁」那个道理） */
.edit-sheet .sheet-row .btn {
  flex: 0 0 auto;
  white-space: nowrap;
}
.edit-sheet input {
  padding: 8px 10px;
  font-size: 13px;
}
.edit-sheet .row {
  margin-top: 0;
}
.edit-sheet .err,
.edit-sheet .ok {
  margin: 0;
}
</style>
