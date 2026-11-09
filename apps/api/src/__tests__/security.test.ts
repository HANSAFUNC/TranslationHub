import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { LocaleHubError } from '@localehub/contracts';
import type { ActorContext } from '@localehub/permissions';
import { RateLimitGuard, RateLimitService } from '../common/rate-limit';
import { CsrfGuard } from '../common/csrf';

/**
 * Unit coverage for the request-level security baseline: rate limiting and CSRF verification.
 * Both are pure decision functions over (request, response), so they are driven here with fake
 * execution contexts; the end-to-end behaviour is covered by the integration suite.
 */

interface FakeRequest {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | undefined>;
  cookies?: Record<string, string>;
  ip?: string;
  protocol?: string;
  socket?: { remoteAddress?: string };
  actor?: ActorContext;
  body?: { email?: string };
}

interface FakeResponse {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

function context(request: FakeRequest, response: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function request(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    method: 'GET',
    path: '/api/v1/projects',
    url: '/api/v1/projects',
    headers: {},
    ip: '203.0.113.7',
    protocol: 'http',
    ...overrides,
  };
}

function response(): FakeResponse {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
  };
}

function userActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: 'user',
    userId: 'user-1',
    organizationId: 'org-1',
    orgRole: null,
    projectRoles: {},
    scopes: [],
    actorType: 'user',
    credentialSource: 'bearer',
    ...overrides,
  };
}

/**
 * A limiter that keeps real counters but never touches Redis, so the tests exercise the guard's
 * bucketing rather than the client library.
 */
class CountingLimiter extends RateLimitService {
  readonly calls: { scope: string; key: string; max: number }[] = [];

  override async check(rule: { scope: string; windowSeconds: number; max: number }, key: string) {
    this.calls.push({ scope: rule.scope, key, max: rule.max });
    const seen = this.calls.filter((call) => call.scope === rule.scope && call.key === key).length;
    return { allowed: seen <= rule.max, remaining: Math.max(0, rule.max - seen), resetAt: Date.now() + 60_000 };
  }
}

const original = { ...process.env };

