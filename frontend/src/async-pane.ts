/**
 * 懒加载面板（`defineAsyncComponent`）的**统一外壳**（2026-10-17）。
 *
 * 用户：「账户统计**有时候打不开**」。
 *
 * 真凶不是接口慢（`/api/exchange/analytics` 实测 50ms），而是**按需下载的那块 JS**：
 *
 *   · 「账户统计」是 `defineAsyncComponent(() => import('./AccountStatsView.vue'))`
 *     —— 第一次点进去才去拉 `AccountStatsView-<hash>.js`（还连带 echarts）。
 *   · 裸 `defineAsyncComponent` 有两个难看的失效方式：
 *     ① **慢**：几秒内什么都不显示（没有 loading 占位），看着就是「点了没反应」；
 *     ② **旧 chunk 404**：**发版之后**未刷新的老页面还记着上一版的 hash，一点就 404
 *        （`index.html` 是 no-cache，但已经打开的页面不会自己换）⇒ 面板**永远**空白，
 *        除非手动刷新 —— 这就是「有时候」。
 *
 * 所以这里给三个兜底：**加载中给字**、**失败给按钮**、**旧 chunk 自动刷新一次**。
 *
 * ⚠️ 「自动刷新」一定要**限频**（`RELOAD_GUARD_MS`）：真断网时每次重试都刷新一遍，
 *    页面会自己闪个不停，比空白更糟。
 */
import {
  defineAsyncComponent,
  defineComponent,
  h,
  inject,
  provide,
  ref,
  type Component
} from 'vue'

/** 两次「自动刷新」之间至少隔这么久（防断网时刷新死循环） */
const RELOAD_GUARD_MS = 30_000
const RELOAD_KEY = 'ca_chunk_reload_at'

/**
 * 这个错误是不是「chunk 没了」。
 *
 * 浏览器 / 各内核的文案不一样，实测这几种：
 *   · `Failed to fetch dynamically imported module: http://…/AccountStatsView-abc.js`
 *   · `Importing a module script failed.`（Safari）
 *   · `error loading dynamically imported module`（Firefox）
 *   · `Unable to preload CSS for …`（Vite 的 CSS 预载）
 */
export function isStaleChunkError(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? '')
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk \d+ failed/i.test(
    msg
  )
}

/**
 * **最多刷一次**页面（拿新的 `index.html`，里面记着新 hash）。
 *
 * @returns 真的发起了刷新就 `true`；限频范围内（刚刷过）返回 `false`，调用方去走失败态。
 */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_GUARD_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // 隐私模式：没有 sessionStorage 就**不自动刷**（没法限频，宁可不刷）
    return false
  }
  location.reload()
  return true
}

/** 「重试」这件事由外层那个壳负责（见下面 `asyncPane` 的最后一段） */
const RETRY = Symbol('async-pane-retry')

function fallbackScaffold(text: string, extra?: unknown[]): ReturnType<typeof h> {
  return h('div', {class: 'pane-fallback'}, [
    h('p', {class: 'pane-fallback-title'}, text),
    ...(extra ?? [])
  ])
}

export interface AsyncPaneOptions {
  /** 面板的中文名（「正在加载账户统计…」/「账户统计没加载出来」） */
  label: string
  /** 多久没加载出来才显示占位（默认 120ms —— 快了就不闪） */
  delay?: number
}

/**
 * 包一层 `defineAsyncComponent`：加载中有字、失败有按钮、旧 chunk 自动刷新。
 *
 * 用法跟原来一模一样，只多给一个名字：
 * ```ts
 * const AccountStatsView = asyncPane(() => import('./AccountStatsView.vue'), {
 *   label: '账户统计'
 * })
 * ```
 */
export function asyncPane(
  loader: () => Promise<{default: Component}>,
  opts: AsyncPaneOptions
): Component {
  const label = opts.label

  const loading = defineComponent({
    name: 'PaneLoading',
    setup: () => () => fallbackScaffold(`正在加载${label}…`)
  })

  const failed = defineComponent({
    name: 'PaneFailed',
    props: {error: {type: Object as () => unknown, default: null}},
    setup: props => {
      /*
       * ⚠️ 别用 Vue 传给 `errorComponent` 的那套（它只给 `error`）：
       *    实测「重试」按了没反应 —— 那个 retry 是上一轮 load 里的闭包，
       *    走到 `fail()` 之后调它等于白调（页面既不刷新也不重拉）。
       *    这里改成让外层壳**换 key 重挂**（见下面 `defineComponent`），
       *    那才是真的「重新 import 一次」。
       */
      const remount = inject<() => void>(RETRY, () => location.reload())
      return () =>
        fallbackScaffold(`${label}没加载出来`, [
          h(
            'p',
            {class: 'dim'},
            String((props.error as Error)?.message ?? '').slice(0, 160) ||
              '可能是网络断了，或者刚发过版。'
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'ghost tiny',
              /*
               * ⚠️ 模块**加载失败**（404 / 网络断）只能靠**刷新页面**重来 ——
               *    浏览器的 module map 会把这次失败**按文档缓存住**，
               *    同一个 `import()` 再跑一次还是那条失败（实测：换 key 重挂也没用）。
               *    其余错误（超时之类）重新挂一次就够，不必整页刷。
               */
              onClick: () =>
                isStaleChunkError(props.error) ? location.reload() : remount()
            },
            '重试'
          )
        ])
    }
  })

  const inner = defineAsyncComponent({
    loader,
    delay: opts.delay ?? 120,
    /**
     * 超时就当失败 —— 不然一直吊着（`timeout` 只在 loader 迟迟不 resolve 时触发；
     * 真断网时浏览器可能既不 resolve 也不 reject）。
     */
    timeout: 30_000,
    loadingComponent: loading,
    errorComponent: failed,
    onError(error, retry, fail, attempts) {
      // ① 旧 chunk（发版后没刷新的页面）：重试同一个 URL 也没用，得换 HTML
      if (isStaleChunkError(error) && reloadOnce()) return
      // ② 网络抖一下：退避重试两次
      if (attempts <= 2) {
        setTimeout(retry, 300 * attempts)
        return
      }
      fail()
    }
  })

  /*
   * 外面再包一层，只做一件事：**「重试」= 换 key 重挂**。
   *
   * 换 key 之后 `inner` 是一个**新实例**，`defineAsyncComponent` 会重新跑一遍 loader
   * （上一次失败的结果不会粘着）—— 这才是用户点「重试」想要的。
   * 直接调 Vue 内部的 retry 不行（见 `failed` 里那段说明）。
   */
  return defineComponent({
    name: 'AsyncPane',
    inheritAttrs: false,
    setup(_, {attrs, slots}) {
      const tries = ref(0)
      provide(RETRY, () => {
        tries.value++
      })
      return () => h(inner, {...attrs, key: tries.value}, slots)
    }
  })
}
