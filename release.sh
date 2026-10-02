#!/usr/bin/env bash
#
# 本机一键发布（在自己电脑上跑，不用先登服务器）：
#   打包 → 上传 → 服务器清旧解包 → 重跑 deploy.sh → 公网验收
#
# 用法：
#   bash release.sh              # 打包 + 上传 + 部署（会问一句确认）
#   bash release.sh -y           # 不问，直接发
#   bash release.sh --dry-run    # 只打包 + 打印命令，不碰服务器
#   bash release.sh --no-check   # 跳过 tsc 类型检查
#
# 服务器端那个脚本是 deploy.sh（加 swap / 装 Docker / 起容器 / 自检）；
# 这个脚本只管「把本机代码安全地送过去并让它跑起来」。
#
# 可覆盖的环境变量（一般不用动）：
#   HOST / SSH_USER / KEY / APP_DIR / DOMAIN

set -euo pipefail

HOST="${HOST:-57.181.38.200}"
SSH_USER="${SSH_USER:-ubuntu}"
KEY="${KEY:-$HOME/.ssh/LightsailDefaultKey-ap-northeast-1.pem}"
APP_DIR="${APP_DIR:-/opt/crypto-advisor}"
DOMAIN="${DOMAIN:-bitcoooin.cn}"
LOCAL_TAR="${LOCAL_TAR:-/tmp/ca.tgz}"
REMOTE_TAR="${REMOTE_TAR:-/tmp/ca.tgz}"

ASSUME_YES=0
DRY_RUN=0
CHECK=1

for arg in "$@"; do
  case "$arg" in
    -y|--yes)     ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    --no-check)   CHECK=0 ;;
    -h|--help)
      awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"
      exit 0 ;;
    *) printf '未知参数：%s（用 -h 看用法）\n' "$arg" >&2; exit 2 ;;
  esac
done

c()    { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
md5of() { if command -v md5 >/dev/null 2>&1; then md5 -q "$1"; else md5sum "$1" | cut -d' ' -f1; fi; }

# ---------------------------------------------------------------- 0. 本机前置检查
[[ -f package.json && -f backend/src/server.ts && -f docker-compose.prod.yml && -f deploy.sh ]] \
  || die '请在仓库根目录跑（需要 package.json / backend/src/server.ts / docker-compose.prod.yml / deploy.sh）'
[[ -f "$KEY" ]] || die "找不到 SSH 密钥：$KEY"

if (( CHECK )); then
  c '类型检查（tsc --noEmit）'
  npm run --silent typecheck
  ok '通过'
fi

# ---------------------------------------------------------------- 1. 打包
c "打包 → $LOCAL_TAR"
rm -f "$LOCAL_TAR"
# COPYFILE_DISABLE=1：别再生成 macOS 的 ._* 元数据文件（服务器上现在留了一堆）
# --no-xattrs：别把 macOS 的 xattr 写进包 —— 否则 Linux 的 GNU tar 会刷一屏
#   “Ignoring unknown extended header keyword”（实测 0 警告 vs 一百多行）
# ⚠️ --exclude='.env' 绝不能漏：服务器那份 .env 里有随机化过的 PGPASSWORD 和你的 Key
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$LOCAL_TAR" \
  --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='.env.local' \
  --exclude='backend/dist' --exclude='frontend/dist' --exclude='logs' \
  --exclude='.DS_Store' --exclude='._*' --exclude='backup*.dump' \
  -C . .

if tar tzf "$LOCAL_TAR" | grep -qx '\./\.env'; then
  die '包里混进了 .env —— 会覆盖服务器上的密钥，已中止'
fi
for f in './package.json' './backend/src/server.ts' './docker-compose.prod.yml' './Caddyfile' './deploy.sh'; do
  if ! tar tzf "$LOCAL_TAR" | grep -qxF "$f"; then
    die "包里缺 $f —— 打包内容不对，已中止"
  fi
done
ok "$(du -h "$LOCAL_TAR" | cut -f1) · $(tar tzf "$LOCAL_TAR" | wc -l | tr -d ' ') 项 · 已确认不含 .env"

LOCAL_MD5_TS="$(md5of backend/src/server.ts)"
LOCAL_MD5_DEPLOY="$(md5of deploy.sh)"

if (( DRY_RUN )); then
  c 'DRY RUN —— 不连服务器。真要执行的是：'
  printf '    scp %s %s@%s:%s\n' "$LOCAL_TAR" "$SSH_USER" "$HOST" "$REMOTE_TAR"
  printf '    ssh %s@%s  → 校验包 → 清空 %s（保留 .env）→ 解包 → md5 核对 → sudo bash deploy.sh\n' \
    "$SSH_USER" "$HOST" "$APP_DIR"
  printf '    curl https://%s/api/health\n' "$DOMAIN"
  exit 0
fi

# ---------------------------------------------------------------- 2. SSH 可用性
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
c "SSH 检查（$SSH_USER@$HOST）"
if ! ssh "${SSH_OPTS[@]}" -i "$KEY" "$SSH_USER@$HOST" true 2>/dev/null; then
  warn 'SSH 连不上。本机代理经常劫持出站 TCP（报 kex_exchange_identification / 连接被关），'
  warn '先关掉代理的全局 TUN（或给目标 IP 加直连），再跑一次。'
  die "无法连接 $SSH_USER@$HOST"
fi
ok 'SSH 可用'

# ---------------------------------------------------------------- 3. 确认
if (( ! ASSUME_YES )); then
  printf '\n把这份包（%s）发到 %s@%s 并在那儿重建容器？[y/N] ' \
    "$(du -h "$LOCAL_TAR" | cut -f1)" "$SSH_USER" "$HOST"
  read -r ans
  case "$ans" in y|Y|yes|YES) ;; *) die '已取消，什么都没动' ;; esac
