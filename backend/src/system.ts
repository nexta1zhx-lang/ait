/**
 * 服务器 / 进程 / 数据库的实时状态。
 *
 * 给「我的 → 服务器」那一页用（前端按秒轮询，自己攒成曲线）。
 *
 * **只读，不落库**：每次请求现采一遍。全都走 Node 内置模块 + 一条 SQL，
 * 所以 macOS（本地开发）和 Linux（线上）都能跑，不用装任何东西。
 *
 *   os.*            主机：负载、内存、CPU 核数
 *   process.*       进程：RSS / heap、运行时长、CPU 使用率
 *   fs.statfs       磁盘（Node 18.15+；取不到就返回 null，不报错）
 *   pg_*            数据库大小 / 连接数 / 各表行数
 */
import fs from 'node:fs'
import os from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {queryOne} from './db/client'

/** 异步跑一条命令（读 `vm_stat` 用） */
const pexec = promisify(execFile)

export interface ServerStatus {
  /** 采样时刻（毫秒） */
  now: number
  host: {
    platform: string
    arch: string
    release: string
    hostname: string
    cpuModel: string
    cpuCount: number
    /** 1 / 5 / 15 分钟平均负载（Windows 上恒为 0） */
    load: [number, number, number]
    uptimeSec: number
    memTotalB: number
    /**
     * 还算「能用」的内存（口径见 `memInfo`）—— **不是** `os.freemem()`。
     * 用 `memTotalB - memAvailB` 才是「用了多少」。
     */
    memAvailB: number
    memUsedPct: number
    /** 这个数是从哪来的：`vm_stat` / `MemAvailable` / `freemem` */
    memSource: string
    diskTotalB: number | null
    diskFreeB: number | null
    diskUsedPct: number | null
  }
  proc: {
    pid: number
    nodeVersion: string
    uptimeSec: number
    /**
     * 进程 CPU 使用率（%）。按**两次采样的差值**算 —— 所以要连着请求两次才有意义，
     * 第一次（或隔很久）会偏小/偏大，前端第一秒那个点忽略即可。
     * 单核跑满 = 100%，多核并行可以超过 100%。
     */
    cpuPct: number
    rssB: number
    heapUsedB: number
    heapTotalB: number
    externalB: number
  }
  db: {
    ok: boolean
    version: string | null
    error?: string
    sizeB: number | null
    connections: number | null
    maxConnections: number | null
    /** 主要业务表的行数；-1 = 这张表还不存在 */
    tables: {name: string; rows: number}[]
  }
  /** 外围服务（docker 容器 / 监听端口）—— 见 `dockerPart` / `portsPart` */
  services: {
    docker: ServiceGroup
    ports: ServiceGroup
  }
  /** 这次采样本身花了多久（毫秒）—— 顺手量一下，能看出后端是不是在卡 */
  tookMs: number
  /**
   * 采样历史（只包含 `?minutes=` 指定那段）。
   *
   * ⚠️ 只有 **HTTP 响应**里带它 —— `collectServerStatus()` 本身不产
   *（它的返回类型是 `ServerStatusCore`）。曲线就画这个。
   */
  history: Sample[]
}

/** 上一次采样的进程 CPU 累计值（算使用率要差值） */
let lastCpu = {at: Date.now(), usage: process.cpuUsage()}

/** 业务表（行数展示用；表名是白名单常量，拼进 SQL 是安全的） */
const TABLES = [
  'analyses',
  'knowledge',
  'llm_usage',
  'ai_docs',
  'ai_doc_versions',
  'tag_templates',
  'contract_store'
]

function pct(used: number, total: number): number {
  if (!(total > 0)) return 0
  return Math.round((used / total) * 1000) / 10
}

/** 磁盘：`fs.statfs` 在 Node 18.15+ 才有，拿不到就返回 null */
async function diskUsage(): Promise<{totalB: number; freeB: number} | null> {
  try {
    const st = await fs.promises.statfs('/')
    return {totalB: st.blocks * st.bsize, freeB: st.bavail * st.bsize}
  } catch {
    return null
  }
}

/**
 * 「内存用了多少」**不能直接用 `os.freemem()`**。
 *
 * macOS 上它只算 `Pages free` —— 文件缓存、可回收的 inactive / speculative /
 * purgeable 全被当成「已用」，16G 的机器常年显示 **99%**
 *（用户 2026-10-04 就是这么发现不对劲的）。
 * Linux 同理：`MemFree` 不含可回收的 cache，要看 `MemAvailable`。
 *
 * 所以按平台各用各的口径，并把 `source` 一并带回去 —— 页面上能看出这个数是哪来的。
 */
