# 线上部署

**线上地址：<https://bitcoooin.cn>**

```text
服务器   52.194.6.144（用户 ubuntu）
密钥     ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem
代码     /opt/crypto-advisor
域名     bitcoooin.cn（A 记录已指向该 IP，NS 在阿里云）
机器     Ubuntu 24.04 / 2 核 / 2GB 内存 / 60G 盘（2026-10-07 由 909MB / 36G 升档）
```

一台 AWS Lightsail（东京）+ Docker Compose，**宿主机除了 Docker 什么都不用装**：

```
   浏览器
     │ HTTPS (443)
     ▼
  ┌────────────────┐            ┌────────────────────────┐
  │ Caddy 容器     │  app:8787  │ Node 容器              │
  │ 反代 + 自动证书 │ ─────────▶ │ ├─ /api/*   后端接口   │
  └────────────────┘            │ └─ /*       前端静态产物│
                                └───────────┬────────────┘
                                            │
                                ┌───────────▼────────────┐
                                │ PostgreSQL 容器         │
                                └────────────────────────┘

  三个容器都在 docker-compose.prod.yml 里，一条命令起。
  出网依赖：fapi.binance.com（行情）· api.deepseek.com（模型）
```

三条要记住的：

- **只有一个 Node 进程**：`backend/src/server.ts` 同时提供 API 和 `frontend/dist`
  静态文件。`NODE_ENV=production` 时它会跳过 Vite，只托管已构建产物，
  所以线上**不需要装 vite / tsx**（镜像里 `npm ci --omit=dev` 就够）。
- **提示词在代码里**（`backend/src/llm/prompts.ts` 的 `PREDICT_PROMPT` / `EXTRACT_PROMPT`）。
  2026-10-04 从数据库搬过来的 —— 改提示词要改代码 + 重新部署（见下面「后续更新」）。
  老表 `ai_docs` / `ai_doc_versions` 没删，程序不再读写它；想退回数据库那套，
  正文按 id 捞：predict = 9、extract = 7。
- 进程崩了由 Docker 自己拉起（`restart: unless-stopped`），**不需要 pm2**。

---

## 首次部署

搬到新机器就按这几步走。

### 先验网络前提（不通就白搭）

服务器必须能出网访问：

```bash
curl -s -o /dev/null -w 'binance %{http_code}\n' https://fapi.binance.com/fapi/v1/ping
curl -s -o /dev/null -w 'deepseek %{http_code}\n' https://api.deepseek.com/user/balance
```

期望：`binance 200`、`deepseek 401`（401 = 通了但没带 Key，正确）。

⚠️ **国内机房访问 Binance 基本不通**。这条不通就换海外节点，不要往下做。

### 1. 把代码传上去

**用 tar + scp，不要用 rsync** —— macOS 自带的是 openrsync（protocol 29），
和服务器上的 rsync 3.x 兼容性没保证。

```bash
# 本机
cd /Users/nexta1/Documents/预测
tar czf /tmp/ca.tgz --exclude='node_modules' --exclude='.git' --exclude='.env' \
  --exclude='backend/dist' --exclude='frontend/dist' --exclude='logs' \
  --exclude='./android' --exclude='./downloads/*.apk' -C . .

scp -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem /tmp/ca.tgz \
  ubuntu@52.194.6.144:/tmp/

# 服务器（⚠️ 必须先 chown 成 ubuntu：`sudo mkdir` 建出来是 root 所有，
#   而 scripts/release.sh 是**非 sudo** 解包 —— 文件得归 ubuntu，不 chown 后面会解压失败）
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@52.194.6.144 \
  'sudo mkdir -p /opt/crypto-advisor && sudo chown ubuntu:ubuntu /opt/crypto-advisor \
   && cd /opt/crypto-advisor && tar xzf /tmp/ca.tgz'
```

包 5MB 左右（大头是自托管字体 `frontend/public/fonts/`）。

> 💡 **APK 不在这条 tar 里**（一个就 9MB，而且服务器上已经有的不必重传）。
> 首次部署想让 `/dl/*` 有东西可下，把 `downloads/*.apk` 单独 `scp` 到
> `/opt/crypto-advisor/downloads/`；之后就交给 `bash scripts/release.sh`（它会按需补传）。

