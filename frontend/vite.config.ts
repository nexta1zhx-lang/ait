import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

/**
 * 前端（Vue3 SPA）—— 与后端完全分离。
 *
 * 源码在 frontend/src，构建产物在 frontend/dist。
 * 后端（backend/src/server.ts）会托管这个目录，找不到文件时回退到
 * index.html，所以 /knowledge、/usage 这类前端路由刷新也能打开。
 *
 * 想让前端独立部署也可以：后端所有 /api 都开了 CORS。
 *   npm run ui:dev    开发（Vite 把 /api 代理到 :8787）
 *   npm run ui:build  构建
 */
export default defineConfig({
  root: __dirname,
  base: '/',
  plugins: [vue()],
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:8787',
        changeOrigin: true
      }
    }
  }
})
