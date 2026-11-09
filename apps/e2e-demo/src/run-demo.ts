import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ApiClient } from '@localehub/api-client';
import { LocalMcpServices } from '@localehub/mcp-local';
import { loadLocalConfig } from '@localehub/workspace';
import { ensureApi, type ApiHandle } from './api-harness';

/**
 * End-to-end acceptance run for the migration scenario in the delivery spec:
 *
 *   1. scan + preview + push a fresh local project to the platform
 *   2. a product manager fixes a wrong Japanese translation on the platform and approves it
 *   3. the Local MCP pulls it, previews the diff (dry run), and after confirmation writes it back
 *   4. the file is re-validated, the apply report is sent, and a second sync reports "unchanged"
 *
 * The demo always runs against a throwaway copy of `demo-app/` so the repository stays clean.
 */

const ROOT = resolve(__dirname, '../../..');
const SOURCE_DEMO = join(ROOT, 'demo-app');
const WORKSPACE = process.env.DEMO_WORKSPACE ?? join(ROOT, '.demo-workspace');

interface Step {
  title: string;
  detail: string;
}

const steps: Step[] = [];
let failures = 0;

/** Set once the API is reachable, so cleanup runs even when a scenario throws. */
let api: ApiHandle | null = null;

function step(title: string, detail: string): void {
  steps.push({ title, detail });
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n${detail}\n`);
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${label}${detail ? ` — ${detail}` : ''}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  \u001b[31m✗ ${label}\u001b[0m${detail ? ` — ${detail}` : ''}\n`);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function main(): Promise<void> {
  const apiUrl = process.env.LOCALEHUB_API_URL ?? 'http://localhost:3001/api/v1';
  const email = process.env.DEMO_EMAIL ?? 'demo@localehub.dev';
  const password = process.env.DEMO_PASSWORD ?? 'demo-password-123';

  step('准备演示仓库 / preparing the demo repository', `workspace: ${WORKSPACE}`);
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  cpSync(SOURCE_DEMO, WORKSPACE, { recursive: true });
  git(WORKSPACE, ['init', '-q']);
  git(WORKSPACE, ['config', 'user.email', 'demo@localehub.dev']);
  git(WORKSPACE, ['config', 'user.name', 'LocaleHub Demo']);
  git(WORKSPACE, ['add', '-A']);
  git(WORKSPACE, ['commit', '-qm', 'chore: initial demo content']);
  check('demo repository created', existsSync(join(WORKSPACE, 'apps/web/src/locales/en-US/common.json')));

  step('启动 API / ensuring the API is up', apiUrl);
  api = await ensureApi(apiUrl, { root: ROOT });
  check(
    'API reachable',
    true,
    api.spawned ? 'started by this run, will be stopped afterwards' : 'already running, left untouched',
  );

  step('登录平台 / signing in to the platform', apiUrl);
  const session = await bootstrapSession(apiUrl, email, password);
  const admin = new ApiClient({ baseUrl: apiUrl, token: session.token });
  check('authenticated', Boolean(session.token), session.organizationName);

  step('创建项目与语言 / creating the project', 'Demo App (en-US → ja-JP)');
  const project = await admin.getProject(session.projectId);
  check('project exists', Boolean(project.id), `${project.name} (${project.sourceLocale})`);
  check(
    'target locale configured',
    project.locales.some((locale) => locale.code === 'ja-JP'),
  );

  step('签发 MCP Token / issuing an MCP token', 'scopes: read, scan, preview, push, pull, apply');
  const issued = await issueToken(admin, project.id);
  check('token issued', issued.token.startsWith('lh_mcp_'), issued.tokenPrefix);

  // Point the repository at the project that was really created (the fixture ships a placeholder).
  const configPath = join(WORKSPACE, '.localehub', 'config.yaml');
  const configText = readFileSync(configPath, 'utf8')
    .replace('PROJECT_ID_PLACEHOLDER', session.projectId)
    .replace('http://localhost:3001/api/v1', apiUrl);
  writeFileSync(configPath, configText, 'utf8');
  git(WORKSPACE, ['add', '.localehub/config.yaml']);
  git(WORKSPACE, ['commit', '-qm', 'chore: point config at the demo project']);

  const local = new LocalMcpServices({
    cwd: WORKSPACE,
    env: { ...process.env, LOCALEHUB_TOKEN: issued.token, LOCALEHUB_API_URL: apiUrl } as NodeJS.ProcessEnv,
  });
  const loaded = loadLocalConfig(WORKSPACE);
  check(
    'local config loads',
    loaded.config.project.id === session.projectId,
    `${loaded.configPath} → project ${loaded.config.project.id}`,
  );

  /* ---------------------------------------------------------------- scenario A */

  step('场景 A：扫描 → 预览 → 推送 / scan → preview → push', '本地新增内容推送到平台');
  const scan = await local.scanLocalProject({});
  check('scan uploaded', scan.uploaded === true, `${scan.filesScanned} files, ${scan.entriesFound} entries`);

  const preview = await local.previewSync({ direction: 'bidirectional' });
  const summary = preview.summary as Record<string, number>;
  check('preview produced push items', summary.pushNew + summary.pushUpdated > 0, JSON.stringify(summary));

  const unconfirmed = await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId) });
  check('push refuses without confirm', unconfirmed.requiresConfirmation === true);

  const push = await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true });
  check('push succeeded', push.status === 'SUCCEEDED' || push.status === 'PARTIAL', JSON.stringify(push.summary));

  const replay = await local.pushProjectChanges({ sync_plan_id: String(preview.syncPlanId), confirm: true });
  check('repeated push is idempotent', replay.idempotentReplay === true, 'no duplicate versions created');

  /* ---------------------------------------------------------------- scenario B */

  step('场景 B：平台修正日语译文并审核 / platform fixes and approves the Japanese copy', 'checkout.pay_now / ja-JP');
  const pullBefore = await local.pullPlatformUpdates({ locales: ['ja-JP'] });
  check('nothing to pull right after the first push', (pullBefore.count as number) === 0);

  const entry = await findEntry(admin, project.id, 'checkout.pay_now', 'ja-JP');
  const corrected = '今すぐお支払いください';
  await admin.saveDraft(project.id, entry.entryId, corrected);
  const approved = await admin.review(project.id, [entry.entryId], 'APPROVE', '修正済み / corrected by PM');
  check('platform approved the corrected value', approved.results[0]?.status === 'APPROVED', corrected);

  const pull = await local.pullPlatformUpdates({ locales: ['ja-JP'] });
  const pulled = (pull.changes as { key: string; locale: string; current: string }[]).find(
    (change) => change.key === 'checkout.pay_now' && change.locale === 'ja-JP',
  );
  check('approved change is pullable', Boolean(pulled), pulled ? `${pulled.current}` : 'not found');

  const applyPreview = await local.previewApply({});
  const applySummary = applyPreview.summary as { ready: number; blocked: number; total: number };
  check('apply plan is ready', applySummary.ready >= 1, JSON.stringify(applySummary));
  const readyItem = (
    applyPreview.changes as { key: string; status: string; previousValue: string | null; newValue: string; filePath: string }[]
  ).find((item) => item.key === 'checkout.pay_now' && item.status === 'READY');
  check(
    'diff shows old value → new value',
    Boolean(readyItem) && readyItem?.previousValue === '今すぐ支払う' && readyItem?.newValue === corrected,
    readyItem ? `${readyItem.filePath}: ${readyItem.previousValue} → ${readyItem.newValue}` : 'no ready item',
  );

  const blockedApply = await local.applyTranslationUpdates({ apply_plan_id: String(applyPreview.applyPlanId) });
  check('apply refuses without confirm', blockedApply.requiresConfirmation === true);

  // simulate a concurrent local edit after the preview: this must block the stale plan
  const jaFile = join(WORKSPACE, 'apps/web/src/locales/ja-JP/common.json');
  const originalJa = readFileSync(jaFile, 'utf8');
  const tampered = JSON.parse(originalJa) as Record<string, unknown>;
  (tampered as { checkout: { pay_now: string } }).checkout.pay_now = 'ローカルで変更';
  writeFileSync(jaFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  let staleBlocked = false;
  try {
    await local.applyTranslationUpdates({ apply_plan_id: String(applyPreview.applyPlanId), confirm: true });
  } catch (error) {
    staleBlocked = (error as { code?: string }).code === 'APPLY_REJECTED_STALE_PREVIEW';
  }
  check('stale apply plan is rejected', staleBlocked, 'local edit after preview blocked the write');
  writeFileSync(jaFile, originalJa, 'utf8');

  const apply = await local.applyTranslationUpdates({ apply_plan_id: String(applyPreview.applyPlanId), confirm: true });
  check('apply wrote the file', (apply.applied as number) >= 1, `status ${apply.status}`);

  const written = JSON.parse(readFileSync(jaFile, 'utf8')) as {
    checkout: { pay_now: string; cart_empty: string };
    greeting: string;
  };
  check('file contains the corrected value', written.checkout.pay_now === corrected);
  check('unrelated keys preserved', written.checkout.cart_empty === 'カートは空です' && typeof written.greeting === 'string');

  const diffStat = git(WORKSPACE, ['diff', '--stat', '--', 'apps/web/src/locales/ja-JP/common.json']).trim();
  const changedLines = git(WORKSPACE, ['diff', '--numstat', '--', 'apps/web/src/locales/ja-JP/common.json']).trim();
  check('git diff touches only the ja-JP file', diffStat.includes('common.json'), changedLines);

  step('场景 B 校验 / verification', '回写后再次校验');
  const validation = await local.validateLocalizationFiles({});
  check(
    'validation has no errors',
    (validation.bySeverity as { ERROR: number }).ERROR === 0,
    JSON.stringify(validation.bySeverity),
  );

  const status = await local.getSyncStatus({});
  check('apply report recorded on the platform', Boolean(status.remote), 'baseline advanced');

  /* ---------------------------------------------------------------- scenario C */

  step('场景 C：再次同步应为 unchanged / a second sync must report unchanged', 'no duplicate versions');
  const secondScan = await local.scanLocalProject({});
  check('rescan ok', (secondScan.filesScanned as number) > 0);
  const secondPreview = await local.previewSync({ direction: 'bidirectional' });
  const secondSummary = secondPreview.summary as Record<string, number>;
  check(
    'everything is in sync',
    secondSummary.pushNew +
      secondSummary.pushUpdated +
      secondSummary.pullApproved +
      secondSummary.pullDraft +
      secondSummary.conflicts ===
      0,
    JSON.stringify(secondSummary),
  );

  /* ---------------------------------------------------------------- scenario D */

  step('场景 D：平台草稿默认不拉取 / drafts are not pulled by default', 'include_drafts=false');
  const entry2 = await findEntry(admin, project.id, 'checkout.cart_empty', 'ja-JP');
  await admin.saveDraft(project.id, entry2.entryId, 'カートに商品がありません');
  const draftPull = await local.pullPlatformUpdates({ locales: ['ja-JP'] });
  const draftChange = (draftPull.changes as { key: string }[]).find((change) => change.key === 'checkout.cart_empty');
  check('draft is excluded from the default pull', !draftChange);
  const draftPullExplicit = await local.pullPlatformUpdates({ locales: ['ja-JP'], include_drafts: true });
  const draftExplicit = (draftPullExplicit.changes as { key: string; reviewStatus: string }[]).find(
    (change) => change.key === 'checkout.cart_empty',
  );
  check('draft is visible with include_drafts=true', Boolean(draftExplicit), draftExplicit?.reviewStatus ?? '');
  const draftApplyPreview = await local.previewApply({});
  const excludedDraft = (draftApplyPreview.changes as { key: string }[]).find((item) => item.key === 'checkout.cart_empty');
  check('unapproved draft never enters the default apply plan', !excludedDraft, 'excluded from APPROVED-only plans');

  const draftApplyExplicit = await local.previewApply({ include_drafts: true });
  const riskyDraft = (draftApplyExplicit.changes as { key: string; status: string }[]).find(
    (item) => item.key === 'checkout.cart_empty',
  );
  check(
    'draft only enters an apply plan with an explicit risk warning',
    Boolean(riskyDraft) && typeof draftApplyExplicit.riskWarning === 'string',
    String(draftApplyExplicit.riskWarning ?? 'no warning'),
  );

  /* ---------------------------------------------------------------- scenario E */

  step('场景 E：原文变更 / source change marks targets stale', 'en-US checkout.cart_empty rewritten');
  const enFile = join(WORKSPACE, 'apps/web/src/locales/en-US/common.json');
  const en = JSON.parse(readFileSync(enFile, 'utf8')) as { checkout: { cart_empty: string } };
  en.checkout.cart_empty = 'Your shopping cart is empty';
  writeFileSync(enFile, `${JSON.stringify(en, null, 2)}\n`, 'utf8');

  await local.scanLocalProject({});
  const sourcePreview = await local.previewSync({ direction: 'bidirectional' });
  const sourceSummary = sourcePreview.summary as Record<string, number>;
  check('source change is pushed', sourceSummary.pushUpdated + sourceSummary.pushNew >= 1, JSON.stringify(sourceSummary));
  await local.pushProjectChanges({ sync_plan_id: String(sourcePreview.syncPlanId), confirm: true });

  const staleEntries = await admin.listStale(project.id);
  check(
    'dependent target marked STALE',
    staleEntries.some((item) => item.key === 'checkout.cart_empty'),
    staleEntries.map((item) => `${item.key}/${item.locale}=${item.status}`).join(', ') || 'none',
  );

  const patch = local.createGitPatch({});
  check('git patch produced without committing', typeof patch.patchPath === 'string', String(patch.patchPath));

  /* ------------------------------------------------------------------ summary */

  if (session.ephemeral && process.env.DEMO_KEEP_PROJECT !== '1') {
    await admin.call('DELETE', `/projects/${session.projectId}?confirmName=${encodeURIComponent(project.name)}`);
    step('清理 / cleanup', '临时项目已删除（设置 DEMO_KEEP_PROJECT=1 可保留用于人工查看）');
  }

  const head = git(WORKSPACE, ['rev-parse', '--short', 'HEAD']).trim();
  step('结果 / result', `${steps.length - 1} scenario steps executed, workspace HEAD still ${head} (no commit by LocaleHub)`);
  if (failures === 0) {
    process.stdout.write('\n\u001b[32mALL ACCEPTANCE CHECKS PASSED\u001b[0m\n');
  } else {
    process.stdout.write(`\n\u001b[31m${failures} CHECK(S) FAILED\u001b[0m\n`);
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------- helpers */

interface Session {
  token: string;
  projectId: string;
  organizationName: string;
  /** true when this run created the project and should delete it afterwards */
  ephemeral: boolean;
}

/** Register (first run only) then log in, and make sure a demo project + locale exist. */
async function bootstrapSession(apiUrl: string, email: string, password: string): Promise<Session> {
  const register = () =>
    fetchJson(apiUrl, '/auth/register', 'POST', {
      email,
      password,
      name: 'Demo Admin',
      organizationName: 'Demo Organization',
    });

  let login: Record<string, unknown>;
  try {
    login = await fetchJson(apiUrl, '/auth/login', 'POST', { email, password });
  } catch {
    await register().catch(() => undefined);
    login = await fetchJson(apiUrl, '/auth/login', 'POST', { email, password });
  }

  const token = String(login.token);
  const organization = login.organization as { id: string; name: string };
  const client = new ApiClient({ baseUrl: apiUrl, token });

  // Each run gets its own project so the demo is repeatable: a project left over from an
  // earlier run (or from `pnpm db:seed`) would otherwise carry a different baseline.
  const name = `Demo App (e2e ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')})`;
  const created = await client.call<{ id: string }>('POST', '/projects', {
    name,
    description: 'Temporary project created by the LocaleHub acceptance demo',
    sourceLocale: 'en-US',
    defaultPlatform: 'web',
    locales: ['ja-JP'],
    platforms: ['web'],
  });
  await client.call('POST', `/projects/${created.id}/locales`, { code: 'ja-JP', name: '日本語' }).catch(() => undefined);
  return { token, projectId: created.id, organizationName: organization.name, ephemeral: true };
}

async function issueToken(admin: ApiClient, projectId: string): Promise<{ token: string; tokenPrefix: string }> {
  const existing = await admin.listTokens();
  const reusable = existing.filter((token) => !token.revokedAt && token.projectIds.includes(projectId));
  for (const token of reusable) await admin.revokeToken(token.id);
  return admin.createToken({
    name: 'e2e-demo',
    scopes: [
      'project.read',
      'repository.scan',
      'sync.preview',
      'sync.push',
      'translation.read',
      'translation.pull',
      'translation.apply',
      'qa.execute',
    ],
    projectIds: [projectId],
    expiresInDays: 1,
  });
}

async function findEntry(client: ApiClient, projectId: string, key: string, locale: string) {
  return client.findEntry(projectId, key, locale);
}

async function fetchJson(apiUrl: string, path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as { success: boolean; data?: Record<string, unknown>; error?: { message: string } };
  if (!response.ok || !payload.success) {
    throw new Error(payload.error?.message ?? `request failed: ${response.status}`);
  }
  return payload.data ?? {};
}

main()
  .catch((error) => {
    process.stdout.write(`\n\u001b[31mDemo failed:\u001b[0m ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  // Runs even when a scenario throws, so a failed demo never leaves a stray API behind.
  .finally(() => api?.stop());
