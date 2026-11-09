import { Body, Controller, Get, Patch } from '@nestjs/common';
import { z } from 'zod';
import type { ActorContext } from '@localehub/permissions';
import { Actor } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
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

  @Patch('settings')
  async updateSettings(@Actor() actor: ActorContext, @Body(zodBody(settingsSchema)) body: z.infer<typeof settingsSchema>) {
    return this.organizations.updateSettings(actor, body);
  }
}
