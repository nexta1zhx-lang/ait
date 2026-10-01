# 开单分析

> **我的规则 + 我的知识库 → 给我一个币种 → 告诉我该不该开单**

前后端分离：`backend/` 是 Node + TypeScript 的 API，`frontend/` 是 Vue3 的单页应用。

| 页面         | 干什么                                              |
| ------------ | --------------------------------------------------- |
| **开单分析** | 选个币种，AI 按我的规则 + 知识库判断该不该做        |
| **知识库**   | 收录我做对 / 做错的案例，AI 提炼成可复用的经验      |
| **用量**     | 每次调用的 token 与花费，人民币计价，带图表和明细表 |

顶部常驻显示**当前模型**（可切换）、**账户余额**（人民币）、规则加载情况、知识库条数。

---

## 启动

### 首次（只做一次）

```bash
npm install                # 装依赖
cp .env.example .env       # 然后编辑 .env，填上 LLM_API_KEY
npm run db:up              # 起数据库（Docker）
npm run sync:contracts     # 拉合约列表（527 个）
```

`.env` 里至少要填这一行，没填就跑不了 —— 判断与提炼都要真实调用大模型：

```bash
LLM_API_KEY=sk-你的key
```

### 每次启动

```bash
npm run web                # → http://localhost:8787
```

**就这一条，不需要 build。** 后端用 `tsx` 直接跑 TypeScript，
前端由后端挂进 Vite 中间件 —— 同一个进程、同一个端口。

启动日志会告诉你当前是哪种模式：

```
  ✅ 开单分析 Web 界面已启动
     http://localhost:8787

  前端    Vite 开发模式 —— 改前端代码立刻生效，不需要 build
  规则    主提示词.md、交易规则与方法.md

  按 Ctrl+C 停止。
```

- 改**前端**代码：立刻生效（热更新），不用重启
- 改**后端**代码：Ctrl+C 再 `npm run web`
- 改 **rules/ 下的规则**：立刻生效，连重启都不用，下次分析自动重读

### 数据库

数据库没起来，页面会打不开（后端会打印 `npm run db:up` 的提示）。

```bash
npm run db:up              # 启动（Docker）
npm run db:status          # 看连接状态 + 各表条数
npm run db:down            # 停止
npm run db:reset -- --yes  # 清空数据（知识库 / 分析记录 / 用量）
```

### 端口被占用

之前起的服务还占着 8787 时会报 `EADDRINUSE`，先关掉它：

```bash
pkill -f "tsx backend/src/server.ts"
npm run web
```

想换端口：`PORT=9000 npm run web`

### 不想开网页

```bash
npm run dev -- BTC/USDT        # 直接分析一个币
npm run history              # 看历史分析 / 档位胜率
npm run cost -- --days 7       # 看 API 花费
npm run swing -- SOL 4h        # 只看拉升检测
npm run selftest               # 离线自检（不需要网络和 Key）
```

### 也可以只跑前端

比如要用浏览器开发者工具的 Vue 面板调试前端：

```bash
npm run web                # 终端 1：后端
npm run ui:dev             # 终端 2：→ http://localhost:5173（/api 自动代理到 8787）
```

### 部署时才需要 build

生产环境不装 `vite` / `tsx`，所以要预先生成静态文件和 JS：

```bash
npm run build:all          # 编译后端 → backend/dist，构建前端 → frontend/dist
npm run web:start          # 跑编译版（自动走静态托管）
```

即使装了 `vite`，也可以用 `FRONTEND=dist npm run web` 强制走静态托管，
用来验证「构建后的样子」。

---

## 目录结构

