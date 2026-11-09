import {
  ErrorCode,
  LocaleHubError,
  contentHash,
  hashObject,
  shortId,
  type PlatformName,
  type ReviewStatus,
  type SyncIdentity,
} from '@localehub/contracts';

export const DEFAULT_APPLY_PLAN_TTL_SECONDS = 30 * 60;

export interface ApplyChangeInput {
  changeId: string;
  identity: SyncIdentity;
  fileId: string;
  filePath: string;
  /** value observed locally at preview time; must still match when applying */
  previousValue: string | null;
  newValue: string;
  translationVersionId: string | null;
  sourceVersionId?: string | null;
  reviewStatus: ReviewStatus;
  remoteRevision: number;
  /** true when the remote change is an archive / removal */
  archived?: boolean;
}

export type ApplyItemStatus = 'READY' | 'STALE_LOCAL_VALUE' | 'MISSING_LOCAL_ENTRY' | 'NOT_APPROVED' | 'NO_LOCAL_FILE' | 'UNCHANGED';

export interface ApplyPlanItem extends ApplyChangeInput {
  status: ApplyItemStatus;
  reason: string;
}

export interface ApplyPlanFile {
  fileId: string;
  filePath: string;
  changeIds: string[];
  changeCount: number;
}

export interface ApplyPlan {
  applyPlanId: string;
  planHash: string;
  projectId: string;
  createdAt: string;
  expiresAt: string;
  items: ApplyPlanItem[];
  files: ApplyPlanFile[];
  summary: {
    total: number;
    ready: number;
    blocked: number;
    filesAffected: number;
    byStatus: Record<string, number>;
  };
  /** every file that will be touched must be inside the write allowlist */
  requiresConfirmation: true;
}

export interface CurrentLocalEntry {
  value: string | null;
  fileId: string;
  filePath: string;
}

export function localEntryKey(identity: Pick<SyncIdentity, 'platform' | 'namespace' | 'key' | 'locale'>): string {
  return [identity.platform, identity.namespace || '', identity.key, identity.locale].join('\u0001');
}

export interface BuildApplyPlanOptions {
  projectId: string;
  changes: ApplyChangeInput[];
  /** fresh scan result, keyed by localEntryKey() */
  currentLocal: Map<string, CurrentLocalEntry>;
  /** file ids that are allowed to be written (files mapping ∩ allowWrite) */
  writableFileIds?: Set<string>;
  includeDrafts?: boolean;
  ttlSeconds?: number;
  now?: Date;
}

/**
 * Spec §6.3 preview_apply / §10.3 — the plan records the *previous* local value for every
 * key so that `apply_translation_updates` can refuse to run when the file changed in between.
 */