async function memInfo(): Promise<{
  totalB: number
  availB: number
  source: string
}> {
  const totalB = os.totalmem()

  // Linux：MemAvailable 才是「不换页的前提下还能用多少」
  if (process.platform === 'linux') {
    try {
      const txt = await fs.promises.readFile('/proc/meminfo', 'utf8')
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(txt)
      if (m) {
        return {totalB, availB: Number(m[1]) * 1024, source: 'MemAvailable'}
      }
    } catch {
      /* 读不到就走下面的兜底 */
    }
  }

  // macOS：free + inactive + speculative + purgeable 才算「可用」
  if (process.platform === 'darwin') {
    try {
      const {stdout} = await pexec('vm_stat')
      const out = String(stdout)
      const pageSize = Number(/page size of (\d+)/.exec(out)?.[1] ?? 0)
      const pages = (k: string) =>
        Number(new RegExp(`Pages ${k}:\\s+(\\d+)\\.`).exec(out)?.[1] ?? 0)
      const free =
        pages('free') +
        pages('inactive') +
        pages('speculative') +
        pages('purgeable')
      if (pageSize > 0 && free > 0) {
        return {totalB, availB: free * pageSize, source: 'vm_stat'}
      }
    } catch {
      /* 同上 */
    }
  }

  // 兜底（Windows 等）：只能信 freemem
  return {totalB, availB: os.freemem(), source: 'freemem'}
}

async function dbPart(): Promise<ServerStatus['db']> {
  const empty = {
    ok: false,
    version: null,
    sizeB: null,
    connections: null,
    maxConnections: null,
    tables: [] as {name: string; rows: number}[]
  }
  try {
    const head = await queryOne<{
      version: string
      size: string
      conns: string
      maxconn: string
    }>(
      `SELECT version() AS version,
              pg_database_size(current_database())::text AS size,
              (SELECT count(*) FROM pg_stat_activity
                WHERE datname = current_database())::text AS conns,
              current_setting('max_connections') AS maxconn`
    )

    const tables: {name: string; rows: number}[] = []
    for (const t of TABLES) {
      try {
        const r = await queryOne<{n: string}>(
          `SELECT count(*)::text AS n FROM ${t}`
        )
        tables.push({name: t, rows: Number(r?.n ?? 0)})
      } catch {
        // 表不存在（还没建 / 已废弃）——标 -1，别把整个接口带崩
        tables.push({name: t, rows: -1})
      }
    }

    return {
      ok: true,
      version: head?.version
        ? head.version.split(' ').slice(0, 2).join(' ')
        : null,
      sizeB: head?.size ? Number(head.size) : null,
      connections: head?.conns ? Number(head.conns) : null,
      maxConnections: head?.maxconn ? Number(head.maxconn) : null,
      tables
    }
  } catch (e) {
    return {...empty, error: (e as Error).message}
  }
}

/**
 * 一组外围服务的监测结果。
 *
 * ⚠️ **拿不到就 `ok:false` + `error`，不要假装「没问题」** ——
 * 「看不到」和「都正常」在运维上完全是两回事。
 */
export interface ServiceGroup {
  ok: boolean
  error?: string
  items: ServiceItem[]
}

export interface ServiceItem {
  /** 主名字（容器名 / 命令名） */
  name: string
  /** 补充（镜像 / 监听地址） */
  detail: string
  /** 状态文字（`Up 3 hours` / PID / `LISTEN`） */
  status: string
  /** 是不是在正常运行（决定那个小圆点颜色） */
  up: boolean
}

/** 命令报错只留一小段（`command not found` 这种够用，别把整段 usage 塞进去） */
function shortErr(e: unknown): string {
  const m = (e as Error)?.message ?? String(e)
  return m.length > 140 ? `${m.slice(0, 140)}…` : m
}

/** `lsof` 会把命令名里的空格写成 `\x20`（`Code\x20H`），还原一下 */
function unescapeLsof(s: string): string {
  return s.replace(/\\x20/gi, ' ')
}

/**
 * 按 key 去重（保序、最多 40 条）。
 *
 * `lsof` 会把同一个套接字按 IPv4/IPv6 各报一行（`rapportd` 那种就重复了），
 * 不去重页面上看着很脏。
 */
