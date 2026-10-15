/**
 * 「那一句话」的档位 —— 从 AI 的结论里判个粗档，用来：
 *   · 持久化分析的**跨档变化提醒**（观望 → 可做 才值得吵醒你）；
 *   · 时间线里那个色块。
 *
 * ⚠️⚠️ 词表跟 `frontend/src/markdown.ts` 的 `verdictKind()` **必须逐字一致** ——
 *    同一条结论在前端有颜色、在后端也要判成同一档，否则会出现「页面上是绿的、Telegram 说不可做」。
 *    改这里就得改那边（那份的注释里也写了这句）。
 *
 * ★ 2026-10-15 实测修正：原来只看**前 260 字**（当时的假设是"结论一定在最前面"）。
 *   可持久化跑出来的实际回答是**一整篇 Markdown**（`# NIL/USDT 1h 判断` + `## 一、…` 分节），
 *   档位那两个字经常在后面 —— 只扫开头会把"可做"判成"观望"。
 *   现在改成：**抹掉 Markdown 记号、全文找、取最早出现的那一类**；
 *   「不能做」永远赢过它内部包含的「能做」（它出现得更早），所以否定不会被误读。
 */
export type Verdict = 'go' | 'no' | 'wait'

/**
 * 「不可做」那一类（**先判否定**：乐观词常被否定词包着）。
 *
 * ⚠️ 这里**只放硬否决**。像"再等等""先等回踩"那种是**观望**（wait）不是否决 ——
 *    它们跟 wait 本来就同义，混进 NO_RE 只会让 no ↔ wait 来回翻（模型换个说法就翻一次），
 *    而"是否可做"其实没变。见下面的 `enteredGo()`。
 */
const NO_RE = /不能做|不该做|不要做|不建议|不开|不动手|不参与|放弃/
/** 「可做」那一类（含条件式「回踩不破可以做多」—— 那也是他的可做信号） */
const GO_RE = /能做|可以做|可做|可以进|建议进|可以开|进场/

/** 抹掉 Markdown 记号，省得它们夹在词里影响匹配 */
export function plainOf(text: string): string {
  return (text ?? '').replace(/[*_`#>]/g, ' ')
}

export function verdictOf(text: string): Verdict {
  const plain = plainOf(text)
  const no = plain.search(NO_RE)
  const go = plain.search(GO_RE)
  if (no >= 0 && (go < 0 || no <= go)) return 'no'
  if (go >= 0) return 'go'
  return 'wait'
}

/**
 * 值不值得**吵醒你**（推 Telegram / 弹站内）：**只在"转成可做"那一刻**。
 *
 * ★ 2026-10-15 用户定：「只有可做才弹窗和发送 telegram」。
 *   上一版是"进出可做都提醒"（可做 → 走弱也发一条），现在收窄成**只推可做**：
 *   · 观望/不可做 → **可做** ✅ 提醒（这是全部意义所在）
 *   · 第一轮就是可做（`prev` 为 null）✅ **也提醒** —— 不然最该知道的那次反而没声
 *   · 可做 → 走弱/观望/不可做 ❌ 不提醒（"要不要动手"是另一件事，而且模型换个措辞就翻一次）
 *   · 不可做 ↔ 观望 ❌ 不提醒（这俩是一回事，噪音）
 *
 * ⚠️ 前端那份（`frontend/src/persist.ts` 用的 `markdown.ts` 里同名函数）判据必须一样，
 *    否则"页面弹了 Telegram 没弹"。
 */
export function enteredGo(prev: string | null, next: Verdict): boolean {
  return next === 'go' && prev !== 'go'
}

/** 给 Telegram / 日志用的人话（「可做」= 他那套词里最积极的一档） */
export function verdictLabel(v: Verdict): string {
  return v === 'go' ? '可做' : v === 'no' ? '不可做' : '观望'
}

/**
 * 一行摘要（通知里用）：抹掉 Markdown、压掉换行，截到 `max` 字。
 *
 * 为什么不在通知里把整篇发出去：15 分钟就来一篇几千字的 Markdown，Telegram 会被刷屏、
 * 人也不会看 —— 摘要 + 「去页面看时间线」才是对的用法。
 */
export function excerptOf(text: string, max = 160): string {
  const one = plainOf(text).replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}
