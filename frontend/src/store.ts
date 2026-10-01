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

/** 全局状态：配置、账户（余额 / 模型）、合约列表。三个页面共用。 */

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

/** 刷新余额（绕过服务端 60 秒缓存） */
export async function refreshBalance(): Promise<void> {
  account.value = await fetchAccount(true).catch(() => account.value)
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
    out.push('rules/ 目录里没读到规则文件，AI 只能凭通用常识判断。')
  }
  return out
})

export const rulesBadge = computed(() => {
  const r = config.value?.rules
  if (!r?.sources?.length) return {text: '⚠️ 规则未加载', cls: 'bad', title: ''}
  const chars = ((r.systemChars || 0) + (r.bodyChars || 0)) / 1000
  return {
    text: `规则 ${r.sources.length} 个文件 · ${chars.toFixed(1)}K · ${r.hash}`,
    cls: 'ok',
    title: r.sources.join('\n')
  }
})

export const kbBadge = computed(() => {
  const total = config.value?.knowledge?.total ?? 0
  return {
    text: `知识库 ${total} 条`,
    cls: total > 0 ? 'ok' : '',
    title: '我标过的案例'
  }
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
