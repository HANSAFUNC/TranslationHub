# 贡献指南

## 分支与提交

- 主分支 `main`，功能分支 `feat/<scope>`、修复分支 `fix/<scope>`。
- 提交格式：`<type>: <description>`（`feat` `fix` `refactor` `docs` `test` `chore` `perf` `ci`）。
- 不提交：`.env*`、`localehub.env`、`.localehub/backups|patches|state.json`、`secrets/`、`dist/`、`.next/`。

## 开发流程

```bash
pnpm install
pnpm db:up && pnpm db:migrate
pnpm -r build
pnpm test            # 单元
pnpm test:integration
pnpm typecheck && pnpm lint
```

改动涉及数据库结构时：

```bash
cd packages/database
DATABASE_URL="$MIGRATE_DATABASE_URL" pnpm exec prisma migrate dev --name <change>
python3 ../../scripts/append-rls.py <migration-dir>   # 见下：新增表必须补 RLS
```

**新增租户表必须同时添加 `organization_id` 列与 RLS 策略**，否则租户隔离测试会失败。

## 代码约定

- 业务规则放 `packages/domain` 或 `packages/sync-engine`，控制器只做校验与编排。
- 纯逻辑（三方比较、格式补丁、路径判定）必须可单测，不引入 IO。
- 所有对外错误使用 `LocaleHubError` + 稳定错误码；新增错误码同步更新 `docs/API.md`。
- 新增 MCP 工具：在 `packages/contracts/src/mcp-tools.ts` 注册 schema，
  在对应 server 里注册实现，并更新 `docs/MCP.md`。
- 新增格式：实现 `FormatAdapter`，加入 `createAdapter` 注册表，并补 fixture + round-trip 测试。
- 任何写文件路径必须经过 `WorkspaceGuard` 与 `SafeFileWriter`，不允许直接 `writeFileSync`。

## 测试要求

- 新功能：至少一个单元测试；涉及同步/回写：补集成测试。
- 修改三方比较规则：必须同时更新 `packages/sync-engine/src/__tests__/three-way.test.ts` 的
  分支表，并解释对既有计划哈希的影响。
- 不允许为通过测试而放宽安全检查（路径、角色、scope、RLS）。

## 提交前检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过（0 warning）
- [ ] `pnpm test` + `pnpm test:integration` 通过
- [ ] 新增 API/MCP 工具已写入 docs
- [ ] 没有把未完成项描述成已完成（更新 `docs/STATUS.md`）
