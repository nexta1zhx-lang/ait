import {createExchange, humanize, type ExchangeCredentials} from './exchange-account'

/**
 * **万能划转**（用户 2026-10-05：「各个里面添加划转功能」）。
 *
 * ★ 用的是**零售版**万能划转 `POST /sapi/v1/asset/transfer`（ccxt `sapiPostAssetTransfer`），
 *   **不是** `/sapi/v1/broker/universalTransfer` —— 那个是「Broker 万能划转」，
 *   要券商/经纪商身份 + `X-SAPI-USED-UC-UID` 之类请求头，普通账号打过去直接被拒。
 *   零售版对个人账号就够了，支持的钱包对见下面 `TYPE_OF`。
 *
 * ★ 支持哪些组合（2026-10-05 在真实账号上**逐个验过** `GET /sapi/v1/asset/transfer`
 *   的 `type` 枚举，合法的回历史、非法的回 `-1102`）：
 *
 *   | type                | 方向                     |
 *   | ------------------- | ------------------------ |
 *   | `MAIN_UMFUTURE`     | 现货 → USDTⓈ 合约        |
 *   | `UMFUTURE_MAIN`     | USDTⓈ 合约 → 现货        |
 *   | `MAIN_FUNDING`      | 现货 → 资金(C2C)         |
 *   | `FUNDING_MAIN`      | 资金(C2C) → 现货         |
 *   | `UMFUTURE_FUNDING`  | USDTⓈ 合约 → 资金(C2C)   |
 *   | `FUNDING_UMFUTURE`  | 资金(C2C) → USDTⓈ 合约   |
 *
 *   ❌ `MAIN_C2C` / `C2C_MAIN`（**真的 C2C 账户**）**无效** —— 币安那个 `type`
 *      在当前账号上回 `-1102`，用户也确认了「不支持 C2C 账户」。
 *      ⚠️ 但注意：本项目界面上那个「C2C 钱包」**其实是 Funding（资金）钱包**
 *      （见 `exchange-overview.ts` 文件头 ①），那个是能划的，别混为一谈。
 *   ❌ 合约 ↔ 合约、币本位（COIN-M）—— 前者压根没有对应 `type`，后者本仓库不碰。
 *
 * ★ `permitsUniversalTransfer`（币安 API 管理页那个「允许通用划转」）**必须开**，
 *   否则报的是通用的 `-2015`，看不出真正原因 ⇒ 下面 `transferPermissions()` 先问一次，
 *   界面据此把「去勾上」这句话直接摆出来。
 *
 * ⚠️ 划转**没有测试接口**（不像下单有 `/order/test`）：调一次就真动钱。
 *    所以金额、方向都由前端二次确认，后端只做「别把参数搞错」的校验。
 */

/** 能划的三个钱包（跟界面上的叫法一一对应） */
export const WALLETS = ['spot', 'funding', 'futures'] as const
export type Wallet = (typeof WALLETS)[number]

/** 界面 / 报错里用的中文名 */
export const WALLET_LABEL: Record<Wallet, string> = {
  spot: '现货',
  funding: '资金（C2C）',
  futures: 'USDTⓈ 合约'
}

/** 方向 → 币安的 `type`（只列**验过能用**的，其余一律拒绝） */
const TYPE_OF: Record<string, string> = {
  'spot>futures': 'MAIN_UMFUTURE',
  'futures>spot': 'UMFUTURE_MAIN',
  'spot>funding': 'MAIN_FUNDING',
  'funding>spot': 'FUNDING_MAIN',
  'futures>funding': 'UMFUTURE_FUNDING',
  'funding>futures': 'FUNDING_UMFUTURE'
}

export interface TransferInput {
  from: Wallet
  to: Wallet
  /** 划多少（正数） */
  amount: number
  /** 默认 USDT —— 本仓库只统计 USDT，别的币种先不做 */
  asset?: string
}

export interface TransferResult {
  /** 币安回的交易号（`tranId`） */
  tranId: string
  type: string
  asset: string
  amount: number
  from: Wallet
  to: Wallet
}

/** 这套 key 能不能划（`permitsUniversalTransfer`） */
export interface TransferPermissions {
  /** 币安 API 管理页的「允许通用划转」—— **false 就一定划不动** */
  permitsUniversalTransfer: boolean
  /** 顺带把这些也带回来，界面提示能说得具体点 */
  enableReading: boolean
  enableFutures: boolean
  enableSpotAndMarginTrading: boolean
}

function isWallet(v: unknown): v is Wallet {
  return WALLETS.includes(v as Wallet)
}

/** 这套 key 的划转权限（只读，不打钱） */
export async function transferPermissions(
  c: ExchangeCredentials
): Promise<TransferPermissions> {
  const ex = createExchange(c)
  if (typeof ex.sapiGetAccountApiRestrictions !== 'function')
    throw new Error(`「${c.exchange}」没有币安那套 sapi 接口，划转暂只接了币安`)
  const r: any = await ex.sapiGetAccountApiRestrictions()
  return {
    permitsUniversalTransfer: r?.permitsUniversalTransfer === true,
    enableReading: r?.enableReading === true,
    enableFutures: r?.enableFutures === true,
    enableSpotAndMarginTrading: r?.enableSpotAndMarginTrading === true
  }
}

