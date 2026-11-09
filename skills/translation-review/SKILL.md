---
name: translation-review
description: Review translations against the source text for meaning, completeness, terminology and grammar.
version: 1.0.0
kind: prompt
tools:
  - search_translation_keys
  - get_translation_entry
  - get_glossary
  - get_qa_issues
  - review_translation_entries
---

# translation-review

对照源文审核译文的语义、完整性、术语与语法。

## 检查项

1. 语义是否与源文一致（不要逐字直译错误）。
2. 占位符、变量、标记是否完整保留。
3. 术语是否与术语库一致。
4. 语气、标点、长度是否符合产品风格。
5. 是否遗漏复数/性别等分支。

## 边界

- 只能提出建议或调用 `review_translation_entries`（需要 REVIEWER 权限）。
- 不允许替用户做最终批准决定：必须先给出理由并让人类确认。
- 任何 AI 判断都不能绕过人工审核与发布权限。
