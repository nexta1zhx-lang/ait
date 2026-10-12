<script setup lang="ts">
/**
 * 分享弹层（2026-10-13）—— 持仓卡片的**预览 + 一键分享**。
 *
 * 用户要的是「把仓位直接同步到社交平台」。这条路选的是**系统分享面板**：
 * 点一下弹出手机自带的分享面板，微信 / 微博 / Telegram / X 全在里面 ——
 * 不用申请开发者账号、不用 token、不用审核（详见当时的方案对比）。
 *
 * 三条出路，按环境自动挑：
 *   ① **App（Capacitor 原生壳）**：把预览图**摊开**，长按它 → 系统菜单里
 *      「保存图片 / 分享图片」—— 不走 `<a download>`（WebView 不实现下载）、
 *      也不走 `navigator.share`（见下面那条坑）；
 *   ② 浏览器：`navigator.share` 能带文件就弹系统面板，不行就**下载图片**；
 *   ③ 任何时候都能**复制文案**（纯文字，什么平台都能粘）。
 *
 * ⚠️★ 两个 WebView 的坑（2026-10-13 用户实测）：
 *   · `<a download>`：安卓 WebView **不实现下载** —— 点了既不下也不报错，
 *     看着就是「按了没反应」（用户：「保存图片在移动端 app 不生效」）。
 *   · `navigator.share`：WebView **在**，`canShare({files})` 还**说 true**，
 *     可真调下去系统找不着目标 ⇒ 弹「没有可分享的软件」（用户原话）。
 *     ⇒ 所以「在不在原生壳里」这个判断是**第一句**就得判的，别等 canShare。
 *   真要在 App 里弹原生分享面板 / 一键存相册，得装 `@capacitor/share` +
 *   `@capacitor/filesystem` 两个插件再重打 APK（那是另一件事）。
 *
 * ⚠️ 样式照 `ProxyUsersPanel` / `AdminView` 那套抄（`.btn` / `.mini` 都是**各组件
 *    自己 scoped 定义**的，不是全局的）；弹层用全局 `.sheet*` + `Teleport` + `warm-skin`。
 */
import {ref, watch} from 'vue'
import {copyText} from '../clipboard'
import {isNativeShell} from '../platform'
import {showToast} from '../toast'
import {renderShareCard, type ShareCardData} from '../share-card'

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

/** 每次打开 / 切换打码 都重画一遍预览 */
watch(
  [() => props.open, masked],
  () => {
    if (!props.open) return
    try {
      preview.value = renderShareCard(props.build(masked.value).data).toDataURL('image/png')
      err.value = ''
    } catch (e) {
      err.value = (e as Error).message
    }
  },
  {immediate: true}
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
  const {data, text, filename} = props.build(masked.value)
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

/** App 里的存图 / 分享：摊开大图，让用户长按 */
function openImage(): void {
  if (!preview.value) return
  sheet.value = preview.value
  showToast('长按图片 → 保存到相册 / 分享')
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
    openImage()
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
 * ⚠️ 复制统一走 `clipboard.ts`（2026-10-13 用户：「复制…在移动端 app 不生效」）——
 *    App 的 WebView 里 `navigator.clipboard.writeText` 是**存在但会 reject** 的，
 *    原来那句 `if (navigator.clipboard?.writeText)` 命中后直接抛异常，老退路
 *    （`execCommand`）永远轮不到，用户看到的就是「复制失败」。
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
 *   ⇒ 所以 App（`isNativeShell()`）里点「保存图片」改成**把预览图摊开铺满**，
 *     让用户**长按图片**走系统那套「保存图片 / 分享图片」菜单；浏览器里照旧下载。
 *   （真要在 App 里一键存进相册，得装 `@capacitor/filesystem` + 分享插件重打 APK，
 *     那是另一件事，见 `ShareSheet` 顶部那段说明。）
 */
async function save(): Promise<void> {
  if (isNativeShell()) {
    openImage()
    return
  }
  const {blob, filename} = await current()
  download(blob, filename)
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
        点「分享」会弹出手机自带的分享面板（微信 / 微博 / Telegram / X 都在里面）。
        浏览器里没有这个面板时会改成下载图片；App 里会把大图摊开，
        长按图片即可存进相册或转发（App 的 WebView 不认「下载」这个动作）。
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
