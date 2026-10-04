import {computed, ref} from 'vue'
import {
  fetchAccount,
  fetchConfig,
  fetchContracts,
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

/**
 * 退出登录时清掉上一份数据。
 * 不清的话下一个登录的人会先看到上一个人的条数 / 花费（虽然马上会被刷掉）。
 */
export function resetStore(): void {
  loading = null
  config.value = null
  account.value = null
  contracts.value = []
  configError.value = ''
  ready.value = false
}

/** 启动时该提醒的事（没配 Key / 规则没读到 / 加载失败） */
export const notices = computed(() => {
  const out: string[] = []
  if (configError.value) out.push(`⚠️ ${configError.value}`)
  const c = config.value
  if (!c) return out
  if (!c.hasApiKey) {
    out.push(
      '还没有配置大模型 API Key —— 去「我的 → 模型配置」填一个才能分析。'
    )
  }
  if (!c.rules?.sources?.length) {
    out.push('没读到内置的分析预测提示词 —— 这是代码问题，不是配置问题。')
  }
  return out
})

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
