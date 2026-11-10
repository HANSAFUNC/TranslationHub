import {
  ErrorCode,
  LocaleHubError,
  type ApiResponse,
  type ConflictRecord,
  type PlatformChange,
  type PushResult,
  type ScanBatchPayload,
  type SyncBaselineSnapshot,
  type SyncPlanPayload,
  type SyncPlanSummary,
  type SkillSourceRow,
  type SyncSessionSummaryRecord,
} from '@localehub/contracts';

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  /** default per-request timeout */
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
}

export interface SyncPreviewResponse {
  syncPlanId: string;
  planHash: string;
  expiresAt: string;
  sessionId: string;
  summary: SyncPlanSummary;
  plan: SyncPlanPayload;
  conflicts: number;
  requiresConfirmation: boolean;
}

export interface TokenInfo {
  organizationId: string;
  userId: string;
  kind: string;
  scopes: string[];
  projects: { id: string; name: string; sourceLocale: string; revision: number }[];
  connection: { id: string; name: string; lastCommit: string | null } | null;
  canPush: boolean;
  canApply: boolean;
}

export interface RemoteProjectInfo {
  id: string;
  name: string;
  slug: string;
  sourceLocale: string;
  defaultPlatform: string;
  revision: number;
  locales: { id: string; code: string; name: string; isSource: boolean; status: string }[];
  platforms: { platform: string }[];
}

export interface SyncStatusResponse {
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
  fileMappings: { fileSetId: string; platform: string; locale: string | null; format: string; paths: string[]; lastScannedAt: Date | null }[];
}

/**
 * Typed REST client for the LocaleHub API.
 *
 * Used by the CLI, the e2e demo and the integration suites. It is intentionally thin: all business
 * rules live on the server so that MCP, Web UI and API share one implementation
 * (spec §0.1.7). Every method maps server error codes back into LocaleHubError.
 */
export interface TokenRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  projectIds: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface TranslationListItem {
  entryId: string;
  key: string;
  namespace: string;
  platform: string;
  locale: string;
  value: string;
  status: string;
  revision: number;
  source: string | null;
  contentHash: string;
  appliedToRepoAt: string | null;
  updatedAt: string;
}



