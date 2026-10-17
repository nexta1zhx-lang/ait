/**
 * K 线上的**用户画线**（用户 2026-10-17：「改为划线模式，点击 k 线顶部出现常用的
 * k 线画图线」）。
 *
 * 为什么又写一个 primitive（`overlay-lines.ts` 是账户那几条横线）：
 *   · 账户线要压在**蜡烛下面**（用户定的层级最低），画线要**盖在蜡烛上面**才看得清；
 *   · 账户线只有水平一种，画线有**斜的**（趋势线）和**方块**（矩形），
 *     要用到时间轴那套坐标（`timeToCoordinate`），形状也不是一条横线能表达的。
 *
 * 画法跟 `overlay-lines.ts` 一样：`paneViews()` 里挂一个 renderer，**每次重画都现算坐标**
 * —— 拖动 / 缩放 / 往前补历史都会自动跟上，不用自己去订阅视图变化。
 *
 * ⚠️ 这里只负责「画」和「点没点中」；拖动新建、弹层、存库都在 `KlineChart.vue`。
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time
} from 'lightweight-charts'

/** 一个点：时间（LWC 的秒级时间戳）+ 价 */
export interface DrawPoint {
  t: number
  p: number
}

export type DrawingKind = 'hline' | 'trend' | 'rect'

/** 存库的那份（跟前端 `KlineChart` / 后端 `kline_drawings.items` 一一对应） */
export interface DrawingItem {
  id: string
  kind: DrawingKind
  /** 水平线的价 */
  p?: number
  /** 趋势线 / 矩形的两个端点 */
  a?: DrawPoint
  b?: DrawPoint
}

/** 画的时候要用的形状：坐标已经算好，或者由调用方现算 */
export type DrawShape =
  | {id: string; kind: 'hline'; price: number; color: string; axis?: string}
  | {id: string; kind: 'trend'; a: DrawPoint; b: DrawPoint; color: string}
  | {id: string; kind: 'rect'; a: DrawPoint; b: DrawPoint; color: string}

export interface DrawingsApi {
  /** 换一批（`selected` = 高亮那条；拖动中的临时线走 `preview`） */
  set(items: DrawShape[], selected?: string | null): void
  setPreview(item: DrawShape | null): void
  attach(series: ISeriesApi<SeriesType, any>): void
  detach(): void
}