fi

# ---------------------------------------------------------------- 4. 上传
c '上传'
scp -q -o BatchMode=yes -i "$KEY" "$LOCAL_TAR" "$SSH_USER@$HOST:$REMOTE_TAR"
ok "已传到 $HOST:$REMOTE_TAR"

# ---------------------------------------------------------------- 5. 远端：检查 → 清旧 → 解包 → 核对 → 部署
c '远端执行（清旧 → 解包 → 核对 → deploy.sh）'
ssh "${SSH_OPTS[@]}" -i "$KEY" "$SSH_USER@$HOST" \
  "bash -s -- '$APP_DIR' '$REMOTE_TAR' '$LOCAL_MD5_TS' '$LOCAL_MD5_DEPLOY'" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; TAR="$2"; WANT_TS="$3"; WANT_DEPLOY="$4"

echo "==> 前置检查"
[[ -d "$APP_DIR" ]] || { echo "✗ $APP_DIR 不存在 —— 首次部署请按 DEPLOY.md 手动走一遍" >&2; exit 1; }
# 服务器上的 .env 是 root:600（deploy.sh 建的），所以只能用 sudo 读
if ! sudo -n sh -c "test -s '$APP_DIR/.env' && grep -qE '^LLM_API_KEY=.+' '$APP_DIR/.env'"; then
  echo "✗ $APP_DIR/.env 里还没有 LLM_API_KEY" >&2
  echo "  首次部署要交互输入 Key，请按 DEPLOY.md「首次部署」手动来一遍" >&2
  exit 1
fi
echo "    ✓ 目录与 .env 都正常"

echo "==> 校验上传的包"
# 一次列出包内容，后面都基于它判断（--warning=... 防 macOS xattr 刷屏）
if ! listing=$(tar tzf "$TAR" --warning=no-unknown-keyword 2>/dev/null); then
  echo "✗ 包读不出来（传输损坏？）—— 先别动旧代码" >&2; exit 1
fi
if ! grep -qxF './package.json' <<<"$listing"; then
  echo "✗ 包不完整（没有 package.json）—— 先别动旧代码" >&2; exit 1
fi
if grep -qxF './.env' <<<"$listing"; then
  echo "✗ 包里含 .env，拒绝解包" >&2; exit 1
fi

echo "==> 清掉旧文件（保留 .env）"
before=$(find "$APP_DIR" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
# tar 只覆盖、不删除：不清的话，本机删掉的 .ts 会残留并被 tsc 编进镜像
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +
echo "    清掉 $before 项"

echo "==> 解包"
# 不加 sudo：文件要归 ubuntu（root 所有会让下次更新解压失败）
tar xzf "$TAR" -C "$APP_DIR" --warning=no-unknown-keyword

echo "==> 核对内容与本机一致"
got_ts=$(md5sum "$APP_DIR/backend/src/server.ts" | cut -d' ' -f1)
got_deploy=$(md5sum "$APP_DIR/deploy.sh" | cut -d' ' -f1)
if [[ "$got_ts" != "$WANT_TS" ]]; then echo "✗ server.ts 不一致：$got_ts ≠ $WANT_TS" >&2; exit 1; fi
if [[ "$got_deploy" != "$WANT_DEPLOY" ]]; then echo "✗ deploy.sh 不一致" >&2; exit 1; fi
echo "    ✓ server.ts / deploy.sh 都与本机 md5 相同"

echo "==> 跑 deploy.sh（构建镜像 + 起容器 + 自检），2 核机器要等几分钟"
cd "$APP_DIR"
sudo bash deploy.sh
REMOTE

# ---------------------------------------------------------------- 6. 公网验收
c '公网验收'
sleep 3
if curl -fsS --max-time 25 "https://$DOMAIN/api/health" > /tmp/ca-health.remote.json 2>/dev/null; then
  head -c 300 /tmp/ca-health.remote.json; echo
  if grep -q '"ok":true' /tmp/ca-health.remote.json; then
    ok "线上正常：https://$DOMAIN"
    exit 0
  fi
  warn 'health 返回了，但 ok 不是 true（看上面远端输出里的数据库提示）'
  exit 1
fi
warn "https://$DOMAIN/api/health 没通 —— 可能容器还在重启，等几秒自己再试一次："
printf '      curl -s https://%s/api/health\n' "$DOMAIN"
printf '      看日志：ssh -i %s %s@%s "cd %s && sudo docker compose -f docker-compose.prod.yml logs --tail=80 app"\n' \
  "$KEY" "$SSH_USER" "$HOST" "$APP_DIR"
exit 1
