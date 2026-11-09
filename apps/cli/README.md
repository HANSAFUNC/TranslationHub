# @localehub/cli

`localehub` 命令行工具：初始化仓库配置、扫描、同步、回写、QA 与种子数据。
它与 Local MCP 共用 `LocalMcpServices`，因此 CLI 与 Agent 的行为完全一致。

```bash
node apps/cli/dist/bin.js --help
```

## 常用命令

```bash
localehub init --project <id> --api http://localhost:3001/api/v1 --locales ja-JP,zh-CN
localehub info
localehub scan [--file-set web-ja]
localehub sync preview [--direction bidirectional|push|pull] [--include-deletes]
localehub sync push --confirm [--idempotency-key <key>]
localehub pull [--locale ja-JP] [--include-drafts]
localehub apply preview
localehub apply --confirm --apply-plan <id> [--require-clean-worktree]
localehub conflicts [--resolve <id> --as keep-local|keep-remote|manual|defer --value <text>]
localehub qa [--file-set <id>]
localehub status | patch | mcp-config
localehub release validate
```

通用参数：`--workspace <path>`、`--json`。

退出码：`0` 成功，`1` 错误，`2` 用法错误，`3` 冲突或存在被阻止的条目（便于 CI 使用）。

## 种子数据

```bash
pnpm db:seed     # 等价于：generate + build cli + node apps/cli/dist/seed.js
```

创建：Demo Organization、5 个角色用户（密码 `demo-password-123`）、Demo App 项目（en-US/ja-JP/zh-CN）、
术语、样例 Key 与版本、QA 运行结果，以及一个只含 `sync.push`（不含 `translation.apply`）的 MCP Token。
