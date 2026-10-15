/**
 * **持久化分析：跑一轮**（2026-10-15 用户：「在 k 线界面顶部加入持久化分析的图标，
 * 点击图标弹窗确定要加入持久化分析，每隔 15 分钟分析一次，最长不超过 8 小时」）。
 *
 * 调度长这样（**一个 ticker + 库里的 `next_at`**，不给每个会话起定时器）：
 *
 *   server.ts 每 15 分钟（对齐 :00/:15/:30/:45 后 20 秒）调 `runPersistTick()`
 *     → 过期会话先收掉（满 8 小时）
 *     → 取 `next_at <= now` 的会话，逐个跑（并发上限交给调用方/库里的 limit）
 *     → 每个会话：runAnalysis({source:'persist'}) → 记结果 → 推进 next_at
 *     → 结论**转成可做**才推 Telegram + 页面上提示（用户 2026-10-15：「只有可做才弹窗和发送 telegram」）
 *
 * 为什么错过的轮次**不补**：补跑等于一次烧好几发，而且"那一刻"的行情已经过去了 ——
 * 那一轮的意义本来就是"当时问 AI 一句"。重启后直接从当前时刻接上。
 *
 * 为什么口径在会话里冻结（symbol/timeframe/days 都不跟页面变）：同一会话的那 32 条结论
 * 得是**同一把尺子**才能横向比；页面上换周期不该把半个会话换掉。
 */
import {runAnalysis} from './run'
import {
  enteredGo,
  excerptOf,
  verdictLabel,
  verdictOf,
  type Verdict
} from './verdict'
import {sendTelegram} from '../notify/telegram'
import {
  MAX_CONSECUTIVE_FAILURES,
  dueSessions,
  expireSessions,
  markFailure,
  markRun,
  nextRunAt,
  type PersistSession
} from '../db/persist'
import type {MarketType, Timeframe} from '../types'

/** 一轮的结果，给日志/测试用 */
export interface PersistRunResult {
  sessionId: number
  symbol: string
  ok: boolean
  verdict: Verdict | null
  /** 这次转成了「可做」（该提醒了） */
  alerted: boolean
  /** 昨天那条档位（变了才有） */
  previousVerdict: string | null
  price: number | null
  error?: string
}

/**
 * 跑一个会话的一轮。
 *
 * `runs` 只在**成功**时 +1（失败的一轮不算"问过一次"），但 `next_at` 无论成败都往前推：
 * 别让一个坏会话卡在队首每 15 分钟重试到天亮。
 */
export async function runSessionOnce(
  s: PersistSession
): Promise<PersistRunResult> {
  try {
    const out = await runAnalysis({
      userId: s.userId,
      symbol: s.ccxtSymbol,
      market: s.marketType as MarketType,
      timeframe: s.timeframe as Timeframe,
      days: s.days,
      // 不带 at：问的就是"到现在为止"。测试点只属于人工测试跑。
      source: 'persist'
    })
    const line = out.judge.line.trim()
    const verdict = verdictOf(line)
    /* 只在**转成可做**时提醒（见 verdict.ts 的 `enteredGo`） */
    const alerted = enteredGo(s.lastVerdict, verdict)
    await markRun({
      id: s.id,
      runs: s.runs + 1,
      nextAt: nextRunAt(),
      analysisId: null,
      verdict,
      line,
      price: out.price
    })
    /* 到点收尾（8 小时）交给 expireSessions；这里只保 32 次之后不再跑 */
    if (alerted) {
      /*
       * ⚠️ 只发**一行摘要**，不发整篇：实测模型给的是一整篇 Markdown（几千字），
       *    15 分钟来一篇会把 Telegram 刷屏。完整结论在页面的时间线里看。
       */
      void sendTelegram(
        `📈 持久化分析 · ${s.symbol} ${s.timeframe}\n` +
          `结论转可做：${s.lastVerdict ? `${verdictLabel(s.lastVerdict as Verdict)} → ` : ''}` +
          `${verdictLabel(verdict)}\n` +
          `${excerptOf(line, 160)}\n` +
          `现价 ${out.price} · 第 ${s.runs + 1} 次（共最多 32 次）`
      )
    }
    return {
      sessionId: s.id,
      symbol: s.symbol,
      ok: true,
      verdict,
      alerted,
      previousVerdict: s.lastVerdict,
      price: out.price
    }
  } catch (e) {
    const failed = s.failed + 1
    const state = await markFailure({id: s.id, failed})
    const msg = (e as Error).message
    console.warn(
      `[persist] ${s.symbol} 第 ${s.runs + 1} 轮失败（连续 ${failed}/${MAX_CONSECUTIVE_FAILURES}）：${msg}`
    )
    if (state === 'paused') {
      void sendTelegram(
        `⚠️ 持久化分析已暂停 · ${s.symbol} ${s.timeframe}\n` +
          `连续 ${failed} 次失败，最后一次：${msg.slice(0, 160)}`
      )
    }
    return {
      sessionId: s.id,
      symbol: s.symbol,
      ok: false,
      verdict: null,
      alerted: false,
      previousVerdict: s.lastVerdict,
      price: null,
      error: msg
    }
  }
}

/**
 * 调度器的一跳：收掉到期的 + 跑所有该跑的。
 *
 * @param limit 这一跳最多跑几个会话（防一次打爆上游和钱包）
 */
export async function runPersistTick(limit = 5): Promise<PersistRunResult[]> {
  const expired = await expireSessions()
  if (expired) console.log(`[persist] ${expired} 个会话满 8 小时，已收尾`)
  const due = await dueSessions(limit)
  if (!due.length) return []
  const out: PersistRunResult[] = []
  for (const s of due) {
    // 逐个跑（不并发）：上游权重 + 模型限流都不喜欢同时打五发
    out.push(await runSessionOnce(s))
  }
  const ok = out.filter(o => o.ok).length
  console.log(
    `[persist] 这一跳跑了 ${out.length} 个会话（成功 ${ok}，失败 ${out.length - ok}）` +
      (out.some(o => o.alerted) ? ' · 有转可做（已提醒）' : '')
  )
  return out
}
