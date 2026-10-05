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
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Stored & Record<string, unknown>
      // 只取认得的字段 —— 删掉的 `keepChartZoom` / `chartBars` / `runBtnPos` 别跟着写回去
      return {marketMinVolM: v.marketMinVolM}
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
 * 手机端那颗「分析」闪电 —— **已经不再存位置了**。
 *
 * 2026-10-04 做成了「可以自由移动 + 记到 localStorage」；
 * 2026-10-05 用户改口：「闪电图标固定在选择周期一行最右侧」
 * → 固定成周期行里的一个格子（`KlineChart` 的 `#head-end` 插槽），拖拽整套拆了。
 */

watch(
  marketMinVolM,
  () => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({marketMinVolM: marketMinVolM.value})
      )
    } catch {
      // 写不了就算了，不影响用
    }
  },
  {deep: true}
)
