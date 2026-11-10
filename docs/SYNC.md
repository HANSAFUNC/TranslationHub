# 双向同步：基线、三方比较、冲突与安全回写

本文是实现依据，对应 packages/sync-engine、packages/domain/sync.ts、packages/local-sync。

## 1. 同步基线（SyncBaseline）

唯一键：`repository_connection_id + platform + namespace + key + locale`。
字段：`local_hash`、`remote_hash`、`base_value`、`source_version_id`、`translation_version_id`、
`remote_revision`、`last_synced_at`，以及本地文件定位信息 `local_file_id` / `local_file_path`。
基线**只代表「上次双方一致时的内容」**，不代表谁是最新。避免用单一 `base_content_hash`
是为了兼容未来两侧规范化规则演进（规格 §7.1）。

## 2. 三方比较（纯函数，可复现）

`computeSyncDiff(entry)`，输入 `L`（当前本地）、`R`（当前平台）、`B`（基线）：

| 本地相对 B                 | 平台相对 B    | L 与 R | 结果                                   |
| -------------------------- | ------------- | ------ | -------------------------------------- |
| 未变                       | 未变          | 相同   | `SKIP`                                 |
| 已变                       | 未变          | —      | `PUSH_LOCAL`                           |
| 未变                       | 已变          | —      | `PULL_REMOTE`（先预览）                |
| 已变                       | 已变          | 相同   | `CONVERGED`（更新基线）                |
| 已变                       | 已变          | 不同   | `CONFLICT`                             |
| 新 Key                     | 不存在        | —      | `PUSH_NEW`                             |
| 不存在                     | 平台新增      | —      | `PULL_NEW`                             |
| 本地删除                   | 平台未变      | —      | `ARCHIVE_CANDIDATE`（不物理删除）      |
| 本地未变                   | 平台删除/归档 | —      | `REMOTE_ARCHIVE_CANDIDATE`             |
| 两侧都删除                 | —             | —      | `ARCHIVE_CONVERGED`                    |
| 平台侧译文基线源文版本过期 | —             | —      | `CONFLICT`（`SOURCE_VERSION_CHANGED`） |

要点：

- 比较的是**规范化后的内容哈希**（SHA-256，NFC + 统一换行），不是文件时间戳，也不是文件哈希。
- 未同步过的条目（无基线）：两侧值相同 → `CONVERGED`；不同 → `CONFLICT`（不猜谁对）。
- 默认只有 `APPROVED` 的远端译文 `remoteApplyEligible=true`；`includeDrafts` 显式开启才放宽，
  且 apply 计划会附带风险提示。
- `STALE` 译文默认不可回写（源文已变更），除非项目策略显式允许。

## 3. 同步计划与防篡改

1. `POST /sync/scans` 上传规范化条目（scan 1 小时过期）。
2. `POST /sync/preview` 由服务端重新计算计划 → 返回 `syncPlanId`、`planHash`、`expiresAt`、`summary`。
3. `planHash = sha256(canonicalJson(plan))`，条目按 locale/platform/namespace/key 排序，哈希可复现。
4. `POST /sync/push` 必须携带 `syncPlanId + planHash + confirmed: true`，服务端校验：
   - 计划存在、未过期、未被确认过；
   - `plan.baseRevision === 当前 project.revision`，否则 `REVISION_MISMATCH`（要求重新预览）；
   - 逐条重新应用，**不信任客户端上传的变更明细**。
5. 同一计划重复 push → 幂等重放（返回上次结果，`idempotentReplay=true`），不会重复创建版本。

## 4. 幂等、并发与重试

- `Idempotency-Key` 建议：`repo-<connection>-<commit>-<planHash>`。
- `TranslationVersion` 不可变；写入前比较 `contentHash`，相同则不产生新版本。
- `SyncSession` 状态：`PENDING / RUNNING / PARTIAL / SUCCEEDED / FAILED / CANCELLED`；
  `SyncItem` 逐条记录状态，允许部分成功后重试失败项。
- 源文变更只在哈希变化时创建新 `SourceVersion`，并把依赖旧版本的译文标记 `STALE`。

## 5. 冲突处理

冲突记录包含 Base / Local / Platform 三份内容与哈希、文件路径、远端版本、原因、决策人。
原因分类：`LOCAL_AND_REMOTE_CHANGED`、`SOURCE_VERSION_CHANGED`、`FILE_MAPPING_CHANGED`、
`LOCAL_DELETED_REMOTE_CHANGED`。

决策语义：

