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

`.env` 至少要填这一行，否则只能跑「模拟判断」：

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
npm run dev -- BTC/USDT --mock # 离线跑通（不花钱）
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
│  ├─ analysis/             拉升检测、段落描述
│  ├─ data/                 ccxt 拉行情、趋势、市场热度
│  ├─ context/              行情 → LLM 可读文本
│  ├─ llm/                  判断、提炼、提示词、计价、余额与模型
│  ├─ db/                   PostgreSQL（知识库 / 分析记录 / 用量）
│  ├─ guardrails/           代码层的红线与仓位计算
│  ├─ devtools/            Vite 中间件（开发时零构建的关键）
│  └─ scripts/              selftest / swing / learn / cost / db
└─ tsconfig.json

frontend/                   前端（Vue3 + Vite）
├─ src/
│  ├─ App.vue              顶部栏（导航 + 模型切换 + 余额）
│  ├─ router.ts            三个页面的路由
│  ├─ store.ts             全局状态（配置 / 账户 / 合约列表）
│  ├─ api.ts               所有接口的类型与调用
│  ├─ format.ts            金额、token、北京时间格式化
│  ├─ comps/               通用组件（图表、表格、卡片、币种下拉…）
│  └─ views/               三个页面
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
系统会拉多周期行情，把**规则 + 知识库经验 + 行情快照**一起给 AI：

```
判档      B 档 · 不该做        命中：①弱势币种（结构不支持）
结论      ⛔ 不可做
本次调用  ¥0.009（$0.0012）· 4,000 + 300 tok · 2.4s

Checklist（逐条核对，7 项固定）
  ❌ 这个币强势吗？        趋势=down，结构=更低的高点 + 更低的低点
  ❌ 止损位写得出吗？       下方没有可依托的结构位，写不出止损
  ⚠️ 心态是否平稳？        数据无法判断，请你自己确认

怎么做    入场 / 止损 / 止盈 / 期望值 / 建议仓位（代码算的）
必须走    动能衰竭就走 · 冲高加速段兑现
⚠️ 当前最该守住的   弱势千万不能赌突破，不去空就已经很好了
```

**输出格式由代码固定**（`backend/src/llm/prompt.ts` 的 JSON 契约），
这样前端才能渲染成卡片。改 `主提示词.md` 时只关心判断逻辑，不用管格式。

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

> 模拟判断也会记一笔，但 token 与花费为 0，统计里单独标出来。

---

## 账户：余额与模型切换

顶部栏常驻：

| 控件          | 说明                                                        |
| ------------- | ----------------------------------------------------------- |
| **模型** 下拉 | 可切换的模型（`GET /models` 拿到的列表，拿不到就用内置的）  |
| **余额** 按钮 | DeepSeek 账户余额（人民币）。点一下刷新（服务端缓存 60 秒） |

切换模型会**写回 `.env` 的 `LLM_MODEL`**，重启也保留。

```bash
curl localhost:8787/api/account
curl -X POST localhost:8787/api/account/model \
     -H 'Content-Type: application/json' -d '{"model":"deepseek-v4-pro"}'
```

余额走 DeepSeek 官方的 `GET /user/balance`，返回的就是人民币，不做汇率换算。

---

## 数据

PostgreSQL（Docker，数据卷 `ca-pgdata`），三张表：

| 表          | 存什么                        |
| ----------- | ----------------------------- |
| `knowledge` | 知识库案例（含前后两段 K 线） |
| `analyses`  | 分析记录（回溯用）            |
| `llm_usage` | 每次 API 调用的 token 与花费  |

**规则不存数据库** —— 直接读 `rules/` 目录。

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
| `npm run dev -- BTC/USDT --mock`                                         | 离线跑通，不花钱                                            |
| `npm run learn -- MAGMA 4h --do "回调不破，右侧进的"`                    | 收录正面案例                                                |
| `npm run learn -- ROBO 1h --dont "突破一点后续没力量"`                   | 收录反面案例                                                |
| `npm run learn -- MAGMA 4h --do "..." --from 2026-09-01 --to 2026-09-15` | 只关心某段时间                                              |
| `npm run swing -- BTC 4h`                                                | 只看拉升检测                                                |
| `npm run cost -- --days 7`                                               | API 用量与花费（`--json` / `--recent N` / `--clear --yes`） |
| `npm run selftest`                                                       | 离线自检，不需要网络和 Key                                  |
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
| `GET /api/analyze?symbol&mock`                | 开单分析（周期与胜率用后端默认值）                           |
| `POST /api/knowledge`                         | 收录案例（`{symbol,timeframe,label,note?,from?,to?,save?}`） |
| `GET /api/knowledge?label=`                   | 案例列表                                                     |
| `GET /api/knowledge/:id`                      | 案例详情（含 K 线）                                          |
| `DELETE /api/knowledge/:id`                   | 删除案例                                                     |
| `GET /api/usage/summary?days&kind&realOnly`   | 用量汇总                                                     |
| `GET /api/usage/calls?days&kind&limit&offset` | 用量明细（分页）                                             |

---

## 它不做什么

- **不预测涨跌** —— 只回答「按你的规则和过往经验，现在该不该做」
- **不自动下单**
- **不用技术指标** —— 只看价格结构（更高的高点 / 更低的低点）、市场热度、周期是否一致
  （ATR 只在后台用于**归一化检测拉升**，不作为判断依据喂给 AI）

## 免责声明

输出为交易纪律辅助，不构成投资建议。所有决策与风险由使用者自行承担。
