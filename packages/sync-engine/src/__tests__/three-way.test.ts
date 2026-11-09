import { describe, expect, it } from 'vitest';
import { contentHash, type ComparableEntry, type RemoteEntrySnapshot, type SyncBaselineSnapshot } from '@localehub/contracts';
import { computeSyncDiff } from '../diff';
import { buildSyncPlan, summarize } from '../plan';

const PROJECT = 'prj_test';

function identity(key: string, locale = 'ja-JP') {
  return { projectId: PROJECT, platform: 'web' as const, namespace: 'common', key, locale };
}

function local(key: string, value: string | null, locale = 'ja-JP') {
  return {
    ...identity(key, locale),
    value,
    contentHash: value === null ? null : contentHash(value),
    fileId: 'web-ja',
    filePath: `apps/web/src/locales/${locale}/common.json`,
  };
}

function remote(
  key: string,
  value: string | null,
  options: { status?: RemoteEntrySnapshot['reviewStatus']; locale?: string; sourceVersionId?: string | null; archived?: boolean } = {},
): RemoteEntrySnapshot {
  return {
    ...identity(key, options.locale ?? 'ja-JP'),
    value,
    contentHash: value === null ? null : contentHash(value),
    entryId: `entry_${key}`,
    translationVersionId: value === null ? null : `tv_${key}`,
    sourceVersionId: options.sourceVersionId ?? 'sv_1',
    sourceContentHash: null,
    reviewStatus: options.status ?? 'APPROVED',
    revision: 3,
    archived: options.archived ?? false,
    updatedBy: 'user_1',
    updatedAt: new Date('2026-11-09T00:00:00Z').toISOString(),
    applyEligible: (options.status ?? 'APPROVED') === 'APPROVED',
  };
}

function baseline(key: string, value: string | null, options: { locale?: string; sourceVersionId?: string | null } = {}): SyncBaselineSnapshot {
  return {
    ...identity(key, options.locale ?? 'ja-JP'),
    localHash: value === null ? null : contentHash(value),
    remoteHash: value === null ? null : contentHash(value),
    baseValue: value,
    remoteVersionId: value === null ? null : `tv_${key}`,
    sourceVersionId: options.sourceVersionId ?? 'sv_1',
    remoteRevision: 2,
  };
}

function entry(params: {
  key?: string;
  local?: ReturnType<typeof local> | null;
  remote?: RemoteEntrySnapshot | null;
  baseline?: SyncBaselineSnapshot | null;
}): ComparableEntry {
  return {
    identity: identity(params.key ?? 'checkout.pay_now'),
    local: params.local ?? null,
    remote: params.remote ?? null,
    baseline: params.baseline ?? null,
  };
}

