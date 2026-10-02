/**
 * 进度步骤（「分析过程」时间线）。
 *
 * 开单分析和案例提炼都用这一套；后端一步步推给前端（SSE），
 * 前端 StepsPanel 也只认这个结构。
 */

/** 分析过程中的一步 */
export interface AnalyzeStep {
  /** 稳定 id，前端拿来匹配 */
  id: string
  /** 显示文案 */
  label: string
  state: 'running' | 'done' | 'error'
  /** 这一步的补充说明（周期、K 线数、token、耗时…） */
  detail?: string
  /** 这一步花了多少毫秒 */
  ms?: number
}

export type OnStep = (step: AnalyzeStep) => void

/**
 * 步骤记录器。
 *
 *   const {steps, start, markFailed} = stepRecorder(onStep)
 *   const end = start('fetch', '拉取行情')
 *   ...
 *   end('200 根')            // 标记完成，自动算耗时
 *   markFailed('fetch', msg) // 这一步炸了，标红
 */
export function stepRecorder(onStep?: OnStep) {
  const emit: OnStep = onStep ?? (() => {})
  const steps: AnalyzeStep[] = []
  /** 每步的起始时间戳 —— markFailed 也要用它算耗时，不能只看闭包里的 */
  const startedAt = new Map<string, number>()

  /** 开一步 → 返回「收尾」函数（自动算耗时并置为 done） */
  const start = (id: string, label: string) => {
    const t0 = Date.now()
    startedAt.set(id, t0)
    const rec: AnalyzeStep = {id, label, state: 'running' as const}
    steps.push(rec)
    emit({...rec})
    return (detail?: string) => {
      rec.state = 'done'
      rec.detail = detail
      rec.ms = Date.now() - t0
      emit({...rec})
    }
  }

  /** 某一步炸了，把它标红（错误本身继续往外抛） */
  const markFailed = (id: string, msg: string) => {
    const rec = steps.find(x => x.id === id)
    if (!rec) return
    rec.state = 'error'
    rec.detail = msg
    // ⚠️ 这里是**耗时**，不是时间戳。
    // 以前写的是 `rec.ms = Date.now()` —— 那是从 1970 数起的豪秒，
    // 前端按秒一除就成了「共 1790907692.6s」。
    const t0 = startedAt.get(id)
    if (t0 !== undefined) rec.ms = Math.max(0, Date.now() - t0)
    emit({...rec})
  }

  return {steps, start, markFailed}
}
