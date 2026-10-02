import crypto from 'crypto'
import {getEnabledDocs} from './db/prompts'
import {OUTPUT_CONTRACT} from './llm/prompt'

/**
 * 「我的提示词」是怎么拼出来的。
 *
 * 全部来自数据库 `ai_docs`（网页「AI 提示词」页上编辑）：
 *   kind = predict → 分析预测提示词（**只有这一份**，不再分角色/规则）
 *   kind = extract → 知识库提炼提示词
 * 关掉的文档不参与。
 *
 * 没有文件、没有内置角色、没有兜底文案 —— 库里没写就是没有。
 */
export interface RulesBundle {
  /** 角色设定（kind=role 的启用文档，按 sort 拼） */
  system: string
  /** 规则正文（kind=rule 的启用文档，按 sort 拼） */
  body: string
  /** 至少有一份文档参与拼 prompt */
  bodyEnabled: boolean
  /** 现在只有数据库一个来源；documents=库里什么都没有 */
  origin: 'db' | 'documents'
  /** 展示用：参与拼接的文档名 */
  sources: string[]
  hash: string
  warnings: string[]
  /** 这批文档里最晚的更新时间 */
  updatedAt: string | null
  /** 读数据库失败的原因（正常时是 null）—— 上层据此决定要不要直接不分析 */
  dbError: string | null
}

/**
 * 读数据库里的提示词文档，拼成 prompt 用的两段。
 *
 * 数据库读不到时**不冒充内容**，直接返回空 —— 上层会提示「没有规则/角色」。
 */
export async function loadRules(): Promise<RulesBundle> {
  const warnings: string[] = []

  try {
    const {predict, updatedAt} = await getEnabledDocs()
    // 提示词只有一份（kind=predict）—— 不再分「角色设定 + 规则正文」两段
    const system = joinDocs(predict)
    const body = ''
    const sources = predict.map(d => d.name)
    const enabled = Boolean(system.trim())
    if (!enabled) {
      warnings.push(
        'ai_docs 里没有启用的「分析预测」提示词 —— 本次不判断（去「AI 提示词」页写一份）。'
      )
    }
    return {
      system,
      body,
      bodyEnabled: enabled,
      origin: enabled ? 'db' : 'documents',
      sources,
      hash: hashOf(fullSystem(system)),
      warnings,
      updatedAt,
      dbError: null
    }
  } catch (e) {
    warnings.push(`读提示词文档失败：${(e as Error).message}`)
    return {
      system: '',
      body: '',
      bodyEnabled: false,
      origin: 'documents',
      sources: [],
      hash: hashOf(fullSystem('')),
      warnings,
      updatedAt: null,
      dbError: (e as Error).message
    }
  }
}

/** 多份文档拼成一段，带上文档名当小标题（模型和我都能看出读的是哪一节） */
function joinDocs(docs: {name: string; content: string}[]): string {
  return docs
    .map(d => `## ${d.name}\n\n${d.content.trim()}`)
    .join('\n\n---\n\n')
}

function hashOf(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)
}

/**
 * **真正发给模型的那份全文** = 数据库正文 + 输出契约（代码里那份 JSON 骨架）。
 *
 * 为什么要拼一起：契约也是「提示词」的一部分 —— 改一条判定标准就是换了提示词，
 * 只哈希数据库正文的话，**改了契约 hash 不变**，以后复盘分不出这次用的是哪一版。
 *
 * ⚠️ `bundle.system` **只是数据库正文**（`buildSystemPrompt` 自己会拼契约），
 * 别拿这个函数的结果再去喂 `buildSystemPrompt`，会拼两遍。
 * 它的用途只有两个：**算 hash** + **存档**。
 */
export function fullSystem(system: string): string {
  const text = system.trim()
  return text ? `${text}\n\n${OUTPUT_CONTRACT}` : ''
}

/**
 * 知识库提炼用的提示词（`ai_docs` 里 kind=extract 的文档）。
 *
 * 跟开单分析那份**分开读**，互不干扰 —— 分析读 role + rule，提炼读 extract。
 * 库里没写就是空的，`extractCase` 会直接报错（代码里没有兜底文案）。
 */
export interface ExtractRules {
  system: string
  enabled: boolean
  sources: string[]
  hash: string
  dbError: string | null
}

export async function loadExtractRules(): Promise<ExtractRules> {
  try {
    const {extract} = await getEnabledDocs()
    const system = joinDocs(extract)
    return {
      system,
      enabled: Boolean(system.trim()),
      sources: extract.map(d => `提炼：${d.name}`),
      hash: hashOf(system),
      dbError: null
    }
  } catch (e) {
    return {
      system: '',
      enabled: false,
      sources: [],
      hash: hashOf(''),
      dbError: (e as Error).message
    }
  }
}
