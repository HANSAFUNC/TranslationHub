import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ErrorCode,
  LocaleHubError,
  Role,
  REMOTE_MCP_PROMPTS,
  canonicalizeLocaleTag,
  formatIdSchema,
  localeTagSchema,
  selectDeliverableSkills,
} from '@localehub/contracts';
import { z } from 'zod';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { createAdapter } from '@localehub/format-adapters';
import { emitProjectEvent } from '@localehub/domain';
import { Actor, Public, RequireRole, type AuthenticatedRequest } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { QueueService, QUEUE_NAMES } from '../../common/queue.service';
import { zodBody } from '../../common/zod.pipe';

const skillSchema = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  kind: z.enum(['PROMPT', 'SCRIPT']).default('PROMPT'),
  version: z.string().max(40).default('1.0.0'),
  content: z.string().min(1),
  manifest: z.record(z.unknown()).default({}),
});

const releaseSchema = z.object({
  name: z.string().min(1).max(120),
  locales: z.array(localeTagSchema).min(1),
});

const exportSchema = z.object({
  locale: localeTagSchema,
  format: formatIdSchema.default('json'),
  platform: z.enum(['web', 'ios', 'android', 'universal']).default('web'),
  namespace: z.string().optional(),
});

@Controller()
export class PlatformController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  /* ------------------------------------------------------------------ skills */

  /**
   * Every registered skill, annotated with what a client can actually reach.
   *
   * The table lists all versions and statuses (that is what a registry page is for), but MCP only
   * ever delivers one entry per slug — the highest PUBLISHED version — and only PROMPT-kind skills
   * become invocable prompts. Computing that here, with the same `selectDeliverableSkills` the two
   * MCP servers use, is what keeps this page from advertising a handle that no server registers.
   */
  @Get('skills')
  async listSkills(@Actor() actor: ActorContext) {
    const rows = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.skill.findMany({
        where: { OR: [{ organizationId: actor.organizationId }, { organizationId: null }] },
        orderBy: [{ slug: 'asc' }, { version: 'desc' }],
      }),
    );
    const delivered = new Map(
      selectDeliverableSkills(rows, { reservedPromptNames: REMOTE_MCP_PROMPTS }).map((skill) => [skill.slug, skill]),
    );
    return rows.map((row) => {
      const served = delivered.get(row.slug);
      return {
        ...row,
        mcp: served && served.version === row.version ? { resourceUri: served.resourceUri, promptName: served.promptName } : null,
      };
    });
  }

  @Post('skills')
  @RequireRole(Role.PROJECT_MANAGER)
  async createSkill(@Actor() actor: ActorContext, @Body(zodBody(skillSchema)) body: z.infer<typeof skillSchema>) {
    if (actor.kind !== 'user') {
      throw new LocaleHubError(ErrorCode.SCOPE_INSUFFICIENT, 'Only interactive sessions may publish skills', 403);
    }
    assertRole(actor, '', Role.PROJECT_MANAGER);
    const skill = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.skill.create({
        data: {
          organizationId: actor.organizationId,
          slug: body.slug,
          name: body.name,
          description: body.description ?? null,
          kind: body.kind,
          version: body.version,
          // Script skills are never executed inside the API process (spec §0.3).
          content: body.content,
          manifest: body.manifest as never,
          createdById: actor.userId,
        },
      }),
    );
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'skill.create',
      resourceType: 'skill',
      resourceId: skill.id,
      metadata: { slug: skill.slug, version: skill.version, kind: skill.kind },
    });
    return skill;
  }

  /* ---------------------------------------------------------------- releases */

  @Get('projects/:projectId/releases')
  async listReleases(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.release.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    );
  }

  @Post('projects/:projectId/releases')
  @RequireRole(Role.PROJECT_MANAGER)
  async createRelease(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(releaseSchema)) body: z.infer<typeof releaseSchema>,
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const entries = await tx.translationEntry.findMany({
        where: { projectId, status: 'APPROVED', localeCode: { in: body.locales.map(canonicalizeLocaleTag) } },
        include: { key: { include: { namespace: true } } },
      });
      const release = await tx.release.create({
        data: {
          organizationId: actor.organizationId,
          projectId,
          name: body.name,
          status: 'VALIDATED',
          locales: body.locales,
          keyCount: entries.length,
          createdById: actor.userId,
        },
      });
      if (entries.length) {
        await tx.releaseSnapshot.createMany({
          data: entries.map((entry) => ({
            organizationId: actor.organizationId,
            releaseId: release.id,
            translationKey: entry.key.key,
            localeCode: entry.localeCode,
            platform: entry.key.platform,
            namespace: entry.key.namespace.name,
            value: entry.value,
            sourceVersionId: entry.basedOnSourceVersionId,
            translationVersionId: entry.currentVersionId,
            contentHash: entry.contentHash,
          })),
        });
      }
      await emitProjectEvent(tx, {
        organizationId: actor.organizationId,
        projectId,
        eventType: 'RELEASE_PUBLISHED',
        resourceType: 'release',
        resourceId: release.id,
        payload: { name: release.name, locales: body.locales, keys: entries.length },
        actorId: actor.userId,
        actorType: 'user',
      });
      return { ...release, snapshotCount: entries.length };
    });
  }

  /* ------------------------------------------------------------ import/export */

  @Get('projects/:projectId/export')
  async export(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(exportSchema)) query: z.infer<typeof exportSchema>,
  ) {
    assertRole(actor, projectId, Role.READONLY);
    const adapter = createAdapter(query.format);
    const entries = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.translationEntry.findMany({
        where: {
          projectId,
          localeCode: query.locale,
          status: 'APPROVED',
          key: {
            platform: query.platform,
            archivedAt: null,
            ...(query.namespace ? { namespace: { name: query.namespace } } : {}),
          },
        },
        include: { key: { include: { namespace: true } } },
      }),
    );
    const files = await adapter.serialize(
      entries.map((entry) => ({
        projectId,
        platform: entry.key.platform as never,
        namespace: entry.key.namespace.name,
        key: entry.key.key,
        locale: entry.localeCode,
        value: entry.value,
        isSource: false,
        fileId: `${query.platform}-${query.locale}`,
        filePath: `localehub/${query.locale}/${entry.key.namespace.name || 'common'}.${query.format === 'json' ? 'json' : query.format}`,
        contentHash: entry.contentHash,
      })),
    );
    return { files, entryCount: entries.length };
  }

  /* ------------------------------------------------------------------- queue */

  @Post('projects/:projectId/qa/run-async')
  @RequireRole(Role.TRANSLATOR)
  async runQaAsync(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(z.object({ locale: localeTagSchema.optional() }))) body: { locale?: string },
  ) {
    assertRole(actor, projectId, Role.TRANSLATOR);
    return this.queue.enqueue(
      QUEUE_NAMES.QA,
      'qa.run',
      { organizationId: actor.organizationId, projectId, locale: body.locale, requestedBy: actor.userId },
      { jobId: `qa:${projectId}:${body.locale ?? 'all'}:${Date.now()}` },
    );
  }

  @Public()
  @Get('system/queues')
  async queues() {
    return this.queue.health();
  }
}

export type { AuthenticatedRequest };
