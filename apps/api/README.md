# @localehub/api

NestJS REST API（`/api/v1`）。控制器只做参数校验与编排，业务逻辑全部在 `@localehub/domain`，
因此 REST、Remote MCP、Local MCP 与 Worker 使用同一套实现。

```bash
pnpm --filter @localehub/api dev     # ts-node，开发
pnpm --filter @localehub/api build
node apps/api/dist/main.js
```

## 结构

```text
src/
├── common/
│   ├── auth.ts                  全局 AuthGuard（会话 JWT 或 lh_mcp_* Token → ActorContext）
│   ├── api-exception.filter.ts  统一错误信封（稳定错误码）
│   ├── response.interceptor.ts  统一成功信封
│   ├── request-context.*.ts     request_id + AsyncLocalStorage（贯穿日志与审计）
│   ├── audit.service.ts         审计写入（自动脱敏）
│   ├── prisma.service.ts        PrismaClient + TenantPrisma（RLS 上下文）
│   ├── queue.service.ts         BullMQ 生产者（Redis 不可用不影响请求）
│   └── zod.pipe.ts              zod → 422 VALIDATION_ERROR
└── modules/                     auth / projects / translations / sync / tokens / qa / misc / mcp / health
```

## 授权模型

- `AuthGuard` 解析凭据 → `ActorContext { organizationId, orgRole, projectRoles, scopes, boundProjectIds }`。
- 路由级：`@RequireRole(Role.X)`（仅当路由带 projectId 时在 guard 生效）、`@RequireScopes('sync.push')`。
- 服务级：`assertRole` / `assertScope` / `assertProjectBound` / `assertLocaleAllowed`
  —— 这是真正的兜底，每个写操作都会做项目管理范围的校验。
- 数据级：每次查询都在 `TenantPrisma.withOrganization()` 的 RLS 事务中执行。

## 错误码

见 [docs/API.md](../../docs/API.md#8-错误码)。新增错误码必须同步文档。
