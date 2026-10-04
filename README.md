# 开单分析 · crypto-entry-advisor

给一个币，把行情切段读成文字，交给大模型**预测接下来最大概率会走成什么样**，
顺带给每个形状标签一个概率。

> 不是投资建议，只做纪律辅助。

---

## 一分钟看懂它在干什么

```
拉 K 线  →  切成小段读成文字  →  拼上下文  →  调模型  →  结论 + 标签概率  →  存档
```

**核心原则：不给 AI 算口径、不给 AI 判档。**

- 以前是「代码算好趋势 / 摆动点 / 量比，AI 按 A/B/C 档填表」。
  现在代码只负责**取数**和**把 K 线读成文字**，怎么读、怎么判断全交给 AI。
- AI 输出**只有 6 个字段**：标签（带概率）、理由、走势、走势概率、结论、推荐。
- 没有止损止盈、没有仓位、没有 checklist、没有护栏校验 —— 那些都删了。
- **提示词写在代码里**（`backend/src/llm/prompts.ts`），改完要**重新部署**。
- 知识库**不注入** prompt，只借它一份**标签池**。

---

## 跑起来

```bash
npm install
npm run db:up          # 起 PostgreSQL（Docker）
npm run web            # 开发模式：后端 + Vite HMR，浏览器开 http://localhost:8787
```

命令行直接分析一个币：

```bash
npm run dev -- BTC/USDT                 # 默认 1h 周期、看最近 3 天（CLI 才有天数参数）
npm run dev -- BTC/USDT -t 4h -d 30     # 换周期 / 换天数
```

| 命令                                                               | 干什么                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `npm run web`                                                      | 起网页（`tsx` 直跑 TS，不用 build）                                |
| `npm run dev -- <币> [-t 周期] [-d 天数]`                          | 命令行分析                                                         |
| `npm run typecheck`                                                | 后端类型检查                                                       |
| `npm run selftest`                                                 | 契约自检（骨架 ↔ zod schema ↔ 枚举）                               |
| `npm run ui:build`                                                 | 打前端产物                                                         |
| `npm run build:all`                                                | 后端 tsc + 前端 vite                                               |
| `npm run db:up` / `db:down` / `db:logs` / `db:status` / `db:reset` | 数据库                                                             |
| `npm run history`                                                  | 命令行看历史分析与标签分布                                         |
| `npm run cost`                                                     | 看用量与花费                                                       |
| `npm run reprice`                                                  | **重算历史花费**（改过节假日表/时段规则后跑；加 `--write` 才写库） |
| `npm run peak`                                                     | 列全年每天算高峰还是空闲（核对节假日表用）                         |
| `npm run learn` / `npm run swing`                                  | 辅助脚本                                                           |
| `npm run sync:contracts`                                           | 拉交易所合约表                                                     |

环境变量放 `.env`（只剩交易所 / 数据库 / 汇率这些；`EXCHANGE` / `MARKET_TYPE` / `API_BASE` 可选）。
**大模型配置（Key / 模型 / 接口地址 / 思考力度）不放 `.env`** —— 按用户存在数据库里，
在网页「我的 → 模型配置」里填；管理员能在「我的 → 管理」看每个人的配置。
网页右上角切换模型现在写的是**你自己的**配置，重启也保留；旁边那个「余额 ¥x.xx」
是模型账户还剩多少钱（`GET /api/account` → DeepSeek `/user/balance`，后端带 60 秒缓存，
**点一下才是真刷新**）。

---

## 线上部署

**已上线：<https://bitcoooin.cn>** —— AWS Lightsail（东京）+ Docker Compose + Caddy 自动 HTTPS。

完整步骤与运维看 [`docs/DEPLOY.md`](./docs/DEPLOY.md)，日常就一件事：

```bash
bash release.sh            # 本机跑：类型检查 → 打包 → 上传 → 远端部署 → 公网验收
bash release.sh --dry-run  # 只看打包结果和要执行的命令，不碰服务器
```

