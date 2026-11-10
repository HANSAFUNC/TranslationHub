import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, ORG_ROLES, PROJECT_ROLES, Role, isValidLocaleTag } from '@localehub/contracts';
import {
  assertCanGrantOrgRole,
  assertCanManageMember,
  assertCanManageMembers,
  assertRole,
  isMemberManagerRole,
  type ActorContext,
} from '@localehub/permissions';
import { hashPassword } from '@localehub/domain';
import type { Prisma } from '@localehub/database';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';

export interface MemberProjectAssignment {
  projectId: string;
  projectName: string;
  role: string;
  localeScope: string[];
}

export interface MemberRow {
  userId: string;
  email: string;
  name: string;
  role: string;
  isPlatformAdmin: boolean;
  lastLoginAt: string | null;
  joinedAt: string;
  projects: MemberProjectAssignment[];
}

/**
 * Organization member management.
 *
 * Two things are worth knowing before reading the queries below.
 *
 * **`memberships` is RLS-scoped, `users` is not.** `users` has no `organization_id` column (a
 * person can belong to several organizations), so it carries no row-level policy and an
 * unfiltered `user.findMany()` would return every user on the platform. Every user read here is
 * therefore keyed by ids that came out of an RLS-scoped `memberships` query.
 *
 * **Looking a user up by email is a privileged read.** Email is a global identifier — that is
 * what makes it the login key — so "is this address already registered?" cannot be answered
 * inside a tenant. This is the same exception the login path takes, and it is confined to the
 * one lookup that needs it. Its consequence: an organization admin can learn whether an address
 * is registered elsewhere on the platform, the same way they can by watching a login fail.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Roles that may see the roster: admins, plus anyone who manages at least one project. */
  private assertCanViewMembers(actor: ActorContext): void {
    if (actor.isPlatformAdmin) return;
    if (isMemberManagerRole(actor.orgRole)) return;
    const managesAProject = Object.values(actor.projectRoles).some((role) => isMemberManagerRole(role));
    if (managesAProject) return;
    throw new LocaleHubError(ErrorCode.ROLE_INSUFFICIENT, 'You cannot view the organization member list', 403);
  }

  async list(actor: ActorContext): Promise<MemberRow[]> {
    this.assertCanViewMembers(actor);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const memberships = await tx.membership.findMany({ orderBy: { createdAt: 'asc' } });
      const userIds = memberships.map((membership) => membership.userId);
      if (!userIds.length) return [];

      // Scoped by the ids the RLS-protected membership query just returned.
      const users = await tx.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, name: true, isPlatformAdmin: true, lastLoginAt: true },
      });
      const byId = new Map(users.map((user) => [user.id, user]));

      const assignments = await tx.projectMember.findMany({
        where: { userId: { in: userIds } },
        include: { project: { select: { id: true, name: true } } },
      });
      const projectsByUser = new Map<string, MemberProjectAssignment[]>();
      for (const assignment of assignments) {
        const list = projectsByUser.get(assignment.userId) ?? [];
        list.push({
          projectId: assignment.projectId,
          projectName: assignment.project.name,
          role: assignment.role,
          localeScope: assignment.localeScope,
        });
        projectsByUser.set(assignment.userId, list);
      }

      return memberships.flatMap((membership) => {
        const user = byId.get(membership.userId);
        // A membership without its user row would be a foreign-key violation; skip defensively
        // rather than emitting a half-filled row the UI would render as a blank member.
        if (!user) return [];
        return [
          {
            userId: user.id,
            email: user.email,
            name: user.name,
            role: membership.role,
            isPlatformAdmin: user.isPlatformAdmin,
            lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
            joinedAt: membership.createdAt.toISOString(),
            projects: projectsByUser.get(user.id) ?? [],
          },
        ];
      });
    });
  }

  /**
   * Add someone to the organization: create the account when the address is new, attach an
   * existing account otherwise.
   *
   * `password` is only ever used on the create path. An existing account's password is never
   * touched here — otherwise any organization admin could take over any account on the platform
   * by "adding" its owner with a password of their choosing.
   */
  async add(
    actor: ActorContext,
    input: { email: string; name?: string; password?: string; role: Role },
  ): Promise<MemberRow> {
    assertCanManageMembers(actor);
    assertCanGrantOrgRole(actor, input.role);
    const email = input.email.toLowerCase();

    const existing = await this.prisma.tenant.withoutTenantScope((tx) =>
      tx.user.findUnique({ where: { email }, select: { id: true, name: true } }),
    );

    if (existing) {
      const alreadyMember = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
        tx.membership.findUnique({
          where: { organizationId_userId: { organizationId: actor.organizationId, userId: existing.id } },
        }),
      );
      if (alreadyMember) {
        throw new LocaleHubError(ErrorCode.CONFLICT, `${email} is already a member of this organization`, 409);
      }
      await this.prisma.tenant.withoutTenantScope((tx) =>
        tx.membership.create({
          data: { organizationId: actor.organizationId, userId: existing.id, role: input.role as never },
        }),
      );
      await this.audit.record({
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: 'member.add_existing',
        resourceType: 'membership',
        resourceId: existing.id,
        metadata: { email, role: input.role },
      });
    } else {
      if (!input.name || !input.password) {
        throw new LocaleHubError(
          ErrorCode.VALIDATION_ERROR,
          'name and password are required when creating a new account',
          422,
        );
      }
      const passwordHash = await hashPassword(input.password);
      const created = await this.prisma.tenant.withoutTenantScope(async (tx) => {
        const user = await tx.user.create({
          data: { email, name: input.name!, passwordHash, isPlatformAdmin: false },
        });
        await tx.membership.create({
          data: { organizationId: actor.organizationId, userId: user.id, role: input.role as never },
        });
        return user;
      });
      await this.audit.record({
        organizationId: actor.organizationId,
        actorId: actor.userId,
        action: 'member.create',
        resourceType: 'user',
        resourceId: created.id,
        metadata: { email, role: input.role },
      });
    }

    const rows = await this.list(actor);
    const row = rows.find((member) => member.email === email);
    if (!row) throw new LocaleHubError(ErrorCode.INTERNAL_ERROR, 'Member was written but cannot be read back', 500);
    return row;
  }

  async updateRole(actor: ActorContext, userId: string, role: Role): Promise<{ userId: string; role: Role }> {
    assertCanManageMembers(actor);
    if (userId === actor.userId) {
      throw new LocaleHubError(ErrorCode.CONFLICT, 'You cannot change your own organization role', 409);
    }
    assertCanGrantOrgRole(actor, role);
    await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
      });
      if (!membership) throw new LocaleHubError(ErrorCode.NOT_FOUND, 'That user is not a member', 404);
      assertCanManageMember(actor, membership.role as Role);
      await this.assertOwnerSurvives(tx, membership.role as Role, role);
      await tx.membership.update({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
        data: { role: role as never },
      });
    });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'member.role_update',
      resourceType: 'membership',
      resourceId: userId,
      metadata: { role },
    });
    return { userId, role };
  }

  async remove(actor: ActorContext, userId: string): Promise<{ userId: string; removed: true }> {
    assertCanManageMembers(actor);
    if (userId === actor.userId) {
      throw new LocaleHubError(
        ErrorCode.CONFLICT,
        'You cannot remove yourself from the organization; ask another owner or admin',
        409,
      );
    }
    await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
      });
      if (!membership) throw new LocaleHubError(ErrorCode.NOT_FOUND, 'That user is not a member', 404);
      assertCanManageMember(actor, membership.role as Role);
      await this.assertOwnerSurvives(tx, membership.role as Role, null);
      // Project assignments are organization-scoped rows of their own; leaving them behind would
      // re-grant the project role the moment the person is added back.
      await tx.projectMember.deleteMany({ where: { userId } });
      await tx.membership.delete({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
      });
    });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'member.remove',
      resourceType: 'membership',
      resourceId: userId,
      metadata: {},
    });
    return { userId, removed: true };
  }

  async resetPassword(actor: ActorContext, userId: string, password: string): Promise<{ userId: string }> {
    assertCanManageMembers(actor);
    if (userId === actor.userId) {
      throw new LocaleHubError(ErrorCode.CONFLICT, 'Use your own password change flow for your account', 409);
    }
    await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
      });
      if (!membership) throw new LocaleHubError(ErrorCode.NOT_FOUND, 'That user is not a member', 404);
      assertCanManageMember(actor, membership.role as Role);
    });
    const passwordHash = await hashPassword(password);
    await this.prisma.tenant.withoutTenantScope((tx) => tx.user.update({ where: { id: userId }, data: { passwordHash } }));
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'member.password_reset',
      resourceType: 'user',
      resourceId: userId,
      metadata: {},
    });
    return { userId };
  }

  /**
   * Set (or replace) a member's role on one project, with an optional locale restriction.
   *
   * Requires PROJECT_MANAGER on that project, or organization admin — which is what
   * `Permission.MEMBER_MANAGE` says. A project manager can therefore staff their own project
   * without being able to touch anybody's organization role.
   */
  async setProjectRole(
    actor: ActorContext,
    userId: string,
    projectId: string,
    input: { role: Role; localeScope?: string[] },
  ): Promise<MemberProjectAssignment> {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    if (!PROJECT_ROLES.includes(input.role)) {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `${input.role} is not a project role`, 400);
    }
    const localeScope = input.localeScope ?? [];
    for (const locale of localeScope) {
      if (!isValidLocaleTag(locale)) {
        throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `Invalid locale tag: ${locale}`, 400);
      }
    }

    const assignment = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const membership = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
      });
      if (!membership) {
        throw new LocaleHubError(
          ErrorCode.NOT_FOUND,
          'That user is not a member of this organization; add them first',
          404,
        );
      }
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
      if (!project) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Project ${projectId} not found`, 404);

      if (localeScope.length) {
        const known = await tx.locale.findMany({ where: { projectId }, select: { code: true } });
        const knownCodes = new Set(known.map((locale) => locale.code));
        const unknown = localeScope.filter((locale) => !knownCodes.has(locale));
        if (unknown.length) {
          throw new LocaleHubError(
            ErrorCode.VALIDATION_ERROR,
            `Project ${project.name} has no such locale: ${unknown.join(', ')}`,
            400,
            { unknown },
          );
        }
      }

      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId, userId } },
        create: {
          organizationId: actor.organizationId,
          projectId,
          userId,
          role: input.role as never,
          localeScope,
        },
        update: { role: input.role as never, localeScope },
      });
      return { projectId, projectName: project.name, role: input.role, localeScope };
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'member.project_role_set',
      resourceType: 'project_member',
      resourceId: `${projectId}:${userId}`,
      metadata: { role: input.role, localeScope },
    });
    return assignment;
  }

  async removeProjectRole(actor: ActorContext, userId: string, projectId: string): Promise<{ removed: true }> {
    assertRole(actor, projectId, Role.PROJECT_MANAGER);
    await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const existing = await tx.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
      if (!existing) throw new LocaleHubError(ErrorCode.NOT_FOUND, 'That user has no role on this project', 404);
      await tx.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
    });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'member.project_role_remove',
      resourceType: 'project_member',
      resourceId: `${projectId}:${userId}`,
      metadata: {},
    });
    return { removed: true };
  }

  /**
   * Refuse a change that would leave the organization with no owner.
   *
   * Without this, an ORG_ADMIN (who may not outrank an owner) could still be the last one
   * standing after demoting or removing the only ORG_OWNER — and nobody could ever manage
   * members again.
   */
  private async assertOwnerSurvives(
    tx: Prisma.TransactionClient,
    current: Role,
    next: Role | null,
  ): Promise<void> {
    if (current !== Role.ORG_OWNER) return;
    if (next === Role.ORG_OWNER) return;
    const owners = await tx.membership.count({ where: { role: Role.ORG_OWNER } });
    if (owners <= 1) {
      throw new LocaleHubError(
        ErrorCode.CONFLICT,
        'This is the organization’s only owner; promote another owner first',
        409,
      );
    }
  }
}

export { ORG_ROLES, PROJECT_ROLES };
