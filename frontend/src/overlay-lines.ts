/**
 * K 线上的「账户叠加线」—— 仓位 / 强平 / 挂单（止盈止损也是挂单）那几条横线，
 * 外加**右侧价格轴上**的价格标签。
 *
 * 为什么不用库自带的 `createPriceLine()`？
 *   用户 2026-10-07：「修 k 线划线的样式 止损止盈和仓位的价格都放坐标轴上颜色要对应
 *   **层级最低**」——
 *   · 库那条 price line 画在**蜡烛上面**，而且没有层级开关 ⇒ 线横在 K 线上；
 *   · 想「价格挂轴上 + 颜色对应 + 线在蜡烛下面」这三样一起要，库那套做不到。
 * ⇒ 自己写一个 **series primitive**：
 *   · `paneViews()` 的视图 `zOrder: 'bottom'`（画在蜡烛**下面**，见 `PrimitivePaneViewZOrder`）；
 *   · `priceAxisViews()` 每条线一枚轴标签：底色压深、**文字用线自己的颜色**（颜色对应）。
 *
 * 拖动时线怎么走，分两种（两条路都在 `KlineChart.vue` 的 `drawDragPreview` 里）：
 *   · 拖**已挂的单** = 改单 ⇒ 那条线本身就是那张单，**挪它自己**（走 `set()` 换个价重画一遍）；
 *   · 拖**仓位线** = 新挂一张止盈 / 止损 ⇒ 走 `setPreview()`：仓位线**一动不动**，
 *     另画一条虚线跟着手指（用户 2026-10-07：「仓位拖动时，原有的仓位不动，只是多条虚线去拉」）。
 */
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType
} from 'lightweight-charts'

/** 一条要画的横线 */
export interface OverlayLine {
  price: number
  color: string
  /** 虚线（挂单 / 强平 / 拖动预览都是虚线；仓位是实线） */
  dashed?: boolean
  /** 右侧轴上的文字（不给 = 这条在轴上不挂标签） */
  axis?: string
}

export interface OverlayLines {
  /** 换一批线（数据变了 / 开关变了 / 换币） */
  set(lines: OverlayLine[]): void
  /** 拖**仓位线**时那条虚线的预览（松手 / 取消传 `null`）；拖已挂的单不走这儿 */
  setPreview(line: OverlayLine | null): void
  attach(series: ISeriesApi<SeriesType, any>): void
  detach(): void
}

/** 轴标签的底色：跟弹层同一个深色（压深才看得清线上那几种亮色） */
const AXIS_BG = '#191b1f'

/**
 * 轴上那枚小标签。
 *
 * ⚠️ 库按**数组引用**做缓存（见 typings 里 `priceAxisViews` 的说明），所以视图对象要
 *    **复用**：条数变了才重建数组，值变了只换对象里的 `line` 引用（`coordinate()` /
 *    `text()` 都现算）。
 */
interface AxisView extends ISeriesPrimitiveAxisView {
  line: OverlayLine | null
}

export function createOverlayLines(): OverlayLines {
  let lines: OverlayLine[] = []
  let preview: OverlayLine | null = null
  let views: AxisView[] = []
  let refs: SeriesAttachedParameter<any, any> | null = null

  /** 要画的全集：常态那几条 + 拖动预览那条 */
  const all = (): OverlayLine[] => (preview ? [...lines, preview] : lines)

  /** 价位 → y（拿不到就 `null`：LWC 在「这一价不在可见区间」时会给 null） */
  function yOf(price: number): number | null {
    const y = refs?.series.priceToCoordinate(price)
    return y === null || y === undefined || !Number.isFinite(y) ? null : y
  }

  /*
   * 画线本体。`paint` 同时挂给 `draw` 和 `drawBackground`：
   * `zOrder: 'bottom'` 的视图库是在**背景层**画（走 `drawBackground`），但哪一层被调用
   * 不该由我们猜 —— 两个都指过去，重复画也只是同一条 1px 线。
   */
  const paint = (target: Parameters<IPrimitivePaneRenderer['draw']>[0]): void => {
    if (!refs) return
    const list = all()
    if (!list.length) return
    target.useMediaCoordinateSpace(scope => {
      const ctx = scope.context
      const w = scope.mediaSize.width
      for (const l of list) {
        const y = yOf(l.price)
        if (y === null) continue
        /* +0.5 落在像素中心：不然 1px 的线会被摊成两条灰边 */
        const yy = Math.round(y) + 0.5
        ctx.save()
        ctx.strokeStyle = l.color
        ctx.lineWidth = 1
        ctx.setLineDash(l.dashed ? [4, 4] : [])
        ctx.beginPath()
        ctx.moveTo(0, yy)
        ctx.lineTo(w, yy)
        ctx.stroke()
        ctx.restore()
      }
    })
  }

  const renderer: IPrimitivePaneRenderer = {draw: paint, drawBackground: paint}

  const paneView: IPrimitivePaneView = {
    /* ★ 关键：画在蜡烛**下面**（用户：「层级最低」） */
    zOrder: (): PrimitivePaneViewZOrder => 'bottom',
    renderer: () => renderer
  }

  /** 条数变了才重建视图数组（库按引用缓存） */
  function rebuildViews(): void {
    const want = all().length
    if (views.length === want) return
    views = []
    for (let i = 0; i < want; i++) {
      views.push({
        line: null,
        coordinate: () => {
          const l = views[i]?.line
          return l ? (yOf(l.price) ?? -1000) : -1000
        },
        text: () => views[i]?.line?.axis ?? '',
        textColor: () => views[i]?.line?.color ?? 'transparent',
        backColor: () => AXIS_BG,
        visible: () => {
          const l = views[i]?.line
          return !!(l?.axis && yOf(l.price) !== null)
        }
      })
    }
  }

  /** 让每条视图指向当前这条线 */
  function syncViews(): void {
    const list = all()
    for (let i = 0; i < views.length; i++) views[i]!.line = list[i] ?? null
  }

  const primitive: ISeriesPrimitive<any> = {
    attached(param: SeriesAttachedParameter<any, any>): void {
      refs = param
    },
    detached(): void {
      refs = null
    },
    paneViews: () => [paneView],
    priceAxisViews: () => views
  }

  function refresh(): void {
    rebuildViews()
    syncViews()
    refs?.requestUpdate()
  }

  return {
    set(next: OverlayLine[]): void {
      lines = next
      refresh()
    },
    setPreview(next: OverlayLine | null): void {
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
