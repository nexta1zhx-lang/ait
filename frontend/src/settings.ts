/**
 * 页面配置（存 localStorage）。
 *
 * 现在只剩一条：
 *  · `marketMinVolM` —— 行情过滤：24h 成交额低于这个数的合约不显示
 *
 * ⚠️ 2026-10-04 **删掉了「K 线缩放记忆」那套**（用户：「k 线保持样式缩放逻辑全部删掉」）：
 *    原来有 `keepChartZoom`（保持缩放开关）+ `chartBars`（全局共用的显示根数），
 *    加上 `saveChartBars` / `rememberShown` / `shownBars` / `shownKey`。
 *    现在**图上显示多少根一律按屏幕宽度算**（见 `KlineChart` 的 `barsForWidth`），
 *    用户缩放只影响当下这一屏，切走 / 换币就回到按宽度算的值。
 *
 * ⚠️ 2026-10-05 **删掉了 `runBtnPos`**：「分析」闪电不再能拖着走，
 *    固定钉在周期行最右侧（用户：「闪电图标固定在选择周期一行最右侧」）。
 *    旧的 `runBtnPos` 就算还留在 localStorage 里也没人读了，不管它。
 */
import {computed, ref, watch} from 'vue'

const KEY = 'ca-settings-v2'
/** 旧键（v1 / 更早）。里面的东西一概不迁移了 —— 见上面那段说明。 */
const OLD_KEY = 'ca-settings-v1'

interface Stored {
  /** 行情过滤：24h 成交额低于这个数（**百万 USDT**）的合约不显示。0 = 不过滤 */
  marketMinVolM?: number
  /** 「交易所账户」按哪种货币看：美元（默认）/ 人民币 */
  exchangeCurrency?: 'usd' | 'cny'
  /** 下单走测试单（默认**开**）。`false` = 真下单 —— 见 `testOrder` */
  testOrder?: boolean
  /** 订单设置（2026-10-06）：这四样画不画在 K 线上。缺省 = 都画 */
  chartShowPosition?: boolean
  chartShowHistory?: boolean
  chartShowOrders?: boolean
  chartShowLiq?: boolean
  /** 持仓那一格显示价值（默认）还是数量 —— 见 `posShowValue` */
  posShowValue?: boolean
  /** 持仓列表的排序条件 —— 见 `posSort` */
  posSort?: PosSort
  /** 排序方向（升 / 降）—— 见 `posSortDir` */
  posSortDir?: 'asc' | 'desc'
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Stored & Record<string, unknown>
      // 只取认得的字段 —— 删掉的 `keepChartZoom` / `chartBars` / `runBtnPos` 别跟着写回去
      return {
        marketMinVolM: v.marketMinVolM,
        exchangeCurrency: v.exchangeCurrency === 'cny' ? 'cny' : 'usd',
        testOrder: v.testOrder !== false,
        chartShowPosition: v.chartShowPosition !== false,
        chartShowHistory: v.chartShowHistory !== false,
        chartShowOrders: v.chartShowOrders !== false,
        chartShowLiq: v.chartShowLiq !== false,
        posShowValue: v.posShowValue !== false,
        posSort:
          v.posSort === 'pnl' || v.posSort === 'value' || v.posSort === 'liq'
            ? v.posSort
            : 'symbol',
        posSortDir: v.posSortDir === 'asc' || v.posSortDir === 'desc' ? v.posSortDir : undefined
      }
    }
    // 老键里已经没有认得的东西了（旧配置全部废弃）
    void localStorage.getItem(OLD_KEY)
    return {}
  } catch {
    // 无痕模式 / 被禁用，读取会抛，当没有配置
    return {}
  }
}

const saved = read()

/**
 * 「行情过滤」：24h 成交额**低于**这个数（单位：**百万 USDT**）的合约，
 * 合约行情列表里就不显示。`0` = 不过滤（默认）。
 *
 * 用户 2026-10-03：「行情过滤 可以配置 24h 成交多少 m，大于这个数合约行情才显示」。
 * ⚠️ 只影响**行情列表**（和它标题右边的总数），不影响 K 线 / 分析取数。
 */
export const marketMinVolM = ref(Math.max(0, saved.marketMinVolM ?? 0))

/** 阈值换算成 USDT 原值（列表那边直接比） */
export const marketMinVolUsd = computed(() => marketMinVolM.value * 1e6)

/**
 * 「交易所账户」那一页用哪种货币看：`usd`（默认，$）/ `cny`（¥）。
 *
 * 用户 2026-10-05：「账户添加人民币汇率切换快捷 usdt cny」。
 * 汇率跟用量页 / 历史页同源（`GET /api/rate` → `USD_CNY`，默认 7.1）。
 */
export const exchangeCurrency = ref<'usd' | 'cny'>(
  saved.exchangeCurrency === 'cny' ? 'cny' : 'usd'
)

