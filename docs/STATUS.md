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

### 1.4 本地仓库操作（CLI）

- 平台只暴露一个 Remote MCP；本地 14 个动作在 CLI 里（scan / sync preview|push / pull /
  apply preview|--confirm / conflicts / qa / status / patch / release validate / info / mcp-config），
  引擎在 `packages/local-sync`，不含任何 MCP 依赖。
- 路径安全：24 个测试通过（`..`、绝对路径、NUL、符号链接逃逸、allowRead/Write、deny 规则、
  配置校验、备份、原子写入、写后校验回滚、重复 Key 检测）。
- 端到端验收脚本 `apps/e2e-demo/dist/run-demo.js`：**A–E 全场景 ALL ACCEPTANCE CHECKS PASSED**
  （该脚本直接驱动 `LocalSyncServices`，与 CLI 同一条代码路径）。

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
- 5 个内置 Skill（prompt 型），通过 MCP 下发给客户端（见 §1.12）。
- 文档：README、PRD、ARCHITECTURE、DATABASE、API、MCP、SYNC、SKILLS、DEPLOYMENT、本文件。

### 1.9 CI 恢复绿色

`main` 上的 GitHub Actions 从第一次推送起一直是红的，三个原因互相掩盖，且**都在本地不可见**：

| #   | 现象                                             | 根因                                                                                                                                                        | 为什么本地看不到                                   |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `Acceptance demo` 报 `fetch failed`              | 演示假定 API 已在运行；集成测试在 `afterAll` 会先把它杀掉                                                                                                   | 本地一直开着 dev API                               |
| 2   | `Acceptance demo` 报 `Invalid email or password` | 集成测试先跑并创建了用户 → 注册关闭 → 演示无法自建账号                                                                                                      | 本地库里早就有 demo 用户                           |
| 3   | 集成测试 `expected 403 to be 201`                | CSRF 守卫读 `process.env.CORS_ORIGINS`，CORS 中间件读校验后的配置（含 schema 默认值）。没有 env **文件**的实例上守卫看到空串，把 Web 自己的 origin 判为非法 | 本地恰好存在 `localehub.env`，启动时被载入进程环境 |

第 3 条用「把 `localehub.env` 挪走 + 导出 CI 的环境变量」在本地复现，旧实现产出与 CI 完全相同的断言失败；
第 1、2 条用「新建空数据库，按 CI 顺序跑演示与集成测试」验证。

核对方式（无需 CI 日志权限）：`badge.svg` 与 `actions/workflows/ci.yml` 页面 HTML 均显示
`completed successfully: Run 5 of CI`。

### 1.10 Docker 栈：两个只在容器里出现的缺陷

此前对镜像的验证只做到「容器起得来 + 路由返回 200」，而页面是纯客户端渲染的，**HTTP 200 与页面
能不能用无关**。改为整套 `docker compose up` 后用无头浏览器按真实路径验证，暴露两个缺陷：

| #   | 现象                                                      | 根因                                                                                                                                                                                                                                     | 修法                                                                                          |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | 页面能开、登录返回 201，但登录后每个 `/api/v1` 请求都 500 | `next.config.ts` 的 `rewrites()` 在**构建期**执行，目标地址被写进 `routes-manifest.json`。`compose.yaml` 只在运行环境设 `API_BASE_URL_INTERNAL`，于是镜像里烘焙的是 `http://localhost:3001`——在容器内那指向 web 容器自己，`ECONNREFUSED` | 改成 `docker/web.Dockerfile` 的构建参数，compose 用 `build.args` 传入                         |
| 2   | 登录成功后的所有请求 403 `INSECURE_TRANSPORT`             | `compose.yaml` 给 api 设了 `NODE_ENV=production`（为了让镜像行为贴近生产），但开发栈没有 TLS 终结，守卫据此拒绝一切认证流量。页面照常打开、登录也成功，所以只看「路由 200」永远发现不了                                                  | 开发栈显式 `ALLOW_INSECURE_HTTP: "true"`；生产 overlay 显式设回 `"false"`，避免被环境合并继承 |

生产 overlay 另修四处同源问题（**未实际执行**——`secrets/**` 在本工作区不可读写，无法起生产栈；
端口与副本的机制用一次性 compose 项目单独实测）：

- api / web 是 `replicas: 2` 却继承宿主端口映射：第二个副本必然 `Bind for 0.0.0.0:3001 failed:
port is already allocated`。nginx 是唯一入口，这些服务不该发布宿主端口。
- **`ports: []` 在 overlay 里是无效写法**，Compose 会忽略空列表并保留基础文件的端口。也就是说
  overlay 头部写着「PostgreSQL 和 Redis 不暴露到宿主机」，实际上 55432 / 56379 一直暴露着。
  正确写法是 `ports: !reset []`（v5.1.3 实测：`ports: []` 保留 `published: "3998"`，
  `!reset []` 清空）。已改 5 个服务，合并结果只剩 nginx 的 80 / 443。
- 缺 `TRUST_PROXY`：Express 默认把 socket 地址当客户端，nginx 后面所有调用者会共用一个限流桶、
  共用一条审计身份。设 `"1"`（前面恰好一跳）。
- `MCP_PUBLIC_URL` / `API_BASE_URL` / `CORS_ORIGINS` 未设，会继承开发默认值：页面会把
  `localhost` 地址发给客户端。

### 1.8 请求层安全基线（本轮新增）

| 项           | 实现                                                                                                              | 验证                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 浏览器会话   | HttpOnly + SameSite=Lax Cookie；CSRF Token 放在可读 Cookie 里做双提交；写请求另校验 Origin/Referer                | 集成测试 4 项 + 无头 Chrome 实测 `httpOnly=true`、`localStorage` 为空 |
| Bearer 凭据  | CLI / Remote MCP / 集成脚本继续用 `Authorization: Bearer`，不受 CSRF 约束                                         | 集成测试「keeps bearer credentials working」                          |
| 传输         | `NODE_ENV=production` 下纯 HTTP 携带凭据返回 `INSECURE_TRANSPORT`（public 路由除外）                              | 集成测试起第二个 production 模式实例验证                              |
| 限流         | 全部端点；已认证按 actor，登录/注册按（IP, 账号）+ 更宽松的 IP 桶；Redis 共享计数，Redis 挂了退化为单进程并打日志 | 16 个单元测试 + 集成测试实测 429                                      |
| 安全响应头   | helmet（CSP / HSTS / X-Frame-Options / nosniff / COOP 等）                                                        | 预检与业务响应实测                                                    |
| 草稿回写策略 | `organizations.allow_draft_apply` 默认 false，平台侧拒绝 `POLICY_VIOLATION`                                       | 集成测试 + 演示场景 D + 设置页开关                                    |
| 同源反代     | Next.js 增加 `/api/v1/*` rewrite，浏览器默认走同源，Cookie 保持 first-party                                       | 无头 Chrome 全流程 20/20                                              |
| 角色校验     | `@RequireRole` 在 guard 里**只在路由带 projectId 时生效**；不带 projectId 的路由必须在 handler 里补 `assertRole`  | 逐路由审计 + 新增集成测试（见 §1.11）                                 |

### 1.11 `DELETE /mcp-tokens/:id` 的角色校验从未生效

guard 的实现是「`@RequireRole` + 路由带 projectId 才校验」，注释写明不带 projectId 的路由要在
service 层自己补检查。Token 吊销这条路由两样都没有：既无 projectId 参数，handler 里也没有
`assertRole`。结果是 `@RequireRole(PROJECT_MANAGER)` 只是装饰——**任何成员（包括 DEVELOPER）
都能吊销组织里任何人的 Token**，已用真实会话复现（HTTP 200 + `revokedAt` 被写入）。

修法：handler 里补 `assertRole(actor, '', PROJECT_MANAGER)`（与 `POST /skills` 同一写法），
UI 按 `/auth/me` 的角色隐藏吊销按钮，并让失败有 toast 而不是静默。

审计了全部 23 处 `@RequireRole`：其余 22 处要么路由带 `:projectId`、要么 body 里有 `projectId`、
要么 handler 里已有 `assertRole`，仅此一处是缺口。逐路由抽查也做了（`POST /skills`、
`POST /projects/:id/locales` 对 DEVELOPER 正确返回 403）。

回归测试写在 `security.integration.test.ts`：先用未修复的构建确认它失败（期望 403 实得 200），
再确认修复后通过，并断言「拒绝之后 Token 确实仍有效」与「OWNER 仍可吊销」——只断言状态码会
漏掉「返回 403 但其实已经写进去了」这类实现。

### 1.12 Skill 通过 MCP 下发给客户端

Skill 是文档，因此以 MCP **resource** 下发，指令型 Skill 额外注册 MCP **prompt**（客户端里是可调用
命令）。没有新增工具：规格 §6.2 把工具面固定在 14 local / 15 remote，而「读已发布的规范」不是一个需
要单独授权的平台能力（REST 侧 `GET /skills` 同样不带 role 或 scope 要求）。

| 端点                        | 内容                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `localehub://skills`        | 清单（Markdown 表格：slug、版本、resource URI、prompt 名称） |
| `localehub://skills/{slug}` | 完整 `SKILL.md`（含 frontmatter），`text/markdown`           |
| `skill-<slug>`              | 仅 `PUBLISHED` + `kind=PROMPT`；可选参数 `focus`             |

规则（`packages/contracts/src/mcp-skills.ts` 一份实现，两个 Server、API 与 Web UI 共用）：
只下发 `PUBLISHED`；每 slug 只取最高版本（`1.10.0` > `1.9.0`，按数字比较）；`kind=SCRIPT` 只有
resource 没有 prompt；prompt 名统一加 `skill-` 前缀。

`skill-` 前缀不是装饰：`McpServer.registerPrompt` 对重名**直接抛错**，而那个错发生在 Server 构建
阶段——一个 slug 撞上内置 prompt 名，等于整台 Server 每个请求都失败，不只是该 Skill 不可用。
`REMOTE_MCP_PROMPTS`（与 `REMOTE_MCP_RESOURCES` 一起）是第二道防线，也是发现接口的唯一来源。

失败降级是**有意的**：skills 查询抛错时只记 stderr 并返回空列表（否则一个附加功能会带塌
15 个工具）。Remote MCP 无状态、每个请求建一次 Server，所以 Skill 是实时的——新发布的 Skill
下一个请求就能读到，不需要重启任何客户端。

验证（真实协议，不是断言内部对象）：

