# @localehub/sync-engine

双向同步的核心算法，**纯函数、无 IO**。CLI 与平台使用同一份实现，因此双方对同一状态的
判断与计划哈希必然一致。

## 导出

| 函数 | 作用 |
|---|---|
| `computeSyncDiff(entry, options)` | 三方比较（Base / Local / Remote）→ `SyncAction` + `SyncDiff` |
| `buildSyncPlan(entries, options)` | 确定性排序 + 逐条 diff + 汇总 + `planHash` |
| `computePlanHash(payload)` | 计划哈希（`sha256(canonicalJson(plan))`） |
| `summarize(items)` | `pushNew / pushUpdated / pullApproved / pullDraft / unchanged / conflicts / archiveCandidates / converged` |
| `resolveConflictValue(diff, input)` | 冲突决策 → 值 + 双方动作 |
| `buildApplyPlan(options)` | 回写计划（含旧值，用于过期校验） |
| `verifyApplyPlan(plan, currentLocal)` | 应用前逐条比对旧值 |
| `isPlanExpired(expiresAt)` | 计划过期判定 |

## 不变量

1. 计划条目按 `locale → platform → namespace → key` 排序，与输入顺序无关。
2. 同一状态永远得到同一个 action；`planHash` 因此可复现。
3. `CONFLICT` 永远不会被自动解决。
4. 只有 `APPROVED`（或显式 `includeDrafts`）的远端值 `remoteApplyEligible=true`。
5. `STALE` 远端值默认不可回写。

改动任何规则都必须同步更新 `src/__tests__/three-way.test.ts`，并说明对既有计划哈希的影响。
详见 [docs/SYNC.md](../../docs/SYNC.md)。
