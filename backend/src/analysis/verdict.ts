/**
 * 「那一句话」的档位 —— 从 AI 的结论里判个粗档，用来：
 *   · 持久化分析的**跨档变化提醒**（观望 → 可做 才值得吵醒你）；
 *   · 时间线里那个色块。
 *
 * ⚠️⚠️ 词表跟 `frontend/src/markdown.ts` 的 `verdictKind()` **必须逐字一致** ——
 *    同一条结论在前端有颜色、在后端也要判成同一档，否则会出现「页面上是绿的、Telegram 说不可做」。
 *    改这里就得改那边（那份的注释里也写了这句）。
 *
 * ★ 历史（别再往回改）：2026-10-15 试过"只看前 260 字"→ 太长会误读；
 *   又试过"全文找、取最早出现的那一类 + 否定前缀判据" —— 复杂且仍有边角漏网。
 *   2026-10-16 用户拍板换成下面这套**粗口径**：短窗口 + 「不」一票否决。
 */
/**
 * **判定口径（2026-10-16 用户定的，就这三条 + 一个短窗口）**：
 *
 *   ① 只看**「结论」那两个字往后的一小段**（最多 20 字，遇到句读就停）；
 *   ② 那段里出现**「不」** ⇒ 不可做（"不该开""不做""没有可做"都算）；
 *   ③ 否则出现**观望 / 观察** ⇒ 观望；出现**开多 / 做多 / 可以做 / 能做 / 进场** ⇒ 可做；
 *      都没有 ⇒ 观望（保守：不发通知）。
 *
 * 为什么是「结论」往后一小段、不是"开头 20 字"：实测 60 条真实回答里，
 * 「结论」出现的位置从**第 2 个字到第 1630 个字**都有 —— 模型有时候先写结论、有时候写在最后
 * （`# BTC/USDT 1h 判断` 开头那批，「结论」在 1400 字之后）。只看开头 20 字会让 7 成的
 * 「不开」被读成"观望"，等于这套提醒永远不响。
 *
 * ⚠️ 为什么「不」一票否决（哪怕它是"不破"）：用户 2026-10-16 的原话是
 *    「如果出现不该不做带不的都把它归为不做」。代价是**条件式放行会被压掉**
 *    （"回踩不破可以做多" ⇒ 判成不可做）。这个方向是**安全**的 —— 少发一条通知，
 *    而不是误发一条"可以做多"的假警报。
 *
 * ⚠️⚠️ 词表 / 窗口 / 优先级，跟 `frontend/src/markdown.ts` 的 `verdictKind()`
 *     **必须逐字一致**（页面上是绿的、Telegram 说不可做，就说明又岔了）。
 */
export type Verdict = 'go' | 'no' | 'wait'

/** 窗口多长（个字符）—— 用户要的「前 20 个字」 */
const WINDOW = 20
/** 遇到这些就停（结论那一句说完了，后面是理由） */
const STOP = /[。！？；，,;]/
/** 「做成」那一类（含条件式「回踩不破可以做多」——它带「不」，按上面那条会被压成不可做） */
const GO_RE = /开多|做多|可以做|能做|可以进|建议进|可以开|进场/
/** 观望那一类 */
const WAIT_RE = /观望|观察/
/**
 * 一票否决：否定词。**别再往里加词** —— 用户要的就是这个粗口径。
 *
 * ⚠️ 带上「没」：用户说的是「带不的都把它归为不做」，按**否定词**理解。
 *    「不」管不着「没有可做的结构」（那里面是「没」，不是「不」）——
 *    而它正是 2026-10-15 那条假警报的原话（"没有可做"被读成可做）。
 *    ⚠️ 顺带一说：判成「观望」和「不可做」**在提醒上是一回事**（都不发通知），
 *       区别只在那块色标和时间线里写什么。
 */
const NO_RE = /不|没/

/** 抹掉 Markdown 记号 + 压成一行（标记会夹在词里，影响找不到「结论」） */
export function plainOf(text: string): string {
  return (text ?? '').replace(/[*_`#>]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 取「结论」往后那一小段 —— 判定只看它。
 *
 * 取不到「结论」（模型没写这两个字）就退回**开头那一段**（老口径）。
 */
export function verdictWindow(text: string): string {
  const plain = plainOf(text)
  const i = plain.indexOf('结论')
  const seg = (i >= 0 ? plain.slice(i + 2) : plain).replace(/^[：:，,、\s]+/, '')
  const cap = seg.slice(0, WINDOW)
  const stop = cap.search(STOP)
  return (stop >= 0 ? cap.slice(0, stop) : cap).trim()
}

export function verdictOf(text: string): Verdict {
  const w = verdictWindow(text)
  if (NO_RE.test(w)) return 'no'
  if (WAIT_RE.test(w)) return 'wait'
  if (GO_RE.test(w)) return 'go'
  return 'wait'
}

/**
 * 值不值得**吵醒你**（弹窗 / Telegram / App 推送）：**只在"转成可做"那一刻**。
 *
 * ★ 2026-10-15 用户定：「只有可做才弹窗和发送 telegram」。
 *   · 观望/不可做 → **可做** ✅ 提醒（第一轮就是可做也提醒 —— 最该知道的那次不能没声）
 *   · 可做 → 走弱/观望/不可做 ❌ 不提醒（"要不要动手"是另一件事）
 *   · 不可做 ↔ 观望 ❌ 不提醒（这俩是一回事，模型换个措辞就翻一次，纯噪音）
 *
 * ⚠️ 前端那份（`frontend/src/markdown.ts` 同名函数）判据必须一样，否则"页面弹了 TG 没弹"。
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