> 💡 只是**更新**的话，不用做这一步 —— 直接 `bash scripts/release.sh` 一条命令。
> 这一步只在**全新机器 / APP_DIR 还不存在**时做（`scripts/release.sh` 检测到目录不在会提示你回来）。

> ⚠️ **一定排除 `.env`**。服务器上的 `.env` 是「在服务器上管」的：里面有随机化过的
> `PGPASSWORD`。用本机的 `.env` 覆盖它，会让**应用连不上数据库**（密码与 db 容器里
> 那个对不上）。首次部署时 `.env` 不存在，`scripts/deploy.sh` 会从 `.env.example` 生成一份，
> 并把 `PGPASSWORD` 换成随机值。

### 2. 一键部署

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@52.194.6.144
cd /opt/crypto-advisor
sudo bash scripts/deploy.sh
```

`scripts/deploy.sh` 幂等，按顺序做：

1. 内存 < 1.9G 就加 2GB swap（现在的 2GB 档够用、不加；老 909MB 机器**必须加**，否则 Postgres / Node 容易被 OOM 杀）
2. 没装 Docker 就装
3. `.env` 不存在就从 `.env.example` 生成；
   `PGPASSWORD` 还是默认值就**换成随机密码**
   （大模型 Key 不再放进 `.env` —— 首次启动会自动把旧 `.env` 里的那份搬到管理员账号）
4. 用官方镜像**校验 `Caddyfile` 语法**（语法错的话 https 打不开，日志要翻半天才看出来）
5. `up -d --build` 起三个容器
6. 自检 `http://127.0.0.1:8787/api/health` —— **HTTP 状态一直是 200，要看里面的 `ok` 字段**
   （`ok` 反映数据库通不通）；数据库不通时提示去翻 db 容器的日志

`.env` 里要关心的几项：

| 变量         | 说明                                                     |
| ------------ | -------------------------------------------------------- |
| `PGPASSWORD` | 别用默认的 `ca_local_dev`，`.env` 与 db 容器共用同一个值 |
| `USD_CNY`    | 展示用汇率                                               |
| `API_BASE`   | **留空**。只有交易所默认域名不可达时才覆盖               |

> 🔑 **大模型配置不在 `.env` 里**（2026-10-04 起）：Key / 接口地址 / 模型 / 思考力度
> 按用户存数据库，在网页「我的 → 个人信息 → 模型配置」里填。
> 首次启动会把服务器旧 `.env` 里的 `LLM_API_KEY` 那几行**自动搬到管理员账号**，
> 之后那几行删掉也不影响。
>
> 👤 **管理员账号**：代码里**不再内置默认密码**（原先的 `admin` / `123456`
> 已删除 —— 仓库是公开的，写在源码里等于把后台钥匙挂在门上）。
> 管理员账号（用户名 + 密码哈希）随**本地数据库同步**一起上来，
> 见下面「迁移数据」—— 部署流程里不需要任何「初始密码」。

不用写 `PGHOST` / `PGPORT` 指向线上 —— compose 里已经用 `environment` 覆盖成 `db`。

> ⚠️ 如果 `.env` 不存在就 `up`，Docker 会因为 bind mount 建出一个叫 `.env` 的**目录**，
> 之后启动必失败。补救：`down` → `rm -rf .env` → `cp .env.example .env` → 再 `up`。

### 3. 放行 80 / 443

**Lightsail → 实例 → Networking → IPv4 Firewall**：确认有 `SSH 22`、`HTTP 80`、`HTTPS 443`。

域名写在 `Caddyfile`（Caddy 在 compose 里，用服务名 `app` 访问上游）：

```caddyfile
bitcoooin.cn {
	encode gzip zstd
	reverse_proxy app:8787 {
		flush_interval -1   # SSE 立刻 flush，否则「分析过程」会憋到跑完才显示
	}
}
```

证书由 Caddy 自动申请，存在 `ca-caddy-data` 卷里，重建容器不会重复申请：

```bash
docker compose -f docker-compose.prod.yml logs -f caddy   # 等 certificate obtained successfully
```

