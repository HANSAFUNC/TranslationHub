import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError, Role } from '@localehub/contracts';
import type { ActorContext } from '@localehub/permissions';
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
