<script setup lang="ts">
/**
 * 「下载 App」页 —— 独立路由 `/download`。
 *
 * 数据来自后端 `/api/downloads`：它扫 `downloads/` 目录，并把同级的
 * `releases.json`（手写的介绍 / 更新说明）合进去 —— 所以**加一版新包
 * 只要把 APK 丢进 downloads/ 并在 releases.json 里补一条**，页面自己就变了。
 *
 * ⚠️ 线上 APK 是 Caddy 按 `/dl/*` 直接发的（不走 Node）；本地没有 Caddy，
 * 由后端自己发一份。所以这里统一用 `downloadUrl()` 拼绝对地址 ——
 * 原生壳里页面跑在 `https://localhost`，相对路径会打到 WebView 自己身上。
 */
import {computed, onMounted, ref} from 'vue'
import {fetchDownloads, downloadUrl, type DownloadsResult} from '../api'
import {bjTime} from '../format'

const data = ref<DownloadsResult | null>(null)
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await fetchDownloads()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(load)

const app = computed(() => data.value?.app ?? {})
const releases = computed(() => data.value?.releases ?? [])
const latest = computed(() => releases.value.find(r => r.latest) ?? null)
const totalSize = computed(() =>
  releases.value.reduce((s, r) => s + (r.size || 0), 0)
)

/** 4,316,551 → 「4.1 MB」 */
function human(bytes: number): string {
  if (!bytes) return '—'
  const mb = bytes / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 页面上只显示前 12 位，鼠标悬停/长按能看全 */
const short = (md5: string | null) => (md5 ? md5.slice(0, 12) : '—')
</script>

<template>
  <div class="col">
    <div v-if="error" class="error">
      <b>读不到下载清单</b>
      <div>{{ error }}</div>
    </div>

    <div v-else-if="loading" class="panel dim">读取中…</div>

    <template v-else>
      <!-- ① 是什么 + 最新版下载 -->
      <section class="panel dl-hero">
        <div class="dl-hero-main">
          <span class="dl-app">{{ app.name || '开单分析' }}</span>
          <span class="dl-meta dim">
            <template v-if="latest">
              v{{ latest.version }} · {{ human(latest.size) }}
            </template>
            <template v-if="app.require"> · {{ app.require }}</template>
            <template v-if="app.packageId"> · {{ app.packageId }}</template>
          </span>
          <p class="dl-desc">{{ app.desc }}</p>
        </div>

        <a
          v-if="latest"
          class="dl-btn"
          :href="downloadUrl(latest.url)"
          :download="latest.file"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v10" />
            <path d="M8 10.5 12 14.5 16 10.5" />
            <path d="M5 18.5h14" />
          </svg>
          下载最新版 v{{ latest.version }}
        </a>
      </section>

      <!-- ② 怎么装 -->
      <section v-if="app.install?.length" class="panel">
        <h2>怎么装</h2>
        <ol class="dl-steps">
          <li v-for="(s, i) in app.install" :key="i">{{ s }}</li>
        </ol>
      </section>

      <!-- ③ 历史版本 -->
      <section class="panel">
        <h2>
          历史版本
          <span class="tag">{{ releases.length }} 个</span>
          <span v-if="totalSize" class="tag">共 {{ human(totalSize) }}</span>
        </h2>

        <div v-if="!releases.length" class="empty">
          还没打过包。在本机跑 <code>bash build-apk.sh</code>，APK 会出现在
          <code>downloads/</code> 里，这页自动就有了。
        </div>

        <div v-else class="dl-list">
          <article
            v-for="r in releases"
            :key="r.file"
            class="dl-item"
            :class="{latest: r.latest, dead: r.deprecated}"
          >
            <div class="dl-head">
              <b class="dl-ver">v{{ r.version }}</b>
              <span v-if="r.latest" class="pill ok">最新</span>
              <span v-if="r.deprecated" class="pill">已弃用</span>
              <span v-if="!r.listed" class="pill">未登记</span>
              <span class="dl-title">{{ r.title || r.file }}</span>
              <span class="dl-spacer"></span>
              <span class="dim dl-date">{{ r.date || bjTime(r.mtime) }}</span>
            </div>

            <ul v-if="r.notes.length" class="dl-notes">
              <li v-for="(n, i) in r.notes" :key="i">{{ n }}</li>
            </ul>

            <div class="dl-foot">
              <span class="dim">{{ human(r.size) }}</span>
              <span class="dim dl-md5" :title="r.md5 ?? ''">
                md5 {{ short(r.md5) }}
              </span>
              <span class="dl-spacer"></span>
              <a class="dl-mini" :href="downloadUrl(r.url)" :download="r.file">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4v10" />
                  <path d="M8 10.5 12 14.5 16 10.5" />
                  <path d="M5 18.5h14" />
                </svg>
                下载
              </a>
            </div>
          </article>
        </div>

        <p v-if="releases.length" class="dim dl-note">
          装新版本直接覆盖安装即可（同一个包名
          <code>{{ app.packageId || 'cn.bitcoooin.advisor' }}</code
          >，数据不会丢）。 想回退就下对应的旧版本号。
        </p>
      </section>
    </template>
  </div>
</template>
