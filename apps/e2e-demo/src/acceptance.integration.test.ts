import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '@localehub/api-client';
import { LocalMcpServices } from '@localehub/mcp-local';
import { PrismaClient } from '@localehub/database';
import { loadLocalConfig } from '@localehub/workspace';

/**
 * Integration suite for the acceptance criteria in spec §16.1/§16.2.
 *
 * Requires PostgreSQL and Redis (docker compose up -d postgres redis) and a built API. The
 * suite boots `apps/api` itself when nothing answers on API_BASE_URL.
 */

const ROOT = resolve(__dirname, '../../..');
const API_BASE = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
const WORKSPACE = process.env.IT_WORKSPACE ?? join(ROOT, '.demo-workspace-integration');

let apiProcess: ChildProcess | null = null;
let session: { token: string; projectId: string };
let admin: ApiClient;
let token: string;
let local: LocalMcpServices;
const runId = Date.now().toString(36);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function apiReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForApi(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await apiReachable()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

async function fetchJson(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as { success: boolean; data?: Record<string, unknown>; error?: { message: string } };
  if (!response.ok || !payload.success) throw new Error(payload.error?.message ?? `request failed ${response.status}`);
  return payload.data ?? {};
}

/**
 * Create an isolated user + organization directly in the database.
 *
 * Registration via the API is intentionally closed once an instance has users, so the test
 * bootstraps its own tenant the same way an operator would (privileged, one-off).
 */
async function ensureUser(email: string, password: string): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      return tx.user.findUnique({ where: { email } });
    });
    if (existing) return;
    const { hashPassword } = await import('@localehub/domain');
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const user = await tx.user.create({ data: { email, name: 'Integration Admin', passwordHash, isPlatformAdmin: false } });
      const organization = await tx.organization.create({ data: { name: `IT Org ${email}`, slug: `it-${runId}-${Date.now().toString(36)}` } });
      await tx.membership.create({ data: { organizationId: organization.id, userId: user.id, role: 'ORG_OWNER' } });
    });
  } finally {
    await prisma.$disconnect();
  }
}

beforeAll(async () => {
  if (!(await apiReachable())) {
    if (!existsSync(join(ROOT, 'apps/api/dist/main.js'))) {
      throw new Error('apps/api is not built. Run `pnpm -r build` before the integration suite.');
    }
    apiProcess = spawn('node', [join(ROOT, 'apps/api/dist/main.js')], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: false,
    });
    const ready = await waitForApi();
    if (!ready) throw new Error(`API did not become healthy at ${API_BASE}`);
  }

  // fresh workspace copy
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  cpSync(join(ROOT, 'demo-app'), WORKSPACE, { recursive: true });
  git(WORKSPACE, ['init', '-q']);
  git(WORKSPACE, ['config', 'user.email', 'it@localehub.dev']);
  git(WORKSPACE, ['config', 'user.name', 'Integration']);
  git(WORKSPACE, ['add', '-A']);
  git(WORKSPACE, ['commit', '-qm', 'chore: fixture']);

  const email = `it-${runId}@localehub.dev`;
  const password = 'integration-password-123';
  await ensureUser(email, password);
  const login = await fetchJson('/auth/login', 'POST', { email, password });
  session = { token: String(login.token), projectId: '' };
  admin = new ApiClient({ baseUrl: API_BASE, token: session.token });

  const project = await admin.call<{ id: string }>('POST', '/projects', {
    name: `IT Project ${runId}`,
    sourceLocale: 'en-US',
    locales: ['ja-JP'],
  });
  session.projectId = project.id;

  const configPath = join(WORKSPACE, '.localehub', 'config.yaml');
  writeFileSync(
    configPath,
    readFileSync(configPath, 'utf8').replace('PROJECT_ID_PLACEHOLDER', project.id).replace('http://localhost:3001/api/v1', API_BASE),
    'utf8',
  );
  git(WORKSPACE, ['add', '.localehub/config.yaml']);
  git(WORKSPACE, ['commit', '-qm', 'chore: point at the test project']);

  const issued = await admin.createToken({
    name: `it-${runId}`,
    scopes: [
      'project.read',
      'repository.scan',
      'sync.preview',
      'sync.push',
      'translation.read',
      'translation.pull',
      'translation.apply',
    ],
    projectIds: [project.id],
    expiresInDays: 1,
  });
  token = issued.token;
  local = new LocalMcpServices({
    cwd: WORKSPACE,
    env: { ...process.env, LOCALEHUB_TOKEN: token, LOCALEHUB_API_URL: API_BASE } as NodeJS.ProcessEnv,
  });
  const config = loadLocalConfig(WORKSPACE);
  expect(config.config.project.id).toBe(project.id);
}, 180_000);

