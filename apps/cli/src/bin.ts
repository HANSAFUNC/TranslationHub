#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import { loadEnvFiles } from '@localehub/config';
import { LocalMcpServices } from '@localehub/mcp-local';
import { loadLocalConfig } from '@localehub/workspace';
import { flagBool, parseArgs } from './args';

/**
 * LocaleHub CLI.
 *
 * The CLI is a thin shell over the same services the Local MCP exposes, so a CI job and an
 * interactive agent cannot drift apart (spec §14: `localehub scan`, `sync preview`, `qa`,
 * `release validate`).
 */

const HELP = `localehub <command>

  init [--project <id>] [--api <url>] [--source-locale en-US] [--locales ja-JP,zh-CN]
      Create .localehub/config.yaml in the current repository.

  info
      Print project, workspace policy, git state and configuration validation.

  scan [--file-set <id>]...
      Scan configured localization files and upload the normalized entries.

  sync preview [--direction bidirectional|push|pull] [--include-deletes]
      Three-way comparison; prints the change plan. Nothing is written.

  sync push --confirm [--idempotency-key <key>]
      Push the current preview plan to the platform.

  pull [--locale ja-JP] [--include-drafts]
      List approved platform changes (read only).

  apply preview
      Build the write-back plan (dry run) and print the per-file diff.
  apply --confirm [--apply-plan <id>] [--require-clean-worktree]
      Write approved translations into the repository (backup + atomic write).

  conflicts [--resolve <id> --as keep-local|keep-remote|manual|defer --value <text>]
      List open sync conflicts or resolve one.

  qa [--locale ja-JP]
      Local validation: format, placeholders, duplicates, missing translations.

  status
      Local state + remote sync status + open conflicts.

  patch
      Write a git patch of the current working tree (never commits).

  mcp-config
      Print the .mcp.json snippet for Claude Code / Cursor / Codex.

Exit codes: 0 ok, 1 error, 2 usage error, 3 conflicts or blocked applies.
`;

