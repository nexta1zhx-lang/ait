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

## 21. 「MM 合约保证金率」挂在配置齿轮旁边（2026-10-06）

用户：「再配置旁加个显示 mm 合约保证金率」→「样式改一下根据风险来变色」。

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

## 24. 「减仓之后没有推送事件、盈利没实时变」（2026-10-06 用户问）

用户原话：「刚才试了减仓后，没有推送事件吗，仓位盈利没有实时变化」。

### 先取证：这次到底发生了什么

时间轴（本地 13:1x，日志 `~/Library/Logs/ait-server.log` + 库 `exchange_fills`）：

| 时刻 | 事实 | 证据 |
|---|---|---|
| 13:18:01 | 挂上 `RLCUSDT sell STOP_MARKET 0.7684 × 26.5 reduceOnly` | 库里 `exchange_open_orders` |
| 13:19:46 | 交易所上真的减了 6.6（已实现 +1.18272） | 成交 `ts` = `05:19:46.384Z` |
| 13:19:46~13:20:12 | **本地账本没有这一笔**，日志里**一条事件行都没有** | `exchange_fills.created_at` = `05:20:18.702Z` |
| 13:20:12 | 进程重启 → `reconcile('boot')` | `[exch:7] REST 补成交 1 笔` |

⇒ 结论：**私有 WS 那一刻一帧都没给**（`订单事件` 一行都没有，`badFrames` 也没有，
说明不是「收到解不开」），而 `WS 收到 ping（连接是活的）` 又是有的 ——
**心跳正常、业务事件不来**，跟之前几次丢单是同一个病（见 §14）。
这一笔最终是靠 REST 补成交在 **32 秒后**捞回来的。

### 但真正该修的是「我们自己下单之后不该指望 WS」

`reconcileKeyOrders()`（下单 / 平仓减仓 / 撤单 / 挂条件单之后都调它）原来是这样：

```ts
s.wake('写操作', {skipOrders: true})   // ← 没带 force
```

`wake` 不带 `force` 就受 `FRESH_MS`（60 秒）约束：
**一分钟内已经采过一次快照 ⇒ 减完仓只对了一次挂单，持仓数量和它算出来的浮盈还停在减仓前。**
用户看到的就是「减了仓，界面上那个仓位/盈利一动不动」。

现在写操作走**强制**那条路（`force` + `skipIncome`）：

```ts
s.wake('写操作', {skipOrders: true, force: true, skipIncome: true})
```

- `force`：无视 `FRESH_MS`（只受 3 秒的连点节流），**当场**重新拉快照 ⇒ 持仓量 / 浮盈立刻对上；
- `skipIncome`：不再单独跑 `income` 那一发（权重 30）—— 这一笔的已实现盈亏和手续费
  由成交对账（`backfillFills` → `saveTrade`）用**同一个 `tranId`** 写进钱账本，
  `income` 那个接口只补 `FUNDING_FEE` / `TRANSFER` 这类成交里没有的；
- 代价：一发快照 25 + ≤8 币 × 5 权重，**只在用户真的下单 / 平仓 / 撤单时发生**。

⇒ 用**我们面板**减仓，从这一刻起不依赖 WS 了：1 秒内账本、持仓、浮盈全对平。
只有在**币安 App 里**操作时，才仍然要等 WS（会丢）或兜底（`FRESH_MS` / 手动刷新 / 5 分钟成交对账）。

### 顺手挖出来的两件事

**① 启动那一刻的补账是「N 个订阅 × N 轮全量对账」**（这才是把 IP 打进 `-1003` 的推手）

日志实证：进程刚起来时 `lastSampleAt = 0`，几个页面 / 几个订阅同时接上 SSE，
**每条订阅都调一次 `wake`、每个都判定「数据旧了」**，于是 5 轮
「快照 25 + 成交 5 + 账本 30 + 挂单 40」同时打出去：

```
[exch:7] 补账（有人打开页面·数据旧了）      ← ×5
[exchange/refresh] binance 429 Too Many Requests … IP(…) 2400 requests per minute
[market] 头部 ticker 连续 3 次失败：429 …
```

