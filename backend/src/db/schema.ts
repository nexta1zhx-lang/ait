/**
 * 全部表结构（幂等 DDL）。
 *
 *   ai_docs          AI 的「角色设定 / 规则正文」文档（可多份、可启停、可排序）
 *   ai_doc_versions  每份文档的历史版本（保存一次留一版，可回滚）
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
export const SCHEMA_SQL = `
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
-- 案例标签只能从这份清单里挑；清单由我自己在网页上维护（空表时播种默认 10 个）
CREATE TABLE IF NOT EXISTS tag_templates (
  id         BIGSERIAL   PRIMARY KEY,
  name       TEXT        NOT NULL,
  sort       INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tag_templates_name_idx ON tag_templates (name);

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