```
backend/                    后端（Node + TypeScript，没有任何 Web 框架）
├─ src/
│  ├─ server.ts             HTTP 服务 + 全部 API 路由（node:http，无依赖）
│  ├─ cli.ts                命令行入口
│  ├─ rules.ts              读取 rules/ 目录
│  ├─ knowledge-service.ts  收录案例的完整链路
│  ├─ config.ts             配置（.env + config/guardrails.yaml）
│  ├─ analysis/             拉升检测、段落描述、期望值计算
│  ├─ data/                 ccxt 拉行情、趋势、市场热度
│  ├─ context/              行情 → LLM 可读文本
│  ├─ llm/                  判断、提炼、提示词、计价、余额与模型
│  ├─ db/                   PostgreSQL（存档 / 规则版本 / 知识库 / 用量）
│  ├─ guardrails/           代码层的红线与仓位计算
│  ├─ devtools/            Vite 中间件（开发时零构建的关键）
│  └─ scripts/              selftest / swing / learn / cost / history / db
└─ tsconfig.json

frontend/                   前端（Vue3 + Vite）
├─ src/
│  ├─ App.vue              顶部栏（导航 + 模型切换 + 余额）
│  ├─ router.ts            四个页面的路由
│  ├─ store.ts             全局状态（配置 / 账户 / 合约列表）
│  ├─ api.ts               所有接口的类型与调用
│  ├─ format.ts            金额、token、北京时间格式化
│  ├─ comps/               通用组件（图表、表格、卡片、币种下拉…）
│  └─ views/               四个页面：开单分析 / 历史 / 知识库 / 用量
├─ vite.config.ts
└─ tsconfig.json

rules/                      ★ 我的规则（只读，每次分析自动注入）
data/contracts.json         本地合约列表（npm run sync:contracts 生成）
config/guardrails.yaml      账户资金 / 风险 / 杠杆 / 红线
docker-compose.yml          PostgreSQL
```

**为什么后端不用框架**：全部业务是「调 API → 算数 → 存库」，
原生 `node:http` 加一张手写路由表就够，少一层依赖。
所有 `/api` 都开了 CORS，前端想独立部署也可以。

**关于 build**：`tsc` 只是把 TypeScript 翻成 JavaScript，换 Express / Fastify /
NestJS / Next.js 都一样需要。真正解决「开发时不想 build」的不是换框架，而是
**别用编译产物跑开发**：后端用 `tsx` 直接执行 TS，前端用 Vite 中间件直接吃源码。
所以 `npm run web` 就够了，`build` 只留给部署。

---

## 模块一 · 我的规则（只读文件）

```
rules/
├─ 主提示词.md            ← AI 的角色设定（system prompt）
├─ 交易规则与方法.md        ← 规则正文
└─ _原始-AI辅助提示词.md    ← 旧版留档，下划线开头 = 不注入
```

- **网页上不显示、不编辑** —— 规则像代码一样用编辑器改、用 git 管版本
- 每次分析**自动全部读取**，改完**不用重启**
- 页顶一行 `规则 2 个文件 · 6.6K · 74110e78cea1` 让你知道读到了
- 文件名以 `_` 开头或叫 `README` → 跳过

详见 [`rules/README.md`](./rules/README.md)。

---

## 模块二 · 知识库（可积累的经验）

填**币种**（+ 周期）→ 选**「我该做的」还是「我不该做的」** → 收录。系统自动：

1. 拉这段行情
2. **自动找出主拉升段**（ATR 归一化 ZigZag 拐点 + 力度/资金打分）
3. **只保留「拉升前 + 拉升后」两段**（前段最多 60 根蓄势，后段最多 40 根）
4. 让 AI 用**你的体系语言**描述这个案例，提炼一条可复用的经验
5. 存进知识库

只关心某段时间就展开「只关心某一段时间？」填起止日期。

### 拉升检测怎么做

用成熟做法 —— **ATR 归一化的 ZigZag 拐点检测**：

```
1. 算 ATR(14)（Wilder 平滑），把波动归一化 → 不同币、不同周期可比
2. ZigZag：从极值回撤超过 2×ATR 才认转折，滤掉噪声
3. 相邻拐点连成「腿」，只看上升腿
4. 打分 = 力度(涨了几个 ATR) × 资金(量能放大倍数)
5. 取分最高、且够得上门槛（≥3×ATR）的那条腿 = 主拉升
6. 截窗口：[拉升起点 - 60根] … [拉升终点 + 40根]
```