function dedupe(rows: {key: string; item: ServiceItem}[]): ServiceItem[] {
  const seen = new Set<string>()
  const out: ServiceItem[] = []
  for (const r of rows) {
    if (seen.has(r.key)) continue
    seen.add(r.key)
    out.push(r.item)
    if (out.length >= 40) break
  }
  return out
}

/**
 * docker 容器。
 *
 * ⚠️ 这段代码在**两种环境**下跑，行为不一样：
 *   · 本机（macOS + Docker Desktop）：直接用宿主机的 `docker` ✓
 *   · 线上：app 自己**跑在容器里**（`ca-app`），默认既没 `docker` 命令、
 *     也够不到宿主机的 daemon。所以 **2026-10-05 起**两边都补上了：
 *     镜像里 `apk add docker-cli iproute2`、compose 给 app 挂了
 *     `/var/run/docker.sock`（见 `Dockerfile` / `docker-compose.prod.yml`）。
 *
 * ⚠️⚠️ 挂 socket 等于把这个容器提到**宿主机 root 那一档**（socket 是读写通道，
 * compose 里那个 `:ro` 只表明意图，挡不住 API 调用）。当时的权衡：自用单管理员、
 * 三个容器同一套 compose、应用本来就攥着交易所只读 key 和大模型 key ——
 * 边际风险可接受；但**以后要给别的东西开这个容器，得先把那条挂载拿掉**。
 */
async function dockerPart(): Promise<ServiceGroup> {
  try {
    const {stdout} = await pexec(
      'docker',
      ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'],
      {timeout: 4000}
    )
    const items = String(stdout)
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [name = '', image = '', status = ''] = l.split('\t')
        return {name, detail: image, status, up: /^Up\b/i.test(status)}
      })
    return {ok: true, items}
  } catch (e) {
    return {ok: false, error: shortErr(e), items: []}
  }
}

/**
 * 监听中的 TCP 端口。
 *
 * macOS 用 `lsof -nP -iTCP -sTCP:LISTEN`（`netstat` 输出更难解），
 * Linux 用 `ss -lnt`（`netstat` 新系统上已经默认不装了）。
 * 两个都拿不到就 `ok:false`。
 */
async function portsPart(): Promise<ServiceGroup> {
  try {
    if (process.platform === 'darwin') {
      const {stdout} = await pexec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
        timeout: 4000
      })
      // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
      const rows = String(stdout)
        .split('\n')
        .slice(1)
        .map(l => l.split(/\s+/))
        .filter(c => c.length >= 9)
      return {
        ok: true,
        items: dedupe(
          rows.map(c => ({
            key: `${c[0]}|${c[8]}`,
            // ⚠️ `lsof` 会把命令名里的空格转成 `\x20`（`Code\x20H`），不解一下很难看
            item: {
              name: unescapeLsof(c[0]),
              detail: unescapeLsof(c[8]),
              status: `PID ${c[1]}`,
              up: true
            }
          }))
        )
      }
    }

    const {stdout} = await pexec('ss', ['-lnt'], {timeout: 4000})
    // State Recv-Q Send-Q Local-Address:Port Peer-Address:Port
    const rows = String(stdout)
      .split('\n')
      .slice(1)
      .map(l => l.trim().split(/\s+/))
      .filter(c => c.length >= 5)
      /*
       * ⚠️⚠️ **本机地址是第 3 列（`c[3]`），第 4 列是对端** —— 原来两处都写的 `c[4]`，
       * 于是页面上显示的是 `0.0.0.0:*` / `*:*` 这种对端地址，等于没显示端口。
       * 这个 bug 一直没被看见，是因为**这条 Linux 分支从没真跑过**：Mac 上走 lsof，
       * 线上容器里没有 `ss`（2026-10-05 装 iproute2 之后才第一次真跑）——
       * 典型的「没端到端跑过的分支里躺着错」。
       */
      // 127.0.0.11 是 Docker 内嵌 DNS，每个容器都有，跟「服务在听什么」无关
      .filter(c => !c[3].startsWith('127.0.0.11:'))
    return {
      ok: true,
      items: dedupe(
        rows.map(c => ({
          key: c[3],
          item: {name: c[3], detail: `队列 ${c[1]}`, status: 'LISTEN', up: true}
        }))
      )
    }
  } catch (e) {
    return {ok: false, error: shortErr(e), items: []}
  }
}