- 单元：`packages/contracts/src/__tests__/mcp-skills.test.ts`（15 个，含 `1.10.0 > 1.9.0` 与
  pre-release 排序）、Remote MCP 用 SDK 的 `InMemoryTransport` 跑真实 MCP 协议（8 个，其中 2 个
  断言「注册了什么」与「`/mcp/tools` 声明了什么」完全一致）；
- 集成：`skill-delivery.integration.test.ts`（11 个）——真库 + 真 API + 真 Remote MCP 进程 +
  真 Streamable HTTP 客户端，覆盖「DRAFT 不下发」「取最高版本」「跨组织不可见」「SCRIPT 无 prompt」
  「内置 prompt 与生成的 prompt 并存不重名」「`GET /skills` 的注解与 Server 一致」；
- 实测：容器栈里注册 5 个内置 Skill 后，SDK 客户端列出 7 个 resource、7 个 prompt，读到
  `translation-review` 正文 572 字节。

顺带修掉一个上游缺陷：`LOCALEHUB_API_URL`（文档写明覆盖 config 文件）此前被已删除的 MCP 入口写在
它自己那份 `LoadedConfig` 上，而 `LocalSyncServices` 会重新加载配置，于是覆盖被静默丢弃——所有
调用方都在和 config 文件里的地址通信。已移到 `LocalSyncServices.config()`（真正读配置的地方），
`services.test.ts` 有回归测试。

### 1.13 平台改为只暴露一个 MCP（偏离规格 §6.1 / §6.2）

**决定由用户做出**：不再提供 Local MCP，平台侧只保留 Remote MCP。这与交付规格 §6.1
（「必须采用双 MCP 边界」）与 §6.2（「Local MCP Tools（必须实现）」）不一致，是本项目
**有意偏离规格**的一处。

理由：

1. Local MCP 由每个开发者的客户端进程各自拉起，版本与能力随机器而变，平台无法统一管理、
   也无法在不打扰用户的情况下更新；
2. 它让「能力清单」失去唯一来源——工具、resource、prompt 散在两台 Server 上，平台的发现接口
   只能把两份清单糊成一个扁平列表，结果声明了 6 条没有任何 Server 实现的 resource，还把一个
   已删除 Server 的 prompt 当成通用清单发布（见 §1.12）。

**本地仓库读写并没有消失**，只是换了载体：`apps/mcp-local` 删除，引擎原地成为
`packages/local-sync`（不含任何 MCP 依赖，类名 `LocalMcpServices` → `LocalSyncServices`），
由 `apps/cli` 驱动。安全属性逐条保留：

| 属性                                                         | 原来由谁保证       | 现在由谁保证                        |
| ------------------------------------------------------------ | ------------------ | ----------------------------------- |
| `allowRead`/`allowWrite`/`deny*` 白名单、`..` 与符号链接逃逸 | Local MCP 工具层   | 同一份 `WorkspaceGuard`（CLI）      |
| 备份 + 原子写 + 写后重解析                                   | Local MCP 工具层   | 同一份 `SafeFileWriter`（CLI）      |
| 先预览后确认、默认 dry-run                                   | MCP `confirm=true` | CLI `--confirm`（缺省即拒绝）       |
| 平台够不到开发者磁盘                                         | 两 Server 分离     | 只有一个平台侧 Server，结构上更彻底 |

失去的是：MCP `annotations` 的 `readOnlyHint` 不再覆盖本地动作（客户端无法据此决定是否弹确认），
改由 CLI 的 `--confirm` 与退出码承担；Agent 需要本地能力时必须用 Bash 调 CLI，而不是调 MCP 工具。

契约层同步收缩：`LOCAL_MCP_TOOLS` / `localToolSchemas` / `LOCAL_TOOL_DESCRIPTIONS` 删除；
`localServerConfig` 与 `localAndRemote` 片段删除；`mcpClientConfig` 只剩单条远端条目，
`localehub mcp-config` 不带 `--remote` 时向平台的公开发现接口询问自己的地址。

顺带修掉 §1.12 提到的发现接口失真：`REMOTE_MCP_RESOURCES` / `REMOTE_MCP_PROMPTS` 进契约，
Server 与 `/mcp/tools` 从同一处取，并有集成测试断言「声明的每一条都真的注册了」——那条
`localehub://projects/{projectId}` 及其 4 个子资源从未被任何 Server 实现，已从声明中移除。

### 1.14 用户管理：组织内建号、分配角色（本轮新增）

此前**没有任何用户管理能力**：`POST /auth/register` 只在实例无用户时可用，`POST /projects/:id/members`
要求账号已经存在，于是除首个管理员外，任何人都无法创建账号。设置页只有一张角色说明表。

现在补全为「管理员在组织内直接建号」——不做邀请、不开放外部注册（用户明确要求）：

| 能力     | 位置                                                           | 说明                                                         |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| 成员列表 | `GET /organization/members`                                    | 含组织角色、各项目角色与 `localeScope`、最近登录             |
| 建号     | `POST /organization/members`                                   | 邮箱 + 姓名 + 初始密码 + 角色；邮箱已存在时只挂组织关系      |
| 改角色   | `PATCH /organization/members/:userId`                          | 组织级角色                                                   |
| 移出组织 | `DELETE /organization/members/:userId`                         | 同时删除其项目角色，避免重新加入时恢复旧权限                 |
| 重置密码 | `POST /organization/members/:userId/password`                  | 无邮件通道，由管理员转达                                     |
| 项目角色 | `PUT/DELETE /organization/members/:userId/projects/:projectId` | 单项目角色 + 语言范围                                        |
| 页面     | `/settings/members`                                            | 列表内联改角色、项目角色增删、建号对话框、重置密码、移出组织 |

五条提权守卫抽出到 `packages/permissions`（`assertCanManageMembers` / `assertCanGrantOrgRole` /
`assertCanManageMember`），11 个单元测试逐条钉住：不能授予高于自己的角色、不能修改高于自己的成员、
不能动自己、不能移除最后一个所有者、MCP Token 不能管理成员。

**其中一条是真实的账号接管面**：`POST /organization/members` 对已存在的邮箱**绝不复写密码**。若照搬
「按邮箱添加并设置密码」的常见写法，任何组织管理员都能用自选密码接管平台上任意账号。集成测试专门
验证：管理员用自选密码「添加」一个已有账号后，原密码仍可登录、管理员给的密码不能登录。

`users` 表没有 RLS（人可属于多个组织，没有 `organization_id` 列），所以所有用户读取都以
**RLS 保护的 `memberships` 查询返回的 id** 为键；按邮箱查人是特权读取，与登录同一例外，且仅此一处。

验证：21 个集成测试（真库 + 真 API）覆盖列表/建号/登录/重复成员/密码规则/提权守卫/项目角色/移除后
清理/重置密码；无头 Chrome 实测 `/settings/members` 渲染 6 名成员、导航可进入、建号对话框字段正确、
真实提交后表格出现新成员且该账号能用所填密码登录、桌面与 390px 均无横向溢出。

### 1.15 `POST /projects` 的角色校验从未生效（本轮发现并修复）

与 §1.11 同一类：guard 只在路由带 `projectId` 时应用 `@RequireRole`，而 `POST /projects` 既无
path 参数、body 里的 `projectId` 也不是自己，handler 与服务层都没有补 `assertRole`。结果是
**任何成员（含 READONLY）都能在组织里创建项目**——我先用真实会话复现（201 + 项目落库），再修，
再把它写进集成测试：READONLY 与 DEVELOPER 均返回 403 `ROLE_INSUFFICIENT`，且断言项目**没有被**
写进去（只断言状态码会漏掉「返回 403 但其实已经写进去了」）。

顺带审计了其余 `@RequireRole` 路由：`/organization/overview` 只返回计数、`/system/queues` 是刻意
`@Public()` 供探针使用、`/organization/settings` 在 service 内自查角色，均无同类缺口。

### 1.16 `POST /projects/:projectId/members` 可绕过全部成员守卫（本轮发现并移除）

写 §1.14 的守卫时留下一条旧路没关：`POST /projects/:projectId/members` 只要求**该项目**的
PROJECT_MANAGER，却会**代建组织成员关系**，并把传入的**项目角色当作组织角色**写进去。

实测复现：一个组织角色仅 `DEVELOPER`、只在某一个项目上有 PROJECT_MANAGER 的账号，调用该接口把一个
组织外的用户拉进组织，落库的组织角色是 `PROJECT_MANAGER`——高于他自己的组织角色，且完全绕过
§1.14 的五条守卫（不得越级授予、不得修改高于自己的成员、必须留至少一个所有者、MCP Token 不得管理
成员、以及「组织级成员管理需要 ORG_ADMIN」）。

该接口的 `POST` 在 Web、CLI、api-client 与测试中**都没有调用方**——它是纯遗留攻击面。已删除
（连同 `addMemberSchema` 与 `ProjectsService.addMember`），`GET` 保留（项目成员只读视图，无害）。
项目经理想给项目配人，走 `PUT /organization/members/:userId/projects/:projectId`（有守卫）；
要把人拉进组织，必须 ORG_ADMIN。

回归测试断言该路由返回 404。至此成员相关的写入路径只剩一条。

### 1.17 OpenAPI 3.1 文档由代码生成（本轮新增）

规格 §8.4 要求「通过 OpenAPI 3.1 生成文档和 TypeScript Client」，§16 的验收清单也列了「API
OpenAPI 文档和 MCP Tool Schema 完整」。

**没有**用 `@nestjs/swagger`。这个代码库用 `@Body(zodBody(schema))` 管道校验，不是 DTO 类，swagger
看不见它们——硬套的结果是给 81 条路由手写一遍 `@ApiBody` / `@ApiResponse`，那是**第二份**描述，必然
漂移。这正是上一轮修掉的 MCP 发现接口犯过的错（手维护的清单声明了 6 条没人实现的 resource）。

改为从**代码本身**装配（`apps/api/src/openapi/document.ts`），一条事实只说一遍：

| 文档里的内容                 | 来源                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| 路径、方法                   | `PATH_METADATA` / `METHOD_METADATA`                                                                      |
| `public` / `role` / `scopes` | `@Public` / `@RequireRole` / `@RequireScopes` 的 `SetMetadata` 键——**与 `AuthGuard` 请求时读的是同一份** |
| 请求体、查询 schema          | 路由参数上的 pipe 实例，即真正执行校验的 `ZodValidationPipe`                                             |

