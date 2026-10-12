<script setup lang="ts">
/**
 * 「管理 → 远程桌面」—— RustDesk 的**只读**总览（2026-10-12）。
 *
 * 这一页要解决的实际问题：以前想知道「谁在用、什么时候上线过、现在给新设备
 * 要填什么」，只能在服务器上翻 hbbs 的 sqlite 和容器日志 —— 手机上看不了。
 *
 * 数据全部来自宿主机那个只读 agent（`/opt/rustdeskd.py` → 172.17.0.1:2098），
 * 应用侧**只能改一样东西：设备的别名**（写自己的 Postgres）。
 *
 * ⚠️ 有三件事这一页故意**不做**，别以为是漏了：
 *   · 不显示「在线 / 离线」—— hbbs 的心跳只在内存里，日志里也没有下线事件，
 *     判断不了。只有「最后活动时间」是真的。
 *   · 没有「封禁 / 踢掉设备」—— rustdesk-server 的 OSS 版没这个能力（Pro 才有）。
 *   · 没有「服务端地址簿」—— 同样是 Pro 的功能；OSS 客户端只把设备存在本机。
 *
 * ⚠️ 样式照 `ProxyUsersPanel.vue` / `AdminView.vue` 那套抄（`.panel` / `.btn` /
 *    行卡片都是**各组件自己 scoped 定义**的，不是全局的）——少抄一条就「一加就变形」。
 */
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {bjTime, bjTimeSec} from '../format'
import {showToast} from '../toast'
import {
  fetchRustDesk,
  setRustDeskNote,
  type RustDeskActivity,
  type RustDeskDevice,
  type RustDeskHealth,
  type RustDeskServerInfo
} from '../api'

/**
 * 自动刷新的间隔。
 *
 * 比「服务器监测」那页的 5 秒慢得多 —— 那边是曲线，这边是清单：
 * 设备的上下线本来就不是秒级的事，60 秒足够，也省得 agent 一直去翻日志。
 */
const POLL_MS = 60_000

const devices = ref<RustDeskDevice[]>([])
const activity = ref<RustDeskActivity[]>([])
const server = ref<RustDeskServerInfo | null>(null)
const health = ref<RustDeskHealth>({ok: false})
const loading = ref(true)
const error = ref('')
const saving = ref('')
const savedAt = ref(0)

/** 正在编辑（还没保存）的那几行 —— 轮询回来时别把它冲掉 */
const edited = ref<Record<string, boolean>>({})

/** 相对时间的基准；每次拉数据时对齐一次 */
const now = ref(Date.now())
let timer: number | null = null

/**
 * 后端版本太旧时（没有 `/api/admin/rustdesk` 这个路由）拿到的是 404 "Not Found"，
 * 那会儿说「宿主机连不上」是误导 ——「代理订阅」那页实测踩过一次，这里同样分流。
 */
const staleBackend = computed(() => /not\s*found|404/i.test(error.value))

/** 最近 24 小时出现过（上过线）的台数 */
const activeCount = computed(() => devices.value.filter(d => d.events24h > 0).length)

const lastActivity = computed(() => activity.value[0]?.at ?? null)

