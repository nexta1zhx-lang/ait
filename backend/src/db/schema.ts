/**
 * 全部表结构（幂等 DDL）。
 *
 *   users            用户（用户名 + scrypt 密码）
 *   sessions         登录会话（token）
 *   user_llm         每个用户自己的 DeepSeek 配置（空 = 用服务器 .env 那份）
 *   ai_docs          ⚠️ **已废弃（2026-10-04）**：原来放 AI 的提示词文档，
 *                    现在提示词写死在代码里（`llm/prompts.ts`），程序不再读写它。
 *                    表和数据都留着（没删），万一要退回数据库那套还能捞回来。
 *   ai_doc_versions  同上，一起废弃。
 *   rules_versions   每次分析**实际用的**那份提示词快照（按内容 hash 去重）
 *   analyses         每次分析的完整存档（输入 / 结论 / 计划 / 护栏 / 事后结果）
 *   knowledge        知识库 —— 我标过的案例 + AI 提炼的经验
 *   llm_usage        每次大模型调用的 token 与花费
 *   contract_store   币种表（合约清单整份一行，每天自动从币安刷）
 *
 * 分层原则：
 *   · 要**筛选 / 排序 / 统计**的 → 独立列（档位、结论、币种、价格、R 倍数…）
 *   · 只用来**回放详情**的 → JSONB（AI 完整输出 / 行情快照 / 护栏明细）
 *   · 会**重复的长文本** → 单独一张表按 hash 去重（规则全文 6.6K，不能每行一份）
 *
 * 提示词**全部存数据库**：`rules/` 目录、代码里的内置角色都已去掉。
 * 每次分析读「启用的文档」拼成 system prompt，并按 hash 存进 rules_versions。
 */

/**
 * `candles` 的列定义 —— ⚠️ **只写这一份**：父表（`SCHEMA_SQL`）与分区迁移脚本
 * （`scripts/migrate-candles-partitions.ts`）都从这里取，别各写一份（写岔了就是列不一致）。
 */
export const CANDLES_COLUMNS = `
  exchange         TEXT             NOT NULL,
  market_type      TEXT             NOT NULL DEFAULT 'swap',
  symbol           TEXT             NOT NULL,   -- ccxt 统一符号（BTC/USDT:USDT）
  pair             TEXT             NOT NULL,   -- 币安交易对（BTCUSDT），上游流名用它
  interval         TEXT             NOT NULL,
  open_time        TIMESTAMPTZ      NOT NULL,
  open             DOUBLE PRECISION NOT NULL,
  high             DOUBLE PRECISION NOT NULL,
  low              DOUBLE PRECISION NOT NULL,
  close            DOUBLE PRECISION NOT NULL,
  volume           DOUBLE PRECISION NOT NULL DEFAULT 0,  -- 基础币成交量
  quote_volume     DOUBLE PRECISION NOT NULL DEFAULT 0,  -- 计价币成交额
  trades           INTEGER          NOT NULL DEFAULT 0,
  taker_buy_volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- ws（实时流）/ rollup（由 1m 滚出）/ backfill（补缺口）/ seed（首灌历史）
  source           TEXT             NOT NULL DEFAULT 'ws',
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (exchange, market_type, symbol, interval, open_time)
`

/**
 * `candles` 的两个非主键索引。⚠️ 建在**父表**上 ⇒ 每片子分区自动有同名索引，
 * `ensureCandlePartitions()` 之后新建的子分区也会自动带。
 *
 * 想走索引的查询**必须**带上 `exchange` + `market_type`（两列都在索引最前）——
 * 只给 `interval`（连 `interval + symbol` 也一样）会用不上任何索引 ⇒ 顺序扫整表。
 * 2026-10-07 就是这么炸的（详见 `docs/EXCHANGE.md` 第 52 节）。
 * 迁移脚本 `scripts/migrate-candles-partitions.ts` 也用这一份，别各写一遍。
 */
export const CANDLES_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS candles_ivl_symbol_time_idx
  ON candles (exchange, market_type, interval, symbol, open_time);
CREATE INDEX IF NOT EXISTS candles_ivl_time_idx
  ON candles (exchange, market_type, interval, open_time);`

/**
 * `candles` 的**静态**分区骨架：每档一个 LIST 子分区 + 一个 DEFAULT 兜底分区。
 * 时间子分区是滚动的，由 `ensureCandlePartitions()` 建。
 *
 * ⚠️ 必须判 `relkind = 'p'`：老库（未分区）上直接 `PARTITION OF` 会报
 *    「candles is not partitioned」，而 `SCHEMA_SQL` 每次启动都跑 —— 迁移前不能炸。
 */
export const CANDLES_PARTITION_SKELETON_SQL = `
DO $$
DECLARE ivl TEXT;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE relname = 'candles' AND relnamespace = current_schema()::regnamespace) = 'p' THEN
    FOREACH ivl IN ARRAY ARRAY['1m','5m','15m','1h','4h','1d'] LOOP
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF candles FOR VALUES IN (%L) PARTITION BY RANGE (open_time)',
        'candles_' || ivl, ivl
      );
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I DEFAULT',
        'candles_' || ivl || '_def', 'candles_' || ivl
      );
    END LOOP;
  END IF;
END $$;`

export const SCHEMA_SQL = `
-- ---------------------------------------------------------------- 用户
-- 用户名 + 密码（scrypt）。密码不存明文。
-- 2026-10-04：**不开放注册**，账号一律由管理员在「我的 → 管理」里创建。
-- 代码里**不再内置默认密码**（原先播种的 admin / 123456 已删除）；
-- 管理员账号随**本地数据库同步**上来，启动时只检查、不建号（见 db/users.ts 的 ensureAdmin）。
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL   PRIMARY KEY,
  username      TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  is_admin      BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 用户名不区分大小写地唯一
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));
-- 老库补列（幂等）
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- 两步验证（TOTP，2026-10-04，只给管理员，见 util/totp.ts）。
--   totp_secret   已启用的密钥（base32）
--   totp_pending  扫了码但还没输码确认的密钥（确认后才搬到 totp_secret）
--   totp_recovery 恢复码的 sha256 列表（**不存明文**）
--   totp_last_step 最近一次用掉的时间步，防止同一个 6 位码被重放
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret   TEXT   NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending  TEXT   NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery JSONB  NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;

