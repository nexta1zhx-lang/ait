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
>   ⚠️ 账本只覆盖最近 7 天（币安只给这么久），标题的 N 天就是从这来的。
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
| **M2** ✅ | `exchange-stream.ts`（WS 常驻 + 重连复用 listenKey + 重连补成交）+ 5 分钟采样兼对账 + SSE `/api/exchange/stream` | 数字开始秒跳 |
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
| 成交对账 | 60 秒 | 5/币（≤8 个币） | **≤40** ← 见下面那条更正 |
| 标记价流 | 1 秒 | 0 | **0**（无持仓时全部退订） |
| 合计 | | | **≈67 权重/分钟/套** |

⇒ **约 36 套闲置账户就能把整个出口 IP 的额度吃光。**
一个几个月没登录、没有任何仓位的账户，不该跟一个正在交易的账户花一样多。

> **⚠️ 更正（第三节审计时发现）**：这一版最初写「成交对账空转时 = 0」是**错的**。
> `symbolsToBackfill()` 取的是**账本里最近 30 天交易过的币**（不是「当前持仓」），
> 所以一个「昨天交易过、现在空仓」的账户照样会逐币查，**≤40 权重/分钟**，
> 比挂单那 40/2分钟 还高一倍。漏了它，整个「空转」就算不出真实收益。

### 改法：`isIdle()` 时分两档

`isIdle()` = **没持仓 + 没挂单 + 最近 10 分钟没动静**。

`lastActivityAt` 只在**账户里真的发生了什么**时才刷新：WS 数据帧、`ORDER_TRADE_UPDATE`、
新记进来一笔成交、挂单集合真的变了、用户下单 / 订阅。**我们自己发起的那一发轮询不算！**

> ⚠️⚠️ 这一条是被**实测**逼出来的（2026-10-06）：原来 `snapshot()` 每轮都会把
> `lastActivityAt` 顶到「现在」，而采样定时器 5 分钟就采一次
> ⇒ `Date.now() - lastActivityAt` 永远 < `IDLE_MS`（10 分钟）
> ⇒ **空转那一档从来没生效过**（`f94cd99` 那个 commit 是空转的），
> 用户问的「长时间没有仓位呢」正好戳在这个洞上。
> 自己问自己「有没有动静」，答案永远是有。

| | 正常档 | 空转 |
|---|---|---|
| 成交对账 | 5 分钟（5/币） | **10 分钟** |
| 挂单对账 | 10 分钟（40 权重） | **30 分钟** |
| 钱账本对账 | 30 分钟 | **60 分钟** |
| 全量快照 | 5 分钟 | **30 分钟** |
| 私有 WS + listenKey | 连着 | **照样连着** |
| 合计 | ≈**16** 权重/分钟/套 | ≈**4** 权重/分钟/套 |

> ⚠️ 这张表里的「正常档」是第 19 节那次收敛**之后**的数（原来成交是 60 秒、挂单 2 分钟、
> 账本是 10 分钟，合计 ≈67）。改的理由见第 19 节：在线也不提速，兜底只按「最小必要」。

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

| | 正常档 | 空转 | **睡着** |
|---|---|---|---|
| 成交对账 | 5 分钟 | 10 分钟 | **1 小时** |
| 挂单对账 | 10 分钟 | 30 分钟 | **1 小时** |
| 钱账本对账 | 30 分钟 | 60 分钟 | **1 小时** |
| 全量快照 | 5 分钟 | 30 分钟 | **1 小时**（余额曲线靠它） |
| 私有 WS + listenKey | 连着 | 连着 | **照样连着** |
| 合计 | ≈16 权重/分钟/套 | ≈4 | **≈2.2** |

**合约和订单的对账基本停掉，余额照采** —— 这就是用户要的那个平衡：
`exchange_snapshots` 是资产曲线**唯一**的源，睡着期间断采，曲线上就会留一段假的空洞；
而余额其实只有资金费（8 小时一次）会动，1 小时采一次已经很富余。

⚠️ **私有 WS 一直连着**，所以「用户在手机上开了仓 / 挂了单」币安照样推过来，
`onOrder` 一进来 `lastActivityAt` 就刷新、账户立刻醒（下一轮 tick 就把三个对账补上）。
**降的是「我们自己主动去问」的频率，不是实时性。**

