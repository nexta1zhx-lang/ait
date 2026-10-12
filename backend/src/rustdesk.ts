/**
 * 远程桌面（RustDesk）—— 「管理 → 远程桌面」那一页（2026-10-12）。
 *
 * 和隔壁「代理订阅」不一样：**这一页只读，一个字节都不写宿主机**。
 *
 *   ① 设备清单和连接记录都在**宿主机**：设备 id / 首次注册 / 客户端上报的 ip 躺在
 *      hbbs 的 `db_v2.sqlite3` 里（hbbs 以 WAL 独占它，只能只读打开），上下线和
 *      中继会话则只在 hbbs/hbbr 的容器日志里 —— 两样应用容器都碰不到。
 *      所以统一由宿主机上的 `rustdeskd`（172.17.0.1:2098）读出来，见 /opt/rustdeskd.py。
 *
 *   ② 本文件自己的表只有一张 `rustdesk_devices`：**我们自己给它起的别名**。
 *      权威副本在宿主机，这张表不是副本、只是备注 —— 设备在服务端被删了我们也
 *      不删行，免得人家换台机器回来时标签没了。
 *
 * WHY 不做「封禁 / 踢掉某台设备」：rustdesk-server 的 **OSS 版根本没有这个能力**
 * （官方 Pro 才有），界面上不许放一个按下去没效果的按钮。同理也没有
 * 「服务端地址簿」—— 那是 Pro 的功能，OSS 客户端只把设备存在本地。
 *
 * ⚠️ **「在线 / 离线」判断不了**：hbbs 的心跳状态只在内存里，日志里也没有下线事件。
 *    所以界面只显示「最后活动时间」，不许写成在线状态。
 */
import {query} from './db/client'
import {hostAgent} from './host-agent'

/**
 * ⚠️ ID 服务器域名（`rustdesk.bitcoooin.cn`）**不在这里写死** —— 它是宿主机
 *    agent 那边的一个参数（`/opt/rustdeskd.py` 的 `RUSTDESKD_ID_SERVER`，
 *    要和 Caddyfile 里的站点名一致），由 `/server` 接口带回来。
 *    这样「页面上显示的接入地址」和「实际能连的地址」只有一个源头。
 */
const AGENT_ENDPOINT = process.env.RUSTDESKD_ENDPOINT || 'http://172.17.0.1:2098'
const AGENT_TOKEN = process.env.RUSTDESKD_TOKEN || ''

const agent = hostAgent({
  endpoint: AGENT_ENDPOINT,
  token: AGENT_TOKEN,
  name: 'rustdeskd',
  tokenHint:
    '没配 RUSTDESKD_TOKEN —— 服务器上 /opt/crypto-advisor/.env 里加一行即可（见 docs/DEPLOY.md「远程桌面」）',
  downHint: '服务器上 systemctl status rustdeskd 看看',
  timeoutMs: 15_000
})

/* ------------------------------------------------------------------ 类型 */

export interface RustDeskDevice {
  id: string
  /** 我们自己起的别名（存在应用库里） */
  note: string
  createdAt: string | null
  ip: string | null
  lastSeenAt: string | null
  /** 最近 24 小时上线过几次 —— 比单纯的「在线/离线」诚实 */
  events24h: number
}

interface Endpoint {
  ip: string
  port: number
}

export type RustDeskActivity =
  | {kind: 'online'; at: string; deviceId: string; ip: string | null}
  | {
      kind: 'relay'
      at: string
      id: string
      from: Endpoint | null
      to: Endpoint | null
      closedAt: string | null
      /** 没结束（日志里还没出现 close）时是 null */
      seconds: number | null
    }

export interface RustDeskPort {
  port: number
  proto: string
  what: string
}

export interface RustDeskServerInfo {
  idServer: string
  /** 客户端要填的那个 key（实时读 /opt/rustdesk/id_ed25519.pub） */
  key: string | null
  webClient: string
  diagUrl: string
  ports: RustDeskPort[]
  dbPath: string
  /** 日志回看窗口，例如 `72h` —— 「最后活动时间」最早只能追到这里 */
  logSince: string
}

export interface RustDeskHealth {
  ok: boolean
  error?: string
  hbbs?: boolean
  hbbr?: boolean
  peers?: number
  sessions?: number
}

export interface RustDeskSnapshot {
  /** 给新设备用的一堆参数（agent 连不上时为 null） */
  server: RustDeskServerInfo | null
  devices: RustDeskDevice[]
  activity: RustDeskActivity[]
  health: RustDeskHealth
}

/* ------------------------------------------------------------------ 别名 */

/**
 * 备注存应用库 —— 它和下发给宿主机的整体覆盖无关，改备注**不碰宿主机**。
 */
export async function setRustDeskNote(deviceId: string, note: string): Promise<void> {
  const id = deviceId.trim()
  if (!/^\d{1,20}$/.test(id)) throw new Error('设备 ID 不对')
  await query(
    `INSERT INTO rustdesk_devices (device_id, note, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (device_id) DO UPDATE SET note = EXCLUDED.note, updated_at = now()`,
    [id, note.trim().slice(0, 100)]
  )
}

async function notes(): Promise<Map<string, string>> {
  const rows = await query<{device_id: string; note: string}>(
    `SELECT device_id, note FROM rustdesk_devices`
  )
  return new Map(rows.map(r => [r.device_id, r.note]))
}

/* ------------------------------------------------------------------ 取数 */

interface AgentDevice {
  id: string
  createdAt: string | null
  ip: string | null
  lastSeenAt: string | null
  events24h: number
}

/**
 * 一页需要的全部数据。agent 连不上**不抛错**：返回 `health.ok=false` + 空列表，
 * 页面据此显示那行红字（跟「代理订阅」同一套处理）。
 */
export async function rustDeskSnapshot(): Promise<RustDeskSnapshot> {
  const mine = await notes()
  try {
    const [health, server, devices, activity] = await Promise.all([
      agent.get<Omit<RustDeskHealth, 'ok'>>('/health'),
      agent.get<RustDeskServerInfo>('/server'),
      agent.get<{count: number; devices: AgentDevice[]}>('/devices'),
      agent.get<{items: RustDeskActivity[]}>('/activity?limit=40')
    ])
    return {
      server,
      devices: devices.devices.map(d => ({...d, note: mine.get(d.id) ?? ''})),
      activity: activity.items,
      health: {ok: true, ...health}
    }
  } catch (e) {
    return {
      server: null,
      devices: [],
      activity: [],
      health: {ok: false, error: (e as Error).message}
    }
  }
}
