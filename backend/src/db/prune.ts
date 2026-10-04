/**
 * 清理过期记录。
 *
 * 用户 2026-10-04：「历史统计数据保存 3 个月的」——
 * 所以分析流水和用量流水**只留最近 N 天**（默认 90 天 = 3 个月，见 `config.keepDays`）。
 *
 * ⚠️ 只删**业务流水**：
 *    · `analyses`    每次分析的存档 ✓ 删
 *    · `llm_usage`   每次调用的 token/花费 ✓ 删
 *    · `knowledge`   自己一条条攒的经验案例 —— **绝不碰**
 *    · `ai_docs`     提示词正文 —— **绝不碰**
 *    · `tag_templates` / `contract_store` —— **绝不碰**
 */
import {query} from './client'

export interface PruneResult {
  /** 保留天数（<= 0 表示没开清理） */
  keepDays: number
  analyses: number
  usage: number
}

/**
 * 删掉 `keepDays` 天以前的流水。`keepDays <= 0` 时什么都不做（直接返回 0）。
 *
 * ⚠️ 顺序不能反：`analyses.llm_usage_id` 指向 `llm_usage`，先删子表再删父表，
 *    否则会撞外键。
 */
export async function pruneOldData(keepDays: number): Promise<PruneResult> {
  if (!(keepDays > 0)) return {keepDays, analyses: 0, usage: 0}

  const a = await query<{id: string}>(
    `DELETE FROM analyses
      WHERE created_at < now() - make_interval(days => $1::int)
      RETURNING id`,
    [keepDays]
  )
  const u = await query<{id: string}>(
    `DELETE FROM llm_usage
      WHERE created_at < now() - make_interval(days => $1::int)
      RETURNING id`,
    [keepDays]
  )

  return {keepDays, analyses: a.length, usage: u.length}
}
