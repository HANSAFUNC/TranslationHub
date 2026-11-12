import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Editing a project's own configuration from the settings page.
 *
 * The web page is a form over these routes, so what has to hold is the API's rules: a source
 * language can be changed only while nothing depends on it, a language that already exists under
 * another spelling is refused rather than duplicated, and a platform cannot be dropped while keys
 * still live on it. Each of those is a decision that is cheap now and expensive after a few
 * thousand entries.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let token = '';

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
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

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  sourceLocale: string;
  locales: { code: string; name: string; isSource: boolean }[];
  platforms: { platform: string }[];
}

const createProject = async (body: Record<string, unknown>) => {
  const created = await call<ProjectDetail>('/projects', { method: 'POST', token, body });
  expect(created.status, JSON.stringify(created.body.error)).toBe(201);
  return created.body.data!;
};

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  const email = `project-settings-${runId}@localehub.dev`;
  const password = 'project-settings-password-1';
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({ data: { email, name: 'Settings Suite', passwordHash, isPlatformAdmin: false } });
      const organization = await tx.organization.create({
        data: { name: `Settings Org ${runId}`, slug: `project-settings-${runId}` },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
    });
  } finally {
    await prisma.$disconnect();
  }

  const login = await call<{ token: string }>('/auth/login', { method: 'POST', body: { email, password } });
  token = login.body.data!.token;
}, 120_000);

afterAll(async () => {
  await api?.stop();
});

