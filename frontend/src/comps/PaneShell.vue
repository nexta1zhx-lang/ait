<script setup lang="ts" generic="T extends string">
/**
 * 「一级 tab 面板」外壳：顶部一排一级 tab 固定不动，下面内容区自己滚
 * （`body.fixed-viewport`），窄屏还能**左右滑动切换**。
 *
 * 「我的」页共用这一套 —— 以前这套整个写在 `MeView.vue` 里，
 * 别的「一级 tab 面板」页要用就抽出来，行为逐字一致。
 *
 * 沿革（用户原话）：
 *   · 2026-10-04「一级 tab（底下一小段线那种）可滑动切换」
 *   · 2026-10-05「我的里面 tab 也加上切换动画丝滑一点」
 *
 * 手势调参与避让规则都在 `../swipe-tabs`，这里只负责接线。
 */
import {onBeforeUnmount, onMounted, ref, watch} from 'vue'
import SegTabs from './SegTabs.vue'
import {useSwipeTabs} from '../swipe-tabs'

defineOptions({name: 'PaneShell'})

const props = defineProps<{
  /** 当前在哪一格 */
  modelValue: T
  /** 一级 tab 的顺序（滑动按它挪一格） */
  options: {value: T; label: string; title?: string}[]
}>()

const emit = defineEmits<{(e: 'update:modelValue', v: T): void}>()

/*
 * 手势区 = **整页**（tab 行 + 内容区）。
 *
 * ⚠️ 上面那排 `.tabpane-tabs` 在窄屏是 `overflow-x: auto` 的**横向可滚**排
 *    （tab 放不下会溢出）—— 那种情况归它自己滚，`../swipe-tabs` 里那条
 *    「能横滚的元素不抢」会自己挡下来，这里不用特殊处理。
 */
const rootRef = ref<HTMLElement | null>(null)
const {onTouchStart, onTouchMove, onTouchEnd} = useSwipeTabs<T>({
  host: () => rootRef.value,
  list: () => props.options,
  current: () => props.modelValue,
  set: v => emit('update:modelValue', v)
})

/**
 * 切一级 tab 时内容「滑入」——跟「开单分析」那排一级 tab 同一套。
 * 方向跟着 tab 顺序：**往后翻 = 从右滑入**（跟翻页 / 滑动同一个方向）。
 *
 * ⚠️ 只挂 260ms 的临时类：动画播完就摘。理由跟 `AnalyzeView` 那份一样：
 *   ① 不摘的话同一个方向连划两次，class 值不变，动画不会重播；
 *   ② `transform` 长期存在会变成 `fixed` 后代的「包含块」。
 */
const paneAnim = ref<'' | 'l' | 'r'>('')
let paneAnimTimer: number | null = null
watch(
  () => props.modelValue,
  (nv, ov) => {
    const i = props.options.findIndex(o => o.value === nv)
    const j = props.options.findIndex(o => o.value === ov)
    if (i < 0 || j < 0 || i === j) return
    paneAnim.value = i > j ? 'l' : 'r'
    if (paneAnimTimer) window.clearTimeout(paneAnimTimer)
    paneAnimTimer = window.setTimeout(() => (paneAnim.value = ''), 260)
  }
)
onBeforeUnmount(() => {
  if (paneAnimTimer) window.clearTimeout(paneAnimTimer)
})

/*
 * 进来就把「整页不滚、内容区自己滚」那个 class 补上 —— 真正的开关交给
 * `App.vue` 那条按 `route.path` 的 watch（换 query 也会重跑它，见那里的说明），
 * 这里只是首帧兜底。
 *
 * ⚠️ **卸载时不要 `remove`** —— `App.vue` 那个 watch 的回调同样在跑
 * （`/analyze`、`/contracts` 也要这个 class），它的回调比 `onBeforeUnmount` 早，
 * 这里再 remove 一下会把刚加上的 class 抹掉，跳过去以后整页就变成能滚的了。
 */
onMounted(() => document.body.classList.add('fixed-viewport'))
</script>

<template>
  <div
    ref="rootRef"
    class="tabpane"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchEnd"
  >
    <SegTabs
      class="tabpane-tabs"
      :model-value="modelValue"
      :options="options"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <div class="tabpane-body" :class="paneAnim ? 'pane-' + paneAnim : ''">
      <slot />
    </div>
  </div>
</template>

