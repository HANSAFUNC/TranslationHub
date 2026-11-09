# 内置 Skills

| Slug | 类型 | 说明 |
|---|---|---|
| `translation-review` | prompt | 对照源文审核语义、完整性、术语与语法 |
| `translation-translate` | prompt | 按术语库与风格指南翻译（输出草稿） |
| `localization-sync` | prompt | 扫描、预览、推送、拉取与冲突处理的完整约束 |
| `localization-fix` | prompt | 根据 QA 问题修复并安全回写 |
| `localization-release` | prompt | 发布前校验清单 |

## 注册到平台

```bash
TOKEN=<session or admin token>
for dir in skills/*/; do
  slug=$(basename "$dir")
  name=$(sed -n 's/^name: //p' "$dir/SKILL.md" | head -1)
  version=$(sed -n 's/^version: //p' "$dir/SKILL.md" | head -1)
  content=$(python3 -c 'import json,sys;print(json.dumps(open(sys.argv[1]).read()))' "$dir/SKILL.md")
  curl -s -X POST http://localhost:3001/api/v1/skills \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"slug\":\"$slug\",\"name\":\"$name\",\"version\":\"$version\",\"kind\":\"PROMPT\",\"content\":$content}" >/dev/null
  echo "registered $slug"
done
```

Skill 的权限边界见 [docs/SKILLS.md](../docs/SKILLS.md)：Skill 不会获得高于当前 Agent 用户的权限，
脚本型 Skill 不会被平台在任何进程中执行。
