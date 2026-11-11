import { describe, expect, it, vi } from 'vitest';
import { recordAudit, redactForAudit } from '../audit';

/**
 * The audit trail is the only place that answers "who changed this", and since the Remote MCP
 * started writing to the same table as the REST API, both surfaces depend on this module. Two
 * properties matter and neither is visible from the call sites: a credential must never reach the
 * row, and a failure to write one must never break the operation being recorded.
 */

describe('redactForAudit', () => {
  it('replaces anything whose key looks like a credential', () => {
    const redacted = redactForAudit({
      name: 'release',
      token: 'lhmcp_abc123',
      apiKey: 'sk-live-1',
      nested: { authorization: 'Bearer x', cookie: 'session=1', password: 'hunter2' },
    }) as Record<string, unknown>;

    expect(redacted.name).toBe('release');
    expect(redacted.token).toBe('[redacted]');
    expect(redacted.apiKey).toBe('[redacted]');
    expect(redacted.nested).toEqual({ authorization: '[redacted]', cookie: '[redacted]', password: '[redacted]' });
    // Nothing survived by accident.
    expect(JSON.stringify(redacted)).not.toContain('lhmcp_abc123');
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('walks arrays and leaves ordinary values alone', () => {
    const redacted = redactForAudit({
      files: [{ path: 'locales/en-US/a.json', secrets: ['x'] }],
      count: 4,
      dryRun: false,
      nothing: null,
    }) as Record<string, unknown>;

    expect(redacted.count).toBe(4);
    expect(redacted.dryRun).toBe(false);
    expect(redacted.nothing).toBeNull();
    expect(redacted.files).toEqual([{ path: 'locales/en-US/a.json', secrets: '[redacted]' }]);
  });

  it('matches keys case-insensitively and by substring', () => {
    const redacted = redactForAudit({ ACCESS_TOKEN: 'a', clientSecret: 'b', API_KEY: 'c' }) as Record<string, string>;
    expect(Object.values(redacted)).toEqual(['[redacted]', '[redacted]', '[redacted]']);
  });
});

/** A Prisma double that records what the transaction ran and can be made to fail. */
function fakePrisma(options: { fail?: boolean } = {}) {
  const created: Record<string, unknown>[] = [];
  const sql: string[] = [];
  const client = {
    $transaction: async (run: (tx: unknown) => Promise<void>) =>
      run({
        $executeRawUnsafe: async (statement: string) => {
          sql.push(statement);
          return 0;
        },
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            if (options.fail) throw new Error('permission denied for table audit_logs');
            created.push(data);
            return data;
          },
        },
      }),
  };
  return { client, created, sql };
}

describe('recordAudit', () => {
  it('writes one row with the fields the caller supplied and sensible defaults', async () => {
    const prisma = fakePrisma();
    await recordAudit(prisma.client as never, {
      organizationId: 'org-1',
      actorId: 'user-1',
      actorType: 'mcp',
      action: 'sync.push',
      resourceType: 'sync_session',
      resourceId: 'session-1',
      projectId: 'project-1',
      syncSessionId: 'session-1',
      mcpClientId: 'client-1',
      metadata: { entryCount: 4 },
    });

    expect(prisma.created).toHaveLength(1);
    const row = prisma.created[0]!;
    expect(row).toMatchObject({
      organizationId: 'org-1',
      actorId: 'user-1',
      actorType: 'mcp',
      action: 'sync.push',
      resourceType: 'sync_session',
      resourceId: 'session-1',
      projectId: 'project-1',
      mcpClientId: 'client-1',
      metadata: { entryCount: 4 },
      requestId: null,
      durationMs: null,
    });
  });

  it('defaults the actor type to a user and the metadata to an empty object', async () => {
    const prisma = fakePrisma();
    await recordAudit(prisma.client as never, {
      organizationId: 'org-1',
      action: 'project.create',
      resourceType: 'project',
    });
    expect(prisma.created[0]).toMatchObject({ actorType: 'user', actorId: null, metadata: {} });
  });

  it('redacts metadata before it is written, not after', async () => {
    const prisma = fakePrisma();
    await recordAudit(prisma.client as never, {
      organizationId: 'org-1',
      action: 'mcp_token.create',
      resourceType: 'mcp_client',
      metadata: { name: 'ci', token: 'lhmcp_secret', nested: { webhookSecret: 'whsec' } },
    });
    expect(JSON.stringify(prisma.created[0])).not.toContain('lhmcp_secret');
    expect(JSON.stringify(prisma.created[0])).not.toContain('whsec');
  });

  it('runs on the privileged path so the row survives an organization-scoped write', async () => {
    const prisma = fakePrisma();
    await recordAudit(prisma.client as never, {
      organizationId: 'org-1',
      action: 'sync.push',
      resourceType: 'sync_session',
    });
    // Without this the insert is evaluated under RLS, and a row written for an organization the
    // request was not scoped to is silently dropped.
    expect(prisma.sql.join(' ')).toContain("set_config('app.bypass_rls', 'on', true)");
  });

  it('swallows a write failure and reports it instead of failing the operation', async () => {
    const prisma = fakePrisma({ fail: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The action it is recording already happened; throwing here would report a failure for
      // work that succeeded.
      await expect(
        recordAudit(prisma.client as never, {
          organizationId: 'org-1',
          action: 'sync.push',
          resourceType: 'sync_session',
        }),
      ).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
      expect(String(error.mock.calls[0]?.[0])).toContain('sync.push');
    } finally {
      error.mockRestore();
    }
  });
});
