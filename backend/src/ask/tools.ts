/**
 * 「数据问答」的工具清单 —— 模型能调的**就这些**。
 *
 * 为什么不让模型直接写 SQL：
 *   · 越权：全库的表都按 `user_id` 隔离，模型漏一次 `WHERE user_id` 就看到别人数据；
 *   · 准确：`grade` / `verdict` / 「做了多少次」这些口径写在代码里，比模型现场猜稳；
 *   · 可控：SQL 是死的、参数是绑定的 ⇒ 想缓存、想离线评测都有抓手。
 * 所以一个工具 = 「一段写死的参数化 SQL」+「参数收敛」+「结果裁到模型吃得下的尺寸」。
 *
 * ⚠️ 每条 SQL 的**第一个条件永远是 `user_id = $1`**，别漏。
 * ⚠️ 时间口径一律**北京自然日**（`from` / `to` 都是 `YYYY-MM-DD`，含头含尾）——
 *    跟「用量统计」那套一致，别混 UTC。
 */
import {query, queryOne} from '../db/client'
import {listSessions} from '../db/persist'
import {usageSummary} from '../db/usage'
import {unifiedPerpSymbol} from '../db/candle-store'
import {getDefaultExchangeKey} from '../db/exchange-keys'
import {
  incomeTotals,
  latestSnapshot,
  listCurve,
  listFills,
  listIncome,
  listOpenOrdersDb,
  netOf
} from '../db/exchange-store'
import {listC2cOrderHistory} from '../db/exchange-analytics'
import {listJournalEntries} from '../db/journals'
import {listPositionHistory, type PositionCycle} from '../data/position-history'
// 档位现算 —— 用的就是持久化提醒 / 前端颜色那一个判定，两边必须一致
import {verdictLabel, verdictOf, type Verdict} from '../analysis/verdict'
// 参数收敛（纯函数）单独一份，好让 `scripts/selftest.ts` 离线跑夹具
import {
  MAX_DAYS,
  MAX_ROWS,
  bjDayEndMs,
  bjDayOf,
  bjDayStartMs,
  bjStamp,
  bjToday,
  dur,
  clampInt,
  normalizeRange,
  normalizeSymbol
} from './range'

/** 周期 → 一根多少毫秒（算「这个范围要多少根 K 线」用） */
const TF_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000
}
/** 能查的周期（跟底座灌的档一致，见 `candle-store.ts` 的 `HIGH_INTERVALS`） */
const INTERVALS = Object.keys(TF_MS)
/**
 * 一次最多读多少根 —— 跟 `config/calibers.yaml` 的「最多根数」一致。
 *
 * ⚠️ 这**不是**数据库限制，是「喂给模型的东西要有个头」：1500 根明细的 JSON
 *    能把上下文撑爆（所以才只给最近 N 根明细、汇总用 SQL 算）。
 */
const MAX_BARS = 1500
/** 明细一次给多少根（汇总不受这个限制） */
const MAX_BAR_ROWS = 200

/* ------------------------------------------------------------------ */
/* 给模型看的工具描述                                                  */
/* ------------------------------------------------------------------ */

export interface AskToolSpec {
  name: string
  /** 中文短名（前端「取值过程」里显示） */
  label: string
  description: string
  parameters: Record<string, unknown>
}

const rangeProps = {
  from: {type: 'string', description: '开始日期，YYYY-MM-DD（北京自然日，含当天）'},
  to: {type: 'string', description: '结束日期，YYYY-MM-DD（含当天）；不填=今天'}
}