describe('editing a project', () => {
  it('saves name and description', async () => {
    const project = await createProject({ name: `Settings ${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] });
    const updated = await call<ProjectDetail>(`/projects/${project.id}`, {
      method: 'PATCH',
      token,
      body: { name: `Renamed ${runId}`, description: '写在项目页上的说明' },
    });
    expect(updated.status, JSON.stringify(updated.body.error)).toBe(200);
    expect(updated.body.data?.name).toBe(`Renamed ${runId}`);
    expect(updated.body.data?.description).toBe('写在项目页上的说明');
  });

  it('adds a target language, with a readable name', async () => {
    const project = await createProject({ name: `Add locale ${runId}`, sourceLocale: 'en-US' });
    const added = await call<{ code: string; name: string }>(`/projects/${project.id}/locales`, {
      method: 'POST',
      token,
      body: { code: 'ko-KR' },
    });
    expect(added.status, JSON.stringify(added.body.error)).toBe(201);
    expect(added.body.data?.code).toBe('ko-KR');
    // A language added from the UI is named the way a translator expects, not by its code.
    expect(added.body.data?.name).toBe('한국어');

    const detail = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    expect(detail.body.data?.locales.map((locale) => locale.code).sort()).toEqual(['en-US', 'ko-KR']);
  });

  it('refuses a second spelling of a language it already has', async () => {
    const project = await createProject({ name: `Equivalent ${runId}`, sourceLocale: 'zh-CN', locales: ['en-US'] });
    const refused = await call(`/projects/${project.id}/locales`, { method: 'POST', token, body: { code: 'zh-Hans' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toContain('zh-CN');

    // Nothing was created on the way to refusing: one Chinese, not two.
    const detail = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    expect(detail.body.data?.locales.map((locale) => locale.code).sort()).toEqual(['en-US', 'zh-CN']);
  });

  it('removes an unused language but never the source', async () => {
    const project = await createProject({ name: `Remove locale ${runId}`, sourceLocale: 'en-US', locales: ['fr-FR', 'de-DE'] });

    const removed = await call(`/projects/${project.id}/locales/fr-FR`, { method: 'DELETE', token });
    expect(removed.status, JSON.stringify(removed.body.error)).toBe(200);

    // The source is what every other translation is anchored to.
    const sourceRemoval = await call(`/projects/${project.id}/locales/en-US`, { method: 'DELETE', token });
    expect(sourceRemoval.status).toBe(409);

    const detail = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    expect(detail.body.data?.locales.map((locale) => locale.code).sort()).toEqual(['de-DE', 'en-US']);
  });

  it('changes the source language while the project is empty', async () => {
    const project = await createProject({ name: `Source swap ${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] });
    const updated = await call<{ sourceLocale: string }>(`/projects/${project.id}`, {
      method: 'PATCH',
      token,
      body: { sourceLocale: 'ja-JP' },
    });
    expect(updated.status, JSON.stringify(updated.body.error)).toBe(200);
    expect(updated.body.data?.sourceLocale).toBe('ja-JP');

    // Re-read for the languages: the flags are what make the swap real.
    const detail = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    const locales = detail.body.data!.locales;
    expect(locales.find((locale) => locale.code === 'ja-JP')?.isSource).toBe(true);
    expect(locales.find((locale) => locale.code === 'en-US')?.isSource).toBe(false);
  });

  it('refuses to re-point the source language once translations exist', async () => {
    const project = await createProject({ name: `Locked source ${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] });
    // One entry is enough: everything downstream is anchored to the source.
    const entryId = await (async () => {
      const scan = await call<{ connectionId: string; scanId: string }>('/sync/scans', {
        method: 'POST',
        token,
        body: {
          projectId: project.id,
          scanId: `scan-${runId}-locked`,
          client: { name: 'settings-suite', version: '0' },
          files: [{ fileId: 'web-en-US', filePath: 'locales/en-US/a.json', locale: 'en-US', platform: 'web', format: 'json', fileHash: '0'.repeat(64), entryCount: 1 }],
          entries: [
            {
              key: 'greeting',
              namespace: '',
              locale: 'en-US',
              value: 'Hello',
              isSource: true,
              contentHash: 'a'.repeat(64),
              fileId: 'web-en-US',
              filePath: 'locales/en-US/a.json',
            },
          ],
        },
      });
      expect(scan.status, JSON.stringify(scan.body.error)).toBe(201);
      const preview = await call<{ syncPlanId: string; planHash: string }>('/sync/preview', {
        method: 'POST',
        token,
        body: {
          projectId: project.id,
          repositoryConnectionId: scan.body.data!.connectionId,
          scanId: scan.body.data!.scanId,
          direction: 'push',
        },
      });
      expect(preview.status, JSON.stringify(preview.body.error)).toBe(201);
      const pushed = await call('/sync/push', {
        method: 'POST',
        token,
        body: {
          syncPlanId: preview.body.data!.syncPlanId,
          planHash: preview.body.data!.planHash,
          confirmed: true,
          client: { name: 'settings-suite', version: '0' },
        },
      });
      expect(pushed.status, JSON.stringify(pushed.body.error)).toBe(201);
      const list = await call<{ items: { entryId: string }[] }>(`/projects/${project.id}/translations`, { token });
      return list.body.data!.items[0]!.entryId;
    })();
    expect(entryId).toBeTruthy();

    const refused = await call(`/projects/${project.id}`, { method: 'PATCH', token, body: { sourceLocale: 'ja-JP' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toContain('cannot be changed');

    const detail = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    expect(detail.body.data?.sourceLocale).toBe('en-US');
  });

  it('sets platforms as a whole, keeping at least one', async () => {
    const project = await createProject({ name: `Platforms ${runId}`, sourceLocale: 'en-US', platforms: ['web'] });

    const added = await call(`/projects/${project.id}`, { method: 'PATCH', token, body: { platforms: ['web', 'ios'] } });
    expect(added.status, JSON.stringify(added.body.error)).toBe(200);
    const withBoth = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    expect((withBoth.body.data?.platforms ?? []).map((row) => row.platform).sort()).toEqual(['ios', 'web']);

    // A project with no platform has nowhere to put a key, so the last one stays.
    const emptied = await call(`/projects/${project.id}`, { method: 'PATCH', token, body: { platforms: [] } });
    expect(emptied.status).toBe(422);

    const removed = await call(`/projects/${project.id}`, { method: 'PATCH', token, body: { platforms: ['ios'] } });
    expect(removed.status, JSON.stringify(removed.body.error)).toBe(200);
    const onlyIos = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    expect((onlyIos.body.data?.platforms ?? []).map((row) => row.platform)).toEqual(['ios']);
  });

  it('refuses to drop a platform that still holds keys', async () => {
    const project = await createProject({ name: `Busy platform ${runId}`, sourceLocale: 'en-US', platforms: ['web'] });
    const scan = await call<{ connectionId: string; scanId: string }>('/sync/scans', {
      method: 'POST',
      token,
      body: {
        projectId: project.id,
        scanId: `scan-${runId}-busy`,
        client: { name: 'settings-suite', version: '0' },
        files: [{ fileId: 'web-en-US', filePath: 'locales/en-US/a.json', locale: 'en-US', platform: 'web', format: 'json', fileHash: '0'.repeat(64), entryCount: 1 }],
        entries: [
          { key: 'greeting', namespace: '', locale: 'en-US', value: 'Hello', isSource: true, contentHash: 'b'.repeat(64), fileId: 'web-en-US', filePath: 'locales/en-US/a.json' },
        ],
      },
    });
    const preview = await call<{ syncPlanId: string; planHash: string }>('/sync/preview', {
      method: 'POST',
      token,
      body: { projectId: project.id, repositoryConnectionId: scan.body.data!.connectionId, scanId: scan.body.data!.scanId, direction: 'push' },
    });
    await call('/sync/push', {
      method: 'POST',
      token,
      body: {
        syncPlanId: preview.body.data?.syncPlanId,
        planHash: preview.body.data?.planHash,
        confirmed: true,
        client: { name: 'settings-suite', version: '0' },
      },
    });

    // Add ios first so there is something to remove.
    await call(`/projects/${project.id}`, { method: 'PATCH', token, body: { platforms: ['web', 'ios'] } });
    const refused = await call<{ removed?: string }>(`/projects/${project.id}/platforms/web`, { method: 'DELETE', token });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.details).toMatchObject({ platform: 'web' });

    const detail = await call<ProjectDetail>(`/projects/${project.id}`, { token });
    expect((detail.body.data?.platforms ?? []).map((row) => row.platform).sort()).toEqual(['ios', 'web']);
  });
});