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
- **提示词在数据库里**（`ai_docs`，`kind=predict`）—— 网页「我的 → AI 提示词」改，
  即时生效（每次分析都重新读库，**不用重启、不用重新部署**）。
  库里是**一份份拼的**：一份正文（判断依据）+ 一份「# 输出」（语气），按 `sort` 拼。
  代码里只剩**语气预设表**（`backend/src/llm/tone-presets.ts`）：启动时把库里缺的那几份补上
  （补出来是**关着**的，绝不覆盖已有的），所以改预设要改代码 + 重新部署。
  ⚠️ **本机改的提示词不会自己上去** —— 要按下面「提示词怎么同步到线上」把两张表搬过去。
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
5. 构建镜像（`docker compose -f docker-compose.prod.yml build app`）——
   本机预构建产物随包带过来，`PREBUILT=1` 让服务器跳过 tsc + vite
6. `up -d` 起三个容器
7. 自检 `http://127.0.0.1:8787/api/health` —— **HTTP 状态一直是 200，要看里面的 `ok` 字段**
   （`ok` 反映数据库通不通）；数据库不通时提示去翻 db 容器的日志

> 发布**不再跑 candles 分区迁移/维护**（2026-10-09 取消，见下面那节）。分区的新建与过期清理
> 由应用自己负责（启动时 + 每小时一次）。
>
> 镜像更新本身仍会重建单个 app 容器，期间可能短暂断开行情 WS；重连后 K 线底座会立即扫描并
> 回补缺口（见 [EXCHANGE.md](./EXCHANGE.md) 的 K 线底座说明）。需要彻底避免部署期间断流，
> 仍需把行情录制器拆成独立常驻服务，或采用双实例切换；这次改动不宣称零停机。

`.env` 里要关心的几项：

| 变量         | 说明                                                     |
| ------------ | -------------------------------------------------------- |
| `PGPASSWORD` | 别用默认的 `ca_local_dev`，`.env` 与 db 容器共用同一个值 |
| `USD_CNY`    | 展示用汇率                                               |
| `API_BASE`   | **留空**。只有交易所默认域名不可达时才覆盖               |

> 🔑 **大模型配置不在 `.env` 里**（2026-10-04 起）：Key / 接口地址 / 模型 / 思考力度
> 按用户存数据库，在网页「我的 → 模型配置 → 密钥配置」里填
> （★ 2026-10-12：「模型配置」从「个人信息」里搬出来成一级 tab，里面 密钥配置 / 用量统计 / AI 提示词 三段）。
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

## 代理订阅（梯子）与「管理 → 代理订阅」页（2026-10-12）

服务器上除应用外还跑着一个**自用梯子**（VLESS + REALITY）。每个人一个独立 UUID、
一条带 BasicAuth 的订阅地址；现在**在应用的「我的 → 管理 → 代理订阅」里点点鼠标就能
加人 / 停用 / 换密码**，不用再 SSH 上去跑脚本。

### 四块东西，各管一段

```
浏览器/Clash ──443/TCP──> xray (REALITY, 宿主机 systemd)
                            │  认得 REALITY 握手 → 当代理用
                            └─ 不认得（普通浏览器）→ 原样回落给 dest
                                                     ↓
                                          127.0.0.1:8444 ─> ca-caddy (容器)

Clash 拉订阅 ──https://bitcoooin.cn/sub/clash──> xray ─回落─> caddy ─/sub/*─> 172.17.0.1:2096
                                                                              (sub_server.py, BasicAuth)

应用「代理订阅」页 ──容器内──> host.docker.internal:2097 (xrayd, 令牌鉴权)
                                    └─ 写 users.json + 重建 xray clients + 重启 xray
```

| 位置 | 干什么 |
|---|---|
| `/usr/local/etc/xray/config.json` + `xray.service` | 梯子真身。**443**，REALITY，`dest=127.0.0.1:8444`（就是本机的 Caddy）、`serverNames=["bitcoooin.cn"]` —— 伪装目标就是你自己那个真网站，探测者看到的是一张真的 Let's Encrypt 证书 |
| `/opt/sub_server.py` + `subscription.service` | 订阅服务。**只监听 docker0 网关 `172.17.0.1:2096`**，公网连不上；BasicAuth 凭据只在 `users.json` 里存 PBKDF2 哈希；`/clash` 发 Clash 配置、`/vless` 发单节点链接，其它路径一律 404（旧版 `GET /` 会把密钥回显出去，等于白送节点） |
| `/opt/xrayd.py` + `xrayd.service` | **唯一动 xray 配置的地方**（root）。只监听 `172.17.0.1:2097` + `X-Admin-Token`（`/etc/xrayd-token`，root 600）。接口只有三个：`GET /health`、`GET /users`、`PUT /users`（**整体覆盖**，天然不漂移） |
| `/usr/local/bin/xray-user` | 命令行前端，调上面的 xrayd。`list` / `add <名字> [密码]` / `del` / `passwd` / `link` / `sync` |