现在 `wake` 有**并发闸**：同一套账户同一时刻只跑一轮，跑的那一轮干的活跟它们一样多，
多出来的全是白花；`force`（写操作）不会被吞掉 —— 记一笔 `wakeAgain`，跑完再来一轮轻的
（快照 + 成交）。

**② 被限流了还在重试 = 纯亏**（新增 `util/rate-cool.ts`）

- 收到 `-1003` / `429` ⇒ 记一个**冷却截止**（默认 20 秒，`EXCHANGE_COOL_MS` 可覆盖），
  冷却期内 `takeWeight` 直接拒绝（回一句人话），`withRetry` **一次都不打**（原来会白打 2 次再放弃）。
  一个冷却窗口只打一行 `[cool] 交易所限流（-1003）…`，不刷屏。

### 还堵了两个「事件静默消失」的洞

| 洞 | 原来什么样 | 现在 |
|---|---|---|
| `ws.on('message')` 没有 `.catch` | `onMessage` 抛一次（DB 抖、字段缺、NaN）⇒ **未处理的 Promise 拒绝**，事件凭空消失，日志一个字没有 | 打一行 `WS 事件处理未捕获（事件丢了，等兜底）` |
| `onMessage` 分发没 try/catch | 同上，且 `E` 类型出错连「是哪类事件」都不知道 | 打 `处理事件 X 失败（这笔先丢，等兜底对账）` |
| 没见过的事件类型 | 静默忽略（`MARGIN_CALL` / `ACCOUNT_CONFIG_UPDATE` / `CONDITIONAL_ORDER_TRIGGER_REJECT` …） | 记一行 `收到没处理的事件类型 X`（每种一次） |
| `unhandledRejection` | Node 15+ 默认**直接退出进程**（流全断、账全停） | `server.ts` 兜住并记一行，**不退出**（交易服务宁可降级别猝死） |

### 「事件到底到没到」以后怎么看日志

```
[exch:7] 收到事件帧 e=ORDER_TRADE_UPDATE      ← 进了（头 5 帧都打）
[exch:7] 订单事件 s=RLCUSDT x=TRADE X=FILLED t=3481234 l=6.6
[exch:7] WS 收到第 1 个 ping（连接是活的）     ← 只是心跳，**不代表事件会到**
```

**没有任何 `收到事件帧` = 事件真没到**（不是我们吞了）；有 `收到事件帧` 但账本没动，
才轮到查我们自己的处理逻辑。

## 25. 根因排查：`/ws/<listenKey>` 这条路上，币安**一个业务字节都不推**（2026-10-06 第二轮）

用户：「不要模拟了，你用真的测」⇒ 下面全是真账户上的实测，不是推断。

### 逐项排除（每一条都有可复现的观测）

| 环节 | 观测 | 判定 |
|---|---|---|
| 代理 / TLS | 对端证书 `subject={"O":"Binance Holdings Limited","CN":"*.binance.com"}`、`issuer=DigiCert/GeoTrust` | **正常，没被中间人** |
| 网络路径 | **同一个** `wsAgent()`、**同一个** host、只差 path 的 `/market/ws`：`654 帧 / 75.1 KB`；我们的 `/ws/<listenKey>`：`0 帧 / 0.3 KB`（= 只有握手） | **不是代理在丢帧** |
| listenKey 接口 | `last_request_url = https://fapi.binance.com/fapi/v1/listenKey` | **打对了** |
| listenKey 有效性 | `PUT` 续期成功并回同 key；`DELETE` 之后 `PUT` 报 `-1125 This listenKey does not exist` | **key 是真的、能删能续** |
| 「谁抢了流」 | `DELETE` → **新建一把全新的 key**（`HC6TMFD52Tcb…`，没人抢、只有我们两条连接）→ 直连交易所打**真单**（`RLCUSDT sell 0.9`，`id=8381646990 status=closed`）⇒ **两条连接 0 帧** | **「本地 vs 线上抢同一把 key」被证伪** |
| 事件真的发生了 | 真成交（上面那笔）+ 免费可逆的划转（`UMFUTURE_MAIN` / `MAIN_UMFUTURE`，tranId 有回执）+ 杠杆 10↔11 | 不是「没有事件」的问题 |
| 什么是「订阅生效」 | 用**伪造的** key（64 个 `A`）连 `/ws/<listenKey>`：`open ✓` + 收到 ping + 0.3 KB + 0 帧 —— **跟真 key 一模一样** | 「连上 + 有 ping」**不能**作为订阅生效的证据 |
| 我们这侧的静默丢失 | `ws.on('message')` 无 `.catch`、`onMessage` 无 try/catch | 已堵（见 §24），且这一轮**没有**任何 `badFrames`/未捕获日志 ⇒ 不是我们吞了 |

