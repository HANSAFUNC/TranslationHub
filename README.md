# LocaleHub

面向开发团队、产品经理、翻译与审核人员的**多语言管理平台**，核心能力是
**代码仓库 ↔ 平台之间的双向本地化同步闭环**，通过 MCP（Model Context Protocol）把
本地仓库安全地接入平台。

```text
开发者本地仓库
  ├─ Web / iOS / Android 语言文件
  ├─ 可选代码上下文（只读白名单）
  └─ Local MCP（stdio）
          │ scan / preview / push / pull / 安全回写
          ▼
LocaleHub API + Sync Engine  ──  PostgreSQL（组织级 RLS）/ Redis + BullMQ
  ├─ 项目、Key、Locale、术语、版本、审核、QA、发布快照
  ├─ 同步基线、同步会话、同步计划、冲突记录、回写报告
  └─ Remote MCP（Streamable HTTP）
          ▲
          │ 产品经理修改译文、翻译人员审核、项目经理批准
          │
LocaleHub Web 平台
```

## 最重要的验收结果

1. 开发者在本地仓库修改语言文件，Agent 通过 Local MCP 扫描、预览并推送到平台。
2. 产品经理在平台修正错误译文并**审核通过**。
3. Agent 通过 Local MCP 拉取变更、展示逐文件逐 Key 的 diff，用户确认后**安全写回**本地文件。
4. 三方基线比较保证：双边同时修改且内容不同时**报冲突，绝不静默覆盖**。
5. 全过程可追溯、可重试、有备份、有 Git diff；默认**不自动 commit / push**。

## 快速开始（本地开发）

前提：Node ≥ 20、pnpm 10、Docker。

```bash
# 1. 安装依赖
pnpm install

# 2. 启动 PostgreSQL 与 Redis（使用 55432 / 56379，避免与本机服务冲突）
pnpm db:up

# 3. 配置环境变量
cp env.example localehub.env     # 本仓库的工作区禁止读写 .env*，因此模板名为 env.example
# 生产环境请使用 AUTH_SECRET_FILE 等 *_FILE 变量注入密钥

# 4. 建表 + 生成 Prisma Client
pnpm db:migrate
pnpm db:generate

# 5. 构建
pnpm -r build

# 6. 种子数据（组织、5 个角色用户、Demo App 项目、术语、QA 数据、MCP Token）
pnpm db:seed

# 7. 启动
pnpm dev:api      # http://localhost:3001/api/v1
pnpm dev:web      # http://localhost:3000
pnpm dev:worker   # BullMQ worker
```

登录：`demo@localehub.dev` / `demo-password-123`（其余角色见 `pnpm db:seed` 输出）。

### 端到端验收演示（推荐先看这个）

```bash
pnpm -r build
node apps/e2e-demo/dist/run-demo.js
```

脚本会自动创建一份 `demo-app` 的临时副本并依次验证：

| 场景 | 验证内容                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------- |
| A    | 扫描 → 预览 → 推送；重复推送幂等，不产生重复版本                                                  |
| B    | 平台修正日语译文并审核 → Local MCP 拉取 → dry-run diff → 确认写回 → 校验 JSON/Key/占位符/Git diff |
| C    | 再次同步结果为 `unchanged`，不产生新版本                                                          |
| D    | 平台草稿默认不进入 pull/apply 列表；显式 `include_drafts` 才可见并附带风险提示                    |
| E    | 源文变更后依赖旧 Source Version 的目标译文自动标记 `STALE`，历史保留                              |

## 接入真实仓库（Local MCP）

```bash
# 1. 在仓库根目录生成配置
node apps/cli/dist/bin.js init --project <project-id> --api http://localhost:3001/api/v1

# 2. 导出平台 Token（绝不要写进 config.yaml 或提交到 Git）
export LOCALEHUB_TOKEN="lh_mcp_..."

# 3. 命令行方式
node apps/cli/dist/bin.js info
node apps/cli/dist/bin.js scan
node apps/cli/dist/bin.js sync preview
node apps/cli/dist/bin.js sync push --confirm
node apps/cli/dist/bin.js pull --locale ja-JP
node apps/cli/dist/bin.js apply preview
node apps/cli/dist/bin.js apply --confirm --apply-plan <id>
```

### Claude Code / Cursor / Codex 配置

```json
{
  "mcpServers": {
    "localehub-local": {
      "command": "node",
      "args": ["/abs/path/to/localehub/apps/mcp-local/dist/bin.js", "--stdio", "--workspace", "."],
      "env": {
        "LOCALEHUB_API_URL": "http://localhost:3001/api/v1",
        "LOCALEHUB_WORKSPACE": ".",
        "LOCALEHUB_TOKEN": "${LOCALEHUB_TOKEN}"
      }
    }
  }
}
```

Local MCP 提供 14 个工具：`get_local_project_info`、`scan_local_project`、`read_project_context`、
`get_remote_project`、`preview_sync`、`push_project_changes`、`pull_platform_updates`、
`preview_apply`、`apply_translation_updates`、`validate_localization_files`、`get_sync_status`、
`resolve_sync_conflict`、`report_apply_result`、`create_git_patch`。