**Caddy 那边**（`docker-compose.prod.yml`）：`443` 让给了 xray，所以 caddy 只留
`'80:80'` + `'127.0.0.1:8444:443'` + `'443:443/udp'`（HTTP/3 走 UDP，不经 xray）。
路由 `handle_path /sub/*` 写在**服务器上的** `/opt/crypto-advisor/Caddyfile`
（这份是权威版本，`release.sh` 已排除它，仓库里那份不参与发布）。

### 应用侧

- 表 `proxy_users`（`backend/src/db/schema.ts`）是**权威副本**：名字 / uuid / 订阅密码 /
  是否启用。密码明文存 —— 和 `user_llm_keys` 同一个口径（只有管理员读得到），
  因为订阅地址要能**反复复制**给朋友，只存哈希就再也显示不出来了。
- 每次改动都会把**整份列表**下发给 xrayd（`backend/src/proxy.ts`）。下发失败不会假装成功：
  接口会明确告诉你「已存库、下发失败」，页面顶部也会出现不一致提示 + 「同步」按钮。
- **第一次打开这一页会自动把宿主机上已有的用户导入进来（uuid 原样保留）**，
  免得任何一次下发把现成的节点抹掉；导入后页面上的订阅地址立刻就能用。
- 需要 `XRAYD_TOKEN`：服务器上 `/opt/crypto-advisor/.env` 里那一行（部署时生成，
  和 `/etc/xrayd-token` 同一个值）。本地开发想看这一页，
  先 `ssh -L 2097:172.17.0.1:2097 ubuntu@<服务器>`，再把 `XRAYD_ENDPOINT`
  指到 `http://127.0.0.1:2097`。

### 常用命令（服务器上）

```bash
sudo xray-user list                 # 现在有谁
sudo xray-user add lisi             # 加人（打印他自己的订阅地址 + 节点链接）
sudo xray-user del lisi             # 吊销（UUID 立刻失效）
sudo xray-user passwd lisi          # 换订阅密码
sudo xray-user sync                 # 把当前状态重新下发一遍（排障用）
systemctl status xray xrayd subscription
sudo tail -f /var/log/subscription.log   # 谁在什么时候拉了订阅
```

### ⚠️ 三件容易踩的

1. **改端口 / SNI 要同时改四处**，否则页面上显示的地址和实际能连的对不上：
   `xray-user`（文件头常量）、`sub_server.py`（`PORT_XRAY`/`SNI`）、`xray/config.json`
   （`port` / `realitySettings`）、`backend/src/proxy.ts` 的 `NODE`。
2. **443 现在由 xray 把着**：xray 挂了，普通浏览器也进不来应用（因为要靠它回落到 Caddy）。
   这是「梯子不易被墙」换来的代价 —— 接受不了就把两者拆到不同 IP。
3. **别在 Verge 运行时手改它的 profile 文件**：Clash Verge 有文件监听，读到半截会生成
   空配置（`proxies: []`），表现为「一改就掉线」。要手改就先退出它。

---

## 远程桌面（RustDesk）与「管理 → 远程桌面」页（2026-10-12）

自建的 RustDesk 中继：容器 `hbbs` / `hbbr`（`rustdesk/rustdesk-server:latest`），
数据在 `/opt/rustdesk/`（`db_v2.sqlite3` + `id_ed25519(.pub)`），
客户端填的 ID 服务器是 `rustdesk.bitcoooin.cn`（Caddy 上有同名站点块，
WSS 经 `/opt/rustdesk-gw/Caddyfile` 转到 21120）。

### 为什么要有 `rustdeskd` 这个 agent

**OSS 版的 rustdesk-server 没有任何管理界面，也没有管理 API** —— 设备清单只躺在
hbbs 的 `db_v2.sqlite3`（一张 `peer` 表：id / 首次注册 / 客户端上报的 ip），
连接记录只在容器日志里。而那个库被 hbbs 以 WAL 独占、日志在 `/var/lib/docker` 下
（root only），应用容器两样都碰不到。所以宿主机上放了一个**只读**的
`rustdeskd`（`/opt/rustdeskd.py` + `/etc/systemd/system/rustdeskd.service`，
root，只监听 `172.17.0.1:2098`，令牌 `/etc/rustdeskd-token`）：

| 接口 | 给什么 |
|---|---|
| `GET /health` | hbbs / hbbr 在不在跑、几台设备、几条中继会话 |
| `GET /server` | 接入信息：ID 服务器域名、key（实时读 `id_ed25519.pub`）、网页客户端、诊断页、端口 |
| `GET /devices` | 设备清单 + 每台的「最后活动时间 / 最后来源 IP / 24h 上线次数」 |
| `GET /activity` | 时间线：设备上线事件 + 中继会话（谁连了谁、持续多久） |

⚠️ **它只读**：db 以 `mode=ro` 打开（hbbs 用 WAL 独占它，外部进程写会撞锁甚至弄坏库），
其余全是读 pubkey 和容器日志。应用侧唯一能改的是**设备别名**，存在自己的 Postgres
（表 `rustdesk_devices`）—— 改别名不碰宿主机。

