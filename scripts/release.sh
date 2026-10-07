#!/usr/bin/env bash
#
# 本机一键发布（在自己电脑上跑，不用先登服务器）：
#   打包 → 上传 → 服务器清旧解包 → 重跑 scripts/deploy.sh → 公网验收
#
# 🛑🛑 **只由用户手工命令时才能跑**（2026-10-07 用户明确要求）。
#    助手 / 自动化不要自己执行这个脚本（更不要加 `-y`）—— 做到「本地验证 + commit + push」
#    就停下，等用户说上线。详见 docs/DEPLOY.md 顶部那段。
#
# 用法（在仓库根目录跑）：
#   bash scripts/release.sh              # 打包 + 上传 + 部署（会问一句确认）
#   bash scripts/release.sh -y           # 不问，直接发
#   bash scripts/release.sh --dry-run    # 只打包 + 打印命令，不碰服务器
#   bash scripts/release.sh --no-check   # 跳过「未提交改动」与 tsc 类型检查
#
# 服务器端那个脚本是 scripts/deploy.sh（加 swap / 装 Docker / 起容器 / 自检）；
# 这个脚本只管「把本机代码安全地送过去并让它跑起来」。
#
# 可覆盖的环境变量（一般不用动）：
#   HOST / SSH_USER / KEY / APP_DIR / DOMAIN

set -euo pipefail

# 脚本在 scripts/ 下，统一切到仓库根 —— 下面全是相对仓库根的路径
# （tar -C .、package.json、backend/src/…）。`bash scripts/release.sh`
# 和 `bash /abs/path/scripts/release.sh` 两种调法都能正确定位。
cd "$(dirname "$0")/.."

HOST="${HOST:-52.194.6.144}"
SSH_USER="${SSH_USER:-ubuntu}"
KEY="${KEY:-$HOME/.ssh/LightsailDefaultKey-ap-northeast-1.pem}"
APP_DIR="${APP_DIR:-/opt/crypto-advisor}"
DOMAIN="${DOMAIN:-bitcoooin.cn}"
LOCAL_TAR="${LOCAL_TAR:-/tmp/ca.tgz}"
REMOTE_TAR="${REMOTE_TAR:-/tmp/ca.tgz}"
# 需要单独补传的 APK 先落在服务器的这个暂存目录（见「4b. APK 按需上传」）
REMOTE_APK_DIR="${REMOTE_APK_DIR:-/tmp/ca-apk}"

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
[[ -f package.json && -f backend/src/server.ts && -f docker-compose.prod.yml && -f scripts/deploy.sh ]] \
  || die '请在仓库根目录跑（需要 package.json / backend/src/server.ts / docker-compose.prod.yml / scripts/deploy.sh）'
[[ -f "$KEY" ]] || die "找不到 SSH 密钥：$KEY"

if (( CHECK )); then
  # 用户 2026-10-04：「部署的时候先本地保存代码」——
  # 发出去的代码必须对应一个明确的提交，否则后面出问题没法回溯「当时跑的是哪版」。
  # 放在类型检查**前面**：脏工作区要立刻报，不浪费时间跑 tsc。
  if git rev-parse --git-dir >/dev/null 2>&1 \
     && [[ -n "$(git status --porcelain)" ]]; then
    git status --short >&2
    die '工作区有未提交的改动 —— 先「git commit」再发布（要强行跳过就加 --no-check）'
  fi
  ok "代码已保存：$(git log -1 --format='%h %s')"

  c '类型检查（tsc --noEmit）'
  npm run --silent typecheck
  ok '通过'
fi

