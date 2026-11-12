import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ErrorCode,
  LocaleHubError,
  contentHash,
  type ApplyReportRequest,
  type ConflictRecord,
  type ConflictResolution,
  type LocalEntrySnapshot,
  type PlatformChange,
  type PlatformName,
  type ProjectShapeExpansion,
  type PushChangeAccepted,
  type PushResult,
  type RemoteEntrySnapshot,
  type ReviewStatus,
  type ScanBatchPayload,
  type SyncBaselineSnapshot,
  type SyncDiff,
  type SyncPlanPayload,
  type SyncPushClientInfo,
  type SyncSessionSummaryRecord,
} from '@localehub/contracts';
import { buildSyncPlan, computeSyncDiff, isPushAction, resolveConflictValue, type BuiltPlan } from '@localehub/sync-engine';
import { TenantPrisma } from '@localehub/database';
import { localeDisplayName, resolveLocaleTag } from '@localehub/contracts';
import { emitProjectEvent, getProjectRevision } from './events';
import {
  ensureTranslationKey,
  markTranslationsStale,
  upsertSourceVersion,
  upsertTranslation,
} from './translation-core';

export interface SyncActor {
  userId: string;
  organizationId: string;
  mcpClientId?: string;
  actorType?: 'user' | 'mcp' | 'system';
}

export interface MarkAppliedItem {
  key: string;
  locale: string;
  platform: PlatformName;
  /** Where the agent wrote it. Optional: the platform never sees the file, so this is a label. */
  filePath?: string | null;
  /**
   * The version the agent wrote, as `get_pending_platform_changes` reported it. Required for the
   * staleness check to mean anything; omitting it is allowed but gives up the guarantee.
   */
  translationVersionId?: string | null;
}

/** Why one item was not marked. Reported rather than thrown, so a partial apply stays partial. */
export type MarkAppliedSkipReason = 'NOT_FOUND' | 'ALREADY_APPLIED' | 'DRAFT_NOT_ALLOWED' | 'VERSION_SUPERSEDED';

export interface MarkAppliedSkip {
  key: string;
  locale: string;
  platform: string;
  reason: MarkAppliedSkipReason;
}

export interface MarkAppliedResult {
  dryRun: boolean;
  projectId: string;
  /** Null when nothing was written: a no-op must not invent a sync session. */
  sessionId: string | null;
  revision: number;
  baselineUpdated: number;
  applied: { key: string; locale: string; platform: string; filePath: string | null; translationVersionId: string | null }[];
  skipped: MarkAppliedSkip[];
}

export interface RemoteSnapshotOptions {
  locales?: string[];
  /** include archived keys so deletions are detectable */
  includeArchived?: boolean;
}

/** Bump when the plan payload shape changes, so old plans can never be replayed. */
export const SYNC_PLAN_VERSION = 1;

export function identityKey(parts: {
  platform: string;
  namespace: string;
  key: string;
  locale: string;
}): string {
  return [parts.platform, parts.namespace || '', parts.key, parts.locale].join('\u0001');
}

/** Local scans may carry a description for a brand new key; use it when creating the key. */
function entryDescription(item: { diff: SyncDiff }): string | undefined {
  const candidate = item.diff as SyncDiff & { description?: string };
  return typeof candidate.description === 'string' && candidate.description.length ? candidate.description : undefined;
}