<style scoped>
/*
 * 一屏铺满：顶部 tab 固定不动，下面的内容区自己滚（`overflow-y: auto`）。
 * 高度来自 `body.fixed-viewport #app`（`height: 100vh` 的 flex 列）——
 * `.tabpane` 用 `flex: 1 1 auto` 把剩余高度全占了，`min-height: 0` 是必须的，
 * 否则 flex 子项不肯缩，`overflow` 就不生效、又变回整页滚。
 */
.tabpane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.tabpane-tabs {
  flex: 0 0 auto;
}
.tabpane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 滑到头别把滚动传递给整页 */
  overscroll-behavior: contain;
  scrollbar-width: thin;
  /*
   * 滚动条**贴容器右边**，但内容跟它拉开距离 ——
   * 用户 2026-10-04：「滚动条靠边和内容区保持距离」。
   *
   * 单个 `padding-right` 会把滚动条也一起往里推（那不是要的效果），
   * 所以再加一个等量的负 `margin-right` 把它推回边上：
   * 净效果 = 轨道在容器边缘、内容离轨道 12px。
   */
  padding-right: 12px;
  margin-right: -12px;
}

/*
 * 手机上这一排（一级 tab）走**底部横线**样式 ——
 * 用户 2026-10-04：「历史用量服务器移动端 tab 改为底部横线 tab」。
 *
 * 做法跟「开单分析」那排一级 tab（`style.css` 的 `.tab-row .seg`）**逐条对齐**：
 * 不要框、不要底色、靠左排，活动项底下一条 2px 短线；
 * ⚠️ **整排不要 `border-bottom`** —— 用户 2026-10-04：「一级 tab 不需要底部一条横线，
 *   类似滑轨那样」：只有活动项那一段短线，像滑块一样跟着走。
 * （二级 tab 那一排则是背景块，两级 tab 一眼能分开。）
 *
 * ⚠️⚠️ **里面的 `<button>` 必须用 `:deep()`** —— 它们长在 `SegTabs.vue` 里，
 *   而 scoped 样式编译出来是 `.tabpane-tabs button[data-v-paneshell]`，
 *   子组件内部的元素带的是 `data-v-segtabs`，**根本匹配不上**。
 *   （`.tabpane-tabs` 自己没事：它就在 `SegTabs` 的根元素上，Vue 会把父的
 *     `data-v` 也留给子组件的根元素。）
 */
@media (max-width: 900px) {
  .tabpane-tabs {
    display: flex;
    width: auto;
    justify-content: flex-start;
    align-items: stretch;
    /* 相邻按钮之间靠 gap 拉开（`.seg` 默认是按钮紧贴 + 分隔线） */
    gap: 18px;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 0;
    /*
     * 窄屏放不下时**横向可滑**，不然最后一格会被 `#app` 的 `overflow: hidden`
     * 直接裁掉、点都点不到。滚动条本身藏掉 —— 顶部那一排要干净，
     * 滑动手感靠 `-webkit-overflow-scrolling`。
     */
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .tabpane-tabs::-webkit-scrollbar {
    display: none;
  }
  .tabpane-tabs :deep(button) {
    /* ⚠️ 基础 `.seg button` 是 `flex: 1 1 0`（等分撑满），这里必须放开，
       否则「靠左」会变成几个一样宽的方块 */
    flex: 0 0 auto;
    padding: 6px 2px 9px;
    border: 0;
    border-radius: 0;
    background: none;
    font-size: 13px;
    position: relative;
  }
  .tabpane-tabs :deep(button.active) {
    background: none;
    color: var(--blue);
  }
  .tabpane-tabs :deep(button.active::after) {
    content: '';
    position: absolute;
    left: 50%;
    /* 对齐 `.tab-row .seg`：贴着按钮底边，不是压在外面的下划线上 */
    bottom: 0;
    width: 18px;
    height: 2px;
    border-radius: 999px;
    background: var(--blue);
    transform: translateX(-50%);
  }

  /*
   * 切一级 tab 滑入 —— 跟「开单分析」那排（`style.css` 的 `.split.pane-l …`）一致。
   * `pane-l` = 往后翻（从右滑入）、`pane-r` = 往前翻（从左滑入）。
   * ⚠️ 类只挂 260ms（见 `paneAnim`）—— 动画完就摘，`transform` 不会长期存在。
   */
  .tabpane-body.pane-l {
    animation: tabpane-in-right 0.24s ease both;
  }
  .tabpane-body.pane-r {
    animation: tabpane-in-left 0.24s ease both;
  }
  @keyframes tabpane-in-right {
    from {
      opacity: 0.35;
      transform: translateX(18px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes tabpane-in-left {
    from {
      opacity: 0.35;
      transform: translateX(-18px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
}
</style>
