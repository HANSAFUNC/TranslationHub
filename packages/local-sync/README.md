# @localehub/local-sync

开发者机器上的**本地仓库引擎**：扫描语言文件、与平台做三方比较、安全写回。

它不是一个 MCP Server，也不含任何 MCP 依赖。平台只暴露一个 MCP（`apps/mcp-remote`，跑在服务端），
它够不到开发者的磁盘；需要读写仓库时由 CLI 驱动这个引擎：

```bash
node apps/cli/dist/bin.js scan
node apps/cli/dist/bin.js sync preview
node apps/cli/dist/bin.js sync push --confirm
node apps/cli/dist/bin.js apply --confirm
```

Agent 用 Bash 调用同样的命令；CI 也是同一条路径，所以交互式使用与流水线不会分叉。

## 安全边界

- 路径必须同时满足：命中 `files[].paths` 映射 ∩ `workspace.allowWrite` ∩ 不命中 `denyWrite`，
  并解析真实路径拒绝 `..` 与符号链接逃逸。
- 写文件顺序：校验旧值 → 备份 → 临时文件 + fsync → 原子 rename → 重新解析（失败回滚）。
- `sync push` / `apply` 缺少 `--confirm` 直接拒绝，默认 dry-run。
- 从不执行 `git commit` / `git push`；`patch` 只生成补丁文件。
- Token 只从环境变量读取，配置文件里出现内联 secret 会直接报错。

## 状态

`.localehub/state.json` 串联多步流程（last scan / last preview / pending apply plans / last apply
report）。它只保存标识与哈希，可安全删除。扫描时整个 `.localehub` 目录被跳过。

命令清单与参数见 [docs/MCP.md](../../docs/MCP.md) §3。