> ⚠️ **证书签下来 ≠ https 能用**。这台机器当时只开了 80，Caddy 走 `tls-alpn-01`（要 443）
> 失败后自动降级 `http-01`（走 80）**把证书签成功了** —— 但外面照样连不上 443。
> **证书 + 端口两样都要看。** 续期 Caddy 自动做，不用 cron。

### 4. 同步数据库（本地 → 服务器，**整份覆盖**）

建表是自动的（`ensureSchema()` 幂等跑），但**表里是空的** ——
账号、标签模板、案例库、历史都要靠这一步从本机搬过去。
⚠️ **提示词不用管**（2026-10-04 起在代码里，见 `backend/src/llm/prompts.ts`）。
**管理员账号就在 dump 的 `users` 表里**，所以代码里不需要任何初始密码 ——
登录用的就是你本机那个密码。

> ⚠️ 这是**覆盖式**：服务器上现有数据（线上跑出来的预测历史、知识库、用量）
> 会被本地这份**完全替换**，不可撤销。第 ③ 步开头会先把服务器现值备份一份，能回滚。

```bash
# ① 本机：导出
cd /Users/nexta1/Documents/预测
docker exec ca-postgres pg_dump -U ca -d crypto_advisor -Fc > /tmp/ca.dump
ls -lh /tmp/ca.dump

# ② 传上去
scp -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem /tmp/ca.dump \
  ubuntu@52.194.6.144:/tmp/

# ③ 服务器：先备份「现在这份」，再整份替换
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@52.194.6.144
cd /opt/crypto-advisor
sudo docker compose -f docker-compose.prod.yml stop app
sudo docker exec ca-postgres pg_dump -U ca -d crypto_advisor -Fc \
  > ~/server-db-before-$(date +%F-%H%M).dump        # ← 回滚用，先留着
sudo docker compose -f docker-compose.prod.yml exec -T db \
  psql -U ca -d postgres -c 'DROP DATABASE IF EXISTS crypto_advisor'
sudo docker compose -f docker-compose.prod.yml exec -T db \
  psql -U ca -d postgres -c 'CREATE DATABASE crypto_advisor OWNER ca'
sudo docker cp /tmp/ca.dump ca-postgres:/tmp/ca.dump
sudo docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U ca -d crypto_advisor --no-owner --disable-triggers /tmp/ca.dump
sudo docker compose -f docker-compose.prod.yml start app
curl -s localhost:8787/api/health
```

关键点：

- **必须 `DROP/CREATE DATABASE`，不能只 `--data-only`**：库里已有数据时 `--data-only`
  会撞主键重复。整份覆盖只能重建库。
- 全量 `pg_restore`（**不带** `--data-only`）连表结构一起还原；
  启动时 `ensureSchema()` 是幂等的，会把 dump 之后新增的表/列补上。
- **回滚**：
  `sudo docker exec -i ca-postgres pg_restore -U ca -d crypto_advisor --clean --if-exists --no-owner ~/server-db-before-*.dump`

### 5. 验收

```bash
# 服务器上先看内部链路
curl -s localhost:8787/api/health     # 期望 "ok":true（= 数据库通）；false 就先查 db 容器

# 本机（走公网）验收
curl -s -o /dev/null -w 'https %{http_code}\n' https://bitcoooin.cn/api/health
curl -s -o /dev/null -w 'http  %{http_code}\n' http://bitcoooin.cn/api/health   # 应 308 → https
```

浏览器打开 `https://bitcoooin.cn`，然后：

1. `/` 页跑一次分析 —— 有结论、有标签概率、能过。
2. `/api/health` 里 `rules.sources` 是 `["分析预测（代码内置）"]`、`systemChars` ≈ 3415。
3. `/history` 能翻到记录。
4. 顶部余额徽标点一下能刷新（说明出网到 DeepSeek 正常）。

---

## 服务器上的那个转发代理（`tinyproxy`，2026-10-05）

服务器上多装了一个 **`tinyproxy`**，只为**本地开发**用：让本机的 dev server 从
服务器 IP 出网（币安 API Key 的 IP 白名单里只有这个 IP，本机出口 IP 会变）。

```
dev server --HTTP CONNECT--> 127.0.0.1:8888 --(ssh -L)--> 服务器 127.0.0.1:8888 --> fapi.binance.com
```

