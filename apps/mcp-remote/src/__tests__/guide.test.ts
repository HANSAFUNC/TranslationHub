import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PrismaClient, TenantPrisma } from '@localehub/database';
import { REMOTE_MCP_TOOLS, Role } from '@localehub/contracts';
import type { ActorContext } from '@localehub/permissions';

import { buildRemoteMcpServer } from '../server';

/**
 * What the server teaches a client about itself.
 *
 * This exists because of a concrete failure: an agent connected to this server, called
 * `import_translations` with a deliberately malformed body, and learned the argument shape from the
 * validation errors — three round trips to discover `files[0].entries[0].key`, and it never
 * discovered `platform`, `namespace` or `confirm`, because error messages only name *required*
 * fields and those three have defaults. The defaults are the dangerous part: `platform` defaults to
 * `web`, so an iOS import silently lands under the wrong platform, which is part of a key's
 * identity and cannot be corrected afterwards without re-importing.
 *
 * So the surfaces that teach are pinned here: the server instructions, the guide resource, the
 * prompt, and the field descriptions that ride along with `tools/list`.
 */

const ACTOR: ActorContext = {
  kind: 'mcp',
  userId: 'user-1',
  organizationId: 'org-1',
  orgRole: Role.ORG_OWNER,
  projectRoles: {},
  scopes: [],
  boundProjectIds: [],
  isPlatformAdmin: false,
  actorType: 'mcp',
};

async function connect(): Promise<Client> {
  const tenant = {
    withOrganization: async (_organizationId: string, callback: (tx: unknown) => unknown) =>
      callback({ skill: { findMany: async () => [] } }),
  } as unknown as TenantPrisma;

  const server = await buildRemoteMcpServer(ACTOR, {} as PrismaClient, tenant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'guide-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { contents: Array<{ text?: string; blob?: string }> }): string {
  const first = result.contents[0];
  return String(first && 'text' in first ? first.text : '');
}

describe('server instructions', () => {
  it('names both sync directions, so the agent does not reach for the wrong tool', async () => {
    const client = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('import_translations');
      expect(instructions).toContain('get_pending_platform_changes');
      expect(instructions).toContain('mark_applied');
      // The platform genuinely cannot read a checkout; saying so is what stops an agent looking
      // for a file tool that will never exist.
      expect(instructions).toContain('无法访问开发者的本地文件系统');
    } finally {
      await client.close();
    }
  });

  it('states the three rules a caller cannot recover from, and points at the guide', async () => {
    const client = await connect();
    try {
      const instructions = client.getInstructions() ?? '';
      // The repository's own directory name is what to pass — not a code the caller has to guess at.
      expect(instructions).toContain('zh-Hans');
      expect(instructions).toContain('归入');
      expect(instructions).toContain('自动新增');
      expect(instructions).toContain('platform 默认是 web');
      expect(instructions).toContain('300~400');
      expect(instructions).toContain('localehub://import-guide');
      // The dry-run default is the difference between "risky write" and "safe question".
      expect(instructions).toContain('dry run');
    } finally {
      await client.close();
    }
  });
});

describe('the import guide', () => {
  it('is served as markdown under a stable URI', async () => {
    const client = await connect();
    try {
      const listed = (await client.listResources()).resources.map((resource) => resource.uri);
      expect(listed).toContain('localehub://import-guide');

      const guide = await client.readResource({ uri: 'localehub://import-guide' });
      expect(guide.contents[0]?.mimeType).toBe('text/markdown');
      expect(textOf(guide).length).toBeGreaterThan(1000);
    } finally {
      await client.close();
    }
  });

  it('carries the call shape, including the fields that have defaults', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://import-guide' }));
      // The shape, so nobody has to probe for it.
      for (const field of ['project_id', 'confirm', 'files', 'path', 'locale', 'platform', 'namespace', 'entries']) {
        expect(text, field).toContain(field);
      }
    } finally {
      await client.close();
    }
  });

  it('states the batching limit with the measurement behind it', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://import-guide' }));
      // The number is measured, not guessed: 400 entries succeeded in ~3.2s, 1000 died at the
      // 5000 ms interactive-transaction timeout.
      expect(text).toContain('300~400');
      expect(text).toContain('5000 ms');
      expect(text).toContain('整批回滚');
    } finally {
      await client.close();
    }
  });

  it('explains what happens to a locale the project does not have', async () => {
    const client = await connect();
    try {
      const text = textOf(await client.readResource({ uri: 'localehub://import-guide' }));
      // The four outcomes, each of which the caller has to be able to predict.
      expect(text).toContain('zh-Hans');
      expect(text).toContain('zh-CN');
      expect(text).toContain('localesMatched');
      expect(text).toContain('localesAdded');
      expect(text).toContain('platformsAdded');
      expect(text).toContain('拒绝');
      // Why it matters: getting this wrong once cost the source versions.
      expect(text).toContain('source version');
      expect(text).toContain('namespace');
    } finally {
      await client.close();
    }
  });
});

