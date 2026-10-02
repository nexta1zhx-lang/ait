/**
 * 「分析过程」的一小段共用逻辑。
 *
 * 开单分析和案例提炼各有一条步骤流，都需要：
 *   · 同样的 SSE 回调处理（同 id 覆盖，新 id 追加）
 *   · 给「正在进行」的那一步算实时耗时
 */
import {computed, onBeforeUnmount, ref, watch} from 'vue'
import type {AnalyzeStep} from './api'

/** 把后端推来的一步合并进列表：同 id 覆盖，新 id 追加 */
export function mergeStep(list: AnalyzeStep[], step: AnalyzeStep): void {
  const i = list.findIndex(x => x.id === step.id)
  if (i === -1) list.push(step)
  else list[i] = step
}

/** 出错时把还在跑的那一步标红 */
export function failRunning(list: AnalyzeStep[], msg: string): void {
  const running = list.find(x => x.state === 'running')
  if (!running) return
  running.state = 'error'
  running.detail = msg
}

/**
 * 计时：完成看后端给的 ms，进行中按本地时钟现算。
 *
 * 面板自己盯着 `steps`，第一次看见某个 id 处于 running 就记下那一刻 ——
 * 这样纯展示组件也能显示「这一步已经跑了 1.3s」。
 */
export function useStepClock(steps: () => AnalyzeStep[]) {
  const now = ref(Date.now())
  const runStart = ref(Date.now())
  const startedAt = new Map<string, number>()
  const timer = window.setInterval(() => (now.value = Date.now()), 200)
  onBeforeUnmount(() => window.clearInterval(timer))

  watch(
    steps,
    list => {
      const alive = new Set<string>()
      for (const s of list) {
        alive.add(s.id)
        if (s.state === 'running' && !startedAt.has(s.id)) {
          startedAt.set(s.id, Date.now())
        }
      }
      // 新一轮跑（id 全换了）就重算基准时间
      if (!list.some(s => startedAt.has(s.id))) runStart.value = Date.now()
      for (const k of [...startedAt.keys()])
        if (!alive.has(k)) startedAt.delete(k)
    },
    {deep: true, immediate: true}
  )

  /** 某一步花了多少毫秒 */
  function msOf(s: AnalyzeStep): number {
    void now.value
    if (s.state !== 'running') {
      const m = Number(s.ms)
      // 防呆：万一哪一步给的 ms 是**时间戳**而不是耗时（历史上出过这个
      // bug），别在前端显示成「1790907692.6s」。超过一天就当没有。
      return Number.isFinite(m) && m >= 0 && m < 86_400_000 ? m : 0
    }
    return Math.max(0, now.value - (startedAt.get(s.id) ?? runStart.value))
  }

  /** 一条流程一共花了多少毫秒 */
  const totalMs = computed(() => {
    void now.value
    return steps().reduce((sum, s) => sum + msOf(s), 0)
  })

  /** 显示用：小于 1 秒写 ms，否则写 s */
  function msText(ms: number): string {
    if (!ms) return ''
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
  }

  /** 总耗时文本：不到 1 秒也要有个数（别显示成空） */
  const totalText = computed(() => msText(totalMs.value) || '0ms')

  return {msOf, msText, totalMs, totalText}
}