- **只 `Listen 127.0.0.1`** ⇒ 公网扫不到、**不用开 Lightsail 规则**、也不需要 BasicAuth；
  够得着的只有能 SSH 进来的人。配置在 `/etc/tinyproxy/tinyproxy.conf`
  （原文件备份成 `tinyproxy.conf.orig`），`ConnectPort` 只放 443 / 80。
- 它**跟线上应用无关**：容器里的应用是直连出网的，不经过它。想彻底停掉：
  `sudo systemctl disable --now tinyproxy`（本机开发会退回 `-2015`）。
- 本机用法见 `scripts/dev-proxy.sh`（`--check` 体检 / 不给参数就开隧道），
  然后 `EXCHANGE_PROXY=http://127.0.0.1:8888 npm run web`。

> ⚠️ 为什么不是 `HTTPS_PROXY` + `NODE_USE_ENV_PROXY`：ccxt 会自己塞一个直连 dispatcher
> 把环境变量代理整条绕过 —— 细节在 `docs/EXCHANGE.md` 的「本地开发」第 ④ 条。

---

## 后续更新

> ### 🛑 发布只能由用户**手工命令**（2026-10-07 用户明确要求）
>
> **任何助手 / 自动化都不要自己跑 `scripts/release.sh`**（`-y` 更不行），
> 也不要 ssh 过去手动 `deploy.sh` / `docker compose restart app`。
> 助手只做到「**改完 → 本地验证 → commit → push**」，然后**停下等用户说「上线」**。
> 发布是个有副作用的动作（重建镜像 + 重启容器 + 清 `/opt` 旧文件），
> 必须由人按下。

**更新 = 本机提交 → 打包 → 上传 → 服务器上重跑 `scripts/deploy.sh`**。
在本机跑一条命令就行（**不用 `git pull`**：tar 把工作区直接搬过去）：

```bash
cd /Users/nexta1/Documents/预测
bash scripts/release.sh            # 会问一句确认；加 -y 不问，加 --dry-run 只看不发
```

`scripts/release.sh` 按顺序做：**先要求工作区已提交**（有未提交改动直接停，加 `--no-check` 可跳过）
→ `tsc` 类型检查 → **本机预构建**（`npm run build:all`，见下面「为什么先在本地编译」）
→ 打包（排除 `.env` / `android` / `*.apk`，并断言包里确实没有 `.env`、确实**有**那两个
`dist`）→ 检查 SSH（连不上就停住并提示）→ `scp` 上传主包 → **按需补传 APK**
（服务器上已有同名同大小的不传）→ 远端「校验包 → 清空旧文件（保留 `.env` / `downloads`）
→ 解包 → md5 与本机核对 → `sudo PREBUILT=1 bash scripts/deploy.sh`
→ **Caddyfile 真的变了才**重建 caddy」→ 最后 `curl https://bitcoooin.cn/api/health` 验收
（**失败会重试 8 次 × 3 秒**，别被 caddy 刚重启的空窗骗了）。**任一步失败就停住**，
不会留下半个部署。

### 为什么先在本地编译（`PREBUILT=1`）

2026-10-07 实测了一次发布：整趟 **5 分 12 秒**，其中**服务器上构建镜像 ≈182 秒**，
而里面 `RUN npm run build:all` 一项就是 **111 秒**（`tsc` ≈31 秒 + `vite build` ≈51 秒，
777 个模块）—— 那台机器只有 **2 核**，而这一步在你的 Mac 上只要几秒。

所以现在的流程改成：**本机 build → 产物随包发过去 → 镜像里跳过编译**。

- `scripts/release.sh` 在打包前跑 `npm run build:all`，把 `backend/dist` + `frontend/dist`
  打进 tar（`tar` 与 `.dockerignore` 里都**不再排除**这两个目录）
- `docker-compose.prod.yml` 把 `PREBUILT` 作为 build-arg 传给 `Dockerfile`
- `Dockerfile`：`PREBUILT=1` **且**两个产物都在且非空 ⇒ 跳过 `build:all`；
  否则**自动退回**源码编译（宁可慢，也不要「半个旧产物」的镜像）
