/**
 * 全部表结构（幂等 DDL）。
 *
 *   rules_versions  规则版本（按内容 hash 去重，历史分析可还原当时读了什么）
 *   analyses        每次分析的完整存档（输入 / 结论 / 计划 / 护栏 / 事后结果）
 *   knowledge       知识库 —— 我标过的案例 + AI 提炼的经验
 *   llm_usage       每次大模型调用的 token 与花费
 *
 * 分层原则：
 *   · 要**筛选 / 排序 / 统计**的 → 独立列（档位、结论、币种、价格、R 倍数…）
 *   · 只用来**回放详情**的 → JSONB（AI 完整输出 / 行情快照 / 护栏明细）
 *   · 会**重复的长文本** → 单独一张表按 hash 去重（规则全文 6.6K，不能每行一份）
 *
 * 规则本身不存数据库，是 rules/ 目录下的 Markdown 文件；
 * 这里只留一份快照，保证「规则改了以后，旧分析还能还原现场」。
 */
export const SCHEMA_SQL = `
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
  -- 期望值用的假设胜率（0~1）
  assumed_win_rate NUMERIC(5,4),

  -- ────────── 结论：要能筛选 / 统计，所以提成列 ──────────
  -- A 顺势单 / B 不该做 / C 期望突破 / unclear 说不清
  grade         TEXT,
  grade_reason  TEXT,
  -- go 可做 / wait 观望 / no_go 不可做
  verdict       TEXT,
  verdict_reason TEXT,
  confidence    INTEGER,
  -- long / short / none
  direction     TEXT,

  -- ────────── 计划：以后算「到底走没走到」要用 ──────────
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

  -- ────────── 护栏：代码层的红线，跟 AI 的判断分开存 ──────────
  guard_passed  BOOLEAN,
  -- 触发的一票否决（B 档 5 条里的哪几条）
  veto          TEXT[]      NOT NULL DEFAULT '{}',
  -- 触发的硬红线
  red_lines     TEXT[]      NOT NULL DEFAULT '{}',

  -- ────────── 来源与成本 ──────────
  model         TEXT,
  rules_hash    TEXT        REFERENCES rules_versions (hash) ON DELETE SET NULL,
  -- 这次引用了知识库里的哪些经验
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
  -- AI 的完整输出（checklist / exitTriggers / coachLine 都在里面）
  result        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- 护栏逐条明细
  guardrails    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- 期望值计算过程
  expectancy    JSONB,
  -- 行情快照：多周期统计 + 市场热度 + 价格结构
  snapshot      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  meta          JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- ────────── 事后结果：复盘用，先留位（null = 还没结算）──────────
  -- tp1 / tp2 / tp3 到止盈 | sl 打止损 | breakeven 平手
  -- | expired 到期未触发 | skipped 看了但没做（这其实最常见）
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

-- ---------------------------------------------------------------- 知识库
CREATE TABLE IF NOT EXISTS knowledge (
  id           BIGSERIAL   PRIMARY KEY,
  symbol       TEXT        NOT NULL,
  ccxt_symbol  TEXT,
  exchange     TEXT        NOT NULL DEFAULT 'binance',
  timeframe    TEXT        NOT NULL,
  -- do = 这是我该做的；dont = 这是我不该做的
  label        TEXT        NOT NULL CHECK (label IN ('do', 'dont')),
  -- A 顺势单 / B 不该做 / C 期望突破
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
`

/**
 * 结构不兼容的旧版本，在建表**之前**先删掉。
 *
 * `analyses` 原来是「一个 decision JSONB」，现在换成了完整的字段化存档，
 * 两者列完全不同。因为是按旧列名探测的，跑完旧列就没了，
 * 所以天然幂等 —— 之后每次启动都不再触发。
 */
export const MIGRATE_SQL = `
-- 模拟判断模式已删除，两边的 mock 列一起清掉
ALTER TABLE IF EXISTS llm_usage DROP COLUMN IF EXISTS mock;
ALTER TABLE IF EXISTS analyses  DROP COLUMN IF EXISTS mock;

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
