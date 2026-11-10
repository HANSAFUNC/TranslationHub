import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PrismaClient } from '@localehub/database';
import { ensureApi, ensureRemoteMcp, type ApiHandle } from './api-harness';

/**
 * Skill delivery over MCP, end to end: PostgreSQL → API → Remote MCP → a real MCP client.
 *
 * The unit suites pin the selector and the registration. What only this suite can show is the
 * chain a developer actually uses — that a skill registered through the public API reaches a
 * client over Streamable HTTP with the right URI, name and content, and that the visibility rules
 * (published only, one version per slug, prompts only for instruction skills) hold through RLS.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const MCP_PORT = 3033;
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let mcp: ApiHandle | null = null;
let session = { email: '', password: '', token: '', organizationId: '' };
let mcpToken = '';
let client: Client | null = null;

async function call<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; data: T | undefined; error?: { code: string; message: string } }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as { data?: T; error?: { code: string; message: string } }) : {};
  return { status: response.status, data: payload.data, error: payload.error };
}

async function createOrgOwner(email: string, password: string): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({ data: { email, name: 'Skill Suite', passwordHash, isPlatformAdmin: false } });
      const organization = await tx.organization.create({
        data: { name: `Skill Org ${email}`, slug: `skill-${runId}-${Date.now().toString(36)}` },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

const SKILL_MD = (slug: string) =>
  ['---', `name: ${slug}`, 'version: 1.0.0', 'kind: prompt', '---', '', `# ${slug}`, '', `Instructions for ${slug}.`].join('\n');

/** `contents` is a text|blob union; every resource in this suite is text. */
function textOf(result: { contents: Array<{ text?: string; blob?: string }> }): string {
  const first = result.contents[0];
  return String(first && 'text' in first ? first.text : '');
}

async function registerSkill(body: Record<string, unknown>): Promise<void> {
  const created = await call('/skills', { method: 'POST', token: session.token, body });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  session = { email: `skill-${runId}@localehub.dev`, password: 'skill-password-123', token: '', organizationId: '' };
  await createOrgOwner(session.email, session.password);
  const login = await call<{ token: string; organization: { id: string } }>('/auth/login', {
    method: 'POST',
    body: { email: session.email, password: session.password },
  });
  expect(login.status).toBeLessThan(300);
  session.token = login.data!.token;
  session.organizationId = login.data!.organization.id;

  await registerSkill({
    slug: 'translation-review',
    name: '译文审核',
    version: '1.0.0',
    kind: 'PROMPT',
    content: SKILL_MD('translation-review'),
  });
  await registerSkill({
    slug: 'translation-review',
    name: '译文审核',
    version: '1.10.0',
    kind: 'PROMPT',
    content: SKILL_MD('translation-review-v110'),
  });
  await registerSkill({
    slug: 'legacy-migrator',
    name: '脚本型',
    version: '1.0.0',
    kind: 'SCRIPT',
    content: SKILL_MD('legacy-migrator'),
  });
  await registerSkill({ slug: 'unfinished', name: '未发布', version: '1.0.0', kind: 'PROMPT', content: SKILL_MD('unfinished') });

  // Unpublish one, through the database: the API has no status route, and the point here is that
  // whatever is not PUBLISHED must not reach a client.
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await tx.skill.updateMany({
        where: { slug: 'unfinished', organizationId: session.organizationId },
        data: { status: 'DRAFT' },
      });
    });
  } finally {
    await prisma.$disconnect();
  }

  const token = await call<{ token: string }>('/mcp-tokens', {
    method: 'POST',
    token: session.token,
    body: { name: 'skill-suite', scopes: ['project.read', 'translation.read'], projectIds: [], expiresInDays: 1 },
  });
  expect(token.status).toBe(201);
  mcpToken = token.data!.token;

  mcp = await ensureRemoteMcp(MCP_PORT, { root: ROOT });
  client = new Client({ name: 'skill-delivery-suite', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
    }),
  );
}, 180_000);

afterAll(async () => {
  await client?.close();
  await mcp?.stop();
  await api?.stop();
});

describe('skill discovery', () => {
  it('advertises the index and one resource per delivered skill', async () => {
    const { resources } = await client!.listResources();
    const uris = resources.map((resource) => resource.uri);

    expect(uris).toContain('localehub://skills');
    expect(uris).toContain('localehub://skills/translation-review');
    expect(uris).toContain('localehub://skills/legacy-migrator');
    // A DRAFT never reaches a client: it is somebody's work in progress.
    expect(uris).not.toContain('localehub://skills/unfinished');
  });

  it('reads the index with the resource and prompt each skill is reachable at', async () => {
    const text = textOf(await client!.readResource({ uri: 'localehub://skills' }));

    expect(text).toContain('`localehub://skills/translation-review`');
    expect(text).toContain('`skill-translation-review`');
    expect(text).not.toContain('unfinished');
  });
});

