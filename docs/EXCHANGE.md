# 交易所资产模块 · 方案（2026-10-05 定稿）

> 一句话：**一套 API Key = 一个账户**；库里存「快照 + 成交」，WebSocket 负责实时，
> 前端**先渲染库里那一份**再后台刷新 —— 秒开、秒跳，不空等 loading。

---

## 1. 范围

**只统计两个钱包**（用户 2026-10-05 定）：

| 维度 | 接口 | 拿到什么 |
|---|---|---|
| USDT 合约（USDⓈ-M） | `GET /fapi/v2/account` | `totalWalletBalance` / `totalUnrealizedProfit` / `totalMarginBalance` / `availableBalance` + `assets[]` + **`positions[]`** |
| C2C 钱包 | `GET /sapi/v1/asset/wallet/balance?needBalanceDetail=true` | `walletName` / `balance` / `assetBalances[]` —— ⚠️ 两个坑（2026-10-05 真丢过钱）：**① 钱包名各账号不一样**（官方文档写 `"C2C"`，实测本账号是 `"Funding"`）⇒ 两个都得认；**② `assetBalances[]` 里没有 `balance` 字段**，金额在 `free`/`locked`/`freeze`/`withdrawing` 里（钱包层级那个 `balance` 是 **BTC 估值**） |
| 挂单 | `GET /fapi/v1/openOrders`（**不需要交易对**） | |
| 成交 | WS `ORDER_TRADE_UPDATE`，REST `userTrades` 兜底 | |
| 已实现盈亏 | WS 同事件里的 `rp`，REST `fapi/v1/income` 兜底 | |

**明确不做**
- ❌ **现货（Spot 钱包）完全不参与统计** —— 老版那套「按币种估值的现货余额列表」整块删掉
- ❌ 币本位 COIN-M（`dapi*`）
- ⚠️ **下单**：2026-10-05 加了 K 线页底部的下单模块，但**只走币安的测试接口**
  （`POST /fapi/v1/order/test`）—— 只校验参数 / 权限 / 保证金，**不进撮合、不真开仓**。
  真下单 / 撤单还没做（要放开就是把接口名从 `order/test` 换成 `order`，见第 5 节末尾）
- ❌ 跨账户、跨用户汇总（净资产 = **那一套 key** 的合约 + C2C）

**净资产口径**：`合约 totalMarginBalance（= 钱包 + 浮盈）+ C2C 折 USDT`

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

K 线页底部那个下单模块用的三条（`data/exchange-trade.ts`）：

| 方法 | 路径 | 打哪个交易所接口 | 说明 |
|---|---|---|---|
| GET | `/api/exchange/trade?id=&symbol=BTCUSDT` | `fapi/v2/balance` + **v2** `positionRisk` + `leverageBracket` | 面板初始化：可用余额 / 当前杠杆 / 最大杠杆 / 数量价格精度（三项并发，单项失败只记进 `errors`，余额失败单列 `balanceError`） |
| POST | `/api/exchange/trade/leverage?id=` | `POST /fapi/v1/leverage` | 调这个交易对的杠杆（有持仓 / 挂单时交易所会拒，原样翻出来） |
| POST | `/api/exchange/trade/order?id=` | **`POST /fapi/v1/order/test`** | 下单（**测试单**：只校验，不进撮合、不真开仓） |

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

**要放开真下单**：`placeTestOrder()` 里 `fapiPrivatePostOrderTest` → `fapiPrivatePostOrder`，
其余逻辑一模一样；但前端「测试单」那几处提示 + 本文档这一段必须一起改。

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

**不用二选一**：Node 自己的出站走代理就行，SSH 不需要代理。

```bash
# 币安全部走本地代理（7890 是 Clash 那种混合口），TUN 就可以一直关着
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npm run web
```

Node 24 的 `fetch` 认 `NODE_USE_ENV_PROXY`（`undici` 的 ProxyAgent 那条路），
实测用它在本机**成功刷了币种表**（528 → 525，剔掉 3 个交割中的币）。
`npm run sync:contracts` 这种一次性命令同样能这么套。

> 另一个坑：新服务器（`52.194.6.144`）的**主机密钥不在 `known_hosts`** 里时，
> `release.sh` 会直接挂在半路（`Host key verification failed` —— `BatchMode` 下不会问你要不要信任）。
> 先 `ssh-keyscan -T 8 -t ed25519,rsa 52.194.6.144 >> ~/.ssh/known_hosts` 再发。

---

## 6. 前端

**界面已定稿**（`comps/ExchangeAccountBoard.vue`）：净资产 → 合约明细四格 → 仓位统计
→ 二级 tab（持仓 / 挂单 / 盈亏 / 成交 / 资产）。

数据接法：

1. 进页面 → `GET /api/exchange/overview` → **立刻渲染**（顶部「3 分钟前」+ ⟳）
2. `age > 60s` 或用户点 ⟳ → `POST /refresh` → 回填
3. 订阅 `/api/exchange/stream`（SSE）→ 有更新就回填，数字**淡闪一下**
4. 挂单 / 成交 / 盈亏三个 tab **懒加载**（进 tab 才拉）
5. 局部失败只提示那一块，不阻塞整页

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
| M6 ✅ | K 线页底部**下单模块**（多空 / 滑动条 / 余额 / 杠杆 / 市价·限价）+ `/api/exchange/trade*` 三条接口 —— **只走测试单** | 2026-10-05 完成（`comps/OrderPanel.vue`） |

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
| 权重（保守估） | ≈ **3.3 权重/分钟/套**（fapi 预算 2400/分钟/IP） |
| 磁盘 | **≈ 6.5 MB / 套**（分级保留的稳态）+ **0.5 MB / 年**（`1d` 点永久） |

**各自的天花板**：

| 资源 | 撑到多少套才吃紧 |
|---|---|
| WS 连接（Node 侧） | 几百条无压力（1 条约 50KB 内存）⚠️ 但**启动时连握手要错开**（币安限 300 次/5 分钟/IP）⇒ 限速 **1 条/秒** |
| REST 额度 | 2400 / 3.3 ≈ **700 套**（保守算 500） |
| **磁盘** ← 真正的瓶颈 | 100 套 ≈ 0.7 GB、300 套 ≈ 2 GB、1000 套 ≈ 6.5 GB（另加 0.5 GB/年）—— 比“一刀切 30 天”宽一倍 |

⇒ **单实例（现在这套部署）舒适区 ≈ 100~300 套 key**，
≈ **50~150 个用户**（假设每人 2 套）。到 300 套时磁盘 4 GB、REST 只用掉 1/3 额度，都还宽松。

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
| 只绑了现货 key 的账户 | 这一页直接提示「现货不参与统计」，不硬算 |

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
