# 数据库设计、RLS 与迁移

## 1. 迁移

```bash
pnpm db:migrate          # 应用迁移（owner 连接）
pnpm db:generate         # 生成 Prisma Client
pnpm db:seed             # 种子数据（apps/cli/src/seed.ts）
```

迁移位于 `packages/database/prisma/migrations/`：

| 迁移 | 内容 |
|---|---|
| `20261109064837_init` | 全部核心表 + 外键 + **RLS 策略（32 张租户表）** + 角色与授权 |
| `20261109065342_sync_baseline_local_file` | 同步基线增加本地文件定位列 |

迁移使用 owner 连接执行（需要 DDL 权限与 shadow database）：
`DATABASE_URL=$MIGRATE_DATABASE_URL pnpm --filter @localehub/database migrate:deploy`。

## 2. 实体关系（核心）

```text
Organization 1─* Membership *─1 User
Organization 1─* Project 1─* Locale
                        ├─* ProjectPlatform
                        ├─* Namespace 1─* TranslationKey 1─* SourceVersion
                        │                                └─* TranslationEntry 1─* TranslationVersion
                        ├─* ProjectMember
                        ├─* RepositoryConnection 1─* RepositoryFileMapping
                        │                          ├─* SyncBaseline
                        │                          └─* SyncSession 1─* SyncItem
                        ├─* SyncPlan  (session 级，绑定 plan_hash)
                        ├─* SyncScan  (上传的扫描批次)
                        ├─* SyncConflict
                        ├─* SyncApplyReport
                        ├─* ProjectEvent  (单调 revision)
                        ├─* GlossaryTerm / QaRun / QaIssue / Release / ReleaseSnapshot
Organization 1─* McpClient / AuditLog / AiProviderConfig / Skill
```

## 3. 关键约束

| 约束 | 位置 |
|---|---|
| `sync_baselines` 唯一：`connection_id + platform + namespace + translation_key + locale_code` | 规格 §9.2 |
| `sync_items` 唯一：`session_id + platform + namespace + translation_key + locale_code` | 防止同计划重复创建版本 |
| `sync_plans.plan_hash` 唯一 | 计划不可篡改、可幂等重放 |
| `translation_versions` 唯一：`entry_id + version` | 历史不可覆盖 |
| `translation_keys` 唯一：`project + platform + namespace + key` | Key 冲突必须可定位 |
| `translation_entries` 唯一：`key_id + locale_id` | 一条 Key 一个 Locale 一个当前值 |
| `sync_apply_reports` 唯一：`session_id + apply_plan_id` | 回写报告幂等 |
| `projects.revision` 单调递增 | 所有增量拉取的权威游标 |

## 4. 租户隔离（RLS）

```sql
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "projects"
  USING (organization_id = current_organization_id() OR rls_bypassed())
  WITH CHECK (organization_id = current_organization_id() OR rls_bypassed());
```

- `current_organization_id()` = `current_setting('app.current_org_id')::uuid`
- `rls_bypassed()` = `current_setting('app.bypass_rls') = 'on'`

应用角色 `localehub_app` **不是**表 owner、不是 superuser、`NOBYPASSRLS`，因此策略真正生效：

```bash
# 无租户上下文 → 0 行
psql -U localehub_app -c "select count(*) from projects;"
# 跨租户写入 → 被拒绝
ERROR: new row violates row-level security policy for table "projects"
```

特权路径（`withoutTenantScope`）仅用于：登录/注册、Token 校验、审计写入、平台级维护任务。
每次使用都设置 `app.bypass_rls=on` 且作用域限制在事务内（`set_config(..., true)`）。

## 5. 版本与失效语义

- `source_versions` 与 `translation_versions` **只追加**；源文哈希不变则不建新版本（幂等）。
- 源文变更 → `markTranslationsStale()` 将依赖旧 Source Version 且状态为
  `APPROVED/DRAFT/PENDING_REVIEW` 的译文置为 `STALE`，不删除任何历史。
- `translation_entries.applied_to_repo_at/commit` 记录是否已写入仓库；
  **新的译文版本会把该标记清空**（新版本尚未回写）。
- `project_events.revision` 与 `projects.revision` 同步递增，构成可补拉的增量日志。

## 6. 索引与性能

- `translation_entries(project_id, status)`、`(project_id, locale_code)`：翻译列表与待审核队列。
- `project_events(project_id, revision)`：增量拉取与同步历史。
- `sync_baselines(project_id)`、`(organization_id)`：同步状态统计。
- `audit_logs(organization_id, created_at)`：审计查询。

数据量增长后的建议（尚未实现）：`project_events` / `audit_logs` 按月分区、
`translation_entries.value` 的 trigram 全文索引、`sync_scans.entries` 迁移到对象存储。
