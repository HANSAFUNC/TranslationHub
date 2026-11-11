import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { z } from 'zod';
import type { ActorContext } from '@localehub/permissions';
import { Actor } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { ApiAuth } from '../../openapi/api-auth';
import { OrganizationsService } from './organizations.service';

const settingsSchema = z.object({
  allowDraftApply: z.boolean().optional(),
});

const auditQuerySchema = z.object({
  /** Prefix filter, e.g. `member.` for membership changes only. */
  action: z.string().max(60).optional(),
  /**
   * Who did it. Since the Remote MCP writes to this table too (`actorType: 'mcp'`), this is what
   * separates "a person changed this" from "an agent changed this" — a distinction the page could
   * not make while the only writer was REST.
   */
  actorType: z.enum(['user', 'mcp', 'system']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

@Controller('organization')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  async current(@Actor() actor: ActorContext) {
    return this.organizations.get(actor);
  }

  @ApiAuth({ role: 'ORG_ADMIN', note: 'service 内校验：仅组织所有者 / 管理员' })
  @Get('audit')
  async audit(@Actor() actor: ActorContext, @Query() query: Record<string, string | undefined>) {
    const parsed = auditQuerySchema.parse(query);
    return this.organizations.listAudit(actor, parsed);
  }

  @ApiAuth({ role: 'ORG_ADMIN', note: 'service 内校验：仅组织所有者 / 管理员' })
  @Patch('settings')
  async updateSettings(@Actor() actor: ActorContext, @Body(zodBody(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.organizations.updateSettings(actor, body);
  }
}
