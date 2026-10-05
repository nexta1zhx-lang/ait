/**
 * 「下单模块用哪套交易所 Key」（用户 2026-10-05：「配置中可切换用户」）。
 *
 * 原来是**隐式**用默认那套（请求连 `?id=` 都不带）；现在「配置」弹层里能切，
 * 选择落 localStorage，K 线页底部那个下单模块跟着走。
 *
 * ⚠️ 记住的 id 可能已经不存在了（在「我的 → 交易所」里删过）——
 *    那就自动回落到**默认那套**、再不行取第一套，不报错、不空转。
 */
import {computed, ref} from 'vue'
import {fetchExchangeKeys, type ExchangeKey} from './api'

const KEY = 'ca-trade-key'
/** 列表缓存多久（配置弹层和下单模块都会来问） */
const TTL_MS = 30_000

export const tradeKeys = ref<ExchangeKey[]>([])
export const tradeKeysErr = ref('')

/** 选中的 id；`undefined` = 没选过，走默认那套 */
export const tradeKeyId = ref<number | undefined>(read())

function read(): number | undefined {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isFinite(v) && v > 0 ? v : undefined
  } catch {
    // 无痕模式 / 被禁用：当没选过
    return undefined
  }
}

function write(id: number): void {
  try {
    localStorage.setItem(KEY, String(id))
  } catch {
    /* 写不了就算了，本次会话内仍然生效 */
  }
}

/** 现在这套 Key：**选的 → 默认 → 第一套** */
export const tradeKey = computed<ExchangeKey | null>(() => {
  const list = tradeKeys.value
  if (!list.length) return null
  return (
    list.find(k => k.id === tradeKeyId.value) ??
    list.find(k => k.isDefault) ??
    list[0] ??
    null
  )
})

export function pickTradeKey(id: number): void {
  tradeKeyId.value = id
  write(id)
}

let at = 0
let loading: Promise<void> | null = null

/** 拉一次列表（30 秒内不重复拉；`force` 强制） */
export function loadTradeKeys(force = false): Promise<void> {
  if (!force && tradeKeys.value.length && Date.now() - at < TTL_MS) {
    return Promise.resolve()
  }
  if (loading) return loading
  loading = (async () => {
    try {
      tradeKeys.value = (await fetchExchangeKeys()).keys ?? []
      tradeKeysErr.value = ''
      at = Date.now()
    } catch (e) {
      tradeKeysErr.value = (e as Error).message
    } finally {
      loading = null
    }
  })()
  return loading
}
