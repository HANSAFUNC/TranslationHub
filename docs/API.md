# REST API 参考

统一前缀 `/api/v1`。所有响应使用统一信封：

```json
{ "success": true, "data": { } }
{ "success": false, "error": { "code": "SYNC_PLAN_EXPIRED", "message": "…", "details": {}, "requestId": "…" } }
```

认证：`Authorization: Bearer <session-jwt | lh_mcp_… | lh_api_…>`。
浏览器会话同时下发 `localehub_session` HttpOnly Cookie。每个请求都会带 `x-request-id`
（可由客户端提供）。

## 1. 健康与系统

| Method | Path             | 说明                                              |
| ------ | ---------------- | ------------------------------------------------- |
| GET    | `/health`        | 健康检查（含数据库探测）                          |
| GET    | `/health/ready`  | 就绪检查                                          |
| GET    | `/system/queues` | BullMQ 队列深度                                   |
| GET    | `/mcp/tools`     | Local / Remote MCP 工具清单与 JSON Schema（公开） |

## 2. 认证与组织

| Method | Path                        | 权限                   | 说明                                         |
| ------ | --------------------------- | ---------------------- | -------------------------------------------- |
| POST   | `/auth/register`            | 公开（仅实例无用户时） | 创建首个管理员与组织                         |
| POST   | `/auth/login`               | 公开                   | 返回 token 与组织列表                        |
| GET    | `/auth/me`                  | 登录                   | 当前用户、角色、组织                         |
| POST   | `/auth/switch-organization` | 登录                   | 切换组织并重签 token                         |
| POST   | `/auth/logout`              | 登录                   | 清除会话 Cookie 与 CSRF Cookie               |
| GET    | `/organization`             | 成员                   | 当前组织及其安全策略                         |
| PATCH  | `/organization/settings`    | ORG_OWNER / ORG_ADMIN  | 修改组织安全策略（当前为 `allowDraftApply`） |
| GET    | `/organization/overview`    | 成员                   | 组织级统计                                   |

### 2.1 两种凭据

| 凭据         | 使用者                    | 传递方式                                                               | 附加要求                                                                      |
| ------------ | ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 会话 Cookie  | 浏览器（Web 后台）        | `localehub_session`，HttpOnly + SameSite=Lax，`credentials: 'include'` | 写请求必须带 `X-CSRF-Token`，其值等于可读的 `localehub_csrf` Cookie（双提交） |
| Bearer Token | CLI、Remote MCP、集成脚本 | `Authorization: Bearer <lh_mcp_… \| lh_api_… \| 会话 JWT>`             | 无（凭据由调用方主动附加）                                                    |

浏览器不再把任何凭据放进 `localStorage`。Cookie 凭据是浏览器自动附带的，因此写请求（POST / PUT /
PATCH / DELETE）额外做两层校验：`Origin`/`Referer` 必须属于本部署（`CORS_ORIGINS`，未配置时默认
`http://localhost:3000`；另加 API 自身 origin），且双提交 Token 必须匹配。允许列表与 CORS 中间件
取自同一处配置，避免两者判断不一致。Bearer 请求只受 Origin 校验约束，没有 Origin 的调用方（curl、
MCP 客户端）不受影响。

生产环境（`NODE_ENV=production`）下纯 HTTP 携带凭据会被拒绝（`INSECURE_TRANSPORT`）；健康检查等
public 路由不受影响，负载均衡仍可探测。

## 3. 项目

| Method   | Path                                                    | 最低角色                   |
| -------- | ------------------------------------------------------- | -------------------------- |
| GET      | `/projects`                                             | READONLY                   |
| POST     | `/projects`                                             | ORG 成员                   |
| GET      | `/projects/:projectId`                                  | READONLY                   |
| PATCH    | `/projects/:projectId`                                  | PROJECT_MANAGER            |
| GET      | `/projects/:projectId/dashboard`                        | READONLY                   |
| GET/POST | `/projects/:projectId/locales`                          | READONLY / PROJECT_MANAGER |
| GET/POST | `/projects/:projectId/members`                          | READONLY / PROJECT_MANAGER |
| GET/POST | `/projects/:projectId/platforms`                        | READONLY / PROJECT_MANAGER |
| GET      | `/projects/:projectId/keys`                             | READONLY                   |
| GET      | `/projects/:projectId/export?locale=&format=&platform=` | READONLY                   |
| GET      | `/projects/:projectId/audit`                            | PROJECT_MANAGER            |

## 4. 翻译