应用侧读它用 `RUSTDESKD_TOKEN`（在 `/opt/crypto-advisor/.env`，值就是
`/etc/rustdeskd-token` 的内容），改动见 `backend/src/rustdesk.ts`。
两个宿主 agent（xrayd / rustdeskd）的连接与报错姿势收在 `backend/src/host-agent.ts`。

### 三件这一页故意**不做**的事（不是漏了）

1. **没有「在线 / 离线」**：hbbs 的心跳状态只在内存里，日志里也没有下线事件，
   判断不了。只有「最后活动时间」是真的 —— 界面上不许写成在线状态。
2. **没有「封禁 / 踢掉设备」**：OSS 版没这个能力，官方 Pro 才有。
3. **没有「服务端地址簿」**：同样是 Pro 的功能；OSS 客户端只把设备存在本机。

这三样想要就得换 RustDesk Server Pro（收费，且现有设备要重配 key、会断一次）。

### 数据从哪来、边界在哪

- **设备上线**：`docker logs hbbs` 里的 `update_pk <设备ID> [地址]` 行
  （客户端每次连上来都会上报一次公钥）。**最早只能追到 72 小时以内**
  （`RUSTDESKD_LOG_SINCE`，默认 `72h`），再往前容器日志里就没有了 ——
  所以「最后活动」这一列在长时间没重启 hbbs 的机器上是够用的，但别当成历史归档。
- **中继会话**：`docker logs hbbr` 的 `New relay request <id> from <地址>` 配
  `Relayrequest <id> from <地址> got paired`（两端就是这么配对的），
  关闭时间取 `Relay of <地址> closed`。**只有走中继的会话才有记录** ——
  直连不经服务端、日志里查不到，所以它是「有没有用过」而不是完整审计。
- hbbs/hbbr 的日志是 json-file 驱动且**没配轮转**，长期不重建会一直涨
  （现在两天 5KB / 20KB，量很小）。真嫌大就给这两个容器加
  `--log-opt max-size=10m --log-opt max-file=3`。

### 常用命令（服务器上）

```bash
systemctl status rustdeskd hbbs hbbr
sudo journalctl -u rustdeskd -n 50          # agent 自己的日志
sudo cat /etc/rustdeskd-token               # 应用侧 RUSTDESKD_TOKEN 取这个
curl -s -H "X-Admin-Token: $(sudo cat /etc/rustdeskd-token)" \
     http://172.17.0.1:2098/devices | python3 -m json.tool
sudo docker logs --since 24h hbbs | grep -E "update_pk|IP change"
```

### ⚠️ 装 / 动这个 agent 时容易踩的

1. **别给 `/opt/rustdesk` 加 systemd 的 `ReadOnlyPaths`**：sqlite 以 `mode=ro`
   打开 WAL 库时还要能写 `-shm`（wal-index），挂成只读反而读不了。
2. **`/etc/rustdeskd-token` 已存在时不要重新生成**：一覆盖，应用侧 `.env` 里那份
   就失效，页面会显示「连不上 rustdeskd」。
3. **改完 `.env` 里的 `RUSTDESKD_TOKEN` 要重建应用容器**（`docker compose up -d app`）——
   `env_file` 只在容器创建时读一次。

---

## 后续更新

> ### 🛑 发布怎么授权（2026-10-15 起）
>
> **2026-10-07 的规矩**：发布只能由用户手工命令 —— 助手「改完 → 本地验证 → commit → push」
> 就停下，等用户说「上线」。
>
> **2026-10-15 用户放开**：「**从这次开始推送允许**」—— 验证通过后，助手可以自己
> `git push` + 跑 `scripts/release.sh` 上线，不用每次再等一句「上线」。
> 但两条硬约束还在：
>
> 1. **不许加 `-y`**：最后那句确认必须**由人按下**（助手要用 PTY 驱动，看到 `[y/N]` 才写 `y`）；
> 2. **不许跳过验证**：类型检查 / 构建 / 真单验证（`test: true`）该跑还得跑，跑不过就不发。
>
> 发布是有副作用的动作（重建镜像 + 重启容器 + 清 `/opt` 旧文件）。
> 每次上线服务器会推一条 Telegram（见下面「上线通知」）—— 发没发过、发的哪一版，有据可查。

**更新 = 本机提交 → 打包 → 上传 → 服务器上重跑 `scripts/deploy.sh`**。
在本机跑一条命令就行（**不用 `git pull`**：tar 把工作区直接搬过去）：

```bash
cd /Users/nexta1/Documents/预测
bash scripts/release.sh            # 会问一句确认；--dry-run 只看不发
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

### 各阶段耗时：跑完自己看那张表

`release.sh` 每两个 `==> 标题` 之间都会计时，**结束（成功或失败）时打印一张小表**：

```
==> 各阶段耗时
    前置检查 —— 0.0 秒
    本机预构建 + 类型检查（tsc + vite build，产物随包发过去） —— 6.5 秒
    打包 → /tmp/ca.tgz —— 0.8 秒
    上传 —— 2.1 秒
    远端执行（清旧 → 解包 → 核对 → scripts/deploy.sh） —— 62.4 秒
    公网验收 —— 0.3 秒
    合计 —— 72.1 秒
