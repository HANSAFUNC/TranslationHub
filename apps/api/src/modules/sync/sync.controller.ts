import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import {
  McpScope,
  Role,
  applyReportSchema,
  localeTagSchema,
  reviewStatusSchema,
  scanBatchSchema,
  resolveConflictSchema,
  syncPreviewSchema,
  syncPushSchema,
} from '@localehub/contracts';
import { z } from 'zod';
import { assertRole, type ActorContext } from '@localehub/permissions';
import { Actor, RequireRole, RequireScopes } from '../../common/auth';
import { AuditService } from '../../common/audit.service';
import { zodBody } from '../../common/zod.pipe';
import { SyncService } from '@localehub/domain';
import { OrganizationsService } from '../organizations/organizations.service';
import { WebhooksService } from '../webhooks/webhooks.service';

const changesQuerySchema = z.object({
  locale: z.union([z.string(), z.array(z.string())]).optional(),
  status: z.union([reviewStatusSchema, z.array(reviewStatusSchema)]).optional(),
  since_revision: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
  connection_id: z.string().optional(),
});

const connectionSchema = z.object({
  name: z.string().min(1).max(120),
  provider: z.enum(['github', 'gitlab', 'bitbucket', 'azure_devops', 'local']).default('local'),
  repoUrl: z.string().url().optional(),
  defaultBranch: z.string().max(200).default('main'),
});

const conflictsQuerySchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED', 'DEFERRED']).optional(),
  locale: localeTagSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

