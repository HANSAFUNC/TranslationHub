import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Import/export formats, end to end.
 *
 * Spec §10.1 adds CSV and XLSX for "产品经理批量编辑、导入校验". The adapters have their own unit
 * tests; what only a live run shows is that the export endpoint can actually produce them — an
 * .xlsx has to arrive base64-encoded with a mime type, and a format the repository mapping may not
 * declare must still be accepted here.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let session = { email: '', password: '', token: '' };
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

interface ExportFile {
  filePath: string;
  format: string;
  content: string;
  locale: string;
  encoding?: 'utf8' | 'base64';
  mimeType?: string;
}

/** A sha256-shaped hash; the schema pins the length, and nothing here validates the value. */
function hash(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64);
}

/** One locale's worth of scan entries, in the flat shape `POST /sync/scans` expects. */
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

  session = { email: `export-${runId}@localehub.dev`, password: 'export-password-123', token: '' };
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(session.password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({
        data: { email: session.email, name: 'Export Suite', passwordHash, isPlatformAdmin: false },
      });
      const organization = await tx.organization.create({
        data: { name: `Export Org ${runId}`, slug: `export-${runId}` },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
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
    body: { name: `export-project-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
  });
  projectId = project.body.data!.id;

  const source = scannedFile('en-US', { 'checkout.title': 'Checkout', 'checkout.cart': 'Cart' });
  const target = scannedFile('ja-JP', { 'checkout.title': 'お会計', 'checkout.cart': 'カート' });
  const scan = await call<{ scanId: string; connectionId: string }>('/sync/scans', {
    method: 'POST',
    token: session.token,
    body: {
      projectId,
      scanId: `scan-${runId}`,
      client: { name: 'export-suite', version: '0.0.0' },
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

  // The export endpoint only emits APPROVED translations, so approve whatever is waiting.
  const queue = await call<{ entryId: string }[]>(`/projects/${projectId}/reviews/queue`, { token: session.token });
  for (const item of queue.body.data ?? []) {
    await call('/translations/review', {
      method: 'POST',
      token: session.token,
      body: { projectId, entryIds: [item.entryId], decision: 'APPROVE' },
    });
  }
}, 180_000);

afterAll(async () => {
  await api?.stop();
});

async function exportAs(format: string) {
  return call<{ files: ExportFile[]; entryCount: number }>(
    `/projects/${projectId}/export?locale=ja-JP&format=${format}&platform=web`,
    { token: session.token },
  );
}

describe('export formats', () => {
  it('has approved Japanese translations to export', async () => {
    const response = await exportAs('json');
    expect(response.status, JSON.stringify(response.body.error)).toBe(200);
    expect(response.body.data!.entryCount).toBeGreaterThan(0);
  });

  it('exports JSON as inline UTF-8 text', async () => {
    const response = await exportAs('json');
    const file = response.body.data!.files[0]!;
    expect(file.encoding ?? 'utf8').toBe('utf8');
    expect(JSON.parse(file.content)).toMatchObject({ checkout: { title: 'お会計' } });
  });

  it('exports CSV with a header and one row per entry', async () => {
    const response = await exportAs('csv');
    expect(response.status, JSON.stringify(response.body.error)).toBe(200);
    const file = response.body.data!.files[0]!;
    expect(file.format).toBe('csv');
    expect(file.filePath.endsWith('.csv')).toBe(true);

    // A BOM, because Excel reads a BOM-less UTF-8 CSV as the system codepage.
    expect(file.content.startsWith('\uFEFF')).toBe(true);
    const lines = file.content.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe('key,namespace,locale,value,description');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.includes('お会計'))).toBe(true);
  });

  it('exports XLSX base64-encoded with its mime type', async () => {
    const response = await exportAs('xlsx');
    expect(response.status, JSON.stringify(response.body.error)).toBe(200);
    const file = response.body.data!.files[0]!;
    expect(file.format).toBe('xlsx');
    expect(file.encoding).toBe('base64');
    expect(file.mimeType).toContain('spreadsheetml');

    // Base64, not mangled text: decoding gives back a zip archive, which is what .xlsx is.
    const buffer = Buffer.from(file.content, 'base64');
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('reads the exported XLSX back into the same translations', async () => {
    const response = await exportAs('xlsx');
    const file = response.body.data!.files[0]!;
    const { XlsxAdapter } = await import('@localehub/format-adapters');
    const parsed = await new XlsxAdapter().parse({
      filePath: file.filePath,
      content: Buffer.from(file.content, 'base64'),
      locale: 'ja-JP',
      namespace: 'common',
      platform: 'web',
    });
    const byKey = Object.fromEntries(parsed.map((entry) => [entry.key, entry.value]));
    expect(byKey['checkout.title']).toBe('お会計');
    expect(byKey['checkout.cart']).toBe('カート');
  });

  it('refuses a format that is neither a sync format nor an import/export one', async () => {
    const response = await exportAs('parquet');
    expect(response.status).toBe(422);
    expect(response.body.error?.code).toBe('VALIDATION_ERROR');
  });
});
