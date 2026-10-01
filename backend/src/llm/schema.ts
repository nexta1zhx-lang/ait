import {z} from 'zod'

export const takeProfitSchema = z.object({
  label: z.string().catch('TP'),
  price: z.number(),
  r: z.number().catch(0),
  reducePercent: z.number().catch(0)
})

/** 开单判断的输出结构 —— 对齐我自己的体系（判档 + Checklist + 结论） */
export const judgeSchema = z.object({
  /** A 顺势单 / B 不该做 / C 期望突破 / unclear 说不清 */
  grade: z.enum(['A', 'B', 'C', 'unclear']).catch('unclear'),
  /** 判档依据：命中了哪几条 */
  gradeReason: z.string().catch(''),
  /** go = 可做, wait = 观望, no_go = 不可做 */
  verdict: z.enum(['go', 'no_go', 'wait']).catch('wait'),
  confidence: z.number().min(0).max(100).catch(50),
  direction: z.enum(['long', 'short', 'none']).catch('none'),
  entry: z
    .object({
      type: z.enum(['market', 'limit']).catch('market'),
      price: z.number().nullable().catch(null)
    })
    .catch({type: 'market', price: null}),
  stopLoss: z.number().nullable().catch(null),
  takeProfits: z.array(takeProfitSchema).catch([]),
  /** 逐条核对我的 Checklist */
  checklist: z
    .array(
      z.object({
        item: z.string(),
        status: z.enum(['pass', 'fail', 'warn']).catch('warn'),
        evidence: z.string().catch('')
      })
    )
    .catch([]),
  /** 命中的否决条款 */
  failedCritical: z.array(z.string()).catch([]),
  /** 差在哪一条 */
  verdictReason: z.string().catch(''),
  /** 什么情况下必须走 */
  exitTriggers: z.array(z.string()).catch([]),
  /** 引用了知识库里哪些经验 */
  knowledgeRefs: z
    .array(
      z.object({
        symbol: z.string().catch(''),
        timeframe: z.string().catch(''),
        lesson: z.string().catch('')
      })
    )
    .catch([]),
  /** 结尾那句话：当前最该守住的规则 */
  coachLine: z.string().catch('')
})

export type JudgeParsed = z.infer<typeof judgeSchema>
