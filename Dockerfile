# syntax=docker/dockerfile:1
#
# 生产镜像：一个容器同时提供 API（/api/*）和前端静态文件（frontend/dist）。
#
# 构建：docker build -t crypto-advisor .
# 运行：docker run --env-file .env -p 8787:8787 crypto-advisor
#
# ⚠️ 运行时不需要 tsx / vite —— NODE_ENV=production 时后端会跳过 Vite 中间件，
#    直接托管 frontend/dist（见 backend/src/devtools/vite-dev.ts）。

# ---------------------------------------------------------------- 构建阶段
FROM node:22-alpine AS build
WORKDIR /app

# 依赖单独一层：只改源码时不会重装依赖
COPY package.json package-lock.json ./
RUN npm ci

# 源码（.dockerignore 已排除 node_modules / dist / .env / logs）
COPY . .

# 后端 tsc -> backend/dist，前端 vite -> frontend/dist
RUN npm run build:all

# ---------------------------------------------------------------- 运行阶段
FROM node:22-alpine AS runtime
WORKDIR /app

# 「服务器监测」页要能从容器里看到宿主机上的容器 / 监听端口（2026-10-05）：
#   · docker-cli —— 容器里得有 `docker` 这个可执行文件（Alpine 包，约 32MB）
#   · iproute2   —— 提供 `ss`，用来读监听端口（busybox 只带 netstat，没有 ss）
# ⚠️ 光装 CLI 不够：还得在 compose 里把 `/var/run/docker.sock` 挂进来，
#    否则 `docker ps` 会报 Cannot connect to the Docker daemon。
RUN apk add --no-cache docker-cli iproute2

ENV NODE_ENV=production \
    PORT=8787

# 只装生产依赖（ccxt / openai / pg / zod / yaml / dotenv / commander）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 只带运行时真正要读的东西。
# ⚠️ backend/src/config.ts 里 ROOT_DIR = backend/dist/../.. = /app，
#    所以下面这些路径必须保持这个目录结构，不能挪。
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY config ./config
COPY data ./data

EXPOSE 8787

# 健康检查：/api/health 会顺带报数据库与提示词状态。
# ⚠️ 它的 HTTP 状态码**恒为 200**，所以真正的判据是响应体里的 ok（= 数据库通不通）；
#    只看 r.ok 的话数据库挂了也永远显示 healthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/dist/server.js"]
