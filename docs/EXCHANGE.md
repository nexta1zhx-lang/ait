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
| **快照** | 合约钱包/保证金/可用/浮盈 + `assets` + `positions` + C2C | **落库** | WS 事件 + 5 分钟采样 + 手动刷新 |
| **成交（账本）** | 逐笔成交 + 已实现盈亏 | **落库（永久）** | WS 事件驱动 |
| **实时** | 挂单、当前余额 | 内存缓存 | 收到事件就更新；15~30s 过期 |
| **兜底** | 全量对账 | 不存 | 15 分钟一次 REST |

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
- 每 5 分钟定时采样一条（`source='poll'`）← 就算 WS 一直没动静也有心跳
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
| **服务长时间停**（部署 / 机器重启 / OOM 反复） | 快照整段空白 | ⚠️ 分钟级**补不回**（币安没有分钟级历史权益接口）<br>✅ **天粒度能补**：实测 `/sapi/v1/accountSnapshot?type=FUTURES` **可用**（每日一个点，回溯 30 天） |

据此加四条设计：

1. **锚点快照**：绑定 key、进程启动、优雅关闭（SIGTERM）各写一条，
   `source = bind | boot | shutdown` —— 曲线**两端都有锚点**，不会出现"开头/结尾没有点"。
2. **断档要看得见**：曲线**不插值**，两点之间画直线；空档 > 2× 采样间隔就画成**断点/虚线**，
   **绝不假装那段时间有数据**。
3. **启动补数据**：启动时若发现最后一条快照早于 N 小时（比如 2 小时）⇒
   用 `/sapi/v1/accountSnapshot?type=FUTURES` 回补天粒度点（`source='snapshotApi'`，
   界面上可以和实测点区分）。
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

**保留期**：快照 30 天（滚动删，跟 `db/prune.ts` 那套一起做）；**成交永久**。

---

## 5. 实时层（WebSocket 用户数据流）

> ### ⚠️ M0 已实测（2026-10-05，用仓库里那套币安合约 key 真跑的）—— 结论**推翻了最初设想**

| 验的东西 | 结果 |
|---|---|
| ccxt 的 `watchOrders()` | ❌ **抛 `binance watchOrders() is not supported yet`** —— 社区版的 `watch*` 只是基类占位，真实现要付费的 ccxt.pro ⇒ **不能靠它** |
| `POST /fapi/v1/listenKey`（ccxt 的 `fapiPrivatePostListenKey`） | ✅ 通，拿到 64 位 listenKey |
| **自己连裸 WS** `wss://fstream.binance.com/ws/<listenKey>` | ✅ **429ms 连上，15 秒稳定不断** |
| `/fapi/v2/account` | ✅ 字段全中；⚠️ `positions` 返回**全部 920 个槽位**（绝大多数 `positionAmt=0`）⇒ 必须过滤 |
| `/sapi/v1/asset/wallet/balance` | ✅ 通；⚠️ **钱包名各账号不一样**：文档写 `"C2C"`、实测本账号是 `"Funding"` ⇒ 必须两个都认；⚠️ **`assetBalances[]` 里没有 `balance`**（钱在 `free`/`locked`/`freeze`/`withdrawing`）—— 读错字段会**静默算成 0** |

⇒ **实时层自己写**：listenKey 搭 ccxt 的隐式方法（`fapiPrivatePostListenKey` / `PutListenKey` /
`DeleteListenKey` ✓ 已验证），WS 用 `ws` 包直连 `wss://fstream.binance.com/ws/<listenKey>`。
**自己管三件事**：30 分钟续期（`PUT`）、指数退避重连、重连后 REST 对账。
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
   ⇒ 15 分钟一次 REST 全量对账（`/fapi/v2/account` + `income`），**不一致以 REST 为准**。
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
`52.194.6.144` 一个就永远不用改；顺带把「TUN 和 SSH 打架」那件事也一起绕开
（只拐你那个 dev 进程，不拐整机）。

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