| 决策           | 平台                                         | 本地                                       |
| -------------- | -------------------------------------------- | ------------------------------------------ |
| `KEEP_LOCAL`   | 立即写入新 APPROVED 版本（新 revision 事件） | 不变（本来就是本地值）                     |
| `KEEP_REMOTE`  | 不变                                         | 需再次 pull + preview_apply + apply 才写回 |
| `MANUAL_MERGE` | 写入合并值（新 APPROVED 版本）               | 需再次 apply 写回                          |
| `DEFER`        | 不变                                         | 不变                                       |

任何决策都**新增版本**，绝不修改历史版本。已解决冲突不能重复解决（`CONFLICT_ALREADY_RESOLVED`）。

## 6. 安全回写（CLI）

`localehub apply --confirm` 的执行顺序：

1. 取出 apply 计划，校验存在、未过期、`confirm=true`。
2. 可选 `require_clean_worktree`（reject dirty tree）。
3. **重新扫描**当前文件，逐条比对 `previousValue`：
   - 值不一致 → `APPLY_REJECTED_STALE_PREVIEW`（整个计划拒绝，不写任何文件）。
4. 逐文件：
   - 再次确认目标路径命中 `files` 映射 ∩ `allowWrite` ∩ `!denyWrite`，并解析真实路径防符号链接逃逸；
   - 用格式 Adapter 做**原地补丁**（保留缩进、键顺序、注释、未知字段）；
   - 备份到 `.localehub/backups/<timestamp>/<path>`；
   - 写同目录临时文件 → `fsync` → 原子 `rename`；
   - 重新解析输出文件，失败则恢复备份并报错；
   - 记录新文件哈希。
5. 输出 `git diff --stat`（不 commit）。
6. 上报 apply report → 平台推进基线、记录 `applied_to_repo_at/commit`。

失败隔离：单个文件失败不影响其他文件；报告状态为 `PARTIAL` 并给出逐条错误码。

## 7. 平台增量事件

`project_events` 每次写入都会 `projects.revision + 1`，事件带该 revision。
CLI 用 `since_revision` 游标拉取，漏掉事件可通过游标补拉，不依赖 webhook。
`projects.revision` 是唯一权威顺序，不使用客户端时间戳。

## 8. 已实现的自动化测试

| 测试                                                                                                            | 位置                                                      |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `test_bidirectional_three_way_merge`（全分支）                                                                  | packages/sync-engine/src/**tests**/three-way.test.ts      |
| `test_same_change_converges`                                                                                    | 同上 + 集成测试                                           |
| `test_conflict_when_both_sides_changed`                                                                         | 集成测试                                                  |
| `test_platform_approved_translation_pulled`                                                                     | 集成测试                                                  |
| `test_draft_translation_not_pulled_by_default`                                                                  | 集成测试                                                  |
| `test_push_new_key` / `test_idempotent_push`                                                                    | 集成测试                                                  |
| `test_preview_plan_expiration`                                                                                  | 集成测试                                                  |
| `test_local_change_after_preview_blocks_apply`                                                                  | 集成测试                                                  |
| `test_apply_creates_backup_and_atomic_write`                                                                    | 集成测试                                                  |
| `test_push_source_change_marks_targets_stale`                                                                   | 集成测试                                                  |
| `test_apply_report_updates_baseline`                                                                            | 集成测试                                                  |
| `test_mcp_scope_enforced`                                                                                       | 集成测试                                                  |
| `test_tenant_rls_isolation`                                                                                     | 集成测试                                                  |
| `test_round_trip_preserves_platform_metadata`                                                                   | packages/format-adapters/src/**tests**/round-trip.test.ts |
| `test_path_traversal_rejected` / `test_symlink_escape_rejected` / `test_local_mcp_reads_only_allowed_workspace` | packages/workspace/src/**tests**/workspace.test.ts        |

## 草稿回写的组织级策略

规格 §3.3 step 8 允许用 `include_drafts=true` 把未审核草稿一并拉取/写回。这条路径会**用草稿覆盖
已审核文案**，因此平台把它收敛成组织级开关：

- `organizations.allow_draft_apply`，默认 `false`。
- 关闭时，任何请求草稿状态的调用（`GET /projects/:id/sync/changes?status=DRAFT`、
  `POST /sync/preview` 带 `includeDrafts`）都会被平台以 `POLICY_VIOLATION` 拒绝 —— 判定在**平台侧**，
  不由运行在开发者机器上的 CLI 决定。
- 开启后行为与规格一致：草稿出现在变更列表里，apply 计划附带 `riskWarning`。
- 开关位置：Web 后台「组织设置 → 同步安全策略」，或 `PATCH /organization/settings`。
