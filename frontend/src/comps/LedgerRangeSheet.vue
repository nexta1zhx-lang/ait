<script setup lang="ts">
/**
 * 「周期范围」底部弹窗 —— 仓位历史 / 成交历史 / 资金动向 右上角那个按钮打开的（用户 2026-10-07）。
 *
 * 用户原话：「右侧配置一个按钮点击底部弹窗可选择周期范围，**提供快捷时间**，
 *          资金动向还要提供**不同类型的资金过滤**」。
 *
 * 所以这里两段：
 *   ① **快捷时间**：今天 / 近 7 天 / 近 30 天 / 近 90 天 / 自定义（自定义才露起止日期）；
 *   ② **资金类型**（只有资金动向那一格传 `types` 才画）：已实现 / 手续费 / 资金费 / 划转 / 其它。
 *
 * ⚠️ 时间一律按**北京时间**算（用户看的就是北京时间）：
 *    「今天」= 北京时间今天 00:00 → 现在；「近 N 天」= 今天往前数 N 个自然日的 00:00 → 现在。
 *    算出来是毫秒时间戳交给后端（那边只当两个毫秒数用，见 `server.ts` 的 `ledgerRange`）。
 * ⚠️ 弹窗里改的只是**草稿**，点「完成」才往外 emit —— 点着快捷时间不放会连着打接口。
 */
import {computed, ref, watch} from 'vue'
import {
  bjDayValue,
  LEDGER_TYPES,
  OTHER_TYPE,
  rangeToInterval,
  type RangeKey
} from '../ledger'
import {bjTime} from '../format'

const props = defineProps<{
  modelValue: boolean
  /** 标题里写是哪一格（「仓位历史 · 周期范围」） */
  title: string
  range: RangeKey
  from: number | null
  to: number | null
  /** 现在选中的资金类型（`null` / 空 = 全部）；**要不要画那一段看 `typeFilter`** */
  types?: string[] | null
  /**
   * 画不画「资金类型」那一段（只有资金动向是 `true`）。
   *
   * ⚠️ 别拿 `types` 的真假当开关：默认就是「全部」（`null`），
   *    那样这一段会在默认状态下**整段消失**（实测踩过：资金动向里根本找不到类型过滤）。
   */
  typeFilter?: boolean
  /** 这一格现在筛了多少笔（底部那句「共 N 笔」） */
  count?: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'apply', v: {
    range: RangeKey
    from: number | null
    to: number | null
    types: string[] | null
  }): void
}>()

const PRESETS: {value: RangeKey; label: string}[] = [
  {value: 'today', label: '今天'},
  {value: '7d', label: '近 7 天'},
  {value: '30d', label: '近 30 天'},
  {value: '90d', label: '近 90 天'},
  {value: 'custom', label: '自定义'}
]

const draftRange = ref<RangeKey>('7d')
const draftFrom = ref('')
const draftTo = ref('')
const draftTypes = ref<string[]>([])

watch(
  () => props.modelValue,
  open => {
    if (!open) return
    draftRange.value = props.range
    draftFrom.value = bjDayValue(props.from) || bjDayValue(bjDayStart(Date.now(), 6))
    draftTo.value = bjDayValue(props.to) || bjDayValue(Date.now())
    draftTypes.value = [...(props.types ?? [])]
  },
  {immediate: true}
)

/** 快捷时间对应的实际区间（自定义时用两个日期框） */
const resolved = computed(() =>
  rangeToInterval(draftRange.value, draftFrom.value, draftTo.value)
)

const preview = computed(() => {
  const {from, to} = resolved.value
  if (!from || !to) return '选好开始和结束的日期'
  return `${bjTime(from)} → ${bjTime(to)}`
})

function toggleType(v: string): void {
  const set = new Set(draftTypes.value)
  if (set.has(v)) set.delete(v)
  else set.add(v)
  draftTypes.value = [...set]
}