### 📌 代理 TUN 和「本地开发」是打架的（2026-10-05 实测）

| | 代理 TUN 开着 | 代理 TUN 关着 |
|---|---|---|
| SSH 到服务器（`release.sh`） | ✗ 被劫持（`kex_exchange_identification: Connection closed`，连 `203.0.113.7:9999` 都“连得上”） | ✓ 通 |
| 本机连币安（K 线行情 / 刷币种表） | ✓ 通 | ✗ 直连被墙 |

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
→ 仓位统计 → 二级 tab（持仓 / 挂单 / 盈亏 / 成交 / 资产）。

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
| **M2** ✅ | `exchange-stream.ts`（WS 常驻 + 重连复用 listenKey + 重连补成交）+ 5 分钟采样兼对账 + SSE `/api/exchange/stream` | 数字开始秒跳 |
| **M3** ✅ | 成交/盈亏**读**接口 + 前端接真数据（`交易所账户` tab 换成 `ExchangeAccountLivePanel`，SSE 接上） | 去掉 mock（界面已用真数据） |
| M4 ✅ | 资产曲线：`GET /api/exchange/history?id=&range=1d\|7d\|30d` + `ExchangeCurveChart.vue`（echarts：close 折线 + high/low 区间带、断档不插值） | 2026-10-05 完成 |
| M5 ✅ | 删 mock / 预览页 / 老面板 / 老 `/api/exchange/account`（连同它那套余额估值、全量订单、已实现盈亏函数） | 收尾（2026-10-05 完成） |
| M6 ✅ | K 线页底部**下单模块**（多空 / 滑动条 / 余额 / 杠杆）+ `/api/exchange/trade*` 三条接口 —— **只走测试单** | 2026-10-05 完成（`comps/OrderPanel.vue`） |
| M6.1 ✅ | 下单模块改版：顶部两格 **「开单」/「仓位」**（市价降级成开单页里的开关：开着价格框禁用、关掉可填 = 限价单）；仓位页简略显示持仓 + 平仓 / 全部补仓；顶栏**一键平仓**。新增 `POST /api/exchange/trade/close` | 2026-10-05 完成 |
| M6.2 ✅ | 下单模块：**去掉「补仓」**、仓位页改成「账户里所有持仓，每条自带平仓」、顶栏标题换成**在用的那套账户名**；「配置」里新增**下单账户**切换（`trade-account.ts`，落 `localStorage.ca-trade-key`） | 2026-10-05 完成 |
| M6.3 ✅ | 下单模块第三版：顶栏**删掉账户昵称和「测试单」标签**、`一键平仓` 挪到**最右**并加二次确认；账户名（`.ktag`）+ 可用余额挪到**价格行右侧**、价格输入框收窄到 130px；**「测试单」变成「配置 → 测试下单」开关**，关掉走真单（`/fapi/v1/order`），真单模式顶栏挂红色「真单」章 | 2026-10-05 完成 |
| M7 ✅ | **多账户视图**：「交易所账户」页顶部的账户下拉框换成 **tab 条（`全部` + 每套 Key 的名字）**；`全部` = 各套快照**加总**（持仓/挂单/盈亏按账户拆行并打 `.ktag` 标签，曲线按时间桶相加），单套时不合并、也不打标签 | 2026-10-05 完成（`comps/ExchangeAccountLivePanel.vue`） |

| M8 ✅ | **现货（只 USDT）进统计** + **万能划转**：净资产 = 合约 + C2C + 现货USDT（快照加 `spot_usdt` 列）；「交易所账户」净资产那行加「划转」按钮 → 弹层支持现货/资金/合约之间六种组合（**真钱**，无测试接口，常驻警示 + 二次确认） | 2026-10-05 完成 |
### 多账户视图（M7）—— 为什么是「加总」而不是「切来切去」

一套 Key = 一个账户，但用户手上可能同时挂好几套（主号 / 小号 / 测试号）。
看总账是常态，看单号是例外 ⇒ **默认落在 `全部`**，tab 条才有意义。

