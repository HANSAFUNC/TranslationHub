import { Body, Controller, Get, Patch } from '@nestjs/common';
import { z } from 'zod';
import type { ActorContext } from '@localehub/permissions';
import { Actor } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { ApiAuth } from '../../openapi/api-auth';
import { OrganizationsService } from './organizations.service';

const settingsSchema = z.object({
  allowDraftApply: z.boolean().optional(),
});

@Controller('organization')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  async current(@Actor() actor: ActorContext) {
    return this.organizations.get(actor);
  }

  @ApiAuth({ role: 'ORG_ADMIN', note: 'service 内校验：仅组织所有者 / 管理员' })
  @Patch('settings')
  async updateSettings(@Actor() actor: ActorContext, @Body(zodBody(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.organizations.updateSettings(actor, body);
  }
}