export const TOOL_SPECS: AskToolSpec[] = [
  {
    name: 'analysis_stats',
    label: '统计预测历史',
    description:
      '统计「预测历史」（每次开单分析存下的那句结论）：按天 / 币种 / 档位分组，' +
      '给出样本数，以及可做 / 观望 / 不可做各多少。' +
      '问「做了多少次」「哪些币做得多」「可做的比例」这类统计问题用它。',
    parameters: {
      type: 'object',
      properties: {
        ...rangeProps,
        group_by: {
          type: 'string',
          enum: ['day', 'symbol', 'verdict'],
          description: '按什么分组；不填=只给一个总数'
        },
        symbol: {type: 'string', description: '只看某个币，如 BTC'}
      }
    }
  },
  {
    name: 'recent_analyses',
    label: '读预测历史',
    description:
      '按时间倒序读「预测历史」里存的原始结论（带币种 / 时间 / 当时的现价 / 判出来的档位）。' +
      '要**具体说了什么**（而不是统计）用它。',
    parameters: {
      type: 'object',
      properties: {
        ...rangeProps,
        symbol: {type: 'string', description: '只看某个币，如 BTC'},
        limit: {type: 'number', description: `最多几条，默认 20，上限 ${MAX_ROWS}`}
      }
    }
  },
  {
    name: 'journal_entries',
    label: '读专家经验',
    description:
      '读「专家经验」里**用户自己写的**条目（标题 / 正文 / 分类 / 挂的币种 / 最后改动时间），' +
      '可按币种、关键词、月份筛，按时间倒序。' +
      '问「我之前总结过什么」「关于 BTC 我记了什么」「我的专家经验里有没有提到过…」这类问题用它。\n' +
      '⚠️ 这里面只有**用户自己的话**，没有行情 / 成交数据 —— ' +
      '要数字去查别的工具，别把日记里的说法当行情事实。',
    parameters: {
      type: 'object',
      properties: {
        symbol: {type: 'string', description: '只看挂了某个币的日记，如 BTC'},
        q: {type: 'string', description: '关键词（在标题和正文里搜）'},
        months: {type: 'string', description: '月份，YYYY-MM；多个用逗号隔开'},
        limit: {type: 'number', description: `最多几条，默认 10，上限 ${MAX_ROWS}`}
      }
    }
  },
  {
    name: 'market_klines',
    label: '读 K 线行情',
    description:
      '读某个币的 **K 线**（底座库里的 U 本位永续），**任意周期**：' +
      INTERVALS.join(' / ') +
      '，`interval: all` 则每个周期给一份概览（最近 30 根的收盘与涨跌）。\n' +
      '返回：区间汇总（根数 / 首根开盘 / 末根收盘 / 涨跌幅 / 最高最低 / 振幅 / 成交额）' +
      '+ `明细` 最近 N 根（每根 = [时间, 开, 高, 低, 收, 成交量, 成交额]，默认 30 根、上限 200）。\n' +
      '问「最近涨了多少」「什么价」「各周期什么情况」「这段行情怎么走的」用它。\n' +
      '⚠️ 各周期保留期不同（5m/15m 只留几天到 30 天、1h 400 天、4h 与 1d 永久）；' +
      '查不到时返回里的「库里覆盖」会告诉你其实有哪一段，别当成"这个币没数据"。',
    parameters: {
      type: 'object',
      properties: {
        symbol: {type: 'string', description: '币种，如 BTC'},
        interval: {
          type: 'string',
          enum: [...INTERVALS, 'all'],
          description: 'K 线周期；不填 = 1d（日线）；all = 所有周期各给一份概览'
        },
        ...rangeProps,
        limit: {type: 'number', description: `明细最多几根，默认 30，上限 ${MAX_BAR_ROWS}`}
      },
      required: ['symbol']
    }
  },
  {
    name: 'usage_cost',
    label: '读 AI 用量与花费',
    description:
      '读大模型调用的用量与花费（次数 / token / 美元），按用途和模型分开。' +
      '问「我花了多少钱」「用了多少 token」用它。',
    parameters: {
      type: 'object',
      properties: {...rangeProps}
    }
  },
  {
    name: 'persist_status',
    label: '读持久化分析',
    description:
      '读「持久化分析」（每隔 15 分钟自动跑一次的那种跟踪）的会话：状态、跑了多少轮、' +
      '最近一条结论。问「有哪些在跟踪」「XX 跟踪得怎么样」用它。',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'ended', 'all'],
          description: '只看在跑的 / 已结束的 / 全部；不填=全部'
        }
      }
    }
  },

  /* ---- 交易所账户（走默认那套 API Key，明细里会写上是哪个账户） ---- */
  {
    name: 'exchange_fills',
    label: '读我的成交',
    description:
      '读**我的真实成交**：`汇总` 是**整个区间**的（总笔数 / 买卖 / 成交额 / 手续费 / 已实现盈亏，' +
      '外加按币种、按天的分布）；`明细` 只给最近 N 条（默认 50，上限 500）。' +
      '问「做了多少单」「哪个币做得最多」用汇总那几个数 —— **别用明细的条数去数**' +
      '（明细有上限，会被截断）。要看某一段的逐笔就把 from/to 收窄。',
    parameters: {
      type: 'object',
      properties: {
        ...rangeProps,
        symbol: {type: 'string', description: '只看某个币，如 BTC'},
        limit: {type: 'number', description: `明细最多几条，默认 50，上限 500`}
      }
    }
  },
  {
    name: 'exchange_positions',
    label: '读历史仓位',
    description:
      '读**历史仓位**（「开仓 → 全平」算一笔，像币安的「仓位历史」）：开仓均价 / 平仓均价 /' +
      '数量 / 杠杆 / 开平仓时间 / 持仓时长 / 净盈亏（= 已实现 − 手续费 + 资金费），' +
      '外加统计（盈/亏/打平各几笔、胜率、毛盈利、毛亏损、多空笔数、平均持仓时长）' +
      '和**还没平完**的那些。问「我哪笔赚了多少」「胜率多少」「平均持仓多久」用它。' +
      '⚠️ 减仓不单独算一笔（归到那一整段里）；区间按**平仓时间**筛。',
    parameters: {
      type: 'object',
      properties: {
        ...rangeProps,
        symbol: {type: 'string', description: '只看某个币，如 BTC'},
        limit: {type: 'number', description: '最多几条仓位，默认 30，上限 100'}
      }
    }
  },
  {
    name: 'exchange_pnl',
    label: '读盈亏汇总',
    description:
      '读交易所口径的**盈亏汇总**（指定区间）：已实现盈亏 / 手续费 / 资金费 / 其它 /' +
      '净盈亏 / 笔数。问「最近赚了还是亏了」「这个月盈亏多少」用它。' +
      '⚠️ 净盈亏 = 已实现 + 手续费 + 资金费（前两类在币安那边本来就是负数，是相加）。' +
      '划转（账户之间搬钱）只进「其它」、**不进净盈亏**。',
    parameters: {
      type: 'object',
      properties: {...rangeProps}
    }
  },
  {
    name: 'exchange_ledger',
    label: '读资金流水',
    description:
      '逐笔读资金流水（已实现盈亏 / 手续费 / 资金费 / 划转…），带时间、币种、金额。' +
      '想扒「钱都花在哪了」「手续费扣了多少笔」用它；只看合计数用 exchange_pnl。',
    parameters: {
      type: 'object',
      properties: {
        ...rangeProps,
        type: {
          type: 'string',
          enum: ['all', 'realized', 'commission', 'funding', 'transfer'],
          description:
            '只看某一类：已实现盈亏 / 手续费 / 资金费 / 划转；不填 = 全部',
          default: 'all'
        },
        limit: {type: 'number', description: '最多几条，默认 60，上限 500'}
      }
    }
  },
  {
    name: 'exchange_account',
    label: '读账户资产',
    description:
      '读**当前账户**：净资产（合约保证金 + C2C + 现货 USDT）、钱包余额、浮动盈亏、' +
      '可用 / 占用、保证金率、**当前持仓**（方向 / 数量 / 开仓价 / 标记价 / 杠杆 / 未实现盈亏 /' +
      '强平价）、以及最近 7 天净资产的起止与高低。问「我现在有多少钱」「现在什么仓」「账户怎么样」用它。',
    parameters: {type: 'object', properties: {}}
  },
  {
    name: 'exchange_orders',
    label: '读当前挂单',
    description:
      '读**当前还挂着的委托**（限价 / 条件单 / 止盈止损），带方向、价格、触发价、数量、已成交。' +
      '问「我挂了什么单」「有没有没撤掉的单」用它。',
    parameters: {type: 'object', properties: {}}
  },
  {
    name: 'exchange_c2c',
    label: '读 C2C 出入金',
    description:
      '读 C2C（法币）订单：买入 / 卖出、法币金额、成交价、数量、时间。' +
      '问「我充了多少 U」「最近出入金」用它。',
    parameters: {
      type: 'object',
      properties: {
        limit: {type: 'number', description: '最多几条，默认 20，上限 100'}
      }
    }
  }
]

/** 转成 OpenAI / DeepSeek 要的 `tools` 形状 */
export function toOpenAiTools(): {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}[] {
  return TOOL_SPECS.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }))
}

