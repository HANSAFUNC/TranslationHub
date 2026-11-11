import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { readZipEntries } from '@localehub/domain';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Release bundles, end to end.
 *
 * The zip builder has its own unit tests. What only a live run shows is that a release built
 * through the API produces a downloadable archive whose manifest agrees with what a consumer can
 * read back out of it — and that the download is authorized per project rather than per path.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let session = { email: '', password: '', token: '' };
let projectId = '';
let bundleDir = '';

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

function hash(seed: string): string {
  return seed.padEnd(64, '0').slice(0, 64);
}

beforeAll(async () => {
  // The API process decides where bundles go; this suite points it at a scratch directory.
  bundleDir = mkdtempSync(join(tmpdir(), 'localehub-bundle-it-'));
  api = await ensureApi(API_BASE, { root: ROOT });

  session = { email: `bundle-${runId}@localehub.dev`, password: 'bundle-password-123', token: '' };
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(session.password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({
        data: { email: session.email, name: 'Bundle Suite', passwordHash, isPlatformAdmin: false },
      });
      const organization = await tx.organization.create({
        data: { name: `Bundle Org ${runId}`, slug: `bundle-${runId}` },
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
    body: { name: `bundle-project-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
  });
  projectId = project.body.data!.id;

  const file = (locale: string, values: Record<string, string>) => {
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
  };

  const source = file('en-US', { 'checkout.title': 'Checkout', 'checkout.cart': 'Cart' });
  const target = file('ja-JP', { 'checkout.title': 'お会計', 'checkout.cart': 'カート' });
  const scan = await call<{ scanId: string; connectionId: string }>('/sync/scans', {
    method: 'POST',
    token: session.token,
    body: {
      projectId,
      scanId: `scan-${runId}`,
      client: { name: 'bundle-suite', version: '0.0.0' },
      files: [source.file, target.file],
      entries: [...source.entries, ...target.entries],
    },
  });
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
  await call('/sync/push', {
    method: 'POST',
    token: session.token,
    body: { syncPlanId: preview.body.data!.syncPlanId, planHash: preview.body.data!.planHash, confirmed: true },
  });

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
  rmSync(bundleDir, { recursive: true, force: true });
});

describe('release bundles', () => {
  let releaseId = '';

  it('builds a release from approved translations', async () => {
    const release = await call<{ id: string; snapshotCount: number }>(`/projects/${projectId}/releases`, {
      method: 'POST',
      token: session.token,
      body: { name: `release-${runId}`, locales: ['ja-JP'] },
    });
    expect(release.status, JSON.stringify(release.body.error)).toBe(201);
    expect(release.body.data!.snapshotCount).toBeGreaterThan(0);
    releaseId = release.body.data!.id;
  });

  it('refuses the download before a bundle has been built', async () => {
    const response = await fetch(`${API_BASE}/projects/${projectId}/releases/${releaseId}/bundle`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(404);
  });

  it('builds a zip and reports what is inside it', async () => {
    const built = await call<{ files: string[]; bytes: number; downloadPath: string }>(
      `/projects/${projectId}/releases/${releaseId}/bundle`,
      { method: 'POST', token: session.token },
    );
    expect(built.status, JSON.stringify(built.body.error)).toBe(201);
    expect(built.body.data!.files).toContain('ja-JP/common.json');
    expect(built.body.data!.bytes).toBeGreaterThan(100);
  });

  it('serves the archive as raw bytes, not wrapped in the JSON envelope', async () => {
    const response = await fetch(`${API_BASE}/projects/${projectId}/releases/${releaseId}/bundle`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('attachment');

    const archive = Buffer.from(await response.arrayBuffer());
    // PK\x03\x04 — and the envelope would have made the first bytes `{"success"`.
    expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const entries = readZipEntries(archive);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('ja-JP/common.json');
    expect(names).toContain('manifest.json');

    const manifest = JSON.parse(entries.find((entry) => entry.name === 'manifest.json')!.data.toString('utf8'));
    expect(manifest.release).toBe(`release-${runId}`);
    expect(manifest.locales).toEqual(['ja-JP']);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(
      names.filter((name) => name !== 'manifest.json'),
    );

    const japanese = JSON.parse(entries.find((entry) => entry.name === 'ja-JP/common.json')!.data.toString('utf8'));
    expect(Object.values(japanese)).toContain('お会計');
  });

  it('is deterministic: rebuilding produces identical bytes', async () => {
    const first = Buffer.from(
      await (
        await fetch(`${API_BASE}/projects/${projectId}/releases/${releaseId}/bundle`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).arrayBuffer(),
    );
    await call(`/projects/${projectId}/releases/${releaseId}/bundle`, { method: 'POST', token: session.token });
    const second = Buffer.from(
      await (
        await fetch(`${API_BASE}/projects/${projectId}/releases/${releaseId}/bundle`, {
          headers: { authorization: `Bearer ${session.token}` },
        })
      ).arrayBuffer(),
    );
    // The recorded checksum is only meaningful if the same release yields the same archive.
    expect(first.equals(second)).toBe(true);
  });

  it('does not serve a release id from another project', async () => {
    const other = await call<{ id: string }>('/projects', {
      method: 'POST',
      token: session.token,
      body: { name: `bundle-other-${runId}`, sourceLocale: 'en-US' },
    });
    const response = await fetch(`${API_BASE}/projects/${other.body.data!.id}/releases/${releaseId}/bundle`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    // The release belongs to a different project, so the path does not address it.
    expect(response.status).toBe(404);
  });
});