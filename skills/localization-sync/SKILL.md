---
name: localization-sync
description: Safely sync localization resources between a local repository and LocaleHub.
version: 1.0.0
kind: prompt
tools:
  - get_local_project_info
  - scan_local_project
  - preview_sync
  - push_project_changes
  - pull_platform_updates
  - preview_apply
  - apply_translation_updates
  - get_sync_status
  - resolve_sync_conflict
  - report_apply_result
  - create_git_patch
---

# localization-sync

在本地仓库与 LocaleHub 之间安全同步本地化资源。

## 流程

1. 读取 `.localehub/config.yaml`。
2. 调用 `get_local_project_info` 与 `scan_local_project`。
3. 在任何 push 或写文件之前调用 `preview_sync`。
4. 向用户解释 push、pull、unchanged、conflict、archive 五类条目。
5. 只有用户明确确认后才 push。
6. 默认只拉取 `APPROVED` 译文。
7. 调用 `preview_apply` 并展示逐文件、逐 Key 的 diff。
8. 只有用户明确确认后才写入文件。
9. 绝不覆盖 preview 之后发生的本地修改。
10. 除非单独授权，否则不执行 git commit 或 push。
11. 汇报同步会话、写入文件、跳过条目与冲突。

## 禁止

- 不得在没有 preview 的情况下 push 或写文件。
- 不得把未审核（DRAFT/PENDING_REVIEW）译文写入正式语言文件。
- 不得因为“看起来一样”就跳过冲突检查。
- 不得读取 allowRead 之外的文件，也不得上传完整源码。
