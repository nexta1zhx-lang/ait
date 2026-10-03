import {z} from 'zod'

/**
 * 开单判断的输出结构 —— **只有四个字段**。
 *
 * 2026-10-02 大简化：原来的 perTimeframe / checklist(通用前置+档位专属) /
 * takeProfits / stopLoss / entry / direction / exitPlan / knowledgeRefs /
 * coachLine / failedCritical / verdictReason **全删了**。
 *
 * 现在 AI 只回：**档位 + 标签 + 理由 + 结论**。
 * 账户、仓位、杠杆、止损止盈、准入清单、知识库经验引用 —— 一概不需要。
 *
 * ⚠️ 档位取值必须和规则文档里的档位表一致 —— 不在枚举里的值会被 `.catch`
 * 静默变成 `unclear`。改这里要同步：`frontend/src/format.ts` 的 GRADE_TEXT、
 * `output/render.ts`、`scripts/history.ts`。
 */
export const judgeSchema = z.object({
  /**
   * 形状标签 + **每个标签的概率**（最多 `MAX_TAGS` 个，现在是 2）。
   *
   * 优先从【可用的标签】（= 标签模板 ∪ 知识库里已用过的标签）里挑，
   * 拼写要完全一致；池子里实在没有合适的才新造。
   */
  tags: z
    .array(
      z.object({
        name: z.string(),
        /** 这个形状 / 走势接下来出现的可能性（0~100） */
        probability: z.number().min(0).max(100).catch(50)
      })
    )
    .catch([]),
  /** 为什么这么看：用我给的数据说话（哪几段、哪几个价位、量能怎么变的） */
  reason: z.string().catch(''),
  /** 接下来**最大概率**会走成什么样（方向和节奏，不写具体点位目标） */
  outlook: z.string().catch(''),
  /** 上面那个走势发生的概率（0~100 的整数） */
  probability: z.number().min(0).max(100).catch(50),
  /** go = 可做, wait = 等待, no_go = 不做 */
  verdict: z.enum(['go', 'wait', 'no_go']).catch('wait'),
  /** 推荐怎么做：现在做什么、什么条件下动手、什么条件下不碰 */
  recommendation: z.string().catch('')
})

/**
 * 标签最多留几个（模型偶尔会多给，`client.ts` 里靠它兜一道）。
 *
 * ★ 2026-10-04：用户要求「标签最多 2 个」—— 原来是 4。
 * 改这里就够了（契约、标签池提示、前端都引用它 / 跟着变），
 * ⚠️ 但**数据库那份提示词里写着「最多 4 个」**，那份要单独改（它在库里，不跟着代码走）。
 */
export const MAX_TAGS = 2

export type JudgeParsed = z.infer<typeof judgeSchema>
