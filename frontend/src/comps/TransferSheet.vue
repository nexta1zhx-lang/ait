<script setup lang="ts">
/**
 * **万能划转**弹层（用户 2026-10-05：「在交易所账户，各个里面添加划转功能」）。
 *
 * ★⚠️ 这是全站**唯一一处真金白银、且没有测试接口**的操作：
 *   币安的下单有 `/fapi/v1/order/test`（只校验不成交），划转**没有**对应物，
 *   点下去钱就真的换了钱包。所以这个弹层里：
 *     · 顶部常驻一条红色警示（不是可关的 toast，是标题下面一直挂着）
 *     · 提交前 `window.confirm` 复述「哪套账户 / 从哪到哪 / 多少」
 *     · 没开「允许通用划转」的 Key **直接禁用提交**（先问一次权限，见下）
 *
 * ★ 支持的钱包对（后端只放行验过能用的六种，见 `data/exchange-transfer.ts`）：
 *   现货 / 资金（C2C）/ USDTⓈ 合约 —— 三者两两互转。
 *   ❌ 合约之间不能互转、❌ 真正的 C2C 账户不在万能划转里。
 *
 * ★ 金额里的「全部」走 `/api/exchange/wallet` 实时读**能划走的那部分**
 *   （现货/资金是 `free`，挂在单子上的锁定额划不动）—— 不用快照里的数，
 *   快照那个是「总额」，照着填会被 `-4046` 拒掉。
 */
import {computed, ref, watch} from 'vue'
import {
  exchangeTransfer,
  fetchTransferPermissions,
  fetchWalletBalance,
  type ExchangeKey,
  type TransferWallet
} from '../api'
import {fmt} from '../format'

const props = defineProps<{
  open: boolean
  /** 在用的那套 Key（弹层里还能改，见下面的账户选择） */
  keyId?: number
  /** 可选的账户列表（只有一套时不摆） */
  keys?: ExchangeKey[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'pickKey', id: number): void
  /** 划完了：外面把快照 / 余额重读一遍 */
  (e: 'done'): void
}>()

/** 界面上的三个钱包 */
const WALLETS: {value: TransferWallet; label: string}[] = [
  {value: 'spot', label: '现货'},
  {value: 'funding', label: '资金(C2C)'},
  {value: 'futures', label: '合约'}
]

const from = ref<TransferWallet>('funding')
const to = ref<TransferWallet>('futures')
const amount = ref('')

const busy = ref(false)
const err = ref('')
/** 成功那一句 —— 摆在弹层里（本仓库的 toast 是 OrderPanel 内部的，不是全局的，
 *  不从这儿乱发事件），顺手把金额清掉，用户看一眼「单号」再自己关 */
const doneMsg = ref('')

/** 这套 Key 能不能划（`permitsUniversalTransfer`）—— null = 还没问过 */
const permitted = ref<boolean | null>(null)
const permErr = ref('')

/** 转出钱包里能划走多少（实时读；null = 还在读 / 读不到） */
const avail = ref<number | null>(null)
const availErr = ref('')

const currentKey = computed(
  () => (props.keys ?? []).find(k => k.id === props.keyId) ?? null
)
/** 多套 Key 时才摆账户选择 */
const multiKey = computed(() => (props.keys?.length ?? 0) > 1)

/** 同一个钱包不能互转（后端也会拦，这里先禁掉按钮） */
const sameWallet = computed(() => from.value === to.value)
const amountNum = computed(() => Number(amount.value))
const amountOk = computed(() => Number.isFinite(amountNum.value) && amountNum.value > 0)

/** 能不能按「划转」那颗按钮 */
const blocked = computed(() => {
  if (busy.value) return '正在提交…'
  if (permitted.value === false)
    return '这把 Key 没开「允许通用划转」—— 去币安 API 管理里打开再回来'
  if (sameWallet.value) return '转出和转入不能是同一个钱包'
  if (!amountOk.value) return '先填金额'
  return ''
})

/** 对调一下方向（点中间那个 ⇅） */
function swap(): void {
  const f = from.value
  from.value = to.value
  to.value = f
  amount.value = ''
  void loadAvail()
}

/** 「全部」：填**能划走**的那个数（不是快照里的总额） */
function useAll(): void {
  if (avail.value === null || avail.value <= 0) return
  amount.value = String(Math.floor(avail.value * 1e8) / 1e8)
}

async function loadAvail(): Promise<void> {
  avail.value = null
  availErr.value = ''
  if (!props.keyId) return
  try {
    const r = await fetchWalletBalance(from.value, props.keyId)
    if (!r.ok) {
      availErr.value = r.error || '读不到这个钱包的余额'
      return
    }
    avail.value = Number(r.available ?? 0)
  } catch (e) {
    availErr.value = (e as Error).message
  }
}

/** 问一次划转权限（只读接口，不打钱） */
async function loadPermission(): Promise<void> {
  permitted.value = null
  permErr.value = ''
  if (!props.keyId) return
  try {
    const r = await fetchTransferPermissions(props.keyId)
    if (!r.ok || !r.permissions) {
      permErr.value = r.error || '读不到这把 Key 的权限'
      permitted.value = null
      return
    }
    permitted.value = r.permissions.permitsUniversalTransfer
    permErr.value = ''
  } catch (e) {
    permErr.value = (e as Error).message
    permitted.value = null
  }
}

