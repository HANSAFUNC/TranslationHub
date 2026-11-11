import { Injectable } from '@nestjs/common';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import {
  assertDeliverableWebhookUrl,
  encryptSecret,
  generateToken,
  webhookAccepts,
} from '@localehub/domain';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { QueueService, QUEUE_NAMES } from '../../common/queue.service';

/**
 * Webhook fan-out and management.
 *
 * An event is written to `webhook_deliveries` first and queued second. The row is the durable
 * record — the queue is only a nudge to the worker — so an event accepted just before a restart
 * is still delivered afterwards, and an operator can always answer "did this reach them".
 *
 * Delivery is at-least-once by design: the same event may arrive twice (a worker crash after the
 * consumer processed it but before the row was updated). Each request carries
 * `x-localehub-event-id`, which is what a consumer deduplicates on.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  /** Every route here is an administrator action; asserted in the service, not by a decorator. */
  private assertAdmin(actor: { orgRole: string | null; isPlatformAdmin?: boolean; kind?: string }): void {
    if (actor.isPlatformAdmin) return;
    if (actor.kind && actor.kind !== 'user') {
      throw new LocaleHubError(ErrorCode.ROLE_INSUFFICIENT, 'MCP tokens cannot manage webhooks', 403);
    }
    if (actor.orgRole !== 'ORG_OWNER' && actor.orgRole !== 'ORG_ADMIN') {
      throw new LocaleHubError(
        ErrorCode.ROLE_INSUFFICIENT,
        'Organization admin or owner is required to manage webhooks',
        403,
      );
    }
  }

  private encryptionKey(): string {
    return process.env.ENCRYPTION_KEY ?? 'dev-only-encryption-key-change-me';
  }

  async list(actor: { organizationId: string }) {
    this.assertAdmin(actor as never);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const hooks = await tx.webhook.findMany({ orderBy: { createdAt: 'desc' } });
      const counts = await tx.webhookDelivery.groupBy({
        by: ['webhookId', 'status'],
        _count: { _all: true },
      });
      const byHook = new Map<string, Record<string, number>>();
      for (const row of counts) {
        const current = byHook.get(row.webhookId) ?? {};
        current[row.status] = row._count._all;
        byHook.set(row.webhookId, current);
      }
      return hooks.map((hook) => ({
        id: hook.id,
        url: hook.url,
        eventTypes: hook.eventTypes,
        secretPrefix: hook.secretPrefix,
        active: hook.active,
        description: hook.description,
        createdAt: hook.createdAt.toISOString(),
        // Counts only — never the encrypted secret, which has no business leaving the server.
        deliveries: byHook.get(hook.id) ?? {},
      }));
    });
  }

  async create(
    actor: { organizationId: string; userId: string },
    input: { url: string; eventTypes?: string[]; description?: string },
  ) {
    this.assertAdmin(actor as never);
    const url = assertDeliverableWebhookUrl(input.url).toString();
    // The plaintext is returned once and never stored in the clear, the same contract as an MCP
    // token — with one difference the schema comments explain: the secret is encrypted, not
    // hashed, because the worker has to *produce* a signature rather than only check one.
    const { token: secret, tokenPrefix } = generateToken('webhook');

    const hook = await this.prisma.tenant.withOrganization(actor.organizationId, (tx) =>
      tx.webhook.create({
        data: {
          organizationId: actor.organizationId,
          url,
          eventTypes: input.eventTypes ?? [],
          secretEncrypted: encryptSecret(secret, this.encryptionKey()),
          secretPrefix: tokenPrefix,
          description: input.description ?? null,
          createdById: actor.userId,
        },
      }),
    );

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'webhook.create',
      resourceType: 'webhook',
      resourceId: hook.id,
      metadata: { url, eventTypes: hook.eventTypes },
    });

    return {
      id: hook.id,
      url: hook.url,
      eventTypes: hook.eventTypes,
      secret,
      secretPrefix: tokenPrefix,
      hint: 'The signing secret is shown once. Verify deliveries with the x-localehub-signature header.',
    };
  }

  async update(
    actor: { organizationId: string; userId: string },
    id: string,
    input: { active?: boolean; eventTypes?: string[]; description?: string },
  ) {
    this.assertAdmin(actor as never);
    const updated = await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const existing = await tx.webhook.findUnique({ where: { id } });
      if (!existing) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Webhook ${id} not found`, 404);
      return tx.webhook.update({
        where: { id },
        data: {
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.eventTypes === undefined ? {} : { eventTypes: input.eventTypes }),
          ...(input.description === undefined ? {} : { description: input.description }),
        },
      });
    });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'webhook.update',
      resourceType: 'webhook',
      resourceId: id,
      metadata: { ...input },
    });
    return { id: updated.id, active: updated.active, eventTypes: updated.eventTypes };
  }

  async remove(actor: { organizationId: string; userId: string }, id: string) {
    this.assertAdmin(actor as never);
    await this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const existing = await tx.webhook.findUnique({ where: { id } });
      if (!existing) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Webhook ${id} not found`, 404);
      // Deliveries cascade with the endpoint: keeping them would preserve payloads for an
      // endpoint whose owner asked for removal.
      await tx.webhook.delete({ where: { id } });
    });
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'webhook.delete',
      resourceType: 'webhook',
      resourceId: id,
      metadata: {},
    });
    return { id, deleted: true };
  }

  /** Delivery history for one endpoint, most recent first. */
  async deliveries(actor: { organizationId: string }, id: string, limit = 100) {
    this.assertAdmin(actor as never);
    return this.prisma.tenant.withOrganization(actor.organizationId, async (tx) => {
      const existing = await tx.webhook.findUnique({ where: { id } });
      if (!existing) throw new LocaleHubError(ErrorCode.NOT_FOUND, `Webhook ${id} not found`, 404);
      const rows = await tx.webhookDelivery.findMany({
        where: { webhookId: id },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 500),
      });
      return rows.map((row) => ({
        id: row.id,
        eventId: row.eventId,
        eventType: row.eventType,
        status: row.status,
        attempts: row.attempts,
        lastStatusCode: row.lastStatusCode,
        lastError: row.lastError,
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  /**
   * Record an event for every matching endpoint and queue it.
   *
   * Failure here must not fail the caller: a translation that was approved is approved whether or
   * not somebody's webhook endpoint answers. The rows and the queue are the retry mechanism, so
   * this reports what it queued and swallows the rest.
   */
  async publish(event: {
    organizationId: string;
    type: string;
    projectId?: string | null;
    data: Record<string, unknown>;
  }): Promise<{ queued: number }> {
    try {
      const hooks = await this.prisma.tenant.withOrganization(event.organizationId, (tx) =>
        tx.webhook.findMany({ where: { organizationId: event.organizationId, active: true } }),
      );
      const targets = hooks.filter((hook) => webhookAccepts(event.type, hook.eventTypes));
      if (!targets.length) return { queued: 0 };

      const eventId = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const payload = {
        id: eventId,
        type: event.type,
        organizationId: event.organizationId,
        projectId: event.projectId ?? null,
        createdAt: new Date().toISOString(),
        data: event.data,
      };

      let queued = 0;
      for (const hook of targets) {
        const delivery = await this.prisma.tenant.withOrganization(event.organizationId, (tx) =>
          tx.webhookDelivery.create({
            data: {
              organizationId: event.organizationId,
              webhookId: hook.id,
              eventId,
              eventType: event.type,
              payload: payload as never,
              status: 'PENDING',
              nextAttemptAt: new Date(),
            },
          }),
        );
        // `jobId` = the delivery id, so queueing the same delivery twice collapses into one job.
        // The organization id travels with the job: the delivery row is behind row level
        // security, so the worker needs it to read the row it is about to process.
        const result = await this.queue.enqueue(
          QUEUE_NAMES.WEBHOOKS,
          'deliver',
          { deliveryId: delivery.id, organizationId: event.organizationId },
          { jobId: delivery.id },
        );
        if (result.queued) queued += 1;
        else {
          // `enqueue` swallows the error so the request can still succeed. Logged here because a
          // delivery row nobody was told about looks exactly like a worker that never ran.
          console.error(`[webhooks] could not queue delivery ${delivery.id}; it stays PENDING and needs a retry`);
        }
      }
      return { queued };
    } catch (error) {
      console.error('[webhooks] failed to publish event:', error instanceof Error ? error.message : error);
      return { queued: 0 };
    }
  }
}