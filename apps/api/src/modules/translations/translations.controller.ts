import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Role, localeTagSchema, platformSchema, reviewStatusSchema, McpScope } from '@localehub/contracts';
import { z } from 'zod';
import { Actor, RequireRole, RequireScopes, type ActorContext } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { TranslationsService } from './translations.service';

const listSchema = z.object({
  locale: localeTagSchema.optional(),
  platform: platformSchema.optional(),
  status: z.union([reviewStatusSchema, z.literal('UNTRANSLATED'), z.literal('ALL')]).optional(),
  namespace: z.string().optional(),
  search: z.string().max(200).optional(),
  keyPrefix: z.string().max(300).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const draftSchema = z.object({
  value: z.string(),
  expectedRevision: z.number().int().nonnegative().optional(),
  expectedContentHash: z.string().optional(),
  comment: z.string().max(2000).optional(),
});

const reviewSchema = z.object({
  entryIds: z.array(z.string().min(1)).min(1).max(500),
  decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
  comment: z.string().max(2000).optional(),
});

const submitSchema = z.object({
  entryIds: z.array(z.string().min(1)).min(1).max(500),
  comment: z.string().max(2000).optional(),
});

@Controller('projects/:projectId')
export class TranslationsController {
  constructor(private readonly translations: TranslationsService) {}

  @Get('translations')
  async list(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(listSchema)) query: z.infer<typeof listSchema>,
  ) {
    return this.translations.list(actor, projectId, query);
  }

  @Get('translations/stale')
  async stale(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    return this.translations.staleQueue(actor, projectId);
  }

  @Get('translations/:entryId')
  async detail(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Param('entryId') entryId: string) {
    return this.translations.detail(actor, projectId, entryId);
  }

  @Get('translations/:entryId/versions')
  async versions(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Param('entryId') entryId: string) {
    return this.translations.versions(actor, projectId, entryId);
  }

  @Post('translations/:entryId/draft')
  @RequireRole(Role.TRANSLATOR)
  @RequireScopes(McpScope.TRANSLATION_WRITE)
  async saveDraft(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Param('entryId') entryId: string,
    @Body(zodBody(draftSchema)) body: z.infer<typeof draftSchema>,
  ) {
    return this.translations.saveDraft(actor, projectId, entryId, body);
  }

  @Post('translations/submit')
  @RequireRole(Role.TRANSLATOR)
  async submit(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(submitSchema)) body: z.infer<typeof submitSchema>,
  ) {
    return this.translations.submitForReview(actor, projectId, body.entryIds, body.comment);
  }

  @Post('translations/review')
  @RequireRole(Role.REVIEWER)
  @RequireScopes(McpScope.TRANSLATION_REVIEW)
  async review(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(reviewSchema)) body: z.infer<typeof reviewSchema>,
  ) {
    return this.translations.review(actor, projectId, body.entryIds, { decision: body.decision, comment: body.comment });
  }

  @Get('reviews/queue')
  async reviewQueue(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    return this.translations.reviewQueue(actor, projectId);
  }

  @Get('translations/by-key')
  async byKey(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(z.object({ key: z.string().min(1), locale: localeTagSchema }))) query: { key: string; locale: string },
  ) {
    return this.translations.byKey(actor, projectId, query.key, query.locale);
  }
}

export { listSchema, draftSchema, reviewSchema, submitSchema };
