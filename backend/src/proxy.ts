/**
 * 代理订阅（梯子）用户管理 —— 「管理 → 代理订阅」那一页。
 *
 * 三层，各管一段：
 *
 *   ① 本文件的 `proxy_users` 表：**权威副本**。存名字 / uuid / 订阅密码 / 是否启用。
 *      密码明文存 —— 和 `user_llm_keys` / `user_exchange_keys` 同一个口径（只有
 *      管理员看得到，见 server.ts 的 `/api/admin/*` 鉴权）。之所以不存哈希：
 *      订阅地址要能**反复复制**给朋友，只存哈希就再也显示不出来了。
 *
 *   ② 宿主机的 `xrayd` 服务（默认 `http://172.17.0.1:2097`，令牌鉴权）：唯一动
 *      xray 配置的地方（xray 跑在宿主机 systemd 里，容器没权限改它）。我们只做
 *      一件事 —— 把「想要的用户列表」整体 PUT 过去，它负责写 `users.json`、
 *      重建 xray 的 clients、必要时重启 xray。**整体覆盖天然不会漂移**：
 *      重复下发同一个状态没有副作用（实测不重启、uuid 不变）。
 *
 *   ③ 订阅分发：`https://<domain>/sub/clash`，BasicAuth。凭据就是 ① 里的
 *      name / password；`/opt/sub_server.py` 读同一份 users.json 校验。
 *
 * WHY 不用 xray 的 gRPC API 热增删：那要开 `api` inbound + 引 gRPC 依赖，
 * 为了省 1 秒重启不值当。改用户本来就不频繁。
 */
import crypto from 'node:crypto'
import QRCode from 'qrcode'
import {query, queryOne} from './db/client'
import {hostAgent} from './host-agent'

/**
 * 节点公开参数。
 *
 * ⚠️ 改端口 / SNI 时这里要和另外三处一起改，否则「页面上看到的地址」和
 *    「实际能连的地址」会对不上：
 *      · /usr/local/bin/xray-user          （命令行前端）
 *      · /opt/sub_server.py                （订阅服务，渲染 Clash 模板）
 *      · /usr/local/etc/xray/config.json   （xray 的 REALITY 真身）
 */
export const NODE = {
  server: '52.194.6.144',
  port: 443,
  sni: 'bitcoooin.cn',
  publicKey: 'nSzAs4I4LO74wmcPy85AZz2A4P73jbIhmfr3MFRFkBE',
  shortId: '05646a2929d72866',
  /** 订阅走的域名（和 bitcoooin.cn 同一个 Caddy，TLS 复用现有证书） */
  domain: 'bitcoooin.cn'
} as const

const AGENT_ENDPOINT = process.env.XRAYD_ENDPOINT || 'http://172.17.0.1:2097'
const AGENT_TOKEN = process.env.XRAYD_TOKEN || ''
const AGENT_TIMEOUT_MS = 30_000

export interface ProxyUser {
  id: number
  name: string
  uuid: string
  password: string
  enabled: boolean
  note: string
  /** 上次成功下发到宿主机的时间；null = 还没成功过 */
  syncedAt: string | null
  createdAt: string
}

interface ProxyUserRaw {
  id: string
  name: string
  uuid: string
  password: string
  enabled: boolean
  note: string
  synced_at: Date | null
  created_at: Date
}

const mapRow = (r: ProxyUserRaw): ProxyUser => ({
  id: Number(r.id),
  name: r.name,
  uuid: r.uuid,
  password: r.password,
  enabled: r.enabled,
  note: r.note,
  syncedAt: r.synced_at ? r.synced_at.toISOString() : null,
  createdAt: r.created_at.toISOString()
})

/** 订阅地址：直接丢给 Clash 的「订阅」栏（用户名密码内嵌在 URL 里） */
export const subUrl = (u: Pick<ProxyUser, 'name' | 'password'>): string =>
  `https://${u.name}:${encodeURIComponent(u.password)}@${NODE.domain}/sub/clash`

/** 单节点链接：不想用订阅就直接导入这个（Clash 手机端也能扫二维码加） */
export const nodeUrl = (u: Pick<ProxyUser, 'name' | 'uuid'>): string =>
  `vless://${u.uuid}@${NODE.server}:${NODE.port}` +
  `?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${NODE.sni}` +
  `&fp=chrome&pbk=${NODE.publicKey}&sid=${NODE.shortId}` +
  `&type=tcp&headerType=none#Tokyo-${u.name}`

/* ------------------------------------------------------------------ 宿主机 agent */

interface AgentUser {
  name: string
  uuid: string
  enabled: boolean
  created: string
}

