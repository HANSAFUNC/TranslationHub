import { Worker, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import type { Prisma, PrismaClient, TenantPrisma } from '@localehub/database';
import { decryptSecret, nextWebhookAttempt, signWebhook, type WebhookEvent } from '@localehub/domain';
import { QUEUE_NAMES } from './queues';

/**
 * Webhook delivery.
 *
 * The queue carries a delivery id, never the payload: the payload lives in `webhook_deliveries`
 * so a worker restart, a redeploy or a Redis flush cannot lose an event that was already accepted.
 * The job re-reads the row, which also makes a redelivered job idempotent — the row's `attempts`
 * counter, not the job, decides when to give up.
 *
 * Every read and write happens inside `TenantPrisma.withOrganization`. A bare `PrismaClient` sets
 * no organization context, and every tenant table is behind row level security, so an unscoped
 * read returns **zero rows** — a delivery that looks like it was never processed. The organization
 * id travels in the job payload for exactly that reason: reading the row is what needs it.
 */

/** A consumer that hangs must not hold a worker slot; the retry schedule handles the rest. */
const DELIVERY_TIMEOUT_MS = 10_000;

export interface WebhookJobPayload {
  deliveryId: string;
  /** Required, and not looked up from the delivery: that lookup is what needs it. */
  organizationId: string;
}

export function startWebhookWorker(connection: IORedis, prisma: PrismaClient, tenant: TenantPrisma): Worker {
  return new Worker<WebhookJobPayload>(
    QUEUE_NAMES.WEBHOOKS,
    async (job: Job<WebhookJobPayload>) =>
      tenant.withOrganization(job.data.organizationId, (tx) => deliver(job.data.deliveryId, tx, prisma)),
    { connection, concurrency: 4 },
  );
}

/** One delivery attempt: read, sign, POST, record. */
async function deliver(deliveryId: string, tx: Prisma.TransactionClient, _prisma: PrismaClient): Promise<unknown> {
  const delivery = await tx.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });
  if (!delivery) return { skipped: 'delivery row no longer exists' };
  if (delivery.status === 'DELIVERED') return { skipped: 'already delivered' };
  if (!delivery.webhook.active) {
    // Disabled after the event was queued: recorded as such rather than silently dropped.
    await tx.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'CANCELLED', lastError: 'Endpoint was disabled before delivery' },
    });
    return { skipped: 'endpoint disabled' };
  }

  const secret = decryptSecret(delivery.webhook.secretEncrypted, encryptionKey());
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const attempts = delivery.attempts + 1;

  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(delivery.webhook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'localehub-webhook/0.1.0',
        // The event id lets a consumer deduplicate; the type lets it route without parsing.
        'x-localehub-event': delivery.eventType,
        'x-localehub-event-id': delivery.eventId,
        'x-localehub-signature': signWebhook({ timestamp, body }, secret),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    statusCode = response.status;
    if (!response.ok) {
      // The first part of the body is the most useful thing to keep; a full HTML error page would
      // bloat the row without telling anybody more.
      const text = await response.text().catch(() => '');
      error = `HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const delivered = statusCode !== null && statusCode >= 200 && statusCode < 300;
  const nextAttemptAt = delivered ? null : nextWebhookAttempt(attempts);

  await tx.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attempts,
      status: delivered ? 'DELIVERED' : nextAttemptAt ? 'PENDING' : 'FAILED',
      lastStatusCode: statusCode,
      lastError: error,
      nextAttemptAt,
      deliveredAt: delivered ? new Date() : null,
    },
  });

  if (!delivered && !nextAttemptAt) {
    // Exhausted. Throwing would make BullMQ retry the job and undo the decision the row already
    // records, so this reports the outcome instead.
    console.error(
      `[worker:webhooks] delivery ${delivery.id} gave up after ${attempts} attempts: ${error ?? 'unknown error'}`,
    );
    return { delivered: false, attempts, exhausted: true, statusCode, error };
  }
  return { delivered, attempts, statusCode, error, nextAttemptAt: nextAttemptAt?.toISOString() ?? null };
}

function encryptionKey(): string {
  return process.env.ENCRYPTION_KEY ?? 'dev-only-encryption-key-change-me';
}

/** Convenience for tests and for the API when it wants to describe an event before storing it. */
export function describeWebhookEvent(event: WebhookEvent): string {
  return `${event.type} ${event.id}`;
}
