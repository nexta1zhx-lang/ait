<script setup lang="ts">
/**
 * 配置（底部弹出）。
 *
 * 入口两处：K 线头部「AI 分析 / ＋」那一行最右边那颗按钮、「我的 → 交易所账户」
 * 账户切换行最右侧那颗「配置」。五条：
 *   · 行情过滤 —— 24h 成交额 ≥ N 百万 USDT 的合约才在行情列表里显示
 *     （用户 2026-10-03：「行情过滤 可以配置 24h 成交多少 m，大于这个数合约行情才显示」）。
 *   · 下单账户 —— K 线页底部下单模块用哪套交易所 Key（用户 2026-10-05）。
 *   · 测试下单 —— **开关**（用户 2026-10-05「测试单在配置中开启」）：
 *     以前「测试单」是写死在开单页上的一句标签，现在挪到这儿，开单页不再提。
 *   · 订单设置（2026-10-06）—— 仓位 / 订单历史 / 仓位委托 / 强平价格
 *     这四样画不画在 K 线上（见 `trade-overlay.ts`、`KlineChart` 的叠加层）。
 *   · 持仓明细（2026-10-07）—— 持仓卡上「价值 / 数量」那一格显示哪个数。
 *   · 基准时间（2026-10-07）—— 合约行情排行榜按哪个时区日切算「今日」涨跌幅（默认 24h）；
 *     选了就直接改合约区那张表的排名。
 *
 * ★ 2026-10-07 版式（用户：「配置改为图标，内容优化所有都去掉描述，开关有点饱满了
 *   上下瘦一点 行情过滤 一行显示 下单一行显示 测试也是 订单 选项样式修改 一个边框
 *   包住，被选择的右上角有勾 持仓一行显示」）：
 *   · 每条弹层都只剩**一行**「标签 + 控件」，所有说明文字（`<p>` / `<em>`）删掉；
 *   · 「订单设置」从四行开关改成**一个边框里的四格**（2×2），选中的右上角一颗**勾**；
 *   · 开关本身瘦了一圈（见 `style.css` 的 `.switch`）。
 *
 * ⚠️ 2026-10-04 删掉了两条（用户：「k 线保持样式缩放逻辑全部删掉」）：
 *    「保持 K 线缩放样式」开关 + 「显示多少根 K 线」读数。
 *    现在图上显示多少根由**屏幕宽度**决定，用户不用管、也没得调。
 *
 * 值都在 `settings.ts`（落 localStorage），这里只负责画和改。
 */
import {computed, ref, watch} from 'vue'
import {
  chartShowHistory,
  chartShowLiq,
  chartShowOrders,
  chartShowPosition,
  marketMinVolM,
  posShowValue,
  rankBase,
  testOrder
} from '../settings'
import {
  loadTradeKeys,
  pickTradeKey,
  tradeKey,
  tradeKeys,
  tradeKeysErr
} from '../trade-account'
import {askConfirm} from '../confirm'
import {bjTime} from '../format'
import TimeModal from './TimeModal.vue'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{(e: 'close'): void}>()

/* 打开时拉一次 Key 列表（30 秒内不重复拉） */
watch(
  () => props.open,
  on => {
    if (on) void loadTradeKeys()
  },
  {immediate: true}
)

/**
 * 行情过滤的输入框。
 * `v-model.number` 交了空串 / 非法值时是 `NaN` —— 一律当 0（不过滤），
 * 不然后面 `NaN * 1e6` 会把整张表滤没。
 */
const minVolM = computed({
  get: () => marketMinVolM.value,
  set: (v: unknown) => {
    marketMinVolM.value = Math.max(0, Math.round(Number(v) || 0))
  }
})

/** 常用档位（手机上点一下就行，不用弹键盘） */
const PRESETS = [0, 1, 5, 10, 50]

/**
 * 切「测试下单」。
 * ⚠️ **关掉的时候必须确认** —— 开关的另一侧是真钱（真开仓 / 真平仓）；
 *    开回来（回到只校验）是往安全那侧走，不用问。
 */
async function toggleTest(): Promise<void> {
  if (!testOrder.value) {
    testOrder.value = true
    return
  }
  const ok = await askConfirm({
    title: '关掉「测试下单」？',
    body: [
      '之后下单和平仓都会发到币安的真实接口：',
      '会真开仓、真扣保证金；平仓会真的把持仓平掉。',
      {t: '这两件事都撤不回来。', tone: 'warn'}
    ],
    okText: '关掉测试',
    danger: true
  })
  if (ok) testOrder.value = false
}

/**
 * 「订单设置」那四格（用户 2026-10-06 要的四个开关，2026-10-07 改成格子）。
 *
 * `kind` 是 `toggleChart` 的 key，`dot` 是跟 K 线上那条线**同色**的点
 * （色值在 `style.css` 的 `.oset-dot[data-kind=…]`），`on` 直接读配置。
 */