产出：`GET /api/v1/openapi.json`（public，客户端读它时还没有凭据）与提交进仓库的 `docs/openapi.json`
（81 个操作 / 68 条路径），由 `pnpm --filter @localehub/api openapi` 重新生成。

两处需要说明的设计：

1. **`@ApiAuth` 只描述、不强制**。有些路由的鉴权在 service 里（成员管理、`POST /projects`），guard
   元数据为空，文档里 `role: null` 会被读成「任何成员都可以」——与事实相反。这些路由用 `@ApiAuth`
   补上真实要求，并用 `x-localehub-auth.enforcedBy` 区分 `guard` / `service` / `authentication`。
   注解与执行分离，避免「写了注解就以为生效了」。
2. **响应体形状留空**。service 直接返回对象字面量，响应类型哪里都没声明。文档只描述信封
   `{success, data, error}` 并把 `data` 留作无约束，而不是编一个没有任何东西校验的形状。

一致性由 `__tests__/openapi.test.ts` 用**独立机制**守住（解析 controller 源码 + 读 app.module
注册表，不复用生成器的元数据走法）：路由集合双向比对、controller 覆盖、已提交文档逐字节比对、
手写 api-client 调用的每个端点都在文档里。四条断言都做了变异验证——故意漏掉 `QaController`、
改坏客户端路径、篡改已提交文档，测试都会红。

顺带修掉一处：`ResponseEnvelopeInterceptor` 会把 `/openapi.json` 也包成 `{success, data}`，任何
OpenAPI 工具都会找不到 `openapi` 字段。新增 `@RawResponse()` 让「描述 API 的文档」不属于「API 的
资源」，这是唯一一处豁免。

### 1.18 账号生命周期与组织审计（本轮新增）

补掉上一轮成员管理之后暴露出的几个缺口——它们都是「接口建好了，但人用不了」或「出事了查不到」：

| 缺口                      | 现在                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 改不了自己的密码          | `PATCH /auth/password`：需提供当前密码；管理员重置接口本来就拒绝操作自己，而平台没有邮件通道，此前本人**完全无法**轮换密码                                                                                   |
| 无法停用账号              | `PATCH /organization/members/:userId/status` + `users.deactivated_at`。暂停保留成员关系、项目角色与审计，但**现有**会话与 MCP Token 立即失效（`AuthGuard` 每请求检查），登录也被拒。不能暂停自己或唯一所有者 |
| 成员变更查不到            | `GET /organization/audit`（`?action=member.` 前缀筛选）+ `/settings/audit` 页。此前 `audit_logs` 一直在写，但唯一的读接口是项目级的，「谁把谁提权了」在全产品里无处可查                                      |
| 多组织登录是随机的        | 登录接受 `organizationId`，不传时进入 `last_organization_id`（新增列）记录的上次组织；传了不存在的组织返回 403 而**不是静默换一个**（见下）                                                                  |
| 多组织切换没有 UI         | 顶栏用户菜单里加组织切换（仅在属于多个组织时出现），切换后整页重载——所有已缓存页面都是按上一个组织取的                                                                                                       |
| `/system/queues` 无需认证 | 改为要求平台管理员。存活/就绪探针仍用公开的 `/health`、`/health/ready`                                                                                                                                       |

**测试抓到的一个真问题**：我最初用 `??` 链写组织选择，结果是「请求了不属于自己的组织」会**静默回退**到
另一个组织——调用方要的是 X，拿到的是 Y，之后所有写入都会落在 Y。集成测试直接把它照出来了
（期望 403，实得 201）。改成显式分支：给了 `organizationId` 就必须命中，否则 403。

`deactivated_at` 与 `last_organization_id` 两个字段都是可空、默认 NULL，迁移不重写表。

验证：15 个集成测试（真库 + 真 API）覆盖改密码（当前密码错误 401、旧密码失效、MCP Token 被拒、写审计）、
暂停（现有会话 403 `ACCOUNT_DEACTIVATED`、已签发的 MCP Token 同样失效、新登录被拒、恢复后可用、不能暂停
自己/唯一所有者、写审计）、审计（普通成员 403、跨组织不可见、记录操作者与目标）、登录选组织（进入指定组织、
记住上次、拒绝不属于的组织）、队列接口（无凭据 401、平台管理员 200、普通管理员 403）。
无头 Chrome 实测四个新/改页面均渲染真实数据、无报错、无横向溢出，并真实点击完成一次「暂停 → 徽章出现 →
恢复」。

### 1.19 CSV / XLSX 适配器（本轮新增）

规格 §10.1 给这两种格式的用途写得很具体：**「产品经理批量编辑、导入校验」**。它们是给人用的导入
导出通道，不是仓库同步格式——这条定位决定了下面每个决定。

- **`CsvAdapter`**：RFC 4180，带电子表格实际会产出的东西（引号字段、字段内换行、双写引号、CRLF）。
  导出写 BOM，因为 Excel 在 Windows 上会把无 BOM 的 UTF-8 CSV 按系统代码页读，非 ASCII 译文全乱；
  读取时容忍 BOM。`applyPatch` **只替换变化的单元格**，行尾、引号风格与列顺序原样保留——与 JSON
  适配器打 token 补丁而不是重新序列化同一个理由。
- **`XlsxAdapter`**：基于 `exceljs`（自己写 xlsx 是典型的重复造轮子）。导出为 base64 + mimeType，
  读取时把数字、日期、富文本、公式结果都归约成「人会看到的那段文字」。
  **`applyPatch` 明确拒绝**：工作簿是 zip 压缩的 XML 部件，「改一个单元格」等于重新生成整个档案，
  没有能保留作者所做修改的原地编辑。所以 `xlsx` **不在** `formatIdSchema`（仓库映射可声明的格式）里
  ——允许它出现在 `.localehub/config.yaml` 会造出一个永远 apply 不了的映射。导入导出走更宽的
  `exportFormatSchema`。
- **列名按名字解析，不按位置**，且**表头必需**：有人在表格里插一列，按位置解析就会把译文读进 key 列。
  大小写不敏感，接受 `Key`/`键`、`Translation`/`译文`、`Language`、`Comment`/`注释`。
- **校验一次报全部问题**：缺 key、缺 locale、重复（key+namespace+locale 三元组，因此同一 key 出现在两个
  namespace 不算重复）、以及值以 `=`/`+`/`@` 开头（电子表格会当公式）——行号按 1 起算并计入表头，与
  用户看到的表格一致。

`GET /projects/:projectId/export` 现在返回 `encoding` 与 `mimeType`，二进制格式不再需要第二个端点。

验证：22 个单元测试（含列顺序打乱、BOM、CRLF、字段内换行、转义往返、按 namespace 精确匹配、
XLSX 数字与富文本、拒绝原地补丁、zip 签名识别）+ 6 个集成测试（真库 + 真 API：导出 JSON/CSV/XLSX，
XLSX 解出来是 zip 签名并能被适配器读回同样的译文，未知格式 422）。

### 1.20 Webhook 事件推送（本轮新增）

`SYNC_PUSHED`、`TRANSLATION_APPROVED` / `TRANSLATION_REJECTED` 会推送到组织配置的 HTTP 端点。

| 能力     | 位置                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 端点管理 | `GET/POST/PATCH/DELETE /organization/webhooks`                            |
| 投递历史 | `GET /organization/webhooks/:id/deliveries`                               |
| 签名     | `x-localehub-signature: t=<unix>,v1=<hex>`，HMAC-SHA256 over `<t>.<body>` |
| 事件标识 | `x-localehub-event`、`x-localehub-event-id`                               |

几个刻意的决定：

- **事件先落库再入队**。`webhook_deliveries` 是耐久记录，队列只是通知 worker；重启、重部署或 Redis
  清空都不会丢掉一个已经接受的事件，运维也永远能回答「这条到底送达没有」。
- **签名密钥加密存储，不是哈希**。这是唯一无法套用「只存哈希」规则的地方：校验 Token 只需要哈希，
  而**生成**签名需要密钥本身。用 `ENCRYPTION_KEY` 派生的 AES-256-GCM，数据库被拖走也伪造不了签名。
- **时间戳在被签名的字符串里**，不只是放在旁边——否则截获一个请求、改一下 `t` 就能重放。
- **至少一次投递**。worker 在消费者处理完但行未更新时崩溃会导致重复投递；`x-localehub-event-id` 是
  给消费者去重用的，文档里写明了。
- **重试约 9 小时**（10s → 30s → 2m → 10m → 30m → 2h → 6h），之后标记 `FAILED` 并留在投递日志里。
  维护窗口内下线的消费者仍能收到，彻底消失的消费者不会被反复打扰。
- 无 `eventTypes` 的端点接收全部事件——这是运维加一个 webhook 时的本意，而「静默收不到任何东西」
  是更糟的默认。

### 1.21 映射变更检测（本轮新增）

`FILE_MAPPING_CHANGED` 此前只是声明了一个冲突原因，从未被任何代码产生。现在当 baseline 记录的
`localFileId` 与本次扫描的文件不一致、且两侧都发生变化时，冲突原因是它而不是笼统的
`LOCAL_AND_REMOTE_CHANGED`——因为审核人真正要决定的是：把远端值写回去，会落到一个这条译文从未住过的文件里。

baseline 没有记录文件 id（该列之前就存在但没传给 diff）时**不**报告映射变化：把「未知」当成「变了」
会让每个尚未推送过的项目里的每条冲突都被错误重标。

验证：4 个单元测试（映射变化、普通双侧冲突不受影响、baseline 无记录时不误报、纯移动不算冲突）。

### 1.22 三个真实缺陷：后台任务从未工作（本轮发现并修复）

做 Webhook 时，端到端验证暴露了三个各自独立、又互相掩盖的缺陷。**异步 QA 从未成功入队过**：

1. **`jobId` 含冒号**。`qa/run-async` 传 `jobId: \`qa:${projectId}:...\``，BullMQ 的 job id 会成为
Redis key 的一部分，直接拒绝（`Custom Id cannot contain :`）。
2. **入队失败被静默吞掉**。`QueueService.enqueue` 为了不让请求失败而 catch 掉异常并返回
   `queued: false`，但**没有任何调用方检查这个返回值**——端点照常返回 201，客户端以为任务已受理。
   同步 QA 一直可用，所以这个洞一直没被注意到。
3. **worker 没有 RLS 上下文**。worker 用的是裸 `PrismaClient`，不设置 `app.current_org_id`；而所有
   租户表都有行级策略，于是**未限定租户的读取返回 0 行**。QA 任务因此读到「项目不存在」，
   Webhook 任务读到「投递行不存在」——两者都表现为「任务跑完了但什么都没发生」。

