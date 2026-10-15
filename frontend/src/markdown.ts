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

/** 把一段 Markdown 渲染成**安全的** HTML */
export function renderMarkdown(text: string): string {
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
    out.push(`<p>${inline(para.join(' '))}</p>`)
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
 * 「它到底说能做还是不能做」—— **只看开头那一段**，纯给卡片定个颜色用。
 *
 * ⚠️ 这是个**展示**用的粗判，不参与任何判断；判错了只是颜色不对。
 *   顺序要紧：先找「不做」类词，再找「能做」类词 —— 否则
 *   「等回踩不破再做」这种句子会被算成「能做」。
 */
export function verdictKind(text: string): 'go' | 'no' | 'wait' {
  /*
   * ⚠️ 判据跟后端 `backend/src/analysis/verdict.ts` 的 `verdictOf()` **逐字一致**
   *    （持久化分析的时间线用后端那一份染色、这里给结论卡染色，两处颜色必须一样）。
   *
   * ★ 2026-10-15 修：原来只扫**前 260 字**（假设"结论一定在最前面"）。可模型经常给一整篇
   *    Markdown（标题 + 分节），档位那两个字在后面 ⇒ 明明"可做"却被染成"观望"。
   *    现在：抹掉 Markdown 记号、**全文找**、取最早出现的那一类。
   *    「不能做」比它内部包含的「能做」出现得更早，所以否定不会被误读。
   */
  const plain = (text ?? '').replace(/[*_`#>]/g, ' ')
  /*
   * ⚠️ 「再等 / 先等」**不在**否决词表里：那是观望（wait），跟 wait 同义，
   *    混进去只会让 no ↔ wait 来回翻 —— 见 `crossedActionable()` 那段。
   */
  const no = plain.search(/不能做|不该做|不要做|不建议|不开|不动手|不参与|放弃/)
  const go = plain.search(/能做|可以做|可做|可以进|建议进|可以开|进场/)
  if (no >= 0 && (go < 0 || no <= go)) return 'no'
  if (go >= 0) return 'go'
  return 'wait'
}

/**
 * 值不值得提醒（站内 toast / Telegram）：**只看「可做」这一档的进出**。
 *
 * 不可做 ↔ 观望 不提醒 —— 这俩在"要不要动手"上是一回事，模型每次换个说法就会翻一次，
 * 32 次能弹十几次，纯噪音。
 *
 * ⚠️ 跟后端 `backend/src/analysis/verdict.ts` 的 `crossedActionable()` **必须一致**，
 *    否则会出现"页面弹了、Telegram 没弹"（同一件事两边判得不一样）。
 */
export function crossedActionable(prev: string | null, next: string): boolean {
  if (!prev) return false
  return (prev === 'go') !== (next === 'go')
}