describe('RateLimitGuard', () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_AUTH_MAX = '2';
    process.env.RATE_LIMIT_WINDOW_SECONDS = '60';
  });

  it('allows requests under the limit and advertises the budget', async () => {
    const limiter = new CountingLimiter();
    const guard = new RateLimitGuard(limiter);
    const res = response();

    await expect(guard.canActivate(context(request({ actor: userActor() }), res))).resolves.toBe(true);
    expect(res.headers['x-ratelimit-limit']).toBe('3');
    expect(res.headers['x-ratelimit-remaining']).toBe('2');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('rejects with RATE_LIMITED and Retry-After once the budget is spent', async () => {
    const limiter = new CountingLimiter();
    const guard = new RateLimitGuard(limiter);
    const actor = userActor();

    for (let i = 0; i < 3; i += 1) {
      await guard.canActivate(context(request({ actor }), response()));
    }

    const res = response();
    const error = await guard.canActivate(context(request({ actor }), res)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocaleHubError);
    expect((error as LocaleHubError).code).toBe('RATE_LIMITED');
    expect((error as LocaleHubError).status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('gives every actor its own budget instead of sharing one bucket per IP', async () => {
    const limiter = new CountingLimiter();
    const guard = new RateLimitGuard(limiter);

    for (let i = 0; i < 3; i += 1) {
      await guard.canActivate(context(request({ actor: userActor({ userId: 'user-a' }) }), response()));
    }

    // Same IP, different user: must still be allowed. One office, or a CI runner executing the
    // acceptance suite and the demo back to back, shares an egress IP.
    await expect(guard.canActivate(context(request({ actor: userActor({ userId: 'user-b' }) }), response()))).resolves.toBe(true);
  });

  it('separates MCP tokens from their owner’s interactive session', async () => {
    const limiter = new CountingLimiter();
    const guard = new RateLimitGuard(limiter);

    await guard.canActivate(context(request({ actor: userActor({ kind: 'mcp', mcpClientId: 'client-1' }) }), response()));
    await guard.canActivate(context(request({ actor: userActor({ userId: 'user-1' }) }), response()));

    expect(limiter.calls.map((call) => call.key)).toEqual(['token:client-1', 'user:user-1']);
  });

  it('brute-forcing one account is blocked even from the same IP', async () => {
    const limiter = new CountingLimiter();
    const guard = new RateLimitGuard(limiter);
    const login = request({
      method: 'POST',
      path: '/api/v1/auth/login',
      ip: '198.51.100.9',
      body: { email: 'victim@example.com' },
    } as Partial<FakeRequest>);

    await guard.canActivate(context(login, response()));
    await guard.canActivate(context(login, response()));
    await expect(guard.canActivate(context(login, response()))).rejects.toBeInstanceOf(LocaleHubError);

    const accountBucket = limiter.calls.find((call) => call.scope === 'auth:account:/api/v1/auth/login');
    expect(accountBucket?.max).toBe(2);
    expect(accountBucket?.key).toBe('198.51.100.9|victim@example.com');
  });

  it('does not let one victim’s failed logins lock out everyone behind the same NAT', async () => {
    const limiter = new CountingLimiter();
    const guard = new RateLimitGuard(limiter);
    const base = { method: 'POST', path: '/api/v1/auth/login', ip: '198.51.100.9' };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await guard
        .canActivate(context(request({ ...base, body: { email: 'victim@example.com' } } as Partial<FakeRequest>), response()))
        .catch(() => undefined);
    }

    // Same IP, different account: the per-account bucket is untouched.
    await expect(
      guard.canActivate(
        context(request({ ...base, body: { email: 'coworker@example.com' } } as Partial<FakeRequest>), response()),
      ),
    ).resolves.toBe(true);
  });

  it('can be switched off for an environment that limits elsewhere', async () => {
    process.env.RATE_LIMIT_ENABLED = 'false';
    const limiter = new CountingLimiter();
    const guard = new RateLimitGuard(limiter);
    const login = request({ method: 'POST', path: '/api/v1/auth/login' });

    for (let i = 0; i < 5; i += 1) {
      await guard.canActivate(context(login, response()));
    }
    expect(limiter.calls).toHaveLength(0);
  });

  afterEach(() => {
    process.env = { ...original };
  });
});

describe('RateLimitService window semantics', () => {
  afterEach(() => {
    process.env = { ...original };
  });

  it('counts within a window and starts a fresh one after it elapses', async () => {
    process.env.REDIS_URL = '';
    const limiter = new RateLimitService();
    const rule = { scope: 'test', windowSeconds: 1, max: 2 };
    vi.useFakeTimers();
    try {
      expect((await limiter.check(rule, 'k')).allowed).toBe(true);
      expect((await limiter.check(rule, 'k')).allowed).toBe(true);
      expect((await limiter.check(rule, 'k')).allowed).toBe(false);

      vi.advanceTimersByTime(1_100);
      expect((await limiter.check(rule, 'k')).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps counters per key', async () => {
    process.env.REDIS_URL = '';
    const limiter = new RateLimitService();
    const rule = { scope: 'test', windowSeconds: 60, max: 1 };

    expect((await limiter.check(rule, 'a')).allowed).toBe(true);
    expect((await limiter.check(rule, 'a')).allowed).toBe(false);
    expect((await limiter.check(rule, 'b')).allowed).toBe(true);
  });
});

describe('CsrfGuard', () => {
  beforeEach(() => {
    process.env.CORS_ORIGINS = 'http://localhost:3000';
  });

  it('lets safe methods through untouched', () => {
    const guard = new CsrfGuard();
    const req = request({ method: 'GET', actor: userActor({ credentialSource: 'cookie' }) });
    expect(guard.canActivate(context(req, response()))).toBe(true);
  });

  it('requires the double-submit token for cookie-authenticated writes', () => {
    const guard = new CsrfGuard();
    const req = request({
      method: 'POST',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3001' },
      cookies: { localehub_csrf: 'token-value' },
      actor: userActor({ credentialSource: 'cookie' }),
    });
    expect(() => guard.canActivate(context(req, response()))).toThrowError(/x-csrf-token/);

    req.headers['x-csrf-token'] = 'token-value';
    expect(guard.canActivate(context(req, response()))).toBe(true);
  });

  it('rejects a mismatched double-submit token', () => {
    const guard = new CsrfGuard();
    const req = request({
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'x-csrf-token': 'attacker-value' },
      cookies: { localehub_csrf: 'token-value' },
      actor: userActor({ credentialSource: 'cookie' }),
    });
    expect(() => guard.canActivate(context(req, response()))).toThrowError(/x-csrf-token/);
  });

  it('rejects a write whose Origin is not part of this deployment', () => {
    const guard = new CsrfGuard();
    const req = request({
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      actor: userActor({ credentialSource: 'bearer' }),
    });
    const error = (() => {
      try {
        guard.canActivate(context(req, response()));
        return null;
      } catch (caught) {
        return caught as LocaleHubError;
      }
    })();
    expect(error?.code).toBe('CSRF_VERIFICATION_FAILED');
  });

  it('accepts the API’s own origin even when CORS_ORIGINS only lists the web app', () => {
    const guard = new CsrfGuard();
    const req = request({
      method: 'POST',
      headers: { origin: 'http://localhost:3001', host: 'localhost:3001' },
      actor: userActor({ credentialSource: 'bearer' }),
    });
    expect(guard.canActivate(context(req, response()))).toBe(true);
  });

  it('leaves non-browser callers alone: a bearer request without Origin is fine', () => {
    const guard = new CsrfGuard();
    const req = request({ method: 'POST', actor: userActor({ credentialSource: 'bearer' }) });
    expect(guard.canActivate(context(req, response()))).toBe(true);
  });

  it('accepts a Referer when Origin is absent', () => {
    const guard = new CsrfGuard();
    const req = request({
      method: 'DELETE',
      headers: { referer: 'http://localhost:3000/projects/abc' },
      actor: userActor({ credentialSource: 'bearer' }),
    });
    expect(guard.canActivate(context(req, response()))).toBe(true);
  });

  afterEach(() => {
    process.env = { ...original };
  });
});
