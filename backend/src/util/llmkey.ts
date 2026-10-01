import {writeEnvVar} from './envfile'

/** 把 API Key 写入 .env */
export function saveKeyToEnv(key: string): boolean {
  return writeEnvVar('LLM_API_KEY', key)
}
