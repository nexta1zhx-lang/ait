<script setup lang="ts">
/**
 * 「我的 → 个人信息 → 账户信息 → 交易所」。
 *
 * 用户 2026-10-04：「个人信息下添加交易所内容，可以新增交易所和 key，支持多个」。
 *
 * 能绑**多套**交易所 API Key（各自起名 / 选交易所 / 选现货还是合约），
 * 其中一套是「默认」——「我的 → 交易所账户」那格默认用它。
 *
 * ⚠️ 真 Key / Secret **不回前端**：列表里显示的是掩码（`abcd****wxyz`），
 *    编辑时也只回显掩码；不改就原样回传，后端认得出掩码、不覆盖。
 *
 * 权限怎么开：只是**看**余额 / 持仓 / 订单 —— 读权限就够；
 * 要用「开单分析 → K 线」底部那个**下单模块**（2026-10-05 加），
 * 得再勾上**合约交易**权限（模块本身走的是币安的测试接口，不会真成交），
 * 并且要在「API 限制 IP」里放行服务器出口 IP —— 不然会一直报 `-2015`。
 */
import {onBeforeUnmount, onMounted, ref} from 'vue'
import {
  createExchangeKey,
  deleteExchangeKey,
  fetchExchangeKeys,
  reorderExchangeKeys,
  setDefaultExchangeKey,
  updateExchangeKey,
  type ExchangeCatalogEntry,
  type ExchangeKey
} from '../api'
import {askConfirm} from '../confirm'
import {loadTradeKeys} from '../trade-account'

const keys = ref<ExchangeKey[]>([])
const catalog = ref<ExchangeCatalogEntry[]>([])
/** 最多能绑几套（后端回的；拿不到就按 4 兜底） */
const max = ref(4)
const loading = ref(false)
const error = ref('')
const msg = ref('')

/* ------------------------- 新增 / 编辑表单 ------------------------- */

const formOpen = ref(false)
/** null = 新增；数字 = 正在改哪一套 */
const editingId = ref<number | null>(null)
const fExchange = ref('binance')
const fName = ref('')
const fApiKey = ref('')
const fSecret = ref('')
const fPassword = ref('')
const fMarketType = ref('swap')
const fSandbox = ref(false)
const saving = ref(false)

function labelOf(id: string): string {
  return catalog.value.find(c => c.id === id)?.label ?? id
}

