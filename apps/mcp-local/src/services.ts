import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErrorCode,
  LocaleHubError,
  contentHash,
  comparePlaceholders,
  type ApplyReportRequest,
  type ConflictRecord,
  type ConflictResolution,
  type PlatformChange,
  type PushResult,
} from '@localehub/contracts';
import { ApiClient, type SyncPreviewResponse } from '@localehub/api-client';
import {
  GitClient,
  SafeFileWriter,
  WorkspaceGuard,
  loadLocalConfig,
  resolveToken,
  scanWorkspace,
  walkWorkspace,
  type LoadedConfig,
  type ScanResult,
} from '@localehub/workspace';
import { globToRegExp } from '@localehub/contracts';
import type { ApplyPlan } from '@localehub/sync-engine';
import { executeApply, planApply, toApplyReportPayload } from './apply';
import { scanAndCollect, type ScanSummary } from './scan';
import { StateStore } from './state';

export interface ToolContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ToolResult {
  [key: string]: unknown;
}

/**
 * Local MCP tool implementations.
 *
 * Every tool that touches the network or the filesystem goes through:
 *   - WorkspaceGuard (path allowlists, symlink checks)
 *   - SafeFileWriter (backup + atomic write + re-parse)
 *   - the platform API (single source of business truth)
 * No tool commits or pushes git on its own.
 */
export class LocalMcpServices {
  private loaded: LoadedConfig | null = null;
  private guard: WorkspaceGuard | null = null;
  private api: ApiClient | null = null;
  private state: StateStore | null = null;
  private lastScan: { result: ScanResult; summary: ScanSummary; payload: { projectId: string; scanId: string } } | null = null;

  constructor(private readonly context: ToolContext = { cwd: process.cwd(), env: process.env }) {}

  /* -------------------------------------------------------------- bootstrap */

  config(): LoadedConfig {
    if (!this.loaded) this.loaded = loadLocalConfig(this.context.cwd);
    return this.loaded;
  }

  workspace(): WorkspaceGuard {
    if (!this.guard) this.guard = new WorkspaceGuard(this.config().config, this.config().root);
    return this.guard;
  }

  store(): StateStore {
    if (!this.state) this.state = new StateStore(this.workspace().root);
    return this.state;
  }

  git(): GitClient {
    return new GitClient(this.workspace().root);
  }

  client(): ApiClient {
    if (!this.api) {
      const config = this.config().config;
      const token = resolveToken(config, this.context.env);
      this.api = new ApiClient({
        baseUrl: config.localehub.apiUrl.replace(/\/api\/v1$/, '') + '/api/v1',
        token,
        clientName: 'localehub-local-mcp',
        clientVersion: '0.1.0',
      });
    }
    return this.api;
  }

  projectId(explicit?: string): string {
    return explicit ?? this.config().config.project.id;
  }

  clientInfo(): { name: string; version: string; gitBranch?: string; gitCommit?: string } {
    const git = this.git();
    const info = git.info();
    return {
      name: 'localehub-local-mcp',
      version: '0.1.0',
      ...(info.branch ? { gitBranch: info.branch } : {}),
      ...(info.commit ? { gitCommit: info.commit } : {}),
    };
  }

  /* --------------------------------------------------- get_local_project_info */

  async getLocalProjectInfo(): Promise<ToolResult> {
    const loaded = this.config();
    const guard = this.workspace();
    const git = this.git();
    const info = git.info();
    const state = this.store().get();
    return {
      configPath: loaded.configPath,
      workspaceRoot: guard.root,
      project: {
        id: loaded.config.project.id,
        name: loaded.config.project.name ?? null,
        sourceLocale: loaded.config.project.sourceLocale,
        platforms: loaded.config.project.platforms ?? [],
      },
      apiUrl: loaded.config.localehub.apiUrl,
      tokenEnv: loaded.tokenEnv,
      fileMappings: loaded.config.files.map((mapping) => ({
        id: mapping.id,
        platform: mapping.platform,
        locale: mapping.locale ?? (mapping.localeFromPath ? '<from path>' : '*'),
        format: mapping.format,
        source: mapping.source === true,
        paths: mapping.paths,
      })),
      workspacePolicy: {
        allowRead: loaded.config.workspace.allowRead,
        allowWrite: loaded.config.workspace.allowWrite,
        denyRead: loaded.config.workspace.denyRead,
        denyWrite: loaded.config.workspace.denyWrite,
      },
      syncPolicy: loaded.config.sync,
      git: {
        isRepository: info.isRepository,
        branch: info.branch,
        commit: info.commit,
        shortCommit: info.shortCommit,
        dirty: info.dirty,
        changedFiles: info.changedFiles.slice(0, 50),
      },
      validation: loaded.validation,
      lastScanId: state.lastScanId,
      lastPreview: state.lastPreview,
      pendingApplyPlans: state.pendingApplyPlans.map((plan) => ({
        applyPlanId: plan.applyPlanId,
        expiresAt: plan.expiresAt,
        ready: plan.summary.ready,
        blocked: plan.summary.blocked,
      })),
    };
  }

