/**
 * 回测统计（手动跑）：读 tmp-rank.ts 存下来的 JSON，算「AI top5 vs 各种基线」。
 *
 * 只有本地计算，不调模型：
 *   · 每个批次里各组的**等权均值**；把「批次」当独立样本做配对差 + bootstrap 置信区间
 *   · 分池（A 热钱池 / B 强势池）汇总
 *   · 排名的信息量：ρ(排名, MFE24) 分布
 *   · 排名的稳定性：跑两遍的 ρ / top5 重合
 */
import fs from 'fs'

interface Outcome {
  p: number
  mfe24: number
  tr24: number
  touch: number
  touched: 'up' | 'dn' | 'none'
}
interface Row {
  pool: 'A' | 'B'
  at: string
  coins: {symbol: string; ch24: number}[]
  out: Outcome[]
  rank: number[]
  rank2?: number[]
  missing: number
}

const files = process.argv.slice(2).filter(a => !a.startsWith('-'))
const rows: Row[] = []
for (const f of files) rows.push(...(JSON.parse(fs.readFileSync(f, 'utf8')) as Row[]))

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const pc = (v: number) => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%'

function rankOf(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({v, i})).sort((a, b) => a.v - b.v)
  const r = new Array<number>(xs.length)
  idx.forEach((o, j) => (r[o.i] = j + 1))
  return r
}
/** Spearman：`a` 按「越大越强」排（排名 1 = 最强，所以先取负号） */
function spearman(a: number[], b: number[]): number {
  const ra = rankOf(a.map(v => -v))
  const rb = rankOf(b)
  const ma = mean(ra)
  const mb = mean(rb)
  let n = 0
  let da = 0
  let db = 0
  for (let i = 0; i < ra.length; i++) {
    n += (ra[i]! - ma) * (rb[i]! - mb)
    da += (ra[i]! - ma) ** 2
    db += (rb[i]! - mb) ** 2
  }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : NaN
}

/** 一个批次里某组（按持仓 id）的表现 */
function arm(r: Row, ids: number[]) {
  const xs = ids.map(i => r.out[i]!).filter(Boolean)
  return {
    mfe24: mean(xs.map(o => o.mfe24)),
    tr24: mean(xs.map(o => o.tr24)),
    touch: mean(xs.map(o => o.touch)),
    up: xs.filter(o => o.touched === 'up').length / xs.length,
    dn: xs.filter(o => o.touched === 'dn').length / xs.length
  }
}

function randMean(r: Row, seed = 7): {mfe24: number; tr24: number; touch: number; up: number} {
  const k = r.coins.length
  let s = seed
  const acc: Outcome[] = []
  for (let t = 0; t < 400; t++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    let x = s
    const pick: number[] = []
    while (pick.length < 5) {
      x = (x * 1103515245 + 12345) & 0x7fffffff
      const i = x % k
      if (!pick.includes(i)) pick.push(i)
    }
    acc.push(...pick.map(i => r.out[i]!))
  }
  return {
    mfe24: mean(acc.map(o => o.mfe24)),
    tr24: mean(acc.map(o => o.tr24)),
    touch: mean(acc.map(o => o.touch)),
    up: acc.filter(o => o.touched === 'up').length / acc.length
  }
}

const ARMS = ['AI top5', 'AI bot5', '随机5', '动量24h5', '全池均值'] as const
type Arm = (typeof ARMS)[number]

function armOf(r: Row, which: Arm) {
  const k = r.coins.length
  if (which === 'AI top5') return arm(r, r.rank.slice(0, 5))
  if (which === 'AI bot5') return arm(r, r.rank.slice(-5))
  if (which === '随机5') return randMean(r)
  if (which === '全池均值') return arm(r, [...Array(k).keys()])
  const mom = r.coins
    .map((c, i) => ({i, v: c.ch24}))
    .sort((a, b) => b.v - a.v)
    .slice(0, 5)
    .map(o => o.i)
  return arm(r, mom)
}

