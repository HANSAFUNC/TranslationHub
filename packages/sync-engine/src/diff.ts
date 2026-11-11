import type { ComparableEntry, ConflictReason, DiffSide, SyncAction, SyncDiff, SyncIdentity } from '@localehub/contracts';
import { contentHash } from '@localehub/contracts';

export interface DiffOptions {
  /** allow DRAFT / PENDING_REVIEW remote values to be pulled (must be explicitly requested) */
  includeDrafts?: boolean;
  /** project policy: allow applying remote translations whose source changed (default false) */
  allowStaleTranslations?: boolean;
  /** treat a missing remote side as "not yet synced" instead of "deleted" */
  remoteArchiveMeansDeleted?: boolean;
}

export type Presence = 'absent' | 'present';

export interface SideState {
  value: string | null;
  hash: string | null;
  present: boolean;
}

function localState(entry: ComparableEntry): SideState {
  const local = entry.local;
  if (!local || local.value === null) return { value: null, hash: null, present: false };
  return { value: local.value, hash: local.contentHash ?? contentHash(local.value), present: true };
}

function remoteState(entry: ComparableEntry): SideState {
  const remote = entry.remote;
  if (!remote || remote.value === null || remote.archived) return { value: null, hash: null, present: false };
  return { value: remote.value, hash: remote.contentHash ?? contentHash(remote.value), present: true };
}

function baseState(entry: ComparableEntry): SideState {
  const baseline = entry.baseline;
  if (!baseline || baseline.localHash === null && baseline.remoteHash === null) {
    return { value: null, hash: null, present: false };
  }
  return {
    value: baseline.baseValue ?? null,
    hash: baseline.localHash ?? baseline.remoteHash,
    present: Boolean(baseline.localHash ?? baseline.remoteHash),
  };
}

/**
 * Did this entry move to a different file since the baseline was recorded?
 *
 * Only meaningful when both sides are known: a baseline without a `localFileId` predates the
 * column, and treating "unknown" as "changed" would report a mapping change for every entry of
 * every project that has not been pushed since.
 */
function localFileChanged(entry: ComparableEntry): boolean {
  const current = entry.local?.fileId;
  const recorded = entry.baseline?.localFileId;
  if (!current || !recorded) return false;
  return current !== recorded;
}

function side(state: SideState, base: SideState): DiffSide {
  return {
    value: state.value,
    contentHash: state.hash,
    present: state.present,
    changed: state.hash !== base.hash || state.present !== base.present,
  };
}

/**
 * Three-way comparison per spec §7.2.
 *
 * B = last synced baseline, L = local file value, R = platform value.
 * The function is pure: identical inputs always produce the same action so that
 * the preview plan and the server side recomputation agree (plan_hash integrity).
 */