/**
 * 下单是不是走**测试单**（用户 2026-10-05：「测试单在配置中开启」）。
 *
 * · `true`（**默认**）→ 币安 `/fapi/v1/order/test`：只校验签名 / 参数 / 权限 / 保证金，
 *   **不进撮合、不真开仓**。
 * · `false` → `/fapi/v1/order`：**真下单 / 真平仓**，会真扣保证金。
 *
 * ⚠️ 默认值必须是 `true`（`read()` 里也是 `v.testOrder !== false`）——
 *    这个开关的另一侧是真钱，没存过配置的人必须落在测试单上。
 */
export const testOrder = ref(saved.testOrder !== false)

/**
 * 「订单设置」（用户 2026-10-06）——
 * 「配置界面可以配置订单设置，1.仓位 2.订单历史 3.仓位委托 4.强平价格」
 * 「是控制和 k 线联动的价格或历史是否显示在 k 线上」。
 *
 * 就是币安合约图那套，四样各自一个开关，控制**画不画在 K 线上**：
 *  · `chartShowPosition` —— **仓位**：持仓的**开仓均价**画一条价格线（多空分色）
 *  · `chartShowLiq`      —— **强平价格**：强平价画一条线（红）
 *  · `chartShowOrders`   —— **仓位委托**：当前挂单每条画一条线（蓝）
 *  · `chartShowHistory`  —— **订单历史**：成交历史标成图上的买卖点
 *
 * ⚠️ 默认**四条都开**：这四样都是自己账户的仓位 / 委托，看不看得见由用户决定，
 *    他自己的东西默认该看得见（不想看就在配置里关掉，关掉的项也不再去取数）。
 */
export const chartShowPosition = ref(saved.chartShowPosition !== false)
export const chartShowLiq = ref(saved.chartShowLiq !== false)
export const chartShowOrders = ref(saved.chartShowOrders !== false)
export const chartShowHistory = ref(saved.chartShowHistory !== false)

/**
 * 持仓那种「价值 / 数量」的那一格显示哪个数（用户 2026-10-07：
 * 「数量和价值放一块可切换显示……切换放配置里」）。
 *
 * 价值 = 数量 × 当前价 —— 同一件事的两种说法，占同一格，所以做成**全局**开关：
 * 一排持仓要能横着比数，逐条各切一半就比不出来了。`true` = 价值（默认）。
 */
export const posShowValue = ref(saved.posShowValue !== false)

/**
 * 持仓列表的排序条件（用户 2026-10-07：「持仓……顶部加排序条件」）。
 *
 * `symbol`（默认，= 后端给的顺序，按币种）· `pnl` 未实现盈亏多的在前 ·
 * `value` 仓位价值大的在前 · `liq` 距强平**近**的在前（最危险的先看见）。
 */
/** 持仓列表的排序条件（见上面 `posSort` 那段说明） */
export type PosSort = 'symbol' | 'pnl' | 'value' | 'liq'

/**
 * 每一档排序**天生**的方向：币种 A→Z、盈亏赚的在前、价值大的在前、距强平最危险的在前。
 *
 * ⚠️ 换档位时方向**回到这一档的默认**（见板子里的 `watch(posSort, …)`）——
 *    不然「升序」这个状态会跟着人跑到完全不同的条件上，看着像排错了。
 */
export function naturalDirOf(by: PosSort): 'asc' | 'desc' {
  return by === 'pnl' || by === 'value' ? 'desc' : 'asc'
}

export const posSort = ref<PosSort>(saved.posSort ?? 'symbol')

/**
 * 排序方向（用户 2026-10-07：「要加升序降序图标」）——
 * 顶栏那颗箭头点一下就在升 / 降之间翻。缺省 = 当前条件的默认方向。
 */
export const posSortDir = ref<'asc' | 'desc'>(
  saved.posSortDir ?? naturalDirOf(saved.posSort ?? 'symbol')
)

/**
 * 手机端那颗「分析」闪电 —— **已经不再存位置了**。
 *
 * 2026-10-04 做成了「可以自由移动 + 记到 localStorage」；
 * 2026-10-05 用户改口：「闪电图标固定在选择周期一行最右侧」
 * → 固定成周期行里的一个格子（`KlineChart` 的 `#head-end` 插槽），拖拽整套拆了。
 */

watch(
  [
    marketMinVolM,
    exchangeCurrency,
    testOrder,
    chartShowPosition,
    chartShowLiq,
    chartShowOrders,
    chartShowHistory,
    posShowValue,
    posSort,
    posSortDir
  ],
  () => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          marketMinVolM: marketMinVolM.value,
          exchangeCurrency: exchangeCurrency.value,
          testOrder: testOrder.value,
          chartShowPosition: chartShowPosition.value,
          chartShowLiq: chartShowLiq.value,
          chartShowOrders: chartShowOrders.value,
          chartShowHistory: chartShowHistory.value,
          posShowValue: posShowValue.value,
          posSort: posSort.value,
          posSortDir: posSortDir.value
        })
      )
    } catch {
      // 写不了就算了，不影响用
    }
  },
  {deep: true}
)
