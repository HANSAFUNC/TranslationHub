# MCP：平台只暴露一个 Remote MCP

## 1. 为什么只有一个

平台侧**只有一个 MCP 服务**：跑在服务端容器里，用 Streamable HTTP，只暴露平台数据。

早期版本按交付规格 §6.1 还提供过一个「Local MCP」——在开发者机器上以 stdio 运行、能读写受
白名单约束的仓库目录。它被移除了，原因是它没有存在的必要，还制造了两个真实问题：

1. **它无法被平台侧统一管理**。它由每个开发者各自的客户端进程拉起，版本、配置、能力都随
   机器而变；平台无法知道对面是哪个版本，也无法在不打扰用户的情况下更新它。
2. **它让「能力清单」失去唯一来源**。工具、resource、prompt 散在两台 Server 上，平台的
   发现接口（`GET /api/v1/mcp/tools`）只能把两份清单糊成一个扁平列表，结果是它声明了 6 条
   没有任何 Server 实现的 resource，还把一个已删除 Server 的 prompt 当成通用清单发布。

去掉之后，读写开发者仓库这件事仍然有人做，只是换了个更合适的载体：**CLI**（见 §3）。它同样
受 workspace 白名单、备份与原子写保护，但它是一个可以按版本固定、可以在 CI 里跑、出错时退出码
明确的普通命令行工具，而不是一个必须由 Agent 进程托管的 MCP 服务。

平台因此**永远无法主动访问开发者机器**：所有「本地动作」都在本地发起，平台只记录结果
（心跳、commit、apply report）。仓库 URL / 分支 / commit **不作为权限依据**。

## 2. Remote MCP

```bash
POST https://<host>/mcp
Authorization: Bearer lh_mcp_...
Content-Type: application/json
```

无状态（每个请求自带凭据），因此不存在跨租户的会话泄漏面。

### 2.1 接入教程（四步）

Web 端「MCP 管理 → 接入教程」是同一份流程，且会用**你自己的项目**生成示例。这里给读文档的人一份
自足的版本。

**第 1 步：签发 Token。** 「开发者 → API / MCP Token」→ 选 scopes → 签发。明文只显示一次。

| 用途                  | scopes                                                        |
| --------------------- | ------------------------------------------------------------- |
| 只读查看              | `project.read`、`translation.read`、`glossary.read`           |
| 让 Agent 写草稿       | 再加 `translation.write`                                      |
| 提交审核              | 再加 `translation.review`（仍需人类 REVIEWER 批准）           |
| 让 Agent 回报仓库写回 | 再加 `sync.push` / `translation.apply`（两者互相独立，见 §5） |

```bash
export LOCALEHUB_TOKEN="lh_mcp_…"   # 存进环境变量，不要提交到 Git
```

**第 2 步：拿到你的 `project_id`。** 15 个工具里有 14 个把它当第一个参数，而它是个 UUID——
不能靠猜。

两种拿法：

- 打开项目的详情页，标题旁就是 `project_id`，点一下即复制（项目页地址的最后一段也是它）；
- 或者直接问 Agent：`list_projects` **只返回这个 Token 能访问的项目**，所以它看到的是你的项目，
  不是别人的。这也是「数据自动适配使用者」的实现方式——过滤依据是 Token 绑定的
  `project_ids` 与用户自身的项目角色，不是你手动填的什么东西。

**第 3 步：把配置放进客户端。** 与本仓库、本地配置无关，只需要 URL 加 Token，可以配在任何机器上。

**第 4 步：验证。**

> 列出 LocaleHub 上我能访问的项目，然后读取 <你的项目> 的语言列表。

能看到自己的项目就说明通了。接着可以让它做事，例如：

> 用 project_id=<你的 project_id> 搜索待审核的译文，逐条给出审核建议。

> 用 project_id=<你的 project_id> 读取 QA 问题，给出修复后的译文并写入草稿。

### 2.2 配置片段

Remote MCP 与本仓库、本地配置**无关**：它只需要一个 URL 和一个 Token，因此可以配在任何地方
（另一台机器、CI、纯平台侧 Agent）。

平台页面「MCP 管理 → 客户端配置」把片段列出来，带复制按钮，URL 取服务端配置的 `MCP_PUBLIC_URL`；
片段由服务端用与 CLI 相同的生成器渲染，两边不会不一致。片段里永远只有 `${LOCALEHUB_TOKEN}`
这种环境变量引用，不会出现 Token 明文。

生成片段：

```bash
node apps/cli/dist/bin.js mcp-config                                # 向平台询问自己的 MCP 地址
node apps/cli/dist/bin.js mcp-config --remote https://example/mcp   # 或显式指定
```

得到：

```json
{
  "mcpServers": {
    "localehub-remote": {
      "type": "http",
      "url": "http://localhost:3003/mcp",
      "headers": { "Authorization": "Bearer ${LOCALEHUB_TOKEN}" }
    }
  }
}
```

