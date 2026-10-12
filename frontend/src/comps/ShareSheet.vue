<script setup lang="ts">
/**
 * 分享弹层（2026-10-13）—— 持仓卡片的**预览 + 一键分享**。
 *
 * 用户要的是「把仓位直接同步到社交平台」。这条路选的是**系统分享面板**：
 * 点一下弹出手机自带的分享面板，微信 / 微博 / Telegram / X 全在里面 ——
 * 不用申请开发者账号、不用 token、不用审核（详见当时的方案对比）。
 *
 * 三条出路，按环境自动挑：
 *   ① `navigator.share` 且支持带文件（`navigator.canShare({files})`）→ 弹系统面板；
 *   ② 桌面浏览器 / 不支持的 WebView → **下载图片**（提示「长按 / 点保存」）；
 *   ③ 任何时候都能**复制文案**（纯文字，什么平台都能粘）。
 *
 * ⚠️ Capacitor 的安卓 WebView **没有** Web Share API（那是 Chrome 的能力，不是
 *    WebView 的）。所以在 App 里点「分享」大概率会走 ② —— 真要在 App 里弹面板，
 *    得装 `@capacitor/share` + `@capacitor/filesystem` 两个插件再重打 APK。
 *
 * ⚠️ 样式照 `ProxyUsersPanel` / `AdminView` 那套抄（`.btn` / `.mini` 都是**各组件
 *    自己 scoped 定义**的，不是全局的）；弹层用全局 `.sheet*` + `Teleport` + `warm-skin`。
 */
import {ref, watch} from 'vue'
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

/** 存图（桌面浏览器 / 不支持的 WebView 都走这里） */
async function save(): Promise<void> {
  const {blob, filename} = await current()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function doShare(): Promise<void> {
  if (busy.value) return
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
    // 退路：存图 + 说明怎么办
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    showToast('这台设备没有系统分享面板，图片已存下 —— 去相册 / 下载里发')
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

async function copyText(): Promise<void> {
  const {text} = props.build(masked.value)
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      // WebView / 非安全上下文里没有 clipboard API，退回到老办法
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    showToast('文案已复制')
  } catch {
    showToast('复制失败，长按下面的图 / 手动选吧', 'bad')
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

      <!-- `.chk` 是全局的（style.css:775）：flex + 7px + 13px，项目里所有勾选行都用它 -->
      <label class="chk">
        <input v-model="masked" type="checkbox" />
        <span>隐去金额（只留百分比）</span>
      </label>

      <div class="sbtns">
        <button class="btn" type="button" @click="copyText">复制文案</button>
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
        桌面浏览器或 App 的 WebView 里没有这个面板时会自动改成下载图片。
      </p>
    </section>
  </Teleport>
</template>

<style scoped>
.share-sheet {
  gap: 10px;
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
/* `.dim` 是全局的（style.css），这里不再重复 */
.small {
  font-size: 11.5px;
}
</style>
