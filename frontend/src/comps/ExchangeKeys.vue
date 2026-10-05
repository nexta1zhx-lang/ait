<script setup lang="ts">
/**
 * 「我的 → 个人信息 → 账户信息 → 交易所」。
 *
 * 用户 2026-10-04：「个人信息下添加交易所内容，可以新增交易所和 key，支持多个」。
 *
 * 能绑**多套**交易所 API Key（各自起名 / 选交易所 / 选现货还是合约），
 * 其中一套是「默认」——「开单分析 → 交易所账户」那格默认用它。
 *
 * ⚠️ 真 Key / Secret **不回前端**：列表里显示的是掩码（`abcd****wxyz`），
 *    编辑时也只回显掩码；不改就原样回传，后端认得出掩码、不覆盖。
 *
 * 权限怎么开：只是**看**余额 / 持仓 / 订单 —— 读权限就够；
 * 要用「开单分析 → K 线」底部那个**下单模块**（2026-10-05 加），
 * 得再勾上**合约交易**权限（模块本身走的是币安的测试接口，不会真成交），
 * 并且要在「API 限制 IP」里放行服务器出口 IP —— 不然会一直报 `-2015`。
 */
import {onMounted, ref} from 'vue'
import {
  createExchangeKey,
  deleteExchangeKey,
  fetchExchangeKeys,
  setDefaultExchangeKey,
  updateExchangeKey,
  type ExchangeCatalogEntry,
  type ExchangeKey
} from '../api'
import {askConfirm} from '../confirm'

const keys = ref<ExchangeKey[]>([])
const catalog = ref<ExchangeCatalogEntry[]>([])
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
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function openAdd(): void {
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
      <small v-if="keys.length">共 {{ keys.length }} 套</small>
    </h2>
    <p class="note">
      绑定交易所 API Key 后，「开单分析 → 交易所账户」那格就能看余额和订单历史。
      只看着数用<b>只读权限</b>就够；要在 K 线页底部<b>下单</b>（测试单，不会真成交），
      得再勾上<b>合约交易</b>权限、并把服务器出口 IP 加进「API 限制 IP」。
    </p>

    <p v-if="loading" class="dim">载入中…</p>

    <ul v-else class="rows">
      <li v-for="k in keys" :key="k.id" :class="{on: k.isDefault}">
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
      <button class="btn primary" type="button" @click="openAdd">
        新增交易所
      </button>
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
}
.rows li.on {
  border-color: var(--blue);
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
  border-color: color-mix(in srgb, var(--blue) 45%, transparent);
}
.badge.soft {
  color: var(--muted);
}
</style>