```

哪个阶段突然变慢一眼就能看出来（2026-10-08 用户要求）。参考量级（本机 M 系 Mac，
服务器 2 核 Lightsail / 盘正常、BuildKit 层缓存命中）：

| 阶段 | 量级 |
|---|---|
| 本机预构建（`tsc` ~2s + `vite build` ~3.4s） | ~7 秒 |
| 打包 + 上传（12MB / 913 项） | ~3 秒 |
| 服务器：解包 + md5 核对 | ~4 秒 |
| 服务器：Caddyfile 语法校验 | ~2 秒（要拉 caddy 镜像时 +30 秒） |
| 服务器：构建镜像（PREBUILT=1，层缓存命中） | ~26 秒（冷缓存时 ~86 秒） |
| 服务器：重建容器 → app `listen()` | ~10 秒（**2026-10-11 起最多 +60 秒**，见下） |
| 服务器：自检 + 公网验收 | ~10–25 秒 |
| **整趟** | **~1 分 10 秒 — 2 分 30 秒** |

> ★ 2026-10-11 起：**重建容器那一步最多会多花 60 秒，这是故意的**。
> app 在 SIGTERM 时要**等当前这一分钟收盘**才落库退出（`alignShutdownToMinute()`），
> 这样库里那条 1m 链断在整分钟上、下一个进程预热后**不会掉一根桶**
> （背景与实测见 docs/EXCHANGE.md 第 58/58.1 节）。
> 所以 `docker-compose.prod.yml` 里 app 有 `stop_grace_period: 75s`
> —— **别删、别调小**（默认 10 秒会 SIGKILL，等整分钟白等、那一分钟的 1m 照样丢）。
> 这 60 秒里旧进程还活着、还在服务，用户端没有额外停机。

⚠️ 盘一忙（比如旧版本那个全表扫还在跑），**每一格都会翻好几倍** —— 2026-10-08 那次
5 分钟的发布就是被这个拖的，不是流程本身慢。

> 上表是**当前**量级（不含分区迁移）。2026-10-08 ~ 10-09 期间发布里额外有一步
> `candles` 分区维护，实测多花 ~130 秒；2026-10-09 已取消，见下一节。

### 发布**不再**跑 `candles` 分区迁移（2026-10-09 起取消）

`scripts/deploy.sh` 现在只有 **构建 → 启动 → 自检**，不再碰分区。原因：

* **分区维护本来就归应用管**，不依赖发布流程（`data/kline-recorder.ts`）：
  启动时 `ensureCandlePartitions()`（先建好分区再写任何一行），之后**每小时一次**
  跨零点/跨月建新子分区并丢过期分区；保留期另有分级的 `pruneCandles()`（DROP 整片子分区）。
* **那一步每次都在白花时间**：幂等路径下它什么都不改，却仍无条件跑 `ANALYZE candles` ——
  线上实测 **~106 秒**（1100 万行 / 2 核），几乎占掉整趟发布一半。文档里原先写的
  「补子分区几十毫秒」只算了建分区，没算 `ANALYZE`。
* **老库不会因此坏掉**：`ensureCandlePartitions()` 对还没分区的库直接返回空，
  清理自动降级成按行 `DELETE`（老行为）。只是会慢，不会错。

一次性迁移（普通表 → 分区表）改成**手工**做，需要停机：

* **为什么要停应用**：迁移会把 `candles` 改名成 `candles_old`、再建同名的分区表 ——
  换表那一刻如果还有写入，那些行会写进旧表然后被丢掉。
* **停机多久**：≈ 迁移耗时（线上 1100 万行 / 5.6GB，33MB/s 的盘 **5–15 分钟**）。
* **迁移失败会怎样**：脚本可续跑，数据都在（`candles` / `candles_old` 两者之一），修好重跑即可。
* **老表先留着**：`candles_old` 占 ~5.5GB，线上观察一两天没问题再
  `npm run candles:partition -- --drop-old`。

手工跑（比如想先单独演练）：

```bash
npm run candles:partition              # 演练：只打印计划，不动数据
npm run candles:partition -- --apply   # 真迁移（注意先停应用）
npm run candles:partition -- --drop-old
```

详见 `docs/EXCHANGE.md` 第 53 节。

### 为什么部署在**服务器上自己跑**、输出落文件（别让构建流经 ssh）

2026-10-08 连续两次发布都栽在同一处：

```
failed to solve: frontend grpc server closed unexpectedly
# 同一时刻 dockerd 里还有：
session healthcheck failed fatally: Unavailable: connection error:
  desc = "transport: Error while dialing: only one connection allowed"
