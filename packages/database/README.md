# @localehub/database

Prisma schema, migrations (including row level security) and the tenant aware client wrapper.

## 命令

```bash
pnpm --filter @localehub/database generate        # prisma generate
pnpm --filter @localehub/database migrate:deploy  # 应用迁移（owner 连接）
pnpm --filter @localehub/database migrate:dev --name <change>
```

迁移使用 owner 连接（需要 DDL 权限与 shadow database）：

```bash
DATABASE_URL="$MIGRATE_DATABASE_URL" pnpm --filter @localehub/database migrate:deploy
```

## 租户隔离

`TenantPrisma` 提供两种访问模式：

```ts
// 1. 普通请求：事务内 SET LOCAL app.current_org_id，RLS 生效
await tenant.withOrganization(organizationId, async (tx) => tx.project.findMany());

// 2. 特权路径：仅用于登录、Token 校验、审计写入等"还不知道租户"的场景
await tenant.withoutTenantScope(async (tx) => tx.user.findUnique({ where: { email } }));
```

两条路径都使用 `set_config(..., true)`，作用域限制在事务内，不会泄漏到连接池中的后续查询。

## 新增表

1. 在 `prisma/schema.prisma` 增加模型，**必须包含 `organizationId`**。
2. `prisma migrate dev --name <change>` 生成迁移。
3. `python3 scripts/append-rls.py packages/database/prisma/migrations/<dir>` 追加 RLS 策略。
4. 补一条集成测试，断言跨租户读写被拒绝。

详见 [docs/DATABASE.md](../../docs/DATABASE.md)。