它内部用 tar + scp 搬运（不要用 rsync：macOS 自带的是 openrsync，和服务器 rsync 3.x
不保证兼容），并自动排除 `.env` / `android` / `*.apk`，清掉服务器上的旧文件后再解包
—— 细节看 `docs/DEPLOY.md`。

两个最容易忘的：**Lightsail 防火墙要放行 80 / 443**；
**打包必须 `--exclude='.env'`**（服务器那份里有随机化过的 `PGPASSWORD`，被覆盖就连不上库）。

生产与开发的差别只有一个：`NODE_ENV=production` 时后端**跳过 Vite**、直接托管
`frontend/dist`，所以线上不需要 `vite` / `tsx`（镜像多阶段构建，只带生产依赖）。

---

## 页面

| 路由         | 干什么                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| `/contracts` | **合约行情**（默认页）。全市场榜单，点一行就去开单分析                  |
| `/analyze`   | **开单分析**。行情条 + K 线，左栏一级 tab 见下                         |
| `/history`   | **预测历史**（`?tab=kb` 切知识库）。左三张饼图，右记录列表；点饼图即筛 |
| `/usage`     | **用量**。每次调用花了多少钱                                           |
| `/me`        | **我的**：预测历史 / 知识库 / 模型配置 / 用量 / 管理 / 个人信息        |
| `/download`  | **下载**。列全部历史安装包（独立页，不进导航）                         |
| 其余          | 302 到上面几个                                                         |

开单分析左栏一级 tab：**合约行情 / K 线 / 实时分析 / 测试 / 历史分析 / 添加案例**
（窄屏会去掉「测试」和「添加案例」，把它们并进 K 线头部的「＋」）。

登录后才有业务数据（行情 / K 线 / 币种 / 图标 / 下载清单无需登录）。
账号由管理员在「我的 → 管理」创建 —— **不开放注册**。

### `/` 上怎么取数

- **主周期 = 图上那个周期**（5分 / 15分 / 1时 / 4时 / 日线）—— 页面上切周期，AI 看的就是它
  （不切的话两边会不一致）。
- 主周期看的就是**图上那一段**：`CHART_BARS`（`frontend/src/analyze.ts`，基准 200 根），
  实际根数**跟屏幕宽度走**（`KlineChart.vue`），换出来的天数发给后端。
  页面上**不给用户填天数**。
- 其余周期**跟着主周期走**，取多少天由 `config/calibers.yaml` 决定：

  ```yaml
  取数:
    其余周期:
      5m: {15m: 2, 1h: 10, 4h: 20, 1d: 30}
      1h: {15m: 2, 4h: 30, 1d: 60}
      15m: {1h: 10, 4h: 20, 1d: 30}
      4h: {1d: 60}
      1d: {}
    最少根数: 30
    最多根数: 1500
  ```

  ⚠️ **每一行都要写全**：漏了哪一行，那个主周期就**一个其它周期都不带**
  （5m 一开始就是漏的 → AI 只看得到最近 1 天的 5 分钟 K 线，看不到大周期方向）。
  改完即时生效，不用重启。

### 测试模式（`/` 左上角切「测试」）

回到过去某一刻看「当时」。用**结束线**指定那一刻，**不用划范围**：

- 在右边 K 线上**点一根**，线就落在那根的收盘上；**已经放好的线可以直接拖**（左右拉，
  面板上的「判断时点」会跟着跳）
- AI 只看到**这一根收盘为止**的 K 线，之后的一根都不给
- 取数永远是「以这一刻为终点往前推 N 根」，所以**只需要一个时刻** ——
  划一段会让人误以为 AI 只看那一段（其实只有结束那一刻参与取数）
- **图本身不截断**：结束线纯粹是个输入，后面的行情照画（否则会像「后面没行情了」）
- 那一刻之后的行为，可以拿来对照 AI 当时说的走势对不对
- 资金费率 / 持仓量 / 多空比拿不到（那些接口只返回「现在」），留空
- **不存档**，不混进预测历史

