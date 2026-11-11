import type { Prisma, PrismaClient } from '@localehub/database';

/**
 * Audit trail, shared by the REST API and the Remote MCP.
 *
 * It was Nest-only (`AuditService`), which meant the MCP had no way to write one — every write an
 * agent made through the MCP was invisible in `audit_logs`, while the same write through REST left
 * a row. That difference is not academic: the organization audit page reads exactly this table, so
 * "who imported forty keys into this project" had no answer when the answer was "an agent".
 *
 * The Nest service is now a thin wrapper over this, so both surfaces produce rows of the same
 * shape. Nothing here depends on a request context; `requestId` is passed in when there is one.
 */

export interface AuditEntryInput {
  organizationId: string;
  actorId?: string | null;
  actorType?: 'user' | 'mcp' | 'system';
  /** Dotted name, e.g. `sync.push`, `member.role_update`. Keep the existing vocabulary. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  projectId?: string | null;
  repositoryConnectionId?: string | null;
  syncSessionId?: string | null;
  mcpClientId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  durationMs?: number;
}

const SECRET_KEYS = /(token|secret|password|apikey|api_key|authorization|cookie)/i;

/** Strip anything that looks like a credential before it can reach the table. */
export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redactForAudit(child);
    }
    return out;
  }
  return value;
}

/**
 * Write one audit row.
 *
 * Runs on the privileged path (`withoutTenantScope`) for the same reason the API's version does:
 * the row is written after the operation, and an RLS-scoped write would fail whenever the operation
 * itself changed the organization context. Failure never propagates — auditing must not break the
 * action it is recording — but it is logged, because a silently empty audit log looks exactly like
 * "nothing happened".
 */
export async function recordAudit(prisma: PrismaClient, input: AuditEntryInput): Promise<void> {
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
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
          metadata: redactForAudit(input.metadata ?? {}) as never,
          requestId: input.requestId ?? null,
          durationMs: input.durationMs ?? null,
        },
      });
    });
  } catch (error) {
    console.error(
      `[audit] failed to persist "${input.action}":`,
      error instanceof Error ? error.message : error,
    );
  }
}