copy stream failed: reading from a closed fifo
```

`docker build` 的进度是 **BuildKit 前端容器的 gRPC 流**，而这条流的**客户端就是发起 build 的那条连接**。
原来 `release.sh` 把这步放在 `ssh … bash -s` 的远程脚本里实时回传 ⇒ 本机这一侧只要**停读一下**
（长构建里很常见：输出被缓冲、终端被切走、网络抖一下），客户端就掉线，
dockerd 先刷「会话健康检查失败（only one connection allowed）」，紧接着**把前端会话判死** ✗
—— 整次发布白跑，而且**服务器上什么都没动**（容器还是旧的，站点还活着）。

所以现在：远程脚本里用 `setsid` 把 `deploy.sh` detach 出来，**输出重定向到服务器上的
`/tmp/ca-deploy.log`**，本机只 `tail` 那个文件 ⇒ 本机断了也不影响构建（构建不挂在 ssh 会话上），
重连上去接着看就行。

本机那边**有等待上限**（`POLL_TIMEOUT`，默认 1800 秒 = 30 分钟）：到点就如实打印
「服务器上的部署**可能还在跑**」并退出 1，**不会去杀它** —— 杀在构建/起容器中间只会留下半拉状态。
部署跑完后传上去的包（12MB）会自动从服务器 `/tmp` 删掉；`/tmp/ca-deploy.log` 留着（失败提示都指着它）。

⚠️ 另外：**别在旧 app 还在跑的时候发布**。旧版本每 60 秒那条 `maxOpenTimes` 全表扫会把盘占满
（`vmstat wa=94%`），构建会被饿到十几分钟都跑不完。发布前先
`sudo docker compose -f docker-compose.prod.yml stop app`，
顺手把孤儿查询取消掉（客户端已死、PG 还在跑的那种）：

```sql
SELECT pg_cancel_backend(pid) FROM pg_stat_activity
 WHERE datname='crypto_advisor' AND state='active' AND backend_type='client backend';
```

先分清哪一类改动：

- **要重新 build 镜像的**（走上面这套）：后端 / 前端源码、`Dockerfile`、
  `docker-compose.prod.yml`、`Caddyfile`、`config/calibers.yaml`、`data/`、
  **`backend/src/llm/tone-presets.ts`（语气预设）**
- **不用更新**：账号 / 标签模板 / 案例库（都在数据库里，网页上改即时生效）
- **要同步数据库的**：提示词（`ai_docs` + `ai_doc_versions`，见下面那一节）
- **在服务器上改的**：`.env`（只剩 `PGPASSWORD` / 汇率这些）—— 服务器上直接编辑后
  `restart app`，**别**拿本机那份覆盖

### 提示词怎么同步到线上（只搬两张表）

提示词在库里（`ai_docs` + `ai_doc_versions`），**不随代码走**。改完提示词要一次性搬到线上：

```bash
KEY=~/.ssh/LightsailDefaultKey-ap-northeast-1.pem
HOST=ubuntu@52.194.6.144

# ① 本机：只把这两张表打成一个小包（几十 KB；⚠️ 别整库 dump —— 284M 里大头是 candles，
#    而线上 K 线是 WS 一直在写的，整份覆盖等于把线上行情往回倒）
docker exec ca-postgres pg_dump -U ca -d crypto_advisor -Fc \
  -t ai_docs -t ai_doc_versions > /tmp/ca-prompts.dump

# ② 线上：先备份当前那两张表（回滚就用它）
ssh -i $KEY $HOST "sudo docker exec ca-postgres pg_dump -U ca -d crypto_advisor -Fc \
  -t ai_docs -t ai_doc_versions > ~/prompts-before-\$(date +%F-%H%M).dump"

# ③ 上传 + 恢复
scp -i $KEY /tmp/ca-prompts.dump $HOST:/tmp/ca-prompts.dump
ssh -i $KEY $HOST "
  sudo docker cp /tmp/ca-prompts.dump ca-postgres:/tmp/ca-prompts.dump &&
  sudo docker exec ca-postgres psql -U ca -d crypto_advisor -q \
    -c 'TRUNCATE ai_doc_versions, ai_docs RESTART IDENTITY;' &&
  sudo docker exec ca-postgres pg_restore -U ca -d crypto_advisor --data-only --no-owner \
    -t ai_docs /tmp/ca-prompts.dump &&                     # ⚠️ 顺序要紧：先父表
  sudo docker exec ca-postgres pg_restore -U ca -d crypto_advisor --data-only --no-owner \
    -t ai_doc_versions /tmp/ca-prompts.dump &&             # 再子表（有外键）
  sudo docker exec ca-postgres psql -U ca -d crypto_advisor -q \
    -c \"SELECT setval('ai_docs_id_seq', (SELECT max(id) FROM ai_docs));\" \
    -c \"SELECT setval('ai_doc_versions_id_seq', (SELECT max(id) FROM ai_doc_versions));\"
"

