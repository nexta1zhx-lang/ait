/**
 * 「从一笔仓位导入知识库」要截**哪一段**行情 —— 纯函数，只放规则。
 *
 * 用户 2026-10-16 的原话：
 *   「这个仓位的截取根据持仓周期来，前面一点，我的持仓范围都要在里面，
 *     然后再包括后面大概 5~6 根走势。这样就能看出我之前开仓是什么情况下开的、
 *     我持仓多久、以及持仓之后那几根又是什么样的。」
 *
 * ⇒ 窗口 = **开仓前 PRE_BARS 根 + 整段持仓 + 平仓后 POST_BARS 根**，
 *    周期按持仓时长换档（`pickTimeframe`）：
 *    拿 5m 看一笔持了两周的仓看不清结构，拿 1d 看一笔持了两小时的仓又只有一根。
 *
 * ⚠️ 单独一个文件（而不是塞在 `knowledge-service.ts` 里）是为了**能被 selftest 直接
 *    import** —— 那个模块一进来就把 db / llm 那一坨全拉起来，夹具没必要背着它跑。
 *    跟 `ask/range.ts` 是同一个理由。
 */
import type {Timeframe} from './types'

/** 开仓前多取几根 —— 「前面一点」，保证看得到开仓那一下之前的蓄势 */
export const POSITION_PRE_BARS = 40
/** 平仓后再看几根（用户：「后面大概 5~6 根走势」） */
export const POSITION_POST_BARS = 6

/**
 * 一笔仓位该用哪个周期来看。
 *
 * 目标是**整段持仓差不多 30~100 根**（4 倍一档），再加上前置 40 / 后置 6，
 * 整段顶天 140 来根 —— 正好在「喂给模型不炸 token」的量级上
 * （`collectCase` 里那条「至少 40 根」的下限也在这个量级）。
 *
 * ⚠️ 档位是**闭区间**：正好 6 小时还是 5m（整段 72 根），
 *    过了 6 小时才换 15m。改边界时 selftest 那组夹具会跟着报。
 */
export function pickTimeframe(holdSec: number): Timeframe {
  const h = Math.max(0, holdSec) / 3600
  if (h <= 6) return '5m'
  if (h <= 24) return '15m'
  if (h <= 4 * 24) return '1h'
  if (h <= 16 * 24) return '4h'
  return '1d'
}

/** 算窗口只用到这两个时间（不用整条 `PositionInput`，夹具好造） */
export interface PositionWindowInput {
  /** 开仓时间（毫秒） */
  openAt: number
  /** 全平时间（毫秒）；**还没平完就是 `null`** */
  closeAt: number | null
}

/**
 * 这一段行情从哪到哪（毫秒，闭区间两端都算进窗口）。
 *
 * ⚠️ **还没平完的仓位右端取「现在」**（`now` 由调用方给，不吃真实时钟 ——
 *    夹具才能固定住）：往未来拉只会拿到空，而后置那几根本来也不存在。
 * ⚠️ 两端都不是「对齐到整根」的：对齐的活儿归交易所 / 取数那层做。
 */
export function positionWindowMs(
  p: PositionWindowInput,
  tfMs: number,
  now: number
): {from: number; to: number} {
  return {
    from: p.openAt - POSITION_PRE_BARS * tfMs,
    to: (p.closeAt ?? now) + POSITION_POST_BARS * tfMs
  }
}