- 手工在服务器上 `sudo bash scripts/deploy.sh`（不带 `PREBUILT`）＝ 老行为：服务器上编译

⚠️ 万一包里的产物有问题，最直接的兜底：`sudo PREBUILT=0 bash scripts/deploy.sh`。

先分清哪一类改动：

- **要重新 build 镜像的**（走上面这套）：后端 / 前端源码、`Dockerfile`、
  `docker-compose.prod.yml`、`Caddyfile`、`config/calibers.yaml`、`data/`、
  **`backend/src/llm/prompts.ts`（提示词）**
- **不用更新**：账号 / 标签模板 / 案例库（都在数据库里，网页上改即时生效）
- **在服务器上改的**：`.env`（只剩 `PGPASSWORD` / 汇率这些）—— 服务器上直接编辑后
  `restart app`，**别**拿本机那份覆盖

### ⚠️ 三条不能忘（`scripts/release.sh` 已经帮你挡住了）

- **`--exclude='.env'` 不能漏**：服务器 `.env` 里有随机化过的 `PGPASSWORD`，被本机那份
  覆盖就再也连不上数据库（日志里是「⚠️ 数据库不可用」）。真碰上了：
  `sudo docker inspect ca-postgres` 查环境变量里的真实密码，改回 `.env`。
- **`downloads` 目录必须留着**：它 bind mount 进了 caddy（`./downloads:/srv/dl`）。
  把目录整个删了再建，**目录 inode 就换了**，容器里那个挂载还指着被删的旧 inode ——
  `/srv/dl` 变成空目录，线上 APK 直接 404（实测踩过）。留着目录、让 tar 往里覆盖文件即可。
- **`Caddyfile` 改了要重建 caddy 容器**：它是 bind mount 的**单个文件**，内容变了
  compose 看不出来，`up -d` 不会重建，而 Caddy 只在启动时读一次配置 —— 不重建等于没改。
  （证书在命名卷 `ca-caddy-data` 里，重建不会重新申请。）
  ⚠️ 2026-10-07 起这一步**只在 Caddyfile 的 md5 真的变了**时才做（release.sh 比对了
  解包前后的指纹）—— 每次无脑 `--force-recreate caddy` 要多花十几秒，而绝大多数发布
  根本没碰它。**在服务器上手工编辑 Caddyfile 之后，记得自己 recreate 一次**。

> 💡 为什么要「先清一遍旧文件」：`tar xzf` 只覆盖同名文件、**不会删除**本机已经删掉的
> 文件；残留的旧 `.ts` 会被 `tsc` 一起编进镜像（还 import 已删模块的话直接构建失败）。
> 数据库在命名卷 `ca-pgdata` 里，删目录不动数据。

---

## 静态下载（`/dl/`）与「下载」页

### `/download` 页

站内有一个独立路由 **`https://bitcoooin.cn/download`**，列出所有历史安装包 +
介绍 + 更新说明。顶栏/底栏那颗「下载」就是它。

数据来自后端 **`/api/downloads`**，它做两件事：

1. 扫 `downloads/` 目录里真实的 `*.apk`（大小 / 时间 / **md5** 都现算，md5 按
   「大小 + mtime」缓存）；
2. 把同级手写的 **`downloads/releases.json`** 合进来 —— 那里面写「这一版叫什么、
   改了啥、什么时候发的」。

所以**加一版新包只要两步**：`bash scripts/build-apk.sh`（自动把 APK 放进
`downloads/`）→ 在 `downloads/releases.json` 里补一条 →
`bash scripts/release.sh -y`。页面不用改代码。没登记的 APK 也会列出来，标「未登记」。

> `releases.json` 里的 `app` 段是整页的介绍文案（名称 / 包名 / 说明 / 安装步骤）；
> `releases[]` 每条对应一个版本（`version` / `file` / `date` / `title` / `notes`）。

### `/dl/*` 文件分发

`downloads/` 里的文件由 Caddy 直接发出去（**不走应用**），链接形如：

```
https://bitcoooin.cn/dl/entry-advisor-0.1.0.apk
```

