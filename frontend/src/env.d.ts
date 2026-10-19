/// <reference types="vite/client" />

declare module '*.vue' {
  import type {DefineComponent} from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

/**
 * 打包成 App（Capacitor）时用得到的环境变量。
 *
 * 用法：`VITE_API_BASE=https://测试服 npm run ui:build`
 * 不写的话，原生壳里默认指向 `https://bitcoooin.cn`（见 `api.ts` 的 `API_BASE`）。
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** 构建时注入的前端版本号（`package.json` 的 version，见 `vite.config.ts`） */
declare const __APP_VERSION__: string
