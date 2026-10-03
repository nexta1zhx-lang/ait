# 线上部署

**线上地址：<https://bitcoooin.cn>**

```text
服务器   57.181.38.200（用户 ubuntu）
密钥     ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem
代码     /opt/crypto-advisor
域名     bitcoooin.cn（A 记录已指向该 IP，NS 在阿里云）
机器     Ubuntu 24.04 / 2 核 / 909MB 内存 / 36G 盘
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
  --exclude='backend/dist' --exclude='frontend/dist' --exclude='logs' -C . .

scp -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem /tmp/ca.tgz \
  ubuntu@57.181.38.200:/tmp/

# 服务器
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@57.181.38.200 \
  'sudo mkdir -p /opt/crypto-advisor && cd /opt/crypto-advisor && tar xzf /tmp/ca.tgz'
```

包只有 250K 左右。

> ⚠️ **一定排除 `.env`**。服务器上的 `.env` 是「在服务器上管」的：里面有随机化过的
> `PGPASSWORD` 和你的 API Key。用本机的 `.env` 覆盖它，会让**应用连不上数据库**
> （密码与 db 容器里那个对不上）。首次部署时 `.env` 不存在，`deploy.sh` 会交互式问你 Key。

### 2. 一键部署

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@57.181.38.200
cd /opt/crypto-advisor
sudo bash deploy.sh
```

`deploy.sh` 幂等，按顺序做：

1. 内存 < 1.9G 就加 2GB swap（这台机器 909MB，**必须加**，否则 Postgres / Node 容易被 OOM 杀）
2. 没装 Docker 就装
3. `.env` 不存在就从 `.env.example` 生成；缺 `LLM_API_KEY` 就**交互式问你**（不回显）；
   `PGPASSWORD` 还是默认值就**换成随机密码**
4. 用官方镜像**校验 `Caddyfile` 语法**（语法错的话 https 打不开，日志要翻半天才看出来）
5. `up -d --build` 起三个容器
6. 自检 `http://127.0.0.1:8787/api/health` —— **HTTP 状态一直是 200，要看里面的 `ok` 字段**
   （`ok` 反映数据库通不通）；数据库不通时提示去翻 db 容器的日志

`.env` 里要关心的几项：

| 变量            | 说明                                                     |
| --------------- | -------------------------------------------------------- |
| `LLM_API_KEY`   | 必填，DeepSeek 的 Key                                    |
| `PGPASSWORD`    | 别用默认的 `ca_local_dev`，`.env` 与 db 容器共用同一个值 |
| `LLM_MODEL`     | `deepseek-flash`（默认，便宜）或 `deepseek-v4-pro`       |
| `LLM_REASONING` | 保持 `none` —— 关掉隐藏思维链，快 5 倍、省 1/3 钱        |
| `USD_CNY`       | 展示用汇率                                               |
| `API_BASE`      | **留空**。只有交易所默认域名不可达时才覆盖               |

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

### 4. 迁移数据（**关键**：标签模板 + 案例库）

建表是自动的（`ensureSchema()` 幂等跑），但**表里是空的**。
⚠️ 提示词**不用迁**（在代码里）。要迁的是「有哪些标签可以挑」和案例库。

```bash
# 本机导出
cd /Users/nexta1/Documents/预测
docker exec ca-postgres pg_dump -U ca -d crypto_advisor -Fc > /tmp/ca.dump

# 传上去
scp -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem /tmp/ca.dump \
  ubuntu@57.181.38.200:/tmp/

# 服务器：导入（先停 app，避免写冲突）
cd /opt/crypto-advisor
sudo docker cp /tmp/ca.dump ca-postgres:/tmp/ca.dump
sudo docker compose -f docker-compose.prod.yml stop app
sudo docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U ca -d crypto_advisor --no-owner --data-only --disable-triggers /tmp/ca.dump
sudo docker compose -f docker-compose.prod.yml start app
curl -s localhost:8787/api/health      # rules.sources 应有 1 份以上
```

- **一定加 `--disable-triggers`**（需要超级用户，`ca` 就是）。不加的话 `pg_restore` 的
  数据段顺序**不等于**表依赖顺序，会出现：
  ```
  COPY failed for table "ai_doc_versions" ... Key (doc_id)=(1) is not present in table "ai_docs"
  COPY failed for table "analyses" ... Key (rules_hash)=(068b12cebc8f) is not present in "rules_versions"
  ```
  补一次也能修（父表已有数据后）：加 `--table=ai_doc_versions --table=analyses` 再跑一遍。
- 最少迁 `tag_templates`（标签模板，不然提示词里的标签池是空的）。
  案例库 `knowledge`（顺带 `knowledge_tags`）、历史 `analyses` / `llm_usage` 可选。
- `ai_docs` / `ai_doc_versions` 已经没用了，迁不迁都行。

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

## 后续更新