/** 某个钱包里 USDT **能划出去多少**（「全部」那个按钮用；实时读，不用快照） */
export async function walletAvailable(
  c: ExchangeCredentials,
  wallet: Wallet
): Promise<{wallet: Wallet; asset: string; available: number; total: number}> {
  const ex = createExchange(c)
  if (wallet === 'spot') {
    const acc: any = await ex.privateGetAccount()
    const b = (Array.isArray(acc?.balances) ? acc.balances : []).find(
      (x: any) => String(x?.asset ?? '').toUpperCase() === 'USDT'
    )
    const free = Number(b?.free ?? 0) || 0
    const locked = Number(b?.locked ?? 0) || 0
    /* 现货能划走的是 **free** —— 挂在单子上的 locked 动不了 */
    return {wallet, asset: 'USDT', available: free, total: free + locked}
  }
  if (wallet === 'funding') {
    const raw: any = await ex.sapiGetAssetWalletBalance({needBalanceDetail: true})
    const list: any[] = Array.isArray(raw) ? raw : (raw?.wallets ?? [])
    const w = list.find(x => /^(c2c|funding)$/i.test(String(x?.walletName ?? '').trim()))
    const b = (Array.isArray(w?.assetBalances) ? w.assetBalances : []).find(
      (x: any) => String(x?.asset ?? '').toUpperCase() === 'USDT'
    )
    /* ⚠️ 资金钱包这里**没有** `balance` 字段，钱在 free/locked/freeze/withdrawing 里 */
    const free = Number(b?.free ?? 0) || 0
    const rest =
      (Number(b?.locked ?? 0) || 0) +
      (Number(b?.freeze ?? 0) || 0) +
      (Number(b?.withdrawing ?? 0) || 0)
    return {wallet, asset: 'USDT', available: free, total: free + rest}
  }
  const accFn = ex.fapiPrivateV2GetAccount ?? ex.fapiPrivateGetAccount
  if (typeof accFn !== 'function')
    throw new Error(`「${c.exchange}」没有币安的合约账户接口`)
  const acc: any = await accFn.call(ex)
  const avail = Number(acc?.availableBalance) || 0
  const margin = Number(acc?.totalMarginBalance) || 0
  return {wallet, asset: 'USDT', available: avail, total: margin}
}

/**
 * 划一笔（**真钱**，没有测试接口）。
 *
 * 校验顺序：钱包对合法 → 金额为正 → 再发出去。
 * ⚠️ 币安对 `amount` 的精度要求是「不超过 8 位小数」，这里统一 `floor` 到 8 位，
 *    免得界面上算出 `9.299999999` 这种数被 `-1111` 拒掉。
 */
export async function universalTransfer(
  c: ExchangeCredentials,
  input: TransferInput
): Promise<TransferResult> {
  const {from, to} = input
  if (!isWallet(from) || !isWallet(to))
    throw new Error('划转方向只支持「现货 / 资金（C2C）/ USDTⓈ 合约」这三个钱包')
  if (from === to) throw new Error('转出和转入不能是同一个钱包')
  const key = `${from}>${to}`
  const type = TYPE_OF[key]
  if (!type)
    throw new Error(
      `不支持「${WALLET_LABEL[from]} → ${WALLET_LABEL[to]}」` +
        '（币安万能划转不支持合约之间互转，也不支持真正的 C2C 账户）'
    )
  const asset = (input.asset || 'USDT').toUpperCase()
  const amount = Math.floor(Number(input.amount) * 1e8) / 1e8
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额要先填好')

  const ex = createExchange(c)
  if (typeof ex.sapiPostAssetTransfer !== 'function')
    throw new Error(`「${c.exchange}」没有币安那套 sapi 接口，划转暂只接了币安`)

  try {
    const r: any = await ex.sapiPostAssetTransfer({type, asset, amount})
    return {
      tranId: String(r?.tranId ?? ''),
      type,
      asset,
      amount,
      from,
      to
    }
  } catch (e) {
    throw new Error(humanizeTransfer(e))
  }
}

/**
 * 划转的报错翻成中文。
 *
 * ⚠️ 跟 `exchange-trade.humanizeTrade` 同一个纪律：**只认币安回的 `code`**，
 *    别拿英文关键词去匹配整条消息（ccxt 的报错里带着请求 URL，一匹配一个准、全是误判）。
 */
function humanizeTransfer(e: unknown): string {
  const raw = (e as Error)?.message ?? String(e)
  const code = Number(raw.match(/"code"\s*:\s*(-?\d+)/)?.[1])
  switch (code) {
    case -1102:
      return '这个划转方向币安不认（合约之间不能互转，C2C 账户也不在万能划转里）'
    case -1100:
      return '参数不对：金额要大于 0，币种和方向都得填对'
    /* ★ 实测最常见的那个（2026-10-05 用 999999 打现货，币安回的就是它） */
    case -5013:
      return '余额不足：这个钱包里没有这么多 USDT（挂在单子上的锁定额划不动）'
    case -1002:
    case -2015:
      /*
       * 币安不给「哪个权限没开」的细分错误 —— 这里只能把两个常见原因一起说了。
       * `permitsUniversalTransfer` 那个开关在「API 管理 → 允许通用划转」。
       */
      return (
        '这把 Key 划不动：多半是没勾「允许通用划转」（去币安 API 管理里开），' +
        '其次看 IP 白名单有没有放行服务器出口 IP'
      )
    default:
      return humanize(e)
  }
}
