---
name: release-to-prod
description: 把这个仓库发版到线上（bitcoooin.cn）或回滚时用。用户说「上线 / 发布 / 发版 / 回滚」就按这份走 —— 它装的是**脚本不会告诉你的那部分**：确认怎么按、发完怎么确认真的是新包、出事怎么退回去。
---

# 发版到线上

脚本本身的机制（怎么打包、为什么先在本地编译、各阶段耗时、APK 怎么补传）
看 [docs/DEPLOY.md](../../../docs/DEPLOY.md)，**别在这里重抄一遍**。
这份只管两件事：**怎么安全地把这一版发出去**、**发完怎么确认发的就是它**。

## 何时用

- 用户说「上线 / 发布 / 发版 / 推到线上」
- 用户说「回滚 / 退回上一版」
- **不适用**：只改 `.github/`（agent 定制）不算发布，不用发；只改文档也不用
  （线上跑的是构建产物，文档不影响运行行为）。

## 两条硬约束（2026-10-15 用户定的，别自己放宽）

1. **不许加 `-y`** —— 最后那句 `[y/N]` 必须由「人」按下。
2. **不许跳过验证** —— 类型检查 / 构建 / 真单验证跑不过就不发。

> 助手**可以**自己发（不用每次等用户说「上线」），但上面两条照旧。

## 步骤

### 0. 先提交 —— 不然脚本直接停

`release.sh` 第一件事就是查工作区：**有未提交改动就停**
（`die '工作区有未提交的改动 —— 先「git commit」再发布'`）。
别用 `--no-check` 绕，那等于把没进版本库的东西发上线。

```bash
git status --short          # 必须是空的
git add -A && git commit    # 提交信息按仓库风格：type(scope): 中文标题 + 讲清为什么
```

### 0b. APK 现在是自动的

`release.sh` 默认会先跑 `scripts/build-apk.sh` 打一版 APK 再一起上传（用户 2026-10-21：
「需要 apk 每次都要上传」）。所以：

- 发版前把 `package.json` 的版本号改好（只在那一处改），`releases.json` 补一条说明；
- 不想这次打 APK 才加 `--no-apk`；
- 缺 JDK 21 / Android SDK 只会警告并跳过；**有工具链但编不过会中止**，先修再发。

### 1. 体检（不碰服务器）

```bash
npm run release:dry         # = bash scripts/release.sh --dry-run
```

它会跑 tsc + `build:all` + 打包，并打印「真要执行什么」。
**盯两行**：`已确认不含 .env` 和 `含预构建产物`。都绿了再往下。

### 2. 真发：确认那一步怎么驱动

**助手的 bash 工具没有可写 stdin 的 PTY**，直接跑 `bash scripts/release.sh`
会卡在 `[y/N]` 上永远等下去。用 FIFO 当 PTY（照抄这三行）：

```bash
cd <仓库根> && export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" &&
  rm -f /tmp/rel-in /tmp/rel.log && mkfifo -m 600 /tmp/rel-in &&
  exec 9<>/tmp/rel-in && bash scripts/release.sh <&9 > /tmp/rel.log 2>&1
```

⚠️ 用 `mode="async"` 起（`initial_wait` 给 30 秒就够，它会自己跑完）。
⚠️ **`exec 9<>/tmp/rel-in` 里的 `<>`（读写打开）不能少**：只读打开一个 FIFO 会
**阻塞到有写者出现** —— 脚本根本起不来，看着像"没反应"。
⚠️ `mkfifo` 前先 `rm -f`：上次跑剩的管道会让这一次直接读到 EOF、`read` 立刻返回空。

然后**轮询日志**，看到 `[y/N]` 才写确认（这才是「人按下」的意思，不是提前答 `-y`）：

```bash
tail -25 /tmp/rel.log                       # 等它打出 [y/N]
printf 'y\n' > /tmp/rel-in                  # ← 这时才写
```

之后继续 tail 等它跑完（整趟通常 **1~2 分钟**，远端重建镜像那步最慢）。
日志尾部的「各阶段耗时」表出现 = 跑完了。

### 3. 验收：**别只看 `/api/health`**

脚本自己会 `curl https://bitcoooin.cn/api/health`（失败重试 8×3 秒），
但那只能证明「有个容器在响应」。**要证明发的是刚才那一版**，再补两条：

```bash
# ① 前端包哈希 —— 跟本地这次 vite 构建的产物逐字比
curl -s https://bitcoooin.cn/ | grep -oE 'index-[A-Za-z0-9_-]+\.(js|css)' | sort -u
ls frontend/dist/assets/ | grep -E '^index-'          # 两边必须一模一样
```

这条最值钱：**能排除「传了旧包 / 浏览器缓存 / 只重建了后端」** ——
`/api/health` 全绿但跑的是旧前端，是完全可能发生的。

```bash
# ② 这次新加的路由要"活着"，不能是 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://bitcoooin.cn/api/ask \
  -H 'Content-Type: application/json' -d '{"question":"hi"}'
# 期望 401（要求登录）—— 401 / 405 都说明路由在；404 说明包没换
```

⚠️ 新接口要鉴权时，**未登录拿到 401 就是「它在」**，别当成失败。

## 回滚

**这个仓库的发版是「把本机工作区打个 tar 搬过去」，不是 `git push` 触发** ——
所以回滚就是**换回代码再发一次**：

```bash
git log --oneline -5         # 找上一版（每次上线服务器会推 Telegram，有据可查）
git revert <坏的那条>        # 别用 reset --hard 硬改历史，revert 留痕
npm run release:dry          # 体检
# 再按上面第 2 步发一次
```

⚠️ 上线是**重建容器**（有几十秒不可用），别在有人正看着的时候来回试 ——
一次发对，或一次退回。

## 踩过的坑

- **`.env` 绝不能进包**。`release.sh` 里有断言（打包时会打 `已确认不含 .env`），
  别去动那段。服务器上那份 `.env` 的 `PGPASSWORD` 是随机化过的，
  被本机这份覆盖后应用**直接连不上数据库**（日志是「⚠️ 数据库不可用」）。
- **别加 `--no-check` 图快**：会那么干通常是想发一个还没提交的文件 ——
  而那正是版本库里查不到的问题来源。
- **确认不能提前答**：预先往 FIFO 塞 `y`（或直接 `-y`）就失去「人按下」的意义了。
  这一步的作用是**给人一个反悔的机会**（比如体检时发现包不对）。
- 发布**不影响本地 `npm run web`**（另一个进程、另一个库），不用先停它。
  ⚠️ 但本地那个有单实例锁（`backend/src/util/single-instance.ts`），同机再起会被拦。