# ---------------------------------------------------------------- 0b. 本机预构建
# 2026-10-07：这一步是为了**别让服务器去编译**。原来每次发布都在服务器上跑
# `npm run build:all`，那台 2 核 Lightsail 实测 `tsc` ≈31 秒 + `vite build` ≈51 秒
# （777 个模块）= **111 秒**，占整趟发布 5 分钟里的 1/3 还多 —— 哪怕只改了一个 .vue。
# 本机（M 系 Mac）跑同一份脚本只要几秒，产物是纯 JS/CSS/HTML，跟平台无关。
# 容器侧靠 `Dockerfile` 的 `PREBUILT` 开关跳过编译（见 docker-compose.prod.yml）。
c '本机预构建（backend/dist + frontend/dist 随包发过去）'
rm -rf backend/dist frontend/dist
npm run --silent build:all
[[ -f backend/dist/server.js ]] || die '预构建失败：没有 backend/dist/server.js'
[[ -f frontend/dist/index.html ]] || die '预构建失败：没有 frontend/dist/index.html'
ok "产物已就绪（后端 $(find backend/dist -type f | wc -l | tr -d ' ') 个文件 / 前端 $(find frontend/dist -type f | wc -l | tr -d ' ') 个文件）"

# ---------------------------------------------------------------- 1. 打包
c "打包 → $LOCAL_TAR"
rm -f "$LOCAL_TAR"
# COPYFILE_DISABLE=1：别再生成 macOS 的 ._* 元数据文件（服务器上现在留了一堆）
# --no-xattrs：别把 macOS 的 xattr 写进包 —— 否则 Linux 的 GNU tar 会刷一屏
#   “Ignoring unknown extended header keyword”（实测 0 警告 vs 一百多行）
# ⚠️ --exclude='.env' 绝不能漏：服务器那份 .env 里有随机化过的 PGPASSWORD 和你的 Key
# ./android 是 Capacitor 的原生工程（含 Gradle 构建产物，几十 MB），服务器只跑
#   后端 + 前端 dist，完全用不到它 —— 排掉能让包小一大截。
# ./downloads 要传（`releases.json` 是下载页的数据源），但 **`*.apk` 排除在外**——
#   APK 一个就有 9MB，而服务器上已经有的不必重传（它们不走镜像，是
#   Caddy 从裸机目录发 `/dl/*` 的）。需要新的那份由「4b. APK 按需上传」单独 scp。
# ⚠️ `backend/dist` / `frontend/dist` **不再排除**（2026-10-07）：上面刚在本地构建好，
#    要随包发过去给镜像直接用（`.dockerignore` 里也对应放开了）。
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$LOCAL_TAR" \
  --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='.env.local' \
  --exclude='logs' \
  --exclude='.DS_Store' --exclude='._*' --exclude='backup*.dump' \
  --exclude='./android' \
  --exclude='./downloads/*.apk' \
  -C . .

if tar tzf "$LOCAL_TAR" | grep -qx '\./\.env'; then
  die '包里混进了 .env —— 会覆盖服务器上的密钥，已中止'
fi
for f in './package.json' './backend/src/server.ts' './docker-compose.prod.yml' './Caddyfile' './scripts/deploy.sh' './downloads/releases.json' \
         './backend/dist/server.js' './frontend/dist/index.html'; do
  if ! tar tzf "$LOCAL_TAR" | grep -qxF "$f"; then
    die "包里缺 $f —— 打包内容不对，已中止"
  fi
done
if tar tzf "$LOCAL_TAR" | grep -q '\.apk$'; then
  die '包里混进了 .apk —— 应该由「4b. APK 按需上传」单独传，已中止'
fi
ok "$(du -h "$LOCAL_TAR" | cut -f1) · $(tar tzf "$LOCAL_TAR" | wc -l | tr -d ' ') 项 · 已确认不含 .env · 含预构建产物"

LOCAL_MD5_TS="$(md5of backend/src/server.ts)"
LOCAL_MD5_DEPLOY="$(md5of scripts/deploy.sh)"

