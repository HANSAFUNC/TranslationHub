import { PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { toJsonSchema } from '@localehub/contracts';
import { API_AUTH, type ApiAuthNote } from './api-auth';

import { AuthController } from '../modules/auth/auth.controller';
import { HealthController } from '../modules/health/health.controller';
import { McpController } from '../modules/mcp/mcp.controller';
import { ContentController } from '../modules/misc/content.controller';
import { PlatformController } from '../modules/misc/platform.controller';
import { OrganizationsController } from '../modules/organizations/organizations.controller';
import { ProjectsController } from '../modules/projects/projects.controller';
import { QaController } from '../modules/qa/qa.controller';
import { SyncController } from '../modules/sync/sync.controller';
import { TokensController } from '../modules/tokens/tokens.controller';
import { TranslationsController } from '../modules/translations/translations.controller';
import { UsersController } from '../modules/users/users.controller';

/**
 * OpenAPI 3.1 document, generated from the code that enforces the API.
 *
 * The obvious approach — `@nestjs/swagger` with `@ApiBody` / `@ApiResponse` on every route — was
 * rejected: this codebase validates with `@Body(zodBody(schema))` pipes rather than DTO classes,
 * so the decorators would have to be written by hand on all 81 routes. That is a *second* place
 * describing each endpoint, and the two would drift — exactly the failure the MCP discovery
 * endpoint had, where a hand-maintained list advertised six resources no server implemented.
 *
 * So nothing is restated. The document is assembled from metadata Nest already stores:
 *
 *   - path and method from `PATH_METADATA` / `METHOD_METADATA`
 *   - `@Public()` / `@RequireRole` / `@RequireScopes` from their `SetMetadata` keys — the same
 *     values `AuthGuard` reads at request time, so the documented requirement cannot differ from
 *     the enforced one
 *   - request body and query schemas from the pipe instance on the route's arguments, which is
 *     the very `ZodValidationPipe` that validates the request
 *
 * Response bodies are the one thing not declared anywhere in this codebase (services return object
 * literals), so the document describes the envelope — `{ success, data, error }` — and leaves
 * `data` unconstrained rather than inventing a shape that nothing checks. That is a real limit,
 * stated rather than papered over.
 */

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
}

/**
 * Controllers in the order they should appear in the document.
 *
 * `OpenApiController` is deliberately absent: it serves this document, so describing it here
 * would be circular. The drift test in `__tests__/openapi.test.ts` allows exactly that one
 * omission and no other.
 */
const CONTROLLERS = [
  HealthController,
  AuthController,
  UsersController,
  OrganizationsController,
  ProjectsController,
  TranslationsController,
  SyncController,
  QaController,
  ContentController,
  PlatformController,
  TokensController,
  McpController,
];

const TAGS: Record<string, string> = {
  HealthController: '健康与系统',
  AuthController: '认证',
  UsersController: '组织成员',
  OrganizationsController: '组织设置',
  ProjectsController: '项目',
  TranslationsController: '翻译与审核',
  SyncController: '同步',
  QaController: '质量',
  ContentController: '术语、记忆、AI、审计',
  PlatformController: 'Skill、发布、导入导出',
  TokensController: 'MCP Token',
  McpController: 'MCP 发现',
};

/** Nest's `RouteParamtypes`, inlined: importing the enum drags in the whole request pipeline. */
const PARAM_BODY = 3;
const PARAM_QUERY = 4;

const REQUEST_METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

interface RouteArgument {
  index: number;
  pipes?: { schema?: unknown }[];
}

/** One route as the framework actually registered it. */
export interface RouteRecord {
  controller: string;
  handler: string;
  method: string;
  /** Express-style path including the controller prefix, e.g. `/projects/:projectId/keys`. */
  path: string;
  public: boolean;
  role: string | null;
  scopes: string[];
  /** Where the documented requirement is actually enforced. */
  enforcedBy: 'guard' | 'service' | 'authentication';
  note: string | null;
  bodySchema: Record<string, unknown> | null;
  querySchema: Record<string, unknown> | null;
  pathParams: string[];
}