export function buildApplyPlan(options: BuildApplyPlanOptions): ApplyPlan {
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlSeconds ?? DEFAULT_APPLY_PLAN_TTL_SECONDS) * 1000).toISOString();

  const items: ApplyPlanItem[] = options.changes
    .map((change) => {
      const key = localEntryKey(change.identity);
      const current = options.currentLocal.get(key);
      const approved = change.reviewStatus === 'APPROVED';
      if (!approved && !options.includeDrafts) {
        return { ...change, status: 'NOT_APPROVED' as ApplyItemStatus, reason: 'Remote value is not APPROVED' };
      }
      if (options.writableFileIds && !options.writableFileIds.has(change.fileId)) {
        return { ...change, status: 'NO_LOCAL_FILE' as ApplyItemStatus, reason: `File mapping ${change.fileId} is not writable` };
      }
      if (!current) {
        return { ...change, status: 'MISSING_LOCAL_ENTRY' as ApplyItemStatus, reason: 'Key does not exist in the current local scan' };
      }
      if (current.value === change.newValue) {
        return { ...change, status: 'UNCHANGED' as ApplyItemStatus, reason: 'Local file already contains this value' };
      }
      if (current.value !== change.previousValue) {
        return {
          ...change,
          status: 'STALE_LOCAL_VALUE' as ApplyItemStatus,
          reason: `Local value changed after preview (expected ${shortHash(change.previousValue)}, found ${shortHash(current.value)})`,
        };
      }
      return { ...change, status: 'READY' as ApplyItemStatus, reason: 'Ready to apply' };
    })
    .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.identity.key.localeCompare(b.identity.key));

  const fileMap = new Map<string, ApplyPlanFile>();
  for (const item of items) {
    if (item.status !== 'READY' && item.status !== 'UNCHANGED') continue;
    const existing = fileMap.get(item.filePath);
    if (existing) {
      existing.changeIds.push(item.changeId);
      existing.changeCount += 1;
    } else {
      fileMap.set(item.filePath, {
        fileId: item.fileId,
        filePath: item.filePath,
        changeIds: [item.changeId],
        changeCount: 1,
      });
    }
  }

  const byStatus: Record<string, number> = {};
  for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  const ready = items.filter((i) => i.status === 'READY').length;

  const hashPayload = {
    projectId: options.projectId,
    items: items.map((i) => ({
      changeId: i.changeId,
      key: i.identity.key,
      locale: i.identity.locale,
      platform: i.identity.platform,
      namespace: i.identity.namespace,
      filePath: i.filePath,
      previousValue: i.previousValue,
      newValue: i.newValue,
      status: i.status,
    })),
  };

  return {
    applyPlanId: shortId('apply', hashObject(hashPayload)),
    planHash: hashObject(hashPayload),
    projectId: options.projectId,
    createdAt: now.toISOString(),
    expiresAt,
    items,
    files: [...fileMap.values()].sort((a, b) => a.filePath.localeCompare(b.filePath)),
    summary: {
      total: items.length,
      ready,
      blocked: items.length - ready,
      filesAffected: fileMap.size,
      byStatus,
    },
    requiresConfirmation: true,
  };
}

function shortHash(value: string | null): string {
  if (value === null) return '<absent>';
  return `${contentHash(value).slice(0, 10)}…`;
}

/** Apply-time re-verification (spec §6.3: reject a stale plan, never overwrite silently). */
export function assertApplyPlanUsable(plan: ApplyPlan, now: Date = new Date()): void {
  if (new Date(plan.expiresAt).getTime() <= now.getTime()) {
    throw new LocaleHubError(ErrorCode.SYNC_PLAN_EXPIRED, `Apply plan ${plan.applyPlanId} expired at ${plan.expiresAt}`, 409);
  }
}

export interface ApplyVerificationResult {
  ok: boolean;
  stale: ApplyPlanItem[];
  missing: ApplyPlanItem[];
}

/**
 * Re-verify every READY item against a fresh scan before writing anything.
 * `requireCleanWorktree=false` still performs this per-key check (spec §6.3).
 */
export function verifyApplyPlan(plan: ApplyPlan, currentLocal: Map<string, CurrentLocalEntry>): ApplyVerificationResult {
  const stale: ApplyPlanItem[] = [];
  const missing: ApplyPlanItem[] = [];
  for (const item of plan.items) {
    if (item.status !== 'READY') continue;
    const current = currentLocal.get(localEntryKey(item.identity));
    if (!current) {
      missing.push(item);
      continue;
    }
    if (current.value !== item.previousValue) stale.push(item);
  }
  return { ok: stale.length === 0 && missing.length === 0, stale, missing };
}

export interface ApplyFileResult {
  filePath: string;
  fileId: string;
  appliedChangeIds: string[];
  backupPath?: string | null;
  contentHash?: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface ApplyExecutionReport {
  applyPlanId: string;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  files: ApplyFileResult[];
  items: {
    changeId: string;
    key: string;
    locale: string;
    namespace: string;
    platform: PlatformName;
    filePath: string;
    applied: boolean;
    previousValue: string | null;
    newValue: string;
    translationVersionId: string | null;
    errorCode?: string;
    errorMessage?: string;
  }[];
  gitDiffStat?: string | null;
}
