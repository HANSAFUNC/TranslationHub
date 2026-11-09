import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import {
  ErrorCode,
  LocaleHubError,
  Role,
  type McpScope,
} from '@localehub/contracts';
import {
  assertProjectBound,
  assertRole,
  assertScope,
  type ActorContext,
} from '@localehub/permissions';
import { hashToken } from '@localehub/domain';
import { PrismaService } from './prisma.service';
import { enrichContext } from './request-context';

export type { ActorContext };

export interface AuthenticatedRequest extends Request {
  actor?: ActorContext;
  user?: { id: string; email: string; name: string; isPlatformAdmin: boolean };
}

const AUTH_SECRET = () => process.env.AUTH_SECRET ?? 'dev-only-auth-secret-change-me';

export interface SessionClaims {
  sub: string;
  org: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  orgRole: Role | null;
}

/** Sign an interactive session cookie / bearer token. */
export function issueSessionToken(claims: SessionClaims, expiresInSeconds = 60 * 60 * 12): string {
  return jwt.sign(claims, AUTH_SECRET(), { expiresIn: expiresInSeconds, algorithm: 'HS256' });
}

export function verifySessionToken(token: string): SessionClaims {
  try {
    return jwt.verify(token, AUTH_SECRET(), { algorithms: ['HS256'] }) as SessionClaims;
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    throw new LocaleHubError(
      expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.INVALID_TOKEN,
      expired ? 'Session expired, sign in again' : 'Invalid session token',
      401,
    );
  }
}

/**
 * Authentication + authorization for every route.
 *
 * Two credential types are accepted:
 *   - `lh_mcp_...` / `lh_api_...` tokens, hashed in `mcp_clients`, carrying explicit scopes
 *   - interactive session JWTs issued by the login endpoint
 *
 * Interactive sessions are additionally checked against the database, so removing a
 * membership takes effect immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) {
      throw new LocaleHubError(ErrorCode.UNAUTHENTICATED, 'Missing bearer token', 401);
    }

    const actor = token.startsWith('lh_mcp_') || token.startsWith('lh_api_')
      ? await this.authenticateApiToken(token, request)
      : await this.authenticateSession(token, request);

    const requiredScopes = this.reflector.getAllAndOverride<McpScope[]>('scopes', [context.getHandler(), context.getClass()]) ?? [];
    for (const scope of requiredScopes) assertScope(actor, scope);

    // Project scoped role check: only applies when the route actually carries a project id.
    // Routes without one perform their own project-level assert in the service layer (an
    // org-level fallback here would wrongly block project members whose org role is READONLY).
    const requiredRole = this.reflector.getAllAndOverride<Role>('role', [context.getHandler(), context.getClass()]);
    const projectId = (request.params?.projectId ?? request.body?.projectId) as string | undefined;
    if (requiredRole && projectId) {
      assertRole(actor, projectId, requiredRole);
    }

    request.actor = actor;
    enrichContext({ organizationId: actor.organizationId, actorId: actor.userId, mcpClientId: actor.mcpClientId });
    return true;
  }

  private async authenticateApiToken(token: string, request: AuthenticatedRequest): Promise<ActorContext> {
    const tokenHash = hashToken(token);
    // Token lookup happens before we know the organization, so it must run on the privileged
    // path: the lookup key is the unguessable token hash, never a tenant filter.
    const client = await this.prisma.tenant.withoutTenantScope((tx) =>
      tx.mcpClient.findUnique({
        where: { tokenHash },
        include: { user: { include: { memberships: true, projectRoles: true } } },
      }),
    );
    if (!client) throw new LocaleHubError(ErrorCode.INVALID_TOKEN, 'Unknown token', 401);
    if (client.revokedAt) throw new LocaleHubError(ErrorCode.INVALID_TOKEN, 'Token has been revoked', 401);
    if (client.expiresAt && client.expiresAt.getTime() < Date.now()) {
      throw new LocaleHubError(ErrorCode.TOKEN_EXPIRED, 'Token expired, create a new connection token', 401);
    }

    const membership = client.user.memberships.find((m) => m.organizationId === client.organizationId);
    if (!membership) {
      throw new LocaleHubError(ErrorCode.ORGANIZATION_ACCESS_DENIED, 'Token owner is not a member of the organization', 403);
    }
    const projectRoles: Record<string, Role | null> = {};
    for (const role of client.user.projectRoles) projectRoles[role.projectId] = role.role as Role;

    const actor: ActorContext = {
      kind: 'mcp',
      userId: client.userId,
      organizationId: client.organizationId,
      orgRole: membership.role as Role,
      projectRoles,
      scopes: (client.scopes as McpScope[]) ?? [],
      mcpClientId: client.id,
      isPlatformAdmin: client.user.isPlatformAdmin,
      boundProjectIds: client.projectIds,
      actorType: 'mcp',
    };

    const projectId = (request.params?.projectId ?? request.body?.projectId) as string | undefined;
    if (projectId) assertProjectBound(actor, projectId);

    // Track last use without blocking the request path.
    void this.prisma.mcpClient
      .update({ where: { id: client.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return actor;
  }

  private async authenticateSession(token: string, request: AuthenticatedRequest): Promise<ActorContext> {
    const claims = verifySessionToken(token);
    const user = await this.prisma.tenant.withoutTenantScope((tx) =>
      tx.user.findUnique({
        where: { id: claims.sub },
        include: { memberships: true, projectRoles: true },
      }),
    );
    if (!user) throw new LocaleHubError(ErrorCode.INVALID_TOKEN, 'User no longer exists', 401);
    const requestedOrg = (request.headers['x-organization-id'] as string | undefined) ?? claims.org;
    const membership = user.memberships.find((m) => m.organizationId === requestedOrg) ?? user.memberships[0];
    if (!membership && !user.isPlatformAdmin) {
      throw new LocaleHubError(ErrorCode.ORGANIZATION_ACCESS_DENIED, 'You are not a member of any organization', 403);
    }
    const projectRoles: Record<string, Role | null> = {};
    for (const role of user.projectRoles) projectRoles[role.projectId] = role.role as Role;
    request.user = { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin };
    return {
      kind: 'user',
      userId: user.id,
      organizationId: membership?.organizationId ?? '',
      orgRole: (membership?.role as Role) ?? null,
      projectRoles,
      scopes: [],
      isPlatformAdmin: user.isPlatformAdmin,
      actorType: 'user',
    };
  }
}


export const Public = (): MethodDecorator & ClassDecorator => SetMetadata('isPublic', true);
export const RequireScopes = (...scopes: McpScope[]): MethodDecorator => SetMetadata('scopes', scopes);
export const RequireRole = (role: Role): MethodDecorator => SetMetadata('role', role);

export const Actor = createParamDecorator((_data: unknown, context: ExecutionContext): ActorContext => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.actor) throw new LocaleHubError(ErrorCode.UNAUTHENTICATED, 'No authenticated actor', 401);
  return request.actor;
});

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.user;
});
