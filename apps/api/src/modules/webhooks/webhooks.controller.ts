import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PROJECT_EVENT_TYPES } from '@localehub/contracts';
import type { ActorContext } from '@localehub/permissions';
import { Actor } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { ApiAuth } from '../../openapi/api-auth';
import { WebhooksService } from './webhooks.service';

/**
 * Webhook endpoints.
 *
 * Organization-scoped, and gated on ORG_ADMIN in the service — a webhook ships translation content
 * and project metadata to an address the caller chooses, which is a decision for an administrator
 * rather than any member.
 */

const createSchema = z.object({
  url: z.string().url().max(2048),
  /** Empty means every event type. */
  eventTypes: z.array(z.enum(PROJECT_EVENT_TYPES)).max(PROJECT_EVENT_TYPES.length).optional(),
  description: z.string().max(200).optional(),
});

const updateSchema = z.object({
  active: z.boolean().optional(),
  eventTypes: z.array(z.enum(PROJECT_EVENT_TYPES)).max(PROJECT_EVENT_TYPES.length).optional(),
  description: z.string().max(200).optional(),
});

@Controller('organization/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @ApiAuth({ role: 'ORG_ADMIN', note: 'service 内校验：webhook 会把译文内容发到调用方指定的地址' })
  @Get()
  async list(@Actor() actor: ActorContext) {
    return this.webhooks.list(actor);
  }

  @ApiAuth({ role: 'ORG_ADMIN', note: '签名密钥只在创建时返回一次' })
  @Post()
  async create(@Actor() actor: ActorContext, @Body(zodBody(createSchema)) body: z.infer<typeof createSchema>) {
    return this.webhooks.create(actor, body);
  }

  @ApiAuth({ role: 'ORG_ADMIN' })
  @Patch(':id')
  async update(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body(zodBody(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.webhooks.update(actor, id, body);
  }

  @ApiAuth({ role: 'ORG_ADMIN' })
  @Delete(':id')
  async remove(@Actor() actor: ActorContext, @Param('id') id: string) {
    return this.webhooks.remove(actor, id);
  }

  @ApiAuth({ role: 'ORG_ADMIN' })
  @Get(':id/deliveries')
  async deliveries(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const limit = query.limit ? Number(query.limit) : 100;
    return this.webhooks.deliveries(actor, id, Number.isFinite(limit) ? limit : 100);
  }
}