export function computeSyncDiff(entry: ComparableEntry, options: DiffOptions = {}): SyncDiff {
  const L = localState(entry);
  const R = remoteState(entry);
  const B = baseState(entry);

  const localChanged = L.present !== B.present || L.hash !== B.hash;
  const remoteChanged = R.present !== B.present || R.hash !== B.hash;
  const sameValue = L.present && R.present && L.hash === R.hash;

  const remote = entry.remote;
  const reviewStatus = remote?.reviewStatus ?? null;
  const remoteApproved =
    reviewStatus === 'APPROVED' || (options.includeDrafts === true && (reviewStatus === 'DRAFT' || reviewStatus === 'PENDING_REVIEW'));
  const remoteStale = reviewStatus === 'STALE';
  const remoteApplyEligible = R.present && remoteApproved && (!remoteStale || options.allowStaleTranslations === true);

  const diffBase: Omit<SyncDiff, 'action' | 'reason'> = {
    base: side(B, B),
    local: side(L, B),
    remote: side(R, B),
    remoteApplyEligible,
    localPushEligible: L.present && !remoteStale,
    entryId: remote?.entryId ?? null,
    translationVersionId: remote?.translationVersionId ?? null,
    sourceVersionId: remote?.sourceVersionId ?? null,
    reviewStatus,
    remoteRevision: remote?.revision ?? null,
    fileId: entry.local?.fileId ?? null,
    filePath: entry.local?.filePath ?? null,
    localValue: L.value,
    remoteValue: R.value,
    baseValue: B.value,
  };

  const build = (action: SyncAction, reason: string, conflictReason?: ConflictReason): SyncDiff => ({
    ...diffBase,
    action,
    reason,
    conflictReason,
  });

  // ---- both sides absent -------------------------------------------------------
  if (!L.present && !R.present) {
    if (!B.present) return build('SKIP', 'NOT_PRESENT_ON_EITHER_SIDE');
    return build('ARCHIVE_CONVERGED', 'DELETED_ON_BOTH_SIDES');
  }

  // ---- only local present: the platform side no longer has the entry -------------
  if (L.present && !R.present) {
    if (!B.present) return build('PUSH_NEW', 'NEW_LOCAL_KEY');
    if (!localChanged) return build('REMOTE_ARCHIVE_CANDIDATE', 'REMOTE_DELETED_LOCAL_UNCHANGED');
    return build('CONFLICT', 'LOCAL_UPDATED_BUT_REMOTE_DELETED', 'LOCAL_DELETED_REMOTE_CHANGED');
  }

  // ---- only remote present: the local file no longer has the entry ---------------
  if (!L.present && R.present) {
    if (!B.present) return build('PULL_NEW', 'NEW_REMOTE_KEY');
    if (!remoteChanged) return build('ARCHIVE_CANDIDATE', 'LOCAL_DELETED_REMOTE_UNCHANGED');
    return build('CONFLICT', 'LOCAL_DELETED_BUT_REMOTE_CHANGED', 'LOCAL_DELETED_REMOTE_CHANGED');
  }

  // ---- both present ------------------------------------------------------------
  if (sameValue) {
    if (localChanged && remoteChanged) return build('CONVERGED', 'BOTH_CHANGED_SAME_VALUE');
    if (!localChanged && !remoteChanged) return build('SKIP', 'UNCHANGED');
    // one side changed to the value the other already had
    if (localChanged && !remoteChanged) return build('CONVERGED', 'LOCAL_MATCHES_REMOTE');
    return build('CONVERGED', 'REMOTE_MATCHES_LOCAL');
  }

  if (localChanged && !remoteChanged) return build('PUSH_LOCAL', 'LOCAL_CHANGED_REMOTE_UNCHANGED');
  if (!localChanged && remoteChanged) {
    if (remoteStale && !options.allowStaleTranslations) {
      return build('CONFLICT', 'REMOTE_SOURCE_VERSION_CHANGED', 'SOURCE_VERSION_CHANGED');
    }
    return build('PULL_REMOTE', 'REMOTE_CHANGED_LOCAL_UNCHANGED');
  }

  // both changed, different values
  if (remoteStale && !options.allowStaleTranslations) {
    return build('CONFLICT', 'BOTH_CHANGED_AND_REMOTE_SOURCE_STALE', 'SOURCE_VERSION_CHANGED');
  }
  // A mapping edit moved the key to a different file since the baseline. Both sides did change,
  // but saying only that hides the part a reviewer has to decide about: writing the remote value
  // back would now land in a file the translation never lived in. Reported as its own reason so
  // the conflict list says which file moved, rather than a generic "both changed".
  if (localFileChanged(entry)) {
    return build('CONFLICT', 'LOCAL_FILE_MAPPING_CHANGED', 'FILE_MAPPING_CHANGED');
  }
  return build('CONFLICT', 'LOCAL_AND_REMOTE_CHANGED', 'LOCAL_AND_REMOTE_CHANGED');
}

/** Which actions the push endpoint may actually apply. */
export function isPushAction(action: SyncAction): boolean {
  return action === 'PUSH_LOCAL' || action === 'PUSH_NEW' || action === 'ARCHIVE_CANDIDATE';
}

/** Which actions let the local side write the remote value into a file. */
export function isPullAction(action: SyncAction): boolean {
  return action === 'PULL_REMOTE' || action === 'PULL_NEW';
}

/** Actions that advance the baseline without any content transfer. */
export function isConvergedAction(action: SyncAction): boolean {
  return action === 'CONVERGED' || action === 'ARCHIVE_CONVERGED' || action === 'SKIP';
}

export function identityOf(entry: ComparableEntry): SyncIdentity {
  return entry.identity;
}

export function describeIdentity(identity: SyncIdentity): string {
  return `${identity.platform}/${identity.locale}/${identity.namespace ? `${identity.namespace}:` : ''}${identity.key}`;
}
