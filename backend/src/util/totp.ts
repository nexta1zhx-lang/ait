/**
 * TOTP（RFC 6238）+ 恢复码。
 *
 * 用户 2026-10-04：「账户支持多端登录，admin 这个账号设备认证可以做吗」→
 * 选了 **TOTP 动态口令**（Google Authenticator / 1Password 那种 6 位码）。
 *
 * 只用 `node:crypto`，**不引第三方库**（OTP 这块算法就这些，自己写反而可控）。
 * 二维码那一步是后端用 `qrcode` 生成 SVG 给前端（见 server.ts）。
 *
 * 兼容性：算法固定 SHA1 / 6 位 / 30 秒 —— 这是各家认证器 App 的默认值，
 * 换别的（SHA256、8 位）很多 App 要手动选，容易把人卡住。
 */
import crypto from 'node:crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const STEP_SECONDS = 30
export const DIGITS = 6

/** 恢复码用的字母表：去掉 I O 0 1 这些看起来会混的 */
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/* ---------------------------------------------------------------- base32 */

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  // 尾巴补到 5 的倍数
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = String(s ?? '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of clean) {
    const idx = B32.indexOf(c)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/* ------------------------------------------------------------------ TOTP */

/** 20 字节随机 → 32 个 base32 字符（认证器 App 认的标准长度） */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes))
}

/** 某个时间步的 6 位码 */
export function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const mac = crypto.createHmac('sha1', key).update(buf).digest()
  const off = mac[mac.length - 1] & 0x0f
  const bin =
    ((mac[off] & 0x7f) << 24) |
    (mac[off + 1] << 16) |
    (mac[off + 2] << 8) |
    mac[off + 3]
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function stepAt(at: number = Date.now()): number {
  return Math.floor(at / 1000 / STEP_SECONDS)
}

/**
 * 校验 6 位码。
 *
 * @param window 允许前后各偏几个时间步（默认 ±1 = 前后 30 秒，给设备时间误差留余量）
 * @returns 命中的**时间步号**；不匹配返回 null。
 *          ⚠️ 调用方要拿这个步号做**防重放**（同一个步号只准成功一次）
 */
export function verifyTotp(
  secret: string,
  code: string,
  at: number = Date.now(),
  window = 1
): number | null {
  const c = String(code ?? '').replace(/\D/g, '')
  if (c.length !== DIGITS || !secret) return null
  const now = stepAt(at)
  const target = Buffer.from(c)
  for (let i = -window; i <= window; i++) {
    const step = now + i
    if (step < 0) continue
    const got = Buffer.from(hotp(secret, step))
    if (got.length === target.length && crypto.timingSafeEqual(got, target)) {
      return step
    }
  }
  return null
}

/** 给认证器 App 扫的链接（也贴给用户当「手动输入」的备选） */
export function otpauthUrl(opts: {
  secret: string
  label: string
  issuer: string
}): string {
  const q = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  })
  return `otpauth://totp/${encodeURIComponent(
    `${opts.issuer}:${opts.label}`
  )}?${q.toString()}`
}

/* -------------------------------------------------------------- 恢复码 */

/** 10 个字符，展示成 `XXXXX-XXXXX` */
export function generateRecoveryCodes(n = 8): string[] {
  const out: string[] = []
  while (out.length < n) {
    let s = ''
    for (let i = 0; i < 10; i++) {
      s += RC_ALPHABET[crypto.randomInt(RC_ALPHABET.length)]
    }
    const code = `${s.slice(0, 5)}-${s.slice(5)}`
    if (!out.includes(code)) out.push(code)
  }
  return out
}

/** 恢复码**只存 hash** —— 库被人看到也拿不到码（跟密码一个道理） */
export function hashRecovery(code: string): string {
  const norm = String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  return crypto.createHash('sha256').update(norm).digest('hex')
}
