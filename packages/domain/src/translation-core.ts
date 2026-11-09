import type { Prisma } from '@prisma/client';
import {
  ErrorCode,
  LocaleHubError,
  contentHash,
  extractPlaceholders,
  type PlatformName,
  type ReviewStatus,
} from '@localehub/contracts';

export interface KeyIdentityInput {
  organizationId: string;
  projectId: string;
  platform: PlatformName;
  namespace: string;
  key: string;
  description?: string | null;
  context?: Record<string, unknown> | null;
}

export async function ensureNamespace(
  tx: Prisma.TransactionClient,
  organizationId: string,
  projectId: string,
  platform: PlatformName,
  name: string,
): Promise<string> {
  const existing = await tx.namespace.findUnique({
    where: { projectId_platform_name: { projectId, platform, name } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await tx.namespace.create({
    data: { organizationId, projectId, platform, name },
    select: { id: true },
  });
  return created.id;
}

export async function ensureTranslationKey(tx: Prisma.TransactionClient, input: KeyIdentityInput): Promise<string> {
  const namespaceId = await ensureNamespace(tx, input.organizationId, input.projectId, input.platform, input.namespace);
  const existing = await tx.translationKey.findUnique({
    where: { projectId_platform_namespaceId_key: { projectId: input.projectId, platform: input.platform, namespaceId, key: input.key } },
    select: { id: true, archivedAt: true },
  });
  if (existing) {
    if (existing.archivedAt) {
      await tx.translationKey.update({ where: { id: existing.id }, data: { archivedAt: null } });
    }
    if (input.description) {
      await tx.translationKey.update({ where: { id: existing.id }, data: { description: input.description } });
    }
    return existing.id;
  }
  const created = await tx.translationKey.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      platform: input.platform,
      namespaceId,
      key: input.key,
      description: input.description ?? null,
      context: (input.context ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    select: { id: true },
  });
  return created.id;
}

export interface SourceVersionResult {
  sourceVersionId: string;
  version: number;
  changed: boolean;
  previousSourceVersionId: string | null;
}

/**
 * Source versions are immutable (spec §0.3). A push that does not change the source text
 * must not create a new version — this is what makes repeated pushes idempotent.
 */
export async function upsertSourceVersion(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    projectId: string;
    keyId: string;
    value: string;
    description?: string | null;
    authorId?: string | null;
  },
): Promise<SourceVersionResult> {
  const hash = contentHash(params.value);
  const latest = await tx.sourceVersion.findFirst({
    where: { keyId: params.keyId },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, contentHash: true },
  });
  if (latest && latest.contentHash === hash) {
    return { sourceVersionId: latest.id, version: latest.version, changed: false, previousSourceVersionId: latest.id };
  }
  const version = (latest?.version ?? 0) + 1;
  const created = await tx.sourceVersion.create({
    data: {
      organizationId: params.organizationId,
      projectId: params.projectId,
      keyId: params.keyId,
      version,
      value: params.value,
      contentHash: hash,
      description: params.description ?? null,
      authorId: params.authorId ?? null,
    },
    select: { id: true },
  });
  return {
    sourceVersionId: created.id,
    version,
    changed: true,
    previousSourceVersionId: latest?.id ?? null,
  };
}

/**
 * Spec §5.3 / §7.2 — when the source changes, every translation that was based on an older
 * source version becomes STALE. Nothing is deleted, and no translation text is touched.
 */
export async function markTranslationsStale(
  tx: Prisma.TransactionClient,
  params: { keyId: string; sourceVersionId: string },
): Promise<number> {
  const result = await tx.translationEntry.updateMany({
    where: {
      keyId: params.keyId,
      OR: [{ basedOnSourceVersionId: null }, { NOT: { basedOnSourceVersionId: params.sourceVersionId } }],
      status: { in: ['APPROVED', 'DRAFT', 'PENDING_REVIEW'] },
    },
    data: { status: 'STALE' },
  });
  return result.count;
}

export interface UpsertTranslationParams {
  organizationId: string;
  projectId: string;
  keyId: string;
  localeId: string;
  localeCode: string;
  value: string;
  status: ReviewStatus;
  basedOnSourceVersionId: string | null;
  authorId?: string | null;
  authorType?: 'user' | 'repository' | 'ai' | 'mcp';
  comment?: string | null;
  /** set when the value came from a repository push */
  repositoryApplied?: boolean;
}

export interface UpsertTranslationResult {
  entryId: string;
  translationVersionId: string | null;
  version: number;
  changed: boolean;
  previousValue: string;
}

