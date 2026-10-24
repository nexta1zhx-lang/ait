#!/usr/bin/env node
/**
 * **只读**自检：加仓之后止盈 / 止损会不会被放回 100%。
 *
 *   npm run check:protect -- --list
 *   npm run check:protect -- --key 3 --symbol 1000PEPEUSDT --add 50
 *
 * 做什么：读一次 `positionRisk` + `openOrders`（普通单 + Algo 条件单），把每条持仓
 * 现有的止盈 / 止损列出来，再拿 `planProtectFull` 算一遍「如果现在加仓 N%，
 * 会把哪几张、从多少改成多少」。
 *
 * ⚠️ **只读**：这条链上没有任何撤单 / 下单调用。要看真改，得在前端真加一次仓。
 * ⚠️ 不打印 API Key / Secret（只打 Key 的 id / 名字），持仓与单号也只打在本地终端。
 */
import {query} from '../db/client'
import {listPositions, listOpenOrders, type OpenOrderRow} from '../data/exchange-trade'
import {planProtectFull} from '../data/auto-stop'
import {getExchangeKey} from '../db/exchange-keys'

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? String(process.argv[i + 1] ?? '') : ''
}

const fmt = (v: number, d = 6): string => {
  if (!Number.isFinite(v)) return '—'
  return String(Number(v.toFixed(d)))
}

/** 这条持仓的平仓侧（多单是卖、空单是买） */
const closeSideOf = (side: string): 'buy' | 'sell' =>
  side === 'short' ? 'buy' : 'sell'

const isTp = (o: OpenOrderRow): boolean =>
  String(o.type).toUpperCase().includes('TAKE_PROFIT')
const isSl = (o: OpenOrderRow): boolean =>
  !isTp(o) && String(o.type).toUpperCase().includes('STOP')

async function main(): Promise<void> {
  const rows = await query<{id: string; user_id: string; name: string; exchange: string}>(
    `SELECT id, user_id, name, exchange FROM user_exchange_keys
      ORDER BY is_default DESC, id`
  )
  if (!rows.length) {
    console.log('这个库里一条交易所 Key 都没有。')
    return
  }
  if (process.argv.includes('--list')) {
    console.log('可用账户（--key 用第一个数字）：')
    for (const r of rows)
      console.log(`  ${r.id}. ${r.name || r.exchange}（user ${r.user_id}，${r.exchange}）`)
    return
  }

  const wantId = Number(arg('key')) || Number(rows[0]!.id)
  const row = rows.find(r => Number(r.id) === wantId) ?? rows[0]!
  const userId = Number(row.user_id)
  const key = await getExchangeKey(userId, Number(row.id))
  if (!key) throw new Error(`找不到 Key ${wantId}`)
  if (!key.apiKey || !key.secret) throw new Error(`${key.name} 没填 API Key`)

  const creds = {
    exchange: key.exchange,
    apiKey: key.apiKey,
    secret: key.secret,
    password: key.password,
    marketType: key.marketType,
    sandbox: key.sandbox
  }

  console.log(`账户：${key.name || key.exchange}（#${key.id}）\n`)

  const only = arg('symbol').toUpperCase()
  const positions = (await listPositions(creds, key.id)).filter(
    p => !only || String(p.symbol ?? '').toUpperCase() === only
  )
  if (!positions.length) {
    console.log(only ? `${only} 现在没有持仓` : '现在没有任何持仓')
    return
  }

  /* 一次把整个账户的挂单拉回来（普通 + 条件单），再按币种分组 */
  const orders = await listOpenOrders(creds)
  const add = Math.abs(Number(arg('add')) || 50)

  for (const p of positions) {
    const symbol = String(p.symbol ?? '').toUpperCase()
    const side = p.side === 'short' ? 'short' : 'long'
    const amount = Math.abs(Number(p.amount) || 0)
    const closing = closeSideOf(side)
    const posSide = side === 'long' ? 'LONG' : 'SHORT'
    const mine = orders.filter(
      o =>
        String(o.symbol ?? '').toUpperCase() === symbol &&
        String(o.side ?? '').toLowerCase() === closing &&
        (o.posSide === 'BOTH' || o.posSide === posSide) &&
        (isTp(o) || isSl(o))
    )

    console.log(
      `${symbol} ${side === 'long' ? '多' : '空'} ${fmt(amount)} 张 · 均价 ${fmt(p.entryPrice)} · 标记 ${fmt(p.markPrice)}`
    )
    if (!mine.length) {
      console.log('  没有任何止盈 / 止损')
      console.log('')
      continue
    }
    for (const o of mine) {
      const pct = amount > 0 && o.amount > 0 ? (o.amount / amount) * 100 : 0
      console.log(
        `  ${isTp(o) ? '止盈' : '止损'} ${fmt(Number(o.stopPrice))} · ${fmt(o.amount)} 张` +
          `（${o.amount > 0 ? `${pct.toFixed(1)}%` : '全仓型'}）` +
          ` · ${String(o.type)} · id ${o.id}` +
          `${o.reduceOnly ? ' · reduceOnly' : ''}`
      )
    }

    /* 假设现在加仓 N%：看决策（**只在本地算，不发任何请求**） */
    const after = amount * (1 + add / 100)
    const plan = planProtectFull({before: amount, amount: after, orders: mine})
    if (plan.action === 'skip') {
      console.log(`  加仓 ${add}% 后：不动（${plan.reason}）`)
    } else {
      console.log(`  加仓 ${add}% 后：改成 ${fmt(plan.quantity)} 张（100%）`)
      for (const c of plan.changes)
        console.log(
          `    ${c.kind === 'profit' ? '止盈' : '止损'} ${fmt(c.stopPrice)}：` +
            `${fmt(c.from)} → ${fmt(c.quantity)} 张（撤旧挂新，id ${c.orderId}）`
        )
    }
    console.log('')
  }
}

main().catch(e => {
  console.error('❌', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
