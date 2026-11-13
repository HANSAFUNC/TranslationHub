import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PrismaClient } from '@localehub/database';
import { ensureApi, ensureRemoteMcp, type ApiHandle } from './api-harness';

/**
 * Screen mockups: a sketch of a UI, uploaded by an agent, read by the translation editor.
 *
 * What this suite pins is the contract between the two halves — the upload path (over MCP, and the
 * same thing over REST) and the editor's read path (list, markers joined with translations, image
 * bytes). The parts that are easy to get subtly wrong and invisible to a unit test:
 *
 *   - a marker pointing at a key the platform does not have is *stored and reported*, not rejected;
 *   - the image comes back under the content-type the server decided, with the headers that make
 *     serving an uploaded SVG safe;
 *   - the tool needs its scope, and a project id from the path is checked against the row;
 *   - re-uploading a screen replaces it, markers included, instead of piling up duplicates.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const MCP_PORT = 3035;
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let mcp: ApiHandle | null = null;
let client: Client | null = null;
let session = { email: '', password: '', token: '' };

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; requestId?: string };
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

/** The MCP result payload, unwrapped from the content block. */
function payload<T>(result: unknown): T {
  const blocks = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const block = blocks[0];
  return JSON.parse(block && block.type === 'text' && block.text ? block.text : '{}') as T;
}

function transport(token: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
}

/** A wireframe, small enough to inline: what a caller that *draws* a screen produces. */
const SKETCH = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 667">
  <rect x="0" y="0" width="375" height="667" fill="#ffffff"/>
  <text x="24" y="96" font-size="24">Checkout</text>
  <text x="24" y="300" font-size="16">Your cart is empty</text>
  <rect x="24" y="580" width="327" height="48" rx="8" fill="#111111"/>
  <text x="150" y="610" font-size="16" fill="#ffffff">Pay now</text>
