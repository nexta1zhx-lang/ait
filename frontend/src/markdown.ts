/**
 * 极小的 Markdown 子集渲染器 —— 只服务「AI 那一整段自由发挥的回复」。
 *
 * ★ 2026-10-11：用户把提示词的输出格式放开之后，模型改成写小标题 + 分点 + 加粗，
 *   而结论卡片一直是 `white-space: pre-wrap` 的**纯文本** ⇒ 页面上能看到
 *   `#` `**` `-` 这些符号本身。这里把那段文字渲染成 HTML，样式在 `style.css` 的
 *   `.answer-body` 那一节。
 *
 * ⚠️ **为什么自己写、不引 marked / markdown-it**：
 *   · 只用得上「标题 / 加粗 / 列表 / 段落」这几样，模型也不会写别的；
 *   · **先转义、再拼自己那几个标签** ⇒ 模型无论写出什么（`<script>`、`onerror=`）
 *     都只是文字，没有 XSS 面；引库反而多一层要配置的 sanitize；
 *   · 少两个依赖（这是本地小工具，不是发给别人用的库）。
 *
 * 支持：`#`/`##`/`###` 标题 · `-` `*` `1.` 列表 · `**粗体**` · `` `代码` `` ·
 *      `---` 分割线 · `|a|b|` 表格行（退化成「a · b」一行）· 空行分段。
 * **不支持**：图片、链接、HTML 透传、脚注 —— 都不需要，也会带来安全问题。
 */

