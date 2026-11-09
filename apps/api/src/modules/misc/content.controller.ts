import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Role, McpScope, platformSchema } from '@localehub/contracts';
import { z } from 'zod';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { Actor, RequireRole } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { zodBody } from '../../common/zod.pipe';
import { TranslationsService } from '../translations/translations.service';
import { AiService } from '@localehub/domain';

/**
 * Glossary, translation memory, AI drafting and the platform-wide overview endpoints used by
 * the Remote MCP and the web dashboard.
 */

const glossarySchema = z.object({
  term: z.string().min(1).max(200),
  translations: z.record(z.string()),
  description: z.string().max(2000).optional(),
  caseSensitive: z.boolean().optional(),
});

const tmSearchSchema = z.object({ query: z.string().min(1), locale: z.string().optional(), limit: z.coerce.number().int().positive().max(50).optional() });

const aiTranslateSchema = z.object({
  entryIds: z.array(z.string()).min(1).max(200),
  targetLocales: z.array(z.string()).min(1),
  provider: z.string().optional(),
  writeDrafts: z.boolean().default(true),
});

@Controller()
export class ContentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly translations: TranslationsService,
  ) {}

  /* --------------------------------------------------------------- glossary */

  @Get('projects/:projectId/glossary')
  async glossary(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.glossaryTerm.findMany({ where: { organizationId: actor.organizationId, OR: [{ projectId }, { projectId: null }] }, orderBy: { term: 'asc' } }),
    );
  }

  @Post('projects/:projectId/glossary')
  @RequireRole(Role.PROJECT_MANAGER)
  async addTerm(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Body(zodBody(glossarySchema)) body: z.infer<typeof glossarySchema>) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.glossaryTerm.create({
        data: {
          organizationId: actor.organizationId,
          projectId,
          term: body.term,
          translations: body.translations as never,
          description: body.description ?? null,
          caseSensitive: body.caseSensitive ?? false,
        },
      }),
    );
  }

  /* ------------------------------------------------------ translation memory */

  @Get('projects/:projectId/translation-memory')
  async searchTm(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(tmSearchSchema)) query: z.infer<typeof tmSearchSchema>,
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.translationMemoryEntry.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(query.locale ? { targetLocale: query.locale } : {}),
          sourceText: { contains: query.query, mode: 'insensitive' },
        },
        orderBy: [{ usageCount: 'desc' }, { updatedAt: 'desc' }],
        take: query.limit ?? 10,
      }),
    );
  }

  /* ------------------------------------------------------------------- AI */

  /**
   * AI drafting. The provider is a pluggable adapter; the default "heuristic" provider needs
   * no network and is what the demo uses. AI output is *always* written as DRAFT and can never
   * approve itself (spec §0.1 "AI 审核结果不能绕过人工审核").
   */
  @Post('projects/:projectId/ai/translate')
  @RequireRole(Role.PRODUCT_MANAGER)
  async aiTranslate(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(aiTranslateSchema)) body: z.infer<typeof aiTranslateSchema>,
  ) {
    assertRole(actor, projectId, Role.PRODUCT_MANAGER);
    const service = new AiService(this.prisma);
    return service.draftTranslations(actor, projectId, body);
  }

  @Post('projects/:projectId/ai/review')
  @RequireRole(Role.REVIEWER)
  async aiReview(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Body(zodBody(z.object({ entryIds: z.array(z.string()).min(1).max(200) }))) body: { entryIds: string[] }) {
    assertRole(actor, projectId, Role.REVIEWER);
    const service = new AiService(this.prisma);
    return service.reviewSuggestions(actor, projectId, body.entryIds);
  }

  /* --------------------------------------------------------- organization */

  @Get('organization/overview')
  async overview(@Actor() actor: ActorContext) {
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const [projects, keys, entries, pendingReview, conflicts, members] = await Promise.all([
        tx.project.count(),
        tx.translationKey.count({ where: { archivedAt: null } }),
        tx.translationEntry.count(),
        tx.translationEntry.count({ where: { status: 'PENDING_REVIEW' } }),
        tx.syncConflict.count({ where: { status: 'OPEN' } }),
        tx.membership.count(),
      ]);
      return { projects, keys, entries, pendingReview, conflicts, members };
    });
  }

  @Get('projects/:projectId/keys')
  async keys(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(z.object({ search: z.string().optional(), platform: platformSchema.optional(), limit: z.coerce.number().int().positive().max(200).optional() })))
    query: { search?: string; platform?: string; limit?: number },
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.translationKey.findMany({
        where: {
          projectId,
          archivedAt: null,
          ...(query.platform ? { platform: query.platform as never } : {}),
          ...(query.search ? { key: { contains: query.search, mode: 'insensitive' } } : {}),
        },
        include: {
          namespace: true,
          sourceVersions: { orderBy: { version: 'desc' }, take: 1 },
          entries: { select: { localeCode: true, status: true, value: true } },
        },
        orderBy: { key: 'asc' },
        take: query.limit ?? 100,
      }),
    );
  }

  @Get('projects/:projectId/entry-by-key')
  async entryByKey(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(z.object({ key: z.string().min(1), locale: z.string().min(1) }))) query: { key: string; locale: string },
  ) {
    return this.translations.byKey(actor, projectId, query.key, query.locale);
  }

  @Get('projects/:projectId/audit')
  async audit(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    return this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.auditLog.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 200 }),
    );
  }

  @Get('projects/:projectId/ai/providers')
  async aiProviders(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    void McpScope;
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const providers = await tx.aiProviderConfig.findMany({
        where: { organizationId: actor.organizationId },
        select: { id: true, name: true, kind: true, model: true, enabled: true, isDefault: true, baseUrl: true },
      });
      return providers;
    });
  }
}
