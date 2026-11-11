import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument, collectRoutes } from '../openapi/document';

/**
 * The OpenAPI document must describe the API that exists.
 *
 * `buildOpenApiDocument` reads Nest's own metadata, so it cannot disagree with the decorators it
 * reads — but it can still miss a whole controller, because the list of controllers is written
 * out by hand in `document.ts`. That is precisely the failure this file exists to catch, and it
 * is the same one the MCP discovery endpoint had: a hand-maintained list that quietly stopped
 * matching reality.
 *
 * The checks below therefore use a *different* mechanism from the generator — they parse the
 * source and the module registration — so agreement between the two means something.
 */

const API_SRC = resolve(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.controller.ts') ? [full] : [];
  });
}

/** `(method, path)` pairs read from the decorators in the source, including the controller prefix. */
function routesFromSource(): { method: string; path: string; file: string }[] {
  const found: { method: string; path: string; file: string }[] = [];
  // `modules` only: `openapi/openapi.controller.ts` serves the document itself, and the
  // generator omits it for the same reason (see `document.ts`).
  for (const file of walk(join(API_SRC, 'modules'))) {
    const source = readFileSync(file, 'utf8');
    const base = /@Controller\(\s*'?([^')]*)'?\s*\)/.exec(source)?.[1] ?? '';
    for (const match of source.matchAll(/@(Get|Post|Patch|Put|Delete)\(\s*'?([^')]*)'?\s*\)/g)) {
      const path = `/${[base, match[2] ?? ''].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
      found.push({ method: match[1]!.toLowerCase(), path, file });
    }
  }
  return found;
}

/** Controllers Nest actually instantiates, read from the module registration. */
function controllersFromModule(): string[] {
  const source = readFileSync(join(API_SRC, 'app.module.ts'), 'utf8');
  const block = /controllers:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/(\w+Controller)/g)].map((match) => match[1]!);
}

/**
 * Turn a client path expression into something comparable with a documented path.
 *
 * The client writes `` `/projects/${projectId}/translations${suffix ? '?a=b' : ''}` ``, so the
 * template expressions — including nested ones — have to collapse to `{param}` and any query tail
 * has to go. Done by repeated innermost-first replacement rather than one regex, because the
 * expressions nest.
 */
function normaliseClientPath(raw: string): string {
  let path = raw;
  let previous = '';
  while (path !== previous) {
    previous = path;
    path = path.replace(/\$\{[^{}]*\}/g, '{param}');
  }
  // Anything left is a template expression too complex to reduce (a conditional query tail).
  path = path.split('?')[0]!.replace(/\$\{.*$/, '');
  return `/${path.replace(/^\/+|\/+$/g, '')}`;
}

describe('OpenAPI document', () => {
  it('describes every route the controllers declare, and nothing else', () => {
    const documented = new Set(collectRoutes().map((route) => `${route.method} ${route.path}`));
    const source = routesFromSource();
    const actual = new Set(source.map((route) => `${route.method} ${route.path}`));

    const missing = [...actual].filter((key) => !documented.has(key));
    const phantom = [...documented].filter((key) => !actual.has(key));
    expect(missing, 'routes declared in a controller but absent from the document').toEqual([]);
    expect(phantom, 'routes in the document that no controller declares').toEqual([]);
  });

  it('covers every controller the application registers', () => {
    const registered = new Set(controllersFromModule());
    // `buildOpenApiDocument` walks a hand-written list; a controller added to the module but not
    // to that list would silently vanish from the document.
    const documentedControllers = new Set(collectRoutes().map((route) => route.controller));
    // The document endpoint describes the API; it is not a resource of the API being described.
    // Documenting it would be circular, so it is the one controller allowed to be absent.
    const forgotten = [...registered].filter((name) => name !== 'OpenApiController' && !documentedControllers.has(name));
    expect(forgotten, 'controllers registered in app.module.ts but missing from the OpenAPI walk').toEqual([]);
  });

  it('is a valid OpenAPI 3.1 document with the expected shape', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBeTruthy();
    expect(Object.keys(document.paths).length).toBeGreaterThan(50);

    for (const [path, operations] of Object.entries(document.paths)) {
      // Path templates use `{name}`, never Express's `:name` — clients cannot read the latter.
      expect(path, 'path must use OpenAPI templating').not.toMatch(/:/);
      for (const [method, operation] of Object.entries(operations as Record<string, Record<string, unknown>>)) {
        expect(['get', 'post', 'put', 'patch', 'delete']).toContain(method);
        expect(operation.operationId, `${method} ${path} has no operationId`).toBeTruthy();
        expect(operation.responses).toBeTruthy();
        // Every path parameter in the URL must be declared, or generated clients break.
        for (const name of [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)) {
          const parameters = (operation.parameters as { name: string; in: string }[] | undefined) ?? [];
          expect(
            parameters.some((parameter) => parameter.in === 'path' && parameter.name === name),
            `${method} ${path} does not declare path parameter ${name}`,
          ).toBe(true);
        }
      }
    }
  });

  it('states where each route’s authorization is enforced', () => {
    const routes = collectRoutes();
    // A route that is neither public nor guarded by metadata must say so explicitly rather than
    // leaving `role: null` to be read as "any member may do this".
    for (const route of routes) {
      expect(['guard', 'service', 'authentication']).toContain(route.enforcedBy);
      if (route.public) expect(route.enforcedBy).toBe('authentication');
    }

    // The routes whose rules live in the service must carry the note, since the guard metadata is
    // empty for them and the document would otherwise understate the requirement.
    const annotated = routes.filter((route) => route.enforcedBy === 'service').map((route) => route.path);
    for (const path of ['/organization/members', '/organization/members/:userId', '/organization/settings', '/projects']) {
      expect(annotated, `${path} should record its service-enforced requirement`).toContain(path);
    }
  });

  it('keeps the committed docs/openapi.json up to date', () => {
    // The document is committed so clients can generate from it without running the API. A copy
    // that silently describes an older API is worse than no copy, so it must regenerate exactly.
    // Regenerate with: pnpm --filter @localehub/api openapi
    // Compared in full, not just by path list: a changed schema or a changed role would slip
    // through a structural-only check, and those are exactly the parts a client relies on.
    const committed = JSON.parse(readFileSync(resolve(API_SRC, '../../../docs/openapi.json'), 'utf8'));
    const fresh = buildOpenApiDocument({ serverUrl: '/api/v1' });
    expect(fresh, 'docs/openapi.json is stale — run `pnpm --filter @localehub/api openapi`').toEqual(committed);
  });

  it('covers every endpoint the TypeScript client calls', () => {
    // Spec §8.4 asks for OpenAPI plus a TypeScript client. The client is still hand-written (its
    // method bodies map onto real HTTP calls), so the useful assertion is that every endpoint it
    // calls exists in the document — a client method pointing at a route that was renamed or
    // removed is a runtime 404 that the types cannot catch.
    const clientSource = readFileSync(resolve(API_SRC, '../../../packages/api-client/src/index.ts'), 'utf8');
    const document = buildOpenApiDocument();

    const calls = [...clientSource.matchAll(/this\.request(?:Impl)?(?:<[^>]*>)?\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*[`']([^`']+)/g)].map(
      (match) => ({
        method: match[1]!.toLowerCase(),
        path: normaliseClientPath(match[2]!),
      }),
    );
    expect(calls.length, 'no client calls parsed — did the client change shape?').toBeGreaterThan(20);

    const declared = new Set(
      Object.entries(document.paths).flatMap(([path, operations]) =>
        Object.keys(operations as Record<string, unknown>).map((method) => {
          const normalised = path.replace(/\{[^}]+\}/g, '{param}');
          return `${method} ${normalised}`;
        }),
      ),
    );

    const unmatched = calls
      .map((call) => `${call.method} ${call.path}`)
      .filter((key) => !declared.has(key));
    expect(unmatched, 'client calls with no matching documented route').toEqual([]);
  });

  it('carries the request schemas the validation pipe actually applies', () => {
    const routes = collectRoutes();
    const create = routes.find((route) => route.path === '/projects' && route.method === 'post')!;
    expect(create.bodySchema).toBeTruthy();
    expect(JSON.stringify(create.bodySchema)).toContain('sourceLocale');

    // A body-less write route must not invent a request body.
    const logout = routes.find((route) => route.path === '/auth/logout')!;
    expect(logout.bodySchema).toBeNull();
  });
});
