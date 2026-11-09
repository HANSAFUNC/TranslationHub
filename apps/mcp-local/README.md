# @localehub/mcp-local

运行在开发者机器上的 MCP Server（stdio）。它能访问**受限的**本地仓库目录，因此与 Remote MCP
严格分离：平台上不存在任何本地文件工具。

```bash
node dist/bin.js --stdio --workspace /path/to/repo
```

## 安全边界

- 路径必须同时满足：命中 `files[].paths` 映射 ∩ `workspace.allowWrite` ∩ 不命中 `denyWrite`，
  并解析真实路径拒绝 `..` 与符号链接逃逸。
- 写文件顺序：校验旧值 → 备份 → 临时文件 + fsync → 原子 rename → 重新解析（失败回滚）。
- `push_project_changes` / `apply_translation_updates` 默认 `confirm=false` 直接拒绝。
- 从不执行 `git commit` / `git push`；`create_git_patch` 只生成补丁文件。
- Token 只从环境变量读取，配置文件里出现内联 secret 会直接报错。

## 状态

`.localehub/state.json` 串联多步流程（last scan / last preview / pending apply plans / last apply
report）。它只保存标识与哈希，可安全删除。扫描时整个 `.localehub` 目录被跳过。

工具清单与参数见 [docs/MCP.md](../../docs/MCP.md)。
