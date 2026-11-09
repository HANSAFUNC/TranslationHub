import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { McpScope, Role, localeTagSchema } from '@localehub/contracts';
import { z } from 'zod';
import { Actor, RequireRole, RequireScopes, type ActorContext } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { QaService } from './qa.service';

const runSchema = z.object({
  locale: localeTagSchema.optional(),
  entryIds: z.array(z.string()).max(2000).optional(),
  enabledRules: z.array(z.string()).optional(),
  disabledRules: z.array(z.string()).optional(),
});

const issueQuerySchema = z.object({
  locale: localeTagSchema.optional(),
  severity: z.enum(['ERROR', 'WARNING', 'INFO']).optional(),
  status: z.enum(['OPEN', 'RESOLVED', 'IGNORED']).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

@Controller('projects/:projectId/qa')
export class QaController {
  constructor(private readonly qa: QaService) {}

  @Get('rules')
  async rules(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    void projectId;
    void actor;
    return this.qa.rules();
  }

  @Post('run')
  @RequireRole(Role.TRANSLATOR)
  @RequireScopes(McpScope.QA_EXECUTE)
  async run(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Body(zodBody(runSchema)) body: z.infer<typeof runSchema>) {
    return this.qa.run(actor, projectId, body);
  }

  @Get('issues')
  async issues(@Actor() actor: ActorContext, @Param('projectId') projectId: string, @Query(zodBody(issueQuerySchema)) query: z.infer<typeof issueQuerySchema>) {
    return this.qa.listIssues(actor, projectId, query);
  }

  @Get('report')
  async report(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    return this.qa.report(actor, projectId);
  }
}
