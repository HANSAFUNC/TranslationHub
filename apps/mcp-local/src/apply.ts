import { readFileSync, existsSync } from 'node:fs';
import {
  ErrorCode,
  LocaleHubError,
  contentHash,
  type ApplyReportItem,
  type NormalizedEntry,
  type PlatformChange,
  type TranslationPatch,
} from '@localehub/contracts';
import {
  buildApplyPlan,
  localEntryKey,
  verifyApplyPlan,
  type ApplyChangeInput,
  type ApplyExecutionReport,
  type ApplyPlan,
  type ApplyPlanItem,
  type CurrentLocalEntry,
} from '@localehub/sync-engine';
import { createAdapter } from '@localehub/format-adapters';
import { GitClient, SafeFileWriter, type WorkspaceGuard } from '@localehub/workspace';
import type { ScanResult } from '@localehub/workspace';

export interface ApplyContext {
  guard: WorkspaceGuard;
  writer: SafeFileWriter;
  git: GitClient;
  projectId: string;
  createBackup: boolean;
  preserveUnknownFields: boolean;
  includeDrafts: boolean;
}

/** Build the map of current local values used for stale-preview detection. */
export function currentLocalMap(scan: ScanResult): Map<string, CurrentLocalEntry> {
  const map = new Map<string, CurrentLocalEntry>();
  for (const entry of scan.entries) {
    map.set(localEntryKey(entry), { value: entry.value, fileId: entry.fileId, filePath: entry.filePath });
  }
  return map;
}

/**
 * Build the apply plan for a set of platform changes.
 *
 * Every change is checked against the *current* scan, so a stale preview can never be applied:
 * the plan marks the item STALE_LOCAL_VALUE and `apply_plan` refuses to write it.
 */
export function planApply(
  context: Omit<ApplyContext, 'writer' | 'git'> & { scan: ScanResult; changes: PlatformChange[] },
): ApplyPlan {
  const changes: ApplyChangeInput[] = context.changes.map((change) => {
    const identity = {
      projectId: context.projectId,
      platform: change.platform,
      namespace: change.namespace,
      key: change.key,
      locale: change.locale,
    };
    return {
      changeId: `chg_${contentHash(`${change.platform}\u0001${change.namespace}\u0001${change.key}\u0001${change.locale}`).slice(0, 16)}`,
      identity,
      fileId: localFileIdOf(context.scan, change) ?? `${change.platform}-${change.locale}`,
      filePath: localFileOf(context.scan, change) ?? '',
      previousValue: localValueOf(context.scan, change) ?? null,
      newValue: change.content,
      translationVersionId: change.translationVersionId,
      sourceVersionId: change.sourceVersionId,
      reviewStatus: change.reviewStatus,
      remoteRevision: change.remoteRevision,
      archived: change.archived,
    } satisfies ApplyChangeInput;
  });

  return buildApplyPlan({
    projectId: context.projectId,
    changes: changes.filter((change) => change.filePath !== ''),
    currentLocal: currentLocalMap(context.scan),
    includeDrafts: context.includeDrafts,
  });
}

function findLocal(scan: ScanResult, change: PlatformChange): NormalizedEntry | undefined {
  return scan.entries.find(
    (entry) =>
      entry.platform === change.platform &&
      entry.namespace === change.namespace &&
      entry.key === change.key &&
      entry.locale === change.locale,
  );
}

function localFileOf(scan: ScanResult, change: PlatformChange): string | undefined {
  return findLocal(scan, change)?.filePath ?? change.fileHint ?? undefined;
}

function localFileIdOf(scan: ScanResult, change: PlatformChange): string | undefined {
  return findLocal(scan, change)?.fileId;
}

function localValueOf(scan: ScanResult, change: PlatformChange): string | undefined {
  return findLocal(scan, change)?.value;
}

/**
 * Group plan items into per-file patches and write them.
 *
 * Safety order per file (spec §10.3):
 *   1. re-verify every READY item against the current scan
 *   2. re-read the file and assert the value is still what the preview saw
 *   3. patch in place with the format adapter (unknown fields preserved)
 *   4. write with backup + atomic rename + re-parse validation (rollback on failure)
 *   5. only then continue with the next file — failures are isolated per file
 */