describe('three-way comparison (spec §7.2)', () => {
  it('skips when neither side changed', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'A'), remote: remote('k', 'A'), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('SKIP');
  });

  it('pushes when only the local side changed', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'B'), remote: remote('k', 'A'), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('PUSH_LOCAL');
    expect(diff.local.changed).toBe(true);
    expect(diff.remote.changed).toBe(false);
  });

  it('pulls when only the platform side changed', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'A'), remote: remote('k', 'B'), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('PULL_REMOTE');
    expect(diff.remoteApplyEligible).toBe(true);
  });

  it('converges when both sides changed to the same value', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'C'), remote: remote('k', 'C'), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('CONVERGED');
  });

  it('conflicts when both sides changed differently (never silently overwrite)', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'B'), remote: remote('k', 'C'), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('CONFLICT');
    expect(diff.conflictReason).toBe('LOCAL_AND_REMOTE_CHANGED');
    expect(diff.baseValue).toBe('A');
    expect(diff.localValue).toBe('B');
    expect(diff.remoteValue).toBe('C');
  });

  it('creates a push_new action for a brand new local key', () => {
    const diff = computeSyncDiff(entry({ local: local('new.key', 'Hello'), remote: null, baseline: null }));
    expect(diff.action).toBe('PUSH_NEW');
  });

  it('creates a pull_new action for a brand new platform key', () => {
    const diff = computeSyncDiff(entry({ local: null, remote: remote('new.key', 'Hello'), baseline: null }));
    expect(diff.action).toBe('PULL_NEW');
  });

  it('marks a locally deleted key as archive candidate instead of deleting it', () => {
    const diff = computeSyncDiff(entry({ local: local('k', null), remote: remote('k', 'A'), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('ARCHIVE_CANDIDATE');
  });

  it('marks a platform archived key as remote archive candidate', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'A'), remote: remote('k', null), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('REMOTE_ARCHIVE_CANDIDATE');
  });

  it('converges when both sides deleted the key', () => {
    const diff = computeSyncDiff(entry({ local: local('k', null), remote: remote('k', null), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('ARCHIVE_CONVERGED');
  });

  it('never applies a draft translation by default (scenario D)', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'A'), remote: remote('k', 'B', { status: 'DRAFT' }), baseline: baseline('k', 'A') }));
    expect(diff.action).toBe('PULL_REMOTE');
    expect(diff.remoteApplyEligible).toBe(false);
  });

  it('can include drafts when explicitly requested', () => {
    const diff = computeSyncDiff(
      entry({ local: local('k', 'A'), remote: remote('k', 'B', { status: 'DRAFT' }), baseline: baseline('k', 'A') }),
      { includeDrafts: true },
    );
    expect(diff.remoteApplyEligible).toBe(true);
  });

  it('conflicts when the remote translation is based on an outdated source version', () => {
    const diff = computeSyncDiff(
      entry({ local: local('k', 'A'), remote: remote('k', 'B', { status: 'STALE' }), baseline: baseline('k', 'A') }),
    );
    expect(diff.action).toBe('CONFLICT');
    expect(diff.conflictReason).toBe('SOURCE_VERSION_CHANGED');
  });

  it('treats identical un-synced values as converged, not as a conflict', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'A'), remote: remote('k', 'A'), baseline: null }));
    expect(diff.action).toBe('CONVERGED');
  });

  it('treats different un-synced values as a conflict', () => {
    const diff = computeSyncDiff(entry({ local: local('k', 'A'), remote: remote('k', 'B'), baseline: null }));
    expect(diff.action).toBe('CONFLICT');
  });
});

describe('plan building', () => {
  const entries: ComparableEntry[] = [
    entry({ key: 'b.key', local: local('b.key', 'new'), remote: null, baseline: null }),
    entry({ key: 'a.key', local: local('a.key', 'B'), remote: remote('a.key', 'A'), baseline: baseline('a.key', 'A') }),
    entry({ key: 'c.key', local: local('c.key', 'A'), remote: remote('c.key', 'A'), baseline: baseline('c.key', 'A') }),
  ];

  const options = {
    projectId: PROJECT,
    repositoryConnectionId: 'conn_1',
    scanId: 'scan_1',
    direction: 'bidirectional' as const,
    baseRevision: 4,
  };

  it('produces a deterministic hash independent of input order', () => {
    const forward = buildSyncPlan(entries, options);
    const reversed = buildSyncPlan([...entries].reverse(), options);
    expect(forward.planHash).toBe(reversed.planHash);
  });

  it('changes the hash when a value changes', () => {
    const changed = buildSyncPlan(
      [entry({ key: 'a.key', local: local('a.key', 'CHANGED'), remote: remote('a.key', 'A'), baseline: baseline('a.key', 'A') }), ...entries.slice(1)],
      options,
    );
    expect(changed.planHash).not.toBe(buildSyncPlan(entries, options).planHash);
  });

  it('summarises actions', () => {
    const { payload } = buildSyncPlan(entries, options);
    expect(payload.summary.pushNew).toBe(1);
    expect(payload.summary.pushUpdated).toBe(1);
    expect(payload.summary.unchanged).toBe(1);
    expect(summarize(payload.items)).toEqual(payload.summary);
  });

  it('gives every item a stable change id', () => {
    const first = buildSyncPlan(entries, options).payload.items.map((i) => i.changeId);
    const second = buildSyncPlan(entries, options).payload.items.map((i) => i.changeId);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });
});
