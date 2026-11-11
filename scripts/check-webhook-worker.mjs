import { createServer } from 'node:http';
import { createRequire } from 'node:module';

// The workspace packages are CommonJS; resolve from the repo root so this script can live in
// `scripts/` without needing its own node_modules.
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const { verifyWebhookSignature } = require('@localehub/domain');

/**
 * Live check of the queue + worker path.
 *
 * The integration suite drives a delivery from its row, which exercises signing and POSTing but
 * not the BullMQ hop. This stands up a real receiver, creates a webhook through the API, publishes
 * an event through the API, and waits for the *worker process* to deliver it.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:3009/api/v1';
const TOKEN = process.env.SESSION_TOKEN;
if (!TOKEN) throw new Error('SESSION_TOKEN is required');

const received = [];
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    received.push({ headers: request.headers, body });
    response.writeHead(200).end('ok');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/hook`;

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const stamp = Date.now().toString(36);
const me = await call('/auth/me');
const project = await call('/projects', {
  method: 'POST',
  body: { name: `worker-check-${stamp}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
});
const projectId = project.body.data.id;

const hook = await call('/organization/webhooks', {
  method: 'POST',
  body: { url, eventTypes: ['SYNC_PUSHED'] },
});
if (hook.status !== 201) throw new Error(`webhook create failed: ${JSON.stringify(hook.body)}`);
const secret = hook.body.data.secret;
console.log('created webhook', hook.body.data.secretPrefix, '→', url);

const hash = (seed) => seed.padEnd(64, '0').slice(0, 64);
const file = (locale, values) => {
  const fileId = `web-${locale}`;
  const filePath = `locales/${locale}/common.json`;
  return {
    file: { fileId, filePath, locale, platform: 'web', format: 'json', fileHash: hash(locale), entryCount: Object.keys(values).length },
    entries: Object.entries(values).map(([key, value]) => ({
      key, namespace: 'common', locale, value,
      isSource: locale === 'en-US', contentHash: hash(key + locale), fileId, filePath,
    })),
  };
};

const source = file('en-US', { 'checkout.title': 'Checkout' });
const target = file('ja-JP', { 'checkout.title': 'お会計' });
const scan = await call('/sync/scans', {
  method: 'POST',
  body: {
    projectId, scanId: `scan-${stamp}`,
    client: { name: 'worker-check', version: '0' },
    files: [source.file, target.file],
    entries: [...source.entries, ...target.entries],
  },
});
if (scan.status !== 201) throw new Error(`scan failed: ${JSON.stringify(scan.body)}`);

const preview = await call('/sync/preview', {
  method: 'POST',
  body: {
    projectId,
    repositoryConnectionId: scan.body.data.connectionId,
    scanId: scan.body.data.scanId,
    direction: 'push',
  },
});
if (preview.status !== 201) throw new Error(`preview failed: ${JSON.stringify(preview.body)}`);

const push = await call('/sync/push', {
  method: 'POST',
  body: { syncPlanId: preview.body.data.syncPlanId, planHash: preview.body.data.planHash, confirmed: true },
});
if (push.status !== 201) throw new Error(`push failed: ${JSON.stringify(push.body)}`);
console.log('published SYNC_PUSHED; waiting for the worker…');

const deadline = Date.now() + 30_000;
while (Date.now() < deadline && received.length === 0) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (!received.length) {
  console.log('RESULT: no delivery within 30s — the worker did not pick the job up');
} else {
  const delivery = received[0];
  const verified = verifyWebhookSignature({
    header: String(delivery.headers['x-localehub-signature']),
    body: delivery.body,
    secret,
  });
  const parsed = JSON.parse(delivery.body);
  console.log('RESULT: delivered', parsed.type, '| signature verified:', verified, '| event:', delivery.headers['x-localehub-event-id']);
  console.log('delivery header:', String(delivery.headers['x-localehub-signature']).slice(0, 24) + '…');
  console.log('org matches:', parsed.organizationId === me.body.data.organizationId, '| project matches:', parsed.projectId === projectId);
}

// Leave the organization as found.
await call(`/organization/webhooks/${hook.body.data.id}`, { method: 'DELETE' });
await call(`/projects/${projectId}`, { method: 'DELETE' }).catch(() => undefined);
server.close();
