import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {ROOT_DIR} from './config'

/** 规则目录 —— 只读，每次分析都全部读取 */
export const RULES_DIR = path.join(ROOT_DIR, 'rules')

/** 角色设定文件（system prompt 本体） */
export const SYSTEM_FILE = '主提示词.md'

/** 文件缺失时的兜底角色设定 */
const DEFAULT_SYSTEM = `你是我的加密货币合约交易教练。

你的任务不是预测涨跌，而是按我写下的交易规则，判断当前该不该开仓。
只引用我的规则条款，不要自创规则。行情数据里没有的东西一律不许猜。
回答要短，像教练下指令，用清单和结论。`

/** 文件缺失时的兜底规则正文 */
const DEFAULT_BODY = `（我还没有写具体规则。请去 rules/ 目录写下我的交易体系。）`

export interface RulesBundle {
  /** system prompt：角色设定 + 工作方式 */
  system: string
  /** 规则正文（拼好的所有 Markdown） */
  body: string
  /** 读取到的文件名 */
  sources: string[]
  hash: string
  warnings: string[]
}

/** 下划线开头 / README = 参考资料，不注入 */
function isSkipped(name: string): boolean {
  const base = path.basename(name)
  return base.startsWith('_') || base.startsWith('.') || /^readme/i.test(base)
}

/** 列出规则目录下的 .md（跳过参考文件） */
function listRuleFiles(): string[] {
  if (!fs.existsSync(RULES_DIR)) return []
  return fs
    .readdirSync(RULES_DIR)
    .filter(f => f.toLowerCase().endsWith('.md'))
    .filter(f => !isSkipped(f))
    .sort()
}

/**
 * 读取 rules/ 目录。
 *
 * - `主提示词.md`  → system
 * - 其余 `*.md`    → 规则正文（按文件名排序拼接）
 * - `_` 开头 / README → 跳过
 */
export function loadRules(): RulesBundle {
  const warnings: string[] = []
  const sources: string[] = []

  if (!fs.existsSync(RULES_DIR)) {
    warnings.push(`找不到规则目录 ${RULES_DIR}，请创建并放入你的规则文件。`)
    const text = DEFAULT_SYSTEM
    return {
      system: text,
      body: DEFAULT_BODY,
      sources: [],
      hash: hashOf(text),
      warnings
    }
  }

  let system = ''
  const parts: string[] = []

  for (const file of listRuleFiles()) {
    let content: string
    try {
      content = fs.readFileSync(path.join(RULES_DIR, file), 'utf8').trim()
    } catch (e) {
      warnings.push(`读取 ${file} 失败：${(e as Error).message}`)
      continue
    }
    if (!content) continue
    sources.push(file)
    if (file === SYSTEM_FILE) system = content
    else parts.push(`<!-- ${file} -->\n\n${content}`)
  }

  if (!system) {
    warnings.push(`没找到 rules/${SYSTEM_FILE}，正在使用内置的通用角色设定。`)
    system = DEFAULT_SYSTEM
  }
  const body = parts.length > 0 ? parts.join('\n\n---\n\n') : DEFAULT_BODY
  if (parts.length === 0) {
    warnings.push('rules/ 下没有规则正文，AI 只能凭角色设定里的体系摘要判断。')
  }

  return {
    system,
    body,
    sources,
    hash: hashOf(system + '\n\n' + body),
    warnings
  }
}

function hashOf(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
}
