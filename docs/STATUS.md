# 交付现状：已完成 / 未完成 / 已知风险

> 本文如实记录实际执行过的验证。未执行的项明确标注，不把"代码已生成"描述成"功能已验证"。

## 1. 已实现并已验证

### 1.1 工程与基础设施
- pnpm Monorepo（`apps/*` + `packages/*`），TypeScript strict，所有包 `tsc` 通过。
- PostgreSQL 16 + Redis 7 通过 `compose.yaml` 启动；`postgres` 起在 55432、`redis` 起在 56379。
- Prisma 两个迁移已应用（含 32 张表的 RLS 策略与 `localehub_app` 非 owner 角色）。
- `compose.yaml` 与 `compose.yaml + compose.production.yaml` 均通过 `docker compose config` 校验。
- API `/api/v1/health` 返回 `{"status":"ok","checks":{"database":true}}`（真实运行验证）。
- Web 15 条路由构建成功，`next start` 后 `/login` 等页面返回 200。
- Worker 编译通过，队列定义与 QA 任务实现完成（**未在长时间运行下验证队列重试**）。

### 1.2 领域与同步
- 三方比较全部 12 类分支、计划确定性哈希、汇总统计：19 个单元测试通过。
- 同步服务：scan 记录、预览、推送（幂等重放）、变更增量、基线、冲突、apply report、
  同步前校验、事件日志。
- 冲突解决：`KEEP_LOCAL` / `KEEP_REMOTE` / `MANUAL_MERGE` / `DEFER`，写平台新版本并推进 revision。
- 源文变更 → 依赖旧 Source Version 的译文标记 `STALE`，历史版本保留。

### 1.3 格式适配器
- JSON（自研 span scanner，原地 token 替换）、YAML（Document API 保留注释）、
  iOS `.strings`、`.stringsdict`、`.xcstrings`、Android `strings.xml`/`plurals.xml`、PO、XLIFF。
- 29 个 round-trip / 原地补丁测试通过，含复数分支、XML 实体、引号与换行转义。

### 1.4 Local MCP
- 14 个工具 + 2 个 Resource + 4 个 Prompt，stdio 传输。
- 路径安全：24 个测试通过（`..`、绝对路径、NUL、符号链接逃逸、allowRead/Write、deny 规则、
  配置校验、备份、原子写入、写后校验回滚、重复 Key 检测）。
- 端到端验收脚本 `apps/e2e-demo/dist/run-demo.js`：**A–E 全场景 ALL ACCEPTANCE CHECKS PASSED**。

### 1.5 集成测试（真实 API + PostgreSQL + 文件系统）
14 个集成测试全部通过，覆盖：push new、幂等推送、平台审核后拉取、备份与原子写回、
apply report 推进基线、草稿隔离、源文变更致 STALE、双边冲突、同值收敛、预览后本地变更阻断回写、
计划过期、Scope 强制、RLS 租户隔离、跨租户 Token 拒绝。

### 1.6 Web 后台（shadcn/ui）
Next.js 15 + shadcn/ui（Tailwind v4、new-york、Radix、lucide、sonner）：项目管理、项目概览、
翻译编辑器（并排原文/译文、版本历史、QA、草稿与审核）、审核队列、过期译文、QA 中心、
仓库同步页（连接/心跳/映射/历史/说明）、同步历史（可展开逐条 Sync Item）、冲突三栏对比、
Token 管理、MCP 工具清单与 Skill 列表、组织设置。
含明/暗/跟随系统主题、语义状态色令牌、响应式侧边栏 + 移动端抽屉导航。

验证方式（headless Chrome + CDP，登录后逐页检查）：

- `next build` 15 条路由全部生成；
- 11 个受保护页面均渲染出 `data-slot="card"/"button"/"table"` 组件，无应用错误；
- 暗色与浅色模式均生效（`.dark` 类随主题切换，首屏内联脚本避免闪烁）；
- 390px 窄视口下 11 个页面**全部无横向溢出**（首次检查发现 Token 页与 MCP 页各有一处，已修正：
  代码块所在栅格列补 `min-w-0`，资源 URI 加 `truncate`）。

### 1.7 其他
- CLI：`init / info / scan / sync preview|push / pull / apply preview|--confirm / conflicts /
  qa / status / patch / mcp-config / release validate`。