（「添加案例」那个 tab 才是真的**拖一段**：画哪一段就提炼哪一段，那是另一套。）

- 「各周期行情」那块显示的就是**真正发给 AI 的原文** —— 每一段都标了天数、根数、起止时间。
  看着不对劲，就是这里不对劲。

---

## 结论长什么样

```json
{
  "tags": [
    {"name": "放量突破", "probability": 62},
    {"name": "上沿受阻", "probability": 40}
  ],
  "reason": "15m 第 5 段从 84,045 拉到 86,622，均量 1,833……",
  "outlook": "先小幅回踩 15m 第 5 段冲高后的密集区不破，再往上试 86,888 那道被反复顶到的上沿",
  "probability": 58,
  "verdict": "wait",
  "recommendation": "现在不追。等 15m 回踩到 84,900-85,300 一带、缩量且不破 84,582 再考虑……"
}
```

- `tags` 是**形状**标签 + 概率（最多 2 个，按概率高低排），不是档位。
- `outlook` 是**预测**，要写**具体价位**：先说看哪个价位、守住还是破了、然后看哪个价位。
  点位必须**带来源**（第几段的高/低点、哪道被反复碰的压力/支撑）——
  允许写点位，但不许凭空抬一个目标价、也不许说成「一定到得了」。
- `probability` 是 `outlook` 那个走法的概率。概率要有依据：
  结构越干净给得越高，两边都说得通给得越低。
- `verdict`：`go` / `wait` / `no_go` —— 现在这个价能不能进。
  **三档怎么判写在提示词里**（「结论三档」那一节）：
  `go` = 现在就能进（最可能那条路占优 + 止损找得到位置）；
  `wait` = 方向清楚但现价离进场位还有一段（提示词里会写明在等什么）；
  `no_go` = 哪个方向都不碰。拿不准 `go` 还是 `wait` 的时候偏 `go`。
  界面上显示为 **可做 / 观望 / 不可做**。

**这份骨架写死在代码里**（`backend/src/llm/prompt.ts` 的 `OUTPUT_CONTRACT`），
但**它只管格式**：字段名、类型、取值范围、必须输出 JSON。
**判定标准一条都不在里面**（怎么读行情、怎么预测、`verdict` 三档怎么分、点位怎么写）
—— 那些全在 `PREDICT_PROMPT` 里。它是程序接口，**不在网页上编辑**。
`npm run selftest` 会断言骨架里的字段名和 `zod` schema 对得上。

---

## 提示词

**写在代码里**，两份常量（`backend/src/llm/prompts.ts`）：

| 常量             | 干什么                                                             | 谁在用               |
| ---------------- | ------------------------------------------------------------------ | -------------------- |
| `PREDICT_PROMPT` | **分析预测**：怎么读行情、怎么预测、怎么给概率、**结论三档怎么判** | 每次分析（`/analyze`） |
| `EXTRACT_PROMPT` | **知识库提炼**：收录案例时怎么把这段行情写成一条案例               | 知识库「收录」       |

- **改提示词 = 改这个文件 + 重新部署**（`bash release.sh`）。网页上没有编辑入口
  （原 `/prompts` 页已撤）。
- 每次分析会把「正文 + 输出契约」一起算 hash 存进 `analyses`，能对出当时用的是哪版。
- 标签池 = **标签模板**（知识库页维护）∪ **知识库里用过的标签**。
  名字要保持一致，不然池子会膨胀；模板外的自造词会在存库前被丢掉。

---

## 花费怎么算

价目表按官方页手工维护（`backend/src/llm/pricing.ts`，单位：美元 / 1M token，**取高峰价**）：

