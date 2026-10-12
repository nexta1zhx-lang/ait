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
export interface ShareCardCell {
  k: string
  v: string
}

export interface ShareCardData {
  /** 币种简写（已经去掉 /USDT），如 `MEGA` */
  base: string
  side: 'long' | 'short'
  leverage: number
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
 *   990  分隔线
 *  1100  第一行标签基线
 *   178  行高 → 三行标签基线 1100 / 1278 / 1456，值基线 +52（1152 / 1330 / 1508）
 *  1680  页脚分隔线（最后一行值基线 1508 + 描述符 ≈1520，留 160px）
 *  1770  页脚文字基线（下方还有 150px 到底边）
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
  divider: 990,
  cells: 1100,
  rowH: 178,
  footLine: 1680,
  foot: 1770
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

/**
 * 画一张持仓卡。
 *
 * 版面从上到下：落款行 → 币种 + 方向/杠杆 → 主角盈亏 → 分隔线 → 2×3 数据格 → 域名。
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
  pill(ctx, px, Y.pill, `${data.leverage}x`, C.gold, 'rgba(255, 193, 107, 0.13)', SZ.pill)

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
  // ⚠️ 值为 `—` 的格子**不列**：打码之后「仓位价值 —」这种读起来像漏了一格，
  //    不如干脆不提（图里留着是占位，文字里没有对齐问题）
  const bits = data.cells
    .filter(c => c.v !== '—')
    .slice(0, 4)
    .map(c => `${c.k} ${c.v}`)
  return [
    `${data.base} ${side} ${data.leverage}x`,
    // 盈亏跟百分比**同一行**，跟图里一个读法（打码时只有百分比）
    [data.hero, data.heroSub].filter(Boolean).join(' '),
    bits.join(' · '),
    data.note ? `${data.note} · bitcoooin.cn` : 'bitcoooin.cn'
  ]
    .filter(Boolean)
    .join('\n')
}
