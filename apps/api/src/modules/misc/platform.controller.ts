import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ErrorCode,
  LocaleHubError,
  Role,
  REMOTE_MCP_PROMPTS,
  canonicalizeLocaleTag,
  exportFormatSchema,
  localeTagSchema,
  selectDeliverableSkills,
} from '@localehub/contracts';
import { z } from 'zod';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { createAdapter } from '@localehub/format-adapters';
import {
  buildReleaseBundle,
  bundleExists,
  emitProjectEvent,
  readBundle,
  snapshotFiles,
  writeBundle,
} from '@localehub/domain';
import { Actor, RequireRole, type AuthenticatedRequest } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { QueueService, QUEUE_NAMES } from '../../common/queue.service';
import { zodBody } from '../../common/zod.pipe';
import { RawResponse } from '../../common/response.interceptor';
import { ApiAuth } from '../../openapi/api-auth';

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
  format: exportFormatSchema.default('json'),
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

  /**
   * Build the release bundle: one zip per release, written to the bundle directory.
   *
   * Spec §8.4 asks for pre-signed URLs rather than Base64 inside a JSON body. A directory keyed by
   * organization and release id gives the same property — the download is a separate request and
   * the bytes never travel through JSON — and swapping in S3 later means replacing one module.
   *
   * Deterministic: the same snapshots always produce the same archive, so the checksum recorded on
   * the release row can be re-verified by whoever downloads it.
   */
  @ApiAuth({ role: 'PROJECT_MANAGER', note: 'guard 的 @RequireRole 在本路由带 projectId 时生效' })
  @Post('projects/:projectId/releases/:releaseId/bundle')
  @RequireRole(Role.PROJECT_MANAGER)
  async buildBundle(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Param('releaseId') releaseId: string,
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    const release = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.release.findFirst({
        where: { id: releaseId, projectId },
        include: { snapshots: true },
      }),
    );
    if (!release) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Release ${releaseId} not found`, 404);
    if (!release.snapshots.length) {
      throw new LocaleHubError(ErrorCode.CONFLICT, 'This release has no snapshots to bundle', 409);
    }

    const files = snapshotFiles(release.snapshots);
    const archive = buildReleaseBundle(
      {
        releaseName: release.name,
        locales: release.locales,
        generatedAt: release.publishedAt ?? release.createdAt,
        source: { releaseId: release.id, projectId, checksum: release.snapshotChecksum },
      },
      files,
    );
    const written = writeBundle(actor.organizationId, release.id, archive);

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'user',
      action: 'release.bundle',
      resourceType: 'release',
      resourceId: release.id,
      projectId,
      metadata: { files: files.length, bytes: written.bytes },
    });

    return {
      releaseId: release.id,
      files: files.map((file) => file.path),
      bytes: written.bytes,
      downloadPath: `/api/v1/projects/${projectId}/releases/${release.id}/bundle`,
    };
  }

  /** Download a built bundle. Raw bytes: a zip wrapped in the JSON envelope is not a zip. */
  @RawResponse()
  @Get('projects/:projectId/releases/:releaseId/bundle')
  async downloadBundle(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Param('releaseId') releaseId: string,
    @Res() response: Response,
  ) {
    assertRole(actor, projectId, Role.READONLY);
    // Ownership is checked against the release row rather than trusted from the path, so a release
    // id from another project — or another organization — cannot be fetched by guessing.
    const release = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.release.findFirst({ where: { id: releaseId, projectId }, select: { id: true, name: true } }),
    );
    if (!release) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Release ${releaseId} not found`, 404);
    if (!bundleExists(actor.organizationId, releaseId)) {
      throw new LocaleHubError(
        ErrorCode.NOT_FOUND,
        'No bundle has been built for this release yet; POST to this path first',
        404,
      );
    }
    const archive = readBundle(actor.organizationId, releaseId)!;
    response.setHeader('content-type', 'application/zip');
    response.setHeader('content-length', String(archive.length));
    response.setHeader(
      'content-disposition',
      `attachment; filename="${release.name.replace(/[^\w.-]+/g, '_')}.zip"`,
    );
    response.end(archive);
  }

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
    // `encoding` tells the client how to read `content`: text formats are inline, .xlsx is
    // base64 because it is a zip archive. A single response shape beats two endpoints.
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
    const result = await this.queue.enqueue(
      QUEUE_NAMES.QA,
      'qa.run',
      { organizationId: actor.organizationId, projectId, locale: body.locale, requestedBy: actor.userId },
      // A job id becomes part of a Redis key, so it cannot contain ':'. Dots and dashes read
      // just as well and BullMQ accepts them.
      { jobId: `qa-${projectId}-${body.locale ?? 'all'}-${Date.now()}` },
    );
    // `enqueue` reports failure instead of throwing so a request can still succeed, but an
    // accepted-looking response for a job that was never queued is how this went unnoticed.
    if (!result.queued) {
      throw new LocaleHubError(
        ErrorCode.INTERNAL_ERROR,
        'Could not queue the QA run; the queue is unavailable. Retry, or run QA synchronously.',
        503,
      );
    }
    return result;
  }

  /**
   * Queue health.
   *
   * Was `@Public()`: it leaked internal queue names and backlog to anyone who could reach the
   * host. Liveness and readiness probes use `/health` and `/health/ready`, which stay public, so
   * this can require a platform admin.
   *
   * The check is written out because the route carries no `projectId` — a `@RequireRole`
   * decorator here would decide nothing (docs/STATUS.md §1.11, §1.15).
   */
  @Get('system/queues')
  async queues(@Actor() actor: ActorContext) {
    if (!actor.isPlatformAdmin) {
      throw new LocaleHubError(
        ErrorCode.ROLE_INSUFFICIENT,
        'Platform administrator is required to read queue health',
        403,
      );
    }
    return this.queue.health();
  }
}

export type { AuthenticatedRequest };
