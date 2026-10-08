# 交易所资产模块 · 方案（2026-10-05 定稿）

> 一句话：**一套 API Key = 一个账户**；库里存「快照 + 成交」，WebSocket 负责实时，
> 前端**先渲染库里那一份**再后台刷新 —— 秒开、秒跳，不空等 loading。

---

## 1. 范围

**统计三个钱包**（用户 2026-10-05 追加了现货）：

| 维度 | 接口 | 拿到什么 |
|---|---|---|
| USDT 合约（USDⓈ-M） | `GET /fapi/v2/account` | `totalWalletBalance` / `totalUnrealizedProfit` / `totalMarginBalance` / `availableBalance` + `assets[]` + **`positions[]`** |
| C2C 钱包 | `GET /sapi/v1/asset/wallet/balance?needBalanceDetail=true` | `walletName` / `balance` / `assetBalances[]` —— ⚠️ 两个坑（2026-10-05 真丢过钱）：**① 钱包名各账号不一样**（官方文档写 `"C2C"`，实测本账号是 `"Funding"`）⇒ 两个都得认；**② `assetBalances[]` 里没有 `balance` 字段**，金额在 `free`/`locked`/`freeze`/`withdrawing` 里（钱包层级那个 `balance` 是 **BTC 估值**） |
| **现货（只 USDT）** | `GET /api/v3/account` | 只挑 `balances[]` 里 `asset === 'USDT'` 那一行的 `free + locked` —— 见下面那条「简单化」 |
| 挂单 | `GET /fapi/v1/openOrders`（**不需要交易对**） | |
| 成交 | WS `ORDER_TRADE_UPDATE`，REST `userTrades` 兜底 | |
| 已实现盈亏 | WS 同事件里的 `rp`，REST `fapi/v1/income` 兜底 | |

> **现货为什么只算 USDT**（用户 2026-10-05：「现货统计也加上，只要 usdt 的统计简单化」）：
> 别的币种要「按币种估值」才进得了净值 —— 那套东西（老版 `/api/exchange/account`）
> 第一版做过，维护成本高、币种对不上时只能静默少算，所以整个删掉了。
> 现在这条线很硬：**现货只看 USDT，其他币种一概不折价、不进净值**，界面上也
> 明写「现货（USDT）」+ 一句「其他币种不计入净资产」，不给人错觉。
> ⚠️ 只读现货余额**不需要**现货交易权限（`enableSpotAndMarginTrading` 可以是 false），
> 只要有「允许读取」就行 —— 实测两把 Key 都是 false 但读得到。

**明确不做**
- ❌ 现货里**除 USDT 之外**的币种估值（见上面那段）
- ❌ 币本位 COIN-M（`dapi*`）
- ⚠️ **下单**：2026-10-05 加了 K 线页底部的下单模块，**默认走币安的测试接口**
  （`POST /fapi/v1/order/test`）—— 只校验参数 / 权限 / 保证金，**不进撮合、不真开仓**。
  在「配置 → 测试下单」里把开关**关掉**就是真下单（`POST /fapi/v1/order`，会真扣保证金），
  由请求体里的 `test: false` 决定，见第 5 节末尾。撤单还没做
- ⚠️ **划转**：2026-10-05 加了「万能划转」（第 5.5 节）—— **真钱、没有测试接口**，
  支持「现货 / 资金(C2C) / USDTⓈ 合约」之间六种组合
- ❌ 跨账户、跨用户汇总（净资产 = **那一套 key** 的合约 + C2C + 现货USDT）

**净资产口径**：`合约 totalMarginBalance（= 钱包 + 浮盈）+ C2C 折 USDT + 现货 USDT`
—— 只有 `db/exchange-store.ts` 的 `netOf()` 一处定义，前端 `ExchangeAccountBoard`
和曲线 SQL 都跟着它，三处口径必须一致。

---

## 2. 分层（为什么这么分）

| 层 | 数据 | 存哪 | 节奏 |
|---|---|---|---|
| **快照** | 合约钱包/保证金/可用/浮盈 + `assets` + `positions` + C2C | **落库** | WS 事件 + 5 分钟写点（0 权重）+ **1 小时 REST 校准** + 手动刷新 |
| **成交（账本）** | 逐笔成交 + 已实现盈亏 | **落库（永久）** | WS 事件驱动 |
| **实时** | 当前余额 / 持仓内存镜像；**挂单已改存库**（`exchange_open_orders`，见 §16） | 内存 + 库 | 收到事件就更新 |
| **兜底** | REST 对账（成交 / 挂单 / income） | 不存 | normal **4 / 6 / 8 小时**，`idle` ×2，`asleep` 全停 —— 见 §24 |

两个「为什么要存」：

1. **快照**：不存就得每次打交易所，慢；存了还能画**资产曲线**。
2. **成交**：⚠️ **币安只保留最近 3 个月**（`userTrades` / `income` 明文写 3 个月，
   `allOrders` 时间窗 ≤ 7 天）。**不存 = 过了 90 天这段账永久消失**，
   以后想算「上月赚了多少 / 做了多少笔 / 手续费花了多少」都拿不回来。

---

## 3. 「快照」到底是什么

**一条快照 = 某一瞬间这个账户的「资产体检报告」**，不是流水、不是增量，就是一整份当前状态：

```
exchange_snapshots 里的一行（举例）
  key_id      4                  哪套 key
  taken_at    2026-10-05 18:42   这一瞬间
  wallet      30228.74           合约钱包余额（totalWalletBalance，不含浮盈）
  unrealized  886.60             未实现盈亏
  margin      31115.34           保证金余额（= 钱包 + 浮盈）← 净资产里的合约那半
  available   9672.43            可用
  positions   [ {BTCUSDT,long,…}, {ETHUSDT,short,…} ]   ← 完整持仓，jsonb
  assets      [ {USDT, wallet, available, unrealized} ]
  c2c_total   2140.00            C2C / Funding 折 USDT
  c2c_detail  [ {USDT,…}, {BTC,…} ]
  source      ws | poll | manual  这条是谁写的
  err         采集时那一侧失败了就记这儿
```

**什么时候写一条**：
- WS 收到 `ACCOUNT_UPDATE`（余额/仓位变了）—— 同一秒多次变化**合并成一条**
- 每 5 分钟写一个净值点（`source='live'`，**0 权重**，用内存那份就地算）← 就算 WS 一直没动静也有心跳
- 每 1 小时一次 **REST 校准**（`source='poll'`）← 只有 REST 有的那几项（C2C / 现货 / 可用余额 / 资产明细）靠它
- 用户点 ⟳（`source='manual'`）

**为什么要它**：
1. 前端「秒开」= 直接读**最新那一条**（毫秒级），不等交易所
2. 攒下来的序列就是**资产曲线**（曲线后做，但数据得从现在开始攒）
3. 排查问题时能回放「3 小时前账上是什么样」

**量和保留：分级保留（降采样），而不是一刀切 30 天**

⚠️ 一刀切“保留 30 天”的话，**30 天前的曲线就没了**；而币安的日快照
（`accountSnapshot`）也只回溯 30 天 ⇒ 补也补不到更早。
要“从注册到结束”都有曲线，就得**按粒度分级留**：

| 粒度 | 保留多久 | 一套 key 的条数 | 用途 |
|---|---|---|---|
| **5 分钟**（原始） | **7 天** | 288 × 7 ≈ 2000 | 看最近几小时/几天的细节 |
| **1 小时**（聚合） | **90 天** | 24 × 90 ≈ 2200 | 看最近一个月 |
| **1 天**（聚合） | **永久** | **365 / 年** | “从注册到结束”的长期曲线 |

⇒ 稳态总量 ≈ **4200 条 ≈ 6.5 MB + 每年 0.5 MB / 套** ——
**比“5 分钟留 30 天”（约 13 MB）还省，同时曲线能永久看**。

归档怎么做：`exchange_snapshots` 加一列 `kind`（`5m | 1h | 1d`），
每天跑一次归档任务：前一天的点聚合成 `1h`；再聚合成 `1d`；
删掉 7 天前的 `5m`、90 天前的 `1h`（**`1d` 永不删**）。
界面上按看的范围自动选粒度（`1 天 → 5m`、`30 天 → 1h`、`1 年 → 1d`）。

### 聚合**不取平均**，留「最高 / 最低」（用户 2026-10-05 定）

- `high` = 桶内所有子行 `high` 的**最大值**（⚠️ **不是 close 的最大值** ——
  这样 5m → 1h → 1d 两级聚合都不会把振幅丢掉）；`high_at` 记最高出现在哪一刻
- `low` = 最小的 `low`；`low_at` 同理
- `margin` / `c2c_total` 取桶内**最后一条**的值 = 这一格的 **close**
- `5m` 原始行：`high = low = 自身净值` ⇒ 查曲线时三种粒度可以用同一套 SQL
- `open` **不存**：它就是上一个桶的 close（断档时那两个点本来就该断开）
- `amplitude`（振幅）**不存**：`(high − low) / low` 现算

⇒ 曲线的画法：**close 画折线 + high/low 画区间带**
（看一年时，一根日柱就是“那天最高到多少、最低到多少”）

**成交永久**（账本不能丢，而且交易所只帮存 3 个月）。

⚠️ 和「成交」的区别：快照是**状态**（可以丢采样点、可以覆盖），
成交是**事件账本**（一行都不能丢，而且交易所只帮存 3 个月）。

### ⚠️ 断档与恢复（后端挂了怎么办）

**先说结论：权益的细粒度历史「补不回来」，所以设计目标是「少断 + 断了看得出来」。**

| 挂什么 | 影响 | 能不能补 |
|---|---|---|
| **进程崩 / 容器重启** | 采样停 + WS 断 | ✅ **自动拉起**：prod compose 里 app 等服务全是 `restart: unless-stopped`（已核实）⇒ 断档 ≈ 秒级；**重启时立刻补一条锚点快照** |
| **WS 断线**（进程还活着） | 成交 / 已实现盈亏事件丢 | ✅ **能补**：重连后 REST 增量拉（`userTrades` / `income`，**3 个月内还在**） |
| **服务长时间停**（部署 / 机器重启 / OOM 反复） | 快照整段空白 | ⚠️ 分钟级**补不回**（币安没有分钟级历史权益接口）<br>⏸ 天粒度**也没接**：`/sapi/v1/accountSnapshot?type=FUTURES` 实测可用（日点，回溯 30 天），但**代码里没实现**（只在探针脚本里调过）⇒ 停几小时就是几小时的空档 |

据此加四条设计：

1. **锚点快照**：绑定 key、进程启动、优雅关闭（SIGTERM）各写一条，
   `source = bind | boot | shutdown` —— 曲线**两端都有锚点**，不会出现"开头/结尾没有点"。
2. **断档要看得见**：曲线**不插值**，两点之间画直线；空档 > 2× 采样间隔就画成**断点/虚线**，
   **绝不假装那段时间有数据**。
3. ⏸ **启动补数据：设计里有、代码里没做** —— 原计划是「最后一条快照早于 N 小时（比如 2 小时）⇒
   用 `/sapi/v1/accountSnapshot?type=FUTURES` 回补天粒度点（`source='snapshotApi'`）」。
   现在启动只写一条 `boot` 锚点（那一刻的真实值），**中间那段空档不补**
   （`snapshotApi` 目前只是类型定义 / schema 注释里的一个名字，真实调用只在
   `backend/src/scripts/probe-ws.ts`）。
4. **写库失败**：内存里兜一批、退避重试（DB 短暂抖动别丢）。

**明确不做 HA**：多副本会重复订阅同一个 key 的 WS（要领导者选举/分布式锁），
代价大于收益 —— 这工具单实例够（见「容量」）。所以真正的长时间停机，
那段细粒度数据**永久缺失**，只能靠上面 1+3 把影响缩到最小。

---

## 4. 表结构（加在 `backend/src/db/schema.ts` 的 `SCHEMA_SQL` 里，幂等）
```sql
-- ── 资产快照（每次采一条；前端读「最新那条」= 秒开）
CREATE TABLE IF NOT EXISTS exchange_snapshots (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id      BIGINT      NOT NULL REFERENCES user_exchange_keys (id) ON DELETE CASCADE,
  -- 粒度：5m = 原始采样；1h / 1d = 归档聚合出来的
  kind        TEXT        NOT NULL DEFAULT '5m',
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 该时间桶内「净资产 = margin + c2c_total」的振幅（5m 行 high = low = 自身净值）
  high        NUMERIC(24,8),
  high_at     TIMESTAMPTZ,
  low         NUMERIC(24,8),
  low_at      TIMESTAMPTZ,
  -- 合约
  wallet      NUMERIC(24,8) NOT NULL DEFAULT 0,   -- totalWalletBalance
  unrealized  NUMERIC(24,8) NOT NULL DEFAULT 0,   -- totalUnrealizedProfit
  margin      NUMERIC(24,8) NOT NULL DEFAULT 0,   -- totalMarginBalance（净资产里的合约那半）
  available   NUMERIC(24,8) NOT NULL DEFAULT 0,   -- availableBalance
  positions   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  assets      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- C2C
  c2c_total   NUMERIC(24,8),
  c2c_detail  JSONB,
  -- 这一条是谁写的 / 有没有失败
  -- poll | ws | manual | bind | boot | shutdown | snapshotApi
  source      TEXT        NOT NULL DEFAULT 'poll',
  err         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exchange_snapshots_key_idx
  ON exchange_snapshots (user_id, key_id, kind, taken_at DESC);
-- 归档去重：同一档位、同一个时间桶只允许一条（重跑归档不会写重复）
CREATE UNIQUE INDEX IF NOT EXISTS exchange_snapshots_bucket_idx
  ON exchange_snapshots (key_id, kind, taken_at);

-- ── 成交账本（永久保留；不存就永久丢，见上面 ⚠️）
CREATE TABLE IF NOT EXISTS exchange_fills (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id     BIGINT      NOT NULL REFERENCES user_exchange_keys (id) ON DELETE CASCADE,
  order_id   TEXT        NOT NULL,
  trade_id   TEXT        NOT NULL,            -- 币安的 `t`，去重靠它
  symbol     TEXT        NOT NULL,
  side       TEXT        NOT NULL,            -- buy / sell
  price      NUMERIC(24,8) NOT NULL DEFAULT 0,
  amount     NUMERIC(24,8) NOT NULL DEFAULT 0,
  cost       NUMERIC(24,8) NOT NULL DEFAULT 0,
  fee        NUMERIC(24,8) NOT NULL DEFAULT 0,
  fee_ccy    TEXT,
  realized   NUMERIC(24,8) NOT NULL DEFAULT 0, -- 这一笔的已实现盈亏（事件里的 rp）
  ts         TIMESTAMPTZ NOT NULL,
  raw        JSONB,                            -- 原始报文，对不上账时能翻
  UNIQUE (key_id, trade_id)
);
CREATE INDEX IF NOT EXISTS exchange_fills_user_idx ON exchange_fills (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS exchange_fills_sym_idx  ON exchange_fills (key_id, symbol, ts DESC);
```

**绑定关系**（照仓库现有规矩，跟 `llm_usage` 一个思路）：

- `user_id` **必带** —— 用户自己的数据一律带它（`analyses` / `knowledge` / `llm_usage` …
  都带），读接口一律 `WHERE user_id = $1`；**哪天 join 漏了也不会串号**，这是兜底。
- `key_id` 也带 —— 数据是**一套 key 一个账户**，界面按套切。
- **删除即删除**（用户 2026-10-05 定）⇒ 两个 FK 都 `ON DELETE CASCADE`，
  删 key / 注销用户，数据一起清。**不留历史、不做 SET NULL**。

**保留期**：分级保留，清理在 [`exchange-archive.ts`](../backend/src/exchange-archive.ts)（每小时一轮）——
5m 留 7 天、1h 留 90 天、1d **永久**；**成交永久**。
⚠️ `db/prune.ts` 只管 `analyses` / `llm_usage`（默认 90 天），**不碰**快照和成交。

---

## 5. 实时层（WebSocket 用户数据流）

> ### ⚠️ M0 已实测（2026-10-05，用仓库里那套币安合约 key 真跑的）—— 结论**推翻了最初设想**

| 验的东西 | 结果 |
|---|---|
| ccxt 的 `watchOrders()` | ❌ **抛 `binance watchOrders() is not supported yet`** —— 社区版的 `watch*` 只是基类占位，真实现要付费的 ccxt.pro ⇒ **不能靠它** |
| `POST /fapi/v1/listenKey`（ccxt 的 `fapiPrivatePostListenKey`） | ✅ 通，拿到 64 位 listenKey |
| **自己连裸 WS** `wss://fstream.binance.com/ws/<listenKey>` | ✅ **429ms 连上，15 秒稳定不断** ⚠️ 但这条路**只有握手**：`/ws/` 一个业务帧都不推，真地址必须带 `/private`（2026-10-06 才查出来，见 §24 坑 1） |
| `/fapi/v2/account` | ✅ 字段全中；⚠️ `positions` 返回**全部 920 个槽位**（绝大多数 `positionAmt=0`）⇒ 必须过滤 |
| `/sapi/v1/asset/wallet/balance` | ✅ 通；⚠️ **钱包名各账号不一样**：文档写 `"C2C"`、实测本账号是 `"Funding"` ⇒ 必须两个都认；⚠️ **`assetBalances[]` 里没有 `balance`**（钱在 `free`/`locked`/`freeze`/`withdrawing`）—— 读错字段会**静默算成 0** |

⇒ **实时层自己写**：listenKey 搭 ccxt 的隐式方法（`fapiPrivatePostListenKey` / `PutListenKey` /
`DeleteListenKey` ✓ 已验证），WS 用 `ws` 包直连 **`wss://fstream.binance.com/private/ws/<listenKey>`**
（⚠️ `/private` 不能少，见 `streamUrl()`）。
**自己管三件事**：25 分钟续期（`PUT`，币安 30 分钟过期）、指数退避重连、重连后 REST 对账。
⚠️ `ws` 现在只是 ccxt 带进来的**传递依赖**，要显式写进 `package.json`。

### 事件 → 动作

| 事件 | 动作 |
|---|---|
| `ORDER_TRADE_UPDATE`（`x=NEW`） | 挂单表 +1（内存） |
| `ORDER_TRADE_UPDATE`（`x=TRADE`/`X=FILLED`） | **upsert `exchange_fills`**（用 `t` 去重）+ 命中挂单表扣量 |
| `ORDER_TRADE_UPDATE`（`x=CANCELED/EXPIRED`） | 挂单表 −1 |
| `ACCOUNT_UPDATE` | 更新内存快照 → 写一条 `exchange_snapshots(source='ws')`（同一秒多次合并成一条） |

### ⚠️ 2026-10-06 实测：**空闲期「零数据帧」是正常的**（别把它当故障）

币安的用户数据流**只在有事件时才推数据帧**，账户半天不动就是一个数据帧都没有。
它真正的心跳是**协议级 ping**（币安每 **3 分钟**发一个 ping 帧，10 分钟收不到 pong
才断连），而 ping 是**控制帧** —— `ws` 的 `message` 回调**看不到它**。

⇒ 我一度把「没有数据帧」误判成「连上了却一帧不推 = 假 IP」，**那是错的**：
加 `ws.on('ping')` 之后日志立刻出现 `WS 收到第 1 个 ping（连接是活的）`。
判断这条流死活**只能**看「数据帧 **或** ping 有没有来」，阈值还必须大于 3 分钟。

⇒ 但「流是活的」**不等于**「事件不会丢」（重连空档 / listenKey 失效 / 进程重启 /
上游偶发丢帧都真实存在，11:02 那笔漏单至今没有直接证据说明是哪种），所以：

- 别把「成交记得对不对」押在这条流上 ⇒ 见 §13 的 **REST 定期对账**；
- 「我们这条 SSE 还活着」**不等于**上游在推数据 ⇒ 见 §13 的 `health` 事件；
- 每一条 `ORDER_TRADE_UPDATE` 都打一行（`x`/`X`/`t`/`l`），下次漏单一查就知道是
  「没收到」还是「收到了但被跳过」。

### 三条硬规矩

1. **WS 不能替代 REST**：断线期间事件会丢，而这是**钱**。
   ⇒ REST 定期对账兜底（成交 / 挂单 / income 的节奏见 §24），**不一致以 REST 为准**；
   另有四个**确定**的补账入口：重连后、写操作后（强制对平）、页面打开（数据旧了）、用户手动刷新。
2. ⚠️ **C2C 钱包没有 WS 事件**（用户数据流只覆盖合约）⇒ C2C 只能 REST 轮询
   （5 分钟）。**净资产里那 6% 最多旧 5 分钟**。
3. **单实例假设**：现在 docker 里就一个 app 容器 ✓；将来多副本会重复订阅
   （要么分布式锁，要么把这条流固定挂主副本）。重连一律**指数退避**。

---

## 5. 后端接口

| 方法 | 路径 | 读哪 | 说明 |
|---|---|---|---|
| GET | `/api/exchange/overview?id=` | 库（最新快照） | **秒开**，返回 `takenAt` / `age` / `stale` |
| POST | `/api/exchange/refresh?id=` | REST | 立刻拉一次 + 落库（手动 ⟳ 用） |
| GET | `/api/exchange/history?id=&range=1d\|7d\|30d` | 库 | 快照序列（画资产曲线；桶宽随跨度自动变 5m/30m/2h） |
| GET | `/api/exchange/orders?id=` | 内存（15s）| 当前挂单 |
| GET | `/api/exchange/fills?id=&symbol=&limit=` | 库 | 成交明细（**不再需要交易对**） |
| GET | `/api/exchange/pnl?id=&by=day\|symbol` | 库 | 盈亏汇总（`GROUP BY`） |
| GET | `/api/exchange/stream?id=` | **SSE** | 推快照/成交变化（照抄 `/api/tickers/stream`） |
| — | ~~`/api/exchange/account`~~ | — | ✅ M5 已下线（连同它那套 `fetchExchangeBalance` / `fetchExchangeOrders` / `fetchRealizedPnl`） |

### 合约下单（M6，2026-10-05）

K 线页底部那个下单模块用的几条（`data/exchange-trade.ts`）：

| 方法 | 路径 | 打哪个交易所接口 | 说明 |
|---|---|---|---|
| GET | `/api/exchange/trade?id=&symbol=BTCUSDT` | `fapi/v2/balance` + **v2** `positionRisk` + `leverageBracket` | 面板初始化：可用余额 / 当前杠杆 / 最大杠杆 / **当前持仓** / 数量价格精度（三项并发，单项失败只记进 `errors`，余额失败单列 `balanceError`）。⚠️ 杠杆和持仓出自**同一次** `positionRisk`，别打两遍 |
| GET | `/api/exchange/trade/positions?id=` | **v2** `positionRisk`（**不带 symbol**） | 账户里**所有**持仓（面板「仓位」那一格列出来的列表，按名义价值倒序）。⚠️ 双向持仓模式下同一个币有两条（LONG / SHORT），按 `positionSide` 区分 |
| POST | `/api/exchange/trade/leverage?id=` | `POST /fapi/v1/leverage` | 调这个交易对的杠杆（有持仓 / 挂单时交易所会拒，原样翻出来） |
| POST | `/api/exchange/trade/order?id=` | `POST /fapi/v1/order/test` **或** `/fapi/v1/order` | 下单。⚠️ 走哪个由请求体里的 **`test`** 决定：`test !== false`（**默认**，含漏传）→ 测试单（只校验，不进撮合、不真开仓）；`test === false` → **真单** |
| POST | `/api/exchange/trade/close?id=` | 同上（`order/test` / `order`） | 平仓，同样看 `test`。`{symbol, side}` 只平那一条（列表里每一行的「平仓」）；只给 `symbol` 平这个交易对；**都不给就是「一键平仓」**（有持仓的全平一遍） |
| POST | `/api/exchange/trade/cancel-order?id=` | `DELETE /fapi/v1/order` / `DELETE /fapi/v1/algoOrder` | 撤一张挂单（⚠️ **没有测试版**，撤了就是真撤）。`{symbol, orderId}` —— 普通单和条件单是两套接口，`cancelAnyOrder()` 先按普通单撤、失败再按条件单撤 |
| POST | `/api/exchange/trade/modify-order?id=` | `PUT /fapi/v1/order` / `POST /fapi/v1/algoOrder` | **改一张挂单**（2026-10-06，用户：「挂单可以修改」）。`{symbol, orderId, price, quantity?}` —— ★ 按类型分流：**限价单**走交易所的改单接口（单号不变）；**止盈 / 止损（条件单）**走**撤旧 + 挂新**（币安把条件单搬进 Algo Order 之后**没有改单接口**，它自己 App 里的「修改」也是撤+挂）⇒ 复用 `placeStopOrder(orderId)`，触发价 / 类型的校正跟 K 线上拖出来那张单是同一段代码。⚠️ 类型 / 方向 / 原数量**以交易所上那张单为准**（现查一次挂单，1 权重），不认前端传的。⚠️ **没有测试版** |
| GET | `/api/rate` | — | 美元 → 人民币汇率（`USD_CNY`，默认 7.1）——「交易所账户」USDT / CNY 快捷切换用，跟用量页同源 |
| POST | `/api/exchange/transfer?id=` | **`POST /sapi/v1/asset/transfer`** | **万能划转（真钱，没有测试接口）**。`{from, to, amount, asset?}`，`from`/`to` ∈ `spot`/`funding`/`futures`，见第 5.5 节 |
| GET | `/api/exchange/wallet?id=&wallet=` | `api/v3/account` / `sapi` / `fapi` | 某个钱包 USDT **能划走多少**（划转弹层的「全部」+ 余额提示；实时读，不读快照） |
| GET | `/api/exchange/permissions?id=` | `GET /sapi/v1/account/apiRestrictions` | 这套 Key 开没开「允许通用划转」（`permitsUniversalTransfer`）|

⚠️ 平仓那两个参数有讲究：**单向持仓模式**带 `reduceOnly`，**双向持仓模式绝对不能带**
（币安直接回 `-1106 Parameter 'reduceonly' sent when not required`）—— 双向模式本来就靠
「反方向 + 同一个 `positionSide`」自动减仓。数量按真实持仓量 × 合约步长向下取整。

⚠️ 五个实测踩到的坑（都是真 Key 打出来的）：

1. **`/fapi/v1/positionRisk` 已经下线** —— 直接 404，而且回的是币安那张 HTML 错误页
   （不翻中文的话界面上就是一坨 HTML）。要用 **v2**。
2. **v3 的 positionRisk 在「这个交易对没持仓」时回空数组**（`[]`）⇒ 拿不到杠杆；
   而 **v2 照常回那一条**（`leverage: "20"`, `positionSide: "BOTH"`）。所以优先 v2、v3 只兜底。
3. **`-2015` 别当「Key 不对」** —— 它是 `Invalid API-key, IP, or permissions for action, request ip: x.x.x.x`，
   实测绝大多数是 **IP 白名单**没放行。`humanize()` 里这条必须**最先**判，
   不然会被前面那条 `invalid api-key` 抢走，提示成「API Key / Secret 不对」，怎么查都查不出来。
4. **`-4192 Trade forbidden due to Cooling-off Period` 也不是白名单 / 权限问题** ——
   实测（2026-10-05，线上真账户）：读余额、读杠杆都正常，**一下单**就被这条拦，
   MARKET / LIMIT 都一样。**它排在参数校验之后**：参数本身不合法的测试单会先回
   `-1111` / `-1102`，参数全对才轮得到 `-4192`。所以 `humanizeTrade()` 里专门有一条
   `-4192` → 直说「币安在冷静期，过一阵再试」（原来会落到 `/permission|forbidden/`
   那条上，翻成「没有权限」，把人往白名单 / 权限上引）。
   官方错误表**只给了这句话、没给原因和时长**；最可能是账户级的**「冷静期」自锁**
   （币安 App：合约页 →「…」→ 冷静期 →「禁止合约交易」，官方 FAQ
   `binance.com/support/faq/detail/ad7fd07f63a64954a6d6e9257d16adcc`）——
   时长是开启时自己选的（**1 天 / 1 周 / 1 月 / 永久**），而且**开了就不能提前解除**
   （客服也解不了）。**最快的确证办法**：同一个账户在手机 App 里手动开一笔合约单，
   手动也下不了就是这个自锁（它本来就同时锁 App 和 API）；手动能下、只有 API 不行，
   那就是别的原因，得再查。换一把新 Key 没用（账户级限制）。
5. **交割中 / 已下架的币会「赖」在币种表里最多一天** ——
   币种表（`data/contracts.json` + 库里 `contract_store`）是**每天**同步一次
   （`CONTRACTS_MAX_AGE_MS` = 24h）。实测 2026-10-05：`1000000BOBUSDT`、`PROMPTUSDT`、
   `PUMPBTCUSDT` 在币安那边状态已经变成 `SETTLING`（正在交割 / 已下架），
   但当天同步过的表里还留着它们（528 → 刷新后 525）。
   下载单面板读的是**实时** `exchangeInfo`（缓存 6h），所以下这种币会被拦住 ——
   `specFor()` 会分清两种说法：「已经不能交易了（正在交割 / 已下架）」和
   「币安的列表里没有这个交易对」。
   想马上刷一次：`npm run sync:contracts`（服务每天自己也会刷）。

**数量 / 精度**：不走 ccxt 的 `loadMarkets()`（它会顺手调一个**私有**的 `fetchCurrencies`，
对只有合约权限的 Key 是多余的请求、还慢一倍），而是直接读公开的 `GET /fapi/v1/exchangeInfo`，
把 `LOT_SIZE.stepSize` / `PRICE_FILTER.tickSize` / `MIN_NOTIONAL.notional` 缓存 6 小时。
数量 `= 可用余额 × 仓位% × 杠杆 ÷ 参考价`，按 `stepSize` **向下**取整，再校验 minQty / minNotional。

**测试单 / 真单**（2026-10-05 追加）：由请求体里的 `test` 决定，
`placeOrder()` / `closePositions()` 里只差最后那一行接口名（`submitOrder()`）：

| `test` | 币安接口 | 效果 |
| --- | --- | --- |
| 不传 / `true` | `POST /fapi/v1/order/test` | 只校验参数 / 权限 / 保证金，**不进撮合** |
| `false` | `POST /fapi/v1/order` | **真下单 / 真平仓**，会真扣保证金 |

⚠️ 判断式写的是 **`test !== false`**（不是 `test === true`）：漏传、传错、传 `null`
全都落在测试单那一侧 —— 宁可误当测试单，也不能误真下单。前端开关在
「配置 → **测试下单**」（`settings.ts` 的 `testOrder`，默认**开**，落 localStorage），
关掉时真单模式会在下单模块顶栏挂一枚红色「真单」章。

### 5.5 万能划转（2026-10-05）

「交易所账户」页净资产那一行的**「划转」**按钮 → 弹层选账户 / 方向 / 金额 → 二次确认。

⚠️⚠️ **这是全站唯一一处"真钱、且没有测试接口"的操作**：下单有 `/fapi/v1/order/test`
（只校验不成交），划转**没有**对应物 —— 调一次钱就真的换钱包了。所以：

- 弹层顶部一条**常驻**红色警示（不是 3.5 秒就消失的 toast）
- 提交前 `window.confirm` 复述「哪套账户 / 从哪到哪 / 多少」
- 没勾「允许通用划转」的 Key **直接禁用提交**，并写清去哪开
- 金额里的「全部」走 `/api/exchange/wallet` 实时读**能划走的那部分**
  （现货/资金是 `free`，挂在单子上的锁定额划不动）—— 照着快照里的"总额"填会被 `-4046` 拒

#### 用哪条接口

**零售版**全能划转 `POST /sapi/v1/asset/transfer`（ccxt `sapiPostAssetTransfer`）。

> ❌ **不要用 `/sapi/v1/broker/universalTransfer`** —— 那是「Broker 万能划转」，
> 要券商/经纪商身份 + `X-SAPI-USED-UC-UID` 之类请求头，**普通个人账号打过去直接被拒**。
> 用户最初给的就是这条 broker 路径，据此纠正。

#### 支持的方向（**在真实账号上逐个验过枚举**）

验法：拿 `GET /sapi/v1/asset/transfer?type=…`（**只读**的查询历史）去试每个候选
`type`，合法的回历史（可能空）、非法的回 `-1102 Mandatory parameter 'type' …`。
结果（2026-10-05）：

| `type` | 方向 | 实测 |
|---|---|---|
| `MAIN_UMFUTURE` | 现货 → USDTⓈ 合约 | ✅ |
| `UMFUTURE_MAIN` | USDTⓈ 合约 → 现货 | ✅ |
| `MAIN_FUNDING` | 现货 → 资金(C2C) | ✅ |
| `FUNDING_MAIN` | 资金(C2C) → 现货 | ✅ |
| `UMFUTURE_FUNDING` | USDTⓈ 合约 → 资金(C2C) | ✅ |
| `FUNDING_UMFUTURE` | 资金(C2C) → USDTⓈ 合约 | ✅ |
| `MAIN_CMFUTURE` / `CMFUTURE_MAIN` / `CMFUTURE_FUNDING` / `FUNDING_CMFUTURE` | 币本位那几对 | ✅ 合法，但本仓库不碰 COIN-M，**不放出来** |
| `MAIN_MARGIN` / `MARGIN_MAIN` | 现货 ↔ 全仓杠杆 | ✅ 合法，同上不放出来 |
| **`MAIN_C2C` / `C2C_MAIN`** | **真的 C2C 账户** | ❌ `-1102`，**不存在** |

所以后端只放行上面六种（`data/exchange-transfer.ts` 的 `TYPE_OF`），其余一律拒并给出中文原因。
⚠️ **合约之间互转**（`UMFUTURE_CMFUTURE` 之类）压根没有对应 `type`，也不支持。

> ⚠️ 别把「C2C 钱包」和「C2C 账户」搞混：本项目界面上那块 **「C2C 钱包」其实是
> Funding（资金）钱包**（见 `exchange-overview.ts` 文件头 ①），**它是能划的**；
> 币安真正的 C2C（P2P）账户才是划不了的那个。

#### 权限

`GET /sapi/v1/account/apiRestrictions` 里的 **`permitsUniversalTransfer`**
= 币安「API 管理 → 编辑权限 → **允许通用划转**」。没开就报通用的 `-2015`（看不出真原因），
所以弹层一打开就先问一次这把 Key 的权限，没开就把话直接摆出来。

⚠️ 同一把 Key 上实测：`测试` 开了（`permitsUniversalTransfer: true`）、
`币安` 没开（false）—— 所以「划不动」大概率是没勾这个开关，不是 IP 白名单。

#### 不在万能划转里的钱包

`/sapi/v1/asset/wallet/balance` 会带回 10 个钱包（Spot / Funding / Cross Margin /
Isolated Margin / USDⓈ-M Futures / COIN-M Futures / Earn / Options / Trading Bots /
Copy Trading）。**只有现货、资金、USDTⓈ合约这三个**在万能划转里，其余（Earn / 期权 /
杠杆 / 跟单）都不通 —— 界面上也就只摆这三个。

### 本地开发：IP 白名单怎么办（2026-10-05）

**症状**：币安那把 Key 勾了「限制访问 IP」之后，本机就连不上了 ——
报错是 `-2015 ... request ip: x.x.x.x`（`humanize()` 会把**当前出口 IP 原样打出来**，
界面提示条里就有，直接照抄去白名单里改）。日志里那条
`[exch:N] 起流失败：binance {"code":-2015,...}`（listenKey 用户数据流）也是同一个原因。

**两个事实（第一个我一开始写错了，2026-10-05 订正）**：

1. **白名单不是只能填一个 IP** —— 币安那个框下面写着「输入多个 IP 地址时，请使用空格隔开」，
   服务器 IP 和本机 IP **可以并存**（`52.194.6.144 1.2.3.4`）。
2. **真正烦的是本机出口 IP 会变**：家宽是动态 IP（路由重拨 / 换 Wi-Fi / 换运营商出口就变，
   实测 `157.254.20.163` 之后又换过）⇒ 填进去过一阵就失效。
3. ⚠️ **别想着「建一把不填白名单、带合约交易权限的 Key」** —— 币安那页的红字写着：
   *如果此 IP 不受限制，且启用了除读取以外的任何权限，则该 API 密钥将被删除*。
   有交易权限的无限制 Key 会被删掉，这条路不通。

三条能走的路，按推荐顺序：

**① 本地用「模拟盘」（demo trading）Key —— 推荐（本地整条链路都能跑）**

* 去 <https://demo.binance.com>（币安官方模拟盘）开一套 API Key：**假钱、不用白名单**。
* 在「我的 → 个人信息 → 交易所」里把它加进来，勾上 **「沙盒 / 测试网」**。
* 后端会自动切环境：ccxt 走 `enableDemoTrading(true)`（`urls.api` 整体换成
  `https://demo-fapi.binance.com`），`exchange-trade.ts` 里读合约规格的
  `exchangeInfo` 也跟着切（`fapiBase()`）。
* ⚠️ **规格必须跟着环境走**：实测同一时间 BTCUSDT 的 `stepSize`
  demo `0.0001` / 线上 `0.001`（合约数量 741 vs 920 个）—— 拿线上规格去算 demo 单，
  数量会被 `-1111`（精度不对）顶回来。所以缓存 key 里带着环境。
* ⚠️ 老写法 `setSandboxMode(true)` **对合约已经不能用了**（ccxt 抛
  `testnet/sandbox mode is not supported for futures anymore`，它把旧的
  `testnet.binancefuture.com` 摘了）—— 别再往回改。

**② 本地只跑前端，接口走线上后端 —— 零 Key、零白名单**

```bash
npm run ui:dev:cloud        # = API_TARGET=https://bitcoooin.cn npm run ui:dev
# 打开 http://localhost:5173（Vite 独立前端，本地不用起后端）
```

`frontend/vite.config.ts` 里那条 `/api` 代理把请求转发到线上，
所以**交易所调用是服务器发出去的**（服务器 IP 已经在白名单里）——
本地一个 Key 都不用配，也不涉及 CORS（浏览器看是同源）。

实测：`/api/contracts` 200（真数据）、`/api/exchange/trade` 不带 token 回**线上**的
`{"error":"请先登录"}`、带 token 时 `/api/exchange/overview` 200（服务器读真账户 OK）。

> ⚠️ **线上跑的是哪个版本决定你能调到什么**：本机实测
> `GET /api/exchange/trade` 在线上是 **404**（M6 那三条还没部署，见「部署」那节），
> 所以「本地前端 + 线上后端」现在只能调**已经上线**的接口；
> 要连带下单模块一起调，得先 `npm run deploy`，或者退回方案 ① 在本地跑。

**③ 把本机 IP 也填进白名单（空格分隔）—— 想真连本机就这个**

适合「本机出口 IP 相对稳定」的情况（比如公司固定出口）。IP 变了就再改一次：
把新 IP 追加进去、把旧的删掉。要一劳永逸就固定出口（静态 IP 的家宽 / 固定节点）。

> ⚠️ **`/fapi/v1/order/test` 不绕白名单** —— 它只是「不进撮合」，签名 / 权限 /
> IP 校验一样要过，2026-10-05 用真 Key 实测回的是同一句
> `-2015 Invalid API-key, IP, or permissions for action, request ip: 157.254.20.163`。
> 所以「反正只打测试单」并不能免掉白名单（读余额那步也过不去）。

**④ 本地请求从服务器出去（走隧道代理）—— 2026-10-05 起推荐用这个**

`③` 的痛点（本机出口 IP 会变）不用忍：让**服务器**替本机出网，白名单里只留
`52.194.6.144` 一个就永远不用改；而且**只拐你那个 dev 进程**，不拐整机。

```
dev server --HTTP CONNECT--> 127.0.0.1:8888 --(ssh -L)--> 服务器 127.0.0.1:8888 --> fapi.binance.com
                                                          （tinyproxy，只监听回环）
```

服务器上装的是一份 `tinyproxy`（Ubuntu 官方源里的小包，**只 `Listen 127.0.0.1`**
⇒ 公网扫不到、不用开 Lightsail 规则、也不需要 BasicAuth，够得着的只有能 SSH 进来的人）：

```bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y tinyproxy
# 配置：Port 8888 / Listen 127.0.0.1 / Allow 127.0.0.1 / ConnectPort 443,80
sudo systemctl enable --now tinyproxy
```

本机两条命令（脚本都封好了）：

```bash
bash scripts/dev-proxy.sh --check     # 体检：出口 IP 是不是 52.194.6.144、币安通不通
bash scripts/dev-proxy.sh             # 开隧道（前台挂着，Ctrl+C 就关）
# 另开一个终端：
export EXCHANGE_PROXY=http://127.0.0.1:8888
export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8888
npm run web
```

**两个环境变量各管一半**（2026-10-06 补测：缺一个就有一半接口超时）：

| 谁 | 靠什么变量 | 管哪些 |
|---|---|---|
| ccxt 实例 | `EXCHANGE_PROXY` | 余额 / 持仓 / 下单 / 划转 / listenKey，**以及行情那条**（`market.ts` 的 `getExchange()`：exchangeInfo / K 线 / ticker 都是 ccxt 打的） |
| 裸 `fetch` | `NODE_USE_ENV_PROXY` + `HTTPS_PROXY` | CoinGecko 市值排名这种 |
| 裸 `WebSocket` | `EXCHANGE_PROXY`（同一个） | K 线实时（`data/kline-stream.ts`）、用户数据流（`exchange-stream.ts`）—— 见下面两段 |

> ⚠️ **WebSocket 得单独接一次**（2026-10-06 查清，「连上了但一条数据都不推」的真因）：
> `ws` 既不认 `HTTP_PROXY` / `HTTPS_PROXY`，也不认 `NODE_USE_ENV_PROXY`，必须自己
> `new WebSocket(url, {agent})`。不塞 agent 时**不会报 DNS 错** —— 墙把
> `fstream.binance.com` 解析成**假 IP**（实测拿到 `31.13.94.7`（Facebook）/
> `108.160.167.165`，每次不一样），TCP 偶尔还能连上、`open` 也触发，但**零帧**。
> 看着像「币安不推数据」，其实是压根没连到币安。
> ⇒ `data/exchange-account.ts` 里加了 `wsAgent()`：读同一个 `EXCHANGE_PROXY`，
>   用 `https-proxy-agent` 建 CONNECT 隧道。塞上之后 0.7 秒就出货。
> 实测（本地带代理跑 `npm run web`）：`[kline] 上游 WS 已连`、`[exch:7]/[exch:9] WS 已连（用户数据流）`、
> K 线 SSE 12 秒 31 条事件、**0 次**「退回 REST 轮询」、`交易所 实例已预热`、
> `常点币已预热 122/122`、`行情条 已预热 61/61`（这几条在没代理时全是超时/失败）。
>
> `https-proxy-agent` 装在 **devDependencies**（生产不需要代理）：生产镜像
> `npm ci --omit=dev` 里没有它，`wsAgent()` 用**动态 import** 并吞掉失败 ⇒ 直连；
> 而且生产不设 `EXCHANGE_PROXY`，压根走不到那段。
>
> 顺带修了个隐患：`kline-stream.ts` 原来 `new WebSocket(...)` **没 import**，
> 用的是 Node 24 的**全局** WebSocket（undici），而 `exchange-stream.ts` 用的是 `ws`
> 包 —— 两处不一致，且全局那个**不支持代理**。现在两处统一走 `ws`。
>
> 还有一个顺带修的坑：`loadSpecs()`（`data/exchange-trade.ts`，下单面板要的合约规格）
> 走的是**裸 fetch** 那条路。本地实测碰到过「拿回一个**没有 `symbols` 的 200**」，
> 结果空列表被缓存 6 小时，之后**每个币**都报「币安的合约列表里没有「BTC」这个交易对」
> —— 一句话把人指到币安身上（真因在本地网络/代理）。现在空列表直接抛错（含响应开头）
> 且**不进缓存**，下一次请求会重试。

> ❌ **别用 `@codelook/proxy-server` 这类来路不明的 npm 包**（用户 2026-10-05 问过）：
> 只有 0.1.0 一个版本、没有仓库、没有 homepage、维护者陌生，还夹带一份 `.env`。
> 源码读了确实没恶意，但能力等价于 tinyproxy，而在**装着 Postgres 和交易所 Key 的机器**
> 上跑一个没人维护的第三方包，风险/收益完全不对等。

> ⚠️⚠️ **为什么是 `EXCHANGE_PROXY` 而不是 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY`**
> （这条 2026-10-05 订正过一次，之前那版是错的）：
> ccxt 4.5 走原生 fetch（Node 下就是 undici），但它在加载完 undici 之后会
> **自己 new 一个直连的 keep-alive dispatcher**（`Exchange.fetchDispatcher`），
> 然后**显式挂到每个请求的 `dispatcher` 上**（`setFetchProxyOptions`）——
> 显式 dispatcher 压过全局 dispatcher，于是 `HTTPS_PROXY` 被**整条绕过**。
> 实测：同一条代理，裸 `fetch` 200，ccxt 10s connect timeout。
> ⇒ 代理只能交给 ccxt 自己（`httpProxy`），见 `data/exchange-account.ts` 的 `exchangeProxy()`。
>
> 而 `NODE_USE_ENV_PROXY=1` **对裸 fetch 那条路仍然有效**（`npm run sync:contracts`
> 这种一次性脚本就是这么刷币种表的），只是**管不到 ccxt**。
> 另外 ccxt **不允许同时给 `httpProxy` 和 `httpsProxy`**（回
> `multiple conflicting proxy settings`），只给 `httpProxy` 就行 —— 它内部按
> httpProxy → httpsProxy 顺序挑一个，挑中的那个对**所有**请求都生效。

> 域名可用环境变量换：`FAPI_BASE`（线上，默认 `https://fapi.binance.com`）、
> `FAPI_DEMO_BASE`（模拟盘，默认 `https://demo-fapi.binance.com`）；
> 前端也可以直接 `VITE_API_BASE=https://bitcoooin.cn npm run web`（走线上 CORS，
> 已放行 `http://localhost:*`），不过那样本地后端还在跑、还会拿本地 Key 去开
> listenKey，日志会一直刷 `-2015`，所以更推荐上面的 `ui:dev:cloud`。

### 📌 本机连币安必须走代理（K 线行情 / 刷币种表 / 下单都一样）

本机的币安出网一律走本地代理（默认就是「④」那条**到服务器的 SSH 隧道**，
出口 IP 即服务器的 `52.194.6.144`：本地直连会被墙，DNS 会被污染成假 IP，
表现为「TCP 连得上、但一条消息都不推」）。

⚠️ 这跟 SSH 无关：`ssh ubuntu@52.194.6.144` **直连可用**（2026-10-06 实测，
本机不再有劫持出站 TCP 的情况）。

**不用二选一**（2026-10-05 订正过：下面这条**只对裸 fetch 有效**，管不到 ccxt）：

```bash
# 币安全部走本地代理（7890 是 Clash 那种混合口），TUN 就可以一直关着
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npm run web
```

Node 24 的 `fetch` 认 `NODE_USE_ENV_PROXY`（`undici` 的 ProxyAgent 那条路），
实测用它在本机**成功刷了币种表**（528 → 525，剔掉 3 个交割中的币）。
`npm run sync:contracts` 这种一次性命令同样能这么套。

> ⚠️ 但**下单 / 余额 / 快照这些走 ccxt 的调用不吃这一套** —— ccxt 会自己塞一个直连
> dispatcher 把环境变量代理绕过去（`docs` 上面「④」那节有详解）。
> 要连 ccxt（含行情）和 WebSocket 一起走代理，用上面「④」那两条变量：
> `EXCHANGE_PROXY=... NODE_USE_ENV_PROXY=1 HTTPS_PROXY=... npm run web`。

> 另一个坑：新服务器（`52.194.6.144`）的**主机密钥不在 `known_hosts`** 里时，
> `release.sh` 会直接挂在半路（`Host key verification failed` —— `BatchMode` 下不会问你要不要信任）。
> 先 `ssh-keyscan -T 8 -t ed25519,rsa 52.194.6.144 >> ~/.ssh/known_hosts` 再发。

---

## 6. 前端

**界面已定稿**（`comps/ExchangeAccountBoard.vue`）：账户 tab 条 → 净资产 → 合约明细四格
→ 仓位统计 → 二级 tab（持仓 / 挂单 / 仓位历史 / 成交 / 资产）。

> 2026-10-06 定稿的那几条（都在 `ExchangeAccountBoard.vue` 的注释里）：
> · 窄屏整页定在 **1.2 屏**（`.live { height: 120vh }`），头几块按内容高、
>   `.tabs-body` 吃掉剩下的高度并**内部滚**（数据再多也不让页面无限长）；
>   宽屏那一格仍是 460px 定高内滚。两边的滚动链都放开了
>   （`overscroll-behavior: auto` 而不是 `contain`）—— 滚到边界接着滚外层。
> · 这一页**不画滚动条**（外层 `.tabpane-body` 与内层 `.tabs-body` 都 `scrollbar-width: none`）。
> · 二级 tab 的列表**默认先铺 20 条**，窄屏滚到底再铺 20（宽屏照旧全部铺出来）；
>   铺的是已经取回来的那份（成交 60 / 仓位历史 50 是 `LivePanel` 那边的取数上限）。
> · 首次挂载**不画全局 loading**（原来一颗 `.spin` + 「正在取账户快照…」实测只存在
>   166→228ms，闪一下比留白更扎眼）。读库本来就是毫秒级，真读不到会落到 `reason`
>   那条终态文案上。⚠️ 别把它加回来；「挂单」自己那颗 `loadingOrders` 是另一回事，留着。
>
> · ★ 2026-10-07 **账户 tab 条右边多了一颗「配置」**（用户：「在账户切换的最右侧添加配置，
>   点击底部弹窗」）：外面包了一层 `.acct-bar`（tab 条 `flex: 1 1 auto` + 自己横向滚，
>   配置钉在右边不跟着滚）；弹的就是 K 线页那个**同一个** `SettingsSheet`
>   （所以两边五条内容一模一样：行情过滤 / 下单账户 / 测试下单 / 订单设置 / **持仓明细**）。
>   ⚠️ 别在这儿另起一个「本页专用」的配置弹层 —— 两份配置迟早会打架。
>   ⚠️ 只有一套 Key 时没有 tab 条，但**这一行和配置按钮照旧在**（不然这一页就没入口了）。
>   · 这颗按钮是**图标**（用户：「配置改为图标」）：跟 K 线页那颗**同一个**滑轨图标
>     （内联 SVG，17px；别写 `⚙` 之类字符 —— 安卓 WebView 的兜底字体不保证有字形，
>     这一页的刷新图标栽过一次）。36×32，跟 tab 条那颗胶囊等高。
> · ★ 2026-10-07「配置」这一层的版式重做（用户一次说完的）：
>   「内容优化所有都去掉描述，开关有点饱满了上下瘦一点 行情过滤 一行显示 下单一行显示
>   测试也是 订单 选项样式修改 一个边框包住，被选择的右上角有勾 持仓一行显示」
>   ＋ 随后两条：「不要加下滑线」/「分割线不要加」。
>   ⇒ 每条只剩**一行**「标签 + 控件」（标题在左、控件贴右；窄屏控件自己换行，标签不换）；
>     **所有说明文字删掉**（连底部那句「改动即时生效，保存在本机」也没了）——
>     要解释就写进 `title`，悬停才看得见；**条与条之间不画线**（那条 `border-top` 撤了，
>     靠 11px 上下留白分）；开关本身瘦了一圈（`style.css` 的 `.switch`：46×26 → **40×22**，
>     旋钮 16）；**这一层里的按钮圆角都收到 `--r-xs`(8px)**（胶囊本来是 999px 的正圆头，
>     `ghost` 是 10px ⇒ 现在统一 8px）。
> · ★ 「订单设置」那四样，用户当天连改了三次，**现在这版是终点**：
>   ① 「选项样式修改 一个边框包住，被选择的右上角有勾」→ 做过一版 2×2 的大框；
>   ② 「不要加下滑线」＋「分割线不要加」→ 框里那几条格子线撤掉；
>   ③ 「订单四个按钮分开一行显示」⇒ **取消共用的大框**，改成**四个各自带边框的小按钮、
>      排成一行**，选中的右上角仍然一颗勾（内联 SVG，`top: 0/right: 2px`）。
>   ⚠️ 一行四颗 + 左边那列标签在 390px 上是 **290 / 296px**（只剩 6px 余量）——
>      再给名字加字、加字号、加内边距都会折成两行，改之前先量。
>   ⚠️ 色点也留着（缩小到 7px）：它跟 K 线上那条线同色，是这四个选项唯一的颜色线索。
>   ⚠️ 这些版式都写在 `SettingsSheet.vue` 的 `<style scoped>` 里，**别去改全局**
>     `.sheet-row` / `.switch` —— `ReduceSheet` / `TransferSheet` 还在用那几条。
> **净资产那一行的缩略走势**（用户 2026-10-06：「净资产旁 加缩略走势图」→
> 「缩略图再宽一点，对比北京时间 12 点，如果今天盈利就绿色否则红色」）：
> · 在 `ExchangeAccountBoard.vue` 里**自绘 SVG**（`spark` computed，viewBox `100×30`，
>   CSS 把宽度拉到 **136px**）。⚠️ **别为它引 echarts** —— 那个 chunk 580KB，
>   展开大图时才按需下（`ExchangeCurveChart` 是 `v-if`）。
> · 点它 = 展开 / 收起下面那张大图（跟折叠标题同一件事）。
>   ⚠️ 折叠标题是 **「币种占比·资产走势」**：2026-10-06 试过只写「走势图」，
>   用户当天就要求改回来了 —— 别再来一次。
> · ★ **颜色 = 较北京时间 12:00 的涨跌**：锚点 = 当天 12:00，**现在还没到 12 点就退回
>   昨天 12:00**（`beijingNoon()`，按固定 **+8** 折算 —— 中国没有夏令时，不必为这一处
>   引时区库）；基准 = 锚点**之前最后一条**（曲线按时桶升序，过了锚点就停）。
>   `pct > 0` → 绿 `--ok`，否则（**含持平**）→ 红 `--bad` —— 用户的原话就是
>   「如果今天盈利就绿色**否则**红色」。
>   ⚠️ 曲线还没覆盖到锚点（账户历史不满一天）时 `pct = null`，颜色回主色 `--accent`：
>   宁可不表态，也别拿「开仓以来」冒充「今天」。
> · 数据就是大图那一份 `props.curve`（跟当前跨度联动），点数 < 2 直接不画。
>   `title` 里写着「较北京 MM-DD 12:00 +x.xx%」，方便核对颜色对不对。
>
> **持仓卡**（2026-10-06 定稿，`ExchangeAccountBoard.vue` 的 `.poss li`）：
> · ⚠️ 2026-10-07 起**不套卡了**（用户：「背景色去掉用底线每个仓位」）：透明底、无圆角，
>   每个仓位一条**底线**（最后一条不画）；`.poss` / `.grps` 两个容器的 `gap` 都归零，
>   左右也不再缩进 —— 跟仓位历史 / 成交 / 挂单四处统一成「透明底 + 一条线」。
> · 顶上一排：币种 / 方向 / 杠杆 / 来源标签，**右侧一行** = 未实现盈亏（大）。
>   ★ **整行可点 = 去「开单分析」看这个币的 K 线**（用户 2026-10-06：「点击币种标题行
>   区域切换到该币种的k线」）。走的是跟「合约」页点一行**逐字相同**那条路：
>   `prefetchSymbol(base)` → `pickSymbol(base)`（换掉分析页那套全局币种）→ `router.push('/analyze')`，
>   ⚠️ 顺序别反，反了会先看到上一只币的结论。是个 `div`，所以补了
>   `role="button"` + `tabindex` + Enter/Space（键盘也点得到）。
  ⚠️ 距强平**不放这儿**（它有自己的格）。
> · 中间**固定 4 列 × 1 行**（⚠️ 不要 `auto-fit`，不然窄一点就折成 3+1），
>   **格内标签在上、数值在下**（用户 2026-10-07：「简约化 竖着布局」，同一天又定
>   「一行显示是 4 个 开仓价 当前价 价值可切换显示为数量 距强平」）：
>   `开仓价 / 当前价 / 价值⇄数量 / 距强平`。
>   · 2026-10-07 这一版是**六格（3×2）压成一行四格**：省掉一整行、再加上「已结」出格，
>     整张卡从 **159px → 150px**，一格 36px、四格等分（390px 上每格约 77px）。
>     ⚠️ 想再瘦身这里已经没地方动了 —— 别又拆回两行。
>   · **「价值」和「数量」占同一格**（价值 = 数量 × 当前价，同一件事的两种说法），
>     显示哪个由**配置**里那条「持仓明细」定（`settings.ts` 的 `posShowValue`，默认价值）。
>     ⚠️ **不在卡片上点着切**：一排持仓各切一半就没法横着比数了，所以做成全局开关。
>   · **「标记价」那一格撤了**（跟「当前价」实测只差 0.02%，占一格不值）——
>     它的口径（强平 / 浮盈按标记价算）留在「距强平」的悬停里，别当它没存在过。
> · ⚠️ **「当前价」是最新成交价**（`last-price.ts`，全市场行情流 + 一次 `/api/markets`
>   当底稿；零权重、只留屏幕上那几个币）；拿不到就画「—」。
> · ⚠️ 「距强平」那一格是**百分比**，不是强平价本身（用户：「强平价格换成距强平」）；
>   强平价挪进 `title`。全仓 / 空仓时币安不给强平价 ⇒ 画「—」，四格照样是齐的。
> · **上一行**（用户：「止盈止损和按钮一行放在一行」是旧话，2026-10-07 拆开了）：
>   左边两条**止盈 / 止损**，**只报价、不写「止盈 / 止损」两个字** —— `0.06924/0.05115`
>   （用户给的样子是 `未止盈/0.01`：用 `/` 分隔，认哪条靠**颜色**（左止盈绿 / 右止损红）
>   + **位置** + 悬停），右边 **「已实现盈利」**（用户 2026-10-07：「已结放到和未止盈
>   那一行右侧 改叫已实现盈利」—— 就是这一行，因为它平时多半正显示着「未止盈/未止损」）。
>   · 那个数**来自钱账本**（`/api/exchange/income`：已实现 + 手续费 + 资金费 ⇒ **净**的，
>     不是毛的 `realized`）；账本里没这个币就画「—」（既不画 0、也不藏起来）。
>   · 两条止盈止损取自**交易所上的条件单**（用户在币安 App 手动挂的也算，
>     `tpsl.ts` 的 `tpSlOf`，卡片和弹层共用一份判断）。
>   · ⚠️ 同一个方向有好几张（部分平仓）时**只报比例最大的那张**（用户：「只显示百分比
>     最多的一个价格即可」），其余张数塞进 `title`。
>   · 没挂的那条写 **「未止盈 / 未止损」**（压暗）—— 别藏起来，不然人分不清
>     「没设」还是「没读到」；⚠️ 设了的那条**不写这两个字**（写了就太长，390px 铺不开）。
> · **最底下一行**：`止盈/止损` `减仓` `平仓` 三颗按钮**等分平铺**（用户 2026-10-07：
>   「按钮放最底下平铺」）—— 以前它们挤在止盈止损右边、加起来约 150px，手指点不中。
>   · ⚠️ 三颗**长得一模一样、都不上色**（用户当天先提「三个按钮颜色都一样」⇒ 改成了
>     「暖沙 / 中性白 / 红」三色，看过之后又改口：「三个按钮都简约化 和现在减仓一样」⇒
>     现在全是 `ghost` 的中性色：`--text` 字 + `--border` 线 + panel-2 底）。
>     ⚠️ **别再给某颗单独加颜色**（试过一轮，被否了）；要强调哪颗就改**文字**。
>   · ⚠️ 也别给它们起 `danger` 这种类名：全局 `button.danger`（透明底 / `--muted` 字 /
>     2px 内边距）会漏进来，把它变成跟另外两颗不一样的东西。
>   · ⚠️ 别再退回「跟止盈止损挤一行」：那一行现在还要放「已实现盈利」。
> · ★ 2026-10-07 **「持仓」那一格多了顶栏**（用户：「持仓 按钮上下间距小一点 顶部加排序条件
>   右侧加一键平仓 需二次弹窗确认」＋随后「要加升序降序图标」）：
>   `[↑↓] [币种|盈亏|价值|距强平] ……… [一键平仓]`（箭头在**最前面**：用户
>   「图标放在第一位」）。
>   · 排序条件是**分段选择器**（比全站的 `.seg` 小一档），值存 `settings.ts` 的 `posSort`；
>     方向那一档存 `posSortDir`，**换条件时回到该条件的默认方向**（`naturalDirOf()`：
>     币种 / 距强平 = 升序，盈亏 / 价值 = 降序）——不这样的话，「升序」会跟着人跑到
>     完全不同的条件上，看着像排错了。
>   · 升 / 降那颗箭头是**一颗 SVG 箭头转 180°**（降序朝下、升序朝上），别用 `↑↓` 字符；
>     它排在排序条件**左边**（见上）。
>   · 排序里的坑：`symbol` 升序**原样用后端给的顺序**（它本来就按币种给），只有降序才
>     `reverse()`；`距强平` 里**没有强平价的永远排最后**，不跟着方向翻。
>   · 「一键平仓」= `emit('closeAll', 全部持仓)` → 外层的 `closeAllRows()`：先弹确认
>     （真单会写明「真单：A / B / C 全部按市价平掉」），确认后**按 Key 去重、每套账户
>     调一次 `closeTradePositions(undefined, keyId, test)`**（不传 symbol = 后端那条
>     「把这个账户全平」的路，见下）。
>   · 卡片上那三颗按钮的上下间距收了一档（`.p-btns` 上边 8→5px、按钮内边距 6→5px、
>     `.poss li` 上下 10→8px）⇒ 一张卡 **150 → 141px**。
> · 「止盈/止损」是**一颗**按钮 → `TpSlSheet`（用户当天追加的意见，都在这里）：
>   **两组**（止盈 / 止损），每组把已有的单列成**一排标签**（`价 · 比例`），
>   点哪个标签才展开哪个的编辑区 —— ⚠️ **同一时刻全局只有一个编辑区**
>   （用户：「不要全部是可编辑，改为选择，每次只出现一个，其余标签显示」，
>   所以编辑区用 `v-show` 挂着，换一张看的时候已经填了一半的价不会丢）。
>   编辑区里有：触发价 + **这一张自己的**平仓比例滑轨（「滑动条区分开」）
>   + 「撤这张」（撤了标签划掉、块压暗，还能「保留」反悔）；右边「＋」再加一张。
>   底部**一颗「确认」**把所有改动**串行**提交（`saveTpSl()`：撤 / 改 / 挂混着来，
>   一条出错不影响别的，成功几条就报几条）。
>   ⚠️ 别退回「每行一颗挂/改」的写法 —— 价没填时按钮是灰的，用户会以为**确认键没了**。
>   ⚠️ 也别再把那段「⚠️真单/测试单」说明加回去（用户：「提示去掉，现在都是真的」）；
>   测试模式只在按钮上带个「测试」前缀。
>   ⚠️ 只有**真改过**的行才提交（`was` 记着打开时的原值），没动过的单不碰。
>   ★ **类型跟着触发价走**（用户 2026-10-06 问「保本价 8 该算止盈还是止损」）：
>   编辑区里实时显示「将按『止损』挂 · 跌到 8 才触发」，填的价**跨过现价**时这一单会
>   自动挪到对应那一组（止盈 ↔ 止损）。这正是币安的口径（后端 `legalKind()`）——
>   **保本单相对开仓价是赚的，但触发价在现价下方，币安只收 `STOP_MARKET`**，
>   拿止盈类型去挂必撞 `-2021`。⚠️ 没动过的那张按**它在交易所上的真实类型**分组
>   （`orderKind(o.type)`），别按当前价重算 —— 现价一移动界面就会把它说成止盈。
>
> **挂单那个 tab**（用户 2026-10-06：「挂单页面数据我看不懂」⇒ 当天重排）：
> 原来一行是 `卖 / TAKE_PROFIT_MARKET / — / × 3,303`，四个问题凑一块儿：
> 类型印的是**币安英文原文**；价格列印的是**委托价**，而条件单压根没有委托价
> （`price` 是 `null`）⇒ 那一格恒为「—」；**最该看的触发价一个字都没显示**；
> 数量也没有字头。现在一行**两行**（跟「成交」tab 同一个套路）：
>
> ```
> 卖  止盈（市价）  平 100%                        数量 3,303
> 触发价 0.006                                     2 小时前
> ```
>
> · 类型说中文（`TYPE_TEXT`：`STOP_MARKET` → 止损（市价）、`TAKE_PROFIT_MARKET` →
>   止盈（市价）…），止盈绿 / 止损红（`orderKind()`，跟持仓卡那行同一个色）；
> · **条件单看触发价、普通委托看委托价**（`triggerOf()` 取 `stopPrice`）—— 这两列别混；
> · 「平 x%」= 这张单占当前仓位的比例（`closePctOf()`）：⚠️ 口径必须跟 `tpsl.ts` 的
>   `tpSlOf` 一致 —— 数量 0 是币安 `closePosition: true` 的**全平型** ⇒ **100%**，
>   别显示成 0%；「全部」那一格里还要比 Key 名，别把两套账户的同名币算到一起；
> · 组头写 `1000BONK /USDT`（原来直接印一整串 `1000BONKUSDT`）。
> · **每组一块卡**（用户：「每个币种加隔离样式」→ 紧接着「持仓也加上背景色」）：
>   原来 `.poss li`（持仓卡）和 `.grps .grp`（挂单组）**共用同一条规则** ——
>   `--panel-2` 底 + 1px 描边 + 10px 圆角，容器 `gap: 10px` 拉开（两边现在都撤了）。
> · → **2026-10-07 一天里全拆完**：仓位历史的 `.cyc` 先撤描边、挂单的 `.grps .grp` 接着
>   也撤（「挂单也不需要背景边框还能用什么方式」）、最后**持仓的 `.poss li` 也撤了**
>   （「背景色去掉用底线每个仓位」）⇒ 五份列表**再没有一块有底的卡**，
>   全是**透明底 + 一条线**，左右 padding 归零（两端都贴面板内边）。
>   ⚠️ 线的画法各家不同，别互相照搬：仓位历史 = 段间 `border-top`；
>   成交 / 资金动向 = 行间 `border-top`（首行去掉）；挂单 = 每组**尾单**的 `border-bottom`；
>   持仓 = **每条** `border-bottom`（最后一条去掉）。
>   线的**画法各家不一样，别互相照搬**：
>   · 仓位历史 `.cyc`：`gap: 0` + `padding: 10px 0` + **`.cyc + .cyc` 的 `border-top`**
>     （段间一条线，比的是「一段一段」）。
>   · 成交 `.trades li` / 资金动向：行间 `border-top`（`li:first-child` 去掉）。
>   · 挂单 `.grps`：**线按币种分组，不按单**（用户三轮：「只在行数据加底线」→
>     「是按币种区分」）⇒ 组头不画线、组内单与单之间不画线，
>     只在**每组最后一单下面**一条 `border-bottom`（`.grps .grp .rows li:last-child`），
>     整份列表**最后一组不画**（不拖尾巴线）；组与组的分界就是这条线 + 16px 留白。
>   ⚠️ `.grps .rows li` 跟 `.rows:not(.trades) li` **同权重（0,2,1）**，
>     要盖掉那条 `border-top` **只能靠写在后面**（写在前面会被盖回去 ⇒ 上下一堆双线）。
>   ⚠️ 试过**左边一条主色竖线**，用户当场否了（「不要左侧加颜色」）——不要再往左边塞重色。
> · ★ **点一行 = 改这张单**（用户：「挂单可以修改」）→ `OrderEditSheet`：
>   条件单改**触发价**、限价单改**委托价**（标签 / 占位符 / 校验都跟着类型走），
>   加一根**平仓比例**滑轨（张数 ÷ 持仓，只有对得上持仓才有）+ 数量框，
>   底下 `撤单` / `保存修改` 两颗一样高。
>   ⚠️ **没改动时「保存」是灰的** —— 不然手一滑就是把同一张单撤了重挂一遍。
>   ⚠️ 触发价正好等于标记价 ⇒ 直接拦住（币安必回 `-2021 立即触发`），别让人提交完
>   再看一句英文报错。
>   ⚠️ 撤单**要点两下**（第一下只是把按钮变成「再点一下撤单」）—— 改单 / 撤单都**没有
>   测试版**，点下去就是真动作。
>   ⚠️ 提交是容器干的（`saveOrderEdit` / `cancelOrderEdit`）：只有它知道这张单是哪套 Key 的
>   （挂单里带的 `keyName` → `keyId`，`keyIdOfOrder()`）。
> ⚠️ **别动 `.rows li` 本体**（它还是单行 flex，资产明细/账本那几处还在用）——
> 两行只是覆盖 `.grps` 里面的那一组。
>
> **二级 tab 现在是这五个**（2026-10-06 又改了一轮）：持仓 / 挂单 / 仓位历史 /
> **成交历史** / **资金动向**。
> · 「成交」改名**成交历史**（用户：「成交改名成交历史」）。
> · 「资产」那一格**删掉**，换成**资金动向**（用户：「资产 tab 去掉换成资金动向，
>   显示所有资金事件怎么变的数据」）。原来那三张余额表（合约多资产 / C2C / 现货 USDT）
>   在净资产那一段的「币种占比」图例里本来就有，重复占一格不划算。
>   资金动向读的是**钱账本**（`/api/exchange/income`）：逐笔列「钱为什么动」——
>   已实现盈亏 / 手续费 / 资金费 / 划转 / 强平清算…，正数进钱负数出钱。
>   ⚠️ **不做任何合计**（用户 2026-10-06：「统计数据不要写，近 7 天多少笔保留」）：
>     顶上只剩「近 7 天 · N 笔」这一个计数，逐笔行第二行右边是「所属账号标签 + 时间（到秒）」。
>     接口仍然返回 `totals`（net / realized / commission / funding / other），UI 只用了 `count`。
>   ⚠️ 逐笔金额按**各自资产**记（USDT / BNB / USDC 混着），**不折算**成 USDT。
>   ⚠️ 账本**库里只留最近 7 天给你看**（标题那个 N 天就是这个）；而**币安那边保留 3 个月**，
>     所以回补是能补到 3 个月的（见第 59 节）。
> · ⚠️ tab 条外面套了一层 `.seg-scroll`（横向可滚、滚条不画）：5 个标签在 390px 上正好卡满。
>
> **仓位历史套卡 / 成交只要分隔线**（用户 2026-10-06：「仓位历史只显示已完全平仓的样式更改，
> 成交样式也改这个不要背景」→ 接着「成交看不太懂，不需要边框只要能区分就行」）：
> · 仓位历史 → 只留**已完全平仓**的那些段，详情是底部弹窗。
>   ⚠️ 样式后来又改了三轮（2026-10-06 两轮 + 2026-10-07 一轮）：
>   ① 「整体不要背景框」⇒ 卡那套（底 + 描边 + 圆角）撤掉；
>   ② 撤掉之后「感觉区分度又不好」⇒ 先试了「行与行之间一条线」，用户明确纠正：
>      「区分度指的是**每一个历史（条目）**」—— **要的是「一条一条分得开」，
>      不要的是「铺底」**。于是改成**透明底 + 1px 描边 + 10px 圆角 + 段间 10px 空档**；
>   ③ 2026-10-07 用户：「仓位历史行数据边框去掉用分割线看看」⇒ 圈也撤了，
>      现在 = **透明底 + `padding: 10px 0` + `.cyc + .cyc` 一条 1px 分割线**
>      （`gap` 归零，第一段头顶不画线，上面是列表标题）。
>      ⚠️ 一句话口径：**背景可以不要，边界必须有** —— 但边界**可以是一条线**，
>      不必围一圈；左右 padding 也归零，让这一段的两端跟资金动向 / 成交那两份列表对齐。
>   ③′ **整页不留悬停态**（用户 2026-10-07：「不需要 hover 效果」）——
>      这一页里所有 `:hover` 全删了（`.cycles .cyc` 的淡底、持仓卡 `.p-h` 的币种名下划线、
>      挂单组 `.grps .rows li` 的 `--hover` 底、`.spark` 的提亮），**只保留 `:focus-visible`**
>      （键盘导航那条），功能不受影响（点一下照样开弹层 / 开 K 线）。
>      ⚠️ 理由不只是「不好看」：手机 WebView 里悬停本来就是虚的，**安卓会在点完之后把
>      `:hover` 粘住** —— 点一行那一行一直亮着，看着像「选中」。
>      以后给这一页加交互态：用 `:focus-visible`，别用 `:hover`。
>   ④ 段内**不分档**（先试过「价提亮 + 时间数量压暗」，用户当天否掉：「持仓时间什么的内容
>      都改为白色吧，这个不用区分」）⇒ 六个值一律 12.5px 白字；右上角净盈亏也**不放大**
>      （「盈利的金额字体不要放大」⇒ 跟 `.pnl` 的 13px 走）。
>   ⑤ 六格里第三格是「**持仓价值**」（开仓名义价值 = 数量 × 开仓均价，`money()`
>      跟持仓页同一个口径）；**持仓时长**挪到脚注左边（用户：「持仓是持仓价值，
>      持仓（时间）放在最底下」）。
>   ⑥ 脚注只剩「持仓时间 + N 笔明细 ›」—— **手续费 / 资金费不在卡片上了**
>      （用户：「手续费资金费在明细中有就行」），改到明细弹层里报，并且**带单位 USDT**
>      （「手续费和资金费用没有单位」）。资金费那句后面注明「未计入」净盈亏。
>   ⑦ 明细弹层：网格第三格叫「**开仓价值**」（用户：「明细表没有体现开仓价值」）；
>      第一笔建仓的成交标「**开仓**」（以前一律写「加仓」）。
>   ⑦′ 逐笔**只报这张单本身**（用户 2026-10-06 最新一轮：「明细样式再改，只显示订单，
>      时间写全放右侧，重新布局」）—— 每一笔两行：
>        ⚠️ 摆法用户连着调了**四轮**，**这一版是定稿**（原话：
>           「买卖标签放在时间后，价格数量放在时间下，行为放在最右侧，
>            实现盈利放在行为左侧」）：
>        ① `时间` 后面紧跟 `买/卖`（只隔 6px）…… 最右是**实现盈亏 → 行为**
>           （盈亏在行为的左边，两个都是右对齐：行为贴右边界、盈亏差 6px）；
>        ② 换行：`价格 x  数量 y` 从**左边**起（正好在时间下面）…… 最右是
>           `价值 n USDT`（`价格 × 数量`）—— 它跟上一行的「行为」落在**同一条竖线**上。
>      ⚠️ 逐笔的「手续费」**去掉了**（那是「钱」的账，净盈亏那行公式已经汇总）；
>         **不用乘号**（「不要用乘号，线上写开仓价和数量」）；标签写「**价格**」不是「价」。
>   ⑦ 弹层高度卡 66vh（「弹窗高度要限制」），而且**只有订单那一段滚**
>      （「弹窗滚动区域只在订单区域」）：外壳 `display:flex; overflow:hidden`，
>      标题 / 净盈亏 / 六格钉住，`.cyc-orders` 自己 `flex:1 + overflow-y:auto`
>      （⚠️ `min-height: 0` 不能省，否则 flex 子项不收缩、整个弹层又被撑开）。
>   ⑧ 订单那一段是**时间轴**画法（「每一笔用一个点加连接线样式」）：`li::before` 一个
>      7px 圆点（开仓那一笔的点用强调色）、`li::after` 一条 1px 竖线串到下一笔
>      （最后一笔不画）；**不再画逐笔分隔线** —— 时间轴本身就是节奏。
>      （时间轴 + 两行布局是 ⑥′ 那轮的版式，`.ord-time` 靠右，`overflow-x` 实测 0。）
>   ⑨ 弹层里那几块「顶部信息」**后来整块删掉了**（用户 2026-10-06：「去掉顶部的信息，
>      外面已经有了」）—— 净盈亏 / 三项公式 / 持仓时间 / 六格，卡片上全有
>      （净盈亏在标题行、持仓价值在网格、持仓时间在脚注），弹层里再铺一遍纯属重复。
>      现在弹层只有三块：**标题 / 简略 K 线 / 逐笔时间轴**（只有最后那块滚）。
>   ⑩ ~~顶上那块换成了**简略 K 线 + 买卖点**~~ **这一版已经整块撤掉了**
>      （用户 2026-10-06 最后一句：「去掉这个显示 k 线缩略图的功能」）——
>      弹层现在又只剩**标题 + 逐笔时间轴**：相关代码全删了
>      （`MiniKline` 的 `marks` / `axes` 两个属性、`chart-theme` 里的 `ScatterChart`、
>      容器里的 `loadCandles` 取数与 `emit('cycle')`）。
>      ⚠️ 但 `MiniKline` 里那个**真 bug 的修复留着**：它以前读 `c.time`，而
>      `/api/candles`（和知识库那份数据）给的是 `timestamp` ⇒ 现在走 `candleTime()`
>      两种都认（那会影响知识库卡片那张缩略图）。
>      下面这段是当时的设计，留着备查 —— 如果哪天要把图请回来，按它做就行：
>      · 图：`MiniKline`（echarts，**异步载**，跟曲线图同一个理由）新增两个属性：
>        `marks` 与 `axes`（**都默认关**，知识库/案例那张缩略图不受影响）。
>        · 买卖点：买 = 朝上的绿箭头、卖 = 朝下的红箭头（`path://` **自绘箭头**，
>          有柄有头，不是一块三角 —— 用户先嫌「不太明显」，后又要「换个图标」）；
>          **15px + 深色描边**，`symbolOffset` 把身子推出蜡烛外，**箭头尖仍贴着成交价**。
>        ⚠️⚠️ **周期只能从 `VALID_TFS` 里挑**（`5m/15m/1h/4h/1d`，跟「开单分析」页
>        那几个按钮同一套）—— 本 App **没有 1m**。第一版这里写了 `'1m'`，
>        而 `/api/candles` 对不认识的周期是**静默回退成 `1h`** 的 ⇒ 一分钟就平的仓，
>        图上画的是一小时 K 线、8 笔成交全挤在同一根上（用户 2026-10-06：
>        「k线周期不对，我一分钟结束用的一小时的k」）。现在按「根数落在 20~300」挑：
>        ≤20 小时 → `5m`、≤3 天 → `15m`、≤12 天 → `1h`、再长 `4h`；
>        留白也从「两边各 1 小时」改成**两边各 1 根**（5 分钟的图上原来凭空多 24 根空白）。
>        （`/api/candles` 那边补了一行 `console.warn`：周期不认识、按 1h 返回时记日志 ——
>          行为没动，免得再有人被静默糊过去。）
>        · 坐标轴（「简略 k 线要加上坐标轴」）：右侧价格刻度、底部时间刻度，
>          网格线用 `C.grid` 压到 0.45 透明度；刻度格式按量级走
>          （`priceTick`：≥1000 取整 / ≥1 两位 / ≥0.01 四位 / 更小六位；
>          `makeTimeTick`：跨度 ≤1 天报 `HH:mm`，跨天报 `MM-DD`），
>          右侧留 44px、底部留 15px 给它，否则刻度会压在 K 线上。
>      · 数据：由**容器**（`ExchangeAccountLivePanel.openCycleChart`）按「币种 + 开平时间」
>        调 `loadCandles` 取；周期按跨度自动挑（≤150 分 → 1m、≤600 → 5m、≤2 天 → 15m、
>        ≤7 天 → 1h，再长 4h），两边各留 1 根；同一段来回开关命中 `cycleChartKey` 不重复打接口。
>        ⚠️ 面板本身是**纯展示**的，所以取数在容器、画图在面板（弹层点击 `emit('cycle')`）。
>      · ⚠️ `chart-theme.ts` 里要注册 **`ScatterChart`** —— 买卖点是 scatter 系列，
>        没注册 echarts 只会打一句 warning（`Series scatter is used but not imported`）然后**什么都不画**
>        （实测踩过）。
>      已实现已经算进净盈亏（`net = 已实现 − 手续费`），再报一遍是重复。
> · 成交 → **不套卡**（描边 / 圆角撤掉），一屏几十条画框太吵，行间一条**极淡的分隔线**就够。
>   ⚠️ 所以 `.rows:not(.trades) li`（每行一条分隔线那套）要把成交排除掉，免得两套规则叠一起；
>   成交自己在 `.trades li` 里给分隔线。
>
> **成交历史逐笔的版式 = 资金动向那一套**（用户 2026-10-06：「成交历史也格式化，
> 目前布局不好看，也是到秒」）：
> · 第一行：`方向(买/卖) + 币种 /USDT + 账号标签` …… `价值 16.3378 USDT`。
>   标签是用户后补的（「右侧加上价值」：同一行里 `价`/`数量` 都报了名字，就它是裸数字，
>   得靠猜）。
>   ⚠️ `.t-amt` **不给定宽**（用户紧接着：「价值两个字不要固定位置，靠右加间距」）——
>     资金动向那边是纯数字，`.fl-amt` 的 104px 定宽右对齐正合适；这边前面挂了「价值」，
>     一定宽就把标签钉在列左边缘、数字甩到最右边，金额一短中间空一大块。
>     现在整块 nowrap 靠右：标签 6px 间距贴着数字，**右边缘照样落在同一条竖线上**。
> · 第二行（用户 2026-10-07 连着定了两版，**现在这版为准**）：
>   **两行两列、每格「文字在左（右对齐）、内容在右」** ——
>   `价格 0.1212 │ 数量 134.8` / `手续费 0.0082 USDT │ 时间 10-06 20:32:03`。
>   · 用户先说「下面文字和内容列竖着布局居中」（标签在上、数值在下、逐列居中），
>     看到效果后改成「文字在左内容在右」，再说「文字右对齐」。
>   · ⚠️ **四项横排一行放不下**：一行要 380px（时间是 `10-06 20:32:03`，14 个等宽
>     字符 = 91px），390 屏的行宽只有 340px ⇒ 分两行两列。
>   · ⚠️ 两列 `max-content` + `justify-content: space-between`：右列贴着行右边缘，
>     跟第一行的金额落在**同一条竖线**上。
>   · ⚠️ 标签统一按 `3em`（三个字）占位 + `text-align: right`：`价格`/`数量`/`时间`
>     是两个字、`手续费` 是三个字，不统一的话同一列里两个数值会差 10px，看着是歪的。
> · 账号标签（「测试」这种 `.ktag`）2026-10-07 从第二行最右边**搬到第一行币种后面**
>   —— 原来它跟币种隔着大半行，扫的时候连不起来是哪套 key 的成交。
>   ⚠️ 这一搬让第一行多了「标签 28px + 两个 gap」，390 屏实测最宽的一条**溢出 11px**
>     ⇒ `.t-line` 的 gap 8→6、`.t-amt` 的 `margin-left` 10→6 把这点挤出来；
>     另外 `.trades .t-line .sym` 加了「可收缩 + 省略号」兜底，宁可截币种名也不撑破行。
> · ⚠️ **窄屏兜底**（`@media (max-width: 380px)`）：360 的安卓机上第一行要塞
>   「方向 + 币种 + /USDT + 标签 + 金额」五样，实测 10/20 条会把币种名截成 `1000…`
>   ⇒ 那时把金额尾巴上的 `USDT` 藏掉（同一行的 `/USDT` 就在币种旁边，单位是重复的）。
>   320px 仍然会截币种名，但不撑破行、不出现横向滚动条。
> · 右边那一列（金额 / 时间）必须跟资金动向落在**同一条竖线**上。
> · 容器都留 `gap: 10px`（`.poss` / `.grps` / `.cycles`），三处同一个数。

**仓位历史里的「资金费用」是哪来的**：成交账本（`exchange_fills`）里**没有**这一项，
它在**钱账本**（`exchange_income`，`income_type = 'FUNDING_FEE'`）里。`listPositionHistory`
会把这批资金费取回来，按「**同一个币 + 时间落在这一段的开仓 ~ 平仓之间**」归给某一段，
加进 `PositionCycle.funding`（**符号跟钱走：负 = 付出，正 = 收到**）。
⚠️ 持仓为 0 那会儿收/付的资金费**归不到任何一段**，只能丢掉（那部分在「资金动向」里看得到）。
✅ `net` = **已实现 − 手续费 + 资金费**（资金费自带符号 ⇒ 直接加；付出扣钱、收到进钱）——
用户 2026-10-06 问「为什么资金费不计入」，答案是：那是我一开始为了不改动历史数字的选择；
现在按「这一笔仓位真花的钱」并进去了（把资金费归到某一段时顺手 `net += amount`）。

数据接法：

1. 进页面 → `GET /api/exchange/overview` → **立刻渲染**（顶部「3 分钟前」+ ⟳）
2. `age > 60s` 或用户点 ⟳ → `POST /refresh` → 回填
3. 订阅 `/api/exchange/stream`（SSE）→ 有更新就回填，数字**淡闪一下**
   （**每套 Key 一条**，见 M7）
4. 挂单 / 成交 / 盈亏三个 tab **懒加载**（进 tab 才拉）
5. 局部失败只提示那一块，不阻塞整页
6. 顶部的账户 tab 条（`全部` + 每套 Key）**只有 ≥2 套时才有**；
   选中值 `picked` 往上 emit，重新取数全由 `ExchangeAccountLivePanel` 负责
   （板子本身是纯展示的，一个请求都不发）

> M3/M5（已完成）：换成 `ExchangeAccountLivePanel` 真容器，
> mock / 预览页 / 老面板 / 老接口已经全删。

---

## 7. 落地顺序

| 里程碑 | 内容 | 产出 |
|---|---|---|
| **M0** ✅ | 用真 key 跑 30 秒临时脚本，确认 ccxt 的币安 ws 用户数据流能出事件、字段够用 | 一句话结论：走 WS 还是退回轮询 |
| **M1** ✅ | `schema.ts` 两张表 + `data/exchange-overview.ts`（REST 取数）+ `overview`/`refresh` 接口 | 真实数字能出来（界面先不动） |
| **M2** ✅ | `exchange-stream.ts`（WS 常驻 + 重连复用 listenKey + 重连补成交）+ 5 分钟采样兼对账 + SSE `/api/exchange/stream`（⚠️ 采样 / 对账的节奏后来改过，见 §24） | 数字开始秒跳 |
| **M3** ✅ | 成交/盈亏**读**接口 + 前端接真数据（`交易所账户` tab 换成 `ExchangeAccountLivePanel`，SSE 接上） | 去掉 mock（界面已用真数据） |
| M4 ✅ | 资产曲线：`GET /api/exchange/history?id=&range=1d\|7d\|30d` + `ExchangeCurveChart.vue`（echarts：close 折线 + high/low 区间带、断档不插值） | 2026-10-05 完成 |
| M5 ✅ | 删 mock / 预览页 / 老面板 / 老 `/api/exchange/account`（连同它那套余额估值、全量订单、已实现盈亏函数） | 收尾（2026-10-05 完成） |
| M6 ✅ | K 线页底部**下单模块**（多空 / 滑动条 / 余额 / 杠杆）+ `/api/exchange/trade*` 三条接口 —— **只走测试单** | 2026-10-05 完成（`comps/OrderPanel.vue`） |
| M6.1 ✅ | 下单模块改版：顶部两格 **「开单」/「仓位」**（市价降级成开单页里的开关：开着价格框禁用、关掉可填 = 限价单）；仓位页简略显示持仓 + 平仓 / 全部补仓；顶栏**一键平仓**。新增 `POST /api/exchange/trade/close` | 2026-10-05 完成 |
| M6.2 ✅ | 下单模块：**去掉「补仓」**、仓位页改成「账户里所有持仓，每条自带平仓」、顶栏标题换成**在用的那套账户名**；「配置」里新增**下单账户**切换（`trade-account.ts`，落 `localStorage.ca-trade-key`） | 2026-10-05 完成 |
| M6.3 ✅ | 下单模块第三版：顶栏**删掉账户昵称和「测试单」标签**、`一键平仓` 挪到**最右**并加二次确认；账户名（`.ktag`）+ 可用余额挪到**价格行右侧**、价格输入框收窄到 130px；**「测试单」变成「配置 → 测试下单」开关**，关掉走真单（`/fapi/v1/order`），真单模式顶栏挂红色「真单」章 | 2026-10-05 完成 |
| M7 ✅ | **多账户视图**：「交易所账户」页顶部的账户下拉框换成 **tab 条（`全部` + 每套 Key 的名字）**；`全部` = 各套快照**加总**（持仓/挂单/盈亏按账户拆行并打 `.ktag` 标签；曲线**按各套「最近的已知值」相加**，见下面那段说明），单套时不合并、也不打标签 | 2026-10-05 完成（`comps/ExchangeAccountLivePanel.vue`） |

| M8 ✅ | **现货（只 USDT）进统计** + **万能划转**：净资产 = 合约 + C2C + 现货USDT（快照加 `spot_usdt` 列）；「交易所账户」净资产那行加「划转」按钮 → 弹层支持现货/资金/合约之间六种组合（**真钱**，无测试接口，常驻警示 + 二次确认） | 2026-10-05 完成 |
### 多账户视图（M7）—— 为什么是「加总」而不是「切来切去」

一套 Key = 一个账户，但用户手上可能同时挂好几套（主号 / 小号 / 测试号）。
看总账是常态，看单号是例外 ⇒ **默认落在 `全部`**，tab 条才有意义。

- **数据层**（`ExchangeAccountLivePanel.vue`）：每套 Key 各发一条
  `GET /api/exchange/overview?id=` / 一条 `SSE /api/exchange/stream?id=`，
  结果按 key_id 攒在 `parts` 里，`rebuild()` 用 `mergeOverviews()` 合成一份给纯展示的
  `ExchangeAccountBoard`。⚠️ 因此这个页面的 SSE 是**并行 N 条**（N = 账户数）。
  2026-10-06 起这一页**被缓存**（`MeView` 里 `v-show` 留着不卸载，切回来不用重拉），
  所以离开时靠 `:active=false` 让 `stopWork()` 把 N 条全关，回来 `startWork()` 重连；
  不关的话 EventSource 会一直挂着。
- **合并口径**：金额类（钱包 / 可用 / 未实现 / C2C / 名义）**求和**；
  持仓列表**拼接**并给每条塞 `keyName`；成交/挂单/盈亏按（`keyName` + 交易对）分组，
  界面上打 `.ktag` 小标签区分来源 —— 同一个币在两套账户上各有一条时，不分就会看成一条。
- **曲线合并**（⚠️ 2026-10-06 修过一次）：按**各套「最近的已知值」相加**，不是
  「同一个桶里各家都有点才相加」—— 各套的采样时刻根本不齐（实测一套 152 个点、
  另一套 132 个），后者会让**只有一边有数据的桶**只剩那一套的值（总账 ~28 掉到 ~13），
  看着就是「数据没统计进去全部」。某套在最早那几个桶还没开始采时用它的**第一个点**回填。
  桶宽取几套里**最宽**的那个（`all` 跨度按各套最早那条快照算，可能不一样）。
- **单套账户**：`accounts` 只有一项 ⇒ **不摆 tab 条**，hero 里退回一个名字标签，
  合并逻辑整体短路（`mergeOverviews` 原样返回），单账户的界面跟以前逐字一样。
- ⚠️ **`picked` 的初值是空串**，不是 `'all'`：挂载时要靠赋值触发 `watch(picked)`
  才会去拉数据；初值写成 `'all'` 的话赋同样的值不触发 watcher，
  页面会永远停在「正在取账户快照…」。

### M2 实测记录（2026-10-05，本地跑通）

启动日志四步：`快照已写（boot）` → `listenKey 就绪（64 位）` → `WS 已连（用户数据流）`；
库里 `exchange_snapshots` 四条路径都落了行（`boot` / `ws` / `poll` / `shutdown`）。
SSE 用真 token 验过：`open` → `snapshot`（底稿，带真实 `ageSec`）→ 点 ⟳ 后收到
`source=manual`、`ageSec=0` 的**实时推送**；不带 token → 401。

⚠️ 三个实测踩到并已修的坑：

1. **重连别重建 listenKey** —— `POST /fapi/v1/listenKey` 是 **1 次 / 5 分钟**，且一个
   账户最多留 60 个 key，建新的会把最老的挤掉（可能顺手踢掉用户自己的量化程序）。
   断线直接拿**旧 key** 连回去（它能活 60 分钟，我们 25 分钟续一次）。
2. **退出要幂等** —— 连按两次 Ctrl+C 真写出了两条 `shutdown` 锚点（库里验证过）。
3. **`POST /refresh` 不经过 `KeyStream`**，所以它自己不会 emit —— 必须显式
   `publishSnapshot()`，否则同一用户别的页面要等 5 分钟采样才看到新数。

⚠️ 仍未验证：`saveTrade()` 的字段映射（`info.symbol` / `fee.currency` /
`info.realizedPnl`）—— 该账户**合约和现货都没有一笔成交**，等有真实成交才能确认。

---

## 9. 容量 / 理论用户数

**单套 key 的消耗**（按现在定的节奏算）：

| 项 | 量 |
|---|---|
| WS 常驻连接 | **1 条**（每套 key 一条） |
| REST | C2C 轮询 1/5min + 对账 2/15min + listenKey 续期 1/30min ≈ **0.37 请求/分钟/套** |
| 权重（保守估） | ≈ **5 权重/分钟/套**（闲置）→ **~50**（有人边看边用）——见第 12 节的实测口径（fapi 预算 2400/分钟/IP） |
| 磁盘 | 稳态 **≈ 5.5 MB / 套**（分级归档的稳态，见第 12 节 P5）+ **0.44 MB / 年**（`1d` 点永久） |

> ⚠️ 上表原来是「≈3.3 权重/分钟/套」，那只算了**后端流**，没算**有人在看页面**时前端那几路。
> 2026-10-06 改造后重新盘了一遍（见第 12 节），闲置确实 ~5，
> 但「资产页 + K 线页 + 频繁成交」能到 ~120/套。⇒ 真正的天花板是**并发活跃用户数**，不是账户数。

**各自的天花板**：

| 资源 | 撑到多少套才吃紧 |
|---|---|
| WS 连接（Node 侧） | 几百条无压力（1 条约 50KB 内存）⚠️ 但**启动时连握手要错开**（币安限 300 次/5 分钟/IP）⇒ 限速 **1 条/秒** |
| REST 额度 | **看活跃度，不是看套数**：闲置 2400 / 5 ≈ 480 套；若全都「边看边用」2400 / 50 ≈ **48 套**（≈24 个用户）；最猛的「K线+资产页+频繁成交」120/套 ⇒ 只有 **20 套**。见第 12 节实测口径 |
| **磁盘** ← 改造前真正的瓶颈 | 改造前**没有清理**：128 MB/年/套 ⇒ 300 套就是 38 GB/年。**2026-10-06 加了分级归档**（第 12 节 P5）⇒ 稳态 5.5 MB/套 + 0.44 MB/年 ⇒ 1000 套也才 ~5.5 GB |

⇒ **单实例舒适区：并发活跃用户 ~20 人以内**（也就是 40 套 key 在被人看着）；
**闲置账户可以挂很多**（几百套），但**同时盯着页面的人**才是权重天花板的决定因素。
磁盘在加了归档之后不再是瓶颈。

**超过 300 套再优化**：① 把 1h 档的保留期从 90 天缩到 30 天 ② C2C 轮询 5 → 15 分钟
③ 分片（一条流固定挂某个副本）。（降采样已经内置了，不是以后的选项）

⚠️ 以上全部基于**单实例**：多副本会重复订阅同一个 key（同一账户多条连接会互相干扰）
⇒ 到时候要么加分布式锁、要么把这条流指定给主副本。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| ccxt 对币安 ws 用户数据流只"有方法"没"声明支持" | M0 实测；不行就 5 分钟轮询增量（**架构不变**，只换数据源） |
| WS 丢事件 → 账错 | 15 分钟 REST 对账，以 REST 为准 |
| C2C 无 WS | 5 分钟轮询，界面知道「最多旧 5 分钟」即可 |
| listenKey 失效 | ccxt 管续期；失败重建流 |
| 多副本重复订阅 | 现在单实例；将来加锁或指定主副本 |
| 币安只留 3 个月 | 成交**永久落库**（存它的根本理由） |
| 交易所额度 | 每 key：2 请求/5 分钟 + 1 次对账/15 分钟，可忽略 |
| 只绑了现货 key 的账户（`marketType=spot`） | 提示「这套账户不是合约账户」，**不硬算** —— 现货 USDT 只是顺带统计，这一页的主体仍是合约 |

---

## 11. 已定 / 已否决（方案收官）

| 问题 | 结论 |
|---|---|
| 资产曲线 | ✅ **已做**（M4，2026-10-05）：快照序列 → `/api/exchange/history` → echarts 折线+区间带 |
| 快照保留 | 5m 留 7 天 / 1h 留 90 天 / **1d 永久** |
| 聚合算法 | **不取平均，留 high/low（振幅）** + close |
| 删 key | **数据一起删**（`CASCADE`），“从注册到结束”= 绑定 → 删 key |
| tab 文案 | **不改**，继续叫「交易所账户」 |
| 断档补数据 | ⏸ **计划**：用 `/sapi/v1/accountSnapshot?type=FUTURES`（日点，北京 08:00，回溯 30 天）—— 实测接口可用，但**代码里没接**（见 §3「断档与恢复」） |

⇒ 方案已定，开工顺序见上面「M0~M5」（**M0 已完成**）。

---

## 12. 2026-10-06 改造：持仓 / 盈利实时化 + 去重 + 限流

> 起因（用户原话）：**「k 线的仓位和交易所界面的持仓数据没有同步，我开仓了一段时间
> 交易所界面才有数据，数据没有复用吗？」「前端请求频率怎么样」「后端有没有对前端接口
> 限流，因为交易有限流」**。查下来的四个问题（P1~P4）和对策：

### P1 · 持仓有三个互不相干的取数方 → 现在只有**一个来源**

改造前：
| 消费者 | 数据从哪来 | 刷新 |
|---|---|---|
| 交易所界面 | 库里的快照 `exchange_snapshots` | 挂载/切账户读一次，之后靠 SSE |
| K 线叠加 | `GET /api/exchange/trade/positions` | **自己 15 秒轮询** |
| 下单页「仓位」格 | 同一个接口 | **又自己 15 秒轮询** |

⇒ 后果：① 同一屏左边栏（旧快照）和图上的持仓线（刚拉的）**显示两个数**；
② 每多一个消费者就多一路轮询，全都打到交易所。

现在：**`backend/src/data/position-cache.ts` 是唯一账本**。
- 常驻流写、所有人读：`publishLive()` 写一次，就通过 SSE `positions` 事件广播一次；
- `GET /api/exchange/trade/positions` **不再直连交易所**，读这份内存；
- 前端 `frontend/src/positions.ts` 是**唯一前端来源**（引用计数订阅），
  K 线叠加 / 下单页都读它 —— 三条链路看的是同一份数据。

`LivePosition` 同时带两个符号，两拨消费者各取所需、不用各自换算：
- `symbol` = ccxt 统一写法（`BTC/USDT:USDT`）→ 板子 / 平仓按钮吃这个；
- `raw` = 币安原始符号（`BTCUSDT`）→ K 线叠加 / 下单页按它比对。

### P2 · 交易所界面**没有陈旧检测** → 加了兜底定时器
`loadSnapshots()` 原来只在**挂载 / 切账户**时跑一次，之后纯靠 SSE。
WS 一旦不推（连接问题 / 币安没派 `ACCOUNT_UPDATE`），最长等 **5 分钟采样** —— 这就是
「开仓了一会儿才出来」的直接原因。

现在 `ExchangeAccountLivePanel.vue` 每 20 秒看一眼：**整份快照**（钱包 / C2C / 现货）
超过 **90 秒**没更新就主动刷一次（后台标签页不刷）。
⚠️ `positions` 补丁**不算**「整份快照」—— 它只带持仓，喂不饱这个判断。

**★ 2026-10-06 补：同一拍里再重读「挂单 + 仓位历史」**（用户：「挂单数据没有更新，
仓位历史也没更新」「没有及时更新」）。

这两份列表以前**只有** SSE 的 `orders` / `fill` 事件会触发重读，而事件本身可能就不来：
断线那阵子（`reconnect` 以前只补快照 / 成交 / 曲线）、后端重启、隧道抖一下、
或者交易所对账窗口还没轮到 —— 结果就是「数字明明变了、列表还是旧的」，只能手动刷新。
现在三条路一起兜：

| 触发 | 干什么 |
|---|---|
| 20 秒那一拍（`startSnapTimer`） | `loadOrders({silent:true})` + `loadCycles()` |
| SSE **重连**（`reconnect`） | 上面两下 + `loadFills()` / `loadCurve()` / `loadSnapshots()` |
| **换到那个 tab**（`onTab`） | 挂单 → 重读挂单；仓位历史 → 重读仓位历史；成交 → 重读成交 |

⚠️ 敢这么频繁是因为这三份都是**读我们自己的库**（挂单存库 / 仓位历史本地推 / 账本），
毫秒级、**零交易所权重** —— 跟上面那个「打交易所的快照」不是一回事。

#### 进页面时的「握手宽限期」（`streamWarming`，2026-10-06 补）

用户：「怎么感觉刷新后进入该页面就会请求」——**他看对了**。实测（页面挂上 fetch 记录器）：
进页面 **483ms** 就并发发出两条 `POST /api/exchange/refresh?auto=1`（一套账户一条），
各 ~2 秒 / 25 权重 —— 正是会撞上出口超时、弹「刷新失败」的那一下。

为什么：刚挂载时 `streamAt` 还是 0（SSE 才刚发出去、还没收到第一帧），
而库里那份快照是后端 5 分钟采样写的（早旧过 15 秒）⇒
`(!streamAlive(id) || deaf) && age > 15s` 成立 ⇒ 白打一轮交易所。

修法（`STREAM_GRACE_MS = 8000` / `STREAM_GRACE_STEP_MS = 1200`）：

* 挂载后的宽限期内（`streamWarming`）**不许**判定「流死了」；
* 每 1.2 秒重判一次（重判只是 `loadSnapshots()` 再读一次库：毫秒级、**零权重**），
  最多等到 8 秒；
* 宽限期内收到任何一帧（`alive`）或后端报 `health: deaf` ⇒ 立刻按正常逻辑走
  （流活着就不刷）；**8 秒都没动静**（真断线）⇒ 照旧兜底刷（只比原来晚 ~8 秒），
  再往后还有 20 秒那一拍（`SNAP_FRESH_MS = 90s`）兜底。

为什么是 8 秒而不是 2.5 秒：后端在订阅那一刻会 `wakeOnView`，
数据旧过它自己的 `FRESH_MS`(60s) 时**先自己去对平一轮再 emit** ——
经出口隧道要 2~4 秒才送第一帧。宽限期短于它就会两头同时打交易所
（实测 2.5 秒那版在 3.4 秒时照样发了 refresh，等于白等）。

实测（修完）：
| 场景 | 进页面时的 `POST /api/exchange/refresh` |
|---|---|
| 页面在前台（SSE 正常握手） | **0 条**（数据/持仓照常渲染） |
| 页面在后台 / 流不吐帧（拿不到可见性） | 1 条/套，**~10 秒**时才发（原来是 0.5 秒） |

⚠️ 后端自己那条「打开页面就补账」（`wakeOnView`，>60s 才补）**没动** ——
   新鲜度还是靠它 + SSE 推；前端这一下只是**不重复**打了。
⚠️ 挂单那下必须带 `silent`：不带就会每 20 秒闪一次「正在查询挂单…」。

### P3 · 后端对前端接口**一个闸都没有** → 权重预算 + 单飞 + TTL

限流按**出口 IP**算，而一台服务器只有一个出口 IP 给所有用户用。
新增 `backend/src/util/rate-budget.ts`：滑动窗口，默认 **1200 权重/分钟**
（币安是 2400，故意留一半给 K 线底座的灌历史/回补、行情 REST 兜底、划转那些路径）。

| 调用点 | 记多少权重 | 理由 |
|---|---|---|
| 账户快照（`fetchExchangeOverview`） | 15 | account + positionRisk + sapi |
| 持仓（`getPositions` 的 REST 兜底） | 5 | positionRisk |
| 查挂单 **不带** symbol | **40** | ⚠️ 2026-10-06 把 IP 打进 `-1003` 的元凶 |
| 查挂单带 symbol | 1 | |
| 成交历史 | 5 | userTrades |
| 清理残留单（不带 symbol） | 40 | |

另外两层去重（都在 `position-cache.ts`）：
- **TTL**：常驻流在跑 → 内存快照可信 90 秒；没在跑 → REST 结果缓存 5 秒
  （多个轮询器合成一发）；
- **单飞**：同一 key 并发进来只有一发真的出去。

⚠️ `?fresh=1`（下单 / 平仓后前端要立刻看到结果）会**两个缓存都跳过** ——
只跳内存那份的话还会被 5 秒的 REST 缓存挡住。

### P4 · 未实现盈亏没有行情参与 → 标记价流 + 本地重算

`ACCOUNT_UPDATE` **只在余额/仓位结构变化时**来，标记价波动**不触发它** ⇒
改造前「持仓和未实现盈亏」在两次事件之间是**冻结的**。

现在（`kline-stream.ts` 的 `subscribeMarkPrice`，复用**同一条**上游 `/market` 连接）：
```
只订有持仓的币  {sym}@markPrice@1s   ← ⚠️ 别订 !markPrice@arr@1s（全市场，每秒几十 KB）
        ↓ 1s 一跳，攒 MARK_BATCH_MS=1s 合并
withMark()  (标记价 − 开仓价) × 数量 × 方向 → 未实现盈亏 / 名义价值 / ROE
        ↓
publishLive(..., live: true) → SSE positions → 前端 1 秒级跳
```

⚠️ **口径**：这是**展示口径**；`positionRisk` 回的 `unRealizedProfit` 才是对账口径。
算法一致（差只差取哪个时刻的标记价），REST 快照一到就把整份盖掉（`live: false`），
不累积误差。**拿不到标记价就不重算**（退回 REST 口径），所以这一路挂了只会「不跳」，
不会算错 —— 跟 K 线那条「上游收不到就退 REST」是一个思路。

### 改造后的刷新节奏（全景）

| 层 | 频率 | 打交易所? |
|---|---|---|
| 标记价 WS（有持仓时） | 1 秒/币 | ❌ |
| SSE `positions` 推送 | 标记价 1 秒合并一批；REST 快照后也推 | ❌ |
| 前端兜底轮询（`positions.ts`） | 60 秒，且 SSE 30 秒内有动静就跳过 | 是（但后端命中缓存） |
| **账户界面兜底刷新** | 20 秒看一眼；**流活着就一次都不刷**，流断了才按 90 秒的节奏刷 | 只在流断时（25/次） |
| 账户界面兜底**重读本地那两份**（2026-10-06 补） | 20 秒（同一拍里）：**挂单**（存库）+ **仓位历史**（本地推） | ❌ 读我们自己的库 |
| 账户界面换 tab 重拉 | 挂载/切 tab（`parts` 保留，切回来秒开）；切到挂单 / 仓位历史 / 成交 **各重读那一份** | ❌ 读库 |
| K 线叠加：挂单 / 成交 | **事件**（SSE `orders` / `fill` / `health` / `reconnect`，去抖 250ms + 最小间隔 700ms；另有「SSE 也断了」时跟持仓兜底那一拍） | 是（1 + 账本读） |
| K 线叠加 账户级盘点 | 300 秒（跨标签页 localStorage 节流） | 是（40/条） |
| 常驻流：`ACCOUNT_UPDATE` → 快照 | 20 秒节流 | 是（25/次） |
| 常驻流：**曲线写点** | 300 秒 | ❌（0 权重，用内存那份算） |
| 常驻流：**REST 校准** | 3600 秒 | 是（25/次） |
| **快照归档**（`exchange-archive.ts`） | 3600 秒 + 启动时一次 | ❌ 只碰库 |

**每套 key / 分钟的权重**（估）：闲置 **~5** → 边看边用 **~50** → K线+资产页+频繁成交 **~120**。

### P5 · 快照**无限长** + 稳态最大那一路（同一天补的）

**① 归档 + 保留**：`exchange_snapshots` 原来**没有任何清理** —— 实测单行 ≈ 1.2 kB、
一套一天 288 行 ⇒ **128 MB/年/套**，100 套 12 GB/年。这是这套设计里唯一会随时间无限涨的。
现在 `exchange-archive.ts` 按 doc 定的分档收拾：

| kind | 来源 | 保留 | 稳态行数/套 |
|---|---|---|---|
| `5m` | 原始采样 | 7 天 | ~2000 |
| `1h` | 5m 聚合 | 90 天 | ~2160 |
| `1d` | 1h 聚合 | 永久 | 365/年 |

⇒ 稳态 ≈ 5.5 MB/套，之后只剩 **0.44 MB/年/套**。
（`npm run archive` 可以手动跑一轮；服务每小时自己跑。）

⚠️ 三条不能改的规矩（都踩过）：
- **只聚合「完整的桶」**：判断条件是**桶结束时间** ≤ 截止点，不是 `taken_at < 截止点`。
  否则边界那个桶会被「半截数据」聚合进去，而 `ON CONFLICT DO NOTHING`
  会让这条半截的**永远留着、再也修不回来**。
- **INSERT 与 DELETE 用同一段谓词**：删掉的必须正是刚聚合过的行。
- **`GROUP BY` 里把桶表达式原样写一遍**，不能写序号 ——
  SELECT 列表里那个 kind 常量自己占一列，序号会让桶表达式被漏掉（报 taken_at 不在 GROUP BY 里）。

⇒ 三档的**时间区间互不重叠**（聚合完就删低档），所以 `listCurve` 直接
`kind IN ('5m','1h','1d')` 一锅端再分桶，不用判断「这段读哪一档」；
区间带取的是**存下来的 `high`/`low` 列**（1h/1d 行是整桶包络，现算会抹掉）。

**② 兜底刷新收敛**：「整份快照超 90 秒就刷」原来是稳态最大的一项
（25 权重/套/90 秒）。但**持仓/未实现盈亏已经由 SSE 秒级推了**（那才是当初要修的），
所以改成 **SSE 还活着就不刷**（心跳 20 秒一次，3 拍没来才算死）。
稳态下这一项归 0，只在流真断的时候才兜底。

### ⚠️ 别改坏的地方

- **REST 仍是对账口径**：`withMark` 只影响展示，别拿它去回写库 / 做结算。
- **标记价只订持仓币**：订 `!markPrice@arr@1s` 会把带宽和解析全打满。
- **`publishLive` 是唯一写入口**：别在别处直接改 `states`，否则前端几处又会对不上。
- **预算必须全局**（按 key / 按用户分就失去意义了）—— 因为限流是按 IP 的。
- **等待不能放进串行链里**：一放进去，一个等额度的调用会把后面本来够额度的也堵住
  （第一版就是这个问题，`rate-budget.ts` 里已改成链外轮询）。

## 13. 2026-10-06 第二轮：统一数据源（订单 / 成交 / 盈亏 / 资金费）

用户四个问题，**根因是同一件事**，所以是一次改造：

| # | 用户看到的 | 真实原因 |
|---|---|---|
| 1 | 减仓了，「最近成交」里没有 | 成交只靠 WS 落库，而 **REST 对账只在重连时跑一次** ⇒ 丢一笔就永久漏（实测漏掉 `959680406`，已实现 −0.1299，账本 −0.0211 vs 交易所 −0.1510） |
| 2 | 止盈止损单不在「挂单」里 | 账户页和 K 线页用了**两个不同的取数方**：账户页走 `fetchOpenOrders`（只拉普通挂单），K 线页走 `listOpenOrders`（普通 + Algo 条件单）。币安把 `STOP_MARKET`/`TAKE_PROFIT_MARKET` 搬到了 `/fapi/v1/openAlgoOrders` |
| 3 | 「盈亏」怎么算的 | 只把 `fills.realized` 加起来（**毛数**），手续费 / 资金费根本没算 —— 但 tooltip 却写着「手续费/资金费也算在里面」 |
| 4 | 资金费算吗 | 算，在 `/fapi/v1/income` 的 `FUNDING_FEE` 里；本地账本当时**一条都没有** |

### ★ 根因：**对账窗口太窄**（不是「WS 哑了」）

真正的机制是：成交**只在**「连上 / 重连」时补一次，起点是「账本里最后一笔」。
于是只要有一笔事件丢了（丢的原因好几种，见 §5），**这一笔就落在窗口之外**，
而且它的时间戳比最后一笔更新 ⇒ 以后每一轮都从它后面接，**永远扫不到它**。

⚠️ 我中间误判过一次，记在这里免得再走一遍：「`open` 会触发、`error` 不报、
但零帧」当时被我当成假 IP。**这是错的** —— 加 `ws.on('ping')` 之后立刻收到
`WS 收到第 1 个 ping（连接是活的）`，流本来是好的，空闲期零数据帧才是常态。
真正要修的是**对账窗口**，跟流死活无关。

⇒ 所以改法的核心是：**定期**用 REST 对账（那一轮的节奏是 60 秒；现在是 4 / 6 / 8 小时，见 §24），窗口取「24 小时」和
「账本最后一笔」里**更早**的那个。这样即使某一笔事件丢了，下一轮也会把它捞回来。

### 改法一：REST 定期对账（止损）

`backend/src/exchange-stream.ts`：

- **成交**（`fetchMyTrades`，权重 5/币）：每 **4 小时**一轮（空转档 8 小时），起点取
  「**24 小时安全窗口**」和「账本最后一笔」里**更早**的那个
  （⚠️ 只看最后一笔会**跳过错单** —— 漏的正是账本里没有的那笔）。
  ⚠️ 一轮只覆盖 **≤8 个币**（`symbolsToBackfill()`：账本里最近 30 天有成交的**按最后成交倒序**取前 8，
  再并上当前持仓 —— 两者**共用**这 8 个名额，所以「开了仓但 30 天内没再成交过」的币可能被挤出去、
  那一段仓位周期就画不出来；8 这个数的来历与代价见 `BACKFILL_MAX_SYMBOLS` 的注释）。
- **钱账本**（`/fapi/v1/income`，**权重 30**）：每 **8 小时**一轮（空转档 16 小时），回看 7 天。
  两个水位初值都置 `0`，让第一轮 tick（30 分钟后）就把两边各对一次。
- **每个币单独 try/catch**：以前一个币抛错（如某币下线回 `-1121`）整轮中止，
  后面的币全不补 —— 一个坏币能拖死整本账。
- 成交落库时**顺手写一份钱账本**（`realized` + `-fee`），所以成交那一轮
  顺带把「盈亏」也刷新了；10 分钟那轮只负责补 `FUNDING_FEE` / `TRANSFER`
  这类**成交里没有**的。

### 改法二：去重键必须**两条写入路算得一样**

⚠️ **币安 `income` 的 `tranId` 跟成交号不是同一个东西**
（实测：成交 `959680406` 对应 `tranId = 95850959680406`），
但它的 `tradeId` 字段才是。第一版按 `tranId` 去重 ⇒ 同一笔钱记两遍，
手续费 27 条变 54 条、已实现 −0.1510 变 −0.3020（正好两倍）。

⇒ 统一走 `data/exchange-trade.ts` 的 `incomeDedupeKey()`：
成交类用 `tradeId:资产`，其它类用 `tranId:资产`（带资产 = 防止 BNB 抵扣那种一拆二）。

### 改法三：挂单 / 成交都收敛到一个取数方

- **挂单**：删掉 `exchange-account.fetchOpenOrders`（那份看不到条件单），
  账户页 `/api/exchange/open-orders` 改用 `listOpenOrders`
  （普通 + Algo，⚠️ 不带 symbol 时必须显式 `subType: 'linear'`，
  否则条件单那一路**静默回空数组**）。字段一并带全 `stopPrice`/`posSide`/`reduceOnly`。
- **成交**：`/api/exchange/trade/history`（K 线买卖点）改**读账本**
  （`listFills` 加可选 symbol 过滤），弃用 `listUserTrades` ——
  一个账户的成交**只有账本一份**，不再出现「K 线有、账户页没有」。

### 改法四：「盈亏」= **仓位历史**（用户最后定的口径）

> 「盈亏界面不是统计数据，是每笔仓位的概念 —— 开仓到结仓中间的盈利，
>  发生减仓的不算在盈亏中统计、全平仓的概念，像币安的仓位历史那样，
>  包括币种 / 盈利 / 开仓均价 / 平仓均价 / 开平仓时间 / 持仓时间，
>  点击还可以查看详情包括每笔订单信息，减仓的要有实现盈利」

⇒ `backend/src/data/position-history.ts`：把**成交账本**按币种还原成一段段
**仓位周期**（0 → 有量 → 回 0），减仓不单独算一笔、其已实现归到整段头上，
同时逐笔留在 `orders` 里。接口 `GET /api/exchange/position-history`
（**纯本地读**，不打交易所）。

不变量（已对真账户断言过）：
- 全平的段 `closedQty == qty`；
- 每段 `Σorders.realized == realized`、`Σorders.fee == fee`；
- **所有段的净合计 == 账本 `Σrealized − Σfee`**（实测 −0.415870 == −0.415870）。

⚠️ 两个边界：
- **账本不全**：币安 `userTrades` 的**单次请求窗口上限是 7 天**（数据保留 3 个月），
  所以第一笔就是平仓的那种段
  标 `partial`（开仓均价给 `null`，不编数）。返回里有 `since`，界面上写明。
- **未平的单独一组**（`open`）：不能混进「已平」里（盈利会忽上忽下），
  但必须看得到 —— 用户还要「减仓的要有实现盈利」，而减仓就发生在未平那一段里。
- **反手**（一笔打过 0 直接变反向持仓）会把这一笔按量拆开，已实现 / 手续费按
  落在本段的比例分摊。

### 改法五：SSE 说「上游哑了」

`streamAlive`（我们这条 SSE 的心跳）**不等于**上游在推数据。
所以后端加了健康检查（`checkHealth`，**4.5 分钟**内连 ping 都没有 ⇒ `deaf`；
阈值必须大于币安的 3 分钟 ping 周期，否则安静期会误报），
经 SSE `health` 事件告诉前端；前端只有收到 `deaf` 才恢复自己 REST 兜底。
⚠️ **别把这一条去掉**：去掉之后「SSE 活着就不刷」会把用户最早那个
「开仓半天界面没数据」重新带回来。

### ⚠️ 别改坏的地方（第二轮）

- **`tran_id` 列存的是 `incomeDedupeKey()` 的结果，不是币安原值。**
- **income 接口权重 30**：别跟着成交对账那一轮一起跑。
- **交易接口的 `symbol` 允许 ccxt 写法**（2026-10-07 修的坑）：前端有**两套符号**在跑
  —— 币安原始符号 `1000000MOGUSDT`（`/fapi`、本地合约表）和 ccxt 统一符号
  `1000000MOG/USDT:USDT`（持仓快照 / 图表）。持仓卡上那颗「平仓」发的就是后者，
  而 `specFor()` 只认前者 ⇒ 一律报「币安的合约列表里没有这个交易对」，**平仓 / 减仓
  从账户页点了就是不动**（K 线页那条路走 REST 持仓，拿的是原始符号，所以一直好的）。
  ⇒ `exchange-trade.ts` 里收口成 `rawSymbolOf()`（`BTC/USDT:USDT` / `BTC/USDT` /
  `BTCUSDT` / 小写 → `BTCUSDT`），下单 / 平仓 / 减仓 / 止盈止损都过它。
  ⚠️ 这条路上都是钱，**别在调用方各转各的**，就守这一处。
- **一键平仓别在前端逐条报符号平**：`closeTradePositions()` **不传 `symbol`** 就是
  后端那条「把这个账户里所有持仓全平」（自己从交易所读持仓，原始符号 + 双向持仓的
  `positionSide` 都对）。前端逐条平会因为上面那个符号坑 + 双向持仓而漏。
- **仓位历史读的是账本，不是 income** —— income 只用来给持仓卡的「已实现盈利」供数。
- **`/api/exchange/position-history` 不打交易所**：它是纯本地推导。

### 2026-10-06 补：点开交易所页面「挂单要等 2 秒」

实测（真账户、经出口隧道）：

| 调用 | 耗时 |
|---|---|
| 冷（新 ccxt 实例，要 `loadMarkets`：`exchangeInfo` + `currencies` 两条 1.5MB） | **3.3 ~ 10.5 秒** |
| 热（实例已缓存）单套 | 0.7 ~ 1.2 秒 |
| 命中缓存 | **3 ~ 10 毫秒** |

2 秒 ≈ 两套账户**串行** × 每套一个来回。三处一起改：

1. **`createExchange` 过期不再重建实例**：TTL（30 分钟）到了照样把**同一个实例**交出去，
   只把重下 markets 放到**后台**（`refreshing` 集合防并发重复刷）。
   ⇒ 干掉「每 30 分钟一次十几秒」那个尖刺。过期只是 markets 可能旧了，
   而挂单 / 持仓 / 下单几乎不依赖它。
2. **挂单走 stale-while-revalidate**：手上有旧的（哪怕刚过期）就**立刻回** + 后台刷一发，
   响应带 `stale: true`；前端拿到 `stale` 过 1.2 秒再问一次（那时命中缓存）。
   TTL 也从 10 秒放宽到 **30 秒**（挂单是用户自己动手才变的，写操作都会 `bump()`）。
3. **前端几套账户并发拉**，不再串行。

结果：首次 ~0.7-1.2 秒（真实交易所往返，躲不掉），**之后每次点开 3~10 毫秒**。

### 2026-10-07 补：ccxt 的 `markets` **落库复用**（用户：入库 / 每天一次 / 认不出再调一次）

`markets` 就是币安 `GET /fapi/v1/exchangeInfo` 那份**合约规格表**（约 1.1MB：符号 +
`tickSize`/`stepSize`/`minQty`/`minNotional`）。ccxt 每个实例保一份、**只在内存**，
于是**每次进程重启都要重下**；而 `fetchOpenOrders` / `createOrder` 这些方法内部第一步
就是 `loadMarkets()` —— 它一坏，挂单 / 持仓 / 下单全线坏。

两处坑（都实测踩到）：

1. **下载比超时长**：经隧道 1.14MB 要 25.6 秒（带 gzip 4 秒），ccxt 默认 10 秒 ⇒ 必超时。
   ⇒ 这份下载单独给 30 秒（`MARKETS_TIMEOUT_MS`），业务请求仍是 10 秒。
2. **ccxt 把失败也缓存**：`loadMarkets()` 只在 `marketsLoading === undefined` 时真下载，
   失败后**不清**这个字段（`ccxt/.../Exchange.js:1277`）⇒ 一次超时之后这个实例
   **每次调用都毫秒级失败**，报的还是第一次那句超时。症状：K 线上一条挂单线都没有、
   「我的」页完全不刷新、**仓位被止损掉了还挂在那儿**。⇒ 失败必须清 `marketsLoading`。

方案（`data/ccxt-markets.ts` + 表 `ccxt_markets`）：

- 建实例时把库里那份 `setMarkets()` 灌回去 ⇒ **冷启动 0 网络**（实测预热从「下 25 秒 / 失败」
  变成秒级完成）；`data/market.ts`（行情那条）共用同一份。
- 成功下载一次就 `JSON.stringify(ex.markets)` 落库（JSONB，实测约 200KB）；
  `MARKETS_TTL_MS = 24h` 过期才在后台重下（用户：「每天轮询一次」）。
- **认不出的符号**（`BadSymbol` / `does not have market`）⇒ 立即重下一次再重试同一件事
  （用户：「认不出来再调一次」）。⚠️ 重下必须 `loadMarkets(true)` —— 不传参数 ccxt
  直接返回现有 markets，等于没重下（我第一版就写了 `loadMarkets()`，实测是个空操作）。
  同一个 key 的并发重下**只跑一发**（`inflight`），不然条件单那一路会各下一份。
- ⚠️ 键是 `交易所|市场类型|环境`（**不带 apiKey**，这是公开数据）：
  沙盒（demo）的规格跟线上不一样（BTCUSDT `stepSize` demo 0.0001 / 线上 0.001），
  所以 demo / live / 自定义 apiBase 各存一份。

### 2026-10-06 补：条件单那一路**不能再静默吞错**

`listOpenOrders` 里原来两条都是 `.catch(() => [])`。经隧道时条件单那一路会**超时**，
于是「取不到」被写成了「账户里一条条件单都没有」—— 跟真的没有**长得一模一样**
（这正是用户「止盈止损单不在挂单里」的另一半原因，另一半是账户页压根没调这个接口）。
现在改成 `Promise.allSettled`：单边失败**记日志**，两边都失败才抛。

### 2026-10-06 补：字段名错位会让 `NaN` 变成 `$0.00`

`IncomeRow` 后端回的是 `amount` / `datetime` / `incomeType`，前端类型那会儿写的是
`income` / `time` / `type` —— 直接 `Number(undefined)` = **`NaN`**，
而 `signedMoney(NaN)` 渲染出来是 **`+$0.00`**，看着像「没赚没亏」，其实是算错了
（持仓卡上的「已实现盈利」就这么错过一次）。
⇒ 前端类型**逐字对齐**后端返回，不再在中间起小名。

## 14. ⚠️⚠️ 2026-10-06 根因：BIGINT 的 key 类型不一致 ⇒ 实时事件**全部静默丢弃**

这是「持仓盈利不实时」「最近成交不实时」「开仓半天界面才有数据」**共同的根因**，
前面几节都只是在兜底，没修到它。

### 症状（极有迷惑性）

- SSE 连上时 `open` / 连接底稿 `snapshot` **一切正常**；
- 之后**所有**实时事件（`positions` / `fill` / `income` / `backfill`）**一条都收不到**；
- 浏览器控制台反复 `net::ERR_ABORTED` + 自动重连（看着像「连上了但没数据」）；
- 服务端日志里 `subscribeExchange 加完=3` 和 `[emit] 订阅者=0` **同时出现**；
- `[...map.keys()].join(',')` 打印出 `7`，`emit` 查的也是 `7` —— 但查不到。

### 根因

| 位置 | 代码 | 运行时值 |
|---|---|---|
| SSE 路由 | `db/exchange-keys.ts` 的 `id: Number(r.id)` | **数字** `7` |
| 常驻流 | `exchange-stream.ts` 的 `listKeys()` 直接用 `query()` 的行 | **字符串** `'7'` |

`user_exchange_keys.id` 是 **BIGSERIAL（bigint）**，`pg` 为了不丢精度把 bigint 返回成
**字符串**。于是 `subscribeExchange(7)` 往 map 里写的是**数字键**，
而 `emit(this.row.id)` 拿着**字符串**去 `get()` —— 永远 miss，
`if (!set?.size) return` 就把事件丢掉了。

⚠️ **`7` 和 `'7'` 用 `console.log` / `join(',')` 打印出来一模一样**，
所以日志看着像「key 在、订阅者却是 0」，靠肉眼看日志基本不可能发现。

### 改法

- `exchange-stream.ts` / `position-cache.ts` 各加一个 `keyOf(keyId) => Number(keyId)`，
  **在 map 的收发两层统一兜住**（不指望调用点传对类型 —— 调用点太多，迟早漏）；
- `listKeys()` 也显式把 `id` / `user_id` 转成数字，别让 `KeyRow.id: number` 这个类型说谎；
- `position-cache.ts` 的 `states` / `streamActive` / `rowsCache` / `inflight` 是**同一个 bug**
  （所以 `positions` 事件也全军覆没），一并走 `keyOf`。

### 教训

**跨模块用 Map 传事件时，键的类型必须归一，而且要在边界处归一。**
`kline-stream.ts` 那条路一直没事，就是因为它的键（`symbol|timeframe`）两边都是字符串。

### 顺手加的诊断（都留着）

- `ORDER_TRADE_UPDATE` 每条打一行（`s`/`x`/`X`/`t`/`l`）—— 以前丢单时**没有任何证据**；
- 上游帧 `JSON.parse` 失败**不再静默 return**（经隧道时帧会被截断，跟「没收到」长得一样）；
- SSE 连接**只活了 <3 秒**就打一行警告（异常拆连接的特征）；
- 交易所流的 `handleExchangeStream` **自己 catch 并打栈**：它跑在 `writeHead(200)` 之后，
  中途抛错会让通用 catch 去发 500，而那一下自己会再抛 `ERR_HTTP_HEADERS_SENT`，
  真实错因被埋掉，外面只看到「连上了就断」。

### 另外两件事（同一天）

1. **标记价补了 REST 兜底**（`kline-stream.ts` + `market.ts` 的 `fetchMarkPrices`）：
   原来只有 K 线 / 行情条有「上游哑了退回 REST 轮询」，标记价没有 ——
   上游 WS 一哑，未实现盈亏就**完全不动**，只能等 5 分钟采样。
   现在 6 秒没标记价就每 3 秒拉一次 `/fapi/v1/premiumIndex`（**不带 symbol 一次拿全市场**，
   权重 10：这一路的成本几乎全在往返上，一个来回比 10 个权重贵得多）。
2. **`req.on('close')` 在 SSE 里是错的**：Node 16 起它在**请求收完**就触发（GET 立刻），
   会把刚建好的 SSE 当成「客户端走了」收尾。三处 SSE 全改成只听 `res.on('close')`。
   （这条**不是**本次的主因，但它是同一类「连上就断」的坑，留着迟早踩。）

## 15. 用户不在线时，数据照样在更新（2026-10-06 用户问）

**结论：更新是后端**常驻进程**做的，跟有没有人开着页面无关。**
SSE 只是「把已经算好的东西推给正在看的人」——`emit()` 在没有订阅者时直接 return
（`if (!set?.size) return`），而**写库和写内存都发生在 `emit` 之前**，一件都不少。

进程里跟浏览器无关的常驻任务：

| 周期 | 干什么 | 在哪 |
|---|---|---|
| 常驻（WS） | 用户数据流：成交 / 账户变动；**持仓币的标记价**（未实现盈亏逐笔重算） | `exchange-stream.ts` |
| **25 分钟** | listenKey 续期（币安 30 分钟过期） | `KEEPALIVE_MS` |
| **30 秒** | 用户数据流健康检查（连 ping 都没有 4.5 分钟 ⇒ 标记降级） | `WS_HEALTH_MS` |
| **5 分钟** | **曲线写点**（内存那份就地算，**0 权重**，`source='live'`） | `SAMPLE_MS` |
| **30 分钟** | 兜底对账的 tick（只判断「到点了吗」，**本身不打交易所**） | `RECON_TICK_MS` |
| **1 小时** | REST **校准**（钱包 / C2C / 现货 / 可用余额 / 资产明细 —— 只有 REST 有的那几项） | `SAMPLE_CALIBRATE_MS` |
| **1 小时** | 快照归档 5m→1h→1d + 清理 | `exchange-archive.ts` |
| **4 小时** | REST 对账**成交**（24 小时安全窗口，每币单独 try/catch，**≤8 个币**） | `FILL_RECONCILE_MS` |
| **6 小时** | REST 对账**挂单**（普通 + 条件单，40 权重） | `ORDERS_RECONCILE_MS` |
| **8 小时** | REST 对账**钱账本**（`/fapi/v1/income`，含资金费，权重 30） | `INCOME_RECONCILE_MS` |
| **3 秒**（按需） | 上游 WS 哑时退回 REST：K 线 / 行情条 / **标记价** | `kline-stream.ts` |

> ⚠️ 4 / 6 / 8 小时那三条是 **normal 档**的值：**空转档 ×2**、
> **睡着档全停**（只有 1 小时的 REST 校准照跑）。判据与分档表见 §17 / §18 / §24。

用户回来时看到的是：SSE 一连上先发**底稿**（库里最新快照，毫秒级），
然后立刻接上实时事件；前端还有一层陈旧检测，数据太旧会主动刷一次。

### 补的一个缺口：新开仓后最多 5 分钟盈亏不动

`syncMarks()`（给持仓币订标记价）原来**只在 `snapshot()` 里调**，而快照 5 分钟一次。
⇒ 新开一个仓之后，那 5 分钟里**那个币根本没订标记价**，盈亏停在开仓那一刻
（有人看没人看都一样，跟「在线」无关）。
币安的 `ACCOUNT_UPDATE` 本来盖得住，但它跟成交事件一样会丢 ⇒ 现在用
**「有成交落地」当触发器**（`resyncAfterFill()`，WS 和 REST 补成交两条路都挂），
走 `snapshot('ws')` 自带的 **20 秒节流**，一笔笔连着来也只打一发（权重 25）。

## 16. 挂单改成「存库 + 变动时改」（2026-10-06，用户提的）

用户原话：**「挂单不是秒级查询啊，有变动才改，其余存库不就行了」** —— 对。
我原来那句「挂单是秒级变化的东西，不适合存下来」是偷懒的说法：
**变动**由币安经用户数据流主动推（`ORDER_TRADE_UPDATE`），根本不用轮询。

### 原来那套的代价

| 问题 | 原因 |
|---|---|
| 点开账户页等 **2 秒** | 每次现查，一个来回经隧道 0.7~1.2 秒，两套账户串行 |
| 一次 **40 权重** | 不带 symbol 查挂单就是 40（带 symbol 才 1），全服务器共用一份预算 |
| 别的 tab / 页面看不到 | 谁想看谁再打一次 |

### 现在

```
WS ORDER_TRADE_UPDATE ──(秒级，变动才动)──┐
                                          ├──► exchange_open_orders（库）
REST 对账（连上/重连 + 每 6 小时，40 权重）┘        │
                                                    └──► SSE `orders` → 前端重读（本地，毫秒级）
```

- 新表 `exchange_open_orders`（`unique(key_id, order_id)`，幂等）；
- `X = NEW / PARTIALLY_FILLED` → upsert；`FILLED / CANCELED / EXPIRED / REJECTED` → 删；
  **只有真的改了才推 SSE**（部分成交那种高频事件不会把前端刷爆）；
- `replaceOpenOrders()` 整体替换时**先插/更新再删没见到的**，绝不能先 `DELETE` ——
  中途失败会留下一个空列表，界面上就成了「一条挂单都没有」（比旧数据糟得多）；
- **写操作之后主动对一次**（`reconcileKeyOrders`）：刚下的单理论上几百毫秒内会经 WS
  落到库里，但不能只靠它（WS 丢事件今天已经抓到实证），所以下单/撤单/清理后主动对一次，
  界面才是确定的 —— 一发 40 权重，只在用户真的动手时发生。
- 前端收到 `orders` 事件重读一次：**本地读，零权重**，所以可以放心收一条刷一次。

### 实测

| | 之前 | 现在 |
|---|---|---|
| `/api/exchange/open-orders` | 731ms（冷）~ 1177ms/套 | **5 ~ 10ms**（`source=db`） |
| 两套账户点开 | ~2 秒（串行） | 毫秒级 |
| 条件单 | 时有时无（Algo 那一路会静默吞错） | `TAKE_PROFIT_MARKET` / `STOP_MARKET` 都带 `stopPrice` |

⚠️ 顺手删掉了 `openOrdersCache`（TTL + SWR 那套）：挂单不再现查，它就没用了；
写操作原本 `bump()` 它，改成 `reconcileKeyOrders()`。

## 17. 空转降频：闲置账户别跟交易中的账户花一样多（2026-10-06）

用户问「你的意思是后端一直在和币安链接，如果长时间没有仓位或者用户不在线呢」——
问到了点子上。**权重是按出口 IP 算的**，一台服务器所有用户共用 2400/分钟，
而原来那几个定时器是**每套 Key 都跑、不管有没有仓位、不管用户上没上线**：

| 任务 | 周期 | 权重 | 空转时 /分钟 |
|---|---|---|---|
| 挂单对账 | 2 分钟 | **40** | **20** ← 最大（2026-10-06 加挂单对账时引入） |
| 钱账本对账 | 10 分钟 | 30 | 3 |
| 全量快照 | 5 分钟 | ~21 | 4.2 |
| 成交对账 | 60 秒 | 5/币（≤8 个币） | **≤40** ← 见下面那条更正 |
| 标记价流 | 1 秒 | 0 | **0**（无持仓时全部退订） |
| 合计 | | | **≈67 权重/分钟/套** |

⇒ **约 36 套闲置账户就能把整个出口 IP 的额度吃光。**
一个几个月没登录、没有任何仓位的账户，不该跟一个正在交易的账户花一样多。

> **⚠️ 更正（第三节审计时发现）**：这一版最初写「成交对账空转时 = 0」是**错的**。
> `symbolsToBackfill()` 取的是**账本里最近 30 天交易过的币**（不是「当前持仓」），
> 所以一个「昨天交易过、现在空仓」的账户照样会逐币查，**≤40 权重/分钟**，
> 比挂单那 40/2分钟 还高一倍。漏了它，整个「空转」就算不出真实收益。

### 改法：按空闲程度分档（现在一共三档）

`isIdle()` = **没持仓 + 没挂单 + 最近 10 分钟没动静**；再往上加一段
`HIBERNATE_MS`（2 小时）就是「睡着」。三档的判据集中在 `tierOf()` 一个纯函数里。

`lastActivityAt` 只在**账户里真的发生了什么**时才刷新：WS 数据帧、`ORDER_TRADE_UPDATE`、
新记进来一笔成交、挂单集合真的变了、用户下单 / 订阅。**我们自己发起的那一发轮询不算！**

> ⚠️⚠️ 这一条是被**实测**逼出来的（2026-10-06）：原来 `snapshot()` 每轮都会把
> `lastActivityAt` 顶到「现在」，而采样定时器 5 分钟就采一次
> ⇒ `Date.now() - lastActivityAt` 永远 < `IDLE_MS`（10 分钟）
> ⇒ **空转那一档从来没生效过**（`f94cd99` 那个 commit 是空转的），
> 用户问的「长时间没有仓位呢」正好戳在这个洞上。
> 自己问自己「有没有动静」，答案永远是有。

| | normal | idle（空转） | asleep（睡着） |
|---|---|---|---|
| 成交对账 | **4 小时**（5/币，≤8 个币） | **8 小时** | **停** |
| 挂单对账 | **6 小时**（40 权重） | **12 小时** | **停** |
| 钱账本对账 | **8 小时** | **16 小时** | **停** |
| REST 校准（快照 / 余额） | **1 小时** | **1 小时** | **1 小时**（照跑） |
| 私有 WS + listenKey | 连着 | 连着 | **照样连着** |
| 合计 | ≈**0.8** 权重/分钟/套 | ≈**0.6** | ≈**0.4** |

> ⚠️ 这张表**改过三轮**：最初 60 秒 / 2 分钟 / 10 分钟（合计 ≈67）→ 第 19 节收到
> 5 / 10 / 30 分钟 → 最后按「各条自己的冗余度」定成 **4 / 6 / 8 小时**（见 §24）。
> 下面「降频降的是对账、不是实时性」那段理由**一直成立**，没变。

⚠️ **降频降的是「对账」，不是实时性**：私有 WS 和 listenKey 一直连着，
所以空转账户突然来一张新挂单 / 新成交，币安经 `ORDER_TRADE_UPDATE` 推过来还是秒级，
`syncOrderFromEvent` 立刻落库 + 推 SSE。REST 对账只是「防丢事件」的兜底。
状态翻转时打一行日志，不然「到底有没有在降频」完全看不见
（文案由 `tierText()` 现算：数字**直接从 `TIER_GAPS` 取**，不再手抄 ——
2026-10-07 之前手抄过两版，一版写「降频到 30 分钟一轮」、另一版写「对账全 1 小时」，
全过时了。日志样例见下一节的实测那段，那里的文案是**当时的**）。

### 还没做、但该考虑的（规模上来之后）

1. **完全离线就停流**：现在登录过、配了 Key 的账户，进程一启动就常驻连接
   （币安对 WS 连接数有限制：300 次/5 分钟/IP）。真到几百套时应该按
   「最近有没有人看 / 有没有仓位」决定要不要起流，停了之后靠一次全量对账追平。
2. **错开启动**：`startExchangeStreams` 现在 `await sleep(1000)` 串行起流
   （币安的连接限速），几百套时启动要几分钟 —— 应该只给「活跃」的先起。
3. **快照写入量**：5 分钟一条 × 套数，虽然归档（5m→1h→1d）已经做了，但
   全空转账户的曲线其实是直线，可以合并得更狠。

---

## 18. 沉睡档：用户不在线就别管合约和订单，但**余额照管、曲线不能断**

（2026-10-06，用户原话：「我能够接受长时间用户不在线就不用管和合约和订单，
余额要管要做曲线图」）

### 判据：`isAsleep()`

**已空转**（`isIdle()`）**+ 连续 `HIBERNATE_MS`（2 小时）没动静**。

> ⚠️ 2026-10-06 修正：这一档最初还要求「**没人订阅**」，后来被用户否掉了 ——
> 在线的实时性由 WS 推送保证，不需要 REST 提速，所以「有没有人在看」**不参与分档**。
> 见第 19 节。

### 睡着了之后

| | normal | idle（空转） | **asleep（睡着）** |
|---|---|---|---|
| 成交对账 | 4 小时 | 8 小时 | **停** |
| 挂单对账 | 6 小时 | 12 小时 | **停** |
| 钱账本对账 | 8 小时 | 16 小时 | **停** |
| REST 校准（快照 / 余额） | 1 小时 | 1 小时 | **1 小时**（余额曲线靠它） |
| 私有 WS + listenKey | 连着 | 连着 | **照样连着** |
| 合计 | ≈0.8 权重/分钟/套 | ≈0.6 | **≈0.4** |

**合约和订单的对账整条停掉**（`reconcileTick` 睡着时直接 `return`，四类水位也**不推进**，
醒来那一轮一次补上），**余额（1 小时的 REST 校准）照采** —— 这就是用户要的那个平衡：
`exchange_snapshots` 是资产曲线**唯一**的源，睡着期间断采，曲线上就会留一段假的空洞；
而余额其实只有资金费（8 小时一次）会动，1 小时采一次已经很富余。

⚠️ **私有 WS 一直连着**，所以「用户在手机上开了仓 / 挂了单」币安照样推过来，
`onOrder` 一进来 `lastActivityAt` 就刷新、账户立刻醒（下一轮 tick 就把三个对账补上）。
**降的是「我们自己主动去问」的频率，不是实时性。**

### 醒来：`wake()`

三个入口：

1. **有人订阅**（`subscribeExchange` → `wakeOnView()`）—— 用户点开账户 / 刷新页面
   （只补「汇总口径 + 曲线」，成交 / 挂单 / 账本**跳过**，因为没有新事件就不会变）；
2. **写操作**（`reconcileKeyOrders`，即下单 / 平仓 / 撤单 / 改杠杆之后）；
3. **手动刷新**（`POST /api/exchange/refresh` → `wakeExchangeStream(…, '手动刷新', {force:true, skipSnapshot:true})`）。

醒来不只是把标志位翻回来：沉睡期间**一笔账都没对**，账户里可能真有过变化，
所以立刻补一轮 **快照 + 成交 + 钱账本（+ 挂单）**，抢在用户盯着屏幕的那一秒钟里对平。
写操作那条路自己紧接着就要对一次挂单，所以给它 `skipOrders`，别白问两遍那 40 权重。

### 冷启动不该把睡着的账户叫醒：`seedActivity()`

`lastActivityAt` 是内存里的，进程一重启就变成「现在」——
一个几个月没人用的账户会重新被当成活跃账户，白跑满 2 小时才肯睡。
所以起流时**只种一次**：取「账本里最后一笔成交」和「这套 Key 的创建时间」里**更晚**的那个
（从没交易过的账户，就是「建完就没动过」）。读不到就当刚有动静，不省这一档。

### 实测证据（2026-10-06）

把几个间隔临时缩到 15~30 秒（验完已还原），日志：

```
[exch:9] 空转（无持仓无挂单）→ 对账降频到 30 分钟一轮
[exch:9] 睡着（空转 + 没人看）→ 成交/挂单/钱账本全停，余额照 1 小时采一次（曲线不断）
[tmp] [exch:9] tick 订阅者=0 空转=true 睡着=true 活动距今=58437s   ← 16 小时 = created_at 播种生效
[exch:9] 快照已写（poll）净资产 14.9200007                          ← 睡着期间余额照采
[tmp] [exch:9] tick 订阅者=0 空转=true 睡着=true 活动距今=58497s   ← +60 秒，没被自己的快照踩回去
[exch:9] 醒（有人订阅）：补一轮沉睡期间可能漏掉的账
[exch:9] 快照已写（poll）净资产 14.9200007
[exch:9] 有动静 → 对账恢复 2 分钟一轮
```

对照：同一次运行里 `[exch:7] tick 订阅者=1 空转=false 睡着=false`
（有 3 个持仓、有人开着页面）—— 两条路各走各的，互不影响。

### 仍然没做（规模再上来时）

1. **真的断流**：现在睡着了也只是不主动问，WS 连接还挂着。真到几千套时，
   连接数（币安 300 次/5 分钟/IP）会成为瓶颈，那时该按「有没有人看」决定要不要连着。
2. **余额采样再拉长**：资金费 8 小时一次 ⇒ 睡着档可以 4 小时采一次，成本再降 4 倍。
   现在留 1 小时是为了曲线在「1 小时桶」上仍然是连续的。

---

## 19. 「只有没数据才请求」：在线不提速 + 手动刷新兜底（2026-10-06）

用户原话（这一轮把口径钉死了）：

> 「用户在线就**没必要频繁对账**，用户感觉不对**可以刷新页面**，移动端做**下滑刷新**，
> 当然不是每次刷新都要请求接口，**要限流节流防抖**」
> 「在线不是有**推送和计算**吗，**只有没数据才请求**」

### 一、撤掉「在线提速」这一档

第 18 节那次我先做成「**有人看 = 全速**（成交 60 秒 / 挂单 2 分钟）」，被否了。
现在的口径是：**在线的实时性由 WS 推送 + 本地标记价重算保证**，REST 对账只是
「怕丢事件」的保险，所以**在线也不提速**。档位只剩三个：

| 档 | 判据 | 成交 | 挂单 | 账本 | 校准（快照 / 余额） |
|---|---|---|---|---|---|
| `normal` | 有仓 / 有单 / 10 分钟内有动静 | **4 小时** | **6 小时** | **8 小时** | **1 小时** |
| `idle` | 无仓无单 + 10 分钟没动静 | **8 小时** | **12 小时** | **16 小时** | **1 小时** |
| `asleep` | 空转 + 2 小时没动静 | **停** | **停** | **停** | **1 小时** |

代码上是**一张表**（`TIER_GAPS`）加一个 30 分钟的 tick（`RECON_TICK_MS`，只判断到点没），
别再散成一堆三元表达式。正常档从当初的 ≈67 权重/分钟/套 降到 ≈**0.8**。

> ⚠️ 这张表也**改过三轮**：那一轮是 5 / 10 / 30 分钟 → 统一到 1 小时 →
> 最后按各条自己的冗余度定成 **4 / 6 / 8 小时**（`idle` ×2、`asleep` 全停）。
> **现在的值以 §24 为准**。

### 二、什么时候**该**请求（「只有没数据才请求」）

| 触发 | 行为 |
|---|---|
| 冷启动（进程起来） | 写一条启动锚点快照 + 连 WS |
| 打开页面（SSE 订阅） | **数据旧了才补**（`FRESH_MS` = 60 秒）；刚被推过 ⇒ **一次都不请求** |
| 用户下单 / 平仓 / 撤单 / 改杠杆 | 立刻对一次挂单（`reconcileKeyOrders`），**这是用户的动作，值得** |
| 用户按 ⟳ / **下拉刷新** | `wake(force)` —— **无视一切降频**，成交 / 挂单 / 钱账本现场全对一遍 |
| 前端自己兜底刷（`auto=1`） | **只拉这一份快照**，不顺手对账 —— 见下面那条「重启风暴」 |
| WS 断线重连 / 上游报「哑了」 | 立刻补一轮（丢事件的时间段必须补） |
| 前端兜底定时器 | 只在**流没活着**或**上游哑了**时才打交易所（`streamAlive` / `deaf`） |

### 二·补、别把「兜底刷一下」也变成一次全量对账（`auto=1`）

第一版做出来就被自己的日志打脸了：一台机器上开着 8 个页面，**服务重启一次**，
每个页面的 SSE 都断 → 前端判定「流没活着」→ 各自自动刷一次
⇒ 日志里瞬间叠出十几发 `补账（手动刷新）`，每发 ≈100 权重。

⇒ 前端自动兜底那条路带上 `auto=1`，后端**只拉快照**，不触发那套「成交 / 挂单 / 钱账本
全对一遍」；**强制补账只留给用户主动那一下**（按钮 / 下拉）。
实测：`auto=1` 不打补账日志，用户手动那一下打（`补账（手动刷新·无视节流）`）。

### 三、下拉刷新（移动端）+ 三道防抖

- 新增 [frontend/src/pull-refresh.ts](../frontend/src/pull-refresh.ts)：页面**在顶部**才接管、
  拖动有阻尼（×0.5，最多 80px）、过阈值松手才触发、**刷新中不接受新的手势**、不抢系统手势
  （不 `preventDefault`）。
- 三道防抖：**前端** 1.5 秒（`MANUAL_MIN_MS`）+ **后端** 3 秒（`FORCED_MIN_MS`）
  + 页面重连那条路 60 秒（`FRESH_MS`）。连点几下不会变成一串请求。

### 四、刷新转圈太久：**4 路并发**（用户：「刷新图标为什么转那么久」）

一次刷新原来是 `account → positionRisk → C2C → 现货` **一路 await 下来**，
经出口隧道实测**串行 ≈1.8 秒**，并发之后 **364ms**：

| 单步 | 耗时 |
|---|---|
| `/fapi/v2/account` | 135ms |
| `positionRisk`（`fetchPositions`） | 459ms |
| C2C `wallet/balance` | 166ms |
| C2C 估值 `fetchTickers` | 308ms |
| 现货 `/api/v3/account` | **710ms** |

四路之间**没有任何依赖** ⇒ `Promise.all`。⚠️ 口径不变：`positionRisk` 失败仍然让整次
刷新失败（不能悄悄当成「没有持仓」）；C2C / 现货读不到只当 `null`，不拖垮整页。
前端多账户那层也改成并发（原来 `for` 一套一套 await，两套就是两个来回叠加）。

> 注：并发**不增加任何一次请求**，只是把「你按下去」那一下的时间砍掉 ——
> 真正省钱的是上面第一、二节（不请求）。

### 五、「资产旁边那个『几分钟前』是什么意思」

> ⚠️ **2026-10-06 这颗标签已经撤掉了**（用户：「净资产…多少秒实时…刚刚更新这些状态去掉」）——
> 下面记的是它当年为什么长那样，`liveAt` / `takenAt` 两个时间戳**仍然算**（合并口径还用它），
> 只是不再往界面上摆。

- 它是**余额快照的采集时间**（`takenAt`），不是「这个页面是什么时候的」：
  持仓 / 盈亏 / 成交走 WS 推送 + 本地标记价，**一秒都在动**；
  那个时间只代表**余额（合约钱包 + C2C + 现货）这几项最后一次问交易所的时间**。
  多账户（「全部」）时取**最旧**的那一份，别报喜不报忧。
- 2026-10-06 改了两处：tooltip 说清楚（并提示可以下拉刷新）；
  变黄的阈值从 **5 分钟提到 35 分钟** —— 因为闲着但健康的账户采样就是 30 分钟一次，
  5 分钟会让它一直黄着，像是在报警。

---

## 20. `ACCOUNT_UPDATE` 里带的数据，原来**一个字都没用**（2026-10-06）

用户贴了币安 U 本位合约的资产实时监控文档问「有用到这个吗」。查下来：
**连接、listenKey、续期、事件分发全都有，但事件里带的数据被丢掉了。**

原来 `onMessage` 里那一支只有一句：

```ts
if (e === 'ACCOUNT_UPDATE') {
  // 余额/仓位变了 → 事件里没有 totalMarginBalance 这种汇总字段，所以拉一次完整的
  await this.snapshot('ws', WS_SNAPSHOT_GAP_SEC)
}
```

也就是把它当**触发器**用，收到就去打一次 REST（21 权重、一个来回 0.5~1 秒）。
而币安这个事件里明明带着：

```json
{"a": {"B": [{"a": "USDT", "wb": "122624.12"}],        // 钱包余额
       "P": [{"s": "BTCUSDT", "pa": "1", "ep": "9000", "up": "0.12"}]}}  // 持仓量/开仓价/浮盈
```

⇒ 成交 / 划转 / 资金费之后，界面得**等一个 REST 来回**才动。而且那个 `WS_SNAPSHOT_GAP_SEC`
（20 秒）**只拦了「写库」**（`saveSnapshot` 的 `minGapSec`），**请求一次都没拦** ——
一秒来 5 条事件就是 5 发 REST。

### 改法：`applyAccountUpdate()`

- `B[].wb` → 钱包余额；`P[].pa/ep/up` → 持仓量（有符号）/ 开仓价 / 未实现盈亏；
- **合并**进 `lastOverview`（⚠️ `P` 里只有「这次变了」的仓位，**不能整份替换**）；
- `pa = 0` ⇒ 从列表摘掉（跟 REST 那一路「过滤零仓」同一口径）；
- 立刻 `syncMarks()` + `pushLive(false)` ⇒ 前端**当帧**就更新，0 权重；
- 汇总口径（可用余额 / 保证金余额 / 资产明细 / C2C / 现货）事件里没有 ⇒ 仍然靠 REST，
  但**真的按 20 秒拦请求**了；只有出现**没见过的**仓位时才立刻要一次
  （那一行缺杠杆 / 强平价）。

### 实测（喂一条合成事件，验完已移除）

```
注入前     钱包=8.68582535  浮盈=0.77689104  持仓=RLC, AIN, 1000BONK
注入后     钱包=123.45678901  浮盈=0.003      ← 事件里的 wb 直接生效（0 权重、当帧）
          持仓=[RLC(ep 0.7142, up 0.3333 ← 事件值), 1000BONK]  ← AIN 被 pa=0 摘掉
+1 秒      REST 快照落下来，把交易所的真值写回（8.68582535 / AIN 回来）
```

设计如此：**本地负责「立刻对」，REST 负责「权威」**。资产那条「几分钟前」的标签
也就是这么来的 —— 现在成交 / 划转 / 资金费能让它当帧刷新，而不用等一个来回。

---

## 21. 「MM 合约保证金率」（2026-10-06 起，2026-10-07 挪过位置）

用户：「再配置旁加个显示 mm 合约保证金率」→「样式改一下根据风险来变色」。

> ★ **位置三次变化，现在挂在「大字价格」那一行的最右端**（用户 2026-10-07：
> 「mm放在 下面最右侧和价格那一排」＋「右侧」）：
>   ① 最早在**币种那一行**、配置齿轮左边；
>   ② 当天先被我理解成「下面开单模块的价格行」，用户看过后否掉了（那行本来就有
>      「价格输入 + 市价开关 + 账户标签 + 可用余额」，再塞一颗会折行）；
>   ③ 现在：`TickerHead` 的价格行末尾开了一个 **`#price-end` 插槽**，
>      `AnalyzeView` 往里面放 `<MarginRateBadge class="tk-mm" />`。
>   · ⚠️ `.tk-price` 必须 `width: 100%`（`.tk-mid` 是 `align-items: flex-start`，
>     子项默认只占内容宽）—— 不然 `margin-left: auto` 顶不到行尾（实测差 49px）。
>   · ⚠️ 插槽内容是**外层**渲染的、不带 `TickerHead` 的 scope id，所以那两条样式
>     写在全局 `style.css` 里、用类名 `.tk-mm` 兜住（别指望 `.tk-price .mm` 的 scoped 规则）。
>   · 它跟着**下单账户**（`tradeKey`）走，所以也可以顺手放在开单模块里 —— 但用户选了价格行。

### 口径（跟币安界面同一个）

```
保证金率 = Σ 维持保证金 ÷ 保证金余额          （到 100% 就是强平）
         = Σ(名义价值 × 该币档位费率) ÷ (钱包 + 浮盈)
```

实测这一套账户：`维持保证金 1.1154 ÷ 保证金余额 9.4902 = 11.65%`
（RLC 名义 20.1、费率 1.5%；**AIN 费率 5%**、1000BONK 1%）。

### 数据链路（关键：**本地重算，所以是实时的**）

| 层 | 改动 |
|---|---|
| `exchange-account.ts` `mapPosition` | 多带 `maintenanceMargin` / `maintenanceMarginPercentage`（ccxt 的 `positionRisk` 里本来就有） |
| `exchange-overview.ts` | 持仓带 `maintMargin`/`mmr`；账户带 `maintMargin`（`totalMaintMargin`，缺了按持仓求和） |
| **`position-cache.withMark`** | **`maintMargin = 名义价值 × mmr`** —— 价格一动就重算 ⇒ 保证金率跟着行情走，不用等 REST |
| `position-cache.statsOf` | 统计里多一个 `maintMargin`（Σ），随 SSE `positions` 增量一起推 |
| `db/exchange-store.latestSnapshot` | 库里没单开列（持仓那份 jsonb 里每条都带着），读的时候按持仓求和 |
| `/api/exchange/trade/positions` | 顺带回 `wallet/unrealized/margin/maintMargin`（兜底路径也要能显示） |
| `frontend/positions.ts` | store 存下这四个数，导出 `accountRiskOf(keyId)` |
| `frontend/comps/MarginRateBadge.vue`（新） | 齿轮左边那枚标签 |

### 颜色：按风险四档（用户：「根据风险来变色」）

| 档 | 阈值 | 颜色 | 实测取到的值 |
|---|---|---|---|
| 正常 | < 30% | 绿（`--ok`） | `rgb(94,186,137)` |
| 注意 | 30~60% | 黄（`--warn`） | `rgb(240,180,41)` |
| 偏高 | 60~85% | 橙（黄红之间） | `color(srgb 0.913 0.501 0.282)` |
| 危险 | ≥ 85% | 红（`--bad`）+ 轻微呼吸（`prefers-reduced-motion` 下不闪） | `rgb(227,85,97)` |

`title` 里写着公式和两个原始数（`1.1154 ÷ 9.4902 = 11.65%`）。

> ⚠️ 第一版还在标签**底下加了一根细条**（长度 = 保证金率）。用户看过之后
> 「下面不用加进度条」⇒ 已去掉，只留一枚胶囊 + 数字（内边距也改回对称的 `2px 7px`）。

⚠️ 踩到的坑：绑定**必须跟着 `tradeKey` 走**（`watch(..., {immediate: true})`）——
Key 列表是异步来的，`onMounted` 那一刻 `tradeKey` 还是 `null`，只绑一次就永远没数据。
另外 `watch` 回调里用到的 `tick` 必须先声明（我第一版写在后面 ⇒ TDZ，Vue 只在
console 报一行 `Unhandled error during execution of watcher callback`，标签干脆不出现）。

### 实测

```
MM11.65%   class="mm lv1"   绿
title: MM 合约保证金率（正常）= 维持保证金 ÷ 保证金余额
       维持保证金 1.1056 ÷ 保证金余额 9.4902 = 11.65%
       到 100% 就是强平。随标记价实时重算，不用等刷新。
12 秒内 8 次采样：11.65% → 11.61%（跟着标记价在动）
```

---

## 22. 挂「保本单」报 `-2021 Order would immediately trigger.`（2026-10-06）

用户：「设置止盈止损，如果说我想设置保本订单」→ 币安回
`binance {"code":-2021,"msg":"Order would immediately trigger."}`。

### 根因：判「止盈 / 止损」用的是**开仓价**，币安认的是**现价**

`KlineChart.drawDragPreview()` 和 `StopSheet.kind` 原来都是：

```ts
const isProfit = (px >= d.entry) === long      // ← 跟**开仓价**比
```

而币安的触发方向是**死的**：

| 平仓方向 | 类型 | 什么时候触发 |
|---|---|---|
| SELL（平多） | `TAKE_PROFIT_MARKET` | 标记价 **涨到 ≥** 触发价 |
| SELL（平多） | `STOP_MARKET` | 标记价 **跌到 ≤** 触发价 |
| BUY（平空） | `TAKE_PROFIT_MARKET` | 标记价 **跌到 ≤** 触发价 |
| BUY（平空） | `STOP_MARKET` | 标记价 **涨到 ≥** 触发价 |

⇒ 「相对**现价**在哪一侧」才有意义。多单开仓价 0.7142、现价 0.7734，
把触发价拖到 **0.7142（保本）**：相对开仓价是赚的，但相对现价在**下方** ⇒
币安只接受 `STOP_MARKET`；按开仓价判成「止盈」⇒ 发的是
`TAKE_PROFIT_MARKET`（现价已经 ≥ 触发价）⇒ **必然** `-2021`。

### 改法：两侧都改成按现价判，后端再兜一道

1. **后端**（权威）：`placeStopOrder` 先取**标记价**（`/fapi/v1/premiumIndex`，权重 1），
   用新的纯函数 `legalKind(side, stopPrice, mark)` 算出**币安唯一接受**的那个类型：
   · 跟调用方要的不一样 ⇒ **按币安的规矩发**，并在 `note` 里说明为什么改；
   · 触发价正好压在标记价上 ⇒ 直接给一句人话（`往上或往下挪一点再挂`），
     不再把那串 `-2021` 甩给用户；
   · 取不到价（网络抖）⇒ **不校正**，让币安自己判（宁可回原样的错，也别瞎改类型）。
2. **显式 `workingType: 'MARK_PRICE'`**：币安默认按**最新成交价**触发，
   而我们判定用的是标记价 —— 不写死的话薄盘/插针时两个数会分叉，`-2021` 又会回来。
   顺带跟前端画的仓位线、算的盈亏是同一个价。
3. **前端**：`DragRef` 带上 `mark`；拖动预览和确认单的类型都按 `mark` 判
   （拿不到才退回 `entry`）。触发价压在现价上时**按钮禁掉**并说明原因。
   提示语用后端回的**实际类型** `r.kind`，避免「提示说挂的止盈、实际挂的是止损」。

### 实测（都是测试单模式，没真挂到交易所）

| 场景 | 结果 |
|---|---|
| 多单浮盈、触发价 = 开仓价 0.7142（请求写 `kind=profit`） | `ok kind=stop type=STOP_MARKET` ✅ 不再 -2021 |
| 平空、触发价在现价上方 0.95 | `kind=stop type=STOP_MARKET` ✅ |
| 平空、触发价在现价下方 0.60 | `kind=profit type=TAKE_PROFIT_MARKET` ✅ |
| 触发价正好等于标记价 | 走那条人话错误（价格在动，靠节流窗口命中） |

`note` 原文举例：
`触发价在标记价 0.7739 的下方，类型按币安的规矩从「止盈」改成「止损」（不改会被回 -2021 立即触发）`


---

## 23. 日志：怎么看「到底调了哪些接口」（2026-10-06）

用户：「我看调用 api 日志有吗」。

### 现状（改之前）

| 有没有 | 什么 |
|---|---|
| ✅ | 常驻流的一生：`listenKey 就绪` / `WS 已连` / `ping` / `快照已写` / `挂单对账 +2 -0` / `REST 补成交 N 笔` / 档位切换 |
| ❌ | **交易类写操作失败**：原因只塞进 JSON 回给前端，**后端一个字不留** ⇒「我试了几次都失败」在日志里查不到 |
| ❌ | **条件单的判定过程**：`-2021` 那类码不记下来只能靠猜 |

### 现在（这一轮加的）

1. `failTrade()`：**下单 / 挂止盈止损 / 平仓减仓 / 撤单 / 改杠杆** 失败统一记一行
   —— `[交易所] 挂止盈/止损 失败（key=7）：binance {...}`。
2. `placeStopOrder` 的**决策日志**：
   `[止损单] RLCUSDT sell 触发价 0.7142 标记价 0.7739 → STOP_MARKET（请求 止盈）数量 26.5 posSide=LONG [真单]`
   —— 带了「用什么价判的 / 判成哪个类型 / 测试还是真单」。
3. **`EXCHANGE_VERBOSE=1` 开关**（默认关）：
   · `[api] <口径> 取权重 N`（`util/rate-budget.ts`）—— **不带密文**的调用流水；
   · ccxt `verbose` —— 连请求 / 响应体一起打，**但请求头里有 `X-MBX-APIKEY`**，
     只在本地排查时开。
4. **服务日志固定写到 `~/Library/Logs/ait-server.log`** —— 不再放 `/tmp`
   （上一轮我把它开在 `/tmp/mm/` 又在收尾时 `rm -rf` 掉，进程还在往已删除的
     文件写，macOS 读不回来，那几次尝试的日志就这么丢了）。
## 24. 实时层设计定稿（2026-10-07）

> 这一节顶掉了原来编号 §25–§30 那几节（排查流水、中间几版被取代的降频方案、WS 终止流程）——
> 本节编号沿用「实时层设计定稿」这个既有叫法，`§24` 之后直接跳到 `§31`，中间的号**不再占**。
> 那几节的**规则**都还在代码里，这里只留「现在是什么样」和「别再犯的坑」。

### 三层数据源

| 层 | 数据 | 来源 | 权重 |
|---|---|---|---|
| **实时** | 合约钱包 `wb`、持仓 `pa/ep`、浮盈 `up` | `ACCOUNT_UPDATE`（`/private/ws/<listenKey>`） | **0** |
| 实时 | 浮盈按秒重算、强平价 / 保证金率随行情动 | `@markPrice@1s`（`/market/ws` 一条共用） | **0** |
| 实时 | 成交、挂单、条件单 | `ORDER_TRADE_UPDATE` / `ALGO_UPDATE` | **0** |
| **曲线** | 净值点（`netOf` 口径） | 内存那份就地算 → `source='live'` 落库 | **0** |
| **校准** | c2c / 现货 / 可用余额 / 资产明细 | REST `overview` | 25/次 |
| 兜底 | 成交 / 挂单 / income 明细 | REST `userTrades` / `openOrders` / `income` | 40 / 40 / 30 每次 |

### 节奏

| 项 | 间隔 | 说明 |
|---|---|---|
| 曲线点 | **5 分钟**，落在**挂钟栅格**上（:00/:05/…） | 与档位、有没有人看、空不空仓**全都无关** ⇒ 1D 图整天 288 个点，不断 |
| REST 校准 | **1 小时**（三档一样） | 只刷「只有 REST 有」的那几项 + 防漂移 |
| 成交 / 挂单 / income 兜底 | **4 / 6 / 8 小时** | 事件已覆盖，纯安全网 |
| 事件类 | 立刻 | 重连后对账、写操作后强制对平（实测 3 秒）、页面打开 / 下拉 / 手动 ⟳ |

每套账户 ≈ **0.8 权重/分钟**（原来活跃档 ≈6.8 —— 那 5 分钟一发的 25 权重买的只是曲线的点，
现在这部分由 0 权重的 live 点提供）。

### 曾经踩过、别再犯的坑

1. **用户数据流必须连 `/private/ws/<listenKey>`**。少了 `/private` 照样返回 101、照样回 ping，
   但**一个业务帧都不推** —— 五条路径同 key 同秒对比才试出来（`/ws/` 0 帧，`/private/ws/` 收到）。
   ⚠️ 所以「连上 + 有 ping」**不能**当作订阅生效的证据。
2. **条件单的事件类型是 `ALGO_UPDATE`**（字段 `o.aid` 单号、`o.o` 类型、`o.tp` 触发价、`o.X` 状态），
   跟普通单的 `ORDER_TRADE_UPDATE` 不是一套；不处理它，撤掉的条件单会永远留在挂单表。
   `TRADE_LITE` 是同一次成交的精简版（字段少），**不处理**。
3. **SSE 只能听 `res.on('close')`，绝不能听 `req`**（Node 16+ 请求读完就触发）——
   听错的表现是「连上能收到底稿，之后所有实时事件一条都收不到」+ 浏览器反复 `ERR_ABORTED`。
4. **归档不取平均**（只留桶内 close / max / min）：取平均会把「中间爆过一次仓」抹平。
   只聚合**完整的桶**，INSERT 与 DELETE 用同一段谓词。
5. **曲线点在 `deaf`（连 ping 都收不到）时不许写**：内存那份是冻结的旧值，写下去就是一条**假平线**
   （比断档更糟）。这种情况退回 REST 采样 —— 宁可贵，不让曲线说谎。
6. 曲线点（`source='live'`）**不参与 `minGapSec` 节流门**（否则每小时的校准会被「刚写过」挡掉），
   而 `latestSnapshot()`（首屏那份）要**排除**它（否则「整份快照 X 分钟前」会变成「刚刚更新」）。
7. **listenKey 是账户共享的**（一个账户一把、POST 会返回同一把）：别为了「洁癖」停续期，
   那会让它在 60 分钟后过期、顺手把用户自己的量化程序踢下线。
8. **写操作之后必须当场对平**（`reconcileKeyOrders` 用 `force`）：否则用户减完仓，
   持仓和浮盈还停在减仓前，要等下一次对账才动（实测踩过：32 秒后才靠 REST 补成交捞回来）。
9. **采样器不能 `setInterval` 从进程启动时刻起算**：相位会跟着启动时刻走（实测桶内漂
   **93～254 秒**），点写出来的时刻跟它被归到的桶起点最多差 5 分钟，而且**重启一次换一个相位**。
   现在每轮都按当前时间算「到下一个栅格边界还有多久」（`untilGrid`）：相位钉死在 :00/:05/…，
   也不会累积漂移。实测 02:10:00 与 02:15:00 两拍，桶内偏移都是 **0**。
10. **拉到 REST 就要推 `lastSampleAt`**：它是「上一次拿到**全量口径**（c2c / 现货 / 可用余额 /
   资产明细）的时刻」。`boot` 那份漏推过 —— 5 分钟后第一拍又白打一发 25 权重，
   库里同一秒挤着两条点（线上实测 `live` 02:06:23 + `poll` 02:06:23）。现在写在
   `snapshot()` 里，所有 REST 拉取统一推。
11. **收尾 WS 时「先 `removeAllListeners()` 再 `close()`」会把整个进程干掉**（2026-10-07 实测崩过）。
   `ws.close()` 在 `readyState === CONNECTING`（握手没完成）时**不同步抛**，而是下一个 tick
   **异步 emit `'error'`**（`WebSocket was closed before the connection was established`）；
   监听器刚被清空 ⇒ Node 把「没人接听的 error」升级成 uncaught exception，
   下面那个 `try/catch` **抓不到**（它在下一个 tick 才 emit）。
   触发条件实测很现实：**代理隧道断了 ⇒ 重连一直卡在 CONNECTING ⇒ 10 分钟后
   `restartIfStuck()` 来收尾 ⇒ 崩**。生产上一样会崩，只是被 `restart: unless-stopped` 拉起来
   （代价是断档 + 一条多余的 `boot` 锚点）。
   修法：**先挂一个吞掉的 `error` 处理器，再 `close()`**（见 `cleanup()`，注释里写明了原因）。
   ⚠️ 同一类坑还有 `onMessage` 的 `void … .catch()`（未处理的 Promise 拒绝 = 事件静默消失）——
   凡是**异步抛出**的都要显式接住，`try/catch` 只覆盖同步那一段。
12. **`candles` 的查询不带 `exchange` / `market_type` = 整表扫**（2026-10-08：线上全站 502 3 分 27 秒）。
   三个索引全以这两列打头，PG 16 又没有 index skip scan ⇒ 只给 `interval`（连 `interval + symbol`
   也一样）就走 `Parallel Seq Scan`。数据量小时完全看不出来，涨到千万行才露头：
   `maxOpenTimes` 单次 **410 秒**，而它开机跑 5 次 + `repairSweep` 每 60 秒一次 ⇒
   磁盘 `wa=94%`、K 线写入被堵、app 3.5 分钟才 `listen()`。带 scope + 逐币索引探测后同规模 **33 ms**。详见 §52。

### 点位的时间戳：写侧留真实时刻，读侧才「聚集」

- 写入用 `now()`（真实测量时刻），**不写桶边界值** —— 唯一索引是
  `(key_id, kind, taken_at)`，写边界值会和同一桶里的事件点（`ws`）/校准点（`poll`）撞键。
- 聚合只发生在读的时候（`listCurve` / 归档）：`floor(epoch / bucketSec) * bucketSec` 分桶，
  桶内 **close 取最新、high/low 取包络、绝不取平均** ⇒ 一个桶在图上永远是**一个点**，
  哪怕库里那个桶有 3 行（`live` + `ws` + `poll`）。
- 桶宽下限 **300 秒**（`/api/exchange/history` 里 `Math.max(300, …)`），而点距恰好 300 秒
  ⇒ 数学上**不会**出现「一个桶两个点」或「空桶」（`t` 与 `t+300` 必落相邻桶）。
  前端判断档的阈值是 2.5 个桶 = 12.5 分钟，5 分钟点距碰不到它。

### 为什么撤掉「没人看就断 WS」

2026-10-06 加过一版（没人看 + 空仓够久就断连接、listenKey 照续）。2026-10-07 撤掉，因为
**曲线的密度就靠那条流**（live 点用内存数据算）：断连等于把曲线的数据源掐掉。
WS 连接**不吃权重**（权重只算 REST），断它省的是「整洁」，却换来曲线稀疏 —— 不划算。
省的地方改成：没人看就不补展示字段 + 三档兜底 4/6/8 小时。

## 31. K 线叠加线重做：价格上轴 + 压在蜡烛下面 + 拖动只拉虚线（2026-10-07 用户拍的口径）

用户原话：「修 k 线划线的样式 止损止盈和仓位的价格都放坐标轴上颜色要对应**层级最低**
1. 仓位拖动时，**原有的仓位不动**，只是多条虚线去拉，方向和仓位价值不要加竖线
2. 止盈止损线 左侧只显示盈利，价格挪到坐标轴上」，随后又补「**止盈止损字样和百分比要加上**」。

### 为什么不再用库的 `createPriceLine()`（这是这一轮的核心）

lightweight-charts 的 price line 有三条硬限制，凑不齐用户要的这四样：

| 要的 | 库的 price line |
|---|---|
| 价格**挂右侧坐标轴**且**颜色跟着线走** | ❌ 能挂（`axisLabelVisible`），但底色是库写死的，改不了 |
| 线**压在所有蜡烛下面**（层级最低） | ❌ **画在蜡烛上面**，没有任何 z-order 开关 |
| 虚线 / 实线按线型分 | ✅ |
| 拖动只多一条虚线、原线不动 | 手动 `applyOptions` 改原线 —— 就是用户不要的那种 |

⇒ 自己写一个 **series primitive**：[frontend/src/overlay-lines.ts](../../frontend/src/overlay-lines.ts)（`createOverlayLines()`）。

### 它怎么画的

- `paneViews()` 返回一个视图，`zOrder: () => 'bottom'` —— 库把它排在**背景层**，
  所以线一定在蜡烛下面（实测：8px 宽的阴线实体把 1px 的绿线整根**切断**，
  一行里 `g53,r8,g23,r8,…` 这样交替 ⇒ 线确实被实体盖住了）。
- 渲染体**同时**实现 `draw` 和 `drawBackground`，两处都指向同一个 `paint()`：
  `bottom` 走的是背景层（`drawBackground`），但「哪一层被调用」不该靠猜，重复画也只是同一条 1px 线。
- `y = Math.round(series.priceToCoordinate(price)) + 0.5`：落在像素中心，不然 1px 的线会糊成两条灰边。
- 虚线用 `ctx.setLineDash([4,4])`（挂单 / 强平 / 拖动预览），仓位是实线。
- **价位 → y 每次重画现算**：所以拖动、缩放、价格轴自动缩放时，线自己就跟上了，
  不需要像左侧 DOM 标签那样每帧盯指纹（那套还在，见 `labelSyncTick`）。

### 右侧轴上那枚价格标签

- `priceAxisViews()` 返回**条数不变就复用**的视图对象数组（库按**数组引用**做缓存，
  每次返回新数组会一直失效重建）；值变了只换对象里的 `line` 引用，`coordinate()` / `text()` 现算。
- `text()` = 价格（`priceText(price)`），`textColor()` = **这条线自己的颜色**（用户要的「颜色要对应」），
  `backColor()` = `#191b1f`（跟弹层同一个深色，压深了才看得清那几种亮色）。
- ⚠️ 轴标签**不参与**和 DOM 那几枚（`.cur-label` 现价、`.level-labels` 百分比）的避让 ——
  开仓价离现价很近时会和「现价」那枚叠在一起。这是老问题（压力/支撑的轴标签一样会撞），
  不是这一轮引入的。

### 左侧标签只留「一眼要用的数」（价格全上轴了）

| 线 | 标签 | 例 |
|---|---|---|
| 仓位 | **方向 + 仓位价值**（**同一段、中间不竖线**）│ 未实现盈亏 | `多 $12.29 │ +$0.0338` |
| 强平 | 就两个字 | `强平` |
| 止盈 / 止损 | 字样 │ 预期盈利 │ 平仓百分比 | `止盈 │ +$0.6436 │ 100%` |
| 加仓（普通委托） | 委托 │ 数量 | `委托 │ 数量 12` |

- 「方向和仓位价值不要加竖线」= 把方向和价值**合成一段**（`<b>` 里两个词），
  段间的竖线由 CSS `.ord-labels .olb i` 画，所以段数一改，竖线数自动跟着改。
- 标题 / 明细（触发价、数量、按开仓均价怎么算的、平掉这条持仓的百分之几）都在 `title` 里
  （按住标签 / 悬停看）。

### 拖动：只拉虚线，原线原标签**一根手指都不许碰**

- `drawDragPreview()` 现在只做两件事：`overlayLines.setPreview({…, dashed: true})`
  + 往 `.ord-labels` 里塞一枚**另起**的 `<span class="olb drag">`（描边走虚线、压淡一档）。
- 原来那枚标签、那条线**不动**（用户：「原有的仓位不动」）—— 所以拖动期间
  `renderOrderLines()` 的早退（`if (drag.value) return`）挪到了标签重建之前，
  避免这一拍的数据回来把标签下标打乱。
- 松手：`renderOrderLines()` 会顺手 `clearDragPreview()`（撤虚线、撤预览标签）；
  `pointercancel` 走同一条清理路（**不弹确认单**）。
- ⚠️ 预览那枚标签**不要给 `pointer-events`**：指针已经被原来那枚标签捕获，
  预览要是能吃事件，手指滑过去就断。

### 别改坏的地方

1. **压力 / 支撑那两条线仍然用 `createPriceLine()`**（`priceLines` 那一套，没动）：
   它们是「按可见窗口每帧重算」的、要轴上百比分标签，跟账户叠加线是两码事，别混在一起改。
2. **别把 `zOrder` 去掉**：去掉就回到「线横在蜡烛上」。
3. **别在 `drag.value` 有值时重画标签**：下标会错位（拖着的标签会指到别人身上）。
4. **别把预览做成「改原线」**：那就退回用户明确否掉的那种表现。
5. `overlayLines.detach()` 要在 `refs.chart.remove()` **之前**调（primitive 挂在蜡烛系列上）。

---

## 32. 交易所账户页第二轮：按账户分类、排序箭头进按钮、两处版式（2026-10-07 用户）

### ★ 先记一个真 bug：仓位历史 / 资金动向**没按账户筛**

用户原话：「仓位 历史 成交历史和资金动向没有根据账户分类显示」。

根因在 [frontend/src/comps/ExchangeAccountLivePanel.vue](../../frontend/src/comps/ExchangeAccountLivePanel.vue)：

```ts
const list = listAll.value      // ← 全部账户
const many = multi.value        // ← 「选中的是不是多套」
```

`listAll` = **所有** Key，`multi` = `activeTargets.length > 1`。选「币安」时：
- `listAll` 还是把「测试」那套的数据一起铺出来；
- `many` 是 false ⇒ 每条**连账号标签都不打**（`{...row, keyName}` 只在 `many` 时加）。

结果就是「两套的记录混在一张列表里、还看不出是谁的」。实测（选「币安」）：
仓位历史 12 笔（= 测试 11 + 币安 1），资金动向「近 7 天 · 132 笔」（= 测试 120 + 币安 12）。

改法：`loadCycles()` / `loadIncome()` 的 `list = activeTargets.value`，
跟 `loadFills()` / `loadOrders()` / `loadCurve()` **四处口径统一**：

> 看哪套就只列哪套；选「全部」时才合并，并且每条都带账号标签。

`listAll` 就此没人用了（`incomeTotals` 只喂「资金动向」右上角那个 `近 N 天 · M 笔`，
所以它跟着列表一起按 `activeTargets` 算，两个数才对得上）。

**复验**（选「测试」）：仓位历史 11 笔（币安那条 PUMP 没了）、资金动向
「近 7 天 · 120 笔」且行里只剩 AIN/MOG 这类、成交历史 41 条里没有币安那些 PUMP 成交。

⚠️ **成交历史本来就是对的**（`loadFills` 一直用 `activeTargets`）：选币安 8 条、
选测试 41 条，跟 `/api/exchange/fills?id=` 两端一一对得上。它被点名大概是
「两套都交易过同一个币（1000CHEEMS），单看列表分不出是谁的」——
要再看是不是这个，得让它在单账户视图里也把账号标签打出来（现在只在「全部」打）。

### 排序箭头进按钮（用户：「升序降序符号显示在每个按钮中点击切换」）

- 原来那颗独立的箭头按钮（`.pos-dir`，占 30px）**删掉**，箭头长进四颗排序按钮里。
- 当前那一档：箭头**满色**、方向 = 用户设的方向；
  其余档：箭头压淡（`opacity: .35`）、方向 = **这一档的默认方向**（`naturalDirOf`），
  点进去就是那个方向 —— 一眼能看出「点它会怎么排」。
- **点当前那一档 = 翻方向**（`pickSort(v)`：同档 → 翻，异档 → 换档）；
  换档时 `watch(posSort)` 照旧把方向拉回这一档的默认。
- 不再用 `SegTabs`（它不支持「按钮里带图标 + 点当前档翻方向」），
  四颗按钮自己排，样式还是全站 `.seg` 那套 +`.pos-sort` 微调。
- 窄屏：`.pos-sort button` 加 `white-space: nowrap`（不加会被 flex 压到换行，
  实测 320 那档按钮高 **27 → 61px**）；`≤380px` 内边距/字号各收一档；
  `≤340px`（老 320 机）**只有当前那一档留箭头**，省下 39px 让「四颗 + 一键平仓」
  仍在一行内（实测 411/390/360/320 四档都无溢出、行高 27）。

### 成交历史第二行：还是左对齐（用户：「历史成交还是左对齐吧」）

`.t-cols`：`space-between` → `start`（列间距 12 → 16px）→ **又改回 `space-between`**
（用户看完左对齐那版：「**应该放在最右侧两端对齐**」）。现在这一行的口径：
**两列各顶一头**，右列（数量 / 时间）整体贴到行右边缘 —— 实测 411 屏
右列 264..**380**、左列 31..141（行 31..380），360/320 同构、无溢出。
⚠️ 那次我先量错了再写进文档（把「`start` 那版右列右边缘 288」当成 `space-between`
的效果），实测 `space-between` 是**会把右列顶到边的**（grid 的
`grid-template-columns: repeat(2, minmax(0, max-content))` + 一个 `column-gap`，
富余宽度全给那个 gap）。

同日再补一句：「成交历史价格和手续费左对齐，**汉字**」——
`.t-pair em` 的 `text-align: right` → **`left`**（`min-width: 3em` 保留）。
两个字的「价格 / 数量 / 时间」不再被推到三字框右边：四个标签的**左边缘**一条线
（实测 `em` 左边缘 31 / 159），数值仍从同一个 `3em + 6px` 处起（`num` 69 / 197）。
⚠️ 别看 `.t-cols` 的盒子铺满整行 —— 那是 grid 的块级框，**列**是靠
`justify-content` 摆的（量列的位置，别量盒子）。

再补一句「时间和数量和内容近一点」：`.t-pair` 的 `gap` 6 → 4px，
**右列**（数量 / 时间，DOM 里第 2、4 个子项 —— grid 行优先）的标签框收到 `2em`。
那两个都是两个字，`3em` 那一版里值离标签 16.5px；左列仍是 `3em`（`手续费` 正好三个字，
收窄它会让同一列里「价格」和「手续费」后面的数值错开 10px）。
实测值起点：右列 197 → **182**、左列 69 → 67，两列内部各自还是对齐的。

### 资金动向一行：币种 → 手续费（类型标签）→ 账号标签

用户：「资金动向 手续费放币种后面 标签放手续费后面」。
- 第一行：**币种**（划转那种就写资产）/ 类型标签（这几行多是「手续费」）/**账号标签** …… 金额。
- 第二行：**只剩时间**（仍然靠右）—— 账号标签从第二行搬到了第一行，跟成交历史一条规矩。

### 按钮改名：减仓 → 平仓、平仓 → 全平（用户口径）

只改**显示的字**，函数名 / `emit` 名字 / 接口全没动：

| 位置 | 以前 | 现在 |
|---|---|---|
| 持仓卡三颗按钮 | 止盈止损 / 减仓 / 平仓 | 止盈止损 / **平仓**（只平一部分）/ **全平**（整条） |
| K 线下方「仓位」那一格 | 减仓 / 平仓 | **平仓 / 全平** |
| `ReduceSheet` 标题与提交按钮 | 减仓 | 平仓 |
| 全平确认框 | 平掉 X 这一条持仓？ / 平掉 | 全平 X 这一条持仓？ / 全平 |
| toast | 已减仓 / 已提交平仓 | 已平仓（x%）/ 已提交全平 |

「一键平仓」那颗**没改**（它是账户级动作，名字没歧义）。

---

## 33. 滚动位置缓存 + 合约行情首屏垫底（2026-10-07 用户）

### ① 交易所页面的滚动位置要记住（用户：「交易所页面滚动条加缓存」）

这一页有**两个**滚动容器，都要恢复：

| 容器 | 谁的 | 管什么 |
|---|---|---|
| `.tabpane-body` | `PaneShell`（在板子外面） | 整页（资产卡 / 列表一起滚） |
| `.tabs-body` | `ExchangeAccountBoard` | 二级 tab 里的列表（窄屏每 20 条铺一批） |

**两处改动：**

1. `views/MeView.vue` 接上现成的 `useScrollMemory()`（合约页 / 开单分析页早就用了）——
   `<KeepAlive>` 把这一页的 DOM 摘出文档再插回来时，两个容器的 `scrollTop` 都会归零，
   这个 helper 在**捕获阶段**记（`scroll` 不冒泡）、激活时挨个摆回去。
   根节点是 `PaneShell` 这个**组件**（页面最外层就是它），所以取它的 `$el`。
   ⚠️ 实测：SPA 里 /me → /analyze → /me，外层 60 / 内层 120 **都还原**。
   ⚠️ 后台标签页量不出来（rAF 与 scroll 事件都不跑）—— 一量就是 0，别被这个假阴性骗到。

2. `ExchangeAccountBoard.vue` 自己再加一层**按二级 tab** 的记忆（`scrollMem`）：
   记 `{top, shown}` 两个值 —— `shown` 是「铺了几条」，不一起恢复的话，
   切回来时内容只有 20 条，写进去的 `scrollTop` 会被**最大滚动距离**夹掉。
   时机也要死抠：`nextTick`（等 Vue 把节点铺出来）→ 一帧后写 → 再一帧复核补写。

   ⚠️ **踩过的坑**：`rememberScroll()` 一开始用的是 `tab.value`，但 `watch(tab)` 里
   `tab.value` 已经是**新**那一格 ⇒ 把旧格的 `top/shown` 覆盖到新格头上，
   症状是「切回来位置还是不对」（实测该回 1500 却落在 37）。
   现在函数签名是 `rememberScroll(of: Tab)`，由调用方说是哪一格。

   实测：成交历史滚到 1500（已铺 49 条）→ 切持仓 → 切回来，**位置 1500 + 49 条都在**。

### ② 合约行情首屏不要空着（用户：「初次加载不要显示没有匹配合约，没数据先拿仓库币种垫底」）

`MarketPanel` 的列表来自行情（SSE `!ticker@arr` + REST 快照），首屏那一下一条都还没有
⇒ 表格里就只剩一行「没有匹配的合约」。

改法：`filtered` 里加一句 —— **一条行情都没有**时，返回**合约表垫底行**
（`store.contracts`，就是「仓库里的币种」，共 525 条）：
只有 `base` / `symbol`，价格那几格是 `null`（模板本来就画成「—」）。
第一条行情到了就整表换掉（`byPair.size > 0` 就不再垫）。

- ⚠️ **只在「完全没有行情」时垫**：行情刚到一半（只推了几个币）就混进来会一半真一半「—」。
- 垫底这份**也要过搜索**（`rest` 那边本来就按关键词过滤），所以首屏搜币照样能用；
  置顶那一段也照常在最上面。
- 上限照旧是 `MAX_ROWS = 120` 行。
- 实测（把 `/api/markets` 和 `/api/tickers/stream` 都 abort 掉再进页面）：
  铺出 **120 行**、价格列全是「—」、标题「共 525 个合约」、**没有**空状态那行；
  放开拦截重进 ⇒ 真行情（共 140 个合约、有价、有涨跌幅）。

---

## 34. 币种图标**落盘**缓存（2026-10-07 用户问「图标保存在数据库吗」→ 选「落盘」）

### 先回答那个问题：**没有入库**

原来的三层，一层数据库都没有：

1. 前端 `iconUrl(base)` → `<img src="/api/icon/ain?v=3">`（`ICON_VERSION` 换源 / 改逻辑时手动 +1 破浏览器缓存）；
2. 后端 `handleIcon`（[backend/src/server.ts](../../backend/src/server.ts)）先查**进程内存** `iconCache`，
   未命中就按 **okx → coincap → spothq** 三个公开 CDN 依次试（实测命中率 67% / 46% / 16%，
   三家合起来 406/528）；
3. 三家都没有 → `letterIcon()` **服务端现画一张 SVG 首字母圆**回 200（故意不回 404：
   `<img>` 加载失败会在控制台刷红字），配色跟前端 `letterColor()` 逐字一致。

「看着像缓存住了」其实是**浏览器**那份：真图标 `max-age=604800`（7 天）、首字母圆 1 天。
数据库里跟币种有关的只有 `contract_store`（合约表 = `data/contracts.json` 的落库版，
字段是 symbol/base/quote/tickSize，**没有图标**）和 `ccxt_markets`。

### 现在：加一层**文件缓存**（`data/icons/`）

- 有图 → `data/icons/<key>.<ext>`（ext 由 content-type 推，回读时反查回类型；
  表里没有的用子类型本身，如 `image/apng` → `apng`）；
- **没图 → `data/icons/<key>.missing`**，文件里存一行取到的时间。
  ⚠️ 不留标记的话，重启后又要为那 122 个没有图标的币各打三趟上游（单条上游 4 秒超时）；
  ⚠️ 标记**不能永久**：图库会慢慢补上新币 ⇒ 超过 `ICON_MISS_TTL_MS`（30 天）就当「不知道」重问一次。
- 只在**进程内存**里存一份（几百 KB），盘上的靠 `readdirSync` 一次列出这个 key 的所有文件
  （`.tmp` 那种写了一半的跳过），不按扩展名挨个 `existsSync`。
- **写盘顺序**：先写 `<name>.tmp` 再 `renameSync` —— 同一个币并发请求时不会读到半个文件。
- 只落**能去问上游**的 key（`probeable`：纯 ASCII）。中文名的币（哈基米 / 龙虾 / 牛来…）
  上游必然没有，落盘只会在盘上堆没用的文件。
- 磁盘只是**加速**：读写全部 best-effort，出错（没权限 / 盘满）**只告警一次**，绝不让图标接口 500。
- `data/icons/` 进了 `.gitignore`（运行产物）；`data/contracts.json` 是**要提交**的基准名单，没动。

### 实测（重启进程、内存缓存清空后）

| 请求 | 第一次（要问上游） | 重启后（走盘） |
|---|---|---|
| `/api/icon/btc` | 200 png | **1.6ms** |
| `/api/icon/eth` | 200 png（129ms） | **1.2ms** |
| `/api/icon/btcdom`（上游没有） | 200 svg 首字母圆（1.89s，打了三趟上游） | **1.1ms**（读 `.missing`） |

响应头没变：真图标 `Cache-Control: public, max-age=604800`、首字母圆 `max-age=86400`。

---

## 35. 划转弹层：去掉常驻警示 + 下拉换成自定义样式（2026-10-07 用户）

用户原话：「⚠️ 划转是**真钱**操作 … 提示去掉，划转的下拉框换成自定义样式」。

### ① 顶部那条红色警示删了

`.tr-warn`（「划转是真钱操作 —— 币安没有划转测试接口…」）模板 + 样式一起删掉。
现在这一处的保护只剩两层，**别再往弹层里加回常驻提示**：

- 提交前 `askConfirm` 里复述「账户 / 从哪到哪 / 多少」+ 一行 `tone: 'warn'`
  （「划转没有测试接口，划出去就真的换钱包了。」）；
- 没开「允许通用划转」的 Key 直接禁用提交。

### ② 从 / 到那两个 `<select>` → `SelectPick`（自定义下拉）

原生 `<select>` 在安卓 WebView 里弹的是**系统控件**（灰底灰字那套），
跟这一页的胶囊 / 面板完全不是一套，`<option>` 更是一点都改不了。

新增 [frontend/src/comps/SelectPick.vue](../../frontend/src/comps/SelectPick.vue)（泛型组件，`{value,label}[]` + `v-model`）：

- 长相跟 `.combo-list` 一套：壳 `position: relative`、列表 `position: absolute`，
  面板底 + 阴影 + 10px 圆角，当前项淡底 + 高亮 + 右侧**内联 SVG 勾**
  （不用 ✓ 字符：安卓兜底字体不保证有字形）；
- 关掉的三种方式：选一项、**点壳外面**（`pointerdown` 捕获阶段）、Esc；
- ⚠️ 列表是**浮层**，所以壳外面那层不能 `overflow: hidden`
  （`.sheet` 是 `overflow: auto`，实测 112px 高的列表在 411/320 下都在视口内、不被裁）；
- 样式放全局 `style.css` 的 `.pk-*`（跟 `.combo-*` 一个位置），
  弹层里只管 `.tr-side .pk { flex: 1 1 auto }`。

实测：411/320 下从/到两颗各 145 / 99px、一行放得下不换行；开合、勾选、⇅ 对调都正常；
点标题（列表外面）会收起来。

---

## 36. 修 bug：一键平仓 / 平仓 / 全平 / 止盈止损 平的是「默认那套」账户（2026-10-07 用户「一键平仓点击平仓不是选择的账户」）

### 现象与根因

用户账户里有两套 Key：`测试`（id 7，`is_default = true`）、`币安`（id 9）。
顶部切到「币安」再点「一键平仓」→ 真被平掉的是 `测试` 那套。

链路：板子把每行的 `keyId` 交给容器 → 容器调
`POST /api/exchange/trade/close?id=…` → **`?id=` 没了** →
后端 `idRaw ? getExchangeKey(me.id, idRaw) : await getDefaultExchangeKey(me.id)`
（`ORDER BY is_default DESC, id`）⇒ 落到默认那套。

`?id=` 之所以没了：**`keyId` 只有「全部」那一格才会补上**。
`mergeOverviews()` 在 `list.length === 1` 时直接 `return list[0].ov`（原样返回、
一行 `keyId` 都没有），而「只选一套」和「一共只有一套」都会走到这个分支；
SSE 的 `positions` 补丁更是把 `p.positions` **原样**盖回去。于是单套视图下
`row.keyId` 恒为 `undefined`，四颗真钱按钮（平仓 / 全平 / 一键平仓 / 止盈止损）
全都交 `undefined` 出去。

2026-10-07 实测（`page.route` 拦住请求、**不放行到后端**，所以没真下单）：
切到「币安」点一键平仓 → `POST /api/exchange/trade/close`（无 `?id=`）⇒ 复现。

### 改法（都在 `ExchangeAccountLivePanel.vue`）

1. `mergeOverviews()` 单套分支也**补 `keyId`**（只是仍然**不写 `keyName`**，
   所以单账户的界面跟以前一样、不会冒出一排账户标签）。补的时候返回新对象，
   别改 `parts` 里那份底稿。
2. 抽出 `resolveKeyId(keyId?, keyName?)`：按「数据自带的 keyId → keyName →
   当前选中的那一套 → 第一套」解析成一个**具体的 id**；
   `keyIdOfOrder()` 改成调它（挂单改 / 撤原来就是这个顺序，行为不变）。
3. 四颗按钮一律走 `resolveKeyId`：`confirmReduce()`、`closeRow()`、`openTpSl()`
   （挂条件单也会挂到默认账户上）、`closeAllRows()` 里的去重集合。
   `closeAllRows()` 里**没有 id 就整单不发**（宁可报一句「先切一下账户」，也不猜）。
4. 「一键平仓」确认框标题带上账户名：`平掉「币安」全部 2 条持仓？`
   —— 只写条数的话，人没法从弹窗上核对这一下动的是哪套（这正是这次报上来的困惑）。

### 实测（`page.route` 拦截，全程没到后端）

| 操作（单套「币安」视图） | 改前 | 改后 |
| --- | --- | --- |
| 一键平仓 | `/trade/close` | `/trade/close?id=9` ✅ |
| 某条「全平」 | 无 `?id=` | `?id=9` + `{symbol,side,test}` ✅ |
| 某条「平仓 25%」 | 无 `?id=` | `?id=9` + `{symbol,side,pct:25,test}` ✅ |
| 「止盈/止损」确认 | 无 `?id=` | `/trade/stop-order?id=9` ✅ |
| 「全部」格（只有币安有仓） | 只发一次、无 `?id=` | `?id=9` 一次 ✅ |

**别改坏的地方**：`keyName` 仍然**只在多套**时才写 —— 它一出现，板子每行就会多一个
`.ktag`（`v-if="p.keyName"`）。所以单套视图「补 keyId 不补 keyName」是**故意**的。

## 37. 实时 K 线底座（2026-10-07，P1 读路径已上线）

用户口径：「合约行情和 k 线渲染我想重构，不需要预热那一套，相关的备注方法删掉防止以后
记忆错乱，改为实时的，存储 7 天 1 分钟的，后端不间断的用推送流计算，这样就可以实现
合约界面和 k 线最近的数据秒开」。

> **P0（已完成）**：底座先只写不读，攒够连续率/权重/内存的实测。
> **P1（2026-10-07 已上线）**：`/api/candles` 的「最新 N 根」改成
> **内存 → 库 → REST**，「当前那根」由底座内存现取；启动预热（`warmCandlesCache`）、
> 10 秒保活（`startKlineKeepWarm`）、跨热线阻塞（`TAIL_MAX_AGE`/`MAX_WAIT_MS`）整块删除。
> 详见下面「P1 落地」一节。
>
> **P2（已做）**：前端与注释里对已删机制的残留引用都清了（`warmCandlesCache` /
> 「全量预热」/「保活」），并把「为什么行情条还预热、K 线不预热」写在该写的地方。
> **P3（已完成，2026-10-07）**：三档校验（写入前 / 缺口 / 抽样对账）。
> **P4（已评估，结论：不做）**：行情层的出站带宽。见下面「行情层带宽：实测与结论」。

### 定稿（实测数字都是这台机器上真跑出来的）

| 项 | 定稿 | 依据 |
|---|---|---|
| 底座订阅 | **525 币 × `@kline_1m` 常驻**，1 条上游连接 | 实测覆盖 525/525、首帧 173 ms、434 帧/秒、130 KB/s |
| 连接与流 | **1 条连接 / 526 条流** | 1050 条一条连接会被 `{"code":4,"msg":"Too many subscriptions"}` + `1008 Invalid request` 踢（实测 0 帧） |
| 高周期 | **收盘 rollup 物化六档**，不额外直订 | 4h/1d 直订实测要多 **2 条连接 + 897 帧/秒 + 278 KB/s**（成本 ×2.1），只买到「漏分钟保险」 |
| 行情层 | `!miniTicker@arr`（51 KB/s，替 `!ticker@arr` 的 104）+ `!markPrice@arr`（39 KB/s、3 秒一轮全市场） | 每条流单独实测；涨跌幅用 `(c−o)/o` 推 |
| 落库 | **只落已收盘的 1m**（8.75 行/秒）+ 六档；保留 1m/5m 7 天、15m 30 天、1h 400 天、4h/1d 永久 | 不落未收盘那根：525 upsert/秒换不到任何体验 |
| 内存 | 每币 × 每高周期一个累加器 ≈ **1 MB**（不存热层） | 定稿时宿主只有 909 MB（压测期 available 掉到 ~300 MB）；2026-10-07 已升到 2GB |
| 回补 | 启动/重连/运行中漏分钟 → 从库里最后一个 `open_time` 起 REST 补，`paced()` 限速 + `takeWeight(2)` | 525 币同时补 ≈ 2600 权重，一次就能把 IP 打进 `-1003` |
| 常态权重 | **0/分钟** | 全走 WS |

### 三条硬约束（都是实测踩出来的）

1. **币安没有 K 线的聚合流**：`!kline_1m@arr` 请求回 `{"result":null}`、**0 帧 0 字节**
   —— 静默无效，连报错都不给（和 `/private/ws` 那个坑同一类）。
   所以 K 线只能 per-symbol 订，525 个币 = 525 条流；"优先用聚合流"只在**行情层**成立。
2. **一条连接最多 1024 条流**：超了直接被关连接。
3. **覆盖度不能靠回执验**：成功回执是 `{"result":null}`（不列流名），流名写错也是静默的
   ⇒ 只认「这个币有没有收到过帧」（`/api/kline/recorder` 的 `covered`）。

### 两条必须记住的实现规则

- **残桶绝不写**：启动时从桶中间开始记、或运行中漏了分钟 ⇒ 那个高周期桶的量/笔数会偏小、
  high/low 会漏掉最高那一下。**实测踩过**：桶中间启动，5m 量 493 而 1m 求和 633，
  而且它把 seed 灌进来的交易所口径盖掉了。现在 `Agg.partial` 一旦为真就整桶丢弃。
- **库里只保证「已收盘的桶」**：高周期的当前根不在这里。P1 的读路径 =
  库里那份（完整桶）+ 由 1m 补出来的当前根，别直接拿库里的当"最后一根"。

### 修复与灌历史

| 场景 | 动作 | 成本 |
|---|---|---|
| 启动 / 上游重连 | 扫一遍「库里最后一个 1m < now-2 分钟」的币，排进修复队列 | 每币 1 发 REST |
| 运行中漏分钟 | `onKline` 发现 `openTime` 跳了 → 排队；每 60 秒最多修 5 个币，同币 10 分钟冷却 | ≤5 币/分钟 × 6 发 |
| 每个币的修复 | ① 补 1m ② SQL 由 1m 重算高周期（只算完整桶）③ 同段再问一次交易所覆盖 | 6 发 |
| 灌历史（`KLINE_SEED=off` 可关） | 每档取 `SEED_BARS`（5m/15m/4h/1d 1000 根、1h 2000 根） | 525 × 5 = 2625 发，限速跑 10~20 分钟 |

灌进来的是 ccxt 口径（**只有 OHLCV**，量/笔数/主动买量存 0）⇒ 每日对账只比 OHLCV。

### 机器实测（同一台 Lightsail，定稿时 909 MB 内存 / 2 vCPU；2026-10-07 升到 2GB / 60G）

| 形态 | 帧率 | 入流量 | ca-app CPU | 宿主 available |
|---|---|---|---|---|
| 只订 1m（定稿） | 434 帧/秒 | 247 KB/s（含 ticker 104） | 8~15% 单核 | 350 → 300 MB |
| 1m + 4h + 1d（被否掉） | 1344 帧/秒 | 526 KB/s | 15~25% 单核 | 297 MB |

入站流量在 Lightsail **不计费**（只计出站），43 GB/天 ≈ 4.2 Mbps。

### 落地状态

- **P0（已完成）**：`candles` 表（`db/candle-store.ts`）、`data/kline-recorder.ts`
  （常驻订阅、收盘落库、rollup、修复队列、灌历史、分级清理）、
  `GET /api/kline/recorder?db=1` 自检、`market.ts` 抽出 `listPerpetualSymbols()` 当**唯一一把尺子**。
- **P1（已完成，2026-10-07）**：`/api/candles` 改成「内存 → 库 → REST」；删 `kline-store`
  的保活（`startKlineKeepWarm`/`keepWarmRound`）与跨热线阻塞（`TAIL_MAX_AGE`/`MAX_WAIT_MS`）。
- **P2（已完成，2026-10-07）**：删启动的 K 线预热（`warmCandlesCache` + `WARM_TIMEFRAMES`
  + `WARM_LIMIT`），清掉前端与注释里对已删机制的残留引用。
  ⚠️ **保留**了行情条预热（`warmPicks`/`warmTickerCache`）—— `/api/ticker` 一个币要并发打
  4 趟交易所、冷启 ~1.07s，跟 K 线读路径无关；也保留 `market.ts` 的 `warmExchange`
  （ccxt `loadMarkets` 每个进程只付一次，删了就是让第一个用户付 2.7s）。
  **SSE 仍按需直订上游**（没改成由底座合成）：底座只收 1m，高周期的当前根若由它合成，
  那根就只会**每分钟**动一次（现在是每帧动），画图手感会变差 —— 不值得。
- **P3（已完成，2026-10-07）**：三档校验落地 —— ①写入前校验 ②缺口巡检（含库内自洽）
  ③每日抽样对账。见下面「三档校验」一节。
- **P5（已完成，2026-10-07）**：合约**生命周期**（新币自动订阅 / 下架自动摘除 + 按需发现）。
  见下面「合约生命周期」一节。顺手修掉一个真 bug：每次开机白下 1.1MB（`hydrateMarketsCache` 排太晚）。
- **P4（已评估，结论：不做，2026-10-07）**：行情层出站带宽。原计划是「换 `!miniTicker@arr`
  + `!markPrice@arr`」—— 实测**两个都站不住**，见下面「行情层带宽：实测与结论」。

### P1 落地（2026-10-07）：`/api/candles` 三层读路径

```
GET /api/candles?symbol=&timeframe=&limit=（不带 from/to 且 limit<=600）
        │
        ├─① 内存（kline-store，只存「已收盘」那串，不设 TTL）
        │     还没跨过一个桶 ⇒ 直接切 300 根（hits.memory）
        │
        ├─② 库（candles 表，底座常驻写）——跨过桶了才来读一次
        │     本地库毫秒级、**0 权重**（hits.db）
        │
        ├─③ REST —— 库里没有（非 swap / 新上市 / 超窗）或库太旧（底座挂了，hits.rest）
        │
        └─ 末根 = 底座内存现取的「当前那根」（hits.live，0 I/O）
              · 高周期：累加器可信 ⇒ 累加器 + 活的 1m；
                       不可信（`Agg.partial`：刚重启/漏过分钟）⇒ 库里 1m + 活的 1m 现拼
```

| 实测（本地，库里全量历史） | 改前 | 改后 |
|---|---|---|
| `/api/candles` 首次（冷） | 180~255 ms | **6.7~28 ms** |
| 第二次起 | 同上（TTL 4s 或补尾巴） | **内存命中** |
| 上游权重 | 每冷启 528 币 × 每 4 秒 | **0**（只有库里没有才发） |
| 末根 | REST 里那根 | 底座内存合成（1m 连打三次量 33.985→34.936→42.299） |
| `store.hits`（一次六周期请求） | — | `db 10 / rest 0 / live 11` |

配套修掉三个挡路问题（详见 commit `feb7aaa`）：当前根合成的 key 用错（`states` 按原始 id
建 key、`currentBar()` 拿统一符号查 ⇒ 恒 null）、**残桶入库**（回补/灌历史三处只按
`timestamp < now` 过滤）、**candles 缺非主键索引**（`maxOpenTimes`/`pruneCandles` 全表扫
1100 万行 ⇒ 库 CPU 300%、连接超时）。

### 端到端再校一遍（2026-10-07，用户「再校验一次从前端到后端的流程」）

这次把「前端怎么请求 → 后端怎么答 → 库里到底写没写对」整条链走了一遍，抓到 3 个 bug
+ 1 个性能问题，都在**本地**修掉并验证（线上没动，等用户命令）：

| 问题 | 现象（实测） | 修法 |
|---|---|---|
| **当前根串市场**（P1 引入） | `market=spot` 的请求也被拼上**合约**的当前根（`live` 计数 24/24 次请求全中）⇒ 现货图里混进合约价格 | `kline-store` 加 `inRecorderScope()`：只有 binance + swap 才拼当前根。实测：合约请求 `live +1`、现货请求 `live` 不动 |
| **`loadOlder` 无竞态保护** | 往前拖触发的那段是异步的，用户拖完马上切币 ⇒ 晚到的**旧币**数据 prepend 到新币的 `candles` 上，图上两个币的价格拼在一起，且不会自愈 | 与主加载共用 `loadSeq`：回来时序号变了整段作废 |
| **还有第三处写残桶** | `repairSymbol` 的「同段再问一次交易所」用 `.filter(c => c.timestamp < now)`（`now` 不是对齐后的桶边界）⇒ 未收盘桶入库，`source='repair'`。本地抓到 5 币 × 5 档，线上同样有 | 换成 `closedOnly(...)`（与另外两处统一）。修完半成品桶计数保持 **0** |
| **区间请求不走库**（性能） | 前端「往前拖看更早」/「选某一刻」走的是带 `from/to` 的分支，完全在 P1 之外：**冷 230ms + 权重 5**，而这段历史库里查一次 **0.34ms**（走 `candles_ivl_symbol_time_idx`）；而且区间结果 30 秒后还会再打一次交易所（历史根本不变） | 新增 `getRangeCandles()`：整个 `[from,to]` 落在库覆盖范围内就走库，否则返回 null 交给原来的 REST 分支。实测 **8~30ms**（`rangeDb` 计数上涨、`rangeRest` 为 0），跨源逐字段对照 **239 根完全一致** |

**没改、只记录的**：全市场行情 SSE 是 **33.7 KB/s / 观看者**（≈121 MB/小时，前端一开着就按这个速率走出站流量）；
`/api/ticker` 冷启现在 **194ms**（改前注释记的 1.07s —— 因为涨幅基点改读底座库了）、命中缓存 4ms；
K 线 SSE 293 B/s；SSE 上游有引用计数 + 30 秒空闲释放（无泄漏）；主加载/各轮询间隔都正常。

### P3 · 三档校验（2026-10-07，用户定的分层）

用户口径：「实时（第 1 档）写入前校验 OHLC/对齐/单调 → 丢弃 + 计数；定时（第 2 档）存在性
检查 → 缺口告警 + 触发补齐；每日（第 3 档）抽样字段对账 → 差异落表 + 告警」。

为什么要三档而不是一档：它们的**成本差两个数量级，抓的东西也完全不同**。
底座是「实时流 + 官方历史包 + 增量回补 + rollup」拼出来的，长期无人值守跑，
错法有好几种，每一种能被看见的位置都不一样：

| 档 | 查什么 | 花什么（⚠️ 见 §53：不花交易所额度 ≠ 不花磁盘） | 抓得到 | 抓不到 |
|---|---|---|---|---|
| **① 实时** | 写入前：桶对齐 / OHLC 关系 / 值域 / 同批重复与倒序 | **0**（纯内存） | 坏值入库（上游抖、调用方算错） | 库里**已经**存在的错 |
| **② 定时**（5 分钟） | 存在性（窗口内该有多少根）+ 库内自洽（**只复核记账的桶**，见 §53） | 存在性 **0**；自洽按账上条数（常态几十条 × ≤1440 行） | 洞、残桶、陈旧值、漏帧 | **1m 自己写错**（1m 是对的基准） |
| **③ 每日** | 抽 3 币 × 5 档 vs 交易所 REST 逐字段比 OHLCV | **30 权重/轮** | 上面全部 + 1m 本身错、口径串了 | 没抽到的币（靠**按天轮换**覆盖：525 币 175 天一轮） |

**① 写入前校验**（`db/candle-store.ts` 的 `sanitizeRows`，挂在 `saveCandles` 里）：
四条入库路（实时流 / rollup / 补缺口 / 灌历史）最后都走 `saveCandles` ⇒ 一处实现、四处生效。
只丢**结构性错误**（一定错的），不做业务判断（"量突然大了 10 倍"是异常检测，不是校验）。
· 未对齐桶栅格 / OHLC 关系不成立 / 非正价、负量、非有限 ⇒ **丢弃**；
· 同批同桶重复 ⇒ **后来的覆盖前面的**（与 UPSERT「谁最后写谁赢」同义），计数不丢数据；
· 同批同币同周期时间倒序 ⇒ **只计数不丢** —— 它幂等无害（不同主键各自插入），
  但出现它说明上游/调用方乱了序，值得在自检里看见。
计数按原因分类，读 `GET /api/kline/recorder` 的 `rejected`（`align`/`ohlc`/`range`/`dup`/`unordered`）。
离线夹具 10 组在 `npm run selftest`（那个纯函数失效方式是"悄悄少一根"，只有夹具卡得住）。

**② 缺口巡检**（`runGapCheck`，每 5 分钟 + `GET /api/kline/gaps?run=1` 手动）：
`repairSweep` 只管「库里最后一条 vs 现在」，**窗口中间的洞它看不见** —— 漏了 40 分钟又被上游
接上，最后一条是新的，扫描就认为"没事"；而那个洞会让图上少一截，读路径还会因为"这段库里有
覆盖"而不去问交易所，于是洞一直摆着。所以按（币 × 周期）扫窗口：
`expected = 从"它自己最早那根"到"现在该有的最后一根"`，`actual < expected` ⇒ 告警 + 排进修复队列。
· 窗口：每档最近 120 根；判"该有"时留 **30 秒 flush 余量**（刚落的那根可能还没写库）——
  假警报比晚 5 分钟发现更糟。
· 只看**订阅过且收过帧**的币（`coveredAt > 0`）：没收过帧的要么是死币要么刚启动，报警纯噪音。
· 一轮最多排 60 个（防一次抖动把队列堆爆，剩下的下一轮再来）。
· **库内自洽**（`findStaleBuckets`）：「有没有」查不出「值对不对」——
  一条**残桶**（写的时候桶还没收盘）在那儿、根数也对，就是值不对，而且**永远不会自愈**
  （`seedHistory` 嫌它太新而跳过、`repairSweep` 只看 1m）。判据：该桶 1m 一根不缺的前提下，
  最后一根 1m 的 close ≠ 高周期行 close，或 1m 的 volume 求和 ≠ 高周期行 volume。
  ⚠️ **必须按订阅清单过滤 `symbol`**：不过滤就要为全市场每个高周期行各做一次 1m 范围扫
  （实测 1575 行 × 240 根 = **1.0 秒**；过滤后 8 币 = **几十毫秒**，整轮 1.0 秒）。

**③ 每日抽样对账**（`runKlineRecon`，启动 15 分钟后第一轮 + 每 24 小时 + `?run=1` 手动）：
抽 3 个币（**按天序号取模轮换**，可复现：出问题能算出"那天比了谁"）× 5 档，各取最近 200 根
与交易所 REST 同段**逐字段比 OHLCV** ⇒ 差异落 `kline_recon` 表 + 告警日志。
· 只比 OHLCV：`seed`/`repair` 灌进来的量/额/笔数是 ccxt 口径（存 0），不可比；
  要比量只能比 `source = 'ws' | 'rollup'` 的桶 —— 而那正是①②在管的事。
· 容差：价格同一个数过一遍 IEEE754 ⇒ 应当**完全相等**；量是「一段 1m 相加」vs 交易所自己的和
  ⇒ 末位可能差一点，用相对 `1e-9`。
· 成本：15 发 × 权重 2 = **30 权重/轮**（限额 2400 权重/分钟）⇒ 一天一轮可忽略。
· 为什么放启动 15 分钟后：那之前 `seedHistory` 还在灌，库本来就不全，比出来全是假差异。
· ⚠️ 别在**没跑过底座**的进程里手动触发：`symbols` 是空的会抛「底座还没就绪」。

**这一档当场抓到的真事（本轮唯一实锤）**：
第一次对账 15 组里 3 组不一致 —— 全是 **4h 桶今天 00:00 UTC、close 对不上**：
BTC 库里 `83850.1` vs 交易所 `84104.9`。查下去：
· 那 8 条（BCH/BTC/ETC/ETH/LINK/LTC/TRX/XRP —— **正好是本地 `KLINE_RECORDER_MAX=8` 的那 8 个**）
  是 `source='seed'`、`updated_at` 02:46 UTC 写的，而那个 4h 桶 04:00 才收盘 ⇒ **写的时候桶还在走**；
· 时间线：写脏数据 **10:46 +08**，`closedOnly` 修复提交 `feb7aaa` 在 **14:23 +08** ⇒
  **是修复前的遗留污染**（全表扫「开盘时间 + 周期 > now」= **0 行**，证明现在的写入方都是对的）；
· 但它**永远修不掉**：`seedHistory` 跳过（`now - last < 2*ms`）、`repairSweep` 只看 1m（1m 是新的）。
⇒ 库内自洽把它抓出来并自愈：8 条全部被 `repair` 用交易所口径盖回
（BTC `close 83850.1 → 84104.9`、`volume 46936.15 → 46978.67`），再跑对账 **3000 根全一致**。

**自检入口**（都要登录）：
· `GET /api/kline/recorder`（`?db=1` 带上每档行数/覆盖区间）→ `rejected` / `gaps` / `recon` 三个计数块
· `GET /api/kline/gaps`、`GET /api/kline/gaps?run=1`
· `GET /api/kline/recon`、`GET /api/kline/recon?run=1`

### 合约生命周期：新币 / 下架（2026-10-07）

用户口径：「如果行情有更新，比如有新币，或者新币种下架了，再去调整它的历史然后订阅」→
「**改为每日**」→ 下架后「下线就不需要了，k 线也没必要统计」。

**改前的问题**：底座的订阅清单在 `boot()` 里**只算一次**（`listPerpetualSymbols`）；
`ccxt_markets` 虽然每天刷，但**底座不会跟着变** ⇒
· 新币**不订阅**（点开只能走 REST、没有秒开），要等进程重启；
· 下架币永远占着清单和一条 `@kline_1m` 流（`checkWatchdog` 只看**全局**末帧，单币静默它看不见）。

**现在三件事**

| 触发 | 时机 | 成本 |
|---|---|---|
| 每日发现 | 启动一次 + 每 24 小时 | 权重 **1**（1.1MB） |
| 按需发现 | 读路径要退 REST、且这个币在合约范围里却没订阅 | 全局 ≥5 分钟一次；单币 1 小时负缓存 |
| 下架 | 发现时 `status !== 'TRADING'` | 退订 + 摘除，**不补数据** |

**发现用的数据**：原始 `/fapi/v1/exchangeInfo`（走 ccxt 的 `fapiPublicGetExchangeInfo`）。
为什么不复用现有两条路：`contracts.ts` 那条是**裸 fetch**（本地要过代理，直连不通）；
ccxt 的 `markets` 把 `status` 压成一个 `active` 布尔、**并且丢掉 `onboardDate`** ——
而"这币什么时候上线的"正是生命周期要的。实测 659 个 U 本位永续 USDT 合约
（525 TRADING / 133 SETTLING / 1 PENDING_TRADING），**924/924 都带 `onboardDate`**。

**生命周期表 `symbols`**：`pair / symbol / base / status / onboard_at / delisted_at / last_seen_at`。
`delisted_at` **只在 TRADING → 其它 的那一刻写一次**（之后不再改，否则"什么时候下架的"就没意义了）；
重新上架会清回 NULL。底座启动时整份读进**内存镜像**（读路径 0 I/O），之后每次发现覆盖。

**⚠️ 「下架时补完最后一段」是错的（实测推翻，记在这里免得以后再想一遍）**：
币安对已下架的币**照样返回 K 线**，但那些是**量 0 的水平线** ——
实测 OMG/WAVES/MKR/STORJ：最近 5 根 1h 量**全是 0**、价格冻住（OMG 0.291、WAVES 1.3355 一根不动）；
WS `omgusdt@kline_1m` 15 秒只有 1 帧（BTC 同窗口 27 帧）。
⇒ 补到 `now` 等于往 **4h/1d（永久保留）** 里塞假 K 线。所以现在：
**下架就是退订 + 摘除，一条也不补**。
库里**已有的历史一行不删**（1m/5m 7 天后自然被清、15m 30 天、1h 400 天、4h/1d 永久）——
用户 2026-10-07 明确定过口径：**「历史留着，只是不再维护」**。不写、不查、不校验，
留着是零成本的；哪天真要清，也该是一次性的显式清理，而不是塞进下架这条路里。
配套给 `repairSymbol` 加了自保：**「最后一次 `volume > 0` 的 1m 距现在超过 15 分钟」的币一律不补** ——
因为下架可能发生在两次发现之间（最长 24 小时），这期间 `repairSweep` / 缺口巡检都会来碰它。

**另一个自保：静默合约**。上游超过 15 分钟没推某个币 ⇒ 缺口巡检把它记成 `silent`（**不算缺口**）、
不去补数据，并**顺手重订一次它那条流**（若是"我们这条流静默死了"就自愈；若是币停了则无副作用）。

**读路径两条规矩**：① `status !== 'TRADING'` 的币**不去触发发现**
（⚠️ 用 `status` 而不是 `delistedAt`：那 134 个"我们从没见过它是 TRADING"的币，
`delisted_at` 天然是空的 —— 拿它当判据会漏掉整整一批）；
② 同一个币 **1 小时**内最多触发一次发现（负缓存，防"真没数据的 symbol"被反复点、反复触发）。

**顺手修掉的一个真 bug：每次开机白下 1.1MB。**
`hydrateMarketsCache()` 原本排在 `startExchangeStreams()` **之后**，而那些路开机就 `getExchange()`
建实例 ⇒ `attachMarkets()` 判"够不够新"时内存缓存还是空的 ⇒ `fresh()` 为假 ⇒ **真去下 1.1MB × 2**
（`data/ccxt-markets.ts` 里"冷启动 0 网络"那个前提就这么被破了）。
现在把灌缓存提到 `main()` **最开头**（`await`）。实测：修复前 `ccxt_markets.updated_at`
每次开机都被刷成启动那一刻，修复后**维持不变**（连续两次重启都验证过）。

**实测（本地，2026-10-07）**

| 场景 | 做法 | 结果 |
|---|---|---|
| 新增 | 从本地 `ccxt_markets` 里删掉 XLM → 重启 | `新合约 XLMUSDT → 已追加订阅 1m（上线 2020-01-20T08:00:00Z）` ✓；随后 XLM 真有 `source='ws'` 的 1m 行（最新 07:45）✓ |
| 下架 | 把已下架的 OMG 在本地 markets 里标成 active → 重启 | `合约下架 OMGUSDT（不在 TRADING 清单里）：已退订、已从清单摘除（不补数据…）；库里已有的历史不动` ✓ |
| 完全同步 | 真实 markets | `没有变化` ✓ |
| 上限保护 | `KLINE_RECORDER_MAX=8` | `新增 0 个（… 共 517），其中 517 个被订阅上限挡住` ✓（**不虚报**） |
| 离线夹具 | `npm run selftest` | 合约 diff **7 组**：同步 / 新币加 / 待上线**不加** / 消失摘 / 状态变摘 / 下架又回归 / 大小写不敏感 ✓ |

接口：`GET /api/kline/contracts`（`?run=1` 立刻发现、`?list=1` 列出非 TRADING 的）。
`GET /api/kline/recorder` 里也多了一块 `discovery`（最近一次结果 + 累计增删 + 订阅数 + 镜像大小）。

### 行情层带宽：实测与结论（2026-10-07，结论「不做，先记账」）

用户口径：先把「现在的方案是什么」讲清楚，再决定动不动。**实测把原计划否掉了**，
所以这一节是**记账**：数字留在这里，以后想动直接看，不用重新测一遍。

**目前方案**

| 路 | 上游 | 后端 | 兜底 |
|---|---|---|---|
| 行情条（涨跌幅） | 一条 `!ticker@arr`（全市场），走 `/market/ws`，**跟 K 线共用同一条连接**（不占 1024 条流额度） | 只留 6 个字段（`last`/`change24hPct`/`high24h`/`low24h`/`volume24h`/`quoteVolume24h`）转成 `TickerPatch`，SSE `/api/tickers/stream` 下发；前端先 `GET /api/markets` 拿底稿再盖增量 | 上游 **5 秒**没推 ⇒ 退回 REST 轮询（每 5 秒拉全表）；推流回来自动切回。没人听 **30 秒**后退订 |
| 标记价（未实现盈亏） | **逐币** `{sym}@markPrice@1s`，只订**有持仓**的那几个（0~8 个），复用同一条连接 | 给「未实现盈亏逐笔重算」供数（P4 改造） | **6 秒**没收到 ⇒ REST 每 3 秒轮询（2026-10-06 补的：之前上游一哑盈亏就不动） |

**实测（2026-10-07，本地走代理，各 20 秒）**

| 流 | 入站 | 每批币数 | 每币字节 |
|---|---|---|---|
| `!ticker@arr`（现在用的） | **59.6 KB/s** | 212 | 303 |
| `!miniTicker@arr` | **35.1 KB/s** | 212 | 179 |
| `!markPrice@arr@1s` | **151.3 KB/s** | 481（1.9 批/秒） | 170 |
| 8 条单币 `@markPrice@1s`（现在用的，8 个持仓） | ≈ **1.4 KB/s** | 1 帧/秒/币 | ≈170 |

**结论一：`!markPrice@arr` 不能换。** 现在是「按持仓订阅」，实测 **1.4 KB/s**；全市场那条
**151.3 KB/s**，差 **~100 倍**。代码注释里「别订 `!markPrice@arr@1s`」那条是对的。
（顺带确认：单币 `@markPrice@1s` 在 `/market/ws` 路由下**真的在推**，10 秒 10 帧。）

**结论二：`!miniTicker@arr` 解决不了 33.7 KB/s。** 两条流的**推送口径完全一样**
（都是「这秒变过的 212 个币」），差别只在**每币字段数**（303 → 179 字节）。
⇒ 换它省的是**服务器的入站**（−41%，约 25 KB/s）和一点解析开销；而
**33.7 KB/s 是我们推给浏览器的出站**，只由「我们推什么」决定 —— 我们早就只转 6 个字段，
跟上游选哪条流**无关**。Lightsail **只计出站**，所以这一换对账单没有影响。
⚠️ 另有一个坑：`!miniTicker@arr` **没有 `P`（24h 涨跌幅）**，只有 `o/h/l/c/v/q`，
换的话得自己算 `(c-o)/o`。

**真要降出站，只有这三条**（记账备查，别忘掉 A 是唯一量级性的）：

| 方案 | 出站 | 代价 |
|---|---|---|
| **A. 只推可见行** | 一屏 20~40 行 ⇒ **2~4 KB/s**（降 ~90%） | 前端把「当前可见的币」报给后端，后端按这个集合过滤；滚动出新行时补一次底稿 |
| **B. 降频**：1 秒 → 3 秒一批 | **~11 KB/s** | 行情条数字跳得慢一点（K 线、持仓盈亏走另外两路，不受影响） |
| C. 不动 | 33.7 KB/s/人（≈121 MB/小时 ≈ 2.9 GB/天） | 无 |

**为什么决定不做**：整站出站的大头是 K 线底座那部分（见「容量 / 理论用户数」），
行情条只在**有人开着页面看行情**时才有流量，且只有自己用时一天 ~2.9 GB。
⇒ 出站不是当前瓶颈，**先记账**。真要做，优先 A。

### 1 分钟周期 + 本地灌历史 → 导入线上（2026-10-07 追加）

**1m 进了前端周期选择器**（用户：「一分钟的选项 k 也在前端需要」）：
`Timeframe` 加 `'1m'`、`VALID_TFS` 加 `'1m'`、`TF_MS` 加 `'1m'`，前端 `TFS` 加「1分」。
⚠️ 以前请求 `timeframe=1m` 会被 `VALID_TFS` 挡下、**静默按 1h 返回**（2026-10-06 就是这样把
仓位明细那张图变成一小时 K 线的）—— 现在 1m 是正式成员，底座也常驻存它。

**历史数据在本地补、整表导线上**（用户：「历史数据用脚本在本地数据库补上…导入线上数据库」）：

| 脚本 | 干什么 |
|---|---|
| `npm run candles:seed`（`backend/src/scripts/seed-candles.ts`） | 本地按窗口往前补历史：1m/5m 7 天、15m 31 天、1h 180 天、4h 200 天、1d 1000 天。**从库里已有的最早那根往前补**（断点续跑、重复跑不重复拉），限速 `--rps`，`-1003` 就歇 30 秒再来 |
| `npm run candles:sync`（`scripts/sync-candles.sh`） | 本地 `candles` → 线上：`\copy … WITH CSV`（两边 `PGTZ=UTC`），`--replace` 整表替换 / 默认走 `candles_import` 临时表 upsert 合并 |
| `npm run candles:audit`（`backend/src/scripts/audit-candles.ts`） | **连续性审计**：逐（币 × 档）按「行数 vs 跨度」核整条序列，把底座两条路结构上看不见的洞找出来（≈8 秒全 6 档）；`-- --repair` 顺手补。**手动跑**，见第 56 节 |

- ⚠️ **为什么不在线上灌**：线上出口 IP 要跟交易/账户共用权重（2400/分钟），2026-10-07 在线灌历史
  吃到 **85 次 `-1003`**（根因：把 K 线一发的权重按 2 记，实际是 **5**）。历史放本地拉，线上零请求。
- 体积（实测 259~375 B/行）：本次补 ≈1130 万行 ≈ **3.5~4.3 GB**；CSV gzip ≈250~400 MB；
  保留策略生效后的稳态 ≈1420 万行 ≈4.3~5.4 GB（线上磁盘 38 G、剩 23 G）。
- ⚠️ ccxt 的 OHLCV 只有 5 个字段 ⇒ **`seed` 段**的 `quote_volume / trades / taker_buy_volume` 是 0
  （`vision` 段有，见下），所以「每日对账」只比 OHLCV。

**换数据源：1m/5m/15m/1h/4h 改走币安官方历史包**（用户：「灌历史有点慢 能否本地跑不走代理」
「能否调多个数据源，也有其他第三方数据有的吧」）

先实测问题：本地出口把 `fapi.binance.com` 解析到假 IP ⇒ REST 必须走代理；一发权重 5；
把并发提到 `--conc=8 --rps=14` **反而被 `-1003` 反复拦**（3.2 分钟只走完 42 币 ⇒ 全量要 40+ 分钟），
即**提速就撞墙**。于是换 `data.binance.vision`（**币安官方历史数据包，不是第三方**）——
同一个 IP 直连它 HTTP/2 200，直连 `fapi.binance.com` 是空响应。

| 项 | 实测 |
|---|---|
| URL | `…/data/futures/um/{monthly,daily}/klines/{PAIR}/{interval}/{PAIR}-{interval}-{YYYY-MM\|YYYY-MM-DD}.zip` |
| 权重 | **0**（不占 2400/分钟，跟交易/账户不抢） |
| 体重 | 1m 月包 1.8 MB（43,200 行，共 43,201 行含表头）/ 1m 日包 57~62 KB；15m 月包 138 KB；5m 月包 390 KB；4h 月包 10 KB；1d 月包 2 KB |
| CSV | 12 列**带表头**：`open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore` |
| 发布延迟 | 日包 T+1（2026-10-07 03:13 时最新只到 10-05 的包）；**当月没有月包**（月末后才发）⇒ 当月逐日拿 |
| 速度 | 并发 16 实测 **1,067 包/分钟**（24,150 个包 ≈ 23 分钟、0 失败） |

`npm run candles:seed:vision`（`backend/src/scripts/seed-vision.ts`）：

- **1m/5m/15m/1h/4h 走官方包；1d 仍走 `candles:seed` 的 REST**（1d 包是 34 个文件/币，
  REST 一发 1000 根显然更便宜）⇒ 两个脚本分工跑，互不重叠；
- 只设 `EXCHANGE_PROXY`（ccxt 认它）、**不要**设 `HTTPS_PROXY` / `NODE_USE_ENV_PROXY`
  —— 后两个会把裸 `fetch` 也塞进代理，恰好毁掉「包直连」（原因见 `exchange-account.ts` 里那段注释：
  ccxt 自己挂显式 dispatcher，绕过环境变量代理）；
- 断点续跑（库里已覆盖的包直接跳过）、只写**已收盘**的桶、`--dry` 只列计划、`--force` 忽略断点。

**验证（跨源逐字段对照 + 包内自洽）**：同一批 bar 用 REST 再拉一遍 —— 1m/5m/15m/1h 的
`open/high/low/close/volume` 与包**精确相同**；包内自洽：5m 的 `volume/quote_volume/trades`
= 它自己那 5 根 1m 的**精确求和**（571.437 / 48,436,713.86 / 10,660），15m = 3 × 5m，
OHLC 也对（5m high = 5 根 1m 的最高）。
⇒ 包还额外给了 `quote_volume / trades / taker_buy_volume`（REST seed 只能塞 0），
所以 **`candles.source` 多了 `vision` 这个值**，且导入线上后能让那些桶的成交额字段从 0 变成真值。

⚠️ 合并导入的护栏：`candles:sync` 的 upsert 是 `DO UPDATE`（同桶以本地为准），
但本地 `seed` 行的成交额是 0，会把线上那份带成交额的行打坏 ⇒ 加了
`WHERE NOT (EXCLUDED.quote_volume = 0 AND candles.quote_volume > 0)`：
**只允许「有成交额」的覆盖「没成交额」的**，反向一律不动。
同理 `--replace` 的 `TRUNCATE` 会连线上实时在写的尾段一起清掉，**默认就该用 merge**。

**这次的落地结果（2026-10-07）**：本地补全 → 导线上，**两边六档 × 525 币、空洞 0**：

| 档 | 线上行数 | 覆盖 | 档 | 线上行数 | 覆盖 |
|---|---|---|---|---|---|
| 1m | 5,324,132 | 09-30 → 现在 | 1h | 2,222,267 | 04-10 → 现在 |
| 5m | 1,064,409 | 09-30 → 现在 | 4h | 616,097 | 03-21 → 现在 |
| 15m | 1,561,580 | 09-06 → 现在 | 1d | 348,784 | 2024-01-11 → 现在 |

合计 **1113 万行 / 4.5 GB**（线上剩 18 G），100% 来自「vision 961 万 + REST seed + 底座实时」，
线上只付了「导入」这一次的本地 I/O，**0 权重**。

补这一步踩到并修掉的两个坑（都是**静默**的，值得记）：

1. **`ssh host "bash -s" <<'EOS'` 会被脚本里的命令吞 stdin** —— 同步脚本原来就是这个写法，
   于是那次导入**跑到一半静默作废**：退出码 0、没有报错、「已合并」那行没打印，
   1088 万行只零星进了几十万（线上 1m 还停在「只有最近 28 分钟」）。
   改成「先把远端脚本 `cat` 落成文件、再 `bash 文件`（stdin 给 /dev/null）」，
   并加上「临时表行数 / 线上行数」两个可见标记 ⇒ 再也不会静默半途而废。
2. **窗口两端没对齐到桶栅格** ⇒ 头部会算出「不到一根」的残缺缺口（白拉一发、写 0 行），
   尾部会把**正在走的当前桶**写进去（残桶）。改为两端都 `floor` 到桶栅格，只处理「已收盘的桶」。

⚠️ 还有一条时序教训：**导出时点必须晚于「本地补洞」跑完**。
这次先在 12:00 导出、12:11 才补完高周期尾洞 ⇒ 那批行没进 CSV，
线上 11 个币（BLUR/SUI/METRA 等）的 5m/15m/1h/4h 留下尾洞，只好再增量补一次。
为此给 `candles:sync` 加了 `--since='30 hours'`：**只导最近这一段**（这次 119 万行、几十秒），
补尾洞不必再搬 1000 万行；`--replace` 与 `--since` 互斥（先清空再灌一段 = 把历史删了）。

---

## 38. 平仓即撤单 + 拖动两条路 + 成交事件的载荷（2026-10-07 用户）

用户这一轮三句话，各自对应一处改动：

> 「1.只改已经有的挂单要移动本身，仓位的派生」
> 「2.持仓订单已经全部平仓了，那么他的挂单止盈止损要全部撤单，目前有延迟」
> 「持仓，挂单等 5 个 tab 我发现不是实时的，有延迟」

### 38.1 拖动两条路（`KlineChart.vue` 的 `drawDragPreview`）

判据是 `DragRef.kind`，两条路**不能混**：

| 拖的是 | 意思 | 线的行为 | 标签的行为 |
|---|---|---|---|
| **已挂的单**（`kind: 'order'`） | 改单（后端撤旧挂新） | **挪原来那条**（`overlayLines.set()` 换个价重画） | 原来那枚就地换文字（`止盈 │ +$0.52 │ 100%`，形状本来就一样） |
| **仓位线**（`kind: 'pos'`） | **新挂**一张止盈/止损 | 原线**一动不动**，`setPreview()` 另画一条虚线 | 另起一枚 `.olb.drag`（不带动「✕」） |

为什么仓位那条必须派生：仓位线不是订单，挪它没有意义；而那条**已挂的单**本身就是那张单，
派生一条反而会出现「场上有两条线、只有一条是真的」。

同一处顺手修的：**按一下标签不再立刻改成预览**。原来 `ordLabelDown` 就调
`drawDragPreview()`，于是「点一下标签露出 ✕」会把线上/标签文字先变成
`止盈 +$0.00 100%`（手指没动）；现在越过 **6px** 门槛才算拖（跟 `ordLabelUp`
判「点 vs 拖」用的是同一个门槛）。

### 38.2 平仓 ⇒ 当场撤残留止盈止损单（后端触发）

**原来为什么有延迟**：撤残留单**只有前端那一条路** —— K 线页带 `?symbol=` 顺手清当前币
（当年是 15 秒一轮的轮询；那条轮询已经删了，现在是「读到这个币的挂单时顺手清」+ SSE 事件触发）、
进页面 + 每 5 分钟整账户一次。没人看页面就没人撤；整账户那发还是
**40 权重**（2026-10-06 把 IP 打进 `-1003` 的元凶）。

现在由**后端在收到平仓事件的那一刻**做（`exchange-stream.ts`）：

* `applyAccountUpdate()` 多返回一个 `closedSymbols` —— 「原来有持仓、这一批 `pa = 0`」的币
  （判据必须是 `idx >= 0`：一条 `ACCOUNT_UPDATE` 里常带一堆**本来就没仓位**的币，判宽了
  就是对着空仓白打一串请求）；
* `ACCOUNT_UPDATE` 分支里 `if (closedSymbols.length) this.sweepOrphans(closedSymbols)`；
* `sweepOrphans()` 去抖（`ORPHAN_SWEEP_GAP_MS`，同币；**原来是 30s，38.5 里改成了 10s**）+ `runSweep()` 真正去撤：
  `chargeWeight(7, 'orphanOrders')` → `cancelOrphanOrders(credsOf(row), symbol)`
  → 撤成功就**就地删库里的行**（不走 40 权重整账户对账）+ 减计数 + `emit orders`。

⚠️ **必须有一次重试**（`ORPHAN_SWEEP_RETRY_MS = [1200, 2500]`）：我们这条触发是 **WS 事件**
（币安说 `pa = 0`），而 `cancelOrphanOrders` 撤之前要**重新读一次 REST 持仓**当保险
（「仓位还在就一张也不撤」，防的是「平了又立刻开回来」）。两个源有时差，**第一次常常一张也撤不到**
—— 实盘就撞上了：第一次 `checked = 2 / cancelled = 0`，30 秒去抖又把重试关掉，
最后只能等前端那条轮询，等于没修。判据用 `checked > 0`（看见了平仓单却没撤）
而不是「持仓数 > 0」（那是**整个账户**的持仓数，别的币有仓也会误判）。

**实测（本地 key 7，真开真平 26 APT ≈ 20u，日志带时间戳）**：

| 时刻 | 事件 |
|---|---|
| 16:13:00 | 平仓请求返回，两笔成交入账（`10 + 16` 两个 partial fill） |
| 16:13:00 | `ACCOUNT_UPDATE` 报 `pa = 0`（WS 比 REST 快，这就是必须重试的原因） |
| 16:13:05 | `仓位平掉（APTUSDT）⇒ 当场撤掉 2 张残留平仓单` |

一轮 5 秒 = 平仓 REST 飞行 + `positionRisk`(5) + 带 symbol 的挂单(1) + 两张撤单，走本地 SSH 代理。
比原来「没人看就永不撤 / 有人看要等下一轮轮询」好一个量级，且**不需要有人看着页面**。
前端那两条轮询留着当兜底（WS 事件也会丢）。

离线夹具（`npm run selftest` 新增一组 10 例）直接驱动**真的那份 `applyAccountUpdate`**
（`KeyStream` 为此导出，只为自检）+ 固定时钟卡去抖：判宽（对空仓的币也发起撤单）、
判窄（漏掉真平仓）、去抖写反（扫一次就永远不扫）都卡得住。

### 38.3 5 个 tab 不实时：`fill` 事件的载荷少了 `id`

「持仓 / 挂单 / 仓位历史 / 成交历史 / 资金动向」这五格，实测四格本来就是秒级，
只有**成交历史 + 仓位历史**慢（实测 `仓位历史` 慢 **5.2 秒**，且一个仓分 3 笔成交时
后两笔**根本不出现**）：

* 后端 `fill` 事件发的是 `{symbol, side, price, amount, fee, realized, ts}`；
* 前端 `ExchangeTrade` 要的是 `{id, symbol, side, price, amount, cost, fee, feeCurrency, realized, datetime}`；
* 前端去重那行是 `if (fills.value.some(f => f.id === t.id)) return` —— `t.id` 是 `undefined`，
  列表里一旦躺了一条 `id: undefined`（就是第一笔），**后面每一笔都被这行挡掉**；
* 副作用：`datetime` 缺 → 那一行时间是空的（排序也按 `datetime`，插进去的位置也是错的）。

修法（两边都要）：后端这条事件改成跟 `/api/exchange/fills` **同一个形状**（`FillRow`，
带上 `id = tradeId` / `datetime` / `cost` / `feeCurrency`）；前端那行改成 `if (t.id && …)`
（`id` 缺失时**别去重** —— 宁可重复一下，下一轮 `loadFills()` 会用整份覆盖回来），
并在 `fill` 里**顺手 `loadIncome()`**：钱账本（已实现 / 手续费）后端在**同一条 WS 帧里**
也写了一份，不重读的话「资金动向」要等下一轮 `income` 事件（那是**对账**的节奏，normal 档 8 小时）。

**修完实测（同一台机器、同一页面、真开真平）**：

| 格 | 修前 | 修后 |
|---|---|---|
| 持仓 | 366 ~ 537 ms | 不变（本来就快） |
| 挂单 | ~200 ms（去掉下单接口自身耗时） | 不变 |
| 成交历史 | 11.6 s（且分笔丢） | **105 ~ 116 ms** |
| 仓位历史 | 5.2 s | **211 ms** |
| 后端推送侧（SSE 直连观测） | `positions` / `fill` / `orders` 都在 **0.2 ~ 0.5 s** 到 | 不变 |

### 38.4 市价单不该出现在「挂单」里（2026-10-07 用户）

> 「我在币安 app 下单市价成交，挂单中出现市价的订单，这是问题」

抓到的证据（`exchange_open_orders` 里那一行的 `raw`）：

```json
{"o":"MARKET","X":"PARTIALLY_FILLED","z":"2096","q":"10732","s":"PUMPUSDT","i":6838180256}
```

两处问题叠在一起，**都得修**：

1. **市价单根本不该写进「挂单」表**。币安对市价单也会先推一条 `X=NEW`「受理了」，
   我们的 `syncOrderFromEvent` 照着写库 ⇒ 它就成了「挂着的单」。
   现在：类型**正好等于 `MARKET`** 的直接走「不在场」那条路（删 + 不发事件）；
   ⚠️ 条件单名字里也带 MARKET（`STOP_MARKET` / `TAKE_PROFIT_MARKET`），那些是**真会挂**的，别一起挡。
2. **订单事件是并发处理的**。同一次市价成交连推三帧 —
   `NEW` → `x=TRADE X=PARTIALLY_FILLED` → `x=TRADE X=FILLED`，实测三帧**前后差 1 毫秒**；
   而 WS 的 message 回调**不会等**上一次的 async 处理做完 ⇒ 「FILLED 的删」和
   「PARTIALLY_FILLED 的写」一交错就**删完又被写回来**（库里那一行 `raw` 正是 PARTIALLY_FILLED，
   就是这条留下的）。现在订单 / 条件单事件走一条 `orderChain` **串行队列**（不 await 上游读帧，
   只保证写库按到帧顺序）。

**实测（探针直接调 `placeOrder`，绕开 HTTP 路由里那次下线后的整表对账，才看得见真相）**：

| | 修前 | 修后 |
|---|---|---|
| 市价开仓后表里 | 400ms 就出现 `MARKET APTUSDT`，2.5 秒后还在 | **一直是空** |
| 条件单（STOP/TP） | 正常入表 | 正常入表 |

### 38.5 去抖把「真的又平了一次」吞掉（同轮实测抓到的）

上面组合验证里出现过一次「平仓后残留止损单 30 秒都没撤」：上一轮清仓（**空扫**也记去抖时间）
之后 **11 秒**又平了一次仓 ⇒ 整轮 sweep 被 30 秒去抖跳过，那张单一直挂到 2 分钟对账。

两头都收紧了：

* 去抖间隔 **30s → 10s**；
* 这个币**重新开起来**（`applyAccountUpdate` 的 `newSymbols`）就**清掉**它的去抖记录
  —— 「又开又平」必须能再扫一次；
* 被去抖跳掉时打一行日志（免得下次又变成「悄悄地没撤」）。

**实测**：同一账户连续两轮「市价开 → 挂条件单 → 平」，两次都在 **3.3 / 3.4 秒**撤掉残留单，
交易所侧收尾 0 挂单 0 持仓。

### 38.6 持仓的「已实现盈利」口径 + 全平型条件单的 0%（2026-10-07 用户）

> 「1.核对持仓的已实现盈利数值不对 2.我在手机下现价全部止损，但是在图表 k 上显示 0%」

**① 已实现盈利：以前算的是「这个交易对」的累计，不是「这条持仓」的**

用户截图那条 PUMP 多单（20x，开仓价 0.006583）—— 卡片写 **−$0.40**，可这条仓位自己
只有开仓手续费 **−$0.0353**（账本里 12 行 PUMP 记录，其中 9 行是**前面已经平掉的三个来回**：
−0.0925 / −0.2756 / −0.0792 …）。`realizedOf()` 原来是「把这个币账本里的行**全加起来**」，
币安 App 在持仓行上给的是**这条持仓**的数 ⇒ 就是用户说的「不对」。

改法：取「**还没平完的那个仓位周期**」的 `net`（`openCycles`）—— 那个周期本身就是
「开仓（0 → 有量）到全平」，跟这条持仓一一对应，键（币 + 方向 + 哪套 Key）天然对得上，
口径（已实现 + 手续费 + 资金费，资金费按**时间窗**归段，见 `position-history.ts`）
也跟「仓位历史」那一格完全一致。周期拿不到就画「—」（宁可不说，也别拿别的来回糊上去）。

实测：PUMP 那条卡片的「已实现盈利」**−$0.40 → −$0.04**（= 开仓手续费），悬停文案同步改成
「这条持仓开盘至今的净盈亏」。

★ **口径已跟用户确认（2026-10-07）：就要「这条持仓自己的」**，
  不要「这个交易对的历史累计」—— 后者在同一个币来回做几趟之后会变成一个跟当前
  这条仓位毫无关系的数。

**② K 线上显示 0%：币安「全部仓位」那种条件单没有数量**

用户从手机挂的那张止损，接口里是：

```json
{"orderType":"STOP_MARKET","quantity":"0.0","closePosition":true,"reduceOnly":true,"triggerPrice":"0.006424"}
```

`closePosition: true` ⇒ 币安把 `quantity` 给 **0**（它平的就是**整条持仓**）。
`tpsl.ts` 的 `tpSlOf` 早就处理了这一类（按 100% 算），但 **K 线标签那条路没处理**：

* 百分比 `Math.min(100, o.amount / pos.amount * 100)` = `0 / 10732` ⇒ **0%**；
* 「预计收益」`diff * o.amount` ⇒ 恒等于 **$0.00**。

改法（`KlineChart.vue` 的 `orderLabel`）：数量为 0 就按**整条持仓**算（百分比直接 100%），
跟 `tpSlOf` 一个口径。实测标签从 `止损 $0.00 0%` 变成 **`止损 −$1.70 100%`**（= 整条仓位的盈亏）。

同一类问题顺手清掉（都是「数量 0 当成 0 张」）：

* 「挂单」列表那一行：`数量 0` → **数量 10,732**（按持仓量报，见 `orderQty`）；
* 点开改单弹层：以前开出来是「0 张 / 0%」，现在按持仓量带进去 = **100%**。


## 39. 账本三格：默认 7 天 + 币种下拉 + 周期范围弹窗 + 资金类型（2026-10-07 用户）

用户原话：

> 「仓位历史，成交历史，资金动向 默认显示 7 天的数据，左侧去掉文字标题 改为币种搜索可下拉
>  默认全部，右侧配置一个按钮点击底部弹窗可选择周期范围，提供快捷时间，资金动向还要提供
>  不同类型的资金过滤」

三格现在是同一套表头版式：**左 = 币种下拉（默认「全部」） ｜ … ｜ 计数 ｜ 右 = 周期范围按钮**。

### 39.1 三个维度**分别在哪一层筛**（这个分工是刻意的）

| 维度 | 在哪筛 | 为什么 |
|---|---|---|
| 周期范围（`from`/`to`） | **后端** | 「这一格现在多少笔」跟列表得是同一份数据；前端筛的话计数、空态、合计口径会各说各话 |
| 资金类型（`types`） | **后端** | 同上（资金动向那张表还要按类型看合计） |
| 币种 | **前端**（本地） | 下拉的候选来自「当前范围里出现过的币」，本地筛就不用在每次换币时再打一发请求，也不会出现「选了 PUMP 之后下拉里只剩 PUMP、回不去」 |

后端入口（`server.ts` 的 `ledgerRange()`，三路由都接）：

* `/api/exchange/fills`（成交历史）
* `/api/exchange/position-history`（仓位历史）
* `/api/exchange/income`（资金动向，多一个 `types`）

参数形状：

```
from=1696...  to=1696...            # 毫秒，含端点；不传 = 不限
types=COMMISSION,FUNDING_FEE        # 只有 income 用；`OTHER` 单独当一个标志（见 39.4）
```

⚠️ **`days` 与 `from/to` 是「与」关系**：`listIncome` 原来那个 `days = 7` 默认还在，
所以选范围时**必须把 `days` 传 0**，否则「近 30 天」会被 7 天悄悄卡回去
（实测两者行数一模一样，是最容易漏的那种静默错）。前端 `loadIncome` 现在是 `days: 0` + `from`/`to`。

### 39.2 默认「近 7 天」是**算出来的**，不是让后端挑

`defaultFilter()` 用北京时间（`bjDayStart`）算 `from = 今天 00:00 往前 6 天`、`to = Date.now()`。
用北京时间是因为整站的时间显示（`bjTime` / `bjTimeSec`）都是北京时间，筛出来的边界得跟眼睛看到的一致。

### 39.3 三格**各自独立**（三个 `LedgerFilter`）

```ts
const filters = reactive<Record<LedgerTab, LedgerFilter>>({inc: …, trades: …, flow: …})
```

三格是三个不同的列表、右上角各有各的按钮 ⇒ 状态也分开。
**如果你想改成「一处改、三格都跟着变」，改这一处就行**（`filters` 换成一份共享对象 + 三格读同一份，
`rangeLabel/rangeOf/...` 都按 `tab` 取，所以改起来只在 `filters` 的定义处）。

### 39.4 底部弹窗 `LedgerRangeSheet.vue`

* **快捷时间**：今天 / 近 7 天 / 近 30 天 / 近 90 天 / 自定义；
* **自定义**：两个 `<input type="date">`（起 / 止，北京时间，止按 **23:59** 收尾）；
* **资金类型**（只有资金动向有）：全部 / 已实现 / 手续费 / 返佣 / 资金费 / 划转 / 强平 / **其它**；
  `其它` = 币安给的 `income_type` **不在**我们认得的清单里（`OTHER`，送后端时从 `types` 里摘出来单独当标志）；
* 底部那句 `2026-10-05 00:00 → 2026-10-07 23:59 · 当前筛出 119 笔` 是**草稿的实时预览**（点「完成」才生效）；
* 草稿态：`draftRange / draftFrom / draftTo / draftTypes`，只有 `apply()` 才 emit（关掉不落库）。

⚠️ **「要不要画资金类型那一段」不能拿 `types` 的真假当开关**：`types` 默认是 `null`（= 全部），
当开关的话这一段会在**默认状态下整段消失**（第一版就是这么写的，实测「资金动向里根本找不到类型过滤」）。
现在用的是独立的 `typeFilter` 布尔。

### 39.5 币种下拉（复用 `SymbolCombo`）

三格用的是同一个组件的 `plain` 模式（无外框、标题位置就是下拉本身）：

* 空值文案 = **「全部」**（`placeholder="全部"`），列表**最上面**还有一颗「全部」（`all-label`，选中 emit `''`）；
* 候选 = **当前范围里出现过的币种**（`symbolOptions()` 去重排序），所以列表跟着范围收窄；
* ⚠️ 比的是**币种简称**（`baseOf`）：下拉给的是 `PUMP` 这种简称，而 `pairOf('PUMP')` 会**原样返回**
  `'PUMP'`，拿它去比 `PUMPUSDT` 永远配不上 —— 第一版就是这里筛了个空。

### 39.6 按钮文案 / 高亮 / 空列表文案

* 资金动向那颗按钮：**类型和范围都要看得见** ⇒ `手续费 · 10-05→10-07`（只显示类型的话范围就藏起来了）；
  没筛类型时只显示范围（`近 7 天` / `今天` / `10-05→10-07`）。
* 高亮 `.on` 只看**范围/类型**是否非默认（`rangeOn`）—— 只换币种不高亮，因为币种在左边下拉里看得见。
* 空列表文案分岔（`filtered`）：默认状态是「账本里还没有…」，筛过之后是
  「**这个筛选条件下**没有…（换个币种或周期范围试试）」，免得用户以为数据丢了。

### 39.7 一次取多少条（`LEDGER_MAX`）

`60 / 200 / 50` → **`500`**：带范围之后选 30 / 90 天，按原来那几十条取就是「筛出来的比实际少」
（静默的假数据）。后端 `listFills` / `listIncome` / `listPositionHistory` 各自的上限是 `500 / 2000 / 500`。
列表还是**按需铺**的（窄屏一屏 20 条、滚到底再铺），所以放大上限只等于「允许往下滚更多」。

### 39.8 实测（本地，1280 宽 + 390 宽各一轮）

| 操作 | 结果 |
|---|---|
| 默认 | 仓位历史 `37 笔已平 · 近 7 天`、成交历史 `119 笔`、资金动向 `239 笔`，三颗按钮都不高亮 |
| 仓位历史 → 今天 | `27 笔`（7 天 37 → 今天 27，说明 `closeAt` 真按范围切了），另两格不动 |
| 成交历史 → PUMP | `9 笔`（列表行数一致）；下拉里仍有「全部」，选回 → `119 笔` |
| 资金动向 → 自定义 10-05→10-07 + 手续费 | 按钮 `手续费 · 10-05→10-07`，`119 笔`、每行类型都是手续费；弹窗再打开时选中的就是这两项（草稿回填对） |
| 资金动向 → 其它 | `0 笔` + 新空态文案「这个筛选条件下没有资金变动…」 |
| 资金动向 → 手续费 + 资金费 + 其它（多选） | `143 笔`（= 119 + 24 + 0，多选是**叠加**的） |
| 390 宽（手机） | 表头一行放得下（组合 43 + 计数 34 + 按钮 148）；弹窗整宽贴底、无横向溢出、类型胶囊换行 |

⚠️ 三格筛选是**三份独立状态**（每格一个按钮）。要共用一份得改 39.3 那一处。

### 39.9 表头两个「看着像小事」的坑（用户当天就指出来了）

做完 39 之后用户连着两句：「**标题栏间距太大了**」→「**全部 字体过大**」。都是表头引进来的：

**① `.empty` 撞名 —— 表头被撑到 65px**

`SymbolCombo` 的 `plain` 模式里，占位那档我给它挂了 `class="empty"`（想表达「空值」），
而全站的 `.empty` 是**空态块**：

```css
.empty { color: var(--muted); font-size: 12px; text-align: center; padding: 22px 0; }
```

⇒ 那颗标签拿 22px 上下内边距 + 居中，量出来 **57px 高**，把 `.pn-h` 整行顶成 **65px**。
类名改成 `ph`（跟 `.empty` 不撞），表头回到 **24px**（跟右边那颗「近 7 天」同高）。

⚠️ 教训：自己起的「语义化类名」先查一遍全站有没有同名的通用类（`.empty` / `.dim` / `.on` …）。

**② `plain` 模式默认 15px —— 那是给「标题」用的**

`.combo-plain` 的 15px / 中粗是合约页那颗**当标题用**的币种名。账本表头旁边的
「N 笔 / 近 7 天」是 **11.5px**，摆在一起就是「全部 字体过大」。

给账本三格的下拉挂 `.pn-sym`（`class` 落在子组件根 `.combo` 上），在 board 的
`<style scoped>` 里用 `:deep()` 压到 **12px**、箭头 **10px**（`:deep()` 是因为
`.combo-plain` 长在子组件模板里，拿不到本组件的 scope 属性）。选中币种仍是 600 粗，
占位（400 + 压暗）跟真选了分得开。

实测（1280 / 390 两个宽度、三格都量过）：表头 **65px → 24px**；390 宽那一行
下拉 42 + 计数 34 + 按钮 63，一行放得下、无溢出。

## 40. 挂单那一格：币种 + 类型筛选，右侧「全部撤单 N」（2026-10-07 用户）

用户原话：

> 「挂单顶部也加过滤条件，右侧加全部撤仓」→ 追问后定的口径：
> 「撤『当前列表里这些』——跟着账户 + 币种筛选走，按钮上直接显示要撤几张」、
> 「需二次确认」、「提示层真单的那种去掉，都是真单」。

### 40.1 版式：一行三段

```
[全部 ▾]  [全部][限价][止损][止盈]              [全部撤单 2]
 币种下拉        类型胶囊（只画这批挂单里真出现过的档）      撤单（带张数）
```

* **币种下拉**跟账本三格同一套（`SymbolCombo` `plain` + `「全部」` + `.pn-sym` 那档字号）；
* **类型胶囊**按 `orderKind()` 的口径分三档（`plain` 限价 / `stop` 止损 / `profit` 止盈，
  `TRAILING_STOP` 也算止损）—— **只在当前这批挂单里出现过才画**，
  没出现过的档不占位置（所以平时就一两颗）；
* 面板窄的时候让**胶囊那一块**横向缩（`min-width: 0` + `overflow-x: auto`，
  滚动条藏掉），右边那颗撤单始终整颗露在外面 —— 它是要点的。

### 40.2 筛在前、铺在后

`filteredOrderGroups`（先筛）→ `visibleOrderGroups`（再按 20 条一屏铺）→ `tabTotal`。
⚠️ 顺序不能反：先铺后筛会出现「筛出 3 张，列表里只有 1 张」（那张在后面 20 条之外）。

### 40.3 「全部撤单」撤的是**列表里现在这些**

不是「账户里的全部」——跟着**当前 tab 选的账户** + **上面的币种 / 类型筛选**走。
按钮上直接写张数（`全部撤单 2`），悬停写出范围（`撤掉列表里这 2 张（APT）`）。

* 载荷 `{items: [{keyId, symbol, orderId}]}`，**每项自带 `keyId`**：
  「全部」那一格可能横跨两套账户，一条请求里就混着两家；
  `keyId` 是**前端取数时贴上去的**（`loadOrders` 按账户取，顺手 `keyId: k.id`）——
  后端那份载荷里没有这个字段。
* 后端按 `keyId` 分组，一组一次循环，撤完各撤各的缓存（`reconcileKeyOrders`）。

### 40.4 后端批量撤单（`cancelTradeOrders` + `POST /api/exchange/trade/cancel-orders`）

* **一张一张来**，两张之间歇 `CANCEL_GAP_MS = 120ms`：币安撤单 weight 1，
  但用户可能一次挂十几张，并发轰出去是最容易被限速的姿势；
* 去重（`symbol|orderId`）+ 上限 `CANCEL_MAX = 200`；
* 一张失败**不停下**（继续撤后面的），但「这把 Key 根本不行」那类错
  （限流 / IP 白名单 / Key 不对 / 没权限 / 接口调不通 / 网络）会**当场收手**，
  剩下的标成「前面那张撤失败后收手了」—— 那不是某一个币的问题，硬撤只会打进 `-1003`；
* 返回 `{ok, cancelled, failed:[{symbol, orderId, error}]}`：**部分失败照实报**
  （前端 toast 成「撤掉 N 张，M 张没撤掉：<第一条第原因>」）；
* `-2011 Unknown order sent.` 单独翻成人话（「这张单在交易所已经不存在了（可能刚撤过或刚成交）」）——
  两个页面同时点「全部撤单」时这条最常见，别把 `binance {"code":-2011,...}` 甩给用户。

### 40.5 二次确认 + 文案（「真单」前缀全去掉）

确认框（`askConfirm`，`danger: true`）：

```
撤掉这 2 张挂单？
  账户：测试 + 币安
  范围：APT
  撤掉之后这些平仓保护就没了。
        [取消]  [全部撤单]
```

★ 用户 2026-10-07：「**提示层真单的那种去掉，都是真单**」⇒ 确认框里不再写
「真单：…」「真撤：…也没有测试版」这种前缀（只有真·测试单那一档才标注「测试单」）。
同一轮顺手清掉的（都是「真单」这个前缀/标记）：

| 位置 | 改前 | 改后 |
|---|---|---|
| `StopSheet` 主按钮悬停 | `真单：触发后按市价平掉 30%` | `触发后按市价平掉 30%` |
| `OrderPanel` 一键平仓标题 | `一键平仓（真单）？` | `一键平仓？` |
| `OrderPanel` 一键平仓 / 全平悬停 | `…（真单）` | `…`（测试单那一档照旧标「测试单」） |
| `ReduceSheet` 平仓悬停 | `平仓（真单）` | `平仓` |
| `OrderPanel` 顶栏那枚常驻「真单」章（`.ord-live`） | 真单模式下一直红着 | **整颗删掉**（用户：「也去掉，那个章现在只是噪音」）+ 样式一起删 |

⚠️ 删了「真单」章之后，**怎么知道现在是哪种模式**：测试模式下**下单 / 挂止盈止损的按钮
上会写「测试」**（`StopSheet` 那颗是 `测试挂止盈`），真单模式什么都不写 —— 这也正是
用户要的效果（「都是真单」）。

### 40.6 实测（本地，key 7「测试」真挂一张再撤掉）

为了验「撤的就是列表里这些」，先**真挂**一张不会成交的限价单：
`APTUSDT 买 7 @ 0.745`（当时现价 0.8139，离 8% 以上，`test:false`）。

| 步骤 | 结果 |
|---|---|
| 「测试」账户 → 挂单格 | `挂单 2`：`APT/USDT 测试 1 单` + `1000CHEEMS/USDT 测试 1 单`（后一张是用户的止盈保护单），胶囊 `全部 / 限价 / 止盈` |
| 点「限价」胶囊 | 只剩 `APT/USDT`，按钮 `全部撤单 1` ✅（止盈那张的组不在了） |
| 点「止盈」胶囊 | 只剩 `1000CHEEMS/USDT` ✅ |
| 币种选 `APT` → 全部撤单 | 确认框「账户：测试 范围：APT」→ 点确认 → toast `已撤掉 1 张挂单`，列表空，按钮 `全部撤单 0`（禁用） |
| **交易所复核**（`/api/exchange/trade/open-orders?id=7`） | 只剩 `1000CHEEMSUSDT TAKE_PROFIT_MARKET` ✅ —— 用户那张保护单**没被碰** |
| 库里复核 | `key 7 = 1000CHEEMSUSDT`、`key 9 = PUMPUSDT` ✅ 两张保护单都在 |
| 筛空时的空态 | 币种仍停在 `APT` → `这个筛选条件下没有挂单` + 按钮禁用 ✅ |
| 多账户分组（bogus 单号，7 + 9 各一条） | 两套都试了、两条都回「这张单在交易所已经不存在了…」✅ 证明按 `keyId` 分组生效 |
| 390 宽 | 表头 **24px** 一行放得下：下拉 42 + 胶囊 137 + 撤单 77，不溢出、胶囊不需要横滑 ✅ |

## 41. K 线的挂单线（止盈止损）不再干等 15 秒（2026-10-07 用户）

用户：「**k线止盈止损渲染感觉慢了一步**」。

### 41.1 实测基线：真的慢 15.3 秒

量法：把图停在一个**没有任何挂单**的币上（key 7「测试」的 `APT`），
从页面里 `fetch` 直接挂一张不会成交的限价单（**不经过我们那套「下单后立刻重读」的代码**，
模拟「在币安 App 上挂的」），然后每 50ms 看一次左边那枚挂单标签什么时候出现：

| 时刻 | 事件 |
|---|---|
| 0ms | `POST /api/exchange/trade/order` 发出 |
| 687ms | 币安回执（`orderId` 拿到） |
| **15,338ms** | 图上那条线 + 标签**才出现** |

15.3 秒 ≈ `KlineChart` 里 `OVERLAY_MS = 15_000` 那一轮 —— 图上那几条线的数据
（`/api/exchange/trade/open-orders?symbol=`）**只有**这一条来源。

### 41.2 根因：持仓走 SSE 了，挂单还在原地

2026-10-06 的改造 P1 把**持仓**改成订阅共享 store（`positions.ts` → `/api/exchange/stream` 的
`positions` 事件），所以仓位线是秒级的。但**挂单**（止盈 / 止损 / 委托）那条路没改，
还是一条 15 秒的轮询 —— 同一个图上，仓位线跟手、挂单线慢半拍，正是用户说的「慢了一步」。

后端其实**早就在推** `orders` 事件了（WS 用户数据流看到挂单变动 / REST 对账后都会 emit，
我们自己的操作和币安 App 上的操作都会推），只是 K 线页没订。

### 41.3 改法：把 `orders` / `fill` 当「该重读了」的信号

* `trade-overlay.ts`：`bindOverlayPositions()` 里顺手订一条 SSE
  ```ts
  stopOverlayEvents = exchangeStream(keyId, {
    orders: () => overlayBump.value++,
    fill: () => overlayBump.value++
  })
  ```
  ⚠️ **同一条连接**：`sharedSse` 按 path 复用（`/api/exchange/stream?id=N`），
  `positions.ts` 那条已经开着了，这里不会再开第二条。
  ⚠️ 推来的**只是信号**：线本身照旧直连交易所那次读（带 symbol，权重 1），
  不是拿 `orders` 的载荷去画。
* `KlineChart.vue`：`watch(overlayBump)` → 两段节流 → `pullOverlay()`
  * **去抖 250ms**：一次挂 / 撤单后端会连推几条（`NEW` → 对账 → …），先合并；
  * **最小间隔 700ms**：那几条有时前后差几百毫秒（去抖挡不住）—— 实测一次下单会引来
    **3 发**「重读挂单 + 重读成交」，带上最小间隔只剩 **1~2 发**。
  * 里面照样判 `overlayWanted()`（不在前台 / 图没被看着 / 四个开关全关 ⇒ 一次都不打）。

### 41.4 实测（同一套量法，改完再量一遍）

| 动作 | 改前 | 改后 |
|---|---|---|
| 挂一张（不经过页面那套刷新代码） | **15,338ms** 才出现 | **1,844ms**（含 208ms 回执）；第二张 **1,755ms** |
| 撤一张（同样不经过页面那套） | ≤15s（同一轮） | **1,686ms**（含 156ms 回执） |
| 一次下单引来的「重读」发数 | 3 发 | 2 发 |

剩下那 ~1.5 秒 = 币安 WS 推订单更新（100~500ms）+ 去抖/间隔 + 直连交易所那次读
（本地走 SSH 代理，约 0.3~0.5 秒）—— 已经不是「等定时器」的量级了。

★ 我们**自己**在图上拖出来的单 / 点叉撤掉的单本来就更快：那两条路（`submitStop` /
`cancelOrderAsk`）在接口回来之后**立刻**调 `pullOverlay()`，不用等 SSE。

### 41.5 那条 15 秒轮询**整条删掉**（用户 2026-10-07：「怎么感觉还是有 15s 这类原来逻辑的代码」）

SSE 接上之后 `OVERLAY_MS = 15_000` 那条轮询就是纯冗余了 —— 删掉它连同 `overlayTimer` /
`syncOverlayTimer()` 和散在五处的调用点，一个不剩（`grep` 过：`OVERLAY_MS` 只在那段注释里
作为「删掉的东西」出现）。删了之后**没有任何定时器**在拉订单信息，触发点全在事件上：

| 触发 | 来源 |
|---|---|
| 进页面 / 切回来 / 回前台 / 换币 / 换「下单账户」/ 动那四个开关 | 组件自己的 `watch` + `onMounted` |
| 挂单变了、新成交、**上游流哑了或恢复**、**长连接重连** | SSE（`overlayBump`） |
| **连 SSE 都断着** | `positions.ts` 那 60 秒的 REST 兜底（只在 SSE 静默 30 秒后才真发），跟着补一拍 |

⚠️ 最后一行是必须的：没有它，长连接要是彻底断了，挂单线会一直冻着（`positions.ts` 也面临
同一个问题，所以那一拍本来就存在，这里只是**跟着它走**，没有新增定时器）。

实测（删掉定时器之后，同样的量法）：挂一张 **1,623ms**（含 189ms 回执）、撤一张 **1,660ms**。

### 41.6 顺手说清两个边界

* **拖动中不重画**：`renderOrderLines()` 开头有 `if (drag.value) return`（这一拍的数据回来
  会把左边标签的下标打乱，正拖着的那枚会指向别人）。SSE 这一路也走同一个函数 ⇒ 一样被挡住；
  数据本身照更新，**松手**时 `ordLabelUp` 会补一次 `renderOrderLines()`。
* **换账户 / 关开关**：`unbindOverlayPositions()` 里把这条 SSE 也退订（不然切页之后还在收）；
  四个开关全关时 `bindOverlayPositions` 直接不订（`overlayEnabled()` 把关）。

## 42. 「人不在线的时候，后端还会关 WS 吗？」（2026-10-07 用户）

用户问：「现在我的合约有仓位的情况下，后端还会关闭 ws 吗」+「人不在线」。

### 答案：不会。三层都不成立

| 层 | 会不会因为「没人看」关掉 |
|---|---|
| **用户数据流 WS**（listenKey 那条） | **不会**。它只有两个关闭点：`restart()`（重连，当场重开）和**进程退出**（`stopExchangeStreams()`，部署时）。 |
| **档位**（决定 REST 对账频率） | **有仓 / 有挂单就永远是 `normal`**（见下）。 |
| **标记价 WS**（`syncMarks()`） | 只跟**有没有持仓**走，跟有没有人看无关。 |

**① 「没人看就断 WS」那套 2026-10-07 就撤掉了** —— 原因记在第 19 节：曲线的密度靠那条流的
live 点，断连等于把曲线数据源掐掉；而 WS 连接**不吃权重**（权重只算 REST），
断它省的是「整洁」，换来的却是曲线稀疏。

**② 有仓 / 有单时连降档都不会发生。** 判据（现在抽成了纯函数 `tierOf()`，见
`backend/src/scripts/selftest.ts` 里那 8 组夹具）：

```
tierOf({positions, openOrders, idleMs, deaf})
  deaf                                   → normal   // 流哑了必须用正常档兜底
  positions > 0 || openOrders > 0        → normal   // ★ 有仓/有单，永远 normal
  idleMs <= 10 分钟                       → normal
  idleMs > 2 小时                         → asleep
  否则                                    → idle
```

⚠️ 「有仓/有单 ⇒ normal」不是速率问题，是**安全**问题：`asleep` 档会把成交 / 挂单 / 账本
的对账**整条停掉**（醒来一轮补上），而止盈止损还在场的时候，那几个小时正好最需要算准。

**③ 睡着档也**不断 WS**：`TIER_GAPS` 那段注释写得很直白 —— 「校准照跑、**WS 照连**（曲线点靠它）」，
睡着只是 `reconcileTick` 直接 return（一条对账都不跑，醒来一轮补上）。

### 「人不在线」到底省了什么

只省**展示用**的东西，跟仓位安全无关：

* 那发 **25 权重的展示快照**（可用余额 / 资产明细 / C2C / 现货）—— 没人看就不打
  （钱包余额 / 持仓 / 浮盈 / 强平那几项是 WS 事件**直接改对**的，一秒都不差）；
* 前端那条 SSE 自己（关页面 / 切后台就断，回来重连；后端 WS 不受影响）。

★ 另外一句要紧的：**止盈止损是挂在币安服务器上的**，触发与否跟我们在不在线毫无关系；
我们的流只决定「我们这边看到的快不快、账记得准不准」。

### 顺手加的诊断（`healthTick` 每 5 分钟那行）

原来只有「事件 / ping / 收了多少 KB」，现在多三个字段，一眼能看出「没人看流还开着吗」：

```
[exch:9] 用户数据流统计：事件 1 帧 / ping 5 个 / 收 0.6 KB（连上 15 分钟，已解析不了 0）
         · 观察者 3 · 档位 normal · 持仓 1 / 挂单 2
```

* `观察者` = 有几个 SSE 订阅者（0 = 没人在线）；
* `档位` = `normal` / `idle` / `asleep`（有仓有单时永远是 normal）；
* `持仓 / 挂单` = 这一档判据里那两个数（`positions.length` / `openOrderCount`）。

## 43. 持仓 / 资金曲线对账 + 三种场景（2026-10-07 用户问）

用户问：「现在合约持仓和资金曲线能对上吗」，外加三种情况：
① 没仓位 + 没在线 ② 有仓位 ③ 没仓位但现在有充值等资金变化。

### 43.1 口径：曲线那个「净值」到底是哪几个数

`listCurve()` 里**全仓库唯一一处**（跟 `netOf()` 一致）：

```
close = margin + coalesce(c2c_total,0) + coalesce(spot_usdt,0)
margin = wallet + unrealized        （合约账户 NET，跟币安 totalMarginBalance 同一算法）
```

一条点一行 `exchange_snapshots`（`kind='5m'`），`source` 记它怎么来的：
`live`（内存那份，0 权重）/ `ws` / `poll`（REST 校准）/ `manual` / `boot` / `shutdown`。

### 43.2 实测对账（2026-10-07 17:2x）

| | wallet | unrealized | margin | 持仓 |
|---|---|---|---|---|
| 交易所实时（`/api/exchange/overview?id=9`） | 14.53744219 | −0.86718505 | 13.67025714 | PUMP long 5045 @ 0.0065828（标记价 0.00641091） |
| 库里那条点（`09:18Z boot`） | 14.53744219 | −0.86718505 | 13.67025714 | 同上 ✅ |
| key 7 实时 | 13.46776735 | −0.20872890 | 13.25903845 | CHEEMS long 59130 @ 0.00052394 |
| key 7 库里那条 | 13.46776735 | −0.20872890 | 13.25903845 | ✅ |

**8 位小数全等**（钱包、浮盈、净值三项）。

密度：近 6 小时 key 7 = 234 点、key 9 = 149 点，**最大间隔 5 分钟**（其中 `live` 各 73 个
≈ 每小时 12 个 = 正好 5 分钟一个）。

24 小时里唯一的 **7 小时洞**（北京 02:44 → 09:46）是**机器/进程没在跑**（洞的右端是一条
`boot` 点）；10-06 白天那些 40~60 分钟的洞是**旧版曲线**（只有 REST 采样）留下的 ——
`live` 点从今早 09:51 才开始写（那次重启上的新代码）。

### 43.3 三种情况分别怎么办

`curveTick()` 是那个 5 分钟采样器（`SAMPLE_MS`，钉在挂钟栅格上）里的一拍，顺序不能反：

```
① writeLivePoint()  内存那份就地落库（source='live'，0 权重）
② sampleIfDue()     按档位决定要不要再打一发 REST 全量（三档现在都是 1 小时）
```

★ 第 ① 步**与档位、与有没有人看、与是不是空仓全都没关系** —— 这是曲线密度的唯一来源。

| | 曲线点 | 档位 | 「没人看」影响什么 |
|---|---|---|---|
| ① **没仓位 + 没在线** | 照写，5 分钟一个点（值 = 钱包余额，一条平阶梯，**这是真话**） | 空仓空单 10 分钟 → `idle`，2 小时 → `asleep` | 只省那发展示快照（可用余额 / 资产明细 / c2c / 现货）。`asleep` 时对账全停，但**校准照跑**（1 小时）、**WS 照连**、**曲线点照写** |
| ② **有仓位** | 照写，5 分钟一个点，浮盈用**标记价**重算（每个持仓订了标记价 WS，秒级）⇒ 曲线跟着浮盈走 | **永远 `normal`**（有仓/有单不降档） | 同上（展示快照）；曲线用的 wallet+unrealized 都由 WS 维护，不受影响 |
| ③ **没仓位 + 有充值/划转/资金费** | 下一个 5 分钟点就出现台阶 | 由「有没有仓/单」决定 | 见下 |

**③ 的链路**：充值 / 划转 / 资金费都会推 `ACCOUNT_UPDATE`，事件里带 `B[].wb`（USDT 钱包余额）
⇒ `applyAccountUpdate` **当场**把 `lastOverview.futures.wallet` 改对 ⇒ 最坏 **≤5 分钟**
（下一个 live 点）曲线上就能看到台阶（入金上台阶、出金下台阶）。

⚠️ 两个例外（只有 REST 有，**最多滞后 1 小时**才进曲线）：**现货余额** `spot_usdt`、
**C2C** `c2c_total` —— 它们不跟着 WS 事件走，靠那 1 小时的校准刷。合约账户的余额没这个限制。

⚠️ 还有一个兜底：`writeLivePoint()` 只在「有底稿 + WS 连着」时才写内存那份；
**流哑了 / WS 断了**它会退回 REST 采样（`snapshot('poll')`）—— 宁可多花 25 权重，
也不在曲线上画一条假的平线（那比断档更糟，等于编数据）。

## 44. 挂单成功之后，线要跟提示**同时**出现（2026-10-07 用户）

用户：「我挂单成功，止盈止损已经提示出来了。但是感觉绘制那条线的时候，有将近 1 秒钟的延迟。」

### 44.1 那 1 秒在哪

| 时刻 | 发生什么 |
|---|---|
| 点「挂止盈」 | `POST /api/exchange/trade/stop-order`（真单：撤旧 + 发 algo 条件单），本地走 SSH 代理，**约 0.9~1.0 秒** |
| 接口回来 | `emit('note', '已挂止盈…')` → 提示弹出 |
| 然后 | `void pullOverlay()` → **直连交易所**读一次挂单（300~500ms；要是刚好有一发飞在半路，`inflight` 会让这一发排队，更久）⇒ **线才画出来** |

也就是说：**提示等的是下单往返（跑不掉），线却在等另一次多余的往返**。接口本来就回了
单号 / 类型 / 触发价 / 数量 —— 画这条线根本不需要再问交易所一遍。

### 44.2 改法：乐观插入（`addLocalOrder()`）

`trade-overlay.ts` 新增两个导出（都只改**叠加层的数据**，不碰交易所）：

```ts
addLocalOrder(o: TradeOpenOrder, replaceId?: string)   // 挂单/改单成功后：塞进去（顺手摘掉旧的）
dropLocalOrder(id: string)                             // 撤单成功后：当场摘掉
```

`KlineChart.submitStop()` 在**真单**成功之后按交易所载荷的形状插一条（`id/type/stopPrice/amount/posSide`
全部来自这次响应），然后那次重读照发 —— 它是**校准**，真值回来覆盖这条乐观数据；
SSE 的 `orders` 事件也会补一发 ⇒ 这条乐观数据活不过一两秒。

⚠️ 三条边界：

* **只有真单才插**：测试单根本没挂上去，塞进来会画一条假线；
* **只插当前这张图的币**（`overlaySymbol` 比一下）：换币的一瞬间别把别的币插进来；
* **改单要带 `replaceId = r.canceled`**（后端撤旧挂新，两张不会同时在场上，旧线必须立刻消失）。
  撤单那条路对称处理：`dropLocalOrder(id)`，做到「提示说撤了 = 线上也没了」。

### 44.3 实测（key 7 · 1000CHEEMS，真单）

拖仓位线 → 比例改 10% → 点「挂止盈」，同一次调用里量两个时刻：

| | 之前 | 现在 |
|---|---|---|
| 提示出现 | 972ms（= 下单往返） | 972ms |
| 线出现 | 提示之后**再等**一次直连交易所的读（300~500ms，撞上在飞的那发更久） | **972ms —— 与提示同一毫秒** |

（新标签 `止盈 +$0.1180 10% ✕` = 10% × 该仓位预计收益 $1.18 ✓，用户原来那张 100% 的单没被碰。）

★ 顺带说明：**提示本身那 1 秒是下单往返**（币安那边撤旧 + 发 algo 条件单，本地走代理），
这个省不掉；这次修的是「提示到了线还在路上」。

## 45. 手机 K 线页：整页 120vh，多出来的那一截**只给底部**（2026-10-07 用户）

用户：「k 线的仓位大小感觉太矮了，能把页面高度加到 120vh，多的空间只放底部，滚动条不显示，
拖动区域自动让父级向下，触顶回弹。」（问过一轮，选的是「给底部的下单 / 仓位模块 ——
底部能多显示几行持仓」，K 线保持现在的高度。）

### 45.1 为什么「把页面加高」这一步会变形

底部那格（`OrderPanel.vue` → `.ord`）原来是 `flex: 0 0 auto`：**高度按内容**，不参与分摊。
而画布 `.chart-wrap` 是 `flex: 1 1 auto`，在一屏（100vh）时它是被两边挤下来的 —— 基准其实是
`height: 50vh`，靠 `flex-shrink` 才落到 268px。所以：

* 只把页面拉高 → 画布**立刻长回基准**（422px），多出来的 20vh 全被它吃掉，底部一格一点不涨；
* 只把底部撑高 → 画布反过来被它挤扁（`min-height: 150px` 是地板），页面还是 100vh。

⇒ 必须**同时**做三件事：页面写明 120dvh、画布钉住原高、底部改成吸收剩余高度。

### 45.2 改法（都在 `style.css` 的 `@media (max-width: 900px)` 里，只认「K 线」那一格）

```css
/* ① 页面：内容写到 120dvh 减掉 #app 那圈内边距，滚的还是 #app（它在这格本来就是 overflow: auto） */
body.fixed-viewport:has(.split.m-chart) .analyze {
  min-height: calc(120dvh - 10px - var(--safe-top) - var(--tabbar-h) - env(safe-area-inset-bottom));
}
/* ② 画布：按「一屏时它正好是多少」定死（576 = #app 上下内边距 69 + tab 行 49 + 图头 217 + 图下那圈 241） */
.split.m-chart .chart-side .chart-wrap { flex: 0 0 auto; height: calc(100dvh - 576px); }
/* ③ 底部：吸收剩余高度（里面的 .ord-pos 是 flex: 1 1 0，跟着多铺几行） */
.split.m-chart .ord { flex: 1 1 auto; }
/* 滚动条不画出来；持仓列表放开 overscroll（拖到底继续拖 = 滚父级，父级到顶是系统原生回弹） */
body.fixed-viewport:has(.split.m-chart) #app { scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.split.m-chart .ord-pos { overscroll-behavior: auto; }
```

⚠️ `calc(100dvh - 576px)` 是**故意**不用 `32vh`：vh 只在 844 这一档上等于 268，
矮屏（667）算出来是 91、被 `min-height: 150px` 顶住 —— 跟改之前一模一样；`32vh` 在矮屏会把图**撑大**。

⚠️ 另外把 `.ord` 从块级改成**一列 flex**（`.ord-head` + `.ord-body { flex: 1 1 auto }`）：
块级的话 `.ord-body` 是内容高，多出来的高度会落在它**外面**（白空一块、列表一行不涨）——
这一条是实测抓到的：先只改了 ①②③，`.ord` 已经 355px 了，可 `.ord-pos` 还是 129px。
桌面（`.ord { flex: 0 0 auto }`）两种写法等高，188px 对 188px，不影响。

### 45.3 实测（390×844 与 390×667）

| | 改前 | 改后 |
|---|---|---|
| 画布 `.chart-wrap`（844） | 268px | **268px**（不变） |
| 底部 `.ord`（844） | 186px | **355px**（+169 = 20vh） |
| 持仓列表 `.ord-pos`（844，行高 44） | 129px ≈ 2.9 行 | **298px ≈ 6.8 行** |
| 整页可滚距离（844） | 0 | **169px** = 20vh |
| 画布（667） | 150px（下限兜底） | 150px（不变） |
| 整页可滚距离（667） | 0 | **133px** = 20vh |

另外三项：`#app` 的 `scrollbar-width: none` ✓（`::-webkit-scrollbar` 也补了 `width: 0`）；
底栏 `.tabbar` 是 `position: fixed`，滚到底它不动、内容末行（`b = 773`）刚好停在它上面（`top = 785`）✓；
「实时分析 / 历史分析」两格与桌面（1280×900）**一屏照样不滚**（`#app` 844/844、900/900）✓。

★ 老实说一句：「拖动让父级向下 / 触顶回弹」是靠 `overscroll-behavior: auto` 交回给浏览器原生的
滚动链 + iOS 回弹（计算值已核：列表 `auto`、`#app` `auto`），**手指那一下没法在这台机器上用真手势复核**。

## 46. 仓位那一行的数据放大一档（2026-10-07 用户）

用户：「仓位的样式在优化下，现在看的有点小」→「行数据」。就是底部持仓列表里**一行持仓**
（币种 · 方向 · 杠杆 · 仓位价值 · 未实现盈亏 · 平仓 / 全平）的字太小，盯盘的那些数字不划算。

原来整行跟着全站的 `11px`（币种 12、杠杆 10）—— 那是**列表 / 表格**那一档的字号，
可这一行是手机上要随时看的实时数字。现在整体抬一档：

| | 之前 | 现在 |
|---|---|---|
| 行（`.ord-pos li`） | 11px / 上下 9px | **12px** / 上下 10px |
| 币种（`.op-sym`） | 12px | **13px** |
| 方向（`.op-side`） | 11px | 12px（跟行一致） |
| 杠杆（`.op-lev`） | 10px | **11px**（内边距 5 → 6px） |
| 仓位价值（`.op-val`） | 11px | 12px |
| **未实现盈亏**（`.op-pnl`） | 11px | **13px + 600 字重**（这一行最该看清的就是它） |
| 平仓 / 全平（`.op-act`） | 11px / 内边距 6·9 | **12px** / 7·10（触摸目标也跟着大一点） |
| 空态「现在没有持仓」 | 11px | 12px |
| 一行高度 | 44px | **50px** |

### 46.1 实测（key 9 · PUMP 多 20x，390 宽 / 列表 374）

| | 之前 | 现在 |
|---|---|---|
| 各字段字号 | 12 / 11 / 10 / 11 / 11 / 11 | 13 / 12 / 11 / 12 / **13** / 12 |
| 一行宽度占用（含 6px 间隙） | 249 + 84 弹性 | 279 + 55 弹性（仍在 374 内 ✓） |
| 一屏行数（列表 298px 高） | 6.8 行 | **5.96 行** |

★ 顺带补了一条**防挤压**：币种从 `flex: 0 0 auto` 改成**可截断**（`0 1 auto` + `max-width: 46%`
+ 省略号）。字一大，长名字（`1000CHEEMS` 这类）就可能把行尾那两颗按钮顶出行外 ——
行是 `overflow: hidden`，顶出去就等于点不到。现在挤压顺序是：先扁「仓位价值」，
再轮到币种截断，**平仓 / 全平 永远留在行里**（实测把币种换成 16 个字符、盈亏换成
`−$123.4567`、价值换成 `$12,345.67`，两颗按钮右边缘仍在列表内侧 ✓）。

## 47. 「当前下单账户」摆到「一键平仓」旁，价格行那颗去掉（2026-10-07 用户）

用户先说「加上当前账户放在 tab 旁」（截图指的是**底部下单模块那一行**：
`开单 / 仓位 · 盈利 ↓ · 一键平仓`）。中途来回了两轮，最后的裁定是
**「搞错了：上面保留，下面去掉」** ——

| | 结果 |
|---|---|
| **上面**：头行 `开单/仓位` 那一行，紧挨「一键平仓」 | **保留**（新加的那颗） |
| **下面**：开单页价格行尾那颗旧的 `.ord-acct` | **去掉**（连同它的样式一起删） |

所以现在账户名**只此一处**：头行最右、`一键平仓` 左边 —— `开单` / `仓位` 两页都看得见。

### 47.1 那颗长什么样（`OrderPanel.vue`）

```html
<button v-if="tradeKey" type="button" class="ktag head-acct"
        :title="`下单账户：${tradeKey.name} —— 点一下换（配置 → 下单账户）`"
        @click="emit('config')">{{ tradeKey.name }}</button>
```

* **点一下能换**：它是 `<button>`，走 `emit('config')` → `AnalyzeView` 的 `cfgOpen = true`
  （「配置」弹层归外层页面管）＝「配置 → 下单账户」的快捷入口（实测点了会弹出 ✓）。
* 位置：`开单/仓位` → `10x`（开单页）/ `盈利 ↓`（仓位页）→ …… → **`测试`** → `一键平仓`（最右）。
* 撑空档靠**这颗**的 `margin-left: auto`；有它的时候把「一键平仓」自己的 `margin-left: auto`
  关掉（`.ord-head:has(.head-acct) .ord-close-all`）—— 两个 auto 会把空档劈成两半、这颗就飘中间。
* 尺寸 `.ord-head .head-acct { padding: 4px 9px; font-size: 11px }`：跟这一行其它小章
  （杠杆 / 排序 / 一键平仓）**一档**。不这么写这一行会高 1~2px、下面的 K 线跟着跳
  （`.ord-sort` 那段踩过同样的坑）。底色 / 字色沿用 `.ktag`（交易所账户页那种标签）。
* 价格行那颗删掉之后，`.ord-acct` 那条 `cursor: default` 的样式也没人用了 ⇒ 一起删；
  价格行 `ord-right` 现在只剩「可用 13.16 USD」，仍旧 `margin-left: auto` 顶到行尾。

### 47.2 实测（key 7「测试」）

| | 开单那一页 | 仓位那一页 |
|---|---|---|
| 头行（390 宽 / 模块 374） | `开单/仓位`(8~104) · `10x`(112~151) · **测试**(270~310) · `一键平仓`(318~382) | `开单/仓位` · `盈利 ↓`(112~181) · **测试**(270~310) · `一键平仓`(318~382) |
| 头行高度 | 30px（**没变**） | 30px（**没变**） |
| 图 / 模块高度 | 268 / 355（都没变） | 268 / 355 |
| 价格行右侧 | 只剩 `可用 13.16 USD`(293~382) | — |

宽屏（1280）：头行 32px（没变），`测试` 在 1145~1185、`一键平仓` 1193~1257；
价格行 27px 没变、右侧只剩余额；图 364 / 模块 188 都没变。

### 47.3 这轮来回（记一笔，免得下次又摆错地方）

1. 第一版摆到了**顶部一级 tab 行**（`K线 / 实时分析 / 历史分析` 那排）+ 给超窄屏加了隐藏规则
   → 用户截图指出要的是**底部那排 tab**，那一版整个退回（`AnalyzeView` / 顶部 tab 行样式 /
   那段超窄屏 media 全撤）。
2. 第二版摆在头行 `开单/仓位` 后面 → 用户要「位置放在一键平仓旁」，于是挪到最右。
3. 用户说「小标签还是去掉吧」⇒ 整颗撤掉（存了一版）。
4. 紧跟着「搞错了：上面保留，下面去掉」⇒ **恢复头行那颗、删掉价格行那颗**（＝现在这版）。

★ 教训：用户说的「tab」得先问清是**哪一排** tab（一级 tab / 下单模块那两格）；
「上面 / 下面」这种方位词，**截图里那个位置**才算数。

## 48. 合约行情涨跌幅方块：候选页第 ② 组（2026-10-07 用户）

用户：「合约行情的涨跌背景色写了几组 html 让我看看来挑」→ 看完 10 组之后：
**「第二，字体细一点」**。

那一页在 `tmp-mkt-chg-variants.html`（仓库根、**未追踪**的临时文件，就是给人挑色用的：
每格 72×28 跟线上一致、铺在 `--panel-2` 真实底色上，旁边是**实算的对比度**）。

### 48.1 改了什么

| | 之前（⑫ 那版） | 现在（② ） |
|---|---|---|
| 涨 | `--ok-fill` = `--ok` 70% + 黑（≈ #428260） | `color-mix(in srgb, var(--ok) 82%, #000)`（≈ #4d9870） |
| 跌 | `--bad-fill` = `--bad` 88% + 黑（≈ #c64b55） | `color-mix(in srgb, var(--bad) 95%, #000)`（≈ #d85158） |
| 字重 | `--fw-bold` 700 | **`--fw-mid` 600**（用户「字体细一点」） |
| 字色 | 白 | 白（不变） |
| 白字对比度（实算） | 4.56 / 4.58 ✓AA | **3.46 / 4.01**（不过 AA，用户看过数值仍选它） |

⚠️ **没有去改 `--ok-fill` / `--bad-fill`**：那两个是**共用**的变量 —— 做多 / 做空按钮、
破坏性确认键、下单面板那几颗实心块都在用，动它等于把按钮一起改了；用户这次只说涨跌幅方块，
所以色值写在 `.mkt-table .chg.up/.down` 里（`.chg` 那段注释里记了 ⑬）。

### 48.2 实测（本地 key 7 / key 9 都一样，纯样式）

```
.mkt-table .chg.up   → background: color(srgb 0.302275 0.598118 0.440549)  color: #fff  font-weight: 600
.mkt-table .chg.down → background: color(srgb 0.845686 0.316667 0.361373)  color: #fff  font-weight: 600
```

跟候选页第 ② 组**逐值一致** ✓；120 个涨跌幅方块全部吃到（`.mkt-table .chg` 一把梭）。
做多 / 做空按钮仍是 `--ok-fill` / `--bad-fill`（4.56 / 4.60 那套），没被牵连 ✓。

## 49. 移动端：整页不给「双指捏合缩放」，图上的留着（2026-10-07 用户）

用户：「移动端不要让双指撮合等手势生效」→ 紧跟一句「**我是说整体页面，不是 k 线**」。
也就是：页面上任何地方双指都不能把整页放大（放大之后回不到原样、密密麻麻的按钮全错位），
但 **K 线自己的双指缩放要留着**（那是缩时间轴，不是浏览器缩放）。

### 49.1 为什么不用 CSS

`touch-action` 是**沿祖先链取交集**的（命中元素 → 一路往上到根）。所以只要给
`html` / `body` 写一句 `touch-action: pan-x pan-y`，K 线那块的双指缩放（LWC 的
`handleScale.pinch`，默认开）也一起没了 —— **CSS 没法「整页都关、只留图」**。

### 49.2 改法：`main.ts` 里拦手势（只拦「双指以上 + 不在图上」）

```ts
document.addEventListener('touchmove', e => {
  if (e.touches.length < 2) return            // 单指：滚动 / 拖图 / 画范围，一律放行
  const el = e.target as Element | null
  if (el?.closest?.('.chart-wrap')) return     // 白名单：只放 K 线那一块
  e.preventDefault()
}, {passive: false})                           // ⚠️ 必须 false，否则 preventDefault 是空操作
```

* 只挂给**触屏判据命中的**那些设备（就是上面 `document.documentElement.classList.add('touch')`
  那个分支里 —— 原生壳或粗指针），PC 一动不动。
* `index.html` 的 viewport 顺手加上 `maximum-scale=1, user-scalable=no`：
  **iOS Safari 从 10 起就忽略它**（无障碍考虑），真正干活的是上面这条 `touchmove`（iOS 13+ 支持
  用 preventDefault 拦捏合）；viewport 那条留着是给 **Android Chrome / 老 WebView** 兜底。
* 双击缩放 / 长按弹菜单**早就关了**（2026-10-03 的 `touch-action: manipulation` + 2026-10-05 的
  `-webkit-user-select: none` / `-webkit-touch-callout: none`），这次只补「捏合」这一种。
* **Android App 不用管**：Capacitor 的 `android.zoomableWebView` 默认 false ⇒
  `WebSettings.setBuiltInZoomControls(false)`（在 `node_modules/@capacitor/android` 的
  `Bridge.java:618` 里核过）—— WebView 本来就没有捏合缩放。iOS 壳不在这个仓库里。

### 49.3 实测（390×844 触屏仿真，key 7）

手势没法在这台 Mac 上真用两根手指按（没触摸屏），所以用合成 `TouchEvent` 直接探**处理逻辑**：

| 起手位置 | 手指 | `defaultPrevented` | 意思 |
|---|---|---|---|
| 下单区 / 行情表 / 别的页面区域 | 2 | **true** ✓ | 手势被吃掉，整页不会放大 |
| `.chart-wrap`（K 线） | 2 | **false** ✓ | 放行 ⇒ 图自己的双指缩放还在 |
| 任意位置 | 1 | false ✓ | 单指永远不拦（滚动、拖图、画范围照旧） |

另外核过：`body` 的 `touch-action` 还是 `manipulation`（没被 CSS 钉死 ⇒ 图的捏合没被祖先链卡住）、
`html.touch` 已挂、viewport meta 已带 `maximum-scale=1, user-scalable=no`。

★ 老实说：**真手势**（两根手指在真机上捏）没在这台机器上复核过，验的是「事件被不被吃掉」这一层。

## 50. 滚动条：行情页「细 + 只在滚动时出现」，K 线页「整页不画」（2026-10-07 用户）

用户：「先修复 2 个 bug：① 合约行情页面滚动条细点，**只在滚动时出现**；② k 线页面**不要滚动条**。」

### 50.1 ① 全站：5px + 静止时全透明，一滚才画出来

原来那套是「10px 轨道 + 2px 透明边框 ≈ 6px 视觉」，**常驻可见**（macOS 上开了「始终显示滚动条」
就一直是那条杠）。现在：

```css
/* 默认全透明 == 看不见；html.scrolling 时才画（不是不能滚，滚轮/拖动/触摸照旧） */
* { scrollbar-color: transparent transparent; scrollbar-width: thin; }
html.scrolling * { scrollbar-color: rgba(255, 255, 255, 0.2) transparent; }
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-thumb { background: transparent; transition: background .18s; }
html.scrolling ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); }
```

`html.scrolling` 由 `main.ts` 一条全局监听挂/摘（停手 **800ms** 摘掉）：

```ts
addEventListener('scroll', () => { /* 挂 .scrolling，800ms 后摘 */ },
                 {capture: true, passive: true})   // ⚠️ 必须 capture
```

⚠️ **必须 `capture: true`**：`scroll` 事件**不冒泡** —— 挂在 window 上不加捕捉，只收得到
document 自己那点滚动，**列表 / 面板这些子滚动容器全漏掉**（实测就是这么发现的）。
⚠️ 写成 `*` 而不是只挂 `html`：`scrollbar-width` / `scrollbar-color` **不继承**，
只写 `html` 的话 `::-webkit-*` 管得到、**Firefox 那两个属性管不到子容器**。
⚠️ hover 不变白那条老规矩保留（只在「滚动中」生效，停手连它一起隐）。

### 50.2 ② K 线那一格：连滚的时候也不画

```css
/* ① 新引擎：一句话就够 */
body.fixed-viewport:has(.split.m-chart) :is(#app, .split),
body.fixed-viewport:has(.split.m-chart) .split * { scrollbar-width: none; }

/* ② 老引擎的兜底：**必须 `display: none`**，`width: 0` 是无效的（见下） */
body.fixed-viewport:has(.split.m-chart) :is(#app, .split)::-webkit-scrollbar,
body.fixed-viewport:has(.split.m-chart) .split ::-webkit-scrollbar { display: none; width: 0; height: 0; }

/* ③ 根视口也别滚：App 里根滚动条是**原生画**的，CSS 管不到，只能让它没得滚 */
html:has(.split.m-chart) { overflow: hidden; scrollbar-width: none; }
html:has(.split.m-chart)::-webkit-scrollbar { display: none; }
```

* **只是不画**：滚动照旧（实测 `#app.scrollTop` 0 → 120 ✓，那 120 就是 §45 那 20vh）。
* 盖的是 `.split` 那棵树（含里面的行情列表）**加上 `#app`**（窄屏滚的是它）；
  **不碰弹层 / toast** —— 那些挂在 `.split` 外面，缩在弹层里滚还是能看见细条。
* `.m-chart` 是「窄屏那格切到 K 线」时才挂的类（`leftView` = chart）⇒ **桌面 K 线视图不带它**，
  桌面那个行情列表照旧是「细 + 滚动时出现」（两条需求不打架）。

#### ★★ 2026-10-07 事后补修：`width: 0` 在老 WebView 里等于没写

当天用户又报「K 线滚动条还在」，量下来**只在装机版 App 里有**、浏览器里没有。
从线上 Caddy 日志里抓到 App 的 UA 与请求：

```
User-Agent: Mozilla/5.0 (Linux; Android 12; SUP-AL90 Build/HUAWEISUP-AL90; wv) … Chrome/114.0.5735.196 …
Referer:    https://bitcoooin.cn/assets/index-CnM8lKTZ.css      ← 32 次，就是当天刚发的那版
```

两个结论一起成立：

1. **App 不是缓存的旧页面**（它是远程加载站点，拿到的是刚发的那版 CSS）；
2. **那台手机是 WebView Chrome 114** —— `scrollbar-width` **要 121 才认**（这条只在 §50.2 里躺着，
   等于没写），于是只剩 `::-webkit-scrollbar` 这条路，而当时写的是 `width: 0`。

`width: 0` 为什么不顶用：按浏览器自己的口径，**零宽度不算「隐藏」**——
Firefox 的 BCD 备注写明「只有 `display: none`（隐藏）与非零宽度（关掉覆盖式滚动条）有作用」，
Safari 13+ 的备注同样是「只有 `display: none` 有效」。反过来也对得上：
**行情页那条 5px 细条在 App 里是正常的**（非零宽度 ✓），唯独这一页的 0 被忽略了（✗）。
⇒ 三处（K 线页 `#app` / `.split` 子树、持仓列表 `.ord-pos`）统一改成 `display: none`。

⚠️ 顺带堵掉最后一个漏洞：**根视口**。App 里 WebView 的根滚动条是**原生控件**画的，
`::-webkit-scrollbar` 与 `scrollbar-width` 都碰不到它 —— 所以干脆让这一格的根视口 `overflow: hidden`
（这一格本来就该在 `#app` 里滚），从源头断掉。实测加了之后 `#app` 照旧滚（0 → 120）、
`documentElement` 可滚量 **0**。

⚠️ 这条经验对**以后所有 CSS 都有用**：装机版跑的是手机里的 WebView（这台是 **114**），
不是我们的构建工具链 —— 写 CSS 时别以「我本机 Chrome 150 好使」为准。
App 的「我的 → 个人信息 → 账户信息 → App 信息」那张体检单上有 **WebView 版本**，先看它。

### 50.3 实测

| 场景 | 静止 | 滚动中 | 停手后 |
|---|---|---|---|
| 行情列表 `.mkt-body`（390 / 1280 都测了） | `scrollbar-color: transparent` ✓ 看不见 | `rgba(255,255,255,.2)` ✓ 出现（宽 **5px**） | 800ms 后回到透明 ✓ |
| K 线页 `#app`（390，`.m-chart`） | `scrollbar-width: none` ✓ | 仍然 none（这一格是「不画」）✓ | none ✓ |
| K 线页滚不滚得动 | — | `scrollTop 0 → 120` ✓ | — |
| K 线页加 `html { overflow: hidden }` 之后 | `html/body` 都 hidden、`documentElement` 可滚量 **0** ✓ | `#app` `scrollTop 0 → 120` ✓ | `.ord` 355px / 画布 268px 不变 ✓ |

## 51. 合约行情排行榜换基准：24h / 时区日切 / 任意时刻（2026-10-07 用户）

用户：「行情排行榜可以自己选一个时刻来排，像币安那样，**直接影响合约区**」
→「基准时间是 **24 小时的一个时间**，比如北京时间就是 **UTC+8**」
→「**可以选择任意时间和 24h**」。

⇒ 配置里那条「基准时间」三档（互斥），只改**合约区那张表**的涨跌幅口径与排名：

| 选 | 口径 |
|---|---|
| `24h`（默认） | 交易所给的**滚动 24 小时**（`change24hPct`），一个字没动 |
| `UTC+8` / `UTC+0` | 该时区**每天 00:00 日切**：`last / 那一刻的收盘价 - 1`（列头显示「今日涨跌」） |
| `任意…` | **任意时刻**（北京时间挑，精确到分钟）：`last / 那一刻的收盘价 - 1`（列头显示「基准涨跌」） |

### 51.1 那一刻的价从哪来（不打交易所）

挂在新的**库内**查询上（`backend/src/db/candle-store.ts` 的 `closesAtOrBefore`）：

* 基准时刻由前端算：时区档 = 「该时区当天 00:00」（`settings.ts` 的 `dayStartMs`，
  每次现算 ⇒ 跨零点自动走到新的一天），任意档 = 用户挑的那个毫秒（`rankSinceMs`）；
  经 `GET /api/markets?since=<ms>` 传下来。
* 后端按基准时刻**离现在多远**挑够用的最细一档（1m / 15m / 1h / 1d），
  取「该档上已收盘、且开盘时间 ≤ 基准时刻」的最后一根 → `MarketRow.baseClose`；
* 前端拿 `baseClose` + 每秒都在刷新的 `last` **现算**（跟头部「1 天 / 3 天…」同一套路），
  所以那一列跟着行情秒级跳。

⚠️ 时区档的基准时刻一定落在最近 24 小时内 ⇒ 底座 1m 那档一定覆盖得到，不会「今天算不出来」；
任意档挑得越早用的档越粗（1m 保留 7 天、15m 约 1 个月、1h 约半年、1d 约两年），
超出范围的币 `baseClose` 是 null ⇒ 显示「—」。

### 51.2 界面

* 配置第 2 行「基准时间」：`24h` + `UTC+8` + `UTC+0` + `任意…`（四颗正好 390px 一行不折行）；
  `任意…` 点开复用「选一个时间点」那个弹窗（自带「现在 / 1 天前 / 7 天前 / 30 天前」快选），
  选中后这颗按钮上直接显示那个时刻 —— 那个弹窗要压在配置弹层之上（`z-index` 320）；
* 选了基准后：列头变「今日涨跌」/「基准涨跌」，表上方多一条
  `今日涨跌 · UTC+8 00:00 日切`（或 `基准涨跌 · 2026-10-04 13:30 起算`）+ 一颗 ✕（一键回 24h）；
* 换基准会**自动把排序切到涨跌幅降序**（用户要的就是「按它来排」）；
  配过基准之后**再进页面也直接按它排**。

### 51.3 实测（2026-10-07 13:4x，走隧道代理打真行情，库里 525 个合约）

| 基准 | 基准时刻（UTC） | 有基准价 | 涨幅前三 | BTC |
|---|---|---|---|---|
| UTC+8 日切 | 2026-10-06T16:00Z | 525/525 | RAYSOL +13.87% · GTC +9.93% · PROM +7.64% | −2.75% |
| UTC+0 日切 | 2026-10-07T00:00Z | 525/525 | GTC +21.17% · RAYSOL +13.80% · PROM +7.06% | −2.56% |
| 任意（3 天前） | 2026-10-04T13:4xZ | 525/525 | RLC +99.78% · ORCA +47.27% · GTC +44.87% | −2.17% |

（结果按分钟对齐的 `since` 缓存 5 分钟 —— 挪排序 / 切币 / 多开标签页都不会再查库。
界面那一路用一份隔离的假后端在浏览器里验过：切 `UTC+8` 会带 `?since=` 重拉、
列头变「今日涨跌」、`baseClose` 为 null 的那行显示「—」、✕ 能回到 24h。）

## 52. 发布之后全站 502 三分钟：K 线那 5.5GB 全表扫（2026-10-08 事故）

**症状**：发布重建 `ca-app` 之后，容器在跑、日志看着「启动正常」、`docker ps` 却一直是 `unhealthy`，
外部访问**全是 502**（Caddy 日志 `dial tcp 172.18.0.4:8787: connect: connection refused`）。
但**从容器里** `fetch http://127.0.0.1:8787/api/health` 是 **200 / 8ms** —— 应用本身没坏，坏的是「它还没开始听」。

**时间线**（服务器上取证，全部是 `docker inspect` / `docker logs -t` 的原始时间）：

| 时刻（UTC） | 事件 |
|---|---|
| 23:53:07 | 新容器 create |
| 23:53:36 | 容器 start（node 起来，`RestartCount=0`：中途没崩） |
| 23:54:01 → 23:56:22 | Caddy **13 次 `connection refused`**（≈ 全站 502） |
| 23:57:01 | **应用第一行日志** —— 之前 **3 分 25 秒**一句都没有 |
| 23:57:03 | `✅ 开单分析 Web 界面已启动`（`listen()` 此刻才发生） |

**根因**（三条证据链：`EXPLAIN` + `pg_stat_activity` + `vmstat`）：

1. `candles` 涨到 **11,055,577 行 / 5.5GB**（本地那份 10,556,168 行 / 3.8GB，同量级）。
2. `maxOpenTimes()` 的谓词只有 `interval + symbol`，**没有 `exchange` / `market_type`**；
   而三个索引**全部以这两列打头**（PG 16 没有 index skip scan）⇒
   现在：`Parallel Seq Scan on candles (cost=500904)`；带 scope 后：
   `Index Only Scan using candles_ivl_symbol_time_idx (cost=2100)`。
3. 这条查询**开机跑 5 次**（`seedHistory` 五档各一次）+ `repairSweep` **每 60 秒一次**。
   单次实测 **410.5 秒**（`state=active · wait_event=IO/DataFileRead`，3 个并行 worker）⇒
   `vmstat wa=94%`、PSI `io some avg10=92%`、`loadavg 4~6.8`（2 核）、`swpd 110MB`；
   连 `psql` 跑一句 catalog 查询都要几分钟，`INSERT INTO candles` 卡在 `IPC/BufferIO`
   ⇒ **K 线实时写入被堵**。这正是 `schema.ts` 里 2026-10-07 记的那句「底座写不进去」——
   当时只加了索引，**没发现那几条查询根本没带 scope，索引压根没被用上**。

**为什么不怪「本地预构建 / BuildKit」（当时的两条怀疑）**：

* 镜像里 `grep -c` 能查到崩溃修复那行 ⇒ 代码是新的那份；
* 从容器内 `fetch /api/health` 是 200，healthcheck 后来也回到 `healthy`；
* 慢的是**初始化前段**（第一行日志之前），而 `EXPLAIN` 在任何一台同样数据的机器上都是 Seq Scan。
  BuildKit 那次失败是另一码事（SSH 流断 ⇒ 前端会话死），与本事故无关。

**修法**（改根因，不是绕）：

| 位置 | 改动 |
|---|---|
| `candle-store.ts` `maxOpenTimes` | 加 `scope` 参数，并改成**每币一次索引探测**（`unnest` + `LEFT JOIN LATERAL … ORDER BY open_time DESC LIMIT 1`）。带 scope 的 `GROUP BY` 仍要把这些币在该档的**全部**索引项读一遍（1m × 525 币 × 7 天 ≈ 530 万条），逐币探测只读 **1 条** |
| `lastOpenTime` / `candleCount` | 补 scope（也缺，只是当前没人调用 —— 留着就是下一颗雷） |
| `rollupFrom1m` | 补 scope（原来 `interval='1m' AND symbol=ANY(…) AND open_time…` 也是全表扫） |
| `pruneCandles` | 原来一条 `(interval='1m' AND open_time<…) OR …`，四条分支都缺前缀 ⇒ 全表扫。改成**按 scope + 档位逐条 DELETE**（前 3 列等值 + `open_time` 范围 ⇒ 走 `candles_ivl_time_idx`） |
| `candleStoreStats` | 诊断接口不再跑全表 `count(*)`：行数取 `pg_class.reltuples`（**估计值**），覆盖区间用每档索引端点探测；要精确值用 `?db=exact` |
| `server.ts` `main()` | **`listen()` 提到所有重活之前** —— 端口 2 秒就服务，重活再慢只是接口慢，不会再出现「Caddy 全程 refused」 |

**实测**（本地 10.5M 行 / 3.8GB，与线上同量级）：

| 写法 | 耗时 |
|---|---|
| 旧（缺 scope，1 个币） | **1691 ms**（线上 525 个币：**410 秒**） |
| 新（525 个真实币） | **33 ms**（线上在磁盘仍被旧代码占满时 9.7 秒 ⇒ 不被占后回到几十毫秒） |

* `pruneCandles` / `rollupFrom1m` 的 `EXPLAIN`：`Index Scan using candles_ivl_time_idx` /
  `candles_ivl_symbol_time_idx`（改前是 `Seq Scan`）；
* 本地重启（带时间戳）：**T+2s 端口已可服务**，T+3s 才轮到 markets / 底座 / 清理 / 灌历史；
* 崩溃修复那份 `dist` 也在线上镜像里（`grep -c` = 1）。

**以后怎么防**（已写进 `schema.ts` 的 `candles` 段注释）：

* `candles` 的索引都以 `exchange, market_type` 打头 ⇒ **新增/修改查询时先看谓词里有没有这两列**，
  没有就是整表扫，数据量小的时候完全看不出来；
* `EXPLAIN` 里出现 `Seq Scan on candles` 就是红灯，正常应当是
  `Index Scan / Index Only Scan using candles_ivl_*`；
* 现成入口：`GET /api/kline/recorder?db=1`（估计值 + 每档覆盖区间）、`?db=exact`（精确值，慎用）。

## 53. K 线底座加固：分区 + 记账式校验 + 去重写入（2026-10-08）

用户：「我希望一次性做彻底一点，就是将整个 K 线做得彻底一点」——
起因是那天一直在问的**「为什么服务器这么慢」**，查到最后是两个同族的问题叠在一起。

### 53.1 那天到底慢在哪（全部实测，不是推测）

机器规格先摆出来：**2 核 / 1906MB / 磁盘 33MB/s**（`dd` 直读直写实测；同代码 JS 循环
比本机慢 **2.3 倍**）。而 `candles` 是 **1100 万行 / 5.6GB**（heap 3.4GB + 索引 2.2GB），
`shared_buffers` 只有 **384MB**、OS page cache ~1.4GB ⇒ **大约 1/3 放得下缓存**，
其余全打到那块 33MB/s 的盘上。

| 任务 | 实测 | 说明 |
|---|---|---|
| **库内自洽（`findStaleBuckets`）** | **4 分 40 秒/轮** | 4 桶 × 5 档 × 全部币 ≈ **370 万行 1m 读取**；1d 一档就 3 分 33 秒、4h ≥57 秒、1h 0.6 秒、15m 7.1 秒、5m 5.6 秒 |
| 它的产出 | **5 个桶 / 全部历史** | `5m 1 / 15m 3 / 1h 1`，而 **4h、1d 一次都没有** ⇒ 97% 的读取量零产出 |
| `bucketCoverage`（存在性） | 1 秒内 | Index Only Scan，快的 |
| `pruneCandles`（老写法） | 每天删 90 万行 | 三份索引写放大 + 死行 + autovacuum 扫全表 3.4GB |
| 症状 | `wa=48%`、PSI io 60–99%、loadavg 冲到 11 | ⇒ 部署慢 5 分钟、SSH/HTTPS 间歇性超时、Caddy 3.5 分钟拿不到上游 |

**根因（成本假设错了三处，都在代码注释里看得见）**：

1. 「**0 权重**」被当成「0 成本」——它不花交易所 API 额度，但花磁盘，而磁盘是这台机器的
   一号瓶颈。原文（`GAP_CHECK_MS` 上面）：*「0 权重（纯库内聚合）⇒ 频率可以给得比较勤」*。
2. `sum(volume)` / `array_agg(close …)` 要的两列**不在任何索引里** ⇒ 每个 1m 行都要回堆取页。
   1d 档一个桶就是 **1440 行**（1h 只有 60），4 桶 × 660 币 × 1440 ≈ 300 万次随机读 ——
   这解释了为什么同一段 SQL 五个档位差 400 倍。
3. 当年外推假设**线性**：设计文档里记的实测是「1575 行 × 240 根 = 1.0 秒；**过滤后 8 币 =
   几十毫秒**，整轮 1.0 秒」。从 8 币乘到 660 币只在**热数据放得下缓存**时成立。今天量了两端：

   | 符号数 | 1d 档耗时 | 每币 |
   |---|---|---|
   | 20 | 554 ms | 27.7 ms |
   | 660（全量） | **212,884 ms** | 323 ms |

   12 倍工作量 → **384 倍耗时**（超线性 = 缓存边界）。
4. 还有个反直觉后果：`ORDER BY open_time DESC LIMIT 50` —— **库里没残桶时 `LIMIT` 永远不生效**，
   必须全扫。健康的库付最贵的代价。
5. `gapChecking` 守卫会让「上一轮没跑完」的下一轮直接跳过 ⇒ 实际是**背靠背连续跑**
   （日志节奏 `01:03 → 02:05 → 02:34`），磁盘长期不闲。

### 53.2 四条改动

#### ① 值校验改成「记账 + 复核」（`kline_pending_check`）

用户的口径：**「历史数据肯定没问题；新增的数据可能因为掉线 / 网络波动出问题，需要补」**。
⇒ 校验不该是「定期全市场扫一遍」，而该是「**只有我们自己写下去、且写的时候桶还没收盘**的那些
桶才可能坏，把它们记下来，等 1m 补齐、桶收盘之后只核对它们」。

* 记账点**只有一处**：`saveCandles`（四条入库路都过它，与 `sanitizeRows` 同一思路）+ 
  `rollupFrom1m`（它是唯一绕过 `saveCandles` 的写入）。
* `seed` 写未收盘的桶 = 预期行为（官方部分快照）⇒ 记账；
  `rollup` 写未收盘的桶 = **按构造不该发生** ⇒ 记账 + **立即告警**（等于一条断言）；
  `repair` 的 REST 覆盖 = 权威值 ⇒ 不记账。
* 复核（每 5 分钟，`verifyPendingChecks(50)`）：只取账上「桶已收盘」的，一个桶一次定向探测
  （≤1440 行）。一致 ⇒ 销账；1m 还没补齐 ⇒ 留着下轮；不一致 ⇒ 排进修复队列 + 留着账继续盯；
  超过 7 天仍判不了（1m 已过保留期）⇒ 销账 + 告警。
* **判据逐字没变**（免得改出语义差）：1m 一根不缺（`n = 桶长` 且最后一根落在桶末）的前提下，
  `close` 或 `sum(volume)` 对不上。
* 全量扫描**保留但只做手动**：`GET /api/kline/gaps?run=full`（上线时把历史遗留理一遍）。

**实测：单轮 370 万行 → 常态几十条账目。** 判据与记账都过了本地夹具（一致销账 / 改坏判残桶 /
1m 已清理时判 waiting 不误判）。

#### ② 写入去重：值没变就不写（`UPSERT … WHERE … IS DISTINCT FROM`）

回补 / 对账 / 重算会把同一批桶反复写很多遍而且是同一个值 —— 那是死行与 vacuum 负载的主要来源
（实测死行几小时就攒到 60 万、触发全表 3.4GB 的扫描）。现在值全一样（含 `source`）就不写。
⚠️ 口径变化：`rowCount` 从「提交行数」变成「**实际变更行数**」，日志与 stats 都按这个说法。

#### ③ 结构：`candles` 两级分区（LIST `interval` → RANGE `open_time`）

```
candles_1m  (按天)   candles_1m_20261008 …
candles_5m  (按天)   candles_15m (按天)
candles_1h  (按月)   candles_4h / candles_1d (按年)
每档另有一片 DEFAULT 兜底（插入永不失败；落在里面的行会在下次建格时搬出来）
```

* **查询只碰自己那一档**：`EXPLAIN` 实测 1d 查询只出现 `candles_1d*`（索引从「1100 万行的
  876MB」变成每档几十万行的小索引）。
* **保留期 = `DROP` 整片子分区**（秒级、零死行、不触发 autovacuum 全表扫）。
* 迁移：`npm run candles:partition`（演练）/ `npm run candles:partition -- --apply`（真做）/
  `-- --drop-old`（确认无误后删老表）。**幂等、可续跑**（中途报错重跑即可）。
  逐档核对**行数 + `sum(close)`**，对不上就中止并留着老表。
* 本地演练（1057 万行）：**3 分 05 秒**，6 档行数与 Σclose 逐位一致。线上预计 5–15 分钟
  （33MB/s 的盘），**期间应用要停**（换表那一刻不能有写入）—— `scripts/deploy.sh` 已把
  「停应用 → 迁移 → 启动」编排进去，且迁移幂等，每次发布跑它没成本。

#### ④ 可观测：每个维护任务自己报耗时

`GET /api/kline/recorder` 现在带 `tasks`（每个任务的 `lastMs` / 跑过几次 / 慢过几次）与
`pendingCheck`（账目数 + 最老那条多久）。超过 **3 秒**就打一条
`[kline] ⚠️ 维护任务慢：…` —— 那天只能靠 ssh 进去手工量，以后慢会自己出现在日志里。

### 53.3 以后新增 K 线相关查询/任务的规矩

1. **谓词必须带 `exchange` + `market_type`**（索引前缀），否则顺序扫整表。
2. **算成本**：写清楚「单轮读多少行、多久跑一次」，并让它**不随历史长度增长**。
   只带 `interval` 的聚合要回堆取 `close`/`volume` ⇒ 一行一次随机读，千万行级别就是分钟级。
3. **别在定时任务里做全市场扫描**：要扫就记账 + 只扫"刚动过的"，或者手动触发。
4. `candles` 的**索引建在父表**上（子分区自动继承）；**分区表上不能设 `reloptions`**
   （PG 16 报错），reloptions 逐片子分区设（`ensureCandlePartitions` 里做）。

## 54. 「掉线期间成交、事后平掉」的币，成交明细永远补不回来（2026-10-08 实测抓到）

**怎么发现的**：用户让我把本地整套流程跑一遍看恢复情况。本地服务停了 3.5 小时，重启后：
K 线追平了、income 账本 +23 条（资金费/已实现盈亏）、余额快照也补了 ——
但 `exchange_fills`（成交明细）**一条没动**。

**根因**：`symbolsToBackfill()` 只从两个来源推「该查哪些币」：

```
① exchange_fills 里最近 30 天有成交的币（按最后成交时间倒序，LIMIT 8）
② 当前持仓的币
```

而这次成交发生在 **JUP / MET / PROM / RESOLV** 上，事后**平掉了**（无持仓），
`exchange_fills` 里又**一条都没有**（就是漏掉的那批）⇒ **两个来源都看不见它们**，
于是永远不去查，那 15 笔明细就永久丢了（盈亏/仓位周期都从 `exchange_fills` 推，跟着一起错）。

⚠️ 注意这是个**鸡生蛋**结构：候选集来自"我们已经知道的成交"，而缺的恰恰是"我们还不知道的成交"。
只要「成交 → 平仓 → 进程重启」这个顺序出现，就会静默丢数据 —— 而**这正是掉线/重启的典型形态**。

**修法**：加第三个来源，且**优先级最高**（`exchange-stream.ts` 的 `symbolsToBackfill()`）：

```sql
-- 账本（income）里出现过的币、且它的账目比我们记的成交还新 ⇒ 有我们没记下来的成交
SELECT i.symbol FROM exchange_income i
  LEFT JOIN (SELECT symbol, max(ts) AS t FROM exchange_fills WHERE key_id=$1 GROUP BY symbol) f
    ON f.symbol = i.symbol
 WHERE i.key_id = $1 AND i.symbol <> '' AND i.ts > now() - interval '30 days'
   AND (f.t IS NULL OR i.ts > f.t)
 GROUP BY i.symbol ORDER BY max(i.ts) DESC LIMIT $2
```

为什么 income 是可靠的锚：它**按时间拉**（`incomeType` 全量、不需要币），
所以掉线期间的钱账本一定是对的 —— 拿对的去点出错的，正好。

* 顺序也改了：**① 缺失发现 → ② 持仓（无条件进）→ ③ 已知成交**。
  原来的顺序会把持仓币挤掉（`LIMIT 8` 先占满 + 末尾 `slice()`），
  而「开了仓但 30 天没再成交」的币同样会让仓位周期画不出来。
* ① 天然**轮转**：补完前 8 个币后它们不再"账目比成交新"，下一轮自动轮到后面的币。
* 顺手加了一行**可见性日志**：`发现 N 个币的成交明细缺失（账本里有）：…` 和
  `补成交：查了 N 个币（…），没有遗漏` —— 原来「没查」与「查了没漏」在日志里长得一样，
  这次就是靠这个才一眼看出问题。

**实测修复效果**（本地，掉线 3.5 小时）：

```
[T+24s] [exch:9] 发现 4 个币的成交明细缺失（账本里有）：RESOLVUSDT、PROMUSDT、METUSDT、JUPUSDT
[T+33s] [exch:9] REST 补成交 15 笔（查了 8 个币：RESOLV…、PROM…、MET…、JUP…、RAYSOL…、PUMP…）
```

`exchange_fills` 里 key 9 的成交 **24 → 39 笔**，四个币的最新成交（02:55）与 income 账本对齐。

---

## 55. 补缺口改成「哪档缺就直连哪档」+ 休眠账户的活跃判据（2026-10-08 用户要求）

### 55.1 为什么改：原来每币固定 6 发 REST，其中大半是白打的

用户的原话：「回补没必要一分钟的去读交易所，直接去拿已经整理好的数据接口」。

原来 `repairSymbol()` 无论报的是哪一档缺口，都先**无条件**拿一发 1m：

```
① 1m      fetchCandlesRange(timeframe:'1m', maxCandles: 1500)   ← 永远打
② 5m      官方覆盖，1~2 根
③ 15m     官方覆盖，1~2 根
④ 1h      官方覆盖，1~2 根
⑤ 4h      官方覆盖，1~2 根
⑥ 1d      官方覆盖，1~2 根
```

= **6 发/币**，而缺口巡检报出来的缺口**位置全在高周期**：

```
2026-10-08 实测：1596 处缺口 = 5m 417 / 15m 417 / 1h 381 / 4h 381，1m 是 0 处
```

也就是说第 ① 发（也是最贵的一发：1500 根 = 15 权重）在绝大多数情况下是**完全没有对应缺口的**。

### 55.2 改成什么样

队列从「币 → 一个 `fromMs`」升级成「币 → `{from, intervals}`」（`RepairJob`）：
**谁报的缺口就修谁**。

| 调用点 | 传的 `intervals` | 效果 |
| --- | --- | --- |
| `repairSweep`（只看 1m 落后） | `['1m']`（默认） | 补 1m，补完顺手用 **纯 SQL** 把 5 档高周期滚出来（0 权重） |
| 缺口巡检 ①（存在性） | `[it]`（报出来的那一档） | **直连交易所那一档**（1 发覆盖 1500 根） |
| 缺口巡检 ②（残桶裁决） | `[sv.interval]` | 同上，只修判定为残的那一档 |

`repairSymbol(st, fromMs, intervals)` 里：

* `intervals.has('1m')` 才打 1m（`maxCandles: 1500`）；补完用 `rollupFrom1m` 把高周期滚一遍（**0 权重**）。
* 高周期**只对被点名的那几档**直连交易所（`interval=<那一档>`）。
  为什么高周期还是直连而不是全靠 rollup：**官方那一档就是权威口径**（量 / 笔数 / 主动买量都齐），
  而 rollup 出来的 `trades` 恒 0（1m 那列我们本来就没存）。
* 交易所那发拿不到（超时 / 限流）⇒ **退回**「用库里 1m 重算」（纯 SQL、0 权重）。
  所以 rollup 那条路留着当**兜底**，不是主路。
* 直连交易所那条路**不往后钳**：`REPAIR_MAX_CALLS = 8` × `REPAIR_MAX_CANDLES = 1500`
  = 一次最多往前 8 发。这个上限**必须覆盖该档的整个保留期**（最费的一档是 1m：
  7 天 = 10080 根 = 7 发；1h 400 天 = 9600 根 = 7 发），不够就会静默丢洞 ——
  所以被截断时会 `console.warn`（等于一条断言）。
  原来这里是个「往前 60 格」的钳位，那是个**静默的丢洞机器**：调用方明明知道洞在哪
  （`fromMs`），钳位却把起点往后推，于是比这更老的洞**连修都不去修** ——
  而「老洞」正是连续性审计要修的（见第 56 节）。
* 0 权重的 rollup 兜底**仍然**只往前 `REPAIR_SPAN_BARS = 60` 格（5m = 5 小时、1h = 2.5 天）。
  为什么它必须窄、而且不能跟着放宽 —— 往下看第 56.5 节的实测。

### 55.3 顺线抓到：休眠账户 = 成交回补整条停摆

`reconcileTick` 在 `asleep` 档直接 `return`，而活跃判据（`seedActivity()`）**只看 `exchange_fills`**
—— 正是 §54 里"会被漏掉的那一份"。于是 §54 修好之后还有一条通路能再次静默停摆：
只要某个账户的成交明细缺失，它就被判成"很久没动" ⇒ 进 `asleep` ⇒ 连"发现缺哪几个币"的机会都没有。

修法：`seedActivity()` 的活跃时刻取 `max(exchange_fills, exchange_income, created_at)`。
income 是**按时间全量拉**的，掉线期间一定完整 —— 拿它当活跃信号，正好补上"成交明细缺失"这类看不见的动静。

**实测**：本地重启后两个账户 `档位 asleep`（本来就该是，无持仓无挂单），
但 `补成交：查了 8 个币（…），没有遗漏` **照常跑**，`exchange_fills` key 9 稳定在 39 笔。

### 55.4 效果

* 常态（缺口全在高周期）：**1 发/币**，从 6 发降下来。
* 补 1m 的路径：1 发 1m + 0 发高周期（纯 SQL 滚）。
* 新增可观测字段 `stats.repairedHigh`：直连交易所补回来的**高周期**行数
  （`backfilled1m` 继续只统计 1m 那一路，两条路分开看）。

---

---

## 56. 连续性审计：`runGapCheck` 结构上看不见的那一类洞（2026-10-08）

### 56.1 怎么发现的

用户让我把本地整套流程跑一遍看恢复情况。K 线尾部、账户侧、余额快照都恢复了，
但顺手按「**行数 vs 跨度**」核了一遍整条序列：**1m 缺 620,603 分钟（11.4%）**，
而缺口巡检报出来的 1m 缺口**全是「差 1 根」的边界噪音** —— 一条真的都没报。

逐日拆（按 `lag()` 找洞）：

| 洞终点那天 | 漏分钟 | 洞数 | 来由 |
| --- | --- | --- | --- |
| 10-07 | 520,006 | 5,427 | 磁盘风暴那天（那片 1m 只有 57 MB，正常一天 192 MB） |
| 10-08 | 100,579 | 855 | 掉线 01:03→04:39（3.6 小时 × 525 币） |

**已排除迁移**：`candles_old` 里同样的洞一模一样（ENJ 1m 两边都少 03:34→05:37），
所以这是事故留下的原生缺口，不是 P3 分区迁移弄丢的。

**还验过它是"静止"的**（这是最有力的证据）：连采两次，行数涨了 1,269 行（实时在正常写），
而缺分钟数一动不动：

```
05:09:03  1m 缺 620593 分钟 / 行数 4825620
05:11:45  1m 缺 620585 分钟 / 行数 4826889
```

### 56.2 根因：两个检测器都是「只往后看」

```
repairSweep   ：从【库里最后一根】往现在补 —— 够不到它后面更早的洞
runGapCheck ②：窗口只有 120 根，而且 expected 是
                lo = max(floor(since/ms)*ms, floor(c.lo/ms)*ms)
                ⇒ 从「这个币在窗口里最早那根」开始数
```

`runGapCheck` 这么写是为了不冤枉新上市的币（它天生没有 120 根历史），
但副作用是：**洞只要顶到窗口左沿就完全隐形** —— 而且 `queueRepair` 的起点用的
是**同一个锚点**，所以连修也不会去修。1m 的窗口只有 2 小时，
于是「掉线 3.6 小时」这种最常见的事故，只要巡检下一次跑到时已经晚了 2 小时，
那个洞就**永远不会被发现、也永远不会被补**。

### 56.3 决定：做成**手动脚本**，不进底座常驻（用户定的）

用户原话：「审计的话没必要单独写在代码里吧，这玩意有缺失的话，我手动执行一遍脚本不就行了。
毕竟默认历史数据是没问题的。」

这个判断成立，而且代码里本来就有同样的先例：贵的「全量残桶体检」也是**手动**入口
（`GET /api/kline/gaps?run=full`），定时那套早就换成记账式复核了。
洞是**事故**留下的，不是常态 —— 为一件"平时没事"的事在服务里常驻一个定时任务不划算。

```
npm run candles:audit                       # 只报告，什么都不写（默认）
npm run candles:audit -- --repair           # 顺手补回来
npm run candles:audit -- --intervals=1m --oldest=20
npm run candles:audit -- --symbols=BTC/USDT:USDT,ETH/USDT:USDT
```

| 参数 | 作用 |
| --- | --- |
| `--repair` | 真的去补（默认只报告） |
| `--intervals=` | 只审这几档（默认 6 档全审） |
| `--symbols=` | 只审这几个币（给了就按币走索引，快得多） |
| `--oldest=N` | 打印最老的 N 个洞（默认 10） |
| `--max=N` | 最多修几个洞（默认 0 = 不限） |
| `--maxcalls=N` | 一个洞最多往前打几发（默认 8） |

**退出码**：还有洞就 `1`（干净是 `0`）—— 方便挂到别的地方当检查用。
`GET /api/kline/gaps?run=audit` 现在只回一句"请用脚本"，别让人以为线上没有这个能力。

### 56.4 它为什么跑得起（≈8 秒）——别把它改成"连值一起比"

判据只用 `count(*)` / `min` / `max`，这三样**全在主键索引里**
（`(exchange, market_type, symbol, interval, open_time)`）⇒ **纯索引扫描、零堆访问**。

实测逐档（本地这台 2 vCPU / 33MB/s 的盘）：

```
1m    3.47 秒   483 万行
5m    0.90 秒   109 万行
15m   1.16 秒   152 万行
1h    1.59 秒   224 万行
4h    0.41 秒    62 万行
1d    0.27 秒    35 万行
合计 ≈ 7.8 秒
```

⚠️ **千万别顺手把 `sum(volume)` / `array_agg(close)` 加进来**：那两列**不在索引里**，
每行都要回堆取页 —— 老的全量自洽扫描就是这么变成 **4 分 40 秒** 的
（也正是 2026-10-08 那次「发布后全站 502 三分钟」的元凶，见第 52/53 节）。
这就是 8 秒与 280 秒的全部差别。

### 56.5 ★ 顺手抓到的一次真事故：**用 REST 补一个"其实存在"的桶 = 降级**

`saveCandles` 是覆盖写（UPSERT），而不同来源的字段完整度**不一样**：

| 来源 | `trades` / `quote_volume` | 实测 |
| --- | --- | --- |
| `vision`（币安官方历史包） | **有** | 15m 953,828 行**全部**非 0 |
| `rollup`（由 ws 的 1m 滚出） | **有**（1m 是 ws 时） | 15m 05:00 桶 523 行里 468 行非 0 |
| `ws`（实时 1m） | **有** | 1m 65,648 行里只有 280 行是 0 |
| `seed` / `backfill` / `repair` / `audit`（ccxt REST） | **一律 0** | `fetchOHLCV` 只有 OHLCV |

而"补洞"走的 REST 正好是**最不全**的那一种 ⇒
**拿 REST 去补一个其实存在的桶不是补数据，是拿 0 盖掉真值。**

实测（就是 `candles:audit --repair` 第一次跑出来的真事）：15m 的 05:00 桶原本
523 行里 468 行带真实笔数，那一次覆盖把被碰到的 2 个币变成了
`trades=0 / quote_volume=0`（`source='audit'`）。

**修法：补存量洞一律 insert-only。**

* `db/candle-store.ts` 新增 `onlyMissing(rows, scope)`：写之前先问一句"库里已经有哪几个桶"，
  只留缺的（走索引，`open_time` 在主键里）；
* `rollupFrom1m(..., fillOnly)`：让数据库自己挡（`ON CONFLICT DO NOTHING`）。
  兜底 rollup 没法先滤（行是 SQL 里现算的）；
* `RepairJob.overwrite`（缺省 `false`）：**只有残桶裁决那条路**（`verifyPendingChecks`
  报上来的桶 —— 那一根本来就在库里、只是值不对）才置 `true`，那种情况覆盖正是目的。

被那次覆盖抹掉的两行已经从 ws 的 1m 用 `rollupFrom1m` 恢复
（`trades` 7600 / 9999、`quote_volume` 也有了，与邻居量级一致）。

⚠️ 顺带纠正一个我一开始搞反的方向：**rollup 不是"最差的那个"**。
它从 ws 的 1m 滚出来时，笔数是**真的**；只有 1m 自己是 `seed`/`backfill` 来的时候才存 0。
所以「高周期缺了」的正解是**直连那一档官方接口**（`vision` 最好，REST 次之），
不是"用 1m 重算一遍"，也不是"覆盖"。

### 56.6 还有一个口子（未改，留个记录）

`repairSymbol` 的**高周期**兜底 rollup 现在也走 `fillOnly`（只补缺），
所以"交易所没给、于是拿 1m 重算去盖"这条降级路已经堵上了。
但**1m 那一路**的 `source='backfill'` 写进去的 `trades` / `quote_volume` 仍然是 0
（ccxt 就不给这两样）—— 也就是说：如果我们去"补"一个已经由 ws 写好的 1m 桶，
它的笔数会被抹成 0。现在 `onlyMissing` 挡掉了这种覆盖，但**新补进来的 1m 桶**
（真的是洞的那些）天生就是 0。

要根治得让 1m 也有"带笔数"的来源：`vision` 的官方历史包**有** 1m，
而且是 0 权重 —— 拿它补老洞比 REST 又便宜又全。这属于另一个决定，**没有在这次一起做**。

---

---

## 57. 2026-10-08 查清的三件事（57.1 / 57.2 当天已改；57.3 结论是不做）

（全文保留排查过程与量化数据 —— 改的时候别再从头查一遍。）

### 57.1 排行榜基准：口径按用户的话改了，切换也不再重拉整表 ✅

**① 语义**：用户 2026-10-08 明确「任意时间指的是 **UTC 的任意 ±12**」——
要的是**任选一个时区偏移**，不是某个历史时刻。所以：

* `RankBase` 从三种（`off` / `tz` / `at`）**砍成两种**：`{kind:'off'}` 与 `{kind:'tz'; min}`。
  老的 `k:'at'` 落盘值**直接退回默认 24h**（硬映射成某个偏移会凭空改掉用户看到的口径）。
* 配置里那颗"任意…"点开从**时刻戳弹窗**换成 **UTC −12 … +12 的偏移选择器**
  （`UTC_OFFSETS`，25 个，整点）。⚠️ 25 个**不能铺成按钮**：390px 上会折行
  （用户要的是"每条一行"）⇒ 收进子弹层 `.tz-pop`（4 列网格 + 可滚）。
* 顺带：后端那三段只服务"很久以前"的挑档（`baseProbe` 的 15m / 1h / 1d）
  变成**到不了的路**（日切最多只到 1 天前 ⇒ 永远走 1m 那支）。代码留着，手动 `?since=` 还能用。

**② 切换慢 —— 实测不在后端，在前端"重拉整表"**（四档实测 0.13–0.20 s）。
改法：换基准**只补那一列**。

* 新增 `GET /api/markets/base?since=`，只回 `{symbol: close}`（525 个数 ≈ 10KB），
  跟 `handleMarkets` 共用 `baseCloseCache`（同一个 key 口径）。
* 前端 `loadBase()` **就地替换** `r.baseClose` → `version++`：
  **不 `byPair.clear()`、不重拉整表、不重建表格**（滚动位置和已有数据都留着）。
  用户 2026-10-08：「前端缓存还是有必要的，但是**数据不会被清**」—— 这条就是照它改的。
* **点已经选中的那颗直接 return**（原来每次都赋一个新对象 ⇒ `watch` 因引用变化照样触发，
  白白打一趟全表）。
* 回到 24h **一个请求都不发**：这一列本来就是行里现成的 `change24hPct`，清掉快照即可。
* 排序仍然切到「涨跌幅降序」（用户要的就是按基准涨跌排），但**不重拉数据** ⇒ 看着是当场重排，
  没有白屏 / 骨架闪。

### 57.2 交易所页四格刷新机制不一样 ✅（两条软肋都补了）

用户 2026-10-08 追问：「为什么不能改和持仓一样是实时的呢？难道没有实时数据吗？」
—— **不是没有实时数据**，对着代码核过：

| 格 | 数据怎么来的 | 交易所推不推 |
| --- | --- | --- |
| 持仓 | WS `ACCOUNT_UPDATE`（`a.P[]`）+ 标记价重算 | **推**，真实时、0 权重 |
| 成交历史 | WS `ORDER_TRADE_UPDATE`（每笔一帧） | **推**，真实时 |
| 仓位历史 | 交易所**没有**这种接口 —— 本地从成交推（`position-history.ts`） | 跟着成交走 |
| 资金动向 | 手续费/已实现盈亏：从**成交帧**里就地写（`writeIncomeFromFill`）⇒ 实时；<br>**资金费**（8h 结算）/ **划转**：交易所**没有任何 WS 事件** ⇒ 只能 REST `/fapi/v1/income` | 一半推、一半只能轮询 |

所以"看着不实时"的根子在**前端两个软肋**（都补了）：

1. **成交历史是三格里唯一没有 20 秒兜底的** —— `startSnapTimer` 只读 orders/cycles/income
   ⇒ 事件一丢（SSE 重连 / 后端重启 / 后端那条用户流哑了）列表就**停在旧数据**，
   只能切 tab 或刷页面。现在**加进 20 秒兜底**（读自己的库，毫秒级、零交易所权重）。
2. **`reconnect` 漏了 `loadIncome()`** —— 快照/成交/曲线/挂单/仓位历史都补了，就它没补
   （日常靠 20 秒兜底盖住，但那意味着"最久迟 20 秒才动"）。现在补上。

⚠️ 仍然**只能**受对账节奏限制的部分：**资金费 / 划转**（数据源没有推送）。
资金费 8h 才结算一次，所以现在的对账频率（活跃 8h / 空闲 16h）是**对齐结算周期**的；
要更"实时"只能把 `INCOME_RECONCILE_MS` 调小（代价 30 权重/发）—— **这一条没动**，
因为它是数据源的硬限制，不是前端/后端的缺陷。

⚠️ 另一条重要的更正：用户 2026-10-08 指出「和 APK 没有关系呀，浏览器也一样」。
当时我把这个现象部分归给"已发布的 APK 落后（0.2.8 构建于 10-07 19:21，落后于 22:47 的
仓位历史修复）"—— **那个归因对本条不成立**：浏览器跑的是同一份前端代码，所以上面两条
软肋同时在浏览器里。APK 落后这件事本身仍成立（值得重打一版），但它**解释不了**这一条。

### 57.3 SSE 要不要合并：**已论证，不做**

用户问「K 线的开单分析和我的交易所 SSE 等可以共用吗」。结论是**不必**：

* 后端五条独立路径：`/api/exchange/stream` · `/api/kline/stream` · `/api/tickers/stream`
  · `/api/analyze/stream` · `/api/knowledge/stream`。
* 前端 [`sharedSse`](../frontend/src/api.ts) **已经按 path 多路复用**了：
  全站想要同一条 path 的组件共用一条连接，切页来回不重连。同 path 的共用早就解决了。
* `/api/analyze/stream` 是**任务型一次性流**（跑一次大模型、推 `step`、`done` 就 `res.end()`），
  代码里明令**不许**套 `liveSse`：断线重连会**再开一个任务、再花一次钱**。
  硬合并等于把"一次性任务"挂到"长连接"上。
* 想合并的动机通常只有浏览器「每源 6 条连接」—— 线上是 **HTTP/2**（实测
  `curl -I https://bitcoooin.cn` 回 `HTTP/2 200`，还宣告了 `h3`）⇒ 这个上限不成立。
* 而且**开单分析根本不碰账户**：`runAnalysis` 的入参只有
  `userId / symbol / market / timeframe / days / at`，没有 keyId ⇒ 也没有"可共用的数据"。

### 57.4 顺带澄清：为什么「行情条 已预热 60/60」还在（K 线已经不预热了）

这两条日志**不是同一件事**，别以为漏改了：

* **K 线不再预热**（2026-10-07 P1）：读路径已改成「内存 → 库 → REST」，第一次点币
  是本地库读（毫秒级、**0 权重**），`warmCandlesCache` 与每 10 秒保活都已删除。
* **行情条仍然预热**：`/api/ticker` 一个币要**并发打 4 趟交易所**
  （`fetchTicker` + `fetchFundingRate` + `fetchOpenInterest` + 366 根日线基点，
  见 [`market.ts`](../backend/src/data/market.ts)），冷启实测 **~1.07 s**。
  其中**资金费率 / 持仓量库里根本没有**（K 线底座只存 OHLCV）⇒ 没法像 K 线那样改成读库，
  只能靠预热让第一发命中缓存。