| Method | Path                                                                                            | 最低角色   | 说明                                               |
| ------ | ----------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------- |
| GET    | `/projects/:projectId/translations?locale=&status=&platform=&namespace=&search=&cursor=&limit=` | READONLY   | cursor 分页                                        |
| GET    | `/projects/:projectId/translations/:entryId`                                                    | READONLY   | 含源文版本、译文版本、QA 问题                      |
| GET    | `/projects/:projectId/translations/:entryId/versions`                                           | READONLY   | 版本历史                                           |
| GET    | `/projects/:projectId/translations/stale`                                                       | READONLY   | 过期译文                                           |
| GET    | `/projects/:projectId/translations/by-key?key=&locale=`                                         | READONLY   | 按 Key+Locale 精确查询                             |
| POST   | `/projects/:projectId/translations/:entryId/draft`                                              | TRANSLATOR | 保存草稿（新版本，支持 `expectedRevision` 乐观锁） |
| POST   | `/projects/:projectId/translations/submit`                                                      | TRANSLATOR | 提交审核                                           |
| POST   | `/projects/:projectId/translations/review`                                                      | REVIEWER   | `APPROVE` / `REJECT` / `REQUEST_CHANGES`           |
| GET    | `/projects/:projectId/reviews/queue`                                                            | READONLY   | 审核队列                                           |

保存草稿会校验占位符一致性，不一致返回 `PLACEHOLDER_MISMATCH`。
批准 `STALE` 译文返回 `STALE_TRANSLATION`。

## 5. 同步（核心）

| Method   | Path                                                                         | Scope               | 说明                                         |
| -------- | ---------------------------------------------------------------------------- | ------------------- | -------------------------------------------- |
| POST     | `/sync/scans`                                                                | `repository.scan`   | 上传扫描批次（文件 + 规范化条目）            |
| POST     | `/sync/preview`                                                              | `sync.preview`      | 创建三方同步预览计划                         |
| POST     | `/sync/push`                                                                 | `sync.push`         | 提交本地变更（`confirmed: true`）            |
| POST     | `/sync/apply-reports`                                                        | `translation.apply` | 上报本地回写结果                             |
| GET      | `/sync/sessions/:id` / `:id/items`                                           | —                   | 同步会话详情                                 |
| GET      | `/sync/recent-sessions`                                                      | —                   | 组织级最近会话                               |
| GET      | `/sync/conflicts?projectId=&status=&locale=`                                 | —                   | 冲突列表                                     |
| GET      | `/sync/conflicts/:id`                                                        | —                   | 冲突详情                                     |
| POST     | `/sync/conflicts/:id/resolve`                                                | —                   | 解决冲突                                     |
| GET      | `/projects/:projectId/sync/status`                                           | —                   | 仓库连接、心跳、映射、基线数、待拉取、冲突数 |
| GET      | `/projects/:projectId/sync/sessions`                                         | —                   | 项目同步历史                                 |
| GET      | `/projects/:projectId/sync/baseline?connection_id=&since_revision=&locales=` | —                   | 基线                                         |
| GET      | `/projects/:projectId/sync/changes?locale=&status=&since_revision=&limit=`   | —                   | 平台变更（增量）                             |
| POST     | `/projects/:projectId/sync/validate`                                         | —                   | 发布/同步前校验                              |
| GET      | `/projects/:projectId/events?since_revision=`                                | —                   | 项目事件日志                                 |
| GET/POST | `/projects/:projectId/repository-connections`                                | PROJECT_MANAGER     | 仓库连接                                     |

### 5.1 创建预览

```http
POST /api/v1/sync/preview
Authorization: Bearer lh_mcp_...
Idempotency-Key: preview-repo-a1b2c3
Content-Type: application/json

{
  "projectId": "project_uuid",
  "repositoryConnectionId": "conn_uuid",
  "scanId": "scan_uuid",
  "direction": "bidirectional",
  "includeDeletes": false,
  "includeDrafts": false
}
```

响应：`syncPlanId`、`planHash`、`expiresAt`、`sessionId`、`summary`、`plan.items[]`、`conflicts`。

### 5.2 推送

```http
POST /api/v1/sync/push
Idempotency-Key: repo-commit-a1b2-plan-xyz

{ "syncPlanId": "plan_uuid", "planHash": "sha256:…", "confirmed": true,
  "client": { "name": "localehub-cli", "version": "0.1.0", "gitBranch": "feature/l10n", "gitCommit": "a1b2c3d4" } }
```

服务端会重新校验计划哈希、过期时间、`baseRevision == 当前 project.revision`，
并**重新应用变更**（不信任客户端明细）。同一计划重复提交返回幂等重放结果。

## 6. 质量与 AI

