import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { z } from 'zod';
import type { Response } from 'express';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import { hashPassword, verifyPassword } from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';
import { issueSessionToken, Public, type AuthenticatedRequest } from '../../common/auth';
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
  async register(@Body(zodBody(registerSchema)) body: z.infer<typeof registerSchema>) {
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
    return { token, user: { id: user.user.id, email: user.user.email, name: user.user.name }, organization: user.organization };
  }

  @Public()
  @Post('login')
  async login(@Body(zodBody(loginSchema)) body: z.infer<typeof loginSchema>, @Res({ passthrough: true }) response: Response) {
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
    const membership = user.memberships[0];
    if (!membership) {
      throw new LocaleHubError(ErrorCode.ORGANIZATION_ACCESS_DENIED, 'User has no organization membership', 403);
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = issueSessionToken({
      sub: user.id,
      org: membership.organizationId,
      email: user.email,
      name: user.name,
      isPlatformAdmin: user.isPlatformAdmin,
      orgRole: membership.role as never,
    });
    response.cookie('localehub_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    });
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
    const token = issueSessionToken({
      sub: membership.userId,
      org: body.organizationId,
      email: membership.user.email,
      name: membership.user.name,
      isPlatformAdmin: membership.user.isPlatformAdmin,
      orgRole: membership.role as never,
    });
    response.cookie('localehub_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return { token };
  }

  @Post('logout')
  async logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie('localehub_session');
    return { ok: true };
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || `org-${Date.now().toString(36)}`;
}

export type { AuthenticatedRequest };