/* 打开时（以及换 Key 时）把权限和余额都问一遍 */
watch(
  () => [props.open, props.keyId],
  ([on]) => {
    if (!on) return
    err.value = ''
    void loadPermission()
    void loadAvail()
  },
  {immediate: true}
)

/* 换转出钱包 ⇒ 余额要重读（不同钱包的「能划走」不一样） */
watch(from, () => {
  amount.value = ''
  void loadAvail()
})

/**
 * 提交 —— 先 confirm 复述一遍再发。
 * ⚠️ 措辞要带上**账户名 / 方向 / 金额**：这一步点错就是真丢钱，
 *    不能只写「确定吗？」。
 */
async function submit(): Promise<void> {
  if (blocked.value || !props.keyId) return
  const label = (w: TransferWallet) =>
    WALLETS.find(x => x.value === w)?.label ?? w
  const name = currentKey.value?.name ?? '当前账户'
  const ok = window.confirm(
    `确认划转（真钱，没有测试接口）：\n\n` +
      `账户：${name}\n` +
      `${label(from.value)} → ${label(to.value)}\n` +
      `金额：${amountNum.value} USDT\n\n` +
      '划出去就真的换钱包了，确定吗？'
  )
  if (!ok) return

  busy.value = true
  err.value = ''
  doneMsg.value = ''
  try {
    const r = await exchangeTransfer(
      {from: from.value, to: to.value, amount: amountNum.value},
      props.keyId
    )
    if (r.ok && r.transfer) {
      amount.value = ''
      doneMsg.value =
        `✅ 已划转：${label(from.value)} → ${label(to.value)} ` +
        `${r.transfer.amount} USDT` +
        (r.transfer.tranId ? `（单号 ${r.transfer.tranId}）` : '')
      /* 让外面把快照 / 曲线重读一遍 —— 钱包里的钱换了，数字立刻要跟着变 */
      emit('done')
      void loadAvail()
    } else {
      err.value = r.error || '划转失败'
    }
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet" role="dialog" aria-label="划转">
      <header class="sheet-head">
        <b>划转</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
      </header>

      <!-- 常驻警示：这不是可关的 toast，是标题下面一直挂着的一句 -->
      <p class="tr-warn">
        ⚠️ 划转是<b>真钱</b>操作 —— 币安没有「划转测试接口」，点下去就真的换钱包了。
        合约之间不能互转，真正的 C2C 账户也不在万能划转里。
      </p>

      <!-- 账户：多套 Key 时才给选 -->
      <div v-if="multiKey" class="sheet-row col">
        <div class="sheet-text"><b>账户</b></div>
        <div class="tk-picks">
          <button
            v-for="k in keys"
            :key="k.id"
            type="button"
            class="ghost tiny"
            :class="{on: k.id === keyId}"
            @click="emit('pickKey', k.id)"
          >
            {{ k.name }}
          </button>
        </div>
      </div>
      <p v-else-if="currentKey" class="tr-who">
        账户：<b>{{ currentKey.name }}</b>
      </p>

      <!-- 方向 -->
      <div class="tr-dir">
        <label class="tr-side">
          <span>从</span>
          <select v-model="from">
            <option v-for="w in WALLETS" :key="w.value" :value="w.value">
              {{ w.label }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="ghost tiny tr-swap"
          title="对调转出 / 转入"
          @click="swap"
        >
          ⇅
        </button>
        <label class="tr-side">
          <span>到</span>
          <select v-model="to">
            <option v-for="w in WALLETS" :key="w.value" :value="w.value">
              {{ w.label }}
            </option>
          </select>
        </label>
      </div>

      <!-- 金额 -->
      <label class="ord-field tr-amount">
        <span>金额</span>
        <input
          v-model="amount"
          inputmode="decimal"
          placeholder="USDT"
          @keyup.enter="submit"
        />
        <button
          type="button"
          class="ghost tiny"
          :disabled="avail === null || avail <= 0"
          :title="
            avail === null
              ? '还在读这个钱包的余额'
              : `这个钱包能划走 ${avail} USDT`
          "
          @click="useAll"
        >
          全部
        </button>
      </label>
      <p class="tr-avail">
        <template v-if="availErr">转出钱包读不到：{{ availErr }}</template>
        <template v-else-if="avail === null">正在读转出钱包的余额…</template>
        <template v-else>
          这个钱包能划走 <b>{{ fmt(avail, 2) }}</b> USDT
        </template>
      </p>

      <!-- 权限：没开就直接把话说清楚，别让人点了才知道 -->
      <p v-if="permitted === false" class="tr-bad">
        这把 Key 没勾「<b>允许通用划转</b>」（币安 → API 管理 → 编辑权限），
        划转会被币安拒掉。开完再回来。
      </p>
      <p v-else-if="permErr" class="tr-bad">权限没读到：{{ permErr }}</p>

      <p v-if="doneMsg" class="tr-ok">{{ doneMsg }}</p>
      <p v-if="err" class="tr-bad">{{ err }}</p>

      <button
        type="button"
        class="tr-go"
        :disabled="!!blocked || !keyId"
        :title="blocked || '划转（真钱）'"
        @click="submit"
      >
        {{ busy ? '提交中…' : '划转' }}
      </button>
      <p v-if="blocked" class="tr-why">{{ blocked }}</p>
    </section>
  </Teleport>
</template>