afterAll(async () => {
  if (apiProcess) {
    apiProcess.kill('SIGTERM');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
});

describe('acceptance: local repository ↔ platform sync', () => {
  it('test_push_new_key: scans, previews and pushes a new local key', async () => {
    const scan = await local.scanLocalProject({});
    expect(scan.uploaded).toBe(true);
    expect(scan.entriesFound).toBeGreaterThan(0);

    const preview = await local.previewSync({ direction: 'bidirectional' });
    expect((preview.summary as Record<string, number>).pushNew).toBeGreaterThan(0);

    const push = await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true });
    expect(push.status).toBe('SUCCEEDED');
    expect((push.summary as Record<string, number>).created).toBeGreaterThan(0);

    const entry = await admin.findEntry(session.projectId, 'checkout.pay_now', 'ja-JP');
    expect(entry.value).toBe('今すぐ支払う');
    expect(entry.status).toBe('APPROVED');
  }, 60_000);

  it('test_idempotent_push: replaying the same plan creates no duplicate versions', async () => {
    const scan = await local.scanLocalProject({});
    expect(scan.uploaded).toBe(true);
    const preview = await local.previewSync({ direction: 'bidirectional' });
    const first = await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true });
    const replay = await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true });
    expect(replay.idempotentReplay).toBe(true);
    expect((replay.summary as Record<string, number>).created).toBe(0);
    expect((first.summary as Record<string, number>).created + (first.summary as Record<string, number>).updated).toBe(0);
  }, 60_000);

  it('test_platform_approved_translation_pulled: approved platform edits become pullable', async () => {
    const entry = await admin.findEntry(session.projectId, 'checkout.pay_now', 'ja-JP');
    await admin.saveDraft(session.projectId, entry.entryId, '今すぐお支払いください');
    const review = await admin.review(session.projectId, [entry.entryId], 'APPROVE');
    expect(review.results[0]?.status).toBe('APPROVED');

    const pull = await local.pullPlatformUpdates({ locales: ['ja-JP'] });
    const change = (pull.changes as { key: string; current: string }[]).find((item) => item.key === 'checkout.pay_now');
    expect(change?.current).toBe('今すぐお支払いください');
  }, 60_000);

  it('test_apply_creates_backup_and_atomic_write: writes the file, keeps a backup, preserves other keys', async () => {
    const preview = await local.previewApply({});
    expect((preview.summary as { ready: number }).ready).toBeGreaterThanOrEqual(1);

    const result = await local.applyTranslationUpdates({ apply_plan_id: String(preview.applyPlanId), confirm: true });
    expect(result.status).toBe('SUCCEEDED');
    expect(result.applied).toBeGreaterThanOrEqual(1);

    const files = result.files as { filePath: string; backupPath: string | null }[];
    expect(files[0]?.backupPath).toBeTruthy();
    expect(existsSync(files[0]!.backupPath!)).toBe(true);

    const content = JSON.parse(readFileSync(join(WORKSPACE, 'apps/web/src/locales/ja-JP/common.json'), 'utf8')) as {
      checkout: { pay_now: string; cart_empty: string };
      greeting: string;
    };
    expect(content.checkout.pay_now).toBe('今すぐお支払いください');
    expect(content.checkout.cart_empty).toBe('カートは空です');
    expect(content.greeting).toContain('新着メッセージ');

    const diffFiles = git(WORKSPACE, ['diff', '--name-only']).trim().split('\n').filter(Boolean);
    expect(diffFiles).toEqual(['apps/web/src/locales/ja-JP/common.json']);
  }, 60_000);

  it('test_apply_report_updates_baseline: the platform records the applied revision', async () => {
    const scan = await local.scanLocalProject({});
    expect(scan.uploaded).toBe(true);
    const preview = await local.previewSync({ direction: 'bidirectional' });
    const summary = preview.summary as Record<string, number>;
    expect(summary.pushNew + summary.pushUpdated + summary.pullApproved + summary.conflicts).toBe(0);
    expect(summary.unchanged).toBeGreaterThan(0);

    const entry = await admin.findEntry(session.projectId, 'checkout.pay_now', 'ja-JP');
    expect(entry.appliedToRepoAt).toBeTruthy();
  }, 60_000);

  it('test_draft_translation_not_pulled_by_default', async () => {
    const entry = await admin.findEntry(session.projectId, 'checkout.cart_empty', 'ja-JP');
    await admin.saveDraft(session.projectId, entry.entryId, 'カートに商品がありません');

    const pull = await local.pullPlatformUpdates({ locales: ['ja-JP'] });
    expect((pull.changes as { key: string }[]).some((change) => change.key === 'checkout.cart_empty')).toBe(false);

    const explicit = await local.pullPlatformUpdates({ locales: ['ja-JP'], include_drafts: true });
    const draft = (explicit.changes as { key: string; reviewStatus: string }[]).find((change) => change.key === 'checkout.cart_empty');
    expect(draft?.reviewStatus).toBe('DRAFT');

    const plan = await local.previewApply({});
    expect((plan.changes as { key: string }[]).some((change) => change.key === 'checkout.cart_empty')).toBe(false);
  }, 60_000);

  it('test_push_source_change_marks_targets_stale', async () => {
    const enPath = join(WORKSPACE, 'apps/web/src/locales/en-US/common.json');
    const en = JSON.parse(readFileSync(enPath, 'utf8')) as { checkout: { cart_empty: string } };
    en.checkout.cart_empty = 'Your shopping cart is empty';
    writeFileSync(enPath, `${JSON.stringify(en, null, 2)}\n`, 'utf8');

    await local.scanLocalProject({});
    const preview = await local.previewSync({ direction: 'bidirectional' });
    await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true });

    const stale = await admin.listStale(session.projectId);
    expect(stale.some((item) => item.key === 'checkout.cart_empty' && item.locale === 'ja-JP')).toBe(true);

    // history is preserved: the older translation versions still exist
    const entry = await admin.findEntry(session.projectId, 'checkout.cart_empty', 'ja-JP');
    const detail = await admin.call<{ versions: unknown[] }>('GET', `/projects/${session.projectId}/translations/${entry.entryId}`);
    expect(detail.versions.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('test_conflict_when_both_sides_changed: local and platform edits produce a conflict, never a silent overwrite', async () => {
    // platform side: approve a new value for checkout.pay_now
    const entry = await admin.findEntry(session.projectId, 'checkout.pay_now', 'ja-JP');
    await admin.saveDraft(session.projectId, entry.entryId, 'プラットフォーム側の修正');
    await admin.review(session.projectId, [entry.entryId], 'APPROVE');

    // local side: change the same key independently
    const jaPath = join(WORKSPACE, 'apps/web/src/locales/ja-JP/common.json');
    const ja = JSON.parse(readFileSync(jaPath, 'utf8')) as { checkout: { pay_now: string } };
    ja.checkout.pay_now = 'ローカル側の修正';
    writeFileSync(jaPath, `${JSON.stringify(ja, null, 2)}\n`, 'utf8');

    await local.scanLocalProject({});
    const preview = await local.previewSync({ direction: 'bidirectional' });
    const conflicts = (preview.changes as { key: string; action: string }[]).filter((change) => change.action === 'CONFLICT');
    expect(conflicts.some((change) => change.key === 'checkout.pay_now')).toBe(true);

    const push = await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true });
    expect((push.summary as Record<string, number>).conflicts).toBeGreaterThanOrEqual(1);

    const open = await admin.listConflicts({ projectId: session.projectId, status: 'OPEN' });
    const conflict = open.find((item) => item.key === 'checkout.pay_now');
    expect(conflict).toBeTruthy();
    expect(conflict?.localValue).toBe('ローカル側の修正');
    expect(conflict?.remoteValue).toBe('プラットフォーム側の修正');

    // resolving with KEEP_LOCAL writes the local value to the platform as a new approved version
    const resolved = await admin.resolveConflict(conflict!.id, { resolution: 'KEEP_LOCAL' });
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedValue).toBe('ローカル側の修正');
    const after = await admin.findEntry(session.projectId, 'checkout.pay_now', 'ja-JP');
    expect(after.value).toBe('ローカル側の修正');
  }, 90_000);

  it('test_same_change_converges: identical edits on both sides converge without a conflict', async () => {
    const entry = await admin.findEntry(session.projectId, 'greeting', 'ja-JP');
    const sameValue = 'こんにちは {name}、新着メッセージは %d 件です';
    await admin.saveDraft(session.projectId, entry.entryId, sameValue);
    await admin.review(session.projectId, [entry.entryId], 'APPROVE');

    const jaPath = join(WORKSPACE, 'apps/web/src/locales/ja-JP/common.json');
    const ja = JSON.parse(readFileSync(jaPath, 'utf8')) as { greeting: string };
    ja.greeting = sameValue;
    writeFileSync(jaPath, `${JSON.stringify(ja, null, 2)}\n`, 'utf8');

    await local.scanLocalProject({});
    const preview = await local.previewSync({ direction: 'bidirectional' });
    const item = (preview.changes as { key: string; locale: string; action: string; reason: string; base: string | null; local: string | null; platformValue: string | null }[]).find(
      (change) => change.key === 'greeting' && change.locale === 'ja-JP',
    );
    expect({ action: item?.action, reason: item?.reason, base: item?.base, local: item?.local, remote: item?.platformValue }).toMatchObject({
      action: 'CONVERGED',
    });
    // checkout.cart_empty/ja-JP is intentionally left STALE by the previous scenario (its source
    // changed after the platform value was written), so it must *not* silently converge: the
    // engine reports SOURCE_VERSION_CHANGED instead.
    const conflicts = (preview.changes as { key: string; action: string; reason: string }[]).filter((change) => change.action === 'CONFLICT');
    expect(conflicts.some((change) => change.key === 'greeting')).toBe(false);
    expect(conflicts.every((change) => change.reason.includes('SOURCE_VERSION'))).toBe(true);
  }, 60_000);

  it('test_local_change_after_preview_blocks_apply', async () => {
    const entry = await admin.findEntry(session.projectId, 'checkout.cart_empty', 'ja-JP');
    await admin.saveDraft(session.projectId, entry.entryId, '買い物かごは空です');
    await admin.review(session.projectId, [entry.entryId], 'APPROVE');

    const preview = await local.previewApply({});
    expect((preview.summary as { ready: number }).ready).toBeGreaterThanOrEqual(1);

    const jaPath = join(WORKSPACE, 'apps/web/src/locales/ja-JP/common.json');
    const before = readFileSync(jaPath, 'utf8');
    const ja = JSON.parse(before) as { checkout: { cart_empty: string } };
    ja.checkout.cart_empty = 'プレビュー後のローカル変更';
    writeFileSync(jaPath, `${JSON.stringify(ja, null, 2)}\n`, 'utf8');

    await expect(
      local.applyTranslationUpdates({ apply_plan_id: String(preview.applyPlanId), confirm: true }),
    ).rejects.toMatchObject({ code: 'APPLY_REJECTED_STALE_PREVIEW' });

    // restore and confirm the plan still works once the file matches again
    writeFileSync(jaPath, before, 'utf8');
    const applied = await local.applyTranslationUpdates({ apply_plan_id: String(preview.applyPlanId), confirm: true });
    expect(applied.status).toBe('SUCCEEDED');
  }, 60_000);

  it('test_preview_plan_expiration: an expired plan cannot be pushed', async () => {
    await local.scanLocalProject({});
    const preview = await local.previewSync({ direction: 'bidirectional' });
    const prisma = new PrismaClient();
    try {
      // Expire the plan exactly the way time would (the TTL is server-side state).
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        await tx.syncPlan.update({
          where: { id: String(preview.syncPlanId) },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      });
    } finally {
      await prisma.$disconnect();
    }
    await expect(
      local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true }),
    ).rejects.toMatchObject({ code: 'SYNC_PLAN_EXPIRED' });
  }, 60_000);

  it('test_mcp_scope_enforced: a token without sync.push cannot push', async () => {
    const readOnly = await admin.createToken({
      name: `ro-${runId}`,
      scopes: ['project.read', 'repository.scan', 'sync.preview'],
      projectIds: [session.projectId],
      expiresInDays: 1,
    });
    const limited = new LocalMcpServices({
      cwd: WORKSPACE,
      env: { ...process.env, LOCALEHUB_TOKEN: readOnly.token, LOCALEHUB_API_URL: API_BASE } as NodeJS.ProcessEnv,
    });
    await limited.scanLocalProject({});
    const preview = await limited.previewSync({ direction: 'bidirectional' });
    await expect(
      limited.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true }),
    ).rejects.toMatchObject({ code: 'SCOPE_INSUFFICIENT' });
  }, 60_000);

  it('test_tenant_rls_isolation: another organization cannot see this project', async () => {
    const otherEmail = `other-${runId}@localehub.dev`;
    const password = 'integration-password-456';
    // A second organization can only be created by another bootstrap; simulate it directly.
    const prisma = new PrismaClient();
    try {
      const organization = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        return tx.organization.create({ data: { name: `Other Org ${runId}`, slug: `other-${runId}` } });
      });
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, organization.id);
        return tx.project.findMany({ where: { id: session.projectId } });
      });
      expect(rows).toHaveLength(0);

      // and without any tenant context at all
      const noContext = await prisma.project.findMany({ where: { id: session.projectId } });
      expect(noContext).toHaveLength(0);

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        await tx.organization.delete({ where: { id: organization.id } });
      });
    } finally {
      await prisma.$disconnect();
    }
    void otherEmail;
    void password;
  }, 60_000);

  it('test_cross_tenant_token_is_rejected: a token cannot touch another project', async () => {
    const foreignProjectId = '00000000-0000-0000-0000-0000000000ff';
    const scan = {
      projectId: foreignProjectId,
      scanId: `scan_foreign_${runId}`,
      files: [],
      entries: [],
    };
    const response = await fetch(`${API_BASE}/sync/scans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(scan),
    });
    expect(response.ok).toBe(false);
    const payload = (await response.json()) as { error?: { code: string } };
    expect(['PROJECT_ACCESS_DENIED', 'NOT_FOUND', 'ROLE_INSUFFICIENT']).toContain(payload.error?.code);
  }, 30_000);
});