export function toolLabel(name: string): string {
  return TOOL_SPECS.find(t => t.name === name)?.label ?? name
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

export interface AskToolContext {
  userId: number
  exchange: string
  marketType: string
  /** 「今天」——留个口子给离线评测固定日期 */
  today?: string
}

export interface AskToolResult {
  /** 给模型看的数据（已经裁过尺寸） */
  data: unknown
  rows: number
  /** 一行摘要（写进「取值过程」，也是回灌给模型的一句话） */
  detail: string
}

/* ---- 交易所账户那半边（2026-10-16 补）----
 *
 * 为什么第一版漏了它：那 6 个工具全是「我分析过什么」，而**做过的单、赚亏、钱去哪了**
 * 在另一批表里（`exchange_fills` / `exchange_income` / `exchange_snapshots` /
 * `exchange_open_orders` / `exchange_c2c_orders`）。用户一问「我最近做的」就露了。
 *
 * 下面这些工具**只读库，不打交易所接口** —— 打接口要密钥、要权重预算（按出口 IP 算，
 * 是全站共用的一条），而这几张表本来就是 WS 事件 + 每 5 分钟采样落下来的。
 *
 * ⚠️ 一律取**默认那套钥匙**（`getDefaultExchangeKey`）。多账户的用户，
 *    明细里会写清是哪个账户 —— 不然模型会当成"全部账户"说出去。
 */

const INCOME_LABEL: Record<string, string> = {
  REALIZED_PNL: '已实现盈亏',
  COMMISSION: '手续费',
  COMMISSION_REBATE: '手续费返还',
  FUNDING_FEE: '资金费',
  TRANSFER: '划转',
  INSURANCE_CLEAR: '强平清算'
}

/** 「资金动向」那几个胶囊 → `income_type` 数组（跟 `exchange-store` 的已知类型对齐） */
const INCOME_PICKS: Record<string, string[] | null> = {
  all: null,
  realized: ['REALIZED_PNL'],
  commission: ['COMMISSION', 'COMMISSION_REBATE'],
  funding: ['FUNDING_FEE'],
  transfer: ['TRANSFER']
}

/** 交易所给的买卖方向（成交那边小写 `buy`、挂单那边大写 `BUY`，两边都认） */
const ORDER_SIDE: Record<string, string> = {BUY: '买', SELL: '卖'}

/** 还没配交易所 Key —— 这不是「查询失败」，是要说给用户听的一句话 */
function noExchangeAccount(what: string): AskToolResult {
  return {
    data: {
      说明:
        '这个账号还没配置交易所 API Key，所以查不到成交 / 盈亏 / 资产。' +
        '去「我的 → 交易所账户」加一套。'
    },
    rows: 0,
    detail: `${what} · 没有配置交易所账户`
  }
}

/**
 * 币安那边的符号是**交易对**（`BTCUSDT`），而库里 `analyses.symbol` 是基础币（`BTC`）——
 * 成交 / 账本这些表按交易对存，过滤时得补回来。
 * ⚠️ 底座只覆盖 U 本位永续（报价 USDT），拼 `USDT` 是对的；别的报价这里查不到。
 */
function pairOf(symbol: string): string {
  return `${symbol}USDT`
}

/** 参数不合法 / 不认识这个工具 —— 回给模型让它自己改，不算系统错误 */
export class ToolInputError extends Error {}

const num2 = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null
}

/**
 * 跑一个工具。
 *
 * 只认白名单里的名字：`name` 不是我们给的 6 个之一就直接抛 ——
 * 模型这个字段是自由文本，不能拿它去拼任何东西。
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AskToolContext
): Promise<AskToolResult> {
  const today = ctx.today ?? bjToday()
  switch (name) {
    case 'analysis_stats':
      return analysisStats(args, ctx, today)
    case 'recent_analyses':
      return recentAnalyses(args, ctx, today)
    case 'journal_entries':
      return journalEntries(args, ctx)
    case 'market_klines':
      return marketKlines(args, ctx, today)
    case 'usage_cost':
      return usageCost(args, ctx, today)
    case 'persist_status':
      return persistStatus(args, ctx)
    case 'exchange_fills':
      return exchangeFills(args, ctx, today)
    case 'exchange_positions':
      return exchangePositions(args, ctx, today)
    case 'exchange_pnl':
      return exchangePnl(args, ctx, today)
    case 'exchange_ledger':
      return exchangeLedger(args, ctx, today)
    case 'exchange_account':
      return exchangeAccount(ctx)
    case 'exchange_orders':
      return exchangeOrders(ctx)
    case 'exchange_c2c':
      return exchangeC2c(args, ctx)
    default:
      throw new ToolInputError(`没有这个工具：${name}`)
  }
}

/** 北京自然日区间 → SQL 条件（日期参数要 `::date`，`DATE $n` 那种写法不合法） */
function rangeSql(a = 2, b = 3): string {
  return (
    `created_at >= ($${a}::date + time '00:00') AT TIME ZONE 'Asia/Shanghai'` +
    ` AND created_at < (($${b}::date + interval '1 day') AT TIME ZONE 'Asia/Shanghai')`
  )
}

/** 一次统计最多扫多少条（档位要在 JS 里现算，得有个上限兜住内存和时间） */
const MAX_SCAN = 20_000

async function analysisStats(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const {from, to, days, note} = normalizeRange(args.from, args.to, today)
  const symbol = normalizeSymbol(args.symbol)
  const raw = String(args.group_by ?? '').trim()
  // 认不出的分组（模型可能自己编一个）当作「不分组」——回总数比报错强
  const groupBy = raw === 'day' || raw === 'symbol' || raw === 'verdict' ? raw : ''

  const params: unknown[] = [ctx.userId, from, to]
  let extra = ''
  if (symbol) {
    params.push(symbol)
    extra = ` AND symbol = $${params.length}`
  }

  /*
   * ⚠️ 档位**不能按 `analyses.verdict` 统计**：那一列（连 `grade`）从 2026-10-11 起
   *    就再没写过，全库是 NULL —— 按它统计会得出「0 个可做」，然后被模型当结论说出去。
   *    所以只取结论原文，用 `verdictOf()`（持久化提醒 / 前端颜色用的同一个判定）现算。
   *    代价是得把这几千条拉回来在 JS 里过一遍，所以有 `MAX_SCAN`。
   */
  const rows = await query<{at: Date; symbol: string; line: string | null}>(
    `SELECT created_at AS at, symbol, grade_reason AS line
       FROM analyses
      WHERE user_id = $1 AND ${rangeSql()}${extra}
      ORDER BY created_at DESC
      LIMIT ${MAX_SCAN}`,
    params
  )

  const buckets = new Map<
    string,
    {total: number; go: number; wait: number; no: number}
  >()
  const bump = (key: string, v: 'go' | 'wait' | 'no'): void => {
    const b = buckets.get(key) ?? {total: 0, go: 0, wait: 0, no: 0}
    b.total += 1
    b[v] += 1
    buckets.set(key, b)
  }
  for (const r of rows) {
    const v = verdictOf(r.line ?? '')
    bump(
      groupBy === 'day'
        ? bjDayOf(r.at.getTime())
        : groupBy === 'symbol'
          ? r.symbol
          : groupBy === 'verdict'
            ? verdictLabel(v)
            : '全部',
      v
    )
  }

  // 「按天」看趋势，新的在前；其余按样本数排
  const sorted = [...buckets.entries()].sort((a, b) =>
    groupBy === 'day'
      ? b[0].localeCompare(a[0])
      : b[1].total - a[1].total || a[0].localeCompare(b[0])
  )
  const data = sorted.slice(0, 60).map(([key, b]) => ({
    分组: key,
    次数: b.total,
    可做: b.go,
    观望: b.wait,
    不可做: b.no
  }))
  const total = rows.length
  const sum = sorted.reduce(
    (a, [, b]) => ({go: a.go + b.go, wait: a.wait + b.wait, no: a.no + b.no}),
    {go: 0, wait: 0, no: 0}
  )

  return {
    data: {
      区间: `${from} ~ ${to}（${days} 天）`,
      币种: symbol || '全部',
      分组: groupBy || '不分组',
      合计: {次数: total, 可做: sum.go, 观望: sum.wait, 不可做: sum.no},
      统计: data
    },
    rows: data.length,
    detail:
      `${from} ~ ${to}（${days} 天）` +
      (symbol ? ` · ${symbol}` : '') +
      (groupBy ? ` · 按 ${groupBy} 分组` : '') +
      ` · 共 ${total} 条（可做 ${sum.go} / 观望 ${sum.wait} / 不可做 ${sum.no}）` +
      (note ? ` · ${note}` : '')
  }
}