想先看看检测效果：

```bash
npm run swing -- BTC 4h          # 看它的主拉升段和入库窗口
npm run swing -- SOL 1h --days 30
```

### 知识库怎么影响判断

分析时**不注入完整案例**，只注入**经验条目**，按档位归类：

```markdown
### 我做对的（照这样找）

- [BTC 4h C档] 回踩不破前高，右侧进的

### 我踩过的坑（出现类似特征就拒绝）

- [ROBO 1h B档] 突破一点后续没力量
```

100 条经验约 4000 字，注入成本很低。

---

## 模块三 · 开单分析

选币种 → 点「让 AI 判断」。周期和假设胜率由后端配置决定，页面上不用填。
系统会拉多周期行情，把**规则 + 知识库经验 + 行情快照**一起给 AI。

### 页面怎么排的

**整页不滚动**：`body.fixed-viewport`（只在这一页挂）把页面锁成 `100vh`，
各栏自己内部滚。`/history`、`/knowledge`、`/usage` 还是普通长文档。

```
┌────────────────────────────────────────────────────────────┐
│ 币种 + 让 AI 判断 + 看周期/模型                              │
├──────────────────────┬─────────────────────────────────────┤
│ 实时分析 │ 历史分析    │ K 线图                               │
│ ──────────────────── │   （铺满右栏高度）                    │
│ 分析过程（跑时展开）   │                                     │
│ 出结论后收成一行      │                                     │
│ ──────────────────── │                                     │
│ AI 结论 │ Checklist  │                                     │
│ 怎么做 │ 市场与周期   │                                     │
│ ──────────────────── │                                     │
│ ⚠️ 当前最该守住的     │                                     │
└──────────────────────┴─────────────────────────────────────┘
```

左边窄（约 1/3）、右边宽（约 2/3）。

**左边一级两个 tab**：`实时分析` / `历史分析`。

- **实时分析** 里面再分四个二级 tab：
  `AI 结论`（档位与理由）· `Checklist`（7 条逐项核对）·
  `怎么做`（入场 / 止损 / 止盈 / 期望值 / 仓位）·
  `市场与周期`（资金费率 / 持仓量 / 多空比 + 多周期趋势表），
  下面跟一块 `后续怎么跟`（分「已开单 · 必须走」和「还没开 · 出现才回头看」）。这一段内容超出左栏高度时自己滚。
- **历史分析** 是这只币自己的历史记录（时间 / 档位 / 结论 / 结算结果 / R），
  点一条直接跳 `/history?id=N` 复盘。

`⚠️ 当前最该守住的` 钉在左栏底部、不参与滚动 —— 它是每次最该看的那句话，
不该被藏在滚动条下面。

**没有任何结论时，结论区一块都不渲染** —— 不摆「有结论后这里会填上」这种占位。

### 分析过程是逐步吐出来的

点按钮后走 `GET /api/analyze/stream`（SSE），每完成一步就推一条：

```
读取我的规则      主提示词.md、交易规则与方法.md · 6.6K 字 · 74110e78cea1   1ms
取知识库经验      知识库为空，跳过                                        6ms
拉取 BTC 行情     BTC/USDT:USDT · 15m/1h/4h/1d · 300 根 K 线 · 现价 83,799.9  2.4s
构建喂给 AI 的行情快照  3147 字                                          21ms
调用 deepseek-flash 判断  deepseek-flash · 6514+1838 tok · 回答 1901 字   8.9s
护栏与仓位校验（代码）  通过 3 项检查                                     3ms
记账并存档        存档 #8 · 花费 ¥0.020（$0.0029）                       22ms
```

调模型那一步要 8~10 秒，以前只能干等；现在能看见卡在哪一步。
一次分析和 `GET /api/analyze` 走的是同一段代码（`runAnalysis`），只是多了个进度回调。

### 输出长这样

