<script setup lang="ts">
/**
 * 「止盈 / 止损」弹层（用户 2026-10-06）：
 * 「按钮加上止盈/止损**是一个按钮**，点击显示当前仓位的止盈止损可以设置」。
 *
 * 用户当天追加的四条（都落在这里）：
 *   ① 「提示去掉，现在都是真的」—— 不再铺那段⚠️真单 / 测试单说明
 *      （按钮上那个「测试」前缀已经说清楚了）。
 *   ② 「止盈止损滑动条区分开」—— 每张单**各有各的平仓比例**滑轨，不再共用一根。
 *   ③ 「由于有部分平仓的多个平价价格和百分比要显示可点击修改」—— 同一个方向可能有
 *      **好几张**（部分平仓），一张不落地列成行，每行都能改价 / 改比例 / 撤。
 *   ④ 「确认键没了」—— 底部一颗明确的**「确认」**，所有改动一次性提交。
 *      （以前是每行一颗「挂 / 改」，价没填就是灰的，看着像"确认键没了"。）
 *
 * ★ 沿用 `StopSheet.vue` 那套 `.cf-*` / `.sheet` 样式，不另起一套 CSS。
 *
 * ⚠️ **真金白银**：`testOrder === false` 时交易所那边真挂 / 真改 / 真撤
 *    （`TAKE_PROFIT_MARKET` / `STOP_MARKET`，触发后市价、只减仓；改单 = 先撤旧的再挂新的）。
 *    测试模式下**条件单没有测试接口**（见后端 `placeStopOrder`），只做本地校验，按钮上带「测试」。
 * ⚠️ 弹层不判「这一单算止盈还是止损」：币安只认「触发价相对**现价**在哪一侧」，
 *    判错会被回 `-2021`。后端 `legalKind()` 会按同一个口径再校一遍并以它为准，
 *    所以填到哪一行只是给人看的分类。
 */
import {computed, ref, watch} from 'vue'
import {kindOfPrice, type TpSlAction, type TpSlTarget} from '../tpsl'

const props = defineProps<{
  open: boolean
  /** 这一条持仓 + 它已经挂着的止盈止损（板子点那颗按钮时给的） */
  target: TpSlTarget | null
  /** 是不是测试单（true = 不真挂） */
  testOrder: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', actions: TpSlAction[]): void
}>()

type Kind = 'profit' | 'stop'

/** 滑轨刻度（跟减仓那根一致） */
const TICKS = [25, 50, 75, 100]

/**
 * 弹层里的一行 = 一张（已有的）或待填的（新的）条件单。
 *
 * ⚠️ `was` 是**打开时**的原值：只有它才能判断「这张改没改」——
 *    不然点确认会把用户没动过的单也撤了重挂（白花两次权重、还可能失败）。
 */
interface Row {
  key: string
  /** 这张单**在交易所上**是哪个类型（新行 = 用户点「＋」时所在的那组） */
  group: Kind
  /** 已有单的 id（`null` = 这是要新挂的） */
  id: string | null
  price: number
  pct: number
  was: {price: number; pct: number} | null
  /** 已有单被标了「要撤」（点确认才真撤） */
  removed: boolean
}

const rows = ref<Row[]>([])
let seq = 0

/**
 * **当前展开的那一张**（`null` = 全收起来）。
 *
 * ⚠️ 用户 2026-10-06：「不要全部是可编辑，改为选择，**每次只出现一个**，其余标签显示」
 *    ⇒ 同一个方向挂着好几张（部分平仓）时，默认只把标签列出来，点哪张才展开哪张的
 *    编辑区；同一时刻**全局只有一个编辑区**（跨止盈 / 止损也是一样）。
 *    用 `v-show` 而不是 `v-if` 挂编辑区：换一张看的时候，已经填了一半的价不会被丢掉。
 */
const selKey = ref<string | null>(null)

/** 每种方向最多留几行（部分平仓撑死也就几张，留个上限免得界面失控） */
const MAX_ROWS = 5

function newRow(kind: Kind): Row {
  return {key: `n${++seq}`, group: kind, id: null, price: 0, pct: 100, was: null, removed: false}
}

/** 每次打开都按「现有的单 + 一张空行」重置 */
watch(
  () => props.open,
  on => {
    if (!on) return
    const t = props.target
    const next: Row[] = []
    for (const kind of ['profit', 'stop'] as Kind[]) {
      for (const o of t?.[kind] ?? []) {
        const pct = Math.max(1, Math.min(100, Math.round(o.pct) || 100))
        next.push({
          key: `e${++seq}`,
          group: kind,
          id: o.id,
          price: o.price,
          pct,
          was: {price: o.price, pct},
          removed: false
        })
      }
      /* 一张都没有就给一张空行 —— 打开就能填，不用先点「加一张」 */
      if (!(t?.[kind] ?? []).length) next.push(newRow(kind))
    }
    rows.value = next
    /* 打开就先展开第一张（没有就展开那条空的止盈行）—— 一进来就能动手 */
    selKey.value = next[0]?.key ?? null
  }
)

