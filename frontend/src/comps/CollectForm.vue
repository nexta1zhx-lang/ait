<script setup lang="ts">
/**
 * 添加案例。
 *
 * 币种、周期跟着右边 K 线走，**时间段只能在图上拖一段**：
 *   · 拖了 → 就提炼那一段，一根不多一根不少
 *   · 没拖 → 不给分析（复盘得有明确的起止，不能拿「现在」凑一段）
 *
 * ⚠️ 2026-10-03 用户要求：
 *   ① 「取消复盘的时间绑定」—— 以前这里会跟着右侧 K 线日历选的那个时间走，
 *      现在完全脱钩（那个日历只负责看盘）；
 *   ② 「不拖就不分析」—— 原来没拖就以「现在」为中心前后各拉 200 根，
 *      那条路也砍了。
 *
 * 提炼时会一并算出**这一段结束时**那一刻的 4H / 日线压力支撑喂给 AI
 * （只用那一刻之前的 K 线，不吃未来数据）。
 * 收录过程一步步显示在「分析过程」里。
 */
import {computed, onBeforeUnmount, ref} from 'vue'
import SymbolCombo from './SymbolCombo.vue'
import StepsPanel from './StepsPanel.vue'
import {collectStream, type AnalyzeStep, type CollectResult} from '../api'
import {contracts, refreshConfig} from '../store'
import {bjTime, fmt, moveCls, moveText} from '../format'
import {failRunning, mergeStep} from '../steps'

const props = defineProps<{
  compact?: boolean
  /** 传了就跟它走（开单分析里跟着右侧的币种 / K 线周期） */
  symbol?: string
  timeframe?: string
  /** 右侧 K 线选的周期 —— 跟它走 */
  timeframe?: string
  /** 右侧图上画好的范围（毫秒）—— **必须有**，没有就不让提炼 */
  range?: {from: number; to: number; bars: number} | null
  /** 是不是正等着我在图上拖一段 */
  drawing?: boolean
}>()

const emit = defineEmits<{
  (e: 'done', r: CollectResult): void
  /** 点「画范围」/「取消」—— 交给右边 K 线图进/出拖动模式 */
  (e: 'draw-range', v: boolean): void
  /** 把图上画的范围清掉 */
  (e: 'clear:select'): void
}>()

const TIMEFRAMES = [
  {value: '5m', label: '5 分钟'},
  {value: '15m', label: '15 分钟'},
  {value: '1h', label: '1 小时'},
  {value: '4h', label: '4 小时'},
  {value: '1d', label: '日线'}
]

/* ---------------- 表单 ---------------- */

/** 没传 props 时才用得上（比如单独打开这个组件） */
const ownSymbol = ref('')
const ownTimeframe = ref('4h')

/** 币种 / 周期跟着外面走（开单分析里就是右侧那套） */
const following = computed(() => !!(props.symbol && props.timeframe))
const symbolValue = computed(() =>
  following.value ? (props.symbol ?? '') : ownSymbol.value
)
const timeframeValue = computed(() =>
  following.value ? (props.timeframe ?? '4h') : ownTimeframe.value
)

const note = ref('')

const collecting = ref(false)
const error = ref('')
const collected = ref<CollectResult | null>(null)
const steps = ref<AnalyzeStep[]>([])

/* ---------------- 收录（带进度） ---------------- */

let closeStream: (() => void) | null = null
onBeforeUnmount(() => closeStream?.())

async function collect() {
  const s = symbolValue.value.trim().toUpperCase()
  if (!s) {
    error.value = '请先选币种，例如 MAGMA'
    return
  }

  // 没画范围就没得提炼：复盘要有明确的起止，「现在」不是一段行情
  const r = props.range
  if (!r) {
    error.value =
      '先在右边图上拖一段行情（点「画范围」），不然不知道该复盘哪一段'
    return
  }

  closeStream?.()
  collecting.value = true
  error.value = ''
  collected.value = null
  steps.value = []

  const base = {symbol: s, timeframe: timeframeValue.value, note: note.value}
  closeStream = collectStream(
    {...base, from: r.from, to: r.to, exact: true},
    {
      onStep(step) {
        mergeStep(steps.value, step)
      },
      onDone(res) {
        // 后端给的 steps 是完整终态，直接覆盖
        if (res.steps?.length) steps.value = res.steps
        collected.value = res
        note.value = ''
        collecting.value = false
        closeStream = null
        emit('done', res)
        void refreshConfig()
      },
      onError(msg) {
        error.value = msg
        failRunning(steps.value, msg)
        collecting.value = false
        closeStream = null
      }
    }
  )
}
</script>