if (( DRY_RUN )); then
  c 'DRY RUN —— 不连服务器。真要执行的是：'
  printf '    scp %s %s@%s:%s\n' "$LOCAL_TAR" "$SSH_USER" "$HOST" "$REMOTE_TAR"
  printf '    ssh %s@%s  → 校验包 → 清空 %s（保留 .env / downloads）→ 解包 → md5 核对 → sudo PREBUILT=1 bash scripts/deploy.sh\n' \
    "$SSH_USER" "$HOST" "$APP_DIR"
  printf '    （APK 不在主包里，只把服务器上没有的那些单独 scp 到 %s）\n' "$REMOTE_APK_DIR"
  printf '    curl https://%s/api/health\n' "$DOMAIN"
  exit 0
fi

# ---------------------------------------------------------------- 2. SSH 可用性
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
# ⚠️ 必须写成 ${VAR}：macOS 自带的 bash 3.2 会把紧跟其后的**全角括号**当成
#    变量名的一部分（报 `HOST）: unbound variable`），加花括号才断得干净。
c "SSH 检查（${SSH_USER}@${HOST}）"
if ! ssh "${SSH_OPTS[@]}" -i "$KEY" "$SSH_USER@$HOST" true 2>/dev/null; then
  warn 'SSH 连不上：检查网络、密钥权限或端口 22。'
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

# ---------------------------------------------------------------- 4b. APK 按需上传
# 用户 2026-10-04：发布包一度 30M —— 大头是 downloads/ 里 3 个 APK 各 ~9MB（自托管字体
# 让 APK 从 4.1MB 涨到 9.1MB）。而这些 APK 不走镜像、是 Caddy 从裸机目录发 /dl/* 的，
# **服务器上已经有的不用重传**。所以主包排除了 *.apk，这里只挑缺的 / 大小对不上的。
# 判定用「文件名 + 字节数」：名字一样、大小一样就认为服务器上那份就是它。
c "APK 按需上传（本地 $(find downloads -maxdepth 1 -name '*.apk' 2>/dev/null | wc -l | tr -d ' ') 个）"
# find -printf 是 GNU find 的（服务器是 Linux，没问题）
SERVER_APKS="$(ssh "${SSH_OPTS[@]}" -i "$KEY" "$SSH_USER@$HOST" \
  "find '$APP_DIR/downloads' -maxdepth 1 -name '*.apk' -printf '%f %s\\n' 2>/dev/null" || true)"