- `Caddyfile`：`handle_path /dl/* { root * /srv/dl; file_server }`
- `docker-compose.prod.yml`：给 **caddy** 挂了 `./downloads:/srv/dl:ro`
- `docker-compose.prod.yml`：给 **app** 也挂了同一个目录 `./downloads:/app/downloads:ro`
  —— `/api/downloads` 要读里面的真实文件（大小 / md5）才能列出清单。
  ⚠️ **两边必须指向同一个宿主机目录**，否则页面上列的和实际能下的对不上。
  ⚠️ `downloads/` **不 COPY 进镜像**（`.dockerignore` 排掉了）——
  换 APK 只传文件，不用重新构建镜像层。

换文件时一起传上去：

```bash
bash scripts/build-apk.sh        # 顺带把新 APK 放进 downloads/（并在 releases.json 里补一条）
bash scripts/release.sh -y       # 打包上传（Caddyfile 没变就不会重建 caddy —— APK 只是文件）
```

> 💭 本地 `npm run web` 也能下：线上 `/dl/*` 是 Caddy 发的，本地没有 Caddy，
> 后端 `serveDownload()` 会自己发一份（`backend/src/server.ts`）。效果一样，
> 所以 `/download` 页在本机就能完整验收。

⚠️ 第一次加这个挂载**必须重建 caddy**，否则容器里没有 `/srv/dl`。
现在这一步是**改了 Caddyfile 才会**触发（release.sh 比对解包前后的 md5）——
所以「只是为了换 APK」的发布不用重建 caddy，文件是 bind mount 的、立刻生效。

## 常用命令

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@52.194.6.144
cd /opt/crypto-advisor

sudo docker compose -f docker-compose.prod.yml ps             # 状态
sudo docker compose -f docker-compose.prod.yml logs -f app     # 应用日志
sudo docker compose -f docker-compose.prod.yml logs -f caddy   # 访问日志 + 证书
sudo docker compose -f docker-compose.prod.yml restart app     # 重启应用
curl -s localhost:8787/api/health                             # 健康检查

# 备份数据库（建议挂 cron，每天一次）
sudo docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U ca -d crypto_advisor -Fc > backup-$(date +%F).dump

# 进 psql
sudo docker compose -f docker-compose.prod.yml exec db psql -U ca -d crypto_advisor
```

崩了按这个顺序查：

```bash
sudo docker compose -f docker-compose.prod.yml ps                    # ① 反复重启？STATUS 里 unhealthy = 数据库不通
sudo docker compose -f docker-compose.prod.yml logs --tail=200 app   # ② 退出原因（最关键）
sudo docker inspect ca-app --format '{{.State.OOMKilled}}'           # ③ 是否被 OOM 杀
dmesg | grep -i 'killed process' | tail -5                           #    内存不够是头号死因
sudo docker stats --no-stream                                        # ④ 资源占用
sudo docker compose -f docker-compose.prod.yml up -d                 # ⑤ 重启
```

## 换机器（换更大的 bundle：$5 → $12）

> **状态：2026-10-07 已执行完毕**（2GB / 60G，静态 IP 没变，域名与证书都没动）。
> 回头看这套流程是有效的，实测结论见本节末尾「本次实测」。
>
> 2026-10-07 起因：量下来 CPU 很闲（PSI `cpu full = 0%`）、**内存紧**（909MB，swap 已用 268MB）、
> **磁盘 I/O 是瓶颈**（PSI `io full avg10 ≈ 37%`、`wa ≈ 39`、PG `buffers_backend` 418 万 ⇒
> `shared_buffers` 64MB 太小）。带宽根本不是事：`ca-app` 实测 入 3.4MB/分 + 出 2.0MB/分
> ≈ **233GB/月**，连旧档的 2TB 都只用了 12%，**别为传输加钱**。
> 所以换机器买的是「**内存**」，CPU（2 vCPU）不用加。

⚠️ Lightsail **不能原地换 bundle**，标准做法就是「**快照 → 用快照建新实例（选大计划）→ 把静态 IP 挪过去**」。
静态 IP 是**独立资源**，可以 detach/attach ⇒ **域名不用改、TLS 证书不用重签**（证书在卷 `ca-caddy-data` 里，
快照里就有）；`scripts/release.sh` / `scripts/sync-candles.sh` 里写死的 `52.194.6.144` 也**不用动**。

### 步骤（控制台那几步我做不了，命令行的我来）

0. **先清一手**（可选，让快照小 8GB）：`sudo docker builder prune -f`
1. **快照**：控制台 → 实例 → 「快照」→ 创建。
   * 想绝对干净：先 `sudo docker compose -f docker-compose.prod.yml stop`（停机 = 快照那几分钟），快照完再 `up -d`；
   * 图省事就直接快照（相当于崩溃一致性快照，**Postgres 会自己恢复**，正常都没事）。
2. **用快照建新实例**：控制台 → 创建实例 → **区域必须选东京（跟现在一致）** → 「从快照」→ 选刚那台
   → 计划选 **$12（2GB / 2vCPU / 60GB / 3TB）** → AZ 尽量跟现在这台一致。
   **先不要动静态 IP**（新实例先用它自己的动态公网 IP）。
3. **在新实例上验收**（用它的动态 IP ssh 进去）：
   ```bash
   sudo docker compose -f docker-compose.prod.yml ps      # 三个都 Up/healthy
   curl -s localhost:8787/api/health                      # {"ok":true,...}
   df -h /                                                # ← 看是不是 60GB
   ```
   ⚠️ 磁盘**不用手扩**：Lightsail 用快照建新实例时会按新计划把分区一起放大（实测 38G → **58G**，36% 已用）。
   万一没自动扩再来一刀：`sudo growpart /dev/xvda 1 && sudo resize2fs /dev/xvda1`
   （NVMe 机型是 `/dev/nvme0n1`，先用 `lsblk` 看一眼）。
   顺带核一下防火墙（22 / 80 / 443 三条，从快照建的实例一般会带过来，但**要亲眼看一下**）。
4. **切静态 IP**：控制台 → 网络 → 静态 IP → 先从**旧**实例 detach → 再 attach 到**新**实例。
   （切换期间几十秒不可用。）然后本机 `curl https://bitcoooin.cn/api/health` 验收。
