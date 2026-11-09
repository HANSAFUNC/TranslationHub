# Changelog

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
- **Local MCP**：14 个工具 + 2 资源 + 4 Prompt，stdio；`confirm=false` 拒绝写操作；状态文件串联多步流程。
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
