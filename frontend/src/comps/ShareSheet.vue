<script setup lang="ts">
/**
 * 分享弹层（2026-10-13）—— 持仓卡片的**预览 + 一键分享**。
 *
 * 用户要的是「把仓位直接同步到社交平台」。这条路选的是**系统分享面板**：
 * 点一下弹出手机自带的分享面板，微信 / 微博 / Telegram / X 全在里面 ——
 * 不用申请开发者账号、不用 token、不用审核（详见当时的方案对比）。
 *
 * 三条出路，按环境自动挑：
 *   ① **App（Capacitor 原生壳）**：走原生插件（`native-share.ts`）——
 *      PNG 落到 cache → `@capacitor/share` 真弹系统面板（分享 / 保存都从那儿选）；
 *   ② 浏览器：`navigator.share` 能带文件就弹系统面板，不行就**下载图片**；
 *   ③ 任何时候都能**复制文案**（原生剪贴板 → Clipboard API → `execCommand`）。
 *
 * ⚠️★ WebView 那串坑（2026-10-13 用户连着报了三轮，逐条实测）：
 *   · `<a download>`：安卓 WebView **不实现下载** —— 点了既不下也不报错，
 *     看着就是「按了没反应」（用户：「保存图片在移动端 app 不生效」）。
 *   · `navigator.share`：WebView **在**，`canShare({files})` 还**说 true**，
 *     可真调下去系统找不着目标 ⇒ 弹「没有可分享的软件」（用户原话）。
 *   · 「长按图片 → 保存」那条退路**也不成立**：这一版 WebView 的长按菜单里
 *     根本没有保存图片（用户：「无法长按保存，分享也是出来保存图片的界面」）。
 *   ⇒ 所以 App 里这三件事（分享 / 保存 / 复制）**全都得走原生**，
 *     APK 里必须装 `@capacitor/share` + `@capacitor/filesystem`（+ clipboard）。
 *     老 APK 上插件不存在 ⇒ `native-share.ts` 返回 false，这里退回「摊开大图」，
 *     至少让用户看到"图在这儿"，而不是什么都不发生。
 *
 * ⚠️ 样式照 `ProxyUsersPanel` / `AdminView` 那套抄（`.btn` / `.mini` 都是**各组件
 *    自己 scoped 定义**的，不是全局的）；弹层用全局 `.sheet*` + `Teleport` + `warm-skin`。
 */
import {ref, watch} from 'vue'
import {loadCandles} from '../candles'
import {copyText} from '../clipboard'
import {blobToBase64, nativeShareImage} from '../native-share'
import {isNativeShell} from '../platform'
import {showToast} from '../toast'
import {renderShareCard, type ShareCardData} from '../share-card'
import type {Candle} from '../api'
import SegTabs from './SegTabs.vue'

const props = defineProps<{
  /** 弹层开着吗 */
  open: boolean
  /**
   * 给「是否打码」画出一份数据。
   *
   * ⚠️ 做成**回掉**而不是数据：货币（¥/$）、小数位、打码后的文案都由外层拼
   *    （它才有 `money()` / 货币开关），这一层只负责画和发。
   */
  build: (masked: boolean) => {data: ShareCardData; text: string; filename: string}
}>()

const emit = defineEmits<{'close': []}>()

/**
 * 默认**不隐藏金额**。
 *
 * 判断依据：这一层有**预览**——真发出去之前你看到的就是那张图，
 * 数字不对可以当场点「隐去金额」重画。所以默认按"分享仓位就是为了给人看数"
 * 来定，安全的那一档留一个开关。（要改成默认打码就改这个初值。）
 */
const masked = ref(false)
const preview = ref('')
const busy = ref('')
const err = ref('')

/**
 * 摊开的大图（只有 App 用得上）。
 *
 * ★ 2026-10-13 用户：「保存图片…在移动端 app 不生效」。App 是 Capacitor 的
 *   WebView —— `<a download>` 那条路**它不实现**（点了既不下也不报错），所以
 *   App 里改成：把预览图铺满屏幕，用户**长按**它，走安卓系统那套
 *   「保存图片 / 分享图片」菜单。（真要一键进相册得装原生插件重打 APK。）
 */
const sheet = ref('')

/*
 * 海报里那张小图（2026-10-13 用户：「加入缩略图」「类似分时图，可选择」）。
 *
 * 用户能在弹层里切：分时 / K 线 / 不带。数据是**这一层**去取的（外层只交 symbol
 * 和两个点位 —— 它手上没有 K 线），取到之后并进 `data.chart.candles` 再画。
 */
