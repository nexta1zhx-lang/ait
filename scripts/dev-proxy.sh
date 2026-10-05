#!/usr/bin/env bash
#
# 本地开发：让交易所请求**从服务器出去**（2026-10-05）
#
# 为什么需要它：
#   · 开发机连不上币安（或不稳），而币安 API Key 的 IP 白名单里填的是**服务器 IP** ⇒
#     本地直接跑会一路 `-2015 Invalid API-key, IP, or permissions`。
#   · 走这个隧道以后，本地 dev server 的出口 IP = 服务器 IP，两把 Key 都能用，
#     也不用开全局 TUN（TUN 拐的是整机，这个只拐你那个 dev 进程）。
#
# 结构：
#   dev server --HTTP CONNECT--> 127.0.0.1:8888 --(ssh -L)--> 服务器 127.0.0.1:8888
#              (tinyproxy，只监听 127.0.0.1，公网扫不到、不需要 BasicAuth)
#                                                    --> fapi.binance.com …
#
# 用法：
#   bash scripts/dev-proxy.sh            # 开隧道（前台挂着，Ctrl+C 关）
#   bash scripts/dev-proxy.sh --check    # 只体检：隧道通不通、出口 IP 是不是服务器
#   bash scripts/dev-proxy.sh --print    # 只打印要 export 的环境变量
#
# 另开一个终端（`--print` 会把下面两行原样打出来）：
#   export EXCHANGE_PROXY=http://127.0.0.1:8888
#   export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8888
#   npm run web
#
# ⚠️ 为什么 ccxt 那条是 `EXCHANGE_PROXY` 而不是 `HTTPS_PROXY`：ccxt 会自己塞一个直连
#    dispatcher，把 Node 的环境变量代理整条绕过（`data/exchange-account.ts` 的
#    `exchangeProxy()` 里有详解）。`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` 只管**裸 fetch**
#    （CoinGecko 那种）；WebSocket 则读 `EXCHANGE_PROXY`（同文件 `wsAgent()`）。

set -euo pipefail

HOST="${HOST:-52.194.6.144}"
SSH_USER="${SSH_USER:-ubuntu}"
KEY="${KEY:-$HOME/.ssh/LightsailDefaultKey-ap-northeast-1.pem}"
PORT="${PORT:-8888}"
PROXY_URL="http://127.0.0.1:${PORT}"

c()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
}

print_env() {
  c '在跑 dev server 的那个终端里 export 这些'
  printf '    export EXCHANGE_PROXY=%s\n' "$PROXY_URL"
  printf '    export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=%s\n' "$PROXY_URL"
  printf '    npm run web\n\n'
  printf '    两个都要，各管一半（实测过，缺一个就会有一半接口超时）：\n'
  printf '      · EXCHANGE_PROXY      → **所有 ccxt 实例**：余额 / 持仓 / 下单 / 划转 /\n'
  printf '                              listenKey，以及行情那条（exchangeInfo / K 线 /\n'
  printf '                              ticker 都是 ccxt 打的）。它必须走 ccxt 自己的\n'
  printf '                              httpProxy —— 环境变量代理会被 ccxt 整条绕过。\n'
  printf '      · NODE_USE_ENV_PROXY+HTTPS_PROXY → 裸 fetch 那些（CoinGecko 市值排名）。\n\n'
  printf '    WebSocket 不用再设第三个变量：K 线实时 与 用户数据流 都读同一个\n'
  printf '    EXCHANGE_PROXY（`wsAgent()` 拿它给 ws 建 CONNECT 隧道）。\n'
  printf '    ⚠️ 不设代理时本机 WS 的表现是**「连上了但一条数据都不推」** —— 墙把\n'
  printf '       fstream.binance.com 解析到假 IP，看着像币安不推，其实是没连到币安。\n'
}

check() {
  c "体检：$PROXY_URL → $HOST:$PORT"
  curl -s -m 12 -x "$PROXY_URL" https://api.ipify.org > /tmp/.dev-proxy-ip 2>/dev/null \
    || die "隧道不通。先确认隧道开着（不带 --check 跑一次），以及服务器上 sudo systemctl status tinyproxy"
  got="$(cat /tmp/.dev-proxy-ip)"; rm -f /tmp/.dev-proxy-ip
  ok "出口 IP：$got"
  if [[ "$got" == "$HOST" ]]; then
    ok '就是服务器本机 —— 币安白名单认的就是它'
  else
    printf '    \033[1;33m!\033[0m 出口不是 %s，白名单可能对不上\n' "$HOST"
  fi
  # ⚠️ 必须写成 ${code}：macOS 自带 bash 3.2 会把紧跟其后的**全角括号**当成变量名的一部分
  #    （报 `code）: unbound variable`）—— 跟 release.sh 里那句 `${HOST}` 是同一个坑。
  code="$(curl -s -m 12 -o /dev/null -w '%{http_code}' -x "$PROXY_URL" https://fapi.binance.com/fapi/v1/ping || true)"
  [[ "${code}" == "200" ]] && ok "币安可达（/fapi/v1/ping → ${code}）" || printf '    \033[1;33m!\033[0m 币安 /fapi/v1/ping → %s\n' "${code}"
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --print)   print_env; exit 0 ;;
  --check)   check; exit 0 ;;
  '') ;;
  *) die "未知参数：$1（用 -h 看用法）" ;;
esac

[[ -f "$KEY" ]] || die "找不到 SSH 密钥：$KEY"
if (ss -ltn 2>/dev/null || netstat -ltn) | grep -q ":${PORT}\b"; then
  c "本机 $PORT 已经有人在听 —— 隧道可能已经在跑了"
  check
  print_env
  exit 0
fi

c "开隧道（前台挂着，Ctrl+C 就关）"
printf '    本机 127.0.0.1:%s  ==ssh -L==>  %s:%s（只监听回环）\n' "$PORT" "$SSH_USER" "$HOST"
print_env
exec ssh -N \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -i "$KEY" \
  -L "${PORT}:127.0.0.1:${PORT}" \
  "${SSH_USER}@${HOST}"