```
判档      B 档 · 不该做        命中：②区间/盘整里来回做 + ③无动向就开单
结论      ⛔ 不可做           把握 86/100
本次调用  ¥0.020（$0.0029）· 6,514 + 1,838 tok · 8.9s

Checklist（逐条核对，7 项固定）
  ❌ 这个币强势吗？        趋势=down，结构=更低的高点 + 更低的低点
  ❌ 止损位写得出吗？       下方没有可依托的结构位，写不出止损
  ⚠️ 心态是否平稳？        数据无法判断，请你自己确认

怎么做    入场 / 止损 / 止盈 / 期望值 / 建议仓位（代码算的，不采信 AI 的算术）
必须走    跌破 83,136.6 结构低点就走 · 反弹到 84,379.8 无力放量就兑现
⚠️ 当前最该守住的   区间就不做，不确定就不做——不去空、不开单，就已经是赚
```

**输出格式由代码固定**（`backend/src/llm/prompt.ts` 的 JSON 契约），
这样前端才能渲染成卡片。改 `主提示词.md` 时只关心判断逻辑，不用管格式。

### 一切都要带周期

**趋势永远是「某个周期的趋势」**，脱离周期说趋势等于没说。契约里明确要求：

- 任何趋势 / 结构 / 强势 / 盘整 / 突破的描述都必须标明周期 ——
  写「1h 震荡、4h 上涨、15m 下跌」，不许只写「趋势是震荡」
- 判档要说清是**哪个周期**给的依据
- 多周期打架必须点明**是哪几个周期冲突**，以及以哪个为准、为什么
- 入场 / 止损 / 止盈的价格要说清是**从哪个周期的结构**取的

实际输出长这样：

```
命中 B 档第 2 条：4h 是震荡区间 112.39–124.99，1h 区间 122.8/116.25，
当前 117.33 就在区间内偏下。全周期量比 0.27 / 0.47 / 0.45 / 0.30，都低于 0.5。
不构成 A 档：1h 虽为上涨结构，但 15m 已是下跌结构，15m 与 1h 方向打架。
```

### 只判「当下看得见的事」

Checklist 共 7 条，全部是行情快照里能验证的：强势 / 盘整结构 / 强力 K /
**各周期趋势是否一致** / 止损位 / 时段 / 心态。

**「后续还有没有力量」已被移除** —— 那是预测，当下数据看不出来。
C 档的必要条件相应变成两条：①有盘整结构 ②有强力 K / 放量突破。

取而代之的是 `exitPlan`，分两种处境写**可观察的触发条件**：

```json
"exitPlan": {
  "holding":  ["已开单：跌破 82,724.3 不能收回 → 走"],
  "watching": ["还没开：1h 放量站上 84,379.8 且回踩不破 → 才回头看"]
}
```

契约里明确要求：只写价格位置 / 量比 / 结构破位这类可验证事件，
不许写「后续会有力量」这种话；没持仓时 `holding` 直接给 `[]`。

---

## 模块四 · 用量与花费

每次调用大模型都会记一笔：输入/输出 token、缓存命中、耗时、花费。

- 顶部徽标：今日 / 累计花费，点开进「用量」页
- 用量页：KPI 卡片 + 每天花费柱状图 + token 构成 + 按天/用途/模型的表格 + 调用明细（分页）
- 命令行：

```bash
npm run cost                 # 最近 30 天
npm run cost -- --days 7     # 换区间
npm run cost -- --recent 20  # 多看几笔明细
npm run cost -- --json       # 原始 JSON
```

### 计价

$$\text{cost} = \frac{\text{命中 token} \times p_{hit} + \text{未命中 token} \times p_{miss} + \text{输出 token} \times p_{out}}{10^6}$$