function apply(): void {
  const {from, to} = resolved.value
  emit('apply', {
    range: draftRange.value,
    from,
    to,
    types: draftTypes.value.length ? draftTypes.value : null
  })
  emit('update:modelValue', false)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="sheet-mask" @click="emit('update:modelValue', false)" />
    <section
      v-if="modelValue"
      class="sheet sheet-confirm range-sheet"
      role="dialog"
      aria-label="周期范围"
    >
      <header class="rr-h">
        <h3>{{ title }} · 周期范围</h3>
        <button
          type="button"
          class="sheet-x rr-x"
          title="关闭"
          @click="emit('update:modelValue', false)"
        >
          ✕
        </button>
      </header>

      <div class="rr-row">
        <span class="rr-k">快捷时间</span>
        <div class="rr-chips">
          <button
            v-for="p in PRESETS"
            :key="p.value"
            type="button"
            class="rr-chip"
            :class="{on: draftRange === p.value}"
            @click="draftRange = p.value"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <div v-if="draftRange === 'custom'" class="rr-row">
        <span class="rr-k">起止（北京时间）</span>
        <div class="rr-dates">
          <input v-model="draftFrom" type="date" class="rr-date" aria-label="开始日期" />
          <span class="rr-dash">→</span>
          <input v-model="draftTo" type="date" class="rr-date" aria-label="结束日期" />
        </div>
      </div>

      <!-- 资金动向才有：钱**为什么**动 -->
      <div v-if="typeFilter" class="rr-row">
        <span class="rr-k">资金类型</span>
        <div class="rr-chips">
          <button
            type="button"
            class="rr-chip"
            :class="{on: !draftTypes.length}"
            @click="draftTypes = []"
          >
            全部
          </button>
          <button
            v-for="t in LEDGER_TYPES"
            :key="t.value"
            type="button"
            class="rr-chip"
            :class="{on: draftTypes.includes(t.value)}"
            @click="toggleType(t.value)"
          >
            {{ t.label }}
          </button>
          <!-- 「其它」= 不在上面这些里的（后端翻成 `income_type NOT IN (已知)`） -->
          <button
            type="button"
            class="rr-chip"
            :class="{on: draftTypes.includes(OTHER_TYPE)}"
            @click="toggleType(OTHER_TYPE)"
          >
            其它
          </button>
        </div>
      </div>

      <p class="rr-note">
        {{ preview }}
        <template v-if="count !== null && count !== undefined"> · 当前筛出 {{ count }} 笔</template>
      </p>

      <footer class="rr-f">
        <button type="button" class="rr-btn ghost" @click="emit('update:modelValue', false)">
          取消
        </button>
        <button type="button" class="rr-btn main" @click="apply">完成</button>
      </footer>
    </section>
  </Teleport>
</template>

<style scoped>
/* 底部弹窗：`.sheet` 那套全局样式已经给了定位 / 圆角 / 安全区，这里只调宽度和排版 */
.range-sheet {
  max-width: 520px;
  margin: 0 auto;
}
.rr-h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.rr-h h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
/* 关闭那颗用全局的 `.sheet-x` 样子，这里只把它推到右边 */
.rr-x {
  margin-left: auto;
}
.rr-row {
  margin-bottom: 10px;
}
.rr-k {
  display: block;
  font-size: 11.5px;
  color: var(--muted);
  margin-bottom: 5px;
}
.rr-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rr-chip {
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 999px;
  padding: 5px 11px;
  font-size: 12.5px;
  cursor: pointer;
}
.rr-chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.rr-dates {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rr-date {
  flex: 1;
  min-width: 0;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 13px;
}
.rr-dash {
  color: var(--muted);
}
.rr-note {
  margin: 4px 0 12px;
  font-size: 11.5px;
  color: var(--muted);
}
.rr-f {
  display: flex;
  gap: 8px;
}
.rr-btn {
  flex: 1;
  border-radius: 10px;
  padding: 10px 0;
  font-size: 13.5px;
  cursor: pointer;
  border: 1px solid var(--border);
}
.rr-btn.ghost {
  background: var(--panel-2);
  color: var(--text);
}
.rr-btn.main {
  background: var(--accent);
  border-color: var(--accent);
  color: #0b0d12;
  font-weight: 600;
}
</style>