/**
 * Create a translation entry or append a new immutable version to it.
 * Returns `changed: false` when the incoming value equals the current one, so repeated
 * pushes (same commit, retried request) never create duplicate versions (spec §7.4).
 */
export async function upsertTranslation(
  tx: Prisma.TransactionClient,
  params: UpsertTranslationParams,
): Promise<UpsertTranslationResult> {
  const hash = contentHash(params.value);
  const existing = await tx.translationEntry.findUnique({
    where: { keyId_localeId: { keyId: params.keyId, localeId: params.localeId } },
    select: { id: true, value: true, contentHash: true, revision: true, currentVersionId: true, status: true },
  });

  if (!existing) {
    const entry = await tx.translationEntry.create({
      data: {
        organizationId: params.organizationId,
        projectId: params.projectId,
        keyId: params.keyId,
        localeId: params.localeId,
        localeCode: params.localeCode,
        value: params.value,
        contentHash: hash,
        status: params.status,
        basedOnSourceVersionId: params.basedOnSourceVersionId,
        updatedById: params.authorId ?? null,
        comment: params.comment ?? null,
        ...(params.repositoryApplied ? { appliedToRepoAt: new Date() } : {}),
      },
      select: { id: true, revision: true },
    });
    const version = await tx.translationVersion.create({
      data: {
        organizationId: params.organizationId,
        projectId: params.projectId,
        entryId: entry.id,
        version: 1,
        value: params.value,
        contentHash: hash,
        status: params.status,
        authorId: params.authorId ?? null,
        authorType: params.authorType ?? 'user',
        basedOnSourceVersionId: params.basedOnSourceVersionId,
        comment: params.comment ?? null,
      },
      select: { id: true },
    });
    await tx.translationEntry.update({ where: { id: entry.id }, data: { currentVersionId: version.id } });
    return { entryId: entry.id, translationVersionId: version.id, version: 1, changed: true, previousValue: '' };
  }

  if (existing.contentHash === hash && existing.status === params.status) {
    return {
      entryId: existing.id,
      translationVersionId: existing.currentVersionId,
      version: 0,
      changed: false,
      previousValue: existing.value,
    };
  }

  const latest = await tx.translationVersion.findFirst({
    where: { entryId: existing.id },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;
  const created = await tx.translationVersion.create({
    data: {
      organizationId: params.organizationId,
      projectId: params.projectId,
      entryId: existing.id,
      version,
      value: params.value,
      contentHash: hash,
      status: params.status,
      authorId: params.authorId ?? null,
      authorType: params.authorType ?? 'user',
      basedOnSourceVersionId: params.basedOnSourceVersionId,
      comment: params.comment ?? null,
    },
    select: { id: true },
  });
  await tx.translationEntry.update({
    where: { id: existing.id },
    data: {
      value: params.value,
      contentHash: hash,
      status: params.status,
      revision: existing.revision + 1,
      currentVersionId: created.id,
      basedOnSourceVersionId: params.basedOnSourceVersionId,
      updatedById: params.authorId ?? null,
      comment: params.comment ?? null,
      // A brand new value has not been written into the repository yet, so any previous
      // "applied" marker is cleared. Only a repository push marks it as applied.
      appliedToRepoAt: params.repositoryApplied ? new Date() : null,
      appliedToRepoCommit: params.repositoryApplied ? null : null,
    },
  });
  return {
    entryId: existing.id,
    translationVersionId: created.id,
    version,
    changed: true,
    previousValue: existing.value,
  };
}

/** Validate that a translation keeps the placeholders of its source (spec §16.1). */
export function assertPlaceholdersPreserved(source: string, target: string, key: string, locale: string): void {
  if (!source) return;
  const sourcePlaceholders = extractPlaceholders(source).map((p) => p.name);
  const targetPlaceholders = new Set(extractPlaceholders(target).map((p) => p.name));
  const missing = sourcePlaceholders.filter((name) => !targetPlaceholders.has(name));
  if (missing.length) {
    throw new LocaleHubError(
      ErrorCode.PLACEHOLDER_MISMATCH,
      `Translation for ${key} (${locale}) is missing placeholders: ${missing.join(', ')}`,
      422,
      { key, locale, missing },
    );
  }
}

export async function nextEntryVersion(tx: Prisma.TransactionClient, entryId: string): Promise<number> {
  const latest = await tx.translationVersion.findFirst({ where: { entryId }, orderBy: { version: 'desc' }, select: { version: true } });
  return (latest?.version ?? 0) + 1;
}
