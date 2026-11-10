import { ErrorCode, LocaleHubError, Role, type McpScope } from '@localehub/contracts';

/**
 * Authorization rules shared by the REST API, the Remote MCP and the Web UI.
 * Keeping them in one package is what makes spec §0.1.7 enforceable: there is exactly
 * one place that decides whether an actor may do something.
 */

export interface ActorContext {
  kind: 'user' | 'mcp' | 'system';
  userId: string;
  organizationId: string;
  /** organization level role (highest granted) */
  orgRole: Role | null;
  /** project id -> project role */
  projectRoles: Record<string, Role | null>;
  scopes: McpScope[];
  mcpClientId?: string;
  isPlatformAdmin?: boolean;
  /** for MCP tokens: the project allowlist the token is bound to */
  boundProjectIds?: string[];
  /** recorded on audit rows and translation versions */
  actorType?: 'user' | 'mcp' | 'system';
  /**
   * How the request authenticated. A `cookie` credential is attached ambiently by the browser,
   * so it additionally has to pass CSRF verification; a `bearer` credential is attached
   * deliberately by the caller and does not.
   */
  credentialSource?: 'bearer' | 'cookie';
}

const ROLE_WEIGHT: Record<Role, number> = {
  [Role.PLATFORM_ADMIN]: 100,
  [Role.ORG_OWNER]: 90,
  [Role.ORG_ADMIN]: 80,
  [Role.PROJECT_MANAGER]: 60,
  [Role.PRODUCT_MANAGER]: 50,
  [Role.REVIEWER]: 40,
  [Role.TRANSLATOR]: 30,
  [Role.DEVELOPER]: 20,
  [Role.READONLY]: 10,
};

export function highestRole(roles: (Role | null | undefined)[]): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (!role) continue;
    if (!best || ROLE_WEIGHT[role] > ROLE_WEIGHT[best]) best = role;
  }
  return best;
}

export function roleAtLeast(actor: ActorContext, projectId: string, required: Role): boolean {
  if (actor.isPlatformAdmin) return true;
  const role = highestRole([actor.orgRole, actor.projectRoles[projectId]]);
  if (!role) return false;
  return ROLE_WEIGHT[role] >= ROLE_WEIGHT[required];
}

export function assertRole(actor: ActorContext, projectId: string, required: Role): void {
  if (!roleAtLeast(actor, projectId, required)) {
    throw new LocaleHubError(ErrorCode.ROLE_INSUFFICIENT, `Role ${required} or higher is required for this project`, 403, {
      required,
      projectId,
    });
  }
}

export function assertScope(actor: ActorContext, scope: McpScope): void {
  if (actor.isPlatformAdmin) return;
  if (actor.kind === 'user') return; // interactive sessions are governed by roles, not MCP scopes
  if (!actor.scopes.includes(scope)) {
    throw new LocaleHubError(ErrorCode.SCOPE_INSUFFICIENT, `Missing required scope: ${scope}`, 403, { required: scope });
  }
}

export function assertAnyScope(actor: ActorContext, scopes: McpScope[]): void {
  if (actor.isPlatformAdmin || actor.kind === 'user') return;
  if (!scopes.some((scope) => actor.scopes.includes(scope))) {
    throw new LocaleHubError(ErrorCode.SCOPE_INSUFFICIENT, `Missing required scope, one of: ${scopes.join(', ')}`, 403);
  }
}

/**
 * MCP tokens are bound to a project allowlist (spec §2.2). An empty allowlist means
 * "every project the user can already reach", never "every project in the database".
 */
export function assertProjectBound(actor: ActorContext, projectId: string): void {
  if (actor.isPlatformAdmin) return;
  if (actor.kind !== 'mcp') return;
  if (actor.boundProjectIds && actor.boundProjectIds.length > 0 && !actor.boundProjectIds.includes(projectId)) {
    throw new LocaleHubError(ErrorCode.PROJECT_ACCESS_DENIED, 'This token is not bound to the requested project', 403, {
      projectId,
    });
  }
}

/** Which locale a translator may edit (project member localeScope). */
export function assertLocaleAllowed(scope: string[] | undefined, locale: string): void {
  if (!scope || scope.length === 0) return;
  if (!scope.includes(locale)) {
    throw new LocaleHubError(ErrorCode.PROJECT_ACCESS_DENIED, `You are not assigned to locale ${locale}`, 403, { locale });
  }
}

export const Permission = {
  PROJECT_READ: Role.READONLY,
  TRANSLATION_EDIT: Role.TRANSLATOR,
  TRANSLATION_SUBMIT: Role.TRANSLATOR,
  TRANSLATION_REVIEW: Role.REVIEWER,
  TRANSLATION_APPROVE: Role.REVIEWER,
  SYNC_PUSH: Role.DEVELOPER,
  SYNC_PULL: Role.DEVELOPER,
  SYNC_APPLY_REPORT: Role.DEVELOPER,
  PROJECT_MANAGE: Role.PROJECT_MANAGER,
  MEMBER_MANAGE: Role.PROJECT_MANAGER,
  TOKEN_MANAGE: Role.PROJECT_MANAGER,
  RELEASE_PUBLISH: Role.PROJECT_MANAGER,
  QA_RUN: Role.TRANSLATOR,
} as const satisfies Record<string, Role>;
