#!/usr/bin/env bash
#
# 可用性看门狗：查「应用 + 数据库 + 容器」，**只在状态变化时**推 Telegram。
#
# 由服务器上的 systemd timer 每分钟拉起一次：
#   /etc/systemd/system/ait-alert.service + ait-alert.timer
#
# ⚠️ 脚本必须留在**仓库里**（release.sh 会把它带上去）。别只放在服务器上 ——
#    release.sh 部署时会先清掉服务器上的旧文件再解包，只放服务器会被清掉。
#    所以这里读的是部署后的路径 `/opt/crypto-advisor/scripts/alert-watchdog.sh`。
#
# ⚠️ 能力边界（别指望它做它做不到的事）：
#    它跑在**同一台机器**上，只能发现「应用 / 数据库 / 容器自己挂了」。
#    「外网不可达 / 运营商把某条链路掐了」它**发现不了** —— 那类要外部探针。
#    （2026-10-14 那次 5G 断 10 分钟就是那类：本脚本当时会一路报正常。）
#
# 配置：/etc/ait-alert.env（root 600，**不进 git**）
#   TELEGRAM_BOT_TOKEN=...   # @BotFather 拿
#   TELEGRAM_CHAT_ID=...     # 给 bot 发过 /start 之后，getUpdates 里拿
#   可选：HEALTH_URL（默认 http://127.0.0.1:8787/api/health）
#         FAIL_THRESHOLD（连续失败几次才报，默认 3）
#         HEARTBEAT_HHMM（例如 09:00，每天这个点发一条「我还活着」；不填就不发）
#
# 手动跑（排查用）：
#   sudo bash scripts/alert-watchdog.sh          # 跑一次检查
#   sudo bash scripts/alert-watchdog.sh --test   # 直接发一条测试消息，不动状态

set -uo pipefail

ENV_FILE="${AIT_ALERT_ENV:-/etc/ait-alert.env}"
if [ ! -r "$ENV_FILE" ]; then
  echo "读不到 $ENV_FILE（root 600，请用 sudo 跑）" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/health}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
HEARTBEAT_HHMM="${HEARTBEAT_HHMM:-}"
STATE_DIR="${STATE_DIR:-/var/lib/ait-alert}"
STATE_FILE="$STATE_DIR/state"

now() { TZ=Asia/Shanghai date '+%F %T'; }
log() { echo "[$(TZ=Asia/Shanghai date '+%F %T')] $*"; }

# 状态文件（root 写、root 读）：
#   status       —— 本次判定：up / down
#   fails        —— 连续失败次数
#   notified     —— 已经**通知过**的状态（up / down / 空=还没通知过任何一次）
#   down_since   —— 这次故障是什么时候开始的（恢复消息里报持续了多久）
#   hb_date      —— 上次发心跳的日期（避免一天发多次）
status=up
fails=0
notified=""
down_since=""
hb_date=""
if [ -r "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi
prev_fails="$fails"
prev_notified="$notified"
prev_down_since="$down_since"

tg_send() {
  local resp
  resp="$(curl -sS --max-time 12 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "disable_web_page_preview=true" \
    --data-urlencode "text=$1" 2>&1)"
  case "$resp" in
    *'"ok":true'*) return 0 ;;
    *)
      log "Telegram 发送失败：${resp:0:180}"
      return 1
      ;;
  esac
}

if [ "${1:-}" = "--test" ]; then
  if tg_send "🔔 Ait 告警通道测试 · $(now)"; then
    echo "测试消息已发出 ✓"
    exit 0
  fi
  echo "测试消息发送失败 ✗（看上面那行原因）"
  exit 1
fi

# ---------------------------------------------------------------- 检查

reason=""

# ① 应用 + 数据库：走本机直连后端（127.0.0.1:8787），不经过 Caddy / xray，
#    这样报出来的原因就是「后端/库」本身，不会跟「入口挂了」混在一起。
body_file="$(mktemp)"
http_code="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 8 "$HEALTH_URL" 2>/dev/null)"
body="$(cat "$body_file" 2>/dev/null)"
rm -f "$body_file"

if [ "$http_code" != "200" ]; then
  reason="/api/health 返回 HTTP ${http_code:-无响应}（期望 200）"
elif ! printf '%s' "$body" | grep -q '"ok":true'; then
  reason="/api/health 没返回 ok:true"
elif ! printf '%s' "$body" | grep -q '"db":{"ok":true'; then
  reason="数据库不健康（/api/health 里 db.ok 不是 true）"
fi

# ② 三个容器都得在跑（后端之外，Caddy / 库单挂也要能发现）
if [ -z "$reason" ]; then
  for c in ca-app ca-caddy ca-postgres; do
    st="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)"
    if [ "$st" != "running" ]; then
      reason="容器 $c 状态异常：$st"
      break
    fi
  done
fi

# ---------------------------------------------------------------- 判定

if [ -z "$reason" ]; then
  status=up
  fails=0
else
  status=down
  fails=$((prev_fails + 1))
  log "异常：$reason（连续第 $fails 次）"
fi

if [ "$status" = "down" ]; then
  [ -n "$prev_down_since" ] && down_since="$prev_down_since" || down_since="$(now)"

  # 连续失败够多次才报（避免网络抖一下就响），且**状态没变过就不重复刷屏**
  if [ "$fails" -ge "$FAIL_THRESHOLD" ] && [ "$prev_notified" != "down" ]; then
    if tg_send "🔴 Ait 故障
原因：$reason
连续失败：$fails 次（阈值 $FAIL_THRESHOLD）
开始于：$down_since"; then
      notified=down
    else
      notified="$prev_notified" # 没发出去 ⇒ 下分钟接着试
    fi
  else
    notified="$prev_notified"
  fi
else
  if [ "$prev_notified" = "down" ]; then
    if tg_send "✅ Ait 已恢复
恢复于：$(now)
故障开始：$prev_down_since"; then
      notified=up
    else
      notified="$prev_notified"
    fi
  elif [ -z "$prev_notified" ]; then
    notified=up # 首次运行且一切正常：只记状态，不发消息
  else
    notified="$prev_notified"
  fi
  down_since=""
fi

# 可选：每天一条心跳，证明「告警通道本身没坏」
if [ -n "$HEARTBEAT_HHMM" ] && [ "$status" = "up" ] \
  && [ "$(TZ=Asia/Shanghai date '+%H:%M')" = "$HEARTBEAT_HHMM" ] \
  && [ "$hb_date" != "$(TZ=Asia/Shanghai date '+%F')" ]; then
  if tg_send "🟢 Ait 每日心跳 · $(now) · 一切正常"; then
    hb_date="$(TZ=Asia/Shanghai date '+%F')"
  fi
fi

# ---------------------------------------------------------------- 落盘

mkdir -p "$STATE_DIR" 2>/dev/null
{
  printf 'status=%q\n' "$status"
  printf 'fails=%q\n' "$fails"
  printf 'notified=%q\n' "$notified"
  printf 'down_since=%q\n' "$down_since"
  printf 'hb_date=%q\n' "$hb_date"
} >"$STATE_FILE" 2>/dev/null || log "写状态文件失败：$STATE_FILE"

exit 0