  /* ------------------------------------------------------ scan_local_project */

  async scanLocalProject(input: { project_id?: string; file_set_ids?: string[] } = {}): Promise<ToolResult> {
    const projectId = this.projectId(input.project_id);
    const guard = this.workspace();
    const scanId = `scan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const config = this.config().config;
    const { result, summary, payload } = await scanAndCollect(guard, {
      projectId,
      sourceLocale: config.project.sourceLocale,
      fileSetIds: input.file_set_ids,
      scanId,
      client: this.clientInfo(),
    });

    // Upload the scan so the platform can compute the three-way comparison.
    let uploaded: { connectionId: string } | null = null;
    let uploadError: string | null = null;
    try {
      const response = await this.client().uploadScan(payload);
      uploaded = { connectionId: response.connectionId };
      this.store().patch({ projectId, connectionId: response.connectionId, lastScanId: scanId, lastScanAt: new Date().toISOString() });
    } catch (error) {
      uploadError = error instanceof Error ? error.message : String(error);
    }

    this.lastScan = { result, summary, payload: { projectId, scanId } };
    this.store().record('scan_local_project', `${summary.filesScanned} files, ${summary.entriesFound} entries`);

    return {
      ...summary,
      uploaded: uploaded !== null,
      uploadError,
      connectionId: uploaded?.connectionId ?? null,
      localOnly: uploaded === null,
      hint: uploaded
        ? 'Scan uploaded. Call preview_sync to compute the three-way diff.'
        : 'Scan works offline. Start the API and re-run scan_local_project before push/pull.',
    };
  }

  /* ----------------------------------------------------- read_project_context */

  /**
   * Read source files for context. Strictly read-only, restricted to `workspace.allowRead`,
   * and never uploaded anywhere by this call (spec §0.3: code context is read on demand).
   */
  async readProjectContext(input: { glob: string; max_files: number; max_bytes_per_file: number }): Promise<ToolResult> {
    const guard = this.workspace();
    const matcher = globToRegExp(input.glob);
    const candidates = walkWorkspace(guard.root).filter((file) => matcher.test(file));
    const allowed: string[] = [];
    const denied: { file: string; reason: string }[] = [];
    for (const file of candidates) {
      try {
        guard.assertReadable(file);
        allowed.push(file);
      } catch (error) {
        denied.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    const selected = allowed.slice(0, input.max_files);
    const files = selected.map((file) => {
      const content = readFileSync(guard.absolute(file), 'utf8');
      const truncated = Buffer.byteLength(content, 'utf8') > input.max_bytes_per_file;
      return { file, excerpt: truncated ? content.slice(0, input.max_bytes_per_file) : content, truncated };
    });
    return {
      files,
      matched: candidates.length,
      allowed: allowed.length,
      denied: denied.slice(0, 20),
      note: 'Context is read locally only. It is never uploaded unless the user explicitly asks for it.',
    };
  }

  /* -------------------------------------------------------- get_remote_project */

  async getRemoteProject(input: { project_id?: string } = {}): Promise<ToolResult> {
    const projectId = this.projectId(input.project_id);
    const [project, status] = await Promise.all([this.client().getProject(projectId), this.client().syncStatus(projectId)]);
    return { project, syncStatus: status };
  }

  /* ------------------------------------------------------------- preview_sync */

  async previewSync(input: {
    project_id?: string;
    direction?: 'bidirectional' | 'push' | 'pull';
    scan_id?: string;
    include_deletes?: boolean;
    include_drafts?: boolean;
    file_set_ids?: string[];
    locales?: string[];
  }): Promise<ToolResult> {
    const projectId = this.projectId(input.project_id);
    const scanId = input.scan_id ?? this.lastScan?.summary.scanId ?? this.store().get().lastScanId;
    if (!scanId) {
      throw new LocaleHubError(ErrorCode.NOT_FOUND, 'No scan available. Call scan_local_project first.', 400);
    }

    const status = await this.client().syncStatus(projectId);
    const connectionId = status.connection?.id ?? this.store().get().connectionId;
    if (!connectionId) {
      throw new LocaleHubError(
        ErrorCode.NOT_FOUND,
        'No repository connection yet. Run scan_local_project once so the platform can register this repository.',
        400,
      );
    }

    const preview: SyncPreviewResponse = await this.client().previewSync({
      projectId,
      repositoryConnectionId: connectionId,
      scanId,
      direction: input.direction ?? 'bidirectional',
      includeDeletes: input.include_deletes ?? false,
      includeDrafts: input.include_drafts ?? false,
      locales: input.locales,
    });

    this.store().patch({
      lastPreview: {
        syncPlanId: preview.syncPlanId,
        planHash: preview.planHash,
        sessionId: preview.sessionId,
        expiresAt: preview.expiresAt,
        summary: preview.summary as unknown as Record<string, number>,
        createdAt: new Date().toISOString(),
      },
      lastRevision: status.revision,
    });
    this.store().record('preview_sync', `plan ${preview.syncPlanId}`);

    return {
      syncPlanId: preview.syncPlanId,
      planHash: preview.planHash,
      sessionId: preview.sessionId,
      expiresAt: preview.expiresAt,
      summary: preview.summary,
      requiresConfirmation: true,
      changes: preview.plan.items.map((item) => ({
        changeId: item.changeId,
        action: item.action,
        key: item.identity.key,
        namespace: item.identity.namespace,
        locale: item.identity.locale,
        platform: item.identity.platform,
        filePath: item.diff.filePath,
        base: item.diff.baseValue,
        local: item.diff.localValue,
        platformValue: item.diff.remoteValue,
        reason: item.diff.reason,
        conflictReason: item.diff.conflictReason ?? null,
        reviewStatus: item.diff.reviewStatus,
        remoteApplyEligible: item.diff.remoteApplyEligible,
      })),
      nextStep:
        preview.summary.pushNew + preview.summary.pushUpdated > 0
          ? 'Show this list to the user. Call push_project_changes with confirm=true only after they approve.'
          : 'Nothing to push. Call pull_platform_updates to fetch approved platform changes.',
    };
  }

  /* ---------------------------------------------------- push_project_changes */

  async pushProjectChanges(input: { preview_id?: string; sync_plan_id?: string; confirm?: boolean; idempotency_key?: string; include_deletes?: boolean }): Promise<ToolResult> {
    const state = this.store().get();
    const preview = state.lastPreview;
    const planId = input.sync_plan_id ?? input.preview_id ?? preview?.syncPlanId;
    if (!planId || !preview || preview.syncPlanId !== planId) {
      throw new LocaleHubError(
        ErrorCode.SYNC_PLAN_NOT_FOUND,
        'No matching preview found. Call preview_sync first, show the plan to the user, then push with that plan id.',
        409,
      );
    }
    if (!input.confirm) {
      return {
        requiresConfirmation: true,
        syncPlanId: planId,
        planHash: preview.planHash,
        summary: preview.summary,
        message: 'Not pushed. Re-run with confirm=true after the user explicitly approves this plan.',
      };
    }

    const idempotencyKey =
      input.idempotency_key ??
      `repo-${this.store().get().connectionId ?? 'conn'}-${this.clientInfo().gitCommit ?? 'nocommit'}-${preview.planHash.slice(0, 16)}`;

    const result: PushResult = await this.client().push({
      syncPlanId: planId,
      planHash: preview.planHash,
      idempotencyKey,
      client: this.clientInfo(),
    });

    this.store().patch({
      lastRevision: result.revision,
      lastPreview: { ...preview, summary: result.summary as unknown as Record<string, number> },
    });
    this.store().record('push_project_changes', `${result.summary.created} created, ${result.summary.updated} updated`);

    return {
      syncSessionId: result.syncSessionId,
      status: result.status,
      revision: result.revision,
      idempotentReplay: result.idempotentReplay,
      summary: result.summary,
      accepted: result.accepted,
      conflicts: result.conflicts,
      failed: result.failed,
      nextStep:
        result.summary.conflicts > 0
          ? 'Some entries conflict. Use resolve_sync_conflict or fix them on the platform, then preview again.'
          : 'Push complete. On the platform, edit and approve translations, then call pull_platform_updates.',
    };
  }

  /* ------------------------------------------------- pull_platform_updates */

  async pullPlatformUpdates(input: {
    project_id?: string;
    locales?: string[];
    statuses?: string[];
    since_revision?: string | number;
    include_drafts?: boolean;
    limit?: number;
  } = {}): Promise<ToolResult> {
    const projectId = this.projectId(input.project_id);
    const statuses = input.include_drafts ? [...(input.statuses ?? ['APPROVED']), 'DRAFT', 'PENDING_REVIEW'] : input.statuses ?? ['APPROVED'];
    // Default window = everything the platform recorded after our last successful push/apply.
    // Passing an explicit since_revision always wins (recovery from a missed event).
    const sinceRevision =
      input.since_revision !== undefined ? Number(input.since_revision) : (this.store().get().lastRevision ?? undefined);

    const { changes, revision } = await this.client().getChanges({
      projectId,
      locales: input.locales,
      statuses,
      sinceRevision,
      limit: input.limit ?? 500,
    });

    this.store().record('pull_platform_updates', `${changes.length} change(s)`);

    return {
      revision,
      count: changes.length,
      changes: changes.map((change) => ({
        entryId: change.entryId,
        key: change.key,
        namespace: change.namespace,
        locale: change.locale,
        platform: change.platform,
        current: change.content,
        previous: change.previousContent,
        reviewStatus: change.reviewStatus,
        translationVersionId: change.translationVersionId,
        remoteRevision: change.remoteRevision,
        appliedToRepo: change.appliedToRepo,
        contentHash: change.contentHash,
      })),
      nextStep: changes.length
        ? 'Call preview_apply to see the exact file/key diff. Nothing has been written yet.'
        : 'No approved platform changes to pull.',
    };
  }

  /* ------------------------------------------------------------- preview_apply */

  async previewApply(input: { project_id?: string; change_ids?: string[]; dry_run?: boolean; create_backup?: boolean; include_drafts?: boolean } = {}): Promise<ToolResult> {
    const projectId = this.projectId(input.project_id);
    const guard = this.workspace();
    const config = this.config().config;

    const { changes } = await this.client().getChanges({
      projectId,
      statuses: input.include_drafts ? ['APPROVED', 'DRAFT', 'PENDING_REVIEW'] : ['APPROVED'],
      limit: 2000,
    });
    // A change that is already in the repository must not be offered again.
    const pending = changes.filter((change) => !change.appliedToRepo);
    const selected = input.change_ids?.length ? pending.filter((change) => input.change_ids!.includes(changeKeyId(change))) : pending;

    const scan = await scanWorkspace(guard, { projectId, sourceLocale: config.project.sourceLocale });
    const plan = planApply({
      guard,
      projectId,
      createBackup: input.create_backup ?? config.sync.createBackup,
      preserveUnknownFields: config.sync.preserveUnknownFields,
      includeDrafts: input.include_drafts ?? false,
      scan,
      changes: selected,
    });

    this.store().storeApplyPlan(plan);
    this.store().record('preview_apply', `${plan.summary.ready} ready / ${plan.summary.total}`);

    return {
      applyPlanId: plan.applyPlanId,
      expiresAt: plan.expiresAt,
      dryRun: input.dry_run !== false,
      summary: plan.summary,
      files: plan.files,
      changes: plan.items.map((item) => ({
        changeId: item.changeId,
        key: item.identity.key,
        locale: item.identity.locale,
        filePath: item.filePath,
        status: item.status,
        reason: item.reason,
        previousValue: item.previousValue,
        newValue: item.newValue,
        reviewStatus: item.reviewStatus,
        translationVersionId: item.translationVersionId,
      })),
      requiresConfirmation: true,
      riskWarning: input.include_drafts
        ? 'include_drafts=true: unapproved translations are part of this plan. Writing them replaces approved copy with draft text.'
        : null,
      nextStep: plan.summary.ready
        ? 'Show the per-file diff to the user. Call apply_translation_updates with confirm=true only after they approve.'
        : 'Nothing can be applied. See the blocked reasons (stale local value, drafts, or already applied).',
    };
  }

  /* ------------------------------------------- apply_translation_updates */

  async applyTranslationUpdates(input: { apply_plan_id: string; confirm?: boolean; require_clean_worktree?: boolean; create_backup?: boolean }): Promise<ToolResult> {
    const store = this.store();
    const plan: ApplyPlan | null = store.getApplyPlan(input.apply_plan_id);
    if (!plan) {
      throw new LocaleHubError(ErrorCode.SYNC_PLAN_NOT_FOUND, `Unknown apply plan ${input.apply_plan_id}. Call preview_apply first.`, 404);
    }
    if (new Date(plan.expiresAt).getTime() <= Date.now()) {
      throw new LocaleHubError(ErrorCode.SYNC_PLAN_EXPIRED, `Apply plan expired at ${plan.expiresAt}. Re-run preview_apply.`, 409);
    }
    if (!input.confirm) {
      return {
        requiresConfirmation: true,
        applyPlanId: plan.applyPlanId,
        ready: plan.summary.ready,
        blocked: plan.summary.blocked,
        files: plan.files,
        message: 'Nothing written. Re-run with confirm=true after the user explicitly approves this diff.',
      };
    }

    const config = this.config().config;
    const git = this.git();
    const info = git.info();
    if (input.require_clean_worktree && info.isRepository && info.dirty) {
      throw new LocaleHubError(
        ErrorCode.APPLY_REJECTED_STALE_PREVIEW,
        `Working tree is dirty (${info.changedFiles.length} file(s)). Commit or stash first, or run with require_clean_worktree=false.`,
        409,
        { changedFiles: info.changedFiles },
      );
    }

    const guard = this.workspace();
    const writer = new SafeFileWriter(guard);
    const scan = await scanWorkspace(guard, { projectId: plan.projectId, sourceLocale: config.project.sourceLocale });

    const report = await executeApply(
      {
        guard,
        writer,
        git,
        projectId: plan.projectId,
        createBackup: input.create_backup ?? config.sync.createBackup,
        preserveUnknownFields: config.sync.preserveUnknownFields,
        includeDrafts: plan.items.some((item) => item.reviewStatus !== 'APPROVED'),
      },
      plan,
      scan,
    );

    const session = store.get().lastPreview?.sessionId;
    let reportError: string | null = null;
    if (session) {
      try {
        await this.client().reportApply(
          toApplyReportPayload(report, {
            syncSessionId: session,
            client: this.clientInfo(),
            gitCommit: git.currentHead(),
          }) as ApplyReportRequest,
        );
      } catch (error) {
        reportError = error instanceof Error ? error.message : String(error);
      }
    }

    store.patch({
      lastApplyReport: {
        applyPlanId: plan.applyPlanId,
        status: report.status,
        files: report.files.map((file) => file.filePath),
        appliedAt: new Date().toISOString(),
        gitCommit: git.currentHead(),
      },
    });
    store.clearApplyPlan(plan.applyPlanId);
    store.record('apply_translation_updates', `${report.items.filter((item) => item.applied).length} applied`);

    return {
      applyPlanId: plan.applyPlanId,
      status: report.status,
      applied: report.items.filter((item) => item.applied).length,
      failed: report.items.filter((item) => !item.applied && item.errorCode !== 'ALREADY_APPLIED').length,
      skipped: report.items.filter((item) => item.errorCode === 'ALREADY_APPLIED' || item.errorCode?.startsWith('NO_')).length,
      files: report.files,
      items: report.items.map((item) => ({
        key: item.key,
        locale: item.locale,
        filePath: item.filePath,
        applied: item.applied,
        previousValue: item.previousValue,
        newValue: item.newValue,
        error: item.errorMessage ?? null,
      })),
      gitDiffStat: report.gitDiffStat,
      gitCommit: git.currentHead(),
      reportError,
      nextStep: reportError
        ? 'Files were written but the apply report could not reach the platform. Re-run report_apply_result once the API is reachable.'
        : 'Review the git diff, then commit yourself. Nothing was committed or pushed by LocaleHub.',
    };
  }

  /* ------------------------------------------- validate_localization_files */

  async validateLocalizationFiles(input: { file_set_ids?: string[]; check_placeholders?: boolean; check_duplicates?: boolean; check_missing?: boolean } = {}): Promise<ToolResult> {
    const config = this.config().config;
    const guard = this.workspace();
    const scan = await scanWorkspace(guard, {
      projectId: config.project.id,
      sourceLocale: config.project.sourceLocale,
      fileSetIds: input.file_set_ids,
    });

    const issues: { code: string; severity: 'ERROR' | 'WARNING' | 'INFO'; key?: string; locale?: string; filePath?: string; message: string }[] = [
      ...scan.errors.map((error) => ({
        code: error.code,
        severity: 'ERROR' as const,
        filePath: error.file,
        message: error.message,
      })),
      ...scan.warnings.map((warning) => ({
        code: warning.code,
        severity: 'WARNING' as const,
        filePath: warning.file,
        message: warning.message,
      })),
    ];

    // missing translations + placeholder checks against the source locale
    const sourceLocale = config.project.sourceLocale;
    const byKey = new Map<string, Map<string, { value: string; filePath: string }>>();
    for (const entry of scan.entries) {
      const id = `${entry.platform}\u0001${entry.namespace}\u0001${entry.key}`;
      const map = byKey.get(id) ?? new Map();
      map.set(entry.locale, { value: entry.value, filePath: entry.filePath });
      byKey.set(id, map);
    }
    const locales = [...new Set(scan.entries.map((entry) => entry.locale))].filter((locale) => locale !== sourceLocale);

    for (const [id, localeMap] of byKey) {
      const source = localeMap.get(sourceLocale);
      if (!source) continue;
      const [, namespace, key] = id.split('\u0001');
      for (const locale of locales) {
        const target = localeMap.get(locale);
        if (!target) {
          if (input.check_missing !== false) {
            issues.push({
              code: 'MISSING_TRANSLATION',
              severity: 'WARNING',
              key,
              locale,
              message: `Key is missing for locale ${locale}${namespace ? ` (namespace ${namespace})` : ''}`,
            });
          }
          continue;
        }
        if (input.check_placeholders !== false) {
          const mismatch = comparePlaceholders(source.value, target.value);
          if (mismatch.missing.length || mismatch.added.length) {
            issues.push({
              code: 'PLACEHOLDER_MISMATCH',
              severity: 'ERROR',
              key,
              locale,
              filePath: target.filePath,
              message: `Placeholders differ from source (missing: ${mismatch.missing.join(', ') || '-'}; extra: ${mismatch.added.join(', ') || '-'})`,
            });
          }
        }
        if (target.value.trim() === '') {
          issues.push({
            code: 'EMPTY_TRANSLATION',
            severity: 'ERROR',
            key,
            locale,
            filePath: target.filePath,
            message: 'Translation is empty',
          });
        }
      }
    }

    return {
      filesScanned: scan.files.length,
      entriesChecked: scan.entries.length,
      locales,
      issueCount: issues.length,
      bySeverity: {
        ERROR: issues.filter((issue) => issue.severity === 'ERROR').length,
        WARNING: issues.filter((issue) => issue.severity === 'WARNING').length,
        INFO: issues.filter((issue) => issue.severity === 'INFO').length,
      },
      issues: issues.slice(0, 300),
    };
  }

  /* --------------------------------------------------------- get_sync_status */

  async getSyncStatus(input: { project_id?: string; include_conflicts?: boolean } = {}): Promise<ToolResult> {
    const projectId = this.projectId(input.project_id);
    const state = this.store().get();
    const git = this.git().info();
    let remote: unknown = null;
    let remoteError: string | null = null;
    let conflicts: ConflictRecord[] = [];
    try {
      remote = await this.client().syncStatus(projectId);
      if (input.include_conflicts !== false) {
        conflicts = await this.client().listConflicts({ projectId, status: 'OPEN' });
      }
    } catch (error) {
      remoteError = error instanceof Error ? error.message : String(error);
    }
    return {
      local: {
        projectId: this.config().config.project.id,
        lastScanId: state.lastScanId,
        lastScanAt: state.lastScanAt,
        lastPreview: state.lastPreview,
        lastApplyReport: state.lastApplyReport,
        pendingApplyPlans: state.pendingApplyPlans.map((plan) => ({
          applyPlanId: plan.applyPlanId,
          expiresAt: plan.expiresAt,
          ready: plan.summary.ready,
        })),
        git: { branch: git.branch, commit: git.commit, dirty: git.dirty },
        history: state.history.slice(0, 10),
      },
      remote,
      remoteError,
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        key: conflict.key,
        locale: conflict.locale,
        platform: conflict.platform,
        reason: conflict.reason,
        base: conflict.baseValue,
        local: conflict.localValue,
        platformValue: conflict.remoteValue,
        status: conflict.status,
        createdAt: conflict.createdAt,
      })),
    };
  }

  /* ---------------------------------------------------- resolve_sync_conflict */

  async resolveSyncConflict(input: { conflict_id: string; resolution: ConflictResolution; value?: string; note?: string }): Promise<ToolResult> {
    if (!input.resolution) {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'resolution is required (KEEP_LOCAL | KEEP_REMOTE | MANUAL_MERGE | DEFER)', 422);
    }
    if (input.resolution === 'MANUAL_MERGE' && typeof input.value !== 'string') {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'MANUAL_MERGE requires an explicit value', 422);
    }
    const resolved = await this.client().resolveConflict(input.conflict_id, {
      resolution: input.resolution,
      value: input.value,
      note: input.note,
    });
    this.store().record('resolve_sync_conflict', `${input.conflict_id} -> ${input.resolution}`);
    return {
      conflict: resolved,
      nextStep:
        input.resolution === 'DEFER'
          ? 'Conflict deferred; nothing changed on either side.'
          : 'Resolution recorded. Run preview_sync again to recompute the plan and baseline.',
    };
  }

  /* ------------------------------------------------------- report_apply_result */

  async reportApplyResult(input: { apply_plan_id: string; git_commit?: string | null; note?: string }): Promise<ToolResult> {
    const state = this.store().get();
    const lastReport = state.lastApplyReport;
    const sessionId = state.lastPreview?.sessionId;
    if (!sessionId) {
      throw new LocaleHubError(ErrorCode.SYNC_SESSION_NOT_FOUND, 'No sync session recorded locally. Run preview_sync first.', 404);
    }
    if (!lastReport || lastReport.applyPlanId !== input.apply_plan_id) {
      throw new LocaleHubError(
        ErrorCode.NOT_FOUND,
        `No local record of apply plan ${input.apply_plan_id}. Use apply_translation_updates, which reports automatically.`,
        404,
      );
    }
    const response = await this.client().reportApply({
      syncSessionId: sessionId,
      applyPlanId: input.apply_plan_id,
      client: this.clientInfo(),
      status: lastReport.status,
      files: lastReport.files.map((file) => ({ filePath: file, backupPath: null, contentHash: contentHash(file) })),
      items: [],
      gitCommit: input.git_commit ?? lastReport.gitCommit ?? null,
      gitDiffStat: null,
    });
    this.store().record('report_apply_result', input.apply_plan_id);
    return { reported: true, ...response, note: input.note ?? null };
  }

  /* ----------------------------------------------------------- create_git_patch */

  createGitPatch(input: { apply_plan_id?: string; output_path?: string; include_untracked?: boolean } = {}): ToolResult {
    const git = this.git();
    if (!git.isRepository()) {
      throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'The workspace is not a git repository, so no patch can be produced.', 400);
    }
    const diff = git.diff();
    const stat = git.diffStat();
    const store = this.store();
    const outputPath = input.output_path ?? join(store.artifactDir('patches'), `localehub-${Date.now()}.patch`);
    writeFileSync(outputPath, `${diff}\n`, 'utf8');
    store.record('create_git_patch', outputPath);
    return {
      patchPath: outputPath,
      diffStat: stat,
      committed: false,
      pushed: false,
      filesChanged: git.info().changedFiles,
      note: input.include_untracked === false ? 'Untracked files are not included in `git diff`.' : 'Patch written but nothing committed or pushed.',
    };
  }

  /* ----------------------------------------------------------------- helpers */

  readStateFile(): string {
    return readFileSync(this.store().get() ? join(this.workspace().root, '.localehub', 'state.json') : '/dev/null', 'utf8');
  }
}

/** Stable id for a platform change, matching the convention used by preview_apply. */
export function changeKeyId(change: PlatformChange): string {
  return `chg_${contentHash(`${change.platform}\u0001${change.namespace}\u0001${change.key}\u0001${change.locale}`).slice(0, 16)}`;
}
