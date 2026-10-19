/**
 * 「系统管理 → Mac 服务」：管 Mac 上那几个 Web 服务的 Caddy 入口。
 *
 * 现在的两个（都在 Mac 上跑，经反向隧道由这台服务器转出去）：
 *   · `code.bitcoooin.cn` → 宿主 8000 → `code serve-web`
 *   · `chat.bitcoooin.cn` → 宿主 59721 → `dsh --profile remote`（DeepSeek Harness）
 *
 * 两边在 Caddyfile 里用的是**同一个 Basic Auth 用户 + 同一个哈希** ⇒ 这里改一次，
 * 两个入口一起生效（只改一个会让两边密码对不上，所以干脆设成一体）。
 *
 * ⚠️ VS Code / Harness 自己都不做认证，对外唯一那道门就是 Caddy 的 basic_auth；
 *    明文不落盘，Caddyfile 里只有 bcrypt 哈希。
 *
 * ⚠️ Caddyfile 由 compose 从宿主机挂到 app 容器（`./Caddyfile:/app/Caddyfile`）。
 *    单文件 bind mount **必须原地写**（`fs.writeFileSync`），不能「写临时文件再 rename」——
 *    rename 会换 inode，Caddy 容器里挂着的还是旧文件。
 */
import fs from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const pexec = promisify(execFile)

const CADDYFILE = process.env.MAC_CADDYFILE || '/app/Caddyfile'
const CADDY_CONTAINER = process.env.MAC_CADDY_CONTAINER || 'ca-caddy'

const PASSWORD_MIN = 8
const PASSWORD_MAX = 200

export type MacServiceDef = {
  key: string
  name: string
  site: string
  /** 服务器上反向隧道的端口（`172.17.0.1:<port>`） */
  port: number
  detail: string
}

/** 顺序就是页面上从上到下的顺序 */
export const MAC_SERVICES: MacServiceDef[] = [
  {
    key: 'code',
    name: 'VS Code Web',
    site: process.env.MAC_SITE_CODE || 'code.bitcoooin.cn',
    port: Number(process.env.MAC_PORT_CODE || 8000),
    detail: 'code serve-web（Copilot Chat + DeepSeek provider）'
  },
  {
    key: 'chat',
    name: 'DeepSeek Harness',
    site: process.env.MAC_SITE_CHAT || 'chat.bitcoooin.cn',
    port: Number(process.env.MAC_PORT_CHAT || 59721),
    detail: 'dsh --profile remote'
  }
]

export type MacServiceStatus = MacServiceDef & {
  url: string
  /** Caddyfile 里有这个站点块，并且找到了 basic_auth 用户 */
  configured: boolean
  /** 隧道那头连得上 */
  up: boolean
}

export type MacServicesInfo = {
  caddyUp: boolean
  /** Basic Auth 用户名（两个入口共用一个） */
  username: string
  services: MacServiceStatus[]
  error?: string
}

type BasicAuth = {
  username: string
  line: number
  indent: string
}

function shortErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** 去掉行尾注释（引号里的 `#` 不算） */
function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

function braceDelta(line: string): number {
  let d = 0
  for (const ch of stripComment(line)) {
    if (ch === '{') d++
    else if (ch === '}') d--
  }
  return d
}

/** 找到 `SITE { ... }` 这个站点块的起止行（含首尾） */
function findSite(lines: string[], site: string): {start: number; end: number} | null {
  // 线上写的是裸域名；测试 / 特殊部署可能带 `http://` 或端口，一并认
  const re = new RegExp(
    `^\\s*(?:https?://)?${site.replace(/\./g, '\\.')}(?::\\d+)?\\s*\\{`
  )
  const start = lines.findIndex(l => re.test(stripComment(l)))
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    depth += braceDelta(lines[i])
    if (depth <= 0 && i > start) return {start, end: i}
  }
  return null
}