- **展示统一用人民币**，括号里的美元是原价（记录里存的是美元，汇率只影响展示）
- 单价按 DeepSeek 官方价目表维护在 `backend/src/llm/pricing.ts`
- **低谷自动减半**：高峰 = UTC 01:00-04:00 与 06:00-10:00 的工作日，其余减半
- 每笔都存下当时的单价快照，官方以后调价也不会篡改历史
- 缓存命中比未命中便宜几十倍 —— 规则和知识库前缀稳定不变时命中率会自然升高
- 想用自己的数：`.env` 里覆盖 `LLM_PRICE_INPUT_HIT / LLM_PRICE_INPUT_MISS / LLM_PRICE_OUTPUT`（填高峰价）
- 汇率 `USD_CNY`（默认 7.1）只影响展示


---

## 账户：余额与模型切换

顶部栏常驻：

| 控件          | 说明                                                        |
| ------------- | ----------------------------------------------------------- |
| **模型** 下拉 | `GET /models` 拿到的真实模型列表，拿不到就用内置的 |
| **余额** 按钮 | DeepSeek 账户余额（人民币）。点一下刷新（服务端缓存 60 秒） |

DeepSeek 目前只有两个模型：`deepseek-flash`（便宜、够用）和
`deepseek-v4-pro`（更强、贵几十倍）。下拉里就这两项。

`.env` 里写 `deepseek-chat` / `deepseek-reasoner` 这类旧别名也能跑 ——
读配置时会自动归一到上面两个，免得同一个模型在用量和存档里被记成两个名字。

切换模型会**写回 `.env` 的 `LLM_MODEL`**，重启也保留。

```bash
curl localhost:8787/api/account
curl -X POST localhost:8787/api/account/model \
     -H 'Content-Type: application/json' -d '{"model":"deepseek-v4-pro"}'
```

余额走 DeepSeek 官方的 `GET /user/balance`，返回的就是人民币，不做汇率换算。

---

## 数据

PostgreSQL（Docker，数据卷 `ca-pgdata`），四张表：

| 表               | 存什么                                       |
| ---------------- | -------------------------------------------- |
| `analyses`       | 每次分析的完整存档（输入 / 结论 / 计划 / 结果） |
| `rules_versions` | 规则全文快照，按内容 hash 去重                 |
| `knowledge`      | 知识库案例（含前后两段 K 线）                  |
| `llm_usage`      | 每次 API 调用的 token 与花费                   |

**规则本身不存数据库** —— 直接读 `rules/` 目录，改完不用重启。

### 分析存档怎么分层

一次分析的字段很多，塞法按用途分三类：

- **要筛选 / 排序 / 统计的** → 独立列。
  档位、结论、币种、入场价、止损价、期望值 R、R 倍数……这些是拿来算胜率的，必须是列。
- **只用来看详情的** → JSONB。
  AI 的完整输出（`result`）、护栏明细（`guardrails`）、当时行情（`snapshot`）。
  这些不会用来查询，拆成列只是给自己找麻烦。
- **会重复的长文本** → 单独一张表按 hash 去重。
  规则全文 6.6K，每行分析存一份就废了。`analyses.rules_hash` 指向 `rules_versions`，
  这样「规则改了以后，旧分析还能还原现场」。

### 存档是为了复盘

每条 `analyses` 都带一组事后字段：`outcome` / `r_multiple` / `mfe_pct` / `mae_pct` /
`outcome_note`。跑完一单回到「历史」页填上结果，就能看到：

- 每个档位（A / B / C）的真实胜率与平均 R
- 哪些币反复在做
- 「可做」但还没结算的有多少

如果 A 档的胜率长期不比 B 档高，说明 `rules/` 里的分档跟实际结果对不上 ——
那要改的是规则文件，不是这套统计。

```bash
npm run db:up               # 启动
npm run db:status           # 连接 + 各表条数
npm run db:down             # 停止
npm run db:reset -- --yes   # 清空数据
```

---

## 命令速查

### 日常（全部 `tsx` / Vite 直跑，不需要编译）