type ChartStyle = 'line' | 'candle' | 'none'
const chartStyle = ref<ChartStyle>('line')
const CHART_OPTS: {value: ChartStyle; label: string; title?: string}[] = [
  {value: 'line', label: '分时', title: '最近一天的走势（折线）'},
  {value: 'candle', label: 'K 线', title: '最近一天的 K 线'},
  {value: 'none', label: '不带', title: '海报上不放小图'}
]
/** 小图那串价格（分时折线 / K 线都画它） */
const series = ref<Candle[] | null>(null)
/** 取行情时那句提示（小字，画在选项右边） */
const chartNote = ref('')

/** 15 分钟 × 96 ≈ 一天 —— 「分时图」要的就是"今天怎么走的" */
const SHARE_TF = '15m'
const SHARE_BARS = 96

/**
 * 把这一层取到的小图组装进外层给的那份数据里。
 *
 * ⚠️ `chart` 这一整块**由这一层生成**（外层只交 `chartSymbol`）：K 线是这儿异步取的，
 *    让两层各写一半必然对不上。没 symbol / 没取到 / 用户选「不带」都走 `style:'none'`。
 */
function buildData(): {data: ShareCardData; text: string; filename: string} {
  const out = props.build(masked.value)
  out.data.chart = {
    style: out.data.chartSymbol && series.value?.length ? chartStyle.value : 'none',
    candles: series.value ?? undefined
  }
  return out
}

/** 每次打开 / 切打码 / 切图表样式 / 行情回来 都重画一遍预览 */
watch(
  [() => props.open, masked, chartStyle, series],
  () => {
    if (!props.open) return
    try {
      preview.value = renderShareCard(buildData().data).toDataURL('image/png')
      err.value = ''
    } catch (e) {
      err.value = (e as Error).message
    }
  },
  {immediate: true}
)

/** 打开弹层时取一次行情（`loadCandles` 自己带 30 秒 memo，反复开关不会重复请求） */
watch(
  () => props.open,
  async open => {
    if (!open) return
    const sym = props.build(masked.value).data.chartSymbol
    series.value = null
    chartNote.value = ''
    if (!sym) {
      chartStyle.value = 'none'
      return
    }
    chartNote.value = '取行情…'
    try {
      const r = await loadCandles(sym, SHARE_TF, SHARE_BARS)
      series.value = r.payload.candles?.length ? r.payload.candles : null
      if (!series.value) {
        chartStyle.value = 'none'
        chartNote.value = '这个币没取到行情，海报不带图'
      } else {
        chartNote.value = ''
      }
    } catch {
      series.value = null
      chartStyle.value = 'none'
      chartNote.value = '这个币没取到行情，海报不带图'
    }
  }
)

function toBlob(cvs: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    cvs.toBlob(b => (b ? resolve(b) : reject(new Error('生成图片失败'))), 'image/png')
  })
}

async function current(): Promise<{
  blob: Blob
  file: File
  text: string
  filename: string
}> {
  const {data, text, filename} = buildData()
  const cvs = renderShareCard(data)
  const blob = await toBlob(cvs)
  return {blob, file: new File([blob], filename, {type: 'image/png'}), text, filename}
}

/** `<a download>` 那条路：**只有浏览器认**（原因见上面 save() 的说明） */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 老 APK（没装插件）的最后退路：把大图摊开，让用户自己长按 */
function openImage(): void {
  if (!preview.value) return
  sheet.value = preview.value
  showToast('长按图片试试；存不了就说明该更新 App 了（新版能直接分享 / 保存）')
}

/**
 * App 里的「分享 / 保存」都走原生（见 `native-share.ts`）。
 *
 * `kind='share'` 带上文案；`kind='save'` 只给图 —— 两者最终都落到系统面板，
 * 用户在里面选「微信 / 相册 / 文件」。**安卓侧没有"直接写进相册"的公开 API**
 * （要 MediaStore，得再引一个社区插件），所以「保存图片」这一步是
 * "把图交给系统面板、由用户挑保存目标"，比原来那条死路强。
 */
async function nativeSend(kind: 'share' | 'save'): Promise<boolean> {
  const {blob, text, filename} = await current()
  const base64 = await blobToBase64(blob)
  return nativeShareImage({
    base64,
    filename,
    text: kind === 'share' ? text : undefined,
    title: '持仓分享',
    dialogTitle: kind === 'share' ? '分享到' : '保存图片'
  })
}