/** 配对差 + bootstrap（重采样批次）95% 区间 */
function paired(a: number[], b: number[]): {d: number; lo: number; hi: number; win: number} {
  const diffs = a.map((v, i) => v - b[i]!)
  let s = 12345
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const boots: number[] = []
  for (let t = 0; t < 4000; t++) {
    const pick: number[] = []
    for (let i = 0; i < diffs.length; i++) pick.push(diffs[Math.floor(rnd() * diffs.length)]!)
    boots.push(mean(pick))
  }
  boots.sort((x, y) => x - y)
  return {
    d: mean(diffs),
    lo: boots[Math.floor(boots.length * 0.025)]!,
    hi: boots[Math.floor(boots.length * 0.975)]!,
    win: diffs.filter(x => x > 0).length / diffs.length
  }
}

const metric = process.env.METRIC ?? 'mfe24'
const label: Record<string, string> = {
  mfe24: '24h 最大有利(MFE)',
  tr24: '24h 实际收益',
  touch: '首触(先+15%/−10%)',
  up: '先到 +15% 的比例'
}

for (const m of ['mfe24', 'tr24', 'touch', 'up'] as const) {
  for (const pools of [['A', 'B'] as const, ['A'] as const, ['B'] as const]) {
    const sub = rows.filter(r => (pools as readonly string[]).includes(r.pool))
    if (!sub.length) continue
    console.log(`\n===== ${label[m]} · 池 ${pools.join('+')} · ${sub.length} 批次 =====`)
    const vals: Record<string, number[]> = {}
    for (const a of ARMS) vals[a] = sub.map(r => armOf(r, a)[m])
    for (const a of ARMS) {
      const d = a === 'AI top5' ? paired(vals[a]!, vals['随机5']!) : null
      const dm = a === 'AI top5' ? paired(vals[a]!, vals['动量24h5']!) : null
      console.log(
        `${a.padEnd(9)} ${(m === 'up' || m === 'touch' ? (mean(vals[a]!) * 100).toFixed(1) + '%' : pc(mean(vals[a]!))).padStart(9)}` +
          (d
            ? `   比随机5 ${pc(d.d)} [${pc(d.lo)}, ${pc(d.hi)}] 赢 ${(d.win * 100).toFixed(0)}% 批` +
              `   比动量5 ${pc(dm!.d)} [${pc(dm!.lo)}, ${pc(dm!.hi)}] 赢 ${(dm!.win * 100).toFixed(0)}% 批`
            : '')
      )
    }
  }
}

// 排名的信息量 + 稳定性
const rhos = rows.map(r => spearman(r.rank, r.out.map(o => o.mfe24)))
const rhosMom = rows.map(r => spearman(r.rank, r.coins.map(c => c.ch24)))
const rhoT = rows.map(r => spearman(r.rank, r.out.map(o => o.touch)))
const dup = rows.filter(r => r.rank2)
console.log(
  `\n===== 排名本身的信号 =====\n` +
    `ρ(排名, MFE24)：均值 ${rhos.reduce((a, b) => a + b, 0) / rhos.length >= 0 ? '' : ''}` +
    `${(mean(rhos) >= 0 ? '+' : '') + mean(rhos).toFixed(3)}  正相关批次 ${rhos.filter(v => v > 0).length}/${rhos.length}` +
    `\nρ(排名, 首触)：均值 ${(mean(rhoT) >= 0 ? '+' : '') + mean(rhoT).toFixed(3)}` +
    `\nρ(排名, 24h涨幅)：均值 ${(mean(rhosMom) >= 0 ? '+' : '') + mean(rhosMom).toFixed(3)}` +
    `（=0 说明它没在抄动量）` +
    `\n同输入跑两遍（${dup.length} 批）：ρ 均值 ${(mean(dup.map(r => spearman(r.rank, r.rank2!.map(v => -v)))) >= 0 ? '+' : '') +
      mean(dup.map(r => spearman(r.rank, r.rank2!.map(v => -v)))).toFixed(3)}` +
    ` · top5 重合均值 ${mean(dup.map(r => r.rank.slice(0, 5).filter(x => r.rank2!.slice(0, 5).includes(x)).length)).toFixed(2)}/5` +
    `\n解析失败（编号缺）批次：${rows.filter(r => r.missing > 0).length}/${rows.length}`
)
