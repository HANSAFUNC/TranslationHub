# Changelog

## 未发布

### 安全基线

- **浏览器会话改为 HttpOnly Cookie**：不再往 `localStorage` 写凭据；写请求使用双提交 CSRF Token，
  并校验 `Origin`/`Referer` 属于本部署。CLI 与两个 MCP 服务端继续使用 Bearer，两条路径解析到同一个 actor。
- **全端点限流**：已认证请求按 actor 计数，`/auth/login` 与 `/auth/register` 按（IP, 账号）计数并叠加
  更宽松的 IP 桶（防密码喷洒、不误伤同一出口 IP 的其他人）。计数存 Redis，多副本共享；
  响应带 `X-RateLimit-*`，超限 429 + `Retry-After`。
- **传输与响应头**：`NODE_ENV=production` 下拒绝纯 HTTP 凭据（`INSECURE_TRANSPORT`）；接入 helmet；
  `TRUST_PROXY` 默认关闭，避免伪造 `X-Forwarded-For` 绕过限流。
- **草稿回写收敛为组织级策略**：`organizations.allow_draft_apply` 默认 `false`，平台侧拒绝
  `include_drafts`（`POLICY_VIOLATION`），不再由运行在开发者机器上的 CLI 决定。
- Web 端新增「组织设置 → 同步安全策略」开关与 `GET/PATCH /organization` 接口。

### 修复

- **CSRF 守卫与 CORS 用了两个来源的允许列表**：守卫直接读 `process.env.CORS_ORIGINS`，而 CORS 中间件
  用的是校验后的配置（含 schema 默认值）。在没有 env _文件_ 的实例上（CI、直接注入环境变量的容器）
  守卫看到空字符串，于是把 Web 自己的 origin 判为非法，写请求一律 403。本地一直没暴露，因为
  `localehub.env` 恰好存在。现在两者统一走 `corsOrigins()`，并补了不依赖 env 文件的回归测试。

- **CI 变绿**：验收演示此前假定 API 已在运行——集成测试在 `afterAll` 里会杀掉它，所以 CI 里演示步骤
  必然以 `fetch failed` 失败。现在演示与集成测试共用一个 API 启动器（`apps/e2e-demo/src/api-harness.ts`），
  连不上就自己起、跑完只关自己起的那个。
- **Web 在本地开发时连不上 API**：`NEXT_PUBLIC_API_BASE_URL` 未设置时回退到同源 `/api/v1`，但 Next
  只重写了 `/api/proxy`，导致请求打到 Web 自身返回 404。已补 `/api/v1/*` rewrite；浏览器默认走同源，
  Cookie 保持 first-party，也不再需要 CORS。
- **`pnpm db:migrate` 在本仓库跑不通**：Prisma 只读 `.env`，而本工作区用的是 `localehub.env`，且迁移必须
  用 owner 角色。新增 `scripts/run-with-env.mjs`，迁移命令改为 `--database-url-var MIGRATE_DATABASE_URL`。

## 0.1.0 — 首次交付

### 新增

- **工程底座**：pnpm Monorepo（8 个 packages + 7 个 apps）、TypeScript strict、ESLint（0 warning）、
  Vitest（unit + integration 双 project）、GitHub Actions CI、Docker 多阶段构建、开发与生产 Compose。
- **数据库**：Prisma Schema（33 张表）、两个迁移、32 张租户表的 RLS 策略、非 owner 应用角色、
  `TenantPrisma` 双模式访问（租户事务 / 特权路径）。
- **领域层**：翻译核心（不可变版本、STALE 标记、占位符校验）、同步服务（scan/preview/push/changes/
  baseline/conflict/apply-report/validate）、项目事件与单调 revision、QA 规则引擎、AI Provider 适配器、
  Token 与密钥加密。
- **同步引擎（纯函数）**：三方比较 12 类分支、确定性计划哈希、冲突决策、回写计划与旧值校验。
- **格式适配器**：JSON（原地 token 补丁）、YAML（保留注释）、iOS `.strings` / `.stringsdict` /
  `.xcstrings`、Android `strings.xml` / `plurals.xml`、PO、XLIFF；含 29 个 round-trip 测试。
- **本地工作区**：路径白名单与符号链接逃逸防护、配置校验、原子写入与备份回滚、Git 只读集成。
- **本地同步（CLI）**：14 个命令，引擎在 `packages/local-sync`（不含 MCP 依赖）；缺 `--confirm`
  拒绝写操作；状态文件串联多步流程。平台只暴露一个 Remote MCP。
- **Remote MCP**：15 个平台工具，无状态 Streamable HTTP；不含任何本地文件能力。
- **REST API**：认证、项目、翻译、同步、Token、QA、AI、术语、TM、Skill、发布、健康检查；
  统一信封与稳定错误码；审计日志自动脱敏；BullMQ 生产者。
- **Worker**：QA 队列（幂等重算）与三个占位队列（明确返回"未配置"）。
- **Web 后台**：Next.js 15 + **shadcn/ui**（Tailwind v4，new-york/zinc，Radix 原语）15 条路由，
  覆盖工作台、项目、翻译编辑器、审核、QA、同步、冲突三栏对比、Token 管理、MCP/Skill 清单、组织设置。
  含明/暗主题、语义状态色令牌、响应式侧边栏与移动端抽屉导航。
- **CLI**：init/info/scan/sync/pull/apply/conflicts/qa/status/patch/mcp-config/release + seed。
- **Skills**：5 个内置 prompt 型 Skill。
- **文档**：README、QUICKSTART、PRD、ARCHITECTURE、DATABASE、API、MCP、SYNC、SKILLS、
  DEPLOYMENT、STATUS、CONTRIBUTING、CHANGELOG 及各包 README。
- **许可证**：MIT（Copyright (c) 2026 HANSAFUNC）。

### 前端规范

- 组件以源码形式落在 `apps/web/src/components/ui/`，与上游注册表逐字节一致，便于 `shadcn add --diff` 增量更新。
- 表单用 `FieldGroup`/`Field`/`FieldSet`，空态用 `Empty`，加载用 `Skeleton`/`Spinner`，提示用 `sonner`，
  按钮内图标用 `data-icon`，`SelectItem`/`DropdownMenuItem` 包在对应 `*Group` 中。
- 状态色（success/warning/info）为项目自定义语义令牌，定义在 `globals.css` 的明暗两套变量里，
  业务代码不出现裸 Tailwind 色值。
- Prettier + `prettier-plugin-tailwindcss` 统一格式化与类名排序。

### 验证

- 86 个自动化测试通过（72 unit + 14 integration）。
- 端到端演示 A–E 全场景通过，连续运行可重复。
- Local / Remote MCP 均通过真实 MCP Client 握手与工具调用。
- API 与 Web Docker 镜像均构建成功并完成容器内运行验证（API 健康检查/登录/MCP 工具清单；Web 8 条路由 HTTP 200）。

### 已知限制

见 [docs/STATUS.md](docs/STATUS.md) 第 2、3 节（OpenAPI 生成、Skills 脚本执行器、对象存储、
CSV/XLSX、GitHub App、前端 E2E 等尚未实现）。