const chartOpts = computed(() => [
  {
    kind: 'position' as const,
    dot: 'pos',
    label: '仓位',
    on: chartShowPosition.value,
    title: '持仓均价线：画在 K 线上'
  },
  {
    kind: 'history' as const,
    dot: 'his',
    label: '订单历史',
    on: chartShowHistory.value,
    title: '成交点位：标在 K 线上'
  },
  {
    kind: 'orders' as const,
    dot: 'ord',
    label: '仓位委托',
    on: chartShowOrders.value,
    title: '挂单价格线：画在 K 线上'
  },
  {
    kind: 'liq' as const,
    dot: 'liq',
    label: '强平价格',
    on: chartShowLiq.value,
    title: '强平价线：画在 K 线上'
  }
])

/**
 * 切「订单设置」里的一项。
 *
 * 走函数而不是模板里直接 `x = !x`：这几个是**从 `settings.ts` import 进来的 ref**，
 * 模板里给它赋值能不能正确落到 `.value` 上不够直观 —— 一律在这儿写清楚。
 */
function toggleChart(kind: 'position' | 'history' | 'orders' | 'liq'): void {
  if (kind === 'position') chartShowPosition.value = !chartShowPosition.value
  else if (kind === 'history') chartShowHistory.value = !chartShowHistory.value
  else if (kind === 'orders') chartShowOrders.value = !chartShowOrders.value
  else chartShowLiq.value = !chartShowLiq.value
}

/** 「持仓明细」那一格显示 价值 / 数量（同上：import 进来的 ref，赋值写在函数里） */
function pickPosDisplay(value: boolean): void {
  posShowValue.value = value
}

/* ---------------- 基准时间（合约行情排行榜） ---------------- */

/**
 * 可选的基准时区（UTC 偏移**分钟** + 显示名）。北京（UTC+8）放第一个 —— 用户举的例子就是它。
 * ⚠️ 只有两项：再加「任意…」那颗，390px 上这一行就放不下、会折成两行（用户要的是「每条一行」）。
 */
const TIMEZONES: {min: number; label: string; title: string}[] = [
  {min: 480, label: 'UTC+8', title: '北京时间'},
  {min: 0, label: 'UTC+0', title: '伦敦时间'}
]

/** 回到默认（交易所的滚动 24h） */
function pickOff(): void {
  rankBase.value = {kind: 'off'}
}

/** 按某个时区每天 00:00 日切 */
function pickTz(min: number): void {
  rankBase.value = {kind: 'tz', min}
}

/* 「任意时刻」那颗：点开复用「选一个时间点」那个弹窗（自带「现在 / 1 天前 / 7 天前…」快选） */
const atOpen = ref(false)

/** 当前选中的时区偏移（不在 tz 那一档就是 null）—— 只给模板判高亮用 */
const pickedTz = computed(() =>
  rankBase.value.kind === 'tz' ? rankBase.value.min : null
)

/** 那颗按钮上的字：没设就是「任意…」，设了显示挑中的时刻（省掉年份） */
const atLabel = computed(() =>
  rankBase.value.kind === 'at'
    ? bjTime(rankBase.value.ms).slice(5, 16)
    : '任意…'
)

