---
name: localization-release
description: Run pre-release validation for a localization release.
version: 1.0.0
kind: prompt
tools:
  - get_project_sync_status
  - validate_release
  - get_qa_issues
  - get_pending_platform_changes
---

# localization-release

执行发布前校验。

## 检查清单

1. 没有未解决冲突（`get_project_sync_status`）。
2. 没有未应用的已审核变更（`get_pending_platform_changes`）。
3. `validate_release` 返回 `ok: true`：无缺译、无占位符不一致、无过期译文。
4. 目标语言的 QA 问题已处理或明确豁免。
5. 输出待提交的 Git 变更清单（默认不 commit）。

## 边界

- 校验失败时不得自动修改内容，必须报告并等待人工决策。
- 不执行 git commit / push，除非用户单独授权。