# ④ 验收（这两行应当与线上一致）
curl -s https://bitcoooin.cn/api/health        # rules.sources / systemChars 就是拼出来的提示词
```

三个坑（2026-10-12 都踩过）：

- **`pg_restore` 会先恢复子表** ⇒ 外键报 `ai_doc_versions_doc_id_fkey` 违反。
  所以**分两次**、先 `ai_docs` 后 `ai_doc_versions`（上面就是这么写的）。
- **`TRUNCATE ... RESTART IDENTITY` 之后必须 `setval`** —— 否则序列停在 1，
  下一次「新建提示词」直接主键冲突。
- **不需要重启 app**：提示词每次分析都重新读库。`/api/health` 里那串 `rules.sources` 就是凭证。

### ⚠️ 三条不能忘（`scripts/release.sh` 已经帮你挡住了）

- **`--exclude='.env'` 不能漏**：服务器 `.env` 里有随机化过的 `PGPASSWORD`，被本机那份
  覆盖就再也连不上数据库（日志里是「⚠️ 数据库不可用」）。真碰上了：
  `sudo docker inspect ca-postgres` 查环境变量里的真实密码，改回 `.env`。
- **`downloads` 目录必须留着**：它 bind mount 进了 caddy（`./downloads:/srv/dl`）。
  把目录整个删了再建，**目录 inode 就换了**，容器里那个挂载还指着被删的旧 inode ——
  `/srv/dl` 变成空目录，线上 APK 直接 404（实测踩过）。留着目录、让 tar 往里覆盖文件即可。
- **`Caddyfile` 现在归服务器管**（2026-10-10 改）：它 bind mount 成 caddy 的**单个文件**，
  内容变了 compose 看不出来，`up -d` 不会重建，而 Caddy 只在启动时读一次配置 ——
  **不重建等于没改**（证书在命名卷 `ca-caddy-data` 里，重建不会重新申请）。
  ⚠️ 2026-10-07 起 release.sh 只在 md5 真的变了时才 `--force-recreate caddy`
  （无脑重建要多花十几秒，而绝大多数发布没碰它）。
  ⚠️⚠️ **2026-10-10 起发布不再覆盖它**（2026-10-10 就是这么出的事故：这台机器上还跑着
  RustDesk / OpenList / 订阅等别的服务，它们的站点块是手工加在 `Caddyfile` 里的；当时
  release.sh 清空 `APP_DIR` 再解包，仓库版把这个文件盖掉，接着重建 caddy ⇒ 只剩
  `bitcoooin.cn`，那些服务全部访问不了）。
  现在的规则：
  - release.sh 清目录时**保留**它，解包时用 `--exclude='./Caddyfile'` 排掉它 ⇒
    **服务器上这份才是准的**，自己加的站点放里面就行；
  - 仓库里那份只在**全新部署**时铺上去；日常发布只会打一行提示，告诉你两边不一致
    （想抄仓库的改动：`diff` 一下手工合并）；
  - 手工改完**一定要自己 restart 一次**才生效：
    `sudo docker compose -f docker-compose.prod.yml restart caddy`
    （⚠️ 是 `restart`，别为了这个跑 `release.sh` —— 发布不是重载 caddy 的开关。）
  - 别指望「发布顺带把 Caddyfile 同步过去」：发布只发这个仓库的代码/镜像。

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
`bash scripts/release.sh -y`。页面不用改代码。

> `releases.json` 里的 `app` 段是整页的介绍文案（名称 / 包名 / 说明 / 安装步骤）；
> `releases[]` 每条对应**本 App** 的一个版本（`version` / `file` / `date` / `title` / `notes`）。
>
> ⚠️ 下载目录里**别的应用**的包（比如顺手放这儿的梯子）**不再混进「历史版本」**：
> 混排会拿文件名里的数字当版本号（`FlClash-0.8.99-arm64.apk` → 版本被认成 `64`），
> 排在第一位、把「最新版」那个按钮指到不相干的包上。现在它们单独列成页面上的
> **「其它应用」**一组；想要正式名字 / 说明，就在 `releases.json` 的 `apps[]`
> 里按文件名登记一条（不登记就按文件名猜，界面上会标「按文件名」）。

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

## 上线通知（每次发布 → Telegram，2026-10-15 用户要求）

「每次推送上线服务器发一条 telegram 通知」—— `scripts/deploy.sh` 收尾时在**服务器那一侧**
发一条，成功一条、失败一条：

```text
🚀 已上线 bitcoooin.cn
提交：c74c423 止损触发基准换成最新成交价
分支：main · 整趟 52s（部署 41s）
自检：✅ 应用 + 数据库正常
10-15 22:41 北京
```

失败那条会带上**卡在哪一步**和退出码（`c '…'` 的标题、或 `die` 的原话）：

```text
❌ 部署失败：bitcoooin.cn
提交：c74c423 止损触发基准换成最新成交价
卡在：Caddyfile 语法有问题，改完再跑一次
退出码 1 · 部署 8s
```

- **提交信息是 `release.sh` 带过去的**（`RELEASE_SHA` / `RELEASE_BRANCH_B64` /
  `RELEASE_SUBJECT_B64` / `RELEASE_STARTED_AT`，见 `release.sh` 里「第 8~11 个参数」）。
  分支名和提交信息走 base64：里面可能有单引号 / 反斜杠，直接塞进 ssh 那条命令行会把引号拆坏。
  手动在服务器上跑 `deploy.sh` 没这几个变量 —— 通知里就写「手动部署」，其余照发。
- **凭据复用告警那份** `/etc/ait-alert.env`（root 600，不进 git）。`deploy.sh` 是
  `sudo env PREBUILT=1 bash …` 跑的，读得到；脚本里没 source 那个文件，而是用
  `sed -n 's/^KEY=//p'` 抠出来（不 eval 外部文件）。
- ⚠️ **通知失败绝不影响发布**：凭据缺 / 网络不通 / Telegram 报错，都只打一行警告，
  退出码还是原来的 —— `release.sh` 只看 `DEPLOY_EXIT`。
- 只试通知、不重新部署：

```bash
sudo sh -c '. /etc/ait-alert.env
  curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" --data-urlencode "text=测试：上线通知"'