- Seed：组织、5 角色用户、项目、3 语言、术语、样例 Key、QA 运行、MCP Token。
- 5 个内置 Skill（prompt 型）。
- 文档：README、PRD、ARCHITECTURE、DATABASE、API、MCP、SYNC、SKILLS、DEPLOYMENT、本文件。

## 2. 未实现 / 部分实现

| 项 | 状态 | 说明 |
|---|---|---|
| OpenAPI 3.1 自动生成 + TS Client | **未实现** | 当前有 zod schema 与手写 `api-client`，无 `openapi.yaml` 生成 |
| Remote MCP 的 OAuth 2.1 | 部分 | 仅 Bearer Token；无 OAuth 授权码流程 |
| Remote MCP 的 Resources 模板 | 部分 | 只注册了 `qa-rules` 资源；项目级资源模板未注册 |
| Skills 脚本隔离执行器 | **未实现** | `kind=SCRIPT` 仅登记，任何进程都不执行（见 SKILLS.md） |
| 对象存储 / 预签名 URL | **未实现** | 导入导出走 JSON 响应体；未接 S3/MinIO |
| CSV / XLSX 适配器 | **未实现** | 规格 §10.1 列出，本版本未实现 |
| Git/GitHub App、PR 检查 | **未实现** | 规格 §14 第二阶段 |
| 发布快照导出为实际文件包 | 部分 | 快照入库与校验和字段存在，未打包导出 |
| Webhook 事件推送 | **未实现** | 目前依赖 `since_revision` 游标拉取 |
| 多组织切换 UI | 部分 | API 支持 `switch-organization`，UI 只展示列表 |
| 用户管理 UI（邀请/改角色） | 部分 | API `POST /projects/:id/members` 存在，UI 未提供表单 |
| 前端单元测试 | **未实现** | 无 Playwright / RTL 用例；仅验证页面可访问（HTTP 200） |
| Docker 镜像构建与运行 | **已完成（API + Web）** | 两个镜像 `docker build` 均成功（EXIT=0）。API 容器：健康检查 ok、登录成功、`/mcp/tools` 返回 14 local + 15 remote。Web 容器：默认 CMD 启动，8 条路由（`/login` `/projects` `/sync` `/sync/conflicts` `/mcp` `/developers/tokens` `/review` `/qa`）全部 HTTP 200 且含应用内容 |
| i18n Adapter：JSON 数组/ICU AST | 部分 | ICU 复数以字符串形式保存，非 AST 级编辑 |
| `file_hash` 级别的映射变更检测 | 部分 | 已存 `local_file_id/path`，`FILE_MAPPING_CHANGED` 冲突原因已定义但未产生 |

## 3. 已知风险与设计取舍

1. **`include_drafts=true` 可回写草稿**：这是规格允许的显式路径（§3.3 step 8），但会覆盖已审核文案。
   apply 计划会返回 `riskWarning`，UI/CLI 需展示。建议生产默认关闭该能力（可加组织策略开关）。
2. **Prisma + RLS 的交互**：`TenantPrisma` 用 `$transaction` 包裹并 `SET LOCAL`，每请求一次额外事务。
   长事务下性能会下降；当前用 cursor 分页与批量上限控制。
3. **登录/Token 校验使用特权路径**：这是 RLS 的必要例外，依赖"token hash / email 唯一"
   作为访问控制。代码中已集中到 `withoutTenantScope`，并以 `set_config(..., true)` 限制在事务内。
4. **冲突只在 preview/push 时产生**：平台侧改动本身不会主动探测本地状态（平台无法访问本地）。
   因此"平台单方改动"在本地执行 preview 前一直处于"待拉取"状态，而非冲突。
5. **`APPLY_REJECTED_STALE_PREVIEW` 是整计划拒绝**：一条条目变脏会阻断整个计划，需要重新
   preview。这是有意选择的保守行为，代价是频繁编辑的仓库需要多次预览。
6. **JSON 原地补丁的边界**：仅支持字符串值与复数对象；数值/布尔值补丁会抛
   `UNSUPPORTED_FORMAT`（翻译文件不应承载非字符串值）。
7. **`.stringsdict` 不支持新建 Key**：结构复杂，要求先在目录中创建条目，补丁只改数量分支。
8. **Web 端 Token 存在 localStorage**：便于与 CLI/MCP 共用同一套 Bearer 鉴权路径，
   但存在 XSS 下的窃取风险。生产建议改为 HttpOnly Cookie 会话（API 已下发 Cookie，
   Web 尚未使用）。