export function createDrawings(): DrawingsApi {
  let items: DrawShape[] = []
  let preview: DrawShape | null = null
  let selected: string | null = null
  let refs: SeriesAttachedParameter<any, any> | null = null

  const all = (): DrawShape[] => (preview ? [...items, preview] : items)

  function yOf(price: number): number | null {
    const y = refs?.series.priceToCoordinate(price)
    return y === null || y === undefined || !Number.isFinite(y) ? null : y
  }

  function xOf(t: number): number | null {
    const x = refs?.chart.timeScale().timeToCoordinate(t as Time)
    return x === null || x === undefined || !Number.isFinite(x) ? null : x
  }

  const paint = (target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void => {
    if (!refs) return
    const list = all()
    if (!list.length) return
    target.useMediaCoordinateSpace(scope => {
      const ctx = scope.context
      const w = scope.mediaSize.width
      for (const it of list) {
        const hot = it.id === selected
        ctx.save()
        ctx.strokeStyle = it.color
        ctx.lineWidth = hot ? 2 : 1
        ctx.setLineDash([])
        if (it.kind === 'hline') {
          const y = yOf(it.price)
          if (y === null) {
            ctx.restore()
            continue
          }
          /* +0.5 落在像素中心，1px 线才不糊 */
          const yy = Math.round(y) + 0.5
          ctx.beginPath()
          ctx.moveTo(0, yy)
          ctx.lineTo(w, yy)
          ctx.stroke()
          /*
           * 线右端那枚小标签（价 + 有提醒时的铃铛）。
           * ⚠️ 不用 `priceAxisViews()` 挂到价格轴上：那层的字是库按刻度自己排的，
           *    实测会被刻度文字压住看不见（而且位置只差几像素就更糟）。画在画布右端最稳。
           */
          if (it.axis) {
            const padX = 4
            const h = 13
            ctx.font = '10px var(--mono, monospace)'
            const tw = ctx.measureText(it.axis).width
            const bx = w - tw - padX * 2 - 2
            const by = yy - h / 2
            ctx.fillStyle = 'rgba(12,16,22,0.78)'
            ctx.fillRect(bx, by, tw + padX * 2, h)
            ctx.fillStyle = it.color
            ctx.textBaseline = 'middle'
            ctx.fillText(it.axis, bx + padX, yy)
          }
        } else {
          const x1 = xOf(it.a.t)
          const y1 = yOf(it.a.p)
          const x2 = xOf(it.b.t)
          const y2 = yOf(it.b.p)
          if (x1 === null || y1 === null || x2 === null || y2 === null) {
            ctx.restore()
            continue
          }
          if (it.kind === 'rect') {
            const l = Math.min(x1, x2)
            const t = Math.min(y1, y2)
            const rw = Math.abs(x2 - x1)
            const rh = Math.abs(y2 - y1)
            ctx.fillStyle = withAlpha(it.color, hot ? 0.14 : 0.07)
            ctx.fillRect(l, t, rw, rh)
            ctx.strokeRect(Math.round(l) + 0.5, Math.round(t) + 0.5, Math.round(rw), Math.round(rh))
          } else {
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
            /* 两个端点各一个小圈：拖完看得出来线头在哪 */
            if (hot) {
              for (const [x, y] of [
                [x1, y1],
                [x2, y2]
              ] as const) {
                ctx.beginPath()
                ctx.arc(x, y, 3, 0, Math.PI * 2)
                ctx.fillStyle = it.color
                ctx.fill()
              }
            }
          }
        }
        ctx.restore()
      }
    })
  }

  const renderer: IPrimitivePaneRenderer = {draw: paint}

  const paneView: IPrimitivePaneView = {
    /* 画线要**盖在蜡烛上面**（跟账户线相反，见文件头） */
    zOrder: (): PrimitivePaneViewZOrder => 'top',
    renderer: () => renderer
  }

  const primitive: ISeriesPrimitive<any> = {
    attached(param: SeriesAttachedParameter<any, any>): void {
      refs = param
    },
    detached(): void {
      refs = null
    },
    paneViews: () => [paneView]
  }

  function refresh(): void {
    refs?.requestUpdate()
  }

  return {
    set(next: DrawShape[], sel: string | null = null): void {
      items = next
      selected = sel
      refresh()
    },
    setPreview(next: DrawShape | null): void {
      preview = next
      refresh()
    },
    attach(series: ISeriesApi<SeriesType, any>): void {
      series.attachPrimitive(primitive)
    },
    detach(): void {
      refs?.series.detachPrimitive(primitive)
      refs = null
    }
  }
}

/** `#rrggbb` → `rgba(...,a)`（矩形要半透明填充） */
function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return `rgba(88,166,255,${a})`
  const n = parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export interface HitCtx {
  /** 时间 → 图上 x（拿不到给 null） */
  xOf(t: number): number | null
  /** 价 → 图上 y（拿不到给 null） */
  yOf(p: number): number | null
  /** 图上 y → 价 */
  priceAt(y: number): number | null
}

export interface DrawHit {
  id: string
  /** 点中的是**这条线的哪个价**（加提醒就用它 —— 水平线就是线价，斜线是那一处的价） */
  price: number
}

/** 点到某条线了吗（容差按像素给；后画的优先） */
export function hitTest(
  items: DrawingItem[],
  x: number,
  y: number,
  ctx: HitCtx,
  tol = 9
): DrawHit | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.kind === 'hline') {
      if (!Number.isFinite(it.p)) continue
      const ly = ctx.yOf(it.p as number)
      if (ly !== null && Math.abs(y - ly) <= tol) return {id: it.id, price: it.p as number}
      continue
    }
    const a = it.a
    const b = it.b
    if (!a || !b) continue
    const x1 = ctx.xOf(a.t)
    const y1 = ctx.yOf(a.p)
    const x2 = ctx.xOf(b.t)
    const y2 = ctx.yOf(b.p)
    if (x1 === null || y1 === null || x2 === null || y2 === null) continue
    if (it.kind === 'rect') {
      const l = Math.min(x1, x2)
      const r = Math.max(x1, x2)
      const t = Math.min(y1, y2)
      const bot = Math.max(y1, y2)
      const onEdge =
        (x >= l - tol && x <= r + tol && (Math.abs(y - t) <= tol || Math.abs(y - bot) <= tol)) ||
        (y >= t - tol && y <= bot + tol && (Math.abs(x - l) <= tol || Math.abs(x - r) <= tol))
      if (onEdge) {
        const p = ctx.priceAt(y)
        if (p !== null) return {id: it.id, price: p}
      }
      continue
    }
    /* 趋势线：点到线段距离 */
    if (distToSegment(x, y, x1, y1, x2, y2) <= tol) {
      const dx = x2 - x1
      /* 竖着的情况 x 一样 —— 直接用点击高度那个价 */
      const ratio = Math.abs(dx) < 0.5 ? 0.5 : (x - x1) / dx
      const p = a.p + (b.p - a.p) * Math.max(0, Math.min(1, ratio))
      return {id: it.id, price: p}
    }
  }
  return null
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 < 0.0001) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t))
}