/**
 * 连不上 / 令牌不对时抛的就是这个 —— 具体措辞在 host-agent.ts 里统一拼。
 * 名字保留下来，是因为这一页的错误提示（「连不上 xrayd（…）」）就是这么来的。
 */
export {HostAgentError as ProxyAgentError} from './host-agent'

const agent = hostAgent({
  endpoint: AGENT_ENDPOINT,
  token: AGENT_TOKEN,
  name: 'xrayd',
  tokenHint:
    '没配 XRAYD_TOKEN —— 服务器上 /opt/crypto-advisor/.env 里加一行即可（见 docs/DEPLOY.md「代理订阅」）',
  downHint: '服务器上 systemctl status xrayd 看看',
  timeoutMs: AGENT_TIMEOUT_MS
})

export interface ProxyHealth {
  ok: boolean
  error?: string
  xrayActive?: boolean
  subActive?: boolean
  inboundPort?: number
  /** 宿主机上「启用中」的用户数 —— 和应用库里的数量对不上就说明该点「同步」了 */
  enabledUsers?: number
}

export async function proxyHealth(): Promise<ProxyHealth> {
  try {
    const h = await agent.get<Omit<ProxyHealth, 'ok'>>('/health')
    return {ok: true, ...h}
  } catch (e) {
    return {ok: false, error: (e as Error).message}
  }
}

/* ------------------------------------------------------------------ 读写 */

const SELECT = `
  SELECT id, name, uuid, password, enabled, note, synced_at, created_at
  FROM proxy_users
`

export async function listProxyUsers(): Promise<ProxyUser[]> {
  const rows = await query<ProxyUserRaw>(`${SELECT} ORDER BY created_at, id`)
  return rows.map(mapRow)
}

async function getProxyUser(id: number): Promise<ProxyUser | null> {
  const row = await queryOne<ProxyUserRaw>(`${SELECT} WHERE id = $1`, [id])
  return row ? mapRow(row) : null
}

async function assertNameFree(name: string, exceptId?: number): Promise<void> {
  const row = await queryOne<{id: string}>(
    `SELECT id FROM proxy_users WHERE lower(name) = lower($1)`,
    [name]
  )
  if (row && Number(row.id) !== exceptId) throw new Error(`名字「${name}」已经有人用了`)
}

/** 用户名 / 订阅密码的字符集：BasicAuth 的 URL 里要能直接放，所以避开 `:@/` */
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

function checkName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error('名字只能用字母 / 数字 / 下划线 / 中划线，1-32 个字符')
  }
}

const newPassword = (): string => crypto.randomBytes(12).toString('base64url')

/**
 * 把宿主机上「应用还不认识」的用户捞进应用库。
 *
 * ⚠️ 为什么需要它：下发给 xrayd 的 PUT 是**整体覆盖**语义 —— 应用库里漏了谁，
 *    谁就会被从 xray 里删掉（节点当场失效）。所以**第一次打开这一页时**必须先把
 *    宿主机现有的名字 / uuid 收进来（uuid 原样保留 → 人家的节点链接不用改，
 *    只有订阅密码是新的，重新拉一次订阅即可）。
 *
 * ⚠️ 它**不能**放在 syncProxyUsers 里每次跑：否则管理员刚删掉的人会被立刻「复活」
 *    （宿主机上还有他 → 又被导入回来）。只在库为空时做，外加一个手动按钮。
 */
export async function importProxyUsersFromAgent(): Promise<number> {
  const host = await agent.get<{users: AgentUser[]}>('/users')
  const mine = await listProxyUsers()
  const have = new Set(mine.map(u => u.name.toLowerCase()))
  let added = 0
  for (const h of host.users) {
    if (have.has(h.name.toLowerCase())) continue
    await query(
      `INSERT INTO proxy_users (name, uuid, password, enabled, note)
       VALUES ($1, $2, $3, $4, '从宿主机导入')
       ON CONFLICT DO NOTHING`,
      [h.name, h.uuid, newPassword(), h.enabled]
    )
    added++
  }
  return added
}

/**
 * 把应用库里的状态**整体**下发给宿主机。
 *
 * 调这个之前先把库改好（本文件里几个写操作都是「改库 → 立刻 sync」）。
 * 下发失败不抛错、只把错误返回 —— 库里的改动是权威的，用户点一次「同步」就能补上。
 */
export async function syncProxyUsers(): Promise<{ok: boolean; error?: string; users: ProxyUser[]}> {
  const users = await listProxyUsers()
  if (users.length === 0) {
    // 一个都不留会让 xray 没有可用客户端（agent 也会拒），所以至少保留能启用的
    return {ok: false, error: '至少要留一个用户', users}
  }
  try {
    await agent.put<{users: AgentUser[]}>('/users', {
      users: users.map(u => ({
        name: u.name,
        uuid: u.uuid,
        password: u.password,
        enabled: u.enabled
      }))
    })
  } catch (e) {
    return {ok: false, error: (e as Error).message, users}
  }
  await query(`UPDATE proxy_users SET synced_at = now() WHERE id = ANY($1::bigint[])`, [
    users.map(u => u.id)
  ])
  return {ok: true, users: await listProxyUsers()}
}

