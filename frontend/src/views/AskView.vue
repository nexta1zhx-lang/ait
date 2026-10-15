<script setup lang="ts">
/**
 * 「我的 → 数据问答」（2026-10-16）。
 *
 * 布局照主流聊天应用那套（用户 2026-10-16：「界面要和现有市场上的类似，
 * 左侧聊天历史，可折叠」）：**左边历史栏 + 右边对话**，历史栏能收起来。
 *   · 宽屏：历史栏常驻，收起来后顶栏留一颗 ☰ 随时叫回来；
 *   · 窄屏：历史栏是**抽屉**（盖在内容上 + 遮罩），点一条会话自动收回去 ——
 *     窄屏底栏是固定的悬浮层，常驻侧栏会把对话挤得没法看。
 * 折叠状态记在 `../ask.ts`（localStorage），切页面回来还是上次那样。
 *
 * 模型能做的只有「选工具 + 给参数」，工具和 SQL 写死在
 * `backend/src/ask/tools.ts`（12 个：预测历史 / 知识库 / 日线 / 用量 / 持久化 /
 * 成交 / 盈亏 / 流水 / 资产 / 挂单 / C2C）。
 *
 * 两条刻意的取舍：
 *  ① **「取值过程」摊开摆**（工具中文名 + 区间 + 行数 + 耗时，流式下一条条长出来）。
 *     数据类问答的信任成本全在这儿 —— 藏起来用户没法判断结论是不是真查出来的。
 *  ② **没查库就答要标出来**（`unverified`）：后端判的，那多半是模型在编。
 */
import {computed, nextTick, onMounted, ref, watch} from 'vue'
import AnswerBody from '../comps/AnswerBody.vue'
import {
  ask,
  askBusy,
  activeThread,
  activeTurns,
  closeSideQuietly,
  deleteThread,
  loadAsk,
  newThread,
  selectThread,
  sideOpen,
  threadGroups,
  toggleSide,
  type AskExchange
} from '../ask'

/** 建议问题 —— 每个都能落到那 12 个工具里的一个 */
const SUGGEST = [
  '最近 30 天我做了多少单？',
  '最近 7 天的分析里「可做」占多少？',
  '我这周做了哪些单？赚了还是亏了？',
  '我现在有多少钱、什么仓？',
  '知识库里我关于 BTC 总结过什么？',
  '我这个月花了多少 AI 费用？'
]

const draft = ref('')
/** 哪几轮摊开了「取值过程」（key = 会话 id + 轮次下标） */
const open = ref<Set<string>>(new Set())
const msgs = ref<HTMLElement | null>(null)
const tail = ref<HTMLElement | null>(null)

onMounted(loadAsk)

