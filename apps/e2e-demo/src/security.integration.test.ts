import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@localehub/database';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * Integration coverage for the request-level security baseline, against a real API and PostgreSQL.
 *
 * Unit tests already pin the decision logic; these tests check the wiring that the unit tests
 * cannot see — that the guards are actually installed, that cookies survive the round trip, and
 * that the organization policy is enforced on the platform rather than trusted to the client.
 */

// `__dirname` matches how the other suites in this package resolve the repository root; the
// package compiles to CommonJS.
const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const runId = Date.now().toString(36);

let api: ApiHandle | null = null;
let session: { email: string; password: string; token: string; organizationId: string };
/** The cookie jar, kept by hand: node's fetch has none. */
let cookies: Record<string, string> = {};

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function cookieHeader(): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function absorbSetCookie(response: Response): void {
  const setCookie = response.headers.getSetCookie?.() ?? [];
  for (const entry of setCookie) {
    const [pair] = entry.split(';');
    const index = pair!.indexOf('=');
    const name = pair!.slice(0, index).trim();
    const value = pair!.slice(index + 1).trim();
    if (value === '') delete cookies[name];
    else cookies[name] = value;
  }
}

async function call<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string | null;
    csrf?: string | null;
    origin?: string | null;
    withCookies?: boolean;
  } = {},
): Promise<{ status: number; body: Envelope<T>; response: Response }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  if (options.origin) headers.origin = options.origin;
  if (options.withCookies) headers.cookie = cookieHeader();

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  absorbSetCookie(response);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Envelope<T>) : { success: false }, response };
}

/** A user + organization created straight in the database, bypassing the closed registration. */
async function createOrgOwner(email: string, password: string): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({ data: { email, name: 'Security Suite', passwordHash, isPlatformAdmin: false } });
      const organization = await tx.organization.create({
        data: { name: `Sec Org ${email}`, slug: `sec-${runId}-${Date.now().toString(36)}` },
      });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** Another member of an existing organization, with the given role. */