### 醒来：`wake()`

两个入口：

1. **有人订阅**（`subscribeExchange` 里调）—— 用户点开账户 / 刷新页面；
2. **写操作**（`reconcileKeyOrders`，即下单 / 平仓 / 撤单 / 改杠杆之后）。

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

| 档 | 判据 | 成交 | 挂单 | 账本 | 快照 |
|---|---|---|---|---|---|
| `normal` | 有仓 / 有单 / 10 分钟内有动静 | 5 分钟 | 10 分钟 | 30 分钟 | 5 分钟 |
| `idle` | 无仓无单 + 10 分钟没动静 | 10 分钟 | 30 分钟 | 60 分钟 | 30 分钟 |
| `asleep` | 空转 + 2 小时 | 1 小时 | 1 小时 | 1 小时 | 1 小时 |

代码上是**一张表**（`TIER_GAPS`），别再散成一堆三元表达式。
正常档从 ≈67 权重/分钟/套 降到 ≈**16**。

> ⚠️ 这张表是**那一轮**的值（5/10/30 分钟）。后来又改过两次：
> §27 统一到 **1 小时**，§29/§30 按冗余度拆成 **4 / 6 / 8 小时**（`idle` 相应 ×2）。
> **要看现在的值请直接看 §27 的表**，别拿这张。

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

> 这一节取代原来 §24–§30 那七节（排查流水、被取代的降频方案、WS 终止流程）。
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
  避免 15 秒一轮的数据回来把标签下标打乱。
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
> **P4（待做）**：行情层换 `!miniTicker@arr` + `!markPrice@arr`。

### 定稿（实测数字都是这台机器上真跑出来的）

| 项 | 定稿 | 依据 |
|---|---|---|
| 底座订阅 | **525 币 × `@kline_1m` 常驻**，1 条上游连接 | 实测覆盖 525/525、首帧 173 ms、434 帧/秒、130 KB/s |
| 连接与流 | **1 条连接 / 526 条流** | 1050 条一条连接会被 `{"code":4,"msg":"Too many subscriptions"}` + `1008 Invalid request` 踢（实测 0 帧） |
| 高周期 | **收盘 rollup 物化六档**，不额外直订 | 4h/1d 直订实测要多 **2 条连接 + 897 帧/秒 + 278 KB/s**（成本 ×2.1），只买到「漏分钟保险」 |
| 行情层 | `!miniTicker@arr`（51 KB/s，替 `!ticker@arr` 的 104）+ `!markPrice@arr`（39 KB/s、3 秒一轮全市场） | 每条流单独实测；涨跌幅用 `(c−o)/o` 推 |
| 落库 | **只落已收盘的 1m**（8.75 行/秒）+ 六档；保留 1m/5m 7 天、15m 30 天、1h 400 天、4h/1d 永久 | 不落未收盘那根：525 upsert/秒换不到任何体验 |
| 内存 | 每币 × 每高周期一个累加器 ≈ **1 MB**（不存热层） | 宿主只有 909 MB（压测期 available 掉到 ~300 MB） |
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

### 机器实测（同一台 Lightsail，909 MB 内存 / 2 vCPU）

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
  ③每日抽样对账。见下面「三档校验」一节。**行情层换聚合流（`!miniTicker@arr` /
  `!markPrice@arr`）**挪到 P4：它跟校验无关，是纯粹的带宽优化，单独一轮做更干净。

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

| 档 | 查什么 | 花什么 | 抓得到 | 抓不到 |
|---|---|---|---|---|
| **① 实时** | 写入前：桶对齐 / OHLC 关系 / 值域 / 同批重复与倒序 | **0**（纯内存） | 坏值入库（上游抖、调用方算错） | 库里**已经**存在的错 |
| **② 定时**（5 分钟） | 存在性（窗口内该有多少根）+ 库内自洽（高周期桶 vs 1m 重算） | **0**（纯库内 SQL） | 洞、残桶、陈旧值、漏帧 | **1m 自己写错**（1m 是对的基准） |
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


