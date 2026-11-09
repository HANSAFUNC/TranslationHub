# @localehub/e2e-demo

端到端验收演示与集成测试。演示脚本会创建一份 `demo-app` 的临时副本、git 初始化、并在平台上
创建一个**临时项目**（结束时删除，`DEMO_KEEP_PROJECT=1` 可保留）。

```bash
pnpm -r build
node apps/e2e-demo/dist/run-demo.js        # 需要 API 在 :3001（未运行时会自动拉起）
pnpm test:integration                      # vitest，同样会自动拉起 API
```

## 演示覆盖的场景

| 场景 | 检查点 |
|---|---|
| 准备 | 复制 demo 仓库、git init、写入真实 project id 并提交 |
| A 扫描→预览→推送 | scan 上传成功、preview 有 push 项、`confirm=false` 被拒、push 成功、重复 push 幂等 |
| B 平台修正→审核→回写 | 审核后变为可拉取、apply 计划 ready、diff 显示旧值→新值、`confirm=false` 被拒、**预览后本地被改动则整计划被拒**、写回后文件含新值且其他 Key 保留、git diff 只涉及目标文件、校验 0 error |
| C 再次同步 | 全部 `unchanged`，不产生新版本 |
| D 草稿隔离 | 默认 pull 不含草稿、`include_drafts` 才可见、默认 apply 计划不含草稿、显式包含时带风险提示 |
| E 原文变更 | 源文推送后依赖旧版本的译文标记 `STALE`，历史版本保留 |
| 收尾 | 生成 git patch（不 commit）；删除临时项目 |

## 集成测试清单（14 项）

`test_push_new_key`、`test_idempotent_push`、`test_platform_approved_translation_pulled`、
`test_apply_creates_backup_and_atomic_write`、`test_apply_report_updates_baseline`、
`test_draft_translation_not_pulled_by_default`、`test_push_source_change_marks_targets_stale`、
`test_conflict_when_both_sides_changed`、`test_same_change_converges`、
`test_local_change_after_preview_blocks_apply`、`test_preview_plan_expiration`、
`test_mcp_scope_enforced`、`test_tenant_rls_isolation`、`test_cross_tenant_token_is_rejected`。

测试使用独立的组织与项目（通过特权路径一次性创建），不依赖 seed 数据。