UPLOAD_LIST=''   # 每行：文件名 字节数 md5
for f in downloads/*.apk; do
  [[ -f "$f" ]] || continue          # 没有 apk 时 glob 会原样返回，挡掉
  name="$(basename "$f")"
  size="$(wc -c < "$f" | tr -d ' ')"
  if printf '%s\n' "$SERVER_APKS" | grep -qxF "$name $size"; then
    ok "服务器上已有，跳过：$name"
  else
    UPLOAD_LIST="${UPLOAD_LIST}${name} ${size} $(md5of "$f")"$'\n'
  fi
done

if [[ -z "$UPLOAD_LIST" ]]; then
  ok '没有需要上传的 APK'
else
  ssh "${SSH_OPTS[@]}" -i "$KEY" "$SSH_USER@$HOST" \
    "rm -rf '$REMOTE_APK_DIR' && mkdir -p '$REMOTE_APK_DIR'"
  printf '%s' "$UPLOAD_LIST" > /tmp/ca-apk-manifest.txt
  scp -q -o BatchMode=yes -i "$KEY" /tmp/ca-apk-manifest.txt \
    "$SSH_USER@$HOST:$REMOTE_APK_DIR/MANIFEST"
  while read -r name size md5; do
    [[ -n "$name" ]] || continue
    scp -q -o BatchMode=yes -i "$KEY" "downloads/$name" \
      "$SSH_USER@$HOST:$REMOTE_APK_DIR/$name"
    ok "已传 ${name}（$(( size / 1048576 )) MB）"
  done <<< "$UPLOAD_LIST"
  rm -f /tmp/ca-apk-manifest.txt
fi

# ---------------------------------------------------------------- 5. 远端：检查 → 清旧 → 解包 → 核对 → 部署
c '远端执行（清旧 → 解包 → 核对 → scripts/deploy.sh）'
ssh "${SSH_OPTS[@]}" -i "$KEY" "$SSH_USER@$HOST" \
  "bash -s -- '$APP_DIR' '$REMOTE_TAR' '$LOCAL_MD5_TS' '$LOCAL_MD5_DEPLOY' '$REMOTE_APK_DIR' '1'" <<'REMOTE'
set -euo pipefail
APP_DIR="$1"; TAR="$2"; WANT_TS="$3"; WANT_DEPLOY="$4"; APK_STAGE="$5"
# 第 6 个参数：PREBUILT —— 包里有本机构建好的 backend/dist / frontend/dist，
# 让 compose 把 build-arg 传进 Dockerfile 跳过服务器上的编译（见上面「本机预构建」）。
PREBUILT="${6:-0}"

echo "==> 前置检查"
[[ -d "$APP_DIR" ]] || { echo "✗ $APP_DIR 不存在 —— 首次部署请按 docs/DEPLOY.md 手动走一遍" >&2; exit 1; }
# 服务器上的 .env 是 root:600（scripts/deploy.sh 建的），所以只能用 sudo 读
# ⚠️ 大模型配置（LLM_API_KEY）2026-10-04 起已经不放 .env 了 ——
#    Key 按用户存在数据库，网页「我的 → 模型配置」里填。
#    所以这里只检查 .env 存在（数据库账号密码还在里面）。
if ! sudo -n sh -c "test -s '$APP_DIR/.env'"; then
  echo "✗ $APP_DIR/.env 不存在 —— 首次部署请按 docs/DEPLOY.md「首次部署」手动走一遍" >&2
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

echo "==> 清掉旧文件（保留 .env / downloads）"
before=$(find "$APP_DIR" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
# 清之前先记下 Caddyfile 的指纹：它没变就不必重建 caddy 容器（见文件末尾）。
# 读不到（首次部署 / 权限）就当「变了」—— 重建是安全的那一边。
old_caddy=$(md5sum "$APP_DIR/Caddyfile" 2>/dev/null | cut -d' ' -f1 || true)
# tar 只覆盖、不删除：不清的话，本机删掉的 .ts 会残留并被 tsc 编进镜像
# ⚠️ 但这两项必须留着：
#   · .env      服务器上管的密钥，本机那份会盖掉
#   · downloads 它 bind mount 进了 caddy（./downloads:/srv/dl）。
#     把目录整个删了再建 = **目录 inode 换了**，容器里那个挂载还指着被删的旧 inode，
#     于是 /srv/dl 变成空目录 —— 线上 APK 直接 404（实测踩过）。
#     留着目录、让 tar 往里覆盖文件，挂载才不断。
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name .env ! -name downloads -exec rm -rf {} +
echo "    清掉 $before 项（保留 .env / downloads）"

echo "==> 解包"
# 不加 sudo：文件要归 ubuntu（root 所有会让下次更新解压失败）
tar xzf "$TAR" -C "$APP_DIR" --warning=no-unknown-keyword

echo "==> 核对内容与本机一致"
got_ts=$(md5sum "$APP_DIR/backend/src/server.ts" | cut -d' ' -f1)
got_deploy=$(md5sum "$APP_DIR/scripts/deploy.sh" | cut -d' ' -f1)
if [[ "$got_ts" != "$WANT_TS" ]]; then echo "✗ server.ts 不一致：$got_ts ≠ $WANT_TS" >&2; exit 1; fi
if [[ "$got_deploy" != "$WANT_DEPLOY" ]]; then echo "✗ scripts/deploy.sh 不一致" >&2; exit 1; fi
echo "    ✓ server.ts / scripts/deploy.sh 都与本机 md5 相同"

echo "==> 安装新 APK（如有）"
# 本机按需挑出来的那几个，已落在 ${APK_STAGE}（带一份 MANIFEST 写期望 md5）
if [[ -f "$APK_STAGE/MANIFEST" ]]; then
  while read -r name size md5; do
    [[ -n "$name" ]] || continue
    src="$APK_STAGE/$name"
    [[ -f "$src" ]] || { echo "✗ 没收到 $name" >&2; exit 1; }
    got=$(md5sum "$src" | cut -d' ' -f1)
    if [[ "$got" != "$md5" ]]; then
      echo "✗ ${name} md5 不符（${got} ≠ ${md5}）—— 传输坏了" >&2; exit 1
    fi
    # 先试直接 mv（downloads 目录正常是 ubuntu 的）；不行再 sudo
    mv "$src" "$APP_DIR/downloads/$name" 2>/dev/null \
      || sudo mv "$src" "$APP_DIR/downloads/$name"
    echo "    ✓ $name"
  done < "$APK_STAGE/MANIFEST"
  rm -rf "$APK_STAGE"
else
  echo "    （没有新的 APK）"
fi

echo "==> 跑 scripts/deploy.sh（构建镜像 + 起容器 + 自检）
    （PREBUILT=$PREBUILT：包里已带本机构建好的产物，服务器跳过 tsc + vite）"
cd "$APP_DIR"
sudo PREBUILT="$PREBUILT" bash scripts/deploy.sh

# Caddyfile 是 bind mount 的**单个文件**：内容变了 compose 看不出来，`up -d` 不会重建容器，
# 而 Caddy 只在启动时读一次配置 —— 不重建的话改了等于没改。
# 证书在命名卷 ca-caddy-data 里，重建不会重新申请。
# 2026-10-07：改成**只在真的变了时**才重建 —— 每次无脑 `--force-recreate caddy`
# 要多花十几秒（容器重起 + 等它监听 443），而绝大多数发布根本没碰 Caddyfile。
new_caddy=$(md5sum "$APP_DIR/Caddyfile" | cut -d' ' -f1)
if [[ -n "$old_caddy" && "$old_caddy" == "$new_caddy" ]]; then
  echo "==> Caddyfile 没变，跳过重建 caddy"
else
  echo "==> 重建 caddy（Caddyfile 变了，靠这一步生效）"
  sudo docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
fi
REMOTE

# ---------------------------------------------------------------- 6. 公网验收
c '公网验收'
# ⚠️ 这里**必须重试**，别一次 curl 就判死。
#    2026-10-07 实测踩过：caddy 刚被 force-recreate，第一次 curl 撞在
#    「容器还在起 / 443 还没监听」的空窗上 ⇒ 脚本 exit 1，但 6 秒后就是 200
#    —— 假警报比真故障更浪费时间（还得再查一遍才知道是假的）。
ATTEMPTS=8
for (( i = 1; i <= ATTEMPTS; i++ )); do
  if curl -fsS --max-time 25 "https://$DOMAIN/api/health" > /tmp/ca-health.remote.json 2>/dev/null; then
    break
  fi
  if (( i < ATTEMPTS )); then
    warn "第 $i 次没通（容器可能还在起），3 秒后再试"
    sleep 3
  fi
done

if [[ -s /tmp/ca-health.remote.json ]]; then
  head -c 300 /tmp/ca-health.remote.json; echo
  if grep -q '"ok":true' /tmp/ca-health.remote.json; then
    ok "线上正常：https://$DOMAIN"
    exit 0
  fi
  warn 'health 返回了，但 ok 不是 true（看上面远端输出里的数据库提示）'
  exit 1
fi
warn "https://$DOMAIN/api/health 试了 $ATTEMPTS 次都没通："
printf '      curl -s https://%s/api/health\n' "$DOMAIN"
printf '      看日志：ssh -i %s %s@%s "cd %s && sudo docker compose -f docker-compose.prod.yml logs --tail=80 app"\n' \
  "$KEY" "$SSH_USER" "$HOST" "$APP_DIR"
exit 1
