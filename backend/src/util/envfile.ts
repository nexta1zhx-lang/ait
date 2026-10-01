import fs from 'fs'
import path from 'path'
import {ROOT_DIR} from '../config'

/**
 * 读 / 写项目根目录的 .env。
 *
 * 写的时候是「就地替换 KEY=... 那一行」，其他内容原样保留，
 * 这样注释和别的配置都不会被冲掉。
 */

export function envFilePath(): string {
  return path.join(ROOT_DIR, '.env')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 写一个变量到 .env（同时更新当前进程的 env，改完立刻生效） */
export function writeEnvVar(name: string, value: string): boolean {
  try {
    const file = envFilePath()
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const line = `${name}=${value}`
    const re = new RegExp(`^${escapeRe(name)}=.*$`, 'm')

    if (re.test(content)) {
      content = content.replace(re, line)
    } else {
      const sep = content === '' || content.endsWith('\n') ? '' : '\n'
      content += `${sep}${line}\n`
    }

    fs.writeFileSync(file, content, 'utf8')
    process.env[name] = value
    return true
  } catch {
    return false
  }
}

/** 展示用：只留头尾，中间打码 */
export function maskSecret(v: string): string {
  const s = String(v ?? '')
  if (!s) return ''
  if (s.length <= 10) return s.slice(0, 2) + '***'
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}