async function doShare(): Promise<void> {
  if (busy.value) return
  /*
   * ⚠️★ **App 里别碰 `navigator.share`**（2026-10-13 用户实测踩到的坑）。
   *
   * 用户报：「点击分享后提示没有可分享的软件，浏览器是可以的」。
   * 根因：Capacitor 的安卓 WebView **有** `navigator.share`，而且
   * `canShare({files})` 会**说 true**（它对带文件分享是"假支持"），
   * 可真调下去系统那边找不到能收这个 `content://` 文件的目标 ⇒
   * 弹一条「没有可分享的软件」，分享没成、还把人吓一跳。
   * （浏览器没事：那是 Chrome 完整实现，能真的唤起系统面板带图。）
   *
   * ⇒ App（`isNativeShell()`）里**直接**走下面那条「摊开大图」的路：
   *   长按图片 → 系统菜单里就有「保存图片 / 分享图片」，效果一样、还没有假面板。
   *   想真在 App 里弹原生分享面板，只有装 `@capacitor/share` 重打 APK（见文件头）。
   */
  if (isNativeShell()) {
    busy.value = 'share'
    try {
      if (await nativeSend('share')) return
      // 插件不在（老 APK）→ 退回大图
      openImage()
    } catch (e) {
      err.value = (e as Error).message
    } finally {
      busy.value = ''
    }
    return
  }
  busy.value = 'share'
  try {
    const {file, blob, text, filename} = await current()
    const nav = navigator as Navigator & {canShare?: (d: {files: File[]}) => boolean}
    const canFiles = typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({files: [file]})
    if (canFiles) {
      try {
        await nav.share!({files: [file], text})
        return
      } catch (e) {
        // 用户在面板上点了取消：什么都不做，别弹错
        if ((e as Error).name === 'AbortError') return
      }
    }
    // 退路：浏览器里没有系统分享面板 ⇒ 下载图片
    download(blob, filename)
    showToast('这台设备没有系统分享面板，图片已存下 —— 去相册 / 下载里发')
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

/**
 * 复制文案。
 *
 * ⚠️ 复制统一走 `clipboard.ts`：原生剪贴板插件（新 APK）→ Clipboard API →
 *    `execCommand`。App 的 WebView 里 `navigator.clipboard.writeText` 是**存在但会
 *    reject** 的，原来那句 `if (navigator.clipboard?.writeText)` 命中后直接抛异常，
 *    老退路永远轮不到，用户看到的就是「复制失败」。
 */
async function onCopy(): Promise<void> {
  const {text} = props.build(masked.value)
  const ok = await copyText(text)
  if (ok) showToast('文案已复制')
  else showToast('复制失败，长按下面的图 / 手动选吧', 'bad')
}

/**
 * 存图。
 *
 * ★ 2026-10-13 用户：「保存图片…在移动端 app 不生效」—— 根因是 `<a download>` 那个
 *   `download` 属性**在 WebView 里没人理**：安卓 WebView 不实现下载，点了既不下、
 *   也不报错，看着就是「按了没反应」。原来的说明还写着「App 里会自动改成下载图片」，
 *   那是错的——App 里那条路也是死路。
 *   ⇒ App（`isNativeShell()`）里现在走 `nativeSend('save')`：PNG 落 cache →
 *     `@capacitor/share` 弹系统面板（在那儿选相册 / 文件 / 微信）；
 *     浏览器里照旧下载。
 *   ⚠️ 长按大图那条退路**这条路堵了**（用户实测：WebView 长按菜单里没有保存图片），
 *     所以只在「老 APK 没有插件」时才走它，而且提示语要说明该更新 App。
 */
async function save(): Promise<void> {
  if (!isNativeShell()) {
    const {blob, filename} = await current()
    download(blob, filename)
    return
  }
  if (busy.value) return
  busy.value = 'save'
  try {
    if (await nativeSend('save')) showToast('在系统面板里选「保存到相册 / 文件」')
    else openImage()
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="sheet-mask" @click="emit('close')" />
    <section
      v-if="props.open"
      class="sheet warm-skin share-sheet"
      role="dialog"
      aria-label="分享持仓"
    >
      <header class="sheet-head">
        <b>分享这条持仓</b>
        <button type="button" class="sheet-x" title="关闭" @click="emit('close')">✕</button>
      </header>

      <p v-if="err" class="err">{{ err }}</p>

      <!-- 预览：发出去的就是这张图 -->
      <img v-if="preview" class="prev" :src="preview" alt="持仓分享图预览" />

      <!--
        海报里那张小图（用户 2026-10-13：「加入缩略图」「类似分时图，可选择」）——
        `.seg` 是全局的分段按钮（style.css:849），组件是通用的 `SegTabs`。
      -->
      <div class="chart-row">
        <span class="cr-label">小图</span>
        <SegTabs v-model="chartStyle" :options="CHART_OPTS" />
        <span v-if="chartNote" class="cr-note">{{ chartNote }}</span>
      </div>

      <!-- `.chk` 是全局的（style.css:775）：flex + 7px + 13px，项目里所有勾选行都用它 -->
      <label class="chk">
        <input v-model="masked" type="checkbox" />
        <span>隐去金额（只留百分比）</span>
      </label>

      <div class="sbtns">
        <button class="btn" type="button" @click="onCopy">复制文案</button>
        <button class="btn" type="button" :disabled="Boolean(busy)" @click="save">保存图片</button>
        <button
          class="btn primary"
          type="button"
          :disabled="Boolean(busy)"
          @click="doShare"
        >
          {{ busy === 'share' ? '处理中…' : '分享' }}
        </button>
      </div>

      <p class="hint dim small">
        点「分享」会弹出手机自带的分享面板（微信 / 微博 / Telegram / X 都在里面）；
        「保存图片」也交给那个面板 —— 在里面选相册 / 文件就行。
        浏览器里没有这个面板时会改成下载图片。
      </p>
    </section>

    <!--
      App 里「保存图片 / 分享」的落点（2026-10-13）：铺满整屏的大图 + 一句「长按」提示。
      ⚠️ 点空白处关掉的是**背景那层**（`.img-full-mask`）—— 别把点击挂到整块容器上，
         否则长按结束时那一下 click 会把图收掉，系统菜单刚弹出来就被关。
    -->
    <div v-if="sheet" class="img-full">
      <div class="img-full-mask" @click="sheet = ''" />
      <div class="img-full-box" role="dialog" aria-label="保存图片">
        <img :src="sheet" alt="持仓分享图">
        <p class="img-tip">长按图片 → 保存到相册 / 分享</p>
        <button class="btn" type="button" @click="sheet = ''">关闭</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * ⚠️ `display: flex` 这一句是**必须的**（2026-10-13 修的）：全局 `.sheet` 是块级
 *    （`style.css` 那条只有 position / padding / 圆角），所以原来那句 `gap: 10px`
 *    **压根没生效** —— 预览图、勾选行、按钮行上下紧贴，一点缝都没有。
 *    用户报「隐去金额上下加间距」就是这个观感。
 */
.share-sheet {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/*
 * 「隐去金额」这一行再各留 6px（10 + 6 = 上下各 16px）——它是**开关**，
 * 上面是预览大图、下面是三颗动作按钮，紧贴任一边都会被当成那一组的一部分。
 */
.share-sheet .chk {
  margin: 6px 0;
}

/* 小图那一行：标签 + 分段按钮 +（取行情时的）小字提示 */
.chart-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cr-label {
  flex: none;
  font-size: 13px;
  color: var(--text);
}
.cr-note {
  min-width: 0;
  font-size: 11.5px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prev {
  display: block;
  width: 100%;
  /* 卡是 9:16 竖版海报，46vh 在手机上只剩巴掌大 ⇒ 放到 58vh */
  max-height: 58vh;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel-2);
}
.sbtns {
  display: flex;
  gap: 8px;
}
.sbtns .btn {
  flex: 1 1 0;
  min-width: 0;
}
/* 按钮（跟 AdminView / ProxyUsersPanel 同一套值） */
.btn {
  padding: 8px 14px;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm, 10px);
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
}
.btn.primary {
  border-color: transparent;
  background: var(--accent, #d3b583);
  color: var(--accent-ink, #17140f);
  font-weight: var(--fw-mid, 500);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.hint {
  margin: 0;
  line-height: 1.6;
}
.err {
  margin: 0;
  font-size: 12.5px;
  color: var(--bad);
}
/* App 里的长按存图层（z-index 记在 style.css 顶部的层次表里：330） */
.img-full {
  position: fixed;
  inset: 0;
  z-index: 330;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px calc(12px + env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom))
    calc(12px + env(safe-area-inset-left));
}
.img-full-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.86);
}
.img-full-box {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  max-height: 100%;
}
.img-full-box img {
  display: block;
  max-width: 100%;
  /* 留出提示 + 按钮那两行的高度，图再怎么大也不会把按钮顶出屏幕 */
  max-height: calc(100vh - 120px);
  border-radius: 12px;
  background: var(--panel-2);
}
.img-tip {
  margin: 0;
  font-size: 12.5px;
  color: var(--text);
}
/* `.dim` 是全局的（style.css），这里不再重复 */
.small {
  font-size: 11.5px;
}
</style>
