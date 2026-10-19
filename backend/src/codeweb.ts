/**
 * 「系统管理 → 代码编辑器」：管理 `code.bitcoooin.cn` 的 Caddy Basic Auth 密码。
 *
 * VS Code 那边是 `code serve-web --without-connection-token`，本身**没有密码**；
 * 对外的唯一一道门是 Caddyfile 里 `code.bitcoooin.cn` 的 `basic_auth`。
 * 这里只改那一行 bcrypt 哈希，改完先 `caddy validate` 再 `caddy reload`，
 * 不重启容器、不断站。
 *
 * ⚠️ Caddyfile 由 compose 从宿主机挂到 app 容器（`./Caddyfile:/app/Caddyfile`）。
 *    单文件 bind mount **必须原地写**（`fs.writeFileSync`），不能「写临时文件再 rename」——
 *    rename 会换 inode，Caddy 容器里挂着的还是旧文件。
 *
 * ⚠️ 密码明文只会出现在 `docker exec ... caddy hash-password` 的参数里一瞬，
 *    不会落盘；Caddyfile 里始终只有哈希。
 */
import fs from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

const pexec = promisify(execFile)

const CADDYFILE = process.env.CODEWEB_CADDYFILE || '/app/Caddyfile'
const CADDY_CONTAINER = process.env.CODEWEB_CADDY_CONTAINER || 'ca-caddy'
const SITE = process.env.CODEWEB_SITE || 'code.bitcoooin.cn'
const TUNNEL_PORT = Number(process.env.CODEWEB_TUNNEL_PORT || 8000)

const PASSWORD_MIN = 8
const PASSWORD_MAX = 200

export type CodeWebInfo = {
  domain: string
  url: string
  /** 宿主机上 `code serve-web` 的端口 */
  port: number
  /** Caddyfile 里 Basic Auth 的用户名 */
  username: string
  /** Caddy 容器在跑 */
  caddyUp: boolean
  /** 宿主机的反向隧道（`127.0.0.1:8000`）能连上 */
  tunnelUp: boolean
  /** 两个都通 */
  online: boolean
  /** Caddyfile 读不到 / 找不到站点块时的说明 */
  error?: string
}

type BasicAuth = {
  username: string
  hash: string
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
  const s = stripComment(line)
  let d = 0
  for (const ch of s) {
    if (ch === '{') d++
    else if (ch === '}') d--
  }
  return d
}

/** 找到 `SITE { ... }` 这个站点块的起止行（含首尾） */
function findSite(lines: string[]): {start: number; end: number} | null {
  // 线上写的是裸域名；测试 / 特殊部署可能带 `http://` 或端口，一并认
  const re = new RegExp(
    `^\\s*(?:https?://)?${SITE.replace(/\./g, '\\.')}(?::\\d+)?\\s*\\{`
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

/** 站点块里的 `basic_auth { ... }` */
function findBasicAuth(
  lines: string[],
  site: {start: number; end: number}
): {start: number; end: number} | null {
  let start = -1
  let depth = 0
  for (let i = site.start + 1; i < site.end; i++) {
    const s = stripComment(lines[i])
    if (start < 0 && /^\s*basic_auth\s*\{/.test(s)) {
      start = i
      depth = 0
    }
    if (start >= 0) {
      depth += braceDelta(lines[i])
      if (depth <= 0 && i > start) return {start, end: i}
    }
  }
  return start >= 0 ? {start, end: site.end} : null
}

/** 第一个 `用户名 哈希` 行 */
function findUser(lines: string[]): BasicAuth | null {
  const site = findSite(lines)
  if (!site) return null
  const ba = findBasicAuth(lines, site)
  if (!ba) return null
  for (let i = ba.start + 1; i < ba.end; i++) {
    const raw = lines[i]
    const s = stripComment(raw).trim()
    if (!s) continue
    const m = s.match(/^(\S+)\s+(\S+)$/)
    if (!m) continue
    return {
      username: m[1],
      hash: m[2],
      line: i,
      indent: raw.match(/^\s*/)?.[0] ?? ''
    }
  }
  return null
}

function readCaddyfile(): {text: string; lines: string[]} {
  const text = fs.readFileSync(CADDYFILE, 'utf8')
  return {text, lines: text.split('\n')}
}

async function caddy(args: string[], timeout = 15_000): Promise<string> {
  const {stdout, stderr} = await pexec(
    'docker',
    ['exec', CADDY_CONTAINER, 'caddy', ...args],
    {timeout, maxBuffer: 1024 * 1024}
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
    const err = e as {stderr?: string}
    const detail = String(err.stderr ?? '')
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

async function isTunnelUp(): Promise<boolean> {
  /*
   * 线上：app 容器通过 compose 的 extra_hosts 把 host.docker.internal 指到宿主机；
   * 反向隧道监听的正是宿主机 127.0.0.1:8000。
   * 本地开发：没有容器，直接试 127.0.0.1。任何 HTTP 响应都算通。
   */
  for (const host of ['host.docker.internal', '127.0.0.1']) {
    try {
      const res = await fetch(`http://${host}:${TUNNEL_PORT}/`, {
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

export async function getCodeWebInfo(): Promise<CodeWebInfo> {
  const info: CodeWebInfo = {
    domain: SITE,
    url: `https://${SITE}`,
    port: TUNNEL_PORT,
    username: '',
    caddyUp: false,
    tunnelUp: false,
    online: false
  }

  try {
    const auth = findUser(readCaddyfile().lines)
    if (auth) info.username = auth.username
    else info.error = `Caddyfile 里没找到 ${SITE} 的 basic_auth 用户`
  } catch (e) {
    info.error = `读不到 Caddyfile（${CADDYFILE}）：${shortErr(e)}`
  }

  const [caddyUp, tunnelUp] = await Promise.all([isCaddyUp(), isTunnelUp()])
  info.caddyUp = caddyUp
  info.tunnelUp = tunnelUp
  info.online = caddyUp && tunnelUp
  return info
}

export async function setCodeWebPassword(password: string): Promise<void> {
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
  const auth = findUser(lines)
  if (!auth) {
    throw new Error(`Caddyfile 里没找到 ${SITE} 的 basic_auth 用户`)
  }

  const hash = await hashPassword(password)
  lines[auth.line] = `${auth.indent}${auth.username} ${hash}`

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