Remote MCP（平台侧，Streamable HTTP）提供 15 个平台工具，**不提供任何本地文件读写能力**。

## 工程结构

```text
localehub/
├── apps/
│   ├── api/          NestJS REST API（/api/v1）
│   ├── web/          Next.js 15 + shadcn/ui 管理后台（Tailwind v4，new-york/zinc）
│   ├── worker/       BullMQ Worker（QA、导入导出、通知）
│   ├── mcp-local/    Local MCP（stdio，开发者机器）
│   ├── mcp-remote/   Remote MCP（Streamable HTTP）
│   ├── cli/          localehub CLI + seed
│   └── e2e-demo/     端到端验收演示与集成测试
├── packages/
│   ├── contracts/    统一数据契约、错误码、MCP Tool Schema
│   ├── database/     Prisma Schema、RLS 迁移、TenantPrisma
│   ├── domain/       领域服务（翻译、同步引擎、QA、AI）
│   ├── sync-engine/  三方比较、同步计划、冲突与回写计划（纯函数）
│   ├── format-adapters/ JSON / YAML / .strings / .stringsdict / .xcstrings / Android XML / PO / XLIFF
│   ├── workspace/    本地文件访问边界、原子写入、Git 集成
│   ├── api-client/   REST 客户端
│   ├── permissions/  角色与 MCP Scope 判定
│   └── config/       环境变量与 Secret 加载
├── skills/           内置 Skill（prompt 型，权限不高于当前用户）
├── docs/             PRD / 架构 / 数据库 / API / MCP / 同步 / Skill / 部署
├── demo-app/         演示用「开发者仓库」fixture
├── compose.yaml      开发编排（postgres/redis/api/worker/mcp-remote/web）
└── compose.production.yaml  生产覆盖（Secret 文件、副本、资源限制、nginx）
```

## 测试

```bash
pnpm test              # 单元测试：三方比较、格式 round-trip、路径安全
pnpm test:integration  # 集成测试：真实 API + PostgreSQL + 文件写回
pnpm typecheck         # 全部 17 个 workspace 项目
pnpm lint              # eslint --max-warnings 0
pnpm format            # prettier（含 Tailwind 类名排序）
```

覆盖：三方比较全部分支、计划哈希稳定性、格式 round-trip 与原地补丁、路径穿越/符号链接逃逸、
配置校验、原子写入与回滚、备份、幂等推送、计划过期、草稿隔离、冲突与收敛、RLS 隔离、
Scope 强制、源文变更致 STALE、apply report 推进基线。

## 部署

```bash
docker compose up -d --build          # 开发/演示
docker compose -f compose.yaml -f compose.production.yaml up -d   # 生产（需 ./secrets/*）
docker compose run --rm api pnpm prisma migrate deploy
```

详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 文档

| 文档                                         | 内容                                     |
| -------------------------------------------- | ---------------------------------------- |
| [docs/PRD.md](docs/PRD.md)                   | 产品需求、角色、验收场景                 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、模块边界、双 MCP 设计              |
| [docs/DATABASE.md](docs/DATABASE.md)         | ER 关系、RLS、迁移说明                   |
| [docs/API.md](docs/API.md)                   | REST API、错误码、幂等与并发             |
| [docs/MCP.md](docs/MCP.md)                   | Local / Remote MCP 工具与配置            |
| [docs/SYNC.md](docs/SYNC.md)                 | 三方同步、基线、冲突算法与回写安全规则   |
| [docs/SKILLS.md](docs/SKILLS.md)             | Skill 安装、权限与执行边界               |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)     | 部署、备份、可观测性                     |
| [docs/STATUS.md](docs/STATUS.md)             | **交付现状：已完成 / 未完成 / 已知风险** |

## 安全基线

- 所有租户数据带 `organization_id`，数据库启用 RLS；应用连接使用非 owner 角色。
- 浏览器会话放在 **HttpOnly Cookie**（页面 JS 读不到），写请求走 **双提交 CSRF Token + Origin 校验**；
  `localStorage` 中不保存任何凭据。生产环境拒绝在纯 HTTP 上认证。
- 所有端点限流：已认证请求按 actor 计数，登录/注册按（IP, 账号）计数，超限 429 + `Retry-After`。
- MCP Token 只存 SHA-256 哈希，明文只显示一次；`sync.push` 与 `translation.apply` 分离授权。
- `include_drafts`（把未审核草稿写回仓库）由**组织级策略**控制，默认关闭，需组织所有者显式开启。
- 文件访问受 `workspace.root` / `allowRead` / `allowWrite` / `denyRead` / `denyWrite` 与文件映射共同约束，
  拒绝路径穿越与符号链接逃逸；平台上不存在任何任意本地文件工具。
- 写文件前校验旧值未被改动，先备份、临时文件 + fsync + 原子 rename，写完重新解析；失败自动回滚。
- 平台译文默认只拉取 `APPROVED`；AI 结果永远是草稿，不能绕过人工审核。
- 上传的 Skill 脚本不在 API/Worker 进程内执行（见 docs/SKILLS.md 的执行边界说明）。

## 许可证

[MIT](LICENSE) © 2026 HANSAFUNC