- **数据层**（`ExchangeAccountLivePanel.vue`）：每套 Key 各发一条
  `GET /api/exchange/overview?id=` / 一条 `SSE /api/exchange/stream?id=`，
  结果按 key_id 攒在 `parts` 里，`rebuild()` 用 `mergeOverviews()` 合成一份给纯展示的
  `ExchangeAccountBoard`。⚠️ 因此这个页面的 SSE 是**并行 N 条**（N = 账户数），
  离开 tab 时必须 `stopStreams()` 全关，不然 EventSource 会一直挂着。
- **合并口径**：金额类（钱包 / 可用 / 未实现 / C2C / 名义）**求和**；
  `takenAt` 取**最旧**那一份（合并视图的「几分钟前」按最差的说，别报喜不报忧）；
  持仓列表**拼接**并给每条塞 `keyName`；成交/挂单/盈亏按（`keyName` + 交易对）分组，
  界面上打 `.ktag` 小标签区分来源 —— 同一个币在两套账户上各有一条时，不分就会看成一条。
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
| 断档补数据 | 可以用 `/sapi/v1/accountSnapshot?type=FUTURES`（日点，北京 08:00，回溯 30 天） |

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

### P3 · 后端对前端接口**一个闸都没有** → 权重预算 + 单飞 + TTL

限流按**出口 IP**算，而一台服务器只有一个出口 IP 给所有用户用。
新增 `backend/src/util/rate-budget.ts`：滑动窗口，默认 **1200 权重/分钟**
（币安是 2400，故意留一半给 K 线预热 / 行情 REST 兜底 / 划转那些路径）。

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
| 账户界面换 tab 重拉 | 挂载/切 tab（`parts` 保留，切回来秒开） | 只挂单那一项（10 秒缓存） |
| K 线叠加：挂单 / 成交 | 15 秒（**只剩这两样**，持仓已由 store 提供） | 是（1 + 5） |
| K 线叠加 账户级盘点 | 300 秒（跨标签页 localStorage 节流） | 是（40/条） |
| 常驻流：`ACCOUNT_UPDATE` → 快照 | 20 秒节流 | 是（25/次） |
| 常驻流：5 分钟采样 | 300 秒 | 是（25/次） |
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

⇒ 所以改法的核心是：**定期**（60 秒）用 REST 对账，窗口取「24 小时」和
「账本最后一笔」里**更早**的那个。这样即使某一笔事件丢了，下一轮也会把它捞回来。

### 改法一：REST 定期对账（止损）

`backend/src/exchange-stream.ts`：

- **成交**（`fetchMyTrades`，权重 5/币）：每 **60 秒**一轮，起点取
  「**24 小时安全窗口**」和「账本最后一笔」里**更早**的那个
  （⚠️ 只看最后一笔会**跳过错单** —— 漏的正是账本里没有的那笔）。
- **钱账本**（`/fapi/v1/income`，**权重 30**）：每 **10 分钟**一轮，回看 7 天。
  两个水位初值都置 `0`，让第一轮 tick（60 秒后）就把两边各对一次。
- **每个币单独 try/catch**：以前一个币抛错（如某币下线回 `-1121`）整轮中止，
  后面的币全不补 —— 一个坏币能拖死整本账。
- 成交落库时**顺手写一份钱账本**（`realized` + `-fee`），所以 60 秒那轮
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
- **账本不全**：币安 `userTrades` 只给最近 7 天，所以第一笔就是平仓的那种段
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
- **income 接口权重 30**：别跟着那 60 秒的成交对账一起跑。
- **仓位历史读的是账本，不是 income** —— income 只用来给持仓卡的「已结」供数。
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

### 2026-10-06 补：条件单那一路**不能再静默吞错**

`listOpenOrders` 里原来两条都是 `.catch(() => [])`。经隧道时条件单那一路会**超时**，
于是「取不到」被写成了「账户里一条条件单都没有」—— 跟真的没有**长得一模一样**
（这正是用户「止盈止损单不在挂单里」的另一半原因，另一半是账户页压根没调这个接口）。
现在改成 `Promise.allSettled`：单边失败**记日志**，两边都失败才抛。