| 时段     | 判定（北京时间）                                             | 单价     |
| -------- | ------------------------------------------------------------ | -------- |
| **高峰** | 周一~周五（**不含法定节假日**）9:00-12:00、14:00-18:00       | 基准价   |
| **空闲** | 其余全部 —— 含**周末全天**、**法定节假日全天**、平日其它时段 | **半价** |

- 判定在 `backend/src/llm/cn-holidays.ts`：节假日表 + 北京时间换算（先把时刻 +8 小时，
  再用 `getUTC*` 读）。⚠️ **节假日表每年国务院发通知后要手工更新一次**，文件头有说明。
- `npm run peak [年|年月]` 会把每一天的判定列出来，对着官方日历扫一眼就能核对。
- 改过表之后跑 **`npm run reprice`** 重算已落库的历史花费（先用不看写库，
  确认差异了再加 `--write`）。它只依赖库里已有的「下单时刻 + 用量 + 模型」，不重新调模型。
- **空闲时段必须按半价算** —— 周末与节假日全天都算空闲，这一项影响的钱不多但不能白交。

## 归档

每次分析落一行 `analyses`：

- `tags`（JSONB，带概率）、`grade_reason`（存的就是理由）、`verdict`、`price`、`snapshot`
- `snapshot` 里存的是当时**发了什么**：`{price, primary, blocks:[{timeframe,primary,days,bars}], heat}`
- 老记录的列（grade / checklist / outcome…）**没删**，只标了 `@deprecated`，历史还能读。

---

## 目录

```
backend/src/
  server.ts              手写 node:http 路由（没用 Express），端口 8787
  cli.ts                 命令行入口
  config.ts              读 .env
  calibers.ts            取数表：哪个主周期带哪些周期、各看多少天
  contracts.ts           合约表
  db/                    PostgreSQL（schema / 文档 / 存档 / 知识库 / 用量）
  data/market.ts         拉 K 线（含「回到某一刻」的重放）
  analysis/describe.ts   把 K 线切成小段读成文字   ← 核心
  context/builder.ts     拼成给 AI 的行情快照
  llm/                   client / prompt（含输出契约）/ schema（zod）/ extract
  output/render.ts       命令行渲染
  scripts/               selftest / history / cost / learn / swing …

frontend/src/
  views/AnalyzeView.vue  开单分析 · MeView.vue 我的 · ContractsView.vue 合约行情
  comps/KlineChart.vue   主图（lightweight-charts）；MiniKline/PieChart/CostTrend 是 echarts
  api.ts / analyze.ts    接口与全局状态 · session.ts 登录态 · candles.ts 预取

config/calibers.yaml     取数表（也能改这里）
data/contracts.json      合约表缓存

docker-compose.yml       PostgreSQL 16（本地开发，只起 db）
docker-compose.prod.yml  生产：app + db + caddy（线上用这份）
Dockerfile               多阶段构建，运行阶段只带生产依赖
Caddyfile                域名与反代（Caddy 跑在 compose 里）
deploy.sh                服务器上一键部署（加 swap / 装 Docker / 起服务 / 自检）
release.sh               本机一键发布（提交检查 → 打包 → 上传 → 触发 deploy.sh → 验收）
build-apk.sh             打 Android APK 并放进 downloads/
docs/DEPLOY.md           部署与运维文档
docs/MOBILE.md           打包成 App（Capacitor）
```

---

## 踩过的坑

- 端口 22、`github.com:443`、`api.binance.com` 在这个网络下不通；
  用 `fapi.binance.com` / `data-api.binance.vision`。
- `ai_docs.kind` 的 CHECK 约束改了要**同步改** `schema.ts` 里的迁移块，否则新 kind 插不进去。
- 页面白屏十有八九是**模板里用了一个已经被删掉的函数** —— 删函数一定要全局搜模板。
- 线上更新代码**必须** `--exclude='.env'`：服务器那份 `.env` 里有随机化过的
  `PGPASSWORD`，被本机那份覆盖后应用就连不上数据库（日志是「⚠️ 数据库不可用」）。
