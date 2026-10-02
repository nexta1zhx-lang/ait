import {judgeSchema} from './schema'

/**
 * 输出契约 —— **故意写死在代码里**。
 *
 * 它只管「机器要读的结构」：字段名、类型、取值范围、必须输出 JSON。
 * **语义一律不在这里**（怎么预测、verdict 三档怎么判、写点位的要求……）
 * —— 那些全在数据库那份提示词（`ai_docs`，kind=predict）里，由我自己写。
 * 这里多写一句，就等于偷偷加了一条我在网页上看不见的规则。
 *
 * ⚠️ 骨架里的字段名必须和 `judgeSchema` 一致 —— `npm run selftest` 会断言两边相等
 * （只改一边不会报错，只会静默变空，因为 schema 里到处是 `.catch()` 兜底）。
 */
export const OUTPUT_CONTRACT = `【输出格式（必须严格遵守）】

只输出**一个 JSON 对象**。不要 Markdown，不要代码块，不要任何解释性文字。
下面骨架里的 \`//\` 只是给你的注解，**不要出现在你的输出里**。

{
  "tags": [                              // 形状标签 + 每个标签的概率，最多 4 个
    { "name": "放量突破", "probability": 70 },
    { "name": "缩量横盘", "probability": 30 }
  ],
  "reason": "为什么这么看（字符串）",
  "outlook": "接下来最大概率会走成什么样（字符串）",
  "probability": 65,                     // 上面那个走势的概率，0~100 的整数
  "verdict": "go | wait | no_go",         // 现在这个价能不能进
  "recommendation": "推荐怎么做（字符串）"
}

字段一个都不能少、也不能多加。
**每个字段该写什么、怎么判断，全按上面我的提示词来 —— 这里只管格式。**`

/**
 * 标签池 → 提示词里的一段。
 *
 * 池子 = **标签模板**（网页「历史知识库」页维护）∪ **知识库里已经用过的标签**。
 * 复用这两处，不另建一套标签体系 —— 已有合适的就用现成的，标签才不会膨胀。
 */
export function tagPoolBlock(tags: string[]): string {
  const clean = [...new Set(tags.map(t => t.trim()).filter(Boolean))]
  if (!clean.length) {
    return (
      '【可用的标签】\n\n' +
      '（标签模板是空的。那就一个标签都不给：tags 必须返回空数组 []。）'
    )
  }
  return (
    '【可用的标签（优先从这里挑，拼写要完全一致）】\n\n' +
    clean.join(' / ') +
    '\n\n' +
    '（最多挑 4 个，只挑真的贴合的；一个都不贴合就返回 []。\n' +
    '  池子里实在没有合适的可以新造，但别拿同义词去顶已有的标签。）'
  )
}

/**
 * system prompt = **数据库里那份预测提示词** + 输出契约。
 *
 * ⚠️ 代码里没有兜底文案 —— 库里没写就直接报错。
 */
export function buildSystemPrompt(promptText: string): string {
  const text = promptText.trim()
  if (!text)
    throw new Error(
      '没有启用的「预测提示词」—— 去「AI 提示词」页写一份（类型选「分析预测」）。'
    )
  return `${text}\n\n${OUTPUT_CONTRACT}`
}

/**
 * 拼 user prompt：行情快照 + 可用的标签 + 一句「请开始预测」。
 *
 * 不注入知识库经验 —— 只从知识库借一份标签池。
 */
export function buildUserPrompt(context: string, tags: string[]): string {
  const sep = '\n\n' + '='.repeat(60) + '\n\n'
  return [
    `【当前行情快照】\n\n${context}`,
    tagPoolBlock(tags),
    '请回答：按我的提示词，这段行情接下来**最大概率**会走成什么样，现在该怎么做。'
  ].join(sep)
}