| 命令                                                                     | 干什么                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `npm run web`                                                            | 起服务 → http://localhost:8787                              |
| `npm run ui:dev`                                                         | 只跑前端 → http://localhost:5173                            |
| `npm run dev -- BTC/USDT`                                                | 命令行分析                                                  |
| `npm run history`                                                        | 历史分析：列表 / 档位胜率 / 结算复盘                         |
| `npm run learn -- MAGMA 4h --do "回调不破，右侧进的"`                    | 收录正面案例                                                |
| `npm run learn -- ROBO 1h --dont "突破一点后续没力量"`                   | 收录反面案例                                                |
| `npm run learn -- MAGMA 4h --do "..." --from 2026-09-01 --to 2026-09-15` | 只关心某段时间                                              |
| `npm run swing -- BTC 4h`                                                | 只看拉升检测                                                |
| `npm run cost -- --days 7`                                               | API 用量与花费（`--json` / `--recent N` / `--clear --yes`） |
| `npm run selftest`                                                       | 离线自检：护栏 + 仓位 + 渲染，不需要网络和 Key               |
| `npm run typecheck`                                                      | 类型检查                                                    |
| `npm run db:up` / `db:down` / `db:status` / `db:reset`                   | 数据库                                                      |
| `npm run sync:contracts`                                                 | 重新拉合约列表                                              |

### 部署 / 发布

| 命令                | 干什么                           |
| ------------------- | -------------------------------- |
| `npm run ui:build`  | 构建前端 → `frontend/dist`       |
| `npm run build`     | 编译后端 → `backend/dist`        |
| `npm run build:all` | 上面两步                         |
| `npm run start`     | 跑编译后的 CLI                   |
| `npm run web:start` | 跑编译后的服务（自动走静态托管） |
| `npm run clean`     | 清掉两边产物                     |

---

## API

后端所有接口都开了 CORS，可以单独调用（前端独立部署也行）。

| 接口                                          | 干什么                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `GET /api/health`                             | 数据库连接 + 规则加载情况                                    |
| `GET /api/config`                             | 页面初始化的全部信息（规则 / 知识库条数 / 花费 / 余额）      |
| `GET /api/account`                            | 余额 + 可用模型（`?refresh=1` 绕过 60 秒缓存）               |
| `POST /api/account/model`                     | 切换模型，写回 `.env`                                        |
| `GET /api/contracts`                          | 本地合约列表                                                 |
| `GET /api/candles?symbol&timeframe&limit`     | K 线 + 最近 4 小时压力支撑                                   |
| `GET /api/analyze?symbol`                     | 开单分析（周期与胜率用后端默认值，结果自动存档）             |
| `GET /api/analyze/stream?symbol`              | 同上，但用 SSE 逐步推进度（`step` → `done`）                |
| `GET /api/analyses`                           | 历史分析列表 + 档位统计                                      |
| `GET /api/analyses/:id`                       | 单条分析完整详情（含当时的规则原文）                         |
| `POST /api/analyses/:id/settle`               | 填事后结果（到没到 TP / 打没打止损 / R 倍数）                 |
| `DELETE /api/analyses/:id`                    | 删除一条分析                                                 |
| `POST /api/knowledge`                         | 收录案例（`{symbol,timeframe,label,note?,from?,to?,save?}`） |
| `GET /api/knowledge?label=`                   | 案例列表                                                     |
| `GET /api/knowledge/:id`                      | 案例详情（含 K 线）                                          |
| `DELETE /api/knowledge/:id`                   | 删除案例                                                     |
| `GET /api/usage/summary?days&kind`            | 用量汇总                                                     |
| `GET /api/usage/calls?days&kind&limit&offset` | 用量明细（分页）                                             |

---

## 它不做什么

- **不预测涨跌** —— 只回答「按你的规则和过往经验，现在该不该做」
- **不自动下单**
- **不用技术指标** —— 只看价格结构（更高的高点 / 更低的低点）、市场热度、周期是否一致
  （ATR 只在后台用于**归一化检测拉升**，不作为判断依据喂给 AI）

## 免责声明

输出为交易纪律辅助，不构成投资建议。所有决策与风险由使用者自行承担。
