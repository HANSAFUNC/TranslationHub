import {
  hashObject,
  shortId,
  type ComparableEntry,
  type SyncPlanItem,
  type SyncPlanPayload,
  type SyncPlanSummary,
} from '@localehub/contracts';
import { computeSyncDiff, type DiffOptions } from './diff';

export const DEFAULT_PLAN_TTL_SECONDS = 30 * 60;

export interface BuildPlanOptions extends DiffOptions {
  planVersion?: number;
  projectId: string;
  repositoryConnectionId: string | null;
  scanId: string;
  direction: 'bidirectional' | 'push' | 'pull';
  baseRevision: number;
}

export interface BuiltPlan {
  payload: SyncPlanPayload;
  planHash: string;
}

/**
 * Deterministic ordering of plan items. The order is part of the plan hash, so it must not
 * depend on hash map iteration order or on the order the client uploaded entries in.
 */
export function sortEntries(entries: ComparableEntry[]): ComparableEntry[] {
  return [...entries].sort((a, b) => {
    const ia = a.identity;
    const ib = b.identity;
    return (
      ia.locale.localeCompare(ib.locale) ||
      ia.platform.localeCompare(ib.platform) ||
      ia.namespace.localeCompare(ib.namespace) ||
      ia.key.localeCompare(ib.key)
    );
  });
}

export function summarize(items: SyncPlanItem[]): SyncPlanSummary {
  const summary: SyncPlanSummary = {
    pushNew: 0,
    pushUpdated: 0,
    pullApproved: 0,
    pullDraft: 0,
    unchanged: 0,
    conflicts: 0,
    archiveCandidates: 0,
    converged: 0,
  };
  for (const item of items) {
    switch (item.action) {
      case 'PUSH_NEW':
        summary.pushNew += 1;
        break;
      case 'PUSH_LOCAL':
        summary.pushUpdated += 1;
        break;
      case 'PULL_NEW':
      case 'PULL_REMOTE':
        if (item.diff.remoteApplyEligible) summary.pullApproved += 1;
        else summary.pullDraft += 1;
        break;
      case 'CONFLICT':
        summary.conflicts += 1;
        break;
      case 'ARCHIVE_CANDIDATE':
      case 'REMOTE_ARCHIVE_CANDIDATE':
        summary.archiveCandidates += 1;
        break;
      case 'CONVERGED':
      case 'ARCHIVE_CONVERGED':
        summary.converged += 1;
        break;
      case 'SKIP':
      default:
        summary.unchanged += 1;
        break;
    }
  }
  return summary;
}

export function buildSyncPlan(entries: ComparableEntry[], options: BuildPlanOptions): BuiltPlan {
  const items: SyncPlanItem[] = sortEntries(entries).map((entry) => {
    const diff = computeSyncDiff(entry, options);
    const identityKey = [
      entry.identity.projectId,
      entry.identity.platform,
      entry.identity.namespace,
      entry.identity.key,
      entry.identity.locale,
    ].join('\u0001');
    return {
      changeId: shortId('chg', identityKey),
      identity: entry.identity,
      action: diff.action,
      diff,
    };
  });

  const payload: SyncPlanPayload = {
    planVersion: options.planVersion ?? 1,
    projectId: options.projectId,
    repositoryConnectionId: options.repositoryConnectionId,
    scanId: options.scanId,
    direction: options.direction,
    baseRevision: options.baseRevision,
    items,
    summary: summarize(items),
  };

  return { payload, planHash: hashObject(payload) };
}

/** The plan hash must cover every field the server will re-validate. */
export function computePlanHash(payload: SyncPlanPayload): string {
  return hashObject(payload);
}

export function isPlanExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}
