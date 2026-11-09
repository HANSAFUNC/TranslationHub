# MCP：Local 与 Remote 的边界与工具

## 1. 为什么必须分离

| | Local MCP | Remote MCP |
|---|---|---|
| 运行位置 | 开发者机器 / CI Runner | LocaleHub 服务端容器 |
| 传输 | stdio | Streamable HTTP |
| 能力 | 读取受限仓库目录、生成 patch、原子写回、Git diff | 平台数据与业务（项目、Key、译文、术语、TM、QA、审核、同步状态） |
| 权限来源 | 本地配置 + `LOCALEHUB_TOKEN` 的 scope | Token 的 scope + 用户角色 |
| 本地文件 | 受 `workspace` 白名单约束 | **完全没有**（不存在 `read_local_file` / `write_local_file`） |

平台**无法**主动访问开发者机器：所有"本地动作"都由 Local MCP 在本地发起，平台只记录结果
（心跳、commit、apply report）。仓库 URL / 分支 / commit **不作为权限依据**。

## 2. Local MCP

### 启动

```bash
node apps/mcp-local/dist/bin.js --stdio [--workspace <path>]
```

环境变量：`LOCALEHUB_WORKSPACE`、`LOCALEHUB_API_URL`（覆盖 config）、`LOCALEHUB_TOKEN`
（变量名可由 `.localehub/config.yaml` 的 `localehub.tokenEnv` 指定）。

### 工具

| 工具 | 默认行为 | 说明 |
|---|---|---|
| `get_local_project_info` | 只读 | 配置、workspace root、Git 分支/commit、映射、策略、上次同步 |
| `scan_local_project` | 只读（上传规范化条目） | 扫描配置声明的语言文件；返回文件数/Key 数/Locale/警告 |
| `read_project_context` | 只读 | 在 `allowRead` 内读取源码上下文，**不默认上传** |
| `get_remote_project` | 只读 | 平台项目、语言与同步配置 |
| `preview_sync` | 只读 | 三方比较，生成变更计划 |
| `push_project_changes` | **必须 `confirm=true`** | 只能提交此前生成且未过期的计划 |
| `pull_platform_updates` | 只读 | 默认只返回 `APPROVED` |
| `preview_apply` | dry-run | 逐文件逐 Key 的旧值/新值/风险 |
| `apply_translation_updates` | **必须二次确认** | 备份 + 原子写入 + 重解析校验 |
| `validate_localization_files` | 只读 | 格式、占位符、重复 Key、缺译 |
| `get_sync_status` | 只读 | 本地状态 + 远端状态 + 未解决冲突 |
| `resolve_sync_conflict` | 显式选择 | `KEEP_LOCAL` / `KEEP_REMOTE` / `MANUAL_MERGE` / `DEFER` |
| `report_apply_result` | 写审计 | 回报实际写回文件与 commit |
| `create_git_patch` | 只读 | 生成 patch/diff，**不 commit** |

Resources：`localehub://local/project-info`、`localehub://local/sync-status`。
Prompts：`sync-localization-project`、`review-localization-changes`、`fix-translation-issues`、
`prepare-localization-release`。

### 本地状态

`.localehub/state.json` 记录 `lastScanId`、`lastPreview`、`pendingApplyPlans`、`lastApplyReport`、
`history`。只保存标识与哈希，不保存 Token。`.localehub/backups|patches|reports` 存放产物，
已在 `.gitignore` 中忽略，且扫描时会跳过整个 `.localehub` 目录。

## 3. Remote MCP

```bash
POST https://<host>/mcp
Authorization: Bearer lh_mcp_...
Content-Type: application/json
```

无状态（每个请求自带凭据），因此不存在跨租户的会话泄漏面。

工具：`list_projects`、`get_project`、`list_project_locales`、`search_translation_keys`、
`get_translation_entry`、`get_glossary`、`search_translation_memory`、`translate_entries`、
`review_translation_entries`、`get_qa_issues`、`update_translation_draft`、`submit_review`、
`get_project_sync_status`、`get_pending_platform_changes`、`validate_release`。

约束：
- `translate_entries` 只写 **DRAFT**；
- `review_translation_entries` 需要 `REVIEWER` 角色，且不能批准 `STALE` 译文；
- 任何工具都不提供本地文件访问。

Resources / Prompts 清单可通过 `GET /api/v1/mcp/tools` 获取（含 JSON Schema）。

## 4. Token 与 Scope

```json
{
  "organization_id": "org_uuid",
  "project_ids": ["project_uuid"],
  "scopes": ["project.read", "repository.scan", "sync.preview", "sync.push",
             "translation.read", "translation.pull", "translation.apply", "qa.execute"],
  "expires_at": "2026-12-09T00:00:00Z"
}
```

- `sync.push`（提交本地变更到平台）与 `translation.apply`（把平台变更写入本地）**分离授权**。
- `release.publish` 必须单独授予，不能被其他 scope 隐式获得。
- Token 明文只在创建时显示一次，数据库仅存 SHA-256 哈希；撤销立即生效。
- 文件系统边界由**本地配置**决定，不依赖平台 Token。

## 5. 配置校验（启动时执行）

`.localehub/config.yaml` 加载时会检查并拒绝：

- 缺少 source 映射、映射缺少 locale、映射使用绝对路径或 `..`；
- `allowWrite` 覆盖源码文件（只允许语言资源）；
- workspace glob 绝对路径或包含 `..`；
- 配置文件中出现内联 secret（必须用 `tokenEnv`）。

并给出警告：多个 source 映射、映射不可写、未被任何映射覆盖的本地化文件（`UNMAPPED_FILE`）。
