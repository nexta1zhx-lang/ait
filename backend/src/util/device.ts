/**
 * 设备识别：把 User-Agent 压成一句人能看的话（「iPhone · Safari」）。
 *
 * 用户 2026-10-04：「账户支持多端登录」→ 要能看到**有哪些设备在线**、
 * 单独踢掉某一台。库里的会话因此多存了 UA / IP（见 db/schema.ts 的 sessions）。
 *
 * 只是给人看的标签，**不做任何安全判断**（UA 谁都能伪造）。
 */
export interface DeviceInfo {
  /** 系统：「iPhone」「iPad」「Android」「Mac」「Windows」「Linux」「未知」 */
  os: string
  /** 浏览器 / 壳：「Safari」「Chrome」「Edge」「Firefox」「App」「未知」 */
  browser: string
  /** 展示用，如「iPhone · Safari」 */
  label: string
  /** 是不是打包的 App（Capacitor 原生壳） */
  app: boolean
}

export function describeDevice(userAgent: string): DeviceInfo {
  const ua = String(userAgent ?? '')

  let os = '未知'
  if (/iPhone/i.test(ua)) os = 'iPhone'
  else if (/iPad/i.test(ua)) os = 'iPad'
  else if (/Android/i.test(ua)) os = 'Android'
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'Mac'
  else if (/Windows/i.test(ua)) os = 'Windows'
  else if (/Linux|X11/i.test(ua)) os = 'Linux'

  // ⚠️ 顺序要紧：Edge 的 UA 里也带 "Chrome"，Opera 里也带，所以先判那些
  const app = /Capacitor/i.test(ua)
  let browser = '未知'
  if (/Edg[A-Za-z]*\//i.test(ua)) browser = 'Edge'
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera'
  else if (/Firefox\/|FxiOS/i.test(ua)) browser = 'Firefox'
  else if (/CriOS\//i.test(ua)) browser = 'Chrome'
  else if (/Chrome\//i.test(ua)) browser = 'Chrome'
  else if (/Safari\//i.test(ua)) browser = 'Safari'
  if (app) browser = 'App'

  const label =
    os === '未知' && browser === '未知' ? '未知设备' : `${os} · ${browser}`
  return {os, browser, label, app}
}

/**
 * 从请求里取客户端 IP。
 *
 * 线上是 Caddy 反代（`X-Forwarded-For` 会带真实 IP），所以优先取那个；
 * 本机直连没有这个头，退回 socket 地址。
 */
export function clientIp(
  headers: Record<string, unknown>,
  remote?: string
): string {
  const xff = headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? String(xff[0]) : String(xff ?? '')
  const first = raw.split(',')[0]?.trim()
  if (first) return first
  let ip = String(remote ?? '')
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip === '::1') ip = '127.0.0.1'
  return ip
}
