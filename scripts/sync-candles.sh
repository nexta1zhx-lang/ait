#!/usr/bin/env bash
#
# 本地 candles → 线上数据库（用户 2026-10-07：「历史数据用脚本在本地数据库补上…导入线上数据库」）。
#
# 为什么这么做：线上出口 IP 要跟交易/账户共用权重（2400/分钟），在线灌历史会把它打进 `-1003`
# （实测一次 85 次）。本地那台机器有独立出口 —— 历史在本地拉全，整表导过去，线上零请求。
#
# 用法：
#   bash scripts/sync-candles.sh              # 合并（幂等，可反复跑；适合增量补）★ 默认用它
#   bash scripts/sync-candles.sh --replace    # 先清空线上 candles 再整表灌（最快，适合一次铺满）
#
# ⚠️ 为什么默认是 merge：线上底座在**实时**往 candles 里写（ws/rollup），
#   `--replace` 的 TRUNCATE 会把「本地还没补到的那段尾」一起清掉 ——
#   只有在本地确实包含完整尾段时才能用 replace。
#   而 merge 又反过来有另一个坑：本地 REST 灌的 `seed` 行没有成交额（ccxt OHLCV 只有 5 字段），
#   同桶合并会把线上那份带成交额的行打坏 ⇒ 合并语句里加了护栏：
#   **只允许「有成交额」的覆盖「没成交额」的**，反向一律不动（见下面 ON CONFLICT 的 WHERE）。
#
# 导出/导入都用 `\copy ... WITH CSV`（两边列顺序都按 `schema.ts` 那张表），
# 并且**两边都锁 UTC**（PGTZ=UTC）—— 否则 timestamptz 会按各自时区写成墙钟时间、整体偏几小时。
set -euo pipefail

MODE="merge"
if [[ "${1:-}" == "--replace" ]]; then MODE="replace"; fi

KEY="${HOME}/.ssh/LightsailDefaultKey-ap-northeast-1.pem"
SRV="ubuntu@52.194.6.144"
LOCAL_DB="ca-postgres"          # 本地容器名（docker-compose.yml 里写死的 container_name）
LOCAL_USER="ca"
LOCAL_DBNAME="crypto_advisor"
LOCAL_DUMP="/tmp/candles-export.csv.gz"
REMOTE_DUMP="/tmp/candles-import.csv.gz"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "本地导出 candles（CSV → gzip）"
docker exec -e PGTZ=UTC -i "${LOCAL_DB}" psql -U "${LOCAL_USER}" -d "${LOCAL_DBNAME}" -q \
  -c "\\copy candles TO STDOUT WITH CSV" | gzip -1 > "${LOCAL_DUMP}"
ls -lh "${LOCAL_DUMP}"
docker exec -e PGTZ=UTC -i "${LOCAL_DB}" psql -U "${LOCAL_USER}" -d "${LOCAL_DBNAME}" -t -A \
  -c "select '本地行数 ' || count(*) from candles"

say "传到线上"
scp -q -i "${KEY}" "${LOCAL_DUMP}" "${SRV}:${REMOTE_DUMP}"

say "线上导入（${MODE}）"
ssh -i "${KEY}" "${SRV}" "MODE=${MODE} bash -s" <<'EOS'
set -euo pipefail
cd /opt/crypto-advisor
PSQL=(sudo docker compose -f docker-compose.prod.yml exec -T -e PGTZ=UTC db psql -U ca -d crypto_advisor -q)
"${PSQL[@]}" -c 'DROP TABLE IF EXISTS candles_import'
if [ "${MODE}" = "replace" ]; then
  "${PSQL[@]}" -c 'TRUNCATE candles'
  zcat /tmp/candles-import.csv.gz | "${PSQL[@]}" -c '\copy candles FROM STDIN WITH CSV'
  echo "已整表替换"
else
  "${PSQL[@]}" -c 'CREATE UNLOGGED TABLE candles_import (LIKE candles INCLUDING DEFAULTS)'
  zcat /tmp/candles-import.csv.gz | "${PSQL[@]}" -c '\copy candles_import FROM STDIN WITH CSV'
  "${PSQL[@]}" -c 'INSERT INTO candles SELECT * FROM candles_import
      ON CONFLICT (exchange, market_type, symbol, interval, open_time) DO UPDATE SET
        high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
        volume = EXCLUDED.volume, quote_volume = EXCLUDED.quote_volume,
        trades = EXCLUDED.trades, taker_buy_volume = EXCLUDED.taker_buy_volume,
        source = EXCLUDED.source, updated_at = now()
      WHERE NOT (EXCLUDED.quote_volume = 0 AND candles.quote_volume > 0)'
  "${PSQL[@]}" -c 'DROP TABLE candles_import'
  echo "已合并（同桶以本地这份为准）"
fi
EOS

say "线上核对"
ssh -i "${KEY}" "${SRV}" "cd /opt/crypto-advisor && sudo docker compose -f docker-compose.prod.yml exec -T db psql -U ca -d crypto_advisor \
  -c \"select interval, count(distinct symbol) as 币数, count(*) as 行数, to_char(min(open_time),'YYYY-MM-DD') as 最早, to_char(max(open_time),'MM-DD HH24:MI') as 最新 from candles group by interval order by interval\" \
  -c \"select pg_size_pretty(pg_total_relation_size('candles')) as 表大小\""

rm -f "${LOCAL_DUMP}"
say "完成（线上不用重启：这张表 P1 的读路径才用）"