/** 一个采样点（画曲线用的精简字段） */
export interface Sample {
  /** 时间戳（毫秒） */
  t: number
  /** 进程 CPU 使用率 % */
  cpu: number
  /** 内存使用率 % */
  mem: number
  /** 进程 RSS（MB） */
  rss: number
  /** 进程 heapUsed（MB） */
  heap: number
}

/**
 * 采样历史（**只在进程内存里**）。
 *
 * 用户 2026-10-04：「服务器的统计图可以选择周期」。
 *
 * 之前曲线是**前端按 3 秒轮询自己攒的** —— 那样选「1 小时」得等一小时，
 * 而且切走再回来就清零。改成后端自己定时采、滚动保留：
 * 任何时刻进来都能看到最近这段的**真实**历史。
 *
 * 不落库：监测数据本来就是「这台机器**当下**怎么样」，
 * 落了还得天天清理（见 `db/prune.ts`）。
 */
const HISTORY_MAX = 1440 // 5 秒一个 → 2 小时
const SAMPLE_MS = 5000
const history: Sample[] = []

function pushSample(s: ServerStatusCore): void {
  history.push({
    t: s.now,
    cpu: s.proc.cpuPct,
    mem: s.host.memUsedPct,
    rss: Math.round(s.proc.rssB / 1048576),
    heap: Math.round(s.proc.heapUsedB / 1048576)
  })
  if (history.length > HISTORY_MAX) {
    history.splice(0, history.length - HISTORY_MAX)
  }
}

/** 取最近 `minutes` 分钟的采样点（前端切周期就传这个） */
export function recentSamples(minutes: number): Sample[] {
  const since = Date.now() - Math.max(1, minutes) * 60_000
  return history.filter(s => s.t >= since)
}

/**
 * 起一个后台采样定时器（server 启动时调一次）。
 *
 * 每 5 秒完整采一次（含 `vm_stat` / `/proc/meminfo`），开销很小；
 * 这样**不管有没有人在看，历史都是连续的**。
 * `unref()`：别因为它让进程退不掉。
 */
export function startSampling(): void {
  const tick = () => {
    void collectServerStatus().catch(() => {
      /* 采不到就算了（比如数据库临时不通），下一个 tick 再试 */
    })
  }
  tick()
  setInterval(tick, SAMPLE_MS).unref()
}

/** 没有 `history` 的那部分（`collectServerStatus` 每次的产出） */
export type ServerStatusCore = Omit<ServerStatus, 'history'>

/** 采一次（不缓存：页面要的是「此刻」） */
export async function collectServerStatus(): Promise<ServerStatusCore> {
  const t0 = Date.now()
  const cpus = os.cpus()
  const mem = await memInfo()

  // 进程 CPU：microseconds 是**累计**值，除以真实经过的时间才是占比
  const at = Date.now()
  const usage = process.cpuUsage()
  const elapsedMs = Math.max(1, at - lastCpu.at)
  const deltaUs =
    usage.user - lastCpu.usage.user + (usage.system - lastCpu.usage.system)
  const cpuPct = Math.round((deltaUs / 1000 / elapsedMs) * 1000) / 10
  lastCpu = {at, usage}

  const disk = await diskUsage()
  const mu = process.memoryUsage()
  const [db, docker, ports] = await Promise.all([
    dbPart(),
    dockerPart(),
    portsPart()
  ])

  const out: ServerStatusCore = {
    now: at,
    host: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      cpuModel: cpus[0]?.model?.trim() ?? '未知',
      cpuCount: cpus.length,
      load: os.loadavg() as [number, number, number],
      uptimeSec: Math.round(os.uptime()),
      memTotalB: mem.totalB,
      memAvailB: mem.availB,
      memUsedPct: pct(mem.totalB - mem.availB, mem.totalB),
      memSource: mem.source,
      diskTotalB: disk?.totalB ?? null,
      diskFreeB: disk?.freeB ?? null,
      diskUsedPct: disk ? pct(disk.totalB - disk.freeB, disk.totalB) : null
    },
    proc: {
      pid: process.pid,
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
      cpuPct: Math.max(0, cpuPct),
      rssB: mu.rss,
      heapUsedB: mu.heapUsed,
      heapTotalB: mu.heapTotal,
      externalB: mu.external
    },
    db,
    services: {docker, ports},
    tookMs: Date.now() - t0
  }

  // 顺手记一个采样点（曲线用的），不管是定时器还是 HTTP 请求触发的
  pushSample(out)
  return out
}