export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          'user-agent': `${this.options.clientName ?? 'localehub-cli'}/${this.options.clientVersion ?? '0.1.0'}`,
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      throw new LocaleHubError(
        ErrorCode.INTERNAL_ERROR,
        `Cannot reach LocaleHub at ${this.baseUrl}: ${message}. Local scanning still works; push/pull are queued for retry.`,
        503,
      );
    }
    clearTimeout(timeout);

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new LocaleHubError(ErrorCode.INTERNAL_ERROR, `Unexpected non-JSON response from ${path}`, 502, {
          status: response.status,
        });
      }
    }
    const envelope = payload as ApiResponse<T> | null;
    if (!response.ok || !envelope || envelope.success === false) {
      const error = envelope && envelope.success === false ? envelope.error : undefined;
      throw new LocaleHubError(
        (error?.code as ErrorCode) ?? ErrorCode.INTERNAL_ERROR,
        error?.message ?? `Request ${method} ${path} failed with status ${response.status}`,
        response.status,
        error?.details,
      );
    }
    return envelope.data;
  }

  /* ------------------------------------------------------------------- meta */

  tokenInfo(): Promise<TokenInfo> {
    return this.request<TokenInfo>('GET', '/mcp/token-info');
  }

  listMcpTools(): Promise<unknown> {
    return this.request('GET', '/mcp/tools');
  }

  /** Skills registered for the token's organization (rows, not the delivered form). */
  listSkills(): Promise<SkillSourceRow[]> {
    return this.request('GET', '/skills');
  }

  /* ---------------------------------------------------------------- project */

  getProject(projectId: string): Promise<RemoteProjectInfo> {
    return this.request<RemoteProjectInfo>('GET', `/projects/${projectId}`);
  }

  listLocales(projectId: string): Promise<RemoteProjectInfo['locales']> {
    return this.request('GET', `/projects/${projectId}/locales`);
  }

  syncStatus(projectId: string): Promise<SyncStatusResponse> {
    return this.request<SyncStatusResponse>('GET', `/projects/${projectId}/sync/status`);
  }

  listSessions(projectId: string): Promise<SyncSessionSummaryRecord[]> {
    return this.request('GET', `/projects/${projectId}/sync/sessions`);
  }

  /* ------------------------------------------------------------------- sync */

  uploadScan(payload: ScanBatchPayload): Promise<{ scanId: string; connectionId: string; entryCount: number; fileCount: number }> {
    return this.request('POST', '/sync/scans', payload);
  }

  previewSync(input: {
    projectId: string;
    repositoryConnectionId: string;
    scanId: string;
    direction: 'bidirectional' | 'push' | 'pull';
    baseRevision?: number;
    includeDeletes?: boolean;
    includeDrafts?: boolean;
    locales?: string[];
  }): Promise<SyncPreviewResponse> {
    return this.request<SyncPreviewResponse>('POST', '/sync/preview', {
      projectId: input.projectId,
      repositoryConnectionId: input.repositoryConnectionId,
      scanId: input.scanId,
      direction: input.direction,
      baseRevision: input.baseRevision,
      includeDeletes: input.includeDeletes ?? false,
      includeDrafts: input.includeDrafts ?? false,
      locales: input.locales,
    });
  }

  push(input: {
    syncPlanId: string;
    planHash: string;
    idempotencyKey?: string;
    client?: { name: string; version: string; gitBranch?: string; gitCommit?: string };
  }): Promise<PushResult> {
    return this.request<PushResult>(
      'POST',
      '/sync/push',
      {
        syncPlanId: input.syncPlanId,
        planHash: input.planHash,
        confirmed: true,
        client: input.client,
      },
      input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {},
    );
  }

  getChanges(input: {
    projectId: string;
    locales?: string[];
    statuses?: string[];
    sinceRevision?: number;
    limit?: number;
  }): Promise<{ changes: PlatformChange[]; revision: number }> {
    const params = new URLSearchParams();
    for (const locale of input.locales ?? []) params.append('locale', locale);
    for (const status of input.statuses ?? ['APPROVED']) params.append('status', status);
    if (input.sinceRevision !== undefined) params.set('since_revision', String(input.sinceRevision));
    if (input.limit) params.set('limit', String(input.limit));
    return this.request('GET', `/projects/${input.projectId}/sync/changes?${params.toString()}`);
  }

  getBaselines(input: {
    projectId: string;
    connectionId?: string;
    sinceRevision?: number;
    locales?: string[];
  }): Promise<{ baselines: SyncBaselineSnapshot[]; revision: number }> {
    const params = new URLSearchParams();
    if (input.connectionId) params.set('connection_id', input.connectionId);
    if (input.sinceRevision !== undefined) params.set('since_revision', String(input.sinceRevision));
    for (const locale of input.locales ?? []) params.append('locales', locale);
    return this.request('GET', `/projects/${input.projectId}/sync/baseline?${params.toString()}`);
  }

  reportApply(payload: unknown): Promise<{ baselineUpdated: number; sessionId: string }> {
    return this.request('POST', '/sync/apply-reports', payload);
  }

  /* -------------------------------------------------------------- conflicts */

  listConflicts(input: { projectId: string; status?: string; locale?: string; limit?: number }): Promise<ConflictRecord[]> {
    const params = new URLSearchParams({ projectId: input.projectId });
    if (input.status) params.set('status', input.status);
    if (input.locale) params.set('locale', input.locale);
    if (input.limit) params.set('limit', String(input.limit));
    return this.request('GET', `/sync/conflicts?${params.toString()}`);
  }

  resolveConflict(conflictId: string, input: { resolution: string; value?: string; note?: string }): Promise<ConflictRecord> {
    return this.request('POST', `/sync/conflicts/${conflictId}/resolve`, input);
  }

  /* ------------------------------------------------------------------- misc */

  validateRelease(projectId: string): Promise<{
    ok: boolean;
    revision: number;
    counts: Record<string, number>;
    issues: { code: string; severity: string; key: string; locale: string; message: string }[];
  }> {
    return this.request('POST', `/projects/${projectId}/sync/validate`);
  }

  qaIssues(projectId: string, locale?: string): Promise<{ id: string; translationKey: string; localeCode: string; ruleCode: string; severity: string; message: string }[]> {
    const params = new URLSearchParams();
    if (locale) params.set('locale', locale);
    return this.request('GET', `/projects/${projectId}/qa/issues?${params.toString()}`);
  }

  /* ------------------------------------------------ platform management helpers */

  /** Escape hatch for endpoints without a dedicated wrapper (used by the CLI and tests). */
  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body);
  }

  listProjects(): Promise<{ id: string; name: string; slug: string; sourceLocale: string; revision: number }[]> {
    return this.request('GET', '/projects');
  }

  listTokens(): Promise<TokenRecord[]> {
    return this.request('GET', '/mcp-tokens');
  }

  createToken(input: { name: string; scopes: string[]; projectIds: string[]; expiresInDays?: number }): Promise<{ id: string; token: string; tokenPrefix: string }> {
    return this.request('POST', '/mcp-tokens', { expiresInDays: 30, ...input });
  }

  revokeToken(id: string): Promise<{ id: string; revokedAt: string | null }> {
    return this.request('DELETE', `/mcp-tokens/${id}`);
  }

  findEntry(projectId: string, key: string, locale: string): Promise<TranslationListItem> {
    const params = new URLSearchParams({ key, locale });
    return this.request('GET', `/projects/${projectId}/entry-by-key?${params.toString()}`);
  }

  saveDraft(projectId: string, entryId: string, value: string, expectedRevision?: number): Promise<{ entryId: string; status: string; revision: number }> {
    return this.request('POST', `/projects/${projectId}/translations/${entryId}/draft`, { value, expectedRevision });
  }

  review(
    projectId: string,
    entryIds: string[],
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    comment?: string,
  ): Promise<{ results: { entryId: string; status: string; revision: number }[] }> {
    return this.request('POST', `/projects/${projectId}/translations/review`, { entryIds, decision, comment });
  }

  listTranslations(projectId: string, query: Record<string, string | number | undefined> = {}): Promise<{ items: TranslationListItem[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString();
    return this.request('GET', `/projects/${projectId}/translations${suffix ? `?${suffix}` : ''}`);
  }

  listStale(projectId: string): Promise<TranslationListItem[]> {
    return this.request('GET', `/projects/${projectId}/translations/stale`);
  }

  reviewQueue(projectId: string): Promise<TranslationListItem[]> {
    return this.request('GET', `/projects/${projectId}/reviews/queue`);
  }

  listConflictsRaw(projectId: string, status?: string): Promise<ConflictRecord[]> {
    const params = new URLSearchParams({ projectId });
    if (status) params.set('status', status);
    return this.request('GET', `/sync/conflicts?${params.toString()}`);
  }
}

/**
 * Platform management helpers. These are used by the CLI, the e2e demo and the integration
 * tests; the Web UI calls the same endpoints through its own fetch wrapper.
 */
