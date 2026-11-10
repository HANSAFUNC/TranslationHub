import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PrismaClient, TenantPrisma } from '@localehub/database';
import {
  REMOTE_MCP_PROMPTS,
  REMOTE_MCP_RESOURCES,
  Role,
  SKILLS_INDEX_URI,
  type SkillSourceRow,
} from '@localehub/contracts';
import type { ActorContext } from '@localehub/permissions';

import { buildRemoteMcpServer } from '../server';

/**
 * Skill delivery on the Remote MCP, driven through the real MCP protocol.
 *
 * `buildRemoteMcpServer` is handed a stub tenant rather than a database: what is being tested is
 * the wiring (which resources and prompts exist, under which URIs and names, and what a read
 * returns), not Prisma. The query itself is the same shape the API's `GET /skills` uses and is
 * covered against a live database by the integration suite.
 */

/** `contents` is a text|blob union; every resource here is text. */
function textOf(result: { contents: Array<{ text?: string; blob?: string }> }): string {
  const first = result.contents[0];
  return String(first && 'text' in first ? first.text : '');
}

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

function sourceRow(overrides: Partial<SkillSourceRow> & Pick<SkillSourceRow, 'slug'>): SkillSourceRow {
  return {
    name: overrides.slug,
    description: null,
    version: '1.0.0',
    kind: 'PROMPT',
    status: 'PUBLISHED',
    content: `---\nname: ${overrides.slug}\nversion: 1.0.0\n---\n# ${overrides.slug}\n\nSteps.`,
    ...overrides,
  } as SkillSourceRow;
}

const ROWS: SkillSourceRow[] = [
  sourceRow({ slug: 'translation-review', name: '译文审核', description: '审核译文' }),
  sourceRow({ slug: 'localization-sync', kind: 'SCRIPT' }),
  sourceRow({ slug: 'not-published', status: 'DRAFT' }),
  // A slug that would collide with a built-in prompt name if prompts were not prefixed.
  sourceRow({ slug: 'fix-translation-issues', name: 'Collision probe' }),
];

async function connect(rows: SkillSourceRow[] = ROWS, options: { failQuery?: boolean } = {}): Promise<Client> {
  const tenant = {
    withOrganization: async (_organizationId: string, callback: (tx: unknown) => unknown) => {
      if (options.failQuery) throw new Error('database is on fire');
      return callback({ skill: { findMany: async () => rows } });
    },
  } as unknown as TenantPrisma;

  const server = await buildRemoteMcpServer(ACTOR, {} as PrismaClient, tenant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'remote-skill-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('Remote MCP registry matches the constants the API publishes', () => {
  // `GET /mcp/tools` renders `REMOTE_MCP_RESOURCES` / `REMOTE_MCP_PROMPTS`. If a registration here
  // drifts from those lists, the discovery endpoint starts advertising something else — which is
  // exactly how it ended up listing six resources no server implemented.
  it('registers every advertised non-skill resource', async () => {
    const client = await connect();
    try {
      const uris = (await client.listResources()).resources.map((resource) => resource.uri);
      for (const uri of REMOTE_MCP_RESOURCES) expect(uris).toContain(uri);
    } finally {
      await client.close();
    }
  });

  it('registers every advertised hand-written prompt', async () => {
    const client = await connect();
    try {
      const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
      for (const name of REMOTE_MCP_PROMPTS) expect(names).toContain(name);
    } finally {
      await client.close();
    }
  });
});

describe('Remote MCP skill delivery', () => {
  it('lists the index and only the published skills', async () => {
    const client = await connect();
    try {
      const uris = (await client.listResources()).resources.map((resource) => resource.uri);
      expect(uris).toContain(SKILLS_INDEX_URI);
      expect(uris).toContain('localehub://skills/translation-review');
      expect(uris).not.toContain('localehub://skills/not-published');
    } finally {
      await client.close();
    }
  });

  it('reads a skill as the verbatim SKILL.md and refuses an unpublished slug', async () => {
    const client = await connect();
    try {
      const result = await client.readResource({ uri: 'localehub://skills/translation-review' });
      expect(textOf(result)).toContain('# translation-review');
      await expect(client.readResource({ uri: 'localehub://skills/not-published' })).rejects.toThrow(/not published/i);
    } finally {
      await client.close();
    }
  });

  it('lets a skill whose slug matches a built-in prompt coexist with it', async () => {
    // `registerPrompt` throws on a duplicate name, and that throw would happen while the server
    // is being built — i.e. every request would fail, not just this skill's. The `skill-` prefix
    // is what makes the two names distinct.
    const client = await connect();
    try {
      const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
      expect(names).toContain('fix-translation-issues');
      expect(names).toContain('skill-fix-translation-issues');
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await client.close();
    }
  });

  it('serves prompts for PROMPT skills and not for SCRIPT skills', async () => {
    const client = await connect();
    try {
      const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
      expect(names).toContain('skill-translation-review');
      expect(names).not.toContain('skill-localization-sync');
    } finally {
      await client.close();
    }
  });

  it('returns the skill body without frontmatter when the prompt is invoked', async () => {
    const client = await connect();
    try {
      const result = await client.getPrompt({ name: 'skill-translation-review', arguments: { focus: 'de-DE' } });
      const content = result.messages[0]?.content;
      const text = String(content?.type === 'text' ? content.text : '');
      expect(text).toContain('LocaleHub Skill「译文审核」');
      expect(text).toContain('本次范围：de-DE');
      expect(text).not.toContain('version: 1.0.0');
    } finally {
      await client.close();
    }
  });

  it('keeps all 15 tools and starts anyway when the skill query fails', async () => {
    // A skills table that cannot be read must not take the tools down with it.
    const client = await connect(ROWS, { failQuery: true });
    try {
      expect((await client.listTools()).tools).toHaveLength(15);

      const uris = (await client.listResources()).resources.map((resource) => resource.uri);
      // The index is still advertised, and says so plainly rather than reading as "no skills exist".
      expect(uris).toContain(SKILLS_INDEX_URI);
      const index = await client.readResource({ uri: SKILLS_INDEX_URI });
      expect(textOf(index)).toContain('没有已发布的 Skill');
    } finally {
      await client.close();
    }
  });
});
