import { Body, Controller, Get, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import { hashPassword, verifyPassword } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';
import { clearSessionCookies, issueSessionToken, Public, setSessionCookie, type AuthenticatedRequest } from '../../common/auth';
import { Actor } from '../../common/auth';
import type { ActorContext } from '@localehub/permissions';
import { zodBody } from '../../common/zod.pipe';
import { AuditService } from '../../common/audit.service';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  name: z.string().min(1).max(120),
  organizationName: z.string().min(1).max(120),
});

const switchOrgSchema = z.object({ organizationId: z.string().uuid() });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});

const loginSchemaWithOrg = loginSchema.extend({
  /** Which organization to open when the account belongs to several. */
  organizationId: z.string().uuid().optional(),
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Bootstrap registration. Only allowed while the instance has no users, or when the email
   * belongs to an existing organization invitation — never an open signup on a live tenant.
   */
  @Public()
  @Post('register')
  async register(
    @Body(zodBody(registerSchema)) body: z.infer<typeof registerSchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const userCount = await this.prisma.user.count();
    if (userCount > 0) {
      throw new LocaleHubError(
        ErrorCode.ROLE_INSUFFICIENT,
        'Registration is closed on this instance. Ask an organization admin to add you.',
        403,
      );
    }
    const passwordHash = await hashPassword(body.password);
    const user = await this.prisma.tenant.withoutTenantScope(async (tx) => {
      const created = await tx.user.create({
        data: { email: body.email.toLowerCase(), name: body.name, passwordHash, isPlatformAdmin: true },
      });
      const org = await tx.organization.create({
        data: { name: body.organizationName, slug: slug(body.organizationName) },
      });
      await tx.membership.create({ data: { organizationId: org.id, userId: created.id, role: 'ORG_OWNER' } });
      return { user: created, organization: org };
    });
    const token = issueSessionToken({
      sub: user.user.id,
      org: user.organization.id,
      email: user.user.email,
      name: user.user.name,
      isPlatformAdmin: true,
      orgRole: 'ORG_OWNER',
    });
    setSessionCookie(response, token);
    return { token, user: { id: user.user.id, email: user.user.email, name: user.user.name }, organization: user.organization };
  }

  @Public()
  @Post('login')
  async login(
    @Body(zodBody(loginSchemaWithOrg)) body: z.infer<typeof loginSchemaWithOrg>,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Login runs before any tenant is known -> privileged read, keyed by the user's email.
    const user = await this.prisma.tenant.withoutTenantScope((tx) =>
      tx.user.findUnique({
        where: { email: body.email.toLowerCase() },
        include: { memberships: { include: { organization: true } } },
      }),
    );
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw new LocaleHubError(ErrorCode.INVALID_TOKEN, 'Invalid email or password', 401);
    }
    // Checked before a token is issued, so a suspended account never holds a working credential.
    if (user.deactivatedAt) {
      throw new LocaleHubError(ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been suspended', 403);
    }
    // Which organization to open. Previously this was `memberships[0]`, i.e. whatever order the
    // database happened to return — and an admin can attach an existing account to a second
    // organization, so a person in two tenants could land in either one at random. Callers can
    // now choose; the response always lists the rest so the UI can offer a switch.
    let membership;
    if (body.organizationId) {
      // An explicit choice is honoured or refused — never quietly substituted. Falling back to a
      // different organization here would sign somebody into a tenant they did not ask for, and
      // every subsequent write would land there.
      membership = user.memberships.find((m) => m.organizationId === body.organizationId);
      if (!membership) {
        throw new LocaleHubError(
          ErrorCode.ORGANIZATION_ACCESS_DENIED,
          'You are not a member of that organization',
          403,
        );
      }
    } else {
      membership =
        user.memberships.find((m) => m.organizationId === user.lastOrganizationId) ?? user.memberships[0];
    }
    if (!membership) {
      throw new LocaleHubError(ErrorCode.ORGANIZATION_ACCESS_DENIED, 'User has no organization membership', 403);
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastOrganizationId: membership.organizationId },
    });
    const token = issueSessionToken({
      sub: user.id,
      org: membership.organizationId,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
      orgRole: membership.role as never,
    });
    setSessionCookie(response, token);
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin },
      organization: { id: membership.organizationId, name: membership.organization.name, role: membership.role },
      organizations: user.memberships.map((m) => ({ id: m.organizationId, name: m.organization.name, role: m.role })),
    };
  }

  @Get('me')
  async me(@Actor() actor: ActorContext) {
    const user = await this.prisma.tenant.withoutTenantScope((tx) =>
      tx.user.findUnique({
        where: { id: actor.userId },
        include: { memberships: { include: { organization: true } } },
      }),
    );
    if (!user) throw new LocaleHubError(ErrorCode.NOT_FOUND, 'User not found', 404);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
      organizationId: actor.organizationId,
      role: actor.orgRole,
      organizations: user.memberships.map((m) => ({ id: m.organizationId, name: m.organization.name, role: m.role })),
    };
  }

  @Post('switch-organization')
  async switchOrganization(
    @Actor() actor: ActorContext,
    @Body(zodBody(switchOrgSchema)) body: z.infer<typeof switchOrgSchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const membership = await this.prisma.tenant
      .withOrganization(body.organizationId, (tx) =>
        tx.membership.findUnique({
          where: { organizationId_userId: { organizationId: body.organizationId, userId: actor.userId } },
          include: { user: true },
        }),
      )
      .catch(() => null);
    if (!membership) {
      throw new LocaleHubError(ErrorCode.ORGANIZATION_ACCESS_DENIED, 'You are not a member of that organization', 403);
    }
    await this.prisma.user.update({ where: { id: actor.userId }, data: { lastOrganizationId: body.organizationId } });
    const token = issueSessionToken({
      sub: membership.userId,
      org: body.organizationId,
      email: membership.user.email,
      name: membership.user.name,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      orgRole: membership.role as never,
    });
    setSessionCookie(response, token);
    return { token };
  }

  /**
   * Change your own password.
   *
   * Admins can reset someone else's (`POST /organization/members/:userId/password`), but before
   * this there was no way to change your own at all — the admin route explicitly refuses to act
   * on yourself, and there is no email channel to fall back on.
   */
  @Patch('password')
  async changePassword(
    @Actor() actor: ActorContext,
    @Body(zodBody(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ) {
    if (actor.kind !== 'user') {
      throw new LocaleHubError(ErrorCode.SCOPE_INSUFFICIENT, 'MCP tokens cannot change passwords', 403);
    }
    const user = await this.prisma.tenant.withoutTenantScope((tx) =>
      tx.user.findUnique({ where: { id: actor.userId }, select: { passwordHash: true } }),
    );
    if (!user) throw new LocaleHubError(ErrorCode.NOT_FOUND, 'User not found', 404);
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      // A wrong current password is a failed authentication, not a validation error.
      throw new LocaleHubError(ErrorCode.INVALID_TOKEN, 'Current password is incorrect', 401);
    }
    const passwordHash = await hashPassword(body.newPassword);
    await this.prisma.tenant.withoutTenantScope((tx) =>
      tx.user.update({ where: { id: actor.userId }, data: { passwordHash } }),
    );
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'user.password_change',
      resourceType: 'user',
      resourceId: actor.userId,
      metadata: {},
    });
    return { changed: true };
  }

  @Post('logout')
  async logout(@Res({ passthrough: true }) response: Response) {
    clearSessionCookies(response);
    return { ok: true };
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || `org-${Date.now().toString(36)}`
  );
}

export type { AuthenticatedRequest };