放进 Claude Code / Cursor 的 MCP 配置（项目里的 `.mcp.json` 或用户级配置）并导出
`LOCALEHUB_TOKEN`，重启客户端即可。

Claude Code 也可以直接用命令行添加：

```bash
claude mcp add --transport http localehub-remote http://localhost:3003/mcp \
  --header "Authorization: Bearer $LOCALEHUB_TOKEN"
```

### 2.2.1 要点与约束

几个要点：

- **Token 是必须的**，不带 Token 的请求返回 401。用平台「开发者 → Token」签发，scope 按用途选：
  只读场景给 `project.read` + `translation.read` + `glossary.read`；需要让 Agent 写草稿再给
  `translation.write`；审核给 `translation.review`。
- **本地开发不需要配 CORS**：Remote MCP 是给 MCP 客户端直连的，不走浏览器。
- **不需要在仓库里装任何东西**：MCP 配置只描述一个远端 URL，与检出目录无关。
- 生产环境把 URL 换成 nginx 暴露的地址（`location /mcp` → `mcp-remote:3003`，见
  `docker/nginx/`）。
- 只支持 `POST /mcp`；`GET /mcp` 返回 405（无状态，没有 SSE 流可订阅）。

工具：`list_projects`、`get_project`、`list_project_locales`、`search_translation_keys`、
`get_translation_entry`、`get_glossary`、`search_translation_memory`、`translate_entries`、
`review_translation_entries`、`get_qa_issues`、`update_translation_draft`、`submit_review`、
`get_project_sync_status`、`get_pending_platform_changes`、`validate_release`。

工具标注（MCP `annotations`）：`translate_entries`、`review_translation_entries`、
`update_translation_draft`、`submit_review` 声明 `readOnlyHint: false`，其余 11 个为只读。
客户端据此可以判断哪些调用会改动平台数据。

约束：

- `translate_entries` 只写 **DRAFT**；
- `review_translation_entries` 需要 `REVIEWER` 角色，且不能批准 `STALE` 译文；
- 任何工具都不提供本地文件访问。

Resources / Prompts 清单可通过 `GET /api/v1/mcp/tools` 获取（含 JSON Schema）。该响应还包含
`skillDelivery`，即下发的 URI 模板与 prompt 前缀，供 Web UI 直接渲染。

### 2.3 使用者之间如何隔离

「别人用的数据要自动适配使用者的项目」这件事在平台上是这样落地的，每一层都不需要使用者手动配置：

| 层         | 机制                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Token      | 绑定签发时的用户、组织与 `project_ids`；`list_projects` 与其余工具都按它过滤                     |
| 角色       | 同一个 Token 解析出的 actor 带用户的组织角色与项目角色，权限与浏览器登录完全一致                 |
| 数据库     | 每张租户表都有行级策略，`app.current_org_id` 之外的行走 SQL 层就不可见（§1.24）                  |
| 文档与示例 | Web 教程用**当前登录者自己的项目**生成 `project_id` 与示例提示词；文档里只有占位符，没有演示数据 |

因此接入者看到的项目列表、示例里的 id、能读到的译文，都是他自己的。平台侧不存在需要他「改成自己的」
配置项——URL 由部署方通过 `MCP_PUBLIC_URL` 决定，其余全部由 Token 推导。

## 3. 本地仓库操作：CLI（不是 MCP）

读写开发者仓库的 14 个动作都在 CLI 里，`localehub <command>`。它们与 MCP 无关，也不需要
MCP：Agent 可以用 Bash 调用，CI 可以直接调用，人也可以在终端里调用。

```bash
node apps/cli/dist/bin.js scan                # 扫描语言文件并规范化
node apps/cli/dist/bin.js sync preview        # 三方比较，只读
node apps/cli/dist/bin.js sync push --confirm # 推送本地变更
node apps/cli/dist/bin.js pull                # 查询平台已审核译文
node apps/cli/dist/bin.js apply preview       # 回写 dry-run
node apps/cli/dist/bin.js apply --confirm     # 备份 + 原子写回
node apps/cli/dist/bin.js conflicts           # 列出未解决冲突
node apps/cli/dist/bin.js qa                  # 本地格式/占位符/缺译校验
node apps/cli/dist/bin.js status              # 本地状态 + 远端状态
node apps/cli/dist/bin.js patch               # 生成 patch/diff，不 commit
node apps/cli/dist/bin.js release validate    # 发布前校验
node apps/cli/dist/bin.js info                # 配置、workspace root、Git 状态
node apps/cli/dist/bin.js mcp-config          # 打印 MCP 客户端配置片段
```

