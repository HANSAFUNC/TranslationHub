# Skills：安装、权限与执行边界

Skill 是**工作流程与本地化规范**；MCP 是**工具能力**。二者组合使用：
Skill 决定"按什么顺序、在什么约束下调用工具"。

## 1. 内置 Skill

| Slug                    | 用途                                 | 主要工具                                                                                                |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `translation-review`    | 对照源文审核语义、完整性、术语、语法 | search_translation_keys, get_translation_entry, get_glossary, get_qa_issues, review_translation_entries |
| `translation-translate` | 按术语库与风格指南翻译               | get_glossary, search_translation_memory, translate_entries, update_translation_draft                    |
| `localization-sync`     | 扫描、预览、推送、拉取与冲突处理     | CLI 全套（scan / sync / pull / apply）                                                                  |
| `localization-fix`      | 根据 QA 问题修复并回写               | get_qa_issues, validate_localization_files, preview_apply, apply_translation_updates                    |
| `localization-release`  | 发布前校验                           | get_sync_status, validate_release, get_pending_platform_changes                                         |

源码位于 `skills/<slug>/SKILL.md`，通过 `POST /api/v1/skills` 注册到平台（记录 slug、版本、内容与
manifest），UI 在「MCP 管理 → Skills」查看。

## 2. 权限模型

- Skill **不引入新权限**：它只能调用当前 Agent 用户已有权限的工具与接口。
- Prompt 型 Skill 只是指令文本，权限完全取决于调用方。
- 脚本型 Skill（`kind: SCRIPT`）**不会**在 API/Worker 进程内执行。

## 3. 脚本型 Skill 的执行边界（当前实现状态）

当前版本**尚未提供**脚本执行器。为避免"看似支持实则不安全"，平台采取的是显式拒绝策略：

- `POST /skills` 接受 `kind=SCRIPT` 仅作为**登记**（内容与 manifest 入库，供审阅与后续执行器使用）；
- 平台任何进程都不会 `eval` / `import` / `child_process` 执行上传内容；
- 需要执行的场景请使用 CLI（`localehub scan / sync / apply`）。

后续接入隔离执行环境时必须满足：独立容器、非 root、只挂载必要目录、默认无网络、
不接触 Docker socket / 宿主根目录 / 平台密钥文件，并对 CPU/内存/时长设限。

## 4. 通过 MCP 下发给客户端

Skill 以 MCP **resource** 下发，指令型 Skill 额外注册一个 MCP **prompt**（客户端里显示为可调用命令）。
两个 MCP Server 都提供，地址相同：

| 用途 | URI / 名称                  | 说明                                                                 |
| ---- | --------------------------- | -------------------------------------------------------------------- |
| 清单 | `localehub://skills`        | Markdown 表格：每个 Skill 的 slug、版本、resource URI 与 prompt 名称 |
| 正文 | `localehub://skills/{slug}` | 完整 `SKILL.md`（含 frontmatter），`text/markdown`                   |
| 调用 | `skill-<slug>`              | 仅 `PUBLISHED` + `kind=PROMPT` 的 Skill 注册                         |

下发规则（两个 Server、API 与 Web UI 共用 `packages/contracts/src/mcp-skills.ts` 的同一份实现）：

- 只下发 `PUBLISHED`：`DRAFT` 是未完成的工作，`DISABLED` 是被主动关掉的，都不该进入 Agent 上下文；
- 每个 slug 只下发**最高版本**（`1.10.0` 高于 `1.9.0`，按数字而非字符串比较）；
- `kind=SCRIPT` 的 Skill **只有 resource，没有 prompt**：脚本正文是待审阅执行的程序，不是可注入对话的消息；
- prompt 名统一加 `skill-` 前缀，因此组织注册的 slug 永远不会和内置 prompt 撞名
  （SDK 对重复注册直接抛错，而那个错会发生在 Server 构建阶段，等于整台 Server 不可用）；
- prompt 注入的是去掉 frontmatter 的正文；resource 保持文件原样。

取数走数据库（与 `GET /skills` 相同的可见性规则，同样受 RLS 约束）。Remote MCP 是无状态的，
每个请求建一次 Server，所以 Skill 是**实时**的：新发布的 Skill 下一个请求就能读到，不需要重启
任何客户端。

Skill 下发没有独立的授权：它与 `GET /skills` 一致，任何已认证的 actor 可读。这是有意的——Skill
不引入新权限（见 §2），正文本身也不含数据。

## 5. 与 MCP 的关系

```text
Agent（Claude Code / Cursor / Codex）
  ├─ Skill：先读 SKILL.md，得到流程与约束
  │    （`localehub://skills` → `localehub://skills/{slug}`，或直接调用 `skill-<slug>`）
  └─ MCP 工具：执行实际动作
       ├─ CLI → 本地仓库（受白名单约束）
       └─ Remote MCP → 平台数据（受角色与 scope 约束）
```

Skill 中的强制条款（例如"必须先 preview、必须用户确认、不得自动 commit"）与 MCP 工具自身的
默认行为（`confirm=false` 拒绝执行、dry-run 默认开启）是**双重保险**：即使 Agent 不遵守 Skill，
工具层也不会越权。