async function main(): Promise<void> {
  loadEnvFiles(process.cwd());
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const { command, flags, positionals } = parseArgs(argv);
  const [group, action] = command;
  const workspace = resolve((flags.workspace as string | undefined) ?? process.env.LOCALEHUB_WORKSPACE ?? process.cwd());
  const json = flagBool(flags, 'json');

  const output = (payload: unknown, summary?: string) => {
    if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else if (summary) process.stdout.write(`${summary}\n`);
    else process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  };

  if (group === 'init') {
    return init(workspace, flags);
  }

  const services = new LocalMcpServices({ cwd: workspace, env: process.env });

  switch (group) {
    case 'info':
      return output(await services.getLocalProjectInfo());
    case 'scan': {
      const fileSetIds = collectFlags(flags, 'file-set');
      const result = await services.scanLocalProject(fileSetIds.length ? { file_set_ids: fileSetIds } : {});
      if (json) return output(result);
      process.stdout.write(
        `scanned ${result.filesScanned} file(s), ${result.entriesFound} entr(ies), locales: ${(result.locales as string[]).join(', ')}\n`,
      );
      if ((result.errors as unknown[]).length) process.stdout.write(`errors: ${JSON.stringify(result.errors)}\n`);
      if ((result.warnings as unknown[]).length) process.stdout.write(`warnings: ${(result.warnings as unknown[]).length}\n`);
      return;
    }
    case 'sync': {
      if (action === 'preview') {
        const result = await services.previewSync({
          direction: (flags.direction as 'bidirectional' | 'push' | 'pull' | undefined) ?? 'bidirectional',
          include_deletes: flagBool(flags, 'include-deletes'),
        });
        if (json) return output(result);
        printPlan(result);
        return;
      }
      if (action === 'push') {
        const result = await services.pushProjectChanges({
          sync_plan_id: flags['plan'] as string | undefined,
          confirm: flagBool(flags, 'confirm'),
          idempotency_key: flags['idempotency-key'] as string | undefined,
          include_deletes: flagBool(flags, 'include-deletes'),
        });
        if (json) return output(result);
        if (result.requiresConfirmation) {
          process.stdout.write('Refused: pass --confirm to push the previewed plan.\n');
          process.exitCode = 2;
          return;
        }
        process.stdout.write(`push ${result.status}: ${JSON.stringify(result.summary)}\n`);
        if ((result.conflicts as unknown[]).length) process.exitCode = 3;
        return;
      }
      process.stderr.write(`unknown sync action: ${action ?? ''}\n`);
      process.exitCode = 2;
      return;
    }
    case 'pull': {
      const result = await services.pullPlatformUpdates({
        locales: collectFlags(flags, 'locale'),
        include_drafts: flagBool(flags, 'include-drafts'),
      });
      if (json) return output(result);
      process.stdout.write(`${result.count} change(s) at revision ${result.revision}\n`);
      for (const change of result.changes as { key: string; locale: string; current: string; reviewStatus: string }[]) {
        process.stdout.write(`  ${change.locale} ${change.key} [${change.reviewStatus}] → ${change.current}\n`);
      }
      return;
    }
    case 'apply': {
      if (!action || action === 'preview') {
        const result = await services.previewApply({
          create_backup: !flagBool(flags, 'no-backup'),
          include_drafts: flagBool(flags, 'include-drafts'),
        });
        if (json) return output(result);
        const summary = result.summary as { ready: number; blocked: number; total: number };
        process.stdout.write(`apply plan ${result.applyPlanId}: ${summary.ready} ready / ${summary.blocked} blocked\n`);
        for (const change of result.changes as { filePath: string; key: string; locale: string; status: string; previousValue: string | null; newValue: string }[]) {
          process.stdout.write(`  [${change.status}] ${change.filePath} ${change.locale} ${change.key}\n`);
          process.stdout.write(`      - ${change.previousValue ?? '(absent)'}\n      + ${change.newValue}\n`);
        }
        if (summary.blocked > 0) process.exitCode = 3;
        return;
      }
      const applyPlanId = (flags['apply-plan'] as string | undefined) ?? undefined;
      if (!applyPlanId) {
        process.stderr.write('apply --confirm requires --apply-plan <id> (from `localehub apply preview`)\n');
        process.exitCode = 2;
        return;
      }
      const result = await services.applyTranslationUpdates({
        apply_plan_id: applyPlanId,
        confirm: flagBool(flags, 'confirm'),
        require_clean_worktree: flagBool(flags, 'require-clean-worktree'),
        create_backup: !flagBool(flags, 'no-backup'),
      });
      if (json) return output(result);
      if (result.requiresConfirmation) {
        process.stdout.write('Refused: pass --confirm to write the previewed changes.\n');
        process.exitCode = 2;
        return;
      }
      process.stdout.write(`apply ${result.status}: ${result.applied} applied, ${result.failed} failed\n`);
      process.stdout.write(`${result.gitDiffStat ?? ''}\n`);
      if ((result.failed as number) > 0) process.exitCode = 3;
      return;
    }
    case 'conflicts': {
      if (flags.resolve) {
        const as = (flags.as as string | undefined) ?? '';
        const map: Record<string, string> = {
          'keep-local': 'KEEP_LOCAL',
          'keep-remote': 'KEEP_REMOTE',
          manual: 'MANUAL_MERGE',
          defer: 'DEFER',
        };
        const resolution = map[as];
        if (!resolution) {
          process.stderr.write('--as must be one of keep-local | keep-remote | manual | defer\n');
          process.exitCode = 2;
          return;
        }
        const result = await services.resolveSyncConflict({
          conflict_id: flags.resolve as string,
          resolution: resolution as never,
          value: flags.value as string | undefined,
        });
        return output(result);
      }
      const status = await services.getSyncStatus({});
      if (json) return output(status);
      const conflicts = status.conflicts as { id: string; key: string; locale: string; reason: string }[];
      if (!conflicts.length) {
        process.stdout.write('no open conflicts\n');
        return;
      }
      for (const conflict of conflicts) {
        process.stdout.write(`  ${conflict.id} ${conflict.locale} ${conflict.key} (${conflict.reason})\n`);
      }
      return;
    }
    case 'qa': {
      const result = await services.validateLocalizationFiles({ file_set_ids: collectFlags(flags, 'file-set') });
      if (json) return output(result);
      process.stdout.write(
        `QA: ${result.issueCount} issue(s) over ${result.entriesChecked} entries — ${JSON.stringify(result.bySeverity)}\n`,
      );
      for (const issue of (result.issues as { severity: string; key?: string; locale?: string; message: string }[]).slice(0, 50)) {
        process.stdout.write(`  [${issue.severity}] ${issue.locale ?? ''} ${issue.key ?? ''} ${issue.message}\n`);
      }
      if ((result.bySeverity as { ERROR: number }).ERROR > 0) process.exitCode = 3;
      return;
    }
    case 'status':
      return output(await services.getSyncStatus({}));
    case 'patch':
      return output(services.createGitPatch({ output_path: flags.output as string | undefined }));
    case 'mcp-config': {
      const loaded = loadLocalConfig(workspace);
      process.stdout.write(
        `${JSON.stringify(
          {
            mcpServers: {
              'localehub-local': {
                command: 'node',
                args: ['<path-to-localehub>/apps/mcp-local/dist/bin.js', '--stdio', '--workspace', '.'],
                env: {
                  LOCALEHUB_API_URL: loaded.config.localehub.apiUrl,
                  LOCALEHUB_WORKSPACE: '.',
                  LOCALEHUB_TOKEN: `\${${loaded.tokenEnv}}`,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    case 'release': {
      if (action !== 'validate') {
        process.stderr.write('usage: localehub release validate\n');
        process.exitCode = 2;
        return;
      }
      const [{ ApiClient }, config] = [await import('@localehub/api-client'), loadLocalConfig(workspace)];
      const client = new ApiClient({
        baseUrl: config.config.localehub.apiUrl,
        token: process.env[config.tokenEnv] ?? '',
      });
      const result = await client.validateRelease(config.config.project.id);
      output(result);
      if (!result.ok) process.exitCode = 3;
      return;
    }
    default:
      process.stderr.write(`unknown command: ${group}\n\n${HELP}`);
      process.exitCode = 2;
  }

  void positionals;
}

function printPlan(result: Record<string, unknown>): void {
  const summary = result.summary as Record<string, number>;
  process.stdout.write(
    `plan ${result.syncPlanId} (expires ${result.expiresAt})\n` +
      `  push_new=${summary.pushNew} push_updated=${summary.pushUpdated} pull_approved=${summary.pullApproved} ` +
      `pull_draft=${summary.pullDraft} unchanged=${summary.unchanged} conflicts=${summary.conflicts} archive=${summary.archiveCandidates}\n`,
  );
  for (const change of (result.changes as { action: string; locale: string; key: string; filePath: string | null }[]) ?? []) {
    if (change.action === 'SKIP') continue;
    process.stdout.write(`  [${change.action}] ${change.locale} ${change.key}${change.filePath ? ` (${change.filePath})` : ''}\n`);
  }
}

function collectFlags(flags: Record<string, string | boolean>, key: string): string[] {
  const value = flags[key];
  if (value === undefined || value === true) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function init(workspace: string, flags: Record<string, string | boolean>): void {
  const configPath = join(workspace, '.localehub', 'config.yaml');
  if (existsSync(configPath)) {
    process.stderr.write(`${configPath} already exists; refusing to overwrite.\n`);
    process.exitCode = 1;
    return;
  }
  const projectId = (flags.project as string | undefined) ?? 'prj_replace_me';
  const apiUrl = (flags.api as string | undefined) ?? 'http://localhost:3001/api/v1';
  const sourceLocale = (flags['source-locale'] as string | undefined) ?? 'en-US';
  const locales = String(flags.locales ?? 'ja-JP')
    .split(',')
    .map((locale) => locale.trim())
    .filter((locale) => locale && locale !== sourceLocale);

  const config = {
    version: 1,
    project: { id: projectId, name: 'My Product', sourceLocale, platforms: ['web'] },
    localehub: { apiUrl, tokenEnv: 'LOCALEHUB_TOKEN' },
    workspace: {
      root: '.',
      allowRead: ['src/**', 'app/**'],
      allowWrite: [`locales/**`],
      denyRead: ['.env*', '**/secrets/**', 'node_modules/**'],
      denyWrite: ['.env*', '**/secrets/**', '**/*.generated.*'],
    },
    sync: {
      defaultDirection: 'bidirectional',
      deletePolicy: 'archive',
      applyPolicy: 'approved_only',
      conflictPolicy: 'manual',
      writeMode: 'dry_run_by_default',
      preserveUnknownFields: true,
      createBackup: true,
      maxFilesPerBatch: 500,
    },
    files: [
      {
        id: 'web-source',
        platform: 'web',
        locale: sourceLocale,
        format: 'json',
        source: true,
        paths: [`locales/${sourceLocale}/**/*.json`],
        keyMode: 'nested',
        namespaceFromPath: true,
      },
      ...locales.map((locale) => ({
        id: `web-${locale.toLowerCase()}`,
        platform: 'web',
        locale,
        format: 'json',
        source: false,
        paths: [`locales/${locale}/**/*.json`],
        keyMode: 'nested',
        namespaceFromPath: true,
      })),
    ],
    ignore: { keys: ['debug.*'], paths: ['**/*.generated.*'] },
  };

  mkdirSync(join(workspace, '.localehub'), { recursive: true });
  writeFileSync(
    configPath,
    `# LocaleHub repository configuration — see docs/MCP.md\n${toYaml(config)}`,
    'utf8',
  );
  process.stdout.write(`wrote ${configPath}\n\nNext steps:\n  1. put your project id in project.id\n  2. export ${'LOCALEHUB_TOKEN'}=...\n  3. localehub info && localehub scan\n  4. localehub sync preview\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
