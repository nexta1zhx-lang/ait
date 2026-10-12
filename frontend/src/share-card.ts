/**
 * 持仓分享卡 —— 在浏览器里用 canvas 画一张 1080×1920 的图（2026-10-13）。
 *
 * 为什么是 canvas 而不是服务端渲染：**分享是本地动作**（点一下弹系统面板），
 * 为一张图往返一次服务器不值当；而且服务端画还得处理中文字体。
 *
 * ⚠️ 这里**只管画，不管格式化**：货币（¥ / $）、小数位、"打码"后的文案
 *    全部由调用方（`ExchangeAccountBoard`）拼好传进来 —— 那边已经有
 *    `money()` / `qty()` / `fmt()` 和货币开关，两边各写一套必然对不上。
 *
 * ⚠️ 别用 `ctx.roundRect`：安卓 System WebView 上老版本没有，自己画（见 `rr`）。
 */
import type {Candle} from './api'

export interface ShareCardCell {
  k: string
  v: string
}

/**
 * 海报里那张小图 + 买卖点位（2026-10-13 用户：「加入缩略图」「类似分时图，可选择」
 * 「连线那种加入简单的图标 买入点位和卖出点位」）。
 *
 * ★ 2026-10-13 用户看了第一版后改口：「买入卖出直接显示在图上不要标注」——
 *   ⇒ 第 2 版把两个点位**画进小图里**（各自一条虚线 + 一个三角图标 + 价格），
 *     下面那行「买入 …→… 卖出」的标注连同中间的百分比**整行删掉**。
 *
 * ⚠️ 点位可能离这段行情很远（实测那条多单：开仓 0.04831、止盈 0.12077，而当天
 *    就在 0.045~0.050 之间晃）——**不能**为了放它俩把 y 轴拉长，否则分时线会被
 *    压成贴底的一条直线。所以：y 轴只按**这段行情自己**的高低点算，
 *    点位线**夹在图的上下边界内**画（超出的那一点点从图标/颜色上看不出来，
 *    但价格数字是**真的**，不会骗人）。
 * ⚠️ 只有数字认不出来（用户 2026-10-13 看到金色的 `0.12077` 问「这是什么」）⇒
 *    每个点位除了价格还带一个**小字**（`买入` / `卖出`），颜色跟点位一致。
 * ⚠️ `candles` 缺席（没取到行情 / 用户选「不带图」）时：整块不画 ——
 *    点位也跟着没有（它们画在图上）。
 */
/**
 * 图上要标的一个**成交点**。
 *
 * ★ 2026-10-13 这一处改了五轮，最后定成「**就是一个点**」（用户：「画点位还是不对，
 *   我现在只需要那个点，价格买入字样可以去掉」）：
 *     「连线那种加入简单的图标买入点位和卖出点位」→ 图上的横线 + 三角 + 价格；
 *     「买入卖出直接显示在图上不要标注」→ 删掉单独那行标注；
 *     「价格标注都去掉」→ 整块删掉；
 *     「买入点要加上放在线下面一点」→ 请回买入那一条；
 *     ⇒ 现在：**按成交那一刻的时间 + 价格打一个圆点**（不画横线、不写价格、
 *       不写「买入 / 卖出」四个字）。为什么之前"位置不对"：横线只表达了价格，
 *       没表达"什么时候成交的"，看着就像标错了地方。
 *
 * ⚠️ `at` 是 ISO 字符串（后端账本给的 `openAt` / `closeAt`），
 *    画的时候按它在 K 线时间轴上的位置放 x。
 */
export interface ShareCardMark {
  at: string
  price: number
  /** `buy` 绿点、`sell` 金点 —— 颜色是唯一的标识（没有文字） */
  kind: 'buy' | 'sell'
}
export interface ShareCardChart {
  /** 价格序列：分时用 `close`，K 线用 OHLC */
  candles?: Candle[]
  /** 怎么画：`line` 分时、`candle` K 线、`none` 不画（用户可切） */
  style: 'line' | 'candle' | 'none'
  /**
   * 已经成交过的买入 / 卖出（图上画成圆点）。
   * 持仓多半只有「买入」一个（还没减过仓）；仓位历史两个都有。
   */
  marks?: ShareCardMark[] | null
  /**
   * 这段持仓持续了多久（秒）—— 弹层拿它决定**用哪个周期、取多少根**，
   * 好让成交那一刻落在时间轴**里面**（不然点会跑到图外面去）。
   * `null` / 缺省 = 按一天算。
   */
  spanSec?: number | null
}

