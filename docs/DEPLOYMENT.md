# 部署与运维

## 1. 本地开发

```bash
pnpm install
pnpm db:up                 # postgres:55432, redis:56379（避开本机占用）
pnpm db:migrate
pnpm db:generate
pnpm -r build
pnpm db:seed
pnpm dev:api & pnpm dev:web
```

## 2. 生产部署

### 2.0 也可以用整套容器在本地跑一遍

```bash
docker compose up -d --build        # postgres / redis / api / worker / mcp-remote / web
open http://localhost:3000
```

这条栈和本文后面的开发方式等价，但**镜像与线上一致**，所以它能验证到宿主进程验证不到的东西：
Next 的 `/api/v1` 转发目标在构建期就写死了（见 `docker/web.Dockerfile` 里的说明），运行期再设
`API_BASE_URL_INTERNAL` 是无效的。

两个只在容器里才会踩到的坑，已在本仓库修好，改 compose 时别退回去：

- **web 的转发目标必须是构建参数**。只写运行环境变量时，容器照常启动、HTML 路由照常 200，
  但所有 `/api/v1` 调用都会 500。
- **api 在开发栈里要显式 `ALLOW_INSECURE_HTTP: "true"`**。`NODE_ENV=production` 且没有 TLS 时，
  登录会成功，之后每个请求都 403 `INSECURE_TRANSPORT`。

### 2.1 准备 Secret

生产环境**不使用**明文环境变量。创建 `./secrets/` 目录：

```bash
mkdir -p secrets
openssl rand -base64 36 > secrets/auth_secret
openssl rand -base64 32 > secrets/encryption_key
openssl rand -base64 24 > secrets/postgres_password
openssl rand -base64 24 > secrets/redis_password
echo "postgresql://localehub_app:$(cat secrets/app_db_password)@postgres:5432/localehub?schema=public" > secrets/database_url
echo "redis://:$(cat secrets/redis_password)@redis:6379" > secrets/redis_url
chmod 600 secrets/*
```

`secrets/` 已在 `.gitignore` 与 `.dockerignore` 中排除。

### 2.1.1 部署前必须定的公开地址

这三项不是密钥，但**必须**按实际域名给值：生产 overlay 不提供本地默认值，否则页面会把
`localhost` 当成真实地址发给客户端和开发者。

| 变量             | 含义                                                    | 例                                 |
| ---------------- | ------------------------------------------------------- | ---------------------------------- |
| `MCP_PUBLIC_URL` | Remote MCP 对外的完整地址，Web UI 与 CLI 都按它生成配置 | `https://localehub.example/mcp`    |
| `API_BASE_URL`   | 平台 API 的对外地址，CLI 按它连接平台                   | `https://localehub.example/api/v1` |
| `CORS_ORIGINS`   | 浏览器访问 Web 的 origin（同源部署就是它自己）          | `https://localehub.example`        |

```bash
export MCP_PUBLIC_URL=https://localehub.example/mcp
export API_BASE_URL=https://localehub.example/api/v1
export CORS_ORIGINS=https://localehub.example
```

`ALLOW_INSECURE_HTTP` 由生产 overlay 固定为 `"false"`、`TRUST_PROXY` 固定为 `"1"`（前面恰好
是 nginx 一跳），无需手工设置；开发用的 `compose.yaml` 里 `ALLOW_INSECURE_HTTP: "true"` 只对
本地明文栈生效。

### 2.2 TLS 证书

把 `fullchain.pem` / `privkey.pem` 放到 `docker/nginx/certs/`。

### 2.3 启动

```bash
docker compose -f compose.yaml -f compose.production.yaml up -d --build
docker compose -f compose.yaml -f compose.production.yaml run --rm \
  -e DATABASE_URL="$(cat secrets/database_url)" api \
  node -e "require('child_process').execSync('pnpm --filter @localehub/database exec prisma migrate deploy',{stdio:'inherit'})"
docker compose ps
docker compose logs -f api worker mcp-remote
```

生产覆盖的关键差异：

| 项             | 开发                        | 生产                         |
| -------------- | --------------------------- | ---------------------------- |
| 端口           | postgres/redis 暴露到宿主机 | 不暴露                       |
| Secret         | `env.example` 明文示例      | `*_FILE` + docker secrets    |
| 副本           | 1                           | api/web/worker 各 2          |
| 资源限制       | 无                          | 有                           |
| 只读根文件系统 | 否                          | api 容器 `read_only` + tmpfs |
| 入口           | 直连                        | nginx（TLS / HSTS / 安全头） |

### 2.4 备份与恢复

```bash
# 逻辑备份
docker compose exec -T postgres pg_dump -U postgres -Fc localehub > backup-$(date +%F).dump
# 恢复演练（务必在独立实例验证）
docker compose exec -T postgres pg_restore -U postgres -Cd localehub_test < backup-2026-11-09.dump
```

建议：每日全量 + WAL 归档；每季度做一次恢复演练并记录耗时。

## 3. 可观测性

| 端点 / 来源                 | 内容                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `GET /api/v1/health`        | 服务与数据库状态                                                                  |
| `GET /api/v1/health/ready`  | 就绪探针                                                                          |
| `GET /api/v1/system/queues` | 队列深度（BullMQ）                                                                |
| 容器 healthcheck            | api 用 Node fetch 探活；postgres/redis 用原生探针                                 |
| 日志                        | 结构化 stdout；含 `request_id`；不记录 Token/密钥/源码正文                        |
| 审计                        | `audit_logs` 表：actor、action、resource、project、sync_session、mcp_client、耗时 |

需要关注的指标：同步会话失败/部分失败率、`REVISION_MISMATCH` 次数（预览过期频率）、
冲突数量与解决时长、`APPLY_REJECTED_STALE_PREVIEW` 次数（本地并发编辑频率）、
队列积压、apply report 回传延迟。

## 4. 升级

```bash
git pull
docker compose -f compose.yaml -f compose.production.yaml build
docker compose -f compose.yaml -f compose.production.yaml run --rm api \
  node -e "require('child_process').execSync('pnpm --filter @localehub/database exec prisma migrate deploy',{stdio:'inherit'})"
docker compose -f compose.yaml -f compose.production.yaml up -d
```

迁移只做向前兼容的增量变更（新增列可空、新增表）；破坏性变更需要单独发布并先备份。

## 5. CI Runner 里跑 CLI（可选）

CLI 默认装在开发者机器。若必须在 CI Runner 内以容器运行：

```bash
docker run --rm -i \
  --network host \
  -v "$PWD/repo":/workspace:rw \
  -w /workspace \
  -e LOCALEHUB_TOKEN -e LOCALEHUB_WORKSPACE=/workspace \
  localehub-api:latest node apps/cli/dist/bin.js scan
```

把 `scan` 换成 `sync preview` / `sync push --confirm` / `apply --confirm` / `qa` 等即可；
退出码 0 表示通过、2 表示用法错误、3 表示冲突或被阻断的写回（见 `localehub --help`）。

**禁止**挂载 `/`、`$HOME` 或 `/var/run/docker.sock`；`-v` 只能指向具体仓库目录。

## 6. 已知部署限制

- `docker/api.Dockerfile` 会在镜像内 `pnpm install` 全部 workspace 依赖，首次构建对网络依赖较大。
- Web 镜像未做 standalone 输出裁剪，镜像偏大；后续可切换 `output: 'standalone'`。
- 对象存储（S3/MinIO）尚未接入，导入导出仍走 JSON 响应体。