async function addMember(
  organizationId: string,
  email: string,
  password: string,
  role: 'DEVELOPER' | 'REVIEWER' | 'READONLY',
): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({ data: { email, name: 'Security Member', passwordHash, isPlatformAdmin: false } });
      await tx.membership.create({ data: { organizationId, userId: user.id, role } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

beforeAll(async () => {
  api = await ensureApi(API_BASE, { root: ROOT });

  session = { email: `sec-${runId}@localehub.dev`, password: 'security-password-123', token: '', organizationId: '' };
  await createOrgOwner(session.email, session.password);

  const login = await call<{ token: string; organization: { id: string } }>('/auth/login', {
    method: 'POST',
    body: { email: session.email, password: session.password },
  });
  expect(login.status).toBeLessThan(300);
  session.token = login.body.data!.token;
  session.organizationId = login.body.data!.organization.id;
}, 180_000);

afterAll(async () => {
  await api?.stop();
});

describe('browser session cookies', () => {
  it('logs in with cookies only: no bearer token anywhere in the browser flow', async () => {
    cookies = {};
    const login = await call('/auth/login', { method: 'POST', body: { email: session.email, password: session.password } });
    expect(login.status).toBeLessThan(300);

    // The session cookie must not be readable by page JavaScript; the CSRF cookie must be.
    const raw = login.response.headers.getSetCookie?.() ?? [];
    const sessionCookie = raw.find((entry) => entry.startsWith('localehub_session='));
    const csrfCookie = raw.find((entry) => entry.startsWith('localehub_csrf='));
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toMatch(/HttpOnly/i);

    // The cookie alone authenticates: this request sends no Authorization header.
    const me = await call<{ email: string }>('/auth/me', { withCookies: true });
    expect(me.status).toBe(200);
    expect(me.body.data?.email).toBe(session.email);
  });

  it('refuses a cookie-authenticated write that carries no CSRF token', async () => {
    const created = await call<{ id: string }>('/projects', {
      method: 'POST',
      withCookies: true,
      origin: 'http://localhost:3000',
      body: { name: `csrf-probe-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
    });
    expect(created.status).toBe(403);
    expect(created.body.error?.code).toBe('CSRF_VERIFICATION_FAILED');
  });

  it('accepts the same write once the double-submit token is supplied', async () => {
    const created = await call<{ id: string }>('/projects', {
      method: 'POST',
      withCookies: true,
      csrf: cookies.localehub_csrf,
      origin: 'http://localhost:3000',
      body: { name: `csrf-ok-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
    });
    expect(created.status).toBe(201);
    expect(created.body.data?.id).toBeTruthy();
  });

  it('rejects a write from a foreign origin even with the right CSRF token', async () => {
    const created = await call('/projects', {
      method: 'POST',
      withCookies: true,
      csrf: cookies.localehub_csrf,
      origin: 'https://evil.example',
      body: { name: `csrf-origin-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
    });
    expect(created.status).toBe(403);
    expect(created.body.error?.code).toBe('CSRF_VERIFICATION_FAILED');
  });

  it('clears the cookies on logout', async () => {
    const logout = await call('/auth/logout', { method: 'POST', withCookies: true, csrf: cookies.localehub_csrf });
    expect(logout.status).toBeLessThan(300);
    expect(cookies.localehub_session).toBeUndefined();

    // Re-login for the remaining tests.
    await call('/auth/login', { method: 'POST', body: { email: session.email, password: session.password } });
  });

  it('keeps bearer credentials working for the CLI and the MCP servers', async () => {
    const me = await call<{ email: string }>('/auth/me', { token: session.token, origin: null });
    expect(me.status).toBe(200);
    expect(me.body.data?.email).toBe(session.email);
  });
});

describe('rate limiting', () => {
  it('answers with the remaining budget on every response', async () => {
    const me = await call('/auth/me', { token: session.token });
    expect(me.response.headers.get('x-ratelimit-limit')).toBeTruthy();
    expect(Number(me.response.headers.get('x-ratelimit-remaining'))).toBeGreaterThanOrEqual(0);
  });

  it('stops a login brute force with 429 once the budget is spent', async () => {
    // Read the configured budget from a first attempt rather than assuming a value, so the test
    // holds for a freshly booted API and for a long-running dev server alike.
    const probe = await call('/auth/login', { method: 'POST', body: { email: session.email, password: 'wrong-password' } });
    const limit = Number(probe.response.headers.get('x-ratelimit-limit') ?? 12);

    let last = probe;
    for (let attempt = 0; attempt <= limit; attempt += 1) {
      last = await call('/auth/login', { method: 'POST', body: { email: session.email, password: 'wrong-password' } });
      if (last.status === 429) break;
    }

    expect(last.status).toBe(429);
    expect(last.body.error?.code).toBe('RATE_LIMITED');
    expect(Number(last.response.headers.get('retry-after'))).toBeGreaterThan(0);
  }, 60_000);
});

describe('organization draft-apply policy', () => {
  it('refuses draft statuses by default, and allows them once the owner opts in', async () => {
    const project = await call<{ id: string }>('/projects', {
      method: 'POST',
      token: session.token,
      body: { name: `policy-${runId}`, sourceLocale: 'en-US', locales: ['ja-JP'] },
    });
    const projectId = project.body.data!.id;

    const before = await call(`/projects/${projectId}/sync/changes`, { token: session.token, origin: null });
    expect(before.status).toBe(200);

    const blocked = await call(`/projects/${projectId}/sync/changes?status=DRAFT`, { token: session.token, origin: null });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error?.code).toBe('POLICY_VIOLATION');
    expect(blocked.body.error?.details).toMatchObject({ policy: 'allowDraftApply' });

    const enabled = await call('/organization/settings', {
      method: 'PATCH',
      token: session.token,
      body: { allowDraftApply: true },
    });
    expect(enabled.status).toBe(200);

    const allowed = await call(`/projects/${projectId}/sync/changes?status=DRAFT`, { token: session.token, origin: null });
    expect(allowed.status).toBe(200);

    // Leave the organization as we found it.
    const disabled = await call('/organization/settings', {
      method: 'PATCH',
      token: session.token,
      body: { allowDraftApply: false },
    });
    expect(disabled.status).toBe(200);

    const blockedAgain = await call(`/projects/${projectId}/sync/changes?status=DRAFT`, { token: session.token, origin: null });
    expect(blockedAgain.status).toBe(403);
  }, 60_000);

  it('reports both policies on the session endpoint the settings page reads', async () => {
    const organization = await call<{ allowDraftApply: boolean; name: string }>('/organization', { token: session.token });
    expect(organization.status).toBe(200);
    expect(organization.body.data?.allowDraftApply).toBe(false);
  });
});

describe('MCP token permissions', () => {
  it('refuses a DEVELOPER revoking a token, which the guard alone did not', async () => {
    // `DELETE /mcp-tokens/:id` carries no project id, and the guard only applies @RequireRole when
    // one is present — so the decorator on that route decided nothing and any member could revoke
    // anybody's token in the organization. This is that hole, as an executable check.
    const email = `sec-dev-${runId}@localehub.dev`;
    const password = 'developer-password-123';
    await addMember(session.organizationId, email, password, 'DEVELOPER');

    const devLogin = await call<{ token: string }>('/auth/login', { method: 'POST', body: { email, password } });
    expect(devLogin.status).toBeLessThan(300);
    const devToken = devLogin.body.data!.token;

    const created = await call<{ id: string }>('/mcp-tokens', {
      method: 'POST',
      token: session.token,
      body: { name: 'revoke-target', scopes: ['project.read'], expiresInDays: 1 },
    });
    expect(created.status).toBe(201);
    const tokenId = created.body.data!.id;

    const refused = await call(`/mcp-tokens/${tokenId}`, { method: 'DELETE', token: devToken });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe('ROLE_INSUFFICIENT');

    // The refusal has to have actually prevented the revoke, not just returned 403.
    const list = await call<{ id: string; revokedAt: string | null }[]>('/mcp-tokens', { token: session.token });
    expect(list.body.data!.find((token) => token.id === tokenId)?.revokedAt).toBeNull();

    // And the owner still can: the check refuses a role, not everybody.
    const allowed = await call(`/mcp-tokens/${tokenId}`, { method: 'DELETE', token: session.token });
    expect(allowed.status).toBe(200);
  });
});

describe('production transport guard', () => {
  it('refuses to authenticate over plain HTTP when NODE_ENV=production', async () => {
    // A separate instance on its own port, because this switch is read per process.
    const port = 3021;
    const productionBase = `http://127.0.0.1:${port}/api/v1`;
    // The switch is read per process, so this needs its own instance. Refuse to assert against
    // someone else's server: a stray API left on this port would answer with a different verdict
    // and turn a port collision into a confusing assertion failure.
    if (await (await import('./api-harness')).apiReachable(productionBase)) {
      throw new Error(`port ${port} is already serving an API; refusing to test against an instance this suite did not start`);
    }
    const production = await ensureApi(productionBase, {
      root: ROOT,
      env: { ...process.env, NODE_ENV: 'production', API_PORT: String(port), RATE_LIMIT_ENABLED: 'false' },
      timeoutMs: 60_000,
    }).catch((error: unknown) => {
      throw new Error(`could not start a production-mode API on port ${port}: ${String(error)}`);
    });
    expect(production.spawned).toBe(true);

    try {
      // Health stays reachable: it is public, and a load balancer has to be able to poll it.
      const health = await fetch(`${productionBase}/health`);
      expect(health.ok).toBe(true);

      const me = await fetch(`${productionBase}/auth/me`, { headers: { authorization: `Bearer ${session.token}` } });
      expect(me.status).toBe(403);
      const body = (await me.json()) as Envelope<unknown>;
      expect(body.error?.code).toBe('INSECURE_TRANSPORT');
    } finally {
      await production.stop();
    }
  }, 120_000);
});
