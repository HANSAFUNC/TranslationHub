import { Injectable } from '@nestjs/common';
import type { Prisma } from '@localehub/database';
import {
  ErrorCode,
  LocaleHubError,
  Role,
  contentHash,
  type PlatformName,
  type ReviewStatus,
} from '@localehub/contracts';
import { assertLocaleAllowed, assertRole, type ActorContext } from '@localehub/permissions';
import { assertPlaceholdersPreserved, emitProjectEvent, upsertTranslation } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';

export interface ListEntriesFilters {
  locale?: string;
  platform?: PlatformName;
  status?: ReviewStatus | 'UNTRANSLATED' | 'ALL';
  namespace?: string;
  search?: string;
  keyPrefix?: string;
  cursor?: string;
  limit?: number;
}

@Injectable()
export class TranslationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: ActorContext, projectId: string, filters: ListEntriesFilters) {
    assertRole(actor, projectId, Role.READONLY);
    const limit = Math.min(filters.limit ?? 50, 200);
    const where: Prisma.TranslationEntryWhereInput = {
      projectId,
      ...(filters.locale ? { localeCode: filters.locale } : {}),
      ...(filters.status && filters.status !== 'ALL' && filters.status !== 'UNTRANSLATED'
        ? { status: filters.status as never }
        : {}),
      key: {
        archivedAt: null,
        ...(filters.platform ? { platform: filters.platform as never } : {}),
        ...(filters.namespace ? { namespace: { name: filters.namespace } } : {}),
        ...(filters.search ? { key: { contains: filters.search, mode: 'insensitive' as const } } : {}),
        ...(filters.keyPrefix ? { key: { startsWith: filters.keyPrefix } } : {}),
      },
    };
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.translationEntry.findMany({
          where,
          include: {
            key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } },
            versions: { orderBy: { version: 'desc' }, take: 1 },
          },
          // By key name, then by id to make the order total. Sorting on `keyId` alone was stable
          // but meaningless — it is a UUID, so a page of the editor arrived in random order and
          // paging through it was paging through noise.
          orderBy: [{ localeCode: 'asc' }, { key: { key: 'asc' } }, { id: 'asc' }],
          take: limit + 1,
          ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
        }),
        // The page count is not derivable from a cursor response, and an editor that shows
        // "100 条" when the project holds 8,300 gives the reader no idea where they are.
        tx.translationEntry.count({ where }),
      ]);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map((entry) => this.toListItem(entry)),
        nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
        total,
      };
    });
  }

  private toListItem(entry: {
    id: string;
    localeCode: string;
    value: string;
    contentHash: string;
    status: string;
    revision: number;
    updatedAt: Date;
    appliedToRepoAt: Date | null;
    key: { key: string; platform: string; description: string | null; context: unknown; namespace: { name: string }; sourceVersions: { value: string; contentHash: string }[] };
  }) {
    const source = entry.key.sourceVersions[0];
    return {
      entryId: entry.id,
      key: entry.key.key,
      namespace: entry.key.namespace.name,
      platform: entry.key.platform,
      locale: entry.localeCode,
      value: entry.value,
      contentHash: entry.contentHash,
      status: entry.status,
      revision: entry.revision,
      description: entry.key.description,
      context: entry.key.context,
      source: source?.value ?? null,
      sourceHash: source?.contentHash ?? null,
      appliedToRepoAt: entry.appliedToRepoAt?.toISOString() ?? null,
      updatedAt: entry.updatedAt.toISOString(),
    };
  }

  async detail(actor: ActorContext, projectId: string, entryId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const entry = await tx.translationEntry.findUnique({
        where: { id: entryId },
        include: {
          key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' } } } },
          versions: { orderBy: { version: 'desc' }, take: 20 },
        },
      });
      if (!entry || entry.projectId !== projectId) {
        throw new LocaleHubError(ErrorCode.NOT_FOUND, `Translation entry ${entryId} not found`, 404);
      }
      const qaIssues = await tx.qaIssue.findMany({ where: { entryId, status: 'OPEN' }, take: 20 });
      return {
        ...this.toListItem(entry as never),
        sourceVersions: entry.key.sourceVersions.map((source) => ({
          id: source.id,
          version: source.version,
          value: source.value,
          contentHash: source.contentHash,
          createdAt: source.createdAt.toISOString(),
        })),
        versions: entry.versions.map((version) => ({
          id: version.id,
          version: version.version,
          value: version.value,
          status: version.status,
          authorId: version.authorId,
          authorType: version.authorType,
          comment: version.comment,
          basedOnSourceVersionId: version.basedOnSourceVersionId,
          createdAt: version.createdAt.toISOString(),
        })),
        qaIssues: qaIssues.map((issue) => ({
          id: issue.id,
          ruleCode: issue.ruleCode,
          severity: issue.severity,
          message: issue.message,
          status: issue.status,
        })),
      };
    });
  }

  /** Save a draft translation as a new immutable version (never overwrites history). */
  async saveDraft(
    actor: ActorContext,
    projectId: string,
    entryId: string,
    input: { value: string; expectedRevision?: number; comment?: string; expectedContentHash?: string },
  ) {
    assertRole(actor, projectId, Role.TRANSLATOR);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const entry = await tx.translationEntry.findUnique({
        where: { id: entryId },
        include: { key: { include: { sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
      });
      if (!entry || entry.projectId !== projectId) {
        throw new LocaleHubError(ErrorCode.NOT_FOUND, `Translation entry ${entryId} not found`, 404);
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== entry.revision) {
        throw new LocaleHubError(
          ErrorCode.CONFLICT,
          `Entry was modified by someone else (expected revision ${input.expectedRevision}, current ${entry.revision})`,
          409,
          { currentRevision: entry.revision },
        );
      }
      const member = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: actor.userId } } });
      assertLocaleAllowed(member?.localeScope, entry.localeCode);

      const source = entry.key.sourceVersions[0]?.value ?? '';
      assertPlaceholdersPreserved(source, input.value, entry.key.key, entry.localeCode);

      const result = await upsertTranslation(tx, {
        organizationId: actor.organizationId,
        projectId,
        keyId: entry.keyId,
        localeId: entry.localeId,
        localeCode: entry.localeCode,
        value: input.value,
        status: 'DRAFT',
        basedOnSourceVersionId: entry.key.sourceVersions[0]?.id ?? null,
        authorId: actor.userId,
        authorType: actor.actorType === 'mcp' ? 'mcp' : 'user',
        comment: input.comment ?? null,
      });

      await emitProjectEvent(tx, {
        organizationId: actor.organizationId,
        projectId,
        eventType: 'TRANSLATION_UPDATED',
        resourceType: 'translation_entry',
        resourceId: entryId,
        payload: { entryId, key: entry.key.key, locale: entry.localeCode, platform: entry.key.platform, status: 'DRAFT' },
        actorId: actor.userId,
        actorType: actor.actorType ?? 'user',
      });

      return { entryId, translationVersionId: result.translationVersionId, revision: entry.revision + 1, status: 'DRAFT' as const };
    });
  }

  async submitForReview(actor: ActorContext, projectId: string, entryIds: string[], comment?: string) {
    assertRole(actor, projectId, Role.TRANSLATOR);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      let submitted = 0;
      for (const entryId of entryIds) {
        const entry = await tx.translationEntry.findUnique({ where: { id: entryId }, include: { key: true } });
        if (!entry || entry.projectId !== projectId) continue;
        await tx.translationEntry.update({ where: { id: entryId }, data: { status: 'PENDING_REVIEW' } });
        await tx.reviewTask.create({
          data: {
            organizationId: actor.organizationId,
            projectId,
            entryId,
            localeCode: entry.localeCode,
            status: 'PENDING_REVIEW',
            submittedById: actor.userId,
          },
        });
        await emitProjectEvent(tx, {
          organizationId: actor.organizationId,
          projectId,
          eventType: 'TRANSLATION_SUBMITTED',
          resourceType: 'translation_entry',
          resourceId: entryId,
          payload: { entryId, key: entry.key.key, locale: entry.localeCode, platform: entry.key.platform, comment: comment ?? null },
          actorId: actor.userId,
          actorType: actor.actorType ?? 'user',
        });
        submitted += 1;
      }
      return { submitted };
    });
  }

  /**
   * Approve or reject a translation.
   *
   * Approving bumps the project revision and appends a TRANSLATION_APPROVED event, which is
   * exactly what the CLI pulls (spec §3.3 step 4). AI results can never bypass this.
   */
  async review(
    actor: ActorContext,
    projectId: string,
    entryIds: string[],
    input: { decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES'; comment?: string },
  ) {
    assertRole(actor, projectId, Role.REVIEWER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const results: { entryId: string; status: ReviewStatus; revision: number }[] = [];
      for (const entryId of entryIds) {
        const entry = await tx.translationEntry.findUnique({ where: { id: entryId }, include: { key: true } });
        if (!entry || entry.projectId !== projectId) continue;
        if (entry.status === 'STALE' && input.decision === 'APPROVE') {
          throw new LocaleHubError(
            ErrorCode.STALE_TRANSLATION,
            `Translation for ${entry.key.key} (${entry.localeCode}) is stale: the source changed after it was written`,
            409,
            { entryId },
          );
        }
        const nextStatus: ReviewStatus =
          input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'DRAFT';
        await tx.translationEntry.update({ where: { id: entryId }, data: { status: nextStatus as never, revision: entry.revision + 1 } });
        await tx.reviewTask.create({
          data: {
            organizationId: actor.organizationId,
            projectId,
            entryId,
            localeCode: entry.localeCode,
            status: nextStatus as never,
            assigneeId: actor.userId,
            completedAt: new Date(),
            actions: {
              create: {
                actorId: actor.userId,
                decision: input.decision,
                comment: input.comment ?? null,
                entryVersion: entry.revision + 1,
              },
            },
          },
        });
        const revision = await emitProjectEvent(tx, {
          organizationId: actor.organizationId,
          projectId,
          eventType:
            input.decision === 'APPROVE' ? 'TRANSLATION_APPROVED' : input.decision === 'REJECT' ? 'TRANSLATION_REJECTED' : 'TRANSLATION_UPDATED',
          resourceType: 'translation_entry',
          resourceId: entryId,
          payload: {
            entryId,
            key: entry.key.key,
            locale: entry.localeCode,
            platform: entry.key.platform,
            namespace: entry.key.namespaceId,
            contentHash: entry.contentHash,
            decision: input.decision,
          },
          actorId: actor.userId,
          actorType: actor.actorType ?? 'user',
        });
        results.push({ entryId, status: nextStatus, revision });
      }
      return { results };
    });
  }

  async versions(actor: ActorContext, projectId: string, entryId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.translationVersion.findMany({
        where: { entryId, projectId },
        orderBy: { version: 'desc' },
        take: 100,
        include: { entry: { select: { localeCode: true } } },
      }),
    );
  }

  async reviewQueue(actor: ActorContext, projectId: string, limit = 50) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const rows = await tx.translationEntry.findMany({
        where: { projectId, status: { in: ['PENDING_REVIEW', 'DRAFT'] } },
        include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } }, versions: { orderBy: { version: 'desc' }, take: 1 } },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });
      return rows.map((entry) => this.toListItem(entry as never));
    });
  }

  async staleQueue(actor: ActorContext, projectId: string, limit = 100) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const rows = await tx.translationEntry.findMany({
        where: { projectId, status: 'STALE' },
        include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } }, versions: { orderBy: { version: 'desc' }, take: 1 } },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });
      return rows.map((entry) => this.toListItem(entry as never));
    });
  }

  async byKey(actor: ActorContext, projectId: string, key: string, locale: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const entry = await tx.translationEntry.findFirst({
        where: { projectId, localeCode: locale, key: { key } },
        include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } }, versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      if (!entry) throw new LocaleHubError(ErrorCode.NOT_FOUND, `No entry for ${key} in ${locale}`, 404);
      return this.toListItem(entry as never);
    });
  }

  async assertEntryHash(projectId: string, organizationId: string, entryId: string, expectedHash: string): Promise<void> {
    await this.prisma.tenant.withOrganization(organizationId, async (tx) => {
      const entry = await tx.translationEntry.findUnique({ where: { id: entryId }, select: { contentHash: true, projectId: true } });
      if (!entry || entry.projectId !== projectId) {
        throw new LocaleHubError(ErrorCode.NOT_FOUND, `Translation entry ${entryId} not found`, 404);
      }
      if (entry.contentHash !== expectedHash) {
        throw new LocaleHubError(ErrorCode.REVISION_MISMATCH, 'Entry content changed; reload before saving', 409);
      }
    });
  }

  static hashOf(value: string): string {
    return contentHash(value);
  }
}
