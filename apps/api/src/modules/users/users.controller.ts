import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { ORG_ROLES, PROJECT_ROLES, type Role } from '@localehub/contracts';
import { localeTagSchema } from '@localehub/contracts';
import type { ActorContext } from '@localehub/permissions';
import { Actor } from '../../common/auth';
import { zodBody } from '../../common/zod.pipe';
import { UsersService } from './users.service';

/**
 * Organization member management.
 *
 * There is no invitation flow and no open registration: an organization admin creates the account
 * outright (email, name, initial password) and can reset that password later. Authorization is
 * decided in `@localehub/permissions` and in the service, not by decorators alone — these routes
 * carry a `:userId`, not a `:projectId`, so a role decorator here would be decorative (see
 * docs/STATUS.md §1.11 for the last time that mistake shipped).
 */

const orgRoleSchema = z.enum(ORG_ROLES as [Role, ...Role[]]);
const projectRoleSchema = z.enum(PROJECT_ROLES as [Role, ...Role[]]);

const addMemberSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(10).max(200).optional(),
  role: orgRoleSchema,
});

const updateRoleSchema = z.object({ role: orgRoleSchema });
const resetPasswordSchema = z.object({ password: z.string().min(10).max(200) });
const projectRoleSchema_ = z.object({
  role: projectRoleSchema,
  localeScope: z.array(localeTagSchema).max(50).optional(),
});

@Controller('organization/members')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@Actor() actor: ActorContext) {
    return this.users.list(actor);
  }

  @Post()
  async add(@Actor() actor: ActorContext, @Body(zodBody(addMemberSchema)) body: z.infer<typeof addMemberSchema>) {
    return this.users.add(actor, body);
  }

  @Patch(':userId')
  async updateRole(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body(zodBody(updateRoleSchema)) body: z.infer<typeof updateRoleSchema>,
  ) {
    return this.users.updateRole(actor, userId, body.role);
  }

  @Delete(':userId')
  async remove(@Actor() actor: ActorContext, @Param('userId') userId: string) {
    return this.users.remove(actor, userId);
  }

  @Post(':userId/password')
  async resetPassword(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body(zodBody(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ) {
    return this.users.resetPassword(actor, userId, body.password);
  }

  @Put(':userId/projects/:projectId')
  async setProjectRole(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Param('projectId') projectId: string,
    @Body(zodBody(projectRoleSchema_)) body: z.infer<typeof projectRoleSchema_>,
  ) {
    return this.users.setProjectRole(actor, userId, projectId, body);
  }

  @Delete(':userId/projects/:projectId')
  async removeProjectRole(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Param('projectId') projectId: string,
  ) {
    return this.users.removeProjectRole(actor, userId, projectId);
  }
}
