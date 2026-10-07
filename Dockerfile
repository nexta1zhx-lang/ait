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

# 源码（.dockerignore **不**排除 dist —— 见下面的 PREBUILT）
COPY . .

# PREBUILT=0（默认）：服务器上从源码编译（老行为）。
# PREBUILT=1：用包里的预构建产物，跳过编译（release.sh 会传这个 build-arg）。
ARG PREBUILT=0

# 后端 tsc -> backend/dist，前端 vite -> frontend/dist。
#
# PREBUILT=1：用 **release.sh 在本机已经构建好**、随包发过来的那两个 dist，
#   跳过编译。为什么值得这么绕：服务器是 2 核 Lightsail，`tsc` ≈31 秒 +
#   `vite build` ≈51 秒（777 个模块）= **111 秒**，而这一步在本机只是几秒钟的事。
#   ⚠️ 两个产物**都**在、且都非空才认；缺一个就退回源码编译 ——
#      宁可慢一点，也不要做出一个「半个旧产物」的镜像。
RUN if [ "${PREBUILT}" = "1" ] \
       && [ -s backend/dist/server.js ] \
       && [ -s frontend/dist/index.html ]; then \
      echo "=== PREBUILT=1：用随包带来的预构建产物，跳过 build:all ==="; \
      ls -l backend/dist/server.js frontend/dist/index.html; \
    else \
      echo "=== 从源码编译（PREBUILT=${PREBUILT}）==="; \
      npm run build:all; \
    fi

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