### 2026-10-06 补：字段名错位会让 `NaN` 变成 `$0.00`

`IncomeRow` 后端回的是 `amount` / `datetime` / `incomeType`，前端类型那会儿写的是
`income` / `time` / `type` —— 直接 `Number(undefined)` = **`NaN`**，
而 `signedMoney(NaN)` 渲染出来是 **`+$0.00`**，看着像「没赚没亏」，其实是算错了
（持仓卡上的「已结」就这么错过一次）。
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
| **60 秒** | REST 对账**成交**（24 小时安全窗口，每币单独 try/catch） | `FILL_RECONCILE_MS` |
| **10 分钟** | REST 对账**钱账本**（`/fapi/v1/income`，含资金费，权重 30） | `INCOME_RECONCILE_MS` |
| **30 秒** | 用户数据流健康检查（连 ping 都没有 4.5 分钟 ⇒ 标记降级） | `WS_HEALTH_MS` |
| **5 分钟** | 全量快照 + 落库（**钱包 / C2C / 现货只有这一条路**，它们没有 WS 事件） | `SAMPLE_MS` |
| **1 小时** | 快照归档 5m→1h→1d + 清理 | `exchange-archive.ts` |
| **3 秒**（按需） | 上游 WS 哑时退回 REST：K 线 / 行情条 / **标记价** | `kline-stream.ts` |

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
REST 对账（连上/重连 + 每 2 分钟，40 权重）┘        │
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
| 成交对账 | 60 秒 | 5/币 | **0**（无持仓且近期无成交时 `symbolsToBackfill()` 为空，不发） |
| 标记价流 | 1 秒 | 0 | **0**（无持仓时全部退订） |
| 合计 | | | **≈27 权重/分钟/套** |

⇒ **约 88 套闲置账户就能把整个出口 IP 的额度吃光。**
一个几个月没登录、没有任何仓位的账户，不该跟一个正在交易的账户花一样多。

### 改法：`isIdle()` 时分两档

`isIdle()` = **没持仓 + 没挂单 + 最近 10 分钟没动静**（成交 / 挂单变动 / 对账成功
都会刷新 `lastActivityAt`）。

| | 活跃 | 空转 |
|---|---|---|
| 挂单对账 | 2 分钟（40 权重） | **30 分钟** |
| 钱账本对账 | 10 分钟 | **30 分钟** |
| 全量快照 | 5 分钟 | **30 分钟** |
| 私有 WS + listenKey | 连着 | **照样连着** |

空转时 ≈**1.3 权重/分钟/套**（降了 20 倍），88 套变 1800 套。

⚠️ **降频降的是「对账」，不是实时性**：私有 WS 和 listenKey 一直连着，
所以空转账户突然来一张新挂单 / 新成交，币安经 `ORDER_TRADE_UPDATE` 推过来还是秒级，
`syncOrderFromEvent` 立刻落库 + 推 SSE。REST 对账只是「防丢事件」的兜底。
状态翻转时打一行日志（`空转（无持仓无挂单）→ 对账降频到 30 分钟一轮`），
不然「到底有没有在降频」完全看不见。

### 还没做、但该考虑的（规模上来之后）

1. **完全离线就停流**：现在登录过、配了 Key 的账户，进程一启动就常驻连接
   （币安对 WS 连接数有限制：300 次/5 分钟/IP）。真到几百套时应该按
   「最近有没有人看 / 有没有仓位」决定要不要起流，停了之后靠一次全量对账追平。
2. **错开启动**：`startExchangeStreams` 现在 `await sleep(1000)` 串行起流
   （币安的连接限速），几百套时启动要几分钟 —— 应该只给「活跃」的先起。
3. **快照写入量**：5 分钟一条 × 套数，虽然归档（5m→1h→1d）已经做了，但
   全空转账户的曲线其实是直线，可以合并得更狠。