describe('skill content', () => {
  it('serves the SKILL.md verbatim, frontmatter included', async () => {
    const result = await client!.readResource({ uri: 'localehub://skills/translation-review' });
    const text = textOf(result);
    expect(result.contents[0]?.mimeType).toBe('text/markdown');
    expect(text.startsWith('---')).toBe(true);
  });

  it('delivers the highest version of a slug, not the first or the last written', async () => {
    // 1.10.0 must beat 1.0.0 — the case a lexicographic version sort gets wrong.
    expect(textOf(await client!.readResource({ uri: 'localehub://skills/translation-review' }))).toContain(
      '# translation-review-v110',
    );
  });

  it('refuses a slug that is not published in this organization', async () => {
    await expect(client!.readResource({ uri: 'localehub://skills/unfinished' })).rejects.toThrow(/not published/i);
  });

  it("does not deliver another organization's skill", async () => {
    // Registered by a different organization in the same database, so this is RLS-visible to the
    // connection and must be excluded by the query rather than by an unreachable row.
    const other = `other-${runId}@localehub.dev`;
    await createOrgOwner(other, 'other-password-123');
    const otherLogin = await call<{ token: string }>('/auth/login', {
      method: 'POST',
      body: { email: other, password: 'other-password-123' },
    });
    const created = await call('/skills', {
      method: 'POST',
      token: otherLogin.data!.token,
      body: { slug: 'private-skill', name: '私有', version: '1.0.0', kind: 'PROMPT', content: SKILL_MD('private-skill') },
    });
    expect(created.status).toBe(201);

    const { resources } = await client!.listResources();
    expect(resources.map((resource) => resource.uri)).not.toContain('localehub://skills/private-skill');
  });
});

describe('skill prompts', () => {
  it('registers a prompt for instruction skills only', async () => {
    const names = (await client!.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(names).toContain('skill-translation-review');
    // A SCRIPT skill is a program to be reviewed, not a message to inject into a conversation.
    expect(names).not.toContain('skill-legacy-migrator');
  });

  it('keeps the hand-written prompts alongside the generated ones', async () => {
    const names = (await client!.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(names).toContain('review-localization-changes');
    expect(names).toContain('fix-translation-issues');
    expect(new Set(names).size).toBe(names.length);
  });

  it('injects the skill body without its frontmatter', async () => {
    const result = await client!.getPrompt({ name: 'skill-translation-review', arguments: { focus: 'ja-JP' } });
    const content = result.messages[0]?.content;
    const text = String(content?.type === 'text' ? content.text : '');

    expect(text).toContain('译文审核');
    expect(text).toContain('本次范围：ja-JP');
    expect(text).toContain('# translation-review-v110');
    expect(text).not.toContain('version: 1.0.0');
  });
});

describe('the registry page agrees with the servers', () => {
  it('annotates each row with what a client can actually reach', async () => {
    const list = await call<
      Array<{
        slug: string;
        version: string;
        status: string;
        kind: string;
        mcp: { resourceUri: string; promptName: string | null } | null;
      }>
    >('/skills', { token: session.token });
    expect(list.status).toBe(200);
    const rows = list.data!;

    const published = rows.find((row) => row.slug === 'translation-review' && row.version === '1.10.0');
    expect(published?.mcp).toEqual({
      resourceUri: 'localehub://skills/translation-review',
      promptName: 'skill-translation-review',
    });

    // A superseded version is listed for the registry's sake but is not what a client receives.
    expect(rows.find((row) => row.slug === 'translation-review' && row.version === '1.0.0')?.mcp).toBeNull();
    // Neither is a DRAFT, nor is a SCRIPT skill given a prompt name.
    expect(rows.find((row) => row.slug === 'unfinished')?.mcp).toBeNull();
    expect(rows.find((row) => row.slug === 'legacy-migrator')?.mcp).toMatchObject({ promptName: null });
  });

  it('describes exactly what the running server registers, and describes one server only', async () => {
    const discovery = await call<{
      remote: unknown[];
      local?: unknown;
      resources: string[];
      prompts: string[];
      skillDelivery: Record<string, string>;
    }>('/mcp/tools');

    // One MCP. A `local` key here would advertise a server that does not exist any more.
    expect(discovery.data).not.toHaveProperty('local');
    expect(discovery.data!.remote).toHaveLength(15);

    // The advertised lists must match the live server, not a hand-maintained copy of it. This is
    // the assertion that would have caught the six `localehub://projects/...` resources the
    // endpoint used to advertise while no server implemented any of them.
    const liveResources = (await client!.listResources()).resources.map((resource) => resource.uri);
    // A URI with a `{placeholder}` is a template, not an instance — it is advertised, never listed.
    const concrete = discovery.data!.resources.filter((uri) => !uri.includes('{'));
    for (const uri of concrete) expect(liveResources).toContain(uri);

    const livePrompts = (await client!.listPrompts()).prompts.map((prompt) => prompt.name);
    // The endpoint lists the hand-written prompts; the per-skill ones are generated per organization.
    for (const name of discovery.data!.prompts) expect(livePrompts).toContain(name);
    expect(discovery.data!.prompts).not.toContain('skill-translation-review');

    expect(discovery.data!.skillDelivery).toEqual({
      indexUri: 'localehub://skills',
      resourceTemplate: 'localehub://skills/{slug}',
      promptPrefix: 'skill-',
    });
  });
});
