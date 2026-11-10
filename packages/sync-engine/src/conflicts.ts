import type { ConflictResolution, SyncDiff } from '@localehub/contracts';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';

export interface ConflictResolutionInput {
  resolution: ConflictResolution;
  /** required for MANUAL_MERGE */
  value?: string;
}

export interface ConflictResolutionOutcome {
  /** value that must become the shared truth on both sides */
  value: string | null;
  /** what to do locally */
  localAction: 'WRITE_VALUE' | 'KEEP' | 'DEFER';
  /** what to do on the platform */
  remoteAction: 'WRITE_VALUE' | 'KEEP' | 'DEFER';
  /** true when the resolved value must be recorded as a new translation version */
  createsNewVersion: boolean;
}

/**
 * Spec §7.3 — conflict resolution never rewrites history, it produces a new version
 * and a new baseline. This helper keeps the CLI and the platform UI consistent.
 */
export function resolveConflictValue(diff: SyncDiff, input: ConflictResolutionInput): ConflictResolutionOutcome {
  switch (input.resolution) {
    case 'KEEP_LOCAL': {
      if (diff.localValue === null) {
        throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'KEEP_LOCAL is not possible: the local side has no value', 400);
      }
      return { value: diff.localValue ?? null, localAction: 'KEEP', remoteAction: 'WRITE_VALUE', createsNewVersion: true };
    }
    case 'KEEP_REMOTE': {
      if (diff.remoteValue === null) {
        throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'KEEP_REMOTE is not possible: the platform side has no value', 400);
      }
      return { value: diff.remoteValue ?? null, localAction: 'WRITE_VALUE', remoteAction: 'KEEP', createsNewVersion: false };
    }
    case 'MANUAL_MERGE': {
      if (typeof input.value !== 'string') {
        throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'MANUAL_MERGE requires an explicit value', 400);
      }
      return { value: input.value, localAction: 'WRITE_VALUE', remoteAction: 'WRITE_VALUE', createsNewVersion: true };
    }
    case 'DEFER':
      return { value: null, localAction: 'DEFER', remoteAction: 'DEFER', createsNewVersion: false };
    default:
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `Unsupported resolution: ${String(input.resolution)}`, 400);
  }
}

/** A conflict may only be resolved once (spec: no silent overwrite of a decision). */
export function assertConflictOpen(status: string): void {
  if (status !== 'OPEN' && status !== 'DEFERRED') {
    throw new LocaleHubError(ErrorCode.CONFLICT_ALREADY_RESOLVED, `Conflict is already ${status}`, 409);
  }
}