修法：job id 改用连字符；`enqueue` 失败打日志，`qa/run-async` 在 `queued === false` 时返回 503
而不是假装成功；worker 的作业体走 `TenantPrisma.withOrganization`（与 API 同一条受认可路径），
Webhook 作业把 `organizationId` 放进载荷——读那一行本来就需要它。

验证：`scripts/check-webhook-worker.mjs` 起一个真实 HTTP 接收端，经 API 触发事件，等 **worker 进程**
投递，再用消费者的方式验签——通过（`delivered SYNC_PUSHED | signature verified: true`）。
异步 QA 实测 `queued: true` 且 `qa_runs` 达到 `SUCCEEDED`。

### 1.23 发布包导出（本轮新增）

| 能力 | 位置                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| 打包 | `POST /projects/:projectId/releases/:releaseId/bundle`（PROJECT_MANAGER）                 |
| 下载 | `GET /projects/:projectId/releases/:releaseId/bundle`（READONLY，返回 `application/zip`） |

- **确定性**。条目按名字排序、时间戳固定为 1980-01-01、存储而非压缩，因此同一份快照永远产出同样的
  字节——`releases.snapshot_checksum` 才有意义：下载的人可以自己复算。测试直接断言「重新打包字节相同」。
- **自描述**。`manifest.json` 记录发布名、生成时间、语言、来源 id 与 checksum，以及**每个文件的 sha256**，
  便于部分下载时校验。
- **按项目鉴权，不按路径**。发布 id 会对着 `release` 行核对 `projectId`，所以猜到一个 id 也取不到别的
  项目、别的组织的包。
- **不走 JSON 信封**。zip 被包进 `{success, data}` 就不是 zip 了，这条路由用 `@RawResponse()`。
- 存储是按 `组织 id/发布 id.zip` 寻址的目录。规格 §8.4 要求预签名 URL 而不是把大文件塞进 JSON 响应体
  ——目录存储给出同样的性质（下载是独立请求，字节不经过 JSON），换 S3 只需替换 `bundles.ts` 里的
  存储层。**导入导出仍走 JSON 响应体**，这一条还没做完。

zip 是手写的（约 120 行）而不是引依赖：需要的形状很小，而约束很具体——存储式条目、固定时间戳、
排序文件名，通用库在这三点上都要对抗。测试用一个独立的读取器解析产物并逐条校验 CRC。

验证：9 个单元测试（分组与 namespace 展平、排序稳定性、独立读取器解析、跨运行确定性、非 ASCII
路径与内容、manifest 内容与摘要、存储的读写与隔离）+ 6 个集成测试（真库 + 真 API：建发布、未打包时
404、打包、下载得到真实 zip 且信封未污染、重新打包字节相同、跨项目 id 取不到）。

### 1.24 `users` / `organizations` / `review_actions` 的 RLS（本轮新增）

这三张表最初被排除在行级策略之外，因为它们都没有 `organization_id` 列：`users` 与
`organizations` 天然是全局的，`review_actions` 通过 `review_tasks` 关联租户。

**这个缺口的方向是危险的**：应用角色不是表 owner，没有策略时未限定租户的读取返回的是
**全部行**，而不是零行。对 `users` 来说，这意味着任何忘记加过滤条件的代码路径都能读到所有用户的
密码哈希。

三张表各自的策略用各自能表达的写法：

- 用户：属于当前组织时可见，经 `memberships` 子查询判断——而 `memberships` 本身受策略保护，
  所以这条不能用来枚举别的租户的人；
- 组织：只有当前会话所属的那一个可见；
- 审核动作：其审核任务在范围内时可见。

给 `users` 加策略**当场打断了登录**，而这正是这次改动有价值的部分：`auth.controller` 写
`lastLoginAt` 用的是裸 `prisma.user.update`，新策略下匹配 0 行，报错是「record not found」——
一个刚刚认证成功的账号却「不存在」。该调用改为走 `withoutTenantScope`（这个文件里其他用户读取
本来就走这条特权路径），并做了一次全仓扫描确认三张表上不再有裸调用。

这个例外是承重的、不是顺手加的，因此写在策略注释里：登录与 Token 认证在 `app.bypass_rls = on`
下运行，因为它们在任何组织已知之前就要读 `users`。

验证方式特意选了**直接用应用角色**（生产同款凭据）而不是经过 API：跨租户读为空、无上下文读为空、
审核动作经任务正确隔离，以及登录路径依然可用。

### 1.25 Docker 栈已重建并验证（本轮）

本轮最后一次改动后，Docker 守护进程内的网络一度持续失败（`registry.npmjs.org` 上的 `ECONNRESET`），
`docker compose build` 装不进新代码，而数据库已应用新的 RLS 迁移——旧镜像里裸写的
`prisma.user.update`（登录更新 `lastLoginAt`）在新策略下匹配 0 行，于是容器栈登录返回 404。

网络恢复后已重建并验证。**其中一处值得记下**：`worker` 用的是独立镜像 `localehub-worker`，不是
`localehub-api`；只重建后者时 worker 仍跑旧代码，日志里少一个队列（4 个而不是 5 个），很容易被当成
「新功能没生效」。完整重建命令是：

```bash
docker compose build api worker mcp-remote web && docker compose up -d --force-recreate
```

重建后的容器栈验证：

- 登录恢复（此前 404 的那条）；
- 98 个集成测试对着**容器栈**全过（不是本地进程）；
- `scripts/check-webhook-worker.mjs` 经容器内 worker 真实投递并验签通过——注意脚本的接收端要
  监听 `0.0.0.0` 并把 `host.docker.internal` 写进 URL，否则容器内的 worker 连不上宿主上的接收端，
  表现为 `fetch failed`（重试机制会正确地把它标成 PENDING/重试中）；
- demo A–E 通过；
- 无头 Chrome 实测 **15/15** 页面渲染真实数据、无错误提示、无横向溢出；390px 下五个设置页同样无溢出。

### 1.26 MCP 接入教程与「按使用者适配」（本轮新增）

此前的 `/mcp` 页面把工具表、资源、配置片段都列了出来，却**没有一条从头到尾的流程**：读者要自己
拼出「先签 Token → 再找 project_id → 粘贴配置 → 验证」。其中最要命的是 project_id——15 个工具里
14 个把它当第一个参数，而它在 UI 里**根本看不到**，只能去翻 URL 或者先跑一次 `list_projects`。

现在：

- `/mcp` 新增「接入教程」标签页并作为默认页：四个编号步骤（签 Token → 拿 project_id →
  放配置 → 验证并开始用），每步给出可点的入口与可复制的片段；
- **项目详情页标题旁显示 `project_id`，点击即复制**；
- 教程里的示例提示词用**当前登录者自己的项目**生成（名称与 id 都是真实的），不是演示数据；
- 文档补了同一份四步流程，以及 §2.3「使用者之间如何隔离」——把「数据自动适配使用者」落到具体机制上：
  Token 绑定、角色解析、RLS、以及示例按读者生成。

关于「自动适配」需要说清楚边界：**平台侧本来就没有需要使用者改的配置**。工具看到哪些项目由 Token
的 `project_ids` 与用户的项目角色决定，SQL 层再由 RLS 兜底；接入者看到的列表、示例里的 id、能读到的
译文，天然都是他自己的。真正缺的是**把这些暴露出来**——一个看不见的 id 会让「自动适配」在体验上退化
成「你得先想办法找到它」。

验证：无头 Chrome 实测教程页为默认标签、四个步骤渲染、页面出现真实 project_id、提示词带
`project_id=`、无报错无溢出；项目详情页显示并可复制 id。另有一个端到端脚本按教程四步真实走一遍
（`scripts/check-mcp-onboarding.mjs`）：签一个只绑定单个项目的 Token，经真实 MCP 传输调用
`list_projects`——**只返回那一个项目**，再用该 id 调 `list_project_locales` 成功。

**运行期间的一次磁盘事故**：重建镜像把 Docker 磁盘占满，Postgres 因
`could not write lock file "postmaster.pid": No space left on device` 反复重启，API 报
`Can't reach database server at postgres:5432`。`docker builder prune -af && docker image prune -af`
回收 21.77 GB 后自行恢复，无需重建数据。这一条与 §1.10 的「只在容器里出现的缺陷」同类：
**症状指向数据库，原因在磁盘**。

### 1.27 从仓库初始化项目（本轮新增）

上一轮补了接入教程，但它默认「你已经有一个项目」。真实的第一天不是这样：仓库里已经有语言文件，
平台上什么都没有。而且**远程 MCP 当时根本没有建项目的工具**——15 个工具全是读写既有项目，Agent
无法把仓库接到平台上。

新增两个工具：

| 工具                  | 做什么                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `create_project`      | 建项目（语言、平台、创建者成为该项目 PROJECT_MANAGER），**返回可直接写入 `.localehub/config.yaml` 的完整内容**与后续步骤 |
| `import_translations` | 把一批语言文件内容写成 Key / 源文版本 / 译文；默认 dry-run，`confirm=true` 才落库                                        |

三个刻意的决定：

1. **是 Agent 读文件，不是平台。** 平台够不到开发者的磁盘，所以 Agent 用自己的文件工具读语言文件、
   把内容交给 MCP。这不是绕过边界，而是边界本身决定的形状。
2. **配置是「返回」而不是「写入」。** `create_project` 把配置文件的内容作为返回值交给 Agent，
   由 Agent 写进仓库——初始化路径上同样不碰使用者的磁盘。
3. **导入复用 CLI 的管道**（`recordScan` → `createPreview` → `push`），因此 Agent 导入与 CLI 推送
   不可能在平台上留下不同的状态。

**顺带消除了两份实现**：建项目原本只在 `ProjectsService.create` 里，MCP 要建项目就得抄一遍。现在抽到
`packages/domain/src/projects.ts` 的 `createProject(tx, input)`，REST 与 MCP 共用；`slugify` 同理。
`localehub init` 与 `create_project` 也共用 `packages/workspace/src/config-template.ts` 的模板，
所以「命令行初始化」与「Agent 初始化」产出的配置文件逐字一致。

**容器状态**：BuildKit 因 Docker Hub 认证失败（`failed to fetch oauth token: … EOF`）无法构建，但旧版
构建器可用——它直接使用本地已有的基础镜像，不需要 registry 认证：

