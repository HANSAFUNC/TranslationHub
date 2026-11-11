import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Account lifecycle and the organization audit trail.
 *
 * Covers the gaps left after member management landed: there was no way to change your own
 * password, no way to suspend an account without deleting it, no organization-level audit view,
 * and login picked an organization at random for a person who belongs to two.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let owner: { email: string; password: string; token: string; organizationId: string };

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

async function seedUser(email: string, password: string, role: string, organizationId?: string): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(password);
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({ data: { email, name: 'Account Suite', passwordHash, isPlatformAdmin: false } });
      const org =
        organizationId ??
        (
          await tx.organization.create({
            data: { name: `Account Org ${email}`, slug: `acct-${runId}-${Date.now().toString(36)}` },
          })
        ).id;
      await tx.membership.create({ data: { organizationId: org, userId: user.id, role: role as never } });
      return org;
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function login(email: string, password: string, organizationId?: string) {
  const response = await call<{ token: string; organization: { id: string }; organizations: { id: string }[] }>('/auth/login', {
    method: 'POST',
    body: { email, password, ...(organizationId ? { organizationId } : {}) },
  });
  return {
    status: response.status,
    token: response.body.data?.token ?? '',
    data: response.body.data,
    error: response.body.error,
  };
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });
  owner = { email: `acct-owner-${runId}@localehub.dev`, password: 'owner-password-123', token: '', organizationId: '' };
  owner.organizationId = await seedUser(owner.email, owner.password, 'ORG_OWNER');
  owner.token = (await login(owner.email, owner.password)).token;
}, 180_000);

afterAll(async () => {
  await api?.stop();
});

describe('changing your own password', () => {
  it('requires the current password', async () => {
    const member = { email: `acct-self-${runId}@localehub.dev`, password: 'original-password-1' };
    await seedUser(member.email, member.password, 'DEVELOPER', owner.organizationId);
    const token = (await login(member.email, member.password)).token;

    const wrong = await call('/auth/password', {
      method: 'PATCH',
      token,
      body: { currentPassword: 'not-my-password', newPassword: 'replacement-password-1' },
    });
    // A wrong current password is a failed authentication, not a malformed request.
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe('INVALID_TOKEN');

    // And nothing changed.
    expect((await login(member.email, member.password)).status).toBe(201);
  });

  it('lets a person rotate their own password, and the old one stops working', async () => {
    const member = { email: `acct-rotate-${runId}@localehub.dev`, password: 'first-password-123' };
    await seedUser(member.email, member.password, 'DEVELOPER', owner.organizationId);
    const token = (await login(member.email, member.password)).token;

    const changed = await call('/auth/password', {
      method: 'PATCH',
      token,
      body: { currentPassword: member.password, newPassword: 'second-password-456' },
    });
    expect(changed.status, JSON.stringify(changed.body.error)).toBe(200);

    expect((await login(member.email, 'second-password-456')).status).toBe(201);
    expect((await login(member.email, member.password)).status).toBe(401);
  });

  it('refuses an MCP token changing a password', async () => {
    const issued = await call<{ token: string }>('/mcp-tokens', {
      method: 'POST',
      token: owner.token,
      body: { name: 'account-suite', scopes: ['project.read'], projectIds: [], expiresInDays: 1 },
    });
    expect(issued.status).toBe(201);
    const response = await call('/auth/password', {
      method: 'PATCH',
      token: issued.body.data!.token,
      body: { currentPassword: 'x', newPassword: 'whatever-password-1' },
    });
    expect(response.status).toBe(403);
  });

  it('records the change in the audit trail', async () => {
    const trail = await call<{ action: string; actor: { email: string } | null }[]>('/organization/audit?action=user.', {
      token: owner.token,
    });
    expect(trail.status).toBe(200);
    expect(trail.body.data!.some((entry) => entry.action === 'user.password_change')).toBe(true);
  });
});

describe('suspending an account', () => {
  it('cuts off existing sessions and tokens immediately, and restores cleanly', async () => {
    const member = { email: `acct-suspend-${runId}@localehub.dev`, password: 'suspend-password-1' };
    await seedUser(member.email, member.password, 'DEVELOPER', owner.organizationId);
    const session = (await login(member.email, member.password)).token;

    const roster = await call<{ userId: string; email: string }[]>('/organization/members', { token: owner.token });
    const target = roster.body.data!.find((row) => row.email === member.email)!;

    // The MCP token is issued while the account is active, so the suspension has to invalidate an
    // already-issued credential — otherwise "suspend" would only affect future logins.
    const mcpToken = await call<{ token: string }>('/mcp-tokens', {
      method: 'POST',
      token: session,
      body: { name: 'suspend-probe', scopes: ['project.read'], projectIds: [], expiresInDays: 1 },
    });

    const suspended = await call(`/organization/members/${target.userId}/status`, {
      method: 'PATCH',
      token: owner.token,
      body: { deactivated: true },
    });
    expect(suspended.status, JSON.stringify(suspended.body.error)).toBe(200);

    // Existing session: rejected on the very next request.
    const after = await call('/auth/me', { token: session });
    expect(after.status).toBe(403);
    expect(after.body.error?.code).toBe('ACCOUNT_DEACTIVATED');

    // Existing MCP token: same treatment.
    if (mcpToken.status === 201) {
      const viaToken = await call('/projects', { token: mcpToken.body.data!.token });
      expect(viaToken.status).toBe(403);
      expect(viaToken.body.error?.code).toBe('ACCOUNT_DEACTIVATED');
    }

    // New logins: refused.
    const blocked = await login(member.email, member.password);
    expect(blocked.status).toBe(403);
    expect(blocked.error?.code).toBe('ACCOUNT_DEACTIVATED');

    const restored = await call(`/organization/members/${target.userId}/status`, {
      method: 'PATCH',
      token: owner.token,
      body: { deactivated: false },
    });
    expect(restored.status).toBe(200);
    expect((await login(member.email, member.password)).status).toBe(201);
  });

  it('refuses suspending yourself or the only owner', async () => {
    const self = await call<{ userId: string }[]>('/organization/members', { token: owner.token });
    const me = self.body.data!.find((row) => row.userId);
    expect(me).toBeTruthy();

    const roster = await call<{ userId: string; email: string }[]>('/organization/members', { token: owner.token });
    const ownerRow = roster.body.data!.find((row) => row.email === owner.email)!;

    const response = await call(`/organization/members/${ownerRow.userId}/status`, {
      method: 'PATCH',
      token: owner.token,
      body: { deactivated: true },
    });
    expect(response.status).toBe(409);
  });

  it('is recorded in the audit trail', async () => {
    const trail = await call<{ action: string }[]>('/organization/audit?action=member.', { token: owner.token });
    const actions = trail.body.data!.map((entry) => entry.action);
    expect(actions).toContain('member.suspend');
    expect(actions).toContain('member.restore');
  });
});

