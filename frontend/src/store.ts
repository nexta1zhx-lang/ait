import {computed, ref} from 'vue'
import {
  fetchAccount,
  fetchConfig,
  fetchContracts,
  switchModel,
  type AccountResult,
  type AppConfig,
  type Contract
} from './api'
import {cny} from './format'

/** 全局状态：配置、账户（模型列表）、合约列表。三个页面共用。 */

export const config = ref<AppConfig | null>(null)
export const account = ref<AccountResult | null>(null)
export const contracts = ref<Contract[]>([])
export const configError = ref('')
export const ready = ref(false)
export const switchingModel = ref(false)

let loading: Promise<void> | null = null

/** 只加载一次，多个页面共享同一个 Promise */
export function bootstrap(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    try {
      config.value = await fetchConfig()
    } catch (e) {
      configError.value = (e as Error).message
    }
    try {
      account.value = await fetchAccount()
    } catch (e) {
      if (!configError.value) configError.value = (e as Error).message
    }
    try {
      const store = await fetchContracts()
      if (store.contracts) contracts.value = store.contracts
      else if (store.error) configError.value = store.error
    } catch (e) {
      if (!configError.value) configError.value = (e as Error).message
    }
    ready.value = true
  })()
  return loading
}

/** 重新拉一次（收完案例 / 分析完 刷新条数与花费） */
export async function refreshConfig(): Promise<void> {
  config.value = await fetchConfig().catch(() => config.value)
  account.value = await fetchAccount().catch(() => account.value)
}

/** 切换模型：写回 .env，下一次判断就用新的 */
export async function changeModel(model: string): Promise<string | null> {
  if (!model || model === config.value?.model) return null
  switchingModel.value = true
  try {
    const r = await switchModel(model)
    if (config.value) config.value = {...config.value, model: r.model}
    if (account.value) {
      account.value = {
        ...account.value,
        model: r.model,
        models: {...account.value.models, current: r.model}
      }
    }
    return r.warning ?? null
  } catch (e) {
    return (e as Error).message
  } finally {
    switchingModel.value = false
  }
}

/** 启动时该提醒的事（没配 Key / 规则没读到 / 加载失败） */
export const notices = computed(() => {
  const out: string[] = []
  if (configError.value) out.push(`⚠️ ${configError.value}`)
  const c = config.value
  if (!c) return out
  if (!c.hasApiKey) {
    out.push(
      '未检测到 LLM_API_KEY，默认走「模拟判断」。在 .env 填入 Key 后才是真实 AI 判断。'
    )
  }
  if (!c.rules?.sources?.length) {
    out.push('没读到内置的分析预测提示词 —— 这是代码问题，不是配置问题。')
  }
  return out
})

/** 可切换的模型列表（拿不到接口列表时用内置的） */
export const modelOptions = computed(() => {
  const list = account.value?.models.available ?? []
  if (list.length) return list
  const cur = config.value?.model
  return cur
    ? [{id: cur, priced: true, price: {inputHit: 0, inputMiss: 0, output: 0}}]
    : []
})

/** 当前模型的单价（美元 / 1M token，高峰价） */
export const currentPrice = computed(
  () =>
    modelOptions.value.find(m => m.id === config.value?.model)?.price ?? null
)

/* ---------------- 模型余额 ---------------- */

export const refreshingBalance = ref(false)

/**
 * 顶栏那个「余额 ¥7.18」。
 * 后端有 60 秒缓存，点一下才是真刷新（`?refresh=1`）。
 */
export const balanceBadge = computed(() => {
  const b = account.value?.balance
  if (!b || !b.ok || !b.main) {
    return {
      text: b ? '余额 —' : '余额 …',
      amount: '',
      cls: 'warn',
      title: b?.error ?? '还没拿到余额'
    }
  }
  const m = b.main
  const low = m.totalBalance > 0 && m.totalBalance < 5
  const money =
    m.currency === 'CNY'
      ? cny(m.totalBalance)
      : `${m.totalBalance.toFixed(2)} ${m.currency}`
  return {
    text: `余额 ${money}`,
    amount: money,
    cls: m.totalBalance <= 0 ? 'bad' : low ? 'warn' : 'ok',
    title:
      `模型账户（${m.currency}）· 最后查询 ${new Date(b.fetchedAt).toLocaleTimeString('zh-CN')}` +
      '\n点一下刷新' +
      (m.grantedBalance > 0
        ? `\n赠送 ${m.grantedBalance} · 充值 ${m.toppedUpBalance}`
        : '')
  }
})

/** 手动刷新余额（绕过后端 60 秒缓存） */
export async function refreshBalance(): Promise<void> {
  if (refreshingBalance.value) return
  refreshingBalance.value = true
  try {
    const r = await fetchAccount(true)
    account.value = r
  } catch {
    /* 拿不到就维持原样，title 里已经写了原因 */
  } finally {
    refreshingBalance.value = false
  }
}
