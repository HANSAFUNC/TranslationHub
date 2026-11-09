import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared bootstrap for anything that needs a live API: the acceptance demo and the integration
 * suite both use it.
 *
 * Both used to assume the caller had already started `apps/api` — which held locally (a dev
 * server was usually running) and broke in CI, where the integration suite starts the API in
 * `beforeAll` and kills it in `afterAll`, leaving nothing listening for the next step. Making the
 * caller responsible for the API removes that hidden precondition.
 */

export interface ApiHandle {
  baseUrl: string;
  /** True when this process started the API and is therefore responsible for stopping it. */
  spawned: boolean;
  /**
   * No-op when the API was already running before we looked. Resolves once the child has really
   * exited — returning as soon as SIGTERM is *sent* would let a second run start against an API
   * that is still draining, and then lose it mid-run.
   */
  stop(): Promise<void>;
}

export interface EnsureApiOptions {
  /** Repository root; `apps/api/dist/main.js` is resolved relative to it. */
  root: string;
  /** How long to wait for `/health` after spawning. */
  timeoutMs?: number;
  /** Forward the child's output to this process instead of buffering it. */
  inheritStdio?: boolean;
  /** Environment for the child; defaults to this process's. */
  env?: NodeJS.ProcessEnv;
}

export async function apiReachable(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForApi(baseUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await apiReachable(baseUrl)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

/**
 * Return a handle to a reachable API, starting one when nothing answers on `baseUrl`.
 *
 * Throws with an actionable message when the API is not built or never becomes healthy, instead
 * of letting the caller fail later with a bare `fetch failed`.
 */
export async function ensureApi(baseUrl: string, options: EnsureApiOptions): Promise<ApiHandle> {
  if (await apiReachable(baseUrl)) {
    return { baseUrl, spawned: false, stop: async () => undefined };
  }

  const entry = join(options.root, 'apps/api/dist/main.js');
  if (!existsSync(entry)) {
    throw new Error(`API is not built: ${entry} is missing. Run \`pnpm -r build\` first.`);
  }

  const child: ChildProcess = spawn('node', [entry], {
    cwd: options.root,
    env: options.env ?? process.env,
    stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Keep the tail of the child's output so a failed start explains itself.
  let output = '';
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-4_000);
  };
  if (!options.inheritStdio) {
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
  }

  const exited = new Promise<void>((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once('exit', () => resolveExit());
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    // Escalate if the API ignores SIGTERM, so a failing run cannot hang the CI job.
    const escalate = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5_000);
    escalate.unref();
    await exited;
    clearTimeout(escalate);
  };

  if (!(await waitForApi(baseUrl, options.timeoutMs ?? 60_000))) {
    await stop();
    const detail = output.trim() ? `\n--- API output ---\n${output.trim()}` : '';
    throw new Error(`API did not become healthy at ${baseUrl} within the timeout.${detail}`);
  }

  return { baseUrl, spawned: true, stop };
}