export interface ShareCardData {
  /** 币种简写（已经去掉 /USDT），如 `MEGA` */
  base: string
  side: 'long' | 'short'
  /**
   * 杠杆倍数；`null` = 不知道 / 不适用（**仓位历史**那条路就没有这个字段，
   * 账本里不存）⇒ 药丸那一行少画一颗，别写个假的 `1x`。
   */
  leverage: number | null
  /** 盈亏方向 —— 决定主色（`up` 绿 / `down` 红） */
  tone: 'up' | 'down'
  /** 主角那个大字。不打码 = `−$42.76`；打码 = `−50.96%` */
  hero: string
  /**
   * 主角**同一行、并排**跟在后面的小字（不打码时是百分比）。
   *
   * ⚠️ 2026-10-13 用户：「金额显示太大了和百分比位置不协调」—— 原来是金额一行、
   *    百分比另起一行顶在左下，两截看不出是一件事。改成并排（跟 App 持仓列表里
   *    `−$42.12 −50.02%` 同一个读法），**基线对齐**，字号是主角的一半左右。
   */
  heroSub: string | null
  /** 主角下面那行小灰字（打码时写「金额已隐藏」）；没有就不占位 */
  heroNote?: string | null
  cells: ShareCardCell[]
  /** 小图 + 买卖点位（见 `ShareCardChart`）；整块可选 */
  chart?: ShareCardChart
  /** 取小图行情用的 symbol（`MEGAUSDT`）—— 弹层拿它去 `loadCandles` */
  chartSymbol?: string
  /** 落款前面那截（例如账户名）；空则只画域名 */
  note?: string
  /** 右上角的时间；默认取当前时间（北京时间） */
  when?: Date
}

export const CARD_W = 1080
/**
 * **竖版海报 9:16**（用户 2026-10-13：「改为常用海报的大小」）。
 *
 * ⚠️ 想换成别的常用尺寸，改这一个常量 **加上**下面 `Y`/`SZ` 那两组刻度（它们是配套的，光改这个高度会留一片空白）：
 *   · 3:4 小红书  → `H = 1440`，`Y` 按 0.75 缩放
 *   · 1:1 朋友圈方图 → `H = 1080`
 */
export const CARD_H = 1920

/**
 * 版面刻度 —— **全部写在这里，改字号/间距只动这一块**。
 *
 * 纵向是**算出来的，不是拍脑袋的**（2026-10-13 用户：「比例也不对」）：
 *
 *   210  落款基线（Ait / 时间）
 *   344  药丸顶端（方向 / 杠杆，高 65 → 到 409）
 *   420  币种基线
 *   770  主角行基线（**金额 + 百分比并排**，同一基线）
 *   858  主角下面那行小灰字（只有打码时才有）
 *   900  小图区顶端（高 240 → 到 1140；买卖点位画在**图里**，见 `drawMiniChart`）
 *  1210  分隔线
 *  1280  第一行标签基线
 *   160  行高 → 三行标签基线 1280 / 1440 / 1600，值基线 +52（1332 / 1492 / 1652）
 *  1720  页脚分隔线（最后一行值基线 1652，留 68px）
 *  1810  页脚文字基线（下方还有 110px 到底边）
 *
 * ⚠️ 2026-10-13 加小图那一段时**整块往下挪了**（原 990/1100/178/1680/1770）：
 *    多出来的空间从上面挤 —— 行高 178 → 160、分隔线 990 → 1210。
 *    后来点位从"单独一行"挪进图里，那一行的 130px 就并给了小图（180 → 240）。
 *    再要加东西，先照这张表往下重算一遍。
 *
 * ⚠️ **别再让最后一行撞页脚线**：早前一版（4:5 那张）值基线 1226 而线画在 1218，
 *    「4.4% / −$0.57」直接压在线上（用户看出来的"比例不对"就是这个）。
 *    改行高/字号/画布高度后，把上面这几行重算一遍。
 *
 * 字号是**一条明确的层次链**（2026-10-13 用户：「金额显示太大了和百分比位置不协调」）：
 *
 *   136 主角金额  >  96 币种  >  62 百分比  >  46 数据值  >  34 落款/日期  >  30 数据标签  >  27 免责
 *
 * ⚠️ 主角**别往大里调**：上一版 176 铺了大半张卡，币种和百分比都被压成配角，
 *    用户直接说"太大了"。现在它只比币种大一档，靠**颜色（红/绿）**抢注意力就够了。
 * ⚠️ 百分比是 `heroSub`，它**并排**跟在主角后面（见 `renderShareCard` 里那段），
 *    不是另起一行 —— 别再拆成两行。那一段会**量总宽再整体等比缩**，
 *    所以「金额 + 百分比」再长也不会冲出画布右边。
 */