function joinPath(base: string, path: string): string {
  const parts = [base, path].map((part) => String(part ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

/** Every route the framework will serve, read from the decorators that registered them. */
export function collectRoutes(): RouteRecord[] {
  const routes: RouteRecord[] = [];

  for (const controller of CONTROLLERS) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
    const prototype = controller.prototype as unknown as Record<string, unknown>;

    for (const handler of Object.getOwnPropertyNames(prototype)) {
      if (handler === 'constructor') continue;
      const fn = prototype[handler];
      if (typeof fn !== 'function') continue;

      const path = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
      const methodId = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      if (path === undefined || methodId === undefined) continue;
      const method = REQUEST_METHODS[methodId];
      if (!method) continue;

      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ?? {}) as Record<string, RouteArgument>;
      let bodySchema: Record<string, unknown> | null = null;
      let querySchema: Record<string, unknown> | null = null;
      for (const [key, argument] of Object.entries(args)) {
        // Keys are `<paramtype>:<index>:<data>`; the paramtype is what distinguishes body from query.
        const paramType = Number(key.split(':')[0]);
        const schema = argument.pipes?.find((pipe) => pipe?.schema)?.schema;
        if (!schema) continue;
        if (paramType === PARAM_BODY) bodySchema = toJsonSchema(schema);
        if (paramType === PARAM_QUERY) querySchema = toJsonSchema(schema);
      }

      const full = joinPath(String(base), String(path));
      const isPublic = Reflect.getMetadata('isPublic', fn) === true;
      const guardRole = (Reflect.getMetadata('role', fn) as string | undefined) ?? null;
      const guardScopes = (Reflect.getMetadata('scopes', fn) as string[] | undefined) ?? [];
      const declared = (Reflect.getMetadata(API_AUTH, fn) as ApiAuthNote | undefined) ?? null;

      routes.push({
        controller: controller.name,
        handler,
        method,
        path: full,
        public: isPublic,
        // A service-enforced rule is what the caller must satisfy; prefer it over the guard's
        // (absent) value so the document states the real requirement.
        role: declared?.role ?? guardRole,
        scopes: declared?.scopes ?? guardScopes,
        enforcedBy: isPublic ? 'authentication' : declared ? 'service' : guardRole || guardScopes.length ? 'guard' : 'authentication',
        note: declared?.note ?? null,
        bodySchema,
        querySchema,
        pathParams: [...full.matchAll(/:(\w+)/g)].map((match) => match[1]!),
      });
    }
  }

  return routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

/** `:projectId` -> `{projectId}`, which is what OpenAPI uses. */
function toOpenApiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}

function securityFor(route: RouteRecord): unknown[] {
  if (route.public) return [];
  // Both credentials resolve to the same actor; the document lists them as alternatives.
  return [{ bearer: [] }, { sessionCookie: [] }];
}

export function buildOpenApiDocument(options: { serverUrl?: string; version?: string } = {}): OpenApiDocument {
  const routes = collectRoutes();
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};

  schemas.ApiEnvelope = {
    type: 'object',
    required: ['success'],
    properties: {
      success: { type: 'boolean' },
      // Not constrained: response bodies are not declared anywhere in this codebase, and inventing
      // a shape here would document something nothing enforces.
      data: { description: 'Response payload. Shape varies per endpoint and is not schema-checked.' },
      error: {
        type: 'object',
        nullable: true,
        properties: {
          code: { type: 'string', description: 'Stable error code, e.g. SYNC_PLAN_EXPIRED' },
          message: { type: 'string' },
          details: { nullable: true },
          requestId: { type: 'string' },
        },
      },
    },
  };

  for (const route of routes) {
    const openApiPath = toOpenApiPath(route.path);
    const operation: Record<string, unknown> = {
      operationId: `${route.controller.replace(/Controller$/, '')}_${route.handler}`,
      tags: [TAGS[route.controller] ?? route.controller],
      summary: `${route.method.toUpperCase()} ${openApiPath}`,
      security: securityFor(route),
      responses: {
        200: {
          description: 'Envelope with `data`',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiEnvelope' } } },
        },
        401: { description: 'UNAUTHENTICATED / INVALID_TOKEN / TOKEN_EXPIRED' },
        403: { description: 'ROLE_INSUFFICIENT / SCOPE_INSUFFICIENT / PROJECT_ACCESS_DENIED' },
        404: { description: 'NOT_FOUND' },
        422: { description: 'VALIDATION_ERROR' },
      },
    };
    // Recorded so a reader — and the drift test — can see what the guard will require.
    operation['x-localehub-auth'] = {
      public: route.public,
      role: route.role,
      scopes: route.scopes,
      // `guard` = @RequireRole/@RequireScopes on the route; `service` = asserted in the handler or
      // service; `authentication` = nothing beyond a valid credential (membership + RLS scope it).
      enforcedBy: route.enforcedBy,
      ...(route.note ? { note: route.note } : {}),
    };

    const parameters: Record<string, unknown>[] = route.pathParams.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (route.querySchema) {
      for (const [name, schema] of Object.entries((route.querySchema.properties as Record<string, unknown>) ?? {})) {
        parameters.push({ name, in: 'query', required: false, schema });
      }
    }
    if (parameters.length) operation.parameters = parameters;

    if (route.bodySchema) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: route.bodySchema } },
      };
    }

    paths[openApiPath] = { ...(paths[openApiPath] ?? {}), [route.method]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'LocaleHub API',
      version: options.version ?? '0.1.0',
      description: [
        'REST API for LocaleHub. Generated from the route decorators, the guard metadata and the',
        'zod validation pipes themselves — see `apps/api/src/openapi/document.ts`.',
        '',
        'Authentication is either a bearer token (`lh_mcp_…` / `lh_api_…` / session JWT) or the',
        'browser session cookie plus the `X-CSRF-Token` double-submit header. `x-localehub-auth` on',
        'each operation records the role and scopes the guard enforces.',
      ].join('\n'),
    },
    servers: [{ url: options.serverUrl ?? '/api/v1' }],
    tags: Object.values(TAGS).map((description) => ({ name: description, description })),
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'localehub_session' },
      },
      schemas,
    },
  };
}
