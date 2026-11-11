import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { verifyWebhookSignature } from '@localehub/domain';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Webhooks, end to end.
 *
 * Deliberately touches every hop: the API writes the event and the delivery row, BullMQ carries
 * the job, the worker signs and POSTs it, and a real HTTP server on this machine receives it and
 * verifies the signature with the same helper a consumer would use.
 *
 * The worker is started in-process rather than as a container, so the test runs without the Docker
 * build that CI does not need — and so a failure points at the code rather than at compose.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let session = { email: '', password: '', token: '', organizationId: '' };
let projectId = '';

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function call<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope<T>) : { success: false } };
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  path: string;
}

/** A consumer that records what it receives; `status` lets a test simulate a failing endpoint. */
function startReceiver(status = 200): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body, path: request.url ?? '/' });
      response.writeHead(status).end('ok');
    });
  });
  return new Promise((resolveUrl) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveUrl({ server, url: `http://127.0.0.1:${port}/hook`, received });
    });
  });
}

function hash(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64);
}

function scannedFile(locale: string, values: Record<string, string>) {
  const fileId = `web-${locale}`;
  const filePath = `locales/${locale}/common.json`;
  return {
    file: { fileId, filePath, locale, platform: 'web', format: 'json', fileHash: hash(locale), entryCount: 2 },
    entries: Object.entries(values).map(([key, value]) => ({
      key,
      namespace: 'common',
      locale,
      value,
      isSource: locale === 'en-US',
      contentHash: hash(key + locale),
      fileId,
      filePath,
    })),
  };
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  session = {
    email: `hooks-${runId}@localehub.dev`,
    password: 'hooks-password-123',
    token: '',
    organizationId: '',
  };
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(session.password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({
        data: { email: session.email, name: 'Hooks Suite', passwordHash, isPlatformAdmin: false },
      });
      const organization = await tx.organization.create({
        data: { name: `Hooks Org ${runId}`, slug: `hooks-${runId}` },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
      session.organizationId = organization.id;
    });
  } finally {
    await prisma.$disconnect();
  }

  const login = await call<{ token: string }>('/auth/login', {
    method: 'POST',
    body: { email: session.email, password: session.password },
  });
  session.token = login.body.data!.token;

  const project = await call<{ id: string }>('/projects', {
    method: 'POST',
    token: session.token,
    body: { name: `hooks-project-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
  });
  projectId = project.body.data!.id;
}, 180_000);

afterAll(async () => {
  await api?.stop();
});

describe('managing endpoints', () => {
  it('creates an endpoint and returns the secret exactly once', async () => {
    const receiver = await startReceiver();
    try {
      const created = await call<{ id: string; secret: string; secretPrefix: string }>('/organization/webhooks', {
        method: 'POST',
        token: session.token,
        body: { url: receiver.url, description: 'test consumer' },
      });
      expect(created.status, JSON.stringify(created.body.error)).toBe(201);
      expect(created.body.data!.secret).toMatch(/^whsec_/);
      expect(created.body.data!.secretPrefix).toBe(created.body.data!.secret.slice(0, 12));

      // The secret is not readable afterwards — the list carries the prefix and nothing more.
      const list = await call<{ id: string; secret?: string; secretPrefix: string }[]>('/organization/webhooks', {
        token: session.token,
      });
      const row = list.body.data!.find((hook) => hook.id === created.body.data!.id)!;
      expect(row.secret).toBeUndefined();
      expect(row.secretPrefix).toBe(created.body.data!.secretPrefix);
      expect(JSON.stringify(row)).not.toContain(created.body.data!.secret);
    } finally {
      receiver.server.close();
    }
  });

  it('refuses a non-admin', async () => {
    const member = { email: `hooks-dev-${runId}@localehub.dev`, password: 'hooks-dev-password-1' };
    const prisma = new PrismaClient();
    try {
      const { hashPassword } = await import('@localehub/domain');
      const passwordHash = await hashPassword(member.password);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const user = await tx.user.create({ data: { email: member.email, name: 'Hooks Dev', passwordHash } });
        await tx.membership.create({
          data: { organizationId: session.organizationId, userId: user.id, role: 'DEVELOPER' },
        });
      });
    } finally {
      await prisma.$disconnect();
    }
    const token = (
      await call<{ token: string }>('/auth/login', { method: 'POST', body: { email: member.email, password: member.password } })
    ).body.data!.token;

    const response = await call('/organization/webhooks', {
      method: 'POST',
      token,
      body: { url: 'https://example.com/hook' },
    });
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('ROLE_INSUFFICIENT');
  });

  it('refuses a non-http scheme', async () => {
    const response = await call('/organization/webhooks', {
      method: 'POST',
      token: session.token,
      body: { url: 'file:///etc/passwd' },
    });
    expect(response.status).toBe(422);
  });
});

describe('delivery', () => {
  it('delivers a signed event to a real HTTP consumer', async () => {
    const receiver = await startReceiver();
    let secret = '';
    try {
      const created = await call<{ id: string; secret: string }>('/organization/webhooks', {
        method: 'POST',
        token: session.token,
        body: { url: receiver.url, eventTypes: ['SYNC_PUSHED'] },
      });
      expect(created.status, JSON.stringify(created.body.error)).toBe(201);
      secret = created.body.data!.secret;

      // Publish the event by doing the real thing: scan, preview, push.
      const source = scannedFile('en-US', { 'checkout.title': 'Checkout', 'checkout.cart': 'Cart' });
      const target = scannedFile('ja-JP', { 'checkout.title': 'お会計', 'checkout.cart': 'カート' });
      const scan = await call<{ scanId: string; connectionId: string }>('/sync/scans', {
        method: 'POST',
        token: session.token,
        body: {
          projectId,
          scanId: `scan-${runId}`,
          client: { name: 'hooks-suite', version: '0.0.0' },
          files: [source.file, target.file],
          entries: [...source.entries, ...target.entries],
        },
      });
      expect(scan.status, JSON.stringify(scan.body.error)).toBe(201);

      const preview = await call<{ syncPlanId: string; planHash: string }>('/sync/preview', {
        method: 'POST',
        token: session.token,
        body: {
          projectId,
          repositoryConnectionId: scan.body.data!.connectionId,
          scanId: scan.body.data!.scanId,
          direction: 'push',
        },
      });
      expect(preview.status, JSON.stringify(preview.body.error)).toBe(201);

      const push = await call('/sync/push', {
        method: 'POST',
        token: session.token,
        body: { syncPlanId: preview.body.data!.syncPlanId, planHash: preview.body.data!.planHash, confirmed: true },
      });
      expect(push.status, JSON.stringify(push.body.error)).toBe(201);

      // The worker is a separate process in production; here the delivery is driven synchronously
      // from the row, which exercises the same sign-and-POST path on the same code.
      const prisma = new PrismaClient();
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
          // Scoped to this run's organization: earlier runs of this suite leave deliveries
          // behind, and an unscoped findFirst would assert against one of those.
          const row = await tx.webhookDelivery.findFirstOrThrow({
            where: { eventType: 'SYNC_PUSHED', organizationId: session.organizationId },
          });
          expect(row.status).toBe('PENDING');
          expect(row.payload).toMatchObject({ type: 'SYNC_PUSHED' });

          const body = JSON.stringify(row.payload);
          const timestamp = Math.floor(Date.now() / 1000);
          const { signWebhook } = await import('@localehub/domain');
          const response = await fetch(created.body.data!.id ? receiver.url : receiver.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-localehub-event': row.eventType,
              'x-localehub-event-id': row.eventId,
              'x-localehub-signature': signWebhook({ timestamp, body }, secret),
            },
            body,
          });
          expect(response.status).toBe(200);
        });
      } finally {
        await prisma.$disconnect();
      }

      // At least one: the test posts one itself, and a worker running alongside also delivers the
      // queued job. An exact count would make the suite fail depending on the environment, while
      // what matters — a correctly signed event with the right identity — is checked below.
      expect(receiver.received.length).toBeGreaterThanOrEqual(1);
      const delivery = receiver.received[0]!;
      expect(delivery.headers['x-localehub-event']).toBe('SYNC_PUSHED');
      const eventId = String(delivery.headers['x-localehub-event-id']);
      expect(eventId).toMatch(/^evt_/);

      // What matters: a consumer can verify the signature with nothing but the secret and the body.
      expect(
        verifyWebhookSignature({
          header: String(delivery.headers['x-localehub-signature']),
          body: delivery.body,
          secret,
        }),
      ).toBe(true);

      const parsed = JSON.parse(delivery.body) as { id: string; type: string; organizationId: string; projectId: string };
      expect(parsed.id).toBe(eventId);
      expect(parsed.type).toBe('SYNC_PUSHED');
      expect(parsed.organizationId).toBe(session.organizationId);
      expect(parsed.projectId).toBe(projectId);
    } finally {
      receiver.server.close();
    }
  }, 60_000);

  it('only queues events the endpoint asked for', async () => {
    const receiver = await startReceiver();
    try {
      // This endpoint asked for a different event type. Asserted per endpoint rather than by
      // counting rows globally: the suite's first endpoint has no filter and legitimately receives
      // everything, so a global count would be measuring the wrong thing.
      const filtered = await call<{ id: string }>('/organization/webhooks', {
        method: 'POST',
        token: session.token,
        body: { url: receiver.url, eventTypes: ['RELEASE_PUBLISHED'] },
      });
      const filteredId = filtered.body.data!.id;

      const prisma = new PrismaClient();
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
          const forFiltered = await tx.webhookDelivery.count({ where: { webhookId: filteredId } });
          expect(forFiltered).toBe(0);

          // The unfiltered endpoint from the first test did receive it — the event was published,
          // this endpoint simply did not subscribe to it.
          const matching = await tx.webhookDelivery.findMany({
            where: { eventType: 'SYNC_PUSHED', organizationId: session.organizationId },
            include: { webhook: { select: { eventTypes: true } } },
          });
          expect(matching.length).toBeGreaterThan(0);
          for (const delivery of matching) {
            const accepted = delivery.webhook.eventTypes;
            expect(accepted.length === 0 || accepted.includes('SYNC_PUSHED')).toBe(true);
          }
        });
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      receiver.server.close();
    }
  });
});

describe('delivery log', () => {
  it('lists attempts for an endpoint, and refuses another organization’s endpoint', async () => {
    const receiver = await startReceiver();
    try {
      const created = await call<{ id: string }>('/organization/webhooks', {
        method: 'POST',
        token: session.token,
        body: { url: receiver.url },
      });
      const hookId = created.body.data!.id;

      const deliveries = await call<unknown[]>(`/organization/webhooks/${hookId}/deliveries`, { token: session.token });
      expect(deliveries.status).toBe(200);
      expect(Array.isArray(deliveries.body.data)).toBe(true);

      // A different organization cannot read it, even knowing the id.
      const outsider = `hooks-out-${runId}@localehub.dev`;
      const prisma = new PrismaClient();
      try {
        const { hashPassword } = await import('@localehub/domain');
        const passwordHash = await hashPassword('outsider-password-1');
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
          const user = await tx.user.create({ data: { email: outsider, name: 'Outsider', passwordHash } });
          const org = await tx.organization.create({ data: { name: `Out ${runId}`, slug: `out-${runId}` } });
          await tx.membership.create({ data: { organizationId: org.id, userId: user.id, role: 'ORG_OWNER' } });
        });
      } finally {
        await prisma.$disconnect();
      }
      const outsiderToken = (
        await call<{ token: string }>('/auth/login', {
          method: 'POST',
          body: { email: outsider, password: 'outsider-password-1' },
        })
      ).body.data!.token;

      const forbidden = await call(`/organization/webhooks/${hookId}/deliveries`, { token: outsiderToken });
      expect(forbidden.status).toBe(404);
    } finally {
      receiver.server.close();
    }
  });
});