const PAD = 96
const Y = {
  header: 210,
  pill: 344,
  symbol: 420,
  hero: 770,
  heroNote: 858,
  chartTop: 900,
  chartH: 240,
  divider: 1210,
  cells: 1280,
  rowH: 160,
  footLine: 1720,
  foot: 1810
}
const SZ = {
  logo: 46,
  logoSub: 34,
  date: 34,
  symbol: 96,
  pill: 36,
  hero: 136,
  heroSub: 62,
  heroNote: 42,
  label: 30,
  /** 点位上那个小字（`开仓` / `止盈`）——比价格小一档，别再大 */
  levelTag: 26,
  value: 46,
  foot: 32,
  footNote: 27
}

const FONT =
  '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

const C = {
  bg: '#0d0c0b',
  strong: '#fff5e7',
  muted: '#aaa398',
  ok: '#72d6a0',
  bad: '#ff7480',
  gold: '#ffc16b',
  line: 'rgba(255, 255, 255, 0.08)'
}

/** 圆角矩形（自己画，别用 `ctx.roundRect`） */
function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rad = Math.min(r, h / 2, w / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

function font(ctx: CanvasRenderingContext2D, size: number, weight = 400): void {
  ctx.font = `${weight} ${size}px ${FONT}`
}

/** 药丸标签（方向 / 杠杆）—— 高度和内边距都跟着字号走，字号在 `SZ.pill` */
function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  bg: string,
  size: number
): number {
  font(ctx, size, 600)
  const padX = Math.round(size * 0.72)
  const w = ctx.measureText(text).width + padX * 2
  const h = Math.round(size * 1.8)
  ctx.fillStyle = bg
  rr(ctx, x, y, w, h, h / 2)
  ctx.fill()
  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + padX, y + h / 2 + 2)
  return w
}