```bash
DOCKER_BUILDKIT=0 docker compose build api worker mcp-remote web && docker compose up -d --force-recreate
```

已用这条路重建并验证：容器栈的 `/mcp/tools` 返回 **17 个工具**（含 `create_project` /
`import_translations`），104 个集成测试与 demo 对着容器栈通过，并用真实 MCP 客户端在容器上走完了
建项目 → 返回配置 → dry-run → 确认导入（`{"created":2,...}`）。

验证：6 个集成测试（真库 + 真 API + 真 MCP 进程 + 真 Streamable HTTP 客户端）。其中最关键的一条是
**把 `create_project` 返回的配置文本喂给 `localConfigSchema` 校验**——一个「看起来对但 CLI 不接受」的
模板会让使用者拿到一个坏仓库却看不出原因。其余覆盖：返回的后续步骤含项目 id 与 token 变量、
DEVELOPER 建项目被拒、dry-run 不落库、确认后 Key 与译文确实写入、Token 未绑定的项目被拒。

### 1.28 MCP 的写入不进审计（本轮发现并修复）

用户问「现在没有把初始项目汇报到服务器的吗」。检查一次真实初始化后的库：

```
project 1 | locales 2 | translation_keys 2 | translation_entries 4
repository_connections 1 | sync_scans 1 | sync_sessions 1 | sync_baselines 4
project_events 7 | audit_logs 0
```

项目、条目、事件都在，唯独 `audit_logs` 是 **0**——而同一份数据走 REST 推送时，`sync.push` 已经
写了 340 行。`grep -c 'audit' apps/mcp-remote/src/server.ts` 返回 `0`：Remote MCP 里一次审计都没写。

这不是「少了个锦上添花的功能」：§1.18 刚建的组织审计页读的就是这张表，所以**通过 MCP 做的每一次
写入在产品里都是隐形的**，「谁导入了这四十个 key」在系统里没有答案。

根因是结构性而非遗漏——写入逻辑原本放在 Nest 的 `AuditService` 里，一个 `@Injectable()`，MCP 进程
根本构造不出来。所以：

| 改动                                                     | 为什么                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 抽出 `packages/domain/src/audit.ts`（`recordAudit` + `redactForAudit`） | 两个进程写同一张表，就必须共用同一段写入逻辑，否则形状迟早分叉                               |
| `AuditService` 改为薄封装                                | 只保留请求特有的东西（`requestId` 来自 async context），其余全部委托                          |
| MCP 加 `audit()` 小助手                                   | actor 一律取自 Token，不接受工具参数——审计的意义就是记「真正是谁做的」                        |
| 六个写工具各加一处                                       | `project.create`、`sync.push`、`translation.ai_translate`、`translation.review`、`translation.draft_update`、`translation.submit_review` |

四个刻意保持的性质：

1. **只读不记账。** dry-run 与 `write_drafts:false` 不写，否则审计页把「看一眼」记成「改一次」。
2. **键名脱敏。** `token` / `secret` / `password` / `authorization` / `cookie` 在落库前替换为
   `[redacted]`，递归处理嵌套对象与数组。
3. **失败不外抛。** 审计写不进去只打 stderr：被记录的动作已经完成，不能因为记不上账就让它看起来失败。
4. **在事务提交之后写。** `recordAudit` 走独立连接，所以 `review_translation_entries` /
   `update_translation_draft` / `submit_review` 里的审计调用被移到 `withOrganization` **之外**：
   放在里面的话，业务事务一旦回滚，审计行会留下来，页面就会声称一次没发生的审核「已批准」。

`import_translations` 沿用 REST 的 action 名 `sync.push`（同一件事），用 `metadata.via` 区分入口，
所以按 action 聚合的统计不会因为入口不同而裂成两份。

**顺带让审计页真的能回答那个问题**：`GET /organization/audit` 增加 `?actorType=mcp` 过滤，返回的每行
带上 `mcpClient`（名称、Token 前缀、是否已撤销）；`/settings/audit` 因此能一眼分出「人改的」与
「Agent 改的」，并在 Agent 行上标出具体是哪把 Token——撤销时不会误伤同事的 CI。

验证：8 个新增单元测试（脱敏、默认值、特权路径、失败不上抛）+ 2 个新增集成测试。都用真 MCP 客户端
建项目、dry-run、确认导入，然后：

- `GET /projects/:projectId/audit` 断言 `project.create` 与 `sync.push` 都在、`actor_type='mcp'`、
  `actor_id` 与 `mcp_client_id` 都指向真实身份、dry-run 没有留下第二行；
- `GET /organization/audit?actorType=mcp` 断言返回的每行都是 MCP、`actor.email` 是签发人、
  `mcpClient.name` 是 Token 名、前缀匹配、未撤销。

### 1.29 平台 → 仓库方向没有闭环（本轮新增 `mark_applied`）

上一轮把「仓库 → 平台」补齐了，但反方向是断的：Agent 能读已审核译文（`get_pending_platform_changes`）、
能自己写文件，**却没有任何工具能说「我写完了」**。后果是 `applied_to_repo_at` 永远为空：

- `get_pending_platform_changes` 每次都把同一批变更再发一遍，Agent 反复做同一件事；
- `validate_release` 一直把它们算作「未落地」；
- 仓库和平台明明一致，系统却认为不一致。

CLI 侧这条路是通的（`apply --confirm` → `POST /sync/apply-reports`），所以缺的不是机制而是入口。

新增第 18 个工具 `mark_applied`：`{ project_id, items[{key, locale, platform, file_path?, translation_version_id?}],
dry_run, git_commit? }`。它写 `applied_to_repo_at` / `applied_to_repo_commit`、把三方比较基线推到已收敛、
发 `SYNC_APPLIED` 事件、留 `sync.apply` 审计，并建一条 `pull` 方向的 sync session 与 apply report
——所以 Agent 的落地在同步历史里和 CLI 的落地并排可见。

**每条都要带 `translation_version_id`，这是这个工具唯一真正的安全检查。** 平台看不到开发者的磁盘，
这条记录本质是**声明**而不是**观测**（和 CLI 的 apply report 同一种信任）。平台能验证的是「你声明的
版本是不是它现在持有的版本」：带旧版本号的条目判为 `VERSION_SUPERSEDED` 并**拒绝标记**。否则一个慢
半拍的 Agent 会把昨天的译文写进仓库、标记为已落地，平台从此不再下发新的那条——这是系统里唯一没有
其他机制能发现的偏差方向。其余判定：`NOT_FOUND`、`ALREADY_APPLIED`（幂等：重复调用不报错、不重复记
事件、不建 session）、`DRAFT_NOT_ALLOWED`（未审核文本落仓库需要组织打开 `allowDraftApply`，与 REST
拉取同一条策略）。`dry_run=true` 只回答不写。

`reportApply` 与 `markApplied` 共用抽出来的 `recordRepositoryWrite`：两边都在对一台平台看不见的机器
做同一个断言，就必须移动同样三样东西（落地标记、基线、事件），两份实现迟早分叉。

**顺带发现并修复：MCP 完全不校验 scope。** 实测确认——签一个只有 `project.read` 的 Token，调用
`import_translations` 能成功写库。服务端只 `assertRole`，从不 `assertScope`，而 REST 路由是靠
`@RequireScopes` 拦的。于是规格 §2.2「`sync.push` 与 `translation.apply` 必须分离授权」在唯一真正
依赖它的入口上失效——默认签发的 Token 明确不含 `translation.apply`，但它照样能把平台变更标记为已落地。

修复方式是把对应关系写进契约（`REMOTE_MCP_TOOL_SCOPES`），并在 `define` 包装层统一断言：放在包装层
而不是各 handler 里，因为「忘了写的检查」等于「没有检查」。映射逐条对齐 REST：

| 工具                         | scope                                              | 对应 REST                     |
| ---------------------------- | -------------------------------------------------- | ----------------------------- |
| `import_translations`        | `repository.scan` + `sync.preview` + `sync.push`    | `/sync/scans`、`/sync/preview`、`/sync/push` |
| `update_translation_draft`   | `translation.write`                                 | `POST /translations/:id/draft` |
| `review_translation_entries` | `translation.review`                                | `POST /translations/review`    |
| `mark_applied`               | `translation.apply`                                 | `POST /sync/apply-reports`     |

其余工具与 REST 对应路由一致：只校验角色。

验证：契约层 5 个单元测试（工具与 schema 一一对应、scope 映射只引用真实工具与真实 scope、两个写工具
的 scope 被钉住）+ 6 个新增集成测试，用真 MCP 客户端跑完整闭环：把一条译文改成 APPROVED →
`get_pending_platform_changes` 显示未落地 → `dry_run` 不写不建 session → 确认后落地、平台不再下发、
REST 视图一致 → 审计有 `sync.apply` 且带 `via: mark_applied` 与 commit → 重复调用幂等且不重复记账 →
平台在期间又改了一版时旧版本号被拒（且真的什么都没改）→ 只有 `sync.push` 的 Token 调 `mark_applied`
得到 `SCOPE_INSUFFICIENT`，但仍能做它被授权的事。

### 1.30 MCP 之前不教怎么用（本轮新增 instructions / 教程资源 / 提示词）

起因是一份真实记录：一个 Agent 连上来，用「发畸形请求看报错」的方式摸 `import_translations` 的入参，三次
往返才问出 `files[0].entries[0].key`，最后写下「MCP 只报字段名，无文档」。

**这个判断是错的，但结论是对的**——schema 一直是完整的（`tools/list` 返回 `required`、嵌套结构、类型、
`default`、`min/max`），只是**没有任何一层在教**。它的试错方法还有个结构性缺陷：报错只列**必填**字段，
凡是带默认值的字段全部隐身，而这里带默认值的恰好是最危险的三个：

| 字段 | 默认值 | 不显式传会怎样 |
| --- | --- | --- |
| `platform` | `web` | iOS 的 key 全部落到 `web` 下。platform 是 key 身份的一部分，之后用 `ios` 扫同一批文件会变成两套不相干的 key |
| `namespace` | `''` | iOS 的 Localizable / InfoPlist / LaunchScreen 三张表拍平成一个 key 空间，同名 key 互相覆盖且不报错 |
| `confirm` | `false` | 这个默认是对的，但它不知道——于是把「安全的两段式」当成「5800 条不可逆写入」在担心 |

所以现在补了四层，各司其职：