function keyOf(i: number): string {
  return `${activeThread.value?.id ?? ''}#${i}`
}
function toggle(i: number): void {
  const k = keyOf(i)
  const next = new Set(open.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  open.value = next
}
function isOpen(i: number): boolean {
  return open.value.has(keyOf(i))
}

/**
 * 滚到底。
 *
 * ⚠️ 滚动容器是**这里**的 `.msgs`（不是 `PaneShell` 的 `.tabpane-body`）——
 *    这一格在 `MeView` 里把外层滚动关掉了（`overflow: hidden`），
 *    否则「左侧固定 + 右侧滚动」这套布局做不出来。
 */
async function toBottom(smooth = true): Promise<void> {
  await nextTick()
  const box = msgs.value
  if (box) box.scrollTo({top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto'})
  else tail.value?.scrollIntoView({block: 'end'})
}

/**
 * 流式期间的自动跟随。
 *
 * ⚠️ 只在**用户本来就在底部附近**时才跟 —— 否则他想回头看上一段，一行行新字会把他
 *    一直往下拽（主流的聊天应用也是这个行为）。
 * ⚠️ 节流 200ms：delta 是逐字的，每个字都滚一次会把主线程占满。
 */
let followTimer: number | null = null
function follow(): void {
  if (followTimer) return
  followTimer = window.setTimeout(() => {
    followTimer = null
    const box = msgs.value
    if (!box) return
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 200) void toBottom()
  }, 200)
}

watch(
  () => activeTurns.value.at(-1)?.answer.length ?? 0,
  () => {
    if (askBusy.value) follow()
  }
)
watch(
  () => activeTurns.value.at(-1)?.steps.length ?? 0,
  () => follow()
)
// 换会话：跳到底（不带动画，省得像"滚过去"）。
// ⚠️ **别在这里收抽屉** —— 这个 watcher 在**挂载那一刻**也会触发
//    （`loadAsk()` 把 `activeId` 从 '' 变成存的那条），一进来就把抽屉关了，
//    表现是「一进这一格左侧历史就没了、只剩一颗 ☰」（2026-10-16 踩过）。
//    收抽屉是**用户点了某一条**才做的事，写在点击处理里（`pickThread`）。
watch(
  () => activeThread.value?.id,
  () => {
    open.value = new Set()
    void toBottom(false)
  }
)

/** 窄屏：抽屉是盖在对话上的，选完得把它收走（**不记**，见 `closeSideQuietly`） */
function closeDrawerOnNarrow(): void {
  if (window.innerWidth <= 900) closeSideQuietly()
}

function pickThread(id: string): void {
  selectThread(id)
  closeDrawerOnNarrow()
}

function startNewThread(): void {
  newThread()
  closeDrawerOnNarrow()
}

async function send(): Promise<void> {
  const q = draft.value.trim()
  if (!q || askBusy.value) return
  draft.value = ''
  const i = activeTurns.value.length
  open.value = new Set([...open.value, `${activeThread.value?.id ?? ''}#${i}`])
  await ask(q)
  void toBottom()
}

async function again(t: AskExchange): Promise<void> {
  if (askBusy.value) return
  await ask(t.question)
  void toBottom()
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/** 参数写成一行给人看（值都短，直接摆） */
function argText(args: Record<string, unknown>): string {
  return Object.entries(args ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
}

/** 左侧那条会话的「什么时候」—— 今天的只写时间，其余写日期 */
function whenText(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})
    : d.toLocaleDateString('zh-CN', {month: '2-digit', day: '2-digit'})
}

const title = computed(() => activeThread.value?.title || '数据问答')
</script>

<template>
  <div class="ask" :class="{'side-open': sideOpen}">
    <!-- ── 右侧：对话 ── -->
    <div class="main">
      <div class="bar">
        <button
          type="button"
          class="icon"
          :title="sideOpen ? '收起历史' : '展开历史'"
          :aria-label="sideOpen ? '收起历史' : '展开历史'"
          @click="toggleSide()"
        >
          ☰
        </button>
        <span class="bar-title">{{ title }}</span>
        <span class="bar-sub">{{ activeTurns.length }} 轮</span>
      </div>

      <!--
        ⚠️ 这一层（`.body`）是**抽屉的定位上下文**，它包住「消息 + 输入框」——
           所以窄屏的抽屉能一路盖到输入框上方（模态层该有的样子）。
           用户 2026-10-16：「层级不对」= 上一版抽屉只盖消息区、输入框（fixed）
           又画在它上面，看起来像输入框浮在侧栏上。
      -->
      <div class="body">
        <!-- ── 左侧：历史会话（宽屏并排 / 窄屏盖在整层上） ── -->
        <aside class="side">
          <div class="side-head">
            <button type="button" class="new-chat" @click="startNewThread">
              <span class="plus">＋</span> 开启新对话
            </button>
            <button
              type="button"
              class="fold"
              title="收起"
              aria-label="收起历史"
              @click="toggleSide(false)"
            >
              ‹
            </button>
          </div>

          <div class="side-list">
            <template v-for="g in threadGroups" :key="g.label">
              <div class="side-group">{{ g.label }}</div>
              <div
                v-for="t in g.items"
                :key="t.id"
                class="side-item"
                :class="{active: t.id === activeThread?.id}"
              >
                <button type="button" class="side-pick" @click="pickThread(t.id)">
                  <span class="side-title">{{ t.title }}</span>
                  <span class="side-when">{{ whenText(t.updatedAt) }}</span>
                </button>
                <button
                  type="button"
                  class="side-del"
                  title="删除这个对话"
                  aria-label="删除"
                  @click.stop="deleteThread(t.id)"
                >
                  ✕
                </button>
              </div>
            </template>
            <div v-if="!threadGroups.length" class="side-empty">
              还没有对话<br />问一句就建一个
            </div>
          </div>
        </aside>

        <!-- 窄屏抽屉的遮罩（只盖这一层；宽屏用 CSS 藏掉） -->
        <div v-if="sideOpen" class="scrim" @click="toggleSide(false)" />

        <div class="col">
          <div ref="msgs" class="msgs">
          <!-- 空会话：说明它能查什么 + 几句能直接点的 -->
          <section v-if="!activeTurns.length" class="panel lead">
            <p class="hint">
              问你自己库里的数据 —— <b>预测历史 / 知识库 / 日线行情 / 成交 / 盈亏 /
              资金流水 / 资产持仓 / 挂单 / C2C / AI 用量 / 持久化跟踪</b>。
              它只会查这些，查不到会直说，不会编。
            </p>
            <div class="chips">
              <button
                v-for="s in SUGGEST"
                :key="s"
                type="button"
                class="chip"
                :disabled="askBusy"
                @click="draft = s"
              >
                {{ s }}
              </button>
            </div>
          </section>

          <section v-for="(t, i) in activeTurns" :key="i" class="panel turn">
            <div class="q">{{ t.question }}</div>

            <!-- 还没有第一个字：告诉用户它在干什么（连第几轮都摆出来） -->
            <div v-if="t.streaming && !t.answer && !t.error" class="live">
              <span class="dot" />
              正在查库{{ t.round ? `…第 ${t.round}/${t.roundMax} 轮` : '…' }}
            </div>

            <AnswerBody v-if="t.answer" :text="t.answer" />
            <!-- 逐字长出来的那段末尾挂个光标，一眼看出还在写 -->
            <div v-if="t.streaming && t.answer" class="caret" />
            <div v-if="t.error" class="error box">{{ t.error }}</div>

            <div class="foot">
              <button
                type="button"
                class="mini"
                :disabled="!t.steps.length"
                @click="toggle(i)"
              >
                {{ isOpen(i) ? '收起' : '取值过程' }}
                <template v-if="t.steps.length"> · {{ t.steps.length }} 步</template>
              </button>
              <!-- 没查库就答 —— 后端判的，必须显眼 -->
              <span v-if="t.unverified && t.answer" class="tag bad">没查库</span>
              <span v-if="t.latencyMs" class="tag">{{ secs(t.latencyMs) }}</span>
              <span v-if="t.costUsd" class="tag">${{ t.costUsd.toFixed(4) }}</span>
              <button
                type="button"
                class="mini ghost"
                :disabled="askBusy"
                @click="again(t)"
              >
                再问一次
              </button>
            </div>

            <ol v-if="isOpen(i) && t.steps.length" class="steps">
              <li v-for="(s, j) in t.steps" :key="j" :class="{bad: !s.ok}">
                <div class="st-head">
                  <b>{{ s.label }}</b>
                  <span class="st-ms">{{ s.rows }} 行 · {{ s.ms }}ms</span>
                </div>
                <div v-if="argText(s.args)" class="st-args">{{ argText(s.args) }}</div>
                <div class="st-detail">{{ s.detail }}</div>
              </li>
            </ol>
          </section>

          <div ref="tail" class="tail" />
          </div>

          <form class="composer" @submit.prevent="send">
            <textarea
              v-model="draft"
              rows="1"
              placeholder="问点你自己库里的数据…"
              :disabled="askBusy"
              @keydown.enter.exact.prevent="send"
            />
            <button
              type="submit"
              class="send"
              :disabled="askBusy || !draft.trim()"
            >
              {{ askBusy ? '查询中' : '发送' }}
            </button>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 整格是一屏（不是长文档）：消息区自己滚，输入框钉在最底下。
 * 外层滚动在 `MeView` 里关掉了、并把它变成了 flex 容器
 *（`.tabpane.ask-pane :deep(.tabpane-body) { display: flex; overflow: hidden }`），
 * 这里靠 `flex: 1 1 auto` **被拉伸**到满高 —— **别改成 `height: 100%`**，
 * 百分比高度在那种父级下撑不起来（实测踩过：整格只有内容那么高）。
 */
.ask {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/*
 * 消息区 + 输入框那一层：**左侧历史栏定位在它里面**。
 *
 * ⚠️ 这一层是抽屉的定位上下文，包住「消息 + 输入框」—— 所以窄屏抽屉能盖住输入框
 *   （模态层该有的样子）。用户 2026-10-16：「层级不对」：上一版抽屉只盖消息区、
 *   而输入框是 `fixed` 又画在抽屉上面，看着像输入框浮在侧栏上。
 * ⚠️ 宽屏时它是 `flex` 行：历史栏是并排的一列（那时消息被挤窄是正常的，
 *   主流聊天应用都这样）；窄屏时历史栏改绝对定位、盖在这一层上。
 */
.body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  gap: 10px;
}

/* 消息 + 输入框那一列 */
.col {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ── 左侧历史 ── */
.side {
  flex: 0 0 232px;
  width: 232px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--panel);
  padding: 8px;
  overflow: hidden;
}
.side-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.new-chat {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12.5px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  transition: border-color 0.15s;
}
.new-chat:hover {
  border-color: var(--accent-line);
}
.plus {
  color: var(--accent);
  font-size: 14px;
}
.fold {
  flex: 0 0 auto;
  width: 30px;
  padding: 8px 0;
  font-size: 15px;
  line-height: 1;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: none;
  color: var(--muted);
}
.fold:hover {
  color: var(--text);
  border-color: var(--accent-line);
}

.side-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.side-group {
  padding: 8px 8px 4px;
  font-size: 10.5px;
  color: var(--muted);
  letter-spacing: 0.02em;
}
.side-item {
  display: flex;
  align-items: center;
  border-radius: var(--r-sm);
}
.side-item.active {
  background: var(--accent-soft);
}
.side-pick {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 7px 8px;
  background: none;
  color: var(--muted);
  text-align: left;
}
.side-item.active .side-pick,
.side-pick:hover {
  color: var(--text);
}
.side-title {
  max-width: 100%;
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.side-when {
  font-size: 10px;
  color: var(--muted);
}
.side-del {
  flex: 0 0 auto;
  padding: 6px 8px;
  background: none;
  color: var(--muted);
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.15s;
}
/*
 * 删除按钮：桌面悬停才露；**触屏没有 hover**，所以 @media (hover: none) 里常显
 *（跟 `style.css` 里那套 hover 规则同一个判据 —— 否则手机上永远删不掉）。
 */
.side-item:hover .side-del,
.side-item.active .side-del {
  opacity: 0.7;
}
.side-del:hover {
  opacity: 1;
  color: #ff9b98;
}
@media (hover: none) {
  .side-del {
    opacity: 0.6;
  }
}
.side-empty {
  padding: 14px 10px;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  line-height: 1.7;
}
/* 收起：整个左栏不占位（☰ 在顶栏） */
.ask:not(.side-open) .side {
  display: none;
}

.scrim {
  display: none;
}

/* ── 右侧对话 ── */
.main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 8px;
}
.icon {
  flex: 0 0 auto;
  width: 32px;
  padding: 6px 0;
  font-size: 14px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: none;
  color: var(--muted);
}
.icon:hover {
  color: var(--text);
  border-color: var(--accent-line);
}
.bar-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: var(--fw-mid, 500);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-sub {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted);
}

.msgs {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
}

/* ── 输入框（钉在右栏底部） ── */
.composer {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding-top: 10px;
}
.composer textarea {
  flex: 1 1 auto;
  resize: none;
  min-height: 42px;
  max-height: 132px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text);
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
}
.composer textarea:focus {
  outline: none;
  border-color: var(--accent-line);
}
.send {
  flex: 0 0 auto;
  padding: 11px 16px;
  font-size: 13px;
  border-radius: var(--r-sm);
}
.send:disabled {
  opacity: 0.5;
}