const name = computed(() => props.target?.name ?? '')
const sideText = computed(() => (props.target?.side === 'short' ? '空' : '多'))
/** 平仓方向（印在确认按钮上） */
const closeLabel = computed(() =>
  props.target?.side === 'short' ? '买入平空' : '卖出平多'
)

/**
 * 这一张**会按哪个类型发出去**。
 *
 * ★ 用户 2026-10-06：「填的价跨过现价时自动把这一单挪到对应那一组（止盈↔止损）」
 *   ⇒ 只要**价被改过**（或者本来就是没提交过的新行），分组就跟**触发价相对现价的位置**
 *   走 —— 这跟币安实际会怎么挂是同一个口径（后端 `legalKind()`）。
 *
 * ⚠️ 没动过的那张**必须按它原本的类型**分组：挂单是服务器上的事实
 *    （比如当初按 STOP 挂的），照价重新分的话，现价一移动界面就会胡说它是止盈。
 */
function liveKind(r: Row): Kind {
  const t = props.target
  if (!t) return r.group
  const edited = !r.was || r.price !== r.was.price
  return edited && r.price > 0 && t.mark > 0
    ? kindOfPrice(t.side, r.price, t.mark)
    : r.group
}

/** 组内成员按**它会挂成什么类型**分（见 `liveKind`） */
const of = (kind: Kind) => rows.value.filter(r => liveKind(r) === kind)

/** 「涨到 X 才触发 / 跌到 X 才触发」——触发方向由类型 + 持仓方向一起决定 */
function triggerText(r: Row): string {
  const long = props.target?.side !== 'short'
  const up = (liveKind(r) === 'profit') === long
  return `${up ? '涨到' : '跌到'} ${fmtPrice(r.price)} 才触发`
}
const canAdd = (kind: Kind) => of(kind).length < MAX_ROWS

/** 点标签：展开这一张；再点一下收起来（同一时刻只有一个，见 `selKey`） */
function toggle(r: Row): void {
  selKey.value = selKey.value === r.key ? null : r.key
}

/** 加一张：顺手把它展开，不然新行填不了 */
function addRow(kind: Kind): void {
  if (!canAdd(kind)) return
  const r = newRow(kind)
  rows.value = [...rows.value, r]
  selKey.value = r.key
}

/** 删掉这张（新行直接移除；已有单标记为「确认后撤掉」，并收起来） */
function dropRow(r: Row): void {
  if (!r.id) rows.value = rows.value.filter(x => x !== r)
  else r.removed = true
  if (selKey.value === r.key) selKey.value = null
}
function keepRow(r: Row): void {
  r.removed = false
}

/** 标签上那几个字：有价的写「价 · 比例」，还没填的写「待填」 */
function chipLabel(r: Row): string {
  return r.price > 0 ? `${fmtPrice(r.price)} · ${r.pct}%` : '待填'
}

/** 这一行的预计盈亏（不含手续费，所以叫「预计」；按开仓均价算，跟币安界面一个口径） */
function pnlOf(r: Row): number {
  const t = props.target
  if (!t || !(t.entry > 0) || !(r.price > 0)) return 0
  const qty = (t.amount * r.pct) / 100
  return (r.price - t.entry) * qty * (t.side === 'short' ? -1 : 1)
}

function estOf(r: Row): string {
  if (!(r.price > 0)) return '填个价'
  const v = pnlOf(r)
  return `预计 ${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`
}

/** 触发价正好压在现价上 ⇒ 币安一定判「立即触发」（-2021），先在这儿拦住 */
function onMark(r: Row): boolean {
  const t = props.target
  return !!t && t.mark > 0 && r.price > 0 && Math.abs(r.price - t.mark) < 1e-12
}

/**
 * 这一行要不要提交：
 *   · 标了撤的已有单 ⇒ 撤单
 *   · 有价的新行 ⇒ 新挂
 *   · 有价、且价或比例跟打开时不一样的已有单 ⇒ 改单（没动过的不碰）
 */
function actionOf(r: Row): TpSlAction | null {
  if (r.removed && r.id) return {kind: r.group, id: r.id, cancel: true, price: 0, pct: 0}
  if (!(r.price > 0)) return null
  /* ⚠️ 类型跟着**触发价**走（`liveKind`），跟界面上显示的那一组一致 */
  if (!r.id) return {kind: liveKind(r), price: r.price, pct: r.pct}
  const changed = !r.was || r.was.price !== r.price || r.was.pct !== r.pct
  return changed ? {kind: liveKind(r), id: r.id, price: r.price, pct: r.pct} : null
}