/**
 * 下发；失败就**抛错**。
 *
 * 库里的改动已经提交了（不能假装回滚），所以消息里说清「已保存、下发失败」——
 * 用户看一眼就懂，点「同步」能补。之前是静默吞掉，结果页面显示成功、
 * 宿主机却没变（实测踩过）。
 */
async function pushOrThrow(): Promise<void> {
  const r = await syncProxyUsers()
  if (!r.ok) {
    throw new Error(`改动已存进应用库，但下发到宿主机失败：${r.error}（可点「同步」重试）`)
  }
}

export interface CreateProxyInput {
  name: string
  note?: string
}

export async function createProxyUser(input: CreateProxyInput): Promise<ProxyUser> {
  const name = input.name.trim()
  checkName(name)
  await assertNameFree(name)

  const row = await queryOne<ProxyUserRaw>(
    `INSERT INTO proxy_users (name, uuid, password, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, uuid, password, enabled, note, synced_at, created_at`,
    [name, crypto.randomUUID(), newPassword(), (input.note ?? '').trim()]
  )
  if (!row) throw new Error('写入失败')
  await pushOrThrow()
  return (await getProxyUser(Number(row.id))) ?? mapRow(row)
}

export async function setProxyUserEnabled(id: number, enabled: boolean): Promise<ProxyUser | null> {
  if (!enabled) {
    // 全停光 xray 就没有可用客户端了（agent 也会拒），这里先拦一道
    const left = await queryOne<{n: string}>(
      `SELECT count(*) AS n FROM proxy_users WHERE enabled AND id <> $1`,
      [id]
    )
    if (Number(left?.n ?? 0) === 0) throw new Error('至少要留一个启用中的用户')
  }
  const row = await queryOne<{id: string}>(
    `UPDATE proxy_users SET enabled = $2 WHERE id = $1 RETURNING id`,
    [id, enabled]
  )
  if (!row) return null
  await pushOrThrow()
  return getProxyUser(id)
}

export async function setProxyUserNote(id: number, note: string): Promise<ProxyUser | null> {
  const row = await queryOne<{id: string}>(
    `UPDATE proxy_users SET note = $2 WHERE id = $1 RETURNING id`,
    [id, note.trim()]
  )
  if (!row) return null
  return getProxyUser(id)
}

/** 换订阅密码（客户端那边要把订阅重新拉一次，节点本身不用改） */
export async function rotateProxyPassword(id: number): Promise<ProxyUser | null> {
  const row = await queryOne<{id: string}>(
    `UPDATE proxy_users SET password = $2 WHERE id = $1 RETURNING id`,
    [id, newPassword()]
  )
  if (!row) return null
  await pushOrThrow()
  return getProxyUser(id)
}

/** 换节点 UUID —— 旧节点链接立刻作废，订阅里那份也会跟着变 */
export async function rotateProxyUuid(id: number): Promise<ProxyUser | null> {
  const row = await queryOne<{id: string}>(
    `UPDATE proxy_users SET uuid = $2 WHERE id = $1 RETURNING id`,
    [id, crypto.randomUUID()]
  )
  if (!row) return null
  await pushOrThrow()
  return getProxyUser(id)
}

export async function deleteProxyUser(id: number): Promise<boolean> {
  const total = await queryOne<{n: string}>(`SELECT count(*) AS n FROM proxy_users`)
  if (Number(total?.n ?? 0) <= 1) throw new Error('至少要留一个用户（不然 xray 就没有可用客户端了）')
  // 删完之后必须还有「启用中的」用户，否则下发会被宿主机拒掉（xray 会没有可用客户端）
  const stillEnabled = await queryOne<{n: string}>(
    `SELECT count(*) AS n FROM proxy_users WHERE enabled AND id <> $1`,
    [id]
  )
  if (Number(stillEnabled?.n ?? 0) === 0) {
    throw new Error('删掉他之后就没有「启用中」的用户了 —— 先启用别人再删')
  }
  const rows = await query<{id: string}>(`DELETE FROM proxy_users WHERE id = $1 RETURNING id`, [id])
  if (rows.length === 0) return false
  await pushOrThrow()
  return true
}

/** 给前端画二维码用（返回 data URL，省得再开一个图片接口） */
export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {margin: 1, width: 320, errorCorrectionLevel: 'M'})
}
