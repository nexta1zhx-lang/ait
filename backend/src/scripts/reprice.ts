/**
 * 重算历史花费 —— 按**新的**高峰 / 空闲判定。
 *
 * 改过 `cn-holidays.ts`（法定节假日表）或高峰时段规则之后跑这个，
 * 把 `llm_usage` 和 `analyses` 里已经落库的 `cost_usd` 重新算一遍。
 *
 * 只依赖库里已有的数据（下单时刻 + 用量 + 模型），不重新调模型。
 *
 *   npm run reprice            # 先看差异，不写库
 *   npm run reprice -- --write # 真写
 *   npm run peak               # 看全年每一天算高峰还是空闲
 */
import {costOf, emptyUsage} from '../llm/pricing'
import {beijingParts, peakText} from '../llm/cn-holidays'
import {query} from '../db/client'

const write = process.argv.includes('--write')

/** 库里的时刻是 TIMESTAMPTZ，pg 会给 Date；字符串也兜一下 */
function atOf(v: unknown): Date {
  if (v instanceof Date) return v
  const d = new Date(String(v))
  return Number.isFinite(d.getTime()) ? d : new Date()
}

const cny = (usd: number) => `¥${(usd * 7.1).toFixed(4)}`

async function main() {
  console.log(
    write
      ? '=== 重算花费（会写库）==='
      : '=== 重算花费（只是预览，加 --write 才写）==='
  )

  /* ---------------- llm_usage ---------------- */
  const rows = await query<{
    id: string
    model: string
    prompt_tokens: number
    completion_tokens: number
    cache_hit_tokens: number
    cache_miss_tokens: number
    cost_usd: string
    peak: boolean
    created_at: unknown
  }>(
    `SELECT id, model, prompt_tokens, completion_tokens,
            cache_hit_tokens, cache_miss_tokens, cost_usd, peak, created_at
       FROM llm_usage
      ORDER BY created_at`
  )

  let changed = 0
  let oldTotal = 0
  let newTotal = 0
  let peakBefore = 0
  let peakAfter = 0
  let peakFixed = 0
  /** 金额有变的 usage 行 —— 关联到它们的 analyses 也要跟着改 */
  const changedIds: number[] = []

  for (const r of rows) {
    const at = atOf(r.created_at)
    const usage = {
      ...emptyUsage(),
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.prompt_tokens + r.completion_tokens,
      cacheHitTokens: r.cache_hit_tokens,
      // 老记录可能没存明细：按「未命中」算，偏保守不会少算钱
      cacheMissTokens:
        r.cache_miss_tokens || Math.max(0, r.prompt_tokens - r.cache_hit_tokens)
    }
    const cost = costOf(r.model, usage, at)
    const before = Number(r.cost_usd)
    oldTotal += before
    newTotal += cost.costUsd
    if (r.peak) peakBefore++
    if (cost.peak) peakAfter++
    if (r.peak !== cost.peak) peakFixed++

    if (Math.abs(before - cost.costUsd) > 1e-9) {
      changed++
      changedIds.push(Number(r.id))
      if (changed <= 8) {
        console.log(
          `  #${r.id}  ${r.model}`,
          `${beijingParts(at).ymd} ${peakText(at)}`,
          `高峰${r.peak ? '是' : '否'}→${cost.peak ? '是' : '否'}`,
          `${cny(before)} → ${cny(cost.costUsd)}`
        )
      }
      if (write) {
        await query(
          `UPDATE llm_usage
              SET cost_usd = $1, peak = $2, price = $3::jsonb, assumed = $4
            WHERE id = $5`,
          [
            cost.costUsd,
            cost.peak,
            JSON.stringify(cost.price),
            cost.assumed,
            Number(r.id)
          ]
        )
      }
    }
  }

  console.log('')
  console.log(`llm_usage   ${rows.length} 行，其中 ${changed} 行金额有变`)
  console.log(
    `  高峰判定   ${peakBefore} 次 → ${peakAfter} 次（纠正 ${peakFixed} 次）`
  )
  console.log(`  合计花费   ${cny(oldTotal)} → ${cny(newTotal)}`)

  /* ---------------- analyses ---------------- */
  // 分析那行的 cost_usd 是调用时的快照。要同步的是**金额变了的**那些 usage 行
  // 关联的 analyses —— （预览不能拿新旧对比，两边现在都是旧值）
  if (!changedIds.length) {
    console.log('analyses   不用动（没有金额变化的关联行）')
    console.log('')
    return
  }

  const idList = changedIds.join(',')
  if (write) {
    const done = await query<{n: string}>(
      `WITH u AS (
         UPDATE analyses a
            SET cost_usd = l.cost_usd
           FROM llm_usage l
          WHERE a.llm_usage_id = l.id
            AND a.cost_usd IS DISTINCT FROM l.cost_usd
        RETURNING 1)
       SELECT count(*)::text AS n FROM u`
    )
    console.log(`analyses   ${Number(done[0]?.n ?? 0)} 行的 cost_usd 已同步`)
  } else {
    const will = await query<{n: string}>(
      `SELECT count(*)::text AS n
         FROM analyses
        WHERE llm_usage_id IN (${idList})`
    )
    console.log(
      `analyses   ${Number(will[0]?.n ?? 0)} 行会跟着更新（跑 --write 同步）`
    )
    console.log(`  关联的 usage id：${idList}`)
  }
  console.log('')
}

void main()
