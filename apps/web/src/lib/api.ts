'use client';

/**
 * Browser API client.
 *
 * The browser authenticates with the HttpOnly `localehub_session` cookie the login endpoint sets,
 * so page JavaScript never holds a credential that an XSS bug could read out of storage. Because
 * a cookie is attached by the browser rather than by this code, every state-changing request also
 * carries the double-submit CSRF token from the readable `localehub_csrf` cookie.
 *
 * The CLI and the MCP servers keep using bearer tokens; both credentials resolve to the same
 * actor, so the UI still exercises the same authorization path as every other client.
 */

/**
 * Resolve the API origin.
 *
 * `NEXT_PUBLIC_API_BASE_URL` is inlined at build time; when it is not set the browser falls
 * back to the same origin, which is what a reverse proxy deployment (nginx `/api/`) needs.
 * Nothing else in the app hard-codes a hostname.
 */
function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  if (typeof window !== 'undefined') return `${window.location.origin}/api/v1`;
  return 'http://localhost:3001/api/v1';
}

export const API_BASE = resolveApiBase();

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const CSRF_COOKIE = 'localehub_csrf';
const CSRF_HEADER = 'x-csrf-token';

/** The readable half of the double-submit pair. Carries no authority by itself. */
function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const csrf = csrfToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    // Required for the session cookie to travel to an API on another origin (dev, and any
    // deployment that does not put both behind one hostname).
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;
  if (!response.ok || !payload || payload.success === false) {
    const error = payload?.error;
    if (response.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login')) {
      window.location.href = '/login';
    }
    throw new ApiError(
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `Request failed (${response.status})`,
      response.status,
      error?.details,
    );
  }
  return payload.data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const patch = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/* ------------------------------------------------------------------ types */

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sourceLocale: string;
  defaultPlatform: string;
  revision: number;
  counts: { keys: number; locales: number; entries: number };
  role: string | null;
}

export interface TranslationListItem {
  entryId: string;
  key: string;
  namespace: string;
  platform: string;
  locale: string;
  value: string;
  contentHash: string;
  status: string;
  revision: number;
  description: string | null;
  context: Record<string, unknown> | null;
  source: string | null;
  sourceHash: string | null;
  appliedToRepoAt: string | null;
  updatedAt: string;
}

export interface TranslationDetail extends TranslationListItem {
  sourceVersions: { id: string; version: number; value: string; contentHash: string; createdAt: string }[];
  versions: {
    id: string;
    version: number;
    value: string;
    status: string;
    authorId: string | null;
    authorType: string;
    comment: string | null;
    createdAt: string;
  }[];
  qaIssues: { id: string; ruleCode: string; severity: string; message: string; status: string }[];
}

export interface SyncStatus {
  projectId: string;
  revision: number;
  connection: {
    id: string;
    name: string;
    provider: string;
    repoUrl: string | null;
    defaultBranch: string;
    status: string;
    lastCommit: string | null;
    lastBranch: string | null;
    lastSeenAt: string | null;
    clientName: string | null;
    clientVersion: string | null;
  } | null;
  baselineCount: number;
  openConflicts: number;
  pendingPlatformChanges: number;
  latestSession: { id: string; status: string; direction: string; createdAt: string; summary: unknown } | null;
  fileMappings: {
    fileSetId: string;
    platform: string;
    locale: string | null;
    format: string;
    paths: string[];
    lastScannedAt: string | null;
  }[];
}

export interface ConflictRecord {
  id: string;
  projectId: string;
  key: string;
  locale: string;
  platform: string;
  namespace: string;
  baseValue: string | null;
  localValue: string | null;
  remoteValue: string | null;
  baseHash: string | null;
  localHash: string | null;
  remoteHash: string | null;
  reason: string;
  filePath: string | null;
  status: string;
  resolution: string | null;
  resolvedValue: string | null;
  createdAt: string;
}

export interface SyncSession {
  id: string;
  projectId: string;
  repositoryConnectionId: string | null;
  direction: string;
  status: string;
  baseRevision: number | null;
  revisionAfter: number | null;
  planHash: string | null;
  summary: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}

export interface OrganizationSettings {
  id: string;
  name: string;
  slug: string;
  allowDraftApply: boolean;
  createdAt: string;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  organizationId: string;
  role: string | null;
  organizations: { id: string; name: string; role: string }[];
}

export interface TokenRecord {
  id: string;
  name: string;
  kind: string;
  tokenPrefix: string;
  scopes: string[];
  projectIds: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
