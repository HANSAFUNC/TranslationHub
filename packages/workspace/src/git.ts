import { execFileSync } from 'node:child_process';

export interface GitInfo {
  isRepository: boolean;
  branch: string | null;
  commit: string | null;
  shortCommit: string | null;
  remoteUrl: string | null;
  dirty: boolean;
  changedFiles: string[];
}

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Minimal git integration for the CLI. It reports branch/commit so the platform
 * can show provenance, and produces diffs after a write — it never commits or pushes on its
 * own (spec §10.3 point 9).
 */
export class GitClient {
  constructor(private readonly cwd: string) {}

  run(args: string[], options: { maxBuffer?: number } = {}): GitCommandResult {
    try {
      const stdout = execFileSync('git', args, {
        cwd: this.cwd,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout, stderr: '', exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; status?: number };
      return {
        ok: false,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? (error instanceof Error ? error.message : String(error)),
        exitCode: typeof err.status === 'number' ? err.status : 1,
      };
    }
  }

  isRepository(): boolean {
    return this.run(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  }

  info(): GitInfo {
    if (!this.isRepository()) {
      return { isRepository: false, branch: null, commit: null, shortCommit: null, remoteUrl: null, dirty: false, changedFiles: [] };
    }
    const branch = this.run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || null;
    const commit = this.run(['rev-parse', 'HEAD']).stdout.trim() || null;
    const shortCommit = this.run(['rev-parse', '--short', 'HEAD']).stdout.trim() || null;
    const remoteUrl = this.run(['config', '--get', 'remote.origin.url']).stdout.trim() || null;
    const status = this.run(['status', '--porcelain']).stdout;
    const changedFiles = status
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return {
      isRepository: true,
      branch,
      commit,
      shortCommit,
      remoteUrl,
      dirty: status.trim().length > 0,
      changedFiles,
    };
  }

  diff(paths?: string[]): string {
    const args = ['diff', '--no-color', '--stat', '--', ...(paths ?? ['.'])];
    const stat = this.run(args).stdout;
    const full = this.run(['diff', '--no-color', '--', ...(paths ?? ['.'])]).stdout;
    return `${stat}\n${full}`.trim();
  }

  diffStat(paths?: string[]): string {
    return this.run(['diff', '--no-color', '--stat', '--', ...(paths ?? ['.'])]).stdout.trim();
  }

  /** Per-file unified diff for a single path (used for the apply preview). */
  fileDiff(path: string): string {
    return this.run(['diff', '--no-color', '--', path]).stdout.trim();
  }

  currentHead(): string | null {
    return this.run(['rev-parse', 'HEAD']).stdout.trim() || null;
  }
}