9. **AI Provider 默认离线启发式**：不会真正翻译，只做术语替换；配置 `ANTHROPIC_API_KEY`
   才会调用真实模型。AI 输出始终为草稿。
10. **单仓多语言文件同名 Key 冲突**：扫描阶段检测并报 `DUPLICATE_KEY`，但只在同一
    platform+namespace+locale 内判定；跨 namespace 同名 Key 视为不同 Key（符合唯一键设计）。

## 4. 实际执行的验证命令与结果

```bash
pnpm -r build                     # 全部 packages + apps 编译通过
pnpm --filter @localehub/web exec next build   # 15 条路由构建成功
pnpm exec tsc -p tsconfig.json --noEmit        # api / web / mcp-local / cli / mcp-remote 均通过
pnpm test                                      # 72 unit tests passed（19 + 29 + 24）
pnpm test:integration                          # 14 integration tests passed
node apps/e2e-demo/dist/run-demo.js            # ALL ACCEPTANCE CHECKS PASSED（A–E）
docker compose config                          # valid
docker compose -f compose.yaml -f compose.production.yaml config   # valid
docker build -f docker/api.Dockerfile .        # 成功（localehub-api:test）
docker run --network host … localehub-api:test # health=ok, login ok, /mcp/tools 返回 14 local + 15 remote
docker build -f docker/web.Dockerfile .        # 成功（localehub-web:test）
docker run -p 3040:3000 … localehub-web:test   # 默认 CMD，8 条路由全部 HTTP 200
pnpm exec eslint . --max-warnings 0            # 0 error / 0 warning
node apps/e2e-demo/dist/run-demo.js            # 连续两次运行均 ALL ACCEPTANCE CHECKS PASSED
psql -U localehub_app …                        # 验证 RLS：无 org 上下文 0 行；跨租户写入被拒绝
curl /api/v1/health                            # {"status":"ok","checks":{"database":true}}
curl -o /dev/null -w %{http_code} /login 等     # 8 个页面均 200
```

## 5. 建议的后续优先级

1. ~~完成 Docker 镜像构建验证~~（已完成，见附一）→ 下一步：把镜像构建产物推送到注册表并在 CI 中做部署冒烟。
2. OpenAPI 3.1 生成 + TS Client 自动生成，替换手写 `api-client`。
3. Web 会话切换到 HttpOnly Cookie，移除 localStorage 存储。
4. Skills 隔离执行器（独立容器、无网络、非 root）。
5. CSV/XLSX 适配器与对象存储导入导出。
6. GitHub/GitLab App + PR 检查（`localehub scan / sync preview --direction=push / qa --changed-only`）。
7. 前端 E2E（Playwright）覆盖翻译编辑器与冲突处理的关键交互。

---

## 附：最终验证记录（本文件写入后重跑）

| 命令 | 结果 |
|---|---|
| `pnpm -r typecheck` | 全部 17 个 workspace 项目通过 |
| `pnpm lint`（`eslint . --max-warnings 0`） | 0 error / 0 warning |
| Local / Remote MCP 真实客户端握手 | 通过（见附二） |
| 端到端演示连续两次运行 | 均通过（demo 自带项目清理，可重复执行） |
| `pnpm test` | 72 passed |
| `pnpm test:integration` | 14 passed |
| `node apps/e2e-demo/dist/run-demo.js` | ALL ACCEPTANCE CHECKS PASSED |
| `docker compose config`（含 production overlay） | valid |
| `docker build -f docker/api.Dockerfile .` | 见下方说明 |

Docker 镜像构建第一次因 Dockerfile 在 `prisma generate` 之前编译 `packages/database` 而失败
（`@prisma/client` 尚无导出），已修正构建顺序（先生成 Prisma Client，再编译）。修正后的构建结果
见仓库根目录最后一次 `docker build` 输出；若网络受限导致依赖下载失败，请在网络可用环境重试：

```bash
docker build -f docker/api.Dockerfile -t localehub-api:local .
docker build -f docker/web.Dockerfile -t localehub-web:local .
```

两个镜像均已成功构建并运行验证。首次 Web 重构建曾在下载 `@next/swc-linux-arm64-*` 时遇到
`ECONNRESET`，重试后完成；这是网络抖动，不是代码问题。