export class SyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tenant: TenantPrisma = new TenantPrisma(prisma),
  ) {}

  /* ------------------------------------------------------------ connections */

  async ensureConnection(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      projectId: string;
      connectionId?: string | null;
      name?: string;
      client?: SyncPushClientInfo;
    },
  ): Promise<string> {
    if (params.connectionId) {
      const found = await tx.repositoryConnection.findUnique({ where: { id: params.connectionId }, select: { id: true } });
      if (!found) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Repository connection ${params.connectionId} not found`, 404);
      if (params.client) {
        await tx.repositoryConnection.update({
          where: { id: found.id },
          data: {
            lastSeenAt: new Date(),
            clientName: params.client.name,
            clientVersion: params.client.version,
            lastBranch: params.client.gitBranch ?? null,
            lastCommit: params.client.gitCommit ?? null,
          },
        });
      }
      return found.id;
    }
    const name = params.name ?? 'default';
    const existing = await tx.repositoryConnection.findUnique({
      where: { projectId_name: { projectId: params.projectId, name } },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await tx.repositoryConnection.create({
      data: {
        organizationId: params.organizationId,
        projectId: params.projectId,
        name,
        provider: 'local',
        lastSeenAt: new Date(),
        clientName: params.client?.name ?? null,
        clientVersion: params.client?.version ?? null,
        lastBranch: params.client?.gitBranch ?? null,
        lastCommit: params.client?.gitCommit ?? null,
      },
      select: { id: true },
    });
    return created.id;
  }

  /* ------------------------------------------------------------------ scans */

  async recordScan(
    projectId: string,
    payload: ScanBatchPayload,
    actor: SyncActor,
  ): Promise<{ scanId: string; connectionId: string; entryCount: number; fileCount: number; expansion: ProjectShapeExpansion }> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, sourceLocale: true } });
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`, 404);

      // A repository is the authority on which languages it holds, so an unknown one is added
      // rather than refused — and an equivalent one is matched rather than duplicated. Everything
      // downstream (the scan record, the baselines, future pushes) then works in project terms.
      const { expansion, resolve } = await this.expandProjectShape(tx, {
        organizationId: actor.organizationId,
        projectId,
        sourceLocale: project.sourceLocale,
        locales: [...payload.files.map((file) => file.locale), ...payload.entries.map((entry) => entry.locale)],
        platforms: payload.files.map((file) => file.platform),
        dryRun: false,
      });
      const files = payload.files.map((file) => ({ ...file, locale: resolve(file.locale) }));
      const entries = payload.entries.map((entry) => ({ ...entry, locale: resolve(entry.locale) }));

      const connectionId = await this.ensureConnection(tx, {
        organizationId: actor.organizationId,
        projectId,
        connectionId: payload.repositoryConnectionId ?? null,
        client: payload.client,
      });

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await tx.syncScan.upsert({
        where: { scanId: payload.scanId },
        create: {
          organizationId: actor.organizationId,
          projectId,
          connectionId,
          scanId: payload.scanId,
          clientName: payload.client?.name ?? null,
          clientVersion: payload.client?.version ?? null,
          gitBranch: payload.client?.gitBranch ?? null,
          gitCommit: payload.client?.gitCommit ?? null,
          fileCount: files.length,
          entryCount: entries.length,
          files: files as unknown as Prisma.InputJsonValue,
          entries: entries as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
        update: {
          connectionId,
          fileCount: files.length,
          entryCount: entries.length,
          files: files as unknown as Prisma.InputJsonValue,
          entries: entries as unknown as Prisma.InputJsonValue,
          gitBranch: payload.client?.gitBranch ?? null,
          gitCommit: payload.client?.gitCommit ?? null,
          expiresAt,
        },
      });

      // keep the file mapping registry in sync with what the client actually scanned
      for (const file of files) {
        await tx.repositoryFileMapping.upsert({
          where: { connectionId_fileSetId: { connectionId, fileSetId: file.fileId } },
          create: {
            organizationId: actor.organizationId,
            connectionId,
            fileSetId: file.fileId,
            platform: file.platform,
            locale: file.locale,
            format: file.format,
            paths: [file.filePath],
            lastScannedAt: new Date(),
          },
          update: { platform: file.platform, locale: file.locale, format: file.format, lastScannedAt: new Date() },
        });
      }

      return { scanId: payload.scanId, connectionId, entryCount: entries.length, fileCount: files.length, expansion };
    });
  }

  /* --------------------------------------------------------------- preview */

  async createPreview(
    params: {
      projectId: string;
      connectionId: string;
      scanId: string;
      direction: 'bidirectional' | 'push' | 'pull';
      baseRevision?: number;
      includeDeletes: boolean;
      includeDrafts: boolean;
      locales?: string[];
    },
    actor: SyncActor,
  ): Promise<{ plan: SyncPlanPayload; planHash: string; expiresAt: string; sessionId: string; conflicts: number; planId: string }> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const scan = await tx.syncScan.findUnique({ where: { scanId: params.scanId } });
      if (!scan) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Scan ${params.scanId} not found`, 404);
      if (scan.expiresAt.getTime() < Date.now()) {
        throw new LocaleHubError(ErrorCode.SYNC_PLAN_EXPIRED, `Scan ${params.scanId} expired`, 409);
      }

      const revision = await getProjectRevision(tx, params.projectId);
      const localEntries = this.parseScanEntries(scan.entries);
      const localeFilter = params.locales?.length ? new Set(params.locales) : null;

      const localMap = new Map<string, LocalEntrySnapshot>();
      for (const entry of localEntries) {
        if (localeFilter && !localeFilter.has(entry.locale)) continue;
        localMap.set(identityKey(entry), entry);
      }

      const remoteMap = await this.loadRemoteSnapshots(tx, {
        projectId: params.projectId,
        locales: localeFilter ? [...localeFilter] : undefined,
      });

      const baselines = await tx.syncBaseline.findMany({ where: { connectionId: params.connectionId } });
      const baselineMap = new Map<string, SyncBaselineSnapshot>();
      for (const baseline of baselines) {
        baselineMap.set(
          identityKey({ platform: baseline.platform, namespace: baseline.namespace, key: baseline.translationKey, locale: baseline.localeCode }),
          {
            projectId: params.projectId,
            platform: baseline.platform,
            namespace: baseline.namespace,
            key: baseline.translationKey,
            locale: baseline.localeCode,
            localHash: baseline.localHash,
            remoteHash: baseline.remoteHash,
            localFileId: baseline.localFileId,
            baseValue: baseline.baseValue,
            remoteVersionId: baseline.translationVersionId,
            sourceVersionId: baseline.sourceVersionId,
            remoteRevision: baseline.remoteRevision,
            lastSyncedAt: baseline.lastSyncedAt.toISOString(),
          },
        );
      }

      const identities = new Set<string>([...localMap.keys(), ...baselineMap.keys()]);
      if (params.direction !== 'push') for (const key of remoteMap.keys()) identities.add(key);

      const comparable = [...identities].map((id) => {
        const local = localMap.get(id) ?? null;
        const remote = remoteMap.get(id) ?? null;
        const baseline = baselineMap.get(id) ?? null;
        const source = local ?? baseline ?? remote;
        return {
          identity: {
            projectId: params.projectId,
            platform: (source?.platform ?? 'web') as PlatformName,
            namespace: source?.namespace ?? '',
            key: source?.key ?? '',
            locale: source?.locale ?? '',
          },
          local,
          remote,
          baseline,
        };
      });

      const built: BuiltPlan = buildSyncPlan(comparable, {
        planVersion: SYNC_PLAN_VERSION,
        projectId: params.projectId,
        repositoryConnectionId: params.connectionId,
        scanId: params.scanId,
        direction: params.direction,
        baseRevision: params.baseRevision ?? revision,
        includeDrafts: params.includeDrafts,
      });

      const session = await tx.syncSession.create({
        data: {
          organizationId: actor.organizationId,
          projectId: params.projectId,
          connectionId: params.connectionId,
          direction: params.direction,
          status: 'PENDING',
          baseRevision: params.baseRevision ?? revision,
          planHash: built.planHash,
          summary: built.payload.summary as unknown as Prisma.InputJsonValue,
          clientName: scan.clientName,
          clientVersion: scan.clientVersion,
          gitBranch: scan.gitBranch,
          gitCommit: scan.gitCommit,
          createdById: actor.userId,
        },
        select: { id: true },
      });

      const expiresAt = new Date(Date.now() + this.planTtlSeconds() * 1000);
      const plan = await tx.syncPlan.create({
        data: {
          organizationId: actor.organizationId,
          projectId: params.projectId,
          sessionId: session.id,
          scanId: params.scanId,
          direction: params.direction,
          baseRevision: params.baseRevision ?? revision,
          planHash: built.planHash,
          planJson: built.payload as unknown as Prisma.InputJsonValue,
          summary: built.payload.summary as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
        select: { id: true },
      });

      const conflicts = await this.syncConflictsFromPlan(tx, {
        organizationId: actor.organizationId,
        projectId: params.projectId,
        sessionId: session.id,
        items: built.payload.items,
      });

      return {
        plan: built.payload,
        planHash: built.planHash,
        expiresAt: expiresAt.toISOString(),
        sessionId: session.id,
        conflicts,
        planId: plan.id,
      };
    });
  }

  private planTtlSeconds(): number {
    const raw = Number(process.env.SYNC_PLAN_TTL_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? raw : 1800;
  }

  private parseScanEntries(json: Prisma.JsonValue): LocalEntrySnapshot[] {
    if (!Array.isArray(json)) return [];
    return json.map((raw) => {
      const entry = raw as Record<string, unknown>;
      return {
        projectId: String(entry.projectId ?? ''),
        platform: (entry.platform as PlatformName) ?? 'web',
        namespace: String(entry.namespace ?? ''),
        key: String(entry.key ?? ''),
        locale: String(entry.locale ?? ''),
        value: entry.deleted === true ? null : String(entry.value ?? ''),
        contentHash: entry.deleted === true ? null : String(entry.contentHash ?? contentHash(String(entry.value ?? ''))),
        fileId: String(entry.fileId ?? ''),
        filePath: String(entry.filePath ?? ''),
        description: entry.description ? String(entry.description) : undefined,
        context: (entry.context as Record<string, unknown> | undefined) ?? undefined,
        placeholders: entry.placeholders as LocalEntrySnapshot['placeholders'],
        platformMetadata: entry.platformMetadata as Record<string, unknown> | undefined,
        basedOnSourceHash: entry.basedOnSourceHash ? String(entry.basedOnSourceHash) : null,
      } satisfies LocalEntrySnapshot;
    });
  }

  private async loadRemoteSnapshots(
    tx: Prisma.TransactionClient,
    params: { projectId: string; locales?: string[] },
  ): Promise<Map<string, RemoteEntrySnapshot>> {
    const entries = await tx.translationEntry.findMany({
      where: {
        projectId: params.projectId,
        ...(params.locales?.length ? { localeCode: { in: params.locales } } : {}),
      },
      include: {
        key: { include: { namespace: true } },
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    const map = new Map<string, RemoteEntrySnapshot>();
    for (const entry of entries) {
      const latestVersion = entry.versions[0];
      const snapshot: RemoteEntrySnapshot = {
        projectId: params.projectId,
        platform: entry.key.platform as PlatformName,
        namespace: entry.key.namespace.name,
        key: entry.key.key,
        locale: entry.localeCode,
        value: entry.value,
        contentHash: entry.contentHash,
        entryId: entry.id,
        translationVersionId: entry.currentVersionId ?? latestVersion?.id ?? null,
        sourceVersionId: entry.basedOnSourceVersionId,
        sourceContentHash: null,
        reviewStatus: entry.status as ReviewStatus,
        revision: entry.revision,
        archived: entry.key.archivedAt !== null,
        updatedBy: entry.updatedById,
        updatedAt: entry.updatedAt.toISOString(),
        applyEligible: entry.status === 'APPROVED' && entry.key.archivedAt === null,
      };
      map.set(identityKey(snapshot), snapshot);
    }
    return map;
  }

  private async syncConflictsFromPlan(
    tx: Prisma.TransactionClient,
    params: { organizationId: string; projectId: string; sessionId: string; items: { identity: { platform: PlatformName; namespace: string; key: string; locale: string }; diff: SyncDiff }[] },
  ): Promise<number> {
    let count = 0;
    for (const item of params.items) {
      if (item.diff.action !== 'CONFLICT') continue;
      count += 1;
      const existing = await tx.syncConflict.findFirst({
        where: {
          projectId: params.projectId,
          platform: item.identity.platform,
          namespace: item.identity.namespace,
          translationKey: item.identity.key,
          localeCode: item.identity.locale,
          status: { in: ['OPEN', 'DEFERRED'] },
        },
        select: { id: true },
      });
      const data = {
        organizationId: params.organizationId,
        projectId: params.projectId,
        sessionId: params.sessionId,
        platform: item.identity.platform,
        namespace: item.identity.namespace,
        translationKey: item.identity.key,
        localeCode: item.identity.locale,
        baseValue: item.diff.baseValue ?? null,
        localValue: item.diff.localValue ?? null,
        remoteValue: item.diff.remoteValue ?? null,
        baseHash: item.diff.base.contentHash,
        localHash: item.diff.local.contentHash,
        remoteHash: item.diff.remote.contentHash,
        reason: item.diff.conflictReason ?? 'LOCAL_AND_REMOTE_CHANGED',
        filePath: item.diff.filePath ?? null,
        remoteVersionId: item.diff.translationVersionId ?? null,
      } as const;
      if (existing) {
        await tx.syncConflict.update({ where: { id: existing.id }, data });
      } else {
        await tx.syncConflict.create({ data });
      }
    }
    return count;
  }

  /* ------------------------------------------------------------------- push */

  async push(
    params: { syncPlanId?: string; planHash: string; client?: SyncPushClientInfo; idempotencyKey?: string; includeDeletes?: boolean },
    actor: SyncActor,
  ): Promise<PushResult> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const plan = await tx.syncPlan.findUnique({
        where: { planHash: params.planHash },
        include: { session: true },
      });
      if (!plan) {
        throw new LocaleHubError(ErrorCode.SYNC_PLAN_NOT_FOUND, 'Sync plan not found; run preview_sync again', 404);
      }
      if (params.syncPlanId && plan.id !== params.syncPlanId) {
        throw new LocaleHubError(ErrorCode.SYNC_PLAN_HASH_MISMATCH, 'Plan hash does not belong to the given plan id', 409);
      }
      if (plan.expiresAt.getTime() < Date.now()) {
        throw new LocaleHubError(ErrorCode.SYNC_PLAN_EXPIRED, `Plan expired at ${plan.expiresAt.toISOString()}`, 409);
      }
      if (plan.confirmedAt) {
        // Idempotent replay: the same plan can never create versions twice (spec §7.4).
        const stored = plan.session.summary as Record<string, unknown> | null;
        const replay = stored?.pushResult as PushResult | undefined;
        if (replay) return { ...replay, idempotentReplay: true };
        throw new LocaleHubError(ErrorCode.IDEMPOTENCY_KEY_REUSED, 'This plan has already been applied', 409);
      }

      const revision = await getProjectRevision(tx, plan.projectId);
      if (plan.baseRevision !== revision) {
        throw new LocaleHubError(
          ErrorCode.REVISION_MISMATCH,
          `Project changed since the preview was created (plan base revision ${plan.baseRevision}, current ${revision}). Run preview_sync again.`,
          409,
          { baseRevision: plan.baseRevision, currentRevision: revision },
        );
      }

      const payload = plan.planJson as unknown as SyncPlanPayload;
      const project = await tx.project.findUniqueOrThrow({ where: { id: plan.projectId }, select: { sourceLocale: true } });

      await tx.syncSession.update({ where: { id: plan.sessionId }, data: { status: 'RUNNING' } });

      const accepted: PushChangeAccepted[] = [];
      const conflicts: PushResult['conflicts'] = [];
      const failed: PushResult['failed'] = [];
      let created = 0;
      let updated = 0;
      let archived = 0;
      let skipped = 0;

      for (const item of payload.items) {
        const identity = item.identity;
        const diff = item.diff;
        try {
          if (diff.action === 'CONFLICT') {
            conflicts.push({ changeId: item.changeId, key: identity.key, locale: identity.locale, reason: diff.conflictReason ?? 'LOCAL_AND_REMOTE_CHANGED' });
            await this.upsertSyncItem(tx, {
              organizationId: actor.organizationId,
              sessionId: plan.sessionId,
              item,
              status: 'CONFLICT',
            });
            continue;
          }
          if (diff.action === 'ARCHIVE_CANDIDATE' || diff.action === 'REMOTE_ARCHIVE_CANDIDATE' || diff.action === 'ARCHIVE_CONVERGED') {
            if (diff.action === 'ARCHIVE_CONVERGED') {
              await this.deleteBaseline(tx, params, identity);
              skipped += 1;
              await this.upsertSyncItem(tx, { organizationId: actor.organizationId, sessionId: plan.sessionId, item, status: 'SKIPPED' });
              continue;
            }
            if (!params.includeDeletes) {
              skipped += 1;
              await this.upsertSyncItem(tx, {
                organizationId: actor.organizationId,
                sessionId: plan.sessionId,
                item,
                status: 'SKIPPED',
                errorCode: 'DELETE_NOT_CONFIRMED',
                errorMessage: 'Deletion was not confirmed (include_deletes=false)',
              });
              continue;
            }
            if (diff.action === 'ARCHIVE_CANDIDATE') {
              const keyId = await this.findKeyId(tx, plan.projectId, identity);
              if (keyId) {
                await tx.translationKey.update({ where: { id: keyId }, data: { archivedAt: new Date() } });
                archived += 1;
                accepted.push({ changeId: item.changeId, key: identity.key, locale: identity.locale, action: 'ARCHIVED' });
                await emitProjectEvent(tx, {
                  organizationId: actor.organizationId,
                  projectId: plan.projectId,
                  eventType: 'KEY_ARCHIVED',
                  resourceType: 'translation_key',
                  resourceId: keyId,
                  payload: { key: identity.key, locale: identity.locale, platform: identity.platform },
                  actorId: actor.userId,
                  actorType: actor.actorType ?? 'user',
                });
              }
            }
            await this.upsertSyncItem(tx, { organizationId: actor.organizationId, sessionId: plan.sessionId, item, status: 'APPLIED' });
            continue;
          }
          if (!isPushAction(diff.action)) {
            if (diff.action === 'CONVERGED') {
              await this.upsertBaseline(tx, {
                organizationId: actor.organizationId,
                projectId: plan.projectId,
                connectionId: payload.repositoryConnectionId,
                identity,
                localHash: diff.local.contentHash,
                remoteHash: diff.remote.contentHash,
                baseValue: diff.localValue ?? diff.remoteValue ?? null,
                translationVersionId: diff.translationVersionId ?? null,
                sourceVersionId: diff.sourceVersionId ?? null,
                remoteRevision: revision,
              });
            }
            skipped += 1;
            await this.upsertSyncItem(tx, { organizationId: actor.organizationId, sessionId: plan.sessionId, item, status: 'SKIPPED' });
            continue;
          }

          // ---- real push ----
          const localeId = await this.ensureLocale(tx, {
            organizationId: actor.organizationId,
            projectId: plan.projectId,
            code: identity.locale,
            isSource: identity.locale === project.sourceLocale,
          });
          const keyId = await ensureTranslationKey(tx, {
            organizationId: actor.organizationId,
            projectId: plan.projectId,
            platform: identity.platform,
            namespace: identity.namespace,
            key: identity.key,
            description: entryDescription(item),
          });

          const value = diff.localValue ?? '';
          let sourceVersionId: string | null = null;
          if (identity.locale === project.sourceLocale) {
            const source = await upsertSourceVersion(tx, {
              organizationId: actor.organizationId,
              projectId: plan.projectId,
              keyId,
              value,
              authorId: actor.userId,
            });
            sourceVersionId = source.sourceVersionId;
            if (source.changed) {
              const staleCount = await markTranslationsStale(tx, { keyId, sourceVersionId: source.sourceVersionId });
              await emitProjectEvent(tx, {
                organizationId: actor.organizationId,
                projectId: plan.projectId,
                eventType: 'SOURCE_VERSION_CREATED',
                resourceType: 'translation_key',
                resourceId: keyId,
                payload: { key: identity.key, platform: identity.platform, version: source.version, staleTargets: staleCount },
                actorId: actor.userId,
                actorType: actor.actorType ?? 'user',
              });
            }
          } else {
            const key = await tx.translationKey.findUnique({ where: { id: keyId }, select: { sourceVersions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } });
            sourceVersionId = key?.sourceVersions[0]?.id ?? null;
          }

          const result = await upsertTranslation(tx, {
            organizationId: actor.organizationId,
            projectId: plan.projectId,
            keyId,
            localeId,
            localeCode: identity.locale,
            value,
            status: 'APPROVED',
            basedOnSourceVersionId: sourceVersionId,
            authorId: actor.userId,
            authorType: actor.actorType === 'mcp' ? 'mcp' : 'repository',
            comment: 'Imported from repository via CLI',
            repositoryApplied: true,
          });

          if (result.changed) {
            if (diff.action === 'PUSH_NEW') created += 1;
            else updated += 1;
            await emitProjectEvent(tx, {
              organizationId: actor.organizationId,
              projectId: plan.projectId,
              eventType: diff.action === 'PUSH_NEW' ? 'TRANSLATION_CREATED' : 'TRANSLATION_UPDATED',
              resourceType: 'translation_entry',
              resourceId: result.entryId,
              payload: {
                entryId: result.entryId,
                key: identity.key,
                locale: identity.locale,
                platform: identity.platform,
                namespace: identity.namespace,
                contentHash: contentHash(value),
                source: 'repository',
              },
              actorId: actor.userId,
              actorType: actor.actorType ?? 'user',
            });
          } else {
            skipped += 1;
          }

          accepted.push({
            changeId: item.changeId,
            key: identity.key,
            locale: identity.locale,
            action: result.changed ? (diff.action === 'PUSH_NEW' ? 'CREATED' : 'UPDATED') : 'SKIPPED',
            translationVersionId: result.translationVersionId,
            sourceVersionId,
            reason: result.changed ? undefined : 'UNCHANGED_CONTENT',
          });

          await this.upsertBaseline(tx, {
            organizationId: actor.organizationId,
            projectId: plan.projectId,
            connectionId: payload.repositoryConnectionId,
            identity,
            localFileId: diff.fileId ?? null,
            localFilePath: diff.filePath ?? null,
            localHash: contentHash(value),
            remoteHash: contentHash(value),
            baseValue: value,
            translationVersionId: result.translationVersionId,
            sourceVersionId,
            remoteRevision: revision,
          });
          await this.upsertSyncItem(tx, { organizationId: actor.organizationId, sessionId: plan.sessionId, item, status: 'APPLIED' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          failed.push({
            changeId: item.changeId,
            key: identity.key,
            locale: identity.locale,
            code: error instanceof LocaleHubError ? error.code : ErrorCode.INTERNAL_ERROR,
            message: err.message,
          });
          await this.upsertSyncItem(tx, {
            organizationId: actor.organizationId,
            sessionId: plan.sessionId,
            item,
            status: 'FAILED',
            errorCode: error instanceof LocaleHubError ? error.code : ErrorCode.INTERNAL_ERROR,
            errorMessage: err.message,
          });
        }
      }

      const syncEventRevision = await emitProjectEvent(tx, {
        organizationId: actor.organizationId,
        projectId: plan.projectId,
        eventType: 'SYNC_PUSHED',
        resourceType: 'sync_session',
        resourceId: plan.sessionId,
        payload: { created, updated, archived, skipped, conflicts: conflicts.length, failed: failed.length },
        actorId: actor.userId,
        actorType: actor.actorType ?? 'user',
      });
      const revisionAfter = Math.max(syncEventRevision, revision);

      const status: PushResult['status'] = failed.length === 0 ? 'SUCCEEDED' : created + updated + archived > 0 ? 'PARTIAL' : 'FAILED';

      if (plan.session.connectionId) {
        await tx.repositoryConnection.update({
          where: { id: plan.session.connectionId },
          data: {
            lastSeenAt: new Date(),
            lastCommit: params.client?.gitCommit ?? null,
            lastBranch: params.client?.gitBranch ?? null,
            clientName: params.client?.name ?? null,
            clientVersion: params.client?.version ?? null,
          },
        }).catch(() => undefined);
      }

      const result: PushResult = {
        syncSessionId: plan.sessionId,
        status,
        revision: revisionAfter,
        accepted,
        conflicts,
        failed,
        summary: { created, updated, archived, skipped, failed: failed.length, conflicts: conflicts.length },
        idempotentReplay: false,
      };

      await tx.syncPlan.update({
        where: { id: plan.id },
        data: { confirmedAt: new Date(), idempotencyKey: params.idempotencyKey ?? null },
      });
      await tx.syncSession.update({
        where: { id: plan.sessionId },
        data: {
          status,
          revisionAfter,
          completedAt: new Date(),
          summary: { ...(payload.summary as unknown as Record<string, unknown>), pushResult: result } as unknown as Prisma.InputJsonValue,
        },
      });

      return result;
    });
  }

  private async upsertSyncItem(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      sessionId: string;
      item: { identity: { platform: PlatformName; namespace: string; key: string; locale: string }; action: string; diff: SyncDiff };
      status: 'PENDING' | 'APPLIED' | 'SKIPPED' | 'FAILED' | 'CONFLICT';
      errorCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    const identity = params.item.identity;
    await tx.syncItem.upsert({
      where: {
        sessionId_platform_namespace_translationKey_localeCode: {
          sessionId: params.sessionId,
          platform: identity.platform,
          namespace: identity.namespace,
          translationKey: identity.key,
          localeCode: identity.locale,
        },
      },
      create: {
        organizationId: params.organizationId,
        sessionId: params.sessionId,
        action: params.item.action as never,
        status: params.status,
        translationKey: identity.key,
        localeCode: identity.locale,
        platform: identity.platform,
        namespace: identity.namespace,
        localHash: params.item.diff.local.contentHash,
        remoteHash: params.item.diff.remote.contentHash,
        baseHash: params.item.diff.base.contentHash,
        entryId: params.item.diff.entryId ?? null,
        translationVersionId: params.item.diff.translationVersionId ?? null,
        errorCode: params.errorCode ?? null,
        errorMessage: params.errorMessage ?? null,
      },
      update: {
        status: params.status,
        localHash: params.item.diff.local.contentHash,
        remoteHash: params.item.diff.remote.contentHash,
        baseHash: params.item.diff.base.contentHash,
        entryId: params.item.diff.entryId ?? null,
        translationVersionId: params.item.diff.translationVersionId ?? null,
        errorCode: params.errorCode ?? null,
        errorMessage: params.errorMessage ?? null,
      },
    });
  }

  private async findKeyId(
    tx: Prisma.TransactionClient,
    projectId: string,
    identity: { platform: PlatformName; namespace: string; key: string },
  ): Promise<string | null> {
    const namespace = await tx.namespace.findUnique({
      where: { projectId_platform_name: { projectId, platform: identity.platform, name: identity.namespace } },
      select: { id: true },
    });
    if (!namespace) return null;
    const key = await tx.translationKey.findUnique({
      where: { projectId_platform_namespaceId_key: { projectId, platform: identity.platform, namespaceId: namespace.id, key: identity.key } },
      select: { id: true },
    });
    return key?.id ?? null;
  }

  /**
   * Add whatever the caller has that the project does not.
   *
   * Three outcomes, and only one of them is "do nothing": an exact code is already there, an
   * equivalent tag resolves to the existing code (`zh-Hans` → `zh-CN`), or the language is new and
   * gets created. The third used to happen silently and the second did not happen at all — which
   * meant an iOS checkout whose source directory is `zh-Hans.lproj` produced a second Chinese
   * locale that was not the source, so the import created no source versions and the project ended
   * up with translated text and no reference to translate from.
   *
   * Ambiguity is refused instead of guessed: a bare `zh` against a project holding both `zh-CN`
   * and `zh-TW` has no right answer, and filing text under the wrong language is silent and
   * expensive to undo.
   */
  private async expandProjectShape(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      projectId: string;
      sourceLocale: string;
      locales: string[];
      platforms: PlatformName[];
      dryRun: boolean;
    },
  ): Promise<{ expansion: ProjectShapeExpansion; resolve: (raw: string) => string }> {
    const rows = await tx.locale.findMany({ where: { projectId: params.projectId }, select: { code: true } });
    const known = rows.map((row) => row.code);
    const expansion: ProjectShapeExpansion = { localesAdded: [], localesMatched: [], platformsAdded: [] };
    const decided = new Map<string, string>();

    const resolve = (raw: string): string => {
      const cached = decided.get(raw);
      if (cached) return cached;
      const resolution = resolveLocaleTag(raw, known);
      if (resolution.reason === 'ambiguous') {
        throw new LocaleHubError(
          ErrorCode.INVALID_LOCALE,
          `Cannot tell which language "${raw}" means: this project already has ${resolution.candidates!.join(' and ')}. ` +
            'Pass the exact code you want.',
          409,
          { incoming: raw, candidates: resolution.candidates },
        );
      }
      if (resolution.reason === 'new') {
        known.push(resolution.code);
        expansion.localesAdded.push(resolution.code);
      } else if (resolution.code !== raw) {
        expansion.localesMatched.push({ from: raw, to: resolution.code });
      }
      decided.set(raw, resolution.code);
      return resolution.code;
    };

    // Resolve before creating: the caller passes every file and entry locale through `resolve`, and
    // the rows can only be written once that has run.
    for (const code of params.locales) resolve(code);

    // Computed for the dry run as well: a preview that omits half the expansion answers a
    // question the caller did not ask. Only the writes are conditional.
    const existingPlatforms = await tx.projectPlatform.findMany({
      where: { projectId: params.projectId },
      select: { platform: true },
    });
    for (const platform of new Set(params.platforms)) {
      if (existingPlatforms.some((row) => row.platform === platform)) continue;
      expansion.platformsAdded.push(platform);
      if (params.dryRun) continue;
      await tx.projectPlatform.create({
        data: { organizationId: params.organizationId, projectId: params.projectId, platform: platform as never },
      });
    }

    if (!params.dryRun) {
      for (const code of expansion.localesAdded) {
        await tx.locale.create({
          data: {
            organizationId: params.organizationId,
            projectId: params.projectId,
            code,
            name: localeDisplayName(code),
            isSource: code === params.sourceLocale,
          },
        });
      }
    }

    return { expansion, resolve };
  }

  /**
   * What an ingest *would* add, for a dry run. Reads only.
   *
   * A dry run that hides the expansion is worse than no dry run: "nothing was written" would be
   * true and useless, because the caller's real question is what the project will look like after.
   */
  async previewShapeExpansion(
    params: { projectId: string; locales: string[]; platforms: PlatformName[] },
    actor: SyncActor,
  ): Promise<ProjectShapeExpansion> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const { expansion } = await this.expandProjectShape(tx, {
        organizationId: actor.organizationId,
        projectId: params.projectId,
        sourceLocale: '',
        locales: params.locales,
        platforms: params.platforms,
        dryRun: true,
      });
      return expansion;
    });
  }

  private async ensureLocale(
    tx: Prisma.TransactionClient,
    params: { organizationId: string; projectId: string; code: string; isSource: boolean },
  ): Promise<string> {
    const existing = await tx.locale.findUnique({
      where: { projectId_code: { projectId: params.projectId, code: params.code } },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await tx.locale.create({
      data: {
        organizationId: params.organizationId,
        projectId: params.projectId,
        code: params.code,
        name: localeDisplayName(params.code),
        isSource: params.isSource,
      },
      select: { id: true },
    });
    return created.id;
  }

  private async upsertBaseline(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      projectId: string;
      connectionId: string | null;
      identity: { platform: PlatformName; namespace: string; key: string; locale: string };
      localFileId?: string | null;
      localFilePath?: string | null;
      localHash: string | null;
      remoteHash: string | null;
      baseValue: string | null;
      translationVersionId: string | null;
      sourceVersionId: string | null;
      remoteRevision: number;
    },
  ): Promise<void> {
    if (!params.connectionId) return;
    const identity = params.identity;
    await tx.syncBaseline.upsert({
      where: {
        connectionId_platform_namespace_translationKey_localeCode: {
          connectionId: params.connectionId,
          platform: identity.platform,
          namespace: identity.namespace,
          translationKey: identity.key,
          localeCode: identity.locale,
        },
      },
      create: {
        organizationId: params.organizationId,
        projectId: params.projectId,
        connectionId: params.connectionId,
        platform: identity.platform,
        namespace: identity.namespace,
        translationKey: identity.key,
        localeCode: identity.locale,
        localFileId: params.localFileId ?? null,
        localFilePath: params.localFilePath ?? null,
        localHash: params.localHash,
        remoteHash: params.remoteHash,
        baseValue: params.baseValue,
        translationVersionId: params.translationVersionId,
        sourceVersionId: params.sourceVersionId,
        remoteRevision: params.remoteRevision,
        lastSyncedAt: new Date(),
      },
      update: {
        ...(params.localFileId ? { localFileId: params.localFileId } : {}),
        ...(params.localFilePath ? { localFilePath: params.localFilePath } : {}),
        localHash: params.localHash,
        remoteHash: params.remoteHash,
        baseValue: params.baseValue,
        translationVersionId: params.translationVersionId,
        sourceVersionId: params.sourceVersionId,
        remoteRevision: params.remoteRevision,
        lastSyncedAt: new Date(),
      },
    });
  }

  private async deleteBaseline(
    tx: Prisma.TransactionClient,
    params: { planHash: string },
    identity: { platform: PlatformName; namespace: string; key: string; locale: string },
  ): Promise<void> {
    const plan = await tx.syncPlan.findUnique({ where: { planHash: params.planHash }, select: { projectId: true } });
    if (!plan) return;
    await tx.syncBaseline.deleteMany({
      where: {
        projectId: plan.projectId,
        platform: identity.platform,
        namespace: identity.namespace,
        translationKey: identity.key,
        localeCode: identity.locale,
      },
    });
  }

  /* --------------------------------------------------------------- changes */

  /** Spec §8.3 — platform changes the local repository can pull, by revision cursor. */
  async getChanges(
    params: {
      projectId: string;
      connectionId?: string | null;
      locales?: string[];
      statuses: ReviewStatus[];
      sinceRevision?: number;
      limit: number;
    },
    actor: SyncActor,
  ): Promise<{ changes: PlatformChange[]; revision: number }> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const revision = await getProjectRevision(tx, params.projectId);
      const events = await tx.projectEvent.findMany({
        where: {
          projectId: params.projectId,
          ...(params.sinceRevision !== undefined ? { revision: { gt: params.sinceRevision } } : {}),
          eventType: { in: ['TRANSLATION_CREATED', 'TRANSLATION_UPDATED', 'TRANSLATION_APPROVED', 'TRANSLATION_REJECTED', 'TRANSLATION_STALE', 'KEY_ARCHIVED'] },
        },
        orderBy: { revision: 'asc' },
        take: params.limit,
      });

      const changes: PlatformChange[] = [];
      const seen = new Set<string>();
      for (const event of events) {
        const payload = event.payload as Record<string, unknown>;
        const entryId = typeof payload.entryId === 'string' ? payload.entryId : null;
        if (!entryId || seen.has(entryId)) continue;
        seen.add(entryId);
        const entry = await tx.translationEntry.findUnique({
          where: { id: entryId },
          include: { key: { include: { namespace: true } }, versions: { orderBy: { version: 'desc' }, take: 2 } },
        });
        if (!entry) continue;
        if (params.locales?.length && !params.locales.includes(entry.localeCode)) continue;
        if (!params.statuses.includes(entry.status as ReviewStatus)) continue;
        const latest = entry.versions[0];
        const previous = entry.versions[1] ?? null;
        changes.push({
          entryId: entry.id,
          key: entry.key.key,
          locale: entry.localeCode,
          platform: entry.key.platform as PlatformName,
          namespace: entry.key.namespace.name,
          content: entry.value,
          contentHash: entry.contentHash,
          previousContent: previous?.value ?? null,
          translationVersionId: entry.currentVersionId ?? latest?.id ?? '',
          sourceVersionId: entry.basedOnSourceVersionId,
          reviewStatus: entry.status as ReviewStatus,
          remoteRevision: event.revision,
          updatedAt: entry.updatedAt.toISOString(),
          appliedToRepo: entry.appliedToRepoAt !== null,
          archived: entry.key.archivedAt !== null,
        });
      }
      return { changes, revision };
    });
  }

  async getBaselines(
    params: { projectId: string; connectionId: string; sinceRevision?: number; locales?: string[] },
    actor: SyncActor,
  ): Promise<{ baselines: SyncBaselineSnapshot[]; revision: number }> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const revision = await getProjectRevision(tx, params.projectId);
      const rows = await tx.syncBaseline.findMany({
        where: {
          connectionId: params.connectionId,
          projectId: params.projectId,
          ...(params.sinceRevision !== undefined ? { remoteRevision: { gt: params.sinceRevision } } : {}),
          ...(params.locales?.length ? { localeCode: { in: params.locales } } : {}),
        },
        orderBy: [{ localeCode: 'asc' }, { translationKey: 'asc' }],
      });
      return {
        revision,
        baselines: rows.map((row) => ({
          projectId: row.projectId,
          platform: row.platform as PlatformName,
          namespace: row.namespace,
          key: row.translationKey,
          locale: row.localeCode,
          localHash: row.localHash,
          remoteHash: row.remoteHash,
          baseValue: row.baseValue,
          remoteVersionId: row.translationVersionId,
          sourceVersionId: row.sourceVersionId,
          remoteRevision: row.remoteRevision,
          lastSyncedAt: row.lastSyncedAt.toISOString(),
        })),
      };
    });
  }

  /* ------------------------------------------------------------- conflicts */

  async listConflicts(
    params: { projectId: string; status?: 'OPEN' | 'RESOLVED' | 'DEFERRED'; locale?: string; limit?: number },
    actor: SyncActor,
  ): Promise<ConflictRecord[]> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const rows = await tx.syncConflict.findMany({
        where: {
          projectId: params.projectId,
          ...(params.status ? { status: params.status } : {}),
          ...(params.locale ? { localeCode: params.locale } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: params.limit ?? 100,
      });
      return rows.map((row) => this.toConflictRecord(row));
    });
  }

  async getConflict(conflictId: string, actor: SyncActor): Promise<ConflictRecord> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const row = await tx.syncConflict.findUnique({ where: { id: conflictId } });
      if (!row) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Conflict ${conflictId} not found`, 404);
      return this.toConflictRecord(row);
    });
  }

  private toConflictRecord(row: {
    id: string;
    projectId: string;
    translationKey: string;
    localeCode: string;
    platform: string;
    namespace: string;
    baseValue: string | null;
    localValue: string | null;
    remoteValue: string | null;
    baseHash: string | null;
    localHash: string | null;
    remoteHash: string | null;
    reason: string;
    filePath: string | null;
    remoteVersionId: string | null;
    status: string;
    resolution: string | null;
    resolvedValue: string | null;
    resolvedAt: Date | null;
    resolvedById: string | null;
    createdAt: Date;
  }): ConflictRecord {
    return {
      id: row.id,
      projectId: row.projectId,
      key: row.translationKey,
      locale: row.localeCode,
      platform: row.platform as PlatformName,
      namespace: row.namespace,
      baseValue: row.baseValue,
      localValue: row.localValue,
      remoteValue: row.remoteValue,
      baseHash: row.baseHash,
      localHash: row.localHash,
      remoteHash: row.remoteHash,
      reason: row.reason as ConflictRecord['reason'],
      filePath: row.filePath,
      remoteVersionId: row.remoteVersionId,
      status: row.status as ConflictRecord['status'],
      resolution: row.resolution as ConflictRecord['resolution'],
      resolvedValue: row.resolvedValue,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedBy: row.resolvedById,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async resolveConflict(
    conflictId: string,
    input: { resolution: ConflictResolution; value?: string; note?: string },
    actor: SyncActor,
  ): Promise<ConflictRecord> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const row = await tx.syncConflict.findUnique({ where: { id: conflictId } });
      if (!row) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Conflict ${conflictId} not found`, 404);
      if (row.status === 'RESOLVED') {
        throw new LocaleHubError(ErrorCode.CONFLICT_ALREADY_RESOLVED, 'Conflict is already resolved', 409);
      }
      // `resolveConflictValue` operates on the flat value fields, so they must be present here
      // (the nested `base/local/remote` sides only carry hashes and presence).
      const outcome = resolveConflictValue(
        {
          action: 'CONFLICT',
          reason: row.reason,
          base: { value: row.baseValue, contentHash: row.baseHash, present: row.baseValue !== null, changed: false },
          local: { value: row.localValue, contentHash: row.localHash, present: row.localValue !== null, changed: true },
          remote: { value: row.remoteValue, contentHash: row.remoteHash, present: row.remoteValue !== null, changed: true },
          baseValue: row.baseValue,
          localValue: row.localValue,
          remoteValue: row.remoteValue,
          remoteApplyEligible: true,
          localPushEligible: true,
        },
        { resolution: input.resolution, value: input.value },
      );

      // When the decision makes the platform the owner of the truth (KEEP_LOCAL /
      // MANUAL_MERGE) the resolved value is written as a new approved version. History is
      // never rewritten (spec §7.3).
      if (outcome.remoteAction === 'WRITE_VALUE' && outcome.value !== null) {
        const localeRow = await tx.locale.findUnique({
          where: { projectId_code: { projectId: row.projectId, code: row.localeCode } },
          select: { id: true },
        });
        // The conflict stores the *dotted* key; the database stores namespace + short key,
        // so resolve through the namespace row rather than matching the raw string.
        const namespaceRow = await tx.namespace.findUnique({
          where: { projectId_platform_name: { projectId: row.projectId, platform: row.platform as never, name: row.namespace } },
          select: { id: true },
        });
        const keyRow = namespaceRow
          ? await tx.translationKey.findUnique({
              where: {
                projectId_platform_namespaceId_key: {
                  projectId: row.projectId,
                  platform: row.platform as never,
                  namespaceId: namespaceRow.id,
                  key: row.translationKey,
                },
              },
              select: { id: true },
            })
          : null;
        if (localeRow && keyRow) {
          const result = await upsertTranslation(tx, {
            organizationId: actor.organizationId,
            projectId: row.projectId,
            keyId: keyRow.id,
            localeId: localeRow.id,
            localeCode: row.localeCode,
            value: outcome.value,
            status: 'APPROVED',
            basedOnSourceVersionId: null,
            authorId: actor.userId,
            authorType: 'user',
            comment: `Resolved sync conflict ${conflictId} (${input.resolution})`,
          });
          await emitProjectEvent(tx, {
            organizationId: actor.organizationId,
            projectId: row.projectId,
            eventType: 'TRANSLATION_APPROVED',
            resourceType: 'translation_entry',
            resourceId: result.entryId,
            payload: {
              entryId: result.entryId,
              key: row.translationKey,
              locale: row.localeCode,
              platform: row.platform,
              contentHash: contentHash(outcome.value),
              fromConflict: conflictId,
            },
            actorId: actor.userId,
            actorType: actor.actorType ?? 'user',
          });
        }
      }

      if (input.resolution === 'DEFER') {
        await tx.syncConflict.update({
          where: { id: conflictId },
          data: { status: 'DEFERRED', resolution: 'DEFER', note: input.note ?? null, resolvedById: actor.userId, resolvedAt: new Date() },
        });
      } else {
        await tx.syncConflict.update({
          where: { id: conflictId },
          data: {
            status: 'RESOLVED',
            resolution: input.resolution,
            resolvedValue: outcome.value,
            note: input.note ?? null,
            resolvedById: actor.userId,
            resolvedAt: new Date(),
          },
        });
        await emitProjectEvent(tx, {
          organizationId: actor.organizationId,
          projectId: row.projectId,
          eventType: 'CONFLICT_RESOLVED',
          resourceType: 'sync_conflict',
          resourceId: conflictId,
          payload: { key: row.translationKey, locale: row.localeCode, resolution: input.resolution, value: outcome.value },
          actorId: actor.userId,
          actorType: actor.actorType ?? 'user',
        });
      }
      const updated = await tx.syncConflict.findUniqueOrThrow({ where: { id: conflictId } });
      return this.toConflictRecord(updated);
    });
  }

  /* ----------------------------------------------------------- apply report */

  /**
   * Record that one entry's text is now in the repository.
   *
   * Shared by the CLI's apply report and the Remote MCP's `mark_applied`, because both surfaces are
   * asserting the same fact about a machine the platform cannot see, and the fact has to move the
   * same three things: the entry's applied marker, the three-way baseline it is compared against
   * next time, and the `SYNC_APPLIED` event the repository's history is built from.
   */
  private async recordRepositoryWrite(
    tx: Prisma.TransactionClient,
    params: {
      actor: SyncActor;
      projectId: string;
      connectionId: string | null;
      applyPlanId: string;
      gitCommit: string | null;
      viaMcp?: boolean;
      item: {
        key: string;
        locale: string;
        platform: PlatformName;
        namespace: string;
        filePath: string | null;
        newValue: string;
      };
    },
  ): Promise<number> {
    const item = params.item;
    const entry = await tx.translationEntry.findFirst({
      where: { projectId: params.projectId, localeCode: item.locale, key: { key: item.key, platform: item.platform } },
      select: { id: true, contentHash: true },
    });
    if (!entry) return 0;

    await tx.translationEntry.update({
      where: { id: entry.id },
      data: { appliedToRepoAt: new Date(), appliedToRepoCommit: params.gitCommit },
    });

    let baselineUpdated = 0;
    if (params.connectionId) {
      const updated = await tx.syncBaseline.updateMany({
        where: {
          connectionId: params.connectionId,
          projectId: params.projectId,
          platform: item.platform,
          namespace: item.namespace,
          translationKey: item.key,
          localeCode: item.locale,
        },
        data: {
          localHash: entry.contentHash,
          remoteHash: entry.contentHash,
          baseValue: item.newValue,
          lastSyncedAt: new Date(),
        },
      });
      baselineUpdated = updated.count;
    }

    await emitProjectEvent(tx, {
      organizationId: params.actor.organizationId,
      projectId: params.projectId,
      eventType: 'SYNC_APPLIED',
      resourceType: 'translation_entry',
      resourceId: entry.id,
      payload: {
        key: item.key,
        locale: item.locale,
        platform: item.platform,
        filePath: item.filePath,
        gitCommit: params.gitCommit,
        applyPlanId: params.applyPlanId,
        ...(params.viaMcp ? { viaMcp: true } : {}),
      },
      actorId: params.actor.userId,
      actorType: params.actor.actorType ?? 'user',
    });

    return baselineUpdated;
  }

  /**
   * Record that an agent wrote approved platform text into a repository.
   *
   * This is the platform → repository half of the loop, and until it existed the half only the CLI
   * could close: an agent could read pending changes and write the files, but every change stayed
   * flagged "not in the repository", so the next pull offered the same work again and
   * `validate_release` kept counting it as outstanding.
   *
   * The platform cannot see the developer's disk, so this is a claim rather than an observation —
   * the same trust a CLI apply report carries. What the platform *can* check is that the text the
   * agent says it wrote is still the text the platform holds: every item names the version it
   * applied, and an item whose version has been superseded is refused rather than marked. Without
   * that check a slow agent would write yesterday's translation, mark it applied, and the platform
   * would never offer the newer one again — a divergence in the one direction nothing else can
   * detect.
   */
  async markApplied(
    params: {
      projectId: string;
      items: MarkAppliedItem[];
      gitCommit?: string | null;
      gitBranch?: string | null;
      client: SyncPushClientInfo;
      dryRun?: boolean;
    },
    actor: SyncActor,
  ): Promise<MarkAppliedResult> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: params.projectId }, select: { id: true } });
      if (!project) {
        throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${params.projectId} not found`, 404);
      }

      // Unapproved text reaches a repository only where the organization has said so. The same
      // rule the REST pull path enforces, checked here because an agent marks its own work.
      const organization = await tx.organization.findUnique({
        where: { id: actor.organizationId },
        select: { allowDraftApply: true },
      });
      const draftsAllowed = organization?.allowDraftApply ?? false;

      const revision = await getProjectRevision(tx, params.projectId);
      const resolved: { item: MarkAppliedItem; entryId: string; namespace: string; versionId: string | null; value: string }[] = [];
      const skipped: MarkAppliedSkip[] = [];

      for (const item of params.items) {
        const entry = await tx.translationEntry.findFirst({
          where: { projectId: params.projectId, localeCode: item.locale, key: { key: item.key, platform: item.platform } },
          include: { key: { include: { namespace: true } } },
        });
        const where = { key: item.key, locale: item.locale, platform: item.platform };

        if (!entry) {
          skipped.push({ ...where, reason: 'NOT_FOUND' });
          continue;
        }
        if (entry.appliedToRepoAt !== null) {
          // Idempotent: an agent that retries after a partial failure must not be told it failed,
          // and must not produce a second `SYNC_APPLIED` event for the same write.
          skipped.push({ ...where, reason: 'ALREADY_APPLIED' });
          continue;
        }
        if (entry.status !== 'APPROVED' && !draftsAllowed) {
          skipped.push({ ...where, reason: 'DRAFT_NOT_ALLOWED' });
          continue;
        }
        if (item.translationVersionId && entry.currentVersionId !== item.translationVersionId) {
          skipped.push({ ...where, reason: 'VERSION_SUPERSEDED' });
          continue;
        }
        resolved.push({
          item,
          entryId: entry.id,
          namespace: entry.key.namespace.name,
          versionId: entry.currentVersionId,
          value: entry.value,
        });
      }

      if (params.dryRun || resolved.length === 0) {
        return {
          dryRun: Boolean(params.dryRun),
          projectId: params.projectId,
          sessionId: null,
          revision,
          baselineUpdated: 0,
          applied: resolved.map((row) => ({
            key: row.item.key,
            locale: row.item.locale,
            platform: row.item.platform,
            filePath: row.item.filePath ?? null,
            translationVersionId: row.versionId,
          })),
          skipped,
        };
      }

      const connectionId = await this.ensureConnection(tx, {
        organizationId: actor.organizationId,
        projectId: params.projectId,
        client: params.client,
      });
      const applyPlanId = `mcp-${randomUUID()}`;
      const gitCommit = params.gitCommit ?? null;

      const session = await tx.syncSession.create({
        data: {
          organizationId: actor.organizationId,
          projectId: params.projectId,
          connectionId,
          direction: 'pull',
          status: 'RUNNING',
          baseRevision: revision,
          summary: { applied: resolved.length, skipped: skipped.length } as unknown as Prisma.InputJsonValue,
          clientName: params.client.name,
          clientVersion: params.client.version,
          gitBranch: params.gitBranch ?? params.client.gitBranch ?? null,
          gitCommit,
          createdById: actor.userId,
        },
        select: { id: true },
      });

      let baselineUpdated = 0;
      for (const row of resolved) {
        baselineUpdated += await this.recordRepositoryWrite(tx, {
          actor,
          projectId: params.projectId,
          connectionId,
          applyPlanId,
          gitCommit,
          viaMcp: true,
          item: {
            key: row.item.key,
            locale: row.item.locale,
            platform: row.item.platform,
            namespace: row.namespace,
            filePath: row.item.filePath ?? null,
            newValue: row.value,
          },
        });
      }

      // The same report a CLI apply leaves behind, so an agent's apply shows up in the sync history
      // beside a person's instead of being invisible to everything that reads these tables.
      await tx.syncApplyReport.create({
        data: {
          organizationId: actor.organizationId,
          projectId: params.projectId,
          sessionId: session.id,
          applyPlanId,
          status: 'SUCCEEDED',
          // The platform never sees the file, so it cannot know the file's real hash. What it can
          // record is a digest of the text it was told is in there — a function of the content,
          // not of the path, which is what makes it worth keeping.
          files: ([...new Set(resolved.map((row) => row.item.filePath).filter((path): path is string => Boolean(path)))].map(
            (filePath) => ({
              filePath,
              backupPath: null,
              contentHash: contentHash(
                resolved
                  .filter((row) => row.item.filePath === filePath)
                  .map((row) => `${row.item.key}\u0001${row.item.locale}\u0001${row.value}`)
                  .sort()
                  .join('\u0000'),
              ),
            }),
          )) as unknown as Prisma.InputJsonValue,
          items: ([
            ...resolved.map((row) => ({
              key: row.item.key,
              locale: row.item.locale,
              namespace: row.namespace,
              platform: row.item.platform,
              filePath: row.item.filePath ?? null,
              applied: true,
              previousValue: null,
              newValue: row.value,
              translationVersionId: row.versionId,
            })),
            ...skipped.map((row) => ({
              key: row.key,
              locale: row.locale,
              namespace: '',
              platform: row.platform,
              filePath: null,
              applied: false,
              previousValue: null,
              newValue: '',
              translationVersionId: null,
              errorCode: row.reason,
            })),
          ]) as unknown as Prisma.InputJsonValue,
          appliedCount: resolved.length,
          failedCount: skipped.length,
          gitCommit,
          clientName: params.client.name,
          clientVersion: params.client.version,
        },
      });

      await tx.syncSession.update({
        where: { id: session.id },
        data: {
          status: skipped.length ? 'PARTIAL' : 'SUCCEEDED',
          revisionAfter: revision,
          completedAt: new Date(),
        },
      });

      return {
        dryRun: false,
        projectId: params.projectId,
        sessionId: session.id,
        revision,
        baselineUpdated,
        applied: resolved.map((row) => ({
          key: row.item.key,
          locale: row.item.locale,
          platform: row.item.platform,
          filePath: row.item.filePath ?? null,
          translationVersionId: row.versionId,
        })),
        skipped,
      };
    });
  }

  async reportApply(payload: ApplyReportRequest, actor: SyncActor): Promise<{ baselineUpdated: number; sessionId: string }> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const session = await tx.syncSession.findUnique({ where: { id: payload.syncSessionId } });
      if (!session) throw new LocaleHubError(ErrorCode.SYNC_SESSION_NOT_FOUND, `Sync session ${payload.syncSessionId} not found`, 404);

      const appliedCount = payload.items.filter((item) => item.applied).length;
      await tx.syncApplyReport.upsert({
        where: { sessionId_applyPlanId: { sessionId: payload.syncSessionId, applyPlanId: payload.applyPlanId } },
        create: {
          organizationId: actor.organizationId,
          projectId: session.projectId,
          sessionId: payload.syncSessionId,
          applyPlanId: payload.applyPlanId,
          status: payload.status,
          files: payload.files as unknown as Prisma.InputJsonValue,
          items: payload.items as unknown as Prisma.InputJsonValue,
          appliedCount,
          failedCount: payload.items.length - appliedCount,
          gitCommit: payload.gitCommit ?? null,
          gitDiffStat: payload.gitDiffStat ?? null,
          clientName: payload.client.name,
          clientVersion: payload.client.version,
        },
        update: {
          status: payload.status,
          files: payload.files as unknown as Prisma.InputJsonValue,
          items: payload.items as unknown as Prisma.InputJsonValue,
          appliedCount,
          failedCount: payload.items.length - appliedCount,
          gitCommit: payload.gitCommit ?? null,
          gitDiffStat: payload.gitDiffStat ?? null,
        },
      });

      let baselineUpdated = 0;
      for (const item of payload.items) {
        if (!item.applied) continue;
        baselineUpdated += await this.recordRepositoryWrite(tx, {
          actor,
          projectId: session.projectId,
          connectionId: session.connectionId,
          applyPlanId: payload.applyPlanId,
          gitCommit: payload.gitCommit ?? null,
          item: {
            key: item.key,
            locale: item.locale,
            platform: item.platform,
            namespace: item.namespace,
            filePath: item.filePath,
            newValue: item.newValue,
          },
        });
      }

      await tx.syncSession.update({
        where: { id: payload.syncSessionId },
        data: { status: payload.status === 'SUCCEEDED' ? 'SUCCEEDED' : payload.status, completedAt: new Date() },
      });

      return { baselineUpdated, sessionId: payload.syncSessionId };
    });
  }

  /** Minimal plan lookup used for authorization on routes without a project id. */
  async getPlanSummary(syncPlanId: string, actor: SyncActor): Promise<{ projectId: string; expiresAt: string; confirmed: boolean }> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const plan = await tx.syncPlan.findUnique({ where: { id: syncPlanId }, select: { projectId: true, expiresAt: true, confirmedAt: true } });
      if (!plan) throw new LocaleHubError(ErrorCode.SYNC_PLAN_NOT_FOUND, `Sync plan ${syncPlanId} not found`, 404);
      return { projectId: plan.projectId, expiresAt: plan.expiresAt.toISOString(), confirmed: plan.confirmedAt !== null };
    });
  }

  /** Create a repository connection record for a project (spec §8 table row 1). */
  async createConnection(
    projectId: string,
    input: { name: string; provider?: string; repoUrl?: string; defaultBranch?: string },
    actor: SyncActor,
  ) {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`, 404);
      return tx.repositoryConnection.create({
        data: {
          organizationId: actor.organizationId,
          projectId,
          name: input.name,
          provider: (input.provider ?? 'local') as never,
          repoUrl: input.repoUrl ?? null,
          defaultBranch: input.defaultBranch ?? 'main',
          createdById: actor.userId,
        },
      });
    });
  }

  async listConnections(projectId: string, actor: SyncActor) {
    return this.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.repositoryConnection.findMany({ where: { projectId }, include: { mappings: true }, orderBy: { createdAt: 'asc' } }),
    );
  }

  async listEvents(projectId: string, actor: SyncActor, sinceRevision?: number, limit = 100) {
    return this.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.projectEvent.findMany({
        where: { projectId, ...(sinceRevision !== undefined ? { revision: { gt: sinceRevision } } : {}) },
        orderBy: { revision: 'asc' },
        take: Math.min(limit, 500),
      }),
    );
  }

  /**
   * Pre-release / pre-sync validation (spec §8 last row, §16 acceptance scenario E).
   * Deliberately conservative: it reports rather than mutates.
   */
  async validateForRelease(projectId: string, actor: SyncActor) {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { sourceLocale: true } });
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`, 404);
      const revision = await getProjectRevision(tx, projectId);

      const [entries, keys, openConflicts] = await Promise.all([
        tx.translationEntry.findMany({
          where: { projectId },
          include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
        }),
        tx.translationKey.count({ where: { projectId, archivedAt: null } }),
        tx.syncConflict.count({ where: { projectId, status: 'OPEN' } }),
      ]);

      const issues: { code: string; severity: 'ERROR' | 'WARNING' | 'INFO'; key: string; locale: string; message: string }[] = [];
      let approved = 0;
      let stale = 0;
      let untranslated = 0;
      let placeholderProblems = 0;

      for (const entry of entries) {
        const source = entry.key.sourceVersions[0]?.value ?? '';
        if (entry.localeCode === project.sourceLocale) continue;
        if (entry.status === 'APPROVED') approved += 1;
        if (entry.status === 'STALE') {
          stale += 1;
          issues.push({
            code: 'STALE_TRANSLATION',
            severity: 'WARNING',
            key: entry.key.key,
            locale: entry.localeCode,
            message: 'Translation is based on an older source version',
          });
        }
        if (!entry.value) {
          untranslated += 1;
          issues.push({
            code: 'MISSING_TRANSLATION',
            severity: 'ERROR',
            key: entry.key.key,
            locale: entry.localeCode,
            message: 'Translation is empty',
          });
        }
        if (source && entry.value) {
          const { comparePlaceholders } = await import('@localehub/contracts');
          const mismatch = comparePlaceholders(source, entry.value);
          if (mismatch.missing.length || mismatch.added.length) {
            placeholderProblems += 1;
            issues.push({
              code: 'PLACEHOLDER_MISMATCH',
              severity: 'ERROR',
              key: entry.key.key,
              locale: entry.localeCode,
              message: `Placeholders differ from source (missing: ${mismatch.missing.join(', ') || '-'}; extra: ${mismatch.added.join(', ') || '-'})`,
            });
          }
        }
      }

      if (openConflicts > 0) {
        issues.push({
          code: 'OPEN_CONFLICTS',
          severity: 'ERROR',
          key: '*',
          locale: '*',
          message: `${openConflicts} unresolved sync conflict(s)`,
        });
      }

      return {
        projectId,
        revision,
        ok: issues.every((issue) => issue.severity !== 'ERROR'),
        counts: { keys, entries: entries.length, approved, stale, untranslated, placeholderProblems, openConflicts },
        issues,
      };
    });
  }

  /* ------------------------------------------------------------- read side */

  async getSession(sessionId: string, actor: SyncActor) {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const session = await tx.syncSession.findUnique({ where: { id: sessionId }, include: { items: true, applyReports: true } });
      if (!session) throw new LocaleHubError(ErrorCode.SYNC_SESSION_NOT_FOUND, `Sync session ${sessionId} not found`, 404);
      return session;
    });
  }

  async listSessions(projectId: string, actor: SyncActor, limit = 20): Promise<SyncSessionSummaryRecord[]> {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const rows = await tx.syncSession.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: limit });
      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        repositoryConnectionId: row.connectionId,
        direction: row.direction,
        status: row.status,
        baseRevision: row.baseRevision,
        revisionAfter: row.revisionAfter,
        planHash: row.planHash,
        summary: (row.summary as Record<string, number> | null) ?? null,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      }));
    });
  }

  async listRecentSessions(actor: SyncActor, limit = 20) {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const rows = await tx.syncSession.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        include: { project: { select: { name: true, slug: true } } },
      });
      return rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        projectName: row.project.name,
        direction: row.direction,
        status: row.status,
        baseRevision: row.baseRevision,
        revisionAfter: row.revisionAfter,
        summary: row.summary,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      }));
    });
  }

  /** Spec §11.2 — repository sync page status widget. */
  async syncStatus(projectId: string, actor: SyncActor, connectionId?: string | null) {
    return this.tenant.withOrganization(actor.organizationId, async (tx) => {
      const revision = await getProjectRevision(tx, projectId);
      const connections = await tx.repositoryConnection.findMany({ where: { projectId } });
      const connection = connectionId
        ? connections.find((c) => c.id === connectionId) ?? null
        : connections[0] ?? null;
      const [baselineCount, openConflicts, latestSession, pendingPull] = await Promise.all([
        connection ? tx.syncBaseline.count({ where: { connectionId: connection.id } }) : Promise.resolve(0),
        tx.syncConflict.count({ where: { projectId, status: 'OPEN' } }),
        tx.syncSession.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
        connection
          ? tx.translationEntry.count({ where: { projectId, status: 'APPROVED', appliedToRepoAt: null } })
          : Promise.resolve(0),
      ]);
      return {
        projectId,
        revision,
        connection: connection
          ? {
              id: connection.id,
              name: connection.name,
              provider: connection.provider,
              repoUrl: connection.repoUrl,
              defaultBranch: connection.defaultBranch,
              status: connection.status,
              lastCommit: connection.lastCommit,
              lastBranch: connection.lastBranch,
              lastSeenAt: connection.lastSeenAt?.toISOString() ?? null,
              clientName: connection.clientName,
              clientVersion: connection.clientVersion,
            }
          : null,
        baselineCount,
        openConflicts,
        pendingPlatformChanges: pendingPull,
        latestSession: latestSession
          ? {
              id: latestSession.id,
              status: latestSession.status,
              direction: latestSession.direction,
              createdAt: latestSession.createdAt.toISOString(),
              summary: latestSession.summary,
            }
          : null,
        fileMappings: connection
          ? await tx.repositoryFileMapping.findMany({
              where: { connectionId: connection.id },
              select: { fileSetId: true, platform: true, locale: true, format: true, paths: true, lastScannedAt: true },
            })
          : [],
      };
    });
  }

  /** Preview used by the CLI before writing anything into the repository. */
  computeLocalDiff(entry: {
    local: LocalEntrySnapshot | null;
    remote: RemoteEntrySnapshot | null;
    baseline: SyncBaselineSnapshot | null;
    identity: { projectId: string; platform: PlatformName; namespace: string; key: string; locale: string };
  }, options: { includeDrafts?: boolean } = {}): SyncDiff {
    return computeSyncDiff(entry, options);
  }

  static newScanId(): string {
    return `scan_${randomUUID()}`;
  }
}
