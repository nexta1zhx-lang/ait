/**
 * 按官方规则列出某一年（或某个月）每天算高峰还是空闲，用来核对节假日表。
 *
 *   npm run peak            # 今年
 *   npm run peak -- 2026    # 指定年
 *   npm run peak -- 2026-10 # 只列一个月
 *
 * 高峰 = 北京时间周一~周五（不含法定节假日）的 9:00-12:00 与 14:00-18:00。
 */
import {CN_HOLIDAYS, beijingParts, peakText} from '../llm/cn-holidays'
import {isPeak} from '../llm/pricing'

const arg = (process.argv[2] ?? '').trim()
const now = beijingParts(new Date())
const year = Number((arg || now.ymd).slice(0, 4)) || Number(now.ymd.slice(0, 4))
const month = arg.length === 7 ? Number(arg.slice(5, 7)) : 0

const WD = ['日', '一', '二', '三', '四', '五', '六']
const pad = (n: number) => String(n).padStart(2, '0')

const from = month ? `${year}-${pad(month)}-01` : `${year}-01-01`
const to = month
  ? `${year}-${pad(month)}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`
  : `${year}-12-31`

console.log(`\n=== ${from} ~ ${to} 高峰 / 空闲（北京时间）===`)
console.log(
  '  高峰 = 周一~周五（不含法定节假日）9:00-12:00、14:00-18:00；其余全天空闲（半价）\n'
)
console.log('   日期        周   9-12   14-18   判定')
console.log('   ' + '-'.repeat(46))

const end = Date.parse(`${to}T00:00:00Z`)
for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
  const d = new Date(t)
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  // 取当天北京时间 10:00 和 15:00 两个点做判断
  const am = new Date(Date.parse(`${ymd}T02:00:00Z`)) // 北京 10:00
  const pm = new Date(Date.parse(`${ymd}T07:00:00Z`)) // 北京 15:00
  const hol = CN_HOLIDAYS.has(ymd) ? ' 节假日' : ''
  console.log(
    `   ${ymd}   ${WD[d.getUTCDay()]}    ` +
      `${isPeak(am) ? '高峰' : '空闲'}   ${isPeak(pm) ? '高峰' : '空闲'}    ` +
      `${peakText(am)}${hol}`
  )
}
console.log('')