describe('the upload prompt', () => {
  it('is registered with its arguments and renders them', async () => {
    const client = await connect();
    try {
      const prompt = (await client.listPrompts()).prompts.find((row) => row.name === 'import-localization-files');
      expect(prompt).toBeTruthy();
      expect((prompt?.arguments ?? []).map((arg) => arg.name).sort()).toEqual(['localesDir', 'projectId']);

      const rendered = await client.getPrompt({
        name: 'import-localization-files',
        arguments: { projectId: 'project-42', localesDir: 'ios/Resources' },
      });
      const text = String((rendered.messages[0]?.content as { text?: string }).text ?? '');
      expect(text).toContain('project_id=project-42');
      expect(text).toContain('ios/Resources');
      // It has to send the agent to the guide rather than restate it, or the two will drift.
      expect(text).toContain('localehub://import-guide');
      // And it must stop before writing when the two irreversible decisions are wrong.
      expect(text).toContain('先停下来');
    } finally {
      await client.close();
    }
  });

  it('does not collide with a skill prompt of the same name', async () => {
    const client = await connect();
    try {
      const names = (await client.listPrompts()).prompts.map((row) => row.name);
      expect(names.filter((name) => name === 'import-localization-files')).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

describe('tool schemas teach the arguments', () => {
  it('describes every field of import_translations that has a default', async () => {
    const client = await connect();
    try {
      const tool = (await client.listTools()).tools.find((row) => row.name === 'import_translations');
      const schema = tool?.inputSchema as {
        properties: Record<string, { description?: string; default?: unknown; items?: { properties: Record<string, { description?: string; default?: unknown }> } }>;
      };
      const file = schema.properties.files!.items!.properties;

      // These three are exactly what probing cannot reveal, because they are not required.
      expect(file.platform!.default).toBe('web');
      expect(file.platform!.description).toContain('ios');
      // A default the caller cannot see is the whole failure mode this test exists for, so the
      // description has to say both what the default is and when it is wrong.
      expect(file.platform!.description).toContain('自动加上');
      expect(file.locale!.description).toContain('zh-Hans');
      expect(file.locale!.description).toContain('自动新增');
      expect(file.namespace!.description).toContain('Localizable');
      expect(schema.properties.confirm!.default).toBe(false);
      expect(schema.properties.confirm!.description).toContain('dry run');
      expect(schema.properties.files!.description).toContain('300~400');
    } finally {
      await client.close();
    }
  });

  it('describes the fields of mark_applied that decide whether a claim is checkable', async () => {
    const client = await connect();
    try {
      const tool = (await client.listTools()).tools.find((row) => row.name === 'mark_applied');
      const schema = tool?.inputSchema as {
        properties: { items?: { items?: { properties: Record<string, { description?: string }> } }; dry_run?: { description?: string } };
      };
      expect(schema.properties.items!.items!.properties.translation_version_id!.description).toContain('当前版本');
      expect(schema.properties.dry_run!.description).toContain('不写库');
    } finally {
      await client.close();
    }
  });

  it('leaves no tool without a description', async () => {
    const client = await connect();
    try {
      const tools = (await client.listTools()).tools;
      for (const name of REMOTE_MCP_TOOLS) {
        const tool = tools.find((row) => row.name === name);
        expect(tool, name).toBeTruthy();
        expect(tool!.description?.length ?? 0, name).toBeGreaterThan(10);
      }
    } finally {
      await client.close();
    }
  });
});
