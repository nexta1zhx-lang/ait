import crypto from 'crypto'
import {OUTPUT_CONTRACT} from './llm/prompt'
import {EXTRACT_PROMPT, PREDICT_PROMPT} from './llm/prompts'

/**
 * 「我的提示词」是怎么来的。
 *
 * ★ 2026-10-04：用户说「**AI 提示词界面没什么用，都要和代码绑定，直接去掉相关逻辑，
 * 写死代码**」—— 所以提示词不再从数据库读，正文就在 `llm/prompts.ts` 里，
 * **改提示词 = 改那个文件 + 重新部署**。
 *
 * ⚠️ `ai_docs` / `ai_doc_versions` 两张表**没删**（数据还在，只是不再读）。
 *
 * ⚠️ 下面这些类型 / 字段名**故意保留原样**（origin / bodyEnabled / dbError …）：
 * 上层（server / cli / `/api/health`）都在读它们，留着就不用改一大片调用点。
 * 只是现在 `dbError` 永远是 null、`origin` 永远是 'code'、`updatedAt` 永远是 null。
 */
export interface RulesBundle {
  /** 分析预测提示词正文（现在就是代码里那份常量） */
  system: string
  /** 以前是「规则正文」那一段；现在恒为空串，留着不破坏调用方 */
  body: string
  /** 有没有可用的提示词（代码常量恒有 → 恒 true） */
  bodyEnabled: boolean
  /** 提示词从哪来：现在是 `'code'`（以前是 `'db'` / `'documents'`） */
  origin: 'code' | 'db' | 'documents'
  /** 展示用：这提示词是哪一份 */
  sources: string[]
  hash: string
  warnings: string[]
  /** 以前是文档的更新时间；代码常量没这个概念，恒为 null */
  updatedAt: string | null
  /** 以前是「读库失败」的原因；现在恒为 null */
  dbError: string | null
}

/** 分析预测提示词（代码内置） */
export async function loadRules(): Promise<RulesBundle> {
  const system = PREDICT_PROMPT
  const enabled = Boolean(system.trim())
  return {
    system,
    body: '',
    bodyEnabled: enabled,
    origin: 'code',
    sources: ['分析预测（代码内置）'],
    hash: hashOf(fullSystem(system)),
    warnings: enabled
      ? []
      : ['内置的分析预测提示词是空的 —— 这是代码 bug，不是配置问题。'],
    updatedAt: null,
    dbError: null
  }
}

function hashOf(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
}

/**
 * **真正发给模型的那份全文** = 提示词正文 + 输出契约（代码里那份 JSON 骨架）。
 *
 * 为什么要拼一起：契约也是「提示词」的一部分 —— 改一条判定标准就是换了提示词，
 * 只哈希正文的话，**改了契约 hash 不变**，以后复盘分不出这次用的是哪一版。
 *
 * ⚠️ `bundle.system` **只是正文**（`buildSystemPrompt` 自己会拼契约），
 * 别拿这个函数的结果再去喂 `buildSystemPrompt`，会拼两遍。
 * 它的用途只有两个：**算 hash** + **存档**。
 */
export function fullSystem(system: string): string {
  const text = system.trim()
  return text ? `${text}\n\n${OUTPUT_CONTRACT}` : ''
}

/**
 * 知识库提炼用的提示词（代码内置，跟分析那份**分开**）。
 *
 * `enabled` 留着：万一以后把正文清空了，`extractCase` 照样会直接报错，不静默跑空。
 */
export interface ExtractRules {
  system: string
  enabled: boolean
  sources: string[]
  hash: string
  dbError: string | null
}

export async function loadExtractRules(): Promise<ExtractRules> {
  const system = EXTRACT_PROMPT
  return {
    system,
    enabled: Boolean(system.trim()),
    sources: ['知识库提炼（代码内置）'],
    hash: hashOf(system),
    dbError: null
  }
}