| 层 | 内容 |
| --- | --- |
| `instructions` | 两个方向别搞反（仓库→平台 / 平台→仓库）、三条事后难改的规则、分批上限、dry-run 默认 |
| `localehub://import-guide` | 完整教程：调用形状、逐条规则、实测边界、推荐顺序、`.strings` 解析坑 |
| `import-localization-files` 提示词 | 七步流程（读文件 → 推 locale/platform → dry run → 分批导入 → 核对），供人从客户端直接唤起 |
| 工具与字段 `description` | 每个字段在什么情况下会出错；**字段描述随 schema 走，所以默认值也能被解释** |

字段描述是关键：`platform` 在 schema 里现在是
`{"type":"string","enum":[…],"default":"web","description":"默认是 web：iOS 请传 'ios'…platform 是 key 身份的一部分"}`。
这正是试错法拿不到的东西。

**顺带把上传上限量清楚了**（此前只是从代码推断）。整个导入跑在一个 Prisma 交互式事务里，默认超时 5 秒：

| 单次调用条目数 | 结果 |
| --- | --- |
| 400 | 成功，约 3.2 秒 |
| 1000 | 失败：`Transaction already closed: … timeout was 5000 ms` |
| 1400 | 失败：同上 |

失败是原子的（超时那次落库 0 条）。教程因此给的是「按文件 × 语言拆开，每批 300~400 条」，并说明重复导入
幂等（未改动的值判 `changed:false`，不产生重复版本）。一万条 key 约 30 次调用——这是当前实现的真实上限，
把工具改成服务端自动分批是后续项（见 §5）。

验证：19 个 MCP 单测（其中 12 个新增，覆盖 instructions 的两方向与三条规则、教程资源的 URI/mime/必含条款、
提示词的参数渲染与「发现 platform/locale 不符要停下来」、带默认值字段必须有描述、任何工具都不许没有描述），
外加容器栈上用真实 MCP 客户端读取确认。

### 1.31 仓库有、平台没有的语言（本轮新增自动扩充）

用户要求：「当平台没有仓库的 locale 的时候 要支持自动扩充」。先实测现状，发现两个缺口，一个比一个贵：

**缺口一：确实会自动建，但是静默的。** 导入 `zh-Hant`、`fr-FR` 时 `ensureLocale` 会建语言行——返回
`{created: 1}`，没有任何地方说明项目多了两个语言，只有事后打开项目页才发现。

**缺口二：等价标签不被认成同一个语言。** 这是真正花钱的那个。项目 `sourceLocale = zh-CN`，iOS 仓库的源目录
是 `zh-Hans.lproj`。实测：平台**新建了一个 `zh-Hans` 语言**，`locales` 变成 `en-US, zh-CN(src), zh-Hans`——
而且因为 `zh-Hans !== zh-CN`，这批内容**不被当作源文**：`upsertSourceVersion` 不执行，译文全部
`basedOnSourceVersionId = null`。项目变成「有译文、没有原文」，占位符校验、源文变更标 stale、AI 翻译全部
失去参照物，**全程不报错**。

修法是把「扩充」定义成三件事，而不是一件：

| 情况 | 行为 |
| --- | --- |
| 代码相同 | 直接用 |
| 等价标签 | 归入项目已有的那个（`zh-Hans` → `zh-CN`、`zh-Hant` → `zh-TW`、`en` → `en-US`、`ja` → `ja-JP`） |
| 项目没有 | 新建语言行，名字用中文可读名（`localeDisplayName`：`简体中文（中国）`、`法语（法国）`、`韩语`） |
| 无法判断 | **拒绝**：项目同时有 `zh-CN` 和 `zh-TW` 而来的是 `zh`，返回 409 `INVALID_LOCALE` 并列出候选 |

platform 同样处理：项目只声明 `web`，内容来了 `ios`，就自动加上 `project_platforms`。

等价判断**刻意写死在一张小表里**（只有中文的脚本↔地区真正互替，加上「光秃秃的语言对上唯一匹配」），不猜
CLDR 的 likely-subtags——认错方向的代价是把繁体归到简体下。

**顺带修掉 `canonicalizeLocaleTag` 的一个真实缺陷**：它号称「小写语言、Title 脚本、大写地区」，但遇到
`pt-br`、`zh-hans` 这种输入时既不修也不报，返回原样，而 `isValidLocaleTag` 又会拒绝——于是目录名和手写
config 里的这类标签会以一个没人看得懂的错误失败。现在按位置修大小写（紧跟语言的四字母只能是脚本，
两字母或三位数字只能是地区），因为位置使这个修复无歧义。

**可预见性是重点**，所以 `expansion` 出现在三个地方：dry run 的返回值（「什么都没写」在调用方真正想知道
「这次导入会让项目变成什么样」时毫无用处）、`sync.push` 审计行、以及 `localehub scan` 的输出。dry run 里
`platformsAdded` 一度是空的——在容器栈上跑出来才发现的，已补并加了回归测试。

验证：9 个契约单测（等价、不混淆繁简、光秃标签、歧义拒绝、可读名字、大小写修复）+ 8 个集成测试（zh-Hans
归入 zh-CN 且判为源文、真新语言被新增且命名、新端被加上、dry run 报告但真的不写、歧义被拒且候选列出、
审计留痕），外加容器栈实测：同一个 `zh-Hans.lproj` 场景，修复前 `locales` 是 `en-US, zh-CN(src), zh-Hans`，
修复后是 `en-US, zh-CN(src)`。

### 1.32 项目管理：配置可改，语言用选的（本轮）

用户的要求：「点每个项目可以修改配置 平台那些 语言配置也可以增加 源语言和目标语言是要 key 选择 不要用手写」。

改之前：项目详情页是**只读**的，语言卡片只是一张表；新建项目的表单里源语言与目标语言是两个自由输入框，
各接受一串 BCP 47 代码。那个输入框是一个带静默失败的记忆测试——`zh-Hans` 与 `zh-CN` 对人是同一个语言、
对数据库是两个，打错了要么得到一个关于语言标签的报错，要么更糟：建出一个没人想要的语言。

**语言选择器**（`components/locale-picker.tsx`）。数据来自新的 `packages/contracts/src/locale-catalog.ts`
（97 种语言，含 `native` 与 `english` 两个名字）：

- 按代码、母语名、英文名都能搜（`中文` 能搜出全部五种中文变体，`korean` 能搜出 `ko-KR`）；
- 下拉里同时显示 `localeLabel(entry)` 与英文名，右边是代码；
- **列表之外的语言仍可输入**：输入 `haw-US` 这类合法标签时出现「使用 haw-US」一行。目录是便利，不是约束；
- 目标语言是多选（`multiple` 模式），源语言单选；
- 选源语言时会自动把它从目标语言里去掉——同一个语言在表单里出现两次读起来像错误。

`localeLabel` 输出**中文**标签（产品是中文的，`한국어` 或 `· FR` 不是中文读者能扫的标签），并只在**有区分
意义时**加地区：整个目录里只有一种韩语，就显示 `韩语`；英语有六种，必须显示 `英语（美国）` 与 `英语（英国）`，
否则两行一模一样，选择变成猜测。语言自己的名字（`한국어`）退到下拉项的第二行，翻译看得懂它。搜中文名也能搜到
（输 `韩语` 出 `ko-KR`，输 `繁体` 出三种繁体中文）。

**项目设置页**（`/projects/[projectId]`）：

| 能力 | 规则 |
| --- | --- |
| 改名称 / 描述 | 直接保存 |
| 改平台（多选） | 作为**集合**整体提交（`PATCH /projects/:id { platforms }`），表单一次保存 |
| 加语言 | `POST /projects/:id/locales`，名字自动用目录里的中文名（`韩语`） |
| 删语言 | `DELETE /projects/:id/locales/:code`，源语言不可删 |
| 改源语言 | 只在项目**还没有任何译文**时允许 |

三条拒绝值得单独说，因为它们都是「现在便宜、几千条之后昂贵」的决定：

1. **加一个已有语言的另一种写法会被拒**（已有 `zh-CN` 再添加 `zh-Hans`）。否则译文会被拆到两个语言下，
   而两边的统计都看起来正常。
2. **有译文的语言不能删**。删语言会级联删掉它的全部译文——那是该让人看着数字决定的，不该是整理列表的副产品。
3. **源语言在有译文后不能改**。源文版本、stale 标记、三方比较基线全都锚在它上面，改锚点等于让这些
   全部指向一个已经不存在的语言。空项目下则允许，并且支持**交换**（把源语言改成已有的某个目标语言，
   两个 locale 的 `isSource` 互换）。

平台同样有保护：不能删到最后一个（项目没有端就无处放 Key），有 Key 的端不能删（`DELETE .../platforms/:platform`）。

**语言标签改中文**（同一轮追加）：目录原本用语言自己的名字做标签（`한국어`、`Français · FR`、`አማርኛ`），
那在语言切换器上是对的，在一个中文后台里是错的——选语言的人得先认出一种自己可能不认识的文字，而 `· FR` 是地区码
不是词。现在 `localeLabel` 输出中文（`韩语`、`英语（美国）`、`简体中文（中国）`），母语名退到下拉项第二行
（翻译看得懂它），搜索同时匹配中文名、母语名、英文名与代码——输 `韩语` 出 `ko-KR`，输 `繁体` 出三种繁体中文。
新增的 `LANGUAGE_ZH` / `REGION_ZH` / `SCRIPT_ZH` 三张表也被 `localeDisplayName` 的兜底路径复用，
所以目录内外的措辞不会分叉。`zh-CN` 没有 script 子标签但就是简体，靠 `ZH_IMPLIED_SCRIPT` 补上，
否则 `zh-CN` 与 `zh-TW` 会都显示成「中文」。

**一个只在镜像里暴露的坑**：Web 改成 import `@localehub/contracts` 后，Docker 构建失败两次——
先是 `web.Dockerfile` 只拷贝了 contracts 的**源码**、没跑它的 build（该包的入口是 `dist`）；补上构建后
又撞 `node:crypto`（contracts 根的 `hash.ts` 用了它，webpack 无法为浏览器解析）。解法不是 polyfill，
而是给 contracts 加浏览器安全的子路径导出（`@localehub/contracts/locale` 与 `/locale-catalog`），
Web 只引用这两个——把「浏览器能用哪部分」写成显式契约，而不是指望 tree-shaking 分析 Node 内置模块。

验证：215 单元（+1 语言标签唯一性）+ 129 集成（+8 项目设置：改名、加语言并命名、拒绝重复语言、删语言与
源语言保护、空项目换源语言、有译文后拒绝换源语言、平台集合保存与「至少一个」、有 Key 的端不能删），
以及浏览器实测三处交互。