describe('the organization audit trail', () => {
  it('refuses a plain member', async () => {
    const member = { email: `acct-dev-${runId}@localehub.dev`, password: 'dev-password-1234' };
    await seedUser(member.email, member.password, 'DEVELOPER', owner.organizationId);
    const token = (await login(member.email, member.password)).token;

    const response = await call('/organization/audit', { token });
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('ROLE_INSUFFICIENT');
  });

  it('records member creation with the actor and the target', async () => {
    const created = `acct-audited-${runId}@localehub.dev`;
    await call('/organization/members', {
      method: 'POST',
      token: owner.token,
      body: { email: created, name: 'Audited', password: 'audited-password-1', role: 'DEVELOPER' },
    });

    const trail = await call<{ action: string; actor: { email: string } | null; metadata: Record<string, unknown> }[]>(
      '/organization/audit?action=member.create',
      { token: owner.token },
    );
    expect(trail.status).toBe(200);
    const entry = trail.body.data!.find((row) => row.metadata?.['email'] === created);
    expect(entry).toBeTruthy();
    expect(entry!.actor?.email).toBe(owner.email);
  });

  it('does not leak another organization’s trail', async () => {
    const outsider = `acct-outsider-${runId}@localehub.dev`;
    await seedUser(outsider, 'outsider-password-1', 'ORG_OWNER');
    const token = (await login(outsider, 'outsider-password-1')).token;

    const trail = await call<{ actor: { email: string } | null }[]>('/organization/audit', { token });
    expect(trail.status).toBe(200);
    const emails = trail.body.data!.map((entry) => entry.actor?.email).filter(Boolean);
    expect(emails).not.toContain(owner.email);
  });
});

describe('choosing an organization at login', () => {
  it('opens the requested organization, and remembers the last one', async () => {
    const email = `acct-multi-${runId}@localehub.dev`;
    const password = 'multi-password-123';
    const first = await seedUser(email, password, 'ORG_OWNER');
    const second = await seedUser(`acct-multi-second-${runId}@localehub.dev`, password, 'ORG_OWNER');

    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const user = await tx.user.findUniqueOrThrow({ where: { email } });
        // A second membership for the same person — the case that made `memberships[0]` unsafe.
        await tx.membership.create({ data: { organizationId: second, userId: user.id, role: 'READONLY' } });
      });
    } finally {
      await prisma.$disconnect();
    }

    const chosen = await login(email, password, second);
    expect(chosen.status).toBe(201);
    expect(chosen.data!.organization.id).toBe(second);
    expect(chosen.data!.organizations).toHaveLength(2);

    // Without an explicit choice the last opened organization is restored, not `memberships[0]`.
    const next = await login(email, password);
    expect(next.data!.organization.id).toBe(second);

    const back = await login(email, password, first);
    expect(back.data!.organization.id).toBe(first);
  });

  it('refuses an organization the account does not belong to', async () => {
    const email = `acct-single-${runId}@localehub.dev`;
    await seedUser(email, 'single-password-1', 'ORG_OWNER');
    const foreign = await seedUser(`acct-foreign-${runId}@localehub.dev`, 'foreign-password-1', 'ORG_OWNER');

    const response = await login(email, 'single-password-1', foreign);
    expect(response.status).toBe(403);
    expect(response.error?.code).toBe('ORGANIZATION_ACCESS_DENIED');
  });
});

describe('queue health', () => {
  it('is no longer readable without a credential', async () => {
    const response = await call('/system/queues');
    expect(response.status).toBe(401);
  });

  it('is readable by a platform administrator', async () => {
    const prisma = new PrismaClient();
    const email = `acct-platform-${runId}@localehub.dev`;
    try {
      const { hashPassword } = await import('@localehub/domain');
      const passwordHash = await hashPassword('platform-password-1');
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const user = await tx.user.create({
          data: { email, name: 'Platform', passwordHash, isPlatformAdmin: true },
        });
        await tx.membership.create({ data: { organizationId: owner.organizationId, userId: user.id, role: 'READONLY' } });
      });
    } finally {
      await prisma.$disconnect();
    }

    const token = (await login(email, 'platform-password-1')).token;
    const response = await call('/system/queues', { token });
    expect(response.status).toBe(200);
  });

  it('is refused to a normal administrator', async () => {
    const member = { email: `acct-admin-${runId}@localehub.dev`, password: 'admin-password-123' };
    await seedUser(member.email, member.password, 'ORG_ADMIN', owner.organizationId);
    const token = (await login(member.email, member.password)).token;

    const response = await call('/system/queues', { token });
    expect(response.status).toBe(403);
  });
});