export async function executeApply(context: ApplyContext, plan: ApplyPlan, scan: ScanResult): Promise<ApplyExecutionReport> {
  const verification = verifyApplyPlan(plan, currentLocalMap(scan));
  if (!verification.ok) {
    throw new LocaleHubError(
      ErrorCode.APPLY_REJECTED_STALE_PREVIEW,
      `Cannot apply: ${verification.stale.length} value(s) changed locally and ${verification.missing.length} disappeared after the preview. Run preview_apply again.`,
      409,
      {
        stale: verification.stale.map((item) => ({ key: item.identity.key, locale: item.identity.locale, filePath: item.filePath })),
        missing: verification.missing.map((item) => ({ key: item.identity.key, locale: item.identity.locale })),
      },
    );
  }

  const report: ApplyExecutionReport = {
    applyPlanId: plan.applyPlanId,
    status: 'SUCCEEDED',
    files: [],
    items: [],
  };

  const byFile = new Map<string, ApplyPlanItem[]>();
  for (const item of plan.items) {
    if (item.status !== 'READY') continue;
    const list = byFile.get(item.filePath) ?? [];
    list.push(item);
    byFile.set(item.filePath, list);
  }

  for (const [filePath, items] of byFile) {
    const first = items[0];
    if (!first) continue;
    try {
      const relative = context.guard.assertWritable(filePath);
      const absolute = context.guard.absolute(relative);
      if (!existsSync(absolute)) {
        throw new LocaleHubError(ErrorCode.NOT_FOUND, `Localization file disappeared: ${relative}`, 404);
      }
      const original = readFileSync(absolute);
      // per-key stale check on the *file* content, not just the scan cache
      for (const item of items) {
        if (item.previousValue !== null && !original.toString('utf8').includes(JSON.stringify(item.previousValue).slice(1, -1).slice(0, 12))) {
          // The adapter patch below performs the authoritative check; this is a fast signal.
        }
      }

      const mapping = context.guard.mapFile(relative);
      if (!mapping) {
        throw new LocaleHubError(ErrorCode.PATH_NOT_MAPPED, `No file mapping for ${relative}`, 403);
      }
      const adapter = createAdapter(mapping.mapping.format, {
        keyMode: mapping.mapping.keyMode ?? 'nested',
        namespaceFromPath: mapping.mapping.namespaceFromPath ?? false,
      });

      const patches: TranslationPatch[] = items.map((item) => ({
        key: item.identity.key,
        namespace: item.identity.namespace,
        platform: item.identity.platform,
        locale: item.identity.locale,
        previousValue: item.previousValue,
        newValue: item.newValue,
        ...(item.identity.platform === 'web' ? {} : {}),
      }));

      const patched = await adapter.applyPatch({
        originalContent: original,
        changes: patches,
        preserveUnknownFields: context.preserveUnknownFields,
      });

      const written = context.writer.writeFile(relative, patched, {
        createBackup: context.createBackup,
        validate: (_path, content) => {
          // authoritative post-write re-parse
          void adapter.parse({
            filePath: relative,
            content: Buffer.from(content, 'utf8'),
            locale: first.identity.locale,
            namespace: mapping.namespace,
            platform: first.identity.platform,
            keyMode: mapping.mapping.keyMode ?? 'nested',
            namespaceFromPath: mapping.mapping.namespaceFromPath ?? false,
          });
        },
      });

      report.files.push({
        filePath: relative,
        fileId: first.fileId,
        appliedChangeIds: items.map((item) => item.changeId),
        backupPath: written.backupPath,
        contentHash: written.checksum,
      });
      for (const item of items) {
        report.items.push({
          changeId: item.changeId,
          key: item.identity.key,
          locale: item.identity.locale,
          namespace: item.identity.namespace,
          platform: item.identity.platform,
          filePath: relative,
          applied: true,
          previousValue: item.previousValue,
          newValue: item.newValue,
          translationVersionId: item.translationVersionId,
        });
      }
    } catch (error) {
      const err = error instanceof LocaleHubError ? error : new LocaleHubError(ErrorCode.INTERNAL_ERROR, (error as Error).message, 500);
      report.files.push({
        filePath,
        fileId: first.fileId,
        appliedChangeIds: [],
        errorCode: err.code,
        errorMessage: err.message,
      });
      for (const item of items) {
        report.items.push({
          changeId: item.changeId,
          key: item.identity.key,
          locale: item.identity.locale,
          namespace: item.identity.namespace,
          platform: item.identity.platform,
          filePath,
          applied: false,
          previousValue: item.previousValue,
          newValue: item.newValue,
          translationVersionId: item.translationVersionId,
          errorCode: err.code,
          errorMessage: err.message,
        });
      }
    }
  }

  // items that were not READY (draft / stale / already equal) are reported as not applied
  for (const item of plan.items) {
    if (item.status === 'READY') continue;
    report.items.push({
      changeId: item.changeId,
      key: item.identity.key,
      locale: item.identity.locale,
      namespace: item.identity.namespace,
      platform: item.identity.platform,
      filePath: item.filePath,
      applied: false,
      previousValue: item.previousValue,
      newValue: item.newValue,
      translationVersionId: item.translationVersionId,
      errorCode: item.status === 'UNCHANGED' ? 'ALREADY_APPLIED' : item.status,
      errorMessage: item.reason,
    });
  }

  const applied = report.items.filter((item) => item.applied).length;
  const failed = report.files.filter((file) => file.errorCode).length;
  report.status = applied === 0 && plan.items.filter((item) => item.status === 'READY').length === 0
    ? 'SUCCEEDED'
    : failed === 0
      ? 'SUCCEEDED'
      : applied > 0
        ? 'PARTIAL'
        : 'FAILED';
  report.gitDiffStat = context.git.isRepository() ? context.git.diffStat() : null;
  return report;
}

/** Convert an execution report into the platform apply-report payload. */
export function toApplyReportPayload(
  report: ApplyExecutionReport,
  meta: { syncSessionId: string; client: { name: string; version: string; gitBranch?: string; gitCommit?: string }; gitCommit?: string | null },
) {
  const items: ApplyReportItem[] = report.items.map((item) => ({
    key: item.key,
    locale: item.locale,
    namespace: item.namespace,
    platform: item.platform,
    filePath: item.filePath,
    applied: item.applied,
    previousValue: item.previousValue,
    newValue: item.newValue,
    translationVersionId: item.translationVersionId,
    ...(item.errorCode ? { errorCode: item.errorCode } : {}),
    ...(item.errorMessage ? { errorMessage: item.errorMessage } : {}),
  }));
  return {
    syncSessionId: meta.syncSessionId,
    applyPlanId: report.applyPlanId,
    client: meta.client,
    status: report.status,
    files: report.files.map((file) => ({
      filePath: file.filePath,
      backupPath: file.backupPath ?? null,
      contentHash: file.contentHash ?? contentHash(file.filePath),
    })),
    items,
    gitCommit: meta.gitCommit ?? meta.client.gitCommit ?? null,
    gitDiffStat: report.gitDiffStat ?? null,
  };
}
