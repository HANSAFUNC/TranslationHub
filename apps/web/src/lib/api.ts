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
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/**
 * Fetch a binary resource and hand back a URL an `<img>` can use.
 *
 * The sketches live behind the same authorization as everything else, and an `<img src>` pointing at
 * the API is not guaranteed to carry the credential: it depends on whether the deployment calls the
 * API on the same origin, on `SameSite`, and on CORS for images. Going through `fetch` with
 * `credentials: 'include'` is the same path every other request already takes, so it works the same
 * way in both deployments — and a failure surfaces as an error the dialog can show instead of a
 * broken-image icon.
 *
 * An SVG becomes a `data:` URL rather than an object URL. Both render identically in an `<img>`, but
 * a `blob:` URL is a *navigable same-origin document*: "open image in a new tab" on one would run any
 * script the file contains in this app's origin, with no `Content-Security-Policy` to stop it — the
 * API's sandbox header applies to the API's own URL, not to a blob made from its bytes. A `data:` URL
 * is not top-level navigable, so that door is closed for the one format that can carry script. A PNG
 * or JPEG blob cannot execute anything, so those keep the cheaper object URL.
 *
 * The caller owns an object URL and must revoke it; `useObjectUrl` does that.
 */
export async function fetchObjectUrl(path: string): Promise<string> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError('MOCKUP_IMAGE_UNAVAILABLE', `Could not load the sketch (${response.status})`, response.status);
  }
  const blob = await response.blob();
  if (!blob.type.includes('svg')) return URL.createObjectURL(blob);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ApiError('MOCKUP_IMAGE_UNAVAILABLE', 'Could not read the sketch', 0));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

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

/* --------------------------------------------------------- screen mockups */

export interface MockupSummary {
  id: string;
  name: string;
  platform: string;
  locale: string;
  width: number | null;
  height: number | null;
  mimeType: string;
  byteSize: number;
  markerCount: number;
  updatedAt: string;
  imagePath: string;
  /** Present when the list was asked about a specific key. */
  containsKey?: boolean;
}

export interface MockupMarker {
  id: string;
  key: string;
  namespace: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  text: string | null;
  note: string | null;
  /** The platform the key was found on; null when the project has no such key. */
  platform: string | null;
  /**
   * The platform's source text for this key. Null either when the key is not in the project at all
   * (`platform` is null too) or when it exists but has no source-locale version yet — use `platform`
   * to tell those apart.
   */
  source: string | null;
  entry: { entryId: string; value: string; status: string; revision: number; updatedAt: string } | null;
}

export interface MockupDetail {
  mockup: MockupSummary;
  locale: string | null;
  markers: MockupMarker[];
}