-- 合约行情的置顶币种（2026-10-04，每个用户最多 5 个，见 db/pins.ts）。
-- 只存 base（BTC，不带 /USDT）；sort 是置顶区里的先后顺序。
-- ⚠️ 注释里千万别写反引号 —— SCHEMA_SQL 是 JS 模板字符串，会被当场截断。
CREATE TABLE IF NOT EXISTS user_pins (
  user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  base       TEXT        NOT NULL,
  sort       INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, base)
);
CREATE INDEX IF NOT EXISTS user_pins_user_idx ON user_pins (user_id, sort);

-- 账户统计的每用户配置（2026-10-09，见 db/stats-settings.ts）。
-- 用户 2026-10-09：「在配置里面选择的配置，要保存到个人的后端和个人信息中」——
-- 这两项以前只写浏览器 localStorage，换设备 / 换 App 就丢，现在按用户存库。
CREATE TABLE IF NOT EXISTS user_stats_settings (
  user_id    BIGINT        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- 收益率基准金额（USDT），必须 > 0
  benchmark  NUMERIC(24,8) NOT NULL DEFAULT 1000,
  -- 金额显示单位：usd（美元）/ cny（人民币）
  currency   TEXT          NOT NULL DEFAULT 'usd',
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- 登录会话：前端存 token，请求带 Authorization: Bearer <token>
-- （SSE 带不了请求头，所以也接受 ?token=，见 server.ts 的 currentUser）。
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT        PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_exp_idx  ON sessions (expires_at);

-- 「多端登录」要看有哪些设备在线、单独踢掉某一台（2026-10-04）。
-- id 只是个**不敏感**的标识（给前端指哪一台用，不能拿来认证）；
-- token 仍然是主键，认证只认它。
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_idx ON sessions (id);

-- 每个用户自己的大模型配置（DeepSeek）。
-- 空串 = 没设置 → 回落到服务器 .env 里那份。
CREATE TABLE IF NOT EXISTS user_llm (
  user_id          BIGINT      PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  api_key          TEXT        NOT NULL DEFAULT '',
  base_url         TEXT        NOT NULL DEFAULT '',
  model            TEXT        NOT NULL DEFAULT '',
  reasoning_effort TEXT        NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- AI 文档
CREATE TABLE IF NOT EXISTS ai_docs (
  id         BIGSERIAL   PRIMARY KEY,
  -- role / rule = 旧版（角色设定 + 规则正文，已不再参与拼装）
  -- predict = 分析预测（开单分析读这一份）；extract = 知识库提炼
  kind       TEXT        NOT NULL DEFAULT 'rule'
                         CHECK (kind IN ('role', 'rule', 'extract', 'predict')),
  name       TEXT        NOT NULL,
  content    TEXT        NOT NULL DEFAULT '',
  -- 关掉就不参与拼 prompt（方便我存多个版本轮流试）
  enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  -- 同一类里按这个排序拼接
  sort       INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_docs_pick_idx ON ai_docs (kind, enabled, sort, id);

-- ---------------------------------------------------------------- 文档历史
-- 每次保存留一版，可以看旧文、可以回滚
CREATE TABLE IF NOT EXISTS ai_doc_versions (
  id       BIGSERIAL   PRIMARY KEY,
  doc_id   BIGINT      NOT NULL REFERENCES ai_docs (id) ON DELETE CASCADE,
  kind     TEXT        NOT NULL,
  name     TEXT        NOT NULL,
  content  TEXT        NOT NULL,
  chars    INTEGER     NOT NULL DEFAULT 0,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_doc_versions_idx
  ON ai_doc_versions (doc_id, saved_at DESC);

-- ---------------------------------------------------------------- 规则版本
-- 规则全文的版本快照。按内容 hash 去重，所以同一个版本只存一份。
CREATE TABLE IF NOT EXISTS rules_versions (
  -- rules.ts 算出来的内容 hash（前 12 位）
  hash       TEXT        PRIMARY KEY,
  -- 主提示词.md 的内容
  system     TEXT        NOT NULL,
  -- 其余规则文件拼起来的内容
  body       TEXT        NOT NULL,
  -- 参与了哪些文件
  sources    TEXT[]      NOT NULL DEFAULT '{}',
  chars      INTEGER     NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- API 用量
-- 每次调用大模型记一笔，用于统计 token 与花费。
-- 价目快照存在 price 里，这样以后官方调价也不会篡改历史记录。
CREATE TABLE IF NOT EXISTS llm_usage (
  id                BIGSERIAL    PRIMARY KEY,
  -- judge = 开单分析；extract = 案例提炼
  kind              TEXT         NOT NULL,
  model             TEXT         NOT NULL,
  symbol            TEXT,
  timeframe         TEXT,
  prompt_tokens     INTEGER      NOT NULL DEFAULT 0,
  completion_tokens INTEGER      NOT NULL DEFAULT 0,
  total_tokens      INTEGER      NOT NULL DEFAULT 0,
  cache_hit_tokens  INTEGER      NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER      NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(16,6) NOT NULL DEFAULT 0,
  -- 是否高峰时段（低谷半价）
  peak              BOOLEAN      NOT NULL DEFAULT false,
  -- 本次使用的单价（美元 / 1M token）快照
  price             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- 模型不在价目表里，用了兜底价
  assumed           BOOLEAN      NOT NULL DEFAULT false,
  -- 重试次数（>1 说明第一次返回的 JSON 不合法）
  attempts          INTEGER      NOT NULL DEFAULT 1,
  latency_ms        INTEGER,
  ok                BOOLEAN      NOT NULL DEFAULT true,
  error             TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_usage_created_idx ON llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_kind_idx    ON llm_usage (kind, model);

-- ---------------------------------------------------------------- 分析存档
CREATE TABLE IF NOT EXISTS analyses (
  id            BIGSERIAL   PRIMARY KEY,

  -- ────────── 输入：这次是在什么条件下问的 ──────────
  symbol        TEXT        NOT NULL,               -- BTC
  ccxt_symbol   TEXT,                               -- BTC/USDT:USDT
  exchange      TEXT        NOT NULL DEFAULT 'binance',
  market_type   TEXT        NOT NULL DEFAULT 'swap',
  timeframes    TEXT[]      NOT NULL DEFAULT '{}',  -- {15m,1h,4h,1d}
  -- @deprecated 期望值已删（没有止损止盈就没有 R），老记录才有值
  assumed_win_rate NUMERIC(5,4),

  -- ────────── 结论：要能筛选 / 统计，所以提成列 ──────────
  -- A 顺势单 / A-W 顺势双底 / S 突破 / V 超跌极速V反 / B 不该做 / unclear 说不清
  grade         TEXT,
  -- 现在存的就是 AI 那段 reason
  grade_reason  TEXT,
  -- go 可做 / wait 观望 / no_go 不可做
  verdict       TEXT,
  -- @deprecated 新记录把 reason 存在 grade_reason，这里是 null
  verdict_reason TEXT,
  -- @deprecated 模型自报的数字没有依据也不参与计算
  confidence    INTEGER,
  -- @deprecated 方向已删（不再给仓位/止损，方向由理由里说）
  direction     TEXT,

  -- ────────── 计划：@deprecated 整组已废弃 ──────────
  -- 账户资金 / 仓位 / 杠杆 / 止损止盈 / 盈亏比 / 期望值 已于 2026-10-02 全部删除。
  -- 下列列一律保留（供读老记录），新记录全部写 null。
  -- 分析那一刻的现价
  price         NUMERIC,
  entry_price   NUMERIC,
  entry_type    TEXT,        -- market | limit
  stop_loss     NUMERIC,
  -- 止损距离 %（相对入场价）
  stop_pct      NUMERIC,
  tp1_price     NUMERIC,
  tp2_price     NUMERIC,
  tp3_price     NUMERIC,
  -- 末段盈亏比
  rr_final      NUMERIC,
  -- 期望值（R）
  expectancy_r  NUMERIC,
  -- 代码算出来的仓位方案
  position_qty      NUMERIC,
  position_notional NUMERIC,
  risk_amount       NUMERIC,
  leverage_used     NUMERIC,

  -- ────────── 护栏：@deprecated 已整体删除 ──────────
  guard_passed  BOOLEAN,
  -- 触发的一票否决
  veto          TEXT[]      NOT NULL DEFAULT '{}',
  -- 触发的硬红线
  red_lines     TEXT[]      NOT NULL DEFAULT '{}',

  -- ────────── 来源与成本 ──────────
  model         TEXT,
  rules_hash    TEXT        REFERENCES rules_versions (hash) ON DELETE SET NULL,
  -- @deprecated 知识库经验不再注入提示词，新记录恒为 []
  knowledge_refs JSONB      NOT NULL DEFAULT '[]'::jsonb,
  -- 对应 llm_usage 里那一笔，方便对账
  llm_usage_id  BIGINT      REFERENCES llm_usage (id) ON DELETE SET NULL,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cost_usd      NUMERIC(16,6),
  latency_ms    INTEGER,
  attempts      INTEGER,
  -- 判断时图表看的是哪个周期（K 线不存：交易所历史数据永久可重拉）
  chart_timeframe TEXT,

  -- ────────── 全量存档：只管回放，不参与查询 ──────────
  -- AI 的原始输出（现在就是四个字段：档位 / 标签 / 理由 / 结论）
  result        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- @deprecated 护栏已删，新记录写 null
  guardrails    JSONB,
  -- @deprecated 期望值已删
  expectancy    JSONB,
  -- 行情快照：多周期统计 + 市场热度 + 价格结构
  snapshot      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  meta          JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- ────────── 事后结果：@deprecated 结算已删 ──────────
  -- 没有止损止盈就没有 R 可算，也就没有胜率统计。列全部保留（读老记录），新记录恒为 null。
  outcome       TEXT,
  outcome_at    TIMESTAMPTZ,
  outcome_price NUMERIC,
  -- 实际拿到多少 R（负数是亏）
  r_multiple    NUMERIC,
  -- 相对入场价的最大有利 / 不利偏移 %
  mfe_pct       NUMERIC,
  mae_pct       NUMERIC,
  outcome_note  TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analyses_created_idx ON analyses (created_at DESC);
CREATE INDEX IF NOT EXISTS analyses_symbol_idx  ON analyses (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS analyses_grade_idx   ON analyses (grade, verdict);
CREATE INDEX IF NOT EXISTS analyses_model_idx   ON analyses (model);
CREATE INDEX IF NOT EXISTS analyses_rules_idx   ON analyses (rules_hash);

-- 分析记录也带标签了（跟知识库共用同一份标签池）
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS analyses_tags_idx ON analyses USING GIN (tags);

-- ---------------------------------------------------------------- 知识库
CREATE TABLE IF NOT EXISTS knowledge (
  id           BIGSERIAL   PRIMARY KEY,
  symbol       TEXT        NOT NULL,
  ccxt_symbol  TEXT,
  exchange     TEXT        NOT NULL DEFAULT 'binance',
  timeframe    TEXT        NOT NULL,
  -- do = 这是我该做的；dont = 这是我不该做的
  label        TEXT        NOT NULL CHECK (label IN ('do', 'dont')),
  -- A 顺势单 / A-W 顺势双底 / S 突破 / V 超跌极速V反 / B 不该做
  grade        TEXT,
  title        TEXT        NOT NULL DEFAULT '',
  note         TEXT        NOT NULL DEFAULT '',
  -- ★ AI 提炼的可复用经验
  lesson       TEXT        NOT NULL DEFAULT '',
  features     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  rally_from   INTEGER,
  rally_to     INTEGER,
  -- 压缩后的 K 线：[[t,o,h,l,c,v], ...]
  candles      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rally_meta   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  snapshot     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_created_idx ON knowledge (created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_symbol_idx  ON knowledge (symbol);
CREATE INDEX IF NOT EXISTS knowledge_label_idx   ON knowledge (label, grade);

-- ---------------------------------------------------------- 标签模板
-- 案例标签只能从这份清单里挑；清单由我自己在网页上维护。
-- ⚠️ 2026-10-04 起**按用户隔离**：唯一索引是 (user_id, name)，见文件末尾。
CREATE TABLE IF NOT EXISTS tag_templates (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    BIGINT      REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  sort       INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────────────────────────── 新列（幂等）
-- 这段行情是什么：up 拉升 / down 下跌 / range 横盘。
-- 以前是 grade(A/B/C)，那是套我自己的体系；现在 AI 不判档了，只客观说走势。
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS move_type TEXT;
-- 为什么走成这样（AI 的分析过程）
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS why       TEXT NOT NULL DEFAULT '';
-- 标签：只能从固定的 10 个模板里挑，AI 不许自己造词
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS tags      JSONB NOT NULL DEFAULT '[]'::jsonb;
-- 「该做 / 不该做」这一维已经去掉：新记录 label 为空，老记录保留原值
ALTER TABLE knowledge ALTER COLUMN label DROP NOT NULL;
-- 标签筛选走 GIN
CREATE INDEX IF NOT EXISTS knowledge_tags_idx      ON knowledge USING GIN (tags);
CREATE INDEX IF NOT EXISTS knowledge_move_type_idx ON knowledge (move_type);

-- ---------------------------------------------------------- 币种表（合约列表）
-- 整份币种清单存一行（id=1）：只有「整体读 / 整体换」的需求，不按行查，
-- 存一份 JSONB 最省事，也不会出现半新半旧。
-- 服务启动时若超过 24 小时就自动从币安拉一次，之后每天一次（新上币会自动出现）；
-- npm run sync:contracts 仍可手动刷。
CREATE TABLE IF NOT EXISTS contract_store (
  id          INTEGER     PRIMARY KEY CHECK (id = 1),
  exchange    TEXT        NOT NULL DEFAULT 'binance',
  market_type TEXT        NOT NULL DEFAULT 'swap',
  source      TEXT        NOT NULL DEFAULT '',
  count       INTEGER     NOT NULL DEFAULT 0,
  contracts   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────────────── 按用户隔离（2026-10-04，幂等）
-- 四个「用户自己的数据」表都加 user_id：
--   analyses（预测历史）/ knowledge（知识库）/ tag_templates（标签模板）/ llm_usage（用量）
-- 老的、还没归属的行 user_id 是 NULL；**第一个注册的账号**会把它们认领走
-- （见 db/users.ts 的 claimLegacyData）。
ALTER TABLE analyses      ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE knowledge     ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE tag_templates ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE llm_usage     ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS analyses_user_idx  ON analyses (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_user_idx ON knowledge (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_user_idx ON llm_usage (user_id, created_at DESC);

-- 标签模板的唯一性从「全局」改成「每个用户一套」：
-- 老库那个 name 全局唯一索引必须先拆掉，否则两个用户不能有同名标签。
DROP INDEX IF EXISTS tag_templates_name_idx;
CREATE UNIQUE INDEX IF NOT EXISTS tag_templates_user_name_idx
  ON tag_templates (user_id, name);
CREATE INDEX IF NOT EXISTS tag_templates_user_idx ON tag_templates (user_id, sort, id);

-- ──────────────────────────────── 大模型密钥（多把，2026-10-04）
-- 一个用户可以有**多把** Key（各自带名字 / 模型 / 接口地址），其中一把是
-- 「默认」，分析就用默认那把。原来的单条 user_llm 已废弃（数据由
-- db/llm-keys.ts 的 migrateLegacyLlm() 搬过来，搬完老表清空）。
CREATE TABLE IF NOT EXISTS user_llm_keys (
  id               BIGSERIAL   PRIMARY KEY,
  user_id          BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 自己起的名字（如「主力」「备用」「便宜那档」）
  name             TEXT        NOT NULL DEFAULT '',
  api_key          TEXT        NOT NULL DEFAULT '',
  base_url         TEXT        NOT NULL DEFAULT '',
  model            TEXT        NOT NULL DEFAULT '',
  reasoning_effort TEXT        NOT NULL DEFAULT '',
  is_default       BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_llm_keys_user_idx ON user_llm_keys (user_id, id);
-- 一个用户最多只能有一把默认（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS user_llm_keys_default_idx
  ON user_llm_keys (user_id) WHERE is_default;

-- 用量记到「哪把密钥」上 —— 统计要按 key 分开看
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS llm_key_id BIGINT
  REFERENCES user_llm_keys (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS llm_usage_key_idx
  ON llm_usage (llm_key_id, created_at DESC);

-- ──────────────────────────────── 交易所账户（多套，2026-10-04）
-- 一个用户可以在「我的 → 个人信息 → 交易所」里绑定**多套**交易所 API Key
-- （各自带名字 / 市场类型），开单分析里那格「交易所账户」用它查余额和订单历史。
-- 密钥字段是**只读用**的凭据；真 Key 不出网（列表只回掩码，见 db/exchange-keys.ts）。
CREATE TABLE IF NOT EXISTS user_exchange_keys (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- ccxt 交易所 id（binance / okx / bybit …）
  exchange     TEXT        NOT NULL DEFAULT 'binance',
  -- 自己起的名字（如「主力」「跟单号」）
  name         TEXT        NOT NULL DEFAULT '',
  api_key      TEXT        NOT NULL DEFAULT '',
  secret       TEXT        NOT NULL DEFAULT '',
  -- 有些交易所（okx / kucoin）要 passphrase，没有就留空
  password     TEXT        NOT NULL DEFAULT '',
  -- spot = 现货，swap = 合约
  market_type  TEXT        NOT NULL DEFAULT 'swap',
  -- 沙盒 / 测试网
  sandbox      BOOLEAN     NOT NULL DEFAULT false,
  is_default   BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_exchange_keys_user_idx
  ON user_exchange_keys (user_id, id);
-- 一个用户最多只能有一套默认
CREATE UNIQUE INDEX IF NOT EXISTS user_exchange_keys_default_idx
  ON user_exchange_keys (user_id) WHERE is_default;

-- ──────────────────────────────── 交易所资产（2026-10-05）
-- 只统计「USDT 合约 + C2C」两个钱包（现货不参与），方案见 docs/EXCHANGE.md。
--
-- 快照 = 某一瞬间的「资产体检报告」：前端秒开就是读最新那一条；
-- 攒下来的序列就是资产曲线，**分级保留**（5m 留 7 天 / 1h 留 90 天 / 1d 永久）。
-- ⚠️ 本文件是 JS 模板字符串，注释里**千万别写反引号**（会被当场截断）。
CREATE TABLE IF NOT EXISTS exchange_snapshots (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id      BIGINT      NOT NULL REFERENCES user_exchange_keys (id) ON DELETE CASCADE,
  -- 粒度：5m = 原始采样；1h / 1d = 归档聚合出来的
  kind        TEXT        NOT NULL DEFAULT '5m',
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 净资产（margin + c2c_total）在该时间桶里的振幅。5m 原始行 high = low = 自身净值，
  -- 这样查曲线时三种粒度能用同一套 SQL（聚合**不取平均**，见 docs/EXCHANGE.md）
  high        NUMERIC(24,8),
  high_at     TIMESTAMPTZ,
  low         NUMERIC(24,8),
  low_at      TIMESTAMPTZ,
  -- 合约（fapi/v2/account）
  wallet      NUMERIC(24,8) NOT NULL DEFAULT 0,   -- totalWalletBalance
  unrealized  NUMERIC(24,8) NOT NULL DEFAULT 0,   -- totalUnrealizedProfit
  margin      NUMERIC(24,8) NOT NULL DEFAULT 0,   -- totalMarginBalance（净资产里合约那半）
  available   NUMERIC(24,8) NOT NULL DEFAULT 0,   -- availableBalance
  positions   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  assets      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- C2C 钱包（sapi/v1/asset/wallet/balance）—— ⚠️ 接口里它的 walletName 实际叫 Funding
  c2c_total   NUMERIC(24,8),
  c2c_detail  JSONB,
  -- 现货钱包里的 **USDT**（用户 2026-10-05：「现货统计也加上，只要 usdt 的统计简单化」）
  -- ⚠️ 只存 USDT 一个数：别的币不折价、也不进净值。全资产估值是另一套东西，
  --    当年就是因为那套估值不好维护才整块删掉的（见 docs/EXCHANGE.md）。
  -- NULL = 采集那个时刻还没统计现货（老行），算净值时 coalesce 成 0。
  spot_usdt   NUMERIC(24,8),
  -- 这一条是谁写的 / 有没有失败
  -- poll | ws | manual（日常）+ bind | boot | shutdown（锚点）+ snapshotApi（补的日点）+ agg（聚合）
  source      TEXT        NOT NULL DEFAULT 'poll',
  err         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exchange_snapshots_key_idx
  ON exchange_snapshots (user_id, key_id, kind, taken_at DESC);
-- 归档去重：同一档位、同一个时间桶只允许一条（归档任务重跑不会写重复）
CREATE UNIQUE INDEX IF NOT EXISTS exchange_snapshots_bucket_idx
  ON exchange_snapshots (key_id, kind, taken_at);

-- 成交账本：**永久保留**。
-- ⚠️ 币安只帮存 3 个月（userTrades / income 都是），不落库就等于永久丢，
-- 以后想统计月度盈亏 / 胜率 / 手续费都拿不回来。挂单不存（那是可变状态）。
CREATE TABLE IF NOT EXISTS exchange_fills (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id     BIGINT      NOT NULL REFERENCES user_exchange_keys (id) ON DELETE CASCADE,
  order_id   TEXT        NOT NULL,
  trade_id   TEXT        NOT NULL,              -- 币安事件里的 t，去重靠它
  symbol     TEXT        NOT NULL,
  side       TEXT        NOT NULL,              -- buy / sell
  price      NUMERIC(24,8) NOT NULL DEFAULT 0,
  amount     NUMERIC(24,8) NOT NULL DEFAULT 0,
  cost       NUMERIC(24,8) NOT NULL DEFAULT 0,
  fee        NUMERIC(24,8) NOT NULL DEFAULT 0,
  fee_ccy    TEXT,
  realized   NUMERIC(24,8) NOT NULL DEFAULT 0,  -- 这一笔的已实现盈亏
  ts         TIMESTAMPTZ NOT NULL,
  raw        JSONB,                             -- 原始报文，对不上账时能翻
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_id, trade_id)
);
CREATE INDEX IF NOT EXISTS exchange_fills_user_idx ON exchange_fills (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS exchange_fills_sym_idx  ON exchange_fills (key_id, symbol, ts DESC);

-- 当前挂单（2026-10-06，用户原话：「挂单不是秒级查询啊，有变动才改，其余存库不就行了」）。
--
-- ★ 为什么从「按需打交易所」改成「存库」：
--   · 挂单的**变动**币安会经用户数据流主动推（ORDER_TRADE_UPDATE 的 NEW / CANCELED /
--     EXPIRED / FILLED），根本不用轮询；
--   · 原来每次点开账户页都要现打一次「不带交易对」的挂单查询 —— 币安那边 **40 权重**
--     且要等一个来回（经隧道 0.7~1.2 秒），所以「点开等 2 秒」；
--   · 别的页面 / 别的 tab 想看还得各自再打一次。
--   存下来之后：前端拿到的是**本地读**（毫秒级），实时变更走 SSE 推。
--   REST 只在对不上时兜底（连上 / 重连 / 定期），跟成交账本一个思路。
CREATE TABLE IF NOT EXISTS exchange_open_orders (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id      BIGINT      NOT NULL REFERENCES user_exchange_keys (id) ON DELETE CASCADE,
  order_id    TEXT        NOT NULL,               -- 币安的 orderId，去重靠它
  symbol      TEXT        NOT NULL,               -- 币安原始符号（1000BONKUSDT）
  side        TEXT        NOT NULL,               -- buy / sell
  type        TEXT        NOT NULL,               -- LIMIT / STOP_MARKET / TAKE_PROFIT_MARKET …
  pos_side    TEXT        NOT NULL DEFAULT 'BOTH',
  price       NUMERIC(24,8),                      -- 委托价（市价 / 条件单没有 ⇒ NULL）
  stop_price  NUMERIC(24,8),                      -- 触发价（止盈止损才有）
  amount      NUMERIC(24,8) NOT NULL DEFAULT 0,
  filled      NUMERIC(24,8) NOT NULL DEFAULT 0,
  reduce_only BOOLEAN     NOT NULL DEFAULT false,
  ts          TIMESTAMPTZ NOT NULL,               -- 下单时间（币安给的）
  seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(), -- 我们最后一次确认它还挂着的时间
  raw         JSONB,
  UNIQUE (key_id, order_id)
);
CREATE INDEX IF NOT EXISTS exchange_open_orders_key_idx ON exchange_open_orders (key_id, ts DESC);
-- 定期对账时按 seen_at 判断哪些是「这轮没见到、已经不在了」的
CREATE INDEX IF NOT EXISTS exchange_open_orders_seen_idx ON exchange_open_orders (key_id, seen_at);

-- 钱账本：**交易所自己那本账**（GET /fapi/v1/income 的每一行）。
-- 2026-10-06 加，起因（用户原话）：「数据要统一用一套」「资金费又算吗」。
--
-- ★ 为什么必须有：exchange_fills 只有**成交**，而**真正影响总收益的还有两样**：
--   · COMMISSION 手续费（实测 7 天 -0.2649，比已实现盈亏还大）
--   · FUNDING_FEE 资金费（每 8 小时结一次，合约特有的成本）
--   之前「盈亏」tab 只把成交里的 realized 加起来 ⇒ **算出来是毛的**，
--   而那个 tooltip 还写着「手续费/资金费也算在里面」—— 对不上账就是这么来的。
--
-- ★ 两个写入方（幂等靠 tranId，所以两条路不会重复记账）：
--   · WS ORDER_TRADE_UPDATE（实时）：o.rp → REALIZED_PNL、o.n → COMMISSION
--   · REST GET /fapi/v1/income（对账 + 补断线）：全类型，含 FUNDING_FEE
--
-- ⚠️ tran_id 就是币安那行的 tranId（成交类是**成交号**，跟 exchange_fills.trade_id
--    同一个东西；资金费是它自己的一串）。**同一个 tranId 下会有多条**（一笔成交既有
--    REALIZED_PNL 又有 COMMISSION），所以唯一键必须带 income_type。
-- ⚠️ 不加 ts 进唯一键：定期重扫同一个时间窗时，只有 (key, type, tranId) 才能挡住重复。
CREATE TABLE IF NOT EXISTS exchange_income (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id      BIGINT      NOT NULL REFERENCES user_exchange_keys (id) ON DELETE CASCADE,
  tran_id     TEXT        NOT NULL,
  income_type TEXT        NOT NULL,   -- REALIZED_PNL / COMMISSION / FUNDING_FEE / TRANSFER / …
  symbol      TEXT,                   -- 有的类型没有币种（比如划转）
  asset       TEXT        NOT NULL,   -- USDT
  amount      NUMERIC(24,8) NOT NULL, -- 正数 = 进钱，负数 = 出钱
  ts          TIMESTAMPTZ NOT NULL,   -- 币安那个 time
  trade_id    TEXT,                   -- 关联到哪笔成交（有的话）
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_id, income_type, tran_id)
);
CREATE INDEX IF NOT EXISTS exchange_income_user_idx ON exchange_income (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS exchange_income_key_idx  ON exchange_income (key_id, ts DESC);

-- Binance C2C completed USDT orders imported by the user for principal-flow analysis.
CREATE TABLE IF NOT EXISTS exchange_c2c_orders (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key_id      BIGINT      NOT NULL REFERENCES user_exchange_keys (id) ON DELETE CASCADE,
  order_id    TEXT        NOT NULL,
  side        TEXT        NOT NULL CHECK (side IN ('Buy', 'Sell')),
  asset       TEXT        NOT NULL DEFAULT 'USDT',
  fiat        TEXT        NOT NULL,
  fiat_total  NUMERIC(24,8) NOT NULL,
  price       NUMERIC(24,8) NOT NULL,
  quantity    NUMERIC(24,8) NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_id, order_id)
);
CREATE INDEX IF NOT EXISTS exchange_c2c_orders_range_idx
  ON exchange_c2c_orders (user_id, key_id, ts DESC);

-- ------------------------------------------- ccxt 的 markets 快照（公开数据）
-- 币安 exchangeInfo 整份约 1.1MB，ccxt 每个实例都要一份、只在内存，
-- 于是每次进程重启都得重下（本地隧道 25 秒 > ccxt 默认 10 秒超时，一超时整个实例就坏）。
-- 这里整份落一行，启动时 setMarkets 灌回去 ⇒ 冷启动 0 网络；之后每天刷一次。
-- key = 交易所|市场类型|环境（跟 Key 无关，公开数据几套账户共用一份）。
CREATE TABLE IF NOT EXISTS ccxt_markets (
  key        TEXT        PRIMARY KEY,
  exchange   TEXT        NOT NULL,
  count      INTEGER     NOT NULL DEFAULT 0,
  markets    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ──────────────────────────────── K 线底座（2026-10-07）
-- 后端常驻订阅 1m 推送流（525 个 U 本位永续），收盘就地落库并滚出高周期。
-- 设计定稿见 docs/EXCHANGE.md：「实时 K 线底座」那一节（1m 直订 + rollup 物化）。
--
-- 保留策略**按周期分级**（见 db/candle-store.ts 的 pruneCandles）：
--   1m 7 天 / 5m 7 天 / 15m 30 天 / 1h 400 天 / 4h 永久 / 1d 永久。
--   2026-10-08 改成分区实现：先按 interval 分（LIST），再按 open_time 分（RANGE，
--   1m/5m/15m 按天、1h 按月、4h/1d 按年）⇒ 分级保留与「只扫自己那档」同时满足。
--   （原来的顾虑是「同一个时间格里混着所有周期，没法只丢 1m 那部分」——
--     两级分区正好解决：先按周期切开，再在周期内部按时间切。）
CREATE TABLE IF NOT EXISTS candles (${CANDLES_COLUMNS}
) PARTITION BY LIST (interval);
-- ⚠️ 这里用 PARTITION BY LIST (interval)，子分区再按 open_time 分 —— 见
-- ensureCandlePartitions()（schema.ts 底下）与 docs/EXCHANGE.md 第 53 节。理由：
--   · 所有查询都带 interval（也只有带它才走得了索引）⇒ 每档一个分区，查询只碰自己那档，
--     索引从「1100 万行的 876MB」变成「1d 档 34 万行的几 MB」，缓存命中率大幅上升；
--     （2026-10-08 实测：一个 1d 查询要 3 分 33 秒，就是被跨全表的随机读拖的。）
--   · 保留期变成 DROP PARTITION ⇒ 原来每天 90 万行的 DELETE（+ 三份索引写放大 + 死行
--     + autovacuum 扫全表 3.4GB）全部归零。
-- 老库（未分区）由 scripts/migrate-candles-partitions.ts 一次性搬过来；
-- CREATE TABLE IF NOT EXISTS 对老库是空操作，所以这段对两边都安全。
-- ⚠️ 子分区不是自动出现的：必须调 ensureCandlePartitions()（启动时/每天），否则插入会报
--    "no partition of relation found for row"（每个档都有一个 DEFAULT 分区兜底，见那儿）。
-- 每天要删掉约 90 万行（1m 那部分滚出 7 天）⇒ 让 autovacuum 勤快点，别等表涨到阈值。
-- ⚠️ **分区表上不能设 reloptions**（PG 16 直接报 "cannot specify storage parameters for a
--    partitioned table"）⇒ 必须判 relkind：普通表（迁移前）在这儿设，分区表由
--    ensureCandlePartitions() **逐个子分区**设（父表的设置也不会继承给子分区）。
DO $$
BEGIN
  IF (SELECT relkind FROM pg_class WHERE relname = 'candles' AND relnamespace = current_schema()::regnamespace) = 'r' THEN
    ALTER TABLE candles SET (
      autovacuum_vacuum_scale_factor = 0.05,
      autovacuum_analyze_scale_factor = 0.02
    );
  END IF;
END $$;
-- ⚠️ 这两个索引**都以 exchange, market_type 打头** ⇒ 想走索引的查询**必须**带上这两列
-- （底座自己的 scope 就是 cfg.exchange / cfg.marketType）。只给 interval（甚至
-- interval + symbol）是**一个索引都用不上**的 —— PG 16 没有 index skip scan，只能顺序扫整表。
-- 2026-10-07 就是这么炸的（当时只加了索引，没发现那几条查询没带 scope，索引压根没被用上）：
-- 表到 1100 万行 / 5.5GB 时，maxOpenTimes 那条只给 interval + symbol 的查询**单次 410 秒**
-- （3 个并行 worker 读满磁盘），而它**开机跑 5 次、之后每 60 秒一次** ⇒
-- vmstat wa=94%、K 线实时写入卡在 IPC/BufferIO、app 容器 **3.5 分钟才 listen()**
-- （Caddy 全程 connection refused ⇒ 全站 502）。详见 docs/EXCHANGE.md 第 52 节。
--   · 走 candles_ivl_symbol_time_idx：带 scope **且**带 symbol 的
--     （maxOpenTimes / lastOpenTime / lastTradedAt / candleCount / rollupFrom1m / 读最近 N 根 …）
--   · 走 candles_ivl_time_idx：带 scope 但**不带** symbol 的（pruneCandles / bucketCoverage …）
-- ⇒ **新增或修改 candles 的查询时，先看谓词里有没有那两列。**
-- 索引名带 ivl 前缀，别改 —— MIGRATE_SQL 里按同名建。
${CANDLES_INDEX_SQL}
-- 分区表上这两条建在**父表**上 ⇒ 每片子分区自动有同名索引，之后 ensureCandlePartitions()
-- 新建的子分区也会自动带（PG 建 PARTITION OF 时会照父表索引建）。

-- ──────────────────────────────── candles 的分区骨架（2026-10-08）
-- 静态部分放在这儿：每档一个 LIST 子分区 + 一个 DEFAULT 兜底分区。
-- ⚠️ 时间子分区（candles_1m_20261008 这种）是**滚动**的，由 ensureCandlePartitions() 建
--    （启动 / 每天 / 迁移时按需）；DEFAULT 兜底保证「忘了建」也不会插入失败
--    —— 落在 DEFAULT 里的行会在下次建该时间格时被搬进正规子分区。
-- ⚠️ 必须包 DO 且判 relkind = 'p'：老库（未分区）上直接 PARTITION OF 会报
--    「candles is not partitioned」，而 SCHEMA_SQL 每次启动都跑 —— 迁移前不能炸。
${CANDLES_PARTITION_SKELETON_SQL}

-- ──────────────────────────────── 待复核的高周期桶（2026-10-08）
-- 「库内自洽」原来是**定时全市场扫描**：每轮 4 桶 × 5 档 × 全部币 ≈ 370 万行 1m 读取，
-- 而 sum(volume) / array_agg(close…) 要的两列不在任何索引里 ⇒ 每个 1m 行都要回堆取一页。
-- 2026-10-08 实测单轮 **4 分 40 秒**（1d 一档就 3 分 33 秒），而那段最贵的 4h/1d 从没揪出过
-- 任何一个坏桶 —— 磁盘被它占住 60–99%，这就是「服务器慢」的真身（见 docs/EXCHANGE.md 第 53 节）。
--
-- 现在改成**记账 + 复核**：只有「我们自己写下去、且写的时候桶还没收盘」的高周期桶才可能坏
-- （历史数据不会自己变坏；掉线/抖动的后果都落在"最近补进来的那段"上），
-- 把那些记在这里，等它的 1m 补齐、桶也收盘之后，**只核对这一桶**（≤1440 行，毫秒级）。
-- 写入者只有三处，全部经 saveCandles 一处判定（见 recordPartialBuckets）：
--   · seed（启动灌历史，官方部分快照 —— 预期会写未收盘的桶）
--   · rollup（按构造不该写未收盘的桶 ⇒ 写了就**立即告警**，等于一条断言）
--   · repair 的 REST 覆盖（权威值，不记账）
CREATE TABLE IF NOT EXISTS kline_pending_check (
  exchange    TEXT        NOT NULL,
  market_type TEXT        NOT NULL,
  symbol      TEXT        NOT NULL,
  interval    TEXT        NOT NULL,
  open_time   TIMESTAMPTZ NOT NULL,             -- 桶起点
  why         TEXT        NOT NULL,             -- 写入来源（seed / rollup / …），排查用
  tries       INTEGER     NOT NULL DEFAULT 0,   -- 复核了几次还没法判定（1m 还没补齐）
  written_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at  TIMESTAMPTZ,
  PRIMARY KEY (exchange, market_type, symbol, interval, open_time)
);
-- 复核顺序：最老的先来；「桶已收盘」的判定在 SQL 里按 interval 算桶长
CREATE INDEX IF NOT EXISTS kline_pending_check_written_idx
  ON kline_pending_check (written_at);

-- ──────────────────────────────── K 线对账（2026-10-07，抽样那一路）
-- 每天抽几个币、每档取最近 N 根，跟交易所 REST 的官方 K 线逐字段比 OHLCV。
-- 为什么只比 OHLCV：seed / repair 灌进来的是 ccxt 口径（量 / 额 / 笔数 / 主动买量都没有，
-- 存 0），所以「量」这一档不可比 —— 要比量只能比 source = 'ws' | 'rollup' 的那些桶，
-- 而那正是「实时校验 + 缺口巡检」两档在管的事。
-- 成本：3 币 × 5 档 = 15 发 REST（每发权重 2）⇒ 30 权重 / 轮，一天一轮可忽略。
CREATE TABLE IF NOT EXISTS kline_recon (
  id           BIGSERIAL   PRIMARY KEY,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol       TEXT        NOT NULL,
  interval     TEXT        NOT NULL,
  from_time    TIMESTAMPTZ NOT NULL,
  to_time      TIMESTAMPTZ NOT NULL,
  compared     INTEGER     NOT NULL,   -- 两端都有、真比过的根数
  mismatched   INTEGER     NOT NULL,   -- 值不一致的根数
  missing      INTEGER     NOT NULL,   -- 缺口：我们缺的 + 交易所缺的
  first_bad_at TIMESTAMPTZ,            -- 第一处不一致的开盘时间（排查用）
  detail       JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- 前几处明细，别存全量
  source       TEXT        NOT NULL DEFAULT 'daily',      -- daily（定时）/ manual（手动）
  ok           BOOLEAN     NOT NULL
);
CREATE INDEX IF NOT EXISTS kline_recon_time_idx ON kline_recon (checked_at DESC);

-- ──────────────────────────────── 合约生命周期（2026-10-07）
-- 「这个币该不该有实时数据」的唯一依据：每天拉一次原始 exchangeInfo 落这里，
-- 并在 TRADING → 其它 的那一刻打上 delisted_at（**只在那一刻写**，之后不再改，
-- 这样「什么时候下架的」是准的；重新上架会把它清回 NULL）。
--
-- 为什么要一张表而不是只看 ccxt 的 markets：markets 把 status 压成了一个 active 布尔、
-- 并且**丢掉 onboardDate** —— 而「这币什么时候上线的」决定了"它该有多少历史"。
-- 唯一索引按 pair（交易所原始符号）—— 订阅、退订、上游流名都用它。
CREATE TABLE IF NOT EXISTS symbols (
  exchange     TEXT        NOT NULL,
  market_type  TEXT        NOT NULL DEFAULT 'swap',
  pair         TEXT        NOT NULL,   -- 币安交易对（BTCUSDT）
  symbol       TEXT        NOT NULL,   -- ccxt 统一符号（BTC/USDT:USDT）
  base         TEXT        NOT NULL,
  status       TEXT        NOT NULL,   -- TRADING / PENDING_TRADING / SETTLING / CLOSE
  onboard_at   TIMESTAMPTZ,            -- 币安 onboardDate（上线时间）
  delisted_at  TIMESTAMPTZ,            -- 第一次看到它不是 TRADING 的时刻
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 最后一次在原始清单里看到它
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (exchange, market_type, pair)
);
CREATE INDEX IF NOT EXISTS symbols_status_idx ON symbols (exchange, market_type, status);
`

/**
 * 结构不兼容的旧版本，在建表**之前**先删掉。
 *
 * `analyses` 原来是「一个 decision JSONB」，现在换成了完整的字段化存档，
 * 两者列完全不同。因为是按旧列名探测的，跑完旧列就没了，
 * 所以天然幂等 —— 之后每次启动都不再触发。
 */
export const MIGRATE_SQL = `
-- candles 补两个非主键查询的索引（2026-10-07）
-- ⚠️ 必须包 DO：MIGRATE 在**建表之前**跑，全新库里 candles 还不存在，
--    裸 CREATE INDEX 会直接报 "relation does not exist"。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'candles'
  ) THEN
    CREATE INDEX IF NOT EXISTS candles_ivl_symbol_time_idx
      ON candles (exchange, market_type, interval, symbol, open_time);
    CREATE INDEX IF NOT EXISTS candles_ivl_time_idx
      ON candles (exchange, market_type, interval, open_time);
  END IF;
END $$;

-- 现货钱包（只 USDT）：老库补列（2026-10-05）
ALTER TABLE IF EXISTS exchange_snapshots ADD COLUMN IF NOT EXISTS spot_usdt NUMERIC(24,8);

-- 模拟判断模式已删除，两边的 mock 列一起清掉
ALTER TABLE IF EXISTS llm_usage DROP COLUMN IF EXISTS mock;
ALTER TABLE IF EXISTS analyses  DROP COLUMN IF EXISTS mock;

-- 护栏（guardrails）已整体删除：列留着读老记录，新记录写 null，所以要去掉 NOT NULL
ALTER TABLE IF EXISTS analyses ALTER COLUMN guardrails DROP NOT NULL;

-- 规则已经改成 ai_docs（多份文档 + 版本），中间那版单行表废弃
DROP TABLE IF EXISTS rules;

-- 知识库提炼的提示词也搬进了 ai_docs → kind 多一个 'extract'。
-- 老库的 CHECK 只允许 role/rule，得先把它拆了重加（名字不定，按定义找）。
DO $$
DECLARE c RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'ai_docs'
  ) THEN
    FOR c IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'ai_docs'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%kind%'
    LOOP
      EXECUTE format('ALTER TABLE ai_docs DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE ai_docs ADD CONSTRAINT ai_docs_kind_check
      CHECK (kind IN ('role', 'rule', 'extract', 'predict'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'analyses'
       AND column_name = 'decision'
  ) THEN
    RAISE NOTICE 'analyses 是旧结构（decision JSONB），重建为新版存档表';
    DROP TABLE analyses CASCADE;
  END IF;
END $$;
`
