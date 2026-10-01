/**
 * 全部表结构（幂等 DDL）。
 *
 *   knowledge   知识库 —— 我标过的案例（该做 / 不该做）+ AI 提炼的经验
 *   analyses    开单分析记录（回溯用，页面不显示）
 *   llm_usage   每次大模型调用的 token 与花费（统计用）
 *
 * 规则不存数据库：直接读 rules/ 目录下的 Markdown。
 */
export const SCHEMA_SQL = `
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

-- ---------------------------------------------------------------- 分析记录
CREATE TABLE IF NOT EXISTS analyses (
  id          BIGSERIAL   PRIMARY KEY,
  symbol      TEXT        NOT NULL,
  exchange    TEXT        NOT NULL DEFAULT 'binance',
  grade       TEXT,
  verdict     TEXT,
  confidence  INTEGER,
  price       NUMERIC,
  decision    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  rules_hash  TEXT,
  model       TEXT,
  mock        BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analyses_created_idx ON analyses (created_at DESC);

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
  -- 模拟判断（网络调用，不花钱）
  mock              BOOLEAN      NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_usage_created_idx ON llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS llm_usage_kind_idx    ON llm_usage (kind, model);

-- 上一版不要的表
DROP TABLE IF EXISTS my_rules;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS case_rules;
DROP TABLE IF EXISTS case_notes;
DROP TABLE IF EXISTS cases;
DROP TABLE IF EXISTS rules;
DROP TABLE IF EXISTS documents;
`
