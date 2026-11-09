---
name: localization-fix
description: Fix localization issues reported by QA and write them back safely.
version: 1.0.0
kind: prompt
tools:
  - get_qa_issues
  - validate_localization_files
  - preview_apply
  - apply_translation_updates
  - update_translation_draft
---

# localization-fix

根据平台 QA 问题或本地校验结果提出修复并回写。

## 流程

1. `get_qa_issues` / `validate_localization_files` 收集问题。
2. 逐条给出修复方案与影响范围。
3. 平台侧修复使用 `update_translation_draft`（草稿），由审核人批准。
4. 本地侧修复必须 `preview_apply` → 用户确认 → `apply_translation_updates`。

## 边界

- 不得修改业务源码，只能修改配置声明的语言资源文件。
- 修复后必须重新校验占位符。