5. **旧实例 stop**（先别删，留几天当后悔药）→ 稳定后再 delete；顺手删掉旧快照（快照按 GB 计费）。
6. **按新内存调 PG**（我这边改 `docker-compose.prod.yml` 的 db `command`，再 `npm run release` 生效，
   重建 db 容器 ≈ 几秒）：`shared_buffers` 64MB → **384MB**、`effective_cache_size` 4GB（错值）→ **1536MB**。
   这才是治 `io full` 的那一刀：内存翻倍 → 页面缓存能住下更多 5.3GB 的库 → 少读盘。
7. 收尾：`sudo docker builder prune -f`（快照会把这 9GB 构建缓存一起搬过来）、
   `/opt/crypto-advisor/.env` 在不在（快照里有，PGPASSWORD 必须跟 pgdata 匹配）。

### 本次实测（2026-10-07，2GB / 60G）

| 项 | 迁移前 909MB 档 | 迁移后 2GB 档 |
| --- | --- | --- |
| 内存 / swap | 909MB，swap 已用 268MB | 1906MB，swap 已用 40MB（available 849MB） |
| 磁盘 | 38G / 36G 用满风险 | 58G，prune 后 13G 用（22%） |
| `buffers_backend`（PG 后端自己刷的缓冲） | 4.18M | 3.0 万（↓ 99%+） |
| PSI `io full avg10` | ≈ 37%（`wa`≈39） | 29%（开机 9 分钟内，含 rollup 追赶） |
| PSI `cpu full` | 0% | 0% |
| 证书 | Let's Encrypt | **没重签**（`ca-caddy-data` 卷跟着快照过来了） |
| `.env` / `downloads/` / `tinyproxy` | — | 全在，`tinyproxy` 仍是 active（本地开发的隧道照旧可用） |
| candles | — | 1m 落后 ~2 分（ws 实时）、5m/15m/1h/4h/1d 全部追平（各周期最新一根都是「当前还没收的那根」的上一根） |

换算下来这次花的钱全在「内存」上：`shared_buffers` 涨 6 倍 + 宿主机页面缓存翻倍，
把原来那一刀磁盘 I/O 直接压下去；`docker builder prune` 一次回收 **8.66GB** 构建缓存 + 156MB 悬空镜像。
