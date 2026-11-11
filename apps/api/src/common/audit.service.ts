import { Injectable } from '@nestjs/common';
import { recordAudit, redactForAudit, type AuditEntryInput } from '@localehub/domain';
import { PrismaService } from './prisma.service';
import { contextRequestId } from './request-context';

export type AuditInput = Omit<AuditEntryInput, 'requestId'>;

/**
 * Audit trail for the REST API.
 *
 * The writing itself lives in `@localehub/domain` so the Remote MCP can record rows of the same
 * shape; this class only adds what is specific to a request — the correlation id from the async
 * context. Keeping the shared part in the domain is what makes "an agent did it" visible in the
 * same table as "a user did it".
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    return recordAudit(this.prisma, { ...input, requestId: contextRequestId() ?? null });
  }

  async list(organizationId: string, filters: { projectId?: string; limit?: number } = {}) {
    return this.prisma.tenant.withOrganization(organizationId, (tx) =>
      tx.auditLog.findMany({
        where: { ...(filters.projectId ? { projectId: filters.projectId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: Math.min(filters.limit ?? 100, 500),
      }),
    );
  }
}

export const redact = redactForAudit;