**更新 = 本机重新打包 → 上传 → 服务器上重跑 `deploy.sh`**（**不用 `git pull`**：
本机工作区有未提交的改动，tar 才能原样带过去）。**在本机跑一条命令就行：**

```bash
cd /Users/nexta1/Documents/预测
bash release.sh            # 会问一句确认；加 -y 不问，加 --dry-run 只看不发
```

它按顺序做：`tsc` 类型检查 → 打包（自动排除 `.env`，并断言包里确实没有它）→
检查 SSH（本机代理劫持时给出提示）→ `scp` 上传 → 远端「校验包 → 清空旧文件
（保留 `.env`）→ 解包 → md5 与本机核对 → `sudo bash deploy.sh`」→
最后 `curl https://bitcoooin.cn/api/health` 验收。**任一步失败就停住**，不会留下半个部署。

先分清哪一类改动：

- **要重新 build 镜像的**（走下面这套）：后端 / 前端源码、`Dockerfile`、
  `docker-compose.prod.yml`、`Caddyfile`、`config/calibers.yaml`、`data/`、
  **`backend/src/llm/prompts.ts`（提示词）**
- **不用更新**：标签模板 / 案例库（数据库里，网页上改即时生效）
- **在服务器上改的**：`.env`（Key / 密码 / 模型）—— 服务器上直接编辑后 `restart app`，
  **别**拿本机那份覆盖

### 手动等价步骤（`release.sh` 做的就是这些）

```bash
# 本机：打包（250K 左右）并上传
cd /Users/nexta1/Documents/预测
tar czf /tmp/ca.tgz --exclude='node_modules' --exclude='.git' --exclude='.env' \
  --exclude='backend/dist' --exclude='frontend/dist' --exclude='logs' -C . .
scp -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem /tmp/ca.tgz \
  ubuntu@57.181.38.200:/tmp/

# 服务器（⚠️ 串成一条 && 链：包没传好就停在第一步，不会删了旧代码却没得解压）
# tar xzf 也不加 sudo —— 用 ubuntu 解压文件才归 ubuntu，root 所有会让下次更新失败
cd /opt/crypto-advisor
tar tzf /tmp/ca.tgz >/dev/null \
  && sudo bash -c 'cd /opt/crypto-advisor && find . -mindepth 1 -maxdepth 1 \
       ! -name .env ! -name downloads -exec rm -rf {} +' \
  && tar xzf /tmp/ca.tgz \
  && sudo bash deploy.sh \
  && sudo docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
# 最后那句别省：Caddyfile 是 bind mount 的单文件，内容改了 compose 看不出来，
# up -d 不会重建容器，而 Caddy 只在启动时读一次配置 —— 不重建等于没改。
```

> ⚠️ **为什么要先清一遍**：`tar xzf` 只覆盖同名文件、**不会删除**本机已经删掉的文件。
> 残留的旧 `.ts` 会被 `tsc` 一起编译进镜像（如果它还 import 了已删模块，会直接构建失败）。
> 只能留 `.env` 和 `downloads` —— 数据库在 Docker 命名卷 `ca-pgdata` 里，删目录不动数据；
> Caddy 证书也在卷里，不会重新申请。
>
> ⚠️ **`downloads` 必须留着**：它 bind mount 进了 caddy（`./downloads:/srv/dl`）。
> 把目录整个删了再建，**目录 inode 就换了**，容器里那个挂载还指着被删的旧 inode ——
> `/srv/dl` 变成空目录，线上 APK 直接 404（实测踩过）。留着目录让 tar 往里覆盖文件就行。

> ⚠️ **`--exclude='.env'` 不能漏**。服务器上的 `.env` 里有随机化过的 `PGPASSWORD`，
> 被本机那份覆盖的话应用会连不上数据库，日志里是「⚠️ 数据库不可用」。
> 真碰上了：`sudo docker inspect ca-postgres` 查环境变量里的真实密码，
> 改回 `.env`；或 `down -v` 重建库后重迁数据。

---

## 静态下载（`/dl/`）

`downloads/` 里的文件由 Caddy 直接发出去（**不走应用**），链接形如：

```
https://bitcoooin.cn/dl/entry-advisor-0.1.0.apk
```

- `Caddyfile`：`handle /dl/* { root * /srv/dl; file_server }`
- `docker-compose.prod.yml`：给 caddy 挂了 `./downloads:/srv/dl:ro`

换文件时一起传上去：

```bash
bash build-apk.sh        # 顺带把新 APK 放进 downloads/
bash release.sh -y       # 打包上传 + 重建 caddy 容器
```

⚠️ 第一次加这个挂载**必须重建 caddy**（`release.sh` 走的就是
`up -d --build`，会按新配置重建），否则容器里没有 `/srv/dl`。

## 常用命令

```bash
ssh -i ~/.ssh/LightsailDefaultKey-ap-northeast-1.pem ubuntu@57.181.38.200
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