/** 站点块里的 `basic_auth { ... }` 的第一行 `用户名 哈希` */
function findAuth(lines: string[], site: string): BasicAuth | null {
  const block = findSite(lines, site)
  if (!block) return null
  let start = -1
  let depth = 0
  for (let i = block.start + 1; i < block.end; i++) {
    const s = stripComment(lines[i])
    if (start < 0 && /^\s*basic_auth\s*\{/.test(s)) {
      start = i
      depth = 0
    }
    if (start < 0) continue
    depth += braceDelta(lines[i])
    if (depth <= 0 && i > start) break
    // ⚠️ 从 `basic_auth {` 的**下一行**开始找：那一行本身也符合「两个词」，
    //    会被当成用户名叫 `basic_auth`（第一版就是这么错的）
    if (i === start) continue
    const row = stripComment(lines[i]).trim()
    const m = row.match(/^(\S+)\s+\S+$/)
    if (m) {
      return {
        username: m[1],
        line: i,
        indent: lines[i].match(/^\s*/)?.[0] ?? ''
      }
    }
  }
  return null
}

function readCaddyfile(): {text: string; lines: string[]} {
  const text = fs.readFileSync(CADDYFILE, 'utf8')
  return {text, lines: text.split('\n')}
}

async function caddy(args: string[]): Promise<string> {
  const {stdout, stderr} = await pexec(
    'docker',
    ['exec', CADDY_CONTAINER, 'caddy', ...args],
    {timeout: 15_000, maxBuffer: 1024 * 1024}
  )
  return `${stdout}${stderr}`
}

async function hashPassword(password: string): Promise<string> {
  let stdout = ''
  try {
    const r = await pexec(
      'docker',
      [
        'exec',
        CADDY_CONTAINER,
        'caddy',
        'hash-password',
        `--plaintext=${password}`
      ],
      {timeout: 15_000, maxBuffer: 1024 * 1024}
    )
    stdout = String(r.stdout)
  } catch (e) {
    // ⚠️ 别把 execFile 的原始错误直接抛出去 —— 它带着整条命令行，
    //    里面就有明文密码。只取 stderr 的第一段。
    const detail = String((e as {stderr?: string}).stderr ?? '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)[0]
    throw new Error(
      `生成哈希失败：${detail ? detail.slice(0, 200) : 'caddy hash-password 执行失败'}`
    )
  }
  const hash = stdout.trim()
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) {
    throw new Error('Caddy 返回的哈希格式不对')
  }
  return hash
}

async function isCaddyUp(): Promise<boolean> {
  try {
    const {stdout} = await pexec(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', CADDY_CONTAINER],
      {timeout: 4000}
    )
    return String(stdout).trim() === 'true'
  } catch {
    return false
  }
}

async function isUp(port: number): Promise<boolean> {
  /*
   * 线上：app 容器通过 compose 的 extra_hosts 把 host.docker.internal 指到宿主机，
   * 反向隧道就监听在宿主机上。本地开发：没有容器，直接试 127.0.0.1。
   * 任何 HTTP 响应都算通（401 也算 —— 说明服务活着）。
   */
  for (const host of ['host.docker.internal', '127.0.0.1']) {
    try {
      const res = await fetch(`http://${host}:${port}/`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(2500)
      })
      return res.status > 0
    } catch {
      /* 换下一个 host */
    }
  }
  return false
}

export async function getMacServices(): Promise<MacServicesInfo> {
  const info: MacServicesInfo = {
    caddyUp: false,
    username: '',
    services: []
  }

  let lines: string[] = []
  try {
    lines = readCaddyfile().lines
  } catch (e) {
    info.error = `读不到 Caddyfile（${CADDYFILE}）：${shortErr(e)}`
  }

  const found = MAC_SERVICES.map(s => (lines.length ? findAuth(lines, s.site) : null))
  for (const a of found) if (a && !info.username) info.username = a.username

  info.services = await Promise.all(
    MAC_SERVICES.map(async (s, i) => ({
      ...s,
      url: `https://${s.site}`,
      configured: Boolean(found[i]),
      up: await isUp(s.port)
    }))
  )

  info.caddyUp = await isCaddyUp()
  if (!info.username && !info.error) {
    info.error = `Caddyfile 里没找到 ${MAC_SERVICES.map(s => s.site).join(' / ')} 的 basic_auth 用户`
  }
  return info
}

export async function setMacPassword(password: string): Promise<void> {
  if (typeof password !== 'string') throw new Error('密码格式不对')
  if (password.length < PASSWORD_MIN) {
    throw new Error(`密码至少 ${PASSWORD_MIN} 位`)
  }
  if (password.length > PASSWORD_MAX) {
    throw new Error(`密码太长（最多 ${PASSWORD_MAX} 位）`)
  }
  if (/[\r\n\0]/.test(password)) {
    throw new Error('密码不能包含换行或空字符')
  }

  const {text, lines} = readCaddyfile()
  const found = MAC_SERVICES.map(s => ({site: s.site, auth: findAuth(lines, s.site)}))

  const usable = found.filter(f => f.auth)
  if (!usable.length) {
    throw new Error(`Caddyfile 里没找到 ${MAC_SERVICES.map(s => s.site).join(' / ')} 的 basic_auth 用户`)
  }
  /*
   * 两个入口共用一套账号：用户名必须一致，否则不知道该按谁改 ——
   * 直接报出来让人先手工对齐，别猜。
   */
  const users = new Set(usable.map(f => f.auth!.username))
  if (users.size > 1) {
    throw new Error(
      `几个入口的用户名不一致（${[...users].join(' / ')}），先在 Caddyfile 里统一再改`
    )
  }

  const hash = await hashPassword(password)
  for (const f of usable) {
    lines[f.auth!.line] = `${f.auth!.indent}${f.auth!.username} ${hash}`
  }

  try {
    // 原地写：单文件 bind mount 换 inode 后容器看不到新内容
    fs.writeFileSync(CADDYFILE, lines.join('\n'))
  } catch (e) {
    throw new Error(`写 Caddyfile 失败：${shortErr(e)}`)
  }

  try {
    await caddy([
      'validate',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile'
    ])
    await caddy([
      'reload',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile'
    ])
  } catch (e) {
    // 校验 / 热重载失败：把文件恢复成旧内容，Caddy 继续跑旧配置
    try {
      fs.writeFileSync(CADDYFILE, text)
    } catch {
      /* 回滚也失败就只能把原始错误报出去 */
    }
    try {
      await caddy([
        'reload',
        '--config',
        '/etc/caddy/Caddyfile',
        '--adapter',
        'caddyfile'
      ])
    } catch {
      /* 旧配置本来就在跑，忽略 */
    }
    throw new Error(`Caddy 没有接受新配置，已回滚：${shortErr(e)}`)
  }
}