</svg>`;

const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

const KEYS = ['checkout.title', 'checkout.empty', 'checkout.pay', 'checkout.missing'];

interface UploadResult {
  mockupId: string;
  name: string;
  replaced: boolean;
  image: { mimeType: string; byteSize: number; width: number | null; height: number | null; checksum: string };
  markers: { total: number; matchedKeys: number; unmatched: { key: string; namespace: string; reason: string }[] };
  imagePath: string;
}

async function uploadSketch(
  projectId: string,
  options: { name?: string; keys?: string[]; replace?: boolean; platform?: string } = {},
): Promise<UploadResult> {
  const keys = options.keys ?? KEYS;
  const result = await client!.callTool({
    name: 'upload_screen_mockup',
    arguments: {
      project_id: projectId,
      name: options.name ?? 'checkout',
      // `web`, because that is what the import above produced: `import_translations` takes its
      // `platform` per *file*, and a key's identity is (project, platform, namespace, key). A sketch
      // uploaded as `ios` would point at three keys the project does not have — which is exactly the
      // mistake this pairing is meant to catch, so the fixture says it out loud.
      platform: options.platform ?? 'web',
      locale: 'en-US',
      image_base64: base64(SKETCH),
      markers: keys.map((key, index) => ({
        key,
        x: 0.06,
        y: 0.1 + index * 0.08,
        width: 0.4,
        height: 0.04,
        text: key,
      })),
      replace: options.replace ?? true,
    },
  });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return payload<UploadResult>(result);
}

/** The REST upload, returning the raw status so a test can expect a refusal. */
async function uploadSketchRaw(
  projectId: string,
  options: { name: string; replace: boolean },
): Promise<{ status: number; body: Envelope<unknown> }> {
  return call(`/projects/${projectId}/mockups`, {
    method: 'POST',
    token: session.token,
    body: {
      name: options.name,
      platform: 'web',
      locale: 'en-US',
      imageBase64: base64(SKETCH),
      markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
      replace: options.replace,
    },
  });
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  session = { email: `mockups-${runId}@localehub.dev`, password: 'mockups-password-123', token: '' };
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(session.password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({
        data: { email: session.email, name: 'Mockup Suite', passwordHash, isPlatformAdmin: false },
      });
      const organization = await tx.organization.create({
        data: { name: `Mockup Org ${runId}`, slug: `mockups-${runId}` },
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

  const issued = await call<{ token: string }>('/mcp-tokens', {
    method: 'POST',
    token: session.token,
    body: {
      name: 'mockup-suite',
      scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read'],
      projectIds: [],
      expiresInDays: 1,
    },
  });
  expect(issued.status, JSON.stringify(issued.body.error)).toBe(201);

  mcp = await ensureRemoteMcp(MCP_PORT, { root: ROOT });
  client = new Client({ name: 'mockup-suite', version: '0.0.0' });
  await client.connect(transport(issued.body.data!.token));
}, 180_000);

afterAll(async () => {
  await client?.close();
  await mcp?.stop();
  await api?.stop();
});

describe('screen mockups', () => {
  let projectId: string;

  beforeAll(async () => {
    const created = await client!.callTool({
      name: 'create_project',
      arguments: { name: `Sketch ${runId}`, source_locale: 'en-US', locales: ['ja-JP'], platforms: ['web', 'ios'] },
    });
    projectId = payload<{ project: { id: string } }>(created).project.id;

    const imported = await client!.callTool({
      name: 'import_translations',
      arguments: {
        project_id: projectId,
        confirm: true,
        files: [
          {
            path: 'ios/en-US/Localizable.strings',
            locale: 'en-US',
            platform: 'ios',
            entries: [
              { key: 'checkout.title', value: 'Checkout' },
              { key: 'checkout.empty', value: 'Your cart is empty' },
              { key: 'checkout.pay', value: 'Pay now' },
            ],
          },
          {
            path: 'ios/ja-JP/Localizable.strings',
            locale: 'ja-JP',
            platform: 'ios',
            entries: [
              { key: 'checkout.title', value: 'お会計' },
              { key: 'checkout.pay', value: '支払う' },
            ],
          },
        ],
      },
    });
    expect(imported.isError, JSON.stringify(imported.content)).toBeFalsy();
  }, 120_000);

  it('stores a sketch, reads its size from the file, and matches markers to keys', async () => {
    const result = await uploadSketch(projectId);

    expect(result.replaced).toBe(false);
    expect(result.image.mimeType).toBe('image/svg+xml');
    // The viewBox in the file, not anything the caller said.
    expect(result.image.width).toBe(375);
    expect(result.image.height).toBe(667);
    expect(result.markers.total).toBe(4);
    expect(result.markers.matchedKeys).toBe(3);
    // A marker for a key the platform has not imported is a fact about the UI, not an error.
    expect(result.markers.unmatched).toEqual([{ key: 'checkout.missing', namespace: '', reason: 'KEY_NOT_IMPORTED' }]);
    // Relative to the API base, because the browser client adds its own base to whatever it is given:
    // an absolute path here resolved to `/api/v1/api/v1/...` and the editor showed a broken sketch.
    expect(result.imagePath).toBe(`/projects/${projectId}/mockups/${result.mockupId}/image`);
    expect(result.imagePath.startsWith('/api/v1')).toBe(false);
  }, 60_000);

  it('serves the image under the type it decided, with the headers that make an SVG safe to serve', async () => {
    const list = await call<{ id: string; width: number | null; markerCount: number }[]>(`/projects/${projectId}/mockups`, {
      token: session.token,
    });
    const mockup = list.body.data!.find((row) => row.width === 375)!;
    expect(mockup.markerCount).toBe(4);

    const response = await fetch(`${API_BASE}/projects/${projectId}/mockups/${mockup.id}/image`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // The sketch is an uploaded document: without this, a browser opened directly on the URL would
    // run whatever it contains, on the API's own origin.
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(await response.text()).toContain('Pay now');

    const etag = response.headers.get('etag')!;
    const revalidated = await fetch(`${API_BASE}/projects/${projectId}/mockups/${mockup.id}/image`, {
      headers: { authorization: `Bearer ${session.token}`, 'if-none-match': etag },
    });
    expect(revalidated.status).toBe(304);
  }, 60_000);

  it('joins every marker with the source text and the translation of the locale being reviewed', async () => {
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;

    const detail = await call<{
      mockup: { name: string; width: number | null; markerCount: number };
      markers: {
        key: string;
        y: number;
        text: string | null;
        source: string | null;
        entry: { value: string; status: string; entryId: string } | null;
      }[];
    }>(`/projects/${projectId}/mockups/${mockupId}?locale=ja-JP`, { token: session.token });

    expect(detail.status).toBe(200);
    const markers = detail.body.data!.markers;
    // Reading order, top to bottom: the dialog's numbered badges follow the screen, not the upload.
    expect(markers.map((marker) => marker.y)).toEqual([...markers.map((marker) => marker.y)].sort((a, b) => a - b));

    const title = markers.find((marker) => marker.key === 'checkout.title')!;
    expect(title.source).toBe('Checkout');
    expect(title.entry?.value).toBe('お会計');

    // Imported source, no Japanese yet: source present, entry absent. Different from "no such key".
    const empty = markers.find((marker) => marker.key === 'checkout.empty')!;
    expect(empty.source).toBe('Your cart is empty');
    expect(empty.entry).toBeNull();

    const missing = markers.find((marker) => marker.key === 'checkout.missing')!;
    expect(missing.source).toBeNull();
    expect(missing.entry).toBeNull();
  }, 60_000);

  it('tells the editor which screen shows the entry it has selected', async () => {
    const withKey = await call<{ name: string; containsKey: boolean }[]>(`/projects/${projectId}/mockups?key=checkout.pay`, {
      token: session.token,
    });
    expect(withKey.body.data!).toHaveLength(1);
    expect(withKey.body.data![0]!.containsKey).toBe(true);

    const withoutKey = await call<{ containsKey: boolean }[]>(`/projects/${projectId}/mockups?key=checkout.absent`, {
      token: session.token,
    });
    // The screen is still listed: "no sketch marks this key" is the answer, not "no sketches exist".
    expect(withoutKey.body.data!).toHaveLength(1);
    expect(withoutKey.body.data![0]!.containsKey).toBe(false);
  }, 60_000);

  it('replaces a screen on re-upload rather than piling up markers', async () => {
    const second = await uploadSketch(projectId, { keys: ['checkout.title', 'checkout.empty'] });
    expect(second.replaced).toBe(true);

    const list = await call<{ id: string; markerCount: number }[]>(`/projects/${projectId}/mockups`, {
      token: session.token,
    });
    expect(list.body.data!).toHaveLength(1);
    expect(list.body.data![0]!.markerCount).toBe(2);
    expect(list.body.data![0]!.id).toBe(second.mockupId);

    // Put the fuller sketch back for the tests that follow.
    await uploadSketch(projectId);
  }, 60_000);

  it('refuses to overwrite when the caller says not to', async () => {
    // Same name *and* platform as the screen above: a screen's identity is the pair, so a `checkout`
    // sketch for another platform is a different screen and is not a collision.
    const result = await client!.callTool({
      name: 'upload_screen_mockup',
      arguments: {
        project_id: projectId,
        name: 'checkout',
        platform: 'web',
        locale: 'en-US',
        image_base64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        replace: false,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('CONFLICT');
  }, 60_000);

  it('refuses an SVG that could act as a script, naming the construct to remove', async () => {
    const result = await client!.callTool({
      name: 'upload_screen_mockup',
      arguments: {
        project_id: projectId,
        name: 'hostile',
        platform: 'ios',
        locale: 'en-US',
        image_base64: base64('<svg onload="alert(1)"><rect width="10" height="10"/></svg>'),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        replace: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('事件属性');
  }, 60_000);

  it('refuses pixel coordinates, the mistake a caller measuring the image makes', async () => {
    const result = await client!.callTool({
      name: 'upload_screen_mockup',
      arguments: {
        project_id: projectId,
        name: 'pixels',
        platform: 'ios',
        locale: 'en-US',
        image_base64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 24, y: 96 }],
        replace: true,
      },
    });
    expect(result.isError).toBe(true);
  }, 60_000);

  it('accepts the same upload over REST, so the flow does not require an MCP client', async () => {
    const response = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'settings',
        platform: 'web',
        locale: 'en-US',
        imageBase64: base64(SKETCH),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
        replace: true,
      },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    expect(response.body.data!.markers.matchedKeys).toBe(1);

    const list = await call<{ name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    expect(list.body.data!.map((row) => row.name)).toContain('settings');
    expect(list.body.data!.filter((row) => row.name === 'checkout')).toHaveLength(1);
  }, 60_000);

  it('accepts a realistic payload over REST, which the default 100 kB body limit would not', async () => {
    // A wireframe that carries its own detail is a few hundred kilobytes, and a base64 image is ~4/3
    // its bytes — over Express's default `json` limit of 100 kB. The padded comment keeps the SVG a
    // real, renderable image while pushing the request past that boundary.
    const padded = SKETCH.replace('</svg>', `<!--${'x'.repeat(180 * 1024)}--></svg>`);
    const response = await call<UploadResult>(`/projects/${projectId}/mockups`, {
      method: 'POST',
      token: session.token,
      body: {
        name: 'large',
        platform: 'web',
        locale: 'en-US',
        imageBase64: base64(padded),
        markers: [{ key: 'checkout.title', x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
        replace: true,
      },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    expect(response.body.data!.image.byteSize).toBeGreaterThan(180 * 1024);
  }, 60_000);

  it('records the upload in the audit trail, with the format the server actually read', async () => {
    const audit = await call<{ action: string; metadata: Record<string, unknown> }[]>(
      '/organization/audit?action=mockup.',
      { token: session.token },
    );
    const uploads = audit.body.data!.filter((row) => row.action === 'mockup.upload');
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.some((row) => row.metadata.detectedMimeType === 'image/svg+xml')).toBe(true);
    expect(uploads.some((row) => row.metadata.via === 'upload_screen_mockup')).toBe(true);
    expect(uploads.some((row) => row.metadata.via === 'api')).toBe(true);
  }, 60_000);

  it('needs sync.push, so a read-only token cannot plant a sketch on the platform', async () => {
    const readOnly = await call<{ token: string }>('/mcp-tokens', {
      method: 'POST',
      token: session.token,
      body: { name: 'mockup-readonly', scopes: ['project.read', 'translation.read'], projectIds: [projectId], expiresInDays: 1 },
    });

    const scoped = new Client({ name: 'mockup-readonly', version: '0.0.0' });
    await scoped.connect(transport(readOnly.body.data!.token));
    try {
      const result = await scoped.callTool({
        name: 'upload_screen_mockup',
        arguments: {
          project_id: projectId,
          name: 'escalation',
          platform: 'ios',
          locale: 'en-US',
          image_base64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
          replace: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('SCOPE_INSUFFICIENT');
    } finally {
      await scoped.close();
    }

    const list = await call<{ name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    expect(list.body.data!.some((row) => row.name === 'escalation')).toBe(false);
  }, 120_000);

  it('checks the project id in the path against the row rather than trusting it', async () => {
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;

    const correct = await fetch(`${API_BASE}/projects/${projectId}/mockups/${mockupId}/image`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(correct.status).toBe(200);

    // The same screen id under a project that does not own it: 404, not the bytes.
    const wrongProject = await fetch(
      `${API_BASE}/projects/00000000-0000-0000-0000-000000000000/mockups/${mockupId}/image`,
      { headers: { authorization: `Bearer ${session.token}` } },
    );
    expect(wrongProject.status).toBe(404);
  }, 60_000);

  describe('the project has to belong to the caller', () => {
    /**
     * Another organization, and a project in it.
     *
     * The upload used to check the role on the *path's* project id and then write with whatever id it
     * was given. RLS made the foreign row invisible to its owner but does not scope the unique index
     * `(project_id, platform, name)`, so an upload against this project would occupy one of its
     * screen names permanently — the owner would see `CONFLICT` on a name no screen of theirs uses.
     */
    let foreign: { projectId: string };

    beforeAll(async () => {
      const prisma = new PrismaClient();
      try {
        const { hashPassword } = await import('@localehub/domain');
        const other = { email: `mockups-other-${runId}@localehub.dev`, password: 'mockups-other-password' };
        const passwordHash = await hashPassword(other.password);
        foreign = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
          const user = await tx.user.create({
            data: { email: other.email, name: 'Other Org', passwordHash, isPlatformAdmin: false },
          });
          const organization = await tx.organization.create({
            data: { name: `Other Org ${runId}`, slug: `mockups-other-${runId}` },
          });
          await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
          const project = await tx.project.create({
            data: {
              organizationId: organization.id,
              name: `Foreign ${runId}`,
              slug: `foreign-${runId}`,
              sourceLocale: 'en-US',
            },
            select: { id: true },
          });
          return { projectId: project.id };
        });
      } finally {
        await prisma.$disconnect();
      }
    }, 60_000);

    it('refuses an upload against a project in another organization, and writes nothing', async () => {
      const attempt = await call('/projects/' + foreign.projectId + '/mockups', {
        method: 'POST',
        token: session.token,
        body: {
          name: 'squat',
          locale: 'en-US',
          imageBase64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        },
      });
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(404);
      expect(attempt.body.error!.code).toBe('NOT_FOUND');

      // Nothing was written under that name — the point of the check is the unique index, not the row.
      const prisma = new PrismaClient();
      try {
        await prisma.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*)::bigint AS count FROM screen_mockups WHERE project_id = $1::uuid`,
          foreign.projectId,
        );
        expect(Number(rows[0]!.count)).toBe(0);
      } finally {
        await prisma.$disconnect();
      }
    }, 60_000);

    it('answers 404 rather than 500 for a project id that does not exist at all', async () => {
      // Reached the foreign key before, so the caller got a 500 carrying raw Prisma text.
      const attempt = await call('/projects/00000000-0000-0000-0000-000000000000/mockups', {
        method: 'POST',
        token: session.token,
        body: {
          name: 'nowhere',
          locale: 'en-US',
          imageBase64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
        },
      });
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(404);
    }, 60_000);

    it('refuses the same upload through MCP, which shares the check', async () => {
      const result = await client!.callTool({
        name: 'upload_screen_mockup',
        arguments: {
          project_id: foreign.projectId,
          name: 'squat',
          platform: 'web',
          locale: 'en-US',
          image_base64: base64(SKETCH),
          markers: [{ key: 'checkout.title', x: 0.1, y: 0.1 }],
          replace: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('NOT_FOUND');
    }, 60_000);
  });

  it('resolves the locale the same way the write path stores it', async () => {
    // Entries are stored under the canonical tag. Reading with `?locale=EN-US` used to match nothing
    // and report every marker as having no translation — a wrong answer with a 200, which is the
    // hardest kind to notice.
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;
    const canonical = await call<{ markers: { entry: unknown }[] }>(
      `/projects/${projectId}/mockups/${mockupId}?locale=en-US`,
      { token: session.token },
    );
    const upper = await call<{ markers: { entry: unknown }[] }>(
      `/projects/${projectId}/mockups/${mockupId}?locale=EN-US`,
      { token: session.token },
    );
    const filled = (rows: { entry: unknown }[]) => rows.filter((row) => row.entry !== null).length;
    expect(filled(canonical.body.data!.markers)).toBeGreaterThan(0);
    expect(filled(upper.body.data!.markers)).toBe(filled(canonical.body.data!.markers));
  }, 60_000);

  it('does not count an archived key as a match', async () => {
    // An archived key was dropped from the repository: the editor does not list it, so a marker that
    // resolves to it must not be reported as a match either.
    const prisma = new PrismaClient();
    // `set_config(…, true)` is transaction-local: run outside a transaction it is gone by the next
    // statement, the update matches nothing under RLS, and the assertion below then passes for the
    // wrong reason. Both halves run inside one transaction, like the suite's own bootstrap does.
    const setArchived = (archivedAt: Date | null) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const updated = await tx.translationKey.updateMany({
          where: { projectId, key: 'checkout.empty' },
          data: { archivedAt },
        });
        expect(updated.count).toBe(1);
      });
    try {
      await setArchived(new Date());

      const result = await uploadSketch(projectId);
      // It is reported as unmatched — "the platform does not have this" — rather than matched.
      expect(result.markers.unmatched.map((row) => row.key)).toContain('checkout.empty');

      await setArchived(null);
      const restored = await uploadSketch(projectId);
      expect(restored.markers.unmatched.map((row) => row.key)).not.toContain('checkout.empty');
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);

  it('returns the ETag and cache directive on a 304, so a revalidation has something to store', async () => {
    const list = await call<{ id: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const mockupId = list.body.data![0]!.id;
    const url = `${API_BASE}/projects/${projectId}/mockups/${mockupId}/image`;
    const first = await fetch(url, { headers: { authorization: `Bearer ${session.token}` } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const revalidated = await fetch(url, {
      headers: { authorization: `Bearer ${session.token}`, 'if-none-match': etag! },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(revalidated.headers.get('cache-control')).toContain('no-cache');
  }, 60_000);

  it('tells "no such key" apart from "no source text", which the editor shows differently', async () => {
    // A key imported only under a non-source locale has a key row and an entry but no SourceVersion.
    // The editor used to read `source === null` as "the platform does not have this key" and told the
    // reviewer to import a key the editor already lists — so the two states have to stay distinct in
    // the payload.
    await client!.callTool({
      name: 'import_translations',
      arguments: {
        project_id: projectId,
        confirm: true,
        files: [
          {
            path: 'ios/ja-JP/Localizable.strings',
            locale: 'ja-JP',
            platform: 'ios',
            entries: [{ key: 'checkout.only_japanese', value: 'お会計' }],
          },
        ],
      },
    });

    await uploadSketch(projectId, { name: 'partial', keys: ['checkout.only_japanese', 'checkout.absent'] });
    const list = await call<{ id: string; name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const partial = list.body.data!.find((row) => row.name === 'partial')!;
    const detail = await call<{ markers: { key: string; platform: string | null; source: string | null; entry: unknown }[] }>(
      `/projects/${projectId}/mockups/${partial.id}?locale=ja-JP`,
      { token: session.token },
    );

    const imported = detail.body.data!.markers.find((row) => row.key === 'checkout.only_japanese')!;
    expect(imported.platform).not.toBeNull();
    expect(imported.source).toBeNull();
    expect(imported.entry).not.toBeNull();

    const absent = detail.body.data!.markers.find((row) => row.key === 'checkout.absent')!;
    expect(absent.platform).toBeNull();
    expect(absent.entry).toBeNull();

    await call(`/projects/${projectId}/mockups/${partial.id}`, { method: 'DELETE', token: session.token });
  }, 120_000);

  it('lets the unique index decide a concurrent replace: false, rather than a read that both pass', async () => {
    // The guard is a read, and two requests in flight both see no row. `replace: false` therefore has
    // to be a create — only the index can settle it — or the second silently overwrites the first
    // while reporting `replaced: false`.
    const results = await Promise.all([
      uploadSketchRaw(projectId, { name: 'racer', replace: false }),
      uploadSketchRaw(projectId, { name: 'racer', replace: false }),
    ]);
    const ok = results.filter((row) => row.status === 201);
    const refused = results.filter((row) => row.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.body.error?.code).toBe('CONFLICT');

    const list = await call<{ id: string; name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const racer = list.body.data!.find((row) => row.name === 'racer');
    if (racer) await call(`/projects/${projectId}/mockups/${racer.id}`, { method: 'DELETE', token: session.token });
  }, 120_000);

  it('answers a body over the route limit with 413 in the standard envelope', async () => {
    // The larger limit is mounted on this route alone. A refusal used to arrive as 500 (Express's
    // parser error passing through the generic branch) or, before that, as Nest's default HTML.
    const huge = 'A'.repeat(5 * 1024 * 1024);
    const response = await fetch(`${API_BASE}/projects/${projectId}/mockups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ name: 'huge', locale: 'en-US', imageBase64: huge, markers: [] }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.success).toBe(false);
    expect(body.error!.code).toBe('VALIDATION_ERROR');
    // This answer comes from a hand-mounted parser, which runs before the middleware that mints the
    // request id — so it used to be the one error a client could not correlate with the logs.
    expect(body.error!.requestId).toBeTruthy();
    expect(response.headers.get('x-request-id')).toBe(body.error!.requestId);
  }, 60_000);

  it('keeps the same-name-plus-namespace identity apart when asking which screen shows a key', async () => {
    // A namespace is part of a key's identity, so a marker in one namespace must not answer for an
    // entry in another with the same name — the dialog would otherwise open the wrong screen and
    // highlight a marker belonging to a different entry.
    await uploadSketch(projectId, {
      name: 'namespaced',
      keys: ['title'],
    });
    const inDefault = await call<{ name: string; containsKey: boolean }[]>(
      `/projects/${projectId}/mockups?key=title&namespace=`,
      { token: session.token },
    );
    expect(inDefault.body.data!.find((row) => row.name === 'namespaced')?.containsKey).toBe(true);

    const inOther = await call<{ name: string; containsKey: boolean }[]>(
      `/projects/${projectId}/mockups?key=title&namespace=InfoPlist`,
      { token: session.token },
    );
    expect(inOther.body.data!.find((row) => row.name === 'namespaced')?.containsKey).toBe(false);

    const cleanup = await call<{ id: string; name: string }[]>(`/projects/${projectId}/mockups`, { token: session.token });
    const extra = cleanup.body.data!.find((row) => row.name === 'namespaced');
    if (extra) await call(`/projects/${projectId}/mockups/${extra.id}`, { method: 'DELETE', token: session.token });
  }, 60_000);
});
