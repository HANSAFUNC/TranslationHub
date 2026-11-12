import type { PlatformName } from './translation';

/** Spec §7 — actions produced by the three way comparison. */
export type SyncAction =
  | 'SKIP' // neither side changed
  | 'PUSH_LOCAL' // local changed, remote unchanged
  | 'PUSH_NEW' // key/locale exists only locally
  | 'PULL_REMOTE' // remote changed, local unchanged
  | 'PULL_NEW' // key/locale exists only on the platform
  | 'CONVERGED' // both changed to the same value
  | 'CONFLICT' // both changed to different values
  | 'ARCHIVE_CANDIDATE' // local deleted, remote unchanged
  | 'REMOTE_ARCHIVE_CANDIDATE' // remote archived/deleted
  | 'ARCHIVE_CONVERGED'; // both sides removed

export type ConflictReason =
  | 'LOCAL_AND_REMOTE_CHANGED'
  | 'SOURCE_VERSION_CHANGED'
  | 'FILE_MAPPING_CHANGED'
  | 'LOCAL_DELETED_REMOTE_CHANGED';

export type ConflictResolution = 'KEEP_LOCAL' | 'KEEP_REMOTE' | 'MANUAL_MERGE' | 'DEFER';

export interface SyncIdentity {
  projectId: string;
  platform: PlatformName;
  namespace: string;
  key: string;
  locale: string;
}

/** Local side of a comparison, produced by a CLI scan. */
export interface LocalEntrySnapshot extends SyncIdentity {
  value: string | null;
  contentHash: string | null;
  fileId: string;
  filePath: string;
  /** source language version hash the local translation is based on (optional) */
  basedOnSourceHash?: string | null;
  description?: string;
  context?: Record<string, unknown>;
  placeholders?: { name: string; type?: string; format?: string }[];
  platformMetadata?: Record<string, unknown>;
}

/** Remote side of a comparison, produced by the platform. */
export interface RemoteEntrySnapshot extends SyncIdentity {
  value: string | null;
  contentHash: string | null;
  entryId: string;
  translationVersionId: string | null;
  sourceVersionId: string | null;
  sourceContentHash: string | null;
  reviewStatus: ReviewStatus;
  revision: number;
  archived: boolean;
  /** human readable author of the current remote value */
  updatedBy?: string | null;
  updatedAt?: string | null;
  /** the review status the value must have to be applied locally */
  applyEligible?: boolean;
}

/** Baseline recorded at the last successful sync (spec §7.1). */
export interface SyncBaselineSnapshot extends SyncIdentity {
  localHash: string | null;
  remoteHash: string | null;
  /**
   * Which file the entry lived in when the baseline was recorded.
   *
   * Carried so the comparison can tell "the translation changed" from "the translation moved":
   * a mapping edit (`files[].paths` in `.localehub/config.yaml`) puts the same key in a different
   * file, and a write-back that silently targets the new file is not the change anybody asked for.
   */
  localFileId?: string | null;
  baseValue?: string | null;
  remoteVersionId?: string | null;
  sourceVersionId?: string | null;
  remoteRevision: number;
  lastSyncedAt?: string;
}

export const PROJECT_EVENT_TYPES = [
  'KEY_CREATED',
  'KEY_ARCHIVED',
  'SOURCE_VERSION_CREATED',
  'TRANSLATION_CREATED',
  'TRANSLATION_UPDATED',
  'TRANSLATION_SUBMITTED',
  'TRANSLATION_APPROVED',
  'TRANSLATION_REJECTED',
  'TRANSLATION_STALE',
  'SYNC_PUSHED',
  'SYNC_APPLIED',
  'CONFLICT_RESOLVED',
  'RELEASE_PUBLISHED',
] as const;
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];

