import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient, TenantPrisma } from '@localehub/database';
import { runQaRules, type QaCandidateEntry } from '@localehub/domain';
import { QUEUE_NAMES } from './queues';
import { startWebhookWorker } from './webhooks';

/**
 * BullMQ worker.
 *
 * Every job is idempotent: it recomputes derived state from the database rather than mutating
 * counters, so a retry after a crash produces the same result (spec §15).
 */
export interface QaJobPayload {
  organizationId: string;
  projectId: string;
  locale?: string;
  requestedBy?: string;
}

export function startWorker(connection: IORedis, prisma: PrismaClient): Worker[] {
  // Every job reads tenant data behind row level security. A bare `PrismaClient` sets no
  // organization context, so an unscoped read returns zero rows — a job that silently does
  // nothing. `TenantPrisma.withOrganization` is the same sanctioned path the API uses.
  const tenant = new TenantPrisma(prisma);
  const workers: Worker[] = [];

  workers.push(
    new Worker<QaJobPayload>(
      QUEUE_NAMES.QA,
      async (job: Job<QaJobPayload>) => {
        const { organizationId, projectId, locale, requestedBy } = job.data;
        // Scoped: `projects`, `translation_entries` and `glossary_terms` all carry a row level
        // security policy, and an unscoped read returns nothing rather than everything.
        return tenant.withOrganization(organizationId, async (tx) => {
        const project = await tx.project.findFirst({ where: { id: projectId }, select: { sourceLocale: true } });
        if (!project) throw new Error(`project ${projectId} not found in organization ${organizationId}`);

        const run = await tx.qaRun.create({
          data: {
            organizationId,
            projectId,
            status: 'RUNNING',
            triggeredById: requestedBy ?? null,
            scope: { locale: locale ?? null, source: 'queue', jobId: job.id ?? null } as never,
            startedAt: new Date(),
          },
        });

        const entries = await tx.translationEntry.findMany({
          where: { projectId, ...(locale ? { localeCode: locale } : {}) },
          include: { key: { include: { namespace: true, sourceVersions: { orderBy: { version: 'desc' }, take: 1 } } } },
        });
        const glossary = await tx.glossaryTerm.findMany({ where: { organizationId, OR: [{ projectId }, { projectId: null }] } });

        const candidates: QaCandidateEntry[] = entries.map((entry) => ({
          entryId: entry.id,
          key: entry.key.key,
          locale: entry.localeCode,
          platform: entry.key.platform,
          namespace: entry.key.namespace.name,
          value: entry.value,
          status: entry.status,
          sourceValue: entry.key.sourceVersions[0]?.value ?? '',
          sourceLocale: project.sourceLocale,
          glossaryTerms: glossary.map((term) => ({
            term: term.term,
            translations: (term.translations ?? {}) as Record<string, string>,
            caseSensitive: term.caseSensitive,
          })),
        }));

        const findings = runQaRules(candidates);
        const entryIds = entries.map((entry) => entry.id);
        if (entryIds.length) {
          await tx.qaIssue.deleteMany({ where: { projectId, entryId: { in: entryIds }, status: 'OPEN' } });
        }
        if (findings.length) {
          await tx.qaIssue.createMany({
            data: findings.map((finding) => ({
              organizationId,
              projectId,
              runId: run.id,
              entryId: finding.entryId,
              translationKey: finding.key,
              localeCode: finding.locale,
              ruleCode: finding.ruleCode,
              severity: finding.severity,
              message: finding.message,
              details: finding.details as never,
            })),
          });
        }
        await tx.qaRun.update({
          where: { id: run.id },
          data: { status: 'SUCCEEDED', finishedAt: new Date(), issueCount: findings.length },
        });
        return { issues: findings.length, entries: entries.length };
        });
      },
      { connection, concurrency: 2 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.IMPORT_EXPORT,
      async (job: Job) => {
        // Import/export of large files is handled by the API synchronously for small batches and
        // delegated here for large ones. Placeholder implementation until object storage is wired.
        return { accepted: true, jobId: job.id, note: 'Import/export job accepted; storage backend not configured.' };
      },
      { connection, concurrency: 1 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.NOTIFICATIONS,
      async (job: Job) => ({ delivered: false, reason: 'No notification channel configured', jobId: job.id }),
      { connection, concurrency: 2 },
    ),
  );

  workers.push(
    new Worker(
      QUEUE_NAMES.AI,
      async (job: Job) => ({ skipped: true, reason: 'AI jobs are created on demand from the API; no background AI work is configured.', jobId: job.id }),
      { connection, concurrency: 1 },
    ),
  );

  workers.push(startWebhookWorker(connection, prisma, tenant));

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      console.error(`[worker:${worker.name}] job ${job?.id ?? '?'} failed: ${error.message}`);
    });
    worker.on('completed', (job) => {
      console.log(`[worker:${worker.name}] job ${job.id} completed`);
    });
  }

  return workers;
}