function relTime(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((now.value - t) / 1000))
  if (s < 90) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`
  // 「天」用四舍五入：1.98 天说成「1 天前」太别扭（精确时间就在旁边）
  return `${Math.round(s / 86_400)} 天前`
}

/** 中继会话持续多久（`seconds` 为 null = 日志里还没看到关闭） */
function dur(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '未结束'
  if (seconds < 60) return `${seconds} 秒`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m} 分 ${seconds % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/** 一台设备显示用的名字：别名优先，没有就显示成「未命名」 */
const nameOf = (d: RustDeskDevice): string => d.note.trim() || '未命名设备'

/**
 * 头像里的那个字。
 *
 * 没起别名时**不能**取「未命名设备」的首字（一个个圆圈里全是「未」，像坏了），
 * 退回设备 ID 的第一位数字 —— 和旁边那枚 ID 徽章对得上。
 */
const avatarOf = (d: RustDeskDevice): string =>
  d.note.trim() ? d.note.trim().slice(0, 1).toUpperCase() : d.id.slice(0, 1)

async function copy(text: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      // WebView / 非安全上下文里没有 clipboard API，退回到老办法
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    showToast(`${label}已复制`)
  } catch {
    showToast('复制失败，长按手动选中吧', 'bad')
  }
}

async function load(): Promise<void> {
  try {
    const r = await fetchRustDesk()
    server.value = r.server
    health.value = r.health
    activity.value = r.activity
    // 正在编辑的行保留本地那份，免得打字打到一半被刷掉
    const local = new Map(
      devices.value.filter(d => edited.value[d.id]).map(d => [d.id, d.note])
    )
    devices.value = r.devices.map(d =>
      local.has(d.id) ? {...d, note: local.get(d.id) ?? ''} : d
    )
    error.value = ''
    savedAt.value = Date.now()
    now.value = Date.now()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/** 存别名（输入框失焦 / 回车时触发） */
async function saveNote(d: RustDeskDevice): Promise<void> {
  const note = d.note.trim()
  if (note === (d.note ?? '').trim() && !edited.value[d.id]) return
  saving.value = d.id
  try {
    await setRustDeskNote(d.id, note)
    d.note = note
    delete edited.value[d.id]
    showToast('别名已保存')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = ''
  }
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
  <div class="rd">
    <!-- ==================== 设备清单 ==================== -->
    <section class="panel">
      <h2>
        远程桌面
        <small v-if="devices.length">
          共 {{ devices.length }} 台 · 24 小时内有活动 {{ activeCount }} 台
        </small>
        <span class="spacer" />
        <span v-if="health.ok" class="dot" :class="health.hbbs && health.hbbr ? 'ok' : 'bad'" />
        <b v-if="health.ok" class="svc" :class="health.hbbs && health.hbbr ? 'ok' : 'bad'">
          {{ health.hbbs && health.hbbr ? '服务正常' : '服务异常' }}
        </b>
        <button class="mini" type="button" @click="load()">刷新</button>
      </h2>

      <!-- 先分清「后端太旧」和「真的连不上宿主机」—— 两种都表现为画面一片空 -->
      <p v-if="staleBackend" class="err">
        后端还是旧版本（没有 /api/admin/rustdesk 这个接口）：先把新版本发布上去
        （<code>bash scripts/release.sh</code>）；本地开发的话重启一下 dev server。
      </p>
      <p v-else-if="!health.ok && !loading" class="err">
        宿主机上的 rustdeskd 连不上：{{ health.error }}
        <button class="mini" type="button" @click="load()">重试</button>
      </p>
      <p v-if="error && !staleBackend" class="err">{{ error }}</p>

      <p v-if="loading" class="dim">载入中…</p>
      <p v-else-if="health.ok && !devices.length" class="dim">
        还没有任何设备连过这台服务器 —— 在客户端的「网络设置」里填上下面的 ID 服务器和 Key，
        它就会出现在这里。
      </p>

      <div v-for="d in devices" :key="d.id" class="prow">
        <div class="phead">
          <span class="pavatar">{{ avatarOf(d) }}</span>
          <div class="pid">
            <div class="pline">
              <b>{{ nameOf(d) }}</b>
              <span class="badge">{{ d.id }}</span>
              <span v-if="d.events24h" class="badge light">{{ d.events24h }} 次上线 / 24h</span>
              <span v-else class="badge light">24h 内没上过线</span>
            </div>
            <div class="pmeta">
              <span>最后活动 {{ relTime(d.lastSeenAt) }}</span>
              <span v-if="d.lastSeenAt">{{ bjTime(d.lastSeenAt) }}</span>
              <span>首次注册 {{ bjTime(d.createdAt) }}</span>
              <span class="mono">{{ d.ip || '未上报 IP' }}</span>
            </div>
          </div>
        </div>

        <div class="pacts">
          <input
            v-model="d.note"
            class="pnote"
            type="text"
            maxlength="100"
            placeholder="别名（给谁用的，例如「我的 MacBook」）"
            @input="edited[d.id] = true"
            @change="saveNote(d)"
            @keyup.enter="saveNote(d)"
          />
          <p v-if="saving === d.id" class="dim small">保存中…</p>
        </div>
      </div>

      <p class="foot dim small">
        RustDesk 服务端只知道「这台设备什么时候上报过」，判断不了在线 / 离线 ——
        所以这里只显示最后活动时间。清单里的「最后活动」最早只能追到
        {{ server?.logSince || '72h' }} 以内（再往前，容器日志里就没了）。
      </p>
    </section>

    <!-- ==================== 接入信息（给新设备用） ==================== -->
    <section class="panel">
      <h2>接入信息 <small>给新设备填这个</small></h2>

      <p v-if="!server" class="dim small">连不上宿主机，拿不到接入信息。</p>
      <template v-else>
        <div class="kv">
          <span class="rk">ID 服务器</span>
          <code>{{ server.idServer }}</code>
          <button class="mini" type="button" @click="copy(server.idServer, 'ID 服务器')">
            复制
          </button>
        </div>
        <div class="kv">
          <span class="rk">Key</span>
          <code class="mono">{{ server.key || '（读不到 id_ed25519.pub）' }}</code>
          <button class="mini" type="button" :disabled="!server.key" @click="copy(server.key!, 'Key')">
            复制
          </button>
        </div>
        <div class="kv">
          <span class="rk">网页客户端</span>
          <code>{{ server.webClient }}</code>
          <button class="mini" type="button" @click="copy(server.webClient, '网页客户端地址')">
            复制
          </button>
        </div>
        <div class="kv">
          <span class="rk">连通性诊断</span>
          <code>{{ server.diagUrl }}</code>
          <button class="mini" type="button" @click="copy(server.diagUrl, '诊断页地址')">
            复制
          </button>
        </div>

        <p class="dim small tip">
          对方客户端 → 设置 → 网络 → 「ID 服务器」填上面第一行、「Key」填第二行，然后重启客户端。
          手机连不上时先让对方开 {{ server.diagUrl }} 看一眼是哪一段不通。
        </p>

        <details class="ports">
          <summary class="dim small">服务端端口（{{ server.ports.length }} 个）</summary>
          <div v-for="p in server.ports" :key="p.port" class="kv">
            <span class="rk">{{ p.port }}/{{ p.proto }}</span>
            <span class="dim small">{{ p.what }}</span>
          </div>
        </details>
      </template>
    </section>

    <!-- ==================== 最近活动 ==================== -->
    <section class="panel">
      <h2>
        最近活动
        <small v-if="lastActivity">最后一次 {{ relTime(lastActivity) }}</small>
      </h2>

      <p v-if="!activity.length" class="dim small">最近没有记录。</p>
      <div v-for="(it, i) in activity" :key="i" class="aline">
        <span class="atime">{{ bjTimeSec(it.at) }}</span>
        <span class="akind" :class="it.kind">
          {{ it.kind === 'online' ? '设备上线' : '中继会话' }}
        </span>
        <span class="atext">
          <template v-if="it.kind === 'online'">
            设备 <code>{{ it.deviceId }}</code> · 来自 {{ it.ip || '未知 IP' }}
          </template>
          <template v-else>
            {{ it.from?.ip || '?' }} → {{ it.to?.ip || '未配对' }} · {{ dur(it.seconds) }}
          </template>
        </span>
      </div>

      <p class="foot dim small">
        只有走中继的会话才会在这里留下记录（双方 NAT 打不通时才走中继）；
        打通的直连不经服务端，日志里查不到。这段时间一共
        {{ health.sessions ?? 0 }} 条中继会话。
      </p>
    </section>
  </div>
</template>

<style scoped>
/* ==================== 卡 / 标题：与 AdminView 那半张卡一致 ==================== */
.rd {
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

/* ==================== 按钮（跟 AdminView / ProxyUsersPanel 同一套值） ==================== */
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

/* ==================== 一台设备一行（跟「用户管理」那张卡同一套写法） ==================== */
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
  font-family: var(--mono, ui-monospace);
}
.badge.light {
  background: var(--panel-2);
  color: var(--muted);
  font-family: inherit;
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
.pmeta .mono {
  font-family: var(--mono, ui-monospace);
  opacity: 0.8;
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
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 10px);
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}

/* ==================== 接入信息那几行「标签 + 值 + 复制」 ==================== */
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
  margin: 10px 0 0;
  line-height: 1.6;
}
.ports {
  margin-top: 10px;
}
.ports summary {
  cursor: pointer;
}

/* ==================== 最近活动 ==================== */
.aline {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 0;
  border-bottom: 1px solid var(--line, var(--border));
  font-size: 12px;
}
.aline:last-of-type {
  border-bottom: none;
}
.atime {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11.5px;
  font-family: var(--mono, ui-monospace);
}
.akind {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--blue-soft);
  color: var(--blue);
}
.akind.relay {
  background: var(--panel-2);
  color: var(--muted);
}
.atext {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.atext code {
  font-family: var(--mono, ui-monospace);
  font-size: 11.5px;
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
.foot {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  line-height: 1.6;
}
.dim {
  color: var(--muted);
}
.small {
  font-size: 11.5px;
}
</style>