function bjParts(d: Date): {date: string; time: string} {
  const t = new Date(d.getTime() + 8 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`
  }
}


/* ---------------- 小图（分时 / K 线） + 买卖点位行 ---------------- */

/**
 * 分时线 / K 线小图。
 *
 * ⚠️ 价格**自己归一化**（这段行情自己的高低点），所以跟卡片上那些点位数字
 *    没有比例关系 —— 只表示"这段时间是怎么走过来的"。
 * ⚠️ K 线一根根画、分时一条折线：同一个函数里分叉，别复制两份（版面常量共用）。
 */
function drawMiniChart(ctx: CanvasRenderingContext2D, chart: ShareCardChart, tone: string): void {
  const list = (chart.candles ?? []).filter(c => Number.isFinite(c.close))
  if (chart.style === 'none' || list.length < 2) return

  const x = PAD
  const w = CARD_W - PAD * 2
  const y = Y.chartTop
  const h = Y.chartH

  /*
   * ⚠️ 这里**不要**给图加底色（2026-10-13 用户：「不要背景色」）——
   *    早前有一层 `rgba(255,255,255,0.03)` 的圆角底，看着多出一块灰板子。
   *    现在只有线本身（分时那条折线 + 面积渐变本身是"线的一部分"，保留）。
   */
  /*
   * ⚠️ 价格范围 = **这段行情的高低点 ∪ 两个点位**（2026-10-13 用户：「买点卖点的位置
   *    还是不对」）。
   *
   *    早前只按行情算范围，成交点落在范围外时被**夹到图的上下边界**上画 ——
   *    数字是真的，位置却是假的，看着就是"标的不是那个地方"。
   *    现在把点位并进范围：图上每一个点的 y 都对得上它的价格。
   *    代价：点位离行情很远时（比如亏了 60%，开仓价在行情上方一大截）分时线会被
   *    压扁一些 —— 这是"位置正确"必须付的，用户要的是真位置。
   *
   * 用户也问过「选取的范围怎么定的」：时间 = 最近 24 小时（15 分钟 × 96 根，
   * 见 `ShareSheet.vue` 的 `SHARE_TF` / `SHARE_BARS`），价格 = 上面这一句。
   */
  let lo = Infinity
  let hi = -Infinity
  for (const c of list) {
    lo = Math.min(lo, c.low > 0 ? c.low : c.close)
    hi = Math.max(hi, c.high > 0 ? c.high : c.close)
  }
  for (const m of chart.marks ?? []) {
    if (Number.isFinite(m.price) && m.price > 0) {
      lo = Math.min(lo, m.price)
      hi = Math.max(hi, m.price)
    }
  }
  if (!(hi > lo)) hi = lo + Math.max(1e-9, Math.abs(lo) * 0.001)
  const air = (hi - lo) * 0.12
  lo -= air
  hi += air
  const py = (p: number) => y + h - ((p - lo) / (hi - lo)) * h

  ctx.save()
  rr(ctx, x, y, w, h, 18)
  ctx.clip()

  if (chart.style === 'candle') {
    const slot = w / list.length
    const bw = Math.max(1.5, slot * 0.62)
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      const cx = x + slot * (i + 0.5)
      const up = c.close >= c.open
      ctx.strokeStyle = up ? C.ok : C.bad
      ctx.fillStyle = up ? C.ok : C.bad
      ctx.lineWidth = Math.max(1, slot * 0.12)
      ctx.beginPath()
      ctx.moveTo(cx, py(c.high > 0 ? c.high : c.close))
      ctx.lineTo(cx, py(c.low > 0 ? c.low : c.close))
      ctx.stroke()
      const top = py(Math.max(c.open, c.close))
      const bot = py(Math.min(c.open, c.close))
      ctx.fillRect(cx - bw / 2, top, bw, Math.max(1.5, bot - top))
    }
  } else {
    const step = w / (list.length - 1)
    const at = (i: number) => ({x: x + step * i, y: py(list[i].close)})

    const g = ctx.createLinearGradient(0, y, 0, y + h)
    g.addColorStop(0, `${tone}2e`)
    g.addColorStop(1, `${tone}00`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(x, y + h)
    for (let i = 0; i < list.length; i++) {
      const p = at(i)
      ctx.lineTo(p.x, p.y)
    }
    ctx.lineTo(x + w, y + h)
    ctx.closePath()
    ctx.fill()

    ctx.strokeStyle = tone
    ctx.lineWidth = 3
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let i = 0; i < list.length; i++) {
      const p = at(i)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()

    // 末端画个点：一眼看出"现在在哪"
    const end = at(list.length - 1)
    ctx.beginPath()
    ctx.arc(end.x - 4, end.y, 7, 0, Math.PI * 2)
    ctx.fillStyle = tone
    ctx.fill()
  }
  ctx.restore()
  /*
   * 已经成交的那几个点：**按时间 + 价格**打一个小圆点（用户：「我现在只需要那个点，
   * 价格买入字样可以去掉」）。没有横线、没有价格数字、没有「买入 / 卖出」四个字 ——
   * 绿点 = 买入、金点 = 卖出，颜色就是唯一的标识。
   *
   * ⚠️ x 用**这一笔成交的时间**（`mark.at`）在 K 线时间轴上插值 ——
   *    这是"位置不对"的真正原因：横线只表达了价格，没表达"什么时候成交的"。
   *    ⚠️ 所以时间轴必须覆盖住持仓那一段，见 `ShareSheet.vue` 的 `pickSpan()`
   *    （按持仓时长选周期 / 根数，否则点会跑到图外面）。
   * ⚠️ 外面留一圈底色描边，深色图上才看得清（尤其点正好压在分时线上时）。
   */
  const t0 = list[0].timestamp
  const tN = list[list.length - 1].timestamp
  const span = tN - t0
  for (const m of chart.marks ?? []) {
    const t = Date.parse(m.at)
    if (!Number.isFinite(t) || !Number.isFinite(m.price) || m.price <= 0) continue
    const k = span > 0 ? (t - t0) / span : 0
    /* 时间落在窗口外（比如刚开仓、K 线还没收到那一根）就贴着边画，别丢点 */
    const mx = x + Math.min(Math.max(k, 0), 1) * w
    const my = Math.min(Math.max(py(m.price), y + 20), y + h - 20)
    const color = m.kind === 'sell' ? C.gold : C.ok
    ctx.beginPath()
    ctx.arc(mx, my, 13, 0, Math.PI * 2)
    ctx.fillStyle = C.bg
    ctx.fill()
    ctx.beginPath()
    ctx.arc(mx, my, 9, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  }
}

/**
 * 画一张持仓卡。
 *
 * 版面从上到下：落款行 → 币种 + 方向/杠杆 → 主角盈亏 → 分隔线 → 2×3 数据格 → 域名。
 *
 * ★ 2026-10-13 用户：「加入缩略图」「类似分时图，可选择」⇒ 在主角盈亏和分隔线之间
 *   插了一张**小图**（成交点画在图里，见 `drawMiniChart` / `ShareCardMark`，刻度在 `Y` 里）。
 */
export function renderShareCard(data: ShareCardData): HTMLCanvasElement {
  const cvs = document.createElement('canvas')
  cvs.width = CARD_W
  cvs.height = CARD_H
  const ctx = cvs.getContext('2d')
  if (!ctx) throw new Error('这个环境拿不到 canvas 2d 上下文')

  const tone = data.tone === 'up' ? C.ok : C.bad

  /* ---------- 底：深色 + 右上暖金、左下冷灰两团光（跟应用里那套一致） ----------
     光斑半径跟着画布走：竖版海报比 4:5 高一截，半径还按宽度算的话下半张会发死。 */
  const R = Math.max(CARD_W, CARD_H) * 0.62
  ctx.fillStyle = C.bg
  ctx.fillRect(0, 0, CARD_W, CARD_H)

  const g1 = ctx.createRadialGradient(CARD_W * 0.86, CARD_H * 0.05, 0, CARD_W * 0.86, CARD_H * 0.05, R)
  g1.addColorStop(0, 'rgba(255, 193, 107, 0.13)')
  g1.addColorStop(1, 'rgba(255, 193, 107, 0)')
  ctx.fillStyle = g1
  ctx.fillRect(0, 0, CARD_W, CARD_H)

  const g2 = ctx.createRadialGradient(CARD_W * 0.08, CARD_H * 0.26, 0, CARD_W * 0.08, CARD_H * 0.26, R)
  g2.addColorStop(0, 'rgba(120, 136, 163, 0.12)')
  g2.addColorStop(1, 'rgba(120, 136, 163, 0)')
  ctx.fillStyle = g2
  ctx.fillRect(0, 0, CARD_W, CARD_H)

  // 一圈极淡的暖色描边，让图在浅色背景的信息流里也立得住
  ctx.strokeStyle = 'rgba(48, 39, 29, 0.9)'
  ctx.lineWidth = 2
  rr(ctx, 1, 1, CARD_W - 2, CARD_H - 2, 0)
  ctx.stroke()

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  /* ---------- 头：落款 + 时间 ---------- */
  const when = bjParts(data.when ?? new Date())
  font(ctx, SZ.logo, 700)
  ctx.fillStyle = C.gold
  ctx.fillText('Ait', PAD, Y.header)
  const logoW = ctx.measureText('Ait').width
  font(ctx, SZ.logoSub, 400)
  ctx.fillStyle = C.muted
  ctx.fillText('· 合约持仓', PAD + logoW + 16, Y.header)

  font(ctx, SZ.date, 400)
  ctx.fillStyle = C.muted
  ctx.textAlign = 'right'
  ctx.fillText(`${when.date} ${when.time}`, CARD_W - PAD, Y.header)
  ctx.textAlign = 'left'

  /* ---------- 币种 + 方向 / 杠杆 ---------- */
  font(ctx, SZ.symbol, 700)
  ctx.fillStyle = C.strong
  ctx.fillText(data.base, PAD, Y.symbol)
  let px = PAD + ctx.measureText(data.base).width + 28

  const sideText = data.side === 'short' ? '空' : '多'
  const sideColor = data.side === 'short' ? C.bad : C.ok
  const sideBg = data.side === 'short' ? 'rgba(255, 116, 128, 0.14)' : 'rgba(114, 214, 160, 0.14)'
  px += pill(ctx, px, Y.pill, sideText, sideColor, sideBg, SZ.pill) + 14
  // 仓位历史那一版没有杠杆（`null`）⇒ 这一颗不画
  if (data.leverage !== null) {
    pill(ctx, px, Y.pill, `${data.leverage}x`, C.gold, 'rgba(255, 193, 107, 0.13)', SZ.pill)
  }

  /* ---------- 主角：盈亏（金额 + 百分比**并排**，同一基线） ---------- */
  ctx.textBaseline = 'alphabetic'
  const GAP = 26
  const maxW = CARD_W - PAD * 2
  // 量一遍「金额 + 间隔 + 百分比」的总宽，超了就**整体等比压**（大额盈亏不会冲出版面）
  font(ctx, SZ.hero, 700)
  let wHero = ctx.measureText(data.hero).width
  let wSub = 0
  if (data.heroSub) {
    font(ctx, SZ.heroSub, 600)
    wSub = ctx.measureText(data.heroSub).width
  }

  const total = wHero + (data.heroSub ? GAP + wSub : 0)
  const scale = total > maxW ? maxW / total : 1

  font(ctx, Math.round(SZ.hero * scale), 700)
  ctx.fillStyle = tone
  ctx.fillText(data.hero, PAD, Y.hero)
  wHero = ctx.measureText(data.hero).width

  if (data.heroSub) {
    font(ctx, Math.round(SZ.heroSub * scale), 600)
    ctx.globalAlpha = 0.8
    ctx.fillText(data.heroSub, PAD + wHero + Math.round(GAP * scale), Y.hero)
    ctx.globalAlpha = 1
  }

  if (data.heroNote) {
    font(ctx, SZ.heroNote, 400)
    ctx.fillStyle = C.muted
    ctx.fillText(data.heroNote, PAD, Y.heroNote)
  }

  /* ---------- 小图（买卖点位画在图里；没有 `chart` 就整块跳过） ---------- */
  if (data.chart) {
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    drawMiniChart(ctx, data.chart, tone)
  }

  /* ---------- 分隔线 ---------- */
  ctx.strokeStyle = C.line
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(PAD, Y.divider)
  ctx.lineTo(CARD_W - PAD, Y.divider)
  ctx.stroke()

  /* ---------- 数据格：2 列 × N 行 ---------- */
  const colW = (CARD_W - PAD * 2) / 2
  data.cells.forEach((c, i) => {
    const x = PAD + (i % 2) * colW
    const y = Y.cells + Math.floor(i / 2) * Y.rowH
    font(ctx, SZ.label, 400)
    ctx.fillStyle = C.muted
    ctx.fillText(c.k, x, y)
    font(ctx, SZ.value, 600)
    ctx.fillStyle = C.strong
    ctx.fillText(c.v, x, y + Math.round(SZ.value * 1.12))
  })

  /* ---------- 落款 ---------- */
  ctx.strokeStyle = C.line
  ctx.beginPath()
  ctx.moveTo(PAD, Y.footLine)
  ctx.lineTo(CARD_W - PAD, Y.footLine)
  ctx.stroke()

  font(ctx, SZ.foot, 400)
  ctx.fillStyle = C.muted
  const note = data.note ? `${data.note} · ` : ''
  ctx.fillText(`${note}bitcoooin.cn`, PAD, Y.foot)

  font(ctx, SZ.footNote, 400)
  ctx.textAlign = 'right'
  ctx.fillStyle = C.muted
  ctx.globalAlpha = 0.75
  ctx.fillText('数据来自币安合约 · 仅供参考', CARD_W - PAD, Y.foot)
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'

  return cvs
}

/** 复制到社交平台的那段纯文字（比图省事，桌面端也能用） */
export function shareText(
  data: Pick<ShareCardData, 'base' | 'side' | 'leverage' | 'hero' | 'heroSub' | 'cells' | 'note'>
): string {
  const side = data.side === 'short' ? '空' : '多'
  const lev = data.leverage === null ? '' : ` ${data.leverage}x`
  // ⚠️ 值为 `—` 的格子**不列**：打码之后「仓位价值 —」这种读起来像漏了一格，
  //    不如干脆不提（图里留着是占位，文字里没有对齐问题）
  const bits = data.cells
    .filter(c => c.v !== '—')
    .slice(0, 4)
    .map(c => `${c.k} ${c.v}`)
  return [
    `${data.base} ${side}${lev}`,
    // 盈亏跟百分比**同一行**，跟图里一个读法（打码时只有百分比）
    [data.hero, data.heroSub].filter(Boolean).join(' '),
    bits.join(' · '),
    data.note ? `${data.note} · bitcoooin.cn` : 'bitcoooin.cn'
  ]
    .filter(Boolean)
    .join('\n')
}