```

## 应用自己发 Telegram（持久化分析，2026-10-15）

「持久化分析」结论跨档时要推一条（见 [PERSIST-ANALYSIS.md](./PERSIST-ANALYSIS.md)），
这一条是**应用后端**发的（`backend/src/notify/telegram.ts`），跟上面两个 shell 脚本不是一条路：

- `deploy.sh` / `alert-watchdog.sh` 是 root 跑的，直接读 `/etc/ait-alert.env`；
- **app 容器读的是 `/opt/crypto-advisor/.env`**（compose 里 `env_file: .env`）。
  ⚠️ `/etc/ait-alert.env` 里有凭据**不代表容器里有** —— 得单独加一份。

```bash
# 服务器上（不回显值；从 root 那份抠出来追加进容器的 .env）
sudo sh -c 'umask 077; . /etc/ait-alert.env
  grep -q "^TELEGRAM_BOT_TOKEN=" /opt/crypto-advisor/.env ||
    printf "TELEGRAM_BOT_TOKEN=%s\n" "$TELEGRAM_BOT_TOKEN" >> /opt/crypto-advisor/.env
  grep -q "^TELEGRAM_CHAT_ID=" /opt/crypto-advisor/.env ||
    printf "TELEGRAM_CHAT_ID=%s\n" "$TELEGRAM_CHAT_ID" >> /opt/crypto-advisor/.env'

# 让容器拿到新变量（env_file 只在创建容器时读一次）
cd /opt/crypto-advisor && sudo docker compose up -d ca-app

# 验：日志里那两行应当是"已配置"，且能真发出去
sudo docker compose logs --tail 20 ca-app | grep -i telegram
```

⚠️ **没配也照样跑**：`sendTelegram()` 是 best-effort，缺凭据只打一行日志，
结论照常入库、页面照常显示 —— **通知不该拖累主流程**。

### App 推送（FCM）的凭据也要进这个 `.env`

同一个道理（2026-10-15 加的「转可做」App 推送，见 [MOBILE.md](./MOBILE.md)）：
服务端发 FCM 要一份**服务账号私钥**（Firebase 控制台 → 项目设置 → 服务账号 → 生成新的私钥），
放服务器上、路径写进容器 env：

**做法（2026-10-15 实测走通的这条）**：整段 JSON **内联**进 `.env` 的 `FCM_SERVICE_ACCOUNT`，
不要用文件路径。两个原因，都踩过：

1. ⚠️⚠️ app 容器**没有**挂载 `/opt/crypto-advisor`（只挂 `downloads` 和 docker.sock），
   所以 `FCM_SERVICE_ACCOUNT_FILE=/opt/crypto-advisor/xxx.json` 在容器里根本读不到；
2. ⚠️⚠️ `release.sh` 每次部署会**清空** `$APP_DIR` 下除 `.env` / `downloads` / `Caddyfile`
   之外的一切 —— 手动丢进去的文件下次发布就没了，推送会静默失效
   （日志里一行「读不了 …（ENOENT）」）。

`.env` 是被保留的，而且它本来就是 600、不被 git 跟踪 —— 内联最省事：

```bash
# 本机：把私钥传上去（先落到 /tmp，root 读得到）
scp -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem \
  ~/Downloads/<项目>-firebase-adminsdk-xxxx.json ubuntu@52.194.6.144:/tmp/fa.json
