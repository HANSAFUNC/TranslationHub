import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Role, platformSchema, localeTagSchema } from '@localehub/contracts';
import { z } from 'zod';
import { Actor, RequireRole, type ActorContext } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { ApiAuth } from '../../openapi/api-auth';
import { ProjectsService } from './projects.service';

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(60).optional(),
  description: z.string().max(2000).optional(),
  sourceLocale: localeTagSchema,
  defaultPlatform: platformSchema.optional(),
  locales: z.array(localeTagSchema).max(80).optional(),
  platforms: z.array(platformSchema).max(4).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  defaultPlatform: platformSchema.optional(),
  aiPolicy: z.record(z.unknown()).optional(),
});

const addLocaleSchema = z.object({ code: localeTagSchema, name: z.string().max(80).optional() });

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list(@Actor() actor: ActorContext) {
    return this.projects.list(actor);
  }

  @ApiAuth({ role: 'PROJECT_MANAGER', note: 'service 内 assertRole：本路由不带 projectId，guard 的 @RequireRole 不生效' })
  @Post()
  async create(@Actor() actor: ActorContext, @Body(zodBody(createProjectSchema)) body: z.infer<typeof createProjectSchema>) {
    return this.projects.create(actor, body);
  }

  @Get(':projectId')
  async get(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    return this.projects.get(actor, projectId);
  }

  @Patch(':projectId')
  @RequireRole(Role.PROJECT_MANAGER)
  async update(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(updateProjectSchema)) body: z.infer<typeof updateProjectSchema>,
  ) {
    return this.projects.update(actor, projectId, body);
  }

  @Delete(':projectId')
  @RequireRole(Role.PROJECT_MANAGER)
  async remove(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Query(zodBody(z.object({ confirmName: z.string().optional() }))) query: { confirmName?: string },
  ) {
    return this.projects.remove(actor, projectId, query.confirmName);
  }

  @Get(':projectId/dashboard')
  async dashboard(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    return this.projects.dashboard(actor, projectId);
  }

  @Get(':projectId/locales')
  async locales(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    return this.projects.listLocales(actor, projectId);
  }

  @Post(':projectId/locales')
  @RequireRole(Role.PROJECT_MANAGER)
  async addLocale(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(addLocaleSchema)) body: z.infer<typeof addLocaleSchema>,
  ) {
    return this.projects.addLocale(actor, projectId, body);
  }

  @Get(':projectId/members')
  async members(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    return this.projects.listMembers(actor, projectId);
  }

  @Get(':projectId/platforms')
  async platforms(@Actor() actor: ActorContext, @Param('projectId') projectId: string) {
    const project = await this.projects.get(actor, projectId);
    return project.platforms;
  }

  @Post(':projectId/platforms')
  @RequireRole(Role.PROJECT_MANAGER)
  async addPlatform(
    @Actor() actor: ActorContext,
    @Param('projectId') projectId: string,
    @Body(zodBody(z.object({ platform: platformSchema }))) body: { platform: string },
  ) {
    return this.projects.addPlatformSafe(actor, projectId, body.platform);
  }
}

export { createProjectSchema, updateProjectSchema, addLocaleSchema };