function flash(text: string): void {
  msg.value = text
  window.setTimeout(() => {
    if (msg.value === text) msg.value = ''
  }, 3000)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await fetchExchangeKeys()
    keys.value = r.keys
    catalog.value = r.exchanges
    if (r.max) max.value = r.max
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/* ---------------- 拖拽排序（用户 2026-10-10） ---------------- */

/*
 * 为什么用 Pointer Events 而不是 HTML5 拖放：这套界面主要跑在 Android WebView（APK）里，
 * HTML5 的 drag & drop 在触摸上收不到事件。Pointer Events 一套代码鼠标 / 触摸都能用，
 * 而且拖动时列表能实时跟着换位（看得见落点）。
 */
/** 列表容器（算落点用） */
const listEl = ref<HTMLElement | null>(null)
/** 正在拖第几行（-1 = 没在拖） */
const dragFrom = ref(-1)
/** 这一轮拖拽有没有真的换过位置（没换就别白打一次接口） */
let dragChanged = false

/** 光标压到哪一行就换到那里 */
function moveTo(clientY: number): void {
  const el = listEl.value
  if (!el || dragFrom.value < 0) return
  const rows = [...el.querySelectorAll<HTMLElement>('li')]
  if (rows.length < 2) return
  // 落在最后一行下面 → 排到最后
  let to = rows.findIndex(r => clientY < r.getBoundingClientRect().bottom)
  if (to < 0) to = rows.length - 1
  if (to === dragFrom.value) return
  const arr = [...keys.value]
  const moved = arr.splice(dragFrom.value, 1)[0]
  if (!moved) return
  arr.splice(to, 0, moved)
  keys.value = arr
  dragFrom.value = to
  dragChanged = true
}

function onPointerMove(e: PointerEvent): void {
  e.preventDefault()
  moveTo(e.clientY)
}

function endDrag(): void {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  const from = dragFrom.value
  const changed = dragChanged
  dragFrom.value = -1
  dragChanged = false
  if (from < 0 || !changed) return
  void saveOrder()
}

function startDrag(e: PointerEvent, i: number): void {
  // 鼠标只认左键
  if (e.pointerType === 'mouse' && e.button !== 0) return
  // 挡掉长按选中 / 原生图片拖拽（不然手指一拖会变成选文字）
  e.preventDefault()
  dragFrom.value = i
  dragChanged = false
  window.addEventListener('pointermove', onPointerMove, {passive: false})
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
}

onBeforeUnmount(endDrag)

/** 把拖完的顺序落库；失败就把列表还原成服务端那份（别留一个假顺序） */
async function saveOrder(): Promise<void> {
  const ids = keys.value.map(k => k.id)
  error.value = ''
  try {
    await reorderExchangeKeys(ids)
    flash('顺序已保存')
    // 别的页面（交易所账户 / 账户统计 / 配置里选下单账户）读的是同一份缓存，顺手刷新
    void loadTradeKeys(true)
  } catch (e) {
    error.value = (e as Error).message
    await load()
  }
}

function openAdd(): void {
  // 满了就别开表单了（按钮那边也会禁用，这里是第二道）
  if (keys.value.length >= max.value) {
    flash(`最多 ${max.value} 套 —— 先删掉一套再加`)
    return
  }
  editingId.value = null
  fExchange.value = catalog.value[0]?.id ?? 'binance'
  fName.value = ''
  fApiKey.value = ''
  fSecret.value = ''
  fPassword.value = ''
  fMarketType.value = 'swap'
  fSandbox.value = false
  error.value = ''
  formOpen.value = true
}

function openEdit(k: ExchangeKey): void {
  editingId.value = k.id
  fExchange.value = k.exchange
  fName.value = k.name
  // 回显掩码：不动它 = 不覆盖
  fApiKey.value = k.apiKey
  fSecret.value = k.secret
  fPassword.value = k.password
  fMarketType.value = k.marketType
  fSandbox.value = k.sandbox
  error.value = ''
  formOpen.value = true
}

function closeForm(): void {
  formOpen.value = false
  editingId.value = null
}

async function save(): Promise<void> {
  if (saving.value) return
  error.value = ''
  const creating = editingId.value === null
  if (creating && (!fApiKey.value.trim() || !fSecret.value.trim())) {
    error.value = '新增时要填 API Key 和 Secret'
    return
  }
  saving.value = true
  try {
    const body = {
      exchange: fExchange.value,
      name: fName.value.trim(),
      apiKey: fApiKey.value.trim(),
      secret: fSecret.value.trim(),
      password: fPassword.value.trim(),
      marketType: fMarketType.value,
      sandbox: fSandbox.value
    }
    if (creating) await createExchangeKey(body)
    else await updateExchangeKey(editingId.value as number, body)
    closeForm()
    flash(creating ? '已新增' : '已保存')
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function makeDefault(k: ExchangeKey): Promise<void> {
  if (k.isDefault) return
  error.value = ''
  try {
    await setDefaultExchangeKey(k.id)
    flash('已设为默认')
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

async function remove(k: ExchangeKey): Promise<void> {
  const ok = await askConfirm({
    title: `删除「${k.name || labelOf(k.exchange)}」这套账户？`,
    body: {t: '删掉之后要重新填 API Key / Secret 才能再用。', tone: 'warn'},
    okText: '删除',
    danger: true
  })
  if (!ok) return
  error.value = ''
  try {
    await deleteExchangeKey(k.id)
    flash('已删除')
    if (editingId.value === k.id) closeForm()
    await load()
  } catch (e) {
    error.value = (e as Error).message
  }
}

onMounted(load)
</script>

<template>
  <section class="panel exch">
    <h2>
      交易所
      <small v-if="keys.length">共 {{ keys.length }} / {{ max }} 套</small>
    </h2>
    <p class="note">
      绑定交易所 API Key 后，「我的 → 交易所账户」那格就能看余额和订单历史。
      只看着数用<b>只读权限</b>就够；要在 K 线页底部<b>下单</b>（测试单，不会真成交），
      得再勾上<b>合约交易</b>权限、并把服务器出口 IP 加进「API 限制 IP」。
      <br />
      最多绑 {{ max }} 套；<b>按住右边的 ⠿ 拖动</b>可以调顺序，各页的账户 tab 都按这个顺序排。
    </p>

    <p v-if="loading" class="dim">载入中…</p>

    <ul v-else ref="listEl" class="rows">
      <li
        v-for="(k, i) in keys"
        :key="k.id"
        :class="{on: k.isDefault, dragging: dragFrom === i}"
      >
        <div class="r-main">
          <b>{{ k.name || '（未命名）' }}</b>
          <span class="badge">{{ labelOf(k.exchange) }}</span>
          <span class="badge soft">
            {{ k.marketType === 'spot' ? '现货' : '合约' }}
          </span>
          <span v-if="k.sandbox" class="badge soft">沙盒</span>
          <span v-if="k.isDefault" class="badge me">默认</span>
        </div>
        <div class="r-sub">
          <code v-if="k.apiKeySet">Key {{ k.apiKey }}</code>
          <code v-else class="dim">Key 未填</code>
          <code v-if="k.passwordSet" class="dim">口令已填</code>
        </div>
        <div class="r-act">
          <button
            v-if="!k.isDefault"
            class="mini"
            type="button"
            @click="makeDefault(k)"
          >
            设为默认
          </button>
          <button class="mini" type="button" @click="openEdit(k)">编辑</button>
          <button class="mini danger" type="button" @click="remove(k)">
            删除
          </button>
        </div>
        <!--
          拖动把手（用户 2026-10-10：「支持拖拽调整顺序」）。
          ⚠️ 绝对定位在卡片**右侧**（见 CSS 里 `.rows li > .drag`）——
            原来放左边当网格的一列，把内容推到 130px 开外，用户当场报「左边空距太大」。
          ⚠️ 只有这一条把手能起拖：整行都能拖的话，「编辑 / 删除」上滑一下就变成拖拽；
            而且把手以外的区域必须保留原生滚动（手机上要能滑页面）。
        -->
        <button
          class="drag"
          type="button"
          :aria-label="`拖动调整「${k.name || labelOf(k.exchange)}」的顺序`"
          title="按住拖动，调整显示顺序"
          @pointerdown="startDrag($event, i)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
          </svg>
        </button>
      </li>
    </ul>

    <p v-if="error" class="err">{{ error }}</p>
    <p v-if="msg" class="ok">{{ msg }}</p>

    <!-- 新增 / 编辑 -->
    <template v-if="formOpen">
      <div class="form">
        <label>
          <span>交易所</span>
          <select v-model="fExchange">
            <option v-for="c in catalog" :key="c.id" :value="c.id">
              {{ c.label }}
            </option>
          </select>
        </label>
        <label>
          <span>名字（自己认得出就行）</span>
          <input v-model="fName" type="text" maxlength="20" placeholder="如：主力 / 跟单号" />
        </label>
        <label>
          <span>API Key</span>
          <input
            v-model="fApiKey"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="editingId === null ? '粘贴 API Key' : '不改就留空'"
          />
        </label>
        <label>
          <span>Secret</span>
          <input
            v-model="fSecret"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="editingId === null ? '粘贴 Secret' : '不改就留空'"
          />
        </label>
        <label>
          <span>Passphrase（OKX / KuCoin 这类才要，没有就留空）</span>
          <input
            v-model="fPassword"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="可选"
          />
        </label>
        <div class="form-row">
          <label class="inline">
            <span>市场</span>
            <select v-model="fMarketType">
              <option value="swap">合约</option>
              <option value="spot">现货</option>
            </select>
          </label>
          <label
            class="inline chk"
            title="本地开发用：币安模拟盘（demo.binance.com）—— 假钱、不用 IP 白名单；勾上后余额/杠杆/合约规格/测试单全打 demo 环境"
          >
            <input v-model="fSandbox" type="checkbox" />
            <span>沙盒 / 测试网</span>
          </label>
        </div>
        <div class="row">
          <button
            class="btn primary"
            type="button"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? '保存中…' : editingId === null ? '新增' : '保存' }}
          </button>
          <button class="btn" type="button" @click="closeForm">取消</button>
        </div>
      </div>
    </template>
    <div v-else class="row">
      <button
        class="btn primary"
        type="button"
        :disabled="keys.length >= max"
        :title="
          keys.length >= max ? `最多只能绑 ${max} 套，先删掉一套再加` : '新增一套交易所 Key'
        "
        @click="openAdd"
      >
        新增交易所
      </button>
      <span v-if="keys.length >= max" class="dim" style="font-size: 12px">
        已到上限（{{ max }} 套），要加新的先删一套。
      </span>
    </div>
  </section>
</template>

<style scoped>
.exch {
  display: flex;
  flex-direction: column;
}
h2 {
  margin: 0 0 8px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
h2 small {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: var(--fw-normal, 400);
}
.note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.rows {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rows li {
  border: 1px solid var(--line, rgba(128, 128, 128, 0.25));
  border-radius: 8px;
  padding: 9px 11px;
  /*
   * ⚠️ 这里**不能**用「grid 两列 = 把手 + 内容」那套（2026-10-10 试过）：
   *    内容会被推到卡片左边 130px 开外，用户当场就报「左边空距太大」。
   *    把手改成**绝对定位在右侧**（iOS 列表的排序把手也是右边），
   *    左侧padding 一个字都不用动 ⇒ 卡片跟加把手之前一模一样。
   */
  position: relative;
  padding-right: 32px;
}
.rows li.on {
  border-color: var(--blue);
}
/* 正在拖的那一行：给个明显的落点反馈 */
.rows li.dragging {
  border-color: var(--accent, #d3b583);
  background: rgba(255, 255, 255, 0.045);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
}
.rows li > .drag {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
}
.drag {
  width: 24px;
  height: 44px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--muted);
  cursor: grab;
  /*
   * ⚠️ 这两条是拖拽能不能用的关键：
   *   `touch-action: none` —— 不加的话手指一竖划被当成页面滚动，拖不动；
   *   `user-select: none` —— 否则长按会先选中文字（手机上看着像卡住）。
   * 只有这一条 24px 宽的把手挡滚动：卡片主体照旧能上下滑页面。
   */
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.drag:active {
  cursor: grabbing;
  color: var(--accent, #d3b583);
}
@media (hover: hover) {
  .drag:hover {
    background: rgba(255, 255, 255, 0.06);
  }
}
.drag svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
}
.r-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.r-sub {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 5px;
}
.r-sub code {
  font-family: var(--mono);
  font-size: 11.5px;
}
.r-act {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.mini {
  padding: 3px 10px;
  font-size: 11.5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.mini.danger {
  color: var(--bad, #e5534b);
}
.form {
  border-top: 1px solid var(--line, rgba(128, 128, 128, 0.25));
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
label.inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
label span {
  font-size: 12px;
  color: var(--muted);
}
input,
select {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 14px;
}
.form-row {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}
.form-row label.inline {
  width: auto;
}
.form-row select {
  width: auto;
}
.chk {
  align-self: center;
}
.chk input {
  width: auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.btn {
  padding: 8px 16px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 10px);
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
}
.btn.primary {
  border-color: transparent;
  background: var(--accent, #d3b583);
  color: var(--accent-ink, #17140f);
  font-weight: var(--fw-mid, 500);
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.err {
  margin: 0 0 8px;
  color: var(--bad);
  font-size: 12.5px;
}
.ok {
  margin: 0 0 8px;
  color: var(--ok);
  font-size: 12.5px;
}
.badge.me {
  color: var(--blue);
  /*
   * ⚠️ 这里原来写的是 `color-mix(in srgb, var(--blue) 45%, transparent)` ——
   *    那台华为 Android 12 的 WebView **算不出 color-mix**，边框会退成 currentColor
   *    （亮灰），看着像多了一道白边。手算成静态 rgba 就稳了（`--accent` = #d3b583）。
   */
  border-color: rgba(211, 181, 131, 0.45);
}
.badge.soft {
  color: var(--muted);
}
</style>
