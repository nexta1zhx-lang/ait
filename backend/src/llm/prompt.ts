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
  "exitPlan": {
    "holding": ["已开单：什么情况下必须走"],
    "watching": ["还没开单：出现什么条件才回头看（不是叫我现在进）"]
  },
  "knowledgeRefs": [
    { "symbol": "ROBO", "timeframe": "1h", "lesson": "引用的经验原文（只能逐字摘自我给的经验列表；没有就给 []）" }
  ],
  "coachLine": "结尾那句话：我当前最该守住的规则"
}

【checklist 必须逐条包含这 7 条】
1. 这个币强势吗？
2. 有盘整结构吗？
3. 有强力 K / 放量突破吗？
4. 各周期趋势一致吗？（做多要短中长同向；只写「多周期一致 / 哪几个周期打架」）
5. 止损位写得出吗？空间合理吗？
6. 现在是关键时段还是垃圾时段？
7. 心态是否平稳（数据判断不了就用 warn，并提醒我自己确认）

【exitPlan 怎么写】
- **只写「当下数据能验证的触发条件」**，不要写「后续会有力量」这种预测
- holding（已开单）：给了什么价、什么量、什么结构变化就必须走
- watching（还没开单）：满足什么条件才值得回头看 —— 写清楚「不是叫你进」
- 两条都必须是**可观察的事件**（价格位置 / 量比 / 结构破位），不是感觉

【一切都要带周期】
**趋势永远是「某个周期的趋势」**，脱离周期说趋势等于没说。所以：

- 任何趋势 / 结构 / 强势 / 盘整 / 突破的描述，**必须标明周期**。
  写「1h 震荡、4h 上涨、15m 下跌」，**不许**只写「趋势是震荡」
- 判档时要说清是**哪个周期**给出的依据（「A 档：4h 上升结构 + 1h 回调不破」）
- 多周期打架时**必须点明是哪几个周期冲突**，并说明以哪个周期为准、为什么
- 入场 / 止损 / 止盈的价格必须说明是**从哪个周期的结构**取的
  （例如「止损放 1h 最近波段低点下方」）

【硬性要求】
- 严禁编造数据，只能用行情快照里出现过的数字
- 写不出止损位 → verdict 必须是 no_go 或 wait
- grade = B 时 verdict 必须是 no_go
- **不要预测涨跌**：不算「后续有没有力量 / 会不会继续涨」这类当下数据看不出来的东西。
  只陈述当下快照里能验证的事实（价格结构、量比、资金费率、持仓量、周期是否一致）
- 不要给「稳赚」的话术，不要建议加仓 / 加杠杆 / 扛单
- knowledgeRefs 只能逐字摘自我在【我过往的经验】里给出的条目；
  没给经验列表（或列表为空）时必须返回 []，**不许自己编经验**
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
  } else {
    // 不说清楚的话，模型会照着输出格式硬凑几条根本不存在的「经验」
    parts.push(
      '【我过往的经验】\n\n' +
        '（我的知识库现在是空的，本次没有任何经验可引用。' +
        'knowledgeRefs 必须返回空数组 []，一条都不许编。）'
    )
  }
  parts.push(`【当前行情快照】\n\n${context}`)
  parts.push(
    '请按我的体系判断：这个币现在该不该开单。逐条核对 Checklist，判档，给结论。'
  )
  return parts.join('\n\n' + '='.repeat(60) + '\n\n')
}
