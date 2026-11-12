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
      scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read', 'translation.apply'],
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

  /**
   * The writes above went through the MCP, and the organization audit page reads `audit_logs`.
   * Before this test existed, every tool wrote its domain rows and nothing else: the project and
   * its four entries were there, the audit trail was empty, and the page that answers "who did
   * this" showed nothing for the surface an agent uses.
   */
  it('leaves an audit trail for what it wrote', async () => {
    const audited = await call<
      {
        action: string;
        actorType: string;
        actorId: string | null;
        mcpClientId: string | null;
        projectId: string | null;
        metadata: Record<string, unknown>;
      }[]
    >(`/projects/${projectId}/audit`, { token: session.token });
    expect(audited.status, JSON.stringify(audited.body.error)).toBe(200);

    const rows = audited.body.data ?? [];
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('project.create');
    expect(actions).toContain('sync.push');

    // The actor is the token's user, and the tool is identified — otherwise the row says "someone
    // did it" and an operator cannot tell which token to revoke.
    const push = rows.find((row) => row.action === 'sync.push');
    expect(push).toMatchObject({ actorType: 'mcp', projectId });
    expect(push?.actorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(push?.mcpClientId).toMatch(/^[0-9a-f-]{36}$/);
    // The metadata says which surface performed it, because the REST push records the same action.
    expect(push?.metadata.via).toBe('import_translations');
    expect(push?.metadata.entryCount).toBe(4);

    // The dry run is a read: it must not look like a change.
    const pushes = rows.filter((row) => row.action === 'sync.push');
    expect(pushes).toHaveLength(1);
  });

  it('names the token that acted, so the right credential can be revoked', async () => {
    // The organization trail is the one that resolves the token. `actor` alone would name the
    // person who issued it, which for a CI token is not who did the work.
    const trail = await call<
      {
        action: string;
        actorType: string;
        actor: { email: string } | null;
        mcpClient: { name: string; tokenPrefix: string; revokedAt: string | null } | null;
      }[]
    >('/organization/audit?actorType=mcp', { token: session.token });
    expect(trail.status, JSON.stringify(trail.body.error)).toBe(200);

    const push = trail.body.data!.find((entry) => entry.action === 'sync.push');
    expect(push).toBeTruthy();
    expect(push!.actorType).toBe('mcp');
    // The person who issued the token is still named — the row says both who and with what.
    expect(push!.actor?.email).toBe(session.email);
    expect(push!.mcpClient?.name).toBe('bootstrap-suite');
    expect(push!.mcpClient?.tokenPrefix).toMatch(/^lh_mcp_/);
    expect(push!.mcpClient?.revokedAt).toBeNull();

    // The filter is a filter, not a relabelling: a user-actor row must not appear under it.
    expect(trail.body.data!.every((entry) => entry.actorType === 'mcp')).toBe(true);
  });

  /**
   * The other direction.
   *
   * Everything above is the repository telling the platform what it has. This is the platform
   * telling it — or rather, the agent saying it has written what the platform asked for. Without
   * it the loop never closes: the same changes are offered by every pull, and `validate_release`
   * keeps counting them as outstanding, because nothing ever says "this text is in the repository".
   */
  describe('reporting a write back into the repository', () => {
    // The entry every step below works on, named rather than positional: the list orders by a
    // UUID, so "the first item" is a different key on every run.
    const KEY = 'checkout.title';
    const filePath = 'locales/ja-JP/common.json';
    let entryId = '';
    let versionId = '';

    interface PendingChanges {
      changes: {
        entryId: string;
        key: string;
        locale: string;
        platform: string;
        translationVersionId: string;
        content: string;
        appliedToRepo: boolean;
      }[];
    }

    interface MarkResult {
      dryRun: boolean;
      sessionId: string | null;
      applied: { key: string; locale: string; platform: string; filePath: string | null }[];
      skipped: { key: string; locale: string; reason: string }[];
      baselineUpdated: number;
    }

    const pending = async () => {
      const result = await client!.callTool({
        name: 'get_pending_platform_changes',
        arguments: { project_id: projectId, locale: 'ja-JP' },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      return payload<PendingChanges>(result);
    };

    const mark = async (arguments_: Record<string, unknown>) =>
      client!.callTool({ name: 'mark_applied', arguments: arguments_ });

    it('starts with an approved change the platform has not seen in the repository', async () => {
      const entries = await call<{ items: { entryId: string; key: string }[] }>(
        `/projects/${projectId}/translations?locale=ja-JP`,
        { token: session.token },
      );
      const listed = entries.body.data!.items.find((entry) => entry.key === KEY);
      expect(listed, `no ${KEY} entry in ja-JP`).toBeTruthy();
      entryId = listed!.entryId;

      const draft = await call(`/projects/${projectId}/translations/${entryId}/draft`, {
        method: 'POST',
        token: session.token,
        body: { value: 'お会計（レビュー済み）' },
      });
      expect(draft.status, JSON.stringify(draft.body.error)).toBe(201);
      const review = await call(`/projects/${projectId}/translations/review`, {
        method: 'POST',
        token: session.token,
        body: { entryIds: [entryId], decision: 'APPROVE' },
      });
      expect(review.status, JSON.stringify(review.body.error)).toBe(201);

      const changes = await pending();
      const change = changes.changes.find((row) => row.entryId === entryId);
      expect(change).toBeTruthy();
      expect(change!.appliedToRepo).toBe(false);
      versionId = change!.translationVersionId;
      expect(versionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('answers a dry run without writing anything', async () => {
      const result = await mark({
        project_id: projectId,
        dry_run: true,
        items: [{ key: KEY, locale: 'ja-JP', platform: 'web', translation_version_id: versionId, file_path: filePath }],
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const reported = payload<MarkResult>(result);
      expect(reported.dryRun).toBe(true);
      // A no-op must not invent a sync session, or the history fills with applies that never were.
      expect(reported.sessionId).toBeNull();
      expect(reported.applied).toHaveLength(1);

      const changes = await pending();
      expect(changes.changes.find((row) => row.entryId === entryId)?.appliedToRepo).toBe(false);
    });

    it('marks the change once it is confirmed, and stops offering it', async () => {
      const result = await mark({
        project_id: projectId,
        dry_run: false,
        git_commit: 'abc1234',
        items: [{ key: KEY, locale: 'ja-JP', platform: 'web', translation_version_id: versionId, file_path: filePath }],
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const reported = payload<MarkResult>(result);
      expect(reported.applied).toHaveLength(1);
      expect(reported.skipped).toEqual([]);
      expect(reported.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      // The loop is closed: the platform no longer offers it.
      const changes = await pending();
      expect(changes.changes.find((row) => row.entryId === entryId)?.appliedToRepo).toBe(true);

      // And the REST view agrees, because both read the same column.
      const detail = await call<{ appliedToRepoAt: string | null }>(
        `/projects/${projectId}/translations/${entryId}`,
        { token: session.token },
      );
      expect(detail.body.data?.appliedToRepoAt).toBeTruthy();
    });

    it('leaves a trail, because the platform is taking the agent at its word', async () => {
      const audited = await call<{ action: string; metadata: Record<string, unknown>; syncSessionId: string | null }[]>(
        `/projects/${projectId}/audit`,
        { token: session.token },
      );
      const row = audited.body.data?.find((entry) => entry.action === 'sync.apply');
      expect(row).toBeTruthy();
      expect(row!.metadata.via).toBe('mark_applied');
      expect(row!.metadata.applied).toBe(1);
      expect(row!.metadata.gitCommit).toBe('abc1234');
      expect(row!.syncSessionId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('is idempotent: a retry is not an error and does not record a second apply', async () => {
      const result = await mark({
        project_id: projectId,
        dry_run: false,
        items: [{ key: KEY, locale: 'ja-JP', platform: 'web', translation_version_id: versionId, file_path: filePath }],
      });
      const reported = payload<MarkResult>(result);
      expect(reported.applied).toEqual([]);
      expect(reported.skipped).toEqual([{ key: KEY, locale: 'ja-JP', platform: 'web', reason: 'ALREADY_APPLIED' }]);
      expect(reported.sessionId).toBeNull();

      const audited = await call<{ action: string }[]>(`/projects/${projectId}/audit`, { token: session.token });
      expect(audited.body.data!.filter((entry) => entry.action === 'sync.apply')).toHaveLength(1);
    });

    it('refuses to mark a version the platform has moved past', async () => {
      // Someone edits the same entry again while the agent is still working. Marking the old text
      // as applied would tell the platform its new text is in the repository when it is not, and
      // nothing else in the system could ever detect that.
      const draft = await call(`/projects/${projectId}/translations/${entryId}/draft`, {
        method: 'POST',
        token: session.token,
        body: { value: 'お会計（さらに新しい）' },
      });
      expect(draft.status, JSON.stringify(draft.body.error)).toBe(201);
      await call(`/projects/${projectId}/translations/review`, {
        method: 'POST',
        token: session.token,
        body: { entryIds: [entryId], decision: 'APPROVE' },
      });

      const result = await mark({
        project_id: projectId,
        dry_run: false,
        items: [{ key: KEY, locale: 'ja-JP', platform: 'web', translation_version_id: versionId, file_path: filePath }],
      });
      const reported = payload<MarkResult>(result);
      expect(reported.applied).toEqual([]);
      expect(reported.skipped).toEqual([
        { key: KEY, locale: 'ja-JP', platform: 'web', reason: 'VERSION_SUPERSEDED' },
      ]);

      // The stale claim changed nothing: the change is still outstanding, with its new version.
      const changes = await pending();
      const change = changes.changes.find((row) => row.entryId === entryId);
      expect(change?.appliedToRepo).toBe(false);
      expect(change?.translationVersionId).not.toBe(versionId);
      // The reason is in the payload the agent reads, not only in this test's assertions.
      expect(reported.skipped[0]?.reason).toBe('VERSION_SUPERSEDED');
      expect(JSON.stringify(result.content)).toContain('Re-run get_pending_platform_changes');
    });

    it('requires the translation.apply scope, which is not in the default set', async () => {
      // Spec §2.2: pushing local changes up and writing platform changes down are separately
      // granted. The token below can push; it must not be able to mark.
      const issued = await call<{ token: string }>('/mcp-tokens', {
        method: 'POST',
        token: session.token,
        body: {
          name: `no-apply-${runId}`,
          scopes: ['project.read', 'repository.scan', 'sync.preview', 'sync.push', 'translation.read'],
          projectIds: [projectId],
          expiresInDays: 1,
        },
      });
      const pusher = new Client({ name: 'no-apply', version: '0' });
      await pusher.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${issued.body.data!.token}` } },
        }),
      );
      try {
        const refused = await pusher.callTool({
          name: 'mark_applied',
          arguments: {
            project_id: projectId,
            dry_run: false,
            items: [{ key: KEY, locale: 'ja-JP', platform: 'web' }],
          },
        });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toContain('SCOPE_INSUFFICIENT');
        expect(JSON.stringify(refused.content)).toContain('translation.apply');

        // The same token can still do what it was issued for.
        const allowed = await pusher.callTool({
          name: 'get_pending_platform_changes',
          arguments: { project_id: projectId, locale: 'ja-JP' },
        });
        expect(allowed.isError, JSON.stringify(allowed.content)).toBeFalsy();
      } finally {
        await pusher.close();
      }
    });
  });

  /**
   * The repository is the authority on which languages it holds.
   *
   * The ordinary iOS layout is `zh-Hans.lproj` in the checkout and `zh-CN` on the platform. Before
   * this, the import created a *second* Chinese locale — and because the code no longer equalled
   * `sourceLocale`, it was not treated as source either, so the project ended up with translated
   * text and no reference to translate from. Silently, in both directions.
   */
  describe('expanding the project from what the repository has', () => {
    interface Expansion {
      localesAdded: string[];
      localesMatched: { from: string; to: string }[];
      platformsAdded: string[];
    }
    interface ImportResult {
      dryRun: boolean;
      files: { path: string; locale: string; isSource: boolean }[];
      expansion: Expansion;
    }

    const localesOf = async (id: string) => {
      const result = await client!.callTool({ name: 'list_project_locales', arguments: { project_id: id } });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      return payload<{ code: string; name: string; isSource: boolean }[]>(result);
    };

    const importFiles = async (id: string, files: unknown[], confirm: boolean) =>
      client!.callTool({ name: 'import_translations', arguments: { project_id: id, confirm, files } });

    let zhProject = '';

    it('creates the project the iOS way round: zh-CN source, web platform', async () => {
      const result = await client!.callTool({
        name: 'create_project',
        arguments: { name: `iOS layout ${runId}`, source_locale: 'zh-CN', locales: ['en-US'], platforms: ['web'] },
      });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      zhProject = payload<{ project: { id: string } }>(result).project.id;
      expect((await localesOf(zhProject)).map((row) => row.code).sort()).toEqual(['en-US', 'zh-CN']);
    });

    it('recognises zh-Hans as the project\'s zh-CN instead of inventing a second Chinese', async () => {
      const result = await importFiles(
        zhProject,
        [
          {
            path: 'zh-Hans.lproj/Localizable.strings',
            locale: 'zh-Hans',
            platform: 'web',
            namespace: 'Localizable',
            entries: [{ key: 'greeting', value: '你好' }],
          },
        ],
        false,
      );
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const preview = payload<ImportResult>(result);

      // The dry run has to say so — "nothing was written" is useless on its own when the caller's
      // real question is whether their directory is about to become a second Chinese locale.
      expect(preview.dryRun).toBe(true);
      expect(preview.expansion.localesMatched).toEqual([{ from: 'zh-Hans', to: 'zh-CN' }]);
      expect(preview.expansion.localesAdded).toEqual([]);
      expect(preview.files[0]?.locale).toBe('zh-CN');
      expect(preview.files[0]?.isSource).toBe(true);

      // And it really wrote nothing.
      expect((await localesOf(zhProject)).map((row) => row.code).sort()).toEqual(['en-US', 'zh-CN']);
    });

    it('lands it as source once confirmed', async () => {
      const result = await importFiles(
        zhProject,
        [
          {
            path: 'zh-Hans.lproj/Localizable.strings',
            locale: 'zh-Hans',
            platform: 'web',
            namespace: 'Localizable',
            entries: [{ key: 'greeting', value: '你好' }],
          },
        ],
        true,
      );
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const imported = payload<ImportResult>(result);
      expect(imported.expansion.localesMatched).toEqual([{ from: 'zh-Hans', to: 'zh-CN' }]);

      // One Chinese, not two — and the text is source text.
      const locales = await localesOf(zhProject);
      expect(locales.map((row) => row.code).sort()).toEqual(['en-US', 'zh-CN']);
      expect(locales.find((row) => row.code === 'zh-CN')?.isSource).toBe(true);

      // Read back through the platform's own API: the value is stored under the project's `zh-CN`,
      // which is the whole point — the repository said `zh-Hans`.
      const entry = await call<{ value: string; locale: string }>(
        `/projects/${zhProject}/entry-by-key?key=greeting&locale=zh-CN`,
        { token: session.token },
      );
      expect(entry.status, JSON.stringify(entry.body.error)).toBe(200);
      expect(entry.body.data?.value).toBe('你好');
      expect(entry.body.data?.locale).toBe('zh-CN');
    });

    it('adds a language the project has never seen, and says which', async () => {
      const result = await importFiles(
        zhProject,
        [
          { path: 'locales/fr-FR/a.json', locale: 'fr-FR', platform: 'web', entries: [{ key: 'greeting', value: 'Bonjour' }] },
        ],
        true,
      );
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(payload<ImportResult>(result).expansion.localesAdded).toEqual(['fr-FR']);

      const locales = await localesOf(zhProject);
      const french = locales.find((row) => row.code === 'fr-FR');
      expect(french).toBeTruthy();
      // A locale the platform invents is named after the language, not after its own code.
      // Named from the shared catalog, in Chinese, so the web picker and the platform agree.
      expect(french?.name).toBe('法语（法国）');
      expect(french?.isSource).toBe(false);
    });

    it('reports the platform it would add, before adding it', async () => {
      const preview = payload<ImportResult>(
        await importFiles(
          zhProject,
          [
            {
              path: 'ios/ja.lproj/Localizable.strings',
              locale: 'ja-JP',
              platform: 'ios',
              namespace: 'Localizable',
              entries: [{ key: 'greeting', value: 'こんにちは' }],
            },
          ],
          false,
        ),
      );
      // The platform has no `ios` yet; a preview that stayed silent about that would be answering
      // half the question.
      expect(preview.expansion.platformsAdded).toEqual(['ios']);
      expect(preview.expansion.localesAdded).toEqual(['ja-JP']);
      const project = await call<{ platforms: { platform: string }[] }>(`/projects/${zhProject}`, {
        token: session.token,
      });
      // …and it really did not add it.
      expect((project.body.data?.platforms ?? []).map((row) => row.platform)).toEqual(['web']);
    });

    it('adds a platform the project did not declare, and reports it', async () => {
      const result = await importFiles(
        zhProject,
        [
          {
            path: 'ios/ja.lproj/Localizable.strings',
            locale: 'ja-JP',
            platform: 'ios',
            namespace: 'Localizable',
            entries: [{ key: 'greeting', value: 'こんにちは' }],
          },
        ],
        true,
      );
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const imported = payload<ImportResult>(result);
      expect(imported.expansion.platformsAdded).toEqual(['ios']);
      expect(imported.expansion.localesAdded).toEqual(['ja-JP']);

      const project = await call<{ platforms: { platform: string }[] }>(`/projects/${zhProject}`, {
        token: session.token,
      });
      expect((project.body.data?.platforms ?? []).map((row) => row.platform).sort()).toEqual(['ios', 'web']);
    });

    it('refuses to guess when a bare language could mean two locales', async () => {
      const created = await client!.callTool({
        name: 'create_project',
        arguments: { name: `Ambiguous ${runId}`, source_locale: 'zh-CN', locales: ['zh-TW'], platforms: ['web'] },
      });
      const ambiguousProject = payload<{ project: { id: string } }>(created).project.id;

      const result = await importFiles(
        ambiguousProject,
        [{ path: 'locales/zh/a.json', locale: 'zh', platform: 'web', entries: [{ key: 'greeting', value: '你好' }] }],
        true,
      );
      expect(result.isError).toBe(true);
      const message = JSON.stringify(result.content);
      expect(message).toContain('INVALID_LOCALE');
      expect(message).toContain('zh-CN');
      expect(message).toContain('zh-TW');

      // Nothing was added on the way to refusing.
      expect((await localesOf(ambiguousProject)).map((row) => row.code).sort()).toEqual(['zh-CN', 'zh-TW']);
    });

    it('records the expansion in the audit trail', async () => {
      const audited = await call<{ action: string; metadata: Record<string, unknown> }[]>(
        `/projects/${zhProject}/audit`,
        { token: session.token },
      );
      // One row per import, so the expansion is the union of what each of them added. This is the
      // record that answers "where did this language come from".
      const pushes = (audited.body.data ?? []).filter((entry) => entry.action === 'sync.push');
      expect(pushes.length).toBeGreaterThanOrEqual(3);
      const added = pushes.flatMap((entry) => (entry.metadata.localesAdded as string[]) ?? []);
      expect(added.sort()).toEqual(['fr-FR', 'ja-JP']);
      // Only the confirming call writes an audit row; the dry run above deliberately writes none.
      const matched = pushes.flatMap((entry) => (entry.metadata.localesMatched as { from: string; to: string }[]) ?? []);
      expect(matched).toEqual([{ from: 'zh-Hans', to: 'zh-CN' }]);
      const platforms = pushes.flatMap((entry) => (entry.metadata.platformsAdded as string[]) ?? []);
      expect(platforms).toEqual(['ios']);
    });
  });

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
        // All three, so this token fails on the project binding rather than on a missing scope —
        // which is what the test is about.
        scopes: ['repository.scan', 'sync.preview', 'sync.push'],
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