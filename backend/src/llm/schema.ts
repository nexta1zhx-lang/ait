import {z} from 'zod'

/**
 * 开单判断的输出结构 —— **就一句话**。
 *
 * ★ 2026-10-11：用户要「重置整个交易系统分析」。原来的
 *   档位 / 标签 / 概率 / 理由 / 走势 / 推荐 六件套全删了，
 *   只回一句话：**能不能做 + 进场价 + 止损价**（自然语言、不固定格式）。
 *
 * 契约只认「有一个字符串字段 `line`」；**内容、语气、要不要带点位，全看数据库那份
 * 「分析预测」提示词**（网页「我的 → AI 提示词」，即改即生效）。
 */
export const judgeSchema = z.object({
  line: z.string().catch('')
})

export type JudgeParsed = {line: string}
export type JudgeResult = JudgeParsed
