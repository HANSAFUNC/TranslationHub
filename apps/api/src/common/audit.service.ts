import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { contextRequestId } from './request-context';

export interface AuditInput {
  organizationId: string;
  actorId?: string | null;
  actorType?: 'user' | 'mcp' | 'system';
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  repositoryConnectionId?: string | null;
  syncSessionId?: string | null;
  mcpClientId?: string | null;
  metadata?: Record<string, unknown>;
  durationMs?: number;
}

/**
 * Audit trail shared by REST, MCP and the worker (spec §0.1.7, §15).
 * Tokens and secrets are never written into `metadata`.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    try {
      await this.prisma.tenant.withoutTenantScope(async (tx) => {
        await tx.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actorId: input.actorId ?? null,
            actorType: input.actorType ?? 'user',
            action: input.action,
            resourceType: input.resourceType,
            resourceId: input.resourceId ?? null,
            projectId: input.projectId ?? null,
            repositoryConnectionId: input.repositoryConnectionId ?? null,
            syncSessionId: input.syncSessionId ?? null,
            mcpClientId: input.mcpClientId ?? null,
            metadata: redact(input.metadata ?? {}) as never,
            requestId: contextRequestId() ?? null,
            durationMs: input.durationMs ?? null,
          },
        });
      });
    } catch {
      // Auditing must never break the primary operation, but it must be visible.
      console.error('[audit] failed to persist audit entry', input.action);
    }
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

const SECRET_KEYS = /(token|secret|password|apikey|api_key|authorization|cookie)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(child);
    }
    return out;
  }
  return value;
}