async function recentAnalyses(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const {from, to, days, note} = normalizeRange(args.from, args.to, today)
  const symbol = normalizeSymbol(args.symbol)
  const limit = clampInt(args.limit, 20, MAX_ROWS)

  /*
   * 不复用 `db/analyses.ts` 的 `listAnalyses`：那个接口是按「最近 N 天」+ 分页写的
   * （`days` 从 `now()` 往回数），套不出「任意区间」—— 硬套会把 `to` 当今天、结果对不上。
   */
  const params: unknown[] = [ctx.userId, from, to]
  let extra = ''
  if (symbol) {
    params.push(symbol)
    extra = ` AND symbol = $${params.length}`
  }
  params.push(limit)

  const rows = await query<{
    at: Date
    symbol: string
    line: string | null
    price: string | null
  }>(
    `SELECT created_at AS at, symbol, grade_reason AS line, price
       FROM analyses
      WHERE user_id = $1 AND ${rangeSql()}${extra}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params
  )

  const data = rows.map(r => ({
    时间: bjStamp(r.at),
    币种: r.symbol,
    档位: verdictLabel(verdictOf(r.line ?? '')),
    现价: num2(r.price),
    结论: String(r.line ?? '').slice(0, 400)
  }))
  return {
    data,
    rows: rows.length,
    detail:
      `${from} ~ ${to}（${days} 天）` +
      (symbol ? ` · ${symbol}` : '') +
      ` · 最新 ${rows.length} 条` +
      (note ? ` · ${note}` : '')
  }
}


/**
 * 读「专家经验」（这一格以前叫「经验」/「日记」）。
 *
 * 知识库模块 2026-10-18 删掉之后，**用户自己写的那些东西只剩「专家经验」这一处**了
 * （用户：「没有知识库了叫经验」）—— 所以给它一个只读工具，
 * 模型问「我以前怎么总结的」时能真去翻，而不是凭印象编。
 */
async function journalEntries(
  args: Record<string, unknown>,
  ctx: AskToolContext
): Promise<AskToolResult> {
  const symbol = normalizeSymbol(args.symbol)
  const q = String(args.q ?? '')
    .trim()
    .slice(0, 60)
  const months = String(args.months ?? '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean)
  const limit = clampInt(args.limit, 10, MAX_ROWS)
  const list = await listJournalEntries(ctx.userId, {
    coin: symbol || undefined,
    q: q || undefined,
    months,
    limit
  })
  const entries = (list.entries ?? []).slice(0, limit).map(e => ({
    时间: e.at,
    标题: e.title || '（无标题）',
    币种: e.coins.map(c => c.base).join(' / ') || '—',
    分类: e.category?.name ?? '未分类',
    正文: String(e.body ?? '').slice(0, 600)
  }))
  return {
    data: {
      命中条数: list.total ?? entries.length,
      条件是: {
        ...(symbol ? {币种: symbol} : {}),
        ...(q ? {关键词: q} : {}),
        ...(months.length ? {月份: months.join(',')} : {})
      },
      条数: entries.length,
      条目: entries
    },
    rows: entries.length,
    detail: `专家经验：${entries.length} 条`
  }
}

async function marketKlines(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const symbol = normalizeSymbol(args.symbol)
  if (!symbol)
    throw new ToolInputError(
      `币种认不出：「${String(args.symbol ?? '').slice(0, 20)}」——只能是字母数字，比如 BTC`
    )
  const pair = unifiedPerpSymbol(symbol)

  /* `interval: 'all'` = 每个周期都给一份概览（问「各周期什么情况」用它） */
  const want = String(args.interval ?? '1d').trim()
  if (want === 'all') return klineAllIntervals(pair, symbol, ctx, today)
  if (!INTERVALS.includes(want))
    throw new ToolInputError(`interval 只能是 ${INTERVALS.join(' / ')} 或 all`)
  const interval = want

  /* 范围：天数上限按「这个周期最多 1500 根」换算（1d 能看 1500 天，5m 只能 5.2 天） */
  const maxDays = Math.max(1, Math.floor((MAX_BARS * TF_MS[interval]) / 86_400_000))
  const {from, to, days, note} = normalizeRange(
    args.from,
    args.to,
    today,
    /* `normalizeRange` 默认夹 400 天（给分析历史那类用的），K 线按根数夹更准 */
    maxDays
  )
  const limit = clampInt(args.limit, 30, MAX_BAR_ROWS)
  const fromMs = bjDayStartMs(from)
  const toMs = bjDayEndMs(to)
  const scope: [string, string] = [ctx.exchange, ctx.marketType]

  const [sum, cover, bars] = await Promise.all([
    queryOne<Record<string, unknown>>(
      `SELECT count(*)::int                              AS n,
              min(open_time)                             AS first_t,
              max(open_time)                             AS last_t,
              (array_agg(open ORDER BY open_time ASC))[1]  AS first_open,
              (array_agg(close ORDER BY open_time DESC))[1] AS last_close,
              max(high)                                  AS hi,
              min(low)                                   AS lo,
              COALESCE(sum(volume), 0)                   AS vol,
              COALESCE(sum(quote_volume), 0)             AS qv
         FROM candles
        WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = $4
          AND open_time >= $5 AND open_time <= $6`,
      [...scope, pair, interval, new Date(fromMs), new Date(toMs)]
    ),
    /* 库里这个档**一共有**多少（用来回答"为什么这段没有数据"） */
    queryOne<Record<string, unknown>>(
      `SELECT count(*)::int AS n, min(open_time) AS first_t, max(open_time) AS last_t
         FROM candles
        WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = $4`,
      [...scope, pair, interval]
    ),
    query<Record<string, unknown>>(
      `SELECT open_time, open, high, low, close, volume, quote_volume
         FROM candles
        WHERE exchange = $1 AND market_type = $2 AND symbol = $3 AND interval = $4
          AND open_time >= $5 AND open_time <= $6
        ORDER BY open_time DESC
        LIMIT $7`,
      [...scope, pair, interval, new Date(fromMs), new Date(toMs), limit]
    )
  ])

  const n = Number(sum?.n ?? 0) || 0
  const coverFrom = cover?.first_t ? bjStamp(String(cover.first_t)) : null
  const coverTo = cover?.last_t ? bjStamp(String(cover.last_t)) : null

  if (!n) {
    return {
      data: {
        币种: symbol,
        周期: interval,
        区间: `${from} ~ ${to}`,
        说明:
          '这个区间里没有 K 线。' +
          (coverTo ? `库里这个周期**有**数据，但只覆盖 ${coverFrom} ~ ${coverTo}。` : '') +
          '（底座只记 U 本位永续；各档保留期不同：5m/15m 短、1h 400 天、4h 与 1d 永久）',
        库里覆盖: coverFrom && coverTo ? {起: coverFrom, 止: coverTo} : null
      },
      rows: 0,
      detail: `${symbol} ${interval} · ${from} ~ ${to} 没有数据` + (coverTo ? `（库里只有 ${coverFrom} ~ ${coverTo}）` : '')
    }
  }

  const firstOpen = num2(sum?.first_open) ?? 0
  const lastClose = num2(sum?.last_close) ?? 0
  const hi = num2(sum?.hi) ?? 0
  const lo = num2(sum?.lo) ?? 0
  const data = {
    币种: symbol,
    周期: interval,
    区间: `${from} ~ ${to}（${days} 天）`,
    根数: n,
    首根: {时间: sum?.first_t ? bjStamp(String(sum.first_t)) : null, 开: firstOpen},
    末根: {时间: sum?.last_t ? bjStamp(String(sum.last_t)) : null, 收: lastClose},
    区间涨跌幅: firstOpen ? num2(((lastClose - firstOpen) / firstOpen) * 100) : null,
    区间最高: hi,
    区间最低: lo,
    振幅: lo ? num2(((hi - lo) / lo) * 100) : null,
    成交额合计: num2(sum?.qv),
    成交量合计: num2(sum?.vol),
    库里覆盖: coverFrom && coverTo ? {起: coverFrom, 止: coverTo, 共: Number(cover?.n ?? 0)} : null,
    明细: {
      条数: bars.length,
      说明:
        `最近 ${bars.length} 根（区间内共 ${n} 根）；每根 = ` +
        '[开, 高, 低, 收, 成交量, 成交额]',
      /*
       * ⚠️ 日线只给**日期**：币安的 1d 是 UTC 00:00 对齐，翻成北京就成了 `08:00` ——
       *    显示成「2026-10-15 08:00」会让人（和模型）以为那是某个 8 点的时刻。
       */
      数据: bars.map(b => [
        interval === '1d' ? bjDayOf(new Date(String(b.open_time)).getTime()) : bjStamp(String(b.open_time)),
        num2(b.open),
        num2(b.high),
        num2(b.low),
        num2(b.close),
        num2(b.volume),
        num2(b.quote_volume)
      ])
    }
  }
  return {
    data,
    rows: n,
    detail:
      `${symbol} ${interval} · ${from} ~ ${to} · ${n} 根` +
      ` · 区间 ${firstOpen} → ${lastClose}` +
      (firstOpen ? `（${num2(((lastClose - firstOpen) / firstOpen) * 100)}%）` : '') +
      ` · 最高 ${hi} / 最低 ${lo}` +
      (note ? ` · ${note}` : '')
  }
}

/**
 * 每个周期一份概览（`interval: 'all'`）。
 *
 * 用来回答「各周期现在什么情况」—— 一次问清，比让模型一个个周期去调省好几轮。
 * 每档只给「最近 30 根」的汇总，不返明细（明细用单周期那一路）。
 */
async function klineAllIntervals(
  pair: string,
  symbol: string,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const scope: [string, string] = [ctx.exchange, ctx.marketType]
  const rows = await query<Record<string, unknown>>(
    `SELECT interval,
            count(*)::int AS n,
            max(open_time) AS last_t,
            (array_agg(close ORDER BY open_time DESC))[1] AS last_close,
            (array_agg(open ORDER BY open_time DESC))[1]  AS last_open,
            max(high) AS hi,
            min(low)  AS lo
       FROM (
         SELECT interval, open_time, open, high, low, close,
                row_number() OVER (PARTITION BY interval ORDER BY open_time DESC) AS rn
           FROM candles
          WHERE exchange = $1 AND market_type = $2 AND symbol = $3
            AND interval = ANY($4::text[])
       ) t
      WHERE rn <= 30
      GROUP BY interval`,
    [...scope, pair, INTERVALS]
  )

  const byInterval = new Map(rows.map(r => [String(r.interval), r]))
  const data = INTERVALS.map(it => {
    const r = byInterval.get(it)
    if (!r || !Number(r.n))
      return {周期: it, 说明: '这个档库里没有数据'}
    const open = num2(r.last_open) ?? 0
    const close = num2(r.last_close) ?? 0
    return {
      周期: it,
      最近30根: Number(r.n),
      最新时间: r.last_t ? bjStamp(String(r.last_t)) : null,
      最新收盘: close,
      最近30根涨跌: open ? num2(((close - open) / open) * 100) : null,
      '30根最高': num2(r.hi),
      '30根最低': num2(r.lo)
    }
  })
  const have = data.filter(d => !('说明' in d))
  return {
    data: {币种: symbol, 各周期: data},
    rows: have.length,
    detail: `${symbol} · ${have.length}/${INTERVALS.length} 个周期有数据（各看最近 30 根）`
  }
}

async function usageCost(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const {from, to, days, note} = normalizeRange(args.from, args.to, today)
  const s = await usageSummary({userId: ctx.userId, from, to})
  const usd = (v: number): number => Number(v.toFixed(4))
  return {
    data: {
      区间: `${from} ~ ${to}`,
      合计: {
        调用次数: s.totals.calls,
        输入token: s.totals.promptTokens,
        输出token: s.totals.completionTokens,
        总token: s.totals.totalTokens,
        花费美元: usd(s.totals.costUsd)
      },
      按用途: s.byKind.map(b => ({
        用途: b.label,
        次数: b.calls,
        花费美元: usd(b.costUsd)
      })),
      按模型: s.byModel.map(b => ({
        模型: b.label,
        次数: b.calls,
        花费美元: usd(b.costUsd)
      }))
    },
    rows: s.totals.calls,
    detail:
      `${from} ~ ${to}（${days} 天） · ${s.totals.calls} 次调用 · $${usd(s.totals.costUsd)}` +
      (note ? ` · ${note}` : '')
  }
}

async function persistStatus(
  args: Record<string, unknown>,
  ctx: AskToolContext
): Promise<AskToolResult> {
  const want = String(args.status ?? 'all').trim()
  if (!/^(active|ended|all)$/.test(want))
    throw new ToolInputError('status 只能是 active / ended / all')

  const all = await listSessions(ctx.userId)
  const rows = want === 'all' ? all : all.filter(s => s.status === want)

  const data = rows.map(s => ({
    币种: s.symbol,
    状态: s.status === 'active' ? '在跑' : '已结束',
    开始: bjStamp(s.startedAt),
    计划结束: bjStamp(s.endsAt),
    已跑轮数: s.runs,
    失败: s.failed,
    结束原因: s.endedReason,
    // 库里存的是 go / no / wait，给人看要翻成中文（跟页面上一个字面）
    最近档位: /^(go|no|wait)$/.test(String(s.lastVerdict ?? ''))
      ? verdictLabel(s.lastVerdict as Verdict)
      : null,
    最近结论: String(s.lastLine ?? '').slice(0, 300),
    最近时间: s.lastAt ? bjStamp(s.lastAt) : null
  }))
  return {
    data,
    rows: rows.length,
    detail: `${
      want === 'all' ? '全部' : want === 'active' ? '在跑的' : '已结束的'
    } · ${rows.length} 个会话`
  }
}

/** 工具结果回灌给模型前先限长度（一条工具结果撑爆上下文就白花钱了） */
export function clipForModel(data: unknown, maxChars = 12_000): string {
  const text = JSON.stringify(data) ?? ''
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…（结果过长已截断，共 ${text.length} 字）`
}

/* ------------------------------------------------------------------ */
/* 交易所账户（只读库，不打交易所接口）                                */
/* ------------------------------------------------------------------ */

/** 北京自然日区间 → 毫秒时间戳（账本那几个函数的 `range` 要的是毫秒、含端点） */
function ledgerRange(from: string, to: string): {from: number; to: number} {
  return {from: bjDayStartMs(from), to: bjDayEndMs(to)}
}

const r2 = (v: number): number => Number((Number.isFinite(v) ? v : 0).toFixed(2))

/**
 * 仓位周期 → 给模型看的那一行。
 *
 * ⚠️ 这里的字段（开平均价 / 净盈亏 / 资金费）都是 `data/position-history.ts`
 *    **从成交账本现算**的 —— 库里没有「仓位」这张表，别去 SQL 里找。
 */
function cycleOf(c: PositionCycle, withOrders = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    币种: c.symbol,
    方向: c.side === 'long' ? '多' : '空',
    开仓价: c.entryPrice,
    平仓价: c.exitPrice,
    数量: c.qty,
    杠杆: c.leverage,
    开仓时间: bjStamp(c.openAt),
    平仓时间: c.closeAt ? bjStamp(c.closeAt) : null,
    持仓时长: dur(c.holdSec),
    已实现盈亏: r2(c.realized),
    手续费成本: r2(c.fee),
    资金费: r2(c.funding),
    净盈亏: r2(c.net),
    账本不全: c.partial
  }
  if (withOrders) {
    // 详情按「先看减仓那几笔」排 —— 他关心的是「减仓那下赚了多少」
    out.成交明细 = [...c.orders]
      .sort((a, b) => (b.reduce ? 1 : 0) - (a.reduce ? 1 : 0))
      .slice(0, 40)
      .map(o => ({
        时间: bjStamp(o.time),
        方向: o.side === 'buy' ? '买' : '卖',
        加减仓: o.reduce ? '减' : '加',
        价格: r2(o.price),
        数量: o.amount,
        手续费: r2(o.fee),
        已实现盈亏: r2(o.realized)
      }))
  }
  return out
}