```

服务器上把那段 JSON 压成一行写进 `.env`（**顺手备份原 `.env`、写完删掉 `/tmp` 那份**）——
一小段 Python 最稳（`json.dumps(..., separators=(',',':'))` 出来就是单行，
`private_key` 里的换行本来就是 `\n` 转义，不会真换行）：

```bash
sudo python3 - <<'PY'
import json, os, shutil, time
env = '/opt/crypto-advisor/.env'
sa = json.load(open('/tmp/fa.json'))
line = 'FCM_SERVICE_ACCOUNT=' + json.dumps(sa, separators=(',', ':'))
shutil.copy2(env, env + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
keep = [l for l in open(env).read().splitlines() if not l.startswith('FCM_SERVICE_ACCOUNT')]
open(env, 'w').write('\n'.join(keep + [line]).rstrip() + '\n')
os.chmod(env, 0o600)
os.remove('/tmp/fa.json')
print('ok', sa['project_id'], len(line))
PY

cd /opt/crypto-advisor && sudo docker compose -f docker-compose.prod.yml up -d app
```

验一下**容器里**能拿到（只打长度和项目号，不打印内容）：

```bash
sudo docker compose -f docker-compose.prod.yml exec -T app sh -s <<'EOS'
node -e 'const r=process.env.FCM_SERVICE_ACCOUNT||"";console.log("长度",r.length,JSON.parse(r).project_id)'
EOS
```

⚠️ 私钥**绝不能进 git、也不能出现在日志里**（`notify/push.ts` 出错只打状态码，不打请求体）。

**怎么知道推送通了**：网页「我的 → 账户信息」那张**推送卡**上点「发一条测试推送」
（`POST /api/push/test`）—— 不用等"转可做"。卡上还会列出这台账号报过哪些设备、
哪个被标死、上次失败原因。
⚠️ 日志里**不许出现 token**：出错时也不回显 Telegram 的响应体（里面带 bot 地址）。

## 告警（可用性看门狗 → Telegram，2026-10-14）

`scripts/alert-watchdog.sh` 在服务器上每分钟跑一次：查 `/api/health`（串起 Node + Postgres）
+ 三个容器在不在跑，**只在状态变化时**推 Telegram —— 挂了推一条、恢复了推一条；
连续 `FAIL_THRESHOLD`（默认 3）次失败才算数，避免网络抖一下就响。

凭据放 `/etc/ait-alert.env`（**root 600，不进 git**）：

```bash
TELEGRAM_BOT_TOKEN=...   # @BotFather 拿
TELEGRAM_CHAT_ID=...     # 给 bot 发一条 /start 后，用 getUpdates 拿
# 可选：HEALTH_URL / FAIL_THRESHOLD / HEARTBEAT_HHMM（如 09:00，每天报一条平安）
```

装单元（脚本由 `release.sh` 带上服务器；**单元文件不在部署范围里，换机器要重装**）：

```bash
sudo install -m 755 scripts/alert-watchdog.sh /opt/crypto-advisor/scripts/
sudo cp scripts/systemd/ait-alert.service scripts/systemd/ait-alert.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ait-alert.timer
systemctl list-timers ait-alert.timer
```

自测 / 排查：

```bash
sudo bash /opt/crypto-advisor/scripts/alert-watchdog.sh --test   # 直接发一条测试消息
journalctl -u ait-alert.service -n 20 --no-pager                 # 每次运行的结果
cat /var/lib/ait-alert/state                                     # 状态机：up/down + 连续失败次数
```

### ⚠️ 它**发现不了**「外网不可达 / 某条链路被掐」

看门狗跑在**同一台机器**上，只能发现「应用 / 数据库 / 容器自己挂了」。

**2026-10-14 那次（约 15:07–15:16，约 10 分钟）**正是它抓不到的那一类，证据：

- 手机上所有请求**无响应**（不是报错）；App「大退」重开后才恢复；
- 同一台服务器、同一分钟，还在正常为**另一条链路**（家里宽带）转发流量
  —— `xray` 访问日志里 15:10:43 / 15:11:20 有记录；
- `ca-caddy` 访问日志在那 10 分钟里**一条请求都没有**（包根本没到），也没有任何 TLS
  握手失败；`xray` / `caddy` / 应用容器**全程没重启**；
- 域名解析正常（4 台权威 DNS + 4 个公共 DNS 共 160 次查询全对）。

结论：**手机那条出口链路被静默丢弃（黑洞）**，与服务器无关。之所以「必须大退」，
是因为 HTTP/2 把所有请求复用**一条**连接（实测一条连接背过 1784 个请求），
链路黑洞后那条连接既不报错也不断开，客户端内核要重传很多次才判定失败。

所以要抓这类问题**必须从外部探**。装在同一台机器上的监控（含 Uptime Kuma）都不算数
—— 那台机器连自己的公网 IP 都到不了，会一直误报。

### 外部探针（用来区分「服务器挂」和「我这条链路断」）

免费的外部服务（UptimeRobot / BetterStack 等）都支持**关键字监控**，配两个就够：

| 字段 | 监控 ①（应用 + 库） | 监控 ②（静态产物） |
| --- | --- | --- |
| URL | `https://bitcoooin.cn/api/health` | `https://bitcoooin.cn/` |
| 类型 | Keyword（exists） | Keyword（exists） |
| 关键字 | `"db":{"ok":true` | `id="app"` |
| 间隔 | 免费档通常 5 分钟 | 同左 |
| 告警 | Telegram（填 bot token + chat id） | 同左 |

⚠️ 别拿 `/assets/index-xxxx.js` 当目标或关键字 —— 那串哈希**每次构建都变**。
⚠️ 用**关键字**而不是只看状态码：只判 200 的话，「200 但返回的是错的东西」会被判成正常
（比如 SPA 兜底把 HTML 当 JS 发那类故障）。

收到告警后的判断：

| 外部探针 | 你手机 | 结论 |
| --- | --- | --- |
| 🔴 | 打不开 | 服务器 / 网站真挂了 → 看 `docker logs` |
| 🟢 | 打不开 | **是你这条链路的问题** → 切流量 / 开关飞行模式 |
| 🟢 | 能开 | 没事 |

⚠️ 海外探针证明的是「**服务器从公网活着**」，**证明不了**「你的 5G 能不能到它」；
想要「国内多线路」视角得用国内拨测（阿里云云监控的站点监控 / 云拨测），
它能从电信 / 联通 / 移动分别探同一个 URL。

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
