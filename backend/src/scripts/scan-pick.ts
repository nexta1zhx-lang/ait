#!/usr/bin/env node
/**
 * 手动跑一轮**选币**（`npm run scan:pick`）—— 自动化预测的第一段，只挑候选、不调 AI、不花钱。
 *
 * 为什么要有这个命令：网页上的「自动化预测 → 筛选的币种」是给人看的，
 * 而调阈值的时候（"每类到底出几个" / "哪一类在刷屏"）在终端上看更快，
 * 也方便同一时刻反复重跑对结果（纯 SQL，可复现）。
 *
 * 阈值默认取该用户的网页配置，env 可以逐项覆盖（用来 A/B）：
 *   TF=1h PER_RULE=4 MAX=12 TURNOVER=3000000 AGE=14 TOP=30
 *   BREAKOUT_VOL=2 DIP_PCT=12 DIP_VOL=1.3 RALLY=1 RALLY_PCT=20 SPIKE_VOL=4
 *   AT=<毫秒时间戳> DBASE=BTC,ETH   （DBASE = 调试时只看这几个币）
 */
import {ensureSchema} from '../db/client'
import {defaultUserId} from '../db/users'
import {DEFAULT_SCAN_PARAMS, getScanParams, normalizeScanParams} from '../db/scan-settings'
import {RULE_LABELS, pickCandidates, type RuleKey} from '../scan/rules'

const num = (k: string, d: number): number => {
  const v = Number(process.env[k])
  return Number.isFinite(v) ? v : d
}
const bool = (k: string, d: boolean): boolean => {
  const v = process.env[k]
  if (v === undefined || v === '') return d
  return v === '1' || v === 'true' || v === 'yes'
}

/** 成交额：`1234567` → `1.23M`（终端里一眼能比大小） */
function money(usd: number): string {
  if (usd >= 1e9) return `${(usd / 1e9).toFixed(2)}B`
  if (usd >= 1e6) return `${(usd / 1e6).toFixed(2)}M`
  if (usd >= 1e3) return `${(usd / 1e3).toFixed(0)}K`
  return usd.toFixed(0)
}

function pct(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`
}

async function main(): Promise<void> {
  await ensureSchema().catch(() => undefined)

  const userId = await defaultUserId().catch(() => null)
  // 网页上配的那份当底稿，env 只覆盖给到的那几项
  const saved = userId === null ? {...DEFAULT_SCAN_PARAMS} : await getScanParams(userId)
  const params = normalizeScanParams({
    ...saved,
    timeframe: process.env.TF ?? saved.timeframe,
    perRule: num('PER_RULE', saved.perRule),
    maxPicks: num('MAX', saved.maxPicks),
    minTurnover: num('TURNOVER', saved.minTurnover),
    minAgeDays: num('AGE', saved.minAgeDays),
    excludeTopRank: num('TOP', saved.excludeTopRank),
    breakoutVol: num('BREAKOUT_VOL', saved.breakoutVol),
    dipPct: num('DIP_PCT', saved.dipPct),
    dipVol: num('DIP_VOL', saved.dipVol),
    rallyPct: num('RALLY_PCT', saved.rallyPct),
    spikeVol: num('SPIKE_VOL', saved.spikeVol),
    rules: {...saved.rules, rally: bool('RALLY', saved.rules.rally)}
  })

  const atRaw = Number(process.env.AT)
  const at = Number.isFinite(atRaw) && atRaw > 0 ? atRaw : null

  console.log(
    `参数：周期 ${params.timeframe} · 每类 ${params.perRule} · 上限 ${params.maxPicks} · ` +
      `成交额 ≥ ${money(params.minTurnover)} · 上市 ≥ ${params.minAgeDays} 天 · ` +
      (params.excludeTopRank > 0 ? `市值前 ${params.excludeTopRank} 不扫\n` : '不过滤市值排名\n') +
      `规则：${(['A', 'B', 'C', 'D'] as RuleKey[])
        .map(k => `${k}${RULE_LABELS[k]}${params.rules[
          k === 'A' ? 'breakout' : k === 'B' ? 'dip' : k === 'C' ? 'rally' : 'volume'
        ] ? '' : '(关)'}`)
        .join(' · ')}\n` +
      `阈值：A 量比 ≥ ${params.breakoutVol} · B ≤ ${pct(-params.dipPct)} 且量比 ≥ ${params.dipVol} · ` +
      `C ≥ ${pct(params.rallyPct)} · D 量比 ≥ ${params.spikeVol}\n`
  )

  const res = await pickCandidates({userId, params, at})
  const only = (process.env.DBASE ?? '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
  const picks = only.length ? res.picks.filter(p => only.includes(p.base)) : res.picks

  console.log(
    `看得见到 ${res.at}（北京时间 ${new Date(new Date(res.at).getTime() + 8 * 3600_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 16)}）· 参与打分 ${res.scanned} 个币 · 用时 ${res.ms}ms`
  )
  console.log(
    `原始命中：` +
      (['A', 'B', 'C', 'D'] as RuleKey[]).map(k => `${k} ${res.ruleHits[k]}`).join(' · ') +
      `（去重配额后 ${picks.length} 个）\n` +
      (res.rankMissing
        ? '⚠️ 市值排名没拉到 ⇒「市值前 N 不扫」这条**没生效**（CoinGecko 挂了 / 还没缓存）\n'
        : `市值前 ${params.excludeTopRank} 排掉 ${res.excludedTop} 个\n`)
  )

  if (!picks.length) {
    console.log('这一轮没有候选 —— 阈值偏严，或者行情真的没事（看上面的"参与打分"个数判断）。')
    return
  }

  const pad = (s: string, n: number): string => {
    // 中文名（`哈基米`）按两个字符宽算，否则表会歪
    const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)
    return s + ' '.repeat(Math.max(0, n - w))
  }

  console.log(
    pad('币种', 10) +
      pad('规则', 20) +
      pad('价格', 12) +
      pad('24h', 8) +
      pad('成交额', 9) +
      pad('量比', 7) +
      pad('离前高', 8) +
      '市值'
  )
  for (const p of picks) {
    console.log(
      pad(p.base, 10) +
        pad(p.ruleLabels.join('+'), 20) +
        pad(p.price < 1 ? p.price.toPrecision(4) : p.price.toFixed(2), 12) +
        pad(pct(p.pct24), 8) +
        pad(money(p.turnover24), 9) +
        pad(`${p.volRatio.toFixed(2)}×`, 7) +
        pad(pct(p.vsHigh20 * 100), 8) +
        (p.rank ? `No.${p.rank}` : '—')
    )
  }
}

main().catch((e: Error) => {
  console.error(`❌ 失败：${e.message}`)
  process.exitCode = 1
})
