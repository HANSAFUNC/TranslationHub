import type { Prisma } from '@prisma/client';
import type { ProjectEventType } from '@localehub/contracts';

/**
 * Project revision + event log (spec §9.2: revisions must be monotonic, never timestamps).
 *
 * Every write that a local repository should eventually observe bumps `projects.revision`
 * and appends a `project_events` row carrying that revision. Clients (CLI, web UI,
 * webhooks) pull by revision cursor, so a missed webhook is always recoverable.
 */
export async function bumpProjectRevision(tx: Prisma.TransactionClient, projectId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ revision: number }[]>`
    UPDATE "projects" SET "revision" = "revision" + 1, "updated_at" = NOW()
    WHERE "id" = ${projectId}::uuid
    RETURNING "revision"
  `;
  const revision = rows[0]?.revision;
  if (typeof revision !== 'number') {
    throw new Error(`Failed to bump revision for project ${projectId}`);
  }
  return revision;
}

export interface EmitEventInput {
  organizationId: string;
  projectId: string;
  eventType: ProjectEventType;
  resourceType: string;
  resourceId?: string | null;
  payload?: Record<string, unknown>;
  actorId?: string | null;
  actorType?: 'user' | 'mcp' | 'system';
}

/** Bump the revision and append the event in one step. */
export async function emitProjectEvent(tx: Prisma.TransactionClient, input: EmitEventInput): Promise<number> {
  const revision = await bumpProjectRevision(tx, input.projectId);
  await tx.projectEvent.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      eventType: input.eventType,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      revision,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? 'user',
    },
  });
  return revision;
}

export async function getProjectRevision(tx: Prisma.TransactionClient, projectId: string): Promise<number> {
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { revision: true } });
  return project.revision;
}
