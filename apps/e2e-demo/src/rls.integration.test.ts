import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, TenantPrisma } from '@localehub/database';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Row level security for the tables that had none.
 *
 * `users`, `organizations` and `review_actions` carry no `organization_id` column, which is why
 * they were left out of the original policy set. That omission ran the wrong way: an unscoped read
 * by the application role returned **everything** rather than nothing.
 *
 * These tests use the application role directly — the same credentials the API uses in production
 * — so they measure the database policy rather than the code that usually sits in front of it.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const APP_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://localehub_app:localehub@127.0.0.1:55432/localehub?schema=public';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let organizationA = '';
let organizationB = '';
let userA = '';
let userB = '';

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword('rls-password-123');
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const orgA = await tx.organization.create({ data: { name: `RLS A ${runId}`, slug: `rls-a-${runId}` } });
      const orgB = await tx.organization.create({ data: { name: `RLS B ${runId}`, slug: `rls-b-${runId}` } });
      organizationA = orgA.id;
      organizationB = orgB.id;

      const a = await tx.user.create({
        data: { email: `rls-a-${runId}@localehub.dev`, name: 'User A', passwordHash },
      });
      const b = await tx.user.create({
        data: { email: `rls-b-${runId}@localehub.dev`, name: 'User B', passwordHash },
      });
      userA = a.id;
      userB = b.id;

      await tx.membership.create({ data: { organizationId: organizationA, userId: userA, role: 'ORG_OWNER' } });
      await tx.membership.create({ data: { organizationId: organizationB, userId: userB, role: 'ORG_OWNER' } });
    });
  } finally {
    await prisma.$disconnect();
  }
}, 180_000);

afterAll(async () => {
  await api?.stop();
});

function appPrisma(): { prisma: PrismaClient; tenant: TenantPrisma } {
  const prisma = new PrismaClient({ datasourceUrl: APP_DATABASE_URL });
  return { prisma, tenant: new TenantPrisma(prisma) };
}

describe('users', () => {
  it('shows only the members of the scoped organization', async () => {
    const { prisma, tenant } = appPrisma();
    try {
      const visible = await tenant.withOrganization(organizationA, (tx) => tx.user.findMany({ select: { id: true } }));
      const ids = visible.map((user) => user.id);
      expect(ids).toContain(userA);
      expect(ids).not.toContain(userB);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('returns nothing at all without an organization context', async () => {
    // The direction that matters: before the policy existed this returned every user on the
    // platform, password hashes included.
    const { prisma } = appPrisma();
    try {
      const all = await prisma.user.findMany({ select: { id: true } });
      expect(all).toEqual([]);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('organizations', () => {
  it('shows only the scoped organization', async () => {
    const { prisma, tenant } = appPrisma();
    try {
      const visible = await tenant.withOrganization(organizationA, (tx) =>
        tx.organization.findMany({ select: { id: true } }),
      );
      expect(visible.map((org) => org.id)).toEqual([organizationA]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('returns nothing without an organization context', async () => {
    const { prisma } = appPrisma();
    try {
      expect(await prisma.organization.findMany({ select: { id: true } })).toEqual([]);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe('review_actions', () => {
  it('scopes through the review task that owns the action', async () => {
    const prisma = new PrismaClient();
    let taskA = '';
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        const project = await tx.project.create({
          data: { organizationId: organizationA, name: `rls-project-${runId}`, slug: `rls-project-${runId}`, sourceLocale: 'en-US' },
        });
        // A key belongs to a namespace; the default one is created with the project in the real
        // flow, so this fixture creates it explicitly.
        const namespace = await tx.namespace.create({
          data: { organizationId: organizationA, projectId: project.id, name: 'common', platform: 'web' },
        });
        const key = await tx.translationKey.create({
          data: { organizationId: organizationA, projectId: project.id, namespaceId: namespace.id, platform: 'web', key: 'title' },
        });
        const source = await tx.sourceVersion.create({
          data: {
            organizationId: organizationA,
            projectId: project.id,
            keyId: key.id,
            version: 1,
            value: 'Title',
            contentHash: 'a'.repeat(64),
          },
        });
        // The project needs the target locale row before an entry can point at it.
        const locale = await tx.locale.create({
          data: { organizationId: organizationA, projectId: project.id, code: 'ja-JP', name: 'ja-JP', isSource: false },
        });
        const entry = await tx.translationEntry.create({
          data: {
            organizationId: organizationA,
            projectId: project.id,
            keyId: key.id,
            localeId: locale.id,
            localeCode: 'ja-JP',
            value: 'タイトル',
            status: 'PENDING_REVIEW',
            contentHash: 'b'.repeat(64),
            basedOnSourceVersionId: source.id,
          },
        });
        // `status` is a `ReviewStatus`, not a task-state enum: a review task is either awaiting a
        // decision or already decided.
        const task = await tx.reviewTask.create({
          data: {
            organizationId: organizationA,
            projectId: project.id,
            entryId: entry.id,
            localeCode: 'ja-JP',
            status: 'PENDING_REVIEW',
          },
        });
        taskA = task.id;
        await tx.reviewAction.create({ data: { taskId: task.id, decision: 'APPROVE', entryVersion: 1 } });
      });
    } finally {
      await prisma.$disconnect();
    }

    const { prisma: app, tenant } = appPrisma();
    try {
      const visibleToA = await tenant.withOrganization(organizationA, (tx) => tx.reviewAction.findMany({ select: { id: true } }));
      expect(visibleToA.length).toBe(1);

      const visibleToB = await tenant.withOrganization(organizationB, (tx) => tx.reviewAction.findMany({ select: { id: true } }));
      expect(visibleToB).toEqual([]);

      expect(await app.reviewAction.findMany({ select: { id: true } })).toEqual([]);
      expect(taskA).toBeTruthy();
    } finally {
      await app.$disconnect();
    }
  });
});

describe('the authentication path still works', () => {
  it('logs in, which reads `users` before any organization is known', async () => {
    // Login is the load-bearing exception: it looks a person up by email with `app.bypass_rls`
    // set. If the policy ever broke that path, nobody could sign in at all.
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `rls-a-${runId}@localehub.dev`, password: 'rls-password-123' }),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { data?: { token: string } };
    expect(payload.data?.token).toBeTruthy();

    // And the session keeps working on the next request, which re-reads the user.
    const me = await fetch(`${API_BASE}/auth/me`, {
      headers: { authorization: `Bearer ${payload.data!.token}` },
    });
    expect(me.status).toBe(200);
  });
});