/** 弹窗里确认一个时刻 = 排行榜换基准（`MarketPanel` 盯着这个 ref 重拉 + 重排） */
function onAtPick(ms: number): void {
  rankBase.value = {kind: 'at', ms}
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-mask" @click="emit('close')" />
    <section v-if="open" class="sheet cfg-sheet" role="dialog" aria-label="配置">
      <header class="sheet-head">
        <b>配置</b>
        <button class="ghost tiny" title="关掉" @click="emit('close')">✕</button>
      </header>

      <!--
        2026-10-07 用户：「内容优化所有都去掉描述……行情过滤 一行显示 下单一行显示
        测试也是……持仓一行显示」⇒ 每条只剩「标签 + 控件」**一行**。
        原来标题下面那句 `<p>`、以及「订单设置」每个开关右边的 `<em>` 说明，全删了：
        选项名本身已经说清它是什么，多一句解释只把弹层撑长。
        ⚠️ 别再往这儿加说明文字 —— 真要解释就写进 `title`（悬停才看得见）。
      -->

      <!-- 行情过滤：24h 成交额低于这个数的合约不显示 -->
      <div class="sheet-row">
        <span class="rk">行情过滤</span>
        <div class="ctl mvol">
          <input
            v-model.number="minVolM"
            type="number"
            min="0"
            step="1"
            inputmode="decimal"
            aria-label="24h 成交额下限（百万 USDT）"
            title="24h 成交额低于此值的合约不显示（单位：百万 USDT）。0 = 不限。"
          />
          <span>M</span>
          <div class="mvol-presets">
            <button
              v-for="p in PRESETS"
              :key="p"
              type="button"
              class="ghost tiny"
              :class="{on: marketMinVolM === p}"
              @click="minVolM = p"
            >
              {{ p === 0 ? '不限' : p + 'M' }}
            </button>
          </div>
        </div>
      </div>

      <!--
        基准时间（用户 2026-10-07）：「行情排行榜可以自己选一个时刻来排，像币安那样，
        直接影响合约区」→「基准时间是 24 小时的一个时间，比如北京时间就是 UTC+8」
        →「可以选择任意时间和 24h」。
        ⇒ 三档：`24h`（默认，交易所的滚动 24 小时）/ 某时区**每天 00:00 日切** /
        **任意时刻**（点开选一个时间点，按北京时间）。三种都只改合约区那张表的口径与排名。
      -->
      <div class="sheet-row">
        <span class="rk">基准时间</span>
        <div
          class="ctl tk-picks"
          title="排行榜的涨跌幅从哪算起：24h / 某时区今日 00:00 / 任意时刻"
        >
          <button
            type="button"
            class="ghost tiny"
            :class="{on: rankBase.kind === 'off'}"
            title="交易所的滚动 24 小时（默认）"
            @click="pickOff"
          >
            24h
          </button>
          <button
            v-for="z in TIMEZONES"
            :key="z.min"
            type="button"
            class="ghost tiny"
            :class="{on: pickedTz === z.min}"
            :title="`${z.title}（${z.label}）每天 00:00 日切，算今日涨跌幅`"
            @click="pickTz(z.min)"
          >
            {{ z.label }}
          </button>
          <button
            type="button"
            class="ghost tiny"
            :class="{on: rankBase.kind === 'at'}"
            :title="
              rankBase.kind === 'at'
                ? `从 ${bjTime(rankBase.ms)}（北京时间）算起，点一下换一个时刻`
                : '选一个时刻作为排行榜基准'
            "
            @click="atOpen = true"
          >
            {{ atLabel }}
          </button>
        </div>
      </div>

      <!-- 下单账户：K 线页底部那个下单模块用哪套交易所 Key -->
      <div class="sheet-row">
        <span class="rk">下单账户</span>
        <div
          class="ctl tk-picks"
          title="下单模块使用的账户（管理密钥：我的 → 个人信息 → 交易所）"
        >
          <button
            v-for="k in tradeKeys"
            :key="k.id"
            type="button"
            class="ghost tiny"
            :class="{on: tradeKey?.id === k.id}"
            :title="`${k.name} · ${k.marketType === 'swap' ? '合约' : '现货'}`"
            @click="pickTradeKey(k.id)"
          >
            {{ k.name }}
          </button>
          <span v-if="!tradeKeys.length" class="dim tiny">{{
            tradeKeysErr || '还没配置交易所 Key'
          }}</span>
        </div>
      </div>

      <!--
        测试下单：开关的另一侧是真钱 ⇒ 开 / 关都先二次确认（见 `toggleTest`）。
      -->
      <div class="sheet-row">
        <span class="rk">测试下单</span>
        <button
          type="button"
          class="switch end"
          :class="{on: testOrder}"
          role="switch"
          :aria-checked="testOrder"
          :aria-label="testOrder ? '测试下单已开启' : '测试下单已关闭'"
          :title="
            testOrder
              ? '开启时仅校验参数与权限，不会真实成交。点一下切换（会先确认）'
              : '已关闭：下单与平仓均为真实成交。点一下切换（会先确认）'
          "
          @click="toggleTest"
        >
          <span />
        </button>
      </div>

      <!--
        订单设置 —— 用户 2026-10-07 改了两次，**现在这一版是终点**：
          ① 「选项样式修改 一个边框包住，被选择的右上角有勾」→ 做过一版 2×2 的大框；
          ② 「不要加下滑线」/「分割线不要加」→ 框里那几条格子线撤了；
          ③ 「订单四个按钮分开一行显示」⇒ **取消共用的大框**，四个各自一个边框的
             小按钮、**排成一行**；选中的右上角仍然一颗勾。
        ⚠️ 一行四颗 + 左边那列标签在 390px 上刚好放得下（实测 282 / 296px）——
           再给名字加字、或者把字号放大，这一行就会折成两行。
        ⚠️ 关掉的那一项**连数据都不再拉**（见 `trade-overlay.ts`），不是只不画。
      -->
      <div class="sheet-row">
        <span class="rk">订单设置</span>
        <div class="ctl opts" title="选择哪几样画在 K 线上">
          <button
            v-for="o in chartOpts"
            :key="o.kind"
            type="button"
            class="opt"
            :class="{on: o.on}"
            role="switch"
            :aria-checked="o.on"
            :aria-label="o.label"
            :title="o.title"
            @click="toggleChart(o.kind)"
          >
            <span class="oset-dot" :data-kind="o.dot" />
            <b>{{ o.label }}</b>
            <!-- 勾用**内联 SVG**：`✓` 在安卓 WebView 的兜底字体里不保证有字形 -->
            <span v-if="o.on" class="opt-ck" aria-hidden="true">
              <svg viewBox="0 0 12 12">
                <path d="M2.4 6.4 4.7 8.7 9.6 3.5" />
              </svg>
            </span>
          </button>
        </div>
      </div>

      <!-- 持仓明细：那一格显示价值还是数量（价值 = 数量 × 当前价） -->
      <div class="sheet-row">
        <span class="rk">持仓明细</span>
        <div class="ctl tk-picks" title="持仓那行显示价值（USDT）还是数量（多少个币）">
          <button
            type="button"
            class="ghost tiny"
            :class="{on: posShowValue}"
            title="显示仓位价值（USDT）"
            @click="pickPosDisplay(true)"
          >
            价值
          </button>
          <button
            type="button"
            class="ghost tiny"
            :class="{on: !posShowValue}"
            title="显示持仓数量（多少个币）"
            @click="pickPosDisplay(false)"
          >
            数量
          </button>
        </div>
      </div>
    </section>

    <!--
      「任意时刻」：复用「选一个时间点」那个弹窗 —— 它自带「现在 / 1 天前 / 7 天前 / 30 天前」
      快选 + 一个 datetime 输入（北京时间、精确到分钟），不用另写一个选择器。
    -->
    <TimeModal
      v-model="atOpen"
      kind="point"
      title="选排行榜的基准时间"
      hint="合约区的涨跌幅会改成「这一刻 → 现在」，并据此排名。"
      :initial="rankBase.kind === 'at' ? rankBase.ms : Date.now()"
      @confirm="onAtPick"
    />
  </Teleport>
</template>

<style scoped>
/*
 * 这一层弹层的版式**只在本组件里改**（别去动全局 `.sheet-row` / `.switch` ——
 * `ReduceSheet` / `TransferSheet` 也在用那几条）。
 */
/*
 * 每条一行：标签在左、控件贴右。
 * ⚠️ **不画分割线**（用户 2026-10-07：「不要加下滑线」→「分割线不要加」）——
 *    全局 `.sheet-row` 那条 `border-top` 在这一层撤掉，条与条之间只用留白分
 *    （所以上下内边距给到 11px，比原来紧贴线的写法松一点）。
 */
.sheet-row {
  align-items: center;
  gap: 10px;
  padding: 11px 0;
  border-top: 0;
}
.rk {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}
/* 控件那一组：顶到最右；窄屏允许自己换行，但别把标签挤成两行 */
.ctl,
.end {
  margin-left: auto;
}
.ctl {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}
/*
 * 按钮圆角小一档（用户 2026-10-07：「按钮圆角小一点」）——
 * 这一层里的按钮本来两套：胶囊是 999px（`--tk-picks`）、其余 `ghost` 是 10px；
 * 现在统一到 `--r-xs`(8px)：胶囊不再是个正圆头，档位 / 关闭键也收一点。
 * ⚠️ 只改**这一层**（scoped），别去改全局 `button.ghost` / `.tk-picks`。
 */
.sheet .ghost,
.tk-picks button {
  border-radius: var(--r-xs);
}
/* 行情过滤一行要塞下「输入 + M + 5 个档位」⇒ 这里比默认紧凑一档 */
.mvol {
  gap: 5px;
}
.mvol input {
  width: 58px;
  padding: 5px 8px;
  font-size: 12.5px;
}
.mvol > span {
  font-size: 11px;
}
.mvol-presets {
  gap: 5px;
}
.mvol-presets button {
  padding: 4px 7px;
  font-size: 11px;
}
/*
 * 「订单设置」四个选项：**四个分开的小按钮、排成一行**（用户 2026-10-07：
 * 「订单四个按钮分开一行显示」）—— 不再是共用一个边框的大框，也不再有格子线；
 * 选中的看**右上角那颗勾** + 字提亮，不靠底色。
 * ⚠️ 尺寸只能这么紧：四颗 + 左边标签在 390px 上是 282 / 296px，改大一点就折行。
 */
.opts {
  display: flex;
  gap: 4px;
}
.opt {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px 5px 6px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-xs);
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}
/* 那一排里的色点小一号（全局 9px 在这儿太占地方） */
.opt .oset-dot {
  width: 7px;
  height: 7px;
}
.opt b {
  font-weight: 400;
  white-space: nowrap;
}
/* 选中的：字提亮 + 右上角一颗勾 */
.opt.on {
  color: var(--text);
}
.opt-ck {
  position: absolute;
  top: 0;
  right: 2px;
  display: inline-flex;
  color: var(--accent);
}
.opt-ck svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
