/**
 * 只允许**一个**后端实例在跑（2026-10-16 用户：「只让一个前后端跑每次」）。
 *
 * 为什么必须：交易所的权重预算是**按出口 IP** 算的，全站共用一条
 *（`util/rate-budget.ts` 那段注释里记着一次真实事故：一次不带 symbol 的挂单查询
 * 就把 IP 打进 `-1003` 黑名单 8 分钟）。本机同时起两个实例 = 两套 WS + 两套补历史 +
 * 两套 5 分钟采样挤同一条预算，表现是「取数失败：交易所请求太频繁」——
 * 而且**每个实例都以为是对方超限**，最难查。
 *
 * 做法：进程级锁文件。
 *   · 启动时读 `.dev-server.lock`，里面的 pid **还活着**就直接拒绝启动（并告诉对方是谁）；
 *   · pid 已经死了（上次崩了 / 被强杀 / 换过机器）→ 当过期，直接盖掉；
 *   · 退出时删掉（SIGINT / SIGTERM / 正常退出都挂，见 `install`）。
 *
 * ⚠️ 只在**非生产**（`NODE_ENV !== 'production'`）下拦。
 *    生产是「一个容器一个进程」，而万一锁文件被打进镜像，容器就再也起不来了
 *    —— 那是拿线上可用性换一个本地便利，不划算。
 * ⚠️ 锁文件在当前工作目录（跟 `.env` 同级），**不进 git**（见 .gitignore）。
 * ⚠️ 急着手动起第二个（比如想对比两个分支）：`ALLOW_MULTI_SERVER=1 npm run web`。
 */
import fs from 'node:fs'
import path from 'node:path'

const LOCK_FILE = path.join(process.cwd(), '.dev-server.lock')

interface LockInfo {
  pid: number
  port: number | string
  startedAt: string
}

/** pid 还活着吗（`kill(pid, 0)` 只探活，不真发信号） */
function alive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程在，只是不是我的 —— 也算活着
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function readLock(): LockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as Partial<LockInfo>
    const pid = Number(raw?.pid)
    if (!Number.isFinite(pid)) return null
    return {
      pid,
      port: raw?.port ?? '?',
      startedAt: String(raw?.startedAt ?? '')
    }
  } catch {
    return null // 没锁 / 内容坏了：都按「没有」处理
  }
}

let holding = false

/**
 * 拿锁。**拿不到就打印原因并 `process.exit(1)`** —— 这是这个模块唯一要做的事，
 * 所以不给返回值让调用方自己决定（那就一定有人忘记判）。
 */
export function claimSingleInstance(port: number | string): void {
  if (process.env.NODE_ENV === 'production') return
  if (process.env.ALLOW_MULTI_SERVER === '1') {
    console.warn('  ⚠️  ALLOW_MULTI_SERVER=1：跳过单实例检查（交易所权重会跟别的实例抢）')
    return
  }

  const existing = readLock()
  if (existing && existing.pid !== process.pid && alive(existing.pid)) {
    console.error('')
    console.error('  ✋ 已经有一个后端在跑了，这次不启动 ——')
    console.error(
      `     pid ${existing.pid} · 端口 ${existing.port}` +
        (existing.startedAt ? ` · 起于 ${existing.startedAt}` : '')
    )
    console.error('')
    console.error('     两个实例会抢**同一条**交易所权重预算（按出口 IP 算），')
    console.error('     表现是「取数失败：交易所请求太频繁」，而且互相甩锅、很难查。')
    console.error('')
    console.error(`     · 只想用现成的那个 → 直接开 http://localhost:${existing.port}`)
    console.error(`     · 要重启            → kill -INT ${existing.pid}（SIGTERM 会等整分钟收盘）`)
    console.error('     · 确实要两个一起跑  → ALLOW_MULTI_SERVER=1 npm run web')
    console.error('')
    process.exit(1)
  }

  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify(
        {pid: process.pid, port, startedAt: new Date().toISOString()},
        null,
        2
      )
    )
    holding = true
  } catch (e) {
    /* 目录只读之类：拦不住就算了，别因为一个锁文件不让服务起 */
    console.warn(`  ⚠️  单实例锁写不了（${(e as Error).message}），跳过`)
    return
  }

  const release = (): void => {
    if (!holding) return
    holding = false
    try {
      // 只删自己写的那份 —— 别人接手过就别动
      if (readLock()?.pid === process.pid) fs.unlinkSync(LOCK_FILE)
    } catch {
      /* 无所谓 */
    }
  }
  process.once('exit', release)
  process.once('SIGINT', release)
  process.once('SIGTERM', release)
}
