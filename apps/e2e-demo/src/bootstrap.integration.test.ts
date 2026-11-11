import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse as parseYaml } from 'yaml';
import { PrismaClient } from '@localehub/database';
import { localConfigSchema } from '@localehub/contracts';
import { ensureApi, ensureRemoteMcp, type ApiHandle } from './api-harness';

/**
 * Bootstrapping a project from a repository, over MCP.
 *
 * This is the flow an agent performs when somebody points it at a checkout that has never been on
 * the platform: read the language files, create the project, import what was read, and leave a
 * `.localehub/config.yaml` behind so the CLI can take over.
 *
 * The platform cannot see the developer's disk, so the agent does the reading and the MCP only
 * receives content. That is why these are Remote MCP tools and not a server-side importer.
 *
 * What the test pins is the part that is easy to get subtly wrong: the config the tool returns has
 * to be a config the CLI will actually accept, and the import has to produce the same platform
 * state a CLI push would.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const MCP_PORT = 3034;
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let mcp: ApiHandle | null = null;
let session = { email: '', password: '', token: '' };
let client: Client | null = null;

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

/** The MCP result payload, unwrapped from the content block. */
/** The SDK's result union is wide; this narrows to the text block every tool returns. */
function payload<T>(result: unknown): T {
  const blocks = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const block = blocks[0];
  return JSON.parse(block && block.type === 'text' && block.text ? block.text : '{}') as T;
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  session = { email: `bootstrap-${runId}@localehub.dev`, password: 'bootstrap-password-123', token: '' };
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(session.password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({
        data: { email: session.email, name: 'Bootstrap Suite', passwordHash, isPlatformAdmin: false },
      });
      const organization = await tx.organization.create({
        data: { name: `Bootstrap Org ${runId}`, slug: `bootstrap-${runId}` },
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
      name: 'bootstrap-suite',
      scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read'],
      projectIds: [],
      expiresInDays: 1,
    },
  });
  expect(issued.status, JSON.stringify(issued.body.error)).toBe(201);

  mcp = await ensureRemoteMcp(MCP_PORT, { root: ROOT });
  client = new Client({ name: 'bootstrap-suite', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${issued.body.data!.token}` } },
    }),
  );
}, 180_000);

afterAll(async () => {
  await client?.close();
  await mcp?.stop();
  await api?.stop();
});

interface BootstrapProject {
  project: { id: string; name: string; slug: string; sourceLocale: string };
  configPath: string;
  config: string;
  nextSteps: string[];
}

describe('creating a project', () => {
  let created: BootstrapProject;
  let projectId = '';

  it('creates a project and returns a config the CLI will accept', async () => {
    const result = await client!.callTool({
      name: 'create_project',
      arguments: {
        name: `Bootstrap App ${runId}`,
        source_locale: 'en-US',
        locales: ['ja-JP', 'zh-CN'],
      },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    created = payload<BootstrapProject>(result);
    projectId = created.project.id;

    expect(created.configPath).toBe('.localehub/config.yaml');
    // The point of returning the file rather than writing it: the agent writes it with the same
    // tools it read the repository with, and the platform never touches the disk.
    expect(created.config).toContain('version: 1');

    // The returned config has to be one the CLI accepts — a template that fails validation would
    // leave the reader with a broken repository and no obvious cause.
    const parsed = localConfigSchema.safeParse(loadYaml(created.config));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
    if (parsed.success) {
      expect(parsed.data.project.id).toBe(projectId);
      expect(parsed.data.project.sourceLocale).toBe('en-US');
      // The source locale is included whether or not the caller listed it.
      expect(parsed.data.files.map((file) => file.locale).sort()).toEqual(['en-US', 'ja-JP', 'zh-CN']);
      // Write access stays inside the language resources.
      expect(parsed.data.workspace.allowWrite).toEqual(['locales/**']);
      expect(parsed.data.sync.writeMode).toBe('dry_run_by_default');
    }
  });

  it('gives the caller the id and the next steps', async () => {
    expect(created.project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.nextSteps.join('\n')).toContain(created.project.id);
    expect(created.nextSteps.join('\n')).toContain('LOCALEHUB_TOKEN');
  });

  it('refuses a token without a manager role', async () => {
    const member = { email: `bootstrap-dev-${runId}@localehub.dev`, password: 'bootstrap-dev-pass-1' };
    const prisma = new PrismaClient();
    try {
      const { hashPassword } = await import('@localehub/domain');
      const passwordHash = await hashPassword(member.password);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const user = await tx.user.create({ data: { email: member.email, name: 'Dev', passwordHash } });
        const org = await tx.organization.create({ data: { name: `Boot Dev ${runId}`, slug: `boot-dev-${runId}` } });
        // DEVELOPER: below PROJECT_MANAGER, which is what `create_project` requires. The token is
        // minted by the organization owner in this test rather than by this account, because a
        // DEVELOPER cannot issue one — a separate rule with its own test.
        await tx.membership.create({ data: { organizationId: org.id, userId: user.id, role: 'DEVELOPER' } });
      });
    } finally {
      await prisma.$disconnect();
    }
    // Minted by the suite's owner, then attached to the developer's account is not possible
    // through the API — a token always belongs to its issuer — so the developer gets a token in
    // their own organization by having an owner issue one and pointing the MCP at *their* token.
    // Instead, assert the rule directly: the developer cannot create a project.
    const login = await call<{ token: string }>('/auth/login', {
      method: 'POST',
      body: { email: member.email, password: member.password },
    });
    const me = await call<{ organizationId: string }>('/auth/me', { token: login.body.data!.token });

    const prisma2 = new PrismaClient();
    let devToken = '';
    try {
      const { hashPassword } = await import('@localehub/domain');
      await prisma2.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const { generateToken } = await import('@localehub/domain');
        const generated = generateToken('mcp');
        const user = await tx.user.findUniqueOrThrow({ where: { email: member.email } });
        await tx.mcpClient.create({
          data: {
            organizationId: me.body.data!.organizationId,
            userId: user.id,
            kind: 'MCP',
            name: 'dev-token',
            tokenHash: generated.tokenHash,
            tokenPrefix: generated.tokenPrefix,
            scopes: ['project.read'],
            projectIds: [],
          },
        });
        devToken = generated.token;
      });
      void hashPassword;
    } finally {
      await prisma2.$disconnect();
    }
    const issued = { body: { data: { token: devToken } } };

    const devClient = new Client({ name: 'dev', version: '0' });
    await devClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${issued.body.data!.token}` } },
      }),
    );
    try {
      const result = await devClient.callTool({
        name: 'create_project',
        arguments: { name: 'Nope', source_locale: 'en-US' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('ROLE_INSUFFICIENT');
    } finally {
      await devClient.close();
    }
  }, 60_000);

  it('imports what the agent read, in a dry run first', async () => {
    const files = [
      {
        path: 'locales/en-US/common.json',
        locale: 'en-US',
        platform: 'web',
        entries: [
          { key: 'checkout.title', value: 'Checkout' },
          { key: 'checkout.cart', value: 'Cart' },
        ],
      },
      {
        path: 'locales/ja-JP/common.json',
        locale: 'ja-JP',
        platform: 'web',
        entries: [
          { key: 'checkout.title', value: 'お会計' },
          { key: 'checkout.cart', value: 'カート' },
        ],
      },
    ];

    const dry = await client!.callTool({
      name: 'import_translations',
      arguments: { project_id: projectId, files, confirm: false },
    });
    expect(dry.isError, JSON.stringify(dry.content)).toBeFalsy();
    const preview = payload<{
      dryRun: boolean;
      entryCount: number;
      files: { path: string; locale: string; entries: number; isSource: boolean }[];
    }>(dry);
    expect(preview.dryRun).toBe(true);
    expect(preview.entryCount).toBe(4);
    // The source file is recognised from the project's own source locale, not from a flag the
    // caller could get wrong.
    expect(preview.files.find((file) => file.path.includes('en-US'))?.isSource).toBe(true);
    expect(preview.files.find((file) => file.path.includes('ja-JP'))?.isSource).toBe(false);

    // Nothing was written.
    const before = await call<unknown[]>(`/projects/${projectId}/keys`, { token: session.token });
    expect(before.body.data ?? []).toEqual([]);
  }, 60_000);

  it('writes the translations when confirmed', async () => {
    const result = await client!.callTool({
      name: 'import_translations',
      arguments: {
        project_id: projectId,
        confirm: true,
        files: [
          {
            path: 'locales/en-US/common.json',
            locale: 'en-US',
            platform: 'web',
            entries: [
              { key: 'checkout.title', value: 'Checkout' },
              { key: 'checkout.cart', value: 'Cart' },
            ],
          },
          {
            path: 'locales/ja-JP/common.json',
            locale: 'ja-JP',
            platform: 'web',
            entries: [
              { key: 'checkout.title', value: 'お会計' },
              { key: 'checkout.cart', value: 'カート' },
            ],
          },
        ],
      },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const imported = payload<{ dryRun: boolean; result: { revision: number; summary: Record<string, number> } }>(result);
    expect(imported.dryRun).toBe(false);
    expect(imported.result.summary.created + imported.result.summary.updated).toBeGreaterThan(0);

    // The platform now holds what the agent read.
    const keys = await call<{ key: string }[]>(`/projects/${projectId}/keys`, { token: session.token });
    const names = (keys.body.data ?? []).map((key) => key.key);
    expect(names).toContain('checkout.title');
    expect(names).toContain('checkout.cart');

    // The list endpoint paginates: `data` is `{ items, nextCursor }`, not an array.
    const entries = await call<{ items: { value: string; localeCode: string }[] }>(
      `/projects/${projectId}/translations?locale=ja-JP`,
      { token: session.token },
    );
    const values = (entries.body.data?.items ?? []).map((entry) => entry.value);
    expect(values).toContain('お会計');
  }, 60_000);

  it('refuses a project the token is not bound to', async () => {
    const other = await call<{ id: string }>('/projects', {
      method: 'POST',
      token: session.token,
      body: { name: `bootstrap-other-${runId}`, sourceLocale: 'en-US' },
    });
    const issued = await call<{ token: string }>('/mcp-tokens', {
      method: 'POST',
      token: session.token,
      body: {
        name: 'narrow',
        scopes: ['repository.scan', 'sync.push'],
        // Bound to the first project only.
        projectIds: [projectId],
        expiresInDays: 1,
      },
    });
    const narrow = new Client({ name: 'narrow', version: '0' });
    await narrow.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${issued.body.data!.token}` } },
      }),
    );
    try {
      const result = await narrow.callTool({
        name: 'import_translations',
        arguments: {
          project_id: other.body.data!.id,
          confirm: true,
          files: [{ path: 'locales/en-US/a.json', locale: 'en-US', platform: 'web', entries: [{ key: 'a', value: 'A' }] }],
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('PROJECT_ACCESS_DENIED');
    } finally {
      await narrow.close();
    }
  }, 60_000);
});

/**
 * Parse the returned config with the same library the CLI uses.
 *
 * `yaml` is imported at the top rather than required here: a dynamic require is what the lint rule
 * forbids, and there was no reason for one.
 */
function loadYaml(text: string): unknown {
  return parseYaml(text.replace(/^#.*\n/, ''));
}