@Controller()
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly audit: AuditService,
    private readonly organizations: OrganizationsService,
  
    private readonly webhooks: WebhooksService,
  ) {}

  /** Statuses that only an opted-in organization may pull into a repository. */
  private static readonly UNAPPROVED = ['DRAFT', 'PENDING_REVIEW'];

  /* -------------------------------------------------- repository connections */

  @Get('projects/:projectId/repository-connections')
  async listConnections(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    const status = await this.sync.syncStatus(projectId, actor);
    return status;
  }

  @Post('projects/:projectId/repository-connections')
  @RequireRole(Role.PROJECT_MANAGER)
  async createConnection(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(connectionSchema)) body: z.infer<typeof connectionSchema>,
  ) {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    const connection = await this.sync.createConnection(projectId, body, actor);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'repository_connection.create',
      resourceType: 'repository_connection',
      resourceId: connection.id,
      projectId,
    });
    return connection;
  }

  @Get('projects/:projectId/sync/status')
  async status(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.sync.syncStatus(projectId, actor);
  }

  /** Organization-wide recent sync sessions (dashboard widget). */
  @Get('sync/recent-sessions')
  async recentSessions(
    @Actor() actor: ActorContext,
    @Query(zodBody(z.object({ limit: z.coerce.number().int().positive().max(100).optional() }))) query: { limit?: number },
  ) {
    return this.sync.listRecentSessions(actor, query.limit ?? 20);
  }

  @Get('projects/:projectId/sync/sessions')
  async sessions(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.READONLY);
    return this.sync.listSessions(projectId, actor);
  }

  /* ---------------------------------------------------------------- scanning */

  @Post('sync/scans')
  @RequireScopes(McpScope.REPOSITORY_SCAN)
  @RequireRole(Role.DEVELOPER)
  async uploadScan(@Actor() actor: ActorContext, @Body(zodBody(scanBatchSchema)) body: z.infer<typeof scanBatchSchema>) {
    assertRole(actor, body.projectId, Role.DEVELOPER);
    const result = await this.sync.recordScan(body.projectId, body as never, actor);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'mcp',
      mcpClientId: actor.mcpClientId,
      action: 'sync.scan',
      resourceType: 'sync_scan',
      resourceId: body.scanId,
      projectId: body.projectId,
      repositoryConnectionId: result.connectionId,
      metadata: { files: result.fileCount, entries: result.entryCount, gitCommit: body.client?.gitCommit },
    });
    return result;
  }

  /* ---------------------------------------------------------- preview & push */

  @Post('sync/preview')
  @RequireScopes(McpScope.SYNC_PREVIEW)
  @RequireRole(Role.DEVELOPER)
  async preview(
    @Actor() actor: ActorContext,
    @Body(zodBody(syncPreviewSchema)) body: z.infer<typeof syncPreviewSchema>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    assertRole(actor, body.projectId, Role.DEVELOPER);
    if (body.includeDrafts) {
      await this.organizations.assertDraftApplyAllowed(actor);
    }
    const result = await this.sync.createPreview(
      {
        projectId: body.projectId,
        connectionId: body.repositoryConnectionId,
        scanId: body.scanId,
        direction: body.direction,
        baseRevision: body.baseRevision,
        includeDeletes: body.includeDeletes,
        includeDrafts: body.includeDrafts,
        locales: body.locales,
      },
      actor,
    );
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'mcp',
      mcpClientId: actor.mcpClientId,
      action: 'sync.preview',
      resourceType: 'sync_plan',
      resourceId: result.planId,
      projectId: body.projectId,
      repositoryConnectionId: body.repositoryConnectionId,
      syncSessionId: result.sessionId,
      metadata: { summary: result.plan.summary, idempotencyKey, planHash: result.planHash },
    });
    return {
      syncPlanId: result.planId,
      planHash: result.planHash,
      expiresAt: result.expiresAt,
      sessionId: result.sessionId,
      summary: result.plan.summary,
      plan: result.plan,
      conflicts: result.conflicts,
      requiresConfirmation: true,
    };
  }

  @Post('sync/push')
  @RequireScopes(McpScope.SYNC_PUSH)
  @RequireRole(Role.DEVELOPER)
  async push(
    @Actor() actor: ActorContext,
    @Body(zodBody(syncPushSchema)) body: z.infer<typeof syncPushSchema>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // The route has no project id, so the project-scoped role check happens here.
    const plan = await this.sync.getPlanSummary(body.syncPlanId, actor);
    assertRole(actor, plan.projectId, Role.DEVELOPER);
    const startedAt = Date.now();
    const result = await this.sync.push(
      {
        syncPlanId: body.syncPlanId,
        planHash: body.planHash,
        client: body.client,
        idempotencyKey: idempotencyKey ?? `${body.syncPlanId}:${body.planHash}`,
      },
      actor,
    );
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'mcp',
      mcpClientId: actor.mcpClientId,
      action: 'sync.push',
      resourceType: 'sync_session',
      resourceId: result.syncSessionId,
      syncSessionId: result.syncSessionId,
      metadata: { summary: result.summary, idempotentReplay: result.idempotentReplay, planHash: body.planHash },
      durationMs: Date.now() - startedAt,
    });
    // Published after the audit row, never instead of it: the audit log is the system of record,
    // webhooks are a notification. An idempotent replay of the same plan is not a new event.
    if (!result.idempotentReplay) {
      await this.webhooks.publish({
        organizationId: actor.organizationId,
        type: 'SYNC_PUSHED',
        // The push body names only the plan and `PushResult` does not repeat the project id, so it
        // comes from the plan itself — not a cast on the result, which would be a guess.
        projectId: (await this.sync.getPlanSummary(body.syncPlanId, actor)).projectId,
        data: { syncSessionId: result.syncSessionId, summary: result.summary, planHash: body.planHash },
      });
    }
    return result;
  }

  @Get('sync/sessions/:id')
  async session(@Actor() actor: ActorContext, @Param('id') id: string) {
    return this.sync.getSession(id, actor);
  }

  @Get('sync/sessions/:id/items')
  async sessionItems(@Actor() actor: ActorContext, @Param('id') id: string) {
    const session = await this.sync.getSession(id, actor);
    return session.items;
  }

  /* ---------------------------------------------------------------- baselines */

  @Get('projects/:projectId/sync/baseline')
  async baseline(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(
      zodBody(
        z.object({
          connection_id: z.string().optional(),
          since_revision: z.coerce.number().optional(),
          locales: z.union([z.string(), z.array(z.string())]).optional(),
        }),
      ),
    )
    query: { connection_id?: string; since_revision?: number; locales?: string | string[] },
  ) {
    assertRole(actor, projectId, Role.DEVELOPER);
    const connectionId = query.connection_id ?? (await this.sync.syncStatus(projectId, actor)).connection?.id;
    if (!connectionId) return { baselines: [], revision: 0 };
    const locales = Array.isArray(query.locales) ? query.locales : query.locales ? [query.locales] : undefined;
    return this.sync.getBaselines({ projectId, connectionId, sinceRevision: query.since_revision, locales }, actor);
  }

  /* ------------------------------------------------------------------ changes */

  @Get('projects/:projectId/sync/changes')
  async changes(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(changesQuerySchema)) query: z.infer<typeof changesQuerySchema>,
  ) {
    assertRole(actor, projectId, Role.DEVELOPER);
    const locales = Array.isArray(query.locale) ? query.locale : query.locale ? [query.locale] : undefined;
    const statuses = Array.isArray(query.status) ? query.status : [query.status ?? 'APPROVED'];
    if (statuses.some((status) => SyncController.UNAPPROVED.includes(status))) {
      await this.organizations.assertDraftApplyAllowed(actor);
    }
    return this.sync.getChanges(
      {
        projectId,
        connectionId: query.connection_id,
        locales,
        statuses: statuses as never,
        sinceRevision: query.since_revision,
        limit: query.limit ?? 200,
      },
      actor,
    );
  }

  /* ------------------------------------------------------------ apply reports */

  @Post('sync/apply-reports')
  @RequireScopes(McpScope.TRANSLATION_APPLY)
  @RequireRole(Role.DEVELOPER)
  async applyReport(@Actor() actor: ActorContext, @Body(zodBody(applyReportSchema)) body: z.infer<typeof applyReportSchema>) {
    const result = await this.sync.reportApply(body as never, actor);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType ?? 'mcp',
      mcpClientId: actor.mcpClientId,
      action: 'sync.apply',
      resourceType: 'sync_apply_report',
      resourceId: body.applyPlanId,
      syncSessionId: body.syncSessionId,
      metadata: { status: body.status, files: body.files.length, items: body.items.length, gitCommit: body.gitCommit },
    });
    return result;
  }

  /* ---------------------------------------------------------------- conflicts */

  @Get('sync/conflicts')
  async conflicts(
    @Actor() actor: ActorContext,
    @Query(zodBody(conflictsQuerySchema.extend({ projectId: z.string().min(1) })))
    query: z.infer<typeof conflictsQuerySchema> & { projectId: string },
  ) {
    assertRole(actor, query.projectId, Role.READONLY);
    return this.sync.listConflicts(
      { projectId: query.projectId, status: query.status, locale: query.locale, limit: query.limit },
      actor,
    );
  }

  @Get('sync/conflicts/:id')
  async conflict(@Actor() actor: ActorContext, @Param('id') id: string) {
    return this.sync.getConflict(id, actor);
  }

  @Post('sync/conflicts/:id/resolve')
  @RequireRole(Role.DEVELOPER)
  async resolve(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body(zodBody(resolveConflictSchema)) body: z.infer<typeof resolveConflictSchema>,
  ) {
    const record = await this.sync.getConflict(id, actor);
    assertRole(actor, record.projectId, Role.DEVELOPER);
    const result = await this.sync.resolveConflict(id, body, actor);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'sync.conflict.resolve',
      resourceType: 'sync_conflict',
      resourceId: id,
      projectId: record.projectId,
      metadata: { resolution: body.resolution, note: body.note },
    });
    return result;
  }

  /* ------------------------------------------------------------- project events */

  @Get('projects/:projectId/events')
  async events(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(
      zodBody(
        z.object({
          since_revision: z.coerce.number().int().nonnegative().optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
        }),
      ),
    )
    query: { since_revision?: number; limit?: number },
  ) {
    assertRole(actor, projectId, Role.READONLY);
    return this.sync.listEvents(projectId, actor, query.since_revision, query.limit ?? 100);
  }

  /* ------------------------------------------------------------- validation */

  @Post('projects/:projectId/sync/validate')
  @RequireRole(Role.DEVELOPER)
  async validate(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    assertRole(actor, projectId, Role.DEVELOPER);
    return this.sync.validateForRelease(projectId, actor);
  }
}