/** 要提交的动作（空 = 什么都没改，这一下「确认」就等于关掉） */
const actions = computed(() =>
  rows.value.map(actionOf).filter((a): a is TpSlAction => !!a)
)

/** 有价但压在现价上的行 —— 拦住确认并说清是哪一行（不然只会看到 -2021） */
const badRow = computed(() => rows.value.find(r => !r.removed && onMark(r)) ?? null)

/** 确认什么时候不能点：正在提交 / 有压在现价上的行 */
const blocked = computed(() => !!props.busy || !!badRow.value)

function onConfirm(): void {
  if (blocked.value) return
  if (!actions.value.length) {
    emit('close')
    return
  }
  emit('confirm', actions.value)
}

function money(v: number): string {
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/** 价格的小数位：跟图上轴一个量级口径 */
function fmtPrice(v: number): string {
  const a = Math.abs(v)
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8
  return v.toFixed(d)
}

/** 数量（基础币）：越小的币留越多小数位，跟持仓列表一个写法 */
function fmtQty(v: number): string {
  const a = Math.abs(v)
  return v.toFixed(a === 0 ? 0 : a < 0.01 ? 8 : a < 1 ? 6 : a < 1000 ? 4 : 2)
}

function onPrice(r: Row, v: unknown): void {
  const n = Number(v)
  r.price = Number.isFinite(n) && n > 0 ? n : 0
}

/** 这一行平掉多少张（读数用） */
const qtyOf = (r: Row) => ((props.target?.amount ?? 0) * r.pct) / 100
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section
      v-if="open"
      class="sheet sheet-confirm warm-skin"
      role="dialog"
      aria-label="止盈 / 止损"
    >
      <header class="sheet-head">
        <b>止盈 / 止损 · {{ name }} {{ sideText }}</b>
        <button type="button" class="sheet-x" title="关闭" @click="emit('close')">
          ✕
        </button>
      </header>

      <!--
        两组：止盈 / 止损。每组里**每张单一个标签**（部分平仓会有好几张），
        点哪个标签才展开哪个的编辑区 —— 同一时刻只有一个（用户：「不要全部是可编辑，
        改为选择，每次只出现一个，其余标签显示」）。
      -->
      <div v-for="kind in (['profit', 'stop'] as Kind[])" :key="kind" class="ts-box">
        <div class="ts-group">
          <span class="ts-kind">{{ kind === 'profit' ? '止盈' : '止损' }}</span>
          <div class="ts-chips">
            <button
              v-for="r in of(kind)"
              :key="r.key"
              type="button"
              class="chip"
              :class="{on: selKey === r.key, off: r.removed, fresh: !r.id}"
              :title="
                r.id
                  ? '点一下' + (selKey === r.key ? '收起' : '改这一张')
                  : '点一下填这张新单'
              "
              @click="toggle(r)"
            >
              {{ chipLabel(r) }}
            </button>
            <span v-if="!of(kind).length" class="ts-none">还没挂</span>
          </div>
          <button
            v-if="canAdd(kind)"
            type="button"
            class="ghost tiny ts-add"
            :disabled="busy"
            :title="`再加一张${kind === 'profit' ? '止盈' : '止损'}（部分平仓就是靠多张）`"
            @click="addRow(kind)"
          >
            ＋
          </button>
        </div>

        <!--
          ⚠️ 用 `v-show` 而不是 `v-if`：换一张看的时候，另一张已经填了一半的价不会丢。
        -->
        <div
          v-for="r in of(kind)"
          v-show="selKey === r.key"
          :key="r.key + '-edit'"
          class="cf-row ts-row"
          :class="{off: r.removed}"
        >
          <label class="cf-lb">
            <span>
              {{ r.id ? '触发价' : '新触发价' }}
              <template v-if="r.was && !r.removed">
                · 原 <b>{{ fmtPrice(r.was.price) }}</b>
              </template>
            </span>
            <b :class="pnlOf(r) >= 0 ? 'pnl-up' : 'pnl-down'">{{ estOf(r) }}</b>
          </label>
          <input
            class="cf-input"
            :value="r.price > 0 ? fmtPrice(r.price) : ''"
            type="text"
            inputmode="decimal"
            :disabled="r.removed"
            :placeholder="
              target && target.mark > 0 ? `现价 ${fmtPrice(target.mark)}` : '触发价'
            "
            :aria-label="`${kind === 'profit' ? '止盈' : '止损'}触发价`"
            @change="onPrice(r, ($event.target as HTMLInputElement).value)"
          />

          <!-- 这一张的比例滑轨（每张各一根，用户：「止盈止损滑动条区分开」） -->
          <div class="cf-row-bar ts-bar">
            <span class="cf-lb">平仓比例<b>{{ r.pct }}%</b></span>
            <span class="ord-bar">
              <input
                v-model.number="r.pct"
                type="range"
                min="1"
                max="100"
                step="1"
                :disabled="r.removed"
                :style="{'--fill': r.pct + '%'}"
                :title="`平掉 ${r.pct}%`"
              />
              <span class="ord-ticks" aria-hidden="true">
                <i v-for="n in TICKS" :key="n" :style="{left: n + '%'}" />
              </span>
            </span>
            <span class="ts-qty">约 {{ fmtQty(qtyOf(r)) }} 张</span>
          </div>

          <div class="ts-act">
            <span v-if="onMark(r)" class="ts-bad">
              触发价就是现价，币安会判「立即触发」，挪一点
            </span>
            <span v-else-if="r.removed" class="ts-bad">这一张在确认后撤掉</span>
            <!-- 实时告诉你它会以哪个类型挂（用户问过「保本价到底算止盈还是止损」） -->
            <span v-else-if="r.price > 0" class="ts-kind-tip">
              将按「{{ liveKind(r) === 'profit' ? '止盈' : '止损' }}」挂 ·
              {{ triggerText(r) }}
            </span>
            <span class="spacer" />
            <button
              v-if="r.removed"
              type="button"
              class="ghost tiny"
              :disabled="busy"
              title="不撤这张了"
              @click="keepRow(r)"
            >
              保留
            </button>
            <button
              v-else
              type="button"
              class="ghost tiny ts-del"
              :disabled="busy"
              :title="r.id ? '撤掉这张（点确认才真撤）' : '删掉这一张'"
              @click="dropRow(r)"
            >
              {{ r.id ? '撤这张' : '删掉' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 一颗明确的确认（用户：「确认键没了」）-->
      <button
        type="button"
        class="tr-go"
        :disabled="blocked"
        :title="
          badRow
            ? '有一行的触发价压在现价上（币安会判「立即触发」），改一下再确认'
            : actions.length
              ? `提交 ${actions.length} 处改动`
              : '没有要改的'
        "
        @click="onConfirm"
      >
        <template v-if="busy">提交中…</template>
        <template v-else-if="!actions.length">确认</template>
        <template v-else>
          {{ testOrder ? '测试' : '' }}确认（{{ actions.length }} 处 · 触发后按市价{{
            closeLabel
          }}）
        </template>
      </button>
    </section>
  </Teleport>
</template>

<style scoped>
/* 一组（止盈 / 止损）：一行标题 + 标签 + 「＋」 */
.ts-box + .ts-box {
  margin-top: 4px;
}
.ts-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 0 2px;
  border-top: 1px solid var(--border);
}
.ts-kind {
  font-size: 12px;
  color: var(--text);
  flex: 0 0 auto;
}
.ts-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
/*
 * 每张单就是一个**标签**（用户：「不要全部是可编辑，改为选择，每次只出现一个，
 * 其余标签显示」）—— 点它才把编辑区展开。
 */
.chip {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-2);
  color: var(--text);
  white-space: nowrap;
}
/* 当前展开的那张：主题色描边 + 高亮底 */
.chip.on {
  border-color: var(--accent-line, var(--border));
  background: var(--accent-soft, rgba(120, 170, 255, 0.14));
}
/* 标了要撤的那张：划掉 */
.chip.off {
  opacity: 0.55;
  text-decoration: line-through;
}
/* 还没挂上去的新单（虚一点，跟已有的区分开） */
.chip.fresh {
  border-style: dashed;
  color: var(--muted);
}
.ts-none {
  font-size: 11px;
  color: var(--muted);
}
.ts-add {
  flex: 0 0 auto;
  padding: 2px 7px;
  font-size: 12px;
  line-height: 1.2;
}
/* 展开的那一张：给它一点缩进，看得出是从上面哪个标签开出来的 */
.ts-row {
  margin-left: 34px;
  padding: 10px 0 6px;
}
/* 标了要撤的那张：整块压暗 */
.ts-row.off {
  opacity: 0.55;
}
/* 比例那一行：滑轨 + 右边「约 N 张」 */
.ts-bar {
  display: grid;
  grid-template-columns: 62px 1fr auto;
  align-items: center;
  gap: 8px;
}
.ts-bar .cf-lb {
  flex-direction: column;
  gap: 0;
  justify-content: center;
}
.ts-qty {
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}
.ts-act {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
}
.ts-bad {
  font-size: 10.5px;
  color: var(--warn, #e0a33e);
}
.ts-kind-tip {
  font-size: 10.5px;
  color: var(--muted);
}
.ts-del {
  color: var(--bad, #e55361);
}
</style>