/** HTML 转义 —— 所有用户/模型文本进 HTML 之前**必须**过这一道 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内：`**粗体**`、``` `` `代码` `` ```。⚠️ 故意不做 `_斜体_` —— 币种名里全是下划线 */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/```([^`]+)```/g, '<code>$1</code>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

const RE_HEAD = /^(#{1,6})\s+(.+?)\s*#*$/
const RE_LIST = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/
const RE_ORDERED = /^\s*\d+[.)]\s+/
const RE_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const RE_TABLE = /^\s*\|(.+)\|\s*$/
const RE_TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/
const RE_FENCE = /^\s*```[A-Za-z0-9+#-]*\s*$/

/** 表格行 → 「a · b · c」（不做真表格：手机上挤，而且模型很少写） */
function tableRow(line: string): string {
  const cells = line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(c => c.trim())
    .filter(Boolean)
  return cells.join(' · ')
}

/**
 * 把一段 Markdown 渲染成**安全的** HTML。
 *
 * @param opts.softBreaks 单个换行也当断行（`<br>`）。默认 `false` = 按标准 Markdown
 *   把连续几行并成一段 —— 但**日记正文是人手写的"一行一句"**，并成一大段就散了，
 *   所以日记那边传 `true`（2026-10-18）。
 */
export function renderMarkdown(text: string, opts: {softBreaks?: boolean} = {}): string {
  const src = (text ?? '').replace(/\r\n?/g, '\n')
  const out: string[] = []
  const lines = src.split('\n')
  let para: string[] = []
  let list: {ordered: boolean; items: string[]} | null = null
  /** 连续表格行（`|a|b|`）攒着一起出，别一行一个段落 */
  let table: string[] = []
  /** ``` 围栏里的原文（原样输出，不做行内解析） */
  let fence: string[] | null = null

  const flushPara = (): void => {
    if (!para.length) return
    out.push(`<p>${inline(para.join(opts.softBreaks ? '\n' : ' ')).replace(/\n/g, '<br>')}</p>`)
    para = []
  }
  const flushList = (): void => {
    if (!list) return
    const tag = list.ordered ? 'ol' : 'ul'
    out.push(
      `<${tag}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${tag}>`
    )
    list = null
  }
  const flushTable = (): void => {
    if (!table.length) return
    // 表头 + `|---|---|`：认出来就把这两行都丢掉（退化成列表之后，列名没意义）
    const rows =
      table.length > 2 && RE_TABLE_SEP.test(table[1] as string)
        ? table.slice(2)
        : table
    out.push('<ul>' + rows.map(r => `<li>${inline(tableRow(r))}</li>`).join('') + '</ul>')
    table = []
  }
  const flushAll = (): void => {
    flushPara()
    flushList()
    flushTable()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (fence) {
      if (RE_FENCE.test(line)) {
        out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`)
        fence = null
      } else {
        fence.push(raw)
      }
      continue
    }

    if (!line.trim()) {
      flushAll()
      continue
    }

    if (RE_FENCE.test(line)) {
      flushAll()
      fence = []
      continue
    }

    if (RE_RULE.test(line)) {
      flushAll()
      out.push('<hr>')
      continue
    }

    const head = RE_HEAD.exec(line)
    if (head) {
      flushAll()
      // `#` / `##` 都当 h3（卡片里不需要更细的层级），`###` 及以下当 h4
      const level = (head[1] as string).length <= 2 ? 3 : 4
      out.push(`<h${level}>${inline(head[2] as string)}</h${level}>`)
      continue
    }

    if (RE_TABLE.test(line)) {
      flushPara()
      flushList()
      table.push(line)
      continue
    }

    const item = RE_LIST.exec(line)
    if (item) {
      flushPara()
      flushTable()
      const ordered = RE_ORDERED.test(line)
      if (!list || list.ordered !== ordered) {
        flushList()
        list = {ordered, items: []}
      }
      list.items.push(item[1] as string)
      continue
    }

    flushList()
    flushTable()
    para.push(line.trim())
  }
  if (fence?.length) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`)
  flushAll()

  return out.join('\n')
}

/**
 * 抹成一行纯文字 —— 给「预测历史」那种**窄地方**用（那里塞不下小标题和分点）。
 * 优先取第一句（到 `。` / `！` / `；` 为止），取不到就整段截断。
 */
export function markdownToPlain(text: string, max = 90): string {
  const plain = (text ?? '')
    .replace(/`{1,3}/g, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const first = plain.split(/(?<=[。！；])/)[0]?.trim() ?? plain
  const one = first.length > 1 ? first : plain
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/**
 * 那一句话的档位 —— 跟后端 `backend/src/analysis/verdict.ts` 的 `verdictOf()`
 * **逐字一致**（同一句话在页面上是绿的、Telegram 说不可做，就说明又岔了）。
 *
 * 口径（2026-10-16 用户定的）：
 *   ① 只看「结论」往后一小段（最多 20 字，遇到句读就停）；
 *   ② 那段里有「不」 ⇒ 不可做（一票否决，用户原话：「带不的都把它归为不做」）；
 *   ③ 否则 观望/观察 ⇒ 观望；开多/做多/可以做/能做/进场 ⇒ 可做；都没有 ⇒ 观望。
 *
 * ⚠️ 「不」一票否决的代价是条件式放行被压掉（"回踩不破可以做多" ⇒ 不可做）——
 *    这是**安全**方向：少发一条通知，而不是误发一条假警报。
 */
const VERDICT_WINDOW = 20
const VERDICT_STOP = /[。！？；，,;]/
const GO_RE = /开多|做多|可以做|能做|可以进|建议进|可以开|进场/
const WAIT_RE = /观望|观察/

/** 「结论」往后那一小段（取不到「结论」就退回开头） */
function verdictWindow(text: string): string {
  const plain = (text ?? '')
    .replace(/[*_`#>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const i = plain.indexOf('结论')
  const seg = (i >= 0 ? plain.slice(i + 2) : plain).replace(/^[：:，,、\s]+/, '')
  const cap = seg.slice(0, VERDICT_WINDOW)
  const stop = cap.search(VERDICT_STOP)
  return (stop >= 0 ? cap.slice(0, stop) : cap).trim()
}

export function verdictKind(text: string): 'go' | 'no' | 'wait' {
  const w = verdictWindow(text)
  /* ⚠️「没」也算（跟后端同一份）：`没有可做的结构` 里没有「不」那个字 */
  if (/不|没/.test(w)) return 'no'
  if (WAIT_RE.test(w)) return 'wait'
  if (GO_RE.test(w)) return 'go'
  return 'wait'
}

/**
 * 值不值得提醒（站内 toast / Telegram）：**只在"转成可做"那一刻**
 *（2026-10-15 用户：「只有可做才弹窗和发送 telegram」）。
 *
 *   · 观望/不可做 → **可做** ✅（第一轮就是可做也提醒）
 *   · 可做 → 走弱/观望 ❌（"要不要动手"是另一件事）
 *   · 不可做 ↔ 观望 ❌（这俩是一回事，模型换个措辞就会翻一次，纯噪音）
 *
 * ⚠️ 跟后端 `backend/src/analysis/verdict.ts` 的 `enteredGo()` **必须逐字一致**，
 *    否则会出现"页面弹了、Telegram 没弹"（同一件事两边判得不一样）。
 */
export function enteredGo(prev: string | null, next: string): boolean {
  return next === 'go' && prev !== 'go'
}
