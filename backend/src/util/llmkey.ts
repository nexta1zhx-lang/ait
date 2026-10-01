import {writeEnvVar} from './envfile'
import {ask, askHidden, isInteractive} from './prompt'

/** 把 API Key 写入 .env，并把 LLM_MOCK 设为 0 */
export function saveKeyToEnv(key: string): boolean {
  const a = writeEnvVar('LLM_API_KEY', key)
  const b = writeEnvVar('LLM_MOCK', '0')
  return a && b
}

export interface ResolveApiKeyOptions {
  /** 命令行显式传入的 Key（优先级最高） */
  provided?: string
  /** 从 .env 读到的 Key */
  fromEnv: string
  baseUrl: string
  /** 用途说明，用在提示语里，如「图片转写」 */
  purpose: string
  /** 允许交互式询问（默认 true）。非 TTY 时会直接抛错 */
  allowPrompt?: boolean
}

/**
 * 统一的 API Key 解析：命令行 > .env > 交互式输入。
 * 交互式输入时可选写入 .env，避免每次都要粘贴。
 */
export async function resolveApiKey(
  opts: ResolveApiKeyOptions
): Promise<string> {
  if (opts.provided) return opts.provided
  if (opts.fromEnv) return opts.fromEnv

  if (opts.allowPrompt === false || !isInteractive()) {
    throw new Error(
      `${opts.purpose}需要 LLM_API_KEY。请在 .env 里填写，或用 --api-key 传入。`
    )
  }

  process.stdout.write('\n')
  process.stdout.write(`• 未检测到 LLM_API_KEY（接口: ${opts.baseUrl}）\n`)
  process.stdout.write(
    '  请粘贴你的 API Key 后回车（输入过程不回显）；按 Ctrl+C 可取消。\n'
  )
  const key = await askHidden('  API Key: ')
  if (!key) throw new Error('未提供 API Key，已退出。')

  process.stdout.write('  是否保存到 .env 以便下次自动使用？(y/N) ')
  const answer = await ask('')
  if (/^y(es)?$/i.test(answer)) {
    process.stdout.write(
      saveKeyToEnv(key)
        ? '• 已保存到 .env（并将 LLM_MOCK 设为 0）\n'
        : '• 保存到 .env 失败，本次仍会使用该 Key。\n'
    )
  }
  return key
}