## 附二：MCP 传输层实测

| 验证 | 结果 |
|---|---|
| Local MCP（stdio）被真实 MCP Client 连接 | `connected: localehub-local 0.1.0` |
| Local MCP 工具数 | 14（名称与规格 §6.2 完全一致） |
| Local MCP Resources / Prompts | 2 / 4 |
| `get_local_project_info` | 返回项目、2 个映射、Git 分支与 commit |
| `validate_localization_files` | 6 条条目、0 问题 |
| `push_project_changes(confirm=false)` | 被拒绝（`requiresConfirmation: true`） |
| `read_project_context` 越界 glob | 0 个 allowed，路径逃逸被阻断 |
| Remote MCP（Streamable HTTP）被真实 MCP Client 连接 | `connected: localehub-remote 0.1.0` |
| Remote MCP 工具数 | 15（与规格 §6.4 一致） |
| Remote MCP 是否暴露本地文件工具 | 否（检查 `read_local_file` / `write_local_file` / `read_file` / `exec` 均不存在） |
| `list_projects` / `get_project_sync_status` | 正常返回 |

修复记录：Remote MCP 最初把数组作为 `structuredContent` 返回，被 MCP 客户端以
`-32602 Invalid tools/call result` 拒绝；已在两个 MCP 服务端统一做「数组包装为 `{items}`」规范化。
`apps/mcp-remote` 缺少 `reflect-metadata` 运行时依赖也已补上。

## 附三：本次交付中发现并修复的问题

| 问题 | 影响 | 修复 |
|---|---|---|
| 归档动作映射颠倒（`ARCHIVE_CANDIDATE` / `REMOTE_ARCHIVE_CANDIDATE`） | 本地删除会被误判为远端删除 | 交换两处返回值并补分支测试 |
| YAML 补丁丢失注释 | 回写会破坏 YAML 文件注释 | 改用 `yaml` 的 Document API |
| JSON 新增嵌套 Key 时空节点不存在 | 新增 Key 报错 | 递归创建中间对象 |
| JSON 插入点落在收尾换行之后 | 生成非法 JSON（逗号独占一行） | 插入点回退到末尾空白之前 |
| 认证查询未走特权路径 | RLS 导致登录/Token 校验查不到 membership | 统一走 `withoutTenantScope` |
| `getChanges` 用 `array_contains` 过滤 JSON 字符串 | 平台变更永远拉不到 | 移除 SQL 过滤，改为应用层按 locale 过滤 |
| 新版本未清空 `applied_to_repo_at` | 已应用的条目标记污染新版本，pull 过滤掉真实变更 | 仅仓库推送才标记为已应用 |
| 冲突解决写回使用扁平字段缺失 | 解决冲突后平台值不更新 | 补齐 `baseValue/localValue/remoteValue` |
| 冲突解决的 Key 查询忽略 namespace | 带 namespace 的项目无法写回 | 通过 namespace 行再查 Key |
| Remote MCP 返回数组作为 `structuredContent` | MCP 客户端报 `-32602` | 两个 MCP 服务端统一包装为 `{items}` |
| `apps/mcp-remote` 缺少 `reflect-metadata` | 远程 MCP 无法启动 | 补依赖 |
| AuthGuard 把 `params.id` 当 projectId | 项目级成员（组织角色为 READONLY）被误拒 | 仅在路由确有 projectId 时做项目级角色判断，其余由服务层显式断言 |
| 缺少 `DELETE /projects/:id` | 无法清理项目，演示不可重复 | 新增删除端点（需 `confirmName` 二次确认） |
| Dockerfile 在 `prisma generate` 前编译 database 包 | 镜像构建失败 | 调整构建顺序 |
| Docker runtime 阶段只拷贝部分目录 | 容器内 `MODULE_NOT_FOUND` | 拷贝完整构建产物 |
| Web 容器用 corepack 启动 pnpm | 启动时联网下载 pnpm 导致启动失败 | 直接执行 next |
| Web 容器 `next start` 工作目录为 `/app` | 找不到 `.next`，容器无法启动 | 运行时 `WORKDIR /app/apps/web` |
| 浏览器端硬编码 API 主机 | 反向代理部署下前端打不到 API | 未配置 `NEXT_PUBLIC_API_BASE_URL` 时回退到同源 `/api/v1` |