## 2. 未实现 / 部分实现

| 项                                                  | 状态       | 说明                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI 3.1 文档                                    | **已完成** | 由装饰器元数据生成（81 个操作 / 68 条路径），`GET /api/v1/openapi.json` + `docs/openapi.json`，见 §1.17                                                                                                                                                                                                                                                                                 |
| OpenAPI 驱动的 TS Client 生成                       | 部分       | 客户端仍手写（方法体是真 HTTP 调用），但新增测试断言「客户端调用的每个端点都在文档里」，路径漂移会被 CI 拦住                                                                                                                                                                                                                                                                            |     |
| Remote MCP 的 OAuth 2.1                             | 部分       | 仅 Bearer Token；无 OAuth 授权码流程                                                                                                                                                                                                                                                                                                                                                    |
| Remote MCP 的 Resources 模板                        | 部分       | 已注册 `qa-rules`、`localehub://skills` 与 `localehub://skills/{slug}`。项目级资源模板（`localehub://projects/{projectId}` 及其子资源）**未实现**，已从 `/mcp/tools` 的声明中移除——声明一条没有 Server 实现的 resource 会让客户端去读一个必然失败的地址（见 §1.13）                                                                                                                     |
| Skills 脚本隔离执行器                               | **未实现** | `kind=SCRIPT` 仅登记，任何进程都不执行（见 SKILLS.md）                                                                                                                                                                                                                                                                                                                                  |
| 对象存储 / 预签名 URL                               | 部分       | 发布包走目录存储并按组织/发布 id 寻址，下载是独立请求；导入导出仍走 JSON 响应体，未接 S3/MinIO。换 S3 只需替换 `packages/domain/src/bundles.ts` 的存储层                                                                                                                                                                                                                                |
| CSV / XLSX 适配器                                   | **已完成** | 22 个单元测试 + 6 个集成测试（经真实导出端点往返），见 §1.19                                                                                                                                                                                                                                                                                                                            |
| Git/GitHub App、PR 检查                             | **未实现** | 规格 §14 第二阶段                                                                                                                                                                                                                                                                                                                                                                       |
| 发布快照导出为实际文件包                            | **已完成** | 确定性 zip（含 manifest 与逐文件摘要），见 §1.23                                                                                                                                                                                                                                                                                                                                        |
| Webhook 事件推送                                    | **已完成** | HMAC 签名投递 + 重试 + 投递日志，见 §1.20；游标拉取仍然保留                                                                                                                                                                                                                                                                                                                             |
| 多组织切换 UI                                       | **已完成** | 顶栏用户菜单里切换（仅在属于多个组织时出现），切换后整页重载；登录时可指定组织并记住上次                                                                                                                                                                                                                                                                                                |
| 用户管理（建号 / 角色 / 项目角色）                  | **已完成** | 无邀请、无自助注册：管理员在 `/settings/members` 直接建号（邮箱+姓名+初始密码+角色）、改组织角色、分配项目角色与语言范围、重置密码、移出组织。API 与守卫见 §1.14                                                                                                                                                                                                                        |
| 会话列表 / 远程登出                                 | **未实现** | 没有 `UserSession` 表，改密码不会注销其他设备，也无法查看「我在哪些设备登录过」。要立即切断访问只能靠暂停账号（见 §1.18）                                                                                                                                                                                                                                                               |
| 前端单元测试                                        | **未实现** | 仓库里没有 Playwright / RTL 用例，也没有进 CI 的浏览器测试。人工验证用无头 Chrome（CDP）脚本，判定标准是「页面出现真实数据且无错误提示」，不是 HTTP 200——后者在 API 全挂时依然成立，本文件 §1.10 就是这么被骗过一次的                                                                                                                                                                   |
| Docker 镜像与整套 compose 栈                        | **已完成** | `docker compose up -d --build` 起全套（postgres / redis / api / worker / mcp-remote / web）。无头 Chrome 实测 24/24：登录后首页、9 条路由与两张项目详情页都渲染出真实数据（不是只 HTTP 200），`/mcp`「客户端配置」三个片段可渲染可复制，桌面与 390px 均无横向溢出；Remote MCP 用 SDK 客户端握手 15 个工具，本地文件类工具未暴露。**过程中发现并修掉两个只在容器里出现的缺陷，见 §1.10** |
| i18n Adapter：JSON 数组/ICU AST                     | 部分       | ICU 复数以字符串形式保存，非 AST 级编辑                                                                                                                                                                                                                                                                                                                                                 |
| `file_hash` 级别的映射变更检测                      | **已完成** | 映射变化现在产生 `FILE_MAPPING_CHANGED` 冲突，见 §1.21                                                                                                                                                                                                                                                                                                                                  |
| `organizations` / `users` / `review_actions` 的 RLS | **已完成** | 三张表都已启用行级策略；无组织上下文时返回 0 行，跨租户不可见。见 §1.24                                                                                                                                                                                                                                                                                                                 |

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
8. ~~**Web 端 Token 存在 localStorage**~~ **已修复**：浏览器改用 HttpOnly 会话 Cookie +
   双提交 CSRF Token，`localStorage` 不再保存凭据；CLI/MCP 仍用 Bearer，两条路径解析到同一个 actor。
9. **AI Provider 默认离线启发式**：不会真正翻译，只做术语替换；配置 `ANTHROPIC_API_KEY`
   才会调用真实模型。AI 输出始终为草稿。
10. **单仓多语言文件同名 Key 冲突**：扫描阶段检测并报 `DUPLICATE_KEY`，但只在同一
    platform+namespace+locale 内判定；跨 namespace 同名 Key 视为不同 Key（符合唯一键设计）。

## 4. 实际执行的验证命令与结果

```bash
pnpm -r build                     # 全部 packages + apps 编译通过
pnpm --filter @localehub/web exec next build   # 15 条路由构建成功
pnpm -r typecheck                              # 16 个 workspace 项目全部通过
pnpm test                                      # 181 unit tests passed（OpenAPI 一致性 7、CSV/XLSX 22、Webhook 14、发布包 9）
pnpm test:integration                          # 104 integration tests passed（含 6 个 RLS 直连验证、6 个仓库初始化）
node apps/e2e-demo/dist/run-demo.js            # ALL ACCEPTANCE CHECKS PASSED（A–E）
docker compose config                          # valid
docker compose -f compose.yaml -f compose.production.yaml config   # valid
docker compose up -d --build                   # 整套栈起来，5 个服务健康
docker compose exec -T web node -e "…routes-manifest…"   # 转发目标 = http://api:3001/api/v1
curl -b cookie http://localhost:3000/api/v1/projects    # 200，走 web 容器转发
docker run --network host … localehub-api:test # health=ok, login ok, /mcp/tools 返回 15 个工具（无 local 段）
docker build -f docker/web.Dockerfile .        # 成功（localehub-web:test）
pnpm exec eslint . --max-warnings 0            # 0 error / 0 warning
node apps/e2e-demo/dist/run-demo.js            # 连续两次运行均 ALL ACCEPTANCE CHECKS PASSED
psql -U localehub_app …                        # 验证 RLS：无 org 上下文 0 行；跨租户写入被拒绝
curl /api/v1/health                            # {"status":"ok","checks":{"database":true}}
curl -o /dev/null -w %{http_code} /login 等     # 8 个页面均 200
curl /api/v1/mcp/tools | jq '.data \| keys'    # ["prompts","remote","remoteUrl","resources","skillDelivery","snippets"]，无 local
curl /api/v1/openapi.json | jq '.paths \| length'  # 68 条路径 / 81 个操作；不带信封（@RawResponse）
pnpm --filter @localehub/api openapi             # 重新生成 docs/openapi.json（提交进仓库，测试逐字节比对）
node apps/cli/dist/bin.js mcp-config           # 向平台问自己的地址，输出单条 localehub-remote 配置
cd .demo-workspace && node …/bin.js info|scan|sync preview   # 本地链路走通（scan 2 文件 / 6 条目）
POST /organization/members (READONLY)          # 无 token 管理成员的越权尝试 → 403（§1.15 修复前后各跑一次）
无头 Chrome 驱动 /settings/members             # 建号对话框真实提交 → 表格出现新成员 → 该账号用所填密码登录成功
```

## 5. 建议的后续优先级

1. **为 `users` / `organizations` / `review_actions` 补 RLS 或收敛访问**。前两张表是全局面级数据、
   没有 `organization_id`；第三条通过 `review_tasks` 关联租户。可选做法：`users` 只允许
   `id IN (SELECT user_id FROM memberships WHERE organization_id = current_organization_id())`，
   或在应用层把读取入口收敛到单一特权函数并加审计。需要先确定「一个用户属于多个组织」时的可见性语义。
2. 由 OpenAPI 文档生成 `api-client` 的方法与类型（当前仅路径漂移有测试守住）。
3. Skills 隔离执行器（独立容器、无网络、非 root）。
4. CSV/XLSX 适配器与对象存储导入导出。
5. GitHub/GitLab App + PR 检查（`localehub scan / sync preview --direction=push / qa --changed-only`）。
6. 前端 E2E（Playwright）覆盖翻译编辑器与冲突处理的关键交互。

---

## 附：最终验证记录（本文件写入后重跑）

| 命令                                             | 结果                                    |
| ------------------------------------------------ | --------------------------------------- |
| `pnpm -r typecheck`                              | 全部 17 个 workspace 项目通过           |
| `pnpm lint`（`eslint . --max-warnings 0`）       | 0 error / 0 warning                     |
| GitHub Actions `CI`（main）                      | **通过**（Run 5）                       |
| Local / Remote MCP 真实客户端握手                | 通过（见附二）                          |
| 端到端演示连续两次运行                           | 均通过（demo 自带项目清理，可重复执行） |
| `pnpm test`                                      | 217 passed                              |
| `pnpm test:integration`                          | 129 passed                              |
| `node apps/e2e-demo/dist/run-demo.js`            | ALL ACCEPTANCE CHECKS PASSED            |
| `docker compose config`（含 production overlay） | valid                                   |
| `docker compose up -d --build`（整套栈）         | 5 个服务全部起，浏览器实测 24/24        |
| `docker buildx build --network host`             | api / web 镜像均构建成功（见下方说明）  |
| 容器栈上的 MCP 写入 → 审计页（无头 Chrome）      | 通过：`/settings/audit` 的「Agent 操作」筛出 100 行，每行标出 Token 名与前缀 |
| `/mcp` 教程页第五步（无头 Chrome）               | 通过：5 个步骤、闭环说明与 `translation_version_id` 提示均渲染，无溢出     |
| `docker build -f docker/api.Dockerfile .`        | 见下方说明                              |

