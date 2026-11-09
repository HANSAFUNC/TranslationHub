---
name: translation-translate
description: Translate entries using the project glossary and style guide.
version: 1.0.0
kind: prompt
tools:
  - search_translation_keys
  - get_glossary
  - search_translation_memory
  - translate_entries
  - update_translation_draft
---

# translation-translate

按术语库与风格指南翻译。

## 流程

1. 读取术语库与翻译记忆。
2. 对目标条目生成译文，保留全部占位符与标记。
3. 通过 `translate_entries` / `update_translation_draft` 写入 **草稿**。
4. 汇报哪些条目仍需要人工确认。

## 边界

- 输出永远是 DRAFT，不得自动提交审核或批准。
- 术语缺失时先提问，不要自行发明术语。