/* ── 轮次内部（跟之前一样的那些小块） ── */
.lead .hint {
  margin: 0 0 10px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  background: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted);
  padding: 5px 11px;
  font-size: 12px;
  line-height: 1.4;
}
.chip:hover:not(:disabled) {
  border-color: var(--accent-line);
  color: var(--text);
}
.turn .q {
  border-left: 2px solid var(--accent-line);
  padding-left: 10px;
  margin-bottom: 10px;
  font-size: 13.5px;
  font-weight: var(--fw-mid, 500);
  overflow-wrap: anywhere;
}
.box {
  border-radius: var(--r-sm);
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.6;
}
.foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.tag.bad {
  color: #ff9b98;
  border-color: color-mix(in srgb, var(--bad) 45%, transparent);
  background: var(--bad-soft);
}
.mini {
  padding: 4px 10px;
  font-size: 11.5px;
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--muted);
  border: 1px solid var(--border);
}
.mini:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent-line);
}
.mini.ghost {
  background: none;
}
.mini:disabled {
  opacity: 0.45;
}

/* 「取值过程」—— 这是这个功能最该被看见的一栏 */
.steps {
  list-style: none;
  margin: 10px 0 0;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.steps li.bad b {
  color: #ff9b98;
}
.st-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
}
.st-ms {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.st-args {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.st-detail {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* 还没出字时的「正在查库…第 N 轮」 */
.live {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12.5px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: ask-pulse 1.1s ease-in-out infinite;
}
@keyframes ask-pulse {
  0%,
  100% {
    opacity: 0.25;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
/* 流式光标：跟在逐字长出来的回答末尾 */
.caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  margin-top: 2px;
  border-radius: 2px;
  background: var(--accent);
  animation: ask-blink 1s steps(2, start) infinite;
}
@keyframes ask-blink {
  to {
    opacity: 0;
  }
}

/* 滚到底用的哨兵，不占高度 */
.tail {
  height: 1px;
}

/*
 * ── 窄屏：历史栏是**模态抽屉**（盖住整层、含输入框）；输入框钉在底栏正上方 ──
 *
 * ⚠️ 输入框为什么用 `position: fixed` 而不用「flex 撑到底 + padding 避让」：
 *    后者要跟一大串 flex 高度链（`.tabpane-body` → `.ask` → `.main` → `.col`）算账，
 *    实测差了几十像素（用户 2026-10-16：「有间距啊」）。底栏本来就是 `position: fixed`
 *    （`bottom: 8px + 安全区`）—— 用**同一个基准**把它钉在底栏正上方，两个数一减就贴住，
 *    跟外层怎么排没关系。
 * ⚠️ 层级（用户 2026-10-16：「层级不对」）：抽屉 `z-index: 7` > 遮罩 `6` > 输入框 `5`，
 *    所以**抽屉打开时盖住输入框**（模态层的正常行为）；抽屉收起时输入框就是最底下那个。
 */
@media (max-width: 900px) {
  .side {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 7;
    width: 78%;
    max-width: 280px;
    flex-basis: auto;
    background: var(--panel-2);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
    animation: ask-drawer 0.18s ease-out;
  }
  @keyframes ask-drawer {
    from {
      transform: translateX(-12px);
      opacity: 0.4;
    }
  }
  .side-open .scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 6;
    background: rgba(0, 0, 0, 0.42);
    border-radius: var(--r-md);
  }
  .composer {
    position: fixed;
    left: 14px;
    right: 14px;
    /* 底栏悬浮层：`bottom: 8px + 安全区`、高约 51px ⇒ 上沿在 59px 处 */
    bottom: calc(var(--tabbar-h, 59px) + env(safe-area-inset-bottom) + 6px);
    z-index: 5;
    padding: 0;
    background: var(--bg);
  }
  .msgs {
    /* 输入框是 `fixed`（脱离文档流）：消息区自己给它在底部留出高度，
       否则最后一条消息会被压在下面 */
    padding-bottom: 62px;
  }
  /* 窄屏每格都窄，行数那个标签别挤成两行 */
  .bar-sub {
    display: none;
  }
}
</style>