| Method | Path                                | 说明                          |
| ------ | ----------------------------------- | ----------------------------- |
| GET    | `/projects/:projectId/qa/rules`     | 内置规则清单                  |
| POST   | `/projects/:projectId/qa/run`       | 同步运行规则引擎              |
| POST   | `/projects/:projectId/qa/run-async` | 投递 BullMQ 异步运行          |
| GET    | `/projects/:projectId/qa/issues`    | 问题列表                      |
| GET    | `/projects/:projectId/qa/report`    | 按规则/语言聚合报告           |
| POST   | `/projects/:projectId/ai/translate` | AI 生成草稿（写入 DRAFT）     |
| POST   | `/projects/:projectId/ai/review`    | AI 审核建议（只读，advisory） |
| GET    | `/projects/:projectId/ai/providers` | Provider 列表                 |

## 7. 术语、记忆、Token、Skill、发布

| Method   | Path                                             | 说明                                |
| -------- | ------------------------------------------------ | ----------------------------------- |
| GET/POST | `/projects/:projectId/glossary`                  | 术语库                              |
| GET      | `/projects/:projectId/translation-memory?query=` | 翻译记忆检索                        |
| GET/POST | `/mcp-tokens`                                    | 列出 / 签发 Token（明文仅返回一次） |
| DELETE   | `/mcp-tokens/:id`                                | 撤销                                |
| GET      | `/mcp/token-info`                                | Token 自检（CLI 启动校验）          |
| GET      | `/mcp/scopes`                                    | Scope 清单                          |
| GET/POST | `/skills`                                        | Skill 注册表                        |
| GET/POST | `/projects/:projectId/releases`                  | 发布与快照                          |

## 8. 错误码

| Code                                                                                                                                       | HTTP    | 含义                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------- | -------------------------- |
| `UNAUTHENTICATED` / `INVALID_TOKEN` / `TOKEN_EXPIRED`                                                                                      | 401     | 凭据问题                   |
| `SCOPE_INSUFFICIENT`                                                                                                                       | 403     | MCP Token 缺少 scope       |
| `ROLE_INSUFFICIENT`                                                                                                                        | 403     | 角色不足                   |
| `PROJECT_ACCESS_DENIED` / `ORGANIZATION_ACCESS_DENIED`                                                                                     | 403     | 越权访问                   |
| `PATH_OUTSIDE_WORKSPACE` / `PATH_TRAVERSAL_REJECTED` / `SYMLINK_ESCAPE_REJECTED` / `PATH_DENIED` / `PATH_NOT_WRITABLE` / `PATH_NOT_MAPPED` | 403     | 本地路径安全               |
| `VALIDATION_ERROR`                                                                                                                         | 422     | 入参校验失败               |
| `PLACEHOLDER_MISMATCH` / `UNSUPPORTED_FORMAT` / `PARSE_ERROR`                                                                              | 422     | 内容与格式                 |
| `SYNC_PLAN_NOT_FOUND` / `SYNC_PLAN_EXPIRED` / `SYNC_PLAN_HASH_MISMATCH`                                                                    | 404/409 | 计划失效，需重新预览       |
| `REVISION_MISMATCH`                                                                                                                        | 409     | 平台已被他人修改           |
| `SYNC_CONFLICT` / `CONFLICT_ALREADY_RESOLVED`                                                                                              | 409     | 冲突                       |
| `APPLY_REJECTED_STALE_PREVIEW` / `LOCAL_FILE_CHANGED_AFTER_PREVIEW`                                                                        | 409     | 预览后本地已变化           |
| `STALE_TRANSLATION`                                                                                                                        | 409     | 译文过期，不能批准/回写    |
| `IDEMPOTENCY_KEY_REUSED`                                                                                                                   | 409     | 幂等键复用                 |
| `NOT_FOUND`                                                                                                                                | 404     | 资源不存在                 |
| `INTERNAL_ERROR`                                                                                                                           | 500     | 未预期错误（细节仅进日志） |

## 9. 约定

- 分页使用 cursor；批量接口限制单次数量上限。
- 写接口支持 `Idempotency-Key`。
- **限流**：所有端点都限流。已认证请求按 actor 计数（MCP Token 与同一用户的浏览器会话各自独立），
  凭据提交端点按（IP, 账号）计数并叠加一个更宽松的 IP 总量桶。每个响应带
  `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`，超限返回 429 +
  `Retry-After` + 错误码 `RATE_LIMITED`。计数存于 Redis（多副本共享），Redis 不可用时退化为单进程计数
  并打日志。
- 内容更新支持 `expectedRevision` / `expectedContentHash` 乐观锁。
- 大文件使用预签名 URL（当前版本的导入导出走 JSON 响应，尚未接入对象存储）。
- OpenAPI：见 §10。

## 10. OpenAPI

`GET /api/v1/mcp/tools` 提供 MCP 工具 JSON Schema。REST 的 OpenAPI 3.1 文档**尚未生成**
（未实现项，见 docs/STATUS.md）；当前以本文档 + `apps/api/src/modules/**/*.controller.ts`
的 zod schema 为准。
