/**
 * 宿主机 agent 的公共 HTTP 客户端。
 *
 * 服务器上跑着两个同构的 root 小服务，都只监听 docker0 网关 + 令牌鉴权：
 *
 *   · xrayd      172.17.0.1:2097   代理订阅的用户管理（见 ./proxy.ts）
 *   · rustdeskd  172.17.0.1:2098   RustDesk 的只读取数（见 ./rustdesk.ts）
 *
 * 两者「连不上 / 令牌不对 / 返回非 2xx」三种失败的**措辞必须一致** ——
 * 页面上那行红字是给人照着排障的（「没配 XRAYD_TOKEN」和「服务器上
 * systemctl status xrayd 看看」都得说清楚），所以收成一份，不各写一遍。
 */
export class HostAgentError extends Error {}

export interface HostAgentOptions {
  /** 宿主机 agent 的地址，例如 `http://172.17.0.1:2098` */
  endpoint: string
  token: string
  /** 出错信息里的名字，例如 `xrayd` */
  name: string
  /** 没配令牌时怎么提示 */
  tokenHint: string
  /** 连不上时补一句「怎么办」 */
  downHint: string
  timeoutMs?: number
}

export interface HostAgent {
  /** 出错信息里要显示的目标地址 */
  readonly endpoint: string
  get<T>(path: string): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
}

export function hostAgent(o: HostAgentOptions): HostAgent {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!o.token) throw new HostAgentError(o.tokenHint)

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000)
    try {
      const res = await fetch(o.endpoint + path, {
        method,
        signal: ctl.signal,
        headers: {
          'X-Admin-Token': o.token,
          ...(body === undefined ? {} : {'Content-Type': 'application/json'})
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      })
      const text = await res.text()
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        /* 非 JSON 就当纯文本报错 */
      }
      if (!res.ok) {
        const detail = (parsed as {error?: string} | null)?.error ?? text.slice(0, 200)
        throw new HostAgentError(`${o.name} 返回 ${res.status}：${detail}`)
      }
      return parsed as T
    } catch (e) {
      if (e instanceof HostAgentError) throw e
      const err = e as Error
      const why = err.name === 'AbortError' ? '超时' : err.message
      throw new HostAgentError(`连不上 ${o.name}（${o.endpoint}，${why}）—— ${o.downHint}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    endpoint: o.endpoint,
    get: <T>(path: string) => call<T>('GET', path),
    put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body)
  }
}