Docker 镜像构建第一次因 Dockerfile 在 `prisma generate` 之前编译 `packages/database` 而失败
（`@prisma/client` 尚无导出），已修正构建顺序（先生成 Prisma Client，再编译）。修正后的构建结果
见仓库根目录最后一次 `docker build` 输出；若网络受限导致依赖下载失败，请在网络可用环境重试：

```bash
docker build -f docker/api.Dockerfile -t localehub-api:local .
docker build -f docker/web.Dockerfile -t localehub-web:local .
```

两个镜像均已成功构建并运行验证。首次 Web 重构建曾在下载 `@next/swc-linux-arm64-*` 时遇到
`ECONNRESET`，重试后完成；这是网络抖动，不是代码问题。

**本轮又踩了同一个坑，顺手把它修掉**：BuildKit 报 `apk add` 的包「masked in: --no-network」，
旧版构建器能连网但 `pnpm install` 反复在 640–660/664 处被 registry 掐断。两处改动：

1. `docker/api.Dockerfile` 的 `deps` 阶段原本 `COPY packages ./packages`（**整个源码树**），
   于是改一个 `.ts` 文件就会让依赖层失效、重下整棵依赖树。现在只 COPY 各包的 `package.json`
   ——这一层从此与源码无关，重构建只跑编译。
2. 两个 Dockerfile 的 `pnpm install` 都加上 `--fetch-retries=10 --fetch-timeout=600000`。
   默认重试 2 次，对「只是慢」的 registry 等于放弃。

网络本身仍不通 BuildKit 的默认网络（容器里 `curl` 25 秒只下到 5 MB），所以构建命令是：

```bash
docker buildx build --network host -f docker/api.Dockerfile -t localehub-api .
docker buildx build --network host -f docker/web.Dockerfile -t localehub-web .
```

## 附二：MCP 传输层实测

平台只有一个 MCP，下表的「工具」一列是它的 18 个平台工具；本地动作在 CLI 里，另表列出。

| 验证                                                | 结果                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Remote MCP（Streamable HTTP）被真实 MCP Client 连接 | `connected: localehub-remote 0.1.0`                                                             |
| Remote MCP 工具数                                   | 18（规格 §6.4 的 15 个 + `create_project` / `import_translations` / `mark_applied`，见 §1.27、§1.29） |
| MCP 是否校验 Token scope                            | 是：`REMOTE_MCP_TOOL_SCOPES` 在包装层统一断言，映射逐条对齐 REST（集成测试断言，见 §1.29）      |
| MCP 是否教怎么用                                    | 是：`instructions` + `localehub://import-guide` + `import-localization-files` 提示词 + 字段级描述（见 §1.30） |
| 仓库有、平台没有的语言                              | 自动新增并报告；等价标签归入已有语言（`zh-Hans` → `zh-CN`）；歧义则拒绝（见 §1.31） |
| MCP 写入是否进审计                                  | 是：7 个写工具写 `audit_logs`，`actor_type='mcp'`，只读与 dry-run 不写（集成测试断言，见 §1.28） |
| `mark_applied` 闭环（容器栈实测）                   | 通过：pending → dry-run（不建 session）→ 确认（建 session）→ 平台不再下发 → 审计有 `sync.apply` |
| 只带 `project.read` 的 Token 调 `import_translations` | 被拒（`SCOPE_INSUFFICIENT`）——修复前实测可写库，见 §1.29                                    |
| 只带 `sync.push` 的 Token 调 `mark_applied`         | 被拒（`SCOPE_INSUFFICIENT: translation.apply`）                                              |
| Remote MCP 是否暴露本地文件工具                     | 否（检查 `read_local_file` / `write_local_file` / `read_file` / `exec` 均不存在）               |
| `list_projects` / `get_project_sync_status`         | 正常返回                                                                                        |
| Remote MCP Resources / Prompts                      | 8 / 8（`qa-rules` + `import-guide` + `skills` + `skills/{slug}` + 3 个 Skill resource；3 内置 + 5 Skill prompt） |
| `localehub://skills/{slug}`                         | 返回完整 `SKILL.md`（含 frontmatter），`text/markdown`                                          |
| 未发布 slug 的 resource 读取                        | 被拒绝（`NOT_FOUND`），不是返回空文档                                                           |
| `/mcp/tools` 声明的 resource 与 prompt              | 与上面实测逐条一致（集成测试断言，非人工比对）                                                  |

本地动作（CLI，不经过 MCP）：

| 验证                                        | 结果                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| `localehub info`                            | 返回配置、workspace root、项目、apiUrl、Git 状态        |
| `localehub scan`                            | `scanned 2 file(s), 6 entr(ies), locales: en-US, ja-JP` |
| `localehub sync preview` / `push --confirm` | 走通（见验收脚本 A–E）                                  |
| `localehub mcp-config`                      | 输出单条 `localehub-remote`，URL 由平台报告             |
| `apply --confirm`                           | 备份 + 原子写 + 重解析校验（24 个 workspace 测试）      |

修复记录：Remote MCP 最初把数组作为 `structuredContent` 返回，被 MCP 客户端以
`-32602 Invalid tools/call result` 拒绝；已在两个 MCP 服务端统一做「数组包装为 `{items}`」规范化。
`apps/mcp-remote` 缺少 `reflect-metadata` 运行时依赖也已补上。

## 附三：本次交付中发现并修复的问题

| 问题                                                                     | 影响                                               | 修复                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| 归档动作映射颠倒（`ARCHIVE_CANDIDATE` / `REMOTE_ARCHIVE_CANDIDATE`）     | 本地删除会被误判为远端删除                         | 交换两处返回值并补分支测试                                                     |
| YAML 补丁丢失注释                                                        | 回写会破坏 YAML 文件注释                           | 改用 `yaml` 的 Document API                                                    |
| JSON 新增嵌套 Key 时空节点不存在                                         | 新增 Key 报错                                      | 递归创建中间对象                                                               |
| JSON 插入点落在收尾换行之后                                              | 生成非法 JSON（逗号独占一行）                      | 插入点回退到末尾空白之前                                                       |
| 认证查询未走特权路径                                                     | RLS 导致登录/Token 校验查不到 membership           | 统一走 `withoutTenantScope`                                                    |
| `getChanges` 用 `array_contains` 过滤 JSON 字符串                        | 平台变更永远拉不到                                 | 移除 SQL 过滤，改为应用层按 locale 过滤                                        |
| 新版本未清空 `applied_to_repo_at`                                        | 已应用的条目标记污染新版本，pull 过滤掉真实变更    | 仅仓库推送才标记为已应用                                                       |
| 冲突解决写回使用扁平字段缺失                                             | 解决冲突后平台值不更新                             | 补齐 `baseValue/localValue/remoteValue`                                        |
| 冲突解决的 Key 查询忽略 namespace                                        | 带 namespace 的项目无法写回                        | 通过 namespace 行再查 Key                                                      |
| Remote MCP 返回数组作为 `structuredContent`                              | MCP 客户端报 `-32602`                              | 两个 MCP 服务端统一包装为 `{items}`                                            |
| `apps/mcp-remote` 缺少 `reflect-metadata`                                | 远程 MCP 无法启动                                  | 补依赖                                                                         |
| AuthGuard 把 `params.id` 当 projectId                                    | 项目级成员（组织角色为 READONLY）被误拒            | 仅在路由确有 projectId 时做项目级角色判断，其余由服务层显式断言                |
| 缺少 `DELETE /projects/:id`                                              | 无法清理项目，演示不可重复                         | 新增删除端点（需 `confirmName` 二次确认）                                      |
| Dockerfile 在 `prisma generate` 前编译 database 包                       | 镜像构建失败                                       | 调整构建顺序                                                                   |
| Docker runtime 阶段只拷贝部分目录                                        | 容器内 `MODULE_NOT_FOUND`                          | 拷贝完整构建产物                                                               |
| Web 容器用 corepack 启动 pnpm                                            | 启动时联网下载 pnpm 导致启动失败                   | 直接执行 next                                                                  |
| Web 容器 `next start` 工作目录为 `/app`                                  | 找不到 `.next`，容器无法启动                       | 运行时 `WORKDIR /app/apps/web`                                                 |
| `POST /projects` 的角色校验从未生效（任何成员可建项目）                  | 只读成员也能创建项目                               | service 内补 `assertRole(actor,'',PROJECT_MANAGER)` + 集成回归测试（见 §1.15） |
| `POST /projects/:id/members` 可绕过全部成员守卫                          | 项目级 PM 能把外部用户拉进组织并给更高组织角色     | 删除该路由（无调用方），回归测试断言 404（见 §1.16）                           |
| `LOCALEHUB_API_URL` 覆盖被静默丢弃                                       | 所有调用方都在和 config 文件里的地址通信           | 移到 `LocalSyncServices.config()`（见 §1.12）                                  |
| 去掉 Local MCP（用户决定）                                               | 两个 MCP 意味着版本/能力无法统一管理，发现接口失真 | 删除 `apps/mcp-local`；引擎移到 `packages/local-sync`，由 CLI 驱动             |
| `/mcp/tools` 声明了 6 条未实现的 resource 与 1 个已删除 Server 的 prompt | 发现接口高估能力                                   | 资源/prompt 清单进契约，集成测试断言「声明 == 实际注册」                       |
| 浏览器端硬编码 API 主机                                                  | 反向代理部署下前端打不到 API                       | 未配置 `NEXT_PUBLIC_API_BASE_URL` 时回退到同源 `/api/v1`                       |
| MCP 的写入不写审计（`audit_logs` 对 Agent 全盲）                         | 审计页看不到任何 MCP 操作，无法追溯、无法撤销对应 Token | 抽 `packages/domain/src/audit.ts`，六个写工具补审计 + 8 单元 / 2 集成测试（见 §1.28） |
| MCP 完全不校验 Token scope（只有 `project.read` 也能写库）               | 规格 §2.2 的 scope 分离在唯一依赖它的入口上失效，默认 Token 能把平台变更标记为已落地 | 契约里声明 `REMOTE_MCP_TOOL_SCOPES`，`define` 包装层统一断言 + 5 单元 / 1 集成测试（见 §1.29） |