**最关键的一条**：删掉 key 的那一刻，本地服务**正连着那把 key**，币安本该立刻推
`listenKeyExpired`（官方原文：*"When the `listenKey` used for the user data stream turns expired,
this event will be pushed"*）——**日志里一条都没有**（`收到事件帧 / 订单事件 / listenKey 过期` 累计 0 行）。

⇒ 结论：**在我们这个出口上，`wss://fstream.binance.com/ws/<listenKey>` 连上了、被 ping 了，
但币安不往里推任何业务帧（连 `listenKeyExpired` 都不推）**；跟「谁持有 listenKey」无关。

### 复验方法（换出口）

`scripts/userstream-probe.mjs`（自包含，只用项目既有的 `ccxt` / `ws` / `pg`）：

```bash
KEY_ID=7 node scripts/userstream-probe.mjs           # 读库里那把 key 的凭据
KEY_ID=9 node scripts/userstream-probe.mjs           # 另一套
API_KEY=… API_SECRET=… node scripts/userstream-probe.mjs
```

它做四件事：`POST /fapi/v1/listenKey` → 连两条 `/ws/<listenKey>` →
造一个**免费可逆**的真事件（合约钱包 ↔ 现货 划转 1 USDT）→ 打印每一条收到的帧。

- 出现 `★★★ 事件帧` ⇒ 这条出口能收到，把用户数据流放在这台机器上就对了；
- 只有 `ping`、收到 ≈0.3 KB、0 帧 ⇒ 这条出口同样收不到，**不是抢流的问题**。

⚠️ 老脚本 `backend/src/scripts/probe-ws.ts`（M0）的结论那一行写的是
「期间事件: 0 条（**账户没动静就是 0 条，正常**）」—— 它**不造事件**，所以永远验不出这件事，
这也是「WS 零帧」拖到现在才被钉死的原因。

### 顺带确认的两条死路（省得以后再试）

| 路 | 实测结果 |
|---|---|
| 现货 listenKey（`POST /api/v3/userDataStream`） | **410 Gone**（币安已下架，换成 WS API 了） |
| 合约 WS API（`wss://ws-fapi.binance.com/ws-fapi/v1`） | HMAC key 不能用：`session.logon` → `-4056 HMAC_SHA256 API key is not supported`；`userDataStream.subscribe.signature` → `-5000 Method … is invalid`。要走这条得单独建一把 **Ed25519** key |

### 可选方案（等复验结果再定）

| 方案 | 做法 | 代价 |
|---|---|---|
| **A 单一所有者 + 本地靠兜底**（现状已够用） | 只有线上连用户数据流；本地不抢，实时性靠：写操作强制对平（**3 秒**，实测）+ 打开页面/下拉刷新对平 + 5 分钟成交对账 | 本地看到「币安 App 上的操作」最慢 5 分钟 |
| **B 谁持有谁转发** | 持有方收到事件后，经内部通道（Redis / SSE / HTTP）把**事件内容**推给另一方；另一方**不再 POST listenKey、不再连 WS** | 要加一条内部通道 |
| **C 子账户** | 本地用**子账户**（子账户有自己的 listenKey，与主账户互不影响） | 要开子账户、单独配 key |

⚠️ **listenKey 是「账户级唯一」**（官方原文：*"If the account has an active `listenKey`, that
`listenKey` will be returned and its validity will be extended for 60 minutes"*）——
所以「再加一把 API Key 给本地用」**拿到的还是同一把 key**（本轮实测：新 key 读到同一个钱包 9.9877、
POST 回同一把 `1maoUqh8…`）⇒ **独立流只能靠独立账户（子账户）**。
