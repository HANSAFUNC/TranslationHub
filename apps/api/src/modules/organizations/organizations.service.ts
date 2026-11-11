import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role } from '@localehub/contracts';
import { isMemberManagerRole, type ActorContext } from '@localehub/permissions';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';

/**
 * Organization-level settings.
 *
 * Only policies that change what the platform will let an agent do to a repository live here.
 * Today that is `allowDraftApply`: whether `include_drafts=true` may pull unapproved text into a
 * repository, replacing approved copy. The delivery spec allows that path but treats it as an
 * explicit, risky opt-in, so it is off until an organization turns it on.
 */
export interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  actor: { id: string; email: string; name: string } | null;
  /**
   * The token an agent acted with, when one did.
   *
   * `actor` alone is misleading for MCP rows: it names the person who issued the token, so a
   * forty-key import by a CI job reads exactly like that person doing it by hand. The name is what
   * an operator needs to find and revoke the right credential.
   */
  mcpClient: { id: string; name: string; tokenPrefix: string; revokedAt: string | null } | null;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(actor: ActorContext) {
    const organization = await this.prisma.withOrganization(actor.organizationId, (tx) =>
      tx.organization.findUnique({ where: { id: actor.organizationId } }),
    );
    if (!organization) throw new LocaleHubError(ErrorCode.NOT_FOUND, 'Organization not found', 404);
    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      allowDraftApply: organization.allowDraftApply,
      createdAt: organization.createdAt,
    };
  }

  /**
   * Organization-level audit trail.
   *
   * Member changes (create, role update, removal, suspension, password reset) were already being
   * written to `audit_logs`, but the only reader was project-scoped, so "who promoted whom" had
   * no answer anywhere in the product. Requires an admin: the trail names people and their roles.
   */
  async listAudit(
    actor: ActorContext,
    options: { action?: string; actorType?: 'user' | 'mcp' | 'system'; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    if (!isMemberManagerRole(actor.orgRole) && !actor.isPlatformAdmin) {
      throw new LocaleHubError(
        ErrorCode.ROLE_INSUFFICIENT,
        'Organization admin or owner is required to read the audit trail',
        403,
      );
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: {
          ...(options.action ? { action: { startsWith: options.action } } : {}),
          ...(options.actorType ? { actorType: options.actorType } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      // Actor names come from an id list the RLS-scoped query above produced; `users` carries no
      // row-level policy of its own (see UsersService for the same reasoning).
      const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)))];
      const actors = actorIds.length
        ? await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true, name: true } })
        : [];
      const byId = new Map(actors.map((user) => [user.id, user]));

      // Same reasoning as `actors`: the ids come from the scoped query above, and `mcp_clients`
      // carries its own row-level policy that would otherwise hide the row from an admin reading
      // their own organization's trail.
      const clientIds = [
        ...new Set(rows.map((row) => row.mcpClientId).filter((id): id is string => Boolean(id))),
      ];
      const clients = clientIds.length
        ? await tx.mcpClient.findMany({
            where: { id: { in: clientIds } },
            select: { id: true, name: true, tokenPrefix: true, revokedAt: true },
          })
        : [];
      const clientById = new Map(clients.map((client) => [client.id, client]));

      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        actorType: row.actorType,
        actor: row.actorId ? (byId.get(row.actorId) ?? null) : null,
        mcpClient: (() => {
          const client = row.mcpClientId ? clientById.get(row.mcpClientId) : undefined;
          if (!client) return null;
          return {
            id: client.id,
            name: client.name,
            tokenPrefix: client.tokenPrefix,
            revokedAt: client.revokedAt ? client.revokedAt.toISOString() : null,
          };
        })(),
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        projectId: row.projectId,
        metadata: row.metadata as Record<string, unknown>,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  async updateSettings(actor: ActorContext, input: { allowDraftApply?: boolean }) {
    if (actor.orgRole !== Role.ORG_OWNER && actor.orgRole !== Role.ORG_ADMIN && !actor.isPlatformAdmin) {
      throw new LocaleHubError(
        ErrorCode.ROLE_INSUFFICIENT,
        'Only organization owners and admins can change organization settings',
        403,
      );
    }
    const organization = await this.prisma.withOrganization(actor.organizationId, (tx) =>
      tx.organization.update({
        where: { id: actor.organizationId },
        data: { ...(input.allowDraftApply === undefined ? {} : { allowDraftApply: input.allowDraftApply }) },
      }),
    );
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      actorType: actor.actorType,
      action: 'organization.settings.update',
      resourceType: 'organization',
      resourceId: organization.id,
      metadata: { allowDraftApply: organization.allowDraftApply },
    });
    return { id: organization.id, name: organization.name, allowDraftApply: organization.allowDraftApply };
  }

  /**
   * Reject a request that would pull unapproved translations when the organization has not opted
   * in. Enforced on the platform rather than in the client: the CLI runs on a developer
   * machine and must not be the thing deciding what a policy allows.
   */
  async assertDraftApplyAllowed(actor: ActorContext): Promise<void> {
    const organization = await this.prisma.withOrganization(actor.organizationId, (tx) =>
      tx.organization.findUnique({ where: { id: actor.organizationId }, select: { allowDraftApply: true } }),
    );
    if (organization?.allowDraftApply) return;
    throw new LocaleHubError(
      ErrorCode.POLICY_VIOLATION,
      'This organization does not allow applying unapproved drafts. An organization owner can enable "allow draft apply" in organization settings.',
      403,
      { policy: 'allowDraftApply' },
    );
  }
}
