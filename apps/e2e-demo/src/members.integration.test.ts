import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Organization member management against a real API and database.
 *
 * The unit suite pins the decision logic. What only a live run can show is the wiring: that the
 * routes exist, that the guards are actually installed on them, that a created account can really
 * log in, and that a role change really changes what that account may do. The privilege rules
 * below are the ones whose failure would be silent — a refused 403 that nonetheless wrote the row
 * is the failure mode docs/STATUS.md §1.11 records, so several tests assert the state *after* the
 * refusal rather than the status code alone.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let owner: { email: string; password: string; token: string; organizationId: string };
let admin: { email: string; password: string; token: string };
let developer: { email: string; password: string; token: string };

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

/** A user created straight in the database, so the suite can bootstrap its own tenant. */
async function seedUser(email: string, password: string, options: { organizationId?: string; role: string }): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({ data: { email, name: 'Members Suite', passwordHash, isPlatformAdmin: false } });
      const organizationId =
        options.organizationId ??
        (
          await tx.organization.create({
            data: { name: `Members Org ${email}`, slug: `members-${runId}-${Date.now().toString(36)}` },
          })
        ).id;
      await tx.membership.create({ data: { organizationId, userId: user.id, role: options.role as never } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function login(email: string, password: string): Promise<{ status: number; token: string }> {
  const response = await call<{ token: string }>('/auth/login', { method: 'POST', body: { email, password } });
  return { status: response.status, token: response.body.data?.token ?? '' };
}

interface MemberRow {
  userId: string;
  email: string;
  role: string;
  projects: { projectId: string; projectName: string; role: string; localeScope: string[] }[];
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  owner = { email: `mem-owner-${runId}@localehub.dev`, password: 'owner-password-123', token: '', organizationId: '' };
  await seedUser(owner.email, owner.password, { role: 'ORG_OWNER' });
  const ownerLogin = await call<{ token: string; organization: { id: string } }>('/auth/login', {
    method: 'POST',
    body: { email: owner.email, password: owner.password },
  });
  expect(ownerLogin.status).toBeLessThan(300);
  owner.token = ownerLogin.body.data!.token;
  owner.organizationId = ownerLogin.body.data!.organization.id;

  admin = { email: `mem-admin-${runId}@localehub.dev`, password: 'admin-password-123', token: '' };
  await seedUser(admin.email, admin.password, { organizationId: owner.organizationId, role: 'ORG_ADMIN' });
  admin.token = (await login(admin.email, admin.password)).token;

  developer = { email: `mem-dev-${runId}@localehub.dev`, password: 'dev-password-123', token: '' };
  await seedUser(developer.email, developer.password, { organizationId: owner.organizationId, role: 'DEVELOPER' });
  developer.token = (await login(developer.email, developer.password)).token;
}, 180_000);

afterAll(async () => {
  await api?.stop();
});

describe('listing members', () => {
  it('lists the organization roster for an admin', async () => {
    const list = await call<MemberRow[]>('/organization/members', { token: admin.token });
    expect(list.status).toBe(200);
    const emails = list.body.data!.map((member) => member.email);
    expect(emails).toContain(owner.email);
    expect(emails).toContain(developer.email);
  });

  it('refuses a plain member', async () => {
    const list = await call('/organization/members', { token: developer.token });
    expect(list.status).toBe(403);
    expect(list.body.error?.code).toBe('ROLE_INSUFFICIENT');
  });

  it('does not leak members of another organization', async () => {
    const outsider = `mem-outsider-${runId}@localehub.dev`;
    await seedUser(outsider, 'outsider-password-123', { role: 'ORG_OWNER' });
    const outsiderToken = (await login(outsider, 'outsider-password-123')).token;

    const list = await call<MemberRow[]>('/organization/members', { token: outsiderToken });
    expect(list.status).toBe(200);
    expect(list.body.data!.map((member) => member.email)).not.toContain(owner.email);
  });
});

describe('creating a member', () => {
  const created = { email: `mem-created-${runId}@localehub.dev`, password: 'created-password-123' };

  it('creates an account an admin can hand over, and the account can sign in', async () => {
    const response = await call<MemberRow>('/organization/members', {
      method: 'POST',
      token: admin.token,
      body: { email: created.email, name: 'Created By Admin', password: created.password, role: 'TRANSLATOR' },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    expect(response.body.data!.role).toBe('TRANSLATOR');

    // The point of creating an account is that somebody can use it.
    const signIn = await login(created.email, created.password);
    expect(signIn.status).toBe(201);
    expect(signIn.token).toBeTruthy();
  });

  it('does not change an existing account password when attaching it to the organization', async () => {
    // The account-takeover guard: "add by email" must never write a password onto an account the
    // caller does not control. Without this, any organization admin could take over any account
    // on the platform by adding its owner with a password of their choosing.
    const victim = `mem-victim-${runId}@localehub.dev`;
    const victimPassword = 'victim-original-password';
    await seedUser(victim, victimPassword, { role: 'ORG_OWNER' });

    const response = await call<MemberRow>('/organization/members', {
      method: 'POST',
      token: admin.token,
      body: { email: victim, name: 'Hijack Attempt', password: 'attacker-chosen-password', role: 'READONLY' },
    });
    expect(response.status, JSON.stringify(response.body.error)).toBe(201);
    expect(response.body.data!.role).toBe('READONLY');

    // Original credential still works …
    expect((await login(victim, victimPassword)).status).toBe(201);
    // … and the one supplied by the admin never became a credential.
    expect((await login(victim, 'attacker-chosen-password')).status).toBe(401);
  });

  it('refuses a duplicate membership', async () => {
    const again = await call('/organization/members', {
      method: 'POST',
      token: admin.token,
      body: { email: created.email, name: 'Again', password: created.password, role: 'DEVELOPER' },
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('CONFLICT');
  });

  it('requires a name and password for a brand-new account', async () => {
    const response = await call('/organization/members', {
      method: 'POST',
      token: admin.token,
      body: { email: `mem-noname-${runId}@localehub.dev`, role: 'DEVELOPER' },
    });
    expect(response.status).toBe(422);
    expect(response.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a password below the minimum length', async () => {
    const response = await call('/organization/members', {
      method: 'POST',
      token: admin.token,
      body: { email: `mem-short-${runId}@localehub.dev`, name: 'Short', password: 'short', role: 'DEVELOPER' },
    });
    expect(response.status).toBe(422);
  });

  it('refuses a plain member creating an account', async () => {
    const response = await call('/organization/members', {
      method: 'POST',
      token: developer.token,
      body: { email: `mem-sneaky-${runId}@localehub.dev`, name: 'Sneaky', password: 'sneaky-password-1', role: 'ORG_ADMIN' },
    });
    expect(response.status).toBe(403);
  });
});

describe('the privilege ladder holds', () => {
  it('stops an admin from minting an owner', async () => {
    const response = await call('/organization/members', {
      method: 'POST',
      token: admin.token,
      body: {
        email: `mem-fake-owner-${runId}@localehub.dev`,
        name: 'Fake Owner',
        password: 'fake-owner-pass-1',
        role: 'ORG_OWNER',
      },
    });
    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('ROLE_INSUFFICIENT');

    // And nothing was written: the refusal has to have prevented the row, not just returned 403.
    const list = await call<MemberRow[]>('/organization/members', { token: owner.token });
    expect(list.body.data!.map((member) => member.email)).not.toContain(`mem-fake-owner-${runId}@localehub.dev`);
  });

  it('stops an admin from demoting the owner', async () => {
    const target = (await call<MemberRow[]>('/organization/members', { token: admin.token })).body.data!.find(
      (member) => member.email === owner.email,
    )!;
    const response = await call(`/organization/members/${target.userId}`, {
      method: 'PATCH',
      token: admin.token,
      body: { role: 'READONLY' },
    });
    expect(response.status).toBe(403);

    const after = (await call<MemberRow[]>('/organization/members', { token: owner.token })).body.data!.find(
      (member) => member.email === owner.email,
    )!;
    expect(after.role).toBe('ORG_OWNER');
  });

  it('stops an admin from removing the owner', async () => {
    const target = (await call<MemberRow[]>('/organization/members', { token: admin.token })).body.data!.find(
      (member) => member.email === owner.email,
    )!;
    const response = await call(`/organization/members/${target.userId}`, { method: 'DELETE', token: admin.token });
    expect(response.status).toBe(403);
    // The owner's session must still work.
    expect((await call('/auth/me', { token: owner.token })).status).toBe(200);
  });

  it('refuses to remove or demote the last owner, even by that owner', async () => {
    // This tenant has exactly one owner, and an owner acting on themselves hits the
    // self-protection rule before the last-owner rule — both must refuse.
    const self = (await call<MemberRow[]>('/organization/members', { token: owner.token })).body.data!.find(
      (member) => member.email === owner.email,
    )!;

    const demote = await call(`/organization/members/${self.userId}`, {
      method: 'PATCH',
      token: owner.token,
      body: { role: 'ORG_ADMIN' },
    });
    expect(demote.status).toBe(409);

    const remove = await call(`/organization/members/${self.userId}`, { method: 'DELETE', token: owner.token });
    expect(remove.status).toBe(409);

    const after = (await call<MemberRow[]>('/organization/members', { token: owner.token })).body.data!.find(
      (member) => member.email === owner.email,
    )!;
    expect(after.role).toBe('ORG_OWNER');
  });

  it('refuses project creation by a member below project manager', async () => {
    // `POST /projects` names no project, so the guard's `@RequireRole` on that route decides
    // nothing by itself — the service has to assert. It did not, and a READONLY member could
    // create projects in the organization (verified against the running API before the fix).
    const readonly = { email: `mem-ro-${runId}@localehub.dev`, password: 'readonly-password-123' };
    await seedUser(readonly.email, readonly.password, { organizationId: owner.organizationId, role: 'READONLY' });
    const readonlyToken = (await login(readonly.email, readonly.password)).token;

    for (const [who, token] of [
      ['READONLY', readonlyToken],
      ['DEVELOPER', developer.token],
    ] as const) {
      const response = await call<{ id: string }>('/projects', {
        method: 'POST',
        token,
        body: { name: `escalation-${who}-${runId}`, sourceLocale: 'en-US' },
      });
      expect(response.status, `${who} creating a project`).toBe(403);
      expect(response.body.error?.code).toBe('ROLE_INSUFFICIENT');
      // …and nothing was written.
      const list = await call<{ name: string }[]>('/projects', { token: owner.token });
      expect(list.body.data!.map((project) => project.name)).not.toContain(`escalation-${who}-${runId}`);
    }
  });

  it('lets an admin change a lower role, and the change takes effect', async () => {
    const target = (await call<MemberRow[]>('/organization/members', { token: admin.token })).body.data!.find(
      (member) => member.email === developer.email,
    )!;

    // A DEVELOPER cannot create a project today.
    const before = await call('/projects', {
      method: 'POST',
      token: developer.token,
      body: { name: `dev-cannot-${runId}`, sourceLocale: 'en-US' },
    });
    expect(before.status).toBe(403);

    const promoted = await call(`/organization/members/${target.userId}`, {
      method: 'PATCH',
      token: admin.token,
      body: { role: 'PROJECT_MANAGER' },
    });
    expect(promoted.status).toBe(200);

    // The session token carries the role, so it has to be reissued — that is the intended
    // behaviour (a role change is not retroactive onto an already-issued credential).
    const refreshed = (await login(developer.email, developer.password)).token;
    const after = await call('/projects', {
      method: 'POST',
      token: refreshed,
      body: { name: `pm-can-${runId}`, sourceLocale: 'en-US' },
    });
    expect(after.status).toBe(201);
  });
});

describe('project roles', () => {
  let projectId = '';
  let targetUserId = '';

  it('assigns a project role to an organization member', async () => {
    const project = await call<{ id: string }>('/projects', {
      method: 'POST',
      token: owner.token,
      body: { name: `members-project-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
    });
    expect(project.status).toBe(201);
    projectId = project.body.data!.id;

    const target = (await call<MemberRow[]>('/organization/members', { token: owner.token })).body.data!.find(
      (member) => member.email === developer.email,
    )!;
    targetUserId = target.userId;

    const assigned = await call<{ role: string; localeScope: string[] }>(
      `/organization/members/${targetUserId}/projects/${projectId}`,
      { method: 'PUT', token: owner.token, body: { role: 'TRANSLATOR', localeScope: ['ja-JP'] } },
    );
    expect(assigned.status, JSON.stringify(assigned.body.error)).toBe(200);
    expect(assigned.body.data!.role).toBe('TRANSLATOR');

    const list = (await call<MemberRow[]>('/organization/members', { token: owner.token })).body.data!;
    const row = list.find((member) => member.userId === targetUserId)!;
    expect(row.projects).toContainEqual({
      projectId,
      projectName: `members-project-${runId}`,
      role: 'TRANSLATOR',
      localeScope: ['ja-JP'],
    });
  });

  it('refuses a locale the project does not have', async () => {
    const response = await call(`/organization/members/${targetUserId}/projects/${projectId}`, {
      method: 'PUT',
      token: owner.token,
      body: { role: 'TRANSLATOR', localeScope: ['de-DE'] },
    });
    expect(response.status).toBe(400);
    expect(response.body.error?.details).toMatchObject({ unknown: ['de-DE'] });
  });

  it('offers no second path that could add an organization member', async () => {
    // `POST /projects/:projectId/members` used to do this: it required only PROJECT_MANAGER on the
    // project, then created the organization membership itself with the *project* role as the org
    // role. A user whose organization role was DEVELOPER, holding PROJECT_MANAGER on one project,
    // could therefore pull an outsider into the organization as a PROJECT_MANAGER — above their
    // own organization role, and past every guard in §1.14. Reproduced against the running API
    // before removal; this asserts the route is gone.
    const response = await call(`/projects/${projectId}/members`, {
      method: 'POST',
      token: owner.token,
      body: { email: `route-probe-${runId}@localehub.dev`, role: 'PROJECT_MANAGER' },
    });
    expect(response.status).toBe(404);
  });

  it('refuses an organization role as a project role', async () => {
    const response = await call(`/organization/members/${targetUserId}/projects/${projectId}`, {
      method: 'PUT',
      token: owner.token,
      body: { role: 'ORG_OWNER' },
    });
    expect(response.status).toBe(422);
  });

  it('refuses assigning a project role to somebody outside the organization', async () => {
    const outsider = `mem-outside-${runId}@localehub.dev`;
    await seedUser(outsider, 'outside-password-123', { role: 'ORG_OWNER' });
    const outsiderToken = (await login(outsider, 'outside-password-123')).token;
    const outsiderMe = await call<{ id: string }>('/auth/me', { token: outsiderToken });

    const response = await call(`/organization/members/${outsiderMe.body.data!.id}/projects/${projectId}`, {
      method: 'PUT',
      token: owner.token,
      body: { role: 'TRANSLATOR' },
    });
    expect(response.status).toBe(404);
    expect(response.body.error?.message).toMatch(/not a member/i);
  });

  it('drops project roles when the member is removed, so re-adding does not restore them', async () => {
    const removed = await call(`/organization/members/${targetUserId}`, { method: 'DELETE', token: owner.token });
    expect(removed.status).toBe(200);

    const prisma = new PrismaClient();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const leftovers = await tx.projectMember.count({ where: { userId: targetUserId } });
        expect(leftovers).toBe(0);
      });
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('resetting a password', () => {
  it('lets an admin set a new password that works', async () => {
    const member = { email: `mem-reset-${runId}@localehub.dev`, password: 'first-password-123' };
    const created = await call<MemberRow>('/organization/members', {
      method: 'POST',
      token: admin.token,
      body: { email: member.email, name: 'Reset Target', password: member.password, role: 'READONLY' },
    });
    expect(created.status).toBe(201);

    const reset = await call(`/organization/members/${created.body.data!.userId}/password`, {
      method: 'POST',
      token: admin.token,
      body: { password: 'second-password-456' },
    });
    expect(reset.status, JSON.stringify(reset.body.error)).toBe(201);

    expect((await login(member.email, 'second-password-456')).status).toBe(201);
    expect((await login(member.email, member.password)).status).toBe(401);
  });
});
