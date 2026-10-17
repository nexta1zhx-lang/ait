/**
 * 清理过期记录 —— 只清 `llm_usage`（每次调用的 token / 花费）。
 *
 * ⚠️ `analyses`（预测历史）**不在清理范围**：那是我自己要看的一句话记录，
 * 删了就没法回头对账了。
 *
 * ⚠️ 只删**流水**：
 *    · `llm_usage`   每次调用的 token / 花费 ✓ 删
 *    · `analyses` / `ai_docs` / `contract_store` —— **绝不碰**
 */
import {query} from './client'

export interface PruneResult {
  /** 保留天数（<= 0 表示没开清理） */
  keepDays: number
  usage: number
}

/** 删掉 `keepDays` 天以前的流水。`keepDays <= 0` 时什么都不做。 */
export async function pruneOldData(keepDays: number): Promise<PruneResult> {
  if (!(keepDays > 0)) return {keepDays, usage: 0}

  const u = await query<{id: string}>(
    `DELETE FROM llm_usage
      WHERE created_at < now() - make_interval(days => $1::int)
      RETURNING id`,
    [keepDays]
  )

  return {keepDays, usage: u.length}
}