<template>
  <div class="collect-form" :class="{compact: !!props.compact}">
    <section class="panel">
      <h2>
        添加案例
        <span class="tag">AI 提炼</span>
      </h2>
      <p class="hint">
        时间段<b>只能</b>在右边图上拖一段：点下面的「画范围」，再在右边图上横向拖，
        就只提炼那一段，一根不多一根不少。<b>不拖就不分析</b> ——
        复盘总得有明确的起止，不能拿「现在」凑一段。
        提炼时会一并算出<b>这一段结束时</b>那一刻的 4H 和日线压力 支撑喂给
        AI（只吃那一刻之前的数据）。
      </p>

      <div class="fields">
        <!-- 币种 / 周期跟着右侧选 -->
        <div v-if="following" class="follow-row">
          <span class="k">币种 · 周期</span>
          <span class="v">
            {{ symbolValue }} · {{ timeframeValue }}
            <em>跟着右边选的</em>
          </span>
        </div>
        <template v-else>
          <label class="field">
            <span>币种</span>
            <SymbolCombo
              v-model="ownSymbol"
              :contracts="contracts"
              @submit="collect"
            />
          </label>
          <label class="field">
            <span>周期</span>
            <select v-model="ownTimeframe">
              <option v-for="t in TIMEFRAMES" :key="t.value" :value="t.value">
                {{ t.label }}
              </option>
            </select>
          </label>
        </template>

        <!-- 时间段：只能在图上拖一段。不跟 K 线日历绑（那个日历只负责看盘），
             也不拿「现在」凑数 —— 不拖就不分析。 -->
        <div class="follow-row" :class="{picked: !!range}">
          <span class="k">{{ range ? '范围' : '时间段' }}</span>
          <span class="v">
            <template v-if="range">
              {{ bjTime(range.from) }} → {{ bjTime(range.to) }}
              <em>{{ range.bars }} 根 · 就是图上画的那一段</em>
            </template>
            <template v-else-if="drawing">
              在右边图上拖一段…
              <em>横向拖，松手就选好（按 Esc 取消）</em>
            </template>
            <template v-else>
              还没画
              <em>不拖就没得分析：点「画范围」，再去右边图上横向拖一段</em>
            </template>
          </span>

          <button
            type="button"
            class="ghost tiny range-btn"
            :class="{on: drawing}"
            :title="
              drawing
                ? '在图上横向拖一段，松手就算选好（Esc 取消）'
                : '在图上拖出一段 K 线，只提炼这一段'
            "
            @click="emit('draw-range', !drawing)"
          >
            {{ drawing ? '取消' : range ? '重画' : '画范围' }}
          </button>
          <button
            v-if="range"
            type="button"
            class="ghost tiny"
            title="清掉范围，改回按时间点前后各 200 根"
            @click="emit('clear:select')"
          >
            清掉
          </button>
        </div>

        <label class="field">
          <span>我的备注（可选）</span>
          <input
            v-model="note"
            placeholder="回调不破，右侧进的"
            @keydown.enter="collect"
          />
        </label>
      </div>

      <!-- 底部：直接开拉（没画范围就不让点） -->
      <div class="collect-bottom">
        <button
          class="btn-block go"
          :disabled="collecting || !range"
          :title="range ? '' : '先在右边图上拖一段行情'"
          @click="collect"
        >
          {{
            collecting
              ? '拉取 + 提炼中…'
              : range
                ? '拉取行情并提炼'
                : '先在图上拖一段'
          }}
        </button>
      </div>

      <div v-if="error" class="error" style="margin-top: 10px">
        {{ error }}
      </div>
    </section>

    <!-- 收录过程：一步步显示在干什么 -->
    <StepsPanel
      :steps="steps"
      :done="!!collected"
      :running="collecting"
      hint="点「拉取行情并提炼」后，这里会逐步写出：拉行情 → 算这一刻的 4H / 日线压力支撑 → 把行情切成小段读结构 → 调模型提炼经验 → 记账并存进知识库。"
    />

    <!-- 提炼结果 -->
    <section v-if="collected" class="panel result">
      <div class="grade-row">
        <div class="move-badge" :class="moveCls(collected.moveType)">
          {{ moveText(collected.moveType) }}
        </div>
        <div class="grade-title">
          <span class="conf"
            >{{ collected.symbol }} · {{ collected.timeframe }}</span
          >
        </div>
      </div>

      <p class="coach-line">{{ collected.lesson || '（空）' }}</p>

      <div v-if="collected.tags.length" class="result-tags">
        <span v-for="t in collected.tags" :key="t" class="tag-chip">{{
          t
        }}</span>
        <span class="tag-hint">（AI 只能从模板里挑，自造的一律丢掉）</span>
      </div>

      <details v-if="collected.why" class="result-why">
        <summary>为什么会这样走</summary>
        <p>{{ collected.why }}</p>
        <div class="feat">
          <span v-if="collected.features.structure">
            结构：{{ collected.features.structure }}
          </span>
          <span v-if="collected.features.volume">
            量能：{{ collected.features.volume }}
          </span>
          <span v-if="collected.features.rhythm">
            节奏：{{ collected.features.rhythm }}
          </span>
        </div>
      </details>

      <!-- AI 分析过程：喂进去什么、它回了什么，全摆出来 -->
      <details class="result-proc">
        <summary>AI 分析过程（喂了什么 → 回了什么）</summary>

        <div class="proc-block">
          <b>这次喂给 AI 的行情口径</b>
          <div class="proc-line">
            {{ collected.window.bars }} 根 ·
            {{ collected.meta.promptChars }} 字行情明细
            <template v-if="collected.meta.sr.length">
              <br />
              大周期压力支撑（那一刻的，不含之后的数据）：
              <span
                v-for="s in collected.meta.sr"
                :key="s.timeframe"
                class="sr-chip"
              >
                {{ s.timeframe }} 支撑 {{ fmt(s.support) }} / 压力
                {{ fmt(s.resistance) }}（{{ s.bars }} 根）
              </span>
            </template>
            <template v-else>
              <br /><em>这次没拿到 4H / 日线数据</em>
            </template>
          </div>
        </div>

        <details class="proc-block">
          <summary>看喂进去的原文</summary>
          <pre class="proc-pre">{{ collected.meta.prompt }}</pre>
        </details>

        <details class="proc-block">
          <summary>看模型原样返回</summary>
          <pre class="proc-pre">{{ collected.meta.raw }}</pre>
        </details>
      </details>

      <div class="result-meta">
        <span>
          {{ (collected.stats.changePct ?? 0) >= 0 ? '+' : ''
          }}{{ collected.stats.changePct ?? 0 }}% · 振幅
          {{ collected.stats.rangePct ?? 0 }}% · 回撤 -{{
            collected.stats.maxDrawdownPct ?? 0
          }}%
        </span>
        <span class="dim">
          {{ bjTime(collected.window.start) }} →
          {{ bjTime(collected.window.end) }} · {{ collected.window.bars }} 根
        </span>
        <span class="dim">
          {{ collected.title }} · 本次
          {{
            collected.meta.warning
              ? '模拟提炼，不计费'
              : collected.meta.usage.text
          }}
        </span>
      </div>

      <RouterLink class="archived-link" to="/me?p=replay&r=kb">
        已存进知识库 → 去看卡片
      </RouterLink>
    </section>
  </div>
