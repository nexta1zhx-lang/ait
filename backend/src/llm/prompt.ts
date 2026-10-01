import {RulesBundle} from '../rules'

/**
 * 输出契约 —— 这段由代码固定，用户改不了。
 * 它把 AI 的回答约束成前端能渲染的结构，同时对应用户体系（判档 + Checklist）。
 */
const OUTPUT_CONTRACT = `【输出格式（必须严格遵守）】

只输出**一个 JSON 对象**。不要 Markdown，不要代码块，不要任何解释性文字。

{
  "grade": "A | B | C | unclear",
  "gradeReason": "判档依据：命中了体系里的哪几条（B 档必须写清是第几条）",
  "verdict": "go | no_go | wait",
  "confidence": 0-100 的整数,
  "direction": "long | short | none",
  "entry": { "type": "market | limit", "price": 数字或 null },
  "stopLoss": 数字或 null,
  "takeProfits": [
    { "label": "TP1", "price": 数字, "r": 盈亏比数字, "reducePercent": 减仓百分比 }
  ],
  "checklist": [
    { "item": "这个币强势吗？", "status": "pass | fail | warn", "evidence": "具体数据依据" }
  ],
  "failedCritical": ["命中的否决条款"],
  "verdictReason": "差在哪一条 / 为什么可做",
  "exitTriggers": ["什么情况下必须走"],
  "knowledgeRefs": [
    { "symbol": "ROBO", "timeframe": "1h", "lesson": "引用的经验原文" }
  ],
  "coachLine": "结尾那句话：我当前最该守住的规则"
}

【checklist 必须逐条包含这 7 条】
1. 这个币强势吗？
2. 有盘整结构吗？
3. 有强力 K / 放量突破吗？
4. 后续还有力量吗？
5. 止损位写得出吗？空间合理吗？
6. 现在是关键时段还是垃圾时段？
7. 心态是否平稳（数据判断不了就用 warn，并提醒我自己确认）

【硬性要求】
- 严禁编造数据，只能用行情快照里出现过的数字
- 写不出止损位 → verdict 必须是 no_go 或 wait
- grade = B 时 verdict 必须是 no_go
- 不要预测涨跌，不要给「稳赚」的话术，不要建议加仓 / 加杠杆 / 扛单
- coachLine 每次都要有`

export function buildSystemPrompt(rules: RulesBundle): string {
  return `${rules.system}

======================================================================
以下是我的规则正文。你判断时必须依据它逐条引用，不要自创规则。
======================================================================

${rules.body}

======================================================================

${OUTPUT_CONTRACT}`
}

export function buildUserPrompt(context: string, lessons: string): string {
  const parts: string[] = []
  if (lessons.trim()) {
    parts.push(
      `【我过往的经验（来自我自己的知识库，判断时请参考）】\n\n${lessons.trim()}`
    )
  }
  parts.push(`【当前行情快照】\n\n${context}`)
  parts.push(
    '请按我的体系判断：这个币现在该不该开单。逐条核对 Checklist，判档，给结论。'
  )
  return parts.join('\n\n' + '='.repeat(60) + '\n\n')
}