async function exchangePositions(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const key = await getDefaultExchangeKey(ctx.userId)
  if (!key) return noExchangeAccount('查历史仓位')

  const {from, to, days, note} = normalizeRange(args.from, args.to, today)
  const symbol = normalizeSymbol(args.symbol)
  const limit = clampInt(args.limit, 30, 100)

  const r = await listPositionHistory(
    ctx.userId,
    key.id,
    limit,
    symbol ? pairOf(symbol) : undefined,
    ledgerRange(from, to)
  )
  const s = r.summary
  const winRate =
    s.closedCount > 0 ? Math.round((s.wins / s.closedCount) * 1000) / 10 : null

  const data = {
    账户: key.name,
    区间: `${from} ~ ${to}（${days} 天）`,
    区间口径: '按**平仓时间**筛的（一笔仓位算哪一天，看它什么时候平的）',
    账本最早: r.since ? bjStamp(r.since) : null,
    账本说明:
      '仓位是从**成交账本现算**的；`since` 之前的历史没进账本。' +
      '标了「账本不全」的那几段，开仓价是残缺的（第一笔本身就是平仓）。',
    统计: {
      已平仓笔数: s.closedCount,
      盈利: s.wins,
      亏损: s.losses,
      打平: s.breakeven,
      胜率百分比: winRate,
      毛盈利: r2(s.grossProfit),
      毛亏损: r2(s.grossLoss),
      净盈亏: r2(s.net),
      已实现: r2(s.realized),
      手续费成本: r2(s.fees),
      资金费: r2(s.funding),
      多单: s.longCount,
      空单: s.shortCount,
      平均持仓: dur(s.averageHoldSec)
    },
    还没平完: r.open.slice(0, 5).map(c => cycleOf(c)),
    还没平完条数: r.openCount,
    列表: {
      条数: r.cycles.length,
      说明:
        `给了最近 ${r.cycles.length} 笔；区间内**共 ${s.closedCount} 笔**` +
        '（「统计」那一份是全量算的，别拿列表条数当总数）。',
      仓位: r.cycles.map(c => cycleOf(c))
    }
  }

  return {
    data,
    rows: r.cycles.length,
    detail:
      `${key.name} · ${from} ~ ${to}（${days} 天）` +
      (symbol ? ` · ${symbol}` : '') +
      ` · 已平 ${s.closedCount} 笔（盈 ${s.wins} / 亏 ${s.losses}` +
      (winRate === null ? '）' : `，胜率 ${winRate}%）`) +
      ` · 净盈亏 ${r2(s.net)}` +
      (r.openCount ? ` · 还有 ${r.openCount} 笔没平完` : '') +
      (note ? ` · ${note}` : '')
  }
}