export interface ProjectEventRecord {
  id: string;
  projectId: string;
  eventType: ProjectEventType;
  resourceType: string;
  resourceId: string | null;
  revision: number;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type QaSeverity = 'ERROR' | 'WARNING' | 'INFO';

export type ReviewStatus = 'DRAFT' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'STALE';

export interface ComparableEntry {
  identity: SyncIdentity;
  local: LocalEntrySnapshot | null;
  remote: RemoteEntrySnapshot | null;
  baseline: SyncBaselineSnapshot | null;
}

export interface DiffSide {
  value: string | null;
  contentHash: string | null;
  present: boolean;
  changed: boolean;
}

export interface SyncDiff {
  action: SyncAction;
  reason: string;
  conflictReason?: ConflictReason;
  base: DiffSide;
  local: DiffSide;
  remote: DiffSide;
  /** true when the remote value may be written into a local file by default */
  remoteApplyEligible: boolean;
  /** true when the local value may be pushed to the platform */
  localPushEligible: boolean;
  entryId?: string | null;
  translationVersionId?: string | null;
  sourceVersionId?: string | null;
  reviewStatus?: ReviewStatus | null;
  remoteRevision?: number | null;
  fileId?: string | null;
  filePath?: string | null;
  localValue?: string | null;
  remoteValue?: string | null;
  baseValue?: string | null;
}

export interface SyncPlanSummary {
  pushNew: number;
  pushUpdated: number;
  pullApproved: number;
  pullDraft: number;
  unchanged: number;
  conflicts: number;
  archiveCandidates: number;
  converged: number;
}

export interface SyncPlanItem {
  changeId: string;
  identity: SyncIdentity;
  action: SyncAction;
  diff: SyncDiff;
}

export interface SyncPlanPayload {
  /** bumped when the plan shape changes; a client can never confirm an older shape */
  planVersion?: number;
  projectId: string;
  repositoryConnectionId: string | null;
  scanId: string;
  direction: 'bidirectional' | 'push' | 'pull';
  baseRevision: number;
  items: SyncPlanItem[];
  summary: SyncPlanSummary;
}

export interface SyncPushClientInfo {
  name: string;
  version: string;
  gitBranch?: string;
  gitCommit?: string;
}

export interface PushRequest {
  syncPlanId: string;
  confirmed: true;
  client?: SyncPushClientInfo;
  idempotencyKey?: string;
}

export interface PushChangeAccepted {
  changeId: string;
  key: string;
  locale: string;
  action: 'CREATED' | 'UPDATED' | 'ARCHIVED' | 'SKIPPED';
  translationVersionId?: string | null;
  sourceVersionId?: string | null;
  reason?: string;
}

export interface PushResult {
  syncSessionId: string;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  revision: number;
  accepted: PushChangeAccepted[];
  conflicts: { changeId: string; key: string; locale: string; reason: ConflictReason }[];
  failed: { changeId: string; key: string; locale: string; code: string; message: string }[];
  summary: { created: number; updated: number; archived: number; skipped: number; failed: number; conflicts: number };
  idempotentReplay: boolean;
}

export interface PlatformChange {
  entryId: string;
  key: string;
  locale: string;
  platform: PlatformName;
  namespace: string;
  content: string;
  contentHash: string;
  previousContent: string | null;
  translationVersionId: string;
  sourceVersionId: string | null;
  reviewStatus: ReviewStatus;
  remoteRevision: number;
  updatedAt: string;
  appliedToRepo: boolean;
  /** true when the change is an archive/removal */
  archived: boolean;
  fileHint?: string | null;
}

export interface ApplyReportItem {
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
}

/**
 * What an ingest added to a project that the project did not already have.
 *
 * Returned by a scan (and by the MCP import, including its dry run) because a repository is the
 * authority on which languages it holds: `zh-Hans.lproj` in the checkout, `zh-CN` on the platform.
 * Expansion that happens silently is indistinguishable from a typo creating a stray language.
 */
export interface ProjectShapeExpansion {
  /** Locales created because the project had no equivalent of them. */
  localesAdded: string[];
  /** Incoming tags matched to an existing code that means the same language. */
  localesMatched: { from: string; to: string }[];
  /** Platforms added to the project because content arrived for them. */
  platformsAdded: string[];
}

export interface ApplyReportRequest {
  syncSessionId: string;
  repositoryConnectionId?: string | null;
  applyPlanId: string;
  client: SyncPushClientInfo;
  files: { filePath: string; backupPath?: string | null; contentHash: string }[];
  items: ApplyReportItem[];
  gitCommit?: string | null;
  gitDiffStat?: string | null;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
}

export interface ConflictRecord {
  id: string;
  projectId: string;
  key: string;
  locale: string;
  platform: PlatformName;
  namespace: string;
  baseValue: string | null;
  localValue: string | null;
  remoteValue: string | null;
  baseHash: string | null;
  localHash: string | null;
  remoteHash: string | null;
  reason: ConflictReason;
  filePath: string | null;
  remoteVersionId: string | null;
  status: 'OPEN' | 'RESOLVED' | 'DEFERRED';
  resolution: ConflictResolution | null;
  resolvedValue?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  createdAt: string;
}

export interface SyncSessionSummaryRecord {
  id: string;
  projectId: string;
  repositoryConnectionId: string | null;
  direction: 'push' | 'pull' | 'bidirectional';
  status: 'PENDING' | 'RUNNING' | 'PARTIAL' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  baseRevision: number | null;
  revisionAfter: number | null;
  planHash: string | null;
  summary: Record<string, number> | null;
  createdAt: string;
  completedAt?: string | null;
}
