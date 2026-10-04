#!/usr/bin/env bash
#
# 服务器端一键部署（Ubuntu）。已经在 AWS Lightsail 上验证过路径。
#
# 用法（在服务器的终端里跑）：
#   bash deploy.sh                  # 代码已经放在当前目录 / APP_DIR
#   bash deploy.sh <git仓库地址>     # 自动 clone 到 /opt/crypto-advisor
#
# 💡 这个脚本可以整段粘进 AWS Lightsail 控制台的「浏览器终端」——
#    本机网络如果劫持了 SSH（实测本机就是），浏览器终端是唯一入口。
#
# 它做四件事：加 swap → 装 Docker → 备好 .env → 起服务并自检。
# 幂等：重复跑不会做坏事。

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/crypto-advisor}"
REPO="${1:-}"

c()   { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Linux ]] || die '这个脚本要在服务器（Linux）上跑，本机是 macOS'

if [[ $EUID -eq 0 ]]; then
  SUDO=''
elif sudo -n true 2>/dev/null; then
  SUDO='sudo'
else
  die '需要 sudo 权限（当前用户无法免密 sudo）'
fi

# ---------------------------------------------------------------- 1. swap
mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
if (( mem_mb < 1900 )) && ! swapon --show 2>/dev/null | grep -q .; then
  c "内存只有 ${mem_mb}MB —— 加 2GB swap（Postgres + Node 很容易被 OOM 杀掉）"
  $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || printf '/swapfile none swap sw 0 0\n' | $SUDO tee -a /etc/fstab >/dev/null
  printf 'vm.swappiness=10\n' | $SUDO tee /etc/sysctl.d/99-ca-swap.conf >/dev/null
  $SUDO sysctl -q -w vm.swappiness=10
  ok "swap 已挂上（2GB，swappiness=10）"
else
  ok "内存 ${mem_mb}MB，不折腾 swap"
fi

# ---------------------------------------------------------------- 2. Docker
if ! command -v docker >/dev/null 2>&1; then
  c '安装 Docker'
  curl -fsSL https://get.docker.com | $SUDO sh
fi
$SUDO docker compose version >/dev/null 2>&1 || die 'docker compose 插件不可用'
ok "docker $($SUDO docker version --format '{{.Server.Version}}')，compose $($SUDO docker compose version --short)"

# ---------------------------------------------------------------- 3. 代码
if [[ -n "$REPO" ]]; then
  if [[ -d "$APP_DIR/.git" ]]; then
    c "更新已有代码 $APP_DIR"
    $SUDO git -C "$APP_DIR" pull --ff-only
  else
    c "克隆代码到 $APP_DIR"
    command -v git >/dev/null 2>&1 || {
      $SUDO apt-get update -qq
      $SUDO apt-get install -y -qq git
    }
    $SUDO mkdir -p "$(dirname "$APP_DIR")"
    $SUDO git clone "$REPO" "$APP_DIR"
    # 改成当前用户所有，后面几步不用一路 sudo
    if [[ -n "$SUDO" ]]; then $SUDO chown -R "$(id -u):$(id -g)" "$APP_DIR"; fi
  fi
fi

if [[ ! -f "$APP_DIR/docker-compose.prod.yml" ]]; then
  die "在 $APP_DIR 里找不到 docker-compose.prod.yml。
    先把代码放进去，或者用：bash deploy.sh <git仓库地址>"
fi
cd "$APP_DIR"
ok "工作目录 $APP_DIR"

# ---------------------------------------------------------------- 4. .env
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok '已从 .env.example 生成 .env'
fi
# ⚠️ 必须是普通文件：Docker 遇到不存在的挂载路径会建出一个同名目录，之后启动必失败
[[ -f .env ]] || die '.env 不是普通文件。删掉重建：rm -rf .env && cp .env.example .env'
chmod 600 .env

# 大模型配置 2026-10-04 起不放 .env：Key / 模型 / 接口地址都在网页
# 「我的 → 模型配置」里按用户存数据库；管理员账号会自动接手旧 .env 里的那份。

if grep -q '^PGPASSWORD=ca_local_dev' .env; then
  if command -v openssl >/dev/null 2>&1; then
    PW="$(openssl rand -hex 16)"
  else
    PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 32 || true)"
  fi
  [[ -n "$PW" ]] || die '生成随机密码失败'
  PW="$PW" awk '/^PGPASSWORD=/{print "PGPASSWORD=" ENVIRON["PW"]; next} {print}' .env > .env.new
  mv .env.new .env
  chmod 600 .env
  ok 'PGPASSWORD 已换成随机密码（记录在 .env 里）'
else
  ok 'PGPASSWORD 已经改过'
fi

# ---------------------------------------------------------------- 5. 起服务
# 先把 Caddyfile 校验一遍：语法错的话 https 打不开，但日志要翻半天才看得出来
c '校验 Caddyfile'
$SUDO docker pull caddy:2-alpine >/dev/null
$SUDO docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null \
  && ok 'Caddyfile 语法 OK' \
  || die 'Caddyfile 语法有问题，改完再跑一次'

c '构建并启动（首次要拉镜像 + 装依赖，几分钟）'
$SUDO docker compose -f docker-compose.prod.yml up -d --build

echo
$SUDO docker compose -f docker-compose.prod.yml ps

c '等应用起来并自检'
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8787/api/health >/tmp/ca-health.json 2>/dev/null; then
    break
  fi
  sleep 2
done

if [[ -s /tmp/ca-health.json ]]; then
  head -c 400 /tmp/ca-health.json
  echo
  # HTTP 200 只说明进程起来了，数据库通不通要看 health 里的 ok
  if grep -q '"ok":false' /tmp/ca-health.json; then
    warn '容器起来了，但数据库连不上（health 里 ok=false）—— 先看这两个日志：'
    printf '      docker compose -f docker-compose.prod.yml logs --tail=80 db\n'
    printf '      docker compose -f docker-compose.prod.yml logs --tail=80 app\n'
  else
    ok '应用已就绪（数据库正常）'
    if grep -q '"sources":\[\]' /tmp/ca-health.json; then
      warn '数据库里还没有提示词 —— 开单分析会报错，见 DEPLOY.md「首次部署」第 4 步（迁移 ai_docs）'
    fi
  fi
else
  warn '本地健康检查没通过，看日志：'
  printf '      docker compose -f docker-compose.prod.yml logs --tail=80 app\n'
fi

# ---------------------------------------------------------------- 6. 收尾提示
cat <<'EOF'

────────────────────────────────────────────────────────────
接下来只差两件事（都在 AWS 控制台点，不需要命令行）：

 ① Lightsail → 实例 → Networking → IPv4 Firewall
    确认有这三条：SSH 22 / HTTP 80 / HTTPS 443
    （缺 80 和 443 的话，Caddy 申请不到证书，https 打不开）

 ② 域名 bitcoooin.cn 的 A 记录已确认指向 57.181.38.200 ✔
    等 1~2 分钟，浏览器打开 https://bitcoooin.cn 即可

常用命令：
  docker compose -f docker-compose.prod.yml ps            # 看状态
  docker compose -f docker-compose.prod.yml logs -f app    # 看应用日志
  docker compose -f docker-compose.prod.yml logs -f caddy  # 看证书/访问日志
  docker compose -f docker-compose.prod.yml restart app    # 重启应用
  docker stats                                             # 看 CPU/内存

开监控面板（可选）：
  docker compose -f docker-compose.prod.yml --profile monitor up -d
  # 然后按 Caddyfile 里的注释加 DNS 记录并放开那两段配置
────────────────────────────────────────────────────────────
EOF
