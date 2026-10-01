import fs from 'node:fs'
import path from 'node:path'
import type http from 'node:http'
import {ROOT_DIR} from '../config'

/**
 * 开发模式：把 Vite 直接挂进后端进程。
 *
 * 这样 `npm run web` 一个命令就同时提供 API + 前端，
 * 改前端代码**立刻生效，完全不需要 build**。
 *
 * 生产环境不装 vite（它是 devDependency），所以这里是动态 import，
 * 拿不到就安静降级成「托管 frontend/dist」。
 */

const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend')
const VITE_CONFIG = path.join(FRONTEND_DIR, 'vite.config.ts')

export function distIndexPath(): string {
  return path.join(FRONTEND_DIR, 'dist', 'index.html')
}

export function hasBuiltFrontend(): boolean {
  return fs.existsSync(distIndexPath())
}

export interface ViteDev {
  /** 处理一个请求；返回 false 表示 Vite 没接（例如是 /api 请求） */
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
  /** 端口之类，仅用于日志 */
  info: string
  close: () => Promise<void>
}

type ConnectMiddleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: (err?: unknown) => void
) => void

/**
 * 尝试挂载 Vite 开发服务器。
 * 返回 null 表示不可用（没装 vite / 源码不在 / 出错），调用方走静态托管。
 */
export async function mountViteDev(): Promise<ViteDev | null> {
  if (!fs.existsSync(path.join(FRONTEND_DIR, 'index.html'))) return null

  let viteFactory: ((opts: unknown) => Promise<unknown>) | undefined
  try {
    // 动态 import：生产环境没装 vite（devDependency）也不会崩
    const mod = (await import('vite')) as unknown as {
      createServer: (opts: unknown) => Promise<unknown>
    }
    viteFactory = mod.createServer
  } catch {
    return null
  }
  if (!viteFactory) return null

  try {
    const vite = (await viteFactory({
      configFile: VITE_CONFIG,
      root: FRONTEND_DIR,
      // 中间件模式：不自己监听端口，交给我们的 http server
      server: {middlewareMode: true},
      // SPA：找不到文件就回退到 index.html
      appType: 'spa'
    })) as {
      middlewares: unknown
      close: () => Promise<void>
    }

    const middlewares = vite.middlewares as unknown as ConnectMiddleware

    return {
      info: 'Vite 开发模式（改前端代码立刻生效，不需要 build）',
      handle: (req, res) => {
        // /api 由我们自己的路由处理，不交给 Vite
        if ((req.url ?? '').startsWith('/api/')) return false
        middlewares(req, res, () => {
          if (!res.writableEnded) {
            res.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'})
            res.end('Not Found')
          }
        })
        return true
      },
      close: () => vite.close()
    }
  } catch (e) {
    console.warn(`[vite] 开发模式挂载失败：${(e as Error).message}`)
    return null
  }
}