| 动作                  | 默认行为               | 说明                                                    |
| --------------------- | ---------------------- | ------------------------------------------------------- |
| `info`                | 只读                   | 配置、workspace root、Git 分支/commit、映射             |
| `scan`                | 只读（上传规范化条目） | 扫描配置声明的语言文件；返回文件数/Key 数/警告          |
| `sync preview`        | 只读                   | 三方比较，生成变更计划                                  |
| `sync push`           | **必须 `--confirm`**   | 只能提交此前生成且未过期的计划                          |
| `pull`                | 只读                   | 默认只返回 `APPROVED`                                   |
| `apply preview`       | dry-run                | 逐文件逐 Key 的旧值/新值/风险                           |
| `apply --confirm`     | **必须二次确认**       | 备份 + 原子写入 + 重解析校验                            |
| `qa`                  | 只读                   | 格式、占位符、重复 Key、缺译                            |
| `status`              | 只读                   | 本地状态 + 远端状态 + 未解决冲突                        |
| `conflicts --resolve` | 显式选择               | `KEEP_LOCAL` / `KEEP_REMOTE` / `MANUAL_MERGE` / `DEFER` |
| `patch`               | 只读                   | 生成 patch/diff，**不 commit**                          |
| `release validate`    | 只读                   | 发布前校验清单                                          |

三件事仍然受保护，与有没有 MCP 无关：

- **workspace 白名单**：`allowRead` / `allowWrite` / `denyRead` / `denyWrite` 在每次路径解析时
  生效，拒绝 `..` 与符号链接逃逸（`packages/workspace`）；
- **备份与原子写**：写回前备份、临时文件原子替换、写后重新解析校验（`SafeFileWriter`）；
- **先预览后确认**：`sync push` 与 `apply` 都要求显式确认，默认 dry-run。

### 本地状态

`.localehub/state.json` 记录 `lastScanId`、`lastPreview`、`pendingApplyPlans`、`lastApplyReport`、
`history`。只保存标识与哈希，不保存 Token。`.localehub/backups|patches|reports` 存放产物，
已在 `.gitignore` 中忽略，且扫描时会跳过整个 `.localehub` 目录。

Agent 侧的正确用法：需要平台的三方比较、冲突检测与基线记录时，让 Agent 用 Bash 跑上面的命令，
而不是绕过它们直接改译文文件——直接改会让平台失去基线，冲突检测随之失效。

## 4. Skill 下发

Skill（工作流程与规范文档）通过 MCP 以 resource 下发，指令型 Skill 额外注册一个 prompt：

| 用途 | URI / 名称                  | 内容                                                          |
| ---- | --------------------------- | ------------------------------------------------------------- |
| 清单 | `localehub://skills`        | Markdown 表格，列出每个 Skill 的 resource URI 与 prompt 名称  |
| 正文 | `localehub://skills/{slug}` | 完整 `SKILL.md`，`text/markdown`                              |
| 调用 | `skill-<slug>`              | 仅 `PUBLISHED` + `kind=PROMPT`；可选参数 `focus` 指定本次范围 |

只下发 `PUBLISHED` 的最高版本；`kind=SCRIPT` 的 Skill 只有 resource，没有 prompt。完整规则见
[docs/SKILLS.md](./SKILLS.md#4-通过-mcp-下发给客户端)。

Server 每个请求建一次（无状态），所以 Skill 是**实时**的：新发布的 Skill 下一个请求就能读到，
不需要重启任何客户端。

取数走数据库、受 RLS 约束，与 `GET /skills` 的可见性规则一致。查询失败时只记 stderr 并返回空清单
——Skill 是附加能力，不能因为读不到它而让 15 个工具一起报错。

## 5. Token 与 Scope

```json
{
  "organization_id": "org_uuid",
  "project_ids": ["project_uuid"],
  "scopes": [
    "project.read",
    "repository.scan",
    "sync.preview",
    "sync.push",
    "translation.read",
    "translation.pull",
    "translation.apply",
    "qa.execute"
  ],
  "expires_at": "2026-12-09T00:00:00Z"
}
```

- `sync.push`（提交本地变更到平台）与 `translation.apply`（把平台变更写入本地）**分离授权**。
- `release.publish` 必须单独授予，不能被其他 scope 隐式获得。
- Token 明文只在创建时显示一次，数据库仅存 SHA-256 哈希；撤销立即生效。
- 文件系统边界由**本地配置**决定，不依赖平台 Token。

## 6. 配置校验（启动时执行）

`.localehub/config.yaml` 加载时会检查并拒绝：

- 缺少 source 映射、映射缺少 locale、映射使用绝对路径或 `..`；
- `allowWrite` 覆盖源码文件（只允许语言资源）；
- workspace glob 绝对路径或包含 `..`；
- 配置文件中出现内联 secret（必须用 `tokenEnv`）。

并给出警告：多个 source 映射、映射不可写、未被任何映射覆盖的本地化文件（`UNMAPPED_FILE`）。