</template>

<style scoped>
.collect-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.collect-form .fields {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.collect-form .field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9px;
}

/* 「圈一段行情」那一行的样式在 style.css 里（实时分析 · 测试 也共用同一套） */

/* ---------------- 底部按钮 ---------------- */

.collect-bottom {
  display: flex;
  align-items: stretch;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.collect-bottom .go {
  flex: 1 1 auto;
  padding: 7px 10px;
  font-weight: 600;
}

/* ---------------- 结果 ---------------- */

.result .coach-line {
  margin: 10px 0 8px;
}

.move-badge {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  border: 1px solid var(--border);
}

.move-badge.up {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 55%, transparent);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
}
.move-badge.down {
  color: var(--bad);
  border-color: color-mix(in srgb, var(--bad) 55%, transparent);
  background: color-mix(in srgb, var(--bad) 12%, transparent);
}
.move-badge.range {
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 55%, transparent);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.result-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-bottom: 8px;
}

.result-tags .tag-hint {
  font-size: 10.5px;
  color: var(--muted);
}

/* ---------------- AI 分析过程 ---------------- */

.result-proc {
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--muted);
}

.result-proc > summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--blue);
}

.result-proc .proc-block {
  margin-top: 7px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel-2);
  line-height: 1.65;
}

.result-proc .proc-block > b {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--text);
}

.result-proc .proc-block > summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--blue);
}

.result-proc .proc-line {
  font-size: 11px;
}

.result-proc .sr-chip {
  display: inline-block;
  margin: 3px 6px 0 0;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel);
  font-family: var(--mono);
  color: var(--text);
}

.result-proc .proc-pre {
  max-height: 260px;
  margin: 6px 0 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.tag-chip {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--blue);
  border-radius: 999px;
  color: var(--blue);
  background: color-mix(in srgb, var(--blue) 10%, transparent);
}

.result-why {
  margin-bottom: 8px;
  font-size: 11.5px;
  color: var(--muted);
}

.result-why summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--blue);
}

.result-why p {
  margin: 6px 0;
  line-height: 1.65;
}

.result-why .feat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
  line-height: 1.6;
}

.result-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--muted);
}

.result .archived-link {
  display: inline-block;
  margin-top: 9px;
  font-size: 11px;
}
</style>