/**
 * 成交的**全区间汇总**（不受明细条数上限影响）。
 *
 * 为什么要单独算：明细有上限（token 成本），而真实数据近 30 天就有 **1809 笔** ——
 * 拿被截断的明细去数「做了多少单」必然少报（2026-10-16 用户：
 * 「历史数据 500 笔要扩大」）。**数数靠汇总、看细节靠明细**，两条路分开：
 * 汇总永远覆盖整个区间，明细只给最近 N 条，并在返回里写清「给了几条 / 一共几条」。
 *
 * ⚠️ 时间用 `ts`（成交时间）+ **毫秒**参数 —— 跟 `db/exchange-store.ts` 的
 *    `LedgerQuery` 同一套约定；别用 `rangeSql()`（那个是 `analyses.created_at` 的）。
 */
async function fillsAgg(
  userId: number,
  keyId: number,
  fromMs: number,
  toMs: number,
  pair?: string
): Promise<{
  total: {n: number; buys: number; cost: number; fee: number; realized: number}
  bySymbol: {symbol: string; n: number; buys: number; realized: number}[]
  byDay: {day: string; n: number; realized: number}[]
}> {
  const params: unknown[] = [userId, keyId, fromMs, toMs]
  let extra = ''
  if (pair) {
    params.push(pair)
    extra = ` AND upper(symbol) = upper($${params.length})`
  }
  const where =
    `user_id = $1 AND key_id = $2` +
    ` AND ts >= to_timestamp($3::bigint / 1000.0)` +
    ` AND ts <= to_timestamp($4::bigint / 1000.0)${extra}`

  const n = (v: unknown): number => Number(v ?? 0) || 0
  const totalRow = await queryOne<Record<string, unknown>>(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE side = 'buy')::int AS buys,
            COALESCE(sum(cost), 0)     AS cost,
            COALESCE(sum(fee), 0)      AS fee,
            COALESCE(sum(realized), 0) AS realized
       FROM exchange_fills
      WHERE ${where}`,
    params
  )
  const bySymbol = await query<Record<string, unknown>>(
    `SELECT symbol,
            count(*)::int AS n,
            count(*) FILTER (WHERE side = 'buy')::int AS buys,
            COALESCE(sum(realized), 0) AS realized
       FROM exchange_fills
      WHERE ${where}
      GROUP BY symbol
      ORDER BY n DESC
      LIMIT 15`,
    params
  )
  /* 按北京自然日分桶（`ts` 是 timestamptz，跟用量统计那套同一写法） */
  const byDay = await query<Record<string, unknown>>(
    `SELECT to_char(ts AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
            count(*)::int AS n,
            COALESCE(sum(realized), 0) AS realized
       FROM exchange_fills
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 14`,
    params
  )

  return {
    total: {
      n: n(totalRow?.n),
      buys: n(totalRow?.buys),
      cost: n(totalRow?.cost),
      fee: n(totalRow?.fee),
      realized: n(totalRow?.realized)
    },
    bySymbol: bySymbol.map(r => ({
      symbol: String(r.symbol ?? ''),
      n: n(r.n),
      buys: n(r.buys),
      realized: n(r.realized)
    })),
    byDay: byDay.map(r => ({
      day: String(r.day ?? ''),
      n: n(r.n),
      realized: n(r.realized)
    }))
  }
}

async function exchangeFills(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const key = await getDefaultExchangeKey(ctx.userId)
  if (!key) return noExchangeAccount('查成交')

  const {from, to, days, note} = normalizeRange(args.from, args.to, today)
  const symbol = normalizeSymbol(args.symbol)
  const limit = clampInt(args.limit, 50, 500)
  const range = ledgerRange(from, to)
  const pair = symbol ? pairOf(symbol) : undefined

  /*
   * ⚠️ 两个查询**各管一半**，别拿明细去数数（近 30 天就有 1809 笔，截到 500 会少报）：
   *   · `fillsAgg` = 整个区间的汇总（多少笔 / 买多少 / 手续费 / 已实现 / 按币按天）
   *   · `listFills` = 最近 `limit` 条明细（给人看细节的）
   */
  const [agg, fills] = await Promise.all([
    fillsAgg(ctx.userId, key.id, range.from, range.to, pair),
    listFills(ctx.userId, key.id, limit, pair, range)
  ])

  const data = {
    账户: key.name,
    区间: `${from} ~ ${to}（${days} 天）`,
    币种: symbol || '全部',
    汇总: {
      说明:
        '这一份是**整个区间**的（不受明细条数上限影响），问「做了多少单」用这里的数。',
      总笔数: agg.total.n,
      买入: agg.total.buys,
      卖出: agg.total.n - agg.total.buys,
      成交额: r2(agg.total.cost),
      手续费成本: r2(agg.total.fee),
      已实现盈亏: r2(agg.total.realized)
    },
    按币种: agg.bySymbol.map(b => ({
      币种: b.symbol,
      笔数: b.n,
      买: b.buys,
      卖: b.n - b.buys,
      已实现盈亏: r2(b.realized)
    })),
    按天: agg.byDay.map(d => ({
      日: d.day,
      笔数: d.n,
      已实现盈亏: r2(d.realized)
    })),
    明细: {
      条数: fills.length,
      说明:
        `最近 ${fills.length} 条（区间内共 ${agg.total.n} 条）。` +
        '要看更多明细就把 from/to 收窄 —— 汇总数字永远覆盖整个区间。',
      成交: fills.map(f => ({
        时间: bjStamp(f.datetime ?? ''),
        币种: f.symbol,
        方向: ORDER_SIDE[f.side.toUpperCase()] ?? f.side,
        价格: f.price,
        数量: f.amount,
        成交额: f.cost,
        手续费: f.fee,
        已实现盈亏: f.realized
      }))
    }
  }
  return {
    data,
    rows: agg.total.n,
    detail:
      `${key.name} · ${from} ~ ${to}` +
      (symbol ? ` · ${symbol}` : '') +
      ` · 共 ${agg.total.n} 笔（买 ${agg.total.buys} / 卖 ${agg.total.n - agg.total.buys}）` +
      ` · 手续费 ${r2(agg.total.fee)} · 已实现 ${r2(agg.total.realized)}` +
      ` · 明细给了最近 ${fills.length} 条` +
      (note ? ` · ${note}` : '')
  }
}

async function exchangePnl(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const key = await getDefaultExchangeKey(ctx.userId)
  if (!key) return noExchangeAccount('查盈亏')

  const {from, to, days, note} = normalizeRange(args.from, args.to, today)
  // `sinceDays` 传 null：区间由 `range` 说了算，两个都给会让它算两遍
  const t = await incomeTotals(ctx.userId, key.id, null, ledgerRange(from, to))

  return {
    data: {
      账户: key.name,
      区间: `${from} ~ ${to}（${days} 天）`,
      已实现盈亏: r2(t.realized),
      手续费: r2(t.commission),
      资金费: r2(t.funding),
      其它: r2(t.other),
      净盈亏: r2(t.net),
      流水笔数: t.count,
      口径:
        '净盈亏 = 已实现 + 手续费 + 资金费（手续费 / 资金费在币安那边是负数，所以相加）。' +
        '划转只在「其它」里，不算盈亏。'
    },
    rows: t.count,
    detail:
      `${key.name} · ${from} ~ ${to}（${days} 天） · 净盈亏 ${r2(t.net)}` +
      `（已实现 ${r2(t.realized)} / 手续费 ${r2(t.commission)} / 资金费 ${r2(t.funding)}）` +
      ` · ${t.count} 笔流水` +
      (note ? ` · ${note}` : '')
  }
}

async function exchangeLedger(
  args: Record<string, unknown>,
  ctx: AskToolContext,
  today: string
): Promise<AskToolResult> {
  const key = await getDefaultExchangeKey(ctx.userId)
  if (!key) return noExchangeAccount('查资金流水')

  const {from, to, days, note} = normalizeRange(args.from, args.to, today)
  const pick = String(args.type ?? 'all').trim()
  if (!(pick in INCOME_PICKS))
    throw new ToolInputError(
      `type 只能是 ${Object.keys(INCOME_PICKS).join(' / ')}`
    )
  const types = INCOME_PICKS[pick]
  const limit = clampInt(args.limit, 60, 500)

  const rows = await listIncome(ctx.userId, key.id, limit, {
    ...ledgerRange(from, to),
    types
  })

  const data = rows.map(r => ({
    时间: bjStamp(r.datetime),
    类型: INCOME_LABEL[r.incomeType] ?? r.incomeType,
    币种: r.symbol || '—',
    金额: r.amount,
    资产: r.asset
  }))
  return {
    data: {账户: key.name, 区间: `${from} ~ ${to}`, 筛选: pick, 流水: data},
    rows: rows.length,
    detail:
      `${key.name} · ${from} ~ ${to}（${days} 天） · ` +
      `${pick === 'all' ? '全部类型' : INCOME_LABEL[types?.[0] ?? ''] ?? pick} · ${rows.length} 笔` +
      (note ? ` · ${note}` : '')
  }
}

async function exchangeAccount(ctx: AskToolContext): Promise<AskToolResult> {
  const key = await getDefaultExchangeKey(ctx.userId)
  if (!key) return noExchangeAccount('查账户资产')

  const snap = await latestSnapshot(ctx.userId, key.id)
  if (!snap) {
    return {
      data: {账户: key.name, 说明: '还没有采集到资产快照（刚配置的 Key 要等一次采集）'},
      rows: 0,
      detail: `${key.name} · 还没有资产快照`
    }
  }

  const ov = snap.overview
  const f = ov.futures
  // 最近 7 天净资产的走势（1 小时一个桶）；`hours = null` 才是全部历史
  const curve = await listCurve(ctx.userId, key.id, 24 * 7, 3600)
  const closes = curve.map(p => p.close)
  const first = closes[0] ?? null
  const last = closes.at(-1) ?? null

  const positions = f.positions.map(p => ({
    币种: p.symbol,
    方向: p.side === 'long' ? '多' : p.side === 'short' ? '空' : p.side,
    数量: p.amount,
    名义价值: r2(p.notional),
    开仓价: p.entryPrice,
    标记价: p.markPrice,
    强平价: p.liquidationPrice,
    杠杆: p.leverage,
    未实现盈亏: r2(p.unrealizedPnl),
    收益率: p.percentage === null ? null : r2(p.percentage)
  }))

  return {
    data: {
      账户: key.name,
      采集时间: bjStamp(ov.takenAt),
      距现在秒: snap.ageSec,
      数据可能过期: snap.stale,
      采集异常: snap.err,
      净资产: r2(netOf(ov)),
      钱包余额: r2(f.wallet),
      浮动盈亏: r2(f.unrealized),
      保证金余额: r2(f.margin),
      可用: r2(f.available),
      占用: r2(f.used),
      保证金率: f.margin ? r2((f.maintMargin / f.margin) * 100) : null,
      C2C钱包USDT: ov.c2c ? r2(ov.c2c.totalUsdt) : null,
      现货USDT: ov.spot ? r2(ov.spot.usdt) : null,
      持仓数: positions.length,
      持仓: positions,
      近7天净资产:
        first === null || last === null
          ? '（这 7 天没有快照）'
          : {
              起: r2(first),
              止: r2(last),
              变化: r2(last - first),
              最高: r2(Math.max(...closes)),
              最低: r2(Math.min(...closes))
            }
    },
    rows: positions.length,
    detail:
      `${key.name} · 净资产 ${r2(netOf(ov))} · 浮动盈亏 ${r2(f.unrealized)} · ` +
      `${positions.length} 个持仓 · 快照 ${Math.round(snap.ageSec / 60)} 分钟前`
  }
}

async function exchangeOrders(ctx: AskToolContext): Promise<AskToolResult> {
  const key = await getDefaultExchangeKey(ctx.userId)
  if (!key) return noExchangeAccount('查挂单')

  const rows = await listOpenOrdersDb(ctx.userId, key.id)
  const data = rows.map(o => ({
    币种: o.symbol,
    方向: ORDER_SIDE[o.side.toUpperCase()] ?? o.side,
    类型: o.type,
    价格: o.price,
    触发价: o.stopPrice,
    数量: o.amount,
    已成交: o.filled,
    只减仓: o.reduceOnly,
    下单时间: bjStamp(o.time),
    来源: o.source === 'auto-stop' ? '自动止损' : '手动'
  }))
  return {
    data: {账户: key.name, 挂单: data},
    rows: rows.length,
    detail: `${key.name} · 当前挂着 ${rows.length} 张单`
  }
}

async function exchangeC2c(
  args: Record<string, unknown>,
  ctx: AskToolContext
): Promise<AskToolResult> {
  const key = await getDefaultExchangeKey(ctx.userId)
  if (!key) return noExchangeAccount('查 C2C')

  const limit = clampInt(args.limit, 20, 100)
  const page = await listC2cOrderHistory(ctx.userId, key.id, 1, limit)
  const buys = page.orders.filter(o => o.side === 'Buy')
  const sells = page.orders.filter(o => o.side === 'Sell')

  const data = {
    账户: key.name,
    总笔数: page.total,
    这一页: page.orders.length,
    买入笔数: buys.length,
    买入法币合计: r2(buys.reduce((n, o) => n + o.fiatTotal, 0)),
    卖出笔数: sells.length,
    卖出法币合计: r2(sells.reduce((n, o) => n + o.fiatTotal, 0)),
    订单: page.orders.map(o => ({
      时间: bjStamp(o.timestamp),
      方向: o.side === 'Buy' ? '买入' : '卖出',
      法币: o.fiat,
      法币金额: o.fiatTotal,
      成交价: o.price,
      数量: o.quantity
    }))
  }
  return {
    data,
    rows: page.orders.length,
    detail: `${key.name} · C2C 共 ${page.total} 笔，这一页 ${page.orders.length} 笔`
  }
}
