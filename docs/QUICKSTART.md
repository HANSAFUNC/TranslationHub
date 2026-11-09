# 5 分钟快速上手

## 1. 起服务

```bash
pnpm install
pnpm db:up                 # postgres:55432 / redis:56379
pnpm db:migrate
pnpm db:generate
pnpm -r build
pnpm db:seed
pnpm dev:api &             # :3001
pnpm dev:web &             # :3000
```

浏览器打开 http://localhost:3000 ，用 `demo@localehub.dev` / `demo-password-123` 登录。

## 2. 看端到端闭环（不接真实仓库）

```bash
node apps/e2e-demo/dist/run-demo.js
```

输出会逐条打印 A–E 五个场景的检查结果，最后是 `ALL ACCEPTANCE CHECKS PASSED`。

## 3. 接自己的仓库

```bash
cd /path/to/your/repo
node /path/to/localehub/apps/cli/dist/bin.js init \
  --project <project-id> \
  --api http://localhost:3001/api/v1 \
  --source-locale en-US \
  --locales ja-JP,zh-CN

# 在平台「开发者 → API / MCP Token」签发一个含 sync.push + translation.apply 的 Token
export LOCALEHUB_TOKEN="lh_mcp_..."

node /path/to/localehub/apps/cli/dist/bin.js info
node /path/to/localehub/apps/cli/dist/bin.js scan
node /path/to/localehub/apps/cli/dist/bin.js sync preview
node /path/to/localehub/apps/cli/dist/bin.js sync push --confirm
```

然后在平台修改并审核译文，回到仓库：

```bash
node /path/to/localehub/apps/cli/dist/bin.js pull --locale ja-JP
node /path/to/localehub/apps/cli/dist/bin.js apply preview
node /path/to/localehub/apps/cli/dist/bin.js apply --confirm --apply-plan <id>
git diff          # 只应包含预期的语言文件条目
```

## 4. 在 Claude Code / Cursor 里用

把 `docs/MCP.md` 中的 `.mcp.json` 片段放到仓库根目录，重启客户端，
然后对 Agent 说：

> 用 localehub-local 扫描这个仓库，先预览同步计划给我看，我确认后再推送。

Agent 会依次调用 `get_local_project_info` → `scan_local_project` → `preview_sync`，
并把计划展示出来；只有你说"确认"之后才会调用 `push_project_changes(confirm=true)`。

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `CONFIG_INVALID: No .localehub/config.yaml found` | 在仓库根目录执行 `localehub init`，或用 `--workspace` 指定路径 |
| `INVALID_TOKEN`：Environment variable LOCALEHUB_TOKEN is empty | 导出 Token；配置里的 `tokenEnv` 可改名 |
| `PATH_NOT_WRITABLE` | 目标路径不在 `workspace.allowWrite` 或不在 `files` 映射内 |
| `SYNC_PLAN_EXPIRED` | 预览超过 30 分钟（`SYNC_PLAN_TTL_SECONDS`），重新 `preview_sync` |
| `REVISION_MISMATCH` | 预览后平台被别人改过，重新预览 |
| `APPLY_REJECTED_STALE_PREVIEW` | 预览后本地文件被改过，重新 `preview_apply` |
| `NOT_APPROVED` 条目 | 平台译文没有审核通过；让审核人批准，或显式 `include_drafts` |
| `SCOPE_INSUFFICIENT` | Token 缺少 `sync.push` 或 `translation.apply`；重新签